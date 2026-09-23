/** Require complete target-session broker data before the evening selection chain. */
export async function brokerDailyReadiness(market: D1Database, targetDate: string) {
  const tables = ['canonical_broker_flow_daily', 'canonical_broker_rank_daily'] as const
  return Promise.all(tables.map(async (table) => {
    const row = await market.prepare(`SELECT COUNT(DISTINCT stock_id) AS count FROM ${table}
      WHERE date = ? AND as_of_date = ? AND source = 'finlab.broker_transactions'
        AND market_segment = 'LISTED_OTC'`)
      .bind(targetDate, targetDate).first<{ count: number }>()
    const count = Number(row?.count ?? 0)
    return {
      key: `${table}:listed_otc`,
      ok: count >= 1000,
      summary: count >= 1000
        ? `${table}=${count} source_date=${targetDate}`
        : `${table} target_rows=${count}/1000 date=${targetDate}`,
    }
  }))
}
