export type ConnectionPhase =
  | 'starting'
  | 'disconnected'
  | 'authorizing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'authorization_required'
  | 'error'
  | 'stopped'

export type ConnectionNotice =
  | 'none'
  | 'authorization_denied'
  | 'authorization_timeout'
  | 'authorization_failed'
  | 'registration_failed'

/** The complete public projection. Never add tokens, PKCE state or credentials. */
export type ConnectionSnapshot = {
  phase: ConnectionPhase
  notice: ConnectionNotice
  gatewayUrl: string
  deviceId: string
  deviceName: string
  activeTasks: number
  pendingExpiresAt: number | null
  lastConnectedAt: number | null
  lastContactAt: number | null
  canConnect: boolean
  canReauthorize: boolean
  canCancelAuthorization: boolean
}

export class ConnectionActionError extends Error {
  constructor(readonly code: 'busy' | 'unavailable') {
    super(
      code === 'busy'
        ? 'A platform task or connection operation is active'
        : 'The plugin is unavailable',
    )
  }
}
