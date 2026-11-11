// The core checks: the surfaces button, a queued prompt's bubble, and the fold
// at the end of a turn. See rig/README.md for what each one proves.
import { MODE, RUNNING, VIEWPORT, check, finished, results, shot, sleep, state, thread, type, waitForAppReady, within } from '../harness.mjs'

// What the mock does with each prompt is decided by the tokens in it
// (tests-js/scripts/mock-server.ts):
//   one    plain reply, paused after its first word until the rig lets go
//   two    one real tool call (`sleep 3` in the sandbox), then an answer
//   three  a note with a tool call (`sleep 5`), then an answer
// (E2E_INTERIM_TRIGGER would give a longer turn, but its script calls a `todo`
// tool this Hermes no longer has, and the turn dies on it.)
const FIRST = 'Rig prompt one, MG_RIG_FIRST. Take your time.'
const QUEUED = 'Rig prompt two, MG_RIG_QUEUED. E2E_CALL(terminal)[{"command":"sleep 3"}]'
const THIRD = 'Rig prompt three, MG_RIG_THIRD. E2E_CORRECTION_SWITCH_TRIGGER'
const FIRST_REPLY = 'First reply from the mock model, MG_RIG_FIRST_DONE. It was held on purpose so that a second prompt could be queued behind it.'
const QUEUED_ANSWER = 'E2E_CALL_RESULT'
const THIRD_ANSWER = 'The corrected task finished.'

export const checks = [
  ['b', 'Surfaces button: one click opens the menu and it stays open'],
  ['c', 'Queued prompt: bubble while the turn is still running'],
  ['d', 'Turn end: work folded away, answer visible']
]

export const mock = {
  holdFirstStreamForPrompt: 'MG_RIG_FIRST',
  replyForPrompt: prompt => (prompt.includes('MG_RIG_FIRST') ? FIRST_REPLY : 'Reply from the mock model.')
}

export async function run() {
  const { app, mock, page } = state

  // ── b. Surfaces button ────────────────────────────────────────────────────
  await check('b', async (entry, must) => {
    const menu = () =>
      page.evaluate(() => {
        const node = document.querySelector('.mg-surfaces-menu')

        if (!node) {
          return { open: false, rows: [] }
        }

        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)

        return {
          open: node.checkVisibility() && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0,
          rows: [...node.querySelectorAll('.mg-surface-row')].map(row => (row.textContent ?? '').trim()),
          size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          state: node.dataset.state ?? null
        }
      })

    must(!(await menu()).open, 'the menu was already open before the click')

    const target = page.locator('[data-tour="mg-surfaces"] .mg-surfaces-hit').first()
    const box = await ((await target.count()) ? target : page.locator('[data-tour="mg-surfaces"]').first()).boundingBox()

    if (!box) {
      throw new Error('the surfaces button has no box to click')
    }

    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + box.height / 2)

    // A log inside the page of every press, release and click it receives (who
    // got it, and whether the browser made it: isTrusted), and of the menu
    // entering and leaving the page. Times are ms since the log began.
    entry.evidence.underPointer = await page.evaluate(
      ({ x, y }) => {
        const name = node =>
          node instanceof Element
            ? `${node.tagName.toLowerCase()}${node.dataset.tour ? `[data-tour=${node.dataset.tour}]` : ''}${node.dataset.slot ? `[data-slot=${node.dataset.slot}]` : ''}${
                typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
              }`
            : String(node)

        const began = performance.now()
        const log = []
        const rig = { log, on: true }
        let present = Boolean(document.querySelector('.mg-surfaces-menu'))

        for (const type of ['pointerdown', 'pointerup', 'click']) {
          document.addEventListener(
            type,
            event => {
              if (rig.on) {
                log.push({
                  ms: Math.round(performance.now() - began),
                  type,
                  target: name(event.target),
                  onButton: Boolean(event.target?.closest?.('[data-tour="mg-surfaces"]')),
                  button: event.target?.closest?.('button')?.getAttribute('aria-label') ?? null,
                  trusted: event.isTrusted
                })
              }
            },
            true
          )
        }

        rig.observer = new MutationObserver(() => {
          const now = Boolean(document.querySelector('.mg-surfaces-menu'))

          if (now !== present) {
            present = now
            log.push({ ms: Math.round(performance.now() - began), type: now ? 'menu added' : 'menu removed' })
          }
        })
        rig.observer.observe(document.body, { childList: true, subtree: true })
        window.__mgRig = rig

        return document.elementsFromPoint(x, y).slice(0, 3).map(name)
      },
      { x, y }
    )

    const readLog = () => page.evaluate(() => window.__mgRig.log.splice(0))

    // Open within 1s of `since`, and still open 1s after that?
    const watch = async since => {
      let opened = null

      while (Date.now() - since < 1000 && opened === null) {
        if ((await menu()).open) {
          opened = Date.now() - since
        } else {
          await sleep(25)
        }
      }

      await sleep(1000)

      return { later: await menu(), opened }
    }

    const clicked = Date.now()

    await page.mouse.click(x, y)

    const { later, opened } = await watch(clicked)
    const events = await readLog()
    const of = type => events.filter(event => event.type === type)

    Object.assign(entry.evidence, {
      clickAt: `${x},${y}`,
      pageSaw: events.map(
        event => `${event.ms}ms ${event.type}${event.target ? ` on ${event.target}${event.button ? ` in button "${event.button}"` : ''}${event.trusted ? ' (trusted)' : ' (SCRIPTED)'}` : ''}`
      ),
      openedAfterMs: opened,
      openOneSecondLater: later.open,
      menu: later.open ? `${later.size} data-state=${later.state}` : null,
      rows: later.rows
    })

    // The press has to land on the button. The click that follows it may land
    // elsewhere: an open menu takes the pointer away from the rest of the page.
    must(
      of('pointerdown').length === 1 && of('click').length === 1 && events.every(event => event.trusted !== false),
      `expected one trusted press and one trusted click, the page saw ${JSON.stringify(events)}`
    )
    const press = of('pointerdown')[0]

    must(
      press?.onButton,
      `the press at ${x},${y}, the centre of the surfaces button, landed on ${press?.button ? `the button "${press.button}"` : (press?.target ?? 'nothing')} instead`
    )
    must(opened !== null, 'the click did not open .mg-surfaces-menu within 1s')
    must(later.open, `.mg-surfaces-menu was ${opened === null && !of('menu added').length ? 'never open' : 'open, then gone'} 1s after the click`)
    must(!later.open || later.rows.length > 0, 'the menu is open but has no .mg-surface-row')
    await shot(entry, 'b-surfaces-menu')

    // Tidy up for the next check; not part of the verdict.
    await page.keyboard.press('Escape')
    await sleep(300)
    entry.evidence.closedByEscape = !(await menu()).open

    if (press && !press.onButton) {
      // Something else took the click. Say what, and take the click back if it
      // was a toggle, so the next checks see the layout they expect.
      const cover = await page.evaluate(
        ({ x, y }) => {
          const top = document.elementsFromPoint(x, y)[0]?.closest('button')
          const mine = document.querySelector('[data-tour="mg-surfaces"]')
          const box = node => {
            const rect = node.getBoundingClientRect()

            return `${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)}`
          }

          // How much of the surfaces button a pointer can reach at all.
          const rect = mine.getBoundingClientRect()
          let reachable = 0

          for (let row = 0; row < 6; row++) {
            for (let column = 0; column < 6; column++) {
              const hit = document.elementFromPoint(rect.x + ((column + 0.5) * rect.width) / 6, rect.y + ((row + 0.5) * rect.height) / 6)

              reachable += mine.contains(hit) ? 1 : 0
            }
          }

          return {
            box: top ? box(top) : null,
            cluster: top?.closest('[data-titlebar-cluster]')?.dataset.titlebarCluster ?? null,
            label: top?.getAttribute('aria-label') ?? null,
            mine: box(mine),
            reachable: `${reachable} of 36 sample points`
          }
        },
        { x, y }
      )

      entry.evidence.coveredBy = cover
      results.observations.push(
        `b: the surfaces button (${cover.mine}) lies under Hermes' own "${cover.label}" titlebar button (${cover.box}, cluster "${cover.cluster}"); a pointer reaches the surfaces button at ${cover.reachable}. Interface mode: ${MODE}.`
      )

      if (cover.label === 'Swap sidebar sides') {
        await page.mouse.click(x, y)
        await sleep(400)
        await readLog()
        entry.evidence.tidyUp = 'the click swapped the sidebar sides; a second click on the same spot swapped them back'
      }
    } else if (entry.why.length) {
      // The press reached the button and the menu still failed. No part of
      // the verdict: does a slower click (pointer rests on the button, button
      // held for 120ms) do better? Tells a timing problem from a dead button.
      await page.mouse.move(x - 200, y + 200)
      await sleep(300)
      await readLog()
      await page.mouse.move(x, y, { steps: 8 })
      await sleep(400)

      const pressed = Date.now()

      await page.mouse.down()
      await sleep(120)
      await page.mouse.up()

      const slow = await watch(pressed)
      const slowEvents = await readLog()

      entry.evidence.diagnosticSlowClick = {
        openedAfterMs: slow.opened,
        openOneSecondLater: slow.later.open,
        pageSaw: slowEvents.map(event => `${event.ms}ms ${event.type}${event.target ? ` on ${event.target}` : ''}`)
      }
      await shot(entry, 'b-diagnostic-slow-click')
      await page.keyboard.press('Escape')
      await sleep(300)
    }

    await page.evaluate(() => {
      window.__mgRig.on = false
      window.__mgRig.observer.disconnect()
    })
  })

  // ── c. Queued prompt ──────────────────────────────────────────────────────
  await check('c', async (entry, must) => {
    await type(FIRST, 'Enter')
    await within(mock.waitForHeldStream(), 60_000, 'the mock never received prompt one')

    // Prompt one now sits on its first word. Queue prompt two behind it the
    // way Hermes' own queue spec does.
    await page.waitForFunction(running => Boolean(document.querySelector(running)), RUNNING, { timeout: 15_000 })
    await type(QUEUED, 'Control+Enter')

    // Prompt one is running for a fact for as long as the mock holds its
    // stream. Watch the thread for 4s of that.
    const queuedAt = Date.now()
    const timeline = []

    while (Date.now() - queuedAt < 4000) {
      await sleep(500)

      const now = await thread()

      timeline.push({ ...now, ms: Date.now() - queuedAt })
    }

    const held = timeline.at(-1)
    const line = sample =>
      `${sample.ms}ms running=[${sample.runningMarkers.join(',')}] rows=[${sample.rowMarks.join(',')}] mg-queued=${sample.queuedBubbles.length} hermes=${sample.hermesQueueChip ?? 'no chip'}`

    entry.evidence.whileOneIsHeld = {
      mockHasPromptTwo: mock.receivedPrompts.some(prompt => prompt.includes('MG_RIG_QUEUED')),
      // Runs of identical samples collapse to the first of each.
      timeline: timeline.filter((sample, index) => index === 0 || line(sample).replace(/^\d+ms/, '') !== line(timeline[index - 1]).replace(/^\d+ms/, '')).map(line)
    }
    must(!entry.evidence.whileOneIsHeld.mockHasPromptTwo, 'prompt two reached the model while prompt one was still held: it was not queued')
    must(held.hermesQueueChip || held.queuedBubbles.length, 'neither Hermes nor the plugin shows prompt two as queued')
    await shot(entry, 'c1-prompt-two-queued-turn-one-held')

    const unmarked = timeline.filter(sample => !sample.runningPairs.some(Boolean))
    const dressed = timeline.filter(sample => sample.rowMarks.some(mark => mark !== 'unmarked'))

    if (unmarked.length) {
      results.observations.push(
        `c: prompt one's stream was held open by the mock (so the turn was running), yet ${unmarked.length} of ${timeline.length} samples found neither aui_turn-activity nor aui_response-loading in its pair (at ${unmarked.map(sample => `${sample.ms}ms`).join(', ')} after queueing).`
      )
    }

    if (dressed.length) {
      results.observations.push(
        `c: while that stream was still held, the plugin had already dressed the unfinished reply as a finished turn (${dressed[0].rowMarks.join(', ')}, first seen ${dressed[0].ms}ms after queueing; ${dressed.length} of ${timeline.length} samples). See c1-prompt-two-queued-turn-one-held.png.`
      )
    }

    if (!timeline.some(sample => sample.queuedBubbles.length)) {
      results.observations.push(
        'c: no [data-mg-queued] bubble exists while prompt one itself is still streaming; it appears once the queued turn starts, inside prompt one\'s pair. Until then only Hermes\' own "N Queued" chip shows the prompt.'
      )
    }

    const released = Date.now()

    mock.releaseHeldStream()

    // The bubble and the running turn, read in one go inside the page.
    const seen = await page
      .waitForFunction(
        ({ marker, running }) => {
          for (const bubble of document.querySelectorAll('[data-mg-queued]')) {
            const text = (bubble.querySelector('[data-slot="aui_user-message-text"]') ?? bubble).textContent ?? ''
            const pair = bubble.closest('[data-slot="aui_turn-pair"]')
            const slots = pair ? [...pair.querySelectorAll(running)].map(node => node.dataset.slot) : []
            const rect = bubble.getBoundingClientRect()

            if (text.includes(marker) && slots.length) {
              return {
                bubble: text.trim(),
                pairPrompt: (pair.querySelector('[data-slot="aui_user-message-root"]:not([data-mg-queued])')?.textContent ?? '').trim().slice(0, 60),
                running: slots,
                size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
                visible: bubble.checkVisibility() && rect.height > 0
              }
            }
          }

          return null
        },
        { marker: 'MG_RIG_QUEUED', running: RUNNING },
        { polling: 50, timeout: 60_000 }
      )
      .then(handle => handle.jsonValue())
      .catch(() => null)

    if (!seen) {
      entry.evidence.after60s = await thread()
      must(false, 'no [data-mg-queued] bubble with prompt two\'s text appeared in a running turn within 60s of releasing prompt one')
      await shot(entry, 'c-no-bubble')

      return
    }

    await shot(entry, 'c-queued-bubble')

    const after = await thread()

    Object.assign(entry.evidence, {
      bubbleAfterReleaseMs: Date.now() - released,
      bubbleText: seen.bubble,
      bubbleSize: seen.size,
      turnRunning: seen.running,
      turnPrompt: seen.pairPrompt,
      stillRunningAfterScreenshot: after.runningPairs.some(Boolean) && after.queuedBubbles.length === 1,
      mockPrompts: mock.receivedPrompts.map(prompt => prompt.match(/MG_RIG_\w+/)?.[0] ?? prompt.slice(0, 30))
    })

    must(seen.bubble === QUEUED, `the bubble reads ${JSON.stringify(seen.bubble)}, prompt two was ${JSON.stringify(QUEUED)}`)
    must(seen.visible, 'the bubble is in the page but not visible')
    must(seen.pairPrompt.includes('MG_RIG_FIRST'), `the bubble sits in the turn of ${JSON.stringify(seen.pairPrompt)}, not in prompt one's`)
    must(entry.evidence.stillRunningAfterScreenshot, 'the turn had ended (or the bubble had gone) by the time the screenshot was taken, so the picture does not show both')
  })

  // ── d. Turn end ───────────────────────────────────────────────────────────
  await check('d', async (entry, must) => {
    await finished(QUEUED_ANSWER, 90_000)
    await type(THIRD, 'Enter')
    await finished(THIRD_ANSWER, 90_000)

    const ended = Date.now()

    // The fold lands a settle delay after the turn ends, then animates.
    const settle = () =>
      page
        .waitForFunction(
          () => {
            const rows = [...document.querySelectorAll('[data-slot="aui_assistant-message-root"]')]

            return rows.length > 0 && rows.every(row => row.dataset.mgSeg) && !document.querySelector('[data-mg-anim]')
          },
          undefined,
          { polling: 50, timeout: 10_000 }
        )
        .then(() => true)
        .catch(() => false)

    // Every reply on screen, cut into segments the way the plugin cuts them:
    // the rows from one prompt (or queued bubble) to the next.
    const read = () =>
      page.evaluate(() => {
        const ROW = '[data-slot="aui_assistant-message-root"]'
        const CONTENT = '[data-slot="aui_assistant-message-content"]'
        const shown = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
        const label = node => (node?.querySelector('[data-slot="aui_user-message-text"]') ?? node)?.textContent?.trim().match(/MG_RIG_\w+/)?.[0] ?? '?'

        const describe = row => {
          const tools = [...row.querySelectorAll(`${CONTENT} > [data-slot="tool-block"]`)]
          const notes = [...row.querySelectorAll(`${CONTENT} > .aui-md`)]

          return {
            display: getComputedStyle(row).display,
            head: 'mgHead' in row.dataset,
            height: Math.round(row.getBoundingClientRect().height),
            lastNote: (notes.at(-1)?.textContent ?? '').trim().slice(0, 50),
            lastNoteShown: notes.length ? shown(notes.at(-1)) : false,
            notes: notes.length,
            notesShown: notes.filter(shown).length,
            part: row.dataset.mgPart ?? null,
            seg: row.dataset.mgSeg ?? null,
            steps: row.dataset.mgSteps ?? null,
            tools: tools.length,
            toolsShown: tools.filter(shown).length,
            worked: row.dataset.mgWorked ?? null
          }
        }

        const out = []

        for (const pair of document.querySelectorAll('[data-slot="aui_turn-pair"]')) {
          const group = pair.querySelector('[data-slot="aui_response-group"]')

          if (!group) {
            continue
          }

          let segment = { prompt: label(pair.querySelector('[data-slot="aui_user-message-root"]:not([data-mg-queued])')), queued: false, rows: [] }

          out.push(segment)

          for (const child of group.children) {
            if (child.matches('[data-mg-queued]')) {
              segment = { prompt: label(child), queued: true, rows: [] }
              out.push(segment)
            } else if (child.matches(ROW)) {
              segment.rows.push(describe(child))
            }
          }
        }

        return out.filter(segment => segment.rows.length)
      })

    // The verdict on one reading. `where` names it in the evidence and reasons.
    const judge = (segments, where) => {
      const summary = {}
      let withWork = 0
      let workRows = 0

      for (const segment of segments) {
        const { rows } = segment
        const work = rows.slice(0, -1)
        const answer = rows.at(-1)
        const tools = rows.reduce((sum, row) => sum + row.tools, 0)
        const hasWork = tools > 0 || work.length > 0 || answer.notes > 1
        const name = `${segment.prompt}${segment.queued ? ' (queued)' : ''}`
        const tag = `${where}, ${name}`

        summary[name] = {
          rows: rows.length,
          seg: [...new Set(rows.map(row => row.seg))].join('|'),
          part: rows.map(row => row.part).join(','),
          steps: rows[0].steps,
          worked: rows[0].worked,
          // Head row: the row stays for the "Worked for" line, its content goes.
          workRows: work.map(row => `${row.head ? 'head ' : ''}display:${row.display} h:${row.height} tools shown ${row.toolsShown}/${row.tools} notes shown ${row.notesShown}/${row.notes}`),
          answerRow: `display:${answer.display} h:${answer.height} tools shown ${answer.toolsShown}/${answer.tools} notes shown ${answer.notesShown}/${answer.notes}, last one shown ${answer.lastNoteShown}: ${JSON.stringify(answer.lastNote)}`
        }

        if (!hasWork) {
          must(answer.seg === 'plain', `${tag}: a reply with no work should be data-mg-seg="plain", it is ${JSON.stringify(answer.seg)}`)
          must(answer.lastNoteShown, `${tag}: the answer is not visible`)

          continue
        }

        withWork += 1
        workRows += work.length
        must(rows.every(row => row.seg === 'closed'), `${tag}: rows carry data-mg-seg ${JSON.stringify(rows.map(row => row.seg))}, expected all "closed"`)
        must(answer.part === 'answer' && work.every(row => row.part === 'work'), `${tag}: data-mg-part is ${JSON.stringify(rows.map(row => row.part))}, expected work… then answer`)
        must(rows[0].head && rows[0].steps, `${tag}: the first row has no data-mg-head / data-mg-steps`)
        must(rows.every(row => row.toolsShown === 0), `${tag}: ${rows.reduce((sum, row) => sum + row.toolsShown, 0)} tool row(s) still visible`)
        must(work.every(row => row.notesShown === 0), `${tag}: a work row still shows its text`)
        must(work.every(row => row.head || row.display === 'none' || row.height === 0), `${tag}: a work row is still laid out (${work.map(row => `${row.display}/${row.height}px`).join(', ')})`)
        must(answer.lastNoteShown && answer.height > 0 && answer.lastNote, `${tag}: the answer is not visible`)
        must(answer.notesShown === 1, `${tag}: the answer row shows ${answer.notesShown} of its ${answer.notes} messages, expected only the last`)
      }

      return { summary, withWork, workRows }
    }

    // ── Reading 1: the thread as it stands when the last turn has just ended.
    const folded = await settle()

    entry.evidence.allRowsMarkedAfterMs = folded ? Date.now() - ended : null

    // Which rows are still unmarked, and what they are (core d diagnostics).
    const unmarked = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-slot="aui_assistant-message-root"]')]
          .filter(row => !row.dataset.mgSeg)
          .map(row => {
            const pair = row.closest('[data-slot="aui_turn-pair"]')
            const box = row.getBoundingClientRect()

            return {
              id: row.dataset.messageId ?? null,
              stale: 'mgStale' in row.dataset,
              pairLive: pair?.dataset.mgLive ?? null,
              inPair: Boolean(pair),
              inGroup: Boolean(row.closest('[data-slot="aui_response-group"]')),
              anchor: row.closest('[data-session-anchor]')?.dataset.sessionAnchor ?? null,
              shown: row.checkVisibility(),
              top: Math.round(box.top),
              h: Math.round(box.height),
              text: (row.textContent ?? '').trim().slice(0, 60)
            }
          })
      )

    if (!folded) {
      entry.evidence.unmarkedRows = await unmarked()
    }
    must(folded, 'live: some reply rows still had no data-mg-seg (or a fold was still animating) 10s after the last turn ended')

    const live = judge(await read(), 'live')

    entry.evidence.live = live.summary
    must(live.withWork >= 2, `live: expected prompts two and three to end with work to fold; found ${live.withWork} such turn(s)`)
    await shot(entry, 'd-turn-end')

    // ── Reading 2: the same thread loaded back from history. Hermes may split
    // a turn into more rows there than it streamed, which is where rows that
    // are work from top to bottom (data-mg-part="work") come from.
    await page.reload()
    await waitForAppReady({ app, page }, 60_000)

    const restored = await page
      .waitForFunction(({ needle, viewport }) => (document.querySelector(viewport)?.textContent ?? '').includes(needle), { needle: THIRD_ANSWER, viewport: VIEWPORT }, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)

    if (restored) {
      const back = await settle()

      if (!back) {
        entry.evidence.unmarkedAfterReload = await unmarked()
      }

      must(back, 'after reload: some reply rows had no data-mg-seg 10s after the thread came back')

      const again = judge(await read(), 'after reload')

      entry.evidence.afterReload = again.summary
      entry.evidence.workRowsSeen = { live: live.workRows, afterReload: again.workRows }
      await shot(entry, 'd-turn-end-after-reload')
    } else {
      entry.evidence.afterReload = 'the thread did not come back after a reload; not judged'
      entry.evidence.workRowsSeen = { live: live.workRows }
    }

    if (!live.workRows && !(restored && entry.evidence.workRowsSeen.afterReload)) {
      results.observations.push(
        'd: no row with data-mg-part="work" ever existed in this run. With the mock, Hermes draws a whole turn (note, tool call, answer) as ONE row, so what was measured is the work inside the answer row (tool blocks and earlier messages hidden, last message visible). A turn spread over several rows is not covered.'
      )
    }
  })
}
