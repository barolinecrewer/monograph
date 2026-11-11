// scroll: does a chat view follow the bottom. One state per viewport. The
// adapter, keepBottom() in src/plugin.js, measures, writes scrollTop and owns
// the timer; this decides.
//
// phase     pinned  meaning
// unknown   null    just found
// held      null    Hermes was placing the view at the last look (an edit, a switch)
// pinned    true    kept at the bottom
// free      false   the reader left the bottom
// reading   false   free, and the line read is picked: it is kept still
// quiet     false   left alone until quietUntil
// anchored  false   a pressed node kept still until anchorUntil, quiet too
//
// Priority is one rule (phaseOf): anchored, quiet, held or unknown, pinned,
// reading, free. Anchored and quiet always come with pinned false, so the
// phase carries pinned, and both end in reading or free.
// Gaps in px, times in ms of `now`'s clock, 0 for none. ownTop: scrollTop our
// last put-back left (NaN: none). toBottom: the last layout asks for the
// bottom (the adapter skips it while text is selected).
//
// event {fields}          what changes (in any phase unless named)
// time {lost}             anchored ends after anchorUntil, or its node is lost
// input {trusted}         wheel up, a key, a press on the scrollbar, anchor's
//                         own wheel: pinned false; trusted also ends anchored
// anchor {ms}             anchored and quiet for ms
// quiet {ms}              pinned false, quiet for ms
// shrink {ms}             a fold of ours shrinks: shrinkUntil, the later end
// restored {top}          a holdStill put back: ownTop
// putBack {top}           the line read put back: top and ownTop
// layout {top, gap, held} after layout, never sent while anchored. First of:
//   quiet: pinned false. held: held.
//   unknown or held: pinned if gap <= 2 or the last gap <= 2 (toBottom if
//     gap > 1), else free.
//   pinned, top more than 2 above the last top, gap > 2, no shrink: free.
//   pinned, gap >= 0.5: toBottom. free or reading, gap <= 2: pinned.
// at {top, gap}           read after our writes: recorded
// scroll {top}            within 1 px of ownTop: ours, no change. Else the
//                         reader's: ownTop NaN, scrolledAt now, line read
//                         dropped, wakeAt now + PICK_MS (0 when pinned)
// seen {top, gap}         not while pinned or quiet: recorded; gap <= 2: pinned
// wake                    wakeAt 0
// picked {found}          the line read, if pinned is false
//
// Readers: pinned (null while quiet); the adapter's guards looks (read a
// scroll's gap), picks (pick the line read), putsBack (REST_MS after the last
// scroll, not quiet). The 900 ms of anchor, quiet and shrink are turnDecor's.
export const scroll = {
  id: 'scroll',
  states: ['unknown', 'held', 'pinned', 'free', 'reading', 'quiet', 'anchored'],
  PICK_MS: 120,
  REST_MS: 200,
  start: () => ({ phase: 'unknown', top: 0, gap: Infinity, ownTop: NaN, scrolledAt: 0, reading: false, quietUntil: 0, anchorUntil: 0, shrinkUntil: 0, wakeAt: 0, toBottom: false }),
  pinnedOf: state => (state.phase === 'pinned' ? true : state.phase === 'unknown' || state.phase === 'held' ? null : false),
  pinned: (state, now) => {
    const pinned = scroll.pinnedOf(state)

    return typeof pinned === 'boolean' && now >= state.quietUntil ? pinned : null
  },
  looks: (state, now) => scroll.pinnedOf(state) !== true && now >= state.quietUntil,
  picks: state => scroll.pinnedOf(state) === false,
  putsBack: (state, now) => state.reading && scroll.pinnedOf(state) === false && now >= state.quietUntil && now - state.scrolledAt >= scroll.REST_MS,
  phaseOf: (pinned, held, reading, quietUntil, anchorUntil, now) => {
    if (anchorUntil) {
      return 'anchored'
    }

    if (now < quietUntil) {
      return 'quiet'
    }

    if (pinned === null) {
      return held ? 'held' : 'unknown'
    }

    return pinned ? 'pinned' : reading ? 'reading' : 'free'
  },
  step(state, event, now) {
    let pinned = scroll.pinnedOf(state)
    let held = state.phase === 'held'
    let { top, gap, ownTop, scrolledAt, reading, quietUntil, anchorUntil, shrinkUntil, wakeAt, toBottom } = state

    switch (event?.type) {
      case 'time':
        if (anchorUntil && (now > anchorUntil || event.lost)) {
          anchorUntil = 0
        }

        break
      case 'input':
        pinned = false

        if (event.trusted) {
          anchorUntil = 0
        }

        break
      case 'anchor':
        pinned = false
        quietUntil = now + event.ms
        anchorUntil = now + event.ms
        break
      case 'quiet':
        pinned = false
        quietUntil = now + event.ms
        break
      case 'shrink':
        shrinkUntil = Math.max(shrinkUntil, now + event.ms)
        break
      case 'restored':
        ownTop = event.top
        break
      case 'putBack':
        top = event.top
        ownTop = event.top
        break
      case 'at':
        top = event.top
        gap = event.gap
        break
      case 'layout':
        toBottom = false

        if (now < quietUntil) {
          pinned = false
        } else if (event.held) {
          pinned = null
          held = true
        } else if (pinned === null) {
          // At the bottom now, or at the last look before this change.
          pinned = event.gap <= 2 || gap <= 2
          toBottom = pinned && event.gap > 1
        } else if (pinned && event.top < top - 2 && event.gap > 2 && now >= shrinkUntil) {
          // Moved up, and not a shrink of ours being clamped.
          pinned = false
        } else if (pinned && event.gap >= 0.5) {
          toBottom = true
        } else if (!pinned && event.gap <= 2) {
          pinned = true
        }

        break
      case 'scroll':
        if (Math.abs(event.top - ownTop) < 1) {
          return state
        }

        ownTop = NaN
        scrolledAt = now
        reading = false
        wakeAt = pinned === true ? 0 : now + scroll.PICK_MS
        break
      case 'seen':
        if (pinned === true || now < quietUntil) {
          return state
        }

        top = event.top
        gap = event.gap

        if (gap <= 2) {
          pinned = true
        }

        break
      case 'wake':
        wakeAt = 0
        break
      case 'picked':
        reading = Boolean(event.found) && pinned === false
        break
      default:
        return state
    }

    const phase = scroll.phaseOf(pinned, held, reading, quietUntil, anchorUntil, now)

    if (
      phase === state.phase &&
      top === state.top &&
      gap === state.gap &&
      Object.is(ownTop, state.ownTop) &&
      scrolledAt === state.scrolledAt &&
      reading === state.reading &&
      quietUntil === state.quietUntil &&
      anchorUntil === state.anchorUntil &&
      shrinkUntil === state.shrinkUntil &&
      wakeAt === state.wakeAt &&
      toBottom === state.toBottom
    ) {
      return state
    }

    return { phase, top, gap, ownTop, scrolledAt, reading, quietUntil, anchorUntil, shrinkUntil, wakeAt, toBottom }
  }
}
