export type BoardType = 'LISTED' | 'OTC' | 'EMERGING' | 'ETF' | 'UNKNOWN'
export type TradabilityTier = 'auto_tradable' | 'research_only' | 'blocked' | 'unknown'
export type RecommendationLane = 'tradable' | 'emerging_watchlist' | 'research_only'

export interface BoardClassificationInput {
  market?: string | null
  open?: number | null
  avg_price?: number | null
  symbol?: string | null
  restricted?: boolean | null
}

export interface BoardClassification {
  boardType: BoardType
  tradabilityTier: TradabilityTier
  recommendationLane: RecommendationLane
  eligibleForMl: boolean
  eligibleForPendingBuy: boolean
  reason: string
}

export function isEmergingStylePriceRow(row: { open?: number | null; avg_price?: number | null }): boolean {
  return row.open == null && row.avg_price != null && Number(row.avg_price) > 0
}

export function normalizeBoardType(market?: string | null): BoardType {
  const value = String(market ?? '').trim().toUpperCase()
  if (value === 'TWSE' || value === 'TSE' || value === 'LISTED' || value === 'SII') return 'LISTED'
  if (value === 'OTC' || value === 'TPEX') return 'OTC'
  if (value === 'EMERGING' || value === 'ESB' || value === 'ROTC') return 'EMERGING'
  if (value === 'ETF') return 'ETF'
  return 'UNKNOWN'
}

export function recommendationLaneForBoard(boardType: BoardType): RecommendationLane {
  if (boardType === 'EMERGING') return 'emerging_watchlist'
  if (boardType === 'LISTED' || boardType === 'OTC') return 'tradable'
  return 'research_only'
}

export function classifyBoard(input: BoardClassificationInput): BoardClassification {
  const marketBoard = normalizeBoardType(input.market)
  const boardType = isEmergingStylePriceRow(input) ? 'EMERGING' : marketBoard

  if (input.restricted === true) {
    return {
      boardType,
      tradabilityTier: 'blocked',
      recommendationLane: 'research_only',
      eligibleForMl: false,
      eligibleForPendingBuy: false,
      reason: 'trading_restricted',
    }
  }

  if (boardType === 'EMERGING') {
    return {
      boardType,
      tradabilityTier: 'research_only',
      recommendationLane: 'emerging_watchlist',
      eligibleForMl: true,
      eligibleForPendingBuy: false,
      reason: isEmergingStylePriceRow(input) ? 'emerging_price_shape' : 'emerging_market',
    }
  }

  if (boardType === 'LISTED' || boardType === 'OTC') {
    const executable = input.open != null && Number(input.open) > 0
    return {
      boardType,
      tradabilityTier: executable ? 'auto_tradable' : 'unknown',
      recommendationLane: executable ? 'tradable' : 'research_only',
      eligibleForMl: executable,
      eligibleForPendingBuy: executable,
      reason: executable ? 'regular_ohlc' : 'missing_executable_open',
    }
  }

  return {
    boardType,
    tradabilityTier: 'unknown',
    recommendationLane: 'research_only',
    eligibleForMl: false,
    eligibleForPendingBuy: false,
    reason: 'unknown_board',
  }
}
