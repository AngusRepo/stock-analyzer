import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { loadHistoricalScreenerArtifactEvidence } from './historicalScreenerArtifactEvidence'
import { buildStrategyRouteRecoveryPacket } from './strategyRouteRecoveryPacket'
import type { SelectionReferenceRowV1 } from './selectionReferenceEvidence'

const signalDate = '2026-08-27'
const producerRunId = 'screener-2026-08-27-route-recovery'

function sha256(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

function reference(): SelectionReferenceRowV1 {
  return {
    signal_date: signalDate,
    symbol: '2330',
    producer_run_id: producerRunId,
    name: 'TSMC',
    market_segment: 'listed',
    sector: 'semiconductor',
    strategy_selected: 1,
    selection_stage: 'l15_router_selected',
    rejection_reason: null,
    score_v2: 88,
    score_components: JSON.stringify({ version: 'score_v2', finalScore: 88 }),
    feature_available: 1,
    feature_rejection_reason: null,
    strategy_labeler_version: 'strategy-labeler-v1',
    strategy_affinity_version: 'strategy-raw-quality-affinity-v1',
    strategy_router_version: 'strategy-evidence-aware-router-v4',
    strategy_router_score: 0.71,
    strategy_challenger_affinity_version: 'strategy-threshold-margin-affinity-v2',
    strategy_challenger_route_version: 'strategy-semantic-continuous-affinity-v5',
    strategy_challenger_route_score: 0.76,
    strategy_registry_checksum: `sha256:${'a'.repeat(64)}`,
  }
}

async function main() {
  const routePacket = await buildStrategyRouteRecoveryPacket([reference()])
  const routeBody = JSON.stringify({
    schema_version: routePacket.schema_version,
    domain: 'strategy_route_recovery',
    business_date: signalDate,
    payload: routePacket,
  })
  const routeChecksum = sha256(routeBody)
  const routeKey = 'evidence/route-recovery.json'
  const mainManifest = JSON.stringify({
    schema_version: 'screener-funnel-evidence-index-v1',
    business_date: signalDate,
    payload: {
      storage_mode: 'chunked_r2_manifest_v1',
      logical_schema_version: 'screener-funnel-evidence-v3',
      payload_header: {
        metadata: {
          strategyCandidatePool: {
            strategy_labeler_version: 'strategy-labeler-v1',
            strategy_matrix_candidate_count: 1,
            strategy_matrix_strategy_count: 26,
            strategy_matrix_expected_cell_count: 26,
            strategy_matrix_coverage_ratio: 1,
            route_recovery_packet: {
              ...routePacket,
              route_scores: undefined,
              artifact_id: 'artifact:strategy-route-recovery:test',
              r2_key: routeKey,
              artifact_checksum: routeChecksum,
            },
          },
        },
      },
    },
  })
  const mainChecksum = sha256(mainManifest)
  const objects = new Map([
    ['evidence/main.json', mainManifest],
    [routeKey, routeBody],
  ])
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            artifact_id: 'artifact:screener-funnel:test',
            r2_key: 'evidence/main.json',
            checksum: mainChecksum,
            canonical_at: '2026-08-27T14:00:00Z',
          }),
        }),
      }),
    },
    ARTIFACTS: {
      get: async (key: string) => {
        const body = objects.get(key)
        return body ? { text: async () => body } : null
      },
    },
  } as any

  const verified = await loadHistoricalScreenerArtifactEvidence(env, signalDate, producerRunId)
  assert.equal(verified?.route_recovery_packet_ready, true)
  assert.equal(verified?.route_recovery_r2_key, routeKey)
  assert.equal(verified?.route_recovery_scores.length, 1)
  assert.equal(verified?.route_recovery_scores[0]?.challenger_route_score, 0.76)

  objects.set(routeKey, routeBody.replace('0.76', '0.77'))
  const tampered = await loadHistoricalScreenerArtifactEvidence(env, signalDate, producerRunId)
  assert.equal(tampered?.route_recovery_packet_ready, false)
  assert.deepEqual(tampered?.route_recovery_scores, [])

  console.log('historical screener route recovery tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
