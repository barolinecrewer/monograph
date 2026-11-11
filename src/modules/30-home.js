// ── Home: what an empty session shows ─────────────────────────────────────
// The greeting (with the user's picture), quick actions that fill the message
// box without sending, pinned sessions and recent sessions.
//
// Where it lives. Hermes' `chat.empty` slot only mounts for a session that
// already exists and is empty; a new chat in the main area is a draft with no
// session id until the first send, and there the slot never mounts
// (thread/index.tsx renders the core intro instead). The composer's
// `composer.underside` slot is mounted under every message box, draft or
// not, so home renders there and decides for itself when to show:
//   - main chat: a new draft (route "#/", no session), nothing running;
//   - a tab (tile): its session is in the persisted list with no messages
//     (a new tab is created and stored at once), nothing running in it;
//   - either way: no message in that surface's thread, not a hidden tab.
// The greeting moves above the box with CSS (62-home.css); the lists hang
// below it, so the box never moves when they load.
//
// Data: `host.listPersistedSessions` (the app's own session read, with model
// and last activity), newest first. The gateway's `session.list` was the
// first choice but answers only live sessions in this Hermes. Pins are the
// config's `pinned` list; pinning here also pins the session in Hermes' own
// sidebar section.

const HOME_RECENT_MAX = 12
const HOME_FETCH = 100
// The most the session list answers at once. Read only to settle a pin the
// first page did not hold.
const HOME_FETCH_ALL = 500
const HOME_STALE_MS = 5_000

// Starters: generic, nothing personal. Text goes in the box; nothing is sent.
const HOME_QUICK = [
  { icon: 'calendar', label: 'Plan the day', text: 'Help me plan my day. Here is what I have on: ' },
  { icon: 'search', label: 'Research a topic', text: 'Research this topic and give me a short summary with sources: ' },
  { icon: 'checklist', label: 'Review a document', text: 'Review this document and tell me what to fix first: ' },
  { icon: 'edit', label: 'Write a draft', text: 'Write a first draft of ' }
]

const HOME_MESSAGE = ':is([data-role="user"], [data-role="assistant"], [data-role="system"])'

// ── Entrance: once per empty session ──
// Home arrives with a short stagger when an empty session is first shown:
// the window's first draft, a draft started after a session was open, a new
// tab. Hermes remounts the composer (and home with it) when an overlay such
// as Settings closes, when the window is resized across a layout change and
// on a plugin reload; none of those is a new empty session, so none plays it
// again. What has played is kept in sessionStorage so a hot reload, which
// runs this file again, remembers it.
const HOME_ENTRANCE_KEY = 'monograph.home.entrance'

function homeEntranceRead() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(HOME_ENTRANCE_KEY) || 'null')

    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function homeEntranceWrite(value) {
  try {
    window.sessionStorage.setItem(HOME_ENTRANCE_KEY, JSON.stringify(value))
  } catch {
    // Storage full or blocked: home then simply does not arrive again.
  }
}

// The draft in the main chat is a new one each time a session was bound in
// between (opened, or made by a send); `draft` counts those. A tab is its own
// session id.
function homeEntranceKey(address) {
  if (!address) {
    return null
  }

  return address === 'new' ? `draft:${homeEntranceRead().draft ?? 0}` : `tab:${address}`
}

// True the first time it is asked for a key, false after.
function homeEntranceClaim(address) {
  const key = homeEntranceKey(address)

  if (!key) {
    return false
  }

  const seen = homeEntranceRead()
  const played = Array.isArray(seen.played) ? seen.played : []

  if (played.includes(key)) {
    return false
  }

  homeEntranceWrite({ ...seen, played: [...played, key].slice(-24) })

  return true
}

// A session became the main chat's: the next draft is a new one.
function homeEntranceNextDraft() {
  const seen = homeEntranceRead()

  homeEntranceWrite({ ...seen, draft: (Number(seen.draft) || 0) + 1 })
}

// ── Data ──
let homeData = { complete: false, error: null, known: new Map(), profile: '', rows: [], status: 'idle', total: 0 }
let homeLoadedAt = 0
let homeInflight = null
const homeListeners = new Set()

const homeSubscribe = listener => {
  homeListeners.add(listener)

  return () => homeListeners.delete(listener)
}

const homeSnapshot = () => homeData

function homeSet(patch) {
  homeData = { ...homeData, ...patch }
  homeListeners.forEach(listener => listener())
}

const homeProfile = () => String(sdk.host?.state?.profile?.get?.() || '').trim() || 'default'

const homeKey = session => String(session?._lineage_root_id || session?.id || '')

function homeRow(session) {
  const title = String(session.title || '').trim()
  const preview = String(session.preview || '').trim()

  return {
    at: Number(session.last_active || session.started_at || 0),
    count: Number(session.message_count ?? 0),
    id: String(session.id),
    key: homeKey(session),
    model: String(session.model || ''),
    // Hermes' own pin (the sidebar's), when this backend reports it.
    server: typeof session.pinned === 'boolean' ? session.pinned : null,
    title: title || preview.replace(/\s+/g, ' ').slice(0, 80) || 'Untitled session'
  }
}

async function homeLoad(force = false) {
  if (homeInflight) {
    return homeInflight
  }

  const profile = homeProfile()

  if (!force && homeData.status === 'ready' && homeData.profile === profile && Date.now() - homeLoadedAt < HOME_STALE_MS) {
    return undefined
  }

  if (typeof sdk.host?.listPersistedSessions !== 'function') {
    homeSet({ error: 'unavailable', status: 'error' })

    return undefined
  }

  // Rows already on screen stay there while the list refreshes.
  homeSet({ error: null, status: homeData.rows.length && homeData.profile === profile ? 'ready' : 'loading' })

  homeInflight = (async () => {
    const result = await sdk.host.listPersistedSessions(null, { limit: HOME_FETCH, profile })
    const sessions = Array.isArray(result?.sessions) ? result.sessions : null

    if (!sessions) {
      throw new Error('no sessions in the answer')
    }

    const all = sessions.filter(session => session?.id && !session.hidden).map(homeRow)
    const known = new Map()

    for (const row of all) {
      known.set(row.key, row)
      known.set(row.id, row)
    }

    const total = Number(result.total)

    homeLoadedAt = Date.now()
    homeSet({
      // The answer holds every session of the profile: a pin that is not in
      // it no longer exists.
      complete: Number.isFinite(total) && total <= sessions.length,
      error: null,
      known,
      profile,
      rows: all.filter(row => row.count > 0).sort((a, b) => b.at - a.at),
      status: 'ready',
      total
    })
  })()
    .catch(() => homeSet({ error: 'failed', status: 'error' }))
    .finally(() => {
      homeInflight = null
    })

  return homeInflight
}

// A pin the first page did not hold: read the longest page the app allows.
// When that holds every session of the profile and still not the pin, the
// session is gone. Past that size nothing is concluded and the pin stays.
let homeVerifying = null

function homeVerify(ids) {
  if (homeVerifying || typeof sdk.host?.listPersistedSessions !== 'function') {
    return homeVerifying
  }

  const profile = homeProfile()

  homeVerifying = sdk.host
    .listPersistedSessions(null, { limit: HOME_FETCH_ALL, profile })
    .then(result => {
      const sessions = Array.isArray(result?.sessions) ? result.sessions : []
      const total = Number(result?.total)
      const known = new Map(homeData.known)

      for (const session of sessions) {
        if (session?.id && !session.hidden) {
          const row = homeRow(session)

          known.set(row.key, row)
          known.set(row.id, row)
        }
      }

      const complete = Number.isFinite(total) && total <= sessions.length

      homeSet({ checked: ids, complete: complete || homeData.complete, known })
    })
    .catch(() => homeSet({ checked: ids }))
    .finally(() => {
      homeVerifying = null
    })

  return homeVerifying
}

// ── Pins ──
const homePins = current =>
  (Array.isArray(current.pinned) ? current.pinned : []).filter(
    pin => pin && typeof pin === 'object' && typeof pin.kind === 'string' && typeof pin.id === 'string' && pin.id
  )

const homeIsPinned = (current, row) =>
  homePins(current).some(pin => pin.kind === 'session' && (pin.id === row.key || pin.id === row.id))

// Pins and unpins made here in the last few seconds: a list page already in
// flight still carries the old flag, so it may not undo them.
const HOME_PIN_FENCE_MS = 15_000
const homePinWrites = new Map()

function homeTogglePin(row) {
  const pins = homePins(getConfig())
  const on = !pins.some(pin => pin.kind === 'session' && (pin.id === row.key || pin.id === row.id))

  setConfig({
    pinned: on
      ? [...pins, { id: row.key, kind: 'session', label: row.title, profile: homeProfile() }]
      : pins.filter(pin => !(pin.kind === 'session' && (pin.id === row.key || pin.id === row.id)))
  })

  homePinWrites.set(row.key, Date.now())
  homePinWrites.set(row.id, Date.now())

  // Hermes' own pin, so its sidebar section shows the same sessions.
  try {
    sdk.host?.sessions?.pin?.(row.key, on)
  } catch {
    // An older Hermes without the door: home's list still holds the pin.
  }

  return on
}

// Follow pins made or removed in Hermes' sidebar: a session Hermes reports
// pinned joins the list, one it reports unpinned leaves it. Pins written here
// moments ago are left alone until the backend has caught up with them.
function homeSyncPins(data) {
  if (data.status !== 'ready' || !data.known?.size) {
    return
  }

  const fresh = id => Date.now() - (homePinWrites.get(id) ?? 0) < HOME_PIN_FENCE_MS
  const pins = homePins(getConfig())
  const profile = data.profile
  const ours = pin => pin.kind === 'session' && (!pin.profile || pin.profile === profile)
  const kept = pins.filter(pin => {
    if (!ours(pin) || fresh(pin.id)) {
      return true
    }

    return data.known.get(pin.id)?.server !== false
  })
  const have = new Set(kept.filter(ours).flatMap(pin => [pin.id, data.known.get(pin.id)?.id, data.known.get(pin.id)?.key]))
  const added = []

  for (const row of new Set(data.known.values())) {
    if (row.server === true && !have.has(row.key) && !have.has(row.id) && !fresh(row.key) && !fresh(row.id)) {
      added.push({ id: row.key, kind: 'session', label: row.title, profile })
      have.add(row.key)
    }
  }

  if (added.length || kept.length !== pins.length) {
    setConfig({ pinned: [...kept, ...added] })
  }
}

// Pinned sessions of this profile, resolved to fresh titles. A pin whose
// session is gone (the list was complete and it was not in it) is dropped.
function homePinnedRows(current, data) {
  const pins = homePins(current).filter(pin => pin.kind === 'session' && (!pin.profile || pin.profile === data.profile))
  const rows = []
  const gone = []
  const unknown = []

  for (const pin of pins) {
    const row = data.known?.get(pin.id) ?? data.rows.find(item => item.id === pin.id)

    if (row) {
      rows.push(row)
    } else if (data.status === 'ready' && data.complete) {
      gone.push(pin)
    } else {
      unknown.push(pin.id)
      rows.push({ at: 0, count: 1, id: pin.id, key: pin.id, model: '', title: String(pin.label || '').trim() || 'Pinned session' })
    }
  }

  return { gone, rows, unknown }
}

// ── Formatting ──
function homeWhen(seconds) {
  if (!seconds) {
    return ''
  }

  const ms = seconds > 1e12 ? seconds : seconds * 1000
  const age = Math.max(0, Date.now() - ms) / 1000

  if (age < 60) {
    return 'now'
  }

  if (age < 3600) {
    return `${Math.floor(age / 60)}m`
  }

  if (age < 86400) {
    return `${Math.floor(age / 3600)}h`
  }

  if (age < 7 * 86400) {
    return `${Math.floor(age / 86400)}d`
  }

  const date = new Date(ms)

  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' })
  })
}

function homeFullWhen(seconds) {
  if (!seconds) {
    return ''
  }

  const ms = seconds > 1e12 ? seconds : seconds * 1000

  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const homeModelName = model => String(model || '').split('/').filter(Boolean).pop() || ''

// ── Where the composer is ──
const homeDraftRoute = () => /^#?\/?(\?.*)?$/.test(window.location.hash)

const homeAtom = name => sdk.host?.state?.[name]

// Tabs whose session home has asked the list about, so one unknown tab asks
// once and not on every frame.
const homeAsked = new Set()
// Sessions at a route whose thread has shown a message in this window.
const homeFilled = new Set()

// The composer an underside belongs to: the main chat (address 'new', the
// draft), a tab (its stored session id), or null for anything home stays
// out of (popped out, a hidden tab, no chat surface).
//
// Hidden means `inert`, or `aria-hidden` that is not a modal layer's veil: an
// open menu, palette or dialog marks every sibling of its portal aria-hidden
// (Radix, through the aria-hidden package, which tags each node it marks with
// data-aria-hidden). That veil leaves the page on screen under the layer, so
// home stays; taking it away would move the composer under an open menu and
// play home's entrance again on close.
const HOME_HIDDEN = '[inert], [aria-hidden="true"]:not([data-aria-hidden])'

function homePlace(anchor) {
  const dock = anchor?.closest?.('[data-slot="composer-dock"]')
  const surface = anchor?.closest?.('[data-chat-surface]')

  if (!dock || !surface || dock.hasAttribute('data-popped-out') || surface.closest(HOME_HIDDEN)) {
    return null
  }

  const target = surface.getAttribute('data-composer-target') || 'main'

  if (target === 'main') {
    return { address: 'new', surface, tile: null }
  }

  return target.startsWith('tile:') && target.length > 5 ? { address: target.slice(5), surface, tile: target.slice(5) } : null
}

// { show, watch, address }: whether home shows here, and whether the surface
// is worth watching for its thread to clear or fill.
function homeVerdict(anchor) {
  const place = homePlace(anchor)

  if (!place) {
    return { address: null, show: false, watch: false }
  }

  const messages = Boolean(place.surface.querySelector(`[data-slot="aui_thread-content"] ${HOME_MESSAGE}`))
  const focused = homeAtom('focusedStoredSessionId')?.get?.() ?? null
  const working = Boolean(homeAtom('busy')?.get?.() || homeAtom('awaitingResponse')?.get?.())

  if (!place.tile) {
    if (homeDraftRoute()) {
      // A new draft: the route names no session and none is bound yet.
      const watch = !homeAtom('activeSessionId')?.get?.()

      return { address: place.address, show: watch && !(focused === null && working) && !messages, watch }
    }

    // A session route whose session holds no messages: one restored at
    // launch, one opened from the sidebar (in Advanced each tab the
    // sidebar's "+" opens is a listed "Untitled session"), one whose first
    // turn stored nothing. Judged like a tab, from Hermes' own list (the
    // session's message count) and only once Hermes has bound the route
    // (an active runtime). Never from how long the thread has been empty:
    // on a switch, and when a send binds the draft, Hermes draws the thread
    // with no messages for a frame or two, and those sessions either have
    // messages in the list or are not in it yet (rig/suites/home.mjs h18).
    const id = homeRouteSession()
    const runtime = homeAtom('activeSessionId')?.get?.() ?? null

    if (!id || !runtime) {
      return { address: null, show: false, watch: false }
    }

    // A thread that has drawn a message is not watched (a subtree observer
    // on a streaming thread), and its session is not taken for empty again
    // in this window on the list's word: the list read when a send bound
    // the session can predate its first stored message, and a later switch
    // back would otherwise meet an empty frame and a count of 0.
    if (messages) {
      homeFilled.add(id)
    }

    if (homeFilled.has(id)) {
      return { address: null, show: false, watch: false }
    }

    const running = Boolean(homeAtom('busyBySession')?.get?.()?.[runtime]) || working

    return homeKnownEmpty(id, place.address === 'new' ? id : place.address, running, messages)
  }

  // A tab: only a session the list holds with no messages in it. One the
  // list does not know is never treated as empty.
  const running = Boolean(homeAtom('busyBySession')?.get?.()?.[place.tile]) || (focused === place.tile && working)

  return homeKnownEmpty(place.tile, place.address, running, messages)
}

// A stored session the list holds with no messages, nothing running in it
// and nothing drawn in its thread. One the list does not know is asked about
// once and meanwhile never treated as empty.
function homeKnownEmpty(id, address, running, messages) {
  const row = homeData.known?.get(id)

  if (!row && !homeAsked.has(id)) {
    homeAsked.add(id)
    void homeLoad(true)
  }

  const watch = Boolean(row && row.count === 0)

  return { address, show: watch && !running && !messages, watch }
}

// The stored session the main chat's route names (#/<id>), or null.
function homeRouteSession() {
  const path = window.location.hash.replace(/^#/, '').split('?')[0]
  const match = /^\/([^/]+)$/.exec(path)

  if (!match) {
    return null
  }

  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

// Told whenever a dock gains or loses home's mark (home shows or hides), so
// what must exist only while home shows can follow without polling.
const homeShownSubs = new Set()
const homeShownChanged = () => homeShownSubs.forEach(sub => sub())

// Re-reads on every signal that can change the answer. The surface's DOM is
// watched only while the rest says "home", to see a thread clear or fill.
function useHomeVisible(anchorRef) {
  const [verdict, setVerdict] = useState({ address: null, show: false })

  useEffect(() => {
    let frame = 0
    let observer = null
    let watched = null
    let veiler = null
    let veiled = null

    // 62-home.css keys on these two instead of asking the document with
    // :has(): the slot's strip (hidden while home is not showing and holds
    // nothing else) and the dock (centred, own greeting off) while home shows.
    let marked = { dock: null, strip: null }

    const mark = show => {
      const anchor = anchorRef.current
      const strip = anchor?.parentElement ?? null
      const dock = anchor?.closest?.('[data-slot="composer-dock"]') ?? null

      if (marked.strip && marked.strip !== strip) {
        delete marked.strip.dataset.mgHomeSlot
      }

      let changed = false

      if (marked.dock && marked.dock !== dock && 'mgHomeDock' in marked.dock.dataset) {
        delete marked.dock.dataset.mgHomeDock
        changed = true
      }

      if (strip && strip !== dock) {
        const value = show ? 'on' : strip.childElementCount === 1 ? 'empty' : 'shared'

        if (strip.dataset.mgHomeSlot !== value) {
          strip.dataset.mgHomeSlot = value
        }
      }

      if (dock) {
        if (show && dock.dataset.mgHomeDock !== '') {
          dock.dataset.mgHomeDock = ''
          changed = true
        } else if (!show && 'mgHomeDock' in dock.dataset) {
          delete dock.dataset.mgHomeDock
          changed = true
        }
      }

      marked = { dock, strip: strip !== dock ? strip : null }

      if (changed) {
        homeShownChanged()
      }
    }

    const apply = next => {
      mark(next.show)
      setVerdict(previous => (previous.show === next.show && previous.address === next.address ? previous : { address: next.address, show: next.show }))
    }

    const run = () => {
      frame = 0

      const anchor = anchorRef.current
      const next = homeVerdict(anchor)

      apply(next)

      const surface = next.watch ? (anchor?.closest?.('[data-chat-surface]') ?? null) : null
      // Something that makes the page under it inert or aria-hidden (not a
      // modal layer's veil, see HOME_HIDDEN) has homePlace() answer null;
      // nothing else fires when it lets go, so it is watched until then.
      const veil = anchor?.closest?.('[data-chat-surface]')?.closest(HOME_HIDDEN) ?? null

      if (veil !== veiled) {
        veiler?.disconnect()
        veiler = veil ? new MutationObserver(schedule) : null
        veiler?.observe(veil, { attributeFilter: ['aria-hidden', 'inert'], attributes: true })
        veiled = veil
      }

      if (surface && watched !== surface) {
        observer?.disconnect()
        observer = new MutationObserver(schedule)
        observer.observe(surface, { childList: true, subtree: true })
        watched = surface
      } else if (!surface && observer) {
        observer.disconnect()
        observer = null
        watched = null
      }
    }

    const schedule = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(run)
      }
    }

    // A send hides home in the same task, before the next frame.
    const now = () => {
      const next = homeVerdict(anchorRef.current)

      if (!next.show) {
        apply(next)
      }

      schedule()
    }

    const stops = ['activeSessionId', 'busy', 'awaitingResponse', 'busyBySession', 'focusedStoredSessionId']
      .map(name => homeAtom(name)?.listen?.(now))
      .filter(Boolean)

    stops.push(homeSubscribe(schedule))
    window.addEventListener('hashchange', now)
    schedule()

    return () => {
      stops.forEach(stop => stop())
      window.removeEventListener('hashchange', now)
      observer?.disconnect()
      veiler?.disconnect()

      if (frame) {
        window.cancelAnimationFrame(frame)
      }

      if (marked.strip) {
        delete marked.strip.dataset.mgHomeSlot
      }

      if (marked.dock && 'mgHomeDock' in marked.dock.dataset) {
        delete marked.dock.dataset.mgHomeDock
        homeShownChanged()
      }
    }
  }, [anchorRef])

  return verdict
}

// ── Actions ──
function homeOpen(row) {
  const path = `/${encodeURIComponent(row.id)}`

  try {
    sdk.host.navigate(path)
  } catch {
    window.location.hash = `#${path}`
  }
}

// Text into the box home sits under; nothing is sent. `setDraft` is the
// app's own door; it reports false when no box answers for the address.
async function homeFill(address, text) {
  const composer = sdk.host?.composer

  if (!composer?.setDraft || !address) {
    return false
  }

  const done = await composer.setDraft(address, text).catch(() => false)

  if (done) {
    composer.focus?.(address)
  }

  return Boolean(done)
}

// ── View ──
const homeStep = index => ({ '--mg-i': String(index) })

function HomeAvatar({ src }) {
  const [broken, setBroken] = useState(false)

  if (!src || broken || !/^data:image\//i.test(src)) {
    return null
  }

  return jsx('img', { alt: '', className: 'mg-home-avatar', draggable: false, onError: () => setBroken(true), src })
}

// Keyboard in the lists: Up and Down move between the rows (Pinned and
// Recent are one list), Home and End go to the first and last, Left and Right
// move between the quick actions. Down from a quick action goes to the first
// row. Tab still reaches everything, pins included, in reading order.
function homeArrows(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return
  }

  const body = event.currentTarget
  const here = event.target
  const rows = [...body.querySelectorAll('.mg-home-open')]
  const chips = [...body.querySelectorAll('.mg-home-action')]
  const inRows = rows.indexOf(here.closest?.('.mg-home-row')?.querySelector('.mg-home-open'))
  const inChips = chips.indexOf(here)
  let next = null

  if (inRows >= 0) {
    if (event.key === 'ArrowDown') {
      next = rows[Math.min(rows.length - 1, inRows + 1)]
    } else if (event.key === 'ArrowUp') {
      next = inRows > 0 ? rows[inRows - 1] : chips[0]
    } else if (event.key === 'Home') {
      next = rows[0]
    } else if (event.key === 'End') {
      next = rows.at(-1)
    }
  } else if (inChips >= 0) {
    if (event.key === 'ArrowRight') {
      next = chips[Math.min(chips.length - 1, inChips + 1)]
    } else if (event.key === 'ArrowLeft') {
      next = chips[Math.max(0, inChips - 1)]
    } else if (event.key === 'ArrowDown') {
      next = rows[0]
    }
  }

  if (next) {
    event.preventDefault()
    next.focus()
    next.scrollIntoView?.({ block: 'nearest' })
  }
}

function HomeRow({ index, pinned, row }) {
  const logo = row.model ? logoFor('', row.model) : null
  const model = homeModelName(row.model)
  const when = homeWhen(row.at)

  return jsxs('li', {
    className: 'mg-home-row',
    'data-mg-pinned': pinned ? '' : undefined,
    'data-mg-session': row.id,
    style: homeStep(index),
    children: [
      jsxs('button', {
        className: 'mg-home-open',
        onClick: () => homeOpen(row),
        title: row.title,
        type: 'button',
        children: [
          jsx('span', { className: 'mg-home-title', children: row.title }),
          model
            ? jsxs('span', {
                className: 'mg-home-model',
                children: [logo ? jsx('span', { 'aria-hidden': true, className: 'mg-logo', 'data-logo': logo }) : null, jsx('span', { children: model })]
              })
            : null,
          when ? jsx('time', { className: 'mg-home-when', title: homeFullWhen(row.at), children: when }) : null
        ]
      }),
      jsx('button', {
        'aria-label': `${pinned ? 'Unpin' : 'Pin'} ${row.title}`,
        'aria-pressed': pinned,
        className: 'mg-home-pin',
        onClick: () => homeTogglePin(row),
        title: pinned ? 'Unpin' : 'Pin',
        type: 'button',
        children: jsx('i', { 'aria-hidden': true, className: `codicon codicon-${pinned ? 'pinned' : 'pin'}` })
      })
    ]
  })
}

function HomeSection({ children, label, start }) {
  return jsxs('section', {
    'aria-label': label,
    className: 'mg-home-section',
    children: [jsx('h2', { className: 'mg-home-label', style: homeStep(start), children: label }), children]
  })
}

function HomeBody({ address }) {
  const current = useSyncExternalStore(subscribe, getConfig)
  const data = useSyncExternalStore(homeSubscribe, homeSnapshot)
  const gateway = useAtom(sdk.host.state.gateway)
  const [filled, setFilled] = useState(null)
  const bodyRef = React.useRef(null)

  // The lists end 20px above the bottom of the chat, wherever the box sits,
  // and scroll beyond that. Home is out of flow, so sizing it never moves
  // the box it is measured against.
  useEffect(() => {
    const body = bodyRef.current
    const dock = body?.closest('[data-slot="composer-dock"]')
    const surface = body?.closest('[data-chat-surface]')

    if (!body || !dock || !surface) {
      return undefined
    }

    let frame = 0
    const fit = () => {
      frame = 0

      const room = Math.floor(surface.getBoundingClientRect().bottom - body.getBoundingClientRect().top - 20)
      const value = `${Math.max(96, room)}px`

      if (body.style.maxHeight !== value) {
        body.style.maxHeight = value
      }
    }
    const schedule = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(fit)
      }
    }
    const sizes = new ResizeObserver(schedule)

    sizes.observe(dock)
    sizes.observe(surface)
    fit()

    return () => {
      sizes.disconnect()

      if (frame) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [])

  // Every arrival reads the list again; rows already known stay on screen.
  useEffect(() => {
    if (gateway === 'open') {
      void homeLoad(true)
    }
  }, [gateway])

  // A session pinned, unpinned or deleted in another window, or in the
  // sidebar beside home, shows when this window or home is looked at again:
  // the window coming to the front reads the list (at most every 5 s).
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') {
        void homeLoad()
      }
    }

    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)

    return () => {
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [])

  useEffect(() => homeSyncPins(data), [data])

  const { gone, rows: pinnedRows, unknown } = homePinnedRows(current, data)
  const unknownKey = unknown.join('|')

  // Pins the first page did not hold are looked up once, in the longer page.
  useEffect(() => {
    if (unknownKey && data.status === 'ready' && data.checked !== unknownKey) {
      void homeVerify(unknownKey)
    }
  }, [unknownKey, data.status, data.checked])

  // Pins whose session is gone leave quietly, after the render that found them.
  useEffect(() => {
    if (!gone.length) {
      return
    }

    const drop = new Set(gone.map(pin => pin.id))

    setConfig({ pinned: homePins(getConfig()).filter(pin => !(pin.kind === 'session' && drop.has(pin.id))) })
  }, [gone.map(pin => pin.id).join('|')])

  const pinnedKeys = new Set(pinnedRows.flatMap(row => [row.key, row.id]))
  const recent = data.rows.filter(row => !pinnedKeys.has(row.key) && !pinnedKeys.has(row.id)).slice(0, HOME_RECENT_MAX)

  let step = 1
  const quick = jsx('div', {
    'aria-label': 'Quick actions',
    className: 'mg-home-quick',
    role: 'group',
    children: HOME_QUICK.map(item =>
      jsxs(
        'button',
        {
          className: 'mg-home-action',
          'data-mg-filled': filled === item.label ? '' : undefined,
          onClick: () => {
            void homeFill(address, item.text).then(done => setFilled(done ? item.label : null))
          },
          style: homeStep(step++),
          title: item.text.trim(),
          type: 'button',
          children: [jsx('i', { 'aria-hidden': true, className: `codicon codicon-${item.icon}` }), jsx('span', { children: item.label })]
        },
        item.label
      )
    )
  })

  // Pins wait for the list, so one whose session is gone is never drawn.
  const pinned = pinnedRows.length && data.status === 'ready'
    ? jsx(HomeSection, {
        label: 'Pinned',
        start: step++,
        children: jsx('ul', {
          className: 'mg-home-list',
          children: pinnedRows.map(row => jsx(HomeRow, { index: step++, pinned: true, row }, row.key))
        })
      })
    : null

  let recentBody

  if (data.status === 'error' && !data.rows.length) {
    recentBody = jsxs('div', {
      className: 'mg-home-note',
      children: [
        jsx('span', { children: 'Recent sessions could not be loaded.' }),
        jsx('button', { className: 'mg-home-retry', onClick: () => void homeLoad(true), type: 'button', children: 'Try again' })
      ]
    })
  } else if (data.status !== 'ready' && !data.rows.length) {
    recentBody = jsx('ul', {
      'aria-busy': true,
      'aria-label': 'Loading recent sessions',
      className: 'mg-home-list mg-home-skeleton',
      children: [0, 1, 2].map(index => jsx('li', { className: 'mg-home-ghost', style: homeStep(step + index) }, index))
    })
    step += 3
  } else if (!recent.length) {
    recentBody = jsx('p', {
      className: 'mg-home-note',
      style: homeStep(step++),
      children: data.rows.length ? 'Every recent session is pinned above.' : 'No sessions yet. What you start here will be listed below.'
    })
  } else {
    recentBody = jsx('ul', {
      className: 'mg-home-list',
      children: recent.map(row => jsx(HomeRow, { index: step++, pinned: false, row }, row.key))
    })
  }

  return jsxs('div', {
    className: 'mg-home-body',
    onKeyDown: homeArrows,
    ref: bodyRef,
    children: [quick, pinned, jsx(HomeSection, { label: 'Recent', start: step++, children: recentBody })]
  })
}

function HomeGreeting() {
  const current = useSyncExternalStore(subscribe, getConfig)

  return jsxs('div', {
    className: 'mg-home-hello',
    style: homeStep(0),
    children: [jsx(HomeAvatar, { src: String(current.avatar || '') }), jsx('h1', { className: 'mg-home-greeting', children: greeting(current) })]
  })
}

// The entrance: claimed once per empty session when home first shows there,
// and over in about half a second. Rows that come in later just appear.
function HomeShown({ address }) {
  const [arriving, setArriving] = useState(() => homeEntranceClaim(address))

  useEffect(() => {
    if (!arriving) {
      return undefined
    }

    const timer = window.setTimeout(() => setArriving(false), 900)

    return () => window.clearTimeout(timer)
  }, [])

  return jsxs('div', {
    className: 'mg-home',
    'data-mg-arriving': arriving ? '' : undefined,
    'data-mg-home': '',
    children: [jsx(HomeGreeting, {}), jsx(HomeBody, { address })]
  })
}

function Home() {
  const anchorRef = React.useRef(null)
  const { address, show } = useHomeVisible(anchorRef)

  return jsxs(React.Fragment, {
    children: [
      jsx('span', { 'aria-hidden': true, className: 'mg-home-anchor', hidden: true, ref: anchorRef }),
      show ? jsx(HomeShown, { address }, address) : null
    ]
  })
}

MODULES.push({
  id: 'home',
  start(ctx) {
    const undo = []

    if (sdk.COMPOSER_AREAS?.underside && sdk.host?.state?.gateway) {
      ctx.register({ area: sdk.COMPOSER_AREAS.underside, id: 'monograph-home', render: () => jsx(Home, {}) })
    }

    // A session bound to the main chat ends the current draft: the next one
    // is a new empty session and arrives again.
    try {
      const atom = sdk.host?.state?.activeSessionId
      let bound = atom?.get?.() ?? null
      const stop = atom?.listen?.(() => {
        const next = atom.get?.() ?? null

        if (next && next !== bound) {
          homeEntranceNextDraft()
        }

        bound = next
      })

      if (typeof stop === 'function') {
        undo.push(stop)
      }
    } catch {
      // No such atom: a draft then arrives once per window.
    }

    // The list follows changes made elsewhere while home is on screen:
    // - the gateway's `sessions.changed` (its change watcher: state.db moved,
    //   checked every 0.5 s) covers a delete, rename, pin or new session from
    //   the sidebar, another window, the CLI or a bot;
    // - Hermes' own cross-window bus (BroadcastChannel "hermes:sessions",
    //   store/session-sync.ts) covers another window before the database has
    //   moved.
    // With home off screen the list is only marked stale; it is read when
    // home next shows. Bursts (a streaming turn moves state.db) are folded
    // into one read.
    let sessionsTimer = 0
    const sessionsMoved = () => {
      homeLoadedAt = 0

      if (sessionsTimer || !document.querySelector('[data-mg-home-dock]')) {
        return
      }

      sessionsTimer = window.setTimeout(() => {
        sessionsTimer = 0
        // A read already under way may predate the change: read once more
        // after it.
        void Promise.resolve(homeInflight)
          .catch(() => undefined)
          .then(() => homeLoad(true))
      }, 120)
    }

    const stopSessionsEvent = ctx.onEvent?.('sessions.changed', sessionsMoved)

    if (typeof stopSessionsEvent === 'function') {
      undo.push(stopSessionsEvent)
    }

    try {
      const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('hermes:sessions') : null

      if (bus) {
        bus.addEventListener('message', sessionsMoved)
        undo.push(() => {
          bus.removeEventListener('message', sessionsMoved)
          bus.close()
        })
      }
    } catch {
      // No channel: the gateway's event alone.
    }

    // A pin or unpin in this window's sidebar is local (store/layout.ts) and
    // reaches the database, and so `sessions.changed`, only within the
    // watcher's 2 s floor (measured 1.3 and 2.2 s, h16). Last resort, as the
    // workstream rules allow: rows added, removed or moved in the sidebar's
    // own list (childList only, never text or attributes), while home is on
    // screen. Attached when home shows, to the sidebar node only.
    let sidebarWatch = null
    let watched = null

    const watchSidebar = () => {
      const list = document.querySelector('[data-slot="sidebar"]')
      const shown = Boolean(document.querySelector('[data-mg-home-dock]'))
      const target = shown ? list : null

      if (target === watched) {
        return
      }

      sidebarWatch?.disconnect()
      sidebarWatch = null
      watched = target

      if (target) {
        sidebarWatch = new MutationObserver(records => {
          if (records.some(record => record.addedNodes.length || record.removedNodes.length)) {
            sessionsMoved()
          }
        })
        sidebarWatch.observe(target, { childList: true, subtree: true })
      }
    }

    // Home hiding (a send, a route change by pushState, which fires no
    // event) lets go of the sidebar at once.
    homeShownSubs.add(watchSidebar)
    undo.push(() => homeShownSubs.delete(watchSidebar))
    undo.push(homeSubscribe(watchSidebar))
    window.addEventListener('hashchange', watchSidebar)
    watchSidebar()

    undo.push(() => {
      window.clearTimeout(sessionsTimer)
      sessionsTimer = 0
      window.removeEventListener('hashchange', watchSidebar)
      sidebarWatch?.disconnect()
      sidebarWatch = null
      watched = null
    })

    undo.push(() => {
      for (const node of document.querySelectorAll('[data-mg-home-slot], [data-mg-home-dock]')) {
        delete node.dataset.mgHomeSlot
        delete node.dataset.mgHomeDock
      }
    })

    // Surfaces menu: Home opens a new empty session.
    const allowed = new Set((ctx.listActions?.() ?? []).map(action => action.id))

    if (allowed.has('session.new') || typeof sdk.host?.newChat === 'function') {
      const row = {
        icon: 'home',
        key: 'home',
        label: 'Home',
        letter: 'h',
        // Monograph's rows read Home, Knowledge, Agent: the two places first,
        // then the panel beside the chat (each module inserts by rank).
        rank: 0,
        run: () => {
          const result = allowed.has('session.new') ? ctx.runAction('session.new') : null

          if (!result || result.ok === false) {
            sdk.host?.newChat?.()
          }
        }
      }

      const after = SHARED.surfaces.findIndex(other => (other?.rank ?? 9) > row.rank)

      SHARED.surfaces.splice(after < 0 ? SHARED.surfaces.length : after, 0, row)
      undo.push(() => {
        const index = SHARED.surfaces.indexOf(row)

        if (index >= 0) {
          SHARED.surfaces.splice(index, 1)
        }
      })
    }

    return () => undo.forEach(stop => stop())
  }
})
