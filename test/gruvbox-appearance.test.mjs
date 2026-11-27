import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const repo = fileURLToPath(new URL('../', import.meta.url))

test('Gruvbox is opt-in and changes the root palette on the same settings path', () => {
  const source = readFileSync(join(repo, 'src', 'plugin.js'), 'utf8')
  const apply = source.slice(source.indexOf('function applyConfig('), source.indexOf('function setConfig('))
  const root = { dataset: {}, style: { setProperty() {} } }
  const render = runInNewContext(`${apply}\napplyConfig`, {
    document: { documentElement: root }, greeting: () => '', toolsShown: () => true, thinkingMode: () => 'live'
  })
  for (const [value, wanted] of [[undefined, 'monograph'], ['gruvbox', 'gruvbox'], ['monograph', 'monograph'], ['unexpected', 'monograph']]) {
    render({ palette: value })
    assert.equal(root.dataset.mgPalette, wanted)
  }
})

const contrast = (a, b) => {
  const luminance = hex => [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const rgb = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return sum + weight * (rgb <= 0.04045 ? rgb / 12.92 : ((rgb + 0.055) / 1.055) ** 2.4)
  }, 0)
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test('release applies the Gruvbox colors and offline Karla only to that mode; terminal mono stays native', t => {
  const dir = mkdtempSync(join(tmpdir(), 'monograph-gruvbox-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of ['build.mjs', 'package.json', 'src']) cpSync(join(repo, file), join(dir, file), { recursive: true })
  execFileSync(process.execPath, ['build.mjs', '--release'], { cwd: dir })
  const plugin = readFileSync(join(dir, 'dist', 'plugin.js'), 'utf8')
  const css = JSON.parse(plugin.match(/^const CSS = (.*)$/m)[1])
  const mode = css.match(/:root\[data-mg-palette="gruvbox"\]\s*\{([^}]*)\}/)?.[1]
  assert.ok(mode, 'Gruvbox declaration is scoped to its opt-in palette')
  assert.match(mode, /--mg-surface:\s*#282828\b/)
  assert.match(mode, /--dt-font-sans:\s*var\(--mg-font\)\s*!important/)
  assert.match(mode, /--mg-font:\s*"Karla",/)
  assert.doesNotMatch(mode, /--(?:dt-font-mono|font-mono):/)
  const color = name => mode.match(new RegExp(`--mg-${name}:\\s*(#[0-9a-f]{6})\\b`))[1]
  assert.ok(contrast(color('text-3'), color('raised-2')) >= 4.5, 'muted text still clears normal-text AA on the raised surface')
  const fonts = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => body).filter(body => body.includes('Karla'))
  assert.equal(fonts.length, 4, 'regular and italic in Latin and Latin Extended')
  for (const font of fonts) {
    const data = font.match(/data:font\/woff2;base64,([\w+/=]+)/)?.[1]
    assert.ok(data, 'Karla is bundled, not requested from the network')
    assert.equal(Buffer.from(data, 'base64').subarray(0, 4).toString(), 'wOF2')
  }
  assert.match(css, /SIL OPEN FONT LICENSE Version 1\.1/)
})
