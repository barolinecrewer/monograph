// Cost: what our stylesheet makes the browser restyle, against bare Hermes in
// the same run. Element counts (UpdateLayoutTree's elementCount, summed over
// a trace), not milliseconds: the count of restyled elements does not change
// with machine load, so a ratio of counts holds while other rigs run.
//
//   k1  A streamed 2,000-line reply in a new session (the stress suite's
//       MGS_LONG): elements restyled with Monograph at most K1_RATIO times
//       bare's, and no single recalc over 1.5 times bare's largest.
//   k2  Scrolling the 60-turn thread up and down: at most K2_RATIO times bare.
//   k3  Selector shapes, read from the live stylesheet (no trace): the three
//       shapes that made the page restyle whole subtrees while a reply
//       streamed (w6-cost). Each fails on any new instance:
//       a. a :has() that is not in the last compound, anchored on a thread
//          element (turn pair, response group, reply row, thread): every
//          node streamed in under the anchor restyled the anchor's whole
//          subtree (Hermes' own `group-has-[…]` rules end in `*`, and every
//          non-subject :has() shares one invalidation set);
//       b. a structural pseudo-class (:first-child, :nth-child(), :…-of-type)
//          left of the last compound: every parent that gains a child
//          restyled the whole subtree of each sibling, page-wide;
//       c. a last compound that matches any element (`… > *`, `… *`,
//          `:not(…)` alone, also inside a nested :is()/:not() selector), in a
//          selector with a combinator: any change of an attribute named on
//          its left (class, role, data-slot, data-mg-live…) restyled the
//          changed element's whole subtree.
//
// Measured on w7/feel, three runs: stream 1.27 times bare every run (81k
// against 64k elements, with the pointer resting over the reply in both;
// w6-cost: 2.7 to 3.0, its start 27), scroll 1.35. What was left over 1.5 in
// w6 was not our stylesheet: 8 wide recalcs were the pointer resting over
// the reply in ours only (see the stream round), and 2 were our working line
// taken out of the response group and the finished line put back, each
// tripping Hermes' `.prose :where(h2 + *)` rules (the line now stays through
// the turn's end). K1_RATIO is what this branch measures plus a margin: one
// wide rule put back (the turn pair :has()) measures 27x.
import fs from 'node:fs'
import path from 'node:path'

import { EVIDENCE, ON_SCREEN_VIEWPORT, check, hotReload, results, sleep, state, stubPlugin, turnDone, type, waitForAppReady } from '../harness.mjs'
import { config as stressConfig, model as stressModel, seed as stressSeed } from './stress.mjs'

export const limitS = 900
export const model = stressModel
export const config = stressConfig
export const seed = stressSeed
export const checks = [
  ['k1', 'Streamed 2,000-line reply: elements restyled against bare'],
  ['k2', 'Scrolling the long thread: elements restyled against bare'],
  ['k3', 'Selector shapes that restyle whole subtrees']
]

const K1_RATIO = 1.4
const K1_LARGEST = 1.5
const K2_RATIO = 1.6

async function traced(fn) {
  const cdp = state.cdp
  const events = []
  const onData = e => events.push(...e.value)

  cdp.on('Tracing.dataCollected', onData)
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline'], recordMode: 'recordContinuously' } })
  await fn()

  const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))

  await cdp.send('Tracing.end')
  await done
  cdp.off('Tracing.dataCollected', onData)

  const main = new Set(events.filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map(e => `${e.pid}:${e.tid}`))
  const counts = events.filter(e => main.has(`${e.pid}:${e.tid}`) && e.ph === 'X' && e.name === 'UpdateLayoutTree').map(e => e.args?.elementCount ?? 0)

  return {
    restyled: counts.reduce((a, b) => a + b, 0),
    recalcs: counts.length,
    over1000: counts.filter(c => c > 1000).length,
    largest: Math.max(0, ...counts)
  }
}

async function wheel(direction, steps) {
  const { page } = state
  const box = await page.evaluate(`(() => { const r = (${ON_SCREEN_VIEWPORT}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.45 } })()`)

  await page.mouse.move(box.x, box.y)

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, direction === 'up' ? -1200 : 1200)
    await sleep(30)
  }
}

// One round: open the long thread, scroll it, then the long reply in a new
// session (the long thread has no room left in the mock model's context).
async function round(tag) {
  const { page } = state

  await page.reload()
  await waitForAppReady({ app: state.app, page }, 60000)
  await sleep(1500)

  const row = page.locator('[data-slot="row-button"]', { hasText: 'MGS long thread' }).first()

  await row.waitFor({ state: 'visible', timeout: 20000 })
  await row.click()
  await sleep(4000)

  const scroll = await traced(async () => {
    await wheel('up', 25)
    await sleep(400)
    await wheel('down', 30)
    await sleep(800)
  })

  await page.keyboard.press('Meta+n')
  await sleep(1200)

  const stream = await traced(async () => {
    await type(`A long reply in the long thread, ${tag}. MGS_LONG(2000)`, 'Enter')
    // The pointer rests over the reply, at the same point in both runs. Left
    // where the click on the message box put it, it sat on the composer in
    // bare Hermes but over the thread in ours (Monograph's empty session
    // draws the message box mid-page), and every 2 s Hermes' own reply
    // drops out from under a still pointer for one frame (its hit test
    // lands on the turn pair; bare does the same, measured), so Hermes'
    // `group-hover … *` rules restyled the whole reply twice: 8 of the wide
    // recalcs w6-cost found were that pointer, in ours only.
    await page.mouse.move(...(await page.evaluate(`(() => { const r = (${ON_SCREEN_VIEWPORT}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height * 0.45] })()`)))
    await turnDone(`${tag} MGS_LONG_DONE`, 240000)
    await sleep(2500)
  })

  return { scroll, stream }
}

let measured = null

async function measure() {
  if (measured) {
    return measured
  }

  await hotReload({ gone: true, source: stubPlugin() })
  const bare = await round('MGC_BARE')

  await hotReload()
  const ours = await round('MGC_OURS')

  measured = { bare, ours }
  fs.writeFileSync(path.join(EVIDENCE, 'cost.json'), JSON.stringify(measured, null, 1))

  return measured
}

const ratio = (a, b) => Math.round((a / Math.max(1, b)) * 100) / 100

// ── k3: the selector shapes, from the CSSOM of our stylesheet ──
// Runs in the page. Returns the offending selectors, by shape.
const SHAPES = () => {
  const STRUCT = /:(first-child|last-child|only-child|nth-child|nth-last-child|first-of-type|last-of-type|only-of-type|nth-of-type|nth-last-of-type)\b/
  const THREAD = /aui_turn-pair|aui_response-group|aui_assistant-message|aui_thread|data-role="assistant"|data-role="user"|aui_user-message/
  // Known and kept: keyed on an attribute that changes only when its zone is
  // drawn (zone tabs, the bots zone), or in files this suite's owner does not
  // own (05-motion.css, 55-motion.css: :root:not(#mg-motion-off) and the
  // ghost menu).
  const ALLOW = [/^\[data-tree-tab\] \*$/, /mg-motion-off/, /^\[data-mg-ghost\]/, /^\[data-bb-left-zone\] > :not/]

  // Split at top level (outside parentheses and brackets).
  const split = (text, seps) => {
    const out = []
    let depth = 0
    let cur = ''

    for (const ch of text) {
      if (ch === '(' || ch === '[') depth++
      if (ch === ')' || ch === ']') depth--
      if (depth === 0 && seps.includes(ch)) {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }

    out.push(cur)

    return out
  }

  const compounds = sel => split(sel.trim().replace(/\s*([>+~])\s*/g, '$1'), ' >+~').filter(Boolean)

  // The arguments of each :name( … ) in a compound, top level.
  const args = (compound, names) => {
    const out = []
    const re = new RegExp(`:(${names})\\(`, 'g')
    let m

    while ((m = re.exec(compound))) {
      let depth = 1
      let i = m.index + m[0].length
      const start = i

      for (; i < compound.length && depth; i++) {
        if (compound[i] === '(') depth++
        if (compound[i] === ')') depth--
      }

      out.push([m[1], compound.slice(start, i - 1)])
    }

    return out
  }

  // Remove every :name( … ) from a compound.
  const strip = compound => {
    let out = ''
    let depth = 0

    for (let i = 0; i < compound.length; i++) {
      const ch = compound[i]

      if (depth === 0 && ch === ':' ) {
        const m = /^::?[a-zA-Z-]+\(?/.exec(compound.slice(i))

        if (m && m[0].endsWith('(')) {
          depth = 1
          i += m[0].length - 1
          continue
        }
      }

      if (depth) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        continue
      }

      out += ch
    }

    return out
  }

  // Does a compound name an element by tag, class, id or attribute (so that
  // Blink can key an invalidation on it)? :is()/:where() count when every
  // argument does; :not() and :has() never do.
  const named = compound => {
    const bare = strip(compound).replace(/::?[a-zA-Z-]+/g, '')

    if (/[#.[&]|^[a-zA-Z]/.test(bare)) {
      return true
    }

    // Each argument's own last compound is the element itself.
    return args(compound, 'is|where').some(([, inner]) => split(inner, ',').every(one => named(compounds(one).at(-1) ?? '')))
  }

  const found = { a: [], b: [], c: [] }

  // nested: a complex selector inside the last compound's :is()/:where()/
  // :not(); its last compound is the outer element, so it counts as named
  // when the outer compound is.
  const visit = (sel, nested, outerNamed = false) => {
    const parts = compounds(sel)
    const last = parts.at(-1) ?? ''

    if (ALLOW.some(re => re.test(sel.trim()))) {
      return
    }

    parts.slice(0, -1).forEach(part => {
      if (/:has\(/.test(part) && THREAD.test(part)) found.a.push(sel)
      if (STRUCT.test(strip(part)) || args(part, 'is|where|not').some(([, inner]) => STRUCT.test(inner))) found.b.push(sel)
    })

    if ((parts.length > 1 || nested) && !named(last) && !outerNamed) {
      found.c.push(sel)
    }

    // Complex selectors nested in the last compound's :is()/:where()/:not().
    for (const [, inner] of args(last, 'is|where|not')) {
      for (const one of split(inner, ',')) {
        if (compounds(one).length > 1) visit(one, true, named(last))
      }
    }
  }

  const walk = rules => {
    for (const rule of rules) {
      if (rule.selectorText) {
        split(rule.selectorText, ',').forEach(sel => visit(sel, /^[>+~]/.test(sel.trim())))
      }

      if (rule.cssRules) {
        walk(rule.cssRules)
      }
    }
  }

  walk(document.getElementById('mg-css').sheet.cssRules)

  for (const k of Object.keys(found)) {
    found[k] = [...new Set(found[k].map(s => s.trim()))]
  }

  return found
}

export async function run() {
  await check('k1', async (entry, must) => {
    const { bare, ours } = await measure()
    const r = ratio(ours.stream.restyled, bare.stream.restyled)
    const big = ratio(ours.stream.largest, bare.stream.largest)

    entry.evidence = { bare: bare.stream, ours: ours.stream, ratio: r, largestRatio: big, limit: K1_RATIO }
    must(bare.stream.recalcs > 100, `the bare stream did not run (${bare.stream.recalcs} recalcs): no reference`)
    must(r <= K1_RATIO, `restyled ${ours.stream.restyled} elements against bare's ${bare.stream.restyled}: ${r}x, limit ${K1_RATIO}x`)
    must(big <= K1_LARGEST, `largest single recalc ${ours.stream.largest} against bare's ${bare.stream.largest}: ${big}x, limit ${K1_LARGEST}x`)
  })

  await check('k2', async (entry, must) => {
    const { bare, ours } = await measure()
    const r = ratio(ours.scroll.restyled, bare.scroll.restyled)

    entry.evidence = { bare: bare.scroll, ours: ours.scroll, ratio: r, limit: K2_RATIO }
    must(bare.scroll.recalcs > 50, `the bare scroll did not run (${bare.scroll.recalcs} recalcs): no reference`)
    must(r <= K2_RATIO, `restyled ${ours.scroll.restyled} elements against bare's ${bare.scroll.restyled}: ${r}x, limit ${K2_RATIO}x`)
  })

  await check('k3', async (entry, must) => {
    const found = await state.page.evaluate(SHAPES)

    entry.evidence = found
    must(!found.a.length, `:has() not in the last compound, on a thread element: ${found.a.join(' | ')}`)
    must(!found.b.length, `structural pseudo-class left of the last compound: ${found.b.join(' | ')}`)
    must(!found.c.length, `last compound matches any element: ${found.c.join(' | ')}`)
  })

  results.notes.push('cost: element counts per trace in cost.json (bare, then Monograph, one round each)')
}
