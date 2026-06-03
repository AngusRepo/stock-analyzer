import {
  buildEntryPriceModelV2FromOhlcvPlan,
  type EntryPriceModelV2,
} from './entryPriceModelV2'
import {
  buildOhlcvTradePlanLevels,
  normalizeOhlcvRows,
  resolveOhlcvEntryPlan,
  type OhlcvRow,
} from './ohlcvTradePlanLevels'
import { buildPriceActionStructure } from './priceActionStructure'

export interface EntryModelReplayPricePath {
  open: number
  high: number
  low: number
  close: number
  next1Close?: number | null
  next5Close?: number | null
  next20Close?: number | null
}

export interface LegacyEntryPlanReplayInput {
  entryPrice: number
  optimisticHigh?: number | null
  stopLoss?: number | null
  source?: 'alpha_context_proxy' | 'recommendation_current_price' | 'pending_buy_item' | 'unknown'
}

export interface EntryModelReplayCase {
  runDate: string
  tradeDate?: string | null
  symbol: string
  oldModel: LegacyEntryPlanReplayInput
  newModel: EntryPriceModelV2
  pricePath: EntryModelReplayPricePath
  metadata?: Record<string, unknown>
}

export interface EntryModelReplayDecision {
  wouldBuy: boolean
  skipped: boolean
  reason: string
  fillPrice: number | null
  ret1: number | null
  ret5: number | null
  ret20: number | null
  mae: number | null
  mfe: number | null
  stopHit: boolean
}

export interface EntryModelReplayCaseResult {
  runDate: string
  symbol: string
  oldDecision: EntryModelReplayDecision
  newDecision: EntryModelReplayDecision
  changed: boolean
}

export interface EntryModelReplaySummary {
  cases: number
  oldFillRate: number
  newFillRate: number
  fillRateDelta: number
  oldAvgRet5: number | null
  newAvgRet5: number | null
  oldAvgMae: number | null
  newAvgMae: number | null
  oldStopHitRate: number
  newStopHitRate: number
  noFillFalseNegativeDelta: number
}

export interface EntryModelReplayPromotionGate {
  decision: 'promote_candidate' | 'observe_only' | 'insufficient_data'
  passed: boolean
  failedGates: string[]
  thresholds: {
    minCases: number
    minFillRateDelta: number
    minNoFillFalseNegativeDelta: number
    maxMaeDeterioration: number
    maxStopHitRateDelta: number
  }
}

export interface EntryModelReplayReport {
  version: 'entry_model_replay_report_v1'
  options: EntryModelReplayLoadOptions
  loadedCases: number
  skipped: Record<string, number>
  summary: EntryModelReplaySummary
  promotionGate: EntryModelReplayPromotionGate
  results: EntryModelReplayCaseResult[]
}

export interface EntryModelReplayLoadOptions {
  startDate: string
  endDate: string
  limit?: number
  symbols?: string[]
  minRank?: number
  maxRank?: number
}

interface RecommendationReplayRow {
  date: string
  symbol: string
  name?: string | null
  rank?: number | string | null
  current_price?: number | string | null
  alpha_context?: string | null
  stock_id?: number | string | null
}

interface PriceReplayRow {
  stock_id: number | string
  date: string
  open?: number | string | null
  high?: number | string | null
  low?: number | string | null
  close?: number | string | null
  volume?: number | string | null
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function roundMetric(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function avg(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => Number.isFinite(Number(value)))
  if (!clean.length) return null
  return roundMetric(clean.reduce((sum, value) => sum + value, 0) / clean.length)
}

function dateOffsetExpression(date: string, days: number): string {
  const direction = days >= 0 ? '+' : ''
  return `date('${date.replace(/'/g, "''")}', '${direction}${days} days')`
}

function oldModelFromRecommendation(row: RecommendationReplayRow): LegacyEntryPlanReplayInput | null {
  const alpha = parseJsonRecord(row.alpha_context)
  const riskOverlay = parseJsonRecord(alpha?.risk_overlay)
  const structure = parseJsonRecord(riskOverlay?.structure_detail)
  const fairHigh = finitePositive(structure?.fair_value_high)
  const fairLow = finitePositive(structure?.fair_value_low)
  const optimisticHigh = finitePositive(structure?.optimistic_value_high)
  const optimisticLow = finitePositive(structure?.optimistic_value_low)
  const current = finitePositive(row.current_price)
  const entry = fairHigh ?? optimisticLow ?? current
  if (entry == null) return null
  return {
    entryPrice: entry,
    optimisticHigh: optimisticHigh ?? fairHigh ?? entry,
    stopLoss: fairLow ?? null,
    source: fairHigh != null || optimisticHigh != null ? 'alpha_context_proxy' : 'recommendation_current_price',
  }
}

function priceRowToOhlcv(row: PriceReplayRow): OhlcvRow | null {
  const close = finitePositive(row.close)
  if (close == null) return null
  const open = finitePositive(row.open) ?? close
  const high = Math.max(finitePositive(row.high) ?? close, open, close)
  const low = Math.min(finitePositive(row.low) ?? close, open, close)
  return {
    date: cleanText(row.date),
    open,
    high,
    low,
    close,
    volume: Math.max(0, finiteNumber(row.volume) ?? 0),
  }
}

function pricePathFromFutureRows(rows: OhlcvRow[]): EntryModelReplayPricePath | null {
  const day0 = rows[0]
  if (!day0) return null
  return {
    open: day0.open,
    high: day0.high,
    low: day0.low,
    close: day0.close,
    next1Close: day0.close,
    next5Close: rows[4]?.close ?? null,
    next20Close: rows[19]?.close ?? null,
  }
}

function ret(fillPrice: number | null, close: number | null | undefined): number | null {
  const fill = finitePositive(fillPrice)
  const c = finitePositive(close)
  if (fill == null || c == null) return null
  return roundMetric((c - fill) / fill)
}

function replayDecisionFromBand(
  pricePath: EntryModelReplayPricePath,
  entryLow: number,
  entryHigh: number,
  chaseCeiling: number,
  stopLoss?: number | null,
): EntryModelReplayDecision {
  const open = finitePositive(pricePath.open)
  const high = finitePositive(pricePath.high)
  const low = finitePositive(pricePath.low)
  const close = finitePositive(pricePath.close)
  if (open == null || high == null || low == null || close == null) {
    return {
      wouldBuy: false,
      skipped: true,
      reason: 'invalid_price_path',
      fillPrice: null,
      ret1: null,
      ret5: null,
      ret20: null,
      mae: null,
      mfe: null,
      stopHit: false,
    }
  }
  if (open > chaseCeiling && low > entryHigh) {
    return {
      wouldBuy: false,
      skipped: true,
      reason: 'open_above_chase_ceiling_without_retest',
      fillPrice: null,
      ret1: null,
      ret5: null,
      ret20: null,
      mae: null,
      mfe: null,
      stopHit: false,
    }
  }
  if (high < entryLow || low > chaseCeiling) {
    return {
      wouldBuy: false,
      skipped: true,
      reason: high < entryLow ? 'never_reached_entry_band' : 'stayed_above_chase_ceiling',
      fillPrice: null,
      ret1: null,
      ret5: null,
      ret20: null,
      mae: null,
      mfe: null,
      stopHit: false,
    }
  }
  const fillPrice = roundMetric(Math.min(Math.max(open, entryLow), entryHigh), 4)
  const stop = finitePositive(stopLoss)
  return {
    wouldBuy: true,
    skipped: false,
    reason: 'filled_in_entry_band',
    fillPrice,
    ret1: ret(fillPrice, pricePath.next1Close ?? close),
    ret5: ret(fillPrice, pricePath.next5Close),
    ret20: ret(fillPrice, pricePath.next20Close),
    mae: roundMetric((low - fillPrice) / fillPrice),
    mfe: roundMetric((high - fillPrice) / fillPrice),
    stopHit: stop != null && low <= stop,
  }
}

export function replayEntryModelCase(input: EntryModelReplayCase): EntryModelReplayCaseResult {
  const oldEntry = finitePositive(input.oldModel.entryPrice)
  const oldCeiling = finitePositive(input.oldModel.optimisticHigh) ?? oldEntry
  const oldDecision = oldEntry == null || oldCeiling == null
    ? replayDecisionFromBand(input.pricePath, Number.NaN, Number.NaN, Number.NaN)
    : replayDecisionFromBand(input.pricePath, oldEntry, oldEntry, oldCeiling, input.oldModel.stopLoss)
  const newDecision = replayDecisionFromBand(
    input.pricePath,
    input.newModel.entryLow,
    input.newModel.entryHigh,
    input.newModel.chaseCeiling,
    input.newModel.stopAnchor,
  )
  return {
    runDate: input.runDate,
    symbol: input.symbol,
    oldDecision,
    newDecision,
    changed: oldDecision.reason !== newDecision.reason || oldDecision.wouldBuy !== newDecision.wouldBuy,
  }
}

export function summarizeEntryModelReplay(results: EntryModelReplayCaseResult[]): EntryModelReplaySummary {
  const cases = results.length
  const oldFilled = results.filter((row) => row.oldDecision.wouldBuy)
  const newFilled = results.filter((row) => row.newDecision.wouldBuy)
  const oldMissedWinners = results.filter((row) => !row.oldDecision.wouldBuy && row.newDecision.ret5 != null && row.newDecision.ret5 > 0).length
  const newMissedWinners = results.filter((row) => !row.newDecision.wouldBuy && row.oldDecision.ret5 != null && row.oldDecision.ret5 > 0).length
  return {
    cases,
    oldFillRate: cases ? roundMetric(oldFilled.length / cases) : 0,
    newFillRate: cases ? roundMetric(newFilled.length / cases) : 0,
    fillRateDelta: cases ? roundMetric((newFilled.length - oldFilled.length) / cases) : 0,
    oldAvgRet5: avg(oldFilled.map((row) => row.oldDecision.ret5)),
    newAvgRet5: avg(newFilled.map((row) => row.newDecision.ret5)),
    oldAvgMae: avg(oldFilled.map((row) => row.oldDecision.mae)),
    newAvgMae: avg(newFilled.map((row) => row.newDecision.mae)),
    oldStopHitRate: oldFilled.length ? roundMetric(oldFilled.filter((row) => row.oldDecision.stopHit).length / oldFilled.length) : 0,
    newStopHitRate: newFilled.length ? roundMetric(newFilled.filter((row) => row.newDecision.stopHit).length / newFilled.length) : 0,
    noFillFalseNegativeDelta: roundMetric((oldMissedWinners - newMissedWinners) / Math.max(1, cases)),
  }
}

export function evaluateEntryModelReplayPromotionGate(
  summary: EntryModelReplaySummary,
  thresholds: Partial<EntryModelReplayPromotionGate['thresholds']> = {},
): EntryModelReplayPromotionGate {
  const t = {
    minCases: thresholds.minCases ?? 30,
    minFillRateDelta: thresholds.minFillRateDelta ?? 0.1,
    minNoFillFalseNegativeDelta: thresholds.minNoFillFalseNegativeDelta ?? 0.02,
    maxMaeDeterioration: thresholds.maxMaeDeterioration ?? 0.005,
    maxStopHitRateDelta: thresholds.maxStopHitRateDelta ?? 0.02,
  }
  const failedGates: string[] = []
  if (summary.cases < t.minCases) failedGates.push('insufficient_cases')
  if (summary.fillRateDelta < t.minFillRateDelta) failedGates.push('fill_rate_delta_below_threshold')
  if (summary.noFillFalseNegativeDelta < t.minNoFillFalseNegativeDelta) failedGates.push('missed_winner_delta_below_threshold')
  const oldMae = summary.oldAvgMae ?? 0
  const newMae = summary.newAvgMae ?? 0
  if (newMae < oldMae - t.maxMaeDeterioration) failedGates.push('mae_deteriorated')
  if (summary.newStopHitRate > summary.oldStopHitRate + t.maxStopHitRateDelta) failedGates.push('stop_hit_rate_deteriorated')
  const passed = failedGates.length === 0
  return {
    decision: summary.cases < t.minCases ? 'insufficient_data' : passed ? 'promote_candidate' : 'observe_only',
    passed,
    failedGates,
    thresholds: t,
  }
}

export async function loadEntryModelReplayCasesFromD1(
  db: D1Database,
  options: EntryModelReplayLoadOptions,
): Promise<{ cases: EntryModelReplayCase[]; skipped: Record<string, number> }> {
  const startDate = cleanText(options.startDate)
  const endDate = cleanText(options.endDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('invalid_replay_date_range')
  }

  const requestedLimit = Number(options.limit ?? 250)
  const limit = Math.max(1, Math.min(2000, Number.isFinite(requestedLimit) ? Math.round(requestedLimit) : 250))
  const symbols = [...new Set((options.symbols ?? []).map((symbol) => cleanText(symbol)).filter(Boolean))]
  const minRank = finiteNumber(options.minRank)
  const maxRank = finiteNumber(options.maxRank)
  const where: string[] = [
    'dr.date >= ?',
    'dr.date <= ?',
    "COALESCE(dr.recommendation_lane, 'tradable') = 'tradable'",
    'COALESCE(dr.eligible_for_pending_buy, 1) = 1',
  ]
  const binds: unknown[] = [startDate, endDate]
  if (symbols.length > 0) {
    where.push(`dr.symbol IN (${symbols.map(() => '?').join(',')})`)
    binds.push(...symbols)
  }
  if (minRank != null) {
    where.push('dr.rank >= ?')
    binds.push(minRank)
  }
  if (maxRank != null) {
    where.push('dr.rank <= ?')
    binds.push(maxRank)
  }
  const { results: recRows } = await db.prepare(`
    SELECT dr.date, dr.symbol, dr.name, dr.rank, dr.current_price, dr.alpha_context, s.id AS stock_id
      FROM daily_recommendations dr
      LEFT JOIN stocks s ON s.symbol = dr.symbol
     WHERE ${where.join(' AND ')}
     ORDER BY dr.date ASC, dr.rank ASC
     LIMIT ?
  `).bind(...binds, limit).all<RecommendationReplayRow>()

  const recommendations = recRows ?? []
  const skipped: Record<string, number> = {}
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  const stockIds = [...new Set(recommendations.map((row) => Number(row.stock_id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (!stockIds.length) {
    return { cases: [], skipped: { missing_stock_id: recommendations.length } }
  }

  const { results: priceRows } = await db.prepare(`
    SELECT stock_id, date, open, high, low, close, volume
      FROM stock_prices
     WHERE stock_id IN (${stockIds.map(() => '?').join(',')})
       AND date >= ${dateOffsetExpression(startDate, -140)}
       AND date <= ${dateOffsetExpression(endDate, 30)}
       AND close IS NOT NULL
     ORDER BY stock_id ASC, date ASC
  `).bind(...stockIds).all<PriceReplayRow>()

  const pricesByStock = new Map<number, OhlcvRow[]>()
  for (const row of priceRows ?? []) {
    const stockId = Number(row.stock_id)
    if (!Number.isFinite(stockId)) continue
    const price = priceRowToOhlcv(row)
    if (!price) continue
    const list = pricesByStock.get(stockId) ?? []
    list.push(price)
    pricesByStock.set(stockId, list)
  }

  const cases: EntryModelReplayCase[] = []
  for (const rec of recommendations) {
    const stockId = Number(rec.stock_id)
    if (!Number.isFinite(stockId) || stockId <= 0) {
      skip('missing_stock_id')
      continue
    }
    const rows = pricesByStock.get(stockId) ?? []
    if (!rows.length) {
      skip('missing_price_rows')
      continue
    }
    const historicalRows = rows.filter((row) => row.date <= rec.date)
    const futureRows = rows.filter((row) => row.date > rec.date)
    const pricePath = pricePathFromFutureRows(futureRows)
    if (!pricePath) {
      skip('missing_future_price_path')
      continue
    }
    const oldModel = oldModelFromRecommendation(rec)
    if (!oldModel) {
      skip('missing_old_entry_model')
      continue
    }
    const levels = buildOhlcvTradePlanLevels(normalizeOhlcvRows(historicalRows), 80)
    const plan = resolveOhlcvEntryPlan(levels, { latestPrice: rec.current_price })
    if (!plan) {
      skip('missing_v2_ohlcv_plan')
      continue
    }
    cases.push({
      runDate: rec.date,
      tradeDate: futureRows[0].date,
      symbol: rec.symbol,
      oldModel,
      newModel: buildEntryPriceModelV2FromOhlcvPlan(plan, {
        priceActionStructure: buildPriceActionStructure(historicalRows, {
          latestPrice: finiteNumber(rec.current_price),
        }),
      }),
      pricePath,
      metadata: {
        name: rec.name ?? null,
        rank: finiteNumber(rec.rank),
        old_model_source: oldModel.source ?? 'unknown',
        new_model_source: 'entry_price_model_v2_daily_proxy_fallback_with_price_action_observe',
      },
    })
  }

  return { cases, skipped }
}

export async function buildEntryModelReplayReportFromD1(
  db: D1Database,
  options: EntryModelReplayLoadOptions,
): Promise<EntryModelReplayReport> {
  const loaded = await loadEntryModelReplayCasesFromD1(db, options)
  const results = loaded.cases.map(replayEntryModelCase)
  const summary = summarizeEntryModelReplay(results)
  return {
    version: 'entry_model_replay_report_v1',
    options,
    loadedCases: loaded.cases.length,
    skipped: loaded.skipped,
    summary,
    promotionGate: evaluateEntryModelReplayPromotionGate(summary),
    results,
  }
}
