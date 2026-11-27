import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

function load(host, runAction = () => ({ ok: true })) {
  const source = readFileSync(new URL('../src/modules/40-coding-workspace.js', import.meta.url), 'utf8')
  const MODULES = []
  const SHARED = { surfaces: [] }
  const calls = []
  const events = new Map()
  const ctx = {
    onEvent(name, callback) { events.set(name, callback); return () => events.delete(name) },
    listActions: () => [{ id: 'view.toggleReview' }],
    runAction: async id => { calls.push(id); return runAction(id) },
    register: spec => { calls.push(spec); return () => calls.push('unregister') }
  }
  const jsx = (type, props) => ({ type, props })
  const state = { value: null }
  runInNewContext(source, {
    ID: 'monograph', MODULES, SHARED, sdk: { host }, jsx, jsxs: jsx,
    useAtom: atom => atom.get(),
    useState: () => [state.value, value => { state.value = value }],
    useEffect(callback, deps) {
      if (!state.deps || deps.some((value, index) => value !== state.deps[index])) {
        state.dispose?.()
        state.deps = deps
        state.dispose = callback()
      }
    },
    window: {
      requestAnimationFrame: cb => { calls.push(cb); return 1 }, cancelAnimationFrame: () => {},
      setTimeout: (cb, delay) => setTimeout(cb, delay), clearTimeout
    }
  })
  return { calls, ctx, events, SHARED, state, stop: MODULES[0].start(ctx) }
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(item => find(item, predicate)).find(Boolean)
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

function atom(get) { return { get, listen: () => () => {} } }

function hostWith(sessions, extra = {}) {
  return {
    state: {
      connectionId: atom(() => 'local'),
      profile: atom(() => 'default'),
      focusedSessionOwner: atom(() => ({ connectionId: 'local', profile: 'default' })),
      focusedStoredSessionId: atom(() => null)
    },
    listPersistedSessions: async () => ({ sessions, total: sessions.length }),
    openSession: async () => {},
    revealPane: () => {},
    ...extra
  }
}

function openPanel(env) {
  const row = env.SHARED.surfaces.find(row => row.key === 'coding-workspace')
  assert.ok(row)
  row.run()
  const spec = env.calls.find(call => call.area === 'panes')
  const component = spec.render()
  return () => component.type(component.props)
}

const settle = () => new Promise(resolve => setImmediate(resolve))

// The host double checks the documented Desktop seam. Git operations run for real.
test('selecting two threads from one repo opens each stored conversation in main and reviews only its checkout', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'monograph-coding-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  const a = join(dir, 'thread a')
  const b = join(dir, 'thread b')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  git(dir, 'init', '-q', repo)
  writeFileSync(join(repo, 'tracked.txt'), 'base\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base')
  git(repo, 'worktree', 'add', '-qb', 'thread-a', a)
  git(repo, 'worktree', 'add', '-qb', 'thread-b', b)
  writeFileSync(join(a, 'tracked.txt'), 'only thread A\n')
  writeFileSync(join(b, 'tracked.txt'), 'only thread B\n')
  const sessions = [
    { id: 'a', title: 'Thread A', cwd: a, git_repo_root: repo, git_branch: 'thread-a' },
    { id: 'b', title: 'Thread B', cwd: b, git_repo_root: repo, git_branch: 'thread-b' },
    { id: 'hidden', title: 'Hidden', cwd: a, git_repo_root: repo, hidden: true },
    { id: 'plain', title: 'Detached', cwd: dir }
  ]
  let focused = null
  const opened = []
  const revealed = []
  const host = hostWith(sessions, {
    revealPane: pane => revealed.push(pane),
    async openSession(id, options) {
      assert.equal(options.intent, 'main')
      assert.equal(options.awaitHydration, true)
      assert.equal(options.route, undefined, 'no explicit route: preserve the sidebar profile scope')
      assert.equal(options.profile, undefined, 'navigate on the active profile without switching chrome')
      opened.push(id)
      focused = id
    }
  })
  host.state.focusedStoredSessionId = atom(() => focused)
  let diff = ''
  const env = load(host, action => {
    assert.equal(action, 'view.toggleReview')
    diff = git(sessions.find(session => session.id === focused).cwd, 'diff', '--', 'tracked.txt')
    return { ok: true }
  })
  const draw = openPanel(env)
  draw()
  await settle()
  const ready = env.state.value
  const render = () => { env.state.value = ready; return draw() }
  assert.ok(find(render(), el => el.props.title === repo), 'one group uses the repo root, not the checkout path')
  assert.equal(find(render(), el => el.props['data-mg-coding-thread'] === 'hidden'), undefined)
  assert.equal(find(render(), el => el.props['data-mg-coding-thread'] === 'plain'), undefined)
  for (const [id, wanted, wrong] of [['a', 'A', 'B'], ['b', 'B', 'A']]) {
    const row = find(render(), el => el.props['data-mg-coding-thread'] === id)
    assert.ok(row, `thread ${id} is in the repo group`)
    await row.props.onClick()
    assert.equal(find(render(), el => el.props['data-mg-coding-thread'] === id).props['aria-current'], 'true')
    await find(render(), el => el.props.className === 'mg-coding-review').props.onClick()
    assert.match(diff, new RegExp(`^\\+only thread ${wanted}$`, 'm'))
    assert.doesNotMatch(diff, new RegExp(`^\\+only thread ${wrong}$`, 'm'))
  }
  assert.deepEqual(opened, ['a', 'b'])
  assert.deepEqual(revealed, ['workspace', 'workspace'], 're-front main even when a split tile covered the chat')
  assert.equal(git(repo, 'status', '--porcelain'), '')
  env.stop()
})

test('a persisted session change refreshes the pane without switching threads', async () => {
  const rows = [{ id: 'a', title: 'Before', cwd: '/checkout', git_repo_root: '/repo' }]
  const env = load(hostWith(rows))
  const draw = openPanel(env)
  draw()
  await settle()
  assert.ok(find(draw(), el => el.props.children === 'Before'))
  rows[0] = { ...rows[0], title: 'After' }
  assert.equal(typeof env.events.get('sessions.changed'), 'function')
  env.events.get('sessions.changed')()
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.ok(find(draw(), el => el.props.children === 'After'))
  env.state.dispose?.()
  assert.ok(!env.events.has('sessions.changed'))
  env.stop()
})

test('a local profile named all never triggers an all-profiles read', () => {
  let reads = 0
  const host = hostWith([], { listPersistedSessions: async () => { reads += 1; return { sessions: [] } } })
  host.state.profile = atom(() => 'all')
  host.state.focusedSessionOwner = atom(() => ({ connectionId: 'local', profile: 'all' }))
  const env = load(host)
  const draw = openPanel(env)
  const panel = draw()
  assert.ok(find(panel, el => typeof el.props.children === 'string' && el.props.children.includes('cross-profile reads')))
  assert.equal(find(panel, el => el.props.className === 'mg-coding-review'), undefined)
  assert.equal(reads, 0)
  env.stop()
})

test('closing the workspace unregisters its pane without changing the chat', () => {
  const env = load(hostWith([]))
  const draw = openPanel(env)
  const close = find(draw(), el => el.props['aria-label'] === 'Close coding workspace')
  close.props.onClick()
  assert.ok(env.calls.includes('unregister'))
  assert.equal(env.calls.filter(x => x === 'view.toggleReview').length, 0)
  env.stop()
})
