import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MemoryTokenStore,
  OAuthClient,
  TaskRunner,
  createBridge,
} from '../dist/index.js'

test('bridge registration advertises actual skill handlers separately from permissions', async () => {
  const registrations = []
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'test-token', expiresAt: Date.now() + 3600000 })
  const bridge = createBridge({ agents: { run: async () => ({ text: 'native result' }) } }, {
    gatewayUrl: 'https://gateway.example',
    transport: 'pull',
    pollIntervalMs: 250,
    oauth: {
      clientId: 'test-client', authorizationEndpoint: 'https://auth.example/auth',
      tokenEndpoint: 'https://auth.example/token', redirectUri: 'http://127.0.0.1/callback',
      scopes: ['device.connect'], tokenStore: store, openAuthorizationUrl: () => {},
    },
    device: { id: 'windows', name: 'Windows Harness', capabilities: ['workspace.read', 'workspace.write'] },
    allowedSkills: ['demo.echo', 'demo.echo'],
    skills: { 'report.export': async () => ({ text: 'custom result' }) },
    fetch: async (url, init) => {
      if (String(url).endsWith('/devices/register')) {
        registrations.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ deviceId: 'windows' }), { status: 200 })
      }
      return new Response(null, { status: 204 })
    },
  })
  try {
    await bridge.start()
    await bridge.stop()
    await bridge.start()
    assert.equal(registrations.length, 2)
    for (const registration of registrations) {
      assert.deepEqual(registration.capabilities, ['workspace.read', 'workspace.write'])
      assert.deepEqual(registration.allowedSkills.sort(), ['demo.echo', 'report.export'])
    }
  } finally {
    await bridge.stop()
  }
})

test('OAuth client uses PKCE and stores the token set', async () => {
  let opened
  const store = new MemoryTokenStore()
  const oauth = new OAuthClient({
    clientId: 'desktop',
    authorizationEndpoint: 'https://auth.example/authorize',
    tokenEndpoint: 'https://auth.example/token',
    redirectUri: 'http://127.0.0.1/callback',
    scopes: ['device.connect'],
    tokenStore: store,
    openAuthorizationUrl: (url) => { opened = url },
  }, async (_url, init) => {
    assert.equal(init.method, 'POST')
    const body = String(init.body)
    assert.match(body, /code_verifier=/u)
    return new Response(JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })

  const request = await oauth.beginAuthorization()
  assert.equal(new URL(opened).searchParams.get('code_challenge_method'), 'S256')
  await oauth.completeAuthorization('code', request.state)
  assert.equal(await oauth.accessToken(), 'access')
  assert.equal((await store.get()).refreshToken, 'refresh')
})

test('TaskRunner rejects unlisted skills and reports successful artifacts', async () => {
  const events = []
  const harness = {
    agents: { run: async () => ({}) },
    ui: { confirm: async () => true },
  }
  const runner = new TaskRunner(
    harness,
    ['workspace.read'],
    {
      allowed: async () => ({ text: 'done' }),
    },
    async (_taskId, event) => { events.push(event) },
    () => {},
  )

  await runner.handle({
    type: 'task',
    envelope: {
      deliveryId: 'delivery-1',
      skillId: 'allowed',
      input: {},
      task: { id: 'task-1', contextId: 'context-1', state: 'TASK_STATE_SUBMITTED' },
    },
  })
  assert.deepEqual(events.map((event) => event.state), [
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED',
  ])
  assert.equal(events[1].artifacts[0].parts[0].text, 'done')

  await runner.handle({
    type: 'task',
    envelope: {
      deliveryId: 'delivery-2',
      skillId: 'not-allowed',
      input: {},
      task: { id: 'task-2', contextId: 'context-1', state: 'TASK_STATE_SUBMITTED' },
    },
  })
  assert.equal(events.at(-1).state, 'TASK_STATE_REJECTED')
})

test('TaskRunner never executes a local skill when the initial gateway claim is rejected', async () => {
  let executions = 0
  const runner = new TaskRunner({ agents: { run: async () => ({}) } }, [], {
    dangerous: async () => { executions++; return { text: 'must not run' } },
  }, async () => { throw new Error('OAuth login is required') }, () => {})
  await runner.handle({ type: 'task', envelope: {
    deliveryId: 'revoked-claim', skillId: 'dangerous', input: {},
    task: { id: 'revoked-task', contextId: 'revoked-context', state: 'TASK_STATE_SUBMITTED' },
  } })
  assert.equal(executions, 0)
})

test('TaskRunner stop drains cancellation reports before credentials can be unlocked', async () => {
  let working, releaseTerminal, stopped = false
  const started = new Promise((resolve) => { working = resolve })
  const terminal = new Promise((resolve) => { releaseTerminal = resolve })
  const runner = new TaskRunner({ agents: { run: async () => ({}) } }, [], {
    waiting: async (_input, context) => {
      working()
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))
      return { text: 'canceled' }
    },
  }, async (_id, event) => {
    if (event.state === 'TASK_STATE_CANCELED') await terminal
  }, () => {})
  const task = runner.handle({ type: 'task', envelope: {
    deliveryId: 'drain', skillId: 'waiting', input: {},
    task: { id: 'drain-task', contextId: 'drain-context', state: 'TASK_STATE_SUBMITTED' },
  } })
  await started
  const stop = runner.stop().then(() => { stopped = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(stopped, false)
  releaseTerminal()
  await stop
  await task
  assert.equal(stopped, true)
})
