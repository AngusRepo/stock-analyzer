/** Closure already recorded by resolveTwTradingSession (weekend, holiday key, cached TWSE schedule or
 * ad-hoc check). Cache reads only: a display poll must not fetch TWSE, write KV or alert.
 * Shared by the premarket display and the read-only monitoring Worker (one trading-day reader). */
export async function recordedClosure(kv: KVNamespace, date: string): Promise<boolean> {
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay()
  if (day === 0 || day === 6) return true
  if (await kv.get(`holiday:${date}`)) return true
  if (await kv.get(`market:twse_adhoc_closure_check:v1:${date}`) === 'closed') return true
  const schedule = await kv.get(`market:twse_holiday_schedule:v2:${date.slice(0, 4)}`, 'json') as { dates?: unknown } | null
  return Array.isArray(schedule?.dates) && schedule.dates.includes(date)
}
