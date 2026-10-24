const phases = {
  starting: ['正在启动', '正在读取本机连接信息。'],
  disconnected: ['未连接', '连接平台后，可从平台向此设备发送任务。'],
  authorizing: [
    '等待浏览器授权',
    '请在浏览器中确认授权，再返回 Harness。完成设备注册后，此处会自动更新。',
  ],
  connecting: ['正在连接', '正在向平台注册此设备。'],
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

export function createConnectionPanel(React, Button) {
  const h = React.createElement
  const muted = { margin: 0, opacity: 0.72, fontSize: 12, lineHeight: 1.6 }
  return function ConnectionPanel({ connection, disabled, readOnly, changed }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const [failed, setFailed] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [confirm, setConfirm] = React.useState(false)
    const [actionError, setActionError] = React.useState(false)
    const live = React.useRef(false)
    const scope = React.useRef(0)
    const generation = React.useRef(0)
    const refresh = React.useCallback(async () => {
      const current = ++generation.current
      try {
        const result = await connection.status()
        if (!result.ok) throw new Error('unavailable')
        if (live.current && current === generation.current) {
          setSnapshot(result.value)
          setFailed(false)
        }
      } catch {
        if (live.current && current === generation.current) setFailed(true)
      }
    }, [connection])
    React.useEffect(() => {
      live.current = true
      scope.current += 1
      let active = true
      let timer
      setSnapshot(null)
      setBusy(false)
      setConfirm(false)
      setActionError(false)
      const tick = async () => {
        await refresh()
        if (active) timer = setTimeout(tick, 2000)
      }
      void tick()
      const stop = connection.subscribe(refresh)
      return () => {
        active = false
        live.current = false
        scope.current += 1
        generation.current += 1
        clearTimeout(timer)
        stop()
      }
    }, [connection, refresh])
    async function act(action) {
      if (
        (action === 'cancelAuthorization' ? readOnly : disabled) ||
        busy ||
        failed ||
        !snapshot
      )
        return
      setBusy(true)
      setConfirm(false)
      setActionError(false)
      generation.current += 1
      const currentScope = scope.current
      const current = () => live.current && currentScope === scope.current
      try {
        const result = await connection[action]()
        if (!result.ok) throw new Error('unavailable')
        if (current()) setSnapshot(result.value)
      } catch {
        if (current()) setActionError(true)
      } finally {
        if (current()) {
          await refresh()
          if (current()) setBusy(false)
        }
      }
    }
    const [label, description] = failed
      ? ['无法读取状态', '请检查 Harness 连接，然后刷新状态。']
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
        snapshot?.activeTasks > 0
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
            snapshot.lastContactAt
              ? h(
                  'span',
                  { style: muted },
                  `最近联络 ${new Date(snapshot.lastContactAt).toLocaleString()}`,
                )
              : null,
            snapshot.phase === 'authorizing' && snapshot.pendingExpiresAt
              ? h(
                  'span',
                  { style: muted },
                  `请在 ${new Date(snapshot.pendingExpiresAt).toLocaleTimeString()} 前完成本次授权`,
                )
              : null,
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
        !connected && snapshot?.phase !== 'reconnecting'
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
        snapshot &&
          snapshot.phase !== 'authorization_required' &&
          snapshot.phase !== 'disconnected'
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
        snapshot?.phase === 'authorizing'
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
            disabled: busy,
            onClick: refresh,
          },
          '刷新状态',
        ),
      ),
      changed
        ? h('p', { style: muted }, '先保存配置，再连接平台或重新授权。')
        : null,
      snapshot?.activeTasks > 0
        ? h('p', { style: muted }, '任务执行期间不能重新授权，请等待任务结束。')
        : null,
      confirm
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
