import { connectionContribution } from '../src/connection-contract.ts'
import { createConnectionPanel } from './connection-panel.js'
import { createUpdatePanel } from './update-panel.js'
import { createUpdateReminder } from './update-reminder.js'
import { createInfoTip } from './ui-help.js'

// DSH supplies React, its configuration store and native project/model catalogs.
window.__ModuleLoader__.load({
  id: '@guanzhu.me/dsh-a2a',
  factory: (require) => {
    const React = require('react')
    const { Button, Input, Toast, Tooltip, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
    const InfoTip = createInfoTip(React, Tooltip)
    const ConnectionPanel = createConnectionPanel(React, Button, { Tooltip, Modal })
    const UpdatePanel = createUpdatePanel(React, Button, { Tooltip, Modal })
    const UpdateReminder = createUpdateReminder(React, Toast)
    const h = React.createElement
    const fields = [
      'gatewayUrl',
      'deviceName',
      'deviceDescription',
      'workingDirectory',
      'agentPreset',
      'provider',
      'model',
      'automaticUpdates',
    ]
    const muted = { margin: 0, opacity: 0.72, lineHeight: 1.6 }
    const selectStyle = {
      width: '100%',
      padding: 8,
      borderRadius: 6,
      color: 'inherit',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l3)',
    }
    const valuesOf = (value) =>
      Object.fromEntries(
        fields.map((field) => [
          field,
          field === 'automaticUpdates' ? value?.[field] === true
            : typeof value?.[field] === 'string' ? value[field] : '',
        ]),
      )
    const modelKey = (provider, model) =>
      provider && model ? JSON.stringify([provider, model]) : ''
    const directoryKey = (path) => {
      const value = path ?? ''
      return /^[A-Za-z]:[\\/]|^[\\/]{2}/u.test(value)
        ? value.replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase()
        : value.replace(/\/+$/u, '') || '/'
    }

    function ConfigurationPage({
      form,
      workspaces,
      pickDirectory,
      loadCatalogs,
      subscribeCatalogs,
      connection,
      updates,
    }) {
      const snapshot = React.useSyncExternalStore(
        form.subscribe,
        form.getSnapshot,
      )
      const projects = React.useSyncExternalStore(
        workspaces.subscribe,
        workspaces.getSnapshot,
      )
      const saved = valuesOf(snapshot.value)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [catalogs, setCatalogs] = React.useState({ loading: true })
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        let generation = 0
        const refresh = async () => {
          const current = ++generation
          // Clear stale Host choices while a replacement catalog is loading.
          setCatalogs({ loading: true })
          const value = await loadCatalogs()
          if (mounted.current && current === generation) setCatalogs(value)
        }
        void refresh()
        const stop = subscribeCatalogs(refresh)
        return () => {
          mounted.current = false
          generation += 1
          stop()
        }
      }, [loadCatalogs, subscribeCatalogs])
      const editable = snapshot.status === 'ready' && snapshot.writable === true
      const configurationReason =
        snapshot.status === 'loading'
          ? '正在读取插件配置，读取完成后可操作。'
          : snapshot.status === 'unavailable'
            ? 'Harness 暂未提供此插件的配置，请检查插件是否启用。'
            : snapshot.status !== 'ready'
              ? '暂时无法读取插件配置，请等待配置恢复后再操作。'
              : snapshot.writable !== true
                ? '当前连接没有配置写入权限，连接和更新操作暂不可用。'
                : null
      const value = draft?.value ?? saved
      const changed = fields.some((field) => value[field] !== saved[field])
      const update = (patch) => {
        setDraft((previous) => ({
          value: { ...(previous?.value ?? saved), ...patch },
          revision: previous?.revision ?? snapshot.revision,
        }))
        setNotice(null)
      }
      const presets = catalogs.presets?.presets ?? []
      const defaultPreset = presets.find((item) => item.isDefault)
      const groups = catalogs.models?.groups ?? []
      const selectedPreset = presets.find((item) =>
        value.agentPreset ? item.id === value.agentPreset : item.isDefault,
      )
      const modelSelection = modelKey(value.provider, value.model)
      const availableModel = groups.some(
        (group) =>
          group.id === value.provider &&
          group.models.some((model) => model.id === value.model),
      )
      const permission = catalogs.permissions?.defaultOptions?.find(
        (item) => item.value === catalogs.permissions.defaultPreset,
      )
      const project = projects.items.find(
        (item) =>
          value.workingDirectory &&
          directoryKey(item.path) === directoryKey(value.workingDirectory),
      )
      const id = React.useId()

      async function choose() {
        setBusy('pick')
        setNotice(null)
        try {
          const selected = await pickDirectory()
          if (mounted.current && selected !== null)
            update({ workingDirectory: selected })
        } catch {
          if (mounted.current)
            setNotice({
              error: true,
              text: '无法打开本地文件夹对话框，请重试或选择已有工作区。',
            })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }
      async function save(event) {
        event?.preventDefault()
        if (!editable || busy || !changed || !draft) return
        setBusy('save')
        setNotice(null)
        try {
          const accepted = await form.mutate(
            fields
              .filter((field) => value[field] !== saved[field])
              .map((field) => ({
                op: 'set',
                path: [field],
                value: value[field],
              })),
            draft.revision,
          )
          if (!mounted.current) return
          if (accepted) {
            setDraft((previous) => previous === draft ? null : previous && ({
              ...previous, revision: form.getSnapshot().revision,
            }))
            setNotice({
              error: false,
              text: '已自动保存',
            })
          } else {
            setNotice({
              error: true,
              text: '未能保存。请确认目录和预设可用；配置可能已更新，请撤销修改后重试。',
            })
          }
        } catch {
          if (mounted.current)
            setNotice({
              error: true,
              text: '保存失败，请检查 Harness 连接后重试。',
            })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }
      React.useEffect(() => {
        if (!editable || busy || !changed || !draft || notice?.error) return
        const timer = setTimeout(() => { void save() }, 600)
        return () => clearTimeout(timer)
      }, [draft, editable, busy, changed, snapshot.revision, notice?.error])
      const disabled = !editable || busy !== null
      return h(
        'form',
        {
          onSubmit: save,
          'aria-label': 'A2A 平台任务配置',
          style: { display: 'grid', gap: 12, maxWidth: 680, minWidth: 0 },
        },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'A2A 平台任务'),
        h(ConnectionPanel, {
          connection,
          disabled: disabled || changed,
          readOnly: !editable,
          changed,
          disabledReason:
            configurationReason ??
            (busy === 'save'
              ? '正在保存配置，请等待保存完成。'
              : busy === 'pick'
                ? '正在选择工作区，请完成或取消选择后再操作。'
                : null),
        },
        h(
          'section',
          {
            'aria-label': '平台地址',
            style: { display: 'grid', gap: 8, padding: '8px 0' },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('label', { htmlFor: `${id}-gateway` }, '平台地址'),
            h(InfoTip, { label: '平台地址说明', text: '填写平台网址。更换地址后需要重新授权。' }),
          ),
          h(Input, {
            id: `${id}-gateway`,
            'aria-label': '平台地址',
            value: value.gatewayUrl,
            maxLength: 500,
            disabled,
            placeholder: 'https://platform.example.com',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => update({ gatewayUrl: event.target.value }),
          }),
        )
        ),
        h(
          'section',
          {
            'aria-label': '任务运行',
            style: {
              display: 'grid',
              gap: 8,
              padding: 16,
              border: '1px solid var(--dsw-alias-border-l3)',
              borderRadius: 10,
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('label', { htmlFor: `${id}-project` }, '工作区（项目目录）'),
            h(InfoTip, { label: '工作区（项目目录）说明', text: '任务在此目录运行；更换目录后请开启新对话。' }),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 } },
          h(
            'select',
            {
              id: `${id}-project`,
              'aria-label': '工作区',
              title: value.workingDirectory || '使用 Harness 默认目录',
              value:
                project?.workspaceId ??
                (value.workingDirectory ? '__custom__' : ''),
              disabled: disabled || projects.phase !== 'ready',
              style: { ...selectStyle, flex: '1 1 0', minWidth: 0, width: 0 },
              onChange: (event) => {
                if (!event.target.value) {
                  update({ workingDirectory: '' })
                  return
                }
                const item = projects.items.find(
                  (entry) => entry.workspaceId === event.target.value,
                )
                if (item) update({ workingDirectory: item.path })
              },
            },
            h('option', { value: '' }, '使用 Harness 默认目录'),
            value.workingDirectory && !project
              ? h(
                  'option',
                  { value: '__custom__' },
                  `所选目录 · ${value.workingDirectory}`,
                )
              : null,
            projects.items.map((item) =>
              h(
                'option',
                { key: item.workspaceId, value: item.workspaceId },
                `${item.title} · ${item.path}`,
              ),
            ),
          ),
            h(
              Button,
              { type: 'button', variant: 'outline', disabled, onClick: choose, style: { flexShrink: 0, whiteSpace: 'nowrap' } },
              busy === 'pick' ? '正在选择…' : '选择目录',
            ),
          ),
        h(
          'details',
          { style: { borderTop: '1px solid var(--dsw-alias-border-l3)', paddingTop: 12 } },
          h('summary', { style: { cursor: 'pointer', fontSize: 13, padding: '4px 0' } }, '高级设置 · 设备、预设与模型'),
        h(
          'section',
          {
            'aria-label': '设备信息',
            style: { display: 'grid', gap: 8, padding: '8px 0' },
          },
          h('h4', { style: { margin: '0 0 4px', fontSize: 14 } }, '设备信息'),
          h('label', { htmlFor: `${id}-name` }, '设备名称'),
          h(Input, {
            id: `${id}-name`,
            'aria-label': '设备名称',
            value: value.deviceName,
            maxLength: 200,
            disabled,
            placeholder: '留空使用 DeepSeek Harness（计算机名）',
            onChange: (event) => update({ deviceName: event.target.value }),
          }),
          h('label', { htmlFor: `${id}-description` }, '设备描述（可选）'),
          h('textarea', {
            id: `${id}-description`,
            'aria-label': '设备描述',
            value: value.deviceDescription,
            maxLength: 1000,
            rows: 2,
            disabled,
            style: { ...selectStyle, resize: 'vertical' },
            placeholder:
              '说明此设备适合处理的任务，平台子 Agent 列表和 A2A Card 会展示。',
            onChange: (event) =>
              update({ deviceDescription: event.target.value }),
          }),
        ),
          h('div', { style: { display: 'grid', gap: 8, padding: '8px 0' } },
          h('label', { htmlFor: `${id}-preset` }, 'Agent 预设（工具集）'),
          h(
            'select',
            {
              id: `${id}-preset`,
              'aria-label': 'Agent 预设',
              value: value.agentPreset,
              disabled: disabled || !catalogs.presets,
              style: selectStyle,
              onChange: (event) => update({ agentPreset: event.target.value }),
            },
            h(
              'option',
              { value: '' },
              `跟随 Harness 默认${defaultPreset ? ` · ${defaultPreset.name ?? defaultPreset.id}` : ''}`,
            ),
            value.agentPreset &&
              !presets.some((item) => item.id === value.agentPreset)
              ? h(
                  'option',
                  { value: value.agentPreset, disabled: true },
                  `不可用：${value.agentPreset}`,
                )
              : null,
            presets.map((item) =>
              h(
                'option',
                {
                  key: item.id,
                  value: item.id,
                  disabled: Boolean(item.broken),
                },
                `${item.name ?? item.id}${item.broken ? '（不可用）' : ''}`,
              ),
            ),
          ),
          h(
            'p',
            { style: muted },
            selectedPreset?.broken
              ? `所选预设不可用：${selectedPreset.broken}`
              : (selectedPreset?.description ??
                  '工具由所选 Agent 预设决定。'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('label', { htmlFor: `${id}-model` }, '模型'),
            h(InfoTip, { label: '模型说明', text: '仅影响新会话。添加模型请前往 Harness 设置 → 模型。' }),
          ),
          h(
            'select',
            {
              id: `${id}-model`,
              'aria-label': '模型',
              value: modelSelection,
              disabled: disabled || !catalogs.models,
              style: selectStyle,
              onChange: (event) => {
                const [provider, model] = event.target.value
                  ? JSON.parse(event.target.value)
                  : ['', '']
                update({ provider, model })
              },
            },
            h(
              'option',
              { value: '' },
              `跟随 Harness 默认${catalogs.models?.default ? ` · ${catalogs.models.default.provider}/${catalogs.models.default.model}` : ''}`,
            ),
            modelSelection && !availableModel
              ? h(
                  'option',
                  { value: modelSelection, disabled: true },
                  `不可用：${value.provider}/${value.model}`,
                )
              : null,
            groups.map((group) =>
              h(
                'optgroup',
                { key: group.id, label: group.name },
                group.models.map((model) =>
                  h(
                    'option',
                    { key: model.id, value: modelKey(group.id, model.id) },
                    model.name ?? model.id,
                  ),
                ),
              ),
            ),
          ),
          catalogs.models?.failures?.length
            ? h(
                'p',
                { role: 'status', style: muted },
                `部分模型服务暂不可用：${catalogs.models.failures.map((item) => item.name).join('、')}`,
              )
            : null,
          h(
            'div',
            {
              style: {
                borderTop: '1px solid var(--dsw-alias-border-l3)',
                paddingTop: 12,
              },
            },
            h('strong', null, '权限'),
            h(
              'p',
              { style: muted },
              permission
                ? `新会话继承：${permission.name}（${permission.value}）`
                : catalogs.permissions
                  ? `新会话继承：${catalogs.permissions.defaultPreset}`
                  : '正在读取 Harness 的权限默认值。',
            ),
            permission?.description
              ? h('p', { style: muted }, permission.description)
              : null,
            h(
              'p',
              { style: muted },
              '权限跟随 Harness 设置 → 常规 → 权限。',
            ),
          ),
          catalogs.loading
            ? h(
                'p',
                { role: 'status', style: muted },
                '正在读取 Harness 的预设、模型和权限…',
              )
            : null,
          catalogs.errors?.length
            ? h(
                'p',
                { role: 'alert', style: muted },
                catalogs.errors.join('；'),
              )
            : null,
          ),
        ),
        ),
        h(UpdatePanel, {
          updates,
          disabled: disabled || changed,
          readOnly: !editable,
          changed,
          autoEnabled: value.automaticUpdates,
          autoDisabled: disabled,
          onAutoChange: (enabled) => update({ automaticUpdates: enabled }),
        }),
        configurationReason
          ? h('p', { role: 'status', style: muted }, configurationReason)
          : null,
        notice?.error && changed
          ? h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { type: 'button', disabled, onClick: () => { void save() } }, '重试保存'),
              h(Button, { type: 'button', variant: 'ghost', disabled,
                onClick: () => { setDraft(null); setNotice(null) } }, '撤销修改'))
          : null,
        notice
          ? h(
              'p',
              {
                role: notice.error ? 'alert' : 'status',
                style: { margin: 0, lineHeight: 1.6 },
              },
              notice.text,
            )
          : null,
      )
    }

    const inject = [
      'slots',
      'configForms',
      'uiWorkspace',
      'workspaces',
      'remote',
      'remote.session',
      'remote.agentPresets',
      'remote.permissionPresets',
    ]
    const installSettings = (ctx) => {
      const configForm = ctx.configForms.get('dsh-a2a')
      const actions = {
        connection: {
          status: ({ signal } = {}) => ctx.remote.dshA2a.status(signal),
          connect: () => ctx.remote.dshA2a.connect(),
          reauthorize: () => ctx.remote.dshA2a.reauthorize(),
          cancelAuthorization: () => ctx.remote.dshA2a.cancelAuthorization(),
          revokeAuthorization: () => ctx.remote.dshA2a.revokeAuthorization(),
          subscribe: (refresh) => ctx.on('connection/reset', refresh),
        },
        updates: {
          status: ({ signal } = {}) => ctx.remote.dshA2a.updateStatus(signal),
          check: () => ctx.remote.dshA2a.checkUpdate(),
          install: (version) => ctx.remote.dshA2a.installUpdate(version),
          subscribe: (refresh) => ctx.on('connection/reset', refresh),
        },
        form: {
          subscribe: (listener) => configForm.subscribe(listener),
          getSnapshot: () => configForm.getSnapshot(),
          mutate: (ops, revision) => configForm.mutate(ops, revision),
        },
        workspaces: {
          subscribe: (listener) => ctx.workspaces.list.subscribe(listener),
          getSnapshot: () => ctx.workspaces.list.getSnapshot(),
        },
        pickDirectory: () => {
          const desktop = globalThis.__DSH_DIRECTORY_PICKER__
          return desktop === undefined
            ? ctx.uiWorkspace.pickDirectory()
            : desktop.pick()
        },
        loadCatalogs: async () => {
          const requests = [
            ['presets', 'Agent 预设', () => ctx.remote.agentPresets.list()],
            ['models', '模型', () => ctx.remote.session.modelCatalog()],
            [
              'permissions',
              '权限',
              () => ctx.remote.permissionPresets.catalog(),
            ],
          ]
          const results = await Promise.allSettled(
            requests.map(([, , read]) => Promise.resolve().then(read)),
          )
          const value = { loading: false, errors: [] }
          results.forEach((result, index) => {
            const [key, label] = requests[index]
            if (result.status === 'fulfilled' && result.value.ok)
              value[key] = result.value.value
            else
              value.errors.push(
                `无法读取${label}，请检查 Harness 连接或相应插件是否启用。`,
              )
          })
          return value
        },
        subscribeCatalogs: (refresh) => {
          const disposers = [
            'llm/adapters-updated',
            'settings/document-updated',
            'permission-presets/catalog-changed',
          ].map((event) => ctx.remote.$on(event, refresh))
          disposers.push(ctx.on('connection/reset', refresh))
          return () => disposers.forEach((dispose) => dispose())
        },
      }
      const disposers = [
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-a2a-update-reminder', order: 80,
              inject: () => ({ updates: actions.updates }) },
            UpdateReminder,
          ),
        ),
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: '@guanzhu.me/dsh-a2a',
              inject: () => actions,
            },
            ConfigurationPage,
          ),
        ),
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-a2a',
              label: 'A2A 平台任务',
              order: 80,
              inject: () => actions,
            },
            ConfigurationPage,
          ),
        ),
      ]
      return () => disposers.forEach((dispose) => dispose())
    }
    async function apply(ctx) {
      const unmountConnection = await ctx.remote.$mount(
        connectionContribution(require('zod').z),
      )
      // $mount creates the namespace service but does not grant this plugin
      // permission to read it. Inject only after mounting to avoid waiting
      // for a service that this plugin itself must provide.
      const settings = ctx.inject(
        [...inject, 'remote.dshA2a'],
        installSettings,
      )
      await settings
      return async () => {
        await settings.dispose()
        await unmountConnection()
      }
    }
    return { apply, inject }
  },
})
