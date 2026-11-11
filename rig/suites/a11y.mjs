// Accessibility of what Monograph adds or restyles: keyboard reach and focus,
// menus by keyboard, names on icon-only buttons, contrast of our tokens, and
// motion under reduced motion and under data-mg-motion="off". See
// rig/README.md ("A11y").
//
// "Ours" means an element Monograph adds (.mg-*), a Hermes control Monograph
// draws (the surfaces button, the approval chip's menu), or a style that
// comes from Monograph's stylesheet (#mg-css): an animation or transition is
// ours when switching #mg-css off changes it.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { EVIDENCE, HERMES_REPO, RUNNING, VIEWPORT, check, hasModule, results, scriptedModel, setMotion, setWindow, shot, sleep, state, type } from '../harness.mjs'
import { startModel } from './stress.mjs'

export const checks = [
  ['y1', 'Keyboard: Tab reaches every Monograph control, each shows visible focus'],
  ['y2', 'Keyboard: our menus open with Enter and Space, arrows move, Escape closes and gives focus back'],
  ['y3', 'Names: every icon-only button of ours has an accessible name'],
  ['y4', 'Contrast: our text tokens on our surfaces, and text and icons as drawn'],
  ['y5', 'Reduced motion: nothing of ours animates'],
  ['y6', 'Motion off (data-mg-motion="off"): nothing of ours animates'],
  ['y7', 'Grayscale: no colour on screen outside bot, model and service logos, in every state, at 1220x800 and 1600x1000'],
  ['y8', 'Sidebar: the selected row reads strongest, an unread one next, the rest quiet; each readable'],
  ['y9', 'Meaning without colour: destructive, error, failed tool, diff, dangerous approval, toast kind, unread and invalid states each carry a glyph, weight, shape or text; focus is a gray cue at 3:1 at every Tab stop']
]

export const limitS = 900

// Replies the stress model does not have: code in five languages and a table
// (MGY_LANGS, y7 and y9), and a provider error (MGY_FAIL, y9).
export const LANGS_REPLY = [
  'Five languages and a table, MGY_LANGS.',
  '',
  '```ts',
  '// A typed helper: comments are the dimmest step, in italic.',
  'export async function load(id: string, retries = 3): Promise<Item[]> {',
  "  const url = `https://example.com/items/${id}`",
  '  return (await fetch(url)).json() as Promise<Item[]>',
  '}',
  '```',
  '',
  '```python',
  '# Count the words in a file.',
  'def count(path: str, limit: int = 10) -> dict:',
  '    words = {}',
  "    for line in open(path, encoding='utf-8'):",
  '        for word in line.split():',
  '            words[word] = words.get(word, 0) + 1',
  '    return dict(sorted(words.items())[:limit])',
  '```',
  '',
  '```bash',
  '# Build, then copy the result.',
  'set -euo pipefail',
  'for f in dist/*.js; do',
  '  cp "$f" "$HOME/out/$(basename "$f")" && echo "copied $f"',
  'done',
  '```',
  '',
  '```json',
  '{ "name": "monograph", "version": 2, "private": true, "tags": ["dark", "flat"], "size": null }',
  '```',
  '',
  '```diff',
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1,3 +1,3 @@',
  ' alpha',
  '-beta',
  '+gamma',
  ' delta',
  '```',
  '',
  '| Language | Strings | Comments |',
  '| --- | --- | --- |',
  '| ts | second step | third, italic |',
  '| python | second step | third, italic |',
  '',
  'Done MGY_LANGS.'
].join('\n')

export const model = async () => scriptedModel(await startModel(), { MGY_FAIL: { error: 'The model refused this request (a planted provider error).', status: 400 }, MGY_LANGS: LANGS_REPLY })

const WCAG = { icon: 3, large: 3, text: 4.5 }

// The stylesheets the FINISH workstream owns (its brief); y4 holds these to
// "no text in --mg-text-4". Files of other areas are listed as evidence only.
const OWN_CSS = ['00-tokens.css', '10-shell.css', '12-corner.css', '14-surfaces.css', '20-sidebar.css', '32-cards.css', '35-controls.css', '40-composer.css', '41-effort.css', '50-menus.css', 'addons/bots.css']
const CSS_DIR = new URL('../../src/css/', import.meta.url)

// Rules in a CSS source (nesting followed) that set `color` to --mg-text-4,
// minus the ones that draw an icon: a disabled state, the codicon font, or
// font-size 0. Each as "file: selector".
export function text4RulesIn(file, source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const found = []
  const stack = []
  let text = ''

  const declarations = body => body.split(';').map(part => part.trim()).filter(Boolean)
  const judge = (selector, decls) => {
    const sets = decls.some(decl => /^color\s*:\s*var\(--mg-text-4\)/.test(decl))
    const icon = /disabled/.test(selector) || decls.some(decl => /codicon/.test(decl) || /^font-size\s*:\s*0(px)?\s*(!important)?$/.test(decl))

    if (sets && !icon) {
      found.push(`${file}: ${selector.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }

  for (const char of css) {
    if (char === '{') {
      const head = text.split(/;(?![^(]*\))/).at(-1).trim()

      // Declarations before a nested rule belong to the enclosing rule.
      const before = text.slice(0, text.length - head.length)

      if (stack.length) {
        stack.at(-1).decls.push(...declarations(before))
      }

      stack.push({ decls: [], selector: [stack.at(-1)?.selector, head].filter(Boolean).join(' ') })
      text = ''
    } else if (char === '}') {
      const rule = stack.pop()

      if (rule) {
        rule.decls.push(...declarations(text))
        judge(rule.selector, rule.decls)
      }

      text = ''
    } else {
      text += char
    }
  }

  return found
}

const ownText4Rules = () => OWN_CSS.flatMap(file => text4RulesIn(file, fs.readFileSync(new URL(file, CSS_DIR), 'utf8')))

const waitIdle = (needle, timeout = 60_000) =>
  state.page.waitForFunction(
    ({ needle, running }) =>
      !document.querySelector(running) &&
      ([...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].find(node => node.getBoundingClientRect().height > 0)?.textContent ?? '').includes(needle),
    { needle, running: RUNNING },
    { polling: 100, timeout }
  )

// The focused element, described, with the styles that make focus visible.
const focused = () =>
  state.page.evaluate(() => {
    const node = document.activeElement

    if (!node || node === document.body) {
      return null
    }

    const style = getComputedStyle(node)
    const mg = [...node.classList].filter(cls => cls.startsWith('mg-')).join('.')

    return {
      label: node.getAttribute('aria-label') ?? (node.textContent ?? '').trim().slice(0, 30),
      mg: mg || null,
      ours: Boolean(node.closest('[class*="mg-"], [data-tour="mg-surfaces"]')) || Boolean(mg),
      role: node.getAttribute('role') ?? node.tagName.toLowerCase(),
      slot: node.dataset.slot ?? null,
      tour: node.dataset.tour ?? null,
      visibleFocus: [
        style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 ? `outline ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}` : 'no outline',
        /\d+px [^,]*\d+px/.test(style.boxShadow) && !/^(rgba\(0, 0, 0, 0\)[^,]*(,|$)\s*)+$/.test(style.boxShadow) ? `shadow ${style.boxShadow.replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px,? ?/g, '')}` : 'no shadow',
        `background ${style.backgroundColor}`,
        parseFloat(style.borderTopWidth) > 0 ? `border ${style.borderTopWidth} ${style.borderColor}` : 'no border',
        `color ${style.color}`
      ].join(' | ')
    }
  })

// The same element's focus-relevant styles once focus has left it.
const unfocusedStyle = selector =>
  state.page.evaluate(selector => {
    const node = document.querySelector(selector)
    const style = node && getComputedStyle(node)

    return style
      ? [
          style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 ? `outline ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}` : 'no outline',
          /\d+px [^,]*\d+px/.test(style.boxShadow) && !/^(rgba\(0, 0, 0, 0\)[^,]*(,|$)\s*)+$/.test(style.boxShadow) ? `shadow ${style.boxShadow.replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px,? ?/g, '')}` : 'no shadow',
          `background ${style.backgroundColor}`,
          parseFloat(style.borderTopWidth) > 0 ? `border ${style.borderTopWidth} ${style.borderColor}` : 'no border',
          `color ${style.color}`
        ].join(' | ')
      : null
  }, selector)

// Checks to run, for probing one (MG_A11Y_ONLY=y8,y9); every run boots.
const ONLY = (process.env.MG_A11Y_ONLY ?? '').split(',').filter(Boolean)
const checkIf = (id, body) => (ONLY.length && !ONLY.includes(id) ? Promise.resolve() : check(id, body))

export async function run() {
  const { app, page } = state

  // Copies go to a variable in the app, never to the system clipboard.
  await app.evaluate(({ clipboard }) => {
    globalThis.__rigClipboard = []
    clipboard.writeText = text => {
      globalThis.__rigClipboard.push(String(text))
    }
  })

  // Something in the thread: a prompt (for its copy button) and a reply with work.
  await type('A11y setup, MGY_SETUP. MGS_WORK', 'Enter')
  await waitIdle('MGY_SETUP MGS_WORK_DONE').catch(() => undefined)
  await sleep(1500)

  // ── y1. Tab order and focus ──────────────────────────────────────────────
  await checkIf('y1', async (entry, must) => {
    const box = page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()

    await box.click()

    const stops = []
    const seen = new Map()

    for (let index = 0; index < 120; index++) {
      await page.keyboard.press('Tab')
      await sleep(40)

      const now = await focused()

      if (!now) {
        stops.push('(body)')
        continue
      }

      const key = `${now.role} "${now.label}"${now.mg ? ` .${now.mg}` : ''}${now.tour ? ` tour=${now.tour}` : ''}`

      stops.push(key)

      if (now.ours && !seen.has(key)) {
        seen.set(key, now)
      }

      if (stops.filter(stop => stop === key).length > 2) {
        break
      }
    }

    // What we expect a keyboard user to reach.
    const targets = [
      ['the surfaces button', stop => /tour=mg-surfaces/.test(stop)],
      ['the approval chip', stop => /\.mg-chip/.test(stop)],
      ['the copy button on a prompt', stop => /\.mg-ucopy/.test(stop)],
      ['the "Worked for" line (open or close the work)', stop => /aui_assistant-message-root|Worked for/.test(stop)]
    ]

    entry.evidence.tabStops = stops.length
    entry.evidence.order = stops.slice(0, 60)
    entry.evidence.reached = Object.fromEntries(targets.map(([name, test]) => [name, stops.some(test)]))

    for (const [name, test] of targets) {
      must(stops.some(test), `Tab never reaches ${name} (${stops.length} stops)`)
    }

    // Visible focus on each of ours that was reached: its styles focused vs not.
    entry.evidence.focus = {}

    for (const [key, info] of seen) {
      const selector = info.tour ? `[data-tour="${info.tour}"]` : info.mg ? `.${info.mg.split('.')[0]}` : null

      if (!selector) {
        continue
      }

      await page.locator(selector).filter({ visible: true }).first().focus()
      await page.keyboard.press('Shift')

      const on = (await focused())?.visibleFocus
      const shotName = `y1-focus-${(info.mg ?? info.tour ?? 'x').replace(/\W+/g, '-')}`

      await shot(entry, shotName)
      await page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first().focus()

      const off = await unfocusedStyle(selector)

      entry.evidence.focus[key] = { focused: on, unfocused: off }
      must(on && on !== off, `${key}: no visible change when it has keyboard focus (${on})`)
    }
  })

  // ── y2. Menus by keyboard ────────────────────────────────────────────────
  await checkIf('y2', async (entry, must) => {
    const menus = [
      ['surfaces', '[data-tour="mg-surfaces"]', '.mg-surfaces-menu'],
      ['approval', '.mg-chip[data-mg-approval]', '.mg-approval-menu']
    ]

    for (const [name, trigger, content] of menus) {
      for (const key of ['Enter', ' ']) {
        const record = {}

        entry.evidence[`${name} ${key === ' ' ? 'Space' : key}`] = record
        await page.locator(trigger).filter({ visible: true }).first().focus()
        await page.keyboard.press(key === ' ' ? 'Space' : key)
        await sleep(400)
        record.opened = await page.locator(content).filter({ visible: true }).count()

        if (!record.opened) {
          must(false, `${name}: ${key === ' ' ? 'Space' : key} on the focused trigger did not open the menu`)
          continue
        }

        const where = () => page.evaluate(() => (document.activeElement?.textContent ?? '').trim().slice(0, 24))

        record.focusInMenu = await page.evaluate(content => Boolean(document.activeElement?.closest(content)), content)
        await page.keyboard.press('ArrowDown')
        await sleep(120)

        const a = await where()

        await page.keyboard.press('ArrowDown')
        await sleep(120)

        const b = await where()

        record.arrows = [a, b]
        await page.keyboard.press('Escape')
        await sleep(400)
        record.closed = !(await page.locator(content).filter({ visible: true }).count())
        record.focusAfter = await focused()
        record.focusBackOnTrigger = await page.evaluate(trigger => Boolean(document.activeElement?.closest(trigger)), trigger)
        must(record.focusInMenu, `${name}: focus did not move into the menu when it opened`)
        must(a && b && a !== b, `${name}: ArrowDown did not move between rows (${a} → ${b})`)
        must(record.closed, `${name}: Escape did not close the menu`)
        must(record.focusBackOnTrigger, `${name}: after Escape, focus is on ${record.focusAfter ? `${record.focusAfter.role} "${record.focusAfter.label}"` : 'the page body'}, not back on the trigger`)
      }
    }
  })

  // ── y3. Names ────────────────────────────────────────────────────────────
  await checkIf('y3', async (entry, must) => {
    // Open what holds our buttons, then read every candidate.
    const prompt = page.locator('[data-slot="aui_user-message-root"]').filter({ visible: true }).last()

    await prompt.hover()
    await sleep(300)

    const read = () =>
      page.evaluate(() => {
        const out = []
        const ours = [
          ...document.querySelectorAll('button[class*="mg-"], [role="button"][class*="mg-"], [class*="mg-"] button, [data-tour="mg-surfaces"], .mg-surfaces-menu [role="menuitem"], .mg-approval-menu [role="menuitem"]')
        ]

        for (const node of new Set(ours)) {
          if (!node.checkVisibility()) {
            continue
          }

          const text = [...node.childNodes]
            .map(child => (child.nodeType === 3 ? child.textContent : child.getAttribute?.('aria-hidden') === 'true' || child.matches?.('i.codicon') ? '' : child.textContent))
            .join('')
            .trim()
          const labelled = node.getAttribute('aria-labelledby')
          const name = node.getAttribute('aria-label') || (labelled && document.getElementById(labelled)?.textContent) || text || node.getAttribute('title') || ''

          out.push({ name: name.trim(), what: `<${node.tagName.toLowerCase()}${[...node.classList].filter(cls => cls.startsWith('mg-')).map(cls => `.${cls}`).join('')}${node.dataset.tour ? ` tour=${node.dataset.tour}` : ''}>` })
        }

        return out
      })

    // Self-test: a planted icon-only button of ours with no name must be
    // caught, or this check proves nothing. It is removed before the verdict.
    await page.evaluate(() => {
      const button = document.createElement('button')

      button.id = 'mg-rig-unnamed'
      button.className = 'mg-rig-unnamed'
      button.innerHTML = '<i class="codicon codicon-close" aria-hidden="true"></i>'
      Object.assign(button.style, { height: '24px', left: '400px', position: 'fixed', top: '300px', width: '24px', zIndex: 99999 })
      document.body.appendChild(button)
    })

    const planted = await read()

    await page.evaluate(() => document.getElementById('mg-rig-unnamed')?.remove())
    entry.evidence.plantedCaught = planted.some(item => item.what.includes('.mg-rig-unnamed') && !item.name)
    must(entry.evidence.plantedCaught, 'self-test: a planted icon-only button with no name was not reported')

    const all = [...(await read())]

    await page.locator('[data-tour="mg-surfaces"]').filter({ visible: true }).first().focus()
    await page.keyboard.press('Enter')
    await sleep(400)
    all.push(...(await read()))
    await page.keyboard.press('Escape')
    await sleep(300)

    const unique = [...new Map(all.map(item => [`${item.what}|${item.name}`, item])).values()]

    entry.evidence.buttons = unique.map(item => `${item.what} "${item.name}"`)
    entry.evidence.unnamed = unique.filter(item => !item.name).map(item => item.what)
    must(unique.length >= 3, `only ${unique.length} buttons of ours found to check`)
    must(!entry.evidence.unnamed.length, `without an accessible name: ${entry.evidence.unnamed.join(', ')}`)
  })

  // ── y4. Contrast ─────────────────────────────────────────────────────────
  await checkIf('y4', async (entry, must) => {
    const measure = () => page.evaluate(WCAG => {
      // Any CSS colour to sRGB through a canvas.
      const canvas = document.createElement('canvas')

      canvas.width = canvas.height = 1

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const rgba = colour => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = '#000'
        ctx.fillStyle = colour
        ctx.fillRect(0, 0, 1, 1)

        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data

        return [r, g, b, a / 255]
      }
      const over = (top, bottom) => top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3])).concat(1)
      const lum = ([r, g, b]) => {
        const lin = value => {
          const c = value / 255

          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        }

        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      }
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)

        return +((x + 0.05) / (y + 0.05)).toFixed(2)
      }
      const root = getComputedStyle(document.documentElement)
      const token = name => root.getPropertyValue(name).trim()

      // Token by token.
      const canvasColour = rgba(token('--mg-canvas') || '#000')
      const surfaces = ['--mg-canvas', '--mg-surface', '--mg-raised', '--mg-raised-2', '--mg-hover', '--mg-active'].filter(token)
      const texts = ['--mg-text', '--mg-text-1', '--mg-text-2', '--mg-text-3', '--mg-text-4'].filter(token)
      const matrix = []

      for (const text of texts) {
        for (const surface of surfaces) {
          const bg = over(rgba(token(surface)), canvasColour)
          const fg = over(rgba(token(text)), bg)

          matrix.push({ ratio: ratio(fg, bg), surface, text, value: `${token(text)} on ${token(surface)}` })
        }
      }

      // As drawn: text in what Monograph adds or restyles.
      const background = node => {
        const layers = []

        for (let up = node; up; up = up.parentElement) {
          const colour = rgba(getComputedStyle(up).backgroundColor)

          if (colour[3] > 0) {
            layers.push(colour)

            if (colour[3] >= 1) {
              break
            }
          }
        }

        return layers.reverse().reduce((bottom, top) => over(top, bottom), canvasColour)
      }

      const hex = ([r, g, b]) => `#${[r, g, b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`
      const describe = node =>
        `${node.tagName.toLowerCase()}${node.dataset.slot ? `[data-slot=${node.dataset.slot}]` : ''}${[...node.classList].filter(cls => cls.startsWith('mg-') || cls.startsWith('codicon-')).map(cls => `.${cls}`).join('')}`
      const drawn = []
      const scope = [
        '.mg-surfaces-menu', '.mg-approval-menu', '.mg-chip', '.mg-ucopy', '[data-tour="mg-surfaces"]', '[data-titlebar-cluster="left"]', '[data-mg-head]', '[data-slot="aui_msg-actions"] time', '[data-slot="aui_user-bubble-actions"] time',
        '[data-slot="composer-root"]', '[data-slot="row-button"]', '[data-slot="pane-tab"]', '[data-slot="aui_assistant-message-content"] .aui-md', '[data-slot="tool-block"]', '[data-slot="aui_thinking-disclosure"]'
      ]

      for (const selector of scope) {
        for (const host of document.querySelectorAll(selector)) {
          if (!host.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
            continue
          }

          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)

          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const parent = text.parentElement

            if (!text.textContent.trim() || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || parent.getBoundingClientRect().height === 0) {
              continue
            }

            const style = getComputedStyle(parent)
            const icon = /codicon/.test(style.fontFamily) || parent.matches('i')
            const size = parseFloat(style.fontSize)
            const bold = Number(style.fontWeight) >= 700
            const kind = icon ? 'icon' : size >= 24 || (bold && size >= 18.66) ? 'large' : 'text'
            const bg = background(parent)
            let opacity = 1

            for (let up = parent; up; up = up.parentElement) {
              opacity *= Number(getComputedStyle(up).opacity)
            }

            const fg = over([...rgba(style.color).slice(0, 3), rgba(style.color)[3] * opacity], bg)

            drawn.push({ bg: hex(bg), element: describe(parent), fg: hex(fg), kind, need: WCAG[kind], ratio: ratio(fg, bg), size: `${Math.round(size)}px`, text: text.textContent.trim().slice(0, 30), where: selector })
          }

          // The "Worked for" line is an element of ours right before the row
          // (div.mg-line): its words are text, its chevron an icon.
          const line = host.matches('[data-mg-head]') && host.previousElementSibling?.classList.contains('mg-line') ? host.previousElementSibling : null

          for (const part of line ? line.children : []) {
            const style = getComputedStyle(part)

            if (part.textContent.trim() && part.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && part.getBoundingClientRect().height > 0) {
              const bg = background(line)
              let opacity = 1

              for (let up = part; up; up = up.parentElement) {
                opacity *= Number(getComputedStyle(up).opacity)
              }

              const kind = /codicon/.test(style.fontFamily) ? 'icon' : 'text'
              const fg = over([...rgba(style.color).slice(0, 3), rgba(style.color)[3] * opacity], bg)

              drawn.push({ bg: hex(bg), element: describe(part), fg: hex(fg), kind, need: WCAG[kind], ratio: ratio(fg, bg), size: style.fontSize, text: part.textContent.trim().slice(0, 30), where: '.mg-line' })
            }
          }

          // Our drawn icons are pseudo-elements: the copy glyph, and every
          // codicon (the surfaces glyph, the chip's shield, the menu rows'
          // icons), which Hermes draws as an <i>'s ::before. A mask-drawn
          // icon shows its background colour.
          const glyphs = [host, ...host.querySelectorAll('i, .codicon, [class*="codicon-"], [data-mg-service], [data-mg-tool-family]')]

          for (const node of new Set(glyphs)) {
            if (node !== host && !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
              continue
            }

            for (const [pseudo, kind] of [['::before', 'icon'], ['::after', 'icon']]) {
              const style = getComputedStyle(node, pseudo)
              const masked = style.webkitMaskImage && style.webkitMaskImage !== 'none'

              if (style.content && style.content !== 'none' && (style.content !== '""' || masked) && style.display !== 'none') {
                const bg = background(node)
                let opacity = 1

                for (let up = node; up; up = up.parentElement) {
                  opacity *= Number(getComputedStyle(up).opacity)
                }

                const ink = rgba(masked ? style.backgroundColor : style.color)
                const fg = over([...ink.slice(0, 3), ink[3] * opacity * Number(style.opacity || 1)], bg)

                drawn.push({ bg: hex(bg), element: `${describe(node)}${pseudo}`, fg: hex(fg), kind, need: WCAG[kind], ratio: ratio(fg, bg), size: style.fontSize, text: masked ? '(mask)' : style.content.slice(0, 30), where: selector })
              }
            }
          }
        }
      }

      return { drawn, matrix }
    }, WCAG)

    // Self-test: grey text planted on the canvas inside one of our places
    // must be reported, or this check proves nothing. Removed before the verdict.
    await page.evaluate(() => {
      const node = document.createElement('div')

      node.id = 'mg-rig-low'
      node.className = 'mg-surfaces-menu mg-rig-low'
      node.textContent = 'planted low contrast'
      Object.assign(node.style, { background: '#0c0c0d', color: '#333333', fontSize: '12px', left: '400px', padding: '4px', position: 'fixed', top: '300px', zIndex: 99999 })
      document.body.appendChild(node)
    })

    const plantedRun = await measure()

    await page.evaluate(() => document.getElementById('mg-rig-low')?.remove())
    entry.evidence.plantedCaught = plantedRun.drawn.find(item => item.element.includes('mg-rig-low') && item.ratio < item.need) ?? null
    must(entry.evidence.plantedCaught, 'self-test: planted #333 text on the canvas was not reported')

    // The thread and composer as they are, then each of our menus open.
    const report = await measure()
    const prompt = page.locator('[data-slot="aui_user-message-root"]').filter({ visible: true }).last()

    await prompt.hover()
    await sleep(300)
    report.drawn.push(...(await measure()).drawn)

    for (const [trigger, content] of [['[data-tour="mg-surfaces"] .mg-surfaces-hit', '.mg-surfaces-menu'], ['.mg-chip[data-mg-approval]', '.mg-approval-menu']]) {
      const box = await page.locator(trigger).filter({ visible: true }).first().boundingBox()

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.locator(content).waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
      await sleep(300)
      report.drawn.push(...(await measure()).drawn)
      await shot(entry, `y4-${content.slice(1)}`)
      await page.mouse.click(5, 790)
      await sleep(300)
    }

    // One line per kind of run: which element, its colours and size, and the
    // first of our places it was found in. The same element in the same
    // colours counts once, whatever its text or how many places hold it.
    const low = report.drawn.filter(item => item.ratio < item.need)
    const key = item => `${item.element}|${item.fg}|${item.bg}|${item.size}|${item.kind}`
    const unique = [...new Map(low.map(item => [key(item), item])).values()].sort((a, b) => a.ratio - b.ratio)
    const line = item => `${item.ratio} < ${item.need} ${item.kind}: ${item.element} in ${item.where}, ${item.fg} on ${item.bg}, ${item.size}, e.g. ${JSON.stringify(item.text)}`

    // --mg-text-4 is not a text colour (00-tokens.css): decoration, disabled
    // controls and icons, which need 3:1. Every other text token needs 4.5:1
    // on every surface token.
    const decoration = item => /--mg-text-4/.test(item.text)

    entry.evidence.tokens = report.matrix.map(item =>
      `${item.text} on ${item.surface}: ${item.ratio}${decoration(item) ? (item.ratio < 3 ? ' (under 3: too faint even for an icon)' : ' (icons and decoration only)') : item.ratio < 4.5 ? ' (under 4.5)' : ''}`
    )
    must(!report.matrix.some(item => !decoration(item) && item.ratio < 4.5), `a text token under 4.5:1 on a surface token: ${report.matrix.filter(item => !decoration(item) && item.ratio < 4.5).map(item => `${item.text} on ${item.surface} ${item.ratio}`).join(', ')}`)
    must(!report.matrix.some(item => decoration(item) && item.ratio < 3), `--mg-text-4 under 3:1 (the icon minimum) on: ${report.matrix.filter(item => decoration(item) && item.ratio < 3).map(item => item.surface).join(', ')}`)

    // Where our stylesheet still draws text in --mg-text-4 (evidence: the
    // places are in files of other areas; only what is on screen above is
    // judged). Disabled and placeholder-free rules for icons are not text,
    // but a rule cannot say which it draws, so all are listed.
    entry.evidence.text4Rules = await page.evaluate(() => {
      const found = []
      const walk = (rules, parent = '') => {
        for (const rule of rules) {
          const selector = rule.selectorText ? (parent ? `${parent} ${rule.selectorText}` : rule.selectorText) : parent

          if (rule.style && /--mg-text-4|--ui-text-quaternary/.test(rule.style.getPropertyValue('color')) && !/disabled/.test(selector)) {
            found.push(selector.replace(/\s+/g, ' ').slice(0, 140))
          }

          if (rule.cssRules?.length) {
            walk(rule.cssRules, selector)
          }
        }
      }

      walk(document.getElementById('mg-css')?.sheet?.cssRules ?? [])

      return found
    })
    entry.evidence.drawnChecked = report.drawn.length
    entry.evidence.kindsChecked = new Set(report.drawn.map(key)).size
    entry.evidence.iconsChecked = report.drawn.filter(item => item.kind === 'icon').length
    entry.evidence.drawnBelow = unique.map(line)
    must(report.drawn.length > 10, `only ${report.drawn.length} text runs measured`)
    must(!unique.length, `${unique.length} kind(s) of text or icon drawn below their contrast minimum: ${unique.map(line).join(' | ')}`)

    // In the files of this suite's owner (FINISH: OWN_CSS), a rule that sets
    // text colour (`color`) to --mg-text-4 fails, read from the sources so
    // each rule is named with its file. Icons are exempt when the rule says
    // so: a disabled state, a glyph drawn in the codicon font, or text hidden
    // with font-size 0. Self-test: a planted rule must be caught.
    const ownText4 = ownText4Rules()
    const plantedText4 = text4RulesIn('planted.css', '.mg-planted-label { font-size: 12px; color: var(--mg-text-4); }')

    entry.evidence.ownText4Rules = ownText4
    entry.evidence.ownText4PlantCaught = plantedText4.length === 1
    must(plantedText4.length === 1, 'self-test: a planted rule colouring text with --mg-text-4 was not caught')
    must(!ownText4.length, `${ownText4.length} rule(s) in our own files colour text with --mg-text-4 (icons and decoration only): ${ownText4.join(' | ')}`)

    if (entry.evidence.text4Rules.length) {
      results.observations.push(`y4: ${entry.evidence.text4Rules.length} rule(s) colour text with --mg-text-4, which is for icons and decoration (see y4 evidence text4Rules)`)
    }
  })

  // ── y5, y6. Motion ───────────────────────────────────────────────────────
  // Every animation and transition that runs while we open our menus, run a
  // turn, open and close the work fold and press copy. Then each is put to
  // the test: does it change when #mg-css is switched off? If so it is ours.
  const motionRun = async (entry, tag) => {
    await page.evaluate(() => {
      const log = (window.__mgRigMotion = [])
      const note = (event, kind) => {
        const target = event.target

        if (!(target instanceof Element)) {
          return
        }

        const style = getComputedStyle(target, event.pseudoElement || null)
        const duration = kind === 'animation' ? style.animationDuration : style.transitionDuration
        const seconds = Math.max(...duration.split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 0.001 : 1)))

        if (seconds > 0.001) {
          log.push({ kind, name: event.animationName ?? event.propertyName, pseudo: event.pseudoElement || '', seconds, target })
        }
      }

      window.__mgRigMotionStop = (() => {
        const a = event => note(event, 'animation')
        const t = event => note(event, 'transition')

        document.addEventListener('animationstart', a, true)
        document.addEventListener('transitionrun', t, true)

        return () => {
          document.removeEventListener('animationstart', a, true)
          document.removeEventListener('transitionrun', t, true)
        }
      })()
    })

    const steps = []
    const step = async (name, fn) => {
      try {
        await fn()
        steps.push(name)
      } catch (error) {
        steps.push(`${name} FAILED: ${String(error.message).split('\n')[0]}`)
      }
    }

    const click = async selector => {
      const box = await page.locator(selector).filter({ visible: true }).first().boundingBox({ timeout: 3000 })

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }

    await step('surfaces menu', async () => {
      await click('[data-tour="mg-surfaces"] .mg-surfaces-hit')
      await sleep(500)
      await page.mouse.click(5, 790)
      await sleep(300)
    })
    await step('approval menu', async () => {
      await click('.mg-chip[data-mg-approval]')
      await sleep(500)
      await page.mouse.click(5, 790)
      await sleep(300)
    })
    await step('effort slider', async () => {
      await click('[data-testid="reasoning-pill"]')
      await sleep(900)
      await page.mouse.click(5, 790)
      await sleep(300)
    })
    await step('model menu', async () => {
      await click('button:is([data-tour="model-pill"], [aria-label^="Model · "])')
      await sleep(500)
      await page.mouse.click(5, 790)
      await sleep(300)
    })
    await step('a turn with work', async () => {
      await type(`Motion test, ${tag}. MGS_WORK`, 'Enter')
      await waitIdle(`${tag} MGS_WORK_DONE`)
      await sleep(1500)
    })
    await step('open and close the work', async () => {
      const head = await page.evaluate(() => {
        const node = [...document.querySelectorAll('.mg-line[data-mg-steps]')].filter(item => item.checkVisibility()).at(-1)
        const rect = node?.getBoundingClientRect()

        return rect ? { x: rect.x + 60, y: rect.y + 12 } : null
      })

      if (!head) {
        throw new Error('no "Worked for" line to press')
      }

      await page.mouse.click(head.x, head.y)
      await sleep(700)
      await page.mouse.click(head.x, head.y)
      await sleep(700)
    })
    await step('copy a prompt', async () => {
      const prompt = page.locator('[data-slot="aui_user-message-root"]').filter({ visible: true }).last()

      await prompt.hover()
      await sleep(200)

      // The copy itself would reach the system clipboard: stop the click there.
      await page.evaluate(() => {
        navigator.clipboard.writeText = async () => undefined
      })
      await prompt.locator('.mg-ucopy').first().click({ timeout: 3000 })
      await sleep(600)
    })

    const found = await page.evaluate(() => {
      window.__mgRigMotionStop()

      const style = document.getElementById('mg-css')
      const seen = new Map()

      for (const item of window.__mgRigMotion) {
        if (!item.target.isConnected) {
          continue
        }

        const key = `${item.kind} ${item.name}${item.pseudo} @ ${item.target.dataset.slot ?? [...item.target.classList].find(cls => cls.startsWith('mg-')) ?? item.target.tagName.toLowerCase()}`

        if (seen.has(key)) {
          continue
        }

        const read = () => {
          const s = getComputedStyle(item.target, item.pseudo || null)

          return item.kind === 'animation' ? `${s.animationName} ${s.animationDuration}` : `${s.transitionProperty} ${s.transitionDuration}`
        }

        const withOurs = read()

        style.disabled = true

        const without = read()

        style.disabled = false
        seen.set(key, { key, ours: withOurs !== without || /^(mg-|mf-|monograph-)/.test(item.name), seconds: item.seconds, withOurs, without })
      }

      return [...seen.values()]
    })

    return { found, steps }
  }

  await checkIf('y5', async (entry, must) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })

    try {
      entry.evidence.mediaMatches = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)

      const { found, steps } = await motionRun(entry, 'MGY_REDUCED')
      const ours = found.filter(item => item.ours)

      entry.evidence.steps = steps
      entry.evidence.ours = ours.map(item => `${item.key} ${item.seconds}s (with #mg-css: ${item.withOurs}; without: ${item.without})`)
      entry.evidence.hermes = found.filter(item => !item.ours).map(item => `${item.key} ${item.seconds}s`).slice(0, 20)
      must(entry.evidence.mediaMatches, 'the page does not see prefers-reduced-motion: reduce')
      must(steps.every(name => !name.includes('FAILED')), `steps that failed: ${steps.filter(name => name.includes('FAILED')).join('; ')}`)
      must(!ours.length, `${ours.length} animation(s) or transition(s) of ours ran under reduced motion: ${entry.evidence.ours.slice(0, 4).join(' | ')}`)
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    }
  })

  await checkIf('y6', async (entry, must) => {
    // The plugin writes data-mg-motion from its settings; set it the way the
    // settings would, without a settings page to press.
    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'off'
    })

    try {
      const { found, steps } = await motionRun(entry, 'MGY_OFF')
      const ours = found.filter(item => item.ours)

      entry.evidence.steps = steps
      entry.evidence.ours = ours.map(item => `${item.key} ${item.seconds}s (with #mg-css: ${item.withOurs}; without: ${item.without})`)
      must(!ours.length, `${ours.length} animation(s) or transition(s) of ours ran with data-mg-motion="off": ${entry.evidence.ours.slice(0, 4).join(' | ')}`)
    } finally {
      await page.evaluate(() => {
        document.documentElement.dataset.mgMotion = 'on'
      })
    }
  })
  // ── y7. Grayscale ────────────────────────────────────────────────────────
  // Chrome is grayscale; colour is allowed only in bot, model and service
  // logos. Every state below is shot (at 1220x800 and at 1600x1000) and every
  // pixel whose channels differ by more than GRAY_SLACK is colour. A pixel
  // inside a marked logo box (LOGO_BOXES, plus 1 px) is allowed; any other
  // fails the check, with the element under it and which of its colours has
  // chroma. The shots double as the visual review set (item 5 of the brief).
  await checkIf('y7', async (entry, must) => {
    const { PNG } = createRequire(path.join(HERMES_REPO, 'package.json'))('pngjs')
    const GRAY_SLACK = 12
    // Bot faces, model logos (menu rows, home), service logos (tool rows,
    // agent panel), and images, which are content (avatars, pictures).
    const LOGO_BOXES = '[data-mg-service], .mg-logo, [data-slot="model-menu-row-icon"], [data-bot-face], img, video'
    const CELL = 24
    const sweeps = []
    const skipped = []
    const shown = selector => page.locator(selector).filter({ visible: true }).first()
    const press = async selector => {
      const box = await shown(selector).boundingBox({ timeout: 4000 })

      if (!box) {
        throw new Error(`nothing on screen for ${selector}`)
      }

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
    const closeAll = async () => {
      for (let i = 0; i < 4; i++) {
        const open = await page.evaluate(() =>
          [...document.querySelectorAll('[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"], [data-slot="command-input"], .mg-surfaces-menu, [role="menu"], [data-slot="popover-content"]')].some(node => node.checkVisibility())
        )

        if (!open) {
          break
        }

        await page.keyboard.press('Escape')
        await sleep(350)
      }
    }
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    // One state: shoot, find colour outside the logo boxes, name what is there.
    const sweep = async (name, { park = true } = {}) => {
      if (park) {
        await page.mouse.move(1, 420)
      }

      await sleep(450)
      await frames()

      const logos = await page.evaluate(selector => ({
        boxes: [...document.querySelectorAll(selector)]
          .filter(node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
          .map(node => node.getBoundingClientRect())
          .filter(r => r.width > 1 && r.height > 1)
          .map(r => ({ x: r.x - 1, y: r.y - 1, w: r.width + 2, h: r.height + 2 })),
        scale: devicePixelRatio,
        size: `${innerWidth}x${innerHeight}`
      }), LOGO_BOXES)
      const buffer = await page.screenshot({ animations: 'disabled', caret: 'hide' })
      const file = path.join(EVIDENCE, 'shots', `y7-${name}.png`)

      fs.writeFileSync(file, buffer)
      entry.screenshots.push(file)

      const image = PNG.sync.read(buffer)
      const { width, height, data } = image
      const allowed = new Uint8Array(width * height)

      for (const box of logos.boxes) {
        for (let y = Math.max(0, Math.floor(box.y * logos.scale)); y < Math.min(height, Math.ceil((box.y + box.h) * logos.scale)); y++) {
          allowed.fill(1, y * width + Math.max(0, Math.floor(box.x * logos.scale)), y * width + Math.min(width, Math.ceil((box.x + box.w) * logos.scale)))
        }
      }

      const cells = new Map()
      const light = new Map()
      let pixels = 0

      for (let p = 0; p < width * height; p++) {
        const i = p * 4
        const chroma = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])

        // Near-white pixels, per cell: a cell that is mostly white is a light
        // surface in a dark app (evidence only; a white primary button is one).
        if (Math.min(data[i], data[i + 1], data[i + 2]) >= 236) {
          const key = `${Math.floor((p % width) / logos.scale / CELL)},${Math.floor(Math.floor(p / width) / logos.scale / CELL)}`

          light.set(key, (light.get(key) ?? 0) + 1)
        }

        if (chroma <= GRAY_SLACK || allowed[p]) {
          continue
        }

        pixels += 1

        const x = (p % width) / logos.scale
        const y = Math.floor(p / width) / logos.scale
        const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
        const cell = cells.get(key) ?? { n: 0, x, y, chroma: 0, rgb: null }

        cell.n += 1

        if (chroma > cell.chroma) {
          Object.assign(cell, { chroma, rgb: `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`, x, y })
        }

        cells.set(key, cell)
      }

      // The worst places, each named by the element there.
      const places = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 10)
      const named = await page.evaluate(points => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        const chroma = colour => {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = '#000'
          ctx.fillStyle = colour
          ctx.fillRect(0, 0, 1, 1)

          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data

          return a > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 12
        }
        const describe = node => {
          const classes = [...node.classList].filter(cls => cls.length < 40).slice(0, 3).map(cls => `.${cls}`).join('')
          const attrs = ['data-slot', 'data-tour', 'role', 'data-state', 'aria-label'].filter(name => node.hasAttribute(name)).map(name => `[${name}="${node.getAttribute(name).slice(0, 24)}"]`).join('')

          return `${node.tagName.toLowerCase()}${attrs}${classes}`
        }
        const coloured = node => {
          const found = []

          for (const pseudo of [null, '::before', '::after']) {
            const style = getComputedStyle(node, pseudo)

            for (const prop of ['color', 'background-color', 'border-top-color', 'border-left-color', 'outline-color', 'fill', 'stroke', 'text-decoration-color']) {
              const value = style.getPropertyValue(prop)

              if (value && chroma(value) && !(prop === 'outline-color' && style.outlineStyle === 'none') && !(prop.startsWith('border') && parseFloat(style.getPropertyValue(prop.replace('color', 'width'))) === 0)) {
                found.push(`${pseudo ?? ''}${prop} ${value}`)
              }
            }

            for (const prop of ['box-shadow', 'background-image']) {
              const value = style.getPropertyValue(prop)

              if (value && value !== 'none' && (value.match(/(rgba?|oklab|oklch|color)\([^)]*\)/g) ?? []).some(chroma)) {
                found.push(`${pseudo ?? ''}${prop} ${value.slice(0, 80)}`)
              }
            }
          }

          return found
        }

        return points.map(point => {
          const chain = []

          for (let node = document.elementFromPoint(point.x, point.y), up = 0; node && up < 6; node = node.parentElement, up++) {
            const props = coloured(node)

            if (props.length || up === 0) {
              chain.push(`${describe(node)}${props.length ? ` {${props.join('; ')}}` : ''}`)
            }

            if (props.length) {
              break
            }
          }

          const selection = getSelection()?.toString() ? ' (a text selection is up)' : ''

          return `${point.n} px near ${Math.round(point.x)},${Math.round(point.y)} ${point.rgb}${selection}: ${chain.join(' < ')}`
        })
      }, places)

      if (pixels) {
        const out = new PNG({ height, width })

        for (let p = 0; p < width * height; p++) {
          const i = p * 4
          const chroma = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
          const hit = chroma > GRAY_SLACK && !allowed[p]

          out.data[i] = hit ? 255 : Math.round(data[i] * 0.3)
          out.data[i + 1] = hit ? 0 : Math.round(data[i + 1] * 0.3)
          out.data[i + 2] = hit ? 0 : Math.round(data[i + 2] * 0.3)
          out.data[i + 3] = 255
        }

        fs.writeFileSync(file.replace(/\.png$/, '-colour.png'), PNG.sync.write(out))
      }

      const full = CELL * CELL * logos.scale * logos.scale * 0.8
      const lightCells = [...light.entries()].filter(([, n]) => n >= full).map(([key]) => key)
      const result = { name, size: logos.size, pixels, logos: logos.boxes.length, places: named, lightCells }

      sweeps.push(result)

      return result
    }

    // A state that cannot be reached is tried once more after closing what
    // is open; a second failure is a skipped state, and a skipped state
    // fails the check (a state never shot is a state never judged).
    const retried = []
    const step = async (name, fn) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await fn()

          return
        } catch (error) {
          await closeAll().catch(() => undefined)
          await page.keyboard.press('Escape').catch(() => undefined)

          if (attempt === 2) {
            skipped.push(`${name}: ${String(error.message).split('\n')[0]}`)
          } else {
            retried.push(`${name}: ${String(error.message).split('\n')[0]}`)
            await sleep(800)
          }
        }
      }
    }

    // Self-test: a small blue square, planted on the field, must be found.
    await page.evaluate(() => {
      const node = document.createElement('div')

      node.id = 'mg-rig-blue'
      Object.assign(node.style, { background: '#2f6bff', height: '6px', left: '600px', position: 'fixed', top: '400px', width: '6px', zIndex: 99999 })
      document.body.appendChild(node)
    })

    const planted = await sweep('planted-blue')

    await page.evaluate(() => document.getElementById('mg-rig-blue')?.remove())
    sweeps.pop()
    entry.evidence.plantedCaught = planted.pixels >= 30 ? `${planted.pixels} px: ${planted.places[0]}` : null
    must(planted.pixels >= 30, `self-test: a planted 6x6 blue square gave ${planted.pixels} coloured pixel(s)`)

    // Content the states need: a code block and a table, a tool call that
    // fails (an error), a diff, and the approval card.
    await step('content', async () => {
      await type('A failing call, MGY_ERR. MGS_CALL(terminal)[{"command":"ls /mg-rig-no-such-dir"}]', 'Enter')
      await waitIdle('MGY_ERR MGS_CALL_DONE', 60_000)
      await type('Write a file, MGY_WRITE. MGS_CALL(write_file)[{"path":"mg-rig-diff.txt","content":"alpha\\nbeta\\n"}]', 'Enter')
      await waitIdle('MGY_WRITE MGS_CALL_DONE', 60_000)
      await type('Patch it, MGY_PATCH. MGS_CALL(patch)[{"mode":"replace","path":"mg-rig-diff.txt","old_string":"beta","new_string":"gamma"}]', 'Enter')
      await waitIdle('MGY_PATCH MGS_CALL_DONE', 60_000)
      // The model's short reply carries a list and a code block. Last, so it
      // is drawn (Hermes unmounts turns far above the view).
      await type('A list and some code, MGY_CODE.', 'Enter')
      await waitIdle('Done MGY_CODE', 60_000)
      // Code in five languages and a table (LANGS_REPLY, this suite's model).
      await type('Five languages and a table, MGY_LANGS.', 'Enter')
      await waitIdle('Done MGY_LANGS', 60_000)
      await sleep(1200)
    })

    const thread = async () => {
      await page.evaluate(VIEWPORT => {
        const view = [...document.querySelectorAll(VIEWPORT)].find(node => node.getBoundingClientRect().height > 0)

        if (view) {
          view.scrollTop = view.scrollHeight
        }
      }, VIEWPORT)
      await sleep(500)
    }

    // Open every fold on screen, so tool rows (the error, the diff) show.
    const openFolds = () =>
      page.evaluate(() => {
        for (const line of document.querySelectorAll('.mg-line[data-mg-steps]:not([data-mg-open])')) {
          const head = line.nextElementSibling

          if (line.checkVisibility() && head) {
            head.click()
          }
        }
      })

    const walk = async tag => {
      await step(`${tag} thread`, async () => {
        await closeAll()
        await thread()
        await sweep(`${tag}-thread`)
      })
      await step(`${tag} work open (error, diff)`, async () => {
        await openFolds()
        await sleep(800)
        await thread()
        await sweep(`${tag}-work-open`)
      })
      await step(`${tag} code block`, async () => {
        await page.evaluate(() => {
          // A code block in a reply (MGY_LONG's), not a tool row's output.
          const code = [...document.querySelectorAll('[data-slot="aui_assistant-message-content"] pre')].filter(node => node.checkVisibility() && !node.closest('[data-slot="tool-block"]')).at(-1)

          if (!code) {
            throw new Error('no code block in a reply')
          }

          code.scrollIntoView({ block: 'center' })
        })
        await sleep(500)
        await sweep(`${tag}-code`)
      })
      // The five-language reply, in two views, and its table.
      for (const [label, lang] of [['langs-ts-py', 'ts'], ['langs-bash-json-diff', 'bash']]) {
        await step(`${tag} ${label}`, async () => {
          await page.evaluate(lang => {
            const blocks = [...document.querySelectorAll('[data-slot="aui_assistant-message-content"] pre')].filter(node => node.checkVisibility() && !node.closest('[data-slot="tool-block"]'))
            const pre = blocks.find(node => (node.closest('[data-language], .aui-shiki')?.textContent ?? node.textContent).includes(lang === 'ts' ? 'export async function load' : 'set -euo pipefail'))

            if (!pre) {
              throw new Error(`no ${lang} block of MGY_LANGS on screen`)
            }

            pre.scrollIntoView({ block: 'start' })
            pre.closest('[data-slot="aui_thread-viewport"]')?.scrollBy(0, -60)
          }, lang)
          await sleep(600)
          await sweep(`${tag}-${label}`)
        })
      }
      await step(`${tag} table`, async () => {
        await page.evaluate(() => {
          const table = [...document.querySelectorAll('[data-slot="aui_assistant-message-content"] table')].filter(node => node.checkVisibility()).at(-1)

          if (!table) {
            throw new Error('no table in a reply')
          }

          table.scrollIntoView({ block: 'center' })
        })
        await sleep(500)
        await sweep(`${tag}-table`)
      })
      await step(`${tag} toasts`, async () => {
        // Hermes' own toasts, raised through the plugin SDK's host.notify.
        for (const kind of ['success', 'error']) {
          await page.evaluate(kind => globalThis.__HERMES_PLUGIN_SDK__.host.notify({ durationMs: 8000, kind, message: kind === 'error' ? 'Could not save (a planted failure)' : 'Saved (a planted success)' }), kind)
          await sleep(900)
          await sweep(`${tag}-toast-${kind}`)
        }
      })
      await step(`${tag} link and selection`, async () => {
        // A link as Hermes draws one in a reply (planted, removed after),
        // and a text selection across a paragraph.
        await page.evaluate(() => {
          const para = [...document.querySelectorAll('[data-slot="aui_assistant-message-content"] .aui-md p')].filter(node => node.checkVisibility()).at(-1)

          if (!para) {
            throw new Error('no paragraph in a reply')
          }

          para.scrollIntoView({ block: 'center' })

          // As markdown-text.tsx draws a link: an <a class="ref">.
          const link = document.createElement('a')

          link.className = 'ref wrap-anywhere'
          link.id = 'mg-rig-link'
          link.href = 'https://example.com/'
          link.textContent = 'a link in a reply'
          para.append(' ', link)

          const range = document.createRange()

          range.selectNodeContents(para.firstChild ?? para)
          getSelection().removeAllRanges()
          getSelection().addRange(range)
        })
        await sleep(300)
        await sweep(`${tag}-link-selection`)
        await page.evaluate(() => {
          getSelection().removeAllRanges()
          document.getElementById('mg-rig-link')?.remove()
        })
      })

      for (const [menu, selector] of [
        ['surfaces', '[data-tour="mg-surfaces"] .mg-surfaces-hit'],
        ['model', 'button:is([data-tour="model-pill"], [aria-label^="Model · "])'],
        ['effort', '[data-testid="reasoning-pill"]'],
        ['approval', '.mg-chip[data-mg-approval]']
      ]) {
        await step(`${tag} ${menu} menu`, async () => {
          await closeAll()
          await press(selector)
          await sleep(700)
          await sweep(`${tag}-menu-${menu}`, { park: false })
          await closeAll()
        })
      }

      await step(`${tag} model submenu`, async () => {
        await closeAll()
        await press('button:is([data-tour="model-pill"], [aria-label^="Model · "])')
        await sleep(600)

        const row = shown('[data-slot="dropdown-menu-sub-trigger"]')

        await row.hover()
        await sleep(700)
        await sweep(`${tag}-menu-model-hover`, { park: false })
        await closeAll()
      })
      await step(`${tag} palette`, async () => {
        await closeAll()
        await page.keyboard.press('Meta+k')
        await shown('[data-slot="command-input"]').waitFor({ timeout: 5000 })
        await sleep(400)
        await sweep(`${tag}-palette`)
        // What paints the palette's search field and a keycap (evidence).
        entry.evidence[`palette${tag}`] = await page.evaluate(() => {
          const chain = node => {
            const out = []

            for (let up = node, i = 0; up && i < 5; up = up.parentElement, i++) {
              const style = getComputedStyle(up)

              out.push(`${up.tagName.toLowerCase()}${up.dataset.slot ? `[${up.dataset.slot}]` : ''} bg ${style.backgroundColor} fg ${style.color}`)
            }

            return out.join(' < ')
          }
          const input = [...document.querySelectorAll('[data-slot="command-input"]')].find(node => node.checkVisibility())
          const kbd = [...document.querySelectorAll('[cmdk-item] kbd, [data-slot="command-item"] kbd, [data-slot="command-item"] [data-slot="kbd"]')].find(node => node.checkVisibility())

          return { input: input ? chain(input) : null, kbd: kbd ? chain(kbd) : null }
        })
        await closeAll()
      })
      await step(`${tag} context menu`, async () => {
        await closeAll()
        await shown('[data-slot="row-button"]').click({ button: 'right' })
        await sleep(600)
        await sweep(`${tag}-context-menu`, { park: false })
        await closeAll()
      })
      await step(`${tag} tooltip`, async () => {
        await closeAll()
        await shown('[data-tour="mg-surfaces"]').hover()
        await sleep(1400)
        await sweep(`${tag}-tooltip`, { park: false })
      })
      await step(`${tag} focus rings`, async () => {
        // Keyboard focus, so :focus-visible holds: from the message box, Tab
        // until the surfaces button, then until the approval chip.
        await page.mouse.move(1, 420)

        for (const [target, label, key] of [['[data-tour="mg-surfaces"]', 'surfaces', 'Tab'], ['.mg-chip[data-mg-approval]', 'chip', 'Shift+Tab']]) {
          await page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first().click()

          let reached = false

          for (let i = 0; i < 90 && !reached; i++) {
            await page.keyboard.press(key)
            reached = await page.evaluate(target => Boolean(document.activeElement?.closest(target)), target)
          }

          if (!reached) {
            throw new Error(`Tab never reached ${target}`)
          }

          await sweep(`${tag}-focus-${label}`, { park: false })
        }
      })
      await step(`${tag} surfaces`, async () => {
        // Our own pages and panel, by their rows in the surfaces menu.
        for (const [label, slug] of [['Home', 'home'], ['Knowledge', 'knowledge'], ['Agent', 'agent-panel']].filter(([, id]) => id !== 'knowledge' || hasModule('knowledge'))) {
          await closeAll()
          await press('[data-tour="mg-surfaces"] .mg-surfaces-hit')
          await page.locator('.mg-surfaces-menu').filter({ visible: true }).first().waitFor({ timeout: 3000 })
          await sleep(300)
          await page.locator('.mg-surface-row', { hasText: new RegExp(`^${label}`) }).filter({ visible: true }).first().click({ timeout: 3000 })
          await sleep(1200)
          await sweep(`${tag}-${slug}`)

          if (slug === 'agent-panel') {
            await press('[data-tour="mg-surfaces"] .mg-surfaces-hit')
            await sleep(500)
            await page.locator('.mg-surface-row', { hasText: /^Agent/ }).filter({ visible: true }).first().click({ timeout: 3000 })
            await sleep(800)
          }
        }

        await shown('[data-slot="row-button"]').click()
        await sleep(1200)
      })
      await step(`${tag} diff surface`, async () => {
        // The Diff surface (Hermes' review pane), beside the thread; its
        // row in the surfaces menu toggles it, ⌘G as well.
        const open = () => page.evaluate(() => [...document.querySelectorAll('body *')].some(node => node.childElementCount === 0 && /^no diffs$/i.test(node.textContent.trim()) && node.checkVisibility()) || Boolean([...document.querySelectorAll('[data-slot="file-diff-panel"]')].find(node => node.checkVisibility() && node.closest('aside, [data-pane], [data-slot*="right"]'))))

        await closeAll()
        await press('[data-tour="mg-surfaces"] .mg-surfaces-hit')
        await page.locator('.mg-surfaces-menu').filter({ visible: true }).first().waitFor({ timeout: 3000 })
        await page.locator('.mg-surface-row', { hasText: /^Diff/ }).filter({ visible: true }).first().click({ timeout: 3000 })
        await sleep(1200)
        await sweep(`${tag}-diff`)

        for (let i = 0; i < 2 && (await open()); i++) {
          await page.keyboard.press('Meta+g')
          await sleep(700)
        }

        if (await open()) {
          throw new Error('the Diff surface did not close')
        }
      })
      // A Settings page by its nav row. A press that Playwright cannot land
      // (y7 lost the five rows under Web access at 1220 px once in three
      // runs, "click: Timeout 4000ms") records what was at the row's centre
      // and how the nav sat, then goes by keyboard: the row focused, Enter.
      // Either way the page must change.
      const navTo = async (nav, label) => {
        const row = shown(`[data-tour="${nav}"]`)
        const page$ = () => page.evaluate(() => document.querySelector('[data-overlay-surface]')?.innerText.slice(0, 400) ?? '')
        const before = await page$()
        try {
          await row.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined)
          await row.click({ timeout: 4000 })
        } catch (error) {
          const why = await row.evaluate(node => {
            const r = node.getBoundingClientRect()
            const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            const scroller = node.closest('nav, [data-radix-scroll-area-viewport], [class*="overflow"]')
            return {
              at: at ? `${at.tagName.toLowerCase()}.${String(at.className).slice(0, 60)}${node.contains(at) ? ' (inside the row)' : ''}` : null,
              box: [r.x, r.y, r.width, r.height].map(Math.round),
              running: node.getAnimations({ subtree: true }).map(a => a.animationName ?? a.transitionProperty ?? a.constructor.name),
              scroller: scroller ? { h: scroller.clientHeight, scrollH: scroller.scrollHeight, top: Math.round(scroller.scrollTop) } : null,
              open: [...document.querySelectorAll('[data-state="open"]')].map(n => n.getAttribute('data-slot') || n.tagName.toLowerCase()).slice(0, 6),
              vh: window.innerHeight
            }
          }).catch(e => ({ error: String(e.message).split('\n')[0] }))
          ;(entry.evidence.navMisses ??= []).push({ label, error: String(error.message).split('\n')[0], why })
          results.observations.push(`y7 nav miss ${label}: ${JSON.stringify(why).slice(0, 300)}`)
          await row.focus()
          await page.keyboard.press('Enter')
          // Two rows can open the same page (a group and its first child),
          // so the keyboard path checks the page changed or the row is now
          // the current one.
          await page
            .waitForFunction(
              ({ before, nav }) => {
                const node = [...document.querySelectorAll(`[data-tour="${nav}"]`)].find(n => n.checkVisibility())
                const current = node && (node.getAttribute('aria-current') || node.matches('[data-active="true"], [data-state="active"], [aria-selected="true"]'))
                return Boolean(current) || (document.querySelector('[data-overlay-surface]')?.innerText.slice(0, 400) ?? '') !== before
              },
              { before, nav },
              { timeout: 3000 }
            )
            .catch(() => {
              throw new Error(`${nav}: the click could not land and Enter did not open the page`)
            })
        }
      }
      await step(`${tag} settings`, async () => {
        await closeAll()
        await page.keyboard.press('Meta+,')
        await shown('[data-tour="nav-plugins"]').waitFor({ timeout: 8000 })
        await sleep(600)

        // One shot per page (the nav-toggle-* buttons fold a group open
        // and shut; they are not pages).
        const navs = await page.evaluate(() => [...document.querySelectorAll('[data-tour^="nav-"]:not([data-tour^="nav-toggle-"])')].filter(node => node.checkVisibility()).map(node => node.dataset.tour))

        entry.evidence.settingsPages = navs

        try {
          for (const nav of navs) {
            await step(`${tag} settings ${nav}`, async () => {
              await navTo(nav, `${tag} ${nav}`)
              await sleep(900)
              await sweep(`${tag}-settings-${nav.replace(/^nav-/, '').replace(/:/g, '-')}`)
            })
          }

          // Monograph's own page (Appearance), its switches, one focused.
          await shown('[data-tour="nav-plugins"]').click({ timeout: 4000 })
          await sleep(600)
          await page.locator('button, a', { hasText: /^Monograph$/ }).filter({ visible: true }).first().click({ timeout: 5000 })
          await sleep(900)
          await sweep(`${tag}-settings-monograph`)

          const toggle = shown('[role="switch"]')

          if (await toggle.count()) {
            await toggle.focus()
            await page.keyboard.press('Shift+Tab')
            await page.keyboard.press('Tab')
            await sleep(300)
            await sweep(`${tag}-settings-switch-focus`, { park: false })
          }
        } finally {
          await press('button[aria-label="Close settings"]').catch(() => page.keyboard.press('Escape'))
          await sleep(800)
        }
      })
    }

    // The approval card: approval mode Manual, a command that needs it.
    await step('approval card', async () => {
      await closeAll()
      await press('.mg-chip[data-mg-approval]')
      await sleep(500)
      await page.locator('[role="menuitem"], [role="menuitemradio"]', { hasText: /^Manual/ }).filter({ visible: true }).first().click({ timeout: 3000 })
      await sleep(500)
      await type('Something risky, MGY_APPROVE. MGS_CALL(terminal)[{"command":"rm -rf /tmp/mg-rig-approval-probe"}]', 'Enter')
      await shown('[data-slot="tool-approval-card"], [data-slot="tool-approval-stack"]').waitFor({ state: 'visible', timeout: 30_000 })
      await sleep(800)
      await sweep('1220-approval-card')

      const deny = page.locator('[data-slot="tool-approval-actions"] button', { hasText: /deny|reject|no/i }).filter({ visible: true }).first()

      if (await deny.count()) {
        await deny.click()
      } else {
        await shown('button[aria-label="Stop"]').click()
      }

      await page.waitForFunction(running => !document.querySelector(running), RUNNING, { timeout: 30_000 }).catch(() => undefined)
      await press('.mg-chip[data-mg-approval]')
      await sleep(500)
      await page.locator('[role="menuitem"], [role="menuitemradio"]', { hasText: /^Off/ }).filter({ visible: true }).first().click({ timeout: 3000 })
      await sleep(500)
    })

    try {
      await setWindow({ height: 800, width: 1220, zoom: 1 })
      await sleep(800)
      await walk('1220')
      await setWindow({ height: 1000, width: 1600, zoom: 1 })
      await sleep(800)
      await walk('1600')
    } finally {
      await setWindow({ height: 800, width: 1220, zoom: 1 }).catch(() => undefined)
    }

    const coloured = sweeps.filter(item => item.pixels)

    entry.evidence.states = sweeps.length
    entry.evidence.statesShot = sweeps.map(item => `${item.name} ${item.size}${item.pixels ? ` COLOUR ${item.pixels} px` : ''}`)
    entry.evidence.colour = coloured.map(item => `${item.name}: ${item.pixels} px; ${item.places.slice(0, 4).join(' | ')}`)
    entry.evidence.skipped = skipped
    entry.evidence.retried = retried
    must(!skipped.length, `${skipped.length} state(s) could not be reached after a retry: ${skipped.join(' | ').slice(0, 800)}`)
    entry.evidence.lightSurfaces = sweeps.filter(item => item.lightCells.length).map(item => `${item.name}: ${item.lightCells.length} cell(s) of ${CELL} px mostly white, first at ${item.lightCells.slice(0, 3).map(key => key.split(',').map(n => n * CELL).join(',')).join(' ')}`)
    must(sweeps.length >= 20, `only ${sweeps.length} states were shot`)
    must(!coloured.length, `${coloured.length} state(s) show colour outside logos: ${coloured.map(item => `${item.name} ${item.pixels} px (${item.places[0] ?? ''})`).join(' || ').slice(0, 1500)}`)
  })
  // ── y8. Sidebar row strength ─────────────────────────────────────────────
  // Four sessions: one pinned, one unread, one selected (and then also
  // unread), one with a turn running. Each row's title is measured as drawn:
  // colour over its real background, weight, and the row's fill.
  await checkIf('y8', async (entry, must) => {
    const { mock } = state

    // MG_A11Y_PLANT=y8: the running title breathes down to 0.2, which y8
    // must catch.
    if (process.env.MG_A11Y_PLANT === 'y8') {
      await page.evaluate(() => {
        const style = document.createElement('style')

        style.id = 'mg-rig-plant-y8'
        // A keyframes rule of its own, named by a rule that outranks ours
        // (a second @keyframes mg-working lost to the plugin's own, which can
        // be put back after this one, so the plant never took).
        style.textContent = '@keyframes mg-rig-plant-y8 { 0%, 100% { opacity: 0.2; } 50% { opacity: 1; } } html [data-slot="sidebar"] :is(.row-hover[data-working="true"], .mf-srow[data-working="true"]) :is(.hover-marquee-inner, .mf-stitle) { animation-name: mg-rig-plant-y8 !important; }'
        document.head.append(style)
      })
    }
    const row = text => page.locator('[data-slot="row-button"]', { hasText: text }).filter({ visible: true }).first()
    const fresh = async () => {
      await page.keyboard.press('Meta+n')
      await sleep(1000)
    }
    // A row's menu item, if the menu has it (a session that finished while
    // another was open is unread already, and offers "Mark as read").
    const menu = async (text, item) => {
      await row(text).click({ button: 'right' })
      await sleep(400)

      const option = page.getByRole('menuitem', { name: item, exact: true })

      if (await option.count()) {
        await option.click({ timeout: 5000 })
      } else {
        await page.keyboard.press('Escape')
      }

      await sleep(700)
    }
    const read = () =>
      page.evaluate(() => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        const rgba = colour => {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = '#000'
          ctx.fillStyle = colour
          ctx.fillRect(0, 0, 1, 1)

          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data

          return [r, g, b, a / 255]
        }
        const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3])).concat(1)
        const lum = ([r, g, b]) => {
          const lin = v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)

          return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        }
        const out = {}

        for (const shell of document.querySelectorAll('[data-slot="sidebar"] .row-hover')) {
          const title = shell.querySelector('.hover-marquee-inner')

          if (!title || !title.checkVisibility()) {
            continue
          }

          const layers = []

          for (let up = title; up; up = up.parentElement) {
            const c = rgba(getComputedStyle(up).backgroundColor)

            if (c[3] > 0) {
              layers.push(c)

              if (c[3] >= 1) {
                break
              }
            }
          }

          const bg = layers.reverse().reduce((b, t) => over(t, b), [12, 12, 13, 1])
          let opacity = 1

          for (let up = title; up && up !== shell.parentElement; up = up.parentElement) {
            opacity *= Number(getComputedStyle(up).opacity)
          }

          const style = getComputedStyle(title)
          const ink = rgba(style.color)
          const fg = over([...ink.slice(0, 3), ink[3] * opacity], bg)
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)

          out[title.textContent.trim().slice(0, 24)] = {
            fill: getComputedStyle(shell).backgroundColor,
            fg: `rgb(${fg.slice(0, 3).map(Math.round).join(', ')})`,
            ink: +lum(fg).toFixed(3),
            ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2),
            selected: shell.className.includes('bg-(--ui-row-active-background)'),
            unread: Boolean(shell.querySelector('[aria-label="Finished — unread"]')),
            weight: style.fontWeight,
            working: shell.dataset.working === 'true',
            pinned: Boolean(shell.closest('[data-slot="sidebar-group"], section, li')?.closest('[aria-label*="Pinned" i], [data-section="pinned"]')) || /pinned/i.test(shell.closest('[data-slot="sidebar-group"], section')?.querySelector('h2, h3, [data-slot="sidebar-group-label"]')?.textContent ?? ''),
            // A shimmer title is painted by its background (text clip): its
            // dimmest moment is the dimmest colour in the gradient.
            dimmest: (() => {
              const stops = (getComputedStyle(title).backgroundImage.match(/rgba?\([^)]*\)/g) ?? []).map(rgba).map(c => over(c, bg))

              // Since wave 4 (55-motion.css) the running title is solid ink
              // that breathes on opacity: its dimmest moment is its ink at
              // the lowest opacity of its running animations' keyframes,
              // times its ancestors' opacity, over the row.
              if (!stops.length) {
                const breaths = title.getAnimations().map(a => {
                  const frames = a.effect?.getKeyframes?.() ?? []

                  return { name: a.animationName ?? '', low: Math.min(1, ...frames.map(f => (f.opacity === undefined || f.opacity === '' ? 1 : Number(f.opacity)))) }
                })
                let above = 1

                for (let up = title.parentElement; up && up !== shell.parentElement; up = up.parentElement) {
                  above *= Number(getComputedStyle(up).opacity)
                }

                if (!breaths.length) {
                  return null
                }

                const floor = Math.min(...breaths.map(b => b.low))
                const ink = rgba(getComputedStyle(title).color)
                const dim = over([...ink.slice(0, 3), ink[3] * above * floor], bg)
                const [h2, l2] = [lum(dim), lum(bg)].sort((x, y) => y - x)

                return { breath: breaths.map(b => `${b.name} ${b.low}`).join(', '), fg: `rgb(${dim.slice(0, 3).map(Math.round).join(', ')})`, ratio: +((h2 + 0.05) / (l2 + 0.05)).toFixed(2) }
              }

              const low = stops.sort((x, y) => lum(x) - lum(y))[0]
              const [h2, l2] = [lum(low), lum(bg)].sort((x, y) => y - x)

              return { fg: `rgb(${low.slice(0, 3).map(Math.round).join(', ')})`, ratio: +((h2 + 0.05) / (l2 + 0.05)).toFixed(2) }
            })(),
            ring: (() => {
              const time = shell.querySelector('time')
              const after = time && getComputedStyle(time, '::after')

              return after && after.content !== 'none' ? `${after.width} ${after.borderTopStyle} ${after.borderTopWidth} radius ${after.borderTopLeftRadius}` : null
            })()
          }
        }

        return out
      })

    try {
      await fresh()
      await type('Second session, MGY_TWO.', 'Enter')
      await waitIdle('Done MGY_TWO', 60_000)
      await fresh()
      await type('Third session, MGY_THREE.', 'Enter')
      await waitIdle('Done MGY_THREE', 60_000)
      await fresh()
      await type('Fourth session, MGY_FOUR. MGS_HOLD', 'Enter')
      await Promise.race([mock?.waitForHeldStream?.(), sleep(15_000)])
      await sleep(800)
      await row('Third session').click()
      await sleep(1000)
      await menu('Second session', 'Mark as unread')
      await menu('A11y setup', 'Pin')
      await page.mouse.move(1, 420)
      await sleep(600)

      const states = await read()
      const pick = test => Object.entries(states).find(([, item]) => test(item))?.[1]
      const selected = pick(item => item.selected && !item.working)
      const unread = pick(item => item.unread && !item.selected)
      const idle = pick(item => !item.unread && !item.selected && !item.working)
      const working = pick(item => item.working)

      entry.evidence.rows = states
      await shot(entry, 'y8-sidebar-rows')

      // Self-test: the selected title planted back to the third step (the
      // look before this check) must read as dimmer than the unread one.
      await page.evaluate(() => {
        const style = document.createElement('style')

        style.id = 'mg-rig-dim-selected'
        style.textContent = 'html body [data-slot="sidebar"] .row-hover[class~="bg-(--ui-row-active-background)"] .hover-marquee-inner { color: var(--mg-text-3) !important; }'
        document.head.append(style)
      })
      // The title's colour transition (120 ms) must finish before it is read.
      await sleep(500)

      const planted = Object.values(await read())

      await page.evaluate(() => document.getElementById('mg-rig-dim-selected')?.remove())
      await sleep(500)

      const plantedSelected = planted.find(item => item.selected && !item.working)
      const plantedUnread = planted.find(item => item.unread && !item.selected)

      entry.evidence.plantedCaught = Boolean(plantedSelected && plantedUnread && plantedSelected.ink < plantedUnread.ink)
      must(entry.evidence.plantedCaught, 'self-test: a selected title dimmed to --mg-text-3 was not seen as dimmer than the unread one')

      // Hover an idle row.
      const idleName = Object.entries(states).find(([, item]) => item === idle)?.[0]

      if (idleName) {
        await row(idleName).hover()
        await sleep(500)
        entry.evidence.idleHovered = (await read())[idleName]
        await shot(entry, 'y8-sidebar-hover')
        await page.mouse.move(1, 420)
      }

      // The selected row, unread as well.
      await menu('Third session', 'Mark as unread').catch(error => {
        entry.evidence.selectedUnread = `could not mark: ${String(error.message).split('\n')[0]}`
      })

      const both = Object.values(await read()).find(item => item.selected)

      entry.evidence.selectedAndUnread = both ?? null
      await shot(entry, 'y8-sidebar-selected-unread')

      must(selected && unread && idle, `rows missing: selected ${Boolean(selected)}, unread ${Boolean(unread)}, idle ${Boolean(idle)}`)

      if (selected && unread && idle) {
        must(selected.fill !== 'rgba(0, 0, 0, 0)', 'the selected row has no fill')
        must(selected.ink >= unread.ink, `the selected title (${selected.fg}) is dimmer than an unread one (${unread.fg})`)
        must(unread.ink > idle.ink, `an unread title (${unread.fg}) is no brighter than an idle one (${idle.fg})`)

        for (const [name, item] of Object.entries({ idle, selected, unread })) {
          must(item.ratio >= 4.5, `the ${name} row's title is ${item.ratio}:1`)
        }
      }

      if (entry.evidence.idleHovered && idle) {
        must(entry.evidence.idleHovered.ink > idle.ink && entry.evidence.idleHovered.ratio >= 4.5, `hover does not lift an idle title readably: ${JSON.stringify(entry.evidence.idleHovered)}`)
      }

      if (both) {
        must(both.ink >= (selected?.ink ?? 0) && both.fill !== 'rgba(0, 0, 0, 0)', `selected and unread reads weaker than selected: ${JSON.stringify(both)}`)
      }

      entry.evidence.working = working ?? 'no running row seen'

      // The pinned row ("A11y setup") and the running one ("Fourth"):
      // readable, the running one at its dimmest moment, and its state told
      // with motion off by the ring that replaces the time.
      const pinnedRow = states[Object.keys(states).find(name => name.startsWith('A11y setup'))]

      entry.evidence.pinnedRow = pinnedRow ?? 'not seen'
      must(pinnedRow && pinnedRow.ratio >= 4.5, `the pinned row's title is not readable: ${JSON.stringify(pinnedRow)}`)
      must(working && working.dimmest && working.dimmest.ratio >= 4.5, `the running row's title at its dimmest is under 4.5:1: ${JSON.stringify(working?.dimmest ?? working)}`)
      await setMotion('off')
      await sleep(400)

      const still = Object.values(await read()).find(item => item.working)

      await shot(entry, 'y8-sidebar-running-motion-off')
      await setMotion('on')
      entry.evidence.workingMotionOff = still ?? null
      must(still?.ring && /solid/.test(still.ring), `with motion off the running row shows no ring in place of its time: ${JSON.stringify(still ?? null)}`)
    } finally {
      mock?.releaseHeldStream?.()
      await sleep(1500)
    }
  })
  // ── y9. Meaning without colour ──────────────────────────────────────────
  // Every state that a hue used to tell (red, green, amber) must be told by
  // something that survives grayscale: a glyph node, a weight, a shape (an
  // edge, a dash) or text. Each is reached for real where the rig can (the
  // session menu, the delete dialog, a provider error, a failed call, a
  // patch, an approval, Hermes' toasts); the invalid field is planted (no
  // Settings form in the sandbox can be left empty and submitted). Self-test:
  // the diff marks planted away must be caught.
  await checkIf('y9', async (entry, must) => {
    const shown = selector => page.locator(selector).filter({ visible: true }).first()
    const press = async selector => {
      const box = await shown(selector).boundingBox({ timeout: 4000 })

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }
    const openFolds = () =>
      page.evaluate(() => {
        for (const head of document.querySelectorAll('[data-mg-head][data-mg-steps]')) {
          if (head.checkVisibility() && !head.closest('[data-mg-open]')) {
            head.click()
          }
        }
      })
    const toBottom = () =>
      page.evaluate(VIEWPORT => {
        const view = [...document.querySelectorAll(VIEWPORT)].find(node => node.getBoundingClientRect().height > 0)

        if (view) {
          view.scrollTop = view.scrollHeight
        }
      }, VIEWPORT)
    // Contrast of two CSS colours (alpha laid over `under`), in the page.
    await page.evaluate(() => {
      window.__mgRigContrast = (a, b, under = 'rgb(20, 20, 21)') => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        const rgba = colour => {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = under
          ctx.fillRect(0, 0, 1, 1)
          ctx.fillStyle = colour
          ctx.fillRect(0, 0, 1, 1)

          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
        }
        const lum = c => {
          const lin = v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)

          return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
        }
        const [hi, lo] = [lum(rgba(a)), lum(rgba(b))].sort((x, y) => y - x)

        return +((hi + 0.05) / (lo + 0.05)).toFixed(2)
      }
    })
    const cues = {}
    const part = async (name, fn) => {
      try {
        cues[name] = await fn()
      } catch (error) {
        cues[name] = { error: String(error.message).split('\n')[0] }
      }
    }
    const diffMarks = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-slot="file-diff-panel"] span[class~="whitespace-pre"]')].filter(node => node.checkVisibility())
        const kind = node => (/ui-diff-add-background/.test(node.className) ? 'add' : /ui-diff-remove-background/.test(node.className) ? 'remove' : 'context')
        const read = node => ({ before: getComputedStyle(node, '::before').content, bg: getComputedStyle(node).backgroundColor, edge: `${getComputedStyle(node).borderLeftStyle} ${getComputedStyle(node).borderLeftColor}`, strike: getComputedStyle(node).textDecorationLine, text: node.textContent.slice(0, 20) })
        const add = rows.find(node => kind(node) === 'add')
        const remove = rows.find(node => kind(node) === 'remove')

        return { add: add ? read(add) : null, remove: remove ? read(remove) : null, rows: rows.length }
      })
    const diffOk = marks => Boolean(marks.add && marks.remove && /"\+"/.test(marks.add.before) && /"\u2212"/.test(marks.remove.before) && marks.add.bg !== marks.remove.bg && marks.add.edge !== marks.remove.edge && !/line-through/.test(marks.remove.strike))

    // A. The session menu's Delete row, then its confirm button.
    await part('destructiveRow', async () => {
      await page.keyboard.press('Escape')
      await shown('[data-slot="row-button"]').click({ button: 'right' })
      await sleep(600)

      const row = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')].filter(node => node.checkVisibility())
        const bad = items.find(node => node.dataset.variant === 'destructive')
        const plain = items.find(node => node.dataset.variant !== 'destructive')

        return bad ? { glyph: Boolean(bad.querySelector('svg, .codicon')), plainWeight: plain ? getComputedStyle(plain).fontWeight : null, text: bad.textContent.trim(), weight: getComputedStyle(bad).fontWeight } : null
      })

      await shot(entry, 'y9-destructive-row')

      if (!row) {
        throw new Error('no destructive row in the session menu')
      }

      await page.locator('[role="menuitem"][data-variant="destructive"]').filter({ visible: true }).first().click()
      await sleep(700)
      row.confirm = await page.evaluate(() => {
        const contrast = window.__mgRigContrast
        const button = [...document.querySelectorAll('[role="dialog"] button[data-variant="destructive"], [role="alertdialog"] button[data-variant="destructive"]')].find(node => node.checkVisibility())
        const primary = [...document.querySelectorAll('button[data-variant="default"]')].find(node => node.checkVisibility())

        if (!button) {
          return null
        }

        const style = getComputedStyle(button)
        const dialog = getComputedStyle(button.closest('[role="dialog"], [role="alertdialog"]')).backgroundColor
        const ring = style.boxShadow.match(/(rgba?\([^)]*\))[^,]*inset/)?.[1] ?? null

        return { bg: style.backgroundColor, edgeContrast: ring ? contrast(ring, dialog) : 0, primaryBg: primary ? getComputedStyle(primary).backgroundColor : null, ring: style.boxShadow.slice(0, 60), text: button.textContent.trim(), weight: style.fontWeight }
      })
      await shot(entry, 'y9-destructive-confirm')
      await page.keyboard.press('Escape')
      await sleep(500)

      return row
    })

    // B. A provider error in the thread.
    await part('errorCard', async () => {
      await page.keyboard.press('Meta+n')
      await sleep(1000)
      await type('A refused request, MGY_FAIL.', 'Enter')
      await shown('[data-slot="aui_error-card"]').waitFor({ timeout: 45_000 })
      await sleep(600)

      const card = await page.evaluate(() => {
        const node = [...document.querySelectorAll('[data-slot="aui_error-card"]')].find(item => item.checkVisibility())

        return { glyph: Boolean(node.querySelector('.aui-error-card-icon, svg')?.checkVisibility()), role: node.getAttribute('role'), title: node.querySelector('.aui-error-card-title')?.textContent.trim() ?? '' }
      })

      await shot(entry, 'y9-error-card')

      return card
    })

    // C, D. A failed call, then a written and patched file (a diff).
    await part('failedTool', async () => {
      await page.waitForFunction(running => !document.querySelector(running), RUNNING, { timeout: 30_000 }).catch(() => undefined)
      await page.keyboard.press('Meta+n')
      await sleep(1000)
      await type('A failing call, MGY_ERR9. MGS_CALL(read_file)[{"path":"/mg-rig-no-such-file-y9.txt"}]', 'Enter')
      await waitIdle('MGY_ERR9 MGS_CALL_DONE', 60_000)
      await type('Write a file, MGY_WRITE9. MGS_CALL(write_file)[{"path":"mg-rig-y9.txt","content":"alpha\\nbeta\\n"}]', 'Enter')
      await waitIdle('MGY_WRITE9 MGS_CALL_DONE', 60_000)
      await type('Patch it, MGY_PATCH9. MGS_CALL(patch)[{"mode":"replace","path":"mg-rig-y9.txt","old_string":"beta","new_string":"gamma"}]', 'Enter')
      await waitIdle('MGY_PATCH9 MGS_CALL_DONE', 60_000)
      await sleep(800)
      await toBottom()
      await sleep(500)
      // Open each turn's fold, then each tool row in it, with real clicks.
      // A reply is dressed again while it settles (data-mg-live="settle"),
      // which can fold it back, so first every pair settles. The fold's
      // "Worked for" line is div.mg-line laid over the head row's top; it
      // takes no pointer, so a press on it lands on the row (the button).
      // Each closed head gets one press on its line, then the failed call's
      // row must show (a second round if a head folded back meanwhile).
      await page.waitForFunction(() => !document.querySelector('[data-mg-live]'), null, { timeout: 15_000 }).catch(() => undefined)
      await sleep(300)
      for (let round = 0; round < 2; round++) {
        const heads = page.locator('[data-mg-head][data-mg-steps]:not([data-mg-open])')
        for (let i = (await heads.count()) - 1; i >= 0; i--) {
          const head = heads.nth(i)
          // To the middle of the thread, not just "in view": in Advanced the
          // user's prompt sticks to the top of the thread and the tab strip
          // sits over it, so a reply scrolled up past them still counts as in
          // view while its line lies under both; the press then landed on the
          // tab strip and the fold never opened (y9 in Advanced, three runs).
          await head.evaluate(node => node.scrollIntoView({ block: 'center' })).catch(() => undefined)
          await sleep(200)
          const line = await head.evaluate(node => {
            const r = (node.previousElementSibling?.classList.contains('mg-line') ? node.previousElementSibling : node).getBoundingClientRect()
            return { x: r.x + 60, y: r.y + Math.min(r.height, 28) / 2 }
          }).catch(() => null)
          if (line) {
            await page.mouse.click(line.x, line.y)
            await sleep(250)
          }
        }
        const shown = await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="tool-block"]')].some(node => node.checkVisibility() && node.textContent.includes('mg-rig-no-such-file-y9')), null, { timeout: 4000 }).then(() => true, () => false)
        entry.evidence.failedToolFoldRounds = round + 1
        if (shown) break
      }
      await toBottom()
      await sleep(600)

      // The failed call's row, closed, as evidence of what it shows shut.
      const closedFail = await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-slot="tool-block"]')].filter(node => node.checkVisibility() && node.textContent.includes('mg-rig-no-such-file-y9')).at(-1)

        return row ? { label: [...row.querySelectorAll('[aria-label]')].map(node => node.getAttribute('aria-label')).join(', '), title: [...row.querySelectorAll('[class*="text-"]')].map(node => node.className).filter(name => /destructive|amber|warning/.test(name)).slice(0, 2) } : null
      })

      // Open the failed row and the patch row (their first button).
      for (const name of ['mg-rig-no-such-file-y9', 'mg-rig-y9.txt']) {
        const row = page.locator('[data-slot="tool-block"]', { hasText: name }).filter({ visible: true }).last()

        if ((await row.count()) && (await row.getAttribute('data-tool-open')) === null) {
          await row.evaluate(node => node.scrollIntoView({ block: 'center' })).catch(() => undefined)
          await sleep(200)
          await row.locator('button').first().click({ timeout: 3000 }).catch(() => undefined)
          await sleep(600)
        }
      }

      const failed = await page.evaluate(() => {
        // The failed call's row: Hermes' Error glyph, or its "Error details"
        // label, either is a cue that is not a hue.
        const row = [...document.querySelectorAll('[data-slot="tool-block"]')].filter(node => node.checkVisibility() && node.textContent.includes('mg-rig-no-such-file-y9')).at(-1)

        if (!row) {
          return { found: false, rows: document.querySelectorAll('[data-slot="tool-block"]').length }
        }

        const glyph = [...row.querySelectorAll('[aria-label="Error"]')].some(node => node.checkVisibility())
        const label = [...row.querySelectorAll('*')].find(node => node.childElementCount === 0 && node.checkVisibility() && /^error( details)?$/i.test(node.textContent.trim()) || /^(error|failed)\b/i.test(node.getAttribute('aria-label') ?? ''))

        return { found: true, glyph, label: label ? label.textContent.trim() : null, open: row.hasAttribute('data-tool-open'), text: row.textContent.replace(/\s+/g, ' ').slice(0, 120) }
      })

      failed.closed = closedFail

      // No failed row: what the thread holds against what Hermes stored for
      // this session, to say who lost the reply (Advanced, twice).
      if (!failed.found) {
        failed.thread = await page.evaluate(() => {
          const viewport = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].find(node => node.checkVisibility())

          const attrs = node => Object.entries(node.dataset).filter(([key]) => key.startsWith('mg')).map(([key, value]) => `${key}=${value}`).join(' ')

          return [...(viewport?.querySelectorAll('[data-slot="aui_thread-content"] [data-role]') ?? [])].map(node => ({
            row: `${node.dataset.role}${node.checkVisibility() ? '' : ' (hidden)'} h=${Math.round(node.getBoundingClientRect().height)} ${attrs(node)}`,
            text: node.textContent.replace(/\s+/g, ' ').slice(0, 70),
            tools: [...node.querySelectorAll('[data-slot="tool-block"]')].map(tool => `${tool.checkVisibility() ? '' : '(hidden) '}${tool.textContent.replace(/\s+/g, ' ').slice(0, 40)}`),
            look: (() => {
              const r = node.getBoundingClientRect()
              const cs = getComputedStyle(node)
              const hit = document.elementFromPoint(r.x + 40, r.y + Math.min(r.height, 30) / 2)
              const line = node.previousElementSibling?.classList.contains('mg-line') ? node.previousElementSibling : node.parentElement?.querySelector(':scope > .mg-line')
              let o = 1
              for (let up = node; up; up = up.parentElement) o *= Number(getComputedStyle(up).opacity)
              return { y: Math.round(r.y), opacity: o, vis: cs.visibility, clip: cs.clipPath, hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}${node.contains(hit) ? ' (inside)' : ''}` : null, line: line ? `${line.checkVisibility() ? 'shown' : 'hidden'} y=${Math.round(line.getBoundingClientRect().y)} "${line.textContent.slice(0, 30)}"` : null, kids: [...node.children].map(k => `${k.tagName.toLowerCase()}${k.dataset.slot ? `[${k.dataset.slot}]` : ''} h=${Math.round(k.getBoundingClientRect().height)} ${k.checkVisibility() ? '' : 'hidden'}`).slice(0, 6) }
            })(),
            parts: [...node.querySelectorAll('[data-mg-part], [data-mg-head], .mg-line')].slice(0, 8).map(part => `${part.className && typeof part.className === 'string' ? part.className.split(' ')[0] : part.tagName.toLowerCase()} ${attrs(part)} ${part.checkVisibility() ? 'shown' : 'hidden'} h=${Math.round(part.getBoundingClientRect().height)}`)
          }))
        })
        failed.stored = await page.evaluate(async () => {
          const list = await window.hermesDesktop.api({ path: '/api/sessions?limit=20&offset=0&min_messages=0' })
          const session = (list?.sessions ?? []).find(row => /MGY_ERR9/.test(`${row.title ?? ''} ${row.preview ?? ''}`))

          if (!session) {
            return 'no stored session with MGY_ERR9'
          }

          const answer = await window.hermesDesktop.api({ path: `/api/sessions/${encodeURIComponent(session.id)}/messages` })
          const messages = answer?.messages ?? answer ?? []

          return { id: session.id, count: session.message_count, messages: (Array.isArray(messages) ? messages : []).map(m => `${m.role}${m.tool_name ? `:${m.tool_name}` : ''}${m.tool_calls ? ` calls=${(Array.isArray(m.tool_calls) ? m.tool_calls : []).map(c => c.function?.name ?? c.name).join('+')}` : ''}: ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 60)}`) }
        }).catch(error => String(error).slice(0, 300))
      }

      await page.locator('[data-slot="file-diff-panel"]').filter({ visible: true }).last().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined)
      await sleep(300)
      await shot(entry, 'y9-failed-tool-and-diff')

      return failed
    })
    // The diff rows: this Hermes shows a patch in the thread as a "+1 −1"
    // chip only, and the Diff surface reads git (the sandbox is no repo), so
    // no diff panel can be reached. The rows are planted as diff-lines.tsx
    // draws them (its classes, inside a file-diff-panel) and judged as drawn.
    await page.evaluate(() => {
      const host = [...document.querySelectorAll('[data-slot="aui_assistant-message-content"]')].filter(node => node.checkVisibility()).at(-1) ?? document.body
      const panel = document.createElement('div')

      panel.id = 'mg-rig-diff'
      panel.dataset.slot = 'file-diff-panel'
      panel.className = '-mx-1.5 -mb-1.5 max-h-[12rem] max-w-none min-w-0 overflow-auto font-mono text-[0.7rem] leading-relaxed text-(--ui-text-secondary)'

      for (const [kind, text] of [['context', 'alpha'], ['remove', 'beta'], ['add', 'gamma'], ['context', 'delta']]) {
        const row = document.createElement('span')

        row.className = `block min-w-max whitespace-pre border-l-2 px-2.5 py-px ${kind === 'add' ? 'border-(--ui-diff-add-border) bg-(--ui-diff-add-background) text-(--ui-diff-add-foreground)' : kind === 'remove' ? 'border-(--ui-diff-remove-border) bg-(--ui-diff-remove-background) text-(--ui-diff-remove-foreground)' : 'border-transparent'}`
        row.textContent = text
        panel.append(row)
      }

      host.append(panel)
      panel.scrollIntoView({ block: 'center' })
    })
    await sleep(300)
    await shot(entry, 'y9-diff-rows-planted')
    await part('diff', diffMarks)

    // Self-test: the marks planted away must fail the diff test.
    await page.evaluate(() => {
      const style = document.createElement('style')

      style.id = 'mg-rig-no-marks'
      style.textContent = 'html body [data-slot="file-diff-panel"] span::before { content: none !important; }'
      document.head.append(style)
    })
    entry.evidence.plantedCaught = !diffOk(await diffMarks())
    await page.evaluate(() => {
      document.getElementById('mg-rig-no-marks')?.remove()
      document.getElementById('mg-rig-diff')?.remove()
    })
    must(entry.evidence.plantedCaught, 'self-test: diff rows with their +/− marks removed still passed')

    // E. An approval (a command Hermes judges dangerous).
    await part('approval', async () => {
      await press('.mg-chip[data-mg-approval]')
      await sleep(500)
      await page.locator('[role="menuitem"], [role="menuitemradio"]', { hasText: /^Manual/ }).filter({ visible: true }).first().click({ timeout: 3000 })
      await sleep(500)
      await type('Something risky, MGY_APPROVE9. MGS_CALL(terminal)[{"command":"rm -rf /tmp/mg-rig-approval-probe-y9"}]', 'Enter')
      await shown('[data-slot="tool-approval-card"]').waitFor({ timeout: 30_000 })
      await sleep(800)

      const card = await page.evaluate(() => {
        const contrast = window.__mgRigContrast
        const node = [...document.querySelectorAll('[data-slot="tool-approval-card"]')].find(item => item.checkVisibility())
        const frame = node.closest('[data-slot="tool-approval-stack"]')?.querySelector('.rounded-xl.border, [data-slot="card-stack-edge"]') ?? node
        const style = getComputedStyle(frame)
        const label = node.querySelector(':scope > div:first-child > span')

        // The activity line above the card ("Running rm -rf …"), as drawn:
        // its colour with every ancestor's opacity, over the canvas.
        const line = [...document.querySelectorAll('[data-approval-activity] span')].find(item => item.checkVisibility() && item.textContent.trim())
        let activity = null

        if (line) {
          let alpha = 1

          for (let up = line; up; up = up.parentElement) {
            alpha *= Number(getComputedStyle(up).opacity)
          }

          const ink = getComputedStyle(line)
          const shimmer = ink.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || /gradient/.test(ink.backgroundImage)
          const colour = ink.color.replace(/^rgba?\(([^,]+),([^,]+),([^,)]+)(,[^)]*)?\)$/, `rgba($1,$2,$3, ${alpha})`)

          activity = { alpha: +alpha.toFixed(2), color: ink.color, ratio: contrast(colour, 'rgb(12, 12, 13)', 'rgb(12, 12, 13)'), shimmer, text: line.textContent.trim().slice(0, 30) }
        }

        return { activity, command: node.querySelector('pre')?.textContent.trim().slice(0, 40) ?? '', edge: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`, edgeContrast: contrast(style.borderTopColor, style.backgroundColor), label: label?.textContent.trim() ?? '', labelWeight: label ? getComputedStyle(label).fontWeight : null }
      })

      await shot(entry, 'y9-approval')

      const deny = page.locator('[data-slot="tool-approval-actions"] button', { hasText: /deny|reject|no/i }).filter({ visible: true }).first()

      if (await deny.count()) {
        await deny.click()
      }

      await page.waitForFunction(running => !document.querySelector(running), RUNNING, { timeout: 30_000 }).catch(() => undefined)
      await press('.mg-chip[data-mg-approval]')
      await sleep(500)
      await page.locator('[role="menuitem"], [role="menuitemradio"]', { hasText: /^Off/ }).filter({ visible: true }).first().click({ timeout: 3000 })
      await sleep(500)

      return card
    })

    // F. Toasts: a failure and a success, side by side.
    await part('toasts', async () => {
      for (const kind of ['error', 'success']) {
        await page.evaluate(kind => globalThis.__HERMES_PLUGIN_SDK__.host.notify({ durationMs: 8000, kind, message: kind === 'error' ? 'Could not save (planted)' : 'Saved (planted)' }), kind)
        await sleep(400)
      }

      await sleep(600)

      const toasts = await page.evaluate(() =>
        [...document.querySelectorAll('[role="alert"], [role="status"]')]
          .filter(node => node.checkVisibility() && /\(planted\)/.test(node.textContent))
          .map(node => ({ glyph: (() => { const icon = node.querySelector('svg, .codicon'); return icon ? `${icon.getAttribute('class') ?? ''} ${icon.innerHTML.replace(/\s+/g, ' ').slice(0, 120)}` : null })(), role: node.getAttribute('role'), text: node.textContent.trim().slice(0, 40) }))
      )

      await shot(entry, 'y9-toasts')

      return toasts
    })

    // G. The unread dot (y8 left rows unread).
    // The labelled status node is hidden (20-sidebar.css); the dot is the
    // row's time redrawn as a filled circle.
    await part('unread', () =>
      page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-slot="sidebar"] .row-hover')].find(node => node.checkVisibility() && node.querySelector('[aria-label="Finished — unread"]'))
        const time = row?.querySelector('time')
        const dot = time && getComputedStyle(time, '::after')

        return row ? { dot: dot ? `${dot.content} ${dot.width}x${dot.height} radius ${dot.borderTopLeftRadius} ${dot.backgroundColor}` : null, label: 'Finished — unread', weight: getComputedStyle(row.querySelector('.hover-marquee-inner') ?? row).fontWeight } : null
      })
    )

    // H. An invalid field (planted: aria-invalid on a Settings field).
    await part('invalid', async () => {
      await page.keyboard.press('Meta+,')
      await shown('[data-tour="nav-plugins"]').waitFor({ timeout: 8000 })
      await sleep(600)

      const field = await page.evaluate(() => {
        const input = [...document.querySelectorAll('[role="dialog"] input[type="text"], [data-overlay-surface] input:not([type])')].find(node => node.checkVisibility()) ?? [...document.querySelectorAll('input')].find(node => node.checkVisibility() && node.type !== 'checkbox')

        if (!input) {
          return null
        }

        const before = getComputedStyle(input).borderTopStyle

        input.setAttribute('aria-invalid', 'true')

        return { after: getComputedStyle(input).borderTopStyle, before }
      })

      await shot(entry, 'y9-invalid-field')
      await page.evaluate(() => document.querySelector('[aria-invalid="true"]')?.removeAttribute('aria-invalid'))
      await press('button[aria-label="Close settings"]').catch(() => page.keyboard.press('Escape'))
      await sleep(600)

      return field
    })


    // I. Keyboard focus, walked with Tab: in the main window from the message
    // box, and on Settings > Plugins > Monograph. Each stop must show a cue
    // that is gray (no chroma) and 3:1 against the surface: an outline, a
    // ring (box-shadow) or an edge that appears with focus.
    const focusWalk = async (label, stops) => {
      const seen = []

      for (let n = 0; n < stops; n++) {
        await page.keyboard.press('Tab')
        await sleep(160)

        const item = await page.evaluate(() => {
          const node = document.activeElement

          if (!node || node === document.body || !node.checkVisibility()) {
            return null
          }

          const read = () => {
            const style = getComputedStyle(node)

            return { border: style.borderTopWidth !== '0px' && style.borderTopStyle !== 'none' ? style.borderTopColor : null, outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 ? style.outlineColor : null, shadow: (style.boxShadow.match(/(rgba?|oklab|oklch|color)\([^)]*\)[^,]*?(\d+(\.\d+)?)px[^,]*/g) ?? []).filter(part => !/^rgba\(0, 0, 0, 0\)/.test(part) && !/ 0px 0px 0px 0px/.test(part)).map(part => part.match(/(rgba?|oklab|oklch|color)\([^)]*\)/)[0]) }
          }
          const focused = read()

          node.blur()

          const rest = read()

          node.focus()

          // The surface under the control: the first opaque background up.
          let under = 'rgb(20, 20, 21)'

          for (let up = node.parentElement; up; up = up.parentElement) {
            const bg = getComputedStyle(up).backgroundColor

            // Only an opaque fill is the surface; a veil (hover, active) is skipped.
            if (bg && !/^rgba\(/.test(bg) && bg !== 'transparent') {
              under = bg
              break
            }
          }

          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          const rgb = colour => {
            ctx.clearRect(0, 0, 1, 1)
            ctx.fillStyle = under
            ctx.fillRect(0, 0, 1, 1)
            ctx.fillStyle = colour
            ctx.fillRect(0, 0, 1, 1)

            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
          }
          const cues = [
            focused.outline && focused.outline !== rest.outline ? focused.outline : null,
            ...focused.shadow.filter(colour => !rest.shadow.includes(colour)),
            focused.border && focused.border !== rest.border ? focused.border : null
          ].filter(Boolean)
          const judged = cues.map(colour => {
            const c = rgb(colour)

            return { chroma: Math.max(...c) - Math.min(...c), colour, ratio: window.__mgRigContrast(colour, under, under) }
          })
          const name = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 24) || node.getAttribute('placeholder') || node.tagName.toLowerCase()

          // The message box shows the caret, not a ring (40-composer.css).
          const caret = node.isContentEditable && Boolean(node.closest('[data-slot="composer-root"]'))

          return { cue: caret ? ['caret'] : judged.filter(cue => cue.ratio >= 3 && cue.chroma <= 12), judged, name, role: node.getAttribute('role') ?? node.tagName.toLowerCase() }
        })

        if (item) {
          seen.push(item)
        }
      }

      const weak = seen.filter(item => !item.cue.length)
      const coloured = seen.filter(item => item.judged.some(cue => cue.chroma > 12))

      return { coloured: coloured.map(item => `${item.role} "${item.name}": ${item.judged.map(cue => cue.colour).join(', ')}`), stops: seen.length, weak: weak.map(item => `${item.role} "${item.name}" ${JSON.stringify(item.judged)}`) }
    }

    await part('focusMain', async () => {
      await page.keyboard.press('Escape')
      await page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first().click()

      return focusWalk('main', 30)
    })
    await part('focusSettings', async () => {
      await page.keyboard.press('Meta+,')
      await shown('[data-tour="nav-plugins"]').waitFor({ timeout: 8000 })
      await sleep(500)
      await shown('[data-tour="nav-plugins"]').click({ timeout: 4000 })
      await sleep(500)
      await page.locator('button, a', { hasText: /^Monograph$/ }).filter({ visible: true }).first().click({ timeout: 5000 })
      await sleep(800)

      const walked = await focusWalk('settings', 30)

      await shot(entry, 'y9-focus-settings-last')
      await press('button[aria-label="Close settings"]').catch(() => page.keyboard.press('Escape'))
      await sleep(600)

      return walked
    })

    entry.evidence.cues = cues

    const { approval, destructiveRow: row, diff, errorCard, failedTool, invalid, toasts, unread } = cues

    must(row && !row.error && row.glyph && Number(row.weight) >= 600 && Number(row.plainWeight) < 600, `the destructive menu row is not told by glyph and weight: ${JSON.stringify(row)}`)
    must(row?.confirm && row.confirm.bg !== row.confirm.primaryBg && row.confirm.edgeContrast >= 3 && Number(row.confirm.weight) >= 600, `the destructive confirm button does not read apart from the primary one: ${JSON.stringify(row?.confirm ?? null)}`)
    must(errorCard && !errorCard.error && errorCard.glyph && errorCard.title, `the error in the thread has no glyph or title: ${JSON.stringify(errorCard)}`)
    must(failedTool && !failedTool.error && failedTool.found && (failedTool.glyph || failedTool.label), `the failed tool row carries no error glyph or label: ${JSON.stringify(failedTool)}`)
    must(diff && diffOk(diff), `diff rows do not read apart without colour (+/− marks, two fills, two edges, no strike): ${JSON.stringify(diff)}`)
    must(approval && !approval.error && approval.edgeContrast >= 3 && Number(approval.labelWeight) >= 600 && approval.command, `the approval card is not told by its edge, weight and command: ${JSON.stringify(approval)}`)
    must(!approval?.activity || approval.activity.shimmer || approval.activity.ratio >= 4.5, `the approval's activity line is under 4.5:1: ${JSON.stringify(approval?.activity)}`)
    must(Array.isArray(toasts) && toasts.length >= 2 && toasts.every(item => item.glyph) && new Set(toasts.map(item => item.glyph)).size >= 2 && toasts.some(item => item.role === 'alert'), `the failure and success toasts do not differ by glyph and role: ${JSON.stringify(toasts)}`)
    must(unread && !unread.error && /^"" [4-9](\.\d+)?px/.test(unread.dot ?? '') && Number(unread.weight) >= 500, `no unread dot (a filled circle in place of the time) and heavier title: ${JSON.stringify(unread)}`)
    for (const key of ['focusMain', 'focusSettings']) {
      const walk = cues[key]

      must(walk && !walk.error && walk.stops >= 8, `${key}: the Tab walk reached ${walk?.stops ?? 0} stops (${walk?.error ?? ''})`)
      must(walk && !walk.coloured?.length, `${key}: focus drawn in colour: ${walk?.coloured?.join(' | ')}`)
      must(walk && !walk.weak?.length, `${key}: ${walk?.weak?.length} stop(s) with no gray focus cue at 3:1: ${walk?.weak?.slice(0, 6).join(' | ')}`)
    }

    must(invalid && !invalid.error && invalid.after === 'dashed' && invalid.before !== 'dashed', `an invalid field is not dashed: ${JSON.stringify(invalid)}`)
  })
}
