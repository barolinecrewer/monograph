// A repo-first lens over Hermes' existing chats. Hermes owns worktree creation,
// chat cwd, and Git review; the published SDK doesn't expose the worktree
// dialog or a "start chat in cwd" action. No synthetic shortcuts or private IPC.
const CODING_PANE = 'coding-workspace'
const CODING_PANE_ID = `${ID}:${CODING_PANE}`
const CODING_LIMIT = 200
const sessionTime = row => Number(row.last_active || row.started_at) || 0

function codingGroups(sessions) {
  const groups = new Map()
  const seen = new Set()

  for (const row of [...sessions].sort((a, b) => sessionTime(b ?? {}) - sessionTime(a ?? {}))) {
    const root = typeof row?.git_repo_root === 'string' ? row.git_repo_root.trim() : ''

    if (!root || !row?.cwd || !row.id || row.hidden || row.archived || seen.has(row.id)) {
      continue
    }

    seen.add(row.id)

    if (!groups.has(root)) {
      groups.set(root, [])
    }

    groups.get(root).push(row)
  }

  return [...groups]
}

function codingProfile(connectionId, activeProfile, owner) {
  // The persisted session endpoint gives profile=all cross-profile semantics,
  // even if a local profile was literally named "all".
  return activeProfile && activeProfile !== 'all' && connectionId === 'local' &&
    owner?.connectionId === 'local' && owner.profile === activeProfile ? activeProfile : null
}

function CodingPane({ close, open, review, onChanged }) {
  const host = sdk.host
  const owner = useAtom(host.state.focusedSessionOwner)
  const focused = useAtom(host.state.focusedStoredSessionId)
  const localProfile = codingProfile(useAtom(host.state.connectionId), useAtom(host.state.profile), owner)
  const [result, setResult] = useState(null)
  const route = { connectionId: 'local', mode: 'local', profile: localProfile, targetProfile: localProfile }

  useEffect(() => {
    if (!localProfile) {
      return undefined
    }

    let active = true
    let revision = 0
    const refresh = async () => {
      const request = ++revision

      try {
        const response = await host.listPersistedSessions(route, { profile: localProfile, limit: CODING_LIMIT })

        if (active && revision === request) {
          const { sessions, total, errors } = response

          setResult({ profile: localProfile, groups: codingGroups(sessions), partial: total > sessions.length || Boolean(errors?.length) })
        }
      } catch {
        if (active && revision === request) {
          setResult({ profile: localProfile, error: true })
        }
      }
    }

    void refresh()
    let timer
    const stop = onChanged(() => {
      if (!timer) {
        timer = window.setTimeout(() => {
          timer = undefined
          void refresh()
        }, 120)
      }
    })

    return () => {
      active = false
      window.clearTimeout(timer)
      stop?.()
    }
  }, [localProfile, focused, onChanged])

  const current = localProfile && result?.profile === localProfile ? result : null
  const groups = current?.groups ?? []

  return jsxs('section', {
    className: 'mg-coding',
    'aria-label': 'Coding workspace',
    children: [
      jsxs('div', {
        className: 'mg-coding-tools',
        children: [
          jsx('strong', { children: 'Coding workspace' }),
          jsx('button', { type: 'button', onClick: close, 'aria-label': 'Close coding workspace', children: '×' })
        ]
      }),
      jsx('p', { children: 'Start isolated work from a project’s New worktree action in the Hermes sidebar. For the current checkout, use New chat inside the project instead.' }),
      review && localProfile ? jsx('button', { type: 'button', className: 'mg-coding-review', onClick: review, children: 'Toggle Git review' }) : null,
      !localProfile ? jsx('p', { role: 'status', children: owner?.profile === 'all'
        ? 'Coding workspace cannot list a profile named “all”; Hermes reserves that name for cross-profile reads.'
        : 'Select a chat on the active local Hermes profile to see its coding threads.' }) : null,
      localProfile && !current ? jsx('p', { role: 'status', children: 'Loading coding threads…' }) : null,
      current?.error ? jsx('p', { role: 'status', children: 'Could not load coding threads. Close and reopen this pane to retry.' }) : null,
      current && !current.error && !groups.length ? jsx('p', { children: 'No saved Git threads in this profile yet. Send a message in a project or worktree to get started.' }) : null,
      current?.partial ? jsx('p', { children: 'Only some saved threads were loaded. Use the Hermes sidebar for older threads.' }) : null,
      ...groups.map(([root, rows]) => jsxs('div', {
        className: 'mg-coding-repo',
        children: [
          jsx('h3', { title: root, children: root.split(/[\\/]/).filter(Boolean).at(-1) || root }),
          ...rows.map(row => jsxs('button', {
            type: 'button',
            title: row.cwd,
            className: 'mg-coding-thread',
            'data-mg-coding-thread': row.id,
            'aria-current': row.id === focused || row._lineage_ids?.includes(focused) ? 'true' : undefined,
            onClick: () => open(row, localProfile),
            children: [
              jsx('span', { children: row.title || 'Untitled thread' }),
              jsx('small', { children: row.git_branch || row.cwd })
            ]
          }, row.id))
        ]
      }, root))
    ]
  })
}

MODULES.push({
  id: CODING_PANE,
  start(ctx) {
    const host = sdk.host

    if (!host?.state?.focusedSessionOwner || !host.state.focusedStoredSessionId ||
        !host.state.connectionId || !host.state.profile ||
        typeof host.listPersistedSessions !== 'function' || typeof host.openSession !== 'function' ||
        typeof host.revealPane !== 'function') {
      return undefined
    }

    let unregister = null
    let frame = 0
    let generation = 0
    let opening = false
    const activeProfile = () => codingProfile(host.state.connectionId.get(), host.state.profile.get(), host.state.focusedSessionOwner.get())
    const close = () => {
      ++generation
      opening = false
      window.cancelAnimationFrame(frame)
      unregister?.()
      unregister = null
    }
    const onChanged = callback => ctx.onEvent?.('sessions.changed', callback)
    const open = async (row, profile) => {
      if (!profile || activeProfile() !== profile) {
        return
      }

      const request = ++generation
      opening = true

      try {
        // Review follows the main cwd. Omit route/profile so the SDK does not
        // switch the sidebar to All Profiles on an ordinary local open.
        await host.openSession(row.id, { awaitHydration: true, intent: 'main' })

        if (generation === request && activeProfile() === profile) {
          // A same-route open of the main chat doesn't front it by itself.
          host.revealPane('workspace')
        }
      } catch (error) {
        if (generation === request && !/superseded by a newer selection/i.test(String(error?.message))) {
          host.notify?.({ kind: 'error', message: 'Could not open that coding thread.' })
        }
      } finally {
        if (generation === request) {
          opening = false
        }
      }
    }
    const review = ctx.listActions?.().some(action => action.id === 'view.toggleReview')
      ? async () => {
          if (opening || !activeProfile()) {
            return
          }

          const result = await ctx.runAction('view.toggleReview')

          if (!result.ok) {
            host.notify?.({ kind: 'error', message: 'Git review is not available here.' })
          }
        }
      : null
    const show = () => {
      if (!unregister) {
        unregister = ctx.register({
          area: 'panes', id: CODING_PANE, title: 'Coding workspace',
          data: { placement: 'left', uncloseable: true, width: '260px' },
          render: () => jsx(CodingPane, { close, open, review, onChanged })
        })
      }

      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        host.undismissPane?.(CODING_PANE_ID)
        host.revealPane(CODING_PANE_ID)
      })
    }
    const row = { icon: 'repo', key: CODING_PANE, label: 'Coding workspace', letter: 'w', rank: 3, run: show }

    SHARED.surfaces.push(row)

    return () => {
      close()
      const index = SHARED.surfaces.indexOf(row)

      if (index !== -1) {
        SHARED.surfaces.splice(index, 1)
      }
    }
  }
})
