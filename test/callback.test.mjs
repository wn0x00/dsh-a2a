import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { startOAuthCallbackServer } from '../dist/oauth-callback.js'
import { createBridge } from '../dist/plugin.js'
import { MemoryTokenStore, OAuthLoginRequiredError } from '../dist/pkce.js'

async function callbackUrl() {
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  return `http://127.0.0.1:${port}/oauth/callback`
}

test('callback waits for local registration and launches only the fixed desktop command after success', async (t) => {
  const url = await callbackUrl()
  let release, entered, completed = false
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const callback = await startOAuthCallbackServer(url, async (code, state) => {
    assert.equal(code, 'private-code')
    assert.equal(state, 'private-state')
    entered()
    await gate
  })
  t.after(() => callback.close())
  const pending = fetch(`${url}?code=private-code&state=private-state`, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
    .then((response) => { completed = true; return response })
  await started
  assert.equal(completed, false)
  release()
  const response = await pending
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /连接成功/)
  assert.match(html, /href="dsh:\/\/open"/)
  assert.match(html, /window\.location\.href='dsh:\/\/open'/)
  assert.match(html, /history\.replaceState/)
  assert.doesNotMatch(html, /private-code|private-state/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
})

test('failed and invalid callbacks never automatically open the app or expose the raw failure', async (t) => {
  const url = await callbackUrl()
  const callback = await startOAuthCallbackServer(url, async () => { throw new Error('<script>secret token</script>') })
  t.after(() => callback.close())
  const failed = await fetch(`${url}?code=unused&state=invalid`, { headers: { 'Accept-Language': 'en-US' } })
  assert.equal(failed.status, 500)
  const html = await failed.text()
  assert.match(html, /Connection incomplete/)
  assert.doesNotMatch(html, /window\.location\.href|secret token|<h1>Connected/)
  const invalid = await fetch(url)
  assert.equal(invalid.status, 400)
  assert.doesNotMatch(await invalid.text(), /window\.location\.href/)
})

test('the standalone diagnostic callback does not launch a desktop instance', async (t) => {
  const url = await callbackUrl()
  const callback = await startOAuthCallbackServer(url, async () => {}, undefined, { openDesktop: false })
  t.after(() => callback.close())
  const response = await fetch(`${url}?code=test&state=test`)
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /diagnostic terminal/)
  assert.doesNotMatch(html, /dsh:\/\/open/)
})

test('a consumed callback is not exchanged twice and a failed registration cannot report success', async (t) => {
  let opened, exchanges = 0, registrations = 0
  const bridge = createBridge({ agents: { run: async () => ({}) } }, {
    gatewayUrl: 'https://platform.example', transport: 'pull',
    device: { id: 'local', name: 'Harness', capabilities: [] },
    oauth: {
      clientId: 'desktop', authorizationEndpoint: 'https://platform.example/authorize',
      tokenEndpoint: 'https://platform.example/token', redirectUri: await callbackUrl(), scopes: [],
      tokenStore: new MemoryTokenStore(), openAuthorizationUrl: (url) => { opened = url },
    },
    fetch: async (url) => {
      if (String(url).endsWith('/token')) {
        exchanges++
        return Response.json({ access_token: 'new-access', expires_in: 3600 })
      }
      registrations++
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    },
  })
  t.after(() => bridge.stop())
  await bridge.start()
  assert.equal(opened, undefined)
  await bridge.connect()
  const state = new URL(opened).searchParams.get('state')
  await assert.rejects(bridge.completeAuthorization('one-use-code', state), OAuthLoginRequiredError)
  await assert.rejects(bridge.completeAuthorization('one-use-code', state), /state/)
  assert.equal(exchanges, 1)
  assert.equal(registrations, 1)
})
