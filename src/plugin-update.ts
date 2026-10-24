import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PersistentTokenStore } from './token-store.js'

export const UPDATE_PACKAGE = '@xbot/deepseek-harness-a2a'
export const UPDATE_BASE_URL =
  'https://gitea.guanzhu.me/api/packages/xbot/generic/deepseek-harness-a2a/'
export const UPDATE_LIST_URL =
  'https://gitea.guanzhu.me/api/v1/packages/xbot?type=generic&q=deepseek-harness-a2a&limit=100'
const UPDATE_ORIGIN = 'https://gitea.guanzhu.me'

export type PluginUpdatePhase =
  | 'idle' | 'checking' | 'available' | 'current' | 'downloading'
  | 'installing' | 'restart_required' | 'updated' | 'outcome_unknown' | 'error'
export type PluginUpdateError =
  | 'network' | 'invalid_manifest' | 'integrity' | 'invalid_package'
  | 'busy' | 'host_unavailable' | 'host_refused' | 'installation_failed'
  | 'installation_unknown' | 'storage' | 'update_changed'
  | 'credential_required' | 'credential_invalid'
export type PluginUpdateSnapshot = {
  phase: PluginUpdatePhase
  currentVersion: string
  latestVersion: string | null
  checkedAt: number | null
  error: PluginUpdateError | null
  restartReason: string | null
  canInstall: boolean
  hasCredential: boolean
}

export type NativePluginChangeResult = {
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  bundle?: string
  version?: string
  restartReason?: string
  error?: { code: string }
}
/** Structural subset of the public 0.2.1-rc.2+ Host pluginManager service. */
export type NativePluginManager = {
  listBundles(): Promise<Array<{
    name: string
    version?: string
    enabled: boolean
    installed: boolean
    availability: 'installation' | 'profile' | 'missing'
  }>>
  installBundle(spec: string, options: {
    enabled: boolean
    requestId: string
    saveExact: boolean
  }): Promise<NativePluginChangeResult>
  waitForInstall?(requestId: string): Promise<NativePluginChangeResult | null>
}
export type PluginUpdaterOptions = {
  currentVersion: string
  storageDirectory: string
  manager(): NativePluginManager | undefined
  canInstall(): boolean
  acquireInstallLock(): Promise<() => Promise<void>>
  fetch?: typeof fetch
  requestTimeoutMs?: number
}
export type PluginUpdater = {
  status(): PluginUpdateSnapshot
  check(): Promise<PluginUpdateSnapshot>
  install(expectedVersion: string): Promise<PluginUpdateSnapshot>
  setCredential(token: string): Promise<PluginUpdateSnapshot>
  clearCredential(): Promise<PluginUpdateSnapshot>
}

type ReleaseManifest = {
  package: typeof UPDATE_PACKAGE
  version: string
  filename: string
  size: number
  sha256: string
  generatedAt: string
}
type Receipt = {
  version: string
  sha256: string
  requestId: string
  phase: 'installing' | 'restart_required' | 'updated' | 'failed'
  restartReason: string | null
}
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024
const MAX_TAR_BYTES = 32 * 1024 * 1024
const RESTART_REASONS = ['no-hmr', 'package-moved', 'host-module', 'unmanaged-plugin', 'module-comparison']
const restartReason = (value: unknown): string | null =>
  typeof value === 'string' && RESTART_REASONS.includes(value) ? value : null
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && VERSION.test(value)
}

/** SemVer precedence: build metadata never turns the same release into an update. */
export function comparePluginVersions(left: string, right: string): number {
  if (!validVersion(left) || !validVersion(right)) throw new Error('Invalid version')
  const a = VERSION.exec(left)!
  const b = VERSION.exec(right)!
  for (let index = 1; index <= 3; index++) {
    const delta = BigInt(a[index]!) - BigInt(b[index]!)
    if (delta !== 0n) return delta > 0n ? 1 : -1
  }
  if (a[4] === b[4]) return 0
  if (!a[4]) return 1
  if (!b[4]) return -1
  const av = a[4].split('.')
  const bv = b[4].split('.')
  for (let index = 0; index < Math.max(av.length, bv.length); index++) {
    const x = av[index], y = bv[index]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

class UpdateFailure extends Error {
  constructor(readonly code: PluginUpdateError) { super(code) }
}

function manifestFrom(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpdateFailure('invalid_manifest')
  const data = value as Record<string, unknown>
  if (Object.keys(data).sort().join(',') !== 'filename,generatedAt,package,sha256,size,version'
    || data.package !== UPDATE_PACKAGE || !validVersion(data.version)
    || data.filename !== `xbot-deepseek-harness-a2a-${data.version}.tgz`
    || typeof data.size !== 'number' || !Number.isSafeInteger(data.size)
    || data.size <= 0 || data.size > MAX_PACKAGE_BYTES
    || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(data.sha256)
    || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))) {
    throw new UpdateFailure('invalid_manifest')
  }
  return Object.freeze({ ...data }) as ReleaseManifest
}

/** Check the archive's identity before native installation can execute package code. */
function verifyArchive(bytes: Buffer, release: ReleaseManifest): void {
  if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
    throw new UpdateFailure('integrity')
  }
  try {
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES })
    let found = false
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every(byte => byte === 0)) break
      const name = header.subarray(0, 100).toString().replace(/\0.*$/su, '')
      const prefix = header.subarray(345, 500).toString().replace(/\0.*$/su, '')
      const path = prefix ? `${prefix}/${name}` : name
      const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/su, '').trim()
      if (!/^[0-7]+$/u.test(sizeText)) throw new Error('size')
      const size = Number.parseInt(sizeText, 8)
      if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length
        || !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..')
        || ![0, 48, 53].includes(header[156]!)) throw new Error('path')
      // Only standard npm regular files/directories are accepted; rejecting PAX
      // and link entries prevents an alternate path from shadowing package.json.
      const checksum = Number.parseInt(header.subarray(148, 156).toString().replace(/\0.*$/su, '').trim(), 8)
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
      if (checksum !== sum) throw new Error('checksum')
      if (path === 'package/package.json') {
        if (found || (header[156] !== 0 && header[156] !== 48) || size > 64 * 1024) throw new Error('manifest')
        const pkg = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString())
        if (pkg.name !== UPDATE_PACKAGE || pkg.version !== release.version || !pkg.dsh?.bundle?.patch) throw new Error('identity')
        found = true
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }
    if (!found) throw new Error('missing manifest')
  } catch { throw new UpdateFailure('invalid_package') }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdateFailure('storage')
  if (process.platform !== 'win32') await chmod(path, 0o700)
}

function validCredential(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 4096
    && /^[\x21-\x7e]+$/u.test(token)
}

async function fetchBytes(url: string, limit: number, options: PluginUpdaterOptions, token: string): Promise<Buffer> {
  const target = new URL(url)
  if (target.origin !== UPDATE_ORIGIN || target.username || target.password || target.hash
    || !(url.startsWith(UPDATE_BASE_URL) || url.startsWith(`${UPDATE_LIST_URL}&page=`))) {
    throw new UpdateFailure('network')
  }
  if (!validCredential(token)) throw new UpdateFailure('credential_invalid')
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      void reader?.cancel().catch(() => {})
      reject(new UpdateFailure('network'))
    }, options.requestTimeoutMs ?? 30_000)
  })
  try {
    return await Promise.race([timedOut, (async () => {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: 'GET',
        redirect: 'error', signal: controller.signal,
        headers: {
          Accept: url.endsWith('.tgz') ? 'application/octet-stream' : 'application/json',
          Authorization: `token ${token}`,
        },
      })
      if (response.status === 401 || response.status === 403) throw new UpdateFailure('credential_invalid')
      if (!response.ok || response.redirected || (response.url && response.url !== url) || !response.body) throw new UpdateFailure('network')
      const declared = response.headers.get('content-length')
      if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) throw new UpdateFailure('integrity')
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > limit) throw new UpdateFailure('integrity')
        chunks.push(chunk.value)
      }
      return Buffer.concat(chunks, size)
    })()])
  } catch (error) {
    throw error instanceof UpdateFailure ? error : new UpdateFailure('network')
  } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}

async function newestRelease(options: PluginUpdaterOptions, token: string): Promise<string | undefined> {
  let newest: string | undefined
  // Request each page until empty: a Host may cap limit below our requested 100.
  // Bound the total to prevent a faulty API from cycling nonempty pages forever.
  for (let page = 1; page <= 100; page++) {
    const bytes = await fetchBytes(`${UPDATE_LIST_URL}&page=${page}`, 1024 * 1024, options, token)
    let records: unknown
    try { records = JSON.parse(bytes.toString()) } catch { throw new UpdateFailure('invalid_manifest') }
    if (!Array.isArray(records)) throw new UpdateFailure('invalid_manifest')
    if (records.length === 0) return newest
    for (const record of records) {
      if (!record || typeof record !== 'object' || record.type !== 'generic'
        || record.name !== 'deepseek-harness-a2a' || !validVersion(record.version)) continue
      if (!newest || comparePluginVersions(record.version, newest) > 0) newest = record.version
    }
  }
  throw new UpdateFailure('invalid_manifest')
}

export function createPluginUpdater(options: PluginUpdaterOptions): PluginUpdater {
  if (!validVersion(options.currentVersion)) throw new Error('Invalid current plugin version')
  const directory = join(options.storageDirectory, 'updates')
  const receiptPath = join(directory, 'last-update.json')
  const credentialDirectory = join(options.storageDirectory, 'gitea-updater')
  const credentialStore = new PersistentTokenStore(credentialDirectory)
  let hasCredential = existsSync(join(credentialDirectory, 'credentials.json'))
  let manifest: ReleaseManifest | undefined
  let receipt: Receipt | undefined
  let busy = false
  let snapshot: Omit<PluginUpdateSnapshot, 'canInstall' | 'hasCredential'> = {
    phase: 'idle', currentVersion: options.currentVersion, latestVersion: null,
    checkedAt: null, error: null, restartReason: null,
  }
  try {
    const raw = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt
    if (!validVersion(raw.version) || !/^[0-9a-f]{64}$/u.test(raw.sha256)
      || typeof raw.requestId !== 'string' || raw.requestId.length > 128
      || (raw.restartReason !== null && typeof raw.restartReason !== 'string')
      || !['installing', 'restart_required', 'updated', 'failed'].includes(raw.phase)) throw new Error('receipt')
    receipt = { ...raw, restartReason: restartReason(raw.restartReason) }
    if (comparePluginVersions(options.currentVersion, raw.version) >= 0) {
      snapshot = { ...snapshot, phase: 'updated', latestVersion: raw.version }
    } else if (raw.phase !== 'failed') {
      snapshot = { ...snapshot, phase: raw.phase === 'restart_required' ? 'restart_required' : 'outcome_unknown',
        latestVersion: raw.version, restartReason: restartReason(raw.restartReason),
        error: raw.phase === 'restart_required' ? null : 'installation_unknown' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      snapshot = { ...snapshot, phase: 'outcome_unknown', error: 'installation_unknown' }
    }
  }
  const status = (): PluginUpdateSnapshot => ({ ...snapshot,
    hasCredential,
    canInstall: !busy && hasCredential && snapshot.phase === 'available' && !!manifest && options.canInstall() && !!options.manager(),
  })
  const errorCode = (error: unknown): PluginUpdateError => error instanceof UpdateFailure ? error.code
    : (error as { code?: string } | null)?.code === 'busy' ? 'busy' : 'storage'
  const fail = (error: unknown) => {
    snapshot = { ...snapshot, phase: 'error', error: errorCode(error) }
  }
  const saveReceipt = async (value: Receipt) => {
    await privateDirectory(directory)
    const temporary = join(directory, `receipt-${randomUUID()}.json`)
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, receiptPath)
    } finally { await rm(temporary, { force: true }) }
    receipt = value
  }
  const loadCredential = async (): Promise<string> => {
    const saved = await credentialStore.get()
    hasCredential = !!saved && validCredential(saved.accessToken)
    if (!hasCredential) throw new UpdateFailure('credential_required')
    return saved!.accessToken
  }
  const readRelease = async (token: string, latest: string | undefined) => {
    manifest = undefined
    if (!latest) {
      snapshot = { ...snapshot, phase: 'current', latestVersion: null,
        checkedAt: Date.now(), error: null, restartReason: null }
      return
    }
    const bytes = await fetchBytes(`${UPDATE_BASE_URL}${encodeURIComponent(latest)}/release-manifest.json`, 16 * 1024, options, token)
    let parsed: unknown
    try { parsed = JSON.parse(bytes.toString()) } catch { throw new UpdateFailure('invalid_manifest') }
    const found = manifestFrom(parsed)
    if (found.version !== latest) throw new UpdateFailure('invalid_manifest')
    manifest = found
    snapshot = { ...snapshot,
      phase: comparePluginVersions(manifest.version, options.currentVersion) > 0 ? 'available' : 'current',
      latestVersion: manifest.version, checkedAt: Date.now(), error: null, restartReason: null,
    }
  }
  return {
    status,
    async setCredential(token) {
      if (busy) return { ...status(), error: 'busy' }
      const previous = snapshot
      const preserveOutcome = ['outcome_unknown', 'restart_required'].includes(snapshot.phase)
      busy = true
      if (!preserveOutcome) snapshot = { ...snapshot, phase: 'checking', error: null }
      try {
        if (!validCredential(token)) throw new UpdateFailure('credential_invalid')
        const latest = await newestRelease(options, token)
        await credentialStore.set({ accessToken: token, expiresAt: Number.MAX_SAFE_INTEGER })
        hasCredential = true
        if (!preserveOutcome) await readRelease(token, latest)
      } catch (error) {
        // A rejected replacement never removes or overwrites the saved token.
        if (preserveOutcome) snapshot = { ...previous, error: errorCode(error) }
        else fail(error)
      } finally { busy = false }
      return status()
    },
    async clearCredential() {
      if (busy) return { ...status(), error: 'busy' }
      const previous = snapshot
      busy = true
      try {
        await credentialStore.clear()
        hasCredential = false
        manifest = undefined
        if (!['outcome_unknown', 'restart_required'].includes(snapshot.phase)) {
          snapshot = { ...snapshot, phase: 'idle', error: null, latestVersion: null }
        }
      } catch (error) {
        if (['outcome_unknown', 'restart_required'].includes(previous.phase)) snapshot = { ...previous, error: errorCode(error) }
        else fail(error)
      }
      finally { busy = false }
      return status()
    },
    async check() {
      if (busy) return status()
      busy = true
      try {
        if (snapshot.phase === 'outcome_unknown' || snapshot.phase === 'restart_required') {
          const manager = options.manager()
          if (manager && receipt) {
            if (receipt.phase === 'installing' && manager.waitForInstall) {
              const result = await manager.waitForInstall(receipt.requestId)
              if (result) {
                if (result.application === 'failed' || result.application === 'cancelled') {
                  await saveReceipt({ ...receipt, phase: 'failed' })
                  throw new UpdateFailure('installation_failed')
                }
                if (result.bundle !== UPDATE_PACKAGE || result.version !== receipt.version
                  || (result.application !== 'applied' && result.application !== 'restart-required')) {
                  throw new UpdateFailure('installation_unknown')
                }
                await saveReceipt({ ...receipt, phase: 'restart_required', restartReason: restartReason(result.restartReason) })
                snapshot = { ...snapshot, phase: 'restart_required', error: null, restartReason: restartReason(result.restartReason) }
                return status()
              }
            }
            const installed = (await manager.listBundles()).find(bundle => bundle.name === UPDATE_PACKAGE)
            if (installed?.installed && installed.version === receipt.version) {
              snapshot = { ...snapshot, phase: 'restart_required', error: null, restartReason: receipt.restartReason }
            }
          }
          // An absent active request does not prove failure. Do not start another
          // package operation after an interrupted response or unreadable receipt.
          return status()
        }
        snapshot = { ...snapshot, phase: 'checking', error: null }
        const token = await loadCredential()
        await readRelease(token, await newestRelease(options, token))
      } catch (error) {
        if (receipt && receipt.phase !== 'failed' && comparePluginVersions(options.currentVersion, receipt.version) < 0) {
          snapshot = { ...snapshot, phase: 'outcome_unknown', error: 'installation_unknown' }
        } else fail(error)
      }
      finally { busy = false }
      return status()
    },
    async install(expectedVersion) {
      if (busy || snapshot.phase === 'outcome_unknown' || snapshot.phase === 'restart_required') return status()
      if (snapshot.phase !== 'available' || !manifest) return status()
      if (expectedVersion !== manifest.version) {
        snapshot = { ...snapshot, error: 'update_changed' }
        return status()
      }
      if (!options.canInstall()) { snapshot = { ...snapshot, error: 'busy' }; return status() }
      const manager = options.manager()
      if (!manager) { snapshot = { ...snapshot, error: 'host_unavailable' }; return status() }
      const release = manifest
      busy = true
      let handedOff = false
      let releaseLock: (() => Promise<void>) | undefined
      try {
        releaseLock = await options.acquireInstallLock()
        if (!options.canInstall()) throw new UpdateFailure('busy')
        snapshot = { ...snapshot, phase: 'downloading', error: null }
        const token = await loadCredential()
        const bytes = await fetchBytes(`${UPDATE_BASE_URL}${encodeURIComponent(release.version)}/${encodeURIComponent(release.filename)}`, release.size, options, token)
        verifyArchive(bytes, release)
        // Keep the exact tarball: native pnpm records this file dependency and
        // may need it again after a restart or dependency repair.
        const cache = join(directory, release.sha256)
        await privateDirectory(directory)
        await privateDirectory(cache)
        const artifact = join(cache, release.filename)
        try { await writeFile(artifact, bytes, { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const info = await lstat(artifact)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== release.size) throw new UpdateFailure('integrity')
        if (process.platform !== 'win32') await chmod(artifact, 0o600)
        verifyArchive(await readFile(artifact), release)
        {
          if (!options.canInstall()) throw new UpdateFailure('busy')
          const bundle = (await manager.listBundles()).find(value => value.name === UPDATE_PACKAGE)
          if (!bundle?.installed || bundle.availability !== 'profile') throw new UpdateFailure('host_unavailable')
          if (!options.canInstall()) throw new UpdateFailure('busy')
          if (bundle.version && comparePluginVersions(release.version, bundle.version) <= 0) throw new UpdateFailure('host_refused')
          const nextReceipt: Receipt = { version: release.version, sha256: release.sha256,
            requestId: randomUUID(), phase: 'installing', restartReason: null }
          await saveReceipt(nextReceipt)
          if (!options.canInstall()) {
            await saveReceipt({ ...nextReceipt, phase: 'failed' })
            throw new UpdateFailure('busy')
          }
          snapshot = { ...snapshot, phase: 'installing' }
          handedOff = true
          // Native service owns this operation. Do not attach the plugin's
          // AbortSignal, cancel it during unload, or await it from cleanup.
          const result = await manager.installBundle(artifact, {
            enabled: bundle.enabled, requestId: nextReceipt.requestId, saveExact: true,
          })
          if (result.application === 'failed' || result.application === 'cancelled') {
            await saveReceipt({ ...nextReceipt, phase: 'failed' })
            handedOff = false
            throw new UpdateFailure(result.error?.code === 'already-installed' || result.error?.code === 'incompatible-version'
              ? 'host_refused' : 'installation_failed')
          }
          if (result.bundle !== UPDATE_PACKAGE || result.version !== release.version
            || (result.application !== 'applied' && result.application !== 'restart-required')) {
            throw new UpdateFailure('installation_unknown')
          }
          const phase = result.application === 'applied' ? 'updated' : 'restart_required'
          await saveReceipt({ ...nextReceipt, phase, restartReason: restartReason(result.restartReason) })
          snapshot = { ...snapshot, phase, error: null, restartReason: restartReason(result.restartReason) }
        }
      } catch (error) {
        if (handedOff) snapshot = { ...snapshot, phase: 'outcome_unknown', error: 'installation_unknown' }
        else fail(error)
      } finally {
        try { await releaseLock?.() } catch {
          if (handedOff) snapshot = { ...snapshot, phase: 'outcome_unknown', error: 'installation_unknown' }
          else fail(new UpdateFailure('busy'))
        }
        busy = false
      }
      return status()
    },
  }
}
