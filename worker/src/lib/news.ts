/**
 * news.ts — 新聞爬蟲 + 規則情感分析
 * 資料來源：Yahoo Finance API / RSS + 鉅亨網 RSS
 */

// ─── 情感分析規則引擎 ─────────────────────────────────────────────────────────
const POSITIVE_KEYWORDS = [
  '獲利', '盈餘', '成長', '創高', '突破', '上漲', '漲停', '買超', '增加',
  '擴產', '訂單', '出貨', '合約', '營收', '利多', '看好', '上修', '轉盈',
  '配息', '股息', '除息', '填息', '回購', '庫藏股', '業績', '超預期',
  '强劲', '領先', '新高', '創新高', '飆漲', '爆量', '主力買', '外資買',
]

const NEGATIVE_KEYWORDS = [
  '虧損', '下跌', '跌停', '賣超', '減少', '縮減', '警告', '風險',
  '裁員', '停工', '召回', '罰款', '訴訟', '違約', '下修', '轉虧', '衰退',
  '看壞', '利空', '暴跌', '崩跌', '拋售', '外資賣', '殺盤', '爆雷',
  '停牌', '下市', '退市', '財務', '虧', '損失', '壞帳',
]

export interface SentimentResult {
  label: 'positive' | 'neutral' | 'negative'
  score: number   // -1 ~ +1
  keywords: string[]
}

export function analyzeSentiment(text: string): SentimentResult {
  const normalizedText = text.toLowerCase()
  const foundPositive = POSITIVE_KEYWORDS.filter(kw => normalizedText.includes(kw))
  const foundNegative = NEGATIVE_KEYWORDS.filter(kw => normalizedText.includes(kw))

  const posScore = foundPositive.length
  const negScore = foundNegative.length
  const total = posScore + negScore

  if (total === 0) return { label: 'neutral', score: 0, keywords: [] }

  const score = (posScore - negScore) / Math.max(total, 3) // normalize
  const label = score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral'

  return {
    label,
    score: Math.max(-1, Math.min(1, score)),
    keywords: [...foundPositive, ...foundNegative].slice(0, 5),
  }
}

// ─── Yahoo Finance 新聞 API ──────────────────────────────────────────────────
async function crawlYahooNews(symbol: string, stockId: number): Promise<CrawledNews[]> {
  const results: CrawledNews[] = []
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=20&enableFuzzyQuery=false`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    })
    if (!res.ok) return results

    const data = await res.json() as any
    for (const item of data.news ?? []) {
      if (!item.title || !item.link) continue
      const sentiment = analyzeSentiment(item.title + ' ' + (item.summary ?? ''))
      results.push({
        stockId,
        title: item.title,
        url: item.link,
        source: item.publisher ?? 'Yahoo Finance',
        publishedAt: item.providerPublishTime
          ? new Date(item.providerPublishTime * 1000).toISOString()
          : new Date().toISOString(),
        sentiment: sentiment.label,
        summary: item.summary ?? null,
      })
    }
  } catch (e) {
    console.warn('[News] Yahoo API failed:', e)
  }
  return results
}

// ─── Yahoo Finance RSS ───────────────────────────────────────────────────────
async function crawlYahooRSS(symbol: string, stockId: number): Promise<CrawledNews[]> {
  const results: CrawledNews[] = []
  try {
    const url = `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(symbol)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) return results

    const xml = await res.text()
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? []

    for (const item of items.slice(0, 15)) {
      const title   = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ?? item.match(/<title>(.*?)<\/title>/)?.[1]
      const link    = item.match(/<link>(.*?)<\/link>/)?.[1]
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]
      const desc    = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]

      if (!title || !link) continue
      const safeUrl = link.trim().match(/^https?:\/\//) ? link.trim() : null
      const sentiment = analyzeSentiment(title + ' ' + (desc ?? ''))
      results.push({
        stockId,
        title: title.trim(),
        url: safeUrl,
        source: 'Yahoo Finance RSS',
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        sentiment: sentiment.label,
        summary: desc ? desc.replace(/<[^>]*>/g, '').trim().slice(0, 200) : null,
      })
    }
  } catch (e) {
    console.warn('[News] Yahoo RSS failed:', e)
  }
  return results
}

// ─── 鉅亨網 RSS ──────────────────────────────────────────────────────────────
async function crawlCnyesRSS(stockNo: string, stockId: number): Promise<CrawledNews[]> {
  const results: CrawledNews[] = []
  try {
    // 鉅亨網個股新聞 RSS
    const url = `https://feeds.cnyes.com/market/tw/${stockNo}/news.rss`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) return results

    const xml = await res.text()
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? []

    for (const item of items.slice(0, 10)) {
      const title   = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ?? item.match(/<title>(.*?)<\/title>/)?.[1]
      const link    = item.match(/<link>(.*?)<\/link>/)?.[1]
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]

      if (!title || !link) continue
      const safeUrl = link.trim().match(/^https?:\/\//) ? link.trim() : null
      const sentiment = analyzeSentiment(title)
      results.push({
        stockId,
        title: title.trim(),
        url: safeUrl,
        source: '鉅亨網',
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        sentiment: sentiment.label,
        summary: null,
      })
    }
  } catch (e) {
    console.warn('[News] Cnyes RSS failed:', e)
  }
  return results
}

// ─── 主入口：爬取並儲存 ───────────────────────────────────────────────────────
interface CrawledNews {
  stockId: number
  title: string
  url: string
  source: string
  publishedAt: string
  sentiment: 'positive' | 'neutral' | 'negative'
  summary: string | null
}

export async function crawlAndStoreNews(db: D1Database, stock: any): Promise<{ count: number }> {
  const symbol  = stock.symbol as string
  const stockNo = symbol.replace(/\.(TW|TWO)$/i, '')

  // 並行爬取三個來源
  const [yahooApi, yahooRss, cnyes] = await Promise.all([
    crawlYahooNews(symbol, stock.id),
    crawlYahooRSS(symbol, stock.id),
    stock.market !== 'US' ? crawlCnyesRSS(stockNo, stock.id) : Promise.resolve([]),
  ])

  const allNews = [...yahooApi, ...yahooRss, ...cnyes]
  if (!allNews.length) return { count: 0 }

  // 去重：同一 url 只取一筆（url 為 null 時改用 title 去重）
  const seen = new Set<string>()
  const unique = allNews.filter(n => {
    const key = n.url ?? `title:${n.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // 批次寫入 D1
  const batch = unique.map(n =>
    db.prepare(
      `INSERT OR IGNORE INTO news (stock_id, title, url, source, sentiment, published_at, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(n.stockId, n.title, n.url, n.source, n.sentiment, n.publishedAt, n.summary)
  )

  if (batch.length) await db.batch(batch)
  return { count: unique.length }
}

// ─── 關鍵字統計 ──────────────────────────────────────────────────────────────
export interface KeywordItem {
  word: string
  count: number
  sentiment: 'positive' | 'neutral' | 'negative'
  size: number  // 1–5 normalized
}

export function extractKeywords(newsItems: any[]): KeywordItem[] {
  const freq = new Map<string, { count: number; posScore: number; negScore: number }>()

  const allKeywords = [...POSITIVE_KEYWORDS, ...NEGATIVE_KEYWORDS]

  for (const item of newsItems) {
    const text = (item.title ?? '') + ' ' + (item.summary ?? '')
    for (const kw of allKeywords) {
      if (text.includes(kw)) {
        const cur = freq.get(kw) ?? { count: 0, posScore: 0, negScore: 0 }
        cur.count++
        if (POSITIVE_KEYWORDS.includes(kw)) cur.posScore++
        else cur.negScore++
        freq.set(kw, cur)
      }
    }
  }

  if (freq.size === 0) return []

  const sorted = Array.from(freq.entries())
    .filter(([, v]) => v.count >= 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 40)

  const maxCount = sorted[0]?.[1].count ?? 1

  return sorted.map(([word, v]) => ({
    word,
    count: v.count,
    sentiment: v.posScore > v.negScore ? 'positive' : v.negScore > v.posScore ? 'negative' : 'neutral',
    size: Math.ceil((v.count / maxCount) * 5),
  }))
}
