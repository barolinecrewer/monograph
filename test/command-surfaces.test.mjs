import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

function harness(platform = 'MacIntel') {
  const source = readFileSync(new URL('../src/modules/45-command-surfaces.js', import.meta.url), 'utf8')
  const MODULES = []
  const timers = new Map()
  const opens = []
  const window = new EventTarget()
  const document = new EventTarget()
  let sequence = 0
  window.setTimeout = callback => { timers.set(++sequence, callback); return sequence }
  window.clearTimeout = id => timers.delete(id)
  runInNewContext(source, { MODULES, navigator: { platform }, window, document, openSurfaces: open => opens.push(open) })
  const dispose = MODULES[0].start()

  function emit(type, fields = {}, target = window) {
    const event = new Event(type, { cancelable: true })
    for (const [key, value] of Object.entries({ isTrusted: true, ...fields })) {
      Object.defineProperty(event, key, { value })
    }
    target.dispatchEvent(event)
    assert.equal(event.defaultPrevented, false, 'native shortcuts and clicks keep their defaults')
  }

  function command(type, timeStamp, fields = {}) {
    emit(type, { key: 'Meta', code: 'MetaLeft', metaKey: type === 'keydown', timeStamp, ...fields })
  }

  function flush() {
    for (const [id, callback] of timers) {
      timers.delete(id)
      callback()
    }
  }

  return { command, document, dispose, emit, flush, opens }
}

test('a solo press of either Mac Command key opens the same picker on release', () => {
  const h = harness()
  for (const code of ['MetaLeft', 'MetaRight']) {
    const before = h.opens.length
    h.command('keydown', 10, { code })
    h.flush()
    assert.equal(h.opens.length, before)
    h.command('keyup', 100, { code })
    h.flush()
    assert.equal(h.opens.length, before + 1)
  }
  assert.deepEqual(h.opens, [true, true])
})

test('Command chords, drags and focus changes do not open the picker', () => {
  const cancelCases = [
    h => h.emit('keydown', { key: 'k', code: 'KeyK', metaKey: true }),
    h => h.emit('keydown', { key: 'Shift', code: 'ShiftLeft', metaKey: true }),
    h => h.command('keydown', 20, { code: 'MetaRight' }),
    h => h.emit('keyup', { key: 'w', code: 'KeyW', metaKey: true }),
    h => h.emit('pointerdown'),
    h => h.emit('wheel'),
    h => h.emit('blur'),
    h => h.emit('visibilitychange', {}, h.document)
  ]
  for (const cancel of cancelCases) {
    const h = harness()
    h.command('keydown', 10)
    cancel(h)
    h.command('keyup', 100)
    h.flush()
    assert.deepEqual(h.opens, [])
  }
})

test('a late chord keyup cancels the pending open if the OS handled the chord keydown', () => {
  const h = harness()
  h.command('keydown', 10)
  h.command('keyup', 100)
  h.emit('keyup', { key: 'w', code: 'KeyW' })
  h.flush()
  assert.deepEqual(h.opens, [])
})

test('clipboard, navigation and focus signals cancel taps when the native app consumed a shortcut keydown', () => {
  for (const signal of ['copy', 'cut', 'paste', 'hashchange', 'focusin', 'resize']) {
    const h = harness()
    h.command('keydown', 10)
    h.command('keyup', 100)
    h.emit(signal)
    h.flush()
    assert.deepEqual(h.opens, [], `${signal} should cancel the opener`)
  }
})

test('long holds, extra modifiers, synthetic events and non-Mac Meta are ignored', () => {
  const h = harness()
  h.command('keydown', 10)
  h.command('keyup', 1500)
  h.command('keydown', 2000, { ctrlKey: true })
  h.command('keyup', 2050)
  h.command('keydown', 3000, { isTrusted: false })
  h.command('keyup', 3050)
  h.flush()
  assert.deepEqual(h.opens, [])

  const linux = harness('Linux x86_64')
  linux.command('keydown', 10)
  linux.command('keyup', 100)
  linux.flush()
  assert.deepEqual(linux.opens, [])
})

test('unloading removes the gesture and cancels an open already queued', () => {
  const h = harness()
  h.command('keydown', 10)
  h.command('keyup', 100)
  h.dispose()
  h.flush()
  h.command('keydown', 200)
  h.command('keyup', 250)
  h.flush()
  assert.deepEqual(h.opens, [])
})
