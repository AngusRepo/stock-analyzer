/**
 * dailyRecommendation.ts — 每日選股推薦引擎
 *
 * 流程（v2）：
 *   1. Screener 在 17:40 寫入 daily_recommendations（chip_score + tech_score + current_price）
 *   2. ML predict 在 18:00 跑 10 model ensemble → 寫 predictions 表
 *   3. 本模組在 18:05：
 *      a. 讀 screener 已寫的 daily_recommendations
 *      b. 讀 ML predictions → 計算 ml_score(0-30)
 *      c. UPDATE ml_score + signal + reason + 過濾 SELL
 *      d. 寫 sector_flow（theme 族群資金流向）
 *   4. Morning-setup 在 07:15：T2 debate 從 daily_recommendations 挑股買入
 *
 * chip_score/tech_score 由 screener 算一次，recommendation 不重算。
 */

import type { Bindings } from '../types'

interface SectorSummary {
  sector: string
  foreign_net: number   // 億元
  trust_net: number
  total_net: number
  avg_rsi: number | null
  avg_momentum_5d: number
  stock_count: number
  up_count: number
  classification: 'industry' | 'theme'
  rs_ratio: number | null       // 相對大盤強度（100=同步, >100=強於大盤）
  rs_momentum: number | null    // RS 一階差分（>0=加速, <0=減速）
  quadrant: string | null       // Leading / Weakening / Lagging / Improving
}

interface ThemeStockDetail {
  theme: string
  symbol: string
  name: string
  net_amount: number    // 億元（外資+投信）
  foreign_net: number
  trust_net: number
  volume_ratio: number | null
  classification: 'top' | 'dark_horse'
}

// ─── D1 chip_data 共用查詢（industry local fallback + theme 都用）─────────────
// chip_data.symbol 是 TEXT（股票代號），不再需要 JOIN stocks
async function queryChipAndPrice(db: D1Database) {
  const { results: chipRows } = await db.prepare(`
    SELECT c.symbol, SUM(c.foreign_net) as foreign_net, SUM(c.trust_net) as trust_net
    FROM chip_data c
    WHERE c.date >= date('now', '-5 days')
    GROUP BY c.symbol
  `).all<any>()
  const { results: priceRows } = await db.prepare(`
    SELECT s.symbol, sp.close
    FROM stock_prices sp
    JOIN stocks s ON sp.stock_id = s.id
    WHERE sp.date = (SELECT MAX(date) FROM stock_prices sp2 WHERE sp2.stock_id = sp.stock_id)
  `).all<any>()
  const priceMap = new Map((priceRows ?? []).map((r: any) => [r.symbol, r.close as number]))
  return { chipRows: chipRows ?? [], priceMap }
}

// ─── Industry sector_flow 已移除（前端只用 theme） ──────────────────────────

// ─── Theme 級別：D1 chip_data + stock_tags 概念標籤 ──────────────────────────
async function calcThemeFlow(env: Bindings): Promise<{ sectors: SectorSummary[]; stockDetails: ThemeStockDetail[] }> {
  try {
    const { results: tagRows } = await env.DB.prepare(
      'SELECT symbol, tag, weight FROM stock_tags ORDER BY symbol, weight DESC'
    ).all<{ symbol: string; tag: string; weight: number }>()
    if (!tagRows?.length) return { sectors: [], stockDetails: [] }

    // 每股限 top 3 概念（weight 最高的 3 個），避免跨足太多概念導致重複計算
    const MAX_TAGS_PER_STOCK = 3
    const symbolTags = new Map<string, { tag: string; weight: number }[]>()
    const tagSymbols = new Map<string, Set<string>>()
    for (const r of tagRows) {
      if (!symbolTags.has(r.symbol)) symbolTags.set(r.symbol, [])
      const tags = symbolTags.get(r.symbol)!
      if (tags.length >= MAX_TAGS_PER_STOCK) continue // 超過 3 個就跳過
      tags.push({ tag: r.tag, weight: r.weight ?? 1 })
      if (!tagSymbols.has(r.tag)) tagSymbols.set(r.tag, new Set())
      tagSymbols.get(r.tag)!.add(r.symbol)
    }

    const { chipRows, priceMap } = await queryChipAndPrice(env.DB)
    if (!chipRows.length) return { sectors: [], stockDetails: [] }

    // 取股票名稱
    const { results: nameRows } = await env.DB.prepare(
      'SELECT symbol, name FROM stocks'
    ).all<{ symbol: string; name: string }>()
    const nameMap = new Map((nameRows ?? []).map(r => [r.symbol, r.name]))

    // per-stock chip amounts（用於 top stocks 排名）
    const stockChips = new Map<string, { fNet: number; tNet: number; total: number }>()
    for (const row of chipRows) {
      const price = priceMap.get(row.symbol) ?? 0
      const fNet = (row.foreign_net ?? 0) * price / 1e8
      const tNet = (row.trust_net ?? 0) * price / 1e8
      stockChips.set(row.symbol, { fNet, tNet, total: fNet + tNet })
    }

    // 主題加總（乘以 weight，避免多概念股全額重複計入）
    const agg = new Map<string, SectorSummary>()
    for (const row of chipRows) {
      const tags = symbolTags.get(row.symbol)
      if (!tags) continue
      const sc = stockChips.get(row.symbol)!
      for (const { tag, weight } of tags) {
        if (!agg.has(tag)) agg.set(tag, { sector: tag, foreign_net: 0, trust_net: 0, total_net: 0, avg_rsi: null, avg_momentum_5d: 0, stock_count: 0, up_count: 0, classification: 'theme', rs_ratio: null, rs_momentum: null, quadrant: null })
        const s = agg.get(tag)!
        s.stock_count++
        s.foreign_net += sc.fNet * weight
        s.trust_net   += sc.tNet * weight
        s.total_net    = s.foreign_net + s.trust_net
      }
    }

    // 量能資料（黑馬偵測用）: 近5日均量 / 前20日均量
    const { results: volRows } = await env.DB.prepare(`
      SELECT s.symbol,
        AVG(CASE WHEN sp.date >= date('now', '-7 days') THEN sp.volume END) as vol_5d,
        AVG(CASE WHEN sp.date < date('now', '-7 days') AND sp.date >= date('now', '-30 days') THEN sp.volume END) as vol_20d
      FROM stock_prices sp
      JOIN stocks s ON sp.stock_id = s.id
      WHERE sp.date >= date('now', '-30 days')
      GROUP BY s.symbol
    `).all<any>()
    const volMap = new Map<string, number>()
    for (const r of volRows ?? []) {
      if (r.vol_5d && r.vol_20d && r.vol_20d > 0) {
        volMap.set(r.symbol, r.vol_5d / r.vol_20d)
      }
    }

    // ── RRG 四象限計算 ────────────────────────────────────────────────────────
    // RS-Ratio = (概念成分股平均 5 日報酬 / 大盤 5 日報酬) × 100
    // RS-Momentum = 今日 RS-Ratio - 5 日前 RS-Ratio（需歷史 sector_flow）
    try {
      // 1. 每個概念成分股的平均 5 日報酬
      const { results: returnRows } = await env.DB.prepare(`
        SELECT s.symbol,
          (SELECT sp2.close FROM stock_prices sp2 WHERE sp2.stock_id = s.id ORDER BY sp2.date DESC LIMIT 1) as close_now,
          (SELECT sp3.close FROM stock_prices sp3 WHERE sp3.stock_id = s.id ORDER BY sp3.date DESC LIMIT 1 OFFSET 5) as close_5d
        FROM stocks s WHERE s.is_active = 1
      `).all<any>()
      const returnMap = new Map<string, number>()
      for (const r of returnRows ?? []) {
        if (r.close_now && r.close_5d && r.close_5d > 0) {
          returnMap.set(r.symbol, (r.close_now - r.close_5d) / r.close_5d)
        }
      }

      // 2. 大盤 5 日報酬（TWII）
      const { results: twiiRows } = await env.DB.prepare(
        'SELECT twii_close FROM market_risk ORDER BY date DESC LIMIT 6'
      ).all<any>()
      let twiiReturn = 0
      if (twiiRows && twiiRows.length >= 2) {
        const latest = twiiRows[0]?.twii_close as number
        const prev5  = twiiRows[Math.min(5, twiiRows.length - 1)]?.twii_close as number
        if (latest && prev5 && prev5 > 0) twiiReturn = (latest - prev5) / prev5
      }

      // 3. 每個概念的 RS-Ratio
      for (const [tag, members] of tagSymbols) {
        const s = agg.get(tag)
        if (!s) continue
        const returns = [...members].map(sym => returnMap.get(sym)).filter((r): r is number => r != null)
        if (returns.length < 3) continue // 成分股太少，不計算
        const themeReturn = returns.reduce((a, b) => a + b, 0) / returns.length
        // RS-Ratio: theme vs market, normalized to 100
        s.rs_ratio = twiiReturn !== 0
          ? Math.round(((1 + themeReturn) / (1 + twiiReturn)) * 100 * 100) / 100
          : themeReturn > 0 ? 105 : themeReturn < 0 ? 95 : 100
      }

      // 4. RS-Momentum: 需要歷史 sector_flow 的 rs_ratio
      const { results: histRs } = await env.DB.prepare(
        `SELECT sector, rs_ratio FROM sector_flow
         WHERE classification = 'theme' AND rs_ratio IS NOT NULL
           AND date = (SELECT date FROM sector_flow WHERE classification = 'theme' AND rs_ratio IS NOT NULL ORDER BY date DESC LIMIT 1 OFFSET 4)
         ORDER BY sector`
      ).all<any>()
      const histRsMap = new Map<string, number>()
      for (const r of histRs ?? []) histRsMap.set(r.sector, r.rs_ratio as number)

      // 5. 計算 Momentum + Quadrant
      for (const s of agg.values()) {
        if (s.rs_ratio == null) continue
        const prevRs = histRsMap.get(s.sector)
        s.rs_momentum = prevRs != null ? Math.round((s.rs_ratio - prevRs) * 100) / 100 : null

        // Quadrant 分類
        const mom = s.rs_momentum ?? 0
        if (s.rs_ratio >= 100 && mom >= 0) s.quadrant = 'Leading'
        else if (s.rs_ratio >= 100 && mom < 0) s.quadrant = 'Weakening'
        else if (s.rs_ratio < 100 && mom < 0) s.quadrant = 'Lagging'
        else s.quadrant = 'Improving'
      }

      // 5b. RS-Momentum 方向一致性（Direction Consistency）
      // 查最近 5 天的 rs_momentum，連續 3 天正值 = 穩定轉強 → 提升象限權重
      try {
        const { results: momHistory } = await env.DB.prepare(
          `SELECT sector, rs_momentum FROM sector_flow
           WHERE classification = 'theme' AND rs_momentum IS NOT NULL
             AND date IN (SELECT DISTINCT date FROM sector_flow WHERE classification = 'theme' AND rs_momentum IS NOT NULL ORDER BY date DESC LIMIT 5)
           ORDER BY sector, date DESC`
        ).all<any>()
        const momBySector = new Map<string, number[]>()
        for (const r of momHistory ?? []) {
          if (!momBySector.has(r.sector)) momBySector.set(r.sector, [])
          momBySector.get(r.sector)!.push(r.rs_momentum)
        }
        for (const s of agg.values()) {
          const hist = momBySector.get(s.sector)
          if (!hist || hist.length < 3) continue
          const recent3 = hist.slice(0, 3) // 最近 3 天（已按 date DESC）
          const allPositive = recent3.every(m => m > 0)
          const allNegative = recent3.every(m => m < 0)
          if (allPositive && s.quadrant === 'Improving') {
            // 穩定轉強 → 升級為 Leading（動能已確認）
            s.quadrant = 'Leading'
            console.log(`[RRG] ${s.sector} Improving→Leading（momentum 連續 3 天正值）`)
          } else if (allNegative && s.quadrant === 'Leading') {
            // 穩定轉弱 → 降級為 Weakening（動能已確認衰退）
            s.quadrant = 'Weakening'
            console.log(`[RRG] ${s.sector} Leading→Weakening（momentum 連續 3 天負值）`)
          }
        }
      } catch (e) {
        console.warn('[RRG] Direction consistency check failed (non-fatal):', e)
      }

      const qCounts = { Leading: 0, Weakening: 0, Lagging: 0, Improving: 0 } as Record<string, number>
      for (const s of agg.values()) { if (s.quadrant) qCounts[s.quadrant] = (qCounts[s.quadrant] ?? 0) + 1 }
      console.log(`[RRG] Quadrant: L=${qCounts.Leading} W=${qCounts.Weakening} Lag=${qCounts.Lagging} I=${qCounts.Improving}, twii5d=${(twiiReturn * 100).toFixed(2)}%`)
    } catch (e) {
      console.warn('[RRG] Quadrant calc failed (non-fatal):', e)
    }

    // per-theme top 5 + dark_horse
    // 計算每個 theme 的 total_net，決定排序方向
    const stockDetails: ThemeStockDetail[] = []
    for (const [tag, members] of tagSymbols) {
      const allStocks = [...members]
        .filter(sym => stockChips.has(sym))
        .map(sym => {
          const sc = stockChips.get(sym)!
          const tags = symbolTags.get(sym) ?? []
          const w = tags.find(t => t.tag === tag)?.weight ?? 1
          return { sym, ...sc, weight: w, weightedTotal: sc.total * w, weightedF: sc.fNet * w, weightedT: sc.tNet * w }
        })

      // 用加權金額排序（與 theme total 一致）
      const themeAgg = agg.get(tag)
      const themeNet = themeAgg?.total_net ?? 0
      // 買超主題：顯示加權貢獻最大的 top 5（高→低）
      // 賣超主題：顯示加權貢獻最負的 top 5（低→高）
      const ranked = themeNet >= 0
        ? allStocks.sort((a, b) => b.weightedTotal - a.weightedTotal)
        : allStocks.sort((a, b) => a.weightedTotal - b.weightedTotal)

      const top3Set = new Set(ranked.slice(0, 3).map(r => r.sym))

      // Top 5：存加權後的金額（與 theme total 對齊）
      for (const r of ranked.slice(0, 5)) {
        stockDetails.push({
          theme: tag, symbol: r.sym, name: nameMap.get(r.sym) ?? r.sym,
          net_amount: Math.round(r.weightedTotal * 100) / 100,
          foreign_net: Math.round(r.weightedF * 100) / 100,
          trust_net: Math.round(r.weightedT * 100) / 100,
          volume_ratio: volMap.get(r.sym) ?? null,
          classification: 'top',
        })
      }

      // Dark horse: 量能暴增 >2x 但不在 top 3
      for (const r of ranked) {
        if (top3Set.has(r.sym)) continue
        const vr = volMap.get(r.sym)
        if (vr && vr >= 2.0) {
          stockDetails.push({
            theme: tag, symbol: r.sym, name: nameMap.get(r.sym) ?? r.sym,
            net_amount: Math.round(r.weightedTotal * 100) / 100,
            foreign_net: Math.round(r.weightedF * 100) / 100,
            trust_net: Math.round(r.weightedT * 100) / 100,
            volume_ratio: Math.round(vr * 100) / 100,
            classification: 'dark_horse',
          })
        }
      }
    }

    const result = Array.from(agg.values()).sort((a, b) => b.total_net - a.total_net)
    console.log(`[SectorFlow:Theme] ${agg.size} 概念, ${stockDetails.filter(d => d.classification === 'top').length} top stocks, ${stockDetails.filter(d => d.classification === 'dark_horse').length} dark horses`)
    return { sectors: result, stockDetails }
  } catch (e) {
    console.error('[SectorFlow:Theme] failed:', e)
    return { sectors: [], stockDetails: [] }
  }
}

// ─── Pre-query 個股多因子資料（Controller 格式）──────────────────────────────
async function buildStockPayloads(db: D1Database): Promise<any[]> {
  const { results: chipRows } = await db.prepare(`
    SELECT symbol, SUM(foreign_net) as foreign_net_5d, SUM(trust_net) as trust_net_5d
    FROM chip_data WHERE date >= date('now', '-7 days') GROUP BY symbol
  `).all<any>()
  const chipMap = new Map(chipRows?.map((r: any) => [r.symbol, r]) ?? [])

  const { results: consecRows } = await db.prepare(`
    SELECT symbol, SUM(CASE WHEN foreign_net > 0 THEN 1 ELSE -1 END) as consec
    FROM (SELECT symbol, foreign_net FROM chip_data WHERE date >= date('now', '-10 days') ORDER BY date DESC)
    GROUP BY symbol
  `).all<any>()
  const consecMap = new Map(consecRows?.map((r: any) => [r.symbol, r.consec]) ?? [])

  const { results: tiRows } = await db.prepare(`
    SELECT s.id as stock_id,
      ti.rsi14, ti.macd_hist, ti.ma5, ti.ma20, ti.ma60,
      (SELECT sp.close FROM stock_prices sp WHERE sp.stock_id = s.id ORDER BY sp.date DESC LIMIT 1) as current_price
    FROM stocks s
    LEFT JOIN technical_indicators ti ON ti.stock_id = s.id
      AND ti.date = (SELECT MAX(date) FROM technical_indicators ti2 WHERE ti2.stock_id = s.id)
    WHERE s.is_active = 1
      OR s.symbol IN (SELECT symbol FROM daily_recommendations WHERE date = (SELECT MAX(date) FROM daily_recommendations))
  `).all<any>()
  const tiMap = new Map(tiRows?.map((r: any) => [r.stock_id, r]) ?? [])

  const { results: mlRows } = await db.prepare(`
    SELECT stock_id, trade_signal, direction_accuracy, forecast_data
    FROM predictions
    WHERE generated_at = (SELECT MAX(generated_at) FROM predictions p2 WHERE p2.stock_id = predictions.stock_id)
    AND generated_at >= date('now', '-2 days')
  `).all<any>().catch(() => ({ results: [] }))
  const mlMap = new Map(mlRows?.map((r: any) => {
    let fd: any = {}
    try { fd = JSON.parse(r.forecast_data ?? '{}') } catch {}
    const models = fd.models ?? []
    const upCount = models.filter((m: any) => m.direction === 'up').length
    const downCount = models.filter((m: any) => m.direction === 'down').length
    return [r.stock_id, {
      signal: fd.signal ?? r.trade_signal,
      confidence: r.direction_accuracy,
      forecast_pct: fd.forecast_pct,
      models_total: models.length,
      models_up: upCount,
      models_down: downCount,
      reasoning: fd.reasoning ?? null,  // ensemble 生成的推理說明
    }]
  }) ?? [])

  // 批量查歷史勝率
  const { results: accRows } = await db.prepare(
    `SELECT stock_id, accuracy, total_count FROM model_accuracy WHERE model_name='ensemble' AND period='30d'`
  ).all<any>().catch(() => ({ results: [] }))
  const accMap = new Map((accRows ?? []).map((r: any) => [r.stock_id, r]))

  const { results: stocks } = await db.prepare(
    `SELECT id, symbol, name, sector FROM stocks
     WHERE is_active=1 OR symbol IN (SELECT symbol FROM daily_recommendations WHERE date = (SELECT MAX(date) FROM daily_recommendations))`
  ).all<any>()
  if (!stocks?.length) return []

  return stocks.map((stock: any) => {
    const chip = chipMap.get(stock.symbol) as any
    const ti   = tiMap.get(stock.id) as any
    const ml   = mlMap.get(stock.id) as any
    const acc  = accMap.get(stock.id) as any
    return {
      stock_id:            stock.id,
      symbol:              stock.symbol,
      name:                stock.name,
      sector:              stock.sector,
      current_price:       ti?.current_price ?? null,
      foreign_net_5d:      chip?.foreign_net_5d ?? 0,
      trust_net_5d:        chip?.trust_net_5d ?? 0,
      foreign_consecutive: consecMap.get(stock.symbol) ?? 0,
      rsi14:               ti?.rsi14 ?? null,
      macd_hist:           ti?.macd_hist ?? null,
      ma5:                 ti?.ma5 ?? null,
      ma20:                ti?.ma20 ?? null,
      ma60:                ti?.ma60 ?? null,
      ml_signal:           ml?.signal ?? null,
      ml_confidence:       ml?.confidence ?? null,
      ml_forecast_pct:     ml?.forecast_pct ?? null,
      ml_models_total:     ml?.models_total ?? 0,
      ml_models_up:        ml?.models_up ?? 0,
      ml_models_down:      ml?.models_down ?? 0,
      ml_reasoning:        ml?.reasoning ?? null,
      hist_accuracy:       acc?.accuracy ?? null,
      hist_count:          acc?.total_count ?? 0,
    }
  })
}

// ─── 推薦理由生成 ──────────────────────────────────────────────────────────
function buildReason(s: any): string {
  const parts: string[] = []

  // 籌碼面
  if (s.foreign_consecutive >= 5) parts.push(`法人連續買超${s.foreign_consecutive}天`)
  else if (s.foreign_consecutive >= 3) parts.push(`法人連買${s.foreign_consecutive}天`)
  const netAmount = ((s.foreign_net_5d ?? 0) + (s.trust_net_5d ?? 0)) / 1e8
  if (netAmount > 5) parts.push(`5日法人淨買超${netAmount.toFixed(1)}億`)
  else if (netAmount > 1) parts.push(`法人買超${netAmount.toFixed(1)}億`)

  // 技術面
  const rsi = s.rsi14 ?? 50
  if (rsi >= 55 && rsi <= 70) parts.push(`RSI ${rsi.toFixed(0)} 健康區間`)
  else if (rsi > 70) parts.push(`RSI ${rsi.toFixed(0)} 強勢`)
  if ((s.macd_hist ?? 0) > 0) parts.push('MACD 多頭排列')
  if (s.current_price && s.ma20 && s.current_price > s.ma20) parts.push('站穩月線之上')

  // ML — 用模型投票數據生成有意義的理由
  const sig = (s._signal ?? '').toUpperCase()
  const total = s.ml_models_total ?? 0
  const up = s.ml_models_up ?? 0
  const down = s.ml_models_down ?? 0
  const conf = s.ml_confidence ?? 0
  const forecastPct = s.ml_forecast_pct ?? 0

  if (sig.includes('STRONG_BUY')) {
    parts.push(`ML 強烈看多（${up}/${total}模型看漲，信心${(conf * 100).toFixed(0)}%）`)
  } else if (sig.includes('BUY')) {
    parts.push(`ML 看多（${up}/${total}模型看漲，預期${forecastPct > 0 ? '+' : ''}${(forecastPct * 100).toFixed(1)}%）`)
  } else if (sig === 'HOLD' && total > 0) {
    // 說明 WHY hold — 是多空分歧、還是信心不足
    if (down > up) {
      parts.push(`${down}/${total}模型偏空但信心不足，暫列觀望`)
    } else if (up > down) {
      parts.push(`${up}/${total}模型偏多但共識未達門檻，暫列觀望`)
    } else {
      parts.push(`模型多空分歧（${up}多/${down}空），方向不明`)
    }
  } else if (total === 0) {
    parts.push('ML 尚未分析')
  }

  if (!parts.length) parts.push('多因子綜合評分入選')
  return parts.join('，')
}

function buildWatchPoints(s: any): string[] {
  const points: string[] = []
  const rsi = s.rsi14 ?? 50
  if (rsi > 75) points.push('RSI 偏高，注意短期回檔風險')
  if ((s.foreign_net_5d ?? 0) < 0) points.push('外資近期偏賣，留意籌碼變化')
  const sig = (s._signal ?? '').toLowerCase()
  if (sig === 'hold') points.push('ML 信心不足，建議小量試單或觀望')
  points.push('留意大盤整體走勢與國際局勢')
  return points
}

// ─── 主函式 ──────────────────────────────────────────────────────────────────
export async function runDailyRecommendation(env: Bindings): Promise<void> {
  console.log('[Recommendation] 開始計算每日選股...')
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  // 1. 主題族群資金流向（industry 已移除，只保留 theme）
  const themeResult = await calcThemeFlow(env)
  const themeSectors = themeResult.sectors
  const themeStockDetails = themeResult.stockDetails
  const sectors = [...themeSectors]

  // 2. Pre-query 個股資料
  const stockPayloads = await buildStockPayloads(env.DB)
  if (!stockPayloads.length) {
    console.log('[Recommendation] 無 active 股票，跳過')
    return
  }

  // 3. 讀 screener 已寫入的 daily_recommendations（chip+tech），補 ML 分數
  //    Screener 寫 chip_score + tech_score → recommendation 補 ml_score + signal + reason
  let recommendations: any[] = []
  {
    // 讀 screener 已寫的候選（chip+tech 已有分數）
    const { results: screenerRecs } = await env.DB.prepare(
      "SELECT * FROM daily_recommendations WHERE date = ? ORDER BY rank"
    ).bind(today).all<any>()

    if (!screenerRecs?.length) {
      console.warn('[Recommendation] Screener 尚未寫入 daily_recommendations，使用 stockPayloads fallback')
      // fallback: screener 沒跑就跳過
      return
    }

    // 建 ML prediction map
    const mlPredMap = new Map<string, { signal: string; confidence: number; forecast_pct: number }>()
    for (const s of stockPayloads) {
      if (s.ml_signal) {
        mlPredMap.set(s.symbol, {
          signal: s.ml_signal,
          confidence: s.ml_confidence ?? 0,
          forecast_pct: s.ml_forecast_pct ?? 0,
        })
      }
    }

    // 更新每筆 recommendation 的 ML 分數 + signal + reason + price
    const updateBatch = []
    let sellCount = 0
    for (const rec of screenerRecs) {
      const ml = mlPredMap.get(rec.symbol)
      const sig = (ml?.signal ?? 'HOLD').toUpperCase()

      // 過濾 SELL / NO_SIGNAL（沒持股不推 SELL）
      if (sig.includes('SELL') || sig === 'NO_SIGNAL') {
        sellCount++
        updateBatch.push(env.DB.prepare(
          "DELETE FROM daily_recommendations WHERE date = ? AND symbol = ?"
        ).bind(today, rec.symbol))
        continue
      }

      // ML 分數 (0-30)
      let mlScore = 0
      if (ml) {
        if (sig.includes('STRONG_BUY')) mlScore += 25
        else if (sig.includes('BUY')) mlScore += 18
        else if (sig === 'HOLD') mlScore += 8
        mlScore += ml.confidence * 10
        if (ml.forecast_pct > 0.03) mlScore += 5
        else if (ml.forecast_pct > 0.01) mlScore += 2
      }
      mlScore = Math.round(Math.max(0, Math.min(30, mlScore)) * 10) / 10  // 四捨五入到小數第一位

      // total = chip + tech + ml
      const totalScore = Math.round(((rec.chip_score ?? 0) + (rec.tech_score ?? 0) + mlScore) * 10) / 10

      // 取最新收盤價
      const payload = stockPayloads.find((s: any) => s.symbol === rec.symbol)
      const currentPrice = payload?.current_price ?? rec.current_price ?? null

      // 建 reason（含 ML 投票細節 — 直接從 stockPayloads 取 model 數據）
      const reasonData = {
        foreign_consecutive: payload?.foreign_consecutive ?? 0,
        foreign_net_5d: payload?.foreign_net_5d ?? 0,
        trust_net_5d: payload?.trust_net_5d ?? 0,
        rsi14: payload?.rsi14 ?? null,
        macd_hist: payload?.macd_hist ?? null,
        current_price: currentPrice,
        ma20: payload?.ma20 ?? null,
        _signal: ml ? ml.signal : null,
        ml_confidence: ml ? ml.confidence : (payload?.ml_confidence ?? 0),
        ml_forecast_pct: ml ? ml.forecast_pct : (payload?.ml_forecast_pct ?? 0),
        ml_models_total: payload?.ml_models_total ?? 0,
        ml_models_up: payload?.ml_models_up ?? 0,
        ml_models_down: payload?.ml_models_down ?? (payload?.ml_models_total ?? 0) - (payload?.ml_models_up ?? 0),
      }

      // 所有 bind 值強制 null 化（D1 不接受 undefined）
      const safeNull = (v: any) => v === undefined ? null : v
      updateBatch.push(env.DB.prepare(`
        UPDATE daily_recommendations SET
          ml_score = ?, score = ?, signal = ?, confidence = ?,
          current_price = ?, has_buy_signal = ?,
          reason = ?, watch_points = ?,
          foreign_net_5d = ?, trust_net_5d = ?, rsi14 = ?, macd_hist = ?
        WHERE date = ? AND symbol = ?
      `).bind(
        mlScore, totalScore,
        safeNull(ml?.signal), safeNull(ml?.confidence),
        safeNull(currentPrice), sig.includes('BUY') ? 1 : 0,
        buildReason(reasonData), JSON.stringify(buildWatchPoints(reasonData)),
        payload ? (payload.foreign_net_5d ?? 0) / 1e8 : 0,
        payload ? (payload.trust_net_5d ?? 0) / 1e8 : 0,
        safeNull(payload?.rsi14), safeNull(payload?.macd_hist),
        today, rec.symbol,
      ))
    }

    // 批次執行
    const BATCH = 50
    for (let b = 0; b < updateBatch.length; b += BATCH) {
      await env.DB.batch(updateBatch.slice(b, b + BATCH))
    }

    // 重新排名（SELL 刪掉後重排）
    const { results: finalRecs } = await env.DB.prepare(
      "SELECT symbol FROM daily_recommendations WHERE date = ? ORDER BY score DESC"
    ).bind(today).all<any>()
    for (let i = 0; i < (finalRecs?.length ?? 0); i++) {
      await env.DB.prepare(
        "UPDATE daily_recommendations SET rank = ? WHERE date = ? AND symbol = ?"
      ).bind(i + 1, today, finalRecs![i].symbol).run()
    }

    recommendations = finalRecs ?? []
    console.log(`[Recommendation] ML 補分完成: ${recommendations.length} 支推薦 (過濾 ${sellCount} SELL)`)
  }

  if (!recommendations.length) {
    console.log('[Recommendation] 無符合條件的股票，跳過')
    // 即使 ML 補分為空（screener 沒跑），仍然繼續寫 sector_flow
  }

  // screener 已寫入 daily_recommendations（chip+tech），ML 補分已透過 UPDATE 完成（上方）
  // 不再用 INSERT OR REPLACE 覆寫（舊 Controller 殘留已移除）
  // T2 debate 在 morning-setup（paper.ts）執行，不在此處

  // 5. 寫入 sector_flow（theme only，industry 由 screener 寫）
  {
    const batch = themeSectors.slice(0, 50)
    if (batch.length) {
      await env.DB.prepare("DELETE FROM sector_flow WHERE date = ? AND classification = 'theme'").bind(today).run()
      const stmts = batch.map(s =>
        env.DB.prepare(`
          INSERT INTO sector_flow
            (date, sector, foreign_net, trust_net, total_net,
             avg_rsi, avg_momentum_5d, stock_count, up_count, classification,
             rs_ratio, rs_momentum, quadrant)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(date, sector) DO UPDATE SET
            foreign_net=excluded.foreign_net, trust_net=excluded.trust_net,
            total_net=excluded.total_net, avg_rsi=excluded.avg_rsi,
            avg_momentum_5d=excluded.avg_momentum_5d, stock_count=excluded.stock_count,
            up_count=excluded.up_count, classification=excluded.classification,
            llm_summary=COALESCE(excluded.llm_summary, sector_flow.llm_summary)
        `).bind(today, s.sector, s.foreign_net, s.trust_net, s.total_net,
                s.avg_rsi, s.avg_momentum_5d, s.stock_count, s.up_count, 'theme',
                s.rs_ratio, s.rs_momentum, s.quadrant)
      )
      await env.DB.batch(stmts)
      console.log(`[SectorFlow:theme] 寫入 ${batch.length} 筆`)
    }
  }

  // 6. 寫入 sector_flow_stocks（per-theme top stocks + dark_horse）
  if (themeStockDetails.length) {
    await env.DB.prepare('DELETE FROM sector_flow_stocks WHERE date = ?').bind(today).run()
    const BATCH = 50
    for (let i = 0; i < themeStockDetails.length; i += BATCH) {
      const chunk = themeStockDetails.slice(i, i + BATCH)
      const stmts = chunk.map(d =>
        env.DB.prepare(`
          INSERT INTO sector_flow_stocks (date, theme, symbol, name, net_amount, foreign_net, trust_net, volume_ratio, classification)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).bind(today, d.theme, d.symbol, d.name, d.net_amount, d.foreign_net, d.trust_net, d.volume_ratio, d.classification)
      )
      await env.DB.batch(stmts)
    }
    const topCount = themeStockDetails.filter(d => d.classification === 'top').length
    const dhCount = themeStockDetails.filter(d => d.classification === 'dark_horse').length
    console.log(`[SectorFlow:Stocks] 寫入 ${topCount} top + ${dhCount} dark_horse`)
  }

  const topTheme = themeSectors.slice(0, 3).map(s => s.sector).join(' ')
  console.log(`[Recommendation] 完成：推薦 ${recommendations.map((r: any) => r.symbol).join(' ')}，主題前3：${topTheme}`)
}
