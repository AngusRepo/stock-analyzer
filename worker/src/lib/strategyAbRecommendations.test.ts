import assert from 'node:assert/strict'
import { allocationView, validateResearchRecommendations, readStrategyAbRecommendations } from './strategyAbRecommendations'
import type { StrategyAbRecommendations } from './strategyAbRecommendationContract'

const rows = [{ symbol: '2485', allocation_weight: .25 }, { symbol: '3576', allocation_weight: .25 },
  { symbol: '3691', allocation_weight: .13 }, { symbol: '6443', allocation_weight: .05 }]
const arm = allocationView(rows, 'snapshot')
assert.equal(arm.picks.length, 4)
assert.ok(Math.abs(arm.cash_weight! - .32) < 1e-10)
assert.equal(allocationView([], 'empty').cash_weight, 1)
for (const bad of [[...rows, rows[0]], [{ symbol: '1', allocation_weight: NaN }],
  [{ symbol: '1', allocation_weight: .7 }, { symbol: '2', allocation_weight: .7 }]]) {
  assert.throws(() => allocationView(bad, 'bad'))
}
const packet: StrategyAbRecommendations = { schema_version: 'strategy-ab-recommendations-v1', date: '2026-09-22',
  scope: 'retrospective_research', generated_at: '2026-09-23T03:00:00Z', production_effect: false,
  nav_maturity_credit: 0, A: arm, B: arm,
  source_checksums: { allocation_context: 'a'.repeat(64), A_model: 'b'.repeat(64), B_model: 'c'.repeat(64) } }
assert.equal(validateResearchRecommendations(packet), packet)
for (const update of [{ nav_maturity_credit: 1 }, { production_effect: true }, { scope: 'daily_allocation' },
  { B: { ...arm, cash_weight: NaN } }, { B: { ...arm, cash_weight: 0 } }, { B: { status: 'unavailable' } }]) {
  assert.throws(() => validateResearchRecommendations({ ...packet, ...update } as any))
}
async function testReadback() {
  const raw = JSON.stringify({ payload: packet })
  const { sha256Text } = await import('./datasetSnapshots')
  const checksum = await sha256Text(raw)
  let checksumOverride = checksum
  const env = {
    DB: { prepare() { return { bind() { return { async first() { return null }, async all() { return { results: [] } } } } } } },
    KV: { async get() { return { r2_key: 'evidence/class=ten_year_cold_archive/domain=strategy-ab-recommendations/test.json', checksum: checksumOverride } } },
    ARTIFACTS: { async get() { return { async text() { return raw } } } },
  } as any
  const result = await readStrategyAbRecommendations(env, packet.date)
  assert.deepEqual(result.A.picks, arm.picks)
  assert.equal(result.scope, 'retrospective_research')
  await assert.rejects(() => readStrategyAbRecommendations(env, '2026-09-21'), /date_mismatch/)
  checksumOverride = '0'.repeat(64)
  await assert.rejects(() => readStrategyAbRecommendations(env, packet.date), /checksum_mismatch/)
  env.KV.get = async () => null
  const missing = await readStrategyAbRecommendations(env, packet.date)
  assert.equal(missing.B.status, 'unavailable')
  assert.equal(missing.B.cash_weight, null)
  console.log('strategyAbRecommendations tests passed')
}
void testReadback().catch(error => { console.error(error); process.exitCode = 1 })
