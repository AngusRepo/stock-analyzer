import type { ExitDecision, ExitPosition } from './paperExitPolicy'
import {
  DEFAULT_HOLDING_EXIT_PARAMS,
  holdingExitDataQualityGuardReason,
  type HoldingExitAdaptiveParams,
  type HoldingExitReview,
} from './holdingExitReview'

export interface MovingTakeProfitTargetDecision {
  action: 'hold' | 'move_tp2'
  reason: string
  currentTp2Price: number | null
  nextTp2Price?: number
  baselineCounterfactual: Pick<ExitDecision, 'action' | 'reason'>
  evidence: {
    score: number
    confidence: number
    regime: string
    activationRatio: number
    atrMultiplier: number
    targetCap: number | null
  }
}

export interface MovingTakeProfitTargetInput {
  position: ExitPosition
  currentPrice: number
  atr14: number
  review: HoldingExitReview
  staticBaseline: Pick<ExitDecision, 'action' | 'reason'>
  params?: HoldingExitAdaptiveParams
}

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function regimeKey(regime: unknown): keyof HoldingExitAdaptiveParams['movingTarget']['atrMultiplier'] {
  if (regime === 'bull' || regime === 'bear' || regime === 'volatile' || regime === 'sideways') return regime
  return 'default'
}

function movingEvidence(
  review: HoldingExitReview,
  params: HoldingExitAdaptiveParams,
  atrMultiplier: number,
  targetCap: number | null,
): MovingTakeProfitTargetDecision['evidence'] {
  return {
    score: review.score,
    confidence: review.confidence,
    regime: String(review.features.regime ?? 'default'),
    activationRatio: params.movingTarget.activationRatio,
    atrMultiplier,
    targetCap,
  }
}

function blocksMovingTarget(staticBaseline: Pick<ExitDecision, 'action' | 'reason'>): boolean {
  if (staticBaseline.action === 'hold') return false
  if (staticBaseline.reason.includes('TP2')) return false
  return true
}

function holdDecision(
  reason: string,
  input: MovingTakeProfitTargetInput,
  params: HoldingExitAdaptiveParams,
  atrMultiplier: number,
  targetCap: number | null,
): MovingTakeProfitTargetDecision {
  return {
    action: 'hold',
    reason,
    currentTp2Price: input.position.tp2_price ?? null,
    baselineCounterfactual: input.staticBaseline,
    evidence: movingEvidence(input.review, params, atrMultiplier, targetCap),
  }
}

export function buildMovingTakeProfitTarget(input: MovingTakeProfitTargetInput): MovingTakeProfitTargetDecision {
  const params = input.params ?? DEFAULT_HOLDING_EXIT_PARAMS
  const currentPrice = finite(input.currentPrice)
  const currentTp2 = finite(input.position.tp2_price)
  const entryPrice = finite(input.position.entry_price ?? input.position.avg_cost)
  const atr = finite(input.atr14) ?? (currentPrice != null ? currentPrice * 0.02 : null)
  const key = regimeKey(input.review.features.regime)
  const atrMultiplier = params.movingTarget.atrMultiplier[key] ?? params.movingTarget.atrMultiplier.default
  const targetCap = currentTp2 != null ? round2(currentTp2 * (1 + params.movingTarget.maxExtensionPct)) : null

  if (currentPrice == null || currentPrice <= 0 || currentTp2 == null || currentTp2 <= 0 || entryPrice == null || entryPrice <= 0 || atr == null || atr <= 0) {
    return holdDecision('invalid_target_inputs', input, params, atrMultiplier, targetCap)
  }
  if (!input.position.tp1_hit) return holdDecision('tp1_not_hit', input, params, atrMultiplier, targetCap)
  if (blocksMovingTarget(input.staticBaseline)) return holdDecision('baseline_exit_priority_blocks_target_move', input, params, atrMultiplier, targetCap)
  if (currentPrice < currentTp2 * params.movingTarget.activationRatio) return holdDecision('not_near_tp2', input, params, atrMultiplier, targetCap)
  if (input.review.confidence < params.movingTarget.minConfidence) return holdDecision('low_review_confidence', input, params, atrMultiplier, targetCap)
  const qualityReason = holdingExitDataQualityGuardReason(input.review.features, params.dataQuality, 'move_target')
  if (qualityReason) return holdDecision(qualityReason, input, params, atrMultiplier, targetCap)
  if (input.review.score > params.movingTarget.maxExitRiskScore) return holdDecision('exit_risk_score_high', input, params, atrMultiplier, targetCap)
  if (input.review.action === 'tighten_trail' || input.review.action === 'partial_exit' || input.review.action === 'full_exit') {
    return holdDecision(`exit_risk_action_${input.review.action}`, input, params, atrMultiplier, targetCap)
  }

  const rawNext = Math.max(
    currentTp2,
    currentPrice * 1.01,
    currentPrice + atr * atrMultiplier,
  )
  const cappedNext = targetCap == null ? rawNext : Math.min(rawNext, targetCap)
  const nextTp2 = round2(cappedNext)
  if (nextTp2 <= currentTp2) return holdDecision('target_cap_reached', input, params, atrMultiplier, targetCap)

  return {
    action: 'move_tp2',
    reason: 'low_exit_risk_extend_tp2',
    currentTp2Price: currentTp2,
    nextTp2Price: nextTp2,
    baselineCounterfactual: input.staticBaseline,
    evidence: movingEvidence(input.review, params, atrMultiplier, targetCap),
  }
}
