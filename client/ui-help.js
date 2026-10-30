export function createInfoTip(React, Tooltip) {
  const h = React.createElement
  return function InfoTip({ label, text }) {
    const [open, setOpen] = React.useState(false)
    const [position, setPosition] = React.useState({ left: 12, top: 12 })
    const id = React.useId()
    const show = (event) => {
      const rect = event.currentTarget.getBoundingClientRect?.()
      if (rect) setPosition({
        left: Math.max(12, Math.min(rect.left, globalThis.innerWidth - 292)),
        top: rect.bottom + 8,
      })
      setOpen(true)
    }
    const anchor = h('button', {
      type: 'button', 'aria-label': label,
      'aria-describedby': !Tooltip && open ? id : undefined,
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, minHeight: 22, padding: 3, flexShrink: 0,
        border: 0, borderRadius: 4, background: 'transparent', color: 'inherit',
        opacity: 0.6, cursor: 'help', verticalAlign: 'middle' },
      ...(!Tooltip ? { onMouseEnter: show, onFocus: show, onClick: show,
        onMouseLeave: () => setOpen(false), onBlur: () => setOpen(false),
        onKeyDown: (event) => { if (event.key === 'Escape') setOpen(false) } } : {}),
    }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.2 }),
      h('path', { d: 'M8 7v4M8 4.5v.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })))
    if (Tooltip) return h(Tooltip, { label: text, side: 'bottom', portal: true, maxWidth: 280, openOnClick: true }, anchor)
    return h(React.Fragment, null, anchor, open ? h('span', {
      id, role: 'tooltip', style: { position: 'fixed', ...position, zIndex: 10000,
        width: 'min(280px, calc(100vw - 24px))', padding: '8px 10px', borderRadius: 6,
        background: '#252a34', color: '#fff', fontSize: 12, fontWeight: 400, lineHeight: 1.6 },
    }, text) : null)
  }
}

export function createConfirmDialog(React, Modal) {
  const h = React.createElement
  return function ConfirmDialog({ title, description, onClose, children }) {
    const dialog = React.useRef(null)
    React.useEffect(() => {
      if (Modal) return
      const element = dialog.current
      element?.showModal?.()
      return () => element?.close?.()
    }, [])
    if (Modal) return h(Modal, { open: true, onClose, title, description, closeLabel: '关闭', footer: children })
    return h('dialog', { ref: dialog, role: 'dialog', 'aria-modal': true,
      'aria-label': title, onCancel: (event) => { event.preventDefault(); onClose() },
      style: { width: 'min(400px, calc(100vw - 32px))', padding: 24, borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l3)', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)' },
    }, h('h3', { style: { margin: '0 0 12px', fontSize: 16 } }, title),
    h('p', { style: { fontSize: 13, lineHeight: 1.7, opacity: 0.75, margin: '0 0 20px' } }, description), children)
  }
}
