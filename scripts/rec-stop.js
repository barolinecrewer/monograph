// Reads and removes the recorder rec-start.js put on window.__mgRec.
const R = window.__mgRec
if (!R) return 'no recorder'
const secs = (performance.now() - R.t0) / 1000
const sorted = [...R.dts].sort((a, b) => a - b)
const pct = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0)
const out = { secs: +secs.toFixed(2), fps: +(R.frames / secs).toFixed(1), frames: R.frames, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
  slow32: R.slow32, slow50: R.slow50, slow100: R.slow100, slow250: R.slow250, maxFrame: R.maxFrame,
  longtasks: { n: R.longtasks.length, total: R.longtasks.reduce((a, b) => a + b.d, 0), top: [...R.longtasks].sort((a, b) => b.d - a.d).slice(0, 12) },
  muts: R.muts, added: R.added, mutBySlot: Object.entries(R.mutBySlot).sort((a, b) => b[1] - a[1]).slice(0, 14),
  animStarts: Object.entries(R.animStarts).sort((a, b) => b[1] - a[1]).slice(0, 25), transStarts: Object.entries(R.transStarts).sort((a, b) => b[1] - a[1]).slice(0, 25), animBursts: R.animBursts.slice(0, 40),
  shifts: { n: R.shifts.length, sum: +R.shifts.reduce((a, b) => a + b.v, 0).toFixed(4), noInput: R.shifts.filter(s => !s.input).length, top: [...R.shifts].sort((a, b) => b.v - a.v).slice(0, 15) },
  viewport: { seen: R.vpSeen, swaps: R.vpSwaps, scrollNoInput: Math.round(R.scrollNoInput), scrollNoInputMax: R.scrollNoInputMax, scrollWithInput: Math.round(R.scrollWithInput),
    scrollNoInputEvents: R.scrollNoInputEvents.slice(0, 30), anchorNoInput: Math.round(R.anchorNoInput * 10) / 10, anchorNoInputMax: R.anchorNoInputMax, anchorEvents: R.anchorEvents.slice(0, 30),
    anchorSet: R.anchorSet, anchorLost: R.anchorLost, gapMax: R.gapMax, gapFramesOver2: R.gapFramesOver2, gapRunMax: R.gapRunMax, gapFinal: R.gapFinal, topFinal: R.topFinal,
    heightStart: R.heightStart, heightFinal: R.heightFinal },
  jumps: R.jumps, wheel: R.wheel, keys: R.keys, pointers: R.pointers, toolNames: R.toolNames,
  events: Object.fromEntries(Object.entries(R.events).map(([k, v]) => [k, (window.__mgRecOpts || {}).snapshot === false ? v.n : v])) }
if (!window.__mgRecKeep) R.stop()
return out
