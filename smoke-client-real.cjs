// Definitive client integration test: loads the REAL dsh-client-ui-settings
// browser bundle (SettingsScopeBinder + SettingsScopeController), wires it to
// a real cordis root with a faithful in-memory settings api, then runs OUR
// client apply against it and verifies the full preset-click propagation.
'use strict'
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { homedir } = require('node:os')
const { join } = require('node:path')
// Resolve the dsh profile to load the real ui-settings bundle from. Override
// with DSH_PROFILE_DIR (path to the profile's package.json) when your profile
// lives elsewhere.
const requireProfile = createRequire(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
)
const { Context, Service } = require('@deepseek-ai/cordis')

// ---- faithful snapshot-store engine stub (immer-equivalent semantics) ----
function createSnapshotStore(init) {
  let state = init
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    update: (mutator) => { mutator(state); for (const l of [...listeners]) l() },
    set: (next) => { state = next; for (const l of [...listeners]) l() },
  }
}
function defineStore(decl) {
  const handle = createSnapshotStore(decl.init())
  const actions = {}
  for (const [name, fn] of Object.entries(decl.actions)) {
    actions[name] = (...args) => handle.update((d) => fn(d, ...args))
  }
  return { ...handle, actions }
}
const runtimeStub = { createSnapshotStore, defineStore }

// ---- bundle loader ----
function loadBundle(requirePath, spec) {
  const { join } = require('node:path')
  const pkgJson = requireProfile.resolve(spec + '/package.json')
  const bundleSource = readFileSync(join(pkgJson.replace(/[\\/]package\.json$/, ''), 'lib', 'client.js'), 'utf8')
  const factory = new Function('require', 'module', 'exports', bundleSource)
  const moduleShim = { exports: {} }
  const requireShim = (s) => {
    if (s === '@deepseek-ai/dsh-client-runtime/client') return runtimeStub
    if (s === '@deepseek-ai/cordis') return require('@deepseek-ai/cordis')
    try { return requireFromLocal(s) } catch { return requireProfile(s) }
  }
  const requireFromLocal = createRequire(__filename)
  let loaded
  global.window = { __ModuleLoader__: { load: (h) => { loaded = h } } }
  factory(requireShim, moduleShim, moduleShim.exports)
  if (!loaded || loaded.id !== requirePath) throw new Error('bundle not registered: ' + spec)
  return loaded.factory(requireShim)
}

;(async () => {
  const { BalanceSettingsSchema } = await import('./lib/index.js')
  const uiSettings = loadBundle('@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-settings')
  const mine = loadBundle('@dsh-external/deepseek-balance-monitor', '@dsh-external/deepseek-balance-monitor')

  const ctx = new Context()

  // In-memory settings document + faithful api face. Simulates a restarted
  // dsh: the document already holds refreshSeconds=180 from a previous session.
  let revision = 2
  const doc = { 'deepseek-balance-monitor': { refreshSeconds: 180 } }
  const schemaEnvelope = BalanceSettingsSchema.toJSON()
  const viewOf = (ns) => ({
    ns,
    schema: schemaEnvelope,
    value: { ...doc[ns] },
    applies: 'live',
    secrets: [],
    revision,
  })
  const api = {
    settings: {
      describe: async () => ({
        result: {
          ok: true,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: Object.keys(doc).map(viewOf),
          },
        },
      }),
      mutate: async ({ ns, ops, expectedRevision }) => {
        if (expectedRevision !== undefined && expectedRevision !== revision) {
          return { result: { ok: false, error: { code: 'settings-rejected', message: 'conflict' } } }
        }
        for (const op of ops) {
          if (op.op === 'set') doc[ns][op.path[0]] = op.value
          else delete doc[ns][op.path[0]]
        }
        revision += 1
        return { result: { ok: true, value: viewOf(ns) } }
      },
    },
  }

  // Fake connection service (the binder reads api + isLoopback; the badge uses rpc.call).
  let rpcMode = 'ok'   // 'ok' | 'business-fail' | 'abort'
  class FakeConnection extends Service {
    constructor(c) { super(c, 'connection') }
    get isLoopback() { return true }
    get api() { return api }
    get rpc() {
      return {
        call: async (channel, endpoint, payload, signal) => {
          if (endpoint !== 'deepseekBalance/fetch') throw new Error('bad endpoint')
          if (rpcMode === 'abort') {
            // Simulate the timeout: the transport aborts the hung request and
            // rejects with AbortError.
            throw new DOMException('Aborted', 'AbortError')
          }
          if (rpcMode === 'business-fail') {
            return { ok: true, value: { ok: false, code: 'no-key', message: 'no key configured' } }
          }
          return { ok: true, value: { fetchedAt: 1, isAvailable: true, balances: [{ currency: 'CNY', totalBalance: 9, grantedBalance: 0, toppedUpBalance: 9 }] } }
        },
      }
    }
  }
  new FakeConnection(ctx)

  // Fake remote service (binder subscribes to settings/document-updated).
  class FakeRemote extends Service {
    constructor(c) { super(c, 'remote') }
    $on() { return () => {} }
  }
  new FakeRemote(ctx)

  // Fake locale + slots.
  class FakeLocale extends Service {
    constructor(c) { super(c, 'locale') }
    register() {}
    bind() { return (key) => key }
  }
  new FakeLocale(ctx)

  const registrations = []
  class FakeSlots extends Service {
    constructor(c) { super(c, 'slots') }
    inject(name, thunk) { registrations.push(thunk()) }
    register(options, component) { registrations.push({ options, component }); return () => {} }
  }
  new FakeSlots(ctx)

  // REAL settingsScope service.
  const { SettingsScopeBinder } = uiSettings
  new SettingsScopeBinder(ctx)

  mine.apply(ctx)
  await new Promise((r) => setTimeout(r, 50))

  const badgeEntry = registrations.find((r) => r.options && r.options.name === 'shell.overlay')
  const tabEntry = registrations.find((r) => r.options && r.options.name === 'settings.plugins.tab')
  if (!badgeEntry || !tabEntry) throw new Error('registrations missing')

  const badgeStore = badgeEntry.options.store
  const tabStore = tabEntry.options.store
  const badgeActions = badgeEntry.options.inject(badgeEntry.options.store.actions)
  const tabActions = tabEntry.options.inject(tabEntry.options.store.actions)

  console.log('initial badge interval:', badgeStore.getSnapshot().refreshSeconds, '| tab:', tabStore.getSnapshot().refreshSeconds)
  // The persisted 180s must be adopted at mount (no user interaction needed).
  if (badgeStore.getSnapshot().refreshSeconds !== 180) throw new Error('badge did NOT adopt persisted 180s at mount')
  if (tabStore.getSnapshot().refreshSeconds !== 180) throw new Error('tab did NOT adopt persisted 180s at mount')

  // Real controller round trip: write -> accept -> publish -> our sync.
  tabActions.setRefreshSeconds(10)
  await new Promise((r) => setTimeout(r, 80))
  console.log('after preset 10s -> badge:', badgeStore.getSnapshot().refreshSeconds, '| tab:', tabStore.getSnapshot().refreshSeconds, '| doc:', JSON.stringify(doc))
  if (badgeStore.getSnapshot().refreshSeconds !== 10) throw new Error('badge store did NOT update to 10s')
  if (tabStore.getSnapshot().refreshSeconds !== 10) throw new Error('tab store did NOT update to 10s')

  tabActions.setRefreshSeconds(180)
  await new Promise((r) => setTimeout(r, 80))
  console.log('after preset 180s -> badge:', badgeStore.getSnapshot().refreshSeconds, '| tab:', tabStore.getSnapshot().refreshSeconds)
  if (badgeStore.getSnapshot().refreshSeconds !== 180) throw new Error('badge store did NOT update to 180s')
  if (doc['deepseek-balance-monitor'].refreshSeconds !== 180) throw new Error('document not persisted')

  badgeActions.refresh()
  await new Promise((r) => setTimeout(r, 800))
  const after = badgeStore.getSnapshot()
  console.log('badge after refresh:', after.status, '| spinning:', after.spinning)
  if (after.status !== 'ready') throw new Error('badge not ready')

  // Business failure inside a successful RPC envelope (no key / timeout / HTTP
  // error): the badge must land on the error state, NOT crash with a malformed
  // snapshot (previously this made the whole badge disappear).
  rpcMode = 'business-fail'
  badgeActions.refresh()
  await new Promise((r) => setTimeout(r, 800))
  const failed = badgeStore.getSnapshot()
  console.log('badge after business failure:', JSON.stringify({ status: failed.status, balance: failed.balance, spinning: failed.spinning, error: failed.error }))
  if (failed.status !== 'error') throw new Error('badge should be error on business failure')
  if (failed.spinning !== false) throw new Error('spinning should stop after business failure')
  // Keeping the last good balance across a failure is fine (the error state
  // does not render it); the key contract is that the malformed snapshot is
  // never adopted and the entry does not crash.
  if (failed.balance !== null && failed.balance.balances === undefined) {
    throw new Error('no malformed snapshot may be stored')
  }

  // Hung request aborted by the timeout: fail path must settle (no infinite spin).
  rpcMode = 'abort'
  badgeActions.refresh()
  await new Promise((r) => setTimeout(r, 800))
  const aborted = badgeStore.getSnapshot()
  console.log('badge after abort:', aborted.status, '| spinning:', aborted.spinning)
  if (aborted.spinning !== false) throw new Error('spinning should stop after abort')
  if (aborted.status !== 'error') throw new Error('badge should be error after abort')

  // Recovery: next successful refresh works again.
  rpcMode = 'ok'
  badgeActions.refresh()
  await new Promise((r) => setTimeout(r, 800))
  const recovered = badgeStore.getSnapshot()
  console.log('badge after recovery:', recovered.status)
  if (recovered.status !== 'ready') throw new Error('badge should recover to ready')

  console.log('REAL CONTROLLER INTEGRATION OK')
  process.exit(0)
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1) })
