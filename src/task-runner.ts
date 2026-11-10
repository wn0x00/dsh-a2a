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

export class HarnessDrainUnconfirmedError extends Error {
  override name = 'HarnessDrainUnconfirmedError'
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
  recoveries?: () => import('./types.js').DeviceRecovery[]
  heartbeatMs?: number
}

const RESPONSE_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'])

export class TaskRunner {
  private journal: TaskJournal | undefined
  private journalScope: string | undefined
  private readonly flushing = new Map<string, Promise<void>>()
  private initialized = false
  private flushingReports: Promise<void> | undefined
  private executionLeases = false
  private queueTail: Promise<void> = Promise.resolve()
  private readonly releaseWaiters = new Set<() => void>()

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

  async initialize(taskEventsVersion = 0, executionLeaseVersion = 0): Promise<void> {
    if (executionLeaseVersion >= 1 && (taskEventsVersion < 1 || !this.options.storageDirectory || !this.sessionScope)) {
      throw new Error('Machine lease execution requires durable task-event storage')
    }
    if (taskEventsVersion < 1 || !this.options.storageDirectory || !this.sessionScope) return
    this.executionLeases = executionLeaseVersion >= 1
    const scope = await this.sessionScope()
    if (scope === this.journalScope && this.initialized) return
    if (scope !== this.journalScope) {
      if (this.localTaskCount()) throw new Error('Cannot switch task authorization while work is active')
      this.initialized = false
      this.journal = new TaskJournal(this.options.storageDirectory, scope)
      await this.journal.load()
      this.journalScope = scope
      this.deliveryIds.clear()
    }
    await this.reconcile()
    this.initialized = true
  }

  private leaseOf(task: A2ATask): { deliveryId: string; phase: string } | undefined {
    const lease = task.metadata?.executionLease as { deliveryId?: unknown; phase?: unknown } | undefined
    return lease && typeof lease.deliveryId === 'string' && typeof lease.phase === 'string'
      ? { deliveryId: lease.deliveryId, phase: lease.phase } : undefined
  }

  /** Never replay a received task across restart, or infer tool cleanup from a terminal state. */
  private async reconcile(): Promise<void> {
    if (!this.journal || !this.options.getTask) return
    void this.flushReports().catch(() => undefined)
    for (const row of this.journal.list()) {
      if (row.previous_grant || row.execution?.phase === 'drained' || row.execution?.phase === 'released') continue
      if (row.phase === 'finished' && !row.execution) continue
      const remote = await this.options.getTask(row.task_id)
      const lease = this.executionLeases ? this.leaseOf(remote) : undefined
      if (lease) {
        if (!row.execution || row.execution.delivery_id !== lease.deliveryId) await this.journal.requireRecovery(row.task_id, lease.deliveryId)
        if (lease.phase === 'released') { await this.journal.releaseExecution(row.task_id, lease.deliveryId); continue }
        // A restored idle session cannot prove a prior process's external
        // tools stopped. Only a matching receipt that never entered execution
        // can be released automatically after restart.
        const drained = row.phase === 'queued' && row.execution?.delivery_id === lease.deliveryId && !row.recovery_pending
        if (!drained) await this.journal.requireRecovery(row.task_id, lease.deliveryId)
        await this.queueEvent(row.task_id, {
          ...(!RESPONSE_STATES.has(remote.state) ? { state: 'TASK_STATE_FAILED' as const,
            message: 'The client restarted. Execution has not been replayed; inspect the local session before continuing.' } : {}),
          ...(drained ? { execution: { delivery_id: lease.deliveryId, phase: 'drained' as const } } : {}),
          diagnostics: { kind: 'recovery', stage: drained ? 'interrupted' : 'recovery_required', error_code: 'client_restarted',
            client_version: PLUGIN_VERSION, executor: row.diagnostics.at(-1)?.executor ?? 'unknown',
            ...(row.local_session_id ? { local_session_id: row.local_session_id } : {}), changes: row.phase === 'queued' ? 'none' : 'unknown' },
        })
        continue
      }
      if (RESPONSE_STATES.has(remote.state)) { await this.journal.markFinished(row.task_id); continue }
      await this.queueEvent(row.task_id, { state: 'TASK_STATE_FAILED',
        message: 'The client restarted during this task. Execution was not replayed; inspect the saved local session before continuing.',
        diagnostics: { kind: 'recovery', stage: 'interrupted', error_code: 'client_restarted',
          client_version: PLUGIN_VERSION, executor: row.diagnostics.at(-1)?.executor ?? 'unknown',
          ...(row.local_session_id ? { local_session_id: row.local_session_id } : {}), changes: 'unknown' } })
    }
    for (const task of await this.options.activeTasks?.() ?? []) {
      const existing = this.journal.get(task.id)
      const lease = this.executionLeases ? this.leaseOf(task) : undefined
      if (existing && (!lease || lease.phase === 'released' || existing.execution?.delivery_id === lease.deliveryId)) continue
      if (!existing) await this.journal.begin(task.id, task.contextId, 'inspect:' + task.id)
      if (lease && lease.phase !== 'released') await this.journal.requireRecovery(task.id, lease.deliveryId)
      await this.queueEvent(task.id, { diagnostics: { kind: 'recovery', stage: lease ? 'recovery_required' : 'untracked',
        error_code: existing ? 'legacy_execution_unconfirmed' : 'local_record_missing', changes: 'unknown', client_version: PLUGIN_VERSION,
        summary: existing ? 'This older receipt does not confirm that native tools stopped. Inspect the session before releasing the machine.'
          : 'This client has no execution record for the task. Inspect the existing executor; it has not been replayed.' } })
      await this.journal.markFinished(task.id)
    }
    for (const recovery of this.executionLeases ? this.options.recoveries?.() ?? [] : []) {
      if (this.journal.get(recovery.taskId)?.execution?.phase === 'drained') continue
      if (!this.journal.get(recovery.taskId)) await this.journal.begin(recovery.taskId, '', 'inspect:' + recovery.taskId)
      await this.journal.requireRecovery(recovery.taskId, recovery.deliveryId, true)
      await this.journal.markFinished(recovery.taskId)
    }
  }

  recoveryTasks(): Array<{ taskId: string; deliveryId: string; localSessionId?: string; canRelease: boolean }> {
    return this.journal?.list().filter((row) => row.recovery_pending && row.execution?.phase !== 'released').map((row) => ({
      taskId: row.task_id, deliveryId: row.execution!.delivery_id,
      ...(row.local_session_id ? { localSessionId: row.local_session_id } : {}),
      canRelease: this.active.size === 0 && (!row.local_session_id || !this.harness.sessionBusy?.(row.local_session_id)),
    })) ?? []
  }

  /** Owner-only UI confirmation; this records an attestation, never pretends to stop a process. */
  async confirmStopped(taskId: string, deliveryId: string): Promise<void> {
    const candidate = this.recoveryTasks().find((row) => row.taskId === taskId && row.deliveryId === deliveryId)
    if (!candidate?.canRelease || !this.journal || !this.options.getTask) throw new Error('This task cannot be released while local execution is active')
    if (this.journal.get(taskId)?.previous_grant) {
      await this.options.activeTasks?.()
      if (!this.options.recoveries?.().some((row) => row.taskId === taskId && row.deliveryId === deliveryId)) throw new Error('Recovery authorization changed; refresh before confirming')
      if (!this.journal.get(taskId)?.pending.some((event) => event.execution?.delivery_id === deliveryId)) {
        await this.queueEvent(taskId, { execution: { delivery_id: deliveryId, phase: 'drained', confirmed_stopped: true } })
      }
      await this.flushTask(taskId)
      if (this.journal.get(taskId)?.execution?.phase !== 'released') throw new Error('Machine release is pending platform acknowledgement')
      return
    }
    const remote = await this.options.getTask(taskId)
    const lease = this.leaseOf(remote)
    if (lease?.deliveryId !== deliveryId) throw new Error('The execution lease has changed; refresh before confirming')
    if (lease.phase === 'released') { await this.journal.releaseExecution(taskId, deliveryId); return }
    if (candidate.localSessionId && this.harness.sessionBusy?.(candidate.localSessionId)) throw new Error('The native session is still running')
    if (!this.journal.get(taskId)?.pending.some((event) => event.execution?.delivery_id === deliveryId)) {
      await this.queueEvent(taskId, {
        ...(!RESPONSE_STATES.has(remote.state) ? { state: 'TASK_STATE_FAILED' as const } : {}),
        execution: { delivery_id: deliveryId, phase: 'drained' },
        diagnostics: { kind: 'recovery', stage: 'owner_confirmed_stopped', client_version: PLUGIN_VERSION,
          summary: 'The local owner confirmed that the old task and tools have stopped.', changes: 'unknown',
          ...(candidate.localSessionId ? { local_session_id: candidate.localSessionId } : {}) },
      })
    }
    await this.flushTask(taskId)
    if (this.journal.get(taskId)?.execution?.phase !== 'released') throw new Error('Machine release is pending platform acknowledgement; retry after reconnecting')
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
                && event.state && event.state !== remote.state
                && (!event.execution || this.leaseOf(remote)?.deliveryId === event.execution.delivery_id)) {
              await journal.reject(taskId, event.event_id!, 'Task is already ' + remote.state + '; stale transition was not replayed')
              if (event.execution) {
                // Preserve the rejected event unchanged. The executor already
                // drained; acknowledge that fact independently of the winning
                // business outcome under a fresh idempotency key.
                await journal.enqueue(taskId, { event_id: randomUUID(), execution: event.execution })
              }
              this.log('warn', 'A stale task transition was retained locally after reconciliation', { taskId, state: remote.state })
              continue
            }
          }
          this.log('warn', 'Task event remains in the durable outbox', { taskId, eventId: event.event_id })
          return
        }
        await journal.acknowledge(taskId, event.event_id!)
        for (const wake of this.releaseWaiters) wake()
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
      if (this.options.getTask) {
        const remote = await this.options.getTask(taskId)
        if ((remote.metadata?.executionLease as { cancelRequested?: boolean } | undefined)?.cancelRequested === true) {
          this.cancel(taskId)
          throw new DOMException('Task cancellation was requested before execution', 'AbortError')
        }
        if (remote.state !== 'TASK_STATE_WORKING') throw new TaskAdmissionClosed('Task is no longer available for execution')
      }
    }
  }

  async handle(event: GatewayEvent): Promise<void> {
    if (event.type === 'cancel') { this.cancel(event.taskId); return }
    if (event.type !== 'task') return
    const { envelope } = event
    if (this.deliveryIds.has(envelope.deliveryId) || this.active.has(envelope.task.id)) return
    this.deliveryIds.add(envelope.deliveryId)
    this.deliveryOrder.push(envelope.deliveryId)
    if (this.deliveryOrder.length > 4096) {
      const expired = this.deliveryOrder.shift()
      if (expired) this.deliveryIds.delete(expired)
    }
    // Reserve capacity synchronously, before persistence or HTTP can yield.
    const controller = new AbortController()
    this.active.set(envelope.task.id, controller)
    const prior = this.queueTail
    let releaseQueue!: () => void
    this.queueTail = new Promise<void>((resolve) => { releaseQueue = resolve })
    const work = (async () => {
      if (this.journal && !await this.journal.begin(envelope.task.id, envelope.task.contextId, envelope.deliveryId,
        { queued: true, leased: this.executionLeases })) { await this.flushReports(); return }
      if (this.journal) await this.queueEvent(envelope.task.id, { diagnostics: { kind: 'progress', stage: 'queued', client_version: PLUGIN_VERSION } })
      await prior
      try {
        await this.waitForReleasedCapacity(envelope.deliveryId, controller.signal)
        await this.start(envelope, controller)
      } catch (error) {
        // A queued cancellation has never entered the executor.
        await this.finishDelivery(envelope, { state: controller.signal.aborted ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
          message: errorMessage(error), diagnostics: { kind: 'result', stage: 'queued_cancelled', changes: 'none' } })
      }
    })().finally(() => { this.active.delete(envelope.task.id); releaseQueue() })
    this.pending.add(work)
    try { await work } finally { this.pending.delete(work) }
  }

  private async waitForReleasedCapacity(deliveryId: string, signal: AbortSignal): Promise<void> {
    while (this.journal?.list().some((row) => row.execution && row.execution.delivery_id !== deliveryId && row.execution.phase !== 'released' && (row.phase !== 'queued' || row.recovery_pending))) {
      signal.throwIfAborted()
      await new Promise<void>((resolve) => {
        const wake = () => { this.releaseWaiters.delete(wake); signal.removeEventListener('abort', wake); resolve() }
        this.releaseWaiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
    signal.throwIfAborted()
  }

  cancel(taskId: string): void { this.active.get(taskId)?.abort() }

  hasPendingReports(): boolean { return this.journal?.list().some((row) => row.pending.length > 0) ?? false }

  localTaskCount(): number {
    // A failed drain may leave a known native writer after its controller exits.
    // Keep that evidence across authorization/update checks until it is idle.
    const tasks = new Set(this.active.keys())
    for (const row of this.journal?.list() ?? []) {
      if (row.execution && row.execution.phase !== 'released' && row.local_session_id
        && this.harness.sessionBusy?.(row.local_session_id)) tasks.add(row.task_id)
    }
    return tasks.size
  }

  hasCapacity(): boolean {
    return this.active.size === 0 && !this.journal?.list().some((row) => row.execution && row.execution.phase !== 'released')
  }

  activeTaskIds(): string[] {
    return [...new Set([...this.active.keys(), ...(this.journal?.list().filter((row) => row.execution && row.execution.phase !== 'released').map((row) => row.task_id) ?? [])])]
  }

  private async finishDelivery(envelope: A2ATaskEnvelope, event: TaskEvent): Promise<void> {
    const payload: TaskEvent = { ...event,
      ...(this.executionLeases ? { execution: { delivery_id: envelope.deliveryId, phase: 'drained' as const } } : {}),
    }
    if (!this.journal) delete payload.diagnostics
    await this.safeReport(envelope.task.id, payload)
  }

  async stop(): Promise<void> {
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.pending])
    // Keep profile ownership until native tools and session persistence drain.
    // A timeout requests cancellation; the final response is sent only after
    // that cleanup. Plugin disposal then closes retained session handles.
    await Promise.allSettled([...this.executions])
    this.active.clear()
    await this.flushReports()
  }

  private async start(envelope: A2ATaskEnvelope, controller: AbortController): Promise<void> {
    const { task } = envelope
    const nativeMessage = envelope.executionMode === 'a2a-message'
    const started = Date.now()
    let latest: TaskDiagnostic = { kind: 'progress', stage: 'admitted', executor: nativeMessage ? 'host-agent' : 'legacy-skill' }
    const progress = async (event: TaskDiagnostic) => {
      latest = safeDiagnostic({ ...latest, ...event, client_version: PLUGIN_VERSION, at: new Date().toISOString(), elapsed_ms: Date.now() - started })
      if (this.journal) await this.queueEvent(task.id, { diagnostics: latest })
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let execution: Promise<HarnessRunResult> | undefined
    let settled = false
    let drainError: unknown
    let outcome: TaskEvent = {}
    try {
      controller.signal.throwIfAborted()
      if (envelope.timeoutSeconds !== undefined && (!Number.isFinite(envelope.timeoutSeconds)
          || envelope.timeoutSeconds < 1 || envelope.timeoutSeconds > 604800)) {
        outcome = { state: 'TASK_STATE_REJECTED', message: 'Task deadline must be between 1 and 604800 seconds' }
        return
      }
      const skill = nativeMessage ? this.messageExecutor
        : Object.hasOwn(this.skills, envelope.skillId) ? this.skills[envelope.skillId] : undefined
      if (!skill) {
        outcome = { state: 'TASK_STATE_REJECTED', message: nativeMessage
          ? 'This client does not support A2A message execution' : `Skill is not allowed on this device: ${envelope.skillId}` }
        return
      }
      const unsupported = (envelope.requestedCapabilities ?? []).filter((capability) => !this.deviceCapabilities.includes(capability))
      if (unsupported.length) {
        outcome = { state: 'TASK_STATE_REJECTED', message: `Device lacks requested capabilities: ${unsupported.join(', ')}` }
        return
      }
      await this.deliver(task.id, { state: 'TASK_STATE_WORKING' }, true)
      await this.journal?.markRunning(task.id)
      await progress({ kind: 'progress', stage: 'admitted' })
      if (this.journal) {
        heartbeat = setInterval(() => { void progress({ kind: 'heartbeat' }).catch(() => undefined) }, this.options.heartbeatMs ?? 30_000)
        heartbeat.unref()
      }
      controller.signal.throwIfAborted()
      if (envelope.approvalRequired && !await this.requestApproval(`Allow remote Agent task ${task.id}?`)) {
        outcome = { state: 'TASK_STATE_CANCELED', message: 'The local user did not approve this task' }
        return
      }
      controller.signal.throwIfAborted()
      const context: HarnessRunContext = {
        taskId: task.id, contextId: task.contextId, signal: controller.signal,
        requestApproval: async (reason) => {
          await progress({ kind: 'progress', stage: 'approval_required' })
          try { return await this.requestApproval(reason) }
          finally { await progress({ kind: 'progress', stage: 'running' }) }
        },
        ...(this.journal ? { reportProgress: progress } : {}),
        executionMode: nativeMessage ? 'a2a-message' : 'legacy-skill',
        ...(nativeMessage && this.sessionScope ? { sessionScope: await this.sessionScope() } : {}),
      }
      execution = skill(nativeMessage ? envelope.message : envelope.input, context)
      this.executions.add(execution)
      void execution.then(
        () => { settled = true; this.executions.delete(execution!) },
        (error) => { settled = true; drainError = error; this.executions.delete(execution!) },
      )
      const result = await this.withTimeout(execution, envelope.timeoutSeconds, controller)
      controller.signal.throwIfAborted()
      const artifacts = this.withTextArtifact(task.id, result)
      const { error_code: _priorError, summary: _priorSummary, ...completed } = latest
      outcome = { state: 'TASK_STATE_COMPLETED', ...(artifacts.length ? { artifacts } : {}),
        ...(this.journal ? { diagnostics: safeDiagnostic({ ...completed, kind: 'result', stage: 'completed', changes: 'unknown', elapsed_ms: Date.now() - started }) } : {}) }
    } catch (error) {
      if (error instanceof TaskAdmissionClosed) { outcome = {}; return }
      const state: A2ATaskState = error instanceof HarnessTimeoutError ? 'TASK_STATE_FAILED'
        : controller.signal.aborted || isAbortError(error) ? 'TASK_STATE_CANCELED'
        : error instanceof HarnessAuthRequiredError ? 'TASK_STATE_AUTH_REQUIRED'
        : error instanceof HarnessInputRequiredError ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_FAILED'
      const errorCode = error instanceof HarnessTimeoutError ? 'execution_deadline_exceeded'
        : error instanceof HarnessAuthRequiredError ? (latest.error_code ?? 'credentials_required')
        : state === 'TASK_STATE_CANCELED' ? 'cancelled' : 'execution_failed'
      outcome = { state, message: errorMessage(error),
        ...(this.journal ? { diagnostics: safeDiagnostic({ ...latest, kind: 'error', error_code: errorCode, changes: 'unknown', elapsed_ms: Date.now() - started }) } : {}) }
      this.log(state === 'TASK_STATE_CANCELED' ? 'info' : 'warn',
        state === 'TASK_STATE_CANCELED' ? 'A2A task cancelled' : 'A2A task failed', { taskId: task.id, state })
    } finally {
      // A timeout/cancellation is not a machine release. Retain the local FIFO
      // and remote lease until tools drain and native history has been flushed.
      if (execution && !settled) await progress({ kind: 'progress', stage: 'draining' }).catch(() => undefined)
      if (execution) await execution.catch(() => undefined)
      if (heartbeat) clearInterval(heartbeat)
      if (drainError instanceof HarnessDrainUnconfirmedError && this.executionLeases) {
        await this.journal!.requireRecovery(task.id, envelope.deliveryId)
        await this.safeReport(task.id, { ...outcome, diagnostics: { ...latest, kind: 'error', stage: 'recovery_required',
          error_code: 'drain_unconfirmed', summary: 'Inspect the native session and stop its tools before confirming machine release.', changes: 'unknown' } })
      } else if (Object.keys(outcome).length || this.executionLeases) {
        await this.finishDelivery(envelope, outcome)
      } else {
        await this.journal?.finish(task.id)
      }
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
