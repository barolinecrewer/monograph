// The disclosure machine, cell by cell (src/machines/disclosure.js).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { disclosure } from '../src/machines/disclosure.js'

const PRESS = { type: 'press' }
const LIVE = { type: 'read', live: true, rest: null }
const REST = { type: 'read', live: false, rest: 'folded' }
const GONE = { type: 'read', live: false, rest: null }

const at = (phase, chosen = null) => ({ phase, chosen })
const walk = (state, ...events) => events.reduce((current, event) => disclosure.step(current, event, 0), state)

// [from, event, to]; `same` means the very object comes back.
const cells = [
  [at('none'), PRESS, 'same'],
  [at('none'), LIVE, at('live')],
  [at('none'), REST, at('folded')],
  [at('none'), GONE, 'same'],
  [at('live'), PRESS, 'same'],
  [at('live'), LIVE, 'same'],
  [at('live'), REST, at('folded')],
  [at('live'), GONE, at('none')],
  [at('folded'), PRESS, at('open', 'open')],
  [at('folded'), LIVE, at('live')],
  [at('folded'), REST, 'same'],
  [at('folded'), GONE, at('none')],
  [at('folded', 'folded'), PRESS, at('open', 'open')],
  [at('folded', 'folded'), LIVE, 'same'],
  [at('folded', 'folded'), REST, 'same'],
  [at('folded', 'folded'), GONE, 'same'],
  [at('open', 'open'), PRESS, at('folded', 'folded')],
  [at('open', 'open'), LIVE, 'same'],
  [at('open', 'open'), REST, 'same'],
  [at('open', 'open'), GONE, 'same']
]

for (const [from, event, to] of cells) {
  test(`${from.phase}${from.chosen ? ` (chosen ${from.chosen})` : ''} + ${event.type}${event.type === 'read' ? (event.live ? ' live' : ` rest=${event.rest}`) : ''}`, () => {
    const copy = { ...from }
    const next = disclosure.step(from, event, 0)

    assert.deepEqual(from, copy, 'the given state is not written into')

    if (to === 'same') {
      assert.equal(next, from)
    } else {
      assert.deepEqual(next, to)
    }
  })
}

test('starts at none with no choice', () => {
  assert.deepEqual(disclosure.start(), at('none'))
})

test('a read keeps the reader\'s choice as it was', () => {
  assert.deepEqual(disclosure.step(at('live', 'open'), REST, 0), at('open', 'open'))
  assert.deepEqual(disclosure.step(at('none', 'folded'), LIVE, 0), at('folded', 'folded'))
})

test('thinking: live while it streams, folded at the answer, open and folded by press', () => {
  let state = walk(disclosure.start(), LIVE, LIVE)

  assert.equal(state.phase, 'live')
  state = walk(state, REST)
  assert.equal(state.phase, 'folded')
  state = walk(state, PRESS, REST, REST)
  assert.deepEqual(state, at('open', 'open'))
  state = walk(state, PRESS)
  assert.deepEqual(state, at('folded', 'folded'))
})

test('thinking: a block Hermes never previewed stays Hermes\' to draw', () => {
  const state = walk(disclosure.start(), GONE, PRESS, GONE)

  assert.deepEqual(state, at('none'))
})

test('work fold and note: a press opens, a pass leaves it open, a press folds', () => {
  let state = walk(disclosure.start(), REST)

  assert.equal(state.phase, 'folded')
  state = walk(state, PRESS, REST)
  assert.equal(state.phase, 'open')
  state = walk(state, PRESS, REST)
  assert.equal(state.phase, 'folded')
})

// Fix A: a reader's choice wins. A block the reader opened is not drawn
// live again by a pass that sees a shimmer, and does not land on folded
// after it; a block the reader folded stays folded.
test('fix A: an opened thinking block stays open when the shimmer comes back', () => {
  const opened = walk(disclosure.start(), LIVE, REST, PRESS)

  assert.deepEqual(walk(opened, LIVE), at('open', 'open'))
  assert.deepEqual(walk(opened, LIVE, LIVE, REST), at('open', 'open'))
  assert.equal(disclosure.step(opened, LIVE, 0), opened, 'nothing changes, the same object')
})

test('fix A: a folded thinking block stays folded, live or not', () => {
  const shut = walk(disclosure.start(), LIVE, REST, PRESS, PRESS)

  assert.deepEqual(shut, at('folded', 'folded'))
  assert.equal(disclosure.step(shut, LIVE, 0), shut)
  assert.equal(disclosure.step(shut, GONE, 0), shut)
})
