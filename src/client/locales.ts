/**
 * Copy dictionaries for the DeepSeek balance monitor (badge + settings tab).
 * Simplified Chinese is the key-set source of truth.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.balanceMonitor'

/** Simplified Chinese dictionary. */
export const zh = {
  tab: '余额监控',
  badgeLabel: 'DeepSeek 余额监控',
  balance: '余额',
  loading: '读取中…',
  unavailable: '不可用',
  refresh: '刷新余额',
  updatedAt: '更新于 {time}',
  lowBalance: '余额不足',
  autoRefreshHint: '每 {seconds} 秒自动刷新',
  title: 'DeepSeek 余额监控',
  description: '在右下角显示 DeepSeek 账户余额角标，并设置余额自动刷新的时间间隔。',
  intervalLabel: '自动刷新间隔',
  intervalHint: '选择预设间隔，或在“自定义”中填写秒数（10–3600 秒）。',
  presets: '预设',
  preset10s: '10 秒',
  preset30s: '30 秒',
  preset1m: '1 分钟',
  preset3m: '3 分钟',
  preset5m: '5 分钟',
  custom: '自定义（秒）',
  apply: '应用',
  saved: '已保存',
  invalidCustom: '请输入 10–3600 之间的秒数',
}

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Balance monitor',
  badgeLabel: 'DeepSeek balance monitor',
  balance: 'Balance',
  loading: 'Loading…',
  unavailable: 'Unavailable',
  refresh: 'Refresh balance',
  updatedAt: 'Updated {time}',
  lowBalance: 'Low balance',
  autoRefreshHint: 'Auto-refreshes every {seconds}s',
  title: 'DeepSeek balance monitor',
  description: 'Shows a DeepSeek account balance badge at the bottom-right corner and controls how often the balance auto-refreshes.',
  intervalLabel: 'Auto-refresh interval',
  intervalHint: 'Pick a preset interval, or enter seconds under “Custom” (10–3600).',
  presets: 'Presets',
  preset10s: '10s',
  preset30s: '30s',
  preset1m: '1 min',
  preset3m: '3 min',
  preset5m: '5 min',
  custom: 'Custom (seconds)',
  apply: 'Apply',
  saved: 'Saved',
  invalidCustom: 'Enter a number between 10 and 3600',
}

/** Preset refresh intervals, in seconds. */
export const PRESET_SECONDS = [10, 30, 60, 180, 300] as const

/** Locale keys for the preset labels, in the same order. */
export const PRESET_LABEL_KEYS = ['preset10s', 'preset30s', 'preset1m', 'preset3m', 'preset5m'] as const

/** One currency row of the balance snapshot. */
export interface BalanceCurrencyView {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

/** Client-side balance snapshot. */
export interface BalanceView {
  fetchedAt: number
  isAvailable: boolean
  balances: BalanceCurrencyView[]
}

/** Currency → symbol map for compact display; unknown currencies show their code. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  TWD: 'NT$',
}

/** Format one amount with its currency. */
export function formatBalance(currency: string, amount: number): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `
  return `${symbol}${amount.toFixed(2)}`
}
