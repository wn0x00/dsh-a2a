import type { Context } from '@deepseek-ai/cordis'
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

export type ConnectionControlAction =
  | 'connect'
  | 'reauthorize'
  | 'cancelPendingAuthorization'
export type ConnectionControl = {
  status(): ConnectionSnapshot
  act(action: ConnectionControlAction): Promise<void>
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
  status(): ConnectionSnapshot {
    this.requireOwner()
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
