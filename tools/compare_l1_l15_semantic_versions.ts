import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyFinLabStyleFactorNormalization } from '../worker/src/lib/marketScreener'
import {
  buildMultiStrategyPleRoutingPlan,
  type MultiStrategyPleAnnotatedCandidate,
} from '../worker/src/lib/multiStrategyPleRouter'
import { registryRowToStrategySpec } from '../worker/src/lib/strategyLearning'
import type { StrategyCandidatePoolCandidate } from '../worker/src/lib/strategyCandidatePool'
import type {
  StrategyFeatureRefTerm,
  StrategyRawSignals,
  StrategySpec,
} from '../worker/src/lib/strategySpec'

const LEARNING_DB = 'stockvision-learning-db'
const OPS_DB = 'stockvision-ops-db'
const OUT_DIR = join('output', 'l1_l15_route_repair_comparison')
const WRANGLER_CLI = join('worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const REFERENCE_CONTRACT = 'selection-reference-snapshot-v3'
const FORMAL_LABELERS = [
  'strategy-labeler-v2-revenue-pit-fuse-v1',
  'strategy-decision-log-pit-reconstruction-v7-revenue-pit-fuse-v1',
]
const ALPHA_IDS = new Set([
  'alpha223_0009',
  'alpha223_0109',
  'alpha223_0166',
  'alpha223_0248',
  'alpha223_0283',
])
const CAPITAL_NORMALIZED_SIGNALS: Record<string, { rawSource: string; signal: string }> = {
  'finlab701_fundamental_features_\u71df\u904b\u8cc7\u91d1': {
    rawSource: 'workingCapital',
    signal: 'factorSignals.finlabSectorNeutralV2WorkingCapitalCapitalRank',
  },
  'finlab701_fundamental_features_\u81ea\u7531\u73fe\u91d1\u6d41\u91cf': {
    rawSource: 'freeCashFlow',
    signal: 'factorSignals.finlabSectorNeutralV2FreeCashFlowCapitalRank',
  },
  finlab701_fundamental_features_EBITDA: {
    rawSource: 'ebitda',
    signal: 'factorSignals.finlabSectorNeutralV2EbitdaCapitalRank',
  },
  'finlab701_financial_statement_\u975e\u6d41\u52d5\u8cc7\u7522': {
    rawSource: 'nonCurrentAssets',
    signal: 'factorSignals.finlabSectorNeutralV2NonCurrentAssetsCapitalRank',
  },
  'finlab701_financial_statement_\u672c\u671f\u73fe\u91d1\u53ca\u7d04\u7576\u73fe\u91d1\u589e\u52a0_\u6e1b\u5c11_\u6578': {
    rawSource: 'cashAndCashEquivalentsIncreaseDecrease',
    signal: 'factorSignals.finlabSectorNeutralV2CashAndCashEquivalentsIncreaseDecreaseCapitalRank',
  },
  'finlab701_financial_statement_\u5176\u4ed6\u61c9\u4ed8\u6b3e': {
    rawSource: 'otherPayables',
    signal: 'factorSignals.finlabSectorNeutralV2OtherPayablesCapitalRank',
  },
  'finlab701_financial_statement_\u6d41\u52d5\u8ca0\u50b5': {
    rawSource: 'currentLiabilities',
    signal: 'factorSignals.finlabSectorNeutralV2CurrentLiabilitiesCapitalRank',
  },
  'finlab701_financial_statement_\u4e0d\u52d5\u7522\u5ee0\u623f\u53ca\u8a2d\u5099': {
    rawSource: 'propertyPlantEquipment',
    signal: 'factorSignals.finlabSectorNeutralV2PropertyPlantEquipmentCapitalRank',
  },
  'finlab701_financial_statement_\u71df\u696d\u8cbb\u7528': {
    rawSource: 'operatingExpenses',
    signal: 'factorSignals.finlabSectorNeutralV2OperatingExpensesCapitalRank',
  },
  'finlab701_financial_statement_\u71df\u696d\u6d3b\u52d5\u4e4b\u6de8\u73fe\u91d1\u6d41\u5165_\u6d41\u51fa': {
    rawSource: 'operatingCashFlowStatement',
    signal: 'factorSignals.finlabSectorNeutralV2OperatingCashFlowStatementCapitalRank',
  },
  'finlab701_financial_statement_\u8ca1\u52d9\u6210\u672c': {
    rawSource: 'financialCost',
    signal: 'factorSignals.finlabSectorNeutralV2FinancialCostCapitalRank',
  },
}
const DIRECTIONAL_SIGNALS: Record<string, { rawSource: string; signal: string }> = {
  tech_gap_down: {
    rawSource: 'techGapDown',
    signal: 'factorSignals.finlabCsV2TechGapDownNoGapRank',
  },
}
const LOWER_IS_BETTER = new Set([
  'KLOW2',
  'KSFT',
  'vola_cv_90d',
  'tech_gap_down',
  'finlab701_financial_statement_\u5176\u4ed6\u61c9\u4ed8\u6b3e',
  'finlab701_financial_statement_\u6d41\u52d5\u8ca0\u50b5',
  'finlab701_financial_statement_\u71df\u696d\u8cbb\u7528',
  'finlab701_financial_statement_\u8ca1\u52d9\u6210\u672c',
])

function query(database: string, sql: string): Array<Record<string, any>> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync(
        process.execPath,
        [WRANGLER_CLI, 'd1', 'execute', database, '--remote', '--json', '--command', sql],
        { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, env: process.env, timeout: 60_000 },
      )
      const start = raw.indexOf('[')
      if (start < 0) throw new Error('d1_json_payload_missing:' + database)
      const payload = JSON.parse(raw.slice(start))
      if (!payload?.[0]?.success) throw new Error('d1_query_failed:' + database)
      if (Number(payload[0]?.meta?.rows_written ?? 0) !== 0 || Number(payload[0]?.meta?.changes ?? 0) !== 0) {
        throw new Error('read_only_contract_violated:' + database)
      }
      return payload[0].results ?? []
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function sqlText(value: unknown): string {
  return String(value ?? '').replaceAll("'", "''")
}

function finite(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function mean(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => value != null && Number.isFinite(value))
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null
}

function rank(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value)
  const output = Array(values.length).fill(0)
  for (let index = 0; index < indexed.length;) {
    let next = index + 1
    while (next < indexed.length && indexed[next].value === indexed[index].value) next += 1
    const averageRank = (index + next - 1) / 2
    for (let cursor = index; cursor < next; cursor += 1) output[indexed[cursor].index] = averageRank
    index = next
  }
  return output
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length < 3 || left.length !== right.length) return null
  const leftMean = mean(left)!
  const rightMean = mean(right)!
  let covariance = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean
    const rightDelta = right[index] - rightMean
    covariance += leftDelta * rightDelta
    leftVariance += leftDelta * leftDelta
    rightVariance += rightDelta * rightDelta
  }
  return leftVariance > 0 && rightVariance > 0
    ? covariance / Math.sqrt(leftVariance * rightVariance)
    : null
}

function spearman(rows: Array<Record<string, any>>, scoreKey: string): number | null {
  const clean = rows.filter((row) => finite(row[scoreKey]) != null && finite(row.residual_return_net) != null)
  return pearson(
    rank(clean.map((row) => Number(row[scoreKey]))),
    rank(clean.map((row) => Number(row.residual_return_net))),
  )
}

function quantileSpread(rows: Array<Record<string, any>>, scoreKey: string): Record<string, number | boolean | null> {
  const clean = rows
    .filter((row) => finite(row[scoreKey]) != null && finite(row.residual_return_net) != null)
    .sort((left, right) => Number(left[scoreKey]) - Number(right[scoreKey]))
  const width = Math.max(1, Math.floor(clean.length / 5))
  const lowMean = mean(clean.slice(0, width).map((row) => Number(row.residual_return_net)))
  const highMean = mean(clean.slice(-width).map((row) => Number(row.residual_return_net)))
  return {
    diagnostic_only_not_admission: true,
    low_quintile_mean: lowMean,
    high_quintile_mean: highMean,
    high_minus_low: lowMean == null || highMean == null ? null : highMean - lowMean,
  }
}

function effectiveBreadth(rows: Array<Record<string, any>>, scoreKey: string): Record<string, number | null> {
  const weights = rows
    .map((row) => finite(row[scoreKey]))
    .filter((value): value is number => value != null)
    .map((score) => clamp(0.75 + score / 200, 0.75, 1.25))
  const weightSum = weights.reduce((sum, value) => sum + value, 0)
  const squaredSum = weights.reduce((sum, value) => sum + value * value, 0)
  return {
    candidates_retained: weights.length,
    retention_rate: rows.length ? weights.length / rows.length : null,
    kish_effective_count: squaredSum > 0 ? (weightSum * weightSum) / squaredSum : null,
    kish_effective_share: squaredSum > 0 && rows.length ? ((weightSum * weightSum) / squaredSum) / rows.length : null,
    weight_min: weights.length ? Math.min(...weights) : null,
    weight_max: weights.length ? Math.max(...weights) : null,
  }
}

function summarize(rows: Array<Record<string, any>>, scoreKey: string): Record<string, any> {
  const dates = [...new Set(rows.map((row) => String(row.signal_date)))].sort()
  const perDate = dates.map((date) => {
    const cohort = rows.filter((row) => row.signal_date === date)
    return {
      date,
      samples: cohort.length,
      spearman: spearman(cohort, scoreKey),
      ...quantileSpread(cohort, scoreKey),
    }
  })
  const weighted = rows.map((row) => ({
    weight: clamp(0.75 + Number(row[scoreKey]) / 200, 0.75, 1.25),
    residual: Number(row.residual_return_net),
  }))
  const weightSum = weighted.reduce((sum, row) => sum + row.weight, 0)
  const dailySpearman = perDate.map((row) => finite(row.spearman))
  const sortedDaily = dailySpearman.filter((value): value is number => value != null).sort((left, right) => left - right)
  return {
    samples: rows.length,
    dates: dates.length,
    global_spearman: spearman(rows, scoreKey),
    mean_daily_spearman: mean(dailySpearman),
    median_daily_spearman: sortedDaily.length ? sortedDaily[Math.floor(sortedDaily.length / 2)] : null,
    positive_daily_spearman_dates: dailySpearman.filter((value) => value != null && value > 0).length,
    ...quantileSpread(rows, scoreKey),
    equal_weight_residual_mean: mean(rows.map((row) => Number(row.residual_return_net))),
    continuous_weight_residual_mean: weightSum > 0
      ? weighted.reduce((sum, row) => sum + row.weight * row.residual, 0) / weightSum
      : null,
    breadth: effectiveBreadth(rows, scoreKey),
    per_date: perDate,
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? '')) as T
  } catch {
    return fallback
  }
}

function strategyRow(row: Record<string, any>): StrategySpec {
  return registryRowToStrategySpec(row as any)
}

function semanticTerm(term: StrategyFeatureRefTerm): StrategyFeatureRefTerm {
  const capital = CAPITAL_NORMALIZED_SIGNALS[term.featureRef]
  const directional = DIRECTIONAL_SIGNALS[term.featureRef]
  const signal = capital?.signal ?? directional?.signal ?? term.signal
  return {
    ...term,
    signal,
    semantic: {
      schemaVersion: 'strategy-feature-semantic-v2',
      rawSource: capital?.rawSource ?? directional?.rawSource ?? term.featureRef,
      direction: LOWER_IS_BETTER.has(term.featureRef) ? 'lower_is_better' : 'higher_is_better',
      transform: capital
        ? 'capital_normalized_cross_sectional_percentile'
        : directional || signal.includes('finlabCs') || signal.includes('finlabSector')
          ? 'cross_sectional_percentile'
          : 'identity',
      denominator: capital ? 'capital_amount' : 'none',
      neutralization: capital || signal.includes('finlabSector') ? 'sector' : 'none',
      pitOwner: 'market',
      missingPolicy: 'fail_closed',
    },
  }
}

function semanticSpec(spec: StrategySpec): StrategySpec {
  if (!ALPHA_IDS.has(spec.id)) return spec
  const weighted = spec.thresholds.featureRefs?.weightedScore
  if (!weighted) throw new Error('alpha_weighted_score_missing:' + spec.id)
  return {
    ...spec,
    version: 'strategy-spec-v2',
    name: spec.name + ' semantic v2 replay',
    status: 'active',
    ownerType: 'strategy',
    promotionStatus: 'production',
    thresholds: {
      ...spec.thresholds,
      featureRefs: {
        ...spec.thresholds.featureRefs,
        weightedScore: {
          ...weighted,
          adaptivePolicy: undefined,
          calibration: undefined,
          terms: weighted.terms.map(semanticTerm),
        },
      },
    },
    riskNotes: [
      ...spec.riskNotes,
      'Research-only paired semantic replay; production_effect=false.',
    ],
  }
}

function hydrateReplayRawSignals(value: unknown): StrategyRawSignals {
  const raw = parseJson<StrategyRawSignals>(value, {})
  const factors = raw.factorSignals ?? {}
  for (const field of [
    'ebitda',
    'nonCurrentAssets',
    'cashAndCashEquivalentsIncreaseDecrease',
    'otherPayables',
    'currentLiabilities',
    'propertyPlantEquipment',
    'operatingExpenses',
    'operatingCashFlowStatement',
    'workingCapital',
    'freeCashFlow',
    'financialCost',
    'capitalAmount',
    'techGapDown',
  ] as const) {
    if ((raw as any)[field] == null && finite(factors[field]) != null) {
      ;(raw as any)[field] = Number(factors[field])
    }
  }
  if (raw.techGapDown == null && finite(raw.technicalIndicators?.tech_gap_down) != null) {
    raw.techGapDown = Number(raw.technicalIndicators!.tech_gap_down)
  }
  return raw
}

function candidateFromContext(row: Record<string, any>): StrategyCandidatePoolCandidate {
  const raw = hydrateReplayRawSignals(row.raw_signals_json)
  return {
    symbol: String(row.symbol),
    industry: row.industry == null ? undefined : String(row.industry),
    market_segment: row.market_segment == null ? null : String(row.market_segment),
    current_price: finite(row.current_price),
    score_v2: raw.score_v2,
    raw_signals: raw,
    eligible_for_ml: true,
    restricted: false,
  }
}

function bySymbol(rows: MultiStrategyPleAnnotatedCandidate[]): Map<string, MultiStrategyPleAnnotatedCandidate> {
  return new Map(rows.map((row) => [String(row.symbol).toUpperCase(), row]))
}

const heads = query(OPS_DB, [
  "SELECT substr(logical_run_key, 10, 10) signal_date, run_id",
  "FROM canonical_run_heads",
  "WHERE logical_run_key GLOB 'screener:????-??-??:TW:production:market_screener'",
  "ORDER BY signal_date",
].join(' '))
const canonical = Object.fromEntries(heads.map((row) => [String(row.signal_date), String(row.run_id)]))
const valuesSql = heads
  .map((row) => "('" + sqlText(row.signal_date) + "','" + sqlText(row.run_id) + "')")
  .join(',')
const routeDates = query(LEARNING_DB, [
  'WITH canonical(signal_date, run_id) AS (VALUES ' + valuesSql + ')',
  'SELECT DISTINCT r.signal_date',
  'FROM selection_reference_snapshots_v1 r',
  'JOIN canonical c ON c.signal_date=r.signal_date AND c.run_id=r.producer_run_id',
  'JOIN canonical_selection_labels_v4 l ON l.signal_date=r.signal_date AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id',
  "WHERE r.strategy_matrix_status='ready'",
  'AND r.strategy_router_score IS NOT NULL',
  'AND r.strategy_challenger_route_score IS NOT NULL',
  'ORDER BY r.signal_date',
].join(' ')).map((row) => String(row.signal_date))

const registryRows = query(LEARNING_DB, [
  'SELECT strategy_id, version, name, status, owner, alpha_bucket,',
  'family_id, variant_id, owner_type, promotion_status, supported_regimes_json,',
  'thesis, thresholds_json, candidate_policy_json, risk_notes_json,',
  'source_refs_json, created_by, created_at, updated_at',
  'FROM strategy_spec_registry',
  "WHERE status <> 'retired'",
  'ORDER BY strategy_id, version',
].join(' '))
const incumbentSpecs = registryRows.map(strategyRow)
void semanticSpec
const rows: Array<Record<string, any>> = []
const versionedEvidenceRows: Array<Record<string, any>> = []
const replayDiagnostics: Array<Record<string, any>> = []

for (const signalDate of routeDates) {
  const runId = canonical[signalDate]
  const contexts = query(LEARNING_DB, [
    'WITH latest_context AS (',
    'SELECT symbol, MAX(context_id) context_id',
    'FROM strategy_decision_log',
    "WHERE date='" + sqlText(signalDate) + "'",
    'GROUP BY symbol',
    ')',
    'SELECT d.symbol,c.raw_signals_json,c.current_price,c.industry,r.market_segment,',
    'r.strategy_router_score,r.strategy_challenger_route_score',
    'FROM latest_context d',
    'JOIN strategy_candidate_contexts c ON c.context_id=d.context_id',
    'JOIN selection_reference_snapshots_v1 r ON r.signal_date=' + "'" + sqlText(signalDate) + "'",
    'AND r.producer_run_id=' + "'" + sqlText(runId) + "'",
    'AND r.symbol=d.symbol',
    "WHERE r.strategy_matrix_status='ready'",
    'AND r.strategy_router_score IS NOT NULL',
    'AND r.strategy_challenger_route_score IS NOT NULL',
    'ORDER BY d.symbol',
  ].join(' '))
  const candidates = contexts.map(candidateFromContext)
  applyFinLabStyleFactorNormalization(candidates.map((candidate) => ({
    raw_signals: candidate.raw_signals as StrategyRawSignals,
    industry: candidate.industry,
  })))
  const replayOptions = {
    maxSlateSize: candidates.length,
    evidenceMode: 'historical_replay' as const,
    minRouteScore: 0,
  }
  const incumbentReplay = buildMultiStrategyPleRoutingPlan(candidates, incumbentSpecs, replayOptions)
  const repairedReplay = incumbentReplay
  const incumbentBySymbol = bySymbol(incumbentReplay.l0Annotated)
  const repairedBySymbol = incumbentBySymbol
  const routeEvidenceBySymbol = new Map<string, { v1Route: number; v2Route: number; repairedScore: number }>()
  for (const context of contexts) {
    const symbol = String(context.symbol).toUpperCase()
    const replay = incumbentBySymbol.get(symbol)
    const v1Route = finite(replay?.strategy_incumbent_route_score)
    const v2Route = finite(replay?.strategy_challenger_route_score)
    const productionIncumbent = finite(context.strategy_router_score)
    const accumulatedChallenger = finite(context.strategy_challenger_route_score)
    if (v1Route == null || v2Route == null || productionIncumbent == null || accumulatedChallenger == null) {
      throw new Error('full_reference_route_missing:' + signalDate + ':' + symbol)
    }
    const repairedScore = clamp(accumulatedChallenger + (v2Route - v1Route), 0, 100)
    routeEvidenceBySymbol.set(symbol, { v1Route, v2Route, repairedScore })
    versionedEvidenceRows.push({
      route_version: 'strategy-semantic-continuous-affinity-v4',
      signal_date: signalDate,
      symbol,
      producer_run_id: runId,
      route_score: repairedScore,
      incumbent_route_version: 'multi-strategy-ple-router-v1',
      incumbent_route_score: productionIncumbent,
      strategy_spec_version: 'strategy-spec-v2',
      evidence_method: 'deterministic_paired_pit_replay',
      source_reference_contract: REFERENCE_CONTRACT,
    })
  }
  const labels = query(LEARNING_DB, [
    'SELECT r.signal_date,r.symbol,r.producer_run_id,r.strategy_selected,',
    'r.strategy_router_score incumbent_score,',
    'r.strategy_challenger_route_score accumulated_challenger_score,',
    'r.score_v2 production_seed_score,',
    'l.residual_return_net',
    'FROM selection_reference_snapshots_v1 r',
    'JOIN canonical_selection_labels_v4 l',
    'ON l.signal_date=r.signal_date AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id',
    "WHERE r.signal_date='" + sqlText(signalDate) + "'",
    "AND r.producer_run_id='" + sqlText(runId) + "'",
    "AND r.strategy_matrix_status='ready'",
    'AND r.strategy_router_score IS NOT NULL',
    'AND r.strategy_challenger_route_score IS NOT NULL',
    'ORDER BY r.symbol',
  ].join(' '))
  let matched = 0
  let deltaSum = 0
  let alphaV1Evaluable = 0
  let alphaV2Evaluable = 0
  for (const label of labels) {
    const symbol = String(label.symbol).toUpperCase()
    const v1 = incumbentBySymbol.get(symbol)
    const v2 = repairedBySymbol.get(symbol)
    const routeEvidence = routeEvidenceBySymbol.get(symbol)
    if (!v1 || !v2 || !routeEvidence) throw new Error('replay_symbol_missing:' + signalDate + ':' + symbol)
    const { v1Route, v2Route, repairedScore } = routeEvidence
    const pairedDelta = v2Route - v1Route
    const contextRankNeutralizationDelta = pairedDelta
    const v1Evaluable = [...ALPHA_IDS].filter((id) => v1.strategy_evaluable_vector?.[id] === 1).length
    const v2Evaluable = [...ALPHA_IDS].filter((id) => v2.strategy_challenger_evaluable_vector?.[id] === 1).length
    alphaV1Evaluable += v1Evaluable
    alphaV2Evaluable += v2Evaluable
    matched += 1
    deltaSum += pairedDelta
    const diagnosticRow: Record<string, any> = {
      ...label,
      local_incumbent_spec_replay_score: v1Route,
      local_semantic_v2_replay_score: v2Route,
      paired_semantic_delta: pairedDelta,
      context_rank_neutralization_delta: contextRankNeutralizationDelta,
      repaired_semantic_v2_score: repairedScore,
      v1_alpha_evaluable_count: v1Evaluable,
      v2_alpha_evaluable_count: v2Evaluable,
      v1_raw_signal_quality: v1.strategy_router_components?.raw_signal_quality ?? null,
      v2_raw_signal_quality: v2.strategy_router_components?.raw_signal_quality ?? null,
      v1_risk_adjusted_affinity: v1.strategy_router_components?.challenger_risk_adjusted_affinity ?? null,
      v2_risk_adjusted_affinity: v2.strategy_router_components?.challenger_risk_adjusted_affinity ?? null,
      v1_diversity: v1.strategy_router_components?.diversity_contribution ?? null,
      v2_diversity: v2.strategy_router_components?.diversity_contribution ?? null,
      v1_uncertainty: v1.strategy_router_components?.challenger_uncertainty ?? null,
      v2_uncertainty: v2.strategy_router_components?.challenger_uncertainty ?? null,
      v1_market_heat: v1.strategy_router_components?.market_heat_score ?? null,
      v2_market_heat: v2.strategy_router_components?.market_heat_score ?? null,
    }
    for (const strategyId of ALPHA_IDS) {
      diagnosticRow['v1_affinity_' + strategyId] = v1.strategy_incumbent_threshold_affinity_vector?.[strategyId] ?? null
      diagnosticRow['v2_affinity_' + strategyId] = v2.strategy_challenger_affinity_vector?.[strategyId] ?? null
      diagnosticRow['v1_hit_' + strategyId] = v1.strategy_hit_vector?.[strategyId] ?? null
      diagnosticRow['v2_hit_' + strategyId] = v2.strategy_challenger_hit_vector?.[strategyId] ?? null
    }
    rows.push(diagnosticRow)
  }
  replayDiagnostics.push({
    signal_date: signalDate,
    candidates: candidates.length,
    labels: labels.length,
    paired_symbols: matched,
    mean_route_delta: matched ? deltaSum / matched : null,
    alpha_v1_evaluable_cells: alphaV1Evaluable,
    alpha_v2_evaluable_cells: alphaV2Evaluable,
    alpha_v2_evaluable_ratio: matched ? alphaV2Evaluable / (matched * ALPHA_IDS.size) : null,
    incumbent_replay_retained: incumbentReplay.mlSlate.length,
    repaired_replay_retained: repairedReplay.mlSlate.length,
  })
}

const formal = summarize(rows, 'incumbent_score')
const accumulated = summarize(rows, 'accumulated_challenger_score')
const repaired = summarize(rows, 'repaired_semantic_v2_score')
const componentKeys = [
  'production_seed_score',
  'local_incumbent_spec_replay_score',
  'local_semantic_v2_replay_score',
  'paired_semantic_delta',
  'context_rank_neutralization_delta',
  'v1_raw_signal_quality',
  'v2_raw_signal_quality',
  'v1_risk_adjusted_affinity',
  'v2_risk_adjusted_affinity',
  'v1_diversity',
  'v2_diversity',
  'v1_uncertainty',
  'v2_uncertainty',
  'v1_market_heat',
  'v2_market_heat',
]
const componentDiagnostics = Object.fromEntries(
  componentKeys.map((key) => [key, summarize(rows, key)]),
)
const strategyDiagnostics = Object.fromEntries([...ALPHA_IDS].sort().map((strategyId) => [
  strategyId,
  {
    incumbent_affinity: summarize(rows, 'v1_affinity_' + strategyId),
    semantic_v2_affinity: summarize(rows, 'v2_affinity_' + strategyId),
    incumbent_hit_rate: mean(rows.map((row) => finite(row['v1_hit_' + strategyId]))),
    semantic_v2_hit_rate: mean(rows.map((row) => finite(row['v2_hit_' + strategyId]))),
  },
]))
const sourceContextCount = replayDiagnostics.reduce((sum, row) => sum + row.candidates, 0)
const incumbentStrategyHitCount = replayDiagnostics.reduce((sum, row) => sum + row.incumbent_replay_retained, 0)
const repairedStrategyHitCount = replayDiagnostics.reduce((sum, row) => sum + row.repaired_replay_retained, 0)
const report = {
  generated_at: new Date().toISOString(),
  contract: 'l1-l15-same-canonical-ready-mature-semantic-paired-comparison-v3',
  production_effect: false,
  selection_semantics: 'full_universe_continuous_positive_weights_no_topk_admission',
  quantiles_are_diagnostic_only: true,
  compared_dates: routeDates,
  compared_samples: rows.length,
  runtime_strategy_match_breadth: {
    source_context_count: sourceContextCount,
    paired_mature_label_count: rows.length,
    incumbent_active_strategy_hit_count: incumbentStrategyHitCount,
    repaired_active_strategy_hit_count: repairedStrategyHitCount,
    incumbent_hit_share_of_context: sourceContextCount > 0 ? incumbentStrategyHitCount / sourceContextCount : null,
    repaired_hit_share_of_context: sourceContextCount > 0 ? repairedStrategyHitCount / sourceContextCount : null,
    hit_share_delta: sourceContextCount > 0 ? (repairedStrategyHitCount - incumbentStrategyHitCount) / sourceContextCount : null,
    post_match_topk_admission: false,
  },
  strategy_spec_change: {
    alpha_strategy_ids: [...ALPHA_IDS].sort(),
    incumbent_version: 'strategy-spec-v1',
    repaired_version: 'strategy-spec-v2',
    semantic_changes: [
      'capital_normalization',
      'sector_neutralization',
      'explicit_factor_direction',
      'tech_gap_down_lower_is_better_versioned_signal',
      'immutable_missing_fail_closed',
      'l1_context_diagnostic_not_expected_return_rank_owner',
    ],
  },
  versions: {
    formal_incumbent_v1: formal,
    accumulated_challenger_v2: accumulated,
    repaired_semantic_context_neutral_v4: repaired,
  },
  component_diagnostics: componentDiagnostics,
  strategy_diagnostics: strategyDiagnostics,
  improvement_vs_accumulated: {
    global_spearman_delta: finite(repaired.global_spearman) != null && finite(accumulated.global_spearman) != null
      ? repaired.global_spearman - accumulated.global_spearman
      : null,
    mean_daily_spearman_delta: finite(repaired.mean_daily_spearman) != null && finite(accumulated.mean_daily_spearman) != null
      ? repaired.mean_daily_spearman - accumulated.mean_daily_spearman
      : null,
    high_minus_low_delta: finite(repaired.high_minus_low) != null && finite(accumulated.high_minus_low) != null
      ? repaired.high_minus_low - accumulated.high_minus_low
      : null,
    negative_ranking_resolved: finite(repaired.global_spearman) != null
      && repaired.global_spearman > 0
      && finite(repaired.high_minus_low) != null
      && repaired.high_minus_low > 0
      && repaired.positive_daily_spearman_dates >= Math.ceil(routeDates.length * 0.6),
  },
  replay: {
    method: 'production_v4_paired_delta_replay',
    formula: 'production_accumulated_challenger_v2 + (runtime_semantic_v4 - runtime_incumbent_v1)',
    local_router_contract: 'same production buildMultiStrategyPleRoutingPlan emits paired v1 incumbent and semantic-v2/context-neutral v4 challenger from identical candidates/options',
    pit_contract: 'immutable strategy_candidate_contexts + canonical ready mature labels; no future outcomes used to construct scores',
    context_raw_fallback: 'immutable factorSignals raw fields only',
    diagnostics: replayDiagnostics,
  },
}
mkdirSync(OUT_DIR, { recursive: true })
const outputPath = join(OUT_DIR, 'semantic_v2_comparison.json')
const evidencePath = join(OUT_DIR, 'semantic_v4_evidence_rows.json')
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
writeFileSync(evidencePath, JSON.stringify(versionedEvidenceRows, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({
  outputPath,
  evidencePath,
  compared_samples: rows.length,
  compared_dates: routeDates.length,
  evidence_rows: versionedEvidenceRows.length,
  versions: report.versions,
  improvement_vs_accumulated: report.improvement_vs_accumulated,
  replay_diagnostics: replayDiagnostics,
}, null, 2))
