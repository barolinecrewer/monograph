import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  let config = {}
  const listeners = new Set()
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  runInNewContext(source, { MODULES, SHARED: {}, navigator: { platform }, window, document, getConfig: () => config, subscribe, openSurfaces: open => opens.push(open) })
  const dispose = MODULES[0].start()
  const select = surfaceKey => { config = { surfaceKey }; listeners.forEach(listener => listener()) }

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

  return { command, document, dispose, emit, flush, opens, select, listeners }
}

test('changing the chosen modifier or turning it off takes effect without a reload', () => {
  const h = harness()
  for (const [setting, key, flag] of [['option', 'Alt', 'altKey'], ['control', 'Control', 'ctrlKey'], ['command', 'Meta', 'metaKey']]) {
    h.select(setting)
    const before = h.opens.length
    h.emit('keydown', { key, code: `${key}Right`, [flag]: true, timeStamp: 10 })
    h.emit('keyup', { key, code: `${key}Right`, [flag]: false, timeStamp: 100 })
    h.flush()
    assert.equal(h.opens.length, before + 1, setting)
  }
  h.select('off')
  h.command('keydown', 10)
  h.command('keyup', 100)
  h.flush()
  assert.equal(h.opens.length, 3)
})

test('changing the setting cancels a pending tap, even if switched back before release', () => {
  const h = harness()
  h.command('keydown', 10)
  h.select('off')
  h.select('command')
  h.command('keyup', 100)
  h.flush()
  h.command('keydown', 200)
  h.command('keyup', 250)
  h.select('option')
  h.flush()
  assert.deepEqual(h.opens, [])
  h.dispose()
  assert.equal(h.listeners.size, 0)
})

test('the release plugin renders Monograph settings and saves a surface key', t => {
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'monograph-surface-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of ['build.mjs', 'package.json', 'src']) cpSync(join(repo, file), join(dir, file), { recursive: true })
  execFileSync(process.execPath, ['build.mjs', '--release'], { cwd: dir })
  // Replace host imports only. Preserve the build's lexical boundaries.
  const plugin = readFileSync(join(dir, 'dist', 'plugin.js'), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace(/^export default \{/m, 'const pluginExport = {')
  const jsx = (type, props) => ({ type, props })
  const navigator = { platform: 'MacIntel' }
  const stored = []
  const shared = runInNewContext(`${plugin}\nstorage = testStorage; SHARED`, {
    sdk: {}, React: { memo: component => component }, navigator, jsx, jsxs: jsx,
    useSyncExternalStore: (_, read) => read(),
    document: { documentElement: { dataset: {}, style: { setProperty() {} } } },
    testStorage: { set: (_, patch) => stored.push(patch.surfaceKey) }
  })
  const row = () => shared.settingsPage().props.children
    .flatMap(section => [].concat(section?.props.children ?? []))
    .find(node => node?.props.id === 'monograph-surface-key')
  const control = row().props.action.props
  assert.deepEqual(Array.from(control.options, option => option.id), ['command', 'option', 'control', 'off'])
  assert.equal(control.value, 'command')
  control.onChange('off')
  assert.deepEqual(stored, ['off'])
  assert.equal(row().props.action.props.value, 'off')
  navigator.platform = 'Linux x86_64'
  assert.equal(row(), undefined)
})

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
