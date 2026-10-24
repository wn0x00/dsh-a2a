import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { ConnectionController } from '../dist/connection-control.js'
import { connectionContribution } from '../dist/connection-contract.js'

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
    for (const method of ['connect', 'reauthorize', 'cancelAuthorization']) {
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
    'connect',
    'reauthorize',
    'status',
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
    assert.deepEqual(descriptor.parameters, [])
    assert.deepEqual(descriptor.result.create().parse(snapshot), snapshot)
    assert.throws(() =>
      descriptor.result.create().parse({ ...snapshot, accessToken: 'secret' }),
    )
  }
  await fork.dispose()
  assert.equal(ctx.get('xbotA2a'), undefined)
})
