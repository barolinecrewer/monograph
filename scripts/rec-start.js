// Read-only recorder. State on window.__mgRec; rec-stop.js reads it and removes everything.
// Two callers: scripts/probe.mjs (passes `sdk`, wants the static snapshot at
// the end) and the rig's perf() in rig/harness.mjs (sets window.__mgRecOpts =
// { snapshot: false } first, and reads the per-frame numbers).
//
// Per animation frame, until rec-stop.js:
//   frame gaps (all kept, for max / p95 / counts over 32, 50, 100 ms);
//   long tasks and layout shifts (PerformanceObserver);
//   the thread viewport: scrollTop, scrollHeight, the gap to the bottom, and
//   the screen position of one "anchor" element (what the reader looks at).
//   A move of either with no wheel, key or pointer input in the last
//   inputMs (500) is "unexplained": the page moved by itself;
//   animation and transition starts, by name and owner;
//   gateway events by type (when an sdk is around).
if (window.__mgRec) { try { window.__mgRec.stop() } catch {} }
const OPTS = window.__mgRecOpts || {}
const INPUT_MS = OPTS.inputMs ?? 500
const sdkRef = typeof sdk !== 'undefined' ? sdk : globalThis.__HERMES_PLUGIN_SDK__
const R = { t0: performance.now(), wall: Date.now(), frames: 0, slow32: 0, slow50: 0, slow100: 0, slow250: 0, maxFrame: 0, dts: [],
  longtasks: [], shifts: [], animStarts: {}, transStarts: {}, animBursts: [], events: {}, toolNames: {}, muts: 0, added: 0, mutBySlot: {},
  scroll: [], jumps: [], wheel: 0, keys: 0, pointers: 0, stops: [],
  vpSeen: 0, vpSwaps: 0, scrollNoInput: 0, scrollWithInput: 0, scrollNoInputMax: 0, scrollNoInputEvents: [],
  anchorNoInput: 0, anchorNoInputMax: 0, anchorEvents: [], anchorLost: 0, anchorSet: 0,
  gapMax: 0, gapFramesOver2: 0, gapRunMax: 0, gapFinal: null, topFinal: null, heightStart: null, heightFinal: null }
const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[inert], [aria-hidden="true"]') }
// The thread on screen: hidden threads of other session tabs stay in the page.
const vp = () => { const list = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].filter(v => vis(v) && v.checkVisibility({ opacityProperty: true, visibilityProperty: true })); for (const v of list) { const r = v.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 160)); if (hit && v.contains(hit)) return v } return list[0] }
const slotOf = n => { let e = n && n.nodeType === 1 ? n : n && n.parentElement; let hops = 0; while (e && hops < 8) { const s = e.getAttribute && (e.getAttribute('data-slot') || e.id || [...e.classList].find(c => c.startsWith('mg-'))); if (s) return s; e = e.parentElement; hops++ } return (n && n.nodeName) || '?' }
const trunc = (v, d = 0) => { if (v == null) return v; if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + `…(${v.length})` : v; if (typeof v !== 'object') return v; if (d > 3) return '{…}'; if (Array.isArray(v)) return v.slice(0, 4).map(x => trunc(x, d + 1)).concat(v.length > 4 ? [`…+${v.length - 4}`] : []); const o = {}; for (const k of Object.keys(v).slice(0, 30)) o[k] = trunc(v[k], d + 1); return o }
const inputAt = () => Math.max(R._wheelAt, R._keyAt, R._pointerAt)
// The anchor: the deepest element under a point 40% down the viewport, so a
// change above it inside the same reply still shows as movement.
let anchor = null, anchorY = null, anchorVp = null
const pickAnchor = v => {
  const box = v.getBoundingClientRect()
  for (const f of [0.4, 0.3, 0.5, 0.2, 0.6, 0.7]) {
    for (const fx of [0.35, 0.5, 0.2]) {
      const hit = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * f)
      if (hit && hit !== v && v.contains(hit) && !hit.matches('[data-slot="aui_thread-content"]')) {
        anchor = hit; anchorY = hit.getBoundingClientRect().top; anchorVp = v; R.anchorSet++
        return
      }
    }
  }
  anchor = null; anchorY = null
}
let last = performance.now(), lastGap = null, lastH = null, lastTop = null, lastAnchorY = null, lastVp = null, raf = 0, animWindow = { t: 0, n: 0, names: {} }, gapRun = 0
const tick = now => {
  const dt = now - last; last = now; R.frames++
  if (R.dts.length < 40000) R.dts.push(Math.round(dt * 10) / 10)
  if (dt > 32) R.slow32++; if (dt > 50) R.slow50++; if (dt > 100) R.slow100++; if (dt > 250) R.slow250++; if (dt > R.maxFrame) R.maxFrame = Math.round(dt)
  const v = vp()
  const quiet = now - inputAt() > INPUT_MS
  if (v) {
    R.vpSeen++
    if (lastVp && v !== lastVp) { R.vpSwaps++; lastH = null; anchor = null }
    lastVp = v
    const gap = Math.round(v.scrollHeight - v.scrollTop - v.clientHeight), h = v.scrollHeight, top = v.scrollTop
    if (R.heightStart === null) R.heightStart = h
    R.heightFinal = h; R.gapFinal = gap; R.topFinal = Math.round(top)
    if (gap > R.gapMax) R.gapMax = gap
    if (gap > 2) { R.gapFramesOver2++; gapRun++; if (gapRun > R.gapRunMax) R.gapRunMax = gapRun } else gapRun = 0
    const rows = v.querySelectorAll('[data-slot="aui_assistant-message-root"]'); const lastRow = rows[rows.length - 1]
    const ay = lastRow ? Math.round(lastRow.getBoundingClientRect().top) : null
    if (lastH !== null) {
      const dH = h - lastH, dTop = top - lastTop, dA = ay !== null && lastAnchorY !== null ? ay - lastAnchorY : 0
      if (Math.abs(dTop) > 0.5) {
        if (quiet) {
          R.scrollNoInput += Math.abs(dTop); if (Math.abs(dTop) > R.scrollNoInputMax) R.scrollNoInputMax = Math.round(Math.abs(dTop))
          if (R.scrollNoInputEvents.length < 80) R.scrollNoInputEvents.push({ t: Math.round(now - R.t0), dTop: Math.round(dTop), dH, gap })
        } else R.scrollWithInput += Math.abs(dTop)
      }
      if (Math.abs(dH) > 24 || Math.abs(dA) > 24 || Math.abs(gap - lastGap) > 24) {
        if (R.jumps.length < 150) R.jumps.push({ t: Math.round(now - R.t0), dH, dTop: Math.round(dTop), dAnchorY: dA, gap, wheelRecent: performance.now() - R._wheelAt < 300 })
      }
    }
    lastGap = gap; lastH = h; lastTop = top; lastAnchorY = ay
    // The reader's anchor: dropped while input is going on, picked again once it settles.
    if (anchor && (!anchor.isConnected || anchorVp !== v || !vis(anchor))) { R.anchorLost++; anchor = null }
    if (!quiet) anchor = null
    if (anchor) {
      const y = anchor.getBoundingClientRect().top
      const d = y - anchorY
      if (Math.abs(d) > 0.5) {
        R.anchorNoInput += Math.abs(d); if (Math.abs(d) > R.anchorNoInputMax) R.anchorNoInputMax = Math.round(Math.abs(d) * 10) / 10
        if (R.anchorEvents.length < 80) R.anchorEvents.push({ t: Math.round(now - R.t0), d: Math.round(d * 10) / 10, gap, on: slotOf(anchor) })
      }
      anchorY = y
      const box = v.getBoundingClientRect()
      if (y < box.top || y > box.bottom) anchor = null
    } else if (quiet) pickAnchor(v)
  }
  raf = requestAnimationFrame(tick)
}
raf = requestAnimationFrame(tick)
R._wheelAt = -1e9; R._keyAt = -1e9; R._pointerAt = -1e9
const onWheel = () => { R.wheel++; R._wheelAt = performance.now() }
const onKey = () => { R.keys++; R._keyAt = performance.now() }
const onPointer = () => { R.pointers++; R._pointerAt = performance.now() }
window.addEventListener('wheel', onWheel, { passive: true, capture: true })
window.addEventListener('keydown', onKey, { passive: true, capture: true })
window.addEventListener('pointerdown', onPointer, { passive: true, capture: true })
const onAnim = e => {
  const key = e.animationName + ' @ ' + slotOf(e.target); R.animStarts[key] = (R.animStarts[key] || 0) + 1
  const now = performance.now()
  if (now - animWindow.t > 120) { if (animWindow.n >= 8 && R.animBursts.length < 60) R.animBursts.push({ t: Math.round(animWindow.t - R.t0), n: animWindow.n, names: animWindow.names }); animWindow = { t: now, n: 0, names: {} } }
  animWindow.n++; animWindow.names[e.animationName] = (animWindow.names[e.animationName] || 0) + 1
}
const onTrans = e => { const key = e.propertyName + ' @ ' + slotOf(e.target); R.transStarts[key] = (R.transStarts[key] || 0) + 1 }
document.addEventListener('animationstart', onAnim, true)
document.addEventListener('transitionrun', onTrans, true)
const pos = []
try { const po = new PerformanceObserver(l => { for (const e of l.getEntries()) if (R.longtasks.length < 300) R.longtasks.push({ t: Math.round(e.startTime - R.t0), d: Math.round(e.duration) }) }); po.observe({ entryTypes: ['longtask'] }); pos.push(po) } catch (e) { R.ltErr = String(e) }
try { const po = new PerformanceObserver(l => { for (const e of l.getEntries()) if (R.shifts.length < 200 && e.value > 0.001) R.shifts.push({ t: Math.round(e.startTime - R.t0), v: +e.value.toFixed(4), input: e.hadRecentInput, src: (e.sources || []).slice(0, 3).map(s => slotOf(s.node) + ' ' + Math.round(s.previousRect.y) + '→' + Math.round(s.currentRect.y)) }) }); po.observe({ type: 'layout-shift', buffered: false }); pos.push(po) } catch (e) { R.lsErr = String(e) }
const mo = new MutationObserver(recs => { R.muts += recs.length; for (const r of recs) { R.added += r.addedNodes.length; const s = slotOf(r.target); R.mutBySlot[s] = (R.mutBySlot[s] || 0) + 1 } })
mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
let off = null
try { off = sdkRef.host.onEvent('*', ev => { const t = ev && ev.type; if (!t) return; const e = R.events[t] || (R.events[t] = { n: 0, keys: Object.keys(ev), samples: [] }); e.n++; const keep = /^subagent|^todo|^approval|^clarify|^session\.info|^message\.(start|complete)|^tool\.(start|complete)|^thinking|^reasoning/.test(t) ? 3 : 1; if (e.samples.length < keep) e.samples.push(trunc(ev)); if (t === 'tool.start' || t === 'tool.complete') { const p = ev.payload || {}; const name = p.name || p.tool_name || ev.name; if (name) R.toolNames[name] = (R.toolNames[name] || 0) + 1 } }) } catch (e) { R.evErr = String(e) }
R.stop = () => { cancelAnimationFrame(raf); window.removeEventListener('wheel', onWheel, true); window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('animationstart', onAnim, true); document.removeEventListener('transitionrun', onTrans, true); pos.forEach(p => p.disconnect()); mo.disconnect(); if (typeof off === 'function') off(); delete window.__mgRec }
window.__mgRec = R
if (OPTS.snapshot === false) return { started: true }
// static snapshot
const root = document.documentElement
const v = vp()
const cfg = {}
for (const k of ['display.show_reasoning', 'display.tool_progress', 'display.reasoning_full', 'display.streaming']) { try { cfg[k] = (await sdkRef.host.request('config.get', { key: k }))?.value } catch (e) { cfg[k] = 'ERR ' + e } }
return {
  mgReady: root.dataset.mgReady, mgTools: root.dataset.mgTools, zoom: +(window.outerWidth / window.innerWidth).toFixed(3), inner: [innerWidth, innerHeight],
  elements: document.getElementsByTagName('*').length, threads: document.querySelectorAll('[data-slot="aui_thread-content"]').length,
  viewports: document.querySelectorAll('[data-slot="aui_thread-viewport"]').length, visibleViewport: !!v,
  inThisThread: v && { pairs: v.querySelectorAll('[data-slot="aui_turn-pair"]').length, rows: v.querySelectorAll('[data-slot="aui_assistant-message-root"]').length,
    toolBlocks: v.querySelectorAll('[data-slot="tool-block"]').length, thinking: v.querySelectorAll('[data-slot="aui_thinking-disclosure"]').length,
    thinkingVisible: [...v.querySelectorAll('[data-slot="aui_thinking-disclosure"]')].filter(vis).length,
    stale: v.querySelectorAll('[data-mg-stale]').length, mfLive: v.querySelectorAll('#mf-live').length, streaming: v.querySelectorAll('[data-message-streaming="true"]').length,
    activity: v.querySelectorAll('[data-slot="aui_turn-activity"]').length, loading: v.querySelectorAll('[data-slot="aui_response-loading"]').length,
    scrollH: v.scrollHeight, clientH: v.clientHeight, overflowAnchor: getComputedStyle(v).overflowAnchor,
    lastRow: (() => { const rows = v.querySelectorAll('[data-slot="aui_assistant-message-root"]'); const r = rows[rows.length - 1]; if (!r) return null; const c = r.querySelector('[data-slot="aui_assistant-message-content"]'); return { id: r.dataset.messageId, marks: { ...r.dataset }, kids: c ? [...c.children].slice(-12).map(k => (k.getAttribute('data-slot') || k.className.toString().slice(0, 30) || k.tagName) + (vis(k) ? '' : ' (hidden)')) : null } })() },
  running: document.getAnimations().length, cfg, plugins: [...document.querySelectorAll('style[id]')].map(s => s.id + ':' + s.textContent.length),
  focused: { sid: sdkRef.host.state.focusedSessionId?.get?.(), stored: sdkRef.host.state.focusedStoredSessionId?.get?.(), busy: sdkRef.host.state.busy?.get?.() }
}
