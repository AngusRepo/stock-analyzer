export interface RecommendationEvidenceLink {
  source: string
  title: string
  url: string
  published_at: string
}

type RecommendationEvidenceTarget = {
  symbol: string
  name?: string
}

type ExternalEvidenceRow = {
  source_id: string | null
  source_kind?: string | null
  title: string | null
  source_url: string | null
  published_at: string | null
  symbols_json: string | null
  decision_effect?: string | null
  source_quality_score?: number | null
  entity_linking_confidence?: number | null
}

type NewsFallbackRow = {
  symbol: string | null
  name?: string | null
  source: string | null
  title: string | null
  url: string | null
  published_at: string | null
  summary?: string | null
}

function cleanSymbol(value: unknown): string {
  const text = String(value ?? '').trim()
  const match = text.match(/\b(\d{4,6})\b/)
  return match?.[1] ?? text
}

function cleanName(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[()[\]?]/g, '')
    .trim()
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

function normalizeTargets(input: Array<string | Partial<RecommendationEvidenceTarget>>): RecommendationEvidenceTarget[] {
  const bySymbol = new Map<string, RecommendationEvidenceTarget>()
  for (const item of input) {
    const symbol = cleanSymbol(typeof item === 'string' ? item : item.symbol)
    if (!symbol) continue
    const name = typeof item === 'string' ? '' : cleanName(item.name)
    const prev = bySymbol.get(symbol)
    bySymbol.set(symbol, {
      symbol,
      name: prev?.name || name || undefined,
    })
  }
  return [...bySymbol.values()]
}

function sourceName(source: unknown): string {
  return String(source ?? '').toLowerCase()
}

export function isRecommendationEvidenceRowSpecific(row: ExternalEvidenceRow, symbol: string): boolean {
  const cleanedSymbol = cleanSymbol(symbol)
  const rowSymbols = parseSymbols(row.symbols_json)
  if (!cleanedSymbol || !rowSymbols.includes(cleanedSymbol)) return false
  if (rowSymbols.length > 3) return false

  const confidence = Number(row.entity_linking_confidence ?? 0)
  const quality = Number(row.source_quality_score ?? 0)
  if (Number.isFinite(confidence) && confidence < 0.45) return false
  if (Number.isFinite(quality) && quality < 0.35) return false

  const source = sourceName(row.source_id)
  const kind = sourceName(row.source_kind)
  const effect = sourceName(row.decision_effect)
  if (source === 'gdelt_events') {
    if (kind.includes('status') || effect === 'risk_context_only') return false
    return confidence >= 0.7
  }
  return true
}

export function isFallbackNewsRelevant(row: NewsFallbackRow, target: RecommendationEvidenceTarget): boolean {
  const symbol = cleanSymbol(target.symbol)
  const name = cleanName(target.name ?? row.name)
  const source = sourceName(row.source)
  const title = String(row.title ?? '')
  const url = String(row.url ?? '')
  const summary = String(row.summary ?? '')
  const lowerUrl = url.toLowerCase()
  const haystack = `${title} ${url} ${summary}`.toLowerCase()

  if (!symbol || !isUsefulUrl(url)) return false
  if (source.includes('cnyes') || source.includes('anue') || lowerUrl.includes('cnyes.com')) return true
  if (new RegExp(`(^|\\D)${symbol}(\\D|$)`).test(haystack)) return true
  if (name && name.length >= 2 && haystack.includes(name.toLowerCase())) return true
  return false
}

export async function loadRecommendationEvidenceLinks(
  db: D1Database,
  date: string,
  targetsOrSymbols: Array<string | Partial<RecommendationEvidenceTarget>>,
  limitPerSymbol = 3,
): Promise<Map<string, RecommendationEvidenceLink[]>> {
  const targets = normalizeTargets(targetsOrSymbols)
  const uniqueSymbols = targets.map((target) => target.symbol)
  const targetBySymbol = new Map(targets.map((target) => [target.symbol, target]))
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
        SELECT source_id, source_kind, title, source_url, published_at, symbols_json,
               decision_effect, source_quality_score, entity_linking_confidence
          FROM external_evidence_items
         WHERE accepted = 1
           AND date(published_at) >= date(?, '-10 days')
           AND source_id IN ('ptt', 'anue', 'd1_news', 'official_rss', 'company_ir_rss', 'gdelt_events')
           AND (${symbolPredicates})
         ORDER BY source_quality_score DESC, entity_linking_confidence DESC, published_at DESC
         LIMIT 240
      `).bind(...params).all<ExternalEvidenceRow>()
      for (const row of results ?? []) {
        const rowSymbols = parseSymbols(row.symbols_json)
        for (const symbol of rowSymbols) {
          if (!chunk.includes(symbol)) continue
          if (!isRecommendationEvidenceRowSpecific(row, symbol)) continue
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
        SELECT s.symbol, s.name, n.source, n.title, n.url, n.published_at, n.summary
          FROM news n
          JOIN stocks s ON s.id = n.stock_id
         WHERE s.symbol IN (${placeholders})
           AND date(n.published_at) >= date(?, '-10 days')
         ORDER BY n.published_at DESC
         LIMIT 240
      `).bind(...chunk, date).all<NewsFallbackRow>()
      for (const row of results ?? []) {
        const symbol = cleanSymbol(row.symbol)
        const target = targetBySymbol.get(symbol)
        if (!target || !isFallbackNewsRelevant(row, target)) continue
        pushLink(linksBySymbol, symbol, {
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
