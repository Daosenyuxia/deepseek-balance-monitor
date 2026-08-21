// Host integration test: registers our ./typert manifest into a real
// TypertRegistry (from the profile's resolution), boots our gateway, then
// drives the REAL api-gateway's claim + dispatch path end to end.
import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Resolve the dsh profile to load the real registry/gateway packages from.
// Override with DSH_PROFILE_DIR (path to the profile's package.json) when your
// profile lives elsewhere.
const requireProfile = createRequire(
  process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
)
const { TypertRegistry } = requireProfile('@deepseek-ai/dsh-typert-registry')
const TypertGatewayService = requireProfile('@deepseek-ai/dsh-api-gateway').default
const { TYPERT } = await import('./lib/typert.host.js')
const { apply } = await import('./lib/index.js')

const ctx = new Context()

// Host typert registry (the typert-loader would register our manifest here).
new TypertRegistry(ctx)
ctx.typert.register(TYPERT)
console.log('manifest registered; local descriptor:', JSON.stringify(ctx.typert.local.get('deepseekBalance/fetch')?.id))

// Fake credential provider + our plugin host half.
class FakeCredentials extends Service {
  constructor(c) { super(c, 'credentials') }
  async resolve(ref) {
    if (ref === 'DEEPSEEK_API_KEY') return { value: 'sk-test-123', source: 'test' }
    return undefined
  }
}
new FakeCredentials(ctx)

globalThis.fetch = async (url, options) => {
  if (options?.headers?.authorization !== 'Bearer sk-test-123') return { ok: false, status: 401 }
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        ],
      }
    },
  }
}

apply(ctx)

// Real api-gateway (host copy). Its rpc intercept needs `connection`, which is
// absent here, so exercise claimsEndpoint/invoke/dispatchRpc directly.
const gateway = new TypertGatewayService(ctx)

const claimed = gateway.claimsEndpoint('deepseekBalance/fetch')
console.log('claimsEndpoint:', claimed)
if (!claimed) throw new Error('endpoint NOT claimed by api-gateway')

const invoked = await gateway.invoke({ namespace: 'deepseekBalance', method: 'fetch', args: {} })
console.log('invoke result:', JSON.stringify(invoked))
if (invoked.ok !== true || invoked.balances[0].totalBalance !== 110) {
  throw new Error('invoke did not return the balance snapshot')
}

const dispatched = await gateway.dispatchRpc('deepseekBalance/fetch', { args: {} }, new AbortController().signal)
console.log('dispatchRpc envelope:', JSON.stringify(dispatched))
if (dispatched.ok !== true || dispatched.value?.ok !== true) {
  throw new Error('dispatchRpc did not produce the RPC envelope')
}

// Boundary validation must reject a malformed result through the zod codec.
const bad = await gateway.invoke({ namespace: 'deepseekBalance', method: 'fetch', args: {} })
console.log('schema decode sanity (ok field):', typeof bad.ok)

// Unknown endpoint must NOT be claimed.
if (gateway.claimsEndpoint('deepseekBalance/nope')) throw new Error('unknown endpoint claimed')
if (gateway.claimsEndpoint('other/thing')) throw new Error('unrelated endpoint claimed')

console.log('HOST INTEGRATION OK')
process.exit(0)
