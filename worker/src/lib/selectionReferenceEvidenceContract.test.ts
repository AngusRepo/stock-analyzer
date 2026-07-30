import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./selectionReferenceEvidence.ts', import.meta.url), 'utf8')

assert.match(source, /reference_contract_version=excluded\.reference_contract_version/)
assert.match(source, /strategy_labeler_version=excluded\.strategy_labeler_version/)
assert.match(source, /strategy_affinity_version=excluded\.strategy_affinity_version/)
assert.match(source, /strategy_registry_checksum=excluded\.strategy_registry_checksum/)
assert.match(source, /feature_contract_version=excluded\.feature_contract_version/)
assert.match(source, /evidence_artifact_id=excluded\.evidence_artifact_id/)
