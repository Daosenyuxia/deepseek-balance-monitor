/**
 * Bottom-right balance badge, registered into the `shell.overlay` slot.
 *
 * Shows the latest DeepSeek balance snapshot, auto-refreshes on the interval
 * chosen in the Plugins settings page, and exposes a circular-arrow refresh
 * button that spins while a refresh is in flight.
 */
import { useEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import styles from './balance.module.css'
import { type BalanceView, formatBalance } from './locales.ts'

/** Snapshot state mirrored into the badge store. */
export interface BalanceBadgeState {
  status: 'loading' | 'ready' | 'error'
  balance: BalanceView | null
  error: string | null
  spinning: boolean
  refreshSeconds: number
  lastUpdated: number
}

/** Props the composed slot registration injects (locale + store hook + refresh action). */
export interface BalanceBadgeProps {
  t: (key: string, params?: Record<string, unknown>) => string
  useStore: <T>(selector: (state: BalanceBadgeState) => T) => T
  refresh: () => void
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Render the balance badge. */
export function BalanceBadge({ t, useStore, refresh }: BalanceBadgeProps) {
  const state = useStore((snapshot) => snapshot)
  const { status, balance, error, spinning, refreshSeconds } = state

  // Keep the latest refresh callback in a ref so the interval effect re-arms
  // only when the interval itself changes.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // Auto-refresh loop: fetch immediately on mount (and whenever the interval
  // changes), then re-arm the timer on the persisted interval.
  useEffect(() => {
    refreshRef.current()
    const intervalMs = Math.max(10, refreshSeconds) * 1000
    const id = setInterval(() => refreshRef.current(), intervalMs)
    return () => clearInterval(id)
  }, [refreshSeconds])

  const ready = status === 'ready' && balance !== null
  // Render-time defense: never trust the snapshot shape (a malformed row must
  // not crash the entry and hide the whole badge).
  const rows = ready && Array.isArray(balance!.balances) ? balance!.balances : []
  // “Insufficient”: the account reports unavailable, or no currency holds a
  // positive balance.
  const insufficient = ready
    && (balance!.isAvailable === false || rows.every((row) => row.totalBalance <= 0))

  const main = ready && rows.length > 0
    ? jsx('span', {
        className: styles.value,
        title: t('autoRefreshHint', { seconds: refreshSeconds }),
        children: rows.map((row) => formatBalance(row.currency, row.totalBalance)).join(' / '),
      })
    : status === 'loading'
      ? jsx('span', { className: styles.value, children: t('loading') })
      : jsx('span', {
          className: [styles.value, styles.error].join(' '),
          title: error ?? undefined,
          children: t('unavailable'),
        })

  const sub = ready
    ? jsx('span', {
        className: styles.sub,
        children: t('updatedAt', { time: formatTime(balance!.fetchedAt) }),
      })
    : null

  // Status dot: the base dot shape is always applied; the color class only
  // switches the background — gray while loading, green once a balance is
  // read, red on failure or when the balance is insufficient.
  const dotClass = [
    styles.dot,
    status === 'error' || insufficient
      ? styles.dotError
      : ready
        ? styles.dotReady
        : null,
  ].filter(Boolean).join(' ')

  return jsxs('div', {
    className: styles.badge,
    'data-plugin': 'deepseek-balance-monitor',
    role: 'status',
    children: [
      jsx('span', {
        className: dotClass,
        title: ready && insufficient ? t('lowBalance') : undefined,
        role: 'img',
        'aria-label': ready && insufficient ? t('lowBalance') : undefined,
        'aria-hidden': ready && insufficient ? undefined : true,
      }),
      jsxs('div', {
        className: styles.body,
        children: [
          jsxs('div', {
            className: styles.main,
            children: [
              jsx('span', { className: styles.label, children: t('balance') }),
              main,
            ],
          }),
          sub,
        ],
      }),
      jsx('button', {
        type: 'button',
        className: spinning ? [styles.refresh, styles.spinning].join(' ') : styles.refresh,
        'aria-label': t('refresh'),
        title: t('refresh'),
        disabled: spinning,
        onClick: refresh,
        children: jsx('svg', {
          className: styles.refreshIcon,
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          children: [
            jsx('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
            jsx('polyline', { points: '21 3 21 9 15 9' }),
          ],
        }),
      }),
    ],
  })
}
