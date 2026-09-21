import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import test from 'node:test'
import { resolveCanonicalMarketRisk } from './marketRiskRuntime'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { buildMarketRegimeState } from './marketRegimeState'
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
function inputs(fault?: 'checksum' | 'date' | 'missing') {
  const date = '2026-09-18'
  const state = buildMarketRegimeState({ label: 'sideways', runDate: fault === 'date' ? '2026-09-17' : date, computedAt: date + 'T14:00:00Z', source: 'hmm' })
  const raw = JSON.stringify(state), checksum = createHash('sha256').update(raw).digest('hex')
  let writes = 0
  const core = { prepare: () => ({ all: async () => ({ results: [
    { date, twii_close: 20000, risk_score: 20, risk_level: 'green' },
    { date: '2026-09-17', twii_close: 19900, risk_score: 20, risk_level: 'green' },
  ] }) }) }
  const market = { prepare: (sql: string) => {
    let args: unknown[] = []
    const statement = { bind: (...values: unknown[]) => { args = values; return statement },
      run: async () => { writes++; throw new Error('risk read must not write') },
      first: async () => {
        if (sql.includes('market_regime_state_history_v1')) {
          assert.deepEqual(args, [date])
          return fault === 'missing' ? null : { state_json: raw, state_checksum: fault === 'checksum' ? '0'.repeat(64) : checksum }
        }
        if (sql.includes('market_breadth')) return { date, advance_ratio: .6, bull_alignment_pct: .5 }
        if (sql.includes('market_regime_factor_packets')) return { date, score: 20, level: 'green' }
        throw new Error('unexpected query')
      },
    }
    return statement
  } }
  const kv = { get: async () => null, put: async () => { writes++; throw new Error('risk read must not write') } }
  return { core, market, kv, writes: () => writes }
}
test('expired weekend KV retains exact latest-session verified regime with no writes', async () => {
  const f = inputs()
  const result = await resolveCanonicalMarketRisk(f as any, f.kv as any, DEFAULT_RISK_CONFIG)
  assert.equal(result.status, 'ready'); assert.equal(result.date, '2026-09-18')
  assert.equal(result.regimeFamily, 'sideways'); assert.equal(f.writes(), 0)
})
for (const fault of ['checksum', 'date', 'missing'] as const) {
  test('dated risk still blocks invalid or absent regime: ' + fault, async () => {
    const f = inputs(fault)
    const result = await resolveCanonicalMarketRisk(f as any, f.kv as any, DEFAULT_RISK_CONFIG)
    assert.equal(result.status, 'blocked'); assert.equal(result.haltNewBuys, true); assert.equal(f.writes(), 0)
  })
}
