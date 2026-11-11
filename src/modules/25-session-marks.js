// ── Sidebar: the model's mark on each session row ───────────────────────────
// Hermes' session rows do not say which model answered. This puts the model's
// logo (the marks the model menu and home already draw) at the head of each
// row, through Hermes' own row slot, `sessionRow.leading`.
//
// Data: `host.listPersistedSessions`, the app's own read of the stored list
// (home reads the same). The slot hands each row its stored id, the root of
// its compression chain, so every id of a chain is mapped to the chain's
// newest model. Nothing is read from the page and no backend plugin is asked.
//
// The list is read at start, and again when a row asks for a session the list
// did not hold (a new one), when a session starts or stops working (its model
// may have changed) and when the profile changes; at most once per
// MARKS_GAP_MS, and a session the list still does not hold is asked for again
// only after MARKS_RETRY_MS.
const MARKS_FETCH = 500
const MARKS_GAP_MS = 4_000
const MARKS_RETRY_MS = 30_000

// stored session id -> its model as stored ('' when none yet)
let marksModels = new Map()
// session the list did not hold -> when it was last asked for
const marksAsked = new Map()
const marksListeners = new Set()
let marksLoadedAt = 0
let marksReady = false
let marksInflight = false
let marksTimer = 0
let marksLive = false

const marksSubscribe = listener => {
  marksListeners.add(listener)

  return () => marksListeners.delete(listener)
}

const marksSame = (a, b) => a.size === b.size && [...a].every(([id, model]) => b.get(id) === model)

async function marksLoad() {
  if (!marksLive || marksInflight || typeof sdk.host?.listPersistedSessions !== 'function') {
    return
  }

  marksInflight = true
  marksLoadedAt = Date.now()

  try {
    const profile = String(sdk.host?.state?.profile?.get?.() || '').trim() || 'default'
    const result = await sdk.host.listPersistedSessions(null, { limit: MARKS_FETCH, profile })
    const next = new Map()

    for (const session of Array.isArray(result?.sessions) ? result.sessions : []) {
      const model = String(session?.model || '')
      const chain = Array.isArray(session?._lineage_ids) ? session._lineage_ids : []

      for (const id of [session?._lineage_root_id, session?.id, ...chain]) {
        if (id) {
          next.set(String(id), model)
        }
      }
    }

    const first = !marksReady

    marksReady = true

    if (marksLive && (first || !marksSame(marksModels, next))) {
      marksModels = next
      marksListeners.forEach(listener => listener())
    }
  } catch {
    // The rows keep the marks they have; the next read tries again.
  } finally {
    marksInflight = false
  }
}

// One read, no sooner than MARKS_GAP_MS after the last one began.
function marksSoon() {
  if (!marksLive || marksTimer) {
    return
  }

  marksTimer = setTimeout(
    () => {
      marksTimer = 0
      void marksLoad()
    },
    Math.max(0, MARKS_GAP_MS - (Date.now() - marksLoadedAt))
  )
}

// A row is on screen for a session the list did not hold.
function marksWant(id) {
  const now = Date.now()

  // Before the first answer every row would ask; that answer is on its way.
  if (!marksReady || marksModels.has(id) || now - (marksAsked.get(id) ?? 0) < MARKS_RETRY_MS) {
    return
  }

  marksAsked.set(id, now)
  marksSoon()
}

function SessionMark({ sessionId }) {
  const model = useSyncExternalStore(marksSubscribe, () => marksModels.get(sessionId))
  const ready = useSyncExternalStore(marksSubscribe, () => marksReady)

  useEffect(() => {
    if (ready && model === undefined) {
      marksWant(sessionId)
    }
  }, [sessionId, model, ready])

  const logo = model ? logoFor('', model) : null

  return logo ? jsx('span', { 'aria-hidden': true, className: 'mg-logo mg-row-model', 'data-logo': logo }) : null
}

MODULES.push({
  id: 'session-marks',
  start(ctx) {
    const area = sdk.SESSION_ROW_AREAS?.leading

    // An older Hermes has no row slot; the rows then stay as Hermes draws them.
    if (!area || typeof sdk.host?.listPersistedSessions !== 'function') {
      return () => undefined
    }

    marksLive = true

    const handle = ctx.register({ area, data: { render: props => jsx(SessionMark, props) }, id: 'monograph-session-mark' })

    const off = [
      sdk.host.state?.busyBySession?.listen?.(marksSoon),
      sdk.host.state?.profile?.listen?.(() => {
        marksAsked.clear()
        marksSoon()
      })
    ]

    void marksLoad()

    return () => {
      marksLive = false
      clearTimeout(marksTimer)
      marksTimer = 0
      off.forEach(stop => typeof stop === 'function' && stop())

      if (typeof handle === 'function') {
        handle()
      }

      marksListeners.clear()
    }
  }
})
