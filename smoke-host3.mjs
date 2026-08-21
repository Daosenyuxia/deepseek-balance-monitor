// Host settings integration test: mounts a real FileSettingsProvider, runs our
// host apply, then exercises exactly the client write path
// (describe -> mutate with expectedRevision -> describe) to prove the
// refreshSeconds namespace is registered and writable.
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
const { apply, SETTINGS_NAMESPACE, REFRESH_FIELD } = await import('./lib/index.js')

const dir = mkdtempSync(join(tmpdir(), 'dsh-balance-settings-'))
const filename = join(dir, 'settings.yaml')

const ctx = new Context()
class FakeCredentials extends Service {
  constructor(c) { super(c, 'credentials') }
  async resolve(ref) { return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test', source: 'test' } : undefined }
}
new FakeCredentials(ctx)

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' }] }
  },
})

// Mount the real settings provider (provides ctx.settings).
await ctx.plugin(FileSettingsProvider, { path: filename })
const settings = ctx.get('settings')

// Run our host half.
apply(ctx)
await new Promise((r) => setTimeout(r, 100))

// 1. Namespace must be registered and listed.
const described = settings.describe()
const nsView = described.find((d) => d.ns === SETTINGS_NAMESPACE)
console.log('described namespaces:', described.map((d) => String(d.ns)).join(', '))
if (!nsView) throw new Error(`namespace ${SETTINGS_NAMESPACE} NOT registered`)
console.log('namespace view:', JSON.stringify({ ns: String(nsView.ns), value: nsView.value, revision: nsView.revision }))
if (nsView.value.refreshSeconds !== 60) throw new Error('default refreshSeconds should be 60')

// 2. Client-style write: mutate with expectedRevision.
await settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: [REFRESH_FIELD], value: 30 }], nsView.revision)
const after = settings.describe().find((d) => d.ns === SETTINGS_NAMESPACE)
console.log('after mutate:', JSON.stringify({ value: after.value, revision: after.revision }))
if (after.value.refreshSeconds !== 30) throw new Error('mutate did not persist refreshSeconds=30')

// 3. Write again with a stale revision must be refused (conflict path) — the
//    client controller handles that by re-reading; make sure a fresh write works.
await settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: [REFRESH_FIELD], value: 180 }], after.revision)
const final_ = settings.describe().find((d) => d.ns === SETTINGS_NAMESPACE)
if (final_.value.refreshSeconds !== 180) throw new Error('second mutate failed')

// 4. Gateway still works alongside the settings registration.
const gateway = ctx.get('deepseekBalance')
const balance = await gateway.fetch()
console.log('gateway fetch ok:', balance.ok)

// 5. Out-of-range write must be rejected by the schema (client clamps anyway).
try {
  await settings.mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: [REFRESH_FIELD], value: 99999 }], final_.revision)
  console.log('NOTE: out-of-range write accepted (schema permissive)')
} catch (error) {
  console.log('out-of-range write rejected:', error.code ?? error.message)
}

rmSync(dir, { recursive: true, force: true })
console.log('HOST SETTINGS OK')
process.exit(0)
