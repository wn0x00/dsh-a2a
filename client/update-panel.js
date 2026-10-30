import { updateNoticeText } from './update-reminder.js'
import { createInfoTip, createConfirmDialog } from './ui-help.js'

const phases = {
  idle: ['尚未检查更新', '手动检查插件版本。检查不会下载或安装更新。'],
  checking: ['正在检查更新', '正在读取发布版本信息。'],
  available: [
    '发现可用更新',
    '确认目标版本后，Harness 会下载、校验并安装更新。',
  ],
  current: ['已是最新版本', '当前没有可安装的新版本。'],
  downloading: ['正在下载更新', '正在下载并校验安装包，请保持 Harness 运行。'],
  installing: [
    '正在安装更新',
    'Harness 正在应用更新，连接可能暂时中断。请勿重复安装。',
  ],
  restart_required: [
    '更新已安装，等待重启',
    '请完全退出 DeepSeek Harness 后重新打开，让更新生效。',
  ],
  updated: ['插件已更新', 'Harness 已确认应用更新。'],
  outcome_unknown: [
    '更新结果待核对',
    '尚未确认本次更新是否完成。请保持 Harness 运行，恢复连接后核对更新结果；不要重复安装。',
  ],
  error: ['更新未完成', '请检查更新状态后重试。'],
}
const errors = {
  network: '无法读取或下载发布文件，请检查网络后重新检查更新。',
  invalid_manifest: '发布信息格式不正确，已停止更新。请稍后重新检查。',
  integrity: '安装包校验未通过，已停止更新，未提交安装。',
  invalid_package: '安装包与此插件不匹配，已停止更新。',
  busy: '有任务、授权或其他更新正在处理，请等待结束后再更新。',
  host_unavailable:
    'Harness 暂未提供可用的插件安装服务，请检查插件是否启用及宿主版本是否兼容。',
  host_refused: 'Harness 未接受本次更新，请在插件管理中检查版本兼容性。',
  installation_failed:
    'Harness 报告安装未完成，请在插件管理中查看当前状态后重新检查更新。',
  installation_unknown: phases.outcome_unknown[1],
  storage: '无法保存本机更新记录，请检查本机目录权限与可用空间。',
  update_changed: '可用版本已变化，请重新检查并确认目标版本。',
}
const terminal = new Set(['restart_required', 'updated', 'error'])
const progressing = new Set(['checking', 'downloading', 'installing'])

function statusRequest(updates, controller) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Status unavailable'))
    controller.signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => updates.status({ signal: controller.signal }))
      .then(resolve, reject)
      .finally(() => {
        controller.signal.removeEventListener('abort', abort)
      })
  })
}

export function createUpdatePanel(React, Button, { Tooltip, Modal } = {}) {
  const h = React.createElement
  const InfoTip = createInfoTip(React, Tooltip)
  const ConfirmDialog = createConfirmDialog(React, Modal)
  const muted = { margin: 0, opacity: 0.72, fontSize: 12, lineHeight: 1.6 }
  return function UpdatePanel({
    updates,
    disabled = false,
    readOnly = false,
    changed = false,
    activeTasks = 0,
    autoEnabled = false,
    autoDisabled = false,
    onAutoChange,
  }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const [readError, setReadError] = React.useState(false)
    const [reading, setReading] = React.useState(false)
    const [operation, setOperation] = React.useState(null)
    const [uncertain, setUncertain] = React.useState(false)
    const [actionError, setActionError] = React.useState(false)
    const [confirmVersion, setConfirmVersion] = React.useState(null)
    const state = React.useRef(null)
    const currentSnapshot = React.useRef(null)
    const installAttempted = React.useRef(false)
    const currentOperation = React.useRef(null)
    const receive = (next, confirmedInstall = false) => {
      currentSnapshot.current = next
      setSnapshot(next)
      setReadError(false)
      if (next.phase === 'outcome_unknown') setUncertain(true)
      else if (
        terminal.has(next.phase) ||
        progressing.has(next.phase) ||
        (confirmedInstall && next.error)
      ) {
        setUncertain(false)
        if (terminal.has(next.phase) || (confirmedInstall && next.error))
          installAttempted.current = false
      }
      setConfirmVersion((version) =>
        version && next.phase === 'available' && next.latestVersion === version
          ? version
          : null,
      )
    }
    React.useEffect(() => {
      const owner = {
        active: true,
        pending: null,
        timer: null,
        failures: 0,
        generation: 0,
      }
      state.current = owner
      currentSnapshot.current = null
      currentOperation.current = null
      installAttempted.current = false
      setSnapshot(null)
      setReadError(false)
      setUncertain(false)
      setOperation(null)
      setActionError(false)
      setConfirmVersion(null)
      const refresh = () => {
        if (!owner.active) return Promise.resolve()
        if (owner.pending) return owner.pending.promise
        clearTimeout(owner.timer)
        setReading(true)
        const generation = ++owner.generation
        const controller = new AbortController()
        const deadline = setTimeout(() => controller.abort(), 8000)
        const flight = { controller, promise: null }
        owner.pending = flight
        flight.promise = (async () => {
          try {
            const result = await statusRequest(updates, controller)
            if (!result?.ok) throw new Error('Status unavailable')
            if (owner.active && generation === owner.generation) {
              receive(result.value)
              owner.failures = 0
            }
          } catch {
            if (owner.active && generation === owner.generation) {
              setReadError(true)
              setConfirmVersion(null)
              if (installAttempted.current) setUncertain(true)
              owner.failures += 1
            }
          } finally {
            clearTimeout(deadline)
            if (owner.pending === flight) owner.pending = null
            if (owner.active) {
              setReading(false)
              owner.timer = setTimeout(
                refresh,
                owner.failures
                  ? Math.min(5000 * 2 ** Math.min(owner.failures - 1, 3), 30000)
                  : 3000,
              )
            }
          }
        })()
        return flight.promise
      }
      owner.refresh = refresh
      owner.invalidate = () => {
        owner.generation += 1
        owner.pending?.controller.abort()
      }
      void refresh()
      const stop = updates.subscribe(refresh)
      return () => {
        owner.active = false
        owner.invalidate()
        clearTimeout(owner.timer)
        stop()
        if (state.current === owner) state.current = null
      }
    }, [updates])
    const refresh = () => state.current?.refresh() ?? Promise.resolve()
    const unknown = uncertain || snapshot?.phase === 'outcome_unknown'
    const processing = progressing.has(snapshot?.phase) || operation !== null
    const installBlocked =
      disabled ||
      readOnly ||
      changed ||
      activeTasks > 0 ||
      readError ||
      unknown ||
      processing ||
      !snapshot?.canInstall
    async function run(action, expectedVersion) {
      const owner = state.current
      if (!owner?.active || currentOperation.current || readOnly || disabled)
        return
      if (action === 'check' && progressing.has(currentSnapshot.current?.phase))
        return
      if (
        action === 'install' &&
        (installBlocked ||
          !expectedVersion ||
          expectedVersion !== currentSnapshot.current?.latestVersion)
      )
        return
      currentOperation.current = action
      setOperation(action)
      setActionError(false)
      setConfirmVersion(null)
      owner.invalidate()
      if (action === 'install') installAttempted.current = true
      try {
        const result =
          action === 'install'
            ? await updates.install(expectedVersion)
            : await updates.check()
        if (!result?.ok) throw new Error('Update request unavailable')
        if (owner.active) receive(result.value, action === 'install')
      } catch {
        if (owner.active) {
          if (action === 'install') setUncertain(true)
          else setActionError(true)
        }
      } finally {
        if (owner.active) {
          currentOperation.current = null
          setOperation(null)
          await refresh()
        }
      }
    }
    let [label, description] = snapshot
      ? (phases[snapshot.phase] ?? phases.error)
      : ['读取更新状态…', '正在读取本机插件版本。']
    if (unknown) [label, description] = phases.outcome_unknown
    else if (readError)
      [label, description] = [
        '无法读取更新状态',
        '请确认插件已启用。若刚更新插件，请完全退出 Harness 后重新打开，再刷新更新状态。',
      ]
    else if (operation === 'install' && !progressing.has(snapshot?.phase))
      [label, description] = [
        '正在提交更新请求',
        '正在等待 Harness 接收更新请求，请勿重复安装。',
      ]
    else if (operation === 'check' && !progressing.has(snapshot?.phase))
      [label, description] = ['正在检查更新', phases.checking[1]]
    const errorHint =
      snapshot?.error && Object.hasOwn(errors, snapshot.error)
        ? errors[snapshot.error]
        : null
    const attention = readError || unknown || operation || (snapshot && !['idle', 'available'].includes(snapshot.phase))
    const autoTip = '开启后，每 24 小时检查正式版本，空闲时自动安装并提醒。Harness 需保持运行；错过的检查会在下次启动时补做，重启由你决定。'
      + (snapshot?.automatic?.enabled && snapshot.automatic.nextCheckAt
        ? ` 下次检查：${new Date(snapshot.automatic.nextCheckAt).toLocaleString()}` : '')
    return h(
      'section',
      { 'aria-label': '插件更新', style: { padding: 16, border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', display: 'grid', gap: 10 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('strong', { style: { fontSize: 13 } }, '插件更新'),
        h('span', { style: muted, title: `${snapshot ? `本次运行版本 ${snapshot.currentVersion}。` : ''}${label}。更新源：npm 官方仓库。` },
          snapshot ? `v${snapshot.currentVersion}` : '读取版本…'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' } },
          !readError && snapshot && !progressing.has(snapshot.phase) && snapshot.phase !== 'restart_required' && !unknown
            ? snapshot.phase === 'available' && snapshot.latestVersion
              ? h(Button, { type: 'button', variant: 'primary', disabled: installBlocked,
                title: !snapshot.canInstall ? '等待任务或授权结束后可更新' : undefined,
                onClick: () => setConfirmVersion(snapshot.latestVersion) }, `更新到 ${snapshot.latestVersion}`)
              : h(Button, { type: 'button', variant: 'ghost', disabled: disabled || readOnly || processing,
                onClick: () => run('check') }, '检查更新')
            : null,
          h(Button, { type: 'button', variant: 'ghost', 'aria-label': '刷新更新状态', title: '刷新更新状态',
            disabled: reading, 'aria-busy': reading, onClick: refresh,
            style: { minWidth: 24, padding: 4, fontSize: 17 } }, '↻'),
        ),
      ),
      onAutoChange ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
          h('input', { type: 'checkbox', role: 'switch', 'aria-label': '自动更新', checked: autoEnabled,
            disabled: autoDisabled, onChange: (event) => onAutoChange(event.target.checked) }),
          '自动更新',
        ),
        h(InfoTip, { label: '自动更新说明', text: autoTip }),
      ) : null,
      attention ? h('div', { style: { display: 'grid', gap: 6 } },
        h('p', { role: 'status', 'aria-live': 'polite', style: muted }, label,
          snapshot?.phase === 'available' && !readError && !unknown ? ` · ${snapshot.latestVersion}` : ''),
        readError || unknown || snapshot?.phase === 'restart_required'
          ? h('p', { style: muted }, description) : null,
        !readError && errorHint && !unknown ? h('p', { role: 'alert', style: muted }, errorHint) : null,
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          unknown || snapshot?.phase === 'restart_required'
            ? h(Button, { type: 'button', variant: 'outline', disabled: disabled || readOnly || operation !== null,
              onClick: () => run('check') }, '核对更新结果') : null,
        ),
        !readError && snapshot?.phase === 'available' && !snapshot.canInstall && !unknown
          ? h('p', { style: muted }, '等待任务或授权结束后可更新。') : null,
      ) : null,
      !attention && snapshot?.automatic?.enabled && snapshot.automatic.notice
        ? h('p', { role: 'status', style: muted }, updateNoticeText(snapshot.automatic.notice)) : null,
      confirmVersion && !readError && !unknown
        ? h(ConfirmDialog, {
            title: `确认更新到 ${confirmVersion}`,
            description: '安装期间会暂停接收任务，完成后可能需要重启 Harness。',
            onClose: () => setConfirmVersion(null),
          },
          h('div', { role: 'group', 'aria-label': '确认插件更新', style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            h(Button, { type: 'button', variant: 'ghost', 'data-modal-autofocus': true, onClick: () => setConfirmVersion(null) }, '取消'),
            h(Button, { type: 'button', variant: 'primary', disabled: installBlocked || snapshot?.latestVersion !== confirmVersion,
              onClick: () => run('install', confirmVersion) }, `确认安装 ${confirmVersion}`),
          )) : null,
      actionError && !unknown ? h('p', { role: 'alert', style: muted }, '检查失败，请刷新状态后重试。') : null,
    )
  }
}
