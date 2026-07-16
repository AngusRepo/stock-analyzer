const D1_BATCH_ALLOWED_DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

export function normalizeD1BatchStatement(raw: any, index: number) {
  const rawSql = typeof raw?.sql === 'string' ? raw.sql.trim() : ''
  if (!rawSql) throw new Error(`statement ${index}: sql is required`)

  // D1 accepts a trailing statement delimiter. Remove only terminal delimiters;
  // any remaining semicolon still represents an unsafe multi-statement payload.
  const sql = rawSql.replace(/;+\s*$/, '').trim()
  if (!sql) throw new Error(`statement ${index}: sql is required`)
  if (sql.includes(';')) throw new Error(`statement ${index}: multiple SQL statements are not allowed`)

  const verb = sql.split(/\s+/, 1)[0]?.toUpperCase()
  if (!D1_BATCH_ALLOWED_DML.has(verb)) {
    throw new Error(`statement ${index}: only INSERT/UPDATE/DELETE/REPLACE are allowed`)
  }

  const params = Array.isArray(raw?.params) ? raw.params : []
  return { sql, params }
}
