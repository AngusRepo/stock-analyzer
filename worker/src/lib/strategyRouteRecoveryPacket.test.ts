import assert from 'node:assert/strict'

import {
  applyStrategyRouteRecoveryScores,
  buildStrategyRouteRecoveryPacket,
  verifyStrategyRouteRecoveryPacket,
} from './strategyRouteRecoveryPacket'
import type { SelectionReferenceRowV1 } from './selectionReferenceEvidence'

const checksum = `sha256:${'a'.repeat(64)}`

function reference(symbol: string, score: number): SelectionReferenceRowV1 {
  return {
    signal_date: '2026-08-27',
    symbol,
    producer_run_id: 'screener-2026-08-27-test',
    name: symbol,
    market_segment: 'listed',
    sector: 'semiconductor',
    strategy_selected: 1,
    selection_stage: 'l15_router_selected',
    rejection_reason: null,
    score_v2: 80,
    score_components: JSON.stringify({ version: 'score_v2', finalScore: 80 }),
    feature_available: 1,
    feature_rejection_reason: null,
    strategy_labeler_version: 'strategy-labeler-v1',
    strategy_affinity_version: 'strategy-raw-quality-affinity-v1',
    strategy_router_version: 'strategy-evidence-aware-router-v4',
    strategy_router_score: score - 0.01,
    strategy_challenger_affinity_version: 'strategy-threshold-margin-affinity-v2',
    strategy_challenger_route_version: 'strategy-semantic-continuous-affinity-v5',
    strategy_challenger_route_score: score,
    strategy_registry_checksum: checksum,
  }
}

async function main() {
  const packet = await buildStrategyRouteRecoveryPacket([
    reference('2330', 0.8),
    reference('2317', 0.7),
  ])
  assert.equal(packet.candidate_count, 2)
  assert.equal(packet.route_score_count, 2)
  assert.deepEqual(packet.route_scores.map((row) => row.symbol), ['2317', '2330'])
  assert.equal(await verifyStrategyRouteRecoveryPacket(packet), true)

  const missingCarrier = [reference('2330', 0.8), reference('2317', 0.7)].map((row) => ({
    ...row,
    strategy_router_version: null,
    strategy_router_score: null,
    strategy_challenger_affinity_version: null,
    strategy_challenger_route_version: null,
    strategy_challenger_route_score: null,
  }))
  const restored = applyStrategyRouteRecoveryScores(
    missingCarrier, packet.route_scores, '2026-08-27', 'screener-2026-08-27-test',
  )
  assert.deepEqual(restored.map((row) => row.strategy_challenger_route_score), [0.8, 0.7])
  assert.equal(restored[0].strategy_router_version, 'strategy-evidence-aware-router-v4')
  assert.throws(
    () => applyStrategyRouteRecoveryScores(
      [{ ...reference('2330', 0.8), strategy_challenger_route_score: 0.1 }, reference('2317', 0.7)],
      packet.route_scores, '2026-08-27', 'screener-2026-08-27-test',
    ),
    /route_recovery_carrier_conflict/,
  )
  assert.throws(
    () => applyStrategyRouteRecoveryScores(
      [reference('2330', 0.8)], packet.route_scores, '2026-08-27', 'screener-2026-08-27-test',
    ),
    /route_recovery_coverage_mismatch/,
  )

  const tampered = structuredClone(packet)
  tampered.route_scores[0].challenger_route_score += 0.1
  assert.equal(await verifyStrategyRouteRecoveryPacket(tampered), false)

  await assert.rejects(
    buildStrategyRouteRecoveryPacket([
      { ...reference('2330', 0.8), strategy_challenger_route_score: null },
    ]),
    /strategy_route_recovery_incomplete/,
  )

  const duplicated = structuredClone(packet)
  duplicated.route_scores[1] = structuredClone(duplicated.route_scores[0])
  assert.equal(await verifyStrategyRouteRecoveryPacket(duplicated), false)

  const boundedPacket = await buildStrategyRouteRecoveryPacket(
    Array.from({ length: 600 }, (_, index) => reference(String(1000 + index), 0.5 + index / 10_000)),
  )
  assert.ok(
    new TextEncoder().encode(JSON.stringify(boundedPacket)).byteLength < 2_000_000,
    '600-row route recovery packet must stay below the internal artifact transport bound',
  )

  console.log('strategy route recovery packet tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
