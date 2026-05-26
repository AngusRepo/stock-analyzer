export type TradePlanStructureSource = 'ohlcv' | 'alpha_fallback'

export type TradePlanStructureInput = {
  source?: string | null
  latest?: number | string | null
  resistance?: number | string | null
  confirmation?: number | string | null
  support?: number | string | null
  atrDefense?: number | string | null
  volumeNode?: number | string | null
  buyReferenceLow?: number | string | null
  buyReferenceHigh?: number | string | null
  optimisticLow?: number | string | null
  optimisticHigh?: number | string | null
}

export type AlphaStructureInput = {
  latestClose?: number | string | null
  poc?: number | string | null
  fairValueLow?: number | string | null
  fairValueHigh?: number | string | null
  optimisticValueHigh?: number | string | null
}

export type TradePlanStructureZones = {
  source: TradePlanStructureSource
  latest: string | null
  resistance: string | null
  confirmation: string | null
  support: string | null
  atrDefense: string | null
  volumeNode: string | null
  buyReferenceZone: string
  optimisticPriceRange: string
  breakoutChaseZone: string
}

export const DEFAULT_STRONG_BREAKOUT_CHASE_PCT = 0.018

function finitePrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function priceText(value: unknown): string | null {
  const n = finitePrice(value)
  return n == null ? null : n.toFixed(2)
}

function rangeText(first: unknown, second: unknown): string {
  const a = finitePrice(first)
  const b = finitePrice(second)
  if (a == null && b == null) return '-'
  if (a == null) return priceText(b) ?? '-'
  if (b == null) return priceText(a) ?? '-'
  if (a === b) return priceText(a) ?? '-'
  const low = Math.min(a, b)
  const high = Math.max(a, b)
  return `${low.toFixed(2)}~${high.toFixed(2)}`
}

export function buildTradePlanStructureZones(
  plan: TradePlanStructureInput | null | undefined,
  context: AlphaStructureInput | null | undefined,
  strongBreakoutChasePct = DEFAULT_STRONG_BREAKOUT_CHASE_PCT,
): TradePlanStructureZones {
  const usesOhlcv = plan?.source === 'ohlcv'
  const source: TradePlanStructureSource = usesOhlcv ? 'ohlcv' : 'alpha_fallback'
  const latestValue = usesOhlcv ? plan?.latest : (plan?.latest ?? context?.latestClose)
  const supportValue = usesOhlcv ? plan?.support : (plan?.support ?? context?.fairValueLow ?? context?.poc)
  const volumeNodeValue = usesOhlcv ? plan?.volumeNode : (plan?.volumeNode ?? context?.poc)
  const confirmationValue = usesOhlcv ? plan?.confirmation : (plan?.confirmation ?? context?.fairValueHigh ?? context?.optimisticValueHigh)
  const resistanceValue = usesOhlcv ? plan?.resistance : (plan?.resistance ?? context?.optimisticValueHigh ?? context?.fairValueHigh)
  const atrDefenseValue = usesOhlcv ? plan?.atrDefense : (plan?.atrDefense ?? context?.fairValueLow ?? context?.poc)
  const confirmation = finitePrice(confirmationValue)
  const breakoutLimit = confirmation == null ? null : confirmation * (1 + strongBreakoutChasePct)
  const optimisticHighCandidate = usesOhlcv
    ? (finitePrice(plan?.optimisticHigh) ?? finitePrice(resistanceValue))
    : finitePrice(resistanceValue)
  const optimisticHigh = confirmation == null
    ? optimisticHighCandidate
    : Math.max(
      confirmation,
      breakoutLimit ?? confirmation,
      optimisticHighCandidate ?? confirmation,
    )
  const optimisticLow = usesOhlcv ? (plan?.optimisticLow ?? confirmationValue) : confirmationValue
  const buyReferenceLow = usesOhlcv ? (plan?.buyReferenceLow ?? supportValue) : supportValue
  const buyReferenceHigh = usesOhlcv ? (plan?.buyReferenceHigh ?? volumeNodeValue) : volumeNodeValue

  return {
    source,
    latest: priceText(latestValue),
    resistance: priceText(resistanceValue),
    confirmation: priceText(confirmationValue),
    support: priceText(supportValue),
    atrDefense: priceText(atrDefenseValue),
    volumeNode: priceText(volumeNodeValue),
    buyReferenceZone: rangeText(buyReferenceLow, buyReferenceHigh),
    optimisticPriceRange: rangeText(optimisticLow, optimisticHigh),
    breakoutChaseZone: rangeText(confirmationValue, breakoutLimit),
  }
}
