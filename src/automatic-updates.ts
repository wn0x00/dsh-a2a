import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginUpdater, PluginUpdateSnapshot } from './plugin-update.js'

export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const RETRY_IDLE_MS = 60 * 1000
export type UpdateNotice = {
  id: string
  kind: 'available' | 'restart_required' | 'updated' | 'error'
  version: string | null
}
export type AutomaticUpdateStatus = {
  enabled: boolean
  nextCheckAt: number | null
  notice: UpdateNotice | null
}
type Schedule = {
  nextCheckAt: number | null
  pendingVersion: string | null
  attemptedVersion: string | null
  noticeKey: string | null
  notice: UpdateNotice | null
}

/** Runs in the Host, independently of Settings. An accepted native install is
 * owned by the Host and must never be awaited by plugin teardown. */
export function createAutomaticUpdates(base: PluginUpdater, options: {
  storageDirectory: string
  enabled(): boolean
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const directory = join(options.storageDirectory, 'updates')
  const path = join(directory, 'automatic-update.json')
  let schedule: Schedule = { nextCheckAt: null, pendingVersion: null, attemptedVersion: null, noticeKey: null, notice: null }
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Schedule
    if (saved.nextCheckAt !== null && (!Number.isFinite(saved.nextCheckAt) || saved.nextCheckAt! < 0)) throw new Error('schedule')
    for (const value of [saved.pendingVersion, saved.attemptedVersion, saved.noticeKey]) {
      if (value !== null && (typeof value !== 'string' || value.length > 200)) throw new Error('schedule')
    }
    if (saved.notice && (typeof saved.notice.id !== 'string' || saved.notice.id.length > 80
      || !['available', 'restart_required', 'updated', 'error'].includes(saved.notice.kind)
      || (saved.notice.version !== null && (typeof saved.notice.version !== 'string' || saved.notice.version.length > 80)))) throw new Error('notice')
    schedule = saved
    // Clock changes must not postpone a check indefinitely.
    if (schedule.nextCheckAt && schedule.nextCheckAt > now() + AUTO_UPDATE_INTERVAL_MS) schedule.nextCheckAt = now()
  } catch { /* Missing/corrupt scheduling metadata never authorizes an install. */ }
  let stopped = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const enabled = () => !stopped && options.enabled() === true
  const persist = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('storage')
    if (process.platform !== 'win32') chmodSync(directory, 0o700)
    const temporary = join(directory, `automatic-${randomUUID()}.json`)
    try {
      writeFileSync(temporary, JSON.stringify(schedule) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
  }
  const notify = (kind: UpdateNotice['kind'], snapshot: PluginUpdateSnapshot) => {
    const version = snapshot.latestVersion
    const key = `${kind}:${version ?? ''}:${snapshot.error ?? ''}`
    if (key === schedule.noticeKey) return
    schedule.noticeKey = key
    schedule.notice = { id: randomUUID(), kind, version }
    persist()
  }
  const report = (snapshot: PluginUpdateSnapshot) => {
    if (snapshot.phase === 'restart_required' || snapshot.phase === 'updated') notify(snapshot.phase, snapshot)
    else if (snapshot.phase === 'error' || snapshot.phase === 'outcome_unknown') notify('error', snapshot)
  }
  const run = async () => {
    if (!enabled()) return
    let snapshot = base.status()
    if (['checking', 'downloading', 'installing'].includes(snapshot.phase)) return
    // Never re-install a receipt whose result needs reconciliation or restart.
    if (['restart_required', 'outcome_unknown', 'updated'].includes(snapshot.phase)) {
      report(snapshot)
      if (snapshot.phase !== 'updated') return
    }
    const due = schedule.nextCheckAt === null || schedule.nextCheckAt <= now()
    const restorePending = schedule.pendingVersion !== null && snapshot.phase === 'idle'
    if (due || restorePending) {
      // Persist BEFORE network I/O: restarts and failed checks cannot hammer npm.
      schedule.nextCheckAt = now() + AUTO_UPDATE_INTERVAL_MS
      if (due) schedule.attemptedVersion = null
      persist()
      snapshot = await base.check(true)
      if (!enabled()) return
      schedule.pendingVersion = snapshot.phase === 'available' ? snapshot.latestVersion : null
      if (snapshot.phase === 'current' && ['available', 'error'].includes(schedule.notice?.kind ?? '')) {
        schedule.notice = null
        schedule.noticeKey = null
      }
      persist()
      report(snapshot)
    }
    if (!enabled() || snapshot.phase !== 'available' || !snapshot.latestVersion
      || schedule.pendingVersion !== snapshot.latestVersion) return
    if (!snapshot.canInstall) {
      notify('available', snapshot)
      return
    }
    if (schedule.attemptedVersion === snapshot.latestVersion) return
    schedule.attemptedVersion = snapshot.latestVersion
    persist()
    // The guard is rechecked by the updater at every await before handoff, so
    // disabling automatic updates while downloading prevents installation.
    snapshot = await base.install(snapshot.latestVersion, enabled)
    if (stopped) return
    if (snapshot.error === 'busy') {
      schedule.attemptedVersion = null
      // The next idle retry refreshes the frozen release if the updater lost it.
      if (snapshot.phase !== 'available') schedule.nextCheckAt = now() + RETRY_IDLE_MS
    } else {
      schedule.pendingVersion = null
    }
    persist()
    if (enabled()) report(snapshot)
  }
  const tick = (): Promise<void> => {
    if (flight) return flight
    flight = run().catch(() => {
      // No raw filesystem/network errors enter notifications; storage failure
      // stops automatic work until the next scheduled check.
      schedule.nextCheckAt = now() + AUTO_UPDATE_INTERVAL_MS
      schedule.pendingVersion = null
      schedule.notice = { id: randomUUID(), kind: 'error', version: null }
    }).finally(() => { flight = undefined })
    return flight
  }
  const arm = () => {
    clearTimeout(timer)
    if (!started || !enabled()) return
    timer = setTimeout(() => { void tick().finally(arm) }, RETRY_IDLE_MS)
    timer.unref()
  }
  const refresh = () => {
    clearTimeout(timer)
    if (!started || !enabled()) return
    void tick().finally(arm)
  }
  const updater: PluginUpdater = {
    status: () => ({ ...base.status(), automatic: {
      enabled: options.enabled() === true,
      nextCheckAt: options.enabled() === true ? schedule.nextCheckAt : null,
      notice: schedule.notice,
    } }),
    check: async (stableOnly) => { await base.check(stableOnly); return updater.status() },
    install: async (version, guard) => { await base.install(version, guard); return updater.status() },
  }
  return {
    updater, tick, refresh,
    start() { started = true; refresh() },
    stop() { stopped = true; clearTimeout(timer) },
  }
}
