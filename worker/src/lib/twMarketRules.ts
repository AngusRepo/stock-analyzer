export type TwPriceSnapMode = 'floor' | 'ceil' | 'nearest'
export type TwOrderLotType = 'board_lot' | 'odd_lot'

export interface TwOrderLeg {
  lotType: TwOrderLotType
  shares: number
  finlabQuantity: number
  finlabQuantityUnit: 'lots' | 'shares'
  oddLot: boolean
  orderLot: 'common' | 'intraday_odd'
}

export function getTwTickSize(price: number): number {
  return price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5
}

// In tick units: absorbs binary float noise (8.16 -> 815.99999…) but keeps real
// sub-tick remainders (8.154 -> 815.4), so ceil/floor never round to cents first.
const TW_TICK_SNAP_EPSILON = 1e-6

export function snapToTwPriceTick(price: number, mode: TwPriceSnapMode): number {
  const numericPrice = Number(price)
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return 0

  // The input's band tick is also right for the result: every band boundary
  // (10/50/100/500/1000) is a multiple of both adjacent ticks.
  const tick = getTwTickSize(numericPrice)
  const scaledTick = Math.max(1, Math.round(tick * 100))
  const tickUnits = (numericPrice * 100) / scaledTick
  const units =
    mode === 'ceil'
      ? Math.max(0, Math.ceil(tickUnits - TW_TICK_SNAP_EPSILON))
      : mode === 'nearest'
        ? Math.round(Math.round(numericPrice * 100) / scaledTick)
        : Math.floor(tickUnits + TW_TICK_SNAP_EPSILON)

  return Math.round(units * scaledTick) / 100
}

export function isValidTwTickPrice(price: number): boolean {
  const numericPrice = Number(price)
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return false
  // Same arithmetic as snapToTwPriceTick: valid exactly when ceil and floor agree,
  // so a valid price snaps to one legal tick in every mode.
  const scaledTick = Math.max(1, Math.round(getTwTickSize(numericPrice) * 100))
  const tickUnits = (numericPrice * 100) / scaledTick
  const units = Math.ceil(tickUnits - TW_TICK_SNAP_EPSILON)
  return units >= 1 && units === Math.floor(tickUnits + TW_TICK_SNAP_EPSILON)
}

export function normalizeTwLimitPrice(price: number, side: 'buy' | 'sell'): number {
  return snapToTwPriceTick(price, side === 'buy' ? 'floor' : 'ceil')
}

export function buildTwOrderLegs(shares: number): TwOrderLeg[] {
  const normalizedShares = Math.max(0, Math.floor(Number(shares) || 0))
  const boardShares = Math.floor(normalizedShares / 1000) * 1000
  const oddShares = normalizedShares % 1000
  const legs: TwOrderLeg[] = []

  if (boardShares > 0) {
    legs.push({
      lotType: 'board_lot',
      shares: boardShares,
      finlabQuantity: boardShares / 1000,
      finlabQuantityUnit: 'lots',
      oddLot: false,
      orderLot: 'common',
    })
  }

  if (oddShares > 0) {
    legs.push({
      lotType: 'odd_lot',
      shares: oddShares,
      finlabQuantity: oddShares,
      finlabQuantityUnit: 'shares',
      oddLot: true,
      orderLot: 'intraday_odd',
    })
  }

  return legs
}

export function normalizeTwFilledSharesForRequestedOrder(requestedShares: number, filledShares: number): number {
  const requested = Math.max(0, Math.floor(Number(requestedShares) || 0))
  const filled = Math.min(requested, Math.max(0, Math.floor(Number(filledShares) || 0)))
  if (requested <= 0 || filled <= 0) return 0

  const requestedLegs = buildTwOrderLegs(requested)
  const hasBoardLeg = requestedLegs.some((leg) => leg.lotType === 'board_lot')
  const hasOddLeg = requestedLegs.some((leg) => leg.lotType === 'odd_lot')

  if (hasBoardLeg && !hasOddLeg) return Math.floor(filled / 1000) * 1000
  if (!hasBoardLeg && hasOddLeg) return Math.min(filled, requested % 1000)

  const boardRequested = Math.floor(requested / 1000) * 1000
  const boardFilled = Math.min(boardRequested, Math.floor(filled / 1000) * 1000)
  const oddFilled = Math.min(requested % 1000, Math.max(0, filled - boardFilled))
  return boardFilled + oddFilled
}
