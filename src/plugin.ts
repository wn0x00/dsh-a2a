import { GatewayClient } from './gateway.js'
import { OAuthClient, OAuthLoginRequiredError } from './pkce.js'
import { TaskRunner } from './task-runner.js'
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

  /** Start the device connection. If no token exists, this opens PKCE login. */
  async start(): Promise<void> {
    if (this.loopPromise) return
    try {
      await this.oauth.accessToken()
      await this.gateway.register(this.allowedSkills)
    } catch (error) {
      if (!(error instanceof OAuthLoginRequiredError)) throw error
      await this.oauth.beginAuthorization()
      this.log('info', 'OAuth login required; browser authorization was opened')
      return
    }
    // Register for both pull and SSE transports.  Registration binds the stable
    // device id to the OAuth subject before the first task claim; pull mode used
    // to skip it and therefore required an out-of-band database row.
    this.stopController = new AbortController()
    this.loopPromise = this.runLoop()
  }

  /** Complete the callback received by the host's localhost redirect server. */
  async completeAuthorization(code: string, state: string): Promise<void> {
    await this.oauth.completeAuthorization(code, state)
    await this.start()
  }

  async cancelAuthorization(state: string): Promise<void> {
    await this.oauth.cancelAuthorization(state)
    this.log('info', 'Device authorization was declined; restart the plugin to retry')
  }

  async logout(): Promise<void> {
    await this.stop()
    await this.oauth.logout()
  }

  async stop(): Promise<void> {
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
          if (envelope) this.dispatch({ type: 'task', envelope })
          await this.sleep(
            envelope ? Math.min(delay, 250) : delay,
            stopController.signal,
          )
          continue
        }
        for await (const event of this.gateway.events(stopController.signal, this.lastEventId)) {
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
          // Pause task polling while consent is pending. A fresh callback starts
          // a new loop; repeated 401s must not open a browser on every poll.
          await this.runner.stop()
          this.loopPromise = undefined
          this.stopController = undefined
          try {
            await this.oauth.beginAuthorization()
            this.log('info', 'Device authorization expired or was revoked; confirm authorization in the platform')
          } catch (authorizationError) {
            this.log('error', 'Unable to request device authorization; restart Harness to retry', {
              error: authorizationError instanceof Error ? authorizationError.message : String(authorizationError),
            })
          }
          return
        }
        if (!stopController.signal.aborted) {
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
