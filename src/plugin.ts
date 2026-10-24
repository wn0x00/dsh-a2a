import { GatewayClient } from './gateway.js'
import { OAuthClient, OAuthLoginRequiredError } from './pkce.js'
import { TaskRunner } from './task-runner.js'
import { ConnectionActionError, type ConnectionNotice, type ConnectionPhase, type ConnectionSnapshot } from './connection-state.js'
import type { BridgeConfig, GatewayEvent, HarnessContext, HarnessSkill } from './types.js'
import { A2A_MESSAGE_CAPABILITY } from './types.js'

export class A2ABridge {
  private readonly oauth: OAuthClient
  private readonly gateway: GatewayClient
  private readonly runner: TaskRunner
  private readonly allowedSkills: string[]
  private stopController: AbortController | undefined
  private loopPromise: Promise<void> | undefined
  private lastEventId: string | undefined
  private connecting: Promise<void> | undefined
  private completing: Promise<void> | undefined
  private phase: ConnectionPhase = 'disconnected'
  private notice: ConnectionNotice = 'none'
  private lastConnectedAt: number | null = null
  private lastContactAt: number | null = null
  private restoreAfterAuthorization = false
  private authorizationTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  status(): ConnectionSnapshot {
    const activeTasks = this.runner.activeTaskIds().length
    const busy = Boolean(this.connecting) || ['starting', 'authorizing', 'connecting', 'stopped'].includes(this.phase)
    return {
      phase: this.phase, notice: this.notice,
      gatewayUrl: new URL(this.config.gatewayUrl).origin,
      deviceId: this.config.device.id, deviceName: this.config.device.name,
      activeTasks, pendingExpiresAt: this.oauth.pendingExpiresAt(),
      lastConnectedAt: this.lastConnectedAt, lastContactAt: this.lastContactAt,
      canConnect: !busy && !this.disposed && !this.loopPromise,
      canReauthorize: !busy && !this.disposed && activeTasks === 0,
      canCancelAuthorization: !this.disposed && !this.connecting && !this.completing && this.phase === 'authorizing' && this.oauth.pendingExpiresAt() !== null,
    }
  }

  constructor(
    private readonly ctx: HarnessContext,
    private readonly config: BridgeConfig,
  ) {
    const fetchImpl = config.fetch ?? globalThis.fetch
    const nativeMessages = config.executionMode === 'a2a-message'
    const capabilities = config.device.capabilities.filter((value) => value !== A2A_MESSAGE_CAPABILITY)
    if (nativeMessages) capabilities.push(A2A_MESSAGE_CAPABILITY)
    this.oauth = new OAuthClient(config.oauth, fetchImpl)
    this.gateway = new GatewayClient(
      config.gatewayUrl,
      { ...config.device, capabilities },
      this.oauth,
      config.transport ?? 'pull',
      config.gatewayPaths,
      fetchImpl,
    )
    const skills: Record<string, HarnessSkill> = nativeMessages ? {} : { ...(config.skills ?? {}) }
    for (const skillId of nativeMessages ? [] : config.allowedSkills ?? []) {
      skills[skillId] ??= (input, context) => ctx.agents.run(skillId, input, context)
    }
    // Advertise exactly the executable registry, including explicitly supplied
    // custom handlers. Filesystem/browser permissions are a separate policy.
    this.allowedSkills = Object.keys(skills)
    this.runner = new TaskRunner(
      ctx,
      config.device.capabilities,
      skills,
      (taskId, event) => this.gateway.taskEvent(taskId, event),
      (level, message, fields) => this.log(level, message, fields),
      nativeMessages ? (message, context) => ctx.agents.run('', message, context) : undefined,
      () => this.oauth.sessionScope(),
    )
  }

  /** Restore saved credentials without opening a browser on startup/revocation. */
  async start(): Promise<void> {
    if (this.loopPromise) return
    if (this.connecting || this.completing || ['starting', 'connecting', 'authorizing'].includes(this.phase)) {
      throw new ConnectionActionError('busy')
    }
    this.disposed = false
    this.phase = 'starting'
    try {
      await this.registerConnection()
    } catch (error) {
      if (!(error instanceof OAuthLoginRequiredError)) {
        this.phase = 'error'
        throw error
      }
      this.phase = 'authorization_required'
      this.log('info', 'Connect this device from Harness Settings → Xbot platform tasks')
    }
  }

  /** The local Settings button or explicitly invoked diagnostic starts consent. */
  async connect(): Promise<void> {
    if (this.disposed) throw new ConnectionActionError('unavailable')
    if (this.phase === 'authorizing') return
    if (this.connecting) return this.connecting
    if (this.completing || ['starting', 'connecting'].includes(this.phase)) throw new ConnectionActionError('busy')
    this.connecting = (async () => {
      this.notice = 'none'
      try {
        await this.registerConnection()
      } catch (error) {
        if (!(error instanceof OAuthLoginRequiredError)) {
          this.phase = 'error'
          this.notice = 'registration_failed'
          throw error
        }
        await this.requestAuthorization(false)
      }
    })()
    try { await this.connecting } finally { this.connecting = undefined }
  }

  /** Pause an idle connection, retaining its grant until replacement succeeds. */
  async reauthorize(): Promise<void> {
    if (this.disposed) throw new ConnectionActionError('unavailable')
    if (this.connecting || this.completing || ['starting', 'connecting', 'authorizing'].includes(this.phase) || this.runner.activeTaskIds().length) {
      throw new ConnectionActionError('busy')
    }
    this.connecting = this.requestAuthorization(true)
    try { await this.connecting } finally { this.connecting = undefined }
  }

  private async requestAuthorization(replace: boolean): Promise<void> {
    this.phase = 'authorizing'
    this.notice = 'none'
    try {
      if (replace) await this.stopPolling()
      this.restoreAfterAuthorization = replace && await this.oauth.hasCredentials()
      await this.oauth.beginAuthorization(true)
      if (this.disposed) {
        await this.oauth.clearPendingAuthorization()
        return
      }
      const expiresAt = this.oauth.pendingExpiresAt()
      clearTimeout(this.authorizationTimer)
      this.authorizationTimer = setTimeout(() => {
        void this.expireAuthorization().catch(() => undefined)
      }, Math.max(1, (expiresAt ?? Date.now() + 600_000) - Date.now()))
      this.authorizationTimer.unref()
      this.log('info', 'Browser authorization opened; approve this device in the platform')
    } catch (error) {
      await this.restoreConnection('authorization_failed')
      throw error
    }
  }

  async expireAuthorization(): Promise<void> {
    if (this.phase !== 'authorizing' || this.completing) return
    await this.oauth.clearPendingAuthorization()
    await this.restoreConnection('authorization_timeout')
  }

  private async restoreConnection(notice: ConnectionNotice): Promise<void> {
    clearTimeout(this.authorizationTimer)
    this.notice = notice
    const restore = this.restoreAfterAuthorization
    this.restoreAfterAuthorization = false
    if (this.disposed) return
    if (!restore) {
      this.phase = 'authorization_required'
      return
    }
    try { await this.registerConnection() } catch (error) {
      this.phase = error instanceof OAuthLoginRequiredError ? 'authorization_required' : 'error'
    }
  }

  private async registerConnection(): Promise<void> {
    if (this.loopPromise) return
    if (this.disposed) throw new ConnectionActionError('unavailable')
    this.phase = 'connecting'
    await this.oauth.accessToken()
    await this.gateway.register(this.allowedSkills)
    if (this.disposed) return
    this.phase = 'connected'
    this.lastConnectedAt = this.lastContactAt = Date.now()
    // Register for both pull and SSE transports.  Registration binds the stable
    // device id to the OAuth subject before the first task claim; pull mode used
    // to skip it and therefore required an out-of-band database row.
    this.stopController = new AbortController()
    this.loopPromise = this.runLoop()
  }

  /** Complete the callback received by the host's localhost redirect server. */
  async completeAuthorization(code: string, state: string): Promise<void> {
    if (this.disposed) throw new ConnectionActionError('unavailable')
    if (this.completing) throw new ConnectionActionError('busy')
    // Validate before disarming the deadline: a forged callback cannot alter
    // the real pending request. Once exchange starts it owns completion.
    this.oauth.validateAuthorizationState(state)
    clearTimeout(this.authorizationTimer)
    this.completing = this.finishAuthorization(code, state)
    try { await this.completing } finally { this.completing = undefined }
  }

  private async finishAuthorization(code: string, state: string): Promise<void> {
    try {
      await this.oauth.completeAuthorization(code, state)
    } catch (error) {
      // A forged or stale callback must not cancel the real pending request.
      if (this.oauth.pendingExpiresAt() === null) {
        await this.restoreConnection('authorization_failed')
      }
      throw error
    }
    clearTimeout(this.authorizationTimer)
    // The platform atomically revoked the old grant at code exchange. It is no
    // longer a usable fallback, even if subsequent device registration fails.
    this.restoreAfterAuthorization = false
    this.notice = 'none'
    if (this.disposed) throw new ConnectionActionError('unavailable')
    // A successful token exchange alone is not a connected device. Registration
    // errors must reach the callback page, never start another consent silently.
    try { await this.registerConnection() } catch (error) {
      this.phase = error instanceof OAuthLoginRequiredError ? 'authorization_required' : 'error'
      this.notice = 'registration_failed'
      throw error
    }
  }

  async updateIdentity(identity: { name: string; description: string }): Promise<void> {
    Object.assign(this.config.device, identity)
    if (this.config.oauth.device) this.config.oauth.device.name = identity.name
    this.gateway.updateIdentity(identity)
    if (!this.loopPromise) return
    try {
      await this.gateway.register(this.allowedSkills)
    } catch (error) {
      if (error instanceof OAuthLoginRequiredError) {
        await this.stopPolling()
        this.phase = 'authorization_required'
      }
      throw error
    }
  }

  async cancelAuthorization(state: string): Promise<void> {
    await this.oauth.cancelAuthorization(state)
    await this.restoreConnection('authorization_denied')
    this.log('info', 'Device authorization was declined; connect again from Harness settings')
  }

  async cancelPendingAuthorization(): Promise<void> {
    if (this.disposed) throw new ConnectionActionError('unavailable')
    if (!this.status().canCancelAuthorization) throw new ConnectionActionError('busy')
    await this.oauth.clearPendingAuthorization()
    await this.restoreConnection('authorization_denied')
  }

  async logout(): Promise<void> {
    await this.stop()
    await this.oauth.logout()
  }

  async stop(): Promise<void> {
    this.disposed = true
    clearTimeout(this.authorizationTimer)
    await this.completing?.catch(() => undefined)
    await this.oauth.clearPendingAuthorization()
    await this.stopPolling()
    this.phase = 'stopped'
  }

  private async stopPolling(): Promise<void> {
    this.stopController?.abort()
    await this.runner.stop()
    const loop = this.loopPromise
    this.loopPromise = undefined
    if (loop) await loop.catch(() => undefined)
    this.stopController = undefined
  }

  private async runLoop(): Promise<void> {
    const stopController = this.stopController
    if (!stopController) return
    const delay = Math.max(
      this.config.pollIntervalMs ?? this.config.reconnectDelayMs ?? 3000,
      250,
    )
    while (!stopController.signal.aborted) {
      try {
        if ((this.config.transport ?? 'pull') === 'pull') {
          // The internal pull relay carries jobs; cancellation is observed via
          // standard GetTask so a cloud CancelTask reaches the running Agent.
          await Promise.all(this.runner.activeTaskIds().map(async (taskId) => {
            const task = await this.gateway.getTask(taskId, stopController.signal)
            if (task.state === 'TASK_STATE_CANCELED') this.runner.cancel(taskId)
          }))
          const envelope = await this.gateway.nextTask(stopController.signal)
          if (stopController.signal.aborted) break
          this.phase = 'connected'
          this.lastContactAt = Date.now()
          if (envelope) this.dispatch({ type: 'task', envelope })
          await this.sleep(
            envelope ? Math.min(delay, 250) : delay,
            stopController.signal,
          )
          continue
        }
        for await (const event of this.gateway.events(stopController.signal, this.lastEventId)) {
          if (stopController.signal.aborted) break
          this.phase = 'connected'
          this.lastContactAt = Date.now()
          if (event.eventId) this.lastEventId = event.eventId
          this.dispatch(event)
          if (event.type === 'task') {
            // Ack once the event is accepted into the local deduplication queue.
            await this.gateway.acknowledge(event.envelope.deliveryId).catch((error) => {
              this.log('warn', 'Unable to acknowledge gateway delivery', {
                deliveryId: event.envelope.deliveryId,
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }
        }
      } catch (error) {
        if (error instanceof OAuthLoginRequiredError && !stopController.signal.aborted) {
          // Revocation is an intentional disconnect. Only a local user action
          // may open a fresh authorization page, even after restarting Harness.
          await this.runner.stop()
          this.loopPromise = undefined
          this.stopController = undefined
          this.phase = 'authorization_required'
          this.log('info', 'Device authorization expired or was revoked; connect again from Harness Settings → Xbot platform tasks')
          return
        }
        if (!stopController.signal.aborted) {
          this.phase = 'reconnecting'
          this.log('warn', 'A2A gateway connection closed; reconnecting', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (!stopController.signal.aborted) await this.sleep(delay, stopController.signal)
    }
  }

  private dispatch(event: GatewayEvent): void {
    if (!this.stopController || this.stopController.signal.aborted) return
    void this.runner.handle(event).catch((error) => {
      this.log('error', 'Unable to dispatch gateway event', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    this.ctx.logger?.[level]?.(message, fields)
  }
}

/**
 * Harness plugin entry point. Keep this shape as the only Harness-facing
 * surface; adapt `HarnessContext` at the host plugin boundary.
 */
export function createBridge(ctx: HarnessContext, config: BridgeConfig): A2ABridge {
  return new A2ABridge(ctx, config)
}

/** Backwards-compatible low-level factory. Native Harness loading uses
 * `harness.ts` and its Cordis `apply(ctx, config)` entry instead. */
export const apply = createBridge

/** Host plugin cleanup hook. */
export async function cleanup(bridge: A2ABridge): Promise<void> {
  await bridge.stop()
}

export const inject = ['agents', 'tools'] as const
