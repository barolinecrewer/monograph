# State machines

Monograph draws on top of an app it does not own, so most of its work is
deciding what state something is in: is this turn running, did the reader open
this fold, is the page pinned to the bottom. Where that decision has more than
two outcomes or depends on time, it is a named machine in `src/machines/`.

## The shape

```
page, gateway, clicks  ->  adapter  ->  event  ->  machine.step  ->  state  ->  adapter  ->  data-mg-* marks
        (impure)                        (plain data)   (pure)      (plain data)               (CSS draws)
```

**A machine** is one file in `src/machines/`, an ES module that exports one
constant (more only when they belong together):

```js
export const sessionBusy = {
  id: 'sessionBusy', // the export name
  states: ['idle', 'running', 'handover'], // every phase, by name
  start: () => ({ phase: 'idle' }), // a new state
  step(state, event, now) {} // the next state
}
```

- `state` is plain data. `state.phase` is one of `states`. Anything else the
  machine has to remember sits beside it (`state.since`, `state.wakeAt`).
- `event` is plain data with a `type`. An adapter that reads the page once a
  frame sends what it read as one event (`{ type: 'read', running: true, … }`).
- `step` is pure: the same state, event and `now` give the same answer. It
  does not write into the state it was given. When nothing changes it returns
  the same object, which is how an adapter knows there is nothing to draw. An
  event it does not know changes nothing.
- A machine has no clock and no timer. `now` is handed in. A machine that must
  be stepped again later says when (`state.wakeAt`, in the same clock as
  `now`), and its adapter owns the one timer that does it.
- A machine cannot name `document`, `window`, a timer, storage, `sdk` or
  `React`. `build.mjs` refuses the build if it does.
- One instance per thing. A machine that exists per session or per turn knows
  one of them; its adapter keeps the `Map` from key to state.
- What the reader chose (opened this, scrolled away) and what was worked out
  (this turn is running) are separate fields. Only a reader's event writes the
  first. This is the rule that keeps two writers from fighting over one mark.
- The states and their transitions are a table in the comment at the top of
  the file. That comment is the documentation; there is no second copy.

**An adapter** is the code that owns the page for that machine: it turns what
it reads into events, keeps the timer, and writes the state out as `data-mg-*`
marks with `put()`. It stays where it was (the core, or a module) and offers a
reader: `expose('sessionBusy', () => …)`.

**CSS** draws from the marks and nothing else. The names and values of the
marks are a contract with the stylesheet and with the rig; a machine changes
how a mark is decided, not what it is called.

## Looking at it

- In a running app: `window.__mgState()` returns every machine's current state
  by name, as plain data. `window.__mgState.machines` lists each machine's
  states. Beside it: `window.__mgPerf` (cost) and `window.__mgTrace` (the last
  fold decisions, when `window.__mgTraceOn` is set).
- With no app: `npm test` runs `test/*.test.mjs` under `node --test`.
  `test/contract.test.mjs` holds every machine to the rules above;
  `test/<machine>.test.mjs` walks its transitions.

## Adding one

1. Write the table first: states, events, and for each pair what happens.
2. `src/machines/<name>.js` and `test/<name>.test.mjs`. Run `npm test`.
3. Feed it from its adapter, `expose()` it, build.
4. Add its line below.

Not everything is a machine. One writer, two values, no time: leave it as an
attribute (the settings marks, the panel's open state). The agent panel's
`apply()` in `src/modules/20-agent-panel.js` is a reducer over gateway events
and follows the same idea in its own file.

## The machines

| Machine | File | Adapter | What it decides |
| --- | --- | --- | --- |
| `approvalMode` | `src/machines/approval-mode.js` | `approvalSync()` and the approval chip | The approval mode every chip of a profile shows, and whether a write is still pending. States: unknown, shown, writing. |
| `sessionBusy` | `src/machines/session-busy.js` | `turnState()` | Whether a session counts as running, including the short handover to a queued prompt. States: idle, running, handover. |
| `scroll` | `src/machines/scroll.js` | `keepBottom()` | Whether a chat view follows the bottom. States: unknown, held, pinned, free, reading, quiet, anchored. |
| `turn` | `src/machines/turn.js` | `plan()` in `turnDecor()` | One turn's run. States: idle, running, settling. The adapter keeps the key and the row records. |
| `disclosure` | `src/machines/disclosure.js` | `turnDecor()` | Whether a work fold, a thinking block or a compaction note is open, and what the reader last chose. States: none, live, folded, open. |
| `queued` | `src/machines/queued.js` | `queuedBubbles()` | Where one queued prompt stands. States: known, recorded, placed, shown, expired. |
