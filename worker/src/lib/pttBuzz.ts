/**
 * pttBuzz.ts — PTT Stock 板題材熱度偵測
 *
 * 爬 PTT Stock 板最近 2-3 頁文章標題（~60 篇）
 * 用概念股關鍵字比對，計算各概念被提及次數
 * 結合推文數作為情緒加權
 */

import type { Bindings } from '../types'

// ── 概念關鍵字對照表 ────────────────────────────────────────────────────────
// tag 對應到 stock_tags.tag，keywords 是 PTT 標題中可能出現的關鍵字
const CONCEPT_KEYWORDS: Record<string, string[]> = {
  'AI_Server':       ['AI', 'GB200', 'H100', 'H200', 'B200', 'AI伺服器', 'AI server', 'NVIDIA', '輝達'],
  'CoWoS先進封裝':    ['CoWoS', '先進封裝', '封裝', 'InFO'],
  'HBM記憶體':       ['HBM', '記憶體', 'DRAM', '南亞科', '華邦電'],
  'DRAM':            ['DRAM', '記憶體', '南亞科', '華邦電', '群聯'],
  'CPO共封裝光學':    ['CPO', '共封裝', '光學', '800G', '光模組', '光收發'],
  '矽光子':          ['矽光子', 'SiPh', 'silicon photonics'],
  'IC設計':          ['IC設計', '聯發科', '聯詠', '瑞昱', '信驊', 'IC design'],
  '晶圓代工':        ['台積', 'TSMC', '晶圓代工', '聯電', 'N2', 'N3', 'A16'],
  '半導體設備':       ['半導體設備', '環球晶', '漢微科', '精測', '矽晶圓'],
  '電動車':          ['電動車', 'EV', '特斯拉', 'Tesla', '充電'],
  '充電樁':          ['充電樁', '充電站', '華城', '士電', '中興電'],
  '儲能':            ['儲能', 'ESS', '電池'],
  '太陽能':          ['太陽能', '光電', '元晶', '茂迪', '聯合再生'],
  '5G':              ['5G', '6G', '網通', '智邦', '啟碁'],
  '低軌衛星':        ['低軌衛星', 'LEO', 'Starlink', '衛星', '星鏈'],
  '光通訊':          ['光通訊', '光纖', '億光', '聯亞'],
  '蘋果供應鏈':      ['蘋果', 'Apple', 'iPhone', '鴻海', '大立光', '和碩'],
  '航運_貨櫃':       ['貨櫃', '長榮', '陽明', '萬海', '運價'],
  '航空':            ['航空', '華航', '長榮航', '星宇', '機票'],
  '金控':            ['金控', '富邦金', '國泰金', '中信金', '配息', '股利'],
  '軍工國防':        ['軍工', '國防', '台船', '漢翔', '潛艦', '無人機'],
  '生技新藥':        ['生技', '新藥', '藥華', '保瑞', 'FDA', '解盲'],
  '營建資產':        ['營建', '建商', '房市', '房價', '豪宅', '都更'],
  '重電':            ['重電', '變壓器', '士電', '華城', '中興電', '電力'],
  'PCB印刷電路板':   ['PCB', '印刷電路板', '欣興', '南電', '景碩', 'ABF'],
  '鋼鐵':            ['鋼鐵', '中鋼', '大成鋼', '豐興', '鋼價'],
  '觀光飯店':        ['觀光', '飯店', '旅遊', '晶華', '旅宿'],
}

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
 * 偵測 PTT Stock 板的概念題材熱度
 * 爬最近 ~60 篇文章，統計各概念被提及次數
 */
export async function detectPttBuzz(): Promise<ConceptBuzzResult[]> {
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

  for (const [concept, keywords] of Object.entries(CONCEPT_KEYWORDS)) {
    stats.set(concept, { count: 0, totalNrec: 0, posts: [] })
  }

  for (const post of allPosts) {
    const titleLower = post.title.toLowerCase()
    for (const [concept, keywords] of Object.entries(CONCEPT_KEYWORDS)) {
      const matched = keywords.some(kw => titleLower.includes(kw.toLowerCase()))
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
