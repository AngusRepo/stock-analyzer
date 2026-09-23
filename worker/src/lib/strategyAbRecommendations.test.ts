import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
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
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE l4_portfolio_plans_v1 (account_id INTEGER, signal_date TEXT, plan_id TEXT, payload_json TEXT); CREATE TABLE paired_nav_frozen_manifests_v1 (signal_date TEXT, snapshot_kind TEXT, frozen_at TEXT)')
    const insert = db.prepare('INSERT INTO l4_portfolio_plans_v1 VALUES(1,?,?,?)')
    for (const [date, id, parent, symbol] of [
      ['2026-09-21', 'day1', null, '2485'],
      ['2026-09-22', 'day2', 'day1', '3576'],
      ['2026-09-22', 'day2-revised', 'day2', '3691'],
    ]) insert.run(date, id, JSON.stringify({ signal_date: date, plan_id: id, parent_plan_id: parent, weights: { [symbol!]: .25 } }))
    const live = { DB: { prepare(sql: string) { return { bind(...args: any[]) { return {
      async first() { return db.prepare(sql).get(...args) ?? null },
      async all() { return { results: db.prepare(sql).all(...args) } },
    } } } } }, KV: { async get() { return null } } } as any
    const day1 = await readStrategyAbRecommendations(live, '2026-09-21')
    const day2 = await readStrategyAbRecommendations(live, '2026-09-22')
    assert.equal(day1.A.source_id, 'day1')
    assert.equal(day2.A.source_id, 'day2-revised')
    assert.deepEqual(day2.A.picks, [{ symbol: '3691', weight: .25 }])
    assert.equal(day2.B.status, 'unavailable')
    const absent = await readStrategyAbRecommendations(live, '2026-09-23')
    assert.equal(absent.A.status, 'unavailable')
    assert.equal(absent.B.status, 'unavailable')
  } finally { db.close() }
  console.log('strategyAbRecommendations tests passed')
}
void testReadback().catch(error => { console.error(error); process.exitCode = 1 })
