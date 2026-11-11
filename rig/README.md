# Monograph test rig

Starts a second, sandboxed Hermes desktop app with the Monograph plugin loaded,
drives it with real mouse and keyboard events through Playwright, and reports
four checks with screenshots. It does not touch the Hermes you are working in:
it has its own `HERMES_HOME`, its own Electron profile and a mock model.

## Run

```sh
node rig/run.mjs            # release build, Hermes in Advanced mode (what a new profile gets)
node rig/run.mjs --simple   # same, with Hermes in its Simple interface mode
node rig/run.mjs --local    # build with config.local.json (your name ends up in screenshots)
node rig/run.mjs --keep     # leave the sandbox on disk for a post-mortem
node rig/run.mjs --verbose  # also print Playwright's own output
node rig/run.mjs --simple --all             # every suite; one table of every check at the end
node rig/run.mjs --simple --suite stress --repeat 3   # three runs; flaky checks listed apart
node rig/run.mjs --simple --motion off     # Monograph's motion setting off for the whole run
node rig/run.mjs --simple --motion reduced # prefers-reduced-motion: reduce emulated for the whole run
node rig/run.mjs --lint                    # no app: merge safety (see "Lint")
```

A run takes about 40 seconds. A 1220x800 Hermes window opens on your screen for
that time and closes by itself. Leave it alone while it runs: the checks click
at screen positions inside it.

Exit code: `0` all checks passed, `1` a check failed or did not run, `2`
the rig itself broke (or left a process behind). With `--all` or `--repeat`,
`1` also when a check passed in some runs and failed in others (flaky).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MG_RIG_HERMES_REPO` | `~/.hermes/hermes-agent` | Hermes checkout to run |
| `MG_RIG_OUT` | `~/.hermes/cache/scratch/mg-rig` | screenshots, logs, temp files |
| `MG_RIG_LIMIT_S` | 600, or the suite's `limitS` | seconds before a run is killed |

Each run writes `MG_RIG_OUT/<UTC date-time>/`: `shots/*.png`, `results.json`
(everything the report prints), `playwright.log`, `app.log`,
`renderer-console.log`. Nothing is written into this repo, so there is nothing
to keep out of git.

## Needs

Nothing of its own. Playwright and Electron come from the Hermes checkout's
`node_modules`, the app is the checkout's existing `apps/desktop/dist`, and the
backend runs on the Python environment the installed Hermes already built. The
rig never builds or installs any of these. If one is missing it stops and says
which.

## What happens in a run

1. The plugin sources are copied into the work dir and built there, so
   `dist/plugin.js` in this repo (your local build) is neither read nor replaced.
2. Hermes' own e2e helpers (`apps/desktop/e2e/fixtures.ts`, imported from the
   checkout, not copied) make a sandbox under `MG_RIG_OUT/t-xxxxxx/` and start
   the mock model server (`tests-js/scripts/mock-server.ts`).
3. The built plugin goes to `<sandbox HERMES_HOME>/desktop-plugins/monograph/plugin.js`.
   That is all Hermes needs: a folder with a `plugin.js` there is loaded and
   enabled by default, no config flag.
4. Electron starts with the sandbox as `HOME`, `HERMES_HOME` and profile. The
   rig refuses to continue if any of those paths is outside its work dir, or if
   the running app reports a different `HERMES_HOME`.
5. The four checks run in one window, in order.
6. The app and the mock are closed, any process still carrying the sandbox in
   its environment is stopped, and the work dir is deleted.

## The checks

**a. Boot.** The window is visible, the plugin's titlebar button
(`[data-tour="mg-surfaces"]`) exists, `--mg-canvas` resolves on `:root`, and the
message box is there. Proves the build loads in this Hermes at all. The evidence
also names the interface mode and Hermes' own buttons in the top-right corner.

**b. Surfaces button.** One `mouse.click` at the centre of the button. The page
logs every press, release and click it receives, with the element that got it
and whether the browser made it (`isTrusted`). Passes when the press landed on
the surfaces button, `.mg-surfaces-menu` opened within a second, and it is still
open a second later with rows in it. Proves a person's single click opens the
menu. When the press lands on something else, the report names what covers the
button and how much of the button a pointer can reach.

**c. Queued prompt.** Prompt one is sent and the mock holds its reply after the
first word. Prompt two is queued behind it (Ctrl+Enter). For four seconds the
thread is sampled, then the mock lets go. Passes when prompt two did not reach
the model while prompt one was held, something on screen showed it as queued,
and a visible `[data-mg-queued]` bubble with prompt two's exact text then sits
in prompt one's turn while that turn still carries a running marker
(`aui_turn-activity` or `aui_response-loading`), still true after the
screenshot. Two screenshots: `c1-…` while prompt one is held, `c-queued-bubble`
with the bubble.

**d. Turn end.** After prompt two (one tool call) and prompt three (a note, a
tool call, an answer) finish: every reply row has `data-mg-seg`; a reply with no
work is `plain`; a reply with work is `closed`, starts with a head row carrying
`data-mg-steps`, shows none of its tool rows and none of its earlier notes, and
shows its last message. Rows marked `data-mg-part="work"` must be `display:none`
or zero height. Judged twice: straight after the last turn, and again after a
page reload, when the thread is drawn from history.

Lines starting `observed:` in the report are things the rig saw on the way that
are no check's verdict.

## Known limits

- **Mock model, not your provider.** Replies, tool calls and their timing are
  scripted by Hermes' mock server. The event shapes of a real provider can
  differ, and with them what the plugin sees. A pass here says the plugin
  handles these shapes, not every shape.
- **Check d never sees a separate work row.** With the mock, Hermes draws a
  whole turn (note, tool call, answer) as one row, live and after a reload. So
  what is measured is the work inside the answer row. The rules for rows that
  are work from top to bottom are written in the check but nothing exercises
  them; the report says so every time that is the case.
- **Check c: the bubble comes with the queued turn, not before.** While prompt
  one is itself still streaming there is no `[data-mg-queued]` bubble, only
  Hermes' own "1 Queued" chip. The bubble appears when Hermes starts the queued
  prompt inside prompt one's turn. The check passes on that reading of "while
  the first turn is still running".
- **New profile.** The sandbox has no sessions, no settings and the default
  layout. `--simple` is the only state it can put the app in. A problem that
  needs your sessions or your layout will not show.
- **One window size**, 1220x800, the size Hermes' fixtures open.
- **Reads one file from the real install**: `~/.hermes/installs/<id>/facts.json`,
  to find the Python environment, which is then run in place with bytecode
  writing off. A fresh `HERMES_HOME` would otherwise download a whole
  environment first.
- **Not the packaged app.** This is the checkout's `dist` under the checkout's
  Electron, not `Hermes.app`. The packaged app opens no debugging port
  (`electron/dev-cdp.ts`), and the rig does not try to make it.
- Prompt three uses the mock's `E2E_CORRECTION_SWITCH_TRIGGER` script. The
  longer `E2E_INTERIM_TRIGGER` script calls a `todo` tool that this Hermes
  rejects, and the turn dies on it.

## Suites

One run boots one sandboxed app, runs check a (boot) and then the checks of
one suite. `rig/suites/core.mjs` holds checks b to d; every feature has a
suite of its own beside it.

```
node rig/run.mjs --simple                  # the core suite
node rig/run.mjs --simple --suite home     # rig/suites/home.mjs
node rig/run.mjs --simple --all            # every suite, one app launch each
```

A suite is a module that exports:

```js
import { RUNNING, VIEWPORT, check, finished, results, shot, sleep, state, type, within } from '../harness.mjs'

// Reported in this order, after "a". Ids are short and unique in the suite.
export const checks = [['h1', 'Home: greeting on an empty session']]

// Optional. Options for Hermes' mock model (tests-js/scripts/mock-server.ts).
export const mock = { replyForPrompt: prompt => 'A reply.' }
// Optional, instead of `mock`: a model server of the suite's own.
// export const model = async ({ startMockServer }) => ({ url, port, close() {} })
// Optional. Extra YAML appended to the sandbox's config.yaml.
// export const config = 'display:\n  show_reasoning: true\n'
// Optional. Files to put into the sandbox before the app starts.
// export async function seed({ sandbox, mock }) {}

export async function run() {
  const { app, page, mock, sandbox } = state

  await check('h1', async (entry, must) => {
    entry.evidence.greeting = await page.locator('.mg-home h1').innerText()
    must(entry.evidence.greeting, 'no greeting')
    await shot(entry, 'h1-home')
  })
}
```

- `check(id, body)` never throws: a check that throws fails, with the error
  and a screenshot kept. `must(ok, reason)` records why a check failed and
  lets it go on, so one run reports everything that is wrong.
- `entry.evidence` is printed in the report. Put measurements there, not
  only verdicts.
- `type(text, keys)` puts text in the message box and presses `keys`
  (`'Enter'`, or `'Control+Enter'` to queue). `finished(needle, timeout)`
  waits for a turn to end with `needle` on screen.
- Prompts are scripted by the tokens in them, as the mock reads them: see the
  comment at the top of `suites/core.mjs` and `E2E_CALL(tool)[{json}]` in the
  mock's source.
- `results.observations.push(...)` is for things worth knowing that are no
  check's verdict.

## Running beside other runs

`rig/locked.sh <command>` holds one of six machine-wide slots while the
command runs and passes its number on as `MG_RIG_SLOT`; the harness gives each
slot its own place on the screen. Use it whenever more than one run may be
going (several worktrees, several agents):

```
MG_RIG_OUT=~/.hermes/cache/scratch/mg-rig-mine rig/locked.sh node rig/run.mjs --simple --suite home
```

The rig's window never takes the keyboard (`rig/no-focus.cjs`): it opens
behind whatever is in front, has no Dock icon, and goes on drawing when
covered. The page is told it has focus through the debugging protocol, so
focus styles and the caret behave as in a window in front. Typing at the
machine while a run is going neither disturbs the run nor is disturbed by it.

## Harness additions

All additive: every earlier export works as before.

**Console errors fail a check.** Every console message and page error of the
run is kept (`consoleEvents`). When a check ends, anything new of type
`error`, every `pageerror` (uncaught exceptions and unhandled rejections) and
any `[monograph] … skipped/failed` warning fails it, with the text in
`evidence.consoleErrors`. Exceptions: `CONSOLE_ALLOW` in `harness.mjs` (short
and commented: Electron's CSP notice, the closed proxy port) and a check's own
`entry.allowConsole = [/…/]` for an error it provokes on purpose.
`consoleErrorsSince(mark)` reads the list directly. A message that arrives
after its check ended counts against the next check.

**`overlaps(selectors = INTERACTIVE, { within, min })`** returns
`{ pairs: [{ a, b, overlap }], seen }`: every pair of visible, interactive
elements whose boxes intersect, ignoring pairs where one holds the other.
Visible means `checkVisibility()` with opacity and visibility, at least 2x2 px
after clipping by every clipping ancestor, `pointer-events` not `none`, not
inert or aria-hidden. `within` is a rectangle `{ x, y, width, height }` or a
selector.

**`layoutProblems()`** returns `{ hScroll, clippedText, truncated }`: a
horizontal scrollbar on the page or any element that shows one, and text cut
off inside a button. Text cut with an ellipsis is listed as `truncated` and is
not a fault.

**`setWindow({ width, height, zoom })`** resizes the window and sets the zoom
factor; returns the page's inner size and zoom.

**`perf(fn)`** records the page while `fn` runs, with the same recorder
`scripts/probe.mjs` uses (`scripts/rec-start.js`, `rec-stop.js`), and returns
`secs`, `fps`, frame gaps (`p50`, `p95`, `p99`, `maxFrame`, `slow32`, `slow50`,
`slow100`), `longtasks { n, total, top }`, `shifts { n, sum, noInput, top }`,
`viewport { anchorNoInput, anchorNoInputMax, scrollNoInput, gapMax,
gapFramesOver2, gapRunMax, gapFinal, … }`, `animStarts`, `transStarts`,
`events` and `fn`'s `value`.

- The viewport is the thread on screen (`ON_SCREEN_VIEWPORT`: Hermes keeps
  the threads of other open tabs in the page, hidden, often with a size).
- "No input" means no wheel, key or pointer press in the 500 ms before.
- `anchorNoInput`: how far, in total, the element the reader is looking at
  (the deepest element 40% down the viewport) moved on screen with no input.
  This is the measure of "the page jumped". `scrollNoInput` is scrollTop moving
  with no input; it can move with nothing visible moving (the app keeping the
  view still while it adds rows above), so it is evidence only.
- `gap*`: distance from the bottom, per frame; `gapRunMax` is the longest run
  of frames more than 2 px off the bottom.

**`judgePerf(stats, { mode, limits })`** returns the reasons a record breaks
`PERF_LIMITS`, stated up front:

| limit | value |
| --- | --- |
| movement without input | 2 px in total (`mode: 'reading'`: the anchor; `mode: 'pinned'`: off the bottom for more than 2 frames, or at the end) |
| a single frame | 100 ms |
| long tasks | 200 ms per 10 s of recording |
| layout shifts without input | none |

**`hotReload({ source, gone })`** rewrites the sandbox's
`desktop-plugins/monograph/plugin.js` in place (Hermes fs-watches each
plugin file, `src/contrib/runtime-loader.ts`; an atomic replace would orphan
the watch) and waits until the plugin's stylesheet has a new `data-owner`,
the stamp `register()` puts on it. `gone: true` waits for the stylesheet to go
instead, for `stubPlugin()`: a plugin with Monograph's id that registers
nothing, so a suite can measure the same scenario on bare Hermes, then put
Monograph back with `hotReload()`. `rebuildPlugin()` runs `build.mjs` again in
the staged copy.

**`instrumentHooks()` / `measureHooks()`**: event listeners on window,
document, html, head and body by type (DevTools' own count), live observer
objects by kind after a garbage collection (`Runtime.queryObjects`), observers
observing and intervals running (counted from `instrumentHooks()` on), heap and
element count. Compare two readings to see growth.

**`quiet(limit = 60000, holdMs = 3000)`** resolves `true` once no turn has
been running anywhere in the page for `holdMs` in a row, `false` when `limit`
ms pass first.

**`currentSession()`** is the stored id of the session on screen, read from
the route (`#/<id>`), or `null` on a new draft.

**`sessionSwitch(id, timeout)`** goes to a session the way Hermes' own e2e
suite does (it sets the route) and waits until the route shows it and a
thread is on screen; `''` goes to a new draft. Returns `{ id, ms }`.

**`setMotion(value)`** in the middle of a run: `'off'` / `'on'` write
`:root[data-mg-motion]` directly (the motion module follows the attribute, so
the kill switch comes and goes with it; the plugin writes the attribute again
on its next settings change); `'reduced'` / `'no-preference'` set the emulated
media feature. For a whole run, `--motion off|reduced` instead: `off` stores
the setting before the app reads it, `reduced` emulates the media feature from
the start; either is named in the run's notes.

**`shot(entry, name)`** at a zoom factor other than 1 takes the picture through
the debugging protocol (`Page.captureScreenshot`): Playwright's own cropped
it to the CSS width (640 of 800 px at 125 %).

**`turnDone(needle, timeout)`** waits for the thread on screen to show
`needle` with nothing in it running. The older `finished()` reads the first
viewport in the document, which is the wrong one once a second session tab is
open.

**`composer()`** now prefers the message box on screen (other tabs keep theirs
in the page, hidden).

**`run.mjs`**: `--all` ends with one table of every check of every suite.
`--repeat N` runs the suite (or every suite, with `--all`) N times and marks
each check `pass`, `FAIL` (never passed) or `flaky` (passed in some runs). A
suite can ask for more time with `export const limitS = <seconds>`.

## Battery (`--suite battery`)

Breadth, with real clicks and keys. Its model is the stress suite's
(`startModel`) with three extra model ids for the model menu's logos.

- **b0** Self-test: a planted `console.error` and unhandled rejection, two
  planted overlapping buttons and a 120 px scroll by script with a 150 ms busy
  frame must each be caught. Proves the detectors can fail.
- **b1** Approval chip on an empty session; its menu has three rows; picking
  Manual changes the chip and Hermes' `approvals.mode`; the chip in another
  open session tab follows.
- **b2** Every surfaces-menu row opens something with a real click, the menu
  closes, and the surface can be closed again (its tab's close button, a
  close button that came with it, Close settings, the session in the sidebar,
  the same row again, Escape, its shortcut, in that order). Each row is
  judged against the state just before it; a surface nothing closes is reset
  with the palette's "Reset layout" so it fails alone.
- **b13b** At 800 px and zoom 1 and 1.25: the message box on screen and the
  thread inside the window, with Monograph and on bare Hermes.
- **b3** Sidebar collapse and expand with a real click; no overlaps in the
  top band while collapsed.
- **b4** New session, then switching between two sessions by the sidebar.
- **b5** Settings > Plugins > Monograph renders, is listed once, and its
  switch flips `:root[data-mg-tools]` and back.
- **b6** The model menu's Claude, OpenAI and DeepSeek rows carry a logo with
  an image and a size.
- **b7** A drag across the effort slider passes through the levels and ends
  on the last; the pill follows.
- **b8** "Toggle tool calls" in the palette, by Enter and by click: the root
  attribute flips once each time; one such row.
- **b9** Tools shown: thinking and a tool row are on screen while a reply
  with reasoning and a call streams.
- **b10** Tools hidden: a finished turn shows no tool rows, summaries or
  thinking, and its line counts no work; a streaming one never shows them; an
  approval card still appears (approval mode Manual from b1); denied.
- **b11** Hermes' own long prompt folds to about four lines and a press opens
  it; Monograph's queued copy of a long prompt folds the same, opens and folds
  again on a press.
- **b12** Copy beside a prompt (ours) and under a reply (Hermes') put the
  text on the clipboard. Copies go to a variable in the app's main process,
  never the system clipboard.
- **b13** Widths 800, 900, 1220, 1800 at zoom 0.9, 1, 1.25: no overlaps in the
  top band, sidebar header or composer, nothing under the native window
  buttons, no horizontal scrollbar, no text cut off in a button.
- **b14** Five hot reloads: exactly one `#mg-css`, surfaces button, approval
  chip per message box, palette row, copy button per prompt; the same counts of menu rows and
  logos; no growth in listeners, observing observers or intervals; no console
  errors.

## Stress (`--suite stress`)

The chat under load, every scenario under `perf()` and judged by
`judgePerf`. Its model is its own (`startModel`, scripts in the file's head
comment); the 100-turn thread is made before launch through Hermes' stdio
gateway (`tui_gateway.entry`), about 25 s. `limitS` is 1100.

- **s1** Open the 100-turn thread; wheel to the top and back; every prompt
  drawn once. Judged against **s1b**, the same, cold, with Monograph unloaded,
  measured first in the same run: at least 92 % of bare's frame rate, long
  tasks at most 1.5 times bare's per 10 s (never held below `PERF_LIMITS`),
  longest frame at most bare's plus 25 % (or 100 ms), no more layout shifts
  without input than bare, movement as `PERF_LIMITS`. Bare Hermes itself
  breaks the fixed limits on this machine, hence the relative verdict.
  **s1v** the same with only Monograph's stylesheet, only its stylesheet
  minus the generated logo rules, and only its script: which half costs what.
  Each variant, and the whole plugin and bare Hermes beside them, carries
  `style`: a Chrome trace of a fixed scroll (20 wheel steps up, 20 down;
  `styleCost` / `traceScroll` in the suite) summed into style recalculation
  time, elements restyled and layout time.
- **s2** 40 tool calls stream while the reader is 1,400 px above the bottom:
  the text being read must not move. **s3** the rest of that turn pinned to the
  bottom: must stay pinned; the fold must count 40 calls. **s2b** both again
  with Monograph unloaded (numbers only).
- **s4** Five prompts queued behind a held turn: none reaches the model early,
  each prompt and reply drawn once, in order, and every reply readable whole.
- **s5** Stop mid-stream: stops within 5 s, the partial reply stays, the next
  prompt works.
- **s6** Switch to another session mid-turn and back: the prompt and reply
  drawn once.
- **s7** Resize 900 → 1500 → 1000 → 1800 → 1220 while a reply streams: stays
  pinned. Layout shifts are reported, not judged (a resize moves things).
- **s8** A 2,000-line reply with code blocks and tables, streamed and then
  scrolled. **s8b** the same with Monograph unloaded.
- **s9** Surfaces, model, approval and effort menus opened and closed fast
  while a reply streams: every press opens its menu, never two at once, none
  left open, the reply finishes. Its timing is judged against **s9b**, the
  same on bare Hermes in the same run (only the model and effort menus exist
  there): long tasks at most twice bare's per 10 s, longest frame at most
  bare's plus 25 % (or 100 ms). **s9c** one menu at a time, eight presses
  each, plus the reply alone, for attribution (numbers only); each menu's
  record then carries `style`, four more open-and-close presses under the
  same trace as s1v, so a menu's own style and layout cost reads apart from
  the reply's.

The reference checks (`*b`, `s1v`) pass unless the rig breaks; their numbers
sit beside the check they mirror, which is how a cost is put on Monograph or
on Hermes. Timings come from a machine running up to six rig windows at once:
compare within a run, and repeat before calling something slow.

## A11y (`--suite a11y`)

- **y1** Tab from the message box reaches the surfaces button, the approval
  chip, a prompt's copy button and the "Worked for" line; each of ours that is
  reached looks different focused than not.
- **y2** The surfaces and approval menus open with Enter and with Space, focus
  moves into them, ArrowDown moves between rows, Escape closes and focus goes
  back to the trigger.
- **y3** Every icon-only button of ours has an accessible name.
- **y4** Contrast from resolved colours: the token matrix (`--mg-text*` on
  `--mg-canvas`, `--mg-surface`, `--mg-raised`, `--mg-hover`, `--mg-active`)
  as evidence, and every text run and icon drawn in our places against its
  real background: 4.5:1 for text, 3:1 for large text and icons.
- **y5** Under emulated `prefers-reduced-motion: reduce`, open our menus, run
  a turn, open and close the fold, press copy: no animation or transition of
  ours runs. "Ours" is decided by switching `#mg-css` off and seeing whether
  the element's animation or transition changes.
- **y6** The same with `:root[data-mg-motion="off"]`.
- **y4** also reads the stylesheets the FINISH area owns (`OWN_CSS` in the
  suite: tokens, shell, corner, surfaces, sidebar, cards, controls, composer,
  effort, menus, `addons/`) and fails on any rule there that sets `color` to
  `--mg-text-4`, the icon-only step. A rule that draws an icon says so: a
  `disabled` selector, the codicon font, or `font-size: 0`. Rules in other
  files are listed as evidence (`text4Rules`). Self-test: a planted rule must
  be caught.
- **y7** Grayscale. Every state below is shot at 1220x800 and again at
  1600x1000, and any pixel whose channels differ by more than `GRAY_SLACK`
  (12) is colour. Pixels inside `LOGO_BOXES` (plus 1 px) are allowed: bot
  faces (`[data-bot-face]`), model logos (`.mg-logo`, the model menu's row
  icons), service logos (`[data-mg-service]`), and `img`/`video`, which are
  content. A coloured pixel elsewhere fails the state; the evidence names the
  element under the worst cells and which of its colours has chroma, and a
  `-colour.png` beside the shot marks them in red. `lightSurfaces` lists
  24 px cells that are mostly white (evidence of a light-mode leak). The walk:
  the thread, the work folds open (a failed call, a diff), a code block, the
  five-language reply (`MGY_LANGS`: ts and python, then bash, json and diff),
  a table, a success and a failure toast (raised with the SDK's
  `host.notify`), a link and a text selection, the surfaces, model, effort and
  approval menus, the model submenu, the palette, a session's context menu, a
  tooltip, keyboard focus on the surfaces button and the approval chip, the
  Home, Knowledge, Agent and Diff surfaces, every Settings page, Monograph's
  page and a focused switch, and the approval card. A state that cannot be
  reached is tried once more; a second failure is a skipped state and fails
  the check (`skipped`, `retried`). Self-test: a planted 6x6 blue square.
- **y8** Sidebar rows measured as drawn (colour over the real background,
  weight, fill): the selected row reads at least as strong as an unread one,
  which reads stronger than an idle one; each title 4.5:1; hover lifts an
  idle title; selected and unread keeps both cues. The pinned row is
  measured too, and the running row at its dimmest moment (the darkest stop
  of its shimmer gradient); with motion off it must still show the ring in
  place of its time. Self-test: the selected title planted back to the third
  step must read dimmer than the unread one.
- **y9** Meaning without colour. Each state a hue used to tell must carry a
  glyph, a weight, a shape or text: the session menu's Delete row (glyph,
  weight 600 against the other rows) and its confirm button (not the
  primary's fill, an edge at 3:1, weight 600); a provider error in the thread
  (`MGY_FAIL`: glyph and title); a failed call, its row opened (Hermes'
  `Error` glyph or its "Error details" label); diff rows (`+` and `−` marks,
  two fills, two edges, no strike-through: planted with diff-lines.tsx's
  classes, since this Hermes shows a patch in the thread only as a `+1 −1`
  chip and the Diff surface reads git); an approval card (an edge at 3:1, a
  heavier label, the command, and the activity line above it at 4.5:1); a
  failure and a success toast (different glyphs, the failure a
  `role="alert"`); the unread dot (a filled circle in place of the time, a
  heavier title); an invalid field (planted `aria-invalid` on a Settings
  field: dashed edge). Then a Tab walk of 30 stops in the main window from
  the message box and 30 on Monograph's Settings page: every stop must gain
  an outline, ring or edge that is gray and 3:1 against the opaque surface
  under it (the message box shows its caret instead). Self-test: the diff
  marks planted away must fail.

The a11y suite's model is the stress model behind `scriptedModel()`
(harness), which answers `MGY_LANGS` with code in five languages and a table
and `MGY_FAIL` with a provider's 400.

## What these suites cannot show

- The mock and the stress model are not a real provider: no real latency
  spread, no provider-specific event shapes.
- The 100-turn thread is drawn from history, never streamed live.
- A check that passes on a layout that looks wrong is still wrong: the
  screenshots are part of the result.

## Pixels (`--suite pixels`)

The app in a fixed list of states, each one screenshot, compared pixel by
pixel with a reference set kept beside the run folders,
`<MG_RIG_OUT>/pixels-ref/<mode>/`. A change that is meant to cost nothing on
screen must leave every state identical.

```sh
MG_PIXELS=record node rig/run.mjs --simple --suite pixels   # on the build to compare against, before the change
node rig/run.mjs --simple --suite pixels                    # after it: every state compared
```

Animations are stopped, the caret hidden, the pointer parked, clocks masked.
A difference is written as `<state>-diff.png` next to the shot. Do not edit
the suite to make a state pass; record again only on the build you compare
against.

Masked, in both images: times of day, relative times (`now`, `3m`), elapsed
times, a month and year (`November 2026`: the knowledge page's date groups
change with the calendar), the whole turn-duration line (`⏱ 3s`: the
stopwatch is a colour emoji drawn through a grayscale filter and its raster
varied between runs, 145 px in p02/p03), the message box's random
placeholder, and bot faces (animated by Hermes' clock).

States added in wave 3: **p25** the Home page, **p26** the Knowledge page,
**p27** the agent panel open beside the thread, **p28** Settings > Plugins >
Monograph (the Appearance page).

## Skin (`MG_RIG_SKIN=1`)

By default the sandbox runs on Hermes' own default skin, as a new profile
has it, so Hermes' light-mode values show wherever Monograph does not pin a
token. `MG_RIG_SKIN=1` puts `skin/monograph.yaml` into
`<sandbox HERMES_HOME>/skins/` and selects it the way a user does
(`display.skin: monograph` in config.yaml, which is what
`hermes config set display.skin monograph` writes); the run's notes say so.
Any suite can run either way:

```sh
MG_RIG_SKIN=1 MG_RIG_OUT=… rig/locked.sh node rig/run.mjs --simple --suite a11y
MG_RIG_SKIN=1 MG_RIG_OUT=… rig/locked.sh node rig/run.mjs --simple --suite pixels
```

The pixel reference is the same folder with and without the skin, so a
pixels run with the skin compares against a reference recorded without it:
every difference is a place where the plugin looks different under the
owner's skin.

## Life (`--suite life`)

What the plugin leaves behind across hot reloads and an unload, and what that
costs. A probe goes into the page before any script runs (an init script,
then a page reload; active only while `sessionStorage.mgLifeProbe` is `1`).
It wraps `addEventListener` / `removeEventListener`, the three observer
constructors and `observe` / `unobserve` / `disconnect`, `setTimeout`,
`setInterval`, `requestAnimationFrame` and their cancels, the SDK's
`host.onEvent` and every host atom's `listen()`. A call is the plugin's when a
frame of its stack runs from a `blob:` URL; Hermes loads each build as its own
blob module, so the URL also says which load made it. Subscriptions made with
`ctx.onEvent` live in Hermes' own registry, which the probe cannot reach;
Hermes disposes them itself, and a stale one would show as an old load's
activity.

- **l1** Counts after the first load, after 1, 3 and 6 hot reloads, and after
  an unload: listeners and observing observers on targets still in the page,
  intervals, pending timeouts and frames, host subscriptions, our nodes and
  `data-mg-*` marks outside threads, `<style>` elements, root attributes and
  `--mg-*` properties, `window` keys starting `mg`/`__mg`. Each reload must
  equal the first load, the unload must be zero. At every sample a short
  reply runs, and calls made by an earlier load during it (timers it arms,
  observer callbacks) fail the check; timers an old load armed in its own
  teardown (nanostores' delayed unmount) are counted apart.
- **l2** Self-test: the build plus a listener, an interval and a node that
  are never undone, loaded twice: each must show as one more.
- **l3** The stress suite's 2,000-line reply (`MGS_LONG(2000)`), three times
  each, taken in turn: on a freshly reloaded page, after six hot reloads, and
  with motion off; then three times on bare Hermes and once on bare Hermes
  with only Monograph's stylesheet. Judged on main-thread time
  (`Performance.getMetrics` in thread ticks, for the whole reply): the
  median after six reloads at most 1.15 times the fresh median plus 300 ms.
  Wall-clock long tasks, the plugin's own timed jobs (`window.__mgPerf`) and
  a CPU profile summary are evidence; so is each reply's stall (long-task
  time that was not spent running: the renderer descheduled on a loaded
  machine, seen on bare Hermes too). `MG_LIFE_PLANT=1` makes every
  hot-reloaded build leak about 300 ms of work per 10 s: l3 must fail then.
  Then one more reply under a Chrome trace with selector statistics
  (attribution only).
- **l5** Motion off costs no more than motion on: the medians of l3's
  motion-off and fresh replies, main-thread time per reply, at most 1.1
  times plus 150 ms.
- **l4** Element census after each long reply (with Monograph, after six
  reloads, bare): how many elements, how many inside the thread on screen and
  in other mounted threads, ours by class.

## Motion (`--suite motion`)

m1 to m8: every layer's enter and exit, fast cycles, controls, no replay,
motion off, reduced motion, hot reloads (see the suite's head). m9 to m11
film every animation of the app (menus, tooltip, palette, dialog, Settings
and a switch, a press, a prompt sent, tool rows and their logos, copy, the
fold, a session switch, the Agent pane and a step in it, Knowledge, home,
the scroll-to-bottom button): each animation frame samples the target's
opacity (times its ancestors'), box and transform and a few landmarks, and
the screencast's pictures, cropped to the target, become a contact sheet,
`shots/film-<on|off|reduced>-<scene>-<target>.png`. **m9** judges motion
on (time on the token plus four frames, more than two distinct frames, no
first frame at the end state, one burst, settled at the end, nothing else
moved); **m10** one second after each scene nothing of ours runs but a
declared endless animation with its cause present, compositor-only (a
planted stuck one must be caught); **m11** the same scenes with motion off
and with reduced motion: no animation or transition with any time in it,
everything drawn at the end, closed layers out of the DOM.
`MG_MOTION_FILM_ONLY=1` runs m9 to m11 alone (for working on them).
**m12** takes the animations wave 4 added (Agent pane fade, copy check,
working title) one at a time: the page's own `animationstart` must see it
play, and a trace around that one action must hold it with no
`compositeFailed` and no unsupported property (Chrome's own verdict; the
page-wide paint count is kept as evidence only). `MG_MOTION_ONLY=m12` runs it
alone after one turn; `MG_MOTION_PLANT=m12` swaps the pane's fade for a
margin and width animation, which m12 must catch.

## Home and panel, wave 6

- **h17** (home) opens every menu that reaches an empty session (model,
  effort, attach, surfaces, a sidebar row's context menu, the palette), and
  closes each once by a press outside and once by Escape, in a tab and in the
  main draft. Every frame (read in a ResizeObserver callback, after every
  rAF and layout) the greeting, home's body and the message box must be on
  screen and within 1 px of where they were, home's dock mark
  (`data-mg-home-dock`) must stay, and `data-mg-empty-chat` must not change.
- **h18** (home) films a first send from a new draft and a switch between
  two sessions with messages, with Monograph and then bare Hermes (stub
  plugin): the message box may not show at the middle (the empty layout)
  after it has docked, or at all on a switch.
- `MG_HOME_ONLY=h17` / `h18` seeds the 500 sessions and runs that check alone.
- **p17** (panel): an approval answered in a second window (Hermes'
  `openWindow`, the same session, Deny in Hermes' card there). The first
  window is sampled every frame: the pane's card must leave within 2.5 s (one
  `sessions.changed` cycle) and never show a pressable button once Hermes'
  own card has gone. `MG_PANEL_PLANT=p17` leaves a copy of the card behind,
  which p17 must catch.

## Lint (`--lint`)

`node rig/run.mjs --lint` launches nothing. It runs `node --check` on every
file in `rig/`, `rig/suites/`, `scripts/` and on `build.mjs`, makes a release
build in a temporary folder and checks that too, and fails on a check id
listed twice in one suite's `checks` (or reusing `a`, the boot check). Run it
after every merge: a duplicate import once broke four suites at load.
