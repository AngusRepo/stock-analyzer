import {
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

export const STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION_V6 = 'strategy-marginal-edge-v6'
export const STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION = 'strategy-marginal-edge-v7'
const MIN_EDGE_DATES = 10
const REPLACEMENT_MDD_TOLERANCE = 0.02
const REPLACEMENT_TURNOVER_TOLERANCE = 0.15
const REPLACEMENT_DUPLICATE_CORRELATION = 0.95
const EDGE_LOOKBACK_CALENDAR_DAYS = 540
const EDGE_PAGE_SIZE = 1000
const T_PLUS_OUTCOME_HORIZON_TRADING_DAYS = 5
const REPLACEMENT_HAC_LAG = T_PLUS_OUTCOME_HORIZON_TRADING_DAYS - 1
const MIN_EFFECTIVE_PAIRED_DATES = 30
const MINIMUM_ECONOMIC_PAIRED_DELTA = 0.001
const MIN_REPLACEMENT_POWER = 0.8
const REPLACEMENT_FAMILYWISE_ALPHA = 0.05
const ONE_SIDED_95_Z = 1.6448536269514722
export const STRATEGY_REPLACEMENT_POLICY_VERSION_V7 = 'strategy-replacement-policy-v7-hac4-holm-power80-v1'

export const STRATEGY_REPLACEMENT_POLICY_V6 = Object.freeze({
  schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION_V6,
  min_paired_dates: MIN_EDGE_DATES,
  min_paired_delta_lcb90_exclusive: 0,
  min_candidate_absolute_cost_net_mean_exclusive: 0,
  max_drawdown_degradation: REPLACEMENT_MDD_TOLERANCE,
  max_turnover_increase: REPLACEMENT_TURNOVER_TOLERANCE,
  max_duplicate_return_correlation: REPLACEMENT_DUPLICATE_CORRELATION,
  requires_full_portfolio_gates: true,
  replacement_mode: 'atomic_one_in_one_out' as const,
  outcome: 'sector_or_market_neutral_cost_net_return' as const,
})

export const STRATEGY_REPLACEMENT_POLICY_V7 = Object.freeze({
  schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
  policy_version: STRATEGY_REPLACEMENT_POLICY_VERSION_V7,
  outcome_horizon_trading_days: T_PLUS_OUTCOME_HORIZON_TRADING_DAYS,
  dependence_adjustment: 'newey_west_bartlett' as const,
  hac_lag: REPLACEMENT_HAC_LAG,
  min_paired_dates: MIN_EDGE_DATES,
  min_effective_paired_dates: MIN_EFFECTIVE_PAIRED_DATES,
  min_paired_delta_lcb95_hac_exclusive: 0,
  minimum_economic_paired_delta: MINIMUM_ECONOMIC_PAIRED_DELTA,
  min_power_at_minimum_economic_delta: MIN_REPLACEMENT_POWER,
  multiple_testing: 'holm_bonferroni' as const,
  familywise_alpha: REPLACEMENT_FAMILYWISE_ALPHA,
  min_candidate_absolute_cost_net_mean_exclusive: 0,
  min_candidate_absolute_cost_net_lcb95_hac_exclusive: 0,
  min_final_portfolio_absolute_cost_net_lcb95_hac_exclusive: 0,
  max_drawdown_degradation: REPLACEMENT_MDD_TOLERANCE,
  max_turnover_increase: REPLACEMENT_TURNOVER_TOLERANCE,
  max_duplicate_return_correlation: REPLACEMENT_DUPLICATE_CORRELATION,
  requires_full_portfolio_gates: true,
  replacement_mode: 'atomic_one_in_one_out' as const,
  outcome: 'sector_or_market_neutral_cost_net_return' as const,
})

// One-sided 90% lower confidence bound. Small date cohorts require Student-t,
// not a normal approximation that understates uncertainty.
function lcb90CriticalValue(sampleSize: number): number | null {
  if (sampleSize < 2) return null
  const byDf = [
    0, 3.077684, 1.885618, 1.637744, 1.533206, 1.475884,
    1.439756, 1.414924, 1.396815, 1.383029, 1.372184,
    1.363430, 1.356217, 1.350171, 1.345030, 1.340606,
    1.336757, 1.333379, 1.330391, 1.327728, 1.325341,
    1.323188, 1.321237, 1.319460, 1.317836, 1.316345,
    1.314972, 1.313703, 1.312527, 1.311434, 1.310415,
  ]
  const df = sampleSize - 1
  return df < byDf.length ? byDf[df] : 1.281552
}

export interface OutcomeCell {
  signal_date: string
  symbol: string
  strategy_id: string
  strategy_version: string
  family_id: string
  production_owner: number | string
  strategy_hit: number | string
  absolute_return_net: number | string
  residual_return_net: number | string
}

export interface StrategyEdgeResult {
  strategyId: string
  strategyVersion: string
  observationDates: number
  candidateObservations: number
  marginalEdgeMean: number | null
  marginalEdgeLcb90: number | null
  positiveDateRate: number | null
  absoluteHitReturnMean: number | null
  productionEligible: boolean
  productionWeightRaw: number
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function sampleStandardDeviation(values: number[], average: number): number | null {
  if (values.length < 2) return null
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

export function evaluateStrategyMarginalEdgesV4(cells: OutcomeCell[]): StrategyEdgeResult[] {
  const byDate = new Map<string, OutcomeCell[]>()
  const strategyKeys = new Map<string, { id: string; version: string }>()
  for (const cell of cells) {
    const residual = finite(cell.residual_return_net)
    const absolute = finite(cell.absolute_return_net)
    if (residual == null || absolute == null) continue
    const dateRows = byDate.get(cell.signal_date) ?? []
    dateRows.push(cell)
    byDate.set(cell.signal_date, dateRows)
    strategyKeys.set(`${cell.strategy_id}|${cell.strategy_version}`, { id: cell.strategy_id, version: cell.strategy_version })
  }

  const edges = new Map<string, number[]>()
  const hitAbsolute = new Map<string, number[]>()
  const observationSymbols = new Map<string, Set<string>>()
  for (const dateRows of byDate.values()) {
    const outcomes = new Map<string, { residual: number; absolute: number }>()
    const hitsBySymbol = new Map<string, Set<string>>()
    for (const row of dateRows) {
      outcomes.set(row.symbol, { residual: Number(row.residual_return_net), absolute: Number(row.absolute_return_net) })
      const key = `${row.strategy_id}|${row.strategy_version}`
      if (Number(row.strategy_hit) === 1) {
        const hits = hitsBySymbol.get(row.symbol) ?? new Set<string>()
        hits.add(key)
        hitsBySymbol.set(row.symbol, hits)
        const absolute = hitAbsolute.get(key) ?? []
        absolute.push(Number(row.absolute_return_net))
        hitAbsolute.set(key, absolute)
        const symbols = observationSymbols.get(key) ?? new Set<string>()
        symbols.add(`${row.signal_date}|${row.symbol}`)
        observationSymbols.set(key, symbols)
      }
    }
    const allSelected = [...hitsBySymbol.entries()].filter(([, hits]) => hits.size > 0).map(([symbol]) => symbol)
    if (!allSelected.length) continue
    const allValue = mean(allSelected.map((symbol) => outcomes.get(symbol)!.residual))!
    for (const key of strategyKeys.keys()) {
      const without = [...hitsBySymbol.entries()]
        .filter(([, hits]) => [...hits].some((hit) => hit !== key))
        .map(([symbol]) => symbol)
      const strategyContributes = allSelected.some((symbol) => hitsBySymbol.get(symbol)?.has(key))
      if (!strategyContributes) continue
      const withoutValue = without.length ? mean(without.map((symbol) => outcomes.get(symbol)!.residual))! : 0
      const values = edges.get(key) ?? []
      values.push(allValue - withoutValue)
      edges.set(key, values)
    }
  }

  return [...strategyKeys.entries()].map(([key, strategy]) => {
    const dateEdges = edges.get(key) ?? []
    const edgeMean = mean(dateEdges)
    const sd = edgeMean == null ? null : sampleStandardDeviation(dateEdges, edgeMean)
    const critical = lcb90CriticalValue(dateEdges.length)
    const lcb = edgeMean != null && sd != null && critical != null
      ? edgeMean - critical * sd / Math.sqrt(dateEdges.length)
      : null
    const absoluteMean = mean(hitAbsolute.get(key) ?? [])
    const eligible = dateEdges.length >= MIN_EDGE_DATES
      && lcb != null && lcb > 0
      && absoluteMean != null && absoluteMean > 0
    return {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      observationDates: dateEdges.length,
      candidateObservations: observationSymbols.get(key)?.size ?? 0,
      marginalEdgeMean: edgeMean,
      marginalEdgeLcb90: lcb,
      positiveDateRate: dateEdges.length ? dateEdges.filter((value) => value > 0).length / dateEdges.length : null,
      absoluteHitReturnMean: absoluteMean,
      productionEligible: eligible,
      productionWeightRaw: eligible ? lcb! : 0,
    }
  }).sort((left, right) => left.strategyId.localeCompare(right.strategyId))
}

export interface StrategyPortfolioDateReturnV4 {
  signalDate: string
  residualReturn: number
  absoluteReturn: number
}

interface ConfidenceSummary {
  dates: number
  mean: number | null
  lcb90: number | null
}

function confidenceSummary(values: number[]): ConfidenceSummary {
  const average = mean(values)
  const sd = average == null ? null : sampleStandardDeviation(values, average)
  const critical = lcb90CriticalValue(values.length)
  return {
    dates: values.length,
    mean: average,
    lcb90: average != null && sd != null && critical != null
      ? average - critical * sd / Math.sqrt(values.length)
      : null,
  }
}

export interface DependenceAdjustedConfidenceV7 {
  dates: number
  mean: number | null
  hacLag: number
  hacLongRunVariance: number | null
  hacStandardError: number | null
  effectiveDates: number | null
  lcb95Hac: number | null
  oneSidedPValue: number | null
  powerAtMinimumEconomicDelta: number | null
}

export interface HolmCorrectionInputV7 {
  key: string
  pValue: number | null
}

export interface HolmCorrectionResultV7 {
  key: string
  familySize: number
  rank: number
  rawPValue: number
  adjustedPValue: number
  criticalAlpha: number
  rejected: boolean
}

function standardNormalCdf(value: number): number {
  if (value === Infinity) return 1
  if (value === -Infinity) return 0
  const absolute = Math.abs(value)
  const t = 1 / (1 + 0.2316419 * absolute)
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute)
  const tail = density * t * (
    0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
  )
  const cdf = 1 - tail
  return value >= 0 ? cdf : 1 - cdf
}

function oneSidedNormalCritical(alpha: number): number | null {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 0.5) return null
  let lower = 0
  let upper = 8
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) / 2
    if (1 - standardNormalCdf(midpoint) > alpha) lower = midpoint
    else upper = midpoint
  }
  return (lower + upper) / 2
}

export function evaluatePowerAtMinimumEconomicDeltaV7(
  standardError: number | null,
  alpha: number,
): number | null {
  if (standardError == null || !Number.isFinite(standardError) || standardError < 0) return null
  if (standardError <= Number.EPSILON) return 1
  const critical = oneSidedNormalCritical(alpha)
  if (critical == null) return null
  return Math.max(0, Math.min(1, standardNormalCdf(
    MINIMUM_ECONOMIC_PAIRED_DELTA / standardError - critical,
  )))
}

/**
 * Newey-West/Bartlett inference for chronological T+5 overlapping returns.
 * The long-run variance is conservatively floored at the IID variance so
 * negative sample autocorrelation cannot manufacture extra effective dates.
 */
export function evaluateDependenceAdjustedMeanV7(
  input: number[],
  requestedLag = REPLACEMENT_HAC_LAG,
): DependenceAdjustedConfidenceV7 {
  const values = input.filter((value) => Number.isFinite(value))
  const dates = values.length
  const average = mean(values)
  const requestedLagInteger = Number.isFinite(requestedLag) ? Math.trunc(requestedLag) : REPLACEMENT_HAC_LAG
  const lag = Math.min(Math.max(REPLACEMENT_HAC_LAG, requestedLagInteger), Math.max(0, dates - 1))
  if (average == null || dates < 2) {
    return {
      dates,
      mean: average,
      hacLag: lag,
      hacLongRunVariance: null,
      hacStandardError: null,
      effectiveDates: null,
      lcb95Hac: null,
      oneSidedPValue: null,
      powerAtMinimumEconomicDelta: null,
    }
  }

  const centered = values.map((value) => value - average)
  const gamma0 = centered.reduce((sum, value) => sum + value * value, 0) / dates
  let rawLongRunVariance = gamma0
  for (let offset = 1; offset <= lag; offset += 1) {
    let covariance = 0
    for (let index = offset; index < dates; index += 1) {
      covariance += centered[index] * centered[index - offset]
    }
    covariance /= dates
    const bartlettWeight = 1 - offset / (lag + 1)
    rawLongRunVariance += 2 * bartlettWeight * covariance
  }
  const longRunVariance = Math.max(0, gamma0, rawLongRunVariance)
  const standardError = Math.sqrt(longRunVariance / dates)
  const effectiveDates = gamma0 <= Number.EPSILON || longRunVariance <= Number.EPSILON
    ? dates
    : Math.max(1, Math.min(dates, dates * gamma0 / longRunVariance))
  const lcb95Hac = average - ONE_SIDED_95_Z * standardError
  const zScore = standardError <= Number.EPSILON
    ? (average > 0 ? Infinity : average < 0 ? -Infinity : 0)
    : average / standardError
  const oneSidedPValue = Math.max(0, Math.min(1, 1 - standardNormalCdf(zScore)))
  const powerAtMinimumEconomicDelta = evaluatePowerAtMinimumEconomicDeltaV7(standardError, 0.05)
  return {
    dates,
    mean: average,
    hacLag: lag,
    hacLongRunVariance: longRunVariance,
    hacStandardError: standardError,
    effectiveDates,
    lcb95Hac,
    oneSidedPValue,
    powerAtMinimumEconomicDelta,
  }
}

export function applyHolmCorrectionV7(
  inputs: HolmCorrectionInputV7[],
  alpha = REPLACEMENT_FAMILYWISE_ALPHA,
): HolmCorrectionResultV7[] {
  const familySize = inputs.length
  if (!familySize) return []
  const sorted = inputs.map((row, originalIndex) => ({
    key: row.key,
    originalIndex,
    pValue: row.pValue == null || !Number.isFinite(row.pValue)
      ? 1
      : Math.max(0, Math.min(1, row.pValue)),
  })).sort((left, right) => left.pValue - right.pValue
    || left.key.localeCompare(right.key)
    || left.originalIndex - right.originalIndex)
  const output = new Array<HolmCorrectionResultV7>(familySize)
  let priorAdjusted = 0
  let rejectionSequenceOpen = true
  sorted.forEach((row, index) => {
    const remaining = familySize - index
    const criticalAlpha = alpha / remaining
    const adjustedPValue = Math.min(1, Math.max(priorAdjusted, row.pValue * remaining))
    const rejected = rejectionSequenceOpen && row.pValue <= criticalAlpha
    if (!rejected) rejectionSequenceOpen = false
    priorAdjusted = adjustedPValue
    output[row.originalIndex] = {
      key: row.key,
      familySize,
      rank: index + 1,
      rawPValue: row.pValue,
      adjustedPValue,
      criticalAlpha,
      rejected,
    }
  })
  return output
}

export function evaluateStrategyPortfolioEdgeV4(
  cells: OutcomeCell[],
  strategyWeights: Map<string, number>,
): StrategyPortfolioDateReturnV4[] {
  const byDate = new Map<string, OutcomeCell[]>()
  for (const cell of cells) {
    const rows = byDate.get(cell.signal_date) ?? []
    rows.push(cell)
    byDate.set(cell.signal_date, rows)
  }
  const output: StrategyPortfolioDateReturnV4[] = []
  for (const [signalDate, rows] of byDate.entries()) {
    const symbols = new Map<string, { residual: number; absolute: number; hits: Set<string> }>()
    for (const row of rows) {
      const residual = finite(row.residual_return_net)
      const absolute = finite(row.absolute_return_net)
      if (residual == null || absolute == null) continue
      const item = symbols.get(row.symbol) ?? { residual, absolute, hits: new Set<string>() }
      if (Number(row.strategy_hit) === 1) item.hits.add(`${row.strategy_id}|${row.strategy_version}`)
      symbols.set(row.symbol, item)
    }
    let totalWeight = 0
    let residualSum = 0
    let absoluteSum = 0
    for (const item of symbols.values()) {
      const weight = [...item.hits].reduce((sum, key) => sum + Math.max(0, strategyWeights.get(key) ?? 0), 0)
      if (weight <= 0) continue
      totalWeight += weight
      residualSum += item.residual * weight
      absoluteSum += item.absolute * weight
    }
    if (totalWeight > 0) {
      output.push({
        signalDate,
        residualReturn: residualSum / totalWeight,
        absoluteReturn: absoluteSum / totalWeight,
      })
    }
  }
  return output.sort((left, right) => left.signalDate.localeCompare(right.signalDate))
}


export interface StrategyReplacementProposalV6 {
  candidateKey: string
  incumbentKey: string
  familyId: string
  incumbentFamilyId: string
  replacementScope: 'same_family' | 'cross_family'
  pairedDates: number
  pairedDeltaMean: number | null
  pairedDeltaLcb90: number | null
  candidateAbsoluteMean: number | null
  candidateMaxDrawdown: number | null
  incumbentMaxDrawdown: number | null
  candidateTurnover: number | null
  incumbentTurnover: number | null
  returnCorrelation: number | null
  pass: boolean
  rejectionReasons: string[]
}

export interface StrategyReplacementProposalV7 extends StrategyReplacementProposalV6 {
  statisticalPolicyVersion: typeof STRATEGY_REPLACEMENT_POLICY_VERSION_V7
  hacLag: number
  effectivePairedDates: number | null
  pairedDeltaHacStandardError: number | null
  pairedDeltaLcb95Hac: number | null
  pairedDeltaOneSidedPValue: number | null
  pairedDeltaPowerAtMinimumEconomicDelta: number | null
  candidateAbsoluteEffectiveDates: number | null
  candidateAbsoluteHacStandardError: number | null
  candidateAbsoluteLcb95Hac: number | null
  holmFamilySize: number
  holmRank: number | null
  holmCriticalAlpha: number | null
  holmAdjustedPValue: number | null
  holmRejected: boolean
}

export interface StrategyPairedConfidenceV7 extends DependenceAdjustedConfidenceV7 {
  lcb90IidDiagnostic: number | null
}

function strategyKey(row: Pick<OutcomeCell, 'strategy_id' | 'strategy_version'>): string {
  return row.strategy_id + '|' + row.strategy_version
}

function maxDrawdown(values: number[]): number | null {
  if (!values.length) return null
  let wealth = 1
  let peak = 1
  let worst = 0
  for (const value of values) {
    wealth *= 1 + value
    peak = Math.max(peak, wealth)
    worst = Math.min(worst, peak > 0 ? wealth / peak - 1 : -1)
  }
  return worst
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null
  const leftMean = mean(left)!
  const rightMean = mean(right)!
  let numerator = 0
  let leftSq = 0
  let rightSq = 0
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] - leftMean
    const r = right[index] - rightMean
    numerator += l * r
    leftSq += l * l
    rightSq += r * r
  }
  return leftSq > 0 && rightSq > 0 ? numerator / Math.sqrt(leftSq * rightSq) : null
}

function strategyDateSeries(
  cells: OutcomeCell[],
  key: string,
): Array<{ date: string; residual: number; absolute: number; symbols: Set<string> }> {
  const byDate = new Map<string, { residual: number[]; absolute: number[]; symbols: Set<string> }>()
  for (const cell of cells) {
    if (strategyKey(cell) !== key || Number(cell.strategy_hit) !== 1) continue
    const residual = finite(cell.residual_return_net)
    const absolute = finite(cell.absolute_return_net)
    if (residual == null || absolute == null) continue
    const bucket = byDate.get(cell.signal_date) ?? { residual: [], absolute: [], symbols: new Set<string>() }
    if (!bucket.symbols.has(cell.symbol)) {
      bucket.symbols.add(cell.symbol)
      bucket.residual.push(residual)
      bucket.absolute.push(absolute)
    }
    byDate.set(cell.signal_date, bucket)
  }
  return [...byDate.entries()]
    .map(([date, bucket]) => ({
      date,
      residual: mean(bucket.residual)!,
      absolute: mean(bucket.absolute)!,
      symbols: bucket.symbols,
    }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

function strategyTurnover(series: Array<{ symbols: Set<string> }>): number | null {
  if (series.length < 2) return null
  const turns: number[] = []
  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1].symbols
    const current = series[index].symbols
    const union = new Set([...previous, ...current])
    if (!union.size) continue
    let intersection = 0
    for (const symbol of previous) if (current.has(symbol)) intersection += 1
    turns.push(1 - intersection / union.size)
  }
  return mean(turns)
}

function pairedPortfolioSummary(
  candidate: StrategyPortfolioDateReturnV4[],
  incumbent: StrategyPortfolioDateReturnV4[],
): ConfidenceSummary {
  const incumbentByDate = new Map(incumbent.map((row) => [row.signalDate, row.residualReturn]))
  return confidenceSummary(candidate
    .filter((row) => incumbentByDate.has(row.signalDate))
    .map((row) => row.residualReturn - incumbentByDate.get(row.signalDate)!))
}

function pairedPortfolioSummaryV7(
  candidate: StrategyPortfolioDateReturnV4[],
  incumbent: StrategyPortfolioDateReturnV4[],
): StrategyPairedConfidenceV7 {
  const incumbentByDate = new Map(incumbent.map((row) => [row.signalDate, row.residualReturn]))
  const deltas = candidate
    .filter((row) => incumbentByDate.has(row.signalDate))
    .map((row) => row.residualReturn - incumbentByDate.get(row.signalDate)!)
  return {
    ...evaluateDependenceAdjustedMeanV7(deltas),
    lcb90IidDiagnostic: confidenceSummary(deltas).lcb90,
  }
}

function pairedPortfolioCorrelation(
  candidate: StrategyPortfolioDateReturnV4[],
  incumbent: StrategyPortfolioDateReturnV4[],
): number | null {
  const incumbentByDate = new Map(incumbent.map((row) => [row.signalDate, row.residualReturn]))
  const paired = candidate.filter((row) => incumbentByDate.has(row.signalDate))
  return pearson(
    paired.map((row) => row.residualReturn),
    paired.map((row) => incumbentByDate.get(row.signalDate)!),
  )
}

function strategyPortfolioSelections(
  cells: OutcomeCell[],
  strategyWeights: Map<string, number>,
): Array<{ date: string; symbols: Set<string> }> {
  const byDate = new Map<string, Set<string>>()
  for (const cell of cells) {
    if (Number(cell.strategy_hit) !== 1 || (strategyWeights.get(strategyKey(cell)) ?? 0) <= 0) continue
    const symbols = byDate.get(cell.signal_date) ?? new Set<string>()
    symbols.add(cell.symbol)
    byDate.set(cell.signal_date, symbols)
  }
  return [...byDate.entries()]
    .map(([date, symbols]) => ({ date, symbols }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

export function evaluatePairedStrategyReplacementsV6(
  cells: OutcomeCell[],
  edges: StrategyEdgeResult[],
  baselineWeights: Map<string, number>,
): {
  proposals: StrategyReplacementProposalV6[]
  accepted: StrategyReplacementProposalV6[]
  finalWeights: Map<string, number>
  baselineDates: StrategyPortfolioDateReturnV4[]
  finalDates: StrategyPortfolioDateReturnV4[]
  globalPaired: ConfidenceSummary
  globalAbsoluteMean: number | null
  globalReturnCorrelation: number | null
  baselineMaxDrawdown: number | null
  finalMaxDrawdown: number | null
  baselineTurnover: number | null
  finalTurnover: number | null
  globalCorrelationPass: boolean
  globalTurnoverPass: boolean
  globalRiskPass: boolean
} {
  const familyByKey = new Map<string, string>()
  for (const cell of cells) {
    const key = strategyKey(cell)
    if (!familyByKey.has(key)) familyByKey.set(key, String(cell.family_id || 'UNKNOWN'))
  }
  const baselineDates = evaluateStrategyPortfolioEdgeV4(cells, baselineWeights)
  const proposals: StrategyReplacementProposalV6[] = []
  for (const edge of edges.filter((row) => row.productionEligible)) {
    const candidateKey = edge.strategyId + '|' + edge.strategyVersion
    if (baselineWeights.has(candidateKey)) continue
    const familyId = familyByKey.get(candidateKey) ?? 'UNKNOWN'
    const candidateSeries = strategyDateSeries(cells, candidateKey)
    const candidateByDate = new Map(candidateSeries.map((row) => [row.date, row]))
    for (const [incumbentKey, incumbentWeight] of baselineWeights.entries()) {
      const incumbentFamilyId = familyByKey.get(incumbentKey) ?? 'UNKNOWN'
      const replacementScope = incumbentFamilyId === familyId ? 'same_family' : 'cross_family'
      const incumbentSeries = strategyDateSeries(cells, incumbentKey)
      const incumbentByDate = new Map(incumbentSeries.map((row) => [row.date, row]))
      const proposalWeights = new Map(baselineWeights)
      proposalWeights.delete(incumbentKey)
      proposalWeights.set(candidateKey, incumbentWeight > 0 ? incumbentWeight : 1)
      const proposalDates = evaluateStrategyPortfolioEdgeV4(cells, proposalWeights)
      const paired = pairedPortfolioSummary(proposalDates, baselineDates)
      const pairedIndividualDates = [...candidateByDate.keys()].filter((date) => incumbentByDate.has(date))
      const returnCorrelation = pearson(
        pairedIndividualDates.map((date) => candidateByDate.get(date)!.residual),
        pairedIndividualDates.map((date) => incumbentByDate.get(date)!.residual),
      )
      const candidateMaxDrawdown = maxDrawdown(candidateSeries.map((row) => row.absolute))
      const incumbentMaxDrawdown = maxDrawdown(incumbentSeries.map((row) => row.absolute))
      const candidateTurnover = strategyTurnover(candidateSeries)
      const incumbentTurnover = strategyTurnover(incumbentSeries)
      const candidateAbsoluteMean = mean(candidateSeries.map((row) => row.absolute))
      const rejectionReasons: string[] = []
      if (paired.dates < MIN_EDGE_DATES) rejectionReasons.push('paired_dates_below_minimum')
      if (paired.lcb90 == null || paired.lcb90 <= 0) rejectionReasons.push('paired_delta_lcb90_not_positive')
      if (candidateAbsoluteMean == null || candidateAbsoluteMean <= 0) rejectionReasons.push('candidate_absolute_cost_net_mean_not_positive')
      if (candidateMaxDrawdown == null || incumbentMaxDrawdown == null) {
        rejectionReasons.push('drawdown_evidence_missing')
      } else if (candidateMaxDrawdown < incumbentMaxDrawdown - REPLACEMENT_MDD_TOLERANCE) {
        rejectionReasons.push('candidate_drawdown_materially_worse')
      }
      if (candidateTurnover == null || incumbentTurnover == null) {
        rejectionReasons.push('turnover_evidence_missing')
      } else if (candidateTurnover > incumbentTurnover + REPLACEMENT_TURNOVER_TOLERANCE) {
        rejectionReasons.push('candidate_turnover_materially_worse')
      }
      if (returnCorrelation == null) {
        rejectionReasons.push('paired_return_correlation_missing')
      } else if (
        returnCorrelation > REPLACEMENT_DUPLICATE_CORRELATION
        && candidateMaxDrawdown != null
        && incumbentMaxDrawdown != null
        && candidateTurnover != null
        && incumbentTurnover != null
        && candidateMaxDrawdown <= incumbentMaxDrawdown
        && candidateTurnover >= incumbentTurnover
      ) {
        rejectionReasons.push('highly_correlated_without_risk_or_turnover_improvement')
      }
      proposals.push({
        candidateKey,
        incumbentKey,
        familyId,
        incumbentFamilyId,
        replacementScope,
        pairedDates: paired.dates,
        pairedDeltaMean: paired.mean,
        pairedDeltaLcb90: paired.lcb90,
        candidateAbsoluteMean,
        candidateMaxDrawdown,
        incumbentMaxDrawdown,
        candidateTurnover,
        incumbentTurnover,
        returnCorrelation,
        pass: rejectionReasons.length === 0,
        rejectionReasons,
      })
    }
  }

  const accepted: StrategyReplacementProposalV6[] = []
  const usedCandidates = new Set<string>()
  const usedIncumbents = new Set<string>()
  for (const proposal of proposals
    .filter((row) => row.pass)
    .sort((left, right) => (right.pairedDeltaLcb90 ?? -Infinity) - (left.pairedDeltaLcb90 ?? -Infinity))) {
    if (usedCandidates.has(proposal.candidateKey) || usedIncumbents.has(proposal.incumbentKey)) continue
    accepted.push(proposal)
    usedCandidates.add(proposal.candidateKey)
    usedIncumbents.add(proposal.incumbentKey)
  }

  const finalWeights = new Map(baselineWeights)
  for (const proposal of accepted) {
    const weight = finalWeights.get(proposal.incumbentKey) ?? 1
    finalWeights.delete(proposal.incumbentKey)
    finalWeights.set(proposal.candidateKey, weight)
  }
  const finalDates = evaluateStrategyPortfolioEdgeV4(cells, finalWeights)
  const globalPaired = pairedPortfolioSummary(finalDates, baselineDates)
  const globalAbsoluteMean = mean(finalDates.map((row) => row.absoluteReturn))
  const baselineMdd = maxDrawdown(baselineDates.map((row) => row.absoluteReturn))
  const finalMdd = maxDrawdown(finalDates.map((row) => row.absoluteReturn))
  const baselineTurnover = strategyTurnover(strategyPortfolioSelections(cells, baselineWeights))
  const finalTurnover = strategyTurnover(strategyPortfolioSelections(cells, finalWeights))
  const globalReturnCorrelation = pairedPortfolioCorrelation(finalDates, baselineDates)
  const globalTurnoverPass = baselineTurnover != null
    && finalTurnover != null
    && finalTurnover <= baselineTurnover + REPLACEMENT_TURNOVER_TOLERANCE
  const globalCorrelationPass = globalReturnCorrelation != null
    && (
      globalReturnCorrelation <= REPLACEMENT_DUPLICATE_CORRELATION
      || (baselineMdd != null && finalMdd != null && finalMdd > baselineMdd)
      || (baselineTurnover != null && finalTurnover != null && finalTurnover < baselineTurnover)
    )
  const globalRiskPass = accepted.length > 0
    && globalPaired.dates >= MIN_EDGE_DATES
    && globalPaired.lcb90 != null
    && globalPaired.lcb90 > 0
    && globalAbsoluteMean != null
    && globalAbsoluteMean > 0
    && baselineMdd != null
    && finalMdd != null
    && finalMdd >= baselineMdd - REPLACEMENT_MDD_TOLERANCE
    && globalTurnoverPass
    && globalCorrelationPass
  if (!globalRiskPass) {
    accepted.splice(0, accepted.length)
    return {
      proposals,
      accepted,
      finalWeights: new Map(baselineWeights),
      baselineDates,
      finalDates: baselineDates,
      globalPaired,
      globalAbsoluteMean,
      globalReturnCorrelation,
      baselineMaxDrawdown: baselineMdd,
      finalMaxDrawdown: finalMdd,
      baselineTurnover,
      finalTurnover,
      globalCorrelationPass,
      globalTurnoverPass,
      globalRiskPass: false,
    }
  }
  return {
    proposals,
    accepted,
    finalWeights,
    baselineDates,
    finalDates,
    globalPaired,
    globalAbsoluteMean,
    globalReturnCorrelation,
    baselineMaxDrawdown: baselineMdd,
    finalMaxDrawdown: finalMdd,
    baselineTurnover,
    finalTurnover,
    globalCorrelationPass,
    globalTurnoverPass,
    globalRiskPass: true,
  }
}

export interface StrategyReplacementEvaluationV7 {
  proposals: StrategyReplacementProposalV7[]
  accepted: StrategyReplacementProposalV7[]
  finalWeights: Map<string, number>
  baselineDates: StrategyPortfolioDateReturnV4[]
  finalDates: StrategyPortfolioDateReturnV4[]
  globalPaired: StrategyPairedConfidenceV7
  globalAbsoluteMean: number | null
  globalAbsoluteConfidence: DependenceAdjustedConfidenceV7
  globalReturnCorrelation: number | null
  baselineMaxDrawdown: number | null
  finalMaxDrawdown: number | null
  baselineTurnover: number | null
  finalTurnover: number | null
  globalCorrelationPass: boolean
  globalTurnoverPass: boolean
  globalEffectiveSamplePass: boolean
  globalPowerPass: boolean
  globalRiskPass: boolean
  globalRejectionReasons: string[]
  holmFamilySize: number
}

/**
 * V7 preserves the V6 atomic/risk contract and adds a separate statistical
 * policy: T+5 HAC(4), one-sided 95% LCB, Holm family-wise control, effective
 * sample size, and 80% power at the versioned minimum economic effect.
 */
export function evaluatePairedStrategyReplacementsV7(
  cells: OutcomeCell[],
  edges: StrategyEdgeResult[],
  baselineWeights: Map<string, number>,
): StrategyReplacementEvaluationV7 {
  const familyByKey = new Map<string, string>()
  for (const cell of cells) {
    const key = strategyKey(cell)
    if (!familyByKey.has(key)) familyByKey.set(key, String(cell.family_id || 'UNKNOWN'))
  }
  const baselineDates = evaluateStrategyPortfolioEdgeV4(cells, baselineWeights)
  const proposals: StrategyReplacementProposalV7[] = []
  for (const edge of edges.filter((row) => row.productionEligible)) {
    const candidateKey = edge.strategyId + '|' + edge.strategyVersion
    if (baselineWeights.has(candidateKey)) continue
    const familyId = familyByKey.get(candidateKey) ?? 'UNKNOWN'
    const candidateSeries = strategyDateSeries(cells, candidateKey)
    const candidateByDate = new Map(candidateSeries.map((row) => [row.date, row]))
    for (const [incumbentKey, incumbentWeight] of baselineWeights.entries()) {
      const incumbentFamilyId = familyByKey.get(incumbentKey) ?? 'UNKNOWN'
      const replacementScope = incumbentFamilyId === familyId ? 'same_family' : 'cross_family'
      const incumbentSeries = strategyDateSeries(cells, incumbentKey)
      const incumbentByDate = new Map(incumbentSeries.map((row) => [row.date, row]))
      const proposalWeights = new Map(baselineWeights)
      proposalWeights.delete(incumbentKey)
      proposalWeights.set(candidateKey, incumbentWeight > 0 ? incumbentWeight : 1)
      const proposalDates = evaluateStrategyPortfolioEdgeV4(cells, proposalWeights)
      const pairedLegacy = pairedPortfolioSummary(proposalDates, baselineDates)
      const paired = pairedPortfolioSummaryV7(proposalDates, baselineDates)
      const pairedIndividualDates = [...candidateByDate.keys()].filter((date) => incumbentByDate.has(date))
      const returnCorrelation = pearson(
        pairedIndividualDates.map((date) => candidateByDate.get(date)!.residual),
        pairedIndividualDates.map((date) => incumbentByDate.get(date)!.residual),
      )
      const candidateMaxDrawdown = maxDrawdown(candidateSeries.map((row) => row.absolute))
      const incumbentMaxDrawdown = maxDrawdown(incumbentSeries.map((row) => row.absolute))
      const candidateTurnover = strategyTurnover(candidateSeries)
      const incumbentTurnover = strategyTurnover(incumbentSeries)
      const candidateAbsoluteMean = mean(candidateSeries.map((row) => row.absolute))
      const candidateAbsoluteConfidence = evaluateDependenceAdjustedMeanV7(candidateSeries.map((row) => row.absolute))
      const rejectionReasons: string[] = []
      if (paired.dates < MIN_EDGE_DATES) rejectionReasons.push('paired_dates_below_minimum')
      if (paired.effectiveDates == null || paired.effectiveDates < MIN_EFFECTIVE_PAIRED_DATES) {
        rejectionReasons.push('effective_paired_dates_below_minimum')
      }
      if (paired.lcb95Hac == null || paired.lcb95Hac <= 0) {
        rejectionReasons.push('paired_delta_lcb95_hac_not_positive')
      }
      if (candidateAbsoluteMean == null || candidateAbsoluteMean <= 0) {
        rejectionReasons.push('candidate_absolute_cost_net_mean_not_positive')
      }
      if (candidateAbsoluteConfidence.lcb95Hac == null || candidateAbsoluteConfidence.lcb95Hac <= 0) {
        rejectionReasons.push('candidate_absolute_cost_net_lcb95_hac_not_positive')
      }
      if (candidateMaxDrawdown == null || incumbentMaxDrawdown == null) {
        rejectionReasons.push('drawdown_evidence_missing')
      } else if (candidateMaxDrawdown < incumbentMaxDrawdown - REPLACEMENT_MDD_TOLERANCE) {
        rejectionReasons.push('candidate_drawdown_materially_worse')
      }
      if (candidateTurnover == null || incumbentTurnover == null) {
        rejectionReasons.push('turnover_evidence_missing')
      } else if (candidateTurnover > incumbentTurnover + REPLACEMENT_TURNOVER_TOLERANCE) {
        rejectionReasons.push('candidate_turnover_materially_worse')
      }
      if (returnCorrelation == null) {
        rejectionReasons.push('paired_return_correlation_missing')
      } else if (
        returnCorrelation > REPLACEMENT_DUPLICATE_CORRELATION
        && candidateMaxDrawdown != null
        && incumbentMaxDrawdown != null
        && candidateTurnover != null
        && incumbentTurnover != null
        && candidateMaxDrawdown <= incumbentMaxDrawdown
        && candidateTurnover >= incumbentTurnover
      ) {
        rejectionReasons.push('highly_correlated_without_risk_or_turnover_improvement')
      }
      proposals.push({
        candidateKey,
        incumbentKey,
        familyId,
        incumbentFamilyId,
        replacementScope,
        pairedDates: paired.dates,
        pairedDeltaMean: paired.mean,
        pairedDeltaLcb90: pairedLegacy.lcb90,
        statisticalPolicyVersion: STRATEGY_REPLACEMENT_POLICY_VERSION_V7,
        hacLag: paired.hacLag,
        effectivePairedDates: paired.effectiveDates,
        pairedDeltaHacStandardError: paired.hacStandardError,
        pairedDeltaLcb95Hac: paired.lcb95Hac,
        pairedDeltaOneSidedPValue: paired.oneSidedPValue,
        pairedDeltaPowerAtMinimumEconomicDelta: paired.powerAtMinimumEconomicDelta,
        candidateAbsoluteEffectiveDates: candidateAbsoluteConfidence.effectiveDates,
        candidateAbsoluteHacStandardError: candidateAbsoluteConfidence.hacStandardError,
        candidateAbsoluteLcb95Hac: candidateAbsoluteConfidence.lcb95Hac,
        holmFamilySize: 0,
        holmRank: null,
        holmCriticalAlpha: null,
        holmAdjustedPValue: null,
        holmRejected: false,
        candidateAbsoluteMean,
        candidateMaxDrawdown,
        incumbentMaxDrawdown,
        candidateTurnover,
        incumbentTurnover,
        returnCorrelation,
        pass: false,
        rejectionReasons,
      })
    }
  }

  const holm = applyHolmCorrectionV7(proposals.map((proposal) => ({
    key: proposal.candidateKey + '->' + proposal.incumbentKey,
    pValue: proposal.pairedDeltaOneSidedPValue,
  })))
  proposals.forEach((proposal, index) => {
    const correction = holm[index]
    proposal.holmFamilySize = correction?.familySize ?? proposals.length
    proposal.holmRank = correction?.rank ?? null
    proposal.holmCriticalAlpha = correction?.criticalAlpha ?? null
    proposal.holmAdjustedPValue = correction?.adjustedPValue ?? null
    proposal.holmRejected = correction?.rejected === true
    proposal.pairedDeltaPowerAtMinimumEconomicDelta = evaluatePowerAtMinimumEconomicDeltaV7(
      proposal.pairedDeltaHacStandardError,
      proposal.holmCriticalAlpha ?? 0,
    )
    if (!proposal.holmRejected) proposal.rejectionReasons.push('holm_familywise_significance_not_met')
    if (
      proposal.pairedDeltaPowerAtMinimumEconomicDelta == null
      || proposal.pairedDeltaPowerAtMinimumEconomicDelta < MIN_REPLACEMENT_POWER
    ) proposal.rejectionReasons.push('paired_delta_power_below_80pct_at_holm_local_alpha')
    proposal.pass = proposal.rejectionReasons.length === 0
  })

  const accepted: StrategyReplacementProposalV7[] = []
  const usedCandidates = new Set<string>()
  const usedIncumbents = new Set<string>()
  for (const proposal of proposals
    .filter((row) => row.pass)
    .sort((left, right) => (right.pairedDeltaLcb95Hac ?? -Infinity) - (left.pairedDeltaLcb95Hac ?? -Infinity)
      || left.candidateKey.localeCompare(right.candidateKey)
      || left.incumbentKey.localeCompare(right.incumbentKey))) {
    if (usedCandidates.has(proposal.candidateKey) || usedIncumbents.has(proposal.incumbentKey)) continue
    accepted.push(proposal)
    usedCandidates.add(proposal.candidateKey)
    usedIncumbents.add(proposal.incumbentKey)
  }

  const finalWeights = new Map(baselineWeights)
  for (const proposal of accepted) {
    const weight = finalWeights.get(proposal.incumbentKey) ?? 1
    finalWeights.delete(proposal.incumbentKey)
    finalWeights.set(proposal.candidateKey, weight)
  }
  const finalDates = evaluateStrategyPortfolioEdgeV4(cells, finalWeights)
  const globalPaired = pairedPortfolioSummaryV7(finalDates, baselineDates)
  const globalAbsoluteMean = mean(finalDates.map((row) => row.absoluteReturn))
  const globalAbsoluteConfidence = evaluateDependenceAdjustedMeanV7(finalDates.map((row) => row.absoluteReturn))
  const baselineMdd = maxDrawdown(baselineDates.map((row) => row.absoluteReturn))
  const finalMdd = maxDrawdown(finalDates.map((row) => row.absoluteReturn))
  const baselineTurnover = strategyTurnover(strategyPortfolioSelections(cells, baselineWeights))
  const finalTurnover = strategyTurnover(strategyPortfolioSelections(cells, finalWeights))
  const globalReturnCorrelation = pairedPortfolioCorrelation(finalDates, baselineDates)
  const globalTurnoverPass = baselineTurnover != null
    && finalTurnover != null
    && finalTurnover <= baselineTurnover + REPLACEMENT_TURNOVER_TOLERANCE
  const globalCorrelationPass = globalReturnCorrelation != null
    && (
      globalReturnCorrelation <= REPLACEMENT_DUPLICATE_CORRELATION
      || (baselineMdd != null && finalMdd != null && finalMdd > baselineMdd)
      || (baselineTurnover != null && finalTurnover != null && finalTurnover < baselineTurnover)
    )
  const globalEffectiveSamplePass = globalPaired.effectiveDates != null
    && globalPaired.effectiveDates >= MIN_EFFECTIVE_PAIRED_DATES
  const globalPowerPass = globalPaired.powerAtMinimumEconomicDelta != null
    && globalPaired.powerAtMinimumEconomicDelta >= MIN_REPLACEMENT_POWER
  const globalRejectionReasons: string[] = []
  if (!accepted.length) globalRejectionReasons.push('no_holm_accepted_replacement')
  if (globalPaired.dates < MIN_EDGE_DATES) globalRejectionReasons.push('full_portfolio_paired_dates_below_minimum')
  if (!globalEffectiveSamplePass) globalRejectionReasons.push('full_portfolio_effective_dates_below_minimum')
  if (globalPaired.lcb95Hac == null || globalPaired.lcb95Hac <= 0) {
    globalRejectionReasons.push('full_portfolio_delta_lcb95_hac_not_positive')
  }
  if (!globalPowerPass) globalRejectionReasons.push('full_portfolio_power_below_80pct')
  if (globalAbsoluteMean == null || globalAbsoluteMean <= 0) {
    globalRejectionReasons.push('full_portfolio_absolute_cost_net_mean_not_positive')
  }
  if (globalAbsoluteConfidence.lcb95Hac == null || globalAbsoluteConfidence.lcb95Hac <= 0) {
    globalRejectionReasons.push('full_portfolio_absolute_cost_net_lcb95_hac_not_positive')
  }
  if (baselineMdd == null || finalMdd == null) {
    globalRejectionReasons.push('full_portfolio_drawdown_evidence_missing')
  } else if (finalMdd < baselineMdd - REPLACEMENT_MDD_TOLERANCE) {
    globalRejectionReasons.push('full_portfolio_drawdown_materially_worse')
  }
  if (!globalTurnoverPass) globalRejectionReasons.push('full_portfolio_turnover_gate_failed')
  if (!globalCorrelationPass) globalRejectionReasons.push('full_portfolio_correlation_gate_failed')
  const globalRiskPass = globalRejectionReasons.length === 0

  if (!globalRiskPass) {
    for (const proposal of accepted) {
      proposal.pass = false
      proposal.rejectionReasons.push(...globalRejectionReasons)
    }
    accepted.splice(0, accepted.length)
    return {
      proposals,
      accepted,
      finalWeights: new Map(baselineWeights),
      baselineDates,
      finalDates: baselineDates,
      globalPaired,
      globalAbsoluteMean,
      globalAbsoluteConfidence,
      globalReturnCorrelation,
      baselineMaxDrawdown: baselineMdd,
      finalMaxDrawdown: finalMdd,
      baselineTurnover,
      finalTurnover,
      globalCorrelationPass,
      globalTurnoverPass,
      globalEffectiveSamplePass,
      globalPowerPass,
      globalRiskPass: false,
      globalRejectionReasons,
      holmFamilySize: proposals.length,
    }
  }
  return {
    proposals,
    accepted,
    finalWeights,
    baselineDates,
    finalDates,
    globalPaired,
    globalAbsoluteMean,
    globalAbsoluteConfidence,
    globalReturnCorrelation,
    baselineMaxDrawdown: baselineMdd,
    finalMaxDrawdown: finalMdd,
    baselineTurnover,
    finalTurnover,
    globalCorrelationPass,
    globalTurnoverPass,
    globalEffectiveSamplePass,
    globalPowerPass,
    globalRiskPass: true,
    globalRejectionReasons,
    holmFamilySize: proposals.length,
  }
}

async function sourceFingerprint(cells: OutcomeCell[]): Promise<string> {
  const payload = JSON.stringify(cells.map((row) => [
    row.signal_date, row.symbol, row.strategy_id, row.strategy_version, row.family_id,
    Number(row.production_owner), Number(row.strategy_hit),
    Number(row.absolute_return_net), Number(row.residual_return_net),
  ]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].slice(0, 10).map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function refreshStrategyMarginalEdgeV4(
  db: D1Database,
  asOfDate: string,
  options: { allowPromotion?: boolean; canonicalRunIds?: Record<string, string> } = {},
): Promise<{ runId: string; status: 'shadow' | 'promoted'; sampleDates: number; eligibleStrategies: number }> {
  const asOfMs = Date.parse(`${asOfDate}T00:00:00Z`)
  if (!Number.isFinite(asOfMs)) throw new Error(`invalid_strategy_edge_as_of_date:${asOfDate}`)
  const startDate = new Date(asOfMs - EDGE_LOOKBACK_CALENDAR_DAYS * 86_400_000).toISOString().slice(0, 10)
  const canonicalOwnerClause = "EXISTS (SELECT 1 FROM json_each(?) h WHERE h.key=m.signal_date AND h.value=m.producer_run_id)"
  const cells: OutcomeCell[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  let cursorStrategyId = ''
  let cursorStrategyVersion = ''
  for (;;) {
    const page = await db.prepare(`
      SELECT m.signal_date, m.symbol, m.strategy_id, m.strategy_version,
             m.family_id, m.production_owner, m.strategy_hit,
             l.absolute_return_net, l.residual_return_net
        FROM strategy_label_matrix_v4 m
        JOIN strategy_label_matrix_runs_v4 mr
          ON mr.producer_run_id=m.producer_run_id
         AND mr.signal_date=m.signal_date
         AND mr.status='ready'
         AND mr.labeler_version IN (?, ?)
         AND m.labeler_version=mr.labeler_version
        JOIN canonical_selection_labels_v4 l
          ON l.signal_date=m.signal_date
         AND l.symbol=m.symbol
         AND l.producer_run_id=m.producer_run_id
         AND l.label_schema_version='canonical-strategy-selection-label-v4'
       WHERE m.signal_date BETWEEN ? AND ?
         AND l.outcome_known_date <= ?
         AND m.strategy_status IN ('active', 'candidate', 'shadow')
         AND EXISTS (
           SELECT 1 FROM strategy_spec_registry eligible_owner
            WHERE eligible_owner.strategy_id=m.strategy_id
              AND eligible_owner.version=m.strategy_version
              AND eligible_owner.owner_type='strategy'
              AND eligible_owner.status IN ('active','candidate','shadow')
              AND eligible_owner.promotion_status <> 'retired'
              AND eligible_owner.variant_id NOT LIKE 's12_%'
         )
         AND ${canonicalOwnerClause}
         AND (
           m.signal_date > ?
           OR (m.signal_date = ? AND m.symbol > ?)
           OR (m.signal_date = ? AND m.symbol = ? AND m.strategy_id > ?)
           OR (m.signal_date = ? AND m.symbol = ? AND m.strategy_id = ? AND m.strategy_version > ?)
         )
       ORDER BY m.signal_date, m.symbol, m.strategy_id, m.strategy_version
       LIMIT ?
    `).bind(
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
      startDate, asOfDate, asOfDate,
      JSON.stringify(options.canonicalRunIds ?? {}),
      cursorDate,
      cursorDate, cursorSymbol,
      cursorDate, cursorSymbol, cursorStrategyId,
      cursorDate, cursorSymbol, cursorStrategyId, cursorStrategyVersion,
      EDGE_PAGE_SIZE,
    ).all<OutcomeCell>()
    const rows = page.results ?? []
    cells.push(...rows)
    if (rows.length < EDGE_PAGE_SIZE) break
    const last = rows.at(-1)!
    cursorDate = last.signal_date
    cursorSymbol = last.symbol
    cursorStrategyId = last.strategy_id
    cursorStrategyVersion = last.strategy_version
  }

  const edges = evaluateStrategyMarginalEdgesV4(cells)
  const eligible = edges.filter((row) => row.productionEligible)
  const previousHead = await db.prepare("SELECT run_id FROM strategy_marginal_edge_head_v4 WHERE owner_key='production'")
    .first<{ run_id?: string }>()
  const registryActiveRows = await db.prepare(`
    SELECT strategy_id, version
      FROM strategy_spec_registry
     WHERE owner_type='strategy' AND status='active' AND promotion_status='production'
       AND variant_id NOT LIKE 's12_%'
     ORDER BY strategy_id, version
  `).all<{ strategy_id: string; version: string }>()
  const registryActiveKeys = new Set((registryActiveRows.results ?? []).map((row) => row.strategy_id + '|' + row.version))
  const previousWeightRows = previousHead?.run_id
    ? await db.prepare(`
        SELECT strategy_id, strategy_version, production_weight_raw
          FROM strategy_marginal_edge_v4
         WHERE run_id=?
           AND production_eligible=1
           AND edge_schema_version IN (?, ?)
      `).bind(
        previousHead.run_id, STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION, STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION_V6,
      )
        .all<{ strategy_id: string; strategy_version: string; production_weight_raw: number | string }>()
    : { results: [] }
  const championWeights = new Map((previousWeightRows.results ?? []).map((row) => [
    `${row.strategy_id}|${row.strategy_version}`,
    Math.max(0, Number(row.production_weight_raw) || 0),
  ]))
  if (!championWeights.size) {
    const cellKeys = new Set(cells.map((cell) => strategyKey(cell)))
    for (const key of registryActiveKeys) if (cellKeys.has(key)) championWeights.set(key, 1)
  }
  const servingCoverageComplete = registryActiveKeys.size === championWeights.size
    && [...registryActiveKeys].every((key) => championWeights.has(key))
  const replacement = evaluatePairedStrategyReplacementsV7(cells, edges, championWeights)
  const candidateDates = replacement.finalDates
  const championDates = replacement.baselineDates
  const championByDate = new Map(championDates.map((row) => [row.signalDate, row]))
  const candidateResidual = confidenceSummary(candidateDates.map((row) => row.residualReturn))
  const candidateAbsoluteMean = replacement.globalAbsoluteMean
  const candidateAbsoluteConfidence = replacement.globalAbsoluteConfidence
  const paired = replacement.globalPaired
  const finalOwnerKeys = new Set(replacement.finalWeights.keys())

  const fingerprint = await sourceFingerprint(cells)
  const runId = `strategy-marginal-edge-v7-${asOfDate}-${fingerprint}`
  if (previousHead?.run_id === runId) {
    const existing = await db.prepare('SELECT status FROM strategy_marginal_edge_runs_v4 WHERE run_id=?')
      .bind(runId).first<{ status?: string }>()
    if (existing?.status === 'promoted') {
      return { runId, status: 'promoted', sampleDates: candidateDates.length, eligibleStrategies: eligible.length }
    }
  }
  const promotionAllowed = options.allowPromotion === true
  const cutoverRiskPass = replacement.globalRiskPass && servingCoverageComplete
  const status: 'shadow' | 'promoted' = promotionAllowed && replacement.accepted.length > 0 && cutoverRiskPass
    ? 'promoted'
    : 'shadow'
  const sampleDates = candidateDates.length
  const candidateQuality = eligible.reduce((sum, row) => sum + row.productionWeightRaw, 0)

  await db.prepare(`
    INSERT INTO strategy_marginal_edge_runs_v4 (
      run_id, as_of_date, status, strategy_count, eligible_strategy_count, sample_dates, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status, strategy_count=excluded.strategy_count,
      eligible_strategy_count=excluded.eligible_strategy_count,
      sample_dates=excluded.sample_dates, evidence_json=excluded.evidence_json, error_code=NULL
  `).bind(runId, asOfDate, status, edges.length, replacement.accepted.length, sampleDates, JSON.stringify({
    schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
    replacement_policy: STRATEGY_REPLACEMENT_POLICY_V7,
    source: 'strategy_label_matrix_v4+canonical_selection_labels_v4',
    source_fingerprint: fingerprint,
    lookback_start_date: startDate,
    pagination: { page_size: EDGE_PAGE_SIZE, complete: true },
    min_production_dates: MIN_EDGE_DATES,
    candidate_strategy_lcb_sum_diagnostic_only: candidateQuality,
    production_owner_count_before: registryActiveKeys.size,
    production_owner_count_after: replacement.finalWeights.size,
    serving_owner_coverage_complete: servingCoverageComplete,
    candidate_portfolio: {
      dates: candidateResidual.dates,
      residual_mean: candidateResidual.mean,
      residual_lcb90: candidateResidual.lcb90,
      absolute_mean: candidateAbsoluteMean,
      absolute_effective_dates: candidateAbsoluteConfidence.effectiveDates,
      absolute_hac_standard_error: candidateAbsoluteConfidence.hacStandardError,
      absolute_lcb95_hac: candidateAbsoluteConfidence.lcb95Hac,
    },
    champion_comparison: {
      champion_run_id: previousHead?.run_id ?? null,
      paired_dates: paired.dates,
      hac_lag: paired.hacLag,
      effective_paired_dates: paired.effectiveDates,
      paired_residual_delta_mean: paired.mean,
      paired_residual_delta_lcb90_iid_diagnostic_only: paired.lcb90IidDiagnostic,
      paired_residual_delta_hac_standard_error: paired.hacStandardError,
      paired_residual_delta_lcb95_hac: paired.lcb95Hac,
      paired_residual_delta_one_sided_p_value: paired.oneSidedPValue,
      power_at_minimum_economic_delta: paired.powerAtMinimumEconomicDelta,
      minimum_economic_delta: MINIMUM_ECONOMIC_PAIRED_DELTA,
    },
    replacements: {
      evaluated: replacement.proposals.length,
      accepted: replacement.accepted,
      rejected: replacement.proposals.filter((row) => !replacement.accepted.includes(row)),
    },
    portfolio_risk: {
      baseline_max_drawdown: replacement.baselineMaxDrawdown,
      final_max_drawdown: replacement.finalMaxDrawdown,
      baseline_turnover: replacement.baselineTurnover,
      final_turnover: replacement.finalTurnover,
      return_correlation: replacement.globalReturnCorrelation,
      correlation_pass: replacement.globalCorrelationPass,
      turnover_pass: replacement.globalTurnoverPass,
    },
    promotion_gates: {
      accepted_hac_holm_replacement_exists: replacement.accepted.length > 0,
      statistical_policy_version: STRATEGY_REPLACEMENT_POLICY_VERSION_V7,
      holm_family_size: replacement.holmFamilySize,
      full_portfolio_positive_cost_net_lcb95_hac: paired.lcb95Hac != null && paired.lcb95Hac > 0,
      full_portfolio_absolute_cost_net_lcb95_hac: candidateAbsoluteConfidence.lcb95Hac != null && candidateAbsoluteConfidence.lcb95Hac > 0,
      full_portfolio_effective_sample_pass: replacement.globalEffectiveSamplePass,
      full_portfolio_power_80pct_pass: replacement.globalPowerPass,
      full_portfolio_correlation_pass: replacement.globalCorrelationPass,
      full_portfolio_turnover_pass: replacement.globalTurnoverPass,
      full_portfolio_all_gates_pass: replacement.globalRiskPass,
      full_portfolio_rejection_reasons: replacement.globalRejectionReasons,
      registry_and_serving_owner_coverage_complete: servingCoverageComplete,
      paired_champion_improvement_lcb95_hac: paired.lcb95Hac != null && paired.lcb95Hac > 0,
      active_count_unchanged: championWeights.size === replacement.finalWeights.size,
      no_hard_top_k: true,
      candidate_and_shadow_strategies_evaluated: true,
      s12_execution_owner_excluded_from_selection_replacement: true,
      registry_cutover_is_atomic_one_in_one_out: true,
      promotion_allowed_for_business_date: promotionAllowed,
    },
  })).run()

  try {
    const strategyStatements = edges.map((row) => db.prepare(`
      INSERT INTO strategy_marginal_edge_v4 (
        run_id, as_of_date, strategy_id, strategy_version, edge_schema_version,
        observation_dates, candidate_observations, marginal_edge_mean, marginal_edge_lcb90,
        positive_date_rate, absolute_hit_return_mean, production_eligible,
        production_weight_raw, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, strategy_id, strategy_version) DO UPDATE SET
        observation_dates=excluded.observation_dates,
        candidate_observations=excluded.candidate_observations,
        marginal_edge_mean=excluded.marginal_edge_mean,
        marginal_edge_lcb90=excluded.marginal_edge_lcb90,
        positive_date_rate=excluded.positive_date_rate,
        absolute_hit_return_mean=excluded.absolute_hit_return_mean,
        production_eligible=excluded.production_eligible,
        production_weight_raw=excluded.production_weight_raw,
        evidence_json=excluded.evidence_json
    `).bind(
      runId, asOfDate, row.strategyId, row.strategyVersion, STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
      row.observationDates, row.candidateObservations, row.marginalEdgeMean, row.marginalEdgeLcb90,
      row.positiveDateRate, row.absoluteHitReturnMean,
      finalOwnerKeys.has(row.strategyId + '|' + row.strategyVersion) ? 1 : 0,
      replacement.finalWeights.get(row.strategyId + '|' + row.strategyVersion) ?? 0,
      JSON.stringify({
        method: 'date_clustered_leave_one_strategy_out_then_hac_holm_cross_family_replacement_v7',
        outcome: 'sector_or_market_neutral_cost_net_return',
        candidate_prefilter_lcb_diagnostic: 'student_t_one_sided_90pct_date_clustered',
        replacement_lcb: 'newey_west_hac4_one_sided_95pct',
        multiple_testing: 'holm_bonferroni_familywise_5pct',
        min_effective_dates: MIN_EFFECTIVE_PAIRED_DATES,
        min_power: MIN_REPLACEMENT_POWER,
        minimum_economic_delta: MINIMUM_ECONOMIC_PAIRED_DELTA,
        min_dates: MIN_EDGE_DATES,
        lookback_calendar_days: EDGE_LOOKBACK_CALENDAR_DAYS,
        no_hard_top_k: true,
      }),
    ))
    for (let offset = 0; offset < strategyStatements.length; offset += 200) {
      await db.batch(strategyStatements.slice(offset, offset + 200))
    }

    const dateStatements = candidateDates.map((candidate) => {
      const champion = championByDate.get(candidate.signalDate)
      return db.prepare(`
        INSERT INTO strategy_marginal_edge_dates_v4 (
          run_id, signal_date, candidate_residual_return, candidate_absolute_return,
          champion_residual_return, champion_absolute_return, paired_residual_delta
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, signal_date) DO UPDATE SET
          candidate_residual_return=excluded.candidate_residual_return,
          candidate_absolute_return=excluded.candidate_absolute_return,
          champion_residual_return=excluded.champion_residual_return,
          champion_absolute_return=excluded.champion_absolute_return,
          paired_residual_delta=excluded.paired_residual_delta
      `).bind(
        runId, candidate.signalDate, candidate.residualReturn, candidate.absoluteReturn,
        champion?.residualReturn ?? null, champion?.absoluteReturn ?? null,
        champion ? candidate.residualReturn - champion.residualReturn : null,
      )
    })
    for (let offset = 0; offset < dateStatements.length; offset += 200) {
      await db.batch(dateStatements.slice(offset, offset + 200))
    }

    const acceptedPairs = new Set(replacement.accepted.map((row) => row.candidateKey + '->' + row.incumbentKey))
    const replacementStatements = replacement.proposals.map((proposal) => {
      const [candidateId, candidateVersion] = proposal.candidateKey.split('|')
      const [incumbentId, incumbentVersion] = proposal.incumbentKey.split('|')
      const accepted = acceptedPairs.has(proposal.candidateKey + '->' + proposal.incumbentKey)
      const decisionStatus = accepted ? (promotionAllowed && cutoverRiskPass ? 'accepted' : 'proposed') : 'rejected'
      const rejectionReasons = accepted || proposal.rejectionReasons.length > 0
        ? proposal.rejectionReasons
        : ['pair_conflict_or_lower_paired_edge']
      return db.prepare(`
        INSERT INTO strategy_replacement_decisions_v5 (
          decision_id, run_id, as_of_date, family_id,
          candidate_strategy_id, candidate_strategy_version,
          replaced_strategy_id, replaced_strategy_version, status,
          paired_dates, paired_delta_mean, paired_delta_lcb90, candidate_absolute_mean,
          candidate_max_drawdown, replaced_max_drawdown,
          candidate_turnover, replaced_turnover, return_correlation, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, candidate_strategy_id, candidate_strategy_version, replaced_strategy_id, replaced_strategy_version)
        DO UPDATE SET
          status=excluded.status,
          paired_dates=excluded.paired_dates,
          paired_delta_mean=excluded.paired_delta_mean,
          paired_delta_lcb90=excluded.paired_delta_lcb90,
          candidate_absolute_mean=excluded.candidate_absolute_mean,
          candidate_max_drawdown=excluded.candidate_max_drawdown,
          replaced_max_drawdown=excluded.replaced_max_drawdown,
          candidate_turnover=excluded.candidate_turnover,
          replaced_turnover=excluded.replaced_turnover,
          return_correlation=excluded.return_correlation,
          evidence_json=excluded.evidence_json
      `).bind(
        `strategy-replacement-v7:${runId}:${candidateId}:${incumbentId}`,
        runId, asOfDate, proposal.familyId,
        candidateId, candidateVersion, incumbentId, incumbentVersion,
        decisionStatus,
        proposal.pairedDates, proposal.pairedDeltaMean, proposal.pairedDeltaLcb90,
        proposal.candidateAbsoluteMean, proposal.candidateMaxDrawdown, proposal.incumbentMaxDrawdown,
        proposal.candidateTurnover, proposal.incumbentTurnover, proposal.returnCorrelation,
        JSON.stringify({
          schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
          statistical_policy_version: proposal.statisticalPolicyVersion,
          hac_lag: proposal.hacLag,
          effective_paired_dates: proposal.effectivePairedDates,
          paired_delta_hac_standard_error: proposal.pairedDeltaHacStandardError,
          paired_delta_lcb95_hac: proposal.pairedDeltaLcb95Hac,
          paired_delta_one_sided_p_value: proposal.pairedDeltaOneSidedPValue,
          paired_delta_power_at_minimum_economic_delta: proposal.pairedDeltaPowerAtMinimumEconomicDelta,
          candidate_absolute_effective_dates: proposal.candidateAbsoluteEffectiveDates,
          candidate_absolute_hac_standard_error: proposal.candidateAbsoluteHacStandardError,
          candidate_absolute_lcb95_hac: proposal.candidateAbsoluteLcb95Hac,
          minimum_economic_delta: MINIMUM_ECONOMIC_PAIRED_DELTA,
          holm_family_size: proposal.holmFamilySize,
          holm_rank: proposal.holmRank,
          holm_critical_alpha: proposal.holmCriticalAlpha,
          holm_adjusted_p_value: proposal.holmAdjustedPValue,
          holm_rejected: proposal.holmRejected,
          paired_delta_lcb90_column_is_legacy_iid_diagnostic: true,
          rejection_reasons: decisionStatus === 'accepted' ? [] : rejectionReasons,
          promotion_allowed: promotionAllowed,
          no_hard_top_k: true,
          replacement_scope: proposal.replacementScope,
          candidate_family_id: proposal.familyId,
          incumbent_family_id: proposal.incumbentFamilyId,
          cross_family_requires_full_portfolio_gates: true,
          outcome: 'sector_or_market_neutral_cost_net_return',
        }),
      )
    })

    if (status === 'promoted') {
      const cutoverStatements: D1PreparedStatement[] = [...replacementStatements]
      for (const proposal of replacement.accepted) {
        const [candidateId, candidateVersion] = proposal.candidateKey.split('|')
        const [incumbentId, incumbentVersion] = proposal.incumbentKey.split('|')
        cutoverStatements.push(db.prepare(`
          INSERT INTO strategy_replacement_cutover_guards_v5(
            guard_id, run_id, phase, precondition_ok, evidence_json
          )
          SELECT ?, ?, 'pre',
                 CASE WHEN EXISTS (
                   SELECT 1 FROM strategy_spec_registry
                    WHERE strategy_id=? AND version=? AND owner_type='strategy'
                      AND status IN ('shadow','candidate') AND promotion_status <> 'retired'
                 ) AND EXISTS (
                   SELECT 1 FROM strategy_spec_registry
                    WHERE strategy_id=? AND version=? AND owner_type='strategy'
                      AND status='active' AND promotion_status='production'
                 ) THEN 1 ELSE 0 END, ?
        `).bind(
          `strategy-replacement-guard-pre:${runId}:${candidateId}:${incumbentId}`,
          runId, candidateId, candidateVersion, incumbentId, incumbentVersion,
          JSON.stringify({ candidate: proposal.candidateKey, incumbent: proposal.incumbentKey }),
        ))
        cutoverStatements.push(db.prepare(`
          UPDATE strategy_spec_registry
             SET status='active', promotion_status='production', updated_at=CURRENT_TIMESTAMP
           WHERE strategy_id=? AND version=?
             AND owner_type='strategy'
             AND status IN ('shadow','candidate')
             AND promotion_status <> 'retired'
        `).bind(candidateId, candidateVersion))
        cutoverStatements.push(db.prepare(`
          UPDATE strategy_spec_registry
             SET status='candidate', promotion_status='candidate', updated_at=CURRENT_TIMESTAMP
           WHERE strategy_id=? AND version=?
             AND owner_type='strategy'
             AND status='active'
             AND promotion_status='production'
        `).bind(incumbentId, incumbentVersion))
        cutoverStatements.push(db.prepare(`
          INSERT INTO strategy_replacement_cutover_guards_v5(
            guard_id, run_id, phase, precondition_ok, evidence_json
          )
          SELECT ?, ?, 'post',
                 CASE WHEN EXISTS (
                   SELECT 1 FROM strategy_spec_registry
                    WHERE strategy_id=? AND version=? AND owner_type='strategy'
                      AND status='active' AND promotion_status='production'
                 ) AND EXISTS (
                   SELECT 1 FROM strategy_spec_registry
                    WHERE strategy_id=? AND version=? AND owner_type='strategy'
                      AND status='candidate' AND promotion_status='candidate'
                 ) THEN 1 ELSE 0 END, ?
        `).bind(
          `strategy-replacement-guard-post:${runId}:${candidateId}:${incumbentId}`,
          runId, candidateId, candidateVersion, incumbentId, incumbentVersion,
          JSON.stringify({ candidate: proposal.candidateKey, incumbent: proposal.incumbentKey }),
        ))
      }
      cutoverStatements.push(db.prepare(`
        INSERT INTO strategy_replacement_cutover_guards_v5(
          guard_id, run_id, phase, precondition_ok, evidence_json
        )
        SELECT ?, ?, 'portfolio_post',
               CASE WHEN (
                 SELECT COUNT(*) FROM strategy_spec_registry
                  WHERE owner_type='strategy' AND status='active' AND promotion_status='production'
               )=? THEN 1 ELSE 0 END, ?
      `).bind(
        `strategy-replacement-guard-portfolio:${runId}`, runId, registryActiveKeys.size,
        JSON.stringify({ expected_active_count: registryActiveKeys.size }),
      ))
      cutoverStatements.push(db.prepare(`
        INSERT INTO strategy_marginal_edge_head_v4(owner_key, run_id, previous_run_id, promoted_at)
        VALUES ('production', ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner_key) DO UPDATE SET
          run_id=excluded.run_id, previous_run_id=strategy_marginal_edge_head_v4.run_id,
          promoted_at=CURRENT_TIMESTAMP
      `).bind(runId, previousHead?.run_id ?? null))
      cutoverStatements.push(db.prepare(`
        INSERT INTO observability_events(
          event_id, date, severity, domain, source, status, title, summary,
          owner, impact, next_action, evidence, created_at
        )
        SELECT ?, ?, 'info', 'strategy', 'strategy_marginal_edge_v7', 'promoted',
               'Atomic strategy replacement promoted', ?, 'strategy-learning',
               'Production active count remains stable through edge-gated one-in-one-out replacement.',
               'Monitor date-clustered cost-net edge, risk and turnover parity.', ?, CURRENT_TIMESTAMP
         WHERE NOT EXISTS (
           SELECT 1 FROM observability_events WHERE event_id=? AND date=?
         )
      `).bind(
        `strategy-edge-v7-promotion:${runId}`,
        asOfDate,
        `replacements=${replacement.accepted.map((row) => row.candidateKey + '->' + row.incumbentKey).join(',')}`,
        JSON.stringify({
          schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
          statistical_policy_version: STRATEGY_REPLACEMENT_POLICY_VERSION_V7,
          run_id: runId,
          replacements: replacement.accepted,
          production_owner_count_before: registryActiveKeys.size,
          production_owner_count_after: replacement.finalWeights.size,
          paired_champion_delta_lcb95_hac: paired.lcb95Hac,
          effective_paired_dates: paired.effectiveDates,
          power_at_minimum_economic_delta: paired.powerAtMinimumEconomicDelta,
          final_portfolio_absolute_lcb95_hac: candidateAbsoluteConfidence.lcb95Hac,
          holm_family_size: replacement.holmFamilySize,
          no_hard_top_k: true,
        }),
        `strategy-edge-v7-promotion:${runId}`,
        asOfDate,
      ))
      await db.batch(cutoverStatements)
    } else if (replacementStatements.length) {
      for (let offset = 0; offset < replacementStatements.length; offset += 100) {
        await db.batch(replacementStatements.slice(offset, offset + 100))
      }
    }
  } catch (error) {
    await db.prepare(`
      UPDATE strategy_marginal_edge_runs_v4
         SET status='failed', error_code=? WHERE run_id=?
    `).bind(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), runId).run().catch(() => {})
    throw error
  }
  return { runId, status, sampleDates, eligibleStrategies: eligible.length }
}

export async function loadPromotedStrategyMarginalEdgeWeightsV4(
  db: D1Database,
  strategyIds: string[],
): Promise<{ runId: string | null; weights: Record<string, number> } | null> {
  const head = await db.prepare(`
    SELECT h.run_id
      FROM strategy_marginal_edge_head_v4 h
      JOIN strategy_marginal_edge_runs_v4 r ON r.run_id=h.run_id AND r.status='promoted'
     WHERE h.owner_key='production'
  `).first<{ run_id?: string }>()
  if (!head?.run_id) return null
  const rows = await db.prepare(`
    SELECT strategy_id, production_weight_raw
      FROM strategy_marginal_edge_v4
     WHERE run_id=?
  `).bind(head.run_id).all<{ strategy_id: string; production_weight_raw: number | string }>()
  const raw = new Map<string, number>()
  for (const row of rows.results ?? []) {
    raw.set(row.strategy_id, (raw.get(row.strategy_id) ?? 0) + Math.max(0, Number(row.production_weight_raw) || 0))
  }
  const total = [...raw.values()].reduce((sum, value) => sum + value, 0)
  const weights = Object.fromEntries(strategyIds.map((id) => [id, total > 0 ? (raw.get(id) ?? 0) / total : 0]))
  return { runId: head.run_id, weights }
}
