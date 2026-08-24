import type { Bindings } from '../types'
import { activeDataDomains } from './dataDomainRegistry'
import {
  ensureStrategyLearningTables,
  materializeStrategyDecisionDailyStats,
  refreshStrategyLearningHeads,
} from './strategyLearning'
import {
  refreshStrategyRouteCalibration,
} from './strategyRouteCalibration'

const LEGACY_STRATEGY_ROUTE_VERSION = 'strategy-threshold-margin-affinity-v2'

type CanonicalHead = { signal_date: string; run_id: string }
type LegacyRouteRow = {
  signal_date: string
  symbol: string
  producer_run_id: string
  incumbent_route_version: string
  incumbent_route_score: number
  challenger_route_version: string
  challenger_route_score: number
}

type TargetRouteRow = {
  signal_date: string
  symbol: string
  producer_run_id: string
  incumbent_route_version: string | null
  incumbent_route_score: number | null
  challenger_route_version: string | null
  challenger_route_score: number | null
}

type RouteCoverage = {
  referenceRows: number
  incumbentRows: number
  challengerRows: number
}

export type StrategyLearningCutoverContinuityReport = {
  schema_version: 'strategy-learning-cutover-continuity-repair-v1'
  dry_run: boolean
  start_date: string
  as_of_date: string
  canonical_dates: number
  legacy_route_rows: number
  legacy_paired_route_rows: number
  target_route_rows_before: number
  target_route_rows_after: number
  target_incumbent_rows_before: number
  target_incumbent_rows_after: number
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
             r.strategy_router_version incumbent_route_version,
             r.strategy_router_score incumbent_route_score,
             r.strategy_challenger_route_version challenger_route_version,
             r.strategy_challenger_route_score challenger_route_score
        FROM selection_reference_snapshots_v1 r
       WHERE r.signal_date BETWEEN ? AND ?
         AND r.strategy_router_version IS NOT NULL
         AND r.strategy_router_score IS NOT NULL
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
      startDate, asOfDate, LEGACY_STRATEGY_ROUTE_VERSION,
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

async function loadTargetRouteRows(
  learningDb: D1Database,
  startDate: string,
  asOfDate: string,
  canonicalRunIds: Record<string, string>,
): Promise<TargetRouteRow[]> {
  const rows: TargetRouteRow[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  let cursorRunId = ''
  for (;;) {
    const page = await learningDb.prepare(`
      SELECT r.signal_date, r.symbol, r.producer_run_id,
             r.strategy_router_version incumbent_route_version,
             r.strategy_router_score incumbent_route_score,
             r.strategy_challenger_route_version challenger_route_version,
             r.strategy_challenger_route_score challenger_route_score
        FROM selection_reference_snapshots_v1 r
       WHERE r.signal_date BETWEEN ? AND ?
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
      startDate, asOfDate, JSON.stringify(canonicalRunIds),
      cursorDate, cursorDate, cursorSymbol,
      cursorDate, cursorSymbol, cursorRunId,
    ).all<TargetRouteRow>()
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

function routeKey(row: Pick<TargetRouteRow, 'signal_date' | 'symbol' | 'producer_run_id'>): string {
  return `${row.signal_date}\u0000${row.symbol}\u0000${row.producer_run_id}`
}

function sameScore(left: number | null, right: number): boolean {
  return left != null && Number.isFinite(Number(left)) && Number(left) === Number(right)
}

function assertLegacyTargetParity(
  legacyRows: LegacyRouteRow[],
  targetRows: TargetRouteRow[],
  requireComplete: boolean,
): void {
  const targetByKey = new Map(targetRows.map((row) => [routeKey(row), row]))
  for (const source of legacyRows) {
    const target = targetByKey.get(routeKey(source))
    if (!target) throw new Error(`strategy_learning_cutover_continuity_target_key_missing:${source.signal_date}/${source.symbol}`)
    const incumbentConflict = target.incumbent_route_version != null
      && target.incumbent_route_version !== source.incumbent_route_version
      || target.incumbent_route_score != null
      && !sameScore(target.incumbent_route_score, source.incumbent_route_score)
    const challengerConflict = target.challenger_route_version != null
      && target.challenger_route_version !== source.challenger_route_version
      || target.challenger_route_score != null
      && !sameScore(target.challenger_route_score, source.challenger_route_score)
    if (incumbentConflict || challengerConflict) {
      throw new Error(`strategy_learning_cutover_continuity_route_conflict:${source.signal_date}/${source.symbol}`)
    }
    if (requireComplete && (
      target.incumbent_route_version !== source.incumbent_route_version
      || !sameScore(target.incumbent_route_score, source.incumbent_route_score)
      || target.challenger_route_version !== source.challenger_route_version
      || !sameScore(target.challenger_route_score, source.challenger_route_score)
    )) {
      throw new Error(`strategy_learning_cutover_continuity_route_parity_failed:${source.signal_date}/${source.symbol}`)
    }
  }
}

function inspectTargetRouteCoverage(rows: TargetRouteRow[]): RouteCoverage {
  return {
    referenceRows: rows.length,
    incumbentRows: rows.filter((row) => row.incumbent_route_version != null && row.incumbent_route_score != null).length,
    challengerRows: rows.filter((row) => (
      row.challenger_route_version === LEGACY_STRATEGY_ROUTE_VERSION
      && row.challenger_route_score != null
    )).length,
  }
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
  const targetRowsBefore = await loadTargetRouteRows(
    learningDb, input.startDate, input.asOfDate, canonicalRunIds,
  )
  assertLegacyTargetParity(legacyRouteRows, targetRowsBefore, false)
  const targetBefore = inspectTargetRouteCoverage(targetRowsBefore)
  if (input.dryRun) {
    return {
      schema_version: 'strategy-learning-cutover-continuity-repair-v1',
      dry_run: true,
      start_date: input.startDate,
      as_of_date: input.asOfDate,
      canonical_dates: heads.length,
      legacy_route_rows: legacyRouteRows.length,
      legacy_paired_route_rows: legacyRouteRows.length,
      target_route_rows_before: targetBefore.challengerRows,
      target_route_rows_after: targetBefore.challengerRows,
      target_incumbent_rows_before: targetBefore.incumbentRows,
      target_incumbent_rows_after: targetBefore.incumbentRows,
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
         SET strategy_router_version=COALESCE(strategy_router_version, ?),
             strategy_router_score=COALESCE(strategy_router_score, ?),
             strategy_challenger_route_version=COALESCE(strategy_challenger_route_version, ?),
             strategy_challenger_route_score=COALESCE(strategy_challenger_route_score, ?)
       WHERE signal_date=? AND symbol=? AND producer_run_id=?
         AND (
           strategy_router_version IS NULL OR strategy_router_score IS NULL
           OR strategy_challenger_route_version IS NULL OR strategy_challenger_route_score IS NULL
         )
    `).bind(
      row.incumbent_route_version, row.incumbent_route_score,
      row.challenger_route_version, row.challenger_route_score,
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
  const targetRowsAfter = await loadTargetRouteRows(
    learningDb, input.startDate, input.asOfDate, canonicalRunIds,
  )
  assertLegacyTargetParity(legacyRouteRows, targetRowsAfter, true)
  const targetAfter = inspectTargetRouteCoverage(targetRowsAfter)
  if (
    targetAfter.incumbentRows < targetBefore.incumbentRows
    || targetAfter.challengerRows < targetBefore.challengerRows
    || targetAfter.incumbentRows < legacyRouteRows.length
    || targetAfter.challengerRows < legacyRouteRows.length
  ) {
    throw new Error(
      `strategy_learning_cutover_continuity_route_readback_failed:`
      + `${targetBefore.incumbentRows}/${targetAfter.incumbentRows}/`
      + `${targetBefore.challengerRows}/${targetAfter.challengerRows}/${legacyRouteRows.length}`,
    )
  }

  return {
    schema_version: 'strategy-learning-cutover-continuity-repair-v1',
    dry_run: false,
    start_date: input.startDate,
    as_of_date: input.asOfDate,
    canonical_dates: heads.length,
    legacy_route_rows: legacyRouteRows.length,
    legacy_paired_route_rows: legacyRouteRows.length,
    target_route_rows_before: targetBefore.challengerRows,
    target_route_rows_after: targetAfter.challengerRows,
    target_incumbent_rows_before: targetBefore.incumbentRows,
    target_incumbent_rows_after: targetAfter.incumbentRows,
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