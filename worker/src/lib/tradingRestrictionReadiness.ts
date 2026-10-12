type OfficialRefresh = { status?: string; trade_date?: string; checked_at?: string; source_counts?: Record<string, number> }

/** Historical recovery receipts must not freshen the current execution cache. */
export async function readOfficialRestrictionReadiness(kv: KVNamespace, date: string) {
  const [datedAt, datedRefresh] = await Promise.all([
    kv.get(`market:trading_restrictions:checked_at:${date}`),
    kv.get(`market:trading_restrictions:refresh_status:${date}`, 'json') as Promise<OfficialRefresh | null>,
  ])
  if (datedAt !== null || datedRefresh !== null) return { checkedAt: datedAt, refresh: datedRefresh }
  const [checkedAt, refresh] = await Promise.all([
    kv.get('market:trading_restrictions:checked_at'),
    kv.get('market:trading_restrictions:refresh_status', 'json') as Promise<OfficialRefresh | null>,
  ])
  return { checkedAt, refresh }
}
