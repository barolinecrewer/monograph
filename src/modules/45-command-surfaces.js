// A tap, not a keybinding chord: observe the real input and leave its defaults
// alone. The titlebar picker stays the owner of menu state and focus.
MODULES.push({
  id: 'command-surfaces',
  start() {
    if (!/mac/i.test(navigator.platform)) {
      return undefined
    }

    const maxTapMs = 500
    const releaseGraceMs = 80
    const command = event => event.key === 'Meta' && (event.code === 'MetaLeft' || event.code === 'MetaRight')
    const otherModifiers = event => event.ctrlKey || event.altKey || event.shiftKey || event.isComposing
    let pressed = null
    let queued

    function cancel() {
      pressed = null
      window.clearTimeout(queued)
      queued = undefined
    }

    function down(event) {
      if (!event.isTrusted) {
        return
      }

      if (pressed && command(event) && event.repeat && event.code === pressed.code) {
        return
      }

      const wasPressed = Boolean(pressed)
      cancel()

      if (!wasPressed && command(event) && event.metaKey && !event.repeat && !otherModifiers(event)) {
        pressed = { code: event.code, at: event.timeStamp }
      }
    }

    function up(event) {
      if (!event.isTrusted) {
        return
      }

      const tap = pressed && command(event) && pressed.code === event.code && !event.metaKey &&
        !otherModifiers(event) && event.timeStamp - pressed.at <= maxTapMs
      cancel()

      if (tap) {
        // Some native accelerators swallow the chord's keydown. Give its
        // remaining keyup a chance to cancel, regardless of release order.
        queued = window.setTimeout(() => {
          queued = undefined
          openSurfaces?.(true)
        }, releaseGraceMs)
      }
    }

    const capture = { capture: true, passive: true }
    // An accelerator can also reveal itself by changing focus, navigating,
    // resizing or running a clipboard action without exposing its keydown.
    const cancelEvents = ['blur', 'focusin', 'hashchange', 'resize', 'copy', 'cut', 'paste', 'pointerdown', 'wheel']
    const listeners = [
      [window, 'keydown', down],
      [window, 'keyup', up],
      ...cancelEvents.map(type => [window, type, cancel]),
      [document, 'visibilitychange', cancel]
    ]
    for (const [target, type, listener] of listeners) {
      target.addEventListener(type, listener, capture)
    }

    return () => {
      cancel()
      for (const [target, type, listener] of listeners) {
        target.removeEventListener(type, listener, capture)
      }
    }
  }
})
