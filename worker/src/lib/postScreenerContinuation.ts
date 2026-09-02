import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  enqueuePipelineStage,
  markPipelineStageFenced,
} from './pipelineStageLease'
import { logSchedulerResult } from './schedulerRunLogger'

export const POST_SCREENER_CONTINUATION_STAGE = 'post_screener_continuation'
export const POST_SCREENER_QUEUED_RECOVERY_SECONDS = 300

async function reclaimStaleQueuedPostScreenerContinuation(
  db: D1Database,
  input: { businessDate: string; canonicalRunId: string },
): Promise<boolean> {
  const recovered = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET queued_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=? AND canonical_run_id=?
       AND status='queued'
       AND COALESCE(queued_at, updated_at) < datetime('now', ?)
    RETURNING canonical_run_id
  `).bind(
    input.businessDate,
    POST_SCREENER_CONTINUATION_STAGE,
    input.canonicalRunId,
    `-${POST_SCREENER_QUEUED_RECOVERY_SECONDS} seconds`,
  ).first<{ canonical_run_id?: string | null }>()
  return String(recovered?.canonical_run_id ?? '') === input.canonicalRunId
}

export async function enqueuePostScreenerPipelineContinuation(
  env: Bindings,
  options: {
    triggerTime: string
    runId: string
    shardCount?: number
    source: string
    summary?: string
  },
): Promise<{ queued: boolean; canonicalRunId: string; status: string }> {
  const shardCount = Math.max(1, Math.floor(Number(options.shardCount ?? 1) || 1))
  const state = await enqueuePipelineStage(databaseForDataDomain(env, 'ops'), {
    businessDate: options.triggerTime,
    stage: POST_SCREENER_CONTINUATION_STAGE,
    runId: options.runId,
    resumeWaiting: true,
    adoptRunIdOnResume: true,
  })
  const reclaimedStaleQueue = !state.shouldEnqueue
    && state.row.status === 'queued'
    && state.row.canonical_run_id === options.runId
    && await reclaimStaleQueuedPostScreenerContinuation(
      databaseForDataDomain(env, 'ops'),
      { businessDate: options.triggerTime, canonicalRunId: options.runId },
    )
  if (!state.shouldEnqueue && !reclaimedStaleQueue) {
    const root = await env.KV.get(
      `scheduler:run:evening-chain:${options.triggerTime}`,
      'json',
    ) as { status?: string; run_id?: string } | null
    const durableStageAdvanced = ['queued', 'running', 'waiting', 'success']
      .includes(String(state.row.status ?? ''))
    if (
      durableStageAdvanced
      && root?.status === 'error'
      && root.run_id === state.row.canonical_run_id
    ) {
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'running',
        summary: `reconciled recovered post-screener continuation for ${options.triggerTime}; run_id=${state.row.canonical_run_id}; durable_stage=${state.row.status}; source=${options.source}`,
        duration_ms: 0,
        run_date: options.triggerTime,
        run_id: state.row.canonical_run_id,
        supersedePrevious: true,
      })
    }
    return {
      queued: false,
      canonicalRunId: state.row.canonical_run_id,
      status: state.row.status,
    }
  }
  if (reclaimedStaleQueue) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running',
      summary: `requeued stale post-screener continuation for ${options.triggerTime}; run_id=${options.runId}; source=${options.source}`,
      duration_ms: 0,
      run_date: options.triggerTime,
      run_id: options.runId,
      supersedePrevious: true,
    })
  }
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: options.summary ??
      `event-driven chain queued post-screener continuation for ${options.triggerTime}; run_id=${options.runId}; source=${options.source}`,
    duration_ms: 0,
    run_date: options.triggerTime,
    run_id: state.row.canonical_run_id,
    supersedePrevious: true,
  })
  try {
    await env.UPDATE_QUEUE.send({
      type: 'post_screener_pipeline',
      cursor: 0,
      triggerTime: options.triggerTime,
      runId: state.row.canonical_run_id,
      shardCount,
      attempt: 1,
    })
  } catch (error) {
    await markPipelineStageFenced(databaseForDataDomain(env, 'ops'), {
      businessDate: options.triggerTime,
      stage: POST_SCREENER_CONTINUATION_STAGE,
      canonicalRunId: state.row.canonical_run_id,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  await env.KV.put(
    `cron:indicator-queue:${options.triggerTime}:${state.row.canonical_run_id}:post-screener-enqueued`,
    new Date().toISOString(),
    { expirationTtl: 7 * 86400 },
  ).catch((e) => console.warn('[Queue] Post-screener enqueue marker write failed:', e))
  return {
    queued: true,
    canonicalRunId: state.row.canonical_run_id,
    status: reclaimedStaleQueue ? 'requeued' : 'queued',
  }
}

type PipelineExecutionFailure = {
  canonical_run_id: string
  status: string
  last_error: string | null
  updated_at: string
}

export type PipelineProvenanceRecoveryDecision = {
  retry: boolean
  reason: string
}

function sqliteUtcMs(value: string): number {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`
  return Date.parse(normalized)
}

export function pipelineProvenanceRecoveryDecision(input: {
  failure: PipelineExecutionFailure | null
  workerVersion?: Bindings['CF_VERSION_METADATA']
}): PipelineProvenanceRecoveryDecision {
  const failure = input.failure
  if (!failure || failure.status !== 'error') return { retry: false, reason: 'pipeline_not_error' }
  const error = String(failure.last_error ?? '')
  if (!error.includes('pipeline_modal_source_sha_mismatch')) {
    return { retry: false, reason: 'pipeline_error_not_provenance_mismatch' }
  }
  const sourceSha = String(input.workerVersion?.tag ?? '').trim()
  const versionId = String(input.workerVersion?.id ?? '').trim()
  const deployedAt = String(input.workerVersion?.timestamp ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !versionId || !deployedAt) {
    return { retry: false, reason: 'worker_release_identity_unavailable' }
  }
  const failureMs = sqliteUtcMs(String(failure.updated_at ?? ''))
  const deployedMs = Date.parse(deployedAt)
  if (!Number.isFinite(failureMs) || !Number.isFinite(deployedMs)) {
    return { retry: false, reason: 'release_timestamp_unparseable' }
  }
  if (deployedMs <= failureMs) {
    return { retry: false, reason: 'worker_release_not_newer_than_failure' }
  }
  return { retry: true, reason: 'new_worker_release_after_provenance_failure' }
}

export async function enqueuePostScreenerPipelineRecovery(
  env: Bindings,
  options: {
    businessDate: string
    workerVersion?: Bindings['CF_VERSION_METADATA']
    source: string
  },
): Promise<{ queued: boolean; canonicalRunId: string | null; status: string; reason: string }> {
  const opsDb = databaseForDataDomain(env, 'ops')
  const failure = await opsDb.prepare(`
    SELECT canonical_run_id, status, last_error, updated_at
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='pipeline_execution'
  `).bind(options.businessDate).first<PipelineExecutionFailure>()
  const decision = pipelineProvenanceRecoveryDecision({
    failure: failure ?? null,
    workerVersion: options.workerVersion,
  })
  if (!decision.retry || !failure) {
    return {
      queued: false,
      canonicalRunId: failure?.canonical_run_id ?? null,
      status: failure?.status ?? 'missing',
      reason: decision.reason,
    }
  }

  const releaseId = String(options.workerVersion!.id).trim()
  const sourceSha = String(options.workerVersion!.tag).trim()
  const recoveryRunId = `pipeline-provenance-recovery:${options.businessDate}:${releaseId}`
  const recovered = await opsDb.prepare(`
    UPDATE pipeline_stage_runs
       SET canonical_run_id=?, status='queued', cursor_key=NULL,
           processed_count=0, expected_count=NULL, persisted_count=0,
           attempt_count=0, lease_owner=NULL, lease_expires_at=NULL,
           queued_at=CURRENT_TIMESTAMP, started_at=NULL, completed_at=NULL,
           last_error=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=?
       AND (
         (status='success' AND canonical_run_id<>?)
         OR (status='error' AND canonical_run_id=?)
       )
       AND EXISTS (
         SELECT 1
           FROM pipeline_stage_runs pipeline
          WHERE pipeline.business_date=?
            AND pipeline.stage='pipeline_execution'
            AND pipeline.canonical_run_id=?
            AND pipeline.status='error'
            AND pipeline.last_error=?
            AND pipeline.updated_at=?
       )
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    recoveryRunId,
    options.businessDate,
    POST_SCREENER_CONTINUATION_STAGE,
    recoveryRunId,
    recoveryRunId,
    options.businessDate,
    failure.canonical_run_id,
    failure.last_error,
    failure.updated_at,
  ).first<import('./pipelineStageLease').PipelineStageRow>()

  if (!recovered) {
    const current = await opsDb.prepare(`
      SELECT canonical_run_id, status
        FROM pipeline_stage_runs
       WHERE business_date=? AND stage=?
    `).bind(options.businessDate, POST_SCREENER_CONTINUATION_STAGE)
      .first<{ canonical_run_id?: string | null; status?: string | null }>()
    return {
      queued: false,
      canonicalRunId: String(current?.canonical_run_id ?? '').trim() || null,
      status: String(current?.status ?? 'missing'),
      reason: current?.canonical_run_id === recoveryRunId
        ? 'release_recovery_already_claimed'
        : 'recovery_cas_not_acquired',
    }
  }

  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `pipeline provenance recovery queued for ${options.businessDate}; failed_run_id=${failure.canonical_run_id}; recovery_run_id=${recoveryRunId}; source_sha=${sourceSha}; source=${options.source}`,
    duration_ms: 0,
    run_date: options.businessDate,
    run_id: recoveryRunId,
  })
  try {
    await env.UPDATE_QUEUE.send({
      type: 'post_screener_pipeline',
      cursor: 0,
      triggerTime: options.businessDate,
      runId: recoveryRunId,
      shardCount: 1,
      attempt: 1,
    })
  } catch (error) {
    await markPipelineStageFenced(opsDb, {
      businessDate: options.businessDate,
      stage: POST_SCREENER_CONTINUATION_STAGE,
      canonicalRunId: recoveryRunId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  await env.KV.put(
    `cron:pipeline-recovery:${options.businessDate}:${releaseId}:enqueued`,
    new Date().toISOString(),
    { expirationTtl: 30 * 86400 },
  ).catch((error) => console.warn('[Queue] Pipeline recovery marker write failed:', error))
  return {
    queued: true,
    canonicalRunId: recoveryRunId,
    status: 'queued',
    reason: decision.reason,
  }
}
