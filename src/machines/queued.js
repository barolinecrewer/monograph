// One queued prompt, by admission id. Adapter: queuedBubbles() in
// src/plugin.js, which keeps the Map, the bubbles and sessionStorage.
//
//             listed, behind   started    loaded     aged, too old   read
//   known     known (listed)   recorded*  recorded   known           known
//   recorded  recorded         recorded   recorded   expired         shown | placed | recorded
//   placed    placed           placed     placed     expired         shown | placed | recorded
//   shown     shown (listed)   recorded*  shown      shown           shown
//   expired   expired (listed) recorded*  expired    expired         expired
//
// * only once listed: the record takes listed.text, listed.stored (or the
//   session) and at = now. listed { text, stored, behind } is the gateway's
//   pending list naming it while another turn of its session runs (behind);
//   evicted forgets listed (the adapter keeps 200). loaded { record } is one
//   from sessionStorage. aged: now - at not under MAX_AGE_MS. read { shown,
//   placed } is a render: Hermes drew the prompt itself (shown wins), or a
//   bubble of ours went in. shown and expired drop the record.
export const queued = {
  id: 'queued',
  states: ['known', 'recorded', 'placed', 'shown', 'expired'],
  // Kept on the machine: build.mjs puts this file in the plugin's own scope.
  MAX_AGE_MS: 12 * 60 * 60 * 1000,
  start: () => ({ phase: 'known', listed: null, session: null, stored: null, text: null, at: null }),
  hasRecord: state => state.phase === 'recorded' || state.phase === 'placed',

  step(state, event, now) {
    const type = event?.type
    const held = queued.hasRecord(state)

    if (type === 'listed') {
      const listed = state.listed

      return !event.behind || (listed && listed.text === event.text && listed.stored === event.stored) ? state : { ...state, listed: { text: event.text, stored: event.stored } }
    }

    if (type === 'evicted') {
      return state.listed ? { ...state, listed: null } : state
    }

    if (type === 'started') {
      if (held || !state.listed) {
        return state
      }

      return { ...state, phase: 'recorded', session: event.session, stored: state.listed.stored ?? event.session, text: state.listed.text, at: now }
    }

    if (type === 'loaded') {
      const { session, stored, text, at } = event.record

      return state.phase === 'known' ? { ...state, phase: 'recorded', session, stored, text, at } : state
    }

    if (!held) {
      return state
    }

    if (type === 'aged' && !(now - state.at < queued.MAX_AGE_MS)) {
      return { ...state, phase: 'expired', session: null, stored: null, text: null, at: null }
    }

    if (type === 'read') {
      if (event.shown) {
        return { ...state, phase: 'shown', session: null, stored: null, text: null, at: null }
      }

      const phase = event.placed ? 'placed' : 'recorded'

      return phase === state.phase ? state : { ...state, phase }
    }

    return state
  }
}
