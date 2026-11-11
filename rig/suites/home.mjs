// Home and sidebar sections (src/modules/30-home.js, src/css/62-home.css,
// src/css/20-sidebar.css). One app launch: the sandbox starts as a new profile
// with no sessions; 500 sessions are then written into its state.db by the
// backend's own SessionDB (Python), and the page is reloaded.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HERMES_REPO, PLUGIN, check, composer, hotReload, results, setWindow, shot, sleep, state, stubPlugin, type } from '../harness.mjs'

export const checks = [
  ['h1', 'New profile, no sessions: home looks intended'],
  ['h2', 'Greeting with the name and picture from config'],
  ['h3', 'Recent sessions in order (500 seeded); a real click opens one'],
  ['h4', 'Home never shows over a session with messages'],
  ['h5', 'Pin and unpin from home survive a reload; sidebar Pinned follows'],
  ['h6', 'Quick action fills the message box and does not send'],
  ['h7', 'Home leaves on send and does not come back'],
  ['h8', 'Keyboard: every home item reachable by Tab, Enter opens, focus visible'],
  ['h9', 'Layouts at 900 and 1800 px, and at 800 px and 125 percent zoom: no overlap, greeting clear of the box'],
  ['h10', 'Sidebar: pinned above the history, no tools group, quiet labels'],
  ['h11', 'Motion: arrives once with a stagger, nothing moves with motion off'],
  ['h12', 'Surfaces menu: Home row opens a new empty session'],
  ['h13', 'Hot reload twice, then unloaded: one of everything, then nothing of ours'],
  ['h15', 'Keyboard in the lists (arrows, Home, End); a pin made in Hermes\' sidebar shows on home and leaves with its unpin; a session deleted in the sidebar leaves home'],
  ['h16', 'Home stays current with home on screen: a pin, an unpin and a delete made in Hermes\' sidebar, and a delete made in a second window, show within a second'],
  ['h17', 'Menus over home (model, effort, attach, surfaces, sidebar context, palette), closed by pointer and by Escape: greeting, home and the message box never move or vanish for a frame'],
  ['h18', 'First send from a new session and a session switch: the message box never shows at the middle again for a frame (bare Hermes filmed alongside)'],
  ['h19', 'A session with no messages at its own route (#/<id>, as restored at launch or opened from the sidebar) gets home and the centred message box; leaving it for a session with messages shows no home frame'],
  ['h14', 'One left edge: greeting, chips, labels and row titles on the message box frame, within 1 px, at 1220, 1600 and 800 px, zoom 1 and 1.25']
]

export const mock = { replyForPrompt: () => 'Reply from the mock model, MG_HOME_REPLY.' }

const CONFIG_KEY = 'hermes.plugin.monograph.config'
const NAME = 'Rig Tester'
// A plain grey figure: a picture without anything personal in it.
const AVATAR =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#777"/><circle cx="32" cy="26" r="12" fill="#bbb"/><rect x="12" y="44" width="40" height="20" rx="10" fill="#bbb"/></svg>'
  ).toString('base64')

// 500 sessions. The first eight carry titles and some a model; the rest are
// numbered. `ago` is seconds since the last message; the expected recent
// order is by `ago`, smallest first.
const NAMED = [
  ['Plan the launch', 'anthropic/claude-sonnet-4'],
  ['Research notes on solar storage', 'openai/gpt-5'],
  ['Draft the quarterly letter', null],
  ['Review the contract', 'deepseek/deepseek-chat'],
  ['Trip itinerary', null],
  ['A very long session title that has to be cut short at the end of its row, whatever the width', 'google/gemini-2.5-pro'],
  ['Kitchen budget', null],
  ['Reading list', null]
]
const SEEDED = Array.from({ length: 500 }, (_, i) => ({
  ago: 120 + i * 900,
  id: `mg_home_${String(i).padStart(3, '0')}`,
  model: NAMED[i]?.[1] ?? (i % 3 === 0 ? 'mock-model' : null),
  prompt: `Seeded prompt ${i}`,
  title: NAMED[i]?.[0] ?? `Seeded session ${String(i).padStart(3, '0')}`
}))

const SEED = `
import json, sys, time
from hermes_state import SessionDB
spec = json.load(open(sys.argv[1]))
db = SessionDB()
now = time.time()
for s in spec:
    t = now - s['ago']
    db.create_session(s['id'], 'desktop', model=s.get('model'), profile_name='default')
    db.append_message(s['id'], 'user', s['prompt'], timestamp=t - 1)
    db.append_message(s['id'], 'assistant', 'A seeded reply.', timestamp=t)
    db.set_session_title(s['id'], s['title'])
    db._execute_write(lambda c, s=s, t=t: c.execute('UPDATE sessions SET started_at=? WHERE id=?', (t - 5, s['id'])))
print('seeded', len(spec))
`

function seedNow() {
  const { sandbox } = state
  const script = path.join(sandbox.root, 'mg-home-seed.py')
  const spec = path.join(sandbox.root, 'mg-home-seed.json')

  fs.writeFileSync(script, SEED)
  fs.writeFileSync(spec, JSON.stringify(SEEDED))

  // A clean environment: the backend's Python finds its own packages.
  const started = Date.now()
  const result = spawnSync(state.python, [script, spec], {
    cwd: HERMES_REPO,
    encoding: 'utf8',
    env: { HERMES_HOME: sandbox.hermesHome, HOME: sandbox.root, PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 240_000
  })

  return { ms: Date.now() - started, status: result.status, stderr: String(result.stderr).slice(-800), stdout: String(result.stdout).trim() }
}

// Everything the checks read about home, in one pass.
const read = () =>
  state.page.evaluate(() => {
    const box = node => {
      if (!node) {
        return null
      }

      const r = node.getBoundingClientRect()

      return { b: Math.round(r.bottom), h: Math.round(r.height), r: Math.round(r.right), w: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y) }
    }

    const home = document.querySelector('.mg-home')
    // The chat surface on screen: the one home is in, else the first not hidden.
    const surface =
      home?.closest('[data-chat-surface]') ??
      [...document.querySelectorAll('[data-chat-surface]')].find(node => !node.closest('[inert], [aria-hidden="true"]')) ??
      null
    const dock = surface?.querySelector('[data-slot="composer-dock"]')
    const avatar = document.querySelector('.mg-home-avatar')
    const rows = section =>
      [...document.querySelectorAll(`.mg-home-section[aria-label="${section}"] .mg-home-row`)].map(row => ({
        id: row.dataset.mgSession,
        model: row.querySelector('.mg-home-model')?.textContent ?? '',
        title: row.querySelector('.mg-home-title')?.textContent ?? '',
        when: row.querySelector('.mg-home-when')?.textContent ?? ''
      }))

    return {
      avatar: avatar ? { box: box(avatar), loaded: avatar.complete && avatar.naturalWidth > 0 } : null,
      body: box(document.querySelector('.mg-home-body')),
      composer: box(surface?.querySelector('[data-slot="composer-root"]')),
      dockBeforeDisplay: dock ? getComputedStyle(dock, '::before').display : null,
      greeting: document.querySelector('.mg-home-greeting')?.textContent ?? null,
      hash: location.hash,
      hello: box(document.querySelector('.mg-home-hello')),
      note: document.querySelector('.mg-home-note')?.textContent ?? null,
      pinned: rows('Pinned'),
      quick: [...document.querySelectorAll('.mg-home-action')].map(node => node.textContent),
      recent: rows('Recent'),
      skeleton: Boolean(document.querySelector('.mg-home-skeleton')),
      surface: box(surface),
      // Recent rows a person can see: inside home's scroll box and the chat.
      visibleRecent: (() => {
        const body = document.querySelector('.mg-home-body')?.getBoundingClientRect()
        const area = surface?.getBoundingClientRect()

        return body && area
          ? [...document.querySelectorAll('.mg-home-section[aria-label="Recent"] .mg-home-row')].filter(row => {
              const r = row.getBoundingClientRect()

              return r.top >= Math.max(body.top, area.top) - 1 && r.bottom <= Math.min(body.bottom, area.bottom) + 1
            }).length
          : 0
      })(),
      userMessages: surface?.querySelectorAll('[data-slot="aui_thread-content"] [data-role="user"]').length ?? 0,
      visible: Boolean(home)
    }
  })

const waitHome = (timeout = 15_000) => state.page.waitForSelector('.mg-home-body', { state: 'visible', timeout })
const waitRows = (timeout = 20_000) =>
  state.page.waitForSelector('.mg-home-section[aria-label="Recent"] .mg-home-row', { state: 'visible', timeout })
const config = () => state.page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), CONFIG_KEY)
const prompts = () => state.mock.receivedPrompts?.length ?? 0

const patchConfig = patch =>
  state.page.evaluate(
    ({ key, patch }) => {
      const current = JSON.parse(localStorage.getItem(key) || '{}')

      for (const [name, value] of Object.entries(patch)) {
        if (value === null) {
          delete current[name]
        } else {
          current[name] = value
        }
      }

      localStorage.setItem(key, JSON.stringify(current))
    },
    { key: CONFIG_KEY, patch }
  )

async function reload() {
  await state.page.reload()
  await state.page.waitForSelector('[data-tour="mg-surfaces"]', { state: 'attached', timeout: 60_000 })
  await state.page.waitForSelector('[data-slot="composer-root"] [contenteditable="true"]', { state: 'visible', timeout: 60_000 })
}

// A planted fault: Monograph hot-reloaded with `swaps` ([from, to] pairs)
// made in its built source, each of which must be found.
async function plantReload(swaps) {
  let source = fs.readFileSync(PLUGIN, 'utf8')

  for (const [from, to] of swaps) {
    if (!source.includes(from)) {
      throw new Error(`plant: not in the build: ${from.slice(0, 60)}`)
    }

    source = source.replace(from, to)
  }

  const file = path.join(state.sandbox.root, `mg-plant-${Date.now()}.js`)

  fs.writeFileSync(file, source)
  await hotReload({ source: file })

  return `planted: ${swaps.length} change(s)`
}

// A person's click at the middle of an element: pointer moves there, presses.
async function click(locator) {
  await locator.scrollIntoViewIfNeeded()

  const b = await locator.boundingBox()

  if (!b) {
    throw new Error('nothing to click')
  }

  await state.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await state.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

// A new session the way the corner's "New session" button makes one. From a
// session with messages that is a new tab (a tile); from a draft, the draft.
async function openHome() {
  const button = state.page.locator('[data-slot="sidebar"] button[aria-label="New session"]').first()

  await click(button)
  await waitHome()
}

// Frames during the next `ms` in which home was on screen: where, and
// whether the thread it sat in had messages.
const sample = ms =>
  state.page.evaluate(
    ms =>
      new Promise(resolve => {
        const seen = []
        const end = performance.now() + ms
        const tick = () => {
          for (const home of document.querySelectorAll('.mg-home')) {
            const surface = home.closest('[data-chat-surface]')

            seen.push({
              at: Math.round(performance.now()),
              hash: location.hash,
              messages: surface?.querySelectorAll('[data-slot="aui_thread-content"] [data-role]').length ?? -1,
              target: surface?.getAttribute('data-composer-target') ?? null
            })
          }

          if (performance.now() < end) {
            requestAnimationFrame(tick)
          } else {
            resolve(seen)
          }
        }

        tick()
      }),
    ms
  )

// The message box of the chat surface home is in (main or a tab).
async function homeBox() {
  const target = await state.page.evaluate(() => document.querySelector('.mg-home')?.closest('[data-chat-surface]')?.getAttribute('data-composer-target') ?? null)

  if (!target) {
    return { box: await composer(), target: null }
  }

  return { box: state.page.locator(`[data-chat-surface][data-composer-target="${target}"] [data-slot="composer-root"] [contenteditable="true"]`).first(), target }
}

const overlaps = (a, b) => Boolean(a && b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b)

async function setWidth(width) {
  const { app, page } = state

  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows()[0]
    const { height } = win.getBounds()

    win.setSize(width, height)
  }, width)
  await sleep(700)

  return page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
}

export async function run() {
  const { page } = state

  // MG_HOME_ONLY=h17 or h18: seed, then that check alone (for probing a fix).
  if (['h17', 'h18', 'h19'].includes(process.env.MG_HOME_ONLY)) {
    results.observations.push(`seed: ${JSON.stringify(seedNow())}`)
    await reload()

    return { h17: runH17, h18: runH18, h19: runH19 }[process.env.MG_HOME_ONLY]()
  }

  await runAll()
  await runH17()
  await runH18()
  await runH19()
}

// ── h19. An empty session at its own route ─────────────────────────────────
// A stored session with no messages, reached at #/<id> (what a launch that
// restores it, or a click on its "Untitled session" row in the sidebar,
// does): home shows in the main chat with the message box centred, as on a
// new draft. Then a session with messages is opened from there: no frame of
// that switch shows home or the box at the middle. MG_HOME_PLANT=h19
// hot-reloads Monograph with the main chat's home kept to the draft route
// (as before); this check must then fail.
const EMPTY_SEED = `
import sys, time
from hermes_state import SessionDB
db = SessionDB()
db.create_session(sys.argv[1], 'desktop', model=None, profile_name='default')
db._execute_write(lambda c: c.execute('UPDATE sessions SET started_at=? WHERE id=?', (time.time() - 30, sys.argv[1])))
print('empty session', sys.argv[1])
`

async function runH19() {
  const { page, sandbox } = state

  await check('h19', async (entry, must) => {
    await setWindow({ width: 1220, zoom: 1 })

    const id = `mg_home_empty_${Date.now() % 100000}`
    const script = path.join(sandbox.root, 'mg-home-empty.py')

    fs.writeFileSync(script, EMPTY_SEED)

    const made = spawnSync(state.python, [script, id], {
      cwd: HERMES_REPO,
      encoding: 'utf8',
      env: { HERMES_HOME: sandbox.hermesHome, HOME: sandbox.root, PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 60_000
    })

    entry.evidence.seeded = String(made.stdout).trim() || String(made.stderr).slice(-300)
    must(made.status === 0, `could not make the empty session: ${entry.evidence.seeded}`)

    // MG_HOME_PLANT=h19: home as it was, the main chat's home on a draft
    // route only. This check must then fail.
    if (process.env.MG_HOME_PLANT === 'h19') {
      entry.evidence.plant = await plantReload([['const id = homeRouteSession()', 'const id = null']])
    }

    // From a session with messages, as a person would come to it.
    await page.evaluate(() => {
      location.hash = '#/mg_home_020'
    })
    await page.waitForSelector('[data-slot="aui_thread-content"] [data-role="user"]', { state: 'visible', timeout: 20_000 }).catch(() => undefined)
    await sleep(800)
    await page.evaluate(id => {
      location.hash = `#/${id}`
    }, id)

    const shown = await page.waitForSelector('.mg-home-body', { state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)

    await sleep(1200)

    const seen = await read()
    const middle = seen.surface ? seen.surface.y + seen.surface.h / 2 : null
    const boxMiddle = seen.composer ? seen.composer.y + seen.composer.h / 2 : null

    entry.evidence.atEmpty = {
      hash: seen.hash,
      home: seen.visible,
      composer: seen.composer,
      surface: seen.surface,
      userMessages: seen.userMessages,
      dock: await page.evaluate(() => document.querySelector('[data-slot="composer-dock"][data-mg-home-dock]') !== null)
    }
    must(seen.hash === `#/${id}`, `the route left the empty session: ${seen.hash}`)
    must(shown && seen.visible, 'no home on a session with no messages at its own route')
    must(entry.evidence.atEmpty.dock, 'the message box is not marked as home\'s (data-mg-home-dock)')
    // Home's layout: the box well above the bottom edge, where a thread's
    // box sits (within 60 px of the surface's bottom).
    must(seen.composer && seen.surface && seen.surface.b - seen.composer.b > 120, `the message box sits at the bottom (box bottom ${seen.composer?.b}, surface bottom ${seen.surface?.b}, middle ${middle}, box middle ${boxMiddle})`)
    await shot(entry, 'h19-empty-session-route')

    // Leave for a session with messages: no home frame on the way.
    await page.evaluate(() => {
      const rec = (window.__mgH19 = { frames: [], on: true })
      const tick = () => {
        rec.frames.push({ hash: location.hash, home: Boolean(document.querySelector('.mg-home')), dock: Boolean(document.querySelector('[data-mg-home-dock]')) })

        if (rec.on) {
          requestAnimationFrame(tick)
        }
      }

      requestAnimationFrame(tick)
      location.hash = '#/mg_home_021'
    })
    await page.waitForSelector('[data-slot="aui_thread-content"] [data-role="user"]', { state: 'visible', timeout: 20_000 }).catch(() => undefined)
    await sleep(800)

    const frames = await page.evaluate(() => {
      window.__mgH19.on = false

      return window.__mgH19.frames
    })
    const bad = frames.filter(frame => frame.hash === '#/mg_home_021' && (frame.home || frame.dock))

    entry.evidence.leaving = { frames: frames.length, homeFramesAtTheOtherSession: bad.length }
    must(frames.length > 5, `only ${frames.length} frames recorded`)
    must(!bad.length, `${bad.length} frame(s) showed home on the session with messages`)
    await shot(entry, 'h19-after-leaving')
  })
}

async function runAll() {
  const { page } = state

  // ── h1. New profile ───────────────────────────────────────────────────────
  await check('h1', async (entry, must) => {
    await waitHome(30_000)
    await page.waitForFunction(() => !document.querySelector('.mg-home-skeleton'), null, { timeout: 20_000 }).catch(() => undefined)
    await sleep(600)

    const seen = await read()

    entry.evidence.home = seen
    must(seen.visible, 'no home on the new profile')
    must(seen.greeting === 'What are we working on today?', `greeting is ${JSON.stringify(seen.greeting)}`)
    must(seen.quick.length === 4, `${seen.quick.length} quick actions`)
    must(!seen.skeleton, 'still loading after 20 s')
    must(/No sessions yet/.test(seen.note ?? ''), `empty note is ${JSON.stringify(seen.note)}`)
    must(seen.recent.length === 0 && seen.pinned.length === 0, 'rows on a profile with no sessions')
    must(seen.dockBeforeDisplay === 'none', `the dock's own greeting still shows (${seen.dockBeforeDisplay})`)
    must(!overlaps(seen.body, seen.composer), 'home overlaps the message box')
    await shot(entry, 'h1-new-profile')

    // A pin whose session does not exist leaves quietly, and is never drawn.
    await patchConfig({ pinned: [{ id: 'mg_home_gone', kind: 'session', label: 'Deleted session', profile: 'default' }] })
    await page.reload()
    await page.waitForSelector('.mg-home-body', { state: 'attached', timeout: 60_000 })

    const ghost = await page.evaluate(
      () =>
        new Promise(resolve => {
          let frames = 0
          const end = performance.now() + 3000
          const tick = () => {
            frames += document.querySelector('.mg-home-section[aria-label="Pinned"]') ? 1 : 0
            performance.now() < end ? requestAnimationFrame(tick) : resolve(frames)
          }

          tick()
        })
    )
    const drawn = await page.evaluate(() => [...document.querySelectorAll('.mg-home-section[aria-label="Pinned"] .mg-home-title')].map(n => n.textContent))

    entry.evidence.ghostPinConfig = (await config()).pinned
    entry.evidence.ghostPinDrawn = drawn
    entry.evidence.ghostPinFrames = ghost
    must(ghost === 0, `the missing pin was drawn for ${ghost} frames`)
    must(Array.isArray(entry.evidence.ghostPinConfig) && entry.evidence.ghostPinConfig.length === 0, 'a pin for a missing session was not dropped')
    must(!drawn.length, 'a pin for a missing session is drawn')
  })

  // ── Seed 500 sessions ────────────────────────────────────────────────────
  const seeded = seedNow()

  results.observations.push(`seed: ${JSON.stringify(seeded)}`)

  // ── h2. Greeting from config ─────────────────────────────────────────────
  await check('h2', async (entry, must) => {
    await patchConfig({ avatar: AVATAR, name: NAME })

    // Long tasks while the 500-session profile loads and home fills.
    await page.addInitScript(() => {
      window.__mgLong = []
      new PerformanceObserver(list => {
        for (const item of list.getEntries()) {
          window.__mgLong.push({ at: Math.round(item.startTime), ms: Math.round(item.duration) })
        }
      }).observe({ type: 'longtask', buffered: true })
    })
    await reload()
    await waitHome(30_000)

    const rowsAt = await page.evaluate(() => performance.now())

    await waitRows().catch(() => undefined)
    await sleep(800)

    const seen = await read()

    entry.evidence.greeting = seen.greeting
    entry.evidence.avatar = seen.avatar
    entry.evidence.hello = seen.hello
    entry.evidence.composer = seen.composer
    entry.evidence.longTasksAfterHome = await page.evaluate(at => (window.__mgLong ?? []).filter(item => item.at >= at), rowsAt)
    must(seen.greeting === `What are we working on today, ${NAME}?`, `greeting is ${JSON.stringify(seen.greeting)}`)
    must(seen.avatar?.loaded, 'the picture did not load')
    must(seen.hello && seen.composer && seen.hello.b <= seen.composer.y + 1, 'the greeting is not above the message box')
    await shot(entry, 'h2-greeting')
  })

  // ── h3. Recent order and a real click ────────────────────────────────────
  await check('h3', async (entry, must) => {
    await waitRows()

    const seen = await read()
    const expected = SEEDED.slice(0, 12).map(s => s.title)

    entry.evidence.recent = seen.recent
    entry.evidence.seed = seeded
    must(seeded.status === 0, `seeding failed: ${seeded.stderr}`)
    must(seen.recent.length === 12, `${seen.recent.length} recent rows, expected 12`)
    must(JSON.stringify(seen.recent.map(r => r.title)) === JSON.stringify(expected), 'recent rows are not in last-active order')
    must(seen.recent[0]?.model.includes('claude-sonnet-4'), `first row model is ${JSON.stringify(seen.recent[0]?.model)}`)
    must(seen.recent[0]?.when === '2m', `first row time is ${JSON.stringify(seen.recent[0]?.when)}`)
    entry.evidence.visibleRecent = seen.visibleRecent
    must(seen.visibleRecent >= 3, `only ${seen.visibleRecent} recent rows can be seen`)
    await shot(entry, 'h3-recent')

    const target = page.locator('.mg-home-section[aria-label="Recent"] .mg-home-row', { hasText: 'Draft the quarterly letter' }).locator('.mg-home-open')
    const watch = sample(4000)

    await click(target)
    await page.waitForFunction(() => location.hash === '#/mg_home_002', null, { timeout: 10_000 })
    await page.waitForFunction(() => document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes('Seeded prompt 2'), null, { timeout: 20_000 })

    const frames = await watch

    entry.evidence.hash = await page.evaluate(() => location.hash)
    entry.evidence.framesWithHome = frames.length
    entry.evidence.framesOverMessages = frames.filter(frame => frame.messages > 0)
    must(entry.evidence.framesOverMessages.length === 0, `home sat over messages in ${entry.evidence.framesOverMessages.length} frames`)
    must(!(await read()).visible, 'home is still showing in the opened session')
    await shot(entry, 'h3-opened')
  })

  // ── h4. Never over a session with messages ───────────────────────────────
  await check('h4', async (entry, must) => {
    const frames = []

    for (const title of ['Plan the launch', 'Trip itinerary']) {
      const row = page.locator('[data-slot="sidebar"] .hover-marquee-inner', { hasText: title }).first()
      const watch = sample(3000)

      await click(row)
      frames.push(...(await watch))
    }

    await reload()
    frames.push(...(await sample(4000)))
    entry.evidence.hash = await page.evaluate(() => location.hash)
    entry.evidence.framesWithHome = frames.length
    entry.evidence.frames = frames.slice(0, 8)
    must(frames.length === 0, `home showed in ${frames.length} frames over a session`)
    must(/^#\/mg_home_/.test(entry.evidence.hash), `ended on ${entry.evidence.hash}, not a session`)
    await shot(entry, 'h4-session')
  })

  // ── h5. Pin and unpin survive a reload ───────────────────────────────────
  await check('h5', async (entry, must) => {
    const title = 'Research notes on solar storage'

    await openHome()
    await waitRows()

    const row = page.locator('.mg-home-section[aria-label="Recent"] .mg-home-row', { hasText: title })

    await row.hover()
    await click(row.locator('.mg-home-pin'))
    await page.waitForSelector('.mg-home-section[aria-label="Pinned"] .mg-home-row', { timeout: 5000 })
    // Hermes writes its pin to the backend a moment later.
    await sleep(1500)

    let seen = await read()

    entry.evidence.afterPin = { pinned: seen.pinned.map(r => r.title), recentFirst: seen.recent.slice(0, 3).map(r => r.title) }
    entry.evidence.config = (await config()).pinned
    must(seen.pinned.some(r => r.title === title), 'not in Pinned after the click')
    must(!seen.recent.some(r => r.title === title), 'still listed under Recent too')
    await shot(entry, 'h5-pinned')

    await reload()
    await waitHome(30_000)
    await waitRows()
    await sleep(800)
    seen = await read()

    const sidebarPinned = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="sidebar"] [data-session-pin-drop] .hover-marquee-inner')].map(node => node.textContent)
    )

    entry.evidence.afterReload = seen.pinned.map(r => r.title)
    entry.evidence.sidebarPinned = sidebarPinned
    must(seen.pinned.some(r => r.title === title), 'pin lost on reload')
    must(sidebarPinned.includes(title), 'not in the sidebar Pinned section')
    await shot(entry, 'h5-pinned-reload')

    const pinnedRow = page.locator('.mg-home-section[aria-label="Pinned"] .mg-home-row', { hasText: title })

    if (process.env.MG_HOME_SIDEBAR_UNPIN) {
      const target = page.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]', { hasText: title }).first()
      const b = await target.boundingBox()

      await page.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' })
      await page.locator('[role="menuitem"]', { hasText: /^Unpin$/ }).first().click()
      entry.evidence.unpinVia = 'sidebar (MG_HOME_SIDEBAR_UNPIN)'
    } else {
      await pinnedRow.hover()
      await click(pinnedRow.locator('.mg-home-pin'))
    }

    await page.waitForFunction(() => !document.querySelector('[data-slot="sidebar"] [data-session-pin-drop] [data-slot="context-menu-trigger"]'), null, { timeout: 5000 })
    await sleep(3000)
    entry.evidence.sidebarPinnedBeforeReload = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="sidebar"] [data-session-pin-drop] .hover-marquee-inner')].map(node => node.textContent)
    )
    await reload()
    await waitHome(30_000)
    await waitRows()
    await sleep(800)
    seen = await read()
    entry.evidence.afterUnpinReload = { config: (await config()).pinned, pinned: seen.pinned.map(r => r.title), recent: seen.recent.slice(0, 3).map(r => r.title) }
    // The sidebar after the reload, over ten seconds: Hermes reads its pins
    // back from the backend.
    const timeline = []

    for (let i = 0; i < 10; i++) {
      timeline.push(
        await page.evaluate(key => ({
          config: (JSON.parse(localStorage.getItem(key) || '{}').pinned ?? []).map(pin => pin.id).join(','),
          hermes: localStorage.getItem('hermes.desktop.pinnedSessions'),
          sidebar: [...document.querySelectorAll('[data-slot="sidebar"] [data-session-pin-drop] .hover-marquee-inner')].map(node => node.textContent).join(',')
        }), CONFIG_KEY)
      )
      await sleep(1000)
    }

    entry.evidence.afterUnpinTimeline = timeline
    entry.evidence.sidebarPinnedAfterUnpin = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="sidebar"] [data-session-pin-drop] .hover-marquee-inner')].map(node => node.textContent)
    )
    seen = await read()
    entry.evidence.homePinnedAfterUnpin = seen.pinned.map(r => r.title)
    must(!seen.pinned.length, 'pinned again on home after the reload')
    must(seen.pinned.length === 0, 'still pinned after unpin and reload')
    must(seen.recent[1]?.title === title, 'not back in its place under Recent')
    must(!entry.evidence.sidebarPinnedBeforeReload.includes(title), 'still in the sidebar Pinned section after the unpin')

    // Hermes' own sidebar, after the reload, is not this check's verdict: in
    // this run's state its pin comes back after a reload whichever control
    // unpinned it (reproduced with the sidebar's own Unpin item by running
    // with MG_HOME_SIDEBAR_UNPIN=1). Kept as an observation.
    if (entry.evidence.sidebarPinnedAfterUnpin.includes(title)) {
      results.observations.push(
        `h5: Hermes' sidebar shows "${title}" pinned again after a reload that followed its unpin (localStorage hermes.desktop.pinnedSessions = ${timeline.at(-1)?.hermes}); home does not`
      )
    }

    // A pin whose session is gone, on a profile with more sessions than the
    // app lists at once (500): nothing can prove it gone, so it stays. Kept
    // as evidence, not judged; h1 checks the drop on a small profile.
    await patchConfig({ pinned: [{ id: 'mg_home_gone', kind: 'session', label: 'Deleted session', profile: 'default' }] })
    await reload()
    await waitHome(30_000)

    const shownAt = await page.evaluate(() => performance.now())

    await waitRows()
    await sleep(2500)
    seen = await read()
    entry.evidence.ghostPinOnBigProfile = { config: (await config()).pinned, rows: seen.pinned.map(r => r.title) }
    entry.evidence.longTasksAfterHomeShowed = await page.evaluate(at => (window.__mgLong ?? []).filter(item => item.at >= at), shownAt)
    await patchConfig({ pinned: [] })
  })

  // ── h6. Quick action ─────────────────────────────────────────────────────
  await check('h6', async (entry, must) => {
    const before = prompts()
    const { box, target } = await homeBox()

    entry.evidence.surface = target
    await click(page.locator('.mg-home-action', { hasText: 'Plan the day' }))
    await sleep(1500)

    const seen = await read()

    entry.evidence.text = (await box.innerText()).trim()
    entry.evidence.focusInBox = await page.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="composer-root"]')))
    entry.evidence.prompts = { after: prompts(), before }
    entry.evidence.homeVisible = seen.visible
    entry.evidence.userMessages = seen.userMessages
    entry.evidence.visibleRecent = seen.visibleRecent
    entry.evidence.boxes = { body: seen.body, composer: seen.composer, surface: seen.surface }
    must(seen.visibleRecent >= 3, `only ${seen.visibleRecent} recent rows can be seen in this tab`)
    must(entry.evidence.text.startsWith('Help me plan my day.'), `the box holds ${JSON.stringify(entry.evidence.text)}`)
    must(entry.evidence.prompts.after === before, 'a prompt reached the model')
    must(seen.userMessages === 0, 'a message was sent')
    must(seen.visible, 'home left without a send')
    await shot(entry, 'h6-filled')
  })

  // ── h7. Leaves on send ───────────────────────────────────────────────────
  await check('h7', async (entry, must) => {
    const { box, target } = await homeBox()

    entry.evidence.surface = target

    await box.click()
    await page.keyboard.press('End')
    await page.keyboard.insertText('MG_HOME_SEND')

    // From the keypress on: when home left, and frames that showed it with
    // the prompt already in the thread.
    const watch = page.evaluate(
      () =>
        new Promise(resolve => {
          const out = { firstGone: null, homeWithPrompt: 0 }
          const start = performance.now()
          const tick = () => {
            const users = document.querySelectorAll('[data-slot="aui_thread-content"] [data-role="user"]').length
            const home = Boolean(document.querySelector('.mg-home'))

            if (!home && out.firstGone === null) {
              out.firstGone = Math.round(performance.now() - start)
            }

            if (home && users > 0) {
              out.homeWithPrompt++
            }

            if (performance.now() - start < 6000) {
              requestAnimationFrame(tick)
            } else {
              resolve(out)
            }
          }

          tick()
        })
    )

    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].some(node => node.textContent.includes('MG_HOME_REPLY')) &&
        !document.querySelector('[data-slot="aui_turn-activity"], [data-slot="aui_response-loading"]'),
      null,
      { timeout: 30_000 }
    )

    const seenSend = await watch

    entry.evidence.watch = seenSend
    await sleep(1500)

    const after = await read()

    entry.evidence.hash = after.hash
    entry.evidence.visibleAfterReply = after.visible
    must(seenSend.firstGone !== null && seenSend.firstGone < 300, `home took ${seenSend.firstGone} ms to leave`)
    must(seenSend.homeWithPrompt === 0, `home showed in ${seenSend.homeWithPrompt} frames with the prompt in the thread`)
    must(!after.visible, 'home came back after the reply')
    await shot(entry, 'h7-after-send')
    await reload()
    await sleep(3000)
    entry.evidence.visibleAfterReload = (await read()).visible
    entry.evidence.hashAfterReload = await page.evaluate(() => location.hash)
    must(!entry.evidence.visibleAfterReload, 'home came back after a reload of the session')
  })

  // ── h8. Keyboard ─────────────────────────────────────────────────────────
  await check('h8', async (entry, must) => {
    await openHome()
    await waitRows()

    const { box } = await homeBox()

    await box.click()

    const wanted = await page.evaluate(() => document.querySelectorAll('.mg-home-body button').length)
    const reached = new Map()

    for (let i = 0; i < 80 && reached.size < wanted; i++) {
      await page.keyboard.press('Tab')

      const info = await page.evaluate(() => {
        const node = document.activeElement

        if (!node?.closest?.('.mg-home-body')) {
          return null
        }

        const style = getComputedStyle(node)
        const all = [...document.querySelectorAll('.mg-home-body button')]

        return {
          index: all.indexOf(node),
          label: node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 40),
          ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
        }
      })

      if (info) {
        reached.set(info.index, info)
      }
    }

    entry.evidence.buttons = wanted
    entry.evidence.reached = reached.size
    entry.evidence.withoutRing = [...reached.values()].filter(item => !item.ring).map(item => item.label)
    must(reached.size === wanted, `Tab reached ${reached.size} of ${wanted} home buttons`)
    must(entry.evidence.withoutRing.length === 0, 'focus without a visible ring')

    // Enter on the first recent row opens it.
    const first = page.locator('.mg-home-section[aria-label="Recent"] .mg-home-row').first()
    const id = await first.getAttribute('data-mg-session')

    await first.locator('.mg-home-open').focus()
    await shot(entry, 'h8-focus')
    await page.keyboard.press('Enter')
    await page.waitForFunction(id => location.hash === `#/${id}`, id, { timeout: 10_000 }).catch(() => undefined)
    entry.evidence.enterOpened = await page.evaluate(() => location.hash)
    must(entry.evidence.enterOpened === `#/${id}`, `Enter did not open ${id}`)
  })

  // ── h9. Narrow and wide ──────────────────────────────────────────────────
  await check('h9', async (entry, must) => {
    for (const width of [900, 1800]) {
      const viewport = await setWidth(width)

      await openHome()
      await waitRows()
      // After the arrival has played out.
      await sleep(1500)

      const seen = await read()
      const layout = await page.evaluate(() => {
        const rects = [...document.querySelectorAll('.mg-home-body .mg-home-row, .mg-home-body .mg-home-label, .mg-home-action')].map(node => {
          const r = node.getBoundingClientRect()

          return { b: r.bottom, name: `${node.className} "${node.textContent.slice(0, 20)}"`, r: r.right, x: r.x, y: r.y }
        })
        const body = document.querySelector('.mg-home-body').getBoundingClientRect()
        const clashes = []

        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i]
            const b = rects[j]

            if (a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5) {
              clashes.push(`${a.name} [${Math.round(a.x)},${Math.round(a.y)},${Math.round(a.r)},${Math.round(a.b)}] x ${b.name} [${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.r)},${Math.round(b.b)}]`)
            }
          }
        }

        return {
          clash: clashes.length,
          clashes,
          outside: [...document.querySelectorAll('.mg-home-row, .mg-home-action')].filter(node => {
            const r = node.getBoundingClientRect()

            return r.right > body.right + 1 || r.x < body.x - 1
          }).length,
          overflowing: [...document.querySelectorAll('.mg-home-open')].filter(node => node.scrollWidth > node.clientWidth + 1).length
        }
      })

      entry.evidence[`w${width}`] = { ...layout, body: seen.body, composer: seen.composer, hello: seen.hello, surface: seen.surface, viewport, visibleRecent: seen.visibleRecent }
      must(seen.visibleRecent >= 3, `${width}: only ${seen.visibleRecent} recent rows can be seen`)
      must(layout.clash === 0, `${width}: ${layout.clash} overlapping pairs`)
      must(layout.outside === 0, `${width}: ${layout.outside} items stick out of home`)
      must(layout.overflowing === 0, `${width}: ${layout.overflowing} rows overflow`)
      must(!overlaps(seen.body, seen.composer) && !overlaps(seen.hello, seen.composer), `${width}: home overlaps the message box`)
      must(
        seen.body && seen.surface && seen.body.r <= seen.surface.r && seen.body.x >= seen.surface.x && seen.body.b <= seen.surface.b + 1,
        `${width}: home leaves the chat area`
      )
      await shot(entry, `h9-${width}`)
    }

    // Narrow and zoomed: the greeting, the box and home's lists never
    // overlap, and home stays in the chat (800 px wide, 125 percent zoom).
    for (const [width, zoom] of [[800, 1], [1220, 1.25], [800, 1.25]]) {
      const viewport = await setWindow({ width, zoom })

      await openHome()
      await sleep(1500)

      const seen = await read()
      const name = `w${width}z${zoom}`
      const greetingBox = await page.evaluate(() => {
        const node = document.querySelector('.mg-home-greeting')
        const r = node?.getBoundingClientRect()

        return r ? { b: Math.round(r.bottom), r: Math.round(r.right), x: Math.round(r.x), y: Math.round(r.y) } : null
      })

      entry.evidence[name] = { viewport, hello: seen.hello, greeting: greetingBox, composer: seen.composer, body: seen.body, surface: seen.surface, visibleRecent: seen.visibleRecent }
      must(seen.visible, `${name}: home did not show`)
      must(greetingBox && seen.composer && !overlaps(greetingBox, seen.composer) && !overlaps(seen.hello, seen.composer), `${name}: the greeting overlaps the message box`)
      must(!overlaps(seen.body, seen.composer), `${name}: home's lists overlap the message box`)
      must(seen.hello && seen.surface && seen.hello.y >= seen.surface.y && seen.hello.x >= seen.surface.x - 1, `${name}: the greeting leaves the chat area`)
      await shot(entry, `h9-${name}`)
    }

    entry.evidence.restoredZoom = await setWindow({ width: 1220, zoom: 1 })
    entry.evidence.restored = await setWidth(1220)
  })

  // ── h14. One left edge ───────────────────────────────────────────────────
  // The message box draws its frame on [data-slot="composer-surface"]; the
  // greeting (or the picture before it), the first quick action, every label
  // and every row's title start on that frame's left edge. Text is measured
  // where its first glyph box starts, not where its element starts.
  await check('h14', async (entry, must) => {
    const edges = () =>
      page.evaluate(() => {
        const home = document.querySelector('.mg-home')
        const surface = home?.closest('[data-chat-surface]')
        const frame = surface?.querySelector('[data-slot="composer-surface"]')
        const textX = node => {
          if (!node) {
            return null
          }

          const range = document.createRange()

          range.selectNodeContents(node)

          const first = [...range.getClientRects()].find(r => r.width > 0)

          return first ? +first.x.toFixed(2) : +node.getBoundingClientRect().x.toFixed(2)
        }
        const firstHello = document.querySelector('.mg-home-hello')?.firstElementChild
        const items = []

        if (firstHello) {
          items.push(['hello', firstHello.classList.contains('mg-home-greeting') ? textX(firstHello) : +firstHello.getBoundingClientRect().x.toFixed(2)])
        }

        const chip = document.querySelector('.mg-home-action')

        if (chip) {
          items.push(['chip', +chip.getBoundingClientRect().x.toFixed(2)])
        }

        for (const label of document.querySelectorAll('.mg-home-label')) {
          items.push([`label ${label.textContent.trim()}`, textX(label)])
        }

        // Rows inside home's scroll box only (a row scrolled out of view is
        // still at the same x, but keep the list short).
        for (const title of [...document.querySelectorAll('.mg-home-row .mg-home-title')].slice(0, 6)) {
          items.push([`row ${title.textContent.slice(0, 18)}`, textX(title)])
        }

        return { frame: frame ? +frame.getBoundingClientRect().x.toFixed(2) : null, items }
      })

    for (const [width, zoom] of [[1220, 1], [1600, 1], [800, 1], [1220, 1.25], [1600, 1.25], [800, 1.25]]) {
      const name = `w${width}z${zoom}`

      await setWindow({ width, zoom })
      await openHome()
      await waitRows().catch(() => undefined)
      await sleep(1200)

      const seen = await edges()
      const off = seen.items.filter(([, x]) => x === null || Math.abs(x - seen.frame) > 1)

      entry.evidence[name] = { frame: seen.frame, items: Object.fromEntries(seen.items), off: off.map(([what, x]) => `${what} ${x === null ? 'missing' : (x - seen.frame).toFixed(1)}`) }
      must(seen.frame !== null, `${name}: no message box frame`)
      must(seen.items.length >= 4, `${name}: only ${seen.items.length} things measured`)
      must(!off.length, `${name}: off the box's left edge (${seen.frame}): ${off.map(([what, x]) => `${what} by ${x === null ? '?' : (x - seen.frame).toFixed(1)} px`).join(', ')}`)
      await shot(entry, `h14-${name}`)
    }

    await setWindow({ width: 1220, zoom: 1 })
    await setWidth(1220)
  })

  // ── h10. Sidebar sections ────────────────────────────────────────────────
  await check('h10', async (entry, must) => {
    await openHome()
    await waitRows()
    await sleep(1000)

    // Start from nothing pinned.
    for (let i = 0; i < 6 && (await page.locator('.mg-home-section[aria-label="Pinned"] .mg-home-row').count()); i++) {
      const first = page.locator('.mg-home-section[aria-label="Pinned"] .mg-home-row').first()

      await first.hover()
      await click(first.locator('.mg-home-pin'))
      await sleep(600)
    }

    await sleep(2000)

    const pinnedShown = () => page.evaluate(() => Boolean(document.querySelector('[data-slot="sidebar"] [data-session-pin-drop]')?.checkVisibility()))

    entry.evidence.pinnedSectionWhenEmpty = (await pinnedShown()) ? 'shown' : 'hidden'
    must(entry.evidence.pinnedSectionWhenEmpty === 'hidden', 'the sidebar shows an empty Pinned section')

    const row = page.locator('.mg-home-section[aria-label="Recent"] .mg-home-row').nth(2)

    await row.hover()
    await click(row.locator('.mg-home-pin'))
    await sleep(800)

    const layout = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-slot="sidebar"]')
      const tools = sidebar.querySelector('[data-slot="sidebar-content"] > [data-slot="sidebar-group"]:has([data-tour^="sidebar-nav-"])')
      const pinned = sidebar.querySelector('[data-session-pin-drop]')
      const history = sidebar.querySelector('[data-session-unpin-drop]')
      const top = node => (node && node.checkVisibility() ? Math.round(node.getBoundingClientRect().top) : null)

      return {
        historyTop: top(history),
        pinnedRows: pinned ? [...pinned.querySelectorAll('.hover-marquee-inner')].map(n => n.textContent) : [],
        pinnedTop: top(pinned),
        toolRows: tools ? [...tools.querySelectorAll('li')].filter(li => li.checkVisibility()).map(li => li.textContent.trim()) : [],
        toolsTop: top(tools),
        upgrade: /upgrade/i.test(sidebar.textContent)
      }
    })

    entry.evidence.layout = layout
    must(layout.toolsTop === null && layout.toolRows.length === 0, `Hermes' nav group is shown in the sidebar (${layout.toolRows.join(', ')})`)
    must(layout.pinnedTop !== null && layout.pinnedRows.length > 0, 'no pinned section')
    must(layout.historyTop !== null, 'no history section')
    must(layout.pinnedTop < layout.historyTop, 'the pinned section is not above the history')
    must(!layout.upgrade, 'an upgrade card is in the sidebar')
    await shot(entry, 'h10-sidebar')

    // Leave no pin behind for the next checks.
    const pinnedRow = page.locator('.mg-home-section[aria-label="Pinned"] .mg-home-row').first()

    await pinnedRow.hover()
    await click(pinnedRow.locator('.mg-home-pin'))
    await sleep(1500)

    // Pinned from the sidebar (Hermes' own menu): home follows, both ways.
    const menuPick = async (title, item) => {
      const target = page.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]', { hasText: title }).first()
      const b = await target.boundingBox()

      await page.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' })
      await page.locator('[role="menuitem"]', { hasText: new RegExp(`^${item}$`) }).first().click()
      await sleep(1500)
    }

    const homePinned = async () => {
      await click(page.locator('[data-slot="sidebar"] .hover-marquee-inner', { hasText: 'Reading list' }).first())
      await page.waitForFunction(() => location.hash === '#/mg_home_007', null, { timeout: 10_000 })
      await sleep(800)
      await openHome()
      await waitRows()
      await sleep(1200)

      const seen = await read()

      must(seen.visibleRecent >= 3, `only ${seen.visibleRecent} recent rows can be seen`)

      return seen.pinned.map(r => r.title)
    }

    await menuPick('Kitchen budget', 'Pin')
    entry.evidence.homeAfterSidebarPin = await homePinned()
    must(entry.evidence.homeAfterSidebarPin.includes('Kitchen budget'), 'a pin made in the sidebar does not show on home')
    await shot(entry, 'h10-sidebar-pin')
    await menuPick('Kitchen budget', 'Unpin')
    entry.evidence.homeAfterSidebarUnpin = await homePinned()
    must(!entry.evidence.homeAfterSidebarUnpin.includes('Kitchen budget'), 'an unpin made in the sidebar stays on home')
  })

  // ── h11. Motion ──────────────────────────────────────────────────────────
  await check('h11', async (entry, must) => {
    const animations = () =>
      page.evaluate(() =>
        document
          .getAnimations()
          .filter(a => a.effect?.target?.closest?.('.mg-home-body, .mg-home-hello'))
          // Motion off means what it means everywhere (05-motion.css): an
          // animation of 1 ms or less is no motion.
          .filter(a => a.effect.getComputedTiming().duration > 1)
          .map(a => ({ delay: a.effect.getTiming().delay, name: a.animationName, state: a.playState }))
      )

    // Leave, come back: a fresh arrival.
    await click(page.locator('[data-slot="sidebar"] .hover-marquee-inner', { hasText: 'Trip itinerary' }).first())
    await sleep(1500)
    await openHome()

    const on = await animations()

    entry.evidence.onCount = on.length
    entry.evidence.onDelays = [...new Set(on.map(a => a.delay))].slice(0, 12)
    must(on.length > 0, 'nothing animates with motion on')
    must(new Set(on.map(a => a.delay)).size > 2, 'no stagger')
    await sleep(1500)
    entry.evidence.runningAfter = (await animations()).filter(a => a.state === 'running').map(a => a.name)
    must(entry.evidence.runningAfter.length === 0, 'animations still running 1.5 s after arrival')

    // The entrance belongs to the empty session, not to the composer's
    // mount: closing Settings, resizing the window, a setting changing and a
    // plugin hot reload must not start it again.
    const listen = () =>
      page.evaluate(() => {
        window.__mgHomeStarts = []
        window.__mgHomeListen ??= event => {
          if (event.target?.closest?.('.mg-home')) window.__mgHomeStarts.push(`${event.animationName} on ${event.target.className}`)
        }
        document.addEventListener('animationstart', window.__mgHomeListen, true)
      })
    const heard = () =>
      page.evaluate(() => {
        document.removeEventListener('animationstart', window.__mgHomeListen, true)
        return window.__mgHomeStarts.splice(0)
      })
    const replays = {}

    await listen()
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('[data-overlay-surface]', { timeout: 10_000 }).catch(() => undefined)
    await sleep(600)
    await page.keyboard.press('Escape')
    await waitHome().catch(() => undefined)
    await sleep(700)
    replays.settingsClose = await heard()
    await listen()
    const width = await page.evaluate(() => window.outerWidth)
    await setWidth(900)
    await setWidth(width)
    await sleep(500)
    replays.resize = await heard()
    await listen()
    await page.evaluate(() => {
      const root = document.documentElement
      root.dataset.mgDensity = root.dataset.mgDensity === 'compact' ? 'comfortable' : 'compact'
    })
    await sleep(200)
    await page.evaluate(() => {
      const root = document.documentElement
      root.dataset.mgDensity = root.dataset.mgDensity === 'compact' ? 'comfortable' : 'compact'
    })
    await sleep(400)
    replays.rootAttribute = await heard()
    await listen()
    await hotReload()
    await waitHome().catch(() => undefined)
    await sleep(900)
    replays.hotReload = await heard()
    entry.evidence.replays = replays
    for (const [when, list] of Object.entries(replays)) {
      must(!list.length, `home's entrance replayed on ${when}: ${list.slice(0, 3).join('; ')}`)
    }

    await patchConfig({ motion: 'off' })
    await reload()
    await page.waitForSelector('.mg-home-hello', { timeout: 30_000 })

    const off = await animations()

    entry.evidence.offCount = off.length
    entry.evidence.off = off.slice(0, 5)
    must(off.length === 0, `${off.length} animations with motion off`)
    await patchConfig({ motion: null })
  })

  // ── h12. Surfaces menu row ───────────────────────────────────────────────
  await check('h12', async (entry, must) => {
    await reload()
    await click(page.locator('[data-slot="sidebar"] .hover-marquee-inner', { hasText: 'Kitchen budget' }).first())
    await page.waitForFunction(() => /^#\/mg_home_/.test(location.hash), null, { timeout: 10_000 })
    await sleep(1000)
    await click(page.locator('[data-tour="mg-surfaces"] .mg-surfaces-hit').first())

    const opened = await page.waitForSelector('.mg-surfaces-menu', { state: 'visible', timeout: 2000 }).then(() => true, () => false)

    if (!opened) {
      // Advanced mode: Hermes' "Swap sidebar sides" sits on the button and
      // takes the click (core check b, a known open issue). Open the menu
      // with the keyboard instead, so the Home row itself is still tested.
      entry.evidence.openedWith = 'keyboard (the click did not reach the surfaces button)'
      await page.locator('[data-tour="mg-surfaces"]').first().focus()
      await page.keyboard.press('Enter')
      await page.waitForSelector('.mg-surfaces-menu', { state: 'visible', timeout: 3000 })
    } else {
      entry.evidence.openedWith = 'click'
    }

    // Rows are found by their label. Monograph's own rows (those above the
    // rule) are meant to read Home, Knowledge, Agent: the places first, then
    // the panel; Home is the first place the owner thinks of.
    const rows = await page.evaluate(() => [...document.querySelectorAll('.mg-surfaces-menu .mg-surface-row')].map(n => n.querySelector('span')?.textContent.trim() ?? n.textContent.trim()))
    const ours = await page.evaluate(() => {
      const out = []

      for (const node of document.querySelector('.mg-surfaces-menu')?.children ?? []) {
        if (node.matches('[role="separator"], [data-slot="dropdown-menu-separator"]')) break
        if (node.matches('.mg-surface-row')) out.push(node.querySelector('span')?.textContent.trim() ?? '')
      }

      return out
    })

    entry.evidence.rows = rows
    entry.evidence.ours = ours
    must(rows.filter(label => label === 'Home').length === 1, `Home rows: ${rows.filter(label => label === 'Home').length} (want 1)`)
    const order = ['Home', 'Knowledge', 'Agent'].filter(label => ours.includes(label))
    must(ours.indexOf('Home') === 0, `Home is not the first of Monograph's rows: ${JSON.stringify(ours)}`)
    must(JSON.stringify(ours.filter(label => order.includes(label))) === JSON.stringify(order), `Monograph's rows read ${JSON.stringify(ours)}, want ${JSON.stringify(order)}`)
    await shot(entry, 'h12-menu')
    await click(page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: 'Home' }).first())
    await waitHome(10_000).catch(() => undefined)

    const seen = await read()

    entry.evidence.hash = seen.hash
    entry.evidence.visible = seen.visible
    must(seen.visible, 'home did not show after the Home row')
    must(seen.hash === '#/' || seen.hash === '', `route is ${seen.hash}`)
    await shot(entry, 'h12-home')
  })

  // ── h13. Hot reload twice, then unloaded: stop() leaves nothing ──
  // Our footprint is everything that carries an mg- class or a data-mg-
  // attribute, the root's data-mg-* keys and the stylesheet. Two reloads
  // change none of it; unloading (a stand-in plugin with Monograph's id)
  // leaves none of it.
  await check('h13', async (entry, must) => {
    const page = state.page
    await openHome()
    await sleep(1200)

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
    const extra = '.mg-home-hello, .mg-home-action, [data-mg-home-slot]'
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
    await shot(entry, 'h13-loaded-again')
    must(before.ours > 0 && before.styles === 1, `before: ${JSON.stringify(before)}`)
    must(after.styles === 1 && after.root === before.root && after.extra === before.extra, `after two reloads: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    must(JSON.stringify(after.kinds) === JSON.stringify(before.kinds) && Math.abs(after.ours - before.ours) <= 2, `after two reloads our nodes changed: ${after.ours} vs ${before.ours}; ${after.kinds.filter(kind => !before.kinds.includes(kind)).join(', ')}`)
    must(unloaded.ours === 0 && !unloaded.root && unloaded.styles === 0 && unloaded.extra === 0, `left behind after unloading: ${JSON.stringify(unloaded)}`)
    must(back.styles === 1 && back.root === before.root, `after loading again: ${JSON.stringify(back)}`)
  })


  // ── h15. Arrows; pins and deletes made in Hermes' sidebar ────────────────
  await check('h15', async (entry, must) => {
    await setWindow({ width: 1220, zoom: 1 })
    await openHome()
    await waitRows()
    await sleep(800)

    const focused = () =>
      page.evaluate(() => {
        const node = document.activeElement
        const rows = [...document.querySelectorAll('.mg-home-open')]
        const chips = [...document.querySelectorAll('.mg-home-action')]
        const style = node ? getComputedStyle(node) : null

        return {
          chip: chips.indexOf(node),
          ring: Boolean(style && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0),
          row: rows.indexOf(node),
          rows: rows.length
        }
      })

    await page.locator('.mg-home-open').first().focus()

    const steps = {}

    for (const [key, want] of [['ArrowDown', { row: 1 }], ['ArrowDown', { row: 2 }], ['End', { row: 'last' }], ['Home', { row: 0 }], ['ArrowUp', { chip: 0 }], ['ArrowRight', { chip: 1 }], ['ArrowDown', { row: 0 }]]) {
      await page.keyboard.press(key)
      await sleep(80)

      const now = await focused()
      const ok = want.row === 'last' ? now.row === now.rows - 1 : want.row !== undefined ? now.row === want.row : now.chip === want.chip

      steps[`${Object.keys(steps).length + 1} ${key}`] = `${now.row >= 0 ? `row ${now.row}` : `chip ${now.chip}`}${now.ring ? ' ring' : ' NO RING'}`
      must(ok && now.ring, `${key}: focus on ${JSON.stringify(now)}, wanted ${JSON.stringify(want)} with a visible ring`)
    }

    entry.evidence.arrows = steps
    await shot(entry, 'h15-arrow-focus')

    // Pin and unpin in Hermes' own sidebar: right click, its own menu item.
    const sidebarMenu = async (title, item) => {
      const target = page.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]', { hasText: title }).first()

      await target.scrollIntoViewIfNeeded()

      const b = await target.boundingBox()

      await page.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' })
      await page.locator('[role="menuitem"]', { hasText: item }).first().click()
    }
    const homeHas = async (section, title) => (await read())[section === 'Pinned' ? 'pinned' : 'recent'].some(row => row.title === title)
    const until = async (test, ms = 10_000) => {
      const end = Date.now() + ms

      while (Date.now() < end) {
        if (await test()) {
          return true
        }

        await sleep(400)
      }

      return false
    }

    // Home again, as a person gets it: from a session, a new one.
    const arriveAgain = async () => {
      await page.evaluate(() => {
        location.hash = '#/mg_home_010'
      })
      await sleep(1000)
      await openHome()
      await waitRows().catch(() => undefined)
    }

    const pinTitle = 'Trip itinerary'
    const goneTitle = 'Kitchen budget'

    await sidebarMenu(pinTitle, /^Pin/)
    await sleep(600)
    await arriveAgain()
    entry.evidence.sidebarPinShows = await until(async () => homeHas('Pinned', pinTitle))
    must(entry.evidence.sidebarPinShows, `pinned in Hermes' sidebar, "${pinTitle}" is not under Pinned on home`)
    await sidebarMenu(pinTitle, /^Unpin/)
    await sleep(600)
    await arriveAgain()
    entry.evidence.sidebarUnpinLeaves = await until(async () => !(await homeHas('Pinned', pinTitle)))
    must(entry.evidence.sidebarUnpinLeaves, `unpinned in Hermes' sidebar, "${pinTitle}" stays under Pinned on home`)

    // Delete in the sidebar, beside home.
    must(await homeHas('Recent', goneTitle), `"${goneTitle}" is not under Recent to begin with`)
    await sidebarMenu(goneTitle, /^Delete/)

    const confirm = page.locator('[role="alertdialog"] button, [role="dialog"] button', { hasText: /^Delete$/ }).first()

    await confirm.waitFor({ state: 'visible', timeout: 5000 })
    await confirm.click()
    await sleep(3000)
    entry.evidence.deletedStillShownBesideHome = await homeHas('Recent', goneTitle)
    await arriveAgain()
    entry.evidence.deletedLeaves = await until(async () => !(await homeHas('Recent', goneTitle)))
    must(entry.evidence.deletedLeaves, `deleted in Hermes' sidebar, "${goneTitle}" is still under Recent on home`)
    await shot(entry, 'h15-after-delete')
  })


  // ── h16. Changes made elsewhere while home is on screen ─────────────────
  // No new arrival: home stays where it is and must follow, within a second,
  // what the sidebar beside it and a second window do. Timed from the click
  // that makes the change to the frame home shows it.
  await check('h16', async (entry, must) => {
    await setWindow({ width: 1220, zoom: 1 })
    await openHome()
    await waitRows()
    await sleep(800)

    const sidebarMenu = async (title, item) => {
      const target = page.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]', { hasText: title }).first()

      await target.scrollIntoViewIfNeeded()

      const b = await target.boundingBox()

      await page.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' })
      await page.locator('[role="menuitem"]', { hasText: item }).first().click()
    }
    // Polled in the page every frame, so the time is the frame it showed.
    const timeUntil = (section, title, present, limit = 5000) =>
      page.evaluate(
        ({ limit, present, section, title }) =>
          new Promise(resolve => {
            const started = performance.now()
            const look = () => {
              const label = [...document.querySelectorAll('.mg-home-label')].find(node => node.textContent.trim() === section)
              const list = label?.closest('section, .mg-home-section, div')
              const has = [...(list?.querySelectorAll('.mg-home-title') ?? [])].some(node => node.textContent.trim() === title)

              if (has === present) {
                resolve(Math.round(performance.now() - started))
              } else if (performance.now() - started > limit) {
                resolve(null)
              } else {
                requestAnimationFrame(look)
              }
            }

            look()
          }),
        { limit, present, section, title }
      )
    const times = (entry.evidence.ms = {})
    const LIMIT = 1000

    const pinTitle = 'Reading list'
    const goneTitle = 'Review the contract'

    must((await timeUntil('Recent', goneTitle, true, 100)) !== null, `"${goneTitle}" is not under Recent to begin with`)

    await sidebarMenu(pinTitle, /^Pin/)
    times.pin = await timeUntil('Pinned', pinTitle, true)
    await sidebarMenu(pinTitle, /^Unpin/)
    times.unpin = await timeUntil('Pinned', pinTitle, false)

    await sidebarMenu(goneTitle, /^Delete/)

    const confirm = page.locator('[role="alertdialog"] button, [role="dialog"] button', { hasText: /^Delete$/ }).first()

    await confirm.waitFor({ state: 'visible', timeout: 5000 })
    await confirm.click()
    times.delete = await timeUntil('Recent', goneTitle, false)
    await shot(entry, 'h16-after-sidebar-changes')

    // A second window of the same app (Hermes' own door), deleting there.
    // Its only signal here is the gateway's sessions.changed, which Hermes'
    // change watcher sends at most once per 2 s (change_watcher.py
    // _CHANGE_BROADCAST_FLOOR_S): a change within 2 s of the last one waits
    // out that floor, in bare Hermes' own sidebar too. So this one comes
    // 2.5 s after the deletes above, as a separate change would.
    await sleep(2500)
    const opened = state.app.waitForEvent('window', { timeout: 20_000 }).catch(() => null)

    await page.evaluate(() => window.hermesDesktop?.openWindow?.())

    const second = await opened

    entry.evidence.secondWindow = Boolean(second)

    if (second) {
      // A row the second window draws. It loads only the newest page of the
      // list (store/layout.ts SIDEBAR_SESSIONS_PAGE_SIZE), and in Advanced
      // every arrival at home through the sidebar's "+" opens a new tab, a
      // listed "Untitled session": by h16 about twenty of them had pushed a
      // fixed older title ("Seeded session 011") off that page, so the
      // window had no row of it at all. The target is the newest titled row
      // that both the second window's sidebar and home's Recent show, leaving
      // out the titles h18 still opens.
      let otherTitle = 'Draft the quarterly letter'

      try {
        await second.waitForSelector('[data-slot="sidebar"] [data-slot="context-menu-trigger"]', { timeout: 60_000 })
        await sleep(1500)

        const homeTitles = await page.evaluate(() => {
          const label = [...document.querySelectorAll('.mg-home-label')].find(node => node.textContent.trim() === 'Recent')
          const list = label?.closest('section, .mg-home-section, div')

          return [...(list?.querySelectorAll('.mg-home-title') ?? [])].map(node => node.textContent.trim())
        })
        const drawn = await second.evaluate(() => [...document.querySelectorAll('[data-slot="sidebar"] [data-slot="context-menu-trigger"]')].filter(node => node.checkVisibility()).map(node => node.textContent.trim()))
        const keep = new Set(['Plan the launch', 'Research notes on solar storage', 'Untitled session'])

        otherTitle = homeTitles.find(title => !keep.has(title) && !/^Help me plan my day/.test(title) && drawn.some(row => row.startsWith(title))) ?? otherTitle
        entry.evidence.secondWindowTarget = otherTitle

        // MG_HOME_PLANT=h16: home reads the list once and never again (home
        // that does not follow another window). This check must then fail.
        if (process.env.MG_HOME_PLANT === 'h16') {
          entry.evidence.plant = await plantReload([['async function homeLoad(force = false) {', "async function homeLoad(force = false) {\n  if (homeData.status === 'ready') return undefined\n"]])
          await waitRows()
          await sleep(800)
        }
        must((await timeUntil('Recent', otherTitle, true, 100)) !== null, `"${otherTitle}" is not under Recent to begin with`)

        // The row a person can see: Advanced mode keeps a hidden copy of
        // the list, and the first match was it (scrollIntoView never ended).
        const target = second.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]', { hasText: otherTitle }).filter({ visible: true }).first()

        await target.waitFor({ state: 'visible', timeout: 10_000 })
        await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined)

        const b = await target.boundingBox()

        await second.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' })
        await second.locator('[role="menuitem"]', { hasText: /^Delete/ }).first().click()
        await second.locator('[role="alertdialog"] button, [role="dialog"] button', { hasText: /^Delete$/ }).first().click({ timeout: 5000 })
        times.deleteInSecondWindow = await timeUntil('Recent', otherTitle, false)
      } catch (error) {
        entry.evidence.secondWindowError = String(error.message).split('\n')[0]
        entry.evidence.secondWindowRows = await second
          .evaluate(title => [...document.querySelectorAll('[data-slot="sidebar"] [data-slot="context-menu-trigger"]')].filter(node => node.textContent.includes(title)).map(node => ({ shown: node.checkVisibility(), y: Math.round(node.getBoundingClientRect().y) })), otherTitle)
          .catch(() => null)
        entry.evidence.secondWindowSidebar = await second
          .evaluate(() => ({
            hash: location.hash,
            rows: [...document.querySelectorAll('[data-slot="sidebar"] [data-slot="context-menu-trigger"]')].map(node => `${node.checkVisibility() ? '' : '(hidden) '}${node.textContent.trim().slice(0, 40)}`),
            more: [...document.querySelectorAll('[data-slot="sidebar"] button')].map(node => node.getAttribute('aria-label') || node.textContent.trim()).filter(Boolean).slice(0, 40)
          }))
          .catch(error => String(error))
        entry.evidence.mainSidebar = await page
          .evaluate(() => [...document.querySelectorAll('[data-slot="sidebar"] [data-slot="context-menu-trigger"]')].map(node => `${node.checkVisibility() ? '' : '(hidden) '}${node.textContent.trim().slice(0, 40)}`))
          .catch(error => String(error))
        entry.evidence.persisted = await page
          .evaluate(async () => {
            const result = await window.hermesDesktop.api({ path: '/api/sessions?limit=100&offset=0&min_messages=0' })

            return (result?.sessions ?? []).map(s => `${s.id.slice(0, 18)} n=${s.message_count} src=${s.source} t=${(s.title || s.preview || '').slice(0, 24)}`)
          })
          .catch(error => String(error))
        await second.screenshot({ path: path.join(process.env.MG_RIG_EVIDENCE, 'shots', 'h16-second-window-error.png') }).catch(() => undefined)
      }

      await second.close().catch(() => undefined)
    }

    for (const [name, ms] of Object.entries(times)) {
      must(ms !== null && ms <= LIMIT, `${name}: home showed it after ${ms === null ? 'more than 5 s' : `${ms} ms`} (limit ${LIMIT} ms)`)
    }

    must(!entry.evidence.secondWindowError, `second window: ${entry.evidence.secondWindowError}`)
    must(entry.evidence.secondWindow, 'Hermes opened no second window (hermesDesktop.openWindow)')
  })
}

async function runH17() {
  const { page } = state

  // ── h17. Menus over home ─────────────────────────────────────────────────
  // Every menu that can open over an empty session, opened by pointer (the
  // palette by its key) and closed once by pointer outside it and once by
  // Escape. Sampled every frame after layout (a ResizeObserver callback, so
  // after every rAF of ours and Hermes'): the greeting, home's body and the
  // message box must stay where they were and on screen, and the root's
  // data-mg-empty-chat must never drop.
  await check('h17', async (entry, must) => {
    await setWindow({ width: 1220, zoom: 1 })
    await openHome()
    await waitRows()
    await sleep(800)

    const HOME_SURFACE = '[data-chat-surface]:has(.mg-home)'
    // A press at the centre of what is on screen, without Playwright's wait
    // for a still element (in a tab the model pill once never counted as
    // still: "scrollIntoViewIfNeeded: Timeout 30000ms").
    const pressOn = async locator => {
      const b = await locator.boundingBox({ timeout: 5000 })

      if (!b) {
        throw new Error('nothing to press')
      }

      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    }
    const OPEN = '[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"], [role="dialog"], [role="menu"], .mg-surfaces-menu'
    const menus = [
      // Home's own chat surface: after a tab opens, a hidden one is there too.
      { id: 'model', trigger: `${HOME_SURFACE} [data-slot="composer-fade"] [data-tour="model-pill"]`, open: () => pressOn(page.locator(`${HOME_SURFACE} [data-slot="composer-fade"] [data-tour="model-pill"]`).filter({ visible: true }).first()) },
      { id: 'effort', open: () => pressOn(page.locator(`${HOME_SURFACE} [data-slot="composer-fade"] [data-testid="reasoning-pill"]`).filter({ visible: true }).first()) },
      { id: 'attach', open: () => pressOn(page.locator(`${HOME_SURFACE} [data-slot="composer-root"] button[aria-label="Add context"]`).filter({ visible: true }).first()) },
      { id: 'surfaces', open: () => click(page.locator('[data-tour="mg-surfaces"] .mg-surfaces-hit').first()) },
      {
        id: 'context',
        open: async () => {
          const row = page.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]:visible').first()

          await row.waitFor({ state: 'visible', timeout: 10_000 })
          await row.scrollIntoViewIfNeeded()

          const b = await row.boundingBox()

          await page.mouse.move(b.x + 40, b.y + b.height / 2)
          await page.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' })
        }
      },
      // The palette sits where the quiet point is; outside it is the corner.
      { corner: true, id: 'palette', open: () => page.keyboard.press('Meta+k') }
    ]

    // A point inside the chat, above home, with nothing to press under it.
    const scenes = (entry.evidence.scenes = [])

    // Home in a tab (what openHome gives once sessions exist) and in the
    // main chat's new draft (#/), where the root's empty mark is on.
    const pass = async where => {
      const quiet = await page.evaluate(() => {
        const surface = document.querySelector('.mg-home')?.closest('[data-chat-surface]')
        const r = surface?.getBoundingClientRect()

        if (!r) {
          return null
        }

        for (const dy of [24, 48, 72, 96]) {
          for (const fx of [0.5, 0.3, 0.7, 0.9]) {
            const x = Math.round(r.x + r.width * fx)
            const y = Math.round(r.y + dy)
            const node = document.elementFromPoint(x, y)

            if (node && surface.contains(node) && !node.closest('button, a, input, textarea, [role="button"], [contenteditable], .mg-home-row, .mg-home-action')) {
              return { x, y }
            }
          }
        }

        return null
      })

      entry.evidence.outside = { ...entry.evidence.outside, [where]: quiet }
      must(quiet, `${where}: no quiet point in the chat to click outside a menu`)

      const record = () =>
        page.evaluate(() => {
          const box = node => {
            const r = node.getBoundingClientRect()

            return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 100) / 100)
          }
          const shown = node => Boolean(node?.isConnected && node.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
          const surface = document.querySelector('.mg-home')?.closest('[data-chat-surface]')
          const comp = surface?.querySelector('[data-slot="composer-root"]')
          const rec = (window.__mgH17 = { frames: [], on: true })
          const dummy = document.createElement('i')

          dummy.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0'
          document.documentElement.append(dummy)

          // Layout is done and every rAF callback has run: what this frame paints.
          const ro = new ResizeObserver(() => {
            const body = document.querySelector('.mg-home-body')
            const hello = document.querySelector('.mg-home-hello')

            rec.frames.push({
              body: shown(body) ? box(body) : null,
              comp: shown(comp) ? box(comp) : null,
              // Home's own mark on its dock (centres it), and the root's
              // empty-session mark (main chat only; a tab has messages
              // elsewhere in the page, so it is off there throughout).
              dock: Boolean(surface?.querySelector('[data-slot="composer-dock"]')?.hasAttribute('data-mg-home-dock')),
              empty: document.documentElement.hasAttribute('data-mg-empty-chat'),
              hello: shown(hello) ? box(hello) : null,
              t: Math.round(performance.now())
            })
          })
          const tick = () => {
            if (!rec.on) {
              ro.disconnect()
              dummy.remove()

              return
            }

            ro.unobserve(dummy)
            ro.observe(dummy)
            requestAnimationFrame(tick)
          }

          requestAnimationFrame(tick)
        })
      const stop = () =>
        page.evaluate(() => {
          window.__mgH17.on = false

          return window.__mgH17.frames
        })


      for (const menu of menus) {
        for (const close of ['pointer', 'Escape']) {
          const scene = { close, id: menu.id, where }

          scenes.push(scene)

          // In a tab Hermes may draw no model pill; a menu that cannot be
          // opened there cannot move home. The main draft must offer all.
          if (where === 'tab' && menu.trigger && !(await page.locator(menu.trigger).filter({ visible: true }).count())) {
            scene.skipped = 'no trigger on screen in a tab'
            continue
          }
          await page.keyboard.press('Escape').catch(() => undefined)
          await sleep(300)
          await record()
          await sleep(200)

          try {
            await menu.open()
            await page.waitForSelector(OPEN, { state: 'visible', timeout: 3000 })
            scene.opened = true
            await sleep(500)

            if (close === 'pointer') {
              const at = menu.corner ? await page.evaluate(() => ({ x: window.innerWidth - 24, y: window.innerHeight - 24 })) : quiet

              await page.mouse.move(at.x, at.y)
              await page.mouse.click(at.x, at.y)
            } else {
              await page.keyboard.press('Escape')
            }

            await page.waitForFunction(sel => !document.querySelector(sel), OPEN, { timeout: 3000 })
            scene.closed = true
            await sleep(600)
          } catch (error) {
            scene.error = String(error.message).split('\n')[0]
          }

          const frames = await stop()
          const first = frames[0]
          const bad = []

          for (const frame of frames) {
            const why = []

            for (const key of ['hello', 'body', 'comp']) {
              if (!frame[key]) {
                why.push(`${key} absent`)
              } else if (first?.[key] && frame[key].some((v, i) => Math.abs(v - first[key][i]) >= 1)) {
                why.push(`${key} at ${frame[key].join(',')} (was ${first[key].join(',')})`)
              }
            }

            if (!frame.dock) {
              why.push('data-mg-home-dock dropped')
            }

            if (frame.empty !== first?.empty) {
              why.push(`data-mg-empty-chat ${frame.empty ? 'came' : 'dropped'}`)
            }

            if (why.length) {
              bad.push(`${frame.t}: ${why.join('; ')}`)
            }
          }

          scene.frames = frames.length
          scene.bad = bad.length
          scene.empty = first?.empty ?? null
          scene.dockDropped = frames.filter(frame => !frame.dock).length
          scene.badFrames = bad.slice(0, 4)
          must(scene.opened && scene.closed, `${where} ${menu.id}, closed by ${close}: ${scene.error ?? 'did not open and close'}`)
          must(frames.length >= 20, `${where} ${menu.id}, closed by ${close}: only ${frames.length} frames recorded`)
          must(!bad.length, `${where} ${menu.id}, closed by ${close}: ${bad.length} of ${frames.length} frames wrong, first ${bad[0]}`)
        }
      }

    }

    const where = await page.evaluate(() => (document.querySelector('.mg-home')?.closest('[data-chat-surface]')?.getAttribute('data-composer-target')?.startsWith('tile:') ? 'tab' : 'main'))

    await pass(where)

    if (where === 'tab') {
      await page.evaluate(() => {
        window.location.hash = '#/'
      })
      await waitHome().catch(() => undefined)
      await sleep(1200)
      await pass('main')
    }

    await shot(entry, 'h17-after-menus')
  })
}

async function runH18() {
  const { page } = state

  // ── h18. No empty-session frame on first send or session switch ──────────
  // Per frame (sampled after layout, as in h17): where the message box on
  // screen is, whether the page is marked empty, the route and how many
  // messages the thread holds. On a first send from a new session and on a
  // switch between two sessions with messages, no frame may show the box at
  // the middle (the empty-session layout) once it has left it, or at all on
  // a switch. Bare Hermes (Monograph unloaded) is filmed the same way in the
  // same run, for reference.
  await check('h18', async (entry, must) => {
    await setWindow({ width: 1220, zoom: 1 })

    const record = () =>
      page.evaluate(() => {
        const rec = (window.__mgH18 = { frames: [], on: true })
        const dummy = document.createElement('i')
        const ids = new WeakMap()
        let next = 0
        const id = node => {
          if (!node) {
            return 0
          }

          if (!ids.has(node)) {
            ids.set(node, ++next)
          }

          return ids.get(node)
        }

        dummy.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0'
        document.documentElement.append(dummy)

        const ro = new ResizeObserver(() => {
          const surface = [...document.querySelectorAll('[data-chat-surface]')].find(node => node.checkVisibility() && !node.closest('[inert], [aria-hidden="true"]:not([data-aria-hidden])'))
          const comp = surface?.querySelector('[data-slot="composer-root"]')
          const r = comp?.checkVisibility() ? comp.getBoundingClientRect() : null
          const thread = surface?.querySelector('[data-slot="aui_thread-content"]')

          rec.frames.push({
            b: r ? Math.round(r.bottom) : null,
            empty: document.documentElement.hasAttribute('data-mg-empty-chat'),
            h: window.innerHeight,
            hash: location.hash,
            home: Boolean(document.querySelector('.mg-home-body')?.checkVisibility()),
            msgs: thread?.querySelectorAll('[data-role="user"], [data-role="assistant"]').length ?? -1,
            t: Math.round(performance.now()),
            thread: id(thread),
            vp: document.querySelectorAll('[data-slot="aui_thread-viewport"]').length
          })
        })
        const tick = () => {
          if (!rec.on) {
            ro.disconnect()
            dummy.remove()

            return
          }

          ro.unobserve(dummy)
          ro.observe(dummy)
          requestAnimationFrame(tick)
        }

        requestAnimationFrame(tick)
      })
    const stop = () =>
      page.evaluate(() => {
        window.__mgH18.on = false

        return window.__mgH18.frames
      })
    // The box is "at the middle" when its bottom sits above the lower quarter.
    const mid = frame => frame.b !== null && frame.b < frame.h * 0.75
    const judge = (frames, kind) => {
      const left = frames.findIndex(frame => frame.b !== null && !mid(frame))
      const back = kind === 'send' ? (left < 0 ? [] : frames.slice(left).filter(mid)) : frames.filter(mid)

      return { back: back.length, first: back[0] ?? null, frames: frames.length, left, midAtStart: frames.slice(0, 3).filter(mid).length }
    }
    const newSession = async () => {
      await page.keyboard.press('Escape').catch(() => undefined)
      await click(page.locator('[data-slot="sidebar"] button[aria-label="New session"]').first())
      await sleep(1200)
    }
    const switchTo = async title => {
      const row = page.locator('[data-slot="sidebar"] [data-slot="context-menu-trigger"]:visible', { hasText: title }).first()

      await row.scrollIntoViewIfNeeded()
      await click(row)
    }
    const film = async label => {
      const out = {}

      // First send from a new session.
      await newSession()
      await record()
      await sleep(150)
      await type(`First send, ${label}, MG_H18_${label}.`, 'Enter')
      await page.waitForFunction(() => document.body.innerText.includes('MG_HOME_REPLY'), null, { timeout: 30_000 }).catch(() => undefined)
      await sleep(600)
      out.send = await stop()

      // A switch between two sessions with messages.
      await switchTo('Plan the launch')
      await page.waitForFunction(() => document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes('Seeded prompt 0'), null, { timeout: 20_000 })
      await sleep(800)
      await record()
      await sleep(150)
      await switchTo('Research notes on solar storage')
      await page.waitForFunction(() => document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes('Seeded prompt 1'), null, { timeout: 20_000 }).catch(() => undefined)
      await sleep(800)
      out.switch = await stop()

      return out
    }

    const ours = await film('ours')

    await shot(entry, 'h18-ours')
    await hotReload({ gone: true, source: stubPlugin() })

    const bare = await film('bare')

    await shot(entry, 'h18-bare')
    await hotReload()

    const table = (entry.evidence.table = {})

    for (const kind of ['send', 'switch']) {
      table[kind] = { bare: judge(bare[kind], kind), ours: judge(ours[kind], kind) }
    }

    entry.evidence.raw = { bare, ours }

    for (const kind of ['send', 'switch']) {
      const { bare: b, ours: o } = table[kind]

      must(o.frames >= 20, `${kind}: only ${o.frames} frames recorded`)
      must(o.back === 0, `${kind}: the message box showed at the middle in ${o.back} frame(s) after it had docked (bare Hermes: ${b.back}); first ${JSON.stringify(o.first)}`)
    }
  })
}
