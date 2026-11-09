import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Bridge from '../dist/index.js'
import { installWorkspaceSettings } from '../dist/workspace-settings.js'

// Use the real dispatcher: Cordis 4.0 binds the fiber as `this`, while 4.1
// passes it as the first argument with a null receiver. Mocks missed this
// startup crash when another Host plugin resolved its configuration.
test('Host can load and update other plugins after the A2A config hook starts', async (t) => {
  const ctx = new Context()
  const forks = []
  t.after(async () => {
    for (const fork of forks.reverse()) await fork.dispose()
  })
  let bridgeConfig
  const bridge = await ctx.plugin({
    name: 'a2a-config-hook',
    apply(scope, config) {
      bridgeConfig = config
      installWorkspaceSettings(scope, config)
    },
  }, {})
  forks.push(bridge)
  const foreign = { gatewayUrl: 'not a platform URL', provider: 'foreign-provider', model: '' }
  let applied
  const other = await ctx.plugin({
    name: 'another-host-plugin',
    apply(_scope, config) { applied = config },
  }, foreign)
  forks.push(other)
  assert.deepEqual(applied, foreign, 'foreign configuration must stay untouched')
  await other.update({ ...foreign, gatewayUrl: 'still not a platform URL' })
  await other.await() // Cordis 4.0 update() returns before its restart settles.
  assert.equal(applied.gatewayUrl, 'still not a platform URL')

  // Own invalid edits must still be rejected; merely swallowing the null
  // receiver would disable validation on the new Host.
  assert.throws(() => bridge.update({ provider: 'incomplete', model: '' }), /完整的模型/)
  assert.throws(() => bridge.update({ gatewayUrl: 'http://platform.example' }), /平台地址/)
  assert.throws(() => bridge.update({ workingDirectory: 'relative-folder' }), /工作目录/)
  await bridge.update({ gatewayUrl: 'https://Platform.Example/' })
  await bridge.await()
  assert.equal(bridgeConfig.gatewayUrl, 'https://platform.example')
  await other.update(foreign)
  await other.await()
  assert.deepEqual(applied, foreign, 'reloading the hook must remain isolated')
})

for (const receiver of [null, undefined]) {
  test(`config hook handles a ${receiver} receiver, traced fibers and missing targets`, () => {
    let hook
    const own = { uid: 42 }
    installWorkspaceSettings({ fiber: own, on(_event, callback) { hook = callback } }, {})
    const invalid = { provider: 'incomplete', model: '' }
    for (const target of [own, { uid: 42 }]) {
      assert.throws(() => hook.call(receiver, target, () => invalid), /完整的模型/)
    }
    for (const target of [null, undefined, {}, { uid: 43 }, { uid: null }]) {
      let calls = 0
      assert.equal(hook.call(receiver, target, () => { calls++; return invalid }), invalid)
      assert.equal(calls, 1, 'must continue the Host config waterfall exactly once')
    }
    const failure = new Error('Host schema validation failed')
    assert.throws(() => hook.call(receiver, own, () => { throw failure }), error => error === failure)
  })
}

test('legacy receiver takes precedence over configuration fields named uid', () => {
  let hook
  installWorkspaceSettings({ fiber: { uid: 42 }, on(_event, callback) { hook = callback } }, {})
  const foreign = { uid: 42, provider: 'foreign-provider', model: '' }
  assert.equal(hook.call({ uid: 43 }, foreign, () => foreign), foreign)
})

test('published Host entry starts, permits later plugin loading, and unloads cleanly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-a2a-host-startup-'))
  const ctx = new Context()
  const forks = []
  t.after(async () => {
    try {
      for (const fork of forks.reverse()) await fork.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  forks.push(await ctx.plugin(TypertRegistry))
  forks.push(await ctx.plugin({ name: 'idle-host-services', apply(scope) {
    for (const name of Bridge.inject) scope.provide(name, {})
  } }))
  const bridge = await ctx.plugin(Bridge, { storageDirectory: directory })
  forks.push(bridge)
  assert.ok(ctx.get('dshA2a'), 'management service should be available without authorization')
  let loaded = false
  forks.push(await ctx.plugin({ name: 'later-host-plugin', apply() { loaded = true } }, {
    provider: 'another-plugin', model: '', workingDirectory: 'relative-foreign-path',
  }))
  assert.equal(loaded, true)
  await bridge.dispose()
  assert.equal(ctx.get('dshA2a'), undefined)
})
