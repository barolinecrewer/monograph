// Life: what the plugin leaves behind across hot reloads and an unload, and
// what that costs. See rig/README.md ("Life").
//
// A probe is put into the page before any script runs (an init script, then
// a page reload). It wraps EventTarget add/removeEventListener, the three
// observer constructors and their observe/unobserve/disconnect,
// setTimeout/clearTimeout, setInterval/clearInterval,
// requestAnimationFrame/cancelAnimationFrame, the SDK's host.onEvent and the
// host atoms' listen(). A call counts as the plugin's when a frame of the
// stack runs from a blob: URL: Hermes loads each plugin build as its own blob
// module (src/contrib/runtime-loader.ts), so the URL also says WHICH load made
// the call. The SDK shims are blobs too, but they only re-export and never run
// at call time. Gateway subscriptions made through ctx.onEvent go into
// Hermes' own registry, which the probe cannot reach; Hermes disposes them on
// unload itself (contrib/plugin.ts tracks them). A stale one would show as an
// old load's activity, which the probe counts while a reply streams.
//
// The probe is only active while sessionStorage.mgLifeProbe is '1', so the
// cost measurement (l3) runs on a page without it.
import {
  ON_SCREEN_VIEWPORT,
  PLUGIN,
  WORK,
  check,
  hotReload,
  perf,
  results,
  shot,
  sleep,
  state,
  stubPlugin,
  turnDone,
  type,
  waitForAppReady
} from '../harness.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { startModel } from './stress.mjs'

export const limitS = 1700

export const checks = [
  ['l1', 'Leak table: load, 1, 3 and 6 hot reloads flat; nothing left after unload'],
  ['l2', 'Self-test: a planted listener, interval and node per load are caught'],
  ['l3', 'Cost: 2,000-line reply fresh, after six hot reloads, and on bare Hermes'],
  ['l4', 'Page growth after the 2,000-line reply: which elements, ours or Hermes\''],
  ['l5', 'Cost: the 2,000-line reply with motion off costs no more than with motion on'],
]

export const model = async () => startModel()

// ── The probe, page side ────────────────────────────────────────────────────
const PROBE = String.raw`(() => {
  if (window.__mgLife || sessionStorage.getItem('mgLifeProbe') !== '1') return
  const L = (window.__mgLife = { blobs: [], seen: [], listeners: [], observers: new Set(), intervals: new Map(), timeouts: new Map(), frames: new Map(), subs: new Map(), calls: {}, wrapped: [] })
  const stackOf = () => {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 60
    const stack = new Error().stack || ''
    Error.stackTraceLimit = limit
    return stack
  }
  // { load, site } for a call made by plugin code, else null.
  const ours = () => {
    const lines = stackOf().split('\n')
    for (const line of lines) {
      const url = line.match(/blob:[^\s)]+?(?=:\d+:\d+)/)
      if (url) {
        let load = L.blobs.indexOf(url[0])
        if (load < 0) {
          load = L.blobs.push(url[0]) - 1
          L.seen[load] = performance.now()
        }
        const at = line.match(/:(\d+):\d+\)?\s*$/)
        const site = ((line.trim().match(/^at (?:async )?([^\s(]+) \(/) || [])[1] || '(anonymous)') + (at ? ':' + at[1] : '')
        return { load, site }
      }
    }
    return null
  }
  const bump = (kind, who) => {
    const key = kind + ' @' + who.load + ' ' + who.site
    L.calls[key] = (L.calls[key] || 0) + 1
  }
  const label = target => {
    if (target === window) return 'window'
    if (target === document) return 'document'
    if (target === document.documentElement) return 'html'
    if (target === document.head) return 'head'
    if (target === document.body) return 'body'
    if (target && target.nodeType === 1) return target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + (target.dataset && target.dataset.slot ? '[' + target.dataset.slot + ']' : '')
    return (target && target.constructor && target.constructor.name) || typeof target
  }
  const capture = options => Boolean(typeof options === 'boolean' ? options : options && options.capture)

  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, fn, options) {
    const who = fn ? ours() : null
    if (who) {
      const c = capture(options)
      if (!L.listeners.some(item => item.target === this && item.type === type && item.fn === fn && item.capture === c)) {
        L.listeners.push({ capture: c, fn, load: who.load, site: who.site, target: this, type })
      }
    }
    return add.call(this, type, fn, options)
  }
  EventTarget.prototype.removeEventListener = function (type, fn, options) {
    const c = capture(options)
    const at = L.listeners.findIndex(item => item.target === this && item.type === type && item.fn === fn && item.capture === c)
    if (at >= 0) L.listeners.splice(at, 1)
    return remove.call(this, type, fn, options)
  }
  // { once: true } listeners and AbortSignal removal are not seen; noted in
  // the report when a listener with either is found.

  for (const kind of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const Original = window[kind]
    if (!Original) continue
    const records = new WeakMap()
    const Wrapped = function (callback, options) {
      const who = ours()
      const record = who ? { kind, load: who.load, site: who.site, targets: new Map() } : null
      const wrappedCallback = function (...args) {
        if (record) bump(kind + ' callback', record)
        return callback.apply(this, args)
      }
      const made = Reflect.construct(Original, options === undefined ? [wrappedCallback] : [wrappedCallback, options], new.target || Wrapped)
      if (record) {
        records.set(made, record)
        L.observers.add(record)
      }
      return made
    }
    Wrapped.prototype = Original.prototype
    Object.setPrototypeOf(Wrapped, Original)
    const proto = Original.prototype
    const observe = proto.observe
    const unobserve = proto.unobserve
    const disconnect = proto.disconnect
    proto.observe = function (target, options) {
      const record = records.get(this)
      if (record) record.targets.set(target, options && options.subtree ? label(target) + ' subtree' : label(target))
      return observe.call(this, target, options)
    }
    if (unobserve) {
      proto.unobserve = function (target) {
        records.get(this)?.targets.delete(target)
        return unobserve.call(this, target)
      }
    }
    proto.disconnect = function () {
      records.get(this)?.targets.clear()
      return disconnect.call(this)
    }
    window[kind] = Wrapped
  }

  const timer = (setName, clearName, map, kind, once) => {
    const set = window[setName]
    const clear = window[clearName]
    window[setName] = function (fn, ...rest) {
      const who = typeof fn === 'function' ? ours() : null
      if (!who) return set.call(this, fn, ...rest)
      let id = 0
      // Armed while its load was current, or by its teardown: a teardown
      // arms timers too (nanostores puts off a store's unmount by a timer
      // when its last listener leaves), and Hermes evaluates the new build
      // just before it disposes the old one. A timer an old load arms more
      // than 1.5 s after a newer load appeared is stale work.
      const now = performance.now()
      const armedCurrent = !L.seen.some((at, index) => index > who.load && now - at > 1500)
      const run = function (...args) {
        if (once) map.delete(id)
        bump(kind + (armedCurrent ? ' fired, armed while current' : ' fired'), who)
        return fn.apply(this, args)
      }
      id = set.call(this, run, ...rest)
      map.set(id, who)
      bump(kind + ' armed', who)
      return id
    }
    window[clearName] = function (id) {
      map.delete(id)
      return clear.call(this, id)
    }
  }
  timer('setTimeout', 'clearTimeout', L.timeouts, 'timeout', true)
  timer('setInterval', 'clearInterval', L.intervals, 'interval', false)
  timer('requestAnimationFrame', 'cancelAnimationFrame', L.frames, 'frame', true)

  // Host subscriptions, once the SDK is there (installed before plugins load).
  const wrapListen = (owner, name, label_) => {
    const original = owner && owner[name]
    if (typeof original !== 'function' || original.__mgLife) return
    const wrapped = function (...args) {
      const who = ours()
      const dispose = original.apply(this, args)
      if (who && typeof dispose === 'function') {
        const token = {}
        L.subs.set(token, { kind: label_ + (typeof args[0] === 'string' ? ' ' + args[0] : ''), load: who.load, site: who.site })
        return function (...more) {
          L.subs.delete(token)
          return dispose.apply(this, more)
        }
      }
      return dispose
    }
    wrapped.__mgLife = true
    try {
      owner[name] = wrapped
      if (owner[name] === wrapped) L.wrapped.push(label_)
    } catch {}
  }
  const hookSdk = () => {
    const sdk = window.__HERMES_PLUGIN_SDK__
    const host = sdk && sdk.host
    if (!host) return false
    wrapListen(host, 'onEvent', 'host.onEvent')
    for (const [key, atom] of Object.entries(host.state || {})) wrapListen(atom, 'listen', 'atom ' + key + '.listen')
    return true
  }
  if (!hookSdk()) {
    // Briefly at start-up only, from a non-blob stack, so it is never counted.
    let tries = 0
    const poll = window.setInterval(() => { if (hookSdk() || tries++ > 2000) clearInterval(poll) }, 5)
  }

  // ── Readings ──
  L.read = () => {
    const current = L.blobs.length - 1
    const group = (items, key) => {
      const out = {}
      for (const item of items) {
        const k = key(item)
        out[k] = (out[k] || 0) + 1
      }
      return out
    }
    const byLoad = items => group(items, item => (item.load === current ? 'current' : 'old'))
    const listeners = L.listeners
    const observing = [...L.observers].filter(record => record.targets.size)
    const subs = [...L.subs.values()]
    const timeouts = [...L.timeouts.values()]
    const intervals = [...L.intervals.values()]
    const frames = [...L.frames.values()]
    const isOurs = node => node.id && /^mg-/.test(node.id) || [...node.classList].some(name => /^mg-/.test(name))
    const all = [...document.getElementsByTagName('*')]
    const viewports = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')]
    const inThread = node => viewports.some(v => v.contains(node))
    const ourNodes = all.filter(isOurs)
    const marked = all.filter(node => node.getAttributeNames().some(name => name.startsWith('data-mg-')))
    const root = document.documentElement
    const registry = Object.keys(window).filter(key => /^_*mg/i.test(key) && !/^__mg(Life|RigHooks|Rec|TraceOn)/.test(key))
    return {
      blobs: L.blobs.length,
      listeners: { total: listeners.length, byLoad: byLoad(listeners), connected: listeners.filter(item => !item.target.nodeType || item.target.isConnected).length, list: group(listeners.filter(item => !item.target.nodeType || item.target.isConnected), item => item.type + ' on ' + label(item.target) + (item.capture ? ' (capture)' : '') + ' @' + (item.load === current ? 'cur' : item.load) + ' ' + item.site) },
      observers: { observing: observing.length, byLoad: byLoad(observing), list: group(observing, record => record.kind + ' on ' + [...record.targets.values()].join(', ') + ' @' + (record.load === current ? 'cur' : record.load) + ' ' + record.site), detachedTargets: observing.filter(record => [...record.targets.keys()].every(t => t.nodeType && !t.isConnected)).length },
      intervals: { total: intervals.length, byLoad: byLoad(intervals), list: group(intervals, who => '@' + (who.load === current ? 'cur' : who.load) + ' ' + who.site) },
      timeoutsPending: { total: timeouts.length, byLoad: byLoad(timeouts), list: group(timeouts, who => '@' + (who.load === current ? 'cur' : who.load) + ' ' + who.site) },
      framesPending: { total: frames.length, byLoad: byLoad(frames) },
      subscriptions: { total: subs.length, byLoad: byLoad(subs), wrapped: L.wrapped, list: group(subs, sub => sub.kind + ' @' + (sub.load === current ? 'cur' : sub.load) + ' ' + sub.site) },
      nodes: { ours: ourNodes.length, oursOutsideThreads: ourNodes.filter(node => !inThread(node)).length, byClass: group(ourNodes.filter(node => !inThread(node)), node => node.id && /^mg-/.test(node.id) ? '#' + node.id : '.' + [...node.classList].find(name => /^mg-/.test(name))) },
      marked: { total: marked.length, outsideThreads: marked.filter(node => !inThread(node)).length, attrsOutsideThreads: group(marked.filter(node => !inThread(node)).flatMap(node => node.getAttributeNames().filter(name => name.startsWith('data-mg-'))), name => name) },
      styles: { all: document.querySelectorAll('style').length, ours: document.querySelectorAll('style#mg-css, style[id^="mg-"], style[data-owner]').length },
      rootAttrs: root.getAttributeNames().filter(name => name.startsWith('data-mg')).sort(),
      rootProps: [...root.style].filter(name => name.startsWith('--mg')).sort(),
      registry,
      elements: all.length
    }
  }
  L.resetCalls = () => { L.calls = {} }
  L.activity = () => {
    const current = L.blobs.length - 1
    const out = { current: 0, old: 0, oldList: {} }
    for (const [key, n] of Object.entries(L.calls)) {
      const load = Number(key.match(/ @(\d+) /)[1])
      if (load === current) out.current += n
      else if (key.includes('armed while current')) out.tail = (out.tail || 0) + n
      else {
        out.old += n
        out.oldList[key] = n
      }
    }
    return out
  }
})()`

// ── Helpers ─────────────────────────────────────────────────────────────────
const waitIdle = (needle, timeout = 90_000) => turnDone(needle, timeout)

async function newSession() {
  const button = state.page.locator('button[aria-label="New session"]').first()

  if (await button.isVisible().catch(() => false)) {
    await button.click()
  } else {
    await state.page.keyboard.press('Meta+n')
  }

  await sleep(800)
}

async function reloadPage(probe) {
  const { app, page } = state

  await page.evaluate(on => sessionStorage.setItem('mgLifeProbe', on ? '1' : '0'), probe)
  await page.reload()
  await waitForAppReady({ app, page }, 90_000)
  await page.waitForFunction(() => Boolean(document.getElementById('mg-css') && document.documentElement.dataset.mgReady), undefined, { timeout: 30_000 })
  await sleep(1500)
}

// The numbers a reading is judged on: what must equal the first load's.
// Listeners and observers count only on targets still in the page: one on a
// node React has since dropped goes with that node.
const flat = reading => ({
  listeners: reading.listeners.connected,
  observing: reading.observers.observing - reading.observers.detachedTargets,
  intervals: reading.intervals.total,
  timeoutsPending: reading.timeoutsPending.total,
  framesPending: reading.framesPending.total,
  subscriptions: reading.subscriptions.total,
  nodesOutsideThreads: reading.nodes.oursOutsideThreads,
  markedOutsideThreads: reading.marked.outsideThreads,
  styles: reading.styles.all,
  ourStyles: reading.styles.ours,
  rootAttrs: reading.rootAttrs.length,
  rootProps: reading.rootProps.length,
  registry: reading.registry.length
})

// One reading: a short reply first (gateway events, a turn drawn), the probe's
// call counts during it (which load did the work), then the structure once the
// page has been still for a moment.
// The approval chip in the message box mounts when Hermes' composer controls
// render, which can come a moment after a (re)load; a reading taken before it
// counts one node and one listener fewer than every later one (l1 once failed
// on that alone). Each sample waits for it first.
const CHIP = '[data-slot="composer-fade"] button.mg-chip'

async function sample(tag) {
  const { page } = state

  await page.waitForSelector(CHIP, { state: 'attached', timeout: 15_000 }).catch(() => results.observations.push(`life ${tag}: no approval chip after 15 s`))
  await page.evaluate(() => window.__mgLife.resetCalls())
  await type(`Life probe ${tag}, MGL_${tag}.`, 'Enter')
  await waitIdle(`MGL_${tag}`, 60_000).catch(() => undefined)
  await sleep(1500)

  const activity = await page.evaluate(() => window.__mgLife.activity())

  await page.evaluate(() => window.__mgLife.resetCalls())
  await sleep(2000)

  const idle = await page.evaluate(() => window.__mgLife.activity())
  const reading = await page.evaluate(() => window.__mgLife.read())

  return { activity, idle, reading }
}

const diff = (a, b) => Object.fromEntries(Object.keys(b).filter(key => JSON.stringify(a?.[key]) !== JSON.stringify(b[key])).map(key => [key, [a?.[key], b[key]]]))

// What grew between two lists of { name: count }.
const grew = (before, after) =>
  Object.fromEntries(
    Object.entries(after)
      .map(([key, n]) => [key.replace(/ @\d+ /, ' @old '), n - (before[key] ?? 0)])
      .filter(([, n]) => n > 0)
  )

// ── Page census, for l4 ─────────────────────────────────────────────────────
const census = () =>
  state.page.evaluate(`(() => {
    const all = [...document.getElementsByTagName('*')]
    const v = ${ON_SCREEN_VIEWPORT}
    const group = (items, key, top = 20) => Object.entries(items.reduce((out, item) => { const k = key(item); if (k) out[k] = (out[k] || 0) + 1; return out }, {})).sort((a, b) => b[1] - a[1]).slice(0, top)
    const ours = node => (node.id && /^mg-/.test(node.id)) || [...node.classList].some(name => /^mg-/.test(name))
    const inV = v ? [...v.getElementsByTagName('*')] : []
    return {
      elements: all.length,
      inThreadOnScreen: inV.length,
      viewports: document.querySelectorAll('[data-slot="aui_thread-viewport"]').length,
      ours: all.filter(ours).length,
      oursInThread: inV.filter(ours).length,
      byOurClass: group(all.filter(ours), node => [...node.classList].find(name => /^mg-/.test(name)) || '#' + node.id),
      byTagInThread: group(inV, node => node.tagName.toLowerCase(), 14),
      bySlot: group(all, node => node.dataset && node.dataset.slot, 16),
      perViewport: [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].map(node => node.getElementsByTagName('*').length),
      outsideViewports: all.length - [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].reduce((sum, node) => sum + node.getElementsByTagName('*').length, 0)
    }
  })()`)

const brief = stats => ({
  secs: stats.secs,
  fps: stats.fps,
  maxFrame: stats.maxFrame,
  longTasksMs: stats.longtasks.total,
  per10s: stats.secs ? Math.round((stats.longtasks.total / stats.secs) * 10) : 0
})

// Where the CPU went during a recording: self time by kind of source (our
// blob, Hermes' bundle, the engine), the time spent with a frame of ours
// anywhere on the stack, and the heaviest functions.
function cpuSummary(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()

  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parent.set(child, node.id)
    }
  }

  const self = new Map()

  profile.samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000))

  const kind = node => {
    const url = node.callFrame.url

    return url.startsWith('blob:') ? 'monograph' : url ? 'hermes' : node.callFrame.functionName || '(engine)'
  }
  const oursAbove = new Map()
  const underOurs = id => {
    if (oursAbove.has(id)) {
      return oursAbove.get(id)
    }

    const node = byId.get(id)
    const value = node.callFrame.url.startsWith('blob:') || (parent.has(id) && underOurs(parent.get(id)))

    oursAbove.set(id, value)

    return value
  }
  const kinds = {}
  const functions = {}
  let withOurs = 0

  for (const [id, ms] of self) {
    const node = byId.get(id)
    const name = `${kind(node)} ${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber + 1}`

    kinds[kind(node)] = (kinds[kind(node)] ?? 0) + ms
    functions[name] = (functions[name] ?? 0) + ms

    if (underOurs(id)) {
      withOurs += ms
    }
  }

  const round = list => Object.fromEntries(Object.entries(list).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, ms]) => [key, Math.round(ms)]))

  return { selfMsByKind: round(kinds), msWithOurFrameOnStack: Math.round(withOurs), topSelf: round(functions) }
}

// A Chrome trace of fn: the main thread's long events (over 50 ms) by name,
// with what they say about themselves, and, where Chrome writes selector
// statistics, the selectors that took the most time.
async function traceDuring(fn) {
  const { cdp } = state
  const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))

  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-blink.debug', 'blink'],
      recordMode: 'recordAsMuchAsPossible'
    },
    transferMode: 'ReturnAsStream'
  })

  let value

  try {
    value = await fn()
  } finally {
    await cdp.send('Tracing.end')
  }

  const { stream } = await done
  let text = ''

  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 20 })

    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data

    if (chunk.eof) {
      break
    }
  }

  await cdp.send('IO.close', { handle: stream }).catch(() => undefined)

  const parsed = JSON.parse(text)
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])
  const long = events.filter(event => event.ph === 'X' && event.dur > 50_000 && !/^(ThreadControllerImpl::RunTask|RunTask|RunMicrotasks)$/.test(event.name))
  const byName = {}

  for (const event of long) {
    const slot = (byName[event.name] ??= { n: 0, ms: 0, examples: [] })

    slot.n += 1
    slot.ms += event.dur / 1000

    // The three longest, with what they say about themselves.
    slot.examples.push({ args: JSON.stringify(event.args ?? {}).slice(0, 400), ms: Math.round(event.dur / 1000) })
    slot.examples.sort((a, b) => b.ms - a.ms).splice(3)
  }

  const selectors = {}

  for (const event of events) {
    const stats = event.args?.selector_stats?.selector_timings

    for (const item of stats ?? []) {
      const slot = (selectors[item.selector] ??= { ms: 0, matches: 0, attempts: 0 })

      slot.ms += (item['elapsed (us)'] ?? 0) / 1000
      slot.matches += item.match_count ?? 0
      slot.attempts += item.match_attempts ?? 0
    }
  }

  return {
    value,
    longEvents: Object.fromEntries(Object.entries(byName).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10).map(([name, slot]) => [name, { ...slot, ms: Math.round(slot.ms) }])),
    topSelectors: Object.entries(selectors).sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([selector, slot]) => ({ selector: selector.slice(0, 220), ms: Math.round(slot.ms), matches: slot.matches, attempts: slot.attempts }))
  }
}

async function longReply(tag) {
  await newSession()
  await type(`A very long reply, ${tag}. MGS_LONG(2000)`, 'Enter')
  await state.page
    .waitForFunction(`((${ON_SCREEN_VIEWPORT})?.textContent ?? '').includes('MGS_LONG_BEGIN')`, undefined, { polling: 100, timeout: 30_000 })
    .catch(() => undefined)

  await state.page.evaluate(() => window.__mgPerfReset?.())

  const began = Date.now()
  const m0 = await threadMetrics()

  await state.cdp.send('Profiler.enable')
  await state.cdp.send('Profiler.start')

  const streaming = await perf(async () => {
    await waitIdle(`${tag} MGS_LONG_DONE`, 180_000)
    await sleep(1500)
  })
  const m1 = await threadMetrics()
  const { profile } = await state.cdp.send('Profiler.stop')
  // The plugin's own timed jobs (window.__mgPerf): how much of the long-task
  // time is our script at all.
  const jobs = await state.page.evaluate(() =>
    Object.entries(window.__mgPerf ?? {})
      .map(([name, entry]) => [name, Math.round(entry.ms), entry.runs, Math.round(entry.max)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
  )

  return {
    census: await census(),
    cpu: cpuSummary(profile),
    jobs,
    streamedMs: Date.now() - began,
    streaming: { ...brief(streaming), topTasks: streaming.longtasks.top.slice(0, 5).map(task => task.d), ...threadCost(m0, m1, streaming) }
  }
}

// Main-thread time (CPU time of the renderer's main thread, from the
// debugging protocol's Performance domain in thread ticks) while a reply
// streams. A machine running six rig windows deschedules the renderer now
// and then: a long task of several seconds with almost no thread time in
// it. Wall-clock long tasks swing with that; thread time does not, so the
// verdicts of l3 and l5 are on thread time, and the stall (long-task time
// that was certainly not spent running: wall long tasks minus all thread
// time) is reported beside it.
async function threadMetrics() {
  const { metrics } = await state.cdp.send('Performance.getMetrics')

  return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
}

const threadCost = (m0, m1, stats) => {
  const task = Math.round((m1.TaskDuration - m0.TaskDuration) * 1000)
  const style = Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000)

  return {
    threadMs: task,
    threadPer10s: stats.secs ? Math.round((task / stats.secs) * 10) : 0,
    styleThreadMs: style,
    stallMs: Math.max(0, Math.round(stats.longtasks.total - task))
  }
}

const median = list => {
  const sorted = [...list].sort((a, b) => a - b)

  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0
}

// Each condition is measured this many times; verdicts use the median.
const MEASURES = 3

// MG_LIFE_PLANT=1 (self-test of l3, never for a verdict): every hot-reloaded
// build carries a leak that is never undone, a timer that does a fixed piece
// of arithmetic once a second (2e8 square roots; in the rig 7e7 of them
// added 950 ms of main-thread time over six reloads and one reply): about
// 300 ms per
// 10 s for each reload. Fixed work, not a wall-clock wait: the rig window is
// behind others and its renderer is descheduled now and then, so a wait of
// 30 ms by the clock is less than that in thread time.
// window.__mgLifePlanted counts its runs, so the evidence shows it ran.
const PLANT = process.env.MG_LIFE_PLANT === '1'

function plantedBuild() {
  const file = path.join(WORK, 'life-planted-cost.js')

  fs.writeFileSync(
    file,
    `${fs.readFileSync(PLUGIN, 'utf8')}\n;setInterval(() => { let x = 0; for (let i = 0; i < 2e8; i++) x += Math.sqrt(i); window.__mgLifePlanted = (window.__mgLifePlanted ?? 0) + (x > 0 ? 1 : 0) }, 1000)\n`
  )

  return file
}

// ── Checks ──────────────────────────────────────────────────────────────────
export async function run() {
  const { page } = state

  await page.context().addInitScript(PROBE)
  await reloadPage(true)

  const installed = await page.evaluate(() => Boolean(window.__mgLife) && window.__mgLife.blobs.length)

  results.notes.push(`life: probe installed before the plugin loaded: ${Boolean(installed)}; host hooks wrapped: ${JSON.stringify(await page.evaluate(() => window.__mgLife?.wrapped ?? []))}`)

  const table = {}
  let firstLoad = null

  await check('l1', async (entry, must) => {
    must(installed, 'the probe did not see the plugin load (no blob frames)')
    await newSession()

    table.load = await sample('LOAD')
    firstLoad = table.load

    let done = 0

    for (const target of [1, 3, 6]) {
      for (; done < target; done++) {
        await hotReload()
      }

      table[`reload${target}`] = await sample(`R${target}`)
    }

    await hotReload({ gone: true, source: stubPlugin() })
    await sleep(1000)
    table.unload = { reading: await page.evaluate(() => window.__mgLife.read()) }

    const rows = Object.fromEntries(Object.entries(table).map(([key, value]) => [key, flat(value.reading)]))

    entry.evidence.table = rows
    entry.evidence.activityDuringReply = Object.fromEntries(Object.entries(table).filter(([, v]) => v.activity).map(([key, v]) => [key, { current: v.activity.current, old: v.activity.old, oldTeardownTimers: v.activity.tail ?? 0 }]))
    entry.evidence.activityIdle2s = Object.fromEntries(Object.entries(table).filter(([, v]) => v.idle).map(([key, v]) => [key, { current: v.idle.current, old: v.idle.old }]))
    entry.evidence.atLoad = {
      listeners: table.load.reading.listeners.list,
      observers: table.load.reading.observers.list,
      intervals: table.load.reading.intervals.list,
      subscriptions: table.load.reading.subscriptions.list,
      timeoutsPending: table.load.reading.timeoutsPending.list,
      nodes: table.load.reading.nodes.byClass,
      rootAttrs: table.load.reading.rootAttrs,
      rootProps: table.load.reading.rootProps,
      registry: table.load.reading.registry
    }

    const last = table.reload6.reading

    entry.evidence.grewBySix = {
      listeners: grew(table.load.reading.listeners.list, last.listeners.list),
      observers: grew(table.load.reading.observers.list, last.observers.list),
      intervals: grew(table.load.reading.intervals.list, last.intervals.list),
      subscriptions: grew(table.load.reading.subscriptions.list, last.subscriptions.list),
      timeoutsPending: grew(table.load.reading.timeoutsPending.list, last.timeoutsPending.list),
      nodes: grew(table.load.reading.nodes.byClass, last.nodes.byClass),
      markedAttrs: grew(table.load.reading.marked.attrsOutsideThreads, last.marked.attrsOutsideThreads),
      oldLoadActivity: table.reload6.activity.oldList,
      oldLoadIdle: table.reload6.idle.oldList
    }

    const u = table.unload.reading

    entry.evidence.leftAfterUnload = {
      listeners: u.listeners.list,
      observers: u.observers.list,
      intervals: u.intervals.list,
      subscriptions: u.subscriptions.list,
      timeoutsPending: u.timeoutsPending.list,
      nodes: u.nodes.byClass,
      marked: u.marked.total,
      rootAttrs: u.rootAttrs,
      rootProps: u.rootProps,
      registry: u.registry,
      styles: u.styles
    }

    for (const key of ['reload1', 'reload3', 'reload6']) {
      const changed = diff(rows.load, rows[key])

      must(!Object.keys(changed).length, `${key} differs from the first load: ${JSON.stringify(changed)}`)
      must(!table[key].activity.old, `${key}: ${table[key].activity.old} call(s) during a reply came from an earlier load: ${JSON.stringify(table[key].activity.oldList).slice(0, 400)}`)

      // Subscriptions made by an earlier load's components that are still
      // mounted: Hermes renders the composers of hidden session tabs late, so
      // their slot components are swapped for the new load's when React gets
      // to them. The total must stay flat (above); this says how many.
      const older = Object.entries(table[key].reading.subscriptions.list).filter(([name]) => !/ @cur /.test(name))

      if (older.length) {
        results.observations.push(`life: ${key}: subscriptions still held by an earlier load's mounted components: ${JSON.stringify(Object.fromEntries(older))}`)
      }
      must(!table[key].idle.old, `${key}: ${table[key].idle.old} call(s) at rest came from an earlier load`)
    }

    const zero = {
      listeners: u.listeners.total,
      observing: u.observers.observing,
      intervals: u.intervals.total,
      timeoutsPending: u.timeoutsPending.total,
      framesPending: u.framesPending.total,
      subscriptions: u.subscriptions.total,
      ourNodes: u.nodes.ours,
      marked: u.marked.total,
      ourStyles: u.styles.ours,
      rootAttrs: u.rootAttrs.length,
      rootProps: u.rootProps.length,
      registry: u.registry.length
    }

    entry.evidence.unloadCounts = zero

    for (const [key, n] of Object.entries(zero)) {
      must(n === 0, `after unload ${key} is ${n}, not 0`)
    }

    must(rows.load.listeners > 0, 'the probe saw no listener of ours at load: it is blind')
    await shot(entry, 'l1-after-unload')
  })

  // ── l2. The probe can fail ───────────────────────────────────────────────
  await check('l2', async (entry, must) => {
    // The real build plus three leaks at module top level: a listener, an
    // interval and a node per load, none ever undone.
    const planted = path.join(WORK, 'life-planted.js')

    fs.writeFileSync(
      planted,
      `${fs.readFileSync(PLUGIN, 'utf8')}\nwindow.addEventListener('mg-life-planted', () => {})\nsetInterval(() => {}, 60000)\ndocument.body.appendChild(Object.assign(document.createElement('i'), { className: 'mg-life-planted' }))\n`
    )
    await hotReload({ source: planted })
    await sleep(500)

    const one = flat(await page.evaluate(() => window.__mgLife.read()))

    await hotReload({ source: planted })
    await sleep(500)

    const two = flat(await page.evaluate(() => window.__mgLife.read()))

    entry.evidence.oneLoad = one
    entry.evidence.twoLoads = two
    must(two.listeners - one.listeners === 1, `the planted listener: ${one.listeners} then ${two.listeners}, expected one more`)
    must(two.intervals - one.intervals === 1, `the planted interval: ${one.intervals} then ${two.intervals}, expected one more`)
    must(two.nodesOutsideThreads - one.nodesOutsideThreads === 1, `the planted node: ${one.nodesOutsideThreads} then ${two.nodesOutsideThreads}, expected one more`)
    await page.evaluate(() => document.querySelectorAll('.mg-life-planted').forEach(node => node.remove()))
  })

  // ── l3, l4. Cost and page growth, on a page without the probe ────────────
  const cost = {}

  await check('l3', async (entry, must) => {
    await reloadPage(false)
    must(!(await page.evaluate(() => Boolean(window.__mgLife))), 'the probe is still in the page')
    await state.cdp.send('Performance.enable', { timeDomain: 'threadTicks' })

    const source = PLANT ? plantedBuild() : PLUGIN

    if (PLANT) {
      results.notes.push('life: MG_LIFE_PLANT=1: every hot-reloaded build carries a planted leak (self-test of l3)')
    }

    // Fresh, after six hot reloads and with motion off, each on a page just
    // reloaded, taken in turn so the machine's load falls on all alike.
    cost.runs = { fresh: [], afterSix: [], motionOff: [], bare: [] }

    for (let round = 0; round < MEASURES; round++) {
      await reloadPage(false)
      cost.runs.fresh.push(await longReply(`MGL_FRESH${round}`))

      await reloadPage(false)
      for (let reload = 0; reload < 6; reload++) {
        await hotReload({ source })
      }
      cost.runs.afterSix.push(await longReply(`MGL_SIX${round}`))
      if (PLANT) entry.evidence[`plantedRuns${round}`] = await page.evaluate(() => window.__mgLifePlanted ?? 0)
      // The sandbox's plugin file is what the next page reload loads.
      if (PLANT) await hotReload()

      // Attribution and l5: the same on a fresh page with Monograph's motion
      // off.
      await reloadPage(false)
      await page.evaluate(() => {
        document.documentElement.dataset.mgMotion = 'off'
      })
      cost.runs.motionOff.push(await longReply(`MGL_STILL${round}`))
      await page.evaluate(() => {
        document.documentElement.dataset.mgMotion = 'on'
      })
    }

    cost.fresh = cost.runs.fresh[0]
    cost.afterSix = cost.runs.afterSix[0]
    cost.motionOff = cost.runs.motionOff[0]

    await reloadPage(false)
    await hotReload({ gone: true, source: stubPlugin() })
    for (let round = 0; round < MEASURES; round++) {
      cost.runs.bare.push(await longReply(`MGL_BARE${round}`))
    }
    cost.bare = cost.runs.bare[0]
    await shot(entry, 'l3-bare-long-reply')

    // Attribution: bare Hermes with only Monograph's stylesheet put in.
    const built = fs.readFileSync(PLUGIN, 'utf8')
    const css = JSON.parse(built.match(/^const CSS = (".*")$/m)[1])

    await page.evaluate(text => {
      const style = document.createElement('style')

      style.id = 'mg-life-css-only'
      style.textContent = text
      document.head.appendChild(style)
    }, css)
    cost.cssOnly = await longReply('MGL_CSSONLY')
    await page.evaluate(() => document.getElementById('mg-life-css-only')?.remove())
    await hotReload()

    // Last, because a trace with selector statistics slows the page a lot:
    // where the time of one more long reply goes, with Monograph loaded.
    const traced = await traceDuring(() => longReply('MGL_TRACE'))

    entry.evidence.traced = { streaming: traced.value.streaming, longEvents: traced.longEvents, topSelectors: traced.topSelectors }

    const table = Object.fromEntries(Object.entries(cost.runs).map(([key, runs]) => [key, {
      threadMs: runs.map(run => run.streaming.threadMs),
      threadPer10s: runs.map(run => run.streaming.threadPer10s),
      styleThreadMs: runs.map(run => run.streaming.styleThreadMs),
      longTasksPer10s: runs.map(run => run.streaming.per10s),
      stallMs: runs.map(run => run.streaming.stallMs),
      medianThreadMs: median(runs.map(run => run.streaming.threadMs)),
      medianThreadPer10s: median(runs.map(run => run.streaming.threadPer10s)),
      medianLongTasksPer10s: median(runs.map(run => run.streaming.per10s))
    }]))

    cost.table = table
    entry.evidence.table = table
    entry.evidence.bareWithOnlyOurCss = cost.cssOnly.streaming
    entry.evidence.stalls = Object.fromEntries(Object.entries(cost.runs).map(([key, runs]) => [key, runs.filter(run => run.streaming.stallMs > 500).map(run => `${run.streaming.stallMs} ms of long tasks not running (top task ${run.streaming.topTasks[0]} ms)`)]))
    entry.evidence.ourJobs = { fresh: cost.fresh.jobs, afterSixReloads: cost.afterSix.jobs, motionOff: cost.motionOff.jobs }
    entry.evidence.cpu = { fresh: cost.fresh.cpu, afterSixReloads: cost.afterSix.cpu, bare: cost.bare.cpu }

    // "Equal within noise", on main-thread time for the whole reply (the
    // same 2,000 lines each time; per 10 s would shrink when a stall
    // stretches the reply): the median after six hot reloads at most 15 %
    // over the fresh page's median, plus 300 ms. A leak of 300 ms per 10 s
    // per reload (MG_LIFE_PLANT=1) is over 2,000 ms on a 12 s reply.
    const limit = Math.round(table.fresh.medianThreadMs * 1.15 + 300)

    entry.evidence.limitThreadMs = limit
    must(table.afterSix.medianThreadMs <= limit, `after six hot reloads the long reply keeps the main thread busy ${table.afterSix.medianThreadMs} ms (median of ${MEASURES}); fresh ${table.fresh.medianThreadMs}, limit ${limit}; bare ${table.bare.medianThreadMs}`)
  })

  await check('l5', async (entry, must) => {
    const table = cost.table

    must(table, 'no measures (l3 did not finish)')

    if (!table) {
      return
    }

    entry.evidence = { ...entry.evidence, motionOn: table.fresh, motionOff: table.motionOff, bare: table.bare }

    // Motion off may cost no more than motion on: medians of main-thread
    // time per reply, 10 % plus 150 ms for noise.
    const limit = Math.round(table.fresh.medianThreadMs * 1.1 + 150)

    entry.evidence.limitThreadMs = limit
    must(table.motionOff.medianThreadMs <= limit, `with motion off the long reply keeps the main thread busy ${table.motionOff.medianThreadMs} ms (median of ${MEASURES}); motion on ${table.fresh.medianThreadMs}, limit ${limit}; bare ${table.bare.medianThreadMs}`)
  })

  await check('l4', async (entry, must) => {
    must(cost.fresh && cost.bare, 'no long-reply census (l3 did not finish)')

    if (!cost.fresh || !cost.bare) {
      return
    }

    entry.evidence.monographFresh = cost.fresh.census
    entry.evidence.monographAfterSix = cost.afterSix?.census ?? null
    entry.evidence.bare = cost.bare.census
    entry.evidence.extra = {
      elements: cost.fresh.census.elements - cost.bare.census.elements,
      inThreadOnScreen: cost.fresh.census.inThreadOnScreen - cost.bare.census.inThreadOnScreen,
      outsideViewports: cost.fresh.census.outsideViewports - cost.bare.census.outsideViewports,
      viewports: cost.fresh.census.viewports - cost.bare.census.viewports
    }
  })
}
