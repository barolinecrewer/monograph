#!/usr/bin/env node
/**
 * Monograph test rig. No dependencies of its own: Playwright and Electron come
 * from the Hermes checkout.
 *
 *   node rig/run.mjs            build (release), launch a sandboxed Hermes, run the core suite
 *   node rig/run.mjs --suite X  run rig/suites/X.mjs instead (one app launch per suite)
 *   node rig/run.mjs --all      run every suite, one after the other, and sum up
 *   node rig/run.mjs --local    build with config.local.json (your name ends up in screenshots)
 *   node rig/run.mjs --simple   run Hermes in its Simple interface mode (default: Advanced, as a new profile)
 *   node rig/run.mjs --keep     leave the sandbox on disk afterwards, for a post-mortem
 *   node rig/run.mjs --verbose  also print Playwright's own output
 *   node rig/run.mjs --repeat N run the suite (or, with --all, every suite) N times and
 *                               report flaky checks (passed in some runs, failed in
 *                               others) apart from failing ones
 *   node rig/run.mjs --lint     no app: node --check on every rig file and build.mjs, a
 *                               release build checked, duplicate check ids in a suite
 *
 *   MG_RIG_HERMES_REPO   Hermes checkout          (default ~/.hermes/hermes-agent)
 *   MG_RIG_OUT           screenshots, logs, temp  (default ~/.hermes/cache/scratch/mg-rig)
 *   MG_RIG_LIMIT_S       seconds before a run is killed (default 600)
 *
 * Nothing is written into the Hermes checkout, the real HERMES_HOME (outside
 * MG_RIG_OUT) or this repo. Exit code: 0 all checks passed, 1 a check failed or
 * did not run, 2 the rig itself broke.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const rig = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(rig)
const argv = process.argv.slice(2)
const suites = fs
  .readdirSync(path.join(rig, 'suites'))
  .filter(file => file.endsWith('.mjs'))
  .map(file => file.slice(0, -4))
  .sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)))
let suite = 'core'

let repeat = 0
// `--motion off|reduced`: run with Monograph's motion setting off, or under
// emulated reduced motion (rig/harness.mjs, MOTION).
let motion = ''

// "--suite X" and "--suite=X" both name the suite, "--repeat N" and
// "--repeat=N" the number of runs; the rest are switches.
for (let index = argv.length - 1; index >= 0; index--) {
  const [flag, inline] = argv[index].split('=')

  if (flag === '--suite') {
    suite = inline ?? argv[index + 1] ?? ''
    argv.splice(index, inline === undefined ? 2 : 1)
  } else if (flag === '--motion') {
    motion = inline ?? argv[index + 1] ?? ''
    argv.splice(index, inline === undefined ? 2 : 1)

    if (!['off', 'reduced'].includes(motion)) {
      console.error('rig: --motion takes off or reduced')
      process.exit(2)
    }
  } else if (flag === '--repeat') {
    repeat = Number(inline ?? argv[index + 1])
    argv.splice(index, inline === undefined ? 2 : 1)

    if (!Number.isInteger(repeat) || repeat < 1) {
      console.error('rig: --repeat takes a whole number of runs, 1 or more')
      process.exit(2)
    }
  }
}

const args = new Set(argv)
const realHome = path.resolve(process.env.MG_RIG_REAL_HERMES_HOME || path.join(os.homedir(), '.hermes'))
const hermesRepo = path.resolve(process.env.MG_RIG_HERMES_REPO || path.join(realHome, 'hermes-agent'))
const out = path.resolve(process.env.MG_RIG_OUT || path.join(realHome, 'cache', 'scratch', 'mg-rig'))
// A suite may ask for more time with `export const limitS = <seconds>`; an
// explicit MG_RIG_LIMIT_S wins.
const suiteLimit = () => {
  try {
    return Number(fs.readFileSync(path.join(rig, 'suites', `${suite}.mjs`), 'utf8').match(/^export const limitS = (\d+)/m)?.[1] ?? 0)
  } catch {
    return 0
  }
}
const RUN_LIMIT_MS = Number(process.env.MG_RIG_LIMIT_S || suiteLimit() || 600) * 1000

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
// Two runs started in the same second must not share a folder: the second
// one takes the next free name (made in place, so the claim is atomic).
// Only a run that launches the app claims one (see below).
let evidence = path.join(out, stamp)
const claimEvidence = () => {
  fs.mkdirSync(out, { recursive: true })

  for (let n = 1; ; n += 1) {
    try {
      fs.mkdirSync(evidence)

      return
    } catch (error) {
      if (error.code !== 'EEXIST' || n > 50) {
        throw error
      }

      evidence = path.join(out, `${stamp}-${n}`)
    }
  }
}
// Short on purpose: the sandbox HERMES_HOME lives below it, and long paths are
// one more thing that could differ from a normal launch.
const work = path.join(out, `t-${crypto.randomBytes(3).toString('hex')}`)

const say = line => console.log(line)

const die = message => {
  console.error(`rig: ${message}`)
  process.exit(2)
}

// ── Lint (--lint): merge safety, no app launched ────────────────────────────
// `node --check` on every rig and suite file and on build.mjs, a release build
// into a temporary folder and `node --check` on that, and a duplicate check id
// inside one suite's `checks` list fails. (A merge once left a duplicate
// import that broke four suites at load; node --check catches that.)
if (args.has('--lint')) {
  const problems = []
  const files = [
    ...fs.readdirSync(rig).filter(file => file.endsWith('.mjs')).map(file => path.join(rig, file)),
    ...suites.map(name => path.join(rig, 'suites', `${name}.mjs`)),
    path.join(repo, 'build.mjs'),
    ...['scripts'].flatMap(dir => fs.readdirSync(path.join(repo, dir)).filter(file => /\.m?js$/.test(file) && !/^rec-/.test(file)).map(file => path.join(repo, dir, file)))
  ]

  for (const file of files) {
    const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })

    if (run.status !== 0) {
      problems.push(`${path.relative(repo, file)}: node --check failed\n${(run.stderr || run.stdout).trim().split('\n').slice(0, 6).join('\n')}`)
    }
  }

  for (const name of suites) {
    const text = fs.readFileSync(path.join(rig, 'suites', `${name}.mjs`), 'utf8')
    const block = text.match(/^export const checks = \[([\s\S]*?)^\]/m)?.[1]

    if (!block) {
      problems.push(`rig/suites/${name}.mjs: no \`export const checks = [ … ]\` list`)
      continue
    }

    // The list itself is evaluated, alone: a missing comma between two
    // entries (\`['x', '…'] ['y', '…']\`) is valid syntax, an index into the
    // first entry, and only breaks the suite when it runs ("not iterable").
    let list = null

    try {
      list = vm.runInNewContext(`[${block}]`, Object.create(null), { timeout: 1000 })
    } catch (error) {
      problems.push(`rig/suites/${name}.mjs: the \`checks\` list does not evaluate on its own (${error.message})`)
      continue
    }

    const broken = list.findIndex(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string')

    if (broken >= 0) {
      problems.push(`rig/suites/${name}.mjs: entry ${broken + 1} of the \`checks\` list is not [id, title] (${JSON.stringify(list[broken]) ?? String(list[broken])}): a missing comma?`)
      continue
    }

    const ids = list.map(([id]) => id)
    const seen = new Set()

    for (const id of ['a', ...ids]) {
      if (seen.has(id)) {
        problems.push(`rig/suites/${name}.mjs: check id ${JSON.stringify(id)} is listed twice${id === 'a' ? ' (a is the boot check)' : ''}`)
      }

      seen.add(id)
    }
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-lint-'))

  try {
    for (const item of ['build.mjs', 'package.json', 'src']) {
      fs.cpSync(path.join(repo, item), path.join(stage, item), { recursive: true })
    }

    const build = spawnSync(process.execPath, ['build.mjs', '--release'], { cwd: stage, encoding: 'utf8', env: { ...process.env, HERMES_HOME: path.join(stage, 'no-install') } })

    if (build.status !== 0) {
      problems.push(`build.mjs --release failed\n${(build.stderr || build.stdout).trim().split('\n').slice(0, 6).join('\n')}`)
    } else {
      const check = spawnSync(process.execPath, ['--check', path.join(stage, 'dist', 'plugin.js')], { encoding: 'utf8' })

      if (check.status !== 0) {
        problems.push(`dist/plugin.js: node --check failed\n${check.stderr.trim().split('\n').slice(0, 6).join('\n')}`)
      }
    }
  } finally {
    fs.rmSync(stage, { force: true, recursive: true })
  }

  say(`lint: ${files.length} files checked, ${suites.length} suites' check ids, one release build`)
  problems.forEach(problem => say(`  FAIL ${problem}`))
  say(problems.length ? `lint: ${problems.length} problem(s)` : 'lint: clean')
  process.exit(problems.length ? 1 : 0)
}

// ── Preflight ───────────────────────────────────────────────────────────────
for (const arg of args) {
  if (!['--all', '--keep', '--local', '--lint', '--simple', '--verbose'].includes(arg)) {
    die(`unknown option ${arg}`)
  }
}

if (!suites.includes(suite)) {
  die(`no suite ${JSON.stringify(suite)}. Suites: ${suites.join(', ')}`)
}

// ── Every suite, and repeats ────────────────────────────────────────────────
// One child run per suite and per repeat: each gets its own sandbox, app and
// evidence folder. The children are this script again, without --all and
// --repeat, so they hold the same lock slot as this run.
const child = name => {
  const flags = [...argv.filter(arg => arg !== '--all'), ...(motion ? ['--motion', motion] : [])]
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--suite', name, ...flags], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const dir = text.match(/^rig: evidence (.*)$/m)?.[1]?.trim()
  let checks = {}

  try {
    checks = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')).checks ?? {}
  } catch {
    // The run never wrote one; its result line says why.
  }

  process.stdout.write(text)

  return { checks, dir: dir ?? null, result: text.match(/^result:\s+(.*)$/m)?.[1] ?? `no result line (exit ${run.status})`, status: run.status ?? 2 }
}

if (args.has('--all') || repeat) {
  // A suite of a private add-on (it says so with `export const addon`) needs
  // that add-on's styles, which only a --local build carries: --all leaves it
  // out of a release run.
  const addon = name => /^export const addon = /m.test(fs.readFileSync(path.join(rig, 'suites', `${name}.mjs`), 'utf8'))
  const names = args.has('--all') ? suites.filter(name => args.has('--local') || !addon(name)) : [suite]
  const runs = Math.max(1, repeat)
  // suite -> check id -> { title, statuses[], dirs[] }
  const table = new Map()
  const lines = []
  let worst = 0

  for (const name of names) {
    const rows = new Map()

    table.set(name, rows)

    for (let round = 1; round <= runs; round++) {
      say(`\n━━ suite ${name}${runs > 1 ? `, run ${round} of ${runs}` : ''} ━━`)

      const run = child(name)

      lines.push(`${name.padEnd(14)}${runs > 1 ? ` run ${round}` : ''} ${run.result}  ${run.dir ?? ''}`)
      worst = Math.max(worst, run.status === 1 ? 1 : run.status)

      for (const [id, entry] of Object.entries(run.checks)) {
        const row = rows.get(id) ?? { dirs: [], statuses: [], title: entry.title ?? '' }

        row.statuses.push(entry.status ?? 'not run')
        row.dirs.push(run.dir)
        rows.set(id, row)
      }
    }
  }

  // One table across suites. A check is "flaky" when it passed in some runs
  // and not in others, "FAIL" when it passed in none.
  say('\n━━ all checks ━━')
  say(`${'suite'.padEnd(10)} ${'check'.padEnd(6)} ${'verdict'.padEnd(8)} ${runs > 1 ? 'runs'.padEnd(runs * 2 + 2) : ''}title`)

  const flaky = []
  const failing = []

  for (const [name, rows] of table) {
    for (const [id, row] of rows) {
      const passed = row.statuses.filter(status => status === 'pass').length
      const verdict = passed === row.statuses.length ? 'pass' : passed === 0 ? 'FAIL' : 'flaky'
      const marks = row.statuses.map(status => (status === 'pass' ? 'P' : status === 'fail' ? 'F' : '-')).join(' ')

      say(`${name.padEnd(10)} ${id.padEnd(6)} ${verdict.padEnd(8)} ${runs > 1 ? marks.padEnd(runs * 2 + 2) : ''}${row.title}`)

      if (verdict === 'flaky') {
        flaky.push(`${name}/${id} (${passed} of ${row.statuses.length} passed)`)
      } else if (verdict === 'FAIL') {
        failing.push(`${name}/${id}`)
      }
    }
  }

  say('\n━━ runs ━━')
  lines.forEach(line => say(line))
  say(`failing:  ${failing.length ? failing.join(', ') : 'none'}`)

  if (runs > 1) {
    say(`flaky:    ${flaky.length ? flaky.join(', ') : 'none'}`)
  }

  // A rig break (exit 2) wins; otherwise any check that did not pass every
  // time, flaky or failing, makes the exit code 1.
  const code = worst >= 2 ? worst : failing.length || flaky.length ? 1 : worst

  say(`overall:  ${code === 0 ? 'every check passed in every run' : code === 1 ? 'some checks failed' : 'the rig broke in at least one run'}`)
  process.exit(code)
}

const desktop = path.join(hermesRepo, 'apps', 'desktop')
const playwright = path.join(hermesRepo, 'node_modules', '@playwright', 'test', 'cli.js')

for (const file of [
  path.join(desktop, 'dist', 'electron-main.mjs'),
  path.join(desktop, 'dist', 'index.html'),
  path.join(desktop, 'e2e', 'fixtures.ts'),
  path.join(hermesRepo, 'tests-js', 'scripts', 'mock-server.ts'),
  playwright
]) {
  if (!fs.existsSync(file)) {
    die(`missing ${file}. The rig never builds or installs inside the Hermes checkout; fix that there first.`)
  }
}

claimEvidence()
fs.mkdirSync(path.join(evidence, 'shots'), { recursive: true })
fs.mkdirSync(path.join(work, 'tmp'), { recursive: true })

// ── Build ───────────────────────────────────────────────────────────────────
// Built from a copy of the sources inside the work dir, so the repo's own
// dist/plugin.js (your local build) is neither read nor replaced, and a build
// someone else starts in the repo at the same moment cannot leak into the run.
const stage = path.join(work, 'build')
const skip = new Set(['.git', 'node_modules', 'dist', 'shots', 'legacy', 'rig', '.DS_Store'])

if (!args.has('--local')) {
  skip.add('config.local.json')
}

fs.cpSync(repo, stage, {
  recursive: true,
  filter: source => !path.relative(repo, source).split(path.sep).some(part => skip.has(part))
})

const built = spawnSync(process.execPath, ['build.mjs', ...(args.has('--local') ? [] : ['--release'])], {
  cwd: stage,
  encoding: 'utf8',
  // build.mjs only installs when asked to; this keeps even a mistake in the sandbox.
  env: { ...process.env, HERMES_HOME: path.join(work, 'no-install') },
  timeout: 60_000
})

if (built.status !== 0) {
  fs.rmSync(work, { recursive: true, force: true })
  die(`build failed:\n${built.stdout}${built.stderr}`)
}

const plugin = path.join(stage, 'dist', 'plugin.js')
const pluginSha = crypto.createHash('sha256').update(fs.readFileSync(plugin)).digest('hex')

say(`rig: ${built.stdout.trim().split('\n')[0]}  sha256 ${pluginSha.slice(0, 12)}`)
say(`rig: suite ${suite}, Hermes interface mode ${args.has('--simple') ? 'simple' : 'advanced'}${motion ? `, motion ${motion}` : ''}`)
say(`rig: evidence ${evidence}`)

// ── Run ─────────────────────────────────────────────────────────────────────
const env = {
  ...process.env,
  MG_RIG_EVIDENCE: evidence,
  MG_RIG_HERMES_REPO: hermesRepo,
  MG_RIG_KEEP: args.has('--keep') ? '1' : '',
  MG_RIG_LIMIT_S: String(RUN_LIMIT_MS / 1000),
  MG_RIG_MODE: args.has('--simple') ? 'simple' : 'advanced',
  MG_RIG_MOTION: motion,
  MG_RIG_PLUGIN: plugin,
  MG_RIG_REAL_HERMES_HOME: realHome,
  MG_RIG_SUITE: suite,
  MG_RIG_WORK: work,
  // Playwright's compile cache would otherwise land beside the sandbox's parent.
  PWTEST_CACHE_DIR: path.join(out, 'pw-cache'),
  // Hermes' fixtures make the sandbox with os.tmpdir().
  TEMP: path.join(work, 'tmp'),
  TMP: path.join(work, 'tmp'),
  TMPDIR: path.join(work, 'tmp')
}

delete env.CI

const log = fs.createWriteStream(path.join(evidence, 'playwright.log'))

const runner = spawn(process.execPath, [playwright, 'test', '--config', path.join(rig, 'playwright.config.mjs')], {
  cwd: rig,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

fs.writeFileSync(path.join(evidence, 'runner.pid'), String(runner.pid))
runner.stdout.pipe(log, { end: false })
runner.stderr.pipe(log, { end: false })

if (args.has('--verbose')) {
  runner.stdout.pipe(process.stdout)
  runner.stderr.pipe(process.stderr)
}

let timedOut = false

const limit = setTimeout(() => {
  timedOut = true
  runner.kill('SIGKILL')
}, RUN_LIMIT_MS)

const code = await new Promise(resolve => runner.on('close', resolve))

clearTimeout(limit)
log.end()

// ── Leftovers ───────────────────────────────────────────────────────────────
// Anything still alive that was started for this run inherited the work dir in
// its environment (HERMES_HOME, HOME, TMPDIR) or was handed it as its profile
// (--user-data-dir). A process that merely names the path, say a `tail` on a
// log, does not match. Only pids are read out of the listing: other processes'
// environments hold secrets and are never printed.
const mine = [
  ...['HERMES_HOME', 'HOME', 'TMPDIR', 'HERMES_DESKTOP_USER_DATA_DIR', 'MG_RIG_WORK'].map(name => `${name}=${work}`),
  `--user-data-dir=${work}`
]

const ours = () =>
  String(spawnSync('ps', ['-axEww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 << 20 }).stdout ?? '')
    .split('\n')
    .filter(line => mine.some(mark => line.includes(mark)))
    .map(line => Number(line.trim().split(/\s+/)[0]))
    .filter(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stragglers = ours()

for (const signal of ['SIGTERM', 'SIGKILL']) {
  const left = ours()

  if (!left.length) {
    break
  }

  for (const pid of left) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }

  await sleep(signal === 'SIGTERM' ? 3000 : 500)
}

const survivors = ours()

if (!args.has('--keep')) {
  fs.rmSync(work, { recursive: true, force: true })
}

// ── Report ──────────────────────────────────────────────────────────────────
let results = null

try {
  results = JSON.parse(fs.readFileSync(path.join(evidence, 'results.json'), 'utf8'))
} catch {
  // The spec never got as far as writing one.
}

const checks = results?.checks ?? {}
// The spec declares its checks before anything runs, so the order is theirs.
const order = Object.keys(checks).length ? Object.keys(checks) : ['a']
const short = value => JSON.stringify(value)

say('')

for (const id of order) {
  const entry = checks[id] ?? { status: 'not run', title: '', why: ['the run ended before this check'] }

  say(`${id}  ${entry.status.toUpperCase().padEnd(7)}  ${entry.title ?? ''}${entry.ms ? `  (${(entry.ms / 1000).toFixed(1)}s)` : ''}`)

  for (const [key, value] of Object.entries(entry.evidence ?? {})) {
    say(`     ${key}: ${short(value)}`)
  }

  for (const reason of entry.why ?? []) {
    say(`     WHY: ${reason}`)
  }

  if (entry.error) {
    say(`     ERROR: ${entry.error.split('\n').slice(0, 4).join('\n            ')}`)
  }

  for (const shot of entry.screenshots ?? []) {
    say(`     screenshot: ${shot}`)
  }
}

say('')

for (const seen of results?.observations ?? []) {
  say(`observed: ${seen}`)
}

for (const note of results?.notes ?? []) {
  say(`note: ${note}`)
}

if (results?.setupError) {
  say(`setup error: ${results.setupError.split('\n').slice(0, 6).join('\n  ')}`)
}

say(`processes: ${stragglers.length ? `${stragglers.length} left after teardown (pids ${stragglers.join(', ')}), stopped by the rig` : 'none left after teardown'}${survivors.length ? `; STILL ALIVE: ${survivors.join(', ')}` : ''}`)
say(`sandbox:   ${args.has('--keep') ? `kept at ${work}` : fs.existsSync(work) ? `COULD NOT REMOVE ${work}` : 'removed'}`)
say(`playwright exit ${timedOut ? `killed after ${RUN_LIMIT_MS / 1000}s` : code}; log ${path.join(evidence, 'playwright.log')}`)

const statuses = order.map(id => checks[id]?.status ?? 'not run')
const passed = statuses.filter(status => status === 'pass').length

say(`result:    ${passed}/${order.length} passed${passed === order.length ? '' : ` (${order.map((id, index) => `${id}=${statuses[index]}`).join(' ')})`}`)

process.exit(!results || survivors.length ? 2 : passed === order.length ? 0 : 1)
