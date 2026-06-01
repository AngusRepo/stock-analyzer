export interface ScreenerFunnelRow {
  symbol: string
  stage: string
  decision: string
  reason_code?: string | null
  score_before?: number | null
  score_after?: number | null
  rank?: number | null
  evidence?: unknown
}

export interface ScreenerFunnelStep {
  stage: string
  decision: string
  reason_code: string | null
  score_before: number | null
  score_after: number | null
  rank: number | null
  evidence: Record<string, unknown>
}

export interface ScreenerFunnelSummary {
  rank: number | null
  reason_code: string | null
  evidence: Record<string, unknown>
  timeline: ScreenerFunnelStep[]
}

function parseEvidence(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toNullableNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function pickLastByStage(steps: ScreenerFunnelStep[], stage: string): ScreenerFunnelStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].stage === stage) return steps[i]
  }
  return null
}

function pickAllByStage(steps: ScreenerFunnelStep[], stage: string): ScreenerFunnelStep[] {
  return steps.filter((step) => step.stage === stage)
}

function pickCandidateSeedStep(steps: ScreenerFunnelStep[]): ScreenerFunnelStep | null {
  return pickLastByStage(steps, 'l1_candidate_seed_after_overlay') ?? pickLastByStage(steps, 'final_selection')
}

function summarizeEvidence(steps: ScreenerFunnelStep[]): Record<string, unknown> {
  const finalSelection = pickLastByStage(steps, 'final_selection')
  const candidateSeed = pickCandidateSeedStep(steps)
  const layer1 = pickLastByStage(steps, 'layer1_strategy_breadth_gate')
  const layer2 = pickLastByStage(steps, 'layer2_coarse_ml_gate')
  const rrg = pickLastByStage(steps, 'rrg_overlay')
  const buzz = pickLastByStage(steps, 'buzz_evidence')
  const strategyPool = [
    ...pickAllByStage(steps, 'strategy_pool_ml_queue'),
    ...pickAllByStage(steps, 'strategy_pool_research_only'),
  ]
  const diversity = pickAllByStage(steps, 'diversity_cooldown')
  const scoring = pickLastByStage(steps, 'scoring')

  const evidence: Record<string, unknown> = {
    ...(candidateSeed?.evidence ?? {}),
    source_of_truth: 'screener_funnel_items',
    decision_path: steps.map((step) => ({
      stage: step.stage,
      decision: step.decision,
      reason_code: step.reason_code,
      score_before: step.score_before,
      score_after: step.score_after,
      rank: step.rank,
    })),
  }

  if (scoring) evidence.base_scoring = scoring.evidence
  if (layer1) evidence.layer1_breadth = { reason_code: layer1.reason_code, rank: layer1.rank, score_after: layer1.score_after, ...layer1.evidence }
  if (layer2) evidence.layer2_coarse_ml = { reason_code: layer2.reason_code, rank: layer2.rank, score_after: layer2.score_after, ...layer2.evidence }
  if (rrg) evidence.rrg_overlay = { reason_code: rrg.reason_code, ...rrg.evidence }
  if (buzz) evidence.buzz_evidence = { reason_code: buzz.reason_code, ...buzz.evidence }
  if (strategyPool.length) {
    evidence.strategy_pool = strategyPool.map((step) => ({
      stage: step.stage,
      decision: step.decision,
      reason_code: step.reason_code,
      score_after: step.score_after,
      rank: step.rank,
      ...step.evidence,
    }))
    evidence.strategy_ids = [
      ...new Set(strategyPool.flatMap((step) => {
        const ids = step.evidence?.strategy_ids
      return Array.isArray(ids) ? ids.map(String) : []
      })),
    ]
  } else {
    const finalStrategyIds = candidateSeed?.evidence?.strategy_pool_ids ?? finalSelection?.evidence?.strategy_pool_ids
    if (Array.isArray(finalStrategyIds) && finalStrategyIds.length) {
      evidence.strategy_ids = [...new Set(finalStrategyIds.map(String).filter(Boolean))]
    }
  }
  if (diversity.length) {
    evidence.diversity_cooldown = diversity.map((step) => ({
      reason_code: step.reason_code,
      score_before: step.score_before,
      score_after: step.score_after,
      ...step.evidence,
    }))
  }

  return evidence
}

export function summarizeScreenerFunnelRows(rows: ScreenerFunnelRow[]): Map<string, ScreenerFunnelSummary> {
  const grouped = new Map<string, ScreenerFunnelStep[]>()
  for (const row of rows) {
    const symbol = normalizeSymbol(row.symbol)
    if (!symbol) continue
    const step: ScreenerFunnelStep = {
      stage: String(row.stage ?? ''),
      decision: String(row.decision ?? ''),
      reason_code: row.reason_code ?? null,
      score_before: toNullableNumber(row.score_before),
      score_after: toNullableNumber(row.score_after),
      rank: toNullableNumber(row.rank),
      evidence: parseEvidence(row.evidence),
    }
    const steps = grouped.get(symbol)
    if (steps) steps.push(step)
    else grouped.set(symbol, [step])
  }

  const summaries = new Map<string, ScreenerFunnelSummary>()
  for (const [symbol, steps] of grouped) {
    const candidateSeed = pickCandidateSeedStep(steps)
    summaries.set(symbol, {
      rank: candidateSeed?.rank ?? null,
      reason_code: candidateSeed?.reason_code ?? null,
      evidence: summarizeEvidence(steps),
      timeline: steps,
    })
  }
  return summaries
}
