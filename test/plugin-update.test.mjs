import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { createPluginUpdater, comparePluginVersions, UPDATE_BASE_URL, UPDATE_LIST_URL, UPDATE_PACKAGE } from '../dist/plugin-update.js'
import { PersistentTokenStore } from '../dist/token-store.js'

function archive(version = '0.1.11', name = UPDATE_PACKAGE, entry = 'package/package.json') {
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
  const directory = await mkdtemp(join(tmpdir(), 'xbot-update-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bytes = overrides.bytes ?? archive()
  const manifest = { package: UPDATE_PACKAGE, version: '0.1.11', filename: 'xbot-deepseek-harness-a2a-0.1.11.tgz',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), generatedAt: '2026-10-24T00:00:00Z', ...overrides.manifest }
  const tokenStore = new PersistentTokenStore(join(directory, 'gitea-updater'))
  if (overrides.credential !== false) await tokenStore.set({ accessToken: 'fixture-read-only-secret', expiresAt: Number.MAX_SAFE_INTEGER })
  let listedVersion = manifest.version
  try { comparePluginVersions(listedVersion, '0.0.0') } catch { listedVersion = '0.1.11' }
  const records = overrides.records ?? [{ name: 'deepseek-harness-a2a', type: 'generic', version: listedVersion }]
  const calls = []
  const installs = []
  let allowed = true, locked = false, releaseCount = 0
  let bundles = [{ name: UPDATE_PACKAGE, version: '0.1.10', enabled: true, installed: true, availability: 'profile' }]
  const manager = {
    listBundles: async () => bundles,
    installBundle: async (spec, options) => {
      assert.equal(locked, true)
      installs.push({ spec, options })
      return overrides.result ?? { application: 'restart-required', bundle: UPDATE_PACKAGE, version: '0.1.11', restartReason: 'no-hmr' }
    },
    ...overrides.manager,
  }
  const options = {
    currentVersion: '0.1.10', storageDirectory: directory, manager: () => manager,
    canInstall: () => allowed,
    acquireInstallLock: async () => { locked = true; return async () => { locked = false; releaseCount++ } },
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith(UPDATE_LIST_URL)) return Response.json(url.endsWith('page=1') ? records : [])
      if (url.endsWith('.json')) return Response.json(manifest)
      assert.equal(locked, true)
      return new Response(bytes)
    },
    ...overrides.options,
  }
  return { updater: createPluginUpdater(options), options, directory, bytes, manifest, calls, installs, tokenStore, records,
    setAllowed: value => { allowed = value }, setBundles: value => { bundles = value }, releaseCount: () => releaseCount }
}

test('SemVer order handles numeric prerelease and ignores build metadata', () => {
  assert.equal(comparePluginVersions('0.1.10', '0.1.9'), 1)
  assert.equal(comparePluginVersions('0.1.10+build.2', '0.1.10+build.1'), 0)
  assert.equal(comparePluginVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1)
  assert.equal(comparePluginVersions('1.0.0', '1.0.0-rc.2'), 1)
  assert.equal(comparePluginVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  for (const version of ['01.0.0', 'v1.0.0', '1.0', '1.0.0-01', '1.0.0/evil']) {
    assert.throws(() => comparePluginVersions(version, '1.0.0'))
  }
})

test('explicit check then native install uses verified stable file and preserves identity/config', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'identity.json'), 'same-device')
  await writeFile(join(f.directory, 'credentials.json'), 'same-token')
  await writeFile(join(f.directory, 'settings.json'), 'same-directory')
  assert.equal(f.calls.length, 0)
  assert.equal((await f.updater.check()).canInstall, true)
  assert.equal((await f.updater.install('0.1.11')).phase, 'restart_required')
  assert.equal(f.installs.length, 1)
  assert.equal(f.calls[0].url, `${UPDATE_LIST_URL}&page=1`)
  assert.equal(f.calls[2].url, `${UPDATE_BASE_URL}0.1.11/release-manifest.json`)
  assert.equal(f.calls[3].url, `${UPDATE_BASE_URL}0.1.11/${f.manifest.filename}`)
  for (const call of f.calls) {
    assert.equal(call.init.redirect, 'error')
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'token fixture-read-only-secret')
    assert.equal(call.init.method, 'GET')
    assert.equal(new URL(call.url).origin, 'https://gitea.guanzhu.me')
  }
  const { spec, options } = f.installs[0]
  assert.deepEqual(Object.keys(options).sort(), ['enabled', 'requestId', 'saveExact'])
  assert.equal(options.enabled, true)
  assert.deepEqual(await readFile(spec), f.bytes)
  const receipt = JSON.parse(await readFile(join(f.directory, 'updates', 'last-update.json')))
  assert.equal(receipt.phase, 'restart_required')
  assert.equal(receipt.sha256, f.manifest.sha256)
  for (const [name, expected] of [['identity.json', 'same-device'], ['credentials.json', 'same-token'], ['settings.json', 'same-directory']]) {
    assert.equal(await readFile(join(f.directory, name), 'utf8'), expected)
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(spec)).mode & 0o777, 0o600)
    assert.equal((await stat(join(f.directory, 'updates'))).mode & 0o777, 0o700)
  }
  assert.equal(f.releaseCount(), 1)
  assert.equal((await f.updater.install('0.1.11')).phase, 'restart_required')
  assert.equal(f.installs.length, 1)
})

test('same version and downgrade never enable installation', async t => {
  for (const version of ['0.1.10', '0.1.9', '0.1.10+newbuild']) {
    const f = await fixture(t, { manifest: { version, filename: `xbot-deepseek-harness-a2a-${version}.tgz` } })
    assert.equal((await f.updater.check()).phase, 'current')
    await f.updater.install('0.1.11')
    assert.equal(f.installs.length, 0)
  }
})

test('invalid manifest source, package, path, size, version and additional fields are refused', async t => {
  for (const manifest of [
    { package: '@evil/plugin' }, { filename: '../plugin.tgz' }, { version: '0.01.11' },
    { size: 8 * 1024 * 1024 + 1 }, { size: -1 }, { sha256: 'ff' },
    { url: 'https://evil.invalid/plugin.tgz' }, { generatedAt: 'tomorrow' },
  ]) {
    const f = await fixture(t, { manifest })
    assert.equal((await f.updater.check()).error, 'invalid_manifest')
    await f.updater.install('0.1.11')
    assert.equal(f.calls.length, 3)
    assert.equal(f.installs.length, 0)
  }
})

test('archive digest/size and inner identity are checked before native installation', async t => {
  for (const [overrides, expected] of [
    [{ manifest: { sha256: 'a'.repeat(64) } }, 'integrity'],
    [{ manifest: { size: 1 } }, 'integrity'],
    [{ bytes: archive('0.1.11', '@other/package') }, 'invalid_package'],
    [{ bytes: archive('0.1.12') }, 'invalid_package'],
    [{ bytes: archive('0.1.11', UPDATE_PACKAGE, '../package/package.json') }, 'invalid_package'],
    [{ bytes: Buffer.from('not a gzip archive') }, 'invalid_package'],
  ]) {
    const f = await fixture(t, overrides)
    await f.updater.check()
    assert.equal((await f.updater.install('0.1.11')).error, expected)
    assert.equal(f.installs.length, 0)
    assert.equal(f.releaseCount(), 1)
  }
})

test('redirects, oversized response and hung network are bounded without exposing diagnostics', async t => {
  for (const response of [
    async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    async () => new Response('x', { headers: { 'content-length': '20000' } }),
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

test('busy tasks reject before download; lock prevents new tasks during installation', async t => {
  const f = await fixture(t)
  await f.updater.check()
  f.setAllowed(false)
  assert.equal(f.updater.status().canInstall, false)
  assert.equal((await f.updater.install('0.1.11')).error, 'busy')
  assert.equal(f.calls.length, 3)
  assert.equal(f.releaseCount(), 0)
  f.setAllowed(true)
  assert.equal((await f.updater.install('0.1.11')).phase, 'restart_required')
})

test('task arriving while acquiring lock or reading bundle prevents host mutation', async t => {
  const f = await fixture(t)
  f.options.acquireInstallLock = async () => { f.setAllowed(false); return async () => {} }
  await f.updater.check()
  assert.equal((await f.updater.install('0.1.11')).error, 'busy')
  assert.equal(f.installs.length, 0)
})

test('host refusal never falls back to uninstall, npm, or build-script approval', async t => {
  const f = await fixture(t, { result: { application: 'failed', error: { code: 'already-installed' } } })
  await f.updater.check()
  const result = await f.updater.install('0.1.11')
  assert.equal(result.error, 'host_refused')
  assert.equal(f.installs.length, 1)
  assert.equal(f.releaseCount(), 1)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates', 'last-update.json'))).phase, 'failed')
})

test('unknown response survives plugin reload and cannot be installed twice', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('connection lost') } } })
  await f.updater.check()
  assert.equal((await f.updater.install('0.1.11')).phase, 'outcome_unknown')
  const afterReload = createPluginUpdater(f.options)
  assert.equal(afterReload.status().phase, 'outcome_unknown')
  const count = f.calls.length
  assert.equal((await afterReload.install('0.1.11')).phase, 'outcome_unknown')
  assert.equal((await afterReload.check()).phase, 'outcome_unknown')
  assert.equal(f.calls.length, count)
  f.setBundles([{ name: UPDATE_PACKAGE, version: '0.1.11', enabled: true, installed: true, availability: 'profile' }])
  assert.equal((await afterReload.check()).phase, 'restart_required')
  const restarted = createPluginUpdater({ ...f.options, currentVersion: '0.1.11' })
  assert.equal(restarted.status().phase, 'updated')
})

test('unknown outcome remains protected if host inspection fails or receipt is unreadable', async t => {
  const f = await fixture(t)
  await mkdir(join(f.directory, 'updates'))
  await writeFile(join(f.directory, 'updates', 'last-update.json'), '{invalid')
  const updater = createPluginUpdater(f.options)
  assert.equal(updater.status().phase, 'outcome_unknown')
  assert.equal((await updater.check()).phase, 'outcome_unknown')
  assert.equal((await updater.install('0.1.11')).phase, 'outcome_unknown')
  assert.equal(f.calls.length, 0)
})

test('only a matching native result is success; restart reasons are bounded', async t => {
  for (const application of ['applied', 'restart-required', 'overridden']) {
    const f = await fixture(t, { result: { application, bundle: UPDATE_PACKAGE, version: '0.1.11', restartReason: 'secret=unsafe' } })
    await f.updater.check()
    const result = await f.updater.install('0.1.11')
    assert.equal(result.phase, application === 'applied' ? 'updated' : application === 'restart-required' ? 'restart_required' : 'outcome_unknown')
    assert.equal(result.restartReason, null)
  }
})

test('frozen manifest determines installation even if release endpoint changes', async t => {
  const f = await fixture(t)
  await f.updater.check()
  f.manifest.version = '0.1.99'
  f.manifest.filename = 'xbot-deepseek-harness-a2a-0.1.99.tgz'
  const result = await f.updater.install('0.1.11')
  assert.equal(result.latestVersion, '0.1.11')
  assert.ok(f.installs[0].spec.endsWith('0.1.11.tgz'))
})

test('installed disabled selection is retained and missing or installation-owned bundle refuses', async t => {
  for (const availability of ['profile', 'installation', 'missing']) {
    const f = await fixture(t)
    f.setBundles([{ name: UPDATE_PACKAGE, version: '0.1.10', enabled: false, installed: true, availability }])
    await f.updater.check()
    const result = await f.updater.install('0.1.11')
    if (availability === 'profile') assert.equal(f.installs[0].options.enabled, false)
    else { assert.equal(result.error, 'host_unavailable'); assert.equal(f.installs.length, 0) }
  }
})


test('installation is bound to the version the user confirmed', async t => {
  const f = await fixture(t)
  await f.updater.check()
  assert.equal((await f.updater.install('0.1.12')).error, 'update_changed')
  assert.equal(f.calls.length, 3)
  assert.equal(f.installs.length, 0)
  assert.equal((await f.updater.install('0.1.11')).phase, 'restart_required')
})

test('reloaded updater joins the active native task before interpreting installed metadata', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('response lost') } } })
  await f.updater.check()
  await f.updater.install('0.1.11')
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
  settle({ application: 'restart-required', bundle: UPDATE_PACKAGE, version: '0.1.11', restartReason: 'package-moved' })
  assert.equal((await recovery).phase, 'restart_required')
  assert.equal(requests.length, 1)
  assert.equal(updater.status().restartReason, 'package-moved')
})

test('native recovery rejection cannot reopen installation after a lost response', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('response lost') } } })
  await f.updater.check()
  await f.updater.install('0.1.11')
  f.options.manager().waitForInstall = async () => { throw new Error('still disconnected') }
  const updater = createPluginUpdater(f.options)
  assert.equal((await updater.check()).phase, 'outcome_unknown')
  assert.equal((await updater.install('0.1.11')).phase, 'outcome_unknown')
  assert.equal(f.calls.length, 4)
})

test('duplicate install/check calls cannot change an in-flight confirmed package', async t => {
  let settle
  const active = new Promise(resolve => { settle = resolve })
  let started
  const start = new Promise(resolve => { started = resolve })
  let installCount = 0
  const f = await fixture(t, { manager: { installBundle: async () => { installCount++; started(); return active } } })
  await f.updater.check()
  const installation = f.updater.install('0.1.11')
  await start
  assert.equal((await f.updater.install('0.1.11')).phase, 'installing')
  assert.equal((await f.updater.check()).phase, 'installing')
  assert.equal(f.calls.length, 4)
  assert.equal(installCount, 1)
  settle({ application: 'applied', bundle: UPDATE_PACKAGE, version: '0.1.11' })
  assert.equal((await installation).phase, 'updated')
})

test('credentials are required, validated before saving, private and separate from device auth', async t => {
  const f = await fixture(t, { credential: false })
  assert.equal(f.updater.status().hasCredential, false)
  assert.equal((await f.updater.check()).error, 'credential_required')
  assert.equal(f.calls.length, 0)
  const secret = 'new-read-only-private-test-secret'
  await writeFile(join(f.directory, 'credentials.json'), 'platform-auth-untouched')
  const result = await f.updater.setCredential(secret)
  assert.equal(result.hasCredential, true)
  assert.equal(result.phase, 'available')
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal((await f.tokenStore.get()).accessToken, secret)
  assert.equal(await readFile(join(f.directory, 'credentials.json'), 'utf8'), 'platform-auth-untouched')
  assert.equal(f.calls[0].url, `${UPDATE_LIST_URL}&page=1`)
  assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), `token ${secret}`)
  if (process.platform !== 'win32') assert.equal((await stat(join(f.directory, 'gitea-updater', 'credentials.json'))).mode & 0o777, 0o600)
  assert.equal(createPluginUpdater(f.options).status().hasCredential, true)
  assert.equal((await f.updater.clearCredential()).hasCredential, false)
  assert.equal(await f.tokenStore.get(), undefined)
  assert.equal((await f.updater.check()).error, 'credential_required')
  assert.equal(await readFile(join(f.directory, 'credentials.json'), 'utf8'), 'platform-auth-untouched')
})

test('rejected replacement preserves the previous PAT and never emits supplied secrets', async t => {
  for (const status of [401, 403]) {
    const secret = `bad-private-token-${status}`
    const f = await fixture(t, { options: { fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get('Authorization'), `token ${secret}`)
      return new Response(`raw server token=${secret}`, { status })
    } } })
    const result = await f.updater.setCredential(secret)
    assert.equal(result.error, 'credential_invalid')
    assert.equal(result.hasCredential, true)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal((await f.tokenStore.get()).accessToken, 'fixture-read-only-secret')
  }
  for (const token of ['', 'bearer with space', 'header\r\nInjected:true', 'a'.repeat(4097)]) {
    const f = await fixture(t)
    assert.equal((await f.updater.setCredential(token)).error, 'credential_invalid')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.tokenStore.get()).accessToken, 'fixture-read-only-secret')
  }
})

test('all package reads use fixed authenticated Gitea GET and reject redirects without following them', async t => {
  for (const [responseFactory, code] of [
    [() => new Response(null, { status: 307, headers: { location: 'https://other.invalid/?secret=do-not-follow' } }), 'network'],
    [() => { const response = Response.json([]); Object.defineProperty(response, 'url', { value: 'https://other.invalid/api/packages' }); return response }, 'network'],
    [() => { const response = Response.json([]); Object.defineProperty(response, 'redirected', { value: true }); return response }, 'network'],
  ]) {
    const calls = []
    const f = await fixture(t, { options: { fetch: async (url, init) => {
      calls.push({ url, init }); return responseFactory()
    } } })
    const result = await f.updater.setCredential('replacement-private-token')
    assert.equal(result.error, code)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${UPDATE_LIST_URL}&page=1`)
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.redirect, 'error')
    assert.equal((await f.tokenStore.get()).accessToken, 'fixture-read-only-secret')
    assert.equal(JSON.stringify(result).includes('replacement-private-token'), false)
  }
})

test('Gitea pagination filters exact name/type and selects highest strict SemVer', async t => {
  const f = await fixture(t)
  const calls = []
  const pages = [
    [
      { name: 'deepseek-harness-a2a-extra', type: 'generic', version: '99.0.0' },
      { name: 'deepseek-harness-a2a', type: 'npm', version: '99.0.0' },
      { name: 'deepseek-harness-a2a', type: 'generic', version: 'v99.0.0' },
      { name: 'deepseek-harness-a2a', type: 'generic', version: '0.1.9' },
    ],
    [
      { name: 'deepseek-harness-a2a', type: 'generic', version: '0.1.11-rc.2' },
      { name: 'deepseek-harness-a2a', type: 'generic', version: '0.1.11' },
    ], [],
  ]
  f.options.fetch = async (url, init) => {
    calls.push(url)
    assert.equal(init.method, 'GET')
    if (url.startsWith(UPDATE_LIST_URL)) return Response.json(pages[Number(new URL(url).searchParams.get('page')) - 1])
    assert.equal(url, `${UPDATE_BASE_URL}0.1.11/release-manifest.json`)
    return Response.json(f.manifest)
  }
  const updater = createPluginUpdater(f.options)
  const result = await updater.check()
  assert.equal(result.latestVersion, '0.1.11')
  assert.equal(result.phase, 'available')
  assert.equal(calls.length, 4)
})

test('empty private registry is a successful credential check without a release', async t => {
  const f = await fixture(t, { credential: false, records: [] })
  const result = await f.updater.setCredential('valid-empty-registry-token')
  assert.equal(result.hasCredential, true)
  assert.equal(result.phase, 'current')
  assert.equal(result.latestVersion, null)
  assert.equal(result.error, null)
  assert.equal(result.canInstall, false)
  assert.equal(f.calls.length, 1)
})

test('package record cannot redirect manifest or mismatch its selected version', async t => {
  const f = await fixture(t, { records: [{ name: 'deepseek-harness-a2a', type: 'generic', version: '0.1.12', url: 'https://evil.invalid/package' }] })
  const result = await f.updater.check()
  assert.equal(result.error, 'invalid_manifest')
  assert.equal(f.calls[2].url, `${UPDATE_BASE_URL}0.1.12/release-manifest.json`)
  assert.equal(f.calls.some(call => call.url.includes('evil.invalid')), false)
})

test('credential changes are refused during native installation without changing saved token', async t => {
  let settle, started
  const active = new Promise(resolve => { settle = resolve })
  const start = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { manager: { installBundle: async () => { started(); return active } } })
  await f.updater.check()
  const running = f.updater.install('0.1.11')
  await start
  assert.equal((await f.updater.setCredential('replacement-secret')).error, 'busy')
  assert.equal((await f.updater.clearCredential()).error, 'busy')
  assert.equal((await f.tokenStore.get()).accessToken, 'fixture-read-only-secret')
  settle({ application: 'restart-required', bundle: UPDATE_PACKAGE, version: '0.1.11' })
  await running
})

test('clearing credentials never clears an unknown native installation receipt', async t => {
  const f = await fixture(t, { manager: { installBundle: async () => { throw new Error('lost') } } })
  await f.updater.check()
  await f.updater.install('0.1.11')
  const result = await f.updater.clearCredential()
  assert.equal(result.phase, 'outcome_unknown')
  assert.equal(result.hasCredential, false)
  assert.equal((await f.updater.install('0.1.11')).phase, 'outcome_unknown')
})

test('credential refusal remains visible while preserving restart-required outcome', async t => {
  const f = await fixture(t)
  await f.updater.check()
  await f.updater.install('0.1.11')
  f.options.fetch = async () => new Response('denied secret', { status: 401 })
  const result = await f.updater.setCredential('replacement-invalid-token')
  assert.equal(result.phase, 'restart_required')
  assert.equal(result.error, 'credential_invalid')
  assert.equal(result.hasCredential, true)
  assert.equal((await f.tokenStore.get()).accessToken, 'fixture-read-only-secret')
  assert.equal((await f.updater.install('0.1.11')).phase, 'restart_required')
})

test('disposal while writing receipt prevents handoff to native installation', async t => {
  const f = await fixture(t)
  await f.updater.check()
  f.options.canInstall = () => !existsSync(join(f.directory, 'updates', 'last-update.json'))
  const result = await f.updater.install('0.1.11')
  assert.equal(result.error, 'busy')
  assert.equal(f.installs.length, 0)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'updates', 'last-update.json'))).phase, 'failed')
})
