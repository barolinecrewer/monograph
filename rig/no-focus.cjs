// Loaded into the sandboxed app's main process (electron -r, see boot() in
// harness.mjs). The rig's window must never take the keyboard: whoever is at
// the machine keeps typing where they were, and their keys cannot land in a
// test. Hermes reveals its window with showInactive() and then focus(); only
// the second half is switched off here. The page is told it has focus through
// the debugging protocol instead (see boot() in harness.mjs).
if (process.versions.electron && process.type === 'browser') {
  try {
    const { app, BrowserWindow } = require('electron')

    BrowserWindow.prototype.focus = function () {}
    BrowserWindow.prototype.show = function () {
      this.showInactive()
    }
    app.focus = () => {}

    // macOS brings a newly started app to the front on its own. An accessory
    // app is left where it is: no Dock icon, no activation, windows as usual.
    if (process.platform === 'darwin') {
      app.setActivationPolicy('accessory')
    }

    // A window that is covered by another one, or by whatever the person at
    // the machine has in front, must go on drawing: the checks time animations.
    app.on('browser-window-created', (_event, win) => {
      win.webContents.setBackgroundThrottling(false)
    })
  } catch (error) {
    console.error('[rig] no-focus hook not applied:', error?.message ?? error)
  }
}
