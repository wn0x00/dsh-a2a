import assert from 'node:assert/strict'
import test from 'node:test'
import { createBridge } from '../dist/plugin.js'
import { MemoryTokenStore } from '../dist/pkce.js'

async function fixture(t, options = {}) {
  const store = new MemoryTokenStore()
  if (options.authorized !== false)
    await store.set({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 3600000,
      sessionScope: 'old-session',
    })
  const opened = []
  const registrations = []
  let rejectRegistration = false
  let delivered = false
  const bridge = createBridge(
    { agents: { run: options.run ?? (async () => ({})) } },
    {
      gatewayUrl: 'https://platform.example',
      ...(options.tasks ? { executionMode: 'a2a-message' } : {}),
      transport: 'pull',
      pollIntervalMs: 250,
      device: { id: 'same-device', name: 'Office desktop', capabilities: [] },
      oauth: {
        clientId: 'desktop',
        authorizationEndpoint: 'https://platform.example/authorize',
        tokenEndpoint: 'https://platform.example/token',
        redirectUri: 'http://127.0.0.1:43127/oauth/callback',
        scopes: ['device.connect'],
        tokenStore: store,
        openAuthorizationUrl: (url) => {
          if (options.browserFails) throw new Error('Browser failed')
          opened.push(url)
        },
      },
      fetch: async (url, init) => {
        if (String(url).endsWith('/token')) {
          await options.exchangeGate?.()
          if (options.exchangeFails)
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          })
        }
        if (String(url).endsWith('/devices/register')) {
          registrations.push(new Headers(init.headers).get('authorization'))
          await options.registerGate?.()
          if (rejectRegistration) return new Response(null, { status: 503 })
          return Response.json({ deviceId: 'same-device' })
        }
        if (options.tasks && String(url).endsWith('/next') && !delivered) {
          delivered = true
          return Response.json({
            task: {
              id: 'active-task',
              contextId: 'context',
              status: { state: 'TASK_STATE_SUBMITTED' },
              metadata: { executionMode: 'a2a-message' },
            },
            executionMode: 'a2a-message',
            deliveryId: 'active-task:message',
            message: {
              messageId: 'message',
              role: 'ROLE_USER',
              parts: [{ text: 'wait' }],
            },
          })
        }
        if (String(url).endsWith('/events')) return Response.json({})
        return new Response(null, { status: 204 })
      },
    },
  )
  t.after(() => bridge.stop())
  return {
    bridge,
    store,
    opened,
    registrations,
    rejectRegistration: () => {
      rejectRegistration = true
    },
    state: () => new URL(opened.at(-1)).searchParams.get('state'),
  }
}

test('status starts unauthorized without opening a browser and reports real registration', async (t) => {
  const f = await fixture(t, { authorized: false })
  await f.bridge.start()
  assert.equal(f.bridge.status().phase, 'authorization_required')
  assert.equal(f.opened.length, 0)
  await f.bridge.connect()
  assert.equal(f.bridge.status().phase, 'authorizing')
  assert.ok(f.bridge.status().pendingExpiresAt > Date.now())
  await f.bridge.completeAuthorization('new-code', f.state())
  assert.equal(f.bridge.status().phase, 'connected')
  assert.ok(f.bridge.status().lastContactAt)
  assert.equal(f.bridge.status().pendingExpiresAt, null)
  assert.doesNotMatch(
    JSON.stringify(f.bridge.status()),
    /new-access|new-refresh|verifier|old-session/,
  )
})

test('reauthorization preserves credentials until a successful replacement exchange', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await f.bridge.reauthorize()
  assert.equal(f.bridge.status().phase, 'authorizing')
  assert.equal((await f.store.get()).accessToken, 'old-access')
  await f.bridge.completeAuthorization('replacement-code', f.state())
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.bridge.status().deviceId, 'same-device')
  assert.equal((await f.store.get()).accessToken, 'new-access')
  assert.notEqual((await f.store.get()).sessionScope, 'old-session')
  assert.equal(f.registrations.at(-1), 'Bearer new-access')
})

test('denial and expiry restore the old authorized connection', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await f.bridge.reauthorize()
  await f.bridge.cancelAuthorization(f.state())
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.bridge.status().notice, 'authorization_denied')
  await f.bridge.reauthorize()
  await f.bridge.expireAuthorization()
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.bridge.status().notice, 'authorization_timeout')
  assert.equal((await f.store.get()).accessToken, 'old-access')
})

test('browser failure keeps and resumes the old grant', async (t) => {
  const f = await fixture(t, { browserFails: true })
  await f.bridge.start()
  await assert.rejects(f.bridge.reauthorize(), /Browser failed/)
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.bridge.status().notice, 'authorization_failed')
  assert.equal((await f.store.get()).accessToken, 'old-access')
})

test('a refused replacement code cannot clear the old grant', async (t) => {
  const f = await fixture(t, { exchangeFails: true })
  await f.bridge.start()
  await f.bridge.reauthorize()
  await assert.rejects(f.bridge.completeAuthorization('bad-code', f.state()))
  assert.equal((await f.store.get()).accessToken, 'old-access')
  assert.equal(f.bridge.status().phase, 'connected')
})

test('failed registration retains the new grant and never reports connected', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await f.bridge.reauthorize()
  f.rejectRegistration()
  await assert.rejects(f.bridge.completeAuthorization('new-code', f.state()))
  assert.equal((await f.store.get()).accessToken, 'new-access')
  assert.equal(f.bridge.status().phase, 'error')
  assert.equal(f.bridge.status().notice, 'registration_failed')
  assert.equal(f.bridge.status().canConnect, true)
})

test('a forged callback leaves the valid pending request intact', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await f.bridge.reauthorize()
  const expiresAt = f.bridge.status().pendingExpiresAt
  await assert.rejects(f.bridge.completeAuthorization('bad', 'forged-state'))
  assert.equal(f.bridge.status().phase, 'authorizing')
  assert.equal(f.bridge.status().pendingExpiresAt, expiresAt)
  await f.bridge.completeAuthorization('real', f.state())
  assert.equal(f.bridge.status().phase, 'connected')
})

function gate() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('direct actions reject while startup registration is unfinished', async (t) => {
  const registration = gate()
  const f = await fixture(t, { registerGate: () => registration.promise })
  const start = f.bridge.start()
  await assert.rejects(f.bridge.connect(), (error) => error.code === 'busy')
  await assert.rejects(f.bridge.reauthorize(), (error) => error.code === 'busy')
  registration.resolve()
  await start
  assert.equal(f.registrations.length, 1)
})

test('slow code exchange owns completion across timeout and concurrent cancellation', async (t) => {
  const exchange = gate()
  const f = await fixture(t, { exchangeGate: () => exchange.promise })
  await f.bridge.start()
  await f.bridge.reauthorize()
  const complete = f.bridge.completeAuthorization('replacement', f.state())
  await f.bridge.expireAuthorization()
  assert.equal(f.bridge.status().phase, 'authorizing')
  assert.equal(f.bridge.status().canCancelAuthorization, false)
  await assert.rejects(
    f.bridge.cancelPendingAuthorization(),
    (error) => error.code === 'busy',
  )
  await assert.rejects(f.bridge.reauthorize(), (error) => error.code === 'busy')
  assert.equal(f.registrations.length, 1)
  exchange.resolve()
  await complete
  assert.deepEqual(f.registrations, ['Bearer old-access', 'Bearer new-access'])
})

test('stop drains an in-flight exchange and never starts another poll loop', async (t) => {
  const exchange = gate()
  const f = await fixture(t, { exchangeGate: () => exchange.promise })
  await f.bridge.start()
  await f.bridge.reauthorize()
  const complete = f.bridge.completeAuthorization('replacement', f.state())
  const rejected = assert.rejects(
    complete,
    (error) => error.code === 'unavailable',
  )
  let stopped = false
  const stop = f.bridge.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(stopped, false)
  exchange.resolve()
  await Promise.all([stop, rejected])
  assert.equal(f.bridge.status().phase, 'stopped')
  assert.equal(f.registrations.length, 1)
  assert.equal((await f.store.get()).accessToken, 'new-access')
  await f.bridge.start()
  assert.equal(f.registrations.at(-1), 'Bearer new-access')
})

test('local cancellation restores the old connection without exposing callback state', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await f.bridge.reauthorize()
  assert.equal(f.bridge.status().canCancelAuthorization, true)
  await f.bridge.cancelPendingAuthorization()
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.bridge.status().notice, 'authorization_denied')
  assert.equal(f.bridge.status().canCancelAuthorization, false)
  await assert.rejects(f.bridge.completeAuthorization('late-code', f.state()))
  assert.equal((await f.store.get()).accessToken, 'old-access')
})

test('reauthorization refuses an active local task without canceling it', async (t) => {
  const running = gate()
  let aborted = false
  const f = await fixture(t, {
    tasks: true,
    run: async (_skill, _input, context) => {
      running.resolve()
      await new Promise((resolve) =>
        context.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
      context.signal.throwIfAborted()
    },
  })
  await f.bridge.start()
  await running.promise
  assert.equal(f.bridge.status().activeTasks, 1)
  assert.equal(f.bridge.status().canReauthorize, false)
  await assert.rejects(f.bridge.reauthorize(), (error) => error.code === 'busy')
  assert.equal(aborted, false)
  assert.equal(f.opened.length, 0)
  await f.bridge.stop()
  assert.equal(aborted, true)
})

test('the diagnostic runner can explicitly connect a fresh bridge without start', async (t) => {
  const f = await fixture(t, { authorized: false })
  assert.equal(f.bridge.status().phase, 'disconnected')
  await f.bridge.connect()
  assert.equal(f.bridge.status().phase, 'authorizing')
  assert.equal(f.opened.length, 1)
})

test('repeated start preserves a connected loop and never duplicates registration', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await f.bridge.start()
  assert.equal(f.bridge.status().phase, 'connected')
  assert.equal(f.registrations.length, 1)
})
