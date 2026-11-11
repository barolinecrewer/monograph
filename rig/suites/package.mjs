// The package suite: install.sh into the sandbox's Hermes home (the app then
// boots on the plugin it installed), the controls in the top band and the
// sidebar header (no two overlap, each takes its own click), the Hermes
// actions Monograph hides still reachable, and --uninstall at the end.
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EVIDENCE, HERMES_REPO, MODE, PLUGIN, WORK, check, finished, results, shot, sleep, state, type } from '../harness.mjs'

export const checks = [
  ['p1', 'install.sh: installs into the sandbox home, twice, and the app runs on what it installed'],
  ['p2', 'Top right: the surfaces button and each Hermes button there take their own click'],
  ['p3', 'Hidden Hermes actions stay reachable: Settings, layout editor, Swap sidebar sides'],
  ['p4', 'No two controls overlap in the top band and sidebar header (widths 900/1220/1800 x zoom 0.9/1/1.25)'],
  ['p5', 'install.sh --uninstall puts the sandbox home back as it was']
]

const DONE = 'Reply from the mock model, MG_PKG_DONE.'

export const mock = { replyForPrompt: () => DONE }

// install.sh and the sources the rig built from: the plugin is <stage>/dist/plugin.js.
const STAGE = path.dirname(path.dirname(PLUGIN))
const INSTALL = path.join(STAGE, 'install.sh')
// What the sandbox held before install.sh ran: a valid, empty plugin, so that
// a hot reload after --uninstall loads something harmless.
const MARKER = "// rig marker: the plugin that was here before install.sh\nexport default { id: 'monograph', name: 'Monograph (rig marker)', register() {} }\n"
const PLUGIN_REL = path.join('desktop-plugins', 'monograph', 'plugin.js')
const SKIN_REL = path.join('skins', 'monograph.yaml')

// A rig run with --local builds with config.local.json; install.sh is then
// asked for the same build, so that the app runs what the rig meant to test.
const LOCAL = fs.existsSync(path.join(STAGE, 'config.local.json'))
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12)
const seeded = {}

const runInstall = (home, ...args) => {
  // Never anything but the sandbox's own home.
  if (!home.startsWith(WORK + path.sep)) {
    throw new Error(`refusing to run install.sh against ${home}: not under the rig's work dir`)
  }

  const run = spawnSync('sh', [INSTALL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: home, MG_HERMES_REPO: HERMES_REPO },
    timeout: 120_000
  })

  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.replaceAll(WORK, '<work>') }
}

export async function seed({ sandbox }) {
  const home = sandbox.hermesHome
  const plugin = path.join(home, PLUGIN_REL)

  fs.writeFileSync(plugin, MARKER)
  seeded.home = home
  seeded.before = fs.existsSync(path.join(home, 'skins')) ? fs.readdirSync(path.join(home, 'skins')) : null
  seeded.first = runInstall(home, ...(LOCAL ? ['--local'] : []))
  seeded.second = runInstall(home, ...(LOCAL ? ['--local'] : []))
  seeded.installedSha = fs.existsSync(plugin) ? sha(plugin) : null
}

// ── Page helpers ─────────────────────────────────────────────────────────────

// Every visible control in the top band and the sidebar header, and every
// pair of them whose boxes intersect. Also the drag regions: a control that a
// later drag region covers loses its clicks in Electron, which no synthetic
// click can show, so it is judged from the boxes and the document order.
const measure = () =>
  state.page.evaluate(() => {
    const visible = node => node.checkVisibility({ visibilityProperty: true }) && getComputedStyle(node).pointerEvents !== 'none'
    const box = node => node.getBoundingClientRect()
    const label = node =>
      node.getAttribute('aria-label') || (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) || `<${node.tagName.toLowerCase()}>`
    const round = r => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right - r.left)}x${Math.round(r.bottom - r.top)}`

    const sidebar = document.querySelector('[data-slot="sidebar"]')
    const side = sidebar && visible(sidebar) && box(sidebar).width > 40 ? box(sidebar) : null
    const headers = [...document.querySelectorAll('[data-panel-header]')].filter(node => visible(node) && box(node).height > 0 && box(node).top < 4)
    // The band is the shortest top header (a zone with its tabs on their own
    // row has a taller one; that row is judged with the sidebar's header).
    const bandBottom = headers.length ? Math.max(24, Math.min(...headers.map(node => box(node).bottom))) : 34
    // The sidebar's header, plus its first row (search, filter, new session).
    const limit = side ? Math.max(bandBottom, side.top + 44) : bandBottom

    const items = []

    for (const node of document.querySelectorAll('button, [role="tab"], [role="radio"], a[href], input, [role="combobox"]')) {
      if (!visible(node)) {
        continue
      }

      const r = box(node)

      if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.left >= innerWidth) {
        continue
      }

      // The band across the window; below it, only the sidebar's header and
      // first row (the thread's own controls are not this check's business).
      const inBand = r.top < bandBottom
      const inSidebarHead = side && r.top < limit && r.left >= side.left - 1 && r.right <= side.right + 1

      if (!inBand && !inSidebarHead) {
        continue
      }

      items.push({ node, r, name: label(node) })
    }

    // The corner's mark and wordmark are drawn by the left cluster itself
    // (::before / ::after), right of its last button.
    const cluster = document.querySelector('[data-titlebar-cluster="left"]')

    if (cluster && visible(cluster)) {
      const buttons = [...cluster.querySelectorAll(':scope > button')].filter(visible)
      const r = box(cluster)
      const left = buttons.length ? box(buttons.at(-1)).right : r.left

      if (r.right - left > 4) {
        items.push({ node: null, r: { left, right: r.right, top: r.top, bottom: r.bottom }, name: 'corner mark + wordmark' })
      }
    }

    const cut = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
    const overlaps = []

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]

        if (a.node && b.node && (a.node.contains(b.node) || b.node.contains(a.node))) {
          continue
        }

        if (cut(a.r, b.r)) {
          overlaps.push(`"${a.name}" ${round(a.r)} x "${b.name}" ${round(b.r)}`)
        }
      }
    }

    const clipped = items.filter(item => item.r.right > innerWidth + 0.5 || item.r.left < -0.5).map(item => `"${item.name}" ${round(item.r)}`)

    // Hermes' drag handles; with the surfaces button in, 14-surfaces.css
    // makes the handle no-drag and drags through a ::before that stops 28px
    // short of its right edge.
    const surfaces = Boolean(document.querySelector('button[data-tour="mg-surfaces"]'))
    const dragConflicts = []

    for (const handle of document.querySelectorAll('[data-window-drag-handle]')) {
      if (!visible(handle) || box(handle).width < 1) {
        continue
      }

      const h = box(handle)
      const area = { left: h.left, right: surfaces ? h.right - 28 : h.right, top: h.top, bottom: h.bottom }

      for (const item of items) {
        if (item.node && cut(item.r, area) && item.node.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING) {
          dragConflicts.push(`"${item.name}" ${round(item.r)} under drag area ${round(area)}`)
        }
      }
    }

    const root = getComputedStyle(document.documentElement)

    return {
      viewport: `${innerWidth}x${innerHeight}`,
      lightsY: parseFloat(root.getPropertyValue('--mg-lights-y')),
      lightsX: parseFloat(root.getPropertyValue('--mg-lights-x')),
      sidebar: side ? round(side) : 'hidden',
      controls: items.length,
      list: items.map(item => `${item.name} ${round(item.r)}`),
      overlaps,
      clipped,
      dragConflicts
    }
  })

const setWindow = async (width, zoom) => {
  await state.app.evaluate(
    ({ BrowserWindow }, { width, zoom }) => {
      const win = BrowserWindow.getAllWindows()[0]

      win.webContents.setZoomFactor(zoom)
      win.setSize(width, 800)
    },
    { width, zoom }
  )
  await sleep(700)
}

const sidebarSide = () =>
  state.page.evaluate(() => {
    const node = document.querySelector('[data-slot="sidebar"]')
    const r = node?.getBoundingClientRect()

    return !r || r.width < 40 ? 'hidden' : r.left + r.width / 2 < innerWidth / 2 ? 'left' : 'right'
  })

const centreOf = async locator => {
  const b = await locator.boundingBox()

  return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null
}

// The whole window as drawn. page.screenshot() takes the CSS viewport in
// device pixels, which at a page zoom other than 1 is only part of the window.
const shotWindow = async (entry, name) => {
  const png = await state.app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')
  )
  const file = path.join(EVIDENCE, 'shots', `${name}.png`)

  fs.writeFileSync(file, Buffer.from(png, 'base64'))
  entry.screenshots.push(file)
}

const menuOpen = () => state.page.evaluate(() => Boolean(document.querySelector('.mg-surfaces-menu')?.checkVisibility()))

export async function run() {
  const { page } = state

  // ── p1. install.sh into the sandbox home ──────────────────────────────────
  await check('p1', async (entry, must) => {
    const home = seeded.home
    const plugin = path.join(home, PLUGIN_REL)
    const skin = path.join(home, SKIN_REL)
    const original = path.join(home, 'monograph-install', 'original', PLUGIN_REL)
    const first = seeded.first ?? { code: null, out: 'did not run' }
    const second = seeded.second ?? { code: null, out: 'did not run' }

    Object.assign(entry.evidence, {
      firstRun: first.out.trim().split('\n'),
      secondRun: second.out.trim().split('\n'),
      installedPlugin: `${seeded.installedSha} (the rig's own release build: ${sha(PLUGIN)})`,
      runningPlugin: fs.existsSync(plugin) ? sha(plugin) : 'missing'
    })

    must(first.code === 0, `the first install exited ${first.code}`)
    must(/replaced {2}<work>\S*desktop-plugins\/monograph\/plugin\.js/.test(first.out), 'the first install did not say it replaced the plugin')
    must(/created {3}<work>\S*skins\/monograph\.yaml/.test(first.out), 'the first install did not say it created the skin')
    must(/^Doctor: Hermes \S+ .*hooks checked, 0 missing/m.test(first.out), 'the doctor did not report 0 missing during the install')
    must(second.code === 0, `the second install exited ${second.code}`)
    must((second.out.match(/^ {2}unchanged /gm) ?? []).length === 2 && !/replaced|created|updated/.test(second.out), 'the second install changed something')
    must(seeded.installedSha === sha(PLUGIN), 'install.sh installed a different build from the rig\'s release build of the same sources')
    must(fs.existsSync(skin) && sha(skin) === sha(path.join(STAGE, 'skin', 'monograph.yaml')), 'the skin in the sandbox is not the repo\'s')
    must(fs.existsSync(original) && fs.readFileSync(original, 'utf8') === MARKER, 'the plugin install.sh replaced was not kept')

    // The app booted on that file: check a found the plugin's button, and
    // the stylesheet the page holds is the installed build's.
    const loaded = await page.evaluate(() => ({
      modules: document.documentElement.dataset.mgModules ?? null,
      button: Boolean(document.querySelector('[data-tour="mg-surfaces"]')),
      style: Boolean([...document.querySelectorAll('style')].find(node => (node.textContent ?? '').includes('--mg-canvas')))
    }))

    entry.evidence.page = loaded
    must(loaded.button && loaded.style, 'the page does not run the installed plugin')
  })

  // ── p2. Top right: each button takes its own click ────────────────────────
  await check('p2', async (entry, must) => {
    await page.mouse.move(600, 400)

    const probe = () => page.evaluate(() =>
      [...document.querySelectorAll('[data-titlebar-cluster="right"] > button, button[data-tour="mg-surfaces"]')]
        .filter(node => node.checkVisibility() && node.getBoundingClientRect().width > 0)
        .map(node => {
          const r = node.getBoundingClientRect()
          const x = r.left + r.width / 2
          const y = r.top + r.height / 2
          const stack = document.elementsFromPoint(x, y)
          const hit = stack[0]?.closest('button')
          const name = n => `${n.tagName.toLowerCase()}${n.getAttribute('aria-label') ? `"${n.getAttribute('aria-label')}"` : ''}${n.dataset.slot ? `[${n.dataset.slot}]` : ''}.${String(n.className).slice(0, 40)}`

          return {
            label: node.getAttribute('aria-label'),
            box: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            centreHits: hit === node ? 'itself' : `${hit?.getAttribute('aria-label') ?? 'no labelled button'} (${stack.slice(0, 3).map(name).join(' | ') || 'nothing'})`
          }
        })
    )

    // Straight after boot the app can still be drawing itself (once, in an
    // early run, no button in the corner was under its own centre and a
    // click did nothing). Wait up to 5s for the corner to settle, and report
    // how long that took and what was in the way meanwhile.
    const began = Date.now()
    let buttons = await probe()
    const firstSeen = buttons.filter(button => button.centreHits !== 'itself')

    while (buttons.some(button => button.centreHits !== 'itself') && Date.now() - began < 5000) {
      await sleep(200)
      buttons = await probe()
    }

    entry.evidence.settledAfterMs = Date.now() - began

    if (firstSeen.length) {
      entry.evidence.notYetReachableAtFirst = firstSeen.map(button => `"${button.label}": ${button.centreHits}`)
      results.observations.push(`p2: at the start of the check ${firstSeen.length} corner button(s) were not under their own centre; settled after ${entry.evidence.settledAfterMs}ms: ${entry.evidence.notYetReachableAtFirst.join('; ')}`)
    }

    entry.evidence.buttons = buttons.map(button => `"${button.label}" ${button.box}, centre reaches ${button.centreHits}`)

    for (const button of buttons) {
      must(button.centreHits === 'itself', `the centre of "${button.label}" reaches ${button.centreHits}`)
    }

    // The surfaces button: one real click opens its menu.
    const surfaces = await centreOf(page.locator('[data-tour="mg-surfaces"] .mg-surfaces-hit').first())

    must(surfaces, 'no surfaces button')

    if (surfaces) {
      const side = await sidebarSide()

      await page.mouse.click(surfaces.x, surfaces.y)
      await sleep(500)
      entry.evidence.surfacesClick = { menuOpen: await menuOpen(), sidebarBefore: side, sidebarAfter: await sidebarSide() }
      must(entry.evidence.surfacesClick.menuOpen, 'a click on the surfaces button did not open its menu')
      must(side === entry.evidence.surfacesClick.sidebarAfter, 'a click on the surfaces button moved the sidebar')
      await shot(entry, `p2-surfaces-${MODE}`)
      await page.keyboard.press('Escape')
      await sleep(300)
    }

    // Swap sidebar sides (Advanced): one real click swaps, a second swaps back.
    const swap = page.locator('[data-titlebar-cluster="right"] > button[aria-label="Swap sidebar sides"]')

    if ((await swap.count()) && (await swap.isVisible())) {
      const at = await centreOf(swap)
      const before = await sidebarSide()

      await page.mouse.click(at.x, at.y)
      await sleep(700)

      const swapped = await sidebarSide()
      const opened = await menuOpen()

      // Hermes reserves room beside the corner by measuring each zone, but
      // does not measure again when a swap moves a zone without resizing it.
      const after = await measure()

      await shot(entry, 'p2-swapped')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('hermes:titlebar-chrome-changed')))
      await sleep(400)

      const remeasured = await measure()

      await page.mouse.click(at.x, at.y)
      await sleep(700)

      entry.evidence.swapClick = { before, afterOneClick: swapped, afterTwo: await sidebarSide(), surfacesMenuOpened: opened }
      must(before === 'left' && swapped === 'right' && entry.evidence.swapClick.afterTwo === 'left', `Swap did not swap and swap back: ${JSON.stringify(entry.evidence.swapClick)}`)
      must(!opened, 'the Swap click opened the surfaces menu')

      if (after.overlaps.length) {
        results.observations.push(
          `p2: after Swap sidebar sides, controls overlap until Hermes measures again (Hermes does not after a swap): ${after.overlaps.join('; ')}. After a 'hermes:titlebar-chrome-changed' event: ${remeasured.overlaps.length ? remeasured.overlaps.join('; ') : 'none'}.`
        )
      }

      entry.evidence.overlapsAfterSwap = after.overlaps
      entry.evidence.overlapsAfterSwapAndRemeasure = remeasured.overlaps
    } else {
      entry.evidence.swapClick = `no Swap button on screen (interface mode ${MODE})`
    }

    const hud = buttons.find(button => button.label === 'HUD mode')

    entry.evidence.hud = hud ? 'reachable at its centre; not clicked (it opens the HUD window)' : `no HUD button on screen (interface mode ${MODE})`
  })

  // ── p3. Hidden Hermes actions stay reachable ──────────────────────────────
  await check('p3', async (entry, must) => {
    await page.mouse.move(600, 400)

    // Settings: a row in the surfaces menu (Hermes' gear is hidden).
    const surfaces = await centreOf(page.locator('[data-tour="mg-surfaces"] .mg-surfaces-hit').first())

    await page.mouse.click(surfaces.x, surfaces.y)
    await sleep(500)
    entry.evidence.surfacesRows = await page.evaluate(() => [...document.querySelectorAll('.mg-surfaces-menu .mg-surface-row')].map(row => (row.textContent ?? '').trim()))
    must(entry.evidence.surfacesRows.some(row => /^Settings/.test(row)), 'no Settings row in the surfaces menu')
    await page.keyboard.press('Escape')
    await sleep(300)

    // Layout editor: a row in Hermes' command palette (its button is hidden).
    await page.keyboard.press('Meta+k')
    await sleep(600)
    await page.keyboard.insertText('layout edit')
    await sleep(600)

    const row = page.getByText('Toggle layout edit mode', { exact: false }).first()

    entry.evidence.paletteRow = (await row.count()) && (await row.isVisible()) ? 'Toggle layout edit mode' : null
    must(entry.evidence.paletteRow, 'the command palette shows no "Toggle layout edit mode" row')
    await shot(entry, `p3-palette-${MODE}`)
    await page.keyboard.press('Escape')
    await sleep(400)

    // Swap sidebar sides: its keybind, in both modes (Simple hides the button).
    await page.mouse.click(600, 300)
    const before = await sidebarSide()

    await page.keyboard.press('Meta+\\')
    await sleep(700)

    const swapped = await sidebarSide()

    await page.keyboard.press('Meta+\\')
    await sleep(700)
    entry.evidence.swapKey = { before, afterOne: swapped, afterTwo: await sidebarSide() }
    must(before === 'left' && swapped === 'right' && entry.evidence.swapKey.afterTwo === 'left', `⌘\\ did not swap and swap back: ${JSON.stringify(entry.evidence.swapKey)}`)
    entry.evidence.notChecked = 'HUD mode by ⌘⇧H (it opens the HUD window); Settings by ⌘,'
  })

  // ── p4. The overlap matrix ────────────────────────────────────────────────
  await check('p4', async (entry, must) => {
    // One finished session, so the sidebar has its search row and list header.
    await type('Rig package prompt, MG_PKG.', 'Enter')
    await finished('MG_PKG_DONE', 60_000)
    await sleep(500)

    const cases = []

    for (const width of [900, 1220, 1800]) {
      for (const zoom of [0.9, 1, 1.25]) {
        cases.push({ width, zoom })
      }
    }

    cases.push({ width: 1220, zoom: 1, collapsed: true })

    const stale = []

    for (const item of cases) {
      const name = `${item.width}@${item.zoom}${item.collapsed ? ' sidebar hidden' : ''}`

      await setWindow(item.width, item.zoom)
      await page.mouse.move(5, 400)

      // The corner follows the native window buttons through --mg-lights-*,
      // which the plugin works out on 'resize'. Note when it lags behind.
      const lights = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mg-lights-y')))
      const expected = 17 / item.zoom

      if (Math.abs(lights - expected) > 0.5) {
        stale.push(`${name}: --mg-lights-y ${lights}px, expected ${expected.toFixed(2)}px`)
        // What a second resize event gives (a person's drag sends many).
        await page.evaluate(() => window.dispatchEvent(new Event('resize')))
        await sleep(300)
      }

      if (item.collapsed) {
        const toggle = await centreOf(page.locator('[data-titlebar-cluster="left"] > button').first())

        await page.mouse.click(toggle.x, toggle.y)
        await sleep(700)
        await page.mouse.move(600, 400)
      }

      const seen = await measure()

      entry.evidence[name] = {
        viewport: seen.viewport,
        sidebar: seen.sidebar,
        controls: seen.controls,
        overlaps: seen.overlaps,
        ...(seen.clipped.length ? { clipped: seen.clipped } : {}),
        ...(seen.dragConflicts.length ? { dragConflicts: seen.dragConflicts } : {})
      }
      must(seen.controls >= 3, `${name}: only ${seen.controls} controls found; the measurement is not seeing the band`)
      must(!seen.overlaps.length, `${name}: ${seen.overlaps.join('; ')}`)
      must(!seen.clipped.length, `${name}: off screen ${seen.clipped.join('; ')}`)
      must(!seen.dragConflicts.length, `${name}: ${seen.dragConflicts.join('; ')}`)
      await shotWindow(entry, `p4-${MODE}-${item.width}-${item.zoom}${item.collapsed ? '-collapsed' : ''}`)

      if (item.collapsed) {
        const toggle = await centreOf(page.locator('[data-titlebar-cluster="left"] > button').first())

        await page.mouse.click(toggle.x, toggle.y)
        await sleep(700)
        must((await sidebarSide()) === 'left', 'the sidebar did not come back after the second toggle click')
      }

      if (item.width === 1220 && item.zoom === 1 && !item.collapsed) {
        entry.evidence.controlsAt1220 = seen.list
      }
    }

    entry.evidence.staleCorner = stale.length ? stale : 'none'

    if (stale.length) {
      results.observations.push(
        `p4: after BrowserWindow.setSize the corner's --mg-lights-y kept the old size's value until another resize event (${stale.length} of ${cases.length} cases, e.g. ${stale[0]}). The plugin reads the zoom as outerWidth / innerWidth in its 'resize' handler; one of the two is not yet updated there. Measured after a second resize event.`
      )
    }

    await setWindow(1220, 1)
  })

  // ── p5. --uninstall ───────────────────────────────────────────────────────
  await check('p5', async (entry, must) => {
    const home = seeded.home
    const run = runInstall(home, '--uninstall')

    entry.evidence.output = run.out.trim().split('\n')
    must(run.code === 0, `--uninstall exited ${run.code}`)
    must(fs.readFileSync(path.join(home, PLUGIN_REL), 'utf8') === MARKER, 'the plugin from before install.sh is not back')
    must(!fs.existsSync(path.join(home, SKIN_REL)), 'the skin is still there')
    must(!fs.existsSync(path.join(home, 'monograph-install')), 'the install records are still there')
    must(
      JSON.stringify(fs.existsSync(path.join(home, 'skins')) ? fs.readdirSync(path.join(home, 'skins')) : null) === JSON.stringify(seeded.before),
      'the skins folder is not as it was'
    )

    const again = runInstall(home, '--uninstall')

    must(again.code === 0 && /Nothing to uninstall/.test(again.out), 'a second --uninstall was not a clean no-op')
  })
}
