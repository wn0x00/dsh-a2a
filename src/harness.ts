import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { openAuthorizationUrl } from './browser.js'
import { installConnectionControl } from './connection-control.js'
import { ConnectionActionError, type ConnectionSnapshot } from './connection-state.js'
import { createPluginUpdater, type NativePluginManager, type PluginUpdater } from './plugin-update.js'
import { PLUGIN_VERSION } from './release-config.js'
import { startOAuthCallbackServer, type OAuthCallbackServer } from './oauth-callback.js'
import { createBridge, type A2ABridge } from './plugin.js'
import { createPlatformBridgeConfig, deviceIdentity, platformStorageDirectory } from './platform.js'
import { HarnessSessionIndex } from './session-index.js'
import { installWorkspaceSettings, resolveWorkingDirectory } from './workspace-settings.js'
import type {
  A2AMessage,
  HarnessAgentHandle,
  HarnessContext,
  HarnessCordisContext,
  HarnessConfigString,
  HarnessPluginConfig,
  HarnessRunContext,
  HarnessRunResult,
  HarnessSessionEvent,
  HarnessWorkspace,
} from './types.js'

export const name = 'xbot-deepseek-harness-a2a'
export const inject = ['agents', 'agentDefaultModel', 'workspaceRegistry', 'sessions'] as const
export { Config } from './workspace-settings.js'

function inputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input)
}

function messageText(input: unknown): string {
  const message = input as Partial<A2AMessage> | null
  if (!message || message.role !== 'ROLE_USER' || !Array.isArray(message.parts) || !message.parts.length) {
    throw new Error('A2A Message must contain user text parts')
  }
  if (message.parts.some((part) => !part || typeof part.text !== 'string' || part.data !== undefined || part.raw !== undefined || part.uri !== undefined)) {
    throw new Error('This Harness Agent currently accepts text Message parts only')
  }
  const text = message.parts.map((part) => part.text).join('\n')
  if (!text.trim()) throw new Error('A2A Message text must not be empty')
  return text
}

function resultText(messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ type?: string; text?: string }> }>): string {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const text = assistant?.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  return text || 'Harness agent completed without a text response.'
}

function configuredString(value: HarnessConfigString | undefined): string | undefined {
  return (typeof value === 'string' ? value : value?.get())?.trim() || undefined
}

/** Provider failures sometimes echo request credentials. Keep summaries bounded
 * and never send raw tool arguments, stdout, or the complete session log. */
function diagnosticText(value: string): string {
  return value
    .replace(/\b(?:sk-|xa2a_)[A-Za-z0-9_-]+/gu, '[redacted]')
    .replace(/\bBearer\s+[^\s,;"'}]+/giu, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password)\b(["']?\s*[:=]\s*["']?)[^\s,"';&}]+/giu, '$1$2[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 500)
}

function failedTurn(events: readonly HarnessSessionEvent[], sessionId: string): Error | undefined {
  const ending = [...events].reverse().find((event) => event.type === 'turn/end')
  const reason = ending?.data?.reason
  if (reason?.kind === 'completed') return undefined
  const hints: Record<string, string> = {
    blocked: 'Harness 会话被阻止，请检查客户端的输入或审批提示。',
    'max-tokens': 'Harness 达到模型输出上限，请缩小任务后继续。',
    interrupted: 'Harness 会话被中断，请检查客户端运行状态。',
    aborted: 'Harness 会话已取消。',
  }
  const code = reason?.error?.code ?? reason?.kind ?? 'MISSING_TURN_END'
  const parts = [`Harness task did not complete (${diagnosticText(code)})`]
  if (reason?.error?.message) parts.push(diagnosticText(reason.error.message))
  else if (reason && hints[reason.kind]) parts.push(hints[reason.kind]!)
  if (reason?.error?.status) parts.push(`HTTP ${reason.error.status}`)
  const lastFailedTool = [...events].reverse().find((event) =>
    event.type === 'tool/result' && event.data?.message?.isError === true,
  )
  if (lastFailedTool) {
    const call = events.find((event) => event.type === 'tool/call'
      && event.data?.callId === lastFailedTool.data?.message?.toolCallId)
    const detail = lastFailedTool.data?.error
    parts.push(`工具 ${diagnosticText(call?.data?.name ?? 'unknown')}${detail?.code ? ` (${diagnosticText(detail.code)})` : ''}${detail?.reason ? `: ${diagnosticText(detail.reason)}` : ''}`)
  }
  parts.push(`DSH 会话: ${sessionId}`)
  return new Error(parts.join('；'))
}

export function createNativeHarnessContext(ctx: HarnessCordisContext, config: HarnessPluginConfig = {}, options: { sessionDirectory?: string } = {}): HarnessContext {
  const sessions = options.sessionDirectory ? new HarnessSessionIndex(options.sessionDirectory) : undefined
  const retained = new Map<string, HarnessAgentHandle>()
  let disposed = false
  let disposal: Promise<void> | undefined
  return {
    dispose: () => disposal ??= (async () => {
      disposed = true
      const handles = [...retained.values()]
      retained.clear()
      const outcomes = await Promise.allSettled(handles.map((handle) => handle.dispose()))
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason), 'Harness sessions could not be closed')
    })(),
    agents: {
      run: async (_skillId: string, input: unknown, runContext: HarnessRunContext): Promise<HarnessRunResult> => {
        if (disposed) throw new Error('Harness plugin has stopped')
        const native = runContext.executionMode === 'a2a-message'
        const sessionStore = ctx.get?.('sessions')
        const text = native ? messageText(input) : inputText(input)
        const selected = ctx.agentDefaultModel?.currentSelection?.()
        const provider = configuredString(config.provider) ?? (process.env.A2A_LLM_PROVIDER?.trim() || undefined) ?? selected?.provider
        const model = configuredString(config.model) ?? (process.env.A2A_LLM_MODEL?.trim() || undefined) ?? selected?.model
        const agentOptions = {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        }
        const presets = ctx.get?.('agentPresets')
        if (!presets) throw new Error('当前 Harness 未提供 Agent 模式服务，请使用支持的 Harness 0.2 版本并启用 Agent 模式。插件不会创建缺少工具和权限策略的会话。')
        const preset = await presets.resolve(configuredString(config.agentPreset))
        if (preset.broken) throw new Error(`Harness Agent 模式 ${preset.id} 不可用：${diagnosticText(preset.broken)}`)
        const setup = async (agentContext: unknown, agent: HarnessAgentHandle['agent']) => {
          if (agent.session.header?.agentPreset !== preset.id) {
            throw new Error('DSH 会话的 Agent 模式与本地记录不一致，请在平台开启新对话。')
          }
          // Follow DSH's durable model selection on a cold resume. Plugin
          // settings seed new sessions; they must not reset a model changed
          // later in DSH's native session controls or change host defaults.
          const pending = ctx.get?.('sessionProjections')?.stateOf(agent.session, 'modelSelection')?.pending
          const logged = agent.session.requestHeader?.()
          const restored = pending ?? logged?.config
          if (restored && agent.options) {
            agent.options.provider = restored.provider
            agent.options.model = restored.model
            const reasoningEffort = pending
              ? pending.reasoningEffort
              : logged?.adapterDefaults?.reasoningEffort ? undefined : logged?.config.reasoningEffort
            if (reasoningEffort) agent.options.reasoningEffort = reasoningEffort
            else delete agent.options.reasoningEffort
          }
          // Match DSH's native session controller: creation alone does not
          // attach a preset's isolated tools, prompts, and permission policies.
          await presets.mount(agentContext, preset.id)
        }
        async function execute(handle: HarnessAgentHandle, cwd: string, sessionId: string, workspace?: HarnessWorkspace, beforeRun?: () => Promise<void>): Promise<HarnessRunResult> {
          let keep = retained.get(sessionId) === handle
          const abort = () => {
            try {
              handle.agent.cancel?.({ kind: 'user' })
            } catch {
              // During host shutdown DSH may have already withdrawn its inbox
              // projection. EventTarget rethrows listener errors as uncaught
              // exceptions, so cancellation cannot throw from this callback.
              // The aborted run still waits for idle and its durability barrier.
            }
          }
          try {
            runContext.signal.throwIfAborted()
            if (native && handle.agent.session.header?.cwd !== cwd) {
              throw new Error('DSH 会话工作目录与本地记录不一致，请在平台开启新对话。')
            }
            if (handle.agent.session.header?.agentPreset !== preset.id) {
              throw new Error('DSH 会话的 Agent 模式与本地记录不一致，请在平台开启新对话。')
            }
            await beforeRun?.()
            await workspace?.attachSession(sessionId)
            runContext.signal.throwIfAborted()
            if (native) {
              retained.set(sessionId, handle)
              keep = true
            }
            if (handle.agent.status === 'running') {
              throw new Error('DSH 会话正在处理其他输入，请等待当前任务完成后重试。')
            }
            const priorEventCount = handle.agent.session.snapshotEvents?.().length ?? 0
            runContext.signal.addEventListener('abort', abort, { once: true })
            handle.agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            })
            await handle.agent.whenIdle()
            runContext.signal.throwIfAborted()
            if (handle.agent.session.snapshotEvents) {
              const error = failedTurn(handle.agent.session.snapshotEvents().slice(priorEventCount), sessionId)
              if (error) throw error
            }
            return { text: resultText(handle.agent.session.deriveMessages()) }
          } finally {
            runContext.signal.removeEventListener('abort', abort)
            // DSH emits api-session/removed when a live handle is disposed.
            // Keep normal native sessions visible and release them only with
            // the plugin. Explicit flush replaces close's durability barrier.
            if (keep) {
              if (!await sessionStore!.flush(handle.agent.session)) throw new Error('DSH 会话未连接持久化服务，无法确认任务记录已保存。')
            }
            else await handle.dispose()
          }
        }
        if (!native) {
          const cwd = await resolveWorkingDirectory(ctx, config)
          runContext.signal.throwIfAborted()
          const sessionId = `xbot-a2a-${randomUUID()}`
          return execute(await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: preset.id }, agentOptions, setup, signal: runContext.signal }), cwd, sessionId)
        }
        if (!sessions || !runContext.sessionScope || !ctx.get?.('sessionPersistence') || !sessionStore) {
          throw new Error('原生 A2A 对话需要本地授权和 Harness 会话持久化服务。')
        }
        const workspaces = ctx.get?.('workspaceRegistry')
        if (!workspaces) throw new Error('当前 Harness 未提供工作区服务，请启用原生工作区后重试。')
        return sessions.withContext(runContext.sessionScope, runContext.contextId, runContext.signal, async (binding, save) => {
          const selectedCwd = await resolveWorkingDirectory(ctx, config)
          runContext.signal.throwIfAborted()
          if (binding && binding.cwd !== selectedCwd) throw new Error('工作目录已更改，请在平台开启新对话；旧会话不会切换项目目录。')
          const workspace = await workspaces.create(selectedCwd)
          const cwd = workspace.path
          if (binding) {
            if (binding.cwd !== cwd) throw new Error('工作目录已更改，请在平台开启新对话；旧会话不会切换项目目录。')
            if (!binding.agentPreset) throw new Error('此对话由旧版插件创建，未绑定 Harness Agent 模式，请在平台开启新对话。')
            if (binding.agentPreset !== preset.id) throw new Error('Agent 模式已更改，请在平台开启新对话；旧会话不会切换工具和权限策略。')
            const live = retained.get(binding.sessionId)
            const registered = ctx.agents.get?.(binding.sessionId)
            if (live && (!ctx.agents.get || registered === live.agent)) return execute(live, cwd, binding.sessionId, workspace)
            if (live) {
              retained.delete(binding.sessionId)
              await live.dispose()
            }
            // A user can reopen a persisted plugin session in DSH before the
            // next remote turn. Reuse that writer without taking its ownership.
            if (registered) return execute({ agent: registered, dispose: async () => {} }, cwd, binding.sessionId, workspace)
            if (!ctx.agents.resume) throw new Error('当前 Harness 版本不支持恢复会话，请升级 Harness。')
            return execute(await ctx.agents.resume({ resumeSessionId: binding.sessionId, agentOptions, setup, signal: runContext.signal }), cwd, binding.sessionId, workspace)
          }
          const sessionId = `xbot-a2a-${randomUUID()}`
          return execute(await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: preset.id }, agentOptions, setup, signal: runContext.signal }), cwd, sessionId, workspace, () => save(cwd, sessionId, preset.id))
        })
      },
    },
    logger: {
      info: (message, fields) => console.info(`[${name}] ${message}`, fields ?? ''),
      warn: (message, fields) => console.warn(`[${name}] ${message}`, fields ?? ''),
      error: (message, fields) => console.error(`[${name}] ${message}`, fields ?? ''),
    },
    ui: {
      confirm: async (reason) => {
        const approved = config.approveRemoteTasks === true
        if (!approved) {
          console.warn(`[${name}] remote task approval denied by default: ${reason}`)
        }
        return approved
      },
    },
  }
}

/** Native DeepSeek Harness/Cordis entry. The host owns the effect lifecycle. */
export function apply(ctx: HarnessCordisContext, config: HarnessPluginConfig = {}): void {
  installWorkspaceSettings(ctx, config)
  ctx.effect(() => {
    let bridge: A2ABridge | undefined
    let harness: HarnessContext | undefined
    let callback: OAuthCallbackServer | undefined
    let callbackClosing = Promise.resolve()
    let callbackTimer: ReturnType<typeof setTimeout> | undefined
    let release: (() => Promise<void>) | undefined
    let disposed = false
    let connectionRequest = configuredString(config.connectionRequest)
    let identity = deviceIdentity(config)
    let settingsUpdate = Promise.resolve()
    let controlUpdate: Promise<void> | undefined
    let initialized = false
    let updating = false
    let updater: PluginUpdater | undefined
    let pluginManager: NativePluginManager | undefined
    if ('inject' in ctx) (ctx as unknown as Context).inject(['pluginManager'], (scope) => {
      pluginManager = scope.get('pluginManager') as unknown as NativePluginManager
      return () => { pluginManager = undefined }
    })
    // This is the host Loader's committed volatile-config event, also used by
    // native DSH settings services. It does not require a private desktop RPC.
    ctx.on?.('loader/volatile-update', () => {
      const nextRequest = configuredString(config.connectionRequest)
      const nextIdentity = deviceIdentity(config)
      const connect = nextRequest !== connectionRequest
      const changed = nextIdentity.name !== identity.name || nextIdentity.description !== identity.description
      connectionRequest = nextRequest
      identity = nextIdentity
      if (!connect && !changed) return
      settingsUpdate = settingsUpdate.then(async () => {
        await start
        if (disposed || updating) return
        if (!bridge) await initialize()
        if (!bridge || disposed) return
        if (changed) await bridge.updateIdentity(nextIdentity)
        if (connect) await bridge.connect()
      }).catch((error: unknown) => {
        if (!disposed) console.error(`[${name}] connection needs attention; retry from Settings`, error instanceof Error ? error.message : 'Unknown error')
      })
    })
    const closeCallback = () => {
      clearTimeout(callbackTimer)
      const active = callback
      callback = undefined
      // Do not await an active callback HTTP response from inside that response.
      if (active) callbackClosing = active.close()
    }
    updater = createPluginUpdater({
      currentVersion: PLUGIN_VERSION,
      storageDirectory: platformStorageDirectory(config, ctx.baseUrl),
      manager: () => pluginManager,
      canInstall: () => initialized && !disposed && !controlUpdate
        && (!bridge || (bridge.status().activeTasks === 0
          && !['starting', 'connecting', 'authorizing'].includes(bridge.status().phase))),
      acquireInstallLock: async () => {
        if (disposed || updating || !initialized || controlUpdate) {
          throw new ConnectionActionError('busy')
        }
        updating = true
        try {
          await settingsUpdate
          if (disposed) throw new ConnectionActionError('unavailable')
          await bridge?.pauseForUpdate()
        } catch (error) {
          updating = false
          throw error
        }
        return async () => {
          // A native install may unload this plugin. Its cleanup must never
          // wait for the install job owned by Plugin Manager itself.
          try {
            if (disposed || !bridge) return
            await bridge.updateIdentity(deviceIdentity(config))
            await bridge.start()
          } catch {
            console.warn(`[${name}] connection could not resume after updating; check Settings`)
          } finally {
            updating = false
          }
        }
      },
    })
    const initialize = async () => {
      const prepared = await createPlatformBridgeConfig(config, openAuthorizationUrl, ctx.baseUrl)
      release = prepared.release
      if (disposed) return
      prepared.config.oauth.prepareAuthorization = async () => {
        if (disposed) throw new Error('Harness plugin has stopped')
        closeCallback()
        await callbackClosing
        callback = await startOAuthCallbackServer(prepared.config.oauth.redirectUri, async (code, state) => {
          if (!bridge || disposed) throw new Error('A2A bridge is not running')
          await bridge.completeAuthorization(code, state)
        }, async (state) => {
          if (!bridge || disposed) throw new Error('A2A bridge is not running')
          await bridge.cancelAuthorization(state)
        })
        callbackTimer = setTimeout(() => {
          closeCallback()
          console.warn(`[${name}] authorization timed out; connect again from Harness settings`)
        }, 600_000)
        callbackTimer.unref()
      }
      prepared.config.oauth.authorizationCompleted = async () => { closeCallback() }
      harness = createNativeHarnessContext(ctx, config, { sessionDirectory: join(prepared.directory, 'sessions') })
      bridge = createBridge(harness, prepared.config)
      console.info(`[${name}] loaded; connecting to platform ${prepared.config.gatewayUrl}`)
      await bridge.start()
    }
    const start = initialize().catch(async (error: unknown) => {
      closeCallback()
      if (!bridge) {
        await release?.()
        release = undefined
      }
      if (!disposed) console.error(`[${name}] failed to start`, error instanceof Error ? error.message : 'Unknown error')
    }).finally(() => { initialized = true })

    // Standalone bridge consumers have no Cordis registry; the real Host does.
    if ('inject' in ctx) installConnectionControl(ctx as unknown as Context, {
      updater: () => updater,
      status: () => {
        const snapshot: ConnectionSnapshot = bridge?.status() ?? {
        phase: disposed ? 'stopped' : initialized ? 'error' : 'starting', notice: 'none',
        gatewayUrl: '', deviceId: '', deviceName: identity.name, activeTasks: 0,
        pendingExpiresAt: null, lastConnectedAt: null, lastContactAt: null,
        canConnect: initialized && !disposed && !controlUpdate, canReauthorize: false, canCancelAuthorization: false,
        }
        return updating
          ? { ...snapshot, phase: 'updating', canConnect: false, canReauthorize: false, canCancelAuthorization: false }
          : snapshot
      },
      act: async (action) => {
        if (disposed) throw new ConnectionActionError('unavailable')
        if (controlUpdate || updating) throw new ConnectionActionError('busy')
        const pending = (async () => {
          await start
          await settingsUpdate
          if (disposed) throw new ConnectionActionError('unavailable')
          if (!bridge) await initialize()
          if (!bridge || disposed) throw new ConnectionActionError('unavailable')
          await bridge[action]()
        })()
        controlUpdate = pending
        try { await pending } finally { controlUpdate = undefined }
      },
    })

    return async () => {
      disposed = true
      // Fence the bridge before draining HTTP callbacks. A slow code exchange
      // may finish during shutdown, but must not register or claim new work.
      const stopping = bridge?.stop()
      void stopping?.catch(() => undefined)
      await start.catch(() => undefined)
      await settingsUpdate
      await controlUpdate?.catch(() => undefined)
      closeCallback()
      // An in-flight callback may still be registering. Drain it before
      // stopping the bridge so it cannot start a loop after teardown.
      await callbackClosing
      try {
        await stopping
      } finally {
        try {
          await harness?.dispose?.()
        } finally {
          // A failed persistence close must not strand this live process's
          // profile lock after all retained handles have drained their teardown.
          closeCallback()
          await callbackClosing
          const unlock = release
          release = undefined
          await unlock?.()
        }
      }
    }
  })
}
