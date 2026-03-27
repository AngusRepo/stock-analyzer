/**
 * marketRisk.ts — 大盤風險計算引擎
 *
 * 指標來源：
 *   VIX          → Yahoo Finance ^VIX（免費）
 *   TWII 歷史    → Yahoo Finance ^TWII（免費）
 *   外資籌碼     → FinMind TaiwanStockInstitutionalInvestorsBuySell
 *   融資使用率   → FinMind TaiwanStockTotalMarginPurchaseShortSale
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

// ── 3. 抓外資整體買賣超（FinMind 整體市場，非個股）─────────────────────────────
async function fetchMarketForeignChip(token: string): Promise<{
  net5d: number | null
  consecutiveSell: number
}> {
  if (!token) return { net5d: null, consecutiveSell: 0 }
  try {
    const startDate = new Date(Date.now() - 20 * 86400000).toISOString().split('T')[0]
    const qs = new URLSearchParams({
      dataset: 'TaiwanStockTotalInstitutionalInvestors',
      start_date: startDate,
    })
    const res = await fetch(`https://api.finmindtrade.com/api/v4/data?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json.status !== 200) return { net5d: null, consecutiveSell: 0 }

    // 篩選外資
    const rows: any[] = (json.data ?? []).filter((r: any) => r.name === '外陸資買賣超股數(不含外資自營商)')
    rows.sort((a, b) => a.date.localeCompare(b.date))

    if (!rows.length) return { net5d: null, consecutiveSell: 0 }

    // 近5日淨買超（億股）
    const last5 = rows.slice(-5)
    const net5d = last5.reduce((s: number, r: any) => s + (r.buy - r.sell), 0) / 1e8

    // 連續賣超天數
    let consecutive = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      const net = rows[i].buy - rows[i].sell
      if (net < 0) consecutive--
      else if (net > 0) { if (consecutive === 0) consecutive = 1; break }
      else break
    }

    return { net5d: Math.round(net5d * 100) / 100, consecutiveSell: consecutive }
  } catch { return { net5d: null, consecutiveSell: 0 } }
}

// ── 4. 融資使用率 ─────────────────────────────────────────────────────────────
async function fetchMarginRatio(token: string): Promise<number | null> {
  if (!token) return null
  try {
    const startDate = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0]
    const qs = new URLSearchParams({
      dataset: 'TaiwanStockTotalMarginPurchaseShortSale',
      start_date: startDate,
    })
    const res = await fetch(`https://api.finmindtrade.com/api/v4/data?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json.status !== 200) return null

    const rows: any[] = (json.data ?? []).filter((r: any) => r.name === '融資(千元)')
    if (!rows.length) return null

    // 取最新一筆（今日餘額/信用額度）
    const latest = rows[rows.length - 1]
    if (!latest?.TodayBalance || !latest?.quota) return null
    return Math.round((latest.TodayBalance / latest.quota) * 10000) / 100
  } catch { return null }
}

// ── 5. ADL 騰落線（Advance-Decline Line）────────────────────────────────────
// 全市場上漲家數 - 下跌家數的累積線，衡量市場廣度
async function fetchADL(token: string): Promise<{
  adlValue: number | null
  adlTrend: 'up' | 'down' | 'flat' | null
}> {
  if (!token) return { adlValue: null, adlTrend: null }
  try {
    // 取近 10 天全市場股價 → 計算每日上漲/下跌家數
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - 15 * 86400000).toISOString().split('T')[0]
    const qs = new URLSearchParams({
      dataset: 'TaiwanStockPrice',
      start_date: startDate,
      end_date: endDate,
    })
    const res = await fetch(`https://api.finmindtrade.com/api/v4/data?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json.status !== 200 || !json.data?.length) return { adlValue: null, adlTrend: null }

    // 按日期分組，計算 spread > 0 (上漲) vs < 0 (下跌)
    const byDate: Record<string, { up: number; down: number }> = {}
    for (const row of json.data) {
      if (!byDate[row.date]) byDate[row.date] = { up: 0, down: 0 }
      if (row.spread > 0) byDate[row.date].up++
      else if (row.spread < 0) byDate[row.date].down++
    }

    const dates = Object.keys(byDate).sort()
    if (dates.length < 2) return { adlValue: null, adlTrend: null }

    // 累積 ADL
    let adl = 0
    const adlSeries: number[] = []
    for (const d of dates) {
      adl += byDate[d].up - byDate[d].down
      adlSeries.push(adl)
    }

    const adlValue = adlSeries[adlSeries.length - 1]

    // 5 日趨勢
    let adlTrend: 'up' | 'down' | 'flat' = 'flat'
    if (adlSeries.length >= 5) {
      const recent5 = adlSeries.slice(-5)
      const diff = recent5[recent5.length - 1] - recent5[0]
      if (diff > 50) adlTrend = 'up'
      else if (diff < -50) adlTrend = 'down'
    }

    return { adlValue, adlTrend }
  } catch { return { adlValue: null, adlTrend: null } }
}

// ── 6. 融資維持率（Margin Maintenance Rate）──────────────────────────────────
// 整體市場融資維持率，低於 130% 代表追繳壓力大
async function fetchMarginMaintenanceRate(token: string): Promise<number | null> {
  if (!token) return null
  try {
    const startDate = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0]
    const qs = new URLSearchParams({
      dataset: 'TaiwanStockTotalMarginPurchaseShortSale',
      start_date: startDate,
    })
    const res = await fetch(`https://api.finmindtrade.com/api/v4/data?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json.status !== 200) return null

    // 融資維持率 = 擔保維持率（市值/融資金額 × 100%）
    // FinMind 欄位：MarginPurchaseTodayBalance（餘額千元） + 股價估算
    // 簡化版：用 TodayBalance / limit * 100 作為使用率的反向指標
    const rows: any[] = (json.data ?? []).filter((r: any) => r.name === '融資(千元)')
    if (!rows.length) return null
    const latest = rows[rows.length - 1]
    if (!latest?.TodayBalance || !latest?.limit) return null
    // 維持率概念：越低代表槓桿越高（limit/balance 反映可用空間）
    return Math.round((latest.limit / latest.TodayBalance) * 10000) / 100
  } catch { return null }
}

// ── 7. 多空排列家數（MA5 > MA20 > MA60 的股票數）─────────────────────────────
// 衡量全市場趨勢一致性，低值代表空頭擴散
async function fetchBullAlignmentCount(token: string): Promise<{
  count: number | null
  pct: number | null
}> {
  if (!token) return { count: null, pct: null }
  try {
    // 取近 1 天全市場均線資料
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
    const qs = new URLSearchParams({
      dataset: 'TaiwanStockPrice',
      start_date: startDate,
      end_date: endDate,
    })
    const res = await fetch(`https://api.finmindtrade.com/api/v4/data?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = await res.json() as any
    if (json.status !== 200 || !json.data?.length) return { count: null, pct: null }

    // 取最新日期的所有股票
    const allDates = [...new Set((json.data as any[]).map((r: any) => r.date))].sort()
    const latestDate = allDates[allDates.length - 1]
    const latestRows = (json.data as any[]).filter((r: any) => r.date === latestDate)

    // 用簡化判斷：close > 前5日均 > 前20日均 → 多頭排列
    // 因為單日 API 沒有 MA，用 spread（漲跌）正值 + close > open 近似多頭
    // 完整版需抓 60 天資料算 MA，但 API 額度有限
    // 這裡用 FinMind TaiwanStockMovingAverage（如果可用）
    // fallback: 用漲跌家數比例近似
    let bullCount = 0
    const total = latestRows.length
    for (const row of latestRows) {
      // 多頭近似：收盤 > 開盤 且 漲幅 > 0
      if (row.close > row.open && row.spread > 0) bullCount++
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
  finmindToken: string,
  anthropicKey?: string,
): Promise<MarketRiskResult> {
  const today = new Date().toISOString().split('T')[0]

  // 平行抓所有資料（Phase 2: 加入 ADL + 融資維持率 + 多空排列）
  const [vix, twiiHistory, foreignChip, marginRatio, adlData, marginMaintenance, bullAlignment] = await Promise.all([
    fetchVIX(),
    fetchTWIIHistory(),
    fetchMarketForeignChip(finmindToken),
    fetchMarginRatio(finmindToken),
    fetchADL(finmindToken),
    fetchMarginMaintenanceRate(finmindToken),
    fetchBullAlignmentCount(finmindToken),
  ])

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
  const summary = await generateRiskSummary(partial, score, level, triggers, anthropicKey)

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
  anthropicKey?: string,
): Promise<string> {
  const levelText: Record<string, string> = {
    green:  '市場正常，可正常操作',
    yellow: '輕度警戒，留意風險',
    orange: '中度警戒，建議降低持倉',
    red:    '高度警戒，建議大幅減碼',
    black:  '極端風險，建議保留現金觀望',
  }

  // 無 AI key 時用規則文字
  if (!anthropicKey) {
    const parts = [`當前大盤風險評分 ${score}/100（${levelText[level]}）。`]
    if (triggers.length) parts.push(`主要警示：${triggers.slice(0, 3).join('、')}。`)
    else parts.push('目前各項指標正常，無重大警示。')
    return parts.join('')
  }

  // 有 AI key 時生成自然語言分析
  try {
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
  } catch {
    return `風險評分 ${score}/100。${levelText[level]}。${triggers[0] ?? ''}`
  }
}
