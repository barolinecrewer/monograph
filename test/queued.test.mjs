// queued (src/machines/queued.js), transition by transition, and what its
// adapter queuedBubbles() in src/plugin.js keeps in sessionStorage.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { queued } from '../src/machines/queued.js'

const { step } = queued
const HOUR = 60 * 60 * 1000
const listed = (text = 'hello', stored = 'S1') => ({ type: 'listed', text, stored, behind: true })
const recorded = (at = 100) => step(step(queued.start(), listed(), 0), { type: 'started', session: 'r1' }, at)

test('queued: the time constant', () => {
  assert.equal(queued.MAX_AGE_MS, 12 * HOUR)
})

test('queued: starts known, with nothing listed and no record', () => {
  assert.deepEqual(queued.start(), { phase: 'known', listed: null, session: null, stored: null, text: null, at: null })
})

test('queued: listed behind a running turn keeps its text and stored id', () => {
  const next = step(queued.start(), listed('a', 'S'), 0)

  assert.equal(next.phase, 'known')
  assert.deepEqual(next.listed, { text: 'a', stored: 'S' })
  assert.equal(step(next, listed('a', 'S'), 1), next, 'the same listing changes nothing')
  assert.deepEqual(step(next, listed('b', 'S'), 1).listed, { text: 'b', stored: 'S' }, 'a new text replaces it')
})

test('queued: listed with no other turn running is ignored', () => {
  const start = queued.start()

  assert.equal(step(start, { ...listed(), behind: false }, 0), start)
})

test('queued: started once listed is recorded, at now, from what was listed', () => {
  const next = recorded(500)

  assert.equal(next.phase, 'recorded')
  assert.deepEqual([next.session, next.stored, next.text, next.at], ['r1', 'S1', 'hello', 500])
  assert.equal(step(step(queued.start(), { ...listed('x'), stored: undefined }, 0), { type: 'started', session: 'r1' }, 1).stored, 'r1', 'no stored id: the session')
})

test('queued: started never listed, or already recorded, changes nothing', () => {
  const start = queued.start()
  const held = recorded()
  const placed = step(held, { type: 'read', placed: true }, 0)

  assert.equal(step(start, { type: 'started', session: 'r1' }, 0), start)
  assert.equal(step(held, { type: 'started', session: 'r2' }, 900), held)
  assert.equal(step(placed, { type: 'started', session: 'r2' }, 900), placed)
})

test('queued: loaded from storage is recorded as it was', () => {
  const record = { id: 'q', session: 'r', stored: 's', text: 't', at: 42 }
  const next = step(queued.start(), { type: 'loaded', record }, 0)

  assert.deepEqual(next, { phase: 'recorded', listed: null, session: 'r', stored: 's', text: 't', at: 42 })
  assert.equal(step(next, { type: 'loaded', record: { ...record, text: 'u' } }, 0), next, 'only into a fresh state')
})

test('queued: a record is kept for under 12 hours, then expires', () => {
  const held = recorded(0)
  const placed = step(held, { type: 'read', placed: true }, 0)

  assert.equal(step(held, { type: 'aged' }, 12 * HOUR - 1), held)
  assert.equal(step(held, { type: 'aged' }, 12 * HOUR).phase, 'expired')
  assert.equal(step(placed, { type: 'aged' }, 12 * HOUR).phase, 'expired')
  assert.equal(step(held, { type: 'aged' }, 12 * HOUR).text, null, 'the record goes')
  assert.equal(step({ ...held, at: undefined }, { type: 'aged' }, 0).phase, 'expired', 'no time is too old')
})

test('queued: read places, unplaces, and shown wins', () => {
  const held = recorded()
  const placed = step(held, { type: 'read', shown: false, placed: true }, 0)

  assert.equal(placed.phase, 'placed')
  assert.equal(step(placed, { type: 'read', placed: true }, 0), placed)
  assert.equal(step(held, { type: 'read' }, 0), held)
  assert.equal(step(placed, { type: 'read' }, 0).phase, 'recorded')

  const shown = step(placed, { type: 'read', shown: true, placed: true }, 0)

  assert.equal(shown.phase, 'shown')
  assert.deepEqual([shown.session, shown.stored, shown.text, shown.at], [null, null, null, null])
  assert.deepEqual(shown.listed, { text: 'hello', stored: 'S1' }, 'what was listed stays')
})

test('queued: shown and expired keep what was listed, and start again when their turn does', () => {
  const shown = step(recorded(), { type: 'read', shown: true }, 0)
  const expired = step(recorded(0), { type: 'aged' }, 13 * HOUR)

  for (const from of [shown, expired]) {
    assert.equal(step(from, { type: 'started', session: 'r9' }, 7).phase, 'recorded')
    assert.equal(step(from, { type: 'read', shown: true }, 0), from)
    assert.equal(step(from, { type: 'aged' }, 1e12), from)
    assert.equal(step(from, { type: 'loaded', record: { text: 't' } }, 0), from)
  }
})

test('queued: evicted forgets the listing', () => {
  const known = step(queued.start(), listed(), 0)

  assert.equal(step(known, { type: 'evicted' }, 0).listed, null)
  assert.equal(step(queued.start(), { type: 'evicted' }, 0).listed, null)
  assert.equal(step(queued.start(), { type: 'evicted' }, 0).phase, 'known')
})

// ── The adapter, through sessionStorage ─────────────────────────────────────
// queuedBubbles() is lifted out of src/plugin.js with no page: no threads, so
// no bubble is placed, and only what it keeps in storage is looked at. The
// same test holds for the code before the machine (it reads and writes the
// same key in the same shape).
const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'src', 'plugin.js'), 'utf8')
const from = source.indexOf('function queuedBubbles(')
const body = source.slice(from, source.indexOf('\n}\n', from) + 2)
const KEY = 'hermes.plugin.monograph.queued'

function rig(initial) {
  const clock = { now: 1_000_000_000_000 }
  const store = new Map(initial === undefined ? [] : [[KEY, initial]])
  const handlers = []
  const window = {
    cancelAnimationFrame: () => {},
    requestAnimationFrame: () => 1,
    sessionStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  }
  const document = { querySelectorAll: () => [] }
  const readers = {}
  const globals = {
    Date: { now: () => clock.now },
    GROUP: '',
    HTMLElement: class {},
    PAIR: '',
    QUEUED_KEY: KEY,
    QUEUED_MAX_AGE: 12 * HOUR,
    QUEUED_SKEW_MS: 0,
    ROW: '',
    USER_ROW: '',
    document,
    expose: (id, read) => {
      readers[id] = read

      return () => {}
    },
    finder: { threads: new Set() },
    queued,
    sdk: { host: { state: {} } },
    timed: (name, fn) => fn,
    watchThreads: () => () => {},
    window
  }
  const make = new Function(...Object.keys(globals), `${body}\nreturn queuedBubbles`)
  const stop = make(...Object.values(globals))({ onEvent: (type, handler) => handlers.push(handler) })
  const send = (type, session, extra = {}) => handlers.forEach(handler => handler({ type, session_id: session, ...extra }))
  const saved = () => JSON.parse(store.get(KEY) ?? 'null')

  return { clock, readers, saved, send, stop, store }
}

// A turn runs in r1; prompt `id` is listed behind it; that turn ends and the
// queued one starts.
const queue = (r, id, text = `text of ${id}`) => {
  r.send('message.start', 'r1', { admission_id: `run-${id}` })
  r.send('session.info', 'r1', { payload: { stored_session_id: 'S1', pending: [{ admission_id: id, text }] } })
  r.send('message.complete', 'r1')
  r.send('message.start', 'r1', { admission_id: id })
}

test('queuedBubbles: a queued prompt whose turn starts is saved as { id, session, stored, text, at }', () => {
  const r = rig()

  queue(r, 'q1', 'two\nlines')
  assert.deepEqual(r.saved(), [{ id: 'q1', session: 'r1', stored: 'S1', text: 'two\nlines', at: r.clock.now }])
  assert.equal(r.store.get(KEY), `[{"id":"q1","session":"r1","stored":"S1","text":"two\\nlines","at":${r.clock.now}}]`, 'keys in this order')
})

test('queuedBubbles: a prompt admitted into an idle session, or the running one, gets no record', () => {
  const r = rig()

  r.send('session.info', 'r1', { payload: { stored_session_id: 'S1', pending: [{ admission_id: 'a', text: 'idle' }] } })
  r.send('message.start', 'r1', { admission_id: 'a' })
  r.send('session.info', 'r1', { payload: { pending: [{ admission_id: 'a', text: 'running' }, { admission_id: 'b', text: ' ' }, { admission_id: 'c', text: 'x', steering: true }] } })
  r.send('message.complete', 'r1')

  for (const id of ['b', 'c']) {
    r.send('message.start', 'r1', { admission_id: id })
  }

  assert.equal(r.saved(), null, 'nothing was saved')
})

test('queuedBubbles: what an older copy saved is read, and kept when the next is saved', () => {
  const old = [
    { id: 'old', session: 'r0', stored: 'S0', text: 'kept', at: 1_000_000_000_000 - 11 * HOUR },
    { id: 'stale', session: 'r0', stored: 'S0', text: 'too old', at: 1_000_000_000_000 - 12 * HOUR },
    { id: '', text: 'no id', at: 1_000_000_000_000 },
    { id: 'notext', text: 5, at: 1_000_000_000_000 }
  ]
  const r = rig(JSON.stringify(old))

  queue(r, 'q2')
  assert.deepEqual(r.saved().map(record => record.id), ['old', 'q2'])
  assert.deepEqual(r.saved()[0], old[0])
})

test('queuedBubbles: storage that is not a list, or not JSON, is read as empty', () => {
  for (const initial of ['{"id":"x"}', 'not json']) {
    const r = rig(initial)

    queue(r, 'q3')
    assert.deepEqual(r.saved().map(record => record.id), ['q3'])
  }
})

test('queuedBubbles: a record is not made twice, and the 40 last are saved', () => {
  const r = rig()

  for (let index = 0; index < 45; index += 1) {
    r.clock.now += 1
    queue(r, `p${index}`)
  }

  r.send('message.start', 'r1', { admission_id: 'p44' })
  assert.equal(r.saved().length, 40)
  assert.equal(r.saved()[0].id, 'p5')
  assert.equal(r.saved().at(-1).id, 'p44')
})

test('queuedBubbles: records past 12 hours go when the next is made', () => {
  const r = rig()

  queue(r, 'early')
  r.clock.now += 12 * HOUR
  queue(r, 'late')
  assert.deepEqual(r.saved().map(record => record.id), ['late'])
})

test('queuedBubbles: only the 200 prompts listed last can be recorded', () => {
  const r = rig()

  r.send('message.start', 'r1', { admission_id: 'running' })
  r.send('session.info', 'r1', { payload: { pending: Array.from({ length: 201 }, (_, index) => ({ admission_id: `k${index}`, text: 'x' })) } })
  r.send('message.complete', 'r1')
  r.send('message.start', 'r1', { admission_id: 'k0' })
  r.send('message.start', 'r1', { admission_id: 'k1' })
  assert.deepEqual(r.saved().map(record => record.id), ['k1'])
})

test('queuedBubbles: records are saved in the order their turns started', () => {
  const r = rig()

  r.send('message.start', 'r1', { admission_id: 'run' })
  r.send('session.info', 'r1', { payload: { pending: [{ admission_id: 'a', text: 'A' }, { admission_id: 'b', text: 'B' }] } })
  r.send('message.complete', 'r1')
  r.send('message.start', 'r1', { admission_id: 'b' })
  r.send('message.start', 'r1', { admission_id: 'a' })
  assert.deepEqual(r.saved().map(record => record.id), ['b', 'a'])
})

test('queuedBubbles: a second start of a recorded prompt neither ages nor saves anything', () => {
  const r = rig()

  queue(r, 'a')
  const before = r.store.get(KEY)

  r.clock.now += 12 * HOUR
  r.send('message.start', 'r1', { admission_id: 'a' })
  assert.equal(r.store.get(KEY), before)
})

test('queuedBubbles: a record read from storage 12 hours old is dropped at once (exposed state)', () => {
  const now = 1_000_000_000_000
  const r = rig(JSON.stringify([{ id: 'old', session: 'r0', stored: 'S0', text: 't', at: now - 12 * HOUR }, { id: 'new', session: 'r0', stored: 'S0', text: 't', at: now }]))

  assert.deepEqual(Object.keys(r.readers.queued().prompts), ['new'])
  assert.equal(r.readers.queued().prompts.new.phase, 'recorded')
})
