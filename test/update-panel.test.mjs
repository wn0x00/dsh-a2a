import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { createUpdatePanel } from '../client/update-panel.js'

const Panel = createUpdatePanel(React, (props) =>
  React.createElement('button', props),
)
const initial = {
  phase: 'idle',
  currentVersion: '0.1.10',
  latestVersion: null,
  checkedAt: null,
  error: null,
  restartReason: null,
  canInstall: false,
  hasCredential: false,
}
const available = {
  ...initial,
  phase: 'available',
  latestVersion: '0.1.11',
  checkedAt: 1000,
  canInstall: true,
}
const completed = {
  ...available,
  phase: 'restart_required',
  canInstall: false,
  restartReason: 'host-module',
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fakeTimers(t) {
  const timers = new Map()
  let id = 0
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    timers.set(++id, { callback, delay })
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (value) => {
    timers.delete(value)
  })
  return {
    async fire(delay) {
      const entry = [...timers].find(([, value]) => value.delay === delay)
      assert.ok(entry, `No ${delay}ms timer`)
      timers.delete(entry[0])
      await act(async () => {
        entry[1].callback()
      })
    },
    delays: () => [...timers.values()].map((timer) => timer.delay),
  }
}
async function fixture(t, options = {}) {
  let snapshot = options.snapshot ?? initial
  let listener, view
  const calls = {
    status: [],
    check: [],
    install: [],
    saveCredential: [],
    clearCredential: [],
  }
  const updates = {
    status: async (request) => {
      calls.status.push(request)
      return options.status
        ? options.status(request)
        : { ok: true, value: snapshot }
    },
    check: async () => {
      calls.check.push(true)
      if (options.check) return options.check()
      snapshot = available
      return { ok: true, value: snapshot }
    },
    install: async (version) => {
      calls.install.push(version)
      if (options.install) return options.install(version)
      snapshot = completed
      return { ok: true, value: snapshot }
    },
    saveCredential: async (token) => {
      calls.saveCredential.push(token)
      if (options.saveCredential) return options.saveCredential(token)
      snapshot = { ...snapshot, hasCredential: true }
      return { ok: true, value: snapshot }
    },
    clearCredential: async () => {
      calls.clearCredential.push(true)
      if (options.clearCredential) return options.clearCredential()
      snapshot = { ...initial, error: 'credential_required' }
      return { ok: true, value: snapshot }
    },
    subscribe: (refresh) => {
      listener = refresh
      return () => {
        listener = null
      }
    },
  }
  await act(async () => {
    view = create(React.createElement(Panel, { updates, ...options.props }))
  })
  t.after(async () => {
    await act(async () => {
      view.unmount()
    })
  })
  return {
    view,
    calls,
    updates,
    text: () => JSON.stringify(view.toJSON()),
    button: (label) =>
      view.root
        .findAllByType('button')
        .find((button) => button.children.join('') === label),
    input: () => view.root.findByType('input'),
    typeCredential: async (value) => {
      await act(async () => {
        view.root.findByType('input').props.onChange({ target: { value } })
      })
    },
    publish: async (next) => {
      snapshot = next
      await act(async () => {
        await listener?.()
      })
    },
    click: async (label) => {
      await act(async () => {
        await view.root
          .findAllByType('button')
          .find((button) => button.children.join('') === label)
          .props.onClick()
      })
    },
  }
}

test('mounting, status polling and refreshing never check for or install updates automatically', async (t) => {
  const clock = fakeTimers(t)
  const page = await fixture(t)
  assert.match(page.text(), /尚未检查更新/)
  assert.equal(page.calls.status.length, 1)
  await clock.fire(3000)
  await page.click('刷新更新状态')
  assert.equal(page.calls.status.length, 3)
  assert.deepEqual(page.calls.check, [])
  assert.deepEqual(page.calls.install, [])
  assert.ok(
    page.calls.status.every(({ signal }) => signal instanceof AbortSignal),
  )
})

test('manual checking and explicit version confirmation precede one exact-version installation', async (t) => {
  const page = await fixture(t)
  await page.click('检查更新')
  assert.equal(page.calls.check.length, 1)
  assert.deepEqual(page.calls.install, [])
  await page.click('更新到 0.1.11')
  assert.match(page.text(), /确认更新到 0.1.11/)
  await page.click('取消')
  assert.deepEqual(page.calls.install, [])
  await page.click('更新到 0.1.11')
  const confirm = page.button('确认安装 0.1.11').props.onClick
  await act(async () => {
    await Promise.all([confirm(), confirm()])
  })
  assert.deepEqual(page.calls.install, ['0.1.11'])
  assert.match(page.text(), /更新已安装，等待重启/)
  assert.match(page.text(), /完全退出 DeepSeek Harness/)
  assert.match(page.text(), /更新包含宿主模块/)
  assert.equal(page.button('更新到 0.1.11'), undefined)
})

for (const props of [
  { readOnly: true },
  { changed: true },
  { activeTasks: 1 },
  { disabled: true },
]) {
  test(`installation is blocked by ${JSON.stringify(props)}`, async (t) => {
    const page = await fixture(t, { snapshot: available, props })
    assert.equal(page.button('更新到 0.1.11').props.disabled, true)
    await page.click('更新到 0.1.11')
    assert.equal(page.button('确认安装 0.1.11').props.disabled, true)
    await page.click('确认安装 0.1.11')
    assert.deepEqual(page.calls.install, [])
  })
}

test('host task and authorization checks prevent installation even without a local task count', async (t) => {
  const page = await fixture(t, {
    snapshot: { ...available, canInstall: false },
  })
  assert.equal(page.button('更新到 0.1.11').props.disabled, true)
  assert.match(page.text(), /等待任务或授权结束/)
  assert.deepEqual(page.calls.install, [])
})

test('a version change closes confirmation and a stale click cannot install another target', async (t) => {
  const page = await fixture(t, { snapshot: available })
  await page.click('更新到 0.1.11')
  const stale = page.button('确认安装 0.1.11').props.onClick
  await page.publish({ ...available, latestVersion: '0.1.12' })
  assert.equal(page.button('确认安装 0.1.11'), undefined)
  await act(async () => {
    await stale()
  })
  assert.deepEqual(page.calls.install, [])
  assert.equal(page.button('更新到 0.1.12').props.disabled, false)
})

test('download and installation progress are read from the host while the accepted request remains pending', async (t) => {
  const pending = deferred()
  const page = await fixture(t, {
    snapshot: available,
    install: () => pending.promise,
  })
  await page.click('更新到 0.1.11')
  let installation
  await act(async () => {
    installation = page.button('确认安装 0.1.11').props.onClick()
  })
  assert.match(page.text(), /正在提交更新请求/)
  await page.publish({ ...available, phase: 'downloading', canInstall: false })
  assert.match(page.text(), /正在下载更新/)
  await page.publish({ ...available, phase: 'installing', canInstall: false })
  assert.match(page.text(), /正在安装更新/)
  assert.equal(page.button('更新到 0.1.11'), undefined)
  await page.publish(completed)
  await act(async () => {
    pending.resolve({ ok: true, value: completed })
    await installation
  })
  assert.match(page.text(), /更新已安装，等待重启/)
  assert.deepEqual(page.calls.install, ['0.1.11'])
})

test('lost installation replies remain unknown until a receipt is confirmed, never automatically reinstalling', async (t) => {
  let receipt = available
  const page = await fixture(t, {
    snapshot: available,
    status: async () => ({ ok: true, value: receipt }),
    install: async () => {
      throw new Error('Bearer private-install-secret')
    },
    check: async () => {
      receipt = completed
      return { ok: true, value: receipt }
    },
  })
  await page.click('更新到 0.1.11')
  await page.click('确认安装 0.1.11')
  assert.match(page.text(), /更新结果待核对/)
  assert.doesNotMatch(page.text(), /更新未完成|private-install-secret|Bearer/)
  assert.equal(page.button('更新到 0.1.11'), undefined)
  await page.click('刷新更新状态')
  assert.match(page.text(), /更新结果待核对/)
  assert.equal(page.calls.check.length, 0)
  assert.deepEqual(page.calls.install, ['0.1.11'])
  await page.click('核对更新结果')
  assert.equal(page.calls.check.length, 1)
  assert.match(page.text(), /更新已安装，等待重启/)
  assert.deepEqual(page.calls.install, ['0.1.11'])
})

test('an unavailable namespace during installation is unknown and recovers through status alone', async (t) => {
  let offline = false
  const page = await fixture(t, {
    snapshot: available,
    status: async () =>
      offline
        ? {
            ok: false,
            error: { code: 'gateway/service-unavailable', message: 'private' },
          }
        : { ok: true, value: available },
    install: async () => {
      offline = true
      return { ok: false, error: { message: 'Bearer private' } }
    },
  })
  await page.click('更新到 0.1.11')
  await page.click('确认安装 0.1.11')
  assert.match(page.text(), /更新结果待核对/)
  assert.doesNotMatch(page.text(), /Bearer|private|更新未完成/)
  page.updates.status = async () => ({
    ok: true,
    value: { ...completed, phase: 'updated' },
  })
  await page.click('刷新更新状态')
  assert.match(page.text(), /插件已更新/)
  assert.doesNotMatch(page.text(), /更新结果待核对/)
  assert.deepEqual(page.calls.install, ['0.1.11'])
})

test('only approved error and restart reason codes are displayed', async (t) => {
  const page = await fixture(t, {
    snapshot: {
      ...available,
      phase: 'error',
      error: 'integrity',
      canInstall: false,
    },
  })
  assert.match(page.text(), /安装包校验未通过/)
  await page.publish({ ...completed, restartReason: 'Bearer secret token' })
  assert.match(page.text(), /完全退出 DeepSeek Harness/)
  assert.doesNotMatch(page.text(), /Bearer|secret token/)
  await page.publish({
    ...available,
    phase: 'error',
    error: 'Bearer error secret',
    canInstall: false,
  })
  assert.doesNotMatch(page.text(), /Bearer|error secret/)
  await page.publish({
    ...available,
    phase: 'error',
    error: 'update_changed',
    canInstall: false,
  })
  assert.match(page.text(), /可用版本已变化/)
})

test('an unreadable update status hides installation and a timed-out read can be safely refreshed', async (t) => {
  const clock = fakeTimers(t)
  const pending = deferred()
  let first = true,
    signal
  const page = await fixture(t, {
    status: async (request) => {
      signal = request.signal
      if (first) {
        first = false
        return pending.promise
      }
      return { ok: true, value: available }
    },
  })
  await clock.fire(8000)
  assert.equal(signal.aborted, true)
  assert.match(page.text(), /无法读取更新状态/)
  assert.equal(page.button('更新到 0.1.11'), undefined)
  await page.click('刷新更新状态')
  await act(async () => {
    pending.resolve({
      ok: true,
      value: { ...initial, currentVersion: '0.0.1' },
    })
  })
  assert.match(page.text(), /本次运行版本 0.1.10/)
  assert.equal(page.button('更新到 0.1.11').props.disabled, false)
  assert.deepEqual(page.calls.install, [])
  assert.deepEqual(page.calls.check, [])
})

test('unmount does not cancel an accepted installation or apply its late result to a new panel', async (t) => {
  const pending = deferred()
  const page = await fixture(t, {
    snapshot: available,
    install: () => pending.promise,
  })
  await page.click('更新到 0.1.11')
  let installation
  await act(async () => {
    installation = page.button('确认安装 0.1.11').props.onClick()
  })
  await act(async () => {
    page.view.unmount()
  })
  await act(async () => {
    pending.resolve({ ok: true, value: completed })
    await installation
  })
  assert.deepEqual(page.calls.install, ['0.1.11'])
})

test('Gitea credentials are write-only, cleared when submitted, and never checked or installed implicitly', async (t) => {
  const pending = deferred()
  let latest = initial
  const page = await fixture(t, {
    status: async () => ({ ok: true, value: latest }),
    saveCredential: () => pending.promise,
  })
  assert.equal(page.input().props.type, 'password')
  assert.equal(page.input().props.value, '')
  assert.match(page.text(), /read:package/)
  assert.match(page.text(), /xbot 组织成员/)
  assert.match(page.text(), /user\/settings\/applications/)
  assert.match(page.text(), /xbot\/-\/packages\?q=deepseek-harness-a2a/)
  await page.typeCredential('fixture-read-only-token')
  let save
  await act(async () => {
    save = page.button('保存凭据').props.onClick()
  })
  assert.deepEqual(page.calls.saveCredential, ['fixture-read-only-token'])
  assert.equal(page.input().props.value, '')
  assert.equal(page.input().props.disabled, true)
  assert.doesNotMatch(page.text(), /fixture-read-only-token/)
  latest = { ...initial, hasCredential: true }
  await act(async () => {
    pending.resolve({ ok: true, value: latest })
    await save
  })
  assert.match(page.text(), /已配置凭据/)
  assert.equal(page.input().props.value, '')
  assert.deepEqual(page.calls.check, [])
  assert.deepEqual(page.calls.install, [])
  assert.equal(page.button('移除凭据').props.disabled, false)
})

test('failed credential requests clear the input without exposing errors or replacing an existing credential', async (t) => {
  const page = await fixture(t, {
    snapshot: { ...initial, hasCredential: true },
    saveCredential: async () => {
      throw new Error('Bearer fixture-read-only-token from server')
    },
  })
  await page.typeCredential('fixture-read-only-token')
  await page.click('保存凭据')
  assert.equal(page.input().props.value, '')
  assert.match(page.text(), /未能确认凭据变更/)
  assert.match(page.text(), /已配置凭据/)
  assert.doesNotMatch(page.text(), /Bearer|fixture-read-only-token|from server/)
  assert.equal(page.calls.saveCredential.length, 1)
})

test('credential removal is explicit and the UI only receives whether a credential remains', async (t) => {
  const page = await fixture(t, {
    snapshot: { ...initial, hasCredential: true },
  })
  assert.deepEqual(page.calls.clearCredential, [])
  await page.click('移除凭据')
  assert.deepEqual(page.calls.clearCredential, [true])
  assert.match(page.text(), /未配置凭据/)
  assert.match(page.text(), /请先配置 Gitea 只读凭据/)
  assert.equal(page.button('移除凭据'), undefined)
  assert.equal(page.input().props.value, '')
  assert.deepEqual(page.calls.install, [])
})

for (const options of [
  { props: { readOnly: true } },
  { props: { disabled: true } },
  { phase: 'checking' },
  { phase: 'downloading' },
  { phase: 'installing' },
]) {
  test(`credential changes are blocked during ${JSON.stringify(options)}`, async (t) => {
    const page = await fixture(t, {
      snapshot: {
        ...initial,
        hasCredential: true,
        ...(options.phase ? { phase: options.phase } : {}),
      },
      props: options.props,
    })
    await page.typeCredential('fixture-read-only-token')
    assert.equal(page.input().props.disabled, true)
    assert.equal(page.button('保存凭据').props.disabled, true)
    assert.equal(page.button('移除凭据').props.disabled, true)
    await page.click('保存凭据')
    await page.click('移除凭据')
    assert.deepEqual(page.calls.saveCredential, [])
    assert.deepEqual(page.calls.clearCredential, [])
  })
}

test('credential validation errors use safe instructions and retain existing authorization', async (t) => {
  const page = await fixture(t, {
    snapshot: {
      ...initial,
      phase: 'error',
      error: 'credential_invalid',
      hasCredential: true,
    },
  })
  assert.match(page.text(), /Gitea 未接受此凭据/)
  assert.match(page.text(), /read:package/)
  assert.match(page.text(), /已配置凭据/)
  assert.equal(page.input().props.value, '')
})
