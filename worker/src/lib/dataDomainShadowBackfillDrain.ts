import type { Bindings, UpdateQueueMsg } from '../types'
import {
  backfillDataDomainTableShadow,
  buildDataDomainAggregateParitySnapshot,
  invalidateGenericManifestProgress,
  isDomainShadowCutoverReady,
  type DomainShadowBackfillResult,
} from './dataDomainShadowBackfill'
import {
  activeDataDomains,
  invalidActiveDataDomains,
  shadowDatabaseForDataDomain,
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'
import {
  assertInactiveLearningShadowAuthority,
  controlTableReceiptBlockers,
  controlTableRowCounts,
  invalidateControlTableClosure,
  isLegacyDirectControlReceipt,
  loadControlTableReceipt,
  verifyLegacyDirectControlReceipt,
} from './dataDomainControlTableParity'
import {
  isAuthoritativeDataDomainFullTableParity,
  isDataDomainControlTable,
  isDataDomainFullTableParityFresh,
} from './dataDomainShadowManifest'
import {
  dataDomainControlRevisionBlockers,
  loadDataDomainControlRevisionPair,
} from './dataDomainControlRevision'
import { runWithMaintenanceLease } from './maintenanceLease'
import { twDaysAgo } from './dateUtils'
import { logSchedulerResult, type SchedulerRunLogEntry } from './schedulerRunLogger'
import { dataDomainShadowBackfillActiveKey } from './dataDomainShadowSession'
import {
  beginDataDomainWriterQuiescence,
  readDataDomainWriterEpochSnapshot,
  reopenDataDomainWriters,
} from './dataDomainWriterEpoch'

const ACTIVE_TTL_SECONDS = 6 * 3600
const DEFAULT_MAX_ATTEMPTS = 5000
const MAX_ATTEMPTS = 20_000
const STALE_PROGRESS_MS = 5 * 60 * 1000
const SHADOW_BACKFILL_QUEUE_BATCH_LIMIT = 50

type DataDomainShadowMutationAuthority = {
  domain: DataDomain
  cutoverStatus: 'legacy' | 'shadow'
}

function isDataDomainShadowAuthorityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /^(data_domain_shadow_active_domain_invalid|data_domain_shadow_requires_inactive_target|data_domain_shadow_requires_strict_disabled|data_domain_shadow_authority_mismatch|domain_shadow_cutover_authority_blocked|domain_manifest_invalidation_cutover_blocked|domain_cutover_source_changed|domain_cutover_inconsistent|control_table_invalidation_cutover_blocked|data_domain_control_revision_|expected_return_pointer_shadow_guard_)/.test(message)
}

async function assertDataDomainShadowMutationAuthority(
  env: Bindings,
  domain: DataDomain,
): Promise<DataDomainShadowMutationAuthority> {
  const invalidDomains = invalidActiveDataDomains(env)
  if (invalidDomains.length) {
    throw new Error(`data_domain_shadow_active_domain_invalid:${invalidDomains.sort().join(',')}`)
  }
  if (String(env.MULTI_D1_STRICT ?? '').trim().toLowerCase() === 'true') {
    throw new Error(`data_domain_shadow_requires_strict_disabled:${domain}`)
  }
  if (activeDataDomains(env).has(domain)) {
    throw new Error(`data_domain_shadow_requires_inactive_target:${domain}`)
  }
  const cutover = await env.DB.prepare(`
    SELECT status FROM data_domain_cutovers WHERE domain=?
  `).bind(domain).first<{ status?: string }>()
  const status = cutover?.status ? String(cutover.status) : null
  if (status !== 'legacy' && status !== 'shadow') {
    throw new Error(`domain_shadow_cutover_authority_blocked:${domain}:${status ?? 'missing'}`)
  }
  return { domain, cutoverStatus: status }
}

export function dataDomainParitySessionWatermark(nowMs = Date.now()): string {
  return new Date(Math.floor(nowMs / 1000) * 1000).toISOString()
}

type ActiveState = {
  run_id: string
  started_at: string | null
}

function parseActiveState(value: string): ActiveState {
  try {
    const parsed = JSON.parse(value) as Partial<ActiveState>
    if (typeof parsed.run_id === 'string' && parsed.run_id.trim()) {
      return { run_id: parsed.run_id, started_at: typeof parsed.started_at === 'string' ? parsed.started_at : null }
    }
  } catch {}
  return { run_id: value, started_at: null }
}

export function isDataDomainShadowProgressStale(
  activeStartedAt: string | null,
  progressUpdatedAt: string | null,
  nowMs = Date.now(),
): boolean {
  const reference = progressUpdatedAt || activeStartedAt
  if (!reference) return false
  const referenceMs = Date.parse(reference)
  return Number.isFinite(referenceMs) && nowMs - referenceMs >= STALE_PROGRESS_MS
}
function progressKey(domain: DataDomain): string {
  return `data-domain-shadow-backfill:${domain}:progress`
}

function incrementalScanKey(domain: DataDomain): string {
  return `data-domain-shadow-backfill:${domain}:incremental-scan`
}

function queueMessage(input: {
  domain: DataDomain
  table?: string
  requestedTable?: string
  runDate: string
  runId: string
  attempt: number
  maxAttempts: number
  errorAttempt?: number
  parityNotBefore: string
  globalSweep?: boolean
}): UpdateQueueMsg {
  return {
    type: 'data_domain_shadow_backfill',
    cursor: 0,
    triggerTime: input.runDate,
    runId: input.runId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    dataDomainErrorAttempt: input.errorAttempt,
    dataDomain: input.domain,
    dataDomainTable: input.table,
    dataDomainRequestedTable: input.requestedTable,
    dataDomainParityNotBefore: input.parityNotBefore,
    dataDomainGlobalSweep: input.globalSweep,
  }
}

export function resolveDataDomainShadowBackfillContinuation(
  requestedTable: string | undefined,
  status: DomainShadowBackfillResult['status'],
): 'same_table' | 'requested_table_complete' | 'requested_table_dependency_blocked' | 'next_domain_table' {
  if (status === 'shadow_delete_reconciliation_deferred') {
    return requestedTable ? 'requested_table_dependency_blocked' : 'next_domain_table'
  }
  if (status !== 'shadow_table_complete') return 'same_table'
  if (
    requestedTable
    && [
      'expected_return_artifact_payloads',
      'model_champion_history',
      'model_champion_pointers',
    ].includes(requestedTable)
  ) return 'requested_table_dependency_blocked'
  return requestedTable ? 'requested_table_complete' : 'next_domain_table'
}

export function shouldContinueDataDomainGlobalSweep(input: {
  globalSweep: boolean
  requestedTable?: string
  domainShadowReady: boolean
}): boolean {
  return input.globalSweep && !input.requestedTable && input.domainShadowReady
}

async function completedDomainTables(env: Bindings, domain: DataDomain): Promise<string[]> {
  const completed = await env.DB.prepare(`
    SELECT table_name
      FROM data_domain_backfill_cursors
     WHERE domain=? AND status='complete'
  `).bind(domain).all<{ table_name: string }>()
  return (completed.results ?? []).map((row) => String(row.table_name))
}

async function nextIncompleteTable(env: Bindings, domain: DataDomain): Promise<string | null> {
  const completedSet = new Set(await completedDomainTables(env, domain))
  return tablesForDataDomainShadowBackfill(domain).find((table) => !completedSet.has(table)) ?? null
}

async function nextDataDomainReceiptRefreshTable(
  env: Bindings,
  domain: DataDomain,
  parityNotBefore?: string | null,
): Promise<string | null> {
  const completedSet = new Set(await completedDomainTables(env, domain))
  const receipts = await env.DB.prepare(`
    SELECT table_name, status, source_count, target_count,
           source_checksum, target_checksum, evidence_json, checked_at
      FROM data_domain_parity_checks
     WHERE domain=? AND check_kind='full_table'
     ORDER BY checked_at DESC, check_id DESC
  `).bind(domain).all<{
    table_name: string
    status?: string | null
    source_count?: number | string | null
    target_count?: number | string | null
    source_checksum?: string | null
    target_checksum?: string | null
    evidence_json?: string | null
    checked_at?: string | null
  }>()
  const latest = new Map<string, typeof receipts.results[number]>()
  for (const receipt of receipts.results ?? []) {
    const table = String(receipt.table_name)
    if (!latest.has(table)) latest.set(table, receipt)
  }
  for (const table of tablesForDataDomainShadowBackfill(domain)) {
    if (!completedSet.has(table)) return table
    const receipt = latest.get(table)
    if (
      !isAuthoritativeDataDomainFullTableParity(table, receipt)
      || !isDataDomainFullTableParityFresh(table, receipt, parityNotBefore)
    ) return table
  }
  return null
}

async function tableRowCount(db: D1Database, table: string): Promise<number> {
  const trustedTable = table.replace(/[^a-z0-9_]/g, '')
  if (trustedTable !== table) throw new Error(`invalid_data_domain_table:${table}`)
  const row = await db.prepare(`SELECT COUNT(*) AS row_count FROM "${trustedTable}"`).first<{
    row_count?: number | string
  }>()
  return Math.max(0, Number(row?.row_count ?? 0))
}

type TableFreshnessWatermark = {
  column: string
  value: string | number | null
}

const TABLE_FRESHNESS_COLUMNS = [
  'updated_at',
  'last_updated',
  'modified_at',
  'event_time',
  'received_at',
  'created_at',
] as const

async function tableFreshnessWatermark(
  db: D1Database,
  table: string,
): Promise<TableFreshnessWatermark | null> {
  const trustedTable = table.replace(/[^a-z0-9_]/g, '')
  if (trustedTable !== table) throw new Error(`invalid_data_domain_table:${table}`)
  const columns = await db.prepare(`PRAGMA table_info("${trustedTable}")`).all<{ name?: string }>()
  const available = new Set((columns.results ?? []).map((row) => String(row.name ?? '')))
  const column = TABLE_FRESHNESS_COLUMNS.find((candidate) => available.has(candidate))
  if (!column) return null
  const row = await db.prepare(
    `SELECT MAX("${column}") AS watermark FROM "${trustedTable}"`,
  ).first<{ watermark?: string | number | null }>()
  return { column, value: row?.watermark ?? null }
}

function sameFreshnessWatermark(
  source: TableFreshnessWatermark | null,
  target: TableFreshnessWatermark | null,
): boolean {
  if (!source && !target) return true
  return Boolean(source && target && source.column === target.column && source.value === target.value)
}

async function resetDataDomainTableForCatchup(
  env: Bindings,
  domain: DataDomain,
  table: string,
  reason: string,
  authority: DataDomainShadowMutationAuthority,
): Promise<void> {
  if (authority.domain !== domain || !['legacy', 'shadow'].includes(authority.cutoverStatus)) {
    throw new Error(`data_domain_shadow_authority_mismatch:${domain}`)
  }
  const cutover = await env.DB.prepare(`
    SELECT status FROM data_domain_cutovers WHERE domain=?
  `).bind(domain).first<{ status?: string }>()
  const status = cutover?.status ? String(cutover.status) : null
  if (!status || !['legacy', 'shadow'].includes(status)) {
    throw new Error(`domain_cutover_source_changed:${domain}:${status ?? 'missing'}`)
  }
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE data_domain_backfill_cursors
         SET status='running', cursor_json=NULL, rows_copied=0, last_batch_rows=0,
             last_source_checksum=NULL, last_target_checksum=NULL, error_code=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND table_name=?
    `).bind(domain, table),
    env.DB.prepare(`
      UPDATE data_domain_parity_checks
         SET status='blocked',
             evidence_json=json_object(
               'schema_version', 'data-domain-shadow-backfill-v1',
               'invalidated_reason', ?
             ),
             checked_at=CURRENT_TIMESTAMP
       WHERE domain=? AND table_name=? AND check_kind='full_table'
    `).bind(reason, domain, table),
    env.DB.prepare(`
      DELETE FROM data_domain_parity_checks WHERE check_id IN (?, ?)
    `).bind(
      `domain-parity:${domain}:${table}:manifest-progress`,
      `domain-parity:${domain}:${table}:delete-progress`,
    ),
    env.DB.prepare(`
      UPDATE data_domain_cutovers
         SET status='legacy', source_row_count=NULL, target_row_count=NULL,
             source_checksum=NULL, target_checksum=NULL, parity_checked_at=NULL,
             updated_at=CURRENT_TIMESTAMP
       WHERE domain=? AND status='shadow'
    `).bind(domain),
  ])
}

const DOMAIN_BACKFILL_ORDER: DataDomain[] = ['execution', 'paper', 'ops', 'learning', 'market', 'research', 'core']

export type LatestEveningChainClosure = {
  runDate: string | null
  status: string
  runScope: string | null
  timestamp: string | null
  terminalSuccess: boolean
  reason: string
}

export function resolveLatestEveningChainClosure(
  entries: Array<SchedulerRunLogEntry | null>,
): LatestEveningChainClosure {
  const latest = entries
    .filter((entry): entry is SchedulerRunLogEntry => Boolean(entry?.run_date))
    .sort((left, right) => (
      String(right.run_date).localeCompare(String(left.run_date))
      || String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? ''))
    ))[0]
  if (!latest) {
    return {
      runDate: null,
      status: 'missing',
      runScope: null,
      timestamp: null,
      terminalSuccess: false,
      reason: 'latest_evening_chain_missing',
    }
  }
  const liveCanonical = latest.run_scope === 'live_canonical'
  const terminalSuccess = latest.status === 'success' && liveCanonical
  return {
    runDate: latest.run_date ?? null,
    status: latest.status,
    runScope: latest.run_scope ?? null,
    timestamp: latest.timestamp ?? null,
    terminalSuccess,
    reason: terminalSuccess
      ? 'latest_evening_chain_live_canonical_success'
      : `latest_evening_chain_not_terminal_live_success:${latest.status}:${latest.run_scope ?? 'unknown_scope'}`,
  }
}

export async function inspectLatestEveningChainClosure(
  kv: KVNamespace,
): Promise<LatestEveningChainClosure> {
  const entries = await Promise.all(
    Array.from({ length: 8 }, (_, days) => twDaysAgo(days))
      .map((date) => kv.get(`scheduler:run:evening-chain:${date}`, 'json') as Promise<SchedulerRunLogEntry | null>),
  )
  return resolveLatestEveningChainClosure(entries)
}


export async function nextDataDomainBackfillDomain(
  env: Bindings,
  parityNotBefore = dataDomainParitySessionWatermark(),
): Promise<DataDomain | null> {
  const invalidDomains = invalidActiveDataDomains(env)
  if (invalidDomains.length) {
    throw new Error(`data_domain_shadow_active_domain_invalid:${invalidDomains.sort().join(',')}`)
  }
  if (String(env.MULTI_D1_STRICT ?? '').trim().toLowerCase() === 'true') {
    throw new Error('data_domain_shadow_requires_strict_disabled:selector')
  }
  const activeDomains = activeDataDomains(env)
  for (const domain of DOMAIN_BACKFILL_ORDER) {
    if (activeDomains.has(domain)) continue
    await assertDataDomainShadowMutationAuthority(env, domain)
    const receiptRefresh = await nextDataDomainReceiptRefreshTable(
      env,
      domain,
      parityNotBefore,
    )
    if (receiptRefresh) return domain
    const incremental = await nextDataDomainIncrementalCatchupTable(
      env,
      domain,
      parityNotBefore,
      false,
    )
    if (incremental) return domain
    const incomplete = await nextIncompleteTable(env, domain)
    if (incomplete) return domain
  }
  return null
}

export async function enqueueNextDataDomainShadowBackfill(
  env: Bindings,
  input: {
    runDate: string
    maxAttempts?: number
    parityNotBefore?: string | null
  },
): Promise<{ caughtUp: boolean; domain: DataDomain | null; queued: boolean; runId: string | null }> {
  const parityNotBefore = input.parityNotBefore || dataDomainParitySessionWatermark()
  const domain = await nextDataDomainBackfillDomain(env, parityNotBefore)
  if (!domain) return { caughtUp: true, domain: null, queued: false, runId: null }
  const queued = await enqueueDataDomainShadowBackfill(env, {
    domain,
    runDate: input.runDate,
    maxAttempts: input.maxAttempts,
    parityNotBefore,
    globalSweep: true,
  })
  return {
    caughtUp: false,
    domain,
    queued: queued.queued,
    runId: queued.runId,
  }
}


export async function nextDataDomainIncrementalCatchupTable(
  env: Bindings,
  domain: DataDomain,
  parityNotBefore?: string | null,
  mutate = true,
  tableScope?: string[],
): Promise<string | null> {
  const target = shadowDatabaseForDataDomain(env, domain)
  if (!target) throw new Error(`data_domain_shadow_binding_missing:${domain}`)
  const mutationAuthority = await assertDataDomainShadowMutationAuthority(env, domain)
  const learningAuthority = domain === 'learning'
    ? assertInactiveLearningShadowAuthority(env)
    : null
  const completedSet = new Set(await completedDomainTables(env, domain))
  const orderedTables = tableScope ?? tablesForDataDomainShadowBackfill(domain)
  for (const table of [...orderedTables].reverse()) {
    if (!completedSet.has(table)) continue
    const [sourceRows, targetRows] = await Promise.all([
      tableRowCount(env.DB, table),
      tableRowCount(target, table),
    ])
    if (targetRows > sourceRows) {
      const deferred = await env.DB.prepare(`
        SELECT evidence_json
          FROM data_domain_parity_checks
         WHERE check_id=?
      `).bind(`domain-parity:${domain}:${table}:delete-progress`)
        .first<{ evidence_json?: string | null }>()
      if (deferred?.evidence_json) {
        try {
          const evidence = JSON.parse(deferred.evidence_json) as {
            phase?: unknown
            blockers?: unknown
          }
          if (evidence.phase === 'waiting_for_dependents' && Array.isArray(evidence.blockers)) {
            const deferredTables = new Set(evidence.blockers.flatMap((value) => {
              if (typeof value !== 'string') return []
              const dependent = value.split(':', 1)[0]?.trim()
              return dependent && orderedTables.includes(dependent) ? [dependent] : []
            }))
            const pendingDependent = orderedTables.find((candidate) => (
              deferredTables.has(candidate) && !completedSet.has(candidate)
            ))
            if (pendingDependent) return pendingDependent
          }
        } catch {}
      }
      return table
    }
  }
  for (const table of orderedTables) {
    if (!completedSet.has(table)) continue
    if (domain === 'learning' && isDataDomainControlTable(table)) {
      const [receipt, counts, liveRevision] = await Promise.all([
        loadControlTableReceipt(env.DB, table),
        controlTableRowCounts(env.DB, target, table),
        loadDataDomainControlRevisionPair(env.DB, target, table),
      ])
      const receiptBlockers = controlTableReceiptBlockers({
        table,
        ...receipt,
        parityNotBefore,
      })
      receiptBlockers.push(...dataDomainControlRevisionBlockers({
        receipt: receipt.parity,
        live: liveRevision,
      }))
      const liveCountsExact = counts.sourceCount === counts.targetCount
      const receiptCountsExact = liveCountsExact
        && counts.sourceCount === Number(receipt.parity?.source_count ?? -1)
        && counts.targetCount === Number(receipt.parity?.target_count ?? -1)
      if (!receiptBlockers.length && receiptCountsExact) continue
      if (!mutate) return table

      let preserveCursor = Boolean(
        liveCountsExact
        && receipt.cursor?.status === 'complete'
        && Number(receipt.cursor.rows_copied ?? -1) === counts.sourceCount,
      )
      const reasons = [...receiptBlockers]
      if (isLegacyDirectControlReceipt(receipt.parity)) {
        const legacy = await verifyLegacyDirectControlReceipt(env.DB, env.DB, target, table)
        preserveCursor = legacy.exact
        reasons.push(...legacy.blockers)
      }
      if (!liveCountsExact) {
        reasons.push(`live_count_mismatch:${counts.sourceCount}/${counts.targetCount}`)
      }
      const receiptCount = Number(receipt.parity?.source_count ?? -1)
      if (liveCountsExact && receiptCount !== counts.sourceCount) {
        reasons.push(`receipt_live_count_mismatch:${receiptCount}/${counts.sourceCount}`)
      }
      await invalidateControlTableClosure(env.DB, {
        changedTables: [table],
        preserveCursorTables: preserveCursor ? [table] : [],
        reason: `control_table_receipt_refresh:${[...new Set(reasons)].join('|')}`,
        authority: learningAuthority!,
      })
      return table
    }
    const [sourceRows, targetRows, sourceWatermark, targetWatermark, parityReceipt] = await Promise.all([
      tableRowCount(env.DB, table),
      tableRowCount(target, table),
      tableFreshnessWatermark(env.DB, table),
      tableFreshnessWatermark(target, table),
      env.DB.prepare(`
        SELECT status, source_count, target_count, source_checksum, target_checksum,
               evidence_json, checked_at
          FROM data_domain_parity_checks
         WHERE domain=? AND table_name=? AND check_kind='full_table'
         ORDER BY checked_at DESC, check_id DESC
         LIMIT 1
      `).bind(domain, table).first<{
        status?: string | null
        source_count?: number | string | null
        target_count?: number | string | null
        source_checksum?: string | null
        target_checksum?: string | null
        evidence_json?: string | null
        checked_at?: string | null
      }>(),
    ])
    if (!isAuthoritativeDataDomainFullTableParity(table, parityReceipt)) return table
    const reason = sourceRows !== targetRows
      ? `row_count_changed:${sourceRows}/${targetRows}`
      : !sameFreshnessWatermark(sourceWatermark, targetWatermark)
        ? `freshness_watermark_changed:${JSON.stringify(sourceWatermark)}/${JSON.stringify(targetWatermark)}`
        : null
    if (reason) {
      if (!mutate) return table
      await resetDataDomainTableForCatchup(env, domain, table, reason, mutationAuthority)
      return table
    }
    const receiptSourceRows = Number(parityReceipt?.source_count ?? -1)
    const receiptTargetRows = Number(parityReceipt?.target_count ?? -1)
    const receiptCountsExact = receiptSourceRows === sourceRows
      && receiptTargetRows === targetRows
    const receiptFresh = isDataDomainFullTableParityFresh(
      table,
      parityReceipt,
      parityNotBefore,
    )
    if (!receiptCountsExact || !receiptFresh) {
      if (!mutate) return table
      await invalidateGenericManifestProgress(
        env.DB,
        domain,
        table,
        `generic_receipt_refresh:${[
          ...(!receiptCountsExact
            ? [`live_count_receipt_mismatch:${receiptSourceRows}/${receiptTargetRows}:${sourceRows}/${targetRows}`]
            : []),
          ...(!receiptFresh ? ['session_watermark_stale'] : []),
        ].join('|')}`,
      )
      return table
    }
  }
  return null
}

async function nextDataDomainIncrementalCatchupTableStep(
  env: Bindings,
  domain: DataDomain,
  parityNotBefore: string | null,
): Promise<{
  table: string | null
  scannedTable: string | null
  scannedTables: number
  totalTables: number
  sweepComplete: boolean
}> {
  const tables = [...tablesForDataDomainShadowBackfill(domain)].reverse()
  const key = incrementalScanKey(domain)
  const state = await env.KV.get(key, 'json') as {
    parity_not_before?: string | null
    next_index?: number
  } | null
  const sameSession = state?.parity_not_before === parityNotBefore
  const nextIndex = sameSession && Number.isSafeInteger(state?.next_index)
    ? Math.max(0, Math.min(Number(state?.next_index), tables.length))
    : 0
  if (nextIndex >= tables.length) {
    await env.KV.delete(key)
    return {
      table: null,
      scannedTable: null,
      scannedTables: tables.length,
      totalTables: tables.length,
      sweepComplete: true,
    }
  }

  const scannedTable = tables[nextIndex]
  const table = await nextDataDomainIncrementalCatchupTable(
    env,
    domain,
    parityNotBefore,
    true,
    [scannedTable],
  )
  if (table) {
    await env.KV.delete(key)
    return {
      table,
      scannedTable,
      scannedTables: nextIndex + 1,
      totalTables: tables.length,
      sweepComplete: false,
    }
  }

  const scannedTables = nextIndex + 1
  if (scannedTables >= tables.length) {
    await env.KV.delete(key)
    return {
      table: null,
      scannedTable,
      scannedTables,
      totalTables: tables.length,
      sweepComplete: true,
    }
  }
  await env.KV.put(key, JSON.stringify({
    parity_not_before: parityNotBefore,
    next_index: scannedTables,
    updated_at: new Date().toISOString(),
  }), { expirationTtl: ACTIVE_TTL_SECONDS })
  return {
    table: null,
    scannedTable,
    scannedTables,
    totalTables: tables.length,
    sweepComplete: false,
  }
}

async function domainChecksumReady(
  env: Bindings,
  domain: DataDomain,
  parityNotBefore?: string | null,
): Promise<boolean> {
  const target = shadowDatabaseForDataDomain(env, domain)
  if (!target) throw new Error(`data_domain_shadow_binding_missing:${domain}`)
  const completedTables = await completedDomainTables(env, domain)
  const parity = await env.DB.prepare(`
    SELECT table_name, status, source_count, target_count,
           source_checksum, target_checksum, evidence_json, checked_at
      FROM data_domain_parity_checks
     WHERE domain=? AND check_kind='full_table' AND status='pass'
  `).bind(domain).all<{
    table_name: string
    status?: string
    source_count?: number | string | null
    target_count?: number | string | null
    source_checksum?: string | null
    target_checksum?: string | null
    evidence_json?: string | null
    checked_at?: string | null
  }>()
  const parityTables: string[] = []
  for (const row of parity.results ?? []) {
    const table = String(row.table_name)
    if (
      !isAuthoritativeDataDomainFullTableParity(table, row)
      || !isDataDomainFullTableParityFresh(table, row, parityNotBefore)
    ) continue
    if (domain === 'learning' && isDataDomainControlTable(table)) {
      const live = await loadDataDomainControlRevisionPair(env.DB, target, table)
      if (dataDomainControlRevisionBlockers({ receipt: row, live }).length) continue
    }
    parityTables.push(table)
  }
  return isDomainShadowCutoverReady(tablesForDataDomainShadowBackfill(domain), completedTables, parityTables)
}

async function refreshDataDomainAggregateCutover(
  env: Bindings,
  domain: DataDomain,
  parityNotBefore: string,
): Promise<boolean> {
  const ownedTables = tablesForDataDomainShadowBackfill(domain)
  const parity = await env.DB.prepare(`
    SELECT table_name, status, source_count, target_count,
           source_checksum, target_checksum, evidence_json, checked_at
      FROM data_domain_parity_checks
     WHERE domain=? AND check_kind='full_table'
     ORDER BY checked_at DESC, check_id DESC
  `).bind(domain).all<{
    table_name: string
    status: string
    source_count: number | string | null
    target_count: number | string | null
    source_checksum: string | null
    target_checksum: string | null
    evidence_json?: string | null
    checked_at?: string | null
  }>()
  const aggregate = await buildDataDomainAggregateParitySnapshot(
    ownedTables,
    parity.results ?? [],
    parityNotBefore,
  )
  if (!aggregate || aggregate.source_checksum !== aggregate.target_checksum) return false
  const checkedAt = new Date().toISOString()
  const updated = await env.DB.prepare(`
    UPDATE data_domain_cutovers
       SET status='shadow', target_binding=?,
           source_row_count=?, target_row_count=?,
           source_checksum=?, target_checksum=?, parity_checked_at=?,
           updated_at=CURRENT_TIMESTAMP
     WHERE domain=? AND status IN ('legacy','shadow')
  `).bind(
    `${domain.toUpperCase()}_DB`,
    aggregate.source_row_count,
    aggregate.target_row_count,
    aggregate.source_checksum,
    aggregate.target_checksum,
    checkedAt,
    domain,
  ).run()
  return Number(updated.meta?.changes ?? 0) === 1
}
export type DataDomainParityCarryForwardInput = {
  authoritative: boolean
  receiptCheckedAt: string | null
  tableEpochUpdatedAt: string | null
  epochBefore: number | null
  epochAfter: number | null
  sourceCount: number
  targetCount: number
  receiptSourceCount: number
  receiptTargetCount: number
}

export function dataDomainParityCarryForwardBlockers(
  input: DataDomainParityCarryForwardInput,
): string[] {
  const blockers: string[] = []
  if (!input.authoritative) blockers.push('authoritative_receipt_missing')
  const receiptMs = Date.parse(String(input.receiptCheckedAt ?? ''))
  const epochUpdatedMs = Date.parse(String(input.tableEpochUpdatedAt ?? ''))
  if (!Number.isFinite(receiptMs) || !Number.isFinite(epochUpdatedMs)) {
    blockers.push('writer_epoch_timestamp_missing')
  } else if (epochUpdatedMs > receiptMs) {
    blockers.push('source_write_after_receipt')
  }
  if (
    input.epochBefore === null
    || input.epochAfter === null
    || input.epochBefore !== input.epochAfter
  ) blockers.push('table_writer_epoch_changed')
  if (input.sourceCount !== input.receiptSourceCount) blockers.push('source_count_changed')
  if (input.targetCount !== input.receiptTargetCount) blockers.push('target_count_changed')
  if (input.sourceCount !== input.targetCount) blockers.push('live_count_mismatch')
  return blockers
}

type CarryForwardReceipt = {
  check_id?: string | null
  table_name?: string | null
  status?: string | null
  source_count?: number | string | null
  target_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  evidence_json?: string | null
  checked_at?: string | null
}

export async function carryForwardStableDataDomainParityReceipts(
  env: Bindings,
  domain: DataDomain,
  parityNotBefore: string,
): Promise<{
  schema_version: 'data-domain-parity-carry-forward-v1'
  domain: DataDomain
  parity_not_before: string
  carried_tables: string[]
  already_fresh_tables: string[]
  blocked: Array<{ table: string; blockers: string[] }>
}> {
  if (domain !== 'ops') throw new Error(`data_domain_parity_carry_forward_not_closed:${domain}`)
  if (String(env.MULTI_D1_STRICT ?? '').trim().toLowerCase() === 'true' || activeDataDomains(env).has(domain)) {
    throw new Error(`data_domain_parity_carry_forward_requires_inactive_target:${domain}`)
  }
  if (!Number.isFinite(Date.parse(parityNotBefore))) {
    throw new Error('data_domain_parity_carry_forward_watermark_invalid')
  }
  const target = shadowDatabaseForDataDomain(env, domain)
  if (!target) throw new Error(`data_domain_shadow_binding_missing:${domain}`)
  const before = await readDataDomainWriterEpochSnapshot(env.DB, domain)
  if (before.writer_state !== 'open') {
    throw new Error(`data_domain_parity_carry_forward_writer_not_open:${domain}:${before.writer_state}`)
  }
  const quiescedEpoch = await beginDataDomainWriterQuiescence(env.DB, domain, before.epoch)
  const carriedTables: string[] = []
  const alreadyFreshTables: string[] = []
  const blocked: Array<{ table: string; blockers: string[] }> = []
  try {
    for (const table of tablesForDataDomainShadowBackfill(domain)) {
      const receipt = await env.DB.prepare(`
        SELECT check_id, table_name, status, source_count, target_count,
               source_checksum, target_checksum, evidence_json, checked_at
          FROM data_domain_parity_checks
         WHERE check_id=?
      `).bind(`domain-parity:${domain}:${table}:full-table`).first<CarryForwardReceipt>()
      if (receipt && isDataDomainFullTableParityFresh(table, receipt, parityNotBefore)) {
        alreadyFreshTables.push(table)
        continue
      }
      const epochBefore = await env.DB.prepare(`
        SELECT epoch, updated_at FROM data_domain_table_writer_epochs
         WHERE domain=? AND table_name=?
      `).bind(domain, table).first<{ epoch?: number | string; updated_at?: string | null }>()
      const [sourceCount, targetCount] = await Promise.all([
        tableRowCount(env.DB, table),
        tableRowCount(target, table),
      ])
      const epochAfter = await env.DB.prepare(`
        SELECT epoch, updated_at FROM data_domain_table_writer_epochs
         WHERE domain=? AND table_name=?
      `).bind(domain, table).first<{ epoch?: number | string; updated_at?: string | null }>()
      const epochBeforeValue = epochBefore && Number.isSafeInteger(Number(epochBefore.epoch))
        ? Number(epochBefore.epoch)
        : null
      const epochAfterValue = epochAfter && Number.isSafeInteger(Number(epochAfter.epoch))
        ? Number(epochAfter.epoch)
        : null
      const blockers = dataDomainParityCarryForwardBlockers({
        authoritative: Boolean(receipt && isAuthoritativeDataDomainFullTableParity(table, receipt)),
        receiptCheckedAt: receipt?.checked_at ?? null,
        tableEpochUpdatedAt: epochBefore?.updated_at ?? null,
        epochBefore: epochBeforeValue,
        epochAfter: epochAfterValue,
        sourceCount,
        targetCount,
        receiptSourceCount: Number(receipt?.source_count ?? -1),
        receiptTargetCount: Number(receipt?.target_count ?? -1),
      })
      if (blockers.length) {
        blocked.push({ table, blockers })
        continue
      }
      let previousEvidence: Record<string, unknown> = {}
      try {
        previousEvidence = JSON.parse(String(receipt?.evidence_json ?? '{}')) as Record<string, unknown>
      } catch {}
      const carriedAt = new Date().toISOString()
      const evidence = JSON.stringify({
        ...previousEvidence,
        carry_forward_schema_version: 'data-domain-parity-carry-forward-v1',
        carried_from_checked_at: receipt!.checked_at,
        carried_at: carriedAt,
        table_writer_epoch: epochAfterValue,
        table_writer_epoch_updated_at: epochAfter?.updated_at ?? null,
        count_revalidated: true,
      })
      const updated = await env.DB.prepare(`
        UPDATE data_domain_parity_checks
           SET evidence_json=?, checked_at=?
         WHERE check_id=? AND status='pass' AND checked_at=?
           AND source_count=? AND target_count=? AND source_checksum=target_checksum
      `).bind(
        evidence,
        carriedAt,
        receipt!.check_id,
        receipt!.checked_at,
        sourceCount,
        targetCount,
      ).run()
      if (Number(updated.meta?.changes ?? 0) !== 1) {
        blocked.push({ table, blockers: ['receipt_compare_and_swap_failed'] })
        continue
      }
      carriedTables.push(table)
    }
  } finally {
    await reopenDataDomainWriters(env.DB, domain, quiescedEpoch)
  }
  return {
    schema_version: 'data-domain-parity-carry-forward-v1',
    domain,
    parity_not_before: parityNotBefore,
    carried_tables: carriedTables,
    already_fresh_tables: alreadyFreshTables,
    blocked,
  }
}

export async function enqueueDataDomainShadowBackfill(
  env: Pick<Bindings, 'KV' | 'UPDATE_QUEUE'>,
  input: {
    domain: DataDomain
    runDate: string
    table?: string
    runId?: string
    maxAttempts?: number
    parityNotBefore?: string
    globalSweep?: boolean
  },
): Promise<{ queued: boolean; runId: string }> {
  if (input.table && !tablesForDataDomainShadowBackfill(input.domain).includes(input.table)) {
    throw new Error(`data_domain_shadow_backfill_requested_table_not_owned:${input.domain}:${input.table}`)
  }
  if (
    input.domain === 'learning'
    && input.table
    && [
      'expected_return_artifact_payloads',
      'model_champion_history',
      'model_champion_pointers',
    ].includes(input.table)
  ) {
    throw new Error(`data_domain_shadow_backfill_dependency_closure_required:${input.domain}:${input.table}`)
  }
  const runId = input.runId ?? `data-domain-shadow-backfill:${input.domain}:${input.runDate}:${crypto.randomUUID()}`
  const key = dataDomainShadowBackfillActiveKey(input.domain)
  const existing = await env.KV.get(key)
  if (existing) {
    const active = parseActiveState(existing)
    const progress = await env.KV.get(progressKey(input.domain), 'json') as { updated_at?: string | null } | null
    if (!isDataDomainShadowProgressStale(active.started_at, progress?.updated_at ?? null)) {
      return { queued: false, runId: active.run_id }
    }
    await env.KV.delete(key)
  }
  const maxAttempts = Math.max(1, Math.min(Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), MAX_ATTEMPTS))
  const parityNotBefore = input.parityNotBefore ?? dataDomainParitySessionWatermark()

  await env.KV.put(key, JSON.stringify({ run_id: runId, started_at: parityNotBefore }), {
    expirationTtl: ACTIVE_TTL_SECONDS,
  })
  try {
    await (env.UPDATE_QUEUE as any).send(queueMessage({
      domain: input.domain,
      table: input.table,
      requestedTable: input.table,
      runDate: input.runDate,
      runId,
      attempt: 0,
      maxAttempts,
      parityNotBefore,
      globalSweep: input.globalSweep,
    }))
    return { queued: true, runId }
  } catch (error) {
    await env.KV.delete(key).catch(() => {})
    throw error
  }
}

export async function runDataDomainShadowBackfillHttpStep(
  env: Bindings,
  input: {
    domain: DataDomain
    runDate: string
    table?: string
    limit?: number
  },
): Promise<{
  runId: string
  parityNotBefore: string
  table: string | null
  caughtUp: boolean
  result: DomainShadowBackfillResult | null
}> {
  if (input.table && !tablesForDataDomainShadowBackfill(input.domain).includes(input.table)) {
    throw new Error(`data_domain_shadow_backfill_requested_table_not_owned:${input.domain}:${input.table}`)
  }
  const key = dataDomainShadowBackfillActiveKey(input.domain)
  const existing = await env.KV.get(key)
  const active = existing ? parseActiveState(existing) : null
  const parityNotBefore = active?.started_at ?? dataDomainParitySessionWatermark()
  const runId = active?.run_id
    ?? `data-domain-shadow-backfill-http:${input.domain}:${input.runDate}:${crypto.randomUUID()}`
  await env.KV.put(key, JSON.stringify({
    run_id: runId,
    started_at: parityNotBefore,
  }), { expirationTtl: ACTIVE_TTL_SECONDS })

  let table: string | null = input.table ?? null
  if (!table) {
    table = await nextDataDomainReceiptRefreshTable(env, input.domain, parityNotBefore)
      || await nextIncompleteTable(env, input.domain)
    if (table) {
      await env.KV.delete(incrementalScanKey(input.domain))
    } else {
      const scan = await nextDataDomainIncrementalCatchupTableStep(
        env,
        input.domain,
        parityNotBefore,
      )
      table = scan.table
      if (!table && !scan.sweepComplete) {
        await env.KV.put(progressKey(input.domain), JSON.stringify({
          run_id: runId,
          transport: 'http_step',
          phase: 'incremental_scan',
          scanned_table: scan.scannedTable,
          scanned_tables: scan.scannedTables,
          total_tables: scan.totalTables,
          updated_at: new Date().toISOString(),
        }), { expirationTtl: ACTIVE_TTL_SECONDS })
        return { runId, parityNotBefore, table: null, caughtUp: false, result: null }
      }
    }
  }
  if (!table) {
    const checksumReady = await domainChecksumReady(env, input.domain, parityNotBefore)
    const caughtUp = checksumReady
      && await refreshDataDomainAggregateCutover(env, input.domain, parityNotBefore)
    if (caughtUp) await env.KV.delete(key)
    return { runId, parityNotBefore, table: null, caughtUp, result: null }
  }

  const result = await backfillDataDomainTableShadow(env, {
    domain: input.domain,
    table,
    limit: input.limit ?? SHADOW_BACKFILL_QUEUE_BATCH_LIMIT,
    parityNotBefore,
  })
  await env.KV.put(progressKey(input.domain), JSON.stringify({
    run_id: runId,
    transport: 'http_step',
    table,
    result,
    updated_at: new Date().toISOString(),
  }), { expirationTtl: ACTIVE_TTL_SECONDS })
  if (result.domain_shadow_ready) {
    await env.KV.delete(key)
  } else {
    await env.KV.put(key, JSON.stringify({
      run_id: runId,
      started_at: parityNotBefore,
    }), { expirationTtl: ACTIVE_TTL_SECONDS })
  }
  return {
    runId,
    parityNotBefore,
    table,
    caughtUp: Boolean(result.domain_shadow_ready),
    result,
  }
}

export async function processDataDomainShadowBackfillDrain(
  env: Bindings,
  msg: UpdateQueueMsg,
): Promise<void> {
  const domain = msg.dataDomain
  if (!domain) throw new Error('data_domain_shadow_backfill_domain_missing')
  const attempt = Math.max(0, Math.floor(msg.attempt ?? 0))
  const maxAttempts = Math.max(1, Math.min(Math.floor(msg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), MAX_ATTEMPTS))
  const errorAttempt = Math.max(0, Math.floor(msg.dataDomainErrorAttempt ?? 0))
  const runId = msg.runId ?? `data-domain-shadow-backfill:${domain}:${msg.triggerTime}:queue`
  const parityNotBefore = msg.dataDomainParityNotBefore
    ?? dataDomainParitySessionWatermark()
  const globalSweep = msg.dataDomainGlobalSweep === true
  const backfillTables = tablesForDataDomainShadowBackfill(domain)
  const currentTable = msg.dataDomainTable
  const requestedTable = msg.dataDomainRequestedTable
  if (currentTable && !backfillTables.includes(currentTable)) {
    throw new Error(`data_domain_shadow_backfill_table_not_owned:${domain}:${currentTable}`)
  }
  if (requestedTable && !backfillTables.includes(requestedTable)) {
    throw new Error(`data_domain_shadow_backfill_requested_table_not_owned:${domain}:${requestedTable}`)
  }
  if (requestedTable && currentTable && requestedTable !== currentTable) {
    throw new Error(`data_domain_shadow_backfill_scope_mismatch:${domain}:${requestedTable}:${currentTable}`)
  }
  if (
    domain === 'learning'
    && requestedTable
    && [
      'expected_return_artifact_payloads',
      'model_champion_history',
      'model_champion_pointers',
    ].includes(requestedTable)
  ) {
    throw new Error(`data_domain_shadow_backfill_dependency_closure_required:${domain}:${requestedTable}`)
  }
  const table = currentTable
    ?? requestedTable
    ?? (await nextDataDomainReceiptRefreshTable(env, domain, parityNotBefore)
      || await nextDataDomainIncrementalCatchupTable(env, domain, parityNotBefore)
      || await nextIncompleteTable(env, domain))
  if (!table) {
    const checksumReady = await domainChecksumReady(env, domain, parityNotBefore)
    const aggregateShadowReady = checksumReady
      && await refreshDataDomainAggregateCutover(env, domain, parityNotBefore)
    await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
    let sweepNext: Awaited<ReturnType<typeof enqueueDataDomainShadowBackfill>> | null = null
    let sweepNextDomain: DataDomain | null = null
    if (shouldContinueDataDomainGlobalSweep({
      globalSweep,
      requestedTable,
      domainShadowReady: aggregateShadowReady,
    })) {
      sweepNextDomain = await nextDataDomainBackfillDomain(env, parityNotBefore)
      if (sweepNextDomain) {
        sweepNext = await enqueueDataDomainShadowBackfill(env, {
          domain: sweepNextDomain,
          runDate: msg.triggerTime,
          maxAttempts,
          parityNotBefore,
          globalSweep: true,
        })
      }
    }
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: aggregateShadowReady ? 'success' : 'error',
      summary: `domain=${domain} initial_copy_complete checksum_ready=${checksumReady} aggregate_shadow_ready=${aggregateShadowReady} global_sweep=${globalSweep} sweep_next_domain=${sweepNextDomain ?? 'none'} sweep_next_queued=${sweepNext?.queued ?? false} run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }

  try {
    await assertDataDomainShadowMutationAuthority(env, domain)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: 'error',
      summary: `domain=${domain} table=${table} mutation_authority_blocked=true error=${errorMessage}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
      error: errorMessage,
    }, env)
    return
  }

  let leased: DomainShadowBackfillResult | { skipped: true; reason: string }
  try {
    leased = await runWithMaintenanceLease(env.DB, {
      taskName: `data-domain-shadow-backfill:${domain}`,
      leaseGroup: 'd1_heavy_maintenance',
      leaseSeconds: 300,
      run: () => backfillDataDomainTableShadow(env, {
        domain,
        table,
        limit: SHADOW_BACKFILL_QUEUE_BATCH_LIMIT,
        parityNotBefore,
      }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (isDataDomainShadowAuthorityError(error)) {
      await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
      await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
        status: 'error',
        summary: `domain=${domain} table=${table} mutation_authority_changed=true error=${errorMessage}`,
        duration_ms: 0,
        run_id: runId,
        run_date: msg.triggerTime,
        error: errorMessage,
      }, env)
      return
    }
    const errorCode = errorMessage.slice(0, 1000)
    const nextAttempt = attempt + 1
    const nextErrorAttempt = errorAttempt + 1
    await env.DB.prepare(`
      INSERT INTO data_domain_backfill_cursors(
        domain, table_name, status, cursor_json, rows_copied, last_batch_rows,
        last_source_checksum, last_target_checksum, error_code, updated_at
      ) VALUES (?, ?, 'error', NULL, 0, 0, NULL, NULL, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(domain,table_name) DO UPDATE SET
        status='error', last_batch_rows=0, error_code=excluded.error_code,
        updated_at=CURRENT_TIMESTAMP
    `).bind(domain, table, errorCode).run()
    await env.KV.put(progressKey(domain), JSON.stringify({
      run_id: runId,
      attempt,
      error_attempt: nextErrorAttempt,
      table,
      error: errorCode,
      updated_at: new Date().toISOString(),
    }), { expirationTtl: ACTIVE_TTL_SECONDS })
    if (nextAttempt >= maxAttempts || nextErrorAttempt >= 3) {
      await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
      await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
        status: 'error',
        summary: `domain=${domain} table=${table} consecutive_errors=${nextErrorAttempt} error=${errorCode} run_id=${runId}`,
        duration_ms: 0,
        run_id: runId,
        run_date: msg.triggerTime,
      }, env)
      return
    }
    await (env.UPDATE_QUEUE as any).send(queueMessage({
      domain,
      table,
      requestedTable,
      runDate: msg.triggerTime,
      runId,
      attempt: nextAttempt,
      maxAttempts,
      errorAttempt: nextErrorAttempt,
      parityNotBefore,
      globalSweep,
    }), { delaySeconds: 30 * (2 ** errorAttempt) })
    return
  }
  if ('skipped' in leased && leased.skipped) {
    await (env.UPDATE_QUEUE as any).send(queueMessage({
      domain,
      table,
      requestedTable,
      runDate: msg.triggerTime,
      runId,
      attempt,
      maxAttempts,
      parityNotBefore,
      globalSweep,
    }), {
      delaySeconds: 30,
    })
    return
  }

  const result = leased as DomainShadowBackfillResult
  await env.KV.put(progressKey(domain), JSON.stringify({
    run_id: runId,
    attempt,
    table,
    result,
    updated_at: new Date().toISOString(),
  }), { expirationTtl: ACTIVE_TTL_SECONDS })

  const continuation = resolveDataDomainShadowBackfillContinuation(requestedTable, result.status)
  if (continuation === 'requested_table_complete') {
    await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: 'success',
      summary: `domain=${domain} table=${table} requested_table_complete=true table_checksum_ready=true source_rows=${result.source_rows} target_rows=${result.target_rows} run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }
  if (continuation === 'requested_table_dependency_blocked') {
    await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: 'error',
      summary: `domain=${domain} table=${table} requested_table_dependency_closure_required=true run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }

  if (attempt + 1 >= maxAttempts) {
    await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: 'error',
      summary: `domain=${domain} exhausted attempts=${attempt + 1}/${maxAttempts} table=${table}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }

  const nextTable = continuation === 'same_table'
    ? table
    : await nextDataDomainReceiptRefreshTable(env, domain, parityNotBefore)
      || await nextDataDomainIncrementalCatchupTable(env, domain, parityNotBefore)
      || await nextIncompleteTable(env, domain)
  if (nextTable) {
    await env.KV.put(dataDomainShadowBackfillActiveKey(domain), JSON.stringify({
      run_id: runId,
      started_at: parityNotBefore,
    }), { expirationTtl: ACTIVE_TTL_SECONDS })
    await (env.UPDATE_QUEUE as any).send(queueMessage({
      domain,
      table: nextTable,
      requestedTable,
      runDate: msg.triggerTime,
      runId,
      attempt: attempt + 1,
      maxAttempts,
      parityNotBefore,
      globalSweep,
    }), { delaySeconds: 1 })
    return
  }

  await env.KV.delete(dataDomainShadowBackfillActiveKey(domain))
  let sweepNext: Awaited<ReturnType<typeof enqueueDataDomainShadowBackfill>> | null = null
  let sweepNextDomain: DataDomain | null = null
  if (shouldContinueDataDomainGlobalSweep({
    globalSweep,
    requestedTable,
    domainShadowReady: Boolean(result.domain_shadow_ready),
  })) {
    sweepNextDomain = await nextDataDomainBackfillDomain(env, parityNotBefore)
    if (sweepNextDomain) {
      sweepNext = await enqueueDataDomainShadowBackfill(env, {
        domain: sweepNextDomain,
        runDate: msg.triggerTime,
        maxAttempts,
        parityNotBefore,
        globalSweep: true,
      })
    }
  }
  await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
    status: result.domain_shadow_ready ? 'success' : 'error',
    summary: `domain=${domain} tables_complete=true checksum_ready=${Boolean(result.domain_shadow_ready)} global_sweep=${globalSweep} sweep_next_domain=${sweepNextDomain ?? 'none'} sweep_next_queued=${sweepNext?.queued ?? false} run_id=${runId}`,
    duration_ms: 0,
    run_id: runId,
    run_date: msg.triggerTime,
  }, env)
}
