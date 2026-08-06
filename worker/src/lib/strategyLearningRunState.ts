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
}

type UniverseRow = {
  producer_run_id: string | null
  expected_candidates: number
}

export async function inspectCanonicalStrategyUniverse(
  db: D1Database,
  businessDate: string,
): Promise<UniverseRow> {
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
  input: { businessDate: string; runId: string; strategyCount: number },
): Promise<StrategyLearningRunRow> {
  const universe = await inspectCanonicalStrategyUniverse(db, input.businessDate)
  if (!universe.producer_run_id || universe.expected_candidates <= 0) {
    throw new Error(`strategy_learning_reference_universe_missing:${input.businessDate}`)
  }
  const expectedRows = universe.expected_candidates * Math.max(0, Math.floor(input.strategyCount))
  await db.prepare(`
    INSERT INTO strategy_learning_runs (
      business_date, canonical_run_id, producer_run_id, status,
      expected_candidates, strategy_count, expected_decision_rows, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, CURRENT_TIMESTAMP)
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
  `).bind(
    input.businessDate,
    input.runId,
    universe.producer_run_id,
    universe.expected_candidates,
    input.strategyCount,
    expectedRows,
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
           lease_owner, lease_expires_at, completed_at
      FROM strategy_learning_runs
     WHERE business_date=?
  `).bind(businessDate).first<StrategyLearningRunRow>()
}

export async function claimStrategyLearningPage(
  db: D1Database,
  input: { businessDate: string; runId: string; cursorSymbol: string; leaseSeconds?: number },
): Promise<StrategyLearningRunRow | null> {
  const modifier = `+${Math.max(30, Math.floor(input.leaseSeconds ?? 300))} seconds`
  return db.prepare(`
    UPDATE strategy_learning_runs
       SET status='running', lease_owner=?, lease_expires_at=datetime('now', ?),
           attempt_count=attempt_count+1, updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=?
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
              lease_owner, lease_expires_at, completed_at
  `).bind(
    input.runId,
    modifier,
    input.businessDate,
    input.cursorSymbol,
    input.runId,
  ).first<StrategyLearningRunRow>()
}

export async function checkpointStrategyLearningPage(
  db: D1Database,
  input: {
    businessDate: string
    runId: string
    previousCursor: string
    nextCursor: string
    processedCandidates: number
    persistedRows: number
  },
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='queued', cursor_symbol=?,
           processed_candidates=processed_candidates+?,
           persisted_decision_rows=persisted_decision_rows+?,
           lease_owner=NULL, lease_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND COALESCE(cursor_symbol, '')=?
  `).bind(
    input.nextCursor,
    input.processedCandidates,
    input.persistedRows,
    input.businessDate,
    input.runId,
    input.previousCursor,
  ).run()
  return Number(result.meta?.changes ?? 0) === 1
}

export async function completeStrategyLearningRun(
  db: D1Database,
  input: { businessDate: string; runId: string },
): Promise<{ candidateRows: number; decisionRows: number; expectedCandidates: number; expectedRows: number }> {
  const state = await loadStrategyLearningRun(db, input.businessDate)
  if (!state) throw new Error(`strategy_learning_run_missing:${input.businessDate}`)
  const expectedCandidates = Math.max(0, Number(state.expected_candidates ?? 0))
  const expectedRows = Math.max(0, Number(state.expected_decision_rows ?? 0))
  const priorCanonicalSuccess = state.status === 'success' && Boolean(state.completed_at)
    && Math.max(0, Number(state.processed_candidates ?? 0)) === expectedCandidates
    && Math.max(0, Number(state.persisted_decision_rows ?? 0)) === expectedRows
  if (priorCanonicalSuccess) {
    await db.prepare(`
      UPDATE strategy_learning_runs
         SET status='success', lease_owner=NULL, lease_expires_at=NULL,
             updated_at=CURRENT_TIMESTAMP, last_error=NULL
       WHERE business_date=? AND canonical_run_id=?
    `).bind(input.businessDate, state.canonical_run_id).run()
    return {
      candidateRows: expectedCandidates,
      decisionRows: expectedRows,
      expectedCandidates,
      expectedRows,
    }
  }
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
    await failStrategyLearningRun(db, { businessDate: input.businessDate, error })
    throw new Error(error)
  }
  await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='running', processed_candidates=?, persisted_decision_rows=?,
           lease_owner=?, lease_expires_at=datetime('now', '+300 seconds'), completed_at=NULL,
           updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=? AND canonical_run_id=?
  `).bind(
    candidateRows, decisionRows, input.runId, input.businessDate, state.canonical_run_id,
  ).run()
  return { candidateRows, decisionRows, expectedCandidates, expectedRows }
}

export async function markStrategyLearningRunFinalized(
  db: D1Database,
  input: { businessDate: string; runId: string },
): Promise<void> {
  const result = await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='success', lease_owner=NULL, lease_expires_at=NULL,
           completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, last_error=NULL
     WHERE business_date=? AND canonical_run_id=?
       AND processed_candidates=expected_candidates
       AND persisted_decision_rows=expected_decision_rows
  `).bind(input.businessDate, input.runId).run()
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error(`strategy_learning_finalize_state_conflict:${input.businessDate}`)
  }
}

export async function deferStrategyLearningFinalizer(
  db: D1Database,
  input: { businessDate: string; runId: string; error: string },
): Promise<void> {
  await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='queued', lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL,
           last_error=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=? AND canonical_run_id=?
       AND processed_candidates=expected_candidates
       AND persisted_decision_rows=expected_decision_rows
  `).bind(input.error.slice(0, 1000), input.businessDate, input.runId).run()
}

export async function failStrategyLearningRun(
  db: D1Database,
  input: { businessDate: string; error: string },
): Promise<void> {
  await db.prepare(`
    UPDATE strategy_learning_runs
       SET status='error', lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL,
           last_error=?, updated_at=CURRENT_TIMESTAMP
     WHERE business_date=?
  `).bind(input.error.slice(0, 1000), input.businessDate).run()
}
