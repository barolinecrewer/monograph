// Service logos on tool rows.
//
// A tool that belongs to a service (an MCP server, a hosted connector, a
// brand-named built-in) gets that service's logo, in colour, in place of the
// row's generic icon. Built-in tools get a grayscale glyph for their family.
// The plugin only marks Hermes' row with an attribute; 34-services.css draws:
//   data-mg-service="<id>"      a service logo (any element, not only rows)
//   data-mg-tool-family="<f>"   a built-in family glyph
//   data-mg-svc-in              the row just arrived in a live turn: the logo
//                               fades in once, then the mark is removed
//
// Which name reaches a row (apps/desktop/src): message-parts.tsx sends a call
// with gateway labels (every mcp__* and connectors__* call, and each inner call
// of a bridged `tool_call`) through ConnectorExecution, which renders
// ToolFallback with `toolName` = the label's words ("Parallel · web search")
// and `innerToolName` = the real name (the inner call's for `tool_call`).
// Without labels `toolName` is the raw name. Hermes puts neither on the DOM, so
// the name is read from the row's React props, and from its title text when
// those cannot be reached.

// [{ id, label, colour, ink, aliases, hosts }] from src/logos/services/index.json (build.mjs).
const SERVICE_LIST = "__MG_SERVICES__"

const squash = value =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const SERVICE_BY_KEY = new Map()

for (const entry of SERVICE_LIST) {
  for (const key of [entry.id, entry.label, ...(entry.aliases ?? [])]) {
    const squashed = squash(key)

    if (squashed && !SERVICE_BY_KEY.has(squashed)) {
      SERVICE_BY_KEY.set(squashed, entry)
    }
  }
}

const answer = entry => (entry ? { colour: entry.colour, id: entry.id, ink: entry.ink, label: entry.label } : null)

// Built-in tools by family. Colour is for service logos only; these are drawn
// in gray by 34-services.css.
const FAMILY_OF = {
  browser_cdp: 'browser',
  browser_dialog: 'browser',
  browser_exec: 'browser',
  browser_vault: 'browser',
  close_terminal: 'terminal',
  computer_use: 'browser',
  cronjob: 'cron',
  cronjob_manage: 'cron',
  delegate_task: 'delegation',
  edit_file: 'files',
  execute_code: 'code',
  image_generate: 'vision',
  list_files: 'files',
  memory: 'memory',
  message_agent: 'delegation',
  patch: 'files',
  process_manage: 'terminal',
  read_file: 'files',
  read_terminal: 'terminal',
  search_files: 'files',
  session_search: 'memory',
  session_search_recall: 'memory',
  skill_manage: 'skills',
  skill_view: 'skills',
  skills_list: 'skills',
  terminal: 'terminal',
  text_to_speech: 'speech',
  todo: 'todo',
  todo_list: 'todo',
  tool_call: 'tools',
  tool_describe: 'tools',
  tool_search: 'tools',
  transcribe_audio: 'speech',
  video_analyze: 'vision',
  video_generate: 'vision',
  vision_analyze: 'vision',
  web_extract: 'web',
  web_search: 'search',
  write_file: 'files'
}

// Brand names that are also everyday words in tool names.
const COMMON_WORDS = new Set(['apollo', 'box', 'linear', 'neon', 'plain', 'ramp', 'apple'])

// Built-ins named after the service they talk to.
const BRAND_BUILTINS = { discord: 'discord', discord_admin: 'discord', x_search: 'x' }

// Google Workspace servers carry several products; the tool name says which.
const GOOGLE_PRODUCTS = [
  ['gmail', 'gmail'],
  ['calendar', 'googlecalendar'],
  ['drive', 'googledrive'],
  ['docs', 'googledocs'],
  ['sheets', 'googlesheets']
]

const tokensOf = text =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// A server or app name to a service: the longest run of its words that names
// one ("google_workspace" -> google, "wispr_flow" -> wisprflow, "github-mcp"
// -> github). Keys under three letters (x) only match the whole name, so an
// "x" inside a longer name never reads as X.
function fromSegment(segment) {
  const tokens = tokensOf(segment).filter((token, index, list) => !(token === 'mcp' && list.length > 1))

  if (!tokens.length) {
    return null
  }

  const whole = SERVICE_BY_KEY.get(tokens.join(''))

  if (whole) {
    return whole
  }

  for (let size = tokens.length - 1; size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const key = tokens.slice(start, start + size).join('')
      const hit = key.length >= 3 ? SERVICE_BY_KEY.get(key) : null

      if (hit) {
        return hit
      }
    }
  }

  return null
}

// "mcp_<server>_<tool>" with single underscores: the server is some leading
// run of words. The longest one that names a service wins, and at least one
// word is left for the tool.
function fromLeadingWords(rest) {
  const tokens = tokensOf(rest)

  for (let size = tokens.length - 1; size >= 1; size--) {
    const hit = fromSegment(tokens.slice(0, size).join('_'))

    if (hit) {
      return { entry: hit, tool: tokens.slice(size).join('_') }
    }
  }

  return null
}

const refine = (entry, tool) => {
  if (entry?.id !== 'google') {
    return entry
  }

  const words = tokensOf(tool)
  const product = GOOGLE_PRODUCTS.find(([word]) => words.includes(word))

  return (product && SERVICE_LIST.find(item => item.id === product[1])) || entry
}

function resolveTool(name) {
  const raw = String(name ?? '').trim()

  if (!raw) {
    return null
  }

  let match

  if ((match = /^mcp__(.+?)__(.+)$/i.exec(raw))) {
    return refine(fromSegment(match[1]), match[2])
  }

  if ((match = /^connectors__(.+?)__(.+)$/i.exec(raw))) {
    return refine(fromSegment(match[1].replace(/_mcp$/i, '')), match[2])
  }

  if ((match = /^(mcp|connectors)_([a-z0-9].*)$/i.exec(raw))) {
    const found = fromLeadingWords(match[2])

    return found ? refine(found.entry, found.tool) : null
  }

  if ((match = /^([^_\s].*?)__(.+)$/.exec(raw))) {
    return refine(fromSegment(match[1]), match[2])
  }

  // A row title from gateway labels: "Parallel · web search  query".
  if ((match = /^(.+?)\s+·\s/.exec(raw))) {
    return SERVICE_BY_KEY.get(squash(match[1])) ?? null
  }

  // A title Hermes built from a raw name: "Mcp Parallel Web Search".
  if (/\s/.test(raw) && /^(mcp|connectors)\s/i.test(raw)) {
    return resolveTool(raw.trim().replace(/\s+/g, '_'))
  }

  const lower = raw.toLowerCase()

  if (BRAND_BUILTINS[lower]) {
    return SERVICE_BY_KEY.get(BRAND_BUILTINS[lower]) ?? null
  }

  if (FAMILY_OF[lower] || /^(browser|web)_/.test(lower)) {
    return null
  }

  // A plugin tool named after its service ("slack_send", "notion_search").
  // Not for brands that are also common words ("linear_search" is no Linear).
  const first = tokensOf(lower)[0]

  return first && first.length >= 4 && /[_-]/.test(lower) && !COMMON_WORDS.has(first) ? (SERVICE_BY_KEY.get(first) ?? null) : null
}

// The tool's own name inside a server or connector prefix
// ("mcp__hermes__terminal" -> "terminal", "connectors__notion__search" ->
// "search"), or the name itself.
function innerName(name) {
  const raw = String(name ?? '').trim()
  const match = /^(?:mcp|connectors)__.+?__(.+)$/i.exec(raw) ?? /^[^_\s].*?__(.+)$/.exec(raw)

  return (match ? match[1] : raw).toLowerCase()
}

// A tool with no service of its own still says what kind of thing it does.
// Words in its name, first match wins; anything else is a plain tool.
const KIND_WORDS = [
  ['search', /(^|_)(search|query|find|lookup|grep|recall)(_|$)/],
  ['files', /(^|_)(file|files|read|write|patch|edit|dir|directory|folder|upload|download|ls)(_|$)/],
  ['terminal', /(^|_)(terminal|shell|bash|command|commands|process|exec)(_|$)/],
  ['web', /(^|_)(fetch|scrape|crawl|url|http|web|browse|page|extract|research)(_|$)/],
  ['memory', /(^|_)(memory|memories|remember|note|notes)(_|$)/]
]

// A built-in tool's family, or the kind of an unknown tool; never null for a
// name, so every row gets a glyph and none is left with an empty box.
function familyOf(name) {
  const lower = String(name ?? '')
    .trim()
    .toLowerCase()

  if (!lower) {
    return null
  }

  const inner = innerName(lower)

  for (const candidate of [lower, inner]) {
    if (FAMILY_OF[candidate]) {
      return FAMILY_OF[candidate]
    }

    if (candidate.startsWith('browser_')) {
      return 'browser'
    }
  }

  return KIND_WORDS.find(([, words]) => words.test(inner))?.[0] ?? 'tools'
}

// Hosts, longest first, so mail.google.com wins over google.com.
const SERVICE_HOSTS = SERVICE_LIST.flatMap(entry => (entry.hosts ?? []).map(host => [host, entry])).sort(
  (a, b) => b[0].length - a[0].length
)

function resolveUrl(url) {
  let host

  try {
    host = new URL(String(url ?? '')).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }

  return SERVICE_HOSTS.find(([known]) => host === known || host.endsWith(`.${known}`))?.[1] ?? null
}

SHARED.services = {
  // { id, label, colour, ink } | null. `colour` is the brand colour; `ink` the
  // colour a one-colour mark is drawn in on the dark surface.
  forTool: name => answer(resolveTool(name)),
  forUrl: url => answer(resolveUrl(url)),
  // A built-in tool's family (terminal, files, code, browser, web, search,
  // memory, skills, delegation, todo, cron, vision, speech, tools).
  // Never null for a name: an unknown tool gets the glyph of its kind
  // (search, files, terminal, web, memory) or the plain tool glyph.
  family: familyOf,
  ids: () => SERVICE_LIST.map(entry => entry.id)
}

// ── Marking Hermes' tool rows ──
// The mark goes on the row's head (the span holding Hermes' icon and the
// title), the element that draws the logo, so the stylesheet matches that one
// element and nothing wider:
//   head  data-mg-svc-head, data-mg-service="<id>" | data-mg-tool-family="<f>",
//         data-mg-svc-in
//   row   data-mg-svc-row="<id>"  (a service row: lifts the shell's grayscale)
const TOOL_ROW = '[data-slot="tool-block"][data-tool-row]'
const ROW_TITLE = ':scope > div > div > button > span:first-child > span:first-child'
// The arrival (--mg-dur-2, 200 ms) and a little more.
const ARRIVAL_MS = 320

// The row's own props: ToolEntry gets `part`, ToolFallback the fields
// themselves. A few levels up from the row's element.
function nameFromProps(row) {
  const key = Object.keys(row).find(name => name.startsWith('__reactFiber$'))

  for (let fiber = key ? row[key] : null, depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
    const props = fiber.memoizedProps
    const part = props && typeof props === 'object' ? (props.part ?? props) : null

    if (part && typeof part.toolName === 'string') {
      if (part.innerToolName) {
        return part.innerToolName
      }

      // A bridged call drawn without gateway labels (a transcript read back
      // after a reload keeps the model's own `tool_call`): its inner call.
      if (part.toolName === 'tool_call' && part.args && typeof part.args === 'object') {
        const calls = Array.isArray(part.args.calls) ? part.args.calls : [part.args]
        const inner = calls.find(call => call && typeof call.name === 'string' && call.name)?.name

        if (inner) {
          return inner
        }
      }

      return part.toolName
    }
  }

  return ''
}

// Did the call fail? From the row's own props, the way Hermes reads a
// result for its "Error details": an error flag, an error field or status
// in the result, a non-zero exit code, or a plain-text result that says so.
// Hermes keeps some failures quiet while the row is shut (a missing file on
// a read is a "notice"); the mark makes any of them visible as a glyph.
const FAILED_STATUS = /^(error|failed|failure|fatal|exception)$/i
const FAILED_TEXT = /^\s*(error\b|file not found|permission denied|command failed)/i

function failedFromProps(row) {
  const key = Object.keys(row).find(name => name.startsWith('__reactFiber$'))

  for (let fiber = key ? row[key] : null, depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
    const props = fiber.memoizedProps
    const part = props && typeof props === 'object' ? (props.part ?? props) : null

    if (!part || typeof part.toolName !== 'string') {
      continue
    }

    if (part.result === undefined) {
      return part.isError === true
    }

    let result = part.result

    if (typeof result === 'string') {
      try {
        result = JSON.parse(result)
      } catch {
        return part.isError === true || FAILED_TEXT.test(result)
      }
    }

    if (!result || typeof result !== 'object') {
      return part.isError === true
    }

    if (result.success === true || result.ok === true) {
      return false
    }

    return (
      part.isError === true ||
      Boolean(result.error) ||
      (typeof result.status === 'string' && FAILED_STATUS.test(result.status.trim())) ||
      (typeof result.exit_code === 'number' && result.exit_code !== 0) ||
      (typeof result.output === 'string' && FAILED_TEXT.test(result.output) && !result.output.trim().includes('\n'))
    )
  }

  return false
}

function nameOf(row) {
  const fromProps = nameFromProps(row)

  if (fromProps) {
    return fromProps
  }

  const title = row.querySelector(ROW_TITLE)
  const label = title ? [...title.children].find(child => !child.matches('.place-items-center')) : null

  return (label?.textContent ?? '').trim()
}

// What a name is drawn as: { service } or { family }, never empty.
function markOf(name) {
  const service = resolveTool(name)

  return service ? { family: null, service: service.id } : { family: familyOf(name) ?? 'tools', service: null }
}

MODULES.push({
  id: 'services',
  start() {
    const marks = new WeakMap() // row -> { service, family }
    const threads = new Map()
    const pending = new Set()
    const arriving = new Map()
    let frame = 0
    let settle = 0

    // Is the row part of a turn that is running now? Hermes shows the turn's
    // running markers only while the model streams, not while tools run, so
    // three signs, any of which will do: the row's own running glyph, a
    // running marker in its turn, or a chat at work and the row in the last
    // turn of its thread.
    const busy = () => {
      const state = sdk.host?.state

      try {
        return Boolean(state?.busy?.get?.()) || Object.values(state?.busyBySession?.get?.() ?? {}).some(Boolean)
      } catch {
        return false
      }
    }

    const live = row => {
      if (row.querySelector('[role="status"]')) {
        return true
      }

      const pair = row.closest('[data-slot="aui_turn-pair"]')

      if (!pair) {
        return false
      }

      if (pair.querySelector(RUNNING)) {
        return true
      }

      // turnDecor marks the pair whose turn runs (data-mg-live="run"), from
      // the thread's own session: a busy session elsewhere does not make a
      // row opened from history arrive.
      if (pair.dataset.mgLive) {
        return pair.dataset.mgLive === 'run'
      }

      const thread = pair.closest(THREAD)
      const pairs = thread?.querySelectorAll('[data-slot="aui_turn-pair"]')

      return busy() && Boolean(pairs?.length) && pairs[pairs.length - 1] === pair
    }

    // Puts the row's mark on its head. Idempotent: called again when React
    // replaced the head, it marks the new one without an arrival.
    const mark = row => {
      let known = marks.get(row)
      let fresh = false

      if (!known) {
        const name = nameOf(row)

        if (!name) {
          return
        }

        known = markOf(name)
        marks.set(row, known)
        fresh = true
      }

      const head = row.querySelector(ROW_TITLE)

      if (!head) {
        return
      }

      if (!('mgSvcHead' in head.dataset)) {
        head.dataset.mgSvcHead = ''
      }

      if (known.service) {
        if (head.dataset.mgService !== known.service) {
          head.dataset.mgService = known.service
        }

        if (row.dataset.mgSvcRow !== known.service) {
          row.dataset.mgSvcRow = known.service
        }
      } else if (head.dataset.mgToolFamily !== known.family) {
        head.dataset.mgToolFamily = known.family
      }

      // A failed call says so while shut: a glyph after its title
      // (34-services.css), never a colour. Read once the call has settled.
      if (!row.querySelector('[role="status"]')) {
        const failed = failedFromProps(row) || Boolean(head.querySelector('.text-destructive'))

        if (failed !== ('mgFailed' in head.dataset)) {
          head.toggleAttribute('data-mg-failed', failed)
        }
      }

      // A row of a running turn arrives with its logo; one drawn from
      // history, or opened from a fold, is simply there.
      if (fresh && live(row)) {
        head.dataset.mgSvcIn = ''
        arriving.set(head, performance.now())
      }
    }

    const flush = () => {
      frame = 0

      for (const node of pending) {
        if (!node.isConnected) {
          continue
        }

        const row = node.closest(TOOL_ROW)

        if (row) {
          mark(row)
        }

        node.querySelectorAll(TOOL_ROW).forEach(mark)
      }

      pending.clear()

      if (arriving.size && !settle) {
        settle = window.setTimeout(release, ARRIVAL_MS)
      }
    }

    // Each head keeps its arrival mark long enough for the arrival to
    // finish; then the mark goes, so nothing can start it again.
    const release = () => {
      const now = performance.now()
      let next = Infinity

      settle = 0

      for (const [head, at] of arriving) {
        const left = at + ARRIVAL_MS - now

        if (left <= 0 || !head.isConnected) {
          delete head.dataset.mgSvcIn
          arriving.delete(head)
        } else {
          next = Math.min(next, left)
        }
      }

      if (arriving.size) {
        settle = window.setTimeout(release, next + 16)
      }
    }

    // An arrival plays once: when it ends or is cut short (the row hidden by
    // a fold for a moment), its mark goes at once, so a restyle cannot start
    // it again on the same head.
    const arrived = event => {
      const head = event.target

      if (event.animationName === 'mg-svc-in' && head instanceof HTMLElement && 'mgSvcIn' in head.dataset) {
        delete head.dataset.mgSvcIn
        arriving.delete(head)
      }
    }

    document.addEventListener('animationend', arrived, true)
    document.addEventListener('animationcancel', arrived, true)

    const queue = node => {
      pending.add(node)
      frame ||= window.requestAnimationFrame(flush)
    }

    const onMutations = records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) {
            queue(node)
          }
        }
      }
    }

    // Each thread on screen is observed on its own (child changes only), and
    // nothing else. Threads come and go with sessions and tiles; the core's
    // thread finder (onThreads, plugin.js) says when, so nothing polls.
    const stopThreads = onThreads({
      found: thread => {
        if (threads.has(thread)) {
          return
        }

        const observer = new MutationObserver(onMutations)

        observer.observe(thread, { childList: true, subtree: true })
        threads.set(thread, observer)
        queue(thread)
      },
      lost: thread => {
        threads.get(thread)?.disconnect()
        threads.delete(thread)
      }
    })

    return () => {
      stopThreads()
      document.removeEventListener('animationend', arrived, true)
      document.removeEventListener('animationcancel', arrived, true)
      window.clearTimeout(settle)
      window.cancelAnimationFrame(frame)
      threads.forEach(observer => observer.disconnect())
      threads.clear()
      pending.clear()
      arriving.clear()

      // Every mark of ours, in every thread the page holds (hidden tabs too).
      for (const node of document.querySelectorAll('[data-mg-svc-row], [data-mg-svc-head], [data-mg-svc-in]')) {
        delete node.dataset.mgSvcHead
        delete node.dataset.mgService
        delete node.dataset.mgToolFamily
        delete node.dataset.mgSvcIn
        delete node.dataset.mgSvcRow
        delete node.dataset.mgFailed
      }
    }
  }
})
