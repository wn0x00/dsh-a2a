import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { ConnectionController } from '../dist/connection-control.js'
import { connectionContribution } from '../dist/connection-contract.js'

const updateSnapshot = {
  phase: 'available', currentVersion: '0.1.10', latestVersion: '0.1.11',
  checkedAt: 1, error: null, restartReason: null, canInstall: true, hasCredential: true,
}

const snapshot = {
  phase: 'connected',
  notice: 'none',
  gatewayUrl: 'https://platform.example',
  deviceId: 'test-device',
  deviceName: 'Test device',
  activeTasks: 0,
  pendingExpiresAt: null,
  lastConnectedAt: 1,
  lastContactAt: 2,
  canConnect: false,
  canReauthorize: true,
  canCancelAuthorization: false,
}

test('the real Cordis service derives the caller from its invocation, never method arguments', async (t) => {
  const ctx = new Context()
  const actions = []
  const fork = await ctx.plugin((scope) => {
    new ConnectionController(scope, {
      status: () => snapshot,
      act: async (action) => {
        actions.push(action)
      },
    })
  })
  t.after(() => fork.dispose())
  const owner = ctx
    .extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    .get('xbotA2a')
  assert.deepEqual(owner.status(), snapshot)
  await owner.connect()
  await owner.reauthorize()
  await owner.cancelAuthorization()
  assert.deepEqual(actions, [
    'connect',
    'reauthorize',
    'cancelPendingAuthorization',
  ])
  for (const invocation of [
    undefined,
    { peer: { principal: { kind: 'agent', id: 'untrusted' } } },
  ]) {
    const service = ctx.extend({ invocation }).get('xbotA2a')
    assert.throws(() => service.status(), /local Host owner/)
    assert.throws(() => service.updateStatus(), /local Host owner/)
    for (const method of ['connect', 'reauthorize', 'cancelAuthorization', 'checkUpdate', 'installUpdate', 'setUpdateCredential', 'clearUpdateCredential']) {
      await assert.rejects(
        service[method]({ principal: { kind: 'owner' } }),
        /local Host owner/,
      )
    }
  }
  assert.equal(actions.length, 3)
  const methods = remoteMethods(ctx.get('xbotA2a'))
  assert.deepEqual(methods.map((entry) => entry.method).sort(), [
    'cancelAuthorization',
    'checkUpdate',
    'clearUpdateCredential',
    'connect',
    'installUpdate',
    'reauthorize',
    'setUpdateCredential',
    'status',
    'updateStatus',
  ])
})

test('RPC failures redact arbitrary upstream errors and strict results reject secrets', async (t) => {
  const ctx = new Context()
  const fork = await ctx.plugin((scope) => {
    new ConnectionController(scope, {
      status: () => snapshot,
      act: async () => {
        throw new Error('Bearer private-token')
      },
    })
  })
  t.after(() => fork.dispose())
  const service = ctx
    .extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    .get('xbotA2a')
  await assert.rejects(service.connect(), (error) => {
    assert.equal(error.code, 'gateway/bad-request')
    assert.doesNotMatch(error.message, /private-token|Bearer/)
    return true
  })
  const contract = connectionContribution(z)
  for (const descriptor of contract.descriptors) {
    assert.equal(descriptor.result.mode, 'strict')
    assert.deepEqual(descriptor.parameters.map((parameter) => parameter.wire),
      descriptor.method === 'installUpdate' ? ['expectedVersion']
        : descriptor.method === 'setUpdateCredential' ? ['token'] : [])
    const expected = descriptor.result.typeSymbol.endsWith('#PluginUpdateSnapshot') ? updateSnapshot : snapshot
    assert.deepEqual(descriptor.result.create().parse(expected), expected)
    assert.deepEqual(descriptor.result.encode(expected), expected)
    assert.deepEqual(descriptor.result.decode(expected), expected)
    for (const validate of [descriptor.result.encode, descriptor.result.decode]) {
      assert.throws(() => validate({ ...expected, accessToken: 'secret' }))
    }
    assert.equal(descriptor.cancellation?.parameter,
      ['status', 'updateStatus'].includes(descriptor.method) ? 'signal' : undefined)
  }
  await fork.dispose()
  assert.equal(ctx.get('xbotA2a'), undefined)
})


test('updater is resolved after startup and all failures have bounded public diagnostics', async (t) => {
  const ctx = new Context()
  let updater
  const operations = []
  const fork = await ctx.plugin((scope) => {
    new ConnectionController(scope, {
      status: () => snapshot, act: async () => {},
      updater: () => updater,
    })
  })
  t.after(() => fork.dispose())
  const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } }).get('xbotA2a')
  assert.throws(() => owner.updateStatus(), (error) => error.code === 'gateway/service-unavailable')
  for (const method of ['checkUpdate', 'installUpdate', 'setUpdateCredential', 'clearUpdateCredential']) {
    await assert.rejects(owner[method](), (error) => error.code === 'gateway/service-unavailable')
  }
  updater = {
    status: () => updateSnapshot,
    check: async () => { operations.push('check'); return updateSnapshot },
    install: async (version) => { operations.push(['install', version]); return updateSnapshot },
    setCredential: async () => updateSnapshot, clearCredential: async () => updateSnapshot,
  }
  assert.deepEqual(owner.updateStatus(), updateSnapshot)
  assert.deepEqual(await owner.checkUpdate(), updateSnapshot)
  assert.deepEqual(await owner.installUpdate('0.1.11'), updateSnapshot)
  assert.deepEqual(operations, ['check', ['install', '0.1.11']])
  const aborted = AbortSignal.abort(new Error('aborted read'))
  assert.throws(() => owner.updateStatus(aborted), /aborted read/)
  for (const name of ['status', 'check', 'install', 'setCredential', 'clearCredential']) {
    updater[name] = () => { throw new Error('Bearer updater-secret') }
  }
  for (const method of ['updateStatus', 'checkUpdate', 'installUpdate', 'setUpdateCredential', 'clearUpdateCredential']) {
    await assert.rejects(async () => owner[method](), (error) => {
      assert.equal(error.code, 'gateway/internal')
      assert.doesNotMatch(error.message, /Bearer|updater-secret/)
      return true
    })
  }
})
