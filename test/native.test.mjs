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

test('follow-default uses the Host route as a pair even when legacy environment overrides remain', async () => {
  const oldProvider = process.env.A2A_LLM_PROVIDER, oldModel = process.env.A2A_LLM_MODEL
  process.env.A2A_LLM_PROVIDER = 'old-deepseek-route'; process.env.A2A_LLM_MODEL = 'old-model'
  try {
    let route
    const reports = []
    const ctx = withPresets({
      agentDefaultModel: { currentSelection: () => ({ provider: 'working-provider', model: 'working-model' }) },
      agents: { async create(options) {
        route = options.agentOptions
        return { agent: { options: { ...route }, followup() {}, async whenIdle() {},
          session: { deriveMessages: () => [] } }, async dispose() {} }
      } }, effect() {},
    })
    const adapter = createNativeHarnessContext(ctx, { provider: '', model: '' })
    await adapter.agents.run('', 'hello', { taskId: 'task', contextId: 'context', signal: new AbortController().signal,
      requestApproval: async () => true, reportProgress: async (event) => reports.push(event) })
    assert.deepEqual(route, { provider: 'working-provider', model: 'working-model' })
    assert.ok(reports.some((event) => event.provider === 'working-provider' && event.selection_source === 'default'))
  } finally {
    if (oldProvider === undefined) delete process.env.A2A_LLM_PROVIDER; else process.env.A2A_LLM_PROVIDER = oldProvider
    if (oldModel === undefined) delete process.env.A2A_LLM_MODEL; else process.env.A2A_LLM_MODEL = oldModel
  }
})

test('an incomplete explicit route cannot mix a configured provider with the default model', async () => {
  let executed = false
  const adapter = createNativeHarnessContext({
    agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) },
    agents: { async create() { executed = true; throw new Error('must not create') } }, effect() {},
  }, { provider: 'different-provider', model: '' })
  await assert.rejects(adapter.agents.run('', 'hello', { taskId: 'task', contextId: 'context', signal: new AbortController().signal, requestApproval: async () => true }), /模型配置不完整/)
  assert.equal(executed, false)
})

test('native missing credentials emit safe route and tool diagnostics and require authorization', async () => {
  const reports = [], events = []
  const ctx = withPresets({
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }) },
    agents: { async create(options) {
      return { agent: { options: { ...options.agentOptions }, followup() {
        events.push({ type: 'turn/start', data: { turn: 2 } },
          { type: 'tool/call', data: { callId: 'call-one', name: 'read_file', arguments: { password: 'not-logged' } } },
          { type: 'tool/result', data: { message: { toolCallId: 'call-one', isError: false }, stdout: 'private-content' } },
          { type: 'turn/end', data: { reason: { kind: 'failed', error: { code: 'MISSING_CREDENTIAL', message: 'Missing provider key; api_key=do-not-send' } } } })
      }, async whenIdle() {}, session: { snapshotEvents: () => events, deriveMessages: () => [] } }, async dispose() {} }
    } }, effect() {},
  })
  const adapter = createNativeHarnessContext(ctx)
  await assert.rejects(adapter.agents.run('', 'hello', { taskId: 'task', contextId: 'context', signal: new AbortController().signal,
    requestApproval: async () => true, reportProgress: async (event) => reports.push(event) }), (error) => {
      assert.equal(error.name, 'HarnessAuthRequiredError')
      assert.equal(error.message.includes('do-not-send'), false)
      return true
    })
  assert.ok(reports.some((event) => event.stage === 'tool_started' && event.tool_name === 'read_file'))
  assert.ok(reports.some((event) => event.stage === 'tool_finished' && event.duration_ms >= 0))
  assert.ok(reports.some((event) => event.error_code === 'MISSING_CREDENTIAL'))
  for (const text of ['not-logged', 'private-content', 'do-not-send']) assert.equal(JSON.stringify(reports).includes(text), false)
})
