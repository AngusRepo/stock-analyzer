import { getExitMultiplier, getExitOrder, type MarketRegime } from './dynamicExitPriority'
import { readCurrentRegimeFamily } from './marketRegimeState'

export async function getPrevTradingDay(db: D1Database, kv?: KVNamespace): Promise<string> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  if (kv) {
    const dt = new Date(`${today}T00:00:00Z`)
    for (let i = 1; i <= 14; i += 1) {
      const d = new Date(dt.getTime() - i * 86400000)
      const dateStr = d.toISOString().slice(0, 10)
      const dayOfWeek = d.getUTCDay()
      if (dayOfWeek === 0 || dayOfWeek === 6) continue
      const isHoliday = await kv.get(`holiday:${dateStr}`)
      if (isHoliday) continue
      return dateStr
    }
  }

  const row = await db.prepare(
    'SELECT date FROM daily_recommendations WHERE date < ? ORDER BY date DESC LIMIT 1',
  ).bind(today).first<{ date: string }>()
  return row?.date ?? new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10)
}

export async function getCurrentRegime(kv: KVNamespace): Promise<MarketRegime | null> {
  return await readCurrentRegimeFamily(kv)
}

export function logRegimeShadow(
  caller: string,
  symbol: string,
  regime: MarketRegime,
  actualAction: string,
  actualReason: string,
  db?: D1Database,
): void {
  const hypOrder = getExitOrder(regime)
  const hypMult = {
    hardStop: getExitMultiplier(regime, 'hardStop'),
    atrTrail: getExitMultiplier(regime, 'atrTrail'),
    tp1: getExitMultiplier(regime, 'tp1'),
    tp2: getExitMultiplier(regime, 'tp2'),
    timeStop: getExitMultiplier(regime, 'timeStop'),
  }
  const ts = new Date().toISOString()
  console.log(JSON.stringify({
    event: 'regime_shadow',
    caller,
    symbol,
    regime,
    actual_action: actualAction,
    actual_reason: actualReason,
    hypothetical_order: hypOrder,
    hypothetical_mult: hypMult,
    ts,
  }))

  if (db) {
    const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    db.prepare(
      'INSERT INTO exit_shadow_log (ts, date, caller, symbol, regime, actual_action, actual_reason, hypothetical_order, hypothetical_mult) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      ts,
      twDate,
      caller,
      symbol,
      regime,
      actualAction,
      actualReason ?? null,
      JSON.stringify(hypOrder),
      JSON.stringify(hypMult),
    ).run().catch((e: any) => console.warn(`[ExitShadow] D1 insert failed: ${e?.message ?? e}`))
  }
}

export async function recordSellSettlement(
  db: D1Database,
  kv: KVNamespace,
  accountId: number,
  symbol: string,
  proceeds: number,
): Promise<number | null> {
  const { getSettlementDate } = await import('./dateUtils')
  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const settleDate = await getSettlementDate(todayStr, kv)
  const lastOrder = await db.prepare(
    "SELECT id FROM paper_orders WHERE account_id=? AND symbol=? AND side='sell' ORDER BY id DESC LIMIT 1",
  ).bind(accountId, symbol).first<{ id: number }>()

  await db.prepare(
    "INSERT INTO paper_settlements (account_id, order_id, symbol, side, amount, trade_date, settlement_date) VALUES (?, ?, ?, 'sell', ?, ?, ?)",
  ).bind(accountId, lastOrder?.id ?? 0, symbol, proceeds, todayStr, settleDate).run()
  return lastOrder?.id ?? null
}

export async function isDayTradeAllowed(
  symbol: string,
  shares: number,
  exitReason: string,
  kv: KVNamespace,
): Promise<{ allowed: boolean; reason: string }> {
  if (shares % 1000 !== 0) return { allowed: false, reason: '僅允許整股當沖' }

  const raw = await kv.get('market:daytrade_eligible')
  if (!raw) return { allowed: false, reason: '缺少當沖白名單資料（KV 未就緒）' }
  try {
    const eligible = JSON.parse(raw) as string[]
    if (!eligible.includes(symbol)) return { allowed: false, reason: `${symbol} 不在當沖白名單` }
  } catch {
    return { allowed: false, reason: '當沖白名單 KV 解析失敗' }
  }

  const allowedTriggers = ['硬停損', 'ATR 初始停損', 'Trailing Stop', 'TP1', 'TP2']
  if (!allowedTriggers.some((trigger) => exitReason.includes(trigger))) {
    return { allowed: false, reason: `不允許的當沖觸發原因: ${exitReason}` }
  }

  return { allowed: true, reason: '當沖條件檢查通過' }
}

export async function getLatestPrice(db: D1Database, symbol: string): Promise<number | null> {
  const row = await db.prepare(`
    SELECT COALESCE(sp.avg_price, sp.close) as price FROM stock_prices sp
    JOIN stocks s ON s.id = sp.stock_id
    WHERE s.symbol = ? AND sp.close IS NOT NULL
    ORDER BY sp.date DESC LIMIT 1
  `).bind(symbol).first<any>()
  return row?.price ?? null
}

export async function batchGetLatestPrices(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map()
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT s.symbol, COALESCE(sp.avg_price, sp.close) as price
    FROM stocks s
    JOIN stock_prices sp ON sp.stock_id = s.id
    INNER JOIN (
      SELECT stock_id, MAX(date) as max_date
      FROM stock_prices
      WHERE close IS NOT NULL
      GROUP BY stock_id
    ) latest ON sp.stock_id = latest.stock_id AND sp.date = latest.max_date
    WHERE s.symbol IN (${placeholders})
  `).bind(...symbols).all<any>()

  const map = new Map<string, number>()
  for (const row of (results ?? [])) {
    if (row.price != null) map.set(row.symbol, row.price)
  }
  return map
}

export async function getStockName(db: D1Database, symbol: string): Promise<string> {
  const row = await db.prepare('SELECT name FROM stocks WHERE symbol=? LIMIT 1').bind(symbol).first<any>()
  return row?.name ?? symbol
}

export async function batchGetATR(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map()
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT s.symbol, ti.atr14
    FROM stocks s
    JOIN technical_indicators ti ON ti.stock_id = s.id
    WHERE s.symbol IN (${placeholders})
      AND ti.date = (SELECT MAX(t2.date) FROM technical_indicators t2 WHERE t2.stock_id = s.id)
  `).bind(...symbols).all<any>()

  const map = new Map<string, number>()
  for (const row of (results ?? [])) {
    if (row.atr14 != null) map.set(row.symbol, row.atr14)
  }
  return map
}
