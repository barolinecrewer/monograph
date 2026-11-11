# Agent panel: survey (section 3)

Surveyed 2026-11-10 against Hermes desktop 0.23.0, build `2bd378ed1b`.
"Read" means read in Hermes' source. "Measured" means seen in the live app.

## What the mockup asks for

The right-hand panel of the "Ace Studio" mockup shows one agent's work:

- a header with the agent's name and "Worked for 3m38s";
- the sources it searched (site names, "5+ more");
- its thinking steps and text;
- a "Run Creative Pipeline" card: seven steps, then Dismiss / Edit /
  Approve & Run.

The chat column lists the sub-agents at work; the panel shows the one selected.

## What Hermes already has

| Thing | Where | Use to us |
|---|---|---|
| Right-hand panes: Files, Review | `app/contrib/controller.tsx`, `area: 'panes'`, `placement: 'right'` | Our panel becomes a third pane in the same zone |
| `bot-panel` plugin | `~/.hermes/desktop-plugins/bot-panel` | A settings pane for a bot profile (model, behaviour, soul, cron, capabilities), 320 px on the right. Not a trace. Shows how a plugin registers a right pane |
| Agents page | `app/agents/index.tsx` | Sub-agent tree with a stream per agent. Built on a store plugins cannot reach |
| Sub-agent rows above the composer | `app/chat/composer/status-stack/subagent-section.tsx`, `[data-slot="composer-subagents"]` | Same store. Can be restyled with CSS |
| Approval card in the chat | `components/assistant-ui/tool/approval.tsx`, `[data-slot="tool-approval-card"]` | Hermes' real approval. Can be restyled with CSS |

## What a plugin can do

| Need | Route | Status |
|---|---|---|
| A right-hand pane | `ctx.register({ area: 'panes', data: { placement: 'right', width } })` | Read; `bot-panel` does it |
| Show, hide, reveal the pane | `host.paneVisibility(id)`, `host.revealPane(id)`, `host.undismissPane(id)` | Read |
| Hear the running turn | `sdk.host.onEvent('*', fn)` | Measured |
| Tool steps | `tool.start` carries `name`, `args`, `tool_call_id`; `tool.complete` adds `result`, `duration_s`, `is_error` | Measured |
| Which session an event belongs to | `session_id` on every event; `host.state.focusedSessionId` | Measured / read |
| Thinking and answer text | `thinking.delta`, `message.delta` (`text`) | Measured |
| Sub-agents | `subagent.start`, `.progress`, `.thinking`, `.tool`, `.complete`, `.spawn_requested`, `.roster` | Read; payloads not measured |
| Todo steps | `todo.updated` | Read; payload not measured |
| Answer an approval | `host.request('approval.respond', { session_id, request_id, choice }, APPROVAL_RESPOND_TIMEOUT_MS)`; choices `once`, `session`, `always`, `deny` | Read; the bundled `hermes-bots` plugin does it |
| Learn that an approval is waiting | `approval.request` arrives as a server request, not an event. `approval.pending` is an RPC | Not settled: unknown whether a plugin hears the request |

## Gaps between the mockup and Hermes

1. **No "Edit".** A Hermes approval can be allowed once, for the session,
   always, or denied. The command cannot be edited. The card gets Deny and
   Allow, with "for this session" and "always" behind a menu. No Edit button.
2. **No step list in an approval.** An approval is one command and a
   description. The mockup's seven steps match Hermes' todo list instead. The
   card shows the todo steps when the agent wrote some, and the waiting
   approval under them.
3. **No history.** Events arrive only while a turn runs. After a reload, or in
   an old chat, the panel has nothing to show unless it is rebuilt from
   `session.events.since` (exists, not examined) or from the chat's own rows.
4. **No service logos.** `src/logos/` holds 19 model-vendor marks and no
   service marks. Parallel, Apify, Cloudflare, Typefully, GitHub and Google
   need adding. How an MCP tool is named in `tool.start` is not measured.
5. **No sources field.** Sources have to be read out of search and fetch tool
   arguments and results. The result shape per tool is not measured.
6. **Sub-agent store is private.** The plugin has to build its own tree from
   the `subagent.*` events.

## Build order

1. Empty pane `monograph:agent` on the right, with a row in the surfaces menu.
2. Trace of the focused session's running turn from `tool.*` events: one row
   per step, with name, short argument, duration and error state.
3. Service marks on trace rows, then on the chat's tool rows.
4. Sources list from search and fetch steps.
5. Sub-agents: measure the payloads first, then a list with the bot designs;
   selecting one shows its trace.
6. Approval card: settle how the plugin learns of a waiting approval first.
   If it cannot, restyle Hermes' own card in the chat and leave the panel
   without buttons.
7. History after a reload, if `session.events.since` allows it.

Each step gets a rig check before it is called done.

## Built (2026-11-10, branch ws/panel)

`src/modules/20-agent-panel.js`, `src/css/60-agent-panel.css`, rig suite
`rig/suites/panel.mjs`. Measured in the rig (Hermes `2bd378ed1b`, Simple and
Advanced mode) unless marked otherwise.

### Measured payloads

| Event | Fields seen | Use |
|---|---|---|
| `tool.start` | `tool_id`, `tool_call_id`, `name`, `tool_name`, `context` (80-char argument preview), `args` | Row, argument, sources from `query` / `url` / `urls` |
| `tool.complete` | the above, `is_error` (bool), `result` (often a JSON string), `duration_s`, `inline_diff` | State and time. `is_error` is the failure flag; a failed search's result is an error text and is not read for sources |
| `reasoning.delta` | `text` | "Thinking" rows (needs `display.show_reasoning`) |
| `thinking.delta` | `text` | Hermes' spinner line ("(⊙_⊙) cogitating..."), not reasoning: ignored |
| `message.delta` | `text` | Kept as a note only if a tool or reasoning follows it; text that ends the turn is the answer and stays in the chat |
| `message.start` / `message.complete` | `complete` has `status`, `outcome`, `usage` | Turn start and end |
| `agent.step` | `iteration` | Ignored |
| `approval.request` | `request_id` (= `prompt_id`), `command`, `description`, `choices`, `timeout_s`, `execution_generation` | The waiting approval. **A plugin does hear it**: it is an event, not only a server request |
| `approval.settled` | `prompt_id`, `execution_generation` | Card down |
| `subagent.spawn_requested`, `.start`, `.thinking`, `.tool`, `.progress`, `.complete` | `goal`, `subagent_id`, `child_session_id`, `delegation_id`, `depth`, `model`, `tool_count`, `toolsets`; `.tool` adds `tool_name`, `tool_preview`; `.complete` adds `status`, `summary`, `duration_seconds`, token counts, `output_tail` | Sub-agent rows. `.thinking` text is a spinner line too: not shown |

Every live event carries `seq`. `delegate_task` returns at once and the child
runs in the background; its `subagent.complete` arrives after the parent's turn
ended, and its report wakes the chat into a new turn ("[ASYNC DELEGATION BATCH
COMPLETE …]"). Sub-agents therefore outlive their turn: running ones, and ones
that finished after their turn ended (less than two minutes before), are
carried into the next turn, the one their report starts. A sub-agent that
ended inside its own turn stays with that turn.

### What the pane does

1. **Pane.** `monograph:agent`, 340px, right placement, registered only while
   open (the bot-panel pattern: `undismissPane`, `revealPane` if adoption did
   not show it). Surfaces row "Agent", letter P, codicon `pulse`. Open state is
   in plugin storage, so a hot reload or a reload brings it back once. Closing
   unregisters it: no node, attribute or pane tab is left.
2. **Trace.** Rows for tool calls, reasoning blocks and interim notes: icon,
   label, argument, running / done / failed / stopped, time. Header "Working
   for 12s" (ticks once a second) then "Worked for 3m 38s", and a step count.
   Thirty rows are drawn; "N earlier steps" opens the rest (400 kept per turn,
   the oldest dropped and counted). Only the newest three running rows tick.
3. **Service logos.** A tool row carries `data-mg-service` from
   `SHARED.services?.forTool(name)` and its label; a source chip from
   `forUrl(url)`. Without the logos module rows show a grayscale codicon and
   chips grey text (verified). With the module present: not verified.
4. **Sources.** Hosts from `url` / `urls` / `query` arguments and, for
   successful search and fetch tools, URLs in the result. `www.` is dropped and
   each host listed once; four chips, then "N more". Queries are listed after
   "Searched".
5. **Sub-agents.** A row per sub-agent with a small bot (one of six body shapes
   in one of eight bloub colours, two eye slots that blink while it works),
   goal, current tool, tool count, time.
6. **Approval.** From `approval.request`; Deny and Allow. When Hermes' own card
   for the same `request_id` is on screen (`[data-slot="tool-approval-card"]
   [data-request-id]`), the pane presses that card's own button, so the answer
   takes Hermes' path and its card leaves too. Otherwise it sends
   `approval.respond { session_id, request_id, choice }`. Sending
   `approval.respond` while Hermes' card is up leaves that card standing in the
   chat (seen in the rig): Hermes clears it only for answers it sent itself.
   "Allow for this session" and "Always" stay in Hermes' card.
7. **After a reload.** The window keeps the last turn of the last eight
   sessions in `sessionStorage` and draws it again (verified). On focus the
   pane also asks `session.events.since` for what it missed. In this build
   that call returned `count: 0, truncated: true, snapshot_required: true`
   after a reload, so a trace cannot be rebuilt from the gateway: a new window
   or an app restart shows "No steps seen for this session in this window
   yet." Rebuilding from stored history would need a read of the session's
   messages (not built).

### Performance

Hermes' stylesheet has `:has()` rules high in the tree (`group/sidebar-wrapper
has-data-[…]` and others), so a DOM change anywhere, the pane's included,
re-styles most of the window (~420 elements per style pass with the pane
closed, ~700 with it open). The pane is built for that: it draws at most about
three times a second, four elements per row (dot and time are `::before` /
`::after`), thirty rows, no `scrollHeight` reads (it follows new rows by CSS
scroll anchoring; reading `scrollHeight` per update cost 3.5s of forced layout
in a 200-step turn), batches of more than eight new rows arrive without the
ease. p7 runs the same 200-step turn with the pane closed, open, and closed
again, and records frame times and a timeline summary.

### Debug log

With `localStorage['hermes.plugin.monograph.agentDebug'] = '1'` before the
plugin loads, every event the pane hears is kept (last 600, payload cut to 400
characters) on `window.__mgAgentEvents`. Off by default; the rig turns it on to
save `p2-events.json`, `p4-events.json`, `p5-events.json`.

### Not built

- A todo / step-list card (the mockup's "Run Creative Pipeline"): this Hermes
  has no `todo` tool in the sandbox, so `todo.updated` could not be measured.
- Selecting a sub-agent to see its own trace.
- History rebuilt from stored messages after an app restart.

## The bridged path (wave 3, measured)

On the owner's setup almost every connector and MCP tool is *deferred*: the
model finds it with `tool_search`, reads it with `tool_describe` and calls it
through `tool_call` (`{ calls: [{ name, arguments }] }`). Read in
`agent/tool_executor.py` (`_unwrap_tool_search_call`), `tools/tool_search.py`
(`resolve_underlying_call`), `tools/tool_labels.py`, `tui_gateway/tool_progress.py`
(`_on_tool_start`, `_on_tool_complete`, `_emit_tool_lifecycle`) and the
desktop's `connector-tool.tsx` (`ConnectorExecution`) and `message-parts.tsx`;
then measured in the rig (panel p14, p11, p11d: the suite registers four fake
stdio MCP servers, parallel, apify, cloudflare and firecrawl, so the calls are
real MCP calls under Hermes' default deferral). Every event below also carries
`tool_call_id` = `tool_id` and `tool_name` = `name`.

| Model call | `tool.start` / `tool.complete` `name` | `tool_id` | `args` | `labels` | Other events |
|---|---|---|---|---|---|
| `tool_search { queries }` | `tool_search` | the call's id | `{ queries }` | one, `kind: "tool"`, `app: "Searching tools"`, `action`: first query | `tool.generating { name: "tool_search" }` before |
| `tool_describe { names }` | `tool_describe` | the call's id | `{ names }` | one, `kind: "tool"`, `app: "Reading tool details"`, `action: "1 tool"` | `tool.generating` |
| `tool_call`, one inner MCP call | the **inner** name, `mcp__parallel__web_search` (the gateway unwraps it) | the outer call's id | the **inner** arguments | one, `kind: "mcp"`, `app: "Parallel"`, `action: "web search"`, `name`: inner | `tool.generating { name: "tool_call" }`; `context` is the inner preview |
| `tool_call`, three MCP calls to different servers | **three** start/complete pairs, each with its inner name, in the batch's order | the first keeps the outer id, the others get generated ids (`call_<12 hex>`) | each its own arguments | one each, `kind: "mcp"` | one `tool.generating` |
| `tool_call`, three connector calls (`connectors__gmail__…`, `connectors__notion__…`, `connectors__slack__…`) | **`tool_call`**, once: a connector batch is one dispatch unit | the outer id | `{ calls: [...] }` | **three**, `kind: "connector"`, `app: "Gmail"`, `action: "fetch emails"`, `name`: each inner | `context: "Gmail · fetch emails +2"`; `result.results[i]` per call (not connected in the sandbox: each has `error`; `is_error` itself is `false`) |
| `tool_call`, inner `todo_list` | `todo_list` (unwrapped) | outer id | the inner `{ todos }` | none (a built-in) | `todo.updated { todos, revision }` right after `tool.complete`, the same as a direct call |
| `tool_call`, inner call that fails when run (MCP server answers `isError`) | the inner name | outer id | inner arguments | one, `kind: "mcp"` | `tool.complete` has `is_error: true` |
| `tool_call`, inner `todo_list` with arguments that fail the deferred schema check (`todos: "not a list"`) | **none**: no `tool.start`, no `tool.complete`, no `todo.updated` (read from p11's `p11-events.json`, two attempts, seq 292 and 299) | — | — | — | only `tool.generating { name: "tool_call" }`, then the next `agent.step`; the model gets the schema error as the tool result. The pane settles a `tool.generating` that no `tool.start` follows (at the next `agent.step`, `tool.generating` or `message.complete`) as a failed step, "Call refused"; the plan card keeps its last list (p11) |
| `todo_list` called directly (`tools.tool_search.defer: []`) | `todo_list` | the call's id | `{ todos }` | none | `todo.updated`; a list that is not a list is **not** refused on this path: the tool takes it as one `"(invalid item)"`, `is_error: false`. An item with empty `content` is refused (`is_error: true`, no `todo.updated`) |

After a reload the transcript keeps the model's own call: the stored part is
`toolName: "tool_call"` with `args.calls`, and the desktop computes labels
again for the rows. Hermes' own todo panel reads both shapes
(`lib/todos.ts`, `isConfirmedTodoResultPart`).

### What Monograph does with it

- **Chat rows** (`00-services.js`): `ConnectorExecution` renders one
  `ToolFallback` per label with `innerToolName` = the inner name, so each inner
  call gets its own row and its own logo, in order. A bridged part drawn
  without labels (`toolName: "tool_call"`) is read from `args.calls`.
  `tool_search` / `tool_describe` resolve to the gray `tools` glyph, never a
  brand. Running rows already carry the logo, beside Hermes' spinner.
- **Trace** (`20-agent-panel.js`): a `tool.start` named `tool_call` becomes one
  step per inner call (from `labels`, else `args.calls`), each with its own
  name, label and logo; `tool.complete` closes them together, each failed or
  done by its own `result.results[i]`. Labels give the step its title
  ("Parallel · web search"; "Searching tools" with the query as detail).
- **Plan card**: fills from `todo.updated`, from a `todo_list` completion, or
  from a `tool_call` completion whose inner call was `todo_list` and whose
  result carries `todos`. A stopped command (`exit_code` 130,
  `[Command interrupted]`) reads stopped, not failed.

### Wave 3 changes beside the bridge

- **Sub-agent trace, Back** (p12). Back was pressed but focus was lost: the
  trace was keyed by turn, and a sub-agent's report wakes a new turn, so the
  rows were made again under the reader. The trace is no longer keyed by turn
  (its fold, sources and step list still are), Back and Escape put focus back
  on the row's open button once the trace is drawn, and a sub-trace opens at
  its top with Back in view.
- **The pane's tab** (p16). Hermes' `closeTreePane` turns a plugin with one
  pane *off* when that pane's tab is closed (`components/pane-shell/tree/store.ts`).
  The pane is registered with `data.uncloseable: true`: the tab offers no Close
  and the close gesture does nothing; the pane closes from its own button and
  the surfaces row. A plugin cannot register a pane closer
  (`registerPaneCloser` is not on the SDK).
- **Sources**: a site with a known service draws its logo; any other a neutral
  globe.
- **Drawing in bursts**: after an interval with more than twelve events the
  pane draws once a second instead of every 300 ms.
- **Approval** (p5, p15). The pane's Deny and Allow press Hermes' own card's
  buttons when that card is on screen, else send `approval.respond`. Measured:
  Allow from the pane gives one `approval.request`, one `approval.settled` and
  one run of the command; an answer given in Hermes' own card takes the pane's
  card down (`approval.settled`, then the tool completes). Another window was
  not tested.
