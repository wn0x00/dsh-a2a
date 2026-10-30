import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAutomaticUpdates, AUTO_UPDATE_INTERVAL_MS } from '../dist/automatic-updates.js'

const initial = { phase: 'idle', currentVersion: '0.2.1', latestVersion: null,
  checkedAt: null, error: null, restartReason: null, canInstall: false }
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-auto-update-'))
  let time = 1000, enabled = false, idle = true
  let snapshot = { ...initial }
  const calls = { check: [], install: [] }
  const base = {
    status: () => ({ ...snapshot, canInstall: snapshot.phase === 'available' && idle }),
    check: async (stableOnly) => {
      calls.check.push(stableOnly)
      await overrides.check?.()
      snapshot = { ...snapshot, phase: 'available', latestVersion: '0.2.2', checkedAt: time, error: null, ...overrides.checked }
      return base.status()
    },
    install: async (version, permitted) => {
      calls.install.push(version)
      await overrides.install?.()
      snapshot = permitted()
        ? { ...snapshot, phase: 'restart_required', restartReason: 'no-hmr', ...overrides.installed }
        : { ...snapshot, phase: 'error', error: 'busy' }
      return base.status()
    },
  }
  const options = { storageDirectory: directory, enabled: () => enabled, now: () => time }
  let auto = createAutomaticUpdates(base, options)
  t.after(async () => { auto.stop(); await rm(directory, { recursive: true, force: true }) })
  return { calls, base, get auto() { return auto },
    enable(value = true) { enabled = value },
    idle(value) { idle = value },
    advance(value) { time += value },
    state(value) { snapshot = { ...snapshot, ...value } },
    restart() { auto.stop(); snapshot = { ...initial }; auto = createAutomaticUpdates(base, options) },
  }
}
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('automatic updates are opt-in, check stable releases daily, and retain the schedule across restart', async t => {
  const f = await fixture(t, { checked: { phase: 'current', latestVersion: null } })
  await f.auto.tick()
  assert.equal(f.calls.check.length, 0)
  f.enable()
  await f.auto.tick()
  assert.deepEqual(f.calls.check, [true])
  assert.equal(f.auto.updater.status().automatic.nextCheckAt, 1000 + AUTO_UPDATE_INTERVAL_MS)
  f.restart()
  f.advance(AUTO_UPDATE_INTERVAL_MS - 1)
  await f.auto.tick()
  assert.equal(f.calls.check.length, 1)
  f.advance(1)
  await f.auto.tick()
  assert.equal(f.calls.check.length, 2)
  assert.equal(f.calls.install.length, 0)
})

test('a new version installs silently only after the Host becomes idle, without another registry check', async t => {
  const f = await fixture(t)
  f.enable(); f.idle(false)
  await f.auto.tick()
  assert.equal(f.calls.install.length, 0)
  const notice = f.auto.updater.status().automatic.notice
  assert.equal(notice.kind, 'available')
  await f.auto.tick()
  assert.equal(f.auto.updater.status().automatic.notice.id, notice.id)
  f.idle(true)
  await f.auto.tick()
  assert.deepEqual(f.calls.install, ['0.2.2'])
  assert.equal(f.calls.check.length, 1)
  assert.equal(f.auto.updater.status().automatic.notice.kind, 'restart_required')
  f.advance(AUTO_UPDATE_INTERVAL_MS)
  await f.auto.tick()
  assert.equal(f.calls.install.length, 1)
})

test('overlapping timer/configuration ticks share one check and one install', async t => {
  const waiting = deferred()
  const f = await fixture(t, { check: () => waiting.promise })
  f.enable()
  const first = f.auto.tick()
  const second = f.auto.tick()
  assert.equal(first, second)
  waiting.resolve()
  await first
  assert.equal(f.calls.check.length, 1)
  assert.equal(f.calls.install.length, 1)
})

test('disabling during a daily check prevents an automatic install', async t => {
  const waiting = deferred()
  const f = await fixture(t, { check: () => waiting.promise })
  f.enable()
  const check = f.auto.tick()
  f.enable(false)
  waiting.resolve()
  await check
  assert.equal(f.calls.install.length, 0)
  assert.equal(f.auto.updater.status().automatic.enabled, false)
  assert.equal(f.auto.updater.status().automatic.nextCheckAt, null)
})

test('disabling during a download revokes the automatic installation guard', async t => {
  const waiting = deferred()
  const f = await fixture(t, { install: () => waiting.promise })
  f.enable()
  const check = f.auto.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.install.length, 1)
  f.enable(false)
  waiting.resolve()
  await check
  assert.equal(f.base.status().error, 'busy')
  assert.notEqual(f.auto.updater.status().automatic.notice?.kind, 'restart_required')
})

test('an accepted installation does not block plugin shutdown or mutate a replacement scheduler', async t => {
  const waiting = deferred()
  const f = await fixture(t, { install: () => waiting.promise })
  f.enable()
  const check = f.auto.tick()
  await new Promise(resolve => setImmediate(resolve))
  f.auto.stop()
  assert.equal(f.auto.stop(), undefined)
  waiting.resolve()
  await check
  assert.equal(f.auto.updater.status().automatic.notice, null)
})

test('ambiguous install results never trigger another automatic installation', async t => {
  const f = await fixture(t, { installed: { phase: 'outcome_unknown', error: 'installation_unknown' } })
  f.enable()
  await f.auto.tick()
  f.advance(AUTO_UPDATE_INTERVAL_MS * 2)
  await f.auto.tick()
  assert.equal(f.calls.install.length, 1)
  assert.equal(f.auto.updater.status().automatic.notice.kind, 'error')
})

test('a failed check reports once and waits a day before retrying, including across restart', async t => {
  const f = await fixture(t, { checked: { phase: 'error', error: 'network', latestVersion: null } })
  f.enable()
  await f.auto.tick()
  const notice = f.auto.updater.status().automatic.notice
  assert.equal(notice.kind, 'error')
  f.restart()
  await f.auto.tick()
  assert.equal(f.calls.check.length, 1)
  assert.equal(f.auto.updater.status().automatic.notice.id, notice.id)
  f.advance(AUTO_UPDATE_INTERVAL_MS)
  await f.auto.tick()
  assert.equal(f.calls.check.length, 2)
  assert.equal(f.calls.install.length, 0)
})

test('a pending idle update can be recovered after restart without losing the reminder', async t => {
  const f = await fixture(t)
  f.enable(); f.idle(false)
  await f.auto.tick()
  f.restart(); f.idle(true)
  await f.auto.tick()
  assert.deepEqual(f.calls.install, ['0.2.2'])
  assert.equal(f.auto.updater.status().automatic.notice.kind, 'restart_required')
})
