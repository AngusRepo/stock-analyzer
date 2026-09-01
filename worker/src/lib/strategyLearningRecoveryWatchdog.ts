import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { twToday } from './dateUtils'
import { logSchedulerResult } from './schedulerRunLogger'

const RECOVERY_LOOKBACK_DAYS = 4
const DISPATCH_FENCE_TTL_SECONDS = 15 * 60

export type StrategyLearningRecoveryRow = {
  business_date: string
  canonical_run_id: string
  status: string
  cursor_symbol: string | null
  expected_candidates: number | string | null
  processed_candidates: number | string | null
  expected_decision_rows: number | string | null
  persisted_decision_rows: number | string | null
  lease_owner: string | null
  lease_expires_at: string | null
  attempt_count: number | string | null
  last_error: string | null
  updated_at: string | null
  production_authority_intent: number | string | null
  policy_closure_status: string | null
}

export type StrategyLearningRecoveryDecision = {
  resume: boolean
  reason: string
}

function d1TimestampMs(value: string | null): number | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  const parsed = Date.parse(normalized.includes('T') ? normalized : normalized.replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) ? parsed : null
}

export function strategyLearningRecoveryDecision(
  row: StrategyLearningRecoveryRow | null,
  nowMs = Date.now(),
): StrategyLearningRecoveryDecision {
  if (!row) return { resume: false, reason: 'recoverable_run_missing' }
  if (row.status === 'success') return { resume: false, reason: 'run_success' }
  if (row.status === 'error') return { resume: false, reason: `run_error:${row.last_error ?? 'unknown'}` }

  const expectedCandidates = Number(row.expected_candidates ?? 0)
  const processedCandidates = Number(row.processed_candidates ?? 0)
  const expectedDecisionRows = Number(row.expected_decision_rows ?? 0)
  const persistedDecisionRows = Number(row.persisted_decision_rows ?? 0)
  const progressValid = expectedCandidates > 0
    && processedCandidates >= 0
    && processedCandidates <= expectedCandidates
    && expectedDecisionRows > 0
    && persistedDecisionRows >= 0
    && persistedDecisionRows <= expectedDecisionRows
  if (!progressValid) return { resume: false, reason: 'recoverable_progress_invalid' }

  if (row.status === 'queued') {
    return !row.lease_owner && !row.lease_expires_at
      ? { resume: true, reason: 'queued_without_lease' }
      : { resume: false, reason: 'queued_with_lease' }
  }
  if (row.status !== 'running') return { resume: false, reason: `unsupported_status:${row.status}` }

  const leaseExpiresMs = d1TimestampMs(row.lease_expires_at)
  if (leaseExpiresMs != null && leaseExpiresMs > nowMs) {
    return { resume: false, reason: 'active_lease' }
  }
  return { resume: true, reason: 'lease_expired' }
}

async function loadRecoveryRun(
  db: D1Database,
  requestedDate?: string,
): Promise<StrategyLearningRecoveryRow | null> {
  if (requestedDate) {
    return db.prepare(`
      SELECT business_date, canonical_run_id, status, cursor_symbol,
             expected_candidates, processed_candidates,
             expected_decision_rows, persisted_decision_rows,
             lease_owner, lease_expires_at, attempt_count, last_error, updated_at,
             production_authority_intent, policy_closure_status
        FROM strategy_learning_runs
       WHERE business_date=?
       LIMIT 1
    `).bind(requestedDate).first<StrategyLearningRecoveryRow>()
  }
  const cutoffDate = twToday()
  return db.prepare(`
    SELECT business_date, canonical_run_id, status, cursor_symbol,
           expected_candidates, processed_candidates,
           expected_decision_rows, persisted_decision_rows,
           lease_owner, lease_expires_at, attempt_count, last_error, updated_at,
           production_authority_intent, policy_closure_status
      FROM strategy_learning_runs
     WHERE business_date BETWEEN date(?, ?) AND ?
       AND (
         (status='queued' AND lease_owner IS NULL AND lease_expires_at IS NULL)
         OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP))
         OR (status='success' AND business_date=?)
       )
     ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END,
              business_date DESC
     LIMIT 1
  `).bind(cutoffDate, `-${RECOVERY_LOOKBACK_DAYS} days`, cutoffDate, cutoffDate).first<StrategyLearningRecoveryRow>()
}

async function loadPostVerifyAuthority(
  db: D1Database,
  businessDate: string,
): Promise<{ status: string; canonical_run_id: string } | null> {
  return db.prepare(`
    SELECT status, canonical_run_id
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='post_verify_chain'
     LIMIT 1
  `).bind(businessDate).first<{ status: string; canonical_run_id: string }>()
}

async function logWatchdog(
  env: Bindings,
  row: StrategyLearningRecoveryRow | null,
  status: 'success' | 'running' | 'triggered' | 'error',
  summary: string,
): Promise<void> {
  await logSchedulerResult(env.KV, 'strategy-learning-watchdog', {
    status,
    summary,
    duration_ms: 0,
    run_id: row?.canonical_run_id,
    run_date: row?.business_date ?? twToday(),
    run_scope: Number(row?.production_authority_intent ?? 0) === 1 ? 'live_canonical' : 'historical_replay',
    error: status === 'error' ? summary : undefined,
    supersedePrevious: true,
  }, env)
}

export async function runStrategyLearningRecoveryWatchdog(
  env: Bindings,
  requestedDate?: string,
): Promise<string> {
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    throw new Error(`invalid_strategy_learning_watchdog_date:${requestedDate}`)
  }
  const opsDb = databaseForDataDomain(env, 'ops')
  const row = await loadRecoveryRun(opsDb, requestedDate)
  const decision = strategyLearningRecoveryDecision(row)
  if (!row) {
    const summary = `SKIPPED strategy-learning recovery ${decision.reason}`
    await logWatchdog(env, null, 'success', summary)
    return summary
  }
  if (!decision.resume) {
    if (decision.reason.startsWith('run_error:') || decision.reason === 'recoverable_progress_invalid') {
      const summary = `strategy-learning recovery blocked date=${row.business_date} reason=${decision.reason}`
      await logWatchdog(env, row, 'error', summary)
      throw new Error(summary)
    }
    if (decision.reason === 'run_success') {
      const { closeEveningChainRootIfComplete } = await import('./eveningChainRootClosure')
      const closure = await closeEveningChainRootIfComplete(opsDb, {
        businessDate: row.business_date,
        canonicalRunId: row.canonical_run_id,
      })
      const summary = `success strategy-learning recovery date=${row.business_date} reason=run_success root=${closure.status}`
      await logWatchdog(env, row, 'success', summary)
      if (closure.status === 'closed_success') {
        await logSchedulerResult(env.KV, 'evening-chain', {
          status: 'success', summary: closure.summary, duration_ms: 0,
          run_id: row.canonical_run_id, run_date: row.business_date,
          run_scope: Number(row.production_authority_intent ?? 0) === 1 ? 'live_canonical' : 'historical_replay',
          supersedePrevious: true,
        }, env)
      }
      return summary
    }
    const summary = `running strategy-learning recovery date=${row.business_date} reason=${decision.reason}`
    await logWatchdog(env, row, 'running', summary)
    return summary
  }

  const authority = await loadPostVerifyAuthority(opsDb, row.business_date)
  if (!['running', 'waiting', 'success'].includes(String(authority?.status ?? ''))
      || authority?.canonical_run_id !== row.canonical_run_id) {
    const summary = [
      `strategy-learning recovery authority denied date=${row.business_date}`,
      `post_verify_status=${authority?.status ?? 'missing'}`,
      `post_verify_run=${authority?.canonical_run_id ?? 'missing'}`,
      `learning_run=${row.canonical_run_id}`,
    ].join(' ')
    await logWatchdog(env, row, 'error', summary)
    throw new Error(summary)
  }

  const dispatchKey = `strategy-learning:watchdog-dispatch:${row.business_date}:${row.canonical_run_id}`
  if (await env.KV.get(dispatchKey)) {
    const summary = `running strategy-learning recovery date=${row.business_date} reason=dispatch_fenced`
    await logWatchdog(env, row, 'running', summary)
    return summary
  }

  await env.UPDATE_QUEUE.send({
    type: 'strategy_learning_materialize',
    cursor: 0,
    cursorKey: String(row.cursor_symbol ?? ''),
    triggerTime: row.business_date,
    runId: row.canonical_run_id,
    productionAuthorityIntent: Number(row.production_authority_intent ?? 0) === 1,
    leaseRetryAttempt: 0,
  })
  await env.KV.put(dispatchKey, JSON.stringify({
    business_date: row.business_date,
    canonical_run_id: row.canonical_run_id,
    reason: decision.reason,
    dispatched_at: new Date().toISOString(),
  }), { expirationTtl: DISPATCH_FENCE_TTL_SECONDS })
  const summary = [
    `triggered strategy-learning recovery date=${row.business_date}`,
    `reason=${decision.reason}`,
    `attempts=${Number(row.attempt_count ?? 0)}`,
    `cursor=${row.cursor_symbol ?? ''}`,
    `production_authority_intent=${Number(row.production_authority_intent ?? 0) === 1}`,
    'authority=revalidate_at_finalizer',
  ].join(' ')
  await logWatchdog(env, row, 'triggered', summary)
  return summary
}
