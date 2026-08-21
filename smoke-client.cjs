// Client-half smoke test (CJS): registers the bundle through a mocked
// window.__ModuleLoader__, runs apply() against a fake browser ctx whose scope
// mock faithfully mirrors the real SettingsScopeController (writes notify
// subscribers, bump the revision), and checks the whole propagation chain:
// preset click -> scope write -> both stores update.
'use strict'
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const requireFrom = createRequire(__filename)

// Minimal defineStore stand-in matching the runtime engine contract used here.
function defineStore(decl) {
  let state = decl.init()
  const listeners = new Set()
  const actions = {}
  for (const [name, fn] of Object.entries(decl.actions)) {
    actions[name] = (...args) => {
      fn(state, ...args)
      for (const l of listeners) l()
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    set: (next) => { state = next; for (const l of listeners) l() },
    actions,
  }
}

const runtimeStub = { defineStore }

let loaded = null
global.window = {
  __ModuleLoader__: {
    load(handoff) { loaded = handoff },
  },
}

const bundleSource = readFileSync(require.resolve('./lib/client.js'), 'utf8')
const factory = new Function('require', 'module', 'exports', bundleSource)
const moduleShim = { exports: {} }
const requireShim = (spec) => {
  if (spec === 'react') return require('react')
  if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-runtime/client') return runtimeStub
  if (spec.startsWith('@deepseek-ai/')) return requireFrom(spec)
  throw new Error('unexpected require: ' + spec)
}
factory(requireShim, moduleShim, moduleShim.exports)

if (!loaded) throw new Error('bundle did not register with __ModuleLoader__')
const exports_ = loaded.factory(requireShim)
if (typeof exports_.apply !== 'function') throw new Error('no apply export')
console.log('client exports:', Object.keys(exports_).join(', '))

// ---- faithful scope mock (mirrors SettingsScopeController publish-on-write) ----
const listeners = new Set()
let revision = 7
let value = { refreshSeconds: 30 }
const scope = {
  getSnapshot: () => ({ status: 'ready', value, revision, writable: true, mode: 'host' }),
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  set: async (field, v) => {
    value = { ...value, [field]: v }
    revision += 1
    for (const l of [...listeners]) l()   // notify like the real controller's publish
  },
}

let lastRpcEndpoint = ''
const connection = {
  rpc: {
    call: async (channel, endpoint) => {
      lastRpcEndpoint = endpoint
      if (channel !== '/api') throw new Error('bad channel: ' + channel)
      return { ok: true, value: { fetchedAt: 1234, isAvailable: true, balances: [{ currency: 'CNY', totalBalance: 88.5, grantedBalance: 8.5, toppedUpBalance: 80 }] } }
    },
  },
}

const registrations = []
const ctx = {
  effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
  locale: {
    register: () => {},
    bind: () => (key) => key,
  },
  slots: {
    inject: (name, thunk) => { registrations.push(thunk()) },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  connection,
  settingsScope: { bind: () => scope },
}

exports_.apply(ctx)

const badgeEntry = registrations.find((r) => r.options && r.options.name === 'shell.overlay' && r.options.id === 'deepseek-balance')
const tabEntry = registrations.find((r) => r.options && r.options.name === 'settings.plugins.tab' && r.options.id === 'deepseek-balance-settings')
if (!badgeEntry || !tabEntry) throw new Error('registrations missing')

;(async () => {
  const badgeActions = badgeEntry.options.inject(badgeEntry.options.store.actions)
  const tabActions = tabEntry.options.inject(tabEntry.options.store.actions)

  const badgeStore = badgeEntry.options.store
  const tabStore = tabEntry.options.store

  // Initial adoption: current scope value (30s) must reach both stores.
  if (badgeStore.getSnapshot().refreshSeconds !== 30) throw new Error('badge store did not adopt 30s')
  if (tabStore.getSnapshot().refreshSeconds !== 30) throw new Error('tab store did not adopt 30s')
  console.log('adopted initial interval 30s ->', badgeStore.getSnapshot().refreshSeconds, tabStore.getSnapshot().refreshSeconds)

  // Preset click flow (the real component calls setRefreshSeconds(10)).
  tabActions.setRefreshSeconds(10)
  await new Promise((r) => setTimeout(r, 20))
  console.log('after preset 10s -> badge:', badgeStore.getSnapshot().refreshSeconds, '| tab:', tabStore.getSnapshot().refreshSeconds)
  if (badgeStore.getSnapshot().refreshSeconds !== 10) throw new Error('badge store did NOT update to 10s')
  if (tabStore.getSnapshot().refreshSeconds !== 10) throw new Error('tab store did NOT update to 10s')

  // Another preset, then verify badge refresh still works.
  tabActions.setRefreshSeconds(180)
  await new Promise((r) => setTimeout(r, 20))
  if (badgeStore.getSnapshot().refreshSeconds !== 180) throw new Error('badge store did NOT update to 180s')
  console.log('after preset 180s -> badge:', badgeStore.getSnapshot().refreshSeconds)

  badgeActions.refresh()
  await new Promise((r) => setTimeout(r, 800))
  const afterRefresh = badgeStore.getSnapshot()
  console.log('badge after refresh:', afterRefresh.status, '| spinning:', afterRefresh.spinning)
  if (afterRefresh.status !== 'ready') throw new Error('badge not ready')
  if (lastRpcEndpoint !== 'deepseekBalance/fetch') throw new Error('wrong RPC endpoint')

  console.log('CLIENT PROPAGATION OK')
  process.exit(0)
})().catch((error) => {
  console.error('SMOKE FAILED:', error.message)
  process.exit(1)
})
