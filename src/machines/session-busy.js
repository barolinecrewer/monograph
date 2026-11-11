// One session's turn, by runtime id. Adapter: turnState() in src/plugin.js.
// A turn that ends with prompts queued is followed by the next within a
// second or two; until then (HANDOVER_MS at most) it counts as running.
//
//             start    complete, waiting>0   complete, 0   pending, 0   tick, since+HANDOVER_MS
//   idle      running  handover              idle          idle         idle
//   running   running  handover              idle          running      running
//   handover  running  handover (since=now)  handover      idle         idle
//
// start { admission } sets current (null: no id), complete clears it,
// pending { items } sets waiting: the items not steering, not current, and
// 'queued' (or no status). wakeAt = since + HANDOVER_MS + WAKE_LATE_MS.
// Busy = Hermes' busyBySession, or handingOver(state, now).
export const sessionBusy = {
  id: 'sessionBusy',
  states: ['idle', 'running', 'handover'],
  // Kept on the machine: build.mjs puts this file in the plugin's own scope.
  HANDOVER_MS: 5000,
  WAKE_LATE_MS: 50,
  start: () => ({ phase: 'idle', current: undefined, waiting: 0, since: null, wakeAt: null }),
  handingOver: (state, now) => state.phase === 'handover' && now - state.since < sessionBusy.HANDOVER_MS,

  queuedBehind(items, current) {
    let count = 0

    for (const item of items) {
      if (item && !item.steering && item.admission_id !== current && (item.status ?? 'queued') === 'queued') {
        count += 1
      }
    }

    return count
  },

  step(state, event, now) {
    const type = event?.type

    if (type === 'start') {
      const current = event.admission ?? null

      return state.phase === 'running' && state.current === current ? state : { ...state, phase: 'running', current, since: null, wakeAt: null }
    }

    if (type === 'complete') {
      if (state.waiting > 0) {
        return { ...state, phase: 'handover', current: undefined, since: now, wakeAt: now + sessionBusy.HANDOVER_MS + sessionBusy.WAKE_LATE_MS }
      }

      // Nothing waiting leaves a handover's clock as it was.
      const phase = state.phase === 'handover' ? 'handover' : 'idle'

      return state.phase === phase && state.current === undefined ? state : { ...state, phase, current: undefined }
    }

    if (type === 'pending') {
      const waiting = sessionBusy.queuedBehind(event.items ?? [], state.current)

      if (!waiting && state.phase === 'handover') {
        return { ...state, phase: 'idle', waiting, since: null, wakeAt: null }
      }

      return waiting === state.waiting ? state : { ...state, waiting }
    }

    if (type === 'tick' && state.phase === 'handover' && now - state.since >= sessionBusy.HANDOVER_MS) {
      return { ...state, phase: 'idle', since: null, wakeAt: null }
    }

    return state
  }
}
