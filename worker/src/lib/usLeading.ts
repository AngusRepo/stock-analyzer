/**
 * usLeading.ts — 美股先行指標
 *
 * 每日 08:30 TW (00:30 UTC) 抓取美股前夜收盤，寫入 D1 + KV。
 * 標的：SOX, TSM(TSMC ADR), ^GSPC, DXY, HY OAS, VIX
 * 數據源：Yahoo Finance（免費）+ FRED API（HY spread，免費）
 */

import type { Bindings } from '../types'

interface USSignal {
  date: string
  sox_close: number | null; sox_return: number | null; sox_ma5: number | null
  tsm_close: number | null; tsm_return: number | null; tsm_premium: number | null
  gspc_close: number | null; gspc_return: number | null
  dxy_close: number | null; dxy_return: number | null
  hy_spread: number | null; hy_spread_chg: number | null
  vix_close: number | null
  sentiment: 'bullish' | 'neutral' | 'bearish'
}

// ─── Yahoo Finance 抓取 ──────────────────────────────────────────────────────

async function fetchYahooQuote(symbol: string): Promise<{ close: number; prevClose: number } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) return null
    const json = await res.json() as any
    const closes: number[] = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
    const valid = closes.filter((c: any) => c != null && c > 0)
    if (valid.length < 2) return null
    return { close: valid[valid.length - 1], prevClose: valid[valid.length - 2] }
  } catch { return null }
}

async function fetchYahooMA5(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) return null
    const json = await res.json() as any
    const closes: number[] = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .filter((c: any) => c != null && c > 0)
    if (closes.length < 5) return null
    return closes.slice(-5).reduce((s: number, v: number) => s + v, 0) / 5
  } catch { return null }
}

// ─── FRED API（HY OAS 信用利差）──────────────────────────────────────────────

async function fetchHYSpread(): Promise<{ value: number; prevValue: number } | null> {
  try {
    // BAMLH0A0HYM2 = ICE BofA US High Yield OAS
    const res = await fetch(
      'https://api.stlouisfed.org/fred/series/observations?series_id=BAMLH0A0HYM2&sort_order=desc&limit=5&file_type=json&api_key=DEMO_KEY',
      { signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) return null
    const json = await res.json() as any
    const obs = (json?.observations ?? []).filter((o: any) => o.value !== '.')
    if (obs.length < 2) return null
    return { value: parseFloat(obs[0].value), prevValue: parseFloat(obs[1].value) }
  } catch { return null }
}

// ─── Main: 蒐集 + 存儲 ──────────────────────────────────────────────────────

export async function fetchAndStoreUSLeading(env: Bindings): Promise<USSignal | null> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  console.log(`[USLeading] Fetching US market signals for ${today}...`)

  // 平行抓 6 支標的
  const [sox, tsm, gspc, dxy, vix, soxMa5, hy] = await Promise.all([
    fetchYahooQuote('%5ESOX'),     // ^SOX 費半
    fetchYahooQuote('TSM'),        // TSMC ADR
    fetchYahooQuote('%5EGSPC'),    // S&P 500
    fetchYahooQuote('DX-Y.NYB'),   // DXY 美元指數
    fetchYahooQuote('%5EVIX'),     // VIX
    fetchYahooMA5('%5ESOX'),       // SOX 5日均線
    fetchHYSpread(),               // HY OAS
  ])

  const soxReturn = sox ? (sox.close - sox.prevClose) / sox.prevClose : null
  const tsmReturn = tsm ? (tsm.close - tsm.prevClose) / tsm.prevClose : null
  const gspcReturn = gspc ? (gspc.close - gspc.prevClose) / gspc.prevClose : null
  const dxyReturn = dxy ? (dxy.close - dxy.prevClose) / dxy.prevClose : null
  const hySpreadChg = hy ? hy.value - hy.prevValue : null

  // 綜合情緒判斷
  let sentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral'
  const bullSignals = [
    soxReturn != null && soxReturn > 0.01,
    gspcReturn != null && gspcReturn > 0.005,
    vix?.close != null && vix.close < 20,
  ].filter(Boolean).length
  const bearSignals = [
    soxReturn != null && soxReturn < -0.02,
    gspcReturn != null && gspcReturn < -0.01,
    vix?.close != null && vix.close > 30,
    hy != null && hy.value > 5,  // HY spread > 500bps = stress
  ].filter(Boolean).length

  if (bullSignals >= 2) sentiment = 'bullish'
  else if (bearSignals >= 2) sentiment = 'bearish'

  const signal: USSignal = {
    date: today,
    sox_close: sox?.close ?? null, sox_return: soxReturn, sox_ma5: soxMa5,
    tsm_close: tsm?.close ?? null, tsm_return: tsmReturn, tsm_premium: null,  // 需台股開盤價對比
    gspc_close: gspc?.close ?? null, gspc_return: gspcReturn,
    dxy_close: dxy?.close ?? null, dxy_return: dxyReturn,
    hy_spread: hy?.value ?? null, hy_spread_chg: hySpreadChg,
    vix_close: vix?.close ?? null,
    sentiment,
  }

  // 存 D1
  try {
    await env.DB.prepare(`
      INSERT INTO us_market_signals (date, sox_close, sox_return, sox_ma5, tsm_close, tsm_return, tsm_premium,
        gspc_close, gspc_return, dxy_close, dxy_return, hy_spread, hy_spread_chg, vix_close, sentiment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        sox_close=excluded.sox_close, sox_return=excluded.sox_return, sox_ma5=excluded.sox_ma5,
        tsm_close=excluded.tsm_close, tsm_return=excluded.tsm_return, tsm_premium=excluded.tsm_premium,
        gspc_close=excluded.gspc_close, gspc_return=excluded.gspc_return,
        dxy_close=excluded.dxy_close, dxy_return=excluded.dxy_return,
        hy_spread=excluded.hy_spread, hy_spread_chg=excluded.hy_spread_chg,
        vix_close=excluded.vix_close, sentiment=excluded.sentiment
    `).bind(today, signal.sox_close, signal.sox_return, signal.sox_ma5,
            signal.tsm_close, signal.tsm_return, signal.tsm_premium,
            signal.gspc_close, signal.gspc_return,
            signal.dxy_close, signal.dxy_return,
            signal.hy_spread, signal.hy_spread_chg,
            signal.vix_close, signal.sentiment).run()
  } catch (e) { console.warn(`[USLeading] D1 write failed:`, e) }

  // 存 KV（供 Screener/Debate 快速讀取）
  await env.KV.put(`us:leading:${today}`, JSON.stringify(signal), { expirationTtl: 86400 })

  const summary = [
    sox ? `SOX ${soxReturn! >= 0 ? '+' : ''}${((soxReturn ?? 0) * 100).toFixed(1)}%` : null,
    gspc ? `S&P ${gspcReturn! >= 0 ? '+' : ''}${((gspcReturn ?? 0) * 100).toFixed(1)}%` : null,
    vix ? `VIX ${vix.close.toFixed(1)}` : null,
    hy ? `HY ${hy.value.toFixed(0)}bps` : null,
    `→ ${sentiment}`,
  ].filter(Boolean).join(' | ')
  console.log(`[USLeading] ${summary}`)

  return signal
}
