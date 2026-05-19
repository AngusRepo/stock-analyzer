export interface RecommendationEvidenceLink {
  source: string
  title: string
  url: string
  published_at: string
}

function cleanSymbol(value: unknown): string {
  const text = String(value ?? '').trim()
  const match = text.match(/\b(\d{4,6})\b/)
  return match?.[1] ?? text
}

function isUsefulUrl(value: unknown): value is string {
  const text = String(value ?? '').trim()
  return /^https?:\/\//i.test(text)
}

function pushLink(
  map: Map<string, RecommendationEvidenceLink[]>,
  symbol: string,
  link: RecommendationEvidenceLink,
  limit: number,
): void {
  const key = cleanSymbol(symbol)
  if (!key || !isUsefulUrl(link.url)) return
  const list = map.get(key) ?? []
  if (list.some((item) => item.url === link.url)) return
  if (list.length >= limit) return
  list.push(link)
  map.set(key, list)
}

function parseSymbols(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(cleanSymbol).filter(Boolean)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(cleanSymbol).filter(Boolean) : []
  } catch {
    return []
  }
}

export async function loadRecommendationEvidenceLinks(
  db: D1Database,
  date: string,
  symbols: string[],
  limitPerSymbol = 3,
): Promise<Map<string, RecommendationEvidenceLink[]>> {
  const uniqueSymbols = [...new Set(symbols.map(cleanSymbol).filter(Boolean))]
  const linksBySymbol = new Map<string, RecommendationEvidenceLink[]>()
  if (!uniqueSymbols.length) return linksBySymbol

  try {
    for (let i = 0; i < uniqueSymbols.length; i += 40) {
      const chunk = uniqueSymbols.slice(i, i + 40)
      const symbolPredicates = chunk.map(() => 'symbols_json LIKE ?').join(' OR ')
      const params = [
        date,
        ...chunk.map((symbol) => `%"${symbol}"%`),
      ]
      const { results } = await db.prepare(`
        SELECT source_id, title, source_url, published_at, symbols_json
          FROM external_evidence_items
         WHERE accepted = 1
           AND date(published_at) >= date(?, '-10 days')
           AND source_id IN ('ptt', 'anue', 'd1_news', 'official_rss', 'company_ir_rss', 'gdelt_events')
           AND (${symbolPredicates})
         ORDER BY source_quality_score DESC, entity_linking_confidence DESC, published_at DESC
         LIMIT 240
      `).bind(...params).all<{
        source_id: string | null
        title: string | null
        source_url: string | null
        published_at: string | null
        symbols_json: string | null
      }>()
      for (const row of results ?? []) {
        const rowSymbols = parseSymbols(row.symbols_json)
        for (const symbol of rowSymbols) {
          if (!chunk.includes(symbol)) continue
          pushLink(linksBySymbol, symbol, {
            source: row.source_id || 'external_evidence',
            title: String(row.title || row.source_url || '').slice(0, 160),
            url: String(row.source_url || ''),
            published_at: String(row.published_at || ''),
          }, limitPerSymbol)
        }
      }
    }
  } catch {
    // Older D1 snapshots may not have V4.1 external evidence tables.
  }

  const needsFallback = uniqueSymbols.filter((symbol) => (linksBySymbol.get(symbol)?.length ?? 0) < limitPerSymbol)
  if (!needsFallback.length) return linksBySymbol

  try {
    for (let i = 0; i < needsFallback.length; i += 40) {
      const chunk = needsFallback.slice(i, i + 40)
      const placeholders = chunk.map(() => '?').join(',')
      const { results } = await db.prepare(`
        SELECT s.symbol, n.source, n.title, n.url, n.published_at
          FROM news n
          JOIN stocks s ON s.id = n.stock_id
         WHERE s.symbol IN (${placeholders})
           AND date(n.published_at) >= date(?, '-10 days')
         ORDER BY n.published_at DESC
         LIMIT 240
      `).bind(...chunk, date).all<{
        symbol: string | null
        source: string | null
        title: string | null
        url: string | null
        published_at: string | null
      }>()
      for (const row of results ?? []) {
        pushLink(linksBySymbol, String(row.symbol || ''), {
          source: row.source || 'd1_news',
          title: String(row.title || row.url || '').slice(0, 160),
          url: String(row.url || ''),
          published_at: String(row.published_at || ''),
        }, limitPerSymbol)
      }
    }
  } catch {
    // News fallback is best-effort; cards simply omit links if no evidence exists.
  }

  return linksBySymbol
}
