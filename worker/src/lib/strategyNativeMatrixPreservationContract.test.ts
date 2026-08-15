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
assert.match(
  source,
  /if \(reusableExistingMatrix\) \{\s*matrixRows = expectedMatrixRows\s*\} else \{[\s\S]*if \(existingMatrix\)[\s\S]*DELETE FROM strategy_label_matrix_v4/,
  'matrix deletion must remain inside the incomplete/non-native repair branch',
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
