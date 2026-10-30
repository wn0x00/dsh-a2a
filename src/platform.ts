import { hostname } from 'node:os'

import { lockProfile, persistentDeviceId, PersistentTokenStore, profileStorageDirectory, stateStorageDirectory } from './token-store.js'
import type { BridgeConfig, HarnessPluginConfig } from './types.js'
import { A2A_MESSAGE_CAPABILITY } from './types.js'

export const DEFAULT_REDIRECT = 'http://127.0.0.1:43127/oauth/callback'
const DEVICE_SCOPES = ['device.connect', 'device.task.receive', 'device.task.report']

/** No platform address is built in. The user configures one in the plugin
 * settings (persisted by the host), through A2A_GATEWAY_URL, or the CLI. */
export class PlatformNotConfiguredError extends Error {
  readonly code = 'platform/not-configured'
  constructor() {
    super('Platform address is not configured. Set the platform URL in the plugin settings or A2A_GATEWAY_URL.')
  }
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

export function configuredString(value: HarnessPluginConfig['deviceName']): string {
  return typeof value === 'string' ? value : (value?.get() ?? '')
}

/** The configured platform address before validation; '' when absent. */
export function configuredGatewayUrl(config: HarnessPluginConfig): string {
  return configuredString(config.gatewayUrl).trim() || process.env.A2A_GATEWAY_URL?.trim() || ''
}

/** A platform address is an HTTPS origin, or loopback HTTP for local development. */
export function normalizePlatformOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || /\s/u.test(value)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('Platform URL must be an HTTPS origin or local loopback HTTP origin')
  }
  return url.origin
}

export function deviceIdentity(config: HarnessPluginConfig): { name: string; description: string } {
  return {
    name: configuredString(config.deviceName).trim() || env('A2A_DEVICE_NAME', `DeepSeek Harness (${hostname()})`),
    description: configuredString(config.deviceDescription).trim(),
  }
}

function profileName(): string {
  const index = process.argv.indexOf('--profile')
  return (index >= 0 ? process.argv[index + 1] : undefined)
    ?? process.argv.find((arg) => arg.startsWith('--profile='))?.slice(10)
    ?? 'desktop'
}

function safeEndpoint(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Authorization metadata has no ${label}`)
  const url = new URL(value)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error(`${label} must use HTTPS or local loopback HTTP`)
  }
  return url.toString()
}

function profileScope(config: HarnessPluginConfig, profileBaseUrl?: string): string {
  const external = (config.authMode ?? env('A2A_AUTH_MODE', 'platform')) === 'external'
  const profile = config.profile ?? process.env.A2A_PROFILE?.trim() ?? profileBaseUrl ?? profileName()
  return `${external ? 'external' : 'platform'}:${profile}`
}

/** Resolve storage without contacting the platform, including for self-update. */
export function platformStorageDirectory(config: HarnessPluginConfig, profileBaseUrl?: string): string {
  const configured = configuredGatewayUrl(config)
  if (!configured) throw new PlatformNotConfiguredError()
  return profileStorageDirectory(normalizePlatformOrigin(configured), profileScope(config, profileBaseUrl), config.storageDirectory)
}

/** Update checks target the public npm registry, not the configured platform,
 * so their storage is isolated by local profile only. */
export function updateStorageDirectory(config: HarnessPluginConfig, profileBaseUrl?: string): string {
  return stateStorageDirectory('plugin-updates', profileScope(config, profileBaseUrl), config.storageDirectory)
}

/** Shared by the native Cordis adapter and the explicit diagnostic runner. */
export async function createPlatformBridgeConfig(
  config: HarnessPluginConfig,
  openAuthorizationUrl: (url: string) => Promise<void> | void,
  profileBaseUrl?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ config: BridgeConfig; directory: string; release: () => Promise<void> }> {
  const configured = configuredGatewayUrl(config)
  if (!configured) throw new PlatformNotConfiguredError()
  const gatewayUrl = normalizePlatformOrigin(configured)
  const external = (config.authMode ?? env('A2A_AUTH_MODE', 'platform')) === 'external'
  const directory = profileStorageDirectory(gatewayUrl, profileScope(config, profileBaseUrl), config.storageDirectory)
  const release = await lockProfile(directory)
  try {
    const identity = await persistentDeviceId(directory)
    const executionMode = config.executionMode ?? 'a2a-message'
    const capabilities = (config.capabilities ?? ['workspace.read', 'workspace.write'])
      .filter((value) => value !== A2A_MESSAGE_CAPABILITY)
    if (executionMode === 'a2a-message') capabilities.push(A2A_MESSAGE_CAPABILITY)
    const device = {
      // Legacy A2A_DEVICE_ID is intentionally not inherited in platform mode.
      id: config.deviceId ?? (external ? env('A2A_DEVICE_ID', identity) : identity),
      ...deviceIdentity(config),
      platform: config.platform ?? (process.platform === 'win32' ? 'windows' : process.platform),
      capabilities: [...new Set(capabilities)],
    }
    const issuer = external ? config.issuerUrl ?? process.env.A2A_OIDC_ISSUER_URL?.trim() : undefined
    if (external && !issuer) throw new Error('External authentication requires issuerUrl or A2A_OIDC_ISSUER_URL')
    const metadataUrl = external
      ? `${safeEndpoint(issuer, 'issuer URL').replace(/\/$/u, '')}/.well-known/openid-configuration`
      : new URL('/api/a2a/oauth/metadata', gatewayUrl).toString()
    const response = await fetchImpl(metadataUrl)
    if (!response.ok) throw new Error(`Authorization metadata unavailable (${response.status})`)
    const metadata = await response.json() as Record<string, unknown>
    const tokenEndpoint = safeEndpoint(metadata.token_endpoint, 'token_endpoint')
    const requestEndpoint = external ? undefined : safeEndpoint(metadata.authorization_request_endpoint ?? new URL('/api/a2a/oauth/requests', gatewayUrl).toString(), 'authorization_request_endpoint')
    const revocationEndpoint = metadata.revocation_endpoint ? safeEndpoint(metadata.revocation_endpoint, 'revocation_endpoint') : undefined
    if (!external && [tokenEndpoint, requestEndpoint, revocationEndpoint].some((endpoint) => endpoint && new URL(endpoint).origin !== new URL(gatewayUrl).origin)) {
      throw new Error('Platform credential endpoints must belong to the configured platform')
    }
    const allowedSkills = executionMode === 'legacy-skill'
      ? config.allowedSkills ?? env('A2A_ALLOWED_SKILLS', 'demo.echo').split(',').map((value) => value.trim()).filter(Boolean)
      : []
    return {
      release,
      directory,
      config: {
        gatewayUrl, transport: 'pull', device, allowedSkills, executionMode,
        pollIntervalMs: config.pollIntervalMs ?? 3000,
        fetch: fetchImpl,
        oauth: {
          clientId: config.clientId ?? env('A2A_OIDC_CLIENT_ID', 'dsh-a2a'),
          authorizationEndpoint: safeEndpoint(metadata.authorization_endpoint, 'authorization_endpoint'),
          tokenEndpoint,
          ...(requestEndpoint ? { authorizationRequestEndpoint: requestEndpoint } : {}),
          ...(revocationEndpoint ? { revocationEndpoint } : {}),
          device,
          redirectUri: config.redirectUri ?? env('A2A_OAUTH_REDIRECT_URI', DEFAULT_REDIRECT),
          scopes: external ? config.scopes ?? env('A2A_OIDC_SCOPES', 'openid offline_access device.connect device.task.receive device.task.report').split(/\s+/u) : DEVICE_SCOPES,
          tokenStore: new PersistentTokenStore(directory),
          openAuthorizationUrl,
        },
      },
    }
  } catch (error) {
    await release()
    throw error
  }
}
