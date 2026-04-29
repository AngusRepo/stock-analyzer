export interface EntryPriceCapInput {
  entryPrice: number | null | undefined
  stopLoss?: number | null
  target1?: number | null
  target2?: number | null
  latestClose?: number | null
  maxPremiumPct: number
}

export interface EntryPriceCapResult {
  entryPrice: number
  stopLoss: number | null
  target1: number | null
  target2: number | null
  capped: boolean
  watchPoint?: string
}

function round2(value: number): number {
  return Math.round(value * 100 + 1e-9) / 100
}

function normalizeOptionalPrice(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function capEntryToLatestClose(input: EntryPriceCapInput): EntryPriceCapResult {
  const entryPrice = normalizeOptionalPrice(input.entryPrice)
  if (entryPrice == null) {
    return {
      entryPrice: 0,
      stopLoss: normalizeOptionalPrice(input.stopLoss),
      target1: normalizeOptionalPrice(input.target1),
      target2: normalizeOptionalPrice(input.target2),
      capped: false,
    }
  }

  const latestClose = normalizeOptionalPrice(input.latestClose)
  const stopLoss = normalizeOptionalPrice(input.stopLoss)
  const target1 = normalizeOptionalPrice(input.target1)
  const target2 = normalizeOptionalPrice(input.target2)
  if (latestClose == null) {
    return { entryPrice, stopLoss, target1, target2, capped: false }
  }

  const maxEntry = round2(latestClose * (1 + input.maxPremiumPct))
  if (entryPrice <= maxEntry) {
    return { entryPrice, stopLoss, target1, target2, capped: false }
  }

  const ratio = maxEntry / entryPrice
  return {
    entryPrice: maxEntry,
    stopLoss: stopLoss != null ? round2(stopLoss * ratio) : null,
    target1: target1 != null ? round2(target1 * ratio) : null,
    target2: target2 != null ? round2(target2 * ratio) : null,
    capped: true,
    watchPoint: `Entry capped to latest close + ${(input.maxPremiumPct * 100).toFixed(1)}% (${latestClose} -> ${maxEntry})`,
  }
}
