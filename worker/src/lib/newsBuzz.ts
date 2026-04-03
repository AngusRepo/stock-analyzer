/**
 * newsBuzz.ts — 新聞標題概念熱度偵測
 *
 * 資料來源：D1 news 表（已由 crawlAndStoreNews 寫入）
 * 邏輯：統計最近 24h 新聞標題中各概念關鍵字出現次數
 * 回傳：ConceptBuzzResult[]（與 pttBuzz 同 interface）
 *
 * keywords 由 marketScreener 透過 loadBuzzKeywords(db) 從 D1 動態載入後傳入
 */
import type { ConceptBuzzResult } from './pttBuzz'

/**
 * 從 D1 news 表統計最近 24h 新聞標題的概念熱度
 * @param keywords — 動態概念關鍵字（由 loadBuzzKeywords 預載）
 */
export async function detectNewsBuzz(db: D1Database, keywords?: Record<string, string[]>): Promise<ConceptBuzzResult[]> {
  const kwMap = keywords ?? {}
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()

  const { results: newsRows } = await db.prepare(
    `SELECT title, sentiment FROM news WHERE published_at >= ? OR created_at >= ? ORDER BY id DESC LIMIT 500`
  ).bind(cutoff, cutoff).all<{ title: string; sentiment: number | null }>()

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
        s.sentimentSum += news.sentiment ?? 0
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
