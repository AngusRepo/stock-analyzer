/**
 * newsBuzz.ts — 新聞標題概念熱度偵測
 *
 * 資料來源：D1 news 表（已由 crawlAndStoreNews 寫入）
 * 邏輯：統計最近 24h 新聞標題中各概念關鍵字出現次數
 * 回傳：ConceptBuzzResult[]（與 pttBuzz 同 interface）
 *
 * keywords 由 marketScreener 從 FinLab taxonomy 動態載入後傳入
 */
import type { ConceptBuzzResult } from './pttBuzz'
import { screenerOverlayCutoff } from './screenerOverlayReads'

/**
 * 從 D1 news 表統計最近 24h 新聞標題的概念熱度
 * @param keywords — 動態概念關鍵字（由 loadBuzzKeywords 預載）
 */
export async function detectNewsBuzz(db: D1Database, keywords?: Record<string, string[]>,
  observation?: { signalDate: string; observedAt: string }): Promise<ConceptBuzzResult[]> {
  const kwMap = keywords ?? {}
  const at = observation?.observedAt ?? new Date().toISOString()
  const date = observation?.signalDate ?? new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10)
  const { cutoff } = screenerOverlayCutoff(date, at)
  const response = await db.prepare(
    `SELECT title, sentiment FROM news
      WHERE julianday(published_at) >= julianday(?, '-1 day')
        AND julianday(published_at) < julianday(?) AND julianday(created_at) < julianday(?)
      ORDER BY id DESC LIMIT 500`
  ).bind(cutoff, cutoff, cutoff).all<{ title: string; sentiment: string | number | null }>()
  if (!response.success || !Array.isArray(response.results)) throw new Error('news_buzz_query_failed')
  const newsRows = response.results

  if (!newsRows?.length) {
    console.log('[NewsBuzz] No recent news found')
    return []
  }

  console.log(`[NewsBuzz] Scanning ${newsRows.length} news titles`)

  const stats = new Map<string, { count: number; sentimentSum: number; titles: string[] }>()
  for (const concept of Object.keys(kwMap)) {
    stats.set(concept, { count: 0, sentimentSum: 0, titles: [] })
  }

  for (const news of newsRows) {
    const titleLower = (news.title ?? '').toLowerCase()
    for (const [concept, kws] of Object.entries(kwMap)) {
      if (kws.some(kw => titleLower.includes(kw.toLowerCase()))) {
        const s = stats.get(concept)!
        s.count++
        // Ingested news uses labels; legacy numeric rows remain supported.
        const sentiment = news.sentiment === 'positive' ? 1 : news.sentiment === 'negative' ? -1
          : news.sentiment === 'neutral' || news.sentiment == null ? 0 : Number(news.sentiment)
        if (!Number.isFinite(sentiment)) throw new Error('news_buzz_sentiment_invalid')
        s.sentimentSum += Math.min(1, Math.max(-1, sentiment))
        if (s.titles.length < 3) s.titles.push(news.title)
      }
    }
  }

  const results: ConceptBuzzResult[] = []
  for (const [concept, s] of stats) {
    if (s.count === 0) continue
    results.push({
      concept,
      mentionCount: s.count,
      sentimentAvg: s.count > 0 ? Math.min(1, Math.max(-1, s.sentimentSum / s.count)) : 0,
      topPosts: s.titles,
    })
  }

  results.sort((a, b) => b.mentionCount - a.mentionCount)
  console.log(`[NewsBuzz] Found ${results.length} concepts: ${results.slice(0, 5).map(r => `${r.concept}(${r.mentionCount})`).join(', ')}`)
  return results
}
