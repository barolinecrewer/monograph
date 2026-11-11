// approvalMode, transition by transition, as the chip behaves today.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { approvalMode } from '../src/machines/approval-mode.js'

const { step } = approvalMode

// Steps a fresh state through events; returns the last state.
const walk = (...events) => events.reduce((state, event) => step(state, event, 0), approvalMode.start())

test('starts unknown, with nothing shown and no request', () => {
  assert.deepEqual(approvalMode.start(), { confirmed: null, mode: null, pending: 0, phase: 'unknown', revision: 0 })
})

test('read: takes the next revision and changes nothing else, in every phase', () => {
  for (const before of [walk(), walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }), walk({ mode: 'off', type: 'write' })]) {
    const after = step(before, { type: 'read' }, 0)

    assert.deepEqual(after, { ...before, revision: before.revision + 1 })
  }
})

test('answer to the newest read: shown, and the answer is both mode and confirmed', () => {
  assert.deepEqual(walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }), {
    confirmed: 'smart',
    mode: 'smart',
    pending: 0,
    phase: 'shown',
    revision: 1
  })
})

test('answer to an older request is dropped: the same state comes back', () => {
  const state = walk({ type: 'read' }, { type: 'read' })

  assert.equal(step(state, { mode: 'off', revision: 1, type: 'answer' }, 0), state)
})

test('answer that changes nothing returns the same state', () => {
  const state = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' })
  const again = step(state, { type: 'read' }, 0)

  assert.equal(step(again, { mode: 'smart', revision: 2, type: 'answer' }, 0), again)
})

test('answer to the newest read moves the shown mode when it differs', () => {
  const state = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { type: 'read' }, { mode: 'off', revision: 2, type: 'answer' })

  assert.deepEqual(state, { confirmed: 'off', mode: 'off', pending: 0, phase: 'shown', revision: 2 })
})

test('write: the pick is shown at once, before any answer, from unknown and from shown', () => {
  assert.deepEqual(walk({ mode: 'off', type: 'write' }), { confirmed: null, mode: 'off', pending: 1, phase: 'writing', revision: 1 })
  assert.deepEqual(walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { mode: 'off', type: 'write' }), {
    confirmed: 'smart',
    mode: 'off',
    pending: 2,
    phase: 'writing',
    revision: 2
  })
})

test('write answered: shown, with what the gateway said (not necessarily the pick)', () => {
  const written = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { mode: 'off', type: 'write' })

  assert.deepEqual(step(written, { mode: 'off', revision: 2, type: 'answer' }, 0), { confirmed: 'off', mode: 'off', pending: 0, phase: 'shown', revision: 2 })
  assert.deepEqual(step(written, { mode: 'manual', revision: 2, type: 'answer' }, 0), {
    confirmed: 'manual',
    mode: 'manual',
    pending: 0,
    phase: 'shown',
    revision: 2
  })
})

test('write failed: back to the last answer, shown', () => {
  const state = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { mode: 'off', type: 'write' }, { revision: 2, type: 'failed' })

  assert.deepEqual(state, { confirmed: 'smart', mode: 'smart', pending: 0, phase: 'shown', revision: 2 })
})

test('write failed with no answer ever: nothing shown again (the chip goes)', () => {
  assert.deepEqual(walk({ mode: 'off', type: 'write' }, { revision: 1, type: 'failed' }), {
    confirmed: null,
    mode: null,
    pending: 0,
    phase: 'unknown',
    revision: 1
  })
})

test('an older write failing is dropped: the same state comes back', () => {
  const state = walk({ mode: 'off', type: 'write' }, { mode: 'smart', type: 'write' })

  assert.equal(step(state, { revision: 1, type: 'failed' }, 0), state)
})

test('failed when already back where it would go returns the same state', () => {
  const state = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' })

  assert.equal(step(state, { revision: 1, type: 'failed' }, 0), state)
})

test('two picks in a row: the second wins, the first answer arriving late is dropped', () => {
  const both = walk({ mode: 'off', type: 'write' }, { mode: 'smart', type: 'write' })

  assert.equal(both.mode, 'smart')
  assert.equal(step(both, { mode: 'off', revision: 1, type: 'answer' }, 0), both)
  assert.deepEqual(step(both, { mode: 'smart', revision: 2, type: 'answer' }, 0), { confirmed: 'smart', mode: 'smart', pending: 0, phase: 'shown', revision: 2 })
})

test('a read after a pick: the pick stays on screen until the read answers, and the write answer is dropped', () => {
  const read = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { mode: 'off', type: 'write' }, { type: 'read' })
  const shown = ({ confirmed, mode, phase }) => ({ confirmed, mode, phase })

  assert.equal(read.phase, 'writing')
  assert.equal(read.mode, 'off')
  assert.deepEqual(shown(step(read, { mode: 'manual', revision: 2, type: 'answer' }, 0)), shown(read))
  assert.deepEqual(shown(step(read, { revision: 2, type: 'failed' }, 0)), shown(read))
  assert.deepEqual(step(read, { mode: 'manual', revision: 3, type: 'answer' }, 0), {
    confirmed: 'manual',
    mode: 'manual',
    pending: 2,
    phase: 'shown',
    revision: 3
  })
})

test('a mode string is taken as given: the adapter normalizes it', () => {
  assert.equal(walk({ type: 'read' }, { mode: 'whatever', revision: 1, type: 'answer' }).mode, 'whatever')
})

test('an unknown event, or none, changes nothing', () => {
  const state = walk({ mode: 'off', type: 'write' })

  assert.equal(step(state, { type: 'focus' }, 0), state)
  assert.equal(step(state, undefined, 0), state)
})

test('step does not write into the state it was given', () => {
  const state = Object.freeze(walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }))

  for (const event of [{ type: 'read' }, { mode: 'off', type: 'write' }, { mode: 'off', revision: 1, type: 'answer' }, { revision: 1, type: 'failed' }]) {
    assert.doesNotThrow(() => step(state, event, 0))
  }
})

test('re-read times: 250 ms after a session.info burst, 600 and 1800 ms after "/approvals"', () => {
  assert.deepEqual(approvalMode.rereadMs, { command: [600, 1800], info: 250 })
})

// Fix C: a write in progress belongs to the profile, so every chip of it
// shows the write and its outcome. `pending` is the revision of the newest
// write not yet settled, 0 when none.
test('fix C: a write is pending on the profile from the press until it settles', () => {
  const written = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { mode: 'off', type: 'write' })

  assert.equal(walk().pending, 0)
  assert.equal(written.pending, 2)
  assert.equal(step(written, { mode: 'off', revision: 2, type: 'answer' }, 0).pending, 0)
  assert.equal(step(written, { revision: 2, type: 'failed' }, 0).pending, 0)
})

test('fix C: a read sets nothing pending, and an answer to it leaves a write pending', () => {
  assert.equal(walk({ type: 'read' }).pending, 0)

  const read = walk({ mode: 'off', type: 'write' }, { type: 'read' }, { mode: 'manual', revision: 2, type: 'answer' })

  assert.equal(read.pending, 1)
  assert.equal(read.mode, 'manual')
})

test('fix C: a write overtaken by a read stops being pending when it settles, its answer dropped', () => {
  const read = walk({ type: 'read' }, { mode: 'smart', revision: 1, type: 'answer' }, { mode: 'off', type: 'write' }, { type: 'read' })
  const settled = step(read, { mode: 'off', revision: 2, type: 'answer' }, 0)

  assert.deepEqual(settled, { ...read, pending: 0 })
  assert.deepEqual(step(read, { revision: 2, type: 'failed' }, 0), { ...read, pending: 0 })
})

test('fix C: two writes: pending until the newer settles; the older settling changes nothing', () => {
  const both = walk({ mode: 'off', type: 'write' }, { mode: 'smart', type: 'write' })

  assert.equal(both.pending, 2)
  assert.equal(step(both, { mode: 'off', revision: 1, type: 'answer' }, 0), both)
  assert.equal(step(both, { revision: 1, type: 'failed' }, 0), both)
  assert.equal(step(both, { mode: 'smart', revision: 2, type: 'answer' }, 0).pending, 0)
})
