import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = resolve(
  packageRoot,
  process.env.XBOT_RELEASE_DIR ?? '../../frontend/public/downloads/deepseek-harness-a2a',
)
mkdirSync(outputDir, { recursive: true })

for (const name of readdirSync(outputDir)) {
  if (name.endsWith('.tgz') || name === 'release-manifest.json') unlinkSync(resolve(outputDir, name))
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = execFileSync(npmCommand, ['pack', '--json', '--pack-destination', outputDir], {
  cwd: packageRoot,
  encoding: 'utf8',
})
const records = JSON.parse(result)
const record = Array.isArray(records) ? records[0] : undefined
if (!record || typeof record.filename !== 'string') throw new Error('npm pack did not return a tarball filename')

const artifactPath = resolve(outputDir, basename(record.filename))
const artifact = readFileSync(artifactPath)
const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
const manifest = {
  package: pkg.name,
  version: pkg.version,
  filename: basename(record.filename),
  size: artifact.byteLength,
  sha256: createHash('sha256').update(artifact).digest('hex'),
  generatedAt: new Date().toISOString(),
}
writeFileSync(resolve(outputDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
copyFileSync(resolve(packageRoot, 'README.md'), resolve(outputDir, 'README.md'))
console.log(`Staged ${manifest.filename} (${manifest.size} bytes) in ${outputDir}`)
console.log(`SHA-256: ${manifest.sha256}`)
