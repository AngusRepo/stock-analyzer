import type { Bindings } from '../types'
import { activeDataDomains, invalidActiveDataDomains } from './dataDomainRegistry'
import {
  boundedDataDomainTableManifest,
  DATA_DOMAIN_FULL_CHECKSUM_LIMIT,
  dataDomainManifestPageLimit,
  type DataDomainControlTable,
  isAuthoritativeDataDomainFullTableParity,
  isDataDomainFullTableParityFresh,
  isDataDomainControlTable,
} from './dataDomainShadowManifest'

export type InactiveLearningShadowAuthority = {
  readonly domain: 'learning'
  readonly strict: false
  readonly active: false
}

export function assertInactiveLearningShadowAuthority(
  env: Bindings,
): InactiveLearningShadowAuthority {
  const invalidDomains = invalidActiveDataDomains(env)
  if (invalidDomains.length) {
    throw new Error(`data_domain_shadow_active_domain_invalid:${invalidDomains.sort().join(',')}`)
  }
  if (String(env.MULTI_D1_STRICT ?? '').trim().toLowerCase() === 'true') {
    throw new Error('data_domain_shadow_requires_strict_disabled:learning')
  }
  if (activeDataDomains(env).has('learning')) {
    throw new Error('data_domain_shadow_requires_inactive_target:learning')
  }
  return { domain: 'learning', strict: false, active: false }
}

type TableColumn = { cid: number; name: string; type: string; notnull: number; pk: number }
type TableShape = {
  columns: string[]
  primaryKeys: string[]
  normalized: Array<{ name: string; type: string; notnull: number; pk: number }>
}

export type ControlTableCursorReceipt = {
  status: string
  cursor_json: string | null
  rows_copied: number | string | null
  last_source_checksum: string | null
  last_target_checksum: string | null
}

export type ControlTableParityReceipt = {
  status: string
  source_count: number | string | null
  target_count: number | string | null
  source_checksum: string | null
  target_checksum: string | null
  evidence_json: string | null
  checked_at: string | null
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid_sql_identifier:${value}`)
  return `"${value}"`
}

function strictNonnegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseEvidence(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function isLegacyDirectControlReceipt(
  receipt: ControlTableParityReceipt | null,
): boolean {
  const evidence = parseEvidence(receipt?.evidence_json)
  const sourceCount = strictNonnegativeInteger(receipt?.source_count)
  const targetCount = strictNonnegativeInteger(receipt?.target_count)
  return Boolean(
    receipt
    && receipt.status === 'pass'
    && sourceCount != null
    && targetCount != null
    && sourceCount === targetCount
    && /^[0-9a-f]{64}$/.test(String(receipt.source_checksum ?? ''))
    && receipt.source_checksum === receipt.target_checksum
    && evidence?.parity_scope === 'full_table_checksum',
  )
}

async function tableCount(db: D1Database, table: DataDomainControlTable): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) count FROM ${identifier(table)}`)
    .first<{ count?: number | string }>()
  const count = strictNonnegativeInteger(row?.count)
  if (count == null) throw new Error(`control_table_count_invalid:${table}`)
  return count
}

async function tableShape(db: D1Database, table: DataDomainControlTable): Promise<TableShape> {
  const result = await db.prepare(`PRAGMA table_info(${identifier(table)})`).all<TableColumn>()
  const ordered = [...(result.results ?? [])].sort((left, right) => Number(left.cid) - Number(right.cid))
  const primaryKeys = ordered.filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => String(column.name))
  if (!ordered.length || !primaryKeys.length) throw new Error(`control_table_shape_missing:${table}`)
  return {
    columns: ordered.map((column) => String(column.name)),
    primaryKeys,
    normalized: ordered.map((column) => ({
      name: String(column.name),
      type: String(column.type ?? '').toUpperCase(),
      notnull: Number(column.notnull),
      pk: Number(column.pk),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  }
}

function sameShape(source: TableShape, target: TableShape): boolean {
  return JSON.stringify(source.primaryKeys) === JSON.stringify(target.primaryKeys)
    && JSON.stringify(source.normalized) === JSON.stringify(target.normalized)
}

export async function loadControlTableReceipt(
  control: D1Database,
  table: DataDomainControlTable,
): Promise<{ cursor: ControlTableCursorReceipt | null; parity: ControlTableParityReceipt | null }> {
  const [cursor, parity] = await Promise.all([
    control.prepare(`
      SELECT status, cursor_json, rows_copied, last_source_checksum, last_target_checksum
        FROM data_domain_backfill_cursors
       WHERE domain='learning' AND table_name=?
    `).bind(table).first<ControlTableCursorReceipt>(),
    control.prepare(`
      SELECT status, source_count, target_count, source_checksum, target_checksum,
             evidence_json, checked_at
        FROM data_domain_parity_checks
       WHERE domain='learning' AND table_name=? AND check_kind='full_table'
       ORDER BY checked_at DESC, check_id DESC LIMIT 1
    `).bind(table).first<ControlTableParityReceipt>(),
  ])
  return { cursor: cursor ?? null, parity: parity ?? null }
}

export function controlTableReceiptBlockers(input: {
  table: DataDomainControlTable
  cursor: ControlTableCursorReceipt | null
  parity: ControlTableParityReceipt | null
  parityNotBefore?: string | null
}): string[] {
  const blockers: string[] = []
  if (!input.cursor) blockers.push('cursor_missing')
  else {
    if (input.cursor.status !== 'complete') blockers.push(`cursor_status:${input.cursor.status}`)
    if (strictNonnegativeInteger(input.cursor.rows_copied)
        !== strictNonnegativeInteger(input.parity?.source_count)) {
      blockers.push('cursor_rows_stale')
    }
    if (input.cursor.last_source_checksum !== input.parity?.source_checksum) {
      blockers.push('cursor_source_checksum_stale')
    }
    if (input.cursor.last_target_checksum !== input.parity?.target_checksum) {
      blockers.push('cursor_target_checksum_stale')
    }
  }
  if (!isAuthoritativeDataDomainFullTableParity(input.table, input.parity)) {
    blockers.push('authoritative_control_receipt_missing')
  } else if (!isDataDomainFullTableParityFresh(
    input.table,
    input.parity,
    input.parityNotBefore,
  )) {
    blockers.push('authoritative_control_receipt_stale_for_session')
  }
  return blockers
}

export async function controlTableRowCounts(
  sourceDb: D1Database,
  targetDb: D1Database,
  table: DataDomainControlTable,
): Promise<{ sourceCount: number; targetCount: number }> {
  const [sourceCount, targetCount] = await Promise.all([
    tableCount(sourceDb, table),
    tableCount(targetDb, table),
  ])
  return { sourceCount, targetCount }
}

export async function verifyLegacyDirectControlReceipt(
  control: D1Database,
  sourceDb: D1Database,
  targetDb: D1Database,
  tableInput: string,
): Promise<{ exact: boolean; blockers: string[] }> {
  if (!isDataDomainControlTable(tableInput)) throw new Error(`control_table_not_allowed:${tableInput}`)
  const table = tableInput
  const [sourceCount, targetCount, sourceShape, targetShape, receipt] = await Promise.all([
    tableCount(sourceDb, table),
    tableCount(targetDb, table),
    tableShape(sourceDb, table),
    tableShape(targetDb, table),
    loadControlTableReceipt(control, table),
  ])
  const blockers: string[] = []
  if (!sameShape(sourceShape, targetShape)) blockers.push('schema_mismatch')
  if (sourceCount !== targetCount) blockers.push('live_count_mismatch')
  if (!isLegacyDirectControlReceipt(receipt.parity)) blockers.push('legacy_direct_receipt_invalid')
  if (sourceCount > DATA_DOMAIN_FULL_CHECKSUM_LIMIT) {
    blockers.push(`legacy_direct_row_limit_exceeded:${sourceCount}`)
  }
  if (
    receipt.cursor?.status !== 'complete'
    || strictNonnegativeInteger(receipt.cursor.rows_copied) !== sourceCount
  ) blockers.push('legacy_cursor_invalid')
  let sourceChecksum: string | null = null
  let targetChecksum: string | null = null
  if (!blockers.length) {
    const pageLimit = dataDomainManifestPageLimit(table, 4000)
    const source = await boundedDataDomainTableManifest({
      db: sourceDb,
      table,
      columns: sourceShape.columns,
      primaryKeys: sourceShape.primaryKeys,
      pageLimit,
      mode: 'canonical',
    })
    if (source.rowCount !== sourceCount) blockers.push('source_count_drift')
    else sourceChecksum = source.checksum
    if (!blockers.length) {
      const target = await boundedDataDomainTableManifest({
        db: targetDb,
        table,
        columns: sourceShape.columns,
        primaryKeys: sourceShape.primaryKeys,
        pageLimit,
        mode: 'canonical',
      })
      if (target.rowCount !== targetCount) blockers.push('target_count_drift')
      else targetChecksum = target.checksum
    }
  }
  if (sourceChecksum && sourceChecksum !== targetChecksum) blockers.push('live_checksum_mismatch')
  if (sourceChecksum && receipt.cursor?.last_source_checksum !== sourceChecksum) {
    blockers.push('cursor_source_checksum_stale')
  }
  if (targetChecksum && receipt.cursor?.last_target_checksum !== targetChecksum) {
    blockers.push('cursor_target_checksum_stale')
  }
  if (sourceChecksum && receipt.parity?.source_checksum !== sourceChecksum) {
    blockers.push('parity_source_checksum_stale')
  }
  if (targetChecksum && receipt.parity?.target_checksum !== targetChecksum) {
    blockers.push('parity_target_checksum_stale')
  }
  return { exact: blockers.length === 0, blockers: [...new Set(blockers)] }
}

export async function invalidateControlTableClosure(
  control: D1Database,
  input: {
    changedTables: readonly DataDomainControlTable[]
    preserveCursorTables?: readonly DataDomainControlTable[]
    reason: string
    authority: InactiveLearningShadowAuthority
  },
): Promise<void> {
  if (
    input.authority.domain !== 'learning'
    || input.authority.strict !== false
    || input.authority.active !== false
  ) throw new Error('control_table_invalidation_authority_invalid')
  const cutover = await control.prepare(`
    SELECT status FROM data_domain_cutovers WHERE domain='learning'
  `).first<{ status?: string }>()
  const status = cutover?.status ? String(cutover.status) : null
  if (!status || !['legacy', 'shadow'].includes(status)) {
    throw new Error(`control_table_invalidation_cutover_blocked:${status ?? 'missing'}`)
  }
  const tables = [...new Set<DataDomainControlTable>([
    ...input.changedTables,
    'model_champion_pointers',
  ])]
  const preserve = new Set(input.preserveCursorTables ?? [])
  if (!input.changedTables.includes('model_champion_pointers')) {
    preserve.add('model_champion_pointers')
  }
  const reason = input.reason.slice(0, 1000)
  const statements: D1PreparedStatement[] = []
  for (const table of tables) {
    if (preserve.has(table)) {
      statements.push(control.prepare(`
        UPDATE data_domain_backfill_cursors
           SET last_batch_rows=0,
               last_source_checksum=NULL, last_target_checksum=NULL,
               error_code=?, updated_at=CURRENT_TIMESTAMP
         WHERE domain='learning' AND table_name=?
      `).bind(reason, table))
    } else {
      statements.push(control.prepare(`
        INSERT INTO data_domain_backfill_cursors(
          domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
          last_source_checksum, last_target_checksum, error_code, updated_at
        ) VALUES ('learning', ?, 'running', NULL, 0, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(domain,table_name) DO UPDATE SET
          status='running', cursor_json=NULL, rows_copied=0, last_batch_rows=0,
          last_source_checksum=NULL, last_target_checksum=NULL,
          error_code=excluded.error_code, updated_at=CURRENT_TIMESTAMP
      `).bind(table, reason))
    }
    statements.push(
      control.prepare(`
        INSERT INTO data_domain_parity_checks(
          check_id, domain, table_name, check_kind, status, source_count, target_count,
          source_checksum, target_checksum, evidence_json
        ) VALUES (?, 'learning', ?, 'full_table', 'blocked', NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(check_id) DO UPDATE SET
          status='blocked', source_count=NULL, target_count=NULL,
          source_checksum=NULL, target_checksum=NULL,
          evidence_json=excluded.evidence_json, checked_at=CURRENT_TIMESTAMP
      `).bind(
        `domain-parity:learning:${table}:full-table`,
        table,
        JSON.stringify({
          schema_version: 'data-domain-control-table-invalidation-v1',
          invalidated_reason: reason,
        }),
      ),
      control.prepare(`
        DELETE FROM data_domain_parity_checks WHERE check_id IN (?, ?)
      `).bind(
        `domain-parity:learning:${table}:manifest-progress`,
        `domain-parity:learning:${table}:delete-progress`,
      ),
    )
  }
  statements.push(control.prepare(`
    UPDATE data_domain_cutovers
       SET status='legacy', source_row_count=NULL, target_row_count=NULL,
           source_checksum=NULL, target_checksum=NULL, parity_checked_at=NULL,
           updated_at=CURRENT_TIMESTAMP
     WHERE domain='learning' AND status IN ('legacy','shadow')
  `))
  await control.batch(statements)
}
