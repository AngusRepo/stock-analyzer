import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname)
const learning = fs.readFileSync(path.join(root, 'strategyLearning.ts'), 'utf8')
const screener = fs.readFileSync(path.join(root, 'marketScreener.ts'), 'utf8')
const labels = fs.readFileSync(path.join(root, 'canonicalSelectionLabels.ts'), 'utf8')
const reference = fs.readFileSync(path.join(root, 'selectionReferenceEvidence.ts'), 'utf8')
const canonicalLabels = fs.readFileSync(path.join(root, 'canonicalSelectionLabels.ts'), 'utf8')
const thresholdCalibration = fs.readFileSync(path.join(root, 'strategyThresholdCalibration.ts'), 'utf8')
const evaluableMigration = fs.readFileSync(path.join(root, '../../migrations/0090_daily_technical_strategy_producer_closure.sql'), 'utf8')

assert.match(learning, /canonical_selection_labels_v4/)
assert.match(learning, /residual_return_net/)
assert.doesNotMatch(learning.slice(learning.indexOf('export async function listStrategyRewardSourceRows'), learning.indexOf('export async function persistStrategyRewardLedgerRows')), /trade_pnl_pct|actual_return_pct/)
assert.match(screener, /policyState\?\.status === 'active'/)
assert.doesNotMatch(screener, /strategyWeights: policyState\?\.strategy_weights/)
assert.match(labels, /price_horizon_labels_v1/)
assert.match(labels, /price_horizon_label_rejections_v1/)
assert.match(labels, /PRICE_HORIZON_PROJECTION_VERSION/)
assert.doesNotMatch(labels, /future\[0\]|future\[4\]/)
assert.match(labels, /horizon\.entry_adjustment_factor/)
assert.match(labels, /horizon\.exit_adjustment_factor/)
assert.match(reference, /expectedCells = references\.length \* specs\.length/)
assert.match(reference, /strategy_label_matrix_persisted_coverage_mismatch/)
assert.match(reference, /reconcileSelectionDecisionEvidenceV4/)
assert.match(reference, /allocation_selected/)
assert.match(reference, /score_components/)
assert.match(reference, /expected_return_owner_unavailable/)
assert.match(canonicalLabels, /r\.feature_contract_version = \?/)
assert.match(canonicalLabels, /NOT EXISTS \(SELECT 1 FROM canonical_selection_labels_v4/)
assert.match(canonicalLabels, /SELECTION_REFERENCE_CONTRACT_VERSION/)
const thresholdEvidenceLoader = thresholdCalibration.slice(
  thresholdCalibration.indexOf('export async function listStrategyThresholdCalibrationEvidenceRows'),
  thresholdCalibration.indexOf('export function buildStrategyThresholdAutoDecisions'),
)
assert.match(thresholdEvidenceLoader, /canonical_selection_labels_v4/)
assert.match(thresholdEvidenceLoader, /strategy-evaluation-v2/)
assert.match(thresholdEvidenceLoader, /selection-reference-snapshot-v3/)
assert.match(thresholdEvidenceLoader, /canonical_run_heads/)
assert.doesNotMatch(thresholdEvidenceLoader, /JOIN predictions|trade_pnl_pct|actual_return_pct/)

console.log('strategySelectionEdgeV4Contract tests passed')
const dailyTechnicalCandidateIds = [
  'stock_tech_s03_vcp_contraction_breakout_v1',
  'stock_tech_s05_first_dry_pullback_v1',
  'stock_tech_s07_2b_false_break_reversal_v1',
  'stock_tech_s08_rsi2_bull_mean_reversion_v1',
  'stock_tech_s09_three_soldiers_base_breakout_v1',
  'stock_tech_s10_island_reversal_v1',
]
for (const strategyId of dailyTechnicalCandidateIds) assert.match(evaluableMigration, new RegExp(strategyId))
for (const suffix of ['03', '05', '07', '08', '09', '10']) {
  assert.match(evaluableMigration, new RegExp(`stockTechS${suffix}Signal`))
}
assert.match(evaluableMigration, /status = 'candidate'/)
assert.match(evaluableMigration, /owner_type = 'strategy'/)
assert.match(evaluableMigration, /promotion_status = 'candidate'/)
assert.match(evaluableMigration, /\$\.maxMlShare', 0/)
assert.match(evaluableMigration, /stock_tech_s12_multitimeframe_smc_reclaim_v1/)
assert.match(evaluableMigration, /s12_structure_snapshots/)