import assert from 'node:assert/strict'
import {
  buildSelectionEvidenceV4,
  persistSelectionEvidenceV4,
  reconcileSelectionDecisionEvidenceV4,
} from './selectionReferenceEvidence'
import { DEFAULT_STRATEGY_SPECS, STRATEGY_FORMAL_LABELER_VERSION, STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION } from './strategySpec'

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
      strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION,
      strategy_router_decision: 'ml_slate',
      strategy_hit_vector: { [spec.id]: 1 },
      strategy_evaluable_vector: { [spec.id]: 1 },
    },
    {
      symbol: '2317',
      score: 58,
      strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION,
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
assert.equal(built.matrix[0].evaluability_status, 'EVALUABLE')
assert.equal(built.matrix[1].evaluable, 0)
assert.equal(built.matrix[1].evaluability_status, 'MISSING_SOURCE')
assert.match(built.matrix[1].unavailable_reason ?? '', /missing_required_signals/)
const missingEvaluability = buildSelectionEvidenceV4({
  signalDate: '2026-07-17',
  producerRunId: 'screener-2026-07-17-missing-evaluable',
  strategyRegistryChecksum: 'registry-checksum',
  specs: [spec],
  candidates: [{ symbol: '2454', strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION, strategy_hit_vector: { [spec.id]: 1 } }],
})
assert.equal(missingEvaluability.matrix[0].evaluable, 0)
assert.equal(missingEvaluability.matrix[0].unavailable_reason, 'strategy_evaluability_missing')
assert.equal(missingEvaluability.matrix[0].evaluability_status, 'MISSING_SOURCE')

const s12Spec = {
  ...spec,
  id: 'stock_tech_s12_multitimeframe_smc_reclaim_v2',
  status: 'candidate' as const,
  variantId: 's12_formal_intraday_snapshot',
  candidatePolicy: {
    ...spec.candidatePolicy,
    evidenceRequirements: ['s12_structure_snapshots', 'intraday_15m', 'intraday_60m'],
  },
}
const mixedOwnerMatrix = buildSelectionEvidenceV4({
  signalDate: '2026-07-17',
  producerRunId: 'screener-2026-07-17-owner-phase',
  strategyRegistryChecksum: 'registry-checksum',
  specs: [spec, s12Spec],
  candidates: [{
    symbol: '2330',
    strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION,
    strategy_evaluable_vector: { [spec.id]: 1 },
  }],
}).matrix
assert.equal(mixedOwnerMatrix.length, 2)
assert.equal(mixedOwnerMatrix.filter((row) => row.evaluability_status === 'EVALUABLE').length, 1)
assert.equal(mixedOwnerMatrix.filter((row) => row.evaluability_status === 'NOT_APPLICABLE_OWNER').length, 1)
assert.equal(mixedOwnerMatrix.filter((row) => row.evaluability_status === 'MISSING_SOURCE').length, 0)
assert.equal(mixedOwnerMatrix.find((row) => row.strategy_id === s12Spec.id)?.unavailable_reason, 'selection_phase_owned_by_s12_execution_replay')

assert.throws(() => buildSelectionEvidenceV4({
  signalDate: '2026-07-17',
  producerRunId: 'legacy-labeler-run',
  strategyRegistryChecksum: 'registry-checksum',
  specs: [spec],
  candidates: [{ symbol: '2330', strategy_labeler_version: 'strategy-labeler-v1' }],
}), /strategy_labeler_version_nonformal/)

assert.throws(() => buildSelectionEvidenceV4({
  signalDate: '2026-07-17',
  producerRunId: 'mixed-labeler-run',
  strategyRegistryChecksum: 'registry-checksum',
  specs: [spec],
  candidates: [
    { symbol: '2330', strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION },
    { symbol: '2317', strategy_labeler_version: STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION },
  ],
}), /strategy_labeler_version_mixed_run/)

const noAccessDb = {
  prepare() { throw new Error('database must not be touched before contract validation') },
} as any

const persistInput = {
  signalDate: '2026-07-17', producerRunId: 'screener-2026-07-17-v4',
  references: built.references, matrix: built.matrix, strategyCount: built.strategyCount,
  strategyRegistryChecksum: 'registry-checksum',
  labelerVersion: STRATEGY_FORMAL_LABELER_VERSION,
  evidenceArtifactId: 'evidence-artifact',
}

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
  await assert.rejects(
    persistSelectionEvidenceV4(noAccessDb, {
      ...persistInput,
      matrix: persistInput.matrix.map((row, index) => index === 0
        ? { ...row, labeler_version: STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION }
        : row),
    }),
    /strategy_label_matrix_row_contract_mismatch/,
  )
  await assert.rejects(
    persistSelectionEvidenceV4(noAccessDb, { ...persistInput, labelerVersion: 'strategy-labeler-v1' }),
    /strategy_label_matrix_nonformal_labeler/,
  )
  assert.deepEqual(updates[0].binds.slice(0, 5), [1, 1, 1, 1, 'BUY'])
  assert.deepEqual(updates[1].binds.slice(0, 5), [1, 1, 0, 0, 'HOLD'])

  console.log('selectionReferenceEvidence tests passed')

}

void runBehaviorTest().catch((error) => {
  throw error
})
