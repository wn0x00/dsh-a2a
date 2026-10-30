import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { createConnectionPanel } from '../client/connection-panel.js'

const Panel = createConnectionPanel(React, (props) =>
  React.createElement('button', props),
)
const snapshot = {
  phase: 'authorization_required',
  notice: 'none',
  deviceName: 'Fixture',
  gatewayUrl: 'https://example.test',
  activeTasks: 0,
  canConnect: true,
  canReauthorize: true,
  canCancelAuthorization: false,
}
const connection = (status) => ({
  status,
  subscribe: () => () => {},
  connect: async () => ({ ok: true, value: snapshot }),
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('an old polling request cannot reschedule after its connection effect is replaced', async (t) => {
  const pending = deferred()
  const timers = new Map()
  let id = 0
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    timers.set(++id, callback)
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (value) => {
    timers.delete(value)
  })
  const first = connection(() => pending.promise)
  const second = connection(async () => ({
    ok: true,
    value: { ...snapshot, phase: 'connected' },
  }))
  let view
  await act(async () => {
    view = create(React.createElement(Panel, { connection: first }))
  })
  await act(async () => {
    view.update(React.createElement(Panel, { connection: second }))
  })
  assert.equal(timers.size, 1)
  await act(async () => {
    pending.resolve({ ok: true, value: snapshot })
  })
  assert.equal(timers.size, 1)
  assert.match(JSON.stringify(view.toJSON()), /重新授权/)
  await act(async () => {
    view.unmount()
  })
  assert.equal(timers.size, 0)
})

test('a stale authorization action cannot refresh or overwrite a replacement connection', async () => {
  const pending = deferred()
  let oldReads = 0
  const first = {
    ...connection(async () => {
      oldReads++
      return { ok: true, value: snapshot }
    }),
    connect: () => pending.promise,
  }
  const second = connection(async () => ({
    ok: true,
    value: { ...snapshot, phase: 'connected' },
  }))
  let view, operation
  await act(async () => {
    view = create(React.createElement(Panel, { connection: first }))
  })
  await act(async () => {
    operation = view.root
      .findAllByType('button')
      .find((button) => button.children.join('') === '申请授权')
      .props.onClick()
  })
  await act(async () => {
    view.update(React.createElement(Panel, { connection: second }))
  })
  await act(async () => {
    pending.resolve({ ok: true, value: { ...snapshot, phase: 'authorizing' } })
    await operation
  })
  assert.equal(oldReads, 1)
  assert.match(JSON.stringify(view.toJSON()), /重新授权/)
  assert.doesNotMatch(JSON.stringify(view.toJSON()), /等待浏览器授权/)
  await act(async () => {
    view.unmount()
  })
})

async function mountPanel(t, source, props = {}) {
  let view
  await act(async () => {
    view = create(React.createElement(Panel, { connection: source, ...props }))
  })
  t.after(async () => {
    await act(async () => {
      view.unmount()
    })
  })
  return {
    view,
    text: () => JSON.stringify(view.toJSON()),
    button: (label) =>
      view.root
        .findAllByType('button')
        .find((button) => (button.props['aria-label'] ?? button.children.join('')) === label),
  }
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
    timers,
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

for (const [code, hint] of [
  ['gateway/service-unavailable', /连接组件尚未就绪/],
  ['gateway/definition-unavailable', /连接组件尚未就绪/],
  ['gateway/result-invalid', /未能正确交换连接信息/],
  ['remote-access/denied', /没有读取此连接状态的权限/],
  ['gateway/internal', /确认 Harness 正在运行/],
]) {
  test(`status failure ${code} provides a safe recovery hint without pretending authorization is missing`, async (t) => {
    const page = await mountPanel(
      t,
      connection(async () => ({
        ok: false,
        error: {
          code,
          message: 'Bearer private-access-token',
          details: { token: 'secret' },
        },
      })),
    )
    assert.match(page.text(), /无法获取本机连接状态/)
    assert.match(page.text(), hint)
    assert.match(page.text(), new RegExp(code))
    assert.doesNotMatch(
      page.text(),
      /private-access-token|Bearer|secret|需要授权/,
    )
    for (const label of ['申请授权', '重新授权', '取消本次授权'])
      assert.equal(page.button(label), undefined)
    assert.equal(page.button('刷新状态').props.disabled, false)
  })
}

test('unrecognized error codes and rejected promises never render arbitrary diagnostics', async (t) => {
  const page = await mountPanel(
    t,
    connection(async () => {
      throw { code: 'Bearer private-token', message: 'secret request' }
    }),
  )
  assert.match(page.text(), /暂时无法确认此设备是否已授权/)
  assert.match(page.text(), /完全退出 DeepSeek Harness/)
  assert.doesNotMatch(
    page.text(),
    /Bearer|private-token|secret request|诊断信息/,
  )
})

test('a previously connected snapshot is explicitly stale after failure and recovers after refresh', async (t) => {
  const clock = fakeTimers(t)
  let broken = false
  const source = connection(async () =>
    broken
      ? { ok: false, error: { code: 'gateway/internal' } }
      : {
          ok: true,
          value: {
            ...snapshot,
            phase: 'connected',
            canConnect: false,
            lastContactAt: 1000,
          },
        },
  )
  const page = await mountPanel(t, source)
  assert.match(page.text(), /重新授权/)
  broken = true
  await clock.fire(2000)
  assert.match(page.text(), /显示的信息可能已过期/)
  assert.doesNotMatch(page.text(), /此设备已授权|最近联络/)
  assert.equal(page.button('重新授权'), undefined)
  broken = false
  await act(async () => {
    await page.button('刷新状态').props.onClick()
  })
  assert.match(page.text(), /重新授权/)
  assert.doesNotMatch(page.text(), /已过期|无法获取本机连接状态/)
  assert.equal(page.button('重新授权').props.disabled, false)
})

test('manual and automatic refresh coalesce; timeout aborts the RPC and late replies cannot overwrite recovery', async (t) => {
  const clock = fakeTimers(t)
  const pending = deferred()
  let calls = 0,
    signal,
    reset
  const source = {
    ...connection(async (options) => {
      calls++
      if (calls === 1) {
        signal = options.signal
        return pending.promise
      }
      return {
        ok: true,
        value: {
          ...snapshot,
          phase: 'connected',
          deviceName: 'Recovered device',
        },
      }
    }),
    subscribe: (listener) => {
      reset = listener
      return () => {}
    },
  }
  const page = await mountPanel(t, source)
  assert.equal(page.button('刷新状态'), undefined)
  let first, second
  await act(async () => {
    first = reset()
    second = reset()
  })
  assert.equal(first, second)
  assert.equal(calls, 1)
  await clock.fire(8000)
  await Promise.all([first, second])
  assert.equal(signal.aborted, true)
  assert.match(page.text(), /未及时响应/)
  assert.equal(page.button('申请授权'), undefined)
  assert.equal(page.button('刷新状态').props.disabled, false)
  await act(async () => {
    await page.button('刷新状态').props.onClick()
  })
  assert.equal(calls, 2)
  await act(async () => {
    pending.resolve({
      ok: true,
      value: { ...snapshot, deviceName: 'Stale device' },
    })
  })
  assert.equal(page.button('重新授权').props.disabled, false)
  assert.doesNotMatch(page.text(), /Stale device|未及时响应/)
  assert.deepEqual(clock.delays(), [2000])
})

test('repeated failures back off and a successful manual refresh restores the ordinary poll interval', async (t) => {
  const clock = fakeTimers(t)
  let broken = true
  const page = await mountPanel(
    t,
    connection(async () =>
      broken
        ? { ok: false, error: { code: 'gateway/internal' } }
        : { ok: true, value: snapshot },
    ),
  )
  assert.deepEqual(clock.delays(), [5000])
  await clock.fire(5000)
  assert.deepEqual(clock.delays(), [10000])
  await clock.fire(10000)
  assert.deepEqual(clock.delays(), [20000])
  await clock.fire(20000)
  assert.deepEqual(clock.delays(), [30000])
  await clock.fire(30000)
  assert.deepEqual(clock.delays(), [30000])
  broken = false
  await act(async () => {
    await page.button('刷新状态').props.onClick()
  })
  assert.deepEqual(clock.delays(), [2000])
  assert.match(page.text(), /申请授权/)
  assert.equal(page.button('申请授权').props.disabled, false)
})

test('unmount cancels an outstanding status read and clears its timeout and poll timer', async (t) => {
  const clock = fakeTimers(t)
  let signal
  const pending = deferred()
  const page = await mountPanel(
    t,
    connection(async (options) => {
      signal = options.signal
      return pending.promise
    }),
  )
  await act(async () => {
    page.view.unmount()
  })
  assert.equal(signal.aborted, true)
  assert.deepEqual(clock.delays(), [])
  await act(async () => {
    pending.resolve({ ok: true, value: snapshot })
  })
  assert.deepEqual(clock.delays(), [])
})

test('updating pauses connection actions while automatic polling continues', async (t) => {
  const page = await mountPanel(
    t,
    connection(async () => ({
      ok: true,
      value: {
        ...snapshot,
        phase: 'updating',
        canConnect: false,
        canReauthorize: false,
        canCancelAuthorization: false,
      },
    })),
  )
  assert.match(page.text(), /正在更新插件/)
  assert.match(page.text(), /已暂停接收新任务/)
  assert.equal(page.button('申请授权'), undefined)
  assert.equal(page.button('重新授权'), undefined)
  assert.equal(page.button('取消本次授权'), undefined)
  assert.equal(page.button('刷新状态'), undefined)
})

for (const [props, message] of [
  [{ disabled: true, readOnly: true }, /当前连接没有操作权限/],
  [
    {
      disabled: true,
      readOnly: true,
      disabledReason: '正在读取插件配置，读取完成后可操作。',
    },
    /正在读取插件配置/,
  ],
  [{ disabled: true, changed: true }, /正在自动保存配置/],
  [
    { disabled: true, disabledReason: '正在保存配置，请等待保存完成。' },
    /正在保存配置/,
  ],
]) {
  test(`a disabled connection action explains ${JSON.stringify(props)}`, async (t) => {
    const page = await mountPanel(
      t,
      connection(async () => ({ ok: true, value: snapshot })),
      props,
    )
    assert.equal(page.button('申请授权').props.disabled, true)
    assert.match(page.text(), message)
    assert.doesNotMatch(page.text(), /重装|重新安装/)
  })
}

test('a host refusal to start authorization is explained without suggesting repeated authorization', async (t) => {
  const page = await mountPanel(
    t,
    connection(async () => ({
      ok: true,
      value: { ...snapshot, canConnect: false },
    })),
  )
  assert.equal(page.button('申请授权').props.disabled, true)
  assert.match(page.text(), /Harness 暂未允许发起连接，请稍后刷新状态/)
})
