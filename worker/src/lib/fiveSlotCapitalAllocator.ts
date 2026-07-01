import type { ScoreV2SnapshotSummary } from './scoreV2Taxonomy'

export type FiveSlotAllocatorAction = 'buy' | 'add' | 'replace' | 'hold' | 'skip'

export interface FiveSlotAllocatorConfig {
  maxPositions: number
  maxPctOfPortfolio: number
  maxPctOfCash: number
  dailyBuyLimit: number
  minPositionValue: number
  swapThreshold?: number
  minReplacementWeakness?: number
}

export interface FiveSlotAllocatorAccount {
  cash: number
  totalPortfolio: number
  dailyRemaining: number
}

export interface FiveSlotMarketContext {
  marketRiskLevel?: string | null
  riskScore?: number | null
  marketOutlookUpsidePct?: number | null
  regimeFamily?: string | null
}

export interface FiveSlotHolding {
  symbol: string
  shares: number
  avgCost: number
  lastPrice?: number | null
  initialStop?: number | null
  trailingStop?: number | null
  highestSinceEntry?: number | null
  daysHeld?: number | null
  tp1Hit?: boolean | null
}

export interface FiveSlotCandidate {
  symbol: string
  confidence?: number | null
  score?: number | null
  score_v2?: Pick<ScoreV2SnapshotSummary, 'finalScore' | 'total'> | null
  riskPct?: number | null
}

export interface FiveSlotDecision {
  symbol: string
  action: FiveSlotAllocatorAction
  reason: string
  budgetCap: number
  targetPositionValue: number
  currentPositionValue: number
  targetExposure: number
  targetSlotValue: number
  confidenceMultiplier: number
  replaceSymbol?: string | null
  replaceWeaknessScore?: number | null
  replaceRequiredRank?: number | null
  candidateRank?: number | null
}

export interface FiveSlotCapitalPlan {
  targetExposure: number
  targetSlotValue: number
  decisions: Map<string, FiveSlotDecision>
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function normalizedRiskLevel(marketRiskLevel: string | null | undefined): string {
  const level = String(marketRiskLevel ?? 'unknown').toLowerCase()
  if (['black', 'halt', 'closed'].includes(level)) return 'black'
  if (['red', 'very_high', 'bear', 'bear_market'].includes(level)) return 'red'
  if (['orange', 'high', 'volatile'].includes(level)) return 'orange'
  if (['medium', 'yellow', 'sideways', 'neutral'].includes(level)) return 'yellow'
  if (['low', 'green', 'bull', 'bull_market', 'constructive'].includes(level)) return 'green'
  return 'unknown'
}

function impliedRiskScore(level: string): number {
  if (level === 'green') return 4
  if (level === 'yellow') return 34
  if (level === 'orange') return 58
  if (level === 'red') return 83
  if (level === 'black') return 100
  return 46
}

function regimeExposureAdjustment(regimeFamily: string | null | undefined): number {
  const family = String(regimeFamily ?? '').toLowerCase()
  if (family === 'bull') return 0.04
  if (family === 'sideways') return -0.01
  if (family === 'volatile') return -0.04
  if (family === 'bear') return -0.06
  return 0
}

function outlookExposureAdjustment(upsidePct: number | null | undefined): number {
  if (upsidePct == null || !Number.isFinite(upsidePct)) return 0
  if (upsidePct >= 6) return 0.05
  if (upsidePct >= 3) return 0.025
  if (upsidePct <= 0.5) return -0.08
  if (upsidePct <= 1.2) return -0.05
  return 0
}

export function inferFiveSlotTargetExposureFromContext(context: FiveSlotMarketContext): number {
  const level = normalizedRiskLevel(context.marketRiskLevel)
  if (level === 'black') return 0
  const rawRiskScore = finiteNumber(context.riskScore, impliedRiskScore(level))
  const riskScore = clamp(rawRiskScore, 0, 100)
  const continuousBase = 0.92 - riskScore * 0.008
  return round4(clamp(
    continuousBase +
      regimeExposureAdjustment(context.regimeFamily) +
      outlookExposureAdjustment(context.marketOutlookUpsidePct),
    0,
    0.95,
  ))
}

export function inferFiveSlotTargetExposure(marketRiskLevel: string | null | undefined): number {
  return inferFiveSlotTargetExposureFromContext({ marketRiskLevel })
}

export function fiveSlotConfidenceMultiplier(candidate: FiveSlotCandidate): number {
  const confidence = finiteNumber(candidate.confidence, 0.6)
  const score = scoreV2FinalScore(candidate)
  const confidenceLeg = clamp((confidence - 0.55) / 0.30, 0, 1)
  const scoreLeg = clamp((score - 55) / 30, 0, 1)
  return clamp(0.75 + (confidenceLeg * 0.35) + (scoreLeg * 0.15), 0.75, 1.25)
}

function scoreV2FinalScore(candidate: FiveSlotCandidate): number {
  const payload = candidate.score_v2
  if (!payload || typeof payload !== 'object') return finiteNumber(candidate.score, 0)
  return clamp(finiteNumber(payload.finalScore ?? payload.total, 0), 0, 100)
}

function holdingValue(holding: FiveSlotHolding): number {
  const price = finiteNumber(holding.lastPrice, finiteNumber(holding.avgCost, 0))
  return Math.max(0, finiteNumber(holding.shares, 0) * price)
}

function candidateRank(candidate: FiveSlotCandidate): number {
  const confidence = finiteNumber(candidate.confidence, 0.6)
  const score = scoreV2FinalScore(candidate)
  const riskPct = finiteNumber(candidate.riskPct, 0.01)
  return score + confidence * 20 + riskPct * 500
}

function stopDistancePct(holding: FiveSlotHolding): number | null {
  const lastPrice = finiteNumber(holding.lastPrice, finiteNumber(holding.avgCost, 0))
  const stop = Math.max(
    finiteNumber(holding.trailingStop, 0),
    finiteNumber(holding.initialStop, 0),
  )
  if (lastPrice <= 0 || stop <= 0 || stop >= lastPrice) return stop >= lastPrice && lastPrice > 0 ? 0 : null
  return (lastPrice - stop) / lastPrice
}

export function fiveSlotHoldingWeaknessScore(holding: FiveSlotHolding): number {
  const avgCost = finiteNumber(holding.avgCost, 0)
  const lastPrice = finiteNumber(holding.lastPrice, avgCost)
  const highestSinceEntry = finiteNumber(holding.highestSinceEntry, Math.max(avgCost, lastPrice))
  const pnlPct = avgCost > 0 ? (lastPrice - avgCost) / avgCost : 0
  const lossScore = Math.max(0, -pnlPct * 100) * 3
  const staleScore = clamp(finiteNumber(holding.daysHeld, 0), 0, 20)
  const tp1Score = holding.tp1Hit === false ? 20 : 0
  const distance = stopDistancePct(holding)
  const nearStopScore = distance == null
    ? 0
    : distance <= 0
      ? 24
      : distance <= 0.02
        ? (0.02 - distance) / 0.02 * 18
        : 0
  const mfePct = avgCost > 0 ? Math.max(0, (highestSinceEntry - avgCost) / avgCost) : 0
  const givebackPct = avgCost > 0 ? Math.max(0, (highestSinceEntry - lastPrice) / avgCost) : 0
  const givebackScore = mfePct >= 0.03 && givebackPct >= 0.015
    ? Math.min(15, givebackPct * 220)
    : 0
  return lossScore + staleScore + tp1Score + nearStopScore + givebackScore
}

function weakestHolding(holdings: FiveSlotHolding[]): { holding: FiveSlotHolding; weakness: number } | null {
  let weakest: { holding: FiveSlotHolding; weakness: number } | null = null
  for (const holding of holdings) {
    const weakness = fiveSlotHoldingWeaknessScore(holding)
    if (!weakest || weakness > weakest.weakness) weakest = { holding, weakness }
  }
  return weakest
}

function replacementThresholdForHolding(holding: FiveSlotHolding, baseThreshold: number): number {
  const distance = stopDistancePct(holding)
  if (distance == null) return baseThreshold
  if (distance <= 0.01) return Math.min(baseThreshold, 0.90)
  if (distance <= 0.02) return Math.min(baseThreshold, 1.00)
  return baseThreshold
}

function bestReplacementHolding(
  holdings: FiveSlotHolding[],
  rank: number,
  replacementThreshold: number,
  minReplacementWeakness: number,
): { holding: FiveSlotHolding; weakness: number; requiredRank: number; margin: number } | null {
  let best: { holding: FiveSlotHolding; weakness: number; requiredRank: number; margin: number } | null = null
  for (const holding of holdings) {
    const weakness = fiveSlotHoldingWeaknessScore(holding)
    if (weakness < minReplacementWeakness) continue
    const requiredRank = weakness * replacementThresholdForHolding(holding, replacementThreshold)
    const margin = rank - requiredRank
    if (margin < 0) continue
    if (
      !best ||
      margin > best.margin ||
      (Math.abs(margin - best.margin) < 0.001 && weakness > best.weakness)
    ) {
      best = { holding, weakness, requiredRank, margin }
    }
  }
  return best
}

function capBudget(value: number, account: FiveSlotAllocatorAccount, config: FiveSlotAllocatorConfig): number {
  return Math.max(0, Math.min(
    value,
    finiteNumber(account.totalPortfolio, 0) * finiteNumber(config.maxPctOfPortfolio, 0.25),
    finiteNumber(account.cash, 0) * finiteNumber(config.maxPctOfCash, 0.30),
    finiteNumber(account.dailyRemaining, finiteNumber(config.dailyBuyLimit, 0)),
  ))
}

function metricPart(key: string, value: unknown): string {
  if (value == null || value === '') return ''
  const normalized = typeof value === 'number'
    ? String(Math.round(value * 100) / 100)
    : String(value).replace(/[;:=\s]+/g, '_')
  return `${key}=${normalized}`
}

export function formatFiveSlotDecisionWatchPoint(decision: FiveSlotDecision): string {
  const detail = [
    metricPart('target', Math.round(decision.targetPositionValue)),
    metricPart('current', Math.round(decision.currentPositionValue)),
    metricPart('budget', Math.round(decision.budgetCap)),
    metricPart('replace', decision.replaceSymbol ?? null),
    metricPart('weakness', decision.replaceWeaknessScore ?? null),
    metricPart('required', decision.replaceRequiredRank ?? null),
    metricPart('rank', decision.candidateRank ?? null),
    metricPart('exposure', decision.targetExposure),
  ].filter(Boolean).join(';')
  return `allocator:${decision.action}:${decision.reason}${detail ? `:${detail}` : ''}`
}

function skipDecision(
  candidate: FiveSlotCandidate,
  reason: string,
  targetExposure: number,
  targetSlotValue: number,
  confidenceMultiplier: number,
  currentPositionValue = 0,
  targetPositionValue = 0,
  replaceSymbol: string | null = null,
  replaceWeaknessScore: number | null = null,
  replaceRequiredRank: number | null = null,
): FiveSlotDecision {
  return {
    symbol: candidate.symbol,
    action: 'skip',
    reason,
    budgetCap: 0,
    targetPositionValue,
    currentPositionValue,
    targetExposure,
    targetSlotValue,
    confidenceMultiplier,
    replaceSymbol,
    replaceWeaknessScore,
    replaceRequiredRank,
    candidateRank: candidateRank(candidate),
  }
}

export function buildFiveSlotCapitalPlan(input: {
  account: FiveSlotAllocatorAccount
  marketRiskLevel: string | null | undefined
  marketContext?: FiveSlotMarketContext | null
  config: FiveSlotAllocatorConfig
  holdings: FiveSlotHolding[]
  candidates: FiveSlotCandidate[]
}): FiveSlotCapitalPlan {
  const maxPositions = Math.max(1, Math.floor(finiteNumber(input.config.maxPositions, 5)))
  const minPositionValue = Math.max(0, finiteNumber(input.config.minPositionValue, 30_000))
  const targetExposure = inferFiveSlotTargetExposureFromContext({
    marketRiskLevel: input.marketRiskLevel,
    ...(input.marketContext ?? {}),
  })
  const totalPortfolio = Math.max(0, finiteNumber(input.account.totalPortfolio, 0))
  const targetSlotValue = maxPositions > 0 ? (totalPortfolio * targetExposure) / maxPositions : 0
  const holdings = input.holdings ?? []
  const candidates = [...(input.candidates ?? [])].sort((a, b) => candidateRank(b) - candidateRank(a))
  const holdingsBySymbol = new Map(holdings.map((holding) => [holding.symbol, holding]))
  const decisions = new Map<string, FiveSlotDecision>()
  let projectedSlots = holdings.length
  const cash = finiteNumber(input.account.cash, 0)
  const dailyRemaining = finiteNumber(input.account.dailyRemaining, finiteNumber(input.config.dailyBuyLimit, 0))
  const replacementThreshold = finiteNumber(input.config.swapThreshold, 1.15)
  const minReplacementWeakness = finiteNumber(input.config.minReplacementWeakness, 35)
  const weakest = weakestHolding(holdings)

  for (const candidate of candidates) {
    const confidenceMultiplier = fiveSlotConfidenceMultiplier(candidate)
    const targetPositionValue = targetSlotValue * confidenceMultiplier
    const holding = holdingsBySymbol.get(candidate.symbol)
    const currentPositionValue = holding ? holdingValue(holding) : 0
    const rank = candidateRank(candidate)

    if (targetExposure <= 0) {
      decisions.set(candidate.symbol, skipDecision(candidate, 'allocator_target_exposure_zero', targetExposure, targetSlotValue, confidenceMultiplier, currentPositionValue, targetPositionValue))
      continue
    }
    if (cash < minPositionValue || dailyRemaining < minPositionValue) {
      decisions.set(candidate.symbol, skipDecision(candidate, 'allocator_budget_below_min', targetExposure, targetSlotValue, confidenceMultiplier, currentPositionValue, targetPositionValue))
      continue
    }

    if (holding) {
      const residual = Math.max(0, targetPositionValue - currentPositionValue)
      const capped = capBudget(residual, { ...input.account, cash, dailyRemaining }, input.config)
      if (capped < minPositionValue) {
        decisions.set(candidate.symbol, {
          symbol: candidate.symbol,
          action: 'hold',
          reason: 'allocator_slot_already_sized',
          budgetCap: 0,
          targetPositionValue,
          currentPositionValue,
          targetExposure,
          targetSlotValue,
          confidenceMultiplier,
          replaceSymbol: null,
          replaceWeaknessScore: null,
          candidateRank: rank,
        })
        continue
      }
      decisions.set(candidate.symbol, {
        symbol: candidate.symbol,
        action: 'add',
        reason: 'allocator_add_underweight_slot',
        budgetCap: capped,
        targetPositionValue,
        currentPositionValue,
        targetExposure,
        targetSlotValue,
        confidenceMultiplier,
        replaceSymbol: null,
        replaceWeaknessScore: null,
        candidateRank: rank,
      })
      continue
    }

    if (projectedSlots >= maxPositions) {
      const replacement = bestReplacementHolding(holdings, rank, replacementThreshold, minReplacementWeakness)
      if (replacement) {
        const capped = capBudget(targetPositionValue, { ...input.account, cash, dailyRemaining }, input.config)
        decisions.set(candidate.symbol, {
          symbol: candidate.symbol,
          action: 'replace',
          reason: replacement.holding.symbol === weakest?.holding.symbol
            ? 'allocator_replace_weakest_slot'
            : 'allocator_replace_risk_slot',
          budgetCap: capped,
          targetPositionValue,
          currentPositionValue,
          targetExposure,
          targetSlotValue,
          confidenceMultiplier,
          replaceSymbol: replacement.holding.symbol,
          replaceWeaknessScore: Math.round(replacement.weakness * 10) / 10,
          replaceRequiredRank: Math.round(replacement.requiredRank * 10) / 10,
          candidateRank: Math.round(rank * 10) / 10,
        })
        continue
      }
      decisions.set(candidate.symbol, skipDecision(
        candidate,
        'allocator_full_requires_replacement',
        targetExposure,
        targetSlotValue,
        confidenceMultiplier,
        currentPositionValue,
        targetPositionValue,
        weakest?.holding.symbol ?? null,
        weakest ? Math.round(weakest.weakness * 10) / 10 : null,
        weakest ? Math.round(weakest.weakness * replacementThresholdForHolding(weakest.holding, replacementThreshold) * 10) / 10 : null,
      ))
      continue
    }

    const capped = capBudget(targetPositionValue, { ...input.account, cash, dailyRemaining }, input.config)
    if (capped < minPositionValue) {
      decisions.set(candidate.symbol, skipDecision(candidate, 'allocator_budget_below_min', targetExposure, targetSlotValue, confidenceMultiplier, currentPositionValue, targetPositionValue))
      continue
    }

    decisions.set(candidate.symbol, {
      symbol: candidate.symbol,
      action: 'buy',
      reason: 'allocator_open_slot',
      budgetCap: capped,
      targetPositionValue,
      currentPositionValue,
      targetExposure,
      targetSlotValue,
      confidenceMultiplier,
      replaceSymbol: null,
      replaceWeaknessScore: null,
      candidateRank: rank,
    })
    projectedSlots += 1
  }

  return { targetExposure, targetSlotValue, decisions }
}

export function buildFiveSlotExecutionDecision(input: {
  account: FiveSlotAllocatorAccount
  marketRiskLevel: string | null | undefined
  marketContext?: FiveSlotMarketContext | null
  config: FiveSlotAllocatorConfig
  holdings: FiveSlotHolding[]
  candidate: FiveSlotCandidate
}): FiveSlotDecision | null {
  const plan = buildFiveSlotCapitalPlan({
    account: input.account,
    marketRiskLevel: input.marketRiskLevel,
    marketContext: input.marketContext,
    config: input.config,
    holdings: input.holdings,
    candidates: [input.candidate],
  })
  return plan.decisions.get(input.candidate.symbol) ?? null
}
