/**
 * session-model-icons — sidebar rows get the model's logo (brand colour) and,
 * instead of "model · N messages", a preview of the last assistant reply.
 * Data: backend route /api/plugins/session-model-icons/previews (state.db).
 */
import { Codicon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, host, SESSION_ROW_AREAS, useQuery } from '@hermes/plugin-sdk'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

const ID = 'session-model-icons'
const PATHS = {"claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", "openai": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", "gemini": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81", "grok": "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z", "deepseek": "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45", "mistral": "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z", "llama": "M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"}
const COLORS = {"claude": "#D97757", "openai": "#FFFFFF", "gemini": "#8E75B2", "grok": "#FFFFFF", "deepseek": "#4D6BFE", "mistral": "#FA520F", "llama": "#0467DF"}
const RULES = [
  [/claude|anthropic|opus|sonnet|haiku|fable|mythos/i, 'claude'],
  [/gpt|openai|(^|[^a-z])o[1-9]|codex/i, 'openai'],
  [/gemini|gemma|google/i, 'gemini'],
  [/grok|xai/i, 'grok'],
  [/deepseek/i, 'deepseek'],
  [/mistral|mixtral|codestral|devstral/i, 'mistral'],
  [/llama|meta-/i, 'llama'],
]
const familyOf = m => { for (const [re, f] of RULES) if (re.test(m || '')) return f; return null }

// Batch every visible row's id into one request per animation frame.
let ctxRef = null
// Plugin backends live in the default profile; pin calls there so a focused bot
// profile (its own plugin host + state.db) never answers for the sidebar.
const apiDefault = (path, opts = {}) => window.hermesDesktop?.api
  ? window.hermesDesktop.api({ path: `/api/plugins/${ID}${path}`, profile: 'default', timeoutMs: 15000, ...opts })
  : ctxRef.rest(path)
const pending = new Map()
const cache = new Map()
let timer = null
function load(id) {
  if (cache.has(id)) return cache.get(id)
  let res, rej
  const p = new Promise((a, b) => { res = a; rej = b })
  cache.set(id, p)
  pending.set(id, [res, rej])
  if (!timer) timer = setTimeout(flush, 30)
  return p
}
async function flush() {
  timer = null
  const batch = new Map(pending); pending.clear()
  let data = null
  try {
    const ids = [...batch.keys()].map(encodeURIComponent).join(',')
    const r = await apiDefault(`/previews?ids=${ids}`)
    data = (r && (r.data ?? r)) || {}
  } catch {}
  for (const [id, [res, rej]] of batch) {
    // failure (e.g. a bot profile focused): reject so the row keeps its last logo/preview and retries
    if (data) res(data[id] || null); else { cache.delete(id); rej(new Error('previews unavailable')) }
    setTimeout(() => cache.delete(id), 20000)
  }
}
function invalidate() { cache.clear() }


// ───────────────────────── Folders + profile footer ─────────────────────────
const AVATAR = ''
const USER_NAME = 'You'
let storage = null
let folders = []
const listeners = new Set()
const info = new Map() // sessionId -> { title, model, working }
const emit = () => { listeners.forEach(l => l()); renderFolders() }
const subscribe = l => { listeners.add(l); return () => listeners.delete(l) }
const getFolders = () => folders
const save = () => { storage?.set('folders', folders); emit() }
const folderOf = id => folders.find(f => f.ids.includes(id))
const uid = () => 'f' + Math.random().toString(36).slice(2, 9)
function moveTo(id, folderId) {
  folders = folders.map(f => ({ ...f, ids: f.ids.filter(x => x !== id) }))
  if (folderId) folders = folders.map(f => (f.id === folderId ? { ...f, ids: [...f.ids, id], open: true } : f))
  save()
}
function createFolder(name, firstId) {
  const f = { id: uid(), name: name || 'New folder', open: true, ids: [] }
  folders = [...folders, f]
  if (firstId) { moveTo(firstId, f.id); return f } 
  save(); return f
}
const svgEl = (d, size = 14, fill = 'currentColor') => {
  const ns = 'http://www.w3.org/2000/svg'; const e = document.createElementNS(ns, 'svg')
  e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('width', size); e.setAttribute('height', size)
  e.style.cssText = `fill:${fill};flex-shrink:0`
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); e.appendChild(p); return e
}
const FOLDER_D = 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z'
const CHEV_D = 'M9 6l6 6-6 6'
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

function editName(span, initial, done) {
  span.contentEditable = 'true'; span.textContent = initial; span.focus()
  const r = document.createRange(); r.selectNodeContents(span); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
  const finish = ok => { span.contentEditable = 'false'; span.removeEventListener('blur', onBlur); done(ok ? span.textContent.trim() : null) }
  const onBlur = () => finish(true)
  span.addEventListener('blur', onBlur)
  span.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); span.blur() } if (e.key === 'Escape') { span.textContent = initial; span.blur() } })
}

function folderRow(id) {
  const d = info.get(id) || {}
  const row = el('div', 'mf-srow'); row.dataset.mfSid = id; if (d.working) row.dataset.working = 'true'
  row.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, sessionItems(id)) }
  const fam = familyOf(d.model)
  if (fam) row.appendChild(svgEl(PATHS[fam], 12, COLORS[fam]))
  row.appendChild(el('span', 'mf-stitle', d.title || 'Untitled'))
  row.onclick = () => host.navigate('/' + encodeURIComponent(id))
  return row
}

function renderFolderBtn() {
  const host = document.querySelector('[data-slot="sidebar"] .codicon-list-filter')?.closest('button')?.parentElement?.parentElement
  if (!host || host.querySelector('#mf-newfolder')) return
  const b = el('button'); b.id = 'mf-newfolder'; b.type = 'button'; b.title = 'New folder'; b.setAttribute('aria-label', 'New folder')
  b.appendChild(el('i', 'codicon codicon-new-folder'))
  b.addEventListener('click', e => { e.stopPropagation(); createFolder('New folder'); renderFolders() })
  host.appendChild(b)
}
function renderFolders() {
  const anchor = document.querySelector('[data-slot="sidebar"] [data-session-unpin-drop]')
  if (!anchor) return
  let box = document.getElementById('mf-folders')
  if (!box || box.nextElementSibling !== anchor) { box?.remove(); box = el('div'); box.id = 'mf-folders'; anchor.parentElement.insertBefore(box, anchor) }
  box.replaceChildren()
  if (!folders.length) { box.remove(); return }
  for (const f of folders) {
    const wrap = el('div', 'mf-folder'); wrap.dataset.folder = f.id
    const fh = el('div', 'mf-fhead')
    const chev = svgEl(CHEV_D, 12); chev.classList.add('mf-chev'); if (f.open) chev.classList.add('open')
    fh.appendChild(chev); fh.appendChild(svgEl(FOLDER_D, 13))
    const name = el('span', 'mf-name', f.name); fh.appendChild(name)
    fh.appendChild(el('span', 'mf-count', String(f.ids.length)))
    fh.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, [
      ['Rename', () => editName(name, f.name, v => { if (v) folders = folders.map(x => x.id === f.id ? { ...x, name: v } : x); save() })],
      ['New folder', () => promptNewFolder()],
      null,
      ['Delete folder', () => { folders = folders.filter(x => x.id !== f.id); save() }],
    ]) }
    fh.onclick = () => { folders = folders.map(x => x.id === f.id ? { ...x, open: !x.open } : x); save() }
    name.ondblclick = e => { e.stopPropagation(); editName(name, f.name, v => { if (v) folders = folders.map(x => x.id === f.id ? { ...x, name: v } : x); save() }) }
    // drop target for drag-from-folder rows
    wrap.appendChild(fh)
    if (f.open) {
      for (const id of f.ids) wrap.appendChild(folderRow(id))
    }
    box.appendChild(wrap)
  }
}

// Small glass menu for folder actions (folder heads, blank sidebar, folder rows)
function closeMenu() { document.getElementById('mf-menu')?.remove() }
function showMenu(x, y, items) {
  closeMenu()
  const m = el('div'); m.id = 'mf-menu'; m.setAttribute('role', 'menu')
  for (const it of items) {
    if (!it) { m.appendChild(el('div', 'mf-sep')); continue }
    const b = el('div', 'mf-item', it[0]); b.setAttribute('role', 'menuitem')
    b.onclick = e => { e.stopPropagation(); closeMenu(); it[1]() }
    m.appendChild(b)
  }
  document.body.appendChild(m)
  const r = m.getBoundingClientRect()
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px'
  setTimeout(() => { addEventListener('pointerdown', ev => { if (!m.contains(ev.target)) closeMenu() }, { once: true, capture: true }) })
  addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenu() }, { once: true })
}
function promptNewFolder(sessionId) {
  const f = createFolder('New folder', sessionId)
  requestAnimationFrame(() => {
    const n = document.querySelector(`[data-folder="${f.id}"] .mf-name`)
    n && editName(n, f.name, v => { if (v) folders = folders.map(x => x.id === f.id ? { ...x, name: v } : x); save() })
  })
}
function markManual(id) { const m = storage?.get('sorted', {}) || {}; m[id] = 'manual'; storage?.set('sorted', m) }
function sessionItems(id) {
  const cur = folderOf(id)
  return [
    ...folders.filter(f => f.id !== cur?.id).map(f => ['Move to ' + f.name, () => { markManual(id); moveTo(id, f.id) }]),
    ['New folder…', () => { markManual(id); promptNewFolder(id) }],
    cur ? ['Remove from folder', () => { markManual(id); moveTo(id, null) }] : null,
  ].filter(Boolean)
}
// Inject folder items at the top of core's session right-click menu
let ctxSid = null
let ctxBlank = false
function injectCoreMenu() {
  if (!ctxSid && !ctxBlank) return
  const menus = [...document.querySelectorAll('[data-slot="context-menu-content"]')]
  const menu = ctxSid ? menus.find(m => m.getAttribute('aria-label') === 'Session actions') : menus[menus.length - 1]
  if (!menu || menu.querySelector('.mf-inj')) return
  const items = ctxSid ? sessionItems(ctxSid) : [['New folder', () => promptNewFolder()]]
  const frag = document.createDocumentFragment()
  for (const [label, fn] of items) {
    const it = el('div', 'mf-inj mf-item', label); it.setAttribute('role', 'menuitem'); it.tabIndex = -1
    it.onclick = e => { e.stopPropagation(); fn(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
    frag.appendChild(it)
  }
  const sep = el('div', 'mf-inj mf-sep'); frag.appendChild(sep)
  menu.insertBefore(frag, menu.firstChild)
}
// Auto-file sessions with Haiku (folder-sort plugin)
async function classify(title, preview, names) {
  if (window.__mfClassify) return window.__mfClassify(title, preview, names)
  const r = await window.hermesDesktop.api({ path: '/api/plugins/session-folders/classify', method: 'POST', body: { title, preview, folders: names }, timeoutMs: 30000 })
  return (r && (r.data ?? r))?.folder ?? null
}
const sortQueue = []
let sorting = false
function queueSort(id, title, preview) {
  if (!window.hermesDesktop?.api || !folders.length || !title || /^(new session|untitled)$/i.test(title)) return
  if (folderOf(id)) return
  const sorted = storage?.get('sorted', {}) || {}
  const key = 'v2|' + title + '|' + folders.map(f => f.name).join(',')
  if (sorted[id] === 'manual' || sorted[id] === key) return
  if (sortQueue.some(q => q.id === id)) return
  sortQueue.push({ id, title, preview, key })
  if (!sorting) runSort()
}
async function runSort() {
  sorting = true
  while (sortQueue.length) {
    const q = sortQueue.shift()
    try {
      const name = await classify(q.title, q.preview || '', folders.map(f => f.name))
      const m = storage?.get('sorted', {}) || {}; m[q.id] = q.key; storage?.set('sorted', m)
      const f = name && folders.find(x => x.name === name)
      if (f && !folderOf(q.id)) moveTo(q.id, f.id)
    } catch {}
  }
  sorting = false
}

function renderFooter() {
  const inner = document.querySelector('[data-bb-left-zone]') || document.querySelector('[data-slot="sidebar-content"]') || document.querySelector('[data-slot="sidebar-inner"]')
  if (!inner) return
  let foot = document.getElementById('mf-footer')
  if (foot && foot.parentElement === inner) return
  foot?.remove()
  foot = el('div'); foot.id = 'mf-footer'
  const me = el('button', 'mf-me'); me.title = 'Settings'
  const img = el('img'); img.src = AVATAR; img.alt = ''
  if (AVATAR) me.appendChild(img); me.appendChild(el('span', '', USER_NAME))
  me.onclick = () => host.navigate('/settings')
  const conn = el('button', 'mf-conn'); conn.title = 'Install connectors'
  const ic = svgEl('M4.5 4.5h5.5v5.5H4.5zM14 4.5h5.5v5.5H14zM4.5 14h5.5v5.5H4.5zM16.75 14v5.5M14 16.75h5.5', 16, 'none')
  ic.style.stroke = 'currentColor'; ic.style.strokeWidth = '1.7'; ic.style.strokeLinecap = 'round'; ic.style.strokeLinejoin = 'round'
  conn.appendChild(ic)
  conn.onclick = () => host.navigate('/capabilities?tab=connectors')
  foot.appendChild(me); foot.appendChild(conn)
  inner.appendChild(foot)
}

function FolderMenu({ sessionId }) {
  const fs = useSyncExternalStore(subscribe, getFolders)
  const current = fs.find(f => f.ids.includes(sessionId))
  return jsx(DropdownMenu, { children: [
    jsx(DropdownMenuTrigger, { asChild: true, children: jsx('button', {
      className: 'mf-rowbtn', 'aria-label': 'Move to folder', type: 'button',
      onClick: e => e.stopPropagation(), onPointerDown: e => e.stopPropagation(),
      children: jsx(Codicon, { name: 'folder', size: '0.75rem' })
    }) }),
    jsx(DropdownMenuContent, { align: 'end', onClick: e => e.stopPropagation(), onPointerDown: e => e.stopPropagation(), children: [
      ...fs.map(f => jsx(DropdownMenuItem, { key: f.id, onSelect: () => moveTo(sessionId, f.id), children: (current?.id === f.id ? '✓ ' : '') + f.name })),
      fs.length ? jsx(DropdownMenuSeparator, {}, 'sep') : null,
      jsx(DropdownMenuItem, { onSelect: () => createFolder('New folder', sessionId), children: 'New folder…' }, 'new'),
      current ? jsx(DropdownMenuItem, { onSelect: () => moveTo(sessionId, null), children: 'Remove from folder' }, 'rm') : null,
    ] })
  ] })
}


const META_RE = /\u00b7\s*\d+\s+messages?/

function ModelLead({ sessionId }) {
  const ref = useRef(null)
  const q = useQuery({
    queryKey: [ID, sessionId],
    queryFn: () => load(sessionId),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    staleTime: 25000,
    retry: 2,
    retryDelay: 4000,
  })
  const data = q.data
  const fam = familyOf(data?.model)
  const preview = data?.preview || ''
  const fs = useSyncExternalStore(subscribe, getFolders)
  const inFolder = fs.some(f => f.ids.includes(sessionId))

  useEffect(() => {
    const row = ref.current?.closest('.row-hover')
    if (!row) return
    const outer = row.closest('li') || row
    outer.style.display = inFolder ? 'none' : ''
    const sync = () => {
      const prev = info.get(sessionId) || {}
      const domTitle = row.querySelector('.hover-marquee-inner')?.textContent?.trim()
      const next = { preview: data?.preview || prev.preview, title: domTitle || data?.title || prev.title, model: data?.model || prev.model, working: row.dataset.working === 'true' }
      if (next.title !== prev.title || next.model !== prev.model || next.working !== prev.working) { info.set(sessionId, next); if (inFolder) renderFolders() }
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(row, { attributes: true, attributeFilter: ['data-working'] })
    return () => { mo.disconnect(); outer.style.display = '' }
  }, [inFolder, data?.title, data?.model])

  useEffect(() => {
    const row = ref.current?.closest('.row-hover')
    if (!row) return
    const apply = () => {
      for (const el of row.querySelectorAll('span')) {
        if (el.children.length) continue
        const t = el.getAttribute('data-preview') !== null ? el.dataset.orig : el.textContent
        if (!t || !META_RE.test(t)) continue
        __set(el, 'data-orig', t)
        if (preview) __set(el, 'data-preview', preview)
        else if (el.hasAttribute('data-preview')) el.removeAttribute('data-preview')
      }
    }
    apply()
    const mo = new MutationObserver(apply)
    mo.observe(row, { subtree: true, childList: true, characterData: true })
    return () => mo.disconnect()
  }, [preview])

  if (!fam) return jsx('span', { ref, 'data-mf-sid': sessionId, style: { display: 'none' } })
  // ref must stay on the rendered node for closest() lookups
  return jsx('span', {
    ref,
    'aria-hidden': true,
    'data-mf-sid': sessionId,
    'data-model-icon': fam,
    style: { display: 'inline-grid', placeItems: 'center', width: 14, height: 14, flexShrink: 0, alignSelf: 'center', marginRight: 6 },
    children: jsx('svg', {
      viewBox: '0 0 24 24', width: 13, height: 13, style: { fill: COLORS[fam] },
      children: jsx('path', { d: PATHS[fam] })
    })
  })
}

// ---- Gateway: messaging platform groups gathered under one "Gateway" label, above the footer ----
function renderGateway() {
  const drop = document.querySelector('[data-slot="sidebar"] [data-session-unpin-drop]')
  let root = drop
  while (root && root.parentElement && !(root.className || '').toString().includes('flex-1')) root = root.parentElement
  const host = root?.parentElement
  const lbl = document.getElementById('mf-gateway')
  if (!host) { lbl?.remove(); return }
  const kids = [...host.children]; const gws = kids.slice(kids.indexOf(root) + 1).filter(c => c.id !== 'mf-gateway' && c.id !== 'mf-folders' && (c.className || '').toString().includes('shrink-0'))
  if (host.hasAttribute('data-mf-gw-host') !== gws.length > 0) host.toggleAttribute('data-mf-gw-host', gws.length > 0)
  if (!gws.length) { lbl?.remove(); return }
  gws.forEach(g => __set(g, 'data-mf-gw'))
  let box = lbl
  if (box && box.nextElementSibling === gws[0] && box.style.paddingLeft) return
  if (!box || box.nextElementSibling !== gws[0]) { box?.remove(); box = el('div'); box.id = 'mf-gateway'; box.textContent = 'Gateway'; host.insertBefore(box, gws[0]) }
  const ref = [...document.querySelectorAll('[data-slot="sidebar"] button')].find(b => b.textContent.trim() === 'Sessions')
  const tn = ref && (() => { const w = document.createTreeWalker(ref, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.trim() === 'Sessions') return n })()
  if (tn) { const r = document.createRange(); r.selectNodeContents(tn); const pl = Math.max(0, Math.round(r.getBoundingClientRect().left - box.getBoundingClientRect().left)) + 'px'; if (box.style.paddingLeft !== pl) box.style.paddingLeft = pl }
}

// perf: ignore DOM churn inside chat transcripts (streaming tokens) — sidebar/chrome only
const __inThread = n => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest && e.closest('[data-slot="thread"], svg[data-bloub], #mf-live, #perf-probe')) }
const __relevant = recs => { for (const r of recs) if (!__inThread(r.target)) return true; return false }
const __set = (el, k, v = '') => { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v) }
const __throttle = (fn, ms) => { let t = 0, last = 0; return () => { if (t) return; const wait = Math.max(0, ms - (performance.now() - last)); t = setTimeout(() => { t = 0; last = performance.now(); fn() }, wait) } }

export default {
  id: ID,
  name: 'Session Model Icons',
  register(ctx) {
    ctxRef = ctx
    const iv = setInterval(() => { if (!document.hidden) invalidate() }, 60000)
    ctx.onDispose(() => clearInterval(iv))
    // Remove white marks injected by the previous version of this plugin.
    document.querySelectorAll('svg[data-model-icon]').forEach(n => n.remove())
    ctx.register({ id: 'lead', area: SESSION_ROW_AREAS.leading, data: { render: props => jsx(ModelLead, props) } })
    storage = ctx.storage
    folders = storage.get('folders', [])
    // Folder rows for sessions whose core row isn't mounted still need titles.
    const hydrate = async () => {
      const ids = folders.flatMap(f => f.ids).filter(id => !info.get(id)?.title)
      if (!ids.length) return
      try {
        const r = await apiDefault(`/previews?ids=${ids.map(encodeURIComponent).join(',')}`)
        const d = (r && (r.data ?? r)) || {}
        for (const id of ids) if (d[id]) info.set(id, { ...(info.get(id) || {}), title: info.get(id)?.title || d[id].title || d[id].preview?.slice(0, 40), model: d[id].model })
        renderFolders()
      } catch {}
    }
    hydrate()
    const hv = setInterval(() => { if (!document.hidden) hydrate() }, 60000)
    ctx.onDispose(() => clearInterval(hv))
    let q = false
    const tick = () => { renderFooter(); renderGateway(); renderFolderBtn(); if (!document.getElementById('mf-folders') || document.getElementById('mf-folders').nextElementSibling !== document.querySelector('[data-slot="sidebar"] [data-session-unpin-drop]')) renderFolders() }
    const tickT = __throttle(tick, 150)
    const mo = new MutationObserver(recs => { if (__relevant(recs)) tickT() })
    mo.observe(document.body, { childList: true, subtree: true })
    tick()
    const onCtx = e => {
      const sb = e.target.closest?.('[data-slot="sidebar"]')
      if (!sb) return
      const row = e.target.closest('.row-hover')
      ctxSid = null; ctxBlank = false
      if (row) { ctxSid = row.querySelector('[data-mf-sid]')?.getAttribute('data-mf-sid') || null; return }
      if (e.target.closest('#mf-folders')) return
      ctxBlank = true
      // If core opens no menu here, fall back to our own.
      const x = e.clientX, y = e.clientY
      setTimeout(() => { if (ctxBlank && !document.querySelector('.mf-inj')) showMenu(x, y, [['New folder', () => promptNewFolder()]]) }, 120)
    }
    document.addEventListener('contextmenu', onCtx, true)
    const mo2 = new MutationObserver(recs => { if ((ctxSid || ctxBlank) && __relevant(recs)) injectCoreMenu() })
    mo2.observe(document.body, { childList: true, subtree: true })
    ctx.onDispose(() => { document.removeEventListener('contextmenu', onCtx, true); mo2.disconnect(); closeMenu() })
    ctx.onDispose(() => { mo.disconnect(); document.getElementById('mf-footer')?.remove(); document.getElementById('mf-newfolder')?.remove(); document.getElementById('mf-folders')?.remove(); document.getElementById('mf-gateway')?.remove() })
  }
}
