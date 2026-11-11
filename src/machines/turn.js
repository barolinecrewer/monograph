// One turn's run, as plan() in turnDecor (src/plugin.js) reads it once a pass.
// The adapter keys it: the thread for the last pair of a known session (so
// Hermes swapping the streamed pair for the stored one is the same turn),
// otherwise the response group. This machine knows one instance, not the key.
//
// One event, read { running, runtime }: running is what the page says (a
// running mark, or the session busy on the last pair, and not only waiting
// for the next prompt's rows); runtime is the session for a thread key, null
// for a group key.
//
//             read, running   read, not running, now-since < SETTLE_MS   read, not running, now-since >= SETTLE_MS
//   idle      running         idle                                       idle
//   running   running         settling (since=now)                       (cannot be: since=now gives 0)
//   settling  running         settling                                   idle (ended={at:now, runtime} when runtime)
//
// Before the table: a state that is not idle and belongs to another runtime
// starts over (idle, ended kept). ended is the thread's last turn: when it
// ended and for which session; remounted() reads it for REMOUNT_MS.
// live() is plan()'s wasLive: the state before this read, after that check,
// is not idle. A settling turn says when to read it again (wakeAt); the
// adapter's timer fires SETTLE_MS after the pass that saw it settling.
// Marks: data-mg-live is 'run' while running, 'settle' while settling.
export const turn = {
  id: 'turn',
  states: ['idle', 'running', 'settling'],
  // Kept on the machine: build.mjs puts this file in the plugin's own scope.
  // How long a reply has to sit idle before its work folds away. A queued
  // prompt's turn starts a moment after the one before it ends, and folding
  // in that gap would fold, unfold and fold again.
  SETTLE_MS: 450,
  REMOUNT_MS: 3000,
  start: () => ({ phase: 'idle', runtime: null, since: null, wakeAt: null, ended: null }),
  live: (state, runtime) => state.phase !== 'idle' && state.runtime === runtime,

  // Rows of a thread's last turn mounted again a moment after it ended, in the
  // same session: still that turn.
  remounted: (state, runtime, now) => state.ended !== null && state.ended.runtime === runtime && now - state.ended.at < turn.REMOUNT_MS,

  step(state, event, now) {
    if (event?.type !== 'read') {
      return state
    }

    const runtime = event.runtime ?? null
    const was = turn.live(state, runtime) ? state.phase : 'idle'

    if (event.running) {
      return was === 'running' ? state : { ...state, phase: 'running', runtime, since: null, wakeAt: null }
    }

    if (was === 'running') {
      return { ...state, phase: 'settling', since: now, wakeAt: now + turn.SETTLE_MS }
    }

    if (was === 'settling' && now - state.since < turn.SETTLE_MS) {
      return state
    }

    if (was === 'settling') {
      return { ...state, phase: 'idle', runtime: null, since: null, wakeAt: null, ended: runtime === null ? state.ended : { at: now, runtime } }
    }

    // Idle already, or a turn of another session started over.
    return state.phase === 'idle' ? state : { ...state, phase: 'idle', runtime: null, since: null, wakeAt: null }
  }
}
