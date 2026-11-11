// Agent panel: a right-hand pane, `monograph:agent`, with the trace of the
// focused session's turn. Built only from gateway events (ctx.onEvent) and
// the gateway's own replay ring (session.events.since); nothing is read out of
// the chat column, so the pane never makes the chat do layout work.
//
//   header    "Working for 12s" while the turn runs, "Worked for 3m 38s" after
//   searched  domains read out of search and fetch steps, de-duplicated
//   steps     one row per tool call, reasoning block and interim note:
//             what it is, a short argument, running / done / failed, how long
//   agents    sub-agents from subagent.* events, each with a small bot face
//   approval  Hermes' own waiting approval (the approval.request event):
//             Deny and Allow, no Edit (Hermes has none). The answer goes
//             through Hermes' own card when it is on screen, else through
//             approval.respond
//
// State is per runtime session id, kept for the last few sessions only, and
// mirrored to sessionStorage so a reload or a hot reload starts where it was.
// Opened and closed from the surfaces menu (letter P).

const PANE = 'agent'
const PANE_ID = `${ID}:${PANE}`
const OPEN_KEY = 'agentPane'
const SNAP_KEY = 'hermes.plugin.monograph.agent'
const MAX_SESSIONS = 8
const MAX_STEPS = 400
const SHOWN_STEPS = 30
// Only the newest running steps tick: a wide parallel batch would otherwise
// rewrite dozens of timers every second.
const TICKING = 3
const MAX_SOURCES = 60
const MAX_AGENTS = 24
const TEXT_MAX = 160
const AGENT_STALE_MS = 10 * 60 * 1000
const AGENT_CARRY_MS = 2 * 60 * 1000
const NEW_ROW_MS = 700
// A sub-agent keeps this many of its own steps; a todo list shows this many
// rows before "Show all".
const MAX_AGENT_STEPS = 120
const TODO_SHOWN = 12
const TODO_MAX = 200

// ── Small helpers ──
const clip = (value, max = TEXT_MAX) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()

  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const firstLine = value => clip(String(value ?? '').split(/\n/).find(line => line.trim()) ?? '')

const human = name => {
  const raw = String(name || 'tool')
  const tail = raw.startsWith('mcp__') ? raw.split('__').slice(2).join('__') || raw : raw
  const words = tail.replace(/[_-]+/g, ' ').trim()

  return words ? words[0].toUpperCase() + words.slice(1) : 'Tool'
}

const hostOf = url => {
  try {
    const parsed = new URL(String(url))

    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.replace(/^www\./, '').toLowerCase() : ''
  } catch {
    return ''
  }
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/g

const KIND_ICONS = [
  [/search|query|find/i, 'search'],
  [/extract|fetch|crawl|scrape|browse|navigate|web|http|url/i, 'globe'],
  [/terminal|shell|exec|bash|process|command/i, 'terminal'],
  [/^todo/i, 'checklist'],
  [/patch|edit|write|replace/i, 'edit'],
  [/read|file|list|glob|grep/i, 'file'],
  [/delegate|agent|subagent/i, 'hubot'],
  [/image|vision|screenshot/i, 'device-camera'],
  [/memory|skill|note/i, 'book']
]

const iconFor = name => KIND_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'tools'

const isSearchy = name => /search|extract|fetch|crawl|scrape|browse|navigate|web|url/i.test(name)

// What a step's arguments say, in a few words. The gateway already sends an
// 80-character preview (`context`); the rest is a fallback for replays and
// other emitters.
function argSummary(name, args, context) {
  if (context) {
    return clip(context, 120)
  }

  if (!args || typeof args !== 'object') {
    return ''
  }

  const pick = ['query', 'command', 'path', 'file_path', 'url', 'goal', 'pattern', 'name', 'prompt', 'text']

  for (const key of pick) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      return clip(args[key], 120)
    }
  }

  if (Array.isArray(args.urls) && args.urls.length) {
    const first = hostOf(args.urls[0]) || clip(args.urls[0], 60)

    return args.urls.length > 1 ? `${first} and ${args.urls.length - 1} more` : first
  }

  return ''
}

// Did a tool fail? Hermes' tool.complete carries no flag; the result says so.
function failed(payload) {
  if (typeof payload?.is_error === 'boolean') {
    return payload.is_error
  }

  if (payload?.error) {
    return true
  }

  const result = payload?.result

  if (result && typeof result === 'object') {
    if (result.success === false || result.ok === false || result.status === 'error') {
      return true
    }

    if (typeof result.error === 'string' && result.error.trim()) {
      return true
    }

    if (Number.isInteger(result.exit_code) && result.exit_code !== 0) {
      return true
    }
  }

  return typeof result === 'string' && /^\s*(error|failed)\b/i.test(result)
}

// Was the tool stopped rather than failed? A stopped turn interrupts the
// running command (exit 130, "[Command interrupted]") or abandons the tool
// ("[Tool execution cancelled …]").
function interrupted(payload) {
  const result = payload?.result

  if (result && typeof result === 'object') {
    return result.exit_code === 130 || /\[Command interrupted\]/.test(String(result.output ?? '').slice(-200))
  }

  return typeof result === 'string' && /^\s*\[Tool execution cancelled\b|\[Command interrupted\]/.test(result.slice(0, 200) + result.slice(-200))
}

// URLs and queries a search or fetch step names, from its arguments and, for
// search tools, from its result.
function sourcesOf(name, args, result) {
  const urls = []
  const queries = []

  const add = value => {
    if (typeof value === 'string') {
      for (const match of value.match(URL_RE) ?? []) {
        urls.push(match)
      }
    }
  }

  if (args && typeof args === 'object') {
    for (const key of ['url', 'href', 'link', 'page']) {
      add(args[key])
    }

    for (const key of ['urls', 'links']) {
      if (Array.isArray(args[key])) {
        args[key].forEach(add)
      }
    }

    for (const key of ['query', 'q', 'search_query']) {
      if (typeof args[key] === 'string' && args[key].trim()) {
        queries.push(clip(args[key], 80))
      }
    }

    if (Array.isArray(args.queries)) {
      args.queries.filter(item => typeof item === 'string').forEach(item => queries.push(clip(item, 80)))
    }
  }

  if (result && isSearchy(name)) {
    // A bounded walk: search results nest their links a level or three deep.
    let seen = 0
    const walk = (value, depth) => {
      if (seen > 200 || depth > 5 || urls.length > 24) {
        return
      }

      seen += 1

      if (typeof value === 'string') {
        add(value.slice(0, 4000))
      } else if (Array.isArray(value)) {
        value.slice(0, 40).forEach(item => walk(item, depth + 1))
      } else if (value && typeof value === 'object') {
        for (const key of Object.keys(value).slice(0, 30)) {
          walk(value[key], depth + 1)
        }
      }
    }

    walk(result, 0)
  }

  return { queries, urls }
}

// ── Store ──
// sessions: runtime id → { sid, turn, seq, epoch, approval }
// A turn: { id, startedAt, endedAt, status, steps, open, sources, agents,
//           dropped, live, partial }
const sessions = new Map()
const storeListeners = new Set()
let version = 0
let queued = 0
let snapshotTimer = 0
let debug = null

// The pane draws at most about three times a second. Hermes' own stylesheet has
// :has() rules high in the tree, so any change in the window, the pane's
// included, re-styles most of the app: a burst of 50 parallel tool calls must
// cost a handful of style passes, not one per event.
// In a burst (a batch of parallel calls: dozens of events between two
// draws) the pane draws once a second: each draw is a style pass over the
// whole window, and a 200-step turn with the pane open measured p95 frames of
// 76 ms against 51 ms closed at three draws a second (panel p7).
const DRAW_EVERY_MS = 300
const BURST_EVENTS = 12
const BURST_DRAW_MS = 1000
let lastDraw = 0
let drawTimer = 0
let sinceDraw = 0
let bursting = false

const draw = () => {
  drawTimer = 0
  queued = window.requestAnimationFrame(() => {
    queued = 0
    lastDraw = performance.now()
    bursting = sinceDraw > BURST_EVENTS
    sinceDraw = 0
    version += 1
    storeListeners.forEach(listener => listener())
  })
}

const notify = () => {
  sinceDraw += 1

  if (queued || drawTimer) {
    return
  }

  // The draw after a busy interval waits longer; a calm one goes back to 300.
  const wait = lastDraw + (bursting ? BURST_DRAW_MS : DRAW_EVERY_MS) - performance.now()

  if (wait > 0) {
    drawTimer = window.setTimeout(draw, wait)
  } else {
    draw()
  }
}

const subscribeStore = listener => {
  storeListeners.add(listener)

  return () => storeListeners.delete(listener)
}

const getVersion = () => version

function sessionFor(sid, create = true) {
  let entry = sessions.get(sid)

  if (!entry && create) {
    entry = { approval: null, epoch: null, seq: 0, sid, turn: null }
  }

  if (entry) {
    // Most recent last; the oldest goes once there are too many.
    sessions.delete(sid)
    sessions.set(sid, entry)

    while (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value)
    }
  }

  return entry
}

const newTurn = (at, live) => ({
  agents: [],
  dropped: 0,
  endedAt: null,
  id: `t${at}-${Math.random().toString(36).slice(2, 7)}`,
  live,
  open: new Map(), // tool id → index in steps
  partial: false,
  sources: [],
  startedAt: at,
  status: 'running',
  steps: [],
  note: null, // streamed text not yet known to be a note: { buffer, startedAt }
  text: null // the open reasoning step being streamed
})

function pushStep(turn, step) {
  turn.steps = [...turn.steps, step]

  if (turn.steps.length > MAX_STEPS) {
    const cut = turn.steps.length - MAX_STEPS
    const shift = index => (Array.isArray(index) ? index.map(shift).filter(item => item >= 0) : index - cut)

    turn.steps = turn.steps.slice(cut)
    turn.dropped += cut
    turn.open = new Map(
      [...turn.open].map(([key, index]) => [key, shift(index)]).filter(([, index]) => (Array.isArray(index) ? index.length > 0 : index >= 0))
    )
  }

  return turn.steps.length - 1
}

// ── The tool_call bridge ──
// A deferred tool is reached through `tool_call` ({ calls: [{ name,
// arguments }] }). The gateway unwraps a single call it can run, so its
// tool.start / tool.complete carry the inner name; it keeps the name
// `tool_call` for a connector batch (several connectors__ calls), a batch it
// refused, and an inner call it could not validate. Those events carry the
// inner calls in `args.calls` and, one per call, in `labels` ({ app, action,
// kind, name, preview, text }). Each inner call is a step of its own.
// (docs/agent-panel.md, "The bridged path".)
const BRIDGE = 'tool_call'

function innerCalls(payload) {
  const labels = Array.isArray(payload?.labels) ? payload.labels.filter(item => item && typeof item === 'object') : []
  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null
  const list = Array.isArray(args?.calls) ? args.calls : args && typeof args.name === 'string' ? [args] : []
  const count = Math.max(labels.length, list.length)

  return Array.from({ length: count }, (_, index) => {
    const call = list[index] && typeof list[index] === 'object' ? list[index] : {}
    let inner = call.arguments

    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner)
      } catch {
        inner = null
      }
    }

    return {
      args: inner && typeof inner === 'object' ? inner : null,
      label: labels[index] ?? null,
      name: String(labels[index]?.name || call.name || BRIDGE)
    }
  })
}

// What a step is called and what it shows beside that, from the gateway's
// label when there is one: "Parallel · web search" for a service tool,
// "Searching tools" with the query for tool_search.
// A call the model began (tool.generating) that never started: Hermes
// refused it before running it. Through the bridge that is a call whose
// arguments fail the deferred schema check (todo_list with `todos` that is
// not a list): the gateway sends tool.generating and nothing else, and the
// model gets the error as its result (docs/agent-panel.md). It reads as a
// failed step, so the trace does not skip a call the model made. Settled at
// the next step, the next call or the turn's end.
// Several calls can be pending at once: a model that calls tools in parallel
// sends every tool.generating before the first tool.start, so a later call
// says nothing about an earlier one. Each start takes its own call off the
// list (startedCall); only what is still there at the next model step or the
// turn's end was refused.
function refused(turn, when, at) {
  const list = turn?.generating

  if (!list?.length) {
    return false
  }

  turn.generating = []

  for (const pending of list) {
    pushStep(turn, {
      born: at ?? 0,
      detail: 'Its arguments did not pass the check; the model was told',
      endedAt: when,
      key: `refused:${pending.when}:${turn.steps.length}`,
      kind: 'tool',
      label: pending.name === BRIDGE ? 'Call refused' : `${human(pending.name)} refused`,
      name: pending.name,
      startedAt: pending.when,
      state: 'failed'
    })
  }

  return true
}

// tool.generating carries only the name, so a start is matched by name; the
// gateway unwraps a single bridged call, whose start then has the inner name.
function startedCall(turn, name) {
  const list = turn?.generating

  if (!list?.length) {
    return
  }

  let index = list.findIndex(pending => pending.name === name)

  if (index < 0) {
    index = list.findIndex(pending => pending.name === BRIDGE)
  }

  list.splice(index < 0 ? 0 : index, 1)
}

function labelled(name, label, args, context) {
  if (label && typeof label.app === 'string' && label.app) {
    if (label.kind === 'tool' || !label.action) {
      return { detail: clip(label.action || label.preview || argSummary(name, args, context), 120), label: clip(label.app, 60) }
    }

    return { detail: clip(label.preview || argSummary(name, args, context), 120), label: clip(label.text || `${label.app} · ${label.action}`, 60) }
  }

  return { detail: argSummary(name, args, context), label: human(name) }
}

// An inner call's own outcome: a connector batch answers one result per call.
function innerFailed(payload, index) {
  const results = payload?.result && typeof payload.result === 'object' && Array.isArray(payload.result.results) ? payload.result.results : null
  const item = results?.[index]

  if (item && typeof item === 'object') {
    return Boolean(item.error) || item.success === false || item.ok === false
  }

  return failed(payload)
}

const isTodoName = name => /^todo(_list)?$/.test(String(name ?? ''))

// The todo list a tool.complete carries: the todo tool's own, or a bridged
// one whose inner call was the todo tool.
function todosOf(type, payload) {
  if (type === 'todo.updated') {
    return payload
  }

  if (type !== 'tool.complete') {
    return null
  }

  if (isTodoName(payload.name)) {
    return payload
  }

  if (payload.name === BRIDGE && innerCalls(payload).some(call => isTodoName(call.name))) {
    const result = payload.result && typeof payload.result === 'object' ? payload.result : null

    return result && Array.isArray(result.todos) ? result : null
  }

  return null
}

function patchStep(turn, index, patch) {
  if (index < 0 || index >= turn.steps.length) {
    return
  }

  const steps = turn.steps.slice()

  steps[index] = { ...steps[index], ...patch }
  turn.steps = steps
}

function addSources(turn, stepKey, found) {
  if (!found.urls.length && !found.queries.length) {
    return
  }

  const list = turn.sources.slice()
  const known = new Set(list.map(source => source.key))

  for (const url of found.urls) {
    const host = hostOf(url)

    if (host && !known.has(host) && list.length < MAX_SOURCES) {
      known.add(host)
      list.push({ host, key: host, kind: 'site', step: stepKey, url })
    }
  }

  for (const query of found.queries) {
    const key = `q:${query.toLowerCase()}`

    if (!known.has(key) && list.length < MAX_SOURCES) {
      known.add(key)
      list.push({ key, kind: 'query', query, step: stepKey })
    }
  }

  turn.sources = list
}

// A reasoning block ends when anything else happens. Streamed text becomes a
// note only once something follows it (a tool, more reasoning): text that
// ends the turn is the answer, and the answer belongs to the chat.
function closeText(turn, at) {
  if (turn.text !== null) {
    patchStep(turn, turn.text, { endedAt: at, state: 'done' })
    turn.text = null
  }
}

function commitNote(turn, at) {
  const note = turn.note

  turn.note = null

  if (note && note.buffer.trim()) {
    pushStep(turn, {
      born: at ?? 0,
      detail: firstLine(note.buffer),
      endedAt: at,
      key: `note:${turn.steps.length}:${turn.dropped}`,
      kind: 'note',
      label: 'Note',
      name: 'note',
      startedAt: note.startedAt,
      state: 'done'
    })
  }
}

function endTurn(turn, at, status) {
  closeText(turn, at)
  turn.note = null

  turn.steps = turn.steps.map(step => (step.state === 'running' ? { ...step, endedAt: at, state: status === 'failed' ? 'failed' : 'stopped' } : step))
  turn.open = new Map()
  // Sub-agents outlive the turn that started them (a delegation runs in the
  // background and reports when done); only ones gone quiet for long stop.
  turn.agents = turn.agents.map(agent =>
    agent.state === 'running' && at && agent.updatedAt && at - agent.updatedAt > AGENT_STALE_MS
      ? { ...agent, state: 'stopped', steps: (agent.steps ?? []).map(step => (step.state === 'running' ? { ...step, endedAt: at, state: 'stopped' } : step)) }
      : agent
  )
  turn.endedAt = at
  turn.status = status
}

// ── Reducer: one gateway event into the session's state ──
// `at` is when it happened: now for a live event, null for a replayed one
// (the ring keeps no times; replayed steps show tool durations only).
function apply(event, at) {
  const type = event?.type
  const sid = event?.session_id
  const payload = event?.payload ?? {}

  if (!type || !sid || typeof type !== 'string') {
    return false
  }

  if (debug) {
    debug.push({ at, keys: Object.keys(payload).join(','), seq: event.seq ?? null, sid, type, payload: JSON.stringify(payload).slice(0, 400) })

    if (debug.length > 600) {
      debug.splice(0, debug.length - 600)
    }
  }

  const tracked =
    type === 'message.start' ||
    type === 'message.complete' ||
    type === 'message.delta' ||
    type.startsWith('tool.') ||
    type.startsWith('subagent.') ||
    type === 'reasoning.delta' ||
    type === 'status.update' ||
    type === 'agent.step' ||
    type === 'approval.request' ||
    type === 'approval.settled' ||
    type === 'todo.updated' ||
    type === 'error'

  if (!tracked) {
    return false
  }

  const entry = sessionFor(sid)

  if (Number.isFinite(event.seq)) {
    if (event.seq <= entry.seq) {
      return false
    }

    entry.seq = event.seq
  }

  const when = at ?? null
  let turn = entry.turn

  // The plan (Hermes' todo list): a full snapshot after each todo call, from
  // todo.updated or the todo tool's own result. It belongs to the session,
  // not to a turn; a newer revision replaces an older one, and a failed todo
  // call (no snapshot) leaves the last good one standing.
  const todos = todosOf(type, payload)

  if (todos && Array.isArray(todos.todos)) {
    const revision = Number.isFinite(Number(todos.revision)) ? Number(todos.revision) : (entry.todos?.revision ?? 0)

    if (!entry.todos || revision >= entry.todos.revision) {
      const items = todos.todos
        .filter(item => item && typeof item === 'object')
        .slice(0, TODO_MAX)
        .map((item, index) => ({
          content: clip(item.content ?? item.text ?? '', 200),
          id: String(item.id ?? index),
          parent: item.parent ? String(item.parent) : null,
          status: ['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) ? item.status : 'pending'
        }))
      const changed = JSON.stringify(items) !== JSON.stringify(entry.todos?.items ?? null)

      entry.todos = { at: when, items, revision }

      if (type === 'todo.updated') {
        return changed
      }
    } else if (type === 'todo.updated') {
      return false
    }
  }

  if (type === 'message.start') {
    if (turn && turn.status === 'running') {
      endTurn(turn, when ?? turn.startedAt, 'done')
    }

    entry.turn = newTurn(when, at !== null)
    entry.approval = null

    // Sub-agents still at work come along into the new turn, and so do ones
    // that finished after their turn did: their report is what starts this
    // turn. One that ended inside its own turn stays with it.
    const carried = (turn?.agents ?? []).filter(
      agent =>
        agent.state === 'running' ||
        (at && agent.endedAt && turn.endedAt && agent.endedAt >= turn.endedAt && at - agent.endedAt < AGENT_CARRY_MS)
    )

    entry.turn.agents = carried.map(agent => ({ ...agent, born: 0 }))

    return true
  }

  // Work arriving with no turn open (its start was missed): open one.
  if (!turn || (turn.status !== 'running' && type !== 'message.complete' && !type.startsWith('subagent.') && type !== 'approval.settled')) {
    if (type === 'message.delta' || type === 'status.update' || type === 'error' || type === 'agent.step') {
      return false
    }

    entry.turn = newTurn(when, at !== null)
    entry.turn.partial = true
    turn = entry.turn
  }

  switch (type) {
    case 'message.complete': {
      if (!turn || turn.status !== 'running') {
        return false
      }

      const status = payload.status === 'error' || payload.status === 'failed' ? 'failed' : payload.status === 'interrupted' ? 'stopped' : 'done'

      // A turn the owner stopped mid-call: those calls were cut off, not refused.
      if (status === 'stopped') {
        turn.generating = []
      }

      refused(turn, when, at)
      endTurn(turn, when, status)
      entry.approval = null

      return true
    }

    case 'agent.step':
      return refused(turn, when, at)

    case 'tool.generating': {
      closeText(turn, when)
      commitNote(turn, at)
      ;(turn.generating ||= []).push({ name: String(payload.name ?? 'tool'), when })

      return true
    }

    case 'tool.start': {
      startedCall(turn, String(payload.name ?? 'tool'))
      closeText(turn, when)
      commitNote(turn, at)

      const id = String(payload.tool_id ?? payload.tool_call_id ?? payload.id ?? `${turn.steps.length}`)
      const name = String(payload.name ?? 'tool')

      if (turn.open.has(id)) {
        return false
      }

      const inner = name === BRIDGE ? innerCalls(payload) : []

      if (inner.length) {
        // One step per inner call, in the batch's order.
        const indices = inner.map((call, position) => {
          const key = `tool:${id}:${position}`
          const index = pushStep(turn, {
            born: at ?? 0,
            ...labelled(call.name, call.label, call.args, inner.length === 1 ? payload.context : ''),
            endedAt: null,
            key,
            kind: 'tool',
            name: call.name,
            startedAt: when,
            state: 'running'
          })

          addSources(turn, key, sourcesOf(call.name, call.args, null))

          return index
        })

        turn.open.set(id, indices)

        return true
      }

      const key = `tool:${id}`
      const index = pushStep(turn, {
        born: at ?? 0,
        ...labelled(name, Array.isArray(payload.labels) && payload.labels.length === 1 ? payload.labels[0] : null, payload.args, payload.context),
        endedAt: null,
        key,
        kind: 'tool',
        name,
        startedAt: when,
        state: 'running'
      })

      turn.open.set(id, index)
      addSources(turn, key, sourcesOf(name, payload.args, null))

      return true
    }

    case 'tool.complete': {
      const id = String(payload.tool_id ?? payload.tool_call_id ?? payload.id ?? '')
      const name = String(payload.name ?? 'tool')
      let index = turn.open.get(id)

      if (index === undefined && name === BRIDGE && innerCalls(payload).length) {
        // A replay or a late join of a bridged call: its steps, done now.
        const inner = innerCalls(payload)

        index = inner.map((call, position) =>
          pushStep(turn, {
            born: 0,
            ...labelled(call.name, call.label, call.args, ''),
            endedAt: null,
            key: `tool:${id || turn.steps.length}:${position}`,
            kind: 'tool',
            name: call.name,
            startedAt: null,
            state: 'running'
          })
        )
      }

      if (Array.isArray(index)) {
        const inner = innerCalls(payload)
        const results = payload.result && typeof payload.result === 'object' && Array.isArray(payload.result.results) ? payload.result.results : null
        const duration = Number(payload.duration_s)

        turn.open.delete(id)
        index.forEach((stepIndex, position) => {
          const step = turn.steps[stepIndex]

          if (!step) {
            return
          }

          const bad = innerFailed(payload, position)

          patchStep(turn, stepIndex, {
            durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : step.startedAt && when ? when - step.startedAt : null,
            endedAt: when,
            state: bad ? 'failed' : 'done'
          })
          addSources(turn, step.key, sourcesOf(step.name, inner[position]?.args ?? null, bad ? null : (results?.[position] ?? payload.result)))
        })

        if (entry.approval && turn.open.size === 0) {
          entry.approval = null
        }

        return true
      }

      if (index === undefined) {
        // A replay or a late join: the start was not seen.
        index = pushStep(turn, {
          born: 0,
          detail: argSummary(name, payload.args, payload.context),
          endedAt: null,
          key: `tool:${id || turn.steps.length}`,
          kind: 'tool',
          label: human(name),
          name,
          startedAt: null,
          state: 'running'
        })
      }

      turn.open.delete(id)

      const duration = Number(payload.duration_s)
      const step = turn.steps[index]

      const bad = failed(payload)

      patchStep(turn, index, {
        detail: step.detail || argSummary(name, payload.args, payload.context),
        durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : step.startedAt && when ? when - step.startedAt : null,
        endedAt: when,
        state: interrupted(payload) ? 'stopped' : bad ? 'failed' : 'done'
      })
      // A failed search's result is an error message, not sources.
      addSources(turn, step.key, sourcesOf(name, payload.args, bad ? null : payload.result))

      if (entry.approval && turn.open.size === 0) {
        entry.approval = null
      }

      return true
    }

    case 'message.delta': {
      const text = String(payload.text ?? '')

      if (!text) {
        return false
      }

      closeText(turn, when)

      // Only the head is kept: a note shows its first line.
      turn.note ??= { buffer: '', startedAt: when }

      if (turn.note.buffer.length < TEXT_MAX * 2) {
        turn.note.buffer = (turn.note.buffer + text).slice(0, TEXT_MAX * 2)
      }

      return false
    }

    case 'reasoning.delta': {
      const text = String(payload.text ?? '')

      if (!text) {
        return false
      }

      commitNote(turn, at)

      if (turn.text === null) {
        turn.text = pushStep(turn, {
          born: at ?? 0,
          buffer: '',
          detail: '',
          endedAt: null,
          key: `think:${turn.steps.length}:${turn.dropped}`,
          kind: 'think',
          label: 'Thinking',
          name: 'think',
          startedAt: when,
          state: 'running'
        })
      }

      const step = turn.steps[turn.text]

      if (step.buffer.length < TEXT_MAX * 2) {
        const buffer = (step.buffer + text).slice(0, TEXT_MAX * 2)
        const detail = firstLine(buffer)

        patchStep(turn, turn.text, { buffer, detail })

        return detail !== step.detail
      }

      return false
    }

    case 'status.update': {
      const text = clip(payload.text ?? '', 90)

      if (text && turn.status === 'running' && turn.statusLine !== text) {
        turn.statusLine = text

        return true
      }

      return false
    }

    case 'error': {
      endTurn(turn, when, 'failed')

      return true
    }

    case 'approval.request': {
      // Hermes' own prompt, heard as an event: id, command, description, choices.
      const id = payload.request_id ?? payload.prompt_id

      if (!id) {
        return false
      }

      entry.approval = { ...payload, request_id: id }

      return true
    }

    case 'approval.settled': {
      const id = payload.request_id ?? payload.prompt_id

      if (!entry.approval || (id && entry.approval.request_id !== id)) {
        return false
      }

      entry.approval = null

      return true
    }

    default:
      break
  }

  if (type.startsWith('subagent.')) {
    if (type === 'subagent.text') {
      return false
    }

    const id = String(payload.subagent_id ?? payload.child_session_id ?? `${payload.delegation_id ?? ''}#${payload.task_index ?? 0}`)
    const list = turn.agents.slice()
    let index = list.findIndex(agent => agent.id === id)

    if (index < 0) {
      if (list.length >= MAX_AGENTS) {
        return false
      }

      list.push({
        born: at ?? 0,
        goal: clip(payload.goal || payload.text || 'Sub-agent', 120),
        id,
        index: list.length,
        lastTool: '',
        model: '',
        startedAt: when,
        state: 'running',
        tools: 0,
        updatedAt: when
      })
      index = list.length - 1
    }

    const agent = { ...list[index], updatedAt: when ?? list[index].updatedAt }

    if (payload.goal) {
      agent.goal = clip(payload.goal, 120)
    }

    if (payload.model) {
      agent.model = clip(payload.model, 40)
    }

    if (Number.isFinite(payload.tool_count)) {
      agent.tools = payload.tool_count
    }

    // Its own trace: a step per tool it calls. One step ends when the next
    // begins (the events carry no tool completion), the last when it ends.
    const steps = (agent.steps ?? []).slice()
    const closeLast = state => {
      const last = steps[steps.length - 1]

      if (last && last.state === 'running') {
        steps[steps.length - 1] = { ...last, durationMs: last.startedAt && when ? when - last.startedAt : null, endedAt: when, state }
      }
    }

    if (type === 'subagent.tool') {
      agent.lastTool = human(payload.tool_name)
      agent.lastDetail = clip(payload.tool_preview ?? payload.text ?? '', 80)
      agent.tools = Math.max(agent.tools, Number(payload.tool_count) || agent.tools + 1)
      closeLast('done')

      const name = String(payload.tool_name ?? 'tool')

      steps.push({
        born: at ?? 0,
        detail: clip(payload.tool_preview ?? payload.text ?? '', 120),
        endedAt: null,
        key: `sub:${id}:${steps.length + (agent.droppedSteps ?? 0)}`,
        kind: 'tool',
        label: human(name),
        name,
        startedAt: when,
        state: 'running'
      })

      if (steps.length > MAX_AGENT_STEPS) {
        agent.droppedSteps = (agent.droppedSteps ?? 0) + steps.length - MAX_AGENT_STEPS
        steps.splice(0, steps.length - MAX_AGENT_STEPS)
      }
    } else if (type === 'subagent.complete') {
      const status = String(payload.status ?? 'completed')

      agent.state = /fail|error|timeout|cancel|interrupt/i.test(status) ? 'failed' : 'done'
      closeLast(agent.state === 'failed' ? (/cancel|interrupt/i.test(status) ? 'stopped' : 'failed') : 'done')
      agent.endedAt = when
      agent.summary = clip(payload.summary ?? payload.text ?? '', 160)

      if (Number.isFinite(payload.duration_seconds)) {
        agent.durationMs = Math.round(payload.duration_seconds * 1000)
      }
    } else if (type === 'subagent.start' && agent.state !== 'running') {
      agent.state = 'running'
    }

    agent.steps = steps
    list[index] = agent
    turn.agents = list

    return true
  }

  return false
}

// ── Snapshot: the last turn of each session, for a reload ──
function snapshot() {
  snapshotTimer = 0

  try {
    const out = []

    for (const entry of sessions.values()) {
      if (!entry.turn) {
        continue
      }

      const { open, text, ...turn } = entry.turn

      out.push({
        epoch: entry.epoch,
        seq: entry.seq,
        sid: entry.sid,
        todos: entry.todos ?? null,
        turn: { ...turn, steps: turn.steps.slice(-200).map(({ buffer, ...step }) => step), open: [...open], text }
      })
    }

    window.sessionStorage.setItem(SNAP_KEY, JSON.stringify(out))
  } catch {
    // Storage full or off: a reload rebuilds from the gateway's ring instead.
  }
}

const saveSoon = () => {
  snapshotTimer ||= window.setTimeout(snapshot, 1500)
}

function restore() {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(SNAP_KEY) || '[]')

    for (const item of Array.isArray(stored) ? stored : []) {
      if (!item?.sid || !item.turn || !Array.isArray(item.turn.steps)) {
        continue
      }

      const entry = sessionFor(item.sid)
      const turn = { ...newTurn(item.turn.startedAt, false), ...item.turn }

      turn.open = new Map(Array.isArray(item.turn.open) ? item.turn.open : [])
      turn.text = Number.isInteger(item.turn.text) ? item.turn.text : null
      turn.note = null
      turn.steps = turn.steps.map(step => ({ ...step, born: 0, buffer: step.detail ?? '' }))
      turn.agents = (turn.agents ?? []).map(agent => ({ ...agent, born: 0 }))
      turn.live = false
      entry.turn = turn
      entry.seq = Number(item.seq) || 0
      entry.epoch = item.epoch ?? null
      entry.todos = item.todos && Array.isArray(item.todos.items) ? item.todos : null
    }
  } catch {
    // Nothing usable stored.
  }
}

// ── Clock: one tick a second, only while something on screen runs ──
const clockListeners = new Set()
let clockTimer = 0
let clockNow = Date.now()

const subscribeClock = listener => {
  clockListeners.add(listener)

  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = window.setInterval(() => {
      clockNow = Date.now()
      clockListeners.forEach(fn => fn())
    }, 1000)
  }

  return () => {
    clockListeners.delete(listener)

    if (!clockListeners.size) {
      window.clearInterval(clockTimer)
      clockTimer = 0
    }
  }
}

const getClock = () => clockNow
const useClock = () => useSyncExternalStore(subscribeClock, getClock)

const shortDuration = ms => {
  if (!Number.isFinite(ms) || ms < 0) {
    return ''
  }

  if (ms < 1000) {
    return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  }

  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }

  return elapsedLabel(ms / 1000)
}

// ── Components ──
const useStore = () => useSyncExternalStore(subscribeStore, getVersion)

const useFocused = () => {
  const atom = sdk.host?.state?.focusedSessionId

  return useSyncExternalStore(
    listener => (atom?.listen ? atom.listen(listener) : () => undefined),
    () => atom?.get?.() ?? null
  )
}

function Ticker({ from }) {
  const now = useClock()

  return jsx('span', { className: 'mg-agent-time', children: shortDuration(now - from) })
}

function Elapsed({ turn }) {
  if (turn.status === 'running') {
    return turn.startedAt ? jsxs('span', { children: ['Working for ', jsx(WorkingFor, { from: turn.startedAt })] }) : 'Working'
  }

  if (turn.startedAt && turn.endedAt && turn.endedAt > turn.startedAt) {
    return `Worked for ${elapsedLabel((turn.endedAt - turn.startedAt) / 1000)}`
  }

  return turn.status === 'failed' ? 'Stopped on an error' : turn.status === 'stopped' ? 'Stopped' : 'Worked'
}

function WorkingFor({ from }) {
  const now = useClock()

  return elapsedLabel((now - from) / 1000)
}

const fresh = born => born && Date.now() - born < NEW_ROW_MS
// A batch bigger than this arrives without the ease: fifty rows sliding in
// at once is noise, and each moving row is style work for the whole window.
const EASED_BATCH = 8

function Mark({ service, icon }) {
  return service
    ? jsx('span', { 'aria-hidden': true, className: 'mg-agent-svc', 'data-mg-service': service })
    : jsx('i', { 'aria-hidden': true, className: `codicon codicon-${icon}` })
}

const noClock = () => () => undefined
const noTime = () => 0

// One row: four elements (row, icon, text, label); the rail dot and the time
// are the row's own ::before and ::after, so a long list stays light.
const Step = React.memo(function Step({ step, tick, ease }) {
  const live = step.state === 'running' && Boolean(step.startedAt) && tick
  const now = useSyncExternalStore(live ? subscribeClock : noClock, live ? getClock : noTime)
  const service = step.kind === 'tool' ? SHARED.services?.forTool?.(step.name) ?? null : null
  const icon = step.kind === 'think' ? 'lightbulb' : step.kind === 'note' ? 'comment' : iconFor(step.name)
  const time = live ? shortDuration(now - step.startedAt) : step.kind === 'tool' && step.state !== 'running' ? shortDuration(step.durationMs) : ''

  return jsxs('li', {
    className: 'mg-agent-step',
    'data-mg-kind': step.kind,
    'data-mg-new': ease && fresh(step.born) ? '' : undefined,
    'data-state': step.state,
    'data-mg-time': time,
    title: [step.label, step.detail, step.state === 'failed' ? 'failed' : ''].filter(Boolean).join(': '),
    children: [
      jsx(Mark, { icon, service: service?.id ?? null }),
      jsxs('span', {
        className: 'mg-agent-text',
        // The gateway's own label ("Parallel · web search") already names the
        // service; a bare name gives way to the service's.
        children: [jsx('b', { children: step.label?.includes(' · ') ? step.label : (service?.label ?? step.label) }), step.detail]
      })
    ]
  })
})

function Sources({ sources }) {
  const [all, setAll] = useState(false)
  const sites = sources.filter(source => source.kind === 'site')
  const queries = sources.filter(source => source.kind === 'query')

  if (!sites.length && !queries.length) {
    return null
  }

  const LIMIT = 4
  const shown = all ? sites : sites.slice(0, LIMIT)
  const more = sites.length - shown.length

  return jsxs('section', {
    className: 'mg-agent-sources',
    children: [
      jsxs('div', {
        className: 'mg-agent-label',
        children: [
          jsx('i', { 'aria-hidden': true, className: 'codicon codicon-search' }),
          jsx('span', { children: 'Searched' }),
          queries.length ? jsx('span', { className: 'mg-agent-queries', title: queries.map(item => item.query).join('\n'), children: queries.map(item => `“${item.query}”`).join(', ') }) : null
        ]
      }),
      sites.length
        ? jsxs('div', {
            className: 'mg-agent-chips',
            children: [
              ...shown.map(source => {
                const service = SHARED.services?.forUrl?.(source.url) ?? null

                return jsxs(
                  'span',
                  {
                    className: 'mg-agent-chip',
                    'data-mg-known': service ? '' : undefined,
                    title: source.url,
                    children: [
                      // A known site draws its service's mark; any other a neutral globe.
                      service
                        ? jsx('span', { 'aria-hidden': true, className: 'mg-agent-svc', 'data-mg-service': service.id })
                        : jsx('i', { 'aria-hidden': true, className: 'codicon codicon-globe mg-agent-site' }),
                      jsx('span', { children: service?.label ?? source.host })
                    ]
                  },
                  source.key
                )
              }),
              more > 0
                ? jsx('button', { className: 'mg-agent-more', onClick: () => setAll(true), type: 'button', children: `${more} more` }, 'more')
                : all && sites.length > LIMIT
                  ? jsx('button', { className: 'mg-agent-more', onClick: () => setAll(false), type: 'button', children: 'less' }, 'less')
                  : null
            ]
          })
        : null
    ]
  })
}

// Little bots, after the bloub designs: a coloured body, two eye slots.
const BOT_SHAPES = [
  'M0-9C5-9 9-5 9 0S5 9 0 9-9 5-9 0-5-9 0-9Z',
  'M-5-9H5C7.8-9 9-7.8 9-5V5C9 7.8 7.8 9 5 9H-5C-7.8 9-9 7.8-9 5V-5C-9-7.8-7.8-9-5-9Z',
  'M-4.5-9C2-9 9-6 9 0S2 9-4.5 9C-7.5 9-9 6-9 0S-7.5-9-4.5-9Z',
  'M0-9.5L8.2-4.75V4.75L0 9.5-8.2 4.75V-4.75Z',
  'M-9-2C-9-6.5-5-9 0-9S9-6.5 9-2 6 9 0 9-9 2.5-9-2Z',
  'M0-9.5C3.5-5 9-2.5 9 2.5 9 6.5 5 9.5 0 9.5S-9 6.5-9 2.5C-9-2.5-3.5-5 0-9.5Z'
]

const BOT_COLOURS = ['#3b93f0', '#e8483f', '#3ecf8e', '#f08a24', '#2fbfa0', '#8b5cf6', '#f0b429', '#e152b0']

function Bot({ index, state }) {
  return jsx('svg', {
    'aria-hidden': true,
    className: 'mg-agent-bot',
    'data-state': state,
    height: 18,
    viewBox: '-10 -10 20 20',
    width: 18,
    children: jsxs('g', {
      children: [
        jsx('path', { d: BOT_SHAPES[index % BOT_SHAPES.length], fill: BOT_COLOURS[index % BOT_COLOURS.length] }),
        jsx('rect', { className: 'mg-agent-eye', fill: 'var(--mg-canvas)', height: 5, rx: 1.1, width: 2.2, x: -3.6, y: -3 }),
        jsx('rect', { className: 'mg-agent-eye', fill: 'var(--mg-canvas)', height: 5, rx: 1.1, width: 2.2, x: 1.4, y: -3 })
      ]
    })
  })
}

function Agents({ agents, onSelect }) {
  if (!agents.length) {
    return null
  }

  return jsxs('section', {
    className: 'mg-agent-agents',
    children: [
      jsxs('div', {
        className: 'mg-agent-label',
        children: [jsx('i', { 'aria-hidden': true, className: 'codicon codicon-hubot' }), jsx('span', { children: agents.length === 1 ? 'Sub-agent' : `${agents.length} sub-agents` })]
      }),
      jsx('ul', {
        children: agents.map(agent =>
          jsxs(
            'li',
            {
              className: 'mg-agent-sub',
              'data-mg-new': fresh(agent.born) ? '' : undefined,
              'data-state': agent.state,
              title: agent.summary || agent.goal,
              children: jsxs('button', {
                'aria-label': `${agent.goal}: open its steps`,
                className: 'mg-agent-sub-open',
                'data-mg-agent-id': agent.id,
                onClick: () => onSelect?.(agent.id),
                type: 'button',
                children: [
                jsx(Bot, { index: agent.index, state: agent.state }),
                jsxs('span', {
                  className: 'mg-agent-text',
                  children: [
                    jsx('b', { children: agent.goal }),
                    jsx('span', {
                      children:
                        agent.state === 'running'
                          ? agent.lastTool
                            ? `${agent.lastTool}${agent.lastDetail ? `: ${agent.lastDetail}` : ''}`
                            : 'Working'
                          : [agent.state === 'failed' ? 'Failed' : agent.state === 'stopped' ? 'Stopped' : 'Done', agent.tools ? `${agent.tools} tool ${agent.tools === 1 ? 'call' : 'calls'}` : '']
                              .filter(Boolean)
                              .join(' · ')
                    })
                  ]
                }),
                agent.state === 'running' && agent.startedAt
                  ? jsx(Ticker, { from: agent.startedAt })
                  : jsx('span', { className: 'mg-agent-time', children: shortDuration(agent.durationMs) }),
                jsx('i', { 'aria-hidden': true, className: 'codicon codicon-chevron-right mg-agent-sub-go' })
              ]
              })
            },
            agent.id
          )
        )
      })
    ]
  })
}

const CHOICE_LABELS = { deny: 'Deny', once: 'Allow' }
// Hermes' own card's buttons for the same answers.
const HERMES_BUTTONS = { deny: '[data-approval-deny]', once: '[data-approval-run]' }

function Approval({ entry }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const approval = entry.approval

  if (!approval) {
    return null
  }

  const choices = Array.isArray(approval.choices) && approval.choices.length ? approval.choices : ['once', 'deny']
  // Deny and Allow, as Hermes offers them; "for this session" and "always"
  // stay in Hermes' own card, behind its menu.
  const order = ['deny', 'once'].filter(choice => choices.includes(choice))

  const answer = choice => {
    setBusy(choice)
    setError('')

    // When Hermes' own card for this request is on screen, press its button:
    // the answer then takes Hermes' own path and its card leaves with it. (An
    // answer sent around it leaves that card standing in the chat.)
    const id = String(approval.request_id ?? '')
    const own = id
      ? [...document.querySelectorAll('[data-slot="tool-approval-card"]')].find(card => card.getAttribute('data-request-id') === id)
      : null
    const button = own?.querySelector(HERMES_BUTTONS[choice])

    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.click()
      window.setTimeout(() => setBusy(null), 600)

      return
    }

    sdk.host
      .request(
        'approval.respond',
        { choice, request_id: approval.request_id, session_id: entry.sid },
        sdk.APPROVAL_RESPOND_TIMEOUT_MS
      )
      .then(() => {
        if (entry.approval?.request_id === approval.request_id) {
          entry.approval = null
          notify()
        }
      })
      .catch(reason => setError(clip(reason?.message ?? 'Could not answer', 80)))
      .finally(() => setBusy(null))
  }

  return jsxs('section', {
    className: 'mg-agent-approval',
    'data-mg-approval-card': approval.request_id ?? '',
    children: [
      jsxs('div', {
        className: 'mg-agent-approval-head',
        children: [jsx('i', { 'aria-hidden': true, className: 'codicon codicon-shield' }), jsx('b', { children: 'Waiting for approval' })]
      }),
      approval.description ? jsx('p', { children: clip(approval.description, 200) }) : null,
      approval.command ? jsx('pre', { children: String(approval.command).slice(0, 600) }) : null,
      error ? jsx('p', { className: 'mg-agent-error', children: error }) : null,
      jsx('div', {
        className: 'mg-agent-actions',
        children: order.map(choice =>
          jsx(
            'button',
            {
              className: 'mg-agent-button',
              'data-mg-choice': choice,
              'data-mg-primary': choice === 'once' ? '' : undefined,
              disabled: Boolean(busy),
              onClick: () => answer(choice),
              type: 'button',
              children: busy === choice ? '…' : CHOICE_LABELS[choice]
            },
            choice
          )
        )
      })
    ]
  })
}

function Steps({ turn }) {
  const [all, setAll] = useState(false)
  const steps = turn.steps
  const hidden = all ? 0 : Math.max(0, steps.length - SHOWN_STEPS)
  const earlier = hidden + turn.dropped
  const shown = steps.slice(hidden)
  const ease = shown.filter(step => fresh(step.born)).length <= EASED_BATCH

  return jsxs('ol', {
    className: 'mg-agent-steps',
    children: [
      earlier
        ? jsx(
            'li',
            {
              className: 'mg-agent-earlier',
              children: hidden
                ? jsx('button', { onClick: () => setAll(true), type: 'button', children: `${earlier} earlier ${earlier === 1 ? 'step' : 'steps'}` })
                : `${earlier} earlier ${earlier === 1 ? 'step' : 'steps'} not kept`
            },
            'earlier'
          )
        : null,
      ...shown.map((step, index) => jsx(Step, { ease, step, tick: index >= shown.length - TICKING }, step.key))
    ]
  })
}

// Not keyed by turn: a new turn (a sub-agent's report wakes one) must not
// re-create the rows and take the focus from the one a reader is on. The
// fold belongs to the turn it was folded in.
function Trace({ entry, onSelect }) {
  const turn = entry.turn
  const [fold, setFold] = useState(null)
  const folded = fold === turn.id
  const setFolded = toggle => setFold(current => (toggle(current === turn.id) ? turn.id : null))
  const tools = turn.steps.filter(step => step.kind === 'tool').length + turn.dropped

  return jsxs('div', {
    className: 'mg-agent-trace',
    'data-mg-status': turn.status,
    'data-mg-turn': turn.id,
    children: [
      jsxs('button', {
        'aria-expanded': !folded,
        className: 'mg-agent-head',
        onClick: () => setFolded(value => !value),
        type: 'button',
        children: [
          jsx('i', { 'aria-hidden': true, className: 'codicon codicon-chevron-down' }),
          jsx('span', { className: 'mg-agent-elapsed', children: jsx(Elapsed, { turn }) }),
          tools ? jsx('span', { className: 'mg-agent-count', children: `${tools} ${tools === 1 ? 'step' : 'steps'}` }) : null
        ]
      }),
      turn.status === 'running' && turn.statusLine ? jsx('div', { className: 'mg-agent-status', children: turn.statusLine }) : null,
      folded
        ? null
        : jsxs(React.Fragment, {
            children: [
              jsx(Sources, { sources: turn.sources }, `sources:${turn.id}`),
              turn.steps.length ? jsx(Steps, { turn }, `steps:${turn.id}`) : turn.status === 'running' ? jsx('p', { className: 'mg-agent-empty', children: 'Waiting for the first step.' }) : null,
              jsx(Agents, { agents: turn.agents, onSelect }),
              turn.partial ? jsx('p', { className: 'mg-agent-note', children: 'Joined after the turn began; earlier steps are not shown.' }) : null
            ]
          })
    ]
  })
}

// ── The plan: Hermes' todo list, as a card ──
// One row per item, in the agent's order: pending, in progress, done,
// cancelled. When the turn that was working on it stopped or failed, the item
// in progress reads as stopped. A long list shows the rows around the one in
// progress, with the rest one press away.
const TODO_WORDS = { cancelled: 'Cancelled', completed: 'Done', in_progress: 'In progress', pending: 'To do', stopped: 'Stopped' }

function TodoCard({ entry }) {
  const [all, setAll] = useState(false)
  const [folded, setFolded] = useState(false)
  const items = entry.todos?.items ?? []

  if (!items.length) {
    return null
  }

  const halted = entry.turn && entry.turn.status !== 'running' && (entry.turn.status === 'stopped' || entry.turn.status === 'failed')
  const done = items.filter(item => item.status === 'completed').length
  const open = items.filter(item => item.status === 'pending' || item.status === 'in_progress').length
  const active = items.findIndex(item => item.status === 'in_progress')
  let from = 0
  let to = items.length

  if (!all && items.length > TODO_SHOWN) {
    from = Math.max(0, Math.min((active >= 0 ? active : items.findIndex(item => item.status === 'pending')) - 3, items.length - TODO_SHOWN))
    from = Math.max(0, from)
    to = from + TODO_SHOWN
  }

  const shown = items.slice(from, to)
  const status = item => (item.status === 'in_progress' && halted ? 'stopped' : item.status)

  return jsxs('section', {
    'aria-label': 'Plan',
    className: 'mg-agent-todo',
    'data-mg-todo-revision': String(entry.todos.revision),
    children: [
      jsxs('button', {
        'aria-expanded': !folded,
        className: 'mg-agent-todo-head',
        onClick: () => setFolded(value => !value),
        type: 'button',
        children: [
          jsx('i', { 'aria-hidden': true, className: 'codicon codicon-checklist' }),
          jsx('b', { children: 'Plan' }),
          jsx('span', { className: 'mg-agent-count', children: `${done} of ${items.length} done${halted && open ? ' · stopped' : ''}` }),
          jsx('i', { 'aria-hidden': true, className: 'codicon codicon-chevron-down mg-agent-todo-fold' })
        ]
      }),
      folded
        ? null
        : jsxs('ol', {
            className: 'mg-agent-todo-list',
            children: [
              from > 0
                ? jsx('li', { className: 'mg-agent-earlier', children: jsx('button', { onClick: () => setAll(true), type: 'button', children: `${from} earlier` }) }, 'earlier')
                : null,
              ...shown.map(item =>
                jsxs(
                  'li',
                  {
                    className: 'mg-agent-todo-item',
                    'data-mg-depth': item.parent ? '1' : undefined,
                    'data-state': status(item),
                    title: `${TODO_WORDS[status(item)]}: ${item.content}`,
                    children: [jsx('span', { 'aria-hidden': true, className: 'mg-agent-todo-mark' }), jsx('span', { className: 'mg-agent-todo-text', children: item.content }), jsx('span', { className: 'mg-sr', children: ` (${TODO_WORDS[status(item)]})` })]
                  },
                  item.id
                )
              ),
              to < items.length
                ? jsx('li', { className: 'mg-agent-earlier', children: jsx('button', { onClick: () => setAll(true), type: 'button', children: `${items.length - to} more` }) }, 'more')
                : all && items.length > TODO_SHOWN
                  ? jsx('li', { className: 'mg-agent-earlier', children: jsx('button', { onClick: () => setAll(false), type: 'button', children: 'Show fewer' }) }, 'fewer')
                  : null
            ]
          })
    ]
  })
}

// ── One sub-agent's own trace ──
// Chosen from its row; its own steps (the tools it called, from its
// subagent.tool events), its state and what it reported. Back returns to the
// turn's trace.
function AgentTrace({ agent, onBack }) {
  const [all, setAll] = useState(false)
  const steps = agent.steps ?? []
  const hidden = all ? 0 : Math.max(0, steps.length - SHOWN_STEPS)
  const earlier = hidden + (agent.droppedSteps ?? 0)
  const shown = steps.slice(hidden)
  const ease = shown.filter(step => fresh(step.born)).length <= EASED_BATCH
  const back = React.useRef(null)

  // Opened from a row further down: the sub-trace starts at its top, with
  // Back in view and focused (a Back scrolled out of view cannot be pressed).
  useEffect(() => {
    back.current?.closest('.mg-agent-scroll')?.scrollTo({ top: 0 })
    back.current?.focus({ preventScroll: true })
  }, [agent.id])

  return jsxs('div', {
    className: 'mg-agent-trace mg-agent-subtrace',
    'data-mg-agent-id': agent.id,
    'data-mg-status': agent.state,
    onKeyDown: event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onBack()
      }
    },
    children: [
      jsxs('button', {
        className: 'mg-agent-back',
        onClick: onBack,
        ref: back,
        type: 'button',
        children: [jsx('i', { 'aria-hidden': true, className: 'codicon codicon-arrow-left' }), jsx('span', { children: 'All steps' })]
      }),
      jsxs('div', {
        className: 'mg-agent-subhead',
        children: [
          jsx(Bot, { index: agent.index, state: agent.state }),
          jsxs('span', {
            className: 'mg-agent-text',
            children: [
              jsx('b', { children: agent.goal }),
              jsx('span', {
                children: [
                  agent.state === 'running' ? 'Working' : agent.state === 'failed' ? 'Failed' : agent.state === 'stopped' ? 'Stopped' : 'Done',
                  agent.model ? agent.model : '',
                  agent.tools ? `${agent.tools} tool ${agent.tools === 1 ? 'call' : 'calls'}` : ''
                ]
                  .filter(Boolean)
                  .join(' · ')
              })
            ]
          }),
          agent.state === 'running' && agent.startedAt ? jsx(Ticker, { from: agent.startedAt }) : jsx('span', { className: 'mg-agent-time', children: shortDuration(agent.durationMs) })
        ]
      }),
      steps.length
        ? jsxs('ol', {
            className: 'mg-agent-steps',
            children: [
              earlier
                ? jsx(
                    'li',
                    {
                      className: 'mg-agent-earlier',
                      children: hidden
                        ? jsx('button', { onClick: () => setAll(true), type: 'button', children: `${earlier} earlier ${earlier === 1 ? 'step' : 'steps'}` })
                        : `${earlier} earlier ${earlier === 1 ? 'step' : 'steps'} not kept`
                    },
                    'earlier'
                  )
                : null,
              ...shown.map((step, index) => jsx(Step, { ease, step, tick: index >= shown.length - TICKING }, step.key))
            ]
          })
        : jsx('p', { className: 'mg-agent-empty', children: agent.state === 'running' ? 'Waiting for its first step.' : 'It called no tools.' }),
      agent.summary ? jsx('p', { className: 'mg-agent-summary', children: agent.summary }) : null
    ]
  })
}

function AgentPane({ close }) {
  useStore()

  const focused = useFocused()
  const entry = focused ? sessions.get(focused) : null
  const scroller = React.useRef(null)
  const turnId = entry?.turn?.id ?? null
  const [chosen, setChosen] = useState(null)
  const agent = chosen && entry?.turn ? (entry.turn.agents.find(item => item.id === chosen.id && chosen.sid === focused) ?? null) : null

  // Another session, or the sub-agent gone from the turn: back to the trace.
  useEffect(() => {
    if (chosen && !agent) {
      setChosen(null)
    }
  }, [chosen, agent])

  // Back (a click or Escape) returns focus to the row the sub-trace was
  // opened from, once the trace is drawn again.
  const returnTo = React.useRef(null)

  useEffect(() => {
    const id = returnTo.current

    if (agent || !id) {
      return undefined
    }

    returnTo.current = null

    const find = () => scroller.current?.querySelector(`.mg-agent-sub-open[data-mg-agent-id="${window.CSS.escape(id)}"]`)
    const row = find()

    if (row) {
      row.focus({ preventScroll: false })

      return undefined
    }

    const frame = window.requestAnimationFrame(() => find()?.focus({ preventScroll: false }))

    return () => window.cancelAnimationFrame(frame)
  }, [agent])

  // A new turn, or another session, starts at its newest step. After that
  // the list follows new steps through CSS scroll anchoring (the anchor at
  // the end of the list), never by measuring: a read of scrollHeight per
  // update forces a layout of the whole window, chat included.
  // (Not while a sub-agent's own trace is open: that one starts at its top.)
  const reading = Boolean(agent)

  useEffect(() => {
    const node = scroller.current
    const frame = node && !reading ? window.requestAnimationFrame(() => node.scrollTo({ top: node.scrollHeight })) : 0

    return () => window.cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnId, focused])

  return jsxs('div', {
    className: 'mg-agent',
    'data-mg-agent-session': focused ?? '',
    children: [
      jsxs('header', {
        className: 'mg-agent-bar',
        children: [
          jsx('i', { 'aria-hidden': true, className: 'codicon codicon-pulse' }),
          jsx('span', { children: 'Agent' }),
          jsx('button', { 'aria-label': 'Close agent panel', className: 'mg-agent-close', onClick: close, title: 'Close', type: 'button', children: jsx('i', { 'aria-hidden': true, className: 'codicon codicon-close' }) })
        ]
      }),
      jsxs('div', {
        className: 'mg-agent-scroll',
        ref: scroller,
        children: [
          agent
            ? jsx(AgentTrace, {
                agent,
                onBack: () => {
                  returnTo.current = agent.id
                  setChosen(null)
                }
              }, agent.id)
            : entry?.turn
              ? jsxs(React.Fragment, {
                  children: [
                    jsx(Trace, { entry, onSelect: id => setChosen({ id, sid: focused }) }, 'trace'),
                    jsx(TodoCard, { entry }),
                    jsx(Approval, { entry }, entry.approval?.request_id ?? 'none')
                  ]
                })
              : entry?.todos?.items?.length
                ? jsx(TodoCard, { entry })
                : jsx('p', { className: 'mg-agent-empty', children: focused ? 'No steps seen for this session in this window yet. They appear here while the agent works.' : 'Open a session to see its steps.' }),
          jsx('div', { 'aria-hidden': true, className: 'mg-agent-anchor' })
        ]
      })
    ]
  })
}

MODULES.push({
  id: 'agent-panel',
  start(ctx) {
    let stopped = false
    let unregister = null
    let open = false
    const timers = new Set()
    const later = (fn, ms) => {
      const id = window.setTimeout(() => {
        timers.delete(id)

        if (!stopped) {
          fn()
        }
      }, ms)

      timers.add(id)

      return id
    }

    if (window.localStorage?.getItem('hermes.plugin.monograph.agentDebug') === '1') {
      debug = window.__mgAgentEvents = window.__mgAgentEvents ?? []
    }

    restore()

    const visible = () => (typeof sdk.host?.paneVisibility === 'function' ? Boolean(sdk.host.paneVisibility(PANE_ID).get()) : Boolean(unregister))

    const mount = () => {
      if (unregister) {
        return
      }

      const handle = ctx.register({
        area: 'panes',
        // Uncloseable: Hermes' closeTreePane switches a plugin with a single
        // pane OFF when that pane's tab is closed (store.ts). The pane closes
        // from its own button and the surfaces row instead.
        data: { placement: 'right', uncloseable: true, width: '340px' },
        id: PANE,
        render: () => jsx(AgentPane, { close: () => setOpen(false) }),
        title: 'Agent'
      })

      unregister = typeof handle === 'function' ? handle : () => undefined
    }

    const unmount = () => {
      if (unregister) {
        try {
          unregister()
        } catch {
          // Already gone with the plugin.
        }

        unregister = null
      }
    }

    // When opening needed a reveal, Hermes un-collapsed the whole right
    // column for it (Advanced mode keeps it collapsed, with Terminal parked
    // in it). Closing the pane would leave that column standing, narrowing the
    // chat. So the chat's width before the reveal is kept, and on close the
    // column is folded again with Hermes' own action, once, and only if it is
    // still narrower than it was.
    let revealed = null

    const chatWidth = () => {
      const node = [...document.querySelectorAll('[data-chat-surface]')].find(item => item.getBoundingClientRect().width > 0 && !item.closest('[inert], [aria-hidden="true"]'))

      return node ? Math.round(node.getBoundingClientRect().width) : 0
    }

    const refold = () => {
      const before = revealed

      revealed = null

      if (!before || !before.width) {
        return
      }

      later(() => {
        const allowed = new Set((ctx.listActions?.() ?? []).map(action => action.id))
        const atClose = chatWidth()

        // A reveal is only needed when the right column was collapsed, so
        // that is how it was found: collapse it again. Not when something
        // the person opened meanwhile now fills it (the chat is more than a
        // rail's width narrower than before): that stays.
        if (!allowed.has('view.toggleRightSidebar') || atClose < before.width - 40) {
          debug?.push({ type: 'refold-skipped', at: Date.now(), before: before.width, now: atClose })

          return
        }

        // Hermes' ⌘J on a split right column (store/layout.ts toggleRightSide
        // -> toggleFileBrowserOpen) opens the column on the first press and
        // collapses it on the second, whatever was open. Both in one task, so
        // nothing is drawn in between.
        debug?.push({ type: 'refold', at: Date.now(), before: before.width, now: atClose })
        ctx.runAction?.('view.toggleRightSidebar')
        ctx.runAction?.('view.toggleRightSidebar')

        // Never leave it worse than it was: a tree where the second press
        // does not collapse (a single right zone minimizes to a rail instead)
        // is put back the way the close left it.
        later(() => {
          const now = chatWidth()

          if (now < atClose - 8) {
            debug?.push({ type: 'refold-undone', at: Date.now(), now })
            ctx.runAction?.('view.toggleRightSidebar')
          }
        }, 300)
      }, 120)
    }

    function setOpen(next) {
      open = next
      ctx.storage?.set?.(OPEN_KEY, next)
      document.documentElement.toggleAttribute('data-mg-agent-open', next)

      if (!next) {
        unmount()
        refold()

        return
      }

      const widthBefore = chatWidth()

      mount()
      sdk.host?.undismissPane?.(PANE_ID)
      // Only force a reveal if adoption alone did not put it on screen: a
      // reveal un-collapses the whole right column and brings back every pane
      // dismissed there (in Advanced mode, Terminal), which stays after ours
      // closes. Adoption can take a few frames, so wait before forcing.
      later(() => {
        if (open && !visible()) {
          debug?.push({ type: 'reveal', at: Date.now() })
          revealed = { width: widthBefore }
          sdk.host?.revealPane?.(PANE_ID)
        }
      }, 400)
      hydrate(sdk.host?.state?.focusedSessionId?.get?.())
    }

    const toggle = () => {
      if (open && visible()) {
        setOpen(false)

        return
      }

      // Registered but not on screen (closed with the pane's own close, its
      // column collapsed, the sides swapped): register it afresh so Hermes
      // places and shows it again.
      if (unregister) {
        unmount()
      }

      setOpen(true)
    }

    // Monograph's rows read Home, Knowledge, Agent (each module inserts by rank).
    const row = { icon: 'pulse', key: 'agent', label: 'Agent', letter: 'p', rank: 2, run: toggle }

    if (SHARED.surfaces) {
      const after = SHARED.surfaces.findIndex(other => (other?.rank ?? 9) > row.rank)

      SHARED.surfaces.splice(after < 0 ? SHARED.surfaces.length : after, 0, row)
    }

    // ── Events ──
    const stopEvents = ctx.onEvent?.('*', event => {
      if (apply(event, Date.now())) {
        notify()
        saveSoon()
      }
    })

    // ── Replay: fill what this window did not hear (a reload, a hot reload,
    // a session opened mid-turn) from the gateway's per-session ring.
    const hydrating = new Set()

    function hydrate(sid) {
      if (!sid || hydrating.has(sid) || typeof sdk.host?.request !== 'function') {
        return
      }

      hydrating.add(sid)

      const entry = sessionFor(sid)

      sdk.host
        .request('session.events.since', { last_seen: entry.seq || 0, session_id: sid })
        .then(result => {
          debug?.push({ count: result?.count ?? null, keys: Object.keys(result ?? {}).join(','), latest: result?.latest_seq ?? null, sid, truncated: result?.truncated ?? null, type: 'hydrate' })

          if (stopped || !result) {
            return
          }

          if (result.epoch && entry.epoch && result.epoch !== entry.epoch) {
            // The gateway restarted: its numbering began again.
            entry.seq = 0
          }

          entry.epoch = result.epoch ?? entry.epoch

          const events = Array.isArray(result.events) ? result.events : []
          // Only the newest turn: from its message.start on, if the ring has it.
          let from = -1

          for (let index = events.length - 1; index >= 0; index -= 1) {
            if (events[index]?.type === 'message.start') {
              from = index
              break
            }
          }

          const slice = from >= 0 ? events.slice(from) : entry.turn ? events : []
          let changed = false

          for (const event of slice) {
            changed = apply({ ...event, session_id: event.session_id ?? sid }, null) || changed
          }

          if (from < 0 && result.truncated && entry.turn && entry.turn.status === 'running') {
            entry.turn.partial = true
          }

          for (const request of Array.isArray(result.open_requests) ? result.open_requests : []) {
            const params = request?.params ?? request

            if ((request?.method ?? params?.method) === 'approval' && params?.request_id) {
              entry.approval = { ...params }
              changed = true
            }
          }

          if (changed) {
            notify()
            saveSoon()
          }
        })
        .catch(error => debug?.push({ error: String(error?.message ?? error).slice(0, 200), sid, type: 'hydrate' }))
        .finally(() => hydrating.delete(sid))
    }

    const focusAtom = sdk.host?.state?.focusedSessionId
    const stopFocus = focusAtom?.listen?.(sid => {
      notify()

      if (open && sid) {
        hydrate(sid)
      }
    })

    if (ctx.storage?.get?.(OPEN_KEY, false) === true) {
      setOpen(true)
    }

    return () => {
      stopped = true
      timers.forEach(id => window.clearTimeout(id))
      timers.clear()

      if (typeof stopEvents === 'function') {
        stopEvents()
      }

      stopFocus?.()
      unmount()

      const at = SHARED.surfaces?.indexOf(row) ?? -1

      if (at >= 0) {
        SHARED.surfaces.splice(at, 1)
      }

      if (snapshotTimer) {
        window.clearTimeout(snapshotTimer)
        snapshot()
      }

      window.cancelAnimationFrame(queued)
      window.clearTimeout(drawTimer)
      queued = 0
      drawTimer = 0
      sinceDraw = 0
      bursting = false
      document.documentElement.removeAttribute('data-mg-agent-open')
      storeListeners.clear()
      sessions.clear()
      debug = null
    }
  }
})
