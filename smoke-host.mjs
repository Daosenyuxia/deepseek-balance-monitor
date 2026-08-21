// Host-half smoke test: boots a real cordis root, provides a fake credentials
// service and a stubbed global fetch, then drives the gateway through apply().
import { Context, Service } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply, DeepseekBalanceGateway, SETTINGS_NAMESPACE, REFRESH_FIELD } from './lib/index.js'

const ctx = new Context()

// Fake credential provider: serves a fixed key for DEEPSEEK_API_KEY.
class FakeCredentials extends Service {
  constructor(c) { super(c, 'credentials') }
  async resolve(ref) {
    if (ref === 'DEEPSEEK_API_KEY') return { value: 'sk-test-123', source: 'test' }
    return undefined
  }
}
new FakeCredentials(ctx)

let calledUrl = ''
let calls = 0
globalThis.fetch = async (url, options) => {
  calledUrl = url
  calls += 1
  if (options?.headers?.authorization !== 'Bearer sk-test-123') {
    return { ok: false, status: 401 }
  }
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

const gateway = ctx.get('deepseekBalance')
if (!gateway) throw new Error('gateway service not registered')

// The Typert Gateway's SRC discovery must see the fetch Remote marker.
const markers = remoteMethods(gateway)
console.log('remote markers:', JSON.stringify(markers))
if (!markers.some((m) => m.method === 'fetch')) {
  throw new Error('Remote marker for fetch missing')
}

const result = await gateway.fetch()
console.log('calledUrl:', calledUrl)
console.log('result:', JSON.stringify(result))

if (result.ok !== true) throw new Error('expected ok result, got ' + JSON.stringify(result))
if (result.balances[0].currency !== 'CNY' || result.balances[0].totalBalance !== 110) {
  throw new Error('balance parse mismatch')
}
if (calledUrl !== 'https://api.deepseek.com/user/balance') throw new Error('wrong url')

// Warm cache: second call within the fresh window must not refetch.
const before = calls
await gateway.fetch()
if (calls !== before) throw new Error('cache not served')

// No-key path.
class NoKeyCredentials extends Service {
  constructor(c) { super(c, 'credentials') }
  async resolve() { return undefined }
}
const ctx2 = new Context()
new NoKeyCredentials(ctx2)
apply(ctx2)
const gateway2 = ctx2.get('deepseekBalance')
const result2 = await gateway2.fetch()
console.log('no-key result:', JSON.stringify(result2))
if (result2.ok !== false || result2.code !== 'no-key') throw new Error('expected no-key failure')

console.log('HOST SMOKE OK')
await ctx.stop?.()
process.exit(0)
