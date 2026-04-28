export interface RealizedPnlInput {
  entryPrice: number
  exitPrice: number
  shares: number
  commission?: number | null
  tax?: number | null
}

export interface RealizedPnlSnapshot {
  entry_price: number
  exit_price: number
  shares: number
  gross_pnl: number
  fees: number
  realized_pnl: number
  realized_pnl_pct: number
}

export interface SellOrderRowForPnl {
  price: number
  shares: number
  commission?: number | null
  tax?: number | null
  note?: unknown
}

export function calcRealizedPnlSnapshot(input: RealizedPnlInput): RealizedPnlSnapshot {
  const shares = Math.max(0, Math.floor(input.shares))
  const entryPrice = Number(input.entryPrice)
  const exitPrice = Number(input.exitPrice)
  const commission = Number(input.commission ?? 0)
  const tax = Number(input.tax ?? 0)
  const grossPnl = (exitPrice - entryPrice) * shares
  const fees = commission + tax
  const realizedPnl = grossPnl - fees
  const costBasis = entryPrice * shares

  return {
    entry_price: entryPrice,
    exit_price: exitPrice,
    shares,
    gross_pnl: Math.round(grossPnl),
    fees: Math.round(fees),
    realized_pnl: Math.round(realizedPnl),
    realized_pnl_pct: costBasis > 0 ? Math.round((realizedPnl / costBasis * 100) * 100) / 100 : 0,
  }
}

export function parseSellOrderNote(note: unknown): Record<string, unknown> {
  if (!note) return {}
  if (typeof note === 'object' && !Array.isArray(note)) return note as Record<string, unknown>
  if (typeof note !== 'string') return {}
  try {
    const parsed = JSON.parse(note)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return { memo: note }
  }
}

export function buildSellOrderNote(
  base: Record<string, unknown>,
  pnlInput: RealizedPnlInput,
): string {
  return JSON.stringify({
    ...base,
    ...calcRealizedPnlSnapshot(pnlInput),
  })
}

export function estimateSellOrderRealizedPnl(row: SellOrderRowForPnl): number | null {
  const note = parseSellOrderNote(row.note)
  const notePnl = Number(note.realized_pnl)
  if (Number.isFinite(notePnl)) return notePnl

  const entryPrice = Number(note.entry_price)
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null

  return calcRealizedPnlSnapshot({
    entryPrice,
    exitPrice: Number(row.price),
    shares: Number(row.shares),
    commission: row.commission,
    tax: row.tax,
  }).realized_pnl
}

export function summarizeSellOrderLosses(rows: SellOrderRowForPnl[]): { losses: number; total: number } {
  let losses = 0
  let total = 0
  for (const row of rows) {
    const pnl = estimateSellOrderRealizedPnl(row)
    if (pnl == null) continue
    total += 1
    if (pnl < 0) losses += 1
  }
  return { losses, total }
}
