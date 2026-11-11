// Exit for dropdown menus.
//
// Every other Radix layer in Hermes plays the exit 55-motion.css gives it:
// Radix keeps the closing layer mounted until its animation ends. A dropdown
// menu cannot. Hermes puts two context providers between the menu's portal
// and its content, so the Presence that guards the portal never finds an
// element to watch and removes the menu in the frame it closes.
//
// So, after React has removed a closed menu from <body>, this puts that same
// node back, inert and out of the pointer's way, lets it play its exit
// (data-state="closed" is already on it), and removes it at the end. React
// let go of the node when it removed it; nothing here is React's any more.
// The observer is on <body>'s own children only.
MODULES.push({
  id: 'motion',
  start() {
    const ghosts = new Set()
    const still = () =>
      document.documentElement.dataset.mgMotion === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const drop = ghost => {
      if (!ghosts.delete(ghost)) return
      clearTimeout(ghost.mgTimer)
      ghost.remove()
    }

    const observer = new MutationObserver(records => {
      if (still()) return

      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement) || node.isConnected || 'mgGhost' in node.dataset) continue
          if (!node.matches('[data-radix-popper-content-wrapper]')) continue

          const menu = node.querySelector(':scope > [data-slot="dropdown-menu-content"][data-state="closed"]')

          if (!menu) continue

          node.dataset.mgGhost = ''
          node.inert = true
          node.setAttribute('aria-hidden', 'true')
          node.style.pointerEvents = 'none'
          ghosts.add(node)
          menu.addEventListener('animationend', event => event.target === menu && drop(node))
          menu.addEventListener('animationcancel', event => event.target === menu && drop(node))
          // In case the exit never runs (the stylesheet gone, display: none).
          node.mgTimer = setTimeout(() => drop(node), 600)
          document.body.appendChild(node)
        }
      }
    })

    observer.observe(document.body, { childList: true })

    // The motion-off kill switch: its own <style id="mg-motion-off">, in the
    // page only while :root[data-mg-motion="off"]. The attribute is watched
    // rather than the setting, so anything that writes it (the settings, the
    // rig) switches it; that observer sees one attribute of one element.
    //
    // It once gave every element (`*`, `*::before`, `*::after`) a zero
    // transition and a cut animation. A transition list on every element
    // makes every style change on every element walk every transitionable
    // property: on a 2,000-line streamed reply that was over a second of
    // style recalculation more than with motion on. Now it names only the
    // elements that can move: every style rule in the page that declares an
    // animation or a transition (Hermes' sheets and ours, read from the CSSOM
    // when motion goes off and again when a stylesheet arrives) is repeated
    // with the cut, under its own selector. A rule matches only where the
    // original did, so an element that cannot move costs nothing; a selector
    // whose last part would match any element (`*`, `:before`) is skipped.
    // Durations go to 0s: the animation is over the moment it is created,
    // shows its end (or resting) state in its first frame and still fires
    // animationend, which a closing Radix layer waits for. Our own rules on
    // the --mg-dur-* tokens collapse anyway (05-motion.css sets them to 0).
    // Hermes' script animations (Element.animate, a 180 ms slide on each
    // message of a running turn) are finished as they start while motion is
    // off; Hermes skips them itself under reduced motion. The reduced-motion
    // copy of the switch stays in 05-motion.css: under reduced motion Hermes'
    // own stylesheet already gives every element a transition, so ours adds
    // no per-element work there.
    const root = document.documentElement
    const CUT = 'animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important'
    const MOVES = /(?:^|;)\s*(?:animation|transition)(?:-name|-duration|-delay|-property)?\s*:\s*(?!none\s*(?:!important\s*)?(?:;|$)|0m?s\s*(?:!important\s*)?(?:;|$))/
    const SMOOTH = /(?:^|;)\s*scroll-behavior\s*:\s*smooth/
    let off = null
    let sheets = null
    let regen = 0

    // Top-level commas only (not those inside :is(), :not(), attribute values).
    const split = text => {
      const parts = []
      let depth = 0
      let quote = ''
      let start = 0

      for (let i = 0; i < text.length; i++) {
        const c = text[i]

        if (quote) {
          if (c === quote && text[i - 1] !== '\\') quote = ''
        } else if (c === '"' || c === "'") {
          quote = c
        } else if (c === '(' || c === '[') {
          depth++
        } else if (c === ')' || c === ']') {
          depth--
        } else if (c === ',' && !depth) {
          parts.push(text.slice(start, i).trim())
          start = i + 1
        }
      }
      parts.push(text.slice(start).trim())

      return parts.filter(Boolean)
    }
    // The last compound, without pseudo-elements: nothing but `*` and
    // pseudo-classes means it is tried on every element.
    const anyElement = selector => {
      const text = selector.replace(/::?(?:before|after|marker|placeholder|selection|backdrop|-webkit-[\w-]+)(?:\([^)]*\))?\s*$/i, '').trim()
      let depth = 0
      let at = 0

      for (let i = 0; i < text.length; i++) {
        const c = text[i]

        if (c === '(' || c === '[') depth++
        else if (c === ')' || c === ']') depth--
        else if (!depth && /[\s>+~]/.test(c) && text[i - 1] !== '\\') at = i + 1
      }

      const last = text.slice(at)

      return /^\*?(?::(?!is\(|where\()[\w-]+(?:\([^()]*\))?)*$/.test(last) && !/^:root\b/.test(last)
    }

    const collect = () => {
      const out = new Set()
      const visit = (rules, parent) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            let selector = rule.selectorText

            if (parent) {
              selector = split(selector).map(part => (part.includes('&') ? part.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${part}`)).join(', ')
            }

            const text = rule.style.cssText

            if (MOVES.test(text) || SMOOTH.test(text)) {
              for (const part of split(selector)) {
                if (!anyElement(part)) out.add(part)
              }
            }

            if (rule.cssRules?.length) visit(rule.cssRules, selector)
          } else if (rule.cssRules && !(rule instanceof CSSKeyframesRule)) {
            visit(rule.cssRules, parent)
          }
        }
      }

      for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) {
        if (sheet.ownerNode === off) continue

        try {
          visit(sheet.cssRules, '')
        } catch {
          // A sheet the page may not read (another origin): nothing to cut.
        }
      }

      // One rule per selector: one that does not parse drops only itself.
      return `${MOTION_OFF_CSS}\n${[...out].map(selector => `${selector}{${CUT}}`).join('\n')}`
    }

    // Element.animate while motion is off: the effect jumps to its end (an
    // endless one is cancelled) as it is made. Put back when motion comes on.
    const native = Element.prototype.animate
    const finished = function (...args) {
      const animation = native.apply(this, args)

      try {
        animation.finish()
      } catch {
        animation.cancel()
      }

      return animation
    }
    const patchAnimate = on => {
      if (on && Element.prototype.animate === native) Element.prototype.animate = finished
      if (!on && Element.prototype.animate === finished) Element.prototype.animate = native
    }

    const build = () => {
      regen = 0
      if (off) off.textContent = collect()
    }

    // A stylesheet that arrives while motion is off (Hermes loads some with
    // the screen that needs them) is read once it has loaded. The observer
    // sees <head>'s own children only, and only while motion is off.
    const later = () => {
      clearTimeout(regen)
      regen = setTimeout(build, 50)
    }
    const arrived = records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node === off || node.id === 'mg-css') continue
          if (node.nodeName === 'STYLE') later()
          if (node.nodeName === 'LINK' && /stylesheet/i.test(node.rel)) node.addEventListener('load', later, { once: true })
        }
      }
    }

    const sync = () => {
      if (root.dataset.mgMotion === 'off') {
        if (!off) {
          off = document.createElement('style')
          off.id = 'mg-motion-off'
        }

        if (!off.isConnected) {
          document.head.insertBefore(off, document.getElementById('mg-css'))
          build()
        }

        if (!sheets) {
          sheets = new MutationObserver(arrived)
          sheets.observe(document.head, { childList: true })
        }

        patchAnimate(true)
      } else {
        off?.remove()
        sheets?.disconnect()
        sheets = null
        clearTimeout(regen)
        patchAnimate(false)
      }
    }

    const attribute = new MutationObserver(sync)

    attribute.observe(root, { attributeFilter: ['data-mg-motion'], attributes: true })
    sync()

    return () => {
      observer.disconnect()
      attribute.disconnect()
      sheets?.disconnect()
      clearTimeout(regen)
      patchAnimate(false)
      off?.remove()
      ;[...ghosts].forEach(drop)
    }
  }
})
