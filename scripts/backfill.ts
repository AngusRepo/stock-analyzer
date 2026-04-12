#!/usr/bin/env npx ts-node
/**
 * backfill.ts — StockVision 首次上線一鍵歷史回填腳本
 *
 * 執行方式：
 *   npx ts-node scripts/backfill.ts
 *
 * 需要先在 .env 設定（或直接改下方 CONFIG）：
 *   FINMIND_TOKEN=xxx
 *   ML_SERVICE_URL=https://xxx.run.app
 *   CLOUDFLARE_ACCOUNT_ID=xxx
 *   CLOUDFLARE_D1_DATABASE_ID=xxx
 *   CLOUDFLARE_API_TOKEN=xxx   （需要 D1:Edit 權限）
 *
 * 執行步驟：
 *   1. 從 D1 讀取所有 in_current_watchlist=1 的股票清單
 *   2. 對每支股票從 FinMind 回抓 500 天 OHLCV + 籌碼 + 技術指標
 *   3. 回抓 TWII 大盤資料寫入 market_risk（供 HMM 訓練）
 *   4. 呼叫 ML /retrain 對每支股票訓練所有模型
 *   5. 印出完整摘要報告
 */

import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG：沒有 .env 的話直接在這裡填
// ═══════════════════════════════════════════════════════════════════════════
function getEnv(key: string, fallback = ''): string {
  return process.env[key] ?? fallback
}

const CONFIG = {
  finmindToken:        getEnv('FINMIND_TOKEN'),
  mlServiceUrl:        getEnv('ML_SERVICE_URL'),
  cfAccountId:         getEnv('CLOUDFLARE_ACCOUNT_ID'),
  cfD1DatabaseId:      getEnv('CLOUDFLARE_D1_DATABASE_ID'),
  cfApiToken:          getEnv('CLOUDFLARE_API_TOKEN'),

  // 回填起始日（越早越好，FinMind 台股最早到 2000 年）
  backfillStartDate:   getEnv('BACKFILL_START_DATE', daysAgo(500)),

  // 每支股票請求之間的延遲（ms），避免超過 FinMind 600 req/hr 限制
  delayBetweenStocks:  1200,

  // D1 batch 最大值（官方上限 100）
  d1BatchSize:         80,
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().split('T')[0]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Checkpoint（斷點續傳）────────────────────────────────────────────────────
const CHECKPOINT_FILE = path.join(process.cwd(), 'backfill_checkpoint.json')

interface Checkpoint {
  lastCompletedIndex: number   // 最後成功完成的 index（-1 = 尚未開始）
  startedAt: string            // 初次開始時間
}

function readCheckpoint(): Checkpoint | null {
  try {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')) as Checkpoint
  } catch { return null }
}

function writeCheckpoint(index: number, startedAt: string): void {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ lastCompletedIndex: index, startedAt }))
  } catch (e) { err('Checkpoint 寫入失敗', e) }
}

function clearCheckpoint(): void {
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE) } catch {}
}

function log(emoji: string, msg: string) {
  console.log(`${emoji}  ${msg}`)
}

function err(msg: string, e?: unknown) {
  console.error(`❌  ${msg}`, e instanceof Error ? e.message : e ?? '')
}

// ─── 簡單 fetch wrapper（Node 18+ 原生 fetch，舊版用 https）─────────────────
async function fetchJson<T = any>(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<T> {
  const res = await fetch(url, {
    method:  options.method  ?? 'GET',
    headers: options.headers ?? {},
    body:    options.body,
    signal:  AbortSignal.timeout(60_000),
  } as RequestInit)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOUDFLARE D1 API
// ═══════════════════════════════════════════════════════════════════════════
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cfAccountId}/d1/database/${CONFIG.cfD1DatabaseId}`
const CF_HEADERS = {
  'Authorization': `Bearer ${CONFIG.cfApiToken}`,
  'Content-Type':  'application/json',
}

async function d1Query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const data = await fetchJson<any>(`${CF_BASE}/query`, {
    method:  'POST',
    headers: CF_HEADERS,
    body: JSON.stringify({ sql, params }),
  })
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`)
  return (data.result?.[0]?.results ?? []) as T[]
}

/** D1 批量 insert，自動分批（每批 80 筆）*/
async function d1Batch(statements: Array<{ sql: string; params: any[] }>): Promise<void> {
  if (!statements.length) return
  const batches: typeof statements[] = []
  for (let i = 0; i < statements.length; i += CONFIG.d1BatchSize) {
    batches.push(statements.slice(i, i + CONFIG.d1BatchSize))
  }
  for (const batch of batches) {
    const data = await fetchJson<any>(`${CF_BASE}/batch`, {
      method:  'POST',
      headers: CF_HEADERS,
      body: JSON.stringify({ batch: batch.map(s => ({ sql: s.sql, params: s.params })) }),
    })
    if (!data.success) throw new Error(`D1 batch failed: ${JSON.stringify(data.errors)}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FINMIND API
// ═══════════════════════════════════════════════════════════════════════════
const FM_BASE = 'https://api.finmindtrade.com/api/v4/data'

async function finmind<T = any>(dataset: string, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams({ dataset, token: CONFIG.finmindToken, ...params })
  const data = await fetchJson<any>(`${FM_BASE}?${qs}`)
  if (data.status !== 200) throw new Error(`FinMind ${dataset}: ${data.msg}`)
  return data.data ?? []
}

// ─── 計算技術指標（從 OHLCV array）─────────────────────────────────────────
function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n
}

function ema(arr: number[], n: number): number[] {
  const k = 2 / (n + 1)
  const result = [arr[0]]
  for (let i = 1; i < arr.length; i++) {
    result.push(arr[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

interface Indicators {
  ma5: number | null; ma10: number | null; ma20: number | null; ma60: number | null
  rsi14: number | null
  macd: number | null; macdSignal: number | null; macdHist: number | null
  bbUpper: number | null; bbMid: number | null; bbLower: number | null
  atr14: number | null
}

function computeIndicators(
  closes: number[], highs: number[], lows: number[],
): Indicators {
  const ma5  = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  const ma60 = sma(closes, 60)

  // RSI-14
  let rsi14: number | null = null
  if (closes.length >= 15) {
    let gains = 0, losses = 0
    for (let i = closes.length - 14; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1]
      if (d > 0) gains += d; else losses -= d
    }
    const avgG = gains / 14, avgL = losses / 14
    rsi14 = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  }

  // MACD
  let macd: number | null = null, macdSignal: number | null = null, macdHist: number | null = null
  if (closes.length >= 35) {
    const e12 = ema(closes, 12), e26 = ema(closes, 26)
    const macdLine = e12.map((v, i) => v - e26[i]).slice(25)
    const sigLine  = ema(macdLine, 9)
    macd       = macdLine[macdLine.length - 1]
    macdSignal = sigLine[sigLine.length - 1]
    macdHist   = macd - macdSignal
  }

  // Bollinger Bands
  let bbUpper: number | null = null, bbMid: number | null = null, bbLower: number | null = null
  if (closes.length >= 20) {
    const sl   = closes.slice(-20)
    const mean = sl.reduce((a, b) => a + b, 0) / 20
    const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / 20)
    bbMid = mean; bbUpper = mean + 2 * std; bbLower = mean - 2 * std
  }

  // ATR-14
  let atr14: number | null = null
  if (highs.length >= 15) {
    const trs: number[] = []
    for (let i = highs.length - 14; i < highs.length; i++) {
      trs.push(Math.max(
        highs[i]  - lows[i],
        Math.abs(highs[i]  - closes[i - 1]),
        Math.abs(lows[i]   - closes[i - 1]),
      ))
    }
    atr14 = trs.reduce((a, b) => a + b, 0) / 14
  }

  return { ma5, ma10, ma20, ma60, rsi14, macd, macdSignal, macdHist, bbUpper, bbMid, bbLower, atr14 }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1：讀取股票清單
// ═══════════════════════════════════════════════════════════════════════════
async function getActiveStocks(): Promise<Array<{ id: number; symbol: string; market: string; name: string }>> {
  // D3 fix: backfill all tradable stocks (not just watchlist) for backtest universe coverage
  return d1Query('SELECT id, symbol, market, name FROM stocks WHERE delisted_date IS NULL ORDER BY symbol')
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2：回填單支股票（價格 + 籌碼 + 技術指標）
// ═══════════════════════════════════════════════════════════════════════════
async function backfillStock(stock: { id: number; symbol: string; market: string }): Promise<{
  prices: number; chips: number; indicators: number; error?: string
}> {
  const stockCode = stock.symbol.replace(/\.TW$|\.TWO$/, '')
  const isTW      = stock.market === 'TW' || stock.market === 'TWO'
  const startDate = CONFIG.backfillStartDate
  let priceCount = 0, chipCount = 0, indCount = 0

  // ── 股價 ──────────────────────────────────────────────────────────────────
  let priceRows: any[] = []
  try {
    if (isTW) {
      priceRows = await finmind('TaiwanStockPrice', { data_id: stockCode, start_date: startDate })
    } else {
      // 美股走 Yahoo Finance
      const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.symbol)}?interval=1d&range=2y`
      const data = await fetchJson<any>(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      const r    = data.chart?.result?.[0]
      if (r) {
        const ts = r.timestamp as number[]
        const q  = r.indicators?.quote?.[0]
        priceRows = ts.map((t, i) => ({
          date: new Date(t * 1000).toISOString().split('T')[0],
          open: q.open?.[i], max: q.high?.[i], min: q.low?.[i],
          close: q.close?.[i], Trading_Volume: q.volume?.[i],
        })).filter(p => p.close != null)
      }
    }

    if (priceRows.length) {
      const stmts = priceRows.map(p => ({
        sql: `INSERT OR REPLACE INTO stock_prices
                (stock_id, date, open, high, low, close, adj_close, volume)
              VALUES (?,?,?,?,?,?,?,?)`,
        params: [stock.id, p.date, p.open, p.max, p.min, p.close, p.close, p.Trading_Volume],
      }))
      await d1Batch(stmts)
      priceCount = priceRows.length
    }
  } catch (e) {
    err(`  股價失敗 ${stockCode}`, e)
  }

  // ── 技術指標（逐日計算，回填所有日期）────────────────────────────────────
  try {
    if (priceRows.length >= 20) {
      // 按日期排序
      const sorted = [...priceRows].sort((a, b) => a.date < b.date ? -1 : 1)
      const stmts: Array<{ sql: string; params: any[] }> = []

      for (let i = 20; i <= sorted.length; i++) {
        const window  = sorted.slice(0, i)
        const closes  = window.map((p: any) => p.close)
        const highs   = window.map((p: any) => p.max)
        const lows    = window.map((p: any) => p.min)
        const date    = sorted[i - 1].date
        const ind     = computeIndicators(closes, highs, lows)

        stmts.push({
          sql: `INSERT OR REPLACE INTO technical_indicators
                  (stock_id, date, ma5, ma10, ma20, ma60, rsi14,
                   macd, macd_signal, macd_hist, bb_upper, bb_mid, bb_lower, atr14)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            stock.id, date,
            ind.ma5, ind.ma10, ind.ma20, ind.ma60, ind.rsi14,
            ind.macd, ind.macdSignal, ind.macdHist,
            ind.bbUpper, ind.bbMid, ind.bbLower, ind.atr14,
          ],
        })
      }
      await d1Batch(stmts)
      indCount = stmts.length
    }
  } catch (e) {
    err(`  技術指標失敗 ${stockCode}`, e)
  }

  // ── 籌碼（僅台股）────────────────────────────────────────────────────────
  if (isTW) {
    try {
      const chipRows = await finmind(
        'TaiwanStockInstitutionalInvestorsBuySell',
        { data_id: stockCode, start_date: startDate },
      )
      // 彙整：同日期三筆（外資/投信/自營）→ 1 筆
      const chipMap: Record<string, { foreign_net: number; trust_net: number; dealer_net: number }> = {}
      for (const r of chipRows) {
        if (!chipMap[r.date]) chipMap[r.date] = { foreign_net: 0, trust_net: 0, dealer_net: 0 }
        const net = r.buy - r.sell
        if (r.name.includes('外資'))     chipMap[r.date].foreign_net += net
        else if (r.name.includes('投信')) chipMap[r.date].trust_net   += net
        else if (r.name.includes('自營')) chipMap[r.date].dealer_net  += net
      }

      const stmts = Object.entries(chipMap).map(([date, c]) => ({
        sql: `INSERT OR REPLACE INTO chip_data
                (stock_id, date, foreign_net, trust_net, dealer_net)
              VALUES (?,?,?,?,?)`,
        params: [stock.id, date, c.foreign_net, c.trust_net, c.dealer_net],
      }))
      if (stmts.length) {
        await d1Batch(stmts)
        chipCount = stmts.length
      }
    } catch (e) {
      err(`  籌碼失敗 ${stockCode}`, e)
    }
  }

  return { prices: priceCount, chips: chipCount, indicators: indCount }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3：回填 TWII 大盤資料到 market_risk（HMM 訓練需要）
// ═══════════════════════════════════════════════════════════════════════════
async function backfillMarketRisk(): Promise<number> {
  log('📈', '回填大盤資料（TWII → market_risk）...')
  try {
    const rows = await finmind('TaiwanStockPrice', {
      data_id:    'TAIEX',
      start_date: CONFIG.backfillStartDate,
    })

    if (!rows.length) {
      // FinMind TAIEX 有時用 Y9999
      const rows2 = await finmind('TaiwanStockPrice', {
        data_id:    'Y9999',
        start_date: CONFIG.backfillStartDate,
      })
      rows.push(...rows2)
    }

    if (!rows.length) {
      log('⚠️', 'TWII 資料為空，跳過 market_risk 回填')
      return 0
    }

    const sorted = [...rows].sort((a, b) => a.date < b.date ? -1 : 1)
    const closes = sorted.map((r: any) => r.close)
    const stmts: Array<{ sql: string; params: any[] }> = []

    for (let i = 1; i < sorted.length; i++) {
      const date  = sorted[i].date
      const close = closes[i]
      const prev  = closes[i - 1]

      // 日報酬
      const ret1d = prev > 0 ? (close - prev) / prev : 0

      // 5 日報酬
      const ret5d = i >= 5 && closes[i - 5] > 0
        ? (close - closes[i - 5]) / closes[i - 5]
        : null

      // 20 日乖離率
      const ma20  = i >= 20
        ? closes.slice(i - 20, i).reduce((a: number, b: number) => a + b, 0) / 20
        : null
      const bias20d = ma20 && ma20 > 0 ? (close - ma20) / ma20 : null

      // 簡單風險分數：乖離率越大 + 日跌越大 → 風險越高
      const riskRaw = Math.min(100, Math.max(0,
        50
        - (ret1d * 200)       // 跌 1% → +2 風險
        + (bias20d ? Math.abs(bias20d) * 100 : 0)  // 乖離 5% → +5 風險
      ))
      const riskScore = Math.round(riskRaw)
      const riskLevel = riskScore >= 70 ? 'critical'
                      : riskScore >= 50 ? 'high'
                      : riskScore >= 30 ? 'medium'
                      : 'low'

      stmts.push({
        sql: `INSERT OR REPLACE INTO market_risk
                (date, twii_close, risk_score, risk_level,
                 market_return_1d, market_return_5d, market_bias_20d)
              VALUES (?,?,?,?,?,?,?)`,
        params: [date, close, riskScore, riskLevel, ret1d, ret5d, bias20d],
      })
    }

    await d1Batch(stmts)
    log('✅', `market_risk 寫入 ${stmts.length} 筆`)
    return stmts.length
  } catch (e) {
    err('market_risk 回填失敗', e)
    return 0
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4：呼叫 ML /retrain（每支股票）
// ═══════════════════════════════════════════════════════════════════════════
async function retrainStock(stock: { id: number; symbol: string; market: string }): Promise<boolean> {
  if (!CONFIG.mlServiceUrl) {
    log('⚠️', 'ML_SERVICE_URL 未設定，跳過 retrain')
    return false
  }

  // 從 D1 讀取該股票的資料
  const [priceRows, chipRows, indRows, mrRows] = await Promise.all([
    d1Query(
      'SELECT date, open, high, low, close, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 600',
      [stock.id],
    ),
    d1Query(
      'SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 200',
      [stock.id],
    ),
    d1Query(
      'SELECT date, ma5, ma20, rsi14, macd_hist as macdHist, bb_upper as bbUpper, bb_lower as bbLower, atr14 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 600',
      [stock.id],
    ),
    d1Query(
      'SELECT date, risk_score, risk_level, market_return_1d, market_return_5d, market_bias_20d FROM market_risk ORDER BY date DESC LIMIT 500',
    ),
  ])

  if (priceRows.length < 60) {
    log('⚠️', `  ${stock.symbol} 資料不足 60 天（${priceRows.length} 筆），跳過 retrain`)
    return false
  }

  // 建構 market_env.history（供 HMM 訓練）
  const mrHistory: Record<string, any> = {}
  for (const r of mrRows) {
    mrHistory[r.date] = {
      risk_score:         r.risk_score,
      risk_level:         r.risk_level,
      market_return_1d:   r.market_return_1d,
      market_return_5d:   r.market_return_5d,
      market_bias_20d:    r.market_bias_20d,
    }
  }
  const latestMR = mrRows[0]

  try {
    const body = {
      stock_id:  stock.id,
      symbol:    stock.symbol,
      market:    stock.market,
      horizon:   14,
      prices:    priceRows.map(p => ({
        date: p.date, close: p.close, open: p.open,
        high: p.high, low: p.low, volume: p.volume,
      })),
      indicators: indRows,
      chips:      stock.market === 'TW' || stock.market === 'TWO' ? chipRows : [],
      market_env: latestMR ? {
        risk_score:       latestMR.risk_score,
        risk_level:       latestMR.risk_level,
        market_return_1d: latestMR.market_return_1d,
        market_return_5d: latestMR.market_return_5d,
        market_bias_20d:  latestMR.market_bias_20d,
        history:          mrHistory,
      } : null,
    }

    const result = await fetchJson<any>(`${CONFIG.mlServiceUrl}/retrain`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    const trained = Object.entries(result.results ?? {})
      .filter(([, v]: [string, any]) => v.trained !== false && !v.error)
      .map(([k]) => k)
    log('🤖', `  ${stock.symbol} retrain 完成：${trained.join(' / ')}`)
    return true
  } catch (e) {
    err(`  ${stock.symbol} retrain 失敗`, e)
    return false
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║        StockVision — 首次上線歷史回填工具             ║')
  console.log('║        版本 v11 | 一鍵執行                           ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log('')

  // ── 環境變數檢查 ────────────────────────────────────────────────────────
  const missing = (['finmindToken', 'cfAccountId', 'cfD1DatabaseId', 'cfApiToken'] as const)
    .filter(k => !CONFIG[k])
  if (missing.length) {
    console.error('❌  缺少必要環境變數：')
    for (const k of missing) console.error(`     - ${k.toUpperCase().replace(/([A-Z])/g, '_$1').slice(1)}`)
    console.error('\n   請在 .env 設定後重試，或直接修改 scripts/backfill.ts 頂部的 CONFIG')
    process.exit(1)
  }
  if (!CONFIG.mlServiceUrl) {
    log('⚠️', 'ML_SERVICE_URL 未設定，將跳過 ML retrain（可之後手動補跑）')
  }

  // ── 斷點續傳檢查 ────────────────────────────────────────────────────────
  const checkpoint = readCheckpoint()
  const startAt = Date.now()
  const startedAt = checkpoint?.startedAt ?? new Date().toISOString()
  const resumeFrom = (checkpoint?.lastCompletedIndex ?? -1) + 1

  if (checkpoint && resumeFrom > 0) {
    log('🔁', `發現斷點記錄，從第 ${resumeFrom + 1} 支股票繼續（上次進度：index ${checkpoint.lastCompletedIndex}）`)
  }

  log('🔍', `回填起始日：${CONFIG.backfillStartDate}`)

  // ── Step 1：讀取股票清單 ────────────────────────────────────────────────
  log('📋', '讀取股票清單...')
  const stocks = await getActiveStocks()
  if (!stocks.length) {
    console.error('❌  D1 中沒有可交易的股票')
    process.exit(1)
  }
  log('✅', `找到 ${stocks.length} 支股票：${stocks.map(s => s.symbol).join('  ')}`)
  console.log('')

  // ── Step 2：逐股回填股價 + 籌碼 + 技術指標 ────────────────────────────
  console.log('─────────────────────────────────────────────────────────')
  log('📥', `開始回填股價資料（每支間隔 ${CONFIG.delayBetweenStocks}ms 避免 API 限速）`)
  if (resumeFrom > 0) log('⏭️', `跳過前 ${resumeFrom} 支（已完成）`)
  console.log('─────────────────────────────────────────────────────────')

  const stockResults: Record<string, any> = {}
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i]

    // 跳過已完成的股票
    if (i < resumeFrom) {
      stockResults[s.symbol] = { status: 'skipped' }
      continue
    }

    log('⏳', `[${i + 1}/${stocks.length}] ${s.symbol} ${s.name}`)
    try {
      const r = await backfillStock(s)
      stockResults[s.symbol] = { ...r, status: 'ok' }
      log('✅', `  股價 ${r.prices} 筆 | 技術指標 ${r.indicators} 筆 | 籌碼 ${r.chips} 筆`)
      writeCheckpoint(i, startedAt)  // 每支成功後立即更新斷點
    } catch (e) {
      stockResults[s.symbol] = { status: 'error', error: String(e) }
      err(`  ${s.symbol} 完整失敗`, e)
      // 失敗不更新斷點（下次從此 index 重試）
    }
    if (i < stocks.length - 1) await sleep(CONFIG.delayBetweenStocks)
  }
  console.log('')

  // ── Step 3：回填大盤資料 ────────────────────────────────────────────────
  console.log('─────────────────────────────────────────────────────────')
  const mrCount = await backfillMarketRisk()
  console.log('')

  // ── Step 4：ML retrain ──────────────────────────────────────────────────
  if (CONFIG.mlServiceUrl) {
    console.log('─────────────────────────────────────────────────────────')
    log('🤖', `開始 ML retrain（${stocks.length} 支股票）...`)
    console.log('')

    // 先喚醒 ML 服務，避免第一支股票遇到冷啟動 timeout
    try {
      log('🔥', '喚醒 ML 服務...')
      await fetchJson(`${CONFIG.mlServiceUrl}/health`)
      log('✅', 'ML 服務已就緒')
    } catch {
      log('⚠️', 'ML 服務喚醒失敗（可能正在啟動），等待 15 秒...')
      await sleep(15_000)
    }

    let retrainOk = 0
    for (let i = 0; i < stocks.length; i++) {
      const s = stocks[i]
      log('🔄', `[${i + 1}/${stocks.length}] 訓練 ${s.symbol}`)
      const ok = await retrainStock(s)
      if (ok) retrainOk++
      // retrain 較耗時，給 ML 服務一點喘息空間
      if (i < stocks.length - 1) await sleep(3_000)
    }
    log('✅', `Retrain 完成：${retrainOk}/${stocks.length} 支成功`)
    console.log('')
  }

  // ── 摘要報告 ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1)
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║                   回填完成摘要                        ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log(`  總耗時：${elapsed}s`)
  console.log(`  大盤資料：${mrCount} 筆寫入 market_risk`)
  console.log('')
  console.log('  各股結果：')
  for (const [sym, r] of Object.entries(stockResults)) {
    if (r.status === 'ok') {
      console.log(`  ✅ ${sym.padEnd(12)} 股價 ${String(r.prices).padStart(4)} 筆 | 指標 ${String(r.indicators).padStart(4)} 筆 | 籌碼 ${String(r.chips).padStart(4)} 筆`)
    } else {
      console.log(`  ❌ ${sym.padEnd(12)} 失敗: ${r.error?.slice(0, 60)}`)
    }
  }
  console.log('')

  const failed  = Object.values(stockResults).filter((r: any) => r.status === 'error').length
  const skipped = Object.values(stockResults).filter((r: any) => r.status === 'skipped').length
  if (failed === 0) {
    clearCheckpoint()  // 全部完成，刪除斷點檔
    console.log('🎉  所有資料回填成功！Cron 從明天起會自動維護最新資料。')
  } else {
    console.log(`⚠️   ${failed} 支股票失敗，請檢查錯誤訊息後重試。`)
    console.log('   （重新執行腳本將從上次失敗的股票繼續，斷點已儲存至 backfill_checkpoint.json）')
  }
  if (skipped > 0) console.log(`   （已跳過 ${skipped} 支先前完成的股票）`)
  console.log('')
}

main().catch(e => {
  console.error('❌  Unexpected error:', e)
  process.exit(1)
})
