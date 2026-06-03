export interface ScreenerLayerReplayOptions {
  startDate: string
  endDate: string
  limit?: number
  l2KeepRatio?: number
  l3KeepRatio?: number
}

export type ScreenerLayerReplaySource = 'strategy_hit' | 'raw_top_up_observe'
export type ScreenerLayerReplayScenarioId =
  | 'strategy_only'
  | 'strategy_plus_raw_top_up'

export interface ScreenerLayerReplayCandidate {
  runId: string
  date: string
  symbol: string
  name?: string | null
  source: ScreenerLayerReplaySource
  score: number
  rank: number
  ret1: number | null
  ret5: number | null
  ret20: number | null
}

export interface ScreenerLayerStageMetrics {
  stage: 'l1_input' | 'l2_keep' | 'l3_keep'
  count: number
  rawTopUpCount: number
  rawTopUpShare: number
  avgRet1: number | null
  avgRet5: number | null
  avgRet20: number | null
  hitRate5: number | null
  symbolsPreview: string[]
}

export interface ScreenerLayerScenarioMetrics {
  scenarioId: ScreenerLayerReplayScenarioId
  l2KeepRatio: number
  l3KeepRatio: number
  stages: ScreenerLayerStageMetrics[]
}

export interface ScreenerLayerReplaySummary {
  strategyOnlyL3Ret5: number | null
  strategyPlusTopUpL3Ret5: number | null
  ret5DeltaTopUpVsStrategyOnly: number | null
  strategyOnlyL3HitRate5: number | null
  strategyPlusTopUpL3HitRate5: number | null
  topUpDecision: 'keep_observe_only' | 'promote_for_replay_review' | 'insufficient_data'
}

export interface ScreenerLayerReplayReport {
  version: 'screener_layer_replay_v1'
  options: Required<Pick<ScreenerLayerReplayOptions, 'startDate' | 'endDate' | 'l2KeepRatio' | 'l3KeepRatio'>> & { limit: number }
  loadedCandidates: number
  skipped: Record<string, number>
  scenarios: ScreenerLayerScenarioMetrics[]
  summary: ScreenerLayerReplaySummary
  notes: string[]
}

interface FunnelCandidateRow {
  run_id: string
  date: string
  symbol: string
  name?: string | null
  decision: string
  reason_code?: string | null
  score_after?: number | string | null
  rank?: number | string | null
  evidence?: string | null
  stock_id?: number | string | null
}

interface PriceReplayRow {
  stock_id: number | string
  date: string
  open?: number | string | null
  close?: number | string | null
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function finitePositive(value: unknown): number | null {
  const n = finiteNumber(value)
  return n != null && n > 0 ? n : null
}

function roundMetric(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function clampRatio(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0.05, Math.min(1, n))
}

function avg(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (!clean.length) return null
  return roundMetric(clean.reduce((sum, value) => sum + value, 0) / clean.length)
}

function parseEvidence(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function classifyLayer1Source(row: FunnelCandidateRow): ScreenerLayerReplaySource {
  const evidence = parseEvidence(row.evidence)
  const fallback = cleanText(evidence.strategy_pool_fallback_source)
  const formalL2Queue = evidence.formal_l2_queue
  if (fallback === 'raw_signal_top_up' || row.decision === 'observe' || formalL2Queue === false) {
    return 'raw_top_up_observe'
  }
  return 'strategy_hit'
}

function dateOffsetExpression(date: string, days: number): string {
  const direction = days >= 0 ? '+' : ''
  return `date('${date.replace(/'/g, "''")}', '${direction}${days} days')`
}

function priceRet(entry: number | null, close: number | null): number | null {
  if (entry == null || close == null) return null
  return roundMetric((close - entry) / entry)
}

function buildPriceReturns(rows: PriceReplayRow[], runDate: string): { ret1: number | null; ret5: number | null; ret20: number | null } | null {
  const future = rows
    .filter((row) => cleanText(row.date) > runDate)
    .sort((a, b) => cleanText(a.date).localeCompare(cleanText(b.date)))
  const day1 = future[0]
  if (!day1) return null
  const entry = finitePositive(day1.open) ?? finitePositive(day1.close)
  if (entry == null) return null
  return {
    ret1: priceRet(entry, finitePositive(day1.close)),
    ret5: priceRet(entry, finitePositive(future[4]?.close ?? future[future.length - 1]?.close)),
    ret20: priceRet(entry, finitePositive(future[19]?.close ?? future[future.length - 1]?.close)),
  }
}

function rankCandidates(candidates: ScreenerLayerReplayCandidate[]): ScreenerLayerReplayCandidate[] {
  return [...candidates].sort((a, b) => (
    a.date.localeCompare(b.date) ||
    a.rank - b.rank ||
    b.score - a.score ||
    a.symbol.localeCompare(b.symbol)
  ))
}

function keepByRatio(candidates: ScreenerLayerReplayCandidate[], ratio: number): ScreenerLayerReplayCandidate[] {
  if (!candidates.length) return []
  const byDate = new Map<string, ScreenerLayerReplayCandidate[]>()
  for (const candidate of candidates) {
    const bucket = byDate.get(candidate.date) ?? []
    bucket.push(candidate)
    byDate.set(candidate.date, bucket)
  }
  const out: ScreenerLayerReplayCandidate[] = []
  for (const bucket of byDate.values()) {
    const ranked = rankCandidates(bucket)
    out.push(...ranked.slice(0, Math.max(1, Math.ceil(ranked.length * ratio))))
  }
  return out
}

function stageMetrics(
  stage: ScreenerLayerStageMetrics['stage'],
  candidates: ScreenerLayerReplayCandidate[],
): ScreenerLayerStageMetrics {
  const rawTopUpCount = candidates.filter((candidate) => candidate.source === 'raw_top_up_observe').length
  const ret5Values = candidates.map((candidate) => candidate.ret5).filter((value): value is number => value != null)
  return {
    stage,
    count: candidates.length,
    rawTopUpCount,
    rawTopUpShare: candidates.length ? roundMetric(rawTopUpCount / candidates.length) : 0,
    avgRet1: avg(candidates.map((candidate) => candidate.ret1)),
    avgRet5: avg(candidates.map((candidate) => candidate.ret5)),
    avgRet20: avg(candidates.map((candidate) => candidate.ret20)),
    hitRate5: ret5Values.length ? roundMetric(ret5Values.filter((value) => value > 0).length / ret5Values.length) : null,
    symbolsPreview: rankCandidates(candidates).slice(0, 20).map((candidate) => candidate.symbol),
  }
}

function scenarioMetrics(
  scenarioId: ScreenerLayerReplayScenarioId,
  l1Input: ScreenerLayerReplayCandidate[],
  l2KeepRatio: number,
  l3KeepRatio: number,
): ScreenerLayerScenarioMetrics {
  const l2 = keepByRatio(l1Input, l2KeepRatio)
  const l3 = keepByRatio(l2, l3KeepRatio)
  return {
    scenarioId,
    l2KeepRatio,
    l3KeepRatio,
    stages: [
      stageMetrics('l1_input', l1Input),
      stageMetrics('l2_keep', l2),
      stageMetrics('l3_keep', l3),
    ],
  }
}

function l3(metrics: ScreenerLayerScenarioMetrics): ScreenerLayerStageMetrics {
  return metrics.stages.find((stage) => stage.stage === 'l3_keep') ?? metrics.stages[metrics.stages.length - 1]
}

function buildSummary(scenarios: ScreenerLayerScenarioMetrics[]): ScreenerLayerReplaySummary {
  const strategyOnly = scenarios.find((scenario) => scenario.scenarioId === 'strategy_only')
  const plusTopUp = scenarios.find((scenario) => scenario.scenarioId === 'strategy_plus_raw_top_up')
  const strategyOnlyL3 = strategyOnly ? l3(strategyOnly) : null
  const plusTopUpL3 = plusTopUp ? l3(plusTopUp) : null
  const ret5Delta = strategyOnlyL3?.avgRet5 != null && plusTopUpL3?.avgRet5 != null
    ? roundMetric(plusTopUpL3.avgRet5 - strategyOnlyL3.avgRet5)
    : null
  const enoughData = (strategyOnlyL3?.count ?? 0) >= 20 && (plusTopUpL3?.count ?? 0) >= 20
  return {
    strategyOnlyL3Ret5: strategyOnlyL3?.avgRet5 ?? null,
    strategyPlusTopUpL3Ret5: plusTopUpL3?.avgRet5 ?? null,
    ret5DeltaTopUpVsStrategyOnly: ret5Delta,
    strategyOnlyL3HitRate5: strategyOnlyL3?.hitRate5 ?? null,
    strategyPlusTopUpL3HitRate5: plusTopUpL3?.hitRate5 ?? null,
    topUpDecision: !enoughData
      ? 'insufficient_data'
      : ret5Delta != null && ret5Delta > 0.003
        ? 'promote_for_replay_review'
        : 'keep_observe_only',
  }
}

export function buildScreenerLayerReplayReport(
  candidates: ScreenerLayerReplayCandidate[],
  options: ScreenerLayerReplayOptions,
  skipped: Record<string, number> = {},
): ScreenerLayerReplayReport {
  const l2KeepRatio = clampRatio(options.l2KeepRatio, 0.75)
  const l3KeepRatio = clampRatio(options.l3KeepRatio, 0.7)
  const strategyOnly = candidates.filter((candidate) => candidate.source === 'strategy_hit')
  const strategyPlusTopUp = candidates.filter((candidate) => candidate.source === 'strategy_hit' || candidate.source === 'raw_top_up_observe')
  const scenarios = [
    scenarioMetrics('strategy_only', strategyOnly, l2KeepRatio, l3KeepRatio),
    scenarioMetrics('strategy_plus_raw_top_up', strategyPlusTopUp, l2KeepRatio, l3KeepRatio),
  ]
  return {
    version: 'screener_layer_replay_v1',
    options: {
      startDate: options.startDate,
      endDate: options.endDate,
      limit: Math.max(1, Math.round(options.limit ?? (candidates.length || 1))),
      l2KeepRatio,
      l3KeepRatio,
    },
    loadedCandidates: candidates.length,
    skipped,
    scenarios,
    summary: buildSummary(scenarios),
    notes: [
      'strategy_only_excludes_raw_signal_top_up_observe',
      'strategy_plus_raw_top_up_is_replay_only_not_formal_l2_policy',
      'forward_returns_use_next_trading_day_open_as_entry_proxy',
    ],
  }
}

export async function loadScreenerLayerReplayCandidatesFromD1(
  db: D1Database,
  options: ScreenerLayerReplayOptions,
): Promise<{ candidates: ScreenerLayerReplayCandidate[]; skipped: Record<string, number> }> {
  const startDate = cleanText(options.startDate)
  const endDate = cleanText(options.endDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('invalid_screener_layer_replay_date_range')
  }
  const limit = Math.max(1, Math.min(5000, Math.round(Number(options.limit ?? 1000) || 1000)))
  const { results } = await db.prepare(`
    WITH latest_runs AS (
      SELECT r.run_id, r.date
        FROM screener_funnel_runs r
        JOIN (
          SELECT date, MAX(created_at) AS created_at
            FROM screener_funnel_runs
           WHERE date >= ? AND date <= ?
           GROUP BY date
        ) latest
          ON latest.date = r.date AND latest.created_at = r.created_at
    )
    SELECT i.run_id, i.date, i.symbol, i.name, i.decision, i.reason_code,
           i.score_after, i.rank, i.evidence, s.id AS stock_id
      FROM screener_funnel_items i
      JOIN latest_runs lr ON lr.run_id = i.run_id
      LEFT JOIN stocks s ON s.symbol = i.symbol
     WHERE i.stage = 'layer1_strategy_breadth_gate'
     ORDER BY i.date ASC, i.rank ASC, i.score_after DESC
     LIMIT ?
  `).bind(startDate, endDate, limit).all<FunnelCandidateRow>()

  const rows = results ?? []
  const skipped: Record<string, number> = {}
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  const stockIds = [...new Set(rows.map((row) => Number(row.stock_id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (!stockIds.length) {
    return { candidates: [], skipped: { missing_stock_id: rows.length } }
  }

  const { results: priceRows } = await db.prepare(`
    SELECT stock_id, date, open, close
      FROM stock_prices
     WHERE stock_id IN (${stockIds.map(() => '?').join(',')})
       AND date >= ?
       AND date <= ${dateOffsetExpression(endDate, 30)}
       AND close IS NOT NULL
     ORDER BY stock_id ASC, date ASC
  `).bind(...stockIds, startDate).all<PriceReplayRow>()

  const pricesByStock = new Map<number, PriceReplayRow[]>()
  for (const row of priceRows ?? []) {
    const stockId = Number(row.stock_id)
    if (!Number.isFinite(stockId)) continue
    const bucket = pricesByStock.get(stockId) ?? []
    bucket.push(row)
    pricesByStock.set(stockId, bucket)
  }

  const candidates: ScreenerLayerReplayCandidate[] = []
  for (const row of rows) {
    const stockId = Number(row.stock_id)
    if (!Number.isFinite(stockId) || stockId <= 0) {
      skip('missing_stock_id')
      continue
    }
    const returns = buildPriceReturns(pricesByStock.get(stockId) ?? [], row.date)
    if (!returns) {
      skip('missing_forward_price_path')
      continue
    }
    candidates.push({
      runId: row.run_id,
      date: row.date,
      symbol: cleanText(row.symbol),
      name: row.name ?? null,
      source: classifyLayer1Source(row),
      score: finiteNumber(row.score_after) ?? 0,
      rank: Math.max(1, Math.round(finiteNumber(row.rank) ?? candidates.length + 1)),
      ...returns,
    })
  }
  return { candidates, skipped }
}

export async function buildScreenerLayerReplayReportFromD1(
  db: D1Database,
  options: ScreenerLayerReplayOptions,
): Promise<ScreenerLayerReplayReport> {
  const loaded = await loadScreenerLayerReplayCandidatesFromD1(db, options)
  return buildScreenerLayerReplayReport(loaded.candidates, options, loaded.skipped)
}
