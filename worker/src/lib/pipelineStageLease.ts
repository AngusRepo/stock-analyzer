import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

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

export const PIPELINE_STAGE_LEASE_SECONDS = 900

export type PipelineStageLeaseIdentity = {
  businessDate: string
  stage: string
  canonicalRunId: string
  leaseOwner: string
}

const PIPELINE_STAGE_LEASE_LOST_PREFIX = 'pipeline_stage_lease_lost:'

function pipelineStageLeaseLost(input: PipelineStageLeaseIdentity): Error {
  return new Error(
    `${PIPELINE_STAGE_LEASE_LOST_PREFIX}${input.businessDate}:${input.stage}:${input.canonicalRunId}:${input.leaseOwner}`,
  )
}

export function isPipelineStageLeaseLost(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error)
  return reason.startsWith(PIPELINE_STAGE_LEASE_LOST_PREFIX)
}

export const PIPELINE_EXECUTION_CALLBACK_SECONDS = 7_200
export const PIPELINE_EXECUTION_RESERVATION_SECONDS = PIPELINE_EXECUTION_CALLBACK_SECONDS

export async function reservePipelineExecutionDispatch(
  db: D1Database,
  input: { businessDate: string; attemptId: string; leaseSeconds?: number },
): Promise<PipelineStageRow | null> {
  const attemptId = input.attemptId.trim()
  if (!attemptId) throw new Error(`pipeline_execution_reservation_identity_missing:${input.businessDate}`)
  return db.prepare(`
    INSERT INTO pipeline_stage_runs (
      business_date, stage, canonical_run_id, status,
      lease_owner, lease_expires_at, queued_at, started_at, updated_at
    ) VALUES (
      ?, 'pipeline_execution', ?, 'running', ?, datetime('now', ?),
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(business_date, stage) DO UPDATE SET
      canonical_run_id=excluded.canonical_run_id,
      status='running', cursor_key=NULL,
      processed_count=0, expected_count=NULL, persisted_count=0,
      attempt_count=pipeline_stage_runs.attempt_count+1,
      lease_owner=excluded.lease_owner, lease_expires_at=excluded.lease_expires_at,
      queued_at=CURRENT_TIMESTAMP, started_at=CURRENT_TIMESTAMP, completed_at=NULL,
      last_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE pipeline_stage_runs.status='error'
       OR (
         pipeline_stage_runs.status IN ('running', 'waiting')
         AND pipeline_stage_runs.lease_expires_at < CURRENT_TIMESTAMP
       )
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    input.businessDate,
    attemptId,
    attemptId,
    leaseModifier(input.leaseSeconds ?? PIPELINE_EXECUTION_RESERVATION_SECONDS),
  ).first<PipelineStageRow>()
}

export async function commitPipelineExecutionDispatch(
  db: D1Database,
  input: {
    businessDate: string
    attemptId: string
    runId: string
    callbackLeaseSeconds?: number
  },
): Promise<PipelineStageRow | null> {
  const runId = input.runId.trim()
  if (!runId || runId === 'unknown') {
    throw new Error(`pipeline_execution_dispatch_identity_missing:${input.businessDate}`)
  }
  return db.prepare(`
    UPDATE pipeline_stage_runs
       SET canonical_run_id=?, status='waiting',
           lease_expires_at=datetime('now', ?), updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage='pipeline_execution'
       AND canonical_run_id=? AND status='running'
       AND lease_owner=? AND lease_expires_at >= CURRENT_TIMESTAMP
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    runId,
    leaseModifier(input.callbackLeaseSeconds ?? PIPELINE_EXECUTION_CALLBACK_SECONDS),
    input.businessDate,
    input.attemptId,
    input.attemptId,
  ).first<PipelineStageRow>()
}

export async function failPipelineExecutionDispatch(
  db: D1Database,
  input: { businessDate: string; attemptId: string; error: string },
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET status='error', last_error=?, lease_owner=NULL, lease_expires_at=NULL,
           completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage='pipeline_execution'
       AND canonical_run_id=? AND status='running' AND lease_owner=?
    RETURNING status
  `).bind(
    input.error.slice(0, 1000),
    input.businessDate,
    input.attemptId,
    input.attemptId,
  ).first<{ status: PipelineStageStatus }>()
  return Boolean(row)
}

export async function acceptPipelineExecutionCallback(
  db: D1Database,
  input: {
    businessDate: string
    runId: string
    status: Extract<PipelineStageStatus, 'success' | 'error'>
    error?: string | null
  },
): Promise<PipelineStageRow | null> {
  return db.prepare(`
    UPDATE pipeline_stage_runs
       SET status=?, last_error=?, lease_owner=NULL, lease_expires_at=NULL,
           completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage='pipeline_execution'
       AND canonical_run_id=?
       AND status IN ('running', 'waiting', ?)
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    input.status,
    input.error?.slice(0, 1000) ?? null,
    input.businessDate,
    input.runId,
    input.status,
  ).first<PipelineStageRow>()
}

export async function isPipelineStageCanonicalState(
  db: D1Database,
  input: { businessDate: string; stage: string; canonicalRunId: string; status?: PipelineStageStatus },
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS ok
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage=? AND canonical_run_id=?
       AND (? IS NULL OR status=?)
  `).bind(
    input.businessDate,
    input.stage,
    input.canonicalRunId,
    input.status ?? null,
    input.status ?? null,
  ).first<{ ok: number }>()
  return Boolean(row)
}

export async function heartbeatPipelineStageLease(
  db: D1Database,
  input: PipelineStageLeaseIdentity & { leaseSeconds?: number },
): Promise<boolean> {
  const renewed = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET lease_expires_at=datetime('now', ?), updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
    RETURNING business_date
  `).bind(
    leaseModifier(input.leaseSeconds ?? PIPELINE_STAGE_LEASE_SECONDS),
    input.businessDate,
    input.stage,
    input.canonicalRunId,
    input.leaseOwner,
  ).first<{ business_date: string }>()
  return Boolean(renewed)
}

type PipelineStageHeartbeatTimer = number

export type PipelineStageLeaseHeartbeatController = {
  assertActive: (boundary?: string) => Promise<void>
  stop: () => Promise<void>
  leaseError: () => Error | null
}

export function startPipelineStageLeaseHeartbeat(
  db: D1Database,
  input: PipelineStageLeaseIdentity & { leaseSeconds?: number },
  options: {
    intervalMs?: number
    heartbeat?: () => Promise<boolean>
    setIntervalFn?: (callback: () => void, intervalMs: number) => PipelineStageHeartbeatTimer
    clearIntervalFn?: (timer: PipelineStageHeartbeatTimer) => void
  } = {},
): PipelineStageLeaseHeartbeatController {
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? 60_000))
  const heartbeat = options.heartbeat ?? (() => heartbeatPipelineStageLease(db, input))
  const setIntervalFn = options.setIntervalFn
    ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs) as unknown as number)
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => globalThis.clearInterval(timer))
  let stopped = false
  let lostError: Error | null = null
  let heartbeatInFlight: Promise<void> | null = null

  const pulse = (): Promise<void> => {
    if (lostError) return Promise.reject(lostError)
    if (heartbeatInFlight) return heartbeatInFlight
    const current = (async () => {
      try {
        if (!(await heartbeat())) throw pipelineStageLeaseLost(input)
      } catch (error) {
        lostError = isPipelineStageLeaseLost(error) ? error as Error : pipelineStageLeaseLost(input)
        throw lostError
      }
    })()
    heartbeatInFlight = current
    void current.finally(() => {
      if (heartbeatInFlight === current) heartbeatInFlight = null
    }).catch(() => {})
    return current
  }

  const timer = setIntervalFn(() => {
    if (stopped || lostError) return
    void pulse().catch(() => {})
  }, intervalMs)

  return {
    assertActive: async () => {
      if (stopped) throw pipelineStageLeaseLost(input)
      await pulse()
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(timer)
      if (heartbeatInFlight) await heartbeatInFlight.catch(() => {})
    },
    leaseError: () => lostError,
  }
}

export async function enqueuePipelineStage(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    runId: string
    resumeWaiting?: boolean
    adoptRunIdOnResume?: boolean
    supersedeSuccess?: boolean
    expectedCanonicalRunId?: string
  },
): Promise<{ shouldEnqueue: boolean; row: PipelineStageRow }> {
  const expectedCanonicalRunId = input.expectedCanonicalRunId?.trim() || null
  const liveStrategyLearningGuardSql = input.stage === 'post_verify_chain'
    ? `AND (
         pipeline_stage_runs.canonical_run_id=?
         OR NOT EXISTS (
           SELECT 1
             FROM strategy_learning_runs strategy_learning
            WHERE strategy_learning.business_date=pipeline_stage_runs.business_date
              AND strategy_learning.canonical_run_id=pipeline_stage_runs.canonical_run_id
              AND strategy_learning.status IN ('running', 'success')
              AND strategy_learning.lease_owner IS NOT NULL
              AND strategy_learning.lease_expires_at >= CURRENT_TIMESTAMP
         )
       )`
    : ''
  const liveStrategyLearningGuardBindings = input.stage === 'post_verify_chain'
    ? [input.runId]
    : []
  const noForeignLiveStrategyLearningSql = input.stage === 'post_verify_chain'
    ? `NOT EXISTS (
         SELECT 1
           FROM strategy_learning_runs strategy_learning
          WHERE strategy_learning.business_date=?
            AND strategy_learning.canonical_run_id<>?
            AND strategy_learning.status IN ('running', 'success')
            AND strategy_learning.lease_owner IS NOT NULL
            AND strategy_learning.lease_expires_at >= CURRENT_TIMESTAMP
       )`
    : '1=1'
  const noForeignLiveStrategyLearningBindings = input.stage === 'post_verify_chain'
    ? [input.businessDate, input.runId]
    : []
  // A callback/queue continuation with an expected owner is not authorized to
  // create a missing stage. The canonical producer must establish it first.
  if (!expectedCanonicalRunId) {
    const inserted = await db.prepare(`
      INSERT INTO pipeline_stage_runs (
        business_date, stage, canonical_run_id, status, queued_at, updated_at
      )
      SELECT ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       WHERE ${noForeignLiveStrategyLearningSql}
      ON CONFLICT(business_date, stage) DO NOTHING
      RETURNING business_date, stage, canonical_run_id, status, cursor_key,
                processed_count, expected_count, persisted_count, attempt_count,
                lease_owner, lease_expires_at
    `).bind(
      input.businessDate,
      input.stage,
      input.runId,
      ...noForeignLiveStrategyLearningBindings,
    ).first<PipelineStageRow>()
    if (inserted) return { shouldEnqueue: true, row: inserted }
  }

  if (input.adoptRunIdOnResume && !expectedCanonicalRunId) {
    const adopted = await db.prepare(`
      UPDATE pipeline_stage_runs
         SET canonical_run_id=?, status='queued', cursor_key=NULL,
             processed_count=0, expected_count=NULL, persisted_count=0,
             attempt_count=0, lease_owner=NULL, lease_expires_at=NULL,
             queued_at=CURRENT_TIMESTAMP, started_at=NULL, completed_at=NULL,
             last_error=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE business_date=? AND stage=?
         AND canonical_run_id<>?
         ${liveStrategyLearningGuardSql}
         AND (
           status IN ('waiting', 'error')
           OR (status='running' AND lease_expires_at < CURRENT_TIMESTAMP)
         )
      RETURNING business_date, stage, canonical_run_id, status, cursor_key,
                processed_count, expected_count, persisted_count, attempt_count,
                lease_owner, lease_expires_at
    `).bind(
      input.runId,
      input.businessDate,
      input.stage,
      input.runId,
      ...liveStrategyLearningGuardBindings,
    ).first<PipelineStageRow>()
    if (adopted) return { shouldEnqueue: true, row: adopted }
  }

  if (input.resumeWaiting) {
    const canonicalFenceSql = expectedCanonicalRunId ? 'AND canonical_run_id=?' : ''
    const resumeBindings = expectedCanonicalRunId
      ? [input.businessDate, input.stage, expectedCanonicalRunId]
      : [input.businessDate, input.stage]
    const resumed = await db.prepare(`
      UPDATE pipeline_stage_runs
         SET status='queued', queued_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
             lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL, last_error=NULL
       WHERE business_date=? AND stage=?
         ${canonicalFenceSql}
         AND (
           status IN ('waiting', 'error')
           OR (status='running' AND lease_expires_at < CURRENT_TIMESTAMP)
         )
      RETURNING business_date, stage, canonical_run_id, status, cursor_key,
                processed_count, expected_count, persisted_count, attempt_count,
                lease_owner, lease_expires_at
    `).bind(...resumeBindings).first<PipelineStageRow>()
    if (resumed) return { shouldEnqueue: true, row: resumed }
  }

  if (input.supersedeSuccess && !expectedCanonicalRunId) {
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
         ${liveStrategyLearningGuardSql}
      RETURNING business_date, stage, canonical_run_id, status, cursor_key,
                processed_count, expected_count, persisted_count, attempt_count,
                lease_owner, lease_expires_at
    `).bind(
      input.runId,
      input.businessDate,
      input.stage,
      input.runId,
      ...liveStrategyLearningGuardBindings,
    ).first<PipelineStageRow>()
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


export type PipelineStageAuthority = {
  stage: string
  canonicalRunId: string
  status?: PipelineStageStatus | null
  cursorKey?: string | null
  leaseOwner?: string | null
}

export async function enqueuePipelineStageAuthorized(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    runId: string
    authority: PipelineStageAuthority
  },
): Promise<{ shouldEnqueue: boolean; row: PipelineStageRow }> {
  const authority = input.authority
  const authoritySql = `EXISTS (
    SELECT 1 FROM pipeline_stage_runs authority
     WHERE authority.business_date=?
       AND authority.stage=?
       AND authority.canonical_run_id=?
       AND (? IS NULL OR authority.status=?)
       AND (? IS NULL OR authority.cursor_key=?)
       AND (? IS NULL OR (
         authority.status='running'
         AND authority.lease_owner=?
         AND authority.lease_expires_at >= CURRENT_TIMESTAMP
       ))
  )`
  const authorityBindings = [
    input.businessDate,
    authority.stage,
    authority.canonicalRunId,
    authority.status ?? null,
    authority.status ?? null,
    authority.cursorKey ?? null,
    authority.cursorKey ?? null,
    authority.leaseOwner ?? null,
    authority.leaseOwner ?? null,
  ]
  const liveStrategyLearningGuardSql = input.stage === 'post_verify_chain'
    ? `AND (
         canonical_run_id=?
         OR NOT EXISTS (
           SELECT 1
             FROM strategy_learning_runs strategy_learning
            WHERE strategy_learning.business_date=pipeline_stage_runs.business_date
              AND strategy_learning.canonical_run_id=pipeline_stage_runs.canonical_run_id
              AND strategy_learning.status IN ('running', 'success')
              AND strategy_learning.lease_owner IS NOT NULL
              AND strategy_learning.lease_expires_at >= CURRENT_TIMESTAMP
         )
       )`
    : ''
  const liveStrategyLearningGuardBindings = input.stage === 'post_verify_chain'
    ? [input.runId]
    : []
  const noForeignLiveStrategyLearningSql = input.stage === 'post_verify_chain'
    ? `NOT EXISTS (
         SELECT 1
           FROM strategy_learning_runs strategy_learning
          WHERE strategy_learning.business_date=?
            AND strategy_learning.canonical_run_id<>?
            AND strategy_learning.status IN ('running', 'success')
            AND strategy_learning.lease_owner IS NOT NULL
            AND strategy_learning.lease_expires_at >= CURRENT_TIMESTAMP
       )`
    : '1=1'
  const noForeignLiveStrategyLearningBindings = input.stage === 'post_verify_chain'
    ? [input.businessDate, input.runId]
    : []
  const inserted = await db.prepare(`
    INSERT INTO pipeline_stage_runs (
      business_date, stage, canonical_run_id, status, queued_at, updated_at
    )
    SELECT ?, ?, ?, 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     WHERE ${authoritySql}
       AND ${noForeignLiveStrategyLearningSql}
    ON CONFLICT(business_date, stage) DO NOTHING
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    input.businessDate,
    input.stage,
    input.runId,
    ...authorityBindings,
    ...noForeignLiveStrategyLearningBindings,
  ).first<PipelineStageRow>()
  if (inserted) return { shouldEnqueue: true, row: inserted }

  const transitioned = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET canonical_run_id=?, status='queued', cursor_key=NULL,
           processed_count=0, expected_count=NULL, persisted_count=0,
           attempt_count=0, lease_owner=NULL, lease_expires_at=NULL,
           queued_at=CURRENT_TIMESTAMP, started_at=NULL, completed_at=NULL,
           last_error=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=?
       AND ${authoritySql}
       ${liveStrategyLearningGuardSql}
       AND (
         (
           canonical_run_id=?
           AND (
             status IN ('waiting', 'error')
             OR (status='running' AND lease_expires_at < CURRENT_TIMESTAMP)
           )
         )
         OR (
           canonical_run_id<>?
           AND (
             status IN ('waiting', 'error', 'success')
             OR (status='running' AND lease_expires_at < CURRENT_TIMESTAMP)
           )
         )
       )
    RETURNING business_date, stage, canonical_run_id, status, cursor_key,
              processed_count, expected_count, persisted_count, attempt_count,
              lease_owner, lease_expires_at
  `).bind(
    input.runId,
    input.businessDate,
    input.stage,
    ...authorityBindings,
    ...liveStrategyLearningGuardBindings,
    input.runId,
    input.runId,
  ).first<PipelineStageRow>()
  if (transitioned) return { shouldEnqueue: true, row: transitioned }

  const row = await db.prepare(`
    SELECT business_date, stage, canonical_run_id, status, cursor_key,
           processed_count, expected_count, persisted_count, attempt_count,
           lease_owner, lease_expires_at
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage=?
  `).bind(input.businessDate, input.stage).first<PipelineStageRow>()
  if (!row) {
    throw new Error(
      `pipeline_stage_authority_rejected:${input.businessDate}:${input.stage}:${authority.canonicalRunId}`,
    )
  }
  return { shouldEnqueue: false, row }
}

export async function claimPipelineStage(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    ownerId: string
    leaseSeconds?: number
    canonicalRunId?: string
  },
): Promise<PipelineStageRow | null> {
  const canonicalRunId = input.canonicalRunId?.trim() || null
  return db.prepare(`
    UPDATE pipeline_stage_runs
       SET status='running', lease_owner=?, lease_expires_at=datetime('now', ?),
           started_at=COALESCE(started_at, CURRENT_TIMESTAMP),
           attempt_count=attempt_count+1, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=?
       AND (? IS NULL OR canonical_run_id=?)
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
    canonicalRunId,
    canonicalRunId,
  ).first<PipelineStageRow>()
}


export async function setPipelineStageCursorFenced(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    canonicalRunId: string
    leaseOwner: string
    cursorKey: string
  },
): Promise<boolean> {
  const updated = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET cursor_key=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=?
       AND canonical_run_id=?
       AND status='running'
       AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
    RETURNING cursor_key
  `).bind(
    input.cursorKey,
    input.businessDate,
    input.stage,
    input.canonicalRunId,
    input.leaseOwner,
  ).first<{ cursor_key: string }>()
  return Boolean(updated)
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
           completed_at=CASE WHEN ? IN ('success', 'error') THEN CURRENT_TIMESTAMP ELSE NULL END,
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

export async function markPipelineStageFenced(
  db: D1Database,
  input: {
    businessDate: string
    stage: string
    canonicalRunId: string
    status: Extract<PipelineStageStatus, 'waiting' | 'success' | 'error'>
    cursorKey?: string | null
    leaseOwner?: string | null
    nextCursorKey?: string | null
    expectedStatus?: PipelineStageStatus | null
    requireUnleased?: boolean
    error?: string | null
  },
): Promise<boolean> {
  const updated = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET status=?, last_error=?, lease_owner=NULL, lease_expires_at=NULL,
           cursor_key=COALESCE(?, cursor_key),
           completed_at=CASE WHEN ? IN ('success', 'error') THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND stage=? AND canonical_run_id=?
       AND (? IS NULL OR cursor_key=?)
       AND (? IS NULL OR (
         status='running' AND lease_owner=? AND lease_expires_at >= CURRENT_TIMESTAMP
       ))
       AND (? IS NULL OR status=?)
       AND (?=0 OR lease_owner IS NULL)
       AND (status<>'success' OR ?='success')
    RETURNING status
  `).bind(
    input.status,
    input.error?.slice(0, 1000) ?? null,
    input.nextCursorKey ?? null,
    input.status,
    input.businessDate,
    input.stage,
    input.canonicalRunId,
    input.cursorKey ?? null,
    input.cursorKey ?? null,
    input.leaseOwner ?? null,
    input.leaseOwner ?? null,
    input.expectedStatus ?? null,
    input.expectedStatus ?? null,
    input.requireUnleased ? 1 : 0,
    input.status,
  ).first<{ status: PipelineStageStatus }>()
  return Boolean(updated)
}

export async function queuePostPipelineStage(
  env: Pick<Bindings, 'DB' | 'UPDATE_QUEUE'> & Partial<Bindings>,
  input: {
    businessDate: string
    runId: string
    resumeWaiting?: boolean
    adoptRunIdOnResume?: boolean
    supersedeSuccess?: boolean
    expectedCanonicalRunId?: string
    authority?: PipelineStageAuthority
    attempt?: number
  },
): Promise<{ queued: boolean; canonicalRunId: string; status: PipelineStageStatus }> {
  const opsDb = databaseForDataDomain(env, 'ops')
  const state = input.authority
    ? await enqueuePipelineStageAuthorized(opsDb, {
        businessDate: input.businessDate,
        stage: 'post_pipeline_chain',
        runId: input.runId,
        authority: input.authority,
      })
    : await enqueuePipelineStage(opsDb, {
        businessDate: input.businessDate,
        stage: 'post_pipeline_chain',
        runId: input.runId,
        resumeWaiting: input.resumeWaiting,
        adoptRunIdOnResume: input.adoptRunIdOnResume,
        supersedeSuccess: input.supersedeSuccess,
        expectedCanonicalRunId: input.expectedCanonicalRunId,
      })
  if (input.expectedCanonicalRunId && state.row.canonical_run_id !== input.expectedCanonicalRunId) {
    return { queued: false, canonicalRunId: state.row.canonical_run_id, status: state.row.status }
  }
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
    await markPipelineStageFenced(opsDb, {
      businessDate: input.businessDate,
      stage: 'post_pipeline_chain',
      canonicalRunId: state.row.canonical_run_id,
      status: 'error',
      expectedStatus: 'queued',
      requireUnleased: true,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return { queued: true, canonicalRunId: state.row.canonical_run_id, status: 'queued' }
}

export async function queuePostVerifyStage(
  env: Pick<Bindings, 'DB' | 'UPDATE_QUEUE'> & Partial<Bindings>,
  input: {
    businessDate: string
    runId: string
    resumeWaiting?: boolean
    adoptRunIdOnResume?: boolean
    supersedeSuccess?: boolean
    expectedCanonicalRunId?: string
    authority?: PipelineStageAuthority
    attempt?: number
  },
): Promise<{ queued: boolean; canonicalRunId: string; status: PipelineStageStatus }> {
  const opsDb = databaseForDataDomain(env, 'ops')
  const state = input.authority
    ? await enqueuePipelineStageAuthorized(opsDb, {
        businessDate: input.businessDate,
        stage: 'post_verify_chain',
        runId: input.runId,
        authority: input.authority,
      })
    : await enqueuePipelineStage(opsDb, {
    businessDate: input.businessDate,
    stage: 'post_verify_chain',
    runId: input.runId,
    resumeWaiting: input.resumeWaiting,
    adoptRunIdOnResume: input.adoptRunIdOnResume,
    supersedeSuccess: input.supersedeSuccess,
    expectedCanonicalRunId: input.expectedCanonicalRunId,
  })
  if (input.expectedCanonicalRunId && state.row.canonical_run_id !== input.expectedCanonicalRunId) {
    return { queued: false, canonicalRunId: state.row.canonical_run_id, status: state.row.status }
  }
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
    await markPipelineStageFenced(opsDb, {
      businessDate: input.businessDate,
      stage: 'post_verify_chain',
      canonicalRunId: state.row.canonical_run_id,
      status: 'error',
      expectedStatus: 'queued',
      requireUnleased: true,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return { queued: true, canonicalRunId: state.row.canonical_run_id, status: 'queued' }
}
