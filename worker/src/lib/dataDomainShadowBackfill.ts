import type { Bindings } from '../types'
import { dataDomainForTable, shadowDatabaseForDataDomain, tablesForDataDomainShadowBackfill, type DataDomain } from './dataDomainRegistry'

export const DATA_DOMAIN_SHADOW_SCHEMA_VERSION = 'data-domain-shadow-backfill-v1'

export interface TableColumn {
  cid: number
  name: string
  type: string
  notnull: number
  pk: number
}

export interface DomainShadowBackfillResult {
  domain: DataDomain
  table: string
  status: 'shadow_progress' | 'shadow_parity_progress' | 'shadow_table_complete'
  source_rows: number
  target_rows: number
  batch_rows: number
  batch_checksum: string | null
  cursor: unknown[] | null
  domain_tables_completed?: number
  domain_tables_total?: number
  domain_shadow_ready?: boolean
  parity_rows_scanned?: number
  parity_rows_repaired?: number
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

async function checksumText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function domainBackfillRollingManifest(
  previousManifest: string | null,
  batchChecksum: string,
  batchRows: number,
): Promise<string> {
  return checksumText(JSON.stringify({
    previous_manifest: previousManifest,
    batch_checksum: batchChecksum,
    batch_rows: batchRows,
  }))
}

export function domainBackfillBatchLimit(value?: number): number {
  return Math.max(1, Math.min(Math.floor(value ?? 500), 500))
}

export function domainBackfillRowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(100 / Math.max(1, Math.floor(columnCount))))
}

export function domainBackfillParityBatchLimit(copyBatchLimit: number): number {
  return Math.max(1, Math.min(Math.floor(copyBatchLimit) * 8, 4000))
}

async function upsertDomainRows(
  target: D1Database,
  table: string,
  columns: string[],
  primaryKeys: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return
  const columnSql = columns.map(identifier).join(', ')
  const valuesSql = columns.map(() => '?').join(', ')
  const nonKeys = columns.filter((column) => !primaryKeys.includes(column))
  const updateSql = nonKeys.length
    ? `DO UPDATE SET ${nonKeys.map((column) => `${identifier(column)}=excluded.${identifier(column)}`).join(', ')}`
    : 'DO NOTHING'
  const rowsPerStatement = domainBackfillRowsPerStatement(columns.length)
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const statementRows = rows.slice(offset, offset + rowsPerStatement)
    const multiValueSql = statementRows.map(() => `(${valuesSql})`).join(', ')
    statements.push(target.prepare(`
      INSERT INTO ${identifier(table)} (${columnSql}) VALUES ${multiValueSql}
      ON CONFLICT (${primaryKeys.map(identifier).join(', ')}) ${updateSql}
    `).bind(...statementRows.flatMap((row) => columns.map((column) => row[column] ?? null))))
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await target.batch(statements.slice(offset, offset + 50))
  }
}

type ManifestProgressEvidence = {
  cursor?: unknown[] | null
  rows_scanned?: number
  repaired_rows?: number
  expected_source_rows?: number
  expected_target_rows?: number
  source_manifest?: string | null
  target_manifest?: string | null
}

function parseManifestProgress(value: unknown): ManifestProgressEvidence {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as ManifestProgressEvidence : {}
  } catch {
    throw new Error('domain_shadow_manifest_progress_invalid')
  }
}

async function tableColumns(db: D1Database, table: string): Promise<TableColumn[]> {
  const result = await db.prepare(`PRAGMA table_info(${identifier(table)})`).all<TableColumn>()
  return (result.results ?? []).sort((left, right) => Number(left.cid) - Number(right.cid))
}

export function isDomainTableSchemaCompatible(source: TableColumn[], target: TableColumn[]): boolean {
  if (!source.length || !target.length) return false
  // D1 additive migrations may append columns in a different physical order.
  const shape = (columns: TableColumn[]) => columns.map((column) => [
    column.name, String(column.type ?? '').toUpperCase(), Number(column.notnull), Number(column.pk),
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  if (JSON.stringify(shape(source)) !== JSON.stringify(shape(target))) {
    return false
  }
  return true
}

function assertSchemaParity(source: TableColumn[], target: TableColumn[], table: string): void {
  if (!source.length) throw new Error(`domain_source_table_missing:${table}`)
  if (!target.length) throw new Error(`domain_target_schema_missing:${table}`)
  if (!isDomainTableSchemaCompatible(source, target)) throw new Error(`domain_table_schema_mismatch:${table}`)
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

export type DomainAggregateParityRow = {
  table_name: string
  status: string
  source_count: number | string | null
  target_count: number | string | null
  source_checksum: string | null
  target_checksum: string | null
}

export type DomainAggregateParitySnapshot = {
  source_row_count: number
  target_row_count: number
  source_checksum: string
  target_checksum: string
}

export async function buildDataDomainAggregateParitySnapshot(
  ownedTables: string[],
  parityRows: DomainAggregateParityRow[],
): Promise<DomainAggregateParitySnapshot | null> {
  const latest = new Map<string, DomainAggregateParityRow>()
  for (const row of parityRows) {
    if (!latest.has(row.table_name)) latest.set(row.table_name, row)
  }
  const sourceManifest: Array<Record<string, unknown>> = []
  const targetManifest: Array<Record<string, unknown>> = []
  for (const table of [...ownedTables].sort()) {
    const row = latest.get(table)
    if (
      !row
      || row.status !== 'pass'
      || Number(row.source_count ?? 0) !== Number(row.target_count ?? 0)
      || !row.source_checksum
      || row.source_checksum !== row.target_checksum
    ) return null
    sourceManifest.push({ table, rows: Number(row.source_count ?? 0), checksum: row.source_checksum })
    targetManifest.push({ table, rows: Number(row.target_count ?? 0), checksum: row.target_checksum })
  }
  return {
    source_row_count: sourceManifest.reduce((sum, row) => sum + Number(row.rows), 0),
    target_row_count: targetManifest.reduce((sum, row) => sum + Number(row.rows), 0),
    source_checksum: await checksumText(JSON.stringify(sourceManifest)),
    target_checksum: await checksumText(JSON.stringify(targetManifest)),
  }
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
  if (dataDomainForTable(table) !== domain || !tablesForDataDomainShadowBackfill(domain).includes(table)) {
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
  const limit = domainBackfillBatchLimit(options.limit)
  const order = primaryKeys.map(identifier).join(", ")
  const selected = await env.DB.prepare(`
    SELECT ${columns.map(identifier).join(", ")}
      FROM ${identifier(table)}
      ${keyset.sql}
     ORDER BY ${order}
     LIMIT ?
  `).bind(...keyset.binds, limit).all<Record<string, unknown>>()
  const rows = selected.results ?? []
  if (rows.length) {
    const activeCutover = await env.DB.prepare(`
      SELECT status FROM data_domain_cutovers WHERE domain=?
    `).bind(domain).first<{ status?: string }>()
    const activeStatus = String(activeCutover?.status ?? 'legacy')
    if (!['legacy', 'shadow'].includes(activeStatus)) {
      throw new Error(`domain_cutover_source_changed:${domain}:${activeStatus}`)
    }
    await env.DB.prepare(`
      UPDATE data_domain_cutovers
         SET status='legacy', source_row_count=NULL, target_row_count=NULL,
             source_checksum=NULL, target_checksum=NULL, parity_checked_at=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND status='shadow'
    `).bind(domain).run()
    await env.DB.prepare(`
      UPDATE data_domain_parity_checks
         SET status='blocked',
             evidence_json=json_set(evidence_json, '$.invalidated_reason', 'source_rows_changed'),
             checked_at=CURRENT_TIMESTAMP
       WHERE domain=? AND table_name=? AND check_kind='full_table'
    `).bind(domain, table).run()
    await env.DB.prepare(`
      DELETE FROM data_domain_parity_checks
       WHERE check_id=?
    `).bind(`domain-parity:${domain}:${table}:manifest-progress`).run()
  }
  if (!rows.length) {
    const sourceCount = await env.DB.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>()
    const targetCount = await target.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>()
    const sourceRows = Number(sourceCount?.count ?? 0)
    const targetRows = Number(targetCount?.count ?? 0)
    if (sourceRows !== targetRows) throw new Error(`domain_shadow_count_mismatch:${domain}:${table}:${sourceRows}/${targetRows}`)

    const fullChecksumLimit = 1000
    const columnSql = columns.map(identifier).join(", ")
    let sourceFullChecksum: string | null = null
    let targetFullChecksum: string | null = null
    let parityStatus: 'pass' | 'blocked' = 'blocked'
    if (sourceRows <= fullChecksumLimit) {
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
    } else {
      const progressId = `domain-parity:${domain}:${table}:manifest-progress`
      const progressRow = await env.DB.prepare(`
        SELECT evidence_json
          FROM data_domain_parity_checks
         WHERE check_id=?
      `).bind(progressId).first<{ evidence_json?: string }>()
      const progress = parseManifestProgress(progressRow?.evidence_json)
      if (
        (progress.expected_source_rows !== undefined && Number(progress.expected_source_rows) !== sourceRows)
        || (progress.expected_target_rows !== undefined && Number(progress.expected_target_rows) !== targetRows)
      ) {
        throw new Error(`domain_shadow_source_changed_during_parity:${domain}:${table}`)
      }
      const manifestCursor = Array.isArray(progress.cursor) ? progress.cursor : null
      const manifestKeyset = domainBackfillKeysetWhere(primaryKeys, manifestCursor)
      const parityLimit = domainBackfillParityBatchLimit(limit)
      const sourcePageResult = await env.DB.prepare(`
        SELECT ${columnSql}
          FROM ${identifier(table)}
          ${manifestKeyset.sql}
         ORDER BY ${order}
         LIMIT ?
      `).bind(...manifestKeyset.binds, parityLimit).all<Record<string, unknown>>()
      const sourcePage = sourcePageResult.results ?? []
      const rowsScanned = Math.max(0, Math.floor(Number(progress.rows_scanned ?? 0)))
      const repairedRows = Math.max(0, Math.floor(Number(progress.repaired_rows ?? 0)))

      if (sourcePage.length) {
        let targetPageResult = await target.prepare(`
          SELECT ${columnSql}
            FROM ${identifier(table)}
            ${manifestKeyset.sql}
           ORDER BY ${order}
           LIMIT ?
        `).bind(...manifestKeyset.binds, parityLimit).all<Record<string, unknown>>()
        let targetPage = targetPageResult.results ?? []
        const sourcePageChecksum = await checksumRows(sourcePage, columns)
        let targetPageChecksum = await checksumRows(targetPage, columns)
        let nextRepairedRows = repairedRows
        if (sourcePageChecksum !== targetPageChecksum) {
          await upsertDomainRows(target, table, columns, primaryKeys, sourcePage)
          targetPageResult = await target.prepare(`
            SELECT ${columnSql}
              FROM ${identifier(table)}
              ${manifestKeyset.sql}
             ORDER BY ${order}
             LIMIT ?
          `).bind(...manifestKeyset.binds, parityLimit).all<Record<string, unknown>>()
          targetPage = targetPageResult.results ?? []
          targetPageChecksum = await checksumRows(targetPage, columns)
          if (sourcePageChecksum !== targetPageChecksum) {
            throw new Error(`domain_shadow_parity_repair_failed:${domain}:${table}`)
          }
          nextRepairedRows += sourcePage.length
        }
        const last = sourcePage.at(-1)!
        const nextManifestCursor = primaryKeys.map((column) => last[column] ?? null)
        const nextRowsScanned = rowsScanned + sourcePage.length
        const sourceManifest = await domainBackfillRollingManifest(
          progress.source_manifest ?? null,
          sourcePageChecksum,
          sourcePage.length,
        )
        const targetManifest = await domainBackfillRollingManifest(
          progress.target_manifest ?? null,
          targetPageChecksum,
          targetPage.length,
        )
        const evidence = {
          schema_version: DATA_DOMAIN_SHADOW_SCHEMA_VERSION,
          parity_scope: 'resumable_full_table_manifest',
          cursor: nextManifestCursor,
          rows_scanned: nextRowsScanned,
          repaired_rows: nextRepairedRows,
          expected_source_rows: sourceRows,
          expected_target_rows: targetRows,
          source_manifest: sourceManifest,
          target_manifest: targetManifest,
        }
        await env.DB.prepare(`
          INSERT INTO data_domain_parity_checks(
            check_id, domain, table_name, check_kind, status, source_count, target_count,
            source_checksum, target_checksum, evidence_json
          ) VALUES (?, ?, ?, 'manifest_progress', 'blocked', ?, ?, ?, ?, ?)
          ON CONFLICT(check_id) DO UPDATE SET
            status='blocked', source_count=excluded.source_count, target_count=excluded.target_count,
            source_checksum=excluded.source_checksum, target_checksum=excluded.target_checksum,
            evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
        `).bind(
          progressId, domain, table, nextRowsScanned, nextRowsScanned,
          sourceManifest, targetManifest, JSON.stringify(evidence),
        ).run()
        return {
          domain,
          table,
          status: 'shadow_parity_progress',
          source_rows: sourceRows,
          target_rows: targetRows,
          batch_rows: sourcePage.length,
          batch_checksum: sourcePageChecksum,
          cursor: nextManifestCursor,
          parity_rows_scanned: nextRowsScanned,
          parity_rows_repaired: nextRepairedRows,
        }
      }

      if (rowsScanned !== sourceRows || !progress.source_manifest || !progress.target_manifest) {
        throw new Error(`domain_shadow_manifest_incomplete:${domain}:${table}:${rowsScanned}/${sourceRows}`)
      }
      if (progress.source_manifest !== progress.target_manifest) {
        throw new Error(`domain_shadow_manifest_mismatch:${domain}:${table}`)
      }
      sourceFullChecksum = progress.source_manifest
      targetFullChecksum = progress.target_manifest
      await env.DB.prepare(`
        UPDATE data_domain_parity_checks
           SET status='pass', source_count=?, target_count=?,
               source_checksum=?, target_checksum=?, checked_at=CURRENT_TIMESTAMP
         WHERE check_id=?
      `).bind(sourceRows, targetRows, sourceFullChecksum, targetFullChecksum, progressId).run()
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
        parity_scope: sourceRows <= fullChecksumLimit ? 'full_table_checksum' : 'resumable_full_table_manifest',
        full_checksum_limit: fullChecksumLimit,
      }),
    ).run()

    await env.DB.prepare(`
      INSERT INTO data_domain_backfill_cursors(
        domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
        last_source_checksum, last_target_checksum, updated_at
      ) VALUES (?, ?, 'complete', ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(domain,table_name) DO UPDATE SET
        status='complete', cursor_json=excluded.cursor_json, rows_copied=excluded.rows_copied,
        last_batch_rows=0, last_source_checksum=excluded.last_source_checksum,
        last_target_checksum=excluded.last_target_checksum, error_code=NULL, updated_at=CURRENT_TIMESTAMP
    `).bind(
      domain, table, JSON.stringify(cursor), sourceRows, sourceFullChecksum, targetFullChecksum,
    ).run()
    const ownedTables = tablesForDataDomainShadowBackfill(domain)
    const completedResult = await env.DB.prepare(`
      SELECT table_name
        FROM data_domain_backfill_cursors
       WHERE domain=? AND status='complete'
    `).bind(domain).all<{ table_name: string }>()
    const parityResult = await env.DB.prepare(`
      SELECT table_name, status, source_count, target_count, source_checksum, target_checksum
        FROM data_domain_parity_checks
       WHERE domain=? AND check_kind='full_table'
       ORDER BY checked_at DESC
    `).bind(domain).all<DomainAggregateParityRow>()
    const completedTables = (completedResult.results ?? []).map((row) => String(row.table_name))
    const parityRows = parityResult.results ?? []
    const parityTables = parityRows
      .filter((row) => row.status === 'pass')
      .map((row) => String(row.table_name))
    const copyAndTableParityReady = isDomainShadowCutoverReady(
      ownedTables,
      completedTables,
      parityTables,
    )
    const aggregateSnapshot = copyAndTableParityReady
      ? await buildDataDomainAggregateParitySnapshot(ownedTables, parityRows)
      : null
    const domainShadowReady = Boolean(
      aggregateSnapshot
      && aggregateSnapshot.source_checksum === aggregateSnapshot.target_checksum,
    )
    const currentCutover = await env.DB.prepare(`
      SELECT status FROM data_domain_cutovers WHERE domain=?
    `).bind(domain).first<{ status?: string }>()
    if (!domainShadowReady && currentCutover?.status && !['legacy', 'shadow'].includes(currentCutover.status)) {
      throw new Error(`domain_cutover_inconsistent:${domain}:${currentCutover.status}`)
    }
    const aggregateCheckedAt = domainShadowReady ? new Date().toISOString() : null
    await env.DB.prepare(`
      INSERT INTO data_domain_cutovers(
        domain, status, source_binding, target_binding,
        source_row_count, target_row_count, source_checksum, target_checksum, parity_checked_at
      ) VALUES (?, ?, 'DB', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        status=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.status ELSE data_domain_cutovers.status END,
        target_binding=excluded.target_binding,
        source_row_count=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.source_row_count ELSE data_domain_cutovers.source_row_count END,
        target_row_count=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.target_row_count ELSE data_domain_cutovers.target_row_count END,
        source_checksum=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.source_checksum ELSE data_domain_cutovers.source_checksum END,
        target_checksum=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.target_checksum ELSE data_domain_cutovers.target_checksum END,
        parity_checked_at=CASE WHEN data_domain_cutovers.status IN ('legacy','shadow') THEN excluded.parity_checked_at ELSE data_domain_cutovers.parity_checked_at END,
        updated_at=CURRENT_TIMESTAMP
    `).bind(
      domain,
      domainShadowReady ? 'shadow' : 'legacy',
      `${domain.toUpperCase()}_DB`,
      aggregateSnapshot?.source_row_count ?? null,
      aggregateSnapshot?.target_row_count ?? null,
      aggregateSnapshot?.source_checksum ?? null,
      aggregateSnapshot?.target_checksum ?? null,
      aggregateCheckedAt,
    ).run()
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
  await upsertDomainRows(target, table, columns, primaryKeys, rows)
  const verify = await target.prepare(`
    SELECT ${columnSql} FROM ${identifier(table)}
     ${keyset.sql}
     ORDER BY ${order}
     LIMIT ?
  `).bind(...keyset.binds, limit).all<Record<string, unknown>>()
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
