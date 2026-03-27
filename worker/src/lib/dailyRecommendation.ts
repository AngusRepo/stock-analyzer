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
import { fetchBulkTWChips, fetchBulkTWPrice, fetchTWStockInfo } from './finmind'

interface SectorSummary {
  sector: string
  foreign_net: number
  trust_net: number
  total_net: number
  avg_rsi: number | null
  avg_momentum_5d: number
  stock_count: number
  up_count: number
}

// ─── 計算族群資金流向（FinMind 全市場 API）─────────────────────────────────────
// 直接用 FinMind bulk API 拉全市場三大法人 + 股價 + 產業分類
// 不依賴 D1 is_active 股票，覆蓋整個 TWSE/OTC 市場
async function calcSectorFlow(env: Bindings): Promise<SectorSummary[]> {
  // 策略：D1 chip_data（已快取）+ FinMind sector mapping（小量 metadata）
  // 全市場 bulk API 資料量太大，Worker 30s CPU limit 會超時
  // 未來可搬到 Controller (Cloud Run) 做全市場版本
  try {
    // 1. D1: 取近 5 日法人淨買賣（張）+ 最新收盤價
    const { results: chipRows } = await env.DB.prepare(`
      SELECT c.stock_id, SUM(c.foreign_net) as foreign_net, SUM(c.trust_net) as trust_net
      FROM chip_data c
      WHERE c.date >= date('now', '-5 days')
      GROUP BY c.stock_id
    `).all<any>()

    const { results: priceRows } = await env.DB.prepare(`
      SELECT stock_id, close FROM stock_prices
      WHERE date = (SELECT MAX(date) FROM stock_prices sp2 WHERE sp2.stock_id = stock_prices.stock_id)
    `).all<any>()

    if (!chipRows?.length) {
      console.warn('[SectorFlow] D1 無 chip_data')
      return []
    }

    const priceMap = new Map((priceRows ?? []).map((r: any) => [r.stock_id, r.close as number]))

    // 2. FinMind: 取 TWSE/OTC 產業分類（metadata only，~2500 筆，很快）
    let sectorOf = new Map<string, string>()
    const token = env.FINMIND_TOKEN
    if (token) {
      try {
        const stockInfo = await fetchTWStockInfo(token)
        for (const s of stockInfo) {
          if (s.industry_category) sectorOf.set(s.stock_id, s.industry_category)
        }
        console.log(`[SectorFlow] FinMind sector mapping: ${sectorOf.size} 支`)
      } catch (e) {
        console.warn('[SectorFlow] FinMind sector mapping failed, fallback to D1:', e)
      }
    }

    // Fallback: 若 FinMind 失敗，用 D1 stocks.sector
    if (!sectorOf.size) {
      const { results: stocks } = await env.DB.prepare(
        'SELECT id, sector FROM stocks WHERE is_active=1 AND sector IS NOT NULL'
      ).all<any>()
      sectorOf = new Map((stocks ?? []).map((s: any) => [s.id, s.sector]))
    }

    // 3. 按族群加總（淨買賣張 × 股價 ÷ 1e8 = 億元）
    const sectorMap = new Map<string, SectorSummary>()
    for (const row of chipRows) {
      const sector = sectorOf.get(row.stock_id)
      if (!sector) continue

      if (!sectorMap.has(sector)) {
        sectorMap.set(sector, {
          sector, foreign_net: 0, trust_net: 0, total_net: 0,
          avg_rsi: null, avg_momentum_5d: 0, stock_count: 0, up_count: 0,
        })
      }
      const s = sectorMap.get(sector)!
      s.stock_count++

      const price = priceMap.get(row.stock_id) ?? 0
      // chip_data foreign_net/trust_net 單位是「張」(1000股)
      s.foreign_net += (row.foreign_net ?? 0) * price * 1000 / 1e8
      s.trust_net   += (row.trust_net ?? 0) * price * 1000 / 1e8
      s.total_net    = s.foreign_net + s.trust_net
    }

    const result = Array.from(sectorMap.values()).sort((a, b) => b.total_net - a.total_net)
    console.log(`[SectorFlow] ${chipRows.length} 支 active 股票 → ${result.length} 個族群`)
    return result
  } catch (e) {
    console.error('[SectorFlow] failed:', e)
    return []
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

  // 1. 族群資金流向
  const sectors = await calcSectorFlow(env)

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

  // 5. 寫入 sector_flow（先清除當天舊資料，避免 screener 舊分類殘留）
  if (sectors.length) {
    await env.DB.prepare('DELETE FROM sector_flow WHERE date = ?').bind(today).run()
    const top = sectors.slice(0, 20)
    const sectorBatch = top.map(s =>
      env.DB.prepare(`
        INSERT INTO sector_flow
          (date, sector, foreign_net, trust_net, total_net,
           avg_rsi, avg_momentum_5d, stock_count, up_count)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(today, s.sector, s.foreign_net, s.trust_net, s.total_net,
              s.avg_rsi, s.avg_momentum_5d, s.stock_count, s.up_count)
    )
    await env.DB.batch(sectorBatch)
    console.log(`[SectorFlow] 寫入 ${top.length} 個族群（已清除舊資料）`)
  }

  console.log(`[Recommendation] 完成：推薦 ${recommendations.map((r: any) => r.symbol).join(' ')}，族群前3：${sectors.slice(0, 3).map(s => s.sector).join(' ')}`)
}
