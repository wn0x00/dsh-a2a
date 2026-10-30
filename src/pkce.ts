import type { OAuthConfig, TokenSet, TokenStore } from './types.js'

const encoder = new TextEncoder()

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function randomUrlValue(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function challenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(verifier),
  )
  return base64Url(new Uint8Array(digest))
}

export class MemoryTokenStore implements TokenStore {
  private tokens: TokenSet | undefined

  async get(): Promise<TokenSet | undefined> {
    return this.tokens
  }

  async set(tokens: TokenSet): Promise<void> {
    this.tokens = tokens
  }

  async clear(): Promise<void> {
    this.tokens = undefined
  }
}

type TokenResponse = {
  access_token?: unknown
  refresh_token?: unknown
  token_type?: unknown
  expires_in?: unknown
  scope?: unknown
}

export type AuthorizationRequest = {
  url: string
  state: string
  verifier: string
}

export class OAuthLoginRequiredError extends Error {
  constructor() { super('OAuth login is required') }
}

export class OAuthClient {
  private readonly store: TokenStore
  private pending: (AuthorizationRequest & { expiresAt: number }) | undefined
  private authorizationPromise: Promise<AuthorizationRequest> | undefined
  private refreshPromise: Promise<string> | undefined

  constructor(
    private readonly config: OAuthConfig,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl
    this.store = config.tokenStore ?? new MemoryTokenStore()
  }

  private readonly fetchImpl: typeof globalThis.fetch

  pendingExpiresAt(): number | null {
    return this.pending?.expiresAt ?? null
  }

  validateAuthorizationState(state: string): void {
    if (!this.pending || this.pending.state !== state || this.pending.expiresAt <= Date.now()) {
      throw new Error('OAuth state is missing or does not match')
    }
  }

  async hasCredentials(): Promise<boolean> {
    return Boolean(await this.store.get())
  }

  async clearPendingAuthorization(): Promise<void> {
    this.pending = undefined
    await this.config.authorizationCompleted?.()
  }

  async beginAuthorization(restart = false): Promise<AuthorizationRequest> {
    if (restart && this.pending) {
      this.pending = undefined
      await this.config.authorizationCompleted?.()
    }
    if (this.pending && this.pending.expiresAt > Date.now()) return this.pending
    if (this.authorizationPromise) return this.authorizationPromise
    this.authorizationPromise = this.createAuthorization()
    try { return await this.authorizationPromise } finally { this.authorizationPromise = undefined }
  }

  private async createAuthorization(): Promise<AuthorizationRequest> {
    const state = randomUrlValue()
    const verifier = randomUrlValue(48)
    const parameters = {
      response_type: 'code', client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri, scope: this.config.scopes.join(' '),
      state, code_challenge: await challenge(verifier), code_challenge_method: 'S256',
    }
    let url = new URL(this.config.authorizationEndpoint)
    let expiresIn = 600
    if (this.config.authorizationRequestEndpoint) {
      const device = this.config.device
      if (!device) throw new Error('Platform authorization requires a device identity')
      const response = await this.fetchImpl(this.config.authorizationRequestEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...parameters, device_id: device.id, device_name: device.name, platform: device.platform ?? 'windows' }),
      })
      if (!response.ok) throw new Error(`Platform authorization request failed (${response.status})`)
      const payload = await response.json() as { authorization_url?: unknown; expires_in?: unknown }
      if (typeof payload.authorization_url !== 'string') throw new Error('Platform did not return an authorization URL')
      url = new URL(payload.authorization_url)
      if (url.origin !== new URL(this.config.authorizationEndpoint).origin || url.pathname !== new URL(this.config.authorizationEndpoint).pathname) {
        throw new Error('Platform returned an unexpected authorization destination')
      }
      if (typeof payload.expires_in === 'number') expiresIn = Math.min(600, Math.max(1, payload.expires_in))
    } else {
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
    }
    await this.config.prepareAuthorization?.()
    const pending = { url: url.toString(), state, verifier, expiresAt: Date.now() + expiresIn * 1000 }
    this.pending = pending
    try { await this.config.openAuthorizationUrl(pending.url) } catch (error) {
      this.pending = undefined
      await this.config.authorizationCompleted?.()
      throw error
    }
    return pending
  }

  async completeAuthorization(code: string, state: string): Promise<TokenSet> {
    const pending = this.pending
    if (!pending || pending.state !== state || pending.expiresAt <= Date.now()) {
      throw new Error('OAuth state is missing or does not match')
    }
    this.pending = undefined
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_verifier: pending.verifier,
    })
    let tokens: TokenSet
    try {
      // A refused replacement code must not erase the still-valid old grant.
      // Only refresh-token rejection proves that the stored grant is invalid.
      tokens = await this.exchange(body, false)
    } catch (error) {
      await this.config.authorizationCompleted?.()
      throw error
    }
    // New consent starts a new local conversation scope, including when a
    // different platform account authorizes the same installed plugin.
    tokens.sessionScope = randomUrlValue()
    await this.store.set(tokens)
    await this.config.authorizationCompleted?.()
    return tokens
  }

  async cancelAuthorization(state: string): Promise<void> {
    if (!this.pending || this.pending.state !== state) {
      throw new Error('OAuth state is missing or does not match')
    }
    this.pending = undefined
    await this.config.authorizationCompleted?.()
  }

  async accessToken(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.readOrRefreshToken()
    try { return await this.refreshPromise } finally { this.refreshPromise = undefined }
  }

  private async readOrRefreshToken(): Promise<string> {
    const current = await this.store.get()
    if (current && current.expiresAt > Date.now() + 60_000) {
      if (!current.sessionScope) {
        current.sessionScope = randomUrlValue()
        await this.store.set(current)
      }
      return current.accessToken
    }
    if (!current?.refreshToken) {
      throw new OAuthLoginRequiredError()
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: this.config.clientId,
    })
    const refreshed = await this.exchange(body)
    // Some providers omit refresh_token during rotation. Preserve the old one.
    const tokens: TokenSet = refreshed.refreshToken
      ? refreshed
      : { ...refreshed, refreshToken: current.refreshToken }
    tokens.sessionScope = current.sessionScope ?? randomUrlValue()
    await this.store.set(tokens)
    return tokens.accessToken
  }

  async sessionScope(): Promise<string> {
    await this.accessToken()
    const current = await this.store.get()
    if (!current?.sessionScope) throw new OAuthLoginRequiredError()
    return current.sessionScope
  }

  /** Confirm revocation before discarding the credential needed to retry it. */
  async revokeAuthorization(): Promise<void> {
    if (this.refreshPromise) await this.refreshPromise.catch(() => undefined)
    const tokens = await this.store.get()
    if (tokens) {
      if (!this.config.revocationEndpoint) throw new Error('The platform does not support authorization revocation')
      const response = await this.fetchImpl(this.config.revocationEndpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.config.clientId,
          token: tokens.refreshToken ?? tokens.accessToken,
          token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token' }),
      })
      if (!response.ok) throw new Error('Authorization revocation was not confirmed')
    }
    this.pending = undefined
    await this.store.clear()
    await this.config.authorizationCompleted?.()
  }

  async logout(): Promise<void> {
    const tokens = await this.store.get()
    try {
      if (tokens && this.config.revocationEndpoint) {
        const response = await this.fetchImpl(this.config.revocationEndpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: this.config.clientId, token: tokens.refreshToken ?? tokens.accessToken, token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token' }),
        })
        if (!response.ok) throw new Error(`Device authorization revocation failed (${response.status})`)
      }
    } finally {
      this.pending = undefined
      await this.store.clear()
      await this.config.authorizationCompleted?.()
    }
  }

  async handleUnauthorized(rejectedToken: string): Promise<boolean> {
    // A task report may still carry the previous access token while polling
    // rotates it. Do not erase the newly rotated credential on that late 401.
    if (this.refreshPromise) await this.refreshPromise
    const current = await this.store.get()
    if (current && current.accessToken !== rejectedToken) return true
    await this.store.clear()
    return false
  }

  private async exchange(body: URLSearchParams, clearRejectedCredentials = true): Promise<TokenSet> {
    const response = await this.fetchImpl(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (response.status === 401 || payload.error === 'invalid_grant') {
        if (clearRejectedCredentials) await this.store.clear()
        throw new OAuthLoginRequiredError()
      }
      throw new Error(`OAuth token exchange failed (${response.status})`)
    }
    const payload = (await response.json()) as TokenResponse
    if (typeof payload.access_token !== 'string') {
      throw new Error('OAuth token response has no access_token')
    }
    const expiresIn =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? payload.expires_in
        : 3600
    const tokens: TokenSet = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    }
    if (typeof payload.refresh_token === 'string') {
      tokens.refreshToken = payload.refresh_token
    }
    if (typeof payload.token_type === 'string') tokens.tokenType = payload.token_type
    if (typeof payload.scope === 'string') tokens.scope = payload.scope
    return tokens
  }
}
