import assert from 'node:assert/strict'
import { test } from 'node:test'
import { R33_MONTHLY_PROMOTION_DESIGN_DISABLED, isDesignDisabledSummary } from './designDisabledSteps'
import { schedulerSkipAttentionReason } from './schedulerStatus'
import { finalizeStrategyLearningEvidenceV5 } from './strategyLearning'

// Wei 2026-11-18: artifact-auto-promotion and the strategy policy update are disabled by design.
// Only their presentation changed; these tests pin that the policy path still writes nothing.

const promotionSkip = `${R33_MONTHLY_PROMOTION_DESIGN_DISABLED}; artifact-auto-promotion does not run in the post-close chain`
  + ' (no serving pointer write); run_date=2026-11-17 run_scope=historical_replay'

test('a design-disabled skip is not an attention skip; a live-canonical replay skip still is', () => {
  assert.equal(isDesignDisabledSummary(promotionSkip), true)
  assert.equal(isDesignDisabledSummary(`policy=${R33_MONTHLY_PROMOTION_DESIGN_DISABLED}`), false, 'a mention is not the receipt')
  assert.equal(schedulerSkipAttentionReason({ task: 'artifact-auto-promotion', status: 'skipped', summary: promotionSkip } as any), null)
  assert.match(String(schedulerSkipAttentionReason({ task: 'adapt', status: 'skipped',
    summary: 'skipped non-production-authoritative callback run_date=2026-11-17; adapt is live-canonical only' } as any)),
  /live-canonical task did not run/)
})

const cachedBeforePolicy = {
  decision_evidence: { finalSignalRows: 0, referenceRows: 0, evOwnerRows: 0 },
  historical_evidence: { successfulDates: 0, attemptedDates: 0, blockedDates: 0, rebuiltMatrixRows: 0 },
  selection_labels: { persisted_rows: 0, pending_rows: 0, unavailable_rows: 0 },
  reward_ledger: { source_rows: 0, persisted_rows: 0 },
  route_backfill_eligibility: [],
  marginal_edge: { status: 'insufficient', eligibleStrategies: 0, sampleDates: 0 },
  route_calibration: { status: 'skipped' },
}

function finalize(persistPolicy: boolean | undefined) {
  const queries: string[] = []
  const stages: string[] = []
  // Any D1 statement (read or write) is recorded and fails: the policy stages are the only ones not cached.
  const db = { prepare: (sql: string) => { queries.push(sql); throw new Error(`d1_touched:${sql.slice(0, 40)}`) } } as any
  const run = finalizeStrategyLearningEvidenceV5(db, '2026-11-17', {
    allowPromotion: false,
    persistPolicy,
    cachedStageResults: { ...cachedBeforePolicy },
    onStageTransition: async (stage: string, status: string) => { stages.push(`${stage}:${status}`) },
  })
  return { run, queries, stages }
}

test('persistPolicy=false (every post-close run since 10/07) runs no policy stage and touches no D1', async () => {
  const { run, queries, stages } = finalize(false)
  const result = await run
  assert.equal(result.policy, null)
  assert.equal(result.productionPolicy, null)
  assert.deepEqual(queries, [])
  assert.ok(!stages.some((stage) => /^(adaptive_policy|production_policy):/.test(stage)), stages.join(','))
})

test('the harness detects a policy write: persistPolicy=true reaches adaptive_policy and D1', async () => {
  const { run, queries, stages } = finalize(true)
  await assert.rejects(run, /d1_touched/)
  assert.ok(queries.length > 0)
  assert.ok(stages.includes('adaptive_policy:running'), stages.join(','))
})
