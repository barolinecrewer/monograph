// Stability: the chat stays still. A long thread, a turn with many tool calls
// and reasoning, a queued prompt behind a running turn, a session switch in the
// middle of a turn, and turn ends while pinned to the bottom and while scrolled
// up. Everything is measured in the page, frame by frame: scroll position, the
// on-screen position of what is being read, layout shifts, long animation
// frames with the scripts behind them, animation starts per element, and the
// history of the fold attributes on every reply row.
//
// The model is a server of this suite's own (the mock in tests-js cannot send
// reasoning). Prompts carry tokens it reads:
//   ID=x            the answer ends on "Done x." (what `finished` waits for)
//   MGS_LONG        a long answer: paragraphs, a list, a code block
//   MGS_WORK(n,s)   n steps, each a note and one terminal call (`sleep s`),
//                   then the answer
//   MGS_THINK       reasoning is streamed before each step and the answer
//   MGS_HOLD        the stream stops after its first word until the rig lets go
//   MGS_SLOWANSWER  the answer streams slowly (three words per 70ms)
import http from 'node:http'

import { RUNNING, VIEWPORT, check as harnessCheck, finished, results, shot, sleep, state, type, waitForAppReady, within } from '../harness.mjs'

// MGS_ONLY=s15 runs only those checks (the rest report "not run"): for
// repeating one check quickly.
const ONLY = process.env.MGS_ONLY ? process.env.MGS_ONLY.split(',') : null
const check = (id, body) => (!ONLY || ONLY.includes(id) ? harnessCheck(id, body) : undefined)

export const checks = [
  ['s1', 'Long thread: 60 turns build without long tasks from Monograph'],
  ['s2', 'Pinned turn end: many tool calls and reasoning, the bottom stays put through the fold'],
  ['s3', 'Reasoning: drawn while it streams, reachable after the turn, tool rows shown'],
  ['s4', 'Scrolled-up turn end: what is being read does not move'],
  ['s5', 'Queued prompt: the running reply is never dressed as finished, no fold flapping'],
  ['s6', 'Session switch mid-turn and back: every prompt and reply drawn once'],
  ['s7', 'Animations: nothing replays; nothing of ours moves with motion off or reduced'],
  ['s8', 'Compaction note: one quiet line that opens on click'],
  ['s9', 'Monograph observers: run counts and time per run'],
  ['s10', 'Model pill: marked in any language, slider colour from the pill beside the open effort menu'],
  ['s11', '"Worked for" counts every tool call of a run, live and after a reload'],
  ['s12', '"Worked for" line by keyboard: a button with its state, Enter and Space toggle it, a visible grayscale ring'],
  ['s13', 'Opened work: run headers readable (4.5:1 on the canvas), every row on the same rhythm'],
  ['s14', 'Reasoning drawn while it streams in a later turn of the same session and after a session switch'],
  ['s15', 'A sign of life: from 300 ms after a prompt until its first words or tool row, something on screen says the model is working'],
  ['s16', 'Thinking setting: "live" shows reasoning and its fold moves neither the answer nor the bottom; "line" shows no reasoning while it runs, only the status row, and it unfolds afterwards']
]

export const config = 'display:\n  show_reasoning: true\n'

const REASONING_NEEDLE = 'MGS_REASONING_TRACE'
// The long thread's length. MG_STAB_TURNS=8 makes a quick diagnostic run;
// the verdict for the report is the default, 60.
const TURNS = Number(process.env.MG_STAB_TURNS) || 60

// ── The suite's own model server ────────────────────────────────────────────
const words = text => text.split(/(?<= )/)

const LONG = id =>
  [
    `## Notes on turn ${id}`,
    '',
    'This answer is long on purpose, so that the thread grows the way a real one does. It holds a few paragraphs, a list and a short code block, which are the blocks a reply is made of.',
    '',
    '- The first point is about layout, and how a column of text keeps its measure.',
    '- The second point is about scrolling, and why a page should not move under the reader.',
    '- The third point is about time, and how long the work took.',
    '',
    '```js',
    `const turn = ${JSON.stringify(id)}`,
    'console.log(turn)',
    '```',
    '',
    'A closing paragraph follows the code, so that the answer does not end on a block that is drawn differently from prose. It is written in plain words and says nothing of interest.',
    '',
    `Done ${id}.`
  ].join('\n')

const REASONING = step =>
  `${REASONING_NEEDLE} step ${step}: I look at what the user asked, weigh two ways to do it, and pick the one that changes less. The first way rewrites the module; the second only moves one call. I take the second, then check the result before answering. `.repeat(2)

export async function model() {
  const receivedPrompts = []
  const log = []
  // One hold at a time; after a release the next MGS_HOLD holds again.
  let releaseHeld = null
  let heldStarted = null
  let heldPromise = null
  let released = null
  const arm = () => {
    heldPromise = new Promise(resolve => (heldStarted = resolve))
    released = new Promise(resolve => (releaseHeld = resolve))
  }

  arm()

  const chunk = (res, delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id: 'mgs', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)

  // pieces: [{ reasoning } | { content } | { hold }], then optional tool call.
  const stream = async (res, pieces, tool, ms) => {
    res.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' })
    chunk(res, { role: 'assistant' })

    for (const piece of pieces) {
      if (piece.pause) {
        await sleep(piece.pause)
        continue
      }

      if (piece.hold) {
        const wait = released

        heldStarted()
        await wait
        continue
      }

      const key = piece.reasoning !== undefined ? 'reasoning_content' : 'content'
      const parts = words(piece.reasoning ?? piece.content)

      for (let index = 0; index < parts.length; index += 3) {
        chunk(res, { [key]: parts.slice(index, index + 3).join('') })
        await sleep(piece.ms ?? ms)
      }
    }

    if (tool) {
      chunk(res, { tool_calls: [{ function: { arguments: JSON.stringify(tool.args), name: tool.name }, id: tool.id, index: 0, type: 'function' }] }, 'tool_calls')
    } else {
      chunk(res, {}, 'stop')
    }

    res.write('data: [DONE]\n\n')
    res.end()
  }

  const textOf = message =>
    typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n')
        : ''

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ created: 0, id: 'mock-model', object: 'model', owned_by: 'mock' }], object: 'list' }))

      return
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')

      return
    }

    let body = ''

    req.on('data', part => (body += part))
    req.on('end', async () => {
      let parsed = {}

      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = {}
      }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const lastUser = messages.map((message, index) => [message, index]).filter(([message]) => message?.role === 'user').at(-1)
      const prompt = textOf(lastUser?.[0])
      const done = lastUser ? messages.slice(lastUser[1] + 1).filter(message => message?.role === 'tool').length : 0
      const id = /ID=(\w+)/.exec(prompt)?.[1] ?? 'x'

      receivedPrompts.push(prompt)

      if (parsed.stream !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', index: 0, message: { content: 'A title', role: 'assistant' } }], created: 0, id: 'mgs', model: 'mock-model', object: 'chat.completion' }))

        return
      }

      const think = prompt.includes('MGS_THINK')
      const work = /MGS_WORK\((\d+),([\d.]+)\)/.exec(prompt)
      const steps = work ? Number(work[1]) : 0
      const fast = prompt.includes('MGS_SLOWANSWER') ? 70 : prompt.includes('MGS_LONG') ? 4 : 18
      const pieces = []

      log.push({ at: Date.now(), done, id, kind: 'start' })

      // MGS_DELAY(ms): the model takes this long before its first token.
      const delay = /MGS_DELAY\((\d+)\)/.exec(prompt)

      if (delay && done === 0) {
        await new Promise(resolve => setTimeout(resolve, Number(delay[1])))
      }

      if (prompt.includes('MGS_HOLD') && done === 0) {
        pieces.push({ content: 'Held ' }, { hold: true }, { content: `reply for ${id}, released by the rig. Done ${id}.` })
        stream(res, pieces, null, 20).then(() => log.push({ at: Date.now(), id, kind: 'end' }))

        return
      }

      // MGS_RUN(n,k): n terminal calls and then k connector calls, one per
      // completion and no words between them, so Hermes draws them as one or
      // two runs ("Ran 7 commands"); then the answer. n + k calls in all.
      const run = /MGS_RUN\((\d+),(\d+)\)/.exec(prompt)

      if (run) {
        const [commands, connectors] = [Number(run[1]), Number(run[2])]
        const services = ['mcp__parallel__web_search', 'mcp__apify__call_actor', 'mcp__notion__search', 'mcp__github__list_issues']

        if (done < commands + connectors) {
          const tool =
            done < commands
              ? { args: { command: `echo run-${id}-${done + 1}` }, name: 'terminal' }
              : { args: { arguments: { query: `run ${id} ${done + 1}` }, name: services[(done - commands) % services.length] }, name: 'tool_call' }

          stream(res, [], { ...tool, id: `call_${id}_${done}` }, 18).then(() => log.push({ at: Date.now(), id, kind: 'tool' }))
        } else {
          stream(res, [{ content: `The run is over, ${commands + connectors} calls. Done ${id}.` }], null, 18).then(() => log.push({ at: Date.now(), id, kind: 'end' }))
        }

        return
      }

      if (done < steps) {
        if (think) {
          pieces.push({ ms: 45, reasoning: REASONING(done + 1) })
        }

        pieces.push({ content: `Step ${done + 1} of ${steps}: looking at the next part of the task before the call.` })
        stream(res, pieces, { args: { command: `sleep ${work[2]}; echo step-${id}-${done + 1}` }, id: `call_${id}_${done}`, name: 'terminal' }, 18).then(() =>
          log.push({ at: Date.now(), id, kind: 'tool' })
        )

        return
      }

      if (think) {
        pieces.push({ ms: 45, reasoning: REASONING('final') })
      }

      // MGS_FOLDPAUSE: the answer's first words, then a pause, so the
      // reasoning's fold happens while nothing else grows.
      if (prompt.includes('MGS_FOLDPAUSE')) {
        pieces.push({ content: 'The answer starts on this line. ' }, { pause: 1800 }, { content: `And it goes on after the pause. Done ${id}.` })
        stream(res, pieces, null, fast).then(() => log.push({ at: Date.now(), id, kind: 'end' }))

        return
      }

      pieces.push({ content: prompt.includes('MGS_LONG') || steps ? LONG(id) : `A short reply. Done ${id}.` })
      stream(res, pieces, null, fast).then(() => log.push({ at: Date.now(), id, kind: 'end' }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const { port } = server.address()

  return {
    close: () => new Promise(resolve => server.close(() => resolve())),
    log,
    port,
    receivedPrompts,
    releaseHeldStream: () => {
      const release = releaseHeld

      arm()
      release()
    },
    url: `http://127.0.0.1:${port}`,
    waitForHeldStream: () => heldPromise
  }
}

// ── In-page recorder ────────────────────────────────────────────────────────
// Installed once; survives until a reload. `__mgStab.start(tag)` begins a
// phase, `__mgStab.stop()` returns its numbers.
function recorder({ running, viewport }) {
  if (window.__mgStab) {
    return 'present'
  }

  const ROW = '[data-slot="aui_assistant-message-root"]'
  const vp = () => [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
  const ids = new WeakMap()
  let next = 1
  const idOf = node => (ids.has(node) ? ids.get(node) : (ids.set(node, next), next++))
  const describe = node => {
    if (!(node instanceof Element)) {
      return String(node?.nodeName)
    }

    const slot = node.closest('[data-slot]')?.dataset.slot ?? ''

    return `${node.tagName.toLowerCase()}${node.dataset.slot ? `[${node.dataset.slot}]` : ''}${slot && slot !== node.dataset.slot ? ` in ${slot}` : ''}`
  }

  window.__mgTraceOn = true

  const S = {
    phase: null,
    tracked: null,
    // Per element and animation name: how many times it started.
    starts: new Map(),
    segHistory: new Map(),
    frames: [],
    shifts: [],
    loafs: [],
    longtasks: [],
    wheelAt: -1e9,
    animStarts: [],
    transStarts: 0
  }

  const reset = tag => {
    S.phase = { tag, t0: performance.now(), wall: Date.now() }
    S.frames = []
    S.shifts = []
    S.loafs = []
    S.longtasks = []
    S.animStarts = []
    S.transStarts = 0
    S.writes = []
    S.starts = new Map()
    S.segHistory = new Map()
  }

  const tick = now => {
    if (S.phase) {
      const v = vp()

      if (v) {
        const rows = v.querySelectorAll(ROW)
        const lastRow = rows[rows.length - 1]
        const blocks = lastRow ? lastRow.querySelectorAll('[data-slot="aui_assistant-message-content"] > .aui-md') : []
        const last = blocks[blocks.length - 1]
        const thinking = [...v.querySelectorAll('[data-slot="aui_thinking-body"]')].filter(node => node.getBoundingClientRect().height > 0)
        const tracked = S.tracked?.isConnected ? Math.round(S.tracked.getBoundingClientRect().top * 10) / 10 : null

        S.frames.push([
          Math.round(now - S.phase.t0),
          Math.round(v.scrollTop * 10) / 10,
          v.scrollHeight,
          v.clientHeight,
          tracked,
          last ? Math.round(last.getBoundingClientRect().bottom * 10) / 10 : null,
          v.querySelector(running) ? 1 : 0,
          v.dataset.following === 'true' ? 1 : 0,
          thinking.reduce((sum, node) => sum + (node.textContent ?? '').length, 0),
          performance.now() - S.wheelAt < 400 ? 1 : 0,
          Date.now(),
          S.needle && lastRow && (lastRow.textContent ?? '').includes(S.needle) ? 1 : 0
        ])
      }
    }

    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)

  window.addEventListener('wheel', () => (S.wheelAt = performance.now()), { capture: true, passive: true })

  // Every write to a thread viewport's scrollTop, and whether a script of the
  // plugin (a blob: module) made it.
  S.writes = []

  const own = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')

  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return own.get.call(this)
    },
    set(value) {
      if (S.phase && this.matches?.(viewport)) {
        const before = own.get.call(this)

        own.set.call(this, value)

        const after = own.get.call(this)

        if (Math.abs(after - before) >= 1 && S.writes.length < 400) {
          const stack = String(new Error().stack ?? '')

          S.writes.push({ d: Math.round(after - before), ours: stack.includes('blob:'), t: Math.round(performance.now() - S.phase.t0), wall: Date.now() })
        }

        return
      }

      own.set.call(this, value)
    }
  })

  document.addEventListener(
    'animationstart',
    event => {
      if (!S.phase) {
        return
      }

      const key = `${idOf(event.target)}|${event.animationName}`
      const count = (S.starts.get(key)?.count ?? 0) + 1
      const row = event.target.closest?.(ROW)
      const pair = event.target.closest?.('[data-slot="aui_turn-pair"]')

      // Each start, with what the row and its pair carried then (to find
      // what restarted it).
      const seen = S.starts.get(key)?.seen ?? []

      seen.push({
        t: Math.round(performance.now() - S.phase.t0),
        live: pair ? 'mgLive' in pair.dataset : null,
        marks: row ? ['mgSeg', 'mgPart', 'mgHead', 'mgStale', 'mgAnim'].filter(name => name in row.dataset).map(name => `${name}=${row.dataset[name]}`).join(' ') : '',
        id: row?.dataset.messageId?.slice(0, 24) ?? null,
        connected: event.target.isConnected,
        same: S.starts.get(key)?.el === event.target
      })
      S.starts.set(key, { count, inThread: Boolean(event.target.closest?.(viewport)), name: event.animationName, node: describe(event.target), el: event.target, row: row ? idOf(row) : null, seen: seen.slice(-4) })
      // How long it runs, as the browser has it (the kill switch in
      // 05-motion.css cuts every animation to 0.01ms starting 1ms in the
      // past, so it is over the moment it starts): the end of its active
      // phase in ms, delay included. Read from the animation object, falling
      // back to the computed style.
      const timing = (() => {
        const anim = (event.target.getAnimations?.({ subtree: true }) ?? []).find(a => a.animationName === event.animationName && (a.effect?.pseudoElement ?? '') === (event.pseudoElement ?? ''))
        const t = anim?.effect?.getComputedTiming?.()

        if (t) {
          return { endMs: Math.round((Number(t.endTime) || 0) * 1000) / 1000, durationMs: Math.round((Number(t.duration) || 0) * 1000) / 1000, fill: t.fill } // ms already
        }

        const style = getComputedStyle(event.target, event.pseudoElement || null)
        const ms = value => (String(value).trim().endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000) || 0
        const duration = ms(style.animationDuration.split(',')[0])
        const count = style.animationIterationCount.split(',')[0].trim()

        return { endMs: ms(style.animationDelay.split(',')[0]) + duration * (count === 'infinite' ? Infinity : Number(count) || 1), durationMs: duration, fill: style.animationFillMode }
      })()

      const shownBox = event.target.getBoundingClientRect?.()

      S.animStarts.push({
        ...timing,
        hidden: !(event.target.checkVisibility?.({ visibilityProperty: true }) && shownBox?.height > 0),
        inRunning: Boolean(pair?.dataset.mgLive !== undefined || pair?.querySelector(running)),
        inThread: Boolean(event.target.closest?.(viewport)),
        name: event.animationName,
        node: describe(event.target),
        t: Math.round(performance.now() - S.phase.t0)
      })
    },
    true
  )
  document.addEventListener('transitionstart', () => S.phase && (S.transStarts += 1), true)

  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (S.phase && entry.duration > 50) {
          S.loafs.push({
            blocking: Math.round(entry.blockingDuration ?? 0),
            d: Math.round(entry.duration),
            scripts: (entry.scripts ?? []).map(script => ({
              d: Math.round(script.duration),
              invoker: String(script.invoker ?? '').slice(0, 80),
              ours: String(script.sourceURL ?? '').startsWith('blob:'),
              src: String(script.sourceURL ?? '').replace(/^.*\//, '').slice(0, 60),
              type: script.invokerType
            })),
            t: Math.round(entry.startTime - S.phase.t0)
          })
        }
      }
    }).observe({ buffered: false, type: 'long-animation-frame' })
  } catch (error) {
    S.loafError = String(error)
  }

  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (S.phase) {
          S.longtasks.push({ d: Math.round(entry.duration), t: Math.round(entry.startTime - S.phase.t0) })
        }
      }
    }).observe({ type: 'longtask' })
  } catch (error) {
    S.longtaskError = String(error)
  }

  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (S.phase && entry.value > 0.0005) {
          S.shifts.push({
            input: entry.hadRecentInput,
            sources: (entry.sources ?? []).slice(0, 3).map(source => `${describe(source.node)} ${Math.round(source.previousRect.y)}→${Math.round(source.currentRect.y)}`),
            t: Math.round(entry.startTime - S.phase.t0),
            v: Math.round(entry.value * 10000) / 10000
          })
        }
      }
    }).observe({ type: 'layout-shift' })
  } catch (error) {
    S.shiftError = String(error)
  }

  // Every value data-mg-seg takes on every reply row, in order.
  new MutationObserver(records => {
    if (!S.phase) {
      return
    }

    for (const record of records) {
      const node = record.target

      if (!node.matches?.(ROW)) {
        continue
      }

      const list = S.segHistory.get(idOf(node)) ?? []
      // A row hidden as a left-over copy loses its marks too: not an unfold.
      const value = node.dataset.mgSeg ?? ('mgStale' in node.dataset ? 'stale' : '-')

      if (list.at(-1)?.v !== value) {
        const prompt = node.closest('[data-slot="aui_turn-pair"]')?.querySelector('[data-slot="aui_user-message-root"]')

        list.push({ t: Math.round(performance.now() - S.phase.t0), turn: /ID=(\w+)/.exec(prompt?.textContent ?? '')?.[1] ?? '?', v: value, wall: Date.now() })
      }

      S.segHistory.set(idOf(node), list)
    }
  }).observe(document.body, { attributeFilter: ['data-mg-seg', 'data-mg-stale'], attributes: true, subtree: true })

  // The working line's life (s7 diagnostics): every insert, removal or move
  // of a node holding a working line, and every attribute written on the line
  // or an ancestor of it, so a pulse that starts again names what did it.
  S.lineLog = []
  const working = new Set()
  const lineNote = (kind, node, extra) => {
    if (S.phase && S.lineLog.length < 400) {
      S.lineLog.push({ t: Math.round(performance.now() - S.phase.t0), kind, node: `${describe(node)}#${idOf(node)}`, ...extra })
    }
  }

  new MutationObserver(records => {
    if (!S.phase) {
      return
    }

    document.querySelectorAll('.mg-line[data-mg-working]').forEach(line => working.add(line))

    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target

        if ([...working].some(line => target === line || target.contains(line))) {
          lineNote('attr', target, { name: record.attributeName, was: String(record.oldValue).slice(0, 60), now: String(target.getAttribute(record.attributeName)).slice(0, 60) })
        }

        continue
      }

      for (const node of record.removedNodes) {
        const held = [...working].filter(line => node === line || node.contains?.(line))

        if (held.length) {
          lineNote('removed', node, { lines: held.map(idOf), from: describe(record.target), back: held.map(line => line.isConnected) })
        }
      }

      for (const node of record.addedNodes) {
        const held = [...working].filter(line => node === line || node.contains?.(line))

        if (held.length) {
          lineNote('added', node, { lines: held.map(idOf), to: describe(record.target) })
        }
      }
    }

    for (const line of working) {
      if (!line.isConnected) {
        working.delete(line)
      }
    }
  }).observe(document.body, { attributes: true, attributeOldValue: true, childList: true, subtree: true, attributeFilter: ['class', 'style', 'hidden', 'data-state', 'data-mg-working', 'data-mg-stale', 'data-mg-live', 'data-mg-work', 'data-mg-anim'] })

  // Style sheets coming and going, and the root's attributes: a restart with
  // no DOM change on the line's own path is a style-level one.
  new MutationObserver(records => {
    if (!S.phase || !working.size) {
      return
    }

    for (const record of records) {
      if (record.type === 'attributes') {
        lineNote('root', record.target, { name: record.attributeName, was: String(record.oldValue).slice(0, 40), now: String(record.target.getAttribute(record.attributeName)).slice(0, 40) })
      } else {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType === 1 && node.matches('style, link')) {
            lineNote(record.addedNodes.length ? 'sheet+' : 'sheet-', node, { id: node.id || null, size: (node.textContent ?? '').length, keyframes: /@keyframes/.test(node.textContent ?? '') })
          }
        }
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeOldValue: true, childList: true, subtree: false })
  new MutationObserver(records => {
    if (!S.phase || !working.size) {
      return
    }

    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType === 1 && node.matches('style, link')) {
          lineNote(record.addedNodes.length ? 'sheet+' : 'sheet-', node, { id: node.id || null, size: (node.textContent ?? '').length, keyframes: /@keyframes/.test(node.textContent ?? '') })
        }
      }

      if (record.type === 'characterData' || (record.target.nodeType === 1 && record.target.matches?.('style'))) {
        lineNote('sheet~', record.target.nodeType === 1 ? record.target : record.target.parentElement, {})
      }
    }
  }).observe(document.head, { childList: true, subtree: true, characterData: true })

  S.start = tag => {
    reset(tag)
    S.lineLog = []
    window.__mgPerfReset?.()
  }

  S.track = node => {
    S.tracked = node
  }

  S.watchFor = needle => {
    S.needle = needle
  }

  S.stop = () => {
    const out = {
      animStarts: S.animStarts,
      lineLog: S.lineLog,
      frames: S.frames,
      loafs: S.loafs,
      longtasks: S.longtasks,
      perf: window.__mgPerf ? JSON.parse(JSON.stringify(window.__mgPerf)) : null,
      replays: [...S.starts.values()].filter(entry => entry.count > 1 && entry.inThread).map(({ el, ...entry }) => entry),
      replaysOutside: [...S.starts.values()].filter(entry => entry.count > 1 && !entry.inThread).map(({ el, seen, ...entry }) => entry),
      writes: S.writes,
      segHistory: [...S.segHistory.entries()].map(([row, list]) => ({ list, row })),
      shifts: S.shifts,
      startsTotal: [...S.starts.values()].reduce((sum, entry) => sum + entry.count, 0),
      tag: S.phase?.tag,
      transStarts: S.transStarts,
      wall0: S.phase?.wall,
      errors: [S.loafError, S.longtaskError, S.shiftError].filter(Boolean)
    }

    S.phase = null
    S.needle = null

    return out
  }

  window.__mgStab = S

  return 'installed'
}

const install = () => state.page.evaluate(recorder, { running: RUNNING, viewport: VIEWPORT })

// Planted faults (self-test of a check, never for a verdict):
// MG_RIG_PLANT=s7fold,s7hidden,s15,s16 (any of them, comma separated).
//   s7fold    every 1.5 s while the thread builds, a folded row loses its fold
//   s7hidden  an arrival of ours plays on a hidden element in the thread
//   s15       every sign of life is hidden
//   s16       the reasoning's fold moves the answer up by 40 px
const PLANTS = new Set((process.env.MG_RIG_PLANT ?? '').split(',').filter(Boolean))
const PLANT_CSS = {
  s15: '[data-slot="aui_thinking-disclosure"], [data-slot="aui_turn-activity"], [data-slot="aui_response-loading"], #mf-live { display: none !important; }',
  s16: '[data-slot="aui_assistant-message-content"]:has(> [data-mg-think="folded"]) > .aui-md { translate: 0 -40px; }'
}
const plant = async id => {
  // One plant at a time: the one before goes.
  await state.page.evaluate(() => document.querySelectorAll('style[data-mg-plant]').forEach(node => node.remove()))

  if (!PLANTS.has(id)) {
    return
  }

  results.notes.push(`stability: MG_RIG_PLANT=${id}: a planted fault (self-test, not a verdict)`)

  if (PLANT_CSS[id]) {
    await state.page.evaluate(css => {
      const style = document.createElement('style')

      style.dataset.mgPlant = ''
      style.textContent = css
      document.head.appendChild(style)
    }, PLANT_CSS[id])
  } else if (id === 's7fold') {
    await state.page.evaluate(() => {
      window.__mgPlantFold = setInterval(() => document.querySelector('[data-slot="aui_assistant-message-root"][data-mg-seg="closed"]')?.removeAttribute('data-mg-seg'), 1500)
    })
  } else if (id === 's7hidden') {
    await state.page.evaluate(viewport => {
      const group = [...document.querySelectorAll(`${viewport} [data-slot="aui_response-group"]`)].at(-1)
      const node = document.createElement('div')

      node.setAttribute('data-slot', 'tool-block')
      node.style.cssText = 'visibility: hidden; height: 4px; animation: mg-stream-in 200ms'
      group?.appendChild(node)
      setTimeout(() => node.remove(), 1000)
    }, VIEWPORT)
  }
}
const start = tag => state.page.evaluate(tag => window.__mgStab.start(tag), tag)
const stop = () => state.page.evaluate(() => window.__mgStab.stop())

// ── Reading a phase ─────────────────────────────────────────────────────────
// frames: [t, scrollTop, scrollHeight, clientHeight, trackedTop, lastAnswerBottom, running, following, thinkingChars, wheel]
const F = { t: 0, top: 1, h: 2, ch: 3, tracked: 4, answer: 5, running: 6, following: 7, thinking: 8, wheel: 9, wall: 10, needle: 11 }

const watchFor = needle => state.page.evaluate(needle => window.__mgStab.watchFor(needle), needle)

// The first frame at which the turn was over: the model had sent its last
// word and the answer's last words were on screen.
const endFrame = (frames, id) => {
  const end = state.mock.log.filter(entry => entry.id === id && entry.kind === 'end').at(-1)?.at ?? Infinity

  return frames.findIndex(frame => frame[F.wall] >= end && frame[F.needle])
}

const ms = list => list.reduce((sum, item) => sum + item, 0)

function summarise(rec) {
  const ours = rec.loafs.filter(loaf => loaf.scripts.some(script => script.ours))
  const ourWorst = Math.max(0, ...rec.loafs.flatMap(loaf => loaf.scripts.filter(script => script.ours).map(script => script.d)))
  const frameGaps = rec.frames.slice(1).map((frame, index) => frame[F.t] - rec.frames[index][F.t])

  return {
    frames: rec.frames.length,
    slowFrames: { over50: frameGaps.filter(gap => gap > 50).length, over100: frameGaps.filter(gap => gap > 100).length, worst: Math.max(0, ...frameGaps) },
    longTasks: { n: rec.longtasks.length, total: ms(rec.longtasks.map(task => task.d)), worst: Math.max(0, ...rec.longtasks.map(task => task.d)) },
    longFrames: rec.loafs.length,
    longFramesWithOurScript: ours.length,
    ourWorstScriptMs: ourWorst,
    ourScriptMsInLongFrames: ms(rec.loafs.flatMap(loaf => loaf.scripts.filter(script => script.ours).map(script => script.d))),
    ourTopScripts: rec.loafs
      .flatMap(loaf => loaf.scripts.filter(script => script.ours).map(script => ({ ...script, t: loaf.t })))
      .sort((a, b) => b.d - a.d)
      .slice(0, 5)
      .map(script => `${script.d}ms ${script.type} ${script.invoker} @${script.t}`),
    layoutShifts: { n: rec.shifts.length, sum: Math.round(ms(rec.shifts.map(shift => shift.v)) * 1000) / 1000, top: [...rec.shifts].sort((a, b) => b.v - a.v).slice(0, 3) },
    animationStarts: rec.startsTotal,
    replays: rec.replays.slice(0, 8),
    transitionStarts: rec.transStarts,
    scrollWrites: { ours: rec.writes.filter(write => write.ours).length, hermes: rec.writes.filter(write => !write.ours).length },
    perf: rec.perf
  }
}

// Frames in which the tracked element moved on screen with no wheel input.
function moves(frames, from = 0, to = Infinity) {
  const out = []

  for (let index = 1; index < frames.length; index += 1) {
    const [a, b] = [frames[index - 1], frames[index]]

    if (b[F.t] < from || b[F.t] > to || a[F.tracked] === null || b[F.tracked] === null || b[F.wheel]) {
      continue
    }

    const delta = b[F.tracked] - a[F.tracked]

    if (Math.abs(delta) > 1) {
      out.push({ dTop: Math.round(b[F.top] - a[F.top]), delta: Math.round(delta), running: b[F.running], t: b[F.t] })
    }
  }

  return out
}

// A row whose data-mg-seg went from a value back to none, or changed twice.
function flaps(segHistory) {
  return segHistory.filter(({ list }) => {
    const values = list.map(item => item.v)
    const set = values.filter((value, index) => value !== '-' || index > 0)

    return set.includes('-') && set.indexOf('-') > 0
  })
}

const rowsOnScreen = () =>
  state.page.evaluate(viewport => {
    const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)

    return v ? v.querySelectorAll('[data-slot="aui_assistant-message-root"]').length : 0
  }, VIEWPORT)

const scrollToBottom = () =>
  state.page.evaluate(viewport => {
    const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)

    v.scrollTop = v.scrollHeight
  }, VIEWPORT)

const viewportBox = () =>
  state.page.evaluate(viewport => {
    const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
    const rect = v.getBoundingClientRect()

    return { h: rect.height, w: rect.width, x: rect.x, y: rect.y }
  }, VIEWPORT)

// The block in the middle of the viewport: the thing being read.
const trackMiddle = () =>
  state.page.evaluate(viewport => {
    const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
    const rect = v.getBoundingClientRect()
    const content = v.querySelector('[data-slot="aui_thread-content"]').getBoundingClientRect()

    for (const dy of [0.4, 0.5, 0.3, 0.6, 0.2]) {
      const hit = document.elementFromPoint(content.x + content.width / 2 - 40, rect.y + rect.height * dy)
      const block = hit?.closest('.aui-md > *, [data-slot="tool-block"], [data-slot="aui_user-message-root"]')

      if (block && v.contains(block)) {
        window.__mgStab.track(block)

        return `${block.tagName.toLowerCase()} "${(block.textContent ?? '').trim().slice(0, 50)}" at ${Math.round(block.getBoundingClientRect().top)}`
      }
    }

    return null
  }, VIEWPORT)

const waitStreamEnd = (id, timeout = 120_000) => finished(`Done ${id}.`, timeout)

// ── The run ─────────────────────────────────────────────────────────────────
export async function run() {
  const { page, mock } = state
  const keep = {}

  await install()

  // ── s1. Long thread ────────────────────────────────────────────────────────
  await check('s1', async (entry, must) => {
    await start('build')
    await plant('s7fold')

    const began = Date.now()

    for (let index = 1; index <= TURNS; index += 1) {
      const id = `L${index}`

      await type(`Turn ${index}. ID=${id} MGS_LONG${index % 6 === 0 ? ' MGS_WORK(2,0)' : ''}`, 'Enter')
      await waitStreamEnd(id)
    }

    await plant('s7hidden')
    await sleep(1500)
    await page.evaluate(() => clearInterval(window.__mgPlantFold))

    const rec = await stop()

    keep.build = rec
    Object.assign(entry.evidence, { turns: TURNS, buildMs: Date.now() - began, rowsOnScreen: await rowsOnScreen(), ...summarise(rec) })
    must((await rowsOnScreen()) >= Math.min(30, TURNS), `fewer than ${Math.min(30, TURNS)} reply rows on screen after ${TURNS} turns`)
    must(entry.evidence.ourWorstScriptMs <= 50, `a Monograph script ran ${entry.evidence.ourWorstScriptMs}ms inside a long frame`)
    await shot(entry, 's1-long-thread')
  })

  // ── s2 + s3. Pinned: a turn with many tool calls and reasoning ─────────────
  let pinned = null
  const lastPairInfo = () =>
    page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...(v?.querySelectorAll('[data-slot="aui_turn-pair"]') ?? [])].at(-1)

      // A session with no turn yet (just switched to).
      if (!pair) {
        return { thinking: 0, thinkingShown: 0, bodyChars: 0, tools: 0, toolsShown: 0, rows: 0, marked: 0, live: false, turn: '?', text: '' }
      }

      const shown = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
      const bodies = [...pair.querySelectorAll('[data-slot="aui_thinking-body"]')]
      const tools = [...pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > [data-slot="tool-block"]')]
      const disclosures = [...pair.querySelectorAll('[data-slot="aui_thinking-disclosure"]')]

      return {
        thinking: disclosures.length,
        thinkingShown: disclosures.filter(shown).length,
        bodyChars: bodies.filter(shown).reduce((sum, node) => sum + (node.textContent ?? '').length, 0),
        // Blocks still streaming (Hermes' shimmer on the label) and what of
        // their text is drawn.
        pending: disclosures.filter(node => node.querySelector('.shimmer')).length,
        pendingChars: disclosures.filter(node => node.querySelector('.shimmer')).flatMap(node => [...node.querySelectorAll('[data-slot="aui_thinking-body"]')]).filter(shown).reduce((sum, node) => sum + (node.textContent ?? '').length, 0),
        // Live reasoning is a few lines at most: how many of the body's own
        // lines the live preview shows.
        liveLines: Math.max(0, ...bodies.filter(node => shown(node) && node.closest('[data-mg-think="live"]')).map(node => {
          const style = getComputedStyle(node)
          const inner = node.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)

          return Math.round((inner / parseFloat(style.lineHeight)) * 100) / 100
        })),
        tools: tools.length,
        toolsShown: tools.filter(shown).length,
        rows: pair.querySelectorAll('[data-slot="aui_assistant-message-root"]').length,
        marked: [...pair.querySelectorAll('[data-slot="aui_assistant-message-root"]')].filter(row => row.dataset.mgSeg).length,
        live: 'mgLive' in pair.dataset,
        turn: /ID=(\w+)/.exec(pair.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '')?.[1] ?? '?',
        text: (pair.textContent ?? '').slice(-400)
      }
    }, VIEWPORT)

  await check('s2', async (entry, must) => {
    await scrollToBottom()
    await sleep(300)
    await start('pinned')
    await watchFor('Done P1.')
    await type('Many tools. ID=P1 MGS_WORK(8,0.2) MGS_THINK', 'Enter')

    // Sample reasoning and tool rows until the answer's last words are in.
    const during = []
    const began = Date.now()

    let pressed = null

    while (Date.now() - began < 120_000) {
      const now = await lastPairInfo()
      const done = now.text.includes('Done P1.')

      during.push({ ...now, done, ms: Date.now() - began, pressed: Boolean(pressed), text: undefined, wall: Date.now() })

      if (done) {
        break
      }

      // Simple mode rests reasoning collapsed (Hermes' own preference): the
      // header shows "Thinking" and a press opens the body. Press the first
      // one while it streams, once, as a reader would; but not when the
      // reasoning has already shown itself (Monograph opens it live): then a
      // collapsed header is an earlier thought, folded, and a press on it
      // opens it in place and lets go of the bottom on purpose.
      if (!pressed && now.thinkingShown && !now.bodyChars && !during.some(sample => sample.bodyChars > 0)) {
        const header = await page.evaluate(viewport => {
          const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
          const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)
          const button = [...pair.querySelectorAll('[data-slot="aui_thinking-disclosure"] button[aria-expanded="false"]')].at(-1)
          const rect = button?.getBoundingClientRect()

          return rect && rect.height > 0 && rect.top > v.getBoundingClientRect().top && rect.bottom < v.getBoundingClientRect().bottom
            ? { label: (button.textContent ?? '').trim().slice(0, 30), x: rect.x + 30, y: rect.y + rect.height / 2 }
            : null
        }, VIEWPORT)

        if (header) {
          await page.mouse.click(header.x, header.y)
          pressed = { ...header, ms: Date.now() - began }
        }
      }

      await sleep(150)
    }

    await sleep(3000)

    const rec = await stop()

    keep.pinned = rec

    const end = endFrame(rec.frames, 'P1')
    const after = end >= 0 ? rec.frames.slice(end) : []
    const answerBottoms = after.map(frame => frame[F.answer]).filter(value => value !== null)
    const gaps = after.map(frame => Math.round(frame[F.h] - frame[F.top] - frame[F.ch]))
    const answerMoved = answerBottoms.length ? Math.round((Math.max(...answerBottoms) - Math.min(...answerBottoms)) * 10) / 10 : null
    const folded = await lastPairInfo()

    pinned = { during, pressed }

    // Each frame-to-frame move of the answer after the end, and whether a
    // fold mark of ours changed in that frame.
    const segWalls = rec.segHistory.flatMap(({ list }) => list.map(item => item.wall))
    const answerMoves = []

    for (let index = 1; index < after.length; index += 1) {
      const [a, b] = [after[index - 1], after[index]]

      if (a[F.answer] !== null && b[F.answer] !== null && Math.abs(b[F.answer] - a[F.answer]) > 1) {
        answerMoves.push({ delta: Math.round(b[F.answer] - a[F.answer]), ours: segWalls.some(wall => wall > a[F.wall] - 5 && wall <= b[F.wall]), t: b[F.t] })
      }
    }
    Object.assign(entry.evidence, {
      turnEndAtMs: end >= 0 ? rec.frames[end][F.t] : null,
      framesAfterEnd: after.length,
      answerBottomRangeAfterEnd: answerMoved,
      answerMovesAfterEnd: answerMoves.slice(0, 8),
      // [t, scrollTop, scrollHeight, clientHeight, tracked, answerBottom, running, following] around each move
      framesAroundMoves: answerMoves.slice(0, 3).map(move => after.filter(frame => Math.abs(frame[F.t] - move.t) <= 60).map(frame => frame.slice(0, 8))),
      foldWrites: rec.segHistory.flatMap(({ list, row }) => list.map(item => ({ row, t: item.t, v: item.v }))).filter(item => item.t >= (after[0]?.[F.t] ?? 0)),
      scrollWritesAfterEnd: rec.writes.filter(write => write.t >= (after[0]?.[F.t] ?? 0)).slice(0, 12),
      bottomGapAfterEnd: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), last: gaps.at(-1) } : null,
      followingAfterEnd: [...new Set(after.map(frame => frame[F.following]))],
      foldedAtEnd: { marked: folded.marked, rows: folded.rows, toolsShown: folded.toolsShown, tools: folded.tools, live: folded.live },
      foldFlaps: flaps(rec.segHistory).length,
      ...summarise(rec)
    })
    must(end >= 0, 'the end of the turn was never seen on screen')
    must(answerMoved !== null, 'no answer block seen after the end')
    must(!answerMoves.some(move => move.ours), `the answer moved on screen in a frame where the fold changed: ${JSON.stringify(answerMoves.filter(move => move.ours))}`)

    if (answerMoves.some(move => !move.ours)) {
      results.observations.push(`s2: after the turn ended (pinned), the answer moved in ${answerMoves.filter(move => !move.ours).length} frame(s) with no fold change of ours in them: ${answerMoves.filter(move => !move.ours).slice(0, 4).map(move => `${move.delta}px @${move.t}ms`).join(', ')}. Hermes follows growth at the bottom one frame late (use-stick-to-bottom).`)
    }
    must(gaps.length && gaps.at(-1) <= 2, `not pinned to the bottom after the fold: gap ${gaps.at(-1)}px`)
    must(folded.marked === folded.rows && folded.toolsShown === 0 && !folded.live, `the finished turn is not folded: ${JSON.stringify(entry.evidence.foldedAtEnd)}`)
    must(entry.evidence.foldFlaps === 0, `${entry.evidence.foldFlaps} reply rows lost their fold mark and got it back`)
    must(entry.evidence.ourWorstScriptMs <= 50, `a Monograph script ran ${entry.evidence.ourWorstScriptMs}ms inside a long frame`)
    await shot(entry, 's2-pinned-turn-end')
  })

  await check('s3', async (entry, must) => {
    const during = pinned?.during ?? []
    const modelEnd = mock.log.filter(item => item.id === 'P1' && item.kind === 'end').at(-1)?.at ?? Infinity
    const running = during.filter(sample => !sample.done && sample.wall < modelEnd)
    // Advanced mode shows reasoning open while it streams; Simple mode rests it
    // collapsed and the rig presses it open.
    const openByDefault = running.some(sample => !sample.pressed && sample.bodyChars > 0)
    const afterPress = openByDefault ? running : running.filter(sample => sample.pressed)
    const chars = afterPress.map(sample => sample.bodyChars)
    // Open by default, each thought folds when the next part starts; what may
    // not happen is a thought's text going while that thought still streams.
    const drops = openByDefault
      ? running.filter((sample, index) => index > 0 && running[index - 1].pendingChars > 0 && sample.pending > 0 && sample.pendingChars === 0 && sample.thinking === running[index - 1].thinking).length
      : chars.filter((value, index) => index > 0 && chars[index - 1] > 0 && value === 0).length

    entry.evidence.whileRunning = {
      samples: running.length,
      withThinkingHeader: running.filter(sample => sample.thinkingShown > 0).length,
      pressedThinking: pinned?.pressed ?? null,
      samplesAfterPress: afterPress.length,
      withReasoningBody: afterPress.filter(sample => sample.bodyChars > 0).length,
      reasoningChars: [...new Set(chars)].slice(0, 12),
      reasoningVanished: drops,
      maxToolRowsShown: Math.max(0, ...running.map(sample => sample.toolsShown)),
      // Two samples in a row: a row that has just arrived can measure 0px once.
      toolRowsHiddenWhileRunning: running.filter((sample, index) => {
        const hidden = item => item?.turn === 'P1' && item.toolsShown < item.tools

        return hidden(sample) && hidden(running[index - 1])
      }).length,
      markedWhileRunning: running.filter(sample => sample.marked > 0).length,
      markedSamples: running.filter(sample => sample.marked > 0).map(sample => `${sample.turn} @${sample.ms}ms rows ${sample.rows} marked ${sample.marked}`),
      liveWhileRunning: running.filter(sample => sample.live).length
    }

    must(entry.evidence.whileRunning.withThinkingHeader >= 3, `a Thinking block was on screen in ${entry.evidence.whileRunning.withThinkingHeader} samples while the turn ran`)
    entry.evidence.reasoningOpenByDefault = openByDefault
    must(pinned?.pressed || openByDefault, 'the Thinking header was never on screen to press while the turn ran')
    must(afterPress.filter(sample => sample.bodyChars > 0).length >= 2, `after the press, the reasoning body was drawn in ${entry.evidence.whileRunning.withReasoningBody} samples while the turn ran`)
    must(Math.max(0, ...chars) > 120, 'the reasoning drawn while running never grew past 120 characters')
    must(drops === 0, `the open reasoning vanished ${drops} times while the turn ran`)
    must(entry.evidence.whileRunning.maxToolRowsShown >= 8, `at most ${entry.evidence.whileRunning.maxToolRowsShown} tool rows were visible while the turn ran (8 calls)`)
    must(entry.evidence.whileRunning.toolRowsHiddenWhileRunning === 0, `tool rows were hidden in ${entry.evidence.whileRunning.toolRowsHiddenWhileRunning} samples while the turn ran`)
    must(running.filter(sample => sample.marked > 0 && sample.turn === 'P1').length === 0, `the running turn carried fold marks: ${entry.evidence.whileRunning.markedSamples.join('; ')}`)

    // After the turn: the work is folded. Press the line (pinned to the
    // bottom, as a reader would be): the work opens below the line and the
    // line stays where it was.
    await scrollToBottom()
    await sleep(400)

    const box = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const row = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1).querySelector('[data-mg-head][data-mg-steps]')

      if (!row) {
        return null
      }

      const rect = row.getBoundingClientRect()

      window.__mgStab.track(row)

      return { following: v.dataset.following, inView: rect.top > v.getBoundingClientRect().top, steps: row.dataset.mgSteps, worked: row.dataset.mgWorked, x: rect.x + 60, y: rect.y + 14 }
    }, VIEWPORT)

    entry.evidence.foldLine = box
    must(box, 'no fold line (data-mg-head with data-mg-steps) on the finished turn')

    if (!box) {
      return
    }

    must(box.inView, 'the fold line is not on screen when pinned to the bottom (cannot press it without scrolling)')
    await start('open-fold')
    await page.mouse.click(box.x, box.y)
    await sleep(900)

    const opened = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)
      const shown = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
      const disclosures = [...pair.querySelectorAll('[data-slot="aui_thinking-disclosure"]')]

      return {
        open: Boolean(pair.querySelector('[data-mg-open]')),
        tools: [...pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > [data-slot="tool-block"]')].filter(shown).length,
        thinking: disclosures.filter(shown).length
      }
    }, VIEWPORT)

    const openRec = await stop()
    const lineMoves = moves(openRec.frames)
    const lineMoved = Math.abs(lineMoves.reduce((sum, move) => sum + move.delta, 0))

    entry.evidence.afterOpeningFold = opened
    entry.evidence.foldLineMovesOnOpen = lineMoves.slice(0, 8).map(move => `${move.delta}px @${move.t}ms`)
    entry.evidence.scrollWritesOnOpen = openRec.writes.slice(0, 8)
    must(opened.open, 'the press on the line did not open the fold')
    must(lineMoved <= 2, `the line moved ${lineMoved}px when it was pressed`)
    must(opened.tools >= 8, `${opened.tools} tool rows visible after opening the fold, 8 ran`)
    must(opened.thinking >= 1, 'no reasoning block visible after opening the fold')

    // The reasoning opens on a press of its own and holds what streamed.
    await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)

      pair.querySelector('[data-slot="aui_thinking-disclosure"] button[aria-expanded]')?.scrollIntoView({ block: 'center' })
    }, VIEWPORT)
    await sleep(300)

    const button = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)
      const node = pair.querySelector('[data-slot="aui_thinking-disclosure"] button[aria-expanded]')
      const rect = node?.getBoundingClientRect()

      return node ? { expanded: node.getAttribute('aria-expanded'), x: rect.x + 30, y: rect.y + rect.height / 2 } : null
    }, VIEWPORT)

    if (button && button.expanded !== 'true') {
      await page.mouse.click(button.x, button.y)
      await sleep(500)
    }

    const body = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)
      const node = pair.querySelector('[data-slot="aui_thinking-body"]')

      return node ? { chars: (node.textContent ?? '').length, shown: node.checkVisibility() && node.getBoundingClientRect().height > 0, text: (node.textContent ?? '').slice(0, 80) } : null
    }, VIEWPORT)

    entry.evidence.reasoningBody = body
    entry.evidence.thinkingHeader = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)
      const button = pair.querySelector('[data-slot="aui_thinking-disclosure"] button[aria-expanded]')
      const spans = [...(button?.querySelectorAll('span') ?? [])].slice(0, 4)

      return {
        text: (button?.textContent ?? '').trim().slice(0, 40),
        paused: document.documentElement.hasAttribute('data-renderer-animations-paused'),
        spans: spans.map(span => {
          const style = getComputedStyle(span)

          return `${span.className.toString().slice(0, 60)} | "${(span.textContent ?? '').trim().slice(0, 20)}" color ${style.color} opacity ${style.opacity} clip ${style.backgroundClip} anim ${style.animationName}/${style.animationPlayState} fill ${style.webkitTextFillColor}`
        })
      }
    }, VIEWPORT)
    must(body?.shown && body.text.includes(REASONING_NEEDLE), 'the reasoning body did not open with the streamed reasoning in it')
    await shot(entry, 's3-reasoning-open')

    // Close the fold again, so later checks see a folded thread. The line is
    // brought to 40% of the viewport (a tall open turn centred would put it
    // off screen, and at the very top a sticky prompt covers it).
    await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const row = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1).querySelector('[data-mg-head][data-mg-steps]')
      const box = v.getBoundingClientRect()

      v.scrollTop += row.getBoundingClientRect().top - (box.top + box.height * 0.4)
    }, VIEWPORT)
    await sleep(400)

    const again = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const row = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1).querySelector('[data-mg-head][data-mg-steps]')
      const rect = row.getBoundingClientRect()

      return { x: rect.x + 60, y: rect.y + 14, under: document.elementFromPoint(rect.x + 60, rect.y + 14)?.closest('[data-slot]')?.dataset.slot }
    }, VIEWPORT)

    entry.evidence.closePress = again
    await sleep(300)
    await page.mouse.click(again.x, again.y)
    await sleep(700)
    entry.evidence.closedAgain = await page.evaluate(() => !document.querySelector('[data-mg-open]'))
    must(entry.evidence.closedAgain, 'a second press did not close the fold')
  })

  // ── s4. Scrolled up while a turn ends ─────────────────────────────────────
  await check('s4', async (entry, must) => {
    const box = await viewportBox()

    // a. Far up, reading older turns.
    await scrollToBottom()
    await sleep(300)
    await type('Scrolled far up. ID=U1 MGS_WORK(4,0.6)', 'Enter')
    await sleep(1200)
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2)

    for (let step = 0; step < 8; step += 1) {
      await page.mouse.wheel(0, -400)
      await sleep(40)
    }

    await sleep(500)
    entry.evidence.farTracked = await trackMiddle()
    must(entry.evidence.farTracked, 'nothing to track in the middle of the viewport')
    await start('scrolled-far')
    await watchFor('Done U1.')
    await waitStreamEnd('U1')
    await sleep(3000)

    const far = await stop()
    const farMoves = moves(far.frames)

    keep.scrolled = far
    entry.evidence.far = { trackedMoves: farMoves.slice(0, 8), writes: far.writes.slice(0, 8), ...summarise(far) }
    must(farMoves.length === 0, `far up: what was being read moved ${farMoves.length} times without input: ${farMoves.slice(0, 5).map(move => `${move.delta}px @${move.t}ms`).join(', ')}`)

    // b. Just above the bottom, reading the answer while it streams in, with
    // the turn's work above it. The worst case for a fold.
    await scrollToBottom()
    await sleep(300)
    await type('Reading the answer. ID=U2 MGS_WORK(3,0.3) MGS_SLOWANSWER', 'Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].some(node => (node.textContent ?? '').includes('Notes on turn U2')), undefined, { timeout: 60_000 })
    await sleep(400)
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
    await page.mouse.wheel(0, -160)
    await sleep(400)
    entry.evidence.nearTracked = await page.evaluate(() => {
      const heading = [...document.querySelectorAll('h2')].find(node => (node.textContent ?? '').includes('Notes on turn U2'))

      window.__mgStab.track(heading)

      return heading ? `h2 at ${Math.round(heading.getBoundingClientRect().top)}` : null
    })
    await start('scrolled-near')
    await watchFor('Done U2.')
    await waitStreamEnd('U2')
    await sleep(3000)

    const near = await stop()
    const nearMoves = moves(near.frames)
    const deferredFold = await lastPairInfo()

    entry.evidence.near = {
      following: [...new Set(near.frames.map(frame => frame[F.following]))],
      trackedMoves: nearMoves.slice(0, 8),
      writes: near.writes.slice(0, 8),
      foldWhileInView: { marked: deferredFold.marked, rows: deferredFold.rows, toolsShown: deferredFold.toolsShown },
      ...summarise(near)
    }
    must(nearMoves.length === 0, `near the bottom: what was being read moved ${nearMoves.length} times without input: ${nearMoves.slice(0, 5).map(move => `${move.delta}px @${move.t}ms${move.running ? ' (running)' : ''}`).join(', ')}`)
    must(deferredFold.marked === 0 && deferredFold.toolsShown > 0, `the turn being read folded under the reader: ${JSON.stringify(entry.evidence.near.foldWhileInView)}`)
    must(entry.evidence.near.ourWorstScriptMs <= 50, `a Monograph script ran ${entry.evidence.near.ourWorstScriptMs}ms inside a long frame`)
    await shot(entry, 's4-scrolled-up-reading')

    // Back to the bottom: the deferred fold happens now.
    await page.mouse.wheel(0, 2000)
    await sleep(1500)

    const later = await lastPairInfo()

    entry.evidence.afterReturningToBottom = { marked: later.marked, rows: later.rows, toolsShown: later.toolsShown }
    must(later.marked === later.rows && later.toolsShown === 0, `back at the bottom, the finished turn is still not folded: ${JSON.stringify(entry.evidence.afterReturningToBottom)}`)
  })

  // ── s5. Queued prompt behind a running turn ────────────────────────────────
  await check('s5', async (entry, must) => {
    await scrollToBottom()
    await sleep(300)
    await start('queue')
    await type('Held turn. ID=Q1 MGS_HOLD', 'Enter')
    await within(mock.waitForHeldStream(), 60_000, 'the model never received the held prompt')
    await page.waitForFunction(running => Boolean(document.querySelector(running)), RUNNING, { timeout: 15_000 })
    // Long enough to fold (item 6 of w5-turns: the fold must show whole lines).
    await type(`Queued turn. ID=Q2 MGS_WORK(3,0.4) ${'This queued prompt is long on purpose, so that its bubble folds to a few lines. '.repeat(8).trim()}`, 'Control+Enter')
    await sleep(4000)


    const releasedAt = Date.now()

    mock.releaseHeldStream()
    // (Its bubble is drawn when its turn starts.) The queued bubble folds to a whole number of its own lines, and a
    // press unfolds and folds it again.
    const clampOf = () =>
      page.evaluate(() => {
        const node = [...document.querySelectorAll('[data-mg-queued]')].find(item => (item.textContent ?? '').includes('ID=Q2'))
        const clamp = node?.querySelector('[data-mg-clamp]')
        const text = clamp?.querySelector('[data-slot="aui_user-message-text"]')

        if (!clamp || !text) {
          return node
            ? { missing: clamp ? 'text' : 'clamp', html: node.outerHTML.replace(/class="[^"]*"/g, '').slice(0, 400) }
            : { missing: 'bubble', bubbles: [...document.querySelectorAll('[data-mg-queued]')].map(item => (item.textContent ?? '').slice(0, 40)) }
        }

        node.scrollIntoView({ block: 'center' })

        const box = clamp.getBoundingClientRect()
        const line = parseFloat(getComputedStyle(text).lineHeight)

        return { folded: clamp.classList.contains('sticky-human-clamp'), long: 'mgLong' in node.dataset, height: Math.round(box.height * 100) / 100, line, lines: Math.round((box.height / line) * 100) / 100, x: box.x + box.width / 2, y: box.y + Math.min(10, box.height / 2) }
      })
    // Monograph draws the queued bubble when its turn starts (Hermes draws
    // none) until Hermes swaps in the stored rows: measure it then.
    await page.waitForFunction(() => [...document.querySelectorAll('[data-mg-queued]')].some(item => (item.textContent ?? '').includes('ID=Q2')), undefined, { polling: 50, timeout: 15_000 }).catch(() => undefined)
    const clamped = await clampOf()

    entry.evidence.clamp = clamped

    if (clamped && !clamped.missing) {
      await page.mouse.click(clamped.x, clamped.y)
      await sleep(400)
      clamped.unfolded = await clampOf()
      await page.mouse.click(clamped.unfolded?.x ?? clamped.x, clamped.unfolded?.y ?? clamped.y)
      await sleep(400)
      clamped.refolded = await clampOf()
    }
    await waitStreamEnd('Q2')
    await sleep(2500)

    const rec = await stop()


    // Fold marks set while Q1 was still held are marks on a running reply.
    const early = rec.segHistory.flatMap(({ list, row }) => list.filter(item => item.v !== '-' && item.v !== 'stale' && item.wall < releasedAt && item.turn === 'Q1').map(item => ({ ...item, row })))
    const flapping = flaps(rec.segHistory)
    const bubble = await page.evaluate(() => [...document.querySelectorAll('[data-mg-queued]')].map(node => (node.textContent ?? '').trim().slice(0, 60)))
    const decisions = await page.evaluate(since => (window.__mgTrace ?? []).filter(item => item.at >= since), rec.wall0)

    entry.evidence.decisions = decisions.slice(-12).map(item => ({ ...item, at: item.at - rec.wall0 }))

    Object.assign(entry.evidence, {
      marksWhileHeld: early.slice(0, 6),
      flappingRows: flapping.slice(0, 4).map(({ list }) => list.map(item => `${item.v}@${item.t}`).join(' ')),
      queuedBubbles: bubble,
      ...summarise(rec)
    })
    must(clamped?.long && clamped.folded, `the long queued prompt did not fold: ${JSON.stringify(clamped)?.slice(0, 300)}`)
    must(clamped && Math.abs(clamped.height - Math.round(clamped.height / clamped.line) * clamped.line) <= 1, `the folded queued prompt shows ${clamped?.lines} lines (cut through a line): ${JSON.stringify(clamped)}`)
    must(clamped?.unfolded && !clamped.unfolded.folded && clamped.unfolded.height > clamped.height + clamped.line, `a press did not unfold the queued prompt: ${JSON.stringify(clamped?.unfolded)}`)
    must(clamped?.refolded?.folded && Math.abs(clamped.refolded.height - clamped.height) <= 1, `a second press did not fold it again: ${JSON.stringify(clamped?.refolded)}`)
    must(early.length === 0, `${early.length} fold marks were put on the reply while it was still running (held by the model)`)
    must(flapping.length === 0, `${flapping.length} reply rows were folded, unfolded and folded again`)
    must(entry.evidence.ourWorstScriptMs <= 50, `a Monograph script ran ${entry.evidence.ourWorstScriptMs}ms inside a long frame`)
    await shot(entry, 's5-queued')
  })

  // ── s6. Session switch in the middle of a turn ────────────────────────────
  await check('s6', async (entry, must) => {
    const session = await page.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0] ?? ''))

    entry.evidence.session = session ? 'known' : 'none'
    must(session, 'no session id in the URL')

    await type('Switch away. ID=W1 MGS_WORK(2,4)', 'Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="tool-block"]')].some(node => (node.textContent ?? '').includes('step-W1') || node.closest('[data-slot="aui_turn-pair"]')?.textContent?.includes('ID=W1')), undefined, { timeout: 30_000 }).catch(() => undefined)
    await sleep(1200)
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(2000)
    await page.evaluate(id => {
      window.location.hash = `#/${id}`
    }, session)
    await start('switch-back')
    await waitStreamEnd('W1', 60_000)
    await sleep(2500)

    const rec = await stop()

    const drawn = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const shown = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
      const prompts = [...v.querySelectorAll('[data-slot="aui_user-message-root"]')].filter(node => (node.textContent ?? '').includes('ID=W1'))
      const answers = [...v.querySelectorAll('[data-slot="aui_assistant-message-root"]')].filter(node => (node.textContent ?? '').includes('Done W1.'))

      return {
        prompts: prompts.length,
        promptsShown: prompts.filter(shown).length,
        answers: answers.length,
        answersShown: answers.filter(shown).length,
        stale: v.querySelectorAll('[data-mg-stale]').length
      }
    }, VIEWPORT)

    Object.assign(entry.evidence, { drawn, foldFlaps: flaps(rec.segHistory).length, ...summarise(rec) })

    if (!drawn.stale && drawn.prompts === 1 && drawn.answers === 1) {
      results.observations.push('s6: Hermes left no live copy beside the stored turn in this run (data-mg-stale = 0), so the left-over-copy rule was not exercised; the check only proves the turn is drawn once.')
    }

    must(drawn.promptsShown === 1, `the prompt is visible ${drawn.promptsShown} times`)
    must(drawn.answersShown === 1, `the answer is visible ${drawn.answersShown} times`)
    must(entry.evidence.foldFlaps === 0, `${entry.evidence.foldFlaps} rows folded, unfolded and folded again`)
    await shot(entry, 's6-switch-back')
  })

  // ── s7. Animations ────────────────────────────────────────────────────────
  await check('s7', async (entry, must) => {
    const phases = [keep.build, keep.pinned, keep.scrolled].filter(Boolean)
    const replays = phases.flatMap(rec => rec.replays)
    const historyAnims = phases.flatMap(rec => rec.animStarts.filter(start => start.inThread && !start.inRunning && /^(mg|mf)-/.test(start.name)))
    const outside = phases.flatMap(rec => rec.replaysOutside)

    if (outside.length) {
      results.observations.push(
        `s7: outside the chat, animations restart on every turn: ${[...new Set(outside.map(replay => `${replay.name} on ${replay.node}`))].join('; ')} (not in this workstream's files; also not stopped by motion off)`
      )
    }

    entry.evidence.replaysInEarlierPhases = replays.slice(0, 10)
    entry.evidence.oursOutsideRunningTurn = historyAnims.length
    entry.evidence.namesOutsideRunningTurn = [...new Set(historyAnims.map(start => start.name))]
    must(replays.length === 0, `${replays.length} element animations started more than once: ${replays.slice(0, 4).map(replay => `${replay.name} on ${replay.node} x${replay.count}`).join('; ')}`)

    // An arrival that starts on something not on screen (a tool row folded
    // away at the end of a turn) is a replay nobody sees, and a cost.
    const hiddenArrivals = phases.flatMap(rec => rec.animStarts.filter(start => start.hidden && start.inThread && /^(mg|mf)-/.test(start.name) && start.name !== 'mg-fold'))

    entry.evidence.arrivalsWhileHidden = hiddenArrivals.slice(0, 6)
    must(hiddenArrivals.length === 0, `${hiddenArrivals.length} arrivals of ours started on hidden elements: ${hiddenArrivals.slice(0, 3).map(start => `${start.name} on ${start.node} @${start.t}`).join('; ')}`)

    // Sending a new prompt must not unfold the turn before it, even for a
    // frame: no reply row of a finished turn goes from folded to undressed.
    const unfolded = (keep.build?.segHistory ?? []).filter(({ list }) => list.some((step, index) => step.v === 'closed' && list.slice(index + 1).some(later => later.v === '-')))

    entry.evidence.finishedTurnsUnfoldedOnSend = unfolded.slice(0, 4).map(({ row, list }) => ({ row, list: list.slice(0, 6) }))
    must(unfolded.length === 0, `${unfolded.length} rows of finished turns lost their fold while later prompts were sent (first: ${JSON.stringify(unfolded[0]?.list.slice(0, 4))})`)

    // Motion off: a turn with work, nothing of ours may animate.
    await scrollToBottom()
    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'off'
    })
    await start('motion-off')
    await type('Motion off. ID=M1 MGS_WORK(2,0.2)', 'Enter')
    await waitStreamEnd('M1')
    await sleep(1500)

    const off = await stop()
    // The rule is about time on screen, not presence: with motion off or
    // reduced, an animation of ours may exist (an entrance cut to 0.01ms by
    // the kill switch) but may not run longer than 1 ms.
    const longerThan1ms = start => !(start.endMs <= 1)
    const offSeen = off.animStarts.filter(start => start.inThread && /^(mg|mf)-/.test(start.name))
    const offOurs = offSeen.filter(longerThan1ms)

    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'on'
    })

    // Reduced motion, the system setting.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start('reduced')
    await type('Reduced motion. ID=M2 MGS_WORK(2,0.2)', 'Enter')
    await waitStreamEnd('M2')
    await sleep(1500)

    const reduced = await stop()
    const reducedSeen = reduced.animStarts.filter(start => start.inThread && /^(mg|mf)-/.test(start.name))
    const reducedOurs = reducedSeen.filter(longerThan1ms)

    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // Motion on: streamed blocks animate once each.
    await start('motion-on')
    await type('Motion on. ID=M3 MGS_WORK(2,0.2)', 'Enter')
    await waitStreamEnd('M3')
    await sleep(1500)

    const on = await stop()

    Object.assign(entry.evidence, {
      motionOff: { ours: offOurs.length, names: [...new Set(offOurs.map(start => start.name))], transitions: off.transStarts, cutTo1ms: offSeen.map(start => `${start.name} end ${start.endMs}ms dur ${start.durationMs}ms fill ${start.fill}`).slice(0, 6) },
      reducedMotion: { ours: reducedOurs.length, names: [...new Set(reducedOurs.map(start => start.name))], transitions: reduced.transStarts, cutTo1ms: reducedSeen.map(start => `${start.name} end ${start.endMs}ms dur ${start.durationMs}ms fill ${start.fill}`).slice(0, 6) },
      motionOn: { ours: on.animStarts.filter(start => start.inThread && /^(mg|mf)-/.test(start.name)).length, replays: on.replays.slice(0, 6) }
    })
    must(entry.evidence.motionOn.ours > 0, 'no streamed block animated with motion on (the check would prove nothing)')
    must(offOurs.length === 0, `${offOurs.length} Monograph animations ran longer than 1 ms with motion off: ${offOurs.slice(0, 4).map(start => `${start.name} ${start.endMs}ms`).join(', ')}`)
    must(reducedOurs.length === 0, `${reducedOurs.length} Monograph animations ran longer than 1 ms under reduced motion: ${reducedOurs.slice(0, 4).map(start => `${start.name} ${start.endMs}ms`).join(', ')}`)
    must(on.replays.length === 0, `${on.replays.length} animations replayed with motion on`)
  })

  // ── s8. Compaction note ───────────────────────────────────────────────────
  await check('s8', async (entry, must) => {
    await scrollToBottom()
    await type('[CONTEXT COMPACTION] Earlier turns were summarised to save room. The summary follows. ID=C1', 'Enter')
    await waitStreamEnd('C1')
    await sleep(800)

    const note = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const row = [...v.querySelectorAll('[data-slot="aui_user-message-root"]')].find(node => (node.textContent ?? '').includes('ID=C1'))

      if (!row) {
        return null
      }

      row.scrollIntoView({ block: 'center' })

      const text = row.querySelector('[data-slot="aui_user-message-text"]')
      const rect = row.getBoundingClientRect()
      const target = row.querySelector('.composer-human-message') ?? row

      return {
        marked: 'mgCompaction' in row.dataset,
        height: Math.round(rect.height),
        textShown: text ? text.checkVisibility() && text.getBoundingClientRect().height > 0 : null,
        label: getComputedStyle(row, '::before').content,
        labelInner: getComputedStyle(target, '::before').content
      }
    }, VIEWPORT)

    entry.evidence.closed = note
    must(note?.marked, 'the compaction note carries no data-mg-compaction')
    must(note && note.height <= 40, `the closed note is ${note?.height}px tall, expected one line`)
    must(note && /Context compacted/.test(`${note.label}${note.labelInner}`), 'no "Context compacted" line')
    must(note && note.textShown === false, 'the note text is shown while closed')
    await sleep(300)

    const box = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const row = v.querySelector('[data-mg-compaction]')
      const rect = row?.getBoundingClientRect()

      return rect ? { x: rect.right - 60, y: rect.top + rect.height / 2 } : null
    }, VIEWPORT)

    if (box) {
      await page.mouse.click(box.x, box.y)
      await sleep(500)
    }

    const opened = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const row = v.querySelector('[data-mg-compaction]')
      const text = row?.querySelector('[data-slot="aui_user-message-text"]')

      return row ? { open: row.dataset.mgCompaction === 'open', textShown: Boolean(text?.checkVisibility() && text.getBoundingClientRect().height > 0), height: Math.round(row.getBoundingClientRect().height) } : null
    }, VIEWPORT)

    entry.evidence.afterClick = opened
    must(opened?.open && opened.textShown, 'a click did not open the note')
    await shot(entry, 's8-compaction-open')
  })

  // ── s9. Our own observers ────────────────────────────────────────────────
  await check('s9', async (entry, must) => {
    const phases = { build: keep.build, pinned: keep.pinned, scrolled: keep.scrolled }

    for (const [name, rec] of Object.entries(phases)) {
      if (rec) {
        entry.evidence[name] = rec.perf ?? 'no counters (window.__mgPerf missing)'
      }
    }

    const all = Object.values(phases).filter(Boolean).map(rec => rec.perf).filter(Boolean)

    must(all.length, 'the plugin publishes no run counters (window.__mgPerf)')

    for (const perf of all) {
      for (const [name, counter] of Object.entries(perf)) {
        if (name !== 'layoutReads') {
          must(counter.selfMax <= 16, `${name}: one run took ${counter.selfMax}ms of its own (${counter.max}ms with layout reads)`)
        }
      }
    }

    entry.evidence.note = 'selfMax: script time of one run, without the layout it forced; layoutReads: the forced layouts (Hermes\' own layout, done earlier than the browser would)'
  })

  // ── s10. Model pill ──────────────────────────────────────────────────────
  // The mock model has no vendor logo, so the label is swapped in the DOM to
  // a German one naming Anthropic (Hermes' own wording, "Modell · …"), and the
  // effort menu is opened with a real click. Only the colour lookup and the
  // marker are proven; a real tile on another vendor is not.
  await check('s10', async (entry, must) => {
    const pill = await page.evaluate(() => {
      const effort = document.querySelector('[data-testid="reasoning-pill"]')
      const model = document.querySelector('[data-mg-pill]')

      return { effort: Boolean(effort), marked: Boolean(model), label: model?.getAttribute('aria-label') ?? null, tour: model?.dataset.tour ?? null }
    })

    entry.evidence.pill = pill
    must(pill.marked, 'no model pill carries data-mg-pill')

    const open = async () => {
      const box = await page.locator('[data-testid="reasoning-pill"]').first().boundingBox()

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(500)

      const seen = await page.evaluate(() => ({
        colour: document.documentElement.style.getPropertyValue('--mg-model').trim(),
        menu: Boolean(document.querySelector('[data-testid="reasoning-pill"][aria-expanded="true"]'))
      }))

      await page.keyboard.press('Escape')
      await sleep(300)

      return seen
    }

    entry.evidence.mockModel = await open()
    must(entry.evidence.mockModel.menu, 'the effort menu did not open')
    must(entry.evidence.mockModel.colour === '#9a9a9e', `--mg-model is ${JSON.stringify(entry.evidence.mockModel.colour)} for a model with no logo, expected the neutral #9a9a9e`)

    await page.evaluate(() => document.querySelector('[data-mg-pill]')?.setAttribute('aria-label', 'Modell · Anthropic: claude-sonnet'))
    entry.evidence.germanLabel = await open()
    must(entry.evidence.germanLabel.colour.toUpperCase() === '#D97757', `--mg-model is ${JSON.stringify(entry.evidence.germanLabel.colour)} for "Modell · Anthropic: …", expected #D97757`)
  })

  // ── s14. Reasoning in a later turn, and after a session switch ──────────
  // s3 proves reasoning is drawn while the first reasoning turn of the
  // session streams. The owner's "thinking not showing" was intermittent, so
  // the same is asked of a second turn in that session, of a turn in another
  // session reached by a switch, and of a turn back in the first session.
  const sampleThinking = async id => {
    const during = []
    const began = Date.now()
    let pressed = null

    while (Date.now() - began < 120_000) {
      const now = await lastPairInfo()
      const done = now.text.includes(`Done ${id}.`)

      during.push({ ...now, done, ms: Date.now() - began, pressed: Boolean(pressed), text: undefined, wall: Date.now() })

      if (done) {
        break
      }

      // Simple mode rests reasoning collapsed; press it open once, as s2 does.
      // Not when it has already shown itself unpressed (a turn of several
      // reasoning blocks has moments between them with nothing open).
      if (!pressed && now.turn === id && now.thinkingShown && !now.bodyChars && !during.some(sample => sample.turn === id && sample.bodyChars > 0)) {
        const header = await page.evaluate(viewport => {
          const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
          const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1)
          const button = [...pair.querySelectorAll('[data-slot="aui_thinking-disclosure"] button[aria-expanded="false"]')].at(-1)
          const rect = button?.getBoundingClientRect()

          return rect && rect.height > 0 && rect.top > v.getBoundingClientRect().top && rect.bottom < v.getBoundingClientRect().bottom ? { x: rect.x + 30, y: rect.y + rect.height / 2 } : null
        }, VIEWPORT)

        if (header) {
          await page.mouse.click(header.x, header.y)
          pressed = { ms: Date.now() - began }
        }
      }

      await sleep(150)
    }

    const modelEnd = mock.log.filter(item => item.id === id && item.kind === 'end').at(-1)?.at ?? Infinity
    const running = during.filter(sample => !sample.done && sample.wall < modelEnd && sample.turn === id)
    const openByDefault = running.some(sample => !sample.pressed && sample.bodyChars > 0)
    const afterPress = openByDefault ? running : running.filter(sample => sample.pressed)
    const chars = afterPress.map(sample => sample.bodyChars)

    return {
      samples: running.length,
      withThinkingHeader: running.filter(sample => sample.thinkingShown > 0).length,
      pressed: Boolean(pressed),
      openByDefault,
      withReasoningBody: afterPress.filter(sample => sample.bodyChars > 0).length,
      maxChars: Math.max(0, ...chars),
      maxLiveLines: Math.max(0, ...running.map(sample => sample.liveLines ?? 0)),
      // Open by default, each block folds when the next part starts: what
      // may not happen is a block's text going while that block still
      // streams. Opened by a press: the open text may not go at all.
      vanished: openByDefault
        ? running.filter((sample, index) => index > 0 && running[index - 1].pendingChars > 0 && sample.pending > 0 && sample.pendingChars === 0 && sample.thinking === running[index - 1].thinking).length
        : chars.filter((value, index) => index > 0 && chars[index - 1] > 0 && value === 0).length,
      markedWhileRunning: running.filter(sample => sample.marked > 0).length
    }
  }

  const judgeThinking = (must, label, seen) => {
    must(seen.withThinkingHeader >= 3, `${label}: a Thinking block was on screen in ${seen.withThinkingHeader} samples while the turn ran`)
    must(seen.pressed || seen.openByDefault, `${label}: the Thinking header was never on screen to press while the turn ran`)
    // w5-turns item 4b: the reasoning shows as it streams, with no press, in
    // Simple mode too.
    must(seen.openByDefault, `${label}: the reasoning did not show while it streamed until it was pressed open`)
    must(seen.maxLiveLines <= 4.2, `${label}: the live reasoning showed ${seen.maxLiveLines} lines, at most four expected`)
    must(seen.withReasoningBody >= 2, `${label}: the reasoning body was drawn in ${seen.withReasoningBody} samples while the turn ran`)
    must(seen.maxChars > 120, `${label}: the reasoning drawn while running never grew past 120 characters (${seen.maxChars})`)
    must(seen.vanished === 0, `${label}: the open reasoning vanished ${seen.vanished} times while the turn ran`)
    must(seen.markedWhileRunning === 0, `${label}: the running turn carried fold marks in ${seen.markedWhileRunning} samples`)
  }

  await check('s14', async (entry, must) => {
    const first = await page.evaluate(() => decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0] ?? ''))

    must(first, 'no session id in the URL')

    // A later turn in the same session.
    await scrollToBottom()
    await sleep(300)
    await type('Think again. ID=T2 MGS_WORK(2,0.3) MGS_THINK', 'Enter')
    entry.evidence.sameSession = await sampleThinking('T2')
    judgeThinking(must, 'second reasoning turn, same session', entry.evidence.sameSession)
    await sleep(1500)

    // Switch to another session and think there.
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(1500)
    await type('Think elsewhere. ID=T3 MGS_WORK(2,0.3) MGS_THINK', 'Enter')
    entry.evidence.otherSession = await sampleThinking('T3')
    judgeThinking(must, 'after switching to another session', entry.evidence.otherSession)
    await shot(entry, 's14-other-session')
    await sleep(1500)

    // And back.
    await page.evaluate(id => {
      window.location.hash = `#/${id}`
    }, first)
    await page.waitForFunction(viewport => ([...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)?.textContent ?? '').includes('Done T2.'), VIEWPORT, { timeout: 30_000 })
    await sleep(1500)
    await scrollToBottom()
    await sleep(300)
    await type('Think on return. ID=T4 MGS_WORK(2,0.3) MGS_THINK', 'Enter')
    entry.evidence.backAgain = await sampleThinking('T4')
    judgeThinking(must, 'back in the first session', entry.evidence.backAgain)
    await shot(entry, 's14-back-again')
  })

  // ── s11. The count on the line ────────────────────────────────────────────
  // 7 terminal calls and 3 connector calls with no words between them: Hermes
  // draws them as runs ("Ran 7 commands") whose rows are not mounted while
  // the run is closed. The line must say 10, live and after a reload, when
  // the turn comes back from history.
  const runInfo = id =>
    page.evaluate(
      ({ id, viewport }) => {
        const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
        const pair = [...(v?.querySelectorAll('[data-slot="aui_turn-pair"]') ?? [])].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes(`ID=${id}`))
        const head = pair?.querySelector('[data-mg-head]')

        return pair
          ? {
              steps: head?.dataset.mgSteps ?? null,
              worked: head?.dataset.mgWorked ?? null,
              label: head?.getAttribute('aria-label') ?? null,
              topBlocks: pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > [data-slot="tool-block"]').length,
              runs: pair.querySelectorAll('[data-tool-group]').length,
              rowsMounted: pair.querySelectorAll('[data-tool-row]').length,
              summaries: [...pair.querySelectorAll('[data-tool-summary]')].map(node => (node.textContent ?? '').trim().slice(0, 60))
            }
          : null
      },
      { id, viewport: VIEWPORT }
    )

  const waitSteps = id =>
    page
      .waitForFunction(
        ({ id, viewport }) => {
          const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
          const pair = [...(v?.querySelectorAll('[data-slot="aui_turn-pair"]') ?? [])].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes(`ID=${id}`))

          return Boolean(pair?.querySelector('[data-mg-head][data-mg-steps]'))
        },
        { id, viewport: VIEWPORT },
        { polling: 100, timeout: 20_000 }
      )
      .catch(() => undefined)

  await check('s11', async (entry, must) => {
    await scrollToBottom()
    await sleep(300)
    await type('Counted calls. ID=K1 MGS_RUN(7,3)', 'Enter')
    await waitStreamEnd('K1')
    await waitSteps('K1')
    await sleep(800)
    entry.evidence.live = await runInfo('K1')
    must(/^10 tool calls\b/.test(entry.evidence.live?.steps ?? ''), `live: the line says ${JSON.stringify(entry.evidence.live?.steps)} for 10 calls`)

    await page.reload()
    await waitForAppReady({ app: state.app, page }, 60_000)
    await page.waitForFunction(viewport => ([...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)?.textContent ?? '').includes('Done K1.'), VIEWPORT, { timeout: 60_000 })
    await waitSteps('K1')
    await sleep(800)
    entry.evidence.afterReload = await runInfo('K1')
    must(/^10 tool calls\b/.test(entry.evidence.afterReload?.steps ?? ''), `after a reload: the line says ${JSON.stringify(entry.evidence.afterReload?.steps)} for 10 calls`)

    if ((entry.evidence.afterReload?.rowsMounted ?? 0) >= 10) {
      results.observations.push('s11: every row of the run was mounted after the reload, so the count did not depend on reading Hermes\' run summaries.')
    }

    await shot(entry, 's11-counted')
  })

  // ── s12. The line from the keyboard ──────────────────────────────────────
  const headState = id =>
    page.evaluate(
      ({ id, viewport }) => {
        const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
        const pair = [...(v?.querySelectorAll('[data-slot="aui_turn-pair"]') ?? [])].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes(`ID=${id}`))
        const head = pair?.querySelector('[data-mg-head][data-mg-steps]')

        if (!head) {
          return null
        }

        // The line is an element of ours right before the row (div.mg-line);
        // the row is the button, the ring is drawn on the line.
        const line = head.previousElementSibling?.classList.contains('mg-line') ? head.previousElementSibling : null
        const ring = line ? getComputedStyle(line) : { outlineStyle: 'no line', outlineWidth: '0', outlineColor: '' }
        // No generated box on any reply row or response group (any one makes
        // every frame of a long reply expensive; see 33-turns.css).
        const boxes = [...v.querySelectorAll('[data-slot="aui_assistant-message-root"], [data-slot="aui_response-group"]')].flatMap(node =>
          ['::before', '::after'].filter(pseudo => getComputedStyle(node, pseudo).content !== 'none').map(pseudo => (node.dataset.slot ?? '') + pseudo)
        )
        const shown = node => node.checkVisibility() && node.getBoundingClientRect().height > 0

        return {
          focused: document.activeElement === head,
          role: head.getAttribute('role'),
          tabindex: head.getAttribute('tabindex'),
          expanded: head.getAttribute('aria-expanded'),
          label: head.getAttribute('aria-label'),
          open: 'mgOpen' in head.dataset,
          toolsShown: [...pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > [data-slot="tool-block"]')].filter(shown).length,
          ring: { style: ring.outlineStyle, width: ring.outlineWidth, color: ring.outlineColor },
          text: line?.textContent.replace(/\ueab6/g, '').trim() ?? null,
          boxes: [...new Set(boxes)],
          scrollTop: Math.round(v.scrollTop)
        }
      },
      { id, viewport: VIEWPORT }
    )

  const grayscale = colour => {
    const parts = (colour ?? '').match(/[\d.]+/g)?.map(Number) ?? []

    return parts.length >= 3 && Math.max(parts[0], parts[1], parts[2]) - Math.min(parts[0], parts[1], parts[2]) <= 3
  }

  await check('s12', async (entry, must) => {
    // From the message box, Shift+Tab back into the thread until the line
    // of K1 (the last turn) has focus.
    await page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first().click()

    let presses = 0

    for (; presses < 80; presses += 1) {
      await page.keyboard.press('Shift+Tab')
      await sleep(30)

      if ((await headState('K1'))?.focused) {
        break
      }
    }

    const focused = await headState('K1')

    entry.evidence.shiftTabs = presses + 1
    entry.evidence.focused = focused
    must(focused?.focused, `Shift+Tab from the message box never reached the "Worked for" line (${presses} presses)`)
    must(focused?.role === 'button' && focused.tabindex === '0', `the line is not a button in the tab order: role ${focused?.role}, tabindex ${focused?.tabindex}`)
    must(focused?.expanded === 'false' && /^Worked for /.test(focused?.label ?? ''), `the closed line should say aria-expanded="false" and be labelled "Worked for …": ${focused?.expanded}, ${JSON.stringify(focused?.label)}`)
    must(focused?.ring.style !== 'none' && parseFloat(focused?.ring.width ?? '0') >= 1, `no focus ring on the line: ${JSON.stringify(focused?.ring)}`)
    must(grayscale(focused?.ring.color), `the focus ring is not gray: ${focused?.ring.color}`)
    must(/^Worked for \S/.test(focused?.text ?? ''), `the line reads ${JSON.stringify(focused?.text)}`)
    must(focused && focused.boxes.length === 0, `generated boxes on reply rows: ${JSON.stringify(focused?.boxes)}`)
    await shot(entry, 's12-line-focused')

    await page.keyboard.press('Enter')
    await sleep(800)
    entry.evidence.afterEnter = await headState('K1')
    must(entry.evidence.afterEnter?.open && entry.evidence.afterEnter.expanded === 'true' && entry.evidence.afterEnter.toolsShown > 0, `Enter did not open the work: ${JSON.stringify(entry.evidence.afterEnter)}`)
    must(entry.evidence.afterEnter?.focused, 'focus left the line on Enter')

    await page.keyboard.press(' ')
    await sleep(800)
    entry.evidence.afterSpace = await headState('K1')
    must(entry.evidence.afterSpace && !entry.evidence.afterSpace.open && entry.evidence.afterSpace.expanded === 'false' && entry.evidence.afterSpace.toolsShown === 0, `Space did not close the work: ${JSON.stringify(entry.evidence.afterSpace)}`)
    must(entry.evidence.afterSpace?.focused, 'focus left the line on Space')

    await page.keyboard.press(' ')
    await sleep(800)
    entry.evidence.afterSecondSpace = await headState('K1')
    must(entry.evidence.afterSecondSpace?.open && entry.evidence.afterSecondSpace.expanded === 'true', `Space did not open the work again: ${JSON.stringify(entry.evidence.afterSecondSpace)}`)
  })

  // ── s13. Opened work: run headers and rhythm ─────────────────────────────
  await check('s13', async (entry, must) => {
    // Open the work with a press on the line (not by keyboard: s12 judges that).
    if (!(await headState('K1'))?.open) {
      const line = await page.evaluate(viewport => {
        const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
        const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes('ID=K1'))
        const head = pair?.querySelector('[data-mg-head][data-mg-steps]')

        head?.scrollIntoView({ block: 'center' })

        const rect = head?.getBoundingClientRect()

        return rect ? { x: rect.x + 60, y: rect.y + 14 } : null
      }, VIEWPORT)

      if (line) {
        await page.mouse.click(line.x, line.y)
        await sleep(900)
      }
    }

    // Open every run of the turn, as a reader would.
    const summaries = page.locator('[data-slot="aui_turn-pair"]:has([data-mg-open]) [data-tool-summary] button[aria-expanded="false"]').filter({ visible: true })

    for (let index = 0; index < 6 && (await summaries.count()); index += 1) {
      await summaries.first().scrollIntoViewIfNeeded()
      await summaries.first().click()
      await sleep(400)
    }

    // Measured at rest: no pointer over the work, no keyboard focus in it.
    await page.mouse.move(2, 400)
    await page.evaluate(() => document.activeElement?.blur?.())
    await sleep(300)

    const m = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].find(node => node.querySelector('[data-mg-open]'))

      if (!pair) {
        return { runs: [], looseRowHeights: [] }
      }

      const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      const rgba = colour => {
        paint.clearRect(0, 0, 1, 1)
        paint.fillStyle = '#000'
        paint.fillStyle = colour
        paint.fillRect(0, 0, 1, 1)

        const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data

        return [r, g, b, a / 255]
      }
      const lum = ([r, g, b]) => {
        const c = value => ((value /= 255) <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)

        return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
      }
      const canvas = rgba(getComputedStyle(document.documentElement).getPropertyValue('--mg-canvas').trim() || '#000')
      const opacity = node => {
        let value = 1

        for (let at = node; at && at !== document.documentElement; at = at.parentElement) {
          value *= parseFloat(getComputedStyle(at).opacity)
        }

        return value
      }
      const contrast = node => {
        const [r, g, b, a] = rgba(getComputedStyle(node).color)
        const alpha = a * opacity(node)
        const seen = [r, g, b].map((value, index) => value * alpha + canvas[index] * (1 - alpha))
        const [hi, lo] = [lum(seen), lum(canvas)].sort((x, y) => y - x)

        return { colour: seen.map(Math.round).join(','), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }
      }
      const runs = [...pair.querySelectorAll('[data-tool-group]')].map(run => {
        const summary = run.querySelector('[data-tool-summary]')
        const text = [...(summary?.querySelectorAll('*') ?? [])].find(node => node.childElementCount === 0 && (node.textContent ?? '').trim())
        const rows = [...run.querySelectorAll('[data-tool-row]')].map(row => row.getBoundingClientRect())

        return {
          summary: (summary?.textContent ?? '').trim().slice(0, 50),
          header: text ? contrast(text) : null,
          headerTop: summary ? Math.round(summary.getBoundingClientRect().top) : null,
          rowTops: rows.map(rect => Math.round(rect.top)),
          rowHeights: rows.map(rect => Math.round(rect.height))
        }
      })
      const loose = [...pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > [data-slot="tool-block"][data-tool-row]')].map(row => Math.round(row.getBoundingClientRect().height))

      return { runs, looseRowHeights: loose }
    }, VIEWPORT)

    await shot(entry, 's13-opened-work')

    const pitches = m.runs.flatMap(run => run.rowTops.slice(1).map((top, index) => top - run.rowTops[index]))
    const heights = [...m.runs.flatMap(run => run.rowHeights), ...m.looseRowHeights]
    // From a run's header to its first row: the same step as from row to row.
    const leads = m.runs.filter(run => run.headerTop !== null && run.rowTops.length).map(run => run.rowTops[0] - run.headerTop)

    Object.assign(entry.evidence, { runs: m.runs, looseRowHeights: m.looseRowHeights, pitches: [...new Set(pitches)], rowHeights: [...new Set(heights)], headerToFirstRow: leads })
    must(m.runs.length > 0 && m.runs.some(run => run.header), 'no opened work with a run header in it (the line did not open)')

    for (const run of m.runs.filter(item => item.header)) {
      must(run.header.ratio >= 4.5, `run header "${run.summary}" is ${run.header.ratio}:1 on the canvas (drawn as ${run.header.colour}), needs 4.5`)
    }

    must(pitches.length >= 3, `too few rows open to measure the rhythm (${pitches.length} steps)`)

    if (pitches.length < 3) {
      return
    }

    must(Math.max(...pitches) - Math.min(...pitches) <= 2, `rows of the opened work are not on one rhythm: steps ${[...new Set(pitches)].join(', ')} px`)
    must(Math.max(...heights) - Math.min(...heights) <= 2, `tool rows differ in height: ${[...new Set(heights)].join(', ')} px`)
    must(leads.every(lead => Math.abs(lead - Math.min(...pitches)) <= 2), `a run's header sits ${leads.join(', ')} px above its first row, rows are ${Math.min(...pitches)} px apart`)
  })

  // ── s15. A sign of life before the first words ───────────────────────────
  // From 300 ms after a prompt is sent until the first text or tool row of
  // its reply, something visible must say the model is working: a Thinking
  // line, Hermes' own status row, or a live-status line. Sampled every frame.
  // (Monograph draws no indicator of its own: its pulsing bar was removed.)
  const signOfLife = (id, sinceSend) =>
    page.evaluate(
      ({ id, viewport, sinceSend }) =>
        new Promise(resolve => {
          const t0 = performance.now() - sinceSend
          const frames = []
          const SIGNS = '[data-slot="aui_thinking-disclosure"], [data-slot="aui_turn-activity"], [data-slot="aui_response-loading"], #mf-live'
          const visible = (node, box) => {
            if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
              return false
            }

            const rect = node.getBoundingClientRect()

            return rect.width > 0 && rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom
          }
          const tick = () => {
            const t = Math.round(performance.now() - t0)
            const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
            const pair = v ? [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes(`ID=${id}`)) : null
            // After a queued prompt, its reply runs on in the pair before it
            // until the queued bubble: the first words after the bubble.
            const bubble = v ? [...v.querySelectorAll('[data-mg-queued]')].find(node => (node.textContent ?? '').includes(`ID=${id}`)) : null
            let rows = pair ? [...pair.querySelectorAll('[data-slot="aui_assistant-message-root"]')] : []

            if (bubble) {
              rows = []

              for (let node = bubble.nextElementSibling; node; node = node.nextElementSibling) {
                if (node.matches('[data-slot="aui_assistant-message-root"]')) {
                  rows.push(node)
                }
              }
            }

            const content = rows.some(row => [...row.querySelectorAll('[data-slot="aui_assistant-message-content"] > .aui-md, [data-slot="aui_assistant-message-content"] > [data-slot="tool-block"]')].some(node => (node.textContent ?? '').trim()))

            if (content || t > 30_000) {
              resolve({ frames, firstContentMs: t, timedOut: !content })

              return
            }

            if (t >= 300 && v) {
              const box = v.getBoundingClientRect()
              const signs = [...v.querySelectorAll(SIGNS)].filter(node => visible(node, box))

              frames.push({ t, sign: signs.length ? (signs[0].className?.toString().slice(0, 20) || signs[0].dataset.slot || signs[0].id) : null })
            }

            requestAnimationFrame(tick)
          }

          tick()
        }),
      { id, viewport: VIEWPORT, sinceSend }
    )

  const judgeLife = (must, label, seen) => {
    const dark = seen.frames.filter(frame => !frame.sign)

    must(!seen.timedOut, `${label}: no words or tool row within 30 s`)
    must(seen.frames.length >= 10, `${label}: only ${seen.frames.length} frames between 300 ms and the first words (the check would prove nothing)`)
    must(dark.length === 0, `${label}: nothing on screen said the model was working in ${dark.length} of ${seen.frames.length} frames (first at ${dark[0]?.t} ms; first words at ${seen.firstContentMs} ms)`)
  }

  const lifeSummary = seen => ({ frames: seen.frames.length, dark: seen.frames.filter(frame => !frame.sign).length, firstDarkMs: seen.frames.find(frame => !frame.sign)?.t ?? null, firstContentMs: seen.firstContentMs, signs: [...new Set(seen.frames.map(frame => frame.sign))] })

  await check('s15', async (entry, must) => {
    await plant('s15')
    // A first prompt in an empty session.
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(1500)
    await type('First words late. ID=L1 MGS_DELAY(2500) MGS_WORK(1,0.2)', 'Enter')

    const first = await signOfLife('L1', 0)

    entry.evidence.emptySession = lifeSummary(first)
    judgeLife(must, 'first prompt in an empty session', first)
    await waitStreamEnd('L1')
    await sleep(1200)

    // The same with tool calls hidden (Monograph's switch).
    const tools = await page.evaluate(() => document.documentElement.dataset.mgTools ?? null)

    await page.evaluate(() => {
      document.documentElement.dataset.mgTools = 'hidden'
    })
    await type('Hidden tools, first words late. ID=L2 MGS_DELAY(2500) MGS_WORK(1,0.2)', 'Enter')

    const hidden = await signOfLife('L2', 0)

    entry.evidence.toolsHidden = lifeSummary(hidden)
    judgeLife(must, 'tool calls hidden', hidden)
    await waitStreamEnd('L2')
    await page.evaluate(value => {
      if (value === null) {
        delete document.documentElement.dataset.mgTools
      } else {
        document.documentElement.dataset.mgTools = value
      }
    }, tools)
    await sleep(1200)

    // A queued prompt: from its hand-over until its first words.
    await type('Held for the queue. ID=L3 MGS_HOLD', 'Enter')
    await within(mock.waitForHeldStream(), 60_000, 'the model never received the held prompt')
    await type('Queued, first words late. ID=L4 MGS_DELAY(2500) MGS_WORK(1,0.2)', 'Control+Enter')
    await sleep(1500)
    mock.releaseHeldStream()
    await finished('Done L3.', 60_000)

    const queued = await signOfLife('L4', 0)

    entry.evidence.queued = lifeSummary(queued)
    judgeLife(must, 'a queued prompt', queued)
    await waitStreamEnd('L4')
    await shot(entry, 's15-after')
  })

  // ── s16. Thinking, as a setting ───────────────────────────────────────────
  // Set the way a second window would (the storage event the appearance
  // module answers), so the value applies without a reload.
  const setThinking = value =>
    page.evaluate(value => {
      const key = 'hermes.plugin.monograph.config'
      const next = { ...JSON.parse(window.localStorage.getItem(key) || '{}'), thinking: value }

      window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(next), storageArea: window.localStorage }))

      return document.documentElement.dataset.mgThinking ?? null
    }, value)

  // Every frame until the turn's last words: the reasoning's state, the
  // answer's first line, the gap under the page, what of reasoning is drawn.
  const thinkFrames = id =>
    page.evaluate(
      ({ id, viewport }) =>
        new Promise(resolve => {
          const t0 = performance.now()
          const frames = []
          // Painted reads: a ResizeObserver made now runs after the plugin's
          // and Hermes' own (observers are told in the order they were made),
          // so in a frame where sizes changed it reads what is painted.
          let watched = null
          const ro = new ResizeObserver(() => {
            const frame = frames.at(-1)
            const v = watched

            if (frame && v) {
              Object.assign(frame, measure(v), { painted: true })
            }
          })
          const measure = v => {
            const pair = [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes(`ID=${id}`))
            const answer = pair ? [...pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > .aui-md')].at(-1) : null
            const firstLine = answer?.querySelector('p, li, h1, h2, h3') ?? answer

            return {
              answerTop: firstLine ? Math.round(firstLine.getBoundingClientRect().top * 10) / 10 : null,
              gap: Math.round((v.scrollHeight - v.scrollTop - v.clientHeight) * 10) / 10
            }
          }
          const tick = () => {
            const t = Math.round(performance.now() - t0)
            const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)

            if (v && v !== watched) {
              ro.disconnect()
              ro.observe(v)
              v.querySelector('[data-slot="aui_thread-content"]') && ro.observe(v.querySelector('[data-slot="aui_thread-content"]'))
              watched = v
            }

            const pair = v ? [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].find(node => (node.querySelector('[data-slot="aui_user-message-root"]')?.textContent ?? '').includes(`ID=${id}`)) : null
            const box = pair?.querySelector('[data-slot="aui_thinking-disclosure"]')
            const answer = pair ? [...pair.querySelectorAll('[data-slot="aui_assistant-message-content"] > .aui-md')].at(-1) : null
            const firstLine = answer?.querySelector('p, li, h1, h2, h3') ?? answer
            const bodies = pair ? [...pair.querySelectorAll('[data-slot="aui_thinking-body"]')].filter(node => node.checkVisibility() && node.getBoundingClientRect().height > 0) : []
            const sign = pair ? [...pair.querySelectorAll('[data-slot="aui_turn-activity"], [data-slot="aui_response-loading"], #mf-live')] : []

            frames.push({
              t,
              think: box ? (box.dataset.mgThink ?? '-') : null,
              boxShown: Boolean(box?.checkVisibility() && box.getBoundingClientRect().height > 0),
              reasoningChars: bodies.reduce((sum, node) => sum + (node.textContent ?? '').length, 0),
              answerTop: firstLine ? Math.round(firstLine.getBoundingClientRect().top * 10) / 10 : null,
              gap: v ? Math.round((v.scrollHeight - v.scrollTop - v.clientHeight) * 10) / 10 : null,
              sign: sign.some(node => node.checkVisibility() && node.getBoundingClientRect().width > 0),
              live: pair ? 'mgLive' in pair.dataset : false,
              done: (pair?.textContent ?? '').includes(`Done ${id}.`)
            })

            if ((frames.at(-1).done && !frames.at(-1).live) || t > 30_000) {
              ro.disconnect()
              resolve(frames)

              return
            }

            requestAnimationFrame(tick)
          }

          tick()
        }),
      { id, viewport: VIEWPORT }
    )

  await check('s16', async (entry, must) => {
    await plant('s16')
    const before = await page.evaluate(() => document.documentElement.dataset.mgThinking ?? null)

    must(before === 'live', `thinking is "${before}" by default, not "live"`)

    // Live: reasoning shows; when it folds, at the bottom, nothing below it moves.
    await scrollToBottom()
    await type('Think, then answer. ID=T1 MGS_THINK MGS_FOLDPAUSE', 'Enter')

    const live = await thinkFrames('T1')
    const fold = live.findIndex((frame, index) => index > 0 && frame.think === 'folded' && live[index - 1].think === 'live')
    const around = fold > 0 ? live.slice(fold - 1, fold + 20).filter(frame => frame.answerTop !== null) : []
    const moved = around.slice(1).map((frame, index) => ({ t: frame.t, top: Math.round((frame.answerTop - around[index].answerTop) * 10) / 10, gap: Math.round((frame.gap - around[index].gap) * 10) / 10 })).filter(step => Math.abs(step.top) >= 1 || Math.abs(step.gap) >= 1)

    entry.evidence.live = {
      frames: live.length,
      maxReasoningChars: Math.max(0, ...live.map(frame => frame.reasoningChars)),
      foldAtMs: fold > 0 ? live[fold].t : null,
      framesAroundFold: around.length,
      movedAroundFold: moved.slice(0, 6),
      states: [...new Set(live.map(frame => frame.think))]
    }
    must(entry.evidence.live.maxReasoningChars > 0, 'live: no reasoning was drawn while it streamed')
    must(fold > 0, `live: the reasoning never folded (states ${JSON.stringify(entry.evidence.live.states)})`)
    must(around.length >= 5, `live: only ${around.length} frames with the answer around the fold (the check would prove nothing)`)
    must(moved.length === 0, `live: when the reasoning folded, the answer's first line or the bottom moved: ${JSON.stringify(moved.slice(0, 4))}`)
    await sleep(800)

    // Line: no reasoning while the turn runs, only the status row.
    const set = await setThinking('line')

    must(set === 'line', `the setting did not apply without a reload (data-mg-thinking=${set})`)
    await scrollToBottom()
    await type('Think, then answer, line only. ID=T2 MGS_THINK MGS_FOLDPAUSE', 'Enter')

    const line = await thinkFrames('T2')
    const running = line.filter(frame => frame.live && frame.t >= 300)
    const shownWhileRunning = running.filter(frame => frame.boxShown || frame.reasoningChars > 0)
    const beforeWords = running.filter(frame => frame.answerTop === null)

    entry.evidence.line = {
      frames: line.length,
      running: running.length,
      reasoningShownWhileRunning: shownWhileRunning.length,
      beforeWords: beforeWords.length,
      withoutSignBeforeWords: beforeWords.filter(frame => !frame.sign).length
    }
    must(running.length >= 10, `line: only ${running.length} running frames (the check would prove nothing)`)
    must(shownWhileRunning.length === 0, `line: reasoning was drawn in ${shownWhileRunning.length} running frames (first at ${shownWhileRunning[0]?.t} ms)`)
    must(beforeWords.length > 0 && entry.evidence.line.withoutSignBeforeWords === 0, `line: no status row was on screen in ${entry.evidence.line.withoutSignBeforeWords} of ${beforeWords.length} frames before the first words`)
    await sleep(800)

    // Afterwards the "Worked for" line unfolds it.
    const head = await page.evaluate(viewport => {
      const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
      const pair = [...(v?.querySelectorAll('[data-slot="aui_turn-pair"]') ?? [])].at(-1)
      const row = pair?.querySelector('[data-slot="aui_assistant-message-root"][data-mg-head][data-mg-steps]')
      const box = row?.getBoundingClientRect()

      return box ? { x: box.left + box.width / 2, y: box.top + 14, steps: row.dataset.mgSteps } : null
    }, VIEWPORT)

    entry.evidence.line.head = head
    must(head, 'line: the finished turn has no "Worked for" line with steps')

    if (head) {
      await page.mouse.click(head.x, head.y)
      await sleep(700)
      entry.evidence.line.afterPress = await page.evaluate(viewport => {
        const v = [...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0)
        const pair = [...(v?.querySelectorAll('[data-slot="aui_turn-pair"]') ?? [])].at(-1)
        const box = pair?.querySelector('[data-slot="aui_thinking-disclosure"]')

        return { thinkingShown: Boolean(box?.checkVisibility() && box.getBoundingClientRect().height > 0) }
      }, VIEWPORT)
      must(entry.evidence.line.afterPress.thinkingShown, 'line: after the turn, pressing "Worked for" did not show the reasoning')
      await shot(entry, 's16-line-unfolded')
    }

    must((await setThinking('live')) === 'live', 'the setting did not go back to "live"')
  })

}
