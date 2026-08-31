import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS,
} from './selectionReferenceEvidence'

assert.deepEqual(SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS, [
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
])
assert.equal(
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
  'selection-reference-snapshot-v3',
)

const labels = readFileSync(new URL('./canonicalSelectionLabels.ts', import.meta.url), 'utf8')
assert.match(labels, /r\.feature_contract_version IN \(\?, \?\)/)
assert.match(labels, /l\.reference_contract_version = r\.feature_contract_version/)
assert.match(labels, /row\.reference\.feature_contract_version/)
assert.match(
  labels,
  /DELETE FROM canonical_selection_labels_v4\s+WHERE signal_date=\? AND symbol=\? AND producer_run_id=\?/,
)
assert.doesNotMatch(
  labels,
  /CANONICAL_SELECTION_ADJUSTMENT_SOURCE, SELECTION_REFERENCE_CONTRACT_VERSION/,
  'derived labels must retain the immutable canonical producer contract',
)

const recovery = readFileSync(new URL('./matureSelectionEvidenceRecovery.ts', import.meta.url), 'utf8')
assert.match(recovery, /mr\.reference_contract_version=\? AND mr\.labeler_version IN \(\?, \?\)/)
assert.match(recovery, /STRATEGY_FORMAL_LABELER_LEGACY_VERSION/)
assert.match(recovery, /r\.feature_contract_version=mr\.reference_contract_version/)
assert.match(recovery, /l\.reference_contract_version=mr\.reference_contract_version/)
assert.match(recovery, /mc\.reference_contract_version=mr\.reference_contract_version/)
assert.match(recovery, /l\.label_schema_version=\? AND l\.adjustment_source=\?/)

const closure = readFileSync(new URL('./eveningChainEvidenceClosure.ts', import.meta.url), 'utf8')
assert.match(closure, /matureReferenceContractVersion/)
assert.match(closure, /reference_contract_version=\? AND labeler_version IN \(\?, \?\)/)
assert.match(closure, /STRATEGY_FORMAL_LABELER_LEGACY_VERSION/)
assert.match(closure, /matureMatrix\?\.matrix_rows/)
assert.match(closure, /matureMatrix\?\.reference_contract_rows/)
assert.match(
  closure,
  /CANONICAL_SELECTION_LABEL_SCHEMA_VERSION,\s+matureReferenceContractVersion,\s+CANONICAL_SELECTION_ADJUSTMENT_SOURCE,\s+matureSignalDate,\s+matureReferenceContractVersion/,
)

const projection = readFileSync(new URL('./priceHorizonProjection.ts', import.meta.url), 'utf8')
assert.match(
  projection,
  /feature_contract_version IN \(\?, \?\)[\s\S]*SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS/,
)

const orchestrator = readFileSync(new URL('./updateOrchestrator.ts', import.meta.url), 'utf8')
assert.match(
  orchestrator,
  /strategy-learning:finalizer:\$\{triggerTime\}:\$\{canonicalRunId\}:\$\{finalizerCacheMode\}:v2-contract-lineage/,
)
