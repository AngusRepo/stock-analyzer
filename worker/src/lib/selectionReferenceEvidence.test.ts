import assert from 'node:assert/strict'
import {
  buildSelectionEvidenceV4,
  reconcileSelectionDecisionEvidenceV4,
} from './selectionReferenceEvidence'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

const spec = DEFAULT_STRATEGY_SPECS.find((row) => row.status === 'active')!
const built = buildSelectionEvidenceV4({
  signalDate: '2026-07-17',
  producerRunId: 'screener-2026-07-17-v4',
  strategyRegistryChecksum: 'registry-checksum',
  specs: [spec],
  candidates: [
    {
      symbol: '2330',
      score: 71,
      score_components: {
        version: 'score_v2',
        semanticVersion: 'score-v2-active8-components-v3',
        finalScore: 71,
        components: { mlEdge: 18, fundamentalQuality: 17, chipFlow: 19, technicalStructure: 17 },
      },
      strategy_labeler_version: 'strategy-labeler-v1',
      strategy_router_decision: 'ml_slate',
      strategy_hit_vector: { [spec.id]: 1 },
      strategy_evaluable_vector: { [spec.id]: 1 },
    },
    {
      symbol: '2317',
      score: 58,
      strategy_labeler_version: 'strategy-labeler-v1',
      strategy_router_decision: 'observe_only',
      strategy_evaluable_vector: { [spec.id]: 0 },
      strategy_unavailable_reason_vector: { [spec.id]: 'missing_required_signals:technicalIndicators.squeezeRelease' },
    },
  ],
})

assert.equal(built.references.length, 2)
assert.equal(built.matrix.length, 2)
assert.equal(built.references[0].feature_available, 1)
assert.match(built.references[0].score_components ?? '', /"version":"score_v2"/)
assert.equal(built.references[1].feature_available, 0)
assert.equal(built.references[1].feature_rejection_reason, 'score_v2_components_missing_or_invalid')
assert.equal(built.matrix[0].evaluable, 1)
assert.equal(built.matrix[1].evaluable, 0)
assert.match(built.matrix[1].unavailable_reason ?? '', /missing_required_signals/)
const missingEvaluability = buildSelectionEvidenceV4({
  signalDate: '2026-07-17',
  producerRunId: 'screener-2026-07-17-missing-evaluable',
  strategyRegistryChecksum: 'registry-checksum',
  specs: [spec],
  candidates: [{ symbol: '2454', strategy_labeler_version: 'strategy-labeler-v1', strategy_hit_vector: { [spec.id]: 1 } }],
})
assert.equal(missingEvaluability.matrix[0].evaluable, 0)
assert.equal(missingEvaluability.matrix[0].unavailable_reason, 'strategy_evaluability_missing')

const updates: Array<{ sql: string; binds: unknown[] }> = []
const fakeDb = {
  prepare(sql: string) {
    return {
      bind(...binds: unknown[]) {
        if (sql.includes('SELECT r.symbol, r.producer_run_id')) {
          return {
            async all() {
              return {
                results: [
                  {
                    symbol: '2330', producer_run_id: 'run', ml_score: 0.72,
                    ml_vote_summary: '{"models":8}',
                    alpha_allocation: '{"expected_return_owner":"allocator_ev_fusion","selected":true,"l4_alpha_ev":{"status":"loaded"}}',
                    signal: 'BUY', score_components: null,
                  },
                  {
                    symbol: '2317', producer_run_id: 'run', ml_score: 0.64,
                    ml_vote_summary: '{"models":8}',
                    alpha_allocation: '{"expected_return_owner":"risk_abstention","selected":false,"l4_alpha_ev":{"status":"loaded"}}',
                    signal: 'HOLD', score_components: null,
                  },
                ],
              }
            },
          }
        }
        const statement = { sql, binds }
        updates.push(statement)
        return statement
      },
    }
  },
  async batch(statements: unknown[]) {
    return statements.map(() => ({ success: true }))
  },
} as any

async function runBehaviorTest(): Promise<void> {
  const reconciled = await reconcileSelectionDecisionEvidenceV4(fakeDb, '2026-07-17')
  assert.deepEqual(reconciled, {
    referenceRows: 2,
    mlEvaluatedRows: 2,
    evOwnerRows: 1,
    allocationSelectedRows: 1,
    finalSignalRows: 2,
  })
  assert.deepEqual(updates[0].binds.slice(0, 5), [1, 1, 1, 1, 'BUY'])
  assert.deepEqual(updates[1].binds.slice(0, 5), [1, 1, 0, 0, 'HOLD'])

  console.log('selectionReferenceEvidence tests passed')

}

void runBehaviorTest().catch((error) => {
  throw error
})
