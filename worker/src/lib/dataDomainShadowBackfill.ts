import type { Bindings } from '../types'
import {
  activeDataDomains,
  dataDomainForTable,
  invalidActiveDataDomains,
  shadowDatabaseForDataDomain,
  tableOwnershipMetadata,
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'
import {
  assertInactiveLearningShadowAuthority,
  invalidateControlTableClosure,
  type InactiveLearningShadowAuthority,
} from './dataDomainControlTableParity'
import {
  dataDomainControlRevisionBlockers,
  dataDomainControlRevisionEvidence,
  loadDataDomainControlRevisionPair,
  strictDataDomainControlRevision,
  type DataDomainControlRevisionPair,
} from './dataDomainControlRevision'
import {
  boundedDataDomainTableManifest,
  checksumRollingManifest,
  checksumRows,
  checksumText,
  dataDomainManifestPageLimit,
  DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
  DATA_DOMAIN_CONTROL_PROGRESS_SCHEMA_VERSION,
  DATA_DOMAIN_DIRECT_MANIFEST_SCHEMA_VERSION,
  DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
  DATA_DOMAIN_FULL_CHECKSUM_LIMIT,
  DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
  isAuthoritativeDataDomainFullTableParity,
  type DataDomainControlTable,
  isDataDomainControlTable,
  isDataDomainFullTableParityFresh,
} from './dataDomainShadowManifest'
import { assertExpectedReturnCandidateIdentityBackfillRows } from './expectedReturnCandidateIdentityBackfillGuard'
import {
  assertExpectedReturnPointerSourceStable,
  assertExpectedReturnPointerTargetClosure,
  beginExpectedReturnPointerShadowGuard,
  type ExpectedReturnPointerShadowGuard,
} from './expectedReturnPointerShadowGuard'
import { validateExpectedReturnControlSemanticPage } from './expectedReturnControlTableSemanticValidation'

export const DATA_DOMAIN_SHADOW_SCHEMA_VERSION = 'data-domain-shadow-backfill-v1'

export function isFinalizedDeferredTableRepairAuthority(input: {
  domainActive: boolean
  routeReady: boolean
  shadowReady: boolean
  cutoverStatus: string | null
  writerState: string | null
}): boolean {
  return input.domainActive
    && !input.routeReady
    && input.shadowReady
    && input.cutoverStatus === 'complete'
    && input.writerState === 'cutover'
}

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
  status: 'shadow_progress' | 'shadow_delete_reconciliation_progress' | 'shadow_delete_reconciliation_deferred' | 'shadow_parent_revalidation_required' | 'shadow_parity_progress' | 'shadow_table_complete'
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
  reconciliation_rows_scanned?: number
  reconciliation_rows_deleted?: number
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid_sql_identifier:${value}`)
  return `"${value}"`
}

export async function domainBackfillRollingManifest(
  previousManifest: string | null,
  batchChecksum: string,
  batchRows: number,
): Promise<string> {
  return checksumRollingManifest(previousManifest, batchChecksum, batchRows)
}

export function domainBackfillBatchLimit(value?: number, table?: string): number {
  const maximum = table === 'strategy_label_matrix_v4'
    ? 1000
    : table === 's12_structure_snapshots'
      ? 100
      : 500
  return Math.max(1, Math.min(Math.floor(value ?? 500), maximum))
}

export function domainBackfillRowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(100 / Math.max(1, Math.floor(columnCount))))
}
export function domainBackfillStatementsPerBatch(table: string): number {
  return table === 'strategy_label_matrix_v4' ? 100 : 50
}


export function domainBackfillExactKeyRowsPerStatement(primaryKeyCount: number): number {
  return Math.min(48, domainBackfillRowsPerStatement(primaryKeyCount))
}

export function domainBackfillParityBatchLimit(copyBatchLimit: number): number {
  return Math.max(1, Math.min(Math.floor(copyBatchLimit) * 8, 4000))
}

export function domainBackfillResumeParityBatchLimit(
  progressRows: number,
  recordedParityLimit: number,
  requestedParityLimit: number,
): number {
  return progressRows > 0
    ? Math.min(recordedParityLimit, requestedParityLimit)
    : requestedParityLimit
}

export function shouldUseRollingDataDomainManifest(input: {
  sourceRows: number
  cursorStatus?: string | null
  controlTableRolling: boolean
}): boolean {
  return input.controlTableRolling
    || input.sourceRows > DATA_DOMAIN_FULL_CHECKSUM_LIMIT
    || input.cursorStatus === 'complete'
}

export function domainBackfillFinalCountFenceBlockers(input: {
  expectedSourceRows: number
  expectedTargetRows: number
  liveSourceRows: number | null
  liveTargetRows: number | null
}): string[] {
  const blockers: string[] = []
  if (input.liveSourceRows == null) blockers.push('live_source_count_invalid')
  if (input.liveTargetRows == null) blockers.push('live_target_count_invalid')
  if (
    input.liveSourceRows != null
    && input.liveSourceRows !== input.expectedSourceRows
  ) blockers.push(`live_source_count_drift:${input.expectedSourceRows}/${input.liveSourceRows}`)
  if (
    input.liveTargetRows != null
    && input.liveTargetRows !== input.expectedTargetRows
  ) blockers.push(`live_target_count_drift:${input.expectedTargetRows}/${input.liveTargetRows}`)
  if (
    input.liveSourceRows != null
    && input.liveTargetRows != null
    && input.liveSourceRows !== input.liveTargetRows
  ) blockers.push(`live_count_mismatch:${input.liveSourceRows}/${input.liveTargetRows}`)
  return blockers
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
  const statementsPerBatch = domainBackfillStatementsPerBatch(table)
  for (let offset = 0; offset < statements.length; offset += statementsPerBatch) {
    await target.batch(statements.slice(offset, offset + statementsPerBatch))
  }
}

type ForeignKeyColumn = {
  id: number
  seq: number
  table: string
  from: string
  to: string
}

function keySignature(row: Record<string, unknown>, columns: string[]): string {
  return JSON.stringify(columns.map((column) => row[column] ?? null))
}

async function loadRowsByKeys(
  db: D1Database,
  table: string,
  selectedColumns: string[],
  keyColumns: string[],
  keyRows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!keyRows.length) return []
  const unique = new Map(keyRows.map((row) => [keySignature(row, keyColumns), row]))
  const rows = [...unique.values()]
  const rowsPerQuery = dataDomainManifestPageLimit(
    table,
    Math.max(1, Math.floor(90 / keyColumns.length)),
  )
  const found: Record<string, unknown>[] = []
  for (let offset = 0; offset < rows.length; offset += rowsPerQuery) {
    const page = rows.slice(offset, offset + rowsPerQuery)
    const tupleColumns = keyColumns.map(identifier).join(', ')
    const tupleValues = page.map(() => `(${keyColumns.map(() => '?').join(', ')})`).join(', ')
    const result = await db.prepare(`
      SELECT ${selectedColumns.map(identifier).join(', ')}
        FROM ${identifier(table)}
       WHERE (${tupleColumns}) IN (${tupleValues})
    `).bind(...page.flatMap((row) => keyColumns.map((column) => row[column] ?? null)))
      .all<Record<string, unknown>>()
    found.push(...(result.results ?? []))
  }
  return found
}

type ForeignKeySyncState = {
  visitedRowKeys: Set<string>
  rowPaths: ReadonlyMap<string, readonly ForeignKeyPathNode[]>
  beforeAncestorWrite?: (table: string) => Promise<void>
}

type ForeignKeyPathNode = {
  table: string
  rowKey: string
}

type DomainTableShape = {
  columns: string[]
  primaryKeys: string[]
}

function foreignKeyRowIdentity(table: string, primaryKeys: string[], row: Record<string, unknown>): string {
  return `${table}:${keySignature(row, primaryKeys)}`
}

async function domainTableShape(
  source: D1Database,
  target: D1Database,
  table: string,
): Promise<DomainTableShape> {
  const sourceColumns = await tableColumns(source, table)
  const targetColumns = await tableColumns(target, table)
  assertSchemaParity(sourceColumns, targetColumns, table)
  const primaryKeys = sourceColumns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name)
  if (!primaryKeys.length) throw new Error(`domain_backfill_primary_key_missing:${table}`)
  return { columns: sourceColumns.map((column) => column.name), primaryKeys }
}

async function syncForeignKeyAncestorsRecursive(
  source: D1Database,
  target: D1Database,
  domain: DataDomain,
  table: string,
  childRows: Record<string, unknown>[],
  state: ForeignKeySyncState,
  knownPrimaryKeys?: string[],
): Promise<void> {
  if (!childRows.length) return
  const owner = dataDomainForTable(table)
  if (owner !== domain) {
    throw new Error(`domain_shadow_foreign_key_owner_mismatch:${table}:${table}`)
  }
  const primaryKeys = knownPrimaryKeys ?? (await domainTableShape(source, target, table)).primaryKeys

  const foreignKeysResult = await target.prepare(`PRAGMA foreign_key_list(${identifier(table)})`).all<ForeignKeyColumn>()
  const groups = new Map<number, ForeignKeyColumn[]>()
  for (const foreignKey of foreignKeysResult.results ?? []) {
    const group = groups.get(Number(foreignKey.id)) ?? []
    group.push(foreignKey)
    groups.set(Number(foreignKey.id), group)
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => Number(left.seq) - Number(right.seq))
    const parentTable = String(ordered[0]?.table ?? '').trim().toLowerCase()
    if (!parentTable) continue
    if (dataDomainForTable(parentTable) !== domain) {
      throw new Error(`domain_shadow_foreign_key_owner_mismatch:${table}:${parentTable}`)
    }
    const childColumns = ordered.map((row) => String(row.from))
    const parentLookupColumns = ordered.map((row) => String(row.to))
    const keyRowsWithPaths = childRows
      .filter((row) => childColumns.every((column) => row[column] != null))
      .map((row) => {
        const childRowKey = foreignKeyRowIdentity(table, primaryKeys, row)
        return {
          keyRow: Object.fromEntries(parentLookupColumns.map((column, index) => [column, row[childColumns[index]]])),
          path: state.rowPaths.get(childRowKey) ?? [{ table, rowKey: childRowKey }],
        }
      })
    const keyRows = keyRowsWithPaths.map(({ keyRow }) => keyRow)
    if (!keyRows.length) continue

    const parentShape = await domainTableShape(source, target, parentTable)
    const parentRows = await loadRowsByKeys(
      source,
      parentTable,
      parentShape.columns,
      parentLookupColumns,
      keyRows,
    )
    const requested = new Set(keyRows.map((row) => keySignature(row, parentLookupColumns)))
    const available = new Set(parentRows.map((row) => keySignature(row, parentLookupColumns)))
    const missing = [...requested].filter((key) => !available.has(key))
    if (missing.length) {
      throw new Error(`domain_shadow_foreign_key_source_missing:${table}:${parentTable}:${missing.length}`)
    }
    const parentRowsByLookupKey = new Map(parentRows.map((row) => [
      keySignature(row, parentLookupColumns),
      row,
    ]))
    const uniqueParentRows = new Map<string, Record<string, unknown>>()
    const parentRowPaths = new Map<string, readonly ForeignKeyPathNode[]>()
    for (const request of keyRowsWithPaths) {
      const parentRow = parentRowsByLookupKey.get(keySignature(request.keyRow, parentLookupColumns))
      if (!parentRow) continue
      const parentRowKey = foreignKeyRowIdentity(parentTable, parentShape.primaryKeys, parentRow)
      const cycleIndex = request.path.findIndex((node) => node.rowKey === parentRowKey)
      if (cycleIndex >= 0) {
        const cyclePath = [...request.path.slice(cycleIndex).map((node) => node.table), parentTable]
        throw new Error(`domain_shadow_foreign_key_cycle:${cyclePath.join('>')}:${parentRowKey}`)
      }
      uniqueParentRows.set(parentRowKey, parentRow)
      if (!parentRowPaths.has(parentRowKey)) {
        parentRowPaths.set(parentRowKey, [...request.path, { table: parentTable, rowKey: parentRowKey }])
      }
    }
    const unsyncedParentRows = [...uniqueParentRows.entries()]
      .filter(([key]) => !state.visitedRowKeys.has(key))
      .map(([, row]) => row)
    if (!unsyncedParentRows.length) continue

    await syncForeignKeyAncestorsRecursive(
      source,
      target,
      domain,
      parentTable,
      unsyncedParentRows,
      {
        visitedRowKeys: state.visitedRowKeys,
        rowPaths: parentRowPaths,
        beforeAncestorWrite: state.beforeAncestorWrite,
      },
      parentShape.primaryKeys,
    )
    await state.beforeAncestorWrite?.(parentTable)
    await upsertDomainRows(target, parentTable, parentShape.columns, parentShape.primaryKeys, unsyncedParentRows)
    for (const row of unsyncedParentRows) {
      state.visitedRowKeys.add(foreignKeyRowIdentity(parentTable, parentShape.primaryKeys, row))
    }
  }
}

export async function syncForeignKeyAncestors(
  source: D1Database,
  target: D1Database,
  domain: DataDomain,
  table: string,
  childRows: Record<string, unknown>[],
  knownPrimaryKeys?: string[],
  beforeAncestorWrite?: (table: string) => Promise<void>,
): Promise<void> {
  return syncForeignKeyAncestorsRecursive(
    source,
    target,
    domain,
    table,
    childRows,
    { visitedRowKeys: new Set(), rowPaths: new Map(), beforeAncestorWrite },
    knownPrimaryKeys,
  )
}

async function deleteTargetRowsByKeys(
  target: D1Database,
  table: string,
  primaryKeys: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return
  const rowsPerStatement = Math.max(1, Math.floor(90 / primaryKeys.length))
  const statements: D1PreparedStatement[] = []
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const page = rows.slice(offset, offset + rowsPerStatement)
    const tuples = page.map(() => `(${primaryKeys.map(() => '?').join(', ')})`).join(', ')
    statements.push(target.prepare(`
      DELETE FROM ${identifier(table)}
       WHERE (${primaryKeys.map(identifier).join(', ')}) IN (${tuples})
    `).bind(...page.flatMap((row) => primaryKeys.map((column) => row[column] ?? null))))
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await target.batch(statements.slice(offset, offset + 50))
  }
}

async function reconcileTargetOnlyPage(
  source: D1Database,
  target: D1Database,
  domain: DataDomain,
  table: string,
  primaryKeys: string[],
  cursor: unknown[] | null,
  limit: number,
): Promise<{
  done: boolean
  scanned: number
  deleted: number
  cursor: unknown[] | null
  blockedTables: string[]
}> {
  const keyset = domainBackfillKeysetWhere(primaryKeys, cursor)
  const order = primaryKeys.map(identifier).join(', ')
  const targetPageResult = await target.prepare(`
    SELECT ${primaryKeys.map(identifier).join(', ')}
      FROM ${identifier(table)}
      ${keyset.sql}
     ORDER BY ${order}
     LIMIT ?
  `).bind(...keyset.binds, limit).all<Record<string, unknown>>()
  const targetPage = targetPageResult.results ?? []
  if (!targetPage.length) {
    return { done: true, scanned: 0, deleted: 0, cursor, blockedTables: [] }
  }
  const sourceRows = await loadRowsByKeys(source, table, primaryKeys, primaryKeys, targetPage)
  const sourceKeys = new Set(sourceRows.map((row) => keySignature(row, primaryKeys)))
  const staleRows = targetPage.filter((row) => !sourceKeys.has(keySignature(row, primaryKeys)))
  const blockedTables: string[] = []
  if (staleRows.length) {
    for (const childTable of tablesForDataDomainShadowBackfill(domain)) {
      if (childTable === table) continue
      const foreignKeys = await target.prepare(`PRAGMA foreign_key_list(${identifier(childTable)})`)
        .all<ForeignKeyColumn>()
      const groups = new Map<number, ForeignKeyColumn[]>()
      for (const foreignKey of foreignKeys.results ?? []) {
        if (String(foreignKey.table).trim().toLowerCase() !== table) continue
        const group = groups.get(Number(foreignKey.id)) ?? []
        group.push(foreignKey)
        groups.set(Number(foreignKey.id), group)
      }
      for (const group of groups.values()) {
        const ordered = [...group].sort((left, right) => Number(left.seq) - Number(right.seq))
        const childColumns = ordered.map((row) => String(row.from))
        const parentColumns = ordered.map((row, index) => String(row.to || primaryKeys[index] || ''))
        if (parentColumns.some((column) => !primaryKeys.includes(column))) {
          throw new Error(`domain_shadow_foreign_key_parent_key_unsupported:${childTable}:${table}`)
        }
        const rowsPerProbe = Math.max(1, Math.floor(90 / childColumns.length))
        for (let offset = 0; offset < staleRows.length; offset += rowsPerProbe) {
          const page = staleRows.slice(offset, offset + rowsPerProbe)
          const tuples = page
            .map(() => `(${childColumns.map(() => '?').join(', ')})`)
            .join(', ')
          const reference = await target.prepare(`
            SELECT 1 present FROM ${identifier(childTable)}
             WHERE (${childColumns.map(identifier).join(', ')}) IN (${tuples})
             LIMIT 1
          `).bind(...page.flatMap((row) => (
            parentColumns.map((column) => row[column] ?? null)
          ))).first<{ present?: number }>()
          if (reference) {
            blockedTables.push(childTable)
            break
          }
        }
      }
    }
  }
  if (blockedTables.length) {
    return {
      done: false,
      scanned: targetPage.length,
      deleted: 0,
      cursor,
      blockedTables: [...new Set(blockedTables)],
    }
  }
  await deleteTargetRowsByKeys(target, table, primaryKeys, staleRows)
  const last = targetPage.at(-1)!
  return {
    done: false,
    scanned: targetPage.length,
    deleted: staleRows.length,
    cursor: primaryKeys.map((column) => last[column] ?? null),
    blockedTables: [],
  }
}

async function resetTargetOnlyDependentTables(
  control: D1Database,
  domain: DataDomain,
  tables: readonly string[],
  reason: string,
  learningAuthority: InactiveLearningShadowAuthority | null,
): Promise<void> {
  const unique = [...new Set(tables)]
  const controlTables = domain === 'learning'
    ? unique.filter(isDataDomainControlTable)
    : []
  if (controlTables.length) {
    await invalidateControlTableClosure(control, {
      changedTables: controlTables as DataDomainControlTable[],
      reason,
      authority: learningAuthority!,
    })
  }
  const genericTables = unique.filter((table) => !controlTables.includes(table as DataDomainControlTable))
  if (!genericTables.length) return
  const statements: D1PreparedStatement[] = []
  for (const table of genericTables) {
    statements.push(
      control.prepare(`
        INSERT INTO data_domain_backfill_cursors(
          domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
          last_source_checksum, last_target_checksum, error_code, updated_at
        ) VALUES (?, ?, 'running', NULL, 0, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(domain,table_name) DO UPDATE SET
          status='running', cursor_json=NULL, rows_copied=0, last_batch_rows=0,
          last_source_checksum=NULL, last_target_checksum=NULL,
          error_code=excluded.error_code, updated_at=CURRENT_TIMESTAMP
      `).bind(domain, table, reason),
      control.prepare(`
        INSERT INTO data_domain_parity_checks(
          check_id, domain, table_name, check_kind, status,
          source_count, target_count, source_checksum, target_checksum, evidence_json
        ) VALUES (?, ?, ?, 'full_table', 'blocked', NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(check_id) DO UPDATE SET
          status='blocked', source_count=NULL, target_count=NULL,
          source_checksum=NULL, target_checksum=NULL,
          evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
      `).bind(
        `domain-parity:${domain}:${table}:full-table`,
        domain,
        table,
        JSON.stringify({
          schema_version: 'data-domain-target-only-dependent-reset-v1',
          invalidated_reason: reason,
        }),
      ),
      control.prepare(`
        DELETE FROM data_domain_parity_checks WHERE check_id IN (?, ?)
      `).bind(
        `domain-parity:${domain}:${table}:manifest-progress`,
        `domain-parity:${domain}:${table}:delete-progress`,
      ),
    )
  }
  await control.batch(statements)
}

async function deferTargetOnlyDeleteReconciliation(
  control: D1Database,
  input: {
    domain: DataDomain
    table: string
    cursor: unknown[] | null
    sourceRows: number
    targetRows: number
    blockers: readonly string[]
    learningAuthority: InactiveLearningShadowAuthority | null
  },
): Promise<void> {
  const reason = `target_only_delete_waiting_for_dependents:${input.blockers.join('|')}`.slice(0, 1000)
  if (input.domain === 'learning' && isDataDomainControlTable(input.table)) {
    await invalidateControlTableClosure(control, {
      changedTables: [input.table],
      preserveCursorTables: [input.table],
      reason,
      authority: input.learningAuthority!,
    })
  }
  await control.batch([
    control.prepare(`
      INSERT INTO data_domain_backfill_cursors(
        domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
        last_source_checksum, last_target_checksum, error_code, updated_at
      ) VALUES (?, ?, 'complete', ?, ?, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(domain,table_name) DO UPDATE SET
        status='complete', cursor_json=excluded.cursor_json, rows_copied=excluded.rows_copied,
        last_batch_rows=0, last_source_checksum=NULL, last_target_checksum=NULL,
        error_code=excluded.error_code, updated_at=CURRENT_TIMESTAMP
    `).bind(
      input.domain,
      input.table,
      JSON.stringify(input.cursor),
      input.sourceRows,
      reason,
    ),
    control.prepare(`
      INSERT INTO data_domain_parity_checks(
        check_id, domain, table_name, check_kind, status,
        source_count, target_count, source_checksum, target_checksum, evidence_json
      ) VALUES (?, ?, ?, 'full_table', 'blocked', NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(check_id) DO UPDATE SET
        status='blocked', source_count=NULL, target_count=NULL,
        source_checksum=NULL, target_checksum=NULL,
        evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
    `).bind(
      `domain-parity:${input.domain}:${input.table}:full-table`,
      input.domain,
      input.table,
      JSON.stringify({
        schema_version: 'data-domain-target-only-delete-deferred-v1',
        invalidated_reason: reason,
      }),
    ),
    control.prepare(`
      INSERT INTO data_domain_parity_checks(
        check_id, domain, table_name, check_kind, status,
        source_count, target_count, source_checksum, target_checksum, evidence_json
      ) VALUES (?, ?, ?, 'delete_reconciliation', 'blocked', ?, ?, NULL, NULL, ?)
      ON CONFLICT(check_id) DO UPDATE SET
        status='blocked', source_count=excluded.source_count, target_count=excluded.target_count,
        source_checksum=NULL, target_checksum=NULL,
        evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
    `).bind(
      `domain-parity:${input.domain}:${input.table}:delete-progress`,
      input.domain,
      input.table,
      input.sourceRows,
      input.targetRows,
      JSON.stringify({
        schema_version: 'data-domain-target-only-delete-deferred-v1',
        phase: 'waiting_for_dependents',
        blockers: [...input.blockers],
      }),
    ),
    control.prepare(`
      UPDATE data_domain_cutovers
         SET status='legacy', source_row_count=NULL, target_row_count=NULL,
             source_checksum=NULL, target_checksum=NULL, parity_checked_at=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND status IN ('legacy','shadow')
    `).bind(input.domain),
  ])
}

type ManifestProgressEvidence = {
  schema_version?: string
  cursor?: unknown[] | null
  rows_scanned?: number
  repaired_rows?: number
  expected_source_rows?: number
  expected_target_rows?: number
  source_manifest?: string | null
  target_manifest?: string | null
  manifest_schema_version?: string
  manifest_page_limit?: number
  semantic_validation_schema_version?: string
  semantic_rows_scanned?: number
  semantic_rows_applicable?: number
  semantic_rows_validated?: number
  source_revision_start?: number
  target_revision_observed?: number
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

function nonnegativeSafeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export async function invalidateGenericManifestProgress(
  control: D1Database,
  domain: DataDomain,
  table: string,
  reasonInput: string,
): Promise<void> {
  const cutover = await control.prepare(`
    SELECT c.status, w.writer_state
      FROM data_domain_cutovers c
      LEFT JOIN data_domain_writer_epochs w ON w.domain=c.domain
     WHERE c.domain=?
  `).bind(domain).first<{ status?: string; writer_state?: string }>()
  const status = cutover?.status ? String(cutover.status) : null
  const ownership = tableOwnershipMetadata(table)
  const finalizedDeferredRepair = Boolean(
    ownership?.domain === domain
    && isFinalizedDeferredTableRepairAuthority({
      domainActive: true,
      routeReady: ownership.route_ready,
      shadowReady: ownership.shadow_ready,
      cutoverStatus: status,
      writerState: cutover?.writer_state ? String(cutover.writer_state) : null,
    }),
  )
  if ((!status || !['legacy', 'shadow'].includes(status)) && !finalizedDeferredRepair) {
    throw new Error(`domain_manifest_invalidation_cutover_blocked:${domain}:${status ?? 'missing'}`)
  }
  const reason = reasonInput.slice(0, 1000)
  await control.batch([
    control.prepare(`
      UPDATE data_domain_backfill_cursors
         SET status='complete', last_batch_rows=0,
             last_source_checksum=NULL, last_target_checksum=NULL,
             error_code=?, updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND table_name=?
    `).bind(reason, domain, table),
    control.prepare(`
      INSERT INTO data_domain_parity_checks(
        check_id, domain, table_name, check_kind, status, source_count, target_count,
        source_checksum, target_checksum, evidence_json
      ) VALUES (?, ?, ?, 'full_table', 'blocked', NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(check_id) DO UPDATE SET
        status='blocked', source_count=NULL, target_count=NULL,
        source_checksum=NULL, target_checksum=NULL,
        evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
    `).bind(
      `domain-parity:${domain}:${table}:full-table`,
      domain,
      table,
      JSON.stringify({
        schema_version: 'data-domain-shadow-manifest-invalidation-v1',
        invalidated_reason: reason,
      }),
    ),
    control.prepare(`
      DELETE FROM data_domain_parity_checks WHERE check_id IN (?, ?)
    `).bind(
      `domain-parity:${domain}:${table}:manifest-progress`,
      `domain-parity:${domain}:${table}:delete-progress`,
    ),
    control.prepare(`
      UPDATE data_domain_cutovers
         SET status='legacy', source_row_count=NULL, target_row_count=NULL,
             source_checksum=NULL, target_checksum=NULL, parity_checked_at=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND status IN ('legacy','shadow')
    `).bind(domain),
  ])
}

async function resetGenericTableForFullRecopy(
  control: D1Database,
  domain: DataDomain,
  table: string,
  reasonInput: string,
): Promise<void> {
  const cutover = await control.prepare(`
    SELECT status FROM data_domain_cutovers WHERE domain=?
  `).bind(domain).first<{ status?: string }>()
  const status = cutover?.status ? String(cutover.status) : null
  if (!status || !['legacy', 'shadow'].includes(status)) {
    throw new Error(`domain_full_recopy_reset_cutover_blocked:${domain}:${status ?? 'missing'}`)
  }
  const reason = reasonInput.slice(0, 1000)
  await control.batch([
    control.prepare(`
      UPDATE data_domain_backfill_cursors
         SET status='running', cursor_json=NULL, rows_copied=0, last_batch_rows=0,
             last_source_checksum=NULL, last_target_checksum=NULL,
             error_code=?, updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND table_name=?
    `).bind(reason, domain, table),
    control.prepare(`
      UPDATE data_domain_parity_checks
         SET status='blocked', source_checksum=NULL, target_checksum=NULL,
             evidence_json=json_object('schema_version', 'data-domain-full-recopy-reset-v1',
                                       'invalidated_reason', ?),
             checked_at=CURRENT_TIMESTAMP
       WHERE domain=? AND table_name=? AND check_kind='full_table'
    `).bind(reason, domain, table),
    control.prepare(`DELETE FROM data_domain_parity_checks WHERE check_id IN (?, ?)`)
      .bind(
        `domain-parity:${domain}:${table}:manifest-progress`,
        `domain-parity:${domain}:${table}:delete-progress`,
      ),
    control.prepare(`
      UPDATE data_domain_cutovers
         SET status='legacy', source_row_count=NULL, target_row_count=NULL,
             source_checksum=NULL, target_checksum=NULL, parity_checked_at=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND status IN ('legacy','shadow')
    `).bind(domain),
  ])
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

export function domainBackfillExactKeyWhere(
  primaryKeys: string[],
  rows: Record<string, unknown>[],
): { sql: string; binds: unknown[] } {
  if (!primaryKeys.length || !rows.length) throw new Error('domain_backfill_exact_keys_empty')
  const clause = `(${primaryKeys.map((key) => `${identifier(key)} IS ?`).join(' AND ')})`
  return {
    sql: `WHERE ${rows.map(() => clause).join(' OR ')}`,
    binds: rows.flatMap((row) => primaryKeys.map((key) => row[key] ?? null)),
  }
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
  evidence_json?: string | null
  checked_at?: string | null
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
  parityNotBefore?: string | null,
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
      || !isAuthoritativeDataDomainFullTableParity(table, row)
      || !isDataDomainFullTableParityFresh(table, row, parityNotBefore)
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

export function parseDomainBackfillCursor(value: unknown): unknown[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = JSON.parse(value)
  if (parsed === null) return null
  if (!Array.isArray(parsed)) throw new Error('domain_backfill_cursor_invalid')
  return parsed
}

export async function backfillDataDomainTableShadow(
  env: Bindings,
  options: {
    domain: DataDomain
    table: string
    limit?: number
    reset?: boolean
    parityNotBefore?: string | null
  },
): Promise<DomainShadowBackfillResult> {
  const domain = options.domain
  const table = String(options.table ?? "").trim().toLowerCase()
  const ownership = tableOwnershipMetadata(table)
  if (ownership?.domain !== domain || !tablesForDataDomainShadowBackfill(domain).includes(table)) {
    throw new Error(`domain_table_ownership_mismatch:${domain}:${table}`)
  }
  const invalidDomains = invalidActiveDataDomains(env)
  if (invalidDomains.length) {
    throw new Error(`data_domain_shadow_active_domain_invalid:${invalidDomains.sort().join(',')}`)
  }
  const domainActive = activeDataDomains(env).has(domain)
  const shadowCutover = await env.DB.prepare(`
    SELECT c.status, w.writer_state
      FROM data_domain_cutovers c
      LEFT JOIN data_domain_writer_epochs w ON w.domain=c.domain
     WHERE c.domain=?
  `).bind(domain).first<{ status?: string; writer_state?: string }>()
  const shadowCutoverStatus = shadowCutover?.status ? String(shadowCutover.status) : null
  const finalizedDeferredRepair = isFinalizedDeferredTableRepairAuthority({
    domainActive,
    routeReady: ownership.route_ready,
    shadowReady: ownership.shadow_ready,
    cutoverStatus: shadowCutoverStatus,
    writerState: shadowCutover?.writer_state ? String(shadowCutover.writer_state) : null,
  })
  if (domainActive && !finalizedDeferredRepair) {
    throw new Error(`data_domain_shadow_requires_inactive_target:${domain}`)
  }
  if (!domainActive && (!shadowCutoverStatus || !['legacy', 'shadow'].includes(shadowCutoverStatus))) {
    throw new Error(
      `domain_shadow_cutover_authority_blocked:${domain}:${shadowCutoverStatus ?? 'missing'}`,
    )
  }
  const learningAuthority: InactiveLearningShadowAuthority | null =
    domain === 'learning' && !finalizedDeferredRepair
      ? assertInactiveLearningShadowAuthority(env)
      : null
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
  const pointerGuard: ExpectedReturnPointerShadowGuard | null =
    domain === 'learning' && table === 'model_champion_pointers'
      ? await beginExpectedReturnPointerShadowGuard(env, target, options.parityNotBefore)
      : null
  const cursorRow = options.reset ? null : await env.DB.prepare(`
    SELECT cursor_json, status FROM data_domain_backfill_cursors WHERE domain=? AND table_name=?
  `).bind(domain, table).first<{ cursor_json?: string | null; status?: string | null }>()
  const cursor = parseDomainBackfillCursor(cursorRow?.cursor_json)
  const keyset = domainBackfillKeysetWhere(primaryKeys, cursor)
  const limit = dataDomainManifestPageLimit(table, domainBackfillBatchLimit(options.limit, table))
  const order = primaryKeys.map(identifier).join(", ")
  const selected = await env.DB.prepare(`
    SELECT ${columns.map(identifier).join(", ")}
      FROM ${identifier(table)}
      ${keyset.sql}
     ORDER BY ${order}
     LIMIT ?
  `).bind(...keyset.binds, limit).all<Record<string, unknown>>()
  const rows = selected.results ?? []
  assertExpectedReturnCandidateIdentityBackfillRows(domain, table, rows)
  if (rows.length) {
    if (domain === 'learning' && isDataDomainControlTable(table)) {
      await invalidateControlTableClosure(env.DB, {
        changedTables: [table],
        preserveCursorTables: [table],
        reason: `control_table_source_rows_changed:${table}`,
        authority: learningAuthority!,
      })
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
       WHERE check_id IN (?, ?)
    `).bind(
      `domain-parity:${domain}:${table}:manifest-progress`,
      `domain-parity:${domain}:${table}:delete-progress`,
    ).run()
  }
  if (!rows.length) {
    const sourceCount = await env.DB.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>()
    const targetCount = await target.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>()
    let sourceRows = Number(sourceCount?.count ?? 0)
    let targetRows = Number(targetCount?.count ?? 0)
    const deleteProgressId = `domain-parity:${domain}:${table}:delete-progress`
    if (targetRows > sourceRows) {
      const progressRow = await env.DB.prepare(`
        SELECT evidence_json FROM data_domain_parity_checks WHERE check_id=?
      `).bind(deleteProgressId).first<{ evidence_json?: string | null }>()
      if (!progressRow) {
        if (domain === 'learning' && isDataDomainControlTable(table)) {
          await invalidateControlTableClosure(env.DB, {
            changedTables: [table],
            preserveCursorTables: [table],
            reason: `target_only_delete_reconciliation_started:${table}`,
            authority: learningAuthority!,
          })
        } else {
          await invalidateGenericManifestProgress(
            env.DB,
            domain,
            table,
            `target_only_delete_reconciliation_started:${domain}:${table}`,
          )
        }
      }
      const progress = parseManifestProgress(progressRow?.evidence_json)
      const reconciliation = await reconcileTargetOnlyPage(
        env.DB,
        target,
        domain,
        table,
        primaryKeys,
        Array.isArray(progress.cursor) ? progress.cursor : null,
        dataDomainManifestPageLimit(table, domainBackfillParityBatchLimit(limit)),
      )
      await assertExpectedReturnPointerSourceStable(env, pointerGuard)
      if (reconciliation.blockedTables.length) {
        const blockers = reconciliation.blockedTables.map(
          (dependent) => `${dependent}:physical_foreign_key_reference`,
        )
        const reason = `target_only_delete_dependency_reset:${blockers.join('|')}`.slice(0, 1000)
        await resetTargetOnlyDependentTables(
          env.DB,
          domain,
          reconciliation.blockedTables,
          reason,
          learningAuthority,
        )
        await deferTargetOnlyDeleteReconciliation(env.DB, {
          domain,
          table,
          cursor: Array.isArray(progress.cursor) ? progress.cursor : null,
          sourceRows,
          targetRows,
          blockers,
          learningAuthority,
        })
        return {
          domain,
          table,
          status: 'shadow_delete_reconciliation_deferred',
          source_rows: sourceRows,
          target_rows: targetRows,
          batch_rows: reconciliation.scanned,
          batch_checksum: null,
          cursor: Array.isArray(progress.cursor) ? progress.cursor : null,
          reconciliation_rows_scanned: Math.max(0, Number(progress.rows_scanned ?? 0)),
          reconciliation_rows_deleted: Math.max(0, Number(progress.repaired_rows ?? 0)),
        }
      }
      const scanned = Math.max(0, Number(progress.rows_scanned ?? 0)) + reconciliation.scanned
      const deleted = Math.max(0, Number(progress.repaired_rows ?? 0)) + reconciliation.deleted
      if (!reconciliation.done) {
        await env.DB.prepare(`
          INSERT INTO data_domain_parity_checks(
            check_id, domain, table_name, check_kind, status, source_count, target_count,
            source_checksum, target_checksum, evidence_json
          ) VALUES (?, ?, ?, 'delete_reconciliation', 'blocked', ?, ?, NULL, NULL, ?)
          ON CONFLICT(check_id) DO UPDATE SET
            status='blocked', source_count=excluded.source_count, target_count=excluded.target_count,
            evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
        `).bind(
          deleteProgressId,
          domain,
          table,
          sourceRows,
          targetRows,
          JSON.stringify({
            schema_version: 'data-domain-shadow-delete-reconciliation-v1',
            cursor: reconciliation.cursor,
            rows_scanned: scanned,
            repaired_rows: deleted,
            expected_source_rows: sourceRows,
          }),
        ).run()
        return {
          domain,
          table,
          status: 'shadow_delete_reconciliation_progress',
          source_rows: sourceRows,
          target_rows: targetRows - reconciliation.deleted,
          batch_rows: reconciliation.scanned,
          batch_checksum: null,
          cursor: reconciliation.cursor,
          reconciliation_rows_scanned: scanned,
          reconciliation_rows_deleted: deleted,
        }
      }
      await env.DB.prepare('DELETE FROM data_domain_parity_checks WHERE check_id=?')
        .bind(deleteProgressId).run()
      const [sourceAfter, targetAfter] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>(),
        target.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`).first<{ count: number | string }>(),
      ])
      sourceRows = Number(sourceAfter?.count ?? 0)
      targetRows = Number(targetAfter?.count ?? 0)
    }
    if (targetRows < sourceRows) {
      await assertExpectedReturnPointerSourceStable(env, pointerGuard)
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE data_domain_backfill_cursors
             SET status='running', cursor_json=NULL, rows_copied=0, last_batch_rows=0,
                 last_source_checksum=NULL, last_target_checksum=NULL,
                 error_code='source_growth_recopy_required', updated_at=CURRENT_TIMESTAMP
           WHERE domain=? AND table_name=?
        `).bind(domain, table),
        env.DB.prepare(`DELETE FROM data_domain_parity_checks WHERE check_id IN (?, ?)`)
          .bind(`domain-parity:${domain}:${table}:manifest-progress`, deleteProgressId),
      ])
      return {
        domain,
        table,
        status: 'shadow_progress',
        source_rows: sourceRows,
        target_rows: targetRows,
        batch_rows: 0,
        batch_checksum: null,
        cursor: null,
      }
    }
    if (sourceRows !== targetRows) throw new Error(`domain_shadow_count_mismatch:${domain}:${table}:${sourceRows}/${targetRows}`)

    const fullChecksumLimit = DATA_DOMAIN_FULL_CHECKSUM_LIMIT
    const controlTableRolling = domain === 'learning' && isDataDomainControlTable(table)
    const semanticControlTable = domain === 'learning'
      && (
        table === 'expected_return_artifact_payloads'
        || table === 'model_champion_history'
      )
    const useRollingManifest = shouldUseRollingDataDomainManifest({
      sourceRows,
      cursorStatus: cursorRow?.status,
      controlTableRolling,
    })
    const columnSql = columns.map(identifier).join(", ")
    let sourceFullChecksum: string | null = null
    let targetFullChecksum: string | null = null
    let actualManifestPageLimit: number | null = null
    let semanticRowsScanned: number | null = null
    let semanticRowsApplicable: number | null = null
    let semanticRowsValidated: number | null = null
    let controlRevisionForReceipt: DataDomainControlRevisionPair | null = null
    let parityStatus: 'pass' | 'blocked' = 'blocked'
    if (!useRollingManifest) {
      actualManifestPageLimit = dataDomainManifestPageLimit(
        table,
        domainBackfillParityBatchLimit(limit),
      )
      const sourceFull = await boundedDataDomainTableManifest({
        db: env.DB, table, columns, primaryKeys,
        pageLimit: actualManifestPageLimit, mode: 'canonical',
      })
      const targetFull = await boundedDataDomainTableManifest({
        db: target, table, columns, primaryKeys,
        pageLimit: actualManifestPageLimit, mode: 'canonical',
      })
      if (sourceFull.rowCount !== sourceRows || targetFull.rowCount !== targetRows) {
        await resetGenericTableForFullRecopy(
          env.DB, domain, table,
          `domain_shadow_source_changed_during_parity:${domain}:${table}`,
        )
        return {
          domain, table, status: 'shadow_progress', source_rows: sourceRows,
          target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
        }
      }
      sourceFullChecksum = sourceFull.checksum
      targetFullChecksum = targetFull.checksum
      if (sourceFullChecksum !== targetFullChecksum) {
        await resetGenericTableForFullRecopy(
          env.DB, domain, table,
          `domain_shadow_full_checksum_recopy_required:${domain}:${table}`,
        )
        return {
          domain, table, status: 'shadow_progress', source_rows: sourceRows,
          target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
        }
      }
      parityStatus = 'pass'
    } else {
      const progressId = `domain-parity:${domain}:${table}:manifest-progress`
      const progressRow = await env.DB.prepare(`
        SELECT evidence_json
          FROM data_domain_parity_checks
         WHERE check_id=?
      `).bind(progressId).first<{ evidence_json?: string }>()
      let progress: ManifestProgressEvidence = {}
      let progressMalformed = false
      try {
        progress = parseManifestProgress(progressRow?.evidence_json)
      } catch {
        progressMalformed = true
      }
      if (
        (progress.expected_source_rows !== undefined && Number(progress.expected_source_rows) !== sourceRows)
        || (progress.expected_target_rows !== undefined && Number(progress.expected_target_rows) !== targetRows)
      ) {
        if (controlTableRolling) {
          await invalidateControlTableClosure(env.DB, {
            changedTables: [table],
            reason: `control_table_source_count_changed:${table}`,
            authority: learningAuthority!,
          })
          return {
            domain, table, status: 'shadow_progress', source_rows: sourceRows,
            target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
          }
        }
        await invalidateGenericManifestProgress(
          env.DB,
          domain,
          table,
          `domain_shadow_source_changed_during_parity:${domain}:${table}`,
        )
        return {
          domain, table, status: 'shadow_parity_progress', source_rows: sourceRows,
          target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
          parity_rows_scanned: 0, parity_rows_repaired: 0,
        }
      }
      const manifestCursor = Array.isArray(progress.cursor) ? progress.cursor : null
      const manifestKeyset = domainBackfillKeysetWhere(primaryKeys, manifestCursor)
      const requestedParityLimit = dataDomainManifestPageLimit(
        table,
        domainBackfillParityBatchLimit(limit),
      )
      const recordedParityLimit = Number(progress.manifest_page_limit ?? 0)
      const parsedProgressRows = nonnegativeSafeInteger(progress.rows_scanned)
      const parsedRepairedRows = nonnegativeSafeInteger(progress.repaired_rows)
      const progressRows = progressRow ? (parsedProgressRows ?? 0) : 0
      const recordedSchema = String(progress.manifest_schema_version ?? '')
      const requiredProgressSchema = controlTableRolling
        ? DATA_DOMAIN_CONTROL_PROGRESS_SCHEMA_VERSION
        : DATA_DOMAIN_SHADOW_SCHEMA_VERSION
      const revisionBeforePage = controlTableRolling
        ? await loadDataDomainControlRevisionPair(env.DB, target, table)
        : null
      const recordedSourceRevision = strictDataDomainControlRevision(
        progress.source_revision_start,
      )
      const recordedTargetRevision = strictDataDomainControlRevision(
        progress.target_revision_observed,
      )
      const invalidProgress = Boolean(progressRow) && (
        progressMalformed
        || (
          parsedProgressRows === null
          || parsedRepairedRows === null
          || parsedRepairedRows > progressRows
          || progressRows < 1
          || !Array.isArray(progress.cursor)
          || progress.cursor.length !== primaryKeys.length
          || !/^[0-9a-f]{64}$/.test(String(progress.source_manifest ?? ''))
          || !/^[0-9a-f]{64}$/.test(String(progress.target_manifest ?? ''))
          || !Number.isInteger(recordedParityLimit)
          || recordedParityLimit < 1
          || recordedParityLimit !== dataDomainManifestPageLimit(table, recordedParityLimit)
          || recordedSchema !== DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION
          || String(progress.schema_version ?? '') !== requiredProgressSchema
          || (controlTableRolling && (
            recordedSourceRevision === null
            || recordedTargetRevision === null
            || recordedSourceRevision !== revisionBeforePage?.sourceRevision
            || recordedTargetRevision !== revisionBeforePage?.targetRevision
          ))
          || (semanticControlTable && (() => {
            const scanned = nonnegativeSafeInteger(progress.semantic_rows_scanned)
            const applicable = nonnegativeSafeInteger(progress.semantic_rows_applicable)
            const validated = nonnegativeSafeInteger(progress.semantic_rows_validated)
            return String(progress.semantic_validation_schema_version ?? '')
                !== DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION
              || scanned !== progressRows
              || applicable === null
              || validated === null
              || applicable !== validated
              || applicable > progressRows
          })())
        )
      )
      if (invalidProgress) {
        if (controlTableRolling) {
          await invalidateControlTableClosure(env.DB, {
            changedTables: [table],
            preserveCursorTables: [table],
            reason: `control_table_manifest_progress_invalid:${table}`,
            authority: learningAuthority!,
          })
          return {
            domain, table, status: 'shadow_parity_progress', source_rows: sourceRows,
            target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
            parity_rows_scanned: 0, parity_rows_repaired: 0,
          }
        }
        await invalidateGenericManifestProgress(
          env.DB,
          domain,
          table,
          `domain_shadow_manifest_progress_invalid:${domain}:${table}`,
        )
        return {
          domain, table, status: 'shadow_parity_progress', source_rows: sourceRows,
          target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
          parity_rows_scanned: 0, parity_rows_repaired: 0,
        }
      }
      const sourceRevisionStart = controlTableRolling
        ? (progressRow ? recordedSourceRevision! : revisionBeforePage!.sourceRevision)
        : null
      const targetRevisionObserved = controlTableRolling
        ? (progressRow ? recordedTargetRevision! : revisionBeforePage!.targetRevision)
        : null
      const parityLimit = domainBackfillResumeParityBatchLimit(
        progressRows,
        recordedParityLimit,
        requestedParityLimit,
      )
      actualManifestPageLimit = parityLimit
      const sourcePageResult = await env.DB.prepare(`
        SELECT ${columnSql}
          FROM ${identifier(table)}
          ${manifestKeyset.sql}
         ORDER BY ${order}
         LIMIT ?
      `).bind(...manifestKeyset.binds, parityLimit).all<Record<string, unknown>>()
      const sourcePage = sourcePageResult.results ?? []
      const rowsScanned = progressRows
      const repairedRows = progressRow ? parsedRepairedRows! : 0

      if (sourcePage.length) {
        const semanticPage = await validateExpectedReturnControlSemanticPage(
          env.DB,
          table,
          sourcePage,
        )
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
        const pageNeededRepair = sourcePageChecksum !== targetPageChecksum
        if (pageNeededRepair) {
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
        await assertExpectedReturnPointerSourceStable(env, pointerGuard)
        const revisionAfterPage = controlTableRolling
          ? await loadDataDomainControlRevisionPair(env.DB, target, table)
          : null
        if (controlTableRolling) {
          const expectedTargetRevision = revisionBeforePage!.targetRevision
            + (pageNeededRepair ? sourcePage.length : 0)
          if (
            revisionAfterPage!.sourceRevision !== sourceRevisionStart
            || revisionAfterPage!.targetRevision !== expectedTargetRevision
          ) {
            await invalidateControlTableClosure(env.DB, {
              changedTables: [table],
              preserveCursorTables: [table],
              reason: `control_table_revision_drift_during_manifest:${table}:${sourceRevisionStart}/${revisionAfterPage!.sourceRevision}:${expectedTargetRevision}/${revisionAfterPage!.targetRevision}`,
              authority: learningAuthority!,
            })
            return {
              domain, table, status: 'shadow_parity_progress', source_rows: sourceRows,
              target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
              parity_rows_scanned: 0, parity_rows_repaired: 0,
            }
          }
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
          schema_version: requiredProgressSchema,
          parity_scope: 'resumable_full_table_manifest',
          cursor: nextManifestCursor,
          rows_scanned: nextRowsScanned,
          repaired_rows: nextRepairedRows,
          expected_source_rows: sourceRows,
          expected_target_rows: targetRows,
          source_manifest: sourceManifest,
          target_manifest: targetManifest,
          manifest_schema_version: DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
          manifest_page_limit: parityLimit,
          ...(controlTableRolling ? {
            source_revision_start: sourceRevisionStart,
            target_revision_observed: revisionAfterPage!.targetRevision,
          } : {}),
          ...(semanticControlTable ? {
            semantic_validation_schema_version: semanticPage.schemaVersion,
            semantic_rows_scanned: Number(progress.semantic_rows_scanned ?? 0)
              + semanticPage.rowsScanned,
            semantic_rows_applicable: Number(progress.semantic_rows_applicable ?? 0)
              + semanticPage.rowsApplicable,
            semantic_rows_validated: Number(progress.semantic_rows_validated ?? 0)
              + semanticPage.rowsValidated,
          } : {}),
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

      if (
        sourceRows === 0
        && rowsScanned === 0
        && !progress.source_manifest
        && !progress.target_manifest
      ) {
        const emptyChecksum = await checksumRows([], columns)
        progress.source_manifest = await domainBackfillRollingManifest(null, emptyChecksum, 0)
        progress.target_manifest = progress.source_manifest
        if (semanticControlTable) {
          progress.semantic_validation_schema_version =
            DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION
          progress.semantic_rows_scanned = 0
          progress.semantic_rows_applicable = 0
          progress.semantic_rows_validated = 0
        }
      }
      const revisionBeforeFinalCounts = controlTableRolling
        ? await loadDataDomainControlRevisionPair(env.DB, target, table)
        : null
      const [sourceCountAfterManifest, targetCountAfterManifest] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`)
          .first<{ count?: number | string }>(),
        target.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`)
          .first<{ count?: number | string }>(),
      ])
      const finalSourceCount = nonnegativeSafeInteger(sourceCountAfterManifest?.count)
      const finalTargetCount = nonnegativeSafeInteger(targetCountAfterManifest?.count)
      const revisionAfterFinalCounts = controlTableRolling
        ? await loadDataDomainControlRevisionPair(env.DB, target, table)
        : null
      const revisionDrift = controlTableRolling && (
        revisionBeforeFinalCounts!.sourceRevision !== sourceRevisionStart
        || revisionBeforeFinalCounts!.targetRevision !== targetRevisionObserved
        || revisionAfterFinalCounts!.sourceRevision !== sourceRevisionStart
        || revisionAfterFinalCounts!.targetRevision !== targetRevisionObserved
      )
      const finalCountBlockers = domainBackfillFinalCountFenceBlockers({
        expectedSourceRows: sourceRows,
        expectedTargetRows: targetRows,
        liveSourceRows: finalSourceCount,
        liveTargetRows: finalTargetCount,
      })
      if (revisionDrift || finalCountBlockers.length) {
        const reason = [
          `domain_shadow_live_count_drift_before_receipt:${domain}:${table}:${finalCountBlockers.join(',') || 'revision_only'}`,
          ...(revisionDrift ? [
            `control_table_revision_drift_before_receipt:${table}:${sourceRevisionStart}/${revisionAfterFinalCounts!.sourceRevision}:${targetRevisionObserved}/${revisionAfterFinalCounts!.targetRevision}`,
          ] : []),
        ].join('|')
        if (controlTableRolling) {
          await invalidateControlTableClosure(env.DB, {
            changedTables: [table],
            preserveCursorTables: [table],
            reason,
            authority: learningAuthority!,
          })
        } else {
          await invalidateGenericManifestProgress(env.DB, domain, table, reason)
        }
        return {
          domain, table, status: 'shadow_parity_progress', source_rows: sourceRows,
          target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
          parity_rows_scanned: 0, parity_rows_repaired: 0,
        }
      }
      if (controlTableRolling) controlRevisionForReceipt = revisionAfterFinalCounts
      if (rowsScanned !== sourceRows || !progress.source_manifest || !progress.target_manifest) {
        throw new Error(`domain_shadow_manifest_incomplete:${domain}:${table}:${rowsScanned}/${sourceRows}`)
      }
      if (progress.source_manifest !== progress.target_manifest) {
        throw new Error(`domain_shadow_manifest_mismatch:${domain}:${table}`)
      }
      const finalSemanticScanned = nonnegativeSafeInteger(progress.semantic_rows_scanned)
      const finalSemanticApplicable = nonnegativeSafeInteger(progress.semantic_rows_applicable)
      const finalSemanticValidated = nonnegativeSafeInteger(progress.semantic_rows_validated)
      if (semanticControlTable && (
        progress.semantic_validation_schema_version
          !== DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION
        || finalSemanticScanned !== sourceRows
        || finalSemanticApplicable === null
        || finalSemanticValidated === null
        || finalSemanticApplicable !== finalSemanticValidated
        || finalSemanticApplicable > sourceRows
      )) {
        throw new Error(
          `expected_return_control_semantic_incomplete:${table}:${String(
            progress.semantic_rows_validated ?? 'missing',
          )}/${sourceRows}`,
        )
      }
      if (semanticControlTable) {
        semanticRowsScanned = Number(progress.semantic_rows_scanned ?? -1)
        semanticRowsApplicable = Number(progress.semantic_rows_applicable ?? -1)
        semanticRowsValidated = Number(progress.semantic_rows_validated ?? -1)
      }
      await assertExpectedReturnPointerTargetClosure(env, target, pointerGuard)
      sourceFullChecksum = progress.source_manifest
      targetFullChecksum = progress.target_manifest
      actualManifestPageLimit = parityLimit
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
        schema_version: controlTableRolling
          ? DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION
          : DATA_DOMAIN_SHADOW_SCHEMA_VERSION,
        parity_scope: useRollingManifest ? 'resumable_full_table_manifest' : 'full_table_checksum',
        full_checksum_limit: fullChecksumLimit,
        manifest_schema_version: useRollingManifest
          ? DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION
          : DATA_DOMAIN_DIRECT_MANIFEST_SCHEMA_VERSION,
        manifest_page_limit: actualManifestPageLimit,
        ...(controlTableRolling ? dataDomainControlRevisionEvidence(
          controlRevisionForReceipt!,
        ) : {}),
        ...(semanticControlTable ? {
          semantic_validation_schema_version:
            DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
          semantic_validation_status: 'pass',
          semantic_rows_scanned: semanticRowsScanned,
          semantic_rows_applicable: semanticRowsApplicable,
          semantic_rows_validated: semanticRowsValidated,
        } : {}),
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
    if (controlTableRolling) {
      const postReceiptRevision = await loadDataDomainControlRevisionPair(env.DB, target, table)
      const revisionBlockers = dataDomainControlRevisionBlockers({
        receipt: {
          evidence_json: JSON.stringify(dataDomainControlRevisionEvidence(
            controlRevisionForReceipt!,
          )),
        },
        live: postReceiptRevision,
      })
      if (revisionBlockers.length) {
        await invalidateControlTableClosure(env.DB, {
          changedTables: [table],
          preserveCursorTables: [table],
          reason: `control_table_revision_drift_after_receipt:${table}:${revisionBlockers.join('|')}`,
          authority: learningAuthority!,
        })
        return {
          domain, table, status: 'shadow_parity_progress', source_rows: sourceRows,
          target_rows: targetRows, batch_rows: 0, batch_checksum: null, cursor: null,
          parity_rows_scanned: 0, parity_rows_repaired: 0,
        }
      }
    }
    const ownedTables = tablesForDataDomainShadowBackfill(domain)
    const completedResult = await env.DB.prepare(`
      SELECT table_name
        FROM data_domain_backfill_cursors
       WHERE domain=? AND status='complete'
    `).bind(domain).all<{ table_name: string }>()
    const parityResult = await env.DB.prepare(`
      SELECT table_name, status, source_count, target_count, source_checksum, target_checksum,
             evidence_json, checked_at
        FROM data_domain_parity_checks
       WHERE domain=? AND check_kind='full_table'
       ORDER BY checked_at DESC
    `).bind(domain).all<DomainAggregateParityRow>()
    const completedTables = (completedResult.results ?? []).map((row) => String(row.table_name))
    const parityRows = parityResult.results ?? []
    if (finalizedDeferredRepair) {
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
        domain_shadow_ready: false,
      }
    }
    const liveRevisionReady = new Set<string>()
    if (domain === 'learning') {
      for (const controlTable of ownedTables.filter(isDataDomainControlTable)) {
        const receipt = parityRows.find((row) => row.table_name === controlTable)
        if (!receipt) continue
        const live = await loadDataDomainControlRevisionPair(env.DB, target, controlTable)
        if (!dataDomainControlRevisionBlockers({ receipt, live }).length) {
          liveRevisionReady.add(controlTable)
        }
      }
    }
    const parityTables = parityRows
      .filter((row) => (
        isAuthoritativeDataDomainFullTableParity(row.table_name, row)
        && isDataDomainFullTableParityFresh(row.table_name, row, options.parityNotBefore)
        && (
          domain !== 'learning'
          || !isDataDomainControlTable(row.table_name)
          || liveRevisionReady.has(row.table_name)
        )
      ))
      .map((row) => String(row.table_name))
    const copyAndTableParityReady = isDomainShadowCutoverReady(
      ownedTables,
      completedTables,
      parityTables,
    )
    const aggregateSnapshot = copyAndTableParityReady
      ? await buildDataDomainAggregateParitySnapshot(
        ownedTables,
        parityRows,
        options.parityNotBefore,
      )
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
  const invalidatedAncestors = new Set<string>()
  await syncForeignKeyAncestors(
    env.DB,
    target,
    domain,
    table,
    rows,
    primaryKeys,
    async (ancestorTable) => {
      if (invalidatedAncestors.has(ancestorTable)) return
      invalidatedAncestors.add(ancestorTable)
      if (domain === 'learning' && isDataDomainControlTable(ancestorTable)) {
        await invalidateControlTableClosure(env.DB, {
          changedTables: [ancestorTable],
          preserveCursorTables: [ancestorTable],
          reason: `foreign_key_ancestor_sync:${table}:${ancestorTable}`,
          authority: learningAuthority!,
        })
      } else {
        await invalidateGenericManifestProgress(
          env.DB,
          domain,
          ancestorTable,
          `foreign_key_ancestor_sync:${table}:${ancestorTable}`,
        )
      }
    },
  )
  await upsertDomainRows(target, table, columns, primaryKeys, rows)
  const targetRows: Record<string, unknown>[] = []
  const verifyStatements: D1PreparedStatement[] = []
  const exactKeyRowsPerStatement = domainBackfillExactKeyRowsPerStatement(primaryKeys.length)
  for (let offset = 0; offset < rows.length; offset += exactKeyRowsPerStatement) {
    const exactKeys = domainBackfillExactKeyWhere(
      primaryKeys,
      rows.slice(offset, offset + exactKeyRowsPerStatement),
    )
    verifyStatements.push(target.prepare(`
      SELECT ${columnSql} FROM ${identifier(table)}
       ${exactKeys.sql}
       ORDER BY ${order}
    `).bind(...exactKeys.binds))
  }
  for (let offset = 0; offset < verifyStatements.length; offset += 50) {
    const verified = await target.batch<Record<string, unknown>>(
      verifyStatements.slice(offset, offset + 50),
    )
    for (const result of verified) targetRows.push(...(result.results ?? []))
  }
  const sourceChecksum = await checksumRows(rows, columns)
  const targetChecksum = await checksumRows(targetRows, columns)
  if (sourceChecksum !== targetChecksum) throw new Error(`domain_shadow_checksum_mismatch:${domain}:${table}`)
  await assertExpectedReturnPointerSourceStable(env, pointerGuard)
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
