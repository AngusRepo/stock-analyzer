export type RetentionCursor = {
  policy_id: string
  dataset_id: string
  status: 'pending' | 'running' | 'cycle_complete' | 'error'
  cursor_date: string | null
  cursor_key: string | null
  cycle: number
  backlog_remaining: boolean
}

function nonNegativeInt(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

export async function beginRetentionRun(
  db: D1Database,
  input: { runId: string; policyId: string; businessDate: string },
): Promise<void> {
  await db.prepare(`
    INSERT INTO data_retention_runs(run_id, policy_id, business_date, status)
    VALUES (?, ?, ?, 'running')
    ON CONFLICT(run_id) DO UPDATE SET
      status='running', last_error=NULL, completed_at=NULL
  `).bind(input.runId, input.policyId, input.businessDate).run()
}

export async function loadRetentionCursor(
  db: D1Database,
  policyId: string,
  datasetId: string,
): Promise<RetentionCursor | null> {
  const row = await db.prepare(`
    SELECT policy_id, dataset_id, status, cursor_date, cursor_key, cycle, backlog_remaining
      FROM data_retention_cursors
     WHERE policy_id=? AND dataset_id=?
  `).bind(policyId, datasetId).first<Record<string, unknown>>()
  if (!row) return null
  return {
    policy_id: String(row.policy_id),
    dataset_id: String(row.dataset_id),
    status: String(row.status) as RetentionCursor['status'],
    cursor_date: row.cursor_date == null ? null : String(row.cursor_date),
    cursor_key: row.cursor_key == null ? null : String(row.cursor_key),
    cycle: nonNegativeInt(row.cycle),
    backlog_remaining: Number(row.backlog_remaining ?? 0) === 1,
  }
}

export async function checkpointRetentionItem(
  db: D1Database,
  input: {
    runId: string
    policyId: string
    datasetId: string
    status: 'success' | 'error' | 'skipped'
    scannedRows?: number
    archivedRows?: number
    scrubbedRows?: number
    deletedRows?: number
    archivedBytes?: number
    cursorDate?: string | null
    cursorKey?: string | number | null
    backlogRemaining: boolean
    cycleComplete?: boolean
    evidence?: Record<string, unknown>
    error?: string | null
  },
): Promise<void> {
  const scannedRows = nonNegativeInt(input.scannedRows)
  const archivedRows = nonNegativeInt(input.archivedRows)
  const scrubbedRows = nonNegativeInt(input.scrubbedRows)
  const deletedRows = nonNegativeInt(input.deletedRows)
  const archivedBytes = nonNegativeInt(input.archivedBytes)
  const cursorDate = input.cursorDate ?? null
  const cursorKey = input.cursorKey == null ? null : String(input.cursorKey)
  const cursorStatus = input.status === 'error'
    ? 'error'
    : input.cycleComplete
      ? 'cycle_complete'
      : 'running'

  await db.batch([
    db.prepare(`
      INSERT INTO data_retention_run_items(
        run_id, dataset_id, status, scanned_rows, archived_rows, scrubbed_rows,
        deleted_rows, archived_bytes, cursor_date, cursor_key, backlog_remaining,
        evidence_json, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id,dataset_id) DO UPDATE SET
        status=excluded.status, scanned_rows=excluded.scanned_rows,
        archived_rows=excluded.archived_rows, scrubbed_rows=excluded.scrubbed_rows,
        deleted_rows=excluded.deleted_rows, archived_bytes=excluded.archived_bytes,
        cursor_date=excluded.cursor_date, cursor_key=excluded.cursor_key,
        backlog_remaining=excluded.backlog_remaining, evidence_json=excluded.evidence_json,
        last_error=excluded.last_error, completed_at=CURRENT_TIMESTAMP
    `).bind(
      input.runId, input.datasetId, input.status, scannedRows, archivedRows, scrubbedRows,
      deletedRows, archivedBytes, cursorDate, cursorKey, input.backlogRemaining ? 1 : 0,
      JSON.stringify(input.evidence ?? {}), input.error?.slice(0, 1000) ?? null,
    ),
    db.prepare(`
      INSERT INTO data_retention_cursors(
        policy_id, dataset_id, status, cursor_date, cursor_key, cycle,
        scanned_rows, archived_rows, scrubbed_rows, deleted_rows,
        backlog_remaining, last_run_id, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(policy_id,dataset_id) DO UPDATE SET
        status=excluded.status,
        cursor_date=CASE WHEN excluded.status='cycle_complete' THEN NULL ELSE excluded.cursor_date END,
        cursor_key=CASE WHEN excluded.status='cycle_complete' THEN NULL ELSE excluded.cursor_key END,
        cycle=data_retention_cursors.cycle + CASE WHEN excluded.status='cycle_complete' THEN 1 ELSE 0 END,
        scanned_rows=data_retention_cursors.scanned_rows+excluded.scanned_rows,
        archived_rows=data_retention_cursors.archived_rows+excluded.archived_rows,
        scrubbed_rows=data_retention_cursors.scrubbed_rows+excluded.scrubbed_rows,
        deleted_rows=data_retention_cursors.deleted_rows+excluded.deleted_rows,
        backlog_remaining=excluded.backlog_remaining,
        last_run_id=excluded.last_run_id, last_error=excluded.last_error,
        updated_at=CURRENT_TIMESTAMP
    `).bind(
      input.policyId, input.datasetId, cursorStatus, cursorDate, cursorKey,
      input.cycleComplete ? 1 : 0, scannedRows, archivedRows, scrubbedRows, deletedRows,
      input.backlogRemaining ? 1 : 0, input.runId, input.error?.slice(0, 1000) ?? null,
    ),
  ])
}

export async function finishRetentionRun(
  db: D1Database,
  input: {
    runId: string
    status: 'success' | 'error' | 'skipped'
    scannedRows?: number
    archivedRows?: number
    scrubbedRows?: number
    deletedRows?: number
    archivedBytes?: number
    error?: string | null
  },
): Promise<void> {
  await db.prepare(`
    UPDATE data_retention_runs
       SET status=?, scanned_rows=?, archived_rows=?, scrubbed_rows=?, deleted_rows=?,
           archived_bytes=?, last_error=?, completed_at=CURRENT_TIMESTAMP
     WHERE run_id=?
  `).bind(
    input.status,
    nonNegativeInt(input.scannedRows),
    nonNegativeInt(input.archivedRows),
    nonNegativeInt(input.scrubbedRows),
    nonNegativeInt(input.deletedRows),
    nonNegativeInt(input.archivedBytes),
    input.error?.slice(0, 1000) ?? null,
    input.runId,
  ).run()
}
