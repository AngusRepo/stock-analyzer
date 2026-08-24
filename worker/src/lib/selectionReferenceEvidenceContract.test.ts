import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./selectionReferenceEvidence.ts', import.meta.url), 'utf8')

assert.match(source, /strategy_label_matrix_immutable_run_conflict/)
assert.match(source, /clean\(existing\.reference_contract_version\) === SELECTION_REFERENCE_CONTRACT_VERSION/)
assert.match(source, /clean\(existing\.evidence_artifact_id\) === input\.evidenceArtifactId/)
assert.match(source, /clean\(existing\.payload_checksum\) === payloadChecksum/)
assert.match(source, /selection_reference_ready_contract_mismatch/)
assert.match(source, /reference_identity_count/)
