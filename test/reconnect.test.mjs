import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../dist/plugin.js'
import { MemoryTokenStore } from '../dist/pkce.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await sleep(5) }
  assert.ok(check(), 'condition never became true')
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const heldTask = () => ({ id: 'task', contextId: 'context', status: { state: 'TASK_STATE_WORKING' },
  metadata: { executionLease: { deliveryId: 'task:message', phase: 'running', cancelRequested: false } } })

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-reconnect-'))
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'access', expiresAt: Date.now() + 3600000, sessionScope: 'same-scope', ...options.tokens })
  const seen = { registrations: [], claims: 0, inventories: 0, events: [], opened: [] }
  const task = heldTask()
  const bridge = createBridge({ agents: { run: async (_skill, message, context) => {
    if (!options.execute) throw new Error('must not execute')
    return options.execute(message, context)
  } } }, {
    gatewayUrl: 'https://platform.example', taskStorageDirectory: directory, executionMode: 'a2a-message', transport: 'pull', pollIntervalMs: 250,
    device: { id: 'device', name: 'device', capabilities: [] },
    oauth: { clientId: 'client', authorizationEndpoint: 'https://platform.example/auth', tokenEndpoint: 'https://platform.example/token',
      redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenStore: store, openAuthorizationUrl: (url) => seen.opened.push(url) },
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      if (path.endsWith('/register')) {
        assert.equal(JSON.parse(init.body).executionLeaseVersion, 1)
        seen.registrations.push(Date.now())
        return await options.register?.(seen.registrations.length, init)
          ?? Response.json({ deviceId: 'device', taskEventsVersion: 1, executionLeaseVersion: 1 })
      }
      if (path.endsWith('/tasks/active')) {
        seen.inventories++
        return await options.inventory?.(seen.inventories)
          ?? Response.json({ tasks: [], recoveries: [], next_after_id: null })
      }
      if (path.endsWith('/next')) { seen.claims++; return await options.next?.(seen.claims) ?? new Response(null, { status: 204 }) }
      if (path.endsWith('/events')) {
        const event = JSON.parse(init.body); seen.events.push(event)
        if (event.state) task.status.state = event.state
        if (event.execution) task.metadata.executionLease.phase = 'released'
        return await options.report?.(event) ?? Response.json({})
      }
      if (path === '/a2a') return Response.json({ result: task })
      if (path === '/token') return options.token()
      throw new Error('Unexpected request: ' + path)
    },
  })
  t.after(async () => { await options.cleanup?.(); await bridge.stop(); await rm(directory, { recursive: true, force: true }) })
  return { bridge, seen, task, store }
}

test('startup retries registration and inventory failures, then stays connected with an unknown recovery hold', async (t) => {
  let task
  const f = await fixture(t, {
    register: (attempt) => attempt === 1 ? new Response(null, { status: 502 }) : undefined,
    inventory: (attempt) => {
      if (attempt === 1) throw new Error('offline inventory')
      return Response.json({ tasks: [{ task, action: 'inspect' }], recoveries: [], next_after_id: null })
    },
  })
  task = f.task
  await f.bridge.start()
  assert.equal(f.bridge.status().phase, 'reconnecting')
  await until(() => f.bridge.status().phase === 'connected')
  assert.equal(f.seen.registrations.length, 3)
  assert.equal(f.bridge.status().recoveryTasks[0].canRelease, true)
  assert.equal(f.seen.claims, 0)
  assert.equal(f.seen.opened.length, 0)
  await f.bridge.confirmStopped('task', 'task:message')
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.bridge.status().recoveryTasks.length, 0)
  await until(() => f.seen.claims > 0)
})

test('a structured protocol request re-registers the existing grant with bounded attempts', async (t) => {
  let requireRegistration = true
  const f = await fixture(t, {
    register: (attempt) => { if (attempt >= 3) requireRegistration = false },
    next: () => requireRegistration ? Response.json({ detail: { code: 'execution_protocol_required', executionLeaseVersion: 1 } }, { status: 409 }) : undefined,
  })
  await f.bridge.start()
  await until(() => f.seen.registrations.length === 3 && f.bridge.status().phase === 'connected')
  assert.ok(f.seen.registrations[1] - f.seen.registrations[0] >= 950)
  assert.ok(f.seen.registrations[2] - f.seen.registrations[1] >= 950)
  assert.equal((await f.store.get()).sessionScope, 'same-scope')
  assert.equal(f.seen.opened.length, 0)
})

test('native registration refuses a platform that does not negotiate the current machine protocol', async (t) => {
  const f = await fixture(t, { register: () => Response.json({ deviceId: 'device', taskEventsVersion: 1, executionLeaseVersion: 0 }) })
  await assert.rejects(f.bridge.start(), /protocol version 1/)
  assert.equal(f.bridge.status().phase, 'error')
  assert.equal(f.seen.claims, 0)
  assert.equal(f.seen.opened.length, 0)
})

test('stop aborts an in-flight reconnect handshake and never begins another claim', async (t) => {
  let signal
  const f = await fixture(t, { register: (attempt, init) => {
    if (attempt === 1) return new Response(null, { status: 503 })
    signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  await f.bridge.start()
  await until(() => signal)
  await f.bridge.stop()
  assert.equal(signal.aborted, true)
  assert.equal(f.bridge.status().phase, 'stopped')
  await sleep(300)
  assert.equal(f.seen.registrations.length, 2)
  assert.equal(f.seen.claims, 0)
})

test('temporary refresh failure retains credentials and recovers without opening authorization', async (t) => {
  let tokens = 0
  const f = await fixture(t, { tokens: { refreshToken: 'refresh', expiresAt: 1 }, token: () => {
    tokens++
    return tokens === 1 ? new Response(null, { status: 503 }) : Response.json({ access_token: 'rotated', expires_in: 3600 })
  } })
  await f.bridge.start()
  assert.equal(f.bridge.status().phase, 'reconnecting')
  assert.equal((await f.store.get()).refreshToken, 'refresh')
  await until(() => f.bridge.status().phase === 'connected')
  assert.equal(tokens, 2)
  assert.equal(f.seen.opened.length, 0)
})

test('invalid authorization stops reconnection without silently opening a browser', async (t) => {
  const f = await fixture(t, { register: () => new Response(null, { status: 401 }) })
  await f.bridge.start()
  assert.equal(f.bridge.status().phase, 'authorization_required')
  await sleep(300)
  assert.equal(f.seen.registrations.length, 1)
  assert.equal(f.seen.opened.length, 0)
})

test('same-protocol registration preserves a live native turn and update waits for its final report ACK', async (t) => {
  const work = deferred()
  let running = false, signal, ack = false, task
  const f = await fixture(t, {
    execute: async (_message, context) => { running = true; signal = context.signal; await work.promise; return { text: 'done' } },
    next: (attempt) => attempt === 1 ? Response.json({ task, executionMode: 'a2a-message', deliveryId: 'task:message',
      message: { messageId: 'message', role: 'ROLE_USER', parts: [{ text: 'work' }] } }) : undefined,
    report: (event) => { if (event.execution && !ack) throw new Error('ACK lost') },
    cleanup: () => { ack = true; work.resolve() },
  })
  task = f.task
  await f.bridge.start()
  await until(() => running)
  await f.bridge.updateIdentity({ name: 'renamed', description: '' })
  assert.equal(f.seen.registrations.length, 2)
  assert.equal(f.seen.inventories, 1)
  assert.equal(signal.aborted, false)
  assert.equal(f.seen.events.some((event) => event.state === 'TASK_STATE_FAILED'), false)
  work.resolve()
  await until(() => f.seen.events.some((event) => event.execution) && f.bridge.status().activeTasks === 0)
  assert.equal(f.bridge.canPauseForUpdate(), false)
  await assert.rejects(f.bridge.pauseForUpdate(), (error) => error.code === 'busy')
  const finalId = f.seen.events.find((event) => event.execution).event_id
  ack = true
  await until(() => f.bridge.canPauseForUpdate())
  assert.ok(f.seen.events.filter((event) => event.execution).every((event) => event.event_id === finalId))
  await f.bridge.pauseForUpdate()
  assert.equal(f.bridge.status().phase, 'stopped')
})


function brokenBody(error) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"partial":'))
    controller.error(error)
  } }), { headers: { 'content-type': 'application/json' } })
}

for (const failure of ['registration', 'inventory']) {
  test('startup retries a ' + failure + ' response that fails after its headers arrive', async (t) => {
    const f = await fixture(t, {
      register: (attempt) => failure === 'registration' && attempt === 1 ? brokenBody(new TypeError('terminated')) : undefined,
      inventory: (attempt) => failure === 'inventory' && attempt === 1 ? brokenBody(new DOMException('body timed out', 'TimeoutError')) : undefined,
    })
    await f.bridge.start()
    assert.equal(f.bridge.status().phase, 'reconnecting')
    await until(() => f.bridge.status().phase === 'connected')
    assert.equal(f.seen.registrations.length, 2)
    assert.equal(f.seen.opened.length, 0)
  })
}

test('a refresh response interrupted after headers retains the grant and retries', async (t) => {
  let tokens = 0
  const f = await fixture(t, { tokens: { refreshToken: 'refresh', expiresAt: 1 }, token: () => {
    tokens++
    return tokens === 1 ? brokenBody(new DOMException('body interrupted', 'AbortError')) : Response.json({ access_token: 'rotated', expires_in: 3600 })
  } })
  await f.bridge.start()
  assert.equal(f.bridge.status().phase, 'reconnecting')
  assert.equal((await f.store.get()).refreshToken, 'refresh')
  await until(() => f.bridge.status().phase === 'connected')
  assert.equal(tokens, 2)
  assert.equal(f.seen.opened.length, 0)
})

test('a complete malformed registration document is rejected rather than treated as a network failure', async (t) => {
  const f = await fixture(t, { register: () => new Response('{invalid json', { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(f.bridge.start(), SyntaxError)
  assert.equal(f.bridge.status().phase, 'error')
  assert.equal(f.seen.registrations.length, 1)
  assert.equal(f.seen.claims, 0)
})
