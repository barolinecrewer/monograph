// disclosure: is this open. One instance per thing a reader can open in a
// turn: a work fold (its head row), a block of thinking, a compaction note.
// Adapter: turnDecor() in plugin.js.
//   phase   what is drawn: none | live | folded | open
//   chosen  the reader's last press: null | open | folded (only a press
//           writes it)
// Events: press; read { live, rest }, what a pass saw: `live` while Hermes
// still writes it (a shimmer on the thinking label), `rest` how it lies
// otherwise, 'folded' or null (thinking: Hermes draws its max-h-40 preview;
// a work fold or a note is always 'folded').
//
//   phase (chosen)  | press                 | read live | rest=folded | rest=null
//   ----------------+-----------------------+-----------+-------------+----------
//   none            | -                     | live      | folded      | -
//   live            | -                     | -         | folded      | none
//   folded (null)   | open,   chosen=open   | live      | -           | none
//   folded (folded) | open,   chosen=open   | -         | -           | -
//   open   (open)   | folded, chosen=folded | -         | -           | -
//
// A reader's choice wins: once pressed, a read draws `chosen` and nothing
// else, so an opened block is never drawn live again, nor lands on folded
// under the reader. (Before, a read drew over it: open, then live when the
// shimmer came back, then folded.) A press on none or live is Hermes' own.
// No time. The adapter drops an instance when the thing stops being
// openable (a work fold's marks taken off), and the choice with it.
export const disclosure = {
  id: 'disclosure',
  states: ['none', 'live', 'folded', 'open'],
  start: () => ({ phase: 'none', chosen: null }),
  step(state, event) {
    const { phase } = state

    if (event.type === 'press') {
      if (phase === 'folded' || phase === 'open') {
        const next = phase === 'open' ? 'folded' : 'open'

        return { phase: next, chosen: next }
      }

      return state
    }

    if (event.type !== 'read') {
      return state
    }

    const next = state.chosen ?? (event.live ? 'live' : event.rest === 'folded' ? 'folded' : 'none')

    return next === phase ? state : { phase: next, chosen: state.chosen }
  }
}
