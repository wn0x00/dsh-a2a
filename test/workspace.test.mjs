import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNativeHarnessContext } from '../dist/harness.js'
import { Config, configuredWorkingDirectory, installWorkspaceSettings, isFullyQualifiedDirectory, resolveWorkingDirectory, validateHostDirectory } from '../dist/workspace-settings.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xbot-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  const other = join(root, 'other')
  await mkdir(workspace)
  await mkdir(other)
  return { root, workspace, other }
}

function message(text = '执行正文') {
  return { messageId: 'message', role: 'ROLE_USER', parts: [{ text }], metadata: { cwd: '/remote-cannot-select-this' } }
}

function context(contextId = 'context', sessionScope = 'local-authorization') {
  return { taskId: 'task', contextId, sessionScope, executionMode: 'a2a-message', signal: new AbortController().signal, requestApproval: async () => false }
}

function host(workspace, options = {}) {
  const stored = new Map()
  const calls = { creates: [], resumes: [], messages: [], disposed: [] }
  const handle = (id, header) => ({
    agent: {
      followup(value) { calls.messages.push({ sessionId: id, value }) },
      async whenIdle() { await options.whenIdle?.() },
      cancel() {},
      session: { header, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '结果' }] }] },
    },
    async dispose() { calls.disposed.push(id) },
  })
  return {
    calls,
    stored,
    ctx: {
      get(name) {
        if (name === 'sessionPersistence') return {}
        if (name === 'agentPresets') return {
          async resolve(id) { return { id: id || 'standard' } },
          async mount() {},
        }
        if (name === 'fs') return {
          resolve: async (path) => path === '.' ? workspace : path,
          processPath: (path) => path,
          processPathFromHostPath: (path) => path,
          stat: async () => ({ type: 'directory' }),
        }
      },
      agents: {
        async create(value) {
          calls.creates.push(value)
          stored.set(value.sessionId, value.meta)
          const created = handle(value.sessionId, value.meta)
          await value.setup?.({}, created.agent)
          return created
        },
        async resume(value) {
          calls.resumes.push(value)
          if (!stored.has(value.resumeSessionId)) throw new Error('Persisted session missing')
          const resumed = handle(value.resumeSessionId, stored.get(value.resumeSessionId))
          await value.setup?.({}, resumed.agent)
          return resumed
        },
      },
      effect() {},
    },
  }
}

test('working directory schema stays serializable and preserves ordinary plugin configuration', () => {
  const parsed = Config['~standard'].validate({ gatewayUrl: 'https://platform.example', provider: 'private-provider' })
  assert.equal(parsed.value.gatewayUrl, 'https://platform.example')
  assert.equal(parsed.value.provider.get(), 'private-provider')
  assert.equal(parsed.value.model.get(), '')
  assert.equal(parsed.value.agentPreset.get(), '')
  assert.equal(configuredWorkingDirectory(parsed.value), '')
  assert.doesNotMatch(JSON.stringify(Config), /realpath|statSync|validateHostDirectory/)
})

test('local directory validation rejects missing, file, relative and drive-relative paths', async (t) => {
  const { root, workspace } = await fixture(t)
  await writeFile(join(root, 'file'), 'not a directory')
  assert.equal(validateHostDirectory(workspace), workspace)
  for (const value of ['relative', join(root, 'missing'), join(root, 'file'), null, '/bad\0path']) {
    assert.throws(() => validateHostDirectory(value), /工作目录/)
  }
  for (const value of ['C:folder', '\\folder', '/folder', '\\\\?\\C:\\folder', '\\\\.\\pipe\\thing']) {
    assert.equal(isFullyQualifiedDirectory(value, 'win32'), false, value)
  }
  for (const value of ['C:\\project', 'D:/project', '\\\\server\\share\\folder']) {
    assert.equal(isFullyQualifiedDirectory(value, 'win32'), true, value)
  }
  if (process.platform !== 'win32') {
    const alias = join(root, 'alias')
    await symlink(workspace, alias)
    assert.equal(validateHostDirectory(alias), workspace)
  }
})

test('settings hook rejects invalid edits before persistence and only validates its own fiber', async (t) => {
  const { root, workspace } = await fixture(t)
  let hook
  const fiber = { uid: 42 }
  const ctx = { fiber, on(_name, value) { hook = value }, effect() {}, agents: {} }
  installWorkspaceSettings(ctx, {})
  const bad = { workingDirectory: join(root, 'missing') }
  assert.throws(() => hook.call(fiber, bad, () => bad), /工作目录/)
  assert.throws(() => hook.call({ uid: 42 }, bad, () => bad), /工作目录/)
  assert.equal(hook.call({ uid: 43 }, bad, () => bad), bad)
  assert.equal(hook.call({}, bad, () => bad), bad)
  const valid = { workingDirectory: workspace }
  assert.equal(hook.call(fiber, valid, () => valid), valid)
  const incompleteModel = { provider: 'provider-only', model: '' }
  assert.throws(() => hook.call(fiber, incompleteModel, () => incompleteModel), /完整的模型/)
  const configuredModel = { provider: 'mimo', model: 'mimo-v2.5-pro' }
  assert.equal(hook.call(fiber, configuredModel, () => configuredModel), configuredModel)
})

test('selected host directory must map into the current filesystem execution world', async (t) => {
  const { workspace } = await fixture(t)
  const { ctx } = host(workspace)
  assert.equal(await resolveWorkingDirectory(ctx, { workingDirectory: workspace }), workspace)
  const unmapped = { ...ctx, get: () => ({ processPathFromHostPath: () => undefined }) }
  await assert.rejects(resolveWorkingDirectory(unmapped, { workingDirectory: workspace }), /无法访问/)
  const missing = { ...ctx, get: () => ({ processPathFromHostPath: (path) => path, resolve: async (path) => path, stat: async () => undefined }) }
  await assert.rejects(resolveWorkingDirectory(missing, { workingDirectory: workspace }), /不可用/)
})

test('standard Message runs only its text in configured cwd and resumes a controlled session across adapter restarts', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx, calls } = host(workspace)
  const options = { sessionDirectory: join(root, 'sessions') }
  const first = createNativeHarnessContext(ctx, { workingDirectory: workspace }, options)
  await first.agents.run('', message('第一段'), context())
  const second = createNativeHarnessContext(ctx, { workingDirectory: workspace }, options)
  await second.agents.run('', message('继续'), context())
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.resumes.length, 1)
  assert.equal(calls.resumes[0].resumeSessionId, calls.creates[0].sessionId)
  assert.equal(calls.creates[0].meta.cwd, workspace)
  assert.deepEqual(calls.messages.map((item) => item.value.content), [[{ type: 'text', text: '第一段' }], [{ type: 'text', text: '继续' }]])
  assert.equal(calls.disposed.length, 2)
  const files = await readdir(options.sessionDirectory)
  const saved = JSON.parse(await readFile(join(options.sessionDirectory, files[0]), 'utf8'))
  assert.match(saved.sessionId, /^xbot-a2a-/)
  assert.equal(saved.cwd, workspace)
})

test('authorization epochs and contexts create separate sessions; remote IDs never resume user sessions', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx, calls } = host(workspace)
  const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, 'sessions') })
  await native.agents.run('', message(), context('user-existing-session'))
  await native.agents.run('', message(), context('user-existing-session', 'new-authorization'))
  await native.agents.run('', message(), context('another-context'))
  assert.equal(calls.creates.length, 3)
  assert.equal(calls.resumes.length, 0)
  assert.equal(new Set(calls.creates.map((item) => item.sessionId)).size, 3)
  assert.ok(calls.creates.every((item) => item.sessionId !== 'user-existing-session'))
})

test('changing working directory refuses an old context and accepts a new context', async (t) => {
  const { root, workspace, other } = await fixture(t)
  const { ctx, calls } = host(workspace)
  let selected = workspace
  const native = createNativeHarnessContext(ctx, { workingDirectory: { get: () => selected } }, { sessionDirectory: join(root, 'sessions') })
  await native.agents.run('', message(), context())
  selected = other
  await assert.rejects(native.agents.run('', message(), context()), /工作目录已更改/)
  assert.equal(calls.resumes.length, 0)
  await native.agents.run('', message(), context('new-context'))
  assert.equal(calls.creates[1].meta.cwd, other)
})

test('same-context execution is serialized and an aborted queued task never resumes', async (t) => {
  const { root, workspace } = await fixture(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { ctx, calls } = host(workspace, { whenIdle: () => gate })
  const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, 'sessions') })
  const first = native.agents.run('', message(), context())
  const cancel = new AbortController()
  const second = native.agents.run('', message(), { ...context(), signal: cancel.signal })
  while (calls.messages.length < 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.resumes.length, 0)
  cancel.abort()
  release()
  await first
  await assert.rejects(second, /abort/i)
  assert.equal(calls.resumes.length, 0)
})

test('unsupported message parts, deleted projects and unavailable persisted sessions fail before followup', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx, calls, stored } = host(workspace)
  const native = createNativeHarnessContext(ctx, { workingDirectory: workspace }, { sessionDirectory: join(root, 'sessions') })
  await assert.rejects(native.agents.run('', { ...message(), parts: [{ data: { cwd: '/other' } }] }, context()), /text Message parts only/)
  assert.equal(calls.creates.length, 0)
  await native.agents.run('', message(), context())
  stored.clear()
  await assert.rejects(native.agents.run('', message(), context()), /Persisted session missing/)
  assert.equal(calls.messages.length, 1)
  await rm(workspace, { recursive: true })
  await assert.rejects(native.agents.run('', message(), context('new')), /工作目录不存在/)
  assert.equal(calls.creates.length, 1)
})
