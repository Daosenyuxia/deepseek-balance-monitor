/**
 * deepseek-balance-monitor, Host half.
 *
 * Starts a balance-monitoring service when DSH boots: `DeepseekBalanceGateway`
 * resolves the DeepSeek API key through the credentials seam (the same
 * `DEEPSEEK_API_KEY` reference the DeepSeek LLM provider uses), queries
 * `GET {baseURL}/user/balance`, and exposes the snapshot to the browser via the
 * Typert Remote gateway (`deepseekBalance/fetch`). A small cache serves the
 * last known snapshot while a refresh is in flight, and the first fetch is
 * kicked off at activation so the badge has data as soon as the browser
 * connects.
 *
 * Also registers the `deepseek-balance-monitor` settings namespace (the
 * `refreshSeconds` field the Plugins page tab edits).
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

/** Settings namespace owning the persisted refresh interval. */
export const SETTINGS_NAMESPACE = settingsNamespace('deepseek-balance-monitor')
/** Field carrying the auto-refresh interval in seconds. */
export const REFRESH_FIELD = 'refreshSeconds'
/** Default interval (60s) when the user layer carries no value. */
export const DEFAULT_REFRESH_SECONDS = 60
/** Durable namespace schema; also the wire envelope the browser scope validates against. */
export const BalanceSettingsSchema = z.object({
  [REFRESH_FIELD]: z.number().min(5).max(3600).default(DEFAULT_REFRESH_SECONDS),
})

/** Credential reference resolved per fetch (never cached — re-resolve per operation). */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** Internal endpoint default; the public one is `https://api.deepseek.com`. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** Serve a cached snapshot instead of refetching within this window. */
const CACHE_FRESH_MS = 5_000
/** Per-request timeout. */
const REQUEST_TIMEOUT_MS = 15_000

/** One currency row of the DeepSeek balance response. */
export interface BalanceCurrencyView {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

/** JSON-safe snapshot returned by `deepseekBalance/fetch`. */
export type BalanceResult =
  | {
      ok: true
      fetchedAt: number
      isAvailable: boolean
      balances: BalanceCurrencyView[]
    }
  | {
      ok: false
      code: 'no-key' | 'transport' | 'http' | 'invalid'
      message?: string
    }

/**
 * Remote balance gateway. Registers the `deepseekBalance` service and exposes
 * the `deepseekBalance/fetch` endpoint to the browser through the Typert
 * Gateway's source-mode discovery (no generated manifest needed).
 */
export class DeepseekBalanceGateway extends TypertRemoteService {
  private readonly apiKeyEnv: string
  private readonly baseURL: string
  private cache: BalanceResult | undefined

  constructor(ctx: Context) {
    super(ctx, 'deepseekBalance')
    this.apiKeyEnv = process.env.DEEPSEEK_API_KEY ?? DEFAULT_API_KEY_ENV
    this.baseURL = process.env[BASE_URL_ENV] ?? DEFAULT_BASE_URL
    // tsdown/rolldown does not transform TS decorators, so apply the Remote
    // marker programmatically instead of `@Remote('fetch')` (see markRemote).
    markRemote(DeepseekBalanceGateway.prototype, 'fetch')
  }

  /** Resolve one API key at fetch time so a changed credential reaches the next call. */
  private async resolveKey(): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return undefined
    const hit = await credentials.resolve(credentialRef(this.apiKeyEnv))
    return hit?.value
  }

  /** Query the DeepSeek balance endpoint and normalize the payload. */
  private async load(): Promise<BalanceResult> {
    const apiKey = await this.resolveKey()
    if (apiKey === undefined || apiKey.length === 0) {
      return {
        ok: false,
        code: 'no-key',
        message: `未配置 API Key：请通过环境变量 ${this.apiKeyEnv} 或 Web 模型页面保存`,
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.baseURL}/user/balance`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        return { ok: false, code: 'http', message: `HTTP ${response.status}` }
      }
      const payload: unknown = await response.json()
      const balances = parseBalances(payload)
      if (balances.length === 0) {
        return { ok: false, code: 'invalid', message: '接口返回中没有可用余额信息' }
      }
      return {
        ok: true,
        fetchedAt: Date.now(),
        isAvailable: isAvailableOf(payload),
        balances,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        code: 'transport',
        message: controller.signal.aborted ? '请求超时' : message,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Remote entry point. Returns a fresh snapshot, or the last known one when a
   * refresh fails — the badge keeps showing the last balance instead of
   * flashing an error on a transient network blip.
   */
  async fetch(): Promise<BalanceResult> {
    const cached = this.cache
    if (cached !== undefined && cached.ok === true && Date.now() - cached.fetchedAt < CACHE_FRESH_MS) {
      return cached
    }
    const result = await this.load()
    if (result.ok === true) this.cache = result
    return result
  }

  /** Best-effort warm-up so the first browser read can be served from cache. */
  async warmUp(): Promise<void> {
    try {
      await this.fetch()
    } catch {
      // Boot-time warm-up failures are fine — the browser retries on its poll.
    }
  }
}

/**
 * Apply a `Remote` marker to a prototype method without decorator syntax.
 *
 * `Remote` only inspects the decorator context it receives, so a synthetic
 * context whose `addInitializer` runs immediately against the target prototype
 * registers the exact same marker `@Remote(name)` would — which is what the
 * Typert Gateway's source-mode discovery reads via `remoteMethods()`.
 */
function markRemote(prototype: object, method: string): void {
  const fakeInstance = Object.create(prototype)
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {
      has: (obj: object) => method in obj,
      get: (obj: object) => (obj as Record<string, unknown>)[method],
      set: (obj: object, value: unknown) => {
        ;(obj as Record<string, unknown>)[method] = value
      },
    },
    addInitializer(initializer: () => void) {
      initializer.call(fakeInstance)
    },
  }
  Remote(method)(function () {}, context as never)
}

/** Normalize `balance_infos` rows (string amounts) into numbers. */
function parseBalances(payload: unknown): BalanceCurrencyView[] {
  if (typeof payload !== 'object' || payload === null) return []
  const infos = (payload as { balance_infos?: unknown }).balance_infos
  if (!Array.isArray(infos)) return []
  const rows: BalanceCurrencyView[] = []
  for (const item of infos) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as {
      currency?: unknown
      total_balance?: unknown
      granted_balance?: unknown
      topped_up_balance?: unknown
    }
    const currency = typeof row.currency === 'string' ? row.currency : ''
    const totalBalance = toNumber(row.total_balance)
    const grantedBalance = toNumber(row.granted_balance)
    const toppedUpBalance = toNumber(row.topped_up_balance)
    if (currency.length === 0 || totalBalance === undefined) continue
    rows.push({ currency, totalBalance, grantedBalance, toppedUpBalance })
  }
  return rows
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function isAvailableOf(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null
    && (payload as { is_available?: unknown }).is_available !== false
}

/**
 * Host loader entry: register the durable settings section (when the optional
 * settings service is composed) and start the balance gateway service.
 *
 * Deliberately NO module-level `inject` export: the gateway resolves the
 * credential seam through `ctx.get('credentials')` per call (which works
 * without a fiber injection), and a bare `apply`-only plugin shape matches the
 * proven host-plugin pattern (cf. maid-atelier) for the nested
 * `ctx.inject(['settings'], …)` registration.
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, BalanceSettingsSchema)
  })
  const gateway = new DeepseekBalanceGateway(ctx)
  void gateway.warmUp()
}