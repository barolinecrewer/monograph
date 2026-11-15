/**
 * image-cards — images you send show as small cards right above your bubble
 * instead of a large thumbnail row below it. Clicking a card opens the app's
 * own lightbox (forwards the click to the hidden original).
 * Also hides the attachment row of a user turn that live-status flagged as a
 * duplicate (data-mf-dup), so re-opened sessions don't show images twice.
 */
const ID = 'image-cards'

function sync() {
  for (const u of document.querySelectorAll('[data-role="user"][data-slot="aui_user-message-root"]')) {
    const row = u.nextElementSibling
    const imgs = row && !row.dataset.role
      ? [...row.querySelectorAll('[data-slot="aui_directive-image"]')].map(w => ({ w, img: w.querySelector('img') })).filter(x => x.img && x.img.src)
      : []
    let strip = u.querySelector(':scope > .mf-att-strip')
    if (!imgs.length) { strip?.remove(); continue }
    // Hide the originals; hide the whole row if images are all it holds.
    for (const { w } of imgs) w.dataset.mfMoved = '1'
    const other = [...row.querySelectorAll('[data-slot="aui_directive-chip"]')].length
    row.dataset.mfAtt = other ? 'partial' : 'moved'
    // Unique by src (the optimistic + hydrated copies can repeat an image).
    const seen = new Set(), list = []
    for (const x of imgs) if (!seen.has(x.img.src)) { seen.add(x.img.src); list.push(x) }
    const key = list.map(x => x.img.src.slice(-64)).join('|')
    if (strip && strip.dataset.key === key && strip === u.firstElementChild) continue
    strip?.remove()
    strip = document.createElement('div'); strip.className = 'mf-att-strip'; strip.dataset.key = key
    for (const { w, img } of list) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mf-att-card'; b.title = img.alt || 'Image'
      const c = document.createElement('img'); c.src = img.src; c.alt = img.alt || ''; c.draggable = false
      b.appendChild(c)
      b.addEventListener('click', e => { e.stopPropagation(); (w.querySelector('button') || img).click() })
      strip.appendChild(b)
    }
    u.prepend(strip)
  }
}

export default {
  id: ID,
  name: 'Image Cards',
  register(ctx) {
    let q = false
    const run = () => { if (!q) { q = true; setTimeout(() => { q = false; try { sync() } catch {} }, 150) } }
    const mo = new MutationObserver(muts => {
      for (const m of muts) if (!(m.target.closest && m.target.closest('.mf-att-strip'))) { run(); return }
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-mf-dup'] })
    run()
    ctx.onDispose(() => {
      mo.disconnect()
      document.querySelectorAll('.mf-att-strip').forEach(n => n.remove())
      document.querySelectorAll('[data-mf-moved],[data-mf-att]').forEach(n => { delete n.dataset.mfMoved; delete n.dataset.mfAtt })
    })
  }
}
