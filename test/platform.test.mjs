import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPlatformBridgeConfig } from '../dist/platform.js'
import { MemoryTokenStore, OAuthClient, OAuthLoginRequiredError } from '../dist/pkce.js'
import { PersistentTokenStore, lockProfile, persistentDeviceId, profileStorageDirectory } from '../dist/token-store.js'
import { createBridge } from '../dist/plugin.js'
import { startOAuthCallbackServer } from '../dist/oauth-callback.js'

const metadata = {
  authorization_endpoint: 'http://127.0.0.1:5173/devices/authorize',
  authorization_request_endpoint: 'http://127.0.0.1:8000/api/a2a/oauth/requests',
  token_endpoint: 'http://127.0.0.1:8000/api/a2a/oauth/token',
  revocation_endpoint: 'http://127.0.0.1:8000/api/a2a/oauth/revoke',
}
const oauthConfig = (store, overrides = {}) => ({
  clientId: 'xbot-windows', authorizationEndpoint: metadata.authorization_endpoint,
  authorizationRequestEndpoint: metadata.authorization_request_endpoint,
  tokenEndpoint: metadata.token_endpoint, revocationEndpoint: metadata.revocation_endpoint,
  redirectUri: 'http://127.0.0.1:43127/oauth/callback',
  scopes: ['device.connect', 'device.task.receive', 'device.task.report'],
  device: { id: 'xbot-test', name: 'My computer', platform: 'linux' },
  tokenStore: store, openAuthorizationUrl() {}, ...overrides,
})
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xbot-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('platform defaults ignore legacy issuer/device and persist identity per profile', async (t) => {
  const root = await temp(t)
  const saved = { A2A_OIDC_ISSUER_URL: process.env.A2A_OIDC_ISSUER_URL, A2A_DEVICE_ID: process.env.A2A_DEVICE_ID }
  process.env.A2A_OIDC_ISSUER_URL = 'http://127.0.0.1:8081/realms/xbot'
  process.env.A2A_DEVICE_ID = 'old-keycloak-device'
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const calls = []
  const fetchImpl = async (url) => { calls.push(url); return Response.json(metadata) }
  const first = await createPlatformBridgeConfig({ storageDirectory: root, profile: 'one' }, () => {}, undefined, fetchImpl)
  assert.deepEqual(calls, ['http://127.0.0.1:8000/api/a2a/oauth/metadata'])
  assert.match(first.config.device.id, /^xbot-[a-f0-9-]{36}$/u)
  assert.deepEqual(first.config.oauth.scopes, ['device.connect', 'device.task.receive', 'device.task.report'])
  const id = first.config.device.id
  await first.config.oauth.tokenStore.set({ accessToken: 'persisted', expiresAt: Date.now() + 100000 })
  await first.release()
  const next = await createPlatformBridgeConfig({ storageDirectory: root, profile: 'one' }, () => {}, undefined, fetchImpl)
  assert.equal(next.config.device.id, id)
  assert.equal((await next.config.oauth.tokenStore.get()).accessToken, 'persisted')
  await next.release()
  const other = await createPlatformBridgeConfig({ storageDirectory: root, profile: 'two' }, () => {}, undefined, fetchImpl)
  assert.notEqual(other.config.device.id, id)
  assert.equal(await other.config.oauth.tokenStore.get(), undefined)
  await other.release()
})

test('storage isolates platforms/profiles and restricts credential file access', async (t) => {
  const root = await temp(t)
  const a = profileStorageDirectory('https://one.example', 'work', root)
  assert.notEqual(a, profileStorageDirectory('https://two.example', 'work', root))
  assert.notEqual(a, profileStorageDirectory('https://one.example', 'home', root))
  const id = await persistentDeviceId(a)
  assert.equal(await persistentDeviceId(a), id)
  const store = new PersistentTokenStore(a)
  await store.set({ accessToken: 'saved-token', refreshToken: 'saved-refresh', expiresAt: 123456 })
  assert.equal((await new PersistentTokenStore(a).get()).refreshToken, 'saved-refresh')
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(a, 'credentials.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(a)).mode & 0o777, 0o700)
  } else assert.equal((await readFile(join(a, 'credentials.json'), 'utf8')).includes('saved-token'), false)
  await store.clear()
  assert.equal(await store.get(), undefined)
})

test('concurrent profile connections are refused until the owner releases storage', async (t) => {
  const directory = await temp(t)
  const release = await lockProfile(directory)
  await assert.rejects(lockProfile(directory), /already connected/u)
  await release()
  await (await lockProfile(directory))()
})

test('platform PKCE binds device and callback verifier, rejects wrong state and replay', async () => {
  const store = new MemoryTokenStore()
  const opens = [], requests = []
  let prepared = 0, closed = 0
  const oauth = new OAuthClient(oauthConfig(store, {
    openAuthorizationUrl: (url) => opens.push(url),
    prepareAuthorization: async () => { prepared++ },
    authorizationCompleted: async () => { closed++ },
  }), async (url, init) => {
    if (url.endsWith('/requests')) {
      requests.push(JSON.parse(init.body))
      assert.equal(requests[0].device_id, 'xbot-test')
      assert.equal(requests[0].platform, 'linux')
      assert.equal(requests[0].response_type, 'code')
      assert.equal(requests[0].code_challenge_method, 'S256')
      return Response.json({ request_id: 'request-1', authorization_url: `${metadata.authorization_endpoint}?request_id=request-1`, expires_in: 600 })
    }
    assert.equal(init.body.get('redirect_uri'), 'http://127.0.0.1:43127/oauth/callback')
    assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), requests[0].code_challenge)
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 900 })
  })
  const [request, duplicate] = await Promise.all([oauth.beginAuthorization(), oauth.beginAuthorization()])
  assert.equal(request.state, duplicate.state)
  assert.equal(opens.length, 1)
  assert.equal(prepared, 1)
  assert.equal(new URL(opens[0]).pathname, '/devices/authorize')
  await assert.rejects(oauth.completeAuthorization('code', 'wrong-state'), /state/u)
  await oauth.completeAuthorization('code', request.state)
  assert.equal(await oauth.accessToken(), 'access')
  assert.equal(closed, 1)
  await assert.rejects(oauth.completeAuthorization('code', request.state), /state/u)
})

test('concurrent access requests rotate refresh token exactly once', async () => {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'expired', refreshToken: 'original', expiresAt: 1 })
  let exchanges = 0
  const oauth = new OAuthClient(oauthConfig(store), async (_url, init) => {
    exchanges++
    assert.equal(init.body.get('grant_type'), 'refresh_token')
    assert.equal(init.body.get('refresh_token'), 'original')
    await new Promise((resolve) => setTimeout(resolve, 10))
    return Response.json({ access_token: 'new-access', refresh_token: 'rotated', expires_in: 900 })
  })
  assert.deepEqual(await Promise.all([oauth.accessToken(), oauth.accessToken(), oauth.accessToken()]), ['new-access', 'new-access', 'new-access'])
  assert.equal(exchanges, 1)
  assert.equal((await store.get()).refreshToken, 'rotated')
})

test('expired or revoked refresh clears credentials and requires reauthorization', async () => {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'expired', refreshToken: 'revoked', expiresAt: 1 })
  const oauth = new OAuthClient(oauthConfig(store), async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
  await assert.rejects(oauth.accessToken(), OAuthLoginRequiredError)
  assert.equal(await store.get(), undefined)
})

test('logout revokes the grant and removes local credentials', async () => {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 1 })
  const oauth = new OAuthClient(oauthConfig(store), async (url, init) => {
    assert.equal(url, metadata.revocation_endpoint)
    assert.equal(init.body.get('token'), 'refresh')
    assert.equal(init.body.get('client_id'), 'xbot-windows')
    assert.equal(init.body.get('token_type_hint'), 'refresh_token')
    return new Response(null, { status: 200 })
  })
  await oauth.logout()
  assert.equal(await store.get(), undefined)
})

test('revoked live bridge pauses polling and opens authorization once', async () => {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 900000 })
  let opens = 0, polls = 0, resolveOpened
  const opened = new Promise((resolve) => { resolveOpened = resolve })
  const bridge = createBridge({ agents: { run: async () => ({}) } }, {
    gatewayUrl: 'http://127.0.0.1:8000', transport: 'pull', pollIntervalMs: 250,
    device: { id: 'xbot-test', name: 'Computer', capabilities: [] },
    oauth: oauthConfig(store, { openAuthorizationUrl: () => { opens++; resolveOpened() } }),
    fetch: async (url) => {
      if (String(url).endsWith('/register')) return Response.json({ deviceId: 'xbot-test' })
      if (String(url).endsWith('/requests')) return Response.json({ authorization_url: `${metadata.authorization_endpoint}?request_id=new`, expires_in: 600 })
      polls++
      return Response.json({ detail: 'Unauthorized' }, { status: 401 })
    },
  })
  try {
    await bridge.start()
    await opened
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(opens, 1)
    assert.equal(polls, 1)
    assert.equal(await store.get(), undefined)
  } finally { await bridge.stop() }
})

test('callback rejects non-loopback listeners', async () => {
  await assert.rejects(startOAuthCallbackServer('http://0.0.0.0:43127/oauth/callback', async () => {}), /loopback/u)
})

test('a late 401 for an old access token preserves credentials rotated by another request', async () => {
  const store = new MemoryTokenStore()
  await store.set({ accessToken: 'rotated', refreshToken: 'new-refresh', expiresAt: Date.now() + 900000 })
  const oauth = new OAuthClient(oauthConfig(store))
  assert.equal(await oauth.handleUnauthorized('old-access'), true)
  assert.equal((await store.get()).refreshToken, 'new-refresh')
  assert.equal(await oauth.handleUnauthorized('rotated'), false)
  assert.equal(await store.get(), undefined)
})

test('platform metadata cannot redirect credential endpoints to a different server', async (t) => {
  const root = await temp(t)
  await assert.rejects(createPlatformBridgeConfig({ storageDirectory: root, profile: 'metadata' }, () => {}, undefined,
    async () => Response.json({ ...metadata, token_endpoint: 'https://other.example/token' })), /configured platform/u)
  // Failed discovery also releases the profile lock so a corrected retry works.
  const prepared = await createPlatformBridgeConfig({ storageDirectory: root, profile: 'metadata' }, () => {}, undefined,
    async () => Response.json(metadata))
  await prepared.release()
})

test('denied callback closes the listener and clears pending only when state matches', async () => {
  const { createServer } = await import('node:net')
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
  let callback, closes = 0, opens = 0
  const oauth = new OAuthClient(oauthConfig(new MemoryTokenStore(), {
    redirectUri,
    openAuthorizationUrl: () => { opens++ },
    authorizationCompleted: async () => { closes++; void callback.close() },
  }), async () => Response.json({ authorization_url: `${metadata.authorization_endpoint}?request_id=denied`, expires_in: 600 }))
  const request = await oauth.beginAuthorization()
  callback = await startOAuthCallbackServer(redirectUri, async () => {}, (state) => oauth.cancelAuthorization(state))
  try {
    const missing = await fetch(`${redirectUri}?error=access_denied`)
    assert.equal(missing.status, 400)
    const forged = await fetch(`${redirectUri}?error=access_denied&state=forged`)
    assert.equal(forged.status, 400)
    assert.equal(closes, 0)
    assert.equal((await oauth.beginAuthorization()).state, request.state)
    assert.equal(opens, 1)
    const valid = await fetch(`${redirectUri}?error=access_denied&state=${request.state}`)
    assert.equal(valid.status, 400)
    await valid.text()
    assert.equal(closes, 1)
    await assert.rejects(fetch(`${redirectUri}?error=access_denied&state=${request.state}`))
    const next = await oauth.beginAuthorization()
    assert.notEqual(next.state, request.state)
    assert.equal(opens, 2)
  } finally { await callback.close() }
})
