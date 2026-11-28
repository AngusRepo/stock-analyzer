/** /v1/paper/nav: the paper account's daily NAV against the TAIEX, window return, drawdown, current positions
 * and today's orders (p4_sources.md §1). Account 1, as paperAccountId() outside an execution scope.
 * The index is CORE_DB market_risk.twii_close (paper_daily_snapshots.twii_value was NULL 10/30 until the session-close fix);
 * benchmark_value is the 0050 close, not the index. No ORDER BY: every read is an index range, sorted in JS. */
import { addDays, twDate, type MonitoringEnv } from './env'

export const PAPER_ACCOUNT_ID = 1

type SnapshotRow = { date: string; cash: number; positions_value: number; total_value: number; pnl_pct: number
  benchmark_value: number | null; max_drawdown_to_date: number | null }

const SNAPSHOTS_SQL = `SELECT date, cash, positions_value, total_value, pnl_pct, benchmark_value, max_drawdown_to_date
  FROM paper_daily_snapshots WHERE account_id = ? AND date >= ?`
const TWII_SQL = 'SELECT date, twii_close FROM market_risk WHERE date >= ?'
const POSITIONS_SQL = `SELECT symbol, name, shares, avg_cost, entry_price, entry_date, updated_at
  FROM paper_positions WHERE account_id = ? AND shares > 0`
// created_at is 'YYYY-MM-DD HH:MM:SS' UTC: a range is an index seek, date(created_at, '+8 hours') = ? is not.
// No GROUP BY side either: it moves the planner to idx_paper_orders_account_side_created and the whole account.
const ORDERS_SQL = `SELECT id, symbol, side, shares, price, total_cost, source, created_at
  FROM paper_orders WHERE account_id = ? AND created_at >= ? AND created_at < ?`
const INTENTS_SQL = `SELECT symbol, side, source, status, order_id, error_message, updated_at
  FROM paper_order_intents WHERE trade_date = ? AND account_id = ?`

const pct = (value: number) => Math.round(value * 1e4) / 1e2
const returnPct = (value: number | null, base: number | null) => value != null && base != null && base > 0 ? pct(value / base - 1) : null

export async function paperNavReport(env: MonitoringEnv, nowMs: number, days: number) {
  const today = twDate(nowMs)
  const since = addDays(today, -(days - 1))
  // TW calendar day today = [today−1 16:00, today 16:00) UTC.
  const ordersFrom = `${addDays(today, -1)} 16:00:00`
  const ordersTo = `${today} 16:00:00`
  const [snapshots, twii, positions, orders, intents] = await Promise.all([
    env.PAPER_DB.prepare(SNAPSHOTS_SQL).bind(PAPER_ACCOUNT_ID, since).all<SnapshotRow>(),
    env.CORE_DB ? env.CORE_DB.prepare(TWII_SQL).bind(since).all<{ date: string; twii_close: number | null }>() : null,
    env.PAPER_DB.prepare(POSITIONS_SQL).bind(PAPER_ACCOUNT_ID).all<Record<string, unknown>>(),
    env.PAPER_DB.prepare(ORDERS_SQL).bind(PAPER_ACCOUNT_ID, ordersFrom, ordersTo).all<Record<string, unknown>>(),
    env.PAPER_DB.prepare(INTENTS_SQL).bind(today, PAPER_ACCOUNT_ID).all<Record<string, unknown>>(),
  ])
  const twiiByDate = new Map((twii?.results ?? []).map((row) => [row.date, row.twii_close != null && row.twii_close > 0 ? row.twii_close : null]))
  const ordered = (snapshots.results ?? []).sort((a, b) => a.date.localeCompare(b.date))
  // Each line is rebased to its first value in the window; a missing index close stays null (never an older close).
  const navBase = ordered[0]?.total_value ?? null
  const twiiBase = ordered.map((row) => twiiByDate.get(row.date) ?? null).find((value) => value != null) ?? null
  let peak = 0
  const rows = ordered.map((row) => {
    // Drawdown from the running peak inside the window, as paperWorkerTasks.ts computes max_drawdown_to_date
    // from the whole history; the stored all-history value is max_drawdown_to_date_pct.
    peak = Math.max(peak, row.total_value)
    const twiiClose = twiiByDate.get(row.date) ?? null
    const navReturn = returnPct(row.total_value, navBase)
    const twiiReturn = returnPct(twiiClose, twiiBase)
    return {
      date: row.date, nav: row.total_value, cash: row.cash, positions_value: row.positions_value,
      nav_return_pct: navReturn, twii_close: twiiClose, twii_return_pct: twiiReturn,
      excess_return_pct: navReturn != null && twiiReturn != null ? pct((navReturn - twiiReturn) / 100) : null,
      drawdown_pct: peak > 0 ? pct(row.total_value / peak - 1) : null,
      pnl_pct_since_inception: row.pnl_pct, benchmark_0050_close: row.benchmark_value,
      max_drawdown_to_date_pct: row.max_drawdown_to_date != null ? pct(row.max_drawdown_to_date) : null,
    }
  })
  const last = rows.at(-1)
  // The index close lands after the paper snapshot, so the benchmark figures come from the last day that has one.
  const lastIndexed = [...rows].reverse().find((row) => row.twii_close != null)
  const orderRows = (orders.results ?? []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  return {
    account_id: PAPER_ACCOUNT_ID, today, since, days,
    index_source: env.CORE_DB ? 'core.market_risk.twii_close' : 'unavailable_no_core_db',
    summary: {
      latest_date: last?.date ?? null, nav: last?.nav ?? null, nav_return_pct: last?.nav_return_pct ?? null,
      twii_as_of: lastIndexed?.date ?? null, twii_return_pct: lastIndexed?.twii_return_pct ?? null, excess_return_pct: lastIndexed?.excess_return_pct ?? null,
      drawdown_pct: last?.drawdown_pct ?? null, min_drawdown_pct: rows.reduce<number | null>((min, row) =>
        row.drawdown_pct == null ? min : min == null ? row.drawdown_pct : Math.min(min, row.drawdown_pct), null),
      pnl_pct_since_inception: last?.pnl_pct_since_inception ?? null, max_drawdown_to_date_pct: last?.max_drawdown_to_date_pct ?? null,
      positions: positions.results?.length ?? 0, orders_today: orderRows.length,
      buys_today: orderRows.filter((row) => row.side === 'buy').length, sells_today: orderRows.filter((row) => row.side === 'sell').length,
      intents_today: intents.results?.length ?? 0,
    },
    rows,
    positions: (positions.results ?? []).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))),
    orders_today: orderRows,
    intents_today: (intents.results ?? []).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))),
  }
}
