import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { normalizeGatewayOrigin, writeReleaseDefaults } from '../scripts/build-defaults.mjs'
import { releaseDirectory, stageRelease } from '../scripts/stage-release.mjs'

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
  assert.equal(packageJson.engines.dsh, '>=0.2.1-rc.2 <0.3.0')
  assert.equal(manifest.loader.patch, 'cordis.patch.yml')
  assert.equal(manifest.oauth.redirectUri, 'http://127.0.0.1:43127/oauth/callback')
  assert.ok(manifest.scopes.includes('device.connect'))
  assert.ok(manifest.scopes.includes('device.task.receive'))
  assert.ok(manifest.scopes.includes('device.task.report'))
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.repository.url, 'git+https://gitea.guanzhu.me/xbot/deepseek-harness-a2a.git')
})

async function releaseFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xbot-standalone-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pkg = { name: '@xbot/release-fixture', version: '0.1.9', private: true, files: ['dist', 'README.md'] }
  await mkdir(join(directory, 'dist'))
  await writeFile(join(directory, 'dist', 'index.js'), 'export const fixture = true\n')
  await writeFile(join(directory, 'README.md'), '# Standalone release fixture\n')
  await writeFile(join(directory, 'package.json'), JSON.stringify(pkg))
  return { directory, pkg }
}

test('standalone release stays within its package and hashes the actual archive', async (t) => {
  const { directory, pkg } = await releaseFixture(t)
  const outputDir = releaseDirectory(directory)
  assert.equal(outputDir, join(directory, 'release'))
  await mkdir(outputDir)
  await writeFile(join(outputDir, 'xbot-release-fixture-0.1.8.tgz'), 'old release')
  await writeFile(join(outputDir, 'release-manifest.json'), JSON.stringify({ package: pkg.name, filename: 'xbot-release-fixture-0.1.8.tgz' }))
  await writeFile(join(outputDir, 'xbot-release-fixture-other-0.1.0.tgz'), 'unrelated release')

  const { manifest: staged } = stageRelease({ packageRoot: directory, outputDir })
  const archive = await readFile(join(outputDir, staged.filename))
  assert.equal(staged.package, pkg.name)
  assert.equal(staged.version, pkg.version)
  assert.equal(staged.size, archive.byteLength)
  assert.equal(staged.sha256, createHash('sha256').update(archive).digest('hex'))
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'release-manifest.json'), 'utf8')), staged)
  assert.equal(await readFile(join(outputDir, 'README.md'), 'utf8'), '# Standalone release fixture\n')
  assert.deepEqual((await readdir(outputDir)).sort(), [
    'README.md', 'release-manifest.json', 'xbot-release-fixture-0.1.9.tgz', 'xbot-release-fixture-other-0.1.0.tgz',
  ])
})

test('release directory override supports platform-relative and absolute destinations', async (t) => {
  const { directory } = await releaseFixture(t)
  const override = '../platform/frontend/public/downloads/deepseek-harness-a2a'
  assert.equal(releaseDirectory(directory, override), resolve(directory, override))
  const outputDir = join(directory, 'platform-downloads')
  assert.equal(releaseDirectory(directory, outputDir), outputDir)
  const previous = process.env.XBOT_RELEASE_DIR
  process.env.XBOT_RELEASE_DIR = outputDir
  let staged
  try {
    staged = stageRelease({ packageRoot: directory }).manifest
  } finally {
    if (previous === undefined) delete process.env.XBOT_RELEASE_DIR
    else process.env.XBOT_RELEASE_DIR = previous
  }
  assert.ok((await readFile(join(outputDir, staged.filename))).byteLength > 0)
  await assert.rejects(readFile(join(directory, 'release', 'release-manifest.json')), { code: 'ENOENT' })
})

test('failed packaging preserves the previous release', async (t) => {
  const { directory, pkg } = await releaseFixture(t)
  const outputDir = join(directory, 'release')
  await mkdir(outputDir)
  await writeFile(join(outputDir, 'xbot-release-fixture-0.1.8.tgz'), 'previous archive')
  await writeFile(join(outputDir, 'release-manifest.json'), 'previous manifest')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...pkg, scripts: { prepack: 'node -e "process.exit(1)"' } }))
  assert.throws(() => stageRelease({ packageRoot: directory, outputDir }))
  assert.equal(await readFile(join(outputDir, 'xbot-release-fixture-0.1.8.tgz'), 'utf8'), 'previous archive')
  assert.equal(await readFile(join(outputDir, 'release-manifest.json'), 'utf8'), 'previous manifest')
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
