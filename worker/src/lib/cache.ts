export async function withCache<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttl: number
): Promise<T> {
  try {
    const cached = await kv.get(key, 'json') as T | null
    if (cached != null) return cached
  } catch {}

  const data = await fetcher()
  try { await kv.put(key, JSON.stringify(data), { expirationTtl: ttl }) } catch {}
  return data
}

export const TTL = {
  QUOTE:   60,    // 1 min
  CHART:   300,   // 5 min
  NEWS:    600,   // 10 min
  MARKET:  60,    // 1 min
  CHIP:    3600,  // 1 hr
  FINANCE: 86400, // 1 day
}
