# Monograph

Monograph is a flat, monochrome look for the Hermes desktop app. It ships as
two files that Hermes already knows how to load:

- a desktop plugin, `monograph`, that holds the layout and the styles, and
  adds a few things of its own: a surfaces menu, a tidier corner, folded tool
  calls, model and service logos, its own surfaces (Home
  and Agent) and an Appearance page;
- a skin, `monograph`, that holds the colours only.

Nothing in Hermes itself is edited. Remove the two files and Hermes looks as
it did.

Design rules: opaque surfaces separated by hairlines, no blur, no shadows,
grayscale chrome. Colour appears only in model and service logos.

## Install

### Before you start

1. **Install Hermes Agent and the Hermes desktop app**: follow the official guide at
   <https://hermes-agent.nousresearch.com/docs>.
2. **Open the desktop app once.** That creates `~/.hermes`, where Monograph installs.
3. **Install Node.js 18 or later.** Check with `node -v`. If it's missing, get it from
   <https://nodejs.org> or run `brew install node`. The installer uses it to build the plugin.

### Install Monograph

```sh
git clone https://github.com/machina-exm/monograph.git
cd monograph
./install.sh --full
```

`--full` installs the complete look: Monograph with its add-ons, the companion
plugins in `extras/` (bot mascots, bot panel, model icons and reply previews,
the one-line live status, context ring, image cards, live titles), turns the
skin on and hides tool calls. Restart Hermes once afterwards so the Python
plugins load. Plain `./install.sh` installs Monograph alone and changes no
settings; then turn the colours on with `hermes config set display.skin monograph`.

`install.sh` builds a release of the plugin from the sources (in a temporary
folder; your checkout is not touched), then copies:

| File | To |
|---|---|
| the plugin | `$HERMES_HOME/desktop-plugins/monograph/plugin.js` |
| the skin | `$HERMES_HOME/skins/monograph.yaml` |

`HERMES_HOME` defaults to `~/.hermes`. The installer prints one line per file
(`created`, `replaced`, `updated` or `unchanged`), then runs the doctor (see
"After a Hermes update"). A running Hermes picks the plugin up within a few
seconds. The installer never edits Hermes' config, so turn the colours on
yourself:

```sh
hermes config set display.skin monograph
```

### Update

```sh
git pull
./install.sh
```

A file that would not change is left alone; the version it replaced is kept
in `$HERMES_HOME/monograph-install/previous/`. Options: `--no-skin` (plugin only), `--local` (build with your
`config.local.json`, see "Settings"), `--help`.

It refuses, and changes nothing, when Node is missing or too old, or when
`HERMES_HOME` is not a Hermes home (no `config.yaml` and no `hermes-agent`).

### Uninstall

```sh
./install.sh --uninstall
```

The first install keeps whatever it replaced in
`$HERMES_HOME/monograph-install/original/` (or a note that nothing was
there). Uninstall puts exactly that back, removes the folders it created, and
deletes its records. If you edited an installed file by hand, that copy is
kept in `$HERMES_HOME/monograph-uninstalled-<date>/` rather than lost. If your
config still names the skin, it tells you how to switch back.

## What it changes

**Shell.** One opaque field; zones meet at a hairline (the resize handle
carries it, and brightens on hover). Tabs show their state by text colour. The
status bar and the terms footer are hidden.

**Top-left corner** (`src/css/12-corner.css`). Row 1, in the title band: the
window buttons, the sidebar toggle, the Hermes mark and "Hermes". Row 2, at
the top of the sidebar: search, then the session list's filter and new-session
buttons. Every control is Hermes' own, moved with CSS. The window buttons are
native and do not zoom with the page, so the plugin publishes where they sit
in page pixels (`--mg-lights-x`, `--mg-lights-y`) and the row follows them. A
zone whose tabs Hermes puts on their own row keeps that row, under the corner.

**Sidebar** (`src/css/20-sidebar.css`, `src/modules/25-session-marks.js`).
Each session row starts with the logo of the model that answered in it, read
from Hermes' own session list. A working row's title shimmers and a ring
stands in for its time; an unread one gets a dot. Hermes' navigation group is
hidden: its pages open from the surfaces menu.

**Top-right corner.** One button, "Open a surface", opens a menu of
everything Hermes can show beside or instead of the chat: Browser, Terminal,
Files, Diff, then the pages (Agents, Artifacts, Scheduled jobs, Messaging,
Capabilities, Settings). Each row has a letter; with the menu open, press it.
Rows run Hermes' own actions. Terminal has no action a plugin may run, so its
row presses your terminal shortcut, and is disabled if you unbound it.

Hermes' own buttons in that corner, and where they went:

| Hermes button | In Monograph |
|---|---|
| Open settings | hidden; the Settings row of the surfaces menu, or ⌘, |
| Layout editor | hidden; ⌘K "Toggle layout edit mode", or ⌘⇧\ |
| HUD mode (Advanced mode) | kept, left of the surfaces button; also ⌘⇧H |
| Swap sidebar sides (Advanced mode) | kept, left of the surfaces button; also ⌘\ |
| Show / hide right sidebar | hidden; ⌘J still opens Files |

Simple mode hides HUD mode and Swap sidebar sides itself; their shortcuts
still work there.

**Window dragging.** Electron lets a drag region that comes later in the page
win over an earlier non-drag one, so a drag area laid over a button swallows
its clicks. Hermes keeps a 48px drag handle after the last tab, under where
the surfaces button sits; with the plugin in, that handle drags through a
strip that stops short of the buttons.

## Surfaces

Monograph's own rows sit at the top of the surfaces menu, above Hermes':

- **Home** (letter h, `src/modules/30-home.js`): what an empty session shows.
  The greeting with your name and picture above the message box; below it
  quick actions (a click fills the box and does not send), pinned sessions
  and recent sessions. Greeting, chips, labels and row titles share the
  message box's left edge. Pinning here pins in Hermes' sidebar and the
  reverse. Keyboard: Tab reaches everything, Up and Down move through the
  rows, Home and End jump, Left and Right move through the chips. It arrives
  once per empty session and never replays.
- **Agent** (letter p, `20-agent-panel.js`): a right-hand pane with the trace
  of the focused session's turn, its todo list and sub-agents.

Other modules: `00-services.js` puts a service logo on each tool row (by tool
name or URL; a tool with no known service gets a glyph for its kind),
`05-state.js` writes the state attributes the stylesheet keys on, and
`50-motion.js` gives dropdown menus their exit.

## Turns

`src/css/33-turns.css` and `turnDecor` in `src/plugin.js`. Checked by
`rig/suites/stability.mjs`.

- **Divider and fold.** While a reply runs, its tool rows, thinking and
  commentary are all on screen. About half a second after it ends they fold
  away under one line and a hairline: "Worked for 7m 56s · 12 tool calls,
  3 messages". Press the line to open the work, press again to close it. The
  time is the gap between your message and the reply's completion. A thread
  opened from history arrives folded, without the animation. Approvals and
  forms are never folded away, and a reply still running is never touched.
- **Running.** Whether a reply runs comes from Hermes' own turn state
  (`busyBySession`, matched to the thread through `data-session-anchor`), not
  from what is drawn: Hermes' running markers come and go between tool calls.
  When a turn ends with prompts queued behind it, the reply keeps counting as
  running until the next one starts (at most 5 s). The DOM markers still
  count too, for tiles the plugin cannot match.
- **The page stays still.** At the bottom, the fold animates and the bottom
  stays put (Hermes' stick-to-bottom holds it). Scrolled up, the element in
  view is measured before and after any change of ours and the difference is
  scrolled away in the same frame. A turn that ends while you are reading it
  (scrolled up, its rows on screen) does not fold until you scroll it out of
  view or back to the bottom. Pressing the line keeps the line where it is.
- **Segments.** A reply is folded per prompt. With queued prompts one reply
  holds several turns; each gets its own line as soon as the next one starts,
  so finished work does not stay open while a later turn runs.
- **Tool chips.** Hermes' tool rows as icon, label and a mono chip with the
  duration.
- **Thinking.** Header row plus a rail down the body. In Simple mode Hermes
  rests reasoning collapsed ("Thinking" with a timer); a press opens it, live.
  It needs `display.show_reasoning: true`; with tool calls hidden it is hidden
  by design.
- **Streamed text.** Each new block of a running reply fades up into place,
  once. Block by block, not word by word: the words belong to Hermes'
  renderer. The animation hangs off `data-mg-live` on the turn pair, which is
  set once per turn, so nothing replays when a running marker blinks.
- **Compaction note.** Hermes' "[CONTEXT COMPACTION …" / "[STILL IN PROGRESS
  …" prompt is drawn as one quiet line, "Context compacted"
  (`data-mg-compaction="closed|open"` on the row); a press opens it.
- **Hover.** Hermes already shows the time and a copy button under a reply on
  hover. Your own messages get a copy button beside their time.
- **Motion.** Nothing in the chat moves under `prefers-reduced-motion` or
  `:root[data-mg-motion="off"]`.
- **Cost.** Each thread has its own MutationObserver; one observer on the body
  only notices threads being mounted. Work runs once per frame for the turns
  that changed (rows added or swapped are dressed at once, before paint), a
  long history is dressed from the bottom up in 6 ms slices, and nothing
  polls. `window.__mgPerf` counts runs and time per job.

The tool, thinking and loading looks follow https://www.beautifului.dev/.

**Queued prompts.** A prompt sent while a turn is running goes to the
gateway's queue. Hermes draws no bubble for it when its turn starts: the reply
carries on under the previous prompt, and the bubble only appears after the
session is reloaded from history. The plugin draws it in the meantime. On each
`message.start` it notes the prompt the gateway names (`admission_id`, with the
text from the last `session.info`), then puts a copy of Hermes' own bubble in
front of the first reply row streamed after that start. If that row is the
first of its group, Hermes drew the prompt itself and nothing is added. The
copy cannot edit or rewind; it shows the time, copies, and folds a long prompt
to four lines. Records live in `sessionStorage` for the life of the window,
since a reload brings the real row back from history. Only prompts listed
while another turn of the session runs get a record; the bubble is placed in
the same frame as the reply row it belongs to.

### Left-over copies

After a switch to another session and back, Hermes can keep the live copy of a
turn in the thread beside the stored one. `markStale` (in `turnDecor`) marks
the copies with `data-mg-stale` and `33-turns.css` hides them:

- a prompt, when a later prompt in the thread has the same timestamp;
- a streamed reply row, when its turn is not running and a stored row in the
  thread ends on the same text (80 characters or more).

Marked rows are left out of the fold and of the tool-call count.

## Prompt box

- No focus ring: the border stays a hairline.
- The model pill and the model menu rows carry the vendor's logo (`src/logos`,
  matched on `provider/model`; add a vendor with an SVG there and a line in
  `index.json`).
- Effort opens as a slider (`41-effort.css`). It is Hermes' own effort menu
  restyled, so Thinking and Fast are the same switches, shown as the two
  corner buttons. Fast appears only for models Hermes offers it on.
- The slider's fill wears the brand colour of the model in use (`--mg-model`
  on `:root`, from the third field of each entry in `src/logos/index.json`;
  grey for a model with no entry), with stars crossing it while the menu is
  open.
- An approval mode chip sits beside "+" (reads and writes `approvals.mode`).
- In the composer, the model menu only picks a model: the effort chip on each
  row and the Effort / Thinking flyout are hidden there, because the effort
  pill sits beside it. Model menus elsewhere are untouched.
- "+" is drawn as a paperclip (Lucide, ISC licence).

## Settings

Settings > Plugins > Monograph (the Appearance page, `10-appearance.js`), or
"Open Monograph settings" in the command palette. Stored per machine through
the plugin's own storage, never in Hermes' config. Every change applies at
once, survives a restart and reaches a second window.

| Setting | Values | Default |
|---|---|---|
| Name | text, up to 60 characters, used in the greeting | empty |
| Picture | an image, cropped square and scaled to 128 px | none |
| Greeting | text, `{name}` is replaced by the name | the built-in line |
| Tool calls | shown, hidden | shown |
| Density | comfortable, compact | comfortable |
| Motion | on, off | on |

Hidden tool calls hide tool rows, run summaries and thinking; approvals and
questions always show. Compact tightens turns, tool rows, paragraphs and
sidebar rows; the composer keeps its size. Motion off stops every animation,
as does the system's "reduce motion" setting. The palette also has "Toggle
tool calls", "Toggle motion" and "Toggle density". "Reset to defaults" asks
first. Every control works from the keyboard; the switches are drawn in
grayscale on this page.

For your own builds, `config.local.json` (ignored by git) holds defaults and
the names of your own stylesheets in `src/css/addons/`, for example
`{ "tools": "hidden", "addons": ["mine"] }` for `src/css/addons/mine.css`. A
release build, and so `install.sh` without `--local`, leaves it out. Your name
belongs on the Appearance page, not here: a name that a build carries as a
default is written into your settings once, the first time that build runs.

## After a Hermes update

Hermes has no stable contract for its markup, so every rule leans on hooks in
it: `data-slot` names, labels, utility classes. After an update some may be
gone. The plugin keeps working; the parts that leaned on a missing hook fall
back to Hermes' own look.

```sh
node scripts/doctor.mjs
```

It reads every hook out of the stylesheets and out of the selector strings in
the plugin's code, and looks for each one in Hermes' desktop source
(`$HERMES_HOME/hermes-agent`, or `MG_HERMES_REPO`). Exit 0: all found. Exit 1:
it lists each missing hook and the file that uses it. Exit 2: no source to
check against (an app installed without the source). `install.sh` runs it
every time.

Monograph was last checked against Hermes commit `2bd378ed1b` (5 November
2026); `selectors.lock.json` records it. On a different Hermes the doctor says
what no longer matches.

## Source layout

| Path | What |
|---|---|
| `src/plugin.js` | The plugin core: injects the stylesheet, applies settings, the surfaces button, the corner, the turn fold |
| `src/modules/NN-name.js` | One feature each, joined into the plugin in name order (contract in `docs/workstreams.md`) |
| `src/css/NN-name.css` | The stylesheet, one file per area, joined in name order; `00-tokens.css` holds the design tokens |
| `src/css/addons/` | Your own extras, only in a build that asks for them in `config.local.json` |
| `src/logos/` | Model logos and `index.json`, which maps models to them; `services/` holds the service logos and their sources |
| `skin/monograph.yaml` | The skin: colours, and a veil that hides the first paint until the plugin's styles are in |
| `build.mjs` | Joins the above into `dist/plugin.js` (no dependencies, no bundler) |
| `install.sh` | Install and uninstall, see above |
| `selectors.json` | Hooks our own code creates, and hooks Hermes builds at runtime with the text that proves they exist |
| `selectors.lock.json` | The doctor's last result and the Hermes commit it ran against |
| `scripts/` | `doctor.mjs`, `release-check.sh` and probing tools for development |
| `rig/` | The test rig, see below |
| `docs/` | Notes for people working on Monograph |
| `test/` | Unit tests of the state machines in `src/machines/` (`npm test`) |

## Working on it

```sh
node build.mjs                 # dist/plugin.js, with config.local.json
node build.mjs --release       # without it
node scripts/doctor.mjs        # every hook still in Hermes?
scripts/release-check.sh       # nothing personal in a release?
```

`scripts/release-check.sh` builds a release in a temporary folder and fails if
the built plugin or the skin holds your login name, your home folder or any
home path, this repo's git name or email, a value from `config.local.json`, an
add-on, or anything shaped like a Hermes session id. Run it before sharing
the repo or a build.

When new code relies on a hook Hermes does not have because Monograph makes
it, register it: `node scripts/doctor.mjs --own '<hook as the doctor prints
it>'`. Hooks starting with `mg-` are recognised as ours without that.

## The test rig

`rig/` starts a second, sandboxed Hermes (its own home, profile and a mock
model) from a Hermes source checkout, loads a release build of the plugin,
and drives it with real pointer and key events through Playwright. It
reports each check with screenshots and measurements. See `rig/README.md`.

```sh
rig/locked.sh node rig/run.mjs --simple                 # core checks, Simple mode
rig/locked.sh node rig/run.mjs --suite package          # this package's checks, Advanced mode
rig/locked.sh node rig/run.mjs --simple --all           # every suite
```

The suites, each one app launch (`--suite <name>`):

| Suite | What it checks |
|---|---|
| `core` | the surfaces button, a queued prompt's bubble, the fold at the end of a turn (the default) |
| `package` | `install.sh` into the sandbox's home, the top band's controls at several widths and zooms, `--uninstall` |
| `home` | home on a new profile and with 500 sessions, pins, quick actions, keyboard, one left edge, the entrance |
| `appearance` | every setting by pointer and keyboard, odd names, the picture, a restart and a second window |
| `panel` | the agent panel's trace, todo card and sub-agents |
| `logos` | service logos on tool rows |
| `motion` | what animates, and that nothing does with motion off |
| `stability` | the chat stays still while it streams, folds and switches |
| `stress` | the chat under load, against bare Hermes in the same run |
| `pixels` | screenshots compared pixel by pixel with a reference set |
| `battery` | every control and every place Monograph touches the chrome |
| `a11y` | keyboard reach, focus, names, contrast |

Each feature suite ends with a hot-reload check: reloaded twice, then
unloaded, the plugin leaves nothing of its own behind.

## Licence

MIT, see `LICENSE`. That covers Monograph's own code and styles.

The logos are not Monograph's. Each one is the mark of its owner and is here
only to say which model or service a row belongs to; using Monograph gives you
no right to them beyond that.

- Model logos (`src/logos/*.svg`): `@lobehub/icons-static-svg` 1.102.0, MIT.
- Service logos (`src/logos/services/`): most from Simple Icons 16.37.0
  (CC0-1.0 icon data), the rest as each vendor publishes its own.
  `services/index.json` names the source and terms of every one.
- The paperclip in the message box is Lucide's (ISC).

If you own a mark and want it changed or removed, open an issue.

