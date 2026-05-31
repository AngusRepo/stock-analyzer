export const HOLDING_EXIT_OUTCOME_ANALYTICS_SCHEMA_VERSION = 'paper-holding-exit-outcome-analytics-v1' as const

export interface HoldingExitOutcomeEventRow {
  trade_date?: string | null
  symbol?: string | null
  event_type?: string | null
  status?: string | null
  reason?: string | null
  order_id?: number | null
  detail_json?: string | null
  created_at?: string | null
}

export interface ParsedHoldingExitSkippedOutcome {
  tradeDate: string
  symbol: string
  skipReason: string
  exitReason: string
  exitSource: string
  entryDate: string | null
  reviewCreatedAt: string | null
  orderId: number | null
  createdAt: string | null
}

export interface ParsedHoldingExitOutcome {
  tradeDate: string
  symbol: string
  finalAction: string
  activeDecisionSource: string
  learningEligible: boolean
  baselineAction: string
  reward: number
  rewardBasis: 'absolute_return' | 'counterfactual_delta' | 'unknown'
  counterfactualRewardScore: number | null
  realizedReturnPct: number
  baselineReturnPct: number | null
  baselineExitPrice: number | null
  activeVsBaselineReturnDeltaPct: number | null
  activeVsBaselineReturnDeltaAmount: number | null
  exitShareRatio: number | null
  learningImpactWeight: number | null
  featureQualityCoverage: number | null
  flowEvidenceCoverage: number | null
  missingFeatureGroups: string[]
  profitRetention: number
  regime: string
  exitSource: string
  orderId: number | null
  createdAt: string | null
}

export interface HoldingExitOutcomeSlice {
  count: number
  avgReward: number
  counterfactualRewardCount: number
  absoluteRewardCount: number
  unknownRewardCount: number
  avgCounterfactualRewardScore: number | null
  featureQualitySampleCount: number
  avgFeatureQualityCoverage: number | null
  avgFlowEvidenceCoverage: number | null
  lowQualityOutcomeCount: number
  learningEligibleCount: number
  learningSkippedCount: number
  avgExitShareRatio: number | null
  avgLearningImpactWeight: number | null
  avgRealizedReturnPct: number
  avgActiveVsBaselineReturnDeltaPct: number | null
  activeVsBaselineDeltaCount: number
  avgProfitRetention: number
  positiveRewardRate: number
}

export interface HoldingExitSkippedOutcomeSlice {
  count: number
}

export interface HoldingExitOutcomeAnalyticsReport {
  schemaVersion: typeof HOLDING_EXIT_OUTCOME_ANALYTICS_SCHEMA_VERSION
  days: number
  totalOutcomes: number
  skippedOutcomeCount: number
  changedActionCount: number
  unchangedActionCount: number
  summary: HoldingExitOutcomeSlice
  byAction: Record<string, HoldingExitOutcomeSlice>
  byBaselineAction: Record<string, HoldingExitOutcomeSlice>
  byRegime: Record<string, HoldingExitOutcomeSlice>
  byRewardBasis: Record<string, HoldingExitOutcomeSlice>
  byActiveDecisionSource: Record<string, HoldingExitOutcomeSlice>
  changedVsBaseline: {
    changed: HoldingExitOutcomeSlice
    unchanged: HoldingExitOutcomeSlice
  }
  bySkipReason: Record<string, HoldingExitSkippedOutcomeSlice>
  recent: ParsedHoldingExitOutcome[]
  recentSkipped: ParsedHoldingExitSkippedOutcome[]
}

interface BuildOptions {
  days?: number
  recentLimit?: number
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return {}
  }
}

function normalizeText(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : fallback
}

function normalizeRewardBasis(value: unknown): ParsedHoldingExitOutcome['rewardBasis'] {
  if (value === 'absolute_return' || value === 'counterfactual_delta') return value
  return 'unknown'
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
}

function orderIdFrom(row: HoldingExitOutcomeEventRow, detail: Record<string, unknown>): number | null {
  return finite(row.order_id) ?? finite(detail.order_id) ?? finite(detail.orderId)
}

function normalizeStatus(status: string | null | undefined): string {
  if (status == null) return ''
  return String(status).trim().toLowerCase()
}

function isRewardOutcomeStatus(status: string | null | undefined): boolean {
  const normalized = normalizeStatus(status)
  return normalized === '' || normalized === 'learned' || normalized === 'observed'
}

export function parseHoldingExitSkippedOutcomeEvent(row: HoldingExitOutcomeEventRow): ParsedHoldingExitSkippedOutcome | null {
  if (row.event_type != null && row.event_type !== 'holding_exit_outcome') return null
  if (normalizeStatus(row.status) !== 'skipped') return null
  const detail = safeParseJson(row.detail_json)
  const symbol = normalizeText(detail.symbol ?? row.symbol, '')
  if (!symbol) return null
  return {
    tradeDate: normalizeText(detail.tradeDate ?? detail.trade_date ?? row.trade_date, ''),
    symbol,
    skipReason: normalizeText(detail.skip_reason ?? row.reason, 'unknown'),
    exitReason: normalizeText(detail.exit_reason, 'unknown'),
    exitSource: normalizeText(detail.exit_source, 'unknown'),
    entryDate: normalizeText(detail.entry_date, '') || null,
    reviewCreatedAt: normalizeText(detail.review_created_at, '') || null,
    orderId: orderIdFrom(row, detail),
    createdAt: row.created_at ?? null,
  }
}

export function parseHoldingExitOutcomeEvent(row: HoldingExitOutcomeEventRow): ParsedHoldingExitOutcome | null {
  if (row.event_type != null && row.event_type !== 'holding_exit_outcome') return null
  if (normalizeStatus(row.status) === 'skipped') return null
  if (!isRewardOutcomeStatus(row.status)) return null
  const detail = safeParseJson(row.detail_json)
  const observation = asRecord(detail.observation)
  if (!Object.keys(observation).length) return null

  const symbol = normalizeText(observation.symbol ?? row.symbol, '')
  if (!symbol) return null
  const reward = finite(observation.reward)
  const rewardBasis = normalizeRewardBasis(observation.rewardBasis)
  const counterfactualRewardScore = finite(observation.counterfactualRewardScore)
  const realizedReturnPct = finite(observation.realizedReturnPct)
  const baselineReturnPct = finite(observation.baselineReturnPct)
  const baselineExitPrice = finite(observation.baselineExitPrice)
  const activeVsBaselineReturnDeltaPct = finite(observation.activeVsBaselineReturnDeltaPct)
  const activeVsBaselineReturnDeltaAmount = finite(observation.activeVsBaselineReturnDeltaAmount)
  const exitShareRatio = finite(observation.exitShareRatio) ?? 1
  const learningImpactWeight = finite(observation.learningImpactWeight) ?? exitShareRatio
  const featureQualityCoverage = finite(observation.featureQualityCoverage)
  const flowEvidenceCoverage = finite(observation.flowEvidenceCoverage)
  const profitRetention = finite(observation.profitRetention)
  if (reward == null || realizedReturnPct == null || profitRetention == null) return null

  return {
    tradeDate: normalizeText(observation.tradeDate ?? row.trade_date, ''),
    symbol,
    finalAction: normalizeText(observation.finalAction, 'unknown'),
    activeDecisionSource: normalizeText(observation.activeDecisionSource, 'unknown'),
    learningEligible: observation.learningEligible !== false,
    baselineAction: normalizeText(observation.baselineAction, 'unknown'),
    reward: round6(reward),
    rewardBasis,
    counterfactualRewardScore: counterfactualRewardScore == null ? null : round6(counterfactualRewardScore),
    realizedReturnPct: round6(realizedReturnPct),
    baselineReturnPct: baselineReturnPct == null ? null : round6(baselineReturnPct),
    baselineExitPrice: baselineExitPrice == null ? null : round6(baselineExitPrice),
    activeVsBaselineReturnDeltaPct: activeVsBaselineReturnDeltaPct == null ? null : round6(activeVsBaselineReturnDeltaPct),
    activeVsBaselineReturnDeltaAmount: activeVsBaselineReturnDeltaAmount == null ? null : round6(activeVsBaselineReturnDeltaAmount),
    exitShareRatio: round6(Math.max(0, Math.min(1, exitShareRatio))),
    learningImpactWeight: round6(Math.max(0, Math.min(1, learningImpactWeight))),
    featureQualityCoverage: featureQualityCoverage == null ? null : round6(featureQualityCoverage),
    flowEvidenceCoverage: flowEvidenceCoverage == null ? null : round6(flowEvidenceCoverage),
    missingFeatureGroups: normalizeStringList(observation.missingFeatureGroups),
    profitRetention: round6(profitRetention),
    regime: normalizeText(observation.regime, 'default'),
    exitSource: normalizeText(observation.exitSource, 'unknown'),
    orderId: orderIdFrom(row, observation),
    createdAt: row.created_at ?? null,
  }
}

function emptySlice(): HoldingExitOutcomeSlice {
  return {
    count: 0,
    avgReward: 0,
    counterfactualRewardCount: 0,
    absoluteRewardCount: 0,
    unknownRewardCount: 0,
    avgCounterfactualRewardScore: null,
    featureQualitySampleCount: 0,
    avgFeatureQualityCoverage: null,
    avgFlowEvidenceCoverage: null,
    lowQualityOutcomeCount: 0,
    learningEligibleCount: 0,
    learningSkippedCount: 0,
    avgExitShareRatio: null,
    avgLearningImpactWeight: null,
    avgRealizedReturnPct: 0,
    avgActiveVsBaselineReturnDeltaPct: null,
    activeVsBaselineDeltaCount: 0,
    avgProfitRetention: 0,
    positiveRewardRate: 0,
  }
}

function summarize(outcomes: ParsedHoldingExitOutcome[]): HoldingExitOutcomeSlice {
  if (!outcomes.length) return emptySlice()
  const count = outcomes.length
  const sum = outcomes.reduce((acc, row) => {
    acc.reward += row.reward
    if (row.rewardBasis === 'counterfactual_delta') acc.counterfactualRewardCount += 1
    else if (row.rewardBasis === 'absolute_return') acc.absoluteRewardCount += 1
    else acc.unknownRewardCount += 1
    if (row.counterfactualRewardScore != null) {
      acc.counterfactualRewardScore += row.counterfactualRewardScore
      acc.counterfactualRewardScoreCount += 1
    }
    if (row.featureQualityCoverage != null) {
      acc.featureQualityCoverage += row.featureQualityCoverage
      acc.featureQualitySampleCount += 1
      if (row.featureQualityCoverage < 0.67 || (row.flowEvidenceCoverage != null && row.flowEvidenceCoverage < 0.67)) {
        acc.lowQualityOutcomeCount += 1
      }
    }
    if (row.flowEvidenceCoverage != null) {
      acc.flowEvidenceCoverage += row.flowEvidenceCoverage
      acc.flowEvidenceSampleCount += 1
    }
    if (row.learningEligible) acc.learningEligibleCount += 1
    else acc.learningSkippedCount += 1
    if (row.exitShareRatio != null) {
      acc.exitShareRatio += row.exitShareRatio
      acc.exitShareRatioCount += 1
    }
    if (row.learningImpactWeight != null) {
      acc.learningImpactWeight += row.learningImpactWeight
      acc.learningImpactWeightCount += 1
    }
    acc.realized += row.realizedReturnPct
    if (row.activeVsBaselineReturnDeltaPct != null) {
      acc.activeDelta += row.activeVsBaselineReturnDeltaPct
      acc.activeDeltaCount += 1
    }
    acc.retention += row.profitRetention
    acc.positive += row.reward > 0 ? 1 : 0
    return acc
  }, {
    reward: 0,
    counterfactualRewardCount: 0,
    absoluteRewardCount: 0,
    unknownRewardCount: 0,
    counterfactualRewardScore: 0,
    counterfactualRewardScoreCount: 0,
    featureQualityCoverage: 0,
    featureQualitySampleCount: 0,
    flowEvidenceCoverage: 0,
    flowEvidenceSampleCount: 0,
    lowQualityOutcomeCount: 0,
    learningEligibleCount: 0,
    learningSkippedCount: 0,
    exitShareRatio: 0,
    exitShareRatioCount: 0,
    learningImpactWeight: 0,
    learningImpactWeightCount: 0,
    realized: 0,
    activeDelta: 0,
    activeDeltaCount: 0,
    retention: 0,
    positive: 0,
  })
  return {
    count,
    avgReward: round6(sum.reward / count),
    counterfactualRewardCount: sum.counterfactualRewardCount,
    absoluteRewardCount: sum.absoluteRewardCount,
    unknownRewardCount: sum.unknownRewardCount,
    avgCounterfactualRewardScore: sum.counterfactualRewardScoreCount > 0
      ? round6(sum.counterfactualRewardScore / sum.counterfactualRewardScoreCount)
      : null,
    featureQualitySampleCount: sum.featureQualitySampleCount,
    avgFeatureQualityCoverage: sum.featureQualitySampleCount > 0
      ? round6(sum.featureQualityCoverage / sum.featureQualitySampleCount)
      : null,
    avgFlowEvidenceCoverage: sum.flowEvidenceSampleCount > 0
      ? round6(sum.flowEvidenceCoverage / sum.flowEvidenceSampleCount)
      : null,
    lowQualityOutcomeCount: sum.lowQualityOutcomeCount,
    learningEligibleCount: sum.learningEligibleCount,
    learningSkippedCount: sum.learningSkippedCount,
    avgExitShareRatio: sum.exitShareRatioCount > 0
      ? round6(sum.exitShareRatio / sum.exitShareRatioCount)
      : null,
    avgLearningImpactWeight: sum.learningImpactWeightCount > 0
      ? round6(sum.learningImpactWeight / sum.learningImpactWeightCount)
      : null,
    avgRealizedReturnPct: round6(sum.realized / count),
    avgActiveVsBaselineReturnDeltaPct: sum.activeDeltaCount > 0
      ? round6(sum.activeDelta / sum.activeDeltaCount)
      : null,
    activeVsBaselineDeltaCount: sum.activeDeltaCount,
    avgProfitRetention: round6(sum.retention / count),
    positiveRewardRate: round6(sum.positive / count),
  }
}

function groupBy(
  outcomes: ParsedHoldingExitOutcome[],
  keyFn: (outcome: ParsedHoldingExitOutcome) => string,
): Record<string, HoldingExitOutcomeSlice> {
  const buckets = new Map<string, ParsedHoldingExitOutcome[]>()
  for (const outcome of outcomes) {
    const key = keyFn(outcome)
    const bucket = buckets.get(key) ?? []
    bucket.push(outcome)
    buckets.set(key, bucket)
  }
  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => [key, summarize(rows)]),
  )
}

function skippedGroupBy(
  rows: ParsedHoldingExitSkippedOutcome[],
  keyFn: (row: ParsedHoldingExitSkippedOutcome) => string,
): Record<string, HoldingExitSkippedOutcomeSlice> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = keyFn(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => [key, { count }]),
  )
}

function dedupeSkippedOutcomes(rows: ParsedHoldingExitSkippedOutcome[]): ParsedHoldingExitSkippedOutcome[] {
  const seen = new Set<string>()
  const out: ParsedHoldingExitSkippedOutcome[] = []
  for (const row of rows) {
    if (row.orderId == null) {
      out.push(row)
      continue
    }
    const key = `${row.orderId}:${row.skipReason}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function dedupeOutcomes(rows: ParsedHoldingExitOutcome[]): ParsedHoldingExitOutcome[] {
  const seen = new Set<number>()
  const out: ParsedHoldingExitOutcome[] = []
  for (const row of rows) {
    if (row.orderId == null) {
      out.push(row)
      continue
    }
    if (seen.has(row.orderId)) continue
    seen.add(row.orderId)
    out.push(row)
  }
  return out
}

export function buildHoldingExitOutcomeAnalytics(
  rows: HoldingExitOutcomeEventRow[],
  options: BuildOptions = {},
): HoldingExitOutcomeAnalyticsReport {
  const recentLimit = Math.max(1, Math.min(Math.round(options.recentLimit ?? 10), 50))
  const skipped = dedupeSkippedOutcomes(rows
    .map(parseHoldingExitSkippedOutcomeEvent)
    .filter((row): row is ParsedHoldingExitSkippedOutcome => row != null)
    .sort((a, b) => String(b.createdAt ?? b.tradeDate).localeCompare(String(a.createdAt ?? a.tradeDate))))
  const outcomes = dedupeOutcomes(rows
    .map(parseHoldingExitOutcomeEvent)
    .filter((row): row is ParsedHoldingExitOutcome => row != null)
    .sort((a, b) => String(b.createdAt ?? b.tradeDate).localeCompare(String(a.createdAt ?? a.tradeDate))))
  const changed = outcomes.filter((row) => row.finalAction !== row.baselineAction)
  const unchanged = outcomes.filter((row) => row.finalAction === row.baselineAction)

  return {
    schemaVersion: HOLDING_EXIT_OUTCOME_ANALYTICS_SCHEMA_VERSION,
    days: Math.max(1, Math.round(options.days ?? 60)),
    totalOutcomes: outcomes.length,
    skippedOutcomeCount: skipped.length,
    changedActionCount: changed.length,
    unchangedActionCount: unchanged.length,
    summary: summarize(outcomes),
    byAction: groupBy(outcomes, (row) => row.finalAction),
    byBaselineAction: groupBy(outcomes, (row) => row.baselineAction),
    byRegime: groupBy(outcomes, (row) => row.regime),
    byRewardBasis: groupBy(outcomes, (row) => row.rewardBasis),
    byActiveDecisionSource: groupBy(outcomes, (row) => row.activeDecisionSource),
    changedVsBaseline: {
      changed: summarize(changed),
      unchanged: summarize(unchanged),
    },
    bySkipReason: skippedGroupBy(skipped, (row) => row.skipReason),
    recent: outcomes.slice(0, recentLimit),
    recentSkipped: skipped.slice(0, recentLimit),
  }
}

export async function loadHoldingExitOutcomeAnalytics(
  db: D1Database,
  options: { accountId?: number; days?: number; limit?: number } = {},
): Promise<HoldingExitOutcomeAnalyticsReport> {
  const accountId = options.accountId ?? 1
  const days = Math.max(1, Math.min(Math.round(options.days ?? 60), 365))
  const limit = Math.max(1, Math.min(Math.round(options.limit ?? 500), 2000))
  const sinceModifier = `-${days} days`
  const { results } = await db.prepare(`
    SELECT trade_date, symbol, event_type, status, reason, order_id, detail_json, created_at
      FROM paper_execution_events
     WHERE account_id=?
       AND event_type='holding_exit_outcome'
       AND created_at >= datetime('now', ?)
     ORDER BY datetime(created_at) DESC
     LIMIT ?
  `).bind(accountId, sinceModifier, limit).all<HoldingExitOutcomeEventRow>().catch(() => ({ results: [] as HoldingExitOutcomeEventRow[] }))

  return buildHoldingExitOutcomeAnalytics(results ?? [], { days })
}
