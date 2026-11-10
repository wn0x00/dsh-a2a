import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRunner, HarnessAuthRequiredError } from '../dist/task-runner.js'
import { TaskJournal } from '../dist/task-journal.js'
import { safeDiagnostic } from '../dist/task-diagnostics.js'

const harness = { agents: { run: async () => ({}) } }
const envelope = (id = 'task-one', extra = {}) => ({ type: 'task', envelope: {
  task: { id, contextId: 'context-one', state: 'TASK_STATE_SUBMITTED' },
  executionMode: 'a2a-message', deliveryId: id + ':message',
  message: { messageId: 'message', role: 'ROLE_USER', parts: [{ text: 'private task input' }] }, ...extra,
} })
const turn = () => new Promise((resolve) => setImmediate(resolve))
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'a2a-task-journal-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

for (const seconds of [undefined, 7200]) {
  test(`task deadline is ${seconds ?? 'unlimited'}; it is independent of the model turn`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let complete, signal
    const wait = new Promise((resolve) => { complete = resolve })
    const reports = []
    const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
      async (_message, context) => { signal = context.signal; await wait; return { text: 'done' } }, async () => 'scope')
    const running = runner.handle(envelope('deadline', seconds ? { timeoutSeconds: seconds } : {}))
    await turn()
    t.mock.timers.tick(3_600_001)
    assert.equal(signal.aborted, false)
    assert.equal(reports.at(-1).state, 'TASK_STATE_WORKING')
    complete()
    await running
    assert.equal(reports.at(-1).state, 'TASK_STATE_COMPLETED')
  })
}

test('an explicit execution deadline still cancels and reports failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async (_message, context) => {
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))
      context.signal.throwIfAborted()
    }, async () => 'scope')
  const running = runner.handle(envelope('deadline', { timeoutSeconds: 7200 }))
  await turn()
  t.mock.timers.tick(7_200_000)
  await running
  assert.equal(reports.at(-1).state, 'TASK_STATE_FAILED')
  assert.match(reports.at(-1).message, /timed out/)
  await runner.stop()
})

test('a lost final acknowledgement survives restart with the same event id and no reexecution', async (t) => {
  const storageDirectory = await directory(t)
  let executions = 0, disconnected = false, remoteState = 'TASK_STATE_WORKING'
  const accepted = new Map(), attempts = []
  const report = async (id, event) => {
    attempts.push(event)
    if (disconnected) throw new Error('offline')
    if (!accepted.has(event.event_id)) accepted.set(event.event_id, structuredClone(event))
    if (event.state === 'TASK_STATE_COMPLETED') { remoteState = event.state; disconnected = true; throw new Error('response lost after commit') }
  }
  const options = { storageDirectory, getTask: async () => ({ id: 'task-one', state: remoteState }), activeTasks: async () => [] }
  const first = new TaskRunner(harness, [], {}, report, () => {}, async (_input, context) => {
    executions++
    await context.reportProgress({ kind: 'progress', stage: 'running', local_session_id: 'local-session' })
    return { text: 'saved output' }
  }, async () => 'scope', options)
  await first.initialize(1)
  await first.handle(envelope())
  await first.flushReports()
  const terminal = [...accepted.values()].find((event) => event.state === 'TASK_STATE_COMPLETED')
  assert.ok(terminal?.event_id)
  const secondAttempts = []
  const second = new TaskRunner(harness, [], {}, async (_id, event) => {
    secondAttempts.push(event)
    if (!accepted.has(event.event_id)) accepted.set(event.event_id, event)
  }, () => {}, async () => { executions++; return {} }, async () => 'scope', options)
  await second.initialize(1)
  await second.handle(envelope())
  assert.equal(executions, 1)
  assert.ok(secondAttempts.some((event) => event.event_id === terminal.event_id))
  assert.equal([...accepted.values()].filter((event) => event.state === 'TASK_STATE_COMPLETED').length, 1)
  const journal = new TaskJournal(storageDirectory, 'scope'); await journal.load()
  assert.equal(journal.get('task-one').pending.length, 0)
  assert.equal(journal.get('task-one').local_session_id, 'local-session')
  assert.equal(JSON.stringify(journal.list()).includes('private task input'), false)
})

test('local execution continues offline and pending diagnostics/results retry without resubmission', async (t) => {
  const storageDirectory = await directory(t)
  let offline = false, executed = 0
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => {
    if (offline) throw new Error('network unavailable')
    reports.push(event)
  }, () => {}, async (_input, context) => {
    offline = true
    await context.reportProgress({ kind: 'progress', stage: 'tool_finished', tool_name: 'read_file', duration_ms: 23,
      summary: 'password=do-not-send Bearer hidden-token' })
    executed++
    return { text: 'finished offline' }
  }, async () => 'scope', { storageDirectory, getTask: async () => ({ state: 'TASK_STATE_WORKING' }), activeTasks: async () => [] })
  await runner.initialize(1)
  await runner.handle(envelope())
  assert.equal(executed, 1)
  assert.equal(reports.some((event) => event.state === 'TASK_STATE_COMPLETED'), false)
  offline = false
  await runner.flushReports()
  assert.equal(reports.at(-1).state, 'TASK_STATE_COMPLETED')
  assert.ok(reports.some((event) => event.diagnostics?.tool_name === 'read_file'))
  assert.equal(JSON.stringify(reports).includes('do-not-send'), false)
  assert.equal(JSON.stringify(reports).includes('hidden-token'), false)
})

test('cold restart reports interrupted work with its saved session instead of replaying it', async (t) => {
  const storageDirectory = await directory(t)
  const journal = new TaskJournal(storageDirectory, 'scope'); await journal.load()
  await journal.begin('crashed', 'context', 'delivery')
  await journal.enqueue('crashed', { event_id: 'session-event', diagnostics: { kind: 'progress', stage: 'running', local_session_id: 'session-before-crash' } })
  await journal.acknowledge('crashed', 'session-event')
  let executed = false
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async () => { executed = true; return {} }, async () => 'scope', {
      storageDirectory, getTask: async (id) => ({ id, state: 'TASK_STATE_WORKING' }),
      activeTasks: async () => [{ id: 'crashed', contextId: 'context', state: 'TASK_STATE_WORKING' }],
    })
  await runner.initialize(1)
  assert.equal(executed, false)
  assert.equal(reports.at(-1).state, 'TASK_STATE_FAILED')
  assert.equal(reports.at(-1).diagnostics.error_code, 'client_restarted')
  assert.equal(reports.at(-1).diagnostics.local_session_id, 'session-before-crash')
  assert.equal(reports.at(-1).diagnostics.changes, 'unknown')
})

test('an unknown remote working task is inspected without declaring failure or executing', async (t) => {
  const storageDirectory = await directory(t)
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async () => { throw new Error('must never replay') }, async () => 'scope', {
      storageDirectory, getTask: async () => ({ state: 'TASK_STATE_WORKING' }),
      activeTasks: async () => [{ id: 'unknown', contextId: 'context', state: 'TASK_STATE_WORKING' }],
    })
  await runner.initialize(1)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].state, undefined)
  assert.equal(reports[0].diagnostics.error_code, 'local_record_missing')
})

test('a new authorization epoch cannot flush the previous identity outbox', async (t) => {
  const storageDirectory = await directory(t)
  const old = new TaskJournal(storageDirectory, 'old-authorization'); await old.load()
  await old.begin('old-task', 'context', 'delivery')
  await old.enqueue('old-task', { event_id: 'old-event', state: 'TASK_STATE_COMPLETED', message: 'old-private-result' })
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async () => ({}), async () => 'new-authorization', { storageDirectory, getTask: async () => { throw new Error('must not query old task') }, activeTasks: async () => [] })
  await runner.initialize(1)
  await runner.flushReports()
  assert.deepEqual(reports, [])
})

test('structured diagnostics redact secrets and discard arbitrary native event fields', () => {
  const value = safeDiagnostic({ kind: 'error', stage: 'tool_finished', error_code: 'MISSING_CREDENTIAL',
    summary: 'password="secret-one" Authorization: Bearer token-two api_key=sk-secretthree',
    raw_command: 'secret command', stdout: 'secret output', arguments: { secret: 'secret four' },
    provider: 'deepseek-official', model: 'deepseek-chat', selection_source: 'default' })
  assert.equal(value.provider, 'deepseek-official')
  assert.equal(value.selection_source, 'default')
  for (const secret of ['secret-one', 'token-two', 'sk-secretthree', 'secret command', 'secret output', 'secret four']) assert.equal(JSON.stringify(value).includes(secret), false)
})

test('credential failures require authorization rather than ending as ordinary failed work', async () => {
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async () => { throw new HarnessAuthRequiredError('Missing local model credentials') }, async () => 'scope')
  await runner.handle(envelope())
  assert.equal(reports.at(-1).state, 'TASK_STATE_AUTH_REQUIRED')
})

test('diagnostic report wire preserves event ids and never fabricates a task state', async () => {
  const { GatewayClient } = await import('../dist/gateway.js')
  const requests = []
  const gateway = new GatewayClient('https://platform.example', { id: 'device-one', name: 'device', capabilities: [] },
    { accessToken: async () => 'test-token' }, 'pull', {}, async (url, init) => {
      requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
      if (String(url).includes('/tasks/active')) return Response.json({ tasks: [{ action: 'inspect', task: {
        id: 'existing', contextId: 'context', status: { state: 'TASK_STATE_WORKING' },
      } }], next_after_id: null })
      return Response.json({ taskEventsVersion: 1, deviceId: 'device-one' })
    })
  assert.equal((await gateway.register()).taskEventsVersion, 1)
  await gateway.taskEvent('existing', { event_id: 'stable-event', diagnostics: { kind: 'heartbeat', stage: 'running', elapsed_ms: 3_601_000 } })
  const body = requests.at(-1).body
  assert.deepEqual(body, { deviceId: 'device-one', event_id: 'stable-event', diagnostics: { kind: 'heartbeat', stage: 'running', elapsed_ms: 3_601_000 } })
  const tasks = await gateway.activeTasks()
  assert.equal(tasks[0].id, 'existing')
  assert.equal(requests.at(-1).url, 'https://platform.example/a2a/devices/device-one/tasks/active?limit=100')
})

test('a stale queued transition is quarantined only after confirming remote termination', async (t) => {
  const { GatewayRequestError } = await import('../dist/gateway.js')
  const storageDirectory = await directory(t)
  const journal = new TaskJournal(storageDirectory, 'scope'); await journal.load()
  await journal.begin('cancelled-remotely', 'context', 'delivery')
  await journal.enqueue('cancelled-remotely', { event_id: 'stale-working', state: 'TASK_STATE_WORKING' })
  let reads = 0
  const runner = new TaskRunner(harness, [], {}, async () => { throw new GatewayRequestError(422) }, () => {},
    async () => { throw new Error('must not replay') }, async () => 'scope', {
      storageDirectory, getTask: async () => { reads++; return { id: 'cancelled-remotely', state: 'TASK_STATE_CANCELED' } }, activeTasks: async () => [],
    })
  await runner.initialize(1)
  await runner.flushReports()
  const stored = new TaskJournal(storageDirectory, 'scope'); await stored.load()
  assert.ok(reads >= 1)
  assert.equal(stored.get('cancelled-remotely').pending.length, 0)
  assert.equal(stored.get('cancelled-remotely').rejected[0].event_id, 'stale-working')
  assert.match(stored.get('cancelled-remotely').rejected[0].reason, /TASK_STATE_CANCELED/)
})

test('a slow diagnostic upload cannot block cancellation polling', async (t) => {
  const { createBridge } = await import('../dist/plugin.js')
  const { MemoryTokenStore } = await import('../dist/pkce.js')
  const storageDirectory = await directory(t)
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 })
  let delivered = false, releaseUpload, observedCancel
  const upload = new Promise((resolve) => { releaseUpload = resolve })
  const cancelled = new Promise((resolve) => { observedCancel = resolve })
  let uploads = 0, reads = 0, executionStarted = false
  const bridge = createBridge({ agents: { run: async (_skill, _input, context) => {
    executionStarted = true
    try {
      await context.reportProgress({ kind: 'progress', stage: 'running' })
      context.signal.throwIfAborted()
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))
      context.signal.throwIfAborted()
    } finally { if (context.signal.aborted) observedCancel() }
  } } }, {
    gatewayUrl: 'https://platform.example', executionMode: 'a2a-message', transport: 'pull', pollIntervalMs: 250,
    taskStorageDirectory: storageDirectory, device: { id: 'device', name: 'device', capabilities: [] },
    oauth: { clientId: 'test', authorizationEndpoint: 'https://auth.example', tokenEndpoint: 'https://auth.example/token', redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenStore: store, openAuthorizationUrl() {} },
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      if (path.endsWith('/register')) return Response.json({ deviceId: 'device', taskEventsVersion: 1, executionLeaseVersion: 1 })
      if (path.endsWith('/tasks/active')) return Response.json({ tasks: [], next_after_id: null })
      if (path.endsWith('/events')) {
        const event = JSON.parse(init.body)
        if (event.diagnostics && event.diagnostics.stage !== 'queued') { uploads++; await upload }
        return Response.json({})
      }
      if (path === '/a2a') {
        reads++
        return Response.json({ result: { id: 'task-one', contextId: 'context-one', status: { state: 'TASK_STATE_WORKING' },
          metadata: { executionLease: { deliveryId: 'task-one:message', phase: 'running', cancelRequested: executionStarted } } } })
      }
      if (delivered) return new Response(null, { status: 204 })
      delivered = true
      return Response.json(envelope().envelope)
    },
  })
  t.after(async () => { releaseUpload(); await bridge.stop() })
  await bridge.start()
  let timer
  try {
    await Promise.race([cancelled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation was blocked by diagnostics')), 2000) })])
    assert.ok(uploads >= 1)
    assert.ok(reads >= 1)
  } finally { clearTimeout(timer); releaseUpload(); await bridge.stop() }
})

test('an idempotent WORKING acknowledgement does not authorize execution after cancellation', async (t) => {
  const storageDirectory = await directory(t)
  let executed = false, reads = 0
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async () => { executed = true; return {} }, async () => 'scope', {
      storageDirectory, getTask: async () => { reads++; return { id: 'task-one', state: 'TASK_STATE_CANCELED' } }, activeTasks: async () => [],
    })
  await runner.initialize(1)
  await runner.handle(envelope())
  assert.equal(reads, 1)
  assert.equal(executed, false)
  assert.equal(reports.filter((event) => event.state === 'TASK_STATE_COMPLETED').length, 0)
  const journal = new TaskJournal(storageDirectory, 'scope'); await journal.load()
  assert.equal(journal.get('task-one').phase, 'finished')
})

test('a recovered tool error is kept in history but not attached to the successful result', async (t) => {
  const storageDirectory = await directory(t)
  const reports = []
  const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
    async (_message, context) => {
      await context.reportProgress({ kind: 'error', stage: 'tool_finished', error_code: 'TOOL_ERROR', summary: 'Recovered tool attempt', provider: 'route', model: 'model' })
      return { text: 'done' }
    }, async () => 'scope', { storageDirectory, getTask: async () => ({ state: 'TASK_STATE_WORKING' }), activeTasks: async () => [] })
  await runner.initialize(1)
  await runner.handle(envelope())
  await runner.flushReports()
  assert.ok(reports.some((event) => event.diagnostics?.error_code === 'TOOL_ERROR'))
  const result = reports.find((event) => event.state === 'TASK_STATE_COMPLETED').diagnostics
  assert.equal(result.error_code, undefined)
  assert.equal(result.summary, undefined)
  assert.equal(result.provider, 'route')
  assert.equal(result.changes, 'unknown')
})

test('invalid execution deadlines cannot start local work', async () => {
  for (const timeoutSeconds of [0, -1, 604801, Infinity, NaN]) {
    let executed = false
    const reports = []
    const runner = new TaskRunner(harness, [], {}, async (_id, event) => reports.push(event), () => {},
      async () => { executed = true; return {} }, async () => 'scope')
    await runner.handle(envelope('invalid', { timeoutSeconds }))
    assert.equal(executed, false)
    assert.equal(reports.at(-1).state, 'TASK_STATE_REJECTED')
  }
})


test('reconnecting does not await a slow final-result outbox before accepting control traffic', async (t) => {
  const storageDirectory = await directory(t)
  const journal = new TaskJournal(storageDirectory, 'scope'); await journal.load()
  await journal.begin('old-result', 'context', 'delivery')
  await journal.enqueue('old-result', { event_id: 'stable-result', state: 'TASK_STATE_COMPLETED' })
  let release
  const upload = new Promise((resolve) => { release = resolve })
  const runner = new TaskRunner(harness, [], {}, async () => upload, () => {},
    async () => { throw new Error('must not replay') }, async () => 'scope', {
      storageDirectory, getTask: async () => ({ state: 'TASK_STATE_COMPLETED' }), activeTasks: async () => [],
    })
  let timer
  try {
    await Promise.race([runner.initialize(1), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Reconnect waited for an old upload')), 1000)
    })])
  } finally { clearTimeout(timer); release(); await runner.flushReports() }
  const stored = new TaskJournal(storageDirectory, 'scope'); await stored.load()
  assert.equal(stored.get('old-result').pending.length, 0)
})
