/**
 * anueBuzz.ts — 鉅亨網新聞概念熱度偵測
 *
 * 資料來源：Anue cnyes.com News API v3
 * 邏輯：抓最新 30 篇台股新聞標題，統計概念關鍵字出現次數
 * 回傳：ConceptBuzzResult[]
 *
 * keywords 由 marketScreener 透過 loadBuzzKeywords(db) 從 D1 動態載入後傳入
 */
import type { ConceptBuzzResult } from './pttBuzz'

interface AnueNewsItem {
  newsId: number
  title: string
  publishAt: number  // unix timestamp
  categoryId: number
}

/**
 * 從 Anue 鉅亨網抓最新台股新聞，統計概念熱度
 * @param keywords — 動態概念關鍵字（由 loadBuzzKeywords 預載）
 */
export async function detectAnueBuzz(keywords?: Record<string, string[]>): Promise<ConceptBuzzResult[]> {
  const kwMap = keywords ?? {}
  try {
    // Anue News API v3 — 台股分類
    const res = await fetch('https://news.cnyes.com/api/v3/news/category/tw_stock?page=1&limit=30', {
      headers: { 'User-Agent': 'StockVision/12.3 (buzz-scanner)' },
    })
    if (!res.ok) {
      console.warn(`[AnueBuzz] API returned ${res.status}`)
      return []
    }

    const body = await res.json() as any
    const items: AnueNewsItem[] = body?.items?.data ?? []
    if (!items.length) {
      console.log('[AnueBuzz] No news items returned')
      return []
    }

    console.log(`[AnueBuzz] Scanning ${items.length} Anue news titles`)

    const stats = new Map<string, { count: number; titles: string[] }>()
    for (const concept of Object.keys(kwMap)) {
      stats.set(concept, { count: 0, titles: [] })
    }

    for (const item of items) {
      const titleLower = (item.title ?? '').toLowerCase()
      for (const [concept, kws] of Object.entries(kwMap)) {
        if (kws.some(kw => titleLower.includes(kw.toLowerCase()))) {
          const s = stats.get(concept)!
          s.count++
          if (s.titles.length < 2) s.titles.push(item.title)
        }
      }
    }

    const results: ConceptBuzzResult[] = []
    for (const [concept, s] of stats) {
      if (s.count === 0) continue
      results.push({
        concept,
        mentionCount: s.count,
        sentimentAvg: 0,  // Anue 無 sentiment 欄位，預設中性
        topPosts: s.titles,
      })
    }

    results.sort((a, b) => b.mentionCount - a.mentionCount)
    console.log(`[AnueBuzz] Found ${results.length} concepts: ${results.slice(0, 5).map(r => `${r.concept}(${r.mentionCount})`).join(', ')}`)
    return results
  } catch (e) {
    console.warn('[AnueBuzz] Failed (non-fatal):', e)
    return []
  }
}
