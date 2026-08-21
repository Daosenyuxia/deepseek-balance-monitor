/**
 * deepseek-balance-monitor, browser half.
 *
 * Calls the Host balance service through the generic RPC carrier
 * (`ctx.connection.rpc.call('/api', 'deepseekBalance/fetch', { args: {} })`) —
 * the same channel the typed Remote facade rides — because the facade's
 * namespace service (`remote.deepseekBalance`) would have to be mounted by
 * this plugin's own apply while its fiber inject already waits for it, which
 * cannot resolve. Then registers:
 *  - a bottom-right balance badge into `shell.overlay`,
 *  - a refresh-interval tab into the Plugins settings section
 *    (`settings.plugins.tab`), editing the persisted
 *    `deepseek-balance-monitor.refreshSeconds` namespace.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import { BalanceBadge, type BalanceBadgeState } from './balance-badge.tsx'
import { BalanceSettingsTab, type BalanceSettingsState } from './settings-tab.tsx'
import { NS, en, zh, type BalanceView } from './locales.ts'

export { NS } from './locales.ts'

/** Settings namespace owned by the Host half; spelled here (client must not depend on the Host package). */
export const SETTINGS_NAMESPACE = 'deepseek-balance-monitor'
/** Field carrying the auto-refresh interval in seconds. */
export const REFRESH_FIELD = 'refreshSeconds'
/** Default interval when the user layer carries no value. */
export const DEFAULT_REFRESH_SECONDS = 60

/** Services required by this browser fiber. */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

const REMOTE_NAMESPACE = 'deepseekBalance'
/** Keep the spin animation visible even for a fast local refresh. */
const MIN_SPIN_MS = 650

/** Badge state store: mirrors the latest balance snapshot and the refresh interval. */
export function createBalanceStore() {
  return defineStore({
    init: (): BalanceBadgeState => ({
      status: 'loading',
      balance: null,
      error: null,
      spinning: false,
      refreshSeconds: DEFAULT_REFRESH_SECONDS,
      lastUpdated: 0,
    }),
    actions: {
      syncRefresh: (d: BalanceBadgeState, seconds: number) => {
        if (Number.isFinite(seconds) && seconds > 0 && d.refreshSeconds !== seconds) d.refreshSeconds = seconds
      },
      begin: (d: BalanceBadgeState) => {
        d.spinning = true
      },
      ok: (d: BalanceBadgeState, balance: BalanceView) => {
        d.status = 'ready'
        d.balance = balance
        d.error = null
        d.lastUpdated = balance.fetchedAt
        d.spinning = false
      },
      fail: (d: BalanceBadgeState, error: string) => {
        d.status = 'error'
        d.error = error
        d.spinning = false
      },
    },
  })
}

/** Settings-tab store: mirrors the persisted interval. */
export function createBalanceSettingsStore() {
  return defineStore({
    init: (): BalanceSettingsState => ({
      refreshSeconds: DEFAULT_REFRESH_SECONDS,
      revision: -1,
    }),
    actions: {
      sync: (d: BalanceSettingsState, seconds: number, revision: number) => {
        if (revision <= d.revision) return
        d.refreshSeconds = seconds
        d.revision = revision
      },
      /** Optimistic adoption: reflect a just-chosen value without waiting for the scope round-trip. */
      apply: (d: BalanceSettingsState, seconds: number) => {
        d.refreshSeconds = seconds
      },
    },
  })
}

/**
 * Browser plugin entry: register dictionaries, the overlay badge, and the
 * Plugins settings tab.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-balance-monitor: dictionaries')
  const t = ctx.locale.bind(NS)

  /** RPC envelope returned by the Host gateway (same shape as the typed Remote facade). */
  interface RpcEnvelope {
    ok: boolean
    value?: unknown
    error?: { code?: string; message?: string }
  }

  /** One business failure result the gateway may return inside a successful RPC envelope. */
  interface BalanceFailure {
    ok: false
    code?: string
    message?: string
  }

  /** Hard cap on one refresh request; a hung connection must not spin forever. */
  const FETCH_TIMEOUT_MS = 15_000

  const fetchBalance = async (): Promise<BalanceView> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let result: RpcEnvelope
    try {
      result = await (ctx.connection as {
        rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcEnvelope> }
      }).rpc.call('/api', `${REMOTE_NAMESPACE}/fetch`, { args: {} }, controller.signal)
    } finally {
      clearTimeout(timer)
    }
    if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? 'fetch failed')
    const value = result.value
    // The gateway reports business failures (no key, timeout, HTTP error) as a
    // successful RPC whose value is `{ ok: false, … }` — treat that as a
    // failure instead of rendering a malformed snapshot. A success snapshot
    // carries no `ok` field and must have a `balances` array.
    if (typeof value !== 'object' || value === null
      || (value as BalanceFailure).ok === false
      || !Array.isArray((value as BalanceView).balances)) {
      const failure = value as BalanceFailure
      throw new Error(failure.message ?? '余额查询失败')
    }
    return value as BalanceView
  }

  // Optional settings surface (mirrors the skin plugin's defensive pattern).
  let scope: { getSnapshot(): { value?: { refreshSeconds?: number }; revision: number }; subscribe(listener: () => void): () => void; set(field: string, value: unknown): Promise<void> } | undefined
  try {
    scope = (ctx as { settingsScope: { bind(spec: { namespace: string }): unknown } }).settingsScope.bind({ namespace: SETTINGS_NAMESPACE }) as typeof scope
  } catch {
    scope = undefined
  }

  const balanceStore = createBalanceStore()
  const settingsStore = createBalanceSettingsStore()
  let balanceBound: { syncRefresh(seconds: number): void } | undefined
  let settingsBound: { sync(seconds: number, revision: number): void } | undefined

  /** Push the latest persisted interval into both stores. */
  const syncFromScope = (): void => {
    if (scope === undefined) return
    const snapshot = scope.getSnapshot()
    const seconds = typeof snapshot.value?.refreshSeconds === 'number'
      ? snapshot.value.refreshSeconds
      : DEFAULT_REFRESH_SECONDS
    balanceBound?.syncRefresh(seconds)
    settingsBound?.sync(seconds, snapshot.revision)
  }
  if (scope !== undefined) {
    ctx.effect(() => scope!.subscribe(syncFromScope), 'deepseek-balance-monitor: interval adoption')
    syncFromScope()
  }

  let refreshSeq = 0
  let refreshing = false
  const runRefresh = (actions: {
    begin(): void
    ok(balance: BalanceView): void
    fail(error: string): void
  }): void => {
    // Skip while a refresh is still in flight (the timeout above guarantees
    // it eventually settles), so a manual click or an interval tick cannot
    // pile up concurrent hung requests.
    if (refreshing) return
    refreshing = true
    const seq = ++refreshSeq
    actions.begin()
    void Promise.all([
      fetchBalance().then(
        (balance) => ({ balance }) as const,
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) as const,
      ),
      new Promise((resolve) => setTimeout(resolve, MIN_SPIN_MS)),
    ])
      .then(([outcome]) => {
        if (seq !== refreshSeq) return
        if ('balance' in outcome) actions.ok(outcome.balance)
        else actions.fail(outcome.error)
      })
      .catch(() => {
        if (seq === refreshSeq) actions.fail('unknown error')
      })
      .finally(() => {
        refreshing = false
      })
  }

  // Bottom-right balance badge.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'deepseek-balance',
    order: 100,
    label: () => t('badgeLabel'),
    locale: NS,
    store: balanceStore,
    inject: (actions: {
      syncRefresh(seconds: number): void
      begin(): void
      ok(balance: BalanceView): void
      fail(error: string): void
    }) => {
      balanceBound = actions
      // Adopt the persisted interval as soon as the badge mounts (the scope's
      // initial read may have completed before this entry bound its actions).
      syncFromScope()
      return { refresh: () => void runRefresh(actions) }
    },
  }, BalanceBadge))

  // Refresh-interval tab in the Plugins settings page.
  if (scope !== undefined) {
    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'deepseek-balance-settings',
      order: 30,
      label: () => t('tab'),
      locale: NS,
      store: settingsStore,
      inject: (actions: {
        sync(seconds: number, revision: number): void
        apply(seconds: number): void
      }) => {
        settingsBound = actions
        syncFromScope()
        return {
          setRefreshSeconds: (seconds: number) => {
            const clamped = Math.min(3600, Math.max(10, Math.round(seconds)))
            // Persist through the settings document…
            void scope!.set(REFRESH_FIELD, clamped)
            // …and adopt optimistically so the tab highlight and the badge
            // interval react instantly (the scope round-trip confirms the same value).
            actions.apply(clamped)
            balanceBound?.syncRefresh(clamped)
          },
        }
      },
    }, BalanceSettingsTab))
  }
}
