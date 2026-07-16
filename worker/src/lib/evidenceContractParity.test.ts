import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOCATOR_EV_FUSION_CONTRACT,
  EVIDENCE_LABEL_SCHEMA_VERSION,
  L4_ALPHA_EV_CONTRACT,
} from './evidenceContracts'

const workerDir = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const pythonContract = readFileSync(
  resolve(workerDir, '../ml-controller/services/evidence_contracts.py'),
  'utf8',
)

function pythonConstant(name: string): string {
  const match = pythonContract.match(new RegExp(`^${name}\\s*=\\s*["']([^"']+)["']`, 'm'))
  assert(match, `missing Python evidence contract constant: ${name}`)
  return match[1]
}

assert.equal(
  EVIDENCE_LABEL_SCHEMA_VERSION,
  pythonConstant('LABEL_SCHEMA_VERSION'),
  'Python/Worker label schema contract drifted',
)
assert.equal(
  L4_ALPHA_EV_CONTRACT.artifactContractVersion,
  pythonConstant('L4_ARTIFACT_CONTRACT_VERSION'),
)
assert.equal(
  L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
  pythonConstant('L4_FEATURE_SEMANTIC_VERSION'),
)
assert.equal(
  ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
  pythonConstant('ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION'),
)
assert.equal(
  ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
  pythonConstant('ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION'),
)
