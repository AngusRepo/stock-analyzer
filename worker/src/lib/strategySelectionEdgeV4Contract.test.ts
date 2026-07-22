import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname)
const learning = fs.readFileSync(path.join(root, 'strategyLearning.ts'), 'utf8')
const screener = fs.readFileSync(path.join(root, 'marketScreener.ts'), 'utf8')
const labels = fs.readFileSync(path.join(root, 'canonicalSelectionLabels.ts'), 'utf8')
const reference = fs.readFileSync(path.join(root, 'selectionReferenceEvidence.ts'), 'utf8')

assert.match(learning, /canonical_selection_labels_v4/)
assert.match(learning, /residual_return_net/)
assert.doesNotMatch(learning.slice(learning.indexOf('export async function listStrategyRewardSourceRows'), learning.indexOf('export async function persistStrategyRewardLedgerRows')), /trade_pnl_pct|actual_return_pct/)
assert.match(screener, /policyState\?\.status === 'active'/)
assert.doesNotMatch(screener, /strategyWeights: policyState\?\.strategy_weights/)
assert.match(labels, /future\[0\]/)
assert.match(labels, /future\[4\]/)
assert.match(labels, /canonical_market_daily/)
assert.match(labels, /source = 'finlab\.price'/)
assert.match(labels, /entryAdjClose \/ entryClose/)
assert.match(labels, /exitAdjClose \/ exitClose/)
assert.match(reference, /expectedCells = references\.length \* specs\.length/)
assert.match(reference, /strategy_label_matrix_persisted_coverage_mismatch/)
assert.match(reference, /reconcileSelectionDecisionEvidenceV4/)
assert.match(reference, /allocation_selected/)
assert.match(reference, /score_components/)
assert.match(reference, /expected_return_owner_unavailable/)

console.log('strategySelectionEdgeV4Contract tests passed')
