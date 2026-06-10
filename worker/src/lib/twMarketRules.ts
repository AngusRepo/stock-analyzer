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

export function snapToTwPriceTick(price: number, mode: TwPriceSnapMode): number {
  const numericPrice = Number(price)
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return 0

  const tick = getTwTickSize(numericPrice)
  const scaledPrice = Math.round(numericPrice * 100)
  const scaledTick = Math.max(1, Math.round(tick * 100))
  const units =
    mode === 'ceil'
      ? Math.ceil(scaledPrice / scaledTick)
      : mode === 'nearest'
        ? Math.round(scaledPrice / scaledTick)
        : Math.floor(scaledPrice / scaledTick)

  return Math.round(units * scaledTick) / 100
}

export function isValidTwTickPrice(price: number): boolean {
  const numericPrice = Number(price)
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return false
  return Math.abs(snapToTwPriceTick(numericPrice, 'nearest') - numericPrice) < 0.000001
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
