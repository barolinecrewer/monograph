# Working on Monograph in parallel

Several agents build Monograph at the same time, each in its own git worktree
on its own branch. One orchestrator merges. These rules keep the owner's
running Hermes safe and the branches mergeable. They are not optional.

## What Monograph is

A redesign of the Hermes desktop app (Electron + React) that ships as one
desktop plugin, `monograph`, plus a colours-only skin. No Hermes source is
edited. Read, in this order:

1. `README.md` (what each part does).
2. `rig/README.md` (the test rig).
3. The Hermes skill references, when your task touches them:
   `~/.hermes/skills/autonomous-ai-agents/hermes-agent/references/desktop-plugins.md`
   (plugin SDK: slots, panes, pages, host API), `themes.md` (skin and probing
   rules), `monograph-turns.md` (how chat turns are marked and folded).
4. Hermes' own source, read-only: `~/.hermes/hermes-agent/apps/desktop/src`.

## Design rules (settled with the owner)

- Flat and opaque. Hairlines, no blur, no shadows, no gradients as decoration.
- Chrome is grayscale. Colour is allowed only for bots, model logos and
  service logos.
- Use the tokens in `src/css/00-tokens.css` (`--mg-canvas`, `--mg-surface`,
  `--mg-raised`, `--mg-hairline`, `--mg-text-1…4`, `--mg-dur-*`,
  `--mg-ease-*`, radii). Do not invent colours or durations.
- Motion: short, calm, purposeful. Animate `opacity` and `transform` only,
  never a property that moves other content, unless the brief says otherwise.
  Nothing moves under `prefers-reduced-motion: reduce` or when the user turned
  motion off. No animation may replay because an unrelated attribute changed.
- Quiet, exact copy. No exclamation marks, no emoji, no marketing words.
- Nothing personal in code: no owner name, paths, sessions or screenshots.
  `scripts/release-check.sh` must pass.
- No element is added inside a chat reply unless the brief says so. Mark with
  `data-mg-*` attributes and draw with CSS; React owns those nodes.

## Hard limits

- Work only inside your worktree. Never touch `~/Dev/hermes-monograph` (the
  main checkout), another agent's worktree, or anything under `~/.hermes`
  except your own scratch and rig output directories.
- Never run `node build.mjs --install` or `--install-skin`, never write into
  `~/.hermes/desktop-plugins` or `~/.hermes/skins`, never run
  `scripts/probe.mjs` (it injects code into the owner's running app), never
  change Hermes config, never restart or quit the owner's Hermes app, never
  kill a process you did not start.
- `~/.hermes/hermes-agent` is read-only reference. Do not edit, build or run
  git commands that change it.
- Commit to your own branch. Do not push, merge into `main`, rebase other
  branches, or create or delete worktrees.
- Do not send clicks or keys to the screen (no `computer_use`, no
  `osascript`). Test through the rig, which drives its own sandboxed app.
- Edit only the files your brief gives you. If you need a change elsewhere,
  write it down in your report instead of making it.

## Code layout

- `src/plugin.js`: the plugin core. Shared scope for every module.
- `src/modules/NN-name.js`: one feature per file. `build.mjs` joins them into
  the plugin in name order, each inside its own block. Contract:

  ```js
  MODULES.push({
    id: 'name',
    start(ctx) {
      // register slots, listen to events, add observers
      return () => { /* undo every one of them */ }
    }
  })
  ```

  - No `import` or `export` in a module. Use what `plugin.js` has in scope:
    `sdk`, `React`, `jsx`, `jsxs`, `useEffect`, `useState`,
    `useSyncExternalStore`, `getConfig`, `setConfig`, `subscribe`, `put`,
    `ROW`, `LOGOS` and the rest of its top-level names.
  - `start` runs once per plugin load, after the stylesheet is in. Whatever it
    adds (listeners, observers, timers, DOM nodes, attributes, registrations)
    must be removed by the function it returns: the plugin is hot-reloaded.
  - A module that throws in `start` is skipped; the rest carries on. Do not
    rely on that: guard against a missing element or API yourself.
  - To offer something to other modules, put it on `SHARED` at the top level
    of your file. Readers use optional chaining.
  - Loaded module ids are on `document.documentElement.dataset.mgModules`.
  - Doors the core already holds open for modules:
    - `SHARED.surfaces.push({ key, label, icon, letter, run })` adds a row to
      the surfaces menu (top right), above Hermes' own rows. `icon` is a
      codicon name, `letter` a free one (taken: b t f d a r j m c s; reserved:
      `p` agent panel, `h` home, `k` knowledge). Remove your row on stop.
    - `SHARED.settingsPage = Component` takes over Settings > Plugins >
      Monograph (the appearance module's). Others do not set it.
    - `SHARED.services` (the logos module's): `forTool(name)` and
      `forUrl(url)` answer `{ id, label, colour } | null`; a logo is drawn by
      CSS on any element carrying `data-mg-service="<id>"`.
- Settings are one object. Read with `getConfig()`, write with
  `setConfig({ key: value })`, listen with `subscribe(fn)` (returns the undo).
  Keys, all optional, none of them personal by default:

  | key | values | drawn as |
  |---|---|---|
  | `name` | text | in the greeting |
  | `avatar` | image data URI, or empty | the user's picture |
  | `greeting` | text, may hold `{name}`; empty means the built-in line | `greeting(getConfig())`, also `--mg-greeting` |
  | `tools` | `shown`, `hidden` | `:root[data-mg-tools]` |
  | `motion` | `on`, `off` | `:root[data-mg-motion]` |
  | `density` | `comfortable`, `compact` | `:root[data-mg-density]` |
  | `pinned` | list of `{ kind, id, label }` | the home module's |
  | `knowledge` | object | the knowledge module's |

  The core writes the three root attributes; a stylesheet may rely on them.
  Every animation is switched off under `:root[data-mg-motion="off"]` as well
  as under `prefers-reduced-motion: reduce`.
- `src/css/NN-name.css`: styles, joined in name order. One file per area.
- No dependencies. No bundler. Plain JS, `jsx()` calls instead of JSX.
- Performance is a feature. No `MutationObserver` on `document.body` with
  `subtree` unless there is no other way; scope it to the smallest node, batch
  work in one `requestAnimationFrame`, and never write to the DOM from an
  observer in a way that wakes it again. No polling under one second.

## Testing

- `node build.mjs` must succeed, and `node --check dist/plugin.js` too.
- `node scripts/doctor.mjs` checks every selector the CSS depends on against
  Hermes' source. Register new hooks as it tells you (`--write`).
- The rig starts a sandboxed second Hermes with a mock model and drives it
  with real pointer and key events (`rig/README.md`, sections "Suites" and
  "Running beside other runs"). Your checks go in a suite of your own,
  `rig/suites/<your suite>.mjs`; do not edit `rig/suites/core.mjs`,
  `rig/harness.mjs` or `rig/run.mjs` unless your brief gives them to you (if
  the harness lacks something, say so in your report, and work around it
  inside your suite). Always run through the lock, with your own output
  directory, and give the command a long timeout (600 s):

  ```sh
  MG_RIG_OUT=~/.hermes/cache/scratch/mg-rig-<your branch> rig/locked.sh node rig/run.mjs --simple --suite <your suite>
  MG_RIG_OUT=~/.hermes/cache/scratch/mg-rig-<your branch> rig/locked.sh node rig/run.mjs --simple    # core must still pass
  ```

  The window opens behind everything and never takes the keyboard. Exit code
  3 from `locked.sh` means the wait for a slot ran out: run it again. Run the
  owner's mode (`--simple`) every time and Advanced mode (no flag) at least
  once before you report.
- Every feature gets rig checks before it is called done: it shows up, it
  works with a real click, it leaves nothing behind when closed, it does not
  break checks a to d, and the renderer console has no new errors
  (`renderer-console.log` in the run's evidence directory).
- Look at your screenshots (`vision_analyze` on the files the rig saves).
  A check that passes on a layout that looks wrong is a failed check.
- Scratch files: `~/.hermes/cache/scratch/mg-<your branch>/`.

## Reporting

End with a report the orchestrator can act on without reading your transcript:

1. What you built, in plain terms, and what you left out.
2. Files changed and commit hashes on your branch (`git log --oneline main..`).
3. Rig result: the exact `result:` line and each check's status, with the
   evidence directory. Say which checks are new.
4. What you did not test, and anything you are unsure of. A claim you did not
   verify is marked as such. Do not round up.
5. Bugs or oddities you saw that are outside your brief.
6. Changes you need in files you do not own.
