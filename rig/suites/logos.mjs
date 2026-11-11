// Service logos on tool rows (src/modules/00-services.js, src/css/34-services.css).
//
// The model is a small front for Hermes' mock: a prompt carrying MG_LOGOS_<X>
// gets scripted tool calls, one per completion, then an answer; anything else
// goes to the mock as usual. Three fake MCP servers (parallel, apify,
// firecrawl) are registered in the sandbox, so their calls are real MCP tools
// and arrive with the gateway's labels, the path the owner's app takes. The
// other names are tools this sandbox does not have: Hermes answers them with an
// error, and still draws their rows.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { EVIDENCE, PLUGIN, check, finished, hotReload, results, shot, sleep, state, stubPlugin, type } from '../harness.mjs'

export const checks = [
  ['l1', 'Service rows: each shows its service logo, in colour, in place of the tool icon'],
  ['l2', 'Built-in rows: a gray glyph per family; an unknown tool gets the glyph of its kind'],
  ['l3', 'Arrival: the logo arrives once with a live row, never again; still with motion off and reduced motion'],
  ['l4', 'Contact sheet: every logo at row size and 2x, legible on the dark surface'],
  ['l5', 'After a reload: rows from history are marked, without the arrival'],
  ['l6', 'Tools hidden: the option still hides the marked rows'],
  ['l7', 'Mapping: real tool names of every family the owner uses resolve to the right logo or glyph'],
  ['l8', 'Hot reload twice: one mark per row, no doubled logos; unloaded, nothing of ours is left'],
  ['l9', 'Installed: every connector, MCP server and built-in of this machine resolves to its own logo (or a glyph of its kind), drawn readable at 14 px on #141415; the table is in the evidence']
]

// What each scripted turn calls, in order. `want` is what the row must show,
// `find` a word of the row's title that identifies it without the plugin.
// Hermes ends a turn after three completions in a row that call only tools it
// does not have, so each unknown name goes out beside a real call.
const TURNS = {
  A: [
    {
      name: 'tool_call',
      args: { name: 'mcp__parallel__web_search', arguments: { query: 'monograph logos' } },
      want: { service: 'parallel', colourful: false },
      find: 'parallel'
    },
    { name: 'mcp__apify__call_actor', args: { actor: 'rig/actor' }, want: { service: 'apify', colourful: true }, find: 'apify' },
    {
      name: 'tool_call',
      args: { name: 'mcp__firecrawl__firecrawl_scrape', arguments: { url: 'https://example.com' } },
      want: { service: 'firecrawl', colourful: true },
      find: 'firecrawl'
    },
    { name: 'connectors__notion__search', args: { query: 'rig' }, want: { service: 'notion', colourful: false }, find: 'notion', with: { name: 'terminal', args: { command: 'echo paired' } } },
    { name: 'mcp_typefully_create_draft', args: { text: 'rig' }, want: { service: 'typefully', colourful: true }, find: 'typefully', with: { name: 'terminal', args: { command: 'echo paired' } } },
    { name: 'cloudflare__workers_list', args: {}, want: { service: 'cloudflare', colourful: true }, find: 'cloudflare', with: { name: 'terminal', args: { command: 'echo paired' } } },
    { name: 'mcp__github__list_issues', args: { repo: 'rig/rig' }, want: { service: 'github', colourful: false }, find: 'github', with: { name: 'terminal', args: { command: 'echo paired' } } },
    { name: 'terminal', args: { command: 'sleep 2' }, want: { family: 'terminal' }, find: 'sleep' }
  ],
  B: [
    { name: 'read_file', args: { path: 'mg-logos-rig.txt' }, want: { family: 'files' }, find: 'mglogosrigtxt' },
    { name: 'execute_code', args: { code: 'print(42)' }, want: { family: 'code' }, find: 'print' },
    { name: 'web_search', args: { query: 'mg logos web' }, want: { family: 'search' }, find: 'mglogosweb' },
    { name: 'memory', args: { action: 'read', target: 'memory' }, want: { family: 'memory' }, find: 'memory' },
    { name: 'skills_list', args: {}, want: { family: 'skills' }, find: 'skill' },
    { name: 'session_search', args: { query: 'mg logos recall' }, want: { family: 'memory' }, find: 'sessionsearch', historyOnly: true },
    { name: 'vision_analyze', args: { image_url: 'mg-logos.png', question: 'what' }, want: { family: 'vision' }, find: 'analyzedimage' },
    { name: 'browser_navigate', args: { url: 'https://example.com/mg-logos' }, want: { family: 'browser' }, find: 'examplecommglogos', historyOnly: true, with: { name: 'terminal', args: { command: 'echo paired' } } },
    { name: 'mg_rig_unknown_tool', args: {}, want: { family: 'tools' }, find: 'mgrigunknowntool', historyOnly: true, with: { name: 'terminal', args: { command: 'echo paired' } } },
    { name: 'terminal', args: { command: 'sleep 2' }, want: { family: 'terminal' }, find: 'sleep' }
  ],
  // Motion off, then reduced motion: one service call each, kept live a moment.
  C: [
    { name: 'tool_call', args: { name: 'mcp__apify__call_actor', arguments: { actor: 'rig/motion-off' } }, want: { service: 'apify', colourful: true }, find: 'apify' },
    { name: 'terminal', args: { command: 'sleep 1' }, want: { family: 'terminal' }, find: 'sleep' }
  ],
  D: [
    { name: 'tool_call', args: { name: 'mcp__parallel__web_search', arguments: { query: 'reduced motion' } }, want: { service: 'parallel', colourful: false }, find: 'parallel' },
    { name: 'terminal', args: { command: 'sleep 1' }, want: { family: 'terminal' }, find: 'sleep' }
  ]
}

// ── Names for l7: what Hermes really sends, and what each must draw ──
// Patterns: mcp__<server>__<tool>, connectors__<app>__<tool>, mcp_<server>_<tool>,
// <server>__<tool>, gateway labels ("Parallel · web search"), Hermes' own MCP
// server (mcp__hermes__<built-in>), plain built-ins, unknown tools by kind.
const PATTERNS = [
  'mcp__<server>__<tool>',
  'connectors__<app>[_mcp]__<tool>',
  'mcp_<server>_<tool>',
  '<server>__<tool>',
  '"<Service> · <words>" (row title from gateway labels)',
  '"Mcp <Server> <Words>" (row title Hermes builds from a raw name)',
  'mcp__google_workspace__<product>_<tool> (gmail, calendar, drive, docs, sheets)',
  'mcp__hermes__<built-in> and plain <built-in>',
  'anything else: a glyph by kind (search, files, terminal, web, memory) or the tool glyph'
]
const MAPPING = [
  ['mcp__parallel__web_search', 'logo:parallel'], ['mcp__parallel__web_fetch', 'logo:parallel'], ['mcp__parallel__web_research', 'logo:parallel'],
  ['mcp__parallel__find_verticals', 'logo:parallel'], ['mcp__parallel__search_vertical', 'logo:parallel'], ['Parallel · web search', 'logo:parallel'], ['Mcp Parallel Web Search', 'logo:parallel'],
  ['mcp__firecrawl__firecrawl_scrape', 'logo:firecrawl'], ['mcp__firecrawl__firecrawl_search', 'logo:firecrawl'],
  ['mcp__apify__call_actor', 'logo:apify'], ['mcp__apify__apify__web_fetch', 'logo:apify'], ['mcp__apify__search_actors', 'logo:apify'],
  ['mcp__typefully__create_draft', 'logo:typefully'], ['mcp_typefully_create_draft', 'logo:typefully'],
  ['mcp__cloudflare__workers_list', 'logo:cloudflare'], ['cloudflare__workers_list', 'logo:cloudflare'], ['connectors__cloudflare_mcp__search', 'logo:cloudflare'],
  ['mcp__github__list_issues', 'logo:github'], ['connectors__github__create_issue', 'logo:github'],
  ['connectors__notion__search', 'logo:notion'], ['connectors__slack__send_message', 'logo:slack'], ['connectors__linear__create_issue', 'logo:linear'],
  ['connectors__gmail__send_email', 'logo:gmail'], ['mcp__google_workspace__gmail_send', 'logo:gmail'], ['mcp__google_workspace__calendar_list_events', 'logo:googlecalendar'],
  ['mcp__google_workspace__drive_search', 'logo:googledrive'], ['mcp__google_workspace__docs_get', 'logo:googledocs'], ['mcp__google_workspace__sheets_read', 'logo:googlesheets'],
  ['mcp__obsidian__search_notes', 'logo:obsidian'],
  ['browser_navigate', 'glyph:browser'], ['browser_exec', 'glyph:browser'], ['mcp__hermes__browser_exec', 'glyph:browser'], ['computer_use', 'glyph:browser'],
  ['terminal', 'glyph:terminal'], ['mcp__hermes__terminal', 'glyph:terminal'], ['process_manage', 'glyph:terminal'],
  ['read_file', 'glyph:files'], ['write_file', 'glyph:files'], ['patch', 'glyph:files'], ['search_files', 'glyph:files'], ['mcp__hermes__read_file', 'glyph:files'], ['mcp__hermes__patch', 'glyph:files'],
  ['web_search', 'glyph:search'], ['mcp__hermes__web_search', 'glyph:search'], ['web_extract', 'glyph:web'], ['mcp__hermes__web_extract', 'glyph:web'],
  ['memory', 'glyph:memory'], ['session_search', 'glyph:memory'],
  ['skill_view', 'glyph:skills'], ['skill_manage', 'glyph:skills'], ['skills_list', 'glyph:skills'], ['mcp__hermes__skill_view', 'glyph:skills'],
  ['delegate_task', 'glyph:delegation'], ['cronjob', 'glyph:cron'], ['vision_analyze', 'glyph:vision'], ['mcp__hermes__vision_analyze', 'glyph:vision'],
  ['text_to_speech', 'glyph:speech'], ['mcp__hermes__text_to_speech', 'glyph:speech'], ['execute_code', 'glyph:code'], ['todo', 'glyph:todo'],
  ['tool_call', 'glyph:tools'], ['tool_search', 'glyph:tools'], ['mcp__hermes__tool_describe', 'glyph:tools'],
  ['mg_rig_unknown_tool', 'glyph:tools'], ['mcp__acme__fetch_url', 'glyph:web'], ['mcp__acme__read_document', 'glyph:files'], ['mcp__acme__run_command', 'glyph:terminal'],
  ['mcp__acme__remember_fact', 'glyph:memory'], ['connectors__peopledatalabs__search_people', 'glyph:search'], ['linear_search', 'glyph:search'], ['box_files', 'glyph:files']
]
// Hosted connector ids, as the connector catalogue names them.
const CONNECTORS = (
  'notion slack supabase linear airtable jira asana peopledatalabs shopify discordbot calendly apollo semrush confluence sendgrid box ashby ' +
  'adobe_marketing_agent_mcp ahrefs_mcp amplitude_mcp better_stack_mcp canva_mcp cashfree_payments_mcp circleback_mcp clickhouse_mcp clickup_mcp ' +
  'cloudflare_mcp coinbase_agents_mcp coinbase_wallet_mcp customerio_mcp datadog_mcp granola_mcp greptile_mcp higgsfield_mcp intercom_mcp memelord_mcp ' +
  'metabase mintlify_mcp neon_mcp pandadoc_mcp plaid_mcp plain posthog_mcp pylon_mcp railway ramp_mcp resend_mcp sentry_mcp statsig_mcp stripe_mcp ' +
  'todoist_mcp turso vercel_mcp wispr_flow_mcp'
).split(' ')

// What is installed on the owner's machine, and what each must draw. The
// connector ids are the catalogue's (connectors.txt); a real tool name of each
// (`connectors__<id>__<ID>_SEARCH`, as hosted connectors name their tools) is
// fed in. null: no brand mark exists, a glyph of its kind is right.
const INSTALLED = [
  ...CONNECTORS.map(id => [
    `connectors__${id}__${id.replace(/_mcp$/, '').toUpperCase()}_SEARCH`,
    {
      adobe_marketing_agent_mcp: 'adobe', better_stack_mcp: 'betterstack', cashfree_payments_mcp: 'cashfree', coinbase_agents_mcp: 'coinbase',
      coinbase_wallet_mcp: 'coinbase', discordbot: 'discord', memelord_mcp: null, peopledatalabs: null, wispr_flow_mcp: 'wisprflow'
    }[id] ?? (id in { memelord_mcp: 1, peopledatalabs: 1 } ? null : id.replace(/_mcp$/, '').replace(/_/g, ''))
  ]),
  ['mcp__parallel__web_search', 'parallel'], ['mcp__parallel__web_research', 'parallel'], ['mcp__apify__call_actor', 'apify'],
  ['mcp__cloudflare__search_docs', 'cloudflare'], ['mcp__typefully__create_draft', 'typefully'], ['mcp__firecrawl__firecrawl_scrape', 'firecrawl'],
  ['browser_navigate', 'glyph:browser'], ['terminal', 'glyph:terminal'], ['read_file', 'glyph:files'], ['memory', 'glyph:memory'], ['skill_view', 'glyph:skills'],
  ['delegate_task', 'glyph:delegation'], ['cronjob', 'glyph:cron'], ['vision_analyze', 'glyph:vision'], ['text_to_speech', 'glyph:speech'],
  ['web_search', 'glyph:search'], ['web_extract', 'glyph:web']
]

const prompt = turn => `Logos rig, turn ${turn}. MG_LOGOS_${turn}`
const answerOf = turn => `Logos turn ${turn} finished, MG_LOGOS_${turn}_DONE.`

// ── The model ──────────────────────────────────────────────────────────────
const textOf = content =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join(' ') : ''

const sse = (model, delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'mg-logos', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

function scripted(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUser = messages.map(m => m?.role).lastIndexOf('user')
  const turn = /MG_LOGOS_([A-Z])\b/.exec(textOf(messages[lastUser]?.content))?.[1]

  if (!turn || !TURNS[turn] || !Array.isArray(body.tools) || !body.tools.length) {
    return null
  }

  // Which step is next: count the tool results since the prompt.
  let left = messages.slice(lastUser + 1).filter(m => m?.role === 'tool').length

  for (const [index, step] of TURNS[turn].entries()) {
    if (left === 0) {
      return { calls: step.with ? [step, step.with] : [step], index, turn }
    }

    left -= step.with ? 2 : 1
  }

  return { results: messages.slice(lastUser + 1).filter(m => m?.role === 'tool').map(m => textOf(m.content).replace(/\s+/g, ' ').slice(0, 70)), text: answerOf(turn), turn }
}

export async function model({ startMockServer }) {
  const mock = await startMockServer({})
  const calls = []
  const toolResults = []

  const server = http.createServer((req, res) => {
    const chunks = []

    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body = null

      try {
        body = req.method === 'POST' && req.url?.startsWith('/v1/chat/completions') ? JSON.parse(raw.toString('utf8')) : null
      } catch {
        body = null
      }

      const plan = body ? scripted(body) : null

      if (!plan) {
        const upstream = http.request(
          { headers: req.headers, host: '127.0.0.1', method: req.method, path: req.url, port: mock.port },
          answer => {
            res.writeHead(answer.statusCode ?? 502, answer.headers)
            answer.pipe(res)
          }
        )

        upstream.on('error', () => {
          res.writeHead(502)
          res.end()
        })
        upstream.end(raw)

        return
      }

      const name = body.model ?? 'mock-model'
      const toolCalls = plan.calls
        ? plan.calls.map((call, at) => ({ index: at, id: `mg_logos_${plan.turn}_${plan.index}_${at}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
        : null

      calls.push(plan.calls ? `${plan.turn}:${plan.calls.map(call => call.name).join('+')}` : `${plan.turn}:answer`)

      if (plan.results) {
        toolResults.push(`${plan.turn}: ${plan.results.join(' | ')}`)
      }

      if (body.stream) {
        res.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' })
        res.write(toolCalls ? sse(name, { role: 'assistant', tool_calls: toolCalls }, 'tool_calls') : sse(name, { role: 'assistant', content: plan.text }))

        if (!toolCalls) {
          res.write(sse(name, {}, 'stop'))
        }

        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls.map(({ index, ...rest }) => rest) } : { role: 'assistant', content: plan.text }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'mg-logos', object: 'chat.completion', created: 0, model: name, choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }))
      }
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const port = server.address().port

  return {
    calls,
    toolResults,
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      await mock.close()
    },
    port,
    get receivedPrompts() {
      return mock.receivedPrompts
    },
    url: `http://127.0.0.1:${port}`
  }
}

// ── Fake MCP servers: stdio JSON-RPC, one tool each, a short wait per call ──
const FAKE_MCP = `
const server = process.argv[2]
const tools = { parallel: 'web_search', apify: 'call_actor', firecrawl: 'firecrawl_scrape' }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: server, version: '0.0.1' } })
    else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: tools[server], description: 'Rig tool of the fake ' + server + ' server.', inputSchema: { type: 'object', properties: {}, additionalProperties: true } }] })
    else if (msg.method === 'tools/call') setTimeout(() => reply(msg.id, { content: [{ type: 'text', text: server + ' answered.' }] }), 600)
    else if (msg.method === 'ping') reply(msg.id, {})
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } }) + '\\n')
  }
})
`

export async function seed({ sandbox }) {
  const script = path.join(sandbox.hermesHome, 'mg-fake-mcp.cjs')

  fs.writeFileSync(script, FAKE_MCP)
  fs.writeFileSync(path.join(sandbox.root, 'mg-logos-rig.txt'), 'A file for the rig.\n')

  const servers = ['parallel', 'apify', 'firecrawl']
    .map(name => `  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(script)}, ${JSON.stringify(name)}]\n`)
    .join('')

  fs.appendFileSync(path.join(sandbox.hermesHome, 'config.yaml'), `\nmcp_servers:\n${servers}`)
}

// ── Page helpers ───────────────────────────────────────────────────────────
// A recorder in the page: every time a row gets data-mg-svc-in or a service
// mark, what its logo's animation was right then; every mg-svc-in animation
// that starts, per row.
const installRecorder = () =>
  state.page.evaluate(() => {
    if (window.__mgLogos) {
      return
    }

    const rec = { arrivals: [], rows: new Map(), starts: new Map(), startsList: [] }
    const head = row => row.querySelector(':scope > div > div > button > span:first-child > span:first-child')
    let next = 0
    const idOf = row => {
      row.__mgRigId ??= ++next
      rec.rows.set(row.__mgRigId, row)

      return row.__mgRigId
    }

    new MutationObserver(records => {
      for (const record of records) {
        // The marks sit on the row's head (00-services.js).
        const row = record.target.closest?.('[data-tool-row]')

        if (!row || record.target !== head(row)) {
          continue
        }

        const mark = record.target

        if (record.attributeName === 'data-mg-svc-in' && mark.hasAttribute('data-mg-svc-in')) {
          const style = getComputedStyle(mark, '::before')

          rec.arrivals.push({
            row: idOf(row),
            service: mark.dataset.mgService ?? null,
            family: mark.dataset.mgToolFamily ?? null,
            animation: style.animationName,
            duration: style.animationDuration,
            motion: document.documentElement.dataset.mgMotion,
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            at: Math.round(performance.now())
          })
        }

        if (record.attributeName === 'data-mg-svc-in' && !mark.hasAttribute('data-mg-svc-in')) {
          const entry = rec.arrivals.findLast(item => item.row === idOf(row))

          if (entry) {
            entry.clearedAfter = Math.round(performance.now()) - entry.at
            entry.animationAfter = getComputedStyle(mark, '::before').animationName
          }
        }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-mg-svc-in', 'data-mg-service', 'data-mg-tool-family'], subtree: true })

    document.addEventListener(
      'animationstart',
      event => {
        if (event.animationName === 'mg-svc-in') {
          const row = event.target.closest?.('[data-tool-row]')
          const id = row ? idOf(row) : 0

          rec.starts.set(id, (rec.starts.get(id) ?? 0) + 1)
          rec.startsList.push({ row: id, service: event.target.dataset?.mgService ?? null, pseudo: event.pseudoElement })
        }
      },
      true
    )

    window.__mgLogos = rec
  })

const recorder = () =>
  state.page.evaluate(() => {
    const rec = window.__mgLogos

    // A row unmounted mid-arrival never reports its mark going; only rows
    // still on the page count.
    const arrivals = rec
      ? rec.arrivals.map(item => ({ ...item, connected: rec.rows.get(item.row)?.isConnected ?? false, stillMarked: rec.rows.get(item.row)?.hasAttribute('data-mg-svc-in') ?? false }))
      : []

    return rec ? { arrivals, starts: [...rec.starts.entries()], startsList: rec.startsList } : null
  })

// Everything about each tool row on screen, read the way a person sees it: the
// title text, and what the head's ::before computes to.
const readRows = () =>
  state.page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    const rgb = value => {
      const probe = document.createElement('i')

      probe.style.color = value
      document.body.append(probe)

      const out = getComputedStyle(probe).color

      probe.remove()

      return out
    }

    return [...document.querySelectorAll('[data-slot="tool-block"][data-tool-row]')].map(row => {
      const head = row.querySelector(':scope > div > div > button > span:first-child > span:first-child')
      const before = head ? getComputedStyle(head, '::before') : null
      const icon = head?.querySelector(':scope > .place-items-center')
      const rect = head?.getBoundingClientRect()

      const filters = []

      for (let node = head; node && node !== document.documentElement; node = node.parentElement) {
        const value = getComputedStyle(node).filter

        if (value && value !== 'none') {
          filters.push(`${node.tagName.toLowerCase()}${node.dataset.slot ? `[${node.dataset.slot}]` : ''}: ${value}`)
        }
      }

      const label = head ? [...head.children].find(child => !child.matches('.place-items-center')) : null
      const dims = []

      for (let node = label; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node)

        if (Number(style.opacity) < 1) {
          dims.push(`${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 3).join('.')}: opacity ${style.opacity}`)
        }
      }

      // What the label's colour comes to on the canvas, as RGB.
      const onCanvas = colour => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d', { willReadFrequently: true })

        canvas.width = canvas.height = 1
        ctx.fillStyle = css.getPropertyValue('--mg-canvas') || '#000'
        ctx.fillRect(0, 0, 1, 1)
        ctx.fillStyle = colour
        ctx.fillRect(0, 0, 1, 1)

        return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
      }

      return {
        titleColor: label ? getComputedStyle(label).color : null,
        titleRgb: label ? onCanvas(getComputedStyle(label).color) : null,
        dims,
        filters,
        box: rect ? { x: rect.left, y: rect.top + (rect.height - 14) / 2, width: 14, height: 14 } : null,
        title: (head?.textContent ?? row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
        service: head?.dataset.mgService ?? null,
        family: head?.dataset.mgToolFamily ?? null,
        visible: row.checkVisibility(),
        before: before
          ? {
              content: before.content,
              width: before.width,
              height: before.height,
              display: before.display,
              mask: before.maskImage || before.webkitMaskImage,
              image: before.backgroundImage,
              color: before.backgroundColor,
              glyphColor: before.color,
              font: before.fontFamily,
              animation: before.animationName
            }
          : null,
        hermesIcon: icon ? { shown: icon.checkVisibility(), status: Boolean(icon.querySelector('[role="status"], [aria-label]')) } : null,
        top: rect ? Math.round(rect.top) : null,
        text2: rgb(css.getPropertyValue('--mg-text-2'))
      }
    })
  })

const squash = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// The pixels a person sees: a PNG screenshot decoded here (8-bit RGB or RGBA,
// not interlaced, which is what Chromium writes), so colour is judged on
// screen and not from a computed style a filter may undo.
function decodePng(buffer) {
  let at = 8
  let width = 0
  let height = 0
  let channels = 4
  const data = []

  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const kind = buffer.toString('ascii', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)

    if (kind === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0

      if (body[8] !== 8 || !channels || body[12] !== 0) {
        throw new Error('unexpected PNG format')
      }
    } else if (kind === 'IDAT') {
      data.push(body)
    }

    at += 12 + length
  }

  const raw = zlib.inflateSync(Buffer.concat(data))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 3)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0

      line[x] = (line[x] + add) & 255
    }

    for (let x = 0; x < width; x++) {
      line.copy(out, (y * width + x) * 3, x * channels, x * channels + 3)
    }

    previous = line
  }

  return { height, pixels: out, width }
}

// The most colourful and the brightest pixel inside a box of the screen.
async function pixelsIn(boxes) {
  const shotPng = await state.page.screenshot()
  const image = decodePng(shotPng)
  const scale = image.width / (await state.page.evaluate(() => window.innerWidth))

  return boxes.map(box => {
    let chroma = 0
    let light = 0

    for (let y = Math.round(box.y * scale); y < Math.round((box.y + box.height) * scale); y++) {
      for (let x = Math.round(box.x * scale); x < Math.round((box.x + box.width) * scale); x++) {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
          continue
        }

        const at = (y * image.width + x) * 3
        const [r, g, b] = [image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]]

        chroma = Math.max(chroma, Math.max(r, g, b) - Math.min(r, g, b))
        light = Math.max(light, Math.max(r, g, b))
      }
    }

    return { chroma, light }
  })
}

// Open the folded work of every finished reply, then every collapsed group of
// calls, with real clicks, so the rows are on screen.
async function openWork(entry) {
  const { page } = state
  const opened = []

  for (let round = 0; round < 12; round++) {
    const target = await page.evaluate(() => {
      const visible = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
      const head = [...document.querySelectorAll('[data-slot="aui_assistant-message-root"][data-mg-head][data-mg-steps]:not([data-mg-open])')].find(visible)

      if (head) {
        head.scrollIntoView({ block: 'center' })

        const rect = head.getBoundingClientRect()

        return { kind: 'fold', x: rect.left + 40, y: rect.top + 12 }
      }

      const button = [...document.querySelectorAll('[data-tool-group] [data-tool-summary] button[aria-expanded="false"]')].find(visible)

      if (button) {
        button.scrollIntoView({ block: 'center' })

        const rect = button.getBoundingClientRect()

        return { kind: 'group', x: rect.left + Math.min(40, rect.width / 2), y: rect.top + rect.height / 2 }
      }

      return null
    })

    if (!target) {
      break
    }

    await page.mouse.click(target.x, target.y)
    opened.push(target.kind)
    await sleep(700)
  }

  entry.evidence.opened = opened.join(', ') || 'nothing to open'
}

// While a turn runs, what is on screen every 150 ms: rows, marked rows, rows
// arriving, and whether the turn shows as running.
const samples = {}

async function runTurn(turn, timeout = 60_000) {
  await type(prompt(turn), 'Enter')

  const seen = (samples[turn] = [])
  let done = false
  const sampler = (async () => {
    while (!done) {
      const sample = await state.page
        .evaluate(running => {
          const rows = document.querySelectorAll('[data-tool-row]')

          return `${rows.length}r/${document.querySelectorAll('[data-tool-row] [data-mg-svc-head]:is([data-mg-service],[data-mg-tool-family])').length}m/${document.querySelectorAll('[data-mg-svc-in]').length}in/${document.querySelector(running) ? 'run' : 'idle'}`
        }, '#mf-live, [data-slot="aui_turn-activity"], [data-slot="aui_response-loading"]')
        .catch(() => 'x')

      if (seen.at(-1) !== sample) {
        seen.push(sample)
      }

      await sleep(150)
    }
  })()

  try {
    await finished(`MG_LOGOS_${turn}_DONE`, timeout)
  } finally {
    done = true
    await sampler
  }

  await sleep(1200)
}

async function judgeRows(entry, must, rows, list) {
  for (const call of list) {
    const row = rows.find(item => squash(item.title).includes(call.find) && !item.claimed)

    if (!row) {
      must(false, `no row on screen for ${call.name} (looked for "${call.find}" in the titles)`)
      continue
    }

    row.claimed = true

    const b = row.before ?? {}
    const seen = { title: row.title, service: row.service, family: row.family, visible: row.visible, before: `${b.width}x${b.height} ${b.display}`, titleColor: row.titleColor, dims: row.dims.join('; ') || 'none' }

    if (call.want.service) {
      const drawn = /data:image\/svg\+xml/.test(b.mask ?? '') ? `mask in ${b.color}` : /data:image\/svg\+xml/.test(b.image ?? '') ? 'image' : 'nothing'

      Object.assign(seen, { drawn })
      must(row.service === call.want.service, `${call.name}: data-mg-service is ${row.service}, wanted ${call.want.service}`)
      must(drawn !== 'nothing', `${call.name}: the row's ::before draws no logo`)
      must(b.width === '16px' && b.height === '14px', `${call.name}: logo box is ${b.width}x${b.height}, not the common 16x14`)
      must(!/^rgba\(0, 0, 0, 0\)$/.test(b.color) || drawn === 'image', `${call.name}: a one-colour logo with no colour`)
      must(!row.filters.length, `${call.name}: a filter on the logo's way up would change its colour: ${row.filters.join('; ')}`)

      // On screen: scroll the row into view and read the logo's pixels.
      const box = await state.page.evaluate(title => {
        const row = [...document.querySelectorAll('[data-tool-row][data-mg-svc-row]')].find(node => node.textContent.replace(/\s+/g, ' ').trim().startsWith(title.slice(0, 30)))
        const head = row?.querySelector(':scope > div > div > button > span:first-child > span:first-child')

        head?.scrollIntoView({ block: 'center' })

        const rect = head?.getBoundingClientRect()

        return rect ? { x: rect.left, y: rect.top + (rect.height - 14) / 2, width: 16, height: 14 } : null
      }, row.title)

      if (box) {
        const [pixels] = await pixelsIn([box])

        seen.pixels = pixels

        if (call.want.colourful) {
          must(pixels.chroma >= 60, `${call.name}: the logo shows no colour on screen (most colourful pixel ${pixels.chroma})`)
        } else {
          must(pixels.light >= 140, `${call.name}: the logo is too dark on screen (brightest pixel ${pixels.light})`)
        }
      } else {
        must(false, `${call.name}: could not find the row again to read its pixels`)
      }
    } else if (call.want.family) {
      Object.assign(seen, { glyph: b.content, glyphColor: b.glyphColor })
      must(row.family === call.want.family, `${call.name}: data-mg-tool-family is ${row.family}, wanted ${call.want.family}`)
      must(/codicon/.test(b.font ?? ''), `${call.name}: glyph not drawn in the codicon font (${b.font})`)
      must(b.content && b.content !== 'none' && b.content !== '""', `${call.name}: glyph has no content`)
      must(b.glyphColor === row.text2, `${call.name}: glyph colour ${b.glyphColor} is not --mg-text-2 ${row.text2}`)
      must(!row.service, `${call.name}: a built-in carries a service mark`)
    } else {
      must(!row.service && !row.family, `${call.name}: an unknown tool was marked (${row.service ?? row.family})`)
      must(row.visible, `${call.name}: the unknown tool's row is not drawn`)
    }

    if (call.want.service || call.want.family) {
      must(Math.max(0, ...(row.titleRgb ?? [])) >= 110, `${call.name}: the row's label is drawn dark (${row.titleColor}, ${row.titleRgb} on the canvas)`)
      must(!row.hermesIcon || !row.hermesIcon.shown || row.hermesIcon.status, `${call.name}: Hermes' own tool icon is still shown beside the mark`)
    }

    entry.evidence[call.name + (call.want.family === 'terminal' ? `#${call.find}` : '')] = seen
  }

  if (entry.why.length) {
    entry.evidence.allTitles = rows.map(row => `${row.title} [${row.service ?? row.family ?? '-'}]`)
  }
}

export async function run() {
  const { page } = state

  await installRecorder()

  // ── l1. Service rows ──────────────────────────────────────────────────────
  await check('l1', async (entry, must) => {
    await runTurn('A')
    await openWork(entry)

    const rows = await readRows()

    entry.evidence.rowsOnScreen = rows.length
    await judgeRows(entry, must, rows, TURNS.A)
    entry.evidence.modelCalls = state.mock.calls.filter(call => call.startsWith('A:')).join(', ')

    const first = await page.evaluate(() => {
      const row = document.querySelector('[data-tool-row][data-mg-svc-row]')

      row?.scrollIntoView({ block: 'center' })

      return Boolean(row)
    })

    must(first, 'no marked row to show')
    await sleep(300)
    await shot(entry, 'l1-service-rows')
  })

  // ── l2. Built-in rows ─────────────────────────────────────────────────────
  await check('l2', async (entry, must) => {
    await runTurn('B')
    await openWork(entry)

    const rows = await readRows()

    await judgeRows(
      entry,
      must,
      rows.filter(row => !row.service),
      TURNS.B.filter(call => !call.historyOnly)
    )
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-tool-row] [data-mg-tool-family]')]

      rows.at(-1)?.scrollIntoView({ block: 'end' })
    })
    await sleep(300)
    await shot(entry, 'l2-builtin-rows')
  })

  // ── l3. Arrival ──────────────────────────────────────────────────────────
  await check('l3', async (entry, must) => {
    const live = (await recorder()).arrivals.filter(item => item.service || item.family)

    entry.evidence.arrivalsInTurnsAB = live.length
    entry.evidence.arrivalSample = live.slice(0, 3)
    must(live.length >= 4, `only ${live.length} rows arrived marked while their turn ran`)
    must(live.every(item => item.animation === 'mg-svc-in'), `an arrival with motion on did not animate: ${JSON.stringify(live.find(item => item.animation !== 'mg-svc-in'))}`)
    const kept = live.filter(item => item.connected)

    entry.evidence.arrivalsStillOnPage = kept.length
    entry.evidence.clearedAfterMs = [...new Set(live.map(item => item.clearedAfter))].join(', ')
    const cleared = live.filter(item => item.clearedAfter !== undefined)

    entry.evidence.arrivalsSeenClearing = cleared.length
    must(cleared.length >= 4, `only ${cleared.length} arrivals were seen to end`)
    must(kept.every(item => !item.stillMarked), 'data-mg-svc-in was left on a row after its arrival')
    must(cleared.every(item => item.clearedAfter >= 200), 'an arrival mark went before the arrival could finish (--mg-dur-2)')
    must(cleared.every(item => item.animationAfter === 'none'), 'the logo still animates after its arrival')

    // Fold the work again and open it, and change an unrelated root attribute:
    // nothing may start the arrival again.
    const before = (await recorder()).startsList.length

    await page.evaluate(() => {
      document.documentElement.dataset.mgDensity = 'compact'
    })
    await sleep(200)
    await page.evaluate(() => {
      document.documentElement.dataset.mgDensity = 'comfortable'
    })

    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="aui_assistant-message-root"][data-mg-head][data-mg-open]')].map(head => {
        head.scrollIntoView({ block: 'center' })

        const rect = head.getBoundingClientRect()

        return { x: rect.left + 40, y: rect.top + 12 }
      })
    )

    for (const point of heads.slice(0, 1)) {
      await page.mouse.click(point.x, point.y)
      await sleep(600)
    }

    await openWork(entry)
    await sleep(400)

    const after = await recorder()
    const counts = after.starts.filter(([id]) => id).map(([, count]) => count)

    entry.evidence.replaysAfterFoldAndAttribute = after.startsList.length - before
    entry.evidence.mostStartsOnOneRow = Math.max(0, ...counts)
    must(after.startsList.length === before, `${after.startsList.length - before} arrivals started again after a fold and an attribute change`)
    must(counts.every(count => count <= 1), 'a row started its arrival more than once')

    // Motion off: the core writes :root[data-mg-motion]; set it as the
    // Appearance setting would.
    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'off'
    })

    const offFrom = (await recorder()).arrivals.length

    await runTurn('C')

    const off = (await recorder()).arrivals.slice(offFrom)

    // Motion off means what it means everywhere (05-motion.css, motion m6,
    // appearance p4): nothing lasts over 1 ms.
    const quiet = item => item.animation === 'none' || parseFloat(item.duration) * (/ms$/.test(item.duration) ? 1 : 1000) <= 1

    entry.evidence.motionOff = off.map(item => `${item.service ?? item.family}: ${item.animation} ${item.duration}`)
    must(off.length >= 1, 'no row arrived during the motion-off turn')
    must(off.every(quiet), 'a logo animated with motion off (over 1 ms)')

    await page.evaluate(() => {
      document.documentElement.dataset.mgMotion = 'on'
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })

    const reducedFrom = (await recorder()).arrivals.length

    await runTurn('D')

    const reduced = (await recorder()).arrivals.slice(reducedFrom)

    entry.evidence.reducedMotion = reduced.map(item => `${item.service ?? item.family}: ${item.animation} ${item.duration} (reduce=${item.reduced})`)
    must(reduced.length >= 1, 'no row arrived during the reduced-motion turn')
    must(reduced.every(quiet), 'a logo animated under reduced motion (over 1 ms)')
    await page.emulateMedia({ reducedMotion: null })
  })

  // ── l4. Contact sheet ─────────────────────────────────────────────────────
  await check('l4', async (entry, must) => {
    await page.evaluate(() => {
      const host = document.createElement('div')

      host.id = 'mg-rig-sheet'
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:var(--mg-canvas);display:grid;grid-template-columns:repeat(7,1fr);gap:2px 6px;padding:10px;overflow:hidden;font:11px/1.2 var(--mg-font);color:var(--mg-text-3);align-content:start'
      document.body.append(host)
    })

    // The ids come from the plugin itself.
    const ids = await page.evaluate(() => {
      const services = [...document.querySelectorAll('[data-mg-service]')].map(node => node.dataset.mgService)

      return services
    })

    entry.evidence.idsMarkedOnRows = [...new Set(ids)].join(', ')

    const table = await page.evaluate(() => {
      const css = document.getElementById('mg-css')?.textContent ?? ''

      return [...css.matchAll(/\[data-mg-service="([a-z0-9]+)"\] \{ --mg-svc-(img|mask)/g)].map(match => [match[1], match[2]])
    })

    entry.evidence.logosInStylesheet = table.length
    must(table.length >= 70, `only ${table.length} logos in the stylesheet`)

    const measured = await page.evaluate(table => {
      const host = document.getElementById('mg-rig-sheet')
      const lum = rgb => {
        const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(v => v / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))

        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const canvas = getComputedStyle(host).backgroundColor
      const out = []

      for (const [id, mode] of table) {
        const cell = document.createElement('div')

        cell.style.cssText = 'display:flex;align-items:center;gap:6px;height:34px;white-space:nowrap;overflow:hidden'

        const small = document.createElement('span')

        small.dataset.mgService = id

        const big = document.createElement('span')

        big.dataset.mgService = id
        big.style.setProperty('--mg-svc-size', '28px')

        const label = document.createElement('span')

        label.textContent = id
        cell.append(small, big, label)
        host.append(cell)

        const b = getComputedStyle(small, '::before')
        const hasMask = /data:image\/svg\+xml/.test(b.maskImage || b.webkitMaskImage || '')
        const hasImage = /data:image\/svg\+xml/.test(b.backgroundImage)
        const [hi, lo] = [lum(b.backgroundColor), lum(canvas)].sort((x, y) => y - x)

        out.push({ id, mode, hasMask, hasImage, ink: hasMask ? b.backgroundColor : null, contrast: hasMask ? Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)) : null, size: `${b.width}/${getComputedStyle(big, '::before').width}` })
      }

      return out
    }, table)

    for (const item of measured) {
      must(item.hasMask !== item.hasImage, `${item.id}: drawn as ${item.hasMask ? 'mask' : ''}${item.hasImage ? ' image' : ''}${!item.hasMask && !item.hasImage ? 'nothing' : ''}`)
      must(item.mode === (item.hasMask ? 'mask' : 'img'), `${item.id}: stylesheet says ${item.mode}, drawn otherwise`)
      must(item.size === '16px/32px', `${item.id}: sizes ${item.size}`)

      if (item.hasMask) {
        must(item.contrast >= 3.5, `${item.id}: one-colour logo at ${item.contrast}:1 against the canvas`)
      }
    }

    entry.evidence.oneColourLogos = measured.filter(item => item.hasMask).length
    entry.evidence.multiColourLogos = measured.filter(item => item.hasImage).length
    entry.evidence.lowestContrast = measured
      .filter(item => item.hasMask)
      .sort((a, b) => a.contrast - b.contrast)
      .slice(0, 6)
      .map(item => `${item.id} ${item.contrast}:1 (${item.ink})`)
      .join(', ')
    fs.writeFileSync(path.join(EVIDENCE, 'logos-measured.json'), JSON.stringify(measured, null, 1))
    await sleep(300)
    await shot(entry, 'l4-contact-sheet')
    await page.evaluate(() => document.getElementById('mg-rig-sheet')?.remove())
    must(!(await page.evaluate(() => document.getElementById('mg-rig-sheet'))), 'the sheet was not removed')
  })

  // ── l5. After a reload ───────────────────────────────────────────────────
  await check('l5', async (entry, must) => {
    await page.reload()
    await page.waitForSelector('[data-slot="composer-root"] [contenteditable="true"]', { timeout: 60_000 })
    await page
      .waitForFunction(() => (document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? '').includes('MG_LOGOS_D_DONE'), null, { timeout: 30_000 })
      .catch(() => undefined)
    await installRecorder()
    await sleep(1500)
    await openWork(entry)
    await sleep(800)

    const rows = await readRows()
    const rec = await recorder()

    entry.evidence.rowsAfterReload = rows.length
    entry.evidence.markedAfterReload = rows.filter(row => row.service || row.family).map(row => row.service ?? row.family).join(', ')
    entry.evidence.arrivalsAfterReload = rec.arrivals.length
    entry.evidence.animationStartsAfterReload = rec.startsList.length
    // Hermes draws a call to a tool it does not have (when it went out alone
    // or beside other calls) only once the turn is read back from history.
    await judgeRows(entry, must, rows, TURNS.B.filter(call => call.historyOnly))
    must(rows.some(row => row.service === 'parallel'), 'no parallel row after the reload')
    must(rows.some(row => row.family === 'terminal'), 'no terminal row after the reload')
    must(rows.filter(row => row.service || row.family).length >= rows.length - 3, 'rows from history left unmarked')
    must(rec.startsList.length === 0, `${rec.startsList.length} logos animated while history was drawn`)
    await page.evaluate(() => document.querySelector('[data-tool-row][data-mg-svc-row]')?.scrollIntoView({ block: 'center' }))
    await sleep(300)
    await shot(entry, 'l5-after-reload')
  })

  // ── l6. Tools hidden ─────────────────────────────────────────────────────
  await check('l6', async (entry, must) => {
    const marked = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-tool-row] [data-mg-svc-head]')].map(head => head.closest('[data-tool-row]').checkVisibility())
      )

    const shown = await marked()

    entry.evidence.markedRowsVisibleBefore = `${shown.filter(Boolean).length} of ${shown.length}`
    must(shown.some(Boolean), 'no marked row visible before hiding tools')

    // Every change of :root[data-mg-tools] while the palette is used.
    await page.evaluate(() => {
      window.__mgToolsFlips = []
      window.__mgToolsWatch = new MutationObserver(() => window.__mgToolsFlips.push(document.documentElement.dataset.mgTools))
      window.__mgToolsWatch.observe(document.documentElement, { attributeFilter: ['data-mg-tools'], attributes: true })
    })

    // The command palette, as a person would: open, type, press the row.
    await page.keyboard.press('Meta+K')
    await sleep(500)
    await page.keyboard.insertText('Toggle tool calls')
    await sleep(500)
    await shot(entry, 'l6-palette')
    entry.evidence.paletteRow = await page.evaluate(() => {
      const node = [...document.querySelectorAll('body *')].filter(el => el.children.length < 4 && /Toggle tool calls/.test(el.textContent ?? '')).at(-1)
      const item = node?.closest('[role], [cmdk-item], button, [data-slot]')

      return item ? `<${item.tagName.toLowerCase()} role=${item.getAttribute('role')} slot=${item.dataset.slot ?? ''} cmdk=${item.hasAttribute('cmdk-item')}>` : 'none'
    })

    const pressRow = async () => {
      const item = page.getByRole('option', { name: /Toggle tool calls/ }).first()
      const box = (await item.count()) ? await item.boundingBox() : null

      if (box) {
        await page.mouse.click(box.x + Math.min(60, box.width / 2), box.y + box.height / 2)
      } else {
        await page.keyboard.press('Enter')
      }

      await sleep(600)
      entry.evidence.paletteClick = `${box ? 'clicked the row' : 'pressed Enter'}; data-mg-tools now ${await page.evaluate(() => document.documentElement.dataset.mgTools)}`
      await page.keyboard.press('Escape')
      await sleep(300)
    }

    await pressRow()

    let mode = await page.evaluate(() => document.documentElement.dataset.mgTools)

    entry.evidence.toolsFlipsDuringPalette = (await page.evaluate(() => window.__mgToolsFlips)).join(' > ') || 'none'

    entry.evidence.byPalette = mode === 'hidden'

    if (mode !== 'hidden') {
      await page.keyboard.press('Escape')
      results.observations.push('l6: the palette did not toggle tool calls; the check set data-mg-tools itself')
      await page.evaluate(() => {
        document.documentElement.dataset.mgTools = 'hidden'
      })
      mode = 'hidden (set by the check)'
    }

    await sleep(300)

    const hidden = await marked()

    entry.evidence.dataMgTools = mode
    entry.evidence.markedRowsVisibleWhileHidden = `${hidden.filter(Boolean).length} of ${hidden.length}`
    must(hidden.length > 0 && hidden.every(visible => !visible), 'a marked row is still visible with tool calls hidden')
    await shot(entry, 'l6-tools-hidden')

    if (entry.evidence.byPalette) {
      await page.keyboard.press('Meta+K')
      await sleep(500)
      await page.keyboard.insertText('Toggle tool calls')
      await sleep(500)
      await pressRow()
    } else {
      await page.evaluate(() => {
        document.documentElement.dataset.mgTools = 'shown'
      })
    }

    const back = await marked()

    entry.evidence.markedRowsVisibleAfter = `${back.filter(Boolean).length} of ${back.length}`
    must(back.some(Boolean), 'rows did not come back when tool calls were shown again')
    await page.evaluate(() => window.__mgToolsWatch?.disconnect())
  })

  // ── l7. Mapping, fed real names ──────────────────────────────────────────
  // The services module of the plugin this run installed, run on its own in
  // Node with stand-ins for what the core gives it, and fed the names Hermes
  // really sends for every tool family the owner uses. An unknown tool gets a
  // glyph of its kind, never a brand and never nothing.
  await check('l7', async (entry, must) => {
    const built = fs.readFileSync(PLUGIN, 'utf8')
    const from = built.indexOf('// ── src/modules/00-services.js ──')
    const to = built.indexOf('// ── src/modules/', from + 10)

    must(from >= 0 && to > from, 'the services module is not in the built plugin')

    const SHARED = { surfaces: [] }

    new Function('SHARED', 'MODULES', 'sdk', 'onThreads', 'RUNNING', 'THREAD', built.slice(from, to))(SHARED, [], {}, () => () => {}, '', '')

    const services = SHARED.services
    const failures = []
    const verdict = name => {
      const service = services.forTool(name)?.id ?? null

      return service ? `logo:${service}` : `glyph:${services.family(name) ?? 'NONE'}`
    }

    for (const [name, want] of MAPPING) {
      const got = verdict(name)

      if (got !== want) {
        failures.push(`${name} -> ${got}, want ${want}`)
      }
    }

    // Every hosted connector the owner has: its logo, or a kind glyph.
    const connectors = CONNECTORS.map(id => [id, verdict(`connectors__${id}__search`)])
    const withoutLogo = connectors.filter(([, got]) => !got.startsWith('logo:'))

    for (const [id, got] of connectors) {
      if (got === 'glyph:NONE') {
        failures.push(`connectors__${id}__search -> nothing`)
      }
    }

    entry.evidence.namesFed = MAPPING.length + CONNECTORS.length
    entry.evidence.patterns = PATTERNS
    entry.evidence.connectorsWithoutLogo = withoutLogo.map(([id, got]) => `${id} (${got})`).join(', ') || 'none'
    entry.evidence.failures = failures
    must(!failures.length, `${failures.length} name(s) mapped wrongly: ${failures.slice(0, 6).join('; ')}`)
    must(withoutLogo.length <= 2, `${withoutLogo.length} connectors have no logo: ${entry.evidence.connectorsWithoutLogo}`)

    // Planted fault: a stand-in that answers Notion for everything must be
    // caught by the same comparison, so the check can fail.
    const planted = MAPPING.filter(([, want]) => want !== 'logo:notion').some(([name, want]) => (services.forTool(name) ? 'logo:notion' : want) !== want)

    entry.evidence.plantedFaultCaught = planted
    must(planted, 'a mapping that answers one brand for everything was not caught')
  })

  // ── l9. What this machine has installed ──────────────────────────────────
  // Every installed connector, MCP server and built-in, by a real tool name:
  // the logo it resolves to (the services module of the built plugin, run in
  // Node as in l7), then drawn in the page at 14 px on #141415 and measured:
  // a one-colour mark by its ink's contrast, a multi-colour one by its most
  // legible colour. The table goes into the evidence.
  await check('l9', async (entry, must) => {
    const built = fs.readFileSync(PLUGIN, 'utf8')
    const from = built.indexOf('// ── src/modules/00-services.js ──')
    const to = built.indexOf('// ── src/modules/', from + 10)
    const SHARED = { surfaces: [] }

    new Function('SHARED', 'MODULES', 'sdk', 'onThreads', 'RUNNING', 'THREAD', built.slice(from, to))(SHARED, [], {}, () => () => {}, '', '')

    const resolved = INSTALLED.map(([name, want]) => {
      const service = SHARED.services.forTool(name)

      return { family: service ? null : SHARED.services.family(name), got: service ? service.id : `glyph:${SHARED.services.family(name)}`, label: service?.label ?? '', name, want: want ?? `glyph:${SHARED.services.family(name)}`, wantBrand: want !== null }
    })
    const ids = [...new Set(resolved.filter(row => !row.got.startsWith('glyph:')).map(row => row.got))]
    const drawn = await page.evaluate(ids => {
      const lum = ([r, g, b]) => [r, g, b].map(v => v / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)

        return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2))
      }
      const BG = [0x14, 0x14, 0x15]
      const rgbOf = text => {
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())?.[1]

        if (hex) {
          const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex

          return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
        }

        const nums = text.match(/[\d.]+/g)

        return nums && /^rgb/.test(text.trim()) ? nums.slice(0, 3).map(Number) : null
      }
      const host = document.createElement('div')

      host.style.cssText = 'position:fixed;left:0;top:0;background:#141415;padding:4px'
      document.body.append(host)

      const out = {}

      for (const id of ids) {
        const node = document.createElement('span')

        node.dataset.mgService = id
        node.style.setProperty('--mg-svc-size', '14px')
        host.append(node)

        const before = getComputedStyle(node, '::before')
        const mask = /url\(/.test(before.maskImage || before.webkitMaskImage || '')
        const image = /url\(/.test(before.backgroundImage)
        let contrast = null
        let ink = null

        if (mask) {
          ink = before.backgroundColor
          contrast = ratio(rgbOf(ink) ?? [0, 0, 0], BG)
        } else if (image) {
          // The colours the SVG paints with, and the most legible of them.
          const svg = decodeURIComponent(before.backgroundImage.replace(/^url\("?data:image\/svg\+xml(;utf8)?,?/, '').replace(/"?\)$/, ''))
          const colours = [...new Set([...svg.matchAll(/(?:fill|stop-color)[=:]\s*["']?(#[0-9a-f]{3,6}|rgb\([^)]*\))/gi)].map(match => match[1].toLowerCase()))]
          const ratios = colours.map(colour => [colour, rgbOf(colour)]).filter(([, rgb]) => rgb).map(([colour, rgb]) => `${colour} ${ratio(rgb, BG)}`)

          ink = ratios.join(' ')
          contrast = ratios.length ? Math.max(...ratios.map(item => Number(item.split(' ')[1]))) : null
        }

        out[id] = { contrast, ink, mode: mask ? 'mask' : image ? 'image' : 'none', width: before.width, height: before.height }
      }

      host.remove()

      return out
    }, ids)

    const table = resolved.map(row => ({ ...row, ...(drawn[row.got] ?? {}) }))
    const lines = table.map(row => [row.name, row.want, row.got, row.mode ?? 'glyph', row.width ? `${row.width}x${row.height}` : '', row.contrast ?? '', row.ink ?? ''].join('\t'))

    fs.writeFileSync(path.join(EVIDENCE, 'logos-installed.tsv'), ['tool name\twant\tgot\tdrawn as\tbox\tcontrast on #141415\tink / colours'].concat(lines).join('\n'))
    entry.evidence.table = table.map(row => `${row.got === row.want ? 'ok ' : 'BAD'} ${row.name} -> ${row.got}${row.mode && row.mode !== 'glyph' ? ` (${row.mode}, ${row.contrast}:1)` : ''}`)
    entry.evidence.file = 'logos-installed.tsv'

    for (const row of table) {
      must(row.got === row.want, `${row.name} draws ${row.got}, want ${row.want}`)

      if (!row.got.startsWith('glyph:')) {
        must(row.mode === 'mask' || row.mode === 'image', `${row.got}: drawn as ${row.mode}`)
        must(row.width === '16px' && row.height === '14px', `${row.got}: box ${row.width}x${row.height} at 14 px`)
        must(row.contrast >= 3, `${row.got}: its most legible colour is ${row.contrast}:1 on #141415 (${row.ink})`)
      }
    }

    const brands = new Set(table.filter(row => !row.got.startsWith('glyph:')).map(row => row.got))

    entry.evidence.summary = `${table.length} names, ${brands.size} logos, ${table.filter(row => row.got.startsWith('glyph:')).length} glyphs, ${table.filter(row => row.got !== row.want).length} wrong`
  })

  // ── l8. Hot reload ───────────────────────────────────────────────────────
  // stop() must leave nothing behind and a new instance must not double up.
  await check('l8', async (entry, must) => {
    const count = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-tool-row]')]
        const heads = rows.map(row => row.querySelectorAll('[data-mg-svc-head]').length)
        const drawn = rows.filter(row => {
          const head = row.querySelector('[data-mg-svc-head]')
          const before = head ? getComputedStyle(head, '::before') : null

          return before && before.content !== 'none'
        }).length

        return {
          rows: rows.length,
          marked: heads.filter(n => n === 1).length,
          doubled: heads.filter(n => n > 1).length,
          drawn,
          logos: document.querySelectorAll('[data-tool-row] [data-mg-service]').length,
          ours: document.querySelectorAll('[data-mg-svc-head], [data-mg-service], [data-mg-tool-family], [data-mg-svc-row], [data-mg-svc-in]').length,
          arriving: document.querySelectorAll('[data-mg-svc-in]').length,
          root: Object.keys(document.documentElement.dataset).filter(key => key.startsWith('mg')).sort().join(' '),
          styles: document.querySelectorAll('#mg-css').length
        }
      })

    const before = await count()

    await hotReload()
    await sleep(600)
    await hotReload()
    await sleep(900)

    const after = await count()

    await hotReload({ gone: true, source: stubPlugin() })
    await sleep(900)

    const unloaded = await count()

    await hotReload()
    await sleep(900)

    const back = await count()

    Object.assign(entry.evidence, { before, afterTwoReloads: after, unloaded, back })
    must(before.marked > 0 && before.doubled === 0, `before: ${JSON.stringify(before)}`)
    must(after.marked === before.marked && after.doubled === 0 && after.logos === before.logos && after.drawn === before.drawn, `after two reloads the marks changed: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    must(after.arriving === 0, `${after.arriving} rows arriving again after a reload`)
    must(after.root === before.root && after.styles === 1, `root attributes or stylesheets changed: ${after.root} (${after.styles} #mg-css) vs ${before.root}`)
    must(unloaded.ours === 0, `${unloaded.ours} marks of ours left after unloading`)
    must(!unloaded.root, `root attributes left after unloading: ${unloaded.root}`)
    must(back.marked === before.marked && back.doubled === 0, `after loading again: ${JSON.stringify(back)}`)
  })

  // Things worth knowing that are no check's verdict.
  const log = path.join(EVIDENCE, 'renderer-console.log')
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []

  results.observations.push(`renderer console: ${lines.filter(line => /\[pageerror\]/.test(line)).length} page errors, ${lines.filter(line => /monograph/i.test(line) && /warn|error/i.test(line)).length} monograph warnings`)
  results.observations.push(`model script: ${state.mock.calls.join(' ')}`)
  results.observations.push(`tool results the model saw: ${state.mock.toolResults.join(' || ')}`)
  results.observations.push(`while turns ran (rows/marked/arriving/state): ${Object.entries(samples).map(([turn, list]) => `${turn}: ${list.join(' ')}`).join(' | ')}`)
}
