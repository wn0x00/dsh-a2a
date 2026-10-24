import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'

type Outcome = 'connected' | 'declined' | 'invalid' | 'failed' | 'notFound'
const copy = {
  zh: {
    connected: ['连接成功', '此设备已连接到平台，可以接收所选 Agent 的任务。'],
    declined: ['本次授权已取消', '请返回 Harness 查看当前连接状态；已有授权仍可用时会恢复原连接。'],
    invalid: ['授权链接已失效', '此链接不属于当前连接请求，或已经使用。请回到 Harness 重新连接。'],
    failed: ['连接未完成', '未能完成本机连接。请检查网络，然后在 Harness 设置中重新连接。'],
    notFound: ['找不到此页面', '此本机地址只用于完成平台授权。'],
    open: '打开 DeepSeek Harness',
    connectedHint: '正在尝试打开桌面应用。如果浏览器没有响应，请点击下方按钮并允许打开应用。',
    retryHint: '在 Harness「设置 → Xbot 平台任务」中点击「连接平台」重新发起授权。',
    diagnosticHint: '返回诊断终端查看连接状态。需要重试时，重新运行诊断命令。',
    foot: '完成后可以关闭此页面。',
  },
  en: {
    connected: ['Connected', 'This device is connected to the platform and can receive tasks from selected Agents.'],
    declined: ['Authorization canceled', 'Return to Harness to check the connection. A previous authorization is restored if it is still valid.'],
    invalid: ['Authorization link unavailable', 'This link does not match the current request or has already been used. Connect again from Harness.'],
    failed: ['Connection incomplete', 'The local connection could not be completed. Check your network and connect again in Harness settings.'],
    notFound: ['Page not found', 'This local address is only used to complete platform authorization.'],
    open: 'Open DeepSeek Harness',
    connectedHint: 'Opening the desktop app. If nothing happens, use the button below and allow your browser to open the app.',
    retryHint: 'In Harness, open Settings → Xbot platform tasks and select Connect to platform to start a new request.',
    diagnosticHint: 'Return to the diagnostic terminal to inspect the connection. Run the command again to retry.',
    foot: 'You can close this page when finished.',
  },
} as const

function html(request: IncomingMessage, response: ServerResponse, status: number, outcome: Outcome, openDesktop: boolean): void {
  const language = request.headers['accept-language']?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const text = copy[language]
  const [title, message] = text[outcome]
  const connected = outcome === 'connected'
  const nonce = randomBytes(18).toString('base64')
  // Native activation is separate from the credential-bearing redirect. Never
  // interpolate callback URLs, codes, states or raw errors into the page.
  const payload = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · DeepSeek Harness</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#172332;font:15px/1.6 system-ui,-apple-system,sans-serif;display:grid;min-height:100svh;place-items:center;padding:24px}main{width:min(100%,480px);padding:32px;border:1px solid #e3e8ee;border-radius:20px;background:#fff;box-shadow:0 16px 48px #14203308}.brand{font-size:13px;font-weight:600;letter-spacing:.02em;color:#64748b}.icon{display:grid;place-items:center;width:44px;height:44px;margin:24px 0 16px;border-radius:14px;background:${connected ? '#e3f5ef' : '#eef1f5'};color:${connected ? '#147558' : '#64748b'};font-size:23px}h1{margin:0 0 10px;font-size:26px;line-height:1.3}p{margin:0 0 16px;color:#59687a}.hint{font-size:13px}a{display:block;text-align:center;border-radius:10px;padding:11px 16px;background:#275fe5;color:white;font-weight:600;text-decoration:none}a:hover{background:#1d4ec4}a:focus-visible{outline:3px solid #8aafff;outline-offset:4px}footer{margin-top:18px;font-size:12px;color:#64748b}@media(prefers-color-scheme:dark){body{background:#121820;color:#eef2f7}main{background:#1b2532;border-color:#334155}p,.brand,footer{color:#adbacb}.icon{background:#273747;color:#b9d5ef}}@media(max-width:480px){main{padding:24px}body{padding:16px}}
</style></head><body><main><div class="brand">DeepSeek Harness · Xbot</div><div class="icon" aria-hidden="true">${connected ? '✓' : '↗'}</div><h1>${title}</h1><p>${message}</p><p class="hint">${openDesktop ? connected ? text.connectedHint : text.retryHint : text.diagnosticHint}</p>${openDesktop ? `<a href="dsh://open">${text.open}</a>` : ''}<footer>${text.foot}</footer></main><script nonce="${nonce}">history.replaceState(null,'','/oauth/callback');${connected && openDesktop ? "setTimeout(()=>{window.location.href='dsh://open'},250);" : ''}</script></body></html>`
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  })
  response.end(payload)
}

export type OAuthCallbackServer = { close: () => Promise<void> }

/** Host the loopback redirect required by the public PKCE client. */
export async function startOAuthCallbackServer(
  redirectUri: string,
  onAuthorization: (code: string, state: string) => Promise<void>,
  onDenied?: (state: string) => Promise<void>,
  options: { openDesktop?: boolean } = {},
): Promise<OAuthCallbackServer> {
  const redirect = new URL(redirectUri)
  if (redirect.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(redirect.hostname) || !redirect.port || redirect.pathname !== '/oauth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error('OAuth callback must use a loopback IP, explicit port and /oauth/callback path')
  }
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const render = (status: number, outcome: Outcome) => html(request, response, status, outcome, options.openDesktop !== false)
    const requestUrl = new URL(request.url ?? '/', redirect)
    if (request.method !== 'GET' || requestUrl.pathname !== redirect.pathname) {
      render(404, 'notFound')
      return
    }
    const error = requestUrl.searchParams.get('error')
    if (error) {
      const state = requestUrl.searchParams.get('state')
      if (!state || !onDenied) {
        render(400, 'invalid')
        return
      }
      try {
        await onDenied(state)
        render(400, 'declined')
      } catch {
        render(400, 'invalid')
      }
      return
    }
    const code = requestUrl.searchParams.get('code')
    const state = requestUrl.searchParams.get('state')
    if (!code || !state) {
      render(400, 'invalid')
      return
    }
    try {
      await onAuthorization(code, state)
      render(200, 'connected')
    } catch {
      render(500, 'failed')
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
