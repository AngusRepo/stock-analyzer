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
import { generateRecommendationReasons, type RecommendationCandidate } from './llm'
import { getTradingConfig } from './tradingConfig'

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
    // Phase 6.6 follow-up: filter to concept-only.
    // Without this, industry/subindustry tags pollute themeSectors aggregation
    // and end up written to sector_flow as classification='theme'.
    const { results: tagRows } = await env.DB.prepare(
      "SELECT symbol, tag, weight FROM stock_tags WHERE tag_type='concept' ORDER BY symbol, weight DESC"
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
    // Phase 6.6 of 4/8 audit — moved to ml-controller sector_flow_service.py
    // (V2 LangGraph node_compute_sector_flow).
    //
    // The old block here had the correct vs-TWII formula but with a bug: the
    // `WHERE s.is_active = 1` filter (line 149) restricted member returns to ~33
    // active stocks, making most themes uncomputable. The new V2 service reads
    // ALL stock_prices without that filter. s.rs_ratio / rs_momentum / quadrant
    // below stay null here — they are written separately by V2 and preserved
    // via the INSERT SET clause (which no longer touches RRG fields).

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
    SELECT stock_id, trade_signal, signal_raw, direction_accuracy, forecast_data
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
    // 優先用 signal_raw（ensemble 原始），其次 trade_signal（簡化版）
    const signal = r.signal_raw ?? r.trade_signal ?? fd.signal ?? 'HOLD'
    return [r.stock_id, {
      signal,
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
  // 三面向都必須有理由：籌碼 → 技術 → ML

  // ── 籌碼面 ──
  let chipReason = ''
  const consec = s.foreign_consecutive ?? 0
  const netAmount = ((s.foreign_net_5d ?? 0) + (s.trust_net_5d ?? 0)) / 1e8
  if (consec >= 5 && netAmount > 5) chipReason = `法人連買${consec}天、淨買超${netAmount.toFixed(1)}億`
  else if (consec >= 3) chipReason = `法人連買${consec}天${netAmount > 1 ? `（${netAmount.toFixed(1)}億）` : ''}`
  else if (netAmount > 5) chipReason = `5日法人淨買超${netAmount.toFixed(1)}億`
  else if (netAmount > 1) chipReason = `法人買超${netAmount.toFixed(1)}億`
  else if (netAmount > 0) chipReason = '法人小幅買超'
  else if (netAmount > -1) chipReason = '法人持平'
  else chipReason = `法人賣超${Math.abs(netAmount).toFixed(1)}億`

  // ── 技術面 ──
  let techReason = ''
  const rsi = s.rsi14 ?? 0
  const macdUp = (s.macd_hist ?? 0) > 0
  const aboveMa = s.current_price && s.ma20 && s.current_price > s.ma20
  const techParts: string[] = []
  if (rsi > 0) {
    if (rsi > 75) techParts.push(`RSI ${rsi.toFixed(0)} 強勢`)
    else if (rsi >= 55) techParts.push(`RSI ${rsi.toFixed(0)} 健康`)
    else if (rsi >= 40) techParts.push(`RSI ${rsi.toFixed(0)} 中性`)
    else techParts.push(`RSI ${rsi.toFixed(0)} 偏弱`)
  }
  if (macdUp) techParts.push('MACD 多頭')
  else techParts.push('MACD 空頭')
  if (aboveMa) techParts.push('站穩月線')
  else techParts.push('月線下方')
  techReason = techParts.join('、')

  // ── ML 面 ──
  let mlReason = ''
  const sig = (s._signal ?? '').toUpperCase()
  const total = s.ml_models_total ?? 0
  const up = s.ml_models_up ?? 0
  const down = s.ml_models_down ?? 0
  const forecastPct = s.ml_forecast_pct ?? 0

  if (total === 0) {
    mlReason = 'ML 尚未分析'
  } else if (sig.includes('STRONG_BUY')) {
    mlReason = `ML 強烈看多（${up}/${total}看漲，預期${forecastPct > 0 ? '+' : ''}${(forecastPct * 100).toFixed(1)}%）`
  } else if (sig.includes('BUY')) {
    mlReason = `ML 看多（${up}/${total}看漲，預期${forecastPct > 0 ? '+' : ''}${(forecastPct * 100).toFixed(1)}%）`
  } else if (sig === 'HOLD') {
    if (down > up) mlReason = `ML 觀望（${down}/${total}偏空但信心不足）`
    else if (up > down) mlReason = `ML 觀望（${up}/${total}偏多但共識未達門檻）`
    else mlReason = `ML 觀望（多空分歧 ${up}/${down}）`
  }

  return `【籌碼】${chipReason}｜【技術】${techReason}｜【ML】${mlReason}`
}

function buildWatchPoints(s: any): string[] {
  const points: string[] = []
  const rsi = s.rsi14 ?? 50
  const conf = s.ml_confidence ?? 0

  // 技術面注意事項
  if (rsi > 80) points.push('RSI 超買，短線可能過熱')
  else if (rsi > 75) points.push('RSI 偏高，留意回檔')
  if ((s.macd_hist ?? 0) < 0 && s.current_price > (s.ma20 ?? 0)) {
    points.push('MACD 走弱但仍在月線上，留意趨勢轉折')
  }

  // 籌碼面注意事項
  if ((s.foreign_net_5d ?? 0) < 0) points.push('外資近期偏賣，留意籌碼變化')
  if ((s.trust_net_5d ?? 0) < 0 && (s.foreign_net_5d ?? 0) > 0) {
    points.push('外資買但投信賣，法人方向不一致')
  }

  // ML 注意事項（根據信心度分級，不是全部都說「信心不足」）
  const sig = (s._signal ?? '').toLowerCase()
  if (sig.includes('sell')) {
    points.push('ML 模型偏空，不建議新建倉位')
  } else if (conf < 0.45) {
    points.push('ML 信心偏低，建議觀望或小量試單')
  } else if (conf >= 0.45 && conf < 0.55 && sig === 'hold') {
    points.push('ML 信心中等，方向未明確，可等待訊號確認')
  } else if (conf >= 0.55) {
    // 信心 55%+ 不說「信心不足」
  }

  if (!points.length) points.push('留意大盤整體走勢與國際局勢')
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
      const sig = ml?.signal ? ml.signal.toUpperCase() : null

      // 過濾：只刪 SELL 和 NO_SIGNAL
      // null（ML 沒跑到）→ 保留，標記為「ML 尚未分析」（screener 選了就值得看）
      if (sig && (sig.includes('SELL') || sig === 'NO_SIGNAL')) {
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
        safeNull(currentPrice), sig?.includes('BUY') ? 1 : 0,
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

    // ── Sprint 3 P0-4: Architecture C Hybrid Ranking ──────────────────────────
    // Why: 解 "filter 後 0 BUY signal" — 即使 ML 全 HOLD 也要保證 top K 進 paper trading
    // How: combined_score = α*screener_norm + β*ml_confidence + γ*signal_tier
    //      若 has_buy_signal 數量 < topK，用 combined_score 排序 promote 到 has_buy_signal=1
    //      同時覆寫 confidence = max(current, promoteMinConf) 讓 paper.ts filter 通過
    try {
      const cfg = await getTradingConfig(env.KV)
      const rk = cfg.ranking
      if (rk.enabled) {
        const { results: allRecs } = await env.DB.prepare(
          `SELECT symbol, signal, has_buy_signal, confidence, chip_score, tech_score, ml_score, score
           FROM daily_recommendations WHERE date = ? ORDER BY score DESC`
        ).bind(today).all<any>()

        const signalTier = (sig: string | null): number => {
          if (!sig) return 0.20  // null ML → 中性底分
          const s = sig.toUpperCase()
          if (s.includes('STRONG_BUY')) return 1.00
          if (s.includes('BUY')) return 0.70
          if (s === 'HOLD') return 0.35
          return 0  // SELL/NO_SIGNAL（已被刪掉，理論上不會到這）
        }

        // 1) 算每支 combined_score
        const scored = (allRecs ?? []).map((r: any) => {
          const screenerNorm = Math.min(1, ((r.chip_score ?? 0) + (r.tech_score ?? 0)) / rk.screenerDenominator)
          const mlConf = Math.max(0, Math.min(1, r.confidence ?? 0))
          const tier = signalTier(r.signal)
          const combined = rk.alpha * screenerNorm + rk.beta * mlConf + rk.gamma * tier
          return { ...r, combined_score: combined }
        })

        // 2) 現在有幾支 has_buy_signal=1
        const currentBuyCount = scored.filter((r: any) => r.has_buy_signal === 1).length

        if (currentBuyCount < rk.topK) {
          const needPromote = rk.topK - currentBuyCount
          // 3) 從 has_buy_signal=0 的 pool 挑 top-N by combined_score
          const pool = scored
            .filter((r: any) => r.has_buy_signal === 0)
            .sort((a: any, b: any) => b.combined_score - a.combined_score)
            .slice(0, needPromote)

          if (pool.length > 0) {
            const promoteBatch = pool.map((r: any) => {
              const promotedConf = Math.max(r.confidence ?? 0, rk.promoteMinConf)
              return env.DB.prepare(
                `UPDATE daily_recommendations
                 SET has_buy_signal = 1, confidence = ?
                 WHERE date = ? AND symbol = ?`
              ).bind(promotedConf, today, r.symbol)
            })
            await env.DB.batch(promoteBatch)
            const promotedSyms = pool.map((r: any) => `${r.symbol}(${r.combined_score.toFixed(3)})`).join(', ')
            console.log(`[Ranking] Promoted ${pool.length} rows to has_buy_signal=1 (current=${currentBuyCount} < topK=${rk.topK}): ${promotedSyms}`)
          } else {
            console.log(`[Ranking] Need promote ${needPromote} but no candidates in pool (all already has_buy_signal=1 or empty)`)
          }
        } else {
          console.log(`[Ranking] has_buy_signal count ${currentBuyCount} >= topK ${rk.topK}, no promotion needed`)
        }
      }
    } catch (e) {
      console.error('[Ranking] Hybrid Ranking failed (non-fatal):', e)
    }

    // ── LLM 推薦理由（覆寫 template reason，失敗時保留 template）──
    if (recommendations.length && env.ANTHROPIC_API_KEY) {
      try {
        const { results: recRows } = await env.DB.prepare(
          `SELECT symbol, name, signal, score, chip_score, tech_score, ml_score,
                  confidence, foreign_net_5d, trust_net_5d, rsi14, macd_hist, current_price
           FROM daily_recommendations WHERE date = ? ORDER BY rank`
        ).bind(today).all<any>()

        if (recRows?.length) {
          const llmCandidates: RecommendationCandidate[] = recRows.map(r => {
            const payload = stockPayloads.find(s => s.symbol === r.symbol)
            return {
              symbol: r.symbol,
              name: r.name,
              signal: r.signal ?? 'HOLD',
              score: r.score ?? 0,
              chip_score: r.chip_score ?? 0,
              tech_score: r.tech_score ?? 0,
              ml_score: r.ml_score ?? 0,
              ml_confidence: r.confidence ?? 0,
              ml_models_up: payload?.ml_models_up ?? 0,
              ml_models_down: payload?.ml_models_down ?? 0,
              ml_models_total: payload?.ml_models_total ?? 0,
              rsi14: r.rsi14,
              macd_hist: r.macd_hist,
              foreign_net_5d: r.foreign_net_5d,
              trust_net_5d: r.trust_net_5d,
              current_price: r.current_price,
            }
          })

          const topThemes = themeSectors.slice(0, 5).map(s => s.sector)
          const llmReasons = await generateRecommendationReasons(env.ANTHROPIC_API_KEY, llmCandidates, topThemes)

          if (llmReasons.size > 0) {
            const llmUpdateBatch = []
            for (const [symbol, { reason, watchPoints }] of llmReasons) {
              // watch_points 只在 LLM 回傳非空時才覆寫（保護 template 的注意事項）
              if (watchPoints.length > 0) {
                llmUpdateBatch.push(env.DB.prepare(
                  "UPDATE daily_recommendations SET reason = ?, watch_points = ? WHERE date = ? AND symbol = ?"
                ).bind(reason, JSON.stringify(watchPoints), today, symbol))
              } else {
                llmUpdateBatch.push(env.DB.prepare(
                  "UPDATE daily_recommendations SET reason = ? WHERE date = ? AND symbol = ?"
                ).bind(reason, today, symbol))
              }
            }
            for (let b = 0; b < llmUpdateBatch.length; b += 50) {
              await env.DB.batch(llmUpdateBatch.slice(b, b + 50))
            }
            console.log(`[Recommendation] LLM 理由覆寫完成：${llmReasons.size} 支`)
          }
        }
      } catch (e) {
        console.error('[Recommendation] LLM 理由失敗（保留 template）:', e)
      }
    }
  }

  if (!recommendations.length) {
    console.log('[Recommendation] 無符合條件的股票，跳過')
    // 即使 ML 補分為空（screener 沒跑），仍然繼續寫 sector_flow
  }

  // screener 已寫入 daily_recommendations（chip+tech），ML 補分已透過 UPDATE 完成（上方）
  // 不再用 INSERT OR REPLACE 覆寫（舊 Controller 殘留已移除）
  // T2 debate 在 morning-setup（paper.ts）執行，不在此處

  // 5. 寫入 sector_flow chip-flow 欄位（theme only）
  // Phase 6.6 of 4/8 audit:
  // - Removed `DELETE FROM sector_flow` — previously wiped V2-written RRG rows
  // - ON CONFLICT SET no longer updates rs_ratio/rs_momentum/quadrant, so V2
  //   RRG values written by ml-controller sector_flow_service are preserved.
  // - On cold-start (no prior V2 write) the VALUES clause seeds RRG fields as
  //   null; next pipeline run will populate them.
  {
    const batch = themeSectors.slice(0, 50)
    if (batch.length) {
      const stmts = batch.map(s =>
        env.DB.prepare(`
          INSERT INTO sector_flow
            (date, sector, foreign_net, trust_net, total_net,
             avg_rsi, avg_momentum_5d, stock_count, up_count, classification,
             rs_ratio, rs_momentum, quadrant)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(date, sector, classification) DO UPDATE SET
            foreign_net=excluded.foreign_net, trust_net=excluded.trust_net,
            total_net=excluded.total_net, avg_rsi=excluded.avg_rsi,
            avg_momentum_5d=excluded.avg_momentum_5d, stock_count=excluded.stock_count,
            up_count=excluded.up_count,
            llm_summary=COALESCE(excluded.llm_summary, sector_flow.llm_summary)
        `).bind(today, s.sector, s.foreign_net, s.trust_net, s.total_net,
                s.avg_rsi, s.avg_momentum_5d, s.stock_count, s.up_count, 'theme',
                s.rs_ratio, s.rs_momentum, s.quadrant)
      )
      await env.DB.batch(stmts)
      console.log(`[SectorFlow:theme] 寫入 ${batch.length} 筆 chip-flow（RRG 由 V2 寫）`)
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
