/** /v1/data-readiness: the OBS data-readiness gates (price / chip / technical freshness and the market
 * dashboard materialization sources of buildDataQualityReport) with every read rewritten as an index seek:
 * MAX(date) via the min/max index optimisation, counts only on the latest date. The judgments are the
 * main Worker's own buildFreshnessCheck / buildMarketDashboardMaterializationCheck; the gate rows are the
 * copied OBS mapping (judgment/obsJudgment.ts). */
import {
  buildFreshnessCheck, buildMarketDashboardMaterializationCheck, DATA_QUALITY_CHIP_READY_MINUTE_TW,
  DATA_QUALITY_MARKET_DASHBOARD_READY_MINUTE_TW, DATA_QUALITY_TECHNICAL_READY_MINUTE_TW, resolveExpectedCompletedDataDate,
  type DataQualityCheck,
} from '../lib/dataQualityMonitor'
import { buildReadinessGates } from './judgment/obsJudgment'
import { addDays, memoized, twDate, TW_OFFSET_MS, type Memo, type MonitoringEnv } from './env'

type Row = Record<string, unknown>
const first = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<Row> =>
  (await db.prepare(sql).bind(...binds).first<Row>()) ?? {}

/** The four per-stock counts are ~14k of this endpoint's rows (prod 11/25: 2,223 + 2,233 + 2,222 + 7,201).
 * A date gains rows only by inserts, and every insert raises MAX(rowid) (one seek on these rowid tables), so a
 * count is reused while the dates and MAX(rowid) are unchanged. The TTL bounds what a delete could hide. */
export const COUNT_MEMO_TTL_S = 6 * 3600

async function unlessInserted<T>(db: D1Database, memo: Memo | undefined, table: string, dates: Array<string | null>, count: () => Promise<T>): Promise<T> {
  if (!memo) return count()
  const mark = (await first(db, `SELECT MAX(rowid) AS mark FROM ${table}`)).mark
  return memoized(memo, `count|${table}|${dates.join('|')}|${mark}`, COUNT_MEMO_TTL_S, count)
}

/** Latest date of an indexed date column and the row count on that date only. */
async function latestDateStats(db: D1Database, memo: Memo | undefined, table: 'stock_prices' | 'chip_data' | 'technical_indicators') {
  const latest = (await first(db, `SELECT MAX(date) AS latest_date FROM ${table}`)).latest_date as string | null
  if (!latest) return { latest_date: null, rows_on_latest: 0 }
  const count = await unlessInserted(db, memo, table, [latest], () => first(db, `SELECT COUNT(*) AS count FROM ${table} WHERE date = ?`, latest))
  return { latest_date: latest, rows_on_latest: Number(count.count ?? 0) }
}

/** MAX(date) per symbol through the (symbol[, session], date) index, then the rows on the newest of them. */
async function latestForSymbols(db: D1Database, table: 'canonical_market_index_daily' | 'canonical_futures_daily', symbols: string[], daySession: boolean) {
  const session = daySession ? " AND session = 'day'" : ''
  const maxima = await db.batch<Row>(symbols.map((symbol) =>
    db.prepare(`SELECT MAX(date) AS latest_date FROM ${table} WHERE symbol = ?${session}`).bind(symbol)))
  const latest = maxima.map((result) => result.results?.[0]?.latest_date as string | null).filter(Boolean).sort().at(-1) ?? null
  if (!latest) return { latest_date: null, rows_on_latest: 0 }
  const count = await first(db, `SELECT COUNT(*) AS rows_on_latest FROM ${table} WHERE symbol IN (${symbols.map(() => '?').join(', ')})${session} AND date = ?`,
    ...symbols, latest)
  return { latest_date: latest, rows_on_latest: Number(count.rows_on_latest ?? 0) }
}

async function latestDatasetStats(db: D1Database, dataset: string) {
  const latest = (await first(db, 'SELECT MAX(date) AS latest_date FROM canonical_regime_context_daily WHERE dataset = ?', dataset)).latest_date as string | null
  if (!latest) return { latest_date: null, rows_on_latest: 0 }
  const count = await first(db, 'SELECT COUNT(*) AS rows_on_latest FROM canonical_regime_context_daily WHERE dataset = ? AND date = ?', dataset, latest)
  return { latest_date: latest, rows_on_latest: Number(count.rows_on_latest ?? 0) }
}

const LISTED_OTC_WALK = 5

/** The newest date at or before `start` that has LISTED_OTC rows (one LIMIT 1 seek per date tried). */
async function listedOtcDateAtOrBefore(db: D1Database, start: string | null): Promise<string | null> {
  let date = start
  for (let step = 0; date && step < LISTED_OTC_WALK; step++) {
    const hit = await first(db, "SELECT 1 AS hit FROM canonical_market_daily WHERE date = ? AND market_segment = 'LISTED_OTC' LIMIT 1", date)
    if (hit.hit) return date
    date = (await first(db, 'SELECT MAX(date) AS d FROM canonical_market_daily WHERE date < ?', date)).d as string | null
  }
  return null
}

/** Market breadth / turnover on the newest LISTED_OTC date: the latest rows by the date index, previous close by primary key. */
async function marketOverviewStats(db: D1Database, memo: Memo | undefined) {
  const max = (await first(db, 'SELECT MAX(date) AS d FROM canonical_market_daily')).d as string | null
  const latest = await listedOtcDateAtOrBefore(db, max)
  if (!latest) return { latest_date: null, market_breadth_rows: 0, turnover_rows: 0, rows_on_latest: 0 }
  const before = (await first(db, 'SELECT MAX(date) AS d FROM canonical_market_daily WHERE date < ?', latest)).d as string | null
  const previous = await listedOtcDateAtOrBefore(db, before)
  const stats = await unlessInserted(db, memo, 'canonical_market_daily', [latest, previous], () => first(db, `SELECT COUNT(CASE WHEN prev.close IS NOT NULL THEN 1 END) AS market_breadth_rows,
          COUNT(CASE WHEN cur.volume IS NOT NULL OR cur.value IS NOT NULL THEN 1 END) AS turnover_rows,
          COUNT(*) AS rows_on_latest
     FROM canonical_market_daily cur
     LEFT JOIN canonical_market_daily prev
       ON prev.stock_id = cur.stock_id AND prev.date = ? AND prev.market_segment = cur.market_segment
    WHERE cur.date = ? AND cur.market_segment = 'LISTED_OTC' AND cur.close IS NOT NULL`, previous ?? '', latest))
  return { latest_date: latest, ...stats }
}

async function latestByDateIndex(db: D1Database, table: 'canonical_market_summary_daily' | 'canonical_institutional_amount_daily', columns: string) {
  const latest = (await first(db, `SELECT MAX(date) AS latest_date FROM ${table}`)).latest_date as string | null
  if (!latest) return { latest_date: null, rows_on_latest: 0 }
  return { latest_date: latest, ...(await first(db, `SELECT COUNT(*) AS rows_on_latest${columns} FROM ${table} WHERE date = ?`, latest)) }
}

const MARKET_SUMMARY_COLUMNS = `,
       SUM(CASE WHEN margin_balance_value IS NOT NULL OR margin_balance_units IS NOT NULL THEN 1 ELSE 0 END) AS margin_rows,
       SUM(CASE WHEN short_balance_units IS NOT NULL THEN 1 ELSE 0 END) AS short_rows`

/** The only gdelt_events dataset in prod (11/25: 103 rows). Pinning it turns the main Worker's
 * `WHERE source = ? ORDER BY as_of_date DESC LIMIT 1` (sorts every gdelt row) into one index seek. */
export const GDELT_QUALITY_DATASET = 'global_event_pressure'

async function gdeltStats(db: D1Database, targetDate: string) {
  // `+accepted`: keeps the planner off idx_external_evidence_accepted(accepted, published_at), which walks the
  // accepted rows of every source (all of them when GDELT is stale); idx_external_evidence_source_date seeks GDELT only.
  const [recent, latest, quality] = await Promise.all([
    first(db, "SELECT COUNT(*) AS rows_on_latest FROM external_evidence_items WHERE source_id = 'gdelt_events' AND published_at >= ? AND +accepted = 1",
      addDays(targetDate, -14)),
    first(db, "SELECT published_at AS latest_date FROM external_evidence_items WHERE source_id = 'gdelt_events' AND +accepted = 1 ORDER BY published_at DESC LIMIT 1"),
    first(db, `SELECT freshness_status, latest_materialization,
                      CASE WHEN json_valid(metrics_json) THEN json_extract(metrics_json, '$.root_cause') ELSE NULL END AS root_cause
                 FROM source_quality_metrics WHERE source = 'gdelt_events' AND dataset = ? ORDER BY as_of_date DESC LIMIT 1`,
      GDELT_QUALITY_DATASET),
  ])
  return { rows_on_latest: Number(recent.rows_on_latest ?? 0), latest_date: (latest.latest_date as string | null) ?? null, quality }
}

const settle = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback)

/** Chip data, technical indicators and the market dashboard sources are written by the evening chain (FinLab canonical
 * and Market update, Indicator queue), not by the close refresh, so today becomes their target only at the writing
 * stage's deadline: the main Worker's minutes (dataQualityMonitor, read from the stage catalog), so both reports and
 * the CD gate move their targets at the same time. */
export const CHIP_READY_MINUTE_TW = DATA_QUALITY_CHIP_READY_MINUTE_TW
export const TECHNICAL_READY_MINUTE_TW = DATA_QUALITY_TECHNICAL_READY_MINUTE_TW
export const MARKET_DASHBOARD_READY_MINUTE_TW = DATA_QUALITY_MARKET_DASHBOARD_READY_MINUTE_TW

/** Lag thresholds are buildDataQualityReport's (pinned by dataReadiness.test.ts against its source). */
export async function dataReadinessReport(env: MonitoringEnv, nowMs: number, requested?: string | null) {
  const expectedAt = (readyMinuteTw?: number) =>
    requested ?? resolveExpectedCompletedDataDate(env.KV, twDate(nowMs), new Date(nowMs + TW_OFFSET_MS), readyMinuteTw)
  const [targetDate, chipTargetDate, technicalTargetDate, dashboardTargetDate] = await Promise.all([
    expectedAt(), expectedAt(CHIP_READY_MINUTE_TW), expectedAt(TECHNICAL_READY_MINUTE_TW), expectedAt(MARKET_DASHBOARD_READY_MINUTE_TW),
  ])
  const db = env.MARKET_DB
  const empty = { latest_date: null, rows_on_latest: 0 }
  // Sequential groups keep at most a few seeks in flight; all of them are single-date or LIMIT 1 reads.
  const [price, chip, technical] = await Promise.all([
    latestDateStats(db, env.MEMO, 'stock_prices'), latestDateStats(db, env.MEMO, 'chip_data'), latestDateStats(db, env.MEMO, 'technical_indicators'),
  ])
  const [twii, twoii, futures, overview, summary, institutional, pcr, largeTrader, business, gdelt] = await Promise.all([
    settle(latestForSymbols(db, 'canonical_market_index_daily', ['TWII', 'TAIEX'], false), empty),
    settle(latestForSymbols(db, 'canonical_market_index_daily', ['TWOII', 'OTC', 'TPEX'], false), empty),
    settle(latestForSymbols(db, 'canonical_futures_daily', ['TXF', 'TX'], true), empty),
    settle(marketOverviewStats(db, env.MEMO), { latest_date: null, market_breadth_rows: 0, turnover_rows: 0, rows_on_latest: 0 } as Row),
    settle(latestByDateIndex(db, 'canonical_market_summary_daily', MARKET_SUMMARY_COLUMNS), empty as Row),
    settle(latestByDateIndex(db, 'canonical_institutional_amount_daily', ''), empty as Row),
    settle(latestDatasetStats(db, 'tw_option_put_call_ratio'), empty),
    settle(latestDatasetStats(db, 'tw_taifex_futures_large_trader'), empty),
    settle(latestDatasetStats(db, 'tw_business_indicators'), empty),
    settle(gdeltStats(db, targetDate), { rows_on_latest: 0, latest_date: null, quality: {} as Row }),
  ])
  const checks: DataQualityCheck[] = [
    buildFreshnessCheck({ id: 'price_freshness', label: 'Price data', latestDate: price.latest_date, targetDate,
      rowsOnLatest: price.rows_on_latest, warnLagDays: 0, failLagDays: 0, minRows: 1000 }),
    buildFreshnessCheck({ id: 'chip_freshness', label: 'Chip data', latestDate: chip.latest_date, targetDate: chipTargetDate,
      rowsOnLatest: chip.rows_on_latest, warnLagDays: 0, failLagDays: 0, minRows: 1000 }),
    buildFreshnessCheck({ id: 'technical_indicator_freshness', label: 'Technical indicators', latestDate: technical.latest_date, targetDate: technicalTargetDate,
      rowsOnLatest: technical.rows_on_latest, warnLagDays: 0, failLagDays: 0, minRows: 1000 }),
    buildMarketDashboardMaterializationCheck({ targetDate: dashboardTargetDate, sources: MATERIALIZATION_SOURCES.map((source) => {
      const stats = ({
        twii_index: [twii.rows_on_latest, twii.latest_date],
        twoii_index: [twoii.rows_on_latest, twoii.latest_date],
        txf_day_futures: [futures.rows_on_latest, futures.latest_date],
        market_breadth: [overview.market_breadth_rows, overview.latest_date],
        market_turnover: [overview.turnover_rows, overview.latest_date],
        margin_short_balance: [Math.min(Number(summary.margin_rows ?? 0), Number(summary.short_rows ?? 0)), summary.latest_date],
        institutional_amount: [institutional.rows_on_latest, institutional.latest_date],
        put_call_ratio: [pcr.rows_on_latest, pcr.latest_date],
        large_trader_net: [largeTrader.rows_on_latest, largeTrader.latest_date],
        business_signal: [business.rows_on_latest, business.latest_date],
        gdelt_global_news: [gdelt.rows_on_latest, gdelt.latest_date ?? (gdelt.quality.latest_materialization as string | null) ?? null],
      } as Record<string, [unknown, unknown]>)[source.key]
      return {
        ...source, rows: Number(stats[0] ?? 0), latestDate: (stats[1] as string | null) ?? null,
        ...(source.key === 'gdelt_global_news'
          ? { rootCause: (gdelt.quality.root_cause ?? gdelt.quality.freshness_status ?? null) as string | null } : {}),
      }
    }) }),
  ]
  const gates = buildReadinessGates(checks)
  return {
    target_date: targetDate,
    status: checks.some((check) => check.status === 'fail') ? 'fail' : checks.some((check) => check.status === 'warn') ? 'warn' : 'ok',
    rows: gates.map(({ tone, ...gate }) => ({ ...gate, tone })),
    checks: checks.map((check) => ({ id: check.id, label: check.label, status: check.status, summary: check.summary,
      latest_date: (check.metrics?.latest_date as string | null) ?? null, lag_days: (check.metrics?.lag_days as number | null) ?? null,
      rows_on_latest: (check.metrics?.rows_on_latest as number | null) ?? null })),
  }
}

/** Copied from buildDataQualityReport's market dashboard sources (keys, labels, lag days, required, scope). */
export const MATERIALIZATION_SOURCES: Array<{ key: string; label: string; source: string; warnLagDays: number; failLagDays: number; required?: boolean; scope: string }> = [
  { key: 'twii_index', label: '加權指數', source: 'canonical_market_index_daily symbol=TWII/TAIEX', warnLagDays: 0, failLagDays: 1, scope: '首頁第一列指數' },
  { key: 'twoii_index', label: '櫃買指數', source: 'canonical_market_index_daily symbol=TWOII/OTC/TPEX', warnLagDays: 0, failLagDays: 1, scope: '首頁第一列指數' },
  { key: 'txf_day_futures', label: '台指期貨日盤', source: 'canonical_futures_daily symbol=TXF/TX session=day', warnLagDays: 0, failLagDays: 1, scope: '首頁第一列指數' },
  { key: 'market_breadth', label: '漲跌家數', source: 'canonical_market_daily LISTED_OTC close vs previous close', warnLagDays: 0, failLagDays: 1, scope: '首頁第二列市場概況' },
  { key: 'market_turnover', label: '成交量與成交金額', source: 'canonical_market_daily LISTED_OTC volume/value', warnLagDays: 0, failLagDays: 1, scope: '首頁第二列市場概況' },
  { key: 'margin_short_balance', label: '融資融券', source: 'canonical_market_summary_daily margin_balance/short_balance', warnLagDays: 0, failLagDays: 1, scope: '首頁第二列市場概況' },
  { key: 'institutional_amount', label: '主要法人資金動向', source: 'canonical_institutional_amount_daily', warnLagDays: 0, failLagDays: 1, scope: '首頁資金流' },
  { key: 'put_call_ratio', label: '買賣權量比', source: 'canonical_regime_context_daily dataset=tw_option_put_call_ratio', warnLagDays: 2, failLagDays: 5, scope: '市場避險情緒' },
  { key: 'large_trader_net', label: '期貨大戶淨部位', source: 'canonical_regime_context_daily dataset=tw_taifex_futures_large_trader', warnLagDays: 2, failLagDays: 5, scope: '市場避險情緒' },
  { key: 'business_signal', label: '景氣對策信號', source: 'canonical_regime_context_daily dataset=tw_business_indicators', warnLagDays: 45, failLagDays: 60, scope: '景氣月頻資料' },
  { key: 'gdelt_global_news', label: 'GDELT 全球新聞脈絡', source: 'external_evidence_items source_id=gdelt_events', warnLagDays: 7, failLagDays: 14, required: false, scope: '最新消息下方全球脈絡' },
]
