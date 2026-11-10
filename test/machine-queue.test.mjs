import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRunner, HarnessDrainUnconfirmedError } from '../dist/task-runner.js'
import { TaskJournal } from '../dist/task-journal.js'

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const realTimeout = globalThis.setTimeout
const tick = () => new Promise((resolve) => realTimeout(resolve, 5))
async function until(check) { for (let i = 0; i < 600; i++) { if (check()) return; await tick() } assert.ok(check(), 'condition never became true') }
const envelope = (id, extra = {}) => ({ type: 'task', envelope: {
  task: { id, contextId: 'context-' + id, state: 'TASK_STATE_WORKING' }, deliveryId: id + ':delivery', executionMode: 'a2a-message',
  message: { messageId: 'message-' + id, role: 'ROLE_USER', parts: [{ text: 'do work' }] }, ...extra,
} })
const remote = (id, phase = 'running') => ({ id, contextId: 'context-' + id, state: 'TASK_STATE_WORKING',
  metadata: { executionLease: { deliveryId: id + ':delivery', phase, cancelRequested: false } } })
async function fixture(t, execute, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-machine-queue-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const events = []
  const tasks = new Map()
  const report = async (id, event) => {
    events.push({ id, ...structuredClone(event) })
    if (options.report) await options.report(id, event)
    if (!tasks.has(id)) tasks.set(id, remote(id))
    if (event.state) tasks.get(id).state = event.state
    if (event.execution) tasks.get(id).metadata.executionLease.phase = 'released'
  }
  const harness = { agents: { run: async () => ({}) }, ...options.harness }
  const config = { storageDirectory: directory, getTask: async (id) => tasks.get(id) ?? remote(id), activeTasks: async () => [], ...options.runner }
  const runner = new TaskRunner(harness, [], {}, report, () => {}, execute, async () => 'scope', config)
  await runner.initialize(1, 1)
  return { runner, events, directory, config, tasks, harness, report }
}

test('different contexts execute FIFO with only one local native writer and persisted queued receipts', async (t) => {
  const gate = deferred(), starts = []
  const f = await fixture(t, async (_message, context) => {
    starts.push(context.taskId)
    if (context.taskId === 'first') await gate.promise
    return { text: 'done' }
  })
  const first = f.runner.handle(envelope('first'))
  const second = f.runner.handle(envelope('second'))
  await until(() => starts.length === 1 && f.events.some((event) => event.id === 'second' && event.diagnostics?.stage === 'queued'))
  assert.deepEqual(starts, ['first'])
  assert.equal(f.runner.hasCapacity(), false)
  const stored = new TaskJournal(f.directory, 'scope'); await stored.load()
  assert.equal(stored.get('second').phase, 'queued')
  assert.equal(JSON.stringify(stored.list()).includes('do work'), false)
  gate.resolve(); await Promise.all([first, second])
  assert.deepEqual(starts, ['first', 'second'])
  assert.equal(f.runner.hasCapacity(), true)
  assert.equal(f.events.filter((event) => event.execution?.phase === 'drained').length, 2)
})

test('canceling a queued task never enters its executor', async (t) => {
  const gate = deferred(), starts = []
  const f = await fixture(t, async (_message, context) => { starts.push(context.taskId); await gate.promise; return {} })
  const first = f.runner.handle(envelope('first'))
  const queued = f.runner.handle(envelope('queued'))
  f.runner.cancel('queued')
  await until(() => starts.length === 1)
  gate.resolve(); await Promise.all([first, queued])
  assert.deepEqual(starts, ['first'])
  const ending = f.events.find((event) => event.id === 'queued' && event.execution)
  assert.equal(ending.state, 'TASK_STATE_CANCELED')
  assert.equal(ending.diagnostics.changes, 'none')
})

test('timeout retains the machine until tool cleanup and history persistence finish', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cleanup = deferred(), starts = []
  let signal
  const f = await fixture(t, async (_message, context) => {
    starts.push(context.taskId)
    if (context.taskId === 'slow') { signal = context.signal; await cleanup.promise }
    return {}
  })
  const first = f.runner.handle(envelope('slow', { timeoutSeconds: 1 }))
  const next = f.runner.handle(envelope('next'))
  await until(() => signal)
  t.mock.timers.tick(1000)
  await until(() => f.events.some((event) => event.diagnostics?.stage === 'draining'))
  assert.equal(signal.aborted, true)
  assert.deepEqual(starts, ['slow'])
  assert.equal(f.events.some((event) => event.execution), false)
  cleanup.resolve(); await Promise.all([first, next])
  const ending = f.events.find((event) => event.id === 'slow' && event.execution)
  assert.equal(ending.state, 'TASK_STATE_FAILED')
  assert.equal(ending.diagnostics.error_code, 'execution_deadline_exceeded')
  assert.deepEqual(starts, ['slow', 'next'])
})

test('release ACK loss prevents another claim and retries the exact event after restart', async (t) => {
  let offline = true, executions = 0
  const f = await fixture(t, async () => { executions++; return {} }, {
    report: async (_id, event) => { if (event.execution && offline) throw new Error('ACK lost') },
  })
  await f.runner.handle(envelope('task'))
  const release = f.events.find((event) => event.execution)
  assert.ok(release.event_id)
  assert.equal(f.runner.hasCapacity(), false)
  offline = false
  const restarted = new TaskRunner(f.harness, [], {}, f.report, () => {}, async () => { executions++; return {} }, async () => 'scope', f.config)
  await restarted.initialize(1, 1); await restarted.flushReports()
  await restarted.handle(envelope('task'))
  assert.equal(executions, 1)
  assert.ok(f.events.filter((event) => event.execution).every((event) => event.event_id === release.event_id))
  assert.equal(restarted.hasCapacity(), true)
})

test('restart can release a queued receipt without replay, but retains unknown running work for owner confirmation', async (t) => {
  const f = await fixture(t, async () => { throw new Error('must not execute') })
  const journal = new TaskJournal(f.directory, 'scope'); await journal.load()
  await journal.begin('queued', 'context', 'queued:delivery', { queued: true, leased: true })
  await journal.begin('running', 'context', 'running:delivery', { leased: true })
  await journal.enqueue('running', { event_id: 'session', diagnostics: { kind: 'progress', local_session_id: 'native-old' } })
  await journal.acknowledge('running', 'session')
  const restarted = new TaskRunner(f.harness, [], {}, f.report, () => {}, async () => { throw new Error('must not execute') }, async () => 'scope', f.config)
  await restarted.initialize(1, 1); await restarted.flushReports()
  assert.ok(f.events.some((event) => event.id === 'queued' && event.execution))
  assert.equal(f.events.some((event) => event.id === 'running' && event.execution), false)
  assert.equal(restarted.hasCapacity(), false)
  assert.deepEqual(restarted.recoveryTasks(), [{ taskId: 'running', deliveryId: 'running:delivery', localSessionId: 'native-old', canRelease: true }])
  await restarted.confirmStopped('running', 'running:delivery')
  assert.equal(restarted.hasCapacity(), true)
  assert.deepEqual(restarted.recoveryTasks(), [])
})

test('a native durability failure never claims a drained machine or starts another task', async (t) => {
  const f = await fixture(t, async () => { throw new HarnessDrainUnconfirmedError('history flush failed') })
  await f.runner.handle(envelope('unflushed'))
  assert.equal(f.events.some((event) => event.execution), false)
  assert.equal(f.runner.hasCapacity(), false)
  assert.equal(f.runner.recoveryTasks()[0].taskId, 'unflushed')
})

test('owner confirmation is fenced by native busy state and preserves pending receipt on network failure', async (t) => {
  let busy = true, offline = false
  const f = await fixture(t, async (_message, context) => {
    await context.reportProgress({ kind: 'progress', local_session_id: 'native' })
    throw new HarnessDrainUnconfirmedError('unconfirmed')
  }, { harness: { sessionBusy: () => busy }, report: async (_id, event) => { if (offline && event.execution) throw new Error('offline') } })
  await f.runner.handle(envelope('task'))
  await assert.rejects(f.runner.confirmStopped('task', 'task:delivery'), /cannot be released/)
  busy = false; offline = true
  await assert.rejects(f.runner.confirmStopped('task', 'task:delivery'), /acknowledgement/)
  const id = f.events.find((event) => event.execution).event_id
  assert.equal(f.runner.recoveryTasks().length, 1)
  offline = false
  await f.runner.confirmStopped('task', 'task:delivery')
  assert.equal(f.runner.recoveryTasks().length, 0)
  assert.ok(f.events.filter((event) => event.execution).every((event) => event.event_id === id))
})

test('a reauthorized device exposes only minimal old-grant leases and releases them with an explicit owner attestation', async (t) => {
  const recoveries = [{ taskId: 'old', deliveryId: 'old:message', state: 'TASK_STATE_FAILED', requiresConfirmation: true }]
  const f = await fixture(t, async () => { throw new Error('must not execute') }, { runner: {
    getTask: async () => { throw new Error('must not read an old grant task') }, activeTasks: async () => [], recoveries: () => recoveries,
  } })
  assert.equal(f.runner.recoveryTasks().length, 1)
  assert.equal(f.events.length, 0)
  await f.runner.confirmStopped('old', 'old:message')
  assert.equal(f.events.length, 1)
  assert.deepEqual(Object.keys(f.events[0]).sort(), ['event_id', 'execution', 'id'])
  assert.deepEqual(f.events[0].execution, { delivery_id: 'old:message', phase: 'drained', confirmed_stopped: true })
})

test('pull capacity stays occupied through cancel-request cleanup and offline release delivery', async (t) => {
  const { createBridge } = await import('../dist/plugin.js')
  const { MemoryTokenStore } = await import('../dist/pkce.js')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-capacity-'))
  const store = new MemoryTokenStore(); await store.set({ accessToken: 'token', expiresAt: Date.now() + 3600000 })
  const cleanup = deferred()
  let started = false, aborted = false, drained = false, releaseAck = false, claims = 0, completed = false
  const task = remote('task')
  const bridge = createBridge({ agents: { run: async (_skill, _message, context) => {
    started = true
    await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))
    aborted = true
    await cleanup.promise
    drained = true
    context.signal.throwIfAborted()
    return {}
  } } }, {
    gatewayUrl: 'https://platform.example', executionMode: 'a2a-message', transport: 'pull', pollIntervalMs: 250,
    taskStorageDirectory: directory, device: { id: 'device', name: 'device', capabilities: [] },
    oauth: { clientId: 'test', authorizationEndpoint: 'https://auth.example', tokenEndpoint: 'https://auth.example/token', redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenStore: store, openAuthorizationUrl() {} },
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      if (path.endsWith('/register')) { assert.equal(JSON.parse(init.body).executionLeaseVersion, 1); return Response.json({ deviceId: 'device', taskEventsVersion: 1, executionLeaseVersion: 1 }) }
      if (path.endsWith('/tasks/active')) return Response.json({ tasks: [], recoveries: [], next_after_id: null })
      if (path.endsWith('/events')) {
        const event = JSON.parse(init.body)
        if (event.execution) {
          assert.equal(drained, true)
          if (!releaseAck) throw new Error('offline release')
          task.metadata.executionLease.phase = 'released'; completed = true
        }
        if (event.state) task.state = event.state
        return Response.json({})
      }
      if (path === '/a2a') {
        task.metadata.executionLease.cancelRequested = started
        return Response.json({ result: { ...task, status: { state: task.state } } })
      }
      claims++
      if (claims > 1) return new Response(null, { status: 204 })
      return Response.json({ ...envelope('task').envelope, task: { ...task, status: { state: task.state } } })
    },
  })
  t.after(async () => { cleanup.resolve(); releaseAck = true; await bridge.stop(); await rm(directory, { recursive: true, force: true }) })
  await bridge.start()
  await until(() => aborted)
  assert.equal(claims, 1)
  assert.equal(completed, false)
  cleanup.resolve()
  await until(() => drained)
  await new Promise((resolve) => realTimeout(resolve, 300))
  assert.equal(claims, 1)
  releaseAck = true
  await until(() => completed && claims > 1)
})

test('an older terminal receipt cannot hide a migrated platform lease that still occupies the machine', async (t) => {
  const f = await fixture(t, async () => { throw new Error('must not run') })
  const journal = new TaskJournal(f.directory, 'scope'); await journal.load()
  await journal.begin('old-timeout', 'context', 'old-timeout:delivery')
  await journal.enqueue('old-timeout', { event_id: 'old-final', state: 'TASK_STATE_FAILED' })
  await journal.acknowledge('old-timeout', 'old-final')
  const task = { ...remote('old-timeout'), state: 'TASK_STATE_FAILED' }
  const restarted = new TaskRunner(f.harness, [], {}, f.report, () => {}, async () => { throw new Error('must not run') }, async () => 'scope', {
    ...f.config, activeTasks: async () => [task], getTask: async () => task,
  })
  await restarted.initialize(1, 1); await restarted.flushReports()
  assert.equal(restarted.hasCapacity(), false)
  assert.equal(restarted.recoveryTasks()[0].taskId, 'old-timeout')
  assert.equal(f.events.some((event) => event.execution), false)
  await restarted.confirmStopped('old-timeout', 'old-timeout:delivery')
  assert.equal(restarted.hasCapacity(), true)
})

test('the machine protocol cannot be enabled without private durable event storage', async () => {
  const runner = new TaskRunner({ agents: { run: async () => ({}) } }, [], {}, async () => {}, () => {})
  await assert.rejects(runner.initialize(1, 1), /durable task-event storage/)
})

test('a competing terminal business outcome cannot permanently block an already drained lease', async (t) => {
  const { GatewayRequestError } = await import('../dist/gateway.js')
  let finalAttempted = false
  const f = await fixture(t, async () => ({}), { report: async (_id, event) => {
    if (event.execution && event.state) { finalAttempted = true; throw new GatewayRequestError(422) }
  }, runner: { getTask: async (id) => finalAttempted ? { ...remote(id), state: 'TASK_STATE_CANCELED' } : remote(id) } })
  await f.runner.handle(envelope('task')); await f.runner.flushReports()
  const releases = f.events.filter((event) => event.execution)
  assert.equal(releases[0].state, 'TASK_STATE_COMPLETED')
  assert.equal(releases.at(-1).state, undefined)
  assert.notEqual(releases[0].event_id, releases.at(-1).event_id)
  assert.equal(f.runner.hasCapacity(), true)
})

test('a restored idle native session does not release a previously running delivery', async (t) => {
  const f = await fixture(t, async () => { throw new Error('must not run') }, { harness: { sessionBusy: () => false } })
  const journal = new TaskJournal(f.directory, 'scope'); await journal.load()
  await journal.begin('old-running', 'context', 'old-running:delivery', { leased: true })
  await journal.enqueue('old-running', { event_id: 'native', diagnostics: { kind: 'progress', local_session_id: 'restored-idle-session' } })
  await journal.acknowledge('old-running', 'native')
  const restarted = new TaskRunner(f.harness, [], {}, f.report, () => {}, async () => { throw new Error('must not run') }, async () => 'scope', f.config)
  await restarted.initialize(1, 1); await restarted.flushReports()
  assert.equal(f.events.some((event) => event.execution), false)
  assert.equal(restarted.hasCapacity(), false)
  assert.equal(restarted.recoveryTasks()[0].localSessionId, 'restored-idle-session')
})


test('a cancellation observed during admission never starts native execution and still releases the lease', async (t) => {
  let executions = 0
  const task = remote('task'); task.metadata.executionLease.cancelRequested = true
  const f = await fixture(t, async () => { executions++; return {} }, { runner: { getTask: async () => task } })
  await f.runner.handle(envelope('task'))
  assert.equal(executions, 0)
  const ending = f.events.find((event) => event.execution)
  assert.equal(ending.state, 'TASK_STATE_CANCELED')
  assert.equal(ending.execution.delivery_id, 'task:delivery')
  assert.equal(f.runner.hasCapacity(), true)
})

test('an unknown recovery hold authenticates periodically without claiming and detects offline or revoked access', async (t) => {
  const { createBridge } = await import('../dist/plugin.js')
  const { MemoryTokenStore } = await import('../dist/pkce.js')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-recovery-heartbeat-'))
  const store = new MemoryTokenStore(); await store.set({ accessToken: 'token', expiresAt: Date.now() + 3600000 })
  const task = remote('unknown')
  let checks = 0, claims = 0, executions = 0, offline = false, revoked = false
  const bridge = createBridge({ agents: { run: async () => { executions++; return {} } } }, {
    gatewayUrl: 'https://platform.example', executionMode: 'a2a-message', transport: 'pull', pollIntervalMs: 250,
    taskStorageDirectory: directory, device: { id: 'device', name: 'device', capabilities: [] },
    oauth: { clientId: 'test', authorizationEndpoint: 'https://auth.example', tokenEndpoint: 'https://auth.example/token', redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenStore: store, openAuthorizationUrl() {} },
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path.endsWith('/register')) return Response.json({ deviceId: 'device', taskEventsVersion: 1, executionLeaseVersion: 1 })
      if (path.endsWith('/tasks/active')) {
        checks++
        if (offline) throw new Error('offline')
        if (revoked) return new Response(null, { status: 401 })
        return Response.json({ tasks: [{ task: { ...task, status: { state: task.state } }, action: 'inspect' }], recoveries: [], next_after_id: null })
      }
      if (path.endsWith('/events')) return Response.json({})
      if (path.endsWith('/next')) { claims++; return new Response(null, { status: 204 }) }
      throw new Error('Unexpected request: ' + path)
    },
  })
  t.after(async () => { await bridge.stop(); await rm(directory, { recursive: true, force: true }) })
  await bridge.start()
  assert.equal(bridge.status().recoveryTasks.length, 1)
  assert.equal(checks, 1)
  const registeredAt = bridge.status().lastContactAt
  t.mock.timers.tick(1000)
  await new Promise((resolve) => realTimeout(resolve, 300))
  assert.equal(checks, 1)
  assert.equal(bridge.status().lastContactAt, registeredAt)
  t.mock.timers.tick(30001)
  await until(() => checks === 2 && bridge.status().lastContactAt > registeredAt)
  const contactedAt = bridge.status().lastContactAt
  offline = true; t.mock.timers.tick(31000)
  await until(() => bridge.status().phase === 'reconnecting')
  assert.equal(bridge.status().lastContactAt, contactedAt)
  offline = false; revoked = true
  await until(() => bridge.status().phase === 'authorization_required')
  assert.equal(bridge.status().lastContactAt, contactedAt)
  assert.equal(claims, 0)
  assert.equal(executions, 0)
  assert.equal(bridge.status().recoveryTasks.length, 1)
})

test('an incomplete same-scope initialization can retry inventory while a restored native writer is busy', async (t) => {
  const f = await fixture(t, async () => { throw new Error('must not replay') }, { harness: { sessionBusy: () => true } })
  const journal = new TaskJournal(f.directory, 'scope'); await journal.load()
  await journal.begin('restored', 'context', 'restored:delivery', { leased: true })
  await journal.enqueue('restored', { event_id: 'session', diagnostics: { kind: 'progress', local_session_id: 'busy-session' } })
  await journal.acknowledge('restored', 'session')
  let inventories = 0
  const runner = new TaskRunner(f.harness, [], {}, f.report, () => {}, async () => { throw new Error('must not replay') }, async () => 'scope', {
    ...f.config, activeTasks: async () => { if (++inventories === 1) throw new Error('inventory unavailable'); return [] },
  })
  try {
    await assert.rejects(runner.initialize(1, 1), /inventory unavailable/)
    assert.equal(runner.localTaskCount(), 1)
    await runner.initialize(1, 1)
    assert.equal(inventories, 2)
    assert.equal(runner.recoveryTasks()[0].canRelease, false)
    assert.equal(runner.hasCapacity(), false)
    assert.equal(f.events.some((event) => event.execution), false)
  } finally {
    // Reconciliation starts background reporting. Drain that writer before
    // fixture teardown removes its journal directory.
    await runner.stop()
  }
})

test('switching authorization still refuses a current-process native turn', async (t) => {
  const work = deferred()
  let scope = 'scope', started = false, signal
  const f = await fixture(t, async () => ({}))
  const runner = new TaskRunner(f.harness, [], {}, f.report, () => {}, async (_message, context) => {
    started = true; signal = context.signal; await work.promise; return {}
  }, async () => scope, f.config)
  await runner.initialize(1, 1)
  const running = runner.handle(envelope('active'))
  t.after(async () => { work.resolve(); await running })
  await until(() => started)
  scope = 'replacement'
  await assert.rejects(runner.initialize(1, 1), /Cannot switch task authorization/)
  assert.equal(signal.aborted, false)
  work.resolve(); await running
})
