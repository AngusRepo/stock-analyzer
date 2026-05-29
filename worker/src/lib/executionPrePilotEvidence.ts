import { twToday } from './dateUtils'

export const REQUIRED_PRE_PILOT_EVENT_TYPES = [
  'finlab_l5_market_data',
  'intraday_technical_decision',
  'paper_broker_reconciliation',
] as const

export type RequiredPrePilotEventType = typeof REQUIRED_PRE_PILOT_EVENT_TYPES[number]

type CountRow = {
  event_type: string
  status: string | null
  count: number | string | null
  latest_created_at: string | null
}

type LatestEventRow = {
  id: number | null
  trade_date: string | null
  symbol: string | null
  event_type: string
  status: string | null
  reason: string | null
  created_at: string | null
}

type PaperOrderCountRow = {
  count: number | string | null
  latest_created_at: string | null
}

export type PrePilotEventCount = {
  total: number
  by_status: Record<string, number>
  latest_created_at: string | null
}

export type ExecutionPrePilotEvidenceReport = {
  success: true
  mode: 'read_only'
  loop: 'production_simulated'
  date: string
  since_utc: string | null
  required_event_types: RequiredPrePilotEventType[]
  complete: boolean
  missing_event_types: RequiredPrePilotEventType[]
  event_counts: Record<RequiredPrePilotEventType, PrePilotEventCount>
  latest_events: LatestEventRow[]
  legacy_shadow_snapshot: {
    total: number
    rows: CountRow[]
  }
  legacy_shadow_snapshot_since: {
    since_utc: string
    total: number
    rows: CountRow[]
  } | null
  paper_orders_since: {
    since_utc: string
    count: number
    latest_created_at: string | null
  } | null
  generated_at: string
  source: 'stockvision_d1_paper_execution_events'
}

export type ExecutionPrePilotEvidenceOptions = {
  date?: string | null
  sinceUtc?: string | null
  limit?: number | null
}

function normalizeTradeDate(date: string | null | undefined): string {
  const value = String(date ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : twToday()
}

function normalizeSinceUtc(value: string | null | undefined): string | null {
  const cleaned = String(value ?? '').trim()
  return cleaned ? cleaned : null
}

function normalizeLimit(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 30
  return Math.max(1, Math.min(Math.trunc(value as number), 100))
}

function toCount(value: unknown): number {
  const count = Number(value ?? 0)
  return Number.isFinite(count) && count > 0 ? count : 0
}

function createEmptyEventCounts(): Record<RequiredPrePilotEventType, PrePilotEventCount> {
  return REQUIRED_PRE_PILOT_EVENT_TYPES.reduce((acc, eventType) => {
    acc[eventType] = {
      total: 0,
      by_status: {},
      latest_created_at: null,
    }
    return acc
  }, {} as Record<RequiredPrePilotEventType, PrePilotEventCount>)
}

function buildEventCounts(rows: CountRow[]): Record<RequiredPrePilotEventType, PrePilotEventCount> {
  const counts = createEmptyEventCounts()
  for (const row of rows) {
    if (!REQUIRED_PRE_PILOT_EVENT_TYPES.includes(row.event_type as RequiredPrePilotEventType)) continue
    const eventType = row.event_type as RequiredPrePilotEventType
    const status = String(row.status ?? 'unknown')
    const count = toCount(row.count)
    counts[eventType].total += count
    counts[eventType].by_status[status] = (counts[eventType].by_status[status] ?? 0) + count
    if (row.latest_created_at && (!counts[eventType].latest_created_at || row.latest_created_at > counts[eventType].latest_created_at)) {
      counts[eventType].latest_created_at = row.latest_created_at
    }
  }
  return counts
}

export async function buildExecutionPrePilotEvidenceReport(
  db: D1Database,
  options: ExecutionPrePilotEvidenceOptions = {},
): Promise<ExecutionPrePilotEvidenceReport> {
  const date = normalizeTradeDate(options.date)
  const sinceUtc = normalizeSinceUtc(options.sinceUtc)
  const limit = normalizeLimit(options.limit)
  const placeholders = REQUIRED_PRE_PILOT_EVENT_TYPES.map(() => '?').join(', ')

  const [eventCountResult, latestEventResult, legacyResult, legacySinceResult, paperOrderResult] = await Promise.all([
    db.prepare(`
      SELECT event_type, status, COUNT(*) AS count, MAX(created_at) AS latest_created_at
      FROM paper_execution_events
      WHERE trade_date = ?
        AND event_type IN (${placeholders})
      GROUP BY event_type, status
      ORDER BY event_type ASC, status ASC
    `).bind(date, ...REQUIRED_PRE_PILOT_EVENT_TYPES).all<CountRow>(),
    db.prepare(`
      SELECT id, trade_date, symbol, event_type, status, reason, created_at
      FROM paper_execution_events
      WHERE trade_date = ?
        AND event_type IN (${placeholders})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(date, ...REQUIRED_PRE_PILOT_EVENT_TYPES, limit).all<LatestEventRow>(),
    db.prepare(`
      SELECT event_type, status, COUNT(*) AS count, MAX(created_at) AS latest_created_at
      FROM paper_execution_events
      WHERE trade_date = ?
        AND (
          event_type = 'finlab_l5_shadow'
          OR event_type = 'intraday_technical_snapshot'
          OR status = 'adaptive_gate_shadow'
        )
      GROUP BY event_type, status
      ORDER BY event_type ASC, status ASC
    `).bind(date).all<CountRow>(),
    sinceUtc
      ? db.prepare(`
          SELECT event_type, status, COUNT(*) AS count, MAX(created_at) AS latest_created_at
          FROM paper_execution_events
          WHERE trade_date = ?
            AND created_at >= ?
            AND (
              event_type = 'finlab_l5_shadow'
              OR event_type = 'intraday_technical_snapshot'
              OR status = 'adaptive_gate_shadow'
            )
          GROUP BY event_type, status
          ORDER BY event_type ASC, status ASC
        `).bind(date, sinceUtc).all<CountRow>()
      : Promise.resolve({ results: [] as CountRow[] }),
    sinceUtc
      ? db.prepare(`
          SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at
          FROM paper_orders
          WHERE created_at >= ?
        `).bind(sinceUtc).all<PaperOrderCountRow>()
      : Promise.resolve({ results: [] as PaperOrderCountRow[] }),
  ])

  const eventCounts = buildEventCounts(eventCountResult.results ?? [])
  const missingEventTypes = REQUIRED_PRE_PILOT_EVENT_TYPES.filter((eventType) => eventCounts[eventType].total <= 0)
  const legacyRows = legacyResult.results ?? []
  const legacySinceRows = legacySinceResult.results ?? []
  const paperOrderRow = paperOrderResult.results?.[0] ?? null

  return {
    success: true,
    mode: 'read_only',
    loop: 'production_simulated',
    date,
    since_utc: sinceUtc,
    required_event_types: [...REQUIRED_PRE_PILOT_EVENT_TYPES],
    complete: missingEventTypes.length === 0,
    missing_event_types: missingEventTypes,
    event_counts: eventCounts,
    latest_events: latestEventResult.results ?? [],
    legacy_shadow_snapshot: {
      total: legacyRows.reduce((sum, row) => sum + toCount(row.count), 0),
      rows: legacyRows,
    },
    legacy_shadow_snapshot_since: sinceUtc
      ? {
          since_utc: sinceUtc,
          total: legacySinceRows.reduce((sum, row) => sum + toCount(row.count), 0),
          rows: legacySinceRows,
        }
      : null,
    paper_orders_since: sinceUtc
      ? {
          since_utc: sinceUtc,
          count: toCount(paperOrderRow?.count),
          latest_created_at: paperOrderRow?.latest_created_at ?? null,
        }
      : null,
    generated_at: new Date().toISOString(),
    source: 'stockvision_d1_paper_execution_events',
  }
}
