import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { createPluginUpdater, comparePluginVersions, UPDATE_METADATA_URL, UPDATE_PACKAGE } from '../dist/plugin-update.js'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const tarballFor = (version) => `${REGISTRY_ORIGIN}/${UPDATE_PACKAGE}/-/dsh-a2a-${version}.tgz`
const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

function archive(version = '0.2.1', name = UPDATE_PACKAGE, entry = 'package/package.json') {
  const data = Buffer.from(JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const header = Buffer.alloc(512)
  header.write(entry)
  header.write('0000600\0', 100)
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  header.fill(32, 148, 156)
  header[156] = 48
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length + 1024)]))
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-a2a-update-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = overrides.bytes ?? archive()
  const listedVersion = overrides.version ?? '0.2.1'
  const integrity = overrides.integrity ?? sha512(bytes)
  const tarball = overrides.tarball ?? tarballFor(listedVersion)
  const metadata = 'metadata' in overrides ? overrides.metadata : {
    name: UPDATE_PACKAGE,
    'dist-tags': { latest: listedVersion },
    versions: {
      [listedVersion]: { name: UPDATE_PACKAGE, version: listedVersion, dist: { tarball, integrity } },
    },
  }
  const calls = []
  const installs = []
  let allowed = true, locked = false, releaseCount = 0
  let bundles = [{ name: UPDATE_PACKAGE, version: '0.2.0', enabled: true, installed: true, availability: 'profile' }]
  const manager = {
    listBundles: async () => bundles,
    installBundle: async (spec, options) => {
      assert.equal(locked, true)
      installs.push({ spec, options })
      return overrides.result ?? { application: 'restart-required', bundle: UPDATE_PACKAGE, version: listedVersion, restartReason: 'no-hmr' }
    },
    ...overrides.manager,
  }
  const options = {
    currentVersion: '0.2.0', storageDirectory: directory, manager: () => manager,
    canInstall: () => allowed,
    acquireInstallLock: async () => { locked = true; return async () => { locked = false; releaseCount++ } },
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url === UPDATE_METADATA_URL) return Response.json(metadata)
      assert.equal(locked, true)
      return new Response(bytes)
    },
    ...overrides.options,
  }
  return { updater: createPluginUpdater(options), options, directory, bytes, metadata, integrity, calls, installs, listedVersion,
    setAllowed: value => { allowed = value }, setBundles: value => { bundles = value }, releaseCount: () => releaseCount }
}

test('SemVer order handles numeric prerelease and ignores build metadata', () => {
  assert.equal(comparePluginVersions('0.2.0', '0.1.9'), 1)
  assert.equal(comparePluginVersions('0.2.0+build.2', '0.2.0+build.1'), 0)
  assert.equal(comparePluginVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1)
  assert.equal(comparePluginVersions('1.0.0', '1.0.0-rc.2'), 1)
  assert.equal(comparePluginVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  for (const version of ['01.0.0', 'v1.0.0', '1.0', '1.0.0-01', '1.0.0/evil']) {
    assert.throws(() => comparePluginVersions(version, '1.0.0'))
  }
})

test('explicit check then native install uses the verified registry file and preserves identity/config', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'identity.json'), 'same-device')
  await writeFile(join(f.directory, 'credentials.json'), 'same-token')
  await writeFile(join(f.directory, 'settings.json'), 'same-directory')
  assert.equal(f.calls.length, 0)
  assert.equal((await f.updater.check()).canInstall, true)
  assert.equal((await f.updater.install('0.2.1')).phase, 'restart_required')
  assert.equal(f.installs.length, 1)
  assert.equal(f.calls[0].url, UPDATE_METADATA_URL)
  assert.equal(f.calls[1].url, tarballFor('0.2.1'))
  for (const call of f.calls) {
    assert.equal(call.init.redirect, 'error')
    assert.equal(new Headers(call.init.headers).get('Authorization'), null)
    assert.equal(call.init.method, 'GET')
    assert.equal(new URL(call.url).origin, REGISTRY_ORIGIN)
  }
  assert.equal(new Headers(f.calls[0].init.headers).get('Accept'), 'application/vnd.npm.install-v1+json')
  const { spec, options } = f.installs[0]
  assert.deepEqual(Object.keys(options).sort(), ['enabled', 'requestId', 'saveExact'])
  assert.equal(options.enabled, true)
  assert.deepEqual(await readFile(spec), f.bytes)
  const receipt = JSON.parse(await readFile(join(f.directory, 'updates', 'last-update.json')))
  assert.equal(receipt.phase, 'restart_required')
  assert.equal(receipt.integrity, f.integrity)
  for (const [name, expected] of [['identity.json', 'same-device'], ['credentials.json', 'same-token'], ['settings.json', 'same-directory']]) {
    assert.equal(await readFile(join(f.directory, name), 'utf8'), expected)
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(spec)).mode & 0o777, 0o600)
    assert.equal((await stat(join(f.directory, 'updates'))).mode & 0o777, 0o700)
  }
  assert.equal(f.releaseCount(), 1)
  assert.equal((await f.updater.install('0.2.1')).phase, 'restart_required')
  assert.equal(f.installs.length, 1)
})

test('same version and downgrade never enable installation', async t => {
  for (const version of ['0.2.0', '0.1.9', '0.2.0+newbuild']) {
    const f = await fixture(t, { version })
    assert.equal((await f.updater.check()).phase, 'current')
    await f.updater.install(version)
    assert.equal(f.installs.length, 0)
  }
})

test('an empty registry document means no release is available', async t => {
  const f = await fixture(t, { metadata: { name: UPDATE_PACKAGE, versions: {} } })
  const result = await f.updater.check()
  assert.equal(result.phase, 'current')
  assert.equal(result.latestVersion, null)
  assert.equal(result.error, null)
  assert.equal(result.canInstall, false)
  assert.equal(f.calls.length, 1)
})

test('malformed registry metadata, tarball origins, paths and integrity are refused', async t => {
  for (const overrides of [
    { metadata: null },
    { metadata: { name: UPDATE_PACKAGE } },
    { metadata: { name: UPDATE_PACKAGE, versions: ['0.2.1'] } },
    { integrity: 'sha256-deadbeef' },
    { tarball: `https://evil.invalid/${UPDATE_PACKAGE}/-/dsh-a2a-0.2.1.tgz` },
    { tarball: `${REGISTRY_ORIGIN}/@evil/other/-/dsh-a2a-0.2.1.tgz` },
    { tarball: `${REGISTRY_ORIGIN}/${UPDATE_PACKAGE}/-/other-0.2.1.tgz` },
    { tarball: `${REGISTRY_ORIGIN}/${UPDATE_PACKAGE}/-/dsh-a2a-0.2.1.tgz?token=x` },
  ]) {
    const f = await fixture(t, overrides)
    assert.equal((await f.updater.check()).error, 'invalid_manifest')
    await f.updater.install('0.2.1')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].url, UPDATE_METADATA_URL)
    assert.equal(f.installs.length, 0)
  }
})

test('registry version selection skips invalid versions and picks the highest strict SemVer', async t => {
  const f = await fixture(t)
  f.options.fetch = async (url) => {
    assert.equal(url, UPDATE_METADATA_URL)
    return Response.json({
      name: UPDATE_PACKAGE,
      versions: {
        'v99.0.0': { dist: { tarball: tarballFor('99.0.0'), integrity: sha512(f.bytes) } },
        '0.1.9': { dist: { tarball: tarballFor('0.1.9'), integrity: sha512(f.bytes) } },
        '0.2.1-rc.2': { dist: { tarball: tarballFor('0.2.1-rc.2'), integrity: sha512(f.bytes) } },
        '0.2.1': { dist: { tarball: tarballFor('0.2.1'), integrity: sha512(f.bytes) } },
      },
    })
  }
  const updater = createPluginUpdater(f.options)
  const result = await updater.check()
  assert.equal(result.latestVersion, '0.2.1')
  assert.equal(result.phase, 'available')
})

test('registry metadata cannot redirect the tarball to another host', async t => {
  const calls = []
  const f = await fixture(t, {
    options: { fetch: async (url, init) => { calls.push({ url, init }); return Response.json({
      name: UPDATE_PACKAGE,
      versions: { '0.2.1': { dist: { tarball: 'https://evil.invalid/package.tgz', integrity: sha512(archive()) } } },
    }) } },
  })
  const result = await f.updater.check()
  assert.equal(result.error, 'invalid_manifest')
  assert.equal(calls.length, 1)
  assert.equal(calls.some(call => call.url.includes('evil.invalid')), false)
})

test('archive integrity and inner identity are checked before native installation', async t => {
  for (const [overrides, expected] of [
    [{ integrity: sha512(Buffer.from('other bytes')) }, 'integrity'],
    [{ bytes: archive('0.2.1', '@other/package') }, 'invalid_package'],
    [{ bytes: archive('0.2.2') }, 'invalid_package'],
    [{ bytes: archive('0.2.1', UPDATE_PACKAGE, '../package/package.json') }, 'invalid_package'],
    [{ bytes: Buffer.from('not a gzip archive') }, 'invalid_package'],
  ]) {
    const f = await fixture(t, overrides)
    await f.updater.check()
    assert.equal((await f.updater.install('0.2.1')).error, expected)
    assert.equal(f.installs.length, 0)
    assert.equal(f.releaseCount(), 1)
  }
})

test('redirects, oversized response and hung network are bounded without exposing diagnostics', async t => {
  for (const response of [
    async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    async () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    async () => { throw new Error('secret query token=secret') },
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const f = await fixture(t, { options: { fetch: response, requestTimeoutMs: 30 } })
    const value = await f.updater.check()
    assert.equal(value.phase, 'error')
    assert.equal(JSON.stringify(value).includes('secret'), false)
    assert.equal(f.installs.length, 0)
  }
})

test('registry reads reject redirected or relocated responses without following them', async t => {
  for (const responseFactory of [
    () => new Response(null, { status: 307, headers: { location: 'https://other.invalid/?secret=do-not-follow' } }),
    () => { const response = Response.json({ versions: {} }); Object.defineProperty(response, 'url', { value: 'https://other.invalid/@guanzhu.me/dsh-a2a' }); return response },
    () => { const response = Response.json({ versions: {} }); Object.defineProperty(response, 'redirected', { value: true }); return response },
  ]) {
    const calls = []
    const f = await fixture(t, { options: { fetch: async (url, init) => {
      calls.push({ url, init }); return responseFactory()
    } } })
    const result = await f.updater.check()
    assert.equal(result.error, 'network')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, UPDATE_METADATA_URL)
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.redirect, 'error')
  }
})

test('busy tasks reject before download; lock prevents new tasks during installation', async t => {
  const f = await fixture(t)
  await f.updater.check()
  f.setAllowed(false)
  assert.equal(f.updater.status().canInstall, false)
  assert.equal((await f.updater.install('0.2.1')).error, 'busy')
  assert.equal(f.calls.length, 1)
  assert.equal(f.releaseCount(), 0)
  f.setAllowed(true)
  assert.equal((await f.updater.install('0.2.1')).phase, 'restart_required')
})

test('task arriving while acquiring lock or reading bundle prevents host mutation', async t => {
  const f = await fixture(t)
  f.options.acquireInstallLock = async () => { f.setAllowed(false); return async () => {} }
  await f.updater.check()
  assert.equal((await f.updater.install('0.2.1')).error, 'busy')
  assert.equal(f.installs.length, 0)
})

test('host refusal never falls back to uninstall, npm, or build-script approval', async t => {
  const f = await fixture(t, { result: { application: 'failed', error: { code: 'already-installed' } } })
  await f.updater.check()
  const result = await f.updater.install('0.2.1')
  assert.equal(result.error, 'host_refused')
  assert.equal(f.installs.length, 1)
  assert.equal(f.releaseCount(), 1)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates', 'last-update.json'))).phase, 'failed')
})

test('unknown response survives plugin reload and cannot be installed twice', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('connection lost') } } })
  await f.updater.check()
  assert.equal((await f.updater.install('0.2.1')).phase, 'outcome_unknown')
  const afterReload = createPluginUpdater(f.options)
  assert.equal(afterReload.status().phase, 'outcome_unknown')
  const count = f.calls.length
  assert.equal((await afterReload.install('0.2.1')).phase, 'outcome_unknown')
  assert.equal((await afterReload.check()).phase, 'outcome_unknown')
  assert.equal(f.calls.length, count)
  f.setBundles([{ name: UPDATE_PACKAGE, version: '0.2.1', enabled: true, installed: true, availability: 'profile' }])
  assert.equal((await afterReload.check()).phase, 'restart_required')
  const restarted = createPluginUpdater({ ...f.options, currentVersion: '0.2.1' })
  assert.equal(restarted.status().phase, 'updated')
})

test('unknown outcome remains protected if host inspection fails or receipt is unreadable', async t => {
  const f = await fixture(t)
  await mkdir(join(f.directory, 'updates'))
  await writeFile(join(f.directory, 'updates', 'last-update.json'), '{invalid')
  const updater = createPluginUpdater(f.options)
  assert.equal(updater.status().phase, 'outcome_unknown')
  assert.equal((await updater.check()).phase, 'outcome_unknown')
  assert.equal((await updater.install('0.2.1')).phase, 'outcome_unknown')
  assert.equal(f.calls.length, 0)
})

test('only a matching native result is success; restart reasons are bounded', async t => {
  for (const application of ['applied', 'restart-required', 'overridden']) {
    const f = await fixture(t, { result: { application, bundle: UPDATE_PACKAGE, version: '0.2.1', restartReason: 'secret=unsafe' } })
    await f.updater.check()
    const result = await f.updater.install('0.2.1')
    assert.equal(result.phase, application === 'applied' ? 'updated' : application === 'restart-required' ? 'restart_required' : 'outcome_unknown')
    assert.equal(result.restartReason, null)
  }
})

test('frozen registry selection determines installation even if metadata changes', async t => {
  const f = await fixture(t)
  await f.updater.check()
  f.metadata.versions['0.2.99'] = { name: UPDATE_PACKAGE, version: '0.2.99', dist: { tarball: tarballFor('0.2.99'), integrity: sha512(f.bytes) } }
  const result = await f.updater.install('0.2.1')
  assert.equal(result.latestVersion, '0.2.1')
  assert.ok(f.installs[0].spec.endsWith('0.2.1.tgz'))
  assert.equal(f.calls.length, 2)
})

test('installed disabled selection is retained and missing or installation-owned bundle refuses', async t => {
  for (const availability of ['profile', 'installation', 'missing']) {
    const f = await fixture(t)
    f.setBundles([{ name: UPDATE_PACKAGE, version: '0.2.0', enabled: false, installed: true, availability }])
    await f.updater.check()
    const result = await f.updater.install('0.2.1')
    if (availability === 'profile') assert.equal(f.installs[0].options.enabled, false)
    else { assert.equal(result.error, 'host_unavailable'); assert.equal(f.installs.length, 0) }
  }
})

test('installation is bound to the version the user confirmed', async t => {
  const f = await fixture(t)
  await f.updater.check()
  assert.equal((await f.updater.install('0.2.2')).error, 'update_changed')
  assert.equal(f.calls.length, 1)
  assert.equal(f.installs.length, 0)
  assert.equal((await f.updater.install('0.2.1')).phase, 'restart_required')
})

test('reloaded updater joins the active native task before interpreting installed metadata', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('response lost') } } })
  await f.updater.check()
  await f.updater.install('0.2.1')
  let settle
  const active = new Promise(resolve => { settle = resolve })
  const manager = f.options.manager()
  const requests = []
  manager.waitForInstall = id => { requests.push(id); return active }
  manager.listBundles = () => { throw new Error('must not inspect uncommitted package') }
  const updater = createPluginUpdater(f.options)
  const recovery = updater.check()
  assert.equal(updater.status().phase, 'outcome_unknown')
  assert.equal(updater.status().canInstall, false)
  settle({ application: 'restart-required', bundle: UPDATE_PACKAGE, version: '0.2.1', restartReason: 'package-moved' })
  assert.equal((await recovery).phase, 'restart_required')
  assert.equal(requests.length, 1)
  assert.equal(updater.status().restartReason, 'package-moved')
})

test('native recovery rejection cannot reopen installation after a lost response', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('response lost') } } })
  await f.updater.check()
  await f.updater.install('0.2.1')
  f.options.manager().waitForInstall = async () => { throw new Error('still disconnected') }
  const updater = createPluginUpdater(f.options)
  assert.equal((await updater.check()).phase, 'outcome_unknown')
  assert.equal((await updater.install('0.2.1')).phase, 'outcome_unknown')
  assert.equal(f.calls.length, 2)
})

test('duplicate install/check calls cannot change an in-flight confirmed package', async t => {
  let settle
  const active = new Promise(resolve => { settle = resolve })
  let started
  const start = new Promise(resolve => { started = resolve })
  let installCount = 0
  const f = await fixture(t, { manager: { installBundle: async () => { installCount++; started(); return active } } })
  await f.updater.check()
  const installation = f.updater.install('0.2.1')
  await start
  assert.equal((await f.updater.install('0.2.1')).phase, 'installing')
  assert.equal((await f.updater.check()).phase, 'installing')
  assert.equal(f.calls.length, 2)
  assert.equal(installCount, 1)
  settle({ application: 'applied', bundle: UPDATE_PACKAGE, version: '0.2.1' })
  assert.equal((await installation).phase, 'updated')
})

test('disposal while writing receipt prevents handoff to native installation', async t => {
  const f = await fixture(t)
  await f.updater.check()
  f.options.canInstall = () => !existsSync(join(f.directory, 'updates', 'last-update.json'))
  const result = await f.updater.install('0.2.1')
  assert.equal(result.error, 'busy')
  assert.equal(f.installs.length, 0)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates', 'last-update.json'))).phase, 'failed')
})
