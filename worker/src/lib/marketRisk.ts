/**
 * marketRisk.ts — 大盤風險計算引擎
 *
 * 指標來源：
 *   VIX          → Yahoo Finance ^VIX（免費）
 *   TWII 歷史    → Yahoo Finance ^TWII（免費）
 *   外資籌碼     → D1 chip_data SUM（TWSE T86 每日寫入）
 *   融資使用率   → TWSE MI_MARGN selectType=MS（市場整體）
 *   ADL 騰落線  → D1 market_breadth（supplemental official data 每日寫入）
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
  adlValue: number | null           // 騰落線（累積 上漲家數-下跌家數）
  adlTrend: 'up' | 'down' | 'flat' | null  // ADL 5日趨勢
  marginMaintenanceRate: number | null  // 融資維持率 %（整體市場）
  bullAlignmentCount: number | null    // 多空排列家數（MA5>MA20>MA60）
  bullAlignmentPct: number | null      // 多空排列比例 %
  riskScore: number
  riskLevel: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  riskSummary: string
  triggers: string[]   // 觸發哪些警示條件
}

// ── 1. 抓 VIX ─────────────────────────────────────────────────────────────────
async function fetchVIX(): Promise<number | null> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d'
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    const json = await res.json() as any
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
    const valid = closes.filter((v: any) => v != null)
    return valid.length ? Math.round(valid[valid.length - 1] * 100) / 100 : null
  } catch { return null }
}

// ── 2. 抓 TWII 近 60 天收盤（計算波動率、均線、乖離率）────────────────────────
async function fetchTWIIHistory(): Promise<number[]> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=3mo'
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    const json = await res.json() as any
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
    return closes.filter((v: any) => v != null)
  } catch { return [] }
}

// ── 3. 外資整體買賣超（D1 chip_data SUM，TWSE T86 已每日寫入）──────────────────
function summarizeForeignChipRows(rows: Array<{ date: string; daily_net: number | null }>): {
  net5d: number | null
  consecutiveSell: number
} {
  if (!rows.length) return { net5d: null, consecutiveSell: 0 }
  const last5 = rows.slice(-5)
  const net5d = last5.reduce((sum, row) => sum + (row.daily_net ?? 0), 0)

  let consecutive = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const net = rows[i].daily_net ?? 0
    if (net < 0) consecutive--
    else if (net > 0) {
      if (consecutive === 0) consecutive = 1
      break
    } else {
      break
    }
  }

  return { net5d: Math.round(net5d * 100) / 100, consecutiveSell: consecutive }
}

async function fetchCanonicalMarketForeignChip(db: D1Database, asOfDate: string): Promise<{
  net5d: number | null
  consecutiveSell: number
}> {
  const { results } = await db.prepare(`
    SELECT c.date,
           SUM(COALESCE(c.foreign_net, 0) * COALESCE(m.close, 0)) / 1e8 AS daily_net
      FROM canonical_chip_daily c
      JOIN canonical_market_daily m
        ON m.stock_id = c.stock_id
       AND m.date = c.date
     WHERE c.date <= ?
       AND c.date >= date(?, '-25 days')
       AND c.source LIKE 'finlab.%'
       AND m.source LIKE 'finlab.%'
     GROUP BY c.date
     ORDER BY c.date
  `).bind(asOfDate, asOfDate).all<{ date: string; daily_net: number | null }>()
  return summarizeForeignChipRows(results ?? [])
}

// FinLab canonical first; legacy.chip_data fallback remains for older snapshots.
async function fetchMarketForeignChip(db: D1Database, asOfDate: string): Promise<{
  net5d: number | null
  consecutiveSell: number
}> {
  try {
    const canonical = await fetchCanonicalMarketForeignChip(db, asOfDate).catch(() => ({ net5d: null, consecutiveSell: 0 }))
    if (canonical.net5d != null) return canonical

    const { results } = await db.prepare(`
      SELECT c.date, SUM(COALESCE(c.foreign_net, 0) * COALESCE(sp.close, 0)) / 1e8 AS daily_net
      FROM chip_data c
      JOIN stocks s ON s.symbol = c.symbol
      JOIN stock_prices sp ON sp.stock_id = s.id AND sp.date = c.date
      WHERE c.date <= ?
        AND c.date >= date(?, '-25 days')
      GROUP BY c.date
      ORDER BY c.date
    `).bind(asOfDate, asOfDate).all<{ date: string; daily_net: number | null }>()

    return summarizeForeignChipRows(results ?? [])
  } catch { return { net5d: null, consecutiveSell: 0 } }
}

// ── 4/6. 融資統計（透過 Controller proxy 取 TWSE MI_MARGN）──────────────────
let _marginCache: { balance: number; limit: number } | null = null

async function fetchTwseMarginSummary(controllerUrl?: string, controllerSecret?: string): Promise<{ balance: number; limit: number } | null> {
  if (_marginCache) return _marginCache
  if (!controllerUrl) return null
  try {
    const headers: Record<string, string> = {}
    if (controllerSecret) headers['X-Controller-Token'] = controllerSecret
    const res = await fetch(`${controllerUrl}/twse/margin-summary`, {
      headers, signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const data = await res.json() as any
    if (data.balance && data.limit) {
      _marginCache = { balance: data.balance, limit: data.limit }
      return _marginCache
    }
    return null
  } catch { return null }
}

// ── 4. 融資使用率 ─────────────────────────────────────────────────────────────
async function fetchMarginRatio(controllerUrl?: string, controllerSecret?: string): Promise<number | null> {
  const data = await fetchTwseMarginSummary(controllerUrl, controllerSecret)
  if (!data) return null
  return Math.round((data.balance / data.limit) * 10000) / 100
}

async function fetchCanonicalMarginStress(db: D1Database, asOfDate: string): Promise<{
  marginRatio: number | null
  marginMaintenanceRate: number | null
}> {
  try {
    const row = await db.prepare(`
      WITH latest AS (
        SELECT MAX(date) AS date
          FROM canonical_chip_daily
         WHERE date <= ?
           AND source LIKE 'finlab.%'
      )
      SELECT SUM(COALESCE(margin_balance, 0)) AS margin_balance,
             SUM(COALESCE(short_balance, 0)) AS short_balance
        FROM canonical_chip_daily
       WHERE date = (SELECT date FROM latest)
         AND source LIKE 'finlab.%'
    `).bind(asOfDate).first<{ margin_balance: number | null; short_balance: number | null }>()
    const marginBalance = Number(row?.margin_balance ?? 0)
    const shortBalance = Number(row?.short_balance ?? 0)
    if (marginBalance <= 0) return { marginRatio: null, marginMaintenanceRate: null }
    return {
      marginRatio: Math.round((shortBalance / marginBalance) * 10000) / 100,
      marginMaintenanceRate: shortBalance > 0 ? Math.round((marginBalance / shortBalance) * 10000) / 100 : null,
    }
  } catch {
    return { marginRatio: null, marginMaintenanceRate: null }
  }
}

// ── 5. ADL 騰落線（D1 market_breadth table，supplemental official data 每日寫入）─────────────────
async function fetchADL(db: D1Database): Promise<{
  adlValue: number | null
  adlTrend: 'up' | 'down' | 'flat' | null
}> {
  try {
    const { results } = await db.prepare(`
      SELECT date, advance_count, decline_count
      FROM market_breadth
      ORDER BY date DESC
      LIMIT 15
    `).all<{ date: string; advance_count: number; decline_count: number }>()

    if (!results?.length || results.length < 2) return { adlValue: null, adlTrend: null }

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

// ── 6. 融資維持率（同一 Controller proxy API）──────────────────────────────
async function fetchMarginMaintenanceRate(controllerUrl?: string, controllerSecret?: string): Promise<number | null> {
  const data = await fetchTwseMarginSummary(controllerUrl, controllerSecret)
  if (!data) return null
  return Math.round((data.limit / data.balance) * 10000) / 100
}

// ── 7. 多空排列家數（D1 stock_prices 計算 MA5/MA20/MA60）───────────────────
async function fetchBullAlignmentCount(db: D1Database): Promise<{
  count: number | null
  pct: number | null
}> {
  try {
    const { results } = await db.prepare(`
      SELECT stock_id, date, close
      FROM stock_prices
      WHERE date >= date('now', '-70 days') AND close IS NOT NULL
      ORDER BY stock_id, date
    `).all<{ stock_id: number; date: string; close: number }>()

    if (!results?.length) return { count: null, pct: null }

    // group by stock_id
    const byStock = new Map<number, number[]>()
    for (const r of results) {
      if (!byStock.has(r.stock_id)) byStock.set(r.stock_id, [])
      byStock.get(r.stock_id)!.push(r.close)
    }

    let bullCount = 0
    let total = 0
    for (const closes of byStock.values()) {
      if (closes.length < 60) continue
      total++
      const ma5  = closes.slice(-5).reduce((a, b) => a + b, 0) / 5
      const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10
      const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20
      const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / 60
      if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) bullCount++
    }

    return {
      count: bullCount,
      pct: total > 0 ? Math.round((bullCount / total) * 10000) / 100 : null,
    }
  } catch { return { count: null, pct: null } }
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
function calcRiskScore(data: Omit<MarketRiskResult, 'riskScore' | 'riskLevel' | 'riskSummary' | 'triggers'>): {
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

  // 融資維持率（最多 8 分）— 低於 150% 代表追繳壓力上升
  if (data.marginMaintenanceRate != null) {
    if (data.marginMaintenanceRate < 130) {
      score += 8; triggers.push(`融資維持率偏低 ${data.marginMaintenanceRate.toFixed(0)}%（<130%），追繳壓力高`)
    } else if (data.marginMaintenanceRate < 150) {
      score += 4; triggers.push(`融資維持率偏低 ${data.marginMaintenanceRate.toFixed(0)}%（<150%）`)
    }
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
  anthropicKey?: string,
  controllerUrl?: string,
  controllerSecret?: string,
  geminiKey?: string,
  runDate?: string,
): Promise<MarketRiskResult> {
  const today = runDate || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  _marginCache = null  // 清除快取

  // 平行抓所有資料（Phase 2: 加入 ADL + 融資維持率 + 多空排列）
  const [vix, twiiHistory, foreignChip, finlabLeverage, legacyMarginRatio, adlData, legacyMarginMaintenance, bullAlignment] = await Promise.all([
    fetchVIX(),
    fetchTWIIHistory(),
    fetchMarketForeignChip(db, today),
    fetchCanonicalMarginStress(db, today),
    fetchMarginRatio(controllerUrl, controllerSecret),
    fetchADL(db),
    fetchMarginMaintenanceRate(controllerUrl, controllerSecret),
    fetchBullAlignmentCount(db),
  ])
  const marginRatio = finlabLeverage.marginRatio ?? legacyMarginRatio
  const marginMaintenance = finlabLeverage.marginMaintenanceRate ?? legacyMarginMaintenance

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
    marginMaintenanceRate: marginMaintenance,
    bullAlignmentCount: bullAlignment.count,
    bullAlignmentPct: bullAlignment.pct,
  }

  const { score, triggers } = calcRiskScore(partial)
  const level = scoreToLevel(score)

  // 生成文字摘要（用 AI 或 fallback 規則）
  const summary = await generateRiskSummary(partial, score, level, triggers, anthropicKey, geminiKey)

  return {
    ...partial,
    riskScore: score,
    riskLevel: level,
    riskSummary: summary,
    triggers,
  }
}

// ── AI 生成風險摘要（fallback 到規則文字）────────────────────────────────────
async function generateRiskSummary(
  data: any, score: number, level: string, triggers: string[],
  anthropicKey?: string, geminiKey?: string,
): Promise<string> {
  const levelText: Record<string, string> = {
    green:  '市場正常，可正常操作',
    yellow: '輕度警戒，留意風險',
    orange: '中度警戒，建議降低持倉',
    red:    '高度警戒，建議大幅減碼',
    black:  '極端風險，建議保留現金觀望',
  }

  // 無 AI key 時用規則文字
  if (!geminiKey && !anthropicKey) {
    const parts = [`當前大盤風險評分 ${score}/100（${levelText[level]}）。`]
    if (triggers.length) parts.push(`主要警示：${triggers.slice(0, 3).join('、')}。`)
    else parts.push('目前各項指標正常，無重大警示。')
    return parts.join('')
  }

  const prompt = `
當前大盤風險數據：
- VIX 恐慌指數：${data.vix ?? 'N/A'}（${data.vixLevel}）
- 加權指數：${data.twiiClose ?? 'N/A'}，20日均線：${data.twiiMa20 ?? 'N/A'}，乖離率：${data.twiiBias ?? 'N/A'}%
- 20日年化波動率：${data.twiiVol20 ?? 'N/A'}%
- 外資近5日買賣超：${data.foreignNet5d ?? 'N/A'} 億，連續動向：${data.foreignConsecutiveSell} 日
- 融資使用率：${data.marginRatio ?? 'N/A'}%
- 騰落線(ADL)趨勢：${data.adlTrend ?? 'N/A'}（${data.adlValue ?? 'N/A'}）
- 融資維持率：${data.marginMaintenanceRate ?? 'N/A'}%
- 多頭排列家數：${data.bullAlignmentCount ?? 'N/A'}（${data.bullAlignmentPct ?? 'N/A'}%）
- 綜合風險評分：${score}/100，等級：${levelText[level]}
- 觸發警示：${triggers.length ? triggers.join('、') : '無'}

請用2-3句繁體中文，給出今日大盤風險的簡要說明與操作建議。語氣客觀，不過度樂觀也不過度悲觀。`

  // Layer 1: Gemini 3.1 Flash Lite（便宜+快速）
  // 2026-04-10: 取代 Haiku，省 $0.2/月
  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 300 },
          }),
        }
      )
      if (res.ok) {
        const json = await res.json() as any
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        if (text) return text
      }
    } catch { /* fallback to Anthropic */ }
  }

  // Layer 2: Anthropic Haiku（fallback）
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const json = await res.json() as any
      return json.content?.[0]?.text ?? levelText[level]
    } catch { /* fall through */ }
  }

  return `風險評分 ${score}/100。${levelText[level]}。${triggers[0] ?? ''}`
}
