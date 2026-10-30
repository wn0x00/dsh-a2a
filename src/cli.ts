#!/usr/bin/env node
import { startOAuthCallbackServer, type OAuthCallbackServer } from './oauth-callback.js'
import { createPlatformBridgeConfig, normalizePlatformOrigin } from './platform.js'
import { persistedPlatformUrl, persistPlatformUrl } from './token-store.js'
import { openAuthorizationUrl } from './browser.js'
import { createBridge } from './plugin.js'
import type { HarnessContext } from './types.js'

function gatewayArgument(): string | undefined {
  const index = process.argv.indexOf('--gateway')
  return (index >= 0 ? process.argv[index + 1] : undefined)
    ?? process.argv.find((arg) => arg.startsWith('--gateway='))?.slice('--gateway='.length)
}

/** Explicit transport diagnostic. Actual remote execution uses the DSH bundle.
 * There is no built-in platform address: pass --gateway (persisted for later
 * runs) or set A2A_GATEWAY_URL. */
async function main(): Promise<void> {
  const explicit = gatewayArgument() ?? (process.env.A2A_GATEWAY_URL?.trim() || undefined)
  if (explicit) await persistPlatformUrl(normalizePlatformOrigin(explicit))
  const gatewayUrl = explicit ?? await persistedPlatformUrl()
  if (!gatewayUrl) {
    console.error('No platform address configured. Pass --gateway https://platform.example.com (saved for future runs) or set A2A_GATEWAY_URL.')
    process.exitCode = 1
    return
  }
  const prepared = await createPlatformBridgeConfig({ executionMode: 'legacy-skill', gatewayUrl }, openAuthorizationUrl, 'diagnostic')
  let callback: OAuthCallbackServer | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const closeCallback = () => {
    clearTimeout(timer)
    const active = callback
    callback = undefined
    if (active) void active.close()
  }
  const context: HarnessContext = {
    agents: { run: async (skillId, input) => ({ text: `[demo:${skillId}] ${typeof input === 'string' ? input : JSON.stringify(input)}` }) },
    logger: {
      info: (message) => console.info(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    },
    ui: { confirm: async () => true },
  }
  prepared.config.oauth.prepareAuthorization = async () => {
    if (callback) await callback.close()
    callback = await startOAuthCallbackServer(prepared.config.oauth.redirectUri, async (code, state) => {
      await bridge.completeAuthorization(code, state)
      console.info('Device connected. Waiting for A2A tasks.')
    }, async (state) => {
      await bridge.cancelAuthorization(state)
    }, { openDesktop: false })
    timer = setTimeout(() => {
      closeCallback()
      console.warn('Authorization expired. Restart the runner to retry.')
    }, 600_000)
    timer.unref()
  }
  prepared.config.oauth.authorizationCompleted = async () => { closeCallback() }
  const bridge = createBridge(context, prepared.config)
  try {
    if (process.argv.includes('--logout')) {
      await bridge.logout()
      console.info('Device authorization revoked; saved credentials removed.')
      return
    }
    console.info(`Diagnostic gateway: ${prepared.config.gatewayUrl}`)
    await bridge.connect()
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await bridge.stop()
    closeCallback()
    await prepared.release()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Diagnostic startup failed')
  process.exitCode = 1
})
