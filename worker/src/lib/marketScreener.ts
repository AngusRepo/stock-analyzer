/**
 * marketScreener.ts — 全市場自動選股 + 族群輪動偵測
 *
 * 每日收盤後執行（14:00 TW = 06:00 UTC cron），從全市場篩選出 ~25 支候選股
 * 自動更新 stocks 表（source='screener'），讓後續 ML pipeline 分析
 *
 * 兩階段漏斗（QuantConnect Coarse+Fine pattern）：
 *   Stage 1: Sector Heat Score → top 5 熱門族群
 *   Stage 2: Individual Stock Filter → 每個族群 top 5-8 支
 */

import type { Bindings } from '../types'
// Types originally from finmind.ts (FinMind API 已棄用，只保留 type 給 screener 內部用)
export interface FMStockPrice {
  date: string
  stock_id: string
  Trading_Volume: number
  Trading_money: number
  open: number
  max: number
  min: number
  close: number
  spread: number
  Trading_turnover: number
}

export interface FMChip {
  date: string
  stock_id: string
  name: string
  buy: number
  sell: number
}
import { getTradingConfig, type TradingConfig } from './tradingConfig'

// ── TWSE/TPEx 官方開放資料 API（免費、無限制、不需 token）─────────────────────

/** 抓 TWSE 上市全市場當日收盤（回傳 FMStockPrice 格式） */
async function fetchTWSEAllPrices(dateStr: string): Promise<FMStockPrice[]> {
  // dateStr: "2026-03-24" → TWSE 要 "20260324"
  const d = dateStr.replace(/-/g, '')
  // 用 STOCK_DAY_ALL — 格式穩定、回傳乾淨 JSON
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json&date=${d}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`TWSE STOCK_DAY_ALL HTTP ${res.status}`)
  const json = await res.json() as any
  if (json.stat !== 'OK' || !json.data?.length) return []

  // fields: [證券代號, 證券名稱, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數]
  const results: FMStockPrice[] = []
  for (const row of json.data) {
    const symbol = String(row[0]).trim()
    if (!/^\d{4}$/.test(symbol)) continue
    const parse = (s: string) => parseFloat(String(s).replace(/,/g, ''))
    const parseInt2 = (s: string) => parseInt(String(s).replace(/,/g, ''), 10) || 0
    const close = parse(row[7])
    if (isNaN(close) || close <= 0) continue
    results.push({
      date: dateStr,
      stock_id: symbol,
      Trading_Volume: parseInt2(row[2]),
      Trading_money: parseInt2(row[3]),
      open: parse(row[4]),
      max: parse(row[5]),
      min: parse(row[6]),
      close,
      spread: parse(row[8]) || 0,
      Trading_turnover: parseInt2(row[9]),
    })
  }
  return results
}

/** 抓 TPEx 上櫃全市場當日收盤 */
async function fetchTPExAllPrices(dateStr: string): Promise<FMStockPrice[]> {
  // TPEx 用民國年: "2026-03-24" → "115/03/24"
  const parts = dateStr.split('-')
  const rocYear = parseInt(parts[0]) - 1911
  const rocDate = `${rocYear}/${parts[1]}/${parts[2]}`
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=${rocDate}&se=EW`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) return []
  const json = await res.json() as any
  // 格式: { tables: [{ data: [[代號, 名稱, 收盤, 漲跌, 開盤, 最高, 最低, 成交股數, ...], ...] }] }
  const rows = json.tables?.[0]?.data ?? json.aaData ?? []
  if (!rows.length) return []

  const results: FMStockPrice[] = []
  for (const row of rows) {
    const symbol = String(row[0]).trim()
    if (!/^\d{4}$/.test(symbol)) continue
    const parse = (s: string) => parseFloat(String(s).replace(/,/g, ''))
    const close = parse(row[2])
    const open = parse(row[4])
    const high = parse(row[5])
    const low = parse(row[6])
    const volume = parseInt(String(row[7]).replace(/,/g, ''), 10) || 0
    const spread = parse(row[3]) || 0
    if (isNaN(close) || close <= 0) continue
    results.push({
      date: dateStr,
      stock_id: symbol,
      Trading_Volume: volume,
      Trading_money: parseInt(String(row[8]).replace(/,/g, ''), 10) || 0,
      open, max: high, min: low, close, spread,
      Trading_turnover: parseInt(String(row[9]).replace(/,/g, ''), 10) || 0,
    })
  }
  return results
}

/** 抓 TWSE 三大法人買賣超（全市場） */
async function fetchTWSEInstitutional(dateStr: string): Promise<FMChip[]> {
  const d = dateStr.replace(/-/g, '')
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${d}&selectType=ALLBUT0999`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) return []
  const json = await res.json() as any
  if (json.stat !== 'OK' || !json.data?.length) return []

  // fields: [證券代號(0), 證券名稱(1),
  //   外陸資買進(2), 外陸資賣出(3), 外陸資買賣超(4),
  //   外資自營商買(5), 外資自營商賣(6), 外資自營商超(7),
  //   投信買(8), 投信賣(9), 投信超(10),
  //   自營商超(11), 自營商買(自行)(12), 自營商賣(自行)(13), 自營商超(自行)(14),
  //   自營商買(避險)(15), 自營商賣(避險)(16), 自營商超(避險)(17),
  //   三大法人超(18)]
  const results: FMChip[] = []
  for (const row of json.data) {
    const symbol = String(row[0]).trim()
    if (!/^\d{4}$/.test(symbol)) continue
    const parse = (s: string) => parseInt(String(s).replace(/,/g, ''), 10) || 0
    results.push({ date: dateStr, stock_id: symbol, name: '外資', buy: parse(row[2]), sell: parse(row[3]) })
    results.push({ date: dateStr, stock_id: symbol, name: '投信', buy: parse(row[8]), sell: parse(row[9]) })
    results.push({ date: dateStr, stock_id: symbol, name: '自營商', buy: parse(row[12]) + parse(row[15]), sell: parse(row[13]) + parse(row[16]) })
  }
  return results
}

/** 抓 TPEx 上櫃三大法人買賣超 */
async function fetchTPExInstitutional(dateStr: string): Promise<FMChip[]> {
  const parts = dateStr.split('-')
  const rocYear = parseInt(parts[0]) - 1911
  const rocDate = `${rocYear}/${parts[1]}/${parts[2]}`
  const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d=${rocDate}&se=EW&t=D`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) return []
  const json = await res.json() as any
  const rows = json.tables?.[0]?.data ?? []
  if (!rows.length) return []

  // TPEx fields: [0]代號 [1]名稱
  // [2-4] 外資(不含自營) buy/sell/net  [5-7] 外資自營  [8-10] 外資合計
  // [11-13] 投信 buy/sell/net  [14-16] 自營商(自行)  [17-19] 自營商(避險)  [20-22] 自營商合計
  const results: FMChip[] = []
  const parse = (s: string) => parseInt(String(s).replace(/,/g, ''), 10) || 0
  for (const row of rows) {
    const symbol = String(row[0]).trim()
    if (!/^\d{4}$/.test(symbol)) continue
    results.push({ date: dateStr, stock_id: symbol, name: '外資', buy: parse(row[2]), sell: parse(row[3]) })
    results.push({ date: dateStr, stock_id: symbol, name: '投信', buy: parse(row[11]), sell: parse(row[12]) })
    results.push({ date: dateStr, stock_id: symbol, name: '自營商', buy: parse(row[14]) + parse(row[17]), sell: parse(row[15]) + parse(row[18]) })
  }
  return results
}

/**
 * 取最近 N 個交易日的全市場資料（TWSE + TPEx）
 * 用重試機制跳過假日（TWSE 假日會回傳空資料）
 */
async function fetchMultiDayMarketData(days: number): Promise<{
  allPrices: FMStockPrice[]
  allChips: FMChip[]
  tpexSymbols: Set<string>
}> {
  const allPrices: FMStockPrice[] = []
  const allChips: FMChip[] = []
  const tpexSymbols = new Set<string>()
  const tw = new Date(Date.now() + 8 * 3600_000)
  let fetched = 0
  let attempts = 0

  while (fetched < days && attempts < days * 2) {
    const dateStr = tw.toISOString().slice(0, 10)
    attempts++
    tw.setDate(tw.getDate() - 1)

    // 跳過週末
    const dow = new Date(dateStr).getDay()
    if (dow === 0 || dow === 6) continue

    try {
      // TWSE 優先，TPEx 可能被 Cloudflare IP 擋（redirect loop）→ 降級只用上市
      let twse: FMStockPrice[] = []
      let tpex: FMStockPrice[] = []
      try { twse = await fetchTWSEAllPrices(dateStr) } catch (e) { console.warn(`[Screener] TWSE ${dateStr} failed:`, e) }
      try { tpex = await fetchTPExAllPrices(dateStr) } catch { /* TPEx 失敗不影響 */ }
      if (twse.length === 0 && tpex.length === 0) continue  // 假日

      allPrices.push(...twse, ...tpex)
      for (const p of tpex) tpexSymbols.add(p.stock_id)

      // Chips：TWSE（上市）+ TPEx（上櫃）法人資料
      if (fetched < 5) {
        try {
          const [twseChips, tpexChips] = await Promise.all([
            fetchTWSEInstitutional(dateStr).catch(() => [] as FMChip[]),
            fetchTPExInstitutional(dateStr).catch(() => [] as FMChip[]),
          ])
          allChips.push(...twseChips, ...tpexChips)
        } catch { /* chips 非必要 */ }
      }

      fetched++
      console.log(`[Screener] Day ${fetched}/${days}: ${dateStr} → ${twse.length + tpex.length} stocks`)
    } catch (e) {
      console.warn(`[Screener] Failed to fetch ${dateStr}:`, e)
    }

    // TWSE 有 rate limit，間隔 3 秒
    if (fetched < days) await new Promise(r => setTimeout(r, 3000))
  }

  return { allPrices, allChips, tpexSymbols }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SectorHeatScore {
  sector: string
  score: number           // 0-100
  components: {
    chipFlow: number      // 法人資金集中度 (40%)
    relativeStrength: number  // 族群相對強度 (30%)
    volumeExpansion: number   // 成交量擴張 (20%)
    momentum: number      // 動量趨勢 (10%)
  }
  stockCount: number
  topStocks: string[]     // representative symbols
}

export interface ScreenerCandidate {
  symbol: string
  name: string
  sector: string
  score: number
  reason: string
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** 計算 N 個交易日前的日期（粗略：日曆天 * 1.5，台北時區） */
function tradingDaysAgo(n: number): string {
  const tw = new Date(Date.now() + 8 * 3600_000)
  tw.setDate(tw.getDate() - Math.ceil(n * 1.5))
  return tw.toISOString().slice(0, 10)
}

function today(): string {
  // 用台北時間（UTC+8），確保收盤後取到當天資料
  const tw = new Date(Date.now() + 8 * 3600_000)
  return tw.toISOString().slice(0, 10)
}

/** Clamp value to [min, max] */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** 將原始值線性 normalize 到 [0, maxScore] */
function normalize(value: number, lower: number, upper: number, maxScore: number): number {
  if (upper === lower) return maxScore / 2
  return clamp(((value - lower) / (upper - lower)) * maxScore, 0, maxScore)
}

// ─── Sector mapping ──────────────────────────────────────────────────────────

interface SectorMap {
  [stockId: string]: { name: string; sector: string; market?: string }
}

/**
 * 從 D1 stocks 表取已有的 sector mapping，
 * 再用 FinMind TaiwanStockInfo 補全未知股票的 sector。
 * 結果快取到 KV（每週刷新一次）。
 */
async function getSectorMapping(env: Bindings): Promise<SectorMap> {
  // 先查 KV 快取
  const cacheKey = 'screener:sector-map'
  const cached = await env.KV.get(cacheKey, 'json') as SectorMap | null
  if (cached) return cached

  // D1 stocks 表（sector 已由 TWSE opendata 在 screener 初始化時填入）
  const { results: dbStocks } = await env.DB.prepare(
    "SELECT symbol, name, sector, market FROM stocks WHERE sector IS NOT NULL AND sector != ''"
  ).all<{ symbol: string; name: string; sector: string; market?: string }>()
  const map: SectorMap = {}
  for (const s of dbStocks ?? []) {
    map[s.symbol] = { name: s.name, sector: s.sector, market: s.market }
  }

  // 快取 7 天
  await env.KV.put(cacheKey, JSON.stringify(map), { expirationTtl: 7 * 86400 })
  return map
}

// ─── Stage 1: Sector Heat Detection ─────────────────────────────────────────

interface StockDailyData {
  prices: Map<string, FMStockPrice[]>   // stockId → sorted prices
  chips: Map<string, Map<string, { foreign: number; trust: number }>>  // stockId → date → net
}

function buildStockData(
  allPrices: FMStockPrice[],
  allChips: FMChip[],
): StockDailyData {
  // Group prices by stock_id, sorted by date
  const prices = new Map<string, FMStockPrice[]>()
  for (const p of allPrices) {
    if (!prices.has(p.stock_id)) prices.set(p.stock_id, [])
    prices.get(p.stock_id)!.push(p)
  }
  for (const arr of prices.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date))
  }

  // Group chips by stock_id → date → { foreign, trust }
  const chips = new Map<string, Map<string, { foreign: number; trust: number }>>()
  for (const c of allChips) {
    if (!chips.has(c.stock_id)) chips.set(c.stock_id, new Map())
    const dateMap = chips.get(c.stock_id)!
    if (!dateMap.has(c.date)) dateMap.set(c.date, { foreign: 0, trust: 0 })
    const entry = dateMap.get(c.date)!
    const net = c.buy - c.sell
    if (c.name.includes('外資')) entry.foreign += net
    if (c.name.includes('投信')) entry.trust += net
  }

  return { prices, chips }
}

/**
 * 計算大盤 5 日報酬率（用加權指數或全市場平均）
 * 這裡用全市場等權平均近似
 */
function calcMarketReturn5d(data: StockDailyData): number {
  let totalReturn = 0
  let count = 0
  for (const prices of data.prices.values()) {
    if (prices.length < 6) continue
    const recent = prices[prices.length - 1].close
    const fiveDaysAgo = prices[prices.length - 6]?.close
    if (recent > 0 && fiveDaysAgo > 0) {
      totalReturn += (recent - fiveDaysAgo) / fiveDaysAgo
      count++
    }
  }
  return count > 0 ? totalReturn / count : 0
}

// ─── DB Operations ───────────────────────────────────────────────────────────

async function updateScreenerWatchlist(db: D1Database, candidates: ScreenerCandidate[], tpexSymbolSet: Set<string>): Promise<void> {
  const candidateSymbols = candidates.map(c => c.symbol)

  // ── Step 1: 停用上一輪的非 pinned screener 股票 ─────────────────────────
  // source='screener' 且非 pinned → 全部先停用，再由 Step 2 重新啟用本輪候選
  // pinned=1（使用者手動加的）永遠不被 screener 輪換影響
  if (!candidates.length) {
    await db.prepare("UPDATE stocks SET is_active=0 WHERE source='screener' AND COALESCE(pinned,0)=0").run()
    return
  }

  const placeholders = candidateSymbols.map(() => '?').join(',')
  await db.prepare(
    `UPDATE stocks SET is_active=0 WHERE source='screener' AND COALESCE(pinned,0)=0 AND symbol NOT IN (${placeholders})`
  ).bind(...candidateSymbols).run()

  // ── Step 2: Upsert 候選股票 ────────────────────────────────────────────
  // pinned 股票：只更新 is_active=1、sector，不動 source
  // 非 pinned 股票：source 設為 screener，下一輪可被正確輪換
  const batch = candidates.map(c => {
    // 根據資料來源判斷市場：TPEX API 來的是 OTC，其餘為 TWSE
    const market = tpexSymbolSet.has(c.symbol) ? 'OTC' : 'TWSE'
    return db.prepare(`
      INSERT INTO stocks (symbol, name, market, sector, is_active, source)
      VALUES (?, ?, ?, ?, 1, 'screener')
      ON CONFLICT(symbol) DO UPDATE SET
        is_active=1,
        market=excluded.market,
        source=CASE WHEN COALESCE(stocks.pinned,0)=1 THEN stocks.source ELSE 'screener' END,
        sector=COALESCE(excluded.sector, stocks.sector),
        updated_at=datetime('now')
    `).bind(c.symbol, c.name, market, c.sector)
  })

  const BATCH_SIZE = 50
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await db.batch(batch.slice(i, i + BATCH_SIZE))
  }
}

async function storeSectorHeat(
  db: D1Database,
  date: string,
  scores: SectorHeatScore[],
): Promise<void> {
  const batch = scores.slice(0, 20).map(s =>
    db.prepare(`
      INSERT INTO sector_heat (date, sector, score, chip_flow, relative_strength, volume_expansion, momentum, top_stocks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, sector) DO UPDATE SET
        score=excluded.score, chip_flow=excluded.chip_flow,
        relative_strength=excluded.relative_strength,
        volume_expansion=excluded.volume_expansion,
        momentum=excluded.momentum, top_stocks=excluded.top_stocks
    `).bind(
      date, s.sector, s.score,
      s.components.chipFlow, s.components.relativeStrength,
      s.components.volumeExpansion, s.components.momentum,
      JSON.stringify(s.topStocks),
    )
  )

  const BATCH_SIZE = 50
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await db.batch(batch.slice(i, i + BATCH_SIZE))
  }
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// Bottom-up 多因子 + RRG 產業輪動 Screener（v2）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 從 stock_tags(tag_type='industry') 建立 symbol → 官方產業 mapping
 * 取代舊 getSectorMapping()（那個讀 stocks.sector 是概念名）
 */
async function getIndustryMapping(db: D1Database, kv: KVNamespace): Promise<Map<string, string>> {
  const cacheKey = 'screener:industry-map'
  const cached = await kv.get(cacheKey, 'json') as Record<string, string> | null
  if (cached) return new Map(Object.entries(cached))

  const { results } = await db.prepare(
    "SELECT symbol, tag FROM stock_tags WHERE tag_type='industry'"
  ).all<{ symbol: string; tag: string }>()
  const map = new Map<string, string>()
  for (const r of (results ?? [])) map.set(r.symbol, r.tag)

  // 快取 7 天
  await kv.put(cacheKey, JSON.stringify(Object.fromEntries(map)), { expirationTtl: 7 * 86400 })
  return map
}

/**
 * Step 2: 多因子評分（FinLab 優化版）
 *
 * 籌碼(0-40): 用相對比例（佔日均成交%），不偏向權值股
 * 技術(0-30): RSI 40-80 全給分，超買不扣分（FinLab 驗證）
 * 動能(0-20): 超額報酬 + 量能比 + 價格意圖因子 + RSI 鈍化
 */
function scoreMultiFactor(
  prices: FMStockPrice[],
  chipDates: Map<string, { foreign: number; trust: number }> | undefined,
  marketReturn5d: number,
  latestClose: number,
): { base_score: number; chip_score: number; tech_score: number; momentum_score: number; reasons: string[] } {
  const reasons: string[] = []
  const latest = prices[prices.length - 1]

  // ── P0-1: 籌碼面 (0-40) — 用相對比例，消除大小型股偏差 ──
  let chip_score = 0
  if (chipDates) {
    let netBuyShares = 0  // 5 日淨買超股數
    let consecBuyDays = 0
    const sortedDates = [...chipDates.keys()].sort().slice(-5)
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      const d = sortedDates[i]
      const nets = chipDates.get(d)!
      const dayNet = nets.foreign + nets.trust
      netBuyShares += dayNet
      if (i === sortedDates.length - 1 || consecBuyDays > 0) {
        if (dayNet > 0) consecBuyDays++
        else if (i < sortedDates.length - 1) consecBuyDays = 0
      }
    }

    // chip_intensity = 淨買超金額 / 20日均成交金額（比例）
    const netBuyAmount = netBuyShares * latestClose  // 元
    const avgDailyTurnover = prices.reduce((s, p) => s + p.Trading_Volume * p.close, 0) / prices.length
    const chipIntensity = avgDailyTurnover > 0 ? netBuyAmount / avgDailyTurnover : 0

    // 相對比例分級（消除大小型股偏差）
    if (chipIntensity > 0.20) chip_score = 36       // 佔日均成交 20%+ 極強
    else if (chipIntensity > 0.10) chip_score = 28  // 10%+
    else if (chipIntensity > 0.05) chip_score = 20  // 5%+
    else if (chipIntensity > 0) chip_score = 12     // 正向
    else if (chipIntensity > -0.05) chip_score = 5  // 微賣
    // else 0

    if (chipIntensity > 0.05) reasons.push(`法人佔成交${(chipIntensity * 100).toFixed(1)}%`)

    // 連續買超天數 bonus
    if (consecBuyDays >= 5) { chip_score += 4; reasons.push(`連買${consecBuyDays}天`) }
    else if (consecBuyDays >= 3) { chip_score += 2 }
  }
  chip_score = clamp(chip_score, 0, 40)

  // ── P0-2: 技術面 (0-30) — RSI 區間放寬，超買不扣分 ──
  let tech_score = 0

  // RSI 14（FinLab 驗證：超買不隱含回調，40-80 全給分）
  let rsiValue = 50
  if (prices.length >= 15) {
    const changes14 = prices.slice(-15).map((p, i, arr) =>
      i === 0 ? 0 : p.close - arr[i - 1].close
    ).slice(1)
    const gains = changes14.filter(c => c > 0)
    const losses = changes14.filter(c => c < 0).map(c => -c)
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0.001
    const rsi = 100 - 100 / (1 + avgGain / avgLoss)
    rsiValue = rsi

    // 放寬版評分（原本 55-70 才給高分，現在 40-80 都給分）
    if (rsi >= 55 && rsi <= 75) { tech_score += 12; reasons.push(`RSI ${rsi.toFixed(0)}`) }
    else if (rsi >= 45 && rsi < 55) tech_score += 8
    else if (rsi >= 40 && rsi < 45) tech_score += 6
    else if (rsi > 75) tech_score += 8  // 超買不扣分，動能延續
    else if (rsi >= 30 && rsi < 40) tech_score += 3  // 超賣反彈潛力
  }

  // MACD（近似 EMA12 - EMA26）
  if (prices.length >= 20) {
    const ma12 = prices.slice(-12).reduce((s, p) => s + p.close, 0) / 12
    const ma26 = prices.slice(-Math.min(26, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(26, prices.length)
    const macdApprox = ma12 - ma26
    if (macdApprox > 0) { tech_score += 8; reasons.push('MACD 多頭') }
    else if (macdApprox > -0.5 * latestClose / 100) tech_score += 3
  }

  // 均線排列
  if (prices.length >= 5) {
    const ma5 = prices.slice(-5).reduce((s, p) => s + p.close, 0) / 5
    if (latest.close > ma5) tech_score += 3
  }
  if (prices.length >= 20) {
    const ma20 = prices.slice(-20).reduce((s, p) => s + p.close, 0) / 20
    if (latest.close > ma20) { tech_score += 4; reasons.push('站上MA20') }
  }

  // P3-5: NATR 低波動加分（低波動 + 趨勢中 = 穩健上漲）
  if (prices.length >= 14) {
    const trueRanges = prices.slice(-15).map((p, i, arr) => {
      if (i === 0) return p.max - p.min
      const prev = arr[i - 1]
      return Math.max(p.max - p.min, Math.abs(p.max - prev.close), Math.abs(p.min - prev.close))
    }).slice(1)
    const atr14 = trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length
    const natr = latestClose > 0 ? (atr14 / latestClose) * 100 : 0

    // 肯特納通道突破
    const ma20 = prices.slice(-Math.min(20, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(20, prices.length)
    if (latest.close > ma20 + 1.5 * atr14 && atr14 > 0) {
      tech_score += 3
      reasons.push('突破肯特納')
    }

    // NATR 低波動：< 3% 且在均線上方 = 穩健趨勢（FinLab IC 驗證）
    if (natr < 3 && latest.close > ma20) tech_score += 2
  }
  tech_score = clamp(tech_score, 0, 30)

  // ── 動能面 (0-20) — 加入價格意圖因子 ──
  let momentum_score = 0

  // 5d excess return vs 大盤 (0-7)
  if (prices.length >= 6) {
    const stockReturn = (latest.close - prices[prices.length - 6].close) / prices[prices.length - 6].close
    const excess = stockReturn - marketReturn5d
    momentum_score += normalize(excess, -0.03, 0.05, 7)
    if (excess > 0.02) reasons.push(`超額+${(excess * 100).toFixed(1)}%`)
  }

  // 量能比：近 3 日 vs 20 日均量 (0-5)
  if (prices.length >= 5) {
    const recent3 = prices.slice(-3).reduce((s, p) => s + p.Trading_Volume, 0) / 3
    const avg20 = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
    const volRatio = avg20 > 0 ? recent3 / avg20 : 1
    momentum_score += normalize(volRatio, 0.7, 2.5, 5)
    if (volRatio > 1.5) reasons.push(`量能${volRatio.toFixed(1)}倍`)
  }

  // P1-3: 價格意圖因子 (0-5) — FinLab 線性因子
  // price_intent = N日報酬 / N日每日絕對報酬總和（1=直線上漲，0=震盪）
  if (prices.length >= 15) {
    const n = Math.min(20, prices.length - 1)
    const retN = (latest.close - prices[prices.length - 1 - n].close) / prices[prices.length - 1 - n].close
    let sumAbsRet = 0
    for (let d = prices.length - n; d < prices.length; d++) {
      if (prices[d - 1].close > 0) sumAbsRet += Math.abs((prices[d].close - prices[d - 1].close) / prices[d - 1].close)
    }
    const priceIntent = sumAbsRet > 0 ? retN / sumAbsRet : 0
    // intent > 0.5 = 大部分漲幅是直線上漲（主力護盤訊號）
    if (priceIntent > 0.5) { momentum_score += 5; reasons.push(`意圖${(priceIntent * 100).toFixed(0)}%`) }
    else if (priceIntent > 0.3) momentum_score += 3
    else if (priceIntent > 0.1) momentum_score += 1
  }

  // RSI 鈍化：RSI > 75 連 3+ 天（門檻從 80 降到 75）
  if (rsiValue > 75 && prices.length >= 6) {
    const recentChanges = prices.slice(-6).map((p, i, arr) =>
      i === 0 ? 0 : p.close - arr[i - 1].close
    ).slice(1)
    let consec = 0
    for (let d = recentChanges.length - 1; d >= 0; d--) {
      if (recentChanges[d] > 0) consec++
      else break
    }
    if (consec >= 3) {
      momentum_score += 3
      reasons.push(`RSI鈍化${consec}天`)
    }
  }
  momentum_score = clamp(momentum_score, 0, 20)

  const base_score = chip_score + tech_score + momentum_score
  return { base_score, chip_score, tech_score, momentum_score, reasons }
}

/** RRG 象限判定 */
function classifyQuadrant(rsRatio: number, rsMomentum: number): string {
  if (rsRatio > 100 && rsMomentum > 0) return 'Leading'
  if (rsRatio <= 100 && rsMomentum > 0) return 'Improving'
  if (rsRatio > 100 && rsMomentum <= 0) return 'Weakening'
  return 'Lagging'
}

/**
 * 一次性回填 RRG 歷史 — 對過去 N 個交易日逐日計算 RS-Ratio/Momentum 寫入 sector_flow
 */
export async function backfillRRG(env: Bindings): Promise<{ filled: number; dates: string[] }> {
  const industryMap = await getIndustryMapping(env.DB, env.KV)
  if (!industryMap.size) return { filled: 0, dates: [] }

  // 取所有有 stock_prices 的交易日（近 30 天）
  const { results: dateRows } = await env.DB.prepare(
    "SELECT DISTINCT date FROM stock_prices WHERE date >= date('now', '-40 days') ORDER BY date"
  ).all<{ date: string }>()
  const tradingDates = (dateRows ?? []).map(r => r.date)
  if (tradingDates.length < 2) return { filled: 0, dates: [] }

  const rsWindow = 15  // 固定用 15 天窗口回填
  const emaSpan = 8
  const filledDates: string[] = []

  // 逐日計算
  for (let i = rsWindow; i < tradingDates.length; i++) {
    const targetDate = tradingDates[i]
    const windowStartDate = tradingDates[i - rsWindow]

    // 查每支股票在 windowStartDate 和 targetDate 的收盤價
    const { results: priceRows } = await env.DB.prepare(`
      SELECT s.symbol,
        (SELECT sp1.close FROM stock_prices sp1 WHERE sp1.stock_id = s.id AND sp1.date = ?) as old_close,
        (SELECT sp2.close FROM stock_prices sp2 WHERE sp2.stock_id = s.id AND sp2.date = ?) as recent_close
      FROM stocks s
      WHERE EXISTS (SELECT 1 FROM stock_tags st WHERE st.symbol = s.symbol AND st.tag_type = 'industry')
    `).bind(windowStartDate, targetDate).all<{ symbol: string; old_close: number | null; recent_close: number | null }>()

    // 按產業聚合報酬
    const industryReturns = new Map<string, number[]>()
    for (const r of (priceRows ?? [])) {
      if (!r.recent_close || !r.old_close || r.old_close <= 0) continue
      const industry = industryMap.get(r.symbol)
      if (!industry) continue
      const ret = (r.recent_close - r.old_close) / r.old_close
      if (!industryReturns.has(industry)) industryReturns.set(industry, [])
      industryReturns.get(industry)!.push(ret)
    }

    // Z-score RS-Ratio
    const industryAvgMap = new Map<string, number>()
    for (const [ind, rets] of industryReturns) {
      if (rets.length >= 3) {
        industryAvgMap.set(ind, rets.reduce((a, b) => a + b, 0) / rets.length)
      }
    }
    const avgValues = [...industryAvgMap.values()]
    if (!avgValues.length) continue
    const mean = avgValues.reduce((a, b) => a + b, 0) / avgValues.length
    const std = Math.sqrt(avgValues.reduce((a, b) => a + (b - mean) ** 2, 0) / avgValues.length) || 0.001

    // 讀前一天的 RS-Ratio 做 EMA
    const prevDate = tradingDates[i - 1]
    const { results: prevRows } = await env.DB.prepare(
      "SELECT sector, rs_ratio FROM sector_flow WHERE date = ? AND classification = 'industry' AND rs_ratio IS NOT NULL"
    ).bind(prevDate).all<{ sector: string; rs_ratio: number }>()
    const prevRsMap = new Map<string, number>()
    for (const r of (prevRows ?? [])) prevRsMap.set(r.sector, r.rs_ratio)

    const k = 2 / (emaSpan + 1)
    const batch = []
    for (const [industry, avgRet] of industryAvgMap) {
      const rawRs = ((avgRet - mean) / std) * 10 + 100
      const prevRs = prevRsMap.get(industry)
      const rsRatio = prevRs != null ? prevRs + k * (rawRs - prevRs) : rawRs
      const rsMomentum = prevRs != null ? rsRatio - prevRs : 0
      const quadrant = classifyQuadrant(rsRatio, rsMomentum)
      const members = industryReturns.get(industry)?.length ?? 0

      batch.push(env.DB.prepare(`
        INSERT INTO sector_flow (date, sector, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d, stock_count, up_count, classification, rs_ratio, rs_momentum, quadrant)
        VALUES (?, ?, 0, 0, 0, NULL, 0, ?, 0, 'industry', ?, ?, ?)
        ON CONFLICT(date, sector) DO UPDATE SET
          rs_ratio=excluded.rs_ratio, rs_momentum=excluded.rs_momentum, quadrant=excluded.quadrant,
          stock_count=excluded.stock_count, classification='industry'
      `).bind(targetDate, industry, members, rsRatio, rsMomentum, quadrant))
    }

    const BATCH_SIZE = 50
    for (let b = 0; b < batch.length; b += BATCH_SIZE) {
      await env.DB.batch(batch.slice(b, b + BATCH_SIZE))
    }
    filledDates.push(targetDate)
  }

  return { filled: filledDates.length, dates: filledDates }
}

/**
 * Step 3: RRG 產業輪動計算（Regime-conditioned 參數）
 *
 * 每個官方產業用等權平均報酬 vs 大盤，計算 RS-Ratio/Momentum/Quadrant
 */
async function calcIndustryRRG(
  data: StockDailyData,
  industryMap: Map<string, string>,
  env: Bindings,
  cfg: TradingConfig,
  endDate: string,
): Promise<Map<string, { rsRatio: number; rsMomentum: number; quadrant: string; bonus: number }>> {
  const result = new Map<string, { rsRatio: number; rsMomentum: number; quadrant: string; bonus: number }>()

  // ── Regime detection → 決定 RRG 參數 ──
  let rsWindow = 20, emaSpan = 10, momLookback = 10
  try {
    // 讀 market_risk
    const riskRow = await env.DB.prepare(
      'SELECT risk_level FROM market_risk ORDER BY date DESC LIMIT 1'
    ).first<{ risk_level: string }>()
    const riskLevel = riskRow?.risk_level ?? 'green'

    // 讀 HMM regime
    const regimeStr = await env.KV.get('ml:regime')
    const regime = regimeStr ?? 'sideways'

    // P3-11: ATR V 轉指標 — 全市場高波動股 ATR/Close > 8% = 急跌末段
    const atrVTurn = await env.DB.prepare(`
      SELECT AVG(ti.atr14 / sp.close * 100) as avg_natr
      FROM technical_indicators ti
      JOIN stock_prices sp ON ti.stock_id = sp.stock_id AND ti.date = sp.date
      WHERE ti.date = (SELECT MAX(date) FROM technical_indicators)
      AND ti.atr14 IS NOT NULL AND sp.close > 0
    `).first<{ avg_natr: number }>().catch(() => null)
    const marketNatr = atrVTurn?.avg_natr ?? 0
    if (marketNatr > 8) {
      console.log(`[RRG] ATR V-turn detected: market NATR=${marketNatr.toFixed(1)}% > 8% → 急跌末段`)
    }

    if (riskLevel === 'red' || riskLevel === 'black') {
      rsWindow = 10; emaSpan = 5; momLookback = 5
      console.log(`[RRG] High vol mode (risk=${riskLevel}): window=${rsWindow}`)
    } else if (regime.includes('bull') || regime.includes('bear')) {
      // Trending → 長窗口
      rsWindow = 25; emaSpan = 12; momLookback = 12
      console.log(`[RRG] Trending mode (regime=${regime}): window=${rsWindow}`)
    } else {
      // Range-bound → 標準
      rsWindow = 15; emaSpan = 8; momLookback = 8
      console.log(`[RRG] Range-bound mode: window=${rsWindow}`)
    }
  } catch (e) {
    console.warn('[RRG] Regime detection failed, using defaults:', e)
  }

  // ── 從 D1 stock_prices 讀 N 日報酬（而非即時 API，確保假日也有完整歷史）──
  const industryReturns = new Map<string, number[]>()
  try {
    // 查每支有 industry tag 的股票的 N 日前收盤 vs 最新收盤
    const { results: returnRows } = await env.DB.prepare(`
      SELECT s.symbol,
        (SELECT sp1.close FROM stock_prices sp1 WHERE sp1.stock_id = s.id ORDER BY sp1.date DESC LIMIT 1) as recent_close,
        (SELECT sp2.close FROM stock_prices sp2 WHERE sp2.stock_id = s.id ORDER BY sp2.date DESC LIMIT 1 OFFSET ?) as old_close
      FROM stocks s
      WHERE s.is_active = 1 OR EXISTS (SELECT 1 FROM stock_tags st WHERE st.symbol = s.symbol AND st.tag_type = 'industry')
    `).bind(rsWindow).all<{ symbol: string; recent_close: number | null; old_close: number | null }>()

    for (const r of (returnRows ?? [])) {
      if (!r.recent_close || !r.old_close || r.old_close <= 0) continue
      const industry = industryMap.get(r.symbol)
      if (!industry) continue
      const ret = (r.recent_close - r.old_close) / r.old_close
      if (!industryReturns.has(industry)) industryReturns.set(industry, [])
      industryReturns.get(industry)!.push(ret)
    }
  } catch (e) {
    console.warn('[RRG] D1 stock_prices query failed, fallback to API data:', e)
    // Fallback: 用 API 即時資料
    for (const [stockId, prices] of data.prices) {
      const industry = industryMap.get(stockId)
      if (!industry) continue
      if (prices.length < rsWindow) continue
      const recent = prices[prices.length - 1].close
      const nDaysAgo = prices[Math.max(0, prices.length - rsWindow)].close
      if (recent <= 0 || nDaysAgo <= 0) continue
      if (!industryReturns.has(industry)) industryReturns.set(industry, [])
      industryReturns.get(industry)!.push((recent - nDaysAgo) / nDaysAgo)
    }
  }

  if (!industryReturns.size) return result

  // 各產業平均報酬 → Z-score 標準化 → RS-Ratio
  // Z-score: mean=100, 每 1 std = 10 分 → 強弱分明
  const industryAvgMap = new Map<string, number>()
  for (const [industry, returns] of industryReturns) {
    if (returns.length >= 3) {
      industryAvgMap.set(industry, returns.reduce((a, b) => a + b, 0) / returns.length)
    }
  }
  const avgValues = [...industryAvgMap.values()]
  const mean = avgValues.reduce((a, b) => a + b, 0) / avgValues.length
  let std = Math.sqrt(avgValues.reduce((a, b) => a + (b - mean) ** 2, 0) / avgValues.length) || 0.001

  // ── Plateau Calibration: 偵測 RS-Ratio 壓縮，放寬 normalization ──
  // 全市場報酬 std 太低（< 0.005 = 0.5%）→ 所有產業擠在 95-105
  // 放大 std 使 Z-score 更離散，恢復象限分布
  if (std < 0.005) {
    const calibratedStd = 0.005
    console.log(`[RRG] Plateau detected: std=${(std * 100).toFixed(3)}% < 0.5% → calibrate to ${(calibratedStd * 100).toFixed(1)}%`)
    std = calibratedStd
  }

  // ── 計算 RS-Ratio ──
  // 查歷史 RS-Ratio（用 sector_flow 前日資料算 momentum）
  let prevRsMap = new Map<string, number>()
  try {
    const { results: prevRows } = await env.DB.prepare(
      `SELECT sector, rs_ratio FROM sector_flow
       WHERE classification='industry' AND rs_ratio IS NOT NULL AND date < ?
       ORDER BY date DESC LIMIT 100`
    ).bind(endDate).all<{ sector: string; rs_ratio: number }>()
    // 取每個 sector 最近的一筆（已按 date DESC）
    for (const r of (prevRows ?? [])) {
      if (!prevRsMap.has(r.sector)) prevRsMap.set(r.sector, r.rs_ratio)
    }
  } catch { /* 冷啟動 OK */ }

  // RRG bonus 設定（從 tradingConfig 讀，fallback defaults）
  const rrg = (cfg as any).rrg ?? {}
  const leadingBonus = rrg.leadingBonus ?? 10
  const improvingBonus = rrg.improvingBonus ?? 7
  const weakeningBonus = rrg.weakeningBonus ?? 0
  const laggingPenalty = rrg.laggingPenalty ?? -5

  const isColdStart = prevRsMap.size === 0

  for (const [industry, returns] of industryReturns) {
    if (returns.length < 3) continue  // 太少成員的產業不計

    const avgReturn = industryAvgMap.get(industry)
    if (avgReturn == null) continue
    // RS-Ratio = Z-score × 10 + 100
    // > 100 = 強於中位產業, < 100 = 弱於中位產業
    // 每 1 std ≈ 10 分：110 = 強 1 std, 90 = 弱 1 std
    const rawRs = ((avgReturn - mean) / std) * 10 + 100
    if (industryReturns.size <= 5) {
      console.log(`[RRG debug] ${industry}: avg=${avgReturn.toFixed(6)} mean=${mean.toFixed(6)} std=${std.toFixed(6)} rawRs=${rawRs.toFixed(2)}`)
    }
    // EMA 平滑：如果有前值就做 EMA，沒有就用 raw
    const prevRs = prevRsMap.get(industry)
    const k = 2 / (emaSpan + 1)
    const rsRatio = prevRs != null ? prevRs + k * (rawRs - prevRs) : rawRs

    // RS-Momentum：今日 - N 天前（用 prevRs 近似 N 天前）
    const rsMomentum = prevRs != null ? rsRatio - prevRs : 0

    const quadrant = classifyQuadrant(rsRatio, rsMomentum)
    let bonus = 0
    if (!isColdStart) {
      // 正常模式：四象限加分
      if (quadrant === 'Leading') bonus = leadingBonus
      else if (quadrant === 'Improving') bonus = improvingBonus
      else if (quadrant === 'Weakening') bonus = weakeningBonus
      else bonus = laggingPenalty
    } else {
      // 冷啟動：沒有 momentum，用 rawRs 強弱排名給分
      if (rsRatio > 105) bonus = 7       // 明顯強於大盤 → 等同 Improving
      else if (rsRatio > 100) bonus = 3  // 略強
      else if (rsRatio >= 95) bonus = 0  // 與大盤同步
      else bonus = -3                    // 明顯弱於大盤
    }

    result.set(industry, { rsRatio, rsMomentum, quadrant, bonus })
  }

  // Debug: print mean, std, and sample rawRs values
  const sampleRs = [...result.entries()].slice(0, 5).map(([k, v]) => `${k}=${v.rsRatio.toFixed(1)}`).join(', ')
  console.log(`[RRG] cold=${isColdStart} mean=${mean.toFixed(6)} std=${std.toFixed(6)} prevRsMap.size=${prevRsMap.size} industries=${industryAvgMap.size}`)
  console.log(`[RRG] sample: ${sampleRs}`)

  // Attach debug info to result for caller to read
  ;(result as any)._debug = `cold=${isColdStart} mean=${mean.toFixed(6)} std=${std.toFixed(6)} industries=${industryAvgMap.size} prevRs=${prevRsMap.size}`
  return result
}

/**
 * Step 5c: 報酬率相關性去重 — Pearson correlation > threshold 的只留最高分
 */
async function deduplicateByCorrelation(
  candidates: ScreenerCandidate[],
  db: D1Database,
  threshold: number,
  windowDays: number,
): Promise<ScreenerCandidate[]> {
  if (candidates.length <= 1) return candidates
  const symbols = candidates.map(c => c.symbol)

  // 從 D1 查 N 天收盤價
  const ph = symbols.map(() => '?').join(',')
  const { results: priceRows } = await db.prepare(`
    SELECT s.symbol, sp.date, sp.close
    FROM stock_prices sp
    JOIN stocks s ON sp.stock_id = s.id
    WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-${windowDays + 30} days')
    ORDER BY s.symbol, sp.date
  `).bind(...symbols).all<{ symbol: string; date: string; close: number }>()

  if (!priceRows?.length) return candidates

  // 建 symbol → daily returns 序列
  const returnSeries = new Map<string, number[]>()
  const priceBySymbol = new Map<string, { date: string; close: number }[]>()
  for (const r of priceRows) {
    if (!priceBySymbol.has(r.symbol)) priceBySymbol.set(r.symbol, [])
    priceBySymbol.get(r.symbol)!.push(r)
  }
  for (const [sym, prices] of priceBySymbol) {
    if (prices.length < 10) continue  // 太少不算
    const returns: number[] = []
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1].close > 0) {
        returns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close)
      }
    }
    returnSeries.set(sym, returns)
  }

  // Pearson 相關性
  function pearson(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length)
    if (n < 10) return 0
    const ax = a.slice(-n), bx = b.slice(-n)
    const meanA = ax.reduce((s, v) => s + v, 0) / n
    const meanB = bx.reduce((s, v) => s + v, 0) / n
    let num = 0, denA = 0, denB = 0
    for (let i = 0; i < n; i++) {
      const da = ax[i] - meanA, db = bx[i] - meanB
      num += da * db
      denA += da * da
      denB += db * db
    }
    const den = Math.sqrt(denA * denB)
    return den > 0 ? num / den : 0
  }

  // 標記要移除的（correlation > threshold 時，移除分數較低的）
  const removed = new Set<string>()
  for (let i = 0; i < candidates.length; i++) {
    if (removed.has(candidates[i].symbol)) continue
    const aReturns = returnSeries.get(candidates[i].symbol)
    if (!aReturns) continue

    for (let j = i + 1; j < candidates.length; j++) {
      if (removed.has(candidates[j].symbol)) continue
      const bReturns = returnSeries.get(candidates[j].symbol)
      if (!bReturns) continue

      const corr = pearson(aReturns, bReturns)
      if (corr > threshold) {
        // 移除分數低的
        const loser = candidates[i].score >= candidates[j].score ? candidates[j].symbol : candidates[i].symbol
        removed.add(loser)
        console.log(`[Dedup] ${candidates[i].symbol} ↔ ${candidates[j].symbol} corr=${corr.toFixed(2)} → remove ${loser}`)
      }
    }
  }

  return candidates.filter(c => !removed.has(c.symbol))
}

/**
 * Bottom-up 全市場選股主流程（v2）
 */
export async function runBottomUpScreener(env: Bindings): Promise<{
  hotSectors: SectorHeatScore[]
  candidates: ScreenerCandidate[]
  debugLog?: string[]
}> {
  console.log('[Screener v2] Starting bottom-up multi-factor screening...')
  const debugLog: string[] = []
  const cfg = await getTradingConfig(env.KV)
  const sc = cfg.screener
  const endDate = today()

  // ── 資料抓取（平行）──
  const { detectPttBuzz, storePttBuzz, loadBuzzKeywords } = await import('./pttBuzz')
  const { detectNewsBuzz } = await import('./newsBuzz')
  const { detectAnueBuzz } = await import('./anueBuzz')

  type BuzzResult = Awaited<ReturnType<typeof detectPttBuzz>>
  let allPrices: FMStockPrice[]
  let allChips: FMChip[]
  let tpexSymbolSet = new Set<string>()
  let combinedBuzz: BuzzResult = []

  try {
    const buzzKeywords = await loadBuzzKeywords(env.DB, env.KV).catch(() => undefined)

    const [marketData, pttBuzz, newsBuzz, anueBuzz] = await Promise.all([
      fetchMultiDayMarketData(20),
      detectPttBuzz(buzzKeywords).catch(() => [] as BuzzResult),
      detectNewsBuzz(env.DB, buzzKeywords).catch(() => [] as BuzzResult),
      detectAnueBuzz(buzzKeywords).catch(() => [] as BuzzResult),
    ])
    allPrices = marketData.allPrices
    allChips = marketData.allChips
    tpexSymbolSet = marketData.tpexSymbols

    // 合併 buzz（Z-score 標準化，same as before）
    const zNorm = (arr: { concept: string; mentionCount: number }[]): Map<string, number> => {
      if (!arr.length) return new Map()
      const counts = arr.map(b => b.mentionCount)
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length
      const std = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length) || 1
      return new Map(arr.map(b => [b.concept, (b.mentionCount - mean) / std]))
    }
    const pttZ = zNorm(pttBuzz), newsZ = zNorm(newsBuzz), anueZ = zNorm(anueBuzz)
    const buzzMap = new Map<string, { zSum: number; rawCount: number; sentimentSum: number; posts: string[] }>()
    for (const [source, zMap] of [[pttBuzz, pttZ], [newsBuzz, newsZ], [anueBuzz, anueZ]] as const) {
      for (const b of source) {
        const z = (zMap as Map<string, number>).get(b.concept) ?? 0
        const existing = buzzMap.get(b.concept)
        if (existing) {
          existing.zSum += z; existing.rawCount += b.mentionCount
          existing.sentimentSum += b.sentimentAvg * b.mentionCount
          existing.posts.push(...b.topPosts.slice(0, 1))
        } else {
          buzzMap.set(b.concept, { zSum: z, rawCount: b.mentionCount, sentimentSum: b.sentimentAvg * b.mentionCount, posts: [...b.topPosts.slice(0, 2)] })
        }
      }
    }
    combinedBuzz = [...buzzMap.entries()].map(([concept, v]) => ({
      concept, mentionCount: v.rawCount,
      sentimentAvg: v.rawCount > 0 ? v.sentimentSum / v.rawCount : 0,
      topPosts: v.posts.slice(0, 3),
    }))
    const zSumMap = new Map([...buzzMap.entries()].map(([k, v]) => [k, v.zSum]))
    combinedBuzz.sort((a, b) => (zSumMap.get(b.concept) ?? 0) - (zSumMap.get(a.concept) ?? 0))

    console.log(`[Screener v2] Data: ${allPrices.length} prices, ${allChips.length} chips | Buzz: ${combinedBuzz.length}`)
  } catch (e) {
    console.error('[Screener v2] Data fetch failed:', e)
    return { hotSectors: [], candidates: [] }
  }

  if (!allPrices.length) {
    console.warn('[Screener v2] No price data, aborting')
    return { hotSectors: [], candidates: [] }
  }

  // ── 處置股排除 ──
  let punishedSet = new Set<string>()
  try {
    const { fetchPunishedStocks } = await import('./twseApi')
    const punished = await fetchPunishedStocks()
    punishedSet = new Set(punished)
    if (punished.length) {
      await env.KV.put('market:punished_stocks', JSON.stringify(punished), { expirationTtl: 86400 })
    }
  } catch (e) {
    console.warn('[Screener v2] 處置股抓取失敗:', e)
  }

  // ── 讀取官方產業 mapping + 概念標籤 ──
  const industryMap = await getIndustryMapping(env.DB, env.KV)
  const { results: tagRows } = await env.DB.prepare(
    "SELECT symbol, tag, weight FROM stock_tags WHERE tag_type='concept'"
  ).all<{ symbol: string; tag: string; weight: number }>()
  const symbolConceptTags = new Map<string, string[]>()
  for (const r of (tagRows ?? [])) {
    if (!symbolConceptTags.has(r.symbol)) symbolConceptTags.set(r.symbol, [])
    symbolConceptTags.get(r.symbol)!.push(r.tag)
  }

  // ── 股票名稱 mapping ──
  const sectorMap = await getSectorMapping(env)

  // ── 建資料結構 ──
  const data = buildStockData(allPrices, allChips)
  // 大盤 5d return：用 D1 的 0050（元大台灣50 ETF）作為 benchmark
  // 0050 追蹤加權指數，是最穩定的大盤代理。若沒有就用加權指數近似
  let marketReturn5d = 0
  try {
    const latestDate = await env.DB.prepare("SELECT MAX(date) as d FROM stock_prices").first<{ d: string }>()
    const fiveDaysAgoDate = await env.DB.prepare(
      "SELECT date FROM (SELECT DISTINCT date FROM stock_prices ORDER BY date DESC LIMIT 6) ORDER BY date ASC LIMIT 1"
    ).first<{ date: string }>()

    if (latestDate?.d && fiveDaysAgoDate?.date) {
      // 嘗試 0050 ETF
      const row0050 = await env.DB.prepare(`
        SELECT
          (SELECT close FROM stock_prices sp JOIN stocks s ON sp.stock_id=s.id WHERE s.symbol='0050' AND sp.date=?) as latest,
          (SELECT close FROM stock_prices sp JOIN stocks s ON sp.stock_id=s.id WHERE s.symbol='0050' AND sp.date=?) as old
      `).bind(latestDate.d, fiveDaysAgoDate.date).first<{ latest: number; old: number }>()

      if (row0050?.latest && row0050?.old && row0050.old > 0) {
        marketReturn5d = (row0050.latest - row0050.old) / row0050.old
      } else {
        // Fallback: 全市場中位數（確定性，不用 LIMIT）
        const { results: allRets } = await env.DB.prepare(`
          SELECT (sp1.close - sp2.close) / sp2.close as ret
          FROM stock_prices sp1
          JOIN stock_prices sp2 ON sp1.stock_id = sp2.stock_id
          WHERE sp1.date = ? AND sp2.date = ? AND sp2.close > 0
        `).bind(latestDate.d, fiveDaysAgoDate.date).all<{ ret: number }>()

        if (allRets?.length) {
          const sorted = allRets.map(r => r.ret).sort((a, b) => a - b)
          marketReturn5d = sorted[Math.floor(sorted.length / 2)]  // 中位數
        }
      }
    }
  } catch (e) {
    marketReturn5d = calcMarketReturn5d(data)
    console.warn('[Screener v2] D1 marketReturn 查詢失敗，fallback API:', e)
  }

  // ── Step 0.5: D1 stock_prices 補充 API 資料（確保假日/手動重跑時資料完整）──
  try {
    const { results: d1Prices } = await env.DB.prepare(`
      SELECT s.symbol, sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume
      FROM stock_prices sp
      JOIN stocks s ON sp.stock_id = s.id
      WHERE sp.date >= date('now', '-30 days')
      ORDER BY s.symbol, sp.date
    `).all<{ symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }>()

    if (d1Prices?.length) {
      // 合併：D1 資料優先（更完整），API 資料補充最新日
      const d1BySymbol = new Map<string, FMStockPrice[]>()
      for (const r of d1Prices) {
        if (!d1BySymbol.has(r.symbol)) d1BySymbol.set(r.symbol, [])
        d1BySymbol.get(r.symbol)!.push({
          date: r.date, stock_id: r.symbol,
          open: r.open, max: r.high, min: r.low, close: r.close,
          Trading_Volume: r.volume ?? 0, Trading_money: 0, spread: 0, Trading_turnover: 0,
        })
      }

      let merged = 0
      for (const [symbol, d1Arr] of d1BySymbol) {
        const apiArr = data.prices.get(symbol)
        if (!apiArr || apiArr.length < 15) {
          // API 資料不足 15 天 → 用 D1 替代
          const d1Dates = new Set(d1Arr.map(p => p.date))
          // 合併 API 獨有的日期（可能有比 D1 更新的當日資料）
          if (apiArr) {
            for (const p of apiArr) {
              if (!d1Dates.has(p.date)) d1Arr.push(p)
            }
          }
          d1Arr.sort((a, b) => a.date.localeCompare(b.date))
          data.prices.set(symbol, d1Arr)
          merged++
        }
      }
      // 補充 API 完全沒有的股票（D1 有但 API 假日沒抓到）
      for (const [symbol, d1Arr] of d1BySymbol) {
        if (!data.prices.has(symbol)) {
          data.prices.set(symbol, d1Arr)
          merged++
        }
      }
      if (merged > 0) console.log(`[Screener v2] D1 補充 ${merged} 支股票的價格資料`)
    }
  } catch (e) {
    console.warn('[Screener v2] D1 stock_prices 補充失敗:', e)
  }

  // ── Step 1: Universe hard filter ──
  console.log('[Screener v2] Step 1: Universe filtering...')
  const universe: { stockId: string; prices: FMStockPrice[] }[] = []
  let skipPrice = 0, skipVol = 0, skipTurnover = 0, skipPunish = 0, skipVolZero = 0

  for (const [stockId, prices] of data.prices) {
    if (prices.length < 3) continue
    const latest = prices[prices.length - 1]

    // Hard filters
    if (latest.close < sc.minPrice || latest.close > sc.maxPrice) { skipPrice++; continue }
    if (latest.Trading_Volume === 0) { skipVolZero++; continue }
    if (punishedSet.has(stockId)) { skipPunish++; continue }

    const volSlice = prices.slice(-Math.min(20, prices.length))
    const avgVol20 = volSlice.reduce((s, p) => s + p.Trading_Volume, 0) / volSlice.length
    if (avgVol20 < sc.minAvgVolume) { skipVol++; continue }

    const avgDailyTurnover = avgVol20 * latest.close
    if (avgDailyTurnover < sc.minDailyTurnover) { skipTurnover++; continue }

    universe.push({ stockId, prices })
  }
  const universeMsg = `[Step 1] Universe: ${universe.length} 檔通過 | 篩掉: 股價=${skipPrice} 均量=${skipVol} 成交額=${skipTurnover} 處置=${skipPunish} 零量=${skipVolZero} 天數不足=${data.prices.size - universe.length - skipPrice - skipVol - skipTurnover - skipPunish - skipVolZero}`
  debugLog.push(universeMsg)
  console.log(universeMsg)

  // ── Step 2: 多因子評分 ──
  console.log('[Screener v2] Step 2: Multi-factor scoring...')
  type ScoredCandidate = ScreenerCandidate & { chip_score: number; tech_score: number; momentum_score: number; industry: string }
  const scored: ScoredCandidate[] = []

  for (const { stockId, prices } of universe) {
    const latest = prices[prices.length - 1]
    const chipDates = data.chips.get(stockId)
    const { base_score, chip_score, tech_score, momentum_score, reasons } = scoreMultiFactor(
      prices, chipDates, marketReturn5d, latest.close
    )

    const info = sectorMap[stockId]
    const industry = industryMap.get(stockId) ?? '其他'

    scored.push({
      symbol: stockId,
      name: info?.name ?? stockId,
      sector: industry,
      score: base_score,
      reason: reasons.slice(0, 3).join('；') || '符合篩選條件',
      chip_score, tech_score, momentum_score,
      industry,
    })
  }

  // Step 2 debug: top 30 scored
  debugLog.push(`[Step 2] 多因子評分完成: ${scored.length} 檔 | 大盤 5d return=${(marketReturn5d * 100).toFixed(2)}%`)
  const scoredSorted = [...scored].sort((a, b) => b.score - a.score)
  debugLog.push(`[Step 2] Top 15 (base_score):`)
  for (const c of scoredSorted.slice(0, 15)) {
    debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} | base=${c.score.toFixed(1)} chip=${c.chip_score} tech=${c.tech_score} mom=${c.momentum_score.toFixed(1)} | ${c.reason}`)
  }

  // Score 分布
  const ranges = [
    { label: '60+', min: 60 }, { label: '50-60', min: 50 }, { label: '40-50', min: 40 },
    { label: '30-40', min: 30 }, { label: '20-30', min: 20 }, { label: '<20', min: 0 },
  ]
  debugLog.push(`[Step 2] 分數分布: ${ranges.map(r => `${r.label}=${scored.filter(c => c.score >= r.min && (r.min === 0 || c.score < r.min + 10)).length}`).join(' ')}`)

  // ── Step 3: RRG 產業輪動加分 ──
  console.log('[Screener v2] Step 3: RRG industry rotation...')
  const rrg = await calcIndustryRRG(data, industryMap, env, cfg, endDate)

  // 寫 sector_flow + sector_heat
  const sectorHeatScores: SectorHeatScore[] = []
  for (const [industry, r] of rrg) {
    // 每個候選加 RRG bonus
    for (const c of scored) {
      if (c.industry === industry) c.score += r.bonus
    }
    // 建 sector_heat 資料
    const membersInUniverse = scored.filter(c => c.industry === industry)
    sectorHeatScores.push({
      sector: industry,
      score: r.rsRatio,
      components: {
        chipFlow: r.rsRatio,
        relativeStrength: r.rsMomentum,
        volumeExpansion: 0,
        momentum: r.bonus,
      },
      stockCount: membersInUniverse.length,
      topStocks: membersInUniverse.sort((a, b) => b.score - a.score).slice(0, 5).map(c => c.symbol),
    })
  }
  sectorHeatScores.sort((a, b) => b.score - a.score)

  // Step 3 debug
  const rrqSample = [...rrg.entries()].slice(0, 3).map(([k, v]) => `${k}:RS=${v.rsRatio.toFixed(2)}`).join(', ')
  debugLog.push(`[Step 3] RRG: ${rrg.size} 產業 | ${(rrg as any)._debug ?? 'no debug'} | sample=[${rrqSample}]`)
  const rrqQuadrants = { Leading: 0, Improving: 0, Weakening: 0, Lagging: 0 }
  for (const [ind, r] of rrg) {
    (rrqQuadrants as any)[r.quadrant] = ((rrqQuadrants as any)[r.quadrant] ?? 0) + 1
  }
  debugLog.push(`[Step 3] 象限分布: Leading=${rrqQuadrants.Leading} Improving=${rrqQuadrants.Improving} Weakening=${rrqQuadrants.Weakening} Lagging=${rrqQuadrants.Lagging}`)
  for (const [ind, r] of [...rrg.entries()].sort((a, b) => b[1].rsRatio - a[1].rsRatio).slice(0, 10)) {
    debugLog.push(`  ${ind}: RS=${r.rsRatio.toFixed(1)} Mom=${r.rsMomentum.toFixed(2)} ${r.quadrant} bonus=${r.bonus}`)
  }

  // 寫 sector_flow（RRG 資料）
  try {
    const flowBatch = [...rrg.entries()].map(([industry, r]) => {
      const members = scored.filter(c => c.industry === industry)
      return env.DB.prepare(`
        INSERT INTO sector_flow (date, sector, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d, stock_count, up_count, classification, rs_ratio, rs_momentum, quadrant)
        VALUES (?, ?, 0, 0, 0, NULL, 0, ?, 0, 'industry', ?, ?, ?)
        ON CONFLICT(date, sector) DO UPDATE SET
          rs_ratio=excluded.rs_ratio, rs_momentum=excluded.rs_momentum, quadrant=excluded.quadrant,
          stock_count=excluded.stock_count, classification='industry'
      `).bind(endDate, industry, members.length, r.rsRatio, r.rsMomentum, r.quadrant)
    })
    const BATCH = 50
    for (let i = 0; i < flowBatch.length; i += BATCH) {
      await env.DB.batch(flowBatch.slice(i, i + BATCH))
    }
  } catch (e) {
    console.warn('[Screener v2] sector_flow write failed:', e)
  }

  // ── Step 4: 情緒面加分 ──
  console.log('[Screener v2] Step 4: Sentiment scoring...')

  // 4a. 新聞情緒（D1 查詢）
  try {
    // 批次查所有候選的近 7 天新聞情緒
    const topSymbols = scored.sort((a, b) => b.score - a.score).slice(0, 100).map(c => c.symbol)
    if (topSymbols.length > 0) {
      // 查 stocks 表拿 stock_id
      const ph = topSymbols.map(() => '?').join(',')
      const { results: newsAgg } = await env.DB.prepare(`
        SELECT s.symbol, n.sentiment, COUNT(*) as cnt
        FROM news n
        JOIN stocks s ON n.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND n.published_at >= date('now', '-7 days')
        GROUP BY s.symbol, n.sentiment
      `).bind(...topSymbols).all<{ symbol: string; sentiment: string; cnt: number }>()

      const sentimentMap = new Map<string, { pos: number; neg: number; total: number }>()
      for (const r of (newsAgg ?? [])) {
        if (!sentimentMap.has(r.symbol)) sentimentMap.set(r.symbol, { pos: 0, neg: 0, total: 0 })
        const s = sentimentMap.get(r.symbol)!
        s.total += r.cnt
        if (r.sentiment === 'positive') s.pos += r.cnt
        if (r.sentiment === 'negative') s.neg += r.cnt
      }

      for (const c of scored) {
        const s = sentimentMap.get(c.symbol)
        if (!s || s.total === 0) continue
        const posRatio = s.pos / s.total
        const negRatio = s.neg / s.total
        if (posRatio > 0.6) c.score += 5
        else if (posRatio > 0.4) c.score += 3
        else if (negRatio > 0.4) c.score -= 3
      }
    }
  } catch (e) {
    console.warn('[Screener v2] News sentiment failed:', e)
  }

  // 4b. PTT buzz → 概念 → 個股加分
  const hotConcepts = new Set(combinedBuzz.slice(0, 10).map(b => b.concept))
  for (const c of scored) {
    const tags = symbolConceptTags.get(c.symbol) ?? []
    const matchedHot = tags.filter(t => hotConcepts.has(t))
    if (matchedHot.length > 0) {
      const buzzBonus = Math.min(5, matchedHot.length * 3)
      c.score += buzzBonus
      if (buzzBonus >= 3) c.reason += `；${matchedHot[0]}概念`
    }
  }

  // ── Step 5: 排序 + 去重 + 截斷 ──
  // Step 4 debug
  debugLog.push(`[Step 4] 情緒面加分完成 | PTT hot concepts: ${[...hotConcepts].join(', ')}`)
  const afterSentiment = [...scored].sort((a, b) => b.score - a.score)
  debugLog.push(`[Step 4] Top 10 (with sentiment):`)
  for (const c of afterSentiment.slice(0, 10)) {
    debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} | total=${c.score.toFixed(1)} | ${c.reason}`)
  }

  console.log('[Screener v2] Step 5: Sort, dedup, truncate...')
  scored.sort((a, b) => b.score - a.score)

  // ── Step 4b: 基本面加分（F-Score + 毛利率事件）──
  try {
    const topSymbols4b = scored.sort((a, b) => b.score - a.score).slice(0, 80).map(c => c.symbol)
    if (topSymbols4b.length > 0) {
      const ph = topSymbols4b.map(() => '?').join(',')

      // P2-4: 簡化版 F-Score（用 D1 financials 可用欄位）
      // 完整 F-Score 9 項，我們有: ROE(→ROA proxy), EPS, revenue_growth_yoy
      const { results: finRows } = await env.DB.prepare(`
        SELECT s.symbol, f.roe, f.eps, f.revenue_growth_yoy
        FROM financials f
        JOIN stocks s ON f.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND f.period_type = 'quarterly'
        AND f.period = (SELECT MAX(f2.period) FROM financials f2 WHERE f2.stock_id = f.stock_id AND f2.period_type = 'quarterly')
      `).bind(...topSymbols4b).all<{ symbol: string; roe: number | null; eps: number | null; revenue_growth_yoy: number | null }>()

      // 前一季
      const { results: prevFinRows } = await env.DB.prepare(`
        SELECT s.symbol, f.roe, f.eps
        FROM financials f
        JOIN stocks s ON f.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND f.period_type = 'quarterly'
        AND f.period = (SELECT MAX(f2.period) FROM financials f2 WHERE f2.stock_id = f.stock_id AND f2.period_type = 'quarterly' AND f2.period < (SELECT MAX(f3.period) FROM financials f3 WHERE f3.stock_id = f.stock_id AND f3.period_type = 'quarterly'))
      `).bind(...topSymbols4b).all<{ symbol: string; roe: number | null; eps: number | null }>()

      const prevFinMap = new Map<string, { roe: number | null; eps: number | null }>()
      for (const r of (prevFinRows ?? [])) prevFinMap.set(r.symbol, r)

      let fscoreApplied = 0
      for (const r of (finRows ?? [])) {
        let fScore = 0
        // 獲利性
        if (r.roe && r.roe > 0) fScore++                     // ROA proxy: ROE > 0
        if (r.eps && r.eps > 0) fScore++                     // EPS > 0
        // 成長性
        if (r.revenue_growth_yoy && r.revenue_growth_yoy > 0) fScore++  // 營收 YoY 成長
        const prev = prevFinMap.get(r.symbol)
        if (prev?.roe && r.roe && r.roe > prev.roe) fScore++ // ROE 改善
        if (prev?.eps && r.eps && r.eps > prev.eps) fScore++ // EPS 改善

        // F-Score >= 4 加分（滿分 5，對應完整 F-Score 的 8/9）
        const c = scored.find(s => s.symbol === r.symbol)
        if (c && fScore >= 4) {
          c.score += 5
          fscoreApplied++
        } else if (c && fScore >= 3) {
          c.score += 2
        } else if (c && fScore <= 1) {
          c.score -= 3  // 財務惡化扣分
        }
      }

      // P3-12: 毛利率創新高事件（簡化版 — 用 revenue_growth_yoy proxy）
      // 真正的毛利率需要 gross_margin 欄位，暫用營收 YoY > 20% 替代
      for (const r of (finRows ?? [])) {
        if (r.revenue_growth_yoy && r.revenue_growth_yoy > 20) {
          const c = scored.find(s => s.symbol === r.symbol)
          if (c) { c.score += 3; c.reason += '；營收高成長' }
        }
      }

      debugLog.push(`[Step 4b] F-Score 加分: ${fscoreApplied} 檔 (>=4分)`)
    }
  } catch (e) {
    console.warn('[Screener v2] F-Score/毛利率加分失敗:', e)
  }

  // ── P2-10: 外資淨買超天數佔比（大盤層級 risk overlay）──
  // P3-11: ATR V 轉指標
  try {
    const { results: foreignRows } = await env.DB.prepare(`
      SELECT date, SUM(foreign_net) as total_foreign_net
      FROM chip_data
      WHERE date >= date('now', '-40 days')
      GROUP BY date ORDER BY date
    `).all<{ date: string; total_foreign_net: number }>()

    if (foreignRows && foreignRows.length >= 10) {
      const buyDays = foreignRows.filter(r => r.total_foreign_net > 0).length
      const foreignBuyRatio = buyDays / foreignRows.length
      // < 0.4 = 外資持續賣超 → 全體候選扣分
      if (foreignBuyRatio < 0.35) {
        for (const c of scored) c.score -= 3
        debugLog.push(`[Step 4b] 外資避險: 買超天數佔比 ${(foreignBuyRatio * 100).toFixed(0)}% < 35% → 全體 -3`)
      } else if (foreignBuyRatio > 0.65) {
        debugLog.push(`[Step 4b] 外資偏多: 買超天數佔比 ${(foreignBuyRatio * 100).toFixed(0)}%`)
      } else {
        debugLog.push(`[Step 4b] 外資中性: 買超天數佔比 ${(foreignBuyRatio * 100).toFixed(0)}%`)
      }
    }
  } catch (e) {
    console.warn('[Screener v2] 外資天數佔比失敗:', e)
  }

  // ── Step 4c: 趨勢品質 + ADX + 流動性分級（D1 60 天歷史）──
  try {
    const top80 = scored.sort((a, b) => b.score - a.score).slice(0, 80).map(c => c.symbol)
    if (top80.length > 0) {
      const ph = top80.map(() => '?').join(',')
      // 查 60 天 OHLCV（ADX 需要 high/low）
      const { results: histRows } = await env.DB.prepare(`
        SELECT s.symbol, sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume
        FROM stock_prices sp JOIN stocks s ON sp.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-90 days')
        ORDER BY s.symbol, sp.date
      `).bind(...top80).all<{ symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }>()

      // 按 symbol 分組
      const histBySymbol = new Map<string, { close: number; high: number; low: number; volume: number }[]>()
      for (const r of (histRows ?? [])) {
        if (!histBySymbol.has(r.symbol)) histBySymbol.set(r.symbol, [])
        histBySymbol.get(r.symbol)!.push({ close: r.close, high: r.high ?? r.close, low: r.low ?? r.close, volume: r.volume ?? 0 })
      }

      // ── G1: 全 universe 的 intent 百分位排名（adaptive 門檻）──
      const intentMap = new Map<string, number>()
      for (const [sym, bars] of histBySymbol) {
        if (bars.length < 20) continue
        const latest = bars[bars.length - 1].close
        const first = bars[0].close
        let sumAbsRet = 0
        for (let i = 1; i < bars.length; i++) {
          if (bars[i - 1].close > 0) sumAbsRet += Math.abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close)
        }
        const netReturn = first > 0 ? (latest - first) / first : 0
        intentMap.set(sym, sumAbsRet > 0 ? netReturn / sumAbsRet : 0)
      }
      // 計算百分位門檻
      const intentValues = [...intentMap.values()].sort((a, b) => a - b)
      const p10 = intentValues[Math.floor(intentValues.length * 0.10)] ?? -0.3
      const p20 = intentValues[Math.floor(intentValues.length * 0.20)] ?? -0.1

      let trendPenalty = 0, intentPenalty = 0, adxPenalty = 0, liqPenalty = 0

      for (const c of scored) {
        const bars = histBySymbol.get(c.symbol)
        if (!bars || bars.length < 20) continue

        const latest = bars[bars.length - 1].close
        const first = bars[0].close
        const high60 = Math.max(...bars.map(b => b.close))

        // ① 距離 60 日高點回落
        const fromHigh = (latest - high60) / high60
        if (fromHigh < -0.15) {
          c.score -= 8
          c.reason += `；距高點${(fromHigh * 100).toFixed(0)}%`
          trendPenalty++
        } else if (fromHigh < -0.10) {
          c.score -= 5
          trendPenalty++
        }

        // ② G1: Intent adaptive 百分位扣分
        const intent = intentMap.get(c.symbol) ?? 0
        if (intent < p10 && intent < 0) {
          c.score -= 8  // 最差 10%（淨跌+高震盪）
          intentPenalty++
        } else if (intent < p20 && intent < 0) {
          c.score -= 5  // 最差 20%
          intentPenalty++
        } else if (intent > 0.4) {
          c.score += 3  // 優質直線上漲
        }

        // ③ G2+ADX: 計算 ADX 14 — 判斷有無趨勢
        if (bars.length >= 15) {
          // +DM / -DM / TR 計算
          let smoothPlusDM = 0, smoothMinusDM = 0, smoothTR = 0
          for (let i = 1; i < Math.min(15, bars.length); i++) {
            const upMove = bars[i].high - bars[i - 1].high
            const downMove = bars[i - 1].low - bars[i].low
            const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0
            const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0
            const tr = Math.max(
              bars[i].high - bars[i].low,
              Math.abs(bars[i].high - bars[i - 1].close),
              Math.abs(bars[i].low - bars[i - 1].close)
            )
            if (i <= 14) {
              smoothPlusDM += plusDM
              smoothMinusDM += minusDM
              smoothTR += tr
            }
          }
          // Wilder smoothing for remaining bars
          for (let i = 15; i < bars.length; i++) {
            const upMove = bars[i].high - bars[i - 1].high
            const downMove = bars[i - 1].low - bars[i].low
            const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0
            const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0
            const tr = Math.max(
              bars[i].high - bars[i].low,
              Math.abs(bars[i].high - bars[i - 1].close),
              Math.abs(bars[i].low - bars[i - 1].close)
            )
            smoothPlusDM = smoothPlusDM - smoothPlusDM / 14 + plusDM
            smoothMinusDM = smoothMinusDM - smoothMinusDM / 14 + minusDM
            smoothTR = smoothTR - smoothTR / 14 + tr
          }
          const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0
          const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0
          const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0
          const adx = dx  // 簡化：用最新 DX 近似 ADX（完整 ADX 需要 DX 的 14 日均值）

          // ADX < 15 + 法人大買 = 無趨勢但法人掃貨（國光生 pattern）
          if (adx < 15 && (c as any).chip_score >= 20) {
            c.score -= 5
            c.reason += `；ADX${adx.toFixed(0)}無趨勢`
            adxPenalty++
          } else if (adx > 30) {
            // 強趨勢加分（搭配 intent 方向）
            if (intent > 0.1) c.score += 2
          }
        }

        // ④ G4: 流動性分級（不提高硬門檻，用分數機制）
        const avgTurnover = bars.reduce((s, b) => s + b.close * b.volume, 0) / bars.length
        if (avgTurnover < 10_000_000) {        // < 1000 萬
          c.score -= 5
          liqPenalty++
        } else if (avgTurnover < 30_000_000) { // 1000~3000 萬
          c.score -= 2
          liqPenalty++
        } else if (avgTurnover > 100_000_000) { // > 1 億
          c.score += 2  // 高流動性優勢
        }
      }

      debugLog.push(`[Step 4c] 趨勢品質: 距高點=${trendPenalty} intent=${intentPenalty} ADX無趨勢=${adxPenalty} 低流動性=${liqPenalty}`)
      debugLog.push(`[Step 4c] Intent adaptive: p10=${p10.toFixed(3)} p20=${p20.toFixed(3)}`)
    }
  } catch (e) {
    console.warn('[Screener v2] 趨勢品質 filter 失敗:', e)
  }

  // 5a+5b: 同產業上限
  const maxPerIndustry = (sc as any).maxPerIndustry ?? 5
  const industryCount = new Map<string, number>()
  let afterIndustryLimit = scored.filter(c => {
    const cnt = industryCount.get(c.industry) ?? 0
    if (cnt >= maxPerIndustry) return false
    industryCount.set(c.industry, cnt + 1)
    return true
  })

  // 5c: 報酬率相關性去重
  const corrThreshold = (sc as any).correlationThreshold ?? 0.8
  const corrWindow = (sc as any).correlationWindow ?? 60
  try {
    // 只對 top 50 做去重（節省計算）
    const top50 = afterIndustryLimit.slice(0, 50)
    afterIndustryLimit = [
      ...(await deduplicateByCorrelation(top50, env.DB, corrThreshold, corrWindow)) as ScoredCandidate[],
      ...afterIndustryLimit.slice(50),
    ]
  } catch (e) {
    console.warn('[Screener v2] Correlation dedup failed:', e)
  }

  // 5d: top N 截斷
  const maxCandidates = (sc as any).maxCandidates ?? 25
  const finalCandidates: ScreenerCandidate[] = afterIndustryLimit.slice(0, maxCandidates)
  const step5Msg = `[Step 5] ${scored.length} 檔 → 同產業≤${maxPerIndustry} → ${afterIndustryLimit.length} 檔 → top ${maxCandidates} → ${finalCandidates.length} 檔`
  debugLog.push(step5Msg)
  console.log(step5Msg)

  // 被產業上限篩掉的
  const removedByIndustry = scored.filter(c => !afterIndustryLimit.includes(c)).slice(0, 10)
  if (removedByIndustry.length) {
    debugLog.push(`[Step 5b] 被同產業上限篩掉（前 10）:`)
    for (const c of removedByIndustry) {
      debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} score=${c.score.toFixed(1)}`)
    }
  }

  // 被去重篩掉的
  const afterDedupSet = new Set(afterIndustryLimit.map(c => c.symbol))
  const removedByDedup = afterIndustryLimit.filter(c => !afterDedupSet.has(c.symbol))
  // 被截斷的
  const truncated = afterIndustryLimit.slice(maxCandidates)
  if (truncated.length) {
    debugLog.push(`[Step 5d] 被 top ${maxCandidates} 截斷（前 10）:`)
    for (const c of truncated.slice(0, 10)) {
      debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} score=${c.score.toFixed(1)}`)
    }
  }

  // ── Step 6: 資料品質（DelistingMonitor）──
  try {
    const candSymbols = finalCandidates.map(c => c.symbol)
    if (candSymbols.length > 0) {
      const ph = candSymbols.map(() => '?').join(',')
      const { results: recentRows } = await env.DB.prepare(`
        SELECT s.symbol, COUNT(sp.date) as days_count
        FROM stocks s
        LEFT JOIN stock_prices sp ON sp.stock_id = s.id AND sp.date >= date('now', '-7 days')
        WHERE s.symbol IN (${ph})
        GROUP BY s.symbol
      `).bind(...candSymbols).all<{ symbol: string; days_count: number }>()
      const delistRisk = new Set<string>()
      for (const r of (recentRows ?? [])) {
        if (r.days_count <= 2) delistRisk.add(r.symbol)
      }
      if (delistRisk.size > 0) {
        const removed = finalCandidates.filter(c => delistRisk.has(c.symbol))
        for (let i = finalCandidates.length - 1; i >= 0; i--) {
          if (delistRisk.has(finalCandidates[i].symbol)) finalCandidates.splice(i, 1)
        }
        if (removed.length) console.log(`[Screener v2] DelistingMonitor: removed ${removed.map(c => c.symbol).join(', ')}`)
      }
    }
  } catch (e) {
    console.warn('[Screener v2] DelistingMonitor failed:', e)
  }

  console.log(`[Screener v2] Final: ${finalCandidates.length} candidates`)

  // ── DB 寫入 ──
  try {
    await updateScreenerWatchlist(env.DB, finalCandidates, tpexSymbolSet)
  } catch (e) {
    console.error('[Screener v2] Watchlist update failed:', e)
  }

  // Screener 分數寫入 daily_recommendations（chip+tech+current_price，ML 由 recommendation 補）
  try {
    await env.DB.prepare("DELETE FROM daily_recommendations WHERE date = ?").bind(endDate).run()
    const recBatch = finalCandidates.map((c, i) => {
      const sc = c as any
      // 從即時 API 資料取最新收盤價（不寫 null）
      const latestPrices = data.prices.get(c.symbol)
      const currentPrice = latestPrices?.length ? latestPrices[latestPrices.length - 1].close : null
      return env.DB.prepare(`
        INSERT INTO daily_recommendations
          (date, stock_id, symbol, name, sector, rank, score,
           chip_score, tech_score, ml_score, current_price,
           reason, watch_points, has_buy_signal, industry)
        VALUES (?, (SELECT id FROM stocks WHERE symbol=?), ?, ?, ?, ?, ?,
                ?, ?, 0, ?, ?, '[]', 0, ?)
      `).bind(
        endDate, c.symbol, c.symbol, c.name ?? null, c.sector ?? null,
        i + 1, Math.round((sc.chip_score + sc.tech_score + sc.momentum_score) * 10) / 10,
        sc.chip_score ?? 0, sc.tech_score ?? 0,
        currentPrice ?? null,
        c.reason ?? null, sc.industry ?? c.sector ?? null,
      )
    })
    const BATCH = 50
    for (let b = 0; b < recBatch.length; b += BATCH) {
      await env.DB.batch(recBatch.slice(b, b + BATCH))
    }

    // 保證所有候選都 is_active=1（防止 updateScreenerWatchlist batch 失敗的邊界情況）
    await env.DB.prepare(
      "UPDATE stocks SET is_active=1 WHERE symbol IN (SELECT symbol FROM daily_recommendations WHERE date=?)"
    ).bind(endDate).run()

    console.log(`[Screener v2] daily_recommendations 寫入 ${finalCandidates.length} 筆（chip+tech+price）`)

    // 對缺 technical_indicators 的新股立即計算（不等 Queue，避免 ML NO_SIGNAL）
    try {
      const { computeAndStoreIndicators } = await import('../routes/stocks')
      const { results: noTiStocks } = await env.DB.prepare(`
        SELECT s.id, s.symbol FROM stocks s
        WHERE s.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM technical_indicators ti WHERE ti.stock_id = s.id AND ti.date >= date('now', '-3 days'))
          AND EXISTS (SELECT 1 FROM stock_prices sp WHERE sp.stock_id = s.id LIMIT 1)
      `).all<{ id: number; symbol: string }>()

      if (noTiStocks?.length) {
        let computed = 0
        for (const stock of noTiStocks) {
          await computeAndStoreIndicators(env.DB, stock.id)
          computed++
        }
        console.log(`[Screener v2] 補算 ${computed} 支新股的 technical_indicators: ${noTiStocks.map(s => s.symbol).join(', ')}`)
      }
    } catch (e) {
      console.warn('[Screener v2] 新股 TI 補算失敗 (non-blocking):', e)
    }
  } catch (e) {
    console.warn('[Screener v2] daily_recommendations 寫入失敗:', e)
  }

  try {
    await storeSectorHeat(env.DB, endDate, sectorHeatScores)
  } catch (e) {
    console.warn('[Screener v2] sector_heat write failed:', e)
  }

  try {
    await storePttBuzz(env.DB, endDate, combinedBuzz)
  } catch (e) {
    console.warn('[Screener v2] buzz write failed:', e)
  }

  // Discord 通知
  try {
    const { sendDiscordNotification } = await import('./notify')
    const leadingIndustries = [...rrg.entries()].filter(([, v]) => v.quadrant === 'Leading').map(([k]) => k).join(', ')
    const topCands = finalCandidates.slice(0, 5).map(c => `${c.symbol}${c.name}(${c.score.toFixed(0)})`).join(' ')
    const pttTop = combinedBuzz.slice(0, 3).map(b => `${b.concept}(${b.mentionCount})`).join(', ')
    void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
      `🔍 **Bottom-up 多因子選股完成**\n` +
      `> 📊 候選：${finalCandidates.length} 支（上限 ${maxCandidates}）\n` +
      `> 🏭 Leading 產業：${leadingIndustries || '無'}\n` +
      `> 🏆 Top 5：${topCands}\n` +
      `> 💬 PTT 熱議：${pttTop || '無'}`)
  } catch (e) {
    console.warn('[Screener v2] Discord failed:', e)
  }

  // Final debug summary
  debugLog.push(`[Final] ${finalCandidates.length} 檔:`)
  for (const c of finalCandidates) {
    debugLog.push(`  ${c.symbol} ${(c as any).name ?? ''} ${(c as any).industry ?? c.sector} score=${c.score.toFixed(1)}`)
  }

  return { hotSectors: sectorHeatScores, candidates: finalCandidates, debugLog }
}

// ═══════════════════════════════════════════════════════════════════════════════
// P2-7: IC（Information Coefficient）驗證框架
// P3-8: MAE 停損分析
// P3-6: Z-score 工具
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * P3-6: Z-score 標準化工具
 * 將任意數值陣列轉為 Z-score，截斷 [-3, 3]
 */
function zScore(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 0.001
  return values.map(v => Math.max(-3, Math.min(3, (v - mean) / std)))
}

/**
 * P2-7: 因子 IC 計算 — 各因子與未來 N 日報酬的 Spearman rank correlation
 * 用於驗證 chip_score / tech_score / momentum_score 的預測力
 * 門檻：IC > 0.05 (ML), > 0.01 (Factor)
 */
export async function calcFactorIC(env: Bindings): Promise<{
  factors: { name: string; ic_5d: number; ic_10d: number; ic_20d: number; sample: number }[]
}> {
  // 查最近 30 天的 daily_recommendations（有 chip_score, tech_score, ml_score）
  const { results: recRows } = await env.DB.prepare(`
    SELECT r.symbol, r.date, r.chip_score, r.tech_score, r.ml_score, r.score as total_score
    FROM daily_recommendations r
    WHERE r.date >= date('now', '-30 days')
    ORDER BY r.date, r.symbol
  `).all<{ symbol: string; date: string; chip_score: number; tech_score: number; ml_score: number; total_score: number }>()

  if (!recRows?.length) return { factors: [] }

  // 查每支股票的未來報酬（5d, 10d, 20d）
  const symbols = [...new Set(recRows.map(r => r.symbol))]
  const ph = symbols.map(() => '?').join(',')
  const { results: priceRows } = await env.DB.prepare(`
    SELECT s.symbol, sp.date, sp.close
    FROM stock_prices sp JOIN stocks s ON sp.stock_id = s.id
    WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-60 days')
    ORDER BY s.symbol, sp.date
  `).bind(...symbols).all<{ symbol: string; date: string; close: number }>()

  // 建 symbol → date → close map
  const priceMap = new Map<string, Map<string, number>>()
  for (const r of (priceRows ?? [])) {
    if (!priceMap.has(r.symbol)) priceMap.set(r.symbol, new Map())
    priceMap.get(r.symbol)!.set(r.date, r.close)
  }

  // Spearman rank correlation
  function spearmanCorr(x: number[], y: number[]): number {
    const n = x.length
    if (n < 5) return 0
    const rankX = rankArray(x), rankY = rankArray(y)
    let sumD2 = 0
    for (let i = 0; i < n; i++) sumD2 += (rankX[i] - rankY[i]) ** 2
    return 1 - (6 * sumD2) / (n * (n * n - 1))
  }
  function rankArray(arr: number[]): number[] {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const ranks = new Array(arr.length)
    sorted.forEach((s, rank) => { ranks[s.i] = rank + 1 })
    return ranks
  }

  // 計算每個因子的 IC
  const factors = ['chip_score', 'tech_score', 'ml_score', 'total_score'] as const
  const results = []

  for (const factor of factors) {
    const ic: { [horizon: string]: number[] } = { '5d': [], '10d': [], '20d': [] }

    // 按日期分組算橫截面 IC
    const byDate = new Map<string, typeof recRows>()
    for (const r of recRows) {
      if (!byDate.has(r.date)) byDate.set(r.date, [])
      byDate.get(r.date)!.push(r)
    }

    for (const [date, recs] of byDate) {
      for (const [horizon, days] of [['5d', 5], ['10d', 10], ['20d', 20]] as const) {
        const factorValues: number[] = []
        const futureReturns: number[] = []

        for (const rec of recs) {
          const prices = priceMap.get(rec.symbol)
          if (!prices) continue
          const dates = [...prices.keys()].sort()
          const dateIdx = dates.indexOf(date)
          if (dateIdx < 0 || dateIdx + days >= dates.length) continue

          const closeNow = prices.get(dates[dateIdx])!
          const closeFuture = prices.get(dates[dateIdx + days])!
          if (closeNow <= 0) continue

          factorValues.push(rec[factor])
          futureReturns.push((closeFuture - closeNow) / closeNow)
        }

        if (factorValues.length >= 5) {
          ic[horizon].push(spearmanCorr(factorValues, futureReturns))
        }
      }
    }

    results.push({
      name: factor,
      ic_5d: ic['5d'].length ? +(ic['5d'].reduce((a, b) => a + b, 0) / ic['5d'].length).toFixed(4) : 0,
      ic_10d: ic['10d'].length ? +(ic['10d'].reduce((a, b) => a + b, 0) / ic['10d'].length).toFixed(4) : 0,
      ic_20d: ic['20d'].length ? +(ic['20d'].reduce((a, b) => a + b, 0) / ic['20d'].length).toFixed(4) : 0,
      sample: recRows.length,
    })
  }

  return { factors: results }
}

/**
 * P3-8: MAE 停損分析 — 用 predictions 表的 max_adverse_pct 分析最佳停損點
 */
export async function analyzeMAE(env: Bindings): Promise<{
  summary: {
    total_trades: number
    winning_trades: number
    losing_trades: number
    winning_mae_p75: number   // 獲利交易的 75 百分位 MAE
    losing_mae_p25: number    // 虧損交易的 25 百分位 MAE
    suggested_stop: number    // 建議停損 %
  }
  distribution: { bucket: string; winning: number; losing: number }[]
}> {
  const { results: trades } = await env.DB.prepare(`
    SELECT max_adverse_pct, actual_return_pct, trade_outcome
    FROM predictions
    WHERE max_adverse_pct IS NOT NULL AND actual_return_pct IS NOT NULL
    ORDER BY generated_at DESC LIMIT 500
  `).all<{ max_adverse_pct: number; actual_return_pct: number; trade_outcome: string | null }>()

  if (!trades?.length) return {
    summary: { total_trades: 0, winning_trades: 0, losing_trades: 0, winning_mae_p75: 0, losing_mae_p25: 0, suggested_stop: -0.10 },
    distribution: [],
  }

  const winning = trades.filter(t => t.actual_return_pct > 0)
  const losing = trades.filter(t => t.actual_return_pct <= 0)

  // MAE 分布（每 2% 一個 bucket）
  const buckets = ['-2%', '-4%', '-6%', '-8%', '-10%', '-12%', '-15%', '-20%', '>-20%']
  const thresholds = [-0.02, -0.04, -0.06, -0.08, -0.10, -0.12, -0.15, -0.20, -1]
  const distribution = buckets.map((bucket, i) => {
    const lo = i === 0 ? 0 : thresholds[i - 1]
    const hi = thresholds[i]
    return {
      bucket,
      winning: winning.filter(t => t.max_adverse_pct >= hi && t.max_adverse_pct < lo).length,
      losing: losing.filter(t => t.max_adverse_pct >= hi && t.max_adverse_pct < lo).length,
    }
  })

  // 百分位計算
  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * p)
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0
  }

  const winMAEs = winning.map(t => t.max_adverse_pct)
  const loseMAEs = losing.map(t => t.max_adverse_pct)

  // 建議停損：獲利交易 75 百分位 MAE（保留大部分獲利交易）
  const winP75 = winMAEs.length ? percentile(winMAEs, 0.25) : -0.05  // 25th percentile of MAE (most negative)
  const suggestedStop = Math.min(winP75 * 1.2, -0.03)  // 多留 20% buffer，最少 -3%

  return {
    summary: {
      total_trades: trades.length,
      winning_trades: winning.length,
      losing_trades: losing.length,
      winning_mae_p75: +(winP75 * 100).toFixed(2),
      losing_mae_p25: loseMAEs.length ? +(percentile(loseMAEs, 0.25) * 100).toFixed(2) : 0,
      suggested_stop: +suggestedStop.toFixed(4),
    },
    distribution,
  }
}
