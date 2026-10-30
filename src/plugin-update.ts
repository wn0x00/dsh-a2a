import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const UPDATE_PACKAGE = '@guanzhu.me/dsh-a2a'
const PACKAGE_BASENAME = 'dsh-a2a'
const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
export const UPDATE_METADATA_URL = `${REGISTRY_ORIGIN}/${encodeURIComponent(UPDATE_PACKAGE).replace('%40', '@')}`
const MAX_METADATA_BYTES = 8 * 1024 * 1024
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024
const MAX_TAR_BYTES = 32 * 1024 * 1024

export type PluginUpdatePhase =
  | 'idle' | 'checking' | 'available' | 'current' | 'downloading'
  | 'installing' | 'restart_required' | 'updated' | 'outcome_unknown' | 'error'
export type PluginUpdateError =
  | 'network' | 'invalid_manifest' | 'integrity' | 'invalid_package'
  | 'busy' | 'host_unavailable' | 'host_refused' | 'installation_failed'
  | 'installation_unknown' | 'storage' | 'update_changed'
export type PluginUpdateSnapshot = {
  phase: PluginUpdatePhase
  currentVersion: string
  latestVersion: string | null
  checkedAt: number | null
  error: PluginUpdateError | null
  restartReason: string | null
  canInstall: boolean
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
}

/** A frozen registry release: exact tarball plus its npm sha512 integrity. */
type RegistryRelease = {
  package: typeof UPDATE_PACKAGE
  version: string
  tarball: string
  filename: string
  integrity: string
}
type Receipt = {
  version: string
  integrity: string
  requestId: string
  phase: 'installing' | 'restart_required' | 'updated' | 'failed'
  restartReason: string | null
}
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

/** Registry metadata names an exact release; the tarball must stay on the
 * registry origin at the package's own path so metadata cannot redirect the
 * download to another host. */
function releaseFrom(version: unknown, dist: unknown): RegistryRelease {
  if (!validVersion(version)) throw new UpdateFailure('invalid_manifest')
  const filename = `${PACKAGE_BASENAME}-${version}.tgz`
  if (!dist || typeof dist !== 'object') throw new UpdateFailure('invalid_manifest')
  const { tarball, integrity } = dist as Record<string, unknown>
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new UpdateFailure('invalid_manifest')
  }
  if (typeof tarball !== 'string') throw new UpdateFailure('invalid_manifest')
  let url: URL
  try { url = new URL(tarball) } catch { throw new UpdateFailure('invalid_manifest') }
  if (url.origin !== REGISTRY_ORIGIN || url.username || url.password || url.search || url.hash
    || url.pathname !== `/${UPDATE_PACKAGE}/-/${filename}`) {
    throw new UpdateFailure('invalid_manifest')
  }
  return Object.freeze({ package: UPDATE_PACKAGE, version, tarball, filename, integrity })
}

/** Pick the highest strictly versioned release in the registry document. */
function latestRelease(document: unknown): RegistryRelease | undefined {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new UpdateFailure('invalid_manifest')
  const versions = (document as Record<string, unknown>).versions
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) throw new UpdateFailure('invalid_manifest')
  let newest: RegistryRelease | undefined
  for (const [version, entry] of Object.entries(versions as Record<string, unknown>)) {
    if (!validVersion(version)) continue
    if (!entry || typeof entry !== 'object') continue
    const candidate = releaseFrom(version, (entry as Record<string, unknown>).dist)
    if (!newest || comparePluginVersions(candidate.version, newest.version) > 0) newest = candidate
  }
  return newest
}

/** Check the archive's integrity and identity before native installation can
 * execute package code. */
function verifyArchive(bytes: Buffer, release: RegistryRelease): void {
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (digest !== release.integrity || bytes.length > MAX_PACKAGE_BYTES) {
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

async function fetchBytes(url: string, limit: number, options: PluginUpdaterOptions): Promise<Buffer> {
  const target = new URL(url)
  if (target.origin !== REGISTRY_ORIGIN || target.username || target.password || target.hash
    || !(url === UPDATE_METADATA_URL || url.startsWith(`${REGISTRY_ORIGIN}/${UPDATE_PACKAGE}/-/`))) {
    throw new UpdateFailure('network')
  }
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
          Accept: url === UPDATE_METADATA_URL
            ? 'application/vnd.npm.install-v1+json'
            : 'application/octet-stream',
        },
      })
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

export function createPluginUpdater(options: PluginUpdaterOptions): PluginUpdater {
  if (!validVersion(options.currentVersion)) throw new Error('Invalid current plugin version')
  const directory = join(options.storageDirectory, 'updates')
  const receiptPath = join(directory, 'last-update.json')
  let release: RegistryRelease | undefined
  let receipt: Receipt | undefined
  let busy = false
  let snapshot: Omit<PluginUpdateSnapshot, 'canInstall'> = {
    phase: 'idle', currentVersion: options.currentVersion, latestVersion: null,
    checkedAt: null, error: null, restartReason: null,
  }
  try {
    const raw = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt
    if (!validVersion(raw.version) || typeof raw.integrity !== 'string'
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(raw.integrity)
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
    canInstall: !busy && snapshot.phase === 'available' && !!release && options.canInstall() && !!options.manager(),
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
  const checkRegistry = async () => {
    release = undefined
    const bytes = await fetchBytes(UPDATE_METADATA_URL, MAX_METADATA_BYTES, options)
    let parsed: unknown
    try { parsed = JSON.parse(bytes.toString()) } catch { throw new UpdateFailure('invalid_manifest') }
    const found = latestRelease(parsed)
    if (!found || comparePluginVersions(found.version, options.currentVersion) <= 0) {
      snapshot = { ...snapshot, phase: 'current', latestVersion: null,
        checkedAt: Date.now(), error: null, restartReason: null }
      return
    }
    release = found
    snapshot = { ...snapshot,
      phase: 'available', latestVersion: found.version,
      checkedAt: Date.now(), error: null, restartReason: null,
    }
  }
  return {
    status,
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
        await checkRegistry()
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
      if (snapshot.phase !== 'available' || !release) return status()
      if (expectedVersion !== release.version) {
        snapshot = { ...snapshot, error: 'update_changed' }
        return status()
      }
      if (!options.canInstall()) { snapshot = { ...snapshot, error: 'busy' }; return status() }
      const manager = options.manager()
      if (!manager) { snapshot = { ...snapshot, error: 'host_unavailable' }; return status() }
      const selected = release
      busy = true
      let handedOff = false
      let releaseLock: (() => Promise<void>) | undefined
      try {
        releaseLock = await options.acquireInstallLock()
        if (!options.canInstall()) throw new UpdateFailure('busy')
        snapshot = { ...snapshot, phase: 'downloading', error: null }
        const bytes = await fetchBytes(selected.tarball, MAX_PACKAGE_BYTES, options)
        verifyArchive(bytes, selected)
        // Keep the exact tarball: native pnpm records this file dependency and
        // may need it again after a restart or dependency repair.
        const cache = join(directory, createHash('sha256').update(selected.integrity).digest('hex'))
        await privateDirectory(directory)
        await privateDirectory(cache)
        const artifact = join(cache, selected.filename)
        try { await writeFile(artifact, bytes, { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const info = await lstat(artifact)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length) throw new UpdateFailure('integrity')
        if (process.platform !== 'win32') await chmod(artifact, 0o600)
        verifyArchive(await readFile(artifact), selected)
        {
          if (!options.canInstall()) throw new UpdateFailure('busy')
          const bundle = (await manager.listBundles()).find(value => value.name === UPDATE_PACKAGE)
          if (!bundle?.installed || bundle.availability !== 'profile') throw new UpdateFailure('host_unavailable')
          if (!options.canInstall()) throw new UpdateFailure('busy')
          if (bundle.version && comparePluginVersions(selected.version, bundle.version) <= 0) throw new UpdateFailure('host_refused')
          const nextReceipt: Receipt = { version: selected.version, integrity: selected.integrity,
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
          if (result.bundle !== UPDATE_PACKAGE || result.version !== selected.version
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
