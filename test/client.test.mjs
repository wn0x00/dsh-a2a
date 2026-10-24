import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import { act, create } from 'react-test-renderer'

const source = await readFile(
  new URL('../dist/client.js', import.meta.url),
  'utf8',
)

async function renderConfiguration(t, options = {}) {
  let snapshot = {
    status: 'ready',
    mode: 'host',
    writable: true,
    revision: 3,
    value: { workingDirectory: 'C:\\Projects\\old' },
    ...options.snapshot,
  }
  const listeners = new Set()
  const writes = []
  let picked = 0
  let registered
  const registrations = []
  const remoteListeners = new Set()
  let client
  const publish = (next) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, revision) => {
      writes.push({ ops: JSON.parse(JSON.stringify(ops)), revision })
      if (options.saveError) throw new Error('offline')
      if (options.refuse || revision !== snapshot.revision) return false
      publish({
        value: {
          ...snapshot.value,
          ...Object.fromEntries(ops.map((op) => [op.path[0], op.value])),
        },
        revision: revision + 1,
      })
      return true
    },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          assert.equal(id, '@xbot/deepseek-harness-a2a')
          client = factory((name) => {
            if (name === 'react') return React
            assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
            return {
              Button: (props) => React.createElement('button', props),
              Input: (props) => React.createElement('input', props),
            }
          })
        },
      },
    },
    ...(options.desktop ? { __DSH_DIRECTORY_PICKER__: options.desktop } : {}),
  }
  vm.runInNewContext(source, sandbox)
  const projectSnapshot = {
    phase: 'ready',
    items: [
      {
        workspaceId: 'project-a',
        path: 'C:\\Projects\\existing',
        title: '已有工程',
      },
    ],
  }
  const dispose = client.apply({
    on: (_event, listener) => {
      remoteListeners.add(listener)
      return () => remoteListeners.delete(listener)
    },
    configForms: {
      get: (namespace) => {
        assert.equal(namespace, 'xbot-a2a')
        return form
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => projectSnapshot,
        subscribe: () => () => {},
      },
    },
    remote: {
      agentPresets: {
        list: async () =>
          options.catalogError
            ? { ok: false }
            : {
                ok: true,
                value: {
                  presets: [
                    {
                      id: 'desktop',
                      name: '桌面助手',
                      isDefault: true,
                      description: '文件与命令工具',
                    },
                    { id: 'coding', name: '代码助手', isDefault: false },
                    {
                      id: 'broken',
                      name: '无效预设',
                      isDefault: false,
                      broken: 'missing package',
                    },
                  ],
                },
              },
      },
      session: {
        modelCatalog: async () => ({
          ok: true,
          value: {
            default: { provider: 'mimo', model: 'mimo-v2.5-pro' },
            groups: [
              {
                id: 'mimo',
                name: 'MiMo',
                models: [{ id: 'mimo-v2.5-pro', name: 'MiMo Pro' }],
              },
              {
                id: 'deepseek',
                name: 'DeepSeek',
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
              },
            ],
            failures: [],
          },
        }),
      },
      permissionPresets: {
        catalog: async () => ({
          ok: true,
          value: {
            defaultPreset: 'workspace-write',
            defaultOptions: [
              {
                value: 'workspace-write',
                name: '工作区写入',
                description: '工作目录可写，外部操作需要审批。',
              },
            ],
          },
        }),
      },
      $on: (_event, listener) => {
        remoteListeners.add(listener)
        return () => remoteListeners.delete(listener)
      },
    },
    uiWorkspace: {
      pickDirectory: async () => {
        picked += 1
        if (options.pickError) throw new Error('native picker unavailable')
        return options.selection === undefined
          ? 'C:\\Projects\\new'
          : options.selection
      },
    },
    slots: {
      inject: (name, register) => {
        assert.ok(['plugins.bundle.config', 'settings.section'].includes(name))
        return register()
      },
      register: (metadata, component) => {
        registrations.push({ metadata, component })
        if (metadata.name === 'plugins.bundle.config')
          registered = { metadata, component }
        return () => undefined
      },
    },
  })
  assert.equal(registered.metadata.key, '@xbot/deepseek-harness-a2a')
  let view
  await act(async () => {
    view = create(
      React.createElement(registered.component, registered.metadata.inject()),
    )
  })
  t.after(async () => {
    await act(async () => {
      view.unmount()
    })
    dispose()
    assert.equal(listeners.size, 0)
    assert.equal(remoteListeners.size, 0)
  })
  return {
    view,
    writes,
    registrations,
    publish,
    picked: () => picked,
    input: () => view.root.findByProps({ 'aria-label': '工作区目录' }),
    button: (label) =>
      view.root
        .findAllByType('button')
        .find((button) => button.children.join('') === label),
    text: () => JSON.stringify(view.toJSON()),
    choose: async () => {
      await act(async () => {
        await view.root
          .findAllByType('button')
          .find((button) => button.children.join('') === '选择文件夹')
          .props.onClick()
      })
    },
    edit: async (value) => {
      await act(async () => {
        view.root.findByProps({ 'aria-label': '工作区目录' }).props.onChange({ target: { value } })
      })
    },
    select: async (label, value) => {
      await act(async () =>
        view.root
          .findAllByType('select')
          .find((element) => element.props['aria-label'] === label)
          .props.onChange({ target: { value } }),
      )
    },
    save: async () => {
      await act(async () => {
        await view.root
          .findByType('form')
          .props.onSubmit({ preventDefault() {} })
      })
    },
  }
}

test('native bundle configuration reads the host value and saves the chosen directory with its revision', async (t) => {
  const page = await renderConfiguration(t)
  assert.equal(page.input().props.value, 'C:\\Projects\\old')
  assert.equal(page.button('保存任务配置').props.disabled, true)
  await page.choose()
  assert.equal(page.picked(), 1)
  assert.equal(page.input().props.value, 'C:\\Projects\\new')
  assert.equal(page.writes.length, 0)
  await page.save()
  assert.deepEqual(page.writes, [
    {
      ops: [
        { op: 'set', path: ['workingDirectory'], value: 'C:\\Projects\\new' },
      ],
      revision: 3,
    },
  ])
  assert.match(page.text(), /配置已保存/)
  assert.equal(page.button('保存任务配置').props.disabled, true)
})

test('desktop picker takes precedence over the host picker and cancel preserves the saved directory', async (t) => {
  let calls = 0
  const page = await renderConfiguration(t, {
    desktop: {
      pick: async () => {
        calls += 1
        return null
      },
    },
  })
  await page.choose()
  assert.equal(calls, 1)
  assert.equal(page.picked(), 0)
  assert.equal(page.input().props.value, 'C:\\Projects\\old')
  assert.equal(page.button('保存任务配置').props.disabled, true)
  assert.equal(page.writes.length, 0)
})

test('manual directory entry remains usable when the OS picker is unavailable', async (t) => {
  const page = await renderConfiguration(t, { pickError: true })
  await page.choose()
  assert.match(page.text(), /无法打开文件夹选择器/)
  await page.edit('C:\\Users\\用户\\工作目录')
  await page.save()
  assert.equal(page.writes[0].ops[0].value, 'C:\\Users\\用户\\工作目录')
  assert.match(page.text(), /配置已保存/)
})

test('host validation refusal never displays an unsaved path as saved', async (t) => {
  const page = await renderConfiguration(t, { refuse: true })
  await page.edit('C:\\missing')
  await page.save()
  assert.match(page.text(), /未能保存/)
  assert.doesNotMatch(page.text(), /任务配置已保存/)
  assert.equal(page.input().props.value, 'C:\\missing')
  await act(async () => page.button('取消修改').props.onClick())
  assert.equal(page.input().props.value, 'C:\\Projects\\old')
})

test('a concurrent host edit is fenced by the revision read when drafting began', async (t) => {
  const page = await renderConfiguration(t)
  await page.edit('C:\\my-edit')
  await act(async () =>
    page.publish({
      value: { workingDirectory: 'C:\\another-editor' },
      revision: 4,
    }),
  )
  await page.save()
  assert.equal(page.writes[0].revision, 3)
  assert.match(page.text(), /未能保存/)
  await act(async () => page.button('取消修改').props.onClick())
  assert.equal(page.input().props.value, 'C:\\another-editor')
})

test('connection failure keeps the draft and allows retry', async (t) => {
  const page = await renderConfiguration(t, { saveError: true })
  await page.choose()
  await page.save()
  assert.match(page.text(), /保存失败，请检查 Harness 连接后重试/)
  assert.equal(page.button('保存任务配置').props.disabled, false)
  assert.equal(page.input().props.value, 'C:\\Projects\\new')
})

for (const snapshot of [
  { status: 'loading' },
  { status: 'unavailable' },
  { writable: false },
  { mode: 'memory' },
]) {
  test(`configuration cannot write while ${JSON.stringify(snapshot)}`, async (t) => {
    const page = await renderConfiguration(t, { snapshot })
    assert.equal(page.input().props.disabled, true)
    assert.equal(page.button('选择文件夹').props.disabled, true)
    assert.equal(page.button('保存任务配置').props.disabled, true)
    await page.save()
    assert.equal(page.writes.length, 0)
  })
}

test('settings has a discoverable entry and real project, preset, model and inherited permission choices', async (t) => {
  const page = await renderConfiguration(t)
  assert.equal(
    page.registrations.find(
      (entry) => entry.metadata.name === 'settings.section',
    ).metadata.label,
    'Xbot 平台任务',
  )
  assert.match(page.text(), /工作区写入/)
  assert.match(page.text(), /外部操作需要审批/)
  assert.match(page.text(), /MiMo Pro/)
  await page.select('工作区', 'project-a')
  await page.select('Agent 预设', 'coding')
  await page.select('模型', JSON.stringify(['deepseek', 'deepseek-chat']))
  await page.save()
  assert.deepEqual(page.writes[0].ops, [
    { op: 'set', path: ['workingDirectory'], value: 'C:\\Projects\\existing' },
    { op: 'set', path: ['agentPreset'], value: 'coding' },
    { op: 'set', path: ['provider'], value: 'deepseek' },
    { op: 'set', path: ['model'], value: 'deepseek-chat' },
  ])
  assert.equal(page.writes[0].revision, 3)
})

test('workspace selection, manual directory and native picker share one saved directory', async (t) => {
  const page = await renderConfiguration(t)
  assert.doesNotMatch(page.text(), /已有项目/)
  await page.select('工作区', 'project-a')
  assert.equal(page.input().props.value, 'C:\\Projects\\existing')
  await page.choose()
  const selector = () => page.view.root.findAllByType('select')
    .find((item) => item.props['aria-label'] === '工作区')
  assert.equal(selector().props.value, '__custom__')
  await page.edit('c:/projects/EXISTING/')
  assert.equal(selector().props.value, 'project-a')
  await page.select('工作区', '')
  assert.equal(page.input().props.value, '')
  await page.save()
  assert.deepEqual(page.writes[0].ops, [
    { op: 'set', path: ['workingDirectory'], value: '' },
  ])
})

test('clearing the directory and model restores host defaults through the same saved configuration', async (t) => {
  const page = await renderConfiguration(t, {
    snapshot: {
      value: {
        workingDirectory: 'C:\\Projects\\old',
        provider: 'mimo',
        model: 'mimo-v2.5-pro',
      },
    },
  })
  await page.edit('')
  await page.select('模型', '')
  await page.save()
  assert.deepEqual(page.writes[0].ops, [
    { op: 'set', path: ['workingDirectory'], value: '' },
    { op: 'set', path: ['provider'], value: '' },
    { op: 'set', path: ['model'], value: '' },
  ])
})

test('unavailable catalogs are explained without hiding directory configuration', async (t) => {
  const page = await renderConfiguration(t, { catalogError: true })
  assert.match(page.text(), /无法读取Agent 预设/)
  assert.equal(
    page.view.root
      .findAllByType('select')
      .find((select) => select.props['aria-label'] === 'Agent 预设').props
      .disabled,
    true,
  )
  assert.equal(page.input().props.disabled, false)
})


test('identity edits save bounded fields and connecting is an explicit revisioned request', async (t) => {
  const page = await renderConfiguration(t)
  assert.equal(page.button('连接平台').props.disabled, false)
  await act(async () => {
    page.view.root.findByProps({ 'aria-label': '设备名称' }).props.onChange({ target: { value: 'Office Harness' } })
    page.view.root.findByProps({ 'aria-label': '设备描述' }).props.onChange({ target: { value: 'Local automation' } })
  })
  assert.equal(page.button('连接平台').props.disabled, true)
  await page.save()
  assert.deepEqual(page.writes[0].ops, [
    { op: 'set', path: ['deviceName'], value: 'Office Harness' },
    { op: 'set', path: ['deviceDescription'], value: 'Local automation' },
  ])
  await act(async () => { await page.button('连接平台').props.onClick() })
  assert.equal(page.writes[1].revision, 4)
  assert.deepEqual(page.writes[1].ops[0].path, ['connectionRequest'])
  assert.equal(typeof page.writes[1].ops[0].value, 'string')
  assert.match(page.text(), /已请求连接/)
  assert.doesNotMatch(page.text(), /连接成功/)
})
