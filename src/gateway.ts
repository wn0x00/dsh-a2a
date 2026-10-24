import type {
  AgentCard,
  A2AArtifact,
  A2AMessage,
  A2ATaskEnvelope,
  A2ATask,
  A2ATaskState,
  DeviceRegistration,
  GatewayEvent,
  TaskEvent,
} from './types.js'
import { OAuthClient, OAuthLoginRequiredError } from './pkce.js'
import type { BridgeConfig, DeviceConfig } from './types.js'

type FetchImpl = typeof globalThis.fetch

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway returned an invalid JSON object')
  }
  return value as Record<string, unknown>
}

function asTask(value: unknown): A2ATask {
  const payload = asObject(value)
  if (typeof payload.id !== 'string' || typeof payload.contextId !== 'string') {
    throw new Error('Task event has no id or contextId')
  }
  const status = payload.status && typeof payload.status === 'object'
    ? asObject(payload.status)
    : undefined
  const stateValue = payload.state ?? status?.state
  const states: A2ATaskState[] = [
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_FAILED',
    'TASK_STATE_REJECTED',
    'TASK_STATE_UNKNOWN',
  ]
  if (typeof stateValue !== 'string' || !states.includes(stateValue as A2ATaskState)) {
    throw new Error('Task event has an invalid state')
  }
  return {
    id: payload.id,
    contextId: payload.contextId,
    state: stateValue as A2ATaskState,
    ...(status
      ? {
          status: {
            state: stateValue as A2ATaskState,
            ...(typeof status.message !== 'undefined' ? { message: status.message } : {}),
            ...(typeof status.timestamp === 'string' ? { timestamp: status.timestamp } : {}),
          },
        }
      : {}),
    ...(typeof payload.statusMessage === 'string' ? { statusMessage: payload.statusMessage } : {}),
    ...(Array.isArray(payload.artifacts) ? { artifacts: payload.artifacts as A2AArtifact[] } : {}),
    ...(Array.isArray(payload.history) ? { history: payload.history } : {}),
    ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? { metadata: payload.metadata as Record<string, unknown> }
      : {}),
    ...(typeof payload.version === 'number' ? { version: payload.version } : {}),
  }
}

function asMessage(value: unknown, task: A2ATask): A2AMessage {
  const message = asObject(value)
  if (typeof message.messageId !== 'string' || !message.messageId
    || message.role !== 'ROLE_USER' || !Array.isArray(message.parts) || !message.parts.length) {
    throw new Error('Relay task must contain an A2A user Message')
  }
  if ((message.contextId !== undefined && message.contextId !== task.contextId)
    || (message.taskId !== undefined && message.taskId !== task.id)) {
    throw new Error('Message does not belong to the delivered Task/context')
  }
  for (const part of message.parts) {
    const value = asObject(part)
    const fields = ['text', 'data', 'raw', 'uri'].filter((key) => Object.hasOwn(value, key))
    if (fields.length !== 1 || (Object.hasOwn(value, 'text') && typeof value.text !== 'string')) {
      throw new Error('Message contains an invalid A2A Part')
    }
  }
  return message as A2AMessage
}

function parseGatewayEvent(eventName: string, value: unknown, eventId?: string): GatewayEvent {
  const payload = asObject(value)
  if (eventName === 'cancel') {
    if (typeof payload.taskId !== 'string') throw new Error('Cancel event has no taskId')
    return { type: 'cancel', taskId: payload.taskId, ...(eventId ? { eventId } : {}) }
  }
  if (eventName === 'ping') {
    return { type: 'ping', ...(eventId ? { eventId } : {}) }
  }
  const task = asTask(payload.task)
  if (typeof payload.deliveryId !== 'string') throw new Error('Task event has no deliveryId')
  const base = taskEnvelope(task, payload)
  return {
    type: 'task',
    envelope: {
      ...base,
      deliveryId: payload.deliveryId,
    },
    ...(eventId ? { eventId } : {}),
  }
}

function taskEnvelope(task: A2ATask, delivery?: Record<string, unknown>): A2ATaskEnvelope {
  const metadata = task.metadata && typeof task.metadata === 'object'
    ? task.metadata as Record<string, unknown>
    : {}
  const history = Array.isArray(task.history) ? task.history : []
  const lastMessage = delivery?.message ?? [...history].reverse().find((message) =>
    message && typeof message === 'object' && (message as Record<string, unknown>).role === 'ROLE_USER',
  ) ?? history.at(-1)
  const parts = lastMessage && typeof lastMessage === 'object' && Array.isArray((lastMessage as Record<string, unknown>).parts)
    ? (lastMessage as Record<string, unknown>).parts as unknown[]
    : []
  const textParts = parts
    .filter((part): part is Record<string, unknown> => Boolean(part && typeof part === 'object'))
    .map((part) => part.text)
    .filter((text): text is string => typeof text === 'string')
  const executionMode = delivery?.executionMode ?? metadata.executionMode
  if (executionMode !== undefined && executionMode !== 'a2a-message' && executionMode !== 'legacy-skill') {
    throw new Error('Relay task has an unsupported execution mode')
  }
  if (delivery?.executionMode && metadata.executionMode && delivery.executionMode !== metadata.executionMode) {
    throw new Error('Relay execution mode does not match its Task')
  }
  const input = delivery?.input ?? metadata.input ?? (textParts.length === 1 ? textParts[0] : parts)
  const skillId = delivery?.skillId ?? metadata.skillId
  if (executionMode !== 'a2a-message' && (typeof skillId !== 'string' || !skillId)) {
    throw new Error('Legacy relay task has no skillId')
  }
  const requestedCapabilities = new Set<string>()
  const timeouts: number[] = []
  for (const policy of [metadata, delivery ?? {}]) {
    if (policy.requestedCapabilities !== undefined) {
      if (!Array.isArray(policy.requestedCapabilities)
        || policy.requestedCapabilities.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('Invalid relay capability policy')
      }
      for (const capability of policy.requestedCapabilities) requestedCapabilities.add(capability)
    }
    if (policy.approvalRequired !== undefined && typeof policy.approvalRequired !== 'boolean') {
      throw new Error('Invalid relay approval policy')
    }
    if (policy.timeoutSeconds !== undefined) {
      if (typeof policy.timeoutSeconds !== 'number' || !Number.isFinite(policy.timeoutSeconds)
        || policy.timeoutSeconds < 1 || policy.timeoutSeconds > 3600) {
        throw new Error('Invalid relay timeout policy')
      }
      timeouts.push(policy.timeoutSeconds)
    }
  }
  return {
    task,
    ...(executionMode === 'a2a-message'
      ? { executionMode, message: asMessage(lastMessage, task) }
      : { executionMode: 'legacy-skill', skillId: skillId as string, input }),
    deliveryId: typeof delivery?.deliveryId === 'string'
      ? delivery.deliveryId
      : `${task.id}:${executionMode === 'a2a-message' ? asMessage(lastMessage, task).messageId : task.version ?? 0}`,
    requestedCapabilities: [...requestedCapabilities],
    approvalRequired: metadata.approvalRequired === true || delivery?.approvalRequired === true,
    ...(timeouts.length ? { timeoutSeconds: Math.min(...timeouts) } : {}),
  }
}

/** A small SSE parser. It intentionally exposes no DOM or Harness dependency. */
async function* readSse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<GatewayEvent & { eventId?: string }> {
  if (!response.body) throw new Error('Gateway SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let eventId: string | undefined
  let data: string[] = []

  const flush = (): GatewayEvent | undefined => {
    if (!data.length) {
      eventName = 'message'
      eventId = undefined
      return undefined
    }
    const json = data.join('\n')
    const result = parseGatewayEvent(eventName, JSON.parse(json), eventId)
    eventName = 'message'
    eventId = undefined
    data = []
    return result
  }

  try {
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          const result = flush()
          if (result) yield result
          continue
        }
        if (line.startsWith(':')) continue
        const separator = line.indexOf(':')
        const field = separator >= 0 ? line.slice(0, separator) : line
        const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /u, '') : ''
        if (field === 'event') eventName = value
        else if (field === 'id') eventId = value
        else if (field === 'data') data.push(value)
      }
    }
    buffer += decoder.decode()
    if (buffer) {
      for (const line of buffer.split(/\r?\n/u)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
      }
    }
    const result = flush()
    if (result) yield result
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export class GatewayClient {
  private registration?: DeviceRegistration
  private readonly fetchImpl: FetchImpl
  private readonly paths: Required<NonNullable<BridgeConfig['gatewayPaths']>>
  private readonly transport: 'sse' | 'pull'

  constructor(
    private readonly gatewayUrl: string,
    private readonly device: DeviceConfig,
    private readonly oauth: OAuthClient,
    transport: 'sse' | 'pull' = 'sse',
    paths: BridgeConfig['gatewayPaths'] = {},
    fetchImpl: FetchImpl = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl
    this.transport = transport
    this.paths = {
      register: paths.register ?? '/a2a/devices/register',
      events: paths.events ?? '/v1/devices/{deviceId}/events',
      nextTask: paths.nextTask ?? '/a2a/devices/{deviceId}/tasks/next',
      taskEvents: paths.taskEvents ?? (transport === 'pull' ? '/a2a/tasks/{taskId}/events' : '/v1/devices/{deviceId}/tasks/{taskId}/events'),
      cancel: paths.cancel ?? '/v1/devices/{deviceId}/tasks/{taskId}/cancel',
      acknowledge: paths.acknowledge ?? '/v1/devices/{deviceId}/deliveries/{deliveryId}/ack',
    }
  }

  async getAgentCard(): Promise<AgentCard> {
    const response = await this.request('/.well-known/agent-card.json', { method: 'GET' })
    return (await response.json()) as AgentCard
  }

  updateIdentity(identity: Pick<DeviceConfig, 'name' | 'description'>): void {
    Object.assign(this.device, identity)
  }

  async register(allowedSkills: string[] = []): Promise<DeviceRegistration> {
    const response = await this.request(this.path(this.paths.register), {
      method: 'POST',
      body: JSON.stringify({
        deviceId: this.device.id,
        deviceName: this.device.name,
        description: this.device.description ?? '',
        platform: this.device.platform ?? 'windows',
        capabilities: this.device.capabilities,
        allowedSkills,
      }),
    })
    const payload = asObject(await response.json())
    if (typeof payload.deviceId !== 'string') throw new Error('Device registration has no deviceId')
    const registration: DeviceRegistration = {
      deviceId: payload.deviceId,
      ...(typeof payload.connectionToken === 'string' ? { connectionToken: payload.connectionToken } : {}),
      ...(typeof payload.expiresAt === 'string' ? { expiresAt: payload.expiresAt } : {}),
    }
    this.registration = registration
    return registration
  }

  async *events(
    signal: AbortSignal,
    lastEventId?: string,
  ): AsyncGenerator<GatewayEvent & { eventId?: string }> {
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (lastEventId) headers['Last-Event-ID'] = lastEventId
    const response = await this.request(this.path(this.paths.events), {
      method: 'GET',
      headers,
      signal,
    })
    yield* readSse(response, signal)
  }

  async nextTask(signal?: AbortSignal): Promise<A2ATaskEnvelope | undefined> {
    if (this.transport !== 'pull') throw new Error('nextTask is only available in pull mode')
    const response = await this.request(this.path(this.paths.nextTask), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    })
    if (response.status === 204) return undefined
    const payload = asObject(await response.json())
    const task = asTask(payload.task ?? payload)
    return taskEnvelope(task, payload.task ? payload : undefined)
  }

  async acknowledge(deliveryId: string): Promise<void> {
    await this.request(this.path(this.paths.acknowledge, { deliveryId }), {
      method: 'POST',
    })
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<A2ATask> {
    const response = await this.request('/a2a', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: taskId, method: 'GetTask', params: { id: taskId } }),
      ...(signal ? { signal } : {}),
    })
    const payload = asObject(await response.json())
    if (payload.error) throw new Error('Unable to read the active A2A task')
    return asTask(payload.result)
  }

  async taskEvent(taskId: string, event: TaskEvent): Promise<void> {
    const body: Record<string, unknown> = {
      state: event.state,
      deviceId: this.device.id,
    }
    if (event.message) {
      body.message = {
        messageId: `${taskId}:${event.state.toLowerCase()}`,
        role: 'ROLE_AGENT',
        parts: [{ text: event.message, mediaType: 'text/plain' }],
      }
    }
    if (event.message) body.statusMessage = event.message
    if (event.artifacts) body.artifacts = event.artifacts
    await this.request(this.path(this.paths.taskEvents, { taskId }), {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  async cancel(taskId: string): Promise<void> {
    await this.request(this.path(this.paths.cancel, { taskId }), {
      method: 'POST',
    })
  }

  private path(template: string, values: Record<string, string> = {}): string {
    return template
      .replaceAll('{deviceId}', encodeURIComponent(this.device.id))
      .replaceAll('{taskId}', (values.taskId ? encodeURIComponent(values.taskId) : '{taskId}'))
      .replaceAll('{deliveryId}', (values.deliveryId ? encodeURIComponent(values.deliveryId) : '{deliveryId}'))
  }

  private async request(path: string, init: RequestInit, retried = false): Promise<Response> {
    const token = await this.oauth.accessToken()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.set('A2A-Version', '1.0')
    headers.set('accept', headers.get('accept') ?? 'application/json')
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const connectionToken = this.registration?.connectionToken
    if (connectionToken) headers.set('x-device-connection', connectionToken)
    const response = await this.fetchImpl(new URL(path, this.gatewayUrl), {
      ...init,
      headers,
    })
    if (response.status === 401) {
      const rotated = await this.oauth.handleUnauthorized(token)
      if (rotated && !retried) return this.request(path, init, true)
      throw new OAuthLoginRequiredError()
    }
    if (!response.ok) throw new Error(`Gateway request failed (${response.status})`)
    return response
  }
}
