/**
 * marketRisk.ts — 大盤風險計算引擎
 *
 * 指標來源：
 *   VIX          → Yahoo Finance ^VIX（免費）
 *   TWII 歷史    → 單一 FinLab TAIEX／完整 TWSE 官方窗口（交易日驗證）
 *   外資籌碼     → D1 chip_data SUM（TWSE T86 每日寫入）
 *   融資使用率   → TWSE MI_MARGN ALL（上市逐檔、同單位餘額／限額）
 *   ADL 騰落線  → D1 market_breadth（Wave2 每日寫入）
 *   多空排列    → D1 stock_prices MA5/MA20/MA60 計算
 *
 * 風險等級邏輯：
 *   green  0-25  → 市場正常，可正常操作
 *   yellow 26-45 → 輕度警戒，留意風險
 *   orange 46-65 → 中度警戒，降低持倉
 *   red    66-85 → 高度警戒，大幅減碼
 *   black  86+   → 極端風險，保留現金
 */

// ── 型別 ───────────────────────────────────────────────────────────────────────
export interface MarketRiskResult {
  date: string
  vix: number | null
  vixLevel: string
  twiiClose: number | null
  twiiVol20: number | null
  twiiMa20: number | null
  twiiBias: number | null
  foreignConsecutiveSell: number
  foreignNet5d: number | null
  marginRatio: number | null
  limitDownCount: number | null
  limitDownPct: number | null
  // ── Phase 2: FinLab 大盤綜合指標強化 ────────────────────────────────────────
  adlValue: number | null           // 最近五個交易日淨騰落家數；並非全歷史 ADL 累積值
  adlTrend: 'up' | 'down' | 'flat' | null  // ADL 5日趨勢
  bullAlignmentCount: number | null    // 多空排列家數（MA5>MA20>MA60）
  bullAlignmentPct: number | null      // 多空排列比例 %
  riskScore: number
  riskLevel: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  riskSummary: string
  quality: MarketRiskQuality
  triggers: string[]   // 觸發哪些警示條件
}

export interface MarketRiskQuality {
  schema_version: 'market-risk-quality-v1'
  date: string
  status: 'complete' | 'bounded' | 'blocked'
  known_score: number
  upper_score: number
  missing: string[]
  critical_missing: string[]
  sources: Record<string, unknown>
  inputs: Record<string, unknown>
}

// ── 1. 抓 VIX ─────────────────────────────────────────────────────────────────
async function fetchVIX(runDate: string): Promise<{value:number|null;date:string|null}> {
  try {
    const cutoff = Date.parse(`${runDate}T00:00:00Z`) / 1000
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&period1=${cutoff - 10 * 86400}&period2=${cutoff}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
    if(!res.ok)return {value:null,date:null}
    const json = await res.json() as any
    const chart = json.chart?.result?.[0]
    const closes = chart?.indicators?.quote?.[0]?.close ?? []
    const observations=closes.map((value:unknown,i:number)=>({value,time:Number(chart?.timestamp?.[i])}))
      .filter((row:any)=>typeof row.value==='number'&&Number.isFinite(row.value)&&row.value>0&&row.time<cutoff&&row.time>=cutoff-5*86400)
      .sort((a:any,b:any)=>a.time-b.time)
    const latest=observations.at(-1)
    return latest ? {value:Math.round(latest.value*100)/100,date:new Date(latest.time*1000).toISOString().slice(0,10)} : {value:null,date:null}
  } catch { return {value:null,date:null} }
}

// ── 2. 抓 TWII 近 60 天收盤（計算波動率、均線、乖離率）────────────────────────
interface TwiiHistoryRow {
  date: string
  close: number
  source: string
}

function parseTwseOfficialNumber(value: unknown): number | null {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function parseTwseOfficialDate(value: unknown): string | null {
  const match = String(value ?? '').trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/)
  if (!match) return null
  const year = Number(match[1]) + 1911
  return `${year}-${match[2]}-${match[3]}`
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function addUtcDays(isoDate: string, days: number): Date {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days))
}

function monthQueryDates(runDate: string): string[] {
  const [year, month] = runDate.split('-').map(Number)
  const queries = new Set<string>()
  queries.add(ymd(addUtcDays(runDate, 0)))
  queries.add(ymd(addUtcDays(runDate, 1)))
  for (let offset = 0; offset < 4; offset++) {
    queries.add(ymd(new Date(Date.UTC(year, month - 1 - offset, 1))))
  }
  return [...queries]
}

async function fetchTwseOfficialTwiiHistory(runDate: string): Promise<TwiiHistoryRow[]> {
  const rows: TwiiHistoryRow[] = []
  for (const queryDate of monthQueryDates(runDate)) {
    try {
      const res = await fetch(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${queryDate}&response=json`, {
        headers: { Accept: 'application/json', 'User-Agent': 'StockVisionBot/1.0' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) continue
      const body = await res.json() as any
      const data = Array.isArray(body?.data) ? body.data : []
      for (const item of data) {
        if (!Array.isArray(item) || item.length < 5) continue
        const date = parseTwseOfficialDate(item[0])
        const close = parseTwseOfficialNumber(item[4])
        if (!date || date > runDate || close == null || close <= 1000 || close >= 100000) continue
        rows.push({ date, close, source: 'twse.mi_5mins_hist.official' })
      }
    } catch {
      continue
    }
  }
  return rows
}

function twiiSourceRank(source: string): number {
  if (source === 'finlab.taiex_total_index') return 0
  if (source === 'twse.mi_5mins_hist.official') return 1
  return 2
}

async function fetchTWIIHistory(db: D1Database, runDate: string): Promise<TwiiHistoryRow[]> {
  try {
    const { results } = await db.prepare(`
      SELECT date, close, source
      FROM canonical_market_index_daily
      WHERE symbol IN ('TWII', 'TAIEX')
        AND date <= ?
        AND close > 1000
        AND close < 100000
        AND source != 'finlab.benchmark_return'
      ORDER BY date DESC
      LIMIT 600
    `).bind(runDate).all<TwiiHistoryRow>()

    const preferred=(results??[]).filter(row=>row.source==='finlab.taiex_total_index')
    const byDate = new Map<string, TwiiHistoryRow>()
    for(const row of preferred){
      const date=String(row.date),close=Number(row.close)
      if(!Number.isFinite(close)||date>runDate)return []
      if(byDate.has(date)&&byDate.get(date)!.close!==close)return []
      byDate.set(date,{date,close,source:row.source})
    }
    if (byDate.size < 21) {
      // Full official window only; never splice sources across a return/MA window.
      byDate.clear()
      for(const row of await fetchTwseOfficialTwiiHistory(runDate))byDate.set(row.date,row)
    }
    const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date))
    if(rows.length<21||rows.at(-1)?.date!==runDate)return []
    const sessions=await db.prepare('SELECT session_date FROM market_trading_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 21').bind(runDate).all<{session_date:string}>()
    const expected=(sessions.results??[]).map(row=>row.session_date).sort()
    if(expected.length!==21||expected.join()!==rows.slice(-21).map(row=>row.date).join())return []
    return rows
  } catch { return [] }
}

// ── 3. 外資整體買賣超（D1 chip_data SUM，TWSE T86 已每日寫入）──────────────────
async function fetchMarketForeignChip(db: D1Database, runDate: string): Promise<{
  net5d: number | null
  consecutiveSell: number
}> {
  try {
    const { results } = await db.prepare(`
      SELECT date, SUM(COALESCE(net_amount, 0)) / 1e8 AS daily_net
        FROM canonical_institutional_amount_daily
       WHERE investor = 'foreign'
         AND source = 'finlab.institutional_investors_trading_all_market_summary'
         AND net_amount IS NOT NULL
         AND date BETWEEN date(?, '-25 days') AND ?
         AND date IN (SELECT session_date FROM market_trading_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 5)
       GROUP BY date
       ORDER BY date
    `).bind(runDate, runDate,runDate).all<{ date: string; daily_net: number }>()

    if (!results || results.length!==5 || results.at(-1)?.date!==runDate || results.some(row=>!Number.isFinite(Number(row.daily_net)))) return { net5d: null, consecutiveSell: 0 }
    const last5 = results.slice(-5)
    const net5d = last5.reduce((sum, row) => sum + Number(row.daily_net ?? 0), 0)
    let consecutive = 0
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const net = Number(results[index].daily_net ?? 0)
      if (net < 0) consecutive -= 1
      else if (net > 0) {
        if (consecutive === 0) consecutive = 1
        break
      } else break
    }
    return { net5d: Math.round(net5d * 100) / 100, consecutiveSell: consecutive }
  } catch {
    return { net5d: null, consecutiveSell: 0 }
  }
}

// ── 4/6. 融資統計（透過 Controller proxy 取 TWSE MI_MARGN）──────────────────
async function fetchMarginRatio(db:D1Database,runDate:string,controllerUrl?:string,controllerSecret?:string):Promise<{value:number|null;source:unknown}> {
  if(!controllerUrl)return {value:null,source:null}
  try{
    const headers:Record<string,string>={}
    if(controllerSecret)headers['X-Controller-Token']=controllerSecret
    const res=await fetch(`${controllerUrl}/twse/margin-summary?run_date=${runDate}`,{headers,signal:AbortSignal.timeout(35000)})
    if(!res.ok)return {value:null,source:null}
    const data=await res.json() as any
    const {results}=await db.prepare('SELECT session_date FROM market_trading_sessions WHERE session_date<? ORDER BY session_date DESC LIMIT 1').bind(runDate).all<{session_date:string}>()
    const previous=results?.[0]?.session_date
    const balance=data.balance,limit=data.limit
    const receiptValid=data.date===runDate&&data.limit_effective_date===runDate&&data.limit_publication_date===previous&&previous<runDate
      &&data.unit==='1000_shares'&&data.source==='twse.mi_margn.all.listed'&&data.coverage>=1000
      &&Number.isFinite(balance)&&balance>=0&&Number.isFinite(data.known_limit)&&data.known_limit>0
      &&Number.isFinite(data.ratio_lower)&&Number.isFinite(data.ratio_upper)&&data.ratio_lower>=0&&data.ratio_upper>=data.ratio_lower
      &&Math.abs(data.ratio_upper-balance/data.known_limit*100)<1e-8
    if(!receiptValid)return {value:null,source:null}
    const exact=data.status==='complete'&&Array.isArray(data.unknown_limit_symbols)&&data.unknown_limit_symbols.length===0
      &&limit===data.known_limit&&data.ratio_lower===data.ratio_upper
    return {value:exact ? data.ratio_upper : null,source:data}

  }catch{return {value:null,source:null}}
}

// ── 5. ADL 騰落線（D1 market_breadth table，Wave2 每日寫入）─────────────────
async function fetchADL(db: D1Database, runDate: string): Promise<{
  adlValue: number | null
  adlTrend: 'up' | 'down' | 'flat' | null
}> {
  try {
    const { results } = await db.prepare(`
      SELECT date, advance_count, decline_count
      FROM market_breadth
      WHERE date IN (SELECT session_date FROM market_trading_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 5)
      ORDER BY date DESC
      LIMIT 5
    `).bind(runDate).all<{ date: string; advance_count: number; decline_count: number }>()

    if (!results?.length || results.length < 5 || results[0].date !== runDate || results.some(row=>row.advance_count==null||row.decline_count==null||!Number.isFinite(Number(row.advance_count))||!Number.isFinite(Number(row.decline_count)))) return { adlValue: null, adlTrend: null }

    const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date))

    let adl = 0
    const adlSeries: number[] = []
    for (const r of sorted) {
      adl += r.advance_count - r.decline_count
      adlSeries.push(adl)
    }

    const adlValue = adlSeries[adlSeries.length - 1]
    let adlTrend: 'up' | 'down' | 'flat' = 'flat'
    if (adlSeries.length >= 5) {
      const diff = adlSeries[adlSeries.length - 1] - adlSeries[adlSeries.length - 5]
      if (diff > 50) adlTrend = 'up'
      else if (diff < -50) adlTrend = 'down'
    }

    return { adlValue, adlTrend }
  } catch { return { adlValue: null, adlTrend: null } }
}

// ── 7. 多空排列家數（D1 stock_prices 計算 MA5/MA20/MA60）───────────────────
export async function fetchBullAlignmentCount(db:D1Database,runDate:string):Promise<{count:number|null;pct:number|null;eligible:number;universe:number}> {
  try{
    // D1 aggregates instead of returning hundreds of thousands of stock-price rows.
    const {results}=await db.prepare(`
      WITH sessions AS (SELECT session_date FROM market_trading_sessions WHERE session_date<=? ORDER BY session_date DESC LIMIT 60),
      ranked AS (
        SELECT stock_id,date,close,ROW_NUMBER() OVER(PARTITION BY stock_id ORDER BY date DESC) rn
        FROM canonical_market_daily
        WHERE date BETWEEN date(?, '-120 days') AND ? AND close>0 AND source='finlab.price'
          AND stock_id GLOB '[1-9][0-9][0-9][0-9]' AND date IN (SELECT session_date FROM sessions)
      ), stats AS (
        SELECT stock_id,COUNT(*) n,MAX(date) last_date,
          AVG(CASE WHEN rn<=5 THEN close END) ma5,AVG(CASE WHEN rn<=20 THEN close END) ma20,AVG(close) ma60
        FROM ranked GROUP BY stock_id
      )
      SELECT SUM(CASE WHEN n=60 AND ma5>ma20 AND ma20>ma60 THEN 1 ELSE 0 END) bull_count,
        SUM(CASE WHEN n=60 THEN 1 ELSE 0 END) eligible,COUNT(*) universe
      FROM stats WHERE last_date=?
    `).bind(runDate,runDate,runDate,runDate).all<{bull_count:number;eligible:number;universe:number}>()
    const row=results?.[0],eligible=Number(row?.eligible??0),universe=Number(row?.universe??0),count=Number(row?.bull_count??0)
    if(eligible<1000||universe<=0||eligible/universe<.8||count<0||count>eligible)return {count:null,pct:null,eligible,universe}
    return {count,pct:Math.round(count/eligible*10000)/100,eligible,universe}
  }catch{return {count:null,pct:null,eligible:0,universe:0}}
}

// ── 計算輔助函式 ───────────────────────────────────────────────────────────────
function annualizedVol(closes: number[], period = 20): number | null {
  if (closes.length < period + 1) return null
  const slice = closes.slice(-period - 1)
  const returns = slice.slice(1).map((c, i) => Math.log(c / slice[i]))
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
  return Math.round(Math.sqrt(variance * 252) * 10000) / 100  // 年化 %
}

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n
}

// ── VIX 等級判斷 ───────────────────────────────────────────────────────────────
function vixLevel(vix: number | null): string {
  if (!vix) return 'unknown'
  if (vix < 15) return 'low'
  if (vix < 20) return 'normal'
  if (vix < 30) return 'elevated'
  if (vix < 40) return 'high'
  return 'extreme'
}

// ── 風險評分引擎（0-100）─────────────────────────────────────────────────────
export function calcRiskScore(data: Omit<MarketRiskResult, 'riskScore' | 'riskLevel' | 'riskSummary' | 'triggers' | 'quality'>): {
  score: number; triggers: string[]
} {
  let score = 0
  const triggers: string[] = []

  // VIX 貢獻（最多 35 分）
  if (data.vix) {
    if (data.vix >= 40) { score += 35; triggers.push(`VIX 極端恐慌 ${data.vix}（≥40）`) }
    else if (data.vix >= 30) { score += 25; triggers.push(`VIX 高度恐慌 ${data.vix}（≥30）`) }
    else if (data.vix >= 20) { score += 15; triggers.push(`VIX 偏高 ${data.vix}（≥20）`) }
    else if (data.vix >= 15) { score += 5 }
  }

  // 台股波動率（最多 20 分）
  if (data.twiiVol20) {
    if (data.twiiVol20 >= 40) { score += 20; triggers.push(`台股波動率極高 ${data.twiiVol20}%（年化≥40%）`) }
    else if (data.twiiVol20 >= 25) { score += 12; triggers.push(`台股波動率偏高 ${data.twiiVol20}%（年化≥25%）`) }
    else if (data.twiiVol20 >= 18) { score += 6 }
  }

  // 乖離率（最多 15 分）
  if (data.twiiBias != null) {
    const bias = Math.abs(data.twiiBias)
    if (bias >= 10) { score += 15; triggers.push(`大盤嚴重偏離均線 ${data.twiiBias?.toFixed(1)}%（≥±10%）`) }
    else if (bias >= 6)  { score += 8; triggers.push(`大盤偏離均線 ${data.twiiBias?.toFixed(1)}%（≥±6%）`) }
    else if (bias >= 3)  { score += 3 }
  }

  // 外資籌碼（最多 20 分）
  if (data.foreignConsecutiveSell <= -5) { score += 20; triggers.push(`外資連續賣超 ${Math.abs(data.foreignConsecutiveSell)} 日`) }
  else if (data.foreignConsecutiveSell <= -3) { score += 12; triggers.push(`外資連續賣超 ${Math.abs(data.foreignConsecutiveSell)} 日`) }
  else if (data.foreignConsecutiveSell <= -1) { score += 5 }

  if (data.foreignNet5d != null && data.foreignNet5d < -50) {
    score += 8; triggers.push(`外資近5日賣超 ${Math.abs(data.foreignNet5d).toFixed(0)} 億`)
  }

  // 融資使用率（最多 10 分）
  if (data.marginRatio != null) {
    if (data.marginRatio >= 80) { score += 10; triggers.push(`融資使用率過高 ${data.marginRatio}%（≥80%）`) }
    else if (data.marginRatio >= 65) { score += 5 }
  }

  // ── Phase 2: FinLab 新指標 ────────────────────────────────────────────────

  // ADL 騰落線趨勢（最多 8 分）— 下降代表市場廣度萎縮
  if (data.adlTrend === 'down') {
    score += 8; triggers.push('騰落線（ADL）呈下降趨勢，市場廣度萎縮')
  }

  // 多空排列比例（最多 8 分）— 低於 30% 代表空頭擴散
  if (data.bullAlignmentPct != null) {
    if (data.bullAlignmentPct < 20) {
      score += 8; triggers.push(`多頭排列家數僅 ${data.bullAlignmentPct.toFixed(0)}%（<20%），空頭擴散`)
    } else if (data.bullAlignmentPct < 30) {
      score += 4; triggers.push(`多頭排列家數偏低 ${data.bullAlignmentPct.toFixed(0)}%（<30%）`)
    }
  }

  return { score: Math.min(100, score), triggers }
}

// ── 風險等級 ───────────────────────────────────────────────────────────────────
function scoreToLevel(score: number): 'green' | 'yellow' | 'orange' | 'red' | 'black' {
  if (score <= 25) return 'green'
  if (score <= 45) return 'yellow'
  if (score <= 65) return 'orange'
  if (score <= 85) return 'red'
  return 'black'
}

// ── 主函式：計算今日大盤風險 ──────────────────────────────────────────────────
export async function calcMarketRisk(
  db: D1Database,
  controllerUrl?: string,
  controllerSecret?: string,
  runDate?: string,
): Promise<MarketRiskResult> {
  const today = runDate || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)


  // 平行抓所有資料（Phase 2: 加入 ADL + 多空排列）
  const [vixData, twiiRows, foreignChip, marginData, adlData, bullAlignment] = await Promise.all([
    fetchVIX(today),
    fetchTWIIHistory(db, today),
    fetchMarketForeignChip(db, today),
    fetchMarginRatio(db,today,controllerUrl,controllerSecret),
    fetchADL(db, today),
    fetchBullAlignmentCount(db, today),
  ])

  const vix=vixData.value,marginRatio=marginData.value,twiiHistory=twiiRows.map(row=>row.close)
  const twiiClose  = twiiHistory.length ? twiiHistory[twiiHistory.length - 1] : null
  const twiiVol20  = annualizedVol(twiiHistory)
  const twiiMa20   = sma(twiiHistory, 20)
  const twiiBias  = (twiiClose && twiiMa20)
    ? Math.round(((twiiClose - twiiMa20) / twiiMa20) * 10000) / 100
    : null

  const partial = {
    date: today,
    vix,
    vixLevel: vixLevel(vix),
    twiiClose,
    twiiVol20,
    twiiMa20: twiiMa20 ? Math.round(twiiMa20 * 100) / 100 : null,
    twiiBias,
    foreignConsecutiveSell: foreignChip.consecutiveSell,
    foreignNet5d: foreignChip.net5d,
    marginRatio,
    limitDownCount: null,   // 需要付費資料，先留 null
    limitDownPct: null,
    adlValue: adlData.adlValue,
    adlTrend: adlData.adlTrend,
    bullAlignmentCount: bullAlignment.count,
    bullAlignmentPct: bullAlignment.pct,
  }

  const quality=buildMarketRiskQuality(partial,{vix:{source:'yahoo.vix.daily',date:vixData.date,cutoff:`${today}T00:00:00Z`},
    benchmark:{source:twiiRows[0]?.source??null,date:twiiRows.at(-1)?.date??null,sessions:twiiRows.slice(-21)},
    foreign:{source:'finlab.institutional_investors_trading_all_market_summary',date:foreignChip.net5d===null?null:today},
    margin:marginData.source,breadth:{source:'market_breadth',date:adlData.adlTrend===null?null:today,window:5,method:'net_advances_last_5_sessions'},
    alignment:{source:'finlab.price',date:today,eligible:bullAlignment.eligible,universe:bullAlignment.universe}})
  const {triggers}=calcRiskScore(partial)
  const score=quality.upper_score
  if(quality.missing.length)triggers.push(`資料缺少：${quality.missing.join(',')}；已知分數 ${quality.known_score}，保守上界 ${score}`)
  const level = scoreToLevel(score)

  // 依同一風險分數與警示產生規則摘要
  const summary = generateRiskSummary(score, level, triggers)

  return {
    ...partial,
    quality,
    riskScore: score,
    riskLevel: level,
    riskSummary: summary,
    triggers,
  }
}

// Rule-based summary; no external LLM call.
function generateRiskSummary(score: number, level: string, triggers: string[]): string {
  const levelText: Record<string, string> = {
    green:  '市場正常，可正常操作',
    yellow: '輕度警戒，留意風險',
    orange: '中度警戒，建議降低持倉',
    red:    '高度警戒，建議大幅減碼',
    black:  '極端風險，建議保留現金觀望',
  }

  const parts = [`當前大盤風險評分 ${score}/100（${levelText[level]}）。`]
  if (triggers.length) parts.push(`主要警示：${triggers.slice(0, 3).join('、')}。`)
  else parts.push('目前各項指標正常，無重大警示。')
  return parts.join('')
}

export function buildMarketRiskQuality(data:Omit<MarketRiskResult,'riskScore'|'riskLevel'|'riskSummary'|'triggers'|'quality'>,sources:Record<string,unknown>={}):MarketRiskQuality {
  const valid=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)
  const missing:string[]=[]
  let upper=0
  const absent=(key:string,condition:boolean,max:number)=>{if(condition){missing.push(key);upper+=max}}
  absent('vix',!valid(data.vix)||data.vix!<=0,35)
  absent('twii_vol20',!valid(data.twiiVol20)||data.twiiVol20!<0,20)
  absent('twii_bias',!valid(data.twiiBias),15)
  absent('foreign_chip',!valid(data.foreignNet5d),28)
  const margin=sources.margin as any
  const marginPenalty=(ratio:number)=>ratio>=80?10:ratio>=65?5:0
  const marginBoundValid=margin?.status==='bounded'&&valid(margin.ratio_lower)&&valid(margin.ratio_upper)&&margin.ratio_lower>=0&&margin.ratio_upper>=margin.ratio_lower
  const missingMargin=!valid(data.marginRatio)||data.marginRatio!<0
  if(missingMargin){missing.push('margin_ratio');upper+=marginBoundValid?marginPenalty(margin.ratio_upper):10}
  absent('adl_trend',!['up','flat','down'].includes(data.adlTrend??''),8)
  absent('bull_alignment_pct',!valid(data.bullAlignmentPct)||data.bullAlignmentPct!<0||data.bullAlignmentPct!>100,8)
  const critical_missing=missing.filter(key=>['twii_vol20','twii_bias','adl_trend','bull_alignment_pct'].includes(key))
  if(!valid(data.twiiClose)||data.twiiClose!<=0)critical_missing.push('twii_close')
  const known_score=calcRiskScore(data).score+(missingMargin&&marginBoundValid?marginPenalty(margin.ratio_lower):0)
  return {schema_version:'market-risk-quality-v1',date:data.date,status:critical_missing.length?'blocked':missing.length?'bounded':'complete',
    known_score,upper_score:Math.min(100,known_score+upper-(missingMargin&&marginBoundValid?marginPenalty(margin.ratio_lower):0)),missing,critical_missing,sources,inputs:{...data}}
}
