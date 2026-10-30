import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { normalizePlatformOrigin } from './platform.js'
import type { HarnessCordisContext, HarnessPluginConfig } from './types.js'

// Keep the schema browser-safe: DSH serializes volatile fields into configForms.
// Host-only validation belongs to internal/config, never to a schema callback.
export const Config = z
  .object({
    automaticUpdates: z.boolean().default(false).volatile(),
    gatewayUrl: z.string().max(500).default('').volatile(),
    deviceName: z.string().max(200).default('').volatile(),
    deviceDescription: z.string().max(1000).default('').volatile(),
    connectionRequest: z.string().max(128).default('').volatile(),
    workingDirectory: z.string().default('').volatile(),
    agentPreset: z.string().default('').volatile(),
    provider: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
  })
  .loose()

export function configuredWorkingDirectory(
  config: HarnessPluginConfig,
): string {
  const value = config.workingDirectory
  return typeof value === 'string' ? value : (value?.get() ?? '')
}

export function isFullyQualifiedDirectory(
  path: string,
  platform = process.platform,
): boolean {
  if (!path || path.includes('\0')) return false
  if (platform !== 'win32') return isAbsolute(path)
  // A drive-relative C:folder or root-relative \\folder depends on ambient state.
  // Device namespaces are not project directories. Normal UNC shares are valid.
  if (/^[\\/]{2}[.?][\\/]/u.test(path)) return false
  return (
    /^[A-Za-z]:[\\/]/u.test(path) ||
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path)
  )
}

export function validateHostDirectory(path: unknown): string {
  if (typeof path !== 'string' || !isFullyQualifiedDirectory(path)) {
    throw new Error('工作目录必须是本机文件夹的完整绝对路径。')
  }
  try {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    throw new Error('工作目录不存在、不是文件夹或无法访问，请重新选择。')
  }
}

function executionPath(ctx: HarnessCordisContext, canonical: string): string {
  const fs = ctx.get?.('fs')
  if (!fs) return canonical
  const mapped = fs.processPathFromHostPath?.(canonical)
  if (!mapped)
    throw new Error(
      '当前 Harness 文件系统无法访问所选本机目录，请使用本地工作区。',
    )
  return mapped
}

/** DSH calls this hook before persisting an edit, then updates the volatile
 * value without restarting the bridge or interrupting an active task. */
export function installWorkspaceSettings(
  ctx: HarnessCordisContext,
  config: HarnessPluginConfig,
): void {
  ctx.on?.('internal/config', function (raw, next) {
    const candidate = next() as Record<string, unknown>
    // Cordis supplies a traced fiber proxy to plugins; the config editor
    // dispatches the original fiber. Compare the root-unique runtime uid too.
    if (this !== ctx.fiber &&
      (ctx.fiber?.uid === undefined || this.uid !== ctx.fiber.uid))
      return candidate
    // The platform address persists as a normalized origin; it is never a
    // credential, so the plain string value may stay in the host config.
    const platform = candidate?.gatewayUrl
    if (typeof platform === 'string' && platform.trim()) {
      try {
        candidate.gatewayUrl = normalizePlatformOrigin(platform.trim())
      } catch {
        throw new Error('平台地址必须是 HTTPS 源站（如 https://platform.example.com），本机调试才允许 http://127.0.0.1 回环地址。')
      }
    } else if (platform !== undefined) {
      candidate.gatewayUrl = ''
    }
    const value = candidate?.workingDirectory
    if (value !== undefined && value !== '') {
      executionPath(ctx, validateHostDirectory(value))
    }
    // Preset resolution waits for the Host Loader and is asynchronous. It is
    // validated by the executor before starting a task, not this sync hook.
    // A model is one provider/model route. An incomplete pair would silently
    // mix the selected model with an unrelated host default.
    if (Boolean(candidate.provider) !== Boolean(candidate.model)) {
      throw new Error(
        '请选择完整的模型，或同时清空服务商和模型以跟随 Harness 默认值。',
      )
    }
    return candidate
  })
  // An invalid directory on disk should remain editable in Settings. Task
  // execution fails closed until it is repaired; don't unload the config page.
  const initial = configuredWorkingDirectory(config)
  if (initial) {
    try {
      executionPath(ctx, validateHostDirectory(initial))
    } catch (error) {
      console.warn(
        '[dsh-a2a] working directory requires attention:',
        error instanceof Error ? error.message : 'Invalid directory',
      )
    }
  }
}

export async function resolveWorkingDirectory(
  ctx: HarnessCordisContext,
  config: HarnessPluginConfig,
): Promise<string> {
  const selected = configuredWorkingDirectory(config)
  const fs = ctx.get?.('fs')
  if (!selected) {
    if (!fs) return validateHostDirectory(process.cwd())
    const target = await fs.resolve('.')
    if (fs.stat && (await fs.stat(target))?.type !== 'directory') {
      throw new Error(
        'Harness 默认工作目录不存在或不是文件夹，请在插件设置中选择工作目录。',
      )
    }
    return fs.processPath(target)
  }
  const canonical = validateHostDirectory(selected)
  if (!fs) return canonical
  const target = await fs.resolve(executionPath(ctx, canonical))
  if (!fs.stat || (await fs.stat(target))?.type !== 'directory') {
    throw new Error('所选工作目录在当前 Harness 文件系统中不可用。')
  }
  return fs.processPath(target)
}
