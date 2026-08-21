/**
 * Plugins-settings tab for the DeepSeek balance monitor.
 *
 * Lets the user pick the auto-refresh interval from presets (10s / 30s /
 * 1 min / 3 min / 5 min) or type a custom number of seconds; the choice is
 * persisted into the `deepseek-balance-monitor.refreshSeconds` settings
 * namespace and takes effect live.
 */
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import styles from './settings.module.css'
import { PRESET_LABEL_KEYS, PRESET_SECONDS } from './locales.ts'

/** Mirror of the persisted interval, kept in the tab's store. */
export interface BalanceSettingsState {
  refreshSeconds: number
  revision: number
}

/** Props the composed slot registration injects (locale + store hook + write action). */
export interface BalanceSettingsTabProps {
  t: (key: string, params?: Record<string, unknown>) => string
  useStore: <T>(selector: (state: BalanceSettingsState) => T) => T
  setRefreshSeconds: (seconds: number) => void
}

const MIN_SECONDS = 10
const MAX_SECONDS = 3600
/** How long the green "saved" notice stays visible. */
const SAVED_NOTICE_MS = 1500

/** Render the refresh-interval settings tab. */
export function BalanceSettingsTab({ t, useStore, setRefreshSeconds }: BalanceSettingsTabProps) {
  const refreshSeconds = useStore((state) => state.refreshSeconds)
  const [custom, setCustom] = useState(String(refreshSeconds))
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<'idle' | 'saved' | 'error'>('idle')
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>()

  // Keep the custom input showing the CURRENT seconds until the user starts
  // editing it (the persisted value may arrive after first mount).
  useEffect(() => {
    if (!editing) setCustom(String(refreshSeconds))
  }, [refreshSeconds, editing])

  // Clear the notice auto-hide timer on unmount.
  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
  }, [])

  const parsed = Number(custom.trim())
  const customValid = custom.trim() !== '' && Number.isFinite(parsed)
    && parsed >= MIN_SECONDS && parsed <= MAX_SECONDS

  const flashSaved = (): void => {
    setNotice('saved')
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice('idle'), SAVED_NOTICE_MS)
  }

  const applyCustom = (): void => {
    if (!customValid) {
      setNotice('error')
      return
    }
    setRefreshSeconds(parsed)
    flashSaved()
  }

  const pickPreset = (seconds: number): void => {
    setRefreshSeconds(seconds)
    setCustom(String(seconds))
    flashSaved()
  }

  const noticeClass = notice === 'saved' ? styles.statusSaved : notice === 'error' ? styles.statusError : styles.status
  const noticeText = notice === 'saved' ? t('saved') : notice === 'error' ? t('invalidCustom') : ''

  return jsxs('section', {
    className: styles.section,
    children: [
      jsx('h3', { className: styles.title, children: t('title') }),
      jsx('p', { className: styles.description, children: t('description') }),
      jsxs('div', {
        className: styles.group,
        children: [
          jsxs('div', {
            className: styles.groupLabel,
            children: [
              jsx('p', { className: styles.groupTitle, children: t('intervalLabel') }),
              jsx('p', { className: styles.groupHint, children: t('intervalHint') }),
            ],
          }),
          jsxs('div', {
            className: styles.presets,
            children: PRESET_SECONDS.map((seconds, index) => {
              const active = seconds === refreshSeconds
              return jsx('button', {
                type: 'button',
                className: active ? [styles.preset, styles.presetActive].join(' ') : styles.preset,
                'aria-pressed': active,
                onClick: () => pickPreset(seconds),
                children: t(PRESET_LABEL_KEYS[index]),
              }, String(seconds))
            }),
          }),
          jsxs('div', {
            className: styles.custom,
            children: [
              jsx('label', {
                className: styles.groupHint,
                htmlFor: 'deepseek-balance-monitor-custom-interval',
                children: t('custom'),
              }),
              jsx('input', {
                id: 'deepseek-balance-monitor-custom-interval',
                className: notice === 'error' ? [styles.customInput, styles.customInputInvalid].join(' ') : styles.customInput,
                type: 'number',
                inputMode: 'numeric',
                min: MIN_SECONDS,
                max: MAX_SECONDS,
                value: custom,
                placeholder: String(refreshSeconds),
                onFocus: () => setEditing(true),
                onBlur: () => setEditing(false),
                onChange: (event: { currentTarget: { value: string } }) => {
                  setCustom(event.currentTarget.value)
                  if (notice !== 'idle') setNotice('idle')
                },
                onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    applyCustom()
                  }
                },
              }),
              jsx('button', {
                type: 'button',
                className: styles.customApply,
                onClick: applyCustom,
                children: t('apply'),
              }),
            ],
          }),
          noticeText !== '' ? jsx('p', { className: noticeClass, children: noticeText }) : null,
        ],
      }),
    ],
  })
}
