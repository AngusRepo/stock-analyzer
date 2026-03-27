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
import {
  fetchBulkTWPrice, fetchBulkTWChips, fetchTWStockInfo,
  type FMStockPrice, type FMChip, type FMStockInfo,
} from './finmind'
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
}> {
  const allPrices: FMStockPrice[] = []
  const allChips: FMChip[] = []
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

  return { allPrices, allChips }
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
  [stockId: string]: { name: string; sector: string }
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

  // D1 已有的 mapping
  const { results: dbStocks } = await env.DB.prepare(
    "SELECT symbol, name, sector FROM stocks WHERE sector IS NOT NULL AND sector != ''"
  ).all<{ symbol: string; name: string; sector: string }>()
  const map: SectorMap = {}
  for (const s of dbStocks ?? []) {
    map[s.symbol] = { name: s.name, sector: s.sector }
  }

  // FinMind 補全
  try {
    const info = await fetchTWStockInfo(env.FINMIND_TOKEN)
    for (const s of info) {
      if (!map[s.stock_id] && s.industry_category) {
        map[s.stock_id] = { name: s.stock_name, sector: s.industry_category }
      }
    }
  } catch (e) {
    console.warn('[Screener] fetchTWStockInfo failed, using DB-only sector map:', e)
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
    if (prices.length < 3) continue  // 至少 3 天資料（TWSE 抓 5 天）

    const latest = prices[prices.length - 1]

    // ── Exclusion filters ──
    // 股價過濾
    if (latest.close < sc.minPrice) continue
    // 日均量過濾
    const volSlice = prices.slice(-Math.min(20, prices.length))
    const avgVol20 = volSlice.reduce((s, p) => s + p.Trading_Volume, 0) / volSlice.length
    if (avgVol20 < sc.minAvgVolume) continue
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

async function updateScreenerWatchlist(db: D1Database, candidates: ScreenerCandidate[]): Promise<void> {
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
  const batch = candidates.map(c =>
    db.prepare(`
      INSERT INTO stocks (symbol, name, market, sector, is_active, source)
      VALUES (?, ?, 'TWSE', ?, 1, 'screener')
      ON CONFLICT(symbol) DO UPDATE SET
        is_active=1,
        source=CASE WHEN COALESCE(stocks.pinned,0)=1 THEN stocks.source ELSE 'screener' END,
        sector=COALESCE(excluded.sector, stocks.sector),
        updated_at=datetime('now')
    `).bind(c.symbol, c.name, c.sector)
  )

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

  // ── Step 1: PTT Buzz + TWSE Price 平行抓 ────────────────────────────────
  const { detectPttBuzz, storePttBuzz } = await import('./pttBuzz')

  let allPrices: FMStockPrice[]
  let allChips: FMChip[]
  let pttBuzz: Awaited<ReturnType<typeof detectPttBuzz>> = []

  try {
    const [marketData, buzz] = await Promise.all([
      fetchMultiDayMarketData(5),
      detectPttBuzz().catch(e => { console.warn('[Screener] PTT buzz failed:', e); return [] }),
    ])
    allPrices = marketData.allPrices
    allChips = marketData.allChips
    pttBuzz = buzz
    console.log(`[Screener] TWSE: ${allPrices.length} prices, ${allChips.length} chips | PTT: ${pttBuzz.length} hot concepts`)
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

  // ── Step 1.5b: 資料清洗 — reclassify 超過 3 tags 的股票（在讀 tags 之前）───
  try {
    const { reclassifyTags } = await import('./tagReclassifier')
    const result = await reclassifyTags(env)
    if (result.updated > 0) {
      console.log(`[Screener] Tag reclassify: ${result.updated} stocks cleaned before concept heat calc`)
    }
  } catch (e) {
    console.warn('[Screener] Tag reclassify failed (non-blocking):', e)
  }

  // ── Step 2: 從 D1 讀概念股標籤（已清洗）──────────────────────────────────
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
  const pttBuzzMap = new Map(pttBuzz.map(b => [b.concept, b]))

  // 每個概念的熱度分數
  const conceptScores: SectorHeatScore[] = []
  for (const [concept, members] of tagSymbols) {
    const memberArr = [...members]
    // PTT buzz 加分（0~30 分）
    const buzz = pttBuzzMap.get(concept)
    const buzzScore = buzz ? Math.min(30, buzz.mentionCount * 5 + (buzz.sentimentAvg > 0 ? 10 : 0)) : 0

    // 成員股的平均 5 日漲幅（0~30 分）
    let totalReturn = 0, returnCount = 0
    for (const sym of memberArr) {
      const prices = data.prices.get(sym)
      if (!prices || prices.length < 2) continue
      const latest = prices[prices.length - 1].close
      const oldest = prices[0].close
      if (oldest > 0) {
        totalReturn += (latest - oldest) / oldest
        returnCount++
      }
    }
    const avgReturn = returnCount > 0 ? totalReturn / returnCount : 0
    const momentumScore = Math.max(0, Math.min(30, (avgReturn + 0.02) / 0.06 * 30))

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

    // 成員股量能擴張（0~15 分）
    let volExpansion = 0, volCount = 0
    for (const sym of memberArr) {
      const prices = data.prices.get(sym)
      if (!prices || prices.length < 3) continue
      const recent = prices[prices.length - 1].Trading_Volume
      const avg = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
      if (avg > 0) {
        volExpansion += recent / avg
        volCount++
      }
    }
    const avgVolRatio = volCount > 0 ? volExpansion / volCount : 1
    const volumeScore = Math.max(0, Math.min(15, (avgVolRatio - 0.8) / 1.5 * 15))

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

  console.log(`[Screener] Final candidates: ${candidates.length}`)

  // ── Step 5: 寫入 DB ──────────────────────────────────────────────────────
  try {
    await updateScreenerWatchlist(env.DB, candidates)
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
    await storePttBuzz(env.DB, endDate, pttBuzz)
  } catch (e) {
    console.warn('[Screener] Failed to store PTT buzz:', e)
  }

  // Discord 通知
  try {
    const { sendDiscordNotification } = await import('./notify')
    const hotNames = hotSectors.map(s => `${s.sector}(${s.score.toFixed(0)})`).join(', ')
    const topCandidates = candidates.filter(c => !c.sector.startsWith('動量')).slice(0, 5).map(c => `${c.symbol}${c.name}`).join(' ')
    const topMom = candidates.filter(c => c.sector.startsWith('動量')).slice(0, 5).map(c => `${c.symbol}${c.name}(${c.reason})`).join(' ')
    const pttTop = pttBuzz.slice(0, 3).map(b => `${b.concept}(${b.mentionCount})`).join(', ')
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
