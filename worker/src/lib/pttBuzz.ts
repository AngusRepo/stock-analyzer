/**
 * pttBuzz.ts — PTT Stock 板題材熱度偵測
 *
 * 爬 PTT Stock 板最近 2-3 頁文章標題（~60 篇）
 * 用概念股關鍵字比對，計算各概念被提及次數
 * 結合推文數作為情緒加權
 */

import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadCoreStockIdentitiesBySymbols } from './stockIdentityMarketBridge'

// Taxonomy keywords are loaded exclusively from FinLab canonical tables.


interface PttPost {
  title: string
  nrec: number    // 推文數
  date: string
}

/** 爬 PTT Stock 板指定頁面 */
async function fetchPttPage(pageNum?: number): Promise<PttPost[]> {
  const suffix = pageNum ? `index${pageNum}.html` : 'index.html'
  const url = `https://www.ptt.cc/bbs/Stock/${suffix}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Cookie': 'over18=1',
    },
  })
  if (!res.ok) return []
  const html = await res.text()

  const posts: PttPost[] = []
  // 用 regex 提取文章區塊
  const entryRegex = /<div class="r-ent">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g
  const nrecRegex = /<span class="hl[^"]*">([^<]*)<\/span>/
  const titleRegex = /<a[^>]*>([^<]+)<\/a>/
  const dateRegex = /<div class="date">\s*([^<]+)/

  let match
  while ((match = entryRegex.exec(html)) !== null) {
    const block = match[0]
    const titleMatch = block.match(titleRegex)
    const nrecMatch = block.match(nrecRegex)
    const dateMatch = block.match(dateRegex)
    if (!titleMatch) continue

    let nrec = 0
    if (nrecMatch) {
      const val = nrecMatch[1].trim()
      if (val === '爆') nrec = 100
      else if (val.startsWith('X')) nrec = -10
      else nrec = parseInt(val, 10) || 0
    }

    posts.push({
      title: titleMatch[1].trim(),
      nrec,
      date: dateMatch ? dateMatch[1].trim() : '',
    })
  }

  return posts
}

/** 從 PTT 頁面提取上一頁頁碼 */
async function getPttPrevPage(): Promise<number | null> {
  const res = await fetch('https://www.ptt.cc/bbs/Stock/index.html', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'over18=1' },
  })
  if (!res.ok) return null
  const html = await res.text()
  const match = html.match(/href="\/bbs\/Stock\/index(\d+)\.html">&lsaquo; 上頁/)
  return match ? parseInt(match[1], 10) : null
}

export interface ConceptBuzzResult {
  concept: string
  mentionCount: number
  sentimentAvg: number     // -1 ~ +1
  topPosts: string[]       // 代表性文章標題
}

/**
 * 從 FinLab canonical industry_theme/subindustry 動態載入關鍵字
 * tag name 本身作為 keyword + 每個 tag 的 top 5 成員股名稱
 * KV 快取 24h，避免重複查詢
 */
export async function loadBuzzKeywords(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  kv?: KVNamespace,
): Promise<Record<string, string[]>> {
  if (kv) {
    const cached = await kv.get('buzz:keywords', 'json') as Record<string, string[]> | null
    if (cached) return cached
  }

  const { results: tagRows } = await databaseForDataDomain(env, 'market').prepare(`
    SELECT tag, symbol
      FROM finlab_taxonomy_tags
     WHERE weight >= 0.3
       AND tag_type IN ('industry_theme','subindustry')
       AND source='finlab.security_industry_themes'
     ORDER BY tag, weight DESC
  `).all<{ tag: string; symbol: string }>()
  if (!tagRows?.length) return {}

  const identities = await loadCoreStockIdentitiesBySymbols(env, tagRows.map((row) => row.symbol))
  const kwMap: Record<string, string[]> = {}
  const tagStocks = new Map<string, string[]>()
  for (const row of tagRows) {
    const identity = identities.get(row.symbol)
    if (!identity) continue
    if (!tagStocks.has(row.tag)) tagStocks.set(row.tag, [])
    const names = tagStocks.get(row.tag)!
    if (names.length < 5) names.push(identity.name)
  }

  for (const [tag, stockNames] of tagStocks) {
    const keywords = new Set<string>()
    keywords.add(tag)
    for (const part of tag.split(/[_（）()、]/).filter((value) => value.length >= 2)) keywords.add(part)
    const stripped = tag.replace(/(工業|纖維|業|及週邊設備|保險|百貨|燃氣|餐旅)$/, '')
    if (stripped.length >= 2 && stripped !== tag) keywords.add(stripped)
    for (const name of stockNames) {
      const clean = name.replace(/(股份有限公司|-KY|投控|控股)$/, '').trim()
      if (clean.length >= 2) keywords.add(clean)
    }
    kwMap[tag] = [...keywords]
  }

  if (kv) await kv.put('buzz:keywords', JSON.stringify(kwMap), { expirationTtl: 86400 })
  console.log(`[BuzzKeywords] Loaded ${Object.keys(kwMap).length} FinLab taxonomy groups (${tagRows.length} tag-stock pairs)`)
  return kwMap
}

/**
 * 偵測 PTT Stock 板的概念題材熱度
 */export async function detectPttBuzz(keywords?: Record<string, string[]>): Promise<ConceptBuzzResult[]> {
  const kwMap = keywords ?? {}
  // 抓最新 2 頁（~40 篇）
  const prevPage = await getPttPrevPage()
  const [page1, page2] = await Promise.all([
    fetchPttPage(),
    prevPage ? fetchPttPage(prevPage) : Promise.resolve([]),
  ])

  const allPosts = [...page1, ...page2]
  console.log(`[PTT] Fetched ${allPosts.length} posts from Stock board`)

  if (!allPosts.length) return []

  // 統計各概念
  const stats = new Map<string, { count: number; totalNrec: number; posts: string[] }>()

  for (const concept of Object.keys(kwMap)) {
    stats.set(concept, { count: 0, totalNrec: 0, posts: [] })
  }

  for (const post of allPosts) {
    const titleLower = post.title.toLowerCase()
    for (const [concept, kws] of Object.entries(kwMap)) {
      const matched = kws.some(kw => titleLower.includes(kw.toLowerCase()))
      if (matched) {
        const s = stats.get(concept)!
        s.count++
        s.totalNrec += post.nrec
        if (s.posts.length < 3) s.posts.push(post.title)
      }
    }
  }

  // 轉成結果，按 count 排序
  const results: ConceptBuzzResult[] = []
  for (const [concept, s] of stats) {
    if (s.count === 0) continue
    results.push({
      concept,
      mentionCount: s.count,
      sentimentAvg: s.count > 0 ? Math.min(1, Math.max(-1, s.totalNrec / (s.count * 20))) : 0,
      topPosts: s.posts,
    })
  }

  return results.sort((a, b) => b.mentionCount - a.mentionCount)
}

/**
 * 將 PTT buzz 結果存入 D1 concept_buzz 表
 */
export async function storePttBuzz(db: D1Database, date: string, buzz: ConceptBuzzResult[]): Promise<void> {
  if (!buzz.length) return
  const batch = buzz.map(b =>
    db.prepare(`
      INSERT INTO concept_buzz (date, concept, mention_count, sentiment_avg, top_posts, source)
      VALUES (?, ?, ?, ?, ?, 'ptt')
      ON CONFLICT(date, concept, source) DO UPDATE SET
        mention_count=excluded.mention_count,
        sentiment_avg=excluded.sentiment_avg,
        top_posts=excluded.top_posts
    `).bind(date, b.concept, b.mentionCount, b.sentimentAvg, JSON.stringify(b.topPosts))
  )

  const BATCH_SIZE = 50
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await db.batch(batch.slice(i, i + BATCH_SIZE))
  }
}
