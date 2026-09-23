import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { validateStrategySpec, STRATEGY_SPEC_HARD_SIGNAL_VERSION, type StrategySpec } from './strategySpec'

const db = new DatabaseSync(':memory:')
const baseline = readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
const table = baseline.match(/CREATE TABLE IF NOT EXISTS strategy_spec_registry \([\s\S]*?\n\);/)?.[0]
assert(table, 'strategy registry baseline table missing')
db.exec(table)

const cases = [
  ['stock_tech_s01_55d_trend_volume_breakout_v1', '01', 'active'],
  ['stock_tech_s02_52w_dual_momentum_v1', '02', 'active'],
  ['stock_tech_s04_ma_deduct_turn_breakout_v1', '04', 'active'],
  ['stock_tech_s06_nr7_inside_bar_breakout_v1', '06', 'active'],
  ['stock_tech_s11_gap_breakout_continuation_v1', '11', 'retired'],
] as const
const insert = db.prepare(`INSERT INTO strategy_spec_registry (
  strategy_id, version, name, status, owner, alpha_bucket, family_id,
  variant_id, owner_type, promotion_status, supported_regimes_json, thesis,
  thresholds_json, candidate_policy_json, risk_notes_json, source_refs_json
) VALUES (?, 'strategy-spec-v1', ?, ?, 'strategy', 'trend_following',
  'TREND_RECLAIM_CONTINUATION', ?, ?, ?, '["bull"]', 'test', ?, ?, '[]', '[]')`)
for (const [id, suffix, status] of cases) {
  insert.run(id, id, status, id, status === 'retired' ? 'retired' : 'strategy',
    status === 'retired' ? 'retired' : 'production',
    JSON.stringify({
      minPrice: 10,
      dsl: { all: [{ signal: `technicalIndicators.stockTechS${suffix}Admission`, op: '==', value: 1 }] },
      technicalStrategy: {
        id: `S${Number(suffix)}`,
        requiresMaterializedAdmission: `technicalIndicators.stockTechS${suffix}Admission`,
        requiresMaterializedSignal: `technicalIndicators.stockTechS${suffix}Signal`,
        scoreSignal: `technicalIndicators.stockTechS${suffix}Score`,
        admissionPolicy: 'adaptive_score_priority_or_hard_signal',
      },
    }),
    JSON.stringify({
      poolQuota: 10,
      evidenceRequirements: [
        'technical_strategy12',
        `materialized_admission:stockTechS${suffix}Admission`,
        `materialized_signal:stockTechS${suffix}Signal`,
        `materialized_score:stockTechS${suffix}Score`,
      ],
    }),
  )
}
const migration = readFileSync('domain-migrations/learning/0053_stock_technical_hard_signal_semantics.sql', 'utf8')
db.exec(migration)
db.exec(migration)

for (const [id, suffix, status] of cases) {
  const rows = db.prepare('SELECT * FROM strategy_spec_registry WHERE strategy_id=? ORDER BY version').all(id) as Record<string, any>[]
  assert.equal(rows.length, status === 'retired' ? 1 : 2)
  const old = rows.find((row) => row.version === 'strategy-spec-v1')!
  assert.equal(old.status, 'retired', 'historical adaptive-admission version must be retained but not served')
  assert.equal(JSON.parse(old.thresholds_json).dsl.all[0].signal, `technicalIndicators.stockTechS${suffix}Admission`)
  if (status === 'retired') continue
  const current = rows.find((row) => row.version === STRATEGY_SPEC_HARD_SIGNAL_VERSION)!
  assert.equal(current.status, 'active')
  const thresholds = JSON.parse(current.thresholds_json)
  assert.equal(thresholds.dsl.all[0].signal, `technicalIndicators.stockTechS${suffix}Signal`)
  assert.equal(thresholds.technicalStrategy.requiresMaterializedAdmission, undefined)
  assert.equal(thresholds.technicalStrategy.admissionPolicy, undefined)
  const requirements: string[] = JSON.parse(current.candidate_policy_json).evidenceRequirements
  assert(!requirements.some((item) => item.startsWith('materialized_admission:')))
  assert(requirements.includes(`materialized_signal:stockTechS${suffix}Signal`))
  const spec: StrategySpec = {
    id, version: current.version, name: current.name, status: 'active', owner: 'strategy',
    familyId: 'TREND_RECLAIM_CONTINUATION', ownerType: 'strategy', promotionStatus: 'production',
    alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'test',
    thresholds, candidatePolicy: JSON.parse(current.candidate_policy_json),
    riskNotes: JSON.parse(current.risk_notes_json), createdBy: current.created_by,
  }
  assert.deepEqual(validateStrategySpec(spec), { ok: true, errors: [] })
  assert(validateStrategySpec({
    ...spec, thresholds: { ...thresholds, dsl: { all: [{
      signal: `technicalIndicators.stockTechS${suffix}Admission`, op: '==', value: 1,
    }] } },
  }).errors.includes('hard_signal_contract_invalid'))
}
db.close()