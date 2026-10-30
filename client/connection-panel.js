const phases = {
  starting: ['正在启动', '正在读取本机连接信息。'],
  configuration_required: [
    '需要配置平台地址',
    '请先在下方填写平台地址并保存，然后再连接平台。平台地址保存在本机 Harness 配置中。',
  ],
  disconnected: ['未连接', '连接平台后，可从平台向此设备发送任务。'],
  authorizing: [
    '等待浏览器授权',
    '请在浏览器中确认授权，再返回 Harness。完成设备注册后，此处会自动更新。',
  ],
  connecting: ['正在连接', '正在向平台注册此设备。'],
  updating: ['正在更新插件', '已暂停接收新任务，更新完成后会恢复连接。'],
  connected: ['已连接', '此设备已授权，可以接收平台任务。'],
  reconnecting: ['连接中断', '暂时无法联络平台，正在自动重试。'],
  authorization_required: [
    '需要授权',
    '尚未授权，或原授权已失效。点击连接平台，在浏览器中完成授权。',
  ],
  error: ['连接失败', '请检查网络与平台地址后重试。若授权已失效，可重新授权。'],
  stopped: ['插件已停止', '请重新启用插件后连接。'],
}
const notices = {
  authorization_denied: '本次授权已取消。',
  authorization_timeout: '本次授权已超时，请重新发起。',
  authorization_failed: '本次授权未完成，请检查浏览器或网络后重试。',
  registration_failed: '设备注册未完成，请重试连接。',
}

const STATUS_TIMEOUT_MS = 8000
const statusErrors = {
  'gateway/service-unavailable': 'unavailable',
  'gateway/method-unavailable': 'unavailable',
  'gateway/invocation-unavailable': 'unavailable',
  'gateway/definition-unavailable': 'unavailable',
  'gateway/binding-invalid': 'incompatible',
  'gateway/signature-invalid': 'incompatible',
  'gateway/result-invalid': 'incompatible',
  'remote-access/denied': 'denied',
  'gateway/internal': 'connection',
  'gateway/cancelled': 'connection',
  'dsh-a2a-ui/status-timeout': 'timeout',
}
const statusHints = {
  unavailable:
    '本机插件的连接组件尚未就绪。请确认插件已启用；若刚更新插件，请完全退出 DeepSeek Harness 后重新打开，再刷新状态。',
  incompatible:
    '插件与 Harness 未能正确交换连接信息。请完全退出 DeepSeek Harness 后重新打开；仍无法读取时，请检查两者是否为兼容版本。',
  denied:
    '当前客户端没有读取此连接状态的权限。请在本机 Harness 中查看，或联系此设备的所有者。',
  connection:
    '暂时无法读取本机 Harness 的连接信息。请确认 Harness 正在运行；若刚更新插件，请完全退出后重新打开，再刷新状态。',
  timeout:
    '本机 Harness 未及时响应。已停止本次读取，稍后会自动重试；也可刷新状态。若刚更新插件，请完全退出 Harness 后重新打开。',
  unknown:
    '暂时无法确认此设备是否已授权。请确认插件已启用；若刚更新插件，请完全退出 DeepSeek Harness 后重新打开，再刷新状态。',
}
function statusFailure(error) {
  // Only known protocol codes may reach the UI. Raw errors can carry URLs,
  // request details or secrets and are never rendered or copied.
  const code =
    typeof error?.code === 'string' && Object.hasOwn(statusErrors, error.code)
      ? error.code
      : null
  return { code, kind: code ? statusErrors[code] : 'unknown' }
}

function readStatus(connection, controller) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve()
      .then(() => connection.status({ signal: controller.signal }))
      .then(resolve, reject)
      .finally(() => {
        controller.signal.removeEventListener('abort', aborted)
      })
  })
}

export function createConnectionPanel(React, Button) {
  const h = React.createElement
  const muted = { margin: 0, opacity: 0.72, fontSize: 12, lineHeight: 1.6 }
  return function ConnectionPanel({
    connection,
    disabled,
    readOnly,
    changed,
    disabledReason,
  }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const [failure, setFailure] = React.useState(null)
    const [readAt, setReadAt] = React.useState(null)
    const [reading, setReading] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [confirm, setConfirm] = React.useState(false)
    const [actionError, setActionError] = React.useState(false)
    const live = React.useRef(false)
    const scope = React.useRef(0)
    const generation = React.useRef(0)
    const reader = React.useRef(null)
    const acting = React.useRef(false)
    const refresh = () => reader.current?.refresh() ?? Promise.resolve()
    React.useEffect(() => {
      live.current = true
      scope.current += 1
      let active = true
      let timer
      let pending = null
      let failures = 0
      setSnapshot(null)
      setReadAt(null)
      setFailure(null)
      setBusy(false)
      setConfirm(false)
      setActionError(false)
      acting.current = false
      const read = () => {
        if (!active) return Promise.resolve()
        if (pending) return pending.promise
        clearTimeout(timer)
        setReading(true)
        const current = ++generation.current
        const controller = new AbortController()
        const deadline = setTimeout(
          () => controller.abort({ code: 'dsh-a2a-ui/status-timeout' }),
          STATUS_TIMEOUT_MS,
        )
        const flight = { controller, promise: null }
        pending = flight
        flight.promise = (async () => {
          try {
            const result = await readStatus(connection, controller)
            if (!result?.ok) throw result?.error
            if (active && current === generation.current) {
              setSnapshot(result.value)
              setReadAt(Date.now())
              setFailure(null)
              failures = 0
            }
          } catch (error) {
            if (active && current === generation.current) {
              setFailure(statusFailure(error))
              setConfirm(false)
              failures += 1
            }
          } finally {
            clearTimeout(deadline)
            if (pending === flight) pending = null
            if (active) {
              setReading(false)
              timer = setTimeout(
                read,
                failures
                  ? Math.min(5000 * 2 ** Math.min(failures - 1, 3), 30000)
                  : 2000,
              )
            }
          }
        })()
        return flight.promise
      }
      const currentReader = {
        refresh: read,
        invalidate: () => {
          generation.current += 1
          pending?.controller.abort({ code: 'gateway/cancelled' })
        },
      }
      reader.current = currentReader
      void read()
      const stop = connection.subscribe(read)
      return () => {
        active = false
        live.current = false
        scope.current += 1
        generation.current += 1
        clearTimeout(timer)
        pending?.controller.abort({ code: 'gateway/cancelled' })
        if (reader.current === currentReader) reader.current = null
        stop()
      }
    }, [connection])
    const failed = failure !== null
    async function act(action) {
      if (
        (action === 'cancelAuthorization' ? readOnly : disabled) ||
        acting.current ||
        failed ||
        !snapshot
      )
        return
      acting.current = true
      setBusy(true)
      setConfirm(false)
      setActionError(false)
      reader.current?.invalidate()
      const currentScope = scope.current
      const current = () => live.current && currentScope === scope.current
      try {
        const result = await connection[action]()
        if (!result.ok) throw new Error('unavailable')
        if (current()) {
          setSnapshot(result.value)
          setReadAt(Date.now())
          setFailure(null)
        }
      } catch {
        if (current()) setActionError(true)
      } finally {
        if (current()) {
          await refresh()
          if (current()) {
            acting.current = false
            setBusy(false)
          }
        }
      }
    }
    const [label, description] = failed
      ? ['无法获取本机连接状态', statusHints[failure.kind]]
      : snapshot
        ? (phases[snapshot.phase] ?? phases.error)
        : ['读取连接状态…', '正在读取本机连接信息。']
    const connected = !failed && snapshot?.phase === 'connected'
    const color = connected
      ? '#27845a'
      : failed || snapshot?.phase === 'error'
        ? '#ba5341'
        : '#92702a'
    const blocked = disabled || busy || failed || !snapshot
    const actionHint =
      disabledReason ??
      (readOnly
        ? '当前连接没有操作权限，请使用可管理本机插件的连接。'
        : changed
          ? '先保存或取消配置修改，再连接平台或重新授权。'
          : busy
            ? '正在处理连接请求，请稍候。'
            : !snapshot?.canConnect &&
                ['authorization_required', 'disconnected', 'error'].includes(
                  snapshot?.phase,
                )
              ? 'Harness 暂未允许发起连接，请稍后刷新状态。'
              : null)
    return h(
      'section',
      {
        'aria-label': '平台连接状态',
        style: {
          padding: 16,
          display: 'grid',
          gap: 12,
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l3)',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', {
          'aria-hidden': true,
          style: {
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
          },
        }),
        h(
          'strong',
          { role: 'status', 'aria-live': 'polite', style: { fontSize: 14 } },
          label,
        ),
        !failed && snapshot?.activeTasks > 0
          ? h(
              'span',
              { style: { ...muted, marginLeft: 'auto' } },
              `${snapshot.activeTasks} 个任务执行中`,
            )
          : null,
      ),
      h('p', { style: { ...muted, fontSize: 13 } }, description),
      snapshot && (snapshot.gatewayUrl || snapshot.deviceName)
        ? h(
            'div',
            { style: { display: 'grid', gap: 4, overflowWrap: 'anywhere' } },
            snapshot.deviceName
              ? h('span', { style: { fontSize: 13 } }, snapshot.deviceName)
              : null,
            snapshot.gatewayUrl
              ? h('span', { style: muted }, snapshot.gatewayUrl)
              : null,
            !failed && snapshot.lastContactAt
              ? h(
                  'span',
                  { style: muted },
                  `最近联络 ${new Date(snapshot.lastContactAt).toLocaleString()}`,
                )
              : null,
            !failed &&
              snapshot.phase === 'authorizing' &&
              snapshot.pendingExpiresAt
              ? h(
                  'span',
                  { style: muted },
                  `请在 ${new Date(snapshot.pendingExpiresAt).toLocaleTimeString()} 前完成本次授权`,
                )
              : null,
          )
        : null,
      failed && snapshot
        ? h(
            'p',
            { style: muted },
            `上次状态：${phases[snapshot.phase]?.[0] ?? '未知'}（已过期）${readAt ? ` · 最后读取 ${new Date(readAt).toLocaleString()}` : ''}。当前是否在线尚未确认。`,
          )
        : null,
      failed && failure.code
        ? h(
            'details',
            { style: muted },
            h('summary', { style: { cursor: 'pointer' } }, '诊断信息'),
            h('code', { style: { overflowWrap: 'anywhere' } }, failure.code),
          )
        : null,
      !failed && notices[snapshot?.notice]
        ? h(
            'p',
            { role: 'status', style: muted },
            notices[snapshot.notice],
            connected ? ' 已恢复原有连接。' : '',
          )
        : null,
      h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        !failed &&
          snapshot &&
          !connected &&
          snapshot.phase !== 'reconnecting' &&
          snapshot.phase !== 'configuration_required' &&
          snapshot.phase !== 'updating'
          ? h(
              Button,
              {
                type: 'button',
                variant: 'primary',
                disabled: blocked || !snapshot?.canConnect,
                onClick: () => act('connect'),
              },
              busy ? '正在处理…' : '连接平台',
            )
          : null,
        !failed &&
          snapshot &&
          snapshot.phase !== 'authorization_required' &&
          snapshot.phase !== 'disconnected' &&
          snapshot.phase !== 'configuration_required' &&
          snapshot.phase !== 'updating'
          ? h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                disabled: blocked || !snapshot.canReauthorize,
                onClick: () => setConfirm(true),
              },
              '重新授权',
            )
          : null,
        !failed && snapshot?.phase === 'authorizing'
          ? h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                disabled:
                  readOnly ||
                  busy ||
                  failed ||
                  !snapshot.canCancelAuthorization,
                onClick: () => act('cancelAuthorization'),
              },
              '取消本次授权',
            )
          : null,
        h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            disabled: reading || busy,
            'aria-busy': reading,
            onClick: refresh,
          },
          '刷新状态',
        ),
      ),
      !failed && actionHint
        ? h('p', { role: 'status', style: muted }, actionHint)
        : null,
      !failed && snapshot?.activeTasks > 0
        ? h('p', { style: muted }, '任务执行期间不能重新授权，请等待任务结束。')
        : null,
      !failed && confirm
        ? h(
            'div',
            {
              role: 'group',
              'aria-label': '确认重新授权',
              style: {
                borderTop: '1px solid var(--dsw-alias-border-l3)',
                paddingTop: 12,
                display: 'grid',
                gap: 10,
              },
            },
            h('strong', { style: { fontSize: 13 } }, '重新授权此设备'),
            h(
              'p',
              { style: muted },
              '将暂停接收新任务并打开浏览器。请使用原平台账号；取消或授权失败时会尝试恢复原连接。授权成功后保留设备和任务配置，平台会话需开启新对话。',
            ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h(
                Button,
                {
                  type: 'button',
                  variant: 'primary',
                  disabled: blocked || !snapshot.canReauthorize,
                  onClick: () => act('reauthorize'),
                },
                '打开浏览器授权',
              ),
              h(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  onClick: () => setConfirm(false),
                },
                '取消',
              ),
            ),
          )
        : null,
      actionError
        ? h(
            'p',
            { role: 'alert', style: { ...muted, color: '#ba5341' } },
            '未能完成操作。请根据当前连接状态重试；浏览器未打开时，请检查系统默认浏览器。',
          )
        : null,
    )
  }
}
