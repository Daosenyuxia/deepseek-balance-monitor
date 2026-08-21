// Simulates the loader's entry mounting: our plugin module is mounted via
// ctx.plugin (a fiber wrapper) alongside a real FileSettingsProvider, and any
// settings.register failure is captured and printed.
import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Resolve the dsh profile to load the real settings provider from. Override
// with DSH_PROFILE_DIR (path to the profile's package.json) when your profile
// lives elsewhere.
const requireProfile = createRequire(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
)
const { FileSettingsProvider } = requireProfile('@deepseek-ai/dsh-settings-file')
const plugin = await import('./lib/index.js')

const dir = mkdtempSync(join(tmpdir(), 'dsh-balance-sim-'))
const ctx = new Context()

class FakeCredentials extends Service {
  constructor(c) { super(c, 'credentials') }
  async resolve(ref) { return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-x', source: 'test' } : undefined }
}
new FakeCredentials(ctx)
globalThis.fetch = async () => ({
  ok: true, status: 200,
  async json() { return { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] } },
})

await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml') })

// Mount our plugin the way the loader does (fiber wrapper; no module inject).
const fiber = ctx.plugin({ name: 'deepseek-balance-monitor', apply: plugin.apply })
console.log('entry fiber created')

await new Promise((r) => setTimeout(r, 300))
const settings = ctx.get('settings')
const described = settings.describe()
const hit = described.find((d) => String(d.ns) === 'deepseek-balance-monitor')
console.log('namespaces:', described.map((d) => String(d.ns)).join(', '))
if (!hit) {
  // Try registering manually to surface the real error.
  try {
    settings.register(plugin.SETTINGS_NAMESPACE, plugin.BalanceSettingsSchema)
    console.log('manual register: OK')
  } catch (error) {
    console.log('manual register FAILED:', error?.message ?? String(error))
  }
} else {
  console.log('namespace registered via apply:', JSON.stringify({ value: hit.value, revision: hit.revision }))
}
const gw = ctx.get('deepseekBalance')
console.log('gateway present:', !!gw)

rmSync(dir, { recursive: true, force: true })
process.exit(0)
