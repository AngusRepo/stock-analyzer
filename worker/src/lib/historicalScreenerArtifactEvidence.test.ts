import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { loadHistoricalScreenerArtifactEvidence } from './historicalScreenerArtifactEvidence'

const signalDate = '2026-07-30'
const producerRunId = 'screener-2026-07-30-canonical'
const manifest = JSON.stringify({
  schema_version: 'screener-funnel-evidence-index-v1',
  business_date: signalDate,
  payload: {
    storage_mode: 'chunked_r2_manifest_v1',
    logical_schema_version: 'screener-funnel-evidence-v3',
    payload_header: {
      metadata: {
        strategyCandidatePool: {
          strategy_labeler_version: 'strategy-labeler-v1',
          strategy_matrix_candidate_count: 590,
          strategy_matrix_strategy_count: 27,
          strategy_matrix_expected_cell_count: 15930,
          strategy_matrix_coverage_ratio: 1,
          strategy_portfolio_metrics: { regime: 'sideways' },
        },
      },
    },
  },
})
const checksum = `sha256:${createHash('sha256').update(manifest).digest('hex')}`

function envWithChecksum(value: string) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            artifact_id: 'artifact:screener_funnel:2026-07-30:verified',
            r2_key: 'evidence/verified.json',
            checksum: value,
            canonical_at: '2026-07-30T14:36:36.236Z',
          }),
        }),
      }),
    },
    ARTIFACTS: {
      get: async () => ({ text: async () => manifest }),
    },
  } as any
}

async function main() {
  const verified = await loadHistoricalScreenerArtifactEvidence(
    envWithChecksum(checksum), signalDate, producerRunId,
  )
  assert.equal(verified?.source_labeler_version, 'strategy-labeler-v1')
  assert.equal(verified?.candidate_count, 590)
  assert.equal(verified?.strategy_count, 27)
  assert.equal(verified?.expected_cell_count, 15930)
  assert.equal(verified?.matrix_coverage_ratio, 1)
  assert.equal(verified?.regime, 'sideways')

  const checksumMismatch = await loadHistoricalScreenerArtifactEvidence(
    envWithChecksum('sha256:wrong'), signalDate, producerRunId,
  )
  assert.equal(checksumMismatch, null)

  console.log('historical screener artifact evidence tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
