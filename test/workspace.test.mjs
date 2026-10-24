import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { OAuthClient } from '../dist/pkce.js'
import { join } from 'node:path'
import test from 'node:test'

import { apply, createNativeHarnessContext } from '../dist/harness.js'
import { A2ABridge } from '../dist/plugin.js'
import { lockProfile, profileStorageDirectory } from '../dist/token-store.js'
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
  const live = new Map()
  const workspaces = new Map()
  const calls = { creates: [], resumes: [], messages: [], disposed: [], flushes: [], attachments: [], cancels: [] }
  const handle = (id, header) => ({
    agent: {
      status: 'idle',
      followup(value) { calls.messages.push({ sessionId: id, value }) },
      async whenIdle() { await options.whenIdle?.() },
      cancel() { calls.cancels.push(id) },
      session: { header, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '结果' }] }] },
    },
    async dispose() { calls.disposed.push(id); live.delete(id); await options.dispose?.() },
  })
  return {
    calls,
    stored,
    live,
    workspaces,
    ctx: {
      get(name) {
        if (name === 'sessionPersistence') return {}
        if (name === 'sessions') return { async flush(session) { await options.flush?.(session); calls.flushes.push(session); return options.persistencePresent !== false } }
        if (name === 'workspaceRegistry') return { async create(path) {
          let item = workspaces.get(path)
          if (!item) {
            item = { id: `workspace-${workspaces.size}`, path, sessionIds: [], async attachSession(id) {
              await options.attachSession?.(id)
              assert.equal(stored.get(id).cwd, path)
              if (!item.sessionIds.includes(id)) item.sessionIds.push(id)
              calls.attachments.push(id)
            } }
            workspaces.set(path, item)
          }
          return item
        } }
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
        get(id) { return live.get(id)?.agent },
        async create(value) {
          calls.creates.push(value)
          stored.set(value.sessionId, value.meta)
          const created = handle(value.sessionId, value.meta)
          await value.setup?.({}, created.agent)
          live.set(value.sessionId, created)
          return created
        },
        async resume(value) {
          calls.resumes.push(value)
          assert.equal(live.has(value.resumeSessionId), false, 'must reuse the existing writer')
          if (!stored.has(value.resumeSessionId)) throw new Error('Persisted session missing')
          const resumed = handle(value.resumeSessionId, stored.get(value.resumeSessionId))
          await value.setup?.({}, resumed.agent)
          live.set(value.resumeSessionId, resumed)
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
  assert.equal(parsed.value.deviceName.get(), '')
  assert.equal(parsed.value.deviceDescription.get(), '')
  assert.equal(configuredWorkingDirectory(parsed.value), '')
  assert.doesNotMatch(JSON.stringify(Config), /realpath|statSync|validateHostDirectory/)
})

test('committed native identity edits register changes and connect requests run only once', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx } = host(workspace)
  const listeners = new Map()
  const updates = []
  let cleanup, connected = 0, ready
  const started = new Promise((resolve) => { ready = resolve })
  let deviceName = 'Initial device', deviceDescription = '', request = ''
  ctx.on = (event, callback) => { listeners.set(event, callback) }
  ctx.effect = (effect) => { cleanup = effect() }
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    authorization_endpoint: 'https://platform.example/authorize',
    token_endpoint: 'https://platform.example/token',
  }))
  t.mock.method(A2ABridge.prototype, 'start', async () => { ready() })
  t.mock.method(A2ABridge.prototype, 'connect', async () => { connected++ })
  t.mock.method(A2ABridge.prototype, 'updateIdentity', async (value) => { updates.push(value) })
  apply(ctx, {
    gatewayUrl: 'https://platform.example', storageDirectory: join(root, 'credentials'),
    workingDirectory: workspace,
    deviceName: { get: () => deviceName }, deviceDescription: { get: () => deviceDescription },
    connectionRequest: { get: () => request },
  })
  t.after(() => cleanup())
  await started
  assert.equal(connected, 0)
  deviceName = ' Office device '
  deviceDescription = ' Local project work '
  request = 'explicit-click'
  listeners.get('loader/volatile-update')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(updates, [{ name: 'Office device', description: 'Local project work' }])
  assert.equal(connected, 1)
  listeners.get('loader/volatile-update')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(connected, 1)
  assert.equal(updates.length, 1)
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
  const { ctx, calls, live, workspaces } = host(workspace)
  const options = { sessionDirectory: join(root, 'sessions') }
  const first = createNativeHarnessContext(ctx, { workingDirectory: workspace }, options)
  t.after(() => first.dispose())
  await first.agents.run('', message('第一段'), context())
  await first.agents.run('', message('第二段'), context())
  assert.equal(calls.resumes.length, 0)
  assert.equal(calls.disposed.length, 0)
  assert.equal(live.size, 1)
  assert.deepEqual(workspaces.get(workspace).sessionIds, [calls.creates[0].sessionId])
  assert.equal(calls.flushes.length, 2)
  await first.dispose()
  assert.equal(live.size, 0)
  const second = createNativeHarnessContext(ctx, { workingDirectory: workspace }, options)
  t.after(() => second.dispose())
  await second.agents.run('', message('继续'), context())
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.resumes.length, 1)
  assert.equal(calls.resumes[0].resumeSessionId, calls.creates[0].sessionId)
  assert.equal(calls.creates[0].meta.cwd, workspace)
  assert.deepEqual(calls.messages.map((item) => item.value.content), [[{ type: 'text', text: '第一段' }], [{ type: 'text', text: '第二段' }], [{ type: 'text', text: '继续' }]])
  assert.equal(calls.disposed.length, 1)
  assert.equal(workspaces.size, 1)
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
  await native.dispose()
  stored.clear()
  const restarted = createNativeHarnessContext(ctx, { workingDirectory: workspace }, { sessionDirectory: join(root, 'sessions') })
  await assert.rejects(restarted.agents.run('', message(), context()), /Persisted session missing/)
  assert.equal(calls.messages.length, 1)
  await rm(workspace, { recursive: true })
  await assert.rejects(restarted.agents.run('', message(), context('new')), /工作目录不存在/)
  assert.equal(calls.creates.length, 1)
})

test('a DSH-opened session is reused without taking its writer ownership', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx, calls, live } = host(workspace)
  const options = { sessionDirectory: join(root, 'sessions') }
  const first = createNativeHarnessContext(ctx, {}, options)
  await first.agents.run('', message(), context())
  const created = calls.creates[0]
  await first.dispose()
  const uiHandle = await ctx.agents.resume({ resumeSessionId: created.sessionId })
  const native = createNativeHarnessContext(ctx, {}, options)
  await native.agents.run('', message('继续'), context())
  assert.equal(calls.resumes.length, 1, 'remote invocation must not open a second writer')
  await native.dispose()
  assert.equal(live.get(created.sessionId), uiHandle, 'plugin disposal must not close the UI-owned session')
  assert.equal(calls.disposed.length, 1)
  await uiHandle.dispose()
})

test('a busy DSH session is neither interrupted nor mistaken for the remote task', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx, calls, live } = host(workspace)
  const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, 'sessions') })
  t.after(() => native.dispose())
  await native.agents.run('', message(), context())
  const handle = live.get(calls.creates[0].sessionId)
  handle.agent.status = 'running'
  await assert.rejects(native.agents.run('', message('must not enqueue'), context()), /正在处理其他输入/)
  assert.equal(calls.messages.length, 1)
  assert.equal(calls.cancels.length, 0)
  assert.equal(calls.disposed.length, 0)
})

test('a missing workspace service or failed attachment cannot run an invisible task', async (t) => {
  const { root, workspace } = await fixture(t)
  for (const missing of [true, false]) {
    const { ctx, calls } = host(workspace, { attachSession: async () => { throw new Error('workspace storage unavailable') } })
    const get = ctx.get.bind(ctx)
    if (missing) ctx.get = (name) => name === 'workspaceRegistry' ? undefined : get(name)
    const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, `sessions-${missing}`) })
    t.after(() => native.dispose())
    await assert.rejects(native.agents.run('', message(), context()), missing ? /工作区服务/ : /workspace storage unavailable/)
    assert.equal(calls.messages.length, 0)
    assert.equal(calls.disposed.length, missing ? 0 : 1)
  }
})

test('task completion waits for the session flush while keeping its workspace entry', async (t) => {
  const { root, workspace } = await fixture(t)
  let flushStarted, release
  const flushing = new Promise((resolve) => { flushStarted = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const { ctx, calls, workspaces } = host(workspace, { flush: async () => { flushStarted(); await gate } })
  const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, 'sessions') })
  t.after(() => native.dispose())
  let completed = false
  const run = native.agents.run('', message(), context()).then(() => { completed = true })
  await flushing
  assert.equal(completed, false)
  assert.equal(calls.disposed.length, 0)
  assert.deepEqual(workspaces.get(workspace).sessionIds, [calls.creates[0].sessionId])
  release()
  await run
  assert.equal(completed, true)
  assert.equal(calls.flushes.length, 1)
})

test('canceling a remote turn flushes it and preserves the writer for the next turn', async (t) => {
  const { root, workspace } = await fixture(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { ctx, calls, live } = host(workspace, { whenIdle: () => gate })
  const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, 'sessions') })
  t.after(() => native.dispose())
  const controller = new AbortController()
  const run = native.agents.run('', message('cancel me'), { ...context(), signal: controller.signal })
  const rejected = assert.rejects(run, { name: 'AbortError' })
  while (!calls.messages.length) await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  release()
  await rejected
  assert.equal(calls.cancels.length, 1)
  assert.equal(calls.flushes.length, 1)
  assert.equal(calls.disposed.length, 0)
  await native.agents.run('', message('continue'), context())
  assert.equal(calls.messages.length, 2)
  assert.equal(calls.resumes.length, 0)
  assert.equal(live.size, 1)
  await native.dispose()
  assert.equal(live.size, 0)
  assert.equal(calls.disposed.length, 1)
})

test('a flush without a durability participant cannot report a completed task', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx } = host(workspace, { persistencePresent: false })
  const native = createNativeHarnessContext(ctx, {}, { sessionDirectory: join(root, 'sessions') })
  t.after(() => native.dispose())
  await assert.rejects(native.agents.run('', message(), context()), /无法确认任务记录已保存/)
})

test('plugin unload releases profile ownership after a retained session close fails', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx, calls } = host(workspace, { dispose: async () => { throw new Error('session close failed after drain') } })
  let cleanup, ready, stopped = false
  const started = new Promise((resolve) => { ready = resolve })
  const gatewayUrl = 'http://127.0.0.1:8000'
  const profile = 'unload-failure-test'
  const storageDirectory = join(root, 'credentials')
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    authorization_endpoint: `${gatewayUrl}/authorize`,
    token_endpoint: `${gatewayUrl}/token`,
  }))
  t.mock.method(A2ABridge.prototype, 'start', async function () {
    await this.ctx.agents.run('', message(), context())
    ready()
  })
  t.mock.method(A2ABridge.prototype, 'stop', async () => { stopped = true })
  ctx.effect = (effect) => { cleanup = effect() }
  apply(ctx, { gatewayUrl, profile, storageDirectory, workingDirectory: workspace })
  await started
  const directory = profileStorageDirectory(gatewayUrl, `platform:${profile}`, storageDirectory)
  await assert.rejects(lockProfile(directory), /already connected/)
  await assert.rejects(cleanup(), AggregateError)
  assert.equal(stopped, true)
  assert.equal(calls.disposed.length, 1)
  const release = await lockProfile(directory)
  await release()
})

test('host unload fences a slow callback before draining its HTTP response', async (t) => {
  const { root, workspace } = await fixture(t)
  const { ctx } = host(workspace)
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
  const gatewayUrl = 'https://platform.example'
  let cleanup, bridge, ready, state, exchangeStarted, finishExchange
  let registrations = 0
  const started = new Promise((resolve) => { ready = resolve })
  const exchanging = new Promise((resolve) => { exchangeStarted = resolve })
  const exchangeGate = new Promise((resolve) => { finishExchange = resolve })
  const nativeFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith(redirectUri)) return nativeFetch(url, init)
    if (String(url).endsWith('/metadata')) return Response.json({ authorization_endpoint: `${gatewayUrl}/authorize`, token_endpoint: `${gatewayUrl}/token` })
    if (String(url).endsWith('/requests')) {
      state = JSON.parse(init.body).state
      return Response.json({ authorization_url: `${gatewayUrl}/authorize?request_id=fixture`, expires_in: 600 })
    }
    if (String(url).endsWith('/token')) {
      exchangeStarted()
      await exchangeGate
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    }
    if (String(url).endsWith('/devices/register')) registrations++
    return new Response(null, { status: 204 })
  })
  const originalStart = A2ABridge.prototype.start
  t.mock.method(A2ABridge.prototype, 'start', async function () {
    bridge = this
    await originalStart.call(this)
    ready()
  })
  const begin = OAuthClient.prototype.beginAuthorization
  t.mock.method(OAuthClient.prototype, 'beginAuthorization', async function (...args) {
    this.config.openAuthorizationUrl = () => undefined
    return begin.apply(this, args)
  })
  ctx.effect = (effect) => { cleanup = effect() }
  apply(ctx, { gatewayUrl, profile: 'slow-callback-shutdown', storageDirectory: join(root, 'credentials'), workingDirectory: workspace, redirectUri })
  await started
  await bridge.connect()
  const callback = nativeFetch(`${redirectUri}?code=fixture&state=${encodeURIComponent(state)}`)
  await exchanging
  const unloading = cleanup()
  await Promise.resolve()
  finishExchange()
  const response = await callback
  await response.text()
  await unloading
  assert.notEqual(response.status, 200)
  assert.equal(bridge.status().phase, 'stopped')
  assert.equal(registrations, 0)
})
