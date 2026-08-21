# deepseek-balance-monitor

[English](README.md) | [简体中文](README.zh-CN.md)

A dsh web plugin that monitors your DeepSeek account balance:
<img width="184" height="83" alt="屏幕截图 2026-08-21 140545" src="https://github.com/user-attachments/assets/5edd1864-cba3-4655-99a2-9eeb67a91173" />
<img width="183" height="83" alt="屏幕截图 2026-08-21 140509" src="https://github.com/user-attachments/assets/3e1f466a-b017-44c5-8e4f-d649bcf339bd" />
- **Bottom-right balance badge** (`shell.overlay` slot): shows the latest
  balance with a status dot, the last-updated time, and — at the far right of
  the badge — a **circular-arrow manual refresh button** that spins while a
  refresh is in flight (the spin is enforced for at least 650 ms so it is
  visible even for fast local refreshes).
- **Auto-refresh service**: the Host half starts with DSH (`DeepseekBalanceGateway`,
  a Typert Remote service at `deepseekBalance/fetch`) and warms up at boot.
  The badge calls that endpoint through the generic RPC carrier
  (`ctx.connection.rpc.call('/api', 'deepseekBalance/fetch', …)` — the same
  channel the typed Remote facade rides) and re-fetches on the interval
  configured in Settings; every response updates the displayed balance.
- **Settings → Plugins → “余额监控” tab**: choose the auto-refresh interval
  from presets (10 秒 / 30 秒 / 1 分钟 / 3 分钟 / 5 分钟) or a custom number of
  seconds (10–3600). The choice is persisted in the
  `deepseek-balance-monitor.refreshSeconds` settings namespace and applies
  live.

## How it gets the API key

The Host resolves `DEEPSEEK_API_KEY` through the credentials seam on every
fetch (same reference the DeepSeek LLM provider uses — the web Models page or
the launching environment can supply it). The endpoint is
`GET {baseURL}/user/balance` with `baseURL` defaulting to
`https://api.deepseek.com` (override via `DEEPSEEK_BASE_URL`).

## Layout

- `src/index.ts` — Host half: settings namespace registration + balance gateway.
- `src/typert.host.ts` — Host typert manifest (`exports["./typert"]`): the
  strict `deepseekBalance/fetch` descriptor the base-layer typert-loader
  registers into the shared `ctx.typert` registry, so the api-gateway claims
  and dispatches the endpoint without cross-package `@Remote` marker
  discovery.
- `src/client/` — Browser half: `index.ts` (apply), `balance-badge.tsx`
  (badge + spin button), `settings-tab.tsx` (interval presets/custom),
  `locales.ts` (zh/en copy).
- `build/tsdown.client.ts` — client-bundle preset (mirrored from dsh-web-ui).

## Build & install

```sh
pnpm install
pnpm build          # emits lib/index.js (Host) + lib/typert.host.js + lib/client.js (browser)
dsh plugin --profile web add <path-to-this-repo>
```

Then restart dsh web (`dsh web`, or whatever your launch script is). The
plugin joins the profile as a bundle: its
`cordis.patch.yml` inserts the loader entry, the `dsh.client` declaration
composes the browser bundle, and the base-layer typert-loader picks up the
`./typert` manifest so the api-gateway serves `deepseekBalance/fetch`.

## Required local patch: expose the settings namespace

The web API proxy only serves settings namespaces on an explicit allowlist
(`WEB_SETTINGS_NAMESPACES` in
`@deepseek-ai/dsh-host-apiproxy/lib/index.js`); namespaces outside it are
invisible to the browser (read and write are refused). This plugin therefore
requires the same local patch the maid-atelier skin already carries in that
file:

```js
const WEB_SETTINGS_NAMESPACES = [
  // ...
  "ui-skin-maid-atelier",
  // Local patch: expose the DeepSeek balance monitor's refresh interval
  // (deepseek-balance-monitor).
  "deepseek-balance-monitor"
];
```

**After any `dsh` reinstall/update this patch must be re-applied** (the file
lives in the global npm install). Verify with
`dsh web --dump-config` (the namespace should appear in `settings.describe`
after boot).

## Smoke tests

```sh
node smoke-host.mjs       # boots a real cordis root; drives the gateway with a stubbed fetch
node smoke-host2.mjs      # typert manifest + real api-gateway claim/dispatch
node smoke-host3.mjs      # real settings provider register/mutate round trip (isolated file)
node smoke-host4.mjs      # loader-style ctx.plugin mount simulation
node smoke-client.cjs     # loads lib/client.js via a mocked __ModuleLoader__; drives badge/tab logic
node smoke-client-real.cjs # real SettingsScopeController + real binder end-to-end
```
