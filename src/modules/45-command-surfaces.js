// A tap, not a keybinding chord: observe the real input and leave its defaults
// alone. The titlebar picker stays the owner of menu state and focus.
const surfaceKeyOptions = [
  { id: 'command', label: '⌘ Command', key: 'Meta', flag: 'metaKey' },
  { id: 'option', label: '⌥ Option', key: 'Alt', flag: 'altKey' },
  { id: 'control', label: '⌃ Control', key: 'Control', flag: 'ctrlKey' },
  { id: 'off', label: 'Off' }
]
const surfaceKeyOption = value => surfaceKeyOptions.find(option => option.id === value) ?? surfaceKeyOptions[0]
const surfaceKeySupported = () => /mac/i.test(navigator.platform)

// The builder gives each feature a private scope. Settings consumes only
// this exposed interface, not this module's private bindings.
SHARED.surfaceKey = { options: surfaceKeyOptions, option: surfaceKeyOption, supported: surfaceKeySupported }

MODULES.push({
  id: 'command-surfaces',
  start() {
    if (!surfaceKeySupported()) {
      return undefined
    }

    const maxTapMs = 500
    const releaseGraceMs = 80
    let option = surfaceKeyOption(getConfig().surfaceKey)
    const matches = event => option.key && event.key === option.key &&
      (event.code === `${option.key}Left` || event.code === `${option.key}Right`)
    const flags = ['metaKey', 'altKey', 'ctrlKey', 'shiftKey']
    const otherModifiers = event => event.isComposing || flags.some(flag => flag !== option.flag && event[flag])
    let pressed = null
    let queued

    function cancel() {
      pressed = null
      window.clearTimeout(queued)
      queued = undefined
    }

    const stopSettings = subscribe(() => {
      const next = surfaceKeyOption(getConfig().surfaceKey)
      if (next !== option) {
        cancel()
        option = next
      }
    })

    function down(event) {
      if (!event.isTrusted) {
        return
      }

      if (pressed && matches(event) && event.repeat && event.code === pressed.code) {
        return
      }

      const wasPressed = Boolean(pressed)
      cancel()

      if (!wasPressed && matches(event) && event[option.flag] && !event.repeat && !otherModifiers(event)) {
        pressed = { code: event.code, at: event.timeStamp }
      }
    }

    function up(event) {
      if (!event.isTrusted) {
        return
      }

      const tap = pressed && matches(event) && pressed.code === event.code && !event[option.flag] &&
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
      stopSettings()
      cancel()
      for (const [target, type, listener] of listeners) {
        target.removeEventListener(type, listener, capture)
      }
    }
  }
})
