import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version

export async function writeReleaseDefaults(destination) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `// Generated release defaults; no credentials and no default platform origin.\nexport const PLUGIN_VERSION = ${JSON.stringify(packageVersion)};\n`)
  return packageVersion
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await writeReleaseDefaults(fileURLToPath(new URL('../dist/release-config.js', import.meta.url)))
}
