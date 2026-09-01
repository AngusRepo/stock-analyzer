import { logSchedulerResult } from './schedulerRunLogger'
import {
  closeStrategyLearningPostVerifyStage,
  hasStrategyLearningPostVerifyAuthority,
  heartbeatStrategyLearningLease,
  reclaimStrategyLearningFinalizedLease,
  releaseStrategyLearningFinalizedLease,
  type StrategyLearningLeaseIdentity,
  type StrategyLearningRunRow,
} from './strategyLearningRunState'

export type StrategyLearningFinalizedTelemetryInput = {
  runDate: string
  canonicalRunId: string
  summary?: string
  durationMs?: number
  attemptId?: string
  runScope?: 'live_canonical' | 'historical_replay' | 'derived'
}

async function reconcileStrategyLearningFinalizedTelemetry(
  db: D1Database,
  kv: KVNamespace,
  input: StrategyLearningFinalizedTelemetryInput,
): Promise<void> {
  const durableSummary = input.summary?.trim()
    || `durable strategy-learning finalize confirmed date=${input.runDate} run_id=${input.canonicalRunId}`
  const common = {
    status: 'success' as const,
    duration_ms: Math.max(0, Number(input.durationMs ?? 0)),
    run_id: input.canonicalRunId,
    attempt_id: input.attemptId,
    run_date: input.runDate,
    run_scope: input.runScope,
    strict: true,
  }
  await logSchedulerResult(kv, 'strategy-learning', {
    ...common,
    summary: durableSummary,
  })
  if (input.runScope === 'historical_replay') return

  await logSchedulerResult(kv, 'post-verify-chain', {
    ...common,
    summary: `strategy-learning durable finalize closed; ${durableSummary}`,
  })
  const { closeEveningChainRootIfComplete } = await import('./eveningChainRootClosure')
  const closure = await closeEveningChainRootIfComplete(db, {
    businessDate: input.runDate,
    canonicalRunId: input.canonicalRunId,
  })
  if (closure.status === 'closed_success') {
    await logSchedulerResult(kv, 'evening-chain', {
      ...common,
      summary: closure.summary,
    })
  }
}

export async function reconcileAndReleaseStrategyLearningFinalizedTelemetry(
  db: D1Database,
  kv: KVNamespace,
  identity: StrategyLearningLeaseIdentity,
  input: StrategyLearningFinalizedTelemetryInput,
): Promise<boolean> {
  if (!(await hasStrategyLearningPostVerifyAuthority(db, identity))) return false
  const renewed = await heartbeatStrategyLearningLease(db, identity)
    || await reclaimStrategyLearningFinalizedLease(db, identity)
  if (!renewed) return false

  if (
    input.runScope !== 'historical_replay'
    && !(await closeStrategyLearningPostVerifyStage(db, identity))
  ) return false

  await reconcileStrategyLearningFinalizedTelemetry(db, kv, input)

  const released = await releaseStrategyLearningFinalizedLease(db, identity)
  if (!released) {
    throw new Error(
      `strategy_learning_finalized_lease_release_conflict:${identity.businessDate}:${identity.canonicalRunId}:${identity.leaseOwner}`,
    )
  }
  return true
}

export type StrategyLearningFinalizedRetryOutcome =
  | 'not_finalized'
  | 'reconciled'
  | 'no_live_telemetry_lease'
  | 'authority_changed'

export async function reconcileStrategyLearningFinalizedRetryFastPath(
  db: D1Database,
  kv: KVNamespace,
  state: StrategyLearningRunRow | null,
  input: { attemptId: string },
): Promise<StrategyLearningFinalizedRetryOutcome> {
  if (!state || state.status !== 'success') return 'not_finalized'
  if (!state.completed_at) {
    throw new Error(
      `strategy_learning_finalized_provenance_missing:${state.business_date}:${state.canonical_run_id}`,
    )
  }
  const policyClosureValid = state.policy_closure_status === 'materialized'
    || (state.production_authority_intent === 0 && state.policy_closure_status === 'evidence_only')
  if (!policyClosureValid) {
    throw new Error(
      `strategy_learning_policy_closure_provenance_missing:${state.business_date}:${state.canonical_run_id}:${state.policy_closure_status}`,
    )
  }
  if (!state.lease_owner || !state.lease_expires_at) return 'no_live_telemetry_lease'

  const reconciled = await reconcileAndReleaseStrategyLearningFinalizedTelemetry(
    db,
    kv,
    {
      businessDate: state.business_date,
      canonicalRunId: state.canonical_run_id,
      leaseOwner: state.lease_owner,
    },
    {
      runDate: state.business_date,
      canonicalRunId: state.canonical_run_id,
      attemptId: input.attemptId,
      runScope: state.production_authority_intent === 1 ? 'live_canonical' : 'historical_replay',
    },
  )
  return reconciled ? 'reconciled' : 'authority_changed'
}
