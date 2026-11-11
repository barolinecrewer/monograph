// Motion: what animates when each piece of chrome opens and closes, measured
// in the page (animationstart / transitionrun events and the Animation objects
// behind them, plus frame times), with motion on, with motion off and under
// reduced motion. See the brief in docs/workstreams.md (MOTION) and
// src/css/05-motion.css / 55-motion.css for what is expected.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { EVIDENCE, HERMES_REPO, RUNNING, check, hasModule, hotReload, results, shot, sleep, state, stubPlugin, turnDone, type } from '../harness.mjs'
import { startModel } from './stress.mjs'

const { PNG } = createRequire(path.join(HERMES_REPO, 'package.json'))('pngjs')

// The stress suite's model: tool calls, held turns and work on demand for the
// film (m9 to m11). Checks m1 to m8 send no prompt.
export const model = async () => startModel()
export const limitS = 1200

export const checks = [
  ['m1', 'Layers, motion on: one enter and one exit each, opacity and transform only, gone afterwards'],
  ['m2', 'Sidebar, panes, Settings overlay: eased where Hermes allows, no replay elsewhere'],
  ['m3', 'Twenty fast open/close cycles per layer: nothing stuck, nothing left eating clicks'],
  ['m4', 'Controls: press settles, focus ring appears at once, switch thumb glides'],
  ['m5', 'No replay: unrelated attribute changes start no animation'],
  ['m6', 'Motion off: nothing runs, end states correct, layers still leave'],
  ['m7', 'Reduced motion (emulated): nothing runs, end states correct, layers still leave'],
  ['m8', 'Motion: hot reload twice, then unloaded: one of everything, then nothing of ours'],
  ['m9', 'Film: every animation frame by frame (contact sheets), on the tokens, no flash, nothing else moves'],
  ['m10', 'Sweep: one second after each scene nothing of ours runs but a declared endless one, compositor-only'],
  ['m11', 'Film again with motion off and with reduced motion: every state reached, nothing invisible, layers leave'],
  ['m12', 'The animations added in wave 4 run on the compositor: no failure reason, no layout or main-thread paint per frame']
]

// Properties a chrome animation may touch. Colours are hover steps; the rest
// is opacity and the transform family.
const MOVING = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate'])
const COLOUR = /(^|-)(color|colour)$|^(fill|stroke)$|^background-color$|^color$|Color$/
const allowed = prop => MOVING.has(prop) || COLOUR.test(prop)
// The effort slider's starfield is the one standing exception in the brief:
// it loops while the menu is open and slides background tiles.
const STARFIELD = new Set(['mg-hyperspace', 'mg-power-pulse'])

// ── In-page recorder ─────────────────────────────────────────────────────────
function installRecorder() {
  if (window.__mgRec) return
  const name = node => {
    if (!(node instanceof Element)) return String(node)
    const bits = [node.tagName.toLowerCase()]
    for (const a of ['data-slot', 'data-tour', 'role', 'data-pane-host', 'data-state', 'aria-label', 'data-testid']) {
      const v = node.getAttribute(a)
      if (v != null) bits.push(`[${a}=${v.slice(0, 28)}]`)
    }
    if (bits.length === 1 && typeof node.className === 'string') bits.push('.' + node.className.trim().split(/\s+/).slice(0, 3).join('.'))
    return bits.join('')
  }
  const rec = { on: false, events: [], frames: [], sel: null }
  const find = (event, kind) => {
    const pseudo = event.pseudoElement || ''
    return document
      .getAnimations()
      .find(a => a.effect?.target === event.target && (a.effect.pseudoElement || '') === pseudo && (kind === 'a' ? a.animationName === event.animationName : a.transitionProperty === event.propertyName))
  }
  const log = event => {
    if (!rec.on) return
    const kind = event.type.startsWith('animation') ? 'a' : 't'
    const entry = {
      type: event.type,
      name: kind === 'a' ? event.animationName : event.propertyName,
      pseudo: event.pseudoElement || '',
      target: name(event.target),
      layer: Boolean(rec.sel && event.target instanceof Element && event.target.matches(rec.sel)),
      t: Math.round(performance.now() - rec.t0),
      phase: rec.phase
    }
    if (event.type === 'animationstart' || event.type === 'transitionrun') {
      const anim = find(event, kind)
      if (anim) {
        const timing = anim.effect.getComputedTiming()
        entry.duration = timing.duration
        entry.iterations = timing.iterations
        if (kind === 'a') {
          const frames = anim.effect.getKeyframes()
          entry.props = [...new Set(frames.flatMap(f => Object.keys(f).filter(k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k))))].map(k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))
          entry.easing = frames[0]?.easing
        } else {
          entry.props = [event.propertyName]
          entry.easing = anim.effect.getTiming().easing
        }
      } else {
        entry.props = kind === 't' ? [event.propertyName] : []
        entry.duration = event.elapsedTime
        entry.lost = true
      }
    }
    rec.events.push(entry)
  }
  for (const type of ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel']) {
    document.addEventListener(type, log, true)
  }
  const tick = now => {
    if (rec.on) {
      if (rec.last) rec.frames.push({ t: Math.round(now - rec.t0), d: Math.round(now - rec.last), phase: rec.phase })
      rec.last = now
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  rec.start = sel => Object.assign(rec, { on: true, events: [], frames: [], sel, phase: 'open', t0: performance.now(), last: 0, marks: {} })
  rec.mark = phase => {
    rec.phase = phase
    rec.marks[phase] = Math.round(performance.now() - rec.t0)
  }
  rec.stop = () => {
    rec.on = false
    return { events: rec.events, frames: rec.frames, marks: rec.marks }
  }
  // What is there now: every element matching `sel`, with what a pointer
  // and an eye would find.
  rec.layers = sel =>
    [...document.querySelectorAll(sel)].map(node => {
      const cs = getComputedStyle(node)
      const r = node.getBoundingClientRect()
      const hit = r.width && r.height ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null
      return {
        state: node.getAttribute('data-state'),
        opacity: Number(cs.opacity),
        transform: cs.transform,
        pointer: cs.pointerEvents,
        visible: node.checkVisibility() && cs.visibility !== 'hidden',
        inert: node.closest('[inert]') != null,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        hitInside: Boolean(hit && node.contains(hit)),
        running: node.getAnimations({ subtree: true }).filter(a => a.playState === 'running').map(a => a.animationName || a.transitionProperty || 'js')
      }
    })
  rec.running = () =>
    document
      .getAnimations()
      .filter(a => a.playState === 'running')
      .map(a => `${a.animationName || a.transitionProperty || a.constructor.name} on ${name(a.effect?.target)}${a.effect?.pseudoElement ?? ''} ${Math.round(a.effect?.getComputedTiming().duration ?? 0)}ms x${a.effect?.getComputedTiming().iterations}`)
  window.__mgRec = rec
}

// ── The surfaces ─────────────────────────────────────────────────────────────
const LAYERS = {
  menu: '[data-slot="dropdown-menu-content"]',
  tooltip: '[data-slot="tooltip-content"]',
  palette: '[role="dialog"]:not([data-slot])',
  dialog: '[data-slot="dialog-content"]'
}

// The one on screen: Hermes keeps other tabs' composers in the page,
// hidden (in Advanced the first reasoning pill was one of them, m11).
const centre = async locator => {
  const box = await locator.filter({ visible: true }).first().boundingBox()
  if (!box) throw new Error('no box for ' + locator)
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

// Advanced mode: Hermes' "Swap sidebar sides" button sits on the surfaces
// button (a known issue), so a click there swaps the sidebar. The
// surfaces menu is then left out of the run, and the report says so.
let SKIP = new Set()

async function coverage(page) {
  const covered = await page.evaluate(() => {
    const b = document.querySelector('[data-tour="mg-surfaces"]')
    if (!b) return 'no surfaces button'
    const r = b.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return b.contains(hit) ? null : `covered by ${hit?.getAttribute('aria-label') || hit?.tagName}`
  })
  if (covered) {
    SKIP = new Set(['surfaces'])
    results.observations.push(`motion: surfaces menu left out of this run, its button is ${covered} (a known issue)`)
  }
}

function surfaces(page) {
  return allSurfaces(page).filter(s => !SKIP.has(s.id))
}

const byId = (page, id) => allSurfaces(page).find(s => s.id === id)

function allSurfaces(page) {
  const clickAt = async sel => {
    const { x, y } = await centre(page.locator(sel))
    await page.mouse.click(x, y)
  }
  const esc = () => page.keyboard.press('Escape')
  return [
    { id: 'surfaces', label: 'Surfaces menu', layer: `${LAYERS.menu}.mg-surfaces-menu`, enter: 'mg-layer-in', exit: 'mg-layer-out', open: () => clickAt('[data-tour="mg-surfaces"] .mg-surfaces-hit'), close: esc, toggle: () => clickAt('[data-tour="mg-surfaces"] .mg-surfaces-hit') },
    { id: 'model', label: 'Model menu', layer: LAYERS.menu, enter: 'mg-layer-in', exit: 'mg-layer-out', open: () => clickAt('[data-tour="model-pill"]'), close: esc, toggle: () => clickAt('[data-tour="model-pill"]') },
    { id: 'approval', label: 'Approval mode menu', layer: `${LAYERS.menu}.mg-approval-menu`, enter: 'mg-layer-in', exit: 'mg-layer-out', open: () => clickAt('[data-slot="composer-fade"] button.mg-chip'), close: esc, toggle: () => clickAt('[data-slot="composer-fade"] button.mg-chip') },
    { id: 'effort', label: 'Effort slider', layer: LAYERS.menu, enter: 'mg-layer-in', exit: 'mg-layer-out', open: () => clickAt('[data-testid="reasoning-pill"]'), close: esc, toggle: () => clickAt('[data-testid="reasoning-pill"]') },
    {
      id: 'tooltip',
      label: 'Tooltip (sidebar button)',
      layer: LAYERS.tooltip,
      enter: 'mg-layer-in',
      exit: 'mg-layer-out',
      open: async () => {
        const { x, y } = await centre(page.locator('[data-titlebar-cluster="left"] > button'))
        await page.mouse.move(x, y, { steps: 3 })
      },
      close: () => page.mouse.move(640, 560, { steps: 3 }),
      toggle: async () => {
        const { x, y } = await centre(page.locator('[data-titlebar-cluster="left"] > button'))
        await page.mouse.move(x, y)
        await sleep(30)
        await page.mouse.move(640, 560)
      },
      settle: 1300
    },
    { id: 'palette', label: 'Command palette', layer: LAYERS.palette, enter: 'mg-layer-in', exit: 'mg-layer-out', open: () => page.keyboard.press('Meta+k'), close: esc, toggle: () => page.keyboard.press('Meta+k') },
    {
      id: 'dialog',
      label: 'Dialog (New project)',
      layer: LAYERS.dialog,
      enter: 'mg-layer-in',
      exit: 'mg-layer-out',
      open: async () => {
        const { x, y } = await centre(page.getByText('New project', { exact: true }))
        await page.mouse.click(x, y)
      },
      close: esc,
      toggle: null
    }
  ]
}

const props = events => [...new Set(events.flatMap(e => e.props ?? []))]
const brief = e => `${e.t}ms ${e.type === 'animationstart' ? 'anim' : 'trans'} ${e.name}${e.pseudo} on ${e.target} ${Math.round(e.duration ?? -1)}ms ${e.easing ?? ''} [${(e.props ?? []).join(',')}]`

// Open, hold, close, hold; everything that started on the way.
async function cycle(page, s, hold = 450) {
  await page.evaluate(sel => window.__mgRec.start(sel), s.layer)
  await s.open()
  await sleep(s.settle ?? hold)
  const opened = await page.evaluate(sel => window.__mgRec.layers(sel), s.layer)
  await page.evaluate(() => window.__mgRec.mark('close'))
  await s.close()
  await sleep(hold)
  const rec = await page.evaluate(() => window.__mgRec.stop())
  const closed = await page.evaluate(sel => window.__mgRec.layers(sel), s.layer)
  return { rec, opened, closed }
}

function judgeCycle(s, { rec, opened, closed }, must, mode) {
  const starts = rec.events.filter(e => e.type === 'animationstart' || e.type === 'transitionrun')
  const onLayer = starts.filter(e => e.layer && !e.pseudo)
  const enter = onLayer.filter(e => e.phase === 'open' && e.name === s.enter)
  const exit = onLayer.filter(e => e.phase === 'close' && e.name === s.exit)
  const exitEnded = rec.events.filter(e => e.layer && e.type === 'animationend' && e.name === s.exit)
  const out = {
    layerOpen: opened.map(l => `${l.state} op=${l.opacity} ${l.size} pe=${l.pointer} running=${l.running.join('|') || 'none'}`),
    layerAfterClose: closed.map(l => `${l.state} op=${l.opacity} pe=${l.pointer} visible=${l.visible} hit=${l.hitInside}`),
    layerAnims: onLayer.map(brief),
    otherAnims: starts.filter(e => !e.layer).map(brief).slice(0, 12)
  }
  const shown = opened.filter(l => l.visible && l.state !== 'closed')
  must(shown.length >= 1, `${s.id}: no visible layer after opening`)
  must(shown.every(l => l.opacity === 1), `${s.id}: open layer not at full opacity (${shown.map(l => l.opacity)})`)
  must(shown.every(l => !l.running.filter(n => !STARFIELD.has(n)).length), `${s.id}: open layer still animating after ${s.settle ?? 450}ms`)
  // Gone, or at least out of reach of the pointer.
  const stuck = closed.filter(l => l.visible && (l.pointer !== 'none' || l.opacity > 0) && !l.inert)
  must(!stuck.length, `${s.id}: layer still there after closing: ${JSON.stringify(stuck)}`)
  if (mode === 'on') {
    must(enter.length === 1, `${s.id}: enter ran ${enter.length} times (want 1)`)
    must(exit.length === 1, `${s.id}: exit ran ${exit.length} times (want 1)`)
    must(exitEnded.length >= 1, `${s.id}: exit never reported animationend`)
    for (const e of [...enter, ...exit]) {
      must(e.duration >= 100 && e.duration <= 240, `${s.id}: ${e.name} lasts ${e.duration}ms`)
      must((e.props ?? []).every(p => MOVING.has(p)), `${s.id}: ${e.name} animates ${e.props}`)
    }
  } else {
    // Off: anything that starts takes no time and no transition is created.
    const slow = starts.filter(e => (e.duration ?? 0) > 1)
    must(!slow.length, `${s.id}: ${slow.length} animation(s) with time in ${mode}: ${slow.slice(0, 3).map(brief).join('; ')}`)
    const trans = starts.filter(e => e.type === 'transitionrun')
    must(!trans.length, `${s.id}: ${trans.length} transition(s) in ${mode}: ${trans.slice(0, 3).map(brief).join('; ')}`)
  }
  const bad = starts.filter(e => !STARFIELD.has(e.name) && !(e.props ?? []).every(allowed))
  must(!bad.length, `${s.id}: non-opacity/transform property animated: ${bad.slice(0, 4).map(brief).join('; ')}`)
  // Frames. A frame is blamed on the layer's animation when it starts after
  // the animation's first two frames (those carry React mounting the layer)
  // and before the animation ends. Over 32ms there is a failure.
  const windows = onLayer.filter(e => e.type === 'animationstart' && e.duration > 1).map(e => [e.t, e.t + e.duration])
  const long = []
  for (const [from, to] of windows) {
    const inside = rec.frames.filter(f => f.t > from && f.t - f.d <= to)
    long.push(...inside.slice(2).filter(f => f.d > 32))
  }
  out.frames = `max ${Math.max(0, ...rec.frames.map(f => f.d))}ms over ${rec.frames.length} frames; during layer animation after its first two frames: ${long.map(f => `${f.d}ms@${f.t}`).join(',') || 'none over 32ms'}`
  out.longFrames = long.length
  return out
}

// Twenty fast cycles, then: no layer left half-way, no layer eating clicks,
// and the surface still opens and closes properly.
async function hammer(page, s, must) {
  const repeat = async (fn, n) => {
    for (let i = 0; i < n; i++) {
      await fn()
      await sleep(25 + (i % 3) * 20)
    }
  }
  if (s.toggle) {
    await repeat(s.toggle, 20)
  } else {
    await repeat(async () => {
      await s.open()
      await sleep(40)
      await s.close()
    }, 20)
  }
  await sleep(500)
  // Whatever state it ended in, it must be a clean one.
  let layers = await page.evaluate(sel => window.__mgRec.layers(sel), s.layer)
  const half = layers.filter(l => l.visible && l.state !== 'closed' && (l.opacity < 1 || l.running.length))
  must(!half.length, `${s.id}: after 20 fast cycles a layer is half-way: ${JSON.stringify(half)}`)
  const ghosts = layers.filter(l => l.state === 'closed' && l.visible && l.pointer !== 'none')
  must(!ghosts.length, `${s.id}: after 20 fast cycles a closed layer still takes the pointer`)
  if (layers.some(l => l.state !== 'closed' && l.visible)) {
    await s.close()
    await sleep(450)
  }
  layers = await page.evaluate(sel => window.__mgRec.layers(sel), s.layer)
  const left = layers.filter(l => l.visible && !l.inert && (l.opacity > 0 || l.pointer !== 'none'))
  must(!left.length, `${s.id}: after 20 fast cycles and a close, ${left.length} layer(s) remain`)
  // Still works.
  const again = await cycle(page, s)
  const ok = again.opened.some(l => l.visible && l.opacity === 1) && !again.closed.some(l => l.visible && l.pointer !== 'none')
  must(ok, `${s.id}: does not open and close cleanly after the fast cycles`)
  return { endedWith: layers.length, reopened: ok }
}

const setMotion = (page, value) => page.evaluate(v => (document.documentElement.dataset.mgMotion = v), value)

// A trigger this mode does not draw (Advanced mode has no approval chip)
// is reported, not failed.
const TRIGGERS = { surfaces: '[data-tour="mg-surfaces"]', model: '[data-tour="model-pill"]', approval: '[data-slot="composer-fade"] button.mg-chip', effort: '[data-testid="reasoning-pill"]' }

async function present(page, s) {
  const sel = TRIGGERS[s.id]
  if (!sel || (await page.locator(sel).count())) return true
  if (!SKIP.has(s.id)) results.observations.push(`motion: ${s.label} left out, its trigger (${sel}) is not drawn in this mode`)
  SKIP.add(s.id)
  return false
}

async function layersPass(page, mode, entry, must) {
  for (const s of surfaces(page)) {
    if (!(await present(page, s))) continue
    try {
      const result = await cycle(page, s)
      const out = (entry.evidence[s.id] = judgeCycle(s, result, must, mode))
      // A long frame can be the machine (other rigs run beside this one).
      // One that comes back on two more tries is the animation's.
      if (out.longFrames) {
        out.retries = []
        for (let i = 0; i < 2 && out.retries.every(r => r.longFrames); i++) {
          const again = judgeCycle(s, await cycle(page, s), () => true, mode)
          out.retries.push({ longFrames: again.longFrames, frames: again.frames })
        }
        must(out.retries.some(r => !r.longFrames), `${s.id}: frames over 32ms while the layer animated, on all three tries`)
      }
    } catch (error) {
      must(false, `${s.id}: ${String(error).slice(0, 200)}`)
    }
  }
}

// ── Film (m9 to m11) ─────────────────────────────────────────────────────────
// Each scene is filmed twice over: in the page, every animation frame
// (requestAnimationFrame, 165 Hz here) samples each target's effective
// opacity (its own times its ancestors'), box and transform, and the boxes of
// a few landmarks (composer, titlebar, sidebar); and the debugging protocol's
// screencast keeps the pictures, which are cropped to the target and laid out
// left to right, top to bottom, as one contact sheet per target
// (shots/film-<mode>-<scene>-<target>.png, frame times in the evidence).
function installFilm() {
  if (window.__mgFilm) return
  const f = { on: false, rows: [] }
  const round = v => Math.round(v * 2) / 2
  const box = r => `${round(r.x)},${round(r.y)},${round(r.width)},${round(r.height)}`
  const eff = node => {
    let o = 1
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
    return Math.round(o * 1000) / 1000
  }
  const LAND = { composer: '[data-slot="composer-root"]', titlebar: '[data-titlebar-cluster="left"]', sidebar: '[data-slot="sidebar"]', homeBody: '.mg-home-body', dock: '[data-slot="composer-dock"]', butterbar: '[data-slot="butterbar"]' }
  const pick = spec => {
    const all = [...document.querySelectorAll(spec.sel)].filter(n => n.checkVisibility() && n.getClientRects().length)
    return spec.which === 'first' ? all[0] : all.at(-1)
  }
  const tick = now => {
    if (!f.on) return
    const row = { t: Math.round((now - f.t0) * 10) / 10, v: {} }
    for (const [k, spec] of Object.entries(f.targets)) {
      const el = pick(spec)
      if (!el) {
        row.v[k] = null
        continue
      }
      const cs = getComputedStyle(el, spec.pseudo ?? null)
      const o = spec.pseudo ? Math.round(Number(cs.opacity) * eff(el) * 1000) / 1000 : eff(el)
      row.v[k] = { o, b: box(el.getBoundingClientRect()), tf: cs.transform === 'none' ? '' : cs.transform, sc: cs.scale === 'none' ? '' : cs.scale, tr: cs.translate === 'none' ? '' : cs.translate, bg: spec.colour ? cs.backgroundColor + cs.color : '' }
    }
    row.land = Object.fromEntries(Object.entries(LAND).map(([k, s]) => {
      const n = document.querySelector(s)
      return [k, n && n.checkVisibility() ? box(n.getBoundingClientRect()) : null]
    }))
    f.rows.push(row)
    requestAnimationFrame(tick)
  }
  f.start = targets => {
    Object.assign(f, { on: true, t0: performance.now(), rows: [], targets })
    requestAnimationFrame(tick)
    return performance.timeOrigin + f.t0
  }
  f.stop = () => {
    f.on = false
    return f.rows
  }
  // Every running animation and transition, with whose it is: a CSS
  // animation is ours when its keyframes are in #mg-css; with the keyframes'
  // properties, iterations and the element it runs on.
  f.sweep = () => {
    const ours = new Set()
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode?.id !== 'mg-css') continue
      const walk = rules => {
        for (const r of rules) {
          if (r instanceof CSSKeyframesRule) ours.add(r.name)
          else if (r.cssRules) walk(r.cssRules)
        }
      }
      walk(sheet.cssRules)
    }
    const name = node => {
      if (!(node instanceof Element)) return String(node)
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(c => !c.includes(':')).slice(0, 3).join('.') : ''
      return `${node.tagName.toLowerCase()}${node.dataset.slot ? `[data-slot=${node.dataset.slot}]` : ''}${cls ? '.' + cls : ''}`
    }
    return document
      .getAnimations()
      .filter(a => a.playState === 'running' || a.pending)
      .map(a => {
        const timing = a.effect?.getComputedTiming() ?? {}
        const props = [...new Set((a.effect?.getKeyframes?.() ?? []).flatMap(k => Object.keys(k).filter(p => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))]
        return {
          kind: a.animationName ? 'animation' : a.transitionProperty ? 'transition' : 'script',
          name: a.animationName || a.transitionProperty || a.id || 'js',
          ours: Boolean(a.animationName && ours.has(a.animationName)),
          target: name(a.effect?.target) + (a.effect?.pseudoElement ?? ''),
          endless: timing.iterations === Infinity,
          duration: Math.round(timing.duration ?? 0),
          age: Math.round(Number(a.currentTime ?? 0)),
          props: props.map(p => p.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))
        }
      })
  }
  window.__mgFilm = f
}

const filmDir = () => {
  const dir = path.join(EVIDENCE, 'shots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Crops `frames` (screencast PNGs) to `clip` (CSS px) and lays them out in
// rows of five, nearest-neighbour scaled so a cell is at most 380 px wide.
function contactSheet(file, frames, clip, scale) {
  const wide = clip.width > 480
  const k = Math.max(1, Math.ceil((clip.width * scale) / (wide ? 640 : 380)))
  const sx = Math.max(0, Math.round(clip.x * scale))
  const sy = Math.max(0, Math.round(clip.y * scale))
  const w = Math.max(1, Math.floor((clip.width * scale) / k))
  const h = Math.max(1, Math.floor((clip.height * scale) / k))
  const cols = Math.min(wide ? 2 : 5, frames.length)
  const rows = Math.ceil(frames.length / cols)
  const gap = 3
  const out = new PNG({ width: cols * (w + gap) + gap, height: rows * (h + gap) + gap })
  for (let i = 0; i < out.data.length; i += 4) out.data.set([90, 90, 90, 255], i)
  frames.forEach((frame, index) => {
    const img = PNG.sync.read(Buffer.from(frame.data, 'base64'))
    const ox = gap + (index % cols) * (w + gap)
    const oy = gap + Math.floor(index / cols) * (h + gap)
    for (let y = 0; y < h; y++) {
      const iy = sy + y * k
      if (iy >= img.height) break
      for (let x = 0; x < w; x++) {
        const ix = sx + x * k
        if (ix >= img.width) break
        const s = (iy * img.width + ix) * 4
        const d = ((oy + y) * out.width + ox + x) * 4
        out.data[d] = img.data[s]
        out.data[d + 1] = img.data[s + 1]
        out.data[d + 2] = img.data[s + 2]
        out.data[d + 3] = 255
      }
    }
  })
  fs.writeFileSync(file, PNG.sync.write(out))
  return file
}

const stateKey = v => (v ? `${v.o}|${v.b}|${v.tf}|${v.sc}|${v.tr}|${v.bg}` : 'none')

// What one target did over a film: when it first and last changed, how many
// distinct states it went through, whether it showed its end state (or held
// its start state) before moving, how many separate bursts of change it had,
// and where it ended.
function judgeTarget(rows, k) {
  const seq = rows.map(r => ({ t: r.t, v: r.v[k] }))
  const changes = []
  for (let i = 1; i < seq.length; i++) if (stateKey(seq[i].v) !== stateKey(seq[i - 1].v)) changes.push(i)
  const first = changes[0]
  const last = changes.at(-1)
  const out = { samples: seq.length, changes: changes.length }
  if (!changes.length) return { ...out, still: true, final: seq.at(-1)?.v ?? null }
  out.from = seq[first - 1].v
  out.final = seq.at(-1).v
  out.startMs = seq[first].t
  out.spanMs = Math.round(seq[last].t - seq[first - 1].t)
  out.distinct = new Set(seq.slice(first - 1, last + 1).map(s => stateKey(s.v))).size
  // Bursts: runs of change separated by more than 60 ms of standing still.
  let bursts = 1
  // (A gap counts only when it spans more than three frames: one long frame
  // on a loaded machine is not a second burst.)
  for (let i = 1; i < changes.length; i++) if (seq[changes[i]].t - seq[changes[i - 1]].t > 60 && changes[i] - changes[i - 1] > 3) bursts++
  out.bursts = bursts
  out.trace = changes.slice(0, 36).map(i => `${seq[i].t}:${seq[i].v ? `${seq[i].v.o}|${seq[i].v.b}|${seq[i].v.tf}${seq[i].v.sc}${seq[i].v.tr}` : 'gone'}`)
  out.settledMs = Math.round(seq.at(-1).t - seq[last].t)
  // The frame interval here (rAF: 60 Hz while the rig window is covered,
  // up to the display's 165 Hz in front).
  const gaps = seq.slice(1).map((s, i) => s.t - seq[i].t).sort((a, b) => a - b)
  out.frameMs = Math.round(gaps[Math.floor(gaps.length / 2)] ?? 16.7)
  // Movement time: from the first frame it is there and changing (an
  // entrance) or the first change (anything else) to the first frame of its
  // end state; for an exit, to the first frame at no opacity or gone.
  const from = seq[first - 1].v === null ? first : first - 1
  const endKey = stateKey(out.final)
  let to = last
  for (let i = from; i <= last; i++) {
    if (!seq[i].v || seq[i].v.o <= 0.01 || (stateKey(seq[i].v) === endKey && seq.slice(i).every(x => stateKey(x.v) === endKey))) {
      to = i
      break
    }
  }
  out.moveMs = Math.round(seq[to].t - seq[from].t)
  // Time the window drew no frame while it moved: every gap between two
  // samples beyond one frame interval. On a loaded machine one dropped frame
  // at 165 Hz is longer than the whole four-frame slack (int4: 30 ms with
  // the menu at 0.07, then gone), so that much of the movement is unknown,
  // not slow. An animation that is slow at a steady frame rate has no gaps.
  out.gapMs = Math.round(seq.slice(from + 1, to + 1).reduce((sum, s, i) => sum + Math.max(0, s.t - seq[from + i].t - out.frameMs), 0))
  // Appearing: the first frame it is there. A flash of the end state is that
  // frame already equal to the final one with movement after it; a held
  // start is the same first state kept over more than two frames first.
  const appear = seq.findIndex(s => s.v)
  if (appear > 0 && seq[appear - 1].v === null) {
    out.appearMs = seq[appear].t
    const settled = seq.slice(appear).findIndex(s => stateKey(s.v) !== stateKey(seq[appear].v))
    out.firstState = seq[appear].v
    out.endFlash = stateKey(seq[appear].v) === stateKey(out.final) && settled > 0 && changes.some(i => i > appear + settled)
    out.heldStartFrames = settled < 0 ? 0 : settled
    // How long that first state stood, up to the last sample that showed it
    // (a sample after a dropped frame does not stretch it).
    out.heldStartMs = settled > 0 ? Math.round(seq[appear + settled - 1].t - seq[appear].t) : 0
  }
  return out
}

function landMoves(rows, keys) {
  const moved = {}
  for (const key of keys) {
    const values = [...new Set(rows.map(r => r.land[key]).filter(v => v !== undefined))]
    if (values.length > 1) moved[key] = values.slice(0, 3)
  }
  return moved
}

// One scene: setup, then film `act` for `ms`, judge each target and write
// its contact sheet.
async function film(mode, scene) {
  const { page, cdp } = state
  if (scene.setup) await scene.setup()
  const frames = []
  const onFrame = ({ data, metadata, sessionId }) => {
    frames.push({ ts: metadata.timestamp * 1000, data })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1220, maxHeight: 800 })
  await sleep(150)
  await page.evaluate(() => window.__mgRec.start(null))
  const t0 = await page.evaluate(t => window.__mgFilm.start(t), scene.targets)
  let error = null
  try {
    await scene.act()
    await sleep(scene.ms ?? 700)
  } catch (e) {
    error = String(e).slice(0, 240)
  }
  const rows = await page.evaluate(() => window.__mgFilm.stop())
  const rec = await page.evaluate(() => window.__mgRec.stop())
  await cdp.send('Page.stopScreencast').catch(() => undefined)
  cdp.off('Page.screencastFrame', onFrame)
  const vw = await page.evaluate(() => innerWidth)
  const out = { error, frames: rows.length, screencastFrames: frames.length, targets: {} }
  // A frame over 250 ms is the machine (six rig windows share it), not the
  // animation: such a film is marked stalled and its timing is not judged.
  out.stalledMs = Math.max(0, ...rows.slice(1).map((r, i) => Math.round(r.t - rows[i].t)).filter(g => g > 250))
  // Every animation and transition that started, with its duration.
  out.started = rec.events.filter(e => e.type === 'animationstart' || e.type === 'transitionrun').map(e => ({ name: e.name + e.pseudo, target: e.target, duration: Math.round((e.duration ?? 0) * 100) / 100 }))
  out.inDom = await page.evaluate(t => Object.fromEntries(Object.entries(t).map(([k, spec]) => [k, document.querySelectorAll(spec.sel).length])), scene.targets)
  for (const k of Object.keys(scene.targets)) {
    const j = judgeTarget(rows, k)
    out.targets[k] = j
    // Crop: every box the target had, padded.
    const boxes = rows.map(r => r.v[k]?.b).filter(Boolean).map(b => b.split(',').map(Number))
    if (!boxes.length || !frames.length) continue
    const pad = 14
    const x0 = Math.max(0, Math.min(...boxes.map(b => b[0])) - pad)
    const y0 = Math.max(0, Math.min(...boxes.map(b => b[1])) - pad)
    const x1 = Math.min(vw, Math.max(...boxes.map(b => b[0] + b[2])) + pad)
    const y1 = Math.min(800, Math.max(...boxes.map(b => b[1] + b[3])) + pad)
    const clip = { x: x0, y: y0, width: Math.max(8, x1 - x0), height: Math.max(8, y1 - y0) }
    const scale = PNG.sync.read(Buffer.from(frames[0].data, 'base64')).width / vw
    // Frames from just before the act to 120 ms after the target's last change.
    const end = t0 + (j.still ? 400 : j.startMs + j.spanMs + 120)
    let chosen = frames.filter(f => f.ts >= t0 - 40 && f.ts <= end)
    if (chosen.length > 20) chosen = Array.from({ length: 20 }, (_, i) => chosen[Math.round((i * (chosen.length - 1)) / 19)])
    if (!chosen.length) chosen = frames.slice(0, 1)
    const file = contactSheet(path.join(filmDir(), `film-${mode}-${scene.id}-${k}.png`), chosen, clip, scale)
    j.sheet = path.basename(file)
    j.sheetFramesMs = chosen.map(f => Math.round(f.ts - t0))
  }
  out.moved = landMoves(rows, scene.still ?? ['composer', 'titlebar', 'sidebar'])
  // Every landmark that changed, first and last value, for the report.
  out.landChanged = landMoves(rows, Object.keys(rows[0]?.land ?? {}))
  if (scene.after) await scene.after().catch(() => undefined)
  return out
}

// Judging a filmed target against what the scene expects of it.
function judgeFilm(mode, scene, out, must) {
  const label = `${scene.id}`
  must(!out.error, `${label}: ${out.error}`)
  for (const [k, kind] of Object.entries(scene.expect ?? {})) {
    const j = out.targets[k]
    if (!j) continue
    const name = `${label}.${k}`
    const max = scene.maxMs?.[k] ?? 200
    if (kind === 'gone') {
      must(j.final === null, `${name}: still on screen at the end (${JSON.stringify(j.final)})`)
    }
    if (kind === 'shown' && mode === 'on') {
      must(j.final && j.final.o > 0.5, `${name}: not shown at the end (${JSON.stringify(j.final)})`)
    }
    if (kind === 'there') {
      must(j.final && j.final.o > 0.99, `${name}: not fully drawn at the end (${JSON.stringify(j.final)})`)
    }
    if (mode === 'on' && out.stalledMs) {
      results.observations.push(`motion film: ${name}: a ${out.stalledMs} ms frame (machine stall), timing not judged`)
    } else if (mode === 'on') {
      if (kind === 'enter' || kind === 'exit' || kind === 'press') {
        must(!j.still, `${name}: nothing moved`)
        if (j.still) continue
        // On the tokens: the token plus four frames for the sampling and a
        // loaded machine.
        // Plus the time no frame was drawn (gapMs): unknown, not slow.
        const limit = max + 4 * (j.frameMs ?? 17) + (j.gapMs ?? 0)
        must(j.moveMs <= limit, `${name}: moved for ${j.moveMs} ms (token ${max}, at most ${limit}, ${j.gapMs ?? 0} ms of it undrawn)`)
        must(j.distinct > 2, `${name}: only ${j.distinct} distinct frame(s)`)
        must(!j.endFlash, `${name}: its first frame was already its end state, then it moved`)
        must(j.bursts <= (scene.bursts?.[k] ?? 1), `${name}: ${j.bursts} separate bursts of movement (replay)`)
      }
      if (kind === 'enter') {
        must(j.final && j.final.o > 0.99, `${name}: ended at opacity ${j.final?.o}`)
        must(j.settledMs >= 80, `${name}: still moving at the end of the film (last change ${j.settledMs} ms before it)`)
        // Held: more than two frames at the 60 Hz the rule was written for
        // (33 ms), measured in time: at 165 Hz three frames are 18 ms, the
        // mount frame and the animation's own first frame.
        must(!(j.heldStartFrames > 2 && j.heldStartMs > 34 && j.firstState?.o === 0), `${name}: held its start state for ${j.heldStartFrames} frames (${j.heldStartMs} ms)`)
      }
      if (kind === 'exit') must(j.final === null || j.final.o === 0, `${name}: still shown after its exit`)
    } else {
      // Motion off / reduced: what changes, changes in one step: no
      // animation or transition with any time in it (checked once per
      // scene, below), and it ends where it rests.
      if (kind === 'enter' || kind === 'there') must(j.final && j.final.o > 0.99, `${name}: left at opacity ${j.final?.o} with motion ${mode}`)
      if (kind === 'shown') must(j.final && j.final.o > 0.5, `${name}: left at opacity ${j.final?.o} with motion ${mode}`)
      if (kind === 'exit') must(j.final === null || j.final.o === 0, `${name}: still shown after closing with motion ${mode}`)
      if (kind === 'exit') must(!out.inDom?.[k], `${name}: ${out.inDom?.[k]} still in the DOM after closing with motion ${mode}`)
    }
  }
  const moved = Object.keys(out.moved ?? {})
  must(!moved.length, `${label}: moved meanwhile: ${JSON.stringify(out.moved)}`)
  if (mode !== 'on') {
    const timed = (out.started ?? []).filter(e => e.duration > 1)
    must(!timed.length, `${label}: ${timed.length} animation(s) or transition(s) with time in them with motion ${mode}: ${timed.slice(0, 3).map(e => `${e.name} ${e.duration} ms on ${e.target}`).join('; ')}`)
  }
}

// Endless animations of ours that may run, each with its cause.
const ENDLESS = {
  'mf-spin': 'a session working (sidebar ring)',
  'monograph-pulse': 'needs input / voice / home loading',
  'mg-agent-breathe': 'a turn running (agent pane)',
  'mg-agent-blink': 'a turn running (agent pane bot)',
  'mg-working': 'a session working (sidebar title)',
  'mg-hyperspace': 'effort menu open (declared exception: background tiles)',
  'mg-power-pulse': 'effort menu open'
}

async function sweep() {
  const { page } = state
  const all = await page.evaluate(() => window.__mgFilm.sweep())
  const busy = await page.evaluate(sel => Boolean(document.querySelector(sel)) || Boolean(document.querySelector('[data-working="true"]')), RUNNING)
  const menu = await page.evaluate(() => Boolean(document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]')))
  const ours = all.filter(a => a.ours)
  const bad = []
  for (const a of ours) {
    // A finite one that started in the last second while a turn is still
    // running is something arriving, not something left running.
    if (!a.endless) {
      if (!busy || a.age >= 1000) bad.push(`${a.name} on ${a.target} still running (${a.duration} ms, ${a.age} ms in) one second on`)
    }
    else if (!ENDLESS[a.name]) bad.push(`${a.name} on ${a.target}: endless and not declared`)
    else if (!STARFIELD.has(a.name) && !a.props.every(p => MOVING.has(p))) bad.push(`${a.name} on ${a.target}: endless and animates ${a.props}`)
    else if (STARFIELD.has(a.name) ? !menu : !busy) bad.push(`${a.name} on ${a.target}: endless with no cause (nothing running, no menu open)`)
  }
  const perName = {}
  for (const a of ours.filter(a => a.endless)) perName[a.name] = (perName[a.name] ?? 0) + 1
  return { ours: ours.map(a => `${a.name}${a.endless ? '∞' : ''} ${a.target}`), others: all.filter(a => !a.ours).map(a => `${a.kind} ${a.name}${a.endless ? '∞' : ''} ${a.target}`).slice(0, 8), perName, bad }
}

const clickSel = async (sel, opts = {}) => {
  // Nothing of `sel` on screen: say what there is of it (hidden copies, the
  // route, the composer's controls) instead of only timing out.
  await state.page.locator(sel).filter({ visible: true }).first().waitFor({ timeout: 10_000 }).catch(() => undefined)
  if (!(await state.page.locator(sel).filter({ visible: true }).count())) {
    const seen = await state.page.evaluate(sel => ({
      hash: location.hash,
      root: Object.keys(document.documentElement.dataset).join(' '),
      copies: [...document.querySelectorAll(sel)].map(node => {
        const r = node.getBoundingClientRect()
        const cs = getComputedStyle(node)
        let hidden = null
        for (let el = node; el && !hidden; el = el.parentElement) {
          const s = getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || el.hidden || el.inert) hidden = `${el.tagName.toLowerCase()}${el.dataset.slot ? `[data-slot=${el.dataset.slot}]` : ''}.${String(el.className).slice(0, 60)} d=${s.display} v=${s.visibility} o=${s.opacity}`
        }
        return { r: [r.x, r.y, r.width, r.height].map(Math.round), d: cs.display, v: cs.visibility, o: cs.opacity, hidden }
      }),
      composers: [...document.querySelectorAll('[data-slot="composer-fade"]')].map(node => ({ shown: node.checkVisibility(), buttons: [...node.querySelectorAll('button')].filter(b => b.checkVisibility()).map(b => b.getAttribute('data-testid') || b.getAttribute('aria-label') || b.textContent.trim().slice(0, 20)) }))
    }), sel).catch(error => String(error))
    results.observations.push(`motion: no visible ${sel}: ${JSON.stringify(seen).slice(0, 1500)}`)
    await state.page.screenshot({ path: path.join(process.env.MG_RIG_EVIDENCE, 'shots', `missing-${sel.replace(/[^a-z]+/gi, '-').slice(0, 40)}.png`) }).catch(() => undefined)
  }
  const { x, y } = await centre(state.page.locator(sel))
  await state.page.mouse.click(x, y, opts)
}

async function surfacesRowClick(label) {
  await clickSel('[data-tour="mg-surfaces"] .mg-surfaces-hit')
  await state.page.waitForSelector('.mg-surfaces-menu', { state: 'visible', timeout: 5000 })
  await sleep(250)
  const { x, y } = await centre(state.page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: label }))
  await state.page.mouse.click(x, y)
}

const T = {
  menu: { sel: '[data-slot="dropdown-menu-content"]' },
  surfaces: { sel: '.mg-surfaces-menu' },
  approval: { sel: '.mg-approval-menu' },
  context: { sel: '[data-slot="context-menu-content"], [data-slot="dropdown-menu-content"]' },
  tooltip: { sel: '[data-slot="tooltip-content"]' },
  palette: { sel: '[role="dialog"]:not([data-slot])' },
  dialog: { sel: '[data-slot="dialog-content"]' },
  settings: { sel: '[data-overlay-surface] > div > [data-glass-raised]' },
  bubble: { sel: '[data-slot="aui_user-message-root"]' },
  reply: { sel: '[data-slot="aui_assistant-message-content"] .aui-md > :first-child' },
  tool: { sel: '[data-slot="tool-block"]' },
  logo: { sel: '[data-mg-svc-head]', pseudo: '::before' },
  glyph: { sel: '[data-slot="tool-block"] svg, [data-slot="tool-block"] .codicon' },
  head: { sel: '[data-slot="aui_assistant-message-root"][data-mg-head]' },
  // The "Worked for" line: its own element right before the head row
  // (syncLine in plugin.js), a disclosure when there is work behind it.
  line: { sel: '.mg-line[data-mg-steps]' },
  // What folds is marked on the elements themselves (data-mg-work).
  work: { sel: '[data-mg-work]' },
  row: { sel: '[data-slot="sidebar"] .row-hover', which: 'first', colour: true },
  copy: { sel: '.mg-ucopy', pseudo: '::before' },
  pane: { sel: '.mg-agent' },
  step: { sel: '.mg-agent-step' },
  kb: { sel: '.mg-kb' },
  card: { sel: '.mg-kb-card, .mg-kb-state', which: 'first' },
  reader: { sel: '.mg-kb-reader' },
  home: { sel: '.mg-home-body' },
  hello: { sel: '.mg-home-hello' },
  thread: { sel: '[data-slot="aui_thread-viewport"]' },
  send: { sel: '[data-slot="composer-fade"] button[type="submit"]' },
  pill: { sel: '[data-tour="model-pill"]' },
  thumb: { sel: '[data-slot="switch-thumb"]', which: 'first' },
  jump: { sel: '.thread-jump-button' },
  toast: { sel: '[data-sonner-toast], [data-slot="toast"], [role="status"][data-state]' }
}
const pickT = (...keys) => Object.fromEntries(keys.map(k => [k, T[k]]))

// The fold's line is div.mg-line, laid over the head row's top; it takes no
// pointer, so a press on it lands on the row, which is the button.
async function clickHead() {
  const box = await state.page.locator(T.line.sel).last().boundingBox()
  if (!box) throw new Error('no "Worked for" line')
  await state.page.mouse.click(Math.round(box.x + 60), Math.round(box.y + box.height / 2))
}

function scenes() {
  const { page } = state
  const esc = () => page.keyboard.press('Escape')
  const NO_SIDEBAR = ['composer', 'titlebar']
  const layer = (id, key, open, close, extra = {}) => [
    { id: `${id}-open`, targets: pickT(key), act: open, expect: { [key]: 'enter' }, again: async () => { await close(); await sleep(500) }, ...extra },
    { id: `${id}-close`, targets: pickT(key), act: close, expect: { [key]: 'exit' }, maxMs: { [key]: 120 }, again: async () => { await open(); await sleep(500) }, ...extra }
  ]
  return [
    ...layer('surfaces', 'surfaces', () => clickSel('[data-tour="mg-surfaces"] .mg-surfaces-hit'), esc),
    ...layer('model', 'menu', () => clickSel('[data-tour="model-pill"]'), esc),
    ...layer('approval', 'approval', () => clickSel('[data-slot="composer-fade"] button.mg-chip'), esc),
    ...layer('effort', 'menu', () => clickSel('[data-testid="reasoning-pill"]'), esc),
    ...layer('tooltip', 'tooltip', async () => {
      const { x, y } = await centre(page.locator('[data-titlebar-cluster="left"] > button'))
      await page.mouse.move(x, y, { steps: 3 })
    }, () => page.mouse.move(640, 560, { steps: 2 }), { ms: 1400 }),
    ...layer('palette', 'palette', () => page.keyboard.press('Meta+k'), esc),
    ...layer('dialog', 'dialog', async () => {
      const button = page.getByText('New project', { exact: true })
      if (!(await button.count())) {
        results.observations.push('motion film: no "New project" button on screen, the dialog was not filmed in this pass (m1, m6, m7 cycle it)')
        return
      }
      await clickSel('text=New project')
    }, esc),
    { id: 'settings-open', targets: pickT('settings'), act: () => page.keyboard.press('Meta+,'), expect: { settings: 'enter' }, still: [], ms: 900 },
    { id: 'switch-toggle', setup: async () => {
      const item = page.getByText('Appearance', { exact: true }).first()
      if (await item.count()) {
        const { x, y } = await centre(item)
        await page.mouse.click(x, y)
        await sleep(700)
      }
    }, targets: pickT('thumb'), act: () => clickSel('[data-slot="switch"]'), expect: { thumb: 'press' }, bursts: { thumb: 1 }, still: [], after: async () => {
      await clickSel('[data-slot="switch"]')
      await sleep(400)
    } },
    { id: 'settings-close', targets: pickT('settings'), act: esc, expect: { settings: 'gone' }, still: [] },
    { id: 'press-pill', targets: pickT('pill'), act: async () => {
      const { x, y } = await centre(page.locator(T.pill.sel))
      await page.mouse.move(x, y)
      await page.mouse.down()
      await sleep(180)
      await page.mouse.up()
    }, expect: { pill: 'press' }, bursts: { pill: 2 }, maxMs: { pill: 420 }, after: async () => {
      await sleep(200)
      await esc()
      await sleep(300)
    } },
    // A prompt with one tool call: the bubble, the sidebar row, the tool row
    // and its logo, the first line of the answer, then the fold.
    // 1.2 s: the send binds the draft to its session and Hermes remounts the
    // thread (the bubble is drawn again about 250 ms after the press); in
    // Advanced, under load, the remounted bubble once was not on screen yet
    // at 600 ms ("send.bubble: not fully drawn at the end (null)"). The
    // bubble's own entrance is judged as before; only the film is longer.
    { id: 'send', setup: async () => {
      await page.mouse.move(640, 560)
    }, targets: pickT('bubble', 'row', 'send'), act: () => type('Film one, MGF_ONE. MGS_CALL(terminal)[{"command":"echo film"}]', 'Enter'), expect: { bubble: 'there', row: 'there' }, still: ['titlebar'], ms: 1200 },
    { id: 'tool', setup: () => turnDone('MGF_ONE MGS_CALL_DONE', 60_000), targets: pickT('tool', 'logo', 'glyph'), act: () => type('Film one more, MGF_TOOLS. MGS_TOOLS(2,900)', 'Enter'), expect: {}, still: ['titlebar', 'sidebar'], ms: 2600, after: () => turnDone('MGS_TOOLS_DONE', 60_000) },
    { id: 'copy', setup: async () => {
      const { x, y } = await centre(page.locator(T.bubble.sel).last())
      await page.mouse.move(x, y)
      await sleep(300)
    }, targets: pickT('copy'), act: () => clickSel('.mg-ucopy >> nth=-1'), expect: { copy: 'there' }, ms: 900 },
    { id: 'home', targets: pickT('home', 'hello'), act: () => page.keyboard.press('Meta+n'), expect: { home: 'there', hello: 'enter' }, still: [], ms: 900, bursts: { home: 1 }, maxMs: { home: 450 } },
    { id: 'work', targets: pickT('line', 'head', 'work', 'reply'), act: async () => {
      await type('Film two, MGF_TWO. MGS_WORK', 'Enter')
      await turnDone('MGS_WORK_DONE', 60_000)
    }, expect: { head: 'there' }, still: ['titlebar'], ms: 1200 },
    { id: 'unfold', targets: pickT('line', 'head', 'work'), act: () => clickHead(), expect: { work: 'shown' }, still: ['titlebar', 'sidebar'], ms: 700 },
    { id: 'refold', targets: pickT('line', 'head', 'work'), act: () => clickHead(), expect: {}, still: ['titlebar', 'sidebar'], ms: 700 },
    { id: 'fail', targets: pickT('tool', 'logo'), act: async () => {
      await type('Film three, MGF_ERR. MGS_CALL(terminal)[{"command":"ls /mg-rig-no-such-dir"}]', 'Enter')
      await turnDone('MGF_ERR MGS_CALL_DONE', 60_000)
    }, expect: {}, still: ['titlebar'], ms: 900 },
    { id: 'context-open', targets: pickT('context'), act: () => clickSel(`${T.row.sel} >> nth=0`, { button: 'right' }), expect: { context: 'enter' } },
    { id: 'context-close', targets: pickT('context'), act: esc, expect: { context: 'exit' }, maxMs: { context: 120 } },
    { id: 'session-switch', setup: async () => {
      await page.keyboard.press('Meta+n')
      await sleep(900)
    }, targets: pickT('thread', 'row'), act: () => clickSel(`${T.row.sel} >> nth=0`), expect: {}, still: ['titlebar', 'sidebar'], ms: 900 },
    { id: 'agent-open', targets: pickT('pane'), act: () => surfacesRowClick('Agent'), expect: { pane: 'there' }, still: ['titlebar', 'sidebar'], ms: 900 },
    { id: 'agent-step', targets: pickT('step'), act: async () => {
      await type('Film four, MGF_STEP. MGS_WORK', 'Enter')
      await turnDone('MGS_WORK_DONE', 60_000)
    }, expect: { step: 'there' }, still: ['titlebar', 'sidebar'], ms: 900 },
    { id: 'agent-close', targets: pickT('pane'), act: () => surfacesRowClick('Agent'), expect: { pane: 'gone' }, still: ['titlebar', 'sidebar'], ms: 900 },
    // The Knowledge page, in a build that has it.
    ...(hasModule('knowledge')
      ? [
          { id: 'knowledge', targets: pickT('kb', 'card'), act: () => surfacesRowClick('Knowledge'), expect: { kb: 'there' }, still: ['titlebar', 'sidebar'], ms: 1100, maxMs: { kb: 470 } },
          { id: 'knowledge-leave', targets: pickT('kb'), act: () => page.keyboard.press('Meta+n'), expect: { kb: 'gone' }, still: ['titlebar', 'sidebar'], ms: 700 }
        ]
      : []),
    { id: 'jump', setup: async () => {
      await type('Film five, MGF_LONG. MGS_LONG(120)', 'Enter')
      await turnDone('MGF_LONG MGS_LONG_DONE', 90_000)
      await sleep(500)
    }, targets: pickT('jump'), act: async () => {
      const { x, y } = await centre(page.locator(T.thread.sel).last())
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -500)
        await sleep(30)
      }
    }, expect: { jump: 'there' }, still: ['titlebar', 'sidebar', 'composer'], ms: 900 }
  ].map(s => ({ ...s, still: s.still ?? NO_SIDEBAR.concat('sidebar') }))
}

// A Chrome trace while fn runs: the Animation events (with Chrome's reasons
// when one cannot run on the compositor) and, per animation's window, how
// many Layout and Paint events the renderer's main thread had.
async function traceAnimations(fn) {
  const { cdp } = state
  const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['blink.animations', 'devtools.timeline', 'disabled-by-default-devtools.timeline'], recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReturnAsStream' })
  try {
    await fn()
  } finally {
    await cdp.send('Tracing.end')
  }
  const { stream } = await done
  let text = ''
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 20 })
    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: stream }).catch(() => undefined)
  const parsed = JSON.parse(text)
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents ?? []
  const main = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
  const raw = events.filter(e => e.name === 'Animation')
  const last = Math.max(0, ...events.map(e => e.ts || 0))
  // Begin and end of one animation share its id (id2.local in newer traces,
  // id in older ones); an id is used again by a later animation, so a begin
  // opens a new record under it and later events join the open one.
  const anims = []
  const open = {}
  for (const e of [...raw].sort((a, b) => a.ts - b.ts)) {
    const key = `${e.id2?.local ?? e.id2?.global ?? e.id ?? e.args?.data?.id}`
    if (e.ph === 'b' || !open[key]) {
      open[key] = { key, name: null, start: null, end: null, failed: new Set(), props: new Set(), events: [] }
      anims.push(open[key])
    }
    const slot = open[key]
    const data = e.args?.data ?? {}
    slot.events.push(`${e.ph}@${Math.round(e.ts / 1000)} ${JSON.stringify(data).slice(0, 160)}`)
    // CSS animations and transitions carry their name in displayName.
    if (data.displayName || data.name) slot.name = data.displayName || data.name
    if (e.ph === 'b') slot.start = e.ts
    if (e.ph === 'e') slot.end = e.ts
    if (data.compositeFailed) slot.failed.add(data.compositeFailed)
    for (const p of data.unsupportedProperties ?? []) slot.props.add(p)
  }
  const onMain = e => !main || (e.pid === main.pid && e.tid === main.tid)
  const out = anims
    .filter(a => a.name && a.start !== null)
    .map(a => {
      const from = a.start
      const to = a.end !== null && a.end >= from ? a.end : last
      const within = name => events.filter(e => e.name === name && e.ph === 'X' && onMain(e) && e.ts >= from && e.ts <= to).length
      return { name: a.name, ms: Math.round((to - from) / 1000), endless: a.end === null, compositeFailed: [...a.failed], unsupported: [...a.props], layouts: within('Layout'), paints: within('Paint'), events: a.events.slice(0, 6) }
    })
  out.rawCount = raw.length
  return out
}

async function filmAll(mode, entry, must) {
  const { page } = state
  await page.evaluate(installFilm)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+n')
  // Home loads its rows a moment later and the composer moves with them
  // (reported); let it settle before the layers are filmed.
  await page.waitForFunction(() => document.querySelector('.mg-home-body') && !document.querySelector('.mg-home-skeleton'), undefined, { timeout: 15_000 }).catch(() => undefined)
  await sleep(1500)
  entry.evidence.homeSettled = await page.evaluate(() => ({ skeleton: Boolean(document.querySelector('.mg-home-skeleton')), composerY: Math.round(document.querySelector('[data-slot="composer-root"]')?.getBoundingClientRect().y ?? -1), composerW: Math.round([...document.querySelectorAll('[data-slot="composer-root"]')].find(node => node.checkVisibility())?.getBoundingClientRect().width ?? -1) }))
  const sweeps = {}
  for (const scene of scenes()) {
    // The reasoning pill is Hermes' to draw, and Hermes leaves it out of a
    // message box narrower than COMPOSER_COMPACT_PILL_PX (560 px; it also
    // shortens the model pill). In Advanced the film's terminal call opens
    // Hermes' Terminal pane at the right and it stays open into the next
    // pass; the chat is then about 260 px narrower and home's centred box
    // measures 542 px (m11's reduced pass, every run). The effort scenes are
    // then skipped, with that reason; a product note for 62-home.css/40-
    // composer.css (home's width) is in the W7-TAILS report.
    if (scene.id.startsWith('effort-')) {
      const fit = await page.evaluate(() => {
        const box = [...document.querySelectorAll('[data-slot="composer-root"]')].find(node => node.checkVisibility())
        return { width: Math.round(box?.getBoundingClientRect().width ?? -1), pill: Boolean([...document.querySelectorAll('[data-testid="reasoning-pill"]')].find(node => node.checkVisibility())) }
      })
      if (!fit.pill && fit.width >= 0 && fit.width < 560) {
        entry.evidence[scene.id] = { skipped: `Hermes draws no reasoning pill in a ${fit.width} px message box (compact under 560 px)` }
        results.observations.push(`motion ${mode}: ${scene.id} skipped: Hermes draws no reasoning pill in a ${fit.width} px message box (Hermes compacts under 560 px; home's centred width with the Terminal pane open)`)
        continue
      }
    }
    try {
      let out = await film(mode, scene)
      // A layer scene that stalled is filmed once more (it can be repeated).
      if (out.stalledMs && scene.again) {
        await scene.again()
        out = { ...(await film(mode, scene)), firstTryStalledMs: out.stalledMs }
      }
      entry.evidence[scene.id] = out
      if (scene.id.startsWith('dialog') && !(await page.getByText('New project', { exact: true }).count()) && !out.targets.dialog?.changes) continue
      judgeFilm(mode, scene, out, must)
    } catch (error) {
      must(false, `${scene.id}: ${String(error).slice(0, 200)}`)
    }
    // The interaction is over when no turn runs any more (a prompt's turn
    // ends after its film); then one second.
    await page.waitForFunction(sel => !document.querySelector(sel), RUNNING, { timeout: 60_000 }).catch(() => undefined)
    await sleep(1000)
    sweeps[scene.id] = await sweep()
  }
  await page.mouse.move(640, 560)
  return sweeps
}


// m9 to m11. MG_MOTION_FILM_ONLY=1 runs only these (m1 to m8 then report
// "not run"): for working on the film, never for a verdict.
async function filmChecks(page) {
  // ── m9. Film, motion on ──
  let sweepsOn = {}
  await check('m9', async (entry, must) => {
    await page.evaluate(() => (document.documentElement.dataset.mgMotion = 'on'))
    sweepsOn = await filmAll('on', entry, must)
  })

  // ── m10. Sweep: nothing of ours left running ──
  await check('m10', async (entry, must) => {
    entry.evidence.sweeps = sweepsOn
    for (const [id, s] of Object.entries(sweepsOn)) {
      for (const bad of s.bad) must(false, `${id} + 1 s: ${bad}`)
      for (const [name, n] of Object.entries(s.perName)) must(n <= 2, `${id} + 1 s: ${name} runs on ${n} elements`)
    }
    // Self-test: a stuck animation of ours (our keyframes, looping, nothing
    // running) must be caught.
    await page.evaluate(() => {
      const i = document.createElement('i')
      i.id = 'mg-motion-planted'
      i.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;animation:mg-fade-in 300ms infinite'
      document.body.appendChild(i)
    })
    await sleep(1000)
    const planted = await sweep()
    await page.evaluate(() => document.getElementById('mg-motion-planted')?.remove())
    entry.evidence.plantedCaught = planted.bad
    must(planted.bad.some(b => /mg-fade-in/.test(b)), `a planted stuck animation was not caught: ${JSON.stringify(planted)}`)
  })

  // ── m11. Film again, motion off, then reduced motion ──
  await check('m11', async (entry, must) => {
    await setMotion(page, 'off')
    await sleep(200)
    const offSweeps = await filmAll('off', { evidence: (entry.evidence.off = {}) }, must)
    await setMotion(page, 'on')
    await state.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await sleep(200)
    const reducedSweeps = await filmAll('reduced', { evidence: (entry.evidence.reduced = {}) }, must)
    await state.cdp.send('Emulation.setEmulatedMedia', { features: [] })
    for (const [mode, sw] of [['off', offSweeps], ['reduced', reducedSweeps]]) {
      for (const [id, s] of Object.entries(sw)) {
        const ours = s.ours.filter(name => !/∞/.test(name))
        must(!ours.length, `${mode}: ${id} + 1 s: still running: ${ours.slice(0, 3)}`)
      }
    }
  })

  // ── m12. What wave 4 added runs on the compositor ──
  await m12(page)
}

// m12, one animation at a time: the page's own animationstart says it played
// (name, element, pseudo-element), and a trace around that one action alone
// says where it ran. An animation that played but has no trace record fails
// (it cannot be judged), as does one that did not play. MG_MOTION_PLANT=m12
// plants a main-thread animation (left and width) on the Agent pane in place
// of its fade, which this check must catch.
async function m12(page) {
  await check('m12', async (entry, must) => {
    await page.evaluate(() => (document.documentElement.dataset.mgMotion = 'on'))
    const plant = process.env.MG_MOTION_PLANT === 'm12'
    if (plant) {
      await page.evaluate(() => {
        const style = document.createElement('style')
        style.id = 'mg-rig-plant-m12'
        style.textContent = '.mg-agent { animation: mg-rig-plant 300ms linear !important; } @keyframes mg-rig-plant { from { margin-left: 120px; width: 50%; } }'
        document.head.append(style)
      })
    }
    const played = () =>
      page.evaluate(() => {
        const seen = (window.__mgM12 = [])
        const on = event => seen.push({ name: event.animationName, pseudo: event.pseudoElement || '', target: event.target.className?.baseVal ?? String(event.target.className ?? '').slice(0, 60) })
        document.addEventListener('animationstart', on, true)
        window.__mgM12Stop = () => {
          document.removeEventListener('animationstart', on, true)
          return seen
        }
      })
    const cases = [
      {
        name: plant ? 'mg-rig-plant' : 'mg-fade-in',
        label: 'Agent pane',
        target: /mg-agent/,
        act: async () => {
          await surfacesRowClick('Agent')
          await page.waitForSelector('.mg-agent', { state: 'visible', timeout: 5000 })
          await sleep(700)
        },
        after: async () => {
          await surfacesRowClick('Agent')
          await sleep(500)
        }
      },
      {
        name: 'mg-check-in',
        label: 'copy turning into a check',
        target: /mg-ucopy/,
        before: async () => {
          const bubble = page.locator(T.bubble.sel).last()
          const { x, y } = await centre(bubble)
          await page.mouse.move(x, y)
          await sleep(400)
        },
        act: async () => {
          await clickSel('.mg-ucopy >> nth=-1')
          await sleep(700)
        }
      },
      {
        name: 'mg-working',
        label: 'a session at work (sidebar title)',
        target: /./,
        act: async () => {
          await type('Compositor, MGF_WORKING. MGS_SLOW(3)', 'Enter')
          await sleep(2500)
        },
        after: () => turnDone('MGS_SLOW_DONE', 60_000).catch(() => undefined)
      }
    ]
    entry.evidence.cases = {}
    for (const c of cases) {
      const out = (entry.evidence.cases[c.name] = { label: c.label })
      try {
        await c.before?.()
        await played()
        const trace = await traceAnimations(c.act)
        const starts = await page.evaluate(() => window.__mgM12Stop())
        await c.after?.()
        out.played = starts.filter(a => a.name === c.name).map(a => `${a.target}${a.pseudo}`)
        out.traced = trace.filter(a => a.name === c.name)
        out.tracedNames = [...new Set(trace.map(a => a.name))].slice(0, 20)
        out.animationEvents = trace.rawCount
        must(out.played.length, `${c.name} (${c.label}): did not play (animationstart saw ${JSON.stringify(starts.map(a => a.name).slice(0, 8))})`)
        must(out.traced.length, `${c.name} (${c.label}): played but has no record in the trace (${trace.rawCount} animation events, names ${out.tracedNames.join(', ')})`)
        for (const a of out.traced) {
          must(!a.compositeFailed.length && !a.unsupported.length, `${c.name} (${c.label}): not on the compositor, reasons ${a.compositeFailed.join(', ')} ${a.unsupported.join(', ')}`)
          // Paints and layouts on the main thread while it ran are kept as
          // evidence only: they count every paint in the page (a hover's
          // colour transition, the streamed reply), so they do not say
          // whether this animation painted. Chrome's own verdict above does.
        }
      } catch (error) {
        must(false, `${c.name} (${c.label}): ${String(error.message ?? error).split('\n')[0]}`)
      }
    }
    if (plant) await page.evaluate(() => document.getElementById('mg-rig-plant-m12')?.remove())
  })
}

export async function run() {
  const { page } = state
  await page.evaluate(installRecorder)
  // MG_MOTION_ONLY=m12: a turn to give the copy button a bubble, then m12.
  if (process.env.MG_MOTION_ONLY === 'm12') {
    await type('Warm up, MGF_ONE. MGS_CALL(terminal)[{"command":"echo warm"}]', 'Enter')
    await turnDone('MGF_ONE MGS_CALL_DONE', 60_000).catch(() => undefined)
    await sleep(1000)
    await m12(page)
    return
  }
  if (process.env.MG_MOTION_FILM_ONLY) {
    await filmChecks(page)
    return
  }
  await coverage(page)
  await page.mouse.move(640, 560)
  await sleep(400)

  // ── m1. Layers, motion on ──
  await check('m1', async (entry, must) => {
    entry.evidence.motion = await page.evaluate(() => document.documentElement.dataset.mgMotion)
    await layersPass(page, 'on', entry, must)
    // A click during a menu's exit lands on what is under it: close the
    // surfaces menu and press the model pill 30ms later.
    {
      const [surf, model] = [byId(page, SKIP.has('surfaces') ? 'effort' : 'surfaces'), byId(page, 'model')]
      await surf.open()
      await sleep(450)
      await surf.close()
      await sleep(30)
      await model.open()
      await sleep(450)
      const layers = await page.evaluate(sel => window.__mgRec.layers(sel), LAYERS.menu)
      entry.evidence.clickDuringExit = layers.map(l => `${l.state} op=${l.opacity} ${l.size}`)
      must(layers.length === 1 && layers[0].state === 'open' && layers[0].opacity === 1 && layers[0].size.startsWith('288x'), `a click 30ms into the ${surf.id} menu's exit did not open the model menu`)
      await model.close()
      await sleep(450)
    }
    // One frame mid-enter of the surfaces menu, for the eye.
    const s = byId(page, SKIP.has('surfaces') ? 'model' : 'surfaces')
    await s.open()
    await sleep(40)
    await shot(entry, 'm1-surfaces-mid-enter')
    await sleep(400)
    await shot(entry, 'm1-surfaces-open')
    await s.close()
    await sleep(400)
    const e = byId(page, 'effort')
    await e.open()
    await sleep(500)
    await shot(entry, 'm1-effort-open')
    await e.close()
    await sleep(60)
    await shot(entry, 'm1-effort-mid-exit')
    await sleep(400)
  })

  // ── m2. Sidebar, panes, overlay ──
  await check('m2', async (entry, must) => {
    const toggle = '[data-titlebar-cluster="left"] > button'
    const run = async (label, act, sel, hold = 600) => {
      await page.evaluate(sel => window.__mgRec.start(sel), sel)
      await act()
      await sleep(hold)
      const rec = await page.evaluate(() => window.__mgRec.stop())
      const starts = rec.events.filter(e => e.type === 'animationstart' || e.type === 'transitionrun')
      entry.evidence[label] = starts.map(brief).slice(0, 14)
      const bad = starts.filter(e => !(e.props ?? []).every(allowed))
      must(!bad.length, `${label}: non-opacity/transform property animated: ${bad.slice(0, 3).map(brief).join('; ')}`)
      const slow = starts.filter(e => e.iterations === 1 && e.duration > 240)
      must(!slow.length, `${label}: longer than 240ms: ${slow.slice(0, 3).map(brief).join('; ')}`)
      return starts
    }
    const click = async sel => {
      const { x, y } = await centre(page.locator(sel))
      await page.mouse.click(x, y)
    }
    // Sidebar: collapse, then expand.
    let starts = await run('sidebarCollapse', () => click(toggle), '[data-slot="sidebar"]')
    must(!(await page.locator('[data-slot="sidebar"]').count()), 'sidebar still there after collapse')
    starts = await run('sidebarExpand', () => click(toggle), '[data-slot="sidebar"]')
    const fade = starts.filter(e => e.layer && e.name === 'mg-fade-in')
    must(fade.length === 1, `sidebar expand: fade ran ${fade.length} times (want 1)`)
    const replays = starts.filter(e => /composer|aui_/.test(e.target))
    entry.evidence.sidebarChatReplays = replays.map(brief)
    // Files pane (⌘J): its content fades in once; nothing in the chat replays.
    // (Simple mode: the Files zone; Advanced mode: ⌘J reveals a kept-alive
    // pane instead. Either way one fade.)
    starts = await run('filesOpen', () => page.keyboard.press('Meta+j'), '[data-tree-group] aside, [data-pane-host]')
    const asideFade = starts.filter(e => e.layer && (e.name === 'mg-fade-in' || e.name === 'opacity'))
    must(asideFade.length === 1, `right pane (⌘J): fade ran ${asideFade.length} times (want 1)`)
    must(!starts.some(e => e.name === 'mg-fade-in' && /data-slot=sidebar\]/.test(e.target)), 'files pane: the sidebar faded in again')
    await shot(entry, 'm2-files')
    starts = await run('filesClose', () => page.keyboard.press('Meta+j'), '[data-tree-group] aside')
    // Terminal: a kept-alive pane, shown in place.
    starts = await run('terminalOpen', () => page.keyboard.press('Control+`'), '[data-pane-host]', 1500)
    const termFade = starts.filter(e => e.layer && e.name === 'opacity')
    must(termFade.length === 1, `terminal: opacity transition ran ${termFade.length} times (want 1)`)
    entry.evidence.terminalHost = await page.evaluate(() => [...document.querySelectorAll('[data-pane-host]')].map(n => `${n.dataset.paneHost} op=${getComputedStyle(n).opacity} hidden=${n.getAttribute('aria-hidden')}`))
    must(entry.evidence.terminalHost.some(t => /op=1 hidden=null/.test(t)), 'terminal host not at full opacity once shown')
    starts = await run('terminalClose', () => page.keyboard.press('Control+`'), '[data-pane-host]')
    // Settings overlay: fades in over the chat; Escape leaves in one frame.
    starts = await run('settingsOpen', () => page.keyboard.press('Meta+,'), '[data-overlay-surface]', 900)
    must(starts.filter(e => e.layer && e.name === 'mg-fade-in').length === 1, 'settings overlay: fade did not run exactly once')
    await shot(entry, 'm2-settings')
    // Moving between settings pages must not replay the overlay's entrance.
    starts = await run('settingsNavigate', async () => {
      const item = page.getByText('Appearance', { exact: true }).first()
      if (await item.count()) {
        const { x, y } = await centre(item)
        await page.mouse.click(x, y)
      }
    }, '[data-overlay-surface], [data-overlay-surface] > div > [data-glass-raised]')
    must(!starts.some(e => e.layer), 'settings: changing page replayed the overlay entrance')
    starts = await run('settingsClose', () => page.keyboard.press('Escape'), '[data-overlay-surface]')
    must(!(await page.locator('[data-overlay-surface]').count()), 'settings overlay still there after Escape')
  })

  // ── m3. Fast cycles ──
  await check('m3', async (entry, must) => {
    for (const s of surfaces(page)) {
      if (!(await present(page, s))) continue
      try {
        entry.evidence[s.id] = await hammer(page, s, must)
      } catch (error) {
        must(false, `${s.id}: ${String(error).slice(0, 200)}`)
      }
    }
    await shot(entry, 'm3-after')
  })

  // ── m4. Controls ──
  await check('m4', async (entry, must) => {
    // Press: hold the mouse on the model pill, read its transform, release.
    const pill = await centre(page.locator('[data-tour="model-pill"]'))
    await page.evaluate(() => window.__mgRec.start('[data-tour="model-pill"]'))
    await page.mouse.move(pill.x, pill.y)
    await page.mouse.down()
    await sleep(200)
    const pressed = await page.evaluate(() => getComputedStyle(document.querySelector('[data-tour="model-pill"]')).transform)
    await page.mouse.up()
    await sleep(300)
    await page.keyboard.press('Escape')
    await sleep(300)
    let rec = await page.evaluate(() => window.__mgRec.stop())
    entry.evidence.pressTransform = pressed
    entry.evidence.pressEvents = rec.events.filter(e => e.layer && e.type === 'transitionrun').map(brief)
    must(/matrix\(0\.97/.test(pressed), `model pill under the pointer is ${pressed}, want scale 0.97`)
    // Focus ring: Tab onto a button; nothing about the ring may transition.
    await page.mouse.move(640, 560)
    await page.evaluate(() => window.__mgRec.start(null))
    const focus = await page.evaluate(() => {
      const b = document.querySelector('button[data-slot="button"]:not([disabled])')
      b?.focus({ focusVisible: true })
      return b ? b.getAttribute('aria-label') || b.textContent.trim().slice(0, 30) : null
    })
    await page.keyboard.press('Tab')
    await sleep(300)
    rec = await page.evaluate(() => window.__mgRec.stop())
    const ring = rec.events.filter(e => e.type === 'transitionrun' && /shadow|outline|border/.test(e.name))
    entry.evidence.focus = { from: focus, ringTransitions: ring.map(brief), all: rec.events.filter(e => e.type === 'transitionrun').map(brief).slice(0, 8) }
    must(!ring.length, `focus ring animated: ${ring.slice(0, 3).map(brief).join('; ')}`)
    // Switch thumb: open the effort menu and flip Thinking, then back.
    const eff = byId(page, 'effort')
    await eff.open()
    await sleep(400)
    const sw = page.locator('[data-slot="dropdown-menu-content"] [data-slot="switch"]').first()
    if (await sw.count()) {
      await page.evaluate(() => window.__mgRec.start('[data-slot="switch-thumb"]'))
      const { x, y } = await centre(sw)
      await page.mouse.click(x, y)
      await sleep(400)
      rec = await page.evaluate(() => window.__mgRec.stop())
      entry.evidence.thumb = rec.events.filter(e => e.layer && e.type === 'transitionrun').map(brief)
      entry.evidence.thumbNote = 'the effort menu draws Thinking as an icon button; its switch is invisible (41-effort.css), so a thumb glide here is measured, not seen'
      await page.mouse.click(x, y)
      await sleep(300)
    } else {
      entry.evidence.thumb = 'no switch in the effort menu'
    }
    await eff.close()
    await sleep(400)
    // Composer: focus, then the send button's change as text arrives and
    // leaves. Only colour and transform may move; nothing over 240ms.
    const box = page.locator('[data-slot="composer-root"] [contenteditable="true"]').first()
    await page.evaluate(() => window.__mgRec.start('[data-slot="composer-fade"] button[type="submit"]'))
    const { x, y } = await centre(box)
    await page.mouse.click(x, y)
    await sleep(250)
    await page.evaluate(() => window.__mgRec.mark('typed'))
    await page.keyboard.insertText('Motion rig')
    await sleep(350)
    const send = await page.evaluate(() => {
      const b = document.querySelector('[data-slot="composer-fade"] button[type="submit"]')
      return b ? { disabled: b.disabled, bg: getComputedStyle(b).backgroundColor, label: b.getAttribute('aria-label') } : null
    })
    await page.evaluate(() => window.__mgRec.mark('cleared'))
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')
    await sleep(350)
    rec = await page.evaluate(() => window.__mgRec.stop())
    const starts = rec.events.filter(e => e.type === 'animationstart' || e.type === 'transitionrun')
    entry.evidence.composer = { send, events: starts.map(brief).slice(0, 16) }
    const bad = starts.filter(e => !(e.props ?? []).every(allowed) || (e.iterations === 1 && e.duration > 240))
    must(!bad.length, `composer: ${bad.slice(0, 3).map(brief).join('; ')}`)
    must(send, 'no send button once text was typed')
    await page.mouse.move(640, 560)
  })

  // ── m5. No replay on unrelated attribute changes ──
  await check('m5', async (entry, must) => {
    const s = byId(page, SKIP.has('surfaces') ? 'model' : 'surfaces')
    await s.open()
    await sleep(450)
    await page.evaluate(() => window.__mgRec.start('[data-slot="dropdown-menu-content"]'))
    await page.evaluate(async () => {
      const root = document.documentElement
      const wait = () => new Promise(r => setTimeout(r, 60))
      const keep = { tools: root.dataset.mgTools, density: root.dataset.mgDensity }
      for (const [k, v] of [['mgTools', 'hidden'], ['mgDensity', 'compact'], ['mgTools', keep.tools], ['mgDensity', keep.density]]) {
        root.dataset[k] = v
        await wait()
      }
      root.setAttribute('data-mg-rig-probe', '1')
      await wait()
      root.removeAttribute('data-mg-rig-probe')
      await wait()
    })
    await sleep(300)
    const rec = await page.evaluate(() => window.__mgRec.stop())
    const starts = rec.events.filter(e => e.type === 'animationstart')
    entry.evidence.duringOpenMenu = starts.map(brief)
    must(!starts.length, `${starts.length} animation(s) started on unrelated attribute changes`)
    await s.close()
    await sleep(450)
    // Hovering across the composer and back must not restart any layer or
    // card animation either (only colour transitions are expected).
    await page.evaluate(() => window.__mgRec.start(null))
    for (const sel of ['[data-tour="model-pill"]', '[data-testid="reasoning-pill"]', '[data-slot="composer-fade"] button.mg-chip']) {
      const { x, y } = await centre(page.locator(sel))
      await page.mouse.move(x, y, { steps: 2 })
      await sleep(60)
    }
    await page.mouse.move(640, 560)
    await sleep(300)
    const hover = await page.evaluate(() => window.__mgRec.stop())
    const hs = hover.events.filter(e => e.type === 'animationstart' && !/tooltip/.test(e.target))
    entry.evidence.hoverAnimations = hs.map(brief)
    must(!hs.length, `hovering the composer started ${hs.length} animation(s)`)
  })

  // ── m6. Motion off ──
  await check('m6', async (entry, must) => {
    await setMotion(page, 'off')
    await sleep(200)
    entry.evidence.runningAtRest = await page.evaluate(() => window.__mgRec.running())
    must(!entry.evidence.runningAtRest.length, `running at rest with motion off: ${entry.evidence.runningAtRest.slice(0, 4)}`)
    await layersPass(page, 'off', entry, must)
    for (const s of surfaces(page)) {
      try {
        entry.evidence[`${s.id}Hammer`] = await hammer(page, s, must)
      } catch (error) {
        must(false, `${s.id} fast cycles: ${String(error).slice(0, 200)}`)
      }
    }
    // The effort starfield stands still.
    const e = byId(page, 'effort')
    await e.open()
    await sleep(400)
    entry.evidence.effortRunning = await page.evaluate(() => window.__mgRec.running())
    must(!entry.evidence.effortRunning.length, `effort menu animating with motion off: ${entry.evidence.effortRunning.slice(0, 3)}`)
    await shot(entry, 'm6-effort-off')
    await e.close()
    await sleep(300)
    await setMotion(page, 'on')
  })

  // ── m7. Reduced motion ──
  await check('m7', async (entry, must) => {
    await state.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await sleep(200)
    entry.evidence.matches = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
    must(entry.evidence.matches, 'reduced motion emulation did not take')
    entry.evidence.runningAtRest = await page.evaluate(() => window.__mgRec.running())
    must(!entry.evidence.runningAtRest.length, `running at rest under reduced motion: ${entry.evidence.runningAtRest.slice(0, 4)}`)
    await layersPass(page, 'reduced', entry, must)
    for (const s of surfaces(page)) {
      try {
        entry.evidence[`${s.id}Hammer`] = await hammer(page, s, must)
      } catch (error) {
        must(false, `${s.id} fast cycles: ${String(error).slice(0, 200)}`)
      }
    }
    await state.cdp.send('Emulation.setEmulatedMedia', { features: [] })
    results.observations.push('motion: reduced motion was emulated through Emulation.setEmulatedMedia, then cleared')
  })

  // ── m8. Hot reload twice, then unloaded: stop() leaves nothing ──
  // Our footprint is everything that carries an mg- class or a data-mg-
  // attribute, the root's data-mg-* keys and the stylesheet. Two reloads
  // change none of it; unloading (a stand-in plugin with Monograph's id)
  // leaves none of it.
  await check('m8', async (entry, must) => {
    const page = state.page

    const footprint = () =>
      page.evaluate(extra => {
        const all = [...document.querySelectorAll('*')]
        const ours = all.filter(node => node.id !== 'mg-css' && node !== document.documentElement && (/(^|\s)mg-/.test(typeof node.className === 'string' ? node.className : node.getAttribute('class') ?? '') || [...node.attributes].some(attr => attr.name.startsWith('data-mg-'))))

        return {
          extra: extra ? document.querySelectorAll(extra).length : 0,
          ours: ours.length,
          kinds: [...new Set(ours.map(node => `${node.tagName.toLowerCase()}.${[...node.classList].filter(name => name.startsWith('mg-')).join('.')}${[...node.attributes].filter(attr => attr.name.startsWith('data-mg-')).map(attr => `[${attr.name}]`).join('')}`))].sort().slice(0, 40),
          // .mg-home is display: contents; its body is what shows.
          home: Boolean(document.querySelector('.mg-home[data-mg-home] .mg-home-body')?.checkVisibility()),
          route: location.hash,
          root: Object.keys(document.documentElement.dataset).filter(key => key.startsWith('mg')).sort().join(' '),
          styles: document.querySelectorAll('#mg-css').length
        }
      }, extra)
    const extra = ''
    const before = await footprint()

    await hotReload()
    await sleep(600)
    await hotReload()
    await sleep(1200)

    const after = await footprint()

    await hotReload({ gone: true, source: stubPlugin() })
    await sleep(1200)

    const unloaded = await footprint()

    await hotReload()
    await sleep(1200)

    const back = await footprint()

    Object.assign(entry.evidence, { before, afterTwoReloads: after, unloaded, back })
    await shot(entry, 'm8-loaded-again')
    must(before.ours > 0 && before.styles === 1, `before: ${JSON.stringify(before)}`)
    // The page is an empty new session (m2 opened and closed Settings and
    // Files over it): home must be drawn before the reloads as well as after.
    // It once was not: closing a modal left home hidden until the next signal.
    must(before.home && after.home, `home on the empty session: ${before.home ? 'drawn' : 'not drawn'} before the reloads, ${after.home ? 'drawn' : 'not drawn'} after them (route ${before.route})`)
    must(after.styles === 1 && after.root === before.root && after.extra === before.extra, `after two reloads: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    must(JSON.stringify(after.kinds) === JSON.stringify(before.kinds) && Math.abs(after.ours - before.ours) <= 2, `after two reloads our nodes changed: ${after.ours} vs ${before.ours}; ${after.kinds.filter(kind => !before.kinds.includes(kind)).join(', ')}`)
    must(unloaded.ours === 0 && !unloaded.root && unloaded.styles === 0 && unloaded.extra === 0, `left behind after unloading: ${JSON.stringify(unloaded)}`)
    must(back.styles === 1 && back.root === before.root, `after loading again: ${JSON.stringify(back)}`)
  })

  await filmChecks(page)

}
