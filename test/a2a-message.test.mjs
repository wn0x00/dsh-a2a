import assert from 'node:assert/strict'
import test from 'node:test'

import { GatewayClient } from '../dist/gateway.js'
import { MemoryTokenStore, OAuthClient } from '../dist/pkce.js'
import { createBridge } from '../dist/plugin.js'
import { TaskRunner } from '../dist/task-runner.js'

const message = (id = 'message-1') => ({
  messageId: id, role: 'ROLE_USER', contextId: 'context-1',
  parts: [{ text: 'Describe this project' }],
})
const task = () => ({
  id: 'task-1', contextId: 'context-1', status: { state: 'TASK_STATE_SUBMITTED' },
  metadata: { executionMode: 'a2a-message' }, history: [message()],
})
const oauthConfig = (store) => ({
  clientId: 'test', authorizationEndpoint: 'https://auth.example/authorize',
  tokenEndpoint: 'https://auth.example/token', redirectUri: 'http://127.0.0.1/callback',
  scopes: [], tokenStore: store, openAuthorizationUrl() {},
})
async function tokens() {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'test', expiresAt: Date.now() + 3600000 })
  return store
}

test('native bridge delivers A2A messages without registering or selecting skills', async () => {
  const store = await tokens()
  const registrations = [], reports = [], inputs = []
  let delivered = false, completed
  const done = new Promise((resolve) => { completed = resolve })
  const bridge = createBridge({ agents: { run: async (skill, input, context) => {
    inputs.push({ skill, input, context })
    return { text: 'Project described' }
  } } }, {
    gatewayUrl: 'https://gateway.example', transport: 'pull', pollIntervalMs: 250,
    executionMode: 'a2a-message',
    device: { id: 'native', name: 'DSH', capabilities: ['workspace.read'] },
    // Stale desktop config must not turn Agent capabilities into tool routing.
    allowedSkills: ['demo.echo'],
    oauth: oauthConfig(store),
    fetch: async (url, init) => {
      assert.equal(init.headers.get('A2A-Version'), '1.0')
      if (String(url).endsWith('/register')) {
        registrations.push(JSON.parse(init.body))
        return Response.json({ deviceId: 'native' })
      }
      if (String(url).endsWith('/events')) {
        const event = JSON.parse(init.body)
        reports.push(event)
        if (event.state === 'TASK_STATE_COMPLETED') completed()
        return Response.json({})
      }
      if (delivered) return new Response(null, { status: 204 })
      delivered = true
      return Response.json({ task: task(), message: message(), executionMode: 'a2a-message', deliveryId: 'task-1:message-1' })
    },
  })
  try {
    await bridge.start()
    await done
    assert.deepEqual(registrations[0].allowedSkills, [])
    assert.ok(registrations[0].capabilities.includes('dsh.a2a.message.v1'))
    assert.equal(inputs[0].skill, '')
    assert.deepEqual(inputs[0].input, message())
    assert.equal(inputs[0].context.executionMode, 'a2a-message')
    assert.ok(inputs[0].context.sessionScope)
    assert.deepEqual(reports.map((event) => event.state), ['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'])
    assert.equal(reports[1].artifacts[0].parts[0].text, 'Project described')
  } finally { await bridge.stop() }
})

test('native mode never treats an old queued skill task as an Agent message', async () => {
  let calls = 0
  const reports = []
  const runner = new TaskRunner({ agents: { run: async () => ({}) } }, [], {},
    async (_id, event) => reports.push(event), () => {}, async () => { calls++; return {} })
  await runner.handle({ type: 'task', envelope: {
    task: { ...task(), state: 'TASK_STATE_SUBMITTED' },
    skillId: 'demo.echo', input: 'old job', deliveryId: 'old',
  } })
  assert.equal(calls, 0)
  assert.equal(reports[0].state, 'TASK_STATE_REJECTED')
})

test('A2A relay preserves each message delivery and validates its task/context', async () => {
  const store = await tokens()
  let body = { task: task(), message: message(), executionMode: 'a2a-message', deliveryId: 'first' }
  const client = new GatewayClient('https://gateway.example', { id: 'native', name: 'DSH', capabilities: [] },
    new OAuthClient(oauthConfig(store)), 'pull', {}, async () => Response.json(body))
  assert.equal((await client.nextTask()).deliveryId, 'first')
  body = { ...body, message: message('message-2'), deliveryId: 'second' }
  assert.equal((await client.nextTask()).message.messageId, 'message-2')
  body.message.taskId = 'another-task'
  await assert.rejects(client.nextTask(), /does not belong/u)
  body.message = { ...message(), parts: [{ text: 'ambiguous', data: {} }] }
  await assert.rejects(client.nextTask(), /invalid A2A Part/u)
  body.message = { ...message(), role: 'ROLE_AGENT' }
  await assert.rejects(client.nextTask(), /A2A user Message/u)
})

test('authorization epoch survives refresh but changes on new consent', async () => {
  const store = await tokens()
  const oauth = new OAuthClient(oauthConfig(store), async () => Response.json({
    access_token: 'rotated', refresh_token: 'refresh', expires_in: 3600,
  }))
  const first = await oauth.sessionScope()
  const current = await store.get()
  await store.set({ ...current, refreshToken: 'refresh', expiresAt: 1 })
  assert.equal(await oauth.sessionScope(), first)
  const request = await oauth.beginAuthorization()
  await oauth.completeAuthorization('code', request.state)
  assert.notEqual(await oauth.sessionScope(), first)
})

test('pull delivery cannot weaken approval, permissions, or timeout policy', async () => {
  const store = await tokens()
  const queued = task()
  queued.metadata = { ...queued.metadata, approvalRequired: true, requestedCapabilities: ['workspace.read'], timeoutSeconds: 30 }
  const body = { task: queued, executionMode: 'a2a-message', message: message(),
    approvalRequired: false, requestedCapabilities: ['workspace.write'], timeoutSeconds: 90 }
  const client = new GatewayClient('https://gateway.example', { id: 'native', name: 'DSH', capabilities: [] },
    new OAuthClient(oauthConfig(store)), 'pull', {}, async () => Response.json(body))
  const envelope = await client.nextTask()
  assert.equal(envelope.approvalRequired, true)
  assert.deepEqual(envelope.requestedCapabilities, ['workspace.read', 'workspace.write'])
  assert.equal(envelope.timeoutSeconds, 30)
  delete queued.metadata.approvalRequired
  body.approvalRequired = true
  let approvals = 0, executions = 0
  const runner = new TaskRunner({ agents: { run: async () => ({}) }, ui: {
    confirm: async () => { approvals++; return false },
  } }, ['workspace.read', 'workspace.write'], {}, async () => {}, () => {}, async () => { executions++; return {} })
  await runner.handle({ type: 'task', envelope: await client.nextTask() })
  assert.equal(approvals, 1)
  assert.equal(executions, 0)
})
