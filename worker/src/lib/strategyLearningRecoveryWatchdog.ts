import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { twToday } from './dateUtils'
import { logSchedulerResult } from './schedulerRunLogger'

export const RECOVERY_LOOKBACK_DAYS = 4
const DISPATCH_FENCE_TTL_SECONDS = 15 * 60
// A deferred finalizer failure used to be resumed on every 15-minute fence expiry, so
// one deterministic or overload failure reran the learning-db finalizer all night
// (11/10–11/11). Its redispatches back off and stop at a cap; counted in KV because a
// claim rewrites the row.
const DEFERRED_FAILURE_PREFIX = 'strategy_learning_finalizer_stage_failed:'
const DEFERRED_FAILURE_MAX_DISPATCHES = 6
const DEFERRED_FAILURE_BACKOFF_BASE_MINUTES = 20
const DEFERRED_FAILURE_BACKOFF_CAP_MINUTES = 160
const DEFERRED_FAILURE_DISPATCH_TTL_SECONDS = 7 * 86_400
const SIMILARITY_ARTIFACT_INCOMPLETE = 'evening_chain_similarity_artifact_incomplete'
const SIMILARITY_ARTIFACT_OVERDUE_MS = 6 * 3_600_000

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
  completed_at: string | null
  policy_closure_completed_at: string | null
}

export type StrategyLearningRecoveryDecision = {
  resume: boolean
  reason: string
}

export type StrategyLearningRecoveryOptions = {
  // Operator redispatch from the admin trigger only; the scheduled watchdog never sets it.
  overrideBackoff?: boolean
}

export type StrategyLearningDeferredRetryGate =
  | { action: 'dispatch' }
  | { action: 'backoff'; nextDueMs: number }
  | { action: 'exhausted' }

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

export function isStrategyLearningDeferredFailure(row: StrategyLearningRecoveryRow): boolean {
  return row.status === 'queued' && String(row.last_error ?? '').startsWith(DEFERRED_FAILURE_PREFIX)
}

/** Minutes to wait after the last deferral before deferred-failure dispatch n (1-based). */
export function strategyLearningDeferredBackoffMinutes(dispatch: number): number {
  if (dispatch <= 1) return 0
  return Math.min(DEFERRED_FAILURE_BACKOFF_CAP_MINUTES, DEFERRED_FAILURE_BACKOFF_BASE_MINUTES * 2 ** (dispatch - 2))
}

export function strategyLearningDeferredRetryGate(
  row: StrategyLearningRecoveryRow,
  dispatches: number,
  nowMs = Date.now(),
): StrategyLearningDeferredRetryGate {
  if (dispatches >= DEFERRED_FAILURE_MAX_DISPATCHES) return { action: 'exhausted' }
  const backoffMs = strategyLearningDeferredBackoffMinutes(dispatches + 1) * 60_000
  const deferredMs = d1TimestampMs(row.updated_at)
  if (backoffMs > 0 && deferredMs != null && nowMs - deferredMs < backoffMs) {
    return { action: 'backoff', nextDueMs: deferredMs + backoffMs }
  }
  return { action: 'dispatch' }
}

export function hasStrategyLearningSuccessReceipt(row: StrategyLearningRecoveryRow): boolean {
  const policyClosed = row.policy_closure_status === 'materialized'
    || (Number(row.production_authority_intent ?? 0) === 0
      && row.policy_closure_status === 'evidence_only')
  return row.status === 'success'
    && Boolean(row.completed_at && row.policy_closure_completed_at)
    && Number(row.expected_candidates) > 0
    && Number(row.processed_candidates) === Number(row.expected_candidates)
    && Number(row.expected_decision_rows) > 0
    && Number(row.persisted_decision_rows) === Number(row.expected_decision_rows)
    && policyClosed
}

const RECOVERY_RUN_COLUMNS = `
  business_date, canonical_run_id, status, cursor_symbol,
  expected_candidates, processed_candidates,
  expected_decision_rows, persisted_decision_rows,
  lease_owner, lease_expires_at, attempt_count, last_error, updated_at,
  production_authority_intent, policy_closure_status,
  completed_at, policy_closure_completed_at`

export function strategyLearningRecoveryWindowStart(today = twToday()): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - RECOVERY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
}

/** Dates the watchdog's lookback reaches; a failure outside it has no automatic retry owner. */
export function isStrategyLearningRecoveryWindowDate(businessDate: string, today = twToday()): boolean {
  return businessDate >= strategyLearningRecoveryWindowStart(today) && businessDate <= today
}

async function loadRecoveryCandidates(
  db: D1Database,
  requestedDate?: string,
): Promise<StrategyLearningRecoveryRow[]> {
  if (requestedDate) {
    const row = await db.prepare(`
      SELECT ${RECOVERY_RUN_COLUMNS}
        FROM strategy_learning_runs
       WHERE business_date=?
       LIMIT 1
    `).bind(requestedDate).first<StrategyLearningRecoveryRow>()
    return row ? [row] : []
  }
  const cutoffDate = twToday()
  const { results } = await db.prepare(`
    SELECT ${RECOVERY_RUN_COLUMNS}
      FROM strategy_learning_runs
     WHERE business_date BETWEEN date(?, ?) AND ?
       AND (
         (status='queued' AND lease_owner IS NULL AND lease_expires_at IS NULL)
         OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP))
         OR status='success'
       )
     ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END,
              business_date DESC
     LIMIT ?
  `).bind(cutoffDate, `-${RECOVERY_LOOKBACK_DAYS} days`, cutoffDate, RECOVERY_LOOKBACK_DAYS + 1)
    .all<StrategyLearningRecoveryRow>()
  return results ?? []
}

async function loadActiveLeaseDate(db: D1Database): Promise<string | null> {
  const cutoffDate = twToday()
  const row = await db.prepare(`
    SELECT business_date
      FROM strategy_learning_runs
     WHERE business_date BETWEEN date(?, ?) AND ?
       AND status IN ('queued','running')
       AND lease_expires_at>CURRENT_TIMESTAMP
     ORDER BY business_date DESC
     LIMIT 1
  `).bind(cutoffDate, `-${RECOVERY_LOOKBACK_DAYS} days`, cutoffDate)
    .first<{ business_date: string }>()
  return row?.business_date ?? null
}

// Same row and acceptance as the finalizer's before_promotion similarity check
// (eveningChainEvidenceClosure.ts).
export async function hasEveningChainSimilarityArtifact(
  learningDb: D1Database,
  businessDate: string,
): Promise<boolean> {
  const similarity = await learningDb.prepare(`
    SELECT status, evidence_artifact_id
      FROM strategy_redundancy_artifacts_v1
     WHERE as_of_date=?
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(businessDate).first<{ status: string; evidence_artifact_id: string | null }>()
  return Boolean(similarity?.evidence_artifact_id)
    && ['pass', 'pending_maturity', 'fail'].includes(String(similarity?.status))
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
  status: 'success' | 'skipped' | 'running' | 'triggered' | 'error',
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

type CandidateOutcome =
  | { dispatch: true; deferredFailure: boolean; deferredDispatches: number; deferredKey: string }
  | { dispatch: false; status: 'running' | 'error'; token: string; detail: string }

async function blockTerminalRun(
  env: Bindings,
  opsDb: D1Database,
  row: StrategyLearningRecoveryRow,
  reason: string,
): Promise<never> {
  const { propagateStrategyLearningTerminalFailure } = await import('./strategyLearningRunState')
  await propagateStrategyLearningTerminalFailure(opsDb, {
    businessDate: row.business_date, canonicalRunId: row.canonical_run_id,
  }, env.KV)
  const summary = `strategy-learning recovery blocked date=${row.business_date} reason=${reason}`
  await logWatchdog(env, row, 'error', summary)
  throw new Error(summary)
}

async function evaluateRecoveryCandidate(
  env: Bindings,
  opsDb: D1Database,
  row: StrategyLearningRecoveryRow,
  options: StrategyLearningRecoveryOptions,
  first: boolean,
): Promise<CandidateOutcome> {
  const blocked = (status: 'running' | 'error', token: string, detail: string): CandidateOutcome => (
    { dispatch: false, status, token, detail }
  )
  const authority = await loadPostVerifyAuthority(opsDb, row.business_date)
  if (!['running', 'waiting', 'success'].includes(String(authority?.status ?? ''))
      || authority?.canonical_run_id !== row.canonical_run_id) {
    const detail = [
      `authority denied date=${row.business_date}`,
      `post_verify_status=${authority?.status ?? 'missing'}`,
      `post_verify_run=${authority?.canonical_run_id ?? 'missing'}`,
      `learning_run=${row.canonical_run_id}`,
    ].join(' ')
    // An older date's denial must not stop the walk; the newest keeps the hard failure.
    if (!first) return blocked('error', 'authority_denied', detail)
    const summary = `strategy-learning recovery ${detail}`
    await logWatchdog(env, row, 'error', summary)
    throw new Error(summary)
  }

  if (await env.KV.get(dispatchFenceKey(row))) {
    return blocked('running', 'dispatch_fenced', `date=${row.business_date} reason=dispatch_fenced`)
  }

  const deferredFailure = isStrategyLearningDeferredFailure(row)
  const deferredKey = `strategy-learning:watchdog-deferred-dispatches:${row.business_date}:${row.canonical_run_id}`
  const deferredDispatches = deferredFailure
    ? Number.parseInt((await env.KV.get(deferredKey)) ?? '0', 10) || 0
    : 0
  if (deferredFailure && !options.overrideBackoff) {
    const gate = strategyLearningDeferredRetryGate(row, deferredDispatches)
    if (gate.action === 'exhausted') {
      const lastError = String(row.last_error).replace(/status=/gi, 'status:').replace(/\s+/g, '_').slice(0, 300)
      return blocked('error', 'exhausted', [
        `exhausted date=${row.business_date}`,
        `run_id=${row.canonical_run_id}`,
        `attempts=${deferredDispatches}`,
        `attempt_count=${Number(row.attempt_count ?? 0)}`,
        `last_error=${lastError}`,
        'recovery_dispatch=not_queued manual_redispatch=strategy-learning-watchdog?override_backoff=1',
      ].join(' '))
    }
    if (gate.action === 'backoff') {
      return blocked('running', 'deferred_backoff', [
        `date=${row.business_date}`,
        'reason=deferred_backoff',
        `next_due=${new Date(gate.nextDueMs).toISOString()}`,
        `attempts=${deferredDispatches}`,
      ].join(' '))
    }
  }
  // Checked under the override too: redispatching without the artifact only repeats the
  // before_promotion failure.
  if (deferredFailure && String(row.last_error).includes(SIMILARITY_ARTIFACT_INCOMPLETE)
      && !(await hasEveningChainSimilarityArtifact(databaseForDataDomain(env, 'learning'), row.business_date))) {
    const deferredMs = d1TimestampMs(row.updated_at)
    const overdue = deferredMs != null && Date.now() - deferredMs >= SIMILARITY_ARTIFACT_OVERDUE_MS
    return overdue
      ? blocked('error', 'awaiting_similarity_artifact_overdue',
        `date=${row.business_date} reason=awaiting_similarity_artifact_overdue since=${new Date(deferredMs).toISOString()} attempts=${deferredDispatches}`)
      : blocked('running', 'awaiting_similarity_artifact',
        `date=${row.business_date} reason=awaiting_similarity_artifact attempts=${deferredDispatches}`)
  }
  return { dispatch: true, deferredFailure, deferredDispatches, deferredKey }
}

function dispatchFenceKey(row: StrategyLearningRecoveryRow): string {
  return `strategy-learning:watchdog-dispatch:${row.business_date}:${row.canonical_run_id}`
}

export async function runStrategyLearningRecoveryWatchdog(
  env: Bindings,
  requestedDate?: string,
  options: StrategyLearningRecoveryOptions = {},
): Promise<string> {
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    throw new Error(`invalid_strategy_learning_watchdog_date:${requestedDate}`)
  }
  const opsDb = databaseForDataDomain(env, 'ops')
  const candidates = await loadRecoveryCandidates(opsDb, requestedDate)
  const row = candidates[0] ?? null
  const decision = strategyLearningRecoveryDecision(row)
  if (!row) {
    const summary = `SKIPPED strategy-learning recovery ${decision.reason}`
    // Nothing was recovered: a no-op is not a success.
    await logWatchdog(env, null, 'skipped', summary)
    return summary
  }
  if (!decision.resume) {
    if (decision.reason.startsWith('run_error:') || decision.reason === 'recoverable_progress_invalid') {
      return blockTerminalRun(env, opsDb, row, decision.reason)
    }
    if (decision.reason === 'run_success') {
      if (!hasStrategyLearningSuccessReceipt(row)) {
        throw new Error(`strategy_learning_success_receipt_incomplete:${row.business_date}:${row.canonical_run_id}`)
      }
      await logSchedulerResult(env.KV, 'strategy-learning', {
        status: 'success', duration_ms: 0,
        summary: `durable strategy-learning finalize confirmed date=${row.business_date} run_id=${row.canonical_run_id} policy_closure=${row.policy_closure_status} candidates=${row.processed_candidates}/${row.expected_candidates} decision_rows=${row.persisted_decision_rows}/${row.expected_decision_rows}`,
        run_id: row.canonical_run_id, run_date: row.business_date,
        run_scope: Number(row.production_authority_intent ?? 0) === 1 ? 'live_canonical' : 'historical_replay',
        strict: true,
      }, env)
      const { closeStrategyLearningPostVerifyStage } = await import('./strategyLearningRunState')
      const stageClosed = await closeStrategyLearningPostVerifyStage(opsDb, {
        businessDate: row.business_date, canonicalRunId: row.canonical_run_id,
      })
      if (stageClosed) {
        await logSchedulerResult(env.KV, 'post-verify-chain', {
          status: 'success', duration_ms: 0,
          summary: `durable learning recovery complete policy_closure=${row.policy_closure_status}`,
          run_id: row.canonical_run_id, run_date: row.business_date,
          run_scope: Number(row.production_authority_intent ?? 0) === 1 ? 'live_canonical' : 'historical_replay',
          strict: true,
        }, env)
      }
      const { closeEveningChainRootAndLog } = await import('./eveningChainRootClosure')
      const closure = await closeEveningChainRootAndLog(env.KV, opsDb, {
        businessDate: row.business_date,
        canonicalRunId: row.canonical_run_id,
        runScope: Number(row.production_authority_intent ?? 0) === 1 ? 'live_canonical' : 'historical_replay',
        alertEnv: env,
        strict: false,
        supersedePrevious: true,
      })
      const summary = `success strategy-learning recovery date=${row.business_date} reason=run_success root=${closure.status}`
      await logWatchdog(env, row, 'success', summary)
      return summary
    }
    const summary = `running strategy-learning recovery date=${row.business_date} reason=${decision.reason}`
    await logWatchdog(env, row, 'running', summary)
    return summary
  }

  const activeDate = await loadActiveLeaseDate(opsDb)
  if (activeDate) {
    const summary = `running strategy-learning recovery date=${row.business_date} reason=other_date_active:${activeDate}`
    await logWatchdog(env, row, 'running', summary)
    return summary
  }

  // Newest first; a gated date must not starve an older recoverable one. Success rows sort
  // last and are only closed when no queued/running run remains (branch above).
  const blockedCandidates: { row: StrategyLearningRecoveryRow; outcome: Extract<CandidateOutcome, { dispatch: false }> }[] = []
  for (const candidate of candidates) {
    if (candidate.status === 'success') continue
    const first = candidate === row
    const candidateDecision = first ? decision : strategyLearningRecoveryDecision(candidate)
    if (!candidateDecision.resume) {
      if (candidateDecision.reason.startsWith('run_error:') || candidateDecision.reason === 'recoverable_progress_invalid') {
        // Recorded only: walk rows are queued/running, so the propagation's guarded UPDATE
        // (learning status='error') would be a no-op that still rewrites the root receipt.
        blockedCandidates.push({ row: candidate, outcome: {
          dispatch: false, status: 'error', token: candidateDecision.reason,
          detail: `blocked date=${candidate.business_date} reason=${candidateDecision.reason}`,
        } })
        continue
      }
      blockedCandidates.push({ row: candidate, outcome: {
        dispatch: false, status: 'running', token: candidateDecision.reason,
        detail: `date=${candidate.business_date} reason=${candidateDecision.reason}`,
      } })
      continue
    }
    const outcome = await evaluateRecoveryCandidate(env, opsDb, candidate, options, first)
    if ('token' in outcome) {
      blockedCandidates.push({ row: candidate, outcome })
      continue
    }
    return dispatchRecovery(env, candidate, candidateDecision, outcome, options)
  }

  const primary = blockedCandidates.find(({ outcome }) => outcome.status === 'error') ?? blockedCandidates[0]
  const status = primary.outcome.status
  const summary = [
    `${status} strategy-learning recovery ${primary.outcome.detail}`,
    ...(blockedCandidates.length > 1
      ? [`candidates=${blockedCandidates.map(({ row: candidate, outcome }) => `${candidate.business_date}:${outcome.token}`).join(',')}`]
      : []),
  ].join(' ')
  await logWatchdog(env, primary.row, status, summary)
  return summary
}

async function dispatchRecovery(
  env: Bindings,
  row: StrategyLearningRecoveryRow,
  decision: StrategyLearningRecoveryDecision,
  outcome: Extract<CandidateOutcome, { dispatch: true }>,
  options: StrategyLearningRecoveryOptions,
): Promise<string> {
  if (outcome.deferredFailure) {
    await env.KV.put(outcome.deferredKey, String(outcome.deferredDispatches + 1), {
      expirationTtl: DEFERRED_FAILURE_DISPATCH_TTL_SECONDS,
    })
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
  await env.KV.put(dispatchFenceKey(row), JSON.stringify({
    business_date: row.business_date,
    canonical_run_id: row.canonical_run_id,
    reason: decision.reason,
    dispatched_at: new Date().toISOString(),
  }), { expirationTtl: DISPATCH_FENCE_TTL_SECONDS })
  const summary = [
    `triggered strategy-learning recovery date=${row.business_date}`,
    `reason=${decision.reason}`,
    `attempts=${Number(row.attempt_count ?? 0)}`,
    ...(outcome.deferredFailure ? [`deferred_dispatch=${outcome.deferredDispatches + 1}/${DEFERRED_FAILURE_MAX_DISPATCHES}`] : []),
    ...(options.overrideBackoff ? ['override_backoff=true'] : []),
    `cursor=${row.cursor_symbol ?? ''}`,
    `production_authority_intent=${Number(row.production_authority_intent ?? 0) === 1}`,
    'authority=revalidate_at_finalizer',
  ].join(' ')
  await logWatchdog(env, row, 'triggered', summary)
  return summary
}
