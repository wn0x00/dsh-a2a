import assert from 'node:assert/strict'
import test from 'node:test'

import { createBridge } from '../dist/plugin.js'
import { MemoryTokenStore } from '../dist/pkce.js'
import { TaskRunner } from '../dist/task-runner.js'

test('stop waits for timed-out native execution to dispose before releasing ownership', async (t) => {
  let release, stopped = false, aborted = false, disposed = false
  const cleanup = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  const reports = []
  const runner = new TaskRunner({ agents: { run: async () => ({}) } }, [], {},
    async (_taskId, event) => { reports.push(event) }, () => {},
    async (_message, context) => {
      context.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      try { await cleanup; return { text: 'late result' } } finally { disposed = true }
    }, async () => 'local-scope',
  )
  await runner.handle({ type: 'task', envelope: {
    task: { id: 'timeout', contextId: 'context', state: 'TASK_STATE_SUBMITTED' },
    executionMode: 'a2a-message', deliveryId: 'timeout:message', timeoutSeconds: 1,
    message: { messageId: 'message', role: 'ROLE_USER', parts: [{ text: 'wait' }] },
  } })
  assert.equal(aborted, true)
  assert.equal(disposed, false)
  assert.equal(reports.at(-1).state, 'TASK_STATE_FAILED')
  const stopping = runner.stop().then(() => { stopped = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  release()
  await stopping
  assert.equal(disposed, true)
  assert.equal(stopped, true)
  assert.deepEqual(reports.map((event) => event.state), ['TASK_STATE_WORKING', 'TASK_STATE_FAILED'])
})

test('standard GetTask cancellation aborts a running pull-delivered Agent and waits for disposal', async (t) => {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 })
  let delivered = false, disposed = false, finish
  const done = new Promise((resolve) => { finish = resolve })
  const reports = [], reads = []
  const bridge = createBridge({ agents: { run: async (_skill, _message, context) => {
    try {
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))
      context.signal.throwIfAborted()
      return { text: 'must not complete' }
    } finally {
      await new Promise((resolve) => setImmediate(resolve))
      disposed = true
    }
  } } }, {
    gatewayUrl: 'https://gateway.example', executionMode: 'a2a-message', transport: 'pull', pollIntervalMs: 250,
    device: { id: 'native', name: 'Harness', capabilities: [] },
    oauth: {
      clientId: 'test', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token',
      redirectUri: 'http://127.0.0.1/callback', scopes: [], tokenStore: store, openAuthorizationUrl() {},
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      if (path.endsWith('/register')) return Response.json({ deviceId: 'native' })
      if (path.endsWith('/events')) {
        const event = JSON.parse(init.body)
        reports.push(event)
        if (event.state === 'TASK_STATE_CANCELED') finish()
        return Response.json({})
      }
      if (path === '/a2a') {
        const rpc = JSON.parse(init.body)
        reads.push(rpc)
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: {
          id: 'cancel-task', contextId: 'context', status: { state: 'TASK_STATE_CANCELED' },
        } })
      }
      if (delivered) return new Response(null, { status: 204 })
      delivered = true
      return Response.json({
        task: { id: 'cancel-task', contextId: 'context', status: { state: 'TASK_STATE_SUBMITTED' }, metadata: { executionMode: 'a2a-message' } },
        executionMode: 'a2a-message', deliveryId: 'cancel-task:message',
        message: { messageId: 'message', role: 'ROLE_USER', parts: [{ text: 'wait for cancellation' }] },
      })
    },
  })
  t.after(() => bridge.stop())
  let timer
  try {
    await bridge.start()
    await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CancelTask was not observed')), 3_000) })])
    assert.equal(reads[0].method, 'GetTask')
    assert.deepEqual(reads[0].params, { id: 'cancel-task' })
    assert.equal(disposed, true)
    assert.deepEqual(reports.map((event) => event.state), ['TASK_STATE_WORKING', 'TASK_STATE_CANCELED'])
  } finally {
    clearTimeout(timer)
    await bridge.stop()
  }
})
