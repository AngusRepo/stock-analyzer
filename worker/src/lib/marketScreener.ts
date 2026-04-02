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

interface SectorAgg {
  stocks: string[]
  // chip data
  foreignNetByDate: Map<string, number>
  trustNetByDate: Map<string, number>
  totalChipNet: number
  // price data
  returns5d: number[]
  upCount: number
  totalVolume: number
  avgVolume20d: number
  highestInSector20d: boolean[]  // per stock: is near 20d high?
  avgMa5: number
  avgMa20: number
  priceCount: number
}

function computeSectorHeatScores(
  data: StockDailyData,
  sectorMap: SectorMap,
  marketReturn5d: number,
): SectorHeatScore[] {
  // Aggregate by sector
  const sectors = new Map<string, SectorAgg>()

  for (const [stockId, prices] of data.prices) {
    const info = sectorMap[stockId]
    if (!info?.sector) continue
    if (prices.length < 2) continue

    const sector = info.sector
    if (!sectors.has(sector)) {
      sectors.set(sector, {
        stocks: [],
        foreignNetByDate: new Map(),
        trustNetByDate: new Map(),
        totalChipNet: 0,
        returns5d: [],
        upCount: 0,
        totalVolume: 0,
        avgVolume20d: 0,
        highestInSector20d: [],
        avgMa5: 0,
        avgMa20: 0,
        priceCount: 0,
      })
    }
    const agg = sectors.get(sector)!
    agg.stocks.push(stockId)

    // Chip aggregation by date
    const chipDates = data.chips.get(stockId)
    if (chipDates) {
      for (const [date, nets] of chipDates) {
        agg.foreignNetByDate.set(date, (agg.foreignNetByDate.get(date) ?? 0) + nets.foreign)
        agg.trustNetByDate.set(date, (agg.trustNetByDate.get(date) ?? 0) + nets.trust)
        agg.totalChipNet += nets.foreign + nets.trust
      }
    }

    // Price metrics
    const latest = prices[prices.length - 1]
    const idx5 = Math.max(0, prices.length - 6)
    const price5dAgo = prices[idx5]
    if (latest.close > 0 && price5dAgo.close > 0) {
      const ret = (latest.close - price5dAgo.close) / price5dAgo.close
      agg.returns5d.push(ret)
      if (ret >= 0) agg.upCount++
    }

    // Volume: total recent vs 20d average
    const last5 = prices.slice(-5)
    const last20 = prices.slice(-20)
    agg.totalVolume += last5.reduce((s, p) => s + p.Trading_Volume, 0)
    agg.avgVolume20d += last20.reduce((s, p) => s + p.Trading_Volume, 0) / Math.max(1, last20.length)

    // 20d high check
    const max20 = Math.max(...prices.slice(-20).map(p => p.max))
    agg.highestInSector20d.push(latest.close >= max20 * 0.97) // within 3% of 20d high

    // MA approximations for momentum
    if (prices.length >= 20) {
      const ma5 = prices.slice(-5).reduce((s, p) => s + p.close, 0) / 5
      const ma20 = prices.slice(-20).reduce((s, p) => s + p.close, 0) / 20
      agg.avgMa5 += ma5
      agg.avgMa20 += ma20
      agg.priceCount++
    }
  }

  // Calculate total market chip flow for normalization
  let totalMarketChip = 0
  for (const agg of sectors.values()) {
    totalMarketChip += Math.abs(agg.totalChipNet)
  }

  // Score each sector
  const scored: SectorHeatScore[] = []

  for (const [sector, agg] of sectors) {
    if (agg.stocks.length < 3) continue // 太少股票的族群不計

    // ① chipFlow (0-40): 法人資金集中度
    let chipFlow = 0
    {
      // 外資+投信同向買超天數 (5天內 >=3天同向)
      const dates = [...new Set([...agg.foreignNetByDate.keys(), ...agg.trustNetByDate.keys()])].sort().slice(-5)
      let alignedDays = 0
      for (const d of dates) {
        const fNet = agg.foreignNetByDate.get(d) ?? 0
        const tNet = agg.trustNetByDate.get(d) ?? 0
        if (fNet > 0 && tNet > 0) alignedDays++
      }
      chipFlow += normalize(alignedDays, 0, 5, 15)

      // 族群淨買超金額佔全市場比例
      const chipShare = totalMarketChip > 0 ? agg.totalChipNet / totalMarketChip : 0
      chipFlow += normalize(chipShare, -0.1, 0.3, 15)

      // 加速 vs 減速：近2日 chip vs 前3日 chip
      const recentDates = dates.slice(-2)
      const olderDates = dates.slice(0, 3)
      const recentChip = recentDates.reduce((s, d) =>
        s + (agg.foreignNetByDate.get(d) ?? 0) + (agg.trustNetByDate.get(d) ?? 0), 0)
      const olderChip = olderDates.reduce((s, d) =>
        s + (agg.foreignNetByDate.get(d) ?? 0) + (agg.trustNetByDate.get(d) ?? 0), 0)
      const accel = olderChip !== 0 ? (recentChip - olderChip) / Math.abs(olderChip) : 0
      chipFlow += normalize(accel, -1, 1, 10)
    }
    chipFlow = clamp(chipFlow, 0, 40)

    // ② relativeStrength (0-30): 族群相對強度
    let relativeStrength = 0
    {
      const avgReturn = agg.returns5d.length > 0
        ? agg.returns5d.reduce((a, b) => a + b, 0) / agg.returns5d.length
        : 0
      // vs 大盤
      const excessReturn = avgReturn - marketReturn5d
      relativeStrength += normalize(excessReturn, -0.03, 0.05, 12)

      // 族群內上漲家數比例
      const upRatio = agg.returns5d.length > 0
        ? agg.upCount / agg.returns5d.length
        : 0
      relativeStrength += normalize(upRatio, 0.3, 0.85, 10)

      // 龍頭股創近20日新高
      const nearHighCount = agg.highestInSector20d.filter(Boolean).length
      const nearHighRatio = agg.highestInSector20d.length > 0
        ? nearHighCount / agg.highestInSector20d.length
        : 0
      relativeStrength += normalize(nearHighRatio, 0, 0.3, 8)
    }
    relativeStrength = clamp(relativeStrength, 0, 30)

    // ③ volumeExpansion (0-20): 成交量擴張
    let volumeExpansion = 0
    {
      const volRatio = agg.avgVolume20d > 0
        ? agg.totalVolume / (agg.avgVolume20d * 5)  // normalize to ~5 day window
        : 1
      volumeExpansion += normalize(volRatio, 0.5, 2.0, 14)

      // 量先價行 bonus：量放大但漲幅 <2%
      const avgReturn = agg.returns5d.length > 0
        ? agg.returns5d.reduce((a, b) => a + b, 0) / agg.returns5d.length
        : 0
      if (volRatio > 1.3 && avgReturn < 0.02 && avgReturn > -0.01) {
        volumeExpansion += 6 // 量先價行 bonus
      }
    }
    volumeExpansion = clamp(volumeExpansion, 0, 20)

    // ④ momentum (0-10): 動量趨勢
    let momentum = 0
    {
      const avgReturn = agg.returns5d.length > 0
        ? agg.returns5d.reduce((a, b) => a + b, 0) / agg.returns5d.length
        : 0
      momentum += avgReturn > 0 ? 5 : 0

      // MA5 > MA20 (多頭排列)
      if (agg.priceCount > 0) {
        const sectorMa5 = agg.avgMa5 / agg.priceCount
        const sectorMa20 = agg.avgMa20 / agg.priceCount
        if (sectorMa5 > sectorMa20) momentum += 5
      }
    }
    momentum = clamp(momentum, 0, 10)

    const totalScore = chipFlow + relativeStrength + volumeExpansion + momentum

    // 找代表股：chip 最大的前 5 支
    const stockChips = agg.stocks.map(id => {
      const cd = data.chips.get(id)
      let net = 0
      if (cd) for (const v of cd.values()) net += v.foreign + v.trust
      return { id, net }
    }).sort((a, b) => b.net - a.net)
    const topStocks = stockChips.slice(0, 5).map(s => s.id)

    scored.push({
      sector,
      score: Math.round(totalScore * 10) / 10,
      components: {
        chipFlow: Math.round(chipFlow * 10) / 10,
        relativeStrength: Math.round(relativeStrength * 10) / 10,
        volumeExpansion: Math.round(volumeExpansion * 10) / 10,
        momentum: Math.round(momentum * 10) / 10,
      },
      stockCount: agg.stocks.length,
      topStocks,
    })
  }

  return scored.sort((a, b) => b.score - a.score)
}

// ─── Stage 2: Individual Stock Filter ────────────────────────────────────────

function filterCandidates(
  data: StockDailyData,
  hotSectors: SectorHeatScore[],
  sectorMap: SectorMap,
  sc: TradingConfig['screener'],
): ScreenerCandidate[] {
  const candidates: ScreenerCandidate[] = []
  const hotSectorNames = new Set(hotSectors.map(s => s.sector))

  for (const [stockId, prices] of data.prices) {
    const info = sectorMap[stockId]
    if (!info?.sector || !hotSectorNames.has(info.sector)) continue
    if (info.market === 'EMERGING') continue  // 排除興櫃
    if (prices.length < 3) continue  // 至少 3 天資料（TWSE 抓 5 天）

    const latest = prices[prices.length - 1]

    // ── Exclusion filters ──
    // 股價過濾
    if (latest.close < sc.minPrice) continue
    // 日均量過濾
    const volSlice = prices.slice(-Math.min(20, prices.length))
    const avgVol20 = volSlice.reduce((s, p) => s + p.Trading_Volume, 0) / volSlice.length
    if (avgVol20 < sc.minAvgVolume) continue
    // Survivorship Bias 防護：日均成交金額過濾（排除殭屍股 / 即將下市）
    // Why: 低成交金額 = 低流動性 + 高價格操縱風險 + 可能正在衰退
    const avgDailyTurnover = avgVol20 * latest.close
    if (avgDailyTurnover < sc.minDailyTurnover) continue
    // 近5日跌幅過濾
    const price5dAgo = prices[Math.max(0, prices.length - 6)]
    if (price5dAgo.close > 0 && (latest.close - price5dAgo.close) / price5dAgo.close < sc.max5dDrop) continue

    // ── Scoring ──
    let score = 0
    const reasons: string[] = []

    // ① Relative Strength vs sector avg (0-30)
    const sectorInfo = hotSectors.find(s => s.sector === info.sector)
    // compute sector avg return
    const sectorStockIds = [...data.prices.keys()].filter(id => sectorMap[id]?.sector === info.sector)
    let sectorAvgReturn = 0
    let sectorRetCount = 0
    for (const sid of sectorStockIds) {
      const sp = data.prices.get(sid)
      if (!sp || sp.length < 6) continue
      const r = (sp[sp.length - 1].close - sp[Math.max(0, sp.length - 6)].close) / sp[Math.max(0, sp.length - 6)].close
      sectorAvgReturn += r
      sectorRetCount++
    }
    sectorAvgReturn = sectorRetCount > 0 ? sectorAvgReturn / sectorRetCount : 0
    const stockReturn = (latest.close - price5dAgo.close) / price5dAgo.close
    const excessVsSector = stockReturn - sectorAvgReturn
    const rsScore = normalize(excessVsSector, -0.03, 0.05, 30)
    score += rsScore
    if (excessVsSector > 0.02) reasons.push(`族群內相對強勢+${(excessVsSector * 100).toFixed(1)}%`)

    // ② 法人連續買超天數 (0-25)
    const chipDates = data.chips.get(stockId)
    let consecBuyDays = 0
    if (chipDates) {
      const sortedDates = [...chipDates.keys()].sort().slice(-5)
      for (let i = sortedDates.length - 1; i >= 0; i--) {
        const d = sortedDates[i]
        const nets = chipDates.get(d)!
        if (nets.foreign + nets.trust > 0) consecBuyDays++
        else break
      }
    }
    const chipScore = normalize(consecBuyDays, 0, 5, 25)
    score += chipScore
    if (consecBuyDays >= 3) reasons.push(`法人連買${consecBuyDays}天`)

    // ③ 技術面健康度: RSI proxy (0-20)
    // Approximate RSI from price changes
    const changes14 = prices.slice(-15).map((p, i, arr) =>
      i === 0 ? 0 : p.close - arr[i - 1].close
    ).slice(1)
    const gains = changes14.filter(c => c > 0)
    const losses = changes14.filter(c => c < 0).map(c => -c)
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0.001
    const rs = avgGain / avgLoss
    const rsi = 100 - 100 / (1 + rs)
    let rsiScore = 0
    if (rsi >= 40 && rsi <= 70) {
      // Optimal range — peak at 55-65
      rsiScore = rsi >= 50 && rsi <= 65 ? 20 : 14
    } else if (rsi > 70 && rsi <= 80) {
      rsiScore = 8 // 偏高但動能仍在
    } else if (rsi >= 30 && rsi < 40) {
      rsiScore = 6 // 偏低但未崩
    }
    score += rsiScore
    if (rsi >= 50 && rsi <= 65) reasons.push(`RSI ${rsi.toFixed(0)} 健康區間`)

    // ④ 成交量 vs 20日均量 (0-15)
    const recentVol = prices.slice(-3).reduce((s, p) => s + p.Trading_Volume, 0) / 3
    const volRatio = avgVol20 > 0 ? recentVol / avgVol20 : 1
    const volScore = normalize(volRatio, 0.7, 2.5, 15)
    score += volScore
    if (volRatio > sc.strongVolRatio) reasons.push(`量能放大${volRatio.toFixed(1)}倍`)

    // ⑤ 價格 > MA (0-10) — 用可用天數的均線
    const maSlice = prices.slice(-Math.min(20, prices.length))
    const ma20 = maSlice.reduce((s, p) => s + p.close, 0) / maSlice.length
    const aboveMa20 = latest.close > ma20
    if (aboveMa20) {
      score += 10
      reasons.push('站上MA20')
    }

    // ⑥ RSI 鈍化加分 (0-8) — RSI > 80 連續 3+ 天 = 強勢動量（FinLab 策略）
    if (rsi > 80) {
      // 往回數連續 RSI > 80 的天數（用近 5 日 price changes 近似）
      const recentChanges = prices.slice(-6).map((p, i, arr) =>
        i === 0 ? 0 : p.close - arr[i - 1].close
      ).slice(1)
      let consecHighRsi = 0
      for (let d = recentChanges.length - 1; d >= 0; d--) {
        // 近似：近日漲多 = RSI 偏高
        if (recentChanges[d] > 0) consecHighRsi++
        else break
      }
      if (consecHighRsi >= 3) {
        score += 8
        reasons.push(`RSI 鈍化${consecHighRsi}天`)
      }
    }

    // ⑦ 肯特納通道突破 (0-6) — close > MA20 + 1.5*ATR = 趨勢突破
    if (prices.length >= 14) {
      // 近似 ATR：14 日 true range 均值
      const trueRanges = prices.slice(-15).map((p, i, arr) => {
        if (i === 0) return p.max - p.min
        const prev = arr[i - 1]
        return Math.max(p.max - p.min, Math.abs(p.max - prev.close), Math.abs(p.min - prev.close))
      }).slice(1)
      const atr14 = trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length
      const keltnerUpper = ma20 + 1.5 * atr14
      if (latest.close > keltnerUpper && atr14 > 0) {
        score += 6
        reasons.push('突破肯特納上軌')
      }
    }

    candidates.push({
      symbol: stockId,
      name: info.name,
      sector: info.sector,
      score: Math.round(score * 10) / 10,
      reason: reasons.slice(0, 3).join('；') || '符合篩選條件',
    })
  }

  // 每個族群取 top N
  const result: ScreenerCandidate[] = []
  for (const hs of hotSectors) {
    const sectorCandidates = candidates
      .filter(c => c.sector === hs.sector)
      .sort((a, b) => b.score - a.score)
      .slice(0, sc.topNPerSector)
    result.push(...sectorCandidates)
  }

  return result.sort((a, b) => b.score - a.score)
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

export async function runMarketScreener(env: Bindings): Promise<{
  hotSectors: SectorHeatScore[]
  candidates: ScreenerCandidate[]
}> {
  console.log('[Screener] Starting concept-based screening...')
  const cfg = await getTradingConfig(env.KV)
  const sc = cfg.screener

  const endDate = today()

  // ── Step 1: PTT + News + Anue Buzz + TWSE Price 平行抓 ─────────────────
  const { detectPttBuzz, storePttBuzz, loadBuzzKeywords } = await import('./pttBuzz')
  const { detectNewsBuzz } = await import('./newsBuzz')
  const { detectAnueBuzz } = await import('./anueBuzz')

  type BuzzResult = Awaited<ReturnType<typeof detectPttBuzz>>
  let allPrices: FMStockPrice[]
  let allChips: FMChip[]
  let tpexSymbolSet = new Set<string>()
  let combinedBuzz: BuzzResult = []

  try {
    // 先從 D1 動態載入概念關鍵字（取代 hardcoded CONCEPT_KEYWORDS）
    const buzzKeywords = await loadBuzzKeywords(env.DB, env.KV).catch(e => {
      console.warn('[Screener] loadBuzzKeywords failed, using fallback:', e)
      return undefined  // buzz functions 各自 fallback
    })

    const [marketData, pttBuzz, newsBuzz, anueBuzz] = await Promise.all([
      fetchMultiDayMarketData(20),
      detectPttBuzz(buzzKeywords).catch(e => { console.warn('[Screener] PTT buzz failed:', e); return [] as BuzzResult }),
      detectNewsBuzz(env.DB, buzzKeywords).catch(e => { console.warn('[Screener] News buzz failed:', e); return [] as BuzzResult }),
      detectAnueBuzz(buzzKeywords).catch(e => { console.warn('[Screener] Anue buzz failed:', e); return [] as BuzzResult }),
    ])
    allPrices = marketData.allPrices
    allChips = marketData.allChips
    tpexSymbolSet = marketData.tpexSymbols

    // 合併三個 buzz 來源：Z-score 標準化後再合併（各源基數不同，raw count 加總會失衡）
    // Why: PTT 40 篇和鉅亨網 30 篇的影響力不同；大盤事件時新聞台轟炸會淹沒散戶情緒
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
          existing.zSum += z
          existing.rawCount += b.mentionCount
          existing.sentimentSum += b.sentimentAvg * b.mentionCount
          existing.posts.push(...b.topPosts.slice(0, 1))
        } else {
          buzzMap.set(b.concept, { zSum: z, rawCount: b.mentionCount, sentimentSum: b.sentimentAvg * b.mentionCount, posts: [...b.topPosts.slice(0, 2)] })
        }
      }
    }
    combinedBuzz = [...buzzMap.entries()].map(([concept, v]) => ({
      concept,
      mentionCount: v.rawCount,  // 保留 raw count 供 UI 顯示
      sentimentAvg: v.rawCount > 0 ? v.sentimentSum / v.rawCount : 0,
      topPosts: v.posts.slice(0, 3),
    }))
    // 用 Z-score 合計排序（而非 raw count），確保各源影響力均衡
    const zSumMap = new Map([...buzzMap.entries()].map(([k, v]) => [k, v.zSum]))
    combinedBuzz.sort((a, b) => (zSumMap.get(b.concept) ?? 0) - (zSumMap.get(a.concept) ?? 0))

    console.log(`[Screener] TWSE+OTC: ${allPrices.length} prices, ${allChips.length} chips | Buzz: PTT=${pttBuzz.length} News=${newsBuzz.length} Anue=${anueBuzz.length} → Combined=${combinedBuzz.length}`)
  } catch (e) {
    console.error('[Screener] Data fetch failed, aborting:', e)
    return { hotSectors: [], candidates: [] }
  }

  if (!allPrices.length) {
    console.warn('[Screener] No price data, aborting')
    return { hotSectors: [], candidates: [] }
  }

  // ── Step 1.5a: 抓處置股清單 → 排除（處置股需圈存，Bot 無法交易）─────────
  let punishedSet = new Set<string>()
  try {
    const { fetchPunishedStocks } = await import('./twseApi')
    const punished = await fetchPunishedStocks()
    punishedSet = new Set(punished)
    if (punished.length) {
      await env.KV.put('market:punished_stocks', JSON.stringify(punished), { expirationTtl: 86400 })
      console.log(`[Screener] 處置股 ${punished.length} 支: ${punished.join(', ')}`)
    }
  } catch (e) {
    console.warn('[Screener] 處置股抓取失敗 (non-blocking):', e)
  }

  // ── Step 2: 從 D1 讀概念股標籤（Opus 一次性貼標，不再每次 reclassify）────
  const { results: tagRows } = await env.DB.prepare(
    'SELECT symbol, tag, weight FROM stock_tags'
  ).all<{ symbol: string; tag: string; weight: number }>()

  // 建立 symbol→tags 和 tag→symbols 雙向 map
  const symbolTags = new Map<string, { tag: string; weight: number }[]>()
  const tagSymbols = new Map<string, Set<string>>()
  for (const row of (tagRows ?? [])) {
    if (!symbolTags.has(row.symbol)) symbolTags.set(row.symbol, [])
    symbolTags.get(row.symbol)!.push({ tag: row.tag, weight: row.weight })
    if (!tagSymbols.has(row.tag)) tagSymbols.set(row.tag, new Set())
    tagSymbols.get(row.tag)!.add(row.symbol)
  }
  console.log(`[Screener] Loaded ${tagRows?.length ?? 0} concept tags, ${tagSymbols.size} concepts`)

  // ── Step 3: 計算概念熱度（PTT buzz + price momentum 加權）─────────────────
  const data = buildStockData(allPrices, allChips)
  const pttBuzzMap = new Map(combinedBuzz.map(b => [b.concept, b]))

  // 每個概念的熱度分數
  const conceptScores: SectorHeatScore[] = []
  for (const [concept, members] of tagSymbols) {
    const memberArr = [...members]
    // PTT buzz 加分（0~30 分）
    const buzz = pttBuzzMap.get(concept)
    const buzzScore = buzz ? Math.min(30, buzz.mentionCount * 5 + (buzz.sentimentAvg > 0 ? 10 : 0)) : 0

    // 成員股 Sortino-adjusted 動能（0~30 分）
    // Sortino = return / downside_deviation — 只懲罰下行波動，不懲罰上漲波動
    let totalSortino = 0, sortinoCount = 0
    for (const sym of memberArr) {
      const prices = data.prices.get(sym)
      if (!prices || prices.length < 3) continue
      const dailyReturns: number[] = []
      for (let i = 1; i < prices.length; i++) {
        if (prices[i - 1].close > 0) dailyReturns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close)
      }
      if (!dailyReturns.length) continue
      const ret = dailyReturns.reduce((s, r) => s + r, 0)
      const downsideReturns = dailyReturns.filter(r => r < 0)
      const downsideDev = downsideReturns.length > 0
        ? Math.sqrt(downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length)
        : 0.001  // 全正報酬 → 極低下行風險 → 高 Sortino
      totalSortino += ret / Math.max(downsideDev, 0.001)
      sortinoCount++
    }
    const avgSortino = sortinoCount > 0 ? totalSortino / sortinoCount : 0
    // Sortino 正常範圍 ~-2 ~ +5，映射到 0~30
    const momentumScore = Math.max(0, Math.min(30, (avgSortino + 1) / 4 * 30))

    // 成員股法人買超集中度（0~25 分）
    let chipScore = 0
    let chipMembers = 0
    for (const sym of memberArr) {
      const chipDates = data.chips.get(sym)
      if (!chipDates) continue
      let netBuy = 0
      for (const [, nets] of chipDates) {
        netBuy += nets.foreign + nets.trust
      }
      if (netBuy > 0) chipMembers++
    }
    if (memberArr.length > 0) {
      chipScore = Math.min(25, (chipMembers / memberArr.length) * 25)
    }

    // 成員股量能擴張（0~15 分）+ Hampel cap + 量價背離懲罰
    let volExpansion = 0, volCount = 0
    let priceUpButVolDown = 0  // 量價背離計數
    for (const sym of memberArr) {
      const prices = data.prices.get(sym)
      if (!prices || prices.length < 3) continue
      const recent = prices[prices.length - 1]
      const avg = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
      if (avg > 0) {
        let ratio = recent.Trading_Volume / avg
        if (ratio > 8) ratio = 5  // Hampel-style cap: > 8x 視為異常，壓到 5x
        volExpansion += ratio
        volCount++
        // 量價背離：價格漲但量縮（ratio < 0.8）= 空漲
        const ret = prices.length >= 2 ? (recent.close - prices[prices.length - 2].close) / prices[prices.length - 2].close : 0
        if (ret > 0.005 && ratio < 0.8) priceUpButVolDown++
      }
    }
    const avgVolRatio = volCount > 0 ? volExpansion / volCount : 1
    const divergencePenalty = volCount > 0 ? (priceUpButVolDown / volCount) * 5 : 0  // 背離比例 × 5 分懲罰
    // 量能強度加分：avgVolRatio > 1.5 且 Sortino 正值 = 量價齊揚（高精準進場訊號）
    const volMomentumBonus = (avgVolRatio > 1.5 && avgSortino > 0.5) ? 3 : 0
    const volumeScore = Math.max(0, Math.min(15, (avgVolRatio - 0.8) / 1.5 * 15 - divergencePenalty + volMomentumBonus))

    const totalScore = buzzScore + momentumScore + chipScore + volumeScore

    // 取該概念內 5 日漲幅最高的代表股
    const topStocks = memberArr
      .map(sym => {
        const p = data.prices.get(sym)
        if (!p || p.length < 2) return { sym, ret: -999 }
        return { sym, ret: (p[p.length - 1].close - p[0].close) / p[0].close }
      })
      .sort((a, b) => b.ret - a.ret)
      .slice(0, 5)
      .map(x => x.sym)

    conceptScores.push({
      sector: concept,
      score: Math.round(totalScore * 10) / 10,
      components: {
        chipFlow: Math.round(chipScore * 10) / 10,
        relativeStrength: Math.round(momentumScore * 10) / 10,
        volumeExpansion: Math.round(volumeScore * 10) / 10,
        momentum: Math.round(buzzScore * 10) / 10,   // PTT buzz 放在 momentum 欄位
      },
      stockCount: memberArr.length,
      topStocks,
    })
  }

  conceptScores.sort((a, b) => b.score - a.score)
  const hotSectors = conceptScores.slice(0, 8)  // Top 8 概念
  console.log(`[Screener] Concept Heat: ${hotSectors.map(s => `${s.sector}(${s.score})`).join(', ')}`)

  // ── Step 4: 從 hot concepts 篩選個股 ────────────────────────────────────
  const sectorMap = await getSectorMapping(env)
  const candidates = filterCandidates(data, hotSectors, sectorMap, sc)

  // 用 concept tag 直接把 hot concept 的所有成員股加入候選
  // 放寬條件：只過濾股價 < 10 和沒有 price data 的，其餘全交給 ML + META 決定
  const existingSymbols = new Set(candidates.map(c => c.symbol))
  for (const hs of hotSectors) {
    const members = tagSymbols.get(hs.sector) ?? new Set()
    for (const sym of members) {
      if (existingSymbols.has(sym)) continue
      const prices = data.prices.get(sym)
      const latest = prices?.[prices.length - 1]
      // 取名稱
      const info = sectorMap[sym]
      const stockRow = await env.DB.prepare('SELECT name FROM stocks WHERE symbol=?').bind(sym).first<any>()
      const name = info?.name ?? stockRow?.name ?? sym

      // 有 price data 的直接加入，沒有的也加（update cron 會補歷史資料）
      candidates.push({
        symbol: sym,
        name,
        sector: hs.sector,
        score: latest ? hs.score : hs.score * 0.5,  // 無 price data 的給半分
        reason: `${hs.sector}概念股`,
      })
      existingSymbols.add(sym)
    }
  }

  // ── Step 4b: 動量突破掃描（中小型飆股捕捉）──────────────────────────────
  // 不靠概念標籤，純技術面：量能爆發 + 價格突破 + 中小型股價區間
  const momentumPicks: ScreenerCandidate[] = []
  let momTotal = 0, momSkipExist = 0, momSkipLen = 0, momSkipPrice = 0, momSkipReturn = 0, momSkipVol = 0
  for (const [stockId, prices] of data.prices) {
    momTotal++
    if (existingSymbols.has(stockId)) { momSkipExist++; continue }
    if (prices.length < 3) { momSkipLen++; continue }

    const latest = prices[prices.length - 1]
    // 股價區間過濾
    if (latest.close < sc.minPrice || latest.close > sc.maxPrice) { momSkipPrice++; continue }

    // 5 日漲幅 > 0.5%（放寬：大盤弱勢時 1% 太嚴）
    const oldest = prices[0]
    if (oldest.close <= 0) continue
    const return5d = (latest.close - oldest.close) / oldest.close
    // 突破 5 日均線也算通過（替代純漲幅條件）
    const ma5 = prices.slice(-5).reduce((s, p) => s + p.close, 0) / Math.min(5, prices.length)
    const aboveMa5 = latest.close > ma5
    if (return5d < sc.minMomReturn && !aboveMa5) { momSkipReturn++; continue }

    // 最新日成交量 > 均量 1.2 倍（放寬：1.5 倍太嚴）
    const avgVol = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
    if (avgVol < sc.minMomAvgVol) { momSkipVol++; continue }
    const volRatio = latest.Trading_Volume / avgVol
    if (volRatio < sc.minVolRatio) { momSkipVol++; continue }

    // 法人加分
    const chipDates = data.chips.get(stockId)
    let institutionalBuy = false
    if (chipDates) {
      const lastDay = [...chipDates.entries()].sort((a, b) => b[0].localeCompare(a[0]))[0]
      if (lastDay) {
        const nets = lastDay[1]
        institutionalBuy = (nets.foreign + nets.trust) > 0
      }
    }

    const score = Math.round(
      (return5d * 200) +          // 漲幅越大越高
      (volRatio * 10) +            // 量能爆發越猛越高
      (institutionalBuy ? 15 : 0)  // 法人買超加分
    )

    const info = sectorMap[stockId]
    const stockRow = await env.DB.prepare('SELECT name, sector FROM stocks WHERE symbol=?').bind(stockId).first<any>()
    const name = info?.name ?? stockRow?.name ?? stockId
    const sector = info?.sector ?? stockRow?.sector ?? '動量突破'

    const reasons: string[] = []
    reasons.push(`5日+${(return5d * 100).toFixed(1)}%`)
    reasons.push(`量能${volRatio.toFixed(1)}倍`)
    if (institutionalBuy) reasons.push('法人買超')

    momentumPicks.push({
      symbol: stockId,
      name,
      sector: `動量_${sector}`,
      score,
      reason: reasons.join('；'),
    })
    existingSymbols.add(stockId)
  }

  // 取動量突破 top N
  momentumPicks.sort((a, b) => b.score - a.score)
  const topMomentum = momentumPicks.slice(0, sc.topNMomentum)
  candidates.push(...topMomentum)
  console.log(`[Screener] Momentum scan: total=${momTotal} skipExist=${momSkipExist} skipLen=${momSkipLen} skipPrice=${momSkipPrice} skipReturn=${momSkipReturn} skipVol=${momSkipVol} passed=${momentumPicks.length} picked=${topMomentum.length}`)
  if (topMomentum.length > 0) {
    console.log(`[Screener] Momentum top: ${topMomentum.slice(0, 5).map(c => `${c.symbol}${c.name}(${c.reason})`).join(', ')}`)
  }

  // ── Step 4.5: 排除處置股 ────────────────────────────────────────────────
  if (punishedSet.size > 0) {
    const before = candidates.length
    const removed = candidates.filter(c => punishedSet.has(c.symbol))
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (punishedSet.has(candidates[i].symbol)) candidates.splice(i, 1)
    }
    if (removed.length) {
      console.log(`[Screener] 排除處置股: ${removed.map(c => `${c.symbol}${c.name}`).join(', ')}`)
    }
  }

  // ── Step 4.55: DelistingMonitor — 連續 3 天無報價 → 排除（Survivorship Bias 防護）
  // Why: 正在衰退但還沒正式下市的股票，D1 會有連續缺值。排除避免紙盤買到殭屍股
  try {
    const candSymbols46 = candidates.map(c => c.symbol)
    if (candSymbols46.length > 0) {
      const ph = candSymbols46.map(() => '?').join(',')
      const { results: recentRows } = await env.DB.prepare(`
        SELECT s.symbol, MAX(sp.date) as last_date, COUNT(sp.date) as days_count
        FROM stocks s
        LEFT JOIN stock_prices sp ON sp.stock_id = s.id AND sp.date >= date('now', '-7 days')
        WHERE s.symbol IN (${ph})
        GROUP BY s.symbol
      `).bind(...candSymbols46).all<{ symbol: string; last_date: string | null; days_count: number }>()

      const delistRisk = new Set<string>()
      for (const r of (recentRows ?? [])) {
        // 近 7 天交易日 ≈ 5 天，如果只有 0-2 筆 → 疑似停牌或衰退
        if (r.days_count <= 2) delistRisk.add(r.symbol)
      }

      if (delistRisk.size > 0) {
        const before = candidates.length
        const removed = candidates.filter(c => delistRisk.has(c.symbol))
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (delistRisk.has(candidates[i].symbol)) candidates.splice(i, 1)
        }
        if (removed.length) {
          console.log(`[Screener] DelistingMonitor 排除 ${removed.length} 支（近 7 天 ≤2 筆報價）: ${removed.map(c => c.symbol).join(', ')}`)
          // 寫入 KV 供其他模組參考
          await env.KV.put('market:delisting_risk', JSON.stringify([...delistRisk]), { expirationTtl: 86400 })
        }
      }
    }
  } catch (e) {
    console.warn('[Screener] DelistingMonitor failed (non-blocking):', e)
  }

  // ── Step 4.6: T2 RRG Filter（Lagging 移除、Weakening 標記）──────────────
  // 用 D1 今日 prices 即時算 RS-Ratio，不依賴前日過時資料
  try {
    // 每個候選股的 top tag
    const candSymbols = candidates.map(c => c.symbol)
    if (candSymbols.length > 0) {
      const { results: candTags } = await env.DB.prepare(
        `SELECT symbol, tag FROM stock_tags WHERE symbol IN (${candSymbols.map(() => '?').join(',')}) ORDER BY symbol, weight DESC`
      ).bind(...candSymbols).all<any>()
      const symTopTag = new Map<string, string>()
      for (const r of candTags ?? []) { if (!symTopTag.has(r.symbol)) symTopTag.set(r.symbol, r.tag) }

      // 查最新象限（sector_flow 已由前日 Recommendation 寫入，或今日 pipeline 中會更新）
      const { results: qRows } = await env.DB.prepare(
        `SELECT sector, quadrant, rs_ratio, rs_momentum FROM sector_flow
         WHERE classification='theme' AND quadrant IS NOT NULL
           AND date=(SELECT MAX(date) FROM sector_flow WHERE classification='theme' AND quadrant IS NOT NULL)`
      ).all<any>()
      const qMap = new Map<string, { quadrant: string; rs_ratio: number }>()
      for (const r of qRows ?? []) qMap.set(r.sector, { quadrant: r.quadrant, rs_ratio: r.rs_ratio })

      const t2Before = candidates.length
      const t2Log: string[] = []
      for (let i = candidates.length - 1; i >= 0; i--) {
        const tag = symTopTag.get(candidates[i].symbol)
        if (!tag) continue
        const q = qMap.get(tag)
        if (!q) continue
        if (q.quadrant === 'Lagging') {
          t2Log.push(`${candidates[i].symbol} REJECT（${tag} Lagging RS=${q.rs_ratio}）`)
          candidates.splice(i, 1)
        } else if (q.quadrant === 'Weakening') {
          candidates[i].score *= 0.7  // 降分，不移除
          t2Log.push(`${candidates[i].symbol} DOWNGRADE（${tag} Weakening）`)
        }
      }
      if (t2Log.length) console.log(`[Screener T2] ${t2Log.join(' | ')}`)
      console.log(`[Screener T2] RRG Filter: ${t2Before} → ${candidates.length}（移除 ${t2Before - candidates.length} Lagging）`)
    }
  } catch (e) {
    console.warn('[Screener T2] RRG filter failed (non-fatal):', e)
  }

  console.log(`[Screener] Final candidates: ${candidates.length}`)

  // ── Step 5: 寫入 DB ──────────────────────────────────────────────────────
  try {
    await updateScreenerWatchlist(env.DB, candidates, tpexSymbolSet)
    console.log(`[Screener] Watchlist updated: ${candidates.length} screener stocks`)
  } catch (e) {
    console.error('[Screener] Failed to update watchlist:', e)
  }

  try {
    await storeSectorHeat(env.DB, endDate, conceptScores)
  } catch (e) {
    console.error('[Screener] Failed to store concept heat:', e)
  }

  // PTT buzz 存入 concept_buzz 表
  try {
    await storePttBuzz(env.DB, endDate, combinedBuzz)
  } catch (e) {
    console.warn('[Screener] Failed to store PTT buzz:', e)
  }

  // Discord 通知
  try {
    const { sendDiscordNotification } = await import('./notify')
    const hotNames = hotSectors.map(s => `${s.sector}(${s.score.toFixed(0)})`).join(', ')
    const topCandidates = candidates.filter(c => !c.sector.startsWith('動量')).slice(0, 5).map(c => `${c.symbol}${c.name}`).join(' ')
    const topMom = candidates.filter(c => c.sector.startsWith('動量')).slice(0, 5).map(c => `${c.symbol}${c.name}(${c.reason})`).join(' ')
    const pttTop = combinedBuzz.slice(0, 3).map(b => `${b.concept}(${b.mentionCount})`).join(', ')
    void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
      `🔍 **全市場概念篩選完成**\n` +
      `> 🔥 熱門概念：${hotNames}\n` +
      `> 💬 PTT熱議：${pttTop || '無'}\n` +
      `> 📊 候選股：${candidates.length} 支\n` +
      `> 🏆 概念股 Top 5：${topCandidates}\n` +
      `> 🚀 動量突破：${topMom || '無'}`)
  } catch (e) {
    console.warn('[Screener] Discord notification failed:', e)
  }

  console.log(`[Screener] Done: ${hotSectors.length} hot concepts, ${candidates.length} candidates`)
  return { hotSectors, candidates }
}

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
 * Step 2: 多因子評分 — 籌碼(0-40) + 技術(0-30) + 動能(0-20)
 */
function scoreMultiFactor(
  prices: FMStockPrice[],
  chipDates: Map<string, { foreign: number; trust: number }> | undefined,
  marketReturn5d: number,
  latestClose: number,
): { base_score: number; chip_score: number; tech_score: number; momentum_score: number; reasons: string[] } {
  const reasons: string[] = []

  // ── 籌碼面 (0-40) ──
  let chip_score = 0
  if (chipDates) {
    // 5 日外資+投信淨買超金額（股數 → 概估億元）
    let netBuyAmount = 0
    let consecBuyDays = 0
    const sortedDates = [...chipDates.keys()].sort().slice(-5)
    for (let i = sortedDates.length - 1; i >= 0; i--) {
      const d = sortedDates[i]
      const nets = chipDates.get(d)!
      const dayNet = nets.foreign + nets.trust
      netBuyAmount += dayNet * latestClose / 1e8  // 股數×股價→億
      if (i === sortedDates.length - 1 || consecBuyDays > 0) {
        if (dayNet > 0) consecBuyDays++
        else if (i < sortedDates.length - 1) consecBuyDays = 0 // 斷了就停
      }
    }
    // 淨買超金額分級
    if (netBuyAmount > 10) chip_score = 36
    else if (netBuyAmount > 5) chip_score = 28
    else if (netBuyAmount > 2) chip_score = 20
    else if (netBuyAmount > 0) chip_score = 12
    else if (netBuyAmount > -2) chip_score = 5
    // else 0

    if (netBuyAmount > 2) reasons.push(`法人買超${netBuyAmount.toFixed(1)}億`)

    // 連續買超天數 bonus
    if (consecBuyDays >= 5) { chip_score += 4; reasons.push(`連買${consecBuyDays}天`) }
    else if (consecBuyDays >= 3) { chip_score += 2 }
  }
  chip_score = clamp(chip_score, 0, 40)

  // ── 技術面 (0-30) ──
  let tech_score = 0

  // RSI 14
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

    if (rsi >= 55 && rsi <= 70) { tech_score += 12; reasons.push(`RSI ${rsi.toFixed(0)}`) }
    else if (rsi >= 50 && rsi < 55) tech_score += 8
    else if (rsi >= 45 && rsi < 50) tech_score += 4
    else if (rsi > 70 && rsi <= 80) tech_score += 5
  }

  // MACD histogram（近似：EMA12 - EMA26 的 signal line diff）
  if (prices.length >= 20) {
    // 簡化：用 12d vs 26d 均線差
    const ma12 = prices.slice(-12).reduce((s, p) => s + p.close, 0) / 12
    const ma26 = prices.slice(-Math.min(26, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(26, prices.length)
    const macdApprox = ma12 - ma26
    // Signal line 近似：用 9d 移動平均 of MACD（這裡簡化為當前值）
    if (macdApprox > 0) { tech_score += 8; reasons.push('MACD 多頭') }
    else if (macdApprox > -0.5 * latestClose / 100) tech_score += 3
  }

  // 均線排列
  const latest = prices[prices.length - 1]
  if (prices.length >= 5) {
    const ma5 = prices.slice(-5).reduce((s, p) => s + p.close, 0) / 5
    if (latest.close > ma5) tech_score += 3
  }
  if (prices.length >= 20) {
    const ma20 = prices.slice(-20).reduce((s, p) => s + p.close, 0) / 20
    if (latest.close > ma20) { tech_score += 4; reasons.push('站上MA20') }
  }
  // MA60 需要 60 天資料，只有 20 天 → 跳過（+0）

  // 肯特納通道突破
  if (prices.length >= 14) {
    const ma20 = prices.slice(-Math.min(20, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(20, prices.length)
    const trueRanges = prices.slice(-15).map((p, i, arr) => {
      if (i === 0) return p.max - p.min
      const prev = arr[i - 1]
      return Math.max(p.max - p.min, Math.abs(p.max - prev.close), Math.abs(p.min - prev.close))
    }).slice(1)
    const atr14 = trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length
    if (latest.close > ma20 + 1.5 * atr14 && atr14 > 0) {
      tech_score += 6
      reasons.push('突破肯特納上軌')
    }
  }
  tech_score = clamp(tech_score, 0, 30)

  // ── 動能面 (0-20) ──
  let momentum_score = 0

  // 5d excess return vs 大盤
  if (prices.length >= 6) {
    const stockReturn = (latest.close - prices[prices.length - 6].close) / prices[prices.length - 6].close
    const excess = stockReturn - marketReturn5d
    momentum_score += normalize(excess, -0.03, 0.05, 10)
    if (excess > 0.02) reasons.push(`超額+${(excess * 100).toFixed(1)}%`)
  }

  // 量能比：近 3 日 vs 20 日均量
  if (prices.length >= 5) {
    const recent3 = prices.slice(-3).reduce((s, p) => s + p.Trading_Volume, 0) / 3
    const avg20 = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
    const volRatio = avg20 > 0 ? recent3 / avg20 : 1
    momentum_score += normalize(volRatio, 0.7, 2.5, 7)
    if (volRatio > 1.5) reasons.push(`量能${volRatio.toFixed(1)}倍`)
  }

  // RSI 鈍化：RSI > 80 連 3+ 天
  if (rsiValue > 80 && prices.length >= 6) {
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
 * Step 3: RRG 產業輪動計算（Regime-conditioned 參數）
 *
 * 每個官方產業用等權平均報酬 vs 大盤，計算 RS-Ratio/Momentum/Quadrant
 */
async function calcIndustryRRG(
  data: StockDailyData,
  industryMap: Map<string, string>,
  env: Bindings,
  cfg: TradingConfig,
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

    if (riskLevel === 'red' || riskLevel === 'black') {
      // High volatility → 極短窗口
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

  // ── 按產業聚合報酬 ──
  const industryReturns = new Map<string, number[]>()  // industry → array of member returns
  let allReturns: number[] = []

  for (const [stockId, prices] of data.prices) {
    const industry = industryMap.get(stockId)
    if (!industry) continue
    if (prices.length < rsWindow) continue

    // N 日累計報酬
    const recent = prices[prices.length - 1].close
    const nDaysAgo = prices[Math.max(0, prices.length - rsWindow)].close
    if (recent <= 0 || nDaysAgo <= 0) continue
    const ret = (recent - nDaysAgo) / nDaysAgo

    if (!industryReturns.has(industry)) industryReturns.set(industry, [])
    industryReturns.get(industry)!.push(ret)
    allReturns.push(ret)
  }

  if (!allReturns.length) return result

  // 大盤等權平均報酬
  const marketReturn = allReturns.reduce((a, b) => a + b, 0) / allReturns.length

  // ── 計算 RS-Ratio ──
  // 查歷史 RS-Ratio（用 sector_flow 前日資料算 momentum）
  let prevRsMap = new Map<string, number>()
  try {
    const { results: prevRows } = await env.DB.prepare(
      `SELECT sector, rs_ratio FROM sector_flow
       WHERE classification='industry' AND rs_ratio IS NOT NULL
       ORDER BY date DESC LIMIT 100`
    ).all<{ sector: string; rs_ratio: number }>()
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

  for (const [industry, returns] of industryReturns) {
    if (returns.length < 3) continue  // 太少成員的產業不計

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
    // RS-Ratio = 相對強度 × 100（EMA 簡化為當前值，冷啟動沒有歷史）
    const rawRs = marketReturn !== 0 ? (avgReturn / Math.abs(marketReturn)) * 100 : 100
    // EMA 平滑：如果有前值就做 EMA，沒有就用 raw
    const prevRs = prevRsMap.get(industry)
    const k = 2 / (emaSpan + 1)
    const rsRatio = prevRs != null ? prevRs + k * (rawRs - prevRs) : rawRs

    // RS-Momentum：今日 - N 天前（用 prevRs 近似 N 天前）
    const rsMomentum = prevRs != null ? rsRatio - prevRs : 0

    const quadrant = classifyQuadrant(rsRatio, rsMomentum)
    let bonus = 0
    if (quadrant === 'Leading') bonus = leadingBonus
    else if (quadrant === 'Improving') bonus = improvingBonus
    else if (quadrant === 'Weakening') bonus = weakeningBonus
    else bonus = laggingPenalty

    result.set(industry, { rsRatio, rsMomentum, quadrant, bonus })
  }

  console.log(`[RRG] ${result.size} industries: ${[...result.entries()].filter(([, v]) => v.quadrant === 'Leading').map(([k]) => k).join(', ') || 'none'} Leading`)
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
}> {
  console.log('[Screener v2] Starting bottom-up multi-factor screening...')
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
  const marketReturn5d = calcMarketReturn5d(data)

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
  console.log(`[Screener v2] Universe: ${universe.length} stocks (skip: price=${skipPrice} vol=${skipVol} turnover=${skipTurnover} punish=${skipPunish} volZero=${skipVolZero})`)

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

  // ── Step 3: RRG 產業輪動加分 ──
  console.log('[Screener v2] Step 3: RRG industry rotation...')
  const rrg = await calcIndustryRRG(data, industryMap, env, cfg)

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
  console.log('[Screener v2] Step 5: Sort, dedup, truncate...')
  scored.sort((a, b) => b.score - a.score)

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
  console.log(`[Screener v2] Step 5: ${scored.length} → industry limit → ${afterIndustryLimit.length} → top ${maxCandidates} → ${finalCandidates.length}`)

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

  return { hotSectors: sectorHeatScores, candidates: finalCandidates }
}
