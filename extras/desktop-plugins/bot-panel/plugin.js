/**
 * bot-panel — right-sidebar inspector for the focused bot. Clicking the bot
 * chat pill (bloub-bots fires `bb:toggle-bot-panel`) reveals/hides it.
 * Shows and edits: model + provider, reasoning effort, fast mode, description,
 * soul (SOUL.md), cron jobs (pause/resume/remove/add), skills, toolsets, MCP.
 */
import {
  Button, host, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Switch, Textarea, useQuery, useQueryClient, useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'bot-panel'
const PANE = 'pane'
const PANE_ID = `${ID}:${PANE}`
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const req = (method, params = {}, ms = 20000) => host.request(method, params, ms)
const focusedProfile = () => String(host.state.focusedSessionProfile?.get?.() || 'default').trim() || 'default'
const say = (message, kind = 'success') => { try { host.notify({ kind, message }) } catch {} }
const errMsg = e => String(e?.message || e || 'failed')

// ---------- tiny layout helpers ----------
const Section = ({ title, right, children }) => jsxs('section', {
  className: 'bp-sec',
  children: [
    jsxs('div', { className: 'bp-sec-h', children: [jsx('span', { children: title }), right || null] }),
    jsx('div', { className: 'bp-sec-b', children })
  ]
})
const Row = ({ label, hint, children }) => jsxs('div', {
  className: 'bp-row',
  children: [
    jsxs('div', { className: 'bp-row-l', children: [jsx('div', { className: 'bp-row-t', children: label }), hint ? jsx('div', { className: 'bp-row-d', children: hint }) : null] }),
    jsx('div', { className: 'bp-row-c', children })
  ]
})
const Sel = ({ value, options, onChange, placeholder, wide }) => jsxs(Select, {
  value: value || undefined,
  onValueChange: onChange,
  children: [
    jsx(SelectTrigger, { className: wide ? 'bp-sel bp-sel-wide' : 'bp-sel', children: jsx(SelectValue, { placeholder: placeholder || '—' }) }),
    jsx(SelectContent, { children: options.map(o => jsx(SelectItem, { value: o.value, children: o.label }, o.value)) })
  ]
})
const Muted = ({ children }) => jsx('div', { className: 'bp-muted', children })

// ---------- model ----------
function ModelSection({ profile, desc, refetch }) {
  const qc = useQueryClient()
  const opts = useQuery({
    queryKey: [ID, 'model-options'],
    queryFn: () => req('model.options', { include_unconfigured: false, explicit_only: false }, 30000),
    staleTime: 120000, retry: false
  })
  const cur = desc?.model || {}
  const [prov, setProv] = useState(cur.provider || '')
  const [model, setModel] = useState(cur.default || '')
  const [confirm, setConfirm] = useState(null)
  useEffect(() => { setProv(cur.provider || ''); setModel(cur.default || ''); setConfirm(null) }, [profile, cur.provider, cur.default])
  const providers = (opts.data?.providers || []).filter(p => p && p.slug)
  const pRow = providers.find(p => p.slug === prov)
  const models = (pRow?.models || []).map(m => typeof m === 'string' ? m : (m?.id || m?.name)).filter(Boolean)
  const modelOpts = [...new Set([...(model && !models.includes(model) ? [model] : []), ...models])].map(m => ({ value: m, label: m }))
  const provOpts = [...(prov && !pRow ? [{ value: prov, label: prov }] : []), ...providers.map(p => ({ value: p.slug, label: p.name || p.slug }))]
  const dirty = prov !== (cur.provider || '') || model !== (cur.default || '')
  const save = async (force = false) => {
    try {
      const r = await req('profiles.configure', { name: profile, provider: prov, model, ...(force ? { confirm_expensive_model: true } : {}) })
      if (r?.confirm_required) { setConfirm(r.confirm_message || 'This model needs confirmation.'); return }
      setConfirm(null); say(`Model set to ${model}`); refetch(); qc.invalidateQueries({ queryKey: [ID] })
    } catch (e) { say(errMsg(e), 'error') }
  }
  return jsxs(Section, {
    title: 'Model',
    children: [
      jsx(Row, { label: 'Provider', children: jsx(Sel, { value: prov, options: provOpts, onChange: v => { setProv(v); setModel('') }, placeholder: opts.isLoading ? 'Loading…' : 'Provider' }) }),
      jsx(Row, { label: 'Model', children: jsx(Sel, { value: model, options: modelOpts, onChange: setModel, placeholder: 'Model' }) }),
      confirm ? jsxs('div', { className: 'bp-warn', children: [jsx('div', { children: confirm }), jsx(Button, { size: 'sm', onClick: () => save(true), children: 'Use anyway' })] }) : null,
      dirty && prov && model ? jsx('div', { className: 'bp-actions', children: jsx(Button, { size: 'sm', onClick: () => save(false), children: 'Save model' }) }) : null
    ]
  })
}

// ---------- effort / fast ----------
function BehaviourSection({ profile }) {
  const q = useQuery({
    queryKey: [ID, 'behaviour', profile],
    queryFn: async () => {
      const [r, f] = await Promise.all([
        req('config.get', { key: 'reasoning', profile }).catch(() => null),
        req('config.get', { key: 'fast', profile }).catch(() => null)
      ])
      return { effort: r?.value || 'medium', fast: f?.value === 'fast' || f?.value === 'ultrafast' }
    },
    staleTime: 10000
  })
  const set = async (key, value, label) => {
    try { await req('config.set', { key, value, profile, scope: 'global' }); say(label); q.refetch() } catch (e) { say(errMsg(e), 'error') }
  }
  return jsxs(Section, {
    title: 'Behaviour',
    children: [
      jsx(Row, { label: 'Effort', hint: 'Reasoning depth', children: jsx(Sel, { value: q.data?.effort, options: EFFORTS.map(e => ({ value: e, label: e })), onChange: v => set('reasoning', v, `Effort set to ${v}`) }) }),
      jsx(Row, { label: 'Fast mode', hint: 'Priority tier when supported', children: jsx(Switch, { checked: !!q.data?.fast, onCheckedChange: v => set('fast', v ? 'fast' : 'normal', v ? 'Fast mode on' : 'Fast mode off') }) })
    ]
  })
}

// ---------- description + soul ----------
function SoulSection({ profile, desc, refetch }) {
  const [soul, setSoul] = useState(desc?.soul || '')
  const [d, setD] = useState(desc?.description || '')
  useEffect(() => { setSoul(desc?.soul || ''); setD(desc?.description || '') }, [profile, desc?.soul, desc?.description])
  const dirty = soul !== (desc?.soul || '') || d !== (desc?.description || '')
  const save = async () => {
    try {
      const r = await req('profiles.configure', { name: profile, soul, description: d })
      if (r?.applied && Object.values(r.applied).some(v => !v)) throw new Error('Some fields were not saved')
      say('Soul saved'); refetch()
    } catch (e) { say(errMsg(e), 'error') }
  }
  return jsxs(Section, {
    title: 'Soul',
    children: [
      jsx('div', { className: 'bp-lbl', children: 'Description' }),
      jsx(Input, { value: d, onChange: e => setD(e.target.value), placeholder: 'What this bot does' }),
      jsx('div', { className: 'bp-lbl', children: 'SOUL.md' }),
      jsx(Textarea, { className: 'bp-soul', value: soul, onChange: e => setSoul(e.target.value), placeholder: 'Personality, role, tone…' }),
      dirty ? jsxs('div', { className: 'bp-actions', children: [
        jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => { setSoul(desc?.soul || ''); setD(desc?.description || '') }, children: 'Revert' }),
        jsx(Button, { size: 'sm', onClick: save, children: 'Save' })
      ] }) : null
    ]
  })
}

// ---------- cron ----------
const when = iso => { if (!iso) return ''; const t = new Date(iso); return isNaN(t) ? String(iso) : t.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function CronSection({ profile }) {
  const q = useQuery({
    queryKey: [ID, 'cron', profile],
    queryFn: () => req('cron.manage', { action: 'list', include_disabled: true, profile }),
    staleTime: 10000, refetchInterval: 30000
  })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', schedule: '', prompt: '' })
  const act = async (action, name, label) => {
    try {
      const r = await req('cron.manage', { action, name, profile })
      if (r && r.success === false) throw new Error(r.error || `${action} failed`)
      say(label); q.refetch()
    } catch (e) { say(errMsg(e), 'error') }
  }
  const add = async () => {
    try {
      const r = await req('cron.manage', { action: 'add', profile, name: form.name, schedule: form.schedule, prompt: form.prompt })
      if (r && r.success === false) throw new Error(r.error || 'Could not create job')
      say('Job created'); setAdding(false); setForm({ name: '', schedule: '', prompt: '' }); q.refetch()
    } catch (e) { say(errMsg(e), 'error') }
  }
  const jobs = q.data?.jobs || []
  return jsxs(Section, {
    title: `Cron jobs${jobs.length ? ` · ${jobs.length}` : ''}`,
    right: jsx('button', { type: 'button', className: 'bp-link', onClick: () => setAdding(a => !a), children: adding ? 'Cancel' : '+ New' }),
    children: [
      adding ? jsxs('div', { className: 'bp-form', children: [
        jsx(Input, { value: form.name, onChange: e => setForm({ ...form, name: e.target.value }), placeholder: 'Name' }),
        jsx(Input, { value: form.schedule, onChange: e => setForm({ ...form, schedule: e.target.value }), placeholder: 'Schedule — e.g. every day at 9am, 0 9 * * *' }),
        jsx(Textarea, { value: form.prompt, onChange: e => setForm({ ...form, prompt: e.target.value }), placeholder: 'What should it do?' }),
        jsx('div', { className: 'bp-actions', children: jsx(Button, { size: 'sm', disabled: !form.schedule.trim() || !form.prompt.trim(), onClick: add, children: 'Create' }) })
      ] }) : null,
      q.isLoading ? jsx(Muted, { children: 'Loading…' }) : q.error ? jsx(Muted, { children: errMsg(q.error) }) : !jobs.length ? jsx(Muted, { children: 'No scheduled jobs.' }) : null,
      ...jobs.map(j => jsxs('div', {
        className: 'bp-job', 'data-off': j.enabled === false ? '' : undefined,
        children: [
          jsxs('div', { className: 'bp-job-top', children: [
            jsx('div', { className: 'bp-job-n', title: j.name, children: j.name }),
            jsx(Switch, { checked: j.enabled !== false, onCheckedChange: v => act(v ? 'resume' : 'pause', j.job_id, v ? 'Job resumed' : 'Job paused') })
          ] }),
          jsx('div', { className: 'bp-job-s', children: [j.schedule, j.enabled !== false && j.next_run_at ? `next ${when(j.next_run_at)}` : (j.enabled === false ? 'paused' : '')].filter(Boolean).join(' · ') }),
          j.prompt_preview ? jsx('div', { className: 'bp-job-p', children: j.prompt_preview }) : null,
          j.last_status ? jsx('div', { className: 'bp-job-s', children: `last: ${j.last_status}${j.last_run_at ? ' · ' + when(j.last_run_at) : ''}` }) : null,
          jsx('div', { className: 'bp-actions', children: jsx('button', { type: 'button', className: 'bp-link bp-danger', onClick: () => act('remove', j.job_id, 'Job removed'), children: 'Remove' }) })
        ]
      }, j.job_id))
    ]
  })
}

// ---------- skills / toolsets / mcp ----------
function ToggleList({ title, items, onToggle, empty, sub }) {
  const [open, setOpen] = useState(false)
  const on = items.filter(i => i.enabled).length
  return jsxs(Section, {
    title: `${title} · ${on}/${items.length}`,
    right: items.length ? jsx('button', { type: 'button', className: 'bp-link', onClick: () => setOpen(o => !o), children: open ? 'Hide' : 'Show' }) : null,
    children: !items.length ? jsx(Muted, { children: empty }) : open ? items.map(i => jsx(Row, {
      label: i.label || i.name, hint: sub ? sub(i) : null,
      children: jsx(Switch, { checked: !!i.enabled, onCheckedChange: v => onToggle(i, v) })
    }, i.name)) : null
  })
}
function CapabilitySections({ profile, desc, refetch }) {
  const save = async (params, label) => {
    try {
      const r = await req('profiles.configure', { name: profile, ...params })
      if (r?.confirm_required) throw new Error(r.confirm_message || 'Needs confirmation')
      say(label); refetch()
    } catch (e) { say(errMsg(e), 'error') }
  }
  const skills = desc?.skills || [], toolsets = desc?.toolsets || [], mcp = desc?.mcp_servers || []
  return jsxs('div', { children: [
    jsx(ToggleList, {
      title: 'Skills', items: skills, empty: 'No skills installed.',
      onToggle: (s, v) => save({ disabled_skills: skills.filter(x => (x.name === s.name ? !v : !x.enabled)).map(x => x.name) }, `${s.name} ${v ? 'enabled' : 'disabled'}`)
    }),
    jsx(ToggleList, {
      title: 'Toolsets', items: toolsets, empty: 'No toolsets.', sub: t => t.description ? t.description.slice(0, 80) : (t.tool_count ? `${t.tool_count} tools` : ''),
      onToggle: (t, v) => save({ enabled_toolsets: toolsets.filter(x => (x.name === t.name ? v : x.enabled)).map(x => x.name) }, `${t.label || t.name} ${v ? 'enabled' : 'disabled'}`)
    }),
    jsx(ToggleList, {
      title: 'MCP servers', items: mcp, empty: 'No MCP servers.', sub: m => m.transport,
      onToggle: (m, v) => save({ enabled_mcp_servers: mcp.filter(x => (x.name === m.name ? v : x.enabled)).map(x => x.name) }, `${m.name} ${v ? 'enabled' : 'disabled'}`)
    })
  ] })
}

// ---------- pane ----------
function BotPanel() {
  const profile = String(useValue(host.state.focusedSessionProfile) || 'default').trim() || 'default'
  const meta = useQuery({
    queryKey: [ID, 'profiles'],
    queryFn: () => req('profiles.list', { include_sessions: false }),
    staleTime: 60000
  })
  const desc = useQuery({
    queryKey: [ID, 'describe', profile],
    queryFn: () => req('profiles.describe', { name: profile }),
    staleTime: 15000
  })
  const prow = (meta.data?.profiles || []).find(p => p.name === profile)
  const title = prow?.ui_meta?.['hermes-bots']?.title || prow?.display_name || (profile === 'default' ? 'Hermes' : profile)
  const refetch = () => desc.refetch()
  return jsxs('div', {
    className: 'bp-root',
    children: [
      jsx('style', { children: CSS }),
      jsxs('div', { className: 'bp-head', children: [
        jsx('div', { className: 'bp-title', children: title }),
        jsx('div', { className: 'bp-sub', children: profile === 'default' ? 'Main bot · default profile' : `Profile · ${profile}` }),
        jsx('button', { type: 'button', className: 'bp-x', 'aria-label': 'Close bot panel', title: 'Close', onClick: () => window.dispatchEvent(new CustomEvent('bb:toggle-bot-panel')), children: '\u00d7' })
      ] }),
      desc.isLoading ? jsx(Muted, { children: 'Loading…' })
        : desc.error ? jsx(Muted, { children: errMsg(desc.error) })
        : jsxs('div', { className: 'bp-body', children: [
          jsx(ModelSection, { profile, desc: desc.data, refetch }),
          jsx(BehaviourSection, { profile }),
          jsx(CronSection, { profile }),
          jsx(SoulSection, { profile, desc: desc.data, refetch }),
          jsx(CapabilitySections, { profile, desc: desc.data, refetch })
        ] })
    ]
  })
}

const CSS = `
.bp-root{height:100%;overflow-y:auto;padding:14px 14px 28px;font-size:13px;color:var(--ui-text-primary,var(--foreground))}
.bp-head{padding:2px 2px 12px;position:relative}
.bp-x{position:absolute;top:0;right:0;width:24px;height:24px;border-radius:50%;border:0;background:none;color:var(--ui-text-tertiary,var(--muted-foreground));font-size:18px;line-height:22px;cursor:pointer;opacity:.7}
.bp-x:hover{opacity:1;background:color-mix(in srgb,var(--ui-text-primary,#fff) 7%,transparent)}
.bp-title{font-size:17px;font-weight:600;letter-spacing:-.01em}
.bp-sub{font-size:12px;color:var(--ui-text-tertiary,var(--muted-foreground));margin-top:2px}
.bp-sec{border-top:1px solid var(--ui-stroke-secondary,var(--border));padding:12px 2px}
.bp-sec-h{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ui-text-tertiary,var(--muted-foreground));margin-bottom:8px}
.bp-sec-b{display:flex;flex-direction:column;gap:8px}
.bp-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px}
.bp-row-l{min-width:0;flex:1}
.bp-row-t{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-row-d{font-size:11px;color:var(--ui-text-quaternary,var(--muted-foreground));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-row-c{flex-shrink:1;min-width:0;max-width:64%;display:flex;align-items:center;justify-content:flex-end}
.bp-sel{width:170px!important;max-width:100%!important;min-width:0!important;height:28px;font-size:12px;overflow:hidden}
.bp-sel > span,.bp-sel [data-slot="select-value"]{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.bp-lbl{font-size:11px;color:var(--ui-text-tertiary,var(--muted-foreground));margin-top:2px}
.bp-soul{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5}
.bp-actions{display:flex;justify-content:flex-end;gap:6px}
.bp-link{font-size:11px;font-weight:500;text-transform:none;letter-spacing:0;color:var(--ui-text-secondary,var(--foreground));opacity:.8;cursor:pointer;background:none;border:0;padding:0}
.bp-link:hover{opacity:1;text-decoration:underline}
.bp-danger{color:var(--ui-text-tertiary,var(--muted-foreground))}
.bp-muted{font-size:12px;color:var(--ui-text-tertiary,var(--muted-foreground));padding:2px 0}
.bp-warn{font-size:12px;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--ui-stroke-secondary,var(--border));border-radius:8px}
.bp-form{display:flex;flex-direction:column;gap:6px;padding-bottom:6px}
.bp-job{padding:8px 10px;border-radius:10px;background:color-mix(in srgb,var(--ui-text-primary,#fff) 5%,transparent);display:flex;flex-direction:column;gap:3px}
.bp-job[data-off]{opacity:.55}
.bp-job-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bp-job-n{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bp-job-s{font-size:11px;color:var(--ui-text-tertiary,var(--muted-foreground))}
.bp-job-p{font-size:12px;color:var(--ui-text-secondary,var(--foreground));opacity:.85;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
`

export default {
  id: ID,
  name: 'Bot Panel',
  register(ctx) {
    // The pane exists ONLY while Bot Mode is on screen (the core Bots roster
    // pane is visible). In Sessions mode it is unregistered entirely.
    const $botsVisible = typeof host.paneVisibility === 'function' ? host.paneVisibility('hermes-bots:pane') : null
    const inBotMode = () => {
      if ($botsVisible) return !!$botsVisible.get()
      const t = [...document.querySelectorAll('[data-tree-tab]')].find(x => x.getAttribute('aria-label') === 'Bots')
      return t?.getAttribute('aria-selected') === 'true'
    }
    let unregister = null
    let disposed = false
    let wasBots = null
    const fiberOf = el => el && el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]
    const press = btn => {
      for (let f = fiberOf(btn); f; f = f.return) {
        const pr = f.memoizedProps
        if (pr && typeof pr.onClick === 'function') { pr.onClick({ currentTarget: btn, target: btn, preventDefault() {}, stopPropagation() {}, nativeEvent: {} }); return }
      }
      btn.click()
    }
    // Leaving Bot Mode: Sessions is plain Hermes. If a bot chat still holds the
    // workspace, move focus to a general (default-profile) session.
    const leaveBots = () => {
      const fp = String(host.state.focusedSessionProfile?.get?.() || 'default')
      if (fp === 'default') return
      // tab-strip "+" first: in Sessions it targets default and reuses an untouched draft
      const vis = sel => [...document.querySelectorAll(sel)].find(b => b.offsetParent)
      const btn = vis('button[aria-label="New session tab"]') || vis('button[aria-label="New session"]')
      if (btn) press(btn)
    }
    // The panel is open only when the user asked for it (pill click). Closing
    // unregisters the pane: no right-sidebar toggle (that's ⌘J = file browser)
    // and no side un-collapse (that restores every dismissed right pane).
    let open = false
    const sync = () => {
      if (disposed) return
      const bots = inBotMode()
      if (wasBots === true && !bots) { open = false; ctx.setTimeout ? ctx.setTimeout(leaveBots, 120) : setTimeout(leaveBots, 120) }
      wasBots = bots
      if (bots && open) {
        if (!unregister) {
          unregister = ctx.register({
            id: PANE,
            area: 'panes',
            title: 'Bot',
            data: { placement: 'right', width: '320px' },
            render: () => jsx(BotPanel, {})
          })
        }
      } else if (unregister) {
        try { unregister() } catch {}
        unregister = null
      }
    }
    // next tick: visibility notifications arrive mid tree-mutation
    const schedule = () => ctx.setTimeout ? ctx.setTimeout(sync, 0) : setTimeout(sync, 0)
    const stop = $botsVisible?.listen?.(schedule)
    const iv = $botsVisible ? null : setInterval(sync, 800)
    schedule()
    ctx.onDispose(() => { disposed = true; stop?.(); if (iv) clearInterval(iv); try { unregister?.() } catch {}; unregister = null })

    const paneVis = () => typeof host.paneVisibility === 'function' ? !!host.paneVisibility(PANE_ID).get() : !!unregister
    let lastToggle = 0
    const toggle = () => {
      if (!inBotMode()) return
      const now = Date.now()
      if (now - lastToggle < 350) return // swallow duplicate pointerdown/click
      lastToggle = now
      // registered but not on screen (e.g. column collapsed) → treat as closed
      if (open && unregister && !paneVis()) open = false
      open = !open
      sync()
      if (!open) return
      if (typeof host.undismissPane === 'function') host.undismissPane(PANE_ID)
      // Only force a reveal if adoption alone didn't put it on screen.
      const later = ctx.setTimeout || setTimeout
      later(() => { if (open && !paneVis()) host.revealPane?.(PANE_ID) }, 80)
    }
    window.addEventListener('bb:toggle-bot-panel', toggle)
    ctx.onDispose(() => window.removeEventListener('bb:toggle-bot-panel', toggle))
  }
}
