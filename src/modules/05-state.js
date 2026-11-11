// ── State attributes for the stylesheet ─────────────────────────────────────
// The one place that writes state onto <html> for the CSS to key on, so that
// no rule has to ask the whole document with :root:has(…). A :root:has() rule
// is checked again on every change anywhere in the page that could touch its
// argument (any button added, any row streamed in), and when its answer flips
// every element under :root is restyled. These attributes flip only when the
// state does, and each is worked out from a cheap, local source:
//
//   data-mg-surfaces="on"    the surfaces button is in the page
//                            (10-shell.css, 14-surfaces.css)
//   data-mg-empty-chat       a chat is on screen, the route is a new draft
//                            (names no session), and no thread in the page has
//                            a message in it yet (40-composer.css)
//   data-mg-menu="model"     the composer's model menu is open
//                            (50-menus.css)
//
// Each one is exactly what the :root:has() it replaces asked, document-wide,
// so nothing on screen changes; rig/suites/pixels.mjs holds them to that in
// every state it visits (the "state" evidence of each check).
//
// Sources, none of them polling and none watching the whole body subtree:
// - the titlebar: its clusters' parent and each cluster, childList only (a
//   handful of nodes), plus Hermes' own 'hermes:titlebar-chrome-changed'
//   event on a route change;
// - the threads: the core's thread finder (onThreads) and one childList
//   observer per thread, which does nothing while the answer cannot change
//   (a thread that has a message only loses it when nodes are removed);
// - menus: pointer, key and focus events, and the body's direct children
//   (Radix puts each open menu there), each checked once per frame.
const OWNER = Symbol.for('monograph.state.owner')

MODULES.push({
  id: 'state',
  start() {
    const root = document.documentElement
    const off = []
    const owner = Symbol('state')
    let frame = 0

    // The newest instance owns the attributes: a hot reload may start the next
    // one before this one stops, and this one's stop must not wipe its work.
    window[OWNER] = owner

    const set = (name, value) => {
      if (value === null) {
        if (root.hasAttribute(name)) {
          root.removeAttribute(name)
        }
      } else if (root.getAttribute(name) !== value) {
        root.setAttribute(name, value)
      }
    }

    // ── What each attribute asks ──
    const SURFACES_BUTTON = 'button[data-tour="mg-surfaces"]'
    const MESSAGE = `${THREAD} :is([data-role="user"], [data-role="assistant"], [data-role="system"])`
    const MODEL_OPEN = '[data-slot="composer-fade"] button:is([data-tour="model-pill"], [aria-label^="Model · "])[aria-expanded="true"]'

    const surfaces = () => set('data-mg-surfaces', document.querySelector(SURFACES_BUTTON) ? 'on' : null)
    // A route that names a session is never empty: Hermes renders a thread
    // anew, with no messages for a frame or two, on a switch and when the
    // first send binds the draft to its session (#/ → #/<id>). Bare Hermes
    // shows those frames as they are; here they would bring the composer to
    // the middle and back (rig/suites/home.mjs h18).
    const draftRoute = () => /^#?\/?(\?.*)?$/.test(window.location.hash)
    const emptyChat = () => set('data-mg-empty-chat', draftRoute() && document.querySelector(VIEWPORT) && !document.querySelector(MESSAGE) ? '' : null)
    const menu = () => set('data-mg-menu', document.querySelector(MODEL_OPEN) ? 'model' : null)

    const all = () => {
      frame = 0
      surfaces()
      emptyChat()
      menu()
    }

    // Once per frame, before it is painted.
    const soon = () => {
      frame ||= window.requestAnimationFrame(all)
    }

    // ── Titlebar ──
    // TitlebarControls renders its clusters as siblings: the left one (always
    // there unless an overlay owns the window), the pane tools one that holds
    // the surfaces button, and the right one. Their parent's children and each
    // cluster's children are watched; nothing deeper.
    const titlebar = new MutationObserver(() => {
      watchTitlebar()
      surfaces()
    })
    let titlebarParent = null

    const watchTitlebar = () => {
      const parent = document.querySelector('[data-titlebar-cluster]')?.parentElement ?? null

      titlebar.disconnect()
      titlebarParent = parent

      if (!parent) {
        return
      }

      titlebar.observe(parent, { childList: true })

      for (const child of parent.children) {
        if (child.matches('[data-titlebar-cluster], .fixed')) {
          titlebar.observe(child, { childList: true })
        }
      }
    }

    // A route change can mount the clusters anew (an overlay closing), under a
    // parent not watched yet.
    const onChrome = () => {
      window.requestAnimationFrame(() => {
        if (!titlebarParent?.isConnected || titlebarParent !== document.querySelector('[data-titlebar-cluster]')?.parentElement) {
          watchTitlebar()
        }

        surfaces()
      })
    }

    window.addEventListener('hermes:titlebar-chrome-changed', onChrome)
    off.push(() => window.removeEventListener('hermes:titlebar-chrome-changed', onChrome))
    off.push(() => titlebar.disconnect())

    // ── Threads ──
    const threads = new Map() // thread → observer

    const stopThreads = onThreads({
      found: thread => {
        if (threads.has(thread)) {
          return
        }

        const observer = new MutationObserver(records => {
          // Has a message: only a removal can take that away.
          if (!root.hasAttribute('data-mg-empty-chat') && !records.some(record => record.removedNodes.length)) {
            return
          }

          emptyChat()
        })

        observer.observe(thread, { childList: true, subtree: true })
        threads.set(thread, observer)
        emptyChat()

        // The shell may not have been drawn when this started.
        if (!titlebarParent?.isConnected) {
          watchTitlebar()
          surfaces()
        }
      },
      lost: thread => {
        threads.get(thread)?.disconnect()
        threads.delete(thread)
        emptyChat()
      }
    })

    off.push(stopThreads, () => {
      threads.forEach(observer => observer.disconnect())
      threads.clear()
    })

    // ── Route ──
    // A route change with nothing removed from a thread (a draft opened over
    // an empty thread). Hermes' router writes the hash with pushState, which
    // fires no event, so its own session atom is the signal too.
    const onRoute = () => {
      emptyChat()
      soon()
    }

    window.addEventListener('hashchange', onRoute)
    off.push(() => window.removeEventListener('hashchange', onRoute))

    for (const name of ['activeSessionId', 'focusedStoredSessionId']) {
      const stop = sdk.host?.state?.[name]?.listen?.(onRoute)

      if (typeof stop === 'function') {
        off.push(stop)
      }
    }

    // ── Menus ──
    // Radix opens and closes a menu on a pointer press, a key, or a pick;
    // focus moves into the menu and back to its trigger on both. The body's
    // direct children change when a menu's portal mounts or leaves.
    const events = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'focusin', 'focusout']

    for (const type of events) {
      document.addEventListener(type, soon, { capture: true, passive: true })
    }

    off.push(() => events.forEach(type => document.removeEventListener(type, soon, { capture: true })))

    const portals = new MutationObserver(soon)

    portals.observe(document.body, { childList: true })
    off.push(() => portals.disconnect())

    // ── Start ──
    watchTitlebar()
    all()

    return () => {
      off.forEach(undo => undo())
      window.cancelAnimationFrame(frame)
      frame = 0

      if (window[OWNER] !== owner) {
        return
      }

      delete window[OWNER]

      for (const name of ['data-mg-surfaces', 'data-mg-empty-chat', 'data-mg-menu']) {
        root.removeAttribute(name)
      }
    }
  }
})
