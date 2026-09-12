export interface UnsettledSettlementSummary {
  unsettledBuyAmount: number
  unsettledSellAmount: number
  netUnsettledSettlement: number
}

export interface PaperAccountValueInput {
  settledCash: number
  positionsValue: number
  netUnsettledSettlement?: number | null
  corporateReceivablesValue?: number
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

function requiredAmount(value: unknown, field: string, nonnegative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
    throw new Error(`paper_nav_amount_invalid:${field}`)
  }
  return value
}

export function computePaperTotalValue(input: PaperAccountValueInput): number {
  if (input.corporateReceivablesValue !== undefined &&
    (!Number.isFinite(input.corporateReceivablesValue) || input.corporateReceivablesValue < 0)) {
    throw new Error('paper_corporate_receivable_value_invalid')
  }
  const total = (
    requiredAmount(input.settledCash, 'settledCash')
    + requiredAmount(input.positionsValue, 'positionsValue', true)
    + requiredAmount(input.netUnsettledSettlement === undefined ? 0 : input.netUnsettledSettlement, 'netUnsettledSettlement')
    + (input.corporateReceivablesValue ?? 0)
  )
  return requiredAmount(total, 'totalValue')
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

/** A partial mark is useful for diagnostics, never for a persisted NAV. */
export function requireCompletePaperPositionValue(
  positions: PaperPositionValueInput[], prices: Map<string, number>,
): number {
  const symbols = new Set<string>()
  for (const position of positions) {
    if (!position.symbol?.trim() || position.symbol !== position.symbol.trim() || typeof position.shares !== 'number'
      || !Number.isSafeInteger(position.shares) || position.shares < 0
      || symbols.has(position.symbol)) {
      throw new Error('paper_snapshot_position_invalid')
    }
    symbols.add(position.symbol)
    const price = prices.get(position.symbol)
    if (position.shares > 0 && (typeof price !== 'number' || !Number.isFinite(price) || price <= 0)) {
      throw new Error(`paper_snapshot_held_marks_missing:${position.symbol}`)
    }
  }
  const valuation = computePaperPositionValuation({ positions, quotePrices: prices })
  if (valuation.missingSymbols.length) {
    throw new Error(`paper_snapshot_held_marks_missing:${valuation.missingSymbols.join(',')}`)
  }
  return requiredAmount(valuation.positionsValue, 'positionsValue', true)
}

export async function getUnsettledSettlementSummary(
  db: D1Database,
  accountId: number,
): Promise<UnsettledSettlementSummary> {
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN side='buy' THEN amount ELSE 0 END), 0) AS unsettled_buy_amount,
      COALESCE(SUM(CASE WHEN side='sell' THEN amount ELSE 0 END), 0) AS unsettled_sell_amount,
      COALESCE(SUM(CASE WHEN side IS NULL OR side NOT IN ('buy','sell')
        OR amount IS NULL OR typeof(amount) NOT IN ('integer','real') OR amount < 0
        THEN 1 ELSE 0 END), 0) AS invalid_amount_rows
    FROM paper_settlements
    WHERE account_id=?
      AND settled=0
  `).bind(accountId).first<{
    unsettled_buy_amount: number
    unsettled_sell_amount: number
    invalid_amount_rows: number
  }>()

  // Aggregate over an empty table returns a real row with zero values. A
  // missing response is a database failure, not proof of zero liabilities.
  if (!row || row.invalid_amount_rows !== 0) throw new Error('paper_nav_settlement_rows_invalid')
  const unsettledBuyAmount = requiredAmount(row?.unsettled_buy_amount, 'unsettledBuyAmount', true)
  const unsettledSellAmount = requiredAmount(row?.unsettled_sell_amount, 'unsettledSellAmount', true)
  return {
    unsettledBuyAmount,
    unsettledSellAmount,
    netUnsettledSettlement: unsettledSellAmount - unsettledBuyAmount,
  }
}
