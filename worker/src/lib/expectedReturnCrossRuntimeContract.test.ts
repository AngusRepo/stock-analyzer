import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'

const repoRoot = path.resolve(process.cwd(), '..')
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

for (const value of [
  L4_ALPHA_EV_CONTRACT.artifactContractVersion,
  L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
  L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
  ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
  ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
  ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
]) {
  assert(pythonContracts.includes(`"${value}"`), `Python contract drift: ${value}`)
}

assert(l4Builder.includes('l4-alpha-ev-ridge-v5-sector-'))
assert(l4Builder.includes('"schema_version": "l4-alpha-ev-validation-packet-v1"'))
assert(fusionBuilder.includes('allocator-ev-fusion-residual-v14-'))
assert(fusionBuilder.includes('"schema_version": "allocator-ev-fusion-validation-packet-v14"'))
assert(maturityAdapter.includes("modelVersionPrefix: 'l4-alpha-ev-ridge-v5-sector-'"))
assert(maturityAdapter.includes("validationSchema: 'l4-alpha-ev-validation-packet-v1'"))
assert(maturityAdapter.includes("modelVersionPrefix: 'allocator-ev-fusion-residual-v14-'"))
assert(maturityAdapter.includes("validationSchema: 'allocator-ev-fusion-validation-packet-v14'"))

console.log('expected-return cross-runtime contract tests passed')
