import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import {
  Remote,
  RemoteError,
  TypertRemoteService,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { connectionContribution } from './connection-contract.js'
import {
  ConnectionActionError,
  type ConnectionSnapshot,
} from './connection-state.js'
import type { PluginUpdater, PluginUpdateSnapshot } from './plugin-update.js'

export type ConnectionControlAction =
  | 'connect'
  | 'reauthorize'
  | 'cancelPendingAuthorization'
export type ConnectionControl = {
  status(): ConnectionSnapshot
  act(action: ConnectionControlAction): Promise<void>
  updater?(): PluginUpdater | undefined
}

/** Management calls belong to the local Host owner, never remote task agents. */
export class ConnectionController extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly control: ConnectionControl,
  ) {
    super(ctx, 'xbotA2a')
  }

  private requireOwner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError(
        'gateway/bad-request',
        'Only the local Host owner can manage the platform connection',
        {},
      )
    }
  }

  @Remote
  status(signal?: AbortSignal): ConnectionSnapshot {
    this.requireOwner()
    signal?.throwIfAborted()
    return this.control.status()
  }

  @Remote
  async connect(): Promise<ConnectionSnapshot> {
    return this.perform('connect')
  }

  @Remote
  async reauthorize(): Promise<ConnectionSnapshot> {
    return this.perform('reauthorize')
  }

  @Remote
  async cancelAuthorization(): Promise<ConnectionSnapshot> {
    return this.perform('cancelPendingAuthorization')
  }

  @Remote
  updateStatus(signal?: AbortSignal): PluginUpdateSnapshot {
    this.requireOwner()
    signal?.throwIfAborted()
    const updater = this.getUpdater('updateStatus')
    try {
      return updater.status()
    } catch {
      throw this.updateFailure()
    }
  }

  @Remote
  async checkUpdate(): Promise<PluginUpdateSnapshot> {
    return this.performUpdate('checkUpdate', (updater) => updater.check())
  }

  @Remote
  async installUpdate(expectedVersion: string): Promise<PluginUpdateSnapshot> {
    return this.performUpdate('installUpdate', (updater) => updater.install(expectedVersion))
  }

  @Remote
  async setUpdateCredential(token: string): Promise<PluginUpdateSnapshot> {
    return this.performUpdate('setUpdateCredential', (updater) => updater.setCredential(token))
  }

  @Remote
  async clearUpdateCredential(): Promise<PluginUpdateSnapshot> {
    return this.performUpdate('clearUpdateCredential', (updater) => updater.clearCredential())
  }

  private getUpdater(method: string): PluginUpdater {
    try {
      const updater = this.control.updater?.()
      if (updater) return updater
    } catch {
      // The factory may depend on Host startup; its diagnostics stay local.
    }
    throw new RemoteError(
      'gateway/service-unavailable',
      'Plugin updates are not available in this Host. Try again after startup.',
      { endpoint: `xbotA2a/${method}` },
    )
  }

  private updateFailure(): RemoteError {
    return new RemoteError(
      'gateway/internal',
      'The plugin update operation could not be completed. Check its status before retrying.',
      {},
    )
  }

  private async performUpdate(
    method: 'checkUpdate' | 'installUpdate' | 'setUpdateCredential' | 'clearUpdateCredential',
    action: (updater: PluginUpdater) => Promise<PluginUpdateSnapshot>,
  ): Promise<PluginUpdateSnapshot> {
    this.requireOwner()
    const updater = this.getUpdater(method)
    try {
      // The Host installer owns its lifetime, including replacement of this
      // plugin. A Client cancellation must not abort an accepted installation.
      return await action(updater)
    } catch {
      throw this.updateFailure()
    }
  }

  private async perform(
    action: ConnectionControlAction,
  ): Promise<ConnectionSnapshot> {
    this.requireOwner()
    try {
      await this.control.act(action)
    } catch (error) {
      // Network failures can include credential-bearing server responses.
      throw new RemoteError(
        'gateway/bad-request',
        error instanceof ConnectionActionError && error.code === 'busy'
          ? 'A task or authorization is active. Try again when it finishes.'
          : 'The platform connection could not be updated. Check the connection status and retry.',
        {},
      )
    }
    return this.control.status()
  }
}

export function installConnectionControl(
  ctx: Context,
  control: ConnectionControl,
): void {
  ctx.inject(['typert'], (scope) => {
    const contribution = connectionContribution(z)
    // The registry API is a public optional Host service; no monorepo runtime
    // dependency is needed to register this package's strict descriptors.
    const registry = scope.get('typert') as unknown as {
      register(value: unknown): unknown
    }
    registry.register({
      package: contribution.package,
      face: 'host',
      schemas: [],
      invocations: contribution.descriptors,
    })
    new ConnectionController(scope, control)
  })
}
