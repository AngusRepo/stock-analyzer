import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  enqueuePipelineStage,
  markPipelineStageFenced,
} from './pipelineStageLease'
import { logSchedulerResult } from './schedulerRunLogger'

export const POST_SCREENER_CONTINUATION_STAGE = 'post_screener_continuation'
export const POST_SCREENER_QUEUED_RECOVERY_SECONDS = 300

// One-time September 29 recovery: both expired first sessions have immutable,
// zero-NAV certificates. A generic snapshot_id error never grants replay.
const SEPT29_UNOBSERVED_SNAPSHOTS = new Map([
  ['cd0eaa2d8aca42a082c94ace8c2bab2d10e0778a3879469f2a0062bb0593b66c', 'ee173175ab6e9871ccda5859de896c9306552f2866a3c6120da86a2cb14c91a9'],
  ['b95d998645eaa5681fefd5e35cc566769038d22c658cea85b32b124c67717b9e', 'd87d54c1f9faf3b3e20577e32420f95b8255bb682f505ab160a383be4044429c'],
])

async function certifiedSep29NavGap(env: Bindings, businessDate: string, error: string): Promise<boolean> {
  if (businessDate !== '2026-09-29' || error !== "'snapshot_id'") return false
  const rows = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT execution_snapshot_id, payload_checksum, payload_json
      FROM paired_nav_unobserved_pairs_v1
     WHERE session_date=? AND execution_snapshot_id IN (?, ?)
  `).bind(businessDate, ...SEPT29_UNOBSERVED_SNAPSHOTS.keys()).all<{
    execution_snapshot_id: string; payload_checksum: string; payload_json: string
  }>()
  if (rows.results.length !== SEPT29_UNOBSERVED_SNAPSHOTS.size) return false
  return rows.results.every((row) => {
    if (SEPT29_UNOBSERVED_SNAPSHOTS.get(row.execution_snapshot_id) !== row.payload_checksum) return false
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    return payload.execution_snapshot_id === row.execution_snapshot_id
      && payload.session_date === businessDate
      && payload.reason === 'first_frame_expired_without_delivery'
      && payload.nav_maturity_credit === 0
      && payload.production_effect === false
      && payload.promotion_allowed === false
  })
}

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
  runtimeApproval?: unknown
  navGapCertified?: boolean
}): PipelineProvenanceRecoveryDecision {
  const failure = input.failure
  if (!failure || failure.status !== 'error') return { retry: false, reason: 'pipeline_not_error' }
  const error = String(failure.last_error ?? '')
  const servingContractFailure = /(?:^|Error: )active8_ensemble_base_(?:identity_mismatch|not_serving):(?:LightGBM|XGBoost|ExtraTrees|TabM|GNN|DLinear|TimeXer|PatchTST|iTransformer)(?::|$)/.test(error)
  const cloudFailure = /^pipeline_cloud_run_failed:(memory_limit|task_failed);completed_at=([^;]+);execution=[a-z0-9-]+$/.exec(error)
  const paperApprovalFailure = error === 'active8_nav_current_configuration_changed_or_unverified'
  const certifiedNavGap = error === "'snapshot_id'" && input.navGapCertified === true
  if (!error.includes('pipeline_modal_source_sha_mismatch') && !servingContractFailure && !cloudFailure && !paperApprovalFailure && !certifiedNavGap) {
    return { retry: false, reason: 'pipeline_error_not_provenance_mismatch' }
  }
  const failureMs = sqliteUtcMs(cloudFailure ? cloudFailure[2] : String(failure.updated_at ?? ''))
  if (paperApprovalFailure) {
    const approval = input.runtimeApproval
    const record = approval && typeof approval === 'object' && !Array.isArray(approval)
      ? approval as Record<string, unknown> : null
    const change = record?.approved_execution_policy_change
    const policy = change && typeof change === 'object' && !Array.isArray(change)
      ? change as Record<string, unknown> : null
    const approvedMs = Date.parse(String(record?.approved_at ?? ''))
    if (record?.schema_version !== 'active8-paper-runtime-approval-v1'
      || record.approved !== true
      || policy?.schema_version !== 'active8-paper-odd-lot-quote-age-change-v1'
      || policy.variable !== 'FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS'
      || policy.previous !== 'absent' || policy.approved !== '10000'
      || !Number.isFinite(failureMs) || !Number.isFinite(approvedMs)
      || approvedMs <= failureMs) {
      return { retry: false, reason: 'paper_runtime_reapproval_not_verified_after_failure' }
    }
  }
  const sourceSha = String(input.workerVersion?.tag ?? '').trim()
  const versionId = String(input.workerVersion?.id ?? '').trim()
  const deployedAt = String(input.workerVersion?.timestamp ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !versionId || !deployedAt) {
    return { retry: false, reason: 'worker_release_identity_unavailable' }
  }
  const deployedMs = Date.parse(deployedAt)
  if (!Number.isFinite(failureMs) || !Number.isFinite(deployedMs)) {
    return { retry: false, reason: 'release_timestamp_unparseable' }
  }
  if (deployedMs <= failureMs) {
    return { retry: false, reason: 'worker_release_not_newer_than_failure' }
  }
  return { retry: true, reason: paperApprovalFailure ? 'new_worker_release_after_paper_runtime_reapproval'
    : certifiedNavGap ? 'new_worker_release_after_certified_nav_gap'
      : cloudFailure ? 'new_worker_release_after_cloud_failure' : 'new_worker_release_after_provenance_failure' }
}

export async function reconcilePipelineCloudFailure(
  env: Bindings, businessDate: string,
): Promise<{ reason: string }> {
  const row = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT canonical_run_id, status, cursor_key, last_error
      FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution'
  `).bind(businessDate).first<{
    canonical_run_id: string; status: string; cursor_key: string | null; last_error: string | null
  }>()
  if (!row || !(['running', 'waiting'].includes(row.status)
    || (row.status === 'error' && row.last_error?.startsWith('pipeline_cloud_run_failed:')))) {
    return { reason: 'no_unclosed_cloud_execution' }
  }
  if (!env.ML_CONTROLLER_URL || !env.ML_CONTROLLER_SECRET) return { reason: 'controller_status_unavailable' }
  const params = new URLSearchParams({ date: businessDate, run_id: row.canonical_run_id })
  if (row.cursor_key) params.set('execution_name', row.cursor_key)
  const response = await fetch(`${env.ML_CONTROLLER_URL}/pipeline/v2/reconcile?${params}`, {
    method: 'POST', headers: { 'X-Controller-Token': env.ML_CONTROLLER_SECRET },
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`pipeline_cloud_reconcile_http:${response.status}`)
  const result = await response.json() as {
    schema_version?: string; run_id?: string; run_date?: string; state?: string;
    reason?: string; failure_callback_sent?: boolean
  }
  if (result.schema_version !== 'pipeline-cloud-execution-status-v1'
    || result.run_id !== row.canonical_run_id || result.run_date !== businessDate) {
    throw new Error('pipeline_cloud_reconcile_identity_mismatch')
  }
  // The controller invokes the existing exact-run Worker callback/root owner.
  // Re-read D1 below; never manufacture terminal success from a process exit.
  return { reason: result.failure_callback_sent ? 'cloud_failure_callback_closed' : String(result.reason ?? result.state) }
}

export async function enqueuePostScreenerPipelineRecovery(
  env: Bindings,
  options: {
    businessDate: string
    workerVersion?: Bindings['CF_VERSION_METADATA']
    source: string
  },
): Promise<{ queued: boolean; canonicalRunId: string | null; status: string; reason: string }> {
  await reconcilePipelineCloudFailure(env, options.businessDate)
  const opsDb = databaseForDataDomain(env, 'ops')
  const failure = await opsDb.prepare(`
    SELECT canonical_run_id, status, last_error, updated_at
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='pipeline_execution'
  `).bind(options.businessDate).first<PipelineExecutionFailure>()
  const runtimeApproval = failure?.last_error === 'active8_nav_current_configuration_changed_or_unverified'
    ? await env.KV.get('ml:active8:paper_runtime_approval:v1', 'json') : null
  const navGapCertified = await certifiedSep29NavGap(
    env, options.businessDate, String(failure?.last_error ?? ''),
  )
  const decision = pipelineProvenanceRecoveryDecision({
    failure: failure ?? null,
    workerVersion: options.workerVersion,
    runtimeApproval,
    navGapCertified,
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
