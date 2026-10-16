import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNativeHarnessContext } from '../dist/harness.js'

const message = {
  messageId: 'message', role: 'ROLE_USER', parts: [{ text: 'Inspect this project' }],
  metadata: { agentPreset: 'remote-cannot-choose', provider: 'remote-provider' },
}
function runContext(id = 'context') {
  return { taskId: 'task', contextId: id, executionMode: 'a2a-message',
    sessionScope: 'local-consent', signal: new AbortController().signal,
    requestApproval: async () => false }
}

async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'xbot-preset-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const sessionDirectory = join(workspace, 'sessions')
  const stored = new Map()
  const live = new Map()
  const calls = { creates: [], resumes: [], mounts: [], inputs: [], disposals: [] }
  const presets = {
    async resolve(id) {
      return { id: id || 'standard', ...(options.broken ? { broken: options.broken } : {}) }
    },
    async mount(context, id) {
      calls.mounts.push({ context, id })
      context.toolsMounted = true
    },
  }
  async function handle(id, request) {
    const session = stored.get(id)
    const context = { toolsMounted: false }
    const value = {
      agent: {
        id,
        options: request.agentOptions,
        followup(input) {
          assert.equal(context.toolsMounted, true, 'a raw Agent cannot execute before its preset tools mount')
          calls.inputs.push(input)
        },
        async whenIdle() {
          session.events.push(...(options.turnEvents ?? [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]))
        },
        session: {
          header: session.header,
          requestHeader: () => session.requestHeader,
          snapshotEvents: () => session.events,
          deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'result' }] }],
        },
      },
      async dispose() { calls.disposals.push(id); live.delete(id) },
    }
    try { await request.setup(context, value.agent) } catch (error) {
      await value.dispose()
      throw error
    }
    live.set(id, value.agent)
    return value
  }
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return options.noPresets ? undefined : presets
      if (name === 'sessionPersistence') return {}
      if (name === 'sessions') return { async flush() { return true } }
      if (name === 'workspaceRegistry') return { async create(path) {
        return { id: 'workspace', path, async attachSession() {} }
      } }
      if (name === 'sessionProjections') return { stateOf(session) {
        return { pending: options.pendingModel ?? null }
      } }
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) },
    agents: {
      get(id) { return live.get(id) },
      async create(request) {
        calls.creates.push(request)
        stored.set(request.sessionId, { header: request.meta, events: [...(options.oldEvents ?? [])] })
        return handle(request.sessionId, request)
      },
      async resume(request) {
        calls.resumes.push(request)
        return handle(request.resumeSessionId, request)
      },
    },
    effect() {},
  }
  return { workspace, sessionDirectory, stored, calls, ctx, live,
    adapter: (config = {}) => {
      const adapter = createNativeHarnessContext(ctx, { workingDirectory: workspace, ...config }, { sessionDirectory })
      t.after(() => adapter.dispose())
      return adapter
    } }
}

test('native creation and resumed contexts mount the selected Harness preset before invoking tools', async (t) => {
  const { adapter, calls, sessionDirectory } = await fixture(t)
  const first = adapter()
  await first.agents.run('', message, runContext())
  await first.dispose()
  const second = adapter()
  await second.agents.run('', message, runContext())
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.resumes.length, 1)
  assert.equal(calls.creates[0].meta.agentPreset, 'standard')
  assert.deepEqual(calls.mounts.map((call) => call.id), ['standard', 'standard'])
  assert.notEqual(calls.mounts[0].context, calls.mounts[1].context)
  assert.equal(calls.inputs.length, 2)
  assert.equal(calls.disposals.length, 1)
  const [file] = await readdir(sessionDirectory)
  assert.equal(JSON.parse(await readFile(join(sessionDirectory, file), 'utf8')).agentPreset, 'standard')
})

test('missing or broken preset services fail before a tool-less Agent can start', async (t) => {
  for (const options of [{ noPresets: true }, { broken: 'pwsh executor unavailable' }]) {
    const { adapter, calls } = await fixture(t, options)
    await assert.rejects(adapter().agents.run('', message, runContext()), options.noPresets ? /Agent 模式服务/ : /pwsh executor unavailable/)
    assert.equal(calls.creates.length, 0)
  }
})

test('preset changes require a new context and remote metadata cannot select a preset', async (t) => {
  const { adapter, calls } = await fixture(t)
  let selected = 'standard'
  const harness = adapter({ agentPreset: { get: () => selected } })
  await harness.agents.run('', message, runContext())
  selected = 'minimal'
  await assert.rejects(harness.agents.run('', message, runContext()), /Agent 模式已更改/)
  assert.equal(calls.resumes.length, 0)
  await harness.agents.run('', message, runContext('new-context'))
  assert.deepEqual(calls.mounts.map((call) => call.id), ['standard', 'minimal'])
})

test('pre-preset contexts and mismatched persisted headers are never silently granted a new tool set', async (t) => {
  const { adapter, calls, stored, sessionDirectory } = await fixture(t)
  const first = adapter()
  await first.agents.run('', message, runContext())
  await first.dispose()
  const [file] = await readdir(sessionDirectory)
  const path = join(sessionDirectory, file)
  const binding = JSON.parse(await readFile(path, 'utf8'))
  delete binding.agentPreset
  await writeFile(path, JSON.stringify(binding))
  await assert.rejects(adapter().agents.run('', message, runContext()), /旧版插件创建/)
  assert.equal(calls.resumes.length, 0)
  binding.agentPreset = 'standard'
  await writeFile(path, JSON.stringify(binding))
  stored.get(binding.sessionId).header.agentPreset = 'different'
  await assert.rejects(adapter().agents.run('', message, runContext()), /Agent 模式与本地记录不一致/)
  assert.equal(calls.inputs.length, 1)
  assert.equal(calls.disposals.length, 2)
})

test('model settings seed new sessions and do not reset an existing DSH session', async (t) => {
  const { adapter, calls, live } = await fixture(t)
  let provider = 'custom-provider', model = 'custom-model'
  const harness = adapter({ provider: { get: () => provider }, model: { get: () => model } })
  await harness.agents.run('', message, runContext())
  assert.deepEqual(calls.creates[0].agentOptions, { provider, model })
  provider = ''; model = ''
  await harness.agents.run('', message, runContext())
  assert.equal(calls.resumes.length, 0)
  assert.deepEqual(live.get(calls.creates[0].sessionId).options, { provider: 'custom-provider', model: 'custom-model' })
  await harness.agents.run('', message, runContext('new-context'))
  assert.deepEqual(calls.creates[1].agentOptions, { provider: 'host-provider', model: 'host-model' })
})

for (const pending of [false, true]) {
  test(`cold resume follows durable DSH model selection with pending=${pending}`, async (t) => {
    const options = {}
    const { adapter, calls, stored, live } = await fixture(t, options)
    const first = adapter({ provider: 'initial', model: 'initial-model' })
    await first.agents.run('', message, runContext())
    await first.dispose()
    const id = calls.creates[0].sessionId
    stored.get(id).requestHeader = {
      config: { provider: 'ui-provider', model: 'ui-model', reasoningEffort: 'high' },
      adapterDefaults: { reasoningEffort: false },
    }
    if (pending) options.pendingModel = { provider: 'pending-provider', model: 'pending-model' }
    await adapter({ provider: 'changed-plugin', model: 'changed-model' }).agents.run('', message, runContext())
    assert.deepEqual(live.get(id).options, pending
      ? { provider: 'pending-provider', model: 'pending-model' }
      : { provider: 'ui-provider', model: 'ui-model', reasoningEffort: 'high' })
    assert.equal(calls.resumes.length, 1)
  })
}

test('failed turn diagnostics include current tool and provider facts while keeping credentials and commands local', async (t) => {
  const { adapter, calls } = await fixture(t, {
    oldEvents: [{ type: 'tool/call', data: { name: 'OLD_TOOL', callId: 'old' } },
      { type: 'tool/result', data: { message: { toolCallId: 'old', isError: true }, error: { code: 'OLD_ERROR' } } }],
    turnEvents: [
      { type: 'tool/call', data: { name: 'pwsh', callId: 'current', arguments: 'DO_NOT_UPLOAD_COMMAND' } },
      { type: 'tool/result', data: { message: { toolCallId: 'current', isError: true }, error: { code: 'TOOL_NOT_FOUND', reason: 'unknown tool; api_key=sk-secret123 password=test-secret' } } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'PROVIDER_ERROR', status: 429, message: 'Failed with Bearer oauth-secret; access_token=token-secret sk-anothersecret' } } } },
    ],
  })
  await assert.rejects(adapter().agents.run('', message, runContext()), (error) => {
    assert.match(error.message, /PROVIDER_ERROR/)
    assert.match(error.message, /HTTP 429/)
    assert.match(error.message, /pwsh \(TOOL_NOT_FOUND\)/)
    assert.match(error.message, /DSH 会话: xbot-a2a-/)
    assert.doesNotMatch(error.message, /OLD_TOOL|OLD_ERROR|DO_NOT_UPLOAD_COMMAND|sk-secret123|test-secret|oauth-secret|token-secret|sk-anothersecret/)
    return true
  })
  assert.equal(calls.disposals.length, 0)
})

test('a resumed task cannot mistake an earlier completed turn for its own completion', async (t) => {
  const { adapter } = await fixture(t, {
    oldEvents: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }], turnEvents: [],
  })
  await assert.rejects(adapter().agents.run('', message, runContext()), /MISSING_TURN_END/)
})
