#!/usr/bin/env node
/**
 * Monograph probe: run a snippet inside the live Hermes renderer and print
 * what it returns. Development tool, never part of a release.
 *
 *   node scripts/probe.mjs path/to/snippet.js [--delay 1500] [--wait 25000] [--keep]
 *   echo "return document.title" | node scripts/probe.mjs -
 *
 * The snippet is the body of `async (ctx, $, $$, sdk) => { ... }` and must return
 * something JSON-serialisable. `$`/`$$` are querySelector/All (array).
 *
 * How: installs a throwaway desktop plugin (`monograph-probe`) carrying the
 * snippet. Hermes hot-loads it, it writes the result to its own plugin data
 * folder, we read that back and remove the plugin. No devtools needed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(name)

  return i === -1 ? null : (argv.splice(i, 2)[1] ?? '')
}
const delay = Number(flag('--delay') ?? 1200)
const wait = Number(flag('--wait') ?? 25000)
const keep = argv.includes('--keep')
const source = argv.find(a => !a.startsWith('--'))

if (!source) {
  console.error('usage: probe.mjs <snippet.js | -> [--delay ms] [--keep]')
  process.exit(2)
}

const body = fs.readFileSync(source === '-' ? 0 : source, 'utf8')
const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
const id = 'monograph-probe'
const pluginDir = path.join(home, 'desktop-plugins', id)
const pluginFile = path.join(pluginDir, 'plugin.js')
const userData =
  process.env.HERMES_USER_DATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Hermes')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Hermes')
      : path.join(os.homedir(), '.config', 'Hermes'))
const dataDir = path.join(userData, 'plugin-files', 'data', id)
const nonce = Date.now().toString(36)
const outName = `out-${nonce}.json`
const outFile = path.join(dataDir, outName)

const plugin = `// Throwaway probe ${nonce}. Safe to delete.
import * as sdk from '@hermes/plugin-sdk'
export default {
  id: ${JSON.stringify(id)},
  name: 'Monograph probe',
  register(ctx) {
    const $ = (s, r = document) => r.querySelector(s)
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s))
    const run = async () => {
      let out
      try {
        out = { ok: true, value: await (async (ctx, $, $$, sdk) => {
${body}
        })(ctx, $, $$, sdk) }
      } catch (error) {
        out = { ok: false, error: String((error && error.stack) || error) }
      }
      let text
      try { text = JSON.stringify(out, null, 1) } catch (error) { text = JSON.stringify({ ok: false, error: 'unserialisable: ' + error }) }
      if (text === undefined) text = JSON.stringify({ ok: true, value: null })
      await ctx.files.writeText('data', ${JSON.stringify(outName)}, text)
    }
    ctx.setTimeout(run, ${delay})
  }
}
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

fs.mkdirSync(pluginDir, { recursive: true })
// Write in place: Hermes' hot reload watches the inode.
fs.writeFileSync(pluginFile, plugin)

let result = null
const deadline = Date.now() + delay + wait

while (Date.now() < deadline) {
  if (fs.existsSync(outFile)) {
    await sleep(120)
    result = fs.readFileSync(outFile, 'utf8')
    break
  }

  await sleep(250)
}

if (!keep) {
  fs.rmSync(pluginDir, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
}

if (result === null) {
  console.error('probe: no result within the deadline (plugin did not load, or the snippet never returned)')
  process.exit(1)
}

const parsed = JSON.parse(result)

if (!parsed.ok) {
  console.error('probe: snippet threw\n' + parsed.error)
  process.exit(1)
}

console.log(typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value, null, 1))
