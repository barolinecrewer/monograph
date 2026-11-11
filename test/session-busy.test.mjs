// sessionBusy (src/machines/session-busy.js), transition by transition, and
// its adapter turnState() in src/plugin.js against a fake clock and gateway.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sessionBusy } from '../src/machines/session-busy.js'

const { step } = sessionBusy
const run = (events, from = sessionBusy.start()) => events.reduce((state, [event, now]) => step(state, event, now), from)
const queued = id => ({ admission_id: id, status: 'queued' })

test('session-busy: the time constants', () => {
  assert.equal(sessionBusy.HANDOVER_MS, 5000)
  assert.equal(sessionBusy.WAKE_LATE_MS, 50)
})

test('session-busy: starts idle with nothing waiting', () => {
  assert.deepEqual(sessionBusy.start(), { phase: 'idle', current: undefined, waiting: 0, since: null, wakeAt: null })
})

test('session-busy: start from every phase is running, with the admission id', () => {
  const handover = run([[{ type: 'pending', items: [queued('b')] }, 0], [{ type: 'complete' }, 10]])

  for (const from of [sessionBusy.start(), run([[{ type: 'start', admission: 'x' }, 0]]), handover]) {
    const next = step(from, { type: 'start', admission: 'a' }, 20)

    assert.equal(next.phase, 'running')
    assert.equal(next.current, 'a')
    assert.equal(next.since, null)
    assert.equal(next.wakeAt, null)
  }

  assert.equal(step(sessionBusy.start(), { type: 'start' }, 0).current, null, 'no admission id is null')
})

test('session-busy: start of the turn already running changes nothing', () => {
  const running = run([[{ type: 'start', admission: 'a' }, 0]])

  assert.equal(step(running, { type: 'start', admission: 'a' }, 5), running)
})

test('session-busy: complete with nothing waiting is idle', () => {
  const next = run([[{ type: 'start', admission: 'a' }, 0], [{ type: 'complete' }, 100]])

  assert.equal(next.phase, 'idle')
  assert.equal(next.current, undefined)
  assert.equal(step(sessionBusy.start(), { type: 'complete' }, 0).phase, 'idle')
})

test('session-busy: complete with prompts waiting is a handover, woken 5050 ms later', () => {
  const next = run([[{ type: 'start', admission: 'a' }, 0], [{ type: 'pending', items: [queued('a'), queued('b')] }, 10], [{ type: 'complete' }, 1000]])

  assert.equal(next.phase, 'handover')
  assert.equal(next.since, 1000)
  assert.equal(next.wakeAt, 6050)
  assert.equal(next.current, undefined)

  // From idle too (a pending list seen before any start).
  assert.equal(run([[{ type: 'pending', items: [queued('b')] }, 0], [{ type: 'complete' }, 7]]).phase, 'handover')
})

test('session-busy: complete during a handover with prompts waiting begins it again', () => {
  const first = run([[{ type: 'pending', items: [queued('b')] }, 0], [{ type: 'complete' }, 100]])
  const again = step(first, { type: 'complete' }, 300)

  assert.equal(again.since, 300)
  assert.equal(again.wakeAt, 5350)
})

test('session-busy: complete during a handover with nothing waiting keeps it as it was', () => {
  const handover = run([[{ type: 'pending', items: [queued('b')] }, 0], [{ type: 'complete' }, 100]])
  const emptied = { ...handover, waiting: 0 }

  assert.equal(step(emptied, { type: 'complete' }, 400), emptied)
})

test('session-busy: pending counts only queued, non-steering prompts behind the running one', () => {
  const running = run([[{ type: 'start', admission: 'a' }, 0]])
  const items = [queued('a'), queued('b'), { admission_id: 'c' }, { admission_id: 'd', status: 'running' }, { admission_id: 'e', steering: true }, null]

  assert.equal(step(running, { type: 'pending', items }, 1).waiting, 2, 'b and c')
  assert.equal(sessionBusy.queuedBehind(items, 'a'), 2)
  // Before any start, an item with no id is the "running" one (undefined).
  assert.equal(sessionBusy.queuedBehind([{ status: 'queued' }], undefined), 0)
  assert.equal(sessionBusy.queuedBehind([{ status: 'queued' }], null), 1)
})

test('session-busy: pending with the same count changes nothing', () => {
  const state = run([[{ type: 'pending', items: [queued('b')] }, 0]])

  assert.equal(step(state, { type: 'pending', items: [queued('c')] }, 1), state)
  assert.equal(step(state, { type: 'pending' }, 1).waiting, 0, 'no list is an empty one')
})

test('session-busy: pending with none left ends a handover', () => {
  const handover = run([[{ type: 'pending', items: [queued('b')] }, 0], [{ type: 'complete' }, 100]])
  const next = step(handover, { type: 'pending', items: [] }, 200)

  assert.equal(next.phase, 'idle')
  assert.equal(next.since, null)
  assert.equal(next.wakeAt, null)
  assert.equal(step(handover, { type: 'pending', items: [queued('c'), queued('d')] }, 200).phase, 'handover')
})

test('session-busy: pending with none left while running stays running', () => {
  const running = run([[{ type: 'start', admission: 'a' }, 0], [{ type: 'pending', items: [queued('b')] }, 1]])

  assert.equal(step(running, { type: 'pending', items: [] }, 2).phase, 'running')
})

test('session-busy: a handover is busy for 5000 ms, and a tick ends it from then on', () => {
  const handover = run([[{ type: 'pending', items: [queued('b')] }, 0], [{ type: 'complete' }, 1000]])

  assert.equal(sessionBusy.handingOver(handover, 5999), true)
  assert.equal(sessionBusy.handingOver(handover, 6000), false)
  assert.equal(step(handover, { type: 'tick' }, 5999), handover)
  assert.equal(step(handover, { type: 'tick' }, 6000).phase, 'idle')
  assert.equal(sessionBusy.handingOver(sessionBusy.start(), 0), false)
})

test('session-busy: a tick outside a handover changes nothing', () => {
  const running = run([[{ type: 'start', admission: 'a' }, 0]])

  assert.equal(step(running, { type: 'tick' }, 1e9), running)
  assert.equal(step(sessionBusy.start(), { type: 'tick' }, 1e9).phase, 'idle')
})

// ── The adapter ──────────────────────────────────────────────────────────────
// turnState() is lifted out of src/plugin.js as it stands and run with a fake
// gateway, a fake clock and a fake timer.
const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'src', 'plugin.js'), 'utf8')
const body = source.slice(source.indexOf('function turnState('), source.indexOf('\n}\n', source.indexOf('function turnState(')) + 2)

function rig() {
  const clock = { now: 0, timers: [] }
  const handlers = []
  const busy = {}
  const calls = []
  const sdk = {
    host: {
      onEvent: (type, handler) => {
        handlers.push(handler)

        return () => {}
      },
      state: {
        activeSessionId: { get: () => 'A', listen: () => () => {} },
        busyBySession: { get: () => busy, listen: () => () => {} }
      }
    }
  }
  const window = {
    clearTimeout: id => {
      clock.timers = clock.timers.filter(timer => timer.id !== id)
    },
    setTimeout: (fn, ms) => {
      const id = clock.timers.length + 1 + Math.random()

      clock.timers.push({ at: clock.now + ms, fn, id })

      return id
    }
  }
  const FakeDate = { now: () => clock.now }
  const make = new Function('sdk', 'window', 'Date', 'sessionBusy', 'expose', 'HANDOVER_MS', `${body}\nreturn turnState`)
  const turnState = make(sdk, window, FakeDate, sessionBusy, () => () => {}, 5000)
  const state = turnState(() => calls.push(clock.now))
  const send = (type, session, extra = {}) => handlers.forEach(handler => handler({ type, session_id: session, ...extra }))
  const advanceTo = at => {
    for (;;) {
      const due = clock.timers.filter(timer => timer.at <= at).sort((a, b) => a.at - b.at)[0]

      if (!due) {
        break
      }

      clock.timers = clock.timers.filter(timer => timer !== due)
      clock.now = due.at
      due.fn()
    }

    clock.now = at
  }
  const thread = session => ({ closest: () => ({ dataset: { sessionAnchor: session === 'A' ? 'workspace' : `session-tile:${session}-stored` } }) })

  return { advanceTo, calls, clock, send, state, thread }
}

const endWithQueued = (r, session) => {
  r.send('session.info', session, { payload: { stored_session_id: `${session}-stored`, pending: [{ admission_id: `${session}-next`, status: 'queued' }] } })
  r.send('message.complete', session)
}

test('turnState: a handover is busy for 5000 ms and re-checked at 5050 ms', () => {
  const r = rig()

  r.send('message.start', 'A', { admission_id: 'A1' })
  endWithQueued(r, 'A')
  r.calls.length = 0
  r.advanceTo(4999)
  assert.equal(r.state.busy(r.thread('A')), true)
  r.advanceTo(5000)
  assert.equal(r.state.busy(r.thread('A')), false)
  assert.deepEqual(r.calls, [])
  r.advanceTo(6000)
  assert.deepEqual(r.calls, [5050], 'one re-check, 50 ms after the handover ran out')
})

test('turnState: a queued turn that starts ends the handover; none waiting ends it too', () => {
  const r = rig()

  endWithQueued(r, 'A')
  r.advanceTo(1000)
  r.send('message.start', 'A', { admission_id: 'A2' })
  assert.equal(r.state.busy(r.thread('A')), false)

  endWithQueued(r, 'A')
  r.calls.length = 0
  r.send('session.info', 'A', { payload: { pending: [] } })
  assert.deepEqual(r.calls, [1000], 'the end of a handover is news')
  assert.equal(r.state.busy(r.thread('A')), false)
  r.send('session.info', 'A', { payload: { pending: [] } })
  assert.deepEqual(r.calls, [1000], 'once')
})

test('turnState: each session is re-checked at the end of its own handover', () => {
  const r = rig()

  endWithQueued(r, 'A')
  r.advanceTo(2000)
  endWithQueued(r, 'B')
  r.calls.length = 0
  // A's handover ran out at 5000; nothing else happens until then.
  r.advanceTo(5100)
  assert.equal(r.state.busy(r.thread('A')), false)
  // B's handover, begun later, must not cancel A's re-check.
  assert.deepEqual(r.calls, [5050], 'A is re-checked at its own time')
  assert.equal(r.state.busy(r.thread('B')), true)
  r.advanceTo(8000)
  assert.deepEqual(r.calls, [5050, 7050], 'and B at its own')
  assert.equal(r.state.busy(r.thread('B')), false)
})

test('turnState: a handover begun again moves its re-check, and the other session keeps its own', () => {
  const r = rig()

  endWithQueued(r, 'A')
  r.advanceTo(1000)
  endWithQueued(r, 'B')
  r.advanceTo(3000)
  endWithQueued(r, 'A')
  r.calls.length = 0
  r.advanceTo(20000)
  assert.deepEqual(r.calls, [6050, 8050])
})
