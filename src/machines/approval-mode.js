// approvalMode: the approval mode a profile's chips show. One state per
// profile key; every chip of the profile reads it. Each request takes the
// next revision; only the answer to the newest may change what is shown
// (as Hermes' store/approval-mode.ts).
//
// State: { phase, mode, confirmed, pending, revision }
//   mode: shown, or null (no chip). confirmed: the last answer, or null.
//   pending: the revision of the newest write not yet settled, or 0; every
//   chip of the profile shows it (data-pending).
//   unknown  nothing shown yet, or a pick failed with no answer to go back to
//   shown    mode is the gateway's answer
//   writing  mode is a pick not yet answered (a newer read keeps it on
//            screen until that read answers)
//
// Event (n: its revision)  Next (r: state.revision)
//   read                   r + 1, nothing else
//   write { mode }         r + 1, mode = the pick, writing, pending = r + 1
//   answer { n, mode }     n = r: mode = confirmed = answer, shown
//   failed { n }           n = r: mode = confirmed, shown (unknown if none).
//                          Sent for a write only.
//   answer or failed       n = pending: pending = 0. Neither: same state.
//
// rereadMs, for approvalSync's timers (each reads every profile on screen):
// info 250 ms after the last of a session.info burst that differs from a
// shown mode; command 600 and 1800 ms after Enter on "/approvals …".
export const approvalMode = {
  id: 'approvalMode',
  states: ['unknown', 'shown', 'writing'],
  rereadMs: { command: [600, 1800], info: 250 },
  start: () => ({ confirmed: null, mode: null, pending: 0, phase: 'unknown', revision: 0 }),

  step(state, event) {
    switch (event?.type) {
      case 'read':
        return { ...state, revision: state.revision + 1 }

      case 'write':
        return { ...state, mode: event.mode, pending: state.revision + 1, phase: 'writing', revision: state.revision + 1 }

      case 'answer':
      case 'failed': {
        const newest = event.revision === state.revision
        const settled = event.revision === state.pending

        if (!newest && !settled) {
          return state
        }

        const answer = newest && event.type === 'answer'
        const mode = answer ? event.mode : newest ? state.confirmed : state.mode
        const confirmed = answer ? event.mode : state.confirmed
        const phase = !newest ? state.phase : mode === null ? 'unknown' : 'shown'
        const pending = settled ? 0 : state.pending

        if (mode === state.mode && confirmed === state.confirmed && phase === state.phase && pending === state.pending) {
          return state
        }

        return { ...state, confirmed, mode, pending, phase }
      }

      default:
        return state
    }
  }
}
