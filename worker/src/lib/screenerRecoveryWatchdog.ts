import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { resolveEveningChainRunAuthority } from './eveningChainRunAuthority'
import {
  claimPipelineStage,
  enqueuePipelineStage,
  type PipelineStageRow,
} from './pipelineStageLease'
import {
  enqueuePostScreenerPipelineContinuation,
  enqueuePostScreenerPipelineRecovery,
} from './postScreenerContinuation'

const SCREENER_STAGE = 'screener_v2'
const SCREENER_LEASE_SECONDS = 6000
const SCREENER_MAX_ATTEMPTS = 3

type TriggerScreener = (
  env: Bindings,
  runDate?: string | null,
  options?: { chainRunId?: string },
) => Promise<unknown>

type FunnelClosure = {
  run_id?: string | null
  universe_count?: number | string | null
  final_count?: number | string | null
}

type CallbackReceipt = {
  accepted: boolean
  reason: string
  canonicalRunId: string | null
  producerRunId: string | null
}

export function screenerLeaseExpired(row: Pick<PipelineStageRow, 'status' | 'lease_expires_at'>, nowMs = Date.now()): boolean {
  if (row.status !== 'running') return false
  const expiresAt = String(row.lease_expires_at ?? '').trim()
  if (!expiresAt) return true
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(expiresAt)
    ? expiresAt
    : `${expiresAt.replace(' ', 'T')}Z`
  const expiresMs = Date.parse(normalized)
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs
}

export function screenerRetryDecision(
  row: Pick<PipelineStageRow, 'status' | 'attempt_count' | 'lease_expires_at'> | null,
  nowMs = Date.now(),
): { retry: boolean; reason: string } {
  if (!row) return { retry: true, reason: 'stage_missing' }
  if (row.status === 'success') return { retry: false, reason: 'stage_success' }
  if (row.status === 'running' && !screenerLeaseExpired(row, nowMs)) {
    return { retry: false, reason: 'active_lease' }
  }
  if (Number(row.attempt_count ?? 0) >= SCREENER_MAX_ATTEMPTS) {
    return { retry: false, reason: 'retry_exhausted' }
  }
  return { retry: true, reason: row.status === 'running' ? 'lease_expired' : `stage_${row.status}` }
}

async function loadScreenerStage(db: D1Database, businessDate: string): Promise<PipelineStageRow | null> {
  return db.prepare(`
    SELECT business_date, stage, canonical_run_id, status, cursor_key,
           processed_count, expected_count, persisted_count, attempt_count,
           lease_owner, lease_expires_at
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage=?
  `).bind(businessDate, SCREENER_STAGE).first<PipelineStageRow>()
}

async function loadCanonicalChainRunId(db: D1Database, businessDate: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT canonical_run_id
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='screener_v2'
     ORDER BY updated_at DESC
     LIMIT 1
  `).bind(businessDate).first<{ canonical_run_id?: string | null }>()
  return String(row?.canonical_run_id ?? '').trim() || null
}

function triggerProducerRunId(result: unknown): string | null {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const candidate = String((result as Record<string, unknown>).run_id ?? '').trim()
    if (candidate) return candidate
  }
  const match = String(result ?? '').match(/(?:^|\s)run_id=([^\s;]+)/)
  return String(match?.[1] ?? '').trim() || null
}

function activeExecutionCollision(error: unknown): boolean {
  return /already has an active execution/i.test(error instanceof Error ? error.message : String(error))
}

async function bindScreenerProducerRun(
  db: D1Database,
  input: { businessDate: string; canonicalRunId: string; ownerId: string; producerRunId: string },
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET cursor_key=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
    RETURNING cursor_key
  `).bind(
    input.producerRunId,
    input.businessDate,
    SCREENER_STAGE,
    input.canonicalRunId,
    input.ownerId,
  ).first<{ cursor_key?: string | null }>()
  return row?.cursor_key === input.producerRunId
}

async function settleScreenerTriggerFailure(
  db: D1Database,
  input: {
    businessDate: string
    canonicalRunId: string
    ownerId: string
    error: string
    activeCollision: boolean
  },
): Promise<void> {
  if (input.activeCollision) {
    await db.prepare(`
      UPDATE pipeline_stage_runs
         SET status='waiting', attempt_count=MAX(0, attempt_count-1),
             lease_owner=NULL, lease_expires_at=NULL,
             last_error='screener_active_execution_collision_no_attempt_consumed',
             updated_at=CURRENT_TIMESTAMP
       WHERE business_date=? AND stage=? AND canonical_run_id=?
         AND status='running' AND lease_owner=?
    `).bind(input.businessDate, SCREENER_STAGE, input.canonicalRunId, input.ownerId).run()
    return
  }
  await db.prepare(`
    UPDATE pipeline_stage_runs
       SET status='error', lease_owner=NULL, lease_expires_at=NULL,
           completed_at=CURRENT_TIMESTAMP, last_error=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
  `).bind(
    input.error.slice(0, 1000),
    input.businessDate,
    SCREENER_STAGE,
    input.canonicalRunId,
    input.ownerId,
  ).run()
}

async function loadSuccessfulFunnel(
  db: D1Database,
  businessDate: string,
  producerRunId: string,
): Promise<FunnelClosure | null> {
  return db.prepare(`
    SELECT run_id, universe_count, final_count
      FROM screener_funnel_runs
     WHERE date=? AND run_id=? AND status='success' AND COALESCE(universe_count, 0) > 0
  `).bind(businessDate, producerRunId).first<FunnelClosure>()
}

export async function triggerCanonicalScreenerStage(
  env: Bindings,
  input: {
    businessDate: string
    canonicalRunId: string
    trigger: TriggerScreener
    ownerId?: string
  },
): Promise<string> {
  const opsDb = databaseForDataDomain(env, 'ops')
  const state = await enqueuePipelineStage(opsDb, {
    businessDate: input.businessDate,
    stage: SCREENER_STAGE,
    runId: input.canonicalRunId,
    resumeWaiting: true,
    adoptRunIdOnResume: true,
  })
  if (state.row.canonical_run_id !== input.canonicalRunId) {
    throw new Error(
      `screener_stage_lineage_mismatch:${input.businessDate}:${state.row.canonical_run_id}:${input.canonicalRunId}`,
    )
  }
  if (!state.shouldEnqueue) {
    return `LOCKED screener stage status=${state.row.status} attempt=${state.row.attempt_count}`
  }

  const ownerId = input.ownerId || `${input.canonicalRunId}:screener:${Date.now().toString(36)}`
  const claimed = await claimPipelineStage(opsDb, {
    businessDate: input.businessDate,
    stage: SCREENER_STAGE,
    ownerId,
    leaseSeconds: SCREENER_LEASE_SECONDS,
  })
  if (!claimed) return 'LOCKED screener stage claim unavailable'
  if (Number(claimed.attempt_count ?? 0) > SCREENER_MAX_ATTEMPTS) {
    await settleScreenerTriggerFailure(opsDb, {
      businessDate: input.businessDate,
      canonicalRunId: input.canonicalRunId,
      ownerId,
      error: 'screener_recovery_attempt_limit_exceeded',
      activeCollision: false,
    })
    throw new Error(`screener_recovery_attempt_limit_exceeded:${input.businessDate}`)
  }

  try {
    const result = await input.trigger(env, input.businessDate, { chainRunId: input.canonicalRunId })
    const producerRunId = triggerProducerRunId(result)
    if (!producerRunId) throw new Error('screener_trigger_producer_run_id_missing')
    const bound = await bindScreenerProducerRun(opsDb, {
      businessDate: input.businessDate,
      canonicalRunId: input.canonicalRunId,
      ownerId,
      producerRunId,
    })
    if (!bound) throw new Error('screener_trigger_stage_fence_lost')
    return typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 500) ?? 'triggered'
  } catch (error) {
    await settleScreenerTriggerFailure(opsDb, {
      businessDate: input.businessDate,
      canonicalRunId: input.canonicalRunId,
      ownerId,
      error: error instanceof Error ? error.message : String(error),
      activeCollision: activeExecutionCollision(error),
    })
    throw error
  }
}

export async function recordCanonicalScreenerCallback(
  db: D1Database,
  input: {
    businessDate: string
    canonicalRunId: string
    producerRunId: string
    status: 'success' | 'error' | 'skipped'
    error?: string
  },
): Promise<CallbackReceipt> {
  const stage = await loadScreenerStage(db, input.businessDate)
  if (!stage) return { accepted: false, reason: 'screener_stage_missing', canonicalRunId: null, producerRunId: null }
  if (stage.canonical_run_id !== input.canonicalRunId) {
    return {
      accepted: false,
      reason: 'screener_callback_lineage_mismatch',
      canonicalRunId: stage.canonical_run_id,
      producerRunId: stage.cursor_key,
    }
  }
  if (!stage.cursor_key || stage.cursor_key !== input.producerRunId) {
    return {
      accepted: false,
      reason: 'screener_callback_producer_mismatch',
      canonicalRunId: stage.canonical_run_id,
      producerRunId: stage.cursor_key,
    }
  }
  if (stage.status === 'success' && input.status !== 'success') {
    return {
      accepted: false,
      reason: 'screener_callback_stale_non_success_after_success',
      canonicalRunId: stage.canonical_run_id,
      producerRunId: stage.cursor_key,
    }
  }
  if (stage.status === 'success') {
    return {
      accepted: true,
      reason: 'callback_terminal_already_success',
      canonicalRunId: stage.canonical_run_id,
      producerRunId: stage.cursor_key,
    }
  }
  if (input.status === 'success') {
    const funnel = await loadSuccessfulFunnel(db, input.businessDate, input.producerRunId)
    if (!funnel?.run_id) {
      return {
        accepted: false,
        reason: 'screener_callback_exact_funnel_missing',
        canonicalRunId: stage.canonical_run_id,
        producerRunId: stage.cursor_key,
      }
    }
  }
  const terminalStatus = input.status === 'success' ? 'success' : 'error'
  const updated = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET status=?, last_error=?, lease_owner=NULL, lease_expires_at=NULL,
           completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=? AND canonical_run_id=? AND cursor_key=?
       AND (status<>'success' OR ?='success')
    RETURNING status
  `).bind(
    terminalStatus,
    input.status === 'success' ? null : String(input.error || input.status).slice(0, 1000),
    input.businessDate,
    SCREENER_STAGE,
    input.canonicalRunId,
    input.producerRunId,
    terminalStatus,
  ).first<{ status?: string }>()
  if (!updated) {
    return {
      accepted: false,
      reason: 'screener_callback_stage_fence_lost',
      canonicalRunId: stage.canonical_run_id,
      producerRunId: stage.cursor_key,
    }
  }
  return {
    accepted: true,
    reason: `callback_${input.status}`,
    canonicalRunId: stage.canonical_run_id,
    producerRunId: stage.cursor_key,
  }
}

export async function runScreenerRecoveryWatchdog(
  env: Bindings,
  trigger: TriggerScreener,
  businessDate: string,
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error(`invalid_screener_watchdog_date:${businessDate}`)
  }
  const opsDb = databaseForDataDomain(env, 'ops')
  const canonicalRunId = await loadCanonicalChainRunId(opsDb, businessDate)
  if (!canonicalRunId) return `SKIPPED canonical screener run missing for ${businessDate}`

  const authority = await resolveEveningChainRunAuthority(env, {
    businessDate,
    canonicalRunId,
    authorityStage: 'screener_v2',
  })
  if (!authority.allowed) {
    return `SKIPPED screener recovery authority denied: ${authority.reason}`
  }

  const stage = await loadScreenerStage(opsDb, businessDate)
  if (stage && stage.canonical_run_id !== canonicalRunId) {
    throw new Error(
      `screener_watchdog_canonical_lineage_mismatch:${businessDate}:${stage.canonical_run_id}:${canonicalRunId}`,
    )
  }
  const producerRunId = String(stage?.cursor_key ?? '').trim()
  const funnel = producerRunId
    ? await loadSuccessfulFunnel(opsDb, businessDate, producerRunId)
    : null
  if (funnel?.run_id) {
    const receipt = await recordCanonicalScreenerCallback(opsDb, {
      businessDate,
      canonicalRunId,
      producerRunId,
      status: 'success',
    })
    if (!receipt.accepted) throw new Error(`screener_watchdog_callback_rejected:${receipt.reason}`)
    const continuation = await enqueuePostScreenerPipelineContinuation(env, {
      triggerTime: businessDate,
      runId: canonicalRunId,
      source: 'screener-v2-watchdog-closure',
      summary: `watchdog verified exact screener funnel=${funnel.run_id} universe=${Number(funnel.universe_count ?? 0)}`,
    })
    const pipelineRecovery = !continuation.queued && continuation.status === 'success'
      ? await enqueuePostScreenerPipelineRecovery(env, {
          businessDate,
          workerVersion: env.CF_VERSION_METADATA,
          source: 'screener-v2-watchdog-pipeline-recovery',
        })
      : null
    return [
      `success funnel=${funnel.run_id}`,
      `universe=${Number(funnel.universe_count ?? 0)}`,
      `continuation=${continuation.queued ? 'queued' : `already_${continuation.status}`}`,
      `pipeline_recovery=${pipelineRecovery
        ? (pipelineRecovery.queued ? 'queued' : pipelineRecovery.reason)
        : 'not_needed'}`,
    ].join(' ')
  }
  if (stage?.status === 'success') {
    throw new Error(`screener_stage_success_without_exact_funnel:${businessDate}:${producerRunId || 'missing'}`)
  }

  const decision = screenerRetryDecision(stage)
  if (!decision.retry) {
    if (decision.reason === 'retry_exhausted') {
      throw new Error(`screener_recovery_exhausted:${businessDate}:attempts=${Number(stage?.attempt_count ?? 0)}`)
    }
    return `running screener watchdog reason=${decision.reason} attempt=${Number(stage?.attempt_count ?? 0)}`
  }

  const summary = await triggerCanonicalScreenerStage(env, {
    businessDate,
    canonicalRunId,
    trigger,
    ownerId: `${canonicalRunId}:watchdog:${Date.now().toString(36)}`,
  })
  return `triggered same-day screener recovery reason=${decision.reason}; ${summary}`
}
