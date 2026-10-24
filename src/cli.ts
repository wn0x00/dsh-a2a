#!/usr/bin/env node
import { openAuthorizationUrl } from './browser.js'
import { startOAuthCallbackServer, type OAuthCallbackServer } from './oauth-callback.js'
import { createPlatformBridgeConfig } from './platform.js'
import { createBridge } from './plugin.js'
import type { HarnessContext } from './types.js'

/** Explicit transport diagnostic. Actual remote execution uses the DSH bundle. */
async function main(): Promise<void> {
  const prepared = await createPlatformBridgeConfig({ executionMode: 'legacy-skill' }, openAuthorizationUrl, 'diagnostic')
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
