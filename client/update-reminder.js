export function updateNoticeText(notice) {
  const version = notice?.version ? ` ${notice.version}` : ''
  switch (notice?.kind) {
    case 'available': return `A2A 插件发现新版本${version}，等待空闲后自动安装。`
    case 'restart_required': return `A2A 插件${version} 已安装，请完全退出并重新打开 Harness。`
    case 'updated': return `A2A 插件已更新到${version}。`
    case 'error': return 'A2A 插件自动更新未完成，请在设置 → A2A 平台任务中查看。'
    default: return ''
  }
}

/** Uses Harness's additive shell overlay: reminders remain active when Settings
 * is closed. Only read sanitized, owner-only status; never initiate updates. */
export function createUpdateReminder(React, Toast) {
  const h = React.createElement
  return function UpdateReminder({ updates }) {
    const [notice, setNotice] = React.useState(null)
    React.useEffect(() => {
      let active = true
      let timer
      let pending
      const seen = new Set()
      const storageKey = 'dsh-a2a:update-reminders'
      try {
        const saved = JSON.parse(globalThis.sessionStorage?.getItem(storageKey) ?? '[]')
        if (Array.isArray(saved)) saved.slice(-50).forEach((id) => seen.add(id))
      } catch { /* Reminders still work if browser storage is unavailable. */ }
      const refresh = async () => {
        if (!active || pending) return
        clearTimeout(timer)
        const controller = new AbortController()
        pending = controller
        const deadline = setTimeout(() => controller.abort(), 8000)
        try {
          const result = await Promise.race([
            updates.status({ signal: controller.signal }),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
          ])
          if (!active || !result?.ok) return
          const automatic = result.value.automatic
          if (!automatic?.enabled) setNotice(null)
          const next = automatic?.notice
          if (automatic?.enabled && next && updateNoticeText(next) && !seen.has(next.id)) {
            seen.add(next.id)
            try { globalThis.sessionStorage?.setItem(storageKey, JSON.stringify([...seen].slice(-50))) } catch { /* optional */ }
            setNotice(next)
          }
        } catch { /* A read failure is not an update failure notification. */ }
        finally {
          clearTimeout(deadline)
          pending = null
          if (active) timer = setTimeout(refresh, 30_000)
        }
      }
      void refresh()
      const stop = updates.subscribe(refresh)
      return () => { active = false; clearTimeout(timer); pending?.abort(); stop() }
    }, [updates])
    if (!notice) return null
    const text = updateNoticeText(notice)
    const dismiss = () => setNotice(null)
    if (Toast) return h(Toast, {
      key: notice.id, text, holdMs: 12_000,
      tone: notice.kind === 'updated' ? 'success' : undefined,
      actions: [{ label: '知道了', onClick: dismiss }], onDone: dismiss,
    })
    return h('div', { role: 'status', style: {
      position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
      maxWidth: 'calc(100vw - 32px)', padding: 12, borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)',
      pointerEvents: 'auto', zIndex: 1000,
    } }, text, h('button', { type: 'button', onClick: dismiss }, '知道了'))
  }
}
