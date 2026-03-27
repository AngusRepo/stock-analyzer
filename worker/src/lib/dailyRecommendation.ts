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
import { fetchTWStockInfo } from './finmind'

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
// chip_data.stock_id 是 stocks.id（數字 FK），需 JOIN 取 symbol
async function queryChipAndPrice(db: D1Database) {
  const { results: chipRows } = await db.prepare(`
    SELECT s.symbol, SUM(c.foreign_net) as foreign_net, SUM(c.trust_net) as trust_net
    FROM chip_data c
    JOIN stocks s ON c.stock_id = s.id
    WHERE c.date >= date('now', '-5 days')
    GROUP BY s.symbol
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

// ─── Industry 級別：Controller 全市場（FinMind bulk API）─────────────────────
async function calcIndustryFlow(env: Bindings, today: string): Promise<SectorSummary[]> {
  if (!env.ML_CONTROLLER_URL) return calcIndustryFlowLocal(env)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    const res = await fetch(`${env.ML_CONTROLLER_URL}/sector-flow`, {
      method: 'POST', headers,
      body: JSON.stringify({ finmind_token: env.FINMIND_TOKEN, date: today }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`Controller /sector-flow HTTP ${res.status}`)
    const data = await res.json() as any
    const sectors: SectorSummary[] = (data.sectors ?? []).map((s: any) => ({
      sector: s.sector, foreign_net: s.foreign_net, trust_net: s.trust_net, total_net: s.total_net,
      avg_rsi: null, avg_momentum_5d: 0, stock_count: s.stock_count, up_count: 0,
      classification: 'industry' as const,
    }))
    console.log(`[SectorFlow:Industry] Controller: ${sectors.length} 產業（${data.stock_count} 股）`)
    if (!sectors.length) {
      console.log('[SectorFlow:Industry] Controller 回空，fallback local')
      return calcIndustryFlowLocal(env)
    }
    return sectors
  } catch (e) {
    console.warn('[SectorFlow:Industry] Controller failed, fallback local:', e)
    return calcIndustryFlowLocal(env)
  }
}

// Legacy fallback：D1 chip_data + FinMind sector mapping（只涵蓋 active stocks）
async function calcIndustryFlowLocal(env: Bindings): Promise<SectorSummary[]> {
  try {
    const { chipRows, priceMap } = await queryChipAndPrice(env.DB)
    if (!chipRows.length) return []

    let sectorOf = new Map<string, string>()
    if (env.FINMIND_TOKEN) {
      try {
        const info = await fetchTWStockInfo(env.FINMIND_TOKEN)
        for (const s of info) { if (s.industry_category) sectorOf.set(s.stock_id, s.industry_category) }
      } catch { /* fallback below */ }
    }
    if (!sectorOf.size) {
      const { results: stocks } = await env.DB.prepare(
        "SELECT symbol, sector FROM stocks WHERE sector IS NOT NULL AND sector != ''"
      ).all<any>()
      sectorOf = new Map((stocks ?? []).map((s: any) => [s.symbol, s.sector]))
    }

    const agg = new Map<string, SectorSummary>()
    for (const row of chipRows) {
      const sector = sectorOf.get(row.symbol)
      if (!sector) continue
      if (!agg.has(sector)) agg.set(sector, { sector, foreign_net: 0, trust_net: 0, total_net: 0, avg_rsi: null, avg_momentum_5d: 0, stock_count: 0, up_count: 0, classification: 'industry' })
      const s = agg.get(sector)!
      s.stock_count++
      const price = priceMap.get(row.symbol) ?? 0
      s.foreign_net += (row.foreign_net ?? 0) * price / 1e8
      s.trust_net   += (row.trust_net ?? 0) * price / 1e8
      s.total_net    = s.foreign_net + s.trust_net
    }
    const result = Array.from(agg.values()).sort((a, b) => b.total_net - a.total_net)
    console.log(`[SectorFlow:Industry] Local: ${agg.size} 產業, chipRows=${chipRows.length}, sectorOf=${sectorOf.size}, top3=${result.slice(0, 3).map(s => s.sector).join(',')}`)
    return result
  } catch (e) {
    console.error('[SectorFlow:Industry] local failed:', e)
    return []
  }
}

// ─── Theme 級別：D1 chip_data + stock_tags 概念標籤 ──────────────────────────
async function calcThemeFlow(env: Bindings): Promise<{ sectors: SectorSummary[]; stockDetails: ThemeStockDetail[] }> {
  try {
    const { results: tagRows } = await env.DB.prepare(
      'SELECT symbol, tag FROM stock_tags'
    ).all<{ symbol: string; tag: string }>()
    if (!tagRows?.length) return { sectors: [], stockDetails: [] }

    const symbolTags = new Map<string, string[]>()
    const tagSymbols = new Map<string, Set<string>>()
    for (const r of tagRows) {
      if (!symbolTags.has(r.symbol)) symbolTags.set(r.symbol, [])
      symbolTags.get(r.symbol)!.push(r.tag)
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

    // 主題加總
    const agg = new Map<string, SectorSummary>()
    for (const row of chipRows) {
      const tags = symbolTags.get(row.symbol)
      if (!tags) continue
      const sc = stockChips.get(row.symbol)!
      for (const tag of tags) {
        if (!agg.has(tag)) agg.set(tag, { sector: tag, foreign_net: 0, trust_net: 0, total_net: 0, avg_rsi: null, avg_momentum_5d: 0, stock_count: 0, up_count: 0, classification: 'theme' })
        const s = agg.get(tag)!
        s.stock_count++
        s.foreign_net += sc.fNet
        s.trust_net   += sc.tNet
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

    // per-theme top 5 + dark_horse
    const stockDetails: ThemeStockDetail[] = []
    for (const [tag, members] of tagSymbols) {
      const ranked = [...members]
        .filter(sym => stockChips.has(sym))
        .map(sym => ({ sym, ...stockChips.get(sym)! }))
        .sort((a, b) => b.total - a.total)

      const top3Set = new Set(ranked.slice(0, 3).map(r => r.sym))

      // Top 5
      for (const r of ranked.slice(0, 5)) {
        stockDetails.push({
          theme: tag, symbol: r.sym, name: nameMap.get(r.sym) ?? r.sym,
          net_amount: Math.round(r.total * 100) / 100,
          foreign_net: Math.round(r.fNet * 100) / 100,
          trust_net: Math.round(r.tNet * 100) / 100,
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
            net_amount: Math.round(r.total * 100) / 100,
            foreign_net: Math.round(r.fNet * 100) / 100,
            trust_net: Math.round(r.tNet * 100) / 100,
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
    SELECT stock_id, SUM(foreign_net) as foreign_net_5d, SUM(trust_net) as trust_net_5d
    FROM chip_data WHERE date >= date('now', '-7 days') GROUP BY stock_id
  `).all<any>()
  const chipMap = new Map(chipRows?.map((r: any) => [r.stock_id, r]) ?? [])

  const { results: consecRows } = await db.prepare(`
    SELECT stock_id, SUM(CASE WHEN foreign_net > 0 THEN 1 ELSE -1 END) as consec
    FROM (SELECT stock_id, foreign_net FROM chip_data WHERE date >= date('now', '-10 days') ORDER BY date DESC)
    GROUP BY stock_id
  `).all<any>()
  const consecMap = new Map(consecRows?.map((r: any) => [r.stock_id, r.consec]) ?? [])

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
    const chip = chipMap.get(stock.id) as any
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
      foreign_consecutive: consecMap.get(stock.id) ?? 0,
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

  // 1. 雙層族群資金流向（industry + theme）
  const [industrySectors, themeResult] = await Promise.all([
    calcIndustryFlow(env, today),
    calcThemeFlow(env),
  ])
  const themeSectors = themeResult.sectors
  const themeStockDetails = themeResult.stockDetails
  const sectors = [...industrySectors, ...themeSectors]

  // 2. Pre-query 個股資料
  const stockPayloads = await buildStockPayloads(env.DB)
  if (!stockPayloads.length) {
    console.log('[Recommendation] 無 active 股票，跳過')
    return
  }

  // 3. Controller 評分 + LLM（或 legacy fallback）
  let recommendations: any[] = []

  if (env.ML_CONTROLLER_URL) {
    // ── Phase 3: Controller 路徑 ──────────────────────────────────────────
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/recommend`, {
        method: 'POST', headers,
        body: JSON.stringify({
          date: today,
          stocks: stockPayloads,
          sectors,
          anthropic_api_key: env.ANTHROPIC_API_KEY,
          top_n: 5,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`Controller /recommend HTTP ${res.status}`)
      const data = await res.json() as any
      recommendations = data.recommendations ?? []
      console.log(`[Recommendation] Controller 回傳 ${recommendations.length} 支推薦`)
    } catch (e) {
      console.error('[Recommendation] Controller failed, using legacy fallback:', e)
      // fall through to legacy
    }
  }

  if (!recommendations.length) {
    // ── Legacy fallback: 本地評分 + LLM ────────────────────────────────────
    // 簡化版：直接用 Controller scorer 的邏輯在本地跑（避免重複大量 code）
    // 由於 Controller 已移走評分邏輯，legacy 退化為「只看 ML signal 排名」
    const withSignal = stockPayloads
      .filter((s: any) => s.ml_signal?.includes('BUY'))
      .sort((a: any, b: any) => (b.ml_confidence ?? 0) - (a.ml_confidence ?? 0))
      .slice(0, 5)

    for (let i = 0; i < withSignal.length; i++) {
      const s = withSignal[i]
      recommendations.push({
        rank: i + 1, stock_id: s.stock_id, symbol: s.symbol,
        name: s.name, sector: s.sector, score: 0,
        chip_score: 0, tech_score: 0, ml_score: 0,
        current_price: s.current_price,
        foreign_net_5d: (s.foreign_net_5d ?? 0) / 1e8,
        trust_net_5d: (s.trust_net_5d ?? 0) / 1e8,
        rsi14: s.rsi14, macd_hist: s.macd_hist,
        ml_signal: s.ml_signal, ml_confidence: s.ml_confidence,
        has_buy_signal: 1,
        reason: '量化指標呈現強勢訊號（legacy fallback）',
        watch_points: '["留意大盤整體走勢"]',
      })
    }
    console.log(`[Recommendation] Legacy fallback: ${recommendations.length} 支推薦`)
  }

  if (!recommendations.length) {
    console.log('[Recommendation] 無符合條件的股票，跳過')
    return
  }

  // 4. 寫入 daily_recommendations
  const recBatch = recommendations.map((r: any) =>
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

  // 5. 寫入 sector_flow（industry + theme 分別清除再寫入）
  for (const cls of ['industry', 'theme'] as const) {
    const batch = (cls === 'industry' ? industrySectors : themeSectors).slice(0, 50)
    if (!batch.length) continue
    await env.DB.prepare('DELETE FROM sector_flow WHERE date = ? AND classification = ?').bind(today, cls).run()
    const stmts = batch.map(s =>
      env.DB.prepare(`
        INSERT INTO sector_flow
          (date, sector, foreign_net, trust_net, total_net,
           avg_rsi, avg_momentum_5d, stock_count, up_count, classification)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(today, s.sector, s.foreign_net, s.trust_net, s.total_net,
              s.avg_rsi, s.avg_momentum_5d, s.stock_count, s.up_count, cls)
    )
    await env.DB.batch(stmts)
    console.log(`[SectorFlow:${cls}] 寫入 ${batch.length} 筆`)
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

  const topIndustry = industrySectors.slice(0, 3).map(s => s.sector).join(' ')
  const topTheme = themeSectors.slice(0, 3).map(s => s.sector).join(' ')
  console.log(`[Recommendation] 完成：推薦 ${recommendations.map((r: any) => r.symbol).join(' ')}，產業前3：${topIndustry}，主題前3：${topTheme}`)
}
