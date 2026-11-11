// The scroll machine (src/machines/scroll.js), transition by transition, as
// keepBottom() in src/plugin.js decided it before the machine existed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scroll } from '../src/machines/scroll.js'

const step = (state, event, now = 1000) => scroll.step(state, event, now)
const at = (phase, fields = {}) => ({ ...scroll.start(), phase, ...fields })
const layout = (top, gap, held = false) => ({ type: 'layout', top, gap, held })

test('starts unknown, pinned not known, nothing pending', () => {
  const state = scroll.start()

  assert.equal(state.phase, 'unknown')
  assert.equal(scroll.pinnedOf(state), null)
  assert.equal(scroll.pinned(state, 0), null)
  assert.equal(state.gap, Infinity)
  assert.ok(Number.isNaN(state.ownTop))
  assert.equal(state.wakeAt, 0)
})

test('the constants: a line is picked 120 ms after a scroll, put back no sooner than 200 ms', () => {
  assert.equal(scroll.PICK_MS, 120)
  assert.equal(scroll.REST_MS, 200)
})

test('pinned per phase', () => {
  const want = { unknown: null, held: null, pinned: true, free: false, reading: false, quiet: false, anchored: false }

  for (const phase of scroll.states) {
    assert.equal(scroll.pinnedOf(at(phase)), want[phase], phase)
  }
})

test('the reader: null while quiet, else pinned', () => {
  assert.equal(scroll.pinned(at('quiet', { quietUntil: 1900 }), 1899), null)
  assert.equal(scroll.pinned(at('quiet', { quietUntil: 1900 }), 1900), false)
  assert.equal(scroll.pinned(at('anchored', { quietUntil: 1900, anchorUntil: 1900 }), 1000), null)
  assert.equal(scroll.pinned(at('pinned'), 1000), true)
  assert.equal(scroll.pinned(at('free'), 1000), false)
  assert.equal(scroll.pinned(at('held'), 1000), null)
})

// ── layout, unknown and held ──

test('layout, unknown: at the bottom within 2 px → pinned, scrolled to the bottom only past 1 px', () => {
  const start = scroll.start()

  assert.deepEqual([step(start, layout(0, 2)).phase, step(start, layout(0, 2)).toBottom], ['pinned', true])
  assert.deepEqual([step(start, layout(0, 1)).phase, step(start, layout(0, 1)).toBottom], ['pinned', false])
  assert.equal(step(start, layout(0, 2.5)).phase, 'free')
  assert.equal(step(start, layout(0, 2.5)).toBottom, false)
})

test('layout, unknown: the last look at the bottom pins it even when this one is not', () => {
  const next = step(at('unknown', { gap: 2 }), layout(0, 400))

  assert.equal(next.phase, 'pinned')
  assert.equal(next.toBottom, true)
})

test('layout, held by Hermes: held, whatever the phase but quiet', () => {
  for (const phase of ['unknown', 'pinned', 'free', 'reading']) {
    const next = step(at(phase), layout(0, 0, true))

    assert.equal(next.phase, 'held', phase)
    assert.equal(scroll.pinnedOf(next), null)
    assert.equal(next.toBottom, false)
  }
})

test('layout, held then let go: decided as unknown', () => {
  assert.equal(step(at('held', { gap: 600 }), layout(0, 0)).phase, 'pinned')
  assert.equal(step(at('held', { gap: 600 }), layout(0, 600)).phase, 'free')
})

// ── layout, pinned ──

test('layout, pinned: any gap from 0.5 px is scrolled away', () => {
  assert.equal(step(at('pinned', { top: 100 }), layout(100, 0.5)).toBottom, true)
  assert.equal(step(at('pinned', { top: 100 }), layout(100, 0.4)).toBottom, false)
  assert.equal(step(at('pinned', { top: 100 }), layout(100, 300)).phase, 'pinned')
})

test('layout, pinned: moved up more than 2 px with a gap over 2 px → free', () => {
  const next = step(at('pinned', { top: 500 }), layout(497, 3))

  assert.equal(next.phase, 'free')
  assert.equal(next.toBottom, false)
  // 2 px up, or a gap of 2: still pinned, and scrolled down.
  assert.equal(step(at('pinned', { top: 500 }), layout(498, 3)).phase, 'pinned')
  assert.equal(step(at('pinned', { top: 500 }), layout(497, 2)).phase, 'pinned')
})

test('layout, pinned: while a shrink of ours runs, moving up does not let go', () => {
  const shrinking = step(at('pinned', { top: 500 }), { type: 'shrink', ms: 900 }, 1000)

  assert.equal(shrinking.shrinkUntil, 1900)
  assert.equal(step(shrinking, layout(100, 400), 1899).phase, 'pinned')
  assert.equal(step(shrinking, layout(100, 400), 1899).toBottom, true)
  assert.equal(step(shrinking, layout(100, 400), 1900).phase, 'free')
})

test('shrink keeps the later end', () => {
  const long = step(scroll.start(), { type: 'shrink', ms: 900 }, 1000)

  assert.equal(step(long, { type: 'shrink', ms: 100 }, 1100).shrinkUntil, 1900)
  assert.equal(step(long, { type: 'shrink', ms: 900 }, 1100).shrinkUntil, 2000)
  assert.equal(step(long, { type: 'shrink', ms: 100 }, 1100), long)
})

// ── layout, free and reading ──

test('layout, free or reading: back within 2 px of the bottom → pinned, no scroll', () => {
  for (const phase of ['free', 'reading']) {
    const next = step(at(phase, { reading: phase === 'reading' }), layout(0, 2))

    assert.equal(next.phase, 'pinned', phase)
    assert.equal(next.toBottom, false)
  }

  assert.equal(step(at('free'), layout(0, 2.5)).phase, 'free')
})

test('layout, quiet: stays quiet and never asks for the bottom, held or not', () => {
  const quiet = at('quiet', { quietUntil: 1900 })

  assert.equal(step(quiet, layout(0, 0), 1899).phase, 'quiet')
  assert.equal(step(quiet, layout(0, 0, true), 1899).phase, 'quiet')
  assert.equal(step(quiet, layout(0, 0), 1899).toBottom, false)
  // At its end the rest of the rules apply.
  assert.equal(step(quiet, layout(0, 0), 1900).phase, 'pinned')
})

test('layout clears an earlier toBottom', () => {
  const asked = step(at('pinned'), layout(0, 40))

  assert.equal(asked.toBottom, true)
  assert.equal(step(asked, layout(0, 0)).toBottom, false)
})

test('at: records top and gap, nothing else', () => {
  const next = step(at('pinned', { toBottom: true }), { type: 'at', top: 120, gap: 0 })

  assert.equal(next.phase, 'pinned')
  assert.equal(next.top, 120)
  assert.equal(next.gap, 0)
  assert.equal(next.toBottom, true)
})

// ── input ──

test('input: any phase lets go of the bottom', () => {
  for (const phase of ['unknown', 'held', 'pinned', 'free']) {
    assert.equal(step(at(phase), { type: 'input', trusted: true }).phase, 'free', phase)
  }

  assert.equal(step(at('reading', { reading: true }), { type: 'input', trusted: true }).phase, 'reading')
})

test('input: the reader ends an anchor, our own wheel does not', () => {
  const anchored = step(at('pinned'), { type: 'anchor', ms: 900 }, 1000)

  assert.equal(step(anchored, { type: 'input', trusted: false }, 1100).phase, 'anchored')

  const reader = step(anchored, { type: 'input', trusted: true }, 1100)

  assert.equal(reader.phase, 'quiet')
  assert.equal(reader.anchorUntil, 0)
  assert.equal(reader.quietUntil, 1900)
})

// ── anchor, quiet, time ──

test('anchor: anchored and quiet for ms, pinned false', () => {
  const next = step(at('pinned'), { type: 'anchor', ms: 900 }, 1000)

  assert.equal(next.phase, 'anchored')
  assert.equal(next.anchorUntil, 1900)
  assert.equal(next.quietUntil, 1900)
  assert.equal(scroll.pinnedOf(next), false)
})

test('time: an anchor holds through anchorUntil and ends after it', () => {
  const anchored = step(at('pinned'), { type: 'anchor', ms: 900 }, 1000)

  assert.equal(step(anchored, { type: 'time' }, 1900), anchored)

  const after = step(anchored, { type: 'time' }, 1900.5)

  assert.equal(after.phase, 'free')
  assert.equal(after.anchorUntil, 0)
})

test('time: an anchor whose node left the page ends, quiet stays', () => {
  const anchored = step(at('pinned'), { type: 'anchor', ms: 900 }, 1000)
  const lost = step(anchored, { type: 'time', lost: true }, 1100)

  assert.equal(lost.phase, 'quiet')
  assert.equal(lost.quietUntil, 1900)
})

test('time: quiet ends at quietUntil, to reading when a line was picked', () => {
  const quiet = step(at('reading', { reading: true }), { type: 'quiet', ms: 900 }, 1000)

  assert.equal(quiet.phase, 'quiet')
  assert.equal(step(quiet, { type: 'time' }, 1899), quiet)
  assert.equal(step(quiet, { type: 'time' }, 1900).phase, 'reading')
  assert.equal(step(step(at('pinned'), { type: 'quiet', ms: 900 }, 1000), { type: 'time' }, 1900).phase, 'free')
})

test('quiet while anchored stays anchored', () => {
  const anchored = step(at('free'), { type: 'anchor', ms: 900 }, 1000)

  assert.equal(step(anchored, { type: 'quiet', ms: 100 }, 1000).phase, 'anchored')
})

test('time with nothing pending changes nothing', () => {
  for (const phase of ['unknown', 'held', 'pinned', 'free']) {
    const state = at(phase)

    assert.equal(step(state, { type: 'time' }), state, phase)
  }
})

// ── our own scrolls and the reader's ──

test('restored and putBack: ownTop; putBack also moves the last top', () => {
  const restored = step(at('free', { top: 10 }), { type: 'restored', top: 300 })

  assert.equal(restored.ownTop, 300)
  assert.equal(restored.top, 10)

  const back = step(at('reading', { reading: true, top: 10 }), { type: 'putBack', top: 280 })

  assert.equal(back.ownTop, 280)
  assert.equal(back.top, 280)
  assert.equal(back.phase, 'reading')
})

test('scroll within 1 px of our own put-back: ours, the same object', () => {
  const state = at('reading', { reading: true, ownTop: 300 })

  assert.equal(step(state, { type: 'scroll', top: 300.9 }), state)
  assert.notEqual(step(state, { type: 'scroll', top: 301 }), state)
})

test("scroll, the reader's: drops the line read, wakes in 120 ms unless pinned", () => {
  const next = step(at('reading', { reading: true, ownTop: 300 }), { type: 'scroll', top: 500 }, 1000)

  assert.equal(next.phase, 'free')
  assert.equal(next.reading, false)
  assert.ok(Number.isNaN(next.ownTop))
  assert.equal(next.scrolledAt, 1000)
  assert.equal(next.wakeAt, 1120)

  const pinned = step(at('pinned', { wakeAt: 900 }), { type: 'scroll', top: 500 }, 1000)

  assert.equal(pinned.phase, 'pinned')
  assert.equal(pinned.wakeAt, 0)
})

test('scroll while unknown or held wakes too (pinned is not true)', () => {
  assert.equal(step(at('unknown'), { type: 'scroll', top: 5 }, 1000).wakeAt, 1120)
  assert.equal(step(at('held'), { type: 'scroll', top: 5 }, 1000).wakeAt, 1120)
})

test('seen: within 2 px of the bottom → pinned; else the numbers only', () => {
  for (const phase of ['unknown', 'held', 'free']) {
    assert.equal(step(at(phase), { type: 'seen', top: 900, gap: 2 }).phase, 'pinned', phase)
  }

  const away = step(at('free'), { type: 'seen', top: 400, gap: 300 })

  assert.equal(away.phase, 'free')
  assert.equal(away.top, 400)
  assert.equal(away.gap, 300)
})

test('seen is ignored while pinned, quiet or anchored', () => {
  const pinned = at('pinned')
  const quiet = at('quiet', { quietUntil: 1900 })

  assert.equal(step(pinned, { type: 'seen', top: 0, gap: 500 }), pinned)
  assert.equal(step(quiet, { type: 'seen', top: 0, gap: 0 }, 1899), quiet)
  assert.equal(scroll.looks(pinned, 1000), false)
  assert.equal(scroll.looks(quiet, 1899), false)
  assert.equal(scroll.looks(quiet, 1900), true)
  assert.equal(scroll.looks(at('unknown'), 0), true)
})

// ── the line read ──

test('wake clears wakeAt; picked sets reading only while pinned is false', () => {
  assert.equal(step(at('free', { wakeAt: 1120 }), { type: 'wake' }, 1120).wakeAt, 0)

  const picked = step(at('free'), { type: 'picked', found: true })

  assert.equal(picked.phase, 'reading')
  assert.equal(step(at('free'), { type: 'picked', found: false }).phase, 'free')
  assert.equal(step(at('pinned'), { type: 'picked', found: true }).reading, false)
  assert.equal(step(at('unknown'), { type: 'picked', found: true }).reading, false)
  assert.equal(scroll.picks(at('free')), true)
  assert.equal(scroll.picks(at('quiet')), true)
  assert.equal(scroll.picks(at('pinned')), false)
  assert.equal(scroll.picks(at('held')), false)
})

test('a line picked while quiet waits for the quiet to end', () => {
  const quiet = step(at('free'), { type: 'quiet', ms: 900 }, 1000)
  const picked = step(quiet, { type: 'picked', found: true }, 1200)

  assert.equal(picked.phase, 'quiet')
  assert.equal(picked.reading, true)
})

test('putsBack: reading, not quiet, 200 ms after the last scroll', () => {
  const reading = at('reading', { reading: true, scrolledAt: 1000 })

  assert.equal(scroll.putsBack(reading, 1199), false)
  assert.equal(scroll.putsBack(reading, 1200), true)
  assert.equal(scroll.putsBack({ ...reading, phase: 'quiet', quietUntil: 1500 }, 1400), false)
  assert.equal(scroll.putsBack({ ...reading, phase: 'quiet', quietUntil: 1500 }, 1500), true)
  // A line picked earlier is kept while pinned and is not put back then.
  assert.equal(scroll.putsBack({ ...reading, phase: 'pinned' }, 2000), false)
  assert.equal(scroll.putsBack(at('free', { scrolledAt: 1000 }), 2000), false)
})

test('a line picked before the bottom was reached is used again once free', () => {
  // As before: only a scroll of the reader's drops it.
  const pinned = step(at('reading', { reading: true }), layout(0, 0))

  assert.equal(pinned.phase, 'pinned')
  assert.equal(pinned.reading, true)
  assert.equal(step(pinned, { type: 'input', trusted: true }).phase, 'reading')
})

// ── the contract, for this machine ──

test('step does not write into the state it is given, and allocates only on change', () => {
  const state = at('pinned', { top: 100, gap: 0 })
  const copy = { ...state }

  step(state, layout(100, 40))
  step(state, { type: 'scroll', top: 0 })
  step(state, { type: 'anchor', ms: 900 })
  assert.deepEqual(state, copy)
  assert.equal(step(state, layout(100, 0)), state)
  assert.equal(step(state, { type: 'at', top: 100, gap: 0 }), state)
})

test('a streamed reply at the bottom: one scroll per frame, pinned throughout', () => {
  let state = step(scroll.start(), layout(0, 0), 0)

  state = step(state, { type: 'at', top: 0, gap: 0 }, 0)

  for (let frame = 1; frame <= 5; frame++) {
    state = step(state, layout(frame * 20 - 20, 20), frame * 16)
    assert.equal(state.toBottom, true)
    state = step(state, { type: 'at', top: frame * 20, gap: 0 }, frame * 16)
    assert.equal(state.phase, 'pinned')
  }
})
