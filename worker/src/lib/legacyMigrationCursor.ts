export type LegacyMigrationCursor = {
  task_name: string
  status: 'pending' | 'running' | 'complete' | 'error'
  cursor_date: string | null
  cursor_key: string | null
  scanned_rows: number
  archived_rows: number
}

export async function loadLegacyMigrationCursor(
  db: D1Database,
  taskName: string,
): Promise<LegacyMigrationCursor | null> {
  return db.prepare(`
    SELECT task_name, status, cursor_date, cursor_key, scanned_rows, archived_rows
      FROM legacy_migration_cursors
     WHERE task_name=?
  `).bind(taskName).first<LegacyMigrationCursor>()
}

export async function checkpointLegacyMigration(
  db: D1Database,
  input: {
    taskName: string
    status: 'running' | 'complete' | 'error'
    cursorDate?: string | null
    cursorKey?: string | null
    scannedRows?: number
    archivedRows?: number
    error?: string | null
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO legacy_migration_cursors (
      task_name, status, cursor_date, cursor_key, scanned_rows, archived_rows,
      last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task_name) DO UPDATE SET
      status=excluded.status,
      cursor_date=COALESCE(excluded.cursor_date, legacy_migration_cursors.cursor_date),
      cursor_key=COALESCE(excluded.cursor_key, legacy_migration_cursors.cursor_key),
      scanned_rows=legacy_migration_cursors.scanned_rows+excluded.scanned_rows,
      archived_rows=legacy_migration_cursors.archived_rows+excluded.archived_rows,
      last_error=excluded.last_error,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    input.taskName,
    input.status,
    input.cursorDate ?? null,
    input.cursorKey ?? null,
    Math.max(0, Math.floor(input.scannedRows ?? 0)),
    Math.max(0, Math.floor(input.archivedRows ?? 0)),
    input.error?.slice(0, 1000) ?? null,
  ).run()
}
