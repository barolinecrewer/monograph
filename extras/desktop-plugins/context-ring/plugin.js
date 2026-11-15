/**
 * context-ring — a tiny ring next to the send button that fills as the
 * context window fills. Hover shows exact usage, e.g. "400k / 1M · 40%".
 */
import { host, Tip, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'context-ring'

function fmt(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

function ContextRing() {
  const usage = useValue(host.state.focusedUsage)
  const used = Number(usage?.context_used) || 0
  const max = Number(usage?.context_max) || 0
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : Number(usage?.context_percent) || 0

  const size = 13
  const stroke = 1.6
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const label = max > 0
    ? `${fmt(used)} / ${fmt(max)} · ${Math.round(pct)}%${usage?.context_estimated ? ' (est.)' : ''}`
    : 'Context: no data yet'

  return jsx(Tip, {
    label,
    side: 'top',
    children: jsx('span', {
      'aria-label': `Context window ${label}`,
      role: 'img',
      'data-slot': 'context-ring',
      style: {
        display: 'inline-grid',
        placeItems: 'center',
        width: '13px',
        height: 'var(--composer-control-size, 28px)',
        margin: '0 8px 0 2px',
        flexShrink: 0,
        cursor: 'default',
        opacity: 0.85
      },
      children: jsxs('svg', {
        width: size,
        height: size,
        viewBox: `0 0 ${size} ${size}`,
        style: { transform: 'rotate(-90deg)' },
        children: [
          jsx('circle', {
            cx: size / 2, cy: size / 2, r,
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: 0.18,
            strokeWidth: stroke
          }),
          jsx('circle', {
            cx: size / 2, cy: size / 2, r,
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: 0.9,
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: c,
            strokeDashoffset: c * (1 - pct / 100),
            style: { transition: 'stroke-dashoffset .4s ease' }
          })
        ]
      })
    })
  })
}

export default {
  id: ID,
  name: 'Context Ring',
  register(ctx) {
    ctx.register({ id: 'ring', area: 'composer.actions', order: 1000, render: () => jsx(ContextRing, {}) })
  }
}
