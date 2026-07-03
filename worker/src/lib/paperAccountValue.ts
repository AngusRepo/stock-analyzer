export interface UnsettledSettlementSummary {
  unsettledBuyAmount: number
  unsettledSellAmount: number
  netUnsettledSettlement: number
}

export interface PaperAccountValueInput {
  settledCash: number
  positionsValue: number
  netUnsettledSettlement?: number | null
}

export interface PaperPositionValueInput {
  symbol: string
  shares: number
}

export interface PaperPositionValuationResult {
  positionsValue: number
  symbolPrices: Map<string, number>
  quoteSymbols: string[]
  fallbackSymbols: string[]
  missingSymbols: string[]
}

function finiteNumber(value: unknown): number {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? numeric : 0
}

function positiveFiniteNumber(value: unknown): number | null {
  const numeric = finiteNumber(value)
  return numeric > 0 ? numeric : null
}

export function computePaperTotalValue(input: PaperAccountValueInput): number {
  return (
    finiteNumber(input.settledCash)
    + finiteNumber(input.positionsValue)
    + finiteNumber(input.netUnsettledSettlement)
  )
}

export function computePaperPositionValuation(input: {
  positions: PaperPositionValueInput[]
  quotePrices?: Map<string, number> | null
  fallbackPrices?: Map<string, number> | null
}): PaperPositionValuationResult {
  const symbolPrices = new Map<string, number>()
  const quoteSymbols = new Set<string>()
  const fallbackSymbols = new Set<string>()
  const missingSymbols = new Set<string>()
  let positionsValue = 0

  for (const position of input.positions ?? []) {
    const symbol = String(position.symbol ?? '').trim()
    const shares = positiveFiniteNumber(position.shares)
    if (!symbol || shares == null) continue

    const quotePrice = positiveFiniteNumber(input.quotePrices?.get(symbol))
    const fallbackPrice = positiveFiniteNumber(input.fallbackPrices?.get(symbol))
    const price = quotePrice ?? fallbackPrice
    if (price == null) {
      missingSymbols.add(symbol)
      continue
    }

    symbolPrices.set(symbol, price)
    positionsValue += price * shares
    if (quotePrice != null) quoteSymbols.add(symbol)
    else fallbackSymbols.add(symbol)
  }

  return {
    positionsValue,
    symbolPrices,
    quoteSymbols: [...quoteSymbols].sort(),
    fallbackSymbols: [...fallbackSymbols].sort(),
    missingSymbols: [...missingSymbols].sort(),
  }
}

export async function getUnsettledSettlementSummary(
  db: D1Database,
  accountId: number,
): Promise<UnsettledSettlementSummary> {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN side='buy' THEN amount ELSE 0 END), 0) AS unsettled_buy_amount,
      COALESCE(SUM(CASE WHEN side='sell' THEN amount ELSE 0 END), 0) AS unsettled_sell_amount
    FROM paper_settlements
    WHERE account_id=?
      AND settled=0
  `).bind(accountId).first<{
    unsettled_buy_amount: number
    unsettled_sell_amount: number
  }>()

  const unsettledBuyAmount = finiteNumber(row?.unsettled_buy_amount)
  const unsettledSellAmount = finiteNumber(row?.unsettled_sell_amount)
  return {
    unsettledBuyAmount,
    unsettledSellAmount,
    netUnsettledSettlement: unsettledSellAmount - unsettledBuyAmount,
  }
}
