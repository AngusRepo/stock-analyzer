import type { Bindings } from '../types'
import { activeDataDomains } from './dataDomainRegistry'
import {
  ensureStrategyLearningTables,
  materializeStrategyDecisionDailyStats,
  refreshStrategyLearningHeads,
} from './strategyLearning'
import {
  refreshStrategyRouteCalibration,
  STRATEGY_ROUTE_CHALLENGER_VERSION,
} from './strategyRouteCalibration'

type CanonicalHead = { signal_date: string; run_id: string }
type LegacyRouteRow = {
  signal_date: string
  symbol: string
  producer_run_id: string
  route_version: string
  route_score: number
}

export type StrategyLearningCutoverContinuityReport = {
  schema_version: 'strategy-learning-cutover-continuity-repair-v1'
  dry_run: boolean
  start_date: string
  as_of_date: string
  canonical_dates: number
  legacy_route_rows: number
  target_route_rows_before: number
  target_route_rows_after: number
  route_rows_repaired: number
  daily_stats_dates_reconciled: number
  head_rows_refreshed: number
  route_calibration: null | {
    run_id: string
    status: string
    sample_count: number
    date_count: number
  }
  promotion_allowed: false
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

async function loadCanonicalHeads(
  legacyDb: D1Database,
  startDate: string,
  asOfDate: string,
): Promise<CanonicalHead[]> {
  const result = await legacyDb.prepare(`
    SELECT substr(logical_run_key, 10, 10) signal_date, run_id
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) BETWEEN ? AND ?
     ORDER BY signal_date
  `).bind(startDate, asOfDate).all<CanonicalHead>()
  return (result.results ?? []).filter((row) => validDate(row.signal_date) && Boolean(row.run_id))
}

async function loadLegacyRouteRows(
  legacyDb: D1Database,
  startDate: string,
  asOfDate: string,
  canonicalRunIds: Record<string, string>,
): Promise<LegacyRouteRow[]> {
  const rows: LegacyRouteRow[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  let cursorRunId = ''
  for (;;) {
    const page = await legacyDb.prepare(`
      SELECT r.signal_date, r.symbol, r.producer_run_id,
             r.strategy_challenger_route_version route_version,
             r.strategy_challenger_route_score route_score
        FROM selection_reference_snapshots_v1 r
       WHERE r.signal_date BETWEEN ? AND ?
         AND r.strategy_challenger_route_version=?
         AND r.strategy_challenger_route_score IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM json_each(?) h
            WHERE h.key=r.signal_date AND h.value=r.producer_run_id
         )
         AND (
           r.signal_date > ?
           OR (r.signal_date=? AND r.symbol>?)
           OR (r.signal_date=? AND r.symbol=? AND r.producer_run_id>?)
         )
       ORDER BY r.signal_date, r.symbol, r.producer_run_id
       LIMIT 400
    `).bind(
      startDate, asOfDate, STRATEGY_ROUTE_CHALLENGER_VERSION,
      JSON.stringify(canonicalRunIds),
      cursorDate, cursorDate, cursorSymbol,
      cursorDate, cursorSymbol, cursorRunId,
    ).all<LegacyRouteRow>()
    const pageRows = page.results ?? []
    rows.push(...pageRows)
    if (pageRows.length < 400) break
    const last = pageRows.at(-1)!
    cursorDate = last.signal_date
    cursorSymbol = last.symbol
    cursorRunId = last.producer_run_id
  }
  return rows
}

async function countTargetRouteRows(
  learningDb: D1Database,
  startDate: string,
  asOfDate: string,
  canonicalRunIds: Record<string, string>,
): Promise<number> {
  const row = await learningDb.prepare(`
    SELECT COUNT(*) row_count
      FROM selection_reference_snapshots_v1 r
     WHERE r.signal_date BETWEEN ? AND ?
       AND r.strategy_challenger_route_version=?
       AND r.strategy_challenger_route_score IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM json_each(?) h
          WHERE h.key=r.signal_date AND h.value=r.producer_run_id
       )
  `).bind(
    startDate, asOfDate, STRATEGY_ROUTE_CHALLENGER_VERSION,
    JSON.stringify(canonicalRunIds),
  ).first<{ row_count: number | string }>()
  return Number(row?.row_count ?? 0)
}

export async function repairStrategyLearningCutoverContinuity(
  env: Bindings,
  input: { startDate: string; asOfDate: string; dryRun: boolean },
): Promise<StrategyLearningCutoverContinuityReport> {
  if (!validDate(input.startDate) || !validDate(input.asOfDate) || input.startDate > input.asOfDate) {
    throw new Error('strategy_learning_cutover_continuity_invalid_date_range')
  }
  if (!activeDataDomains(env).has('learning')) {
    throw new Error('strategy_learning_cutover_continuity_requires_active_learning_domain')
  }
  if (!env.LEARNING_DB) throw new Error('strategy_learning_cutover_continuity_learning_binding_missing')
  if (!env.OPS_DB) throw new Error('strategy_learning_cutover_continuity_ops_binding_missing')

  const legacyDb = env.DB
  const learningDb = env.LEARNING_DB
  const heads = await loadCanonicalHeads(env.OPS_DB, input.startDate, input.asOfDate)
  const canonicalRunIds = Object.fromEntries(heads.map((row) => [row.signal_date, row.run_id]))
  const legacyRouteRows = await loadLegacyRouteRows(
    legacyDb, input.startDate, input.asOfDate, canonicalRunIds,
  )
  const targetBefore = await countTargetRouteRows(
    learningDb, input.startDate, input.asOfDate, canonicalRunIds,
  )
  if (input.dryRun) {
    return {
      schema_version: 'strategy-learning-cutover-continuity-repair-v1',
      dry_run: true,
      start_date: input.startDate,
      as_of_date: input.asOfDate,
      canonical_dates: heads.length,
      legacy_route_rows: legacyRouteRows.length,
      target_route_rows_before: targetBefore,
      target_route_rows_after: targetBefore,
      route_rows_repaired: 0,
      daily_stats_dates_reconciled: 0,
      head_rows_refreshed: 0,
      route_calibration: null,
      promotion_allowed: false,
    }
  }

  let repaired = 0
  for (let offset = 0; offset < legacyRouteRows.length; offset += 100) {
    const results = await learningDb.batch(legacyRouteRows.slice(offset, offset + 100).map((row) => learningDb.prepare(`
      UPDATE selection_reference_snapshots_v1
         SET strategy_challenger_route_version=?,
             strategy_challenger_route_score=?
       WHERE signal_date=? AND symbol=? AND producer_run_id=?
         AND (strategy_challenger_route_version IS NULL OR strategy_challenger_route_score IS NULL)
    `).bind(
      row.route_version, row.route_score,
      row.signal_date, row.symbol, row.producer_run_id,
    )))
    repaired += results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0)
  }

  await ensureStrategyLearningTables(learningDb)
  let reconciledDates = 0
  for (const head of heads) {
    await materializeStrategyDecisionDailyStats(learningDb, head.signal_date, {
      canonicalProducerRunId: head.run_id,
      skipEnsure: true,
    })
    reconciledDates += 1
  }
  const headRows = await refreshStrategyLearningHeads(learningDb)
  const routeCalibration = await refreshStrategyRouteCalibration(learningDb, input.asOfDate, {
    allowPromotion: false,
    canonicalRunIds,
  })
  const targetAfter = await countTargetRouteRows(
    learningDb, input.startDate, input.asOfDate, canonicalRunIds,
  )
  if (targetAfter < targetBefore || targetAfter < legacyRouteRows.length) {
    throw new Error(`strategy_learning_cutover_continuity_route_readback_failed:${targetBefore}/${targetAfter}/${legacyRouteRows.length}`)
  }

  return {
    schema_version: 'strategy-learning-cutover-continuity-repair-v1',
    dry_run: false,
    start_date: input.startDate,
    as_of_date: input.asOfDate,
    canonical_dates: heads.length,
    legacy_route_rows: legacyRouteRows.length,
    target_route_rows_before: targetBefore,
    target_route_rows_after: targetAfter,
    route_rows_repaired: repaired,
    daily_stats_dates_reconciled: reconciledDates,
    head_rows_refreshed: headRows,
    route_calibration: {
      run_id: routeCalibration.runId,
      status: routeCalibration.status,
      sample_count: routeCalibration.result.sampleCount,
      date_count: routeCalibration.result.dateCount,
    },
    promotion_allowed: false,
  }
}