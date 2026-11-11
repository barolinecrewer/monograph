// The agent panel (src/modules/20-agent-panel.js): the right-hand pane with the
// focused session's trace. One app launch runs every check below in order.
//
// The model is this suite's own small server (below), not Hermes' mock: the
// mock's E2E_CALL makes one tool call per turn, and these checks need turns of
// several steps, reasoning, a sub-agent, an approval and 200 tool calls. The
// tools themselves are Hermes' own and really run in the sandbox.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { EVIDENCE, MODE, RUNNING, VIEWPORT, check, hasModule, hotReload, results, stubPlugin, shot, sleep, state, type, waitForAppReady } from '../harness.mjs'

export const checks = [
  ['p1', 'Agent pane: one click on the surfaces row opens it, one closes it, nothing left behind'],
  ['p2', 'Trace: a multi-tool turn fills the pane in order, with states and times'],
  ['p3', 'Sources: search and fetch steps listed by site, de-duplicated'],
  ['p4', 'Sub-agents: a delegated task shows as a bot row that runs and ends'],
  ['p5', 'Approval: Hermes\' waiting approval shows in the pane and a click answers it'],
  ['p6', 'Session switch: the pane follows the focused session'],
  ['p7', 'A 200-step turn stays within the frame budget'],
  ['p8', 'Page reload: the pane comes back with the same trace'],
  ['p9', 'Plugin hot reload: one pane, same trace'],
  ['p10', 'Closed at the end: nothing left in the page'],
  ['p11', 'Plan card: the todo list as a card; a failed todo call keeps it; 60 items; a stopped turn reads stopped'],
  ['p12', 'Sub-agent trace: a click on a sub-agent shows its own steps (60 of them), Back and Escape return'],
  ['p13', 'Hot reload twice: one pane, one plan card, no doubled rows; unloaded, nothing of ours is left'],
  ['p14', 'Bridged tool_call: each inner call has its own service logo on the chat row and in the trace, three in one call in order; tool_search/tool_describe quiet; labels read as the inner tool'],
  ['p11d', 'Plan card on the direct path (todo_list not deferred): fills, updates, survives a failed call'],
  ['p15', 'Approval answered elsewhere (Hermes\' own card): the pane\'s card leaves; Allow in the pane resolves it once'],
  ['p17', 'Approval answered in a second window: the pane in the first settles within one sessions.changed cycle and never shows a live button for an answered request'],
  ['p16', 'The Agent pane\'s tab cannot switch Monograph off; closing the pane leaves the right column as it was']
]

// Checks to run, for probing one part (MG_PANEL_ONLY=p14,p11). Every run
// that is reported runs them all.
const ONLY = (process.env.MG_PANEL_ONLY ?? '').split(',').filter(Boolean)
const checkIf = (id, body) => (ONLY.length && !ONLY.includes(id) ? Promise.resolve() : check(id, body))

// Fake MCP servers, so the bridged path (`tool_call`) runs for real: on the
// owner's setup MCP tools are deferred and reached only through tool_search,
// tool_describe and tool_call. Newline-delimited JSON-RPC over stdio, the
// least an MCP client needs: initialize, tools/list, tools/call.
const MCP_TOOLS = {
  apify: [['call_actor', 'actor']],
  cloudflare: [['search_docs', 'query']],
  firecrawl: [['firecrawl_scrape', 'url']],
  parallel: [['web_search', 'query']]
}
const MCP_CODE = `const server=process.argv[1];const tools=${JSON.stringify(MCP_TOOLS)}[server]||[];let buf='';const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}if(m.id===undefined)continue;const p=m.params||{};if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:p.protocolVersion||'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:server,version:'1.0.0'}}});else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:tools.map(([name,key])=>({name,description:server+' '+name.replace(/_/g,' ')+' for the rig.',inputSchema:{type:'object',properties:{[key]:{type:'string'}},required:[key]}}))}});else if(m.method==='tools/call'){const a=p.arguments||{};const bad=JSON.stringify(a).includes('fail');const text=bad?'Error: '+server+' refused the request':JSON.stringify({server,tool:p.name,results:[{title:'Parallel result',url:'https://parallel.ai/blog/search'},{title:'Docs',url:'https://developers.cloudflare.com/workers/'},{title:'Elsewhere',url:'https://example.net/page'}]});setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text}],isError:bad}}),900)}else send({jsonrpc:'2.0',id:m.id,result:{}})}})`
const mcpServers = Object.keys(MCP_TOOLS)
  .map(name => `  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: ${JSON.stringify(['-e', MCP_CODE, name])}\n`)
  .join('')

// Sandbox settings: Hermes asks before a recursive delete, and reasoning is
// sent to the window (it is what the panel's "Thinking" rows are made of).
// Tool search stays at Hermes' default (todo_list and every MCP tool
// deferred, as on the owner's setup); p11d turns deferral off for its own
// session.
export const config = `approvals:\n  mode: "manual"\ndisplay:\n  show_reasoning: true\nmcp_servers:\n${mcpServers}`

const MULTI = 'Rig panel prompt, MG_PANEL_MULTI. Research the brand.'
const MULTI_DONE = 'MG_PANEL_MULTI_DONE'
const SUB = 'Rig panel prompt, MG_PANEL_SUB. Hand one part to a helper.'
const SUB_DONE = 'MG_PANEL_SUB_DONE'
const APPROVE = 'Rig panel prompt, MG_PANEL_APPROVE. Clean the scratch folder.'
const APPROVE_DONE = 'MG_PANEL_APPROVE_DONE'
const OTHER = 'Rig panel prompt, MG_PANEL_OTHER. One quick step.'
const OTHER_DONE = 'MG_PANEL_OTHER_DONE'
const MANY = 'Rig panel prompt, MG_PANEL_MANY. Two hundred steps.'
const MANY_DONE = 'MG_PANEL_MANY_DONE'
const APPROVAL_COMMAND = 'rm -rf /tmp/mg-panel-approval-probe'
const TODO = 'Rig panel prompt, MG_PANEL_TODO. Plan the launch.'
const TODO_DONE = 'MG_PANEL_TODO_DONE'
const PLAN60 = 'Rig panel prompt, MG_PANEL_PLANLONG. Sixty items, then a long step.'
const SUB60 = 'Rig panel prompt, MG_PANEL_SUBLONG. Hand sixty steps to a helper.'
const SUB60_DONE = 'MG_PANEL_SUBLONG_DONE'
const BRIDGE = 'Rig panel prompt, MG_PANEL_BRIDGE. Search, then call through the bridge.'
const BRIDGE_DONE = 'MG_PANEL_BRIDGE_DONE'
const DIRECT = 'Rig panel prompt, MG_PANEL_DIRECTTODO. Plan without the bridge.'
const DIRECT_DONE = 'MG_PANEL_DIRECTTODO_DONE'

const PLAN = ['Read the brief', 'Collect the sources', 'Draft the positioning', 'Check the numbers', 'Write the release notes', 'Review with design', 'Publish']
const todo = (items, active, done = []) =>
  items.map((content, index) => ({ content, id: String(index + 1), status: done.includes(index) ? 'completed' : index === active ? 'in_progress' : 'pending' }))

const EXTRACT_URLS = [
  'https://www.acedesign.io/about',
  'https://acedesign.io/pricing',
  'https://www.linkedin.com/company/acedesign',
  'https://x.com/acedesign/status/1',
  'https://github.com/acedesign/site',
  'https://acedesign.io/',
  'https://example.org/review',
  'https://news.ycombinator.com/item?id=1'
]
const EXPECTED_HOSTS = ['acedesign.io', 'linkedin.com', 'x.com', 'github.com', 'example.org', 'news.ycombinator.com']

// ── The model ─────────────────────────────────────────────────────────────
// Each completion is chosen by the prompt's token and by how many tool
// results follow the last user message (the step of the script it is on).
const call = (name, args) => ({ args, name })
// A deferred tool, reached the way the model reaches it on the owner's setup.
const bridged = (...entries) => call('tool_call', { calls: entries.map(([name, args]) => ({ arguments: args, name })) })

// The bridged path, step by step (item 1 of the brief; docs/agent-panel.md).
const BRIDGE_STEPS = [
  { text: '', tools: [call('tool_search', { queries: ['parallel web search'] })] },
  { text: '', tools: [call('tool_describe', { names: ['mcp__parallel__web_search'] })] },
  { text: '', tools: [bridged(['mcp__parallel__web_search', { query: 'acedesign launch' }])] },
  {
    text: '',
    tools: [
      bridged(
        ['connectors__gmail__GMAIL_FETCH_EMAILS', { query: 'launch' }],
        ['connectors__notion__NOTION_SEARCH', { query: 'brief' }],
        ['connectors__slack__SLACK_SEND_MESSAGE', { channel: '#launch', text: 'Draft is up.' }]
      )
    ]
  },
  { text: '', tools: [bridged(['mcp__parallel__web_search', { query: 'three at once' }], ['mcp__apify__call_actor', { actor: 'site-crawler' }], ['mcp__firecrawl__firecrawl_scrape', { url: 'https://acedesign.io/' }])] },
  { text: '', tools: [bridged(['mcp__cloudflare__search_docs', { query: 'fail on purpose' }])] },
  { text: '', tools: [bridged(['todo_list', { todos: [{ content: 'Bridged plan item', id: '1', status: 'in_progress' }] }])] }
]

function script(user, done, rounds = done) {
  if (user.includes('MG_PANEL_BRIDGE')) {
    return BRIDGE_STEPS[rounds] ?? { text: `${BRIDGE_DONE}: bridged calls ran.` }
  }

  if (user.includes('MG_PANEL_DIRECTTODO')) {
    // Direct calls: this session's config does not defer todo_list.
    return [
      { text: '', tools: [call('todo_list', { todos: todo(PLAN, 0) })] },
      // A call that fails: an item with no text (the todo tool refuses it).
      // A list that is not a list does not fail on this path: the tool takes
      // it as one "(invalid item)"; through the bridge the schema check
      // refuses it (p11).
      { text: '', tools: [call('todo_list', { todos: [{ content: '', id: '1', status: 'pending' }] })] },
      { text: '', tools: [call('todo_list', { todos: todo(PLAN, 1, [0]) })] },
      { text: `${DIRECT_DONE}: direct plan.` }
    ][Math.min(done, 3)]
  }

  if (user.includes('MG_PANEL_CHILDLONG')) {
    // Sixty steps in one go, for the sub-agent's own trace.
    return [
      { text: '', tools: Array.from({ length: 60 }, (_, index) => call('terminal', { command: `echo child-long-${index + 1}` })) },
      { text: 'Child finished sixty steps.' }
    ][Math.min(done ? 1 : 0, 1)]
  }

  if (user.includes('MG_PANEL_CHILD')) {
    return [
      { reasoning: 'The helper reads the notes first.', text: '', tools: [call('terminal', { command: 'sleep 1 && echo child-step' })] },
      { text: 'Child finished: the notes are summarised.' }
    ][Math.min(done, 1)]
  }

  if (user.includes('MG_PANEL_MULTI')) {
    return [
      { reasoning: 'Plan: search for the brand, read its pages, then build.', text: 'Looking for sources first.', tools: [call('web_search', { query: 'acedesign positioning' })] },
      { text: '', tools: [call('web_extract', { urls: EXTRACT_URLS })] },
      { reasoning: 'Sources read. Now a build step that takes a while.', text: '', tools: [call('terminal', { command: 'sleep 2 && echo built' })] },
      { text: '', tools: [call('terminal', { command: 'echo failing-on-purpose; exit 3' })] },
      { text: `${MULTI_DONE}: every step ran.` }
    ][Math.min(done, 4)]
  }

  if (user.includes('MG_PANEL_SUB.')) {
    return [
      { text: '', tools: [call('delegate_task', { context: 'Rig sub-agent.', goal: 'MG_PANEL_CHILD summarise the notes' })] },
      { text: `${SUB_DONE}: the helper reported back.` }
    ][Math.min(done, 1)]
  }

  if (user.includes('MG_PANEL_APPROVE')) {
    return [{ text: '', tools: [call('terminal', { command: APPROVAL_COMMAND })] }, { text: `${APPROVE_DONE}: answered.` }][Math.min(done, 1)]
  }

  if (user.includes('MG_PANEL_TODO')) {
    return [
      { text: '', tools: [bridged(['todo_list', { todos: todo(PLAN, 0) }])] },
      // A second's work, so the card is seen between two revisions.
      { text: '', tools: [call('terminal', { command: 'sleep 1 && echo plan-step-1' })] },
      { text: '', tools: [bridged(['todo_list', { todos: todo(PLAN, 1, [0]) }])] },
      { text: '', tools: [call('terminal', { command: 'echo failing-on-purpose; exit 3' })] },
      // A todo call that fails (no list): the card keeps the last good one.
      { text: '', tools: [bridged(['todo_list', { todos: 'not a list' }])] },
      { text: '', tools: [bridged(['todo_list', { todos: todo(PLAN, 2, [0, 1]) }])] },
      { text: `${TODO_DONE}: the plan is under way.` }
    ][Math.min(done, 6)]
  }

  if (user.includes('MG_PANEL_PLANLONG')) {
    const items = Array.from({ length: 60 }, (_, index) => `Long plan item ${index + 1}`)

    return [
      { text: '', tools: [bridged(['todo_list', { todos: todo(items, 40, Array.from({ length: 40 }, (_, index) => index)) }])] },
      { text: '', tools: [call('terminal', { command: 'sleep 45 && echo never' })] },
      { text: 'Stopped plan.' }
    ][Math.min(done, 2)]
  }

  if (user.includes('MG_PANEL_SUBLONG')) {
    return [
      { text: '', tools: [call('delegate_task', { context: 'Rig sub-agent, long.', goal: 'MG_PANEL_CHILDLONG run sixty steps' })] },
      { text: `${SUB60_DONE}: handed over.` }
    ][Math.min(done, 1)]
  }

  if (user.includes('MG_PANEL_OTHER')) {
    return [{ text: '', tools: [call('terminal', { command: 'echo other-session' })] }, { text: `${OTHER_DONE}: one step.` }][Math.min(done, 1)]
  }

  if (user.includes('MG_PANEL_MANY')) {
    // 200 tool calls in four batches of 50: one model round trip per batch.
    if (done >= 200) {
      return { text: `${MANY_DONE}: 200 steps.` }
    }

    return {
      text: '',
      tools: Array.from({ length: 50 }, (_, index) => call('terminal', { command: `echo step-${done + index + 1}` }))
    }
  }

  return { text: 'Reply from the rig model.' }
}

const textOf = message =>
  typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join(' ') : ''

function lastUser(messages) {
  const index = messages.map(message => message?.role).lastIndexOf('user')
  const after = messages.slice(index + 1)

  return {
    done: after.filter(message => message?.role === 'tool').length,
    // Model rounds that called tools: a bridged batch the gateway splits
    // answers with several tool messages for one round.
    rounds: after.filter(message => message?.role === 'assistant' && message.tool_calls?.length).length,
    // The prompt was already answered and something woke the chat again (a
    // background sub-agent reporting back): reply in a line, run nothing.
    answered: after.some(message => message?.role === 'assistant' && !message.tool_calls?.length && textOf(message).trim()),
    text: textOf(messages[index])
  }
}

let callSeq = 0

function respond(res, model, turn, stream) {
  const toolCalls = (turn.tools ?? []).map((tool, index) => ({
    function: { arguments: JSON.stringify(tool.args), name: tool.name },
    id: `call_mg_${++callSeq}`,
    index,
    type: 'function'
  }))
  const finish = toolCalls.length ? 'tool_calls' : 'stop'

  if (!stream) {
    const message = { content: turn.text || null, role: 'assistant' }

    if (toolCalls.length) {
      message.tool_calls = toolCalls.map(({ index, ...rest }) => rest)
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ finish_reason: finish, index: 0, message }], created: 0, id: 'mg', model, object: 'chat.completion', usage: { completion_tokens: 20, prompt_tokens: 10, total_tokens: 30 } }))

    return
  }

  res.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' })

  const chunk = (delta, reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason, index: 0 }], created: 0, id: 'mg', model, object: 'chat.completion.chunk' })}\n\n`
  const parts = []

  for (const word of (turn.reasoning ?? '').split(' ').filter(Boolean)) {
    parts.push({ reasoning_content: `${word} ` })
  }

  for (const [index, word] of (turn.text ?? '').split(' ').filter(Boolean).entries()) {
    parts.push({ content: index ? ` ${word}` : word })
  }

  const next = () => {
    if (res.destroyed) {
      return
    }

    const part = parts.shift()

    if (part) {
      res.write(chunk(part))
      setTimeout(next, 15)

      return
    }

    res.write(toolCalls.length ? chunk({ tool_calls: toolCalls }, finish) : chunk({}, finish))
    res.write('data: [DONE]\n\n')
    res.end()
  }

  next()
}

const requests = []

export async function model() {
  const receivedPrompts = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ created: 0, id: 'mock-model', object: 'model', owned_by: 'mock' }], object: 'list' }))

      return
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')

      return
    }

    let body = ''

    req.on('data', piece => {
      body += piece
    })
    req.on('end', () => {
      let parsed = {}

      try {
        parsed = JSON.parse(body)
      } catch {
        // Treated as an empty request.
      }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const { answered, done, rounds, text } = lastUser(messages)
      const wake = answered || !/MG_PANEL_[A-Z]+/.test(text)

      receivedPrompts.push(text.slice(0, 120))
      requests.push({ direct: (parsed.tools ?? []).map(tool => tool?.function?.name).filter(name => /^todo|^tool_call$/.test(name ?? '')).join(','), done, roles: messages.map(message => message?.role?.[0] ?? '?').join('').slice(-40), tool: textOf(messages.filter(message => message?.role === 'tool').at(-1) ?? {}).slice(0, 240), user: text.slice(0, 160), wake })
      // The bridged turn goes at a reading pace, so every row it draws is
      // on screen for a few samples.
      setTimeout(() => respond(res, parsed.model || 'mock-model', wake ? { text: 'Noted.' } : script(text, done, rounds), parsed.stream === true), !wake && /MG_PANEL_(BRIDGE|DIRECTTODO)/.test(text) ? 600 : 0)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const port = server.address().port

  return {
    close: () => new Promise(resolve => server.close(() => resolve())),
    port,
    receivedPrompts,
    url: `http://127.0.0.1:${port}`
  }
}

// ── Reading the page ──────────────────────────────────────────────────────
const readPanel = () =>
  state.page.evaluate(() => {
    const panes = [...document.querySelectorAll('.mg-agent')]
    const root = panes[0]

    if (!root) {
      return { count: 0, open: false, rows: [], subs: [], chips: [] }
    }

    const rect = root.getBoundingClientRect()
    const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()

    return {
      approval: root.querySelector('.mg-agent-approval')
        ? {
            buttons: [...root.querySelectorAll('.mg-agent-approval button')].map(text),
            command: text(root.querySelector('.mg-agent-approval pre')),
            id: root.querySelector('.mg-agent-approval').dataset.mgApprovalCard
          }
        : null,
      chips: [...root.querySelectorAll('.mg-agent-chip')].map(text),
      count: panes.length,
      empty: text(root.querySelector('.mg-agent-scroll > .mg-agent-empty')),
      head: text(root.querySelector('.mg-agent-elapsed')),
      more: text(root.querySelector('.mg-agent-more')),
      open: root.checkVisibility() && rect.width > 0 && rect.height > 0,
      queries: text(root.querySelector('.mg-agent-queries')),
      rows: [...root.querySelectorAll('.mg-agent-step')].map(row => {
        const label = text(row.querySelector('.mg-agent-text > b'))

        return {
          detail: text(row.querySelector('.mg-agent-text')).slice(label.length).trim(),
          isNew: 'mgNew' in row.dataset,
          kind: row.dataset.mgKind,
          label,
          service: row.querySelector('[data-mg-service]')?.dataset.mgService ?? null,
          state: row.dataset.state,
          time: row.dataset.mgTime ?? ''
        }
      }),
      earlier: text(root.querySelector('.mg-agent-earlier')),
      session: root.dataset.mgAgentSession,
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      status: root.querySelector('.mg-agent-trace')?.dataset.mgStatus ?? null,
      subs: [...root.querySelectorAll('.mg-agent-sub')].map(row => ({
        bot: Boolean(row.querySelector('svg.mg-agent-bot path')),
        line: text(row.querySelector('.mg-agent-text > span')),
        state: row.dataset.state,
        time: text(row.querySelector('.mg-agent-time')),
        title: text(row.querySelector('.mg-agent-text > b'))
      })),
      turn: root.querySelector('.mg-agent-trace')?.dataset.mgTurn ?? null,
      todo: root.querySelector('.mg-agent-todo')
        ? {
            count: text(root.querySelector('.mg-agent-todo .mg-agent-count')),
            items: [...root.querySelectorAll('.mg-agent-todo-item')].map(item => `${item.dataset.state}:${text(item.querySelector('.mg-agent-todo-text'))}`),
            more: [...root.querySelectorAll('.mg-agent-todo .mg-agent-earlier')].map(text),
            revision: root.querySelector('.mg-agent-todo').dataset.mgTodoRevision,
            cards: root.querySelectorAll('.mg-agent-todo').length
          }
        : null,
      subtrace: root.querySelector('.mg-agent-subtrace')
        ? {
            goal: text(root.querySelector('.mg-agent-subhead .mg-agent-text > b')),
            line: text(root.querySelector('.mg-agent-subhead .mg-agent-text > span')),
            steps: root.querySelectorAll('.mg-agent-subtrace .mg-agent-step').length,
            earlier: text(root.querySelector('.mg-agent-subtrace .mg-agent-earlier')),
            states: [...new Set([...root.querySelectorAll('.mg-agent-subtrace .mg-agent-step')].map(row => row.dataset.state))]
          }
        : null
    }
  })

const chatWidth = () => state.page.evaluate(viewport => Math.round(document.querySelector(viewport)?.getBoundingClientRect().width ?? -1), VIEWPORT)

const done = (needle, timeout = 120_000) =>
  state.page.waitForFunction(
    ({ needle, running, viewport }) => !document.querySelector(running) && (document.querySelector(viewport)?.textContent ?? '').includes(needle),
    { needle, running: RUNNING, viewport: VIEWPORT },
    { polling: 100, timeout }
  )

// Clicks on the surfaces button that did not reach it, and what took them.
const surfacesBlocked = []

// The surfaces button, pressed with the mouse; then the menu's own row.
async function surfacesRow(label) {
  const { page } = state
  const button = page.locator('[data-tour="mg-surfaces"] .mg-surfaces-hit').first()
  const box = await button.boundingBox()

  if (!box) {
    throw new Error('no surfaces button to click')
  }

  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  // Once a click is known to land elsewhere, do not keep pressing the cover
  // (in Advanced mode it swaps the sidebars every time); use the keyboard.
  const covered = surfacesBlocked.length
    ? await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('[data-tour="mg-surfaces"]'), { x, y })
    : false

  if (!covered) {
    await page.mouse.click(x, y)
  }

  const opened = !covered && await page
    .waitForSelector('.mg-surfaces-menu .mg-surface-row', { state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false)

  if (covered) {
    await page.locator('[data-tour="mg-surfaces"]').first().focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('.mg-surfaces-menu .mg-surface-row', { state: 'visible', timeout: 3000 })
  } else if (!opened) {
    // Something lies over the button (in Advanced mode Hermes' own "Swap
    // sidebar sides" does; a known issue). Note it, undo what that click did,
    // and reach the menu from the keyboard so the later checks still run.
    const cover = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })

    surfacesBlocked.push(cover ?? 'unknown')

    if (cover === 'Swap sidebar sides') {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(300)
    }

    await page.locator('[data-tour="mg-surfaces"]').first().focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('.mg-surfaces-menu .mg-surface-row', { state: 'visible', timeout: 3000 })
  }

  const rows = await page.$$eval('.mg-surfaces-menu .mg-surface-row', nodes => nodes.map(node => (node.textContent ?? '').trim()))
  const row = page.locator('.mg-surfaces-menu .mg-surface-row', { hasText: label }).first()
  const rowBox = await row.boundingBox()

  if (!rowBox) {
    throw new Error(`no "${label}" row in the surfaces menu (rows: ${rows.join(' | ')})`)
  }

  await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)

  return rows
}

const waitPanel = (open, timeout = 4000) =>
  state.page
    .waitForFunction(open => Boolean(document.querySelector('.mg-agent')?.checkVisibility()) === open, open, { polling: 50, timeout })
    .then(() => true)
    .catch(() => false)

// Rows of the panel sampled while a turn runs, until `needle` is on screen.
async function sampleTurn(needle, timeout = 120_000) {
  const samples = []
  const started = Date.now()
  let finished = false

  done(needle, timeout).then(
    () => {
      finished = true
    },
    () => {
      finished = true
    }
  )

  while (!finished && Date.now() - started < timeout) {
    const panel = await readPanel()

    samples.push({ ms: Date.now() - started, chat: await chatWidth(), head: panel.head, rows: (panel.rows ?? []).map(row => `${row.label}:${row.state}`), status: panel.status })
    await sleep(200)
  }

  await done(needle, 5000)

  return samples
}

// No turn running anywhere in the thread for 3s in a row.
async function quiet(limit = 60_000) {
  const started = Date.now()
  let since = Date.now()

  while (Date.now() - started < limit) {
    const busy = await state.page.evaluate(running => Boolean(document.querySelector(running)), RUNNING)

    if (busy) {
      since = Date.now()
    } else if (Date.now() - since >= 3000) {
      return true
    }

    await sleep(200)
  }

  return false
}

const debugEvents = () => state.page.evaluate(() => (window.__mgAgentEvents ?? []).splice(0))

function keepEvents(name, events) {
  fs.writeFileSync(path.join(EVIDENCE, `${name}-events.json`), JSON.stringify(events, null, 1))

  return events.reduce((out, event) => {
    out[event.type] = (out[event.type] ?? 0) + 1

    return out
  }, {})
}

// Self time per script and the heaviest functions of a CPU profile.
function summarise(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const self = new Map()
  const gaps = profile.timeDeltas ?? []

  profile.samples.forEach((id, index) => {
    self.set(id, (self.get(id) ?? 0) + (gaps[index] ?? 0) / 1000)
  })

  const byScript = {}
  const byFunction = {}

  for (const [id, ms] of self) {
    const frame = byId.get(id)?.callFrame ?? {}
    const script = (frame.url || `(${frame.functionName || 'program'})`).replace(/^.*\//, '')
    const fn = `${frame.functionName || '(anon)'} ${script}:${frame.lineNumber}`

    byScript[script] = (byScript[script] ?? 0) + ms
    byFunction[fn] = (byFunction[fn] ?? 0) + ms
  }

  const top = map => Object.entries(map).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([name, ms]) => `${Math.round(ms)}ms ${name}`)

  return { byFunction: top(byFunction), byScript: top(byScript) }
}

// Hermes' tool rows in the thread on screen, in order, with our marks.
const readChatRows = () =>
  state.page.evaluate(() => {
    const viewport = [...document.querySelectorAll('[data-slot="aui_thread-viewport"]')].find(node => node.getBoundingClientRect().width > 0) ?? document
    const pairs = [...viewport.querySelectorAll('[data-slot="aui_turn-pair"]')]
    const last = pairs.at(-1) ?? viewport

    return [...last.querySelectorAll('[data-slot="tool-block"][data-tool-row]')].map(row => {
      const head = row.querySelector('[data-mg-svc-head]')

      return {
        family: head?.dataset.mgToolFamily ?? null,
        service: head?.dataset.mgService ?? null,
        title: (row.querySelector('button')?.textContent ?? row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)
      }
    })
  })

// The trace's rows with the service each one draws.
const SERVICES_IN_ORDER = ['parallel', 'gmail', 'notion', 'slack', 'parallel', 'apify', 'firecrawl', 'cloudflare']

const parseTime = text => {
  const match = /^(?:(\d+)m )?([\d.]+)s$/.exec(text ?? '')

  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : NaN
}

// ── The checks ────────────────────────────────────────────────────────────
export async function run() {
  const { app, page } = state

  // Raw event log for the evidence: the module keeps one only with this flag.
  await page.evaluate(() => window.localStorage.setItem('hermes.plugin.monograph.agentDebug', '1'))
  await page.reload()
  await waitForAppReady({ app, page }, 60_000)
  await page.waitForSelector('[data-tour="mg-surfaces"] .mg-surfaces-hit', { timeout: 30_000 })

  // ── p1. Open and close from the surfaces menu ──
  await checkIf('p1', async (entry, must) => {
    must(!(await readPanel()).open, 'the pane was open before any click')

    const chatBefore = await chatWidth()
    const rows = await surfacesRow('Agent')

    must(!surfacesBlocked.length, `the click on the surfaces button landed on "${surfacesBlocked[0]}" instead; the menu was opened from the keyboard for the rest of the run`)

    entry.evidence.menuRows = rows
    // Home, Knowledge (in a build that has it), Agent: Monograph's own rows,
    // by rank (home suite h11).
    const before = hasModule('knowledge') ? ['KnowledgeK', 'Knowledge'] : ['HomeH', 'Home']

    must(rows.indexOf('AgentP') === rows.indexOf(before[0]) + 1 && rows.filter(row => row === 'AgentP').length === 1, `"Agent" (P) is not the one row after ${before[1]}: ${rows.join(' | ')}`)
    must(await waitPanel(true), 'the pane did not open within 4s of the click on "Agent"')

    const opened = await readPanel()

    entry.evidence.opened = { count: opened.count, empty: opened.empty, size: opened.size }
    entry.evidence.chatWidth = { before: chatBefore, open: await chatWidth() }
    must(opened.count === 1, `${opened.count} panes in the page`)
    must(opened.empty, 'an empty session shows no "nothing has run" line')
    await shot(entry, 'p1-open-empty')

    await surfacesRow('Agent')
    must(await waitPanel(false), 'the pane did not close within 4s of the second click')

    const left = await page.evaluate(() => ({
      attr: document.documentElement.hasAttribute('data-mg-agent-open'),
      nodes: document.querySelectorAll('[class*="mg-agent"]').length,
      tab: document.querySelectorAll('[data-pane-tab-id="monograph:agent"]').length,
      where: [...document.querySelectorAll('.mg-agent')].map(node => {
        const rect = node.getBoundingClientRect()

        return `${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)} inert=${Boolean(node.closest('[inert]'))} hidden=${Boolean(node.closest('[aria-hidden="true"]'))}`
      })
    }))

    // The module folds Hermes' right column back after a close (120 ms, and
    // a check 250 ms later); the column itself eases. Read once that is over.
    entry.evidence.chatWidthAtClose = await chatWidth()
    await sleep(1400)
    entry.evidence.afterClose = { ...left, chatWidth: await chatWidth() }
    entry.evidence.refolds = await page.evaluate(() => (window.__mgAgentEvents ?? []).filter(event => /^refold/.test(event.type)).map(event => `${event.type} ${event.before ?? ''}->${event.now}`))
    entry.evidence.forcedReveals = (await page.evaluate(() => (window.__mgAgentEvents ?? []).filter(event => event.type === 'reveal').length))
    must(!left.attr && !left.nodes && !left.tab, `left behind after closing: ${JSON.stringify(left)}`)
    must(entry.evidence.afterClose.chatWidth === chatBefore, `the chat column is ${entry.evidence.afterClose.chatWidth}px wide after closing, ${chatBefore}px before opening`)
    await shot(entry, 'p1-closed')

    // Open again for the next checks, this time by the row's letter.
    await page.locator('[data-tour="mg-surfaces"]').first().focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('.mg-surfaces-menu', { state: 'visible', timeout: 3000 })
    await page.keyboard.press('p')
    must(await waitPanel(true), 'the letter P in the open menu did not open the pane')
  })

  // ── p2. A multi-tool turn ──
  await checkIf('p2', async (entry, must) => {
    await debugEvents()
    await type(MULTI, 'Enter')

    // Motion, read on the first running row: on, then with motion off.
    // However motion off is put in place (a stylesheet, a rule, a style
    // element added by an observer a microtask later), it must be in force
    // two frames after the attribute is written: the read waits that long,
    // and only counts when the row was still running at both reads.
    const motion = page
      .evaluate(async () => {
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const root = document.documentElement
        // Motion off has one meaning (05-motion.css): any animation of ours
        // takes 1 ms or less. So "moves" is a name with a longer duration.
        const ms = value => Math.max(...String(value).split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000)))
        const moving = style => (style.animationName !== 'none' && ms(style.animationDuration) > 1 ? style.animationName : 'none')
        const until = Date.now() + 30_000

        while (Date.now() < until) {
          const row = document.querySelector('.mg-agent .mg-agent-step[data-state="running"]')

          if (!row) {
            await new Promise(resolve => setTimeout(resolve, 50))
            continue
          }

          const read = () => ({ dot: moving(getComputedStyle(row, '::before')), row: moving(getComputedStyle(row)), running: row.isConnected && row.dataset.state === 'running' })
          const was = root.dataset.mgMotion
          const on = read()

          root.dataset.mgMotion = 'off'
          await frames()

          const off = read()

          if (was === undefined) {
            delete root.dataset.mgMotion
          } else {
            root.dataset.mgMotion = was
          }

          await frames()

          const back = read()

          if (on.running && off.running) {
            return { back, off, on }
          }
        }

        return null
      })
      .catch(() => null)

    const samples = await sampleTurn(MULTI_DONE)

    entry.evidence.motion = await motion
    must(entry.evidence.motion?.on.dot === 'mg-agent-breathe', `a running row's dot does not breathe: ${JSON.stringify(entry.evidence.motion)}`)
    must(entry.evidence.motion?.off.dot === 'none' && entry.evidence.motion?.off.row === 'none', `with motion off a running row still animates: ${JSON.stringify(entry.evidence.motion)}`)
    const end = await readPanel()
    const events = await debugEvents()

    entry.evidence.eventTypes = keepEvents('p2', events)
    entry.evidence.toolStartPayload = events.find(event => event.type === 'tool.start')?.payload ?? null
    entry.evidence.toolCompletePayloads = events.filter(event => event.type === 'tool.complete').map(event => event.payload.slice(0, 300))
    entry.evidence.timeline = samples
      .filter((sample, index) => index === 0 || JSON.stringify([sample.rows, sample.status]) !== JSON.stringify([samples[index - 1].rows, samples[index - 1].status]))
      .map(sample => `${sample.ms}ms [${sample.status}] ${sample.head} | ${sample.rows.join(', ')}`)
    entry.evidence.final = { head: end.head, rows: end.rows.map(row => `${row.kind} ${row.label} "${row.detail}" ${row.state} ${row.time}`) }

    const tools = end.rows.filter(row => row.kind === 'tool')
    const names = tools.map(row => row.label)

    must(JSON.stringify(names) === JSON.stringify(['Web search', 'Web extract', 'Terminal', 'Terminal']), `tool rows read ${JSON.stringify(names)}, expected Web search, Web extract, Terminal, Terminal`)
    must(tools[0]?.detail.includes('acedesign'), `the search row's argument is ${JSON.stringify(tools[0]?.detail)}`)
    must(tools[2]?.detail.includes('sleep 2'), `the build row's argument is ${JSON.stringify(tools[2]?.detail)}`)
    must(tools[2]?.state === 'done' && parseTime(tools[2]?.time) >= 1.9, `the 2s build step reads ${tools[2]?.state} ${tools[2]?.time}`)
    must(tools[3]?.state === 'failed', `the step that exits 3 reads ${tools[3]?.state}, expected failed`)
    must(end.rows.some(row => row.kind === 'think' && row.detail.startsWith('Plan')), 'no Thinking row with the reasoning\'s first line')
    must(end.rows.filter(row => row.state === 'running').length === 0, 'a row still runs after the turn ended')
    must(!end.rows.some(row => row.detail.includes(MULTI_DONE)), 'the answer is listed as a step; it belongs to the chat')
    must(end.rows.some(row => row.kind === 'note' && row.detail.startsWith('Looking for sources')), 'the interim note before the search is not listed')
    must(end.status === 'done' && /^Worked for \d+s$/.test(end.head) && parseTime(end.head.replace('Worked for ', '')) >= 2, `the header reads ${JSON.stringify(end.head)} (${end.status})`)
    must(samples.some(sample => /^Working for/.test(sample.head) && sample.rows.some(row => row.endsWith(':running'))), 'no sample showed "Working for" with a running row while the turn ran')

    // In order: a step never appears before the one that ran before it.
    const order = samples.map(sample => sample.rows.filter(row => /^(Web|Terminal)/.test(row)).map(row => row.split(':')[0]))
    const prefix = order.every(list => list.every((name, index) => name === names[index]))

    must(prefix, 'at some sample the tool rows were not a prefix of the final order')

    const widths = [...new Set(samples.map(sample => sample.chat))]

    entry.evidence.chatWidthsDuringTurn = widths
    must(widths.length === 1, `the chat column changed width while the pane updated: ${widths.join(', ')}`)
    await shot(entry, 'p2-multi-tool-trace')
  })

  // ── p3. Sources ──
  await checkIf('p3', async (entry, must) => {
    const before = await readPanel()

    entry.evidence.chips = before.chips
    entry.evidence.more = before.more
    entry.evidence.queries = before.queries
    must(before.queries.includes('acedesign positioning'), `the search query is not listed: ${JSON.stringify(before.queries)}`)
    must(before.chips.length === 4 && /^\d+ more$/.test(before.more), `expected 4 chips and "N more", saw ${JSON.stringify(before.chips)} and ${JSON.stringify(before.more)}`)

    const more = page.locator('.mg-agent .mg-agent-more').first()
    const box = await more.boundingBox()

    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(300)
    }

    const after = await readPanel()
    const hosts = after.chips

    entry.evidence.chipsAfterMore = hosts
    must(new Set(hosts).size === hosts.length, `a site is listed twice: ${hosts.join(', ')}`)

    for (const host of EXPECTED_HOSTS) {
      must(hosts.some(chip => chip === host || chip.toLowerCase().includes(host.split('.')[0])), `${host} is not listed after "more": ${hosts.join(', ')}`)
    }

    must(hosts.filter(chip => /acedesign/i.test(chip)).length === 1, 'acedesign.io (three URLs, with and without www) is not listed exactly once')

    // Each site carries its service's logo when it has one, else a globe.
    entry.evidence.chipMarks = await page.evaluate(() =>
      [...document.querySelectorAll('.mg-agent .mg-agent-chip')].map(chip => `${(chip.textContent ?? '').trim()}=${chip.querySelector('[data-mg-service]')?.dataset.mgService ?? (chip.querySelector('.codicon-globe') ? 'globe' : 'none')}`)
    )
    must(entry.evidence.chipMarks.every(mark => !mark.endsWith('=none')), `a source has no mark: ${entry.evidence.chipMarks.join(', ')}`)
    must(entry.evidence.chipMarks.some(mark => /=github$/.test(mark)), `github.com is not drawn with the GitHub logo: ${entry.evidence.chipMarks.join(', ')}`)
    must(entry.evidence.chipMarks.some(mark => /^example\.org=globe$/.test(mark)), `example.org is not drawn with the globe: ${entry.evidence.chipMarks.join(', ')}`)
    entry.evidence.modules = await page.evaluate(() => document.documentElement.dataset.mgModules ?? '')
    await shot(entry, 'p3-sources')
  })

  // ── p4. Sub-agent ──
  await checkIf('p4', async (entry, must) => {
    await debugEvents()
    await type(SUB, 'Enter')

    const seen = []
    const seenSubs = []
    const started = Date.now()
    let running = null
    let finished = false

    done(SUB_DONE, 120_000).then(
      () => (finished = true),
      () => (finished = true)
    )

    while (!finished && Date.now() - started < 120_000) {
      const panel = await readPanel()

      if (panel.subs?.length) {
        seenSubs.push(panel.subs)
        seen.push(`${panel.subs.map(sub => `${sub.state} "${sub.title}" ${sub.line}`).join(' / ')}`)

        if (!running && panel.subs.some(sub => sub.state === 'running')) {
          running = panel.subs
          await shot(entry, 'p4-subagent-running')
        }
      }

      await sleep(150)
    }

    await done(SUB_DONE, 5000)

    // The helper runs in the background and reports after the turn: wait for
    // its row to end, then for the chat to be quiet (the report wakes it).
    let ended = false

    for (const until = Date.now() + 60_000; Date.now() < until && !ended; ) {
      const panel = await readPanel()

      if (panel.subs?.length) {
        seenSubs.push(panel.subs)
        seen.push(`${panel.subs.map(sub => `${sub.state} "${sub.title}" ${sub.line} ${sub.time}`).join(' / ')}`)
        ended = panel.subs.every(sub => sub.state !== 'running')
        running ||= panel.subs.some(sub => sub.state === 'running') ? panel.subs : null
      }

      if (!ended) {
        await sleep(200)
      }
    }

    if (ended) {
      await shot(entry, 'p4-subagent-done')
    }

    entry.evidence.subAgentEndedAfterTurn = ended
    await quiet()

    const end = await readPanel()
    const events = await debugEvents()

    entry.evidence.eventTypes = keepEvents('p4', events)
    entry.evidence.subagentPayloads = events.filter(event => event.type.startsWith('subagent.')).map(event => `${event.type} {${event.keys}}`)
    entry.evidence.timeline = [...new Set(seen)].slice(0, 30)
    entry.evidence.final = end.subs
    entry.evidence.finalRows = end.rows.map(row => `${row.kind} ${row.label} ${row.state}`)
    entry.evidence.modelRequests = requests.slice(-8)

    // The report wakes the chat into a new turn; the finished helper is shown
    // in the turn it ran in, so judge the last state the rows were seen in.
    const last = seenSubs.at(-1) ?? []

    must(last.length === 1, `${last.length} sub-agent rows, expected 1`)
    must(last[0]?.bot, 'the sub-agent row has no bot face')
    must(last[0]?.title.includes('summarise the notes'), `the sub-agent row reads ${JSON.stringify(last[0]?.title)}`)
    must(last[0]?.state === 'done', `the sub-agent ended as ${last[0]?.state}`)
    must(running, 'the sub-agent was never seen running')
    must(ended, 'the sub-agent row never left the running state within 60s of the turn')
  })

  // ── p5. Approval ──
  await checkIf('p5', async (entry, must) => {
    await quiet()
    await debugEvents()
    await type(APPROVE, 'Enter')

    const card = await page
      .waitForFunction(() => {
        const node = document.querySelector('.mg-agent .mg-agent-approval')

        return node?.checkVisibility() ? node.textContent : null
      }, undefined, { polling: 100, timeout: 30_000 })
      .then(handle => handle.jsonValue())
      .catch(() => null)

    entry.evidence.hermesCardInChat = await page.evaluate(() => Boolean(document.querySelector('[data-slot="tool-approval-card"]')))
    must(card, 'no approval card in the pane within 30s')

    if (!card) {
      entry.evidence.events = keepEvents('p5', await debugEvents())
      await shot(entry, 'p5-no-card')

      return
    }

    const panel = await readPanel()

    entry.evidence.card = panel.approval
    entry.evidence.subAgentRowsInThisTurn = panel.subs.length
    must(!panel.subs.length, 'the sub-agent of an earlier turn is shown in this one')
    must(panel.approval.command.includes(APPROVAL_COMMAND), `the card shows ${JSON.stringify(panel.approval.command)}`)
    must(JSON.stringify(panel.approval.buttons) === JSON.stringify(['Deny', 'Allow']), `buttons: ${JSON.stringify(panel.approval.buttons)}`)
    entry.evidence.hermesCardId = await page.evaluate(() => document.querySelector('[data-slot="tool-approval-card"]')?.getAttribute('data-request-id') ?? null)
    must(entry.evidence.hermesCardId === panel.approval.id, `Hermes' card is for ${entry.evidence.hermesCardId}, the pane's for ${panel.approval.id}`)
    await shot(entry, 'p5-approval-card')

    const deny = page.locator('.mg-agent .mg-agent-approval button[data-mg-choice="deny"]').first()
    const box = await deny.boundingBox()

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    const gone = await page
      .waitForFunction(() => !document.querySelector('.mg-agent .mg-agent-approval'), undefined, { polling: 100, timeout: 10_000 })
      .then(() => true)
      .catch(() => false)

    must(gone, 'the pane\'s card was still there 10s after Deny')
    await done(APPROVE_DONE, 60_000).catch(() => undefined)

    const after = await readPanel()
    const chat = await page.evaluate(
      viewport => ({
        hermesCard: Boolean(document.querySelector('[data-slot="tool-approval-card"]')),
        text: (document.querySelector(viewport)?.textContent ?? '').slice(-600)
      }),
      VIEWPORT
    )

    // Hermes' card leaves with a short exit animation of its own.
    const hermesGone = await page
      .waitForFunction(() => !document.querySelector('[data-slot="tool-approval-card"]'), undefined, { polling: 100, timeout: 5000 })
      .then(() => true)
      .catch(() => false)

    await sleep(3000)
    entry.evidence.after = {
      head: after.head,
      rows: after.rows.map(row => `${row.label} ${row.state}`),
      hermesCardGoneWithin5s: hermesGone,
      hermesCardThreeSecondsLater: await page.evaluate(() => Boolean(document.querySelector('[data-slot="tool-approval-card"]')))
    }
    chat.hermesCard = !hermesGone || entry.evidence.after.hermesCardThreeSecondsLater
    const p5events = await debugEvents()

    entry.evidence.events = keepEvents('p5', p5events)
    entry.evidence.gatedResult = p5events.find(event => event.type === 'tool.complete')?.payload.slice(0, 700) ?? null
    must(/denied by user/i.test(entry.evidence.gatedResult ?? ''), 'the gated command was not reported as denied by the user')
    must(!chat.hermesCard, 'Hermes\' own approval card is still in the chat after the pane answered')
    must(chat.text.includes(APPROVE_DONE), 'the turn did not finish after the answer')
    must(after.rows.some(row => row.label === 'Terminal' && row.state !== 'running'), 'the gated terminal step is still running')
    entry.evidence.chatTail = chat.text.slice(-300)
    entry.evidence.denied = /BLOCKED|denied/i.test(JSON.stringify(entry.evidence.events)) ? 'see p5-events.json' : null
    await shot(entry, 'p5-after-deny')
  })

  // ── p6. Session switch ──
  let firstSession = null

  await checkIf('p6', async (entry, must) => {
    await quiet()

    const a = await readPanel()

    firstSession = await page.evaluate(() => window.location.hash.replace(/^#\/?/, ''))
    entry.evidence.sessionA = { hash: firstSession, runtime: a.session, steps: a.rows.length, turn: a.turn }

    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    must(
      await page
        .waitForFunction(turn => document.querySelector('.mg-agent .mg-agent-trace')?.dataset.mgTurn !== turn, a.turn, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false),
      'the pane still shows session A\'s turn after opening a new session'
    )

    const blank = await readPanel()

    entry.evidence.newSession = { empty: blank.empty, rows: blank.rows.length, runtime: blank.session }
    await type(OTHER, 'Enter')
    await done(OTHER_DONE, 60_000)
    await sleep(400)

    const b = await readPanel()
    const bHash = await page.evaluate(() => window.location.hash.replace(/^#\/?/, ''))

    entry.evidence.sessionB = { hash: bHash, rows: b.rows.map(row => `${row.label} ${row.state}`), runtime: b.session, turn: b.turn }
    must(b.session && b.session !== a.session, `the pane names runtime ${b.session}, session A was ${a.session}`)
    must(b.rows.filter(row => row.kind === 'tool').length === 1 && b.rows.some(row => row.detail.includes('other-session')), `session B's trace: ${JSON.stringify(entry.evidence.sessionB.rows)}`)
    await shot(entry, 'p6-session-b')

    await page.evaluate(id => {
      window.location.hash = `#/${id}`
    }, firstSession)

    const back = await page
      .waitForFunction(turn => document.querySelector('.mg-agent .mg-agent-trace')?.dataset.mgTurn === turn, a.turn, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    const again = await readPanel()

    entry.evidence.backToA = { rows: again.rows.length, runtime: again.session, turn: again.turn }
    must(back, `back in session A the pane shows turn ${again.turn}, expected ${a.turn}`)
    must(again.rows.length === a.rows.length, `session A had ${a.rows.length} rows, now ${again.rows.length}`)
    must(again.rows.every(row => !row.isNew), 'rows replayed their arrival animation on switching back')
    await shot(entry, 'p6-back-to-a')
  })

  // ── p7. 200 steps ──
  await checkIf('p7', async (entry, must) => {
    // A frame log in the page: every frame's gap, and long tasks.
    const startProbe = () =>
      page.evaluate(() => {
        const probe = { frames: [], long: [], on: true }
        let last = performance.now()
        const loop = now => {
          probe.frames.push(now - last)
          last = now

          if (probe.on) {
            requestAnimationFrame(loop)
          }
        }

        requestAnimationFrame(loop)

        try {
          probe.observer = new PerformanceObserver(list => list.getEntries().forEach(item => probe.long.push(Math.round(item.duration))))
          probe.observer.observe({ type: 'longtask', buffered: false })
        } catch {
          probe.observer = null
        }

        window.__mgFrames = probe
      })

    const stopProbe = () =>
      page.evaluate(() => {
        const probe = window.__mgFrames

        probe.on = false
        probe.observer?.disconnect()

        const frames = probe.frames.slice(1).sort((x, y) => x - y)
        const at = q => Math.round(frames[Math.min(frames.length - 1, Math.floor(q * frames.length))] ?? 0)

        return {
          frames: frames.length,
          longTasks: probe.long.length,
          longTaskMs: probe.long.reduce((sum, ms) => sum + ms, 0),
          max: Math.round(frames.at(-1) ?? 0),
          over50: frames.filter(ms => ms > 50).length,
          p50: at(0.5),
          p95: at(0.95)
        }
      })

    const turnOf = async label => {
      await page.evaluate(() => {
        window.location.hash = '#/'
      })
      await sleep(1500)
      await startProbe()

      const started = Date.now()
      // MG_PANEL_PROFILE=1: a CPU profile of the turn, self time summed by
      // function, so the pane's per-event work can be read (evidence only).
      const profiling = process.env.MG_PANEL_PROFILE === '1'

      if (profiling) {
        await state.cdp.send('Profiler.enable')
        await state.cdp.send('Profiler.setSamplingInterval', { interval: 200 })
        await state.cdp.send('Profiler.start')
      }

      await type(MANY.replace('Two hundred', `Two hundred, ${label}`), 'Enter')
      await done(MANY_DONE, 240_000)

      const stats = await stopProbe()

      if (profiling) {
        const { profile } = await state.cdp.send('Profiler.stop')
        const byId = new Map(profile.nodes.map(node => [node.id, node]))
        const self = new Map()
        const gaps = profile.timeDeltas ?? []

        profile.samples.forEach((id, i) => {
          const node = byId.get(id)
          const f = node.callFrame
          const key = `${f.functionName || '(anon)'} ${(f.url || '').split('/').pop().slice(0, 40)}:${f.lineNumber + 1}`

          self.set(key, (self.get(key) ?? 0) + (gaps[i] ?? 0) / 1000)
        })

        const top = [...self].filter(([key]) => !/^\((idle|program|garbage collector)\)/.test(key)).sort((a, b) => b[1] - a[1])
        const ours = top.filter(([key]) => /plugin|monograph|blob/i.test(key))

        entry.evidence[`profile_${label}`] = {
          oursMs: Math.round(ours.reduce((sum, [, ms]) => sum + ms, 0)),
          ours: ours.slice(0, 15).map(([key, ms]) => `${Math.round(ms)}ms ${key}`),
          top: top.slice(0, 12).map(([key, ms]) => `${Math.round(ms)}ms ${key}`)
        }
      }

      return { ...stats, seconds: Math.round((Date.now() - started) / 100) / 10 }
    }

    // A timeline trace of a run, summed by event: where the frame time goes
    // (script, style, layout, paint), with the biggest layouts named.
    const traced = async label => {
      const events = []
      const onData = data => events.push(...data.value)

      state.cdp.on('Tracing.dataCollected', onData)
      await state.cdp.send('Tracing.start', {
        // (Invalidation tracking names the culprits but slows every frame
        // tenfold; it is left out so the numbers stand.)
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
        transferMode: 'ReportEvents'
      })

      const stats = await turnOf(label)
      const complete = new Promise(resolve => state.cdp.once('Tracing.tracingComplete', resolve))

      await state.cdp.send('Tracing.end')
      await complete
      state.cdp.off('Tracing.dataCollected', onData)

      const main = events.filter(event => event.ph === 'X' && event.dur)
      const sum = {}

      for (const event of main) {
        if (['UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'FunctionCall', 'EvaluateScript', 'ParseHTML', 'HitTest', 'ScheduleStyleRecalculation', 'RecalculateStyles', 'UpdateLayerTree', 'Commit', 'RunTask'].includes(event.name)) {
          sum[event.name] = (sum[event.name] ?? 0) + event.dur / 1000
        }
      }

      const layouts = main
        .filter(event => event.name === 'Layout')
        .sort((x, y) => y.dur - x.dur)
        .slice(0, 5)
        .map(event => `${Math.round(event.dur / 1000)}ms dirty ${event.args?.beginData?.dirtyObjects ?? '?'}/${event.args?.beginData?.totalObjects ?? '?'} partial=${event.args?.beginData?.partialLayout ?? '?'}`)
      const styles = main
        .filter(event => event.name === 'UpdateLayoutTree')
        .sort((x, y) => y.dur - x.dur)
        .slice(0, 5)
        .map(event => `${Math.round(event.dur / 1000)}ms elements ${event.args?.elementCount ?? '?'}`)

      // What asks for style work: invalidation reasons and the nodes named.
      const reasons = {}

      for (const event of events) {
        if (/Invalidat/.test(event.name)) {
          const data = event.args?.data ?? {}
          const key = `${event.name}: ${data.reason ?? data.changedAttribute ?? data.changedClass ?? data.changedId ?? data.selectors?.[0]?.selector ?? '?'} @ ${String(data.nodeName ?? '').slice(0, 60)}`

          reasons[key] = (reasons[key] ?? 0) + 1
        }
      }

      const invalidations = Object.entries(reasons).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([key, count]) => `${count}x ${key}`)

      // Stalls: long tasks with next to nothing traced inside them (the
      // renderer descheduled or collecting garbage while six rig windows and
      // other agents load the machine). They hit pane-closed runs as often as
      // pane-open ones, so they are reported, and judged apart from tasks
      // whose time is the page's own work.
      const inner = task => main.filter(event => event !== task && event.name !== 'RunTask' && event.tid === task.tid && event.ts >= task.ts && event.ts + event.dur <= task.ts + task.dur)
      const own = task => {
        // Top-level children only: nested events would count twice.
        const list = inner(task).sort((x, y) => x.ts - y.ts)
        let end = 0
        let sum = 0

        for (const event of list) {
          if (event.ts >= end) {
            sum += event.dur
            end = event.ts + event.dur
          }
        }

        return sum
      }
      // A task's own CPU time (tdur) against its wall time (dur): a renderer
      // that was descheduled shows a long dur and a short tdur. Without tdur
      // in the trace, the share of the task covered by traced work.
      const heavy = main
        .filter(event => event.name === 'RunTask' && event.dur >= 50_000)
        .map(task => ({ cpu: Number.isFinite(task.tdur), ms: task.dur / 1000, share: Number.isFinite(task.tdur) ? task.tdur / task.dur : own(task) / task.dur }))
      const stalls = heavy.filter(task => task.share < 0.5)
      const worked = heavy.filter(task => task.share >= 0.5)

      // The longest tasks, and what each was made of: the work inside it by
      // event name, scripts by file and function. This names a long frame.
      const tasks = main.filter(event => event.name === 'RunTask').sort((x, y) => y.dur - x.dur).slice(0, 3)
      const longest = tasks.map(task => {
        const inside = main.filter(event => event !== task && event.tid === task.tid && event.ts >= task.ts && event.ts + event.dur <= task.ts + task.dur)
        const parts = {}

        for (const event of inside) {
          const data = event.args?.data ?? {}
          const name = event.name === 'FunctionCall' || event.name === 'EvaluateScript' ? `${event.name} ${String(data.url ?? '').replace(/^.*\//, '').slice(0, 40)}:${data.lineNumber ?? '?'} ${data.functionName ?? ''}` : event.name

          parts[name] = (parts[name] ?? 0) + event.dur / 1000
        }

        return `${Math.round(task.dur / 1000)}ms at +${Math.round((task.ts - (main[0]?.ts ?? task.ts)) / 1000)}ms: ${Object.entries(parts).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([name, ms]) => `${name} ${Math.round(ms)}ms`).join(', ')}`
      })

      return { ...stats, invalidations, longest, maxTask: Math.round(Math.max(0, ...worked.map(task => task.ms))), stallMs: Math.round(stalls.reduce((sum, task) => sum + task.ms, 0)), stalls: stalls.length, stallBy: heavy.some(task => task.cpu) ? 'thread time' : 'traced share', workedMs: Math.round(worked.reduce((sum, task) => sum + task.ms, 0)), timeline: Object.fromEntries(Object.entries(sum).map(([name, ms]) => [name, Math.round(ms)])), topLayouts: layouts, topStyles: styles }
    }

    // Closed, open, closed: the open run is judged against both closed ones.
    if ((await readPanel()).open) {
      await surfacesRow('Agent')
    }

    must(await waitPanel(false), 'could not close the pane for the baseline run')

    const closed = await traced('pane closed')

    await surfacesRow('Agent')
    must(await waitPanel(true), 'could not open the pane again')

    // MG_PANEL_PLANT=1: three 400 ms busy tasks in the open run, to prove
    // the judgement below still catches the page's own long work.
    if (process.env.MG_PANEL_PLANT === '1') {
      await page.evaluate(() => [3000, 6000, 9000].forEach(at => setTimeout(() => {
        const end = performance.now() + 400

        while (performance.now() < end) {
          // busy on purpose
        }
      }, at)))
    }

    const open = await traced('pane open')
    const openSession = await page.evaluate(() => window.location.hash)

    await surfacesRow('Agent')
    await waitPanel(false)

    // The reference: bare Hermes (Monograph unloaded for this turn), the
    // limit any relaxed budget is held to (w3-common.md, rule 2).
    await hotReload({ gone: true, source: stubPlugin() })
    await sleep(800)

    const closedAgain = await traced('bare Hermes')

    await hotReload()
    await page.waitForSelector('[data-tour="mg-surfaces"] .mg-surfaces-hit', { timeout: 30_000 })
    // Back to the turn the pane saw.
    await page.evaluate(hash => {
      window.location.hash = hash
    }, openSession)
    await sleep(1500)

    await surfacesRow('Agent')
    await waitPanel(true)
    await sleep(1000)
    entry.evidence.bareHermes = closedAgain

    const panel = await readPanel()
    const dom = await page.evaluate(() => document.querySelectorAll('.mg-agent .mg-agent-step').length)

    entry.evidence.paneClosed = closed
    entry.evidence.paneOpen = open
    entry.evidence.pane = { domRows: dom, earlier: panel.earlier, head: panel.head, lastRow: panel.rows.at(-1) }
    entry.evidence.budget =
      'pane open, against the same launch: p95 frame <= max(50ms, 1.1x bare Hermes); longest task with work in it <= max(250ms, 1.5x the worst of pane closed and bare); time in long tasks with work in them <= 1.5x the worst of those + 500ms. Stalls (long tasks whose thread time is under half their wall time: the renderer was descheduled) are reported, not judged. Run order: pane closed, pane open, bare Hermes'

    const tools = await page.evaluate(() => Number((document.querySelector('.mg-agent .mg-agent-count')?.textContent ?? '').match(/\d+/)?.[0] ?? 0))

    entry.evidence.stepCount = tools
    must(tools === 200, `the header counts ${tools} steps, expected 200`)
    must(dom <= 30, `${dom} step rows in the page; the list should cap at 30 plus the "earlier" line`)
    must(/^\d+ earlier steps$/.test(panel.earlier), `the "earlier" line reads ${JSON.stringify(panel.earlier)}`)
    entry.evidence.judged = {
      order: 'pane closed, pane open, bare Hermes',
      p95: [closed.p95, open.p95, closedAgain.p95],
      maxTask: [closed.maxTask, open.maxTask, closedAgain.maxTask],
      workedMs: [closed.workedMs, open.workedMs, closedAgain.workedMs],
      stallMs: [closed.stallMs, open.stallMs, closedAgain.stallMs],
      rawMaxFrame: [closed.max, open.max, closedAgain.max]
    }
    must(open.p95 <= Math.max(50, 1.1 * closedAgain.p95), `p95 frame ${open.p95}ms with the pane open, ${closedAgain.p95}ms on bare Hermes (${closed.p95}ms with the pane closed)`)
    must(open.maxTask <= Math.max(250, 1.5 * Math.max(closed.maxTask, closedAgain.maxTask)), `longest task with work in it ${open.maxTask}ms with the pane open, ${closed.maxTask}ms and ${closedAgain.maxTask}ms closed`)
    const baseline = Math.max(closed.workedMs, closedAgain.workedMs)

    must(open.workedMs <= baseline * 1.5 + 500, `long-task work ${open.workedMs}ms with the pane open, ${closed.workedMs}ms and ${closedAgain.workedMs}ms closed`)
    await shot(entry, 'p7-200-steps')

    // "N earlier steps" opens the rest with a click.
    const earlier = page.locator('.mg-agent .mg-agent-earlier button').first()

    await earlier.scrollIntoViewIfNeeded().catch(() => undefined)

    const box = await earlier.boundingBox()

    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(400)
      entry.evidence.rowsAfterEarlier = await page.evaluate(() => document.querySelectorAll('.mg-agent .mg-agent-step').length)
      must(entry.evidence.rowsAfterEarlier === 200, `after "earlier steps" ${entry.evidence.rowsAfterEarlier} rows, expected 200`)
    }
  })

  // ── p8. Page reload ──
  await checkIf('p8', async (entry, must) => {
    await page.evaluate(id => {
      window.location.hash = `#/${id}`
    }, firstSession)
    await sleep(2000)

    const before = await readPanel()

    await page.reload()
    await waitForAppReady({ app, page }, 60_000)
    must(await waitPanel(true, 15_000), 'the pane did not come back after the reload')
    await page.waitForFunction(() => document.querySelector('.mg-agent .mg-agent-trace'), undefined, { timeout: 15_000 }).catch(() => undefined)
    await sleep(1500)

    const after = await readPanel()
    const sig = panel => (panel.rows ?? []).map(row => `${row.kind}:${row.label}:${row.state}`).join('|')

    entry.evidence.before = { head: before.head, rows: before.rows.length, runtime: before.session }
    entry.evidence.after = { count: after.count, head: after.head, rows: after.rows.length, runtime: after.session, animated: after.rows.filter(row => row.isNew).length }
    must(after.count === 1, `${after.count} panes after the reload`)
    must(before.rows.length > 0, 'nothing to compare: the pane showed no rows before the reload')
    must(sig(after) === sig(before), `the trace changed over the reload: ${sig(before)} → ${sig(after)}`)
    must(after.head === before.head, `the header read ${JSON.stringify(before.head)}, now ${JSON.stringify(after.head)}`)
    must(!after.rows.some(row => row.isNew), 'restored rows played their arrival animation')
    await shot(entry, 'p8-after-reload')

    // Again without the window's own copy: the trace has to come back from
    // the gateway's replay ring (session.events.since) alone. The ring keeps
    // no times, so only steps and states are compared.
    await page.evaluate(() => window.sessionStorage.removeItem('hermes.plugin.monograph.agent'))
    await page.reload()
    await waitForAppReady({ app, page }, 60_000)
    await waitPanel(true, 15_000)
    await page.waitForFunction(() => document.querySelector('.mg-agent .mg-agent-trace'), undefined, { timeout: 15_000 }).catch(() => undefined)
    await sleep(1500)

    const ring = await readPanel()

    entry.evidence.hydrate = (await debugEvents()).filter(event => event.type === 'hydrate')

    const replay = entry.evidence.hydrate.find(item => 'count' in item)

    entry.evidence.fromRingOnly = { empty: ring.empty, head: ring.head, rows: ring.rows.map(row => `${row.kind}:${row.label}:${row.state} ${row.time}`) }

    if (replay?.count) {
      must(sig(ring) === sig(before), `rebuilt from the ring: ${sig(ring)}, before: ${sig(before)}`)
    } else {
      // The gateway kept nothing to replay (count 0, truncated): the pane must
      // say it has nothing, not show a wrong or half trace.
      results.observations.push(`p8: after a reload without the window's copy, session.events.since returned ${JSON.stringify(replay)}; the trace cannot be rebuilt from the gateway here.`)
      must(!ring.rows.length && /No steps seen/.test(ring.empty), `with nothing to replay the pane shows ${JSON.stringify(entry.evidence.fromRingOnly)}`)
    }

    await shot(entry, 'p8-reload-without-copy')
  })


  // ── p11. Plan card ──
  await checkIf('p14', async (entry, must) => {
    await quiet()

    if (!(await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(true)
    }

    await debugEvents()
    // Playwright's pageerror flattens a thrown non-Error (or a rejection with
    // no reason) to an empty line. Record what was really thrown, in the page.
    await page.evaluate(() => {
      const describe = value => {
        let kind = typeof value
        let text = ''

        try {
          kind = value === null ? 'null' : value instanceof Error ? `Error:${value.name}` : (value?.constructor?.name ?? typeof value)
          text = value instanceof Error ? value.message : JSON.stringify(value)?.slice(0, 300) ?? String(value)
        } catch {
          text = String(value)
        }

        return { kind, stack: String(value?.stack ?? new Error('probe').stack).slice(0, 1500), text }
      }

      window.__mgRigErrors = []
      window.__mgRigErrorStop?.()

      const onError = event => window.__mgRigErrors.push({ at: Date.now(), source: `${event.filename ?? ''}:${event.lineno ?? ''}`, type: 'error', ...describe(event.error ?? event.message) })
      const onReject = event => window.__mgRigErrors.push({ at: Date.now(), type: 'unhandledrejection', ...describe(event.reason) })

      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onReject)
      window.__mgRigErrorStop = () => {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onReject)
      }
    })
    await type(BRIDGE, 'Enter')

    // Hermes folds a finished turn's work away; the rows are read while the
    // turn runs, the longest list seen kept (rows only ever get added).
    let chat = []
    let runningHtml = null
    const seenRows = new Map()
    const runningRows = new Map()
    let finished = false
    const started = Date.now()

    done(BRIDGE_DONE, 120_000).then(
      () => (finished = true),
      () => (finished = true)
    )

    while (!finished && Date.now() - started < 120_000) {
      // Rows come and go while Hermes regroups a streaming turn: keep every
      // row seen, in the order first seen, in the last state seen. A running
      // row (spinner, "Running …") is the same row as the one it becomes.
      for (const row of await readChatRows()) {
        const running = /^[\u2800-\u28ff\s]*Running\s/.test(row.title)
        // The key: the title without the spinner, "Running", the time and
        // the result count Hermes adds when the call ends ("3 items").
        const key = row.title
          .replace(/^[\u2800-\u28ff\s]*(Running\s+)?/, '')
          .replace(/\s*[\d.]+m?s$/, '')
          .replace(/\s*\d+\s+(items?|match(es)?|results?)$/, '')
          .toLowerCase()

        if (running) {
          runningRows.set(key, { ...row, samples: (runningRows.get(key)?.samples ?? 0) + 1 })
        }

        seenRows.set(key, row)
      }

      chat = [...seenRows.values()]
      runningHtml ||= await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-slot="tool-block"][data-tool-row]')].find(node => /Running/.test(node.textContent))

        return row ? row.outerHTML.replace(/ class="[^"]*"/g, '').slice(0, 1500) : null
      })
      await sleep(100)
    }

    await sleep(800)

    // The finished turn is folded: open it with a real click and read again.
    const head = page.locator(`${VIEWPORT} [data-mg-steps]`).last()
    const headBox = await head.boundingBox().catch(() => null)

    if (headBox) {
      await page.mouse.click(headBox.x + headBox.width / 2, headBox.y + headBox.height / 2)
      await sleep(600)
    }

    entry.evidence.runningRows = [...runningRows.values()].map(row => `${row.service ?? `(${row.family})`} x${row.samples} ${row.title.replace(/^[\u2800-\u28ff]+/, '')}`)
    entry.evidence.runningHtml = runningHtml
    entry.evidence.chatOpened = (await readChatRows()).map(row => `${row.service ?? `(${row.family})`} ${row.title}`)

    await shot(entry, 'p14-chat-open')

    const end = await readPanel()
    const events = await debugEvents()

    entry.evidence.eventTypes = keepEvents('p14', events)
    entry.evidence.toolEvents = events.filter(event => /^(tool\.(start|complete)|todo\.)/.test(event.type)).map(event => `${event.type} ${event.payload.slice(0, 220)}`)
    entry.evidence.chatRows = chat.map(row => `${row.service ?? `(${row.family})`} ${row.title}`)
    entry.evidence.trace = end.rows.filter(row => row.kind === 'tool').map(row => `${row.service ?? '-'} ${row.label} "${row.detail.slice(0, 40)}" ${row.state}`)
    entry.evidence.todo = end.todo
    await shot(entry, 'p14-bridged-trace')

    // One row seen under two titles (running, then done with a result line)
    // is one row: consecutive repeats of a service collapse.
    const chatServices = chat.map(row => row.service).filter((service, index, list) => service && service !== list[index - 1])
    const traceRows = end.rows.filter(row => row.kind === 'tool')
    const traceServices = traceRows.map(row => row.service).filter(Boolean)

    must(JSON.stringify(chatServices) === JSON.stringify(SERVICES_IN_ORDER), `chat rows draw ${JSON.stringify(chatServices)}, expected ${JSON.stringify(SERVICES_IN_ORDER)}`)
    must(JSON.stringify(traceServices) === JSON.stringify(SERVICES_IN_ORDER), `trace rows draw ${JSON.stringify(traceServices)}, expected ${JSON.stringify(SERVICES_IN_ORDER)}`)

    // While it runs a row already shows its service (Hermes' spinner beside it).
    // Judged on rows seen running in two samples or more (a row that ran for
    // a few milliseconds can be sampled before the next frame marks it).
    const runningServices = [...runningRows.values()].filter(row => row.samples >= 2 && !/search(ing)? tools|tool details/i.test(row.title))

    must(runningServices.length >= 4 && runningServices.every(row => row.service), `running rows without their logo: ${JSON.stringify(entry.evidence.runningRows)}`)

    // tool_search and tool_describe: a quiet glyph, never a brand.
    const bridges = chat.filter(row => /search(ing)? tools|tool details|tool search|tool describe/i.test(row.title))

    must(bridges.length === 2 && bridges.every(row => !row.service && row.family), `tool_search / tool_describe rows in the chat: ${JSON.stringify(bridges)}`)

    const quietTrace = traceRows.filter(row => /tools?\b/i.test(row.label) && !row.service)

    must(quietTrace.length >= 2, `tool_search / tool_describe rows in the trace: ${JSON.stringify(entry.evidence.trace)}`)

    // No row is named after the bridge itself.
    must(!chat.some(row => /^tool call\b/i.test(row.title)), `a chat row reads "Tool call": ${JSON.stringify(chat.map(row => row.title))}`)
    must(!traceRows.some(row => /^tool[ _]call$/i.test(row.label)), `a trace row reads "Tool call": ${JSON.stringify(traceRows.map(row => row.label))}`)

    // The failed inner call fails on its own row.
    const failedRow = traceRows.find(row => row.service === 'cloudflare')

    must(failedRow?.state === 'failed', `the failing cloudflare call reads ${failedRow?.state}`)

    // An inner todo_list fills the plan card.
    must(end.todo?.items.some(item => item.includes('Bridged plan item')), `the bridged todo_list did not reach the plan card: ${JSON.stringify(end.todo)}`)

    // What was thrown during the turn, as the page saw it (the console line
    // can be empty). Shown, not judged here: the harness judges the console.
    entry.evidence.pageErrors = await page.evaluate(() => {
      window.__mgRigErrorStop?.()

      return window.__mgRigErrors ?? []
    })
  })

  await checkIf('p11', async (entry, must) => {
    await quiet()

    if (!(await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(true)
    }

    await type(TODO, 'Enter')

    const seen = []
    const started = Date.now()
    let finished = false

    done(TODO_DONE, 120_000).then(
      () => (finished = true),
      () => (finished = true)
    )

    while (!finished && Date.now() - started < 120_000) {
      const panel = await readPanel()

      if (panel.todo) {
        seen.push(`r${panel.todo.revision} ${panel.todo.count} [${panel.todo.items.map(item => item.split(':')[0]).join(',')}]`)
      }

      await sleep(150)
    }

    await sleep(800)

    const end = await readPanel()

    entry.evidence.timeline = [...new Set(seen)]
    entry.evidence.modelRequests = requests.slice(-8)
    entry.evidence.todoEvents = await page.evaluate(() => (window.__mgAgentEvents ?? []).filter(item => /todo/.test(JSON.stringify(item))).slice(-6)).catch(() => null)
    entry.evidence.eventTypes = keepEvents('p11', await page.evaluate(() => (window.__mgAgentEvents ?? []).slice(-200)).catch(() => []))
    entry.evidence.final = end.todo
    entry.evidence.steps = end.rows.map(row => `${row.label}:${row.state}`)
    await shot(entry, 'p11-plan-card')
    must(end.todo, 'no plan card after a turn that wrote a todo list')
    must(end.todo?.cards === 1, `${end.todo?.cards} plan cards`)
    must(end.todo?.items.length === PLAN.length, `${end.todo?.items.length} items, expected ${PLAN.length}`)
    must(/^2 of 7 done/.test(end.todo?.count ?? ''), `the card reads ${end.todo?.count}`)
    must(end.todo?.items[0]?.startsWith('completed:Read the brief') && end.todo?.items[2]?.startsWith('in_progress:Draft'), `items: ${JSON.stringify(end.todo?.items)}`)
    must(new Set(entry.evidence.timeline).size >= 2, 'the card never changed while the turn ran')
    must(end.rows.some(row => row.state === 'failed'), 'the failing tool did not show as failed in the trace')
    // The bridged todo_list whose arguments fail the schema check: the
    // gateway sends only tool.generating for it (p11-events.json), never a
    // start. It must still read as a failed step, not vanish.
    entry.evidence.refused = end.rows.filter(row => /refused/i.test(row.label)).map(row => `${row.label}:${row.state}`)
    must(entry.evidence.refused.length >= 1 && entry.evidence.refused.every(row => row.endsWith(':failed')), `the refused bridged call is not a failed step: ${JSON.stringify(entry.evidence.steps)}`)
    // The todo call with no list failed; the card did not go blank or back.
    must(!entry.evidence.timeline.some(line => / 0 of 0 /.test(line)), 'the card went blank on the failed todo call')

    // Sixty items, then a long step that is stopped.
    await type(PLAN60, 'Enter')
    await state.page.waitForFunction(() => document.querySelectorAll('.mg-agent-todo-item').length > 0 && /of 60 done/.test(document.querySelector('.mg-agent-todo .mg-agent-count')?.textContent ?? ''), null, { timeout: 60_000 }).catch(() => undefined)
    await sleep(1500)

    const long = await readPanel()

    entry.evidence.long = { count: long.todo?.count, shown: long.todo?.items.length, more: long.todo?.more, active: long.todo?.items.filter(item => item.startsWith('in_progress')) }
    await shot(entry, 'p11-plan-60')
    must(/^40 of 60 done/.test(long.todo?.count ?? ''), `60 items: the card reads ${long.todo?.count}`)
    must(long.todo && long.todo.items.length <= 14 && long.todo.items.some(item => item.startsWith('in_progress:Long plan item 41')), `60 items: shown ${long.todo?.items.length}, active ${JSON.stringify(entry.evidence.long.active)}`)
    must((long.todo?.more ?? []).some(text => /earlier|more/.test(text)), 'no way to see the rest of the list')

    const stop = state.page.locator('button[aria-label="Stop"]').first()

    entry.evidence.stopButton = await stop.count()

    if (entry.evidence.stopButton) {
      const box = await stop.boundingBox()

      await state.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    } else {
      await state.page.keyboard.press('Escape')
    }

    await state.page.waitForFunction(running => !document.querySelector(running), RUNNING, { timeout: 20_000 }).catch(() => undefined)
    await sleep(1200)

    const stopped = await readPanel()

    entry.evidence.stopped = { status: stopped.status, count: stopped.todo?.count, active: stopped.todo?.items.filter(item => /^(in_progress|stopped)/.test(item)), steps: stopped.rows.slice(-2).map(row => `${row.label}:${row.state}`) }
    await shot(entry, 'p11-plan-stopped')
    must(stopped.status === 'stopped' || stopped.status === 'failed', `the turn reads ${stopped.status} after Stop`)
    must(stopped.todo?.items.some(item => item.startsWith('stopped:Long plan item 41')), `the item in progress does not read stopped: ${JSON.stringify(entry.evidence.stopped.active)}`)
    must(/stopped/.test(stopped.todo?.count ?? ''), `the card's count does not say stopped: ${stopped.todo?.count}`)
    must(stopped.rows.at(-1)?.state === 'stopped', `the long step reads ${stopped.rows.at(-1)?.state}`)
  })

  // ── p11d. Plan card, direct path ──
  // Hermes' default defers todo_list (the model reaches it through
  // tool_call, p11 and p14). With `tools.tool_search.defer: []` it is offered
  // directly. The setting is written for a new session, then put back.
  await checkIf('p11d', async (entry, must) => {
    await quiet()

    const file = path.join(state.sandbox.hermesHome, 'config.yaml')
    const before = fs.readFileSync(file, 'utf8')

    fs.writeFileSync(file, `${before.trimEnd()}\ntools:\n  tool_search:\n    defer: []\n`)

    try {
      await page.evaluate(() => {
        window.location.hash = '#/'
      })
      await sleep(1500)

      if (!(await readPanel()).open) {
        await surfacesRow('Agent')
        await waitPanel(true)
      }

      await debugEvents()
      await type(DIRECT, 'Enter')

      const seen = []
      const started = Date.now()
      let finished = false

      done(DIRECT_DONE, 120_000).then(
        () => (finished = true),
        () => (finished = true)
      )

      while (!finished && Date.now() - started < 120_000) {
        const panel = await readPanel()

        if (panel.todo) {
          seen.push(`r${panel.todo.revision} ${panel.todo.count}`)
        }

        await sleep(100)
      }

      await sleep(800)

      const end = await readPanel()
      const events = await debugEvents()
      const mine = requests.filter(request => request.user.includes('MG_PANEL_DIRECTTODO'))

      entry.evidence.offered = [...new Set(mine.map(request => request.direct))]
      entry.evidence.eventTypes = keepEvents('p11d', events)
      entry.evidence.todoEvents = events.filter(event => /todo/.test(event.payload) && /^(tool\.(start|complete)|todo\.)/.test(event.type)).map(event => `${event.type} ${event.payload.slice(0, 160)}`)
      entry.evidence.timeline = [...new Set(seen)]
      entry.evidence.final = end.todo
      entry.evidence.steps = end.rows.map(row => `${row.label}:${row.state}`)
      await shot(entry, 'p11d-direct-plan')
      must(entry.evidence.offered.some(names => names.split(',').includes('todo_list')), `todo_list was not offered directly to the model: ${JSON.stringify(entry.evidence.offered)}`)
      must(events.some(event => event.type === 'tool.start' && /"name":"todo_list"/.test(event.payload) && !/"name":"tool_call"/.test(event.payload)), 'no direct todo_list call in the events')
      must(end.todo?.cards === 1 && /^1 of 7 done/.test(end.todo.count), `the card reads ${end.todo?.count}`)
      must(end.todo?.items[1]?.startsWith('in_progress:Collect'), `items: ${JSON.stringify(end.todo?.items)}`)
      must(!entry.evidence.timeline.some(line => / 0 of 0 /.test(line)), 'the card went blank on the failed todo call')
      must(end.rows.some(row => row.state === 'failed'), 'the failed todo call is not shown as failed in the trace')
    } finally {
      fs.writeFileSync(file, before)
    }
  })

  // ── p12. Sub-agent trace ──
  await checkIf('p12', async (entry, must) => {
    await quiet()
    await type(SUB60, 'Enter')
    await done(SUB60_DONE, 120_000).catch(() => undefined)

    // The helper runs in the background: wait for its row to finish.
    let row = null

    for (const until = Date.now() + 90_000; Date.now() < until; ) {
      const panel = await readPanel()

      row = panel.subs.find(sub => sub.title.includes('sixty steps')) ?? null

      if (row && row.state !== 'running') {
        break
      }

      await sleep(300)
    }

    entry.evidence.row = row
    must(row, 'no row for the long sub-agent')

    const button = state.page.locator('.mg-agent-sub-open', { hasText: 'sixty steps' }).last()

    if (await button.count()) {
      const box = await button.boundingBox()

      await state.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(500)
    }

    const opened = await readPanel()

    entry.evidence.subtrace = opened.subtrace
    await shot(entry, 'p12-subagent-trace')
    must(opened.subtrace, 'a click on the sub-agent row did not open its trace')
    must(opened.subtrace?.goal.includes('sixty steps'), `the sub-trace is of ${opened.subtrace?.goal}`)
    must(opened.subtrace && opened.subtrace.steps >= 30 && opened.subtrace.steps <= 31, `the sub-trace draws ${opened.subtrace?.steps} rows (expected 30 and an earlier line)`)
    must(/^30 earlier steps$/.test(opened.subtrace?.earlier ?? ''), `the earlier line reads ${opened.subtrace?.earlier}`)
    must(!(opened.subtrace?.states ?? []).includes('running') || row?.state === 'running', `steps still running in a finished sub-agent: ${opened.subtrace?.states}`)

    // Keyboard: focus is on Back; Escape returns to the trace and to the row.
    entry.evidence.focusAfterOpen = await state.page.evaluate(() => document.activeElement?.className ?? '')
    must(/mg-agent-back/.test(entry.evidence.focusAfterOpen), `focus after opening is on ${entry.evidence.focusAfterOpen}`)
    await state.page.keyboard.press('Escape')
    await sleep(400)

    const back = await readPanel()

    entry.evidence.afterEscape = { subtrace: Boolean(back.subtrace), subs: back.subs.length, focus: await state.page.evaluate(() => document.activeElement?.className ?? '') }
    must(!back.subtrace && back.subs.length >= 1, 'Escape did not return to the trace')
    must(/mg-agent-sub-open/.test(entry.evidence.afterEscape.focus), `focus after Escape is on ${entry.evidence.afterEscape.focus}`)

    // Enter on the row opens it again; Back (a real click) returns.
    await state.page.keyboard.press('Enter')
    await sleep(400)
    must((await readPanel()).subtrace, 'Enter on the row did not open the sub-trace')

    const backButton = state.page.locator('.mg-agent-back').first()
    const backBox = await backButton.boundingBox()

    entry.evidence.backButton = await state.page.evaluate(() => {
      const node = document.querySelector('.mg-agent-back')
      const rect = node?.getBoundingClientRect()
      const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null

      return rect ? { at: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`, hit: hit?.closest('button')?.className ?? hit?.tagName ?? null } : null
    })
    await state.page.evaluate(() => {
      const log = (window.__mgFocusLog = [])
      const note = event => log.push(`${event.type} ${event.target?.className || event.target?.tagName || '?'}`.slice(0, 60))

      window.__mgFocusOff?.()
      document.addEventListener('focusin', note, true)
      document.addEventListener('focusout', note, true)
      window.__mgFocusOff = () => {
        document.removeEventListener('focusin', note, true)
        document.removeEventListener('focusout', note, true)
      }
    })
    await state.page.mouse.click(backBox.x + backBox.width / 2, backBox.y + backBox.height / 2)
    await sleep(400)
    entry.evidence.focusLog = await state.page.evaluate(() => {
      window.__mgFocusOff?.()

      return window.__mgFocusLog
    })
    must(!(await readPanel()).subtrace, `Back did not return to the trace (Back at ${JSON.stringify(entry.evidence.backButton)})`)
    entry.evidence.focusAfterBack = await state.page.evaluate(() => `${document.activeElement?.className ?? ''} ${document.activeElement?.textContent?.slice(0, 40) ?? ''}`)
    must(/mg-agent-sub-open/.test(entry.evidence.focusAfterBack) && /sixty steps/.test(entry.evidence.focusAfterBack), `focus after Back is on ${entry.evidence.focusAfterBack}`)
  })

  // ── p9. Hot reload ──
  await checkIf('p9', async (entry, must) => {
    // A sub-agent's report (p12) wakes a turn; reload once it is over.
    await quiet()

    const before = await readPanel()
    const owner = await page.evaluate(() => document.getElementById('mg-css')?.dataset.owner)

    // Same file, same inode, one more line: Hermes reloads the plugin.
    fs.appendFileSync(state.installed, `\n// rig hot reload ${Date.now()}\n`)

    const reloaded = await page
      .waitForFunction(owner => document.getElementById('mg-css')?.dataset.owner !== owner, owner, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)

    must(reloaded, 'the plugin did not reload within 20s of the file changing')
    await sleep(1500)

    const after = await readPanel()
    const extra = await page.evaluate(() => ({
      panes: document.querySelectorAll('.mg-agent').length,
      tabs: document.querySelectorAll('[data-pane-tab-id="monograph:agent"]').length
    }))

    entry.evidence.before = { head: before.head, rows: before.rows.length, turn: before.turn }
    entry.evidence.after = { ...extra, head: after.head, rows: after.rows.length }
    must(extra.panes === 1, `${extra.panes} agent panes after the hot reload`)
    must(after.rows.length === before.rows.length, `rows ${before.rows.length} → ${after.rows.length} over the hot reload`)
    await shot(entry, 'p9-after-hot-reload')

    // The menu still has exactly one Agent row, and it still closes the pane.
    const rows = await surfacesRow('Agent')

    entry.evidence.menuRows = rows
    must(rows.filter(row => row === 'AgentP').length === 1, `menu rows after the hot reload: ${rows.join(' | ')}`)
    must(await waitPanel(false), 'the Agent row did not close the pane after the hot reload')
  })


  // ── p13. Hot reload twice, then unloaded ──
  await checkIf('p13', async (entry, must) => {
    if (!(await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(true)
    }

    const count = () =>
      page.evaluate(() => ({
        panes: document.querySelectorAll('.mg-agent').length,
        todos: document.querySelectorAll('.mg-agent-todo').length,
        subs: document.querySelectorAll('.mg-agent-sub').length,
        steps: document.querySelectorAll('.mg-agent-step').length,
        tabs: document.querySelectorAll('[data-pane-tab-id="monograph:agent"]').length,
        root: Object.keys(document.documentElement.dataset).filter(key => key.startsWith('mg')).sort().join(' ')
      }))

    const reload = async source => {
      const owner = await page.evaluate(() => document.getElementById('mg-css')?.dataset.owner ?? null)

      fs.writeFileSync(state.installed, source)
      await page.waitForFunction(owner => (document.getElementById('mg-css')?.dataset.owner ?? null) !== owner, owner, { timeout: 30_000 }).catch(() => undefined)
      await sleep(1500)
    }

    const original = fs.readFileSync(state.installed, 'utf8')
    const before = await count()

    await reload(`${original}\n// rig reload a\n`)
    await reload(`${original}\n// rig reload b\n`)

    const after = await count()

    entry.evidence.before = before
    entry.evidence.afterTwoReloads = after
    must(after.panes === 1 && after.tabs <= 1, `after two reloads: ${after.panes} panes, ${after.tabs} tabs`)
    must(after.todos === before.todos && after.subs === before.subs && after.steps === before.steps, `rows changed over two reloads: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    must(after.root === before.root, `root attributes ${before.root} -> ${after.root}`)

    // Unloaded: a plugin with Monograph's id that registers nothing.
    fs.writeFileSync(state.installed, "export default { id: 'monograph', name: 'Monograph (rig stand-in)', register() {} }\n")
    await page.waitForFunction(() => !document.getElementById('mg-css'), null, { timeout: 30_000 }).catch(() => undefined)
    await sleep(1200)

    const unloaded = await count()

    entry.evidence.unloaded = unloaded
    must(!unloaded.panes && !unloaded.todos && !unloaded.tabs && !unloaded.root, `unloaded, left behind: ${JSON.stringify(unloaded)}`)

    // Back as built; the pane comes back once (it was open), then closes.
    await reload(original)
    await page.waitForSelector('[data-tour="mg-surfaces"] .mg-surfaces-hit', { timeout: 15_000 })
    await sleep(800)
    entry.evidence.back = await count()
    must(entry.evidence.back.panes <= 1, `${entry.evidence.back.panes} panes after loading again`)

    if ((await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(false)
    }
  })

  // ── p10. Nothing left ──
  // ── p15. Approval answered elsewhere, and Allow from the pane ──
  await checkIf('p15', async (entry, must) => {
    await quiet()
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(1500)

    if (!(await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(true)
    }

    const waitCard = () =>
      page
        .waitForFunction(() => Boolean(document.querySelector('.mg-agent .mg-agent-approval')?.checkVisibility()) && Boolean(document.querySelector('[data-slot="tool-approval-card"] [data-approval-deny]')), undefined, { polling: 100, timeout: 30_000 })
        .then(() => true)
        .catch(() => false)
    const cardGone = () =>
      page
        .waitForFunction(() => !document.querySelector('.mg-agent .mg-agent-approval'), undefined, { polling: 100, timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
    const press = async selector => {
      const box = await page.locator(selector).first().boundingBox()

      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      }

      return Boolean(box)
    }
    const count = (events, type) => events.filter(event => event.type === type).length

    // 1. Answered in Hermes' own card (the composer's card): ours leaves.
    await debugEvents()
    await type('Rig panel prompt, MG_PANEL_APPROVE. Answered in the chat.', 'Enter')
    must(await waitCard(), 'no approval card (pane and chat) within 30s')
    must(await press('[data-slot="tool-approval-card"] [data-approval-deny]'), 'no Deny in Hermes\' card')
    entry.evidence.elsewhere = { paneCardGone: await cardGone() }
    await done(APPROVE_DONE, 60_000).catch(() => undefined)
    await quiet()

    const first = await debugEvents()

    entry.evidence.elsewhere.events = { request: count(first, 'approval.request'), settled: count(first, 'approval.settled') }
    entry.evidence.elsewhere.result = first.filter(event => event.type === 'tool.complete').map(event => event.payload.slice(0, 160))
    must(entry.evidence.elsewhere.paneCardGone, 'the pane\'s card stayed after Hermes\' own card answered')
    must(/denied by user/i.test(first.filter(event => event.type === 'tool.complete').map(event => event.payload).join(' ')), 'the answer in Hermes\' card did not deny the command')

    // 2. Allow in the pane: Hermes' approval is answered once.
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(1500)
    await type('Rig panel prompt, MG_PANEL_APPROVE. Allowed in the pane.', 'Enter')
    must(await waitCard(), 'no approval card for the second prompt')
    await shot(entry, 'p15-approval-again')
    must(await press('.mg-agent .mg-agent-approval button[data-mg-choice="once"]'), 'no Allow in the pane\'s card')

    const paneGone = await cardGone()
    const hermesGone = await page
      .waitForFunction(() => !document.querySelector('[data-slot="tool-approval-card"]'), undefined, { polling: 100, timeout: 10_000 })
      .then(() => true)
      .catch(() => false)

    await done(APPROVE_DONE, 60_000).catch(() => undefined)
    await quiet()

    const second = await debugEvents()
    const results = second.filter(event => event.type === 'tool.complete')

    entry.evidence.fromPane = {
      hermesGone,
      paneGone,
      request: count(second, 'approval.request'),
      results: results.map(event => event.payload.slice(0, 160)),
      settled: count(second, 'approval.settled')
    }
    must(paneGone && hermesGone, `after Allow in the pane: pane card gone ${paneGone}, Hermes' card gone ${hermesGone}`)
    must(entry.evidence.fromPane.request === 1 && entry.evidence.fromPane.settled === 1, `one approval asked and settled expected: ${JSON.stringify(entry.evidence.fromPane)}`)
    must(results.length === 1 && !/denied/i.test(results[0].payload), `the allowed command did not run once: ${JSON.stringify(entry.evidence.fromPane.results)}`)
  })

  // ── p17. Approval answered in a second window ──
  // The first window runs the turn with our pane open; a second window of
  // the same app (Hermes' own door) opens that session and answers in
  // Hermes' card there. The first window is sampled every frame from the
  // press: the pane's card must leave within one sessions.changed cycle
  // (Hermes sends it at most once per 2 s, change_watcher.py, plus 500 ms),
  // and no frame may show its buttons pressable once Hermes' own card in
  // the first window has gone (an answered request: a dead button).
  await checkIf('p17', async (entry, must) => {
    const LIMIT = 2500
    await quiet()
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(1500)

    if (!(await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(true)
    }

    await debugEvents()
    await type('Rig panel prompt, MG_PANEL_APPROVE. Answered in another window.', 'Enter')

    const carded = await page
      .waitForFunction(() => Boolean(document.querySelector('.mg-agent .mg-agent-approval')?.checkVisibility()), undefined, { polling: 100, timeout: 30_000 })
      .then(() => true, () => false)

    must(carded, 'no approval card in the pane within 30 s')

    const sid = await page.evaluate(() => location.hash.replace(/^#\/?/, '').split(/[?#/]/)[0])

    entry.evidence.session = sid

    const opened = state.app.waitForEvent('window', { timeout: 20_000 }).catch(() => null)

    await page.evaluate(() => window.hermesDesktop?.openWindow?.())

    const second = await opened

    entry.evidence.secondWindow = Boolean(second)
    must(second, 'Hermes opened no second window (hermesDesktop.openWindow)')

    if (carded && second) {
      try {
        await second.waitForSelector('[data-slot="composer-root"]', { timeout: 60_000 })
        await second.evaluate(sid => {
          window.location.hash = `#/${sid}`
        }, sid)

        const deny = second.locator('[data-slot="tool-approval-card"] [data-approval-deny]').first()

        await deny.waitFor({ state: 'visible', timeout: 30_000 })
        await sleep(500)

        // Sampling in the first window, after layout each frame.
        await page.evaluate(() => {
          const rec = (window.__mgP17 = { frames: [], on: true, t0: performance.now() })
          const dummy = document.createElement('i')
          dummy.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;opacity:0'
          document.documentElement.append(dummy)
          const ro = new ResizeObserver(() => {
            const card = document.querySelector('.mg-agent .mg-agent-approval')
            const buttons = card ? [...card.querySelectorAll('button')].filter(b => b.checkVisibility() && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && getComputedStyle(b).pointerEvents !== 'none') : []
            rec.frames.push({ hermes: Boolean(document.querySelector('[data-slot="tool-approval-card"] [data-approval-deny]')), live: buttons.length, pane: Boolean(card?.checkVisibility()), t: Math.round(performance.now() - rec.t0) })
          })
          const tick = () => {
            if (!rec.on) {
              ro.disconnect()
              dummy.remove()
              return
            }
            ro.unobserve(dummy)
            ro.observe(dummy)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })

        const box = await deny.boundingBox()

        // MG_PANEL_PLANT=p17: a copy of the pane's card that nothing takes
        // away, standing in for a pane that misses the answer.
        if (process.env.MG_PANEL_PLANT === 'p17') {
          await page.evaluate(() => {
            const card = document.querySelector('.mg-agent .mg-agent-approval')

            card?.parentElement?.append(Object.assign(card.cloneNode(true), { id: 'mg-rig-plant-p17' }))
          })
        }

        await page.evaluate(() => (window.__mgP17.t0 = performance.now()))
        await second.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page
          .waitForFunction(() => !document.querySelector('.mg-agent .mg-agent-approval'), undefined, { polling: 50, timeout: 8000 })
          .catch(() => undefined)
        await sleep(400)

        const frames = await page.evaluate(() => {
          window.__mgP17.on = false
          return window.__mgP17.frames
        })
        const goneAt = frames.find(frame => !frame.pane)?.t ?? null
        const hermesGoneAt = frames.find(frame => !frame.hermes)?.t ?? null
        const dead = frames.filter(frame => !frame.hermes && frame.pane && frame.live)

        entry.evidence.frames = frames.length
        entry.evidence.paneGoneMs = goneAt
        entry.evidence.hermesCardGoneMs = hermesGoneAt
        entry.evidence.deadFrames = dead.length
        entry.evidence.deadFirst = dead[0] ?? null
        must(frames.length >= 10, `only ${frames.length} frames recorded`)
        must(goneAt !== null && goneAt <= LIMIT, `the pane's card left ${goneAt === null ? 'not within 8 s' : `after ${goneAt} ms`} (limit ${LIMIT} ms)`)
        must(!dead.length, `${dead.length} frame(s) showed the pane's buttons pressable after Hermes' own card had gone (first at ${dead[0]?.t} ms)`)
        await shot(entry, 'p17-first-window-after')
      } catch (error) {
        must(false, `second window: ${String(error.message).split('\n')[0]}`)
      }
    }

    await page.evaluate(() => document.getElementById('mg-rig-plant-p17')?.remove())
    await second?.close().catch(() => undefined)
    await done(APPROVE_DONE, 60_000).catch(() => undefined)
    await quiet()

    const events = await debugEvents()

    entry.evidence.events = { request: events.filter(e => e.type === 'approval.request').length, settled: events.filter(e => e.type === 'approval.settled').length }
    const completed = events.filter(event => event.type === 'tool.complete').map(event => event.payload)

    entry.evidence.result = completed.map(payload => payload.slice(0, 160))
    must(/denied by user/i.test(completed.join(' ')), 'the answer in the second window did not deny the command')
  })

  // ── p16. The pane's tab, Advanced mode ──
  await checkIf('p16', async (entry, must) => {
    await quiet()

    if (!(await readPanel()).open) {
      await surfacesRow('Agent')
      await waitPanel(true)
    }

    await sleep(800)

    const tab = page.locator('[data-pane-tab-id="monograph:agent"]').first()
    const alive = () => page.evaluate(() => ({ css: Boolean(document.getElementById('mg-css')), modules: document.documentElement.dataset.mgModules ?? '', pane: Boolean(document.querySelector('.mg-agent')) }))

    entry.evidence.mode = MODE
    entry.evidence.tabs = await tab.count()

    if (!entry.evidence.tabs) {
      // Alone in its zone the pane has no tab strip (Simple; Advanced in the
      // sandbox's layout). The tab appears only when it shares a zone (beside
      // Review, with a workspace), which this sandbox does not set up: the
      // flag is then not exercised here.
      entry.evidence.note = 'no tab strip for the pane in this layout; uncloseable is not exercised'
      await surfacesRow('Agent')
      must(await waitPanel(false), 'the pane did not close from the surfaces row after p16')

      return
    }

    const box = await tab.boundingBox()

    // The close gesture (middle click), then the tab's menu.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' })
    await sleep(1000)
    entry.evidence.afterMiddleClick = await alive()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await sleep(500)
    entry.evidence.menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(node => (node.textContent ?? '').trim()).filter(Boolean))
    await shot(entry, 'p16-tab-menu')
    await page.keyboard.press('Escape')
    await sleep(300)
    must(entry.evidence.afterMiddleClick.css && entry.evidence.afterMiddleClick.modules, `Monograph went off after a middle click on the pane's tab: ${JSON.stringify(entry.evidence.afterMiddleClick)}`)
    must(!entry.evidence.menu.some(text => /^Close\b/i.test(text) && !/other|all|right|left/i.test(text)), `the tab menu offers Close: ${JSON.stringify(entry.evidence.menu)}`)
    must((await alive()).css, 'Monograph is off at the end of p16')

    // Closed again for p10, from the surfaces row.
    await surfacesRow('Agent')
    must(await waitPanel(false), 'the pane did not close from the surfaces row after p16')
  })

  await checkIf('p10', async (entry, must) => {
    const left = await page.evaluate(() => ({
      attr: document.documentElement.hasAttribute('data-mg-agent-open'),
      nodes: document.querySelectorAll('[class*="mg-agent"]').length,
      tab: document.querySelectorAll('[data-pane-tab-id="monograph:agent"]').length
    }))

    entry.evidence.left = left
    must(!left.attr && !left.nodes && !left.tab, `left behind: ${JSON.stringify(left)}`)

    const errors = fs
      .readFileSync(path.join(EVIDENCE, 'renderer-console.log'), 'utf8')
      .split('\n')
      .filter(line => /^\[(error|pageerror)\]/.test(line) && /monograph|agent-panel|mg-agent/i.test(line))

    entry.evidence.consoleErrors = errors.slice(0, 10)
    must(!errors.length, `${errors.length} renderer errors that name the plugin`)
    await shot(entry, 'p10-closed')
    results.observations.push(`panel: ${state.mock.receivedPrompts.length} model completions served by the suite's model`)
  })
}
