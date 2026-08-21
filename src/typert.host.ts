/**
 * Host Typert manifest for the balance gateway (the `exports["./typert"]`
 * artifact the Host typert-loader imports and registers into the shared
 * `ctx.typert` registry).
 *
 * With this strict descriptor in place, the api-gateway claims and dispatches
 * `deepseekBalance/fetch` through the shared registry — it does not need to
 * discover the `@Remote` markers, which would be invisible across separate
 * copies of `dsh-typert-protocol` (each copy keeps its own private marker
 * table).
 */
import { z } from 'zod'

const balanceCurrencySchema = z.object({
  currency: z.string(),
  totalBalance: z.number(),
  grantedBalance: z.number(),
  toppedUpBalance: z.number(),
})

const balanceResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    fetchedAt: z.number(),
    isAvailable: z.boolean(),
    balances: z.array(balanceCurrencySchema),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['no-key', 'transport', 'http', 'invalid']),
    message: z.string().optional(),
  }),
])

export const TYPERT = {
  package: '@dsh-external/deepseek-balance-monitor',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@dsh-external/deepseek-balance-monitor#deepseekBalance/fetch',
      service: 'deepseekBalance',
      namespace: 'deepseekBalance',
      method: 'fetch',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@dsh-external/deepseek-balance-monitor#BalanceResult',
        schema: balanceResultSchema,
      },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
