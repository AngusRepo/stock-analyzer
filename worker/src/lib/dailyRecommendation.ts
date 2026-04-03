/**
 * dailyRecommendation.ts — 每日選股推薦引擎
 *
 * Phase 3 MVC：
 *   1. Worker pre-query D1（族群流向 + 個股多因子資料）
 *   2. POST Controller /recommend（評分 + LLM 理由）
 *   3. Worker 寫入 D1 daily_recommendations + sector_flow
 *
 * 若 ML_CONTROLLER_URL 未設定 → 走 legacy 本地評分路徑（rollback 安全）
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
    SELECT ti.stock_id, ti.rsi14, ti.macd_hist, sp.close as current_price, ti.ma5, ti.ma20, ti.ma60
    FROM technical_indicators ti
    JOIN stock_prices sp ON sp.stock_id = ti.stock_id AND sp.date = ti.date
    WHERE ti.date = (SELECT MAX(date) FROM technical_indicators ti2 WHERE ti2.stock_id = ti.stock_id)
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
    return [r.stock_id, { signal: fd.signal ?? r.trade_signal, confidence: r.direction_accuracy, forecast_pct: fd.forecast_pct }]
  }) ?? [])

  // 批量查歷史勝率
  const { results: accRows } = await db.prepare(
    `SELECT stock_id, accuracy, total_count FROM model_accuracy WHERE model_name='ensemble' AND period='30d'`
  ).all<any>().catch(() => ({ results: [] }))
  const accMap = new Map((accRows ?? []).map((r: any) => [r.stock_id, r]))

  const { results: stocks } = await db.prepare('SELECT id, symbol, name, sector FROM stocks WHERE is_active=1').all<any>()
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
      hist_accuracy:       acc?.accuracy ?? null,
      hist_count:          acc?.total_count ?? 0,
    }
  })
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

  // 3. Screener 分數(60%) + ML 分數(40%) 加權合併
  //    Screener 決定「哪些值得看」，ML 決定「方向+信心」
  let recommendations: any[] = []
  {
    // 讀 ML predictions（KV 快取或 D1 最新）
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

    const withScore = stockPayloads.map((s: any) => {
      // ── 籌碼分數 (0-40) ──
      const chipScore = Math.min(40, Math.max(0,
        (s.foreign_consecutive ?? 0) * 4 +
        (((s.foreign_net_5d ?? 0) + (s.trust_net_5d ?? 0)) > 0 ? 12 : 0) +
        ((s.foreign_net_5d ?? 0) > 0 && (s.trust_net_5d ?? 0) > 0 ? 8 : 0)  // 雙法人同步加分
      ))

      // ── 技術分數 (0-30) ──
      const rsi = s.rsi14 ?? 50
      const techScore = Math.min(30,
        (rsi >= 40 && rsi <= 80 ? 8 : rsi > 80 ? 6 : 0) +       // RSI 放寬
        ((s.macd_hist ?? 0) > 0 ? 8 : 0) +                        // MACD 多頭
        (s.current_price > (s.ma20 ?? 0) ? 5 : 0) +               // 站上 MA20
        (s.current_price > (s.ma5 ?? 0) ? 3 : 0) +                // 站上 MA5
        (rsi >= 55 && rsi <= 70 ? 4 : 0) +                        // RSI 最佳區
        (s.current_price > (s.ma60 ?? 0) ? 2 : 0)                 // 站上 MA60
      )

      // ── ML 分數 (0-30) ──
      const ml = mlPredMap.get(s.symbol)
      let mlScore = 0
      if (ml) {
        // Signal 分數
        if (ml.signal.includes('STRONG_BUY')) mlScore += 25
        else if (ml.signal.includes('BUY')) mlScore += 18
        else if (ml.signal === 'HOLD') mlScore += 8
        else if (ml.signal.includes('SELL')) mlScore -= 5
        // Confidence 加成
        mlScore += ml.confidence * 10
        // 預測漲幅加成
        if (ml.forecast_pct > 0.03) mlScore += 5
        else if (ml.forecast_pct > 0.01) mlScore += 2
      }
      mlScore = Math.max(0, Math.min(30, mlScore))

      // ── 加權合併：screener 基礎(chip+tech) 60% + ML 40% ──
      const baseScore = chipScore + techScore  // 0-70
      const totalScore = Math.round(baseScore * 0.6 + mlScore * 0.4 + (chipScore + techScore + mlScore) * 0.1)

      return {
        ...s, _score: totalScore,
        _chipScore: chipScore, _techScore: techScore, _mlScore: mlScore,
        _signal: ml?.signal ?? null, _confidence: ml?.confidence ?? null,
      }
    })
    // 過濾 SELL — 沒持股不推薦賣出標的
    .filter((s: any) => {
      const sig = (s._signal ?? '').toLowerCase()
      return !sig.includes('sell') && sig !== 'no_signal'
    })
    .sort((a: any, b: any) => b._score - a._score)
    .slice(0, 25)

    for (let i = 0; i < withScore.length; i++) {
      const s = withScore[i]
      recommendations.push({
        rank: i + 1, stock_id: s.stock_id, symbol: s.symbol,
        name: s.name, sector: s.sector, score: s._score,
        chip_score: s._chipScore, tech_score: s._techScore, ml_score: s._mlScore,
        current_price: s.current_price,
        foreign_net_5d: (s.foreign_net_5d ?? 0) / 1e8,
        trust_net_5d: (s.trust_net_5d ?? 0) / 1e8,
        rsi14: s.rsi14, macd_hist: s.macd_hist,
        ml_signal: s._signal, ml_confidence: s._confidence,
        has_buy_signal: s._signal?.includes('BUY') ? 1 : 0,
        reason: `多因子 #${i + 1}（籌碼${s._chipScore}+技術${s._techScore}+ML${s._mlScore}）`,
        watch_points: '["留意大盤整體走勢"]',
      })
    }
    const sellCount = stockPayloads.filter((s: any) => (s.ml_signal ?? '').toLowerCase().includes('sell')).length
    const noSigCount = stockPayloads.filter((s: any) => (s.ml_signal ?? '').toLowerCase() === 'no_signal').length
    console.log(`[Recommendation] Screener+ML 合併: ${recommendations.length} 支推薦 (過濾 ${sellCount} SELL + ${noSigCount} NO_SIGNAL)`)
  }

  if (!recommendations.length) {
    console.log('[Recommendation] 無符合條件的股票，跳過')
    return
  }

  // T2 RRG Filter 已移至 Screener（Step 4.6），此處不再重複過濾
  const finalRecs = recommendations
  finalRecs.forEach((r, i) => { r.rank = i + 1 })

  // 4. 寫入 daily_recommendations（T2 過濾後）
  const recBatch = finalRecs.map((r: any) =>
    env.DB.prepare(`
      INSERT OR REPLACE INTO daily_recommendations
        (date, stock_id, symbol, name, sector, rank, score,
         signal, confidence, reason, watch_points, has_buy_signal,
         current_price, foreign_net_5d, trust_net_5d, rsi14, macd_hist,
         chip_score, tech_score, ml_score)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      today, r.stock_id, r.symbol, r.name, r.sector, r.rank, r.score,
      r.ml_signal, r.ml_confidence,
      (r.reason ?? '').slice(0, 500),
      typeof r.watch_points === 'string' ? r.watch_points : JSON.stringify(r.watch_points ?? []),
      r.has_buy_signal ?? 0,
      r.current_price, r.foreign_net_5d, r.trust_net_5d,
      r.rsi14, r.macd_hist,
      r.chip_score, r.tech_score, r.ml_score,
    )
  )
  await env.DB.batch(recBatch)

  // 5. 寫入 sector_flow（theme only，industry 已移除）
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
