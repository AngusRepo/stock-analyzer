import type { OhlcvEntryPlan, OhlcvRow } from './ohlcvTradePlanLevels'
import type { PriceActionStructure, PriceActionZoneStatus } from './priceActionStructure'

export type EntryPriceModelV2AnchorSource =
  | 'tick_volume_profile'
  | 'intraday_volume_profile'
  | 'daily_proxy_fallback'

export type EntryPriceRetestStatus = 'none' | 'waiting' | 'confirmed' | 'failed'

export interface EntryPriceModelV2L5Support {
  quoteAgeMs: number | null
  spreadPct: number | null
  depthOk: boolean
  imbalance: number | null
}

export interface EntryPriceModelV2 {
  modelVersion: 'entry_price_model_v2'
  anchorSource: EntryPriceModelV2AnchorSource
  poc: number | null
  vah: number | null
  val: number | null
  discountLow: number | null
  discountHigh: number | null
  equilibrium: number | null
  premiumLow: number | null
  premiumHigh: number | null
  orderBlockLow: number | null
  orderBlockHigh: number | null
  fvgLow: number | null
  fvgHigh: number | null
  retestStatus: EntryPriceRetestStatus
  entryLow: number
  entryHigh: number
  preferredEntry: number
  chaseCeiling: number
  stopAnchor: number
  l5Support: EntryPriceModelV2L5Support
  confidence: number
  fallbackReason?: string
}

export interface VolumeProfileV2 {
  poc: number | null
  vah: number | null
  val: number | null
  valueAreaVolumePct: number
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function round2(value: number): number {
  return Math.round(value * 100 + 1e-9) / 100
}

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function emptyL5Support(): EntryPriceModelV2L5Support {
  return {
    quoteAgeMs: null,
    spreadPct: null,
    depthOk: false,
    imbalance: null,
  }
}

export function buildVolumeProfileV2(
  rows: OhlcvRow[],
  options: { binCount?: number; valueAreaPct?: number } = {},
): VolumeProfileV2 {
  const usable = rows.filter((row) => (
    finitePositive(row.high) != null &&
    finitePositive(row.low) != null &&
    finitePositive(row.close) != null &&
    Number(row.volume) > 0
  ))
  if (!usable.length) return { poc: null, vah: null, val: null, valueAreaVolumePct: 0 }
  const low = Math.min(...usable.map((row) => row.low))
  const high = Math.max(...usable.map((row) => row.high))
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return { poc: null, vah: null, val: null, valueAreaVolumePct: 0 }
  }

  const binCount = Math.max(8, Math.min(96, Math.round(options.binCount ?? 32)))
  const targetPct = bounded(Number(options.valueAreaPct ?? 0.7), 0.5, 0.9)
  const width = (high - low) / binCount
  const bins = Array.from({ length: binCount }, () => 0)
  let totalVolume = 0

  for (const row of usable) {
    const volume = Math.max(0, Number(row.volume))
    totalVolume += volume
    const rowLow = Math.max(low, row.low)
    const rowHigh = Math.min(high, row.high)
    const first = Math.max(0, Math.min(binCount - 1, Math.floor((rowLow - low) / width)))
    const last = Math.max(first, Math.min(binCount - 1, Math.floor((rowHigh - low) / width)))
    const share = volume / (last - first + 1)
    for (let idx = first; idx <= last; idx += 1) bins[idx] += share
  }

  const maxVolume = Math.max(...bins)
  if (totalVolume <= 0 || maxVolume <= 0) return { poc: null, vah: null, val: null, valueAreaVolumePct: 0 }
  const pocIndex = bins.findIndex((value) => value === maxVolume)
  const selected = new Set<number>([pocIndex])
  let selectedVolume = bins[pocIndex]
  let left = pocIndex - 1
  let right = pocIndex + 1
  while (selectedVolume / totalVolume < targetPct && (left >= 0 || right < bins.length)) {
    const leftValue = left >= 0 ? bins[left] : -1
    const rightValue = right < bins.length ? bins[right] : -1
    if (rightValue > leftValue) {
      selected.add(right)
      selectedVolume += rightValue
      right += 1
    } else {
      selected.add(left)
      selectedVolume += leftValue
      left -= 1
    }
  }

  const indexes = [...selected].sort((a, b) => a - b)
  return {
    poc: round2(low + (pocIndex + 0.5) * width),
    val: round2(low + indexes[0] * width),
    vah: round2(low + (indexes[indexes.length - 1] + 1) * width),
    valueAreaVolumePct: Math.round((selectedVolume / totalVolume) * 1000) / 1000,
  }
}

export function buildEntryPriceModelV2FromOhlcvPlan(
  plan: OhlcvEntryPlan,
  options: {
    anchorSource?: EntryPriceModelV2AnchorSource
    profile?: VolumeProfileV2 | null
    priceActionStructure?: PriceActionStructure | null
    l5Support?: Partial<EntryPriceModelV2L5Support> | null
    fallbackReason?: string
  } = {},
): EntryPriceModelV2 {
  const profile = options.profile ?? null
  const priceAction = options.priceActionStructure ?? null
  const orderBlock = priceAction?.bestOrderBlock ?? null
  const fvg = priceAction?.bestFvg ?? null
  const anchorSource = options.anchorSource ?? 'daily_proxy_fallback'
  const swingLow = Math.min(plan.support, plan.buyReferenceLow, plan.stopLoss)
  const swingHigh = Math.max(plan.resistance, plan.confirmation, plan.optimisticHigh)
  const range = Math.max(0.01, swingHigh - swingLow)
  const equilibrium = round2(swingLow + range * 0.5)
  const discountLow = round2(swingLow)
  const discountHigh = round2(swingLow + range * 0.5)
  const premiumLow = equilibrium
  const premiumHigh = round2(swingHigh)
  const profileVal = finitePositive(profile?.val)
  const profileVah = finitePositive(profile?.vah)
  const profilePoc = finitePositive(profile?.poc)
  const entryLow = round2(Math.max(
    swingLow,
    Math.min(plan.buyReferenceLow, profileVal ?? plan.buyReferenceLow),
  ))
  const entryHighBase = plan.mode === 'pullback'
    ? Math.min(plan.confirmation, Math.max(plan.buyReferenceHigh, profilePoc ?? plan.buyReferenceHigh))
    : Math.max(plan.confirmation, profileVah ?? plan.confirmation)
  const entryHigh = round2(Math.max(entryLow, entryHighBase))
  const preferredEntry = round2(plan.mode === 'pullback'
    ? Math.min(entryHigh, Math.max(entryLow, profilePoc ?? plan.entryPrice))
    : Math.max(plan.entryPrice, plan.confirmation))
  const chaseCeiling = round2(Math.max(
    plan.optimisticHigh,
    profileVah ?? 0,
    plan.confirmation,
  ))
  const retestStatus = entryRetestStatusFromPriceAction([
    orderBlock?.status ?? null,
    fvg?.status ?? null,
  ])
  const structureConfidenceBoost = retestStatus === 'confirmed'
    ? 0.08
    : retestStatus === 'waiting'
      ? 0.03
      : retestStatus === 'failed'
        ? -0.08
        : 0
  const baseConfidence = anchorSource === 'daily_proxy_fallback' ? 0.45 : 0.72

  return {
    modelVersion: 'entry_price_model_v2',
    anchorSource,
    poc: profilePoc ?? plan.volumeNode ?? null,
    vah: profileVah ?? null,
    val: profileVal ?? null,
    discountLow,
    discountHigh,
    equilibrium,
    premiumLow,
    premiumHigh,
    orderBlockLow: orderBlock?.low ?? null,
    orderBlockHigh: orderBlock?.high ?? null,
    fvgLow: fvg?.low ?? null,
    fvgHigh: fvg?.high ?? null,
    retestStatus,
    entryLow,
    entryHigh,
    preferredEntry,
    chaseCeiling,
    stopAnchor: round2(plan.stopLoss),
    l5Support: {
      ...emptyL5Support(),
      ...(options.l5Support ?? {}),
    },
    confidence: bounded(round2(baseConfidence + structureConfidenceBoost), 0, 1),
    fallbackReason: options.fallbackReason ?? (anchorSource === 'daily_proxy_fallback' ? 'ohlcv_trade_plan_proxy' : undefined),
  }
}

export function formatEntryPriceModelV2WatchPoint(model: EntryPriceModelV2): string {
  return [
    'entry_price_model_v2:',
    `source=${model.anchorSource}`,
    `entry=${model.entryLow}~${model.entryHigh}`,
    `preferred=${model.preferredEntry}`,
    `chase_ceiling=${model.chaseCeiling}`,
    `premium=${model.premiumLow ?? 'na'}~${model.premiumHigh ?? 'na'}`,
    `discount=${model.discountLow ?? 'na'}~${model.discountHigh ?? 'na'}`,
    `poc=${model.poc ?? 'na'}`,
    `order_block=${model.orderBlockLow ?? 'na'}~${model.orderBlockHigh ?? 'na'}`,
    `fvg=${model.fvgLow ?? 'na'}~${model.fvgHigh ?? 'na'}`,
    `retest=${model.retestStatus}`,
    model.fallbackReason ? `fallback=${model.fallbackReason}` : null,
  ].filter(Boolean).join(' ')
}

function entryRetestStatusFromPriceAction(statuses: Array<PriceActionZoneStatus | null>): EntryPriceRetestStatus {
  const clean = statuses.filter((status): status is PriceActionZoneStatus => status != null)
  if (!clean.length) return 'none'
  if (clean.some((status) => status === 'retested')) return 'confirmed'
  if (clean.some((status) => status === 'untested')) return 'waiting'
  return 'failed'
}
