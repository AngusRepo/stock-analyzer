// /api/paper/gate-calibration: how the entry gate treated pending buys over a trading-date window.
//
// The previous version summed every paper_execution_events row (snapshot_audit, finlab, l5 and
// intraday_technical_decision included) into total_events, but only counted statuses named
// filled/deferred/skipped, which no entry gate writes, so the card showed total ~4,900 with
// filled = deferred = skipped = 0 (data-errors-findings.md item 2). One intraday check also
// writes 2-3 rows (intraday_technical_decision/defer, pending_buy/checked_waiting and, outside
// swing_waiting_*, a pending_buy/execution_blocked companion).
//
// Now: one outcome per pending_buy check, filled from paper_orders, and
// total = filled + deferred + blocked + skipped.
//   checked_waiting                                   -> deferred
//   checked_waiting + execution_blocked companion     -> blocked
//   quote_unavailable                                 -> blocked
//   cancelled, allocator_skip, skipped                -> skipped
// ('expired' is left out until it is decided whether an expired pending buy is a gate skip.)
// A check is its primary row (checked_waiting, quote_unavailable, cancelled, allocator_skip, skipped).
// execution_blocked is only ever written as the companion of a primary
// (paperEntryTasks recordActiveExecutionStatus): same symbol and reason, inserted right after it by
// the same sequential writer, so it marks that primary as blocked and is never counted on its own.
// Other pending_buy statuses (submitted, completed, ...) are lifecycle notes and are left out.
// submitted also gets a companion; a companion only belongs to p when no other pending_buy row of
// the same symbol sits between them, so a submitted note's companion is never paired with an
// earlier checked_waiting of the same symbol and reason.
// filled counts only gate-owned buys (source 'auto_ml', paperEntryTasks); manual
// POST /api/paper/buy orders (source defaults to 'manual') never passed the gate.

export type GateOutcome = 'deferred' | 'blocked' | 'skipped'

// The companion is looked up by rowid (the next few ids) instead of by time, so a pair that
// straddles a second or minute stays one check and two checks in the same minute stay two.
// NOT INDEXED keeps that lookup on the rowid range; otherwise the planner picks
// idx_paper_execution_events_account_created and walks every account event per check.
const COMPANION_ID_WINDOW = 5

// The pinned index keeps the trading-date range seek; idx_paper_execution_events_account_created
// would otherwise walk every account-1 event since the table began (prod EXPLAIN 2026-11-26).
export const PAPER_GATE_CHECKS_SQL = `
  WITH checks AS (
    SELECT CASE
             WHEN p.status IN ('cancelled', 'allocator_skip', 'skipped') THEN 'skipped'
             WHEN p.status = 'quote_unavailable' THEN 'blocked'
             WHEN EXISTS (
               SELECT 1 FROM paper_execution_events b NOT INDEXED
                WHERE b.id > p.id AND b.id <= p.id + ${COMPANION_ID_WINDOW}
                  AND b.event_type = 'pending_buy' AND b.status = 'execution_blocked'
                  AND b.symbol IS p.symbol AND b.reason IS p.reason AND b.account_id = p.account_id
                  AND NOT EXISTS (
                    SELECT 1 FROM paper_execution_events m NOT INDEXED
                     WHERE m.id > p.id AND m.id < b.id
                       AND m.event_type = 'pending_buy' AND m.symbol IS p.symbol AND m.account_id = p.account_id
                  )
             ) THEN 'blocked'
             ELSE 'deferred'
           END AS outcome,
           p.status, p.reason, p.source, p.created_at
      FROM paper_execution_events p INDEXED BY idx_paper_execution_events_date
     WHERE p.trade_date >= ? AND p.trade_date <= ?
       AND p.event_type = 'pending_buy'
       AND p.status IN ('checked_waiting', 'quote_unavailable', 'cancelled', 'allocator_skip', 'skipped')
       AND p.account_id = ?
  )
  SELECT outcome, status, reason, source, COUNT(*) AS count, MAX(created_at) AS last_seen
    FROM checks
   GROUP BY outcome, status, reason, source
   ORDER BY count DESC, last_seen DESC`

// created_at mixes 'YYYY-MM-DD HH:MM:SS' and ISO 'YYYY-MM-DDTHH:MM:SSZ' (UTC). The plain string
// range (whole UTC days) keeps the (account_id, side, created_at) seek; datetime() applies the
// exact UTC bounds of the Taiwan trading-date window.
export const PAPER_GATE_FILLED_SQL = `
  SELECT COUNT(*) AS filled
    FROM paper_orders
   WHERE account_id = ? AND side = 'buy'
     AND created_at >= ? AND created_at < ?
     AND source = 'auto_ml'
     AND datetime(created_at) >= ? AND datetime(created_at) < ?`

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** UTC bounds of [windowStart 00:00, windowEnd+1 00:00) Taiwan time (UTC+8). */
export function gateWindowUtcBounds(windowStart: string, windowEnd: string) {
  const startUtc = `${shiftDate(windowStart, -1)} 16:00:00`
  const endUtc = `${windowEnd} 16:00:00`
  return { coarseStart: shiftDate(windowStart, -1), coarseEnd: shiftDate(windowEnd, 1), startUtc, endUtc }
}

export type GateCalibrationRow = {
  outcome: GateOutcome
  event_type: 'pending_buy'
  status: string
  reason: string
  source: string | null
  count: number
  last_seen: string | null
}

export async function buildPaperGateCalibration(
  db: D1Database,
  input: { accountId: number; days: number; windowStart: string; windowEnd: string },
) {
  const bounds = gateWindowUtcBounds(input.windowStart, input.windowEnd)
  const [checks, filledRow] = await Promise.all([
    db.prepare(PAPER_GATE_CHECKS_SQL).bind(input.windowStart, input.windowEnd, input.accountId).all<any>(),
    db.prepare(PAPER_GATE_FILLED_SQL)
      .bind(input.accountId, bounds.coarseStart, bounds.coarseEnd, bounds.startUtc, bounds.endUtc)
      .first<{ filled: number }>(),
  ])
  const rows: GateCalibrationRow[] = (checks.results ?? []).flatMap((row: any) => {
    const outcome = row.outcome as GateOutcome
    if (!['deferred', 'blocked', 'skipped'].includes(outcome)) return []
    return [{
      outcome,
      event_type: 'pending_buy' as const,
      status: String(row.status ?? 'unknown'),
      reason: String(row.reason ?? 'unknown'),
      source: row.source ?? null,
      count: Number(row.count ?? 0),
      last_seen: row.last_seen ?? null,
    }]
  })
  const sum = (outcome: GateOutcome) => rows.filter((row) => row.outcome === outcome).reduce((total, row) => total + row.count, 0)
  const filled = Number(filledRow?.filled ?? 0)
  const deferred = sum('deferred')
  const blocked = sum('blocked')
  const skipped = sum('skipped')
  return {
    status: 'success' as const,
    days: input.days,
    window_start: input.windowStart,
    window_end: input.windowEnd,
    denominator_definition: 'pending_buy checks (one primary row each; execution_blocked companions mark it blocked) + paper_orders buys; total = filled + deferred + blocked + skipped',
    total_events: filled + deferred + blocked + skipped,
    filled_events: filled,
    deferred_events: deferred,
    blocked_events: blocked,
    skipped_events: skipped,
    // Subset of skipped_events (kept for existing readers).
    cancelled_events: rows.filter((row) => row.status === 'cancelled').reduce((total, row) => total + row.count, 0),
    rows,
  }
}
