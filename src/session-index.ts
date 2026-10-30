import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LocalSessionBinding {
  version: 1
  sessionId: string
  cwd: string
  /** Absent only for pre-preset plugin sessions, which cannot safely resume. */
  agentPreset?: string
}

/** Only locally minted IDs enter this index. Remote context IDs and local
 * authorization epochs are hashed together; neither can name a DSH session. */
export class HarnessSessionIndex {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly directory: string) {}

  async withContext<T>(scope: string, contextId: string, signal: AbortSignal,
    callback: (binding: LocalSessionBinding | undefined, save: (cwd: string, sessionId: string, agentPreset: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    if (!scope || !contextId) throw new Error('A2A session requires a local authorization scope and contextId')
    const key = createHash('sha256').update(JSON.stringify([scope, contextId])).digest('hex')
    const prior = this.pending.get(key) ?? Promise.resolve()
    const task = prior.catch(() => undefined).then(async () => {
      signal.throwIfAborted()
      const file = join(this.directory, `${key}.json`)
      let binding: LocalSessionBinding | undefined
      try {
        binding = JSON.parse(await readFile(file, 'utf8')) as LocalSessionBinding
        if (binding.version !== 1 || !/^dsh-a2a-[a-f0-9-]{36}$/u.test(binding.sessionId) || typeof binding.cwd !== 'string' || !binding.cwd || (binding.agentPreset !== undefined && (typeof binding.agentPreset !== 'string' || !binding.agentPreset))) {
          throw new Error('Invalid session mapping')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本地会话索引无法读取，请在平台开启新对话。')
      }
      return callback(binding, async (cwd, sessionId, agentPreset) => {
        if (binding) throw new Error('Cannot replace an existing local session binding')
        if (!/^dsh-a2a-[a-f0-9-]{36}$/u.test(sessionId)) throw new Error('Invalid plugin-owned session id')
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') await chmod(this.directory, 0o700)
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, sessionId, cwd, agentPreset }), { flag: 'wx', mode: 0o600 })
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true })
        }
      })
    })
    const tail = task.then(() => undefined, () => undefined)
    this.pending.set(key, tail)
    try { return await task } finally {
      if (this.pending.get(key) === tail) this.pending.delete(key)
    }
  }
}
