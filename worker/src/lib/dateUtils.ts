/**
 * dateUtils.ts — Taiwan timezone helpers
 *
 * Cloudflare Workers 沒有 timezone support，用固定 UTC+8 offset 計算台灣時間。
 */

const TW_OFFSET_MS = 8 * 3600_000

export function twNow(): Date {
  return new Date(Date.now() + TW_OFFSET_MS)
}

export function twToday(): string {
  return twNow().toISOString().slice(0, 10)
}

export function twDaysAgo(days: number): string {
  return new Date(Date.now() + TW_OFFSET_MS - days * 86400000).toISOString().slice(0, 10)
}

/**
 * T+2 settlement date：從 tradeDate 開始跳 2 個 business day（排除週末 + KV holiday）。
 * @param tradeDate YYYY-MM-DD
 * @param kv KVNamespace — 查 holiday:{date} key
 */
export async function getSettlementDate(tradeDate: string, kv: KVNamespace): Promise<string> {
  let d = new Date(tradeDate + 'T00:00:00Z')
  let bizDays = 0
  while (bizDays < 2) {
    d = new Date(d.getTime() + 86400_000)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue // skip weekend
    const dateStr = d.toISOString().slice(0, 10)
    const isHoliday = await kv.get(`holiday:${dateStr}`)
    if (isHoliday) continue
    bizDays++
  }
  return d.toISOString().slice(0, 10)
}

/**
 * 查詢 paper_settlements 算出可用購買力。
 * available = settled_cash - pending_buys + same_settlement_date_sell_offsets
 */
export async function getAvailableCash(db: D1Database, accountId: number): Promise<number> {
  const acc = await db.prepare('SELECT cash FROM paper_accounts WHERE id=?').bind(accountId).first<{ cash: number }>()
  const settledCash = acc?.cash ?? 0

  // Pending buys（尚未結算的買入金額）
  const pendingBuys = await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) as total FROM paper_settlements WHERE account_id=? AND side=\'buy\' AND settled=0'
  ).bind(accountId).first<{ total: number }>()

  // Same-settlement-date sell offsets：同一 settlement_date 的賣出可抵銷買入
  // 找出所有 pending buy 的 settlement_dates
  const buySettleDates = await db.prepare(
    'SELECT DISTINCT settlement_date FROM paper_settlements WHERE account_id=? AND side=\'buy\' AND settled=0'
  ).bind(accountId).all<{ settlement_date: string }>()
  const buyDates = (buySettleDates?.results ?? []).map(r => r.settlement_date)

  let sellOffset = 0
  if (buyDates.length > 0) {
    // 查同 settlement_date 的 pending sells
    const placeholders = buyDates.map(() => '?').join(',')
    const sellResult = await db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM paper_settlements WHERE account_id=? AND side='sell' AND settled=0 AND settlement_date IN (${placeholders})`
    ).bind(accountId, ...buyDates).first<{ total: number }>()
    sellOffset = sellResult?.total ?? 0
  }

  return settledCash - (pendingBuys?.total ?? 0) + sellOffset
}
