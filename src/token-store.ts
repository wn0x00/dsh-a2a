import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { TokenSet, TokenStore } from './types.js'

/** DPAPI is bound to the signed-in Windows account. Secrets travel through
 * stdin/stdout, never command arguments, environment variables or error logs. */
async function dpapi(value: string, operation: 'Protect' | 'Unprotect'): Promise<string> {
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.once('error', () => reject(new Error('Windows credential protection is unavailable')))
    child.once('close', (code) => {
      if (code !== 0) reject(new Error('Windows credential protection failed'))
      else resolve(output.trim())
    })
    child.stdin.on('error', () => reject(new Error('Windows credential protection failed')))
    child.stdin.end(value)
  })
}

async function privateWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dirname(path), 0o700)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export class PersistentTokenStore implements TokenStore {
  constructor(private readonly directory: string) {}

  async get(): Promise<TokenSet | undefined> {
    let raw: string
    try {
      raw = await readFile(join(this.directory, 'credentials.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Unable to read saved device credentials')
    }
    try {
      const envelope = JSON.parse(raw) as { protection: string; data: string }
      if (process.platform === 'win32' && envelope.protection !== 'dpapi') {
        throw new Error('Windows credentials must use DPAPI')
      }
      const serialized = envelope.protection === 'dpapi'
        ? Buffer.from(await dpapi(envelope.data, 'Unprotect'), 'base64').toString('utf8')
        : envelope.data
      const tokens = JSON.parse(serialized) as TokenSet
      if (typeof tokens.accessToken !== 'string' || !Number.isFinite(tokens.expiresAt)) {
        throw new Error('Invalid device credentials')
      }
      return tokens
    } catch {
      // Unreadable/foreign-account credentials require consent again; never
      // expose raw token content through JSON parsing or DPAPI error messages.
      await this.clear()
      return undefined
    }
  }

  async set(tokens: TokenSet): Promise<void> {
    const serialized = JSON.stringify(tokens)
    const envelope = process.platform === 'win32'
      ? { protection: 'dpapi', data: await dpapi(Buffer.from(serialized).toString('base64'), 'Protect') }
      : { protection: 'file-mode-0600', data: serialized }
    await privateWrite(join(this.directory, 'credentials.json'), JSON.stringify(envelope))
  }

  async clear(): Promise<void> {
    await rm(join(this.directory, 'credentials.json'), { force: true })
  }
}

/** Machine-local state root shared by every platform/profile of this plugin. */
export function stateStorageBase(root?: string): string {
  return root ?? process.env.A2A_STORAGE_DIRECTORY ?? (
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-a2a')
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsh-a2a')
  )
}

/** Storage keyed by an opaque scope string plus the local Harness profile. */
export function stateStorageDirectory(scope: string, profile: string, root?: string): string {
  const key = createHash('sha256').update(`${scope}\n${profile}`).digest('hex')
  return join(stateStorageBase(root), key)
}

export function profileStorageDirectory(gatewayUrl: string, profile: string, root?: string): string {
  const gateway = new URL(gatewayUrl)
  if (gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error('Platform URL must not contain credentials, query or fragment')
  }
  return stateStorageDirectory(`${gateway.origin}${gateway.pathname.replace(/\/$/u, '')}`, profile, root)
}

const PLATFORM_FILE = 'platform.json'

/** The standalone diagnostic's last explicitly configured platform address. */
export async function persistedPlatformUrl(root?: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(join(stateStorageBase(root), PLATFORM_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Unable to read the saved platform address')
  }
  const value = JSON.parse(raw) as { gatewayUrl?: unknown }
  return typeof value.gatewayUrl === 'string' && value.gatewayUrl.trim() ? value.gatewayUrl.trim() : undefined
}

export async function persistPlatformUrl(gatewayUrl: string, root?: string): Promise<void> {
  await privateWrite(join(stateStorageBase(root), PLATFORM_FILE), JSON.stringify({ gatewayUrl }))
}

/** New platform identities deliberately do not reuse the old hostname/Keycloak
 * device id. The random identity survives restarts within this profile. */
export async function persistentDeviceId(directory: string): Promise<string> {
  const path = join(directory, 'device.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { id: string }
    if (/^xbot-[a-f0-9-]{36}$/u.test(value.id)) return value.id
    throw new Error('Invalid saved device identity')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const id = `xbot-${randomUUID()}`
  await privateWrite(path, JSON.stringify({ id }))
  return id
}

/** Prevent two Harness processes from rotating the same refresh credential. */
export async function lockProfile(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'active.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(String(process.pid))
      await file.close()
      return () => rm(path, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number(await readFile(path, 'utf8').catch(() => ''))
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0) } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(path, { force: true })
            continue
          }
        }
      }
      throw new Error('This platform/profile is already connected in another Harness process. Close it before restarting the plugin.')
    }
  }
  throw new Error('Unable to lock device credentials')
}
