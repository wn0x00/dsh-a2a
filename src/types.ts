/** Public contracts used by the bridge. These are deliberately independent of
 * private DeepSeek Harness classes; the host plugin supplies the adapter. */

export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_UNKNOWN'

export type A2APart = {
  text?: string
  data?: unknown
  raw?: unknown
  mediaType?: string
  uri?: string
  filename?: string
}

/** A2A v1 Message. Skills describe the Agent; they are not execution routes. */
export type A2AMessage = {
  messageId: string
  role: 'ROLE_USER' | 'ROLE_AGENT'
  parts: A2APart[]
  contextId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}

/** Internal relay negotiation; this is not an A2A protocol capability. */
export const A2A_MESSAGE_CAPABILITY = 'dsh.a2a.message.v1'

export type A2AArtifact = {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
}

export type A2ATask = {
  id: string
  contextId: string
  state: A2ATaskState
  /** Optional wire-format status retained for A2A v1 compatibility. */
  status?: { state: A2ATaskState; message?: unknown; timestamp?: string }
  statusMessage?: string
  artifacts?: A2AArtifact[]
  history?: unknown[]
  metadata?: Record<string, unknown>
  version?: number
}

type RelayTaskOptions = {
  task: A2ATask
  /** A gateway-generated id used to deduplicate an at-least-once stream. */
  deliveryId: string
  requestedCapabilities?: string[]
  approvalRequired?: boolean
  timeoutSeconds?: number
}

/** Private delivery envelope around standard A2A Message / Task objects. */
export type A2ATaskEnvelope = RelayTaskOptions & (
  | { executionMode: 'a2a-message'; message: A2AMessage }
  | { executionMode?: 'legacy-skill'; skillId: string; input: unknown }
)

export type GatewayEvent =
  | { type: 'task'; envelope: A2ATaskEnvelope; eventId?: string }
  | { type: 'cancel'; taskId: string; eventId?: string }
  | { type: 'ping'; eventId?: string }

export type HarnessRunContext = {
  taskId: string
  contextId: string
  signal: AbortSignal
  requestApproval: (reason: string) => Promise<boolean>
  executionMode?: 'a2a-message' | 'legacy-skill'
  /** Locally generated authorization epoch; never accepted from task metadata. */
  sessionScope?: string
}

export type HarnessRunResult = {
  text?: string
  artifacts?: A2AArtifact[]
}

export type HarnessSkill = (
  input: unknown,
  context: HarnessRunContext,
) => Promise<HarnessRunResult>

export type HarnessContext = {
  /** Release retained native sessions after the bridge has drained its tasks. */
  dispose?: () => Promise<void>
  /** Map this to the public Agent/Session invocation API in the installed
   * Harness release. The bridge itself does not import private Harness code. */
  agents: {
    run: (
      skillId: string,
      input: unknown,
      context: HarnessRunContext,
    ) => Promise<HarnessRunResult>
  }
  logger?: {
    info?: (message: string, fields?: Record<string, unknown>) => void
    warn?: (message: string, fields?: Record<string, unknown>) => void
    error?: (message: string, fields?: Record<string, unknown>) => void
  }
  ui?: {
    confirm?: (reason: string) => Promise<boolean>
  }
}

/** Structural subset of the DeepSeek Harness Cordis agent service used by the
 * native plugin entry. Keeping this structural lets the bridge's standalone
 * npm tests run without installing the whole Harness monorepo. */
export type HarnessCordisContext = {
  baseUrl?: string
  fiber?: { uid?: number }
  on?: {
    (name: 'internal/config', handler: (this: { uid?: number }, raw: unknown, next: () => unknown) => unknown): unknown
    (name: 'loader/volatile-update', handler: () => void): unknown
  }
  get?: {
    (name: 'fs'): {
      resolve: (path: string) => Promise<unknown>
      processPath: (path: unknown) => string
      processPathFromHostPath?: (path: string) => string | undefined
      stat?: (path: unknown) => Promise<{ type: string } | undefined>
    } | undefined
    (name: 'sessionPersistence'): unknown
    (name: 'sessions'): {
      flush: (session: HarnessAgentHandle['agent']['session']) => Promise<boolean>
    } | undefined
    (name: 'workspaceRegistry'): {
      create: (path: string) => Promise<HarnessWorkspace>
    } | undefined
    (name: 'sessionProjections'): {
      stateOf: (session: HarnessAgentHandle['agent']['session'], key: 'modelSelection') => {
        pending?: HarnessModelSelection | null
      } | undefined
    } | undefined
    (name: 'agentPresets'): {
      resolve: (id?: string) => Promise<{ id: string; broken?: string }>
      mount: (context: unknown, id: string) => Promise<unknown>
    } | undefined
  }
  agentDefaultModel?: {
    currentSelection: () => { provider?: string; model?: string }
  }
  agents: {
    get?: (sessionId: string) => HarnessAgentHandle['agent'] | undefined
    create: (options: {
      sessionId: string
      signal?: AbortSignal
      meta?: { cwd: string; agentPreset?: string }
      agentOptions?: { provider?: string; model?: string; maxTokens?: number }
      setup?: (context: unknown, agent: HarnessAgentHandle['agent']) => Promise<void>
    }) => Promise<HarnessAgentHandle>
    resume?: (options: {
      resumeSessionId: string
      signal?: AbortSignal
      agentOptions?: { provider?: string; model?: string; maxTokens?: number }
      setup?: (context: unknown, agent: HarnessAgentHandle['agent']) => Promise<void>
    }) => Promise<HarnessAgentHandle>
  }
  effect: (effect: () => void | (() => void | Promise<void>)) => unknown
}

export type HarnessAgentHandle = {
      agent: {
        id?: string
        status?: 'idle' | 'running'
        options?: { provider?: string; model?: string; reasoningEffort?: string }
        followup: (message: {
          id: string
          role: 'user'
          content: Array<{ type: 'text'; text: string }>
          source: { kind: 'user' }
        }) => void
        whenIdle: () => Promise<void>
        cancel?: (cause: { kind: 'user' }) => void
        session: {
          header?: { cwd?: string; agentPreset?: string }
          requestHeader?: () => { config: HarnessModelSelection; adapterDefaults?: { reasoningEffort?: boolean } } | undefined
          snapshotEvents?: () => ReadonlyArray<HarnessSessionEvent>
          deriveMessages: () => ReadonlyArray<{
            role: string
            content: ReadonlyArray<{ type?: string; text?: string }>
          }>
        }
      }
      dispose: () => Promise<void>
}

/** DSH workspaces own a canonical directory and durable session membership. */
export type HarnessWorkspace = {
  id: string
  path: string
  attachSession: (sessionId: string) => Promise<void>
}

export type HarnessModelSelection = {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Only diagnostic fields are read; raw commands and tool output stay local. */
export type HarnessSessionEvent = {
  type: string
  seq?: number
  data?: {
    turn?: number
    name?: string
    callId?: string
    reason?: { kind: string; error?: { code?: string; message?: string; status?: number; requestId?: string } }
    error?: { code?: string; reason?: string }
    message?: { isError?: boolean; toolCallId?: string }
  }
}

export type HarnessConfigString = string | { get: () => string }

/** Configuration accepted by the actual Cordis plugin entry. There is no
 * built-in platform address: the user configures `gatewayUrl` in Settings
 * (persisted by the host) or through the environment. */
export type HarnessPluginConfig = {
  /** Explicit opt-in; the Host checks daily and installs only while idle. */
  automaticUpdates?: boolean | { get: () => boolean }
  /** The volatile value is supplied by native Harness Settings. */
  workingDirectory?: HarnessConfigString
  /** Local Harness tool/prompt composition; empty follows the host default. */
  agentPreset?: HarnessConfigString
  /** Platform base origin; required, configured and persisted by the user. */
  gatewayUrl?: HarnessConfigString
  /** External issuers are opt-in; legacy issuer environment values are ignored. */
  authMode?: 'platform' | 'external'
  profile?: string
  storageDirectory?: string
  issuerUrl?: string
  clientId?: string
  redirectUri?: string
  deviceId?: string
  deviceName?: HarnessConfigString
  deviceDescription?: HarnessConfigString
  /** Changed only by the local Settings connect button; never a credential. */
  connectionRequest?: HarnessConfigString
  platform?: string
  capabilities?: string[]
  scopes?: string[]
  pollIntervalMs?: number
  provider?: HarnessConfigString
  model?: HarnessConfigString
  allowedSkills?: string[]
  /** Compatibility for the standalone diagnostic; native Harness uses messages. */
  executionMode?: 'a2a-message' | 'legacy-skill'
  /** Require an explicit approval for remote tasks in the native host. */
  approveRemoteTasks?: boolean
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresAt: number
  scope?: string
  sessionScope?: string
}

export type TokenStore = {
  get: () => Promise<TokenSet | undefined>
  set: (tokens: TokenSet) => Promise<void>
  clear: () => Promise<void>
}

export type OAuthConfig = {
  clientId: string
  authorizationEndpoint: string
  tokenEndpoint: string
  authorizationRequestEndpoint?: string
  revocationEndpoint?: string
  device?: Pick<DeviceConfig, 'id' | 'name' | 'platform'>
  redirectUri: string
  scopes: string[]
  openAuthorizationUrl: (url: string) => Promise<void> | void
  /** Opens the loopback listener only while authorization is pending. */
  prepareAuthorization?: () => Promise<void>
  authorizationCompleted?: () => Promise<void>
  tokenStore?: TokenStore
}

export type DeviceConfig = {
  id: string
  name: string
  description?: string
  platform?: string
  capabilities: string[]
}

export type BridgeConfig = {
  gatewayUrl: string
  oauth: OAuthConfig
  device: DeviceConfig
  transport?: 'sse' | 'pull'
  pollIntervalMs?: number
  gatewayPaths?: {
    register?: string
    events?: string
    nextTask?: string
    taskEvents?: string
    cancel?: string
    acknowledge?: string
  }
  /** Skill ids that may call `ctx.agents.run` directly. */
  allowedSkills?: string[]
  executionMode?: 'a2a-message' | 'legacy-skill'
  skills?: Record<string, HarnessSkill>
  reconnectDelayMs?: number
  fetch?: typeof globalThis.fetch
}

export type AgentCard = {
  name: string
  description?: string
  version?: string
  supportedInterfaces: Array<{
    url: string
    protocolBinding: string
    protocolVersion: string
  }>
  capabilities?: {
    streaming?: boolean
    pushNotifications?: boolean
  }
  skills?: Array<Record<string, unknown>>
}

export type DeviceRegistration = {
  deviceId: string
  connectionToken?: string
  expiresAt?: string
}

export type TaskEvent = {
  state: A2ATaskState
  message?: string
  artifacts?: A2AArtifact[]
}
