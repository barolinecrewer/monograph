/**
 * live-status — while the agent works, the reply shows ONE short line
 * ("Reading the sidebar styles") with an animated infinity mark. The line is
 * written by Haiku from each tool call / failure (Python half: plugins/live-status).
 */
import { host } from '@hermes/plugin-sdk'

const ID = 'live-status'
const INF_D = 'M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z'
let ctxRef = null
let liveText = '', liveKind = 'work'

function liveNode() {
  const n = document.createElement('div'); n.id = 'mf-live'
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', 18); svg.setAttribute('height', 18)
  const base = document.createElementNS(ns, 'path'); base.setAttribute('d', INF_D); base.setAttribute('class', 'mf-inf-base')
  const run = document.createElementNS(ns, 'path'); run.setAttribute('d', INF_D); run.setAttribute('class', 'mf-inf-run'); run.setAttribute('pathLength', '100')
  svg.append(base, run); n.appendChild(svg)
  const t = document.createElement('span'); t.className = 'mf-live-text'; n.appendChild(t)
  return n
}

// Busy but no streaming message yet (e.g. right after re-opening a running
// session): the app shows its own loading row, which the skin hides.
const LOADING_SEL = '[data-slot="aui_response-loading"]'

// The reply that is streaming. After a switch to another session and back,
// Hermes can leave a finished reply flagged as streaming, further up the
// thread; the running reply is always in the last turn of its thread.
function streamingMarker() {
  for (const st of document.querySelectorAll('[data-message-streaming="true"]')) {
    const pair = st.closest('[data-slot="aui_turn-pair"]')
    const pairs = st.closest('[data-slot="aui_thread-content"]')?.querySelectorAll('[data-slot="aui_turn-pair"]')
    if (!pair || !pairs?.length || pairs[pairs.length - 1] === pair) return st
  }
  return null
}

const isBusy = () => !!(streamingMarker() || document.querySelector(LOADING_SEL))

function renderLive() {
  const st = streamingMarker()
  const msg = st?.closest('[data-role="assistant"]')?.querySelector('[data-slot="aui_assistant-message-content"]') || null
  const loading = msg ? null : document.querySelector(LOADING_SEL)
  let n = document.getElementById('mf-live')
  if (!msg && !loading) { n?.remove(); return }
  if (msg) {
    if (!n || n.parentElement !== msg || n !== msg.lastElementChild) { n?.remove(); n = liveNode(); msg.appendChild(n) }
  } else if (!n || n.previousElementSibling !== loading) { n?.remove(); n = liveNode(); loading.after(n) }
  const t = n.querySelector('.mf-live-text')
  const text = liveText || 'Working'
  if (t.textContent !== text) { t.textContent = text; t.classList.remove('mf-in'); void t.offsetWidth; t.classList.add('mf-in') }
  n.dataset.kind = liveKind
}

// Re-opening a running session can render the in-flight user message twice
// (optimistic copy + hydrated copy). Hide a user turn that repeats the one
// right before it with no assistant turn in between.
function dedupeUsers() {
  let prev = null
  for (const m of document.querySelectorAll('[data-role="user"], [data-role="assistant"]')) {
    if (m.dataset.role === 'assistant') { if ((m.textContent || '').trim()) prev = null; continue }
    const txt = (m.textContent || '').trim()
    const dup = prev !== null && txt && txt === prev
    if (dup) { if (m.dataset.mfDup !== '1') m.dataset.mfDup = '1' }
    else { if (m.dataset.mfDup) delete m.dataset.mfDup; prev = txt }
  }
}

async function pollLive() {
  try {
    const r = window.hermesDesktop?.api ? await window.hermesDesktop.api({ path: '/api/plugins/live-status/status', profile: 'default', timeoutMs: 8000 }) : await ctxRef.rest('/status')
    const d = (r && (r.data ?? r)) || {}
    const sid = host.state.focusedStoredSessionId?.get?.() || ''
    let best = d[sid]
    if (!best) for (const v of Object.values(d)) if (!best || v.at > best.at) best = v
    const fresh = best && Date.now() / 1000 - best.at < 180 && best.kind !== 'done'
    liveText = fresh ? best.text : ''
    liveKind = fresh ? best.kind : 'work'
  } catch {}
  renderLive()
}

export default {
  id: ID,
  name: 'Live Status',
  register(ctx) {
    ctxRef = ctx
    let watching = false, q = false
    const mo = new MutationObserver(() => { if (!q) { q = true; setTimeout(() => { q = false; dedupeUsers(); renderLive() }, 250) } })
    const iv = setInterval(() => {
      dedupeUsers()
      const streaming = !document.hidden && isBusy()
      if (streaming) {
        if (!watching) { watching = true; mo.observe(document.body, { childList: true, subtree: true }) }
        pollLive()
      } else {
        if (watching) { watching = false; mo.disconnect() }
        liveText = ''; document.getElementById('mf-live')?.remove()
      }
    }, 1500)
    ctx.onDispose(() => { clearInterval(iv); mo.disconnect(); document.getElementById('mf-live')?.remove(); document.querySelectorAll('[data-mf-dup]').forEach(e => delete e.dataset.mfDup) })
  }
}
