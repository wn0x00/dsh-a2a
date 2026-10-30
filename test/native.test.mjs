import assert from 'node:assert/strict'
import test from 'node:test'

import { createNativeHarnessContext } from '../dist/harness.js'

function withPresets(ctx) {
  const get = ctx.get?.bind(ctx)
  ctx.get = (name) => name === 'agentPresets' ? {
    async resolve(id) { return { id: id || 'standard' } },
    async mount() {},
  } : get?.(name)
  const create = ctx.agents.create.bind(ctx.agents)
  ctx.agents.create = async (options) => {
    const handle = await create(options)
    handle.agent.session.header = options.meta
    await options.setup?.({}, handle.agent)
    return handle
  }
  return ctx
}

test('native adapter routes an A2A skill through the Harness agent service', async () => {
  let received
  let disposed = false
  const ctx = {
    agents: {
      async create(options) {
        assert.equal(options.agentOptions?.provider, 'deepseek')
        return {
          agent: {
            followup(message) {
              received = message
            },
            async whenIdle() {},
            session: {
              deriveMessages() {
                return [{ role: 'assistant', content: [{ type: 'text', text: 'Harness result' }] }]
              },
            },
          },
          async dispose() {
            disposed = true
          },
        }
      },
    },
    effect() {},
  }
  const harness = createNativeHarnessContext(withPresets(ctx), {
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  const result = await harness.agents.run('demo.echo', { prompt: 'hello' }, {
    taskId: 'task-1',
    contextId: 'context-1',
    signal: new AbortController().signal,
    requestApproval: async () => true,
  })

  assert.deepEqual(received.content, [{ type: 'text', text: '{"prompt":"hello"}' }])
  assert.equal(received.role, 'user')
  assert.equal(received.source.kind, 'user')
  assert.equal(result.text, 'Harness result')
  assert.equal(disposed, true)
})

test('native adapter inherits the Harness profile default model', async () => {
  let receivedOptions
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'profile-provider', model: 'profile-model' }),
    },
    agents: {
      async create(options) {
        receivedOptions = options
        return {
          agent: {
            followup() {},
            async whenIdle() {},
            session: { deriveMessages: () => [] },
          },
          async dispose() {},
        }
      },
    },
    effect() {},
  }
  const harness = createNativeHarnessContext(withPresets(ctx))
  await harness.agents.run('demo.echo', 'hello', {
    taskId: 'task-2',
    contextId: 'context-2',
    signal: new AbortController().signal,
    requestApproval: async () => true,
  })

  assert.equal(receivedOptions.agentOptions.provider, 'profile-provider')
  assert.equal(receivedOptions.agentOptions.model, 'profile-model')
})

test('native adapter inherits the filesystem workspace and fails an errored host turn', async () => {
  let disposed = false
  const events = []
  const ctx = {
    get: (name) => name === 'fs' ? { resolve: async () => 'virtual-root', processPath: () => '/isolated/workspace' } : undefined,
    agents: {
      async create(options) {
        assert.equal(options.meta.cwd, '/isolated/workspace')
        return {
          agent: {
            followup() {}, async whenIdle() {
              events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_UNAVAILABLE' } } } })
            },
            session: {
              deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'partial text' }] }],
              snapshotEvents: () => events,
            },
          },
          async dispose() { disposed = true },
        }
      },
    },
    effect() {},
  }
  const harness = createNativeHarnessContext(withPresets(ctx))
  await assert.rejects(harness.agents.run('demo.echo', 'hello', {
    taskId: 'task-error', contextId: 'context-error', signal: new AbortController().signal, requestApproval: async () => true,
  }), /MODEL_UNAVAILABLE/u)
  assert.equal(disposed, true)
})

for (const projectionDisposed of [false, true]) {
  test(`native cancellation drains the host handle when projectionDisposed=${projectionDisposed}`, async () => {
    let started, finishIdle, finishDisposal
    const ready = new Promise((resolve) => { started = resolve })
    const idle = new Promise((resolve) => { finishIdle = resolve })
    const disposal = new Promise((resolve) => { finishDisposal = resolve })
    const controller = new AbortController()
    let cancelCalls = 0, disposing = false, disposed = false, settled = false
    const ctx = {
      agents: {
        async create() {
          return {
            agent: {
              followup() { started() },
              cancel(cause) {
                assert.deepEqual(cause, { kind: 'user' })
                cancelCalls++
                if (projectionDisposed) {
                  throw new Error('agent "dsh-a2a-test" cannot read inbox state: its projection registration is not active')
                }
              },
              async whenIdle() { await idle },
              session: { deriveMessages() { throw new Error('Canceled execution must not read disposed projections') } },
            },
            async dispose() {
              disposing = true
              await disposal
              disposed = true
            },
          }
        },
      },
      effect() {},
    }
    const harness = createNativeHarnessContext(withPresets(ctx))
    const running = harness.agents.run('demo.echo', 'wait', {
      taskId: 'shutdown-task', contextId: 'shutdown-context', signal: controller.signal, requestApproval: async () => true,
    })
    const rejected = assert.rejects(running, { name: 'AbortError' }).then(() => { settled = true })
    await ready
    controller.abort()
    // EventTarget schedules escaped listener errors on the next tick. This
    // also proves that cancellation alone has not released the host handle.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelCalls, 1)
    assert.equal(settled, false)
    assert.equal(disposing, false)
    finishIdle()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(disposing, true)
    assert.equal(disposed, false)
    assert.equal(settled, false)
    finishDisposal()
    await rejected
    assert.equal(disposed, true)
  })
}
