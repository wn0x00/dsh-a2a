import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import * as Zod from 'zod'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import { installConnectionControl } from '../dist/connection-control.js'

const snapshot = {
  phase: 'connected', notice: 'none', gatewayUrl: 'https://platform.example',
  deviceId: 'device', deviceName: 'Office Harness', activeTasks: 0,
  pendingExpiresAt: null, lastConnectedAt: 1, lastContactAt: 2,
  canConnect: false, canReauthorize: true, canCancelAuthorization: false,
}
const updateSnapshot = {
  phase: 'available', currentVersion: '0.1.10', latestVersion: '0.1.11',
  checkedAt: 1, error: null, restartReason: null, canInstall: true, hasCredential: true,
}
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

function clientBundle() {
  let client
  vm.runInNewContext(source, {
    setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load({ factory }) {
      client = factory((name) => {
        if (name === 'react') return React
        if (name === 'zod') return Zod
        assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
        return { Button: () => null, Input: () => null }
      })
    } } },
  })
  return client
}

// Only the Connection carrier is in memory. Both ends use the released SDK:
// bundled Client apply -> $mount -> scoped namespace -> JSON RPC -> Host Gateway
// -> the actual plugin controller. UI fixtures cannot bypass Cordis injection.
async function fixture(t, options = {}) {
  const host = new Context()
  const client = new Context()
  const forks = []
  const actions = []
  const calls = []
  const registrations = new Map()
  let principal = { kind: 'owner' }
  let gate
  let transportError
  const peerSignal = new AbortController().signal
  const add = async (ctx, plugin) => {
    const fork = await ctx.plugin(plugin)
    forks.push(fork)
    return fork
  }
  t.after(async () => {
    for (const fork of forks.reverse()) await fork.dispose()
  })
  await add(host, TypertRegistry)
  await add(host, { name: 'access-policy', apply(ctx) {
    ctx.provide('remoteAccess', {
      decide: () => options.allowNonOwner
        ? { kind: 'allow' } : { kind: 'deny', reason: 'no-grant' },
    })
  } })
  await add(host, TypertGateway)
  const control = await add(host, { name: 'plugin-host', apply(ctx) {
    installConnectionControl(ctx, {
      status: () => ({ ...snapshot, ...options.extraStatus }),
      updater: options.updater,
      act: async (action) => {
        if (options.actionError) throw new Error('Bearer private-token')
        actions.push(action)
      },
    })
  } })
  assert.ok(host.get('xbotA2a'), 'Host controller must have started')
  const gateway = host.get('typertGateway')
  await add(client, TypertRegistry)
  await add(client, { name: 'connection-carrier', apply(ctx) {
    ctx.provide('connection', {
      interactions: 'none',
      rpc: {
        // A native carrier supports streams; these unary tests never open one.
        open: async function* () { throw new Error('Unexpected stream') },
        call: async (prefix, endpoint, payload, signal) => {
          assert.equal(prefix, '/api')
          const wire = JSON.parse(JSON.stringify(payload))
          calls.push({ endpoint, payload: wire, signal })
          if (transportError) throw transportError
          if (gate) await gate(signal)
          const result = await gateway.dispatchRpc(endpoint, wire, signal, {
            principal, signal: peerSignal,
          })
          return JSON.parse(JSON.stringify(result))
        },
      },
    })
  } })
  await add(client, ClientGateway)
  await add(client, { name: 'host-ui-services', apply(ctx) {
    ctx.provide('configForms', { get: () => ({
      getSnapshot: () => ({ status: 'ready' }), subscribe: () => () => {},
    }) })
    ctx.provide('workspaces', { list: {
      getSnapshot: () => ({ phase: 'ready', items: [] }), subscribe: () => () => {},
    } })
    ctx.provide('uiWorkspace', { pickDirectory: async () => '/workspace' })
    ctx.provide('slots', {
      inject: (_name, install) => install(),
      register: (metadata) => {
        registrations.set(metadata.name, metadata)
        return () => registrations.delete(metadata.name)
      },
    })
    for (const [namespace, method, value] of [
      ['session', 'modelCatalog', { groups: [] }],
      ['agentPresets', 'list', { presets: [] }],
      ['permissionPresets', 'catalog', { defaultPreset: 'safe' }],
    ]) {
      class Catalog extends Service {
        constructor() { super(ctx, `remote.${namespace}`) }
      }
      Catalog.prototype[method] = async () => ({ ok: true, value })
      new Catalog()
    }
  } })
  const mount = () => add(client, { name: 'published-client-bundle', ...clientBundle() })
  let mounted = await mount()
  const connection = () => registrations.get('settings.section').inject().connection
  return {
    host, client, control, calls, actions, registrations, connection,
    updates: () => registrations.get('settings.section').inject().updates,
    props: () => registrations.get('settings.section').inject(),
    principal: (next) => { principal = next },
    gate: (next) => { gate = next },
    transportError: (next) => { transportError = next },
    unload: () => mounted.dispose(),
    reload: async () => { mounted = await mount() },
  }
}

test('published bundle reads its mounted namespace through a real scoped Client and Host RPC', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.connection().status(), { ok: true, value: snapshot })
  for (const action of ['connect', 'reauthorize', 'cancelAuthorization']) {
    assert.equal((await f.connection()[action]()).ok, true)
  }
  assert.deepEqual(f.actions, ['connect', 'reauthorize', 'cancelPendingAuthorization'])
  assert.deepEqual(f.calls.map(({ endpoint }) => endpoint), [
    'xbotA2a/status', 'xbotA2a/connect', 'xbotA2a/reauthorize', 'xbotA2a/cancelAuthorization',
  ])
  assert.ok(f.calls.every(({ payload }) => Object.keys(payload).join() === 'args'
    && Object.keys(payload.args).length === 0))
  assert.doesNotMatch(JSON.stringify(await f.connection().status()), /token|verifier|state=/)
  // The dynamically injected child must retain the settings page's other deps.
  assert.equal(f.props().form.getSnapshot().status, 'ready')
  assert.equal(f.props().workspaces.getSnapshot().phase, 'ready')
  assert.equal(await f.props().pickDirectory(), '/workspace')
  assert.deepEqual(Array.from((await f.props().loadCatalogs()).errors), [])
})

test('real wire preserves owner-only policy and redacts failed management actions', async (t) => {
  const f = await fixture(t, { actionError: true })
  f.principal({ kind: 'agent', id: 'untrusted' })
  for (const action of ['status', 'connect', 'reauthorize', 'cancelAuthorization']) {
    const result = await f.connection()[action]()
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'remote-access/denied')
  }
  assert.equal(f.actions.length, 0)
  f.principal({ kind: 'owner' })
  const failure = await f.connection().connect()
  assert.equal(failure.ok, false)
  assert.doesNotMatch(failure.error.message, /Bearer|private-token/)
})

test('controller still denies a non-owner when an upstream access policy allows the call', async (t) => {
  const f = await fixture(t, { allowNonOwner: true })
  f.principal({ kind: 'agent', id: 'untrusted' })
  for (const action of ['status', 'connect', 'reauthorize', 'cancelAuthorization']) {
    assert.equal((await f.connection()[action]()).ok, false)
  }
  assert.deepEqual(f.actions, [])
})

test('status AbortSignal reaches the carrier, cancels a pending read, and permits the next read', async (t) => {
  const f = await fixture(t)
  let started
  const ready = new Promise((resolve) => { started = resolve })
  f.gate((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started()
  }))
  const controller = new AbortController()
  const pending = f.connection().status({ signal: controller.signal })
  await ready
  const delivered = f.calls.at(-1)
  assert.deepEqual(delivered.payload, { args: {} })
  controller.abort(new Error('Deadline reached'))
  assert.equal(delivered.signal.aborted, true)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/cancelled')
  f.gate(undefined)
  assert.equal((await f.connection().status()).ok, true)
})

test('wire reports carrier and withdrawn Host failures without mistaking them for a disconnected device', async (t) => {
  const f = await fixture(t)
  f.transportError(new Error('offline'))
  const offline = await f.connection().status()
  assert.equal(offline.ok, false)
  assert.equal(offline.error.code, 'gateway/internal')
  f.transportError(undefined)
  await f.control.dispose()
  const withdrawn = await f.connection().status()
  assert.equal(withdrawn.ok, false)
  assert.equal(withdrawn.error.code, 'gateway/definition-unavailable')
})

test('unloading and reloading the real bundle removes and recreates its namespace and both settings slots', async (t) => {
  const f = await fixture(t)
  const oldConnection = f.connection()
  assert.equal(f.registrations.size, 2)
  assert.equal((await oldConnection.status()).ok, true)
  await f.unload()
  assert.equal(f.registrations.size, 0)
  assert.equal(f.client.get('remote.xbotA2a'), undefined)
  assert.equal(f.client.get('typert').remotes.list().length, 0)
  await assert.rejects(async () => oldConnection.status())
  await f.reload()
  assert.equal(f.registrations.size, 2)
  assert.equal((await f.connection().status()).ok, true)
})


test('strict Host wire output rejects extra secret fields without echoing their values', async (t) => {
  const f = await fixture(t, { extraStatus: { accessToken: 'private-bearer-value' } })
  const result = await f.connection().status()
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /private-bearer-value/)
})


for (const allowNonOwner of [false, true]) {
  test(`update RPC refuses non-owner before updater access (upstream allow=${allowNonOwner})`, async (t) => {
    let accessed = 0
    const f = await fixture(t, {
      allowNonOwner,
      updater: () => { accessed += 1; throw new Error('must not be accessed') },
    })
    f.principal({ kind: 'agent', id: 'untrusted' })
    for (const [method, args] of [['status', []], ['check', []], ['install', ['0.1.11']], ['saveCredential', ['synthetic-token']], ['clearCredential', []]]) {
      const result = await f.updates()[method](...args)
      assert.equal(result.ok, false)
      assert.equal(result.error.code, allowNonOwner ? 'gateway/bad-request' : 'remote-access/denied')
    }
    assert.equal(accessed, 0)
  })
}

test('published update controls use the late Host updater and bind installation to the confirmed version', async (t) => {
  let updater
  const operations = []
  const f = await fixture(t, { updater: () => updater })
  const unavailable = await f.updates().status()
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.error.code, 'gateway/service-unavailable')
  updater = {
    status: () => updateSnapshot,
    check: async () => { operations.push('check'); return updateSnapshot },
    install: async (version) => { operations.push(['install', version]); return { ...updateSnapshot, phase: 'restart_required', restartReason: 'no-hmr', canInstall: false } },
  }
  assert.deepEqual(await f.updates().status(), { ok: true, value: updateSnapshot })
  assert.equal((await f.updates().check()).ok, true)
  const installed = await f.updates().install('0.1.11')
  assert.equal(installed.ok, true)
  assert.equal(installed.value.phase, 'restart_required')
  assert.deepEqual(operations, ['check', ['install', '0.1.11']])
  assert.deepEqual(f.calls.at(-1).payload, { args: { expectedVersion: '0.1.11' } })
  for (const version of [undefined, '', 'latest', 'https://evil.example/package.tgz', '0'.repeat(81)]) {
    const refused = await f.updates().install(version)
    assert.equal(refused.ok, false)
    assert.match(refused.error.code, /^gateway\/(arguments|input)-invalid$/)
  }
  assert.equal(operations.length, 2, 'invalid versions cannot reach the updater')
})

test('update state reads carry cancellation without adding cancellation to install commands', async (t) => {
  const f = await fixture(t, { updater: () => ({ status: () => updateSnapshot }) })
  let started
  const ready = new Promise((resolve) => { started = resolve })
  f.gate((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    started()
  }))
  const controller = new AbortController()
  const pending = f.updates().status({ signal: controller.signal })
  await ready
  controller.abort()
  assert.equal(f.calls.at(-1).signal.aborted, true)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/cancelled')
  f.gate(undefined)
  assert.deepEqual(await f.updates().status(), { ok: true, value: updateSnapshot })
})

test('update RPC redacts factories, action failures, and undeclared output fields', async (t) => {
  let updater
  let factoryFails = true
  const f = await fixture(t, { updater: () => {
    if (factoryFails) throw new Error('Bearer updater-secret')
    return updater
  } })
  for (const [method, args] of [['status', []], ['check', []], ['install', ['0.1.11']], ['saveCredential', ['synthetic-token']], ['clearCredential', []]]) {
    const unavailable = await f.updates()[method](...args)
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.error.code, 'gateway/service-unavailable')
    assert.doesNotMatch(JSON.stringify(unavailable), /updater-secret|Bearer/)
  }
  factoryFails = false
  updater = Object.fromEntries(['status', 'check', 'install', 'setCredential', 'clearCredential'].map((name) => [name, () => {
    throw new Error('Bearer updater-secret')
  }]))
  for (const [method, args] of [['status', []], ['check', []], ['install', ['0.1.11']], ['saveCredential', ['synthetic-token']], ['clearCredential', []]]) {
    const failure = await f.updates()[method](...args)
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'gateway/internal')
    assert.doesNotMatch(JSON.stringify(failure), /updater-secret|Bearer/)
  }
  updater.status = () => ({ ...updateSnapshot, accessToken: 'updater-secret' })
  const malformed = await f.updates().status()
  assert.equal(malformed.ok, false)
  assert.doesNotMatch(JSON.stringify(malformed), /updater-secret/)
})


test('credential RPC validates and trims owner input while returning only public status', async (t) => {
  const stored = []
  let hasCredential = false
  const current = () => ({ ...updateSnapshot, hasCredential })
  const f = await fixture(t, { updater: () => ({
    status: current,
    setCredential: async (token) => { stored.push(token); hasCredential = true; return current() },
    clearCredential: async () => { hasCredential = false; return current() },
  }) })
  const saved = await f.updates().saveCredential('  synthetic-private-pat  ')
  assert.deepEqual(stored, ['synthetic-private-pat'])
  assert.equal(saved.ok, true)
  assert.equal(saved.value.hasCredential, true)
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-private-pat/)
  for (const token of [undefined, '', '   ', 'synthetic-private-pat\nembedded', 'synthetic-private-pat token', '秘钥', 's'.repeat(4097)]) {
    const refused = await f.updates().saveCredential(token)
    assert.equal(refused.ok, false)
    assert.match(refused.error.code, /^gateway\/(arguments|input)-invalid$/)
    assert.doesNotMatch(JSON.stringify(refused), /synthetic-private-pat|秘钥|ssssssss/)
  }
  assert.equal(stored.length, 1, 'invalid credentials must not be stored or retried')
  const cleared = await f.updates().clearCredential()
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.hasCredential, false)
  assert.deepEqual(f.calls.at(-1).payload, { args: {} })
})
