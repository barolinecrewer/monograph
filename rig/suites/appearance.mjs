// Appearance: Settings > Plugins > Monograph (src/modules/10-appearance.js).
// Opened and used with real pointer and key events; values read back from the
// root attributes, the stylesheet's results and the plugin's own storage.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { HERMES_REPO, WORK, buildAppEnv, check, findElectron, finished, hotReload, results, shot, sleep, state, stubPlugin, type, waitForAppReady } from '../harness.mjs'

export const checks = [
  ['p1', 'Appearance: the page opens with real clicks'],
  ['p2', 'Appearance: name and greeting, on an empty session'],
  ['p3', 'Appearance: picture stored within the limit, bad files refused'],
  ['p4', 'Appearance: tools, motion and density, each with a visible consequence'],
  ['p5', 'Appearance: palette entries'],
  ['p6', 'Appearance: everything survives a reload'],
  ['p7', 'Appearance: keyboard only'],
  ['p8', 'Appearance: reset to defaults, with a confirmation'],
  ['p9', 'Appearance: the page at 1220 and 900 px wide'],
  ['p10', 'Appearance: a hot reload leaves one of everything'],
  ['p11', 'Appearance: hot reload twice, then unloaded: one of everything, then nothing of ours'],
  ['p12', 'Appearance: names with odd characters ($ and & patterns, emoji, 80 characters, empty) reach the greeting as typed'],
  ['p13', "Appearance: Hermes' Switch drawn in grayscale on the page, its state clear without colour, a gray focus ring"],
  ['p14', 'Appearance: tool calls shown or hidden applies to an open thread at once, and what was in view stays in view'],
  ['p15', 'Appearance: every value survives an app restart, and a second window shows the same'],
  ['p16', 'Appearance: thinking, live or the working line only, stored and applied at once, Hermes\' own preference never written']
]

const TOOL_PROMPT = 'Rig appearance prompt, MG_RIG_AP. E2E_CALL(terminal)[{"command":"echo appearance"}]'
const TOOL_ANSWER = 'E2E_CALL_RESULT'
const NAME = 'Ada Lovelace'
const STORAGE_KEY = 'hermes.plugin.monograph.config'
const PAGE = '[data-mg-ap="page"]'
const NAV_ITEM = '[data-tour="nav-plugins:desktop:monograph:settings"]'

export const mock = { replyForPrompt: () => 'Reply from the mock model.' }

// ── Fixtures: written by hand, no dependencies ──
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n

  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }

  return c >>> 0
})

const crc32 = buffer => {
  let c = 0xffffffff

  for (const byte of buffer) {
    c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  }

  return (c ^ 0xffffffff) >>> 0
}

const chunk = (kind, data) => {
  const head = Buffer.alloc(8)

  head.writeUInt32BE(data.length, 0)
  head.write(kind, 4, 'ascii')

  const tail = Buffer.alloc(4)

  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'ascii'), data])), 0)

  return Buffer.concat([head, data, tail])
}

// An RGB PNG; `pixels(x, y)` gives [r, g, b], or `noise` fills it randomly.
function png(width, height, { pixels, noise = false, level = 6 }) {
  const raw = noise ? crypto.randomBytes((width * 3 + 1) * height) : Buffer.alloc((width * 3 + 1) * height)

  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)

    raw[row] = 0

    if (!noise) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixels(x, y)

        raw[row + 1 + x * 3] = r
        raw[row + 2 + x * 3] = g
        raw[row + 3 + x * 3] = b
      }
    }
  }

  const ihdr = Buffer.alloc(13)

  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function fixtures() {
  const dir = path.join(WORK, 'ap-fixtures')

  fs.mkdirSync(dir, { recursive: true })

  const files = {
    // Wide on purpose, so the crop has something to do: a white disc centred.
    picture: [path.join(dir, 'portrait.png'), png(480, 300, { pixels: (x, y) => ((x - 240) ** 2 + (y - 150) ** 2 < 100 ** 2 ? [235, 235, 235] : [40 + (x % 60), 60, 90]) })],
    huge: [path.join(dir, 'huge.png'), png(3000, 2300, { level: 0, noise: true })],
    text: [path.join(dir, 'notes.txt'), Buffer.from('These are notes, not a picture.\n')],
    broken: [path.join(dir, 'broken.png'), crypto.randomBytes(4096)]
  }

  const out = {}

  for (const [key, [file, data]] of Object.entries(files)) {
    fs.writeFileSync(file, data)
    out[key] = { file, bytes: data.length }
  }

  return out
}

// ── Helpers ──
const page = () => state.page

const centre = async locator => {
  await locator.first().scrollIntoViewIfNeeded().catch(() => undefined)

  const box = await locator.first().boundingBox()

  if (!box) {
    throw new Error(`nothing to click for ${locator}`)
  }

  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

// A real pointer click at the centre of what the locator finds.
const press = async locator => {
  const { x, y } = await centre(locator)

  await page().mouse.click(x, y)
}

const visible = selector => page().evaluate(selector => [...document.querySelectorAll(selector)].some(node => node.checkVisibility()), selector)

const until = async (test, ms, step = 100) => {
  const end = Date.now() + ms

  while (Date.now() < end) {
    if (await test()) {
      return true
    }

    await sleep(step)
  }

  return Boolean(await test())
}

const stored = () =>
  page().evaluate(key => {
    try {
      return JSON.parse(window.localStorage.getItem(key) || '{}')
    } catch {
      return null
    }
  }, STORAGE_KEY)

const rootMarks = () =>
  page().evaluate(() => {
    const root = document.documentElement

    return {
      density: root.dataset.mgDensity ?? null,
      greeting: getComputedStyle(root).getPropertyValue('--mg-greeting').trim(),
      motion: root.dataset.mgMotion ?? null,
      tools: root.dataset.mgTools ?? null
    }
  })

// What the page shows right now.
const pageState = () =>
  page().evaluate(selector => {
    const root = document.querySelector(selector)

    if (!root) {
      return null
    }

    const avatar = root.querySelector('[data-mg-avatar]')
    const toggle = id => root.querySelector(`#${id} [role="switch"]`)?.getAttribute('aria-checked') ?? root.querySelector(`#${id} input[type="checkbox"]`)?.checked ?? null

    return {
      avatar: avatar ? { kind: avatar.dataset.mgAvatar, text: avatar.textContent, src: avatar.getAttribute('src')?.slice(0, 30) ?? null } : null,
      density: [...root.querySelectorAll('#monograph-density button[aria-pressed="true"]')].map(node => node.textContent.trim()),
      greeting: root.querySelector('[data-mg-ap="greeting"]')?.value ?? null,
      motion: toggle('monograph-motion'),
      name: root.querySelector('[data-mg-ap="name"]')?.value ?? null,
      note: root.querySelector('[data-mg-ap="picture-note"]')?.textContent ?? null,
      noteKind: root.querySelector('[data-mg-ap="picture-note"]')?.dataset.kind ?? null,
      preview: root.querySelector('[data-mg-ap="preview"]')?.textContent ?? null,
      previewElements: root.querySelector('[data-mg-ap="preview"]')?.children.length ?? null,
      removeDisabled: root.querySelector('[data-mg-ap="remove"]')?.disabled ?? null,
      tools: toggle('monograph-tool-calls')
    }
  }, PAGE)

// Settings > Plugins > Monograph, by pointer: the surfaces menu, its Settings
// row, then the rail. Returns the route taken.
async function openPage(entry) {
  const steps = []

  if (await visible(PAGE)) {
    return ['already open']
  }

  if (!(await visible(NAV_ITEM))) {
    await press(page().locator('[data-tour="mg-surfaces"] .mg-surfaces-hit'))

    if (await until(() => visible('.mg-surfaces-menu'), 1_500)) {
      steps.push('surfaces button')
      await press(page().locator('.mg-surface-row', { hasText: 'Settings' }))
      steps.push('Settings row')
    } else {
      // Something covers the surfaces button (core check b names it). Hermes'
      // own settings shortcut instead; the rest is still by pointer.
      entry.evidence.surfacesButtonCovered = true
      await page().keyboard.press('Meta+,')
      steps.push('Meta+, (the surfaces menu did not open)')
    }

    await until(() => visible('[data-tour^="nav-"]'), 10_000)
  }

  if (!(await visible(NAV_ITEM))) {
    // The plugin entries hang under Plugins; open it first.
    const plugins = page().locator('[data-tour="nav-plugins"]')

    if (await plugins.count()) {
      await press(plugins)
      steps.push('Plugins in the rail')
      await until(() => visible(NAV_ITEM), 5_000)
    }
  }

  if (!(await visible(NAV_ITEM))) {
    entry.evidence.railItems = await page().evaluate(() => [...document.querySelectorAll('[data-tour^="nav-"]')].map(node => node.dataset.tour))
    throw new Error(`no ${NAV_ITEM} in the settings rail`)
  }

  await press(page().locator(NAV_ITEM))
  steps.push('Monograph in the rail')
  await page().waitForSelector(PAGE, { state: 'visible', timeout: 10_000 })

  return steps
}

// Settings is an overlay over the chat; its own close button takes it away.
async function closeSettings() {
  const close = page().locator('button[aria-label="Close settings"]')

  if (await close.count()) {
    await press(close)
    await until(async () => !(await visible('[data-tour^="nav-"]')), 5_000)
  }
}

// A new, empty chat, by pointer: the "+" after the last tab.
async function newSession(entry) {
  await closeSettings()
  await press(page().locator('button[aria-label="New session tab"]'))
  await page().waitForSelector('[data-slot="composer-root"] [contenteditable="true"]', { state: 'visible', timeout: 15_000 })

  const empty = await until(
    () => page().evaluate(() => !document.querySelector('[data-slot="aui_thread-content"] :is([data-role="user"], [data-role="assistant"])')),
    10_000
  )

  if (!empty) {
    entry.why.push('the "New session tab" button did not give an empty chat')
  }
}

// The greeting an empty chat shows: the dock's ::before (40-composer.css).
// The one meaning of "motion off" (05-motion.css), tested the same way as the
// motion suite's m6: while `act` runs, every animation that starts lasts at
// most 1 ms and no transition is created. Returns what started, with times.
async function motionDuring(act) {
  await page().evaluate(() => {
    window.__mgMotionSeen = []
    window.__mgMotionHear ??= event => {
      const animation = document
        .getAnimations()
        .find(item => item.effect?.target === event.target && (event.type === 'animationstart' ? item.animationName === event.animationName : item.transitionProperty === event.propertyName))
      const ms = animation ? animation.effect.getComputedTiming().duration : event.elapsedTime * 1000

      window.__mgMotionSeen.push({ kind: event.type === 'animationstart' ? 'anim' : 'trans', ms: Math.round(ms * 1000) / 1000, name: event.animationName || event.propertyName, on: `${event.target.tagName?.toLowerCase()}${event.target.getAttribute?.('data-slot') ? `[${event.target.getAttribute('data-slot')}]` : ''}` })
    }
    document.addEventListener('animationstart', window.__mgMotionHear, true)
    document.addEventListener('transitionrun', window.__mgMotionHear, true)
  })
  await act()
  return page().evaluate(() => {
    document.removeEventListener('animationstart', window.__mgMotionHear, true)
    document.removeEventListener('transitionrun', window.__mgMotionHear, true)
    return window.__mgMotionSeen.splice(0)
  })
}

const motionFaults = seen => [...seen.filter(item => item.kind === 'anim' && item.ms > 1), ...seen.filter(item => item.kind === 'trans')]

// A visible consequence of the motion setting: the model menu's entrance.
const modelMenuMotion = () =>
  motionDuring(async () => {
    await press(page().locator('[data-tour="model-pill"]'))
    await sleep(450)
    await page().keyboard.press('Escape')
    await sleep(400)
  })

const shownGreeting = () =>
  page().evaluate(() => {
    const dock = document.querySelector('[data-slot="composer-dock"]:not([data-popped-out])')

    if (!dock) {
      return null
    }

    const style = getComputedStyle(dock, '::before')

    return { animation: `${style.animationName} ${style.animationDuration}`, content: style.content, display: style.display }
  })

const inputText = async (selector, text) => {
  await press(page().locator(selector))
  await page().keyboard.press('Meta+a')
  await page().keyboard.press('Backspace')

  if (text) {
    await page().keyboard.type(text, { delay: 8 })
  }
}

// Heights that density may and may not move, on what is on screen (Hermes
// keeps inactive tabs mounted).
const measure = () =>
  page().evaluate(() => {
    const h = node => (node ? Math.round(node.getBoundingClientRect().height * 10) / 10 : null)
    const shown = selector => [...document.querySelectorAll(selector)].find(node => node.checkVisibility() && node.getBoundingClientRect().height > 0)
    const pair = shown('[data-slot="aui_turn-pair"]')

    return {
      bubble: h(pair?.querySelector('.composer-human-message')),
      composer: h(shown('[data-slot="composer-root"]')),
      sidebarHeader: h(shown('[data-slot="sidebar"] [data-panel-header], [data-panel-header]')),
      sidebarSessionRow: h(shown('[data-slot="sidebar"] .row-hover')),
      // The top band: where the surfaces button and the tabs sit, and where
      // the thread begins under them.
      titlebar: (() => {
        const button = document.querySelector('[data-tour="mg-surfaces"]')?.getBoundingClientRect()
        const tab = shown('[data-tree-tab]')?.getBoundingClientRect()
        const viewport = shown('[data-slot="aui_thread-viewport"]')?.getBoundingClientRect()

        return button && tab && viewport ? `button ${Math.round(button.y)}+${Math.round(button.height)}, tab ${Math.round(tab.y)}+${Math.round(tab.height)}, thread from ${Math.round(viewport.y)}` : null
      })(),
      turnPair: h(pair),
      vars: Object.fromEntries(
        ['--conversation-turn-gap', '--turn-block-gap', '--paragraph-gap', '--tool-row-gap'].map(name => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])
      )
    }
  })

// Motion back on, through the page's switch, when a check turned it off.
async function setMotionOn() {
  const sw = page().locator(`${PAGE} #monograph-motion [role="switch"]`)

  if ((await sw.getAttribute('aria-checked').catch(() => 'true')) === 'false') {
    await sw.focus()
    await page().keyboard.press('Space')
    await sleep(200)
  }
}

let files = null
const consoleErrors = []

export async function run() {
  const p = page()

  p.on('console', message => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text().slice(0, 300))
    }
  })
  p.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`))

  files = fixtures()

  // ── p1. Open the page ──
  await check('p1', async (entry, must) => {
    entry.evidence.route = await openPage(entry)
    entry.evidence.url = p.url().replace(/^.*#/, '#')

    const shown = await pageState()

    entry.evidence.page = shown
    must(shown, 'the Monograph settings page did not render [data-mg-ap="page"]')
    entry.evidence.headings = await p.evaluate(() => [...document.querySelectorAll('.mg-ap-heading')].map(node => node.textContent))
    must(JSON.stringify(entry.evidence.headings) === JSON.stringify(['You', 'Chat', 'Motion']), `section headings ${JSON.stringify(entry.evidence.headings)}`)
    entry.evidence.hermesParts = await p.evaluate(selector => {
      const root = document.querySelector(selector)

      return {
        inputs: root.querySelectorAll('[data-slot="input"]').length,
        switches: root.querySelectorAll('[role="switch"]').length,
        segmented: root.querySelectorAll('#monograph-density button[aria-pressed]').length,
        flatStandIns: root.querySelectorAll('.mg-ap-row, .mg-ap-input-flat, .mg-ap-button').length
      }
    }, PAGE)
    must(entry.evidence.hermesParts.flatStandIns === 0, 'the page fell back to flat stand-ins: Hermes parts missing')
    must(shown?.tools === 'true' && shown?.motion === 'true' && shown?.density?.[0] === 'Comfortable', `defaults not shown: ${JSON.stringify(shown)}`)
    await shot(entry, 'p1-page')
  })

  // ── p2. Name and greeting ──
  await check('p2', async (entry, must) => {
    await openPage(entry)

    await inputText('[data-mg-ap="name"]', NAME)
    let shown = await pageState()

    entry.evidence.afterName = { preview: shown.preview, stored: (await stored())?.name, root: (await rootMarks()).greeting }
    must(shown.preview === `What are we working on today, ${NAME}?`, `preview after the name: ${JSON.stringify(shown.preview)}`)
    must((await stored())?.name === NAME, 'the name was not stored')

    // On an empty session.
    await newSession(entry)
    await sleep(500)
    entry.evidence.emptySessionGreeting = await shownGreeting()
    must(entry.evidence.emptySessionGreeting?.content === JSON.stringify(`What are we working on today, ${NAME}?`), `the empty session shows ${entry.evidence.emptySessionGreeting?.content}`)
    must(!(await visible(PAGE)), 'the settings page is still in the document after leaving it')
    await shot(entry, 'p2-empty-session-name')

    // A greeting of one's own with {name}.
    await openPage(entry)
    await inputText('[data-mg-ap="greeting"]', 'Good evening, {name}. Where were we?')
    shown = await pageState()
    entry.evidence.customPreview = shown.preview
    must(shown.preview === `Good evening, ${NAME}. Where were we?`, `custom preview: ${JSON.stringify(shown.preview)}`)
    await newSession(entry)
    await sleep(400)
    entry.evidence.emptySessionCustom = await shownGreeting()
    must(entry.evidence.emptySessionCustom?.content === JSON.stringify(`Good evening, ${NAME}. Where were we?`), `the empty session shows ${entry.evidence.emptySessionCustom?.content}`)
    await shot(entry, 'p2-empty-session-custom')

    // Bad input: markup is text, a 500-character name is cut to 60.
    await openPage(entry)
    await inputText('[data-mg-ap="greeting"]', '<b>Hi</b> <img src=x onerror=alert(1)> {name}')
    shown = await pageState()
    entry.evidence.markup = { preview: shown.preview, elementsInPreview: shown.previewElements, imgsOnPage: await p.evaluate(sel => document.querySelector(sel).querySelectorAll('img:not([data-mg-avatar])').length, PAGE) }
    must(shown.preview === `<b>Hi</b> <img src=x onerror=alert(1)> ${NAME}` && shown.previewElements === 0, `markup preview: ${JSON.stringify(entry.evidence.markup)}`)
    must(entry.evidence.markup.imgsOnPage === 0, 'markup in the greeting became an element')

    await press(p.locator('[data-mg-ap="name"]'))
    await p.keyboard.press('Meta+a')
    await p.keyboard.insertText('x'.repeat(500))
    const long = (await stored())?.name ?? ''

    entry.evidence.longName = { stored: long.length, field: (await pageState()).name.length }
    must(long.length <= 60 && long.length > 0, `a 500-character name stored as ${long.length} characters`)
    await shot(entry, 'p2-bad-input')

    // Back to a plain name and the built-in line for the rest of the run.
    await inputText('[data-mg-ap="name"]', NAME)
    await inputText('[data-mg-ap="greeting"]', '')
    shown = await pageState()
    must(shown.preview === `What are we working on today, ${NAME}?`, `an empty greeting did not bring the built-in line back: ${shown.preview}`)
  })

  // ── p3. Picture ──
  await check('p3', async (entry, must) => {
    await openPage(entry)
    entry.evidence.fixtures = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, `${path.basename(value.file)} ${(value.bytes / 1024 / 1024).toFixed(2)} MB`]))
    entry.evidence.before = (await pageState()).avatar
    must(entry.evidence.before?.kind === 'letter' && entry.evidence.before?.text === 'A', `no letter fallback before a picture: ${JSON.stringify(entry.evidence.before)}`)

    const choose = async file => {
      const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10_000 }), press(p.locator('[data-mg-ap="choose"]'))])

      await chooser.setFiles(file)
      await until(async () => ['done', 'error'].includes((await pageState()).noteKind), 30_000)

      return pageState()
    }

    const inspect = () =>
      p.evaluate(async key => {
        const uri = JSON.parse(window.localStorage.getItem(key) || '{}').avatar ?? ''

        if (!uri) {
          return { bytes: 0 }
        }

        const image = new Image()

        image.src = uri
        await image.decode()

        return { bytes: uri.length, type: uri.slice(5, uri.indexOf(';')), width: image.naturalWidth, height: image.naturalHeight }
      }, STORAGE_KEY)

    // A wide picture: cropped square, at most 128 px, under 40 KB.
    let shown = await choose(files.picture.file)

    entry.evidence.picture = { note: shown.note, stored: await inspect(), shown: shown.avatar }
    const pic = entry.evidence.picture.stored

    must(shown.noteKind === 'done', `picture refused: ${shown.note}`)
    must(pic.bytes > 0 && pic.bytes <= 40 * 1024, `picture stored as ${pic.bytes} bytes`)
    must(pic.width === pic.height && pic.width <= 128 && pic.width > 0, `picture is ${pic.width}x${pic.height}`)
    must(shown.avatar?.kind === 'picture', 'the page does not show the picture')
    must(shown.removeDisabled === false, 'Remove is not available with a picture set')
    await shot(entry, 'p3-picture')

    // A 20 MB image is scaled down like any other.
    shown = await choose(files.huge.file)
    entry.evidence.huge = { note: shown.note, stored: await inspect() }
    must(shown.noteKind === 'done', `the 20 MB image was refused: ${shown.note}`)
    must(entry.evidence.huge.stored.bytes <= 40 * 1024 && entry.evidence.huge.stored.width <= 128, `the 20 MB image stored as ${JSON.stringify(entry.evidence.huge.stored)}`)

    const kept = (await stored())?.avatar

    // Not an image, and an image that is not one: both refused, picture kept.
    shown = await choose(files.text.file)
    entry.evidence.textFile = { note: shown.note, kind: shown.noteKind, keptPicture: (await stored())?.avatar === kept }
    must(shown.noteKind === 'error' && entry.evidence.textFile.keptPicture, `a text file: ${JSON.stringify(entry.evidence.textFile)}`)
    await shot(entry, 'p3-refused')

    shown = await choose(files.broken.file)
    entry.evidence.brokenFile = { note: shown.note, kind: shown.noteKind, keptPicture: (await stored())?.avatar === kept }
    must(shown.noteKind === 'error' && entry.evidence.brokenFile.keptPicture, `a broken image: ${JSON.stringify(entry.evidence.brokenFile)}`)

    // Remove, then put the small picture back for the reload check.
    await press(p.locator('[data-mg-ap="remove"]'))
    await sleep(200)
    shown = await pageState()
    entry.evidence.removed = { avatar: shown.avatar, stored: (await stored())?.avatar }
    must(shown.avatar?.kind === 'letter' && !entry.evidence.removed.stored, `after Remove: ${JSON.stringify(entry.evidence.removed)}`)
    shown = await choose(files.picture.file)
    must(shown.noteKind === 'done', 'the picture could not be set again after Remove')
  })

  // ── p4. Tools, motion, density ──
  // One at a time, each from the page by pointer, each judged on the chat
  // under the settings overlay.
  await check('p4', async (entry, must) => {
    const headLine = () =>
      p.evaluate(() => {
        const head = [...document.querySelectorAll('[data-slot="aui_assistant-message-root"][data-mg-head]')].find(node => node.checkVisibility())
        // The line is an element of ours before the row (div.mg-line), no
        // longer the row's ::before: what it shows is its visible text.
        const line = head?.previousElementSibling?.classList.contains('mg-line') ? head.previousElementSibling : null

        return head ? { before: line ? line.innerText.replace(/\s+/g, ' ').trim() : getComputedStyle(head, '::before').content, after: getComputedStyle(head, '::after').content } : null
      })

    const flip = async (selector, text) => {
      await openPage(entry)
      await press(text ? p.locator(selector, { hasText: text }) : p.locator(selector))
      await sleep(150)

      const marks = await rootMarks()

      await closeSettings()
      await sleep(400)

      return marks
    }

    // Motion: the model menu's entrance, on and then off. Off means what it
    // means everywhere (05-motion.css, motion suite m6): nothing that starts
    // lasts over 1 ms, no transition is created.
    await closeSettings()
    const on = await modelMenuMotion()
    entry.evidence.motionOn = { started: on.filter(item => item.kind === 'anim').slice(0, 6), durToken: await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mg-dur-2').trim()) }
    entry.evidence.motionMarks = await flip('#monograph-motion [role="switch"]')
    const off = await modelMenuMotion()
    entry.evidence.motionOff = { started: off.slice(0, 6), faults: motionFaults(off).slice(0, 6), durToken: await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mg-dur-2').trim()) }
    must(entry.evidence.motionMarks.motion === 'off', `the motion switch left data-mg-motion=${entry.evidence.motionMarks.motion}`)
    must(on.some(item => item.name === 'mg-layer-in' && item.ms >= 100), `motion on: the model menu did not ease in (${JSON.stringify(entry.evidence.motionOn.started)})`)
    must(!motionFaults(off).length, `motion off: ${motionFaults(off).length} animation(s) or transition(s) with time: ${JSON.stringify(motionFaults(off).slice(0, 3))}`)
    entry.evidence.motionMarks = await flip('#monograph-motion [role="switch"]')
    must(entry.evidence.motionMarks.motion === 'on', 'the motion switch did not turn motion back on')

    // A turn with a tool call, in this same chat.
    await type(TOOL_PROMPT, 'Enter')
    await finished(TOOL_ANSWER, 60_000)
    // Measure once the turn has folded (turnDecor), so only density differs.
    entry.evidence.folded = await until(() => visible('[data-slot="aui_assistant-message-root"][data-mg-head][data-mg-steps]'), 10_000)
    must(entry.evidence.folded, 'the turn never folded; the density heights below compare unlike states')
    await sleep(800)

    // Density.
    entry.evidence.comfortable = await measure()
    await shot(entry, 'p4-thread-comfortable')
    entry.evidence.densityMarks = await flip('#monograph-density button', 'Compact')
    entry.evidence.compact = await measure()
    await shot(entry, 'p4-thread-compact')

    const { comfortable: a, compact: b } = entry.evidence
    const rem = value => parseFloat(value)

    must(entry.evidence.densityMarks.density === 'compact', `the density control left data-mg-density=${entry.evidence.densityMarks.density}`)
    must(rem(a.vars['--conversation-turn-gap']) === 0.375 && rem(b.vars['--conversation-turn-gap']) === 0.25, `density vars ${JSON.stringify(a.vars)} -> ${JSON.stringify(b.vars)}`)
    must(b.turnPair < a.turnPair, `density: the turn is not shorter in compact (${a.turnPair} -> ${b.turnPair})`)
    must(b.sidebarSessionRow < a.sidebarSessionRow, `density: the sidebar row is not shorter (${a.sidebarSessionRow} -> ${b.sidebarSessionRow})`)
    must(a.composer === b.composer && a.composer > 0, `density moved the composer (${a.composer} -> ${b.composer})`)
    must(a.titlebar === b.titlebar && a.titlebar, `density moved the top band (${a.titlebar} -> ${b.titlebar})`)
    must(a.sidebarHeader === b.sidebarHeader, `density moved the sidebar header (${a.sidebarHeader} -> ${b.sidebarHeader})`)

    // Tool calls.
    entry.evidence.headLineShown = await headLine()
    entry.evidence.toolsMarks = await flip('#monograph-tool-calls [role="switch"]')
    entry.evidence.headLineHidden = await headLine()
    await shot(entry, 'p4-thread-compact-tools-hidden')
    must(entry.evidence.toolsMarks.tools === 'hidden', `the tool calls switch left data-mg-tools=${entry.evidence.toolsMarks.tools}`)
    must(
      entry.evidence.headLineShown?.before?.includes('1 tool call') && entry.evidence.headLineHidden && !entry.evidence.headLineHidden.before.includes('tool call'),
      `tools: the line read ${JSON.stringify(entry.evidence.headLineShown)} then ${JSON.stringify(entry.evidence.headLineHidden)}`
    )

    // Leave motion off for the reload check.
    await flip('#monograph-motion [role="switch"]')
    entry.evidence.left = await rootMarks()
  })

  // ── p5. Palette ──
  await check('p5', async (entry, must) => {
    const palette = async query => {
      await p.keyboard.press('Meta+k')
      await p.waitForSelector('[cmdk-input], [data-slot="command-input"]', { state: 'visible', timeout: 5_000 })
      await until(() => p.evaluate(() => document.activeElement?.matches('[cmdk-input], [data-slot="command-input"]') ?? false), 3_000)
      await p.keyboard.type(query, { delay: 10 })
      await until(() => p.evaluate(query => document.activeElement?.value === query, query), 3_000)
      await sleep(300)

      return p.evaluate(() => [...document.querySelectorAll('[cmdk-item], [data-slot="command-item"]')].filter(node => node.checkVisibility()).map(node => node.textContent.replace(/\s+/g, ' ').trim()))
    }

    const before = await rootMarks()

    entry.evidence.motionRows = await palette('Toggle motion')
    must(entry.evidence.motionRows.some(row => row.startsWith('Toggle motion')), `no "Toggle motion" row: ${JSON.stringify(entry.evidence.motionRows)}`)
    await p.keyboard.press('Enter')
    await sleep(200)
    await p.keyboard.press('Escape')
    await sleep(200)

    entry.evidence.densityRows = await palette('Toggle density')
    must(entry.evidence.densityRows.some(row => row.startsWith('Toggle density')), `no "Toggle density" row: ${JSON.stringify(entry.evidence.densityRows)}`)
    await p.keyboard.press('Enter')
    await sleep(200)
    await p.keyboard.press('Escape')
    await sleep(200)

    const after = await rootMarks()

    entry.evidence.marks = { before, after }
    must(before.motion !== after.motion && before.density !== after.density, `palette rows did not flip motion and density: ${JSON.stringify(entry.evidence.marks)}`)
    entry.evidence.toolRows = await palette('Toggle tool calls')
    await p.keyboard.press('Escape')
    await sleep(200)
    must(entry.evidence.toolRows.some(row => row.startsWith('Toggle tool calls')), 'the core "Toggle tool calls" row is gone')

    entry.evidence.openRows = await palette('Open Monograph settings')
    must(entry.evidence.openRows.some(row => row.startsWith('Open Monograph settings')), `no "Open Monograph settings" row: ${JSON.stringify(entry.evidence.openRows)}`)
    await p.keyboard.press('Enter')
    entry.evidence.opened = await until(() => visible(PAGE), 5_000)
    must(entry.evidence.opened, '"Open Monograph settings" did not open the page')
    entry.evidence.url = p.url().replace(/^.*#/, '#')

    // Leave tools hidden, motion off and density compact for the reload.
    await press(p.locator('#monograph-density button', { hasText: 'Compact' }))
    if ((await rootMarks()).motion !== 'off') {
      await press(p.locator('#monograph-motion [role="switch"]'))
    }
    entry.evidence.left = await rootMarks()
    await shot(entry, 'p5-palette-opened-page')
  })

  // ── p6. Reload ──
  await check('p6', async (entry, must) => {
    const before = { marks: await rootMarks(), stored: await stored() }

    await closeSettings()
    await p.reload()
    await waitForAppReady({ app: state.app, page: p }, 60_000)
    await p.waitForFunction(() => document.documentElement.dataset.mgReady, null, { timeout: 30_000 })

    const after = { marks: await rootMarks(), stored: await stored() }

    entry.evidence.before = { ...before.marks, name: before.stored?.name, avatarBytes: before.stored?.avatar?.length ?? 0 }
    entry.evidence.after = { ...after.marks, name: after.stored?.name, avatarBytes: after.stored?.avatar?.length ?? 0 }
    must(JSON.stringify(before.marks) === JSON.stringify(after.marks), 'root marks changed across the reload')
    must(after.marks.tools === 'hidden' && after.marks.motion === 'off' && after.marks.density === 'compact', `after reload: ${JSON.stringify(after.marks)}`)
    must(after.stored?.name === NAME && after.stored?.avatar === before.stored?.avatar && after.stored.avatar, 'name or picture lost across the reload')

    await openPage(entry)
    const shown = await pageState()

    entry.evidence.page = shown
    must(shown.name === NAME && shown.avatar?.kind === 'picture' && shown.tools === 'false' && shown.motion === 'false' && shown.density[0] === 'Compact', `the page after reload: ${JSON.stringify(shown)}`)
    await shot(entry, 'p6-after-reload')
  })

  // ── p7. Keyboard only ──
  await check('p7', async (entry, must) => {
    await openPage(entry)
    await p.evaluate(() => window.scrollTo(0, 0))
    // One click into the first field; from there on, keys only.
    await press(p.locator('[data-mg-ap="name"]'))

    const where = () =>
      p.evaluate(() => {
        const node = document.activeElement

        return node?.dataset?.mgAp ?? node?.getAttribute('aria-label') ?? (node?.getAttribute('aria-pressed') !== null ? `choice:${node?.textContent.trim()}` : `${node?.tagName}:${node?.textContent?.trim().slice(0, 20)}`)
      })

    const order = [await where()]

    for (let index = 0; index < 10; index++) {
      await p.keyboard.press('Tab')
      order.push(await where())
    }

    entry.evidence.tabOrder = order

    const expected = ['name', 'choose', 'remove', 'greeting', 'Show tool calls', 'choice:Live', 'choice:Working line', 'choice:Comfortable', 'choice:Compact', 'Animations', 'reset']

    must(JSON.stringify(order.slice(0, expected.length)) === JSON.stringify(expected), `Tab order ${JSON.stringify(order)}, expected ${JSON.stringify(expected)}`)

    await p.keyboard.press('Shift+Tab')
    entry.evidence.shiftTab = await where()
    must(entry.evidence.shiftTab === 'Animations', `Shift+Tab from Reset went to ${entry.evidence.shiftTab}`)

    // Space on a switch, Enter on a choice.
    const focusOn = async target => {
      for (let index = 0; index < 12 && (await where()) !== target; index++) {
        await p.keyboard.press('Shift+Tab')
      }

      return (await where()) === target
    }

    const before = await rootMarks()

    must(await focusOn('Show tool calls'), 'could not reach the tool calls switch with Shift+Tab')
    await p.keyboard.press('Space')
    // Past the two thinking choices to Comfortable.
    await p.keyboard.press('Tab')
    await p.keyboard.press('Tab')
    await p.keyboard.press('Tab')
    await p.keyboard.press('Enter')
    await p.keyboard.press('Tab')
    await p.keyboard.press('Tab')
    await p.keyboard.press('Space')
    await sleep(200)

    const after = await rootMarks()

    entry.evidence.keys = { before, after }
    must(after.tools !== before.tools && after.density === 'comfortable' && after.motion !== before.motion, `Space/Enter did not switch: ${JSON.stringify(entry.evidence.keys)}`)

    // Enter on Reset opens the confirmation; Escape closes it and keeps everything.
    await p.keyboard.press('Tab')
    must((await where()) === 'reset', 'Tab after Motion did not reach Reset')
    await p.keyboard.press('Enter')
    entry.evidence.dialogOpened = await until(() => visible('[role="alertdialog"], [role="dialog"]'), 3_000)
    must(entry.evidence.dialogOpened, 'Enter on Reset opened no confirmation')
    await shot(entry, 'p7-confirm')

    // Focus starts on Cancel, and Enter there cancels.
    entry.evidence.dialogFocus = await where()
    must(entry.evidence.dialogFocus === 'reset-cancel', `the confirmation opened with focus on ${entry.evidence.dialogFocus}, not Cancel`)
    await p.keyboard.press('Enter')
    await sleep(300)
    entry.evidence.afterEnterOnCancel = { dialog: await visible('[role="alertdialog"], [role="dialog"]'), name: (await stored())?.name, focus: await where() }
    must(!entry.evidence.afterEnterOnCancel.dialog && entry.evidence.afterEnterOnCancel.name === NAME, `Enter on Cancel: ${JSON.stringify(entry.evidence.afterEnterOnCancel)}`)

    // Open again; Escape closes it.
    await p.keyboard.press('Enter')
    await until(() => visible('[role="alertdialog"], [role="dialog"]'), 3_000)
    await p.keyboard.press('Escape')
    await sleep(300)
    entry.evidence.afterEscape = { dialog: await visible('[role="alertdialog"], [role="dialog"]'), name: (await stored())?.name }
    must(!entry.evidence.afterEscape.dialog && entry.evidence.afterEscape.name === NAME, `Escape: ${JSON.stringify(entry.evidence.afterEscape)}`)
    entry.evidence.focusAfterEscape = await where()
    must(entry.evidence.focusAfterEscape === 'reset', `focus after Escape went to ${entry.evidence.focusAfterEscape}, not back to Reset`)

    // Typing in the name field, by keys only.
    must(await focusOn('name'), 'could not reach the name field with Shift+Tab')
    // Tab selects the field's text; ArrowRight puts the caret at its end.
    await p.keyboard.press('ArrowRight')
    await p.keyboard.type(' K', { delay: 10 })
    entry.evidence.typedName = (await stored())?.name
    must(entry.evidence.typedName === `${NAME} K`, `typing in the name field stored ${JSON.stringify(entry.evidence.typedName)}`)
    await p.keyboard.press('Backspace')
    await p.keyboard.press('Backspace')
  })

  // ── p8. Reset ──
  await check('p8', async (entry, must) => {
    await openPage(entry)
    await press(p.locator('#monograph-tool-calls [role="switch"]'))
    await press(p.locator('#monograph-density button', { hasText: 'Compact' }))
    await inputText('[data-mg-ap="greeting"]', 'Hello {name}')

    const dialog = '[role="alertdialog"], [role="dialog"]'

    // Cancel first: nothing changes.
    await press(p.locator('[data-mg-ap="reset"]'))
    must(await until(() => visible(dialog), 3_000), 'Reset opened no confirmation')
    entry.evidence.dialogText = await p.evaluate(selector => [...document.querySelectorAll(selector)].find(node => node.checkVisibility())?.innerText.replace(/\s+/g, ' ').slice(0, 300), dialog)
    await shot(entry, 'p8-confirm')
    await press(p.locator('[data-mg-ap="reset-cancel"]'))
    await until(async () => !(await visible(dialog)), 3_000)
    entry.evidence.afterCancel = await stored()
    must(entry.evidence.afterCancel?.name === NAME && entry.evidence.afterCancel?.tools === 'hidden', `Cancel changed something: ${JSON.stringify(entry.evidence.afterCancel)?.slice(0, 200)}`)

    // Then confirm.
    await press(p.locator('[data-mg-ap="reset"]'))
    await until(() => visible(dialog), 3_000)
    await press(p.locator('[data-mg-ap="reset-confirm"]'))
    await until(async () => !(await visible(dialog)), 3_000)
    await sleep(200)

    const config = await stored()

    entry.evidence.afterReset = { stored: { ...config, avatar: config?.avatar ? `${config.avatar.length} bytes` : config?.avatar }, marks: await rootMarks(), page: await pageState() }
    const { marks, page: shown } = entry.evidence.afterReset

    must(config?.name === '' && config?.avatar === '' && config?.greeting === '', `stored after reset: ${JSON.stringify(entry.evidence.afterReset.stored)}`)
    must(marks.tools === 'shown' && marks.motion === 'on' && marks.density === 'comfortable', `root after reset: ${JSON.stringify(marks)}`)
    must(marks.greeting === JSON.stringify('What are we working on today?'), `greeting after reset: ${marks.greeting}`)
    must(shown.name === '' && shown.greeting === '' && shown.avatar?.kind === 'blank' && shown.tools === 'true' && shown.motion === 'true', `page after reset: ${JSON.stringify(shown)}`)
    await shot(entry, 'p8-after-reset')
  })

  // ── p9. Widths ──
  await check('p9', async (entry, must) => {
    await openPage(entry)

    // Something in every field, so the layout carries content.
    await inputText('[data-mg-ap="name"]', NAME)
    await inputText('[data-mg-ap="greeting"]', 'Good evening, {name}.')

    const resize = width =>
      state.app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows()[0]
        const { height } = win.getBounds()

        win.setSize(width, height)

        return win.getBounds()
      }, width)

    const overflow = () =>
      p.evaluate(selector => {
        const root = document.querySelector(selector)
        const box = root.getBoundingClientRect()
        const out = [...root.querySelectorAll('*')].filter(node => {
          const rect = node.getBoundingClientRect()

          return node.checkVisibility() && rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1)
        })

        return { width: Math.round(box.width), overflowing: out.slice(0, 5).map(node => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`) }
      }, PAGE)

    for (const width of [1220, 900]) {
      entry.evidence[`window${width}`] = await resize(width)
      await sleep(600)
      entry.evidence[`layout${width}`] = await overflow()
      must(entry.evidence[`layout${width}`].overflowing.length === 0, `at ${width}px something sticks out of the page: ${entry.evidence[`layout${width}`].overflowing}`)
      await p.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'start' }), PAGE)
      await shot(entry, `p9-page-${width}-top`)
      await p.evaluate(selector => document.querySelector(`${selector} [data-mg-ap="reset"]`).scrollIntoView({ block: 'center' }), PAGE)
      await sleep(200)
      await shot(entry, `p9-page-${width}-bottom`)
    }

    await resize(1220)
    entry.evidence.consoleErrors = consoleErrors.slice(0, 20)
    const ours = consoleErrors.filter(text => /monograph|appearance|mg-ap|pageerror/i.test(text))

    must(ours.length === 0, `renderer errors from this plugin: ${JSON.stringify(ours)}`)
  })

  // ── p10. Hot reload ──
  await check('p10', async (entry, must) => {
    await closeSettings()

    const owner = () => p.evaluate(() => document.getElementById('mg-css')?.dataset.owner ?? null)
    const before = await owner()

    // Truncate-and-write keeps the inode Hermes watches, as build.mjs does.
    fs.writeFileSync(state.installed, `${fs.readFileSync(state.installed, 'utf8')}\n// rig: hot reload ${Date.now()}\n`)
    entry.evidence.reloaded = await until(async () => (await owner()) !== before, 20_000, 250)
    must(entry.evidence.reloaded, 'the plugin did not hot reload within 20s')
    await sleep(800)

    const rows = async query => {
      await p.keyboard.press('Meta+k')
      await p.waitForSelector('[cmdk-input], [data-slot="command-input"]', { state: 'visible', timeout: 5_000 })
      await until(() => p.evaluate(() => document.activeElement?.matches('[cmdk-input], [data-slot="command-input"]') ?? false), 3_000)
      await p.keyboard.type(query, { delay: 10 })
      await sleep(400)

      const found = await p.evaluate(() => [...document.querySelectorAll('[cmdk-item], [data-slot="command-item"]')].filter(node => node.checkVisibility()).map(node => node.textContent.replace(/\s+/g, ' ').trim()))

      await p.keyboard.press('Escape')
      await sleep(200)

      return found
    }

    entry.evidence.motionRows = await rows('Toggle motion')
    entry.evidence.densityRows = await rows('Toggle density')
    entry.evidence.openRows = await rows('Open Monograph settings')
    must(entry.evidence.motionRows.filter(row => row.startsWith('Toggle motion')).length === 1, `"Toggle motion" rows after a hot reload: ${JSON.stringify(entry.evidence.motionRows)}`)
    must(entry.evidence.densityRows.filter(row => row.startsWith('Toggle density')).length === 1, `"Toggle density" rows after a hot reload: ${JSON.stringify(entry.evidence.densityRows)}`)
    must(entry.evidence.openRows.filter(row => row.startsWith('Open Monograph settings')).length === 1, `"Open Monograph settings" rows after a hot reload: ${JSON.stringify(entry.evidence.openRows)}`)

    entry.evidence.modules = await p.evaluate(() => document.documentElement.dataset.mgModules ?? null)
    must(/\bappearance\b/.test(entry.evidence.modules ?? ''), `data-mg-modules after the reload: ${entry.evidence.modules}`)
    await openPage(entry)
    entry.evidence.pages = await p.evaluate(selector => document.querySelectorAll(selector).length, PAGE)
    must(entry.evidence.pages === 1, `${entry.evidence.pages} pages after a hot reload`)
    await shot(entry, 'p10-after-hot-reload')
  })

  results.observations.push(`appearance suite: ${consoleErrors.length} renderer console errors during the suite (see p9 evidence)`)

  // ── p11. Hot reload twice, then unloaded: stop() leaves nothing ──
  // Our footprint is everything that carries an mg- class or a data-mg-
  // attribute, the root's data-mg-* keys and the stylesheet. Two reloads
  // change none of it; unloading (a stand-in plugin with Monograph's id)
  // leaves none of it.
  await check('p11', async (entry, must) => {
    const page = state.page
    await openPage(entry)
    await sleep(600)

    const footprint = () =>
      page.evaluate(extra => {
        const all = [...document.querySelectorAll('*')]
        const ours = all.filter(node => node.id !== 'mg-css' && node !== document.documentElement && (/(^|\s)mg-/.test(typeof node.className === 'string' ? node.className : node.getAttribute('class') ?? '') || [...node.attributes].some(attr => attr.name.startsWith('data-mg-'))))

        return {
          extra: extra ? document.querySelectorAll(extra).length : 0,
          ours: ours.length,
          kinds: [...new Set(ours.map(node => `${node.tagName.toLowerCase()}.${[...node.classList].filter(name => name.startsWith('mg-')).join('.')}${[...node.attributes].filter(attr => attr.name.startsWith('data-mg-')).map(attr => `[${attr.name}]`).join('')}`))].sort().slice(0, 40),
          root: Object.keys(document.documentElement.dataset).filter(key => key.startsWith('mg')).sort().join(' '),
          styles: document.querySelectorAll('#mg-css').length
        }
      }, extra)
    const extra = '[data-mg-ap]'
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
    await shot(entry, 'p11-loaded-again')
    must(before.ours > 0 && before.styles === 1, `before: ${JSON.stringify(before)}`)
    must(after.styles === 1 && after.root === before.root && after.extra === before.extra, `after two reloads: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    must(JSON.stringify(after.kinds) === JSON.stringify(before.kinds) && Math.abs(after.ours - before.ours) <= 2, `after two reloads our nodes changed: ${after.ours} vs ${before.ours}; ${after.kinds.filter(kind => !before.kinds.includes(kind)).join(', ')}`)
    must(unloaded.ours === 0 && !unloaded.root && unloaded.styles === 0 && unloaded.extra === 0, `left behind after unloading: ${JSON.stringify(unloaded)}`)
    must(back.styles === 1 && back.root === before.root, `after loading again: ${JSON.stringify(back)}`)
  })


  // ── p12. Odd names ──
  // Each typed by keyboard into the name field; the greeting an empty chat
  // shows (the preview line, which is greeting(config), and the dock's
  // --mg-greeting) carries it exactly, with no $-pattern expanded, and the
  // stored value is the same text. 80 characters are cut at the field's 60.
  await check('p12', async (entry, must) => {
    await openPage(entry)

    const cases = [
      ['dollars', 'A$&B $1 $$'],
      ['emoji', 'Zoë 🦊 Ünïcødé'],
      ['long', 'N'.repeat(30) + 'm'.repeat(30) + 'X'.repeat(20)],
      ['empty', '']
    ]

    entry.evidence.cases = {}

    for (const [label, text] of cases) {
      await inputText('[data-mg-ap="name"]', text)
      await sleep(250)

      const want = Array.from(text).slice(0, 60).join('')
      const shown = await pageState()
      const saved = (await stored())?.name ?? ''
      const marks = await rootMarks()

      entry.evidence.cases[label] = { field: shown?.name, preview: shown?.preview, saved, avatar: shown?.avatar?.kind }
      must(saved === want, `${label}: stored ${JSON.stringify(saved)}, typed ${JSON.stringify(want)}`)
      must(shown?.name === want, `${label}: the field shows ${JSON.stringify(shown?.name)}`)

      if (want) {
        must(shown?.preview?.includes(want), `${label}: the greeting reads ${JSON.stringify(shown?.preview)}`)
        must(marks.greeting.length > want.length, `${label}: --mg-greeting is ${marks.greeting.slice(0, 120)}`)
      } else {
        must(shown?.preview && !/undefined|null|\{name\}|, ?[.?!]?$/.test(shown.preview), `empty name: the greeting reads ${JSON.stringify(shown?.preview)}`)
        must(shown?.avatar?.kind !== 'letter' || shown?.avatar?.text === '', `empty name: the avatar shows ${JSON.stringify(shown?.avatar)}`)
      }
    }

    await shot(entry, 'p12-empty-name')
    await inputText('[data-mg-ap="name"]', NAME)
    await sleep(250)
  })

  // ── p13. The Switch in grayscale ──
  await check('p13', async (entry, must) => {
    await openPage(entry)

    const look = () =>
      page().evaluate(selector => {
        const sw = document.querySelector(`${selector} #monograph-motion [role="switch"]`)
        const knob = sw?.querySelector('[data-slot="switch-thumb"]')

        if (!sw || !knob) {
          return null
        }

        const rgb = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
        const gray = value => {
          const [r, g, b] = rgb(value)

          return Math.max(r, g, b) - Math.min(r, g, b) <= 2
        }
        const luma = value => {
          const [r, g, b] = rgb(value)

          return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
        }
        const ts = getComputedStyle(sw)
        const ks = getComputedStyle(knob)
        const sr = sw.getBoundingClientRect()
        const kr = knob.getBoundingClientRect()

        return {
          checked: sw.getAttribute('aria-checked'),
          knobGray: gray(ks.backgroundColor),
          knobLuma: luma(ks.backgroundColor),
          knobX: Math.round(kr.x - sr.x),
          ring: `${ts.outlineStyle} ${ts.outlineWidth} ${ts.outlineColor}`,
          ringGray: gray(ts.outlineColor) && !/rgb\(\d+, \d+, \d+\) .*rgb/.test(ts.boxShadow),
          shadow: ts.boxShadow,
          knobShadow: ks.boxShadow,
          trackBorderGray: gray(ts.borderTopColor),
          trackGray: gray(ts.backgroundColor),
          trackLuma: luma(ts.backgroundColor)
        }
      }, PAGE)

    const sw = page().locator(`${PAGE} #monograph-motion [role="switch"]`)
    const states = {}

    for (let i = 0; i < 2; i += 1) {
      const now = await look()

      states[now?.checked] = now
      await sw.focus()
      await page().keyboard.press('Space')
      await sleep(300)
    }

    // Focus by keyboard: Shift+Tab then Tab lands on it with a visible ring.
    await sw.focus()
    await page().keyboard.press('Shift+Tab')
    await page().keyboard.press('Tab')
    await sleep(200)
    states.focused = await look()
    entry.evidence.states = states

    const on = states.true
    const off = states.false

    must(on && off, `the motion switch was not seen in both states: ${JSON.stringify(Object.keys(states))}`)

    if (on && off) {
      must(on.trackGray && off.trackGray && on.knobGray && off.knobGray && on.trackBorderGray && off.trackBorderGray, `colour in the switch: ${JSON.stringify({ on, off })}`)
      must(on.knobX - off.knobX >= 10, `the knob moves ${on.knobX - off.knobX} px between the states`)
      must(on.knobLuma - off.knobLuma >= 60 && on.trackLuma - off.trackLuma >= 40, `on and off differ too little in brightness: knob ${off.knobLuma}->${on.knobLuma}, track ${off.trackLuma}->${on.trackLuma}`)
      must(on.knobLuma >= 240, `the knob when on is not white (${on.knobLuma})`)
      must(on.shadow === 'none' && off.shadow === 'none' && on.knobShadow === 'none', `shadows: ${on.shadow} / ${on.knobShadow}`)
    }

    must(states.focused?.ring?.startsWith('solid') && states.focused.ringGray, `focus ring: ${states.focused?.ring} / ${states.focused?.shadow}`)
    await shot(entry, 'p13-switch-focused')
    await setMotionOn()
  })

  // ── p14. Tool calls on an open thread ──
  // A thread of several turns with tool calls, scrolled to its middle; the
  // switch flipped on the page over it, then closed. The rows go at once,
  // and the user message that was at the top of the view is still there.
  await check('p14', async (entry, must) => {
    // In the chat the earlier checks used (it already holds a tool turn).
    await closeSettings()

    for (let i = 0; i < 6; i += 1) {
      await type(`${TOOL_PROMPT} turn ${i}`, 'Enter')
      await finished(TOOL_ANSWER, 60_000).catch(() => undefined)
      await sleep(500)
    }

    const view = () =>
      page().evaluate(() => {
        const viewport = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].filter(node => node.checkVisibility()).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]

        if (!viewport) {
          return null
        }

        const top = viewport.getBoundingClientRect().top
        const users = [...viewport.querySelectorAll('[data-role="user"]')]
        const anchor = users.find(node => node.getBoundingClientRect().bottom > top + 8) ?? null
        // Tool rows not hidden by their own style (a folded turn hides them
        // through its parent, which is not what is tested here).
        const tools = [...viewport.querySelectorAll('[data-role="assistant"] :is([data-slot="tool-block"], [data-tool-summary])')].filter(node => getComputedStyle(node).display !== 'none').length

        return {
          anchor: anchor ? users.indexOf(anchor) : -1,
          anchorY: anchor ? Math.round(anchor.getBoundingClientRect().top - top) : null,
          max: viewport.scrollHeight - viewport.clientHeight,
          scrollTop: Math.round(viewport.scrollTop),
          tools
        }
      })

    // Into the middle of the thread.
    await page().evaluate(() => {
      const viewport = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].filter(node => node.checkVisibility()).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]

      viewport.scrollTop = Math.round((viewport.scrollHeight - viewport.clientHeight) / 2)
    })
    await sleep(600)

    const before = await view()

    await openPage(entry)

    const sw = page().locator(`${PAGE} #monograph-tool-calls [role="switch"]`)

    await sw.focus()
    await page().keyboard.press('Space')

    // At once: within two frames of the key, with the page still open.
    const atOnce = await page().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.documentElement.dataset.mgTools ?? null)))))

    await closeSettings()
    await sleep(500)

    const hidden = await view()

    await openPage(entry)
    await sw.focus()
    await page().keyboard.press('Space')
    await closeSettings()
    await sleep(500)

    const shown = await view()

    Object.assign(entry.evidence, { before, atOnce, hidden, shown })
    must(before && before.max > 200 && before.tools > 0, `no scrollable thread with tool rows to test on: ${JSON.stringify(before)}`)
    must(atOnce === 'hidden', `two frames after the key the root reads data-mg-tools=${atOnce}`)
    must(hidden && hidden.tools === 0, `tool rows still drawn after hiding: ${JSON.stringify(hidden)}`)
    must(hidden && hidden.anchor === before.anchor && Math.abs(hidden.anchorY - before.anchorY) <= 24, `what was in view moved when the rows went: ${JSON.stringify({ before, hidden })}`)
    must(shown && shown.tools > 0 && shown.anchor === before.anchor && Math.abs(shown.anchorY - before.anchorY) <= 24, `what was in view moved when the rows came back: ${JSON.stringify({ before, shown })}`)
    await shot(entry, 'p14-thread-after')
  })

  // ── p15. An app restart and a second window ──
  // Values set by the page, then the app quit the way a person quits it and
  // started again on the same profile: the page, the root and the greeting
  // show the same. Then a second window of the same app.
  // ── p16. Thinking ──
  // Two values, on our page; the root mark follows at once, the value is
  // stored with the others, and Hermes' own reasoning preference is never
  // persisted (neither its localStorage key nor the sandbox's config.yaml).
  await check('p16', async (entry, must) => {
    const HERMES_KEY = 'hermes.desktop.reasoning.collapsedByDefault'
    const hermesPref = () => page().evaluate(key => window.localStorage.getItem(key), HERMES_KEY)
    const configYaml = () => {
      try {
        return fs.readFileSync(path.join(state.sandbox.hermesHome, 'config.yaml'), 'utf8')
      } catch {
        return ''
      }
    }
    const read = () =>
      page().evaluate(
        ({ selector, key }) => {
          const row = document.querySelector(`${selector} #monograph-thinking`)

          return {
            mark: document.documentElement.dataset.mgThinking ?? null,
            stored: JSON.parse(window.localStorage.getItem(key) || '{}').thinking ?? null,
            buttons: row ? [...row.querySelectorAll('button')].map(button => `${button.textContent.trim()}${button.getAttribute('aria-pressed') === 'true' || button.getAttribute('aria-checked') === 'true' || button.dataset.state === 'on' || button.dataset.state === 'active' ? '*' : ''}`) : null
          }
        },
        { selector: PAGE, key: STORAGE_KEY }
      )
    const prefBefore = await hermesPref()
    const yamlBefore = configYaml()

    await openPage(entry)

    const first = await read()

    await press(page().locator(`${PAGE} #monograph-thinking button`, { hasText: 'Working line' }))
    await sleep(150)

    const line = await read()

    await press(page().locator(`${PAGE} #monograph-thinking button`, { hasText: 'Live' }))
    await sleep(150)

    const live = await read()

    // MG_RIG_PLANT=p16 (self-test, never a verdict): Hermes' own preference
    // written as if the switch had persisted it.
    if ((process.env.MG_RIG_PLANT ?? '').split(',').includes('p16')) {
      results.notes.push('appearance: MG_RIG_PLANT=p16: a planted fault (self-test, not a verdict)')
      await page().evaluate(key => window.localStorage.setItem(key, 'planted-p16'), HERMES_KEY)
    }


    Object.assign(entry.evidence, { first, line, live, hermesPrefBefore: prefBefore, hermesPrefAfter: await hermesPref(), configMentionsReasoningBefore: /collapsed|show_reasoning/i.test(yamlBefore), configMentionsReasoningAfter: /collapsed|show_reasoning/i.test(configYaml()), configChanged: yamlBefore !== configYaml() })
    await shot(entry, 'p16-thinking-row')
    must(first.buttons?.length === 2, `the Thinking row has ${first.buttons?.length ?? 'no'} choices: ${JSON.stringify(first.buttons)}`)
    must(first.mark === 'live' && first.buttons?.[0] === 'Live*', `by default thinking is not "live": ${JSON.stringify(first)}`)
    must(line.mark === 'line' && line.stored === 'line' && line.buttons?.[1] === 'Working line*', `"Working line" did not apply at once and store: ${JSON.stringify(line)}`)
    must(live.mark === 'live' && live.stored === 'live' && live.buttons?.[0] === 'Live*', `"Live" did not apply at once and store: ${JSON.stringify(live)}`)
    must(entry.evidence.hermesPrefAfter === prefBefore, `Hermes' stored reasoning preference changed: ${prefBefore} -> ${entry.evidence.hermesPrefAfter}`)
    must(!entry.evidence.configChanged, "the sandbox's config.yaml changed while thinking was switched")
  })

  await check('p15', async (entry, must) => {
    await openPage(entry)
    await inputText('[data-mg-ap="name"]', 'Restart Tester')
    await inputText('[data-mg-ap="greeting"]', 'Back again, {name}')

    // Compact, tools hidden, motion off: each away from its default.
    await press(page().locator(`${PAGE} #monograph-density button`, { hasText: 'Compact' }))

    for (const id of ['monograph-tool-calls', 'monograph-motion']) {
      const sw = page().locator(`${PAGE} #${id} [role="switch"]`)

      if ((await sw.getAttribute('aria-checked')) === 'true') {
        await sw.focus()
        await page().keyboard.press('Space')
      }
    }

    await sleep(500)

    const before = { marks: await rootMarks(), page: await pageState(), stored: await stored() }
    const { app } = state
    const proc = app.process()

    await closeSettings()
    await Promise.race([app.close(), sleep(20_000)])
    entry.evidence.quit = proc.exitCode !== null || proc.signalCode !== null ? 'exited' : 'still running'

    // The same launch as the harness's boot(): same sandbox, same env.
    const { _electron } = await import(new URL(`file://${path.join(HERMES_REPO, 'node_modules/@playwright/test/index.mjs')}`).href)
    const env = buildAppEnv(state.sandbox, {
      HERMES_DESKTOP_PYTHON: state.python,
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(name => [name, 'http://127.0.0.1:9'])),
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1'
    })
    const desktop = path.join(HERMES_REPO, 'apps', 'desktop')
    const again = await _electron.launch({ args: ['-r', path.join(import.meta.dirname, '..', 'no-focus.cjs'), desktop, '--disable-gpu', '--no-sandbox'], cwd: desktop, env, executablePath: findElectron() })
    const win = await again.firstWindow()

    state.app = again
    state.page = win
    state.cdp = await win.context().newCDPSession(win)
    await state.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitForAppReady({ app: again, page: win }, 120_000)
    await win.waitForSelector('[data-tour="mg-surfaces"]', { state: 'attached', timeout: 60_000 })
    await sleep(1500)

    const marks = await rootMarks()

    await openPage(entry)

    const after = { marks, page: await pageState(), stored: await stored() }

    entry.evidence.before = before
    entry.evidence.afterRestart = after
    await shot(entry, 'p15-after-restart')

    for (const key of ['name', 'greeting', 'tools', 'motion', 'density']) {
      must(JSON.stringify(after.stored?.[key]) === JSON.stringify(before.stored?.[key]), `${key} after a restart: ${JSON.stringify(after.stored?.[key])}, before ${JSON.stringify(before.stored?.[key])}`)
    }

    must(JSON.stringify(after.marks) === JSON.stringify(before.marks), `the root after a restart ${JSON.stringify(after.marks)} vs ${JSON.stringify(before.marks)}`)
    must(after.page?.name === 'Restart Tester' && after.page?.greeting === 'Back again, {name}' && after.page?.tools === 'false' && after.page?.motion === 'false' && after.page?.density?.[0] === 'Compact', `the page after a restart: ${JSON.stringify(after.page)}`)

    // A second window: Hermes' own door (preload: openWindow).
    const opened = again.waitForEvent('window', { timeout: 20_000 }).catch(() => null)

    await win.evaluate(() => window.hermesDesktop?.openWindow?.())

    const second = await opened

    entry.evidence.secondWindow = Boolean(second)

    if (second) {
      await second.waitForSelector('[data-tour="mg-surfaces"]', { state: 'attached', timeout: 60_000 }).catch(() => undefined)
      await sleep(1500)

      const there = await second.evaluate(key => {
        const root = document.documentElement

        return {
          marks: { density: root.dataset.mgDensity ?? null, greeting: getComputedStyle(root).getPropertyValue('--mg-greeting').trim(), motion: root.dataset.mgMotion ?? null, tools: root.dataset.mgTools ?? null },
          stored: JSON.parse(localStorage.getItem(key) || '{}')
        }
      }, STORAGE_KEY)

      entry.evidence.secondWindowSees = there.marks
      must(JSON.stringify(there.marks) === JSON.stringify(before.marks), `the second window shows ${JSON.stringify(there.marks)}, the first ${JSON.stringify(before.marks)}`)

      // A change in one window reaches the other.
      await win.evaluate(() => document.querySelector('[data-mg-ap="name"]') && true)
      await inputText('[data-mg-ap="name"]', 'Second Window')
      await sleep(1000)
      entry.evidence.secondWindowAfterChange = await second.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').name ?? null, STORAGE_KEY)
      entry.evidence.secondWindowGreeting = await second.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mg-greeting').trim())
      must(entry.evidence.secondWindowAfterChange === 'Second Window', `the second window's stored name is ${entry.evidence.secondWindowAfterChange}`)
      must(entry.evidence.secondWindowGreeting.includes('Second Window'), `a name changed in the first window does not reach the second window's greeting: ${entry.evidence.secondWindowGreeting.slice(0, 80)}`)
      await second.close().catch(() => undefined)
    } else {
      must(false, 'Hermes opened no second window (hermesDesktop.openWindow)')
    }
  })

}
