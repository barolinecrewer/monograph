#!/usr/bin/env node
/**
 * Monograph doctor: after a Hermes update, find out what broke.
 *
 * Hermes ships no stable class contract, so every selector we write leans on
 * a hook in the app's own markup (data-slot, aria-label, a utility class).
 * This reads the hooks out of our CSS (src/css, add-ons included) and out of
 * the selector strings in our JS (src/plugin.js, src/modules/*.js), and checks
 * each one still exists in the Hermes desktop source. Nothing is
 * hand-maintained except selectors.json, which lists hooks our own code
 * creates and hooks that are built at runtime and need a different search
 * string.
 *
 *   node scripts/doctor.mjs                  report, exit 1 if a hook is gone
 *   node scripts/doctor.mjs --json           machine-readable
 *   node scripts/doctor.mjs --write          also record the result in selectors.lock.json
 *   node scripts/doctor.mjs --own '<hook>'   register a hook our own code creates
 *                                            (an attribute name, or a full key
 *                                            as the report prints it), then check
 *
 * Exit codes: 0 every hook found, 1 some missing, 2 no Hermes source to check.
 *
 * Hermes source: MG_HERMES_REPO, else $HERMES_HOME/hermes-agent, else
 * ~/.hermes/hermes-agent. Hooks that start with mg-, mf-, bb- or monograph
 * are ours and need no entry: class names, data-mg-* attributes, and
 * attribute values such as data-tour="mg-surfaces".
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const args = new Set(argv)
const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
const repo = path.resolve(process.env.MG_HERMES_REPO || path.join(home, 'hermes-agent'))
const appSrc = path.join(repo, 'apps', 'desktop', 'src')
const selectorsFile = path.join(root, 'selectors.json')
const config = JSON.parse(fs.readFileSync(selectorsFile, 'utf8'))
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// selectors.json is always written in one shape: sorted, one entry per line,
// so hooks registered on different branches merge without conflicts.
const writeSelectors = next => {
  const own = [...new Set(next.own ?? [])].sort(byText)
  const overrides = Object.entries(next.overrides ?? {}).sort(([a], [b]) => byText(a, b))
  const list = (items, indent) => items.map(item => indent + item).join(',\n')

  fs.writeFileSync(
    selectorsFile,
    [
      '{',
      `  "//": ${JSON.stringify(next['//'] ?? '')},`,
      '  "own": [',
      list(own.map(item => JSON.stringify(item)), '    '),
      '  ],',
      '  "overrides": {',
      list(overrides.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`), '    '),
      '  }',
      '}'
    ]
      .filter(line => line !== '')
      .join('\n') + '\n'
  )
}

for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--own') {
    const hook = argv[index + 1]

    if (!hook || hook.startsWith('--')) {
      console.error('doctor: --own needs a hook, e.g. --own \'[data-tour="my-thing"]\' or --own data-my-attr')
      process.exit(2)
    }

    config.own = [...(config.own ?? []), hook]
    writeSelectors(config)
    console.log(`registered ${hook} as our own in selectors.json`)
  }
}

const walk = (dir, keep, out = []) => {
  if (!fs.existsSync(dir)) {
    return out
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byText(a.name, b.name))) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      walk(full, keep, out)
    } else if (keep(entry.name)) {
      out.push(full)
    }
  }

  return out
}

// ── 1. Hooks we depend on, read from our own selectors ──────────────────────
const OWN_PREFIX = /^(mf-|bb-|mg-|monograph)/
const OWN_ATTR = /^data-(mf|bb|mg)-/
const GENERIC_ATTR = new Set([
  'role', 'type', 'inert', 'aria-hidden', 'aria-checked', 'aria-selected', 'data-state', 'data-active'
])
const own = new Set(config.own ?? [])

const hooks = new Map() // key -> { kind, needle, files:Set }

const add = (key, kind, needle, file) => {
  if (!hooks.has(key)) {
    hooks.set(key, { kind, needle, files: new Set() })
  }

  hooks.get(key).files.add(file)
}

// Every hook in one selector, or selector list.
const readSelector = (selector, rel) => {
  for (const [, attr, op, value] of selector.matchAll(/\[([a-zA-Z-]+)\s*([\^$*~|]?=)\s*["']([^"']*)["'](?:\s+i)?\]/g)) {
    const key = `[${attr}${op}"${value}"]`

    if (OWN_ATTR.test(attr) || GENERIC_ATTR.has(attr) || own.has(attr) || own.has(key) || OWN_PREFIX.test(value)) {
      continue
    }

    add(key, attr, value, rel)
  }

  for (const [, attr] of selector.matchAll(/\[([a-zA-Z-]+)\]/g)) {
    if (OWN_ATTR.test(attr) || OWN_PREFIX.test(attr) || GENERIC_ATTR.has(attr) || own.has(attr) || own.has(`[${attr}]`)) {
      continue
    }

    add(`[${attr}]`, 'attr', attr, rel)
  }

  const bare = selector.replace(/\[[^\]]*\]/g, '')

  for (const [, raw] of bare.matchAll(/\.((?:[a-zA-Z_]|\\.)(?:[\w-]|\\.)*)/g)) {
    const name = raw.replace(/\\(.)/g, '$1')

    if (!OWN_PREFIX.test(name) && !own.has(`.${name}`)) {
      add(`.${name}`, 'class', name, rel)
    }
  }
}

const cssFiles = walk(path.join(root, 'src', 'css'), name => name.endsWith('.css'))

for (const file of cssFiles) {
  const rel = path.relative(root, file)
  const css = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\("[^"]*"\)/g, 'url()')

  for (const [, prelude] of css.matchAll(/([^{}]+)\{/g)) {
    const selector = prelude.trim()

    if (!selector || selector.startsWith('@') || /^(from|to|[\d.,%\s]+)$/.test(selector)) {
      continue
    }

    readSelector(selector, rel)
  }
}

// JS: every string literal that reads as a selector. A template literal is
// split at its ${…} holes and each piece is read on its own. Labels, messages
// and bare class names (no leading dot) carry no [attr…] and no .name at a
// selector position, so they add nothing.
const jsFiles = [path.join(root, 'src', 'plugin.js'), ...walk(path.join(root, 'src', 'modules'), name => name.endsWith('.js'))].filter(file =>
  fs.existsSync(file)
)

const looksLikeSelector = text =>
  /\[[a-zA-Z-]+(?:\s*[\^$*~|]?=\s*["'][^"']*["'](?:\s+i)?)?\]/.test(text) ||
  /^\s*(?::scope\s*)?(?:[>+~]\s*)?(?:a|button|div|i|input|li|p|span|svg|time|ul)?\.[a-zA-Z_][\w-]*(?:[\s>+~,:.[)]|$)/.test(text)

for (const file of jsFiles) {
  const rel = path.relative(root, file)
  const source = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

  for (const [, quote, body] of source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*?)\1/g)) {
    for (const raw of quote === '`' ? body.split(/\$\{[^}]*\}/) : [body]) {
      const text = raw.replace(/\\(["'`\\])/g, '$1')

      if (looksLikeSelector(text)) {
        readSelector(text, rel)
      }
    }
  }
}

// ── 2. The Hermes desktop source, as one haystack ───────────────────────────
if (!fs.existsSync(appSrc)) {
  console.error(`doctor: no desktop source at ${appSrc}. Set MG_HERMES_REPO to a Hermes checkout to check against it.`)
  process.exit(2)
}

const haystack = walk(appSrc, name => /\.(tsx?|css|json)$/.test(name) && !/\.test\./.test(name))
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n')

const git = (...gitArgs) => {
  try {
    return execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// ── 3. Check ────────────────────────────────────────────────────────────────
const overrides = config.overrides ?? {}

// Codicons are classes Hermes builds at runtime from a name
// (<Codicon name="list-filter" />  ->  class="codicon codicon-list-filter"),
// so the class never appears in the source as written; its name does.
const needlesFor = (key, hook) => {
  if (overrides[key]) {
    return [overrides[key]]
  }

  const codicon = hook.kind === 'class' ? hook.needle.match(/^codicon-(.+)$/)?.[1] : null

  return codicon
    ? [hook.needle, `name="${codicon}"`, `name: '${codicon}'`, `icon: '${codicon}'`, `icon="${codicon}"`]
    : [hook.needle]
}

const missing = []

for (const [key, hook] of [...hooks].sort(([a], [b]) => byText(a, b))) {
  const needles = needlesFor(key, hook)

  if (!needles.some(needle => haystack.includes(needle))) {
    missing.push({ hook: key, searched: needles.join(' | '), usedIn: [...hook.files].sort(byText) })
  }
}

// No timestamp: the lock changes only when the result does, so branches that
// ran the doctor against the same Hermes agree on it.
const result = {
  hermes: { commit: git('rev-parse', '--short', 'HEAD'), date: git('log', '-1', '--format=%ad', '--date=short') },
  sources: { css: cssFiles.length, js: jsFiles.length },
  hooks: hooks.size,
  missing
}

if (args.has('--write')) {
  fs.writeFileSync(path.join(root, 'selectors.lock.json'), JSON.stringify(result, null, 2) + '\n')
}

if (args.has('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(
    `Hermes ${result.hermes.commit || '(not a git checkout)'} (${result.hermes.date || 'no date'}): ${hooks.size} hooks checked, ${missing.length} missing`
  )

  for (const item of missing) {
    console.log(`  MISSING ${item.hook}  (searched "${item.searched}")  used in ${item.usedIn.join(', ')}`)
  }

  if (missing.length) {
    console.log("  A hook our own code creates is not a miss: register it with  node scripts/doctor.mjs --own '<hook>'")
  }
}

process.exit(missing.length ? 1 : 0)
