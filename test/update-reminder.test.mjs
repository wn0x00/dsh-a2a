import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { createUpdateReminder } from '../client/update-reminder.js'

test('global reminders work outside Settings, deduplicate polling, and stop on unload', async t => {
  let refresh, disposed = false
  let value = { automatic: { enabled: true, notice: { id: 'one', kind: 'restart_required', version: '0.2.2' } } }
  const updates = {
    status: async () => ({ ok: true, value }),
    subscribe: listener => { refresh = listener; return () => { disposed = true } },
  }
  const Reminder = createUpdateReminder(React, props => React.createElement('aside', props, props.text))
  let view
  await act(async () => { view = create(React.createElement(Reminder, { updates })) })
  t.after(async () => { await act(async () => view.unmount()) })
  assert.match(JSON.stringify(view.toJSON()), /0.2.2.*请完全退出/)
  await act(async () => view.root.findByType('aside').props.onDone())
  await act(async () => refresh())
  assert.equal(view.toJSON(), null)
  value = { automatic: { enabled: true, notice: { id: 'two', kind: 'updated', version: '0.2.2' } } }
  await act(async () => refresh())
  assert.match(JSON.stringify(view.toJSON()), /已更新到/)
  await act(async () => view.unmount())
  assert.equal(disposed, true)
})

test('disabled automatic updates and failed status reads do not produce a misleading reminder', async t => {
  let refresh, failure = false
  const Reminder = createUpdateReminder(React)
  const updates = {
    status: async () => {
      if (failure) throw new Error('Bearer secret')
      return { ok: true, value: { automatic: { enabled: false,
        notice: { id: 'disabled', kind: 'error', version: null } } } }
    },
    subscribe: listener => { refresh = listener; return () => {} },
  }
  let view
  await act(async () => { view = create(React.createElement(Reminder, { updates })) })
  t.after(async () => { await act(async () => view.unmount()) })
  assert.equal(view.toJSON(), null)
  failure = true
  await act(async () => refresh())
  assert.equal(view.toJSON(), null)
})
