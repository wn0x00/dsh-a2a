import { randomUUID } from 'node:crypto'
import { TaskJournal } from './task-journal.js'
import { diagnosticText, safeDiagnostic } from './task-diagnostics.js'
import { PLUGIN_VERSION } from './release-config.js'
import { GatewayRequestError } from './gateway.js'
import type {
  A2AArtifact,
  A2ATaskEnvelope,
  A2ATaskState,
  GatewayEvent,
  HarnessContext,
  HarnessRunContext,
  HarnessRunResult,
  HarnessSkill,
  TaskEvent,
  TaskDiagnostic,
  A2ATask,
} from './types.js'

export class HarnessAuthRequiredError extends Error {
  override name = 'HarnessAuthRequiredError'
}

export class HarnessInputRequiredError extends Error {
  override name = 'HarnessInputRequiredError'
}

class TaskAdmissionClosed extends Error {}

class HarnessTimeoutError extends Error {
  override name = 'HarnessTimeoutError'
}

export type TaskReporter = (taskId: string, event: TaskEvent) => Promise<void>

function errorMessage(error: unknown): string {
  return diagnosticText(error instanceof Error ? error.message : 'The local task failed')
}

function textArtifact(taskId: string, text: string): A2AArtifact {
  return {
    artifactId: `${taskId}:result`,
    name: 'result.txt',
    parts: [{ text, mediaType: 'text/plain' }],
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export type TaskRunnerOptions = {
  storageDirectory?: string
  getTask?: (taskId: string) => Promise<A2ATask>
  activeTasks?: () => Promise<A2ATask[]>
  heartbeatMs?: number
}

const RESPONSE_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'])

export class TaskRunner {
  private journal: TaskJournal | undefined
  private journalScope: string | undefined
  private readonly flushing = new Map<string, Promise<void>>()
  private initialized = false
  private flushingReports: Promise<void> | undefined

  private readonly active = new Map<string, AbortController>()
  private readonly pending = new Set<Promise<void>>()
  private readonly executions = new Set<Promise<HarnessRunResult>>()
  private readonly deliveryIds = new Set<string>()
  private readonly deliveryOrder: string[] = []

  constructor(
    private readonly harness: HarnessContext,
    private readonly deviceCapabilities: readonly string[],
    private readonly skills: Readonly<Record<string, HarnessSkill>>,
    private readonly report: TaskReporter,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void,
    private readonly messageExecutor?: HarnessSkill,
    private readonly sessionScope?: () => Promise<string>,
    private readonly options: TaskRunnerOptions = {},
  ) {}

  async initialize(taskEventsVersion = 0): Promise<void> {
    if (taskEventsVersion < 1 || !this.options.storageDirectory || !this.sessionScope) return
    const scope = await this.sessionScope()
    if (scope === this.journalScope && this.initialized) return
    if (this.active.size) throw new Error('Cannot switch task authorization while work is active')
    this.journal = new TaskJournal(this.options.storageDirectory, scope)
    await this.journal.load()
    this.journalScope = scope
    this.deliveryIds.clear()
    await this.reconcile()
    this.initialized = true
  }

  /** Reconcile old receipts, never replay an interrupted local side effect. */
  private async reconcile(): Promise<void> {
    if (!this.journal || !this.options.getTask) return
    void this.flushReports().catch(() => undefined)
    for (const row of this.journal.list()) {
      if (row.phase !== 'running') continue
      const remote = await this.options.getTask(row.task_id)
      if (RESPONSE_STATES.has(remote.state)) { await this.journal.markFinished(row.task_id); continue }
      await this.queueEvent(row.task_id, {
        state: 'TASK_STATE_FAILED',
        message: 'The client restarted during this task. Execution was not replayed; inspect the saved local session before continuing.',
        diagnostics: { kind: 'recovery', stage: 'interrupted', error_code: 'client_restarted',
          client_version: PLUGIN_VERSION, executor: row.diagnostics.at(-1)?.executor ?? 'unknown',
          ...(row.local_session_id ? { local_session_id: row.local_session_id } : {}),
          changes: 'unknown' },
      })
    }
    // A device may have upgraded without a prior ledger. Surface that gap; do
    // not claim the task failed or launch it again from an untrusted snapshot.
    for (const task of await this.options.activeTasks?.() ?? []) {
      if (this.journal.get(task.id)) continue
      await this.journal.begin(task.id, task.contextId, 'inspect:' + task.id)
      await this.queueEvent(task.id, { diagnostics: { kind: 'recovery', stage: 'untracked',
        error_code: 'local_record_missing', changes: 'unknown', client_version: PLUGIN_VERSION,
        summary: 'This client has no execution record for the task. Inspect the existing executor; it has not been replayed.' } })
      await this.journal.markFinished(task.id)
    }
  }

  async flushReports(): Promise<void> {
    if (this.flushingReports) return this.flushingReports
    const journal = this.journal
    if (!journal) return
    const work = (async () => {
      // Reports have their own carrier. A slow task's outbox does not block
      // cancellation checks or task pulls; cap parallel transport attempts.
      const rows = journal.list().filter((row) => row.pending.length)
      for (let offset = 0; offset < rows.length; offset += 4) {
        await Promise.all(rows.slice(offset, offset + 4).map((row) => this.flushTask(row.task_id)))
      }
    })()
    this.flushingReports = work
    try { await work } finally { this.flushingReports = undefined }
  }

  private async flushTask(taskId: string): Promise<void> {
    const existing = this.flushing.get(taskId)
    if (existing) return existing
    const journal = this.journal
    if (!journal) return
    const work = (async () => {
      for (let sent = 0; sent < 50; sent++) {
        const event = journal.get(taskId)?.pending[0]
        if (!event) return
        try { await this.report(taskId, event) } catch (error) {
          if (error instanceof GatewayRequestError && [409, 422].includes(error.status) && this.options.getTask) {
            let remote: A2ATask | undefined
            try { remote = await this.options.getTask(taskId) } catch { /* Leave unknown outcomes pending. */ }
            if (remote && ['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(remote.state)
                && event.state && event.state !== remote.state) {
              await journal.reject(taskId, event.event_id!, 'Task is already ' + remote.state + '; stale transition was not replayed')
              this.log('warn', 'A stale task transition was retained locally after reconciliation', { taskId, state: remote.state })
              continue
            }
          }
          this.log('warn', 'Task event remains in the durable outbox', { taskId, eventId: event.event_id })
          return
        }
        await journal.acknowledge(taskId, event.event_id!)
      }
    })()
    this.flushing.set(taskId, work)
    try { await work } finally { this.flushing.delete(taskId) }
  }

  private async queueEvent(taskId: string, event: TaskEvent): Promise<void> {
    if (!this.journal) { await this.report(taskId, event); return }
    await this.journal.enqueue(taskId, { ...event, event_id: event.event_id ?? randomUUID(),
      ...(event.diagnostics ? { diagnostics: safeDiagnostic(event.diagnostics) } : {}) })
    void this.flushTask(taskId).catch(() => undefined)
  }

  private async deliver(taskId: string, event: TaskEvent, requireAck = false): Promise<void> {
    if (!this.journal) { await this.report(taskId, event); return }
    const durable = { ...event, event_id: event.event_id ?? randomUUID(),
      ...(event.diagnostics ? { diagnostics: safeDiagnostic(event.diagnostics) } : {}) }
    await this.journal.enqueue(taskId, durable)
    await this.flushTask(taskId)
    if (requireAck) {
      if (this.journal.get(taskId)?.pending.some((item) => item.event_id === durable.event_id)) {
        throw new Error('The gateway did not acknowledge local execution admission')
      }
      // An idempotent ACK can describe an older WORKING report after the user
      // already canceled the task. Recheck current state before any side effect.
      if (this.options.getTask && (await this.options.getTask(taskId)).state !== 'TASK_STATE_WORKING') {
        throw new TaskAdmissionClosed('Task is no longer available for execution')
      }
    }
  }

  async handle(event: GatewayEvent): Promise<void> {
    if (event.type === 'cancel') {
      this.cancel(event.taskId)
      return
    }
    if (event.type !== 'task') return
    const { envelope } = event
    if (this.deliveryIds.has(envelope.deliveryId)) return
    this.deliveryIds.add(envelope.deliveryId)
    this.deliveryOrder.push(envelope.deliveryId)
    if (this.deliveryOrder.length > 4096) {
      const expired = this.deliveryOrder.shift()
      if (expired) this.deliveryIds.delete(expired)
    }
    if (this.journal && !await this.journal.begin(envelope.task.id, envelope.task.contextId, envelope.deliveryId)) {
      await this.flushReports()
      return
    }
    const work = this.start(envelope)
    this.pending.add(work)
    try { await work } finally { this.pending.delete(work) }
  }

  cancel(taskId: string): void {
    this.active.get(taskId)?.abort()
  }

  activeTaskIds(): string[] {
    return [...this.active.keys()]
  }

  async stop(): Promise<void> {
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.pending])
    // A timeout reports failure promptly, but the native Agent can still be
    // cancelling tools and flushing session history. Keep the profile locked
    // until execution drains; plugin cleanup then closes its retained handles.
    await Promise.allSettled([...this.executions])
    this.active.clear()
    await this.flushReports()
  }

  private async start(envelope: A2ATaskEnvelope): Promise<void> {
    const { task } = envelope
    if (this.active.has(task.id)) return
    if (envelope.timeoutSeconds !== undefined && (!Number.isFinite(envelope.timeoutSeconds)
        || envelope.timeoutSeconds < 1 || envelope.timeoutSeconds > 604800)) {
      await this.safeReport(task.id, { state: 'TASK_STATE_REJECTED', message: 'Task deadline must be between 1 and 604800 seconds' })
      return
    }
    const nativeMessage = envelope.executionMode === 'a2a-message'
    const skill = nativeMessage
      ? this.messageExecutor
      : Object.hasOwn(this.skills, envelope.skillId) ? this.skills[envelope.skillId] : undefined
    if (!skill) {
      await this.safeReport(task.id, {
        state: 'TASK_STATE_REJECTED',
        message: nativeMessage
          ? 'This client does not support A2A message execution'
          : `Skill is not allowed on this device: ${envelope.skillId}`,
      })
      return
    }
    const requested = envelope.requestedCapabilities ?? []
    const unsupported = requested.filter((capability) => !this.deviceCapabilities.includes(capability))
    if (unsupported.length) {
      await this.safeReport(task.id, {
        state: 'TASK_STATE_REJECTED',
        message: `Device lacks requested capabilities: ${unsupported.join(', ')}`,
      })
      return
    }

    const controller = new AbortController()
    this.active.set(task.id, controller)
    const started = Date.now()
    let latest: TaskDiagnostic = { kind: 'progress', stage: 'admitted', executor: nativeMessage ? 'host-agent' : 'legacy-skill' }
    const progress = async (event: TaskDiagnostic) => {
      latest = safeDiagnostic({ ...latest, ...event, client_version: PLUGIN_VERSION, at: new Date().toISOString(), elapsed_ms: Date.now() - started })
      if (this.journal) {
        // Persist first, then send independently. A disconnected gateway must
        // not stall each local tool or model step for an HTTP retry timeout.
        await this.queueEvent(task.id, { diagnostics: latest })
      }
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      // Executing local work requires the gateway to accept this claim. In
      // particular, a revoked credential or stale grant must stop execution.
      await this.deliver(task.id, { state: 'TASK_STATE_WORKING' }, true)
      await progress({ kind: 'progress', stage: 'admitted' })
      if (this.journal) {
        heartbeat = setInterval(() => { void progress({ kind: 'heartbeat' }).catch(() => undefined) }, this.options.heartbeatMs ?? 30_000)
        heartbeat.unref()
      }
      if (controller.signal.aborted) throw new DOMException('Task was canceled', 'AbortError')
      if (envelope.approvalRequired) {
        const approved = await this.requestApproval(`Allow remote Agent task ${task.id}?`)
        if (!approved) {
          await this.safeReport(task.id, {
            state: 'TASK_STATE_CANCELED',
            message: 'The local user did not approve this task',
          })
          return
        }
      }
      if (controller.signal.aborted) throw new DOMException('Task was canceled', 'AbortError')
      const context: HarnessRunContext = {
        taskId: task.id,
        contextId: task.contextId,
        signal: controller.signal,
        requestApproval: async (reason) => {
          await progress({ kind: 'progress', stage: 'approval_required' })
          try { return await this.requestApproval(reason) }
          finally { await progress({ kind: 'progress', stage: 'running' }) }
        },
        ...(this.journal ? { reportProgress: progress } : {}),
        executionMode: nativeMessage ? 'a2a-message' : 'legacy-skill',
        ...(nativeMessage && this.sessionScope ? { sessionScope: await this.sessionScope() } : {}),
      }
      const execution = skill(nativeMessage ? envelope.message : envelope.input, context)
      this.executions.add(execution)
      void execution.then(
        () => { this.executions.delete(execution) },
        () => { this.executions.delete(execution) },
      )
      const result = await this.withTimeout(
        execution,
        envelope.timeoutSeconds,
        controller,
      )
      if (controller.signal.aborted) {
        await this.safeReport(task.id, { state: 'TASK_STATE_CANCELED' })
        return
      }
      const artifacts = this.withTextArtifact(task.id, result)
      const { error_code: _priorError, summary: _priorSummary, ...completed } = latest
      await this.safeReport(task.id, {
        state: 'TASK_STATE_COMPLETED',
        ...(artifacts.length ? { artifacts } : {}),
        ...(this.journal ? { diagnostics: safeDiagnostic({ ...completed, kind: 'result', stage: 'completed', changes: 'unknown', elapsed_ms: Date.now() - started }) } : {}),
      })
    } catch (error) {
      if (error instanceof TaskAdmissionClosed) {
        await this.journal?.finish(task.id)
        return
      }
      const state: A2ATaskState = error instanceof HarnessTimeoutError
        ? 'TASK_STATE_FAILED'
        : controller.signal.aborted || isAbortError(error)
          ? 'TASK_STATE_CANCELED'
          : error instanceof HarnessAuthRequiredError
          ? 'TASK_STATE_AUTH_REQUIRED'
          : error instanceof HarnessInputRequiredError
            ? 'TASK_STATE_INPUT_REQUIRED'
            : 'TASK_STATE_FAILED'
      const errorCode = error instanceof HarnessTimeoutError ? 'execution_deadline_exceeded'
        : error instanceof HarnessAuthRequiredError ? (latest.error_code ?? 'credentials_required')
        : controller.signal.aborted ? 'cancelled' : 'execution_failed'
      await this.safeReport(task.id, { state, message: errorMessage(error),
        ...(this.journal ? { diagnostics: safeDiagnostic({ ...latest, kind: 'error',
          error_code: errorCode, changes: 'unknown', elapsed_ms: Date.now() - started }) } : {}),
      })
      this.log('warn', 'A2A task failed', { taskId: task.id, state })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      this.active.delete(task.id)
    }
  }

  private async requestApproval(reason: string): Promise<boolean> {
    if (!this.harness.ui?.confirm) return false
    return this.harness.ui.confirm(reason)
  }

  private withTextArtifact(taskId: string, result: HarnessRunResult): A2AArtifact[] {
    const artifacts = result.artifacts ? [...result.artifacts] : []
    if (result.text) artifacts.unshift(textArtifact(taskId, result.text))
    return artifacts
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutSeconds: number | undefined,
    controller: AbortController,
  ): Promise<T> {
    // An asynchronous task can legitimately outlive a model turn by hours.
    // Only an explicitly supplied policy creates an execution deadline.
    if (timeoutSeconds === undefined) return promise
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 604800) {
      throw new Error('Task deadline must be between 1 and 604800 seconds')
    }
    const seconds = timeoutSeconds
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new HarnessTimeoutError('The local task timed out'))
      }, seconds * 1000)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async safeReport(taskId: string, event: TaskEvent): Promise<void> {
    try {
      await this.deliver(taskId, event)
    } catch (error) {
      this.log('error', 'Unable to report A2A task state', {
        taskId,
        state: event.state,
        error: errorMessage(error),
      })
    }
  }
}
