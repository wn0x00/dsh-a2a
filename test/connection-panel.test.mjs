import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { createConnectionPanel } from '../client/connection-panel.js'

const Panel = createConnectionPanel(React, (props) => React.createElement('button', props))
const snapshot = { phase: 'authorization_required', notice: 'none', deviceName: 'Fixture', gatewayUrl: 'https://example.test', activeTasks: 0, canConnect: true, canReauthorize: true, canCancelAuthorization: false }
const connection = (status) => ({ status, subscribe: () => () => {}, connect: async () => ({ ok: true, value: snapshot }) })

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('an old polling request cannot reschedule after its connection effect is replaced', async (t) => {
  const pending = deferred()
  const timers = new Map()
  let id = 0
  t.mock.method(globalThis, 'setTimeout', (callback) => { timers.set(++id, callback); return id })
  t.mock.method(globalThis, 'clearTimeout', (value) => { timers.delete(value) })
  const first = connection(() => pending.promise)
  const second = connection(async () => ({ ok: true, value: { ...snapshot, phase: 'connected' } }))
  let view
  await act(async () => { view = create(React.createElement(Panel, { connection: first })) })
  await act(async () => { view.update(React.createElement(Panel, { connection: second })) })
  assert.equal(timers.size, 1)
  await act(async () => { pending.resolve({ ok: true, value: snapshot }) })
  assert.equal(timers.size, 1)
  assert.match(JSON.stringify(view.toJSON()), /已连接/)
  await act(async () => { view.unmount() })
  assert.equal(timers.size, 0)
})

test('a stale authorization action cannot refresh or overwrite a replacement connection', async () => {
  const pending = deferred()
  let oldReads = 0
  const first = { ...connection(async () => { oldReads++; return { ok: true, value: snapshot } }), connect: () => pending.promise }
  const second = connection(async () => ({ ok: true, value: { ...snapshot, phase: 'connected' } }))
  let view, operation
  await act(async () => { view = create(React.createElement(Panel, { connection: first })) })
  await act(async () => { operation = view.root.findAllByType('button').find(button => button.children.join('') === '连接平台').props.onClick() })
  await act(async () => { view.update(React.createElement(Panel, { connection: second })) })
  await act(async () => { pending.resolve({ ok: true, value: { ...snapshot, phase: 'authorizing' } }); await operation })
  assert.equal(oldReads, 1)
  assert.match(JSON.stringify(view.toJSON()), /已连接/)
  assert.doesNotMatch(JSON.stringify(view.toJSON()), /等待浏览器授权/)
  await act(async () => { view.unmount() })
})
