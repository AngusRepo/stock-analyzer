import type { Bindings } from '../types'

export type PipelineStageStatus = 'queued' | 'running' | 'waiting' | 'success' | 'error'

export type PipelineStageRow = {
  business_date: string
  stage: string
  canonical_run_id: string
  status: PipelineStageStatus
  cursor_key: string | null
  processed_count: number
  expected_count: number | null
  persisted_count: number
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
}

const leaseModifier = (seconds: number) => `+${Math.max(30, Math.floor(seconds))} seconds`

export async function enqueuePipelineStage(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    runId: string
    resumeWaiting?: boolean
    supersedeSuccess?: boolean
  },
): Promise<{ shouldEnqueue: boolean; row: PipelineStageRow }> {
  const inserted = await db.prepare(`
    INSERT INTO pipeline_stage_runs (
      business_date, stage, canonical_run_id, status, queued_at, updated_at
    ) VALUES (?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(business_date, stage) DO NOTHING
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(input.businessDate, input.stage, input.runId).first<PipelineStageRow>()
  if (inserted) return { shouldEnqueue: true, row: inserted }

  if (input.resumeWaiting) {
    const resumed = await db.prepare(`
      UPDATE pipeline_stage_runs
         SET status='queued', queued_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
             lease_owner=NULL, lease_expires_at=NULL, last_error=NULL
       WHERE business_date=? AND stage=?
         AND (
           status IN ('waiting', 'error')
           OR (status='running' AND lease_expires_at < CURRENT_TIMESTAMP)
         )
      RETURNING business_date, stage, canonical_run_id, status, cursor_key,
                processed_count, expected_count, persisted_count, attempt_count,
                lease_owner, lease_expires_at
    `).bind(input.businessDate, input.stage).first<PipelineStageRow>()
    if (resumed) return { shouldEnqueue: true, row: resumed }
  }

  if (input.supersedeSuccess) {
    const superseded = await db.prepare(`
      UPDATE pipeline_stage_runs
         SET canonical_run_id=?,
             status='queued',
             cursor_key=NULL,
             processed_count=0,
             expected_count=NULL,
             persisted_count=0,
             attempt_count=0,
             lease_owner=NULL,
             lease_expires_at=NULL,
             queued_at=CURRENT_TIMESTAMP,
             started_at=NULL,
             completed_at=NULL,
             last_error=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE business_date=? AND stage=?
         AND status='success'
         AND canonical_run_id<>?
      RETURNING business_date, stage, canonical_run_id, status, cursor_key,
                processed_count, expected_count, persisted_count, attempt_count,
                lease_owner, lease_expires_at
    `).bind(input.runId, input.businessDate, input.stage, input.runId).first<PipelineStageRow>()
    if (superseded) return { shouldEnqueue: true, row: superseded }
  }

  const row = await db.prepare(`
    SELECT business_date, stage, canonical_run_id, status, cursor_key,
           processed_count, expected_count, persisted_count, attempt_count,
           lease_owner, lease_expires_at
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage=?
  `).bind(input.businessDate, input.stage).first<PipelineStageRow>()
  if (!row) throw new Error(`pipeline_stage_state_missing:${input.businessDate}:${input.stage}`)
  return { shouldEnqueue: false, row }
}

export async function claimPipelineStage(
  db: D1Database,
  input: { businessDate: string; stage: string; ownerId: string; leaseSeconds?: number },
): Promise<PipelineStageRow | null> {
  return db.prepare(`
    UPDATE pipeline_stage_runs
       SET status='running', lease_owner=?, lease_expires_at=datetime('now', ?),
           started_at=COALESCE(started_at, CURRENT_TIMESTAMP),
           attempt_count=attempt_count+1, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=?
       AND (
         status='queued'
         OR (status='running' AND lease_expires_at < CURRENT_TIMESTAMP)
       )
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    input.ownerId,
    leaseModifier(input.leaseSeconds ?? 900),
    input.businessDate,
    input.stage,
  ).first<PipelineStageRow>()
}

export async function markPipelineStage(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    status: Extract<PipelineStageStatus, 'waiting' | 'success' | 'error'>
    error?: string | null
  },
): Promise<void> {
  await db.prepare(`
    UPDATE pipeline_stage_runs
       SET status=?, last_error=?, lease_owner=NULL, lease_expires_at=NULL,
           completed_at=CASE WHEN ? IN ('success', 'error') THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=?
  `).bind(
    input.status,
    input.error?.slice(0, 1000) ?? null,
    input.status,
    input.businessDate,
    input.stage,
  ).run()
}

export async function queuePostPipelineStage(
  env: Pick<Bindings, 'DB' | 'UPDATE_QUEUE'>,
  input: {
    businessDate: string
    runId: string
    resumeWaiting?: boolean
    supersedeSuccess?: boolean
    attempt?: number
  },
): Promise<{ queued: boolean; canonicalRunId: string; status: PipelineStageStatus }> {
  const state = await enqueuePipelineStage(env.DB, {
    businessDate: input.businessDate,
    stage: 'post_pipeline_chain',
    runId: input.runId,
    resumeWaiting: input.resumeWaiting,
    supersedeSuccess: input.supersedeSuccess,
  })
  if (!state.shouldEnqueue) {
    return { queued: false, canonicalRunId: state.row.canonical_run_id, status: state.row.status }
  }
  try {
    await env.UPDATE_QUEUE.send({
      type: 'post_pipeline_chain',
      cursor: 0,
      triggerTime: input.businessDate,
      runId: state.row.canonical_run_id,
      attempt: Math.max(0, Math.floor(input.attempt ?? state.row.attempt_count)),
    })
  } catch (error) {
    await markPipelineStage(env.DB, {
      businessDate: input.businessDate,
      stage: 'post_pipeline_chain',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return { queued: true, canonicalRunId: state.row.canonical_run_id, status: 'queued' }
}

export async function queuePostVerifyStage(
  env: Pick<Bindings, 'DB' | 'UPDATE_QUEUE'>,
  input: { businessDate: string; runId: string; resumeWaiting?: boolean; attempt?: number },
): Promise<{ queued: boolean; canonicalRunId: string; status: PipelineStageStatus }> {
  const state = await enqueuePipelineStage(env.DB, {
    businessDate: input.businessDate,
    stage: 'post_verify_chain',
    runId: input.runId,
    resumeWaiting: input.resumeWaiting,
  })
  if (!state.shouldEnqueue) {
    return { queued: false, canonicalRunId: state.row.canonical_run_id, status: state.row.status }
  }
  try {
    await env.UPDATE_QUEUE.send({
      type: 'post_verify_chain',
      cursor: 0,
      triggerTime: input.businessDate,
      runId: state.row.canonical_run_id,
      attempt: Math.max(0, Math.floor(input.attempt ?? state.row.attempt_count)),
    })
  } catch (error) {
    await markPipelineStage(env.DB, {
      businessDate: input.businessDate,
      stage: 'post_verify_chain',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return { queued: true, canonicalRunId: state.row.canonical_run_id, status: 'queued' }
}
