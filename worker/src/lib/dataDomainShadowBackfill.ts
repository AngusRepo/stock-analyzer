import type { Bindings } from '../types'
import { dataDomainForTable, shadowDatabaseForDataDomain, tablesForDataDomain, type DataDomain } from './dataDomainRegistry'

export const DATA_DOMAIN_SHADOW_SCHEMA_VERSION = 'data-domain-shadow-backfill-v1'

interface TableColumn {
  cid: number
  name: string
  type: string
  notnull: number
  pk: number
}

export interface DomainShadowBackfillResult {
  domain: DataDomain
  table: string
  status: 'shadow_progress' | 'shadow_table_complete'
  source_rows: number
  target_rows: number
  batch_rows: number
  batch_checksum: string | null
  cursor: unknown[] | null
  domain_tables_completed?: number
  domain_tables_total?: number
  domain_shadow_ready?: boolean
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid_sql_identifier:${value}`)
  return `"${value}"`
}

function canonicalRows(rows: Record<string, unknown>[], columns: string[]): string {
  return JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))))
}

async function checksumRows(rows: Record<string, unknown>[], columns: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalRows(rows, columns)),
  )
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function tableColumns(db: D1Database, table: string): Promise<TableColumn[]> {
  const result = await db.prepare(`PRAGMA table_info(${identifier(table)})`).all<TableColumn>()
  return (result.results ?? []).sort((left, right) => Number(left.cid) - Number(right.cid))
}

function assertSchemaParity(source: TableColumn[], target: TableColumn[], table: string): void {
  if (!source.length) throw new Error(`domain_source_table_missing:${table}`)
  if (!target.length) throw new Error(`domain_target_schema_missing:${table}`)
  const shape = (columns: TableColumn[]) => columns.map((column) => [
    column.name, String(column.type ?? '').toUpperCase(), Number(column.notnull), Number(column.pk),
  ])
  if (JSON.stringify(shape(source)) !== JSON.stringify(shape(target))) {
    throw new Error(`domain_table_schema_mismatch:${table}`)
  }
}

export function domainBackfillKeysetWhere(primaryKeys: string[], cursor: unknown[] | null): { sql: string; binds: unknown[] } {
  if (!cursor?.length) return { sql: '', binds: [] }
  if (cursor.length !== primaryKeys.length) throw new Error('domain_backfill_cursor_shape_mismatch')
  const tuple = primaryKeys.map(identifier).join(", ")
  return { sql: `WHERE (${tuple}) > (${primaryKeys.map(() => '?').join(', ')})`, binds: cursor }
}

export function isDomainShadowCopyComplete(ownedTables: string[], completedTables: string[]): boolean {
  const completed = new Set(completedTables.map((table) => table.trim().toLowerCase()))
  return ownedTables.length > 0 && ownedTables.every((table) => completed.has(table))
}

export function isDomainShadowCutoverReady(
  ownedTables: string[],
  completedTables: string[],
  checksumParityTables: string[],
): boolean {
  return isDomainShadowCopyComplete(ownedTables, completedTables)
    && isDomainShadowCopyComplete(ownedTables, checksumParityTables)
}

function parseCursor(value: unknown): unknown[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('domain_backfill_cursor_invalid')
  return parsed
}

export async function backfillDataDomainTableShadow(
  env: Bindings,
  options: { domain: DataDomain; table: string; limit?: number; reset?: boolean },
): Promise<DomainShadowBackfillResult> {
  const domain = options.domain
  const table = String(options.table ?? "").trim().toLowerCase()
  if (dataDomainForTable(table) !== domain || !tablesForDataDomain(domain).includes(table)) {
    throw new Error(`domain_table_ownership_mismatch:${domain}:${table}`)
  }
  const target = shadowDatabaseForDataDomain(env, domain)
  if (!target) throw new Error(`data_domain_shadow_binding_missing:${domain}`)
  const sourceColumns = await tableColumns(env.DB, table)
  const targetColumns = await tableColumns(target, table)
  assertSchemaParity(sourceColumns, targetColumns, table)
  const primaryKeys = sourceColumns.filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name)
  if (!primaryKeys.length) throw new Error(`domain_backfill_primary_key_missing:${table}`)
  const columns = sourceColumns.map((column) => column.name)
  const cursorRow = options.reset ? null : await env.DB.prepare(`
    SELECT cursor_json FROM data_domain_backfill_cursors WHERE domain=? AND table_name=?
  `).bind(domain, table).first<{ cursor_json?: string | null }>()
  const cursor = parseCursor(cursorRow?.cursor_json)
  const keyset = domainBackfillKeysetWhere(primaryKeys, cursor)
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 50))
  const order = primaryKeys.map(identifier).join(", ")
  const selected = await env.DB.prepare(`
    SELECT ${columns.map(identifier).join(", ")}
      FROM ${identifier(table)}
      ${keyset.sql}
     ORDER BY ${order}
     LIMIT ?
  `).bind(...keyset.binds, limit).all<Record<string, unknown>>()
  const rows = selected.results ?? []
  if (!rows.length) {
    const sourceCount = await env.DB.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>()
    const targetCount = await target.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>()
    const sourceRows = Number(sourceCount?.count ?? 0)
    const targetRows = Number(targetCount?.count ?? 0)
    if (sourceRows !== targetRows) throw new Error(`domain_shadow_count_mismatch:${domain}:${table}:${sourceRows}/${targetRows}`)

    const fullChecksumLimit = 1000
    let sourceFullChecksum: string | null = null
    let targetFullChecksum: string | null = null
    let parityStatus: 'pass' | 'blocked' = 'blocked'
    if (sourceRows <= fullChecksumLimit) {
      const columnSql = columns.map(identifier).join(", ")
      const sourceFull = await env.DB.prepare(`
        SELECT ${columnSql} FROM ${identifier(table)} ORDER BY ${order}
      `).all<Record<string, unknown>>()
      const targetFull = await target.prepare(`
        SELECT ${columnSql} FROM ${identifier(table)} ORDER BY ${order}
      `).all<Record<string, unknown>>()
      sourceFullChecksum = await checksumRows(sourceFull.results ?? [], columns)
      targetFullChecksum = await checksumRows(targetFull.results ?? [], columns)
      if (sourceFullChecksum !== targetFullChecksum) {
        throw new Error(`domain_shadow_full_checksum_mismatch:${domain}:${table}`)
      }
      parityStatus = 'pass'
    }

    await env.DB.prepare(`
      INSERT INTO data_domain_parity_checks(
        check_id, domain, table_name, check_kind, status, source_count, target_count,
        source_checksum, target_checksum, evidence_json
      ) VALUES (?, ?, ?, 'full_table', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id) DO UPDATE SET
        status=excluded.status, source_count=excluded.source_count, target_count=excluded.target_count,
        source_checksum=excluded.source_checksum, target_checksum=excluded.target_checksum,
        evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
    `).bind(
      `domain-parity:${domain}:${table}:full-table`, domain, table, parityStatus,
      sourceRows, targetRows, sourceFullChecksum, targetFullChecksum,
      JSON.stringify({
        schema_version: DATA_DOMAIN_SHADOW_SCHEMA_VERSION,
        parity_scope: parityStatus === 'pass' ? 'full_table_checksum' : 'manifest_checksum_required',
        full_checksum_limit: fullChecksumLimit,
      }),
    ).run()

    await env.DB.prepare(`
      INSERT INTO data_domain_backfill_cursors(domain, table_name, status, cursor_json, updated_at)
      VALUES (?, ?, 'complete', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(domain,table_name) DO UPDATE SET status='complete', cursor_json=excluded.cursor_json,
        error_code=NULL, updated_at=CURRENT_TIMESTAMP
    `).bind(domain, table, JSON.stringify(cursor)).run()
    const ownedTables = tablesForDataDomain(domain)
    const completedResult = await env.DB.prepare(`
      SELECT table_name
        FROM data_domain_backfill_cursors
       WHERE domain=? AND status='complete'
    `).bind(domain).all<{ table_name: string }>()
    const parityResult = await env.DB.prepare(`
      SELECT table_name
        FROM data_domain_parity_checks
       WHERE domain=? AND check_kind='full_table' AND status='pass'
    `).bind(domain).all<{ table_name: string }>()
    const completedTables = (completedResult.results ?? []).map((row) => String(row.table_name))
    const parityTables = (parityResult.results ?? []).map((row) => String(row.table_name))
    const domainShadowReady = isDomainShadowCutoverReady(ownedTables, completedTables, parityTables)
    const currentCutover = await env.DB.prepare(`
      SELECT status FROM data_domain_cutovers WHERE domain=?
    `).bind(domain).first<{ status?: string }>()
    if (!domainShadowReady && currentCutover?.status && !['legacy', 'shadow'].includes(currentCutover.status)) {
      throw new Error(`domain_cutover_inconsistent:${domain}:${currentCutover.status}`)
    }
    await env.DB.prepare(`
      INSERT INTO data_domain_cutovers(domain,status,source_binding,target_binding)
      VALUES (?, ?, 'DB', ?)
      ON CONFLICT(domain) DO UPDATE SET
        status=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.status ELSE data_domain_cutovers.status END,
        target_binding=excluded.target_binding, updated_at=CURRENT_TIMESTAMP
    `).bind(domain, domainShadowReady ? 'shadow' : 'legacy', `${domain.toUpperCase()}_DB`).run()
    return {
      domain,
      table,
      status: 'shadow_table_complete',
      source_rows: sourceRows,
      target_rows: targetRows,
      batch_rows: 0,
      batch_checksum: sourceFullChecksum,
      cursor,
      domain_tables_completed: completedTables.filter((completed) => ownedTables.includes(completed)).length,
      domain_tables_total: ownedTables.length,
      domain_shadow_ready: domainShadowReady,
    }
  }

  const columnSql = columns.map(identifier).join(", ")
  const valuesSql = columns.map(() => '?').join(', ')
  const nonKeys = columns.filter((column) => !primaryKeys.includes(column))
  const updateSql = nonKeys.length
    ? `DO UPDATE SET ${nonKeys.map((column) => `${identifier(column)}=excluded.${identifier(column)}`).join(", ")}`
    : 'DO NOTHING'
  const statements = rows.map((row) => target.prepare(`
    INSERT INTO ${identifier(table)} (${columnSql}) VALUES (${valuesSql})
    ON CONFLICT (${primaryKeys.map(identifier).join(", ")}) ${updateSql}
  `).bind(...columns.map((column) => row[column] ?? null)))
  for (let offset = 0; offset < statements.length; offset += 50) await target.batch(statements.slice(offset, offset + 50))
  const tupleClauses = rows.map(() => `(${primaryKeys.map((column) => `${identifier(column)}=?`).join(" AND ")})`)
  const verify = await target.prepare(`
    SELECT ${columnSql} FROM ${identifier(table)}
     WHERE ${tupleClauses.join(" OR ")}
     ORDER BY ${order}
  `).bind(...rows.flatMap((row) => primaryKeys.map((column) => row[column] ?? null))).all<Record<string, unknown>>()
  const targetRows = verify.results ?? []
  const sourceChecksum = await checksumRows(rows, columns)
  const targetChecksum = await checksumRows(targetRows, columns)
  if (sourceChecksum !== targetChecksum) throw new Error(`domain_shadow_checksum_mismatch:${domain}:${table}`)
  const last = rows.at(-1)!
  const nextCursor = primaryKeys.map((column) => last[column] ?? null)
  await env.DB.prepare(`
    INSERT INTO data_domain_backfill_cursors(
      domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
      last_source_checksum, last_target_checksum, updated_at
    ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(domain,table_name) DO UPDATE SET
      status='running', cursor_json=excluded.cursor_json,
      rows_copied=data_domain_backfill_cursors.rows_copied+excluded.last_batch_rows,
      last_batch_rows=excluded.last_batch_rows, last_source_checksum=excluded.last_source_checksum,
      last_target_checksum=excluded.last_target_checksum, error_code=NULL, updated_at=CURRENT_TIMESTAMP
  `).bind(domain, table, JSON.stringify(nextCursor), rows.length, rows.length, sourceChecksum, targetChecksum).run()
  await env.DB.prepare(`
    INSERT INTO data_domain_parity_checks(
      check_id, domain, table_name, check_kind, status, source_count, target_count,
      source_checksum, target_checksum, evidence_json
    ) VALUES (?, ?, ?, 'batch', 'pass', ?, ?, ?, ?, ?)
    ON CONFLICT(check_id) DO UPDATE SET
      status='pass', source_count=excluded.source_count, target_count=excluded.target_count,
      source_checksum=excluded.source_checksum, target_checksum=excluded.target_checksum,
      evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
  `).bind(
    `domain-parity:${domain}:${table}:${sourceChecksum.slice(0, 16)}`,
    domain, table, rows.length, targetRows.length, sourceChecksum, targetChecksum,
    JSON.stringify({ schema_version: DATA_DOMAIN_SHADOW_SCHEMA_VERSION, cursor: nextCursor }),
  ).run()
  return {
    domain, table, status: 'shadow_progress', source_rows: rows.length, target_rows: targetRows.length,
    batch_rows: rows.length, batch_checksum: sourceChecksum, cursor: nextCursor,
  }
}
