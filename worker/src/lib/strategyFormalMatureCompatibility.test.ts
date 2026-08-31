import assert from 'node:assert/strict'
import {
  buildStrategyFormalMatureCompatibilitySql,
  isStrategyFormalMatureEvidencePair,
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
} from './selectionReferenceEvidence'
import {
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

assert.equal(isStrategyFormalMatureEvidencePair(
  SELECTION_REFERENCE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
), true)
assert.equal(isStrategyFormalMatureEvidencePair(
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
), true)
assert.equal(isStrategyFormalMatureEvidencePair(
  SELECTION_REFERENCE_CONTRACT_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
), true)
assert.equal(isStrategyFormalMatureEvidencePair(
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
), true)
assert.equal(isStrategyFormalMatureEvidencePair(
  SELECTION_REFERENCE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
), false, 'legacy labeler must not be paired with the current reference contract')
assert.equal(isStrategyFormalMatureEvidencePair(
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
), false, 'current labeler must not be paired with the legacy reference contract')

const sql = buildStrategyFormalMatureCompatibilitySql('matrix_run')
assert.match(sql.sql, /matrix_run\.reference_contract_version=\?/)
assert.match(sql.sql, /matrix_run\.labeler_version IN \(\?, \?\)/)
assert.deepEqual(sql.binds, [
  SELECTION_REFERENCE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
])
assert.throws(() => buildStrategyFormalMatureCompatibilitySql('mr; DROP TABLE x'), /invalid_strategy_formal_mature_table_alias/)
