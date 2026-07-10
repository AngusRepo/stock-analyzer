import { normalizeTwEquityTargetPrice } from './twEquityMarketContract'
import type { S12TwExitCalibration } from './s12TwEquityCalibration'

export type TwEquityExitFusionTargets = {
  runnerTp1: number | null
  runnerTp2: number | null
  runnerTp1Source: string | null
  nearPressureTp1: number | null
  nearPressureTp1Source: string | null
  anchors: TwEquityExitFusionAnchors
  recoveredAnchorCount: number
}

export type TwEquityExitFusionAnchors = {
  atrTp1: number | null
  atrTp2: number | null
  mlTp1: number | null
  mlTp2: number | null
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseLifecycle(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null
  } catch {
    return null
  }
}

function uniqueTargets(values: Array<number | null>, floor: number): number[] {
  const sorted = values
    .filter((value): value is number => value != null && value > floor)
    .sort((a, b) => a - b)
  return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]) >= 0.01)
}

function medianTarget(values: Array<number | null>, floor: number): number | null {
  const sorted = uniqueTargets(values, floor)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function extractTwEquityExitFusionAnchorsFromOrderNote(rawNote: unknown): TwEquityExitFusionAnchors {
  const note = parseLifecycle(rawNote) ?? {}
  return {
    atrTp1: positiveNumber(note.atr_tp1 ?? note.atrTp1),
    atrTp2: positiveNumber(note.atr_tp2 ?? note.atrTp2),
    mlTp1: positiveNumber(note.ml_t1 ?? note.ml_target1 ?? note.mlTp1),
    mlTp2: positiveNumber(note.ml_t2 ?? note.ml_target2 ?? note.mlTp2),
  }
}

export function isTwEquityExitFusionEligible(rawLifecycle: unknown): boolean {
  const lifecycle = parseLifecycle(rawLifecycle)
  if (lifecycle?.version !== 'canonical_trade_lifecycle_v1') return false
  if (lifecycle.owners?.exit === 'tw_equity_exit_fusion_v2') return true
  if (lifecycle.owners?.exit !== 's12_position_decision_v1') return false
  const s12 = lifecycle.entry?.s12
  return lifecycle.entry?.source === 's12_assist_entry' && Boolean(s12?.ready) && !Boolean(s12?.invalidated)
}

export function resolveTwEquityExitFusionV2(
  rawLifecycle: unknown,
  fallbackAnchors: Partial<TwEquityExitFusionAnchors> = {},
  calibration: S12TwExitCalibration | null = null,
): TwEquityExitFusionTargets {
  const empty = {
    runnerTp1: null,
    runnerTp2: null,
    runnerTp1Source: null,
    nearPressureTp1: null,
    nearPressureTp1Source: null,
    anchors: { atrTp1: null, atrTp2: null, mlTp1: null, mlTp2: null },
    recoveredAnchorCount: 0,
  }
  const lifecycle = parseLifecycle(rawLifecycle)
  if (lifecycle?.version !== 'canonical_trade_lifecycle_v1') return empty
  if (!isTwEquityExitFusionEligible(lifecycle)) return empty

  const s12 = lifecycle.entry?.s12
  const entryPrice = positiveNumber(lifecycle.entry?.entryPrice) ?? 0
  const exit = lifecycle.exit && typeof lifecycle.exit === 'object' ? lifecycle.exit : {}
  const plan = s12?.exitPlan && typeof s12.exitPlan === 'object' ? s12.exitPlan : {}
  const atr = positiveNumber(exit.atr14)
  const tpMultiplier = positiveNumber(exit.tpMultiplier)
  const tp2Multiplier = positiveNumber(exit.tp2Multiplier)
  const storedAtrTp1 = positiveNumber(exit.anchors?.atrTp1)
  const storedAtrTp2 = positiveNumber(exit.anchors?.atrTp2)
  const storedMlTp1 = positiveNumber(exit.anchors?.mlTp1)
  const storedMlTp2 = positiveNumber(exit.anchors?.mlTp2)
  const atrTp1 = storedAtrTp1 ?? positiveNumber(fallbackAnchors.atrTp1) ?? (
    atr != null && tpMultiplier != null ? entryPrice + atr * tpMultiplier : null
  )
  const atrTp2 = storedAtrTp2 ?? positiveNumber(fallbackAnchors.atrTp2) ?? (
    atr != null && tpMultiplier != null && tp2Multiplier != null
      ? entryPrice + atr * tpMultiplier * tp2Multiplier
      : null
  )
  const mlTp1 = storedMlTp1 ?? positiveNumber(fallbackAnchors.mlTp1)
  const mlTp2 = storedMlTp2 ?? positiveNumber(fallbackAnchors.mlTp2)
  const anchors = { atrTp1, atrTp2, mlTp1, mlTp2 }
  const recoveredAnchorCount = [
    storedAtrTp1 == null && positiveNumber(fallbackAnchors.atrTp1) != null,
    storedAtrTp2 == null && positiveNumber(fallbackAnchors.atrTp2) != null,
    storedMlTp1 == null && positiveNumber(fallbackAnchors.mlTp1) != null,
    storedMlTp2 == null && positiveNumber(fallbackAnchors.mlTp2) != null,
  ].filter(Boolean).length
  const nearPressureTp1 = positiveNumber(plan.tp1)
  const nearPressureTp1Source = String(plan.tp1Source ?? '').trim() || null
  const legacyTp1 = positiveNumber(exit.tp1)
  const legacyTp2 = positiveNumber(exit.tp2)
  const legacyTp1IsPressure = nearPressureTp1 != null && legacyTp1 != null && Math.abs(nearPressureTp1 - legacyTp1) < 0.01
  const structuralStop = positiveNumber(s12?.structureStop) ?? positiveNumber(lifecycle.entry?.stopLoss)
  const calibratedTp1Raw = calibration && calibration.tp1MfeQuantile > 0
    ? entryPrice * (1 + calibration.tp1MfeQuantile)
    : null
  const calibratedTp1 = calibratedTp1Raw != null && (
    structuralStop == null ||
    (calibratedTp1Raw - entryPrice) / Math.max(0.0001, entryPrice - structuralStop) >= calibration!.minNetProfitR
  )
    ? normalizeTwEquityTargetPrice(calibratedTp1Raw)
    : null
  const calibratedTp2 = calibration && calibration.tp2MfeQuantile > 0
    ? normalizeTwEquityTargetPrice(entryPrice * (1 + calibration.tp2MfeQuantile))
    : null
  const runnerTp1Candidates = [
    mlTp1,
    atrTp1,
    calibratedTp1,
    legacyTp1IsPressure ? null : legacyTp1,
  ]
  const runnerTp2Candidates = [
    mlTp2,
    atrTp2,
    calibratedTp2,
    legacyTp2,
  ]
  const runnerTp1Raw = medianTarget(runnerTp1Candidates, entryPrice)
  const runnerTp1 = runnerTp1Raw == null ? null : normalizeTwEquityTargetPrice(runnerTp1Raw)
  const runnerTp2Raw = medianTarget(runnerTp2Candidates, runnerTp1 ?? entryPrice)
  const runnerTp2 = runnerTp2Raw == null ? null : normalizeTwEquityTargetPrice(runnerTp2Raw)
  const runnerOwnerCount = uniqueTargets(runnerTp1Candidates, entryPrice).length

  return {
    runnerTp1,
    runnerTp2,
    runnerTp1Source: runnerTp1 == null
      ? null
      : runnerOwnerCount > 1
        ? 'tw_equity_runner_median_v2'
        : 'tw_equity_runner_fusion_v2',
    nearPressureTp1,
    nearPressureTp1Source,
    anchors,
    recoveredAnchorCount,
  }
}

export function migrateCanonicalLifecycleExitFusionV2(
  rawLifecycle: unknown,
  targets: TwEquityExitFusionTargets,
): string | null {
  const lifecycle = parseLifecycle(rawLifecycle)
  if (lifecycle?.version !== 'canonical_trade_lifecycle_v1' || targets.runnerTp1 == null) {
    return typeof rawLifecycle === 'string' ? rawLifecycle : null
  }
  const next = JSON.parse(JSON.stringify(lifecycle)) as Record<string, any>
  next.owners = next.owners && typeof next.owners === 'object' ? next.owners : {}
  next.owners.exit = 'tw_equity_exit_fusion_v2'
  next.exit = next.exit && typeof next.exit === 'object' ? next.exit : {}
  next.exit.tp1 = targets.runnerTp1
  if (targets.runnerTp2 != null) next.exit.tp2 = targets.runnerTp2
  next.exit.tp1Source = targets.runnerTp1Source ?? 'tw_equity_runner_fusion_v2'
  next.exit.tp2Source = 'tw_equity_runner_fusion_v2'
  next.exit.fusionPolicy = 'tw_equity_exit_fusion_v2'
  next.exit.anchors = targets.anchors
  return JSON.stringify(next)
}
