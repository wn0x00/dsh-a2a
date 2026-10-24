import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { openAuthorizationUrl } from '../dist/browser.js'

for (const failure of ['error', 'exit']) {
  test(`browser launch ${failure} rejects so replacement authorization can restore the old grant`, async () => {
    await assert.rejects(
      openAuthorizationUrl(
        'https://platform.example/authorize?state=private',
        () => {
          const child = new EventEmitter()
          child.unref = () => undefined
          setImmediate(() =>
            child.emit(
              failure,
              failure === 'exit' ? 1 : new Error('OS failure'),
            ),
          )
          return child
        },
      ),
      /system browser could not be opened/,
    )
  })
}

test('browser launch keeps the URL as one argument and never logs the authorization request', async (t) => {
  const log = t.mock.method(console, 'log')
  const url =
    'https://platform.example/authorize?state=private&code_challenge=private'
  await openAuthorizationUrl(url, (_command, args, options) => {
    assert.equal(args.at(-1), url)
    assert.equal(options.shell, undefined)
    const child = new EventEmitter()
    child.unref = () => undefined
    setImmediate(() => child.emit('exit', 0))
    return child
  })
  assert.equal(log.mock.callCount(), 0)
})
