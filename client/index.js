// DSH supplies React, its configuration store and native project/model catalogs.
window.__ModuleLoader__.load({
  id: '@xbot/deepseek-harness-a2a',
  factory: (require) => {
    const React = require('react')
    const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const fields = ['workingDirectory', 'agentPreset', 'provider', 'model']
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
          typeof value?.[field] === 'string' ? value[field] : '',
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
      const editable =
        snapshot.status === 'ready' &&
        snapshot.writable &&
        snapshot.mode === 'host'
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
              text: '无法打开文件夹选择器，请填写本机目录的完整路径，或选择已有工作区。',
            })
        } finally {
          if (mounted.current) setBusy(null)
        }
      }
      async function save(event) {
        event.preventDefault()
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
            setDraft(null)
            setNotice({
              error: false,
              text: '任务配置已保存，新平台对话将使用此工作区、Agent 预设和默认模型。已有会话保留原工作区，在 DSH 中继续查看和操作。',
            })
          } else {
            setNotice({
              error: true,
              text: '未能保存。请确认目录和预设可用；配置可能已更新，请取消修改后重试。',
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
      const disabled = !editable || busy !== null
      return h(
        'form',
        {
          onSubmit: save,
          'aria-label': 'Xbot 平台任务配置',
          style: { display: 'grid', gap: 12, maxWidth: 680, minWidth: 0 },
        },
        h('h3', { style: { margin: 0, fontSize: 16 } }, 'Xbot 平台任务'),
        h(
          'p',
          { style: muted },
          '平台任务会话保存在 DSH 左侧的工作区中。工作区就是任务实际执行的项目目录，任务结束后会话仍然保留。',
        ),
        h('label', { htmlFor: `${id}-project` }, '工作区（项目目录）'),
        h(
          'select',
          {
            id: `${id}-project`,
            'aria-label': '工作区',
            value:
              project?.workspaceId ??
              (value.workingDirectory ? '__custom__' : ''),
            disabled: disabled || projects.phase !== 'ready',
            style: selectStyle,
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
          h(
            'option',
            { value: '' },
            '使用 Harness 默认目录',
          ),
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
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
            },
          },
          h(
            'div',
            { style: { flex: '1 1 300px', minWidth: 0, display: 'grid' } },
            h(Input, {
              id: `${id}-directory`,
              'aria-label': '工作区目录',
              value: value.workingDirectory,
              onChange: (event) =>
                update({ workingDirectory: event.target.value }),
              disabled,
              placeholder: '选择文件夹或输入完整目录路径；留空使用 Harness 默认目录',
              autoComplete: 'off',
              spellCheck: false,
              style: { width: '100%' },
            }),
          ),
          h(
            Button,
            { type: 'button', variant: 'outline', disabled, onClick: choose },
            busy === 'pick' ? '正在选择…' : '选择文件夹',
          ),
        ),
        h(
          'p',
          { style: { ...muted, fontSize: 12, overflowWrap: 'anywhere' } },
          saved.workingDirectory
            ? `已保存的工作区目录：${saved.workingDirectory}`
            : '当前使用 Harness 默认目录，它不跟随左侧临时选中的工作区。',
        ),
        h(
          'p',
          { style: muted },
          '选择已有工作区或选择文件夹会设置同一个目录。新目录会在首次任务时加入左侧工作区。更换目录后，请在平台开启新对话。',
        ),
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
              { key: item.id, value: item.id, disabled: Boolean(item.broken) },
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
                '在 Harness 的 Agent 预设中配置工具。运行命令需要所选预设包含 Shell 工具。'),
        ),
        h('label', { htmlFor: `${id}-model` }, '模型'),
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
          'p',
          { style: muted },
          '此处选择新会话的默认模型。已有会话可在 DSH 的模型选择器中调整。添加模型和密钥：Harness 设置 → 模型。',
        ),
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
            '在 Harness 设置 → 常规 → 权限中调整新会话默认值。已有会话保留原权限，需要确认的工具仍由 Harness 审批。插件不会自动放开权限。',
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
          ? h('p', { role: 'alert', style: muted }, catalogs.errors.join('；'))
          : null,
        snapshot.status === 'loading'
          ? h('p', { role: 'status', style: muted }, '正在读取配置…')
          : !editable
            ? h(
                'p',
                { role: 'status', style: muted },
                '请在本机 Harness 中启用此插件后配置任务。',
              )
            : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(
            Button,
            {
              type: 'submit',
              variant: 'primary',
              disabled: disabled || !changed,
            },
            busy === 'save' ? '正在保存…' : '保存任务配置',
          ),
          changed
            ? h(
                Button,
                {
                  type: 'button',
                  variant: 'ghost',
                  disabled: busy !== null,
                  onClick: () => {
                    setDraft(null)
                    setNotice(null)
                  },
                },
                '取消修改',
              )
            : null,
        ),
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
    function apply(ctx) {
      const configForm = ctx.configForms.get('xbot-a2a')
      const actions = {
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
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: '@xbot/deepseek-harness-a2a',
              inject: () => actions,
            },
            ConfigurationPage,
          ),
        ),
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'xbot-a2a',
              label: 'Xbot 平台任务',
              order: 80,
              inject: () => actions,
            },
            ConfigurationPage,
          ),
        ),
      ]
      return () => disposers.forEach((dispose) => dispose())
    }
    return { apply, inject }
  },
})
