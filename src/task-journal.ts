import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskDiagnostic, TaskEvent } from './types.js'

export type TaskRecord = {
  version: 1
  task_id: string
  context_id: string
  deliveries: string[]
  phase: 'running' | 'finished'
  updated_at: string
  diagnostics: TaskDiagnostic[]
  pending: TaskEvent[]
  local_session_id?: string
  terminal?: TaskEvent
  rejected?: Array<{ event_id: string; reason: string }>
}

const RESPONSE_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'])

/** One file per task, isolated by the locally minted OAuth authorization epoch.
 * No task input, credentials, model prompts or raw native tool events are stored. */
export class TaskJournal {
  private records = new Map<string, TaskRecord>()
  private tail: Promise<void> = Promise.resolve()
  private readonly directory: string

  constructor(directory: string, scope: string) {
    if (!scope) throw new Error('Task journal requires an authorization scope')
    this.directory = join(directory, createHash('sha256').update(scope).digest('hex'))
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const row = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as TaskRecord
      if (row.version !== 1 || !row.task_id || !Array.isArray(row.pending) || !Array.isArray(row.deliveries) || !Array.isArray(row.diagnostics)) {
        throw new Error('Local task journal is invalid; execution has not resumed')
      }
      if (row.phase === 'finished' && row.pending.length === 0 && Date.parse(row.updated_at) < Date.now() - 30 * 86400_000) {
        await rm(join(this.directory, name)); continue
      }
      this.records.set(row.task_id, row)
    }
  }

  list(): TaskRecord[] { return structuredClone([...this.records.values()]) }
  get(taskId: string): TaskRecord | undefined {
    const row = this.records.get(taskId)
    return row ? structuredClone(row) : undefined
  }

  async begin(taskId: string, contextId: string, deliveryId: string): Promise<boolean> {
    let started = false
    await this.change(taskId, (previous) => {
      if (previous?.deliveries.includes(deliveryId)) return previous
      started = true
      return { version: 1, task_id: taskId, context_id: contextId,
        deliveries: [...(previous?.deliveries ?? []), deliveryId].slice(-100),
        phase: 'running', updated_at: new Date().toISOString(), diagnostics: previous?.diagnostics ?? [],
        pending: previous?.pending ?? [], ...(previous?.local_session_id ? { local_session_id: previous.local_session_id } : {}) }
    })
    return started
  }

  async enqueue(taskId: string, event: TaskEvent): Promise<void> {
    await this.change(taskId, (row) => {
      if (!row) throw new Error('Task journal record is missing')
      if (!event.event_id) throw new Error('Durable events require event_id')
      if (row.pending.some((item) => item.event_id === event.event_id)) return row
      if (event.diagnostics) {
        row.diagnostics = [...row.diagnostics, event.diagnostics].slice(-200)
        if (event.diagnostics.local_session_id) row.local_session_id = event.diagnostics.local_session_id
        // Keep the newest offline heartbeat rather than accumulating one every
        // 30 seconds. Meaningful events and terminal results remain ordered.
        if (event.diagnostics.kind === 'heartbeat') row.pending = row.pending.filter((item) => item.diagnostics?.kind !== 'heartbeat')
      }
      row.pending.push(structuredClone(event))
      // Bound offline diagnostic storage without ever discarding state/results.
      const excess = row.pending.filter((item) => !item.state).length - 1000
      if (excess > 0) {
        let remaining = excess
        row.pending = row.pending.filter((item) => item.state || remaining-- <= 0)
      }
      if (event.state && RESPONSE_STATES.has(event.state)) { row.phase = 'finished'; row.terminal = structuredClone(event) }
      row.updated_at = new Date().toISOString()
      return row
    })
  }

  async reject(taskId: string, eventId: string, reason: string): Promise<void> {
    await this.change(taskId, (row) => {
      if (!row) throw new Error('Task journal record is missing')
      row.pending = row.pending.filter((item) => item.event_id !== eventId)
      row.rejected = [...(row.rejected ?? []), { event_id: eventId, reason }].slice(-20)
      row.updated_at = new Date().toISOString()
      return row
    })
  }

  async acknowledge(taskId: string, eventId: string): Promise<void> {
    await this.change(taskId, (row) => {
      if (!row) throw new Error('Task journal record is missing')
      row.pending = row.pending.filter((item) => item.event_id !== eventId)
      return row
    })
  }

  async markFinished(taskId: string): Promise<void> {
    await this.change(taskId, (row) => {
      if (!row) throw new Error('Task journal record is missing')
      row.phase = 'finished'; row.updated_at = new Date().toISOString()
      return row
    })
  }

  async finish(taskId: string): Promise<void> {
    await this.change(taskId, (row) => {
      if (!row) throw new Error('Task journal record is missing')
      row.phase = 'finished'; row.pending = []; row.updated_at = new Date().toISOString()
      return row
    })
  }

  private async change(taskId: string, mutate: (row: TaskRecord | undefined) => TaskRecord): Promise<void> {
    const work = this.tail.then(async () => {
      const row = mutate(this.get(taskId))
      const filename = join(this.directory, createHash('sha256').update(taskId).digest('hex') + '.json')
      const temporary = filename + '.' + randomUUID() + '.tmp'
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(row)); await file.sync() } finally { await file.close() }
        await rename(temporary, filename)
        // fsync the directory entry on POSIX as well as the data file, so a
        // machine crash cannot acknowledge an event whose rename was lost.
        if (process.platform !== 'win32') {
          const directory = await open(this.directory, 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
        this.records.set(taskId, row)
      } finally { await rm(temporary, { force: true }) }
    })
    this.tail = work.catch(() => undefined)
    return work
  }
}
