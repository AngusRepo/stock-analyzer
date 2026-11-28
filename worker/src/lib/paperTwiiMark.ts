import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { parseTwseOfficialDate, parseTwseOfficialNumber } from './twseOfficialParse'
import { paperExecutionFetch, scopedPaperAccountId } from './paperExecutionScope'

// paper_daily_snapshots.twii_value is the TAIEX close OF THE VALUATION SESSION.
//
// The snapshot runs at 14:20 and 18:25 TW, but market_risk(D) is written by the evening ML chain
// (recomputeDailyMarketRisk, 21:45 root). Before 2026-10-29 the snapshot read
// `market_risk WHERE date <= D ORDER BY date DESC` and so stored D-1's close under D; AUD-20
// (3b7902f9) made it exact-date and every snapshot since 2026-10-30 stored null. The close is
// now taken, still for exactly D, from the first source that has it at snapshot time:
//   1. core market_risk.twii_close (when the chain already ran, e.g. a re-run)
//   2. market canonical_market_index_daily TWII/TAIEX (FinLab total index, then TWSE official)
//   3. TWSE MI_5MINS_HIST for D's month (official daily close, published after the 13:30 close)
// A close dated any other day never stands in. Inside a paper execution scope (native runner,
// replays, fixtures) inputs are sealed, so step 3 is skipped and only the D1 sources are read.

export type SessionTwiiMark = {
  value: number | null
  source: 'market_risk' | 'canonical_market_index_daily' | 'twse.mi_5mins_hist.official' | null
  canonical_source?: string
}

const plausible = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 1000 && value < 100000

export const CANONICAL_TWII_SESSION_SQL = `
  SELECT close, source
    FROM canonical_market_index_daily
   WHERE symbol IN ('TWII', 'TAIEX')
     AND date = ?
     AND close > 1000 AND close < 100000
     AND source != 'finlab.benchmark_return'
   ORDER BY CASE source WHEN 'finlab.taiex_total_index' THEN 0 WHEN 'twse.mi_5mins_hist.official' THEN 1 ELSE 2 END
   LIMIT 1`

export async function fetchTwseSessionTwiiClose(session: string, fetchImpl: typeof fetch = paperExecutionFetch): Promise<number | null> {
  try {
    const res = await fetchImpl(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${session.replace(/-/g, '')}&response=json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'StockVisionBot/1.0' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { data?: unknown[] }
    for (const item of Array.isArray(body?.data) ? body.data : []) {
      if (!Array.isArray(item) || item.length < 5) continue
      if (parseTwseOfficialDate(item[0]) !== session) continue
      const close = parseTwseOfficialNumber(item[4])
      return plausible(close) ? close : null
    }
  } catch { /* network/parse failure: the mark stays missing */ }
  return null
}

export async function resolveSessionTwiiClose(
  env: Bindings,
  session: string,
  options: { allowNetwork?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SessionTwiiMark> {
  const risk = await databaseForDataDomain(env, 'core')
    .prepare('SELECT twii_close FROM market_risk WHERE date = ? AND twii_close > 0')
    .bind(session).first<{ twii_close: number }>().catch(() => null)
  if (plausible(Number(risk?.twii_close))) return { value: Number(risk!.twii_close), source: 'market_risk' }

  const canonical = await databaseForDataDomain(env, 'market')
    .prepare(CANONICAL_TWII_SESSION_SQL)
    .bind(session).first<{ close: number; source: string }>().catch(() => null)
  if (plausible(Number(canonical?.close))) {
    return { value: Number(canonical!.close), source: 'canonical_market_index_daily', canonical_source: canonical!.source }
  }

  if (!(options.allowNetwork ?? scopedPaperAccountId() === null)) return { value: null, source: null }
  const official = await fetchTwseSessionTwiiClose(session, options.fetchImpl ?? paperExecutionFetch)
  if (official != null) return { value: official, source: 'twse.mi_5mins_hist.official' }
  return { value: null, source: null }
}
