// Stress: the chat under load, every scenario recorded with perf(). See
// rig/README.md ("Stress") for what each check does and the limits it fails on
// (PERF_LIMITS in harness.mjs: no unexplained movement over 2 px, no frame
// over 100 ms, no more than 200 ms of long tasks per 10 s, no layout shift
// without input before it).
//
// The model is this suite's own (startModel below), because Hermes' mock
// cannot script many tool calls, long replies or a hold per prompt. Tokens in
// a prompt pick the script:
//   MGS_TOOLS(n[,ms])  n terminal calls (`echo`), one per completion, `ms`
//                      before each; a note every tenth; then MGS_TOOLS_DONE
//   MGS_LONG(lines)    one reply of that many lines, with code blocks and
//                      tables, in 240-character pieces; ends MGS_LONG_DONE
//   MGS_SLOW(s)        about s seconds of words, 40 ms apart; MGS_SLOW_DONE
//   MGS_HOLD           first word, then waits for releaseHeldStream()
//   MGS_THINK          reasoning first, then an answer; MGS_THINK_DONE
//   MGS_CALL(tool)[{…}] one call of that tool with those arguments, then
//                      "The tool finished, <token> MGS_CALL_DONE."
//   MGS_WORK           reasoning, a note and one `echo` call, then reasoning
//                      and an answer; MGS_WORK_DONE
//   anything else      a short reply: "Reply for <first MG…_ token> … Done <token>."
// Other suites may use it: `export const model = () => startModel({ extraModels })`.
// The 100-turn thread is made before the app starts, through Hermes' own
// stdio gateway (tui_gateway.entry, as apps/desktop/e2e/real-session-builder.ts
// does), against the same model.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createInterface } from 'node:readline'

import {
  HERMES_REPO,
  ON_SCREEN_VIEWPORT,
  PERF_LIMITS,
  PLUGIN,
  RUNNING,
  VIEWPORT,
  WORK,
  buildAppEnv,
  check as harnessCheck,
  hotReload,
  judgePerf,
  perf as rawPerf,
  results,
  setWindow,
  shot,
  sleep,
  state,
  stubPlugin,
  turnDone,
  type,
  waitForAppReady
} from '../harness.mjs'

export const limitS = 1800

export const checks = [
  ['s1', '100-turn thread: wheel scroll to the top and back, nothing moves by itself'],
  ['s1b', 'Reference: s1 again with Monograph unloaded (bare Hermes)'],
  ['s1v', 'Attribution: s1 with only Monograph\'s stylesheet, and with only its script'],
  ['s2', '40 tool calls streaming: the view stays put while reading above'],
  ['s3', '40 tool calls streaming: the view stays at the bottom while pinned'],
  ['s2b', 'Reference: s2 and s3 again with Monograph unloaded (bare Hermes)'],
  ['s4', 'Five prompts queued behind a running turn'],
  ['s5', 'Stop a turn mid-stream'],
  ['s6', 'Switch session mid-turn and back: everything drawn once'],
  ['s7', 'Resize the window while a reply streams: stays pinned'],
  ['s8', 'A 2,000-line reply with code blocks and tables'],
  ['s8b', 'Reference: s8 again with Monograph unloaded (bare Hermes)'],
  ['s9', 'Menus opened and closed fast while a reply streams'],
  ['s9b', 'Reference: s9 again with Monograph unloaded (bare Hermes)'],
  ['s9c', 'Attribution: s9 one menu at a time, with Monograph'],
  ['s0', 'Self-test: the painted sampler sees painted gaps and only those; a view left off the bottom fails'],
  ['s10b', 'Reference: s10 and s10r with Monograph unloaded (bare Hermes)'],
  ['s10', 'Thinking, 400 pieces over 20 s, pinned: shown while it streams, folds at the answer, opens and folds by press and Enter'],
  ['s10r', 'Thinking, 400 pieces, read from 600 px above: nothing being read moves'],
  ['s10n', 'No reasoning: no thinking block; one working bar per thread while it runs, gone at the end, absent with motion off'],
  ['s11b', 'Reference: s11 and s11r with Monograph unloaded (bare Hermes)'],
  ['s11', 'Streaming feel, pinned: prose, code and tables, tool end, stop, error, next prompt at the end, session switch, resize, tools hidden'],
  ['s11r', 'Streaming feel, read from 600 px above: the same, nothing being read moves']
]

const TURNS = 100
const FIRST_TURN = 'MGS thread start, MGT_1.'

export const model = async () => startModel()

// Reasoning reaches the app only with display.show_reasoning (the owner's
// setting); s10 streams it.
export const config = 'display:\n  show_reasoning: true\n'

export async function seed({ mock, sandbox }) {
  const env = buildAppEnv(sandbox, {
    HERMES_DESKTOP_PYTHON: state.python,
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: HERMES_REPO,
    ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(name => [name, 'http://127.0.0.1:9'])),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1'
  })
  const began = Date.now()
  const turns = Array.from({ length: TURNS }, (_, index) => (index === 0 ? FIRST_TURN : `Turn ${index + 1} of the long thread, MGT_${index + 1}.`))
  const made = await seedSession({ cwd: sandbox.root, env, python: state.python, title: 'MGS long thread', turns })

  results.notes.push(`stress: seeded a ${TURNS}-turn session (${made.stored}) in ${((Date.now() - began) / 1000).toFixed(1)}s through tui_gateway.entry; ${mock.completions()} completions so far`)
}


// ── What is painted ─────────────────────────────────────────────────────────
// The recorder (scripts/rec-start.js) reads the gap to the bottom in
// requestAnimationFrame. That runs before layout and before ResizeObserver
// callbacks, and Monograph keeps the bottom from a ResizeObserver (keepBottom
// in plugin.js), after layout and before paint. So a growth that the observer
// scrolls away in the same frame is reported as a one-frame gap that never
// reaches the screen (measured: 372 px at the rAF read, closed 10 ms later in
// the same frame).
// This sampler reads what is painted: its own ResizeObserver on the thread
// and its viewport, created at the start of every recording, so after the
// plugin's (observers are notified in the order they were made) and after
// Hermes' own stick-to-bottom. When it is called in a frame, its read (after
// every correction, before paint) is that frame's painted gap; a frame with
// no size change keeps the rAF read. The judged gap* numbers are these; the
// recorder's own are kept beside them as `raf`.
const PAINTED_START = `(() => {
  const find = () => ${ON_SCREEN_VIEWPORT}
  const P = (window.__mgPainted = { frames: [], on: true })
  const read = v => Math.round(v.scrollHeight - v.scrollTop - v.clientHeight)
  let current = null
  let watched = null
  P.ro = new ResizeObserver(() => {
    const v = find()
    if (P.on && current && v) current.painted = read(v)
  })
  const tick = () => {
    if (!P.on) return
    const v = find()
    if (v && v !== watched) {
      P.ro.disconnect()
      P.ro.observe(v)
      const thread = v.querySelector('[data-slot="aui_thread-content"]')
      if (thread) P.ro.observe(thread)
      watched = v
    }
    current = v ? { raf: read(v) } : null
    if (current) P.frames.push(current)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  // Frames over 200 ms: what ran in them (long animation frames).
  P.loafs = []
  try {
    P.po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (P.on && e.duration > 200 && P.loafs.length < 6) {
          P.loafs.push({ d: Math.round(e.duration), blocking: Math.round(e.blockingDuration ?? 0), styleLayoutMs: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : null, renderMs: e.renderStart ? Math.round(e.startTime + e.duration - e.renderStart) : null, scripts: (e.scripts ?? []).slice(0, 4).map(x => ({ d: Math.round(x.duration), invoker: String(x.invoker ?? '').slice(0, 70), ours: String(x.sourceURL ?? '').startsWith('blob:'), fn: String(x.sourceFunctionName ?? '').slice(0, 40), src: String(x.sourceURL ?? '').split('/').pop().slice(0, 40), layoutMs: Math.round(x.forcedStyleAndLayoutDuration ?? 0) })) })
        }
      }
    })
    P.po.observe({ type: 'long-animation-frame', buffered: false })
  } catch {}
})()`

const PAINTED_STOP = `(async () => {
  const P = window.__mgPainted
  if (!P) return null
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  P.on = false
  P.ro.disconnect()
  P.po?.disconnect()
  delete window.__mgPainted
  const gaps = P.frames.map(f => f.painted ?? f.raf)
  let run = 0, runMax = 0, over = 0, max = 0
  for (const gap of gaps) {
    max = Math.max(max, gap)
    if (gap > 2) { over++; run++; runMax = Math.max(runMax, run) } else run = 0
  }
  const unpainted = P.frames.filter(f => f.raf > 2 && f.painted !== undefined && f.painted <= 2).length
  return { frames: gaps.length, gapMax: max, gapFramesOver2: over, gapRunMax: runMax, gapFinal: gaps.at(-1) ?? null, rafGapsNeverPainted: unpainted, loafs: P.loafs }
})()`

async function perf(fn, options) {
  await state.page.evaluate(PAINTED_START)

  let stats = null
  let painted = null

  try {
    stats = await rawPerf(fn, options)
  } finally {
    painted = await state.page.evaluate(PAINTED_STOP).catch(() => null)
  }

  if (painted?.frames) {
    const v = stats.viewport
    v.raf = { gapMax: v.gapMax, gapFramesOver2: v.gapFramesOver2, gapRunMax: v.gapRunMax, gapFinal: v.gapFinal }
    v.rafGapsNeverPainted = painted.rafGapsNeverPainted
    stats.loafs = painted.loafs
    Object.assign(v, { gapMax: painted.gapMax, gapFramesOver2: painted.gapFramesOver2, gapRunMax: painted.gapRunMax, gapFinal: painted.gapFinal })
  }

  return stats
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const brief = stats => ({
  secs: stats.secs,
  fps: stats.fps,
  frameMs: { p50: stats.p50, p95: stats.p95, max: stats.maxFrame, over32: stats.slow32, over50: stats.slow50, over100: stats.slow100 },
  longTasks: { n: stats.longtasks.n, totalMs: stats.longtasks.total, per10s: stats.secs ? Math.round((stats.longtasks.total / stats.secs) * 10) : 0, top: stats.longtasks.top.slice(0, 4).map(task => task.d) },
  shifts: { n: stats.shifts.n, noInput: stats.shifts.noInput, sum: stats.shifts.sum, first: stats.shifts.top[0] ?? null, list: stats.shifts.top.slice(0, 8) },
  view: {
    anchorNoInput: stats.viewport.anchorNoInput,
    anchorNoInputMax: stats.viewport.anchorNoInputMax,
    scrollNoInput: stats.viewport.scrollNoInput,
    gapMax: stats.viewport.gapMax,
    gapRunMax: stats.viewport.gapRunMax,
    gapFinal: stats.viewport.gapFinal,
    raf: stats.viewport.raf,
    rafGapsNeverPainted: stats.viewport.rafGapsNeverPainted,
    firstUnexplained: stats.viewport.anchorEvents.slice(0, 3)
  },
  framesOver200: stats.loafs?.length ? stats.loafs : undefined,
  animations: stats.animStarts.slice(0, 6).map(([name, count]) => `${name} x${count}`),
  wheel: stats.wheel
})


// s1 and s9 are judged against bare Hermes measured the same way in the same
// run (s1b, s9b, which run first), because bare Hermes itself breaks the fixed
// PERF_LIMITS on this machine (s1b: about 220 ms of long tasks per 10 s and a
// 150 ms frame when the thread first draws). The targets are the brief's:
//   frame rate         at least `fpsShare` of bare's (s1: 92 percent)
//   long tasks per 10 s at most `longTaskFactor` times bare's (s1: 1.5, s9: 2),
//                      and never held to less than PERF_LIMITS allows
//   longest frame      at most bare's longest plus 25 percent, or 100 ms
//   layout shifts      with no input: no more than bare has
//   movement           as PERF_LIMITS, unchanged (`mode`)
function judgeAgainstBare(stats, bare, { fpsShare = null, longTaskFactor, mode }) {
  const per10 = run => (run.secs > 0 ? (run.longtasks.total / run.secs) * 10 : 0)
  const limits = {
    frameMs: Math.max(PERF_LIMITS.frameMs, Math.round(bare.maxFrame * 1.25)),
    longTaskMsPer10s: Math.max(PERF_LIMITS.longTaskMsPer10s, Math.round(per10(bare) * longTaskFactor)),
    shiftsNoInput: bare.shifts.noInput
  }
  const why = judgePerf(stats, { limits, mode }).map(reason => `${reason} [limit from bare Hermes in this run: ${JSON.stringify(limits)}]`)

  if (fpsShare && stats.fps < bare.fps * fpsShare) {
    why.push(`${stats.fps} fps, under ${Math.round(fpsShare * 100)} percent of bare Hermes' ${bare.fps} fps in this run`)
  }

  return { limits, why }
}

const view = () =>
  state.page.evaluate(`(() => {
    const v = ${ON_SCREEN_VIEWPORT}

    return v ? { gap: Math.round(v.scrollHeight - v.scrollTop - v.clientHeight), height: v.scrollHeight, top: Math.round(v.scrollTop) } : null
  })()`)

const waitFor = (fn, arg, timeout, label) =>
  state.page
    .waitForFunction(fn, arg, { polling: 100, timeout })
    .then(() => true)
    .catch(() => {
      throw new Error(`${label}: not within ${timeout / 1000}s`)
    })

const waitText = (needle, timeout = 60_000) =>
  waitFor(`((${ON_SCREEN_VIEWPORT})?.textContent ?? '').includes(${JSON.stringify(needle)})`, undefined, timeout, `"${needle}" on screen`)

const waitIdle = (needle, timeout = 90_000) => turnDone(needle, timeout)

const running = () => state.page.evaluate(`Boolean((${ON_SCREEN_VIEWPORT})?.querySelector(${JSON.stringify(RUNNING)}))`)

// Elements of each kind in the thread on screen whose text holds the needle
// and that a person can see: a turn drawn twice shows as 2.
const drawn = needle =>
  state.page.evaluate(`(() => {
    const v = ${ON_SCREEN_VIEWPORT}
    const needle = ${JSON.stringify(needle)}
    const shown = node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && node.getBoundingClientRect().height > 0
    const count = selector => (v ? [...v.querySelectorAll(selector)] : []).filter(node => (node.textContent ?? '').includes(needle) && shown(node)).length

    return {
      prompts: count('[data-slot="aui_user-message-root"]'),
      replies: count('[data-slot="aui_assistant-message-root"]'),
      stale: v ? v.querySelectorAll('[data-mg-stale]').length : 0
    }
  })()`)

// What a person can read of each reply row in the thread on screen.
const readable = () =>
  state.page.evaluate(`(() => {
    const v = ${ON_SCREEN_VIEWPORT}

    return v ? [...v.querySelectorAll('[data-slot="aui_assistant-message-root"], [data-slot="aui_user-message-root"]')].map(row => ({
      marks: Object.entries(row.dataset).filter(([key]) => key.startsWith('mg')).map(([key, value]) => key + '=' + value).join(' '),
      role: row.dataset.role ?? row.dataset.slot,
      text: (row.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 140)
    })) : []
  })()`)

async function pointAtThread() {
  const box = await state.page.evaluate(`(() => {
    const rect = (${ON_SCREEN_VIEWPORT})?.getBoundingClientRect()

    return rect ? { height: rect.height, width: rect.width, x: rect.x, y: rect.y } : null
  })()`)

  if (!box) {
    throw new Error('no thread viewport on screen')
  }

  await state.page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.45)

  return box
}

// Real wheel input until the viewport stops moving at an end.
async function wheelTo(direction, { maxSteps = 400, step = 600 } = {}) {
  await pointAtThread()

  let still = 0
  let last = null
  let steps = 0

  for (; steps < maxSteps && still < 6; steps++) {
    await state.page.mouse.wheel(0, direction === 'up' ? -step : step)
    await sleep(30)

    const now = await view()
    const atEnd = direction === 'up' ? now?.top === 0 : now?.gap <= 2

    still = atEnd && now?.height === last?.height ? still + 1 : 0
    last = now
  }

  return { steps, ...last }
}

async function newSession() {
  const button = state.page.locator('button[aria-label="New session"]').first()

  if (await button.isVisible().catch(() => false)) {
    await button.click()
  } else {
    await state.page.keyboard.press('Meta+n')
  }

  await sleep(800)
}

// By its title; a title Hermes shortened (a long prompt) is found by the
// words it starts with, the newest such row (the list is newest first).
async function openSession(text) {
  const rows = state.page.locator('[data-slot="row-button"]')
  let row = rows.filter({ hasText: text }).first()

  try {
    await row.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    row = rows.filter({ hasText: text.split(',')[0] }).first()
    await row.waitFor({ state: 'visible', timeout: 12_000 })
    openedBy.push({ text, title: (await row.innerText()).slice(0, 80) })
  }

  await row.click()
}

const openedBy = []

// Puts the reader somewhere above the bottom with real wheel input, then
// lets input settle so the recorder treats any later movement as unexplained.
async function readAbove(px = 1400) {
  await pointAtThread()

  for (let moved = 0; moved < px; moved += 350) {
    await state.page.mouse.wheel(0, -350)
    await sleep(40)
  }

  await sleep(700)

  return view()
}

const lastPairTools = () =>
  state.page.evaluate(`(() => {
    const v = ${ON_SCREEN_VIEWPORT}
    const pairs = v ? v.querySelectorAll('[data-slot="aui_turn-pair"]') : []
    const pair = pairs[pairs.length - 1]

    return pair ? pair.querySelectorAll('[data-slot="tool-block"]').length : 0
  })()`)

// One run of the tool-call scenario: reading above for `readMs`, then pinned
// to the bottom until the turn ends and folds.
async function toolScenario(tag, entry, { readMs = 7000 } = {}) {
  const prompt = `Forty tool calls, ${tag}. MGS_TOOLS(40,350)`

  await type(prompt, 'Enter')
  await waitFor(`(() => {
    const v = ${ON_SCREEN_VIEWPORT}
    const pairs = v ? v.querySelectorAll('[data-slot="aui_turn-pair"]') : []

    return (pairs[pairs.length - 1]?.querySelectorAll('[data-slot="tool-block"]').length ?? 0) >= 1
  })()`, undefined, 60_000, 'the first tool row')

  const toolsAtStart = await lastPairTools()
  const placed = await readAbove()
  const reading = await perf(async () => {
    await sleep(readMs)
  })
  const toolsAfterReading = await lastPairTools()

  await shot(entry, `${entry.id}-reading-while-streaming`)

  const bottom = await wheelTo('down')

  await sleep(600)

  const pinned = await perf(async () => {
    await waitIdle(`${tag} MGS_TOOLS_DONE`, 120_000)
    // The fold lands half a second after the end, then animates.
    await sleep(1800)
  })

  await shot(entry, `${entry.id}-pinned-after-end`)

  const fold = await state.page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-slot="aui_assistant-message-root"]')]
    const last = rows.at(-1)
    const head = [...rows].reverse().find(row => 'mgHead' in row.dataset)
    const pair = last?.closest('[data-slot="aui_turn-pair"]')

    // What Hermes drew for the calls: a run of consecutive calls is ONE
    // tool-block (data-tool-group) holding a row per call.
    return {
      hermesDrew: pair
        ? {
            toolBlocks: pair.querySelectorAll('[data-slot="tool-block"]').length,
            groups: pair.querySelectorAll('[data-tool-group]').length,
            rows: pair.querySelectorAll('[data-tool-row]').length,
            summaries: [...pair.querySelectorAll('[data-tool-summary]')].map(node => (node.textContent ?? '').trim().slice(0, 40))
          }
        : null,
      lastSeg: last?.dataset.mgSeg ?? null,
      steps: head?.dataset.mgSteps ?? null,
      worked: head?.dataset.mgWorked ?? null
    }
  })

  return { bottom, fold, pinned, placed, reading, toolsAfterReading, toolsAtStart }
}

// ── The checks ──────────────────────────────────────────────────────────────
// MGS_ONLY=s10,s11 runs only those checks (the rest report "not run"): for
// working on a few checks without the whole half hour.
const ONLY = process.env.MGS_ONLY ? process.env.MGS_ONLY.split(',') : null
const check = (id, body) => (!ONLY || ONLY.includes(id) ? harnessCheck(id, body) : undefined)

export async function run() {
  const { mock, page } = state
  const record = {}

  // ── s1. 100-turn thread ──────────────────────────────────────────────────
  const wheelEnds = async () => {
    const ends = {}
    const stats = await perf(async () => {
      ends.up = await wheelTo('up')
      await sleep(1200)
      ends.firstTurnShown = (await drawn('MGS thread start')).prompts
      ends.down = await wheelTo('down')
      await sleep(1200)
    })

    return { ends, stats }
  }

  // The bare reference first, so that s1 can be judged against it.
  await check('s1b', async (entry, must) => {
    await hotReload({ gone: true, source: stubPlugin() })

    try {
      // Cold, as s1 is: the page reloaded (the stand-in stays the plugin on
      // disk, so Monograph stays out), then the thread opened from history.
      await page.reload()
      await waitForAppReady({ app: state.app, page }, 60_000)
      await sleep(1500)
      entry.evidence.monograph = await page.evaluate(() => (document.getElementById('mg-css') ? 'loaded' : 'unloaded'))
      // What bare Hermes draws in the top-left corner and the sidebar header.
      entry.evidence.bareTopLeft = await page.evaluate(() =>
        [...document.querySelectorAll('button, [data-slot="pane-tab"]')]
          .filter(node => node.checkVisibility() && node.getBoundingClientRect().top < 80 && node.getBoundingClientRect().left < 300)
          .map(node => `${node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 20)} at ${Math.round(node.getBoundingClientRect().x)},${Math.round(node.getBoundingClientRect().y)}`)
      )
      await shot(entry, 's1b-bare-hermes')
      await openSession('MGS long thread')
      await waitText(`Done MGT_${TURNS}.`, 60_000)
      await sleep(1500)

      const { ends, stats } = await wheelEnds()

      record.s1bStats = stats
      Object.assign(entry.evidence, { ends, perf: brief(stats), verdict: judgePerf(stats, { mode: 'reading' }) })
    } finally {
      await hotReload()
    }

    must(await page.evaluate(() => Boolean(document.getElementById('mg-css'))), 'Monograph did not come back after the reference run')
  })

  await check('s1', async (entry, must) => {
    entry.id = 's1'

    // Cold, as the reference was.
    await page.reload()
    await waitForAppReady({ app: state.app, page }, 60_000)
    await sleep(1500)

    const opened = Date.now()

    await openSession('MGS long thread')
    await waitText(`Done MGT_${TURNS}.`, 60_000)
    entry.evidence.openedMs = Date.now() - opened
    await sleep(1500)

    const { ends, stats } = await wheelEnds()
    const pairs = await page.evaluate(`(() => {
      const v = ${ON_SCREEN_VIEWPORT}
      const texts = [...v.querySelectorAll('[data-slot="aui_user-message-root"]')].filter(node => node.checkVisibility()).map(node => (node.textContent ?? '').match(/MGT_\\d+/)?.[0])

      return { distinct: new Set(texts.filter(Boolean)).size, visiblePrompts: texts.length }
    })()`)

    Object.assign(entry.evidence, { ends, pairs, perf: brief(stats), bare: record.s1bStats ? brief(record.s1bStats) : null })
    record.s1 = brief(stats)
    must(ends.up.top === 0 && ends.firstTurnShown === 1, `did not reach the first turn by wheel (top ${ends.up.top}, first prompt drawn ${ends.firstTurnShown} time(s))`)
    must(ends.down.gap <= 2, `did not get back to the bottom by wheel (gap ${ends.down.gap}px)`)
    must(pairs.distinct === TURNS && pairs.visiblePrompts === TURNS, `expected ${TURNS} prompts drawn once each, saw ${pairs.visiblePrompts} prompts, ${pairs.distinct} distinct`)
    must(record.s1bStats, 'no bare reference to judge against (s1b did not record one)')

    if (record.s1bStats) {
      const { limits, why } = judgeAgainstBare(stats, record.s1bStats, { fpsShare: 0.92, longTaskFactor: 1.5, mode: 'reading' })

      entry.evidence.limits = { ...limits, fps: Math.round(record.s1bStats.fps * 0.92 * 10) / 10 }

      for (const reason of why) {
        must(false, reason)
      }
    }

    await shot(entry, 's1-bottom-after-wheel')
  })

  // Style cost of `fn`, from the browser's own trace (devtools.timeline):
  // how many style recalculations ran, their total time, and how many
  // elements they restyled in all. A rule that makes every change restyle
  // the whole page shows here as hundreds of thousands of elements, whatever
  // else the machine is doing; frame rates on a shared machine are noisier.
  const styleCost = async fn => {
    const cdp = state.cdp
    const events = []
    const collect = event => events.push(...event.value)

    cdp.on('Tracing.dataCollected', collect)
    await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'], recordMode: 'recordContinuously' }, transferMode: 'ReportEvents' })

    try {
      await fn()
    } finally {
      const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))

      await cdp.send('Tracing.end')
      await done
      cdp.off('Tracing.dataCollected', collect)
    }

    const recalcs = events.filter(event => event.name === 'UpdateLayoutTree' && event.ph === 'X')

    return {
      recalcs: recalcs.length,
      recalcMs: Math.round(recalcs.reduce((sum, event) => sum + event.dur, 0) / 1000),
      restyled: recalcs.reduce((sum, event) => sum + (event.args?.elementCount ?? 0), 0),
      layoutMs: Math.round(events.filter(event => event.name === 'Layout' && event.ph === 'X').reduce((sum, event) => sum + event.dur, 0) / 1000)
    }
  }

  // A fixed scroll for styleCost: 20 wheel steps up and 20 down.
  const traceScroll = () =>
    styleCost(async () => {
      await pointAtThread()

      for (const direction of [-1, 1]) {
        for (let step = 0; step < 20; step++) {
          await page.mouse.wheel(0, direction * 600)
          await sleep(30)
        }

        await sleep(400)
      }
    })

  // Which part costs what. Each variant is loaded cold, the 100-turn thread
  // opened, then scrolled twice: with real wheel input for the frame rate
  // (as s1), and a fixed scroll under the browser's trace for the style
  // cost. Variants: Monograph's stylesheet only, the stylesheet without the
  // generated logo rules, the script only, the whole plugin without the
  // generated :root:has() rules that publish --mg-model (build.mjs), and the
  // stylesheet's files in four groups. Then each file alone (with the
  // tokens), style cost only, which is the per-file attribution.
  // Stylesheet-only variants run without src/modules/05-state.js, so rules
  // keyed on its attributes do not apply there.
  await check('s1v', async (entry, must) => {
    const built = fs.readFileSync(PLUGIN, 'utf8')
    const literal = built.match(/^const CSS = (".*")$/m)?.[1]

    if (!literal) {
      throw new Error('cannot find the stylesheet in the built plugin')
    }

    const css = JSON.parse(literal)
    const noLogos = css.replace(/\/\* ── src\/logos \(generated\) ── \*\/[\s\S]*?(?=\/\* ── src\/)/, '')
    const noModelHas = css.replace(/^:root:has\(button:is\(.*$/gm, '')
    const write = (name, text) => {
      const file = path.join(WORK, `variant-${name}.js`)

      fs.writeFileSync(file, text)

      return file
    }
    const cssOnly = text =>
      `export default { id: 'monograph', name: 'Monograph (rig: stylesheet only)', register(ctx) { const s = document.createElement('style'); s.id = 'mg-css'; s.dataset.owner = String(Math.random()); s.textContent = ${JSON.stringify(text)}; document.head.appendChild(s); document.documentElement.dataset.mgReady = 'variant'; setTimeout(() => { document.documentElement.dataset.mgReady = 'variant' }, 900); ctx.onDispose(() => { s.remove(); delete document.documentElement.dataset.mgReady }) } }\n`
    const withCss = text => built.replace(/^const CSS = ".*"$/m, () => `const CSS = ${JSON.stringify(text)}`)
    // The stylesheet cut into its files, whole: build.mjs heads each one with
    // "/* ── src/… ── */". (Files have sub-headings of the same shape, so the
    // cut is on "src/" only.)
    const sections = css.split(/(?=\/\* ── src\/)/)
    const nameOf = part => part.match(/^\/\* ── (\S+)/)?.[1] ?? '?'
    const group = names => sections.filter(part => names.some(name => nameOf(part).startsWith(`src/css/${name}`))).join('\n')
    const tokens = sections.filter(part => /^src\/css\/0[05]-/.test(nameOf(part))).join('\n')
    const variants = [
      ['stylesheet only', write('css', cssOnly(css))],
      ['stylesheet only, no logo rules', write('css-nologos', cssOnly(noLogos))],
      ['script only', write('js', built.replace(/^const CSS = ".*"$/m, 'const CSS = "/* rig: empty */"'))],
      ['whole plugin without the generated --mg-model :root:has() rules', write('no-model-has', withCss(noModelHas))],
      ['tokens + shell, corner, surfaces, sidebar (10-20)', write('css-shell', cssOnly(`${tokens}\n${group(['10-', '12-', '14-', '20-'])}`))],
      ['tokens + chat, answer-only, cards, turns, services (30-34)', write('css-chat', cssOnly(`${tokens}\n${group(['30-', '31-', '32-', '33-', '34-'])}`))],
      ['tokens + controls, composer, effort, menus (35-50)', write('css-composer', cssOnly(`${tokens}\n${group(['35-', '40-', '41-', '50-'])}`))],
      ['tokens + motion, panel, home, appearance, knowledge (55-66)', write('css-pages', cssOnly(`${tokens}\n${group(['55-', '60-', '62-', '64-', '66-'])}`))]
    ]
    const files = sections.map(nameOf).filter(name => !/^src\/css\/0[05]-/.test(name))
    const open = async file => {
      if (file) {
        await hotReload({ source: file })
      } else {
        await hotReload({ gone: true, source: stubPlugin() })
      }

      await page.reload()
      await waitForAppReady({ app: state.app, page }, 60_000)
      await sleep(1500)
      await openSession('MGS long thread')
      await waitText(`Done MGT_${TURNS}.`, 60_000)
      await sleep(1500)
    }

    entry.evidence.cssKB = { full: Math.round(css.length / 1024), withoutLogoRules: Math.round(noLogos.length / 1024) }

    try {
      // Reference style cost: Monograph whole, and bare Hermes.
      await open(PLUGIN)
      entry.evidence['style cost, whole plugin'] = await traceScroll()
      await open(null)
      entry.evidence['style cost, bare Hermes'] = await traceScroll()

      for (const [name, file] of variants) {
        await open(file)

        const { ends, stats } = await wheelEnds()

        entry.evidence[name] = { reached: `${ends.up.top === 0 ? 'top' : 'NOT top'}, ${ends.down.gap <= 2 ? 'bottom' : 'NOT bottom'}`, ...brief(stats), style: await traceScroll() }
      }

      // Per file: the tokens and that file alone.
      const perFile = {}

      for (const name of files) {
        const keep = sections.filter(part => /^src\/css\/0[05]-/.test(nameOf(part)) || nameOf(part) === name).join('\n')

        await open(write(`file-${name.replace(/\W+/g, '-')}`, cssOnly(keep)))

        const cost = await traceScroll()

        perFile[name] = `recalc ${cost.recalcMs} ms x${cost.recalcs}, ${cost.restyled} elements restyled, layout ${cost.layoutMs} ms`
      }

      entry.evidence['style cost per file (tokens + the file)'] = perFile
    } finally {
      await hotReload()
    }

    entry.evidence.full = record.s1 ?? null
    must(await page.evaluate(() => Boolean(document.getElementById('mg-css'))), 'Monograph did not come back after the variants')
  })

  // ── s2 to s8: judged against bare Hermes in the same run ─────────────────
  // Every scenario of s2 to s8 is also run with Monograph unloaded (s2b,
  // s8b, and inside s4 to s7), and Monograph's record is judged against that
  // one: the same window, the same machine load, the same Hermes. The limits
  // of PERF_LIMITS stand, except where bare Hermes itself does worse, and
  // then only by bare's number plus a stated margin (BARE_MARGIN). Pinned to
  // the bottom, the view may be off it by more than 2 px for at most one
  // frame in a row (or bare's run, if longer) and end 0 or 1 px off (or
  // bare's end), which is tighter than PERF_LIMITS.
  const BARE_MARGIN = { frameMs: 50, longTaskMsPer10s: 100, shiftsNoInput: 1 }
  const per10s = stats => (stats.secs > 0 ? (stats.longtasks.total / stats.secs) * 10 : 0)

  const judgeAgainst = (stats, bare, { mode = null, shifts = true } = {}) => {
    const limits = {
      frameMs: Math.max(PERF_LIMITS.frameMs, bare.maxFrame + BARE_MARGIN.frameMs),
      longTaskMsPer10s: Math.max(PERF_LIMITS.longTaskMsPer10s, Math.round(per10s(bare)) + BARE_MARGIN.longTaskMsPer10s),
      shiftsNoInput: shifts ? Math.max(PERF_LIMITS.shiftsNoInput, bare.shifts.noInput + BARE_MARGIN.shiftsNoInput) : Infinity
    }
    const why = judgePerf(stats, { limits, mode })

    if (mode === 'pinned') {
      const run = Math.max(1, bare.viewport.gapRunMax)
      const end = Math.max(1, bare.viewport.gapFinal)

      if (stats.viewport.gapRunMax > run || stats.viewport.gapFinal > end) {
        why.push(
          `off the bottom for ${stats.viewport.gapRunMax} frame(s) in a row (gap up to ${stats.viewport.gapMax} px), ${stats.viewport.gapFinal} px at the end; allowed ${run} frame(s) and ${end} px (bare Hermes: ${bare.viewport.gapRunMax} frame(s), ${bare.viewport.gapFinal} px)`
        )
      }
    }

    return { limits, why: [...new Set(why)] }
  }

  // Runs `scenario(tag)` with Monograph unloaded, then puts Monograph back.
  const bareRun = async scenario => {
    await hotReload({ gone: true, source: stubPlugin() })

    try {
      const unloaded = await page.evaluate(() => !document.getElementById('mg-css'))

      return { unloaded, ...(await scenario()) }
    } finally {
      await hotReload()
    }
  }

  // ── s2, s3. 40 tool calls, reading and pinned ────────────────────────────
  // The bare reference runs first, so s2 and s3 can be judged against it.
  let tools = null

  await check('s2b', async (entry, must) => {
    entry.id = 's2b'

    const bare = await bareRun(() => toolScenario('MGS_S2B', entry))

    record.s2b = bare
    entry.evidence.monograph = bare.unloaded ? 'unloaded' : 'loaded'
    entry.evidence.reading = brief(bare.reading)
    entry.evidence.pinned = brief(bare.pinned)
    entry.evidence.readingVerdict = judgePerf(bare.reading, { mode: 'reading' })
    entry.evidence.pinnedVerdict = judgePerf(bare.pinned, { mode: 'pinned' })
    must(bare.unloaded, 'Monograph was still loaded during the reference run')
    must(await page.evaluate(() => Boolean(document.getElementById('mg-css'))), 'Monograph did not come back after the reference run')
  })

  await check('s2', async (entry, must) => {
    entry.id = 's2'
    tools = await toolScenario('MGS_S2', entry)
    Object.assign(entry.evidence, {
      readerPlacedAt: tools.placed,
      toolRows: { atStart: tools.toolsAtStart, afterReading: tools.toolsAfterReading },
      perf: brief(tools.reading),
      bare: record.s2b ? brief(record.s2b.reading) : null
    })
    must(record.s2b, 'no bare reference (s2b) to judge against')
    must(tools.placed?.gap > 200, `the reader was not above the bottom when reading began (gap ${tools.placed?.gap}px)`)
    must(tools.toolsAfterReading > tools.toolsAtStart, `no tool rows arrived while reading (${tools.toolsAtStart} → ${tools.toolsAfterReading}): nothing was streaming`)

    if (record.s2b) {
      const { limits, why } = judgeAgainst(tools.reading, record.s2b.reading, { mode: 'reading' })

      entry.evidence.limits = limits
      why.forEach(reason => must(false, reason))
    }
  })

  await check('s3', async (entry, must) => {
    if (!tools) {
      throw new Error('s2 did not run the scenario')
    }

    Object.assign(entry.evidence, { backToBottom: tools.bottom, fold: tools.fold, perf: brief(tools.pinned), bare: record.s2b ? brief(record.s2b.pinned) : null })
    must(record.s2b, 'no bare reference (s2b) to judge against')
    must(tools.bottom?.gap <= 2, `could not get to the bottom by wheel (gap ${tools.bottom?.gap}px)`)
    // 40 calls, a note before every tenth: Hermes draws four runs of ten.
    must(tools.fold.lastSeg === 'closed' && /^40 tool calls\b/.test(tools.fold.steps ?? ''), `the finished turn is not folded as 40 tool calls: ${JSON.stringify(tools.fold)}`)

    if (record.s2b) {
      const { limits, why } = judgeAgainst(tools.pinned, record.s2b.pinned, { mode: 'pinned' })

      entry.evidence.limits = limits
      why.forEach(reason => must(false, reason))
    }
  })

  // ── s4. Five queued prompts ──────────────────────────────────────────────
  const queueScenario = async (entry, tag) => {
    await newSession()
    await type(`Hold this one, ${tag}_HOLD. MGS_HOLD`, 'Enter')
    await Promise.race([mock.waitForHeldStream(), sleep(30_000).then(() => Promise.reject(new Error('the model never held the first prompt')))])
    await waitFor(running => Boolean(document.querySelector(running)), RUNNING, 15_000, 'a running marker')

    const queued = [1, 2, 3, 4, 5].map(n => `Queued prompt ${n}, ${tag}_Q${n}.`)

    for (const prompt of queued) {
      await type(prompt, 'Control+Enter')
      await sleep(150)
    }

    await sleep(1000)

    const whileHeld = { chip: await page.evaluate(() => document.body.innerText.match(/\b\d+ Queued\b/)?.[0] ?? null), modelGotQueued: mock.receivedPrompts.filter(text => text.includes(`${tag}_Q`)).length }

    await shot(entry, `${entry.id}-five-queued-while-held`)

    const stats = await perf(async () => {
      mock.releaseHeldStream()
      await waitIdle(`Done ${tag}_Q5.`, 120_000)
      await sleep(1800)
    })

    return { stats, whileHeld }
  }

  await check('s4', async (entry, must) => {
    entry.id = 's4'

    const { stats, whileHeld } = await queueScenario(entry, 'MGS_S4')
    const counts = {}

    entry.evidence.whileHeld = whileHeld

    for (const n of [1, 2, 3, 4, 5]) {
      counts[`Q${n}`] = { prompt: (await drawn(`Queued prompt ${n}, MGS_S4_Q${n}.`)).prompts, reply: (await drawn(`Done MGS_S4_Q${n}.`)).replies }
    }

    const order = mock.receivedPrompts.map(text => text.match(/MGS_S4_(Q\d|HOLD)/)?.[1]).filter(Boolean)
    const rows = await readable()
    // Every reply a person should be able to read whole: "Reply for … Done …".
    const whole = {}

    for (const n of [1, 2, 3, 4, 5]) {
      whole[`Q${n}`] = rows.some(row => row.text.includes(`Reply for MGS_S4_Q${n}.`) && row.text.includes(`Done MGS_S4_Q${n}.`))
    }

    entry.evidence.rows = rows.slice(-14)
    entry.evidence.wholeRepliesReadable = whole

    Object.assign(entry.evidence, { counts, modelOrder: order, perf: brief(stats), bubbles: await page.evaluate(() => document.querySelectorAll('[data-mg-queued]').length) })
    await shot(entry, 's4-after-all-five')

    entry.id = 's4-bare'

    const bare = await bareRun(() => queueScenario(entry, 'MGS_S4B'))

    entry.id = 's4'
    entry.evidence.bare = { unloaded: bare.unloaded, perf: brief(bare.stats) }
    must(bare.unloaded, 'Monograph was still loaded during the bare reference run')
    must(entry.evidence.whileHeld.modelGotQueued === 0, 'a queued prompt reached the model while the first one was held')
    must(
      Object.values(counts).every(count => count.prompt === 1 && count.reply === 1),
      `each queued prompt and its reply should be drawn once: ${JSON.stringify(counts)}`
    )
    must([...new Set(order)].join(',') === 'HOLD,Q1,Q2,Q3,Q4,Q5', `the model got the prompts in the order ${order.join(',')}`)
    must(Object.values(whole).every(Boolean), `replies that cannot be read whole on screen: ${Object.entries(whole).filter(([, ok]) => !ok).map(([key]) => key).join(', ')}`)

    const { limits, why } = judgeAgainst(stats, bare.stats, { mode: 'pinned' })

    entry.evidence.limits = limits
    why.forEach(reason => must(false, reason))
  })

  // ── s5. Stop mid-stream ──────────────────────────────────────────────────
  const stopScenario = async (entry, tag) => {
    await newSession()
    await type(`Stop me halfway, ${tag}. MGS_SLOW(30)`, 'Enter')
    await waitText('word40 ', 30_000)

    let stoppedAfter = null
    const stats = await perf(async () => {
      await sleep(400)

      const stop = page.locator('button[aria-label="Stop"]').first()

      await stop.click({ timeout: 5000 })

      const clicked = Date.now()

      await waitFor(running => !document.querySelector(running), RUNNING, 10_000, 'the turn to stop')
      stoppedAfter = Date.now() - clicked
      await sleep(1500)
    })

    return { stats, stoppedAfter }
  }

  await check('s5', async (entry, must) => {
    entry.id = 's5'

    const { stats, stoppedAfter } = await stopScenario(entry, 'MGS_S5')
    const partial = await drawn('word40 ')
    const after = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-slot="aui_assistant-message-root"]')].at(-1)

      return { seg: row?.dataset.mgSeg ?? null, shown: row ? row.checkVisibility() && row.getBoundingClientRect().height > 0 : false, text: (row?.textContent ?? '').slice(-80) }
    })

    await shot(entry, 's5-after-stop')
    await type('After the stop, MGS_S5B.', 'Enter')
    await waitIdle('Done MGS_S5B.', 60_000).catch(error => must(false, `the next prompt after a stop did not finish: ${error.message}`))

    Object.assign(entry.evidence, { after, nextPrompt: await drawn('Done MGS_S5B.'), partial, perf: brief(stats), stoppedAfterMs: stoppedAfter, slowDone: (await drawn('MGS_S5 MGS_SLOW_DONE')).replies })

    const bare = await bareRun(() => stopScenario(entry, 'MGS_S5R'))

    entry.evidence.bare = { unloaded: bare.unloaded, perf: brief(bare.stats), stoppedAfterMs: bare.stoppedAfter }
    must(bare.unloaded, 'Monograph was still loaded during the bare reference run')
    must(stoppedAfter !== null && stoppedAfter < 5000, `the turn kept running ${stoppedAfter}ms after Stop`)
    must(partial.replies === 1, `the partial reply should stay on screen once, it is drawn ${partial.replies} time(s)`)
    must(entry.evidence.slowDone === 0, 'the stopped reply still ran to its end')
    must(entry.evidence.nextPrompt.replies === 1, `the reply after the stop is drawn ${entry.evidence.nextPrompt.replies} time(s)`)

    const { limits, why } = judgeAgainst(stats, bare.stats, { mode: 'pinned' })

    entry.evidence.limits = limits
    why.forEach(reason => must(false, reason))
  })

  // ── s6. Switch session mid-turn and back ─────────────────────────────────
  const switchScenario = async (entry, tag) => {
    await newSession()
    await type(`Switch away and back, ${tag}. MGS_SLOW(14)`, 'Enter')
    await waitText('word30 ', 30_000)
    await openSession('MGS long thread')
    await sleep(2000)

    const awayShows = await drawn(tag)
    const stats = await perf(async () => {
      await openSession(`Switch away and back, ${tag}`)
      await waitIdle(`${tag} MGS_SLOW_DONE`, 60_000)
      await sleep(1800)
    })

    return { awayShows, stats }
  }

  await check('s6', async (entry, must) => {
    entry.id = 's6'

    const { awayShows, stats } = await switchScenario(entry, 'MGS_S6')

    entry.evidence.awayShows = awayShows
    entry.evidence.prompt = await drawn('Switch away and back, MGS_S6')
    entry.evidence.reply = await drawn('word10 ')
    entry.evidence.ending = await drawn('MGS_S6 MGS_SLOW_DONE')
    entry.evidence.perf = brief(stats)
    await shot(entry, 's6-back-after-switch')

    const bare = await bareRun(() => switchScenario(entry, 'MGS_S6R'))

    entry.evidence.bare = { unloaded: bare.unloaded, perf: brief(bare.stats) }
    must(bare.unloaded, 'Monograph was still loaded during the bare reference run')
    must(entry.evidence.awayShows.prompts === 0 && entry.evidence.awayShows.replies === 0, `the other session shows this turn: ${JSON.stringify(entry.evidence.awayShows)}`)
    must(entry.evidence.prompt.prompts === 1, `the prompt is drawn ${entry.evidence.prompt.prompts} time(s) after coming back`)
    must(entry.evidence.reply.replies === 1 && entry.evidence.ending.replies === 1, `the reply is drawn ${entry.evidence.reply.replies} time(s) (start) and ${entry.evidence.ending.replies} time(s) (end)`)

    if (!entry.evidence.reply.stale) {
      results.observations.push('s6: Hermes left no live copy of the turn this time (no [data-mg-stale] node), so markStale had nothing to hide; the check proves the thread was drawn once, not that the copy rule works.')
    }

    const { limits, why } = judgeAgainst(stats, bare.stats)

    entry.evidence.limits = limits
    why.forEach(reason => must(false, reason))
  })

  // ── s7. Resize while streaming ───────────────────────────────────────────
  const resizeScenario = async tag => {
    await newSession()
    await type(`Resize while I write, ${tag}. MGS_SLOW(12)`, 'Enter')
    await waitText('word20 ', 30_000)
    await wheelTo('down')

    const sizes = []
    const stats = await perf(async () => {
      for (const width of [900, 1500, 1000, 1800, 1220]) {
        sizes.push({ width, ...(await setWindow({ width })), ...(await view()) })
        await sleep(900)
      }

      await waitIdle(`${tag} MGS_SLOW_DONE`, 60_000)
      await sleep(1500)
    })

    await setWindow({ height: 800, width: 1220 })

    return { sizes, stats }
  }

  await check('s7', async (entry, must) => {
    const { sizes, stats } = await resizeScenario('MGS_S7')

    Object.assign(entry.evidence, { perf: brief(stats), sizes })
    await shot(entry, 's7-after-resizes')

    const bare = await bareRun(() => resizeScenario('MGS_S7R'))

    entry.evidence.bare = { unloaded: bare.unloaded, perf: brief(bare.stats) }
    must(bare.unloaded, 'Monograph was still loaded during the bare reference run')

    // A window resize moves things with no input by nature: shifts are
    // reported, not judged.
    const { limits, why } = judgeAgainst(stats, bare.stats, { mode: 'pinned', shifts: false })

    entry.evidence.limits = limits
    why.forEach(reason => must(false, reason))
  })

  // ── s8. A 2,000-line reply ───────────────────────────────────────────────
  // The bare reference (s8b) runs first, so s8 can be judged against it.
  const longReply = async (entry, tag) => {
    await newSession()
    await type(`A very long reply, ${tag}. MGS_LONG(2000)`, 'Enter')
    await waitText('MGS_LONG_BEGIN', 30_000)

    const began = Date.now()
    const streaming = await perf(async () => {
      await waitIdle(`${tag} MGS_LONG_DONE`, 180_000)
      await sleep(1500)
    })
    const streamedMs = Date.now() - began
    const scrolling = await perf(async () => {
      await wheelTo('up', { step: 1200 })
      await sleep(800)
      await wheelTo('down', { step: 1200 })
      await sleep(800)
    })

    return { scrolling, streamedMs, streaming }
  }

  await check('s8b', async (entry, must) => {
    const long = await bareRun(() => longReply(entry, 'MGS_S8B'))

    record.s8b = long
    Object.assign(entry.evidence, {
      monograph: long.unloaded ? 'unloaded' : 'loaded',
      streamedMs: long.streamedMs,
      streaming: brief(long.streaming),
      scrolling: brief(long.scrolling),
      streamingVerdict: judgePerf(long.streaming, { mode: 'pinned' }),
      scrollingVerdict: judgePerf(long.scrolling)
    })
    must(long.unloaded, 'Monograph was still loaded during the reference run')
    must(await page.evaluate(() => Boolean(document.getElementById('mg-css'))), 'Monograph did not come back after the reference run')
  })

  await check('s8', async (entry, must) => {
    const long = await longReply(entry, 'MGS_S8')

    Object.assign(entry.evidence, {
      drawn: await drawn('MGS_S8 MGS_LONG_DONE'),
      streamedMs: long.streamedMs,
      streaming: brief(long.streaming),
      scrolling: brief(long.scrolling),
      bare: record.s8b ? { streaming: brief(record.s8b.streaming), scrolling: brief(record.s8b.scrolling) } : null
    })
    await shot(entry, 's8-long-reply')
    must(record.s8b, 'no bare reference (s8b) to judge against')
    must(entry.evidence.drawn.replies === 1, `the long reply is drawn ${entry.evidence.drawn.replies} time(s)`)

    if (record.s8b) {
      const streaming = judgeAgainst(long.streaming, record.s8b.streaming, { mode: 'pinned' })
      const scrolling = judgeAgainst(long.scrolling, record.s8b.scrolling)

      entry.evidence.limits = { streaming: streaming.limits, scrolling: scrolling.limits }
      streaming.why.forEach(reason => must(false, `while streaming: ${reason}`))
      scrolling.why.forEach(reason => must(false, `while scrolling it: ${reason}`))
    }
  })

  // ── s9. Menus while streaming ────────────────────────────────────────────
  const menusWhileStreaming = async (entry, tag) => {
    // Both runs start from the same page: freshly loaded, then a new session.
    // Without this the page carries whatever the checks before left mounted
    // (s8's 2,000-line reply among it), and the two runs were judged on pages
    // of 6,300 and 3,700 elements.
    await page.reload()
    await waitForAppReady({ app: state.app, page }, 60_000)
    await sleep(1500)
    await newSession()
    await type(`Menus while I write, ${tag}. MGS_SLOW(16)`, 'Enter')
    await waitText('word10 ', 30_000)

    const triggers = [
      ['surfaces', '[data-tour="mg-surfaces"] .mg-surfaces-hit'],
      ['model', 'button:is([data-tour="model-pill"], [aria-label^="Model · "])'],
      ['approval', '.mg-chip[data-mg-approval]'],
      ['effort', '[data-testid="reasoning-pill"]']
    ]
    const log = { maxOpenAtOnce: 0, opened: {}, pressed: {}, rounds: 0 }
    const openMenus = () =>
      page.evaluate(() => [...document.querySelectorAll('[data-slot="dropdown-menu-content"], .mg-surfaces-menu, [role="menu"]')].filter(node => node.checkVisibility()).length)

    const stats = await perf(async () => {
      for (let round = 0; round < 6; round++) {
        for (const [name, selector] of triggers) {
          const box = await page.locator(selector).filter({ visible: true }).first().boundingBox({ timeout: 3000 }).catch(() => null)

          if (!box) {
            continue
          }

          const x = box.x + box.width / 2
          const y = box.y + box.height / 2

          await page.mouse.click(x, y)
          log.pressed[name] = (log.pressed[name] ?? 0) + 1
          await sleep(120)

          const open = await openMenus()

          log.maxOpenAtOnce = Math.max(log.maxOpenAtOnce, open)
          log.opened[name] = (log.opened[name] ?? 0) + (open ? 1 : 0)
          // A second press on the same spot closes it (Escape would stop the turn
          // if the menu had not opened).
          await page.mouse.click(x, y)
          await sleep(120)
        }

        log.rounds += 1
      }

      await sleep(400)
      log.openAtEnd = await openMenus()
      await waitIdle(`${tag} MGS_SLOW_DONE`, 60_000)
      await sleep(1500)
    })

    // How big the page is: Hermes keeps other sessions' threads mounted,
    // and a rule that restyles the whole page costs in proportion.
    log.elements = await page.evaluate(() => document.querySelectorAll('*').length)

    return { log, reply: await drawn(`${tag} MGS_SLOW_DONE`), stats }
  }

  // The bare reference first (only the model and effort menus exist there),
  // so that s9 can be judged against it.
  await check('s9b', async (entry, must) => {
    await hotReload({ gone: true, source: stubPlugin() })

    try {
      const { log, reply, stats } = await menusWhileStreaming(entry, 'MGS_S9B')

      record.s9bStats = stats
      Object.assign(entry.evidence, { menus: log, perf: brief(stats), reply, verdict: judgePerf(stats, { mode: 'pinned' }) })
    } finally {
      await hotReload()
    }

    must(await page.evaluate(() => Boolean(document.getElementById('mg-css'))), 'Monograph did not come back after the reference run')
  })

  await check('s9', async (entry, must) => {
    const { log, reply, stats } = await menusWhileStreaming(entry, 'MGS_S9')

    record.s9 = brief(stats)
    Object.assign(entry.evidence, { menus: log, perf: brief(stats), reply, bare: record.s9bStats ? brief(record.s9bStats) : null })
    await shot(entry, 's9-after-menus')
    must(Object.keys(log.pressed).length === 4, `only ${Object.keys(log.pressed).join(', ')} could be pressed`)
    must(Object.entries(log.pressed).every(([name, count]) => log.opened[name] === count), `not every press opened its menu: opened ${JSON.stringify(log.opened)} of pressed ${JSON.stringify(log.pressed)}`)
    must(log.maxOpenAtOnce <= 1, `${log.maxOpenAtOnce} menus were open at once`)
    must(log.openAtEnd === 0, `${log.openAtEnd} menu(s) still open at the end`)
    must(reply.replies === 1, 'the streaming reply did not finish once (it was stopped, or drawn twice)')
    must(record.s9bStats, 'no bare reference to judge against (s9b did not record one)')

    if (record.s9bStats) {
      const { limits, why } = judgeAgainstBare(stats, record.s9bStats, { longTaskFactor: 2, mode: 'pinned' })

      entry.evidence.limits = limits

      for (const reason of why) {
        must(false, reason)
      }
    }
  })

  // Which menu costs what: each trigger pressed open and shut eight times
  // while a reply streams, one trigger per reply. Numbers only.
  await check('s9c', async entry => {
    const triggers = [
      ['surfaces', '[data-tour="mg-surfaces"] .mg-surfaces-hit'],
      ['model', 'button:is([data-tour="model-pill"], [aria-label^="Model · "])'],
      ['approval', '.mg-chip[data-mg-approval]'],
      ['effort', '[data-testid="reasoning-pill"]'],
      ['none (the reply alone)', null]
    ]

    for (const [name, selector] of triggers) {
      const tag = `MGS_S9C_${name.slice(0, 4).toUpperCase()}`

      await newSession()
      await type(`One menu, ${tag}. MGS_SLOW(16)`, 'Enter')
      await waitText('word6 ', 30_000)

      const stats = await perf(async () => {
        const started = Date.now()

        for (let round = 0; round < 8 && selector; round++) {
          const box = await page.locator(selector).filter({ visible: true }).first().boundingBox({ timeout: 3000 }).catch(() => null)

          if (!box) {
            break
          }

          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          await sleep(120)
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          await sleep(120)
        }

        // The same length of recording for every trigger.
        await sleep(Math.max(0, 4500 - (Date.now() - started)))
      })

      const { fps, frameMs, longTasks, secs } = brief(stats)
      // Then four more presses under the browser's trace: what each open and
      // close costs in style work, and how much of the page it restyles.
      const style = selector
        ? await styleCost(async () => {
            for (let round = 0; round < 4; round++) {
              const box = await page.locator(selector).filter({ visible: true }).first().boundingBox({ timeout: 3000 }).catch(() => null)

              if (!box) {
                break
              }

              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
              await sleep(120)
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
              await sleep(120)
            }
          })
        : null

      entry.evidence[name] = { fps, frameMs, longTasks, secs, style, elements: await page.evaluate(() => document.querySelectorAll('*').length) }
      await waitIdle(`${tag} MGS_SLOW_DONE`, 60_000).catch(() => undefined)
    }
  })

  // ── s0. The painted sampler can fail, and what it does not report ─────────
  // Three planted cases on the 100-turn thread, at the bottom:
  //   grown and closed: 150 px are added and an observer made before the
  //     sampler (as Monograph's and Hermes' are) scrolls them away before
  //     paint. The rAF read sees a gap; the painted read must not.
  //   one painted frame: the view is put 100 px up from a timer and back two
  //     frames later. The painted read must see it, for 1 to 3 frames.
  //   left off: the view is put 120 px up and left there. The pinned verdict
  //     must fail.
  await check('s0', async (entry, must) => {
    await openSession('MGS long thread')
    await sleep(1500)
    await wheelTo('down')
    await sleep(600)

    const plant = body => page.evaluate(`(() => { const v = ${ON_SCREEN_VIEWPORT}; ${body} })()`)

    // The self-test needs a thread that can scroll: in the full run the view
    // on screen was once one that could not, and every read was 0 (it passed
    // alone). What the view is, and room planted when it is too short.
    entry.evidence.view = await plant(`
      const all = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')]
      const before = v ? { scrollHeight: v.scrollHeight, clientHeight: v.clientHeight, scrollTop: Math.round(v.scrollTop) } : null
      if (v && v.scrollHeight - v.clientHeight < 600) {
        const room = document.createElement('div')
        room.id = 'mg-plant-room'
        room.style.height = '2400px'
        v.querySelector('[data-slot="aui_thread-content"]')?.prepend(room)
        v.scrollTop = v.scrollHeight
      }
      return { viewports: all.length, shown: all.filter(node => node.getBoundingClientRect().height > 10).length, before, roomPlanted: Boolean(document.getElementById('mg-plant-room')), title: document.title, rows: v ? v.querySelectorAll('[data-slot="aui_assistant-message-root"]').length : 0 }
    `)
    await sleep(400)
    entry.evidence.scrollable = await plant(`return v ? v.scrollHeight - v.clientHeight : 0`)
    must(entry.evidence.scrollable >= 600, `the view on screen cannot scroll (${entry.evidence.scrollable} px), so the self-test would prove nothing: ${JSON.stringify(entry.evidence.view)}`)

    await plant(`
      const t = v.querySelector('[data-slot="aui_thread-content"]')
      window.__mgPlantRo = new ResizeObserver(() => { v.scrollTop = v.scrollHeight })
      window.__mgPlantRo.observe(t)
    `)

    const closed = await perf(async () => {
      await sleep(300)
      await plant(`
        setTimeout(() => {
          const d = document.createElement('div')
          d.id = 'mg-plant'
          d.style.height = '150px'
          v.querySelector('[data-slot="aui_thread-content"]').appendChild(d)
        }, 0)
      `)
      await sleep(700)
    })

    await plant(`window.__mgPlantRo.disconnect(); delete window.__mgPlantRo; document.getElementById('mg-plant')?.remove(); v.scrollTop = v.scrollHeight`)
    await sleep(500)

    const oneFrame = await perf(async () => {
      await sleep(300)
      await plant(`
        setTimeout(() => {
          v.scrollTop -= 100
          requestAnimationFrame(() => requestAnimationFrame(() => { v.scrollTop = v.scrollHeight }))
        }, 0)
      `)
      await sleep(700)
    })

    await sleep(300)

    const leftOff = await perf(async () => {
      await sleep(300)
      await plant(`v.scrollTop -= 120`)
      await sleep(700)
    })

    await plant(`document.getElementById('mg-plant-room')?.remove()`)
    await wheelTo('down')

    const sum = stats => ({ painted: { gapMax: stats.viewport.gapMax, gapRunMax: stats.viewport.gapRunMax, gapFinal: stats.viewport.gapFinal }, raf: stats.viewport.raf, rafGapsNeverPainted: stats.viewport.rafGapsNeverPainted })

    Object.assign(entry.evidence, { grownAndClosed: sum(closed), onePaintedFrame: sum(oneFrame), leftOff: sum(leftOff), leftOffVerdict: judgePerf(leftOff, { mode: 'pinned' }) })
    must(closed.viewport.raf?.gapMax >= 140, `grown and closed: the rAF read should see the 150 px before the observer closes it, it saw ${closed.viewport.raf?.gapMax}`)
    must(closed.viewport.gapMax <= 2, `grown and closed: the painted read reports ${closed.viewport.gapMax} px, a gap that was never painted`)
    must(oneFrame.viewport.gapMax >= 95 && oneFrame.viewport.gapRunMax >= 1 && oneFrame.viewport.gapRunMax <= 3, `one painted frame: the painted read should see 100 px for 1 to 3 frames, it saw ${oneFrame.viewport.gapMax} px for ${oneFrame.viewport.gapRunMax}`)
    must(judgePerf(leftOff, { mode: 'pinned' }).length > 0 && leftOff.viewport.gapFinal >= 100, `left off: the pinned verdict passed a view left 120 px off the bottom (${leftOff.viewport.gapFinal} px at the end)`)
  })

  // ── s10. Thinking ─────────────────────────────────────────────────────────
  // Reasoning in 400 small pieces over 20 s, then an answer. While it streams
  // its text is visible (opacity 1, no box); when the answer starts it folds
  // to its header line; a press or Enter on the header unfolds it in full and
  // folds it again, and the header does not move. Judged pinned and 600 px
  // above the bottom, against bare Hermes in the same run.
  const thinkState = () =>
    page.evaluate(`(() => {
      const v = ${ON_SCREEN_VIEWPORT}
      const boxes = v ? [...v.querySelectorAll('[data-slot="aui_thinking-disclosure"]')] : []
      const box = boxes.at(-1)
      const body = box?.querySelector('[data-slot="aui_thinking-body"]')
      const header = box?.querySelector('button[aria-expanded]')
      const r = body?.getBoundingClientRect()

      return box ? {
        boxes: boxes.length,
        state: box.dataset.mgThink ?? null,
        opacity: getComputedStyle(box).opacity,
        bodyHeight: r ? Math.round(r.height) : 0,
        bodyShown: Boolean(body && body.checkVisibility({ visibilityProperty: true }) && r.height > 4),
        textLength: (body?.textContent ?? '').length,
        expanded: header?.getAttribute('aria-expanded') ?? null,
        headerTop: header ? Math.round(header.getBoundingClientRect().top * 10) / 10 : null
      } : { boxes: 0 }
    })()`)

  const thinkScenario = async (tag, mode, press = false) => {
    await newSession()

    if (mode === 'reading') {
      await type(`Some text to read first, ${tag}_F. MGS_PROSE(60,4)`, 'Enter')
      await waitIdle(`${tag}_F MGS_PROSE_DONE`, 60_000)
    }

    await type(`Think a long time, ${tag}. MGS_THINKLONG(400,50)`, 'Enter')
    // Bare Hermes in Simple mode keeps live reasoning collapsed: wait for the block, not its words.
    await waitFor(`Boolean((${ON_SCREEN_VIEWPORT})?.querySelector('[data-slot="aui_thinking-disclosure"]'))`, undefined, 30_000, 'the thinking block')
    await sleep(1000)

    if (mode === 'reading') {
      await readAbove(600)
    }

    const seen = { whileStreaming: null, afterAnswer: null }
    const stats = await perf(async () => {
      await sleep(3000)
      seen.whileStreaming = await thinkState()
      await waitText('The answer after a long think', 40_000)
      await sleep(900)
      seen.afterAnswer = await thinkState()

      if (!press) {
        await waitIdle(`${tag} MGS_THINKLONG_DONE`, 60_000)
        await sleep(1200)
      }
    })

    // While the answer streams: a press opens it, Enter folds it, Enter
    // opens it. A press on the header holds the header under the pointer
    // (the view leaves the bottom on purpose), so the record above, judged
    // for "at the bottom", ends at the press; from the press on, what is
    // judged is that the pressed header does not move, in any painted frame.
    if (press && seen.afterAnswer.boxes) {
      const header = page.locator('[data-slot="aui_thinking-disclosure"] button[aria-expanded]').last()

      seen.before = await thinkState()
      await header.evaluate(node => {
        const top = node.getBoundingClientRect().top
        const log = (window.__mgHeaderDrift = { max: 0, frames: 0, worst: null, on: true })
        const tick = () => {
          if (!log.on) {
            return
          }

          // Read after the frame's layout (the rAF before it can lag a frame).
          const d = node.isConnected ? Math.abs(node.getBoundingClientRect().top - top) : 0

          log.frames += 1

          if (d > log.max) {
            log.max = Math.round(d * 10) / 10
            log.worst = log.frames
          }

          requestAnimationFrame(() => setTimeout(tick, 0))
        }

        requestAnimationFrame(() => setTimeout(tick, 0))
      })
      await header.click({ timeout: 5000 })
      await sleep(700)
      seen.opened = await thinkState()
      await header.focus()
      await page.keyboard.press('Enter')
      await sleep(700)
      seen.closed = await thinkState()
      await page.keyboard.press('Enter')
      await sleep(700)
      seen.reopened = await thinkState()
      seen.headerDrift = await page.evaluate(() => {
        window.__mgHeaderDrift.on = false

        return window.__mgHeaderDrift
      })
      await waitIdle(`${tag} MGS_THINKLONG_DONE`, 60_000)
      await sleep(1200)
    }

    return { seen, stats }
  }

  const thinkRecord = {}

  await check('s10b', async (entry, must) => {
    entry.id = 's10b'

    const bare = await bareRun(async () => ({ pinned: await thinkScenario('MGS_T10B', 'pinned'), reading: await thinkScenario('MGS_T10BR', 'reading') }))

    thinkRecord.bare = bare
    entry.evidence.pinned = brief(bare.pinned.stats)
    entry.evidence.reading = brief(bare.reading.stats)
    entry.evidence.seen = bare.pinned.seen
    must(bare.unloaded, 'Monograph was still loaded during the bare reference run')
  })

  // Long tasks over 50 ms that bare Hermes does not have: no more of them
  // than bare had, plus one (stated margin: one task, for a machine that
  // runs other rigs at the same time).
  const noNewLongTasks = (stats, bare, must) => {
    must(stats.longtasks.n <= bare.longtasks.n + 1, `${stats.longtasks.n} long tasks over 50 ms (bare Hermes: ${bare.longtasks.n}; allowed ${bare.longtasks.n + 1}); longest ${stats.longtasks.top.slice(0, 3).map(task => task.d).join(', ')} ms`)
  }

  await check('s10', async (entry, must) => {
    entry.id = 's10'

    const { seen, stats } = await thinkScenario('MGS_T10', 'pinned', true)

    Object.assign(entry.evidence, { seen, perf: brief(stats), bare: thinkRecord.bare ? brief(thinkRecord.bare.pinned.stats) : null })
    must(seen.whileStreaming?.boxes === 1, `while reasoning streams there should be one thinking block, there are ${seen.whileStreaming?.boxes}`)
    must(seen.whileStreaming?.bodyShown && seen.whileStreaming.textLength > 100, `the reasoning text is not visible while it streams: ${JSON.stringify(seen.whileStreaming)}`)
    must(seen.whileStreaming?.opacity === '1', `the streaming reasoning is drawn at opacity ${seen.whileStreaming?.opacity}`)
    must(seen.afterAnswer?.state === 'folded' && !seen.afterAnswer.bodyShown && seen.afterAnswer.expanded === 'false', `once the answer came the reasoning did not fold to its line: ${JSON.stringify(seen.afterAnswer)}`)

    if (thinkRecord.bare) {
      const bare = thinkRecord.bare.pinned.stats

      // "Zero jumps": the view never off the bottom in a painted frame.
      must(stats.viewport.gapRunMax <= bare.viewport.gapRunMax && stats.viewport.gapFinal <= Math.max(1, bare.viewport.gapFinal), `off the bottom for ${stats.viewport.gapRunMax} painted frame(s) (gap up to ${stats.viewport.gapMax} px, ${stats.viewport.gapFinal} px at the end; bare Hermes: ${bare.viewport.gapRunMax} frames)`)
      must(stats.shifts.noInput <= bare.shifts.noInput, `${stats.shifts.noInput} layout shifts with no input (bare Hermes: ${bare.shifts.noInput})`)
      noNewLongTasks(stats, bare, must)
    }

    const { before, opened, closed, reopened } = seen

    must(before && opened && closed && reopened, 'the fold was not pressed while the answer streamed')
    await shot(entry, 's10-thinking-open')
    must(opened?.state === 'open' && opened.bodyShown && opened.expanded === 'true' && opened.bodyHeight > 160, `a press did not open the whole reasoning: ${JSON.stringify(opened)}`)
    must(opened && Math.abs(opened.headerTop - before.headerTop) < 1, `the header moved ${opened.headerTop - before.headerTop} px when it opened`)
    must(seen.headerDrift && seen.headerDrift.frames > 20 && seen.headerDrift.max < 1, `the pressed header moved up to ${seen.headerDrift?.max} px in a frame while it opened, folded and opened again (frame ${seen.headerDrift?.worst} of ${seen.headerDrift?.frames})`)
    must(closed?.state === 'folded' && !closed.bodyShown, `Enter did not fold it again: ${JSON.stringify(closed)}`)
    must(reopened?.state === 'open' && reopened.bodyShown, `Enter did not open it: ${JSON.stringify(reopened)}`)
  })

  await check('s10r', async (entry, must) => {
    entry.id = 's10r'

    const { seen, stats } = await thinkScenario('MGS_T10R', 'reading')

    Object.assign(entry.evidence, { seen, perf: brief(stats), bare: thinkRecord.bare ? brief(thinkRecord.bare.reading.stats) : null })
    must(seen.afterAnswer?.state === 'folded', `the reasoning did not fold while the reader was above: ${JSON.stringify(seen.afterAnswer)}`)
    // Reading older text: it may not move by even 1 px.
    must(stats.viewport.anchorNoInput < 1, `the text being read moved ${stats.viewport.anchorNoInput} px with no input (largest step ${stats.viewport.anchorNoInputMax}); first: ${JSON.stringify(stats.viewport.anchorEvents.slice(0, 3))}`)

    if (thinkRecord.bare) {
      noNewLongTasks(stats, thinkRecord.bare.reading.stats, must)
    }
  })

  // ── s10n. No reasoning; the working indicator ─────────────────────────────
  // A reply with no reasoning shows no thinking block, empty or not. While a
  // turn runs one row of the thread carries data-mg-working and draws one
  // pulsing bar (opacity only); at the end it is gone; with motion off it is
  // not drawn.
  await check('s10n', async (entry, must) => {
    const indicator = () =>
      page.evaluate(`(() => {
        const v = ${ON_SCREEN_VIEWPORT}
        const rows = v ? [...v.querySelectorAll('.mg-line[data-mg-working]')] : []
        const bar = rows[0]?.querySelector('.mg-line-bar')
        const style = bar ? getComputedStyle(bar) : null
        const anims = bar ? bar.getAnimations().map(a => a.animationName + ':' + a.playState + ':' + Object.keys(a.effect?.getKeyframes?.()[0] ?? {}).filter(k => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).join('+')) : []

        return { rows: rows.length, shown: Boolean(bar && bar.checkVisibility() && bar.getBoundingClientRect().height > 0), height: style?.height ?? null, animation: style?.animationName ?? null, anims, thinking: v ? v.querySelectorAll('[data-slot="aui_thinking-disclosure"]').length : 0 }
      })()`)

    await newSession()
    await type('No reasoning here, MGS_S10N. MGS_SLOW(5)', 'Enter')
    await waitText('word10 ', 30_000)

    const running = await indicator()

    await shot(entry, 's10n-working')
    await waitIdle('MGS_S10N MGS_SLOW_DONE', 60_000)
    await sleep(1200)

    const ended = await indicator()

    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'off'
    })
    await type('Motion off, MGS_S10M. MGS_SLOW(4)', 'Enter')
    await waitText('word10 ', 30_000)

    const off = await indicator()

    await waitIdle('MGS_S10M MGS_SLOW_DONE', 60_000)
    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'on'
    })

    Object.assign(entry.evidence, { running, ended, motionOff: off })
    must(running.thinking === 0 && ended.thinking === 0, `a thinking block was drawn for a reply with no reasoning: ${running.thinking}, ${ended.thinking}`)
    must(running.rows === 1 && running.shown && running.animation === 'monograph-pulse', `while running, one line should draw the working bar: ${JSON.stringify(running)}`)
    must(running.anims.every(name => !/transform/.test(name)), `the indicator animates more than opacity: ${running.anims}`)
    must(ended.rows === 0, `the working bar is still there after the turn: ${JSON.stringify(ended)}`)
    must(!off.shown && off.anims.length === 0, `with motion off the working bar is drawn: ${JSON.stringify(off)}`)
  })

  // ── s11. Streaming feel ───────────────────────────────────────────────────
  // Every situation of the brief, pinned and again 600 px above the bottom,
  // each against bare Hermes in the same run: no jump over 2 px for more
  // than one painted frame, ends pinned if it was pinned, reading never moves
  // by even 1 px, and no frame over 100 ms that bare does not have.
  const FEEL = {
    prose: { prompt: tag => `Long prose, ${tag}. MGS_PROSE(300,16)`, done: tag => `${tag} MGS_PROSE_DONE`, first: 'Prose line 10 ' },
    mixed: { prompt: tag => `Code and tables, ${tag}. MGS_MIXED`, done: tag => `${tag} MGS_MIXED_DONE`, first: 'A reply with code' },
    toolEnd: { prompt: tag => `Three quick calls, ${tag}. MGS_TOOLS(3,0)`, done: tag => `${tag} MGS_TOOLS_DONE`, first: 'Working on step 1' },
    stop: { prompt: tag => `Stop me, ${tag}. MGS_SLOW(20)`, done: null, first: 'word30 ', during: async () => { await sleep(500); await page.locator('button[aria-label="Stop"]').first().click({ timeout: 5000 }); await waitFor(running => !document.querySelector(running), RUNNING, 10_000, 'the turn to stop') } },
    // The connection is cut mid-reply; Hermes shows the error or retries.
    error: { prompt: tag => `Break and retry, ${tag}. MGS_FLAKY(40)`, done: null, first: 'Flaky words', during: async () => { await waitFor(running => !document.querySelector(running), RUNNING, 60_000, 'the broken turn to end') } },
    nextAtEnd: { prompt: tag => `Then another, ${tag}. MGS_SLOW(4)`, done: tag => `Done ${tag}_N.`, first: 'word10 ', during: async tag => { await waitText(`${tag} MGS_SLOW_DONE`, 30_000); await type(`Right after, ${tag}_N.`, 'Enter') } },
    switchBack: { prompt: tag => `Away and back, ${tag}. MGS_SLOW(8)`, done: tag => `${tag} MGS_SLOW_DONE`, first: 'word10 ', during: async tag => { await newSession(); await sleep(1200); await openSession(`Away and back, ${tag}`) } },
    resize: { prompt: tag => `Resize by 200, ${tag}. MGS_SLOW(6)`, done: tag => `${tag} MGS_SLOW_DONE`, first: 'word10 ', during: async () => { await setWindow({ width: 1020 }); await sleep(800); await setWindow({ width: 1220 }) } },
    toolsHidden: { prompt: tag => `Tools off and on, ${tag}. MGS_WORK`, done: tag => `${tag} MGS_WORK_DONE`, first: 'Let me check', during: async () => { await page.evaluate(() => { document.documentElement.dataset.mgTools = 'hidden' }); await sleep(900); await page.evaluate(() => { document.documentElement.dataset.mgTools = 'shown' }) } }
  }

  const feelScenario = async (name, tag, mode) => {
    const spec = FEEL[name]

    await newSession()

    if (mode === 'reading') {
      await type(`Some text to read first, ${tag}_F. MGS_PROSE(60,4)`, 'Enter')
      await waitIdle(`${tag}_F MGS_PROSE_DONE`, 60_000)
    }

    await type(spec.prompt(tag), 'Enter')

    if (spec.first) {
      await waitText(spec.first, 30_000)
    } else {
      await waitFor(running => Boolean(document.querySelector(running)), RUNNING, 30_000, 'the turn to start')
    }

    if (mode === 'reading') {
      await readAbove(600)
    }

    const stats = await perf(async () => {
      await spec.during?.(tag)

      if (spec.done) {
        await waitIdle(spec.done(tag), 90_000)
      }

      await sleep(1500)
    })

    return stats
  }

  const feelAll = async (prefix, modes) => {
    const out = {}

    for (const name of Object.keys(FEEL)) {
      for (const mode of modes) {
        const tag = `${prefix}_${name.toUpperCase()}_${mode === 'reading' ? 'R' : 'P'}`

        try {
          out[`${name}/${mode}`] = await feelScenario(name, tag, mode)
        } catch (error) {
          out[`${name}/${mode}`] = { error: error.message.slice(0, 200) }
        }
      }
    }

    return out
  }

  const feelRecord = {}

  await check('s11b', async (entry, must) => {
    const bare = await bareRun(async () => ({ runs: await feelAll('MGS_F11B', ['pinned', 'reading']) }))

    feelRecord.bare = bare.runs
    must(bare.unloaded, 'Monograph was still loaded during the bare reference run')

    for (const [key, stats] of Object.entries(bare.runs)) {
      entry.evidence[key] = stats.error ? stats : { gapRun: stats.viewport.gapRunMax, gapFinal: stats.viewport.gapFinal, anchor: stats.viewport.anchorNoInput, maxFrame: stats.maxFrame, longTasks: stats.longtasks.n }
    }
  })

  const feelJudge = (entry, must, runs, mode) => {
    for (const [key, stats] of Object.entries(runs)) {
      const bare = feelRecord.bare?.[key]

      if (stats.error) {
        must(false, `${key}: ${stats.error}`)
        continue
      }

      entry.evidence[key] = { gapMax: stats.viewport.gapMax, gapRun: stats.viewport.gapRunMax, gapFinal: stats.viewport.gapFinal, anchor: stats.viewport.anchorNoInput, maxFrame: stats.maxFrame, longTasks: stats.longtasks.n, shifts: stats.shifts.noInput, bare: bare && !bare.error ? { gapRun: bare.viewport.gapRunMax, anchor: bare.viewport.anchorNoInput, maxFrame: bare.maxFrame, shifts: bare.shifts.noInput } : null, framesOver200: stats.loafs?.length ? stats.loafs : undefined }

      if (mode === 'pinned') {
        must(stats.viewport.gapRunMax <= 1, `${key}: off the bottom by more than 2 px for ${stats.viewport.gapRunMax} painted frames in a row (gap up to ${stats.viewport.gapMax} px)`)
        must(stats.viewport.gapFinal <= 1, `${key}: ends ${stats.viewport.gapFinal} px off the bottom`)
      } else {
        must(stats.viewport.anchorNoInput < 1, `${key}: the text being read moved ${stats.viewport.anchorNoInput} px with no input; first: ${JSON.stringify(stats.viewport.anchorEvents.slice(0, 2))}`)
      }

      if (bare && !bare.error) {
        const frameLimit = Math.max(PERF_LIMITS.frameMs, bare.maxFrame + BARE_MARGIN.frameMs)

        must(stats.maxFrame <= frameLimit, `${key}: a frame took ${stats.maxFrame} ms (limit ${frameLimit}: bare Hermes' longest ${bare.maxFrame} ms + ${BARE_MARGIN.frameMs})`)
      }
    }
  }

  await check('s11', async (entry, must) => {
    feelJudge(entry, must, await feelAll('MGS_F11', ['pinned']), 'pinned')
  })

  await check('s11r', async (entry, must) => {
    entry.evidence.openedByTitleStart = openedBy
    feelJudge(entry, must, await feelAll('MGS_F11', ['reading']), 'reading')
  })
}

// ── The model ───────────────────────────────────────────────────────────────
export function startModel({ extraModels = [] } = {}) {
  const receivedPrompts = []
  const held = []
  let heldStarted = null
  let heldPromise = new Promise(resolve => (heldStarted = resolve))
  let completions = 0
  const flakySeen = new Set()

  const chunk = (model, delta, finish = null) =>
    `data: ${JSON.stringify({ id: 'mgs', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

  // A reply streamed as pieces, `every` ms apart. Pieces are strings (content)
  // or { reasoning } objects. `hold` pauses after the first piece.
  const stream = (req, res, model, pieces, { every = 15, hold = false, toolCalls = null } = {}) => {
    res.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' })

    let index = 0
    let timer = 0
    let closed = false

    res.on('close', () => {
      closed = true
      clearTimeout(timer)
    })

    const next = () => {
      if (closed) {
        return
      }

      if (index >= pieces.length) {
        if (toolCalls) {
          res.write(chunk(model, { tool_calls: toolCalls.map((call, i) => ({ function: { arguments: JSON.stringify(call.args), name: call.name }, id: `call_mgs_${Date.now()}_${i}`, index: i, type: 'function' })) }, 'tool_calls'))
        } else {
          res.write(chunk(model, {}, 'stop'))
        }

        res.write('data: [DONE]\n\n')
        res.end()

        return
      }

      const piece = pieces[index++]

      res.write(chunk(model, typeof piece === 'string' ? { content: piece } : { reasoning_content: piece.reasoning }))

      if (hold && index === 1) {
        held.push(() => {
          timer = setTimeout(next, every)
        })
        heldStarted?.()

        return
      }

      timer = setTimeout(next, every)
    }

    next()
  }

  const words = (text, size = 1) => {
    const list = text.split(/(?<= )/)
    const out = []

    for (let i = 0; i < list.length; i += size) {
      out.push(list.slice(i, i + size).join(''))
    }

    return out
  }

  const pieces = (text, size) => {
    const out = []

    for (let i = 0; i < text.length; i += size) {
      out.push(text.slice(i, i + size))
    }

    return out
  }

  const longReply = (lines, tag) => {
    const out = ['Here is the long reply, MGS_LONG_BEGIN.\n\n']
    let n = 0

    while (n < lines) {
      const block = n % 400

      if (block === 100) {
        out.push('```js\n')
        for (let i = 0; i < 60 && n < lines; i++, n++) out.push(`const line${n} = compute(${n}, 'value ${n}') // a code line that is long enough to need some room ${n}\n`)
        out.push('```\n\n')
      } else if (block === 250) {
        out.push('| Column A | Column B | Column C | Column D |\n| --- | --- | --- | --- |\n')
        for (let i = 0; i < 40 && n < lines; i++, n++) out.push(`| row ${n} | value ${n * 2} | text for row ${n} | ${n % 7} |\n`)
        out.push('\n')
      } else {
        out.push(`Line ${n} of the long reply carries some ordinary prose so that it wraps like real text does.\n`)
        n++
      }
    }

    out.push(`\nThe long reply ends here, ${tag} MGS_LONG_DONE.`)

    return out.join('')
  }

  const shortReply = tag => {
    const n = Number(tag.match(/\d+/)?.[0] ?? 0)
    const base = `Reply for ${tag}. This is an ordinary answer with a sentence or two so the row has some height.`

    if (n % 5 === 0) {
      return `${base}\n\n- first point for ${tag}\n- second point\n- third point\n\n\`\`\`py\nprint(\"${tag}\")\nfor i in range(3):\n    print(i)\n\`\`\`\n\nDone ${tag}.`
    }

    if (n % 3 === 0) {
      return `${base}\n\n${'A longer paragraph that wraps over a few lines in the thread column, to vary the heights of rows. '.repeat(3)}\n\nDone ${tag}.`
    }

    return `${base} Done ${tag}.`
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: ['mock-model', ...extraModels].map(id => ({ created: 0, id, object: 'model', owned_by: 'mock' })), object: 'list' }))

      return
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404)
      res.end('{}')

      return
    }

    let body = ''

    req.on('data', part => (body += part))
    req.on('end', () => {
      let parsed = {}

      try {
        parsed = JSON.parse(body)
      } catch {}

      completions += 1

      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const lastUser = messages.map((m, i) => [m, i]).filter(([m]) => m?.role === 'user').at(-1)
      const text = typeof lastUser?.[0]?.content === 'string' ? lastUser[0].content : Array.isArray(lastUser?.[0]?.content) ? lastUser[0].content.map(p => p.text ?? '').join('\n') : ''
      const toolsSince = lastUser ? messages.slice(lastUser[1] + 1).filter(m => m?.role === 'tool').length : 0
      const model = parsed.model || 'mock-model'
      const tag = text.match(/MG[A-Z]*_[A-Z0-9_]+/)?.[0] ?? 'prompt'

      receivedPrompts.push(text)

      if (parsed.stream !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', index: 0, message: { content: 'Short answer.', role: 'assistant' } }], created: 0, id: 'mgs', model, object: 'chat.completion', usage: { completion_tokens: 2, prompt_tokens: 2, total_tokens: 4 } }))

        return
      }

      const tools = text.match(/MGS_TOOLS\((\d+)(?:,(\d+))?\)/)

      if (tools) {
        const n = Number(tools[1])
        const delay = Number(tools[2] ?? 0)

        if (toolsSince < n) {
          const note = toolsSince % 10 === 0 ? words(`Working on step ${toolsSince + 1} of ${n}.`) : []

          setTimeout(() => stream(req, res, model, note, { toolCalls: [{ args: { command: `echo mgs-step-${toolsSince + 1}` }, name: 'terminal' }] }), delay)
        } else {
          stream(req, res, model, words(`All ${n} steps are done, ${tag} MGS_TOOLS_DONE.`))
        }

        return
      }

      const call = /MGS_CALL\(([a-z_]+)\)\[(\{.*\})\]/s.exec(text)

      if (call) {
        if (toolsSince === 0) {
          stream(req, res, model, words('Calling the tool now.'), { toolCalls: [{ args: JSON.parse(call[2]), name: call[1] }] })
        } else {
          stream(req, res, model, words(`The tool finished, ${tag} MGS_CALL_DONE.`))
        }

        return
      }

      if (text.includes('MGS_WORK')) {
        const thought = words('I should look at the files first, then answer. '.repeat(3), 2).map(reasoning => ({ reasoning }))

        if (toolsSince === 0) {
          // Slow enough to be sampled: about 2 s of thinking, a 2 s tool call.
          stream(req, res, model, [...thought, ...words('Let me check something first.')], { every: 120, toolCalls: [{ args: { command: 'sleep 2; echo mgs-work' }, name: 'terminal' }] })
        } else {
          stream(req, res, model, [...thought.slice(0, 6), ...words(`Here is the answer after the work, ${tag} MGS_WORK_DONE.`)], { every: 120 })
        }

        return
      }

      const long = text.match(/MGS_LONG\((\d+)\)/)

      if (long) {
        stream(req, res, model, pieces(longReply(Number(long[1]), tag), 240), { every: 12 })

        return
      }

      const slow = text.match(/MGS_SLOW\((\d+)\)/)

      if (slow) {
        const seconds = Number(slow[1])
        const out = []
        const every = 40
        const count = Math.round((seconds * 1000) / every)

        for (let i = 0; i < count; i++) {
          out.push(i % 60 === 59 ? `word${i}.\n\n` : i % 300 === 150 ? `\n\n\`\`\`\ncode ${i}\n\`\`\`\n\n` : `word${i} `)
        }

        out.push(`The slow reply ends, ${tag} MGS_SLOW_DONE.`)
        stream(req, res, model, out, { every })

        return
      }

      // Reasoning in `n` small pieces, `ms` apart, then an answer in words.
      const thinkLong = text.match(/MGS_THINKLONG\((\d+),(\d+)\)/)

      if (thinkLong) {
        const n = Number(thinkLong[1])
        const thought = Array.from({ length: n }, (_, i) => ({ reasoning: i % 40 === 39 ? `step ${i}.\n\n` : `thought${i} ` }))

        // The answer takes about six seconds, so the fold can be pressed while it streams.
        stream(req, res, model, [...thought, ...words(`The answer after a long think. ${'It goes on for a while so the reasoning above can be opened and folded while the answer still streams. '.repeat(6)}${tag} MGS_THINKLONG_DONE.`)], { every: Number(thinkLong[2]) })

        return
      }

      // `lines` lines of prose, one piece per line, `ms` apart.
      const prose = text.match(/MGS_PROSE\((\d+),(\d+)\)/)

      if (prose) {
        const out = Array.from({ length: Number(prose[1]) }, (_, i) => `Prose line ${i} of the reply, ordinary words that wrap like real text in the column.${i % 6 === 5 ? '\n\n' : ' '}`)

        stream(req, res, model, [...out, `\n\nThe prose ends, ${tag} MGS_PROSE_DONE.`], { every: Number(prose[2]) })

        return
      }

      // Three code blocks, a table and a list, in 40-character pieces.
      if (text.includes('MGS_MIXED')) {
        const code = n => '```js\n' + Array.from({ length: 12 }, (_, i) => `const v${n}_${i} = compute(${i}) // line ${i} of block ${n}`).join('\n') + '\n```\n\n'
        const table = '| Name | Value | Note |\n| --- | --- | --- |\n' + Array.from({ length: 10 }, (_, i) => `| row ${i} | ${i * 3} | a note for row ${i} |`).join('\n') + '\n\n'
        const list = Array.from({ length: 8 }, (_, i) => `- list item ${i}, with a few words`).join('\n') + '\n\n'
        const body = `A reply with code, a table and a list.\n\n${code(1)}Some words between.\n\n${table}${code(2)}${list}${code(3)}The mixed reply ends, ${tag} MGS_MIXED_DONE.`

        stream(req, res, model, pieces(body, 40), { every: 16 })

        return
      }

      // The first time a tag is seen the stream breaks off after `n` words
      // (the connection is cut); Hermes' retry then gets the whole reply.
      const flaky = text.match(/MGS_FLAKY\((\d+)\)/)

      if (flaky) {
        const all = words(`${'Flaky words before the break. '.repeat(30)}The flaky reply ends, ${tag} MGS_FLAKY_DONE.`)

        if (!flakySeen.has(tag)) {
          flakySeen.add(tag)
          res.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' })

          let i = 0
          const next = () => {
            if (i >= Number(flaky[1])) {
              res.socket?.destroy()

              return
            }

            res.write(chunk(model, { content: all[i++] }))
            setTimeout(next, 30)
          }

          next()

          return
        }

        stream(req, res, model, all, { every: 20 })

        return
      }

      if (text.includes('MGS_THINK')) {
        const thought = words('Let me think about this carefully. First I consider the question, then the options, then I weigh them against each other and pick one. '.repeat(4), 2).map(reasoning => ({ reasoning }))

        stream(req, res, model, [...thought, ...words('After thinking, the answer is forty two, MGS_THINK_DONE.')], { every: 25 })

        return
      }

      if (text.includes('MGS_HOLD')) {
        stream(req, res, model, words(`Held reply from the model, it was paused on purpose and now finishes, ${tag} MGS_HOLD_DONE.`), { hold: true, every: 20 })

        return
      }

      stream(req, res, model, words(shortReply(tag), 3), { every: 8 })
    })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()

      resolve({
        close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()) }),
        completions: () => completions,
        port,
        receivedPrompts,
        releaseHeldStream: () => {
          held.splice(0).forEach(go => go())
          heldPromise = new Promise(resolve => (heldStarted = resolve))
        },
        url: `http://127.0.0.1:${port}`,
        waitForHeldStream: () => heldPromise
      })
    })
  })
}

// Durable history made through Hermes' own stdio gateway (tui_gateway.entry),
// the way apps/desktop/e2e/real-session-builder.ts does, with the rig's Python.
async function seedSession({ cwd, env, python, title, turns }) {
  const child = spawn(python, ['-m', 'tui_gateway.entry'], { cwd, env, stdio: 'pipe' })
  const waiting = new Map()
  const events = []
  const watchers = []
  const stderr = []
  let id = 0

  createInterface({ input: child.stderr }).on('line', line => {
    stderr.push(line)
    stderr.length > 60 && stderr.shift()
  })
  createInterface({ input: child.stdout }).on('line', line => {
    let frame

    try {
      frame = JSON.parse(line)
    } catch {
      return
    }

    if (typeof frame.id === 'number' && waiting.has(frame.id)) {
      const { reject, resolve } = waiting.get(frame.id)

      waiting.delete(frame.id)
      frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.result)

      return
    }

    if (frame.method === 'event') {
      const watcher = watchers.find(w => w.test(frame))

      if (watcher) {
        watchers.splice(watchers.indexOf(watcher), 1)
        watcher.resolve(frame)
      } else {
        events.push(frame)
      }
    }
  })

  const timed = (promise, label, ms = 60_000) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`seed: ${label} timed out\n${stderr.join('\n')}`)), ms))])

  const request = (method, params) =>
    timed(
      new Promise((resolve, reject) => {
        id += 1
        waiting.set(id, { reject, resolve })
        child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`)
      }),
      method
    )

  const event = test => {
    const index = events.findIndex(test)

    return index >= 0 ? Promise.resolve(events.splice(index, 1)[0]) : timed(new Promise(resolve => watchers.push({ resolve, test })), 'event')
  }

  try {
    await event(frame => frame.params?.type === 'gateway.ready')

    const created = await request('session.create', { cols: 120, cwd, source: 'desktop', title })
    const runtime = created.session_id

    for (const text of turns) {
      const done = event(frame => frame.params?.type === 'message.complete' && frame.params.session_id === runtime)

      await request('prompt.submit', { session_id: runtime, text })
      await done
    }

    await request('session.close', { session_id: runtime })

    return { runtime, stored: created.stored_session_id }
  } finally {
    child.stdin.end()
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
    child.kill('SIGTERM')
  }
}
