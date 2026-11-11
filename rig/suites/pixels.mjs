// Pixels: the app in a fixed list of states, each one screenshot, compared
// pixel by pixel with a reference set. A change that is meant to cost nothing
// on screen (a faster selector, a state attribute instead of a :has()) must
// leave every one of these images exactly as it was.
//
//   MG_PIXELS=record   write the reference set (do this on the build to
//                      compare against, before the change)
//   (unset)            compare with the reference set; a state with no
//                      reference yet is recorded and says so
//
// References live beside the run folders: <MG_RIG_OUT>/pixels-ref/<mode>/,
// one set per interface mode. Screenshots are taken with animations stopped
// (finite ones at their end, endless ones at their start), the caret hidden,
// the pointer parked where it hovers nothing (except where a state is about
// what is under it), and every clock or elapsed-time text masked with a flat
// box. A diff is written as <state>-diff.png next to the shot: differing
// pixels red, the rest dimmed.
//
// The model is the stress suite's (startModel), with the battery's extra
// model ids so the model menu has logo rows.
//
// p23 is geometry, not pixels: the sidebar's own tab row (Sessions, Bots)
// and the corner row (sidebar toggle, mark, "Hermes") must never overlap, at
// any sidebar width and zoom, and the unread badge on the toggle is gray.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { EVIDENCE, HERMES_REPO, MODE, ON_SCREEN_VIEWPORT, check, hasModule, hotReload, results, setWindow, sleep, state, stubPlugin, turnDone, type, waitForAppReady } from '../harness.mjs'
import { startModel } from './stress.mjs'

export const limitS = 900

export const model = () => startModel({ extraModels: ['claude-sonnet-4-5', 'gpt-5', 'deepseek-chat'] })

export const checks = [
  ['p01', 'Empty new session'],
  ['p02', 'A finished thread, tool calls shown, folded'],
  ['p03', 'The same thread with its fold opened'],
  ['p04', 'The same thread with tool calls hidden'],
  ['p05', 'Surfaces menu open'],
  ['p06', 'Model menu open'],
  ['p07', 'Effort menu open'],
  ['p08', 'Approval menu open'],
  ['p09', 'Command palette open'],
  ['p10', 'Sidebar collapsed'],
  ['p11', 'Sidebar swapped to the right'],
  ['p12', 'Settings open'],
  ['p13', 'Narrow window, 800 px'],
  ['p14', 'Wide window, 1800 px'],
  ['p15', 'Zoom 1.25'],
  ['p16', 'Zoom 0.9'],
  ['p17', 'A reply held mid-stream (running)'],
  ['p18', 'Back to an empty session from a thread'],
  ['p19', 'Back to the thread by the sidebar'],
  ['p20', 'Bots tab of the sidebar'],
  ['p21', 'Sidebar dragged narrow'],
  ['p22', 'Unread badge on the sidebar toggle'],
  ['p23', 'Geometry: the sidebar tab row and the corner row never overlap; the badge is gray'],
  ['p24', 'State attributes follow the page frame by frame: menus by keyboard and pointer, session switch, hot reload, unload'],
  ['p25', 'Home page'],
  ['p26', 'Knowledge page'],
  ['p27', 'Agent panel open beside the thread'],
  ['p28', 'Settings > Plugins > Monograph (Appearance)']
  // p26 is the Knowledge page's, in a build that has it.
].filter(([id]) => id !== 'p26' || hasModule('knowledge'))

// ── Reference set and comparison ────────────────────────────────────────────
const RECORD = process.env.MG_PIXELS === 'record'
const REF = path.join(path.dirname(EVIDENCE), 'pixels-ref', MODE)
const { PNG } = createRequire(path.join(HERMES_REPO, 'package.json'))('pngjs')

fs.mkdirSync(REF, { recursive: true })

const PARK = { x: 1, y: 420 }

// Text that changes with the clock: times of day, "now", "3m", timers. The
// boxes of those words alone (text ranges, not their elements) are masked, in
// CSS px; the mask is painted into the saved image and, when comparing, the
// masks of both images are painted into both.
const clockRects = () =>
  state.page.evaluate(() => {
    // A month and year ("November 2026", the knowledge page's date groups)
    // changes with the calendar.
    const CLOCK = /^((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{4}|now|just now|\d+\s?(s|m|h|d|w|mo|y|min|mins|sec|secs|hr|hrs)( ago)?|\d{1,2}:\d{2}(:\d{2})?(\s?[AP]M)?|(yesterday|today)\b.*|\d+(\.\d+)?s|\d+m \d+s)$/i
    const rects = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim()

      // The agent panel's "Worked for 5s" is one text node: the whole line goes.
      if (!text || text.length > 24 || !(CLOCK.test(text) || /^Worked for \d/.test(text)) || !node.parentElement?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        continue
      }

      const range = document.createRange()

      range.selectNodeContents(node)

      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) {
          rects.push({ x: r.x - 2, y: r.y - 2, w: r.width + 4, h: r.height + 4 })
        }
      }
    }

    // A turn's duration line, whole: "⏱ 3s" is two text nodes, and the
    // stopwatch is a colour emoji Hermes draws through a grayscale filter;
    // its raster differed between runs (p02/p03, 145 px in its 14x14 box at
    // x 394), so it goes with the time it belongs to.
    for (const line of document.querySelectorAll('[data-slot="aui_turn-duration"]')) {
      const r = line.getBoundingClientRect()

      if (line.checkVisibility() && r.width > 0) {
        rects.push({ x: r.x - 2, y: r.y - 2, w: r.width + 4, h: r.height + 4 })
      }
    }

    // Hermes picks the empty message box's placeholder at random.
    for (const box of document.querySelectorAll('[data-slot="composer-rich-input"]')) {
      const r = box.getBoundingClientRect()

      if (box.checkVisibility() && !(box.textContent ?? '').trim() && r.width > 0) {
        rects.push({ x: r.x, y: r.y, w: Math.min(r.width, 360), h: r.height })
      }
    }

    // The Bots pane's faces are animated by Hermes' own clock (15 fps).
    for (const face of document.querySelectorAll('[data-bot-face]')) {
      const r = face.getBoundingClientRect()

      if (face.checkVisibility() && r.width > 0) {
        rects.push({ x: r.x - 1, y: r.y - 1, w: r.width + 2, h: r.height + 2 })
      }
    }

    // Image px per CSS px. Under Electron's zoom factor the shot is
    // innerWidth x innerHeight image px with the page drawn at the zoom, so
    // devicePixelRatio, not the image width, is the scale.
    return { rects, scale: devicePixelRatio }
  })

// "Worked for 7s" is the time a turn took, and it varies by a second between
// runs. The plugin writes it from the row's data-mg-worked into the line, an
// element of ours before the row (div.mg-line > .mg-line-worked). For the shot
// every non-empty value reads "9s" (same glyph count as most), in the row's
// mark (so a re-render of the line says 9s too) and in the line's text; the
// real values are put back right after. The turn observers neither watch
// this attribute nor wake for text inside a line (plugin.js), so nothing
// reacts to the swap.
const pinWorked = () =>
  state.page.evaluate(() => {
    for (const row of document.querySelectorAll('[data-mg-worked]')) {
      // Pinned again before every shot: the plugin may rewrite the value
      // (a turn settling) after an earlier pin.
      if (row.dataset.mgWorked && row.dataset.mgWorked !== '9s') {
        row.dataset.rigWorked = row.dataset.mgWorked
        row.dataset.mgWorked = '9s'
      }
    }

    for (const text of document.querySelectorAll('.mg-line > .mg-line-worked')) {
      if (/^Worked for /.test(text.textContent) && text.textContent !== 'Worked for 9s') {
        text.dataset.rigWorked = text.textContent
        text.textContent = 'Worked for 9s'
      }
    }
  })

const unpinWorked = () =>
  state.page.evaluate(() => {
    for (const row of document.querySelectorAll('[data-rig-worked]')) {
      if (row.classList.contains('mg-line-worked')) {
        if (row.textContent === 'Worked for 9s') {
          row.textContent = row.dataset.rigWorked
        }
      } else if (row.dataset.mgWorked === '9s') {
        row.dataset.mgWorked = row.dataset.rigWorked
      }

      delete row.dataset.rigWorked
    }
  })

// plugin.js places the corner row from outerWidth / innerWidth on `resize`;
// right after a resize or zoom the two can still disagree, and the row then
// sits a few px off until the next resize. After resizing, the suite fires
// one more `resize` once the window has settled, so a state is shot as a
// person would see it after a moment. (Reported as a bug in plugin.js.)
const settleWindow = async () => {
  await sleep(400)
  await state.page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(300)
}

function decode(file) {
  return PNG.sync.read(fs.readFileSync(file))
}

// Paints the masks (CSS px; `scale` image px per CSS px) into a decoded image.
function paintMasks(image, masks, scale) {
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x * scale))
    const y0 = Math.max(0, Math.floor(m.y * scale))
    const x1 = Math.min(image.width, Math.ceil((m.x + m.w) * scale))
    const y1 = Math.min(image.height, Math.ceil((m.y + m.h) * scale))

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * image.width + x) * 4

        image.data[i] = 255
        image.data[i + 1] = 0
        image.data[i + 2] = 255
        image.data[i + 3] = 255
      }
    }
  }

  return image
}

const masksOf = file => {
  try {
    return JSON.parse(fs.readFileSync(file.replace(/\.png$/, '.masks.json'), 'utf8'))
  } catch {
    return { rects: [], scale: 1 }
  }
}

// Exact comparison, with one allowance measured on the reference build
// against itself: the rounded corners of the home's composer and chips come
// out one colour level apart from run to run (10 to 13 pixels, never more
// than one level). So a pixel one level off is "faint" and counted apart; a
// state fails on any pixel more than one level off, or on more than
// FAINT_MAX faint ones (a real one-level change, such as the self-test's in
// p01, moves far more pixels than that).
const FAINT_MAX = 40

function compare(refFile, newFile, diffFile) {
  const refMasks = masksOf(refFile)
  const newMasks = masksOf(newFile)
  const a = paintMasks(paintMasks(decode(refFile), refMasks.rects, refMasks.scale), newMasks.rects, newMasks.scale)
  const b = paintMasks(paintMasks(decode(newFile), refMasks.rects, refMasks.scale), newMasks.rects, newMasks.scale)

  if (a.width !== b.width || a.height !== b.height) {
    return { size: `${a.width}x${a.height} -> ${b.width}x${b.height}`, pixels: a.width * a.height }
  }

  const out = new PNG({ height: a.height, width: a.width })
  let pixels = 0
  let faint = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1

  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]))

    if (delta === 1) {
      faint += 1
    }

    if (!delta) {
      out.data[i] = out.data[i + 1] = out.data[i + 2] = Math.round(b.data[i] * 0.25)
    } else {
      pixels += 1
      out.data[i] = 255
      out.data[i + 1] = 0
      out.data[i + 2] = 0

      const p = i / 4
      const x = p % a.width
      const y = Math.floor(p / a.width)

      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }

    out.data[i + 3] = 255
  }

  if (pixels) {
    fs.writeFileSync(diffFile, PNG.sync.write(out))
  }

  // Pixels that count: everything over one level, or every faint one too
  // once there are more of them than the noise allows.
  const counted = faint > FAINT_MAX ? pixels : pixels - faint

  return { pixels: counted, faint, box: pixels ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, scale: a.width }
}

// Waits (up to 4 s) until no finite animation or transition is running:
// Hermes' and Monograph's own (a fold opening, a menu fading in). Endless
// ones (spinners, shimmer) are left to the screenshot, which stops them.
const quiet = () =>
  state.page.evaluate(async () => {
    const began = performance.now()

    while (performance.now() - began < 4000) {
      const busy = document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)

      if (!busy.length) {
        return Math.round(performance.now() - began)
      }

      await new Promise(resolve => setTimeout(resolve, 50))
    }

    return 'still moving after 4 s'
  })

// The state's screenshot, then its verdict against the reference (or, with
// `against`, against another shot of this run).
async function snap(entry, must, name, { park = true, against = null } = {}) {
  const { page } = state

  if (park) {
    await page.mouse.move(PARK.x, PARK.y)
  }

  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // Hermes' scrollbars show for a moment after the thread scrolls or
  // resizes, then fade (not an animation the page lists). Long enough for
  // that to be over.
  await sleep(1600)
  entry.evidence.quietAfterMs = await quiet()
  await judgeState(entry, must)

  const file = path.join(EVIDENCE, 'shots', `${name}.png`)
  const ref = against ? path.join(EVIDENCE, 'shots', `${against}.png`) : path.join(REF, `${name}.png`)

  await pinWorked()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  // A state is shot once it holds still: two shots in a row, 300 ms apart,
  // the same in every unmasked pixel (something can still be settling, a
  // transition Hermes starts late, a box that eases into place).
  const masks = await clockRects()
  const take = async () => {
    await pinWorked()

    return paintMasks(PNG.sync.read(await page.screenshot({ animations: 'disabled', caret: 'hide' })), masks.rects, masks.scale)
  }
  let image = await take()
  let tries = 1

  for (; tries < 8; tries++) {
    await sleep(300)

    const again = await take()

    if (again.data.equals(image.data)) {
      break
    }

    image = again
  }

  entry.evidence.shotsUntilStill = tries
  await unpinWorked()

  fs.writeFileSync(file, PNG.sync.write(image))
  fs.writeFileSync(file.replace(/\.png$/, '.masks.json'), JSON.stringify(masks))
  entry.screenshots.push(file)
  entry.evidence.masked = masks.rects.length

  if (!against && (RECORD || !fs.existsSync(ref))) {
    fs.copyFileSync(file, ref)
    fs.copyFileSync(file.replace(/\.png$/, '.masks.json'), ref.replace(/\.png$/, '.masks.json'))
    entry.evidence.reference = RECORD ? `recorded ${ref}` : `no reference yet; recorded ${ref}`

    return
  }

  const diff = path.join(EVIDENCE, 'shots', `${name}-diff.png`)
  const result = compare(ref, file, diff)

  entry.evidence.reference = ref
  entry.evidence.diff = result

  if (result.pixels) {
    entry.screenshots.push(diff)
  }

  must(!result.pixels, `${result.pixels} pixel(s) differ from the reference (${result.faint} of them by one level)${result.size ? ` (size ${result.size})` : ''}${result.box ? ` in ${JSON.stringify(result.box)} (image ${result.scale} px wide)` : ''}`)
}

// ── State attributes and rewritten selectors ───────────────────────────────
// src/modules/05-state.js writes attributes on <html> in place of
// document-wide :root:has() rules. In every state the suite visits, each
// attribute must say exactly what the :has() it replaced would have said,
// asked of the same document now. Without the module (the reference build)
// this is recorded as not applicable.
export const STATE_TRUTH = `(() => {
  const q = selector => document.querySelector(selector)
  return {
    'data-mg-surfaces': q('button[data-tour="mg-surfaces"]') ? 'on' : null,
    // Only a new draft (#/) is the empty layout (05-state.js, home h18): a
    // route naming a session renders its thread empty for a frame or two.
    'data-mg-empty-chat': ['', '#', '#/'].includes(location.hash.split('?')[0]) && q('[data-slot="aui_thread-viewport"]') && !q('[data-slot="aui_thread-content"] :is([data-role="user"], [data-role="assistant"], [data-role="system"])') ? '' : null,
    'data-mg-menu': q('[data-slot="composer-fade"] button:is([data-tour="model-pill"], [aria-label^="Model · "])[aria-expanded="true"]') ? 'model' : null
  }
})()`

// Selectors rewritten to ask less of the page: in every state, each new one
// must pick out exactly the elements the old one did, among the elements
// that are drawn. One that only the old one picked and that is not drawn
// (no box, or not visible) is listed in the evidence and not counted.
export const SAME = [
  // 12-corner.css: the zone header (a div) holding a tab strip in the band.
  ['div:has(> [data-slot="context-menu-trigger"]:not(.absolute) > [role="tablist"])', 'div:where([data-panel-header]):has(> [data-slot="context-menu-trigger"]:not(.absolute) > [role="tablist"])'],
  // 14-surfaces.css: the titlebar cluster that holds the surfaces button.
  ['div:not([data-titlebar-cluster]):has(> button[data-tour="mg-surfaces"])', 'div:where(.fixed):not([data-titlebar-cluster]):has(> button[data-tour="mg-surfaces"])'],
  // 41-effort.css: the effort menu, open or closing.
  [
    ':is(:root:has([data-testid="reasoning-pill"][aria-expanded="true"]) [data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-content"].w-52.p-0[data-state="closed"]):has(> [data-slot="dropdown-menu-radio-group"])',
    '[data-slot="dropdown-menu-content"][data-slot].w-52.p-0:has(> [data-slot="dropdown-menu-radio-group"])'
  ]
]

async function judgeState(entry, must) {
  const expected = await state.page.evaluate(STATE_TRUTH)
  const seen = await state.page.evaluate(
    ({ expected, same }) => {
      const root = document.documentElement
      const module = (root.dataset.mgModules ?? '').split(' ').includes('state')
      const attributes = Object.fromEntries(Object.keys(expected).map(name => [name, root.getAttribute(name)]))
      const selectors = same.map(([before, after]) => {
        const a = new Set(document.querySelectorAll(before))
        const b = new Set(document.querySelectorAll(after))
        const drawn = node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && node.getBoundingClientRect().width * node.getBoundingClientRect().height > 0
        const all = [...[...a].filter(node => !b.has(node)), ...[...b].filter(node => !a.has(node))]
        const odd = all.filter(drawn)
        const name = node => `${node.tagName.toLowerCase()}[${[...node.attributes].filter(attr => attr.name !== 'style').map(attr => `${attr.name}=${attr.value.slice(0, 50)}`).join(' ')}] parent ${node.parentElement?.tagName.toLowerCase()}[${[...(node.parentElement?.attributes ?? [])].map(attr => attr.name).join(' ')}]`

        return { after: after.slice(0, 60), matched: a.size, differ: odd.length, odd: odd.slice(0, 2).map(name), undrawn: all.filter(node => !drawn(node)).slice(0, 2).map(name) }
      })

      return { attributes, expected, module, selectors }
    },
    { expected, same: SAME }
  )

  entry.evidence.state = seen.module ? seen.attributes : 'no state module in this build'
  entry.evidence.selectorsMatched = seen.selectors.map(row => row.matched).join(' ')

  if (seen.module) {
    for (const [name, value] of Object.entries(seen.expected)) {
      must(seen.attributes[name] === value, `${name} is ${JSON.stringify(seen.attributes[name])}, the page says ${JSON.stringify(value)}`)
    }
  }

  for (const row of seen.selectors) {
    if (row.undrawn.length) {
      entry.evidence.selectorUndrawn = row.undrawn
    }

    if (row.differ) {
      entry.evidence.selectorOdd = row.odd
    }

    must(!row.differ, `the rewritten selector ${row.after}… picks ${row.differ} element(s) the old one did not, or misses them`)
  }
}

// ── Getting the app into each state ─────────────────────────────────────────
const shown = selector => state.page.locator(selector).filter({ visible: true }).first()

async function press(selector) {
  const box = await shown(selector).boundingBox({ timeout: 5000 })

  if (!box) {
    throw new Error(`nothing on screen for ${selector}`)
  }

  await state.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const openMenu = () =>
  state.page.waitForFunction(() => [...document.querySelectorAll('[data-slot="dropdown-menu-content"], .mg-surfaces-menu')].some(node => node.checkVisibility() && node.getAttribute('data-state') !== 'closed'), undefined, { timeout: 4000 })

// Every menu, palette and dialog closed again, by Escape only when one is
// open (Escape with nothing open would stop a running turn).
async function closeAll() {
  const { page } = state

  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="dropdown-menu-content"], [data-slot="command-input"], .mg-surfaces-menu, [role="menu"]')].some(node => node.checkVisibility())
    )

    if (!open) {
      break
    }

    await page.keyboard.press('Escape')
    await sleep(350)
  }

  await sleep(300)
}

async function newSession() {
  const button = shown('button[aria-label="New session"]')

  if (await button.count()) {
    await button.click()
  } else {
    await state.page.keyboard.press('Meta+n')
  }

  await sleep(1000)
}

async function openRow(text) {
  await state.page.locator('[data-slot="row-button"]', { hasText: text }).filter({ visible: true }).first().click()
  await sleep(1200)
}

async function paletteRun(label) {
  const { page } = state

  await page.keyboard.press('Meta+k')
  await shown('[data-slot="command-input"]').waitFor({ timeout: 5000 })
  await page.keyboard.insertText(label)
  await sleep(400)

  for (let i = 0; i < 12; i++) {
    const on = await page.evaluate(() => [...document.querySelectorAll('[data-slot="command-item"][data-selected="true"], [cmdk-item][aria-selected="true"]')].find(node => node.checkVisibility())?.textContent?.trim() ?? '')

    if (on.startsWith(label)) {
      break
    }

    await page.keyboard.press('ArrowDown')
    await sleep(60)
  }

  await page.keyboard.press('Enter')
  await sleep(500)

  if (await shown('[data-slot="command-input"]').count()) {
    await page.keyboard.press('Escape')
    await sleep(300)
  }
}

// The sidebar zone: its outer box, and the sash on its right edge.
const sidebarBox = () =>
  state.page.evaluate(() => {
    const group = document.querySelector('[data-tour="sessions-sidebar"]')?.closest('[data-tree-group]')
    const r = group?.getBoundingClientRect()

    return r ? { x: r.x, width: r.width } : null
  })

async function dragSidebarTo(width) {
  const { page } = state
  const box = await sidebarBox()

  if (!box) {
    return null
  }

  const sash = await page.evaluate(edge => {
    const list = [...document.querySelectorAll('[role="separator"]')].map(node => ({ node, r: node.getBoundingClientRect() })).filter(({ r }) => r.height > 200 && Math.abs(r.x - edge) < 12)

    return list[0] ? { x: list[0].r.x + list[0].r.width / 2, y: list[0].r.y + list[0].r.height / 2 } : null
  }, box.x + box.width)

  if (!sash) {
    return null
  }

  await page.mouse.move(sash.x, sash.y)
  await page.mouse.down()

  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(sash.x + ((box.x + width - sash.x) * step) / 8, sash.y)
    await sleep(30)
  }

  await page.mouse.up()
  await sleep(500)

  return (await sidebarBox())?.width ?? null
}

// What the top-left corner holds, in page px: the corner row (toggle, mark,
// label, as one box), each sidebar tab's label, and the unread badge.
const corner = () =>
  state.page.evaluate(() => {
    const box = node => {
      const r = node.getBoundingClientRect()

      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
    }
    const cluster = document.querySelector('[data-titlebar-cluster="left"]')
    const group = document.querySelector('[data-tour="sessions-sidebar"]')?.closest('[data-tree-group]')
    const tabs = group ? [...group.querySelectorAll('[data-panel-header] [data-tree-tab]')].filter(node => node.checkVisibility() && node.getBoundingClientRect().width > 0) : []
    const badge = cluster?.querySelector('[data-slot="badge"]')

    return {
      cluster: cluster && cluster.checkVisibility() ? box(cluster) : null,
      tabs: tabs.map(node => ({ name: node.getAttribute('aria-label'), ...box(node.querySelector('.truncate') ?? node) })),
      badge: badge && badge.checkVisibility() ? { ...box(badge), background: getComputedStyle(badge).backgroundColor, color: getComputedStyle(badge).color, text: badge.textContent } : null,
      zoom: +(outerWidth / innerWidth).toFixed(3)
    }
  })

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const gray = colour => {
  const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).map(Number)

  return Math.max(r, g, b) - Math.min(r, g, b) <= 2
}

// ── The states ──────────────────────────────────────────────────────────────
export async function run() {
  const { mock, page } = state

  await setWindow({ height: 800, width: 1220, zoom: 1 })
  await settleWindow()
  await sleep(1000)

  await check('p01', async (entry, must) => {
    await snap(entry, must, 'p01-empty-session')

    // Self-test: the same state with the corner's "Hermes" one level less
    // blue must be caught. The planted rule is removed again before anything else.
    const planted = { evidence: {}, screenshots: [] }
    const plantedWhy = []

    entry.evidence.plantedColour = await page.evaluate(() => {
      const label = document.querySelector('[data-titlebar-cluster="left"]')
      const [r, g, b] = getComputedStyle(label, '::after').color.match(/[\d.]+/g).map(Number)
      const style = document.createElement('style')
      const colour = `rgb(${r}, ${g}, ${b > 0 ? b - 1 : b + 1})`

      // Monograph keeps its stylesheet last in <head>; this rule wins by
      // specificity instead of order.
      style.id = 'rig-planted'
      style.textContent = `html body [data-titlebar-cluster="left"][data-titlebar-cluster]::after { color: ${colour} !important; }`
      document.head.append(style)

      return colour
    })
    await snap(planted, (ok, why) => ok || plantedWhy.push(why), 'p01-planted-fault', { against: 'p01-empty-session' })
    await page.evaluate(() => document.getElementById('rig-planted')?.remove())
    entry.evidence.plantedFault = planted.evidence.diff ?? null
    must(plantedWhy.length > 0, 'self-test: the corner label one colour level off was not caught')
  })

  // One turn with work in it (reasoning, a note, a tool call, an answer) and
  // one plain turn after it.
  await check('p02', async (entry, must) => {
    await type('Show your work, MGP_WORK. MGS_WORK', 'Enter')
    await turnDone('MGS_WORK_DONE', 90_000)
    await type('And a short one, MGP_TWO.', 'Enter')
    await turnDone('Done MGP_TWO.', 60_000)
    await sleep(2500)
    entry.evidence.fold = await page.evaluate(`(() => [...((${ON_SCREEN_VIEWPORT})?.querySelectorAll('[data-mg-seg]') ?? [])].map(row => row.dataset.mgSeg + (row.dataset.mgSteps ? ' ' + row.dataset.mgSteps : '')))()`)
    await snap(entry, must, 'p02-thread-tools-shown')
  })

  await check('p03', async (entry, must) => {
    const head = await page.evaluate(`(() => {
      const row = (${ON_SCREEN_VIEWPORT})?.querySelector('.mg-line[data-mg-steps]')
      const r = row?.getBoundingClientRect()
      return r ? { x: r.x + Math.min(120, r.width / 2), y: r.y + Math.min(12, r.height / 2) } : null
    })()`)

    must(head, 'no fold line on the thread')

    if (head) {
      await page.mouse.click(head.x, head.y)
      await sleep(900)
      entry.evidence.rows = await page.evaluate(`(() => [...((${ON_SCREEN_VIEWPORT})?.querySelectorAll('[data-slot="aui_assistant-message-content"] > *') ?? [])].map(node => (node.dataset.slot ?? node.className.toString().slice(0, 20)) + ':' + getComputedStyle(node).display + ':' + Math.round(node.getBoundingClientRect().height)))()`)
      await snap(entry, must, 'p03-fold-open')

      // Opening the work scrolls the line up under the title band, where a
      // press would land on the band; bring it back to the middle first.
      const again = await page.evaluate(`(async () => {
        const row = (${ON_SCREEN_VIEWPORT})?.querySelector('.mg-line[data-mg-steps]')
        row?.scrollIntoView({ block: 'center' })
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const r = row?.getBoundingClientRect()
        return r ? { x: r.x + Math.min(120, r.width / 2), y: r.y + Math.min(12, r.height / 2) } : null
      })()`)

      entry.evidence.headMoved = again && (again.x !== head.x || again.y !== head.y) ? again : false
      await page.mouse.click((again ?? head).x, (again ?? head).y)
      await sleep(900)
      await quiet()
      entry.evidence.closedAgain = await page.evaluate(`!(${ON_SCREEN_VIEWPORT})?.querySelector('[data-mg-open]')`)
      // Back to the bottom, where the thread was.
      await page.evaluate(`(() => { const v = ${ON_SCREEN_VIEWPORT}; v.scrollTop = v.scrollHeight })()`)
      await sleep(600)
      must(entry.evidence.closedAgain, 'the fold did not close again on a second press')
    }
  })

  await check('p04', async (entry, must) => {
    await paletteRun('Toggle tool calls')
    entry.evidence.tools = await page.evaluate(() => document.documentElement.dataset.mgTools)
    await snap(entry, must, 'p04-thread-tools-hidden')
    await paletteRun('Toggle tool calls')
    must(entry.evidence.tools === 'hidden', `tools were ${entry.evidence.tools}`)
  })

  const menuState = (id, name, selector) =>
    check(id, async (entry, must) => {
      await closeAll()
      await press(selector)
      await openMenu()
      await sleep(400)
      // The model menu's logos arrive after the menu (two captures of one
      // commit once differed by 222 px on them): wait until the open menu's
      // rows stop changing and every picture in it, <img> or a CSS
      // background or mask, has decoded, then two frames.
      entry.evidence.pictures = await page.evaluate(async () => {
        const menus = () => [...document.querySelectorAll('[data-slot="dropdown-menu-content"][data-state="open"], .mg-surfaces-menu')]
        const shape = () => menus().map(menu => menu.querySelectorAll('*').length).join(',')
        let last = shape()
        let still = 0

        for (let i = 0; i < 40 && still < 3; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
          const now = shape()
          still = now === last ? still + 1 : 0
          last = now
        }

        const urls = new Set()
        const imgs = []

        for (const menu of menus()) {
          for (const node of [menu, ...menu.querySelectorAll('*')]) {
            if (node instanceof HTMLImageElement) imgs.push(node)

            for (const pseudo of [null, '::before', '::after']) {
              const style = getComputedStyle(node, pseudo)

              for (const value of [style.backgroundImage, style.maskImage, style.webkitMaskImage]) {
                for (const match of String(value ?? '').matchAll(/url\("?(.*?)"?\)/g)) urls.add(match[1])
              }
            }
          }
        }

        const decode = image => (image.decode ? image.decode().catch(() => 'failed') : Promise.resolve())
        await Promise.all([...imgs.map(decode), ...[...urls].map(url => { const image = new Image(); image.src = url; return decode(image) })])
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        return { imgs: imgs.length, cssPictures: urls.size, incomplete: imgs.filter(image => !image.complete || !image.naturalWidth).length }
      })
      await snap(entry, must, name, { park: false })
      await closeAll()
    })

  await menuState('p05', 'p05-menu-surfaces', '[data-tour="mg-surfaces"] .mg-surfaces-hit')
  await menuState('p06', 'p06-menu-model', 'button:is([data-tour="model-pill"], [aria-label^="Model · "])')
  await menuState('p07', 'p07-menu-effort', '[data-testid="reasoning-pill"]')
  await menuState('p08', 'p08-menu-approval', '.mg-chip[data-mg-approval]')

  await check('p09', async (entry, must) => {
    await page.keyboard.press('Meta+k')
    await shown('[data-slot="command-input"]').waitFor({ timeout: 5000 })
    await sleep(300)
    await snap(entry, must, 'p09-palette')
    await closeAll()
  })

  await check('p10', async (entry, must) => {
    const hide = await press('button[aria-label="Hide sidebar"]')

    await sleep(900)
    await snap(entry, must, 'p10-sidebar-collapsed')

    const show = shown('button[aria-label="Show sidebar"]')

    if (await show.count()) {
      await show.click()
    } else {
      await page.mouse.click(hide.x, hide.y)
    }

    await sleep(900)
  })

  await check('p11', async (entry, must) => {
    const before = await sidebarBox()

    await page.keyboard.press('Meta+Backslash')
    await sleep(1000)

    const after = await sidebarBox()

    entry.evidence.sidebarX = { before: before?.x ?? null, after: after?.x ?? null }
    await snap(entry, must, 'p11-sidebar-swapped')
    await page.keyboard.press('Meta+Backslash')
    await sleep(1000)
    must(after && before && after.x > before.x, `the sidebar did not move right: ${JSON.stringify(entry.evidence.sidebarX)}`)
  })

  await check('p12', async (entry, must) => {
    await page.keyboard.press('Meta+,')
    await shown('[data-tour="nav-plugins"]').waitFor({ timeout: 8000 })
    await sleep(600)
    await snap(entry, must, 'p12-settings')

    const close = shown('button[aria-label="Close settings"]')

    if (await close.count()) {
      await close.click()
    } else {
      await page.keyboard.press('Escape')
    }

    await sleep(800)
  })

  const sized = (id, name, size) =>
    check(id, async (entry, must) => {
      entry.evidence.window = await setWindow({ height: 800, ...size })
      await settleWindow()
      await sleep(500)
      await snap(entry, must, name)
      await setWindow({ height: 800, width: 1220, zoom: 1 })
      await settleWindow()
    })

  await sized('p13', 'p13-narrow-800', { width: 800, zoom: 1 })
  await sized('p14', 'p14-wide-1800', { width: 1800, zoom: 1 })
  await sized('p15', 'p15-zoom-125', { width: 1220, zoom: 1.25 })
  await sized('p16', 'p16-zoom-090', { width: 1220, zoom: 0.9 })

  await check('p17', async (entry, must) => {
    await type('Hold the reply here, MGP_HOLD. MGS_HOLD', 'Enter')
    await Promise.race([mock.waitForHeldStream(), sleep(20_000)])
    await sleep(1500)
    await snap(entry, must, 'p17-running-held')
    mock.releaseHeldStream()
    await turnDone('MGS_HOLD_DONE', 60_000)
    await sleep(2500)
  })

  await check('p18', async (entry, must) => {
    await newSession()
    await sleep(800)
    await snap(entry, must, 'p18-empty-after-thread')
  })

  await check('p19', async (entry, must) => {
    await openRow('MGP_WORK')
    await sleep(1500)
    await snap(entry, must, 'p19-thread-by-sidebar')
  })

  await check('p20', async (entry, must) => {
    await press('[data-tree-tab="hermes-bots:pane"]')
    await sleep(1200)
    await snap(entry, must, 'p20-bots-tab')
    await press('[data-tree-tab="sessions"]')
    await sleep(900)
  })

  await check('p21', async (entry, must) => {
    entry.evidence.width = await dragSidebarTo(200)
    await snap(entry, must, 'p21-sidebar-narrow')
    entry.evidence.restored = await dragSidebarTo(260)
  })

  // A session marked unread (its row's menu, "Mark as unread"): Hermes
  // counts it on the sidebar toggle.
  await check('p22', async (entry, must) => {
    await newSession()

    const row = page.locator('[data-slot="row-button"]', { hasText: 'MGP_WORK' }).filter({ visible: true }).first()

    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark as unread' }).click({ timeout: 5000 })
    await sleep(1200)
    entry.evidence.corner = await corner()
    await snap(entry, must, 'p22-unread-badge')
    must(entry.evidence.corner.badge, 'no unread badge on the sidebar toggle')
  })

  await check('p23', async (entry, must) => {
    const seen = []

    for (const zoom of [0.9, 1, 1.25, 1.5]) {
      await setWindow({ height: 800, width: 1220, zoom })
      await settleWindow()

      for (const width of [190, 230, 260, 340, 480]) {
        const got = await dragSidebarTo(width)
        const where = await corner()
        const hits = where.cluster ? where.tabs.filter(tab => intersects(tab, where.cluster)).map(tab => tab.name) : []
        const badgeHits = where.badge ? where.tabs.filter(tab => intersects(tab, where.badge)).map(tab => tab.name) : []

        seen.push({ zoom, asked: width, width: got, cluster: where.cluster, tabs: where.tabs.map(tab => `${tab.name} ${tab.x},${tab.y} ${tab.w}x${tab.h}`), hits, badgeHits })
        must(!hits.length && !badgeHits.length, `zoom ${zoom}, sidebar ${got}px: the corner row overlaps the tab(s) ${[...hits, ...badgeHits].join(', ')}`)
        must(where.tabs.length > 0, `zoom ${zoom}, sidebar ${got}px: no sidebar tabs on screen`)
      }
    }

    await setWindow({ height: 800, width: 1220, zoom: 1 })
    await settleWindow()
    await dragSidebarTo(260)

    // Self-test: squeeze the sidebar's header back into the band, as Hermes
    // draws it without Monograph's rule; the tabs then sit under the corner
    // row, and the check above must see it.
    await page.evaluate(() => {
      const style = document.createElement('style')

      style.id = 'rig-planted'
      style.textContent = 'html body [data-panel-header][data-panel-header]:has(> [data-slot="context-menu-trigger"].absolute > [role="tablist"]) { height: 30px !important; }'
      document.head.append(style)
    })
    await sleep(300)

    const planted = await corner()

    await page.evaluate(() => document.getElementById('rig-planted')?.remove())
    await sleep(300)
    entry.evidence.plantedOverlap = planted.cluster ? planted.tabs.filter(tab => intersects(tab, planted.cluster)).map(tab => tab.name) : []
    must(entry.evidence.plantedOverlap.length > 0, `self-test: tabs squeezed into the band were not seen to overlap the corner row: ${JSON.stringify(planted)}`)

    const where = await corner()

    entry.evidence.sizes = seen
    entry.evidence.badge = where.badge
    must(where.badge, 'no unread badge to judge (p22 should have left one)')
    must(!where.badge || (gray(where.badge.background) && gray(where.badge.color)), `the unread badge is not gray: ${JSON.stringify(where.badge)}`)
  })

  // The attributes of src/modules/05-state.js, frame by frame, through the
  // moments they must flip: Settings opened and closed (the surfaces button
  // leaves and comes back), a menu opened and closed by keyboard and by
  // pointer, a fresh page on an empty session and its first message, a
  // switch between sessions, a hot reload, and Monograph unloaded (nothing
  // may be left on <html>). Every frame, once produced, each attribute must
  // say what the page says (STATE_TRUTH).
  // Monograph's own surfaces, each opened by its row in the surfaces menu.
  const surface = async label => {
    await closeAll()
    await press('[data-tour="mg-surfaces"] .mg-surfaces-hit')
    await openMenu()
    await sleep(300)
    await page.locator('.mg-surface-row', { hasText: new RegExp(`^${label}`) }).filter({ visible: true }).first().click({ timeout: 3000 })
    await sleep(1200)
  }

  await check('p25', async (entry, must) => {
    await surface('Home')
    await snap(entry, must, 'p25-home')
  })

  if (hasModule('knowledge')) {
    await check('p26', async (entry, must) => {
      await surface('Knowledge')
      await snap(entry, must, 'p26-knowledge')
    })
  }

  await check('p27', async (entry, must) => {
    await openRow('MGP_WORK')
    await surface('Agent')
    await snap(entry, must, 'p27-agent-panel')
    await surface('Agent')
  })

  await check('p28', async (entry, must) => {
    await page.keyboard.press('Meta+,')
    await shown('[data-tour="nav-plugins"]').waitFor({ timeout: 8000 })
    await shown('[data-tour="nav-plugins"]').click()
    await sleep(600)
    await page.locator('button, a', { hasText: /^Monograph$/ }).filter({ visible: true }).first().click({ timeout: 5000 })
    await sleep(900)
    await snap(entry, must, 'p28-appearance')
    await press('button[aria-label="Close settings"]').catch(() => page.keyboard.press('Escape'))
    await sleep(800)
  })

  await check('p24', async (entry, must) => {
    const hasModule = await page.evaluate(() => (document.documentElement.dataset.mgModules ?? '').split(' ').includes('state'))

    if (!hasModule) {
      entry.evidence.skipped = 'no state module in this build'

      return
    }

    const monitor = () =>
      page.evaluate(`(() => {
        const keep = window.__rigState ?? { frames: 0, wrong: [], flips: {}, last: {} }
        window.__rigState = keep
        const truth = () => ${STATE_TRUTH}
        const tick = () => {
          window.__rigStateFrame = requestAnimationFrame(tick)
          setTimeout(() => {
            const expected = truth()
            const root = document.documentElement
            keep.frames += 1
            for (const [name, value] of Object.entries(expected)) {
              if (name in keep.last && keep.last[name] !== value) keep.flips[name] = (keep.flips[name] ?? 0) + 1
              keep.last[name] = value
              if (root.getAttribute(name) !== value && keep.wrong.length < 20) {
                keep.wrong.push({ at: keep.step, name, has: root.getAttribute(name), want: value })
              }
            }
          }, 0)
        }
        tick()
      })()`)
    // The record survives a page reload in the runner, not in the page.
    const records = []
    const collect = async () => {
      const got = await page.evaluate(() => {
        cancelAnimationFrame(window.__rigStateFrame)

        const got = window.__rigState

        delete window.__rigState

        return got
      })

      if (got) {
        records.push(got)
      }
    }
    const step = name => page.evaluate(label => (window.__rigState.step = label), name)
    const pill = 'button:is([data-tour="model-pill"], [aria-label^="Model · "])'
    const attr = name => page.evaluate(n => document.documentElement.getAttribute(n), name)
    const seen = {}

    await monitor()
    await step('thread')
    await openRow('MGP_WORK')

    await step('settings')
    await page.keyboard.press('Meta+,')
    await shown('[data-tour="nav-plugins"]').waitFor({ timeout: 8000 })
    await sleep(500)
    seen.settingsOpen = await attr('data-mg-surfaces')
    await press('button[aria-label="Close settings"]').catch(() => page.keyboard.press('Escape'))
    await sleep(800)
    seen.settingsClosed = await attr('data-mg-surfaces')

    await step('model menu by keyboard')
    await shown(pill).focus()
    await page.keyboard.press('Enter')
    await openMenu()
    await sleep(300)
    seen.keyboardOpen = await attr('data-mg-menu')
    await page.keyboard.press('Escape')
    await sleep(500)
    seen.keyboardClosed = await attr('data-mg-menu')

    await step('model menu by pointer')
    await press(pill)
    await openMenu()
    await sleep(300)
    seen.pointerOpen = await attr('data-mg-menu')
    await page.mouse.click(PARK.x + 600, PARK.y)
    await sleep(500)
    seen.pointerClosed = await attr('data-mg-menu')

    // A fresh page on a new session: no thread with a message is mounted.
    await step('new session, page reloaded')
    await newSession()
    await collect()
    await page.reload()
    await waitForAppReady({ app: state.app, page }, 60_000)
    await sleep(1500)
    await monitor()
    await step('fresh page')
    // The reloaded page sits on the new session's own route (#/<id>), and
    // only a draft route is "empty" (05-state.js). A new draft is opened
    // under the monitor, so data-mg-empty-chat flips on, and then off with
    // the first message, and both flips are judged frame by frame.
    seen.freshPageHash = await page.evaluate(() => location.hash)
    seen.freshPageBefore = await attr('data-mg-empty-chat')
    await step('draft opened')
    await page.evaluate(() => {
      location.hash = '#/'
    })
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-mg-empty-chat'), null, { timeout: 10_000 }).catch(() => undefined)
    await sleep(800)
    seen.freshPage = { has: await attr('data-mg-empty-chat'), truth: (await page.evaluate(STATE_TRUTH))['data-mg-empty-chat'], hash: await page.evaluate(() => location.hash) }
    await step('first message')
    await type('First message here, MGP_FLIP.', 'Enter')
    await turnDone('Done MGP_FLIP.', 60_000)
    await sleep(500)
    seen.afterFirstMessage = await attr('data-mg-empty-chat')

    await step('switch sessions')
    await openRow('MGP_WORK')
    await sleep(600)
    await openRow('MGP_FLIP')
    await sleep(600)

    await step('hot reload')
    await hotReload()
    await sleep(500)
    seen.afterReload = await page.evaluate(STATE_TRUTH)
    seen.afterReloadHas = await page.evaluate(() => ['data-mg-surfaces', 'data-mg-empty-chat', 'data-mg-menu'].map(name => document.documentElement.getAttribute(name)))

    // Unloaded: the monitor would now disagree on purpose, so it stops first.
    await collect()
    await hotReload({ gone: true, source: stubPlugin() })
    seen.unloaded = await page.evaluate(() => ['data-mg-surfaces', 'data-mg-empty-chat', 'data-mg-menu'].filter(name => document.documentElement.hasAttribute(name)))
    await hotReload()
    await sleep(800)
    seen.reloaded = await page.evaluate(() => ['data-mg-surfaces', 'data-mg-empty-chat', 'data-mg-menu'].map(name => document.documentElement.getAttribute(name)))

    const frames = records.reduce((sum, record) => sum + record.frames, 0)
    const wrong = records.flatMap(record => record.wrong)
    const flips = {}

    for (const record of records) {
      for (const [name, count] of Object.entries(record.flips)) {
        flips[name] = (flips[name] ?? 0) + count
      }
    }

    Object.assign(entry.evidence, { seen, frames, flips, wrongFrames: wrong })
    must(frames > 60, `the frame monitor saw only ${frames} frames`)
    must(!wrong.length, `an attribute disagreed with the page in ${wrong.length} frame(s): ${JSON.stringify(wrong.slice(0, 4))}`)

    for (const name of ['data-mg-surfaces', 'data-mg-empty-chat', 'data-mg-menu']) {
      must(flips[name] >= 2, `${name} never flipped and back under the monitor (${flips[name] ?? 0} flips): the check proves nothing for it`)
    }

    must(seen.settingsOpen === null && seen.settingsClosed === 'on', `surfaces button: Settings open ${seen.settingsOpen}, closed ${seen.settingsClosed}`)
    must(seen.keyboardOpen === 'model' && seen.keyboardClosed === null, `model menu by keyboard: open ${seen.keyboardOpen}, closed ${seen.keyboardClosed}`)
    must(seen.pointerOpen === 'model' && seen.pointerClosed === null, `model menu by pointer: open ${seen.pointerOpen}, closed ${seen.pointerClosed}`)
    must(seen.freshPage.has === '' && seen.freshPage.truth === '' && seen.afterFirstMessage === null, `empty chat: fresh page ${JSON.stringify(seen.freshPage)}, after the first message ${seen.afterFirstMessage}`)
    must(!seen.unloaded.length, `left on <html> after Monograph was unloaded: ${seen.unloaded.join(', ')}`)
    must(seen.reloaded[0] === 'on', `after loading Monograph again data-mg-surfaces is ${seen.reloaded[0]}`)
  })

  results.notes.push(`pixels: references ${RECORD ? 'recorded' : 'compared'} in ${REF}`)
}
