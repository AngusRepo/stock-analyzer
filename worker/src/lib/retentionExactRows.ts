/** Compare archived values and delete the entire batch in one SQLite statement. */
import type { RetentionArchiveSource } from './retentionArchiveOnly'

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('retention_identifier_invalid')
  return `"${value}"`
}

export function buildExactRetentionDelete(
  source: RetentionArchiveSource,
  rows: Record<string, unknown>[],
): { sql: string; rowsJson: string } {
  if (!source.deleteTable || source.deleteKeyColumn !== 'rowid' || !rows.length || rows.length > 250) {
    throw new Error('retention_exact_delete_contract_invalid')
  }
  const table = identifier(source.deleteTable)
  const columns = Object.keys(rows[0]).filter((key) => key !== '__cursor_key' && key !== '__archive_date').sort()
  if (!columns.length) throw new Error('retention_exact_delete_empty_columns')
  const keys = new Set<number>()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.__cursor_key) || keys.has(row.__cursor_key as number)) {
      throw new Error('retention_exact_delete_row_identity_invalid')
    }
    keys.add(row.__cursor_key as number)
    if (typeof row.__archive_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.__archive_date))
      throw new Error('retention_exact_delete_date_invalid')
    const currentColumns = Object.keys(row).filter((key) => key !== '__cursor_key' && key !== '__archive_date').sort()
    if (JSON.stringify(columns) !== JSON.stringify(currentColumns)) throw new Error('retention_exact_delete_schema_changed')
    for (const key of columns) {
      const value = row[key]
      if (!(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))))) {
        throw new Error('retention_exact_delete_value_unsupported')
      }
    }
  }
  const matches = columns.map((column) => `${table}.${identifier(column)} IS json_extract(expected.value, '$.${column}')`).join(' AND ')
  // The count guard is inside the same statement: any concurrent edit, deletion,
  // eligibility change or rowid reuse prevents ALL rows in this batch deleting.
  const sql = `WITH expected AS MATERIALIZED (SELECT value FROM json_each(?)),
    matched AS MATERIALIZED (
      SELECT ${table}.rowid AS row_key FROM ${table} JOIN expected
        ON ${table}.rowid=json_extract(expected.value, '$.__cursor_key')
       WHERE ${matches}
         AND ${source.dateExpression} < ?
         AND (${source.eligibilitySql})
    )
    DELETE FROM ${table}
     WHERE rowid IN (SELECT row_key FROM matched)
       AND (SELECT COUNT(*) FROM matched)=(SELECT COUNT(*) FROM expected)
    RETURNING rowid AS deleted_key`
  const rowsJson = JSON.stringify(rows)
  if (new TextEncoder().encode(rowsJson).length > 1_900_000) throw new Error('retention_exact_delete_binding_too_large')
  return { sql, rowsJson }
}


export const RETENTION_CHUNK_MAX_BYTES = 1024 * 1024

export function buildBoundedRetentionSelect(source: RetentionArchiveSource, columns: string[]): string {
  if (!source.deleteTable || source.deleteKeyColumn !== 'rowid' || !columns.length)
    throw new Error('retention_bounded_select_contract_invalid')
  const table = identifier(source.deleteTable)
  // D1 caps SQL functions at 32 arguments; wide prediction tables exceed that.
  // Sum JSON scalar lengths instead of constructing one 76-argument json_object.
  const fields = columns.map(column => {
    const keyBytes = new TextEncoder().encode(JSON.stringify(column)).length + 2
    return `(length(CAST(json_quote(${table}.${identifier(column)}) AS BLOB))+${keyBytes})`
  }).join('+')
  return `WITH candidates AS MATERIALIZED (
    SELECT rowid AS row_key, ${source.dateExpression} AS source_date, substr(${source.dateExpression},1,10) AS archive_date,
           (${fields}) + 256 AS row_bytes
      FROM ${table} WHERE (${source.eligibilitySql}) AND ${source.dateExpression} < ?
     ORDER BY source_date,row_key LIMIT ?
  ), budgeted AS MATERIALIZED (
    SELECT *,SUM(row_bytes) OVER (ORDER BY source_date,row_key) AS total_bytes FROM candidates
  )
  SELECT ${table}.rowid AS __cursor_key,budgeted.archive_date AS __archive_date,${table}.*
    FROM budgeted JOIN ${table} ON ${table}.rowid=budgeted.row_key
   WHERE budgeted.total_bytes<=? ORDER BY budgeted.source_date,budgeted.row_key`
}
