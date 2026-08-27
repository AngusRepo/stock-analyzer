import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { HistoricalScreenerArtifactEvidence } from './historicalScreenerArtifactEvidence'
import {
  auditHistoricalSelectionEvidenceRecoveryPreflight,
  referenceLineageRecoveryRetryAllowed,
} from './historicalSelectionEvidenceRecoveryPreflight'

const unavailableArtifact: HistoricalScreenerArtifactEvidence = {
  artifact_id: 'artifact:screener_funnel:2026-08-06:verified',
  artifact_checksum: `sha256:${'a'.repeat(64)}`,
  producer_run_id: 'screener-2026-08-06-canonical',
  canonical_at: '2026-08-06T14:00:00Z',
  source_labeler_version: 'strategy-labeler-v1',
  candidate_count: 540,
  strategy_count: 26,
  expected_cell_count: 14_040,
  matrix_coverage_ratio: 1,
  regime: 'sideways',
  route_recovery_packet_schema: null,
  route_recovery_packet_checksum: null,
  route_recovery_parity_checksum: null,
  route_recovery_candidate_count: 0,
  route_recovery_score_count: 0,
  route_recovery_artifact_id: null,
  route_recovery_r2_key: null,
  route_recovery_artifact_checksum: null,
  route_recovery_packet_ready: false,
  route_recovery_scores: [],
}

function fakeDb(overrides: Record<string, unknown> = {}) {
  let writes = 0
  return {
    get writes() { return writes },
    prepare(sql: string) {
      assert.match(sql, /strategy_decision_log/)
      return {
        bind() {
          return {
            async first() {
              return {
                decision_rows: 14_040,
                decision_symbols: 540,
                decision_strategies: 26,
                evaluation_contract_rows: 14_040,
                pit_packet_rows: 14_040,
                mature_label_rows: 520,
                rejected_label_rows: 20,
                reference_rows: 0,
                matrix_rows: 0,
                matrix_run_status: 'writing',
                matrix_run_expected_rows: 14_040,
                ...overrides,
              }
            },
            async run() { writes += 1 },
          }
        },
      }
    },
  }
}

async function main() {
  const missingCarrierDb = fakeDb()
  const unavailable = await auditHistoricalSelectionEvidenceRecoveryPreflight(
    missingCarrierDb as unknown as D1Database,
    {
      signalDate: '2026-08-06',
      producerRunId: 'screener-2026-08-06-canonical',
      asOfDate: '2026-08-24',
      artifactEvidence: unavailableArtifact,
    },
  )
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.retrySelector, false)
  assert.equal(unavailable.writeCanonical, false)
  assert.equal(unavailable.matureLabelRows, 520)
  assert.equal(unavailable.rejectedLabelRows, 20)
  assert(unavailable.blockers.includes('immutable_route_recovery_packet_missing'))
  assert(unavailable.blockers.includes('challenger_route_score_coverage_incomplete:0/540'))
  assert(unavailable.blockers.includes('route_score_parity_receipt_missing'))
  assert(unavailable.blockers.includes('canonical_reference_carrier_missing'))
  assert(unavailable.blockers.includes('canonical_strategy_matrix_carrier_missing'))
  assert.equal(referenceLineageRecoveryRetryAllowed('reference_lineage_incomplete', unavailable), false)
  assert.equal(missingCarrierDb.writes, 0, 'preflight must never write canonical or audit rows')

  const readyDb = fakeDb({
    reference_rows: 540,
    matrix_rows: 14_040,
    matrix_run_status: 'ready',
  })
  const ready = await auditHistoricalSelectionEvidenceRecoveryPreflight(
    readyDb as unknown as D1Database,
    {
      signalDate: '2026-08-06',
      producerRunId: 'screener-2026-08-06-canonical',
      asOfDate: '2026-08-24',
      artifactEvidence: {
        ...unavailableArtifact,
        route_recovery_packet_schema: 'strategy-route-recovery-packet-v1',
        route_recovery_packet_checksum: `sha256:${'b'.repeat(64)}`,
        route_recovery_parity_checksum: `sha256:${'c'.repeat(64)}`,
        route_recovery_candidate_count: 540,
        route_recovery_score_count: 540,
        route_recovery_artifact_id: "artifact:strategy_route_recovery:test",
        route_recovery_r2_key: "evidence/route-recovery.json",
        route_recovery_artifact_checksum: `sha256:${"d".repeat(64)}`,
        route_recovery_packet_ready: true,
      },
    },
  )
  assert.equal(ready.status, 'retryable')
  assert.equal(ready.retrySelector, true)
  assert.deepEqual(ready.blockers, [])
  assert.equal(referenceLineageRecoveryRetryAllowed('reference_lineage_incomplete', ready), true)
  assert.equal(referenceLineageRecoveryRetryAllowed('decision_grid_incomplete', ready), false)
  assert.equal(readyDb.writes, 0)

  const routeSource = readFileSync(new URL('../routes/adminWriteRoutes.ts', import.meta.url), 'utf8')
  assert.match(routeSource, /\/api\/admin\/strategy\/evidence-recovery\/preflight/)
  assert.match(routeSource, /loadCanonicalScreenerRunIds/)
  assert.match(routeSource, /loadHistoricalScreenerArtifactEvidence/)
  assert.match(routeSource, /auditHistoricalSelectionEvidenceRecoveryPreflight/)
  assert.match(routeSource, /mode: 'read_only_preflight'/)
}

void main()
