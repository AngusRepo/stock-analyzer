export type StrategyLearningRunRow = {
  business_date: string
  canonical_run_id: string
  producer_run_id: string | null
  status: 'queued' | 'running' | 'success' | 'error'
  cursor_symbol: string | null
  expected_candidates: number | null
  processed_candidates: number
  strategy_count: number | null
  expected_decision_rows: number | null
  persisted_decision_rows: number
  lease_owner: string | null
  lease_expires_at: string | null
  completed_at: string | null
  production_authority_intent: number
  policy_closure_status: 'pending' | 'materialized' | 'evidence_only'
  policy_closure_reason: string | null
  policy_closure_completed_at: string | null
}

export const STRATEGY_LEARNING_LEASE_SECONDS = 900

export type StrategyLearningLeaseIdentity = {
  businessDate: string
  canonicalRunId: string
  leaseOwner: string
}

const STRATEGY_LEARNING_LEASE_LOST_PREFIX = 'strategy_learning_lease_lost:'

export function isStrategyLearningLeaseLost(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error)
  return reason.startsWith(STRATEGY_LEARNING_LEASE_LOST_PREFIX)
}

function strategyLearningLeaseLost(input: StrategyLearningLeaseIdentity): Error {
  return new Error(`${STRATEGY_LEARNING_LEASE_LOST_PREFIX}${input.businessDate}:${input.canonicalRunId}:${input.leaseOwner}`)
}

type UniverseRow = {
  producer_run_id: string | null
  expected_candidates: number
}

export async function inspectCanonicalStrategyUniverse(
  db: D1Database,
  businessDate: string,
  canonicalProducerRunId?: string | null,
): Promise<UniverseRow> {
  if (canonicalProducerRunId) {
    const row = await db.prepare(`
      SELECT ? AS producer_run_id, COUNT(*) AS expected_candidates
        FROM selection_reference_snapshots_v1
       WHERE signal_date=?
         AND producer_run_id=?
         AND hard_gate_passed=1
         AND strategy_labeled=1
         AND strategy_matrix_status='ready'
    `).bind(canonicalProducerRunId, businessDate, canonicalProducerRunId).first<UniverseRow>()
    return {
      producer_run_id: canonicalProducerRunId,
      expected_candidates: Math.max(0, Number(row?.expected_candidates ?? 0)),
    }
  }
  const row = await db.prepare(`
    SELECT MAX(r.producer_run_id) AS producer_run_id,
           COUNT(*) AS expected_candidates
      FROM selection_reference_snapshots_v1 r
     WHERE r.signal_date=?
       AND r.hard_gate_passed=1
       AND r.strategy_labeled=1
       AND r.strategy_matrix_status='ready'
       AND EXISTS (
         SELECT 1
           FROM canonical_run_heads h
          WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
            AND h.run_id=r.producer_run_id
       )
  `).bind(businessDate).first<UniverseRow>()
  return {
    producer_run_id: row?.producer_run_id ?? null,
    expected_candidates: Math.max(0, Number(row?.expected_candidates ?? 0)),
  }
}

export async function initializeStrategyLearningRun(
  db: D1Database,
  input: {
    businessDate: string
    runId: string
    strategyCount: number
    universeDb?: D1Database
    canonicalProducerRunId?: string | null
    productionAuthorityIntent?: boolean
  },
): Promise<StrategyLearningRunRow> {
  const universe = await inspectCanonicalStrategyUniverse(
    input.universeDb ?? db, input.businessDate, input.canonicalProducerRunId,
  )
  if (!universe.producer_run_id || universe.expected_candidates <= 0) {
    throw new Error(`strategy_learning_reference_universe_missing:${input.businessDate}`)
  }
  const expectedRows = universe.expected_candidates * Math.max(0, Math.floor(input.strategyCount))
  await db.prepare(`
    INSERT INTO strategy_learning_runs (
      business_date, canonical_run_id, producer_run_id, status,
      expected_candidates, strategy_count, expected_decision_rows,
      production_authority_intent, policy_closure_status, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    ON CONFLICT(business_date) DO UPDATE SET
      canonical_run_id=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id
          THEN excluded.canonical_run_id
        WHEN strategy_learning_runs.status='error' THEN excluded.canonical_run_id
        ELSE strategy_learning_runs.canonical_run_id
      END,
      producer_run_id=excluded.producer_run_id,
      status=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN 'queued'
        WHEN strategy_learning_runs.status='error' THEN 'queued'
        ELSE strategy_learning_runs.status
      END,
      cursor_symbol=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN NULL
        WHEN strategy_learning_runs.status='error' THEN NULL
        ELSE strategy_learning_runs.cursor_symbol
      END,
      processed_candidates=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN 0
        WHEN strategy_learning_runs.status='error' THEN 0
        ELSE strategy_learning_runs.processed_candidates
      END,
      persisted_decision_rows=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN 0
        WHEN strategy_learning_runs.status='error' THEN 0
        ELSE strategy_learning_runs.persisted_decision_rows
      END,
      expected_candidates=excluded.expected_candidates,
      strategy_count=excluded.strategy_count,
      expected_decision_rows=excluded.expected_decision_rows,
      production_authority_intent=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id
          THEN excluded.production_authority_intent
        ELSE MAX(strategy_learning_runs.production_authority_intent, excluded.production_authority_intent)
      END,
      policy_closure_status=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN 'pending'
        WHEN strategy_learning_runs.status='error' THEN 'pending'
        ELSE strategy_learning_runs.policy_closure_status
      END,
      policy_closure_reason=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN NULL
        WHEN strategy_learning_runs.status='error' THEN NULL
        ELSE strategy_learning_runs.policy_closure_reason
      END,
      policy_closure_completed_at=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN NULL
        WHEN strategy_learning_runs.status='error' THEN NULL
        ELSE strategy_learning_runs.policy_closure_completed_at
      END,
      lease_owner=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN NULL
        WHEN strategy_learning_runs.status='error' THEN NULL
        ELSE strategy_learning_runs.lease_owner
      END,
      lease_expires_at=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN NULL
        WHEN strategy_learning_runs.status='error' THEN NULL
        ELSE strategy_learning_runs.lease_expires_at
      END,
      completed_at=CASE
        WHEN strategy_learning_runs.producer_run_id IS NOT excluded.producer_run_id THEN NULL
        ELSE strategy_learning_runs.completed_at
      END,
      updated_at=CURRENT_TIMESTAMP
    WHERE strategy_learning_runs.status<>'success'
  `).bind(
    input.businessDate,
    input.runId,
    universe.producer_run_id,
    universe.expected_candidates,
    input.strategyCount,
    expectedRows,
    input.productionAuthorityIntent ? 1 : 0,
  ).run()
  const row = await loadStrategyLearningRun(db, input.businessDate)
  if (!row) throw new Error(`strategy_learning_run_init_failed:${input.businessDate}`)
  return row
}

export async function loadStrategyLearningRun(
  db: D1Database,
  businessDate: string,
): Promise<StrategyLearningRunRow | null> {
  return db.prepare(`
    SELECT business_date, canonical_run_id, producer_run_id, status, cursor_symbol,
           expected_candidates, processed_candidates, strategy_count,
           expected_decision_rows, persisted_decision_rows,
           lease_owner, lease_expires_at, completed_at,
           production_authority_intent, policy_closure_status,
           policy_closure_reason, policy_closure_completed_at
      FROM strategy_learning_runs
     WHERE business_date=?
  `).bind(businessDate).first<StrategyLearningRunRow>()
}

export async function claimStrategyLearningPage(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { cursorSymbol: string; leaseSeconds?: number },
): Promise<StrategyLearningRunRow | null> {
  const modifier = `+${Math.max(30, Math.floor(input.leaseSeconds ?? STRATEGY_LEARNING_LEASE_SECONDS))} seconds`
  return db.prepare(`
    UPDATE strategy_learning_runs
       SET status='running', lease_owner=?, lease_expires_at=datetime('now', ?),
           attempt_count=attempt_count+1, updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=? AND canonical_run_id=?
       AND status IN ('queued', 'running')
       AND COALESCE(cursor_symbol, '')=?
       AND (
         lease_owner IS NULL
         OR lease_expires_at < CURRENT_TIMESTAMP
         OR lease_owner=?
       )
    RETURNING business_date, canonical_run_id, producer_run_id, status, cursor_symbol,
              expected_candidates, processed_candidates, strategy_count,
              expected_decision_rows, persisted_decision_rows,
              lease_owner, lease_expires_at, completed_at,
              production_authority_intent, policy_closure_status,
              policy_closure_reason, policy_closure_completed_at
  `).bind(
    input.leaseOwner,
    modifier,
    input.businessDate,
    input.canonicalRunId,
    input.cursorSymbol,
    input.leaseOwner,
  ).first<StrategyLearningRunRow>()
}

export async function heartbeatStrategyLearningLease(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { leaseSeconds?: number },
): Promise<boolean> {
  const modifier = `+${Math.max(30, Math.floor(input.leaseSeconds ?? STRATEGY_LEARNING_LEASE_SECONDS))} seconds`
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET lease_expires_at=datetime('now', ?), updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status IN ('running', 'success') AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
    RETURNING 1 AS renewed
  `).bind(
    modifier,
    input.businessDate,
    input.canonicalRunId,
    input.leaseOwner,
  ).first<{ renewed: number }>()
  return Number(row?.renewed ?? 0) === 1
}

export async function assertStrategyLearningLease(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { leaseSeconds?: number },
): Promise<void> {
  if (!(await heartbeatStrategyLearningLease(db, input))) {
    throw strategyLearningLeaseLost(input)
  }
}

type StrategyLearningHeartbeatTimer = number

export type StrategyLearningLeaseHeartbeatController = {
  assertActive: () => Promise<void>
  stop: () => Promise<void>
  leaseError: () => Error | null
}

export function startStrategyLearningLeaseHeartbeat(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { leaseSeconds?: number },
  options: {
    intervalMs?: number
    heartbeat?: () => Promise<boolean>
    setIntervalFn?: (callback: () => void, intervalMs: number) => StrategyLearningHeartbeatTimer
    clearIntervalFn?: (timer: StrategyLearningHeartbeatTimer) => void
  } = {},
): StrategyLearningLeaseHeartbeatController {
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? 60_000))
  const heartbeat = options.heartbeat
    ?? (() => heartbeatStrategyLearningLease(db, input))
  const setIntervalFn = options.setIntervalFn
    ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs) as unknown as number)
  const clearIntervalFn = options.clearIntervalFn
    ?? ((timer) => globalThis.clearInterval(timer))
  let stopped = false
  let lostError: Error | null = null
  let heartbeatInFlight: Promise<void> | null = null

  const pulse = (): Promise<void> => {
    if (lostError) return Promise.reject(lostError)
    if (heartbeatInFlight) return heartbeatInFlight
    const current = (async () => {
      try {
        if (!(await heartbeat())) throw strategyLearningLeaseLost(input)
      } catch (error) {
        lostError = isStrategyLearningLeaseLost(error)
          ? error as Error
          : strategyLearningLeaseLost(input)
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
      if (stopped) throw strategyLearningLeaseLost(input)
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

export async function checkpointStrategyLearningPage(
  db: D1Database,
  input: {
    businessDate: string
    canonicalRunId: string
    leaseOwner: string
    previousCursor: string
    nextCursor: string
    processedCandidates: number
    persistedRows: number
  },
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='queued', cursor_symbol=?,
           processed_candidates=processed_candidates+?,
           persisted_decision_rows=persisted_decision_rows+?,
           lease_owner=NULL, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
       AND COALESCE(cursor_symbol, '')=?
    RETURNING 1 AS checkpointed
  `).bind(
    input.nextCursor,
    input.processedCandidates,
    input.persistedRows,
    input.businessDate,
    input.canonicalRunId,
    input.leaseOwner,
    input.previousCursor,
  ).first<{ checkpointed: number }>()
  return Number(row?.checkpointed ?? 0) === 1
}

export async function completeStrategyLearningRun(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { leaseSeconds?: number },
): Promise<{ candidateRows: number; decisionRows: number; expectedCandidates: number; expectedRows: number } | null> {
  const state = await loadStrategyLearningRun(db, input.businessDate)
  if (!state) throw new Error(`strategy_learning_run_missing:${input.businessDate}`)
  if (
    state.canonical_run_id !== input.canonicalRunId
    || state.status !== 'running'
    || state.lease_owner !== input.leaseOwner
  ) return null
  const expectedCandidates = Math.max(0, Number(state.expected_candidates ?? 0))
  const expectedRows = Math.max(0, Number(state.expected_decision_rows ?? 0))
  const durableCoverageComplete = expectedCandidates > 0
    && expectedRows > 0
    && Boolean(state.cursor_symbol)
    && Math.max(0, Number(state.processed_candidates ?? 0)) === expectedCandidates
    && Math.max(0, Number(state.persisted_decision_rows ?? 0)) === expectedRows
  let candidateRows = Math.max(0, Number(state.processed_candidates ?? 0))
  let decisionRows = Math.max(0, Number(state.persisted_decision_rows ?? 0))
  if (!durableCoverageComplete) {
    const coverage = await db.prepare(`
      SELECT COUNT(DISTINCT d.symbol) AS candidate_rows,
             COUNT(*) AS decision_rows
        FROM strategy_decision_log d
        JOIN strategy_spec_registry s
          ON s.strategy_id=d.strategy_id AND s.version=d.strategy_version
       WHERE d.date=? AND s.status <> 'retired'
    `).bind(input.businessDate).first<{ candidate_rows: number; decision_rows: number }>()
    candidateRows = Math.max(0, Number(coverage?.candidate_rows ?? 0))
    decisionRows = Math.max(0, Number(coverage?.decision_rows ?? 0))
  }
  if (candidateRows !== expectedCandidates || decisionRows !== expectedRows) {
    const error = `strategy_learning_incomplete:candidates=${candidateRows}/${expectedCandidates}:rows=${decisionRows}/${expectedRows}`
    throw new Error(error)
  }
  const modifier = `+${Math.max(30, Math.floor(input.leaseSeconds ?? STRATEGY_LEARNING_LEASE_SECONDS))} seconds`
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='running', processed_candidates=?, persisted_decision_rows=?,
            lease_expires_at=datetime('now', ?), completed_at=NULL,
           updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
    RETURNING 1 AS completed
  `).bind(
    candidateRows, decisionRows, modifier, input.businessDate, input.canonicalRunId, input.leaseOwner,
  ).first<{ completed: number }>()
  if (Number(row?.completed ?? 0) !== 1) return null
  return { candidateRows, decisionRows, expectedCandidates, expectedRows }
}

export async function markStrategyLearningRunFinalized(
  db: D1Database,
  input: StrategyLearningLeaseIdentity,
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='success', completed_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
       AND processed_candidates=expected_candidates
       AND persisted_decision_rows=expected_decision_rows
       AND policy_closure_status IN ('materialized', 'evidence_only')
       AND (
         production_authority_intent=0
         OR policy_closure_status='materialized'
       )
       AND EXISTS (
         SELECT 1
           FROM pipeline_stage_runs p
          WHERE p.business_date=strategy_learning_runs.business_date
            AND p.stage='post_verify_chain'
            AND p.canonical_run_id=strategy_learning_runs.canonical_run_id
            AND p.status IN ('running', 'waiting', 'success')
       )
    RETURNING 1 AS finalized
  `).bind(input.businessDate, input.canonicalRunId, input.leaseOwner).first<{ finalized: number }>()
  return Number(row?.finalized ?? 0) === 1
}

export async function recordStrategyLearningPolicyClosure(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & {
    status: 'materialized' | 'evidence_only'
    reason: string
  },
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET policy_closure_status=?, policy_closure_reason=?,
           policy_closure_completed_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
       AND processed_candidates=expected_candidates
       AND persisted_decision_rows=expected_decision_rows
       AND (
         production_authority_intent=0
         OR ?='materialized'
       )
    RETURNING 1 AS recorded
  `).bind(
    input.status,
    input.reason.slice(0, 1000),
    input.businessDate,
    input.canonicalRunId,
    input.leaseOwner,
    input.status,
  ).first<{ recorded: number }>()
  return Number(row?.recorded ?? 0) === 1
}

export async function closeStrategyLearningPostVerifyStage(
  db: D1Database,
  input: Pick<StrategyLearningLeaseIdentity, 'businessDate' | 'canonicalRunId'>,
): Promise<boolean> {
  const alreadyClosed = await db.prepare(`
    SELECT 1 AS closed
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='post_verify_chain'
       AND canonical_run_id=? AND status='success'
       AND EXISTS (
         SELECT 1
           FROM strategy_learning_runs strategy_learning
          WHERE strategy_learning.business_date=pipeline_stage_runs.business_date
            AND strategy_learning.canonical_run_id=pipeline_stage_runs.canonical_run_id
            AND strategy_learning.status='success'
            AND strategy_learning.production_authority_intent=1
            AND strategy_learning.policy_closure_status='materialized'
       )
     LIMIT 1
  `).bind(input.businessDate, input.canonicalRunId).first<{ closed: number }>()
  if (Number(alreadyClosed?.closed ?? 0) === 1) return true

  const row = await db.prepare(`
    UPDATE pipeline_stage_runs
       SET status='success', completed_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=? AND stage='post_verify_chain'
       AND canonical_run_id=? AND status='waiting'
       AND lease_owner IS NULL
       AND EXISTS (
         SELECT 1
           FROM strategy_learning_runs strategy_learning
          WHERE strategy_learning.business_date=pipeline_stage_runs.business_date
            AND strategy_learning.canonical_run_id=pipeline_stage_runs.canonical_run_id
            AND strategy_learning.status='success'
            AND strategy_learning.production_authority_intent=1
            AND strategy_learning.policy_closure_status='materialized'
       )
    RETURNING 1 AS closed
  `).bind(input.businessDate, input.canonicalRunId).first<{ closed: number }>()
  return Number(row?.closed ?? 0) === 1
}

export async function hasStrategyLearningPostVerifyAuthority(
  db: D1Database,
  input: Pick<StrategyLearningLeaseIdentity, 'businessDate' | 'canonicalRunId'>,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS authorized
      FROM pipeline_stage_runs
     WHERE business_date=?
       AND stage='post_verify_chain'
       AND canonical_run_id=?
       AND status IN ('running', 'waiting', 'success')
     LIMIT 1
  `).bind(input.businessDate, input.canonicalRunId).first<{ authorized: number }>()
  return Number(row?.authorized ?? 0) === 1
}

export async function adoptStrategyLearningPostVerifyAuthority(
  db: D1Database,
  input: Pick<StrategyLearningLeaseIdentity, 'businessDate' | 'canonicalRunId'>,
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET canonical_run_id=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=?
       AND canonical_run_id<>?
       AND status='queued'
       AND lease_owner IS NULL AND lease_expires_at IS NULL
       AND expected_candidates>0
       AND processed_candidates=expected_candidates
       AND expected_decision_rows>0
       AND persisted_decision_rows=expected_decision_rows
       AND last_error LIKE 'strategy_learning_finalize_authority_lost:%'
       AND EXISTS (
         SELECT 1
           FROM pipeline_stage_runs p
          WHERE p.business_date=strategy_learning_runs.business_date
            AND p.stage='post_verify_chain'
            AND p.canonical_run_id=?
            AND p.status IN ('running', 'waiting', 'success')
       )
    RETURNING 1 AS adopted
  `).bind(
    input.canonicalRunId,
    input.businessDate,
    input.canonicalRunId,
    input.canonicalRunId,
  ).first<{ adopted: number }>()
  return Number(row?.adopted ?? 0) === 1
}

export async function reclaimStrategyLearningFinalizedLease(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { leaseSeconds?: number },
): Promise<boolean> {
  const modifier = `+${Math.max(30, Math.floor(input.leaseSeconds ?? STRATEGY_LEARNING_LEASE_SECONDS))} seconds`
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET lease_expires_at=datetime('now', ?), updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status='success' AND completed_at IS NOT NULL
       AND lease_owner IS NOT NULL AND lease_owner=?
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < CURRENT_TIMESTAMP
       AND EXISTS (
         SELECT 1
           FROM pipeline_stage_runs p
          WHERE p.business_date=strategy_learning_runs.business_date
            AND p.stage='post_verify_chain'
            AND p.canonical_run_id=strategy_learning_runs.canonical_run_id
            AND p.status IN ('running', 'waiting', 'success')
       )
    RETURNING 1 AS reclaimed
  `).bind(
    modifier,
    input.businessDate,
    input.canonicalRunId,
    input.leaseOwner,
  ).first<{ reclaimed: number }>()
  return Number(row?.reclaimed ?? 0) === 1
}

export async function releaseStrategyLearningFinalizedLease(
  db: D1Database,
  input: StrategyLearningLeaseIdentity,
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET lease_owner=NULL, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status='success' AND completed_at IS NOT NULL
       AND lease_owner=? AND lease_expires_at >= CURRENT_TIMESTAMP
       AND EXISTS (
         SELECT 1
           FROM pipeline_stage_runs p
          WHERE p.business_date=strategy_learning_runs.business_date
            AND p.stage='post_verify_chain'
            AND p.canonical_run_id=strategy_learning_runs.canonical_run_id
            AND p.status IN ('running', 'waiting', 'success')
       )
    RETURNING 1 AS released
  `).bind(input.businessDate, input.canonicalRunId, input.leaseOwner).first<{ released: number }>()
  return Number(row?.released ?? 0) === 1
}

export async function deferStrategyLearningFinalizer(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { error: string },
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='queued', lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL,
           policy_closure_status='pending', policy_closure_reason=?,
           policy_closure_completed_at=NULL, last_error=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
       AND processed_candidates=expected_candidates
       AND persisted_decision_rows=expected_decision_rows
    RETURNING 1 AS deferred
  `).bind(
    input.error.slice(0, 1000), input.error.slice(0, 1000),
    input.businessDate, input.canonicalRunId, input.leaseOwner,
  ).first<{ deferred: number }>()
  return Number(row?.deferred ?? 0) === 1
}

export async function failStrategyLearningRun(
  db: D1Database,
  input: StrategyLearningLeaseIdentity & { error: string },
): Promise<boolean> {
  const row = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='error', lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL,
           policy_closure_status='pending', policy_closure_reason=?,
           policy_closure_completed_at=NULL, last_error=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND status='running' AND lease_owner=?
       AND lease_expires_at >= CURRENT_TIMESTAMP
    RETURNING 1 AS failed
  `).bind(
    input.error.slice(0, 1000), input.error.slice(0, 1000),
    input.businessDate, input.canonicalRunId, input.leaseOwner,
  ).first<{ failed: number }>()
  return Number(row?.failed ?? 0) === 1
}
