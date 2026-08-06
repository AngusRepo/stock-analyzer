import type { Bindings, UpdateQueueMsg } from '../types'
import {
  backfillDataDomainTableShadow,
  isDomainShadowCutoverReady,
  type DomainShadowBackfillResult,
} from './dataDomainShadowBackfill'
import {
  shadowDatabaseForDataDomain,
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'
import { runWithMaintenanceLease } from './maintenanceLease'
import { twDaysAgo } from './dateUtils'
import { logSchedulerResult, type SchedulerRunLogEntry } from './schedulerRunLogger'

const ACTIVE_TTL_SECONDS = 6 * 3600
const DEFAULT_MAX_ATTEMPTS = 5000
const MAX_ATTEMPTS = 20_000
const STALE_PROGRESS_MS = 5 * 60 * 1000

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
function activeKey(domain: DataDomain): string {
  return `data-domain-shadow-backfill:${domain}:active`
}

function progressKey(domain: DataDomain): string {
  return `data-domain-shadow-backfill:${domain}:progress`
}

function queueMessage(input: {
  domain: DataDomain
  table?: string
  runDate: string
  runId: string
  attempt: number
  maxAttempts: number
  errorAttempt?: number
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
  }
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
): Promise<void> {
  const cutover = await env.DB.prepare(`
    SELECT status FROM data_domain_cutovers WHERE domain=?
  `).bind(domain).first<{ status?: string }>()
  const status = String(cutover?.status ?? 'legacy')
  if (!['legacy', 'shadow'].includes(status)) {
    throw new Error(`domain_cutover_source_changed:${domain}:${status}`)
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
      DELETE FROM data_domain_parity_checks WHERE check_id=?
    `).bind(`domain-parity:${domain}:${table}:manifest-progress`),
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


export async function nextDataDomainBackfillDomain(env: Bindings): Promise<DataDomain | null> {
  for (const domain of DOMAIN_BACKFILL_ORDER) {
    const incomplete = await nextIncompleteTable(env, domain)
    if (incomplete) return domain
    const incremental = await nextDataDomainIncrementalCatchupTable(env, domain)
    if (incremental) return domain
  }
  return null
}

export async function enqueueNextDataDomainShadowBackfill(
  env: Bindings,
  input: { runDate: string; maxAttempts?: number },
): Promise<{ caughtUp: boolean; domain: DataDomain | null; queued: boolean; runId: string | null }> {
  const domain = await nextDataDomainBackfillDomain(env)
  if (!domain) return { caughtUp: true, domain: null, queued: false, runId: null }
  const queued = await enqueueDataDomainShadowBackfill(env, {
    domain,
    runDate: input.runDate,
    maxAttempts: input.maxAttempts,
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
): Promise<string | null> {
  const target = shadowDatabaseForDataDomain(env, domain)
  if (!target) throw new Error(`data_domain_shadow_binding_missing:${domain}`)
  const completedSet = new Set(await completedDomainTables(env, domain))
  for (const table of tablesForDataDomainShadowBackfill(domain)) {
    if (!completedSet.has(table)) continue
    const [sourceRows, targetRows, sourceWatermark, targetWatermark] = await Promise.all([
      tableRowCount(env.DB, table),
      tableRowCount(target, table),
      tableFreshnessWatermark(env.DB, table),
      tableFreshnessWatermark(target, table),
    ])
    const reason = sourceRows !== targetRows
      ? `row_count_changed:${sourceRows}/${targetRows}`
      : !sameFreshnessWatermark(sourceWatermark, targetWatermark)
        ? `freshness_watermark_changed:${JSON.stringify(sourceWatermark)}/${JSON.stringify(targetWatermark)}`
        : null
    if (reason) {
      await resetDataDomainTableForCatchup(env, domain, table, reason)
      return table
    }
  }
  return null
}

async function domainChecksumReady(env: Bindings, domain: DataDomain): Promise<boolean> {
  const completedTables = await completedDomainTables(env, domain)
  const parity = await env.DB.prepare(`
    SELECT table_name
      FROM data_domain_parity_checks
     WHERE domain=? AND check_kind='full_table' AND status='pass'
  `).bind(domain).all<{ table_name: string }>()
  const parityTables = (parity.results ?? []).map((row) => String(row.table_name))
  return isDomainShadowCutoverReady(tablesForDataDomainShadowBackfill(domain), completedTables, parityTables)
}

export async function enqueueDataDomainShadowBackfill(
  env: Pick<Bindings, 'KV' | 'UPDATE_QUEUE'>,
  input: {
    domain: DataDomain
    runDate: string
    table?: string
    runId?: string
    maxAttempts?: number
  },
): Promise<{ queued: boolean; runId: string }> {
  const runId = input.runId ?? `data-domain-shadow-backfill:${input.domain}:${input.runDate}:${crypto.randomUUID()}`
  const key = activeKey(input.domain)
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

  await env.KV.put(key, JSON.stringify({ run_id: runId, started_at: new Date().toISOString() }), {
    expirationTtl: ACTIVE_TTL_SECONDS,
  })
  try {
    await (env.UPDATE_QUEUE as any).send(queueMessage({
      domain: input.domain,
      table: input.table,
      runDate: input.runDate,
      runId,
      attempt: 0,
      maxAttempts,
    }))
    return { queued: true, runId }
  } catch (error) {
    await env.KV.delete(key).catch(() => {})
    throw error
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
  const backfillTables = tablesForDataDomainShadowBackfill(domain)
  const requestedTable = msg.dataDomainTable
  const table = requestedTable && backfillTables.includes(requestedTable)
    ? requestedTable
    : await nextIncompleteTable(env, domain)
      || await nextDataDomainIncrementalCatchupTable(env, domain)
  if (!table) {
    const checksumReady = await domainChecksumReady(env, domain)
    await env.KV.delete(activeKey(domain))
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: checksumReady ? 'success' : 'error',
      summary: `domain=${domain} initial_copy_complete checksum_ready=${checksumReady} run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }

  let leased: DomainShadowBackfillResult | { skipped: true; reason: string }
  try {
    leased = await runWithMaintenanceLease(env.DB, {
      taskName: `data-domain-shadow-backfill:${domain}`,
      leaseGroup: 'd1_heavy_maintenance',
      leaseSeconds: 300,
      run: () => backfillDataDomainTableShadow(env, { domain, table, limit: 500 }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
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
      await env.KV.delete(activeKey(domain))
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
      runDate: msg.triggerTime,
      runId,
      attempt: nextAttempt,
      maxAttempts,
      errorAttempt: nextErrorAttempt,
    }), { delaySeconds: 30 * (2 ** errorAttempt) })
    return
  }
  if ('skipped' in leased && leased.skipped) {
    await (env.UPDATE_QUEUE as any).send(queueMessage({ domain, table, runDate: msg.triggerTime, runId, attempt, maxAttempts }), {
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

  if (attempt + 1 >= maxAttempts) {
    await env.KV.delete(activeKey(domain))
    await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
      status: 'error',
      summary: `domain=${domain} exhausted attempts=${attempt + 1}/${maxAttempts} table=${table}`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }

  const nextTable = ['shadow_progress', 'shadow_parity_progress'].includes(result.status)
    ? table
    : await nextIncompleteTable(env, domain)
      || await nextDataDomainIncrementalCatchupTable(env, domain)
  if (nextTable) {
    await env.KV.put(activeKey(domain), JSON.stringify({
      run_id: runId,
      started_at: new Date().toISOString(),
    }), { expirationTtl: ACTIVE_TTL_SECONDS })
    await (env.UPDATE_QUEUE as any).send(queueMessage({
      domain,
      table: nextTable,
      runDate: msg.triggerTime,
      runId,
      attempt: attempt + 1,
      maxAttempts,
    }), { delaySeconds: 1 })
    return
  }

  await env.KV.delete(activeKey(domain))
  await logSchedulerResult(env.KV, 'data-domain-shadow-backfill', {
    status: result.domain_shadow_ready ? 'success' : 'error',
    summary: `domain=${domain} tables_complete=true checksum_ready=${Boolean(result.domain_shadow_ready)} run_id=${runId}`,
    duration_ms: 0,
    run_id: runId,
    run_date: msg.triggerTime,
  }, env)
}