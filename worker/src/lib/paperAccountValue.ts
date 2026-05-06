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

function finiteNumber(value: unknown): number {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? numeric : 0
}

export function computePaperTotalValue(input: PaperAccountValueInput): number {
  return (
    finiteNumber(input.settledCash)
    + finiteNumber(input.positionsValue)
    + finiteNumber(input.netUnsettledSettlement)
  )
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
