// Appearance: Settings > Plugins > Monograph. Everything personal lives here,
// in the user's settings, never in code: name, picture, greeting, how much of
// a reply shows, density and motion. Every change is written through
// setConfig (ctx.storage), so it applies at once and survives a reload.
//
// Also: palette entries "Toggle motion", "Toggle density" and "Open Monograph
// settings", beside the core's "Toggle tool calls".

const AP_NAME_MAX = 60
const AP_GREETING_MAX = 160
const AP_FILE_MAX = 30 * 1024 * 1024
const AP_PICTURE_PX = 128
const AP_PICTURE_MAX = 40 * 1024
const AP_PICTURE_URI = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

// What "Reset to defaults" brings back: the build's defaults for every key
// this page owns. Pinned items and knowledge belong to other modules.
const apDefaults = () => ({
  avatar: typeof DEFAULTS.avatar === 'string' ? DEFAULTS.avatar : '',
  density: DEFAULTS.density === 'compact' ? 'compact' : 'comfortable',
  greeting: typeof DEFAULTS.greeting === 'string' ? DEFAULTS.greeting : '',
  motion: DEFAULTS.motion === 'off' ? 'off' : 'on',
  name: typeof DEFAULTS.name === 'string' ? DEFAULTS.name : '',
  thinking: DEFAULTS.thinking === 'line' ? 'line' : 'live',
  tools: DEFAULTS.tools === 'hidden' ? 'hidden' : 'shown'
})

// One line of plain text: no control characters (they would also break the
// CSS string the greeting is drawn from), and a length cap.
const apText = (value, max) =>
  Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '))
    .slice(0, max)
    .join('')

const apMotion = current => (current.motion === 'off' ? 'off' : 'on')
const apDensity = current => (current.density === 'compact' ? 'compact' : 'comfortable')
const apPicture = current => (typeof current.avatar === 'string' && AP_PICTURE_URI.test(current.avatar) ? current.avatar : '')
const apInitial = current => Array.from(String(current.name ?? '').trim())[0]?.toLocaleUpperCase() ?? ''

const useApConfig = () => useSyncExternalStore(subscribe, getConfig)

class ApPictureError extends Error {}

// A chosen file becomes a square picture: the centre square, scaled down to
// at most 128 px, as a data URI under 40 KB.
async function apPictureFrom(file) {
  if (!file) {
    throw new ApPictureError('No file was chosen.')
  }

  if (file.size > AP_FILE_MAX) {
    throw new ApPictureError(`That file is ${Math.round(file.size / (1024 * 1024))} MB. Choose an image under 30 MB.`)
  }

  if (file.type && !file.type.startsWith('image/')) {
    throw new ApPictureError('That file is not an image. Choose a PNG, JPEG, WebP or GIF.')
  }

  const url = URL.createObjectURL(file)

  try {
    const image = new Image()

    image.decoding = 'async'
    image.src = url

    try {
      await image.decode()
    } catch {
      throw new ApPictureError('That file could not be read as an image. Choose a PNG, JPEG, WebP or GIF.')
    }

    const width = image.naturalWidth
    const height = image.naturalHeight

    if (!width || !height) {
      throw new ApPictureError('That image has no size. Choose another one.')
    }

    const side = Math.min(width, height)
    const out = Math.max(1, Math.min(AP_PICTURE_PX, side))
    const canvas = document.createElement('canvas')

    canvas.width = out
    canvas.height = out

    const pen = canvas.getContext('2d')

    if (!pen) {
      throw new ApPictureError('The picture could not be drawn. Try again.')
    }

    pen.imageSmoothingEnabled = true
    pen.imageSmoothingQuality = 'high'
    pen.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, out, out)

    for (const [type, quality] of [
      ['image/webp', 0.9],
      ['image/webp', 0.75],
      ['image/webp', 0.55],
      ['image/jpeg', 0.85],
      ['image/jpeg', 0.6],
      ['image/jpeg', 0.4]
    ]) {
      const uri = canvas.toDataURL(type, quality)

      if (uri.startsWith(`data:${type};base64,`) && uri.length <= AP_PICTURE_MAX) {
        return { side: out, uri }
      }
    }

    throw new ApPictureError('That image could not be made small enough. Choose a simpler one.')
  } finally {
    URL.revokeObjectURL(url)
  }
}

// The user's picture, or the first letter of their name. Other modules may
// draw it too: SHARED.Avatar, with a `size` in px.
function ApAvatar({ size = 40 }) {
  const current = useApConfig()
  const picture = apPicture(current)
  const letter = apInitial(current)
  const style = { '--mg-ap-avatar': `${size}px` }

  if (picture) {
    return jsx('img', { alt: '', className: 'mg-ap-avatar', 'data-mg-avatar': 'picture', draggable: false, src: picture, style })
  }

  return jsx('span', {
    'aria-hidden': true,
    className: 'mg-ap-avatar',
    'data-mg-avatar': letter ? 'letter' : 'blank',
    style,
    children: letter || jsx('i', { className: 'codicon codicon-account' })
  })
}

SHARED.Avatar = ApAvatar

// Hermes' own parts where this Hermes has them, flat stand-ins otherwise.
function ApRow({ action, below, description, id, title }) {
  if (sdk.ListRow) {
    return jsx(sdk.ListRow, { action, below, description, id, title })
  }

  return jsxs('div', {
    className: 'mg-ap-row',
    id,
    children: [
      jsxs('div', {
        className: 'mg-ap-row-text',
        children: [jsx('div', { className: 'mg-ap-row-title', children: title }), description ? jsx('div', { className: 'mg-ap-row-description', children: description }) : null, below]
      }),
      jsx('div', { className: 'mg-ap-row-action', children: action })
    ]
  })
}

function ApToggle({ checked, description, id, label, onChange }) {
  if (sdk.ToggleRow) {
    return jsx(sdk.ToggleRow, { checked, description, id, label, onChange })
  }

  return jsx(ApRow, {
    action: jsx('input', { 'aria-label': label, checked, className: 'mg-ap-check', onChange: event => onChange(event.target.checked), type: 'checkbox' }),
    description,
    id,
    title: label
  })
}

function ApInput(props) {
  return jsx(sdk.Input ?? 'input', { ...props, className: `mg-ap-input${sdk.Input ? '' : ' mg-ap-input-flat'}` })
}

function ApButton({ children, ...props }) {
  if (sdk.Button) {
    return jsx(sdk.Button, { size: 'sm', type: 'button', variant: 'outline', ...props, children })
  }

  return jsx('button', { ...props, className: 'mg-ap-button', type: 'button', children })
}

function ApChoice({ label, onChange, options, value }) {
  if (sdk.SegmentedControl) {
    return jsx('div', { 'aria-label': label, className: 'mg-ap-choice', role: 'group', children: jsx(sdk.SegmentedControl, { onChange, options, value }) })
  }

  return jsx('div', {
    'aria-label': label,
    className: 'mg-ap-choice mg-ap-choice-flat',
    role: 'group',
    children: options.map(option =>
      jsx('button', { 'aria-pressed': option.id === value, onClick: () => onChange(option.id), type: 'button', children: option.label }, option.id)
    )
  })
}

function ApPictureRow() {
  const current = useApConfig()
  const picture = apPicture(current)
  const [note, setNote] = useState(null) // { kind: 'error' | 'busy' | 'done', text }
  const input = React.useRef(null)
  const ticket = React.useRef(0)

  const choose = async event => {
    const file = event.target.files?.[0]
    const mine = ++ticket.current

    // Let the same file be chosen again after a removal.
    event.target.value = ''

    if (!file) {
      return
    }

    setNote({ kind: 'busy', text: 'Reading the image.' })

    try {
      const { side, uri } = await apPictureFrom(file)

      if (mine === ticket.current) {
        setConfig({ avatar: uri })
        setNote({ kind: 'done', text: `Saved as a ${side} px square, ${(uri.length / 1024).toFixed(1)} KB.` })
      }
    } catch (error) {
      if (mine === ticket.current) {
        setNote({ kind: 'error', text: error instanceof ApPictureError ? error.message : 'That image could not be used. Choose another one.' })
      }
    }
  }

  const remove = () => {
    ticket.current += 1
    setConfig({ avatar: '' })
    setNote(null)
  }

  return jsx(ApRow, {
    action: jsxs('div', {
      className: 'mg-ap-picture',
      children: [
        jsx(ApAvatar, { size: 40 }),
        jsx(ApButton, { 'data-mg-ap': 'choose', onClick: () => input.current?.click(), children: picture ? 'Change' : 'Choose image' }),
        jsx(ApButton, { 'data-mg-ap': 'remove', disabled: !picture, onClick: remove, children: 'Remove' }),
        jsx('input', {
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          'aria-hidden': true,
          className: 'mg-ap-file',
          'data-mg-ap': 'file',
          hidden: true,
          onChange: choose,
          ref: input,
          tabIndex: -1,
          type: 'file'
        })
      ]
    }),
    below: jsx('div', { 'aria-live': 'polite', className: 'mg-ap-note', 'data-kind': note?.kind ?? 'none', 'data-mg-ap': 'picture-note', role: 'status', children: note?.text ?? '' }),
    description: 'Cropped to a square and scaled down to 128 px. Without one, the first letter of your name stands in.',
    id: 'monograph-picture',
    title: 'Picture'
  })
}

// A destructive step, so it asks first. Built from Hermes' dialog parts
// rather than its ConfirmDialog, which confirms on Enter or Space wherever
// focus is, Cancel included. Here focus starts on Cancel, Enter presses the
// focused button, Escape closes, and focus goes back to Reset.
function ApResetRow() {
  const [open, setOpen] = useState(false)
  const cancel = React.useRef(null)
  const description = 'Name, picture, greeting, tool calls, thinking, density and motion go back to how Monograph ships.'
  const parts = sdk.Dialog && sdk.DialogTrigger && sdk.DialogContent && sdk.DialogTitle && sdk.Button

  const reset = () => {
    setConfig(apDefaults())
    setOpen(false)
  }

  if (parts) {
    return jsx(ApRow, {
      action: jsxs(sdk.Dialog, {
        onOpenChange: setOpen,
        open,
        children: [
          jsx(sdk.DialogTrigger, { asChild: true, children: jsx(ApButton, { 'data-mg-ap': 'reset', children: 'Reset' }) }),
          jsxs(sdk.DialogContent, {
            className: 'mg-ap-dialog max-w-md',
            'data-mg-ap': 'reset-dialog',
            onOpenAutoFocus: event => {
              event.preventDefault()
              cancel.current?.focus()
            },
            children: [
              jsxs(sdk.DialogHeader ?? 'div', {
                children: [
                  jsx(sdk.DialogTitle, { children: 'Reset Monograph to its defaults?' }),
                  sdk.DialogDescription
                    ? jsx(sdk.DialogDescription, { children: 'This clears your name, picture and greeting, and turns tool calls, thinking, density and motion back to their defaults.' })
                    : null
                ]
              }),
              jsxs(sdk.DialogFooter ?? 'div', {
                children: [
                  jsx(sdk.Button, { 'data-mg-ap': 'reset-cancel', onClick: () => setOpen(false), ref: cancel, type: 'button', variant: 'ghost', children: 'Cancel' }),
                  jsx(sdk.Button, { 'data-mg-ap': 'reset-confirm', onClick: reset, type: 'button', variant: 'destructive', children: 'Reset' })
                ]
              })
            ]
          })
        ]
      }),
      description,
      id: 'monograph-reset',
      title: 'Reset to defaults'
    })
  }

  return jsx(ApRow, {
    action: open
      ? jsxs('div', {
          className: 'mg-ap-picture',
          children: [
            jsx(ApButton, { 'data-mg-ap': 'reset-cancel', onClick: () => setOpen(false), children: 'Cancel' }),
            jsx(ApButton, { 'data-mg-ap': 'reset-confirm', onClick: reset, children: 'Reset' })
          ]
        })
      : jsx(ApButton, { 'data-mg-ap': 'reset', onClick: () => setOpen(true), children: 'Reset' }),
    description,
    id: 'monograph-reset',
    title: 'Reset to defaults'
  })
}

function AppearancePage() {
  const current = useApConfig()
  const builtIn = greeting({ ...current, greeting: '' })

  return jsxs('div', {
    className: 'mg-ap',
    'data-mg-ap': 'page',
    children: [
      jsxs('section', {
        'aria-labelledby': 'mg-ap-you',
        className: 'mg-ap-section',
        children: [
          jsx('h3', { className: 'mg-ap-heading', id: 'mg-ap-you', children: 'You' }),
          jsx(ApRow, {
            action: jsx(ApInput, {
              'aria-label': 'Name',
              'data-mg-ap': 'name',
              maxLength: AP_NAME_MAX,
              onChange: event => setConfig({ name: apText(event.target.value, AP_NAME_MAX) }),
              placeholder: 'Your name',
              spellCheck: false,
              type: 'text',
              value: typeof current.name === 'string' ? current.name : ''
            }),
            description: 'Used in the greeting and for the letter in place of a picture.',
            id: 'monograph-name',
            title: 'Name'
          }),
          jsx(ApPictureRow, {}),
          jsx(ApRow, {
            // The preview sits under the field, beside it on a wide pane and
            // under it on a narrow one.
            action: jsxs('div', {
              className: 'mg-ap-field',
              children: [
                jsx(ApInput, {
                  'aria-label': 'Greeting',
                  'data-mg-ap': 'greeting',
                  maxLength: AP_GREETING_MAX,
                  onChange: event => setConfig({ greeting: apText(event.target.value, AP_GREETING_MAX) }),
                  placeholder: builtIn,
                  spellCheck: false,
                  type: 'text',
                  value: typeof current.greeting === 'string' ? current.greeting : ''
                }),
                jsxs('div', {
                  className: 'mg-ap-preview',
                  children: [jsx('span', { className: 'mg-ap-preview-label', children: 'Preview' }), jsx('span', { 'data-mg-ap': 'preview', children: greeting(current) })]
                })
              ]
            }),
            description: 'The line an empty chat opens with. {name} stands for your name. Leave it empty for the built-in line.',
            id: 'monograph-greeting',
            title: 'Greeting'
          })
        ]
      }),
      jsxs('section', {
        'aria-labelledby': 'mg-ap-chat',
        className: 'mg-ap-section',
        children: [
          jsx('h3', { className: 'mg-ap-heading', id: 'mg-ap-chat', children: 'Chat' }),
          jsx(ToolCallsRow, {}),
          jsx(ApRow, {
            action: jsx(ApChoice, {
              label: 'Thinking',
              onChange: id => setConfig({ thinking: id === 'line' ? 'line' : 'live' }),
              options: [
                { id: 'live', label: 'Live' },
                { id: 'line', label: 'Hidden' }
              ],
              value: thinkingMode(current)
            }),
            description: 'Live shows the reasoning as a few dim lines while the model works, folded away once the answer starts. Hidden shows none of it until the turn ends; the reasoning stays under "Worked for".',
            id: 'monograph-thinking',
            title: 'Thinking'
          }),
          jsx(ApRow, {
            action: jsx(ApChoice, {
              label: 'Density',
              onChange: id => setConfig({ density: id === 'compact' ? 'compact' : 'comfortable' }),
              options: [
                { id: 'comfortable', label: 'Comfortable' },
                { id: 'compact', label: 'Compact' }
              ],
              value: apDensity(current)
            }),
            description: 'Compact tightens the space between turns, tool rows, paragraphs and sidebar rows. The composer and the top band keep their size.',
            id: 'monograph-density',
            title: 'Density'
          })
        ]
      }),
      jsxs('section', {
        'aria-labelledby': 'mg-ap-motion',
        className: 'mg-ap-section',
        children: [
          jsx('h3', { className: 'mg-ap-heading', id: 'mg-ap-motion', children: 'Motion' }),
          jsx(ApToggle, {
            checked: apMotion(current) === 'on',
            description: 'Fades and slides across Monograph. When the system is set to reduce motion, nothing moves, whatever this says.',
            id: 'monograph-motion',
            label: 'Animations',
            onChange: on => setConfig({ motion: on ? 'on' : 'off' })
          })
        ]
      }),
      jsx('section', { className: 'mg-ap-section mg-ap-section-last', children: jsx(ApResetRow, {}) })
    ]
  })
}

SHARED.settingsPage = AppearancePage

MODULES.push({
  id: 'appearance',
  start(ctx) {
    const undo = []

    // The name used to come only from the build's defaults (config.local.json).
    // The page holds it now: a name that was never typed in is written into
    // the user's settings once, so it stays when the build stops carrying it.
    // A name the user typed (even an empty one) is never touched.
    if (typeof DEFAULTS.name === 'string' && DEFAULTS.name && typeof saved?.name !== 'string') {
      setConfig({ name: DEFAULTS.name })
    }

    if (sdk.PALETTE_AREA && typeof ctx.register === 'function') {
      const add = data => {
        const stop = ctx.register({ area: sdk.PALETTE_AREA, data, id: data.id })

        if (typeof stop === 'function') {
          undo.push(stop)
        }
      }

      add({
        detail: () => apMotion(getConfig()),
        detailVariant: 'state',
        id: 'monograph-toggle-motion',
        keepOpen: true,
        keywords: ['monograph', 'motion', 'animation', 'reduce', 'on', 'off'],
        label: 'Toggle motion',
        run: () => setConfig({ motion: apMotion(getConfig()) === 'on' ? 'off' : 'on' })
      })

      add({
        detail: () => apDensity(getConfig()),
        detailVariant: 'state',
        id: 'monograph-toggle-density',
        keepOpen: true,
        keywords: ['monograph', 'density', 'compact', 'comfortable', 'spacing'],
        label: 'Toggle density',
        run: () => setConfig({ density: apDensity(getConfig()) === 'compact' ? 'comfortable' : 'compact' })
      })

      // Hermes has no app action for a plugin's settings page, but it builds
      // the route for one.
      if (typeof sdk.pluginSettingsHref === 'function' && typeof sdk.host?.navigate === 'function') {
        add({
          id: 'monograph-open-settings',
          keywords: ['monograph', 'appearance', 'settings', 'name', 'picture', 'avatar', 'greeting', 'thinking', 'reasoning', 'density', 'motion'],
          label: 'Open Monograph settings',
          run: () => sdk.host.navigate(sdk.pluginSettingsHref(ID))
        })
      }
    }

    // A second window shares this storage. When the other window changes a
    // setting, the browser tells this one (a storage event, only ever from
    // another window), and the change is applied here too. Only the keys that
    // differ are written; a write that changes nothing raises no event, so the
    // two windows settle after one round.
    const key = `hermes.plugin.${ID}.config`
    const fromOtherWindow = event => {
      if (event.key !== key || event.storageArea !== window.localStorage || !event.newValue) {
        return
      }

      let next = null

      try {
        next = JSON.parse(event.newValue)
      } catch {
        return
      }

      if (!next || typeof next !== 'object') {
        return
      }

      const current = getConfig()
      const changed = Object.fromEntries(Object.entries(next).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(current[name])))

      if (Object.keys(changed).length) {
        setConfig(changed)
      }
    }

    window.addEventListener('storage', fromOtherWindow)
    undo.push(() => window.removeEventListener('storage', fromOtherWindow))

    return () => {
      for (const stop of undo.splice(0)) {
        try {
          stop()
        } catch {
          // Already gone with the plugin's own contributions.
        }
      }
    }
  }
})
