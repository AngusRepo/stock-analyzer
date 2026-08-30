import type { Bindings } from '../types'

export const PIT_RESIDUAL_SHADOW_APPLICATION_MODE = 'shadow_pre_l2_candidate_rank_feature_only' as const
export const PIT_RESIDUAL_SHADOW_WEIGHT = 0.10 as const
export const PIT_RESIDUAL_PRIMARY_HORIZON_SESSIONS = 10 as const
export const PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED = false as const
export const PIT_RESIDUAL_DEBATE_VISIBILITY = false as const

const QUERY_CHUNK_SIZE = 80

export interface PitResidualShadowRow {
  signalDate: string
  symbol: string
  industry: string
  residualMomentumRank: number
  breadthRank: number | null
  flowDiffusionRank: number | null
  researchBaseScore: number
  researchShadowScore: number
  factorContractVersion: string
  taxonomySnapshotDate: string
  taxonomyChecksum: string
}

export interface PitResidualShadowSnapshot {
  signalDate: string | null
  rows: PitResidualShadowRow[]
}

export interface PitResidualCandidateInput {
  symbol: string
  score: number
}

export interface PitResidualCounterfactual {
  symbol: string
  signalDate: string
  industry: string
  productionBasePercentile: number
  residualMomentumRank: number
  productionShadowScore: number
  productionRank: number
  shadowRank: number
  rankDelta: number
  breadthRank: number | null
  flowDiffusionRank: number | null
  diagnosticConfirmationRank: number | null
  researchBaseScore: number
  researchShadowScore: number
  factorContractVersion: string
  taxonomySnapshotDate: string
  taxonomyChecksum: string
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unitInterval(value: unknown): number | null {
  const parsed = finite(value)
  return parsed != null && parsed >= 0 && parsed <= 1 ? parsed : null
}

export function requireLearningShadowDatabase(
  env: Pick<Bindings, 'LEARNING_DB'>,
): D1Database {
  if (!env.LEARNING_DB) throw new Error('pit_residual_learning_db_binding_required')
  return env.LEARNING_DB
}

export async function loadPitResidualShadowSnapshot(
  db: D1Database,
  symbols: string[],
  asOfDate: string,
): Promise<PitResidualShadowSnapshot> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error(`pit_residual_invalid_as_of_date:${asOfDate}`)
  }
  const uniqueSymbols = [...new Set(symbols.map((value) => String(value || '').trim()).filter(Boolean))]
  if (!uniqueSymbols.length) return { signalDate: null, rows: [] }
  const latest = await db.prepare(
    `SELECT MAX(signal_date) AS signal_date
       FROM pit_factor_shadow_daily_v1
      WHERE signal_date <= ?`,
  ).bind(asOfDate).first<{ signal_date?: string | null }>()
  const signalDate = String(latest?.signal_date || '').trim()
  if (!signalDate) return { signalDate: null, rows: [] }

  const rows: PitResidualShadowRow[] = []
  for (let index = 0; index < uniqueSymbols.length; index += QUERY_CHUNK_SIZE) {
    const chunk = uniqueSymbols.slice(index, index + QUERY_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT signal_date, symbol, industry, residual_momentum_rank,
              breadth_rank, flow_diffusion_rank, research_base_score,
              research_shadow_score, factor_contract_version,
              taxonomy_snapshot_date, taxonomy_checksum,
              residual_weight, primary_horizon_sessions, decision_effect
         FROM pit_factor_shadow_daily_v1
        WHERE signal_date = ?
          AND symbol IN (${placeholders})
          AND residual_weight = 0.10
          AND primary_horizon_sessions = 10
          AND decision_effect = 'none'
        ORDER BY symbol`,
    ).bind(signalDate, ...chunk).all<Record<string, unknown>>()
    for (const row of results ?? []) {
      const symbol = String(row.symbol || '').trim()
      const residualMomentumRank = unitInterval(row.residual_momentum_rank)
      const researchBaseScore = finite(row.research_base_score)
      const researchShadowScore = finite(row.research_shadow_score)
      if (!symbol || residualMomentumRank == null || researchBaseScore == null || researchShadowScore == null) continue
      rows.push({
        signalDate: String(row.signal_date || signalDate),
        symbol,
        industry: String(row.industry || '').trim(),
        residualMomentumRank,
        breadthRank: unitInterval(row.breadth_rank),
        flowDiffusionRank: unitInterval(row.flow_diffusion_rank),
        researchBaseScore,
        researchShadowScore,
        factorContractVersion: String(row.factor_contract_version || ''),
        taxonomySnapshotDate: String(row.taxonomy_snapshot_date || ''),
        taxonomyChecksum: String(row.taxonomy_checksum || ''),
      })
    }
  }
  return { signalDate, rows }
}

function percentileRanks(values: Array<{ symbol: string; value: number }>): Map<string, number> {
  const sorted = [...values].sort((left, right) => left.value - right.value || left.symbol.localeCompare(right.symbol))
  const ranks = new Map<string, number>()
  let index = 0
  while (index < sorted.length) {
    let stop = index + 1
    while (stop < sorted.length && sorted[stop].value === sorted[index].value) stop += 1
    const averageRank = ((index + 1) + stop) / 2
    const percentile = averageRank / sorted.length
    for (let cursor = index; cursor < stop; cursor += 1) {
      ranks.set(sorted[cursor].symbol, percentile)
    }
    index = stop
  }
  return ranks
}

function descendingRanks(values: Array<{ symbol: string; value: number }>): Map<string, number> {
  return new Map(
    [...values]
      .sort((left, right) => right.value - left.value || left.symbol.localeCompare(right.symbol))
      .map((item, index) => [item.symbol, index + 1]),
  )
}

export function buildPitResidualCounterfactuals(
  candidates: PitResidualCandidateInput[],
  snapshot: PitResidualShadowSnapshot,
): PitResidualCounterfactual[] {
  if (!snapshot.signalDate || !snapshot.rows.length) return []
  const rowBySymbol = new Map(snapshot.rows.map((row) => [row.symbol, row]))
  const mapped = candidates
    .map((candidate) => ({
      symbol: String(candidate.symbol || '').trim(),
      score: finite(candidate.score),
    }))
    .filter((candidate): candidate is { symbol: string; score: number } =>
      Boolean(candidate.symbol && candidate.score != null && rowBySymbol.has(candidate.symbol)),
    )
  if (!mapped.length) return []
  const basePercentiles = percentileRanks(mapped.map((item) => ({ symbol: item.symbol, value: item.score })))
  const productionRanks = descendingRanks(mapped.map((item) => ({ symbol: item.symbol, value: item.score })))
  const shadowValues = mapped.map((item) => {
    const row = rowBySymbol.get(item.symbol)!
    const basePercentile = basePercentiles.get(item.symbol)!
    return {
      symbol: item.symbol,
      value: (1 - PIT_RESIDUAL_SHADOW_WEIGHT) * basePercentile
        + PIT_RESIDUAL_SHADOW_WEIGHT * row.residualMomentumRank,
    }
  })
  const shadowRanks = descendingRanks(shadowValues)
  const shadowBySymbol = new Map(shadowValues.map((item) => [item.symbol, item.value]))
  return mapped.map((item) => {
    const row = rowBySymbol.get(item.symbol)!
    const diagnostics = [row.breadthRank, row.flowDiffusionRank].filter(
      (value): value is number => value != null,
    )
    const productionRank = productionRanks.get(item.symbol)!
    const shadowRank = shadowRanks.get(item.symbol)!
    return {
      symbol: item.symbol,
      signalDate: snapshot.signalDate!,
      industry: row.industry,
      productionBasePercentile: basePercentiles.get(item.symbol)!,
      residualMomentumRank: row.residualMomentumRank,
      productionShadowScore: shadowBySymbol.get(item.symbol)!,
      productionRank,
      shadowRank,
      rankDelta: productionRank - shadowRank,
      breadthRank: row.breadthRank,
      flowDiffusionRank: row.flowDiffusionRank,
      diagnosticConfirmationRank: diagnostics.length
        ? diagnostics.reduce((total, value) => total + value, 0) / diagnostics.length
        : null,
      researchBaseScore: row.researchBaseScore,
      researchShadowScore: row.researchShadowScore,
      factorContractVersion: row.factorContractVersion,
      taxonomySnapshotDate: row.taxonomySnapshotDate,
      taxonomyChecksum: row.taxonomyChecksum,
    }
  })
}

