import type { Bindings, UpdateQueueMsg } from '../types'
import {
  backfillDataDomainTableShadow,
  isDomainShadowCutoverReady,
  type DomainShadowBackfillResult,
} from './dataDomainShadowBackfill'
import {
  shadowDatabaseForDataDomain,
  tablesForDataDomain,
  type DataDomain,
} from './dataDomainRegistry'
import { runWithMaintenanceLease } from './maintenanceLease'
import { logSchedulerResult } from './schedulerRunLogger'

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
}): UpdateQueueMsg {
  return {
    type: 'data_domain_shadow_backfill',
    cursor: 0,
    triggerTime: input.runDate,
    runId: input.runId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
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
  return tablesForDataDomain(domain).find((table) => !completedSet.has(table)) ?? null
}

async function tableRowCount(db: D1Database, table: string): Promise<number> {
  const trustedTable = table.replace(/[^a-z0-9_]/g, '')
  if (trustedTable !== table) throw new Error(`invalid_data_domain_table:${table}`)
  const row = await db.prepare(`SELECT COUNT(*) AS row_count FROM "${trustedTable}"`).first<{
    row_count?: number | string
  }>()
  return Math.max(0, Number(row?.row_count ?? 0))
}

const DOMAIN_BACKFILL_ORDER: DataDomain[] = ['ops', 'learning', 'market', 'research', 'core']

export async function nextDataDomainBackfillDomain(env: Bindings): Promise<DataDomain | null> {
  for (const domain of DOMAIN_BACKFILL_ORDER) {
    const incomplete = await nextIncompleteTable(env, domain)
    if (incomplete) return domain
    const incremental = await nextDataDomainIncrementalCatchupTable(env, domain)
    if (incremental) return domain
  }
  return null
}

export async function nextDataDomainIncrementalCatchupTable(
  env: Bindings,
  domain: DataDomain,
): Promise<string | null> {
  const target = shadowDatabaseForDataDomain(env, domain)
  if (!target) throw new Error(`data_domain_shadow_binding_missing:${domain}`)
  const completedSet = new Set(await completedDomainTables(env, domain))
  for (const table of tablesForDataDomain(domain)) {
    if (!completedSet.has(table)) continue
    const [sourceRows, targetRows] = await Promise.all([
      tableRowCount(env.DB, table),
      tableRowCount(target, table),
    ])
    if (sourceRows !== targetRows) return table
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
  return isDomainShadowCutoverReady(tablesForDataDomain(domain), completedTables, parityTables)
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
  const runId = msg.runId ?? `data-domain-shadow-backfill:${domain}:${msg.triggerTime}:queue`
  const table = msg.dataDomainTable
    || await nextIncompleteTable(env, domain)
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

  const leased = await runWithMaintenanceLease(env.DB, {
    taskName: `data-domain-shadow-backfill:${domain}`,
    leaseGroup: 'd1_heavy_maintenance',
    leaseSeconds: 300,
    run: () => backfillDataDomainTableShadow(env, { domain, table, limit: 500 }),
  })
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