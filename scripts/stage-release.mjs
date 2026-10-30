import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function releaseDirectory(packageRoot, override) {
  return resolve(packageRoot, override || 'release')
}

export function stageRelease({ packageRoot = defaultPackageRoot, outputDir = releaseDirectory(packageRoot, process.env.DSH_A2A_RELEASE_DIR) } = {}) {
  mkdirSync(outputDir, { recursive: true })
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  let previousFilename
  try {
    const previous = JSON.parse(readFileSync(resolve(outputDir, 'release-manifest.json'), 'utf8'))
    if (previous.package === pkg.name && typeof previous.filename === 'string'
      && previous.filename === basename(previous.filename) && previous.filename.endsWith('.tgz')) {
      previousFilename = previous.filename
    }
  } catch {
    // A missing or invalid old manifest must not select any file for deletion.
  }
  // npm supplies its JS entry point for npm scripts; this avoids spawning .cmd on Windows.
  const npmEntry = process.env.npm_execpath
  const npmCommand = npmEntry ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const npmArgs = [...(npmEntry ? [npmEntry] : []), 'pack', '--json', '--pack-destination', outputDir]
  const result = execFileSync(npmCommand, npmArgs, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const records = JSON.parse(result)
  const record = Array.isArray(records) ? records[0] : undefined
  if (!record || typeof record.filename !== 'string') throw new Error('npm pack did not return a tarball filename')

  const artifactPath = resolve(outputDir, basename(record.filename))
  const artifact = readFileSync(artifactPath)
  const manifest = {
    package: pkg.name,
    version: pkg.version,
    filename: basename(record.filename),
    size: artifact.byteLength,
    sha256: createHash('sha256').update(artifact).digest('hex'),
    generatedAt: new Date().toISOString(),
  }
  copyFileSync(resolve(packageRoot, 'README.md'), resolve(outputDir, 'README.md'))
  writeFileSync(resolve(outputDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // A failed build keeps the previous release. Remove only its recorded archive.
  if (previousFilename && previousFilename !== manifest.filename) {
    rmSync(resolve(outputDir, previousFilename), { force: true })
  }
  return { manifest, outputDir }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { manifest, outputDir } = stageRelease()
  console.log(`Staged ${manifest.filename} (${manifest.size} bytes) in ${outputDir}`)
  console.log(`SHA-256: ${manifest.sha256}`)
}
