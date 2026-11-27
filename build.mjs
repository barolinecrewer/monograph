#!/usr/bin/env node
/**
 * Monograph build. No dependencies.
 *
 *   node build.mjs                 build dist/plugin.js with local config
 *   node build.mjs --release       build without config.local.json (shareable)
 *   node build.mjs --install       build, then write the plugin into Hermes
 *   node build.mjs --install-skin  also copy skin/monograph.yaml into Hermes
 *
 * Desktop plugins are one uncompiled file that cannot import siblings, so the
 * CSS modules are concatenated and inlined as a string.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = new Set(process.argv.slice(2))
const at = (...parts) => path.join(root, ...parts)
const read = (...parts) => fs.readFileSync(at(...parts), 'utf8')

const pkg = JSON.parse(read('package.json'))
const release = args.has('--release')
const local = !release && fs.existsSync(at('config.local.json')) ? JSON.parse(read('config.local.json')) : {}
const { addons = [], ...localDefaults } = local
const defaults = { name: '', tools: 'shown', ...localDefaults }

const modules = fs
  .readdirSync(at('src', 'css'))
  .filter(file => file.endsWith('.css'))
  .sort()
  .map(file => ['src/css/' + file, read('src', 'css', file)])

for (const addon of addons) {
  modules.push([`src/css/addons/${addon}.css`, read('src', 'css', 'addons', `${addon}.css`)])
}

// Model logos: one data URI each, held in a custom property so the composer
// pill (matched in CSS) and the model menu rows (matched in the plugin) share
// a single copy.
const logoIndex = JSON.parse(read('src', 'logos', 'index.json')).logos
const logoUri = name =>
  'data:image/svg+xml,' +
  encodeURIComponent(read('src', 'logos', `${name}.svg`).trim().replaceAll('currentColor', '#ededed'))
const needles = list => list.map(text => `[aria-label*=${JSON.stringify(text)} i]`).join(', ')
const logoCss = [
  ':root {',
  ...logoIndex.map(([name]) => `  --mg-logo-${name}: url("${logoUri(name)}");`),
  '}',
  ...logoIndex.map(([name]) => `.mg-logo[data-logo="${name}"] { background-image: var(--mg-logo-${name}); }`),
  // Lowest priority first: a later rule wins, which mirrors "first match wins".
  ...[...logoIndex]
    .reverse()
    .map(
      ([name, list]) =>
        `button:is([data-tour="model-pill"], [aria-label^="Model · "]):is(${needles(list)})::before { content: ""; background-image: var(--mg-logo-${name}); }`
    ),
  // The brand colour of the model in use (--mg-model) is not generated here:
  // a document-wide :root:has() per vendor cost about 480 ms of style work per
  // scroll trace. modelChips() in plugin.js sets it from the logo index.
].join('\n')

modules.splice(1, 0, ['src/logos (generated)', logoCss])

// The Desktop plugin is a single file. Bundle Karla with its OFL so the
// palette works offline and the installed artifact carries the font license.
const karla = (name, extension) => fs.readFileSync(at('src', 'fonts', 'karla', `${name}.${extension}`))
const karlaRanges = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF'
}
const karlaCss = [
  '/*\n' + karla('OFL', 'txt').toString('utf8').trim() + '\n*/',
  ...['normal', 'italic'].flatMap(style => ['latin-ext', 'latin'].map(subset => {
    const font = karla(`${style === 'normal' ? 'regular' : 'italic'}-${subset}`, 'woff2')

    return `@font-face { font-family: "Karla"; font-style: ${style}; font-weight: 400 700; font-display: swap; src: url("data:font/woff2;base64,${font.toString('base64')}") format("woff2"); unicode-range: ${karlaRanges[subset]}; }`
  }))
].join('\n')
modules.push(['src/fonts/karla (generated)', karlaCss])

// Service logos (src/logos/services): a custom property per id on
// [data-mg-service="<id>"], which 34-services.css draws, and the table the
// services module (src/modules/00-services.js) matches tool names against.
// The SVGs come from outside: refuse anything that is not a static drawing.
const services = JSON.parse(read('src', 'logos', 'services', 'index.json')).services
const UNSAFE = /<script|\son[a-z]+\s*=|<foreignObject|<image|<(?:a|iframe|use|set|animate\w*)\b|\s(?:xlink:)?href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)|<!ENTITY|<!DOCTYPE|@import|javascript:/i
const svgUri = svg =>
  'data:image/svg+xml,' +
  svg
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('"', "'")
    .replace(/[%#<>]/g, char => encodeURIComponent(char))

// A one-colour mark must stand out from the canvas: 3.5:1, a little over the
// 3:1 asked of graphics, since these marks are 14 px. A near-gray brand colour
// too dark for that is drawn in the text colour; a darker hue is lightened
// until it does.
const SURFACE = '#0c0c0d'
const rgbOf = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
const luminance = hex =>
  rgbOf(hex)
    .map(value => value / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0)
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi + 0.05) / (lo + 0.05)
}
const mix = (hex, amount) =>
  '#' +
  rgbOf(hex)
    .map(value => Math.round(value + (255 - value) * amount).toString(16).padStart(2, '0'))
    .join('')
const inkFor = hex => {
  if (contrast(hex, SURFACE) >= 3.5) {
    return hex
  }

  const [r, g, b] = rgbOf(hex)

  if (Math.max(r, g, b) - Math.min(r, g, b) < 48) {
    return 'var(--mg-text)'
  }

  let amount = 0

  while (contrast(mix(hex, amount), SURFACE) < 3.5 && amount < 1) {
    amount += 0.05
  }

  return mix(hex, amount).toUpperCase()
}

const serviceTable = services.map(({ aliases, colour, hosts, id, label, mode }) => ({
  aliases,
  colour,
  hosts,
  id,
  ink: mode === 'mask' ? inkFor(colour) : null,
  label
}))
const serviceCss = services
  .map(({ colour, id, mode }) => {
    if (!/^[a-z0-9]+$/.test(id)) {
      throw new Error(`src/logos/services: bad id ${JSON.stringify(id)}`)
    }

    const svg = read('src', 'logos', 'services', `${id}.svg`)

    if (UNSAFE.test(svg) || !/^\s*<svg[\s>]/.test(svg)) {
      throw new Error(`src/logos/services/${id}.svg is not a static SVG`)
    }

    return mode === 'mask'
      ? `[data-mg-service="${id}"] { --mg-svc-mask: url("${svgUri(svg)}"); --mg-svc-ink: ${inkFor(colour)}; }`
      : `[data-mg-service="${id}"] { --mg-svc-img: url("${svgUri(svg)}"); }`
  })
  .join('\n')

modules.splice(2, 0, ['src/logos/services (generated)', serviceCss])

// The motion-off kill switch (05-motion.css, between the two markers) is not
// part of the stylesheet: its `*` rules would be matched against every element
// with motion on as well. It goes into its own <style>, which the motion
// module (src/modules/50-motion.js) puts in only while motion is off.
const OFF_BEGIN = '/* @mg-motion-off { */'
const OFF_END = '/* } @mg-motion-off */'
let motionOff = ''

for (const entry of modules) {
  const begin = entry[1].indexOf(OFF_BEGIN)

  if (begin < 0) {
    continue
  }

  const end = entry[1].indexOf(OFF_END, begin)

  if (motionOff || end < 0) {
    throw new Error(`${entry[0]}: the motion-off markers must appear once, in order`)
  }

  motionOff = entry[1].slice(begin + OFF_BEGIN.length, end).trim()
  entry[1] = entry[1].slice(0, begin) + entry[1].slice(end + OFF_END.length)
}

if (!motionOff) {
  throw new Error('src/css/05-motion.css: no motion-off kill switch between its markers')
}

const css = modules.map(([name, text]) => `/* ── ${name} ── */\n${text.trimEnd()}\n`).join('\n')

// Feature modules: src/modules/*.js, in name order, each in its own block so
// their names stay private. They share the plugin's module scope (see the
// MODULES note in src/plugin.js). No imports or exports inside a module.
const jsDir = at('src', 'modules')
const jsModules = fs.existsSync(jsDir)
  ? fs
      .readdirSync(jsDir)
      .filter(file => file.endsWith('.js'))
      .sort()
      .map(file => ['src/modules/' + file, read('src', 'modules', file)])
  : []

for (const [name, text] of jsModules) {
  if (/^\s*(import|export)\s/m.test(text)) {
    throw new Error(`${name}: modules cannot import or export; use what plugin.js already has in scope`)
  }
}

const js = jsModules.map(([name, text]) => `// ── ${name} ──\n{\n${text.trimEnd()}\n}\n`).join('\n')

// State machines: src/machines/*.js, in name order, above the core so the
// core and every module can use them (docs/state-machines.md). Each file is a
// real ES module, so `node --test` imports it with no app and no build. It
// exports constants and nothing else, imports nothing, and is pure: it cannot
// see the page, a clock or a timer. Here `export const x` becomes `const x`.
const machineDir = at('src', 'machines')
const machineFiles = fs.existsSync(machineDir)
  ? fs
      .readdirSync(machineDir)
      .filter(file => file.endsWith('.js'))
      .sort()
      .map(file => ['src/machines/' + file, read('src', 'machines', file)])
  : []
const IMPURE =
  /\b(document|window|globalThis|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|localStorage|sessionStorage|performance|Date\.now|Math\.random|sdk|React)\b/
const machineNames = []

for (const [name, text] of machineFiles) {
  // Comments may name anything; the code may not.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const impure = code.match(IMPURE)

  if (impure) {
    throw new Error(`${name}: a machine is pure, and this one names \`${impure[0]}\`. Reading the page, the clock and timers belong to its adapter`)
  }

  if (/^\s*import\s/m.test(code) || /^\s*export\s+(?!const\s)/m.test(code)) {
    throw new Error(`${name}: a machine file imports nothing and exports only with \`export const\``)
  }

  for (const [, exported] of code.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)) {
    if (machineNames.includes(exported)) {
      throw new Error(`${name}: \`${exported}\` is exported by another machine file too`)
    }

    machineNames.push(exported)
  }
}

// A machine's comments are its documentation (the table at its top) and stay
// in the source: the plugin carries the code and one line saying where to read.
const machines =
  machineFiles
    .map(([name, text]) => {
      const code = text
        .replace(/^[ \t]*\/\/.*\n/gm, '')
        .replace(/^export const /gm, 'const ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      // Taking lines out must leave a program: parse it, do not run it.
      try {
        new Function(code)
      } catch (error) {
        throw new Error(`${name}: does not parse once its comment lines are out (${error.message}). A line of a template string that starts with // ?`)
      }

      return `// ── ${name} (states and transitions: the table at the top of that file) ──\n${code}\n`
    })
    .join('\n') + `${machineFiles.length ? '\n' : ''}const MACHINES = { ${machineNames.join(', ')} }`

// Function replacements: the CSS contains `$` and `%` sequences.
const plugin = read('src', 'plugin.js')
  .replace('/* __MG_MACHINES__ */', () => machines)
  .replace('/* __MG_MODULES__ */', () => js || '// (no feature modules)')
  .replace('"__MG_VERSION__"', () => JSON.stringify(pkg.version))
  .replace('"__MG_CSS__"', () => JSON.stringify(css))
  .replace('"__MG_MOTION_OFF_CSS__"', () => JSON.stringify(motionOff))
  .replace('"__MG_DEFAULTS__"', () => JSON.stringify(defaults))
  .replace('"__MG_LOGOS__"', () => JSON.stringify(logoIndex))
  .replace('"__MG_SERVICES__"', () => JSON.stringify(serviceTable))

if (/__MG_[A-Z_]+__/.test(plugin.replace(JSON.stringify(css), '""').replace(JSON.stringify(motionOff), '""'))) {
  throw new Error('unreplaced build placeholder in plugin.js')
}

// Truncate-and-write keeps the inode, which Hermes' hot reload watches.
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

write(at('dist', 'plugin.js'), plugin)

const kb = n => (n / 1024).toFixed(1) + ' KB'
console.log(`built dist/plugin.js  v${pkg.version}  css ${kb(Buffer.byteLength(css))} in ${modules.length} modules`)
console.log(`  modules: ${modules.map(([name]) => path.basename(name, '.css')).join(', ')}`)
console.log(`  js modules: ${jsModules.map(([name]) => path.basename(name, '.js')).join(', ') || 'none'}`)
console.log(`  machines: ${machineNames.join(', ') || 'none'}`)
console.log(`  mode: ${release ? 'release' : 'local'}${addons.length ? `, addons: ${addons.join(', ')}` : ''}`)

const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')

if (args.has('--install') || args.has('--install-skin')) {
  const target = path.join(home, 'desktop-plugins', 'monograph', 'plugin.js')
  write(target, plugin)
  console.log(`installed plugin -> ${target}`)
}

if (args.has('--install-skin')) {
  const target = path.join(home, 'skins', 'monograph.yaml')
  write(target, read('skin', 'monograph.yaml'))
  console.log(`installed skin   -> ${target}`)
  console.log('  reload it: hermes config set display.skin default && sleep 2 && hermes config set display.skin monograph')
}
