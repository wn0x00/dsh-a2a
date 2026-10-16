import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { normalizeGatewayOrigin, writeReleaseDefaults } from '../scripts/build-defaults.mjs'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))

test('release metadata exposes an executable local host runner', () => {
  assert.equal(packageJson.version, manifest.version)
  assert.equal(packageJson.bin['xbot-deepseek-harness-a2a'], './dist/cli.js')
  assert.deepEqual(packageJson.files, ['dist', 'manifest.json', 'README.md', 'cordis.patch.yml'])
  assert.equal(manifest.cli, 'dist/cli.js')
  assert.equal(manifest.entry, 'dist/index.js')
  assert.equal(manifest.loader.type, 'deepseek-harness-cordis-bundle')
  assert.equal(manifest.runtime.node, '>=22.19.0')
  assert.equal(manifest.loader.patch, 'cordis.patch.yml')
  assert.equal(manifest.oauth.redirectUri, 'http://127.0.0.1:43127/oauth/callback')
  assert.ok(manifest.scopes.includes('device.connect'))
  assert.ok(manifest.scopes.includes('device.task.receive'))
  assert.ok(manifest.scopes.includes('device.task.report'))
})

test('release builds embed a validated production origin without changing local defaults', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'xbot-release-defaults-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const productionFile = join(directory, 'production.mjs')
  await writeReleaseDefaults(productionFile, 'https://agent.guanzhu.me/')
  assert.equal((await import(pathToFileURL(productionFile).href)).DEFAULT_GATEWAY, 'https://agent.guanzhu.me')
  const localFile = join(directory, 'local.mjs')
  await writeReleaseDefaults(localFile)
  assert.equal((await import(pathToFileURL(localFile).href)).DEFAULT_GATEWAY, 'http://127.0.0.1:8000')
  assert.match(packageJson.scripts.build, /node scripts\/build-defaults\.mjs/u)
})

test('release gateway rejects plaintext remote hosts and embedded credentials or paths', () => {
  for (const url of ['http://agent.guanzhu.me', 'https://user:password@agent.guanzhu.me',
    'https://agent.guanzhu.me/api', 'https://agent.guanzhu.me?token=private',
    'https://agent.guanzhu.me#fragment', ' https://agent.guanzhu.me', 'file:///tmp/platform']) {
    assert.throws(() => normalizeGatewayOrigin(url))
  }
})
