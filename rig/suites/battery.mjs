// Battery: breadth. Every Monograph control and every place it touches the
// chrome, with real clicks and keys. See rig/README.md ("Battery").
//
// The model is the stress suite's (startModel in suites/stress.mjs), with
// three extra model ids so the model menu has rows that carry logos.
import fs from 'node:fs'
import path from 'node:path'
import {
  INTERACTIVE,
  PLUGIN,
  ON_SCREEN_VIEWPORT,
  RUNNING,
  VIEWPORT,
  check as harnessCheck,
  consoleErrorsSince,
  consoleEvents,
  hasModule,
  hotReload,
  instrumentHooks,
  judgePerf,
  layoutProblems,
  measureHooks,
  overlaps,
  perf,
  rebuildPlugin,
  results,
  setWindow,
  shot,
  stubPlugin,
  sleep,
  state,
  turnDone,
  type,
  waitForAppReady
} from '../harness.mjs'

// MGS_ONLY=s15 runs only those checks (the rest report "not run"): for
// repeating one check quickly.
const ONLY = process.env.MGS_ONLY ? process.env.MGS_ONLY.split(',') : null
const check = (id, body) => (!ONLY || ONLY.includes(id) ? harnessCheck(id, body) : undefined)
import { startModel } from './stress.mjs'

export const limitS = 900

// Planted faults (self-test of a check, never for a verdict), comma separated:
// MG_RIG_PLANT=closeable (b17), b18 (the surfaces button hidden), b19 (no
// failure glyph on a shut failed row).
const PLANTS = new Set((process.env.MG_RIG_PLANT ?? '').split(',').filter(Boolean))
const plantCss = async (id, css) => {
  await state.page.evaluate(() => document.querySelectorAll('style[data-mg-plant]').forEach(node => node.remove()))

  if (PLANTS.has(id)) {
    results.notes.push(`battery: MG_RIG_PLANT=${id}: a planted fault (self-test, not a verdict)`)
    await state.page.evaluate(text => {
      const style = document.createElement('style')

      style.dataset.mgPlant = ''
      style.textContent = text
      document.head.appendChild(style)
    }, css)
  }
}

export const checks = [
  ['b0', 'Harness self-test: the error, overlap and movement detectors fire on planted faults'],
  ['b1', 'Approval chip on an empty session: shown, its menu opens, a pick sticks'],
  ['b2', 'Surfaces menu: every row opens its surface with a real click, and it closes again'],
  ['b3', 'Sidebar collapses and expands with a real click'],
  ['b4', 'New session, and switching between two sessions'],
  ['b5', 'Settings opens and the Monograph page renders and works'],
  ['b6', 'Model menu opens with a logo on each known vendor row'],
  ['b7', 'Effort slider: a drag across it moves the level'],
  ['b8', 'Command palette toggles tool calls; :root[data-mg-tools] follows'],
  ['b9', 'Tools shown: thinking and tool rows visible while a reply streams'],
  ['b10', 'Tools hidden: tool rows, summaries and thinking hidden; an approval still shows'],
  ['b11', 'Long prompts: Hermes\' own folds to four lines and opens; the queued copy too'],
  ['b12', 'Copy on a message puts its text on the clipboard'],
  ['b13', 'Window widths and zoom: no overlaps, no horizontal scrollbar, no clipped button text'],
  ['b13b', 'Narrow window: message box on screen and thread inside the window, against bare Hermes'],
  ['b14', 'Hot reload five times: one of everything, nothing grows, no errors'],
  ['b15', 'Sidebar swapped to the right and back (Cmd+\\): the main tabs clear the window buttons at once'],
  ['b16', 'Greeting: a name holding $& and $1 is put in as text'],
  ['b17', 'Agent pane: its tab has no close control, and no way of closing or sweeping the pane switches Monograph off'],
  ['b18', 'Surfaces button: visible and pressable with the tab strip always on and 12 tabs, at 1220 and 800 px'],
  ['b19', 'A failed tool call says so while its row is shut: a glyph, not a colour; a call that worked has none']
]

export const model = () => startModel({ extraModels: ['claude-sonnet-4-5', 'gpt-5', 'deepseek-chat'] })

// ── Helpers ─────────────────────────────────────────────────────────────────
const SHOWN = ON_SCREEN_VIEWPORT

// Marks the thread on screen so locators can be scoped to it:
// `[data-rig-onscreen] …`. Hermes keeps other tabs' threads in the page.
const markOnScreen = () =>
  state.page.evaluate(`(() => {
    document.querySelectorAll('[data-rig-onscreen]').forEach(node => node.removeAttribute('data-rig-onscreen'))
    ;(${ON_SCREEN_VIEWPORT})?.setAttribute('data-rig-onscreen', '')
  })()`)

const waitIdle = (needle, timeout = 60_000) => turnDone(needle, timeout)

// Back to a chat: any page or modal closed, a session's thread on screen.
async function home() {
  const { page } = state

  if (await page.locator('button[aria-label="Close settings"]').filter({ visible: true }).count()) {
    await page.locator('button[aria-label="Close settings"]').filter({ visible: true }).first().click()
    await sleep(500)
  }

  if (!(await page.evaluate(`Boolean(${SHOWN})`)) || !/^#\/(local-|$)/.test(await page.evaluate(() => location.hash || '#/'))) {
    const row = page.locator('[data-slot="row-button"]').filter({ visible: true }).first()

    if (await row.count()) {
      await row.click()
      await sleep(900)
    }
  }
}

const visible = (selector, scope = 'document') =>
  state.page.evaluate(
    ({ scope, selector }) => {
      const root = scope === 'document' ? document : eval(scope)

      return root ? [...root.querySelectorAll(selector)].filter(node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && node.getBoundingClientRect().height > 0).length : 0
    },
    { scope, selector }
  )

async function centre(selector) {
  const box = await state.page.locator(selector).filter({ visible: true }).first().boundingBox({ timeout: 5000 })

  if (!box) {
    throw new Error(`nothing on screen for ${selector}`)
  }

  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

async function press(selector) {
  const { x, y } = await centre(selector)

  await state.page.mouse.click(x, y)

  return { x, y }
}

const menusOpen = () =>
  state.page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="dropdown-menu-content"], [role="menu"], [role="dialog"], [cmdk-root]')]
      .filter(node => node.checkVisibility())
      .map(node => node.className.toString().match(/mg-[\w-]+/)?.[0] ?? node.getAttribute('role') ?? node.dataset.slot)
  )

async function newSession() {
  const button = state.page.locator('button[aria-label="New session"]').filter({ visible: true }).first()

  if (await button.count()) {
    await button.click()
  } else {
    await state.page.keyboard.press('Meta+n')
  }

  await sleep(800)
}

async function openPalette() {
  await state.page.keyboard.press('Meta+k')
  await state.page.locator('[data-slot="command-input"]').filter({ visible: true }).first().waitFor({ timeout: 5000 })
}

// Runs "Toggle tool calls" from the palette with real keys; returns what the
// palette showed and the root attribute after.
async function toggleToolsFromPalette(how = 'enter') {
  const { page } = state

  await openPalette()
  await page.keyboard.insertText('Toggle tool calls')
  await sleep(300)

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="command-item"]')].filter(node => node.checkVisibility() && /Toggle tool calls/.test(node.textContent ?? '')).map(node => (node.textContent ?? '').trim())
  )
  const before = await page.evaluate(() => document.documentElement.dataset.mgTools)

  const runs = await page.evaluate(() => {
    window.__mgRigToolFlips = 0

    const observer = new MutationObserver(records => {
      window.__mgRigToolFlips += records.filter(record => record.attributeName === 'data-mg-tools').length
    })

    observer.observe(document.documentElement, { attributeFilter: ['data-mg-tools'], attributes: true })
    window.__mgRigToolObserver = observer

    return true
  })

  const highlighted = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="command-item"][data-selected="true"], [cmdk-item][aria-selected="true"]')].find(node => node.checkVisibility())?.textContent?.trim() ?? null)
  const firstHighlighted = await highlighted()
  let arrows = 0
  let clickedAt = null
  // What a press at the row's middle reaches before the pointer has moved.
  let quietHit = null

  if (how === 'click') {
    const row = page.locator('[data-slot="command-item"]', { hasText: 'Toggle tool calls' }).filter({ visible: true }).first()

    await row.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined)

    // A real pointer press at the row's middle; what is drawn there is kept.
    const box = await row.boundingBox({ timeout: 3000 }).catch(() => null)

    if (box) {
      quietHit = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)

        return hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute('data-slot') ? `[${hit.getAttribute('data-slot')}]` : ''} "${hit.textContent.trim().slice(0, 30)}"` : null
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      // A person's pointer travels to the row before it presses. Hermes keeps
      // the list inert to the pointer until the mouse moves after the palette
      // opens (usePointerQuiet in components/ui/command.tsx), so a press with
      // no travel before it lands on the list, not the row, for Hermes' own
      // rows too.
      await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 30)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
      await sleep(150)
      clickedAt = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)?.closest('[data-slot="command-item"]') ?? document.elementFromPoint(x, y)

        return hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute('data-slot') ? `[${hit.getAttribute('data-slot')}]` : ''} "${hit.textContent.trim().slice(0, 30)}"` : null
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    } else {
      clickedAt = 'no box for the row'
    }
  } else {
    // A keyboard user moves to the row first if the palette highlights another.
    while (!/^Toggle tool calls/.test((await highlighted()) ?? '') && arrows < 15) {
      await page.keyboard.press('ArrowDown')
      arrows += 1
      await sleep(60)
    }

    await page.keyboard.press('Enter')
  }

  await sleep(400)

  const flips = await page.evaluate(() => {
    window.__mgRigToolObserver.disconnect()

    return window.__mgRigToolFlips
  })
  const after = await page.evaluate(() => document.documentElement.dataset.mgTools)
  const stillOpen = await page.locator('[data-slot="command-input"]').filter({ visible: true }).count()
  const rowAfter = await page.evaluate(() => [...document.querySelectorAll('[data-slot="command-item"]')].find(node => node.checkVisibility() && /Toggle tool calls/.test(node.textContent ?? ''))?.textContent?.trim() ?? null)

  if (stillOpen) {
    await page.keyboard.press('Escape')
    await sleep(300)
  }

  return { after, arrowsToReachIt: arrows, before, clickedAt, firstHighlighted, flips: runs ? flips : null, how, quietHit, rowAfter, rows, stillOpenAfterEnter: Boolean(stillOpen) }
}

// Hermes' own toggle row ("Toggle status bar", a paletteToggle like ours),
// pressed with the pointer the same way: the reference for what a click on a
// palette row does here, and whether the palette stays open after it.
async function hermesToggleByClick(label = 'Toggle status bar') {
  const { page } = state

  await openPalette()
  await page.keyboard.insertText(label)
  await sleep(300)

  const read = () => page.evaluate(label => [...document.querySelectorAll('[data-slot="command-item"]')].find(node => node.checkVisibility() && node.textContent.includes(label))?.textContent?.trim() ?? null, label)
  const before = await read()
  const row = page.locator('[data-slot="command-item"]', { hasText: label }).filter({ visible: true }).first()
  const box = await row.boundingBox({ timeout: 3000 }).catch(() => null)

  if (box) {
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 30)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
    await sleep(150)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await sleep(400)
  }

  const after = await read()
  const stillOpen = Boolean(await page.locator('[data-slot="command-input"]').filter({ visible: true }).count())

  // Put it back.
  if (before && after && before !== after) {
    if (!stillOpen) {
      await openPalette()
      await page.keyboard.insertText(label)
      await sleep(300)
    }

    for (let i = 0; i < 10 && !(await page.evaluate(label => [...document.querySelectorAll('[data-slot="command-item"][data-selected="true"]')].some(node => node.checkVisibility() && node.textContent.includes(label)), label)); i++) {
      await page.keyboard.press('ArrowDown')
      await sleep(60)
    }

    await page.keyboard.press('Enter')
    await sleep(300)
  }

  if (await page.locator('[data-slot="command-input"]').filter({ visible: true }).count()) {
    await page.keyboard.press('Escape')
    await sleep(300)
  }

  return { after, before, changed: Boolean(before && after && before !== after), label, stillOpenAfterClick: stillOpen }
}

// What is on screen, to tell whether a surface opened and closed again.
const scene = () =>
  state.page.evaluate(() => {
    const shown = node => node.checkVisibility() && node.getBoundingClientRect().width > 4 && node.getBoundingClientRect().height > 4
    // On screen for real: nothing else drawn over its middle.
    const onTop = node => {
      if (!shown(node)) {
        return false
      }

      const rect = node.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)

      return Boolean(hit && (node === hit || node.contains(hit)))
    }

    return {
      hash: location.hash.replace(/[?&]_=[^&]*/, ''),
      tabs: [...document.querySelectorAll('[data-slot="pane-tab"]')].filter(shown).map(node => node.getAttribute('aria-label') ?? node.textContent.trim()).sort(),
      terminals: [...document.querySelectorAll('.xterm')].filter(onTop).length,
      webviews: [...document.querySelectorAll('webview, iframe')].filter(onTop).length,
      buttons: [...document.querySelectorAll('button[aria-label]')].filter(onTop).map(node => node.getAttribute('aria-label')),
      viewport: Boolean([...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].find(shown)),
      thread: (() => {
        const v = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].find(onTop)
        const r = v?.getBoundingClientRect()

        return r ? `${Math.round(r.x)}+${Math.round(r.width)}` : null
      })(),
      headings: [...document.querySelectorAll('h1, h2')].filter(shown).map(node => node.textContent.trim().slice(0, 30)).slice(0, 3)
    }
  })

const same = (a, b) =>
  a.hash === b.hash && a.tabs.join('|') === b.tabs.join('|') && a.terminals === b.terminals && a.webviews === b.webviews && a.viewport === b.viewport && a.thread === b.thread

// Fold the right column the way a person can: Hermes' ⌘J (toggle right
// sidebar) twice. On the split right column of both modes the first press
// opens it and the second collapses it, whatever was showing there.
async function refoldRight() {
  if (state.page.keyboard) {
    await state.page.keyboard.press('Escape').catch(() => undefined)
    await state.page.keyboard.press('Meta+j')
    await sleep(500)
    await state.page.keyboard.press('Meta+j')
    await sleep(900)
  }
}

async function resetLayout() {
  const { page } = state

  await page.keyboard.press('Escape').catch(() => undefined)
  await openPalette()
  await page.keyboard.insertText('Reset layout')
  await sleep(400)

  // Move to the row if another one is highlighted.
  for (let i = 0; i < 10; i++) {
    const on = await page.evaluate(() => [...document.querySelectorAll('[data-slot="command-item"][data-selected="true"], [cmdk-item][aria-selected="true"]')].find(node => node.checkVisibility())?.textContent?.trim() ?? '')

    if (/^Reset layout/.test(on)) {
      break
    }

    await page.keyboard.press('ArrowDown')
    await sleep(60)
  }

  await page.keyboard.press('Enter')
  await sleep(1200)

  if (await page.locator('[data-slot="command-input"]').filter({ visible: true }).count()) {
    await page.keyboard.press('Escape')
    await sleep(300)
  }
}

async function openSurfaces() {
  await press('[data-tour="mg-surfaces"] .mg-surfaces-hit')
  await state.page.locator('.mg-surfaces-menu').waitFor({ state: 'visible', timeout: 3000 })
}

const pluginLoaded = () => state.page.evaluate(() => Boolean(document.documentElement.dataset.mgReady))

// Hermes disables a single-pane plugin whose pane tab is closed (closeTreePane
// in components/pane-shell/tree/store.ts) and keeps that decision in
// localStorage. Undo it there and reload the page, so the checks after a
// failure still mean something.
async function reEnable() {
  const { app, page } = state

  await page.evaluate(() => {
    const key = 'hermes.desktop.pluginDecisions.v2'
    let decisions = {}

    try {
      decisions = JSON.parse(window.localStorage.getItem(key) || '{}') || {}
    } catch {
      decisions = {}
    }

    window.localStorage.setItem(key, JSON.stringify({ ...decisions, monograph: true }))
  })
  await page.reload()
  await waitForAppReady({ app, page }, 60_000).catch(() => undefined)
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.mgReady), undefined, { timeout: 20_000 }).catch(() => undefined)
}

const surfaceRows = () => state.page.evaluate(() => [...document.querySelectorAll('.mg-surfaces-menu .mg-surface-row')].map(row => row.querySelector('span')?.textContent?.trim() ?? row.textContent.trim()))

// ── The checks ──────────────────────────────────────────────────────────────
export async function run() {
  const { app, page } = state

  // The clipboard belongs to the person at the machine. Copies made by the
  // app during the run go to a variable in the main process instead.
  await app.evaluate(({ clipboard }) => {
    globalThis.__rigClipboard = []
    clipboard.writeText = text => {
      globalThis.__rigClipboard.push(String(text))
    }
  })
  const clipboardPatched = await app.evaluate(({ clipboard }) => String(clipboard.writeText).includes('__rigClipboard'))

  await page.evaluate(() => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = async text => {
        window.__rigClipboard = [...(window.__rigClipboard ?? []), String(text)]
      }
    }
  })

  // ── b0. The detectors can fail ───────────────────────────────────────────
  await check('b0', async (entry, must) => {
    entry.allowConsole = [/rig-selftest/]

    const mark = consoleEvents.length

    await page.evaluate(() => {
      console.error('rig-selftest: a planted console error')
      setTimeout(() => Promise.reject(new Error('rig-selftest: a planted unhandled rejection')), 0)
    })
    await sleep(500)

    const caught = consoleErrorsSince(mark).map(event => `${event.type}: ${event.text.slice(0, 60)}`)

    entry.evidence.consoleCaught = caught
    must(caught.some(text => text.startsWith('error')), 'a console.error in the page was not caught')
    must(caught.some(text => text.includes('rejection')), 'an unhandled rejection in the page was not caught')

    await page.evaluate(() => {
      for (const [id, x] of [['mg-rig-a', 300], ['mg-rig-b', 320]]) {
        const button = document.createElement('button')

        button.id = id
        button.textContent = id
        Object.assign(button.style, { height: '30px', left: `${x}px`, position: 'fixed', top: '300px', width: '60px', zIndex: 99999 })
        document.body.appendChild(button)
      }
    })

    const planted = await overlaps('#mg-rig-a, #mg-rig-b')

    await page.evaluate(() => document.querySelectorAll('#mg-rig-a, #mg-rig-b').forEach(node => node.remove()))
    entry.evidence.overlapCaught = planted.pairs
    must(planted.pairs.length === 1, `two buttons planted on top of each other gave ${planted.pairs.length} overlap(s)`)

    // A thread to move: one reply, made scrollable by a spacer.
    await type('Self test, MGB_SELF.', 'Enter')
    await waitIdle('Done MGB_SELF.')

    const moved = await perf(async () => {
      await page.evaluate(selector => {
        const v = [...document.querySelectorAll(selector)].find(node => node.getBoundingClientRect().height > 0)
        const spacer = document.createElement('div')

        spacer.id = 'mg-rig-spacer'
        spacer.style.height = '3000px'
        // Lines to read: the recorder anchors on the element under a point 40%
        // down the view and drops an anchor whose top is off screen, so one
        // blank 3000 px block gave it nothing to follow (and b0 failed at
        // random). 100 lines of 30 px always put a line there.
        for (let line = 0; line < 100; line++) {
          const row = document.createElement('p')

          row.textContent = `Self-test line ${line + 1}`
          row.style.cssText = 'height: 30px; margin: 0'
          spacer.appendChild(row)
        }
        v.prepend(spacer)
        v.scrollTop = 1500
      }, VIEWPORT)
      await sleep(900)
      // Moved by script, with no input: the recorder must call it unexplained.
      await page.evaluate(selector => {
        const v = [...document.querySelectorAll(selector)].find(node => node.getBoundingClientRect().height > 0)

        v.scrollTop -= 120
        // And a frame that takes 150 ms.
        const until = performance.now() + 150

        while (performance.now() < until) {
          // busy
        }
      }, VIEWPORT)
      await sleep(600)
      await page.evaluate(() => document.getElementById('mg-rig-spacer')?.remove())
    })
    const verdict = judgePerf(moved, { mode: 'reading' })

    entry.evidence.movementCaught = { anchorNoInput: moved.viewport.anchorNoInput, maxFrame: moved.maxFrame, scrollNoInput: moved.viewport.scrollNoInput, verdict }
    must(verdict.some(reason => reason.includes('moved with no input')), 'a 120 px scroll by script was not reported as movement without input')
    must(verdict.some(reason => reason.includes('a frame took')), 'a 150 ms frame was not reported')
  })

  // ── b1. Approval chip ────────────────────────────────────────────────────
  await check('b1', async (entry, must) => {
    await newSession()
    await sleep(1500)
    entry.evidence.onEmptySession = await visible('.mg-chip[data-mg-approval]')
    await shot(entry, 'b1-empty-session-composer')
    must(entry.evidence.onEmptySession === 1, `the approval chip is on screen ${entry.evidence.onEmptySession} time(s) on an empty session, expected once`)

    if (!entry.evidence.onEmptySession) {
      // Carry on in a session that has a turn, where it was seen before.
      await type('Chip test, MGB_CHIP.', 'Enter')
      await waitIdle('Done MGB_CHIP.')
      entry.evidence.afterATurn = await visible('.mg-chip[data-mg-approval]')
    }

    await press('.mg-chip[data-mg-approval]')
    await page.locator('.mg-approval-menu').waitFor({ state: 'visible', timeout: 3000 })

    const rows = await page.evaluate(() => [...document.querySelectorAll('.mg-approval-menu .mg-approval-row')].map(row => ({ checked: row.getAttribute('aria-checked'), text: row.querySelector('b')?.textContent })))

    entry.evidence.menu = rows
    await shot(entry, 'b1-approval-menu')
    must(rows.length === 3, `the menu has ${rows.length} rows, expected Manual, Smart, Off`)
    await page.locator('.mg-approval-menu .mg-approval-row', { hasText: 'Manual' }).click()
    const chipOnScreen = () => page.evaluate(() => [...document.querySelectorAll('.mg-chip[data-mg-approval]')].filter(node => node.checkVisibility()).map(node => node.getAttribute('aria-label')))

    await sleep(800)

    const stored = await page.evaluate(async () => (await globalThis.__HERMES_PLUGIN_SDK__.host.request('config.get', { key: 'approvals.mode' }))?.value)

    entry.evidence.after = { chip: (await chipOnScreen()).join(', '), stored, menusOpen: await menusOpen() }

    // Another session tab: its composer has its own chip.
    const other = page.locator('[data-slot="pane-tab"]').filter({ visible: true }).filter({ hasNotText: /^(Sessions|Bots)$/ }).first()

    if (await other.count()) {
      await other.click()
      await sleep(1000)
      entry.evidence.otherTabChip = (await chipOnScreen()).join(', ')
      must(entry.evidence.otherTabChip === 'Approval mode: Manual', `in another session tab the chip reads ${entry.evidence.otherTabChip || 'nothing'} while the mode is ${stored}`)
    }
    must(entry.evidence.after.chip === 'Approval mode: Manual', `the chip reads ${entry.evidence.after.chip}`)
    must(stored === 'manual', `Hermes' config holds approvals.mode=${stored}`)
    must(!entry.evidence.after.menusOpen.length, `a menu is still open after the pick: ${entry.evidence.after.menusOpen}`)

    // Every chip in the page, the hidden tabs' too: all must say the same.
    const everyChip = () => page.evaluate(() => [...new Set([...document.querySelectorAll('.mg-chip[data-mg-approval]')].map(node => node.dataset.mgApproval))])
    const configNow = () => page.evaluate(async () => (await globalThis.__HERMES_PLUGIN_SDK__.host.request('config.get', { key: 'approvals.mode' }))?.value)
    const settle = async want => {
      for (let i = 0; i < 20 && (await everyChip()).join() !== want; i++) {
        await sleep(150)
      }

      return everyChip()
    }

    // Changed with Hermes' own slash command in the chat (/approvals off):
    // the gateway writes the config and sends session.info to live sessions.
    await page.evaluate(() => {
      window.__mgRigInfo = []
      window.__mgRigInfoStop = globalThis.__HERMES_PLUGIN_SDK__.host.onEvent('session.info', event => window.__mgRigInfo.push(event?.payload?.approval_mode ?? null))
    })
    await type('/approvals off', 'Enter')

    for (let i = 0; i < 40 && (await configNow()) !== 'off'; i++) {
      await sleep(150)
    }

    entry.evidence.bySlashCommand = { chips: await settle('off'), stored: await configNow() }
    entry.evidence.bySlashCommand.sessionInfoModes = await page.evaluate(() => window.__mgRigInfo.splice(0))
    await page.keyboard.press('Escape').catch(() => undefined)
    must(entry.evidence.bySlashCommand.stored === 'off', `/approvals off did not change Hermes' config (holds ${entry.evidence.bySlashCommand.stored})`)
    must(entry.evidence.bySlashCommand.chips.join() === 'off', `after /approvals off the chips read ${entry.evidence.bySlashCommand.chips.join(', ')}`)

    // A config.set from outside any session sends no event at all (the
    // gateway's broadcast reaches live sessions only), so nothing can show it
    // until the next read: window focus, a chip mounting, the menu opening.
    // Recorded, not judged; the menu opening must then show it.
    await page.evaluate(() => globalThis.__HERMES_PLUGIN_SDK__.host.request('config.set', { key: 'approvals.mode', value: 'smart' }))
    await sleep(800)
    entry.evidence.silentSet = { chipsAfter800ms: await everyChip(), sessionInfoModes: await page.evaluate(() => window.__mgRigInfo.splice(0)), stored: await configNow() }
    await press('.mg-chip[data-mg-approval]')
    await page.locator('.mg-approval-menu').waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
    entry.evidence.silentSet.chipsWithMenuOpen = await settle('smart')
    entry.evidence.silentSet.checkedRow = await page.evaluate(() => [...document.querySelectorAll('.mg-approval-menu .mg-approval-row[aria-checked="true"] b')].map(node => node.textContent))
    await page.keyboard.press('Escape')
    await sleep(300)
    await page.evaluate(() => window.__mgRigInfoStop?.())
    must(entry.evidence.silentSet.chipsWithMenuOpen.join() === 'smart', `with the menu open after a silent change to smart, the chips read ${entry.evidence.silentSet.chipsWithMenuOpen.join(', ')}`)

    // Changed in Hermes' own Settings (Safety, Approval mode), which saves by
    // REST and sends no event: the chips must have it once Settings closes.
    const viaSettings = {}

    entry.evidence.viaSettings = viaSettings

    try {
      await page.keyboard.press('Meta+,')
      await page.locator('[data-tour="nav-plugins"]').waitFor({ state: 'visible', timeout: 8000 })
      await page.locator('button, a', { hasText: /^Safety$/ }).filter({ visible: true }).first().click({ timeout: 5000 })
      await sleep(800)

      // The field by Hermes' own hook for it (config-field.tsx:
      // data-tour="field-<key>"), not by its wording or nesting. Safety opens
      // on the page it was last left on; Approvals is one of three.
      const field = page.locator('[data-tour="field-approvals.mode"]').filter({ visible: true }).first()

      if (!(await field.count())) {
        await page.locator('button, a', { hasText: /^Approvals$/ }).filter({ visible: true }).first().click({ timeout: 5000 })
        await sleep(600)
      }

      const trigger = field.locator('[role="combobox"], [data-slot="select-trigger"]').first()

      viaSettings.page = await page.evaluate(() => location.hash)
      viaSettings.before = (await trigger.innerText({ timeout: 5000 })).trim()
      await trigger.click()
      await page.locator('[role="option"]', { hasText: /^Manual$/ }).first().click({ timeout: 5000 })
      viaSettings.picked = (await trigger.innerText()).trim()

      // Hermes saves settings a moment after the change.
      for (let i = 0; i < 30 && (await configNow()) !== 'manual'; i++) {
        await sleep(200)
      }

      viaSettings.storedBeforeClose = await configNow()
      viaSettings.chipsBeforeClose = await everyChip()
      await page.locator('button[aria-label="Close settings"]').filter({ visible: true }).first().click()
      viaSettings.chipsAfterClose = await settle('manual')
      viaSettings.stored = await configNow()
    } catch (error) {
      viaSettings.error = String(error.message).split('\n')[0]
      await page.keyboard.press('Escape').catch(() => undefined)
    }

    await shot(entry, 'b1-after-settings')
    must(!viaSettings.error, `could not change the mode in Hermes' Settings: ${viaSettings.error}`)
    must(viaSettings.error || viaSettings.stored === 'manual', `Hermes' Settings did not store manual (holds ${viaSettings.stored})`)
    must(viaSettings.error || viaSettings.chipsAfterClose?.join() === 'manual', `after Settings set Manual, the chips read ${viaSettings.chipsAfterClose?.join(', ')}`)

    // Settings left it at Manual, which b10 needs (an approval card must appear there).
    entry.evidence.atEnd = { chips: await everyChip(), stored: await configNow() }
  })

  // ── b2. Surfaces ─────────────────────────────────────────────────────────
  await check('b2', async (entry, must) => {
    // Start from a session with a turn in it (b0's), no pane open: every row
    // is judged against that, and Home and Knowledge are left by going back
    // to it in the sidebar, as a person would.
    const BASE_TITLE = 'Self test, MGB_SELF.'
    const toBase = async () => {
      await page.locator('[data-slot="row-button"]', { hasText: BASE_TITLE }).filter({ visible: true }).first().click({ timeout: 5000 })
      await sleep(900)
    }

    await toBase()
    await openSurfaces()

    const rows = await surfaceRows()

    entry.evidence.rows = rows
    await page.mouse.click(5, 790)
    await sleep(300)
    // Rows by rank: Monograph's own (Home, Knowledge when the build has it,
    // Agent), then Hermes'.
    const ORDER = ['Home', 'Knowledge', 'Agent', 'Browser', 'Terminal', 'Files', 'Diff', 'Agents', 'Artifacts', 'Scheduled jobs', 'Messaging', 'Capabilities', 'Settings'].filter(
      label => label !== 'Knowledge' || hasModule('knowledge')
    )

    must(rows.join('|') === ORDER.join('|'), `the rows read ${rows.join(', ')}; expected ${ORDER.join(', ')}`)

    entry.evidence.base = await scene()
    entry.evidence.surfaces = {}

    // Bare Hermes' own Terminal, from this same base: its shortcut to open,
    // its Hide button to close. Measured with Monograph unloaded, then the
    // right column folded again (⌘J twice) and Monograph put back.
    entry.evidence.bareReference = {}

    try {
      await hotReload({ gone: true, source: stubPlugin() })
      await sleep(600)

      const bareBase = await scene()

      await page.keyboard.press('Control+Backquote')
      await sleep(1200)

      const opened = await scene()

      await page.locator('button[aria-label="Hide terminal"]').filter({ visible: true }).first().click({ timeout: 3000 })
      await sleep(1000)

      const end = await scene()

      await refoldRight()
      entry.evidence.bareReference.Terminal = { base: bareBase, end, opened: opened.terminals, refolded: same(bareBase, await scene()) }
    } catch (error) {
      entry.evidence.bareReference.error = String(error.message).split('\n')[0]
    }

    await hotReload()
    await toBase()
    must(same(entry.evidence.base, await scene()), `after the bare-Hermes reference the scene is not the base: ${JSON.stringify(await scene())}`)

    for (const label of rows) {
      const record = {}
      // Each row is judged against the state just before it, so one surface
      // that stays open is one failure, not a cascade.
      const base = await scene()

      entry.evidence.surfaces[label] = record

      try {
        await openSurfaces()
        await page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: label }).first().click()
        await sleep(1200)
        record.menuClosed = !(await page.locator('.mg-surfaces-menu').count())

        const opened = await scene()

        record.opened = !same(base, opened)
        record.saw = {
          buttons: opened.buttons.filter(label => !base.buttons.includes(label)),
          hash: opened.hash,
          headings: opened.headings,
          tabs: opened.tabs.filter(tab => !base.tabs.includes(tab)),
          terminals: opened.terminals,
          webviews: opened.webviews
        }
        await shot(entry, `b2-${label.toLowerCase().replace(/\W+/g, '-')}`)

        // Close it the way a person would: its own close button, the same row
        // again (the panes toggle), then back to the chat.
        // The tab this row opened: Diff opens Hermes' "Review" pane, and a
        // tab that only came back with it (the Agent pane beside Review in
        // Advanced mode) is not the one to close.
        const OWN_TAB = { Browser: /Browser/i, Diff: /Review|Diff/i, Files: /Files/i, Terminal: /Terminal/i }
        const fresh = record.saw.tabs.find(tab => OWN_TAB[label]?.test(tab)) ?? record.saw.tabs[0]
        const ways = [
          // Overlays (Settings, Agents, Scheduled jobs) first: they cover the sidebar.
          ['Close settings', async () => {
            const close = page.locator('button[aria-label="Close settings"]').filter({ visible: true }).first()

            if (!(await close.count())) {
              return false
            }

            await close.click()

            return true
          }],
          ['a close or hide button that came with it', async () => {
            const label = record.saw.buttons.find(name => /^(close|hide|dismiss)\b/i.test(name) && !/window|sidebar$/i.test(name))

            if (!label) {
              return false
            }

            await page.locator(`button[aria-label="${label}"]`).filter({ visible: true }).first().click()

            return true
          }],
          // Home (a new empty session at #/, in the current tab) and Knowledge
          // (the page at #/knowledge) are left by going back to the session it
          // started from. First: closing Home's draft tab instead would leave
          // a different tab in front.
          ['the session it started from, in the sidebar', async () => {
            if (opened.hash === base.hash) {
              return false
            }

            await toBase()

            return true
          }],
          ['the close button on its pane tab', async () => {
            if (!fresh) {
              return false
            }

            const tab = page.locator('[data-slot="pane-tab"]', { hasText: fresh }).filter({ visible: true }).first()

            await tab.hover()
            await sleep(200)

            const close = tab.locator('button[aria-label="Close"]').first()

            if (!(await close.count())) {
              return false
            }

            await close.click()

            return true
          }],
          ['the titlebar\'s "Hide right sidebar"', async () => {
            if (base.buttons.includes('Hide right sidebar') || !(await scene()).buttons.includes('Hide right sidebar')) {
              return false
            }

            await page.locator('button[aria-label="Hide right sidebar"]').filter({ visible: true }).first().click()

            return true
          }],
          ['the same row again', async () => {
            await openSurfaces()
            await page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: label }).first().click()

            return true
          }],
          ['Escape', async () => {
            await page.keyboard.press('Escape')

            return true
          }],
          ['its shortcut (Files: Cmd+J, Diff: Cmd+G, Browser: Cmd+Shift+L, Terminal: Ctrl+`)', async () => {
            const keys = { Browser: 'Meta+Shift+l', Diff: 'Meta+g', Files: 'Meta+j', Terminal: 'Control+Backquote' }[label]

            if (!keys) {
              return false
            }

            await page.keyboard.press(keys)

            return true
          }]
        ]

        record.closedBy = null

        if (record.opened) {
          record.tried = []

          for (const [name, way] of ways) {
            if (await way().catch(() => false)) {
              await sleep(900)
              record.tried.push(name)

              if (!(await pluginLoaded())) {
                record.pluginGoneAfter = name
                break
              }

              if (same(base, await scene())) {
                record.closedBy = name
                break
              }
            }
          }
        }

        record.after = await scene()

        // Monograph itself must survive every surface opening and closing.
        if (!(await pluginLoaded())) {
          record.pluginGone = true
          await shot(entry, `b2-${label.toLowerCase().replace(/\W+/g, '-')}-plugin-gone`)
          must(false, `${label}: Monograph was unloaded (no data-mg-ready on the root) after ${record.pluginGoneAfter ? `closing it by ${record.pluginGoneAfter}` : 'opening it'}; tried: ${(record.tried ?? []).join(', ')}`)
          // Put it back so the checks after this one still mean something.
          await reEnable()
          record.reEnabled = await pluginLoaded()
          results.observations.push(`b2: Monograph was disabled at the ${label} row; it was enabled again (localStorage decision and a reload): ${record.reEnabled ? 'back' : 'still gone'}`)
          await toBase().catch(() => home())
        }

        record.closedOnlyByKeyboard = /shortcut|Escape/.test(record.closedBy ?? '')

        // A Hermes surface that Hermes itself does not close all the way
        // (Advanced mode: Terminal, opened from a collapsed right column,
        // closes to a rail and leaves the column open) is judged against
        // bare Hermes, measured at the start of this check from the same
        // base: the row passes only if it changed the scene exactly as bare
        // Hermes' own shortcut and Hide did. Then the right column is folded
        // again with ⌘J twice, so the next row starts where this one did.
        const bareRef = entry.evidence.bareReference?.[label]

        if (!record.closedBy && bareRef?.end && (await pluginLoaded())) {
          const delta = (from, to) => JSON.stringify({ added: to.tabs.filter(tab => !from.tabs.includes(tab)), gone: from.tabs.filter(tab => !to.tabs.includes(tab)), hash: from.hash === to.hash, terminals: to.terminals, thread: to.thread, webviews: to.webviews })

          record.bareDelta = delta(bareRef.base, bareRef.end)
          record.ourDelta = delta(base, record.after)

          if (record.bareDelta === record.ourDelta) {
            record.closedBy = `${record.tried.at(-1)}, ending where bare Hermes ends (${record.bareDelta})`
            await refoldRight()
            record.afterRefold = same(base, await scene())
          }
        }

        if (!record.closedBy) {
          await shot(entry, `b2-${label.toLowerCase().replace(/\W+/g, '-')}-not-closed`)
          // Start the next row from Hermes' default layout and the chat, the
          // way a person would: "Reset layout" in the palette.
          await resetLayout()
          await toBase().catch(() => home())
          record.afterReset = same(base, await scene()) ? 'back where it started' : JSON.stringify(await scene())
        }

        must(record.menuClosed, `${label}: the menu stayed open after the row was clicked`)
        must(record.opened, `${label}: nothing changed on screen after the row was clicked`)
        must(!record.opened || record.closedBy, `${label}: could not get back to where it started (${JSON.stringify(record.after)})`)
      } catch (error) {
        must(false, `${label}: ${String(error.message).split('\n')[0]}`)
        await page.keyboard.press('Escape').catch(() => undefined)
      }
    }
  })

  // Whatever b2 could not close, the layout goes back to Hermes' default the
  // way a person would do it: "Reset layout" in the palette.
  if (!same(await scene(), results.checks.b2.evidence?.base ?? (await scene()))) {
    await resetLayout()
    await home()
    results.observations.push('b2: the layout was reset through the palette ("Reset layout") after b2 left something open')
  }

  // ── b3. Sidebar ──────────────────────────────────────────────────────────
  await check('b3', async (entry, must) => {
    await home()
    const edge = () => page.evaluate(`(${SHOWN})?.getBoundingClientRect().left ?? null`)
    const before = await edge()
    const hide = await press('button[aria-label="Hide sidebar"]')

    await sleep(700)

    const collapsed = await edge()

    await shot(entry, 'b3-collapsed')
    entry.evidence.topBandCollapsed = (await overlaps(INTERACTIVE, { within: { height: 40, width: 1220, x: 0, y: 0 } })).pairs

    const show = page.locator('button[aria-label="Show sidebar"]').filter({ visible: true }).first()

    entry.evidence.showButton = await show.count()

    if (entry.evidence.showButton) {
      await show.click()
    } else {
      await page.mouse.click(hide.x, hide.y)
    }

    await sleep(700)

    const after = await edge()

    Object.assign(entry.evidence, { threadLeftEdge: { before, collapsed, after } })
    await shot(entry, 'b3-expanded')
    must(before - collapsed > 150, `collapsing moved the thread's left edge from ${before} to ${collapsed}`)
    must(Math.abs(after - before) <= 1, `expanding brought the edge to ${after}, it was ${before}`)
    must(!entry.evidence.topBandCollapsed.length, `overlaps in the top band with the sidebar collapsed: ${JSON.stringify(entry.evidence.topBandCollapsed)}`)
  })

  // ── b4. New session, switch ──────────────────────────────────────────────
  await check('b4', async (entry, must) => {
    await home()
    await newSession()
    await type('First of two sessions, MGB_ONE.', 'Enter')
    await waitIdle('Done MGB_ONE.')
    await newSession()
    entry.evidence.newIsEmpty = await page.evaluate(`!((${SHOWN})?.textContent ?? '').includes('MGB_ONE')`)
    await type('Second of two sessions, MGB_TWO.', 'Enter')
    await waitIdle('Done MGB_TWO.')

    const shows = () => page.evaluate(`(() => { const t = (${SHOWN})?.textContent ?? ''; return { one: t.includes('Done MGB_ONE.'), two: t.includes('Done MGB_TWO.') } })()`)

    await page.locator('[data-slot="row-button"]', { hasText: 'MGB_ONE' }).first().click()
    await sleep(1200)
    entry.evidence.onOne = await shows()
    await page.locator('[data-slot="row-button"]', { hasText: 'MGB_TWO' }).first().click()
    await sleep(1200)
    entry.evidence.onTwo = await shows()
    await shot(entry, 'b4-back-on-two')
    must(entry.evidence.newIsEmpty, 'the new session still shows the first session\'s turn')
    must(entry.evidence.onOne.one && !entry.evidence.onOne.two, `on session one the thread shows ${JSON.stringify(entry.evidence.onOne)}`)
    must(entry.evidence.onTwo.two && !entry.evidence.onTwo.one, `on session two the thread shows ${JSON.stringify(entry.evidence.onTwo)}`)
  })

  // ── b5. Settings ─────────────────────────────────────────────────────────
  await check('b5', async (entry, must) => {
    await page.keyboard.press('Meta+,')
    await page.locator('[data-tour="nav-plugins"]').waitFor({ state: 'visible', timeout: 8000 })
    await page.locator('[data-tour="nav-plugins"]').click()
    await sleep(600)

    const entryButton = page.locator('button, a', { hasText: /^Monograph$/ }).filter({ visible: true }).first()

    entry.evidence.navEntries = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter(node => node.checkVisibility() && node.textContent.trim() === 'Monograph' && node.getBoundingClientRect().x < 300).length)
    await entryButton.click({ timeout: 5000 })
    await sleep(800)
    entry.evidence.url = page.url().replace(/^.*#/, '#')

    const pageText = await page.evaluate(() => (document.querySelector('main, [role="main"]') ?? document.body).innerText.slice(0, 600))

    entry.evidence.pageHas = { monograph: /Monograph/.test(pageText), showToolCalls: /Show tool calls/.test(pageText) }
    await shot(entry, 'b5-monograph-settings')

    const toggle = page.locator('[role="switch"]').filter({ visible: true })

    entry.evidence.switches = await toggle.count()

    // The tool-call switch, wherever the page puts it.
    const tools = page.locator('[id="monograph-tool-calls"], [role="switch"][aria-labelledby*="monograph-tool-calls"], label:has-text("Show tool calls") >> xpath=..//*[@role="switch"]').filter({ visible: true }).first()
    const target = (await tools.count()) ? tools : toggle.first()
    const before = await page.evaluate(() => document.documentElement.dataset.mgTools)

    if (await target.count()) {
      await target.click()
      await sleep(400)
      entry.evidence.toolsAfterClick = await page.evaluate(() => document.documentElement.dataset.mgTools)
      await target.click()
      await sleep(400)
      entry.evidence.toolsAfterSecondClick = await page.evaluate(() => document.documentElement.dataset.mgTools)
    }

    await press('button[aria-label="Close settings"]').catch(() => page.keyboard.press('Escape'))
    await sleep(600)
    must(entry.evidence.navEntries === 1, `Settings lists ${entry.evidence.navEntries} "Monograph" entries`)
    must(entry.evidence.pageHas.monograph, 'the Monograph settings page shows no "Monograph"')
    must(entry.evidence.switches > 0, 'the Monograph settings page has no switch')
    must(entry.evidence.toolsAfterClick && entry.evidence.toolsAfterClick !== before, `a click on the first switch left data-mg-tools at ${entry.evidence.toolsAfterClick} (was ${before})`)
    must(entry.evidence.toolsAfterSecondClick === before, `a second click left data-mg-tools at ${entry.evidence.toolsAfterSecondClick}`)
  })

  // ── b6. Model menu ───────────────────────────────────────────────────────
  await check('b6', async (entry, must) => {
    await home()
    await press('button:is([data-tour="model-pill"], [aria-label^="Model · "])')
    await sleep(800)

    const menu = await page.evaluate(() => {
      const content = [...document.querySelectorAll('[data-slot="dropdown-menu-content"]')].find(node => node.checkVisibility())

      if (!content) {
        return null
      }

      return [...content.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [data-slot="dropdown-menu-sub-trigger"], [data-slot="dropdown-menu-item"]')]
        .filter(row => row.checkVisibility())
        .map(row => {
          const logo = row.querySelector('.mg-logo')
          const rect = logo?.getBoundingClientRect()

          return {
            logo: logo ? `${logo.dataset.logo} ${Math.round(rect.width)}x${Math.round(rect.height)} ${getComputedStyle(logo).backgroundImage === 'none' ? 'NO IMAGE' : 'image'}` : null,
            text: (row.textContent ?? '').trim().slice(0, 40)
          }
        })
    })

    entry.evidence.rows = menu
    await shot(entry, 'b6-model-menu')
    await page.keyboard.press('Escape')
    await sleep(300)
    must(menu, 'no model menu opened')

    for (const [vendor, needle] of [['claude', /claude|sonnet|opus|haiku/i], ['openai', /gpt/i], ['deepseek', /deepseek/i]]) {
      const row = menu?.find(item => needle.test(item.text))

      must(row, `no ${vendor} row in the model menu`)
      must(!row || (row.logo?.startsWith(vendor) && row.logo.includes('image') && !/ 0x| x0/.test(row.logo)), `the ${vendor} row has logo ${row?.logo}`)
    }
  })

  // ── b7. Effort slider ────────────────────────────────────────────────────
  await check('b7', async (entry, must) => {
    await home()
    const pill = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="reasoning-pill"]')].find(node => node.checkVisibility())?.getAttribute('aria-label'))

    // Hermes draws no effort pill in a narrow message box (compactModelPill in
    // apps/desktop/src/app/chat/composer/controls.tsx): a pane left open by an
    // earlier check narrows the chat enough. Say so, put the layout back, and
    // only then judge; a pill still missing in a wide box is a failure.
    const box = () => page.evaluate(() => {
      const root = [...document.querySelectorAll('[data-slot="composer-root"]')].find(node => node.checkVisibility())

      return { composerWidth: root ? Math.round(root.getBoundingClientRect().width) : null, pills: document.querySelectorAll('[data-testid="reasoning-pill"]').length }
    })

    entry.evidence.start = { ...(await box()), pill: (await pill()) ?? null }

    if (!entry.evidence.start.pill) {
      await resetLayout()
      await home()
      entry.evidence.afterReset = { ...(await box()), pill: (await pill()) ?? null }
      results.observations.push(`b7: no effort pill on screen at the start (message box ${entry.evidence.start.composerWidth} px wide); the layout was reset first (${entry.evidence.afterReset.composerWidth} px after)`)

      // Advanced mode's default layout keeps Files, Review and Terminal on the
      // right: hide that column (Cmd+J, view.toggleRightSidebar) for room.
      if (!entry.evidence.afterReset.pill) {
        await page.keyboard.press('Meta+j')
        await sleep(700)
        entry.evidence.afterRightColumnHidden = { ...(await box()), pill: (await pill()) ?? null }
        results.observations.push(`b7: still no pill after the reset; the right column was hidden (Cmd+J): message box ${entry.evidence.afterRightColumnHidden.composerWidth} px`)
      }
    }

    entry.evidence.before = await pill()
    await press('[data-testid="reasoning-pill"]')
    await sleep(600)

    const group = await page.evaluate(() => {
      const node = [...document.querySelectorAll('[data-slot="dropdown-menu-content"] > [data-slot="dropdown-menu-radio-group"]')].find(item => item.checkVisibility())
      const rect = node?.getBoundingClientRect()

      return node ? { levels: [...node.children].map(child => child.textContent.trim()), rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y } } : null
    })

    entry.evidence.group = group
    await shot(entry, 'b7-effort-open')

    if (!group) {
      must(false, 'the effort menu did not open as a slider')

      return
    }

    const checked = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="dropdown-menu-content"] > [data-slot="dropdown-menu-radio-group"] > [aria-checked="true"]')].map(node => node.textContent.trim()))
    const y = group.rect.y + group.rect.height / 2
    const seen = []

    await page.mouse.move(group.rect.x + 4, y)
    await page.mouse.down()

    for (let step = 0; step <= 12; step++) {
      await page.mouse.move(group.rect.x + 4 + ((group.rect.width - 8) * step) / 12, y, { steps: 3 })
      await sleep(40)
      seen.push((await checked()).join('|'))
    }

    await page.mouse.up()
    await sleep(300)

    const levelsSeen = [...new Set(seen)]

    entry.evidence.levelsDuringDrag = levelsSeen
    entry.evidence.menuStillOpen = (await menusOpen()).length > 0
    await shot(entry, 'b7-effort-after-drag')
    await page.keyboard.press('Escape')
    await sleep(300)
    entry.evidence.after = await pill()
    must(levelsSeen.length >= Math.min(3, group.levels.length), `a drag from end to end passed through ${levelsSeen.length} level(s): ${levelsSeen.join(', ')}`)
    must(levelsSeen.at(-1) === group.levels.at(-1), `the drag ended on ${levelsSeen.at(-1)}, not the last level ${group.levels.at(-1)}`)
    must(entry.evidence.after !== entry.evidence.before, `the pill still reads ${entry.evidence.after}`)
  })

  // ── b8. Palette ──────────────────────────────────────────────────────────
  await check('b8', async (entry, must) => {
    await home()
    const first = await toggleToolsFromPalette('enter')
    const second = await toggleToolsFromPalette('enter')
    // The same row pressed with the pointer, for comparison.
    const clicked = await toggleToolsFromPalette('click')

    await shot(entry, 'b8-after-clicking-the-row')

    if (clicked.after !== clicked.before) {
      await toggleToolsFromPalette('click')
    }

    const hermesRow = await hermesToggleByClick()

    Object.assign(entry.evidence, { clicked, first, hermesRow, second, menusOpen: await menusOpen(), toolsAtEnd: await page.evaluate(() => document.documentElement.dataset.mgTools) })
    must(first.rows.length === 1, `the palette lists ${first.rows.length} "Toggle tool calls" row(s)`)
    must(first.before === 'shown' && first.after === 'hidden', `Enter on the row: ${first.before} → ${first.after} (the attribute changed ${first.flips} time(s))`)
    must(clicked.after !== clicked.before, `a click on the row: ${clicked.before} → ${clicked.after} (the attribute changed ${clicked.flips} time(s))`)
    must(second.before === 'hidden' && second.after === 'shown', `second toggle: ${second.before} → ${second.after}`)
    must(!first.stillOpenAfterEnter || /off$/.test(first.rowAfter ?? ''), `the row's state reads ${JSON.stringify(first.rowAfter)} after turning tool calls off`)
    must(clicked.flips === 1, `a click on the row changed the attribute ${clicked.flips} time(s), expected once`)
    // Hermes' own toggle rows stay open after running (keepOpen, paletteToggle
    // in app/command-palette/contrib.ts); ours must behave the same, by Enter
    // and by click.
    must(hermesRow.changed, `the reference, a click on Hermes' own "${hermesRow.label}" row, changed nothing (${hermesRow.before} → ${hermesRow.after}): the click itself does not reach palette rows`)
    must(first.stillOpenAfterEnter === hermesRow.stillOpenAfterClick && clicked.stillOpenAfterEnter === hermesRow.stillOpenAfterClick, `after running, the palette is ${first.stillOpenAfterEnter ? 'open' : 'closed'} (Enter) and ${clicked.stillOpenAfterEnter ? 'open' : 'closed'} (click) for our row, ${hermesRow.stillOpenAfterClick ? 'open' : 'closed'} for Hermes' own toggle row`)
    must(!entry.evidence.menusOpen.length, `left open: ${entry.evidence.menusOpen}`)
  })

  // A turn with reasoning, a note and a tool call, sampled while it streams.
  const workTurn = async tag => {
    await type(`Some work please, ${tag}. MGS_WORK`, 'Enter')

    const samples = []
    const until = Date.now() + 30_000

    while (Date.now() < until) {
      const sample = await page.evaluate(`((running, done) => {
        const v = ${SHOWN}
        const pair = v ? [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1) : null
        const shown = selector => (pair ? [...pair.querySelectorAll(selector)].filter(node => node.checkVisibility() && node.getBoundingClientRect().height > 0).length : 0)

        return { done: Boolean(pair?.textContent.includes(done)), running: Boolean(pair?.querySelector(running)), summaries: shown('[data-tool-summary]'), thinking: shown('[data-slot="aui_thinking-disclosure"]'), tools: shown('[data-slot="tool-block"]') }
      })(${JSON.stringify(RUNNING)}, ${JSON.stringify(`${tag} MGS_WORK_DONE`)})`)

      samples.push(sample)

      // Over once the answer is there and nothing runs.
      if (sample.done && !sample.running) {
        break
      }

      await sleep(80)
    }

    await waitIdle(`${tag} MGS_WORK_DONE`)
    await sleep(1500)

    const live = samples.filter(sample => sample.running)

    return { live: live.length, thinkingSeen: live.filter(sample => sample.thinking).length, toolsSeen: live.filter(sample => sample.tools).length, summariesSeen: live.filter(sample => sample.summaries).length }
  }

  // ── b9. Tools shown: thinking while streaming ────────────────────────────
  await check('b9', async (entry, must) => {
    await home()
    await newSession()
    entry.evidence.tools = await page.evaluate(() => document.documentElement.dataset.mgTools)
    entry.evidence.stream = await workTurn('MGB_SHOWN')
    await shot(entry, 'b9-shown-after')
    must(entry.evidence.stream.live > 3, `the turn was seen running in only ${entry.evidence.stream.live} sample(s)`)
    must(entry.evidence.stream.thinkingSeen > 0, `thinking was never on screen while the reply streamed (${entry.evidence.stream.live} samples while running)`)
    must(entry.evidence.stream.toolsSeen > 0, 'no tool row was on screen while the reply streamed')
  })

  // ── b10. Tools hidden ────────────────────────────────────────────────────
  await check('b10', async (entry, must) => {
    const off = await toggleToolsFromPalette('enter')

    entry.evidence.toggled = `${off.before} → ${off.after}`

    // The finished turn from b9, now hidden.
    entry.evidence.finished = await page.evaluate(`(() => {
      const v = ${SHOWN}
      const pair = v ? [...v.querySelectorAll('[data-slot="aui_turn-pair"]')].at(-1) : null
      const shown = selector => (pair ? [...pair.querySelectorAll(selector)].filter(node => node.checkVisibility() && node.getBoundingClientRect().height > 0).length : 0)
      const head = pair?.querySelector('[data-mg-head]')

      return {
        line: head?.previousElementSibling?.classList.contains('mg-line') ? head.previousElementSibling.innerText : null,
        summaries: shown('[data-tool-summary]'),
        thinking: shown('[data-slot="aui_thinking-disclosure"]'),
        tools: shown('[data-slot="tool-block"]')
      }
    })()`)
    // A fresh session: the model answers MGS_WORK without a tool call once the
    // conversation already holds one (b9's).
    await newSession()
    entry.evidence.streaming = await workTurn('MGB_HIDDEN')
    await shot(entry, 'b10-hidden-after-turn')

    await type('Something risky, MGB_APPROVE. MGS_CALL(terminal)[{"command":"rm -rf /tmp/hermes-e2e-approval-probe"}]', 'Enter')

    const card = await page
      .locator('[data-slot="tool-approval-card"], [data-slot="tool-approval-stack"]')
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false)

    entry.evidence.approvalShown = card
    await shot(entry, 'b10-approval-with-tools-hidden')

    if (card) {
      const deny = page.locator('[data-slot="tool-approval-actions"] button', { hasText: /deny|reject|no/i }).filter({ visible: true }).first()

      entry.evidence.approvalButtons = await page.evaluate(() => [...document.querySelectorAll('[data-slot="tool-approval-actions"] button')].map(button => button.textContent.trim()))

      if (await deny.count()) {
        await deny.click()
      } else {
        await page.locator('button[aria-label="Stop"]').filter({ visible: true }).first().click()
      }
    } else {
      await page.locator('button[aria-label="Stop"]').filter({ visible: true }).first().click().catch(() => undefined)
    }

    await page.waitForFunction(running => !document.querySelector(running), RUNNING, { timeout: 30_000 }).catch(() => undefined)

    const back = await toggleToolsFromPalette('enter')

    entry.evidence.toggledBack = `${back.before} → ${back.after}`
    must(off.after === 'hidden', `tools did not turn hidden (${entry.evidence.toggled})`)
    must(!entry.evidence.finished.tools && !entry.evidence.finished.thinking && !entry.evidence.finished.summaries, `a finished turn still shows work with tools hidden: ${JSON.stringify(entry.evidence.finished)}`)
    must(!/tool call|message/.test(entry.evidence.finished.line ?? ''), `the line above the answer still counts the work: ${entry.evidence.finished.line}`)
    must(entry.evidence.streaming.live > 3, 'the hidden-tools turn was never seen running')
    must(!entry.evidence.streaming.thinkingSeen && !entry.evidence.streaming.toolsSeen && !entry.evidence.streaming.summariesSeen, `work showed while streaming with tools hidden: ${JSON.stringify(entry.evidence.streaming)}`)
    must(card, 'no approval card appeared for a command that needs approval, with tools hidden')
    must(back.after === 'shown', `tools did not come back (${entry.evidence.toggledBack})`)
  })

  // ── b11. Long prompts ────────────────────────────────────────────────────
  await check('b11', async (entry, must) => {
    const long = n => Array.from({ length: n }, (_, index) => `Line ${index + 1} of a long prompt that should fold to four lines in the thread.`).join(' ')
    const own = `${long(14)} MGB_LONG.`

    await newSession()
    await type(own, 'Enter')
    await waitIdle('Done MGB_LONG.')

    const fold = selector =>
      page.evaluate(selector => {
        const node = [...document.querySelectorAll(selector)].filter(item => item.checkVisibility()).at(-1)
        const clamp = node?.querySelector('.sticky-human-clamp, [data-mg-clamp]')
        const text = node?.querySelector('[data-slot="aui_user-message-text"]')
        const lineHeight = text ? parseFloat(getComputedStyle(text).lineHeight) : null

        return node
          ? {
              clamped: clamp?.dataset.clamped ?? null,
              classed: clamp?.classList.contains('sticky-human-clamp') ?? false,
              height: Math.round(clamp?.getBoundingClientRect().height ?? node.getBoundingClientRect().height),
              lineHeight,
              lines: lineHeight ? +((clamp?.getBoundingClientRect().height ?? 0) / lineHeight).toFixed(1) : null,
              long: 'mgLong' in node.dataset,
              full: text ? Math.round(text.scrollHeight) : null
            }
          : null
      }, selector)

    await markOnScreen()
    entry.evidence.hermes = await fold('[data-rig-onscreen] [data-slot="aui_user-message-root"]:not([data-mg-queued])')
    await shot(entry, 'b11-own-long-prompt')

    // Hermes' own: a press opens the edit box with the whole prompt. Hermes
    // can only edit a prompt it has stored: right after the turn the row may
    // still be the optimistic copy (id "user-<uuid>"), and a press there opens
    // nothing, with or without Monograph. Wait for the stored row
    // ("<timestamp>-<n>-user") that replaces it.
    // The swap can remount the thread in a new viewport, which has no rig
    // mark yet, so the viewport on screen is looked up on every poll.
    const promptId = () =>
      page.evaluate(
        viewport => [...(([...document.querySelectorAll(viewport)].find(node => node.getBoundingClientRect().height > 0))?.querySelectorAll('[data-slot="aui_user-message-root"]:not([data-mg-queued])') ?? [])].at(-1)?.dataset.messageId ?? null,
        VIEWPORT
      )

    entry.evidence.promptIdAfterTurn = await promptId()

    for (const until = Date.now() + 15_000; Date.now() < until && !/^\d+(\.\d+)?-\d+-user$/.test((await promptId()) ?? ''); ) {
      await sleep(150)
    }

    await markOnScreen()
    entry.evidence.promptIdAtPress = await promptId()

    const bubble = page.locator('[data-rig-onscreen] [data-slot="aui_user-message-root"]:not([data-mg-queued]) button[aria-label="Edit message"]').last()

    // What the press met (b11 diagnostics): a text selection swallows it in
    // Hermes, a remount drops an editor that opened; sampled every 50 ms.
    entry.evidence.beforePress = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('[data-rig-onscreen] [data-slot="aui_user-message-root"]:not([data-mg-queued]) button[aria-label="Edit message"]')]
      const target = buttons.at(-1)

      document.querySelectorAll('[data-rig-target]').forEach(node => node.removeAttribute('data-rig-target'))
      target?.setAttribute('data-rig-target', '')

      const box = target?.getBoundingClientRect()
      const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null

      return {
        buttons: buttons.length,
        visible: buttons.map(node => node.checkVisibility()),
        selection: String(window.getSelection() ?? '').slice(0, 60),
        hitInside: Boolean(hit && target?.contains(hit)),
        hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}` : null
      }
    })
    await bubble.click()

    const editorTrace = []

    for (let step = 0; step < 12; step += 1) {
      editorTrace.push(
        await page.evaluate(needle => {
          const open = [...document.querySelectorAll('[contenteditable="true"], textarea')].some(node => node.checkVisibility() && (node.textContent || node.value || '').includes(needle))
          const target = document.querySelector('[data-rig-target]')

          return `${open ? 'E' : '-'}${target ? (target.isConnected ? 'c' : 'x') : 'g'}`
        }, 'Line 14 of a long prompt')
      )
      await sleep(50)
    }

    entry.evidence.editorTrace = editorTrace.join(' ')
    entry.evidence.hermesOpened = await page.evaluate(needle => [...document.querySelectorAll('[contenteditable="true"], textarea')].some(node => node.checkVisibility() && (node.textContent || node.value || '').includes(needle)), 'Line 14 of a long prompt')
    await shot(entry, 'b11-own-long-prompt-opened')
    await page.keyboard.press('Escape')
    await sleep(400)

    // The queued copy (Monograph's).
    await type('Hold for the queue, MGB_QHOLD. MGS_HOLD', 'Enter')
    await Promise.race([state.mock.waitForHeldStream(), sleep(20_000)])
    await page.waitForFunction(running => Boolean(document.querySelector(running)), RUNNING, { timeout: 10_000 }).catch(() => undefined)
    await type(`${long(12)} MGB_QLONG.`, 'Control+Enter')
    await sleep(500)
    state.mock.releaseHeldStream()
    await markOnScreen()
    await page.locator('[data-rig-onscreen] [data-mg-queued]').first().waitFor({ timeout: 30_000 }).catch(() => undefined)
    await sleep(500)
    entry.evidence.queued = await fold('[data-rig-onscreen] [data-mg-queued]')
    await shot(entry, 'b11-queued-long-prompt')

    if (entry.evidence.queued) {
      await page.locator('[data-rig-onscreen] [data-mg-queued] [data-slot="aui_user-message-text"]').first().click()
      await sleep(400)
      entry.evidence.queuedOpened = await fold('[data-rig-onscreen] [data-mg-queued]')
      await page.locator('[data-rig-onscreen] [data-mg-queued] [data-slot="aui_user-message-text"]').first().click()
      await sleep(400)
      entry.evidence.queuedClosedAgain = await fold('[data-rig-onscreen] [data-mg-queued]')
    }

    await waitIdle('Done MGB_QLONG.').catch(() => undefined)

    // This Hermes may draw the queued prompt itself; then Monograph's copy is
    // rightly never made, and Hermes' own row must fold like any long prompt.
    if (!entry.evidence.queued) {
      await markOnScreen()
      entry.evidence.queuedDrawnByHermes = await page.evaluate(() => [...document.querySelectorAll('[data-rig-onscreen] [data-slot="aui_user-message-root"]')].filter(node => node.textContent.includes('MGB_QLONG')).length)
      entry.evidence.queuedHermesFold = await fold('[data-rig-onscreen] [data-slot="aui_user-message-root"]:not([data-mg-queued]):has([data-slot="aui_user-message-text"])')
      results.observations.push(`b11: no Monograph copy of the queued prompt; Hermes drew it ${entry.evidence.queuedDrawnByHermes} time(s) itself, so queuedBubbles() had nothing to do in this run`)
    }

    const four = info => info && info.lines !== null && info.lines <= 4.6 && info.lines >= 3
    must(four(entry.evidence.hermes), `Hermes' own long prompt shows ${entry.evidence.hermes?.lines} lines, expected about four`)
    must(entry.evidence.hermesOpened, `pressing Hermes' own long prompt did not open it in full (prompt row ${entry.evidence.promptIdAtPress})`)
    must(entry.evidence.queued || entry.evidence.queuedDrawnByHermes === 1, `the long queued prompt is drawn ${entry.evidence.queuedDrawnByHermes ?? 0} time(s) by Hermes and has no Monograph copy`)
    must(entry.evidence.queued || four(entry.evidence.queuedHermesFold), `Hermes' row for the long queued prompt is not folded to four lines: ${JSON.stringify(entry.evidence.queuedHermesFold)}`)
    must(!entry.evidence.queued || (entry.evidence.queued.long && four(entry.evidence.queued)), `the queued copy is not folded to four lines: ${JSON.stringify(entry.evidence.queued)}`)
    must(!entry.evidence.queuedOpened || entry.evidence.queuedOpened.height >= entry.evidence.queuedOpened.full - 2, `a press did not open the queued copy: ${JSON.stringify(entry.evidence.queuedOpened)}`)
    must(!entry.evidence.queuedClosedAgain || four(entry.evidence.queuedClosedAgain), `a second press did not fold it again: ${JSON.stringify(entry.evidence.queuedClosedAgain)}`)
  })

  // ── b12. Copy ────────────────────────────────────────────────────────────
  await check('b12', async (entry, must) => {
    const takeClips = async () => [...(await app.evaluate(() => globalThis.__rigClipboard.splice(0))), ...(await page.evaluate(() => (window.__rigClipboard ?? []).splice(0)))]

    if (!clipboardPatched) {
      throw new Error('the app\'s clipboard could not be redirected, so nothing is copied (the system clipboard is not the rig\'s to write)')
    }

    await takeClips()
    await newSession()
    await type('Copy this prompt, MGB_COPY.', 'Enter')
    await waitIdle('Done MGB_COPY.')

    // Ours: the copy button beside a prompt's time, shown on hover.
    const prompt = page.locator('[data-slot="aui_user-message-root"]', { hasText: 'MGB_COPY' }).filter({ visible: true }).last()

    await prompt.hover()
    await sleep(300)

    const ours = prompt.locator('.mg-ucopy')

    entry.evidence.ourButtons = await ours.count()

    if (entry.evidence.ourButtons) {
      await ours.first().click()
      await sleep(400)
    }

    entry.evidence.oursCopied = await takeClips()
    entry.evidence.doneMark = await prompt.locator('.mg-ucopy[data-done]').count()

    // Hermes' own copy under a reply.
    const reply = page.locator('[data-slot="aui_assistant-message-root"]', { hasText: 'Done MGB_COPY.' }).filter({ visible: true }).last()

    await reply.hover()
    await sleep(300)

    const theirs = reply.locator('button[aria-label="Copy"]').filter({ visible: true }).first()

    if (await theirs.count()) {
      await theirs.click()
      await sleep(400)
    }

    entry.evidence.replyCopied = await takeClips()
    must(entry.evidence.ourButtons === 1, `the prompt has ${entry.evidence.ourButtons} Monograph copy button(s)`)
    must(entry.evidence.oursCopied.includes('Copy this prompt, MGB_COPY.'), `the prompt's copy button copied ${JSON.stringify(entry.evidence.oursCopied)}`)
    must(entry.evidence.replyCopied.some(text => text.includes('Done MGB_COPY.')), `the reply's copy button copied ${JSON.stringify(entry.evidence.replyCopied)}`)
  })

  // ── b13. Widths and zoom ─────────────────────────────────────────────────
  await check('b13', async (entry, must) => {
    await home()
    entry.evidence.layouts = {}

    for (const zoom of [0.9, 1, 1.25]) {
      for (const width of [800, 900, 1220, 1800]) {
        const name = `${width}@${zoom}`
        const size = await setWindow({ height: 800, width, zoom })
        const sidebarRight = await page.evaluate(`(${SHOWN})?.getBoundingClientRect().left ?? 0`)
        const top = await overlaps(INTERACTIVE, { within: { height: 40, width: 4000, x: 0, y: 0 } })
        const sidebar = sidebarRight > 40 ? await overlaps(INTERACTIVE, { within: { height: 80, width: sidebarRight, x: 0, y: 0 } }) : { pairs: [] }
        const composer = await overlaps(INTERACTIVE, { within: '[data-slot="composer-root"]' })
        const problems = await layoutProblems()
        // The native window buttons are not in the page; the plugin publishes
        // where they end (--mg-lights-x) and their centre line (--mg-lights-y).
        const lights = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement)

          return { x: parseFloat(root.getPropertyValue('--mg-lights-x')) || 82, y: parseFloat(root.getPropertyValue('--mg-lights-y')) || 17 }
        })
        const underLights = (await overlaps(INTERACTIVE, { within: { height: lights.y * 2 - 6, width: lights.x - 6, x: 6, y: 3 } })).seen
        const underLightsNames = underLights
          ? await page.evaluate(({ x, y }) => [...new Set([6, 20, 34, 48, 62].filter(px => px < x - 6).map(px => document.elementFromPoint(px, y)?.closest('button, [role="tab"], [data-slot="pane-tab"], a')).filter(Boolean).map(node => node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 20)))], lights)
          : []
        const pairs = [...top.pairs, ...sidebar.pairs, ...composer.pairs]
        const unique = [...new Map(pairs.map(pair => [`${pair.a}|${pair.b}`, pair])).values()]

        // The zoom factor the rig set is the truth; outerWidth / innerWidth
        // (what the plugin reads) is what is under test.
        const expected = { x: +(82 / zoom).toFixed(1), y: +(17 / zoom).toFixed(1) }

        must(Math.abs(expected.x - lights.x) <= 1 && Math.abs(expected.y - lights.y) <= 1, `${name}: the plugin places the corner row for zoom ${(82 / lights.x).toFixed(2)} (--mg-lights-x ${lights.x}px, --mg-lights-y ${lights.y}px), the page is at zoom ${zoom} (expected ${expected.x}px, ${expected.y}px; outerWidth/innerWidth reads ${size.zoom})`)
        entry.evidence.layouts[name] = { inner: size.inner, lights: `${lights.x},${lights.y} (expected ${expected.x},${expected.y})`, underWindowButtons: underLightsNames, overlaps: unique.map(pair => `${pair.a} × ${pair.b} (${pair.overlap})`), hScroll: problems.hScroll, clippedText: problems.clippedText, truncated: problems.truncated.length }

        if (unique.length || problems.hScroll.length || problems.clippedText.length || [1220, 800].includes(width)) {
          await shot(entry, `b13-${width}-${String(zoom).replace('.', '_')}`)
        }

        must(!unique.length, `${name}: ${unique.length} overlap(s): ${unique.slice(0, 3).map(pair => `${pair.a} × ${pair.b} ${pair.overlap}`).join('; ')}`)
        must(!underLightsNames.length, `${name}: under the native window buttons (0-${Math.round(lights.x)} px, centre ${Math.round(lights.y)} px): ${underLightsNames.join(', ')}`)
        must(!problems.hScroll.length, `${name}: horizontal scrollbar: ${problems.hScroll.slice(0, 2).join('; ')}`)
        must(!problems.clippedText.length, `${name}: text cut off in a button: ${problems.clippedText.slice(0, 3).join('; ')}`)
      }
    }

    await setWindow({ height: 800, width: 1220, zoom: 1 })
  })

  // ── b13b. The narrow sizes on bare Hermes, for attribution ───────────────
  await check('b13b', async (entry, must) => {
    const landmarks = () =>
      page.evaluate(`(() => {
        const out = {}
        const box = node => {
          const r = node?.getBoundingClientRect()

          return r ? { bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) } : null
        }
        const composer = [...document.querySelectorAll('[data-slot="composer-root"]')].find(node => node.checkVisibility())

        out.window = innerWidth + 'x' + innerHeight
        out.thread = box(${SHOWN})
        out.composer = box(composer)
        out.composerOnScreen = Boolean(composer) && box(composer).bottom <= innerHeight && box(composer).right <= innerWidth && box(composer).left >= 0
        out.threadInside = Boolean(${SHOWN}) && box(${SHOWN}).right <= innerWidth + 1

        return out
      })()`)

    entry.evidence.withMonograph = {}
    entry.evidence.bare = {}

    for (const zoom of [1, 1.25]) {
      await setWindow({ height: 800, width: 800, zoom })
      entry.evidence.withMonograph[`800@${zoom}`] = await landmarks()
    }

    await hotReload({ gone: true, source: stubPlugin() })

    try {
      for (const zoom of [1, 1.25]) {
        await setWindow({ height: 800, width: 800, zoom })
        entry.evidence.bare[`800@${zoom}`] = await landmarks()
        await shot(entry, `b13b-bare-800-${String(zoom).replace('.', '_')}`)
      }
    } finally {
      await setWindow({ height: 800, width: 1220, zoom: 1 })
      await hotReload()
    }

    for (const [name, seen] of Object.entries(entry.evidence.withMonograph)) {
      const bare = entry.evidence.bare[name]

      must(seen.composerOnScreen || !bare?.composerOnScreen, `${name}: the message box is off screen with Monograph (${JSON.stringify(seen.composer)}) and on screen without it`)
      must(seen.threadInside || !bare?.threadInside, `${name}: the thread runs past the window's right edge with Monograph (${JSON.stringify(seen.thread)}) and not without it`)
    }
  })

  // ── b14. Hot reload ──────────────────────────────────────────────────────
  await check('b14', async (entry, must) => {
    await home()
    await instrumentHooks()

    const census = async () => {
      const counts = await page.evaluate(() => ({
        styles: document.querySelectorAll('style#mg-css').length,
        ownedStyles: document.querySelectorAll('style[data-owner]').length,
        surfacesButtons: document.querySelectorAll('[data-tour="mg-surfaces"]').length,
        approvalChips: document.querySelectorAll('.mg-chip[data-mg-approval]').length,
        // One chip per message box: Hermes keeps other tabs' composers mounted.
        composers: document.querySelectorAll('[data-slot="composer-root"]').length,
        composersWithTwoChips: [...document.querySelectorAll('[data-slot="composer-root"]')].filter(node => node.querySelectorAll('.mg-chip[data-mg-approval]').length > 1).length,
        userCopyButtons: document.querySelectorAll('.mg-ucopy').length,
        userBubblesWithTime: document.querySelectorAll('[data-slot="aui_user-bubble-actions"] time').length,
        modules: document.documentElement.dataset.mgModules ?? null,
        ready: document.documentElement.dataset.mgReady ?? null
      }))

      await openSurfaces()
      counts.surfaceRows = (await surfaceRows()).length
      await page.mouse.click(5, 790)
      await sleep(300)
      await openPalette()
      await page.keyboard.insertText('Toggle tool calls')
      await sleep(300)
      counts.paletteRows = await page.evaluate(() => [...document.querySelectorAll('[data-slot="command-item"]')].filter(node => node.checkVisibility() && /Toggle tool calls/.test(node.textContent ?? '')).length)
      await page.keyboard.press('Escape')
      await sleep(300)
      await press('button:is([data-tour="model-pill"], [aria-label^="Model · "])')
      await sleep(600)
      counts.logosInModelMenu = await page.evaluate(() => [...document.querySelectorAll('[data-slot="dropdown-menu-content"] .mg-logo')].filter(node => node.checkVisibility()).length)
      await page.keyboard.press('Escape')
      await sleep(300)

      return { ...counts, hooks: await measureHooks() }
    }

    const mark = consoleEvents.length
    const first = await hotReload()
    const baseline = await census()
    const times = [first.ms]

    for (let round = 2; round <= 5; round++) {
      times.push((await hotReload()).ms)
    }

    const last = await census()
    const errors = consoleErrorsSince(mark)

    entry.evidence.reloadMs = times
    entry.evidence.afterFirst = baseline
    entry.evidence.afterFifth = last
    await shot(entry, 'b14-after-five-reloads')

    for (const key of ['styles', 'ownedStyles', 'surfacesButtons', 'approvalChips', 'surfaceRows', 'paletteRows', 'logosInModelMenu', 'modules', 'ready']) {
      must(baseline[key] === last[key], `${key}: ${baseline[key]} after the first reload, ${last[key]} after the fifth`)
    }

    must(last.styles === 1 && last.ownedStyles === 1, `${last.styles} #mg-css style element(s), ${last.ownedStyles} owned`)
    must(last.surfacesButtons === 1 && last.approvalChips <= last.composers && last.composersWithTwoChips === 0 && last.paletteRows === 1, `duplicates: ${last.surfacesButtons} surfaces buttons, ${last.approvalChips} approval chips for ${last.composers} message boxes (${last.composersWithTwoChips} with two), ${last.paletteRows} palette rows`)
    must(last.userCopyButtons === last.userBubblesWithTime, `${last.userCopyButtons} copy buttons for ${last.userBubblesWithTime} prompts`)

    const grew = []

    for (const [target, info] of Object.entries(last.hooks.listeners)) {
      for (const [kind, count] of Object.entries(info.byType)) {
        const was = baseline.hooks.listeners[target]?.byType[kind] ?? 0

        if (count > was) {
          grew.push(`${target} ${kind} listeners ${was} → ${count}`)
        }
      }
    }

    for (const [kind, count] of Object.entries(last.hooks.observing ?? {})) {
      const was = baseline.hooks.observing?.[kind] ?? 0

      if (count > was) {
        grew.push(`${kind} observing ${was} → ${count}`)
      }
    }

    if (last.hooks.intervals > baseline.hooks.intervals) {
      grew.push(`intervals ${baseline.hooks.intervals} → ${last.hooks.intervals}`)
    }

    entry.evidence.grew = grew
    entry.evidence.liveObjects = { first: baseline.hooks.liveObjects, fifth: last.hooks.liveObjects, heapMB: [baseline.hooks.heapMB, last.hooks.heapMB] }
    must(!grew.length, `grew over four reloads: ${grew.join('; ')}`)
    must(!errors.length, `${errors.length} console error(s) during the reloads: ${errors.slice(0, 2).map(event => event.text.slice(0, 120)).join(' | ')}`)
  })

  // ── b15. Sidebar swap ────────────────────────────────────────────────────
  // With the sidebar on the right, the main zone's tab strip sits in the
  // title band under the native window buttons and the corner row, and must
  // start clear of them. Hermes measures those zones again only on a resize
  // or a route change; the plugin tells it after a swap
  // (hermes:titlebar-chrome-changed). Measured two frames after the key, with
  // no resize in between. Self-test: the same swap with that event dropped
  // must be caught.
  await check('b15', async (entry, must) => {
    await home()

    const measure = () =>
      page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        const lightsX = parseFloat(root.getPropertyValue('--mg-lights-x')) || 82
        const shown = node => node.checkVisibility() && node.getBoundingClientRect().width > 4
        const tabs = [...document.querySelectorAll('[data-slot="pane-tab"]')].filter(node => shown(node) && !/^(Sessions|Bots)$/.test(node.textContent.trim()) && node.getBoundingClientRect().top < 40)
        const first = tabs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
        const corner = [...document.querySelectorAll('[data-titlebar-cluster="left"] button')].filter(shown).map(node => node.getBoundingClientRect())
        const cornerRight = Math.round(Math.max(0, ...corner.filter(rect => rect.top < 40).map(rect => rect.right)))
        const sidebar = document.querySelector('[data-tour="sessions-sidebar"]')
        const left = first ? Math.round(first.getBoundingClientRect().left) : null
        const clear = Math.max(Math.round(lightsX), cornerRight)
        // Where the main zone (the one holding the tabs) starts: only a zone
        // that starts under the corner can have its tabs drawn there.
        const zone = first?.closest('[data-tree-group], [data-group-id], [data-slot="pane-group"]') ?? first?.parentElement?.parentElement
        const zoneLeft = zone ? Math.round(zone.getBoundingClientRect().left) : null

        return { clear, cornerRight, firstTab: first ? { left, text: first.textContent.trim().slice(0, 24) } : null, lightsX: Math.round(lightsX), side: sidebar?.classList.contains('border-l') ? 'right' : 'left', tabUnderCorner: left !== null && left < clear - 1, zoneLeft }
      })
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 100)))))
    const swap = async () => {
      await page.keyboard.press('Meta+Backslash')
      await frames()

      return measure()
    }

    entry.evidence.before = await measure()
    entry.evidence.swapped = await swap()
    await shot(entry, 'b15-swapped')
    entry.evidence.back = await swap()

    // The same with the plugin's event dropped.
    await page.evaluate(() => {
      const original = window.dispatchEvent

      window.__mgRigDispatch = original
      window.dispatchEvent = function (event) {
        return event?.type === 'hermes:titlebar-chrome-changed' ? true : original.call(this, event)
      }
    })

    try {
      entry.evidence.plantedSwapped = await swap()
      entry.evidence.plantedBack = await swap()
    } finally {
      await page.evaluate(() => {
        window.dispatchEvent = window.__mgRigDispatch
        window.dispatchEvent(new CustomEvent('hermes:titlebar-chrome-changed'))
      })
      await frames()
    }

    entry.evidence.end = await measure()

    const { before, swapped, back, plantedSwapped } = entry.evidence

    must(swapped.side !== before.side, `Cmd+\\ did not swap the sidebar (${before.side} → ${swapped.side})`)
    must(back.side === before.side, `a second Cmd+\\ did not swap it back (${back.side})`)
    must(!swapped.tabUnderCorner, `sidebar on the ${swapped.side}: the first main tab "${swapped.firstTab?.text}" starts at ${swapped.firstTab?.left} px, under the window buttons and corner row (clear from ${swapped.clear} px)`)
    must(!back.tabUnderCorner, `swapped back: the first main tab starts at ${back.firstTab?.left} px, clear from ${back.clear} px`)
    // The self-test means something only where the swap puts the main zone
    // under the corner (Simple mode; in Advanced mode other panes sit there).
    entry.evidence.exercised = swapped.zoneLeft !== null && swapped.zoneLeft < swapped.clear

    if (entry.evidence.exercised) {
      must(plantedSwapped.side !== before.side && plantedSwapped.tabUnderCorner, `self-test: with the plugin's hermes:titlebar-chrome-changed dropped, the swap was not caught (${JSON.stringify(plantedSwapped)})`)
    } else {
      results.observations.push(`b15: after the swap the main zone starts at ${swapped.zoneLeft} px, clear of the corner (${swapped.clear} px), so this layout cannot put its tabs there; the check proves nothing here`)
    }
    must(!entry.evidence.end.tabUnderCorner && entry.evidence.end.side === before.side, `the layout did not come back: ${JSON.stringify(entry.evidence.end)}`)
  })

  // ── b16. Greeting template ───────────────────────────────────────────────
  // The name is text: `$&`, `$1` and the like in it must not act as
  // replacement patterns. The settings go in through the plugin's own storage
  // and a hot reload (the plugin reads them in register()), then back.
  await check('b16', async (entry, must) => {
    const KEY = 'hermes.plugin.monograph.config'
    const name = 'A$&B $1 $$'
    const own = 'Hello, {name}. Ready?'
    const expected = 'Hello, A$&B $1 $$. Ready?'
    const saved = await page.evaluate(KEY => window.localStorage.getItem(KEY), KEY)

    // The fixture must be one the old code gets wrong, or this proves nothing.
    entry.evidence.patternReplacerGives = await page.evaluate(({ name, own }) => own.replaceAll('{name}', name), { name, own })
    must(entry.evidence.patternReplacerGives !== expected, 'self-test: the fixture name does not tell a pattern replacer from a text one')

    try {
      await page.evaluate(({ KEY, name, own }) => {
        let config = {}

        try {
          config = JSON.parse(window.localStorage.getItem(KEY) || '{}') || {}
        } catch {
          config = {}
        }

        window.localStorage.setItem(KEY, JSON.stringify({ ...config, greeting: own, name }))
      }, { KEY, name, own })
      await hotReload()
      entry.evidence.greeting = await page.evaluate(() => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--mg-greeting').trim()

        try {
          return JSON.parse(raw)
        } catch {
          return raw
        }
      })
    } finally {
      await page.evaluate(({ KEY, saved }) => (saved === null ? window.localStorage.removeItem(KEY) : window.localStorage.setItem(KEY, saved)), { KEY, saved })
      await hotReload()
    }

    must(entry.evidence.greeting === expected, `the greeting reads ${JSON.stringify(entry.evidence.greeting)}, expected ${JSON.stringify(expected)}`)
  })

  // ── b17. The Agent pane's own tab ────────────────────────────────────────
  // Hermes switches a plugin OFF when the tab of its only pane is closed
  // (closeTreePane in components/pane-shell/tree/store.ts). The pane is
  // registered `uncloseable`, so Hermes draws no close control on its tab,
  // leaves Close out of the tab's menu and skips it for Close others / Close
  // all / ⌘W (isUncloseablePane). This check asserts exactly that, in either
  // mode: the Agent tab has no close control, and every way there is to close
  // or sweep the pane leaves Monograph enabled.
  // Hermes draws a zone's tab strip only when it holds more than one pane or
  // the app default (Settings > Workspace) says "always" (strip-visibility.ts),
  // so the check sets that default for itself, as a person can, and puts it
  // back after. No tab even then is "not run", never a pass.
  // MG_RIG_PLANT=closeable runs it on a build whose pane is registered
  // without the flag: the check must then fail.
  const tabStripDefault = value =>
    page.evaluate(value => {
      const key = 'hermes.desktop.tabStripDefault'
      const old = window.localStorage.getItem(key)

      if (value === null) {
        window.localStorage.removeItem(key)
      } else {
        window.localStorage.setItem(key, value)
      }

      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, oldValue: old, storageArea: window.localStorage }))

      return old
    }, value)

  await check('b17', async (entry, must) => {
    if (PLANTS.has('closeable')) {
      const stage = path.dirname(path.dirname(PLUGIN))
      const file = path.join(stage, 'src', 'modules', '20-agent-panel.js')

      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('uncloseable: true', 'uncloseable: false'))
      rebuildPlugin()
      await hotReload()
      entry.evidence.planted = 'the pane registered without uncloseable'
    }

    await home()
    entry.evidence.tabStripDefaultBefore = await tabStripDefault('always')
    await sleep(300)

    const TAB = '[data-pane-tab-id="monograph:agent"]'
    const tab = page.locator(TAB).filter({ visible: true }).first()
    const paneOpen = () => page.evaluate(() => Boolean([...document.querySelectorAll('.mg-agent')].find(node => node.checkVisibility())))
    const ways = (entry.evidence.ways = {})

    // One way: open the pane, do it, record whether the pane closed and
    // whether Monograph is still on; put Monograph back if not.
    const attempt = async (name, act) => {
      if (!(await paneOpen())) {
        await openSurfaces()
        await page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: 'Agent' }).first().click()
        await sleep(1200)
      }

      const record = { open: await paneOpen(), tab: await tab.count() }

      ways[name] = record

      try {
        record.did = await act()
      } catch (error) {
        record.did = `error: ${String(error.message).split('\n')[0]}`
      }

      await sleep(1000)
      record.pluginOn = await pluginLoaded()
      record.decision = await page.evaluate(() => JSON.parse(window.localStorage.getItem('hermes.desktop.pluginDecisions.v2') || '{}').monograph ?? null)
      record.paneOpenAfter = record.pluginOn ? await paneOpen() : null

      if (!record.pluginOn) {
        await shot(entry, `b17-${name.replace(/\W+/g, '-')}-plugin-off`)
        await reEnable()
        await tabStripDefault('always')
        record.reEnabled = await pluginLoaded()
      }

      must(record.pluginOn, `${name}: Monograph was switched off (plugin decision ${record.decision})`)

      return record
    }

    // The tab and its close control.
    await attempt('the tab, hovered', async () => {
      if (!(await tab.count())) {
        return 'no tab'
      }

      await tab.hover()
      await sleep(250)
      entry.evidence.closeControls = await page.evaluate(selector => {
        const node = [...document.querySelectorAll(selector)].find(item => item.checkVisibility())
        const strip = node?.closest('[data-zone-tabstrip]') ?? node?.parentElement
        // A close control inside the tab, or one the strip draws for it.
        const inTab = [...(node?.querySelectorAll('button, [role="button"]') ?? [])].filter(item => /close/i.test(item.getAttribute('aria-label') ?? item.title ?? ''))
        const forTab = [...(strip?.querySelectorAll('button[aria-label]') ?? [])].filter(item => /^close\b/i.test(item.getAttribute('aria-label')) && item.checkVisibility() && !item.closest('[data-pane-tab-id]:not([data-pane-tab-id="monograph:agent"])'))

        return { inTab: inTab.map(item => item.getAttribute('aria-label')), strip: forTab.map(item => item.getAttribute('aria-label')) }
      }, TAB)
      await shot(entry, 'b17-agent-tab-hovered')

      return 'hovered'
    })

    entry.evidence.agentTab = ways['the tab, hovered'].tab

    if (!entry.evidence.agentTab) {
      await page.locator('button[aria-label="Close agent panel"]').filter({ visible: true }).first().click().catch(() => undefined)
      await sleep(600)
      await tabStripDefault(entry.evidence.tabStripDefaultBefore)
      must(false, 'not run: no tab for the Agent pane appeared even with the tab strip set to always')

      return
    }

    must(!entry.evidence.closeControls.inTab.length && !entry.evidence.closeControls.strip.length, `the Agent tab has a close control: ${JSON.stringify(entry.evidence.closeControls)}`)

    // A close control, if one is there after all, pressed.
    await attempt('its close control', async () => {
      await tab.hover()
      await sleep(200)

      const close = tab.locator('button[aria-label="Close"]').first()

      if (!(await close.count())) {
        return 'none to press'
      }

      await close.click()

      return 'pressed'
    })

    // The close gesture: middle click (and ⌘-click) on the tab.
    await attempt('middle click on the tab', async () => {
      const box = await tab.boundingBox()

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' })

      return 'clicked'
    })

    await attempt('Cmd-click on the tab', async () => {
      await tab.click({ modifiers: ['Meta'] })

      return 'clicked'
    })

    // The tab's menu: no Close row for it; Close others and Close all, if
    // there, pressed.
    const menuRows = async () => {
      const box = await tab.boundingBox()

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
      await sleep(500)

      return page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].filter(node => node.checkVisibility()).map(node => ({ disabled: node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('data-disabled'), text: (node.textContent ?? '').trim() })))
    }

    for (const row of [/^Close$/i, /^Close others/i, /^Close all/i, /^Close (tabs )?to the right/i]) {
      await attempt(`the tab's menu: ${row.source}`, async () => {
        const rows = await menuRows()

        entry.evidence.menu = rows

        const hit = rows.find(item => row.test(item.text) && !item.disabled)

        if (!hit) {
          await page.keyboard.press('Escape')

          return 'no such row (or disabled)'
        }

        await page.locator('[role="menuitem"]', { hasText: hit.text }).filter({ visible: true }).first().click()

        return `pressed ${hit.text}`
      })
    }

    must(!(entry.evidence.menu ?? []).some(item => /^Close$/i.test(item.text) && !item.disabled), `the tab's menu offers Close: ${JSON.stringify(entry.evidence.menu)}`)

    // Hermes' close-tab key, with focus in the pane.
    await attempt('Cmd+W with focus in the pane', async () => {
      await page.locator('.mg-agent').filter({ visible: true }).first().click({ position: { x: 20, y: 60 } }).catch(() => undefined)
      await page.keyboard.press('Meta+w')

      return 'pressed'
    })

    await attempt('Escape in the pane', async () => {
      await page.locator('.mg-agent').filter({ visible: true }).first().click({ position: { x: 20, y: 60 } }).catch(() => undefined)
      await page.keyboard.press('Escape')

      return 'pressed'
    })

    // Monograph's own ways: these must close it. They do not need the tab,
    // so the tab strip goes back first (with it always on, the main zone's
    // tabs fill the titlebar and can cover the surfaces button).
    await tabStripDefault(entry.evidence.tabStripDefaultBefore)
    await sleep(400)

    const row = await attempt('the surfaces menu row', async () => {
      await openSurfaces()
      await page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: 'Agent' }).first().click()

      return 'clicked'
    })

    must(row.pluginOn && !row.paneOpenAfter, 'the surfaces row did not close the pane')

    const own = await attempt('the pane\'s own close button', async () => {
      await page.locator('button[aria-label="Close agent panel"]').filter({ visible: true }).first().click()

      return 'clicked'
    })

    must(own.pluginOn && !own.paneOpenAfter, 'the pane\'s own close button did not close it')

    await shot(entry, 'b17-after-every-way')
    await tabStripDefault(entry.evidence.tabStripDefaultBefore)

    if (entry.evidence.planted) {
      // Put the real build back for whatever runs after.
      const stage = path.dirname(path.dirname(PLUGIN))
      const file = path.join(stage, 'src', 'modules', '20-agent-panel.js')

      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('uncloseable: false', 'uncloseable: true'))
      rebuildPlugin()
      await hotReload()
    }
  })

  // ── b18. The surfaces button beside a full tab strip ─────────────────────
  // Hermes' tab strip set to "always" and a dozen tabs: the button must stay
  // on screen, on top, and open its menu on one press, wide and narrow.
  await check('b18', async (entry, must) => {
    await plantCss('b18', '[data-tour="mg-surfaces"] { visibility: hidden !important; }')
    const before = await tabStripDefault('always')
    const width = await page.evaluate(() => window.outerWidth)
    const tabCount = () => page.evaluate(() => [...document.querySelectorAll('[data-pane-tab-id]')].filter(node => node.checkVisibility()).length)

    await home()
    await sleep(300)

    // A new tab is an empty session, which Hermes reuses until it holds a
    // turn: each gets one short turn of its own.
    for (let tries = 0; tries < 16 && (await tabCount()) < 12; tries += 1) {
      await page.keyboard.press('Meta+t')
      await sleep(500)
      await type(`Tab filler ${tries}, MGB_TAB${tries}.`, 'Enter')
      await waitIdle(`MGB_TAB${tries}`, 30_000).catch(() => undefined)
    }

    entry.evidence.tabs = await tabCount()

    const button = () =>
      page.evaluate(() => {
        const node = document.querySelector('[data-tour="mg-surfaces"]')
        const box = node?.getBoundingClientRect()
        const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null

        return node
          ? {
              box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
              inWindow: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.width >= 20,
              shown: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
              onTop: Boolean(hit && node.contains(hit)),
              hit: hit && !node.contains(hit) ? `${hit.tagName.toLowerCase()}${hit.dataset.slot ? `[${hit.dataset.slot}]` : ''}${hit.dataset.paneTabId ? `[tab ${hit.dataset.paneTabId}]` : ''}.${String(hit.className).slice(0, 40)}` : null
            }
          : null
      })

    for (const at of [1220, 800]) {
      await setWindow({ width: at })
      await sleep(400)

      const seen = await button()
      let opened = false

      if (seen?.onTop) {
        opened = await openSurfaces()
          .then(() => true)
          .catch(() => false)
        await page.keyboard.press('Escape')
        await sleep(300)
      }

      entry.evidence[`w${at}`] = { ...seen, opened }
      await shot(entry, `b18-tabs-${at}`)
      must(seen?.shown && seen.inWindow, `${at} px: the surfaces button is not on screen with ${entry.evidence.tabs} tabs: ${JSON.stringify(seen)}`)
      must(seen?.onTop, `${at} px: something covers the surfaces button: ${seen?.hit}`)
      must(opened, `${at} px: one press on the surfaces button did not open its menu`)
    }

    must(entry.evidence.tabs >= 12, `only ${entry.evidence.tabs} tabs could be opened (the check needs 12)`)
    await setWindow({ width })
    await tabStripDefault(before)
    await sleep(300)
  })

  // ── b19. A failed tool call, shut ────────────────────────────────────────
  await check('b19', async (entry, must) => {
    await plantCss('b19', '[data-mg-svc-head][data-mg-failed]::after { content: none !important; }')
    await newSession()
    await type('A failing read, MGB_FAILREAD. MGS_CALL(read_file)[{"path":"/mg-rig-no-such-file-b19.txt"}]', 'Enter')
    await waitIdle('MGB_FAILREAD MGS_CALL_DONE', 60_000)
    await type('A failing command, MGB_FAILCMD. MGS_CALL(terminal)[{"command":"ls /mg-rig-no-such-dir-b19"}]', 'Enter')
    await waitIdle('MGB_FAILCMD MGS_CALL_DONE', 60_000)
    await type('A working command, MGB_OKCMD. MGS_CALL(terminal)[{"command":"echo mg-rig-ok-b19"}]', 'Enter')
    await waitIdle('MGB_OKCMD MGS_CALL_DONE', 60_000)
    await sleep(1200)

    // Open every turn's fold (the "Worked for" line), leaving the rows shut.
    await page.evaluate(() => {
      for (const head of document.querySelectorAll('[data-mg-head][data-mg-steps]:not([data-mg-open])')) {
        if (head.checkVisibility()) {
          const r = head.getBoundingClientRect()

          head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.x + 60, clientY: r.y + 9, view: window }))
        }
      }
    })
    await sleep(900)

    const rows = await page.evaluate(() =>
      Object.fromEntries(
        ['mg-rig-no-such-file-b19', 'mg-rig-no-such-dir-b19', 'mg-rig-ok-b19'].map(needle => {
          const row = [...document.querySelectorAll('[data-slot="tool-block"]')].filter(node => node.checkVisibility() && node.textContent.includes(needle)).at(-1)
          const head = row?.querySelector('[data-mg-svc-head]')
          const after = head ? getComputedStyle(head, '::after') : null

          return [
            needle,
            row
              ? {
                  open: row.hasAttribute('data-tool-open'),
                  marked: Boolean(head && 'mgFailed' in head.dataset),
                  glyph: after && after.content !== 'none' && after.content !== 'normal' ? after.content : null,
                  glyphColour: after?.color ?? null,
                  glyphWidth: head && after && after.content !== 'none' ? Math.round(head.getBoundingClientRect().width) : null
                }
              : null
          ]
        })
      )
    )

    entry.evidence.rows = rows
    await shot(entry, 'b19-failed-rows-shut')

    const grey = colour => {
      const [r, g, b] = (colour?.match(/\d+(\.\d+)?/g) ?? []).map(Number)

      return r === g && g === b
    }

    for (const needle of ['mg-rig-no-such-file-b19', 'mg-rig-no-such-dir-b19']) {
      const row = rows[needle]

      must(row, `${needle}: no tool row on screen`)
      must(!row || !row.open, `${needle}: the row was open, the check is about a shut one`)
      must(row?.marked && row.glyph, `${needle}: the shut row of a failed call carries no mark: ${JSON.stringify(row)}`)
      must(!row?.glyph || grey(row.glyphColour), `${needle}: the failure glyph is drawn in colour (${row?.glyphColour})`)
    }

    must(rows['mg-rig-ok-b19'] && !rows['mg-rig-ok-b19'].marked && !rows['mg-rig-ok-b19'].glyph, `a call that worked is marked as failed: ${JSON.stringify(rows['mg-rig-ok-b19'])}`)
  })

  results.notes.push('battery: copies during the run went to a variable in the app, never to the system clipboard')
}
