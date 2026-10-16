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
} from './types.js'

export class HarnessAuthRequiredError extends Error {
  override name = 'HarnessAuthRequiredError'
}

export class HarnessInputRequiredError extends Error {
  override name = 'HarnessInputRequiredError'
}

class HarnessTimeoutError extends Error {
  override name = 'HarnessTimeoutError'
}

export type TaskReporter = (taskId: string, event: TaskEvent) => Promise<void>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The local task failed'
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

export class TaskRunner {
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
  ) {}

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
    // until that execution has actually disposed its Harness handle.
    await Promise.allSettled([...this.executions])
    this.active.clear()
  }

  private async start(envelope: A2ATaskEnvelope): Promise<void> {
    const { task } = envelope
    if (this.active.has(task.id)) return
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
    try {
      // Executing local work requires the gateway to accept this claim. In
      // particular, a revoked credential or stale grant must stop execution.
      await this.report(task.id, { state: 'TASK_STATE_WORKING' })
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
        requestApproval: (reason) => this.requestApproval(reason),
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
      await this.safeReport(task.id, {
        state: 'TASK_STATE_COMPLETED',
        ...(artifacts.length ? { artifacts } : {}),
      })
    } catch (error) {
      const state: A2ATaskState = error instanceof HarnessTimeoutError
        ? 'TASK_STATE_FAILED'
        : controller.signal.aborted || isAbortError(error)
          ? 'TASK_STATE_CANCELED'
          : error instanceof HarnessAuthRequiredError
          ? 'TASK_STATE_AUTH_REQUIRED'
          : error instanceof HarnessInputRequiredError
            ? 'TASK_STATE_INPUT_REQUIRED'
            : 'TASK_STATE_FAILED'
      await this.safeReport(task.id, { state, message: errorMessage(error) })
      this.log('warn', 'A2A task failed', { taskId: task.id, state })
    } finally {
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
    const seconds = Math.min(Math.max(timeoutSeconds ?? 300, 1), 3600)
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
      await this.report(taskId, event)
    } catch (error) {
      this.log('error', 'Unable to report A2A task state', {
        taskId,
        state: event.state,
        error: errorMessage(error),
      })
    }
  }
}
