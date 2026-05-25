import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'
import { readScoreV2Snapshot, type ScoreV2StorageRow } from './scoreV2Taxonomy'

export type Breeze2Trigger = 'morning_debate' | 'screener_enrichment'

export interface Breeze2CandidateLike {
  symbol?: unknown
  name?: unknown
  stock_name?: unknown
  score_v2?: unknown
  rank?: unknown
  reason?: unknown
  watch_points?: unknown
  strategy_watch_points?: unknown
  recommendation_lane?: unknown
  major_event?: unknown
  theme?: Record<string, unknown>
  news?: Record<string, unknown> | Array<Record<string, unknown>>
  evidence_items?: Array<Record<string, unknown>>
}

export interface Breeze2FactCheckRequest {
  symbol: string
  stock_name?: string
  trigger: Breeze2Trigger
  reason: string
  theme: Record<string, unknown>
  news: Record<string, unknown> | Array<Record<string, unknown>>
  evidence_items: Array<Record<string, unknown>>
  metadata: Record<string, unknown>
  execute_modal: boolean
  mutation_allowed: false
  real_trading_allowed: false
}

export type Breeze2Report = Record<string, any>

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeScore(score: unknown): number {
  const value = asNumber(score, 0)
  return value > 1 ? Math.min(1, value / 100) : Math.max(0, Math.min(1, value))
}

function scoreSnapshot(candidate: Breeze2CandidateLike) {
  return readScoreV2Snapshot({ score_components: candidate.score_v2 } as ScoreV2StorageRow)
}

function candidateScore(candidate: Breeze2CandidateLike): number {
  return scoreSnapshot(candidate)?.finalScore ?? 0
}

function normalizeCandidateScore(candidate: Breeze2CandidateLike): number {
  return normalizeScore(candidateScore(candidate))
}

function collectWatchPoints(candidate: Breeze2CandidateLike): string[] {
  return [
    ...(Array.isArray(candidate.watch_points) ? candidate.watch_points : []),
    ...(Array.isArray(candidate.strategy_watch_points) ? candidate.strategy_watch_points : []),
  ].map(String).filter(Boolean)
}

function inferTheme(candidate: Breeze2CandidateLike): Record<string, unknown> {
  const explicit = candidate.theme && typeof candidate.theme === 'object' ? candidate.theme : {}
  const score = normalizeCandidateScore(candidate)
  const points = collectWatchPoints(candidate)
  const hasBuzz = points.some((point) => point.includes('buzz_evidence'))
  const hasRrg = points.some((point) => point.includes('rrg_overlay'))
  return {
    theme_score: explicit.theme_score ?? (hasRrg || hasBuzz ? Math.max(score, 0.72) : score),
    fact_support: explicit.fact_support ?? (hasBuzz && !hasRrg ? 0.48 : 0.55),
    hype_risk: explicit.hype_risk ?? (hasBuzz ? 0.62 : 0.35),
    name: explicit.name ?? points.find((point) => point.includes('buzz_evidence')) ?? undefined,
  }
}

function priority(candidate: Breeze2CandidateLike): number {
  const theme = inferTheme(candidate)
  const score = normalizeCandidateScore(candidate)
  const themeScore = asNumber(theme.theme_score, 0)
  const factSupport = asNumber(theme.fact_support, 1)
  const hypeRisk = asNumber(theme.hype_risk, 0)
  return (0.30 * score) + (0.30 * themeScore) + (0.25 * Math.max(0, 1 - factSupport)) + (0.15 * hypeRisk)
}

export function shouldRequestBreeze2(candidate: Breeze2CandidateLike): boolean {
  const score = normalizeCandidateScore(candidate)
  const theme = inferTheme(candidate)
  const themeScore = asNumber(theme.theme_score, 0)
  const factSupport = asNumber(theme.fact_support, 1)
  const hypeRisk = asNumber(theme.hype_risk, 0)
  return score >= 0.70 && (
    (themeScore >= 0.75 && factSupport <= 0.60)
    || hypeRisk >= 0.70
    || Boolean(candidate.major_event)
  )
}

export function selectBreeze2ScreenerCandidates<T extends Breeze2CandidateLike>(
  candidates: T[],
  maxCandidates = 5,
): T[] {
  const limit = Math.max(0, Math.floor(maxCandidates || 0))
  if (limit <= 0) return []
  return candidates
    .filter((candidate) => Boolean(String(candidate.symbol ?? '').trim()) && shouldRequestBreeze2(candidate))
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, limit)
}

export function buildBreeze2FactCheckRequest(
  candidate: Breeze2CandidateLike,
  trigger: Breeze2Trigger,
  options: { executeModal?: boolean; runDate?: string; rank?: number } = {},
): Breeze2FactCheckRequest {
  const symbol = String(candidate.symbol ?? '').trim()
  const stockName = String(candidate.stock_name ?? candidate.name ?? symbol).trim()
  const points = collectWatchPoints(candidate)
  const score = scoreSnapshot(candidate)
  return {
    symbol,
    stock_name: stockName,
    trigger,
    reason: String(candidate.reason ?? (trigger === 'morning_debate' ? 'morning_debate_semantic_fact_check' : 'screener_shortlist_theme_validation')),
    theme: inferTheme(candidate),
    news: candidate.news ?? {},
    evidence_items: Array.isArray(candidate.evidence_items)
      ? candidate.evidence_items
      : points.map((point) => ({ source: 'stockvision_watch_point', snippet: point })),
    metadata: {
      run_date: options.runDate,
      rank: options.rank ?? candidate.rank,
      screener_score: score?.finalScore ?? 0,
      score_source: score?.source ?? 'missing_score_v2',
      recommendation_lane: candidate.recommendation_lane,
      source: 'stockvision_worker',
    },
    execute_modal: options.executeModal ?? true,
    mutation_allowed: false,
    real_trading_allowed: false,
  }
}

export function extractBreeze2WatchPoint(report: Breeze2Report | null | undefined): string | null {
  if (!report || typeof report !== 'object') return null
  const scores = report.scores && typeof report.scores === 'object' ? report.scores : {}
  const flags = Array.isArray(report.risk_flags) ? report.risk_flags.map(String).slice(0, 4).join(',') : ''
  return [
    `breeze2:${String(report.recommended_decision_context ?? 'unknown')}`,
    `fact=${scores.fact_support ?? 'n/a'}`,
    `hype=${scores.hype_risk ?? 'n/a'}`,
    `quality=${scores.source_quality ?? 'n/a'}`,
    flags ? `flags=${flags}` : '',
  ].filter(Boolean).join(' ')
}

function validReport(report: Breeze2Report): boolean {
  return report?.schema_version === 'breeze2-research-context-v1'
    && report.allowed_use === 'research_context_only'
    && report.decision_effect === 'advisory_only'
    && report.primary_candidate_source_allowed === false
}

export async function requestBreeze2FactCheck(
  env: Bindings,
  request: Breeze2FactCheckRequest,
  timeoutMs = 60_000,
): Promise<Breeze2Report | null> {
  if (!env.ML_CONTROLLER_URL || !request.symbol) return null
  try {
    const res = await controllerFetch(env, '/breeze2/fact_check', {
      method: 'POST',
      jsonBody: request,
      timeoutMs,
    })
    if (!res.ok) return null
    const report = await res.json() as Breeze2Report
    return validReport(report) ? report : null
  } catch (error) {
    console.warn('[Breeze2] fact check skipped:', error)
    return null
  }
}

export async function enrichScreenerCandidatesWithBreeze2<T extends Breeze2CandidateLike>(
  env: Bindings,
  candidates: T[],
  options: { runDate?: string; maxCandidates?: number; executeModal?: boolean } = {},
): Promise<Map<string, Breeze2Report>> {
  const selected = selectBreeze2ScreenerCandidates(candidates, options.maxCandidates ?? 5)
  const pairs = await Promise.all(selected.map(async (candidate, index) => {
    const request = buildBreeze2FactCheckRequest(candidate, 'screener_enrichment', {
      executeModal: options.executeModal ?? true,
      runDate: options.runDate,
      rank: index + 1,
    })
    const report = await requestBreeze2FactCheck(env, request)
    return [String(candidate.symbol ?? '').trim(), report] as const
  }))
  return new Map(pairs.filter((pair): pair is readonly [string, Breeze2Report] => Boolean(pair[0] && pair[1])))
}

export async function enrichMorningDebateCandidatesWithBreeze2<T extends Breeze2CandidateLike>(
  env: Bindings,
  candidates: T[],
  options: { runDate?: string; executeModal?: boolean } = {},
): Promise<Map<string, Breeze2Report>> {
  const pairs = await Promise.all(candidates.map(async (candidate, index) => {
    const request = buildBreeze2FactCheckRequest(candidate, 'morning_debate', {
      executeModal: options.executeModal ?? true,
      runDate: options.runDate,
      rank: index + 1,
    })
    const report = await requestBreeze2FactCheck(env, request)
    return [String(candidate.symbol ?? '').trim(), report] as const
  }))
  return new Map(pairs.filter((pair): pair is readonly [string, Breeze2Report] => Boolean(pair[0] && pair[1])))
}
