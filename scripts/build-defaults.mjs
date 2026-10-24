import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const localGateway = 'http://127.0.0.1:8000'
const packageVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version

export function normalizeGatewayOrigin(value = localGateway) {
  const url = new URL(value)
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || /\s/u.test(value)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('XBOT_DEFAULT_GATEWAY_URL must be an HTTPS origin or local loopback HTTP origin')
  }
  return url.origin
}

export async function writeReleaseDefaults(destination, gateway = localGateway) {
  const origin = normalizeGatewayOrigin(gateway)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `// Generated release defaults; no credentials.\nexport const DEFAULT_GATEWAY = ${JSON.stringify(origin)};\nexport const PLUGIN_VERSION = ${JSON.stringify(packageVersion)};\n`)
  return origin
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await writeReleaseDefaults(
    fileURLToPath(new URL('../dist/release-config.js', import.meta.url)),
    process.env.XBOT_DEFAULT_GATEWAY_URL,
  )
}
