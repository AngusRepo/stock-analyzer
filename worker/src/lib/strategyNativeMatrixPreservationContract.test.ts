import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')

assert.match(
  source,
  /mr\.labeler_version IN \([\s\S]*STRATEGY_FORMAL_LABELER_VERSION[\s\S]*STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/,
  'historical repair discovery must treat a complete native matrix as closed',
)
assert.match(
  source,
  /STRATEGY_FORMAL_LABELER_VERSIONS\.some\(\(version\) => version === cleanToken\(existingMatrix\.labeler_version\)\)/,
  'historical repair must reuse a complete native matrix instead of deleting Route V2 evidence',
)
assert.doesNotMatch(
  source,
  /DELETE FROM strategy_label_matrix_v4 WHERE producer_run_id/,
  'historical repair must never delete canonical matrix before the atomic staging cutover',
)
assert.match(
  source,
  /const persisted = await persistSelectionEvidenceV4\(db,/,
  'incomplete historical matrix replacement must use the durable atomic evidence writer',
)
assert.match(
  source,
  /existingMatrixProjectionRows === expectedMatrixRows[\s\S]*existingMatrixProjectedThresholdRows === existingMatrixMatchedRows/,
  'historical repair must only reuse a matrix whose challenger projection is complete',
)
assert.match(
  source,
  /existingMatrixContractRows === expectedMatrixRows/,
  'historical repair must reject a mixed-labeler or mixed-contract matrix even when row counts match',
)
