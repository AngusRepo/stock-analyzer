import type { Bindings } from '../types'
import { writeEvidenceArtifact, type EvidenceArtifactManifest } from './artifactLifecycle'
import { activeDataDomains, MULTI_D1_STRICT_ROUTING_READY } from './dataDomainRegistry'

export const DAILY_EXECUTION_PAPER_LINEAGE_SCHEMA_VERSION = 'daily-execution-paper-lineage-v1'

type CountResult = { count: number | string | null }

async function countRows(db: D1Database | undefined, sql: string, ...binds: unknown[]): Promise<number | null> {
  if (!db) return null
  try {
    const row = await db.prepare(sql).bind(...binds).first<CountResult>()
    return Math.max(0, Number(row?.count ?? 0))
  } catch (error) {
    if (/no such table/i.test(String(error))) return null
    throw error
  }
}

async function paperSnapshot(db: D1Database, businessDate: string): Promise<Record<string, unknown> | null> {
  return db.prepare(`
    SELECT account_id, date, cash, positions_value, total_value, pnl, pnl_pct, created_at
      FROM paper_daily_snapshots
     WHERE date=?
     ORDER BY account_id
     LIMIT 1
  `).bind(businessDate).first<Record<string, unknown>>()
}

export interface DailyExecutionPaperClosureResult {
  execution: EvidenceArtifactManifest
  paper: EvidenceArtifactManifest
  activity_status: 'activity' | 'no_activity'
}

export async function writeDailyExecutionPaperClosureArtifacts(
  env: Bindings,
  businessDate: string,
): Promise<DailyExecutionPaperClosureResult> {
  const activeDomains = [...activeDataDomains(env)].sort()
  const [
    legacyBrokerIntents,
    legacyBrokerEvents,
    splitBrokerIntents,
    splitBrokerEvents,
    legacyPaperOrders,
    legacyPaperEvents,
    splitPaperOrders,
    splitPaperEvents,
    snapshot,
  ] = await Promise.all([
    countRows(env.DB, 'SELECT COUNT(*) count FROM broker_execution_intents WHERE trade_date=?', businessDate),
    countRows(env.DB, `
      SELECT COUNT(*) count
        FROM broker_execution_events
       WHERE date(event_time)=date(?) OR date(received_at)=date(?)
    `, businessDate, businessDate),
    countRows(env.EXECUTION_DB, 'SELECT COUNT(*) count FROM broker_execution_intents WHERE trade_date=?', businessDate),
    countRows(env.EXECUTION_DB, `
      SELECT COUNT(*) count
        FROM broker_execution_events
       WHERE date(event_time)=date(?) OR date(received_at)=date(?)
    `, businessDate, businessDate),
    countRows(env.DB, 'SELECT COUNT(*) count FROM paper_orders WHERE date(created_at)=date(?)', businessDate),
    countRows(env.DB, 'SELECT COUNT(*) count FROM paper_execution_events WHERE trade_date=?', businessDate),
    countRows(env.PAPER_DB, 'SELECT COUNT(*) count FROM paper_orders WHERE date(created_at)=date(?)', businessDate),
    countRows(env.PAPER_DB, 'SELECT COUNT(*) count FROM paper_execution_events WHERE trade_date=?', businessDate),
    paperSnapshot(env.DB, businessDate),
  ])

  const executionRows = (legacyBrokerIntents ?? 0) + (legacyBrokerEvents ?? 0)
  const paperRows = (legacyPaperOrders ?? 0) + (legacyPaperEvents ?? 0)
  const activityStatus = executionRows + paperRows > 0 ? 'activity' : 'no_activity'
  const routing = {
    active_domains: activeDomains,
    strict_requested: String(env.MULTI_D1_STRICT ?? '').toLowerCase() === 'true',
    strict_routing_ready: MULTI_D1_STRICT_ROUTING_READY,
    execution_target_schema_available: splitBrokerIntents != null && splitBrokerEvents != null,
    paper_target_schema_available: splitPaperOrders != null && splitPaperEvents != null,
  }

  const executionProducerRunId = `daily-execution-closure:${businessDate}`
  const execution = await writeEvidenceArtifact(env, {
    domain: 'execution_daily_closure',
    businessDate,
    producerRunId: executionProducerRunId,
    canonicalRunId: executionProducerRunId,
    retentionClass: 'canonical_execution',
    schemaVersion: DAILY_EXECUTION_PAPER_LINEAGE_SCHEMA_VERSION,
    rowCount: executionRows,
    payload: {
      business_date: businessDate,
      closure_kind: 'daily_execution_lineage',
      activity_status: activityStatus,
      legacy: { broker_intents: legacyBrokerIntents, broker_events: legacyBrokerEvents },
      split_shadow: { broker_intents: splitBrokerIntents, broker_events: splitBrokerEvents },
      routing,
      real_order_effect: 'none',
    },
    metadata: { closure_kind: 'daily_execution_lineage', activity_status: activityStatus },
  })

  const paperProducerRunId = `daily-paper-shadow-closure:${businessDate}`
  const paper = await writeEvidenceArtifact(env, {
    domain: 'paper_daily_closure',
    businessDate,
    producerRunId: paperProducerRunId,
    canonicalRunId: paperProducerRunId,
    retentionClass: 'paper_shadow',
    schemaVersion: DAILY_EXECUTION_PAPER_LINEAGE_SCHEMA_VERSION,
    rowCount: paperRows + (snapshot ? 1 : 0),
    payload: {
      business_date: businessDate,
      closure_kind: 'daily_paper_shadow_lineage',
      activity_status: activityStatus,
      legacy: { paper_orders: legacyPaperOrders, paper_execution_events: legacyPaperEvents, snapshot },
      split_shadow: { paper_orders: splitPaperOrders, paper_execution_events: splitPaperEvents },
      routing,
      real_order_effect: 'none',
    },
    metadata: { closure_kind: 'daily_paper_shadow_lineage', activity_status: activityStatus },
  })

  return { execution, paper, activity_status: activityStatus }
}
