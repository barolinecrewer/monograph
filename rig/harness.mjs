// The rig's harness: one sandboxed Hermes per run, and the helpers every suite
// uses to drive it. Started by rig/run.mjs through checks.spec.mjs; the checks
// themselves live in rig/suites/<name>.mjs. See rig/README.md.
//
// Sandbox, mock model and Electron launch are Hermes' own e2e helpers, imported
// from the checkout by path. Everything here goes through Playwright into that
// one window: real mouse and keyboard events, no script-made clicks.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const need = name => {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} is not set: start the rig with "node rig/run.mjs"`)
  }

  return value
}

export const HERMES_REPO = need('MG_RIG_HERMES_REPO')
export const EVIDENCE = need('MG_RIG_EVIDENCE')
export const WORK = need('MG_RIG_WORK')
export const PLUGIN = need('MG_RIG_PLUGIN')
export const REAL_HOME = need('MG_RIG_REAL_HERMES_HOME')
export const KEEP = Boolean(process.env.MG_RIG_KEEP)

// Whether the build under test carries a feature module (src/modules/NN-<name>.js).
// A copy of the source may leave one out; a check of that module's page is
// then left out too, rather than failed. build.mjs heads each module's block
// with its file name, which is what this reads.
const BUILT = fs.readFileSync(PLUGIN, 'utf8')

export const hasModule = name => new RegExp(`── src/modules/\\d+-${name}\\.js ──`).test(BUILT)
// Hermes' interface mode: 'advanced' is what a new profile gets, 'simple' hides
// the instrumentation (store/interface-mode.ts).
export const MODE = process.env.MG_RIG_MODE === 'simple' ? 'simple' : 'advanced'
// `run.mjs --motion off|reduced`: every suite runs with Monograph's motion
// setting off (stored the way the Appearance page stores it, before the app
// reads it) or under emulated prefers-reduced-motion. Unset: as before.
export const MOTION = ['off', 'reduced'].includes(process.env.MG_RIG_MOTION) ? process.env.MG_RIG_MOTION : null
// MG_RIG_SKIN=1 installs skin/monograph.yaml in the sandbox and selects it
// (see boot()); the default is Hermes' own skin, as a new profile has it.
export const SKIN = process.env.MG_RIG_SKIN === '1'

// Anything else from the Hermes checkout, by path from its root.
export const hermes = file => import(pathToFileURL(path.join(HERMES_REPO, file)).href)
export const { test, expect, allowErrorBanners } = await hermes('apps/desktop/e2e/test.ts')
export const { buildAppEnv, createSandbox, findElectron, waitForAppReady } = await hermes('apps/desktop/e2e/fixtures.ts')
const { _electron } = await hermes('node_modules/@playwright/test/index.mjs')
const { stopSandboxGatewayDaemons } = await hermes('apps/desktop/e2e/run-tmp-reaper.ts')
export const { startMockServer } = await hermes('tests-js/scripts/mock-server.ts')
const { writeEnvFile, writeMockProviderConfig } = await hermes('tests-js/scripts/mock-provider-config.ts')

// A turn is running while its pair holds one of these.
export const RUNNING = '[data-slot="aui_turn-activity"], [data-slot="aui_response-loading"]'
export const VIEWPORT = '[data-slot="aui_thread-viewport"]'

// The thread a person is looking at, as a JS expression for page.evaluate /
// waitForFunction strings. Hermes keeps the threads of other open session
// tabs in the page (hidden, but often with a size), so the first viewport in
// the document is not necessarily the one on screen: this takes the visible
// one whose middle is not covered by another thread.
export const ON_SCREEN_VIEWPORT = `(() => {
  const list = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].filter(v => v.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && v.getBoundingClientRect().height > 10)
  for (const v of list) {
    const r = v.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 160))
    if (hit && v.contains(hit)) return v
  }
  return list[0] ?? null
})()`

// Waits until the thread on screen holds `needle` and nothing in it runs.
export const turnDone = (needle, timeout = 60_000) =>
  state.page
    .waitForFunction(`(() => { const v = ${ON_SCREEN_VIEWPORT}; return Boolean(v) && !v.querySelector(${JSON.stringify(RUNNING)}) && (v.textContent ?? '').includes(${JSON.stringify(needle)}) })()`, undefined, {
      polling: 100,
      timeout
    })
    .then(() => true)
    .catch(() => {
      throw new Error(`no finished turn showing "${needle}" on screen within ${timeout / 1000}s`)
    })

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const within = (promise, ms, label) =>
  Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`${label}: nothing after ${ms}ms`)))])

// `observations` are things seen on the way that are no check's verdict but
// that whoever reads the report should know about.
export const results = { checks: {}, notes: [], observations: [], startedAt: new Date().toISOString() }
export const save = () => fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(results, null, 2))
// app, page, mock, sandbox, python, installed: filled by boot().
export const state = {}

// The checks of this run, in the order they are reported. Each starts as
// "not run", so a run that dies early still names what it did not reach.
export function declare(list) {
  for (const [id, title] of list) {
    results.checks[id] = { status: 'not run', title }
  }

  save()
}

export async function shot(entry, name) {
  const file = path.join(EVIDENCE, 'shots', `${name}.png`)

  // Under a zoom factor other than 1, Playwright's page.screenshot() sizes
  // the picture in CSS pixels but crops device pixels: at 800 px and 125 %
  // it kept 640 px of the width (home h9). The debugging protocol's own
  // capture takes the whole surface the window shows.
  const zoom = await state.page.evaluate(() => outerWidth / innerWidth).catch(() => 1)

  if (Math.abs(zoom - 1) > 0.01 && state.cdp) {
    const { data } = await state.cdp.send('Page.captureScreenshot', { format: 'png' })

    fs.writeFileSync(file, Buffer.from(data, 'base64'))
  } else {
    await state.page.screenshot({ path: file })
  }
  entry.screenshots.push(file)

  return file
}

// One check: `body` fills entry.evidence and calls `must` for each thing that
// has to hold. A check that throws fails with the error kept.
export async function check(id, body) {
  const entry = Object.assign(results.checks[id], { evidence: {}, screenshots: [], why: [] })

  if (results.abort) {
    entry.why.push(`not run: ${results.abort}`)
    save()

    return
  }

  const started = Date.now()
  const consoleMark = consoleEvents.length

  const must = (ok, reason) => {
    if (!ok) {
      entry.why.push(reason)
    }

    return Boolean(ok)
  }

  try {
    await body(entry, must)
    entry.status = entry.why.length ? 'fail' : 'pass'
  } catch (error) {
    entry.status = 'fail'
    entry.error = String(error?.stack ?? error).slice(0, 2000)
    await shot(entry, `${id}-error`).catch(() => undefined)
  }

  // Console messages reach Playwright a moment after the page writes them.
  await sleep(150)

  const fresh = consoleErrorsSince(consoleMark, entry.allowConsole)

  if (fresh.length) {
    entry.evidence.consoleErrors = fresh.slice(0, 8).map(event => `[${event.type}] ${event.text.slice(0, 400)}`)
    entry.why.push(`${fresh.length} new console error(s) or unhandled rejection(s) during the check (renderer-console.log)`)
    entry.status = 'fail'
  }

  entry.ms = Date.now() - started
  save()
}

// ── Console and page errors, per check ──────────────────────────────────────
// Every console message and page error of the run, in order. check() notes
// where the list stood when it began; a new error, page error (uncaught
// exception or unhandled rejection) or a "[monograph] … skipped/failed"
// warning fails the check, unless it matches CONSOLE_ALLOW or the check's own
// `entry.allowConsole` (a list of RegExps, for a check that provokes one on
// purpose). A message that arrives after its check ended is counted against
// the next check.
export const consoleEvents = []

// Hermes' own noise. Keep this short, and say for each entry why it is not
// ours. Matched against "[type] text".
export const CONSOLE_ALLOW = [
  // Electron's dev-build CSP notice: printed once per window load by Electron
  // itself, never by the page's code. A warning, listed here for clarity.
  /Electron Security Warning/,
  // Chromium's network log for a request the page made to a port that is
  // closed on purpose (the rig points every proxy at 127.0.0.1:9).
  /127\.0\.0\.1:9\b/
]

const isError = event =>
  event.type === 'error' || event.type === 'pageerror' || (event.type === 'warning' && /^\[monograph\].*(skipped|failed)/.test(event.text))

export function consoleErrorsSince(mark = 0, allow = []) {
  return consoleEvents
    .slice(mark)
    .filter(isError)
    .filter(event => ![...CONSOLE_ALLOW, ...(allow ?? [])].some(rule => rule.test(`[${event.type}] ${event.text}`)))
}

// The message box on screen. Hermes keeps the composers of other open
// session tabs in the page, hidden, so the first one in the document may not
// be the one a person sees.
export const composer = async () => {
  const shown = state.page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()

  if (await shown.count()) {
    return shown
  }

  const scoped = state.page.locator('[data-slot="composer-root"] [contenteditable="true"]').first()

  return (await scoped.count()) ? scoped : state.page.locator('[contenteditable="true"]').first()
}

// Click the message box, put the text in, press the keys. insertText rather
// than key-by-key: the prompts carry brackets and quotes an editor may pair up.
export async function type(text, keys) {
  const box = await composer()

  await box.waitFor({ state: 'visible', timeout: 15_000 })
  await box.click()
  await state.page.keyboard.insertText(text)

  const typed = (await box.innerText()).trim()

  if (typed !== text) {
    throw new Error(`the message box holds ${JSON.stringify(typed)} instead of ${JSON.stringify(text)}`)
  }

  await state.page.keyboard.press(keys)
}

export const thread = () =>
  state.page.evaluate(
    ({ running, viewport }) => ({
      mfLive: Boolean(document.querySelector('#mf-live')),
      queuedBubbles: [...document.querySelectorAll('[data-mg-queued]')].map(node => (node.textContent ?? '').trim().slice(0, 80)),
      rowMarks: [...document.querySelectorAll('[data-slot="aui_assistant-message-root"]')].map(row =>
        'mgSeg' in row.dataset ? `seg=${row.dataset.mgSeg}${'mgWorked' in row.dataset ? ` worked="${row.dataset.mgWorked}"` : ''}` : 'unmarked'
      ),
      runningMarkers: [...document.querySelectorAll(running)].map(node => `${node.dataset.slot.replace('aui_', '')}${node.dataset.state ? `:${node.dataset.state}` : ''}`),
      runningPairs: [...document.querySelectorAll('[data-slot="aui_turn-pair"]')].map(pair => Boolean(pair.querySelector(running))),
      hermesQueueChip: document.body.innerText.match(/\b\d+ Queued\b/)?.[0] ?? null,
      text: (document.querySelector(viewport)?.textContent ?? '').replace(/\s+/g, ' ').slice(-400)
    }),
    { running: RUNNING, viewport: VIEWPORT }
  )

// A turn is over when its answer is on screen and nothing in the thread runs.
export const finished = (needle, timeout) =>
  state.page.waitForFunction(
    ({ needle, running, viewport }) =>
      !document.querySelector(running) && (document.querySelector(viewport)?.textContent ?? '').includes(needle),
    { needle, running: RUNNING, viewport: VIEWPORT },
    { timeout }
  )

// The interpreter of the dependency environment the real install committed for
// this checkout: <home>/installs/<key>/facts.json, key as in pm/environments.py.
// Only that one file is read from the real home, and nothing is written.
function committedPython() {
  const key = crypto.createHash('sha256').update(fs.realpathSync(HERMES_REPO)).digest('hex').slice(0, 16)
  const facts = path.join(REAL_HOME, 'installs', key, 'facts.json')
  let venv

  try {
    venv = JSON.parse(fs.readFileSync(facts, 'utf8')).packages?.venv?.environment
  } catch (error) {
    throw new Error(`cannot read ${facts}: ${error.message}`)
  }

  const python = venv && path.join(venv, 'bin', 'python')

  if (!python || !fs.existsSync(python)) {
    throw new Error(`${facts} names no usable Python environment (${venv ?? 'none'}); the rig will not build one`)
  }

  return python
}

// A suite may shape the run through what it exports:
//   mock    options for Hermes' own mock model (tests-js/scripts/mock-server.ts)
//   model   async ({ startMockServer }) => a model server of the suite's own:
//           { url, port, close() } and, if it has them, receivedPrompts and
//           releaseHeldStream()
//   config  extra YAML for the sandbox's config.yaml
//   seed    ({ sandbox, mock }) => files to put into the sandbox before launch
export async function boot(suite = {}) {
  const mock = suite.model ? await suite.model({ startMockServer }) : await startMockServer(suite.mock ?? {})

  state.mock = mock

  const sandbox = createSandbox('mg')

  state.sandbox = sandbox

  // The whole point: nothing below may resolve to the real Hermes home.
  for (const dir of [sandbox.root, sandbox.hermesHome, sandbox.userDataDir]) {
    if (!dir.startsWith(WORK + path.sep) || dir === REAL_HOME) {
      throw new Error(`sandbox path ${dir} is not under the rig's work dir ${WORK}`)
    }
  }

  // MG_RIG_SKIN=1: the owner's case, Monograph's skin installed and chosen.
  // Skins are YAML files in <HERMES_HOME>/skins/ and the active one is
  // `display.skin` in config.yaml (hermes_cli/skin_engine.py), which is what
  // `hermes config set display.skin monograph` writes; the gateway pushes it
  // to the desktop. Without it the app runs on Hermes' default skin.
  let extra = suite.config ?? ''

  if (SKIN) {
    const skins = path.join(sandbox.hermesHome, 'skins')

    fs.mkdirSync(skins, { recursive: true })
    fs.copyFileSync(path.join(import.meta.dirname, '..', 'skin', 'monograph.yaml'), path.join(skins, 'monograph.yaml'))
    extra = /^display:\s*$/m.test(extra) ? extra.replace(/^display:\s*$/m, 'display:\n  skin: monograph') : `${extra}${extra && !extra.endsWith('\n') ? '\n' : ''}display:\n  skin: monograph\n`
    results.notes.push('skin: skin/monograph.yaml installed in the sandbox and selected (display.skin: monograph)')
  }

  // No update check: it would run git in the Hermes checkout.
  writeMockProviderConfig(sandbox.hermesHome, mock.url, undefined, `updates:\n  check: false\n${extra}`)
  writeEnvFile(sandbox.hermesHome)

  // A plain folder with a plugin.js under <HERMES_HOME>/desktop-plugins is
  // loaded and on by default; no config flag (src/contrib/runtime-loader.ts).
  const installed = path.join(sandbox.hermesHome, 'desktop-plugins', 'monograph', 'plugin.js')

  fs.mkdirSync(path.dirname(installed), { recursive: true })
  fs.copyFileSync(PLUGIN, installed)
  state.installed = installed

  const python = committedPython()

  state.python = python

  // Last thing before launch: the sandbox exists, the app has not read it yet.
  await suite.seed?.({ mock, sandbox })

  const env = buildAppEnv(sandbox, {
    // The backend's Python. Left to itself, a launch under a new HERMES_HOME
    // treats the checkout as borrowed and first syncs a whole dependency
    // environment into that home (hermes_cli/venv_sync.py), from the network.
    // Instead: run the environment the real install already committed, in
    // place and read-only, and switch the sync off.
    HERMES_DESKTOP_PYTHON: python,
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    // The checkout is read-only to the rig, bytecode caches included.
    PYTHONDONTWRITEBYTECODE: '1',
    // Belt and braces: the backend's HTTP clients may reach this machine only.
    ...Object.fromEntries(
      ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(name => [name, 'http://127.0.0.1:9'])
    ),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1'
  })

  if (env.HERMES_HOME !== sandbox.hermesHome || env.HOME !== sandbox.root || env.HERMES_DESKTOP_USER_DATA_DIR !== sandbox.userDataDir) {
    throw new Error('the app environment does not point at the sandbox')
  }

  // Hermes' own launchDesktop(), plus one preloaded module: the window opens
  // without taking the keyboard (rig/no-focus.cjs).
  const desktop = path.join(HERMES_REPO, 'apps', 'desktop')
  const app = await _electron.launch({
    args: ['-r', path.join(import.meta.dirname, 'no-focus.cjs'), desktop, '--disable-gpu', '--no-sandbox'],
    cwd: desktop,
    env,
    executablePath: findElectron()
  })
  const page = await app.firstWindow()

  state.app = app
  state.page = page

  // The window never has the keyboard, so the page is told it does: focus
  // styles, focus events and the caret behave as in a window in front.
  state.cdp = await page.context().newCDPSession(page)
  await state.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

  // Runs started through rig/locked.sh hold a slot. Each slot has its own
  // place on the screen, so that no rig window covers another: a covered
  // window stops drawing, and every timed check in it would stall.
  const slot = Number(process.env.MG_RIG_SLOT)

  if (Number.isInteger(slot) && slot >= 0) {
    await app
      .evaluate(({ BrowserWindow, screen }, slot) => {
        const win = BrowserWindow.getAllWindows()[0]
        const area = screen.getPrimaryDisplay().workArea
        const { width, height } = win.getBounds()
        const columns = Math.max(1, Math.floor(area.width / (width + 16)))
        const rows = Math.max(1, Math.floor(area.height / (height + 16)))

        win.setPosition(area.x + 8 + (slot % columns) * (width + 16), area.y + 8 + (Math.floor(slot / columns) % rows) * (height + 16))
      }, slot)
      .catch(() => undefined)
  }

  const proc = app.process()

  fs.writeFileSync(path.join(EVIDENCE, 'pids.json'), JSON.stringify({ electron: proc.pid, mockPort: mock.port, runner: process.pid, sandbox: sandbox.root }))

  const appLog = fs.createWriteStream(path.join(EVIDENCE, 'app.log'))

  proc.stdout?.pipe(appLog, { end: false })
  proc.stderr?.pipe(appLog, { end: false })

  const consoleLog = fs.createWriteStream(path.join(EVIDENCE, 'renderer-console.log'))

  page.on('console', message => {
    consoleLog.write(`[${message.type()}] ${message.text().slice(0, 2000)}\n`)
    consoleEvents.push({ at: Date.now(), text: message.text().slice(0, 2000), type: message.type() })
  })
  // An empty-message throw has been seen several times with nothing to tell
  // what it was; its name, type and JSON form go along with the stack.
  page.on('pageerror', error => {
    let json

    try {
      json = JSON.stringify(error)
    } catch (problem) {
      json = `(not serialisable: ${problem?.message})`
    }

    const text = `${String(error?.stack ?? error).slice(0, 2000)} {name: ${JSON.stringify(error?.name ?? null)}, typeof: ${typeof error}, json: ${String(json).slice(0, 600)}}`

    consoleLog.write(`[pageerror] ${text}\n`)
    consoleEvents.push({ at: Date.now(), text, type: 'pageerror' })
  })

  await waitForAppReady({ app, page }, 120_000)

  if (MODE === 'simple') {
    // The mode picker's own storage key, then a reload: the app reads it at start.
    await page.evaluate(() => window.localStorage.setItem('hermes.desktop.interfaceMode.v1', 'simple'))
  }

  if (MOTION === 'off') {
    // The plugin's own stored settings (ctx.storage: hermes.plugin.<id>.<key>).
    await page.evaluate(() => {
      const key = 'hermes.plugin.monograph.config'
      let saved = {}

      try {
        saved = JSON.parse(window.localStorage.getItem(key) || '{}') || {}
      } catch {
        saved = {}
      }

      window.localStorage.setItem(key, JSON.stringify({ ...saved, motion: 'off' }))
    })
  }

  if (MODE === 'simple' || MOTION === 'off') {
    await page.reload()
    await waitForAppReady({ app, page }, 60_000)
  }

  if (MOTION === 'reduced') {
    await state.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  }

  if (MOTION) {
    results.notes.push(`motion: ${MOTION === 'off' ? 'Monograph motion setting off (stored before the app read it)' : 'prefers-reduced-motion: reduce emulated'} for the whole run`)
  }
}

// A model server in front of another (`base`, e.g. the stress suite's
// startModel()): a prompt holding one of `scripts`' tokens gets that reply,
// streamed in short pieces; every other request goes to `base` unchanged.
// Returns base's own extras (receivedPrompts, releaseHeldStream, …) too.
//   export const model = async () => scriptedModel(await startModel(), { MGY_LANGS: '```ts\n…', MGY_FAIL: { status: 400, error: '…' } })
export async function scriptedModel(base, scripts) {
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    let body = ''

    req.on('data', part => (body += part))
    req.on('end', () => {
      let parsed = {}

      try {
        parsed = JSON.parse(body)
      } catch {}

      const user = (Array.isArray(parsed.messages) ? parsed.messages : []).filter(m => m?.role === 'user').at(-1)
      const text = typeof user?.content === 'string' ? user.content : Array.isArray(user?.content) ? user.content.map(p => p.text ?? '').join('\n') : ''
      const token = req.method === 'POST' && req.url?.startsWith('/v1/chat/completions') && parsed.stream === true ? Object.keys(scripts).find(key => text.includes(key)) : null
      // Only the first completion of a turn: after a tool result the base answers.
      const afterTool = (parsed.messages ?? []).slice((parsed.messages ?? []).lastIndexOf(user) + 1).some(m => m?.role === 'tool')

      if (token && !afterTool && typeof scripts[token] === 'object') {
        // { status, error }: the provider refuses the request.
        res.writeHead(scripts[token].status ?? 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'invalid_request_error', message: scripts[token].error ?? 'The request was refused.', type: 'invalid_request_error' } }))

        return
      }

      if (token && !afterTool) {
        const reply = scripts[token]
        const model = parsed.model || 'mock-model'
        const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish, index: 0 }], created: 0, id: 'mgy', model, object: 'chat.completion.chunk' })}\n\n`
        let at = 0

        res.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' })

        const next = () => {
          if (res.destroyed) {
            return
          }

          if (at >= reply.length) {
            res.write(chunk({}, 'stop'))
            res.end('data: [DONE]\n\n')

            return
          }

          res.write(chunk({ content: reply.slice(at, at + 160) }))
          at += 160
          setTimeout(next, 10)
        }

        next()

        return
      }

      const target = new URL(req.url, base.url)
      const forward = http.request(target, { headers: { ...req.headers, host: target.host }, method: req.method }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(res)
      })

      forward.on('error', () => {
        res.writeHead(502)
        res.end('{}')
      })
      forward.end(body)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const port = server.address().port

  return {
    ...base,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise(done => server.close(() => done()))
      await base.close?.()
    },
    port,
    url: `http://127.0.0.1:${port}`
  }
}

export async function teardown() {
  const { app, mock, sandbox } = state

  if (app) {
    const proc = app.process()

    await Promise.race([app.close().catch(() => undefined), sleep(20_000)])

    if (proc.exitCode === null && proc.signalCode === null) {
      results.notes.push(`Electron (pid ${proc.pid}) did not exit within 20s of close(); killed`)
      proc.kill('SIGKILL')
    }
  }

  if (mock) {
    mock.releaseHeldStream?.()
    await Promise.race([mock.close().catch(() => undefined), sleep(5_000)])
  }

  if (sandbox) {
    if (KEEP) {
      stopSandboxGatewayDaemons(sandbox.root, sandbox.hermesHome)
    } else {
      sandbox.cleanup()
    }
  }

  save()
}

export const BOOT = ['a', 'Boot: window loads, Monograph active']

// Boot the sandboxed app for `suite` and run check a. Without a booted app and
// an active plugin nothing after it means anything, so a failure here stops
// the run: every later check reports "not run" with the reason.
export async function bootCheck(suite = {}) {
  // Banners are reported as evidence at the end instead of failing the run twice.
  allowErrorBanners()

  try {
    await boot(suite)
  } catch (error) {
    results.setupError = String(error?.stack ?? error).slice(0, 3000)
    results.abort = 'the sandboxed app did not come up'

    if (state.page) {
      await state.page.screenshot({ path: path.join(EVIDENCE, 'shots', 'setup-error.png') }).catch(() => undefined)
    }
  }

  const { app, page, sandbox } = state

  await check('a', async (entry, must) => {
    const identity = await page.evaluate(() => window.hermesDesktop?.getVersion?.()).catch(() => null)

    entry.evidence.url = page.url().replace(HERMES_REPO, '<hermes>')
    entry.evidence.window = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]

      return { ...win.getBounds(), fullscreen: win.isFullScreen(), maximized: win.isMaximized(), visible: win.isVisible() }
    })
    entry.evidence.hermesHome = identity?.hermesHome ? identity.hermesHome.replace(WORK, '<work>') : 'not reported by this build'
    entry.evidence.appVersion = identity?.appVersion ?? null

    if (identity?.hermesHome && identity.hermesHome !== sandbox.hermesHome) {
      results.abort = `the app reports HERMES_HOME ${identity.hermesHome}, not the sandbox; stopped before sending anything`
      must(false, results.abort)

      return
    }

    await page.waitForSelector('[data-tour="mg-surfaces"]', { state: 'attached', timeout: 30_000 }).catch(() => undefined)

    const seen = await page.evaluate(() => {
      const button = document.querySelector('[data-tour="mg-surfaces"]')
      const rect = button?.getBoundingClientRect()
      const root = getComputedStyle(document.documentElement)

      return {
        button: button ? `<${button.tagName.toLowerCase()}> ${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)}` : null,
        canvas: root.getPropertyValue('--mg-canvas').trim(),
        composer: Boolean(document.querySelector('[data-slot="composer-root"] [contenteditable="true"]')),
        glyph: Boolean(document.querySelector('[data-tour="mg-surfaces"] .mg-surfaces-hit')),
        mode: window.localStorage.getItem('hermes.desktop.interfaceMode.v1') ?? 'advanced (no key: Hermes\' default)',
        // Hermes' own buttons in the top-right cluster that are on screen.
        rightCluster: [...document.querySelectorAll('[data-titlebar-cluster="right"] button')]
          .filter(node => node.checkVisibility() && node.getBoundingClientRect().width > 0)
          .map(node => `"${node.getAttribute('aria-label') ?? '?'}" at ${Math.round(node.getBoundingClientRect().x)},${Math.round(node.getBoundingClientRect().y)}`),
        tools: document.documentElement.dataset.mgTools ?? null
      }
    })

    const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12)

    Object.assign(entry.evidence, {
      surfacesButton: seen.button,
      surfacesGlyph: seen.glyph,
      '--mg-canvas': seen.canvas,
      'data-mg-tools': seen.tools,
      composer: seen.composer,
      interfaceMode: seen.mode,
      hermesTopRightButtons: seen.rightCluster,
      pluginInSandbox: `${state.installed.replace(WORK, '<work>')} sha256 ${sha(state.installed)} (built ${sha(PLUGIN)})`
    })

    must(seen.button, 'no [data-tour="mg-surfaces"] button: the plugin did not register its titlebar button')
    must(seen.canvas, '--mg-canvas does not resolve on :root: the plugin stylesheet is not applied')
    must(seen.composer, 'no message box inside [data-slot="composer-root"]')
    must(entry.evidence.window.visible, 'the window is not visible')
    await shot(entry, 'a-boot')
  })

  if (results.checks.a.status !== 'pass' && !results.abort) {
    results.abort = 'check a failed: without a booted app and an active plugin the rest proves nothing'
  }
}

// Banners still on screen, where the model calls went, and the run's verdict.
export async function wrapUp() {
  const { mock, page } = state

  if (page) {
    const banners = await page
      .evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(node => (node.textContent ?? '').trim().slice(0, 200)).filter(Boolean))
      .catch(() => [])

    for (const banner of banners) {
      results.notes.push(`error banner on screen at the end: ${banner}`)
    }
  }

  if (mock) {
    results.notes.push(`model calls went to the mock at 127.0.0.1:${mock.port}${mock.receivedPrompts ? ` (${mock.receivedPrompts.length} completions)` : ''}`)
  }

  save()

  const failed = Object.entries(results.checks).filter(([, entry]) => entry.status !== 'pass').map(([id, entry]) => `${id}=${entry.status}`)

  expect(failed, 'checks that did not pass').toEqual([])
}


// ── Layout: overlaps ────────────────────────────────────────────────────────
// Interactive elements a person can see and point at.
export const INTERACTIVE =
  'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [role="option"], [tabindex]:not([tabindex="-1"])'

// Every pair of visible, interactive elements whose boxes intersect, ignoring
// pairs where one holds the other. "Visible": checkVisibility() with opacity
// and visibility, a box of at least 2x2 px after clipping by every ancestor
// that clips (overflow other than visible), pointer-events not none, not
// inert or aria-hidden. `within` limits the search to a rectangle
// { x, y, width, height } or to the box of a selector. `min` is the smallest
// overlap, in px each way, that counts.
export function overlaps(selectors = INTERACTIVE, { min = 1, within = null } = {}) {
  return state.page.evaluate(
    ({ selectors, min, within }) => {
      const list = Array.isArray(selectors) ? selectors.join(', ') : selectors
      let area = null

      if (typeof within === 'string') {
        const node = document.querySelector(within)

        area = node ? node.getBoundingClientRect() : null

        if (!area) {
          return { error: `no element for ${within}`, pairs: [], seen: 0 }
        }
      } else if (within) {
        area = { bottom: within.y + within.height, left: within.x, right: within.x + within.width, top: within.y }
      }

      const clipped = node => {
        let { bottom, left, right, top } = node.getBoundingClientRect()

        for (let up = node.parentElement; up && up !== document.documentElement; up = up.parentElement) {
          const style = getComputedStyle(up)

          if (style.overflowX !== 'visible' || style.overflowY !== 'visible' || style.contain.includes('paint')) {
            const box = up.getBoundingClientRect()

            left = Math.max(left, box.left)
            right = Math.min(right, box.right)
            top = Math.max(top, box.top)
            bottom = Math.min(bottom, box.bottom)
          }
        }

        left = Math.max(left, 0)
        top = Math.max(top, 0)
        right = Math.min(right, window.innerWidth)
        bottom = Math.min(bottom, window.innerHeight)

        return { bottom, left, right, top }
      }

      const name = node => {
        const label = node.getAttribute('aria-label') ?? node.getAttribute('title') ?? (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)
        const marks = [node.dataset.tour && `tour=${node.dataset.tour}`, node.dataset.slot && `slot=${node.dataset.slot}`, node.dataset.testid && `testid=${node.dataset.testid}`]
          .filter(Boolean)
          .join(' ')
        const mg = [...node.classList].filter(cls => cls.startsWith('mg-')).join('.')

        return `<${node.tagName.toLowerCase()}${mg ? `.${mg}` : ''}${marks ? ` ${marks}` : ''}> "${label}"`
      }

      const items = []

      for (const node of document.querySelectorAll(list)) {
        if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || node.closest('[inert], [aria-hidden="true"]')) {
          continue
        }

        if (getComputedStyle(node).pointerEvents === 'none') {
          continue
        }

        const box = clipped(node)

        if (box.right - box.left < 2 || box.bottom - box.top < 2) {
          continue
        }

        if (area && (box.right <= area.left || box.left >= area.right || box.bottom <= area.top || box.top >= area.bottom)) {
          continue
        }

        items.push({ box, node })
      }

      const pairs = []

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i]
          const b = items[j]

          if (a.node.contains(b.node) || b.node.contains(a.node)) {
            continue
          }

          const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left)
          const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)

          if (w >= min && h >= min) {
            const at = `${Math.round(Math.max(a.box.left, b.box.left))},${Math.round(Math.max(a.box.top, b.box.top))}`

            pairs.push({ a: name(a.node), b: name(b.node), overlap: `${Math.round(w)}x${Math.round(h)} at ${at}` })
          }
        }
      }

      return { pairs, seen: items.length }
    },
    { min, selectors, within }
  )
}

// Layout problems in the window as it stands: a horizontal scrollbar on the
// page or on any element that shows one, and text cut off inside a button
// (its text box reaches past the button's clipped box). Text that ends in an
// ellipsis is reported apart, as "truncated": it is cut on purpose.
export function layoutProblems({ within = null } = {}) {
  return state.page.evaluate(
    ({ within }) => {
      const out = { clippedText: [], hScroll: [], truncated: [] }
      const page = document.scrollingElement

      if (page.scrollWidth > page.clientWidth + 1) {
        out.hScroll.push(`page: scrollWidth ${page.scrollWidth} > clientWidth ${page.clientWidth}`)
      }

      for (const node of document.querySelectorAll('body *')) {
        const style = getComputedStyle(node)

        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1 && node.checkVisibility() && node.clientHeight > 0) {
          const box = node.getBoundingClientRect()

          if (box.width > 0 && style.scrollbarWidth !== 'none') {
            out.hScroll.push(`<${node.tagName.toLowerCase()} ${node.dataset.slot ?? node.className.toString().slice(0, 40)}> scrollWidth ${node.scrollWidth} > ${node.clientWidth} at ${Math.round(box.x)},${Math.round(box.y)}`)
          }
        }
      }

      const area = within ? document.querySelector(within)?.getBoundingClientRect() : null

      for (const button of document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]')) {
        if (!button.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
          continue
        }

        const box = button.getBoundingClientRect()

        if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) {
          continue
        }

        if (area && (box.right <= area.left || box.left >= area.right || box.bottom <= area.top || box.top >= area.bottom)) {
          continue
        }

        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)

        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          if (!text.textContent.trim() || !text.parentElement.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
            continue
          }

          const range = document.createRange()

          range.selectNodeContents(text)

          const rect = range.getBoundingClientRect()

          if (rect.width === 0) {
            continue
          }

          // The box the text is really allowed: the button, cut by every
          // clipping ancestor between the text and the button.
          let left = box.left
          let right = box.right
          let top = box.top
          let bottom = box.bottom
          let ellipsis = false

          for (let up = text.parentElement; up && up !== button.parentElement; up = up.parentElement) {
            const s = getComputedStyle(up)

            ellipsis ||= s.textOverflow === 'ellipsis'

            if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
              const b = up.getBoundingClientRect()

              left = Math.max(left, b.left)
              right = Math.min(right, b.right)
              top = Math.max(top, b.top)
              bottom = Math.min(bottom, b.bottom)
            }
          }

          const over = Math.max(left - rect.left, rect.right - right, top - rect.top, rect.bottom - bottom)

          if (over > 1) {
            const label = `"${text.textContent.trim().slice(0, 40)}" in <${button.tagName.toLowerCase()}${button.getAttribute('aria-label') ? ` "${button.getAttribute('aria-label')}"` : ''}> cut by ${Math.round(over)}px at ${Math.round(box.x)},${Math.round(box.y)}`

            ;(ellipsis ? out.truncated : out.clippedText).push(label)
          }
        }
      }

      return out
    },
    { within }
  )
}

// The window's content size and zoom. Sizes are the BrowserWindow's outer
// size; the page's own innerWidth follows from it and the zoom.
export async function setWindow({ height, width, zoom } = {}) {
  const { app, page } = state

  await app.evaluate(
    ({ BrowserWindow }, { height, width, zoom }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const bounds = win.getBounds()

      if (width || height) {
        win.setBounds({ ...bounds, height: height ?? bounds.height, width: width ?? bounds.width })
      }

      if (zoom) {
        win.webContents.setZoomFactor(zoom)
      }
    },
    { height, width, zoom }
  )
  await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))
  await sleep(250)

  return page.evaluate(() => ({ inner: `${innerWidth}x${innerHeight}`, zoom: +(outerWidth / innerWidth).toFixed(3) }))
}

// ── Performance ─────────────────────────────────────────────────────────────
// perf(fn) records the page while fn runs (scripts/rec-start.js and
// rec-stop.js, the same recorder scripts/probe.mjs uses) and returns:
//   secs, fps, frames, p50 / p95 / p99 / maxFrame (ms between frames),
//   slow32 / slow50 / slow100 / slow250 (frames over that many ms),
//   longtasks { n, total, top }, shifts { n, sum, noInput, top },
//   viewport { scrollNoInput, scrollNoInputMax, anchorNoInput,
//              anchorNoInputMax, gapMax, gapFramesOver2, gapRunMax, … },
//   animStarts / transStarts ([name @ owner, count]), events, value (fn's).
// "NoInput" means no wheel, key or pointer press in the 500 ms before.
const recorder = file => fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', file), 'utf8')

export async function perf(fn, { inputMs = 500 } = {}) {
  const { page } = state
  const start = recorder('rec-start.js')
  const stop = recorder('rec-stop.js')

  await page.evaluate(`(async () => { window.__mgRecOpts = ${JSON.stringify({ inputMs, snapshot: false })}; ${start}\n})()`)

  const began = Date.now()
  let value
  let failure = null

  try {
    value = await fn()
  } catch (error) {
    failure = error
  }

  const stats = await page.evaluate(`(async () => { ${stop}\n})()`)

  if (failure) {
    throw failure
  }

  return { ...stats, value, wallMs: Date.now() - began }
}

// The thresholds the stress suite fails on, stated up front (rig/README.md).
export const PERF_LIMITS = {
  // The reader's anchor (reading mode) or the bottom gap (pinned mode) may
  // move this many px in total without input.
  scrollPx: 2,
  // No single frame may take longer.
  frameMs: 100,
  // Long tasks, summed, per 10 s of recording.
  longTaskMsPer10s: 200,
  // Layout shifts not preceded by input.
  shiftsNoInput: 0
}

// Reasons a perf() record breaks PERF_LIMITS. `mode` says what the viewport
// should have done: 'reading' (stay put while scrolled up), 'pinned' (stay at
// the bottom), or null (not judged).
export function judgePerf(stats, { limits = {}, mode = null } = {}) {
  const limit = { ...PERF_LIMITS, ...limits }
  const why = []
  const per10 = stats.secs > 0 ? (stats.longtasks.total / stats.secs) * 10 : 0

  if (stats.maxFrame > limit.frameMs) {
    why.push(`a frame took ${stats.maxFrame} ms (limit ${limit.frameMs}); ${stats.slow100} frame(s) over 100 ms, p95 ${stats.p95} ms`)
  }

  if (per10 > limit.longTaskMsPer10s) {
    why.push(`long tasks ${stats.longtasks.total} ms in ${stats.secs} s = ${Math.round(per10)} ms per 10 s (limit ${limit.longTaskMsPer10s})`)
  }

  if (stats.shifts.noInput > limit.shiftsNoInput) {
    why.push(`${stats.shifts.noInput} layout shift(s) with no input before them (sum ${stats.shifts.sum}); first: ${JSON.stringify(stats.shifts.top[0])}`)
  }

  // What the reader sees is the anchor. scrollTop may change with no input
  // and nothing visible moving (the app compensating for rows added above),
  // so it is evidence, not the verdict.
  if (mode === 'reading' && stats.viewport.anchorNoInput > limit.scrollPx) {
    why.push(
      `the view moved with no input: the text being read moved ${stats.viewport.anchorNoInput} px in total (largest step ${stats.viewport.anchorNoInputMax}; scrollTop changed ${stats.viewport.scrollNoInput} px) (limit ${limit.scrollPx})`
    )
  }

  if (mode === 'pinned' && (stats.viewport.gapRunMax > 2 || stats.viewport.gapFinal > limit.scrollPx)) {
    why.push(
      `the view came off the bottom: gap up to ${stats.viewport.gapMax} px, ${stats.viewport.gapFramesOver2} frame(s) over 2 px, longest run ${stats.viewport.gapRunMax} frames, ${stats.viewport.gapFinal} px at the end`
    )
  }

  return why
}

// ── Hot reload ──────────────────────────────────────────────────────────────
// Hermes watches each <HERMES_HOME>/desktop-plugins/<name>/plugin.js with an
// fs watch (src/contrib/runtime-loader.ts, watchDiskPluginFile): a write to
// the same file reloads the plugin in place, disposing the previous
// registrations first. The file is rewritten in place (same inode; an atomic
// replace would orphan the watch) with a comment that makes it differ, and
// the reload is known to have happened when the plugin's stylesheet changes
// owner (register() stamps #mg-css with a fresh data-owner on every load).
let reloads = 0

//
// `source` is the file to put in place (the run's build by default). With
// `gone: true` the reload is known to have happened when the stylesheet and
// :root[data-mg-ready] are gone: for a stand-in plugin with the same id that
// registers nothing (stubPlugin()), to measure Hermes without Monograph.
export async function hotReload({ gone = false, source = PLUGIN, timeout = 30_000 } = {}) {
  const { page } = state
  const before = await page.evaluate(() => document.getElementById('mg-css')?.dataset.owner ?? null)
  const began = Date.now()

  reloads += 1
  fs.writeFileSync(state.installed, `${fs.readFileSync(source, 'utf8')}\n// rig hot reload ${reloads}\n`)
  await page.waitForFunction(
    ({ before, gone }) => {
      const style = document.getElementById('mg-css')

      if (gone) {
        return !style && !document.documentElement.dataset.mgReady
      }

      return Boolean(style && style.dataset.owner && style.dataset.owner !== before && document.documentElement.dataset.mgReady)
    },
    { before, gone },
    { polling: 50, timeout }
  )

  // The old instance's teardown runs on a 600 ms timer (plugin.js).
  await sleep(800)

  return { ms: Date.now() - began, reload: reloads }
}

// A plugin with Monograph's id that registers nothing: hot-loading it unloads
// Monograph the way Hermes would (its disposers run), so a suite can measure
// the same scenario on bare Hermes. hotReload() with the default source puts
// Monograph back.
export function stubPlugin() {
  const file = path.join(WORK, 'stub-plugin.js')

  fs.writeFileSync(file, "export default { id: 'monograph', name: 'Monograph (rig stand-in)', register() {} }\n")

  return file
}

// Build the plugin again from the staged sources (run.mjs stages a copy of
// the repo next to the sandbox), for a suite that changes a source first.
export function rebuildPlugin({ release = true } = {}) {
  const stage = path.dirname(path.dirname(PLUGIN))
  const run = spawnSync(process.execPath, ['build.mjs', ...(release ? ['--release'] : [])], {
    cwd: stage,
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: path.join(WORK, 'no-install') },
    timeout: 60_000
  })

  if (run.status !== 0) {
    throw new Error(`rebuild failed: ${run.stdout}${run.stderr}`)
  }

  return PLUGIN
}

// What the page holds that a leaky reload would grow: event listeners on the
// global targets (DevTools' own count, DOMDebugger.getEventListeners), live
// observer objects by kind (Runtime.queryObjects, after a garbage collection),
// observers that are observing right now and intervals that are running
// (counted by instrumentHooks() from the moment it was installed), the JS
// heap after a collection, and the number of elements.
export async function instrumentHooks() {
  await state.page.evaluate(() => {
    if (window.__mgRigHooks) {
      return
    }

    const hooks = { intervals: new Set(), observing: new Map() }

    window.__mgRigHooks = hooks

    for (const kind of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
      const proto = window[kind]?.prototype

      if (!proto) {
        continue
      }

      const observe = proto.observe
      const disconnect = proto.disconnect
      const unobserve = proto.unobserve

      proto.observe = function (target, ...rest) {
        const set = hooks.observing.get(this) ?? new Set()

        set.add(target)
        hooks.observing.set(this, set)
        set.kind = kind

        return observe.call(this, target, ...rest)
      }
      proto.disconnect = function () {
        hooks.observing.delete(this)

        return disconnect.call(this)
      }

      if (unobserve) {
        proto.unobserve = function (target) {
          const set = hooks.observing.get(this)

          set?.delete(target)

          if (set && !set.size) {
            hooks.observing.delete(this)
          }

          return unobserve.call(this, target)
        }
      }
    }

    const setInterval = window.setInterval
    const clearInterval = window.clearInterval

    window.setInterval = function (...args) {
      const id = setInterval.apply(this, args)

      hooks.intervals.add(id)

      return id
    }
    window.clearInterval = function (id) {
      hooks.intervals.delete(id)

      return clearInterval.call(this, id)
    }
  })
}

export async function measureHooks() {
  const { cdp, page } = state
  const listeners = {}

  for (const [label, expression] of [
    ['window', 'window'],
    ['document', 'document'],
    ['html', 'document.documentElement'],
    ['head', 'document.head'],
    ['body', 'document.body']
  ]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression })
    const found = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })
    const byType = {}

    for (const listener of found.listeners) {
      byType[listener.type] = (byType[listener.type] ?? 0) + 1
    }

    listeners[label] = { total: found.listeners.length, byType }
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => undefined)
  }

  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)

  const live = {}

  for (const kind of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver']) {
    const proto = await cdp.send('Runtime.evaluate', { expression: `${kind}.prototype` })

    if (!proto.result.objectId) {
      continue
    }

    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId })
    const count = await cdp.send('Runtime.callFunctionOn', { functionDeclaration: 'function () { return this.length }', objectId: objects.objectId, returnByValue: true })

    live[kind] = count.result.value
    await cdp.send('Runtime.releaseObject', { objectId: objects.objectId }).catch(() => undefined)
    await cdp.send('Runtime.releaseObject', { objectId: proto.result.objectId }).catch(() => undefined)
  }

  const page_ = await page.evaluate(() => {
    const hooks = window.__mgRigHooks
    const observing = {}

    for (const set of hooks?.observing.values() ?? []) {
      observing[set.kind] = (observing[set.kind] ?? 0) + 1
    }

    return {
      elements: document.getElementsByTagName('*').length,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      intervals: hooks ? hooks.intervals.size : null,
      observing: hooks ? observing : null
    }
  })

  return { listeners, liveObjects: live, ...page_ }
}

// ── Helpers asked for by the suites (additions) ─────────────────────────────
// quiet(limit, holdMs): no turn running anywhere in the page for holdMs in a
// row (default 3 s). Resolves true, or false when `limit` ms pass first.
export async function quiet(limit = 60_000, holdMs = 3000) {
  const started = Date.now()
  let since = Date.now()

  while (Date.now() - started < limit) {
    const busy = await state.page.evaluate(running => Boolean(document.querySelector(running)), RUNNING)

    if (busy) {
      since = Date.now()
    } else if (Date.now() - since >= holdMs) {
      return true
    }

    await sleep(200)
  }

  return false
}

// The stored id of the session on screen (from the route), or null.
export const currentSession = () => state.page.evaluate(() => (location.hash.match(/^#\/([^/?#]+)/)?.[1] ?? null))

// sessionSwitch(id): go to a session the way Hermes' own e2e suite does
// (apps/desktop/e2e/core/switch-back-race.spec.ts sets the hash), then wait
// until the route shows it and a thread is on screen. `id` '' or '/' goes to
// a new draft (#/). Returns { id, ms }.
export async function sessionSwitch(id, timeout = 15_000) {
  const target = String(id ?? '').replace(/^#?\/?/, '')
  const started = Date.now()

  await state.page.evaluate(target => {
    window.location.hash = `#/${target}`
  }, target)
  await state.page.waitForFunction(
    `(() => { const want = ${JSON.stringify(target)}; const now = location.hash.replace(/^#\\/?/, '').split(/[?#]/)[0]; return now === want && (want === '' || Boolean(${ON_SCREEN_VIEWPORT})) })()`,
    undefined,
    { polling: 100, timeout }
  )

  return { id: target, ms: Date.now() - started }
}

// setMotion('off' | 'on' | 'reduced' | 'no-preference') in the middle of a
// run: 'off'/'on' set Monograph's root attribute directly (no reload; the
// plugin writes it again on its next settings change), 'reduced' /
// 'no-preference' set the emulated media feature.
export async function setMotion(value) {
  if (value === 'reduced' || value === 'no-preference') {
    await state.cdp.send('Emulation.setEmulatedMedia', { features: value === 'reduced' ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] })
  } else {
    await state.page.evaluate(value => {
      document.documentElement.dataset.mgMotion = value
    }, value === 'off' ? 'off' : 'on')
  }
}

// A timeline trace of the main window while `fn` runs, summarised: how many
// frames the renderer began, fired animation frames, committed and drew, and
// where main-thread time went by event name, plus the scripts that ran (by
// function and url) and what fired them (timers, rAF callbacks, observers).
// For "is anything asking for frames at rest" questions (knowledge k7 with
// MG_KB_PROFILE=1). `categories` may add more trace categories.
export async function traceSummary(fn, { categories = [] } = {}) {
  const { cdp } = state
  const events = []
  const onData = data => events.push(...data.value)

  cdp.on('Tracing.dataCollected', onData)
  await cdp.send('Tracing.start', {
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.animations', ...categories].join(','),
    transferMode: 'ReportEvents'
  })

  const began = Date.now()
  let failure = null

  try {
    await fn()
  } catch (error) {
    failure = error
  }

  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))

  await cdp.send('Tracing.end')
  await complete
  cdp.off('Tracing.dataCollected', onData)

  if (failure) {
    throw failure
  }

  // The renderer's main thread: the thread with the most frame-start events.
  const threads = {}

  for (const event of events) {
    if (event.name === 'BeginMainThreadFrame' || event.name === 'FireAnimationFrame' || event.name === 'UpdateLayoutTree') {
      const key = `${event.pid}:${event.tid}`

      threads[key] = (threads[key] ?? 0) + 1
    }
  }

  const mainKey = Object.entries(threads).sort((x, y) => y[1] - x[1])[0]?.[0]
  const onMain = event => `${event.pid}:${event.tid}` === mainKey
  const count = {}
  const ms = {}
  const scripts = {}

  for (const event of events) {
    if (onMain(event) || /Frame|Draw|Swap|Composit/.test(event.name)) {
      count[event.name] = (count[event.name] ?? 0) + 1

      if (event.ph === 'X' && event.dur) {
        ms[event.name] = +((ms[event.name] ?? 0) + event.dur / 1000).toFixed(1)
      }
    }

    if (onMain(event) && ['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'ResizeObserver::Callback', 'IntersectionObserverController::computeIntersections', 'v8.callFunction'].includes(event.name)) {
      const data = event.args?.data ?? {}
      const key = `${event.name} ${data.functionName ?? data.type ?? ''} ${String(data.url ?? '').split('/').pop()}:${data.lineNumber ?? ''}`.trim()

      scripts[key] = (scripts[key] ?? 0) + 1
    }
  }

  // Every event by name, all threads: what there was when no frame began.
  const anyName = {}

  for (const event of events) {
    if (event.ph !== 'M') {
      anyName[event.name] = (anyName[event.name] ?? 0) + 1
    }
  }

  const keep = names => Object.fromEntries(Object.entries(count).filter(([name]) => names.test(name)).sort((x, y) => y[1] - x[1]))
  const secs = (Date.now() - began) / 1000

  return {
    secs: +secs.toFixed(1),
    frames: keep(/^(BeginFrame|BeginMainThreadFrame|FireAnimationFrame|RequestAnimationFrame|Commit|DrawFrame|NeedsBeginFrameChanged|PipelineReporter|Animation|Paint|Layout|UpdateLayoutTree|PrePaint|Layerize|Screenshot)$/),
    mainMs: Object.fromEntries(Object.entries(ms).sort((x, y) => y[1] - x[1]).slice(0, 14)),
    scripts: Object.fromEntries(Object.entries(scripts).sort((x, y) => y[1] - x[1]).slice(0, 16)),
    animations: Object.entries(
      events
        .filter(event => event.cat?.includes('blink.animations') && event.ph === 'b')
        .reduce((all, event) => ({ ...all, [event.args?.data?.name ?? event.name]: (all[event.args?.data?.name ?? event.name] ?? 0) + 1 }), {})
    ).slice(0, 12),
    events: events.length,
    mainThreadFound: Boolean(mainKey),
    byName: Object.fromEntries(Object.entries(anyName).sort((x, y) => y[1] - x[1]).slice(0, 14))
  }
}
