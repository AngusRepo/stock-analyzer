import type { Bindings } from '../types'
import {
  DEFAULT_HOLDING_EXIT_PARAMS,
  type HoldingExitAdaptiveParams,
  type HoldingExitFeatures,
  type HoldingExitReview,
  type HoldingExitReviewAction,
} from './holdingExitReview'
import { recordPaperExecutionEvent } from './paperExecutionEvents'

export const HOLDING_EXIT_LEARNING_KV_KEY = 'paper:holding_exit_learning_state:v1'
export const HOLDING_EXIT_LEARNING_SCHEMA_VERSION = 'paper-holding-exit-learning-v1' as const

const FACTOR_KEYS = [
  'brokerFlow',
  'institutionalChip',
  'moneyFlow',
  'structure',
  'giveback',
  'regime',
] as const

type FactorName = typeof FACTOR_KEYS[number]
type ReviewFactorMap = HoldingExitReview['factors']
type ThresholdKey = keyof HoldingExitAdaptiveParams['thresholds']['default']
type RewardBasis = 'absolute_return' | 'counterfactual_delta'
type ActiveDecisionSource =
  | 'current_policy'
  | 'holding_review'
  | 'moving_tp_target'
  | 'intraday_rescore'
  | 'manual'
  | 'unknown'

const ABSOLUTE_REWARD_BLEND = {
  return: 0.55,
  retention: 0.35,
  confidence: 0.10,
} as const

const COUNTERFACTUAL_REWARD_BLEND = {
  delta: 0.70,
  retention: 0.20,
  confidence: 0.10,
} as const

export interface HoldingExitLearningGuardrails {
  learningRate: number
  fullConfidenceSamples: number
  minWeight: number
  maxWeight: number
  maxWeightStep: number
  thresholdStep: number
  thresholdMin: number
  thresholdMax: number
  thresholdGap: number
  trailMultiplierStep: number
  minTrailAtrMultiplier: number
  maxTrailAtrMultiplier: number
}

export interface HoldingExitLearningStats {
  count: number
  rewardEwma: number
  avgReward: number
  avgRealizedReturnPct: number
  avgProfitRetention: number
  positiveRewardCount: number
}

export interface HoldingExitLearningObservation {
  tradeDate: string
  symbol: string
  reviewCreatedAt: string | null
  reviewAction: string
  finalAction: string
  activeDecisionSource: ActiveDecisionSource
  learningEligible: boolean
  baselineAction: string
  score: number
  confidence: number
  realizedReturnPct: number
  baselineReturnPct: number | null
  baselineExitPrice: number | null
  activeVsBaselineReturnDeltaPct: number | null
  activeVsBaselineReturnDeltaAmount: number | null
  positionSharesBeforeExit: number | null
  exitShareRatio: number
  learningImpactWeight: number
  profitRetention: number
  reward: number
  rewardBasis: RewardBasis
  counterfactualRewardScore: number | null
  featureQualityCoverage: number | null
  flowEvidenceCoverage: number | null
  missingFeatureGroups: string[]
  mfePct: number | null
  givebackPctAtReview: number | null
  regime: string
  factorValues: ReviewFactorMap
  exitReason: string
  exitSource: string
  shares: number
  orderId: number | null
}

export interface HoldingExitReviewEventForLearning {
  status?: string | null
  reason?: string | null
  detail?: Record<string, unknown> | null
  createdAt?: string | null
}

export interface HoldingExitTargetUpdateEventForLearning {
  status?: string | null
  reason?: string | null
  detail?: Record<string, unknown> | null
  createdAt?: string | null
}

export interface HoldingExitLearningState {
  schemaVersion: typeof HOLDING_EXIT_LEARNING_SCHEMA_VERSION
  paramsVersion: number
  sampleCount: number
  updatedAt: string
  params: HoldingExitAdaptiveParams
  factorUtility: Record<FactorName, number>
  actionStats: Record<string, HoldingExitLearningStats>
  regimeStats: Record<string, HoldingExitLearningStats>
  guardrails: HoldingExitLearningGuardrails
  lastObservation: HoldingExitLearningObservation | null
  provenance: {
    source: 'paper_execution_events'
    effect: 'paper_trading_only'
    rawEventType: 'holding_exit_review'
    outcomeEventType: 'holding_exit_outcome'
  }
}

export interface HoldingExitSellOutcomeInput {
  env: Pick<Bindings, 'DB' | 'KV'>
  accountId?: number
  tradeDate: string
  symbol: string
  entryDate?: string | null
  entryPrice: number
  exitPrice: number
  shares: number
  positionSharesBeforeExit?: number | null
  exitReason: string
  exitSource: string
  orderId?: number | null
}

export interface HoldingExitSellOutcomeResult {
  recorded: boolean
  reason: string
  observation?: HoldingExitLearningObservation
  state?: HoldingExitLearningState
}

const DEFAULT_GUARDRAILS: HoldingExitLearningGuardrails = {
  learningRate: 0.08,
  fullConfidenceSamples: 5,
  minWeight: 0.05,
  maxWeight: 0.4,
  maxWeightStep: 0.03,
  thresholdStep: 0.02,
  thresholdMin: 0.18,
  thresholdMax: 0.96,
  thresholdGap: 0.04,
  trailMultiplierStep: 0.03,
  minTrailAtrMultiplier: 0.75,
  maxTrailAtrMultiplier: 1.8,
}

function nowIso(): string {
  return new Date().toISOString()
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function finiteOr(value: unknown, fallback: number): number {
  const n = finite(value)
  return n == null ? fallback : n
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cloneParams(params: HoldingExitAdaptiveParams): HoldingExitAdaptiveParams {
  return JSON.parse(JSON.stringify(params)) as HoldingExitAdaptiveParams
}

function zeroFactorUtility(): Record<FactorName, number> {
  return {
    brokerFlow: 0,
    institutionalChip: 0,
    moneyFlow: 0,
    structure: 0,
    giveback: 0,
    regime: 0,
  }
}

function normalizeFactors(value: unknown): ReviewFactorMap {
  const raw = asRecord(value)
  return {
    brokerFlow: clamp(finiteOr(raw.brokerFlow, 0), 0, 1),
    institutionalChip: clamp(finiteOr(raw.institutionalChip, 0), 0, 1),
    moneyFlow: clamp(finiteOr(raw.moneyFlow, 0), 0, 1),
    structure: clamp(finiteOr(raw.structure, 0), 0, 1),
    giveback: clamp(finiteOr(raw.giveback, 0), 0, 1),
    regime: clamp(finiteOr(raw.regime, 0), 0, 1),
  }
}

function normalizeFeatures(value: unknown): HoldingExitFeatures {
  const raw = asRecord(value)
  const rawQuality = asRecord(raw.featureQuality)
  const qualityCoverage = finite(rawQuality.coverage)
  const missingFeatureGroups = Array.isArray(rawQuality.missing)
    ? rawQuality.missing.map((item) => String(item))
    : []
  return {
    brokerNetAmount5d: finite(raw.brokerNetAmount5d),
    brokerConcentrationDelta5d: finite(raw.brokerConcentrationDelta5d),
    institutionalNetAmount5d: finite(raw.institutionalNetAmount5d),
    obvTemperature60: finite(raw.obvTemperature60),
    supportBreakPct: finite(raw.supportBreakPct),
    mfePct: finite(raw.mfePct),
    givebackPct: finite(raw.givebackPct),
    regime: typeof raw.regime === 'string' ? raw.regime as HoldingExitFeatures['regime'] : null,
    featureQuality: qualityCoverage == null
      ? undefined
      : {
          coverage: round4(clamp(qualityCoverage, 0, 1)),
          missing: missingFeatureGroups as any,
          sources: {} as any,
        },
  }
}

function flowEvidenceCoverageFromFeatures(features: HoldingExitFeatures): number | null {
  if (!features.featureQuality) return null
  const missing = new Set((features.featureQuality.missing ?? []).map((item) => String(item)))
  const groups = ['brokerFlow', 'institutionalChip', 'moneyFlow']
  const present = groups.filter((group) => !missing.has(group)).length
  return round4(present / groups.length)
}

function normalizeWeights(
  rawWeights: unknown,
  guardrails: HoldingExitLearningGuardrails,
): HoldingExitAdaptiveParams['weights'] {
  const raw = asRecord(rawWeights)
  const weights = {} as HoldingExitAdaptiveParams['weights']
  let total = 0
  for (const key of FACTOR_KEYS) {
    const value = clamp(
      finiteOr(raw[key], DEFAULT_HOLDING_EXIT_PARAMS.weights[key]),
      guardrails.minWeight,
      guardrails.maxWeight,
    )
    weights[key] = value
    total += value
  }
  if (total <= 0) return cloneParams(DEFAULT_HOLDING_EXIT_PARAMS).weights
  for (const key of FACTOR_KEYS) weights[key] = round6(weights[key] / total)
  return weights
}

function enforceThresholdOrder(
  thresholds: HoldingExitAdaptiveParams['thresholds']['default'],
  guardrails: HoldingExitLearningGuardrails,
): HoldingExitAdaptiveParams['thresholds']['default'] {
  const ordered: ThresholdKey[] = ['warn', 'tighten', 'partial', 'full']
  const values = ordered.map((key) => clamp(thresholds[key], guardrails.thresholdMin, guardrails.thresholdMax))
  for (let i = 1; i < values.length; i++) {
    values[i] = Math.max(values[i], values[i - 1] + guardrails.thresholdGap)
  }
  const overflow = values[values.length - 1] - guardrails.thresholdMax
  if (overflow > 0) {
    for (let i = 0; i < values.length; i++) values[i] -= overflow
  }
  for (let i = values.length - 2; i >= 0; i--) {
    values[i] = Math.min(values[i], values[i + 1] - guardrails.thresholdGap)
  }
  return {
    warn: round4(clamp(values[0], guardrails.thresholdMin, guardrails.thresholdMax)),
    tighten: round4(clamp(values[1], guardrails.thresholdMin, guardrails.thresholdMax)),
    partial: round4(clamp(values[2], guardrails.thresholdMin, guardrails.thresholdMax)),
    full: round4(clamp(values[3], guardrails.thresholdMin, guardrails.thresholdMax)),
  }
}

function normalizeParams(rawParams: unknown, guardrails: HoldingExitLearningGuardrails): HoldingExitAdaptiveParams {
  const raw = asRecord(rawParams)
  const defaults = cloneParams(DEFAULT_HOLDING_EXIT_PARAMS)
  const rawThresholds = asRecord(raw.thresholds)
  const thresholds = {} as HoldingExitAdaptiveParams['thresholds']
  for (const regime of ['default', 'bull', 'sideways', 'bear', 'volatile'] as const) {
    thresholds[regime] = enforceThresholdOrder({
      warn: finiteOr(asRecord(rawThresholds[regime]).warn, defaults.thresholds[regime].warn),
      tighten: finiteOr(asRecord(rawThresholds[regime]).tighten, defaults.thresholds[regime].tighten),
      partial: finiteOr(asRecord(rawThresholds[regime]).partial, defaults.thresholds[regime].partial),
      full: finiteOr(asRecord(rawThresholds[regime]).full, defaults.thresholds[regime].full),
    }, guardrails)
  }

  const rawTrail = asRecord(raw.trailAtrMultiplier)
  const trailAtrMultiplier = {} as HoldingExitAdaptiveParams['trailAtrMultiplier']
  for (const regime of ['default', 'bull', 'sideways', 'bear', 'volatile'] as const) {
    trailAtrMultiplier[regime] = round4(clamp(
      finiteOr(rawTrail[regime], defaults.trailAtrMultiplier[regime]),
      guardrails.minTrailAtrMultiplier,
      guardrails.maxTrailAtrMultiplier,
    ))
  }

  const rawMovingTarget = asRecord(raw.movingTarget)
  const rawTargetAtr = asRecord(rawMovingTarget.atrMultiplier)
  const targetAtrMultiplier = {} as HoldingExitAdaptiveParams['movingTarget']['atrMultiplier']
  for (const regime of ['default', 'bull', 'sideways', 'bear', 'volatile'] as const) {
    targetAtrMultiplier[regime] = round4(clamp(
      finiteOr(rawTargetAtr[regime], defaults.movingTarget.atrMultiplier[regime]),
      0.2,
      4,
    ))
  }

  return {
    weights: normalizeWeights(raw.weights, guardrails),
    thresholds,
    trailAtrMultiplier,
    movingTarget: {
      activationRatio: round4(clamp(
        finiteOr(rawMovingTarget.activationRatio, defaults.movingTarget.activationRatio),
        0.90,
        1.02,
      )),
      maxExitRiskScore: round4(clamp(
        finiteOr(rawMovingTarget.maxExitRiskScore, defaults.movingTarget.maxExitRiskScore),
        0.05,
        0.70,
      )),
      minConfidence: round4(clamp(
        finiteOr(rawMovingTarget.minConfidence, defaults.movingTarget.minConfidence),
        0.10,
        0.95,
      )),
      maxExtensionPct: round4(clamp(
        finiteOr(rawMovingTarget.maxExtensionPct, defaults.movingTarget.maxExtensionPct),
        0.01,
        0.60,
      )),
      atrMultiplier: targetAtrMultiplier,
    },
    sellActions: normalizeSellActions(raw.sellActions, defaults.sellActions),
    dataQuality: normalizeDataQuality(raw.dataQuality, defaults.dataQuality),
    actionGates: normalizeActionGates(raw.actionGates, defaults.actionGates),
    reasonCutoffs: normalizeReasonCutoffs(raw.reasonCutoffs, defaults.reasonCutoffs),
    minScoreConfidence: round4(clamp(
      finiteOr(raw.minScoreConfidence, defaults.minScoreConfidence),
      0.1,
      0.95,
    )),
  }
}

function normalizeSellActions(
  rawSellActions: unknown,
  defaults: HoldingExitAdaptiveParams['sellActions'],
): HoldingExitAdaptiveParams['sellActions'] {
  const raw = asRecord(rawSellActions)
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    allowPartialExit: typeof raw.allowPartialExit === 'boolean' ? raw.allowPartialExit : defaults.allowPartialExit,
    allowFullExit: typeof raw.allowFullExit === 'boolean' ? raw.allowFullExit : defaults.allowFullExit,
    minConfidence: round4(clamp(finiteOr(raw.minConfidence, defaults.minConfidence), 0.1, 0.99)),
    partialSellRatio: round4(clamp(finiteOr(raw.partialSellRatio, defaults.partialSellRatio), 0.05, 0.95)),
    minPartialShares: Math.max(1, Math.round(finiteOr(raw.minPartialShares, defaults.minPartialShares))),
    roundLotSize: Math.max(1, Math.round(finiteOr(raw.roundLotSize, defaults.roundLotSize))),
  }
}

function normalizeDataQuality(
  rawDataQuality: unknown,
  defaults: HoldingExitAdaptiveParams['dataQuality'],
): HoldingExitAdaptiveParams['dataQuality'] {
  const raw = asRecord(rawDataQuality)
  return {
    minCoverageForMoveTarget: round4(clamp(
      finiteOr(raw.minCoverageForMoveTarget, defaults.minCoverageForMoveTarget),
      0,
      1,
    )),
    minFlowCoverageForMoveTarget: round4(clamp(
      finiteOr(raw.minFlowCoverageForMoveTarget, defaults.minFlowCoverageForMoveTarget),
      0,
      1,
    )),
    minCoverageForSellAction: round4(clamp(
      finiteOr(raw.minCoverageForSellAction, defaults.minCoverageForSellAction),
      0,
      1,
    )),
    minFlowCoverageForSellAction: round4(clamp(
      finiteOr(raw.minFlowCoverageForSellAction, defaults.minFlowCoverageForSellAction),
      0,
      1,
    )),
  }
}

function normalizeActionGates(
  rawActionGates: unknown,
  defaults: HoldingExitAdaptiveParams['actionGates'],
): HoldingExitAdaptiveParams['actionGates'] {
  const raw = asRecord(rawActionGates)
  return {
    fullExitStructureMin: round4(clamp(finiteOr(raw.fullExitStructureMin, defaults.fullExitStructureMin), 0.05, 0.99)),
    partialExitStructureMin: round4(clamp(finiteOr(raw.partialExitStructureMin, defaults.partialExitStructureMin), 0.05, 0.99)),
    partialExitGivebackMin: round4(clamp(finiteOr(raw.partialExitGivebackMin, defaults.partialExitGivebackMin), 0.05, 0.99)),
  }
}

function normalizeReasonCutoffs(
  rawReasonCutoffs: unknown,
  defaults: HoldingExitAdaptiveParams['reasonCutoffs'],
): HoldingExitAdaptiveParams['reasonCutoffs'] {
  const raw = asRecord(rawReasonCutoffs)
  return {
    brokerFlow: round4(clamp(finiteOr(raw.brokerFlow, defaults.brokerFlow), 0.01, 0.99)),
    institutionalChip: round4(clamp(finiteOr(raw.institutionalChip, defaults.institutionalChip), 0.01, 0.99)),
    moneyFlow: round4(clamp(finiteOr(raw.moneyFlow, defaults.moneyFlow), 0.01, 0.99)),
    structure: round4(clamp(finiteOr(raw.structure, defaults.structure), 0.01, 0.99)),
    giveback: round4(clamp(finiteOr(raw.giveback, defaults.giveback), 0.01, 0.99)),
  }
}

function normalizeGuardrails(rawGuardrails: unknown): HoldingExitLearningGuardrails {
  const raw = asRecord(rawGuardrails)
  return {
    learningRate: clamp(finiteOr(raw.learningRate, DEFAULT_GUARDRAILS.learningRate), 0.01, 0.5),
    fullConfidenceSamples: Math.max(1, Math.round(finiteOr(raw.fullConfidenceSamples, DEFAULT_GUARDRAILS.fullConfidenceSamples))),
    minWeight: clamp(finiteOr(raw.minWeight, DEFAULT_GUARDRAILS.minWeight), 0.01, 0.2),
    maxWeight: clamp(finiteOr(raw.maxWeight, DEFAULT_GUARDRAILS.maxWeight), 0.2, 0.8),
    maxWeightStep: clamp(finiteOr(raw.maxWeightStep, DEFAULT_GUARDRAILS.maxWeightStep), 0.001, 0.1),
    thresholdStep: clamp(finiteOr(raw.thresholdStep, DEFAULT_GUARDRAILS.thresholdStep), 0.001, 0.08),
    thresholdMin: clamp(finiteOr(raw.thresholdMin, DEFAULT_GUARDRAILS.thresholdMin), 0.05, 0.6),
    thresholdMax: clamp(finiteOr(raw.thresholdMax, DEFAULT_GUARDRAILS.thresholdMax), 0.6, 0.99),
    thresholdGap: clamp(finiteOr(raw.thresholdGap, DEFAULT_GUARDRAILS.thresholdGap), 0.01, 0.15),
    trailMultiplierStep: clamp(finiteOr(raw.trailMultiplierStep, DEFAULT_GUARDRAILS.trailMultiplierStep), 0.001, 0.15),
    minTrailAtrMultiplier: clamp(finiteOr(raw.minTrailAtrMultiplier, DEFAULT_GUARDRAILS.minTrailAtrMultiplier), 0.3, 1.2),
    maxTrailAtrMultiplier: clamp(finiteOr(raw.maxTrailAtrMultiplier, DEFAULT_GUARDRAILS.maxTrailAtrMultiplier), 1.2, 3),
  }
}

function normalizeStats(rawStats: unknown): Record<string, HoldingExitLearningStats> {
  const raw = asRecord(rawStats)
  const out: Record<string, HoldingExitLearningStats> = {}
  for (const [key, value] of Object.entries(raw)) {
    const item = asRecord(value)
    out[key] = {
      count: Math.max(0, Math.round(finiteOr(item.count, 0))),
      rewardEwma: round6(clamp(finiteOr(item.rewardEwma, 0), -1, 1)),
      avgReward: round6(clamp(finiteOr(item.avgReward, 0), -1, 1)),
      avgRealizedReturnPct: round6(finiteOr(item.avgRealizedReturnPct, 0)),
      avgProfitRetention: round6(clamp(finiteOr(item.avgProfitRetention, 0), -1, 1.5)),
      positiveRewardCount: Math.max(0, Math.round(finiteOr(item.positiveRewardCount, 0))),
    }
  }
  return out
}

export function defaultHoldingExitLearningState(updatedAt = nowIso()): HoldingExitLearningState {
  return {
    schemaVersion: HOLDING_EXIT_LEARNING_SCHEMA_VERSION,
    paramsVersion: 0,
    sampleCount: 0,
    updatedAt,
    params: cloneParams(DEFAULT_HOLDING_EXIT_PARAMS),
    factorUtility: zeroFactorUtility(),
    actionStats: {},
    regimeStats: {},
    guardrails: { ...DEFAULT_GUARDRAILS },
    lastObservation: null,
    provenance: {
      source: 'paper_execution_events',
      effect: 'paper_trading_only',
      rawEventType: 'holding_exit_review',
      outcomeEventType: 'holding_exit_outcome',
    },
  }
}

export function normalizeHoldingExitLearningState(rawState: unknown, updatedAt = nowIso()): HoldingExitLearningState {
  const raw = asRecord(rawState)
  const guardrails = normalizeGuardrails(raw.guardrails)
  const seed = defaultHoldingExitLearningState(updatedAt)
  const rawUtility = asRecord(raw.factorUtility)
  const factorUtility = zeroFactorUtility()
  for (const key of FACTOR_KEYS) factorUtility[key] = round6(clamp(finiteOr(rawUtility[key], 0), -1, 1))

  return {
    ...seed,
    paramsVersion: Math.max(0, Math.round(finiteOr(raw.paramsVersion, 0))),
    sampleCount: Math.max(0, Math.round(finiteOr(raw.sampleCount, 0))),
    updatedAt: String(raw.updatedAt ?? updatedAt),
    params: normalizeParams(raw.params, guardrails),
    factorUtility,
    actionStats: normalizeStats(raw.actionStats),
    regimeStats: normalizeStats(raw.regimeStats),
    guardrails,
    lastObservation: asRecord(raw.lastObservation).symbol ? raw.lastObservation as HoldingExitLearningObservation : null,
  }
}

function parseEventDetail(rawDetail: unknown): Record<string, unknown> {
  if (typeof rawDetail === 'string') {
    try {
      return asRecord(JSON.parse(rawDetail))
    } catch {
      return {}
    }
  }
  return asRecord(rawDetail)
}

function actionFromDetail(detail: Record<string, unknown>, fallback: unknown): string {
  const movingTarget = asRecord(detail.moving_tp_target)
  if (movingTarget.action === 'move_tp2') return 'move_tp2'
  const candidate = asRecord(detail.final_candidate)
  const action = candidate.action ?? fallback
  return String(action ?? 'unknown')
}

function activeDecisionSourceFromDetail(detail: Record<string, unknown>, finalAction: string): ActiveDecisionSource {
  const movingTarget = asRecord(detail.moving_tp_target)
  if (finalAction === 'move_tp2' || movingTarget.action === 'move_tp2') return 'moving_tp_target'
  const candidate = asRecord(detail.final_candidate)
  const source = String(candidate.source ?? '').trim()
  if (
    source === 'current_policy'
    || source === 'holding_review'
    || source === 'intraday_rescore'
    || source === 'manual'
  ) return source
  return 'unknown'
}

function learningEligibleFromSource(source: ActiveDecisionSource): boolean {
  return source === 'holding_review' || source === 'moving_tp_target'
}

function baselineActionFromDetail(detail: Record<string, unknown>): string {
  const baseline = asRecord(detail.baseline_counterfactual)
  return String(baseline.action ?? 'unknown')
}

function baselineExitPriceFromDetail(detail: Record<string, unknown>, finalAction: string): number | null {
  const movingTarget = asRecord(detail.moving_tp_target)
  if (finalAction === 'move_tp2') {
    const currentTp2Price = finite(movingTarget.currentTp2Price)
    if (currentTp2Price != null && currentTp2Price > 0) return currentTp2Price
  }

  const baseline = asRecord(detail.baseline_counterfactual)
  for (const key of ['exitPrice', 'targetPrice', 'tp2Price']) {
    const value = finite(baseline[key])
    if (value != null && value > 0) return value
  }
  return null
}

function counterfactualRewardScore(input: {
  activeVsBaselineReturnDeltaPct: number | null
  baselineReturnPct: number | null
  realizedReturnPct: number
  maxFavorablePct: number
}): number | null {
  if (input.activeVsBaselineReturnDeltaPct == null || input.baselineReturnPct == null) return null
  const scale = Math.max(
    Math.abs(input.baselineReturnPct),
    Math.abs(input.realizedReturnPct),
    Math.abs(input.maxFavorablePct),
    Number.EPSILON,
  )
  return round6(clamp(input.activeVsBaselineReturnDeltaPct / scale, -1, 1))
}

function exitShareRatioFromInput(shares: number, positionSharesBeforeExit: number | null): number {
  const base = positionSharesBeforeExit != null && positionSharesBeforeExit > 0 ? positionSharesBeforeExit : shares
  return round6(clamp(shares / Math.max(base, Number.EPSILON), 0, 1))
}

export function buildHoldingExitLearningObservation(input: {
  tradeDate: string
  symbol: string
  entryPrice: number
  exitPrice: number
  shares: number
  positionSharesBeforeExit?: number | null
  exitReason: string
  exitSource: string
  orderId?: number | null
  reviewEvent: HoldingExitReviewEventForLearning
}): HoldingExitLearningObservation | null {
  const entryPrice = finite(input.entryPrice)
  const exitPrice = finite(input.exitPrice)
  const shares = finite(input.shares)
  if (entryPrice == null || entryPrice <= 0 || exitPrice == null || shares == null || shares <= 0) return null
  const positionSharesBeforeExitRaw = finite(input.positionSharesBeforeExit)
  const positionSharesBeforeExit = positionSharesBeforeExitRaw != null && positionSharesBeforeExitRaw > 0
    ? Math.round(positionSharesBeforeExitRaw)
    : null

  const detail = parseEventDetail(input.reviewEvent.detail)
  const factors = normalizeFactors(detail.factors)
  const features = normalizeFeatures(detail.features)
  const featureQualityCoverage = features.featureQuality?.coverage != null
    ? round4(clamp(features.featureQuality.coverage, 0, 1))
    : null
  const flowEvidenceCoverage = flowEvidenceCoverageFromFeatures(features)
  const missingFeatureGroups = (features.featureQuality?.missing ?? []).map((item) => String(item))
  const realizedReturnPct = round6((exitPrice - entryPrice) / entryPrice)
  const finalAction = actionFromDetail(detail, input.reviewEvent.status)
  const activeDecisionSource = activeDecisionSourceFromDetail(detail, finalAction)
  const exitShareRatio = exitShareRatioFromInput(shares, positionSharesBeforeExit)
  const learningImpactWeight = finalAction === 'partial_sell' || finalAction === 'partial_exit'
    ? round6(clamp(exitShareRatio, 0.05, 1))
    : 1
  const baselineExitPrice = baselineExitPriceFromDetail(detail, finalAction)
  const baselineReturnPct = baselineExitPrice != null
    ? round6((baselineExitPrice - entryPrice) / entryPrice)
    : null
  const activeVsBaselineReturnDeltaPct = baselineReturnPct != null
    ? round6(realizedReturnPct - baselineReturnPct)
    : null
  const activeVsBaselineReturnDeltaAmount = baselineExitPrice != null
    ? round4((exitPrice - baselineExitPrice) * shares)
    : null
  const mfePct = features.mfePct != null ? round6(features.mfePct) : null
  const maxFavorablePct = Math.max(mfePct ?? realizedReturnPct, realizedReturnPct, 0)
  const profitRetention = maxFavorablePct > 0
    ? round6(clamp(realizedReturnPct / maxFavorablePct, -1, 1.5))
    : realizedReturnPct > 0 ? 1 : 0
  const returnReward = clamp(realizedReturnPct / 0.12, -1, 1)
  const retentionReward = maxFavorablePct > 0 ? clamp((profitRetention - 0.5) * 2, -1, 1) : 0
  const confidence = clamp(finiteOr(detail.confidence, 0), 0, 1)
  const counterfactualScore = counterfactualRewardScore({
    activeVsBaselineReturnDeltaPct,
    baselineReturnPct,
    realizedReturnPct,
    maxFavorablePct,
  })
  const rewardBasis: RewardBasis = counterfactualScore == null ? 'absolute_return' : 'counterfactual_delta'
  const reward = round6(clamp(
    counterfactualScore == null
      ? returnReward * ABSOLUTE_REWARD_BLEND.return
        + retentionReward * ABSOLUTE_REWARD_BLEND.retention
        + (confidence - 0.5) * ABSOLUTE_REWARD_BLEND.confidence
      : counterfactualScore * COUNTERFACTUAL_REWARD_BLEND.delta
        + retentionReward * COUNTERFACTUAL_REWARD_BLEND.retention
        + (confidence - 0.5) * COUNTERFACTUAL_REWARD_BLEND.confidence,
    -1,
    1,
  ))

  return {
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    reviewCreatedAt: input.reviewEvent.createdAt ?? null,
    reviewAction: String(input.reviewEvent.status ?? 'unknown'),
    finalAction,
    activeDecisionSource,
    learningEligible: learningEligibleFromSource(activeDecisionSource),
    baselineAction: baselineActionFromDetail(detail),
    score: round4(clamp(finiteOr(detail.score, 0), 0, 1)),
    confidence: round4(confidence),
    realizedReturnPct,
    baselineReturnPct,
    baselineExitPrice: baselineExitPrice != null ? round4(baselineExitPrice) : null,
    activeVsBaselineReturnDeltaPct,
    activeVsBaselineReturnDeltaAmount,
    positionSharesBeforeExit,
    exitShareRatio,
    learningImpactWeight,
    profitRetention,
    reward,
    rewardBasis,
    counterfactualRewardScore: counterfactualScore,
    featureQualityCoverage,
    flowEvidenceCoverage,
    missingFeatureGroups,
    mfePct,
    givebackPctAtReview: features.givebackPct != null ? round6(features.givebackPct) : null,
    regime: String(features.regime ?? 'default'),
    factorValues: factors,
    exitReason: input.exitReason,
    exitSource: input.exitSource,
    shares: Math.round(shares),
    orderId: input.orderId ?? null,
  }
}

function updateStat(
  previous: HoldingExitLearningStats | undefined,
  observation: HoldingExitLearningObservation,
  learningRate: number,
): HoldingExitLearningStats {
  const count = (previous?.count ?? 0) + 1
  const avg = (oldValue: number | undefined, nextValue: number) => {
    const prev = oldValue ?? 0
    return prev + (nextValue - prev) / count
  }
  const prevEwma = previous?.rewardEwma ?? observation.reward
  return {
    count,
    rewardEwma: round6(prevEwma + (observation.reward - prevEwma) * learningRate),
    avgReward: round6(avg(previous?.avgReward, observation.reward)),
    avgRealizedReturnPct: round6(avg(previous?.avgRealizedReturnPct, observation.realizedReturnPct)),
    avgProfitRetention: round6(avg(previous?.avgProfitRetention, observation.profitRetention)),
    positiveRewardCount: (previous?.positiveRewardCount ?? 0) + (observation.reward > 0 ? 1 : 0),
  }
}

function updateWeights(
  current: HoldingExitAdaptiveParams['weights'],
  utility: Record<FactorName, number>,
  guardrails: HoldingExitLearningGuardrails,
  confidenceScale: number,
): HoldingExitAdaptiveParams['weights'] {
  const raw: Record<FactorName, number> = {} as Record<FactorName, number>
  let total = 0
  for (const key of FACTOR_KEYS) {
    const step = clamp(utility[key], -1, 1) * guardrails.maxWeightStep * confidenceScale
    raw[key] = clamp(current[key] + step, guardrails.minWeight, guardrails.maxWeight)
    total += raw[key]
  }
  const out = {} as HoldingExitAdaptiveParams['weights']
  for (const key of FACTOR_KEYS) out[key] = round6(raw[key] / total)
  return out
}

function adjustThreshold(
  thresholds: HoldingExitAdaptiveParams['thresholds']['default'],
  action: string,
  reward: number,
  step: number,
  guardrails: HoldingExitLearningGuardrails,
): HoldingExitAdaptiveParams['thresholds']['default'] {
  const next = { ...thresholds }
  const direction = reward >= 0 ? -1 : 1
  const amount = Math.abs(reward) * step
  if (action === 'warn') next.warn += direction * amount
  if (action === 'tighten_trail') next.tighten += direction * amount
  if (action === 'partial_exit' || action === 'partial_sell') next.partial += direction * amount
  if (action === 'full_exit' || action === 'full_sell') next.full += direction * amount
  return enforceThresholdOrder(next, guardrails)
}

function adjustTrailMultiplier(
  multiplier: number,
  observation: HoldingExitLearningObservation,
  step: number,
  guardrails: HoldingExitLearningGuardrails,
): number {
  if (observation.finalAction !== 'tighten_trail') return multiplier
  const highGiveback = observation.givebackPctAtReview != null
    && observation.mfePct != null
    && observation.mfePct > 0
    && observation.givebackPctAtReview / observation.mfePct > 0.35
  const direction = observation.reward >= 0 && highGiveback ? -1 : observation.reward < 0 ? 1 : 0
  return round4(clamp(
    multiplier + direction * Math.abs(observation.reward) * step,
    guardrails.minTrailAtrMultiplier,
    guardrails.maxTrailAtrMultiplier,
  ))
}

function adjustActionGates(
  gates: HoldingExitAdaptiveParams['actionGates'],
  observation: HoldingExitLearningObservation,
  step: number,
): HoldingExitAdaptiveParams['actionGates'] {
  const direction = observation.reward >= 0 ? -1 : 1
  const amount = Math.abs(observation.reward) * step
  const next = { ...gates }

  if (observation.finalAction === 'full_exit' || observation.finalAction === 'full_sell') {
    next.fullExitStructureMin = round4(clamp(next.fullExitStructureMin + direction * amount, 0.05, 0.99))
  }

  if (observation.finalAction === 'partial_exit' || observation.finalAction === 'partial_sell') {
    if (observation.factorValues.structure >= observation.factorValues.giveback) {
      next.partialExitStructureMin = round4(clamp(next.partialExitStructureMin + direction * amount, 0.05, 0.99))
    } else {
      next.partialExitGivebackMin = round4(clamp(next.partialExitGivebackMin + direction * amount, 0.05, 0.99))
    }
  }

  return next
}

function adjustMovingTargetGuards(
  movingTarget: HoldingExitAdaptiveParams['movingTarget'],
  observation: HoldingExitLearningObservation,
  step: number,
): HoldingExitAdaptiveParams['movingTarget'] {
  if (observation.finalAction !== 'move_tp2') return movingTarget
  const amount = Math.abs(observation.reward) * step
  const loosen = observation.reward >= 0
  return {
    ...movingTarget,
    activationRatio: round4(clamp(
      movingTarget.activationRatio + (loosen ? -amount : amount),
      0.90,
      1.02,
    )),
    maxExitRiskScore: round4(clamp(
      movingTarget.maxExitRiskScore + (loosen ? amount : -amount),
      0.05,
      0.70,
    )),
    minConfidence: round4(clamp(
      movingTarget.minConfidence + (loosen ? -amount : amount),
      0.10,
      0.95,
    )),
    maxExtensionPct: round4(clamp(
      movingTarget.maxExtensionPct + (loosen ? amount : -amount),
      0.01,
      0.60,
    )),
  }
}

function adjustSellActions(
  sellActions: HoldingExitAdaptiveParams['sellActions'],
  observation: HoldingExitLearningObservation,
  step: number,
): HoldingExitAdaptiveParams['sellActions'] {
  const isPartial = observation.finalAction === 'partial_sell' || observation.finalAction === 'partial_exit'
  const isFull = observation.finalAction === 'full_sell' || observation.finalAction === 'full_exit'
  if (!isPartial && !isFull) return sellActions

  const amount = Math.abs(observation.reward) * step
  const loosen = observation.reward >= 0
  return {
    ...sellActions,
    minConfidence: round4(clamp(
      sellActions.minConfidence + (loosen ? -amount : amount),
      0.1,
      0.99,
    )),
    partialSellRatio: isPartial
      ? round4(clamp(
          sellActions.partialSellRatio + (loosen ? amount : -amount),
          0.05,
          0.95,
        ))
      : sellActions.partialSellRatio,
  }
}

function adjustDataQuality(
  dataQuality: HoldingExitAdaptiveParams['dataQuality'],
  observation: HoldingExitLearningObservation,
  step: number,
): HoldingExitAdaptiveParams['dataQuality'] {
  if (observation.featureQualityCoverage == null || observation.flowEvidenceCoverage == null) return dataQuality

  const isMoveTarget = observation.finalAction === 'move_tp2'
  const isSell = observation.finalAction === 'partial_sell'
    || observation.finalAction === 'partial_exit'
    || observation.finalAction === 'full_sell'
    || observation.finalAction === 'full_exit'
  if (!isMoveTarget && !isSell) return dataQuality

  const amount = Math.abs(observation.reward) * step
  const direction = observation.reward >= 0 ? -1 : 1
  const next = { ...dataQuality }

  if (isMoveTarget) {
    next.minCoverageForMoveTarget = round4(clamp(
      next.minCoverageForMoveTarget + direction * amount,
      0.34,
      1,
    ))
    next.minFlowCoverageForMoveTarget = round4(clamp(
      next.minFlowCoverageForMoveTarget + direction * amount,
      0.34,
      1,
    ))
  }

  if (isSell) {
    next.minCoverageForSellAction = round4(clamp(
      next.minCoverageForSellAction + direction * amount,
      0.34,
      1,
    ))
    next.minFlowCoverageForSellAction = round4(clamp(
      next.minFlowCoverageForSellAction + direction * amount,
      0.34,
      1,
    ))
  }

  return next
}

export function updateHoldingExitLearningState(
  previousState: HoldingExitLearningState,
  observation: HoldingExitLearningObservation,
  updatedAt = nowIso(),
): HoldingExitLearningState {
  const state = normalizeHoldingExitLearningState(previousState, updatedAt)
  if (observation.learningEligible === false) return state

  const guardrails = state.guardrails
  const sampleCount = state.sampleCount + 1
  const confidenceScale = clamp(sampleCount / guardrails.fullConfidenceSamples, 0.2, 1)
  const learningImpactWeight = clamp(finiteOr((observation as any).learningImpactWeight, 1), 0.05, 1)
  const learningReward = round6(observation.reward * learningImpactWeight)
  const learningObservation = { ...observation, reward: learningReward }
  const factorUtility = { ...state.factorUtility }
  for (const key of FACTOR_KEYS) {
    const target = learningReward * observation.factorValues[key]
    factorUtility[key] = round6(factorUtility[key] + (target - factorUtility[key]) * guardrails.learningRate)
  }

  const params = cloneParams(state.params)
  params.weights = updateWeights(params.weights, factorUtility, guardrails, confidenceScale)
  const regimeKey = observation.regime === 'bull'
    || observation.regime === 'bear'
    || observation.regime === 'volatile'
    || observation.regime === 'sideways'
    ? observation.regime
    : 'default'
  params.thresholds[regimeKey] = adjustThreshold(
    params.thresholds[regimeKey],
    observation.finalAction,
    learningReward,
    guardrails.thresholdStep * confidenceScale,
    guardrails,
  )
  params.trailAtrMultiplier[regimeKey] = adjustTrailMultiplier(
    params.trailAtrMultiplier[regimeKey],
    learningObservation,
    guardrails.trailMultiplierStep * confidenceScale,
    guardrails,
  )
  if (observation.finalAction === 'move_tp2') {
    const currentTargetMult = params.movingTarget.atrMultiplier[regimeKey]
      ?? params.movingTarget.atrMultiplier.default
    params.movingTarget.atrMultiplier[regimeKey] = round4(clamp(
      currentTargetMult + learningReward * guardrails.trailMultiplierStep * confidenceScale,
      0.2,
      4,
    ))
  }
  params.movingTarget = adjustMovingTargetGuards(
    params.movingTarget,
    learningObservation,
    guardrails.thresholdStep * confidenceScale,
  )
  params.actionGates = adjustActionGates(
    params.actionGates,
    learningObservation,
    guardrails.thresholdStep * confidenceScale,
  )
  params.sellActions = adjustSellActions(
    params.sellActions,
    learningObservation,
    guardrails.thresholdStep * confidenceScale,
  )
  params.dataQuality = adjustDataQuality(
    params.dataQuality,
    learningObservation,
    guardrails.thresholdStep * confidenceScale,
  )

  return {
    ...state,
    paramsVersion: state.paramsVersion + 1,
    sampleCount,
    updatedAt,
    params,
    factorUtility,
    actionStats: {
      ...state.actionStats,
      [observation.finalAction]: updateStat(state.actionStats[observation.finalAction], observation, guardrails.learningRate),
    },
    regimeStats: {
      ...state.regimeStats,
      [regimeKey]: updateStat(state.regimeStats[regimeKey], observation, guardrails.learningRate),
    },
    lastObservation: observation,
  }
}

export async function getHoldingExitLearningState(kv: KVNamespace): Promise<HoldingExitLearningState> {
  const raw = await kv.get(HOLDING_EXIT_LEARNING_KV_KEY, 'json').catch(() => null)
  return normalizeHoldingExitLearningState(raw)
}

export async function getHoldingExitAdaptiveParams(kv: KVNamespace): Promise<HoldingExitAdaptiveParams> {
  const state = await getHoldingExitLearningState(kv)
  return state.params
}

async function putHoldingExitLearningState(kv: KVNamespace, state: HoldingExitLearningState): Promise<void> {
  await kv.put(HOLDING_EXIT_LEARNING_KV_KEY, JSON.stringify(state))
}

function holdingExitReviewEventFromRow(row: any): HoldingExitReviewEventForLearning {
  return {
    status: row.status ?? null,
    reason: row.reason ?? null,
    detail: parseEventDetail(row.detail_json),
    createdAt: row.created_at ?? null,
  }
}

function holdingExitTargetUpdateEventFromRow(row: any): HoldingExitTargetUpdateEventForLearning {
  return {
    status: row.status ?? null,
    reason: row.reason ?? null,
    detail: parseEventDetail(row.detail_json),
    createdAt: row.created_at ?? null,
  }
}

async function loadRecentHoldingExitReviewEvents(
  db: D1Database,
  accountId: number,
  symbol: string,
  options: { entryDate?: string | null; tradeDate?: string | null } = {},
): Promise<HoldingExitReviewEventForLearning[]> {
  try {
    const binds: unknown[] = [accountId, symbol]
    const lifecycleFilters: string[] = []
    const entryDay = String(options.entryDate ?? '').slice(0, 10)
    const tradeDay = String(options.tradeDate ?? '').slice(0, 10)
    if (entryDay) {
      lifecycleFilters.push('AND date(created_at) >= date(?)')
      binds.push(entryDay)
    }
    if (tradeDay) {
      lifecycleFilters.push('AND date(created_at) <= date(?)')
      binds.push(tradeDay)
    }
    const { results } = await db.prepare(`
      SELECT status, reason, detail_json, created_at
        FROM paper_execution_events
       WHERE account_id=?
         AND symbol=?
         AND event_type='holding_exit_review'
         ${lifecycleFilters.join('\n         ')}
       ORDER BY datetime(created_at) DESC
       LIMIT 10
    `).bind(...binds).all<any>()
    return (results ?? []).map(holdingExitReviewEventFromRow)
  } catch (error) {
    if (!/no such table/i.test(String(error))) {
      console.warn(`[HoldingExitLearning] latest review lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return []
  }
}

async function loadRecentHoldingExitTargetUpdateEvents(
  db: D1Database,
  accountId: number,
  symbol: string,
  options: { entryDate?: string | null; tradeDate?: string | null } = {},
): Promise<HoldingExitTargetUpdateEventForLearning[]> {
  try {
    const binds: unknown[] = [accountId, symbol]
    const lifecycleFilters: string[] = []
    const entryDay = String(options.entryDate ?? '').slice(0, 10)
    const tradeDay = String(options.tradeDate ?? '').slice(0, 10)
    if (entryDay) {
      lifecycleFilters.push('AND date(created_at) >= date(?)')
      binds.push(entryDay)
    }
    if (tradeDay) {
      lifecycleFilters.push('AND date(created_at) <= date(?)')
      binds.push(tradeDay)
    }
    const { results } = await db.prepare(`
      SELECT status, reason, detail_json, created_at
        FROM paper_execution_events
       WHERE account_id=?
         AND symbol=?
         AND event_type='holding_exit_target_update'
         ${lifecycleFilters.join('\n         ')}
       ORDER BY datetime(created_at) DESC
       LIMIT 10
    `).bind(...binds).all<any>()
    return (results ?? []).map(holdingExitTargetUpdateEventFromRow)
  } catch (error) {
    if (!/no such table/i.test(String(error))) {
      console.warn(`[HoldingExitLearning] latest target update lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return []
  }
}

function isEventInPositionLifecycle(
  createdAt: string | null | undefined,
  entryDate: string | null | undefined,
  tradeDate: string | null | undefined,
): boolean {
  return isEventOnOrAfterEntryDate(createdAt, entryDate) && isEventOnOrBeforeTradeDate(createdAt, tradeDate)
}

function latestEligibleReviewEvent(
  events: HoldingExitReviewEventForLearning[],
  entryDate: string | null | undefined,
  tradeDate: string | null | undefined,
): HoldingExitReviewEventForLearning | null {
  return events.find((event) => isEventInPositionLifecycle(event.createdAt, entryDate, tradeDate)) ?? null
}

function latestEligibleTargetUpdateEvent(
  events: HoldingExitTargetUpdateEventForLearning[],
  entryDate: string | null | undefined,
  tradeDate: string | null | undefined,
): HoldingExitTargetUpdateEventForLearning | null {
  return events.find((event) => isEventInPositionLifecycle(event.createdAt, entryDate, tradeDate)) ?? null
}

function reviewEventWithMovingTargetLineage(
  reviewEvent: HoldingExitReviewEventForLearning,
  targetEvent: HoldingExitTargetUpdateEventForLearning | null,
  entryDate?: string | null,
  tradeDate?: string | null,
): HoldingExitReviewEventForLearning {
  if (!targetEvent) return reviewEvent
  if (!isEventOnOrAfterEntryDate(targetEvent.createdAt, entryDate)) return reviewEvent
  if (!isEventOnOrBeforeTradeDate(targetEvent.createdAt, tradeDate)) return reviewEvent
  const reviewDetail = parseEventDetail(reviewEvent.detail)
  const existingMovingTarget = asRecord(reviewDetail.moving_tp_target)
  if (existingMovingTarget.action === 'move_tp2') return reviewEvent

  const targetDetail = parseEventDetail(targetEvent.detail)
  if (targetDetail.action !== 'move_tp2') return reviewEvent

  return {
    ...reviewEvent,
    detail: {
      ...reviewDetail,
      moving_tp_target: targetDetail,
      moving_tp_target_lineage: {
        source_event_type: 'holding_exit_target_update',
        source_created_at: targetEvent.createdAt ?? null,
        source_status: targetEvent.status ?? null,
        source_reason: targetEvent.reason ?? null,
      },
    },
  }
}

function isEventOnOrAfterEntryDate(createdAt: string | null | undefined, entryDate: string | null | undefined): boolean {
  const entryDay = String(entryDate ?? '').slice(0, 10)
  if (!entryDay) return true
  const eventDay = String(createdAt ?? '').slice(0, 10)
  if (!eventDay) return false
  return eventDay >= entryDay
}

function isEventOnOrBeforeTradeDate(createdAt: string | null | undefined, tradeDate: string | null | undefined): boolean {
  const exitDay = String(tradeDate ?? '').slice(0, 10)
  if (!exitDay) return true
  const eventDay = String(createdAt ?? '').slice(0, 10)
  if (!eventDay) return false
  return eventDay <= exitDay
}

async function hasRecordedHoldingExitOutcome(
  db: D1Database,
  accountId: number,
  orderId: number | null | undefined,
): Promise<boolean> {
  if (orderId == null || !Number.isFinite(Number(orderId))) return false
  try {
    const row = await db.prepare(`
      SELECT id
        FROM paper_execution_events
       WHERE account_id=?
         AND event_type='holding_exit_outcome'
         AND status IN ('learned','observed')
         AND order_id=?
       LIMIT 1
    `).bind(accountId, orderId).first<any>()
    return Boolean(row)
  } catch (error) {
    if (!/no such table/i.test(String(error))) {
      console.warn(`[HoldingExitLearning] duplicate outcome lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }
}

async function hasRecordedSkippedHoldingExitOutcome(
  db: D1Database,
  accountId: number,
  orderId: number | null | undefined,
  reason: string,
): Promise<boolean> {
  if (orderId == null || !Number.isFinite(Number(orderId))) return false
  try {
    const row = await db.prepare(`
      SELECT id
        FROM paper_execution_events
       WHERE account_id=?
         AND event_type='holding_exit_outcome'
         AND status='skipped'
         AND order_id=?
         AND reason=?
       LIMIT 1
    `).bind(accountId, orderId, reason).first<any>()
    return Boolean(row)
  } catch (error) {
    if (!/no such table/i.test(String(error))) {
      console.warn(`[HoldingExitLearning] skipped outcome duplicate lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }
}

async function recordSkippedHoldingExitOutcome(input: {
  env: Pick<Bindings, 'DB'>
  accountId: number
  tradeDate: string
  symbol: string
  orderId?: number | null
  reason: string
  exitReason: string
  exitSource: string
  entryDate?: string | null
  reviewCreatedAt?: string | null
  detail?: Record<string, unknown>
}): Promise<void> {
  if (await hasRecordedSkippedHoldingExitOutcome(input.env.DB, input.accountId, input.orderId ?? null, input.reason)) return
  await recordPaperExecutionEvent(input.env, {
    accountId: input.accountId,
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    side: 'sell',
    eventType: 'holding_exit_outcome',
    status: 'skipped',
    reason: input.reason,
    detail: {
      skip_reason: input.reason,
      exit_reason: input.exitReason,
      exit_source: input.exitSource,
      entry_date: input.entryDate ?? null,
      review_created_at: input.reviewCreatedAt ?? null,
      ...(input.detail ?? {}),
    },
    orderId: input.orderId ?? null,
    source: input.exitSource,
  })
}

export async function recordHoldingExitSellOutcome(
  input: HoldingExitSellOutcomeInput,
): Promise<HoldingExitSellOutcomeResult> {
  const accountId = input.accountId ?? 1
  if (await hasRecordedHoldingExitOutcome(input.env.DB, accountId, input.orderId ?? null)) {
    return { recorded: false, reason: 'duplicate_holding_exit_outcome' }
  }

  const reviewEvents = await loadRecentHoldingExitReviewEvents(input.env.DB, accountId, input.symbol, {
    entryDate: input.entryDate ?? null,
    tradeDate: input.tradeDate,
  })
  const reviewEvent = latestEligibleReviewEvent(reviewEvents, input.entryDate, input.tradeDate)
  if (!reviewEvent) {
    const latestReviewEvent = (await loadRecentHoldingExitReviewEvents(input.env.DB, accountId, input.symbol))[0] ?? null
    if (latestReviewEvent && !isEventOnOrAfterEntryDate(latestReviewEvent.createdAt, input.entryDate)) {
      await recordSkippedHoldingExitOutcome({
        env: input.env,
        accountId,
        tradeDate: input.tradeDate,
        symbol: input.symbol,
        orderId: input.orderId ?? null,
        reason: 'stale_holding_exit_review',
        exitReason: input.exitReason,
        exitSource: input.exitSource,
        entryDate: input.entryDate ?? null,
        reviewCreatedAt: latestReviewEvent.createdAt ?? null,
      })
      return { recorded: false, reason: 'stale_holding_exit_review' }
    }
    if (latestReviewEvent && !isEventOnOrBeforeTradeDate(latestReviewEvent.createdAt, input.tradeDate)) {
      await recordSkippedHoldingExitOutcome({
        env: input.env,
        accountId,
        tradeDate: input.tradeDate,
        symbol: input.symbol,
        orderId: input.orderId ?? null,
        reason: 'future_holding_exit_review',
        exitReason: input.exitReason,
        exitSource: input.exitSource,
        entryDate: input.entryDate ?? null,
        reviewCreatedAt: latestReviewEvent.createdAt ?? null,
      })
      return { recorded: false, reason: 'future_holding_exit_review' }
    }
    await recordSkippedHoldingExitOutcome({
      env: input.env,
      accountId,
      tradeDate: input.tradeDate,
      symbol: input.symbol,
      orderId: input.orderId ?? null,
      reason: 'missing_holding_exit_review',
      exitReason: input.exitReason,
      exitSource: input.exitSource,
      entryDate: input.entryDate ?? null,
    })
    return { recorded: false, reason: 'missing_holding_exit_review' }
  }
  const targetEvents = await loadRecentHoldingExitTargetUpdateEvents(input.env.DB, accountId, input.symbol, {
    entryDate: input.entryDate ?? null,
    tradeDate: input.tradeDate,
  })
  const targetEvent = latestEligibleTargetUpdateEvent(targetEvents, input.entryDate, input.tradeDate)
  const attributedReviewEvent = reviewEventWithMovingTargetLineage(reviewEvent, targetEvent, input.entryDate, input.tradeDate)

  const observation = buildHoldingExitLearningObservation({
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    shares: input.shares,
    positionSharesBeforeExit: input.positionSharesBeforeExit ?? null,
    exitReason: input.exitReason,
    exitSource: input.exitSource,
    orderId: input.orderId ?? null,
    reviewEvent: attributedReviewEvent,
  })
  if (!observation) {
    await recordSkippedHoldingExitOutcome({
      env: input.env,
      accountId,
      tradeDate: input.tradeDate,
      symbol: input.symbol,
      orderId: input.orderId ?? null,
      reason: 'invalid_holding_exit_outcome',
      exitReason: input.exitReason,
      exitSource: input.exitSource,
      entryDate: input.entryDate ?? null,
      reviewCreatedAt: attributedReviewEvent.createdAt ?? reviewEvent.createdAt ?? null,
    })
    return { recorded: false, reason: 'invalid_holding_exit_outcome' }
  }

  const previous = await getHoldingExitLearningState(input.env.KV)
  const state = updateHoldingExitLearningState(previous, observation)
  const learningEligible = observation.learningEligible !== false
  if (learningEligible) await putHoldingExitLearningState(input.env.KV, state)
  await recordPaperExecutionEvent(input.env, {
    accountId,
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    side: 'sell',
    eventType: 'holding_exit_outcome',
    status: learningEligible ? 'learned' : 'observed',
    reason: input.exitReason,
    detail: {
      observation,
      learning_eligible: learningEligible,
      learning_skipped_reason: learningEligible ? null : `final_candidate_${observation.activeDecisionSource}`,
      params_version: state.paramsVersion,
      sample_count: state.sampleCount,
      learned_params: state.params,
      source_review_created_at: observation.reviewCreatedAt,
    },
    orderId: input.orderId ?? null,
    source: input.exitSource,
  })

  return {
    recorded: true,
    reason: learningEligible ? 'learned' : 'observed_not_learned',
    observation,
    state,
  }
}
