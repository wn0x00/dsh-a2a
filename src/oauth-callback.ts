import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function html(response: ServerResponse, status: number, title: string, message: string): void {
  const payload = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><main style="font-family:system-ui,sans-serif;margin:4rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this window and return to DeepSeek Harness.</p></main>`
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

export type OAuthCallbackServer = { close: () => Promise<void> }

/** Host the loopback redirect required by the public PKCE client. */
export async function startOAuthCallbackServer(
  redirectUri: string,
  onAuthorization: (code: string, state: string) => Promise<void>,
  onDenied?: (state: string) => Promise<void>,
): Promise<OAuthCallbackServer> {
  const redirect = new URL(redirectUri)
  if (redirect.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(redirect.hostname) || !redirect.port || redirect.pathname !== '/oauth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error('OAuth callback must use a loopback IP, explicit port and /oauth/callback path')
  }
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', redirect)
    if (request.method !== 'GET' || requestUrl.pathname !== redirect.pathname) {
      html(response, 404, 'Not found', 'This callback endpoint only accepts the OAuth redirect.')
      return
    }
    const error = requestUrl.searchParams.get('error')
    if (error) {
      const state = requestUrl.searchParams.get('state')
      if (!state || !onDenied) {
        html(response, 400, 'Invalid authorization response', 'The authorization state is missing or cannot be verified.')
        return
      }
      try {
        await onDenied(state)
        html(response, 400, 'Authorization declined', 'No device was connected. Restart the plugin to authorize again.')
      } catch {
        html(response, 400, 'Invalid authorization response', 'The authorization state does not match this request.')
      }
      return
    }
    const code = requestUrl.searchParams.get('code')
    const state = requestUrl.searchParams.get('state')
    if (!code || !state) {
      html(response, 400, 'Missing authorization response', 'The callback did not include code and state.')
      return
    }
    try {
      await onAuthorization(code, state)
      html(response, 200, 'DeepSeek Harness connected', 'The device is now connected to the A2A gateway.')
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue)
      html(response, 500, 'Connection failed', message)
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(Number.parseInt(redirect.port, 10), redirect.hostname.replace(/^\[|\]$/gu, ''))
  })

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
