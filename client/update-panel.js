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
  credential_required: '请先配置 Gitea 只读凭据，再检查更新。',
  credential_invalid:
    'Gitea 未接受此凭据。请确认令牌具有 read:package 权限，且账号是 xbot 组织成员。',
}
const restartReasons = {
  'no-hmr': '当前宿主需要重启才能载入插件变更。',
  'package-moved': '插件安装位置已改变，需要重启宿主。',
  'host-module': '更新包含宿主模块，需要重启才能生效。',
  'unmanaged-plugin': '此插件无法在当前进程中重新加载，需要重启。',
  'module-comparison': '宿主无法确认模块是否可直接替换，需要重启。',
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

export function createUpdatePanel(React, Button) {
  const h = React.createElement
  const muted = { margin: 0, opacity: 0.72, fontSize: 12, lineHeight: 1.6 }
  return function UpdatePanel({
    updates,
    disabled = false,
    readOnly = false,
    changed = false,
    activeTasks = 0,
  }) {
    const [snapshot, setSnapshot] = React.useState(null)
    const [readError, setReadError] = React.useState(false)
    const [reading, setReading] = React.useState(false)
    const [operation, setOperation] = React.useState(null)
    const [uncertain, setUncertain] = React.useState(false)
    const [actionError, setActionError] = React.useState(false)
    const [confirmVersion, setConfirmVersion] = React.useState(null)
    const [credential, setCredential] = React.useState('')
    const [credentialError, setCredentialError] = React.useState(false)
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
      setCredential('')
      setCredentialError(false)
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
    const credentialBlocked =
      disabled || readOnly || readError || unknown || processing || !snapshot
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
    async function changeCredential(remove = false) {
      const owner = state.current
      if (!owner?.active || currentOperation.current || credentialBlocked)
        return
      const token = credential.trim()
      if (!remove && !token) return
      // Tokens are write-only: remove the input as soon as a request is sent,
      // including requests that later fail. The host preserves a prior token.
      setCredential('')
      currentOperation.current = remove ? 'credential-clear' : 'credential-save'
      setOperation(currentOperation.current)
      setCredentialError(false)
      setConfirmVersion(null)
      owner.invalidate()
      try {
        const result = remove
          ? await updates.clearCredential()
          : await updates.saveCredential(token)
        if (!result?.ok) throw new Error('Credential request unavailable')
        if (owner.active) receive(result.value)
      } catch {
        if (owner.active) setCredentialError(true)
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
    return h(
      'section',
      {
        'aria-label': '插件更新',
        style: {
          padding: 16,
          border: '1px solid var(--dsw-alias-border-l3)',
          borderRadius: 10,
          display: 'grid',
          gap: 10,
        },
      },
      h(
        'div',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
          },
        },
        h('strong', { style: { fontSize: 14 } }, '插件更新'),
        h(
          'span',
          {
            role: 'status',
            'aria-live': 'polite',
            style: { ...muted, marginLeft: 'auto' },
          },
          label,
        ),
      ),
      snapshot
        ? h(
            'p',
            { style: muted },
            `本次运行版本 ${snapshot.currentVersion}`,
            snapshot.latestVersion
              ? ` · 发布版本 ${snapshot.latestVersion}`
              : '',
          )
        : null,
      h('p', { style: muted }, description),
      !readError && errorHint && !unknown
        ? h('p', { role: 'alert', style: muted }, errorHint)
        : null,
      snapshot?.phase === 'restart_required' &&
        Object.hasOwn(restartReasons, snapshot.restartReason)
        ? h('p', { style: muted }, restartReasons[snapshot.restartReason])
        : null,
      snapshot?.checkedAt
        ? h(
            'p',
            { style: muted },
            `最近检查 ${new Date(snapshot.checkedAt).toLocaleString()}`,
          )
        : null,
      h(
        'div',
        { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        !readError &&
          snapshot &&
          !progressing.has(snapshot.phase) &&
          snapshot.phase !== 'restart_required' &&
          !unknown
          ? h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                disabled: disabled || readOnly || processing,
                onClick: () => run('check'),
              },
              '检查更新',
            )
          : null,
        !readError &&
          snapshot?.phase === 'available' &&
          !unknown &&
          snapshot.latestVersion
          ? h(
              Button,
              {
                type: 'button',
                variant: 'primary',
                disabled: installBlocked,
                onClick: () => setConfirmVersion(snapshot.latestVersion),
              },
              `更新到 ${snapshot.latestVersion}`,
            )
          : null,
        unknown || snapshot?.phase === 'restart_required'
          ? h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                disabled: disabled || readOnly || operation !== null,
                onClick: () => run('check'),
              },
              '核对更新结果',
            )
          : null,
        h(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            disabled: reading,
            'aria-busy': reading,
            onClick: refresh,
          },
          '刷新更新状态',
        ),
      ),
      changed
        ? h('p', { style: muted }, '请先保存或取消配置修改，再安装更新。')
        : activeTasks > 0
          ? h(
              'p',
              { style: muted },
              '任务执行期间不能更新插件，请等待任务结束。',
            )
          : null,
      !readError &&
        snapshot?.phase === 'available' &&
        !snapshot.canInstall &&
        !unknown
        ? h(
            'p',
            { style: muted },
            '当前暂不能安装，请等待任务或授权结束，并确认 Harness 的插件管理服务可用。',
          )
        : null,
      confirmVersion && !readError && !unknown
        ? h(
            'div',
            {
              role: 'group',
              'aria-label': '确认插件更新',
              style: {
                borderTop: '1px solid var(--dsw-alias-border-l3)',
                paddingTop: 10,
                display: 'grid',
                gap: 8,
              },
            },
            h(
              'strong',
              { style: { fontSize: 13 } },
              `确认更新到 ${confirmVersion}`,
            ),
            h(
              'p',
              { style: muted },
              '更新期间会暂停接收平台任务，Harness 可能要求重启。只有确认后才会下载安装。',
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h(
                Button,
                {
                  type: 'button',
                  variant: 'primary',
                  disabled:
                    installBlocked ||
                    snapshot?.latestVersion !== confirmVersion,
                  onClick: () => run('install', confirmVersion),
                },
                `确认安装 ${confirmVersion}`,
              ),
              h(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  onClick: () => setConfirmVersion(null),
                },
                '取消',
              ),
            ),
          )
        : null,
      actionError && !unknown
        ? h(
            'p',
            { role: 'alert', style: muted },
            '未能完成更新检查。请刷新状态，确认 Harness 已连接后重试。',
          )
        : null,
      h(
        'details',
        {
          style: {
            borderTop: '1px solid var(--dsw-alias-border-l3)',
            paddingTop: 10,
          },
        },
        h(
          'summary',
          { style: { cursor: 'pointer', fontSize: 13 } },
          '更新源授权',
          snapshot && !readError
            ? snapshot.hasCredential
              ? ' · 已配置凭据'
              : ' · 未配置凭据'
            : '',
        ),
        h(
          'div',
          { style: { display: 'grid', gap: 8, paddingTop: 10 } },
          h(
            'p',
            { style: muted },
            '更新源：Gitea · xbot / deepseek-harness-a2a。请使用仅含 read:package 权限的令牌，账号需是 xbot 组织成员。',
          ),
          h(
            'a',
            {
              href: 'https://gitea.guanzhu.me/user/settings/applications',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { fontSize: 12 },
            },
            '在 Gitea 创建只读令牌',
          ),
          h(
            'a',
            {
              href: 'https://gitea.guanzhu.me/xbot/-/packages?q=deepseek-harness-a2a',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { fontSize: 12 },
            },
            '查看 Gitea 发布包',
          ),
          h(
            'label',
            { style: { display: 'grid', gap: 6, fontSize: 12 } },
            'Gitea 只读令牌',
            h('input', {
              type: 'password',
              name: 'gitea-package-token',
              value: credential,
              autoComplete: 'off',
              spellCheck: false,
              maxLength: 4096,
              disabled: credentialBlocked,
              placeholder: snapshot?.hasCredential
                ? '输入新令牌以替换已保存凭据'
                : '粘贴只读令牌',
              onChange: (event) => setCredential(event.target.value),
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l3)',
                background: 'transparent',
                color: 'inherit',
              },
            }),
          ),
          h(
            'p',
            { style: muted },
            '凭据仅保存在本机，保存后输入会立即清空，不会回填已保存的令牌。',
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                disabled: credentialBlocked || !credential.trim(),
                onClick: () => changeCredential(),
              },
              operation === 'credential-save' ? '正在保存凭据…' : '保存凭据',
            ),
            snapshot?.hasCredential
              ? h(
                  Button,
                  {
                    type: 'button',
                    variant: 'ghost',
                    disabled: credentialBlocked,
                    onClick: () => changeCredential(true),
                  },
                  operation === 'credential-clear'
                    ? '正在移除凭据…'
                    : '移除凭据',
                )
              : null,
          ),
          credentialError
            ? h(
                'p',
                { role: 'alert', style: muted },
                '未能确认凭据变更。请刷新更新状态后重试；输入已清空。',
              )
            : null,
        ),
      ),
    )
  }
}
