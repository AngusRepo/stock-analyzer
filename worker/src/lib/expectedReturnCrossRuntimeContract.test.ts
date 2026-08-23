import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'

const repoRoot = path.resolve(process.cwd(), '..')
const manifest = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'schemas/expected-return-contracts-v1.json'),
  'utf8',
)) as any
const pythonContracts = fs.readFileSync(
  path.join(repoRoot, 'ml-controller/services/evidence_contracts.py'),
  'utf8',
)
const l4Builder = fs.readFileSync(
  path.join(repoRoot, 'ml-controller/services/l4_alpha_ev_artifact_builder.py'),
  'utf8',
)
const fusionBuilder = fs.readFileSync(
  path.join(repoRoot, 'ml-controller/services/allocator_ev_fusion_artifact_builder.py'),
  'utf8',
)
const maturityAdapter = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/expectedReturnMaturityEvidence.ts'),
  'utf8',
)

const l4Manifest = manifest.owners.l4_alpha_ev.current
const fusionManifest = manifest.owners.allocator_ev_fusion.current
assert.equal(L4_ALPHA_EV_CONTRACT.artifactContractVersion, l4Manifest.artifact_contract_version)
assert.equal(L4_ALPHA_EV_CONTRACT.featureSemanticVersion, l4Manifest.feature_semantic_version)
assert.equal(L4_ALPHA_EV_CONTRACT.labelSchemaVersion, l4Manifest.label_schema_version)
assert.equal(L4_ALPHA_EV_CONTRACT.modelVersionPrefix, l4Manifest.model_version_prefix)
assert.equal(L4_ALPHA_EV_CONTRACT.validationSchemaVersion, l4Manifest.validation_schema_version)
assert.equal(L4_ALPHA_EV_CONTRACT.expectedReturnSemantic, l4Manifest.expected_return_semantic)
assert.equal(ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion, fusionManifest.artifact_contract_version)
assert.equal(ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion, fusionManifest.feature_semantic_version)
assert.equal(ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion, fusionManifest.label_schema_version)
assert.equal(ALLOCATOR_EV_FUSION_CONTRACT.modelVersionPrefix, fusionManifest.model_version_prefix)
assert.equal(ALLOCATOR_EV_FUSION_CONTRACT.validationSchemaVersion, fusionManifest.validation_schema_version)
assert.equal(ALLOCATOR_EV_FUSION_CONTRACT.expectedReturnSemantic, fusionManifest.expected_return_semantic)
assert(pythonContracts.includes('expected-return-contracts-v1.json'))
assert(pythonContracts.includes('SUPPORTED_L4_SERVING_CONTRACT_PAIRS'))
for (const retired of manifest.owners.l4_alpha_ev.retired_compatibility) {
  assert.equal(retired.serve_eligible, false)
  assert.equal(retired.accept_new_candidates, false)
  assert.equal(retired.retired_at, '2026-08-23')
}

assert(l4Builder.includes('l4-alpha-ev-ridge-v5-sector-'))
assert(l4Builder.includes('"schema_version": "l4-alpha-ev-validation-packet-v1"'))
assert(fusionBuilder.includes('allocator-ev-fusion-residual-v14-'))
assert(fusionBuilder.includes('"schema_version": "allocator-ev-fusion-validation-packet-v14"'))
assert(maturityAdapter.includes('modelVersionPrefix: L4_ALPHA_EV_CONTRACT.modelVersionPrefix'))
assert(maturityAdapter.includes('validationSchema: L4_ALPHA_EV_CONTRACT.validationSchemaVersion'))
assert(maturityAdapter.includes('modelVersionPrefix: ALLOCATOR_EV_FUSION_CONTRACT.modelVersionPrefix'))
assert(maturityAdapter.includes('validationSchema: ALLOCATOR_EV_FUSION_CONTRACT.validationSchemaVersion'))

console.log('expected-return cross-runtime contract tests passed')
