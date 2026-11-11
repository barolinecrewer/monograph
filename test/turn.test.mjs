// turn (src/machines/turn.js), transition by transition, and against the run
// lifecycle plan() in turnDecor (src/plugin.js) kept before it was a machine.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { turn } from '../src/machines/turn.js'

const { step } = turn
const read = (running, runtime = null) => ({ type: 'read', running, runtime })
const run = (events, from = turn.start()) => events.reduce((state, [event, now]) => step(state, event, now), from)
const running = (runtime = null, at = 0) => run([[read(true, runtime), at]])
const settling = (runtime = null, at = 100) => run([[read(true, runtime), 0], [read(false, runtime), at]])

test('turn: the time constants', () => {
  assert.equal(turn.SETTLE_MS, 450)
  assert.equal(turn.REMOUNT_MS, 3000)
})

test('turn: starts idle, nothing ended', () => {
  assert.deepEqual(turn.start(), { phase: 'idle', runtime: null, since: null, wakeAt: null, ended: null })
})

test('turn: (idle, running) is running, with the session', () => {
  const next = step(turn.start(), read(true, 's1'), 10)

  assert.equal(next.phase, 'running')
  assert.equal(next.runtime, 's1')
  assert.equal(next.since, null)
  assert.equal(next.wakeAt, null)
})

test('turn: (idle, not running) changes nothing', () => {
  const idle = turn.start()

  assert.equal(step(idle, read(false, 's1'), 10), idle)
  assert.equal(step(idle, read(false), 10), idle)
})

test('turn: (running, running) changes nothing', () => {
  const state = running('s1')

  assert.equal(step(state, read(true, 's1'), 500), state)
})

test('turn: (running, not running) is settling from now, woken SETTLE_MS later', () => {
  const next = step(running('s1'), read(false, 's1'), 1000)

  assert.equal(next.phase, 'settling')
  assert.equal(next.since, 1000)
  assert.equal(next.wakeAt, 1450)
  assert.equal(next.runtime, 's1')
})

test('turn: (settling, not running) waits until SETTLE_MS has passed, to the millisecond', () => {
  const state = settling('s1', 100)

  assert.equal(step(state, read(false, 's1'), 100), state)
  assert.equal(step(state, read(false, 's1'), 549), state, '449 ms is still settling')

  const done = step(state, read(false, 's1'), 550)

  assert.equal(done.phase, 'idle', '450 ms is idle')
  assert.deepEqual(done, { phase: 'idle', runtime: null, since: null, wakeAt: null, ended: { at: 550, runtime: 's1' } })
})

test('turn: a group key (no session) ends with nothing remembered', () => {
  const done = step(settling(null, 100), read(false), 550)

  assert.equal(done.phase, 'idle')
  assert.equal(done.ended, null)
})

test('turn: (settling, running) runs again, the settle clock dropped', () => {
  const next = step(settling('s1', 100), read(true, 's1'), 300)

  assert.equal(next.phase, 'running')
  assert.equal(next.since, null)
  assert.equal(next.wakeAt, null)

  // Settling again starts a new clock.
  const again = step(next, read(false, 's1'), 400)

  assert.equal(again.since, 400)
  assert.equal(step(again, read(false, 's1'), 849).phase, 'settling')
  assert.equal(step(again, read(false, 's1'), 850).phase, 'idle')
})

test('turn: a thread whose session changed starts over', () => {
  // Running in s1, read for s2: not running is idle at once, no settle.
  const stopped = step(running('s1'), read(false, 's2'), 50)

  assert.equal(stopped.phase, 'idle')
  assert.equal(stopped.ended, null, 'a turn that started over did not end')
  assert.equal(turn.live(running('s1'), 's2'), false, 'wasLive is false for the other session')

  // Running in s2 is a new run, not a carried one.
  const fresh = step(running('s1'), read(true, 's2'), 50)

  assert.equal(fresh.phase, 'running')
  assert.equal(fresh.runtime, 's2')

  // Settling in s1, read for s2: idle, no settle either.
  assert.equal(step(settling('s1', 100), read(false, 's2'), 120).phase, 'idle')
  assert.equal(step(settling('s1', 100), read(true, 's2'), 120).runtime, 's2')
})

test('turn: a session change keeps when the last turn ended', () => {
  const ended = step(settling('s1', 100), read(false, 's1'), 600)

  assert.equal(step(ended, read(false, 's2'), 700), ended, 'idle ignores the session')
  assert.equal(step(step(ended, read(true, 's2'), 700), read(false, 's1'), 800).ended, ended.ended, 'a run of s2 dropped for s1 keeps s1 ended')
})

test('turn: live() is "the state before this read was not idle", for this session', () => {
  assert.equal(turn.live(turn.start(), 's1'), false)
  assert.equal(turn.live(running('s1'), 's1'), true)
  assert.equal(turn.live(settling('s1'), 's1'), true)
  assert.equal(turn.live(running(), null), true)
  assert.equal(turn.live(settling('s1'), 's2'), false)
})

test('turn: the remount window is REMOUNT_MS after the end, same session only', () => {
  const ended = step(settling('s1', 100), read(false, 's1'), 1000)

  assert.equal(turn.remounted(ended, 's1', 1000), true)
  assert.equal(turn.remounted(ended, 's1', 3999), true, '2999 ms is inside')
  assert.equal(turn.remounted(ended, 's1', 4000), false, '3000 ms is outside')
  assert.equal(turn.remounted(ended, 's2', 1500), false, 'another session')
  assert.equal(turn.remounted(ended, undefined, 1500), false, 'no session')
  assert.equal(turn.remounted(turn.start(), 's1', 0), false, 'nothing ended')

  // Running again does not forget the end; plan() asks only when wasLive is false.
  assert.equal(turn.remounted(step(ended, read(true, 's1'), 1200), 's1', 1200), true)
})

test('turn: an unknown event, or none, changes nothing', () => {
  const state = settling('s1')

  assert.equal(step(state, { type: 'press' }, 200), state)
  assert.equal(step(state, undefined, 200), state)
})

// The lifecycle as plan() had it before the machine: live, idle, liveRuntime
// and endedAt, keyed by the thread (last pair, session known) or the group.
const before = () => {
  const live = new WeakSet()
  const idle = new WeakMap()
  const endedAt = new WeakMap()
  const liveRuntime = new WeakMap()

  return ({ thread, group, last, runtime, running, now }) => {
    const key = last && runtime ? thread : group
    let recheck = false

    if (key === thread && liveRuntime.get(thread) !== runtime) {
      live.delete(thread)
      idle.delete(thread)
    }

    const wasLive = live.has(key)
    let settled = !running

    if (running) {
      live.add(key)
      idle.delete(key)

      if (key === thread) {
        liveRuntime.set(thread, runtime)
      }
    } else if (wasLive) {
      const since = idle.get(key) ?? now

      idle.set(key, since)

      if (now - since < 450) {
        settled = false
        recheck = true
      }
    }

    const ended = endedAt.get(thread)
    const remounted = !wasLive && last && ended?.runtime === runtime && now - ended.at < 3000

    if (settled) {
      if (live.has(key) && key === thread) {
        endedAt.set(thread, { at: now, runtime })
      }

      live.delete(key)
      idle.delete(key)
    }

    return { wasLive, settled, recheck, mark: running ? 'run' : !settled ? 'settle' : null, remounted }
  }
}

// The same, as plan() has it now.
const after = () => {
  const turns = new WeakMap()
  const IDLE = turn.start()
  const READ = { type: 'read', running: false, runtime: null }

  return ({ thread, group, last, runtime, running, now }) => {
    const key = last && runtime ? thread : group
    const was = turns.get(key) ?? IDLE

    READ.running = running
    READ.runtime = key === thread ? runtime : null

    const wasLive = turn.live(was, READ.runtime)
    const next = turn.step(was, READ, now)

    if (next !== was) {
      turns.set(key, next)
    }

    const remounted = !wasLive && last && turn.remounted(turns.get(thread) ?? IDLE, runtime, now)

    return { wasLive, settled: next.phase === 'idle', recheck: next.phase === 'settling', mark: running ? 'run' : next.phase === 'settling' ? 'settle' : null, remounted }
  }
}

test('turn: plan() decides as it did before the machine, over 20,000 random reads', () => {
  // runtimeFor() answers a session or null, never undefined (the old
  // remount test would throw on undefined with nothing ended).
  // A small fixed generator (mulberry32), so a failure repeats.
  let seed = 7
  const pick = list => {
    seed = (seed + 0x6d2b79f5) | 0

    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)

    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)

    return list[((mixed ^ (mixed >>> 14)) >>> 0) % list.length]
  }
  const thread = {}
  const groups = [{}, {}, {}]
  const old = before()
  const now = after()
  let at = 0

  for (let index = 0; index < 20000; index += 1) {
    at += pick([0, 1, 16, 200, 449, 450, 451, 1000, 2999, 3000])

    const read = { thread, group: pick(groups), last: pick([true, true, false]), runtime: pick(['s1', 's1', 's2', null]), running: pick([true, false, false]), now: at }

    assert.deepEqual(now(read), old(read), `read ${index}: ${JSON.stringify({ ...read, thread: undefined, group: groups.indexOf(read.group) })}`)
  }
})
