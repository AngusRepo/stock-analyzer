import { Hono } from 'hono'

import { loadLatestStockFinancialSnapshot, toLlmFinancialContext } from '../lib/fundamentalData'
import { DEFAULT_STRATEGY_SPECS } from '../lib/strategySpec'

// ── 安全的 ID 解析（parseInt NaN 防護）─────────────────────────────────────
function parseId(s: string | undefined | null): number | null {
  const n = parseInt(s ?? '')
  return isNaN(n) || n <= 0 ? null : n
}
function parsePosInt(s: string | undefined | null, fallback: number): number {
  const n = parseInt(s ?? '')
  return isNaN(n) || n <= 0 ? fallback : n
}
function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}
function extractXmlTag(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? decodeXmlEntities(match[1]) : ''
}
function parseRssItems(xml: string, source: string, limit: number) {
  return Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi))
    .slice(0, limit)
    .map((match) => {
      const raw = match[0]
      const title = extractXmlTag(raw, 'title')
      const url = extractXmlTag(raw, 'link')
      const publishedAt = extractXmlTag(raw, 'pubDate') || extractXmlTag(raw, 'published')
      const publishedDate = publishedAt ? new Date(publishedAt) : null
      const summary = extractXmlTag(raw, 'description').replace(/<[^>]+>/g, '').slice(0, 180)
      return {
        source,
        title,
        url,
        published_at: publishedDate && Number.isFinite(publishedDate.getTime()) ? publishedDate.toISOString() : null,
        summary,
      }
    })
    .filter((item) => item.title && item.url)
}
function stripNewsHtml(value: unknown): string {
  return decodeXmlEntities(String(value ?? ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
async function fetchCnyesStockNews(limit: number) {
  try {
    const url = `https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=${Math.max(limit * 6, 12)}`
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'StockVisionBot/1.0 (+https://stockvision)',
      },
    })
    if (!res.ok) throw new Error(`cnyes_http_${res.status}`)
    const body = await res.json() as any
    const rows = Array.isArray(body?.items?.data) ? body.items.data : []
    return rows
      .map((row: any) => {
        const newsId = row?.newsId ?? row?.id
        const publishedAt = Number(row?.publishAt ?? row?.publishedAt)
        return {
          source: '鉅亨網',
          title: String(row?.title ?? row?.summary ?? '').trim(),
          url: newsId ? `https://news.cnyes.com/news/id/${newsId}` : null,
          published_at: Number.isFinite(publishedAt) ? new Date(publishedAt * 1000).toISOString() : null,
          summary: stripNewsHtml(row?.summary ?? row?.content).slice(0, 180),
        }
      })
      .filter((item: any) => item.title && item.url)
      .filter(isStockMarketNews)
      .slice(0, limit)
  } catch (e) {
    console.warn('[market/news] Cnyes API failed:', e)
    return []
  }
}
const STOCK_NEWS_PATTERN = /股票|台股|股市|上市|上櫃|櫃買|個股|類股|股價|收盤|開盤|盤中|盤後|外資|投信|自營商|三大法人|成交量|融資|融券|台積電|鴻海|聯發科|電子股|金融股|權值股|ETF|除權息|營收|法說|財報|殖利率|現金股利|當沖|期貨|台指期/i
function isStockMarketNews(item: { title?: string | null; summary?: string | null; url?: string | null }): boolean {
  const text = `${item.title ?? ''} ${item.summary ?? ''}`
  return STOCK_NEWS_PATTERN.test(text)
}
function vixLevelFromValue(vix: number | null): string {
  if (vix == null) return 'unknown'
  if (vix < 15) return 'low'
  if (vix < 20) return 'normal'
  if (vix < 30) return 'elevated'
  if (vix < 40) return 'high'
  return 'extreme'
}
async function fetchYahooCloses(symbol: string, range = '3mo'): Promise<number[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return []
    const json = await res.json() as any
    return (json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .map((v: unknown) => Number(v))
      .filter((v: number) => Number.isFinite(v) && v > 0)
  } catch {
    return []
  }
}
function annualizedVolPct(closes: number[]): number | null {
  if (closes.length < 22) return null
  const last = closes.slice(-21)
  const returns = last.slice(1).map((close, index) => Math.log(close / last[index]))
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / Math.max(1, returns.length - 1)
  return Math.round(Math.sqrt(variance) * Math.sqrt(252) * 1000) / 10
}
async function buildMarketRiskFallback(reason: string) {
  const [vixCloses, twiiCloses] = await Promise.all([
    fetchYahooCloses('^VIX', '5d'),
    fetchYahooCloses('^TWII', '3mo'),
  ])
  const vix = vixCloses.length ? Math.round(vixCloses[vixCloses.length - 1] * 10) / 10 : null
  const twiiVol20 = annualizedVolPct(twiiCloses)
  return {
    date: new Date().toISOString().slice(0, 10),
    vix,
    vixLevel: vixLevelFromValue(vix),
    twiiClose: twiiCloses.length ? Math.round(twiiCloses[twiiCloses.length - 1] * 100) / 100 : null,
    twiiVol20,
    twiiMa20: null,
    twiiBias: null,
    foreignConsecutiveSell: null,
    foreignNet5d: null,
    marginRatio: null,
    limitDownCount: null,
    limitDownPct: null,
    riskScore: 50,
    riskLevel: 'local_fallback',
    riskSummary: `本機 market_risk 資料不可用，暫以 Yahoo VIX / TWII 20日波動率顯示。原因：${reason}`,
    calculatedAt: new Date().toISOString(),
    contextFactors: [],
    usMarketSignal: null,
    globalEventContext: {
      source: 'gdelt_events',
      provider: 'GDELT',
      status: 'missing',
      label: '尚未匯入',
      date: null,
      eventCount: 0,
      sourceQuality: null,
      entityConfidence: null,
      decisionEffect: 'risk_context_only',
      allowedUse: 'shadow_global_event_context',
      events: [],
      missingReason: 'market_risk_fallback',
    },
    fearGreedIndex: {
      schemaVersion: 'stockvision_fear_greed_v1',
      date: new Date().toISOString().slice(0, 10),
      score: null,
      label: '待匯入',
      source: 'local_fallback',
      methodology: '0=恐懼、100=貪婪；有效因子等權平均，缺資料因子不硬補。',
      factors: [],
      missingFactors: ['market_risk_empty'],
    },
    hedgeSentiment: {
      schemaVersion: 'stockvision_hedge_sentiment_v1',
      date: new Date().toISOString().slice(0, 10),
      score: null,
      label: '待匯入',
      source: 'local_fallback',
      methodology: '0=低避險、100=高避險；PCR、大戶部位、外資5日流、波動、信用利差、美元避險有效因子等權平均。',
      factors: [],
    },
    hedgeSentimentFactors: [],
  }
}

import type { Bindings, Variables } from '../types'
import { authMiddleware, adminMiddleware } from '../lib/auth'
import { rateLimitMiddleware } from '../lib/rateLimit'
import { withCache, TTL } from '../lib/cache'
import { fetchAndStoreStockData } from './stocks'
import { computeAndStoreIndicators } from '../lib/technicalIndicators'
import {
  generateTechnicalAnalysis,
  generateTradingAdvice,
  generateAnalystSummary,
  answerStockQuestion,
} from '../lib/llm'
import {
  buildHardGateSummary,
  buildSparseAllocationSummary,
  buildMlDiagnostics,
  buildMlVoteSummary,
  compactRecommendationForCard,
  DIRECT_ALPHA_VOTE_MODEL_NAMES,
  parsePredictionForecastData,
} from '../lib/recommendationContext'
import { getTradingConfig } from '../lib/tradingConfig'
import { classifyBoard, resolveRecommendationGovernance } from '../lib/boardTradability'
import { summarizeScreenerFunnelRows, summarizeStrategyPortfolioIntelligenceHealth } from '../lib/screenerFunnelEvidence'
import { readMarketRegimeState } from '../lib/marketRegimeState'
import {
  buildMarketRegimeFactorPacket,
  loadMarketRegimeFactorPacket,
  upsertMarketRegimeFactorPacket,
} from '../lib/marketRegimeFactorPacket'
import { buildMarketOptimisticOutlook } from '../lib/marketOutlook'
import { loadRecommendationEvidenceLinks } from '../lib/recommendationEvidenceLinks'
import { SCORE_V2_VERSION } from '../lib/scoreV2Taxonomy'
import { getAdaptiveParamsForRegime } from '../lib/adaptiveConfig'
import { fetchTaifexDayClose, fetchTaifexNightClose } from '../lib/twseApi'

// ════════════════════════════════════════════════════════════════════════════
// MARKET routes
// ════════════════════════════════════════════════════════════════════════════
export const market = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type MarketSeriesCandidate = {
  sql: string
  binds?: unknown[]
  source: string
}

type MarketSeriesPoint = {
  date: string
  close: number
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function formatTaipeiIsoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  const day = parts.find((part) => part.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}

function taipeiIsoDate(): string {
  return formatTaipeiIsoDate(new Date())
}

function taipeiIsoDateMinusDays(daysBack: number): string {
  const todayStartTw = new Date(`${taipeiIsoDate()}T00:00:00+08:00`)
  return formatTaipeiIsoDate(new Date(todayStartTw.getTime() - daysBack * 86400_000))
}

function parseOfficialNumber(value: unknown): number | null {
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (!text || text === '-') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

function parseOfficialDate(value: unknown): string | null {
  const text = String(value ?? '').trim()
  const slash = text.match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/)
  if (slash) {
    let year = Number(slash[1])
    if (year < 1911) year += 1911
    return `${year.toString().padStart(4, '0')}-${slash[2].padStart(2, '0')}-${slash[3].padStart(2, '0')}`
  }
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  return null
}

function buildIndexSnapshot(
  symbol: string,
  name: string,
  points: MarketSeriesPoint[],
  source: string,
) {
  const byDate = new Map<string, number>()
  for (const point of points) {
    if (Number.isFinite(point.close)) byDate.set(point.date, point.close)
  }
  const series = [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .filter((point) => Number.isFinite(point.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)
  const current = series.at(-1)?.close ?? null
  const date = series.at(-1)?.date ?? null
  const prev = series.length >= 2 ? series.at(-2)?.close ?? null : null
  const change = current != null && prev != null ? current - prev : null
  const changePct = current != null && prev ? (change! / prev) * 100 : null

  return {
    symbol,
    name,
    current: current == null ? null : Math.round(current * 100) / 100,
    change: change == null ? null : Math.round(change * 100) / 100,
    changePct: changePct == null ? null : Math.round(changePct * 100) / 100,
    date,
    source,
    status: current == null ? 'missing_finlab_source' : 'ok',
    history: series.map((point) => ({ date: point.date, close: Math.round(point.close * 100) / 100 })),
  }
}

async function loadFinlabSeries(
  db: D1Database,
  symbol: string,
  name: string,
  candidates: MarketSeriesCandidate[],
) {
  let fallbackSnapshot: ReturnType<typeof buildIndexSnapshot> | null = null
  for (const candidate of candidates) {
    try {
      const query = db.prepare(candidate.sql)
      const result = candidate.binds?.length
        ? await query.bind(...candidate.binds).all<any>()
        : await query.all<any>()
      const points = (result.results ?? [])
        .map((row: any) => {
          const date = String(row.date ?? row.trading_date ?? row.data_date ?? '').slice(0, 10)
          const close = numberOrNull(row.close ?? row.value ?? row.current ?? row.price)
          return date && close != null ? { date, close } : null
        })
        .filter((point): point is MarketSeriesPoint => Boolean(point))

      if (points.length > 0) {
        const snapshot = buildIndexSnapshot(symbol, name, points, candidate.source)
        if (!fallbackSnapshot) fallbackSnapshot = snapshot
        if (snapshot.history.length >= 2 && snapshot.change != null) return snapshot
      }
    } catch (e) {
      console.warn(`[market/indices] FinLab candidate skipped for ${symbol}: ${candidate.source}`, e)
    }
  }

  return fallbackSnapshot ?? buildIndexSnapshot(symbol, name, [], `FinLab source missing: ${candidates.map((item) => item.source).join(' / ')}`)
}

async function fetchTwseTaiexOfficialPoints(queryIsoDate: string): Promise<MarketSeriesPoint[]> {
  const queryDate = queryIsoDate.replace(/-/g, '')
  const res = await fetch(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${queryDate}&response=json`, {
    headers: { Accept: 'application/json', 'User-Agent': 'StockVisionBot/1.0' },
  })
  if (!res.ok) return []
  const body = await res.json() as any
  const rows = Array.isArray(body?.data) ? body.data : []
  return rows
    .map((row: any) => {
      if (!Array.isArray(row) || row.length < 5) return null
      const date = parseOfficialDate(row[0])
      const close = parseOfficialNumber(row[4])
      return date && close != null ? { date, close } : null
    })
    .filter((point: MarketSeriesPoint | null): point is MarketSeriesPoint => Boolean(point))
}

async function fetchTwseTaiexOfficialSeries() {
  try {
    const dates = Array.from({ length: 11 }, (_, daysBack) => taipeiIsoDateMinusDays(daysBack))
    const groups = await Promise.all(dates.map((date) => fetchTwseTaiexOfficialPoints(date).catch(() => [])))
    const points = groups.flat()
    return buildIndexSnapshot('TWII', '加權指數', points, 'TWSE MI_5MINS_HIST official')
  } catch (e) {
    console.warn('[market/indices] TWSE MI_5MINS_HIST fallback failed', e)
    return missingMaterializationSnapshot('TWII', '加權指數', 'TWSE MI_5MINS_HIST official')
  }
}

function hasMarketSeriesData(snapshot: any): boolean {
  return numberOrNull(snapshot?.current) != null
}

function hasMarketSeriesDelta(snapshot: any): boolean {
  return hasMarketSeriesData(snapshot) &&
    numberOrNull(snapshot?.change) != null &&
    numberOrNull(snapshot?.changePct ?? snapshot?.change_pct) != null
}

function normalizeMarketSeriesDate(value: unknown): string {
  const raw = String(value ?? '').trim()
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  return raw.slice(0, 10)
}

function chooseBestMarketSeries(primary: any, fallbacks: any[]): any {
  const candidates = [primary, ...fallbacks].filter((snapshot) => hasMarketSeriesData(snapshot))
  if (!candidates.length) return primary
  const withDelta = candidates.filter((snapshot) => hasMarketSeriesDelta(snapshot))
  const pool = withDelta.length ? withDelta : candidates
  return pool.sort((a, b) => normalizeMarketSeriesDate(b?.date).localeCompare(normalizeMarketSeriesDate(a?.date)))[0] ?? primary
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null
  return Math.round(((current - previous) / previous) * 10_000) / 100
}

const LISTED_OTC_SCOPE = {
  label: '上市櫃，不含興櫃',
  marketSegment: 'LISTED_OTC',
  includesListed: true,
  includesOtc: true,
  includesEmerging: false,
}

const TRACKED_UNIVERSE_SCOPE = {
  label: '追蹤股票池，不含興櫃',
  marketSegment: 'TRACKED_LISTED_OTC',
  includesListed: true,
  includesOtc: true,
  includesEmerging: false,
}

function missingMaterializationSnapshot(symbol: string, name: string, source: string) {
  return {
    symbol,
    name,
    current: null,
    change: null,
    changePct: null,
    source,
    status: 'finlab_not_materialized',
    history: [],
  }
}

async function loadMarketRiskTwiiSeries(db: D1Database) {
  try {
    const { results } = await db.prepare(
      `SELECT date, twii_close AS close
       FROM market_risk
       WHERE twii_close IS NOT NULL
       ORDER BY date DESC
       LIMIT 30`
    ).all<any>()
    const points = (results ?? [])
      .map((row: any) => {
        const date = String(row.date ?? '').slice(0, 10)
        const close = numberOrNull(row.close)
        return date && close != null ? { date, close } : null
      })
      .filter((point): point is MarketSeriesPoint => Boolean(point))
    return buildIndexSnapshot('TWII', '加權指數', points, 'FinLab canonical market_risk.twii_close')
  } catch (e) {
    console.warn('[market/indices] market_risk.twii_close fallback failed', e)
    return missingMaterializationSnapshot('TWII', '加權指數', 'FinLab canonical market_risk.twii_close')
  }
}

async function loadCanonicalMarketOverview(db: D1Database) {
  try {
    const row = await db.prepare(
      `WITH ordered_dates AS (
       SELECT date
       FROM canonical_market_daily
       WHERE market_segment = 'LISTED_OTC'
       GROUP BY date
       ORDER BY date DESC
       LIMIT 2
       ),
       latest_date AS (
         SELECT MAX(date) AS date FROM ordered_dates
       ),
       previous_date AS (
         SELECT MIN(date) AS date FROM ordered_dates
       ),
       joined_rows AS (
         SELECT
           cur.date,
           cur.stock_id,
           cur.close,
           prev.close AS prev_close,
           cur.volume,
           cur.value
         FROM canonical_market_daily cur
         JOIN latest_date ld ON cur.date = ld.date
         LEFT JOIN canonical_market_daily prev
           ON prev.stock_id = cur.stock_id
          AND prev.date = (SELECT date FROM previous_date)
          AND prev.market_segment = cur.market_segment
         WHERE cur.close IS NOT NULL
           AND cur.market_segment = 'LISTED_OTC'
       )
       SELECT
         (SELECT date FROM latest_date) AS date,
         SUM(CASE WHEN prev_close IS NOT NULL AND close > prev_close THEN 1 ELSE 0 END) AS advance_count,
         SUM(CASE WHEN prev_close IS NOT NULL AND close = prev_close THEN 1 ELSE 0 END) AS unchanged_count,
         SUM(CASE WHEN prev_close IS NOT NULL AND close < prev_close THEN 1 ELSE 0 END) AS decline_count,
         COUNT(CASE WHEN prev_close IS NOT NULL THEN 1 END) AS compared_count,
         SUM(COALESCE(volume, 0)) AS market_volume,
         SUM(COALESCE(value, 0)) AS market_value
       FROM joined_rows`
    ).first<any>()
    if (!row?.date) return null

    return {
      breadthSnapshot: {
        date: row.date,
        advance_count: numberOrNull(row.advance_count),
        unchanged_count: numberOrNull(row.unchanged_count),
        decline_count: numberOrNull(row.decline_count),
        compared_count: numberOrNull(row.compared_count),
        source: 'canonical_market_daily.finlab.price',
        scope: LISTED_OTC_SCOPE,
      },
      marketStats: {
        date: row.date,
        volume: numberOrNull(row.market_volume),
        amount: numberOrNull(row.market_value),
        comparedCount: numberOrNull(row.compared_count),
        source: 'canonical_market_daily.finlab.price',
        scope: LISTED_OTC_SCOPE,
        unit: {
          volume: 'shares',
          amount: 'TWD',
        },
      },
    }
  } catch (e) {
    console.warn('[market/risk] canonical_market_daily overview failed', e)
    return null
  }
}

async function loadCanonicalCreditTrading(db: D1Database) {
  const summary = await loadMarketSummaryCreditTrading(db)
  if (summary) {
    const canonicalChip = await loadCanonicalChipCreditTrading(db)
    return mergeCreditTradingSummaryWithCanonicalEstimate(summary, canonicalChip)
  }
  const canonicalChip = await loadCanonicalChipCreditTrading(db)
  if (canonicalChip) return canonicalChip
  return loadLegacyMarginDataCreditTrading(db)
}

function mergeCreditTradingSummaryWithCanonicalEstimate(summary: any, canonicalChip: any | null) {
  if (!canonicalChip || canonicalChip.date !== summary.date) return summary
  const merged = { ...summary }
  if (merged.estimatedMarginPositionValue == null && canonicalChip.estimatedMarginPositionValue != null) {
    merged.estimatedMarginPositionValue = canonicalChip.estimatedMarginPositionValue
    merged.estimatedMarginPositionValueChangePct = canonicalChip.estimatedMarginPositionValueChangePct ?? null
  }
  if (merged.estimatedShortPositionValue == null && canonicalChip.estimatedShortPositionValue != null) {
    merged.estimatedShortPositionValue = canonicalChip.estimatedShortPositionValue
    merged.estimatedShortPositionValueChangePct = canonicalChip.estimatedShortPositionValueChangePct ?? null
  }
  if (merged.marginBalanceUnits == null && canonicalChip.marginBalanceUnits != null) {
    merged.marginBalanceUnits = canonicalChip.marginBalanceUnits
  }
  if (merged.shortBalanceUnits == null && canonicalChip.shortBalanceUnits != null) {
    merged.shortBalanceUnits = canonicalChip.shortBalanceUnits
  }
  if (canonicalChip.pricedCount != null) merged.pricedCount = canonicalChip.pricedCount
  merged.source = `${summary.source};${canonicalChip.source}:estimated_value`
  merged.valueMethod = `${summary.valueMethod}+canonical_chip_estimated_value`
  return merged
}

async function loadMarketSummaryCreditTrading(db: D1Database) {
  try {
    const { results } = await db.prepare(
      `WITH ordered_dates AS (
         SELECT date
         FROM canonical_market_summary_daily
         WHERE margin_balance_value IS NOT NULL
            OR margin_balance_units IS NOT NULL
            OR short_balance_units IS NOT NULL
         GROUP BY date
         ORDER BY date DESC
         LIMIT 2
       ),
       scoped AS (
         SELECT s.*,
                CASE WHEN s.market_segment = 'ALL' THEN 1 ELSE 0 END AS is_all
         FROM canonical_market_summary_daily s
         JOIN ordered_dates d ON s.date = d.date
       ),
       mode AS (
         SELECT
           date,
           MAX(CASE WHEN is_all = 1 AND (
             margin_balance_value IS NOT NULL
             OR margin_balance_units IS NOT NULL
             OR short_balance_units IS NOT NULL
           ) THEN 1 ELSE 0 END) AS has_all_credit
         FROM scoped
         GROUP BY date
       )
       SELECT
         s.date,
         SUM(CASE WHEN m.has_all_credit = 1 AND s.market_segment <> 'ALL' THEN NULL ELSE s.margin_balance_value END) AS margin_balance_value,
         SUM(CASE WHEN m.has_all_credit = 1 AND s.market_segment <> 'ALL' THEN NULL ELSE s.margin_balance_units END) AS margin_balance_units,
         SUM(CASE WHEN m.has_all_credit = 1 AND s.market_segment <> 'ALL' THEN NULL ELSE s.short_balance_units END) AS short_balance_units,
         AVG(CASE WHEN m.has_all_credit = 1 AND s.market_segment <> 'ALL' THEN NULL ELSE s.margin_balance_change_pct END) AS margin_balance_change_pct,
         AVG(CASE WHEN m.has_all_credit = 1 AND s.market_segment <> 'ALL' THEN NULL ELSE s.short_balance_change_pct END) AS short_balance_change_pct,
         COUNT(*) AS coverage_count,
         GROUP_CONCAT(DISTINCT s.source) AS sources
       FROM scoped s
       JOIN mode m ON m.date = s.date
       GROUP BY s.date
       ORDER BY s.date DESC`
    ).all<any>()
    const latest = results?.[0]
    const previous = results?.[1]
    if (!latest?.date) return null
    const marginBalanceValue = numberOrNull(latest.margin_balance_value)
    const marginBalanceUnits = numberOrNull(latest.margin_balance_units)
    const shortBalanceUnits = numberOrNull(latest.short_balance_units)
    const previousMarginBalanceValue = numberOrNull(previous?.margin_balance_value)
    const previousMarginBalanceUnits = numberOrNull(previous?.margin_balance_units)
    const previousShortBalanceUnits = numberOrNull(previous?.short_balance_units)
    return {
      date: latest.date,
      marginBalance: marginBalanceValue ?? marginBalanceUnits,
      marginBalanceValue,
      marginBalanceUnits,
      marginBalanceUnit: marginBalanceValue != null ? 'TWD' : 'lots',
      shortBalance: shortBalanceUnits,
      shortBalanceUnits,
      shortBalanceValue: null,
      marginBalanceChangePct: numberOrNull(latest.margin_balance_change_pct)
        ?? percentChange(marginBalanceValue ?? marginBalanceUnits, previousMarginBalanceValue ?? previousMarginBalanceUnits),
      shortBalanceChangePct: numberOrNull(latest.short_balance_change_pct) ?? percentChange(shortBalanceUnits, previousShortBalanceUnits),
      maintenanceRate: null,
      coverageCount: numberOrNull(latest.coverage_count),
      source: `canonical_market_summary_daily:${latest.sources ?? 'market_summary'}`,
      scope: LISTED_OTC_SCOPE,
      valueMethod: marginBalanceValue != null ? 'official_market_summary' : 'official_units',
    }
  } catch (e) {
    console.warn('[market/risk] canonical_market_summary_daily credit trading failed', e)
    return null
  }
}

async function loadLegacyMarginDataCreditTrading(db: D1Database) {
  try {
    const { results } = await db.prepare(
      `WITH ordered_dates AS (
         SELECT date
         FROM margin_data
         GROUP BY date
         ORDER BY date DESC
         LIMIT 2
       )
       SELECT
         m.date,
         SUM(COALESCE(m.margin_balance, 0)) AS margin_balance_units,
         SUM(COALESCE(m.short_balance, 0)) AS short_balance_units,
         COUNT(*) AS coverage_count
       FROM margin_data m
       JOIN ordered_dates d ON m.date = d.date
       GROUP BY m.date
       ORDER BY m.date DESC`
    ).all<any>()
    const latest = results?.[0]
    const previous = results?.[1]
    if (!latest?.date) return null
    const marginBalanceUnits = numberOrNull(latest.margin_balance_units)
    const shortBalanceUnits = numberOrNull(latest.short_balance_units)
    const previousMarginBalanceUnits = numberOrNull(previous?.margin_balance_units)
    const previousShortBalanceUnits = numberOrNull(previous?.short_balance_units)
    return {
      date: latest.date,
      marginBalance: marginBalanceUnits,
      marginBalanceValue: null,
      marginBalanceUnits,
      marginBalanceUnit: 'lots',
      shortBalance: shortBalanceUnits,
      shortBalanceUnits,
      shortBalanceValue: null,
      marginBalanceChangePct: percentChange(marginBalanceUnits, previousMarginBalanceUnits),
      shortBalanceChangePct: percentChange(shortBalanceUnits, previousShortBalanceUnits),
      maintenanceRate: null,
      coverageCount: numberOrNull(latest.coverage_count),
      source: 'margin_data.legacy_serving_table',
      scope: TRACKED_UNIVERSE_SCOPE,
      valueMethod: 'tracked_universe_units',
    }
  } catch (e) {
    console.warn('[market/risk] margin_data credit trading failed', e)
    return null
  }
}

async function loadCanonicalChipCreditTrading(db: D1Database) {
  try {
    const { results } = await db.prepare(
      `WITH ordered_dates AS (
         SELECT date
         FROM canonical_chip_daily
         WHERE market_segment = 'LISTED_OTC'
         GROUP BY date
         ORDER BY date DESC
         LIMIT 2
       )
       SELECT
         c.date,
         SUM(COALESCE(c.margin_balance, 0)) AS margin_balance,
         SUM(COALESCE(c.short_balance, 0)) AS short_balance,
         SUM(CASE WHEN p.close IS NOT NULL THEN COALESCE(c.margin_balance, 0) * p.close * 1000 ELSE NULL END) AS estimated_margin_position_value,
         SUM(CASE WHEN p.close IS NOT NULL THEN COALESCE(c.short_balance, 0) * p.close * 1000 ELSE NULL END) AS estimated_short_position_value,
         COUNT(*) AS coverage_count,
         SUM(CASE WHEN p.close IS NOT NULL THEN 1 ELSE 0 END) AS priced_count
       FROM canonical_chip_daily c
       JOIN ordered_dates d ON c.date = d.date
       LEFT JOIN canonical_market_daily p
         ON p.stock_id = c.stock_id
        AND p.date = c.date
        AND p.market_segment = 'LISTED_OTC'
        AND p.source = 'finlab.price'
       WHERE c.market_segment = 'LISTED_OTC'
       GROUP BY c.date
       ORDER BY c.date DESC`
    ).all<any>()
    const latest = results?.[0]
    const previous = results?.[1]
    if (!latest?.date) return null
    const marginBalance = numberOrNull(latest.margin_balance)
    const shortBalance = numberOrNull(latest.short_balance)
    const estimatedMarginPositionValue = numberOrNull(latest.estimated_margin_position_value)
    const estimatedShortPositionValue = numberOrNull(latest.estimated_short_position_value)
    const previousMarginBalance = numberOrNull(previous?.margin_balance)
    const previousShortBalance = numberOrNull(previous?.short_balance)
    const previousEstimatedMarginPositionValue = numberOrNull(previous?.estimated_margin_position_value)
    const previousEstimatedShortPositionValue = numberOrNull(previous?.estimated_short_position_value)
    return {
      date: latest.date,
      marginBalance,
      shortBalance,
      marginBalanceValue: null,
      marginBalanceUnits: marginBalance,
      marginBalanceUnit: 'lots',
      shortBalanceUnits: shortBalance,
      shortBalanceValue: null,
      estimatedMarginPositionValue,
      estimatedShortPositionValue,
      marginBalanceChangePct: percentChange(marginBalance, previousMarginBalance),
      shortBalanceChangePct: percentChange(shortBalance, previousShortBalance),
      estimatedMarginPositionValueChangePct: percentChange(estimatedMarginPositionValue, previousEstimatedMarginPositionValue),
      estimatedShortPositionValueChangePct: percentChange(estimatedShortPositionValue, previousEstimatedShortPositionValue),
      maintenanceRate: null,
      coverageCount: numberOrNull(latest.coverage_count),
      pricedCount: numberOrNull(latest.priced_count),
      source: 'canonical_chip_daily.finlab.margin_transactions',
      scope: LISTED_OTC_SCOPE,
      valueMethod: 'official_units_pending_market_summary_value',
    }
  } catch (e) {
    console.warn('[market/risk] canonical_chip_daily credit trading failed', e)
    return null
  }
}

async function loadCanonicalInstitutionalFlows(db: D1Database) {
  try {
    const row = await db.prepare(
      `WITH latest_date AS (
         SELECT MAX(date) AS date
         FROM canonical_institutional_amount_daily
       )
       SELECT
         (SELECT date FROM latest_date) AS date,
         SUM(CASE WHEN investor = 'foreign' THEN net_amount ELSE 0 END) / 100000000.0 AS foreign_net,
         SUM(CASE WHEN investor = 'trust' THEN net_amount ELSE 0 END) / 100000000.0 AS trust_net,
         SUM(CASE WHEN investor IN ('dealer', 'dealer_self', 'dealer_hedge') THEN net_amount ELSE 0 END) / 100000000.0 AS dealer_net,
         SUM(CASE WHEN investor IN ('foreign', 'trust', 'dealer', 'dealer_self', 'dealer_hedge') THEN net_amount ELSE 0 END) / 100000000.0 AS total_net,
         COUNT(*) AS row_count
       FROM canonical_institutional_amount_daily
       WHERE date = (SELECT date FROM latest_date)`
    ).first<any>()
    if (!row?.date) return null
    return {
      date: row.date,
      foreignNet: numberOrNull(row.foreign_net),
      trustNet: numberOrNull(row.trust_net),
      dealerNet: numberOrNull(row.dealer_net),
      totalNet: numberOrNull(row.total_net),
      rowCount: numberOrNull(row.row_count),
      source: 'canonical_institutional_amount_daily.finlab.institutional_investors_trading_all_market_summary',
      scope: LISTED_OTC_SCOPE,
    }
  } catch (e) {
    console.warn('[market/risk] canonical_institutional_amount_daily flows failed', e)
    return null
  }
}

async function loadLatestUsMarketSignal(db: D1Database) {
  try {
    const row = await db.prepare(
      `SELECT date, sox_return, gspc_return, dxy_return, hy_spread, hy_spread_chg, vix_close, sentiment
       FROM us_market_signals
       ORDER BY date DESC
       LIMIT 1`
    ).first<any>()
    if (!row?.date) return null
    return {
      date: String(row.date ?? '').slice(0, 10),
      soxReturn: numberOrNull(row.sox_return),
      gspcReturn: numberOrNull(row.gspc_return),
      dxyReturn: numberOrNull(row.dxy_return),
      hySpread: numberOrNull(row.hy_spread),
      hySpreadChange: numberOrNull(row.hy_spread_chg),
      vixClose: numberOrNull(row.vix_close),
      sentiment: row.sentiment == null ? null : String(row.sentiment),
      source: 'us_market_signals',
    }
  } catch (e) {
    console.warn('[market/risk] us_market_signals failed', e)
    return null
  }
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

async function loadGdeltGlobalEventContext(db: D1Database) {
  try {
    const { results } = await db.prepare(
      `SELECT source_kind, title, source_url, published_at, themes_json, symbols_json,
              allowed_use, decision_effect, source_quality_score, entity_linking_confidence
         FROM external_evidence_items
        WHERE source_id = 'gdelt_events'
          AND accepted = 1
          AND date(published_at) >= date('now', '-14 days')
        ORDER BY published_at DESC
        LIMIT 6`
    ).all<any>()
    const rows = (results ?? []).map((row: any) => ({
      title: String(row.title ?? '').trim(),
      url: String(row.source_url ?? '').trim(),
      publishedAt: String(row.published_at ?? '').slice(0, 19),
      sourceKind: String(row.source_kind ?? 'global_event_graph'),
      allowedUse: String(row.allowed_use ?? 'shadow_global_event_context'),
      decisionEffect: String(row.decision_effect ?? 'risk_context_only'),
      sourceQuality: numberOrNull(row.source_quality_score),
      entityConfidence: numberOrNull(row.entity_linking_confidence),
      themes: parseJsonStringArray(row.themes_json).slice(0, 4),
      symbols: parseJsonStringArray(row.symbols_json).slice(0, 4),
    })).filter((row) => row.title)

    if (!rows.length) {
      return {
        source: 'gdelt_events',
        provider: 'GDELT',
        status: 'missing',
        label: '尚未匯入',
        date: null,
        eventCount: 0,
        sourceQuality: null,
        entityConfidence: null,
        decisionEffect: 'risk_context_only',
        allowedUse: 'shadow_global_event_context',
        events: [],
        missingReason: 'no_accepted_gdelt_events_last_14d',
      }
    }

    const sourceQuality = averageNumbers(rows.map((row) => row.sourceQuality))
    const entityConfidence = averageNumbers(rows.map((row) => row.entityConfidence))
    const latest = rows[0]
    const label = sourceQuality == null
      ? '全球事件脈絡'
      : sourceQuality >= 0.65
        ? '高品質事件脈絡'
        : sourceQuality >= 0.4
          ? '中等品質事件脈絡'
          : '低品質事件脈絡'

    return {
      source: 'gdelt_events',
      provider: 'GDELT',
      status: 'ok',
      label,
      date: latest?.publishedAt?.slice(0, 10) ?? null,
      eventCount: rows.length,
      sourceQuality,
      entityConfidence,
      decisionEffect: 'risk_context_only',
      allowedUse: 'shadow_global_event_context',
      events: rows,
      missingReason: null,
    }
  } catch (e) {
    console.warn('[market/risk] gdelt global event context failed', e)
    return {
      source: 'gdelt_events',
      provider: 'GDELT',
      status: 'unavailable',
      label: '尚未匯入',
      date: null,
      eventCount: 0,
      sourceQuality: null,
      entityConfidence: null,
      decisionEffect: 'risk_context_only',
      allowedUse: 'shadow_global_event_context',
      events: [],
      missingReason: 'external_evidence_items_unavailable',
    }
  }
}

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function averageNumbers(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => Number.isFinite(value))
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function scoreFromFearGreedRange(value: number | null, fearAt: number, greedAt: number): number | null {
  if (value == null) return null
  if (fearAt === greedAt) return null
  return clamp100(((value - fearAt) / (greedAt - fearAt)) * 100)
}

function signedPctText(value: number | null, digits = 2): string {
  if (value == null) return '待匯入'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function signedBillionText(value: number | null, digits = 1): string {
  if (value == null) return '待匯入'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}億`
}

function signedContractsText(value: number | null): string {
  if (value == null) return '待匯入'
  return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString('zh-TW')}口`
}

function fearGreedLabel(score: number | null): string {
  if (score == null) return '待匯入'
  if (score < 20) return '極度恐懼'
  if (score < 45) return '恐懼'
  if (score < 55) return '中性'
  if (score < 75) return '貪婪'
  return '極度貪婪'
}

function fearGreedFactor(
  id: string,
  label: string,
  score: number | null,
  value: string,
  source: string,
  detail: string,
) {
  return {
    id,
    label,
    score,
    value,
    status: score == null ? 'missing' : 'ok',
    source,
    detail,
  }
}

function buildFearGreedIndex(args: {
  row: any
  canonicalOverview: any | null
  regimeContext: any | null
  usSignal: any | null
}) {
  const { row, regimeContext, usSignal } = args
  const twiiBias = numberOrNull(row?.twii_bias)
  const pcr = numberOrNull(regimeContext?.putCallRatio)
  const usVix = numberOrNull(row?.vix) ?? numberOrNull(usSignal?.vixClose)
  const twVol20 = numberOrNull(row?.twii_vol20)
  const hySpread = numberOrNull(usSignal?.hySpread)
  const hySpreadChange = numberOrNull(usSignal?.hySpreadChange)
  const dxyReturnPct = usSignal?.dxyReturn == null ? null : numberOrNull(usSignal.dxyReturn)! * 100
  const usdTwdChangePct = numberOrNull(regimeContext?.usdTwdChangePct)
  const gspcReturnPct = usSignal?.gspcReturn == null ? null : numberOrNull(usSignal.gspcReturn)! * 100
  const soxReturnPct = usSignal?.soxReturn == null ? null : numberOrNull(usSignal.soxReturn)! * 100

  const volatilityScore = averageNumbers([
    scoreFromFearGreedRange(usVix, 35, 12),
    scoreFromFearGreedRange(twVol20, 55, 12),
  ])
  const creditScore = averageNumbers([
    scoreFromFearGreedRange(hySpread, 5.5, 2.5),
    scoreFromFearGreedRange(hySpreadChange, 0.35, -0.2),
  ])
  const fxScore = averageNumbers([
    scoreFromFearGreedRange(dxyReturnPct, 1.2, -1.2),
    scoreFromFearGreedRange(usdTwdChangePct, 1.0, -0.8),
  ])
  const globalRiskScore = averageNumbers([
    scoreFromFearGreedRange(gspcReturnPct, -2, 2),
    scoreFromFearGreedRange(soxReturnPct, -4, 4),
  ])

  const factors = [
    fearGreedFactor(
      'market_momentum',
      '市場動能',
      scoreFromFearGreedRange(twiiBias, -6, 6),
      signedPctText(twiiBias),
      'market_risk.twii_bias',
      '加權指數相對 20MA；越強代表風險偏好越高。',
    ),
    fearGreedFactor(
      'options_positioning',
      '選擇權情緒',
      scoreFromFearGreedRange(pcr, 1.4, 0.6),
      pcr == null ? '待匯入' : pcr.toFixed(2),
      'canonical_regime_context_daily.tw_option_put_call_ratio',
      '賣買權量比越高通常代表避險需求越強。',
    ),
    fearGreedFactor(
      'volatility_pressure',
      '波動壓力',
      volatilityScore == null ? null : clamp100(volatilityScore),
      usVix == null ? '待匯入' : `VIX ${usVix.toFixed(2)} / 台股波動 ${twVol20 == null ? '--' : `${twVol20.toFixed(2)}%`}`,
      'market_risk.vix_twii_vol20 / us_market_signals.vix_close',
      '隱含波動與台股實現波動越高，分數越偏恐懼。',
    ),
    fearGreedFactor(
      'credit_stress',
      '信用風險',
      creditScore == null ? null : clamp100(creditScore),
      hySpread == null ? '待匯入' : `高收益債利差 ${hySpread.toFixed(2)}%`,
      'us_market_signals.hy_spread',
      '信用利差擴大通常代表市場風險承受度下降。',
    ),
    fearGreedFactor(
      'safe_haven_fx',
      '避險匯率',
      fxScore == null ? null : clamp100(fxScore),
      dxyReturnPct == null ? '待匯入' : `美元指數 ${signedPctText(dxyReturnPct)}`,
      'us_market_signals.dxy_return / canonical_regime_context_daily.world_index',
      '美元與美元兌台幣走強通常代表避險需求上升。',
    ),
    fearGreedFactor(
      'global_risk_appetite',
      '全球風險偏好',
      globalRiskScore == null ? null : clamp100(globalRiskScore),
      gspcReturnPct == null ? '待匯入' : `S&P 500 ${signedPctText(gspcReturnPct)} / SOX ${soxReturnPct == null ? '--' : signedPctText(soxReturnPct)}`,
      'us_market_signals.gspc_return_sox_return',
      '美股與半導體風險偏好會外溢到台股。',
    ),
  ]
  const score = averageNumbers(factors.map((factor) => factor.score))
  const rounded = score == null ? null : clamp100(score)

  return {
    schemaVersion: 'stockvision_fear_greed_v4',
    date: row?.date ?? null,
    score: rounded,
    label: fearGreedLabel(rounded),
    source: 'StockVision composite: price momentum, options positioning, volatility, credit, safe-haven FX, global equity appetite',
    methodology: '0=恐懼、100=貪婪；有效因子等權平均，缺資料因子不硬補；不納入景氣燈號、法人買賣超、期貨大戶部位，避免混入非核心或避險情緒因子。',
    factors,
    missingFactors: factors.filter((factor) => factor.score == null).map((factor) => factor.id),
  }
}

function buildHedgeSentimentFactors(args: {
  row: any
  regimeContext: any | null
  usSignal: any | null
}) {
  const { row, regimeContext, usSignal } = args
  const foreignNet5d = numberOrNull(row?.foreign_net_5d)
  const largeTraderNet = numberOrNull(regimeContext?.largeTraderNet)
  const pcr = numberOrNull(regimeContext?.putCallRatio)
  const twVol20 = numberOrNull(row?.twii_vol20)
  const usVix = numberOrNull(row?.vix) ?? numberOrNull(usSignal?.vixClose)
  const hySpread = numberOrNull(usSignal?.hySpread)
  const dxyReturnPct = usSignal?.dxyReturn == null ? null : numberOrNull(usSignal.dxyReturn)! * 100
  const usdTwd = numberOrNull(regimeContext?.usdTwd)
  const usdTwdChangePct = numberOrNull(regimeContext?.usdTwdChangePct)

  return [
    {
      id: 'foreign_net_5d',
      label: '外資5日買賣超',
      value: signedBillionText(foreignNet5d),
      raw_value: foreignNet5d,
      source: 'market_risk.foreign_net_5d',
      detail: '外資連續買超代表風險偏好較強；賣超代表籌碼壓力。',
    },
    {
      id: 'large_trader_net',
      label: '大戶前五淨部位',
      value: signedContractsText(largeTraderNet),
      raw_value: largeTraderNet,
      source: 'canonical_regime_context_daily.tw_taifex_futures_large_trader',
      detail: '臺股期貨 TX+MTX/4+TMF/20 口徑；前五大交易人買方部位減賣方部位。',
    },
    {
      id: 'put_call_ratio',
      label: '賣買權量比',
      value: pcr == null ? '待匯入' : pcr.toFixed(2),
      raw_value: pcr,
      source: 'canonical_regime_context_daily.tw_option_put_call_ratio',
      detail: '賣權相對買權越高，代表避險需求越強。',
    },
    {
      id: 'twii_vol20',
      label: '台股波動率',
      value: twVol20 == null ? '待匯入' : `${twVol20.toFixed(2)}%`,
      raw_value: twVol20,
      source: 'market_risk.twii_vol20',
      detail: '加權指數 20 日實現波動率；越高代表市場震盪越大。',
    },
    {
      id: 'us_vix',
      label: '美股 VIX',
      value: usVix == null ? '待匯入' : usVix.toFixed(2),
      raw_value: usVix,
      source: 'market_risk.vix / us_market_signals.vix_close',
      detail: 'S&P 500 選擇權隱含波動，常作為全球避險壓力 proxy。',
    },
    {
      id: 'hy_spread',
      label: '高收益債利差',
      value: hySpread == null ? '待匯入' : `${hySpread.toFixed(2)}%`,
      raw_value: hySpread,
      source: 'us_market_signals.hy_spread',
      detail: '信用利差擴大通常代表市場要求更高風險補償。',
    },
    {
      id: 'dxy_return',
      label: '美元指數變動',
      value: signedPctText(dxyReturnPct),
      raw_value: dxyReturnPct,
      source: 'us_market_signals.dxy_return',
      detail: '美元走強常見於全球資金轉向避險。',
    },
    {
      id: 'usd_twd',
      label: '美元兌台幣',
      value: usdTwd == null ? '待匯入' : usdTwd.toFixed(3),
      raw_value: usdTwd,
      source: 'canonical_regime_context_daily.world_index',
      detail: usdTwdChangePct == null ? '匯率避險因子。' : `日變動 ${signedPctText(usdTwdChangePct)}；台幣轉弱通常代表風險偏好下降。`,
    },
  ]
}

function hedgeSentimentLabel(score: number | null): string {
  if (score == null) return '待匯入'
  if (score >= 70) return '偏高避險'
  if (score >= 46) return '中高避險'
  if (score >= 28) return '中性避險'
  return '低避險'
}

function buildHedgeSentiment(args: {
  row: any
  regimeContext: any | null
  usSignal: any | null
  factors: any[]
}) {
  const { row, regimeContext, usSignal, factors } = args
  const foreignNet5d = numberOrNull(row?.foreign_net_5d)
  const largeTraderNet = numberOrNull(regimeContext?.largeTraderNet)
  const pcr = numberOrNull(regimeContext?.putCallRatio)
  const twVol20 = numberOrNull(row?.twii_vol20)
  const usVix = numberOrNull(row?.vix) ?? numberOrNull(usSignal?.vixClose)
  const hySpread = numberOrNull(usSignal?.hySpread)
  const hySpreadChange = numberOrNull(usSignal?.hySpreadChange)
  const dxyReturnPct = usSignal?.dxyReturn == null ? null : numberOrNull(usSignal.dxyReturn)! * 100
  const usdTwdChangePct = numberOrNull(regimeContext?.usdTwdChangePct)
  const score = averageNumbers([
    scoreFromFearGreedRange(pcr, 0.6, 1.4),
    scoreFromFearGreedRange(largeTraderNet, 6000, -6000),
    scoreFromFearGreedRange(foreignNet5d, 3500, -3500),
    scoreFromFearGreedRange(twVol20, 12, 55),
    scoreFromFearGreedRange(usVix, 12, 35),
    scoreFromFearGreedRange(hySpread, 2.5, 5.5),
    scoreFromFearGreedRange(hySpreadChange, -0.2, 0.35),
    scoreFromFearGreedRange(dxyReturnPct, -1.2, 1.2),
    scoreFromFearGreedRange(usdTwdChangePct, -0.8, 1.0),
  ])
  const rounded = score == null ? null : clamp100(score)

  return {
    schemaVersion: 'stockvision_hedge_sentiment_v1',
    date: row?.date ?? null,
    score: rounded,
    label: hedgeSentimentLabel(rounded),
    source: 'StockVision composite hedge sentiment',
    methodology: '0=低避險、100=高避險；PCR、大戶淨部位、外資5日流、台股/美股波動、信用利差、美元避險壓力有效因子等權平均；不納入景氣燈號或新聞事件主觀判讀。',
    factors,
  }
}

function cycleSignalLabel(score: number | null): string {
  if (score == null) return '待匯入'
  if (score <= 16) return '藍燈'
  if (score <= 22) return '黃藍燈'
  if (score <= 31) return '綠燈'
  if (score <= 37) return '黃紅燈'
  return '紅燈'
}

function businessCycleFromFactorPacket(factorPacket: any, fallbackDate: string) {
  const factors = Array.isArray(factorPacket?.factors) ? factorPacket.factors : []
  const businessFactor = factors.find((item: any) => (
    String(item?.id ?? '').toLowerCase().includes('breadth')
    || String(item?.label ?? '').includes('景氣對策')
    || String(item?.source ?? '').includes('tw_business_indicators')
  ))
  const rawScore = numberOrNull(businessFactor?.raw_value)
    ?? numberOrNull(String(businessFactor?.value ?? '').match(/-?\d+(?:\.\d+)?/)?.[0])
  const sourceDate = String(businessFactor?.source_date ?? fallbackDate ?? '').slice(0, 10)
  if (rawScore == null) {
    return {
      source: 'finlab.tw_business_indicators',
      status: 'finlab_not_materialized',
      months: [],
    }
  }
  return {
    source: businessFactor?.source ?? 'finlab.tw_business_indicators',
    status: 'ok',
    latest: {
      month: sourceDate ? sourceDate.slice(0, 7) : String(fallbackDate).slice(0, 7),
      score: rawScore,
      label: cycleSignalLabel(rawScore),
      sourceDate: sourceDate || null,
    },
    months: [{
      month: sourceDate ? sourceDate.slice(0, 7) : String(fallbackDate).slice(0, 7),
      score: rawScore,
      label: cycleSignalLabel(rawScore),
      sourceDate: sourceDate || null,
    }],
  }
}

type CanonicalRegimeContextRow = {
  date: string
  dataset: string
  field: string
  category: string
  value: number | null
  textValue: string | null
  source: string
}

function contextLabelValue(row: CanonicalRegimeContextRow | null, fallback = 'n/a') {
  if (!row) return fallback
  if (row.value != null) return Number.isInteger(row.value) ? String(row.value) : String(Math.round(row.value * 1000) / 1000)
  return row.textValue ?? fallback
}

function pickContextRow(rows: CanonicalRegimeContextRow[], patterns: RegExp[]) {
  return rows.find((row) => patterns.some((pattern) => pattern.test(`${row.field} ${row.category}`))) ?? rows[0] ?? null
}

function latestContextRows(rows: CanonicalRegimeContextRow[]) {
  const latestDate = rows.map((row) => row.date).sort().at(-1)
  return latestDate ? rows.filter((row) => row.date === latestDate) : []
}

function derivedContextRow(
  base: CanonicalRegimeContextRow,
  field: string,
  value: number,
): CanonicalRegimeContextRow {
  return {
    ...base,
    field,
    value,
    textValue: null,
  }
}

function derivePutCallVolumeRatio(rows: CanonicalRegimeContextRow[]): CanonicalRegimeContextRow | null {
  const latestRows = latestContextRows(rows)
  const ratio = latestRows.find((row) => /買賣權成交量比率|賣買權成交量比率|put.*call.*volume/i.test(row.field) && row.value != null)
  if (ratio?.value != null) {
    const normalized = ratio.value > 10 ? ratio.value / 100 : ratio.value
    return derivedContextRow(ratio, '賣買權量比', Math.round(normalized * 1000) / 1000)
  }
  const putVolume = latestRows.find((row) => /賣權成交量|put.*volume/i.test(row.field) && row.value != null)
  const callVolume = latestRows.find((row) => /買權成交量|call.*volume/i.test(row.field) && row.value != null)
  if (putVolume?.value != null && callVolume?.value) {
    return derivedContextRow(putVolume, '賣買權量比', Math.round((putVolume.value / callVolume.value) * 1000) / 1000)
  }
  return null
}

function deriveLargeTraderNet(rows: CanonicalRegimeContextRow[]): CanonicalRegimeContextRow | null {
  const latestRows = latestContextRows(rows)
  const indexRows = latestRows.filter((row) => /臺股期貨|台股期貨|TX\+MTX|台指|臺指/i.test(row.category))
  const scopedRows = indexRows.length ? indexRows : latestRows
  const buyTop5 = scopedRows.find((row) => /買方前五大交易人部位數/.test(row.field) && row.value != null)
  const sellTop5 = scopedRows.find((row) => /賣方前五大交易人部位數/.test(row.field) && row.value != null)
  if (buyTop5?.value != null && sellTop5?.value != null) {
    return derivedContextRow(buyTop5, '前五大交易人淨部位', Math.round(buyTop5.value - sellTop5.value))
  }
  const buyTop10 = scopedRows.find((row) => /買方前十大交易人部位數/.test(row.field) && row.value != null)
  const sellTop10 = scopedRows.find((row) => /賣方前十大交易人部位數/.test(row.field) && row.value != null)
  if (buyTop10?.value != null && sellTop10?.value != null) {
    return derivedContextRow(buyTop10, '前十大交易人淨部位', Math.round(buyTop10.value - sellTop10.value))
  }
  return null
}

function contextFactor(
  id: string,
  label: string,
  row: CanonicalRegimeContextRow | null,
  status: 'ok' | 'warn' | 'error' | 'info' | 'missing' = 'info',
) {
  return {
    id,
    label,
    value: contextLabelValue(row),
    raw_value: row?.value ?? null,
    status: row ? status : 'missing',
    source: row?.source ?? 'canonical_regime_context_daily',
    source_date: row?.date ?? null,
    detail: row ? `${row.dataset}.${row.field}.${row.category}` : 'not_materialized',
  }
}

async function loadCanonicalRegimeContext(db: D1Database) {
  try {
    const { results } = await db.prepare(
      `SELECT date, dataset, field, category, value, text_value, source
       FROM canonical_regime_context_daily
       WHERE dataset IN (
         'tw_business_indicators',
         'tw_option_put_call_ratio',
         'tw_taifex_futures_large_trader',
         'tw_taifex_option_large_trader',
         'world_index',
         'margin_context'
       )
       AND (
         dataset NOT IN ('tw_taifex_futures_large_trader', 'tw_taifex_option_large_trader')
         OR category LIKE '%臺股期貨%'
         OR category LIKE '%台股期貨%'
         OR category LIKE '%TX+MTX%'
         OR category LIKE '%台指%'
         OR category LIKE '%臺指%'
       )
       ORDER BY date DESC
       LIMIT 720`
    ).all<any>()
    const rows: CanonicalRegimeContextRow[] = (results ?? [])
      .map((row: any) => ({
        date: String(row.date ?? '').slice(0, 10),
        dataset: String(row.dataset ?? ''),
        field: String(row.field ?? ''),
        category: String(row.category ?? 'market'),
        value: numberOrNull(row.value),
        textValue: row.text_value == null ? null : String(row.text_value),
        source: String(row.source ?? 'canonical_regime_context_daily'),
      }))
      .filter((row) => row.date && row.dataset)

    const pcrRows = rows.filter((row) => row.dataset === 'tw_option_put_call_ratio' && row.value != null)
    const largeRows = rows.filter((row) => row.dataset === 'tw_taifex_futures_large_trader' && row.value != null)
    const businessRows = rows
      .filter((row) => row.dataset === 'tw_business_indicators' && row.value != null)
      .filter((row) => row.field === 'business_signal_score' || /景氣|signal/i.test(`${row.field} ${row.category}`))
    const usdRows = rows
      .filter((row) => row.dataset === 'world_index' && row.value != null)
      .filter((row) => /usd|twd|美元|台幣|匯率/i.test(`${row.field} ${row.category}`))
    const pcr = derivePutCallVolumeRatio(pcrRows) ?? pickContextRow(pcrRows, [/pcr/i, /put.*call/i, /ratio/i, /賣買權|買賣權|賣權.*買權/])
    const largeTrader = deriveLargeTraderNet(largeRows) ?? pickContextRow(largeRows, [/net/i, /淨|部位|大戶|未平倉/])
    const usdTwd = pickContextRow(usdRows, [/usd.*twd/i, /twd.*usd/i, /美元|台幣|匯率/])
    const usdPrevious = usdTwd
      ? usdRows.find((row) => row.field === usdTwd.field && row.category === usdTwd.category && row.date < usdTwd.date) ?? null
      : null
    const latestBusiness = businessRows[0] ?? null
    const businessMonths = businessRows
      .slice(0, 6)
      .map((row) => ({
        month: row.date.slice(0, 7),
        score: row.value,
        label: cycleSignalLabel(row.value),
        sourceDate: row.date,
      }))
      .reverse()

    const factors = [
      contextFactor('put_call_ratio', '賣買權量比', pcr, 'info'),
      contextFactor('large_trader_net', '大戶前五淨部位', largeTrader, (largeTrader?.value ?? 0) < 0 ? 'warn' : 'info'),
      contextFactor('usd_twd', '美元兌台幣', usdTwd, 'info'),
    ]

    return {
      source: 'canonical_regime_context_daily',
      putCallRatio: pcr?.value ?? null,
      largeTraderNet: largeTrader?.value ?? null,
      usdTwd: usdTwd?.value ?? null,
      usdTwdChangePct: percentChange(usdTwd?.value ?? null, usdPrevious?.value ?? null),
      fxStatus: usdTwd?.value == null ? null : '穩定',
      businessCycle: latestBusiness ? {
        source: latestBusiness.source,
        status: 'ok',
        latest: {
          month: latestBusiness.date.slice(0, 7),
          score: latestBusiness.value,
          label: cycleSignalLabel(latestBusiness.value),
          sourceDate: latestBusiness.date,
        },
        months: businessMonths,
      } : null,
      factors,
      missing: {
        putCallRatio: pcr == null,
        largeTraderNet: largeTrader == null,
        usdTwd: usdTwd == null,
        businessSignal: latestBusiness == null,
      },
    }
  } catch (e) {
    console.warn('[market/risk] canonical_regime_context_daily failed', e)
    return null
  }
}

async function loadMarketRiskDetailBreakdown(db: D1Database) {
  const [liquidity, chipPressure, regime] = await Promise.all([
    loadCanonicalLiquidityDetail(db),
    loadCanonicalChipPressureDetail(db),
    loadCanonicalRegimeRiskDetail(db),
  ])

  if (!liquidity && !chipPressure && !regime) return null
  return {
    schemaVersion: 'market_risk_detail_breakdown_v1',
    liquidity,
    chipPressure,
    regime,
  }
}

async function loadCanonicalLiquidityDetail(db: D1Database) {
  try {
    const row = await db.prepare(
      `WITH latest_date AS (
         SELECT MAX(date) AS date
         FROM canonical_market_daily
         WHERE market_segment = 'LISTED_OTC'
       )
       SELECT
         (SELECT date FROM latest_date) AS date,
         SUM(COALESCE(value, 0)) AS turnover_amount,
         SUM(COALESCE(market_value, 0)) AS market_value,
         SUM(COALESCE(trade_count, 0)) AS trade_count,
         COALESCE(
           SUM(CASE
             WHEN close > 0 AND last_ask_price IS NOT NULL AND last_bid_price IS NOT NULL AND last_ask_price >= last_bid_price
             THEN ((last_ask_price - last_bid_price) / close) * 10000.0 * COALESCE(value, 0)
             ELSE 0
           END) / NULLIF(SUM(CASE
             WHEN close > 0 AND last_ask_price IS NOT NULL AND last_bid_price IS NOT NULL AND last_ask_price >= last_bid_price
             THEN COALESCE(value, 0)
             ELSE 0
           END), 0),
           AVG(CASE
             WHEN close > 0 AND last_ask_price IS NOT NULL AND last_bid_price IS NOT NULL AND last_ask_price >= last_bid_price
             THEN ((last_ask_price - last_bid_price) / close) * 10000.0
             ELSE NULL
           END)
         ) AS bid_ask_spread_bps,
         100.0 * SUM(CASE WHEN adj_close IS NOT NULL THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS adjusted_ohlc_coverage_pct,
         COUNT(*) AS coverage_count,
         SUM(CASE WHEN last_ask_price IS NOT NULL AND last_bid_price IS NOT NULL THEN 1 ELSE 0 END) AS quote_coverage_count
       FROM canonical_market_daily
       WHERE date = (SELECT date FROM latest_date)
         AND market_segment = 'LISTED_OTC'`
    ).first<any>()
    if (!row?.date) return null
    return {
      date: row.date,
      turnoverAmount: numberOrNull(row.turnover_amount),
      marketValue: numberOrNull(row.market_value),
      tradeCount: numberOrNull(row.trade_count),
      bidAskSpreadBps: numberOrNull(row.bid_ask_spread_bps),
      adjustedOhlcCoveragePct: numberOrNull(row.adjusted_ohlc_coverage_pct),
      coverageCount: numberOrNull(row.coverage_count),
      quoteCoverageCount: numberOrNull(row.quote_coverage_count),
      source: 'canonical_market_daily.finlab.price',
    }
  } catch (e) {
    console.warn('[market/risk] canonical liquidity detail failed', e)
    return null
  }
}

async function loadCanonicalChipPressureDetail(db: D1Database) {
  try {
    const row = await db.prepare(
      `WITH latest_date AS (
         SELECT MAX(date) AS date
         FROM canonical_chip_daily
         WHERE market_segment = 'LISTED_OTC'
       )
       SELECT
         (SELECT date FROM latest_date) AS date,
         COALESCE(
           100.0 * SUM(COALESCE(margin_balance, 0)) / NULLIF(SUM(COALESCE(margin_limit, 0)), 0),
           AVG(margin_usage_ratio)
         ) AS margin_usage_ratio,
         COALESCE(
           100.0 * SUM(COALESCE(short_balance, 0)) / NULLIF(SUM(COALESCE(short_limit, 0)), 0),
           AVG(short_usage_ratio)
         ) AS short_usage_ratio,
         SUM(COALESCE(margin_balance, 0)) AS margin_balance,
         SUM(COALESCE(margin_limit, 0)) AS margin_limit,
         SUM(COALESCE(short_balance, 0)) AS short_balance,
         SUM(COALESCE(short_limit, 0)) AS short_limit,
         SUM(COALESCE(security_lending_sell_balance, 0)) / 1000.0 AS security_lending_sell_balance,
         AVG(broker_balance_index) AS broker_balance_index,
         AVG(broker_buy_sell_ratio) AS broker_buy_sell_ratio,
         SUM(COALESCE(foreign_buy, 0)) AS foreign_buy,
         SUM(COALESCE(foreign_sell, 0)) AS foreign_sell,
         SUM(COALESCE(trust_buy, 0)) AS trust_buy,
         SUM(COALESCE(trust_sell, 0)) AS trust_sell,
         SUM(COALESCE(dealer_buy, 0)) AS dealer_buy,
         SUM(COALESCE(dealer_sell, 0)) AS dealer_sell,
         COUNT(*) AS coverage_count
       FROM canonical_chip_daily
       WHERE date = (SELECT date FROM latest_date)
         AND market_segment = 'LISTED_OTC'
         AND LOWER(COALESCE(stock_id, '')) NOT IN ('', 'nan', 'none', 'null')
         AND stock_id NOT LIKE '%.%'`
    ).first<any>()
    if (!row?.date) return null
    return {
      date: row.date,
      marginUsageRatio: numberOrNull(row.margin_usage_ratio),
      shortUsageRatio: numberOrNull(row.short_usage_ratio),
      marginBalance: numberOrNull(row.margin_balance),
      marginLimit: numberOrNull(row.margin_limit),
      shortBalance: numberOrNull(row.short_balance),
      shortLimit: numberOrNull(row.short_limit),
      securityLendingSellBalance: numberOrNull(row.security_lending_sell_balance),
      brokerBalanceIndex: numberOrNull(row.broker_balance_index),
      brokerBuySellRatio: numberOrNull(row.broker_buy_sell_ratio),
      foreignBuy: numberOrNull(row.foreign_buy),
      foreignSell: numberOrNull(row.foreign_sell),
      trustBuy: numberOrNull(row.trust_buy),
      trustSell: numberOrNull(row.trust_sell),
      dealerBuy: numberOrNull(row.dealer_buy),
      dealerSell: numberOrNull(row.dealer_sell),
      coverageCount: numberOrNull(row.coverage_count),
      source: 'canonical_chip_daily.finlab.chip_diversity',
    }
  } catch (e) {
    console.warn('[market/risk] canonical chip pressure detail failed', e)
    return null
  }
}

async function loadCanonicalRegimeRiskDetail(db: D1Database) {
  try {
    const [futuresRows, worldRow] = await Promise.all([
      db.prepare(
        `WITH latest_date AS (
           SELECT MAX(date) AS date
           FROM canonical_regime_context_daily
           WHERE dataset = 'futures_institutional_investors_trading_summary'
         ),
         tx_categories AS (
           SELECT 'dealer' AS participant_id, '自營商' AS label, '臺股期貨_自營商' AS category
           UNION ALL SELECT 'trust', '投信', '臺股期貨_投信'
           UNION ALL SELECT 'foreign', '外資', '臺股期貨_外資及陸資'
         )
         SELECT
           (SELECT date FROM latest_date) AS date,
           tx.participant_id,
           tx.label,
           tx.category,
           SUM(CASE WHEN c.field = 'futures_inst_net_trade_lots' THEN c.value ELSE 0 END) AS futures_inst_net_trade_lots,
           SUM(CASE WHEN c.field = 'futures_inst_net_oi_lots' THEN c.value ELSE 0 END) AS futures_inst_net_oi_lots,
           SUM(CASE WHEN c.field = 'futures_inst_net_trade_amount_k' THEN c.value ELSE 0 END) AS futures_inst_net_trade_amount_k,
           SUM(CASE WHEN c.field = 'futures_inst_net_oi_amount_k' THEN c.value ELSE 0 END) AS futures_inst_net_oi_amount_k,
           COUNT(c.field) AS coverage_count
         FROM tx_categories tx
         LEFT JOIN canonical_regime_context_daily c
           ON c.date = (SELECT date FROM latest_date)
          AND c.dataset = 'futures_institutional_investors_trading_summary'
          AND c.category = tx.category
          AND c.field IN (
             'futures_inst_net_trade_lots',
             'futures_inst_net_oi_lots',
             'futures_inst_net_trade_amount_k',
             'futures_inst_net_oi_amount_k'
           )
         GROUP BY tx.participant_id, tx.label, tx.category
         ORDER BY CASE tx.participant_id WHEN 'dealer' THEN 1 WHEN 'trust' THEN 2 WHEN 'foreign' THEN 3 ELSE 4 END`
      ).all<any>(),
      db.prepare(
        `WITH latest_date AS (
           SELECT MAX(date) AS date
           FROM canonical_regime_context_daily
           WHERE dataset = 'world_index'
             AND field = 'world_adj_close'
         ),
         previous_date AS (
           SELECT MAX(date) AS date
           FROM canonical_regime_context_daily
           WHERE dataset = 'world_index'
             AND field = 'world_adj_close'
             AND date < (SELECT date FROM latest_date)
         )
         SELECT
           (SELECT date FROM latest_date) AS date,
           AVG(CASE
             WHEN prev.value IS NOT NULL AND prev.value != 0
             THEN ((cur.value - prev.value) / prev.value) * 100.0
             ELSE NULL
           END) AS world_adj_close_change_pct,
           COUNT(*) AS world_index_count
         FROM canonical_regime_context_daily cur
         LEFT JOIN canonical_regime_context_daily prev
           ON prev.dataset = cur.dataset
          AND prev.field = cur.field
          AND prev.category = cur.category
          AND prev.date = (SELECT date FROM previous_date)
         WHERE cur.date = (SELECT date FROM latest_date)
           AND cur.dataset = 'world_index'
           AND cur.field = 'world_adj_close'`
      ).first<any>(),
    ])
    const participantRows = (futuresRows?.results ?? []).map((row: any) => ({
      id: String(row.participant_id ?? ''),
      label: String(row.label ?? ''),
      category: String(row.category ?? ''),
      netTradeLots: numberOrNull(row.futures_inst_net_trade_lots) ?? 0,
      netOiLots: numberOrNull(row.futures_inst_net_oi_lots) ?? 0,
      netTradeAmountK: numberOrNull(row.futures_inst_net_trade_amount_k) ?? 0,
      netOiAmountK: numberOrNull(row.futures_inst_net_oi_amount_k) ?? 0,
      coverageCount: numberOrNull(row.coverage_count) ?? 0,
      date: row.date ?? null,
    })).filter((row) => row.id && row.label)
    const totalRow = participantRows.reduce((acc, row) => ({
      ...acc,
      netTradeLots: acc.netTradeLots + row.netTradeLots,
      netOiLots: acc.netOiLots + row.netOiLots,
      netTradeAmountK: acc.netTradeAmountK + row.netTradeAmountK,
      netOiAmountK: acc.netOiAmountK + row.netOiAmountK,
      coverageCount: acc.coverageCount + row.coverageCount,
    }), {
      id: 'total',
      label: '合計',
      category: '臺股期貨_三大法人合計',
      netTradeLots: 0,
      netOiLots: 0,
      netTradeAmountK: 0,
      netOiAmountK: 0,
      coverageCount: 0,
      date: participantRows.find((row) => row.date)?.date ?? null,
    })
    const futuresBreakdown = [...participantRows, totalRow]
    if (!totalRow.date && !worldRow?.date) return null
    return {
      date: totalRow.date ?? worldRow?.date ?? null,
      futuresInstNetTradeLots: totalRow.netTradeLots,
      futuresInstNetOiLots: totalRow.netOiLots,
      futuresInstNetTradeAmountK: totalRow.netTradeAmountK,
      futuresInstNetOiAmountK: totalRow.netOiAmountK,
      futuresInstitutionalBreakdown: futuresBreakdown,
      worldAdjCloseChangePct: numberOrNull(worldRow?.world_adj_close_change_pct),
      coverageCount: totalRow.coverageCount,
      worldIndexCount: numberOrNull(worldRow?.world_index_count),
      source: 'canonical_regime_context_daily.finlab',
    }
  } catch (e) {
    console.warn('[market/risk] canonical regime risk detail failed', e)
    return null
  }
}

market.get('/indices', async (c) => {
  const data = await withCache(c.env.KV, 'market:indices:finlab-clean:v12-twii-finlab-first', async () => {
    const [finlabTwii, finlabTwoii, finlabTxfDay, finlabTxfNight, taifexDay, taifexNight, marketRiskTwii, twseOfficialTwii] = await Promise.all([
      loadFinlabSeries(c.env.DB, 'TWII', '加權指數', [
        {
          sql: 'SELECT date, close FROM canonical_market_index_daily WHERE symbol IN (?, ?) AND close > 1000 AND close < 100000 ORDER BY date DESC LIMIT 30',
          binds: ['TWII', 'TAIEX'],
          source: 'FinLab canonical_market_index_daily',
        },
        {
          sql: 'SELECT date, close FROM market_index_daily WHERE symbol IN (?, ?) AND close > 1000 AND close < 100000 ORDER BY date DESC LIMIT 30',
          binds: ['TWII', 'TAIEX'],
          source: 'FinLab market_index_daily',
        },
      ]),
      loadFinlabSeries(c.env.DB, 'TWOII', '櫃買指數', [
        {
          sql: 'SELECT date, close FROM canonical_market_index_daily WHERE symbol IN (?, ?, ?) AND close > 10 AND close < 10000 ORDER BY date DESC LIMIT 30',
          binds: ['TWOII', 'OTC', 'TPEX'],
          source: 'FinLab canonical_market_index_daily',
        },
        {
          sql: 'SELECT date, close FROM market_index_daily WHERE symbol IN (?, ?, ?) ORDER BY date DESC LIMIT 30',
          binds: ['TWOII', 'OTC', 'TPEX'],
          source: 'FinLab market_index_daily',
        },
        {
          sql: 'SELECT date, close FROM finlab_tw_stock_market_ind WHERE symbol IN (?, ?, ?) ORDER BY date DESC LIMIT 30',
          binds: ['TWOII', 'OTC', 'TPEX'],
          source: 'FinLab etl:finlab_tw_stock_market_ind',
        },
      ]),
      loadFinlabSeries(c.env.DB, 'TXF', '台指期貨', [
        {
          sql: "SELECT date, close FROM canonical_futures_daily WHERE symbol IN (?, ?) AND session = 'day' AND close > 1000 ORDER BY date DESC, contract_month ASC LIMIT 30",
          binds: ['TXF', 'TX'],
          source: 'FinLab canonical_futures_daily',
        },
        {
          sql: 'SELECT date, close FROM finlab_futures_price WHERE symbol IN (?, ?) ORDER BY date DESC LIMIT 30',
          binds: ['TXF', 'TX'],
          source: 'FinLab futures_price',
        },
        {
          sql: 'SELECT date, "收盤價" AS close FROM futures_price WHERE symbol IN (?, ?) ORDER BY date DESC LIMIT 30',
          binds: ['TXF', 'TX'],
          source: 'FinLab futures_price:收盤價',
        },
        {
          sql: 'SELECT date, close FROM futures_price WHERE symbol IN (?, ?) ORDER BY date DESC LIMIT 30',
          binds: ['TXF', 'TX'],
          source: 'FinLab futures_price',
        },
      ]),
      loadFinlabSeries(c.env.DB, 'TXF', '台指期貨夜盤', [
        {
          sql: "SELECT date, close FROM canonical_futures_daily WHERE symbol IN (?, ?) AND session = 'night' AND close > 1000 ORDER BY date DESC, contract_month ASC LIMIT 30",
          binds: ['TXF', 'TX'],
          source: 'FinLab canonical_futures_daily night',
        },
      ]),
      fetchTaifexDayClose().catch(() => null),
      fetchTaifexNightClose().catch(() => null),
      loadMarketRiskTwiiSeries(c.env.DB),
      fetchTwseTaiexOfficialSeries(),
    ])
    const taifexDaySnapshot = taifexDay ? {
      symbol: 'TXF',
      name: '台指期貨',
      current: Math.round(taifexDay.lastPrice * 100) / 100,
      change: Math.round(taifexDay.changePoints * 100) / 100,
      changePct: Math.round(taifexDay.changePct * 100) / 100,
      date: taifexDay.date,
      time: taifexDay.time,
      source: 'TAIFEX MIS day session',
      status: 'ok',
      history: [],
    } : null
    const twii = hasMarketSeriesData(finlabTwii)
      ? finlabTwii
      : hasMarketSeriesData(marketRiskTwii)
        ? marketRiskTwii
        : twseOfficialTwii
    const twoii = hasMarketSeriesData(finlabTwoii)
      ? finlabTwoii
      : missingMaterializationSnapshot('TWOII', '櫃買指數', 'FinLab canonical_market_index_daily not materialized by GCP backfill')
    const bestTxfDay = chooseBestMarketSeries(finlabTxfDay, taifexDaySnapshot ? [taifexDaySnapshot] : [])
    const txfDay = hasMarketSeriesData(bestTxfDay)
      ? bestTxfDay
      : missingMaterializationSnapshot('TXF', '台指期貨', 'FinLab futures_price not materialized')
    const taifexNightSnapshot = taifexNight ? {
      symbol: 'TXF',
      name: '台指期貨夜盤',
      current: Math.round(taifexNight.lastPrice * 100) / 100,
      change: Math.round(taifexNight.changePoints * 100) / 100,
      changePct: Math.round(taifexNight.changePct * 100) / 100,
      date: taifexNight.date,
      time: taifexNight.time,
      source: 'TAIFEX MIS',
      status: 'ok',
      history: [],
    } : null
    const bestTxfNight = chooseBestMarketSeries(finlabTxfNight, taifexNightSnapshot ? [taifexNightSnapshot] : [])
    const txfNight = hasMarketSeriesData(bestTxfNight)
      ? bestTxfNight
      : missingMaterializationSnapshot('TXF', '台指期貨夜盤', 'FinLab canonical_futures_daily night / TAIFEX MIS')
    return {
      twii,
      twoii,
      txfDay,
      txfNight,
      futuresSources: {
        finlabDaily: ['futures_price', 'canonical_futures_daily.day', 'canonical_futures_daily.night', 'futures_institutional_investors_trading_summary', 'tw_taifex_futures_large_trader'],
        liveDayFallback: taifexDay ? 'TAIFEX MIS fetchTaifexDayClose' : null,
        liveNight: taifexNightSnapshot ? 'TAIFEX MIS fetchTaifexNightClose' : null,
        canonicalNightFallback: hasMarketSeriesData(finlabTxfNight) ? 'FinLab canonical_futures_daily night' : null,
        dahuApiConfigured: false,
      },
      updatedAt: new Date().toISOString(),
    }
  }, TTL.MARKET)
  return c.json(data)
})

market.get('/news', async (c) => {
  const limitPerSource = Math.min(parsePosInt(c.req.query('perSource'), 3), 6)
  const data = await withCache(c.env.KV, `market:news:v5:cnyes-stock-filter:${limitPerSource}`, async () => {
    const feeds = [
      { source: '經濟日報', url: 'https://money.udn.com/rssfeed/news/1001/5591' },
      { source: '經濟日報', url: 'https://money.udn.com/rssfeed/news/1001/5588' },
    ]
    const [rssGroups, cnyesRows] = await Promise.all([
      Promise.all(feeds.map(async (feed) => {
        try {
          const res = await fetch(feed.url, {
            headers: {
              Accept: 'application/rss+xml, application/xml, text/xml',
              'User-Agent': 'StockVisionBot/1.0 (+https://stockvision)',
            },
          })
          if (!res.ok) throw new Error(`rss_http_${res.status}`)
          return parseRssItems(await res.text(), feed.source, limitPerSource * 10)
            .filter(isStockMarketNews)
            .slice(0, limitPerSource)
        } catch (e) {
          console.warn(`[market/news] RSS failed ${feed.url}:`, e)
          return []
        }
      })),
      fetchCnyesStockNews(limitPerSource),
    ])

    const d1Rows = await c.env.DB.prepare(`
      SELECT source, title, url, published_at, summary
      FROM news
      WHERE published_at >= datetime('now', '-10 days')
      ORDER BY published_at DESC
      LIMIT 120
    `).all<any>().catch(() => ({ results: [] as any[] }))

    const bySource = new Map<string, any[]>()
    for (const row of d1Rows.results ?? []) {
      const source = String(row.source || 'StockVision').trim()
      if (/經濟日報|money\s*udn|udn/i.test(source) && !isStockMarketNews(row)) continue
      const list = bySource.get(source) ?? []
      if (list.length < limitPerSource) {
        list.push({
          source,
          title: String(row.title || '').trim(),
          url: row.url,
          published_at: row.published_at,
          summary: row.summary,
        })
        bySource.set(source, list)
      }
    }

    const merged = new Map<string, any>()
    for (const item of [...rssGroups.flat(), ...cnyesRows]) merged.set(item.url || item.title, item)
    for (const rows of bySource.values()) {
      for (const item of rows) merged.set(item.url || `${item.source}:${item.title}`, item)
    }

    const sourceCounts = new Map<string, number>()
    const balanced = Array.from(merged.values())
      .sort((a, b) => new Date(b.published_at ?? 0).getTime() - new Date(a.published_at ?? 0).getTime())
      .filter((item) => {
        const source = String(item.source || 'unknown')
        const count = sourceCounts.get(source) ?? 0
        if (count >= limitPerSource) return false
        sourceCounts.set(source, count + 1)
        return true
      })

    return balanced
  }, 15 * 60)

  return c.json(data)
})

// ════════════════════════════════════════════════════════════════════════════
// LLM routes
// ════════════════════════════════════════════════════════════════════════════
export const llm = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// LLM 費用最貴，全部端點限速（10次/分鐘/IP）並要求登入
llm.use('/*', rateLimitMiddleware('llm'))

// Helper: build snapshot + rich context from DB
async function buildSnapshot(db: D1Database, stockId: number) {
  const [stock, latestPrice, latestInd, prediction, factor, risk,
         recentNews, marketRisk, modelAccuracy, stockMemories, recentPredictions] = await Promise.all([
    db.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM factor_scores WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare("SELECT * FROM risk_metrics WHERE stock_id=? AND period='1y' ORDER BY calculated_at DESC LIMIT 1").bind(stockId).first<any>(),
    // rich context
    db.prepare("SELECT title, sentiment, published_at FROM news WHERE stock_id=? ORDER BY published_at DESC LIMIT 7").bind(stockId).all<any>(),
    db.prepare("SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1").all<any>(),
    db.prepare("SELECT model_name, accuracy, total_count, period FROM model_accuracy WHERE stock_id=? AND period IN ('30d','all') ORDER BY period, model_name").bind(stockId).all<any>(),
    db.prepare("SELECT memory_type, content FROM stock_memories WHERE stock_id=? ORDER BY updated_at DESC LIMIT 5").bind(stockId).all<any>(),
    db.prepare("SELECT trade_signal as signal, direction_correct, generated_at FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 5").bind(stockId).all<any>(),
  ])

  if (!stock) return null

  const rich = {
    recentNews: recentNews?.results?.map((n: any) => ({
      title: n.title, sentiment: n.sentiment, publishedAt: n.published_at,
    })) ?? null,
    marketRisk: marketRisk?.results?.[0] ? {
      riskLevel: marketRisk.results[0].risk_level,
      riskScore: marketRisk.results[0].risk_score,
      riskSummary: marketRisk.results[0].risk_summary,
    } : null,
    modelAccuracy: modelAccuracy?.results?.map((a: any) => ({
      modelName: a.model_name, accuracy: a.accuracy,
      totalCount: a.total_count, period: a.period,
    })) ?? null,
    stockMemories: stockMemories?.results?.map((m: any) => ({
      memoryType: m.memory_type, content: m.content,
    })) ?? null,
    recentPredictions: recentPredictions?.results?.map((p: any) => ({
      signal: p.signal, direction_correct: p.direction_correct, generatedAt: p.generated_at,
    })) ?? null,
  }

  return {
    stock, rich, snapshot: {
      symbol: stock.symbol, name: stock.name,
      currentPrice: latestPrice?.close ?? 0,
      ma5: latestInd?.ma5, ma10: latestInd?.ma10, ma20: latestInd?.ma20, ma60: latestInd?.ma60,
      rsi14: latestInd?.rsi14, macd: latestInd?.macd, macdSignal: latestInd?.macd_signal, macdHist: latestInd?.macd_hist,
      bbUpper: latestInd?.bb_upper, bbMid: latestInd?.bb_mid, bbLower: latestInd?.bb_lower, atr14: latestInd?.atr14,
      compositeScore: factor?.composite_score, quantile: factor?.quantile,
      zMomentum: factor?.z_momentum, zValue: factor?.z_value, zQuality: factor?.z_quality,
      sharpeRatio: risk?.sharpe_ratio, maxDrawdown: risk?.max_drawdown, beta: risk?.beta, var95: risk?.var95,
      tradeSignal: prediction?.trade_signal, entryPrice: prediction?.entry_price,
      stopLoss: prediction?.stop_loss, target1: prediction?.target1, target2: prediction?.target2,
    }
  }
}

// ── LLM KV 快取：同一天同一支股票不重複打 Anthropic API ──────────────────────
const llmCacheKey = (type: string, stockId: number) => {
  const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  return `llm:${type}:${stockId}:${twDate}`
}

llm.post('/technical-analysis', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const cacheKey = llmCacheKey('tech', stockId)
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json({ analysis: cached, cached: true })

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)
  const analysis = await generateTechnicalAnalysis(c.env.ANTHROPIC_API_KEY, result.snapshot, result.rich)
  await c.env.KV.put(cacheKey, analysis, { expirationTtl: 86400 })
  return c.json({ analysis })
})

llm.post('/trading-advice', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const cacheKey = llmCacheKey('trade', stockId)
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json({ advice: cached, cached: true })

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)
  const advice = await generateTradingAdvice(c.env.ANTHROPIC_API_KEY, result.snapshot, result.rich)
  await c.env.KV.put(cacheKey, advice, { expirationTtl: 86400 })
  return c.json({ advice })
})

llm.post('/analyst-summary', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const cacheKey = llmCacheKey('summary', stockId)
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json({ summary: cached, cached: true })

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)

  const [latestFin, latestChip] = await Promise.all([
    loadLatestStockFinancialSnapshot(c.env.DB, stockId),
    c.env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 1').bind(result.stock.symbol).first<any>(),
  ])

  const financials = toLlmFinancialContext(latestFin)
  const chipData   = latestChip ? { foreignNetBuy: latestChip.foreign_net, investmentTrustNetBuy: latestChip.trust_net, dealerNetBuy: latestChip.dealer_net, marginBalance: latestChip.margin_balance } : null

  const summary = await generateAnalystSummary(c.env.ANTHROPIC_API_KEY, { snapshot: result.snapshot, financials, chipData, rich: result.rich })
  await c.env.KV.put(cacheKey, summary, { expirationTtl: 86400 })
  return c.json({ summary })
})

llm.post('/ask', authMiddleware, async (c) => {
  const { stockId, question, conversationHistory } = await c.req.json()
  if (!question?.trim()) return c.json({ error: '請輸入問題' }, 400)

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)

  const [latestFin, latestChip] = await Promise.all([
    loadLatestStockFinancialSnapshot(c.env.DB, stockId),
    c.env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 1').bind(result.stock.symbol).first<any>(),
  ])

  const answer = await answerStockQuestion(c.env.ANTHROPIC_API_KEY, {
    question,
    snapshot: result.snapshot,
    financials: toLlmFinancialContext(latestFin),
    chipData: latestChip ? { foreignNetBuy: latestChip.foreign_net, marginBalance: latestChip.margin_balance } : null,
    conversationHistory,
  })
  return c.json({ answer })
})

// ════════════════════════════════════════════════════════════════════════════
// WATCHLIST routes
// ════════════════════════════════════════════════════════════════════════════
export const watchlist = new Hono<{ Bindings: Bindings; Variables: Variables }>()
watchlist.use('*', authMiddleware)

// GET /api/watchlist — 回傳用戶追蹤清單（含股票基本資訊 + 最新報價）
watchlist.get('/', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT w.stock_id, w.cost_price, w.shares, w.note,
           s.symbol, s.name, s.market, s.sector,
           COALESCE(p.avg_price, p.close) as close, p.open, p.high, p.low, p.volume,
           ROUND((COALESCE(p.avg_price, p.close) - COALESCE(p2.avg_price, p2.close)) / COALESCE(p2.avg_price, p2.close) * 100, 2) as change_pct,
           (SELECT GROUP_CONCAT(tag, ',') FROM (SELECT tag FROM stock_tags WHERE symbol = s.symbol ORDER BY weight DESC LIMIT 3)) as tags
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    LEFT JOIN (SELECT stock_id, close, open, high, low, volume FROM stock_prices
               WHERE (stock_id, date) IN (SELECT stock_id, MAX(date) FROM stock_prices GROUP BY stock_id)) p
      ON p.stock_id = w.stock_id
    LEFT JOIN (SELECT stock_id, close, avg_price, date FROM stock_prices
               WHERE (stock_id, date) IN (
                 SELECT stock_id, MAX(date) FROM stock_prices
                 WHERE date < (SELECT MAX(date) FROM stock_prices sp2 WHERE sp2.stock_id = stock_prices.stock_id)
                 GROUP BY stock_id
               )) p2 ON p2.stock_id = w.stock_id
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `).bind(userId).all()
  return c.json(results ?? [])
})

watchlist.get('/:stockId', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT * FROM watchlist WHERE user_id=? AND stock_id=?'
  ).bind(c.get('userId'), parseInt(c.req.param('stockId'))).first()
  return c.json(row ?? null)
})

watchlist.put('/:stockId', async (c) => {
  const userId  = c.get('userId')
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const { costPrice, shares, note } = await c.req.json()
  await c.env.DB.prepare(
    `INSERT INTO watchlist (user_id, stock_id, cost_price, shares, note)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, stock_id) DO UPDATE SET
       cost_price=excluded.cost_price, shares=excluded.shares,
       note=excluded.note, updated_at=datetime('now')`
  ).bind(userId, stockId, costPrice ?? null, shares ?? null, note ?? null).run()
  return c.json({ success: true })
})

// POST /api/watchlist/:stockId — 快速加入追蹤（不需 body）
watchlist.post('/:stockId', async (c) => {
  const userId  = c.get('userId')
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO watchlist (user_id, stock_id) VALUES (?,?)`
  ).bind(userId, stockId).run()
  return c.json({ success: true })
})

// DELETE /api/watchlist/:stockId — 移除追蹤
watchlist.delete('/:stockId', async (c) => {
  const userId  = c.get('userId')
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  await c.env.DB.prepare(
    'DELETE FROM watchlist WHERE user_id=? AND stock_id=?'
  ).bind(userId, stockId).run()
  return c.json({ success: true })
})

// ════════════════════════════════════════════════════════════════════════════
// ALERTS routes
// ════════════════════════════════════════════════════════════════════════════
export const alerts = new Hono<{ Bindings: Bindings; Variables: Variables }>()
alerts.use('*', authMiddleware)

alerts.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT a.*, s.symbol, s.name FROM alert_rules a JOIN stocks s ON a.stock_id=s.id WHERE a.user_id=? AND a.is_active=1'
  ).bind(c.get('userId')).all()
  return c.json(results)
})

alerts.post('/', async (c) => {
  const userId = c.get('userId')
  const { stockId, ruleType, threshold } = await c.req.json()

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM alert_rules WHERE user_id=? AND is_active=1'
  ).bind(userId).first<{ cnt: number }>()
  if ((count?.cnt ?? 0) >= 20) return c.json({ error: '最多設定 20 個警報' }, 400)

  await c.env.DB.prepare(
    'INSERT INTO alert_rules (user_id, stock_id, rule_type, threshold) VALUES (?,?,?,?)'
  ).bind(userId, stockId, ruleType, threshold ?? null).run()
  return c.json({ success: true }, 201)
})

alerts.delete('/:id', async (c) => {
  const userId = c.get('userId')
  await c.env.DB.prepare(
    'UPDATE alert_rules SET is_active=0 WHERE id=? AND user_id=?'
  ).bind(parseInt(c.req.param('id')), userId).run()
  return c.json({ success: true })
})

// ════════════════════════════════════════════════════════════════════════════
// NEWS routes
// ════════════════════════════════════════════════════════════════════════════
import { crawlAndStoreNews, extractKeywords } from '../lib/news'
export const news = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/news/:stockId/crawl  →  手動觸發爬蟲
news.post('/:stockId/crawl', authMiddleware, async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)
  const result = await crawlAndStoreNews(c.env.DB, stock)
  return c.json({ success: true, count: result.count })
})

// GET /api/news/:stockId/sentiment  →  情感統計摘要
news.get('/:stockId/sentiment', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    `SELECT sentiment, COUNT(*) as count FROM news
     WHERE stock_id=? AND published_at>=? GROUP BY sentiment`
  ).bind(stockId, since).all<any>()

  const summary = { positive: 0, neutral: 0, negative: 0, total: 0 }
  for (const r of results) {
    summary[r.sentiment as keyof typeof summary] = r.count
    summary.total += r.count
  }
  return c.json(summary)
})

// GET /api/news/:stockId/trend  →  30日情感趨勢（每日統計）
news.get('/:stockId/trend', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    `SELECT date(published_at) as date, sentiment, COUNT(*) as count
     FROM news WHERE stock_id=? AND published_at>=?
     GROUP BY date(published_at), sentiment ORDER BY date`
  ).bind(stockId, since).all<any>()

  // pivot: { date, positive, neutral, negative }
  const byDate = new Map<string, { positive: number; neutral: number; negative: number }>()
  for (const r of results) {
    if (!byDate.has(r.date)) byDate.set(r.date, { positive: 0, neutral: 0, negative: 0 })
    byDate.get(r.date)![r.sentiment as 'positive'|'neutral'|'negative'] = r.count
  }
  const trend = Array.from(byDate.entries()).map(([date, v]) => ({ date, ...v }))
  return c.json(trend)
})

// GET /api/news/:stockId/keywords  →  關鍵字詞頻統計
news.get('/:stockId/keywords', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    `SELECT title, summary FROM news WHERE stock_id=? AND published_at>=?`
  ).bind(stockId, since).all<any>()

  const keywords = extractKeywords(results)
  return c.json(keywords)
})

// ════════════════════════════════════════════════════════════════════════════
// ML PREDICTION routes  (proxy → Cloud Run Python)
// ════════════════════════════════════════════════════════════════════════════
export const ml = new Hono<{ Bindings: Bindings; Variables: Variables }>()

ml.use('/*', authMiddleware)

// POST /api/ml/predict/:stockId
ml.post('/predict/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const mlUrl = (c.env as any).ML_SERVICE_URL
  if (!mlUrl) return c.json({ error: 'ML service not configured' }, 503)

  // ── Step 1：基礎資料查詢 ──────────────────────────────────────────────────
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>()
  if (!stock) return c.json({ error: 'Stock not found' }, 404)

  const [prices, indicators, chips, news, modelAccRows, marketRiskRow] = await Promise.all([
    c.env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14, plus_di14 as plusDi14, minus_di14 as minusDi14, adx14, parabolic_sar as parabolicSar, cci20, volume_weighted_rsi14 as volumeWeightedRsi14, volume_momentum_divergence_13_27_10 as volumeMomentumDivergence132710 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 200').bind(stock.symbol).all<any>(),
    c.env.DB.prepare('SELECT date(published_at) as date, AVG(CASE sentiment WHEN \'positive\' THEN 1 WHEN \'negative\' THEN -1 ELSE 0 END) as score FROM news WHERE stock_id=? GROUP BY date(published_at) ORDER BY date DESC LIMIT 90').bind(stockId).all<any>(),
    // 各模型 30d 準確率（供 weighted_vote 動態加權）
    c.env.DB.prepare("SELECT model_name, accuracy FROM model_accuracy WHERE stock_id=? AND period='30d'").bind(stockId).all<any>(),
    // 當前市場風險環境（供 HMM Regime / LinUCB bandit context）
    c.env.DB.prepare('SELECT risk_level, risk_score, twii_bias AS twii_bias_20d, twii_close FROM market_risk ORDER BY date DESC LIMIT 1').first<any>(),
  ])

  // ── Step 2：新股票自動初始化（資料不足 60 筆時）───────────────────────────
  let priceRows = prices.results ?? []
  let indRows   = indicators.results ?? []

  if (priceRows.length < 60) {
    console.log(`[ML predict] ${stock.symbol} 資料不足（${priceRows.length} 筆），自動觸發初始化...`)
    try {
      // 從 FinMind / Yahoo 抓最近 365 天資料（約 3-5 秒）
      await fetchAndStoreStockData(c.env.DB, c.env.KV, stock, (c.env as any).FINMIND_TOKEN)
      // 計算技術指標（約 1 秒）
      await computeAndStoreIndicators(c.env.DB, stockId)

      // 重新查詢
      const [p2, i2] = await Promise.all([
        c.env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
        c.env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14, plus_di14 as plusDi14, minus_di14 as minusDi14, adx14, parabolic_sar as parabolicSar, cci20, volume_weighted_rsi14 as volumeWeightedRsi14, volume_momentum_divergence_13_27_10 as volumeMomentumDivergence132710 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
      ])
      priceRows = p2.results ?? []
      indRows   = i2.results ?? []
    } catch (e) {
      console.error(`[ML predict] 自動初始化失敗 ${stock.symbol}:`, e)
    }

    // 初始化後仍不足，代表市場無此資料或 FinMind 額度耗盡
    if (priceRows.length < 60) {
      return c.json({
        error: `${stock.symbol} 歷史資料不足（取得 ${priceRows.length} 筆，需 60+ 筆）。` +
               `可能原因：股票代碼錯誤、FinMind Token 未設定、或資料來源暫無資料。`,
        symbol: stock.symbol,
        data_count: priceRows.length,
      }, 422)
    }

    // 初始化成功 → 繼續往下執行 ML 預測（不 early return，讓流程一次完成）
    console.log(`[ML predict] ${stock.symbol} 初始化完成（${priceRows.length} 筆），繼續 ML 預測...`)
  }

  // ── Step 3：組裝完整 payload（含動態加權欄位）───────────────────────────────

  // real_accuracies: { "KalmanFilter": 0.65, ... }
  const realAccuracies: Record<string, number> = {}
  for (const row of (modelAccRows.results ?? []) as any[]) {
    if (row.model_name && row.accuracy != null) {
      realAccuracies[row.model_name] = parseFloat(row.accuracy)
    }
  }

  // market_env: 傳入最新市場風險指標，供 HMM Regime 偵測 + LinUCB context
  const marketEnv = marketRiskRow ? {
    risk_level:      marketRiskRow.risk_level,
    risk_score:      marketRiskRow.risk_score,
    twii_bias_20d:   marketRiskRow.twii_bias_20d ?? 0,
  } : null
  const [tradingConfig, adaptiveParams] = await Promise.all([
    getTradingConfig(c.env.KV),
    getAdaptiveParamsForRegime(c.env.KV),
  ])

  const payload = {
    stock_id:         stockId,
    symbol:           stock.symbol,
    prices:           priceRows.slice().reverse(),
    indicators:       indRows.slice().reverse(),
    chips:            (chips.results ?? []).slice().reverse(),
    sentiment_scores: (news.results ?? []).slice().reverse(),
    horizon:          14,
    trading_config:   tradingConfig,
    adaptive_params:  adaptiveParams,
    real_accuracies:  realAccuracies,   // ✅ 動態準確率加權
    market_env:       marketEnv,        // ✅ HMM Regime + LinUCB context
    // model_stats（profit_factor / expectancy）目前 D1 無此欄位，保留空物件
  }

  try {
    const cacheKey = `ml:predict:${stockId}`
    // POST = 用戶主動觸發 → 不讀 cache（GET 才讀 cache）

    const mlHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if ((c.env as any).ML_SERVICE_SECRET) mlHeaders['X-Service-Token'] = (c.env as any).ML_SERVICE_SECRET

    const res = await fetch(`${mlUrl}/predict`, {
      method: 'POST',
      headers: mlHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),  // 90s timeout（Modal cold start 可能需要 30-60s）
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`ML service HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = await res.json()

    // 快取 1 小時（供 GET 讀取）
    await c.env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 })

    // 儲存預測結果到 D1
    const d = data as any
    if (d.signal && d.forecasts) {
      await c.env.DB.prepare(
        `INSERT OR REPLACE INTO predictions
         (stock_id, model_name, horizon, direction_accuracy, forecast_data, trade_signal, entry_price, stop_loss, target1, target2, best_model, created_at)
         VALUES (?, 'Ensemble', 14, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
      ).bind(
        stockId,
        d.confidence ?? 0,
        JSON.stringify({ forecasts: d.forecasts, models: d.models, signal: d.signal }),
        d.signal,
        d.entry_price,
        d.stop_loss,
        d.target1,
        d.target2,
      ).run()
    }

    return c.json(data)
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? `ML 預測逾時（90s），可能是 cold start。請 1 分鐘後重試。`
      : `ML 預測失敗：${e?.message?.slice(0, 200) ?? '未知錯誤'}`
    console.error(`[ML predict] ${stock.symbol}:`, e?.message)
    return c.json({ error: msg, symbol: stock.symbol }, 502)
  }
})

// GET /api/ml/predict/:stockId  →  取最新快取結果
ml.get('/predict/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const cached = await c.env.KV.get(`ml:predict:${stockId}`)
  if (cached) return c.json(JSON.parse(cached))

  // 從 D1 取最新儲存的預測（model_name 存入時為 'ensemble' 小寫）
  const row = await c.env.DB.prepare(
    `SELECT * FROM predictions WHERE stock_id=? AND model_name='ensemble' ORDER BY generated_at DESC LIMIT 1`
  ).bind(stockId).first<any>()

  if (!row) return c.json({ error: 'No prediction available' }, 404)
  const fd = JSON.parse(row.forecast_data ?? '{}')
  return c.json({
    signal: row.trade_signal,
    entry_price: parseFloat(row.entry_price),
    stop_loss: parseFloat(row.stop_loss),
    target1: parseFloat(row.target1),
    target2: parseFloat(row.target2),
    confidence: row.direction_accuracy,
    forecasts: fd.forecasts ?? [],
    models: fd.models ?? [],
    reasoning: fd.signal ?? '',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Market Risk routes
// ════════════════════════════════════════════════════════════════════════════

// GET /api/market/risk — 取最新大盤風險（快取30分鐘）
market.get('/risk', async (c) => {
  const cacheKey = 'market:risk:latest:v19-finlab-risk-detail'
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  // 從 D1 取最新一筆
  let row: any | null = null
  try {
    row = await c.env.DB.prepare(
      'SELECT * FROM market_risk ORDER BY date DESC LIMIT 1'
    ).first<any>()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const fallback = await buildMarketRiskFallback(message)
    await c.env.KV.put(cacheKey, JSON.stringify(fallback), { expirationTtl: 300 }).catch(() => {})
    return c.json(fallback)
  }

  if (!row) {
    const fallback = await buildMarketRiskFallback('market_risk_empty')
    await c.env.KV.put(cacheKey, JSON.stringify(fallback), { expirationTtl: 300 }).catch(() => {})
    return c.json(fallback)
  }

  const regimeState = await readMarketRegimeState(c.env.KV).catch(() => null)
  const factor = (
    id: string,
    label: string,
    value: string,
    status: 'ok' | 'warn' | 'error' | 'info' | 'missing',
    source: string,
    detail = '',
  ) => ({ id, label, value, status, source, detail })
  const numberOrNull = (value: unknown): number | null => {
    if (value == null) return null
    if (typeof value === 'string' && value.trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const formatPct = (value: number | null, digits = 2) => value == null ? 'n/a' : `${value.toFixed(digits)}%`
  const formatBillion = (value: number | null) => value == null ? 'n/a' : `${value.toFixed(1)}億`
  const twiiBias = numberOrNull(row.twii_bias)
  const foreignNet5d = numberOrNull(row.foreign_net_5d)
  const marginRatio = numberOrNull(row.margin_ratio)
  const limitDownPct = numberOrNull(row.limit_down_pct)
  const regimeSurface = regimeState?.regime_surface ?? {}
  const monitors = regimeState?.monitors ?? {}
  const transitionGuard = regimeState?.transition_guard ?? {}
  const legacyContextFactors = [
    factor('price_trend', '價格趨勢', formatPct(twiiBias), twiiBias == null ? 'missing' : twiiBias < -3 ? 'error' : twiiBias < -1 ? 'warn' : 'ok', 'market_risk.twii_bias', `TWII close ${row.twii_close ?? 'n/a'} vs MA20 ${row.twii_ma20 ?? 'n/a'}`),
    factor('volatility', '波動', row.vix != null ? `VIX ${Number(row.vix).toFixed(1)}` : `${Number(row.twii_vol20 ?? 0).toFixed(2)}%`, String(row.vix_level ?? '').toLowerCase().includes('high') ? 'warn' : 'info', 'market_risk.vix_twii_vol20'),
    factor('breadth', '市場廣度', formatPct(limitDownPct), limitDownPct == null ? 'missing' : limitDownPct > 3 ? 'error' : limitDownPct > 1 ? 'warn' : 'ok', 'market_risk.limit_down_pct', `limit_down_count=${row.limit_down_count ?? 'n/a'}`),
    factor('chips', '籌碼', formatBillion(foreignNet5d), foreignNet5d == null ? 'missing' : foreignNet5d < 0 ? 'warn' : 'ok', 'market_risk.foreign_net_5d', `foreign_consecutive_sell=${row.foreign_consecutive_sell ?? 0}`),
    factor('leverage', '槓桿', formatPct(marginRatio), marginRatio == null ? 'missing' : marginRatio > 40 ? 'warn' : 'info', 'market_risk.margin_ratio'),
    factor('regime', 'Regime', regimeState?.label ?? 'missing', regimeState ? (regimeState.family === 'bear' ? 'warn' : 'ok') : 'error', regimeState?.source === 'legacy_label' ? 'legacy_regime_fallback' : 'market_regime_state', `run_date=${regimeState?.run_date ?? 'missing'}`),
    factor('global_risk', '全球風險', String((monitors as any).global_event_pressure ?? (regimeSurface as any).global_risk ?? 'context'), (regimeSurface as any).global_risk > 0.6 ? 'warn' : 'info', 'market_regime_state.monitors'),
    factor('lppls', 'LPPLS', String((monitors as any).lppls ?? 'context'), (transitionGuard as any).bubble_risk ? 'warn' : 'info', 'market_regime_state.monitors.lppls'),
    factor('hawkes', 'Hawkes', String((monitors as any).hawkes ?? 'context'), (transitionGuard as any).contagion_risk ? 'warn' : 'info', 'market_regime_state.monitors.hawkes'),
  ]
  let factorPacket = await buildMarketRegimeFactorPacket(c.env.DB, row, regimeState).catch(() => null)
  if (factorPacket) {
    await upsertMarketRegimeFactorPacket(c.env.DB, factorPacket).catch(() => {})
  } else {
    factorPacket = await loadMarketRegimeFactorPacket(c.env.DB, row.date).catch(() => null)
  }
  const [canonicalOverview, creditTradingBase, institutionalFlows, regimeContext, usMarketSignal, globalEventContext, marketRiskDetail] = await Promise.all([
    loadCanonicalMarketOverview(c.env.DB),
    loadCanonicalCreditTrading(c.env.DB),
    loadCanonicalInstitutionalFlows(c.env.DB),
    loadCanonicalRegimeContext(c.env.DB),
    loadLatestUsMarketSignal(c.env.DB),
    loadGdeltGlobalEventContext(c.env.DB),
    loadMarketRiskDetailBreakdown(c.env.DB),
  ])
  const creditTrading = creditTradingBase
  const businessCycle = regimeContext?.businessCycle ?? businessCycleFromFactorPacket(factorPacket, row.date)
  const contextFactors = [
    ...(regimeContext?.factors ?? []),
    ...(factorPacket?.factors ?? legacyContextFactors),
  ]
  const marketOutlook = buildMarketOptimisticOutlook({
    marketRiskRow: row,
    regimeState,
    factorPacket,
  })
  const fearGreedIndex = buildFearGreedIndex({
    row,
    canonicalOverview,
    regimeContext,
    usSignal: usMarketSignal,
  })
  const hedgeSentimentFactors = buildHedgeSentimentFactors({
    row,
    regimeContext,
    usSignal: usMarketSignal,
  })
  const hedgeSentiment = buildHedgeSentiment({
    row,
    regimeContext,
    usSignal: usMarketSignal,
    factors: hedgeSentimentFactors,
  })
  const rawSummary = String(row.risk_summary ?? '').trim()
  const packetSummary = rawSummary && !rawSummary.includes('V4 weighted factors')
    ? rawSummary
    : `市場風險 ${Math.round(Number(factorPacket?.score ?? row.risk_score ?? 0))}/100，等級 ${factorPacket?.level ?? row.risk_level ?? 'unknown'}。`

  const data = {
    date:                   row.date,
    vix:                    row.vix,
    vixLevel:               row.vix_level,
    twiiClose:              row.twii_close,
    twiiVol20:              row.twii_vol20,
    twiiMa20:               row.twii_ma20,
    twiiBias:              row.twii_bias,
    foreignConsecutiveSell: row.foreign_consecutive_sell,
    foreignNet5d:           row.foreign_net_5d,
    marginRatio:            row.margin_ratio,
    limitDownCount:         row.limit_down_count,
    limitDownPct:           row.limit_down_pct,
    riskScore:              factorPacket?.score ?? row.risk_score,
    riskLevel:              factorPacket?.level ?? row.risk_level,
    riskSummary:            packetSummary,
    calculatedAt:           row.calculated_at,
    breadthSnapshot:        canonicalOverview?.breadthSnapshot ?? null,
    marketStats:            canonicalOverview?.marketStats ?? null,
    marketDataScope:        canonicalOverview?.marketStats?.scope ?? null,
    marketVolume:           canonicalOverview?.marketStats?.volume ?? null,
    marketTurnoverAmount:   canonicalOverview?.marketStats?.amount ?? null,
    creditTrading,
    marginBalance:          creditTrading?.marginBalance ?? null,
    marginBalanceValue:     creditTrading?.marginBalanceValue ?? null,
    marginBalanceUnits:     creditTrading?.marginBalanceUnits ?? null,
    marginBalanceUnit:      creditTrading?.marginBalanceUnit ?? null,
    shortBalance:           creditTrading?.shortBalance ?? null,
    shortBalanceValue:      creditTrading?.shortBalanceValue ?? null,
    shortBalanceUnits:      creditTrading?.shortBalanceUnits ?? null,
    marginBalanceChangePct: creditTrading?.marginBalanceChangePct ?? null,
    shortBalanceChangePct:  creditTrading?.shortBalanceChangePct ?? null,
    putCallRatio:           regimeContext?.putCallRatio ?? null,
    largeTraderNet:         regimeContext?.largeTraderNet ?? null,
    usdTwd:                 regimeContext?.usdTwd ?? null,
    usdTwdChangePct:        regimeContext?.usdTwdChangePct ?? null,
    fxStatus:               regimeContext?.fxStatus ?? null,
    institutionalFlows,
    businessCycle,
    regimeContext,
    usMarketSignal,
    globalEventContext,
    marketRiskDetail,
    fearGreedIndex,
    hedgeSentiment,
    hedgeSentimentFactors,
    dataSourcePriority: [
      'FinLab canonical materialized tables',
      'market_risk / market_regime_factor_packets',
      'TAIFEX MIS only for live night futures',
    ],
    materializationGaps: {
      putCallRatio: regimeContext?.missing?.putCallRatio ? 'FinLab tw_option_put_call_ratio not materialized' : null,
      largeTraderNet: regimeContext?.missing?.largeTraderNet ? 'FinLab tw_taifex_futures_large_trader not materialized' : null,
      usdTwd: regimeContext?.missing?.usdTwd ? 'FinLab world_index USD/TWD not materialized' : null,
    },
    regimeState: regimeState ? {
      label: regimeState.label,
      family: regimeState.family,
      runDate: regimeState.run_date,
      computedAt: regimeState.computed_at,
      source: regimeState.source,
      regimeSurface: regimeState.regime_surface,
      transitionGuard: regimeState.transition_guard,
      monitors: regimeState.monitors,
    } : null,
    marketOutlook,
    factorPacket,
    contextFactors,
  }

  await c.env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })
  return c.json(data)
})

// GET /api/market/risk/history?days=30 — 歷史風險趨勢
market.get('/risk/history', async (c) => {
  const days = Math.min(parsePosInt(c.req.query('days'), 30), 90)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
  const { results } = await c.env.DB.prepare(
    `SELECT date, risk_score, risk_level, vix, twii_close, twii_vol20, twii_bias,
            foreign_consecutive_sell, foreign_net_5d
     FROM market_risk WHERE date >= ? ORDER BY date ASC`
  ).bind(since).all<any>()
  return c.json(results ?? [])
})

// GET /api/market/ex-dividend — 除權除息預告（KV 快取，Wave2 每日更新）
market.get('/ex-dividend', async (c) => {
  const raw = await c.env.KV.get('market:ex_dividend_forecast')
  if (!raw) return c.json([])
  return c.json(JSON.parse(raw))
})

// GET /api/market/attention-stocks — 注意股清單（KV 快取，Wave2 每日更新）
market.get('/attention-stocks', async (c) => {
  const raw = await c.env.KV.get('market:attention_stocks')
  if (!raw) return c.json([])
  return c.json(JSON.parse(raw))
})

// ─── 聊天對話持久化 ────────────────────────────────────────────────────────────
export const chat = new Hono<{ Bindings: Bindings; Variables: Variables }>()
// GET  /api/chat/sessions?stockId=   取對話列表（userId 從 JWT 取，非 query param）
// GET  /api/chat/sessions/:id/messages       取對話訊息
// POST /api/chat/sessions                    建立 session
// POST /api/chat/sessions/:id/messages       新增訊息（user + assistant）
// DELETE /api/chat/sessions/:id              刪除對話

chat.use('/*', authMiddleware)

chat.get('/sessions', async (c) => {
  // Fix: userId 從 JWT 取，不信任 query param
  const userId  = String(c.get('userId'))
  const stockId = c.req.query('stockId')
  const { results } = await c.env.DB.prepare(`
    SELECT cs.*, s.symbol, s.name as stock_name,
           (SELECT content FROM chat_messages WHERE session_id=cs.id ORDER BY created_at DESC LIMIT 1) as last_message
    FROM chat_sessions cs
    LEFT JOIN stocks s ON cs.stock_id = s.id
    WHERE cs.user_id=? ${stockId ? 'AND cs.stock_id=?' : ''}
    ORDER BY cs.updated_at DESC LIMIT 20
  `).bind(...(stockId ? [userId, parseInt(stockId)] : [userId])).all<any>()
  return c.json(results ?? [])
})

chat.get('/sessions/:id/messages', async (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return c.json({ error: '無效 ID' }, 400)

  // Fix IDOR: 確認 session 屬於當前用戶
  const session = await c.env.DB.prepare(
    'SELECT user_id FROM chat_sessions WHERE id=?'
  ).bind(sessionId).first<{ user_id: string }>()
  if (!session) return c.json({ error: '對話不存在' }, 404)
  if (String(session.user_id) !== String(c.get('userId'))) {
    return c.json({ error: '無權限' }, 403)
  }

  const before = parseId(c.req.query('before'))  // 往前翻頁：載入比此 ID 更早的訊息
  const limit  = Math.min(parsePosInt(c.req.query('limit'), 50), 100)

  const { results } = await c.env.DB.prepare(
    before
      ? 'SELECT id, role, content, created_at FROM chat_messages WHERE session_id=? AND id < ? ORDER BY id DESC LIMIT ?'
      : 'SELECT id, role, content, created_at FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?'
  ).bind(...(before ? [sessionId, before, limit] : [sessionId, limit])).all<any>()

  // 回傳時反轉為時間正序（前端顯示用）
  return c.json((results ?? []).reverse())
})

chat.post('/sessions', async (c) => {
  // Fix: userId 永遠從 JWT 取
  const userId  = String(c.get('userId'))
  const { stockId, title } = await c.req.json()
  const result = await c.env.DB.prepare(`
    INSERT INTO chat_sessions (user_id, stock_id, title) VALUES (?,?,?)
  `).bind(userId, stockId ?? null, title ?? null).run()
  return c.json({ id: result.meta?.last_row_id, userId, stockId })
})

chat.post('/sessions/:id/messages', async (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return c.json({ error: '無效 ID' }, 400)

  // Fix IDOR: 確認 session 屬於當前用戶
  const session = await c.env.DB.prepare(
    'SELECT user_id FROM chat_sessions WHERE id=?'
  ).bind(sessionId).first<{ user_id: string }>()
  if (!session) return c.json({ error: '對話不存在' }, 404)
  if (String(session.user_id) !== String(c.get('userId'))) {
    return c.json({ error: '無權限' }, 403)
  }

  const { role, content } = await c.req.json()
  if (!['user', 'assistant'].includes(role) || !content) {
    return c.json({ error: 'invalid role or content' }, 400)
  }

  // Fix: 限制 content 長度，防止超大 payload 塞滿 D1
  const safeContent = typeof content === 'string' ? content.slice(0, 8000) : ''
  if (!safeContent) return c.json({ error: 'content 不可為空' }, 400)

  await c.env.DB.prepare(
    'INSERT INTO chat_messages (session_id, role, content) VALUES (?,?,?)'
  ).bind(sessionId, role, safeContent).run()
  await c.env.DB.prepare(
    "UPDATE chat_sessions SET updated_at=datetime('now') WHERE id=?"
  ).bind(sessionId).run()
  return c.json({ ok: true })
})

chat.delete('/sessions/:id', async (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return c.json({ error: '無效 ID' }, 400)

  // Fix IDOR: 確認 session 屬於當前用戶（或 admin 可刪任何 session）
  const session = await c.env.DB.prepare(
    'SELECT user_id FROM chat_sessions WHERE id=?'
  ).bind(sessionId).first<{ user_id: string }>()
  if (!session) return c.json({ error: '對話不存在' }, 404)
  const isAdmin = c.get('userRole') === 'admin'
  if (!isAdmin && String(session.user_id) !== String(c.get('userId'))) {
    return c.json({ error: '無權限' }, 403)
  }

  await c.env.DB.prepare('DELETE FROM chat_sessions WHERE id=?').bind(sessionId).run()
  return c.json({ ok: true })
})

// ─── 交易模擬損益查詢 ──────────────────────────────────────────────────────────
ml.use('/trade-performance/*', rateLimitMiddleware('api'))
ml.use('/trade-history/*', rateLimitMiddleware('api'))
// system-logs 只有 admin 能看（包含內部 Cron 錯誤細節）
ml.use('/system-logs*', adminMiddleware)


// GET /api/ml/system-logs
ml.get('/system-logs', async (c) => {
  const limit = parsePosInt(c.req.query('limit'), 50)
  const level = c.req.query('level')  // filter by 'error' | 'warn' | 'info'
  const whereLevel = level ? `AND level=?` : ''
  const params = level ? [limit, level] : [limit]
  const { results } = await c.env.DB.prepare(`
    SELECT * FROM system_logs
    ${level ? 'WHERE level=?' : ''}
    ORDER BY created_at DESC LIMIT ?
  `).bind(...(level ? [level, limit] : [limit])).all<any>()
  return c.json(results ?? [])
})

ml.get('/trade-performance/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const { results } = await c.env.DB.prepare(`
    SELECT tp.*,
           ma.accuracy, ma.profit_factor as acc_profit_factor
    FROM trade_performance tp
    LEFT JOIN model_accuracy ma
      ON tp.stock_id = ma.stock_id AND tp.model_name = ma.model_name AND ma.period = tp.period
    WHERE tp.stock_id=?
    ORDER BY tp.period, tp.profit_factor DESC NULLS LAST
  `).bind(stockId).all<any>()
  return c.json(results ?? [])
})

ml.get('/trade-performance/global', async (c) => {
  // 全局績效統計（所有股票加總）
  const { results } = await c.env.DB.prepare(`
    SELECT model_name, period,
           SUM(total_trades)  as total_trades,
           SUM(win_trades)    as win_trades,
           SUM(total_pnl_pct) as total_pnl,
           ROUND(CAST(SUM(win_trades) AS REAL) / SUM(total_trades), 3) as win_rate,
           AVG(profit_factor) as avg_profit_factor,
           AVG(expectancy)    as avg_expectancy,
           AVG(avg_pnl_r)     as avg_r
    FROM trade_performance
    WHERE total_trades >= 5
    GROUP BY model_name, period
    ORDER BY period, avg_profit_factor DESC NULLS LAST
  `).all<any>()
  return c.json(results ?? [])
})

// 某支股票的逐筆模擬交易記錄
ml.get('/trade-history/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const limit   = parsePosInt(c.req.query('limit'), 50)
  const { results } = await c.env.DB.prepare(`
    SELECT generated_at, model_name, trade_signal,
           predicted_direction, actual_direction, direction_correct,
           entry_price, stop_loss, target1, target2,
           trade_outcome, trade_pnl_pct, trade_pnl_r,
           max_favorable_pct, max_adverse_pct,
           actual_return_pct, market_risk_level, verified_at
    FROM predictions
    WHERE stock_id=? AND trade_pnl_pct IS NOT NULL
    ORDER BY generated_at DESC
    LIMIT ?
  `).bind(stockId, limit).all<any>()
  return c.json(results ?? [])
})

// ─── ML 準確率查詢 ────────────────────────────────────────────────────────────
ml.get('/accuracy/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const { results } = await c.env.DB.prepare(`
    SELECT model_name, accuracy, total_count, correct_count, avg_price_error, period, last_updated
    FROM model_accuracy
    WHERE stock_id=?
    ORDER BY period, accuracy DESC
  `).bind(stockId).all<any>()
  return c.json(results ?? [])
})

ml.get('/accuracy/global', async (c) => {
  // 跨所有股票的準確率統計
  const { results } = await c.env.DB.prepare(`
    SELECT model_name, period,
           SUM(total_count) as total, SUM(correct_count) as correct,
           ROUND(CAST(SUM(correct_count) AS REAL) / SUM(total_count), 3) as accuracy
    FROM model_accuracy
    WHERE total_count >= 5
    GROUP BY model_name, period
    ORDER BY period, accuracy DESC
  `).all<any>()
  return c.json(results ?? [])
})

// ════════════════════════════════════════════════════════════════════════════
// Notification routes  GET /api/notifications
// ════════════════════════════════════════════════════════════════════════════
export const notifications = new Hono<{ Bindings: Bindings; Variables: Variables }>()
notifications.use('/*', authMiddleware)

// GET /api/notifications — 未讀通知列表
notifications.get('/', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    `SELECT id, stock_symbol, rule_type, threshold, triggered_price, created_at
     FROM alert_notifications WHERE user_id=? AND is_read=0
     ORDER BY created_at DESC LIMIT 20`
  ).bind(userId).all<any>()
  return c.json(results ?? [])
})

// GET /api/notifications/count — 未讀數量（badge 用）
notifications.get('/count', async (c) => {
  const userId = c.get('userId')
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM alert_notifications WHERE user_id=? AND is_read=0'
  ).bind(userId).first<{ cnt: number }>()
  return c.json({ count: row?.cnt ?? 0 })
})

// POST /api/notifications/read-all — 全部標為已讀
notifications.post('/read-all', async (c) => {
  const userId = c.get('userId')
  await c.env.DB.prepare(
    "UPDATE alert_notifications SET is_read=1 WHERE user_id=? AND is_read=0"
  ).bind(userId).run()
  return c.json({ success: true })
})

// ════════════════════════════════════════════════════════════════════════════
// System Status  GET /api/system/status
// ════════════════════════════════════════════════════════════════════════════
export const system = new Hono<{ Bindings: Bindings; Variables: Variables }>()

system.get('/status', async (c) => {
  const db = c.env.DB

  // 查各資料表最新一筆的日期
  const [
    latestPrice,
    latestChip,
    latestNews,
    latestPrediction,
    latestMarketRisk,
    totalStocks,
    totalNews,
    dbSize,
  ] = await Promise.all([
    db.prepare('SELECT MAX(date) as d, COUNT(*) as cnt FROM stock_prices').first<any>(),
    db.prepare('SELECT MAX(date) as d FROM chip_data').first<any>(),
    db.prepare('SELECT MAX(published_at) as d, COUNT(*) as cnt FROM news').first<any>(),
    db.prepare('SELECT MAX(generated_at) as d FROM predictions').first<any>(),
    db.prepare('SELECT date, risk_level, risk_score, calculated_at FROM market_risk ORDER BY date DESC LIMIT 1').first<any>(),
    db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE in_current_watchlist=1').first<any>(),
    db.prepare('SELECT COUNT(*) as cnt FROM news').first<any>(),
    db.prepare("SELECT SUM(pgsize * ncell) as sz FROM dbstat").first<any>().catch(() => null),
  ])

  // 判斷各資料是否為今日（台灣交易日）
  const today     = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const isRecent  = (dateStr: string | null, allowYesterday = true) => {
    if (!dateStr) return false
    const d = dateStr.split('T')[0]
    return d === today || (allowYesterday && d === yesterday)
  }

  const priceDate      = latestPrice?.d ?? null
  const chipDate       = latestChip?.d ?? null
  const newsDate       = latestNews?.d ? latestNews.d.split('T')[0] : null
  const predictionDate = latestPrediction?.d ? latestPrediction.d.split('T')[0] : null
  const riskDate       = latestMarketRisk?.date ?? null

  // 整體狀態：全部都有今日或昨日資料才算 ok
  const priceOk      = isRecent(priceDate)
  const chipOk       = isRecent(chipDate)
  const newsOk       = isRecent(newsDate)
  const predOk       = isRecent(predictionDate)
  const riskOk       = isRecent(riskDate)

  const allOk    = priceOk && chipOk
  const hasWarn  = !priceOk || !chipOk

  return c.json({
    overall: allOk ? 'ok' : hasWarn ? 'warning' : 'stale',
    updatedAt: new Date().toISOString(),
    data: {
      prices: {
        lastDate:  priceDate,
        isRecent:  priceOk,
        rowCount:  latestPrice?.cnt ?? 0,
      },
      chips: {
        lastDate:  chipDate,
        isRecent:  chipOk,
      },
      news: {
        lastDate:  newsDate,
        isRecent:  newsOk,
        rowCount:  totalNews?.cnt ?? 0,
      },
      predictions: {
        lastDate:  predictionDate,
        isRecent:  predOk,
      },
      marketRisk: {
        lastDate:    riskDate,
        isRecent:    riskOk,
        riskLevel:   latestMarketRisk?.risk_level ?? null,
        riskScore:   latestMarketRisk?.risk_score ?? null,
        calculatedAt: latestMarketRisk?.calculated_at ?? null,
      },
    },
    meta: {
      activeStocks: totalStocks?.cnt ?? 0,
      dbSizeBytes:  dbSize?.sz ?? null,
    },
  })
})


// ══════════════════════════════════════════════════════════════════════════════
// 每日選股推薦 & 族群資金流向
// ══════════════════════════════════════════════════════════════════════════════
export const recommendations = new Hono<{ Bindings: Bindings; Variables: Variables }>()

recommendations.use('/*', authMiddleware)

const FINAL_RECOMMENDATION_WHERE = "signal IS NOT NULL AND confidence IS NOT NULL AND score_components LIKE '%score_v2%'"
const FINAL_RECOMMENDATION_ROW_WHERE = "r.signal IS NOT NULL AND r.confidence IS NOT NULL AND r.score_components LIKE '%score_v2%'"

function isEmergingRecommendation(row: Record<string, any>): boolean {
  return String(row.recommendation_lane ?? '').toLowerCase() === 'emerging_watchlist'
    || String(row.market_segment ?? '').toUpperCase() === 'EMERGING'
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

type InstitutionalRawCardRow = {
  key: string
  label: string
  buy_shares: number | null
  sell_shares: number | null
  net_shares: number | null
}

function buildInstitutionalRawToday(row: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!row) return null
  const rows: InstitutionalRawCardRow[] = [
    {
      key: 'foreign',
      label: '外資',
      buy_shares: finiteNumber(row.foreign_buy),
      sell_shares: finiteNumber(row.foreign_sell),
      net_shares: finiteNumber(row.foreign_net),
    },
    {
      key: 'trust',
      label: '投信',
      buy_shares: finiteNumber(row.trust_buy),
      sell_shares: finiteNumber(row.trust_sell),
      net_shares: finiteNumber(row.trust_net),
    },
    {
      key: 'dealer',
      label: '自營商',
      buy_shares: finiteNumber(row.dealer_buy),
      sell_shares: finiteNumber(row.dealer_sell),
      net_shares: finiteNumber(row.dealer_net),
    },
  ]
  const hasData = rows.some((item) => (
    item.buy_shares != null || item.sell_shares != null || item.net_shares != null
  ))
  if (!hasData) return null
  return {
    schema_version: 'institutional_raw_card_v1',
    date: String(row.date ?? ''),
    source: 'chip_data',
    unit: 'shares',
    rows,
    total_net_shares: rows.reduce((sum, item) => sum + (item.net_shares ?? 0), 0),
  }
}

function normalizeBrokerRankRow(row: Record<string, any>): Record<string, any> {
  return {
    rank: finiteNumber(row.rank_no),
    broker_code: row.broker_code == null ? null : String(row.broker_code),
    broker_name: row.broker_name == null ? null : String(row.broker_name),
    buy_lots: finiteNumber(row.buy_lots ?? row.buy_shares),
    sell_lots: finiteNumber(row.sell_lots ?? row.sell_shares),
    net_lots: finiteNumber(row.net_lots ?? row.net_shares),
  }
}

function buildBrokerTopFlowsToday(
  row: Record<string, any> | null | undefined,
  date: string,
  rankRows: Record<string, any>[] = [],
): Record<string, any> {
  const topBuy = rankRows
    .filter((rankRow) => String(rankRow.rank_side ?? '').toLowerCase() === 'buy')
    .sort((a, b) => Number(a.rank_no ?? 999) - Number(b.rank_no ?? 999))
    .slice(0, 5)
    .map(normalizeBrokerRankRow)
  const topSell = rankRows
    .filter((rankRow) => String(rankRow.rank_side ?? '').toLowerCase() === 'sell')
    .sort((a, b) => Number(a.rank_no ?? 999) - Number(b.rank_no ?? 999))
    .slice(0, 5)
    .map(normalizeBrokerRankRow)
  if (!row) {
    return {
      schema_version: 'broker_top_flows_card_v1',
      date,
      source: 'canonical_broker_flow_daily',
      unit: 'lots',
      top_buy: topBuy,
      top_sell: topSell,
      aggregate: null,
      missing_reason: topBuy.length || topSell.length ? null : 'no_canonical_broker_flow_row_for_symbol_date',
      materialization_gap: topBuy.length || topSell.length ? null : 'broker_level_top5_not_materialized_in_d1',
    }
  }
  return {
    schema_version: 'broker_top_flows_card_v1',
    date: String(row.date ?? date),
    source: String(row.source ?? 'canonical_broker_flow_daily'),
    unit: 'lots',
    top_buy: topBuy,
    top_sell: topSell,
    aggregate: {
      market_segment: row.market_segment ?? null,
      buy_lots: finiteNumber(row.buy_shares),
      sell_lots: finiteNumber(row.sell_shares),
      net_lots: finiteNumber(row.net_shares),
      dominant_net_lots: finiteNumber(row.dominant_net_shares),
      gross_imbalance_lots: finiteNumber(row.gross_imbalance_shares),
      estimated_amount: finiteNumber(row.estimated_amount),
      broker_count: finiteNumber(row.broker_count),
      concentration: finiteNumber(row.concentration),
    },
    missing_reason: topBuy.length || topSell.length ? null : 'broker_level_detail_table_missing',
    materialization_gap: topBuy.length || topSell.length
      ? null
      : 'FinLab broker_transactions was compressed into canonical_broker_flow_daily aggregates; broker_code/name top5 rows are not persisted yet.',
  }
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function uniqueStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function stageEffectivePass(row: Record<string, any> | null | undefined): number | null {
  if (!row) return null
  const selected = finiteNumber(row.selected_count)
  const pass = finiteNumber(row.pass_count)
  const observe = finiteNumber(row.observe_count)
  const total = finiteNumber(row.total_count)
  const drop = finiteNumber(row.drop_count) ?? 0
  const candidates = [selected, pass, observe, total == null ? null : Math.max(0, total - drop)]
    .filter((value): value is number => value != null && Number.isFinite(value))
  return candidates.length ? Math.max(...candidates) : null
}

function roundMetric(value: number | null, digits = 3): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function jaccard(left: Set<string>, right: Set<string>): number | null {
  const union = new Set([...left, ...right])
  if (union.size === 0) return null
  let intersection = 0
  for (const symbol of left) if (right.has(symbol)) intersection += 1
  return intersection / union.size
}

function binaryCorr(left: Set<string>, right: Set<string>, universeSize: number): number | null {
  if (universeSize <= 1) return null
  let both = 0
  for (const symbol of left) if (right.has(symbol)) both += 1
  const leftOnly = left.size - both
  const rightOnly = right.size - both
  const neither = Math.max(0, universeSize - both - leftOnly - rightOnly)
  const denom = Math.sqrt(
    (both + leftOnly) *
    (rightOnly + neither) *
    (both + rightOnly) *
    (leftOnly + neither),
  )
  if (!Number.isFinite(denom) || denom <= 0) return null
  return ((both * neither) - (leftOnly * rightOnly)) / denom
}

async function buildDailyPipelineSummaries(db: Bindings['DB'], date: string): Promise<Record<string, any>> {
  const latestRun = await db.prepare(`
    SELECT run_id, date, status, universe_count, candidate_count, final_count, emerging_count, created_at
      FROM screener_funnel_runs
     WHERE date = ?
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(date).first<any>()
  if (!latestRun?.run_id) {
    return {
      funnel_summary: null,
      strategy_summary: null,
    }
  }

  const { results: stageRows } = await db.prepare(`
    SELECT stage,
           COUNT(DISTINCT symbol) AS total_count,
           COUNT(DISTINCT CASE WHEN decision = 'pass' THEN symbol END) AS pass_count,
           COUNT(DISTINCT CASE WHEN decision = 'selected' THEN symbol END) AS selected_count,
           COUNT(DISTINCT CASE WHEN decision = 'observe' THEN symbol END) AS observe_count,
           COUNT(DISTINCT CASE WHEN decision = 'drop' THEN symbol END) AS drop_count
      FROM screener_funnel_items
     WHERE run_id = ?
     GROUP BY stage
  `).bind(latestRun.run_id).all<any>()
  const byStage = new Map<string, Record<string, any>>((stageRows ?? []).map((row: any) => [String(row.stage ?? ''), row]))
  const pickStage = (...names: string[]) => names.map((name) => byStage.get(name)).find(Boolean) ?? null
  const signalCounts = await db.prepare(`
    SELECT COUNT(DISTINCT symbol) AS recommendation_count,
           COUNT(DISTINCT CASE WHEN signal IN ('BUY', 'STRONG_BUY') OR has_buy_signal = 1 THEN symbol END) AS buy_signal_count,
           COUNT(DISTINCT CASE WHEN signal = 'HOLD' THEN symbol END) AS hold_count
      FROM daily_recommendations
     WHERE date = ?
  `).bind(date).first<any>().catch(() => null)
  const layer0Stage = pickStage('universe')
  const layer1Stage = pickStage('l1_candidate_seed_after_overlay', 'layer1_strategy_breadth_gate', 'final_selection')
  const layer2Stage = pickStage('l15_ml_slate_queue', 'layer2_coarse_ml_gate', 'layer2_timesfm_enrichment')
  const layer3Stage = pickStage('layer3_formal_ml_gate')
  const l0Pass = finiteNumber(layer0Stage?.pass_count) ?? finiteNumber(latestRun.candidate_count)
  const l0Drop = finiteNumber(layer0Stage?.drop_count)
  const l1Pass = stageEffectivePass(layer1Stage)
  const l2Pass = stageEffectivePass(layer2Stage)
  const l3Pass = stageEffectivePass(layer3Stage)
  const recommendationCount = finiteNumber(signalCounts?.recommendation_count) ?? finiteNumber(latestRun.final_count)
  const buySignalCount = finiteNumber(signalCounts?.buy_signal_count)
  const holdCount = finiteNumber(signalCounts?.hold_count)
  const l4Pass = buySignalCount ?? finiteNumber(latestRun.final_count)
  type PipelineLayerDef = {
    layer: string
    label: string
    stage: string
    passed: number | null
    eliminated?: number | null
    previous?: number | null
  }
  const layerDefs: PipelineLayerDef[] = [
    { layer: 'L0', label: 'Universe gate', stage: String(layer0Stage?.stage ?? 'universe'), passed: l0Pass, eliminated: l0Drop },
    { layer: 'L1', label: 'Active strategy breadth', stage: String(layer1Stage?.stage ?? 'l1_candidate_seed_after_overlay'), passed: l1Pass, eliminated: finiteNumber(layer1Stage?.drop_count), previous: l0Pass },
    { layer: 'L2', label: 'ML slate queue', stage: String(layer2Stage?.stage ?? 'l15_ml_slate_queue'), passed: l2Pass, eliminated: finiteNumber(layer2Stage?.drop_count), previous: l1Pass },
    { layer: 'L3', label: 'Formal ML gate', stage: String(layer3Stage?.stage ?? 'layer3_formal_ml_gate'), passed: l3Pass, eliminated: finiteNumber(layer3Stage?.drop_count), previous: l2Pass },
    { layer: 'L4', label: 'BUY signal allocation', stage: 'daily_recommendations.signal BUY', passed: l4Pass, previous: l3Pass ?? l2Pass ?? l1Pass },
  ]
  const layers = layerDefs.map((row) => {
    const eliminated = row.eliminated != null
      ? row.eliminated
      : row.previous != null && row.passed != null
        ? Math.max(0, row.previous - row.passed)
        : null
    return {
      layer: row.layer,
      label: row.label,
      stage: row.stage,
      passed: row.passed,
      eliminated,
    }
  })

  const { results: strategyRows } = await db.prepare(`
    SELECT symbol, evidence
      FROM screener_funnel_items
     WHERE run_id = ?
       AND stage = 'l1_candidate_seed_after_overlay'
       AND decision IN ('selected', 'pass', 'observe')
  `).bind(latestRun.run_id).all<any>()
  const strategySymbols = new Map<string, Set<string>>()
  const candidateSymbols = new Set<string>()
  for (const row of strategyRows ?? []) {
    const symbol = String(row.symbol ?? '').trim()
    if (!symbol) continue
    candidateSymbols.add(symbol)
    const evidence = parseJsonObject(row.evidence)
    const strategyIds = uniqueStringList(evidence.strategy_pool_ids ?? evidence.strategy_ids)
    for (const strategyId of strategyIds) {
      const set = strategySymbols.get(strategyId) ?? new Set<string>()
      set.add(symbol)
      strategySymbols.set(strategyId, set)
    }
  }
  const registryActiveRows = await db.prepare(`
    SELECT strategy_id
      FROM strategy_spec_registry
     WHERE status = 'active'
     ORDER BY strategy_id
  `).all<any>().catch(() => ({ results: [] as any[] }))
  const registryActiveIds = new Set(
    (registryActiveRows.results ?? [])
      .map((row: any) => String(row.strategy_id ?? '').trim())
      .filter(Boolean),
  )
  const defaultActiveIds = DEFAULT_STRATEGY_SPECS
    .filter((spec) => spec.status === 'active')
    .map((spec) => spec.id)
  const activeStrategyIds = registryActiveIds.size ? registryActiveIds : new Set(defaultActiveIds)
  const strategyDisplayIds = [...new Set([...activeStrategyIds, ...strategySymbols.keys()])]
  const strategyUniverseSize = Math.max(candidateSymbols.size, finiteNumber(latestRun.final_count) ?? 0)
  const strategyCounts = strategyDisplayIds
    .map((strategy_id) => {
      const symbols = strategySymbols.get(strategy_id) ?? new Set<string>()
      return {
      strategy_id,
      selected_count: symbols.size,
      symbols: [...symbols].sort(),
      status: activeStrategyIds.has(strategy_id) ? 'active' : 'observed',
      source: registryActiveIds.has(strategy_id) ? 'strategy_spec_registry' : activeStrategyIds.has(strategy_id) ? 'default_strategy_specs' : 'screener_evidence',
    }
    })
    .sort((a, b) => b.selected_count - a.selected_count || a.strategy_id.localeCompare(b.strategy_id))
  const pairwise: Array<Record<string, any>> = []
  const entries = [...strategySymbols.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [leftId, leftSet] = entries[i]
      const [rightId, rightSet] = entries[j]
      const overlap = [...leftSet].filter((symbol) => rightSet.has(symbol)).length
      pairwise.push({
        left: leftId,
        right: rightId,
        overlap,
        jaccard: roundMetric(jaccard(leftSet, rightSet)),
        corr: roundMetric(binaryCorr(leftSet, rightSet, strategyUniverseSize)),
      })
    }
  }
  const avg = (values: Array<number | null | undefined>) => {
    const clean = values.filter((value): value is number => value != null && Number.isFinite(value))
    return clean.length ? roundMetric(clean.reduce((sum, value) => sum + value, 0) / clean.length) : null
  }

  return {
    funnel_summary: {
      schema_version: 'daily_pipeline_funnel_summary_v1',
      source_of_truth: 'screener_funnel_runs + screener_funnel_items',
      run_id: latestRun.run_id,
      status: latestRun.status,
      date: latestRun.date,
      created_at: latestRun.created_at,
      universe_count: finiteNumber(latestRun.universe_count),
      candidate_count: finiteNumber(latestRun.candidate_count),
      final_count: finiteNumber(latestRun.final_count),
      recommendation_count: recommendationCount,
      buy_signal_count: buySignalCount,
      hold_count: holdCount,
      emerging_count: finiteNumber(latestRun.emerging_count),
      layers,
      stage_counts: stageRows ?? [],
    },
    strategy_summary: {
      schema_version: 'daily_active_strategy_summary_v1',
      source_of_truth: 'strategy_spec_registry active rows + screener_funnel_items.l1_candidate_seed_after_overlay.evidence.strategy_pool_ids',
      run_id: latestRun.run_id,
      candidate_count: candidateSymbols.size,
      active_strategy_count: activeStrategyIds.size,
      observed_strategy_count: strategySymbols.size,
      strategies: strategyCounts,
      pairwise,
      avg_jaccard: avg(pairwise.map((row) => row.jaccard)),
      avg_corr: avg(pairwise.map((row) => row.corr)),
    },
  }
}

function formatAbsTwdAmountFromBillion(value: number): string {
  const abs = Math.abs(value)
  if (abs < 0.01 && abs > 0) return `${Math.round(abs * 10_000)}萬`
  return `${abs.toFixed(2)}億`
}

function buildEmergingBrokerEvidence(row: Record<string, any>): Record<string, any> | null {
  if (!isEmergingRecommendation(row)) return null
  const amountBillion = finiteNumber(row.broker_chip_cash_total_5d ?? row.chip_cash_total_5d)
  const netShares = finiteNumber(row.broker_net_shares_5d)
  if ((amountBillion == null || amountBillion === 0) && (netShares == null || netShares === 0)) return null
  const latestAmount = finiteNumber(row.broker_chip_cash_latest)
  const brokerCount = finiteNumber(row.broker_count_latest)
  const concentration = finiteNumber(row.broker_concentration_latest)
  const sourceDate = String(row.broker_flow_source_date ?? row.date ?? '')
  const source = String(row.broker_flow_source ?? 'finlab.rotc_broker_transactions')
  const direction = (amountBillion ?? 0) >= 0 ? '買超' : '賣超'
  const reasonParts = [`券商分點近5日${direction}${formatAbsTwdAmountFromBillion(amountBillion ?? 0)}`]
  if (brokerCount != null) reasonParts.push(`券商數${Math.round(brokerCount)}`)
  if (concentration != null) reasonParts.push(`集中度${concentration.toFixed(2)}`)
  return {
    source,
    source_date: sourceDate,
    broker_net_amount_5d_billion: amountBillion ?? 0,
    broker_net_amount_latest_billion: latestAmount ?? null,
    broker_net_shares_5d: netShares ?? null,
    broker_count_latest: brokerCount ?? null,
    concentration_latest: concentration ?? null,
    reason: reasonParts.join('、'),
  }
}

function isScoreV2Payload(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as any).version === SCORE_V2_VERSION)
}

function normalizeScoreV2ReasonText(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text) return ''
  return text
    .replace(/^【籌碼】[^｜\n]+｜/, '')
    .replace(/【技術】/g, 'Technical:')
    .replace(/【ML】/g, 'ML Edge:')
    .replace(/｜/g, '; ')
    .trim()
}

function mergeEmergingBrokerReason(reason: unknown, evidence: Record<string, any> | null): string | unknown {
  if (!evidence) return reason
  const chipReason = String(evidence.reason ?? '券商分點資料已更新')
  const text = normalizeScoreV2ReasonText(reason)
  if (!text) return `Score V2 Chip Flow evidence: ${chipReason}`
  if (text.includes(chipReason)) return text
  return text.includes('Score V2')
    ? `${text}; Chip Flow evidence: ${chipReason}`
    : `Score V2 Chip Flow evidence: ${chipReason}; ${text}`
}

function mergeEmergingBrokerScoreComponents(scoreComponents: unknown, evidence: Record<string, any> | null): unknown {
  if (!evidence) return scoreComponents
  if (!isScoreV2Payload(scoreComponents)) {
    return scoreComponents ? { ...(scoreComponents as Record<string, any>), chipEvidence: evidence } : null
  }
  const reasons = Array.isArray(scoreComponents.reasons)
    ? scoreComponents.reasons.map(String).filter(Boolean)
    : []
  reasons.push(`chipFlowEvidence:${String(evidence.reason ?? 'broker evidence updated')}`)
  return {
    ...scoreComponents,
    chipEvidence: evidence,
    reasons: Array.from(new Set(reasons)),
  }
}

function mergeEmergingBrokerWatchPoints(points: unknown, evidence: Record<string, any> | null): string[] {
  const list = Array.isArray(points) ? points.map((p) => String(p ?? '')).filter(Boolean) : []
  if (!evidence) return list
  const filtered = list.filter((p) => !p.includes('籌碼資料不足：興櫃或資料源未提供三大法人明細'))
  filtered.push(
    `chip_source=${evidence.source},source_date=${evidence.source_date},broker_net_amount_5d=${evidence.broker_net_amount_5d_billion},broker_net_shares_5d=${evidence.broker_net_shares_5d ?? 'n/a'},broker_count=${evidence.broker_count_latest ?? 'n/a'},concentration=${evidence.concentration_latest ?? 'n/a'}`,
  )
  return Array.from(new Set(filtered))
}

// GET /api/recommendations/daily?date=YYYY-MM-DD
// 不帶 date → 先查今天，沒資料則查上一個交易日（D1 最新有推薦的日期）
recommendations.get('/daily', async (c) => {
  const view = c.req.query('view') === 'card' ? 'card' : 'full'
  let date = c.req.query('date')
  const requestedDate = date
  let resolvedFrom: 'requested' | 'today' | 'fallback_prev' = date ? 'requested' : 'today'
  if (!date) {
    const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    // 先看今天有沒有
    const todayCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM daily_recommendations WHERE date = ? AND ${FINAL_RECOMMENDATION_WHERE}`
    ).bind(twToday).first<{ cnt: number }>()
    if ((todayCount?.cnt ?? 0) > 0) {
      date = twToday
    } else {
      // 沒有 → 查上一個交易日（最新有推薦資料的日期）
      const prev = await c.env.DB.prepare(
        `SELECT date FROM daily_recommendations WHERE date < ? AND ${FINAL_RECOMMENDATION_WHERE} ORDER BY date DESC LIMIT 1`
      ).bind(twToday).first<{ date: string }>()
      date = prev?.date ?? twToday
      if (date !== twToday) resolvedFrom = 'fallback_prev'
    }
  }
  const requestedOrToday = requestedDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const cardDataAsOfDate = String(requestedOrToday)
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, s.market, p.forecast_data AS prediction_forecast_data,
           ROUND(COALESCE(r.foreign_net_5d, 0), 6) AS chip_cash_foreign_5d,
           ROUND(COALESCE(r.trust_net_5d, 0), 6) AS chip_cash_trust_5d,
           0 AS dealer_net_5d,
           CASE
             WHEN r.recommendation_lane = 'emerging_watchlist'
               OR UPPER(COALESCE(r.market_segment, '')) = 'EMERGING'
             THEN ROUND(COALESCE((
               SELECT SUM(cbf.estimated_amount)
                 FROM canonical_broker_flow_daily cbf
                WHERE cbf.stock_id = r.symbol
                  AND cbf.date <= r.date
                  AND cbf.date >= date(r.date, '-14 days')
             ), 0) / 100000000.0, 6)
             ELSE ROUND(COALESCE(r.foreign_net_5d, 0) + COALESCE(r.trust_net_5d, 0), 6)
           END AS chip_cash_total_5d,
           ROUND(COALESCE((
             SELECT SUM(cbf.estimated_amount)
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
                AND cbf.date >= date(r.date, '-14 days')
           ), 0) / 100000000.0, 6) AS broker_chip_cash_total_5d,
           ROUND(COALESCE((
             SELECT cbf.estimated_amount
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ), 0) / 100000000.0, 6) AS broker_chip_cash_latest,
           (
             SELECT SUM(cbf.net_shares)
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
                AND cbf.date >= date(r.date, '-14 days')
           ) AS broker_net_shares_5d,
           (
             SELECT cbf.broker_count
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_count_latest,
           (
             SELECT cbf.concentration
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_concentration_latest,
           (
             SELECT cbf.source
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_flow_source,
           (
             SELECT cbf.date
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_flow_source_date,
           (
             SELECT sp.open
               FROM stock_prices sp
              WHERE sp.stock_id = r.stock_id
                AND sp.date <= r.date
              ORDER BY sp.date DESC
              LIMIT 1
           ) AS latest_open,
           (
             SELECT sp.avg_price
               FROM stock_prices sp
              WHERE sp.stock_id = r.stock_id
                AND sp.date <= r.date
              ORDER BY sp.date DESC
              LIMIT 1
           ) AS latest_avg_price
    FROM daily_recommendations r
    LEFT JOIN stocks s ON s.id = r.stock_id
    LEFT JOIN predictions p ON p.id = (
      SELECT p2.id
        FROM predictions p2
       WHERE p2.stock_id = r.stock_id
         AND p2.model_name = 'ensemble'
         AND p2.prediction_date = r.date
       ORDER BY p2.generated_at DESC, p2.id DESC
       LIMIT 1
    )
    WHERE r.date = ? AND ${FINAL_RECOMMENDATION_ROW_WHERE}
      AND COALESCE(r.recommendation_lane, '') != 'emerging_watchlist'
      AND UPPER(COALESCE(r.market_segment, s.market, '')) NOT IN ('EMERGING', 'ESB', 'ROTC')
    -- Frontend panels need the complete final set so BUY / potential BUY rows
    -- that rank beyond the card display limit are still eligible for priority UI.
    ORDER BY r.rank ASC
  `).bind(date).all<any>()

  const screenerFunnelBySymbol = new Map<string, any>()
  const resultSymbols = [...new Set((results ?? [])
    .map((r: any) => String(r.symbol ?? '').trim())
    .filter(Boolean))]
  const institutionalRawBySymbol = new Map<string, any>()
  const brokerTopFlowsBySymbol = new Map<string, any>()
  const brokerRankRowsBySymbol = new Map<string, any[]>()
  if (resultSymbols.length > 0) {
    const placeholders = resultSymbols.map(() => '?').join(',')
    try {
      const { results: chipRows } = await c.env.DB.prepare(`
        WITH latest_chip AS (
          SELECT symbol, MAX(date) AS date
            FROM chip_data
           WHERE date <= ?
             AND symbol IN (${placeholders})
           GROUP BY symbol
        )
        SELECT c.symbol, c.date,
               c.foreign_buy, c.foreign_sell, c.foreign_net,
               c.trust_buy, c.trust_sell, c.trust_net,
               c.dealer_buy, c.dealer_sell, c.dealer_net
          FROM chip_data c
          JOIN latest_chip l
            ON l.symbol = c.symbol
           AND l.date = c.date
      `).bind(cardDataAsOfDate, ...resultSymbols).all<any>()
      for (const row of chipRows ?? []) {
        const payload = buildInstitutionalRawToday(row)
        if (payload) institutionalRawBySymbol.set(String(row.symbol ?? '').trim(), payload)
      }
    } catch (e) {
      console.warn('[recommendations/daily] institutional raw card data unavailable:', e)
    }
    try {
      const rankTable = await c.env.DB.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name = 'canonical_broker_rank_daily'
         LIMIT 1
      `).first<{ name: string }>()
      if (rankTable?.name) {
        const { results: rankRows } = await c.env.DB.prepare(`
          WITH latest_rank AS (
            SELECT stock_id, MAX(date) AS date
              FROM canonical_broker_rank_daily
             WHERE date <= ?
               AND stock_id IN (${placeholders})
             GROUP BY stock_id
          )
          SELECT r.stock_id, r.date, r.market_segment, r.rank_side, r.rank_no,
                 r.broker_code, r.broker_name, r.buy_lots, r.sell_lots, r.net_lots, r.source
            FROM canonical_broker_rank_daily r
            JOIN latest_rank l
              ON l.stock_id = r.stock_id
             AND l.date = r.date
           WHERE r.rank_side IN ('buy', 'sell')
           ORDER BY r.stock_id ASC, r.rank_side ASC, r.rank_no ASC
        `).bind(cardDataAsOfDate, ...resultSymbols).all<any>()
        for (const row of rankRows ?? []) {
          const symbol = String(row.stock_id ?? '').trim()
          const rows = brokerRankRowsBySymbol.get(symbol) ?? []
          rows.push(row)
          brokerRankRowsBySymbol.set(symbol, rows)
        }
      }
    } catch (e) {
      console.warn('[recommendations/daily] broker top5 rank table unavailable:', e)
    }
    try {
      const { results: brokerRows } = await c.env.DB.prepare(`
        WITH latest_broker_flow AS (
          SELECT stock_id, MAX(date) AS date
            FROM canonical_broker_flow_daily
           WHERE date <= ?
             AND stock_id IN (${placeholders})
           GROUP BY stock_id
        )
        SELECT f.stock_id, f.date, f.market_segment, f.buy_shares, f.sell_shares, f.net_shares,
               f.dominant_net_shares, f.gross_imbalance_shares, f.estimated_amount,
               f.broker_count, f.concentration, f.source
          FROM canonical_broker_flow_daily f
          JOIN latest_broker_flow l
            ON l.stock_id = f.stock_id
           AND l.date = f.date
      `).bind(cardDataAsOfDate, ...resultSymbols).all<any>()
      for (const row of brokerRows ?? []) {
        const symbol = String(row.stock_id ?? '').trim()
        brokerTopFlowsBySymbol.set(
          symbol,
          buildBrokerTopFlowsToday(row, String(row.date ?? cardDataAsOfDate), brokerRankRowsBySymbol.get(symbol) ?? []),
        )
      }
    } catch (e) {
      console.warn('[recommendations/daily] broker flow card data unavailable:', e)
    }
  }
  if (resultSymbols.length > 0) {
    try {
      const placeholders = resultSymbols.map(() => '?').join(',')
      const { results: funnelRows } = await c.env.DB.prepare(`
        WITH latest_screener_run AS (
          SELECT run_id
            FROM screener_funnel_runs
           WHERE date = ?
           ORDER BY created_at DESC
           LIMIT 1
        )
        SELECT symbol, stage, decision, reason_code, score_before, score_after, rank, evidence
          FROM screener_funnel_items
         WHERE run_id = (SELECT run_id FROM latest_screener_run)
           AND symbol IN (${placeholders})
           AND stage IN (
             'universe',
             'scoring',
             'rrg_overlay',
             'buzz_evidence',
             'diversity_cooldown',
             'layer1_strategy_breadth_gate',
             'l15_ml_slate_queue',
             'layer2_timesfm_enrichment',
             'layer2_coarse_ml_gate',
             'layer3_formal_ml_gate',
             'l1_candidate_seed_after_overlay',
             'strategy_pool_ml_queue',
             'strategy_pool_research_only',
             'final_selection'
           )
         ORDER BY symbol ASC, created_at ASC
      `).bind(date, ...resultSymbols).all<any>()
      for (const [symbol, summary] of summarizeScreenerFunnelRows(funnelRows ?? [])) {
        screenerFunnelBySymbol.set(symbol, summary)
      }
    } catch (e) {
      console.warn('[recommendations/daily] screener funnel evidence unavailable:', e)
    }
  }

  const stockIds = [...new Set((results ?? []).map((r: any) => Number(r.stock_id)).filter((id: number) => Number.isFinite(id)))]
  const perModelByStock = new Map<number, any[]>()
  if (stockIds.length > 0) {
    const placeholders = stockIds.map(() => '?').join(',')
    const { results: perModelRows } = await c.env.DB.prepare(`
      SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data
        FROM predictions
       WHERE stock_id IN (${placeholders})
         AND model_name != 'ensemble'
         AND model_name NOT LIKE '%::challenger'
         AND prediction_date = ?
       ORDER BY stock_id, model_name
    `).bind(...stockIds, date).all<any>().catch(() => ({ results: [] as any[] }))
    for (const row of perModelRows ?? []) {
      const id = Number(row.stock_id)
      const list = perModelByStock.get(id) ?? []
      list.push(row)
      perModelByStock.set(id, list)
    }
  }

  // 解析 watch_points JSON
  const tradingConfig = await getTradingConfig(c.env.KV)
  const recs = (results ?? []).map((r: any) => {
    const forecastData = parsePredictionForecastData(r.prediction_forecast_data) ?? {}
    const persistedAlphaContext = parsePredictionForecastData(r.alpha_context)
    const persistedAlphaAllocation = parsePredictionForecastData(r.alpha_allocation)
    const alphaAllocation = forecastData?.alpha_allocation ?? persistedAlphaAllocation ?? null
    const l4SparseAllocation = buildSparseAllocationSummary(alphaAllocation)
    const persistedMlVoteSummary = parsePredictionForecastData(r.ml_vote_summary)
    const active8PersistedMlVoteSummary = persistedMlVoteSummary
      && Number(persistedMlVoteSummary.total ?? 0) <= DIRECT_ALPHA_VOTE_MODEL_NAMES.length
      ? persistedMlVoteSummary
      : null
    const persistedScoreComponents = parsePredictionForecastData(r.score_components)
    const screenerFunnel = screenerFunnelBySymbol.get(String(r.symbol ?? '').trim()) ?? null
    const screenerFunnelEvidenceBase = screenerFunnel?.evidence
      ? {
          ...screenerFunnel.evidence,
          ...(l4SparseAllocation ? { layer4_sparse_allocation: l4SparseAllocation } : {}),
        }
      : l4SparseAllocation
        ? { layer4_sparse_allocation: l4SparseAllocation }
        : null
    const perModelRows = perModelByStock.get(Number(r.stock_id)) ?? []
    const parsedWatchPoints = (() => { try { return JSON.parse(r.watch_points ?? '[]') } catch { return [] } })()
    const emergingBrokerEvidence = buildEmergingBrokerEvidence(r)
    const watchPoints = mergeEmergingBrokerWatchPoints(parsedWatchPoints, emergingBrokerEvidence)
    const scoreComponents = mergeEmergingBrokerScoreComponents(persistedScoreComponents, emergingBrokerEvidence)
    const board = classifyBoard({
      market: r.market,
      open: r.latest_open,
      avg_price: r.latest_avg_price,
      symbol: r.symbol,
    })
    const persistedLane = String(r.recommendation_lane || '').trim()
    const governance = resolveRecommendationGovernance(board, {
      recommendationLane: persistedLane,
      eligibleForMl: r.eligible_for_ml,
      eligibleForPendingBuy: r.eligible_for_pending_buy,
    })
    const hardGateSummary = buildHardGateSummary({
      boardType: board.boardType,
      tradabilityTier: board.tradabilityTier,
      recommendationLane: governance.recommendationLane,
      marketSegment: r.market_segment || board.boardType,
      boardReason: board.reason,
      persistedRecommendationLane: persistedLane,
      eligibleForMl: governance.eligibleForMl,
      eligibleForPendingBuy: governance.eligibleForPendingBuy,
    })
    const screenerFunnelEvidence = screenerFunnelEvidenceBase
      ? {
          ...screenerFunnelEvidenceBase,
          layer05_hard_gate: hardGateSummary,
        }
      : { layer05_hard_gate: hardGateSummary }
    return {
      ...r,
      market_segment: r.market_segment || board.boardType,
      board_type: board.boardType,
      tradability_tier: board.tradabilityTier,
      recommendation_lane: governance.recommendationLane,
      eligible_for_ml: governance.eligibleForMl,
      eligible_for_pending_buy: governance.eligibleForPendingBuy,
      board_reason: board.reason,
      l05_hard_gate: hardGateSummary,
      alpha_context: forecastData?.alpha_context ?? persistedAlphaContext ?? null,
      alpha_allocation: alphaAllocation,
      l4_sparse_allocation: l4SparseAllocation,
      ml_vote_summary: buildMlVoteSummary(forecastData, perModelRows, tradingConfig.signal) ?? active8PersistedMlVoteSummary,
      ml_diagnostics: buildMlDiagnostics(forecastData),
      score_components: scoreComponents,
      chip_evidence: emergingBrokerEvidence,
      reason: mergeEmergingBrokerReason(r.reason, emergingBrokerEvidence),
      screener_funnel_rank: screenerFunnel?.rank ?? null,
      screener_funnel_reason: screenerFunnel?.reason_code ?? null,
      screener_funnel_evidence: screenerFunnelEvidence,
      screener_funnel_timeline: screenerFunnel?.timeline ?? [],
      institutional_raw_today: institutionalRawBySymbol.get(String(r.symbol ?? '').trim()) ?? null,
      broker_top_flows_today: (() => {
        const symbol = String(r.symbol ?? '').trim()
        const rankRows = brokerRankRowsBySymbol.get(symbol) ?? []
        return brokerTopFlowsBySymbol.get(symbol)
          ?? buildBrokerTopFlowsToday(null, String(rankRows[0]?.date ?? r.date ?? date), rankRows)
      })(),
      watch_points: watchPoints,
    }
  })
  const evidenceLinksBySymbol = await loadRecommendationEvidenceLinks(
    c.env.DB,
    String(date),
    recs.map((r: any) => ({ symbol: String(r.symbol ?? ''), name: String(r.name ?? '') })),
    3,
  ).catch((e) => {
    console.warn('[recommendations/daily] evidence links unavailable:', e)
    return new Map<string, any[]>()
  })
  for (const rec of recs) {
    rec.evidence_links = evidenceLinksBySymbol.get(String(rec.symbol ?? '').trim()) ?? []
  }
  const tradableRecs = recs.filter((r: any) => r.recommendation_lane === 'tradable')
  const emergingRecs: any[] = []
  const researchOnlyRecs = recs.filter((r: any) => r.recommendation_lane === 'research_only')
  const shape = view === 'card' ? compactRecommendationForCard : (r: Record<string, any>) => r
  const tradablePayload = tradableRecs.map(shape)
  const emergingPayload = emergingRecs.map(shape)
  const researchOnlyPayload = researchOnlyRecs.map(shape)
  const allPayload = recs.map(shape)
  const strategyPortfolioIntelligenceHealth = summarizeStrategyPortfolioIntelligenceHealth(
    screenerFunnelBySymbol.values(),
    recs.length,
  )
  let pipelineSummaries: Record<string, any> = { funnel_summary: null, strategy_summary: null }
  try {
    pipelineSummaries = await buildDailyPipelineSummaries(c.env.DB, String(date))
  } catch (e) {
    console.warn('[recommendations/daily] daily pipeline summaries unavailable:', e)
  }

  return c.json({
    requested_date: requestedOrToday,
    date,
    is_stale: date !== requestedOrToday,
    resolved_from: resolvedFrom,
    view,
    recommendations: tradablePayload,
    tradable_recommendations: tradablePayload,
    emerging_recommendations: emergingPayload,
    research_only_recommendations: researchOnlyPayload,
    all_recommendations: allPayload,
    lanes: {
      tradable: { count: tradableRecs.length },
      emerging_watchlist: { count: emergingRecs.length },
      research_only: { count: researchOnlyRecs.length },
    },
    strategy_portfolio_intelligence_health: strategyPortfolioIntelligenceHealth,
    funnel_summary: pipelineSummaries.funnel_summary,
    strategy_summary: pipelineSummaries.strategy_summary,
    generated_at: recs[0]?.created_at ?? null,
  })
})

// GET /api/recommendations/history?days=7
// 近 N 天的推薦歷史（用於追蹤推薦準確率）
recommendations.get('/history', async (c) => {
  const days = Math.min(parsePosInt(c.req.query('days'), 7), 30)
  const { results } = await c.env.DB.prepare(`
    SELECT r.date, r.symbol, r.name, r.sector, r.rank, r.score,
           r.score_components, r.ml_score, r.chip_score, r.tech_score,
           COALESCE(r.momentum_score, 0) AS momentum_score,
           r.signal, r.confidence, r.has_buy_signal,
           r.current_price,
           -- 回測：推薦後實際表現（從 predictions 取）
           p.actual_return_pct, p.direction_correct, p.trade_outcome
    FROM daily_recommendations r
    LEFT JOIN predictions p
      ON p.stock_id = r.stock_id
      AND p.model_name = 'ensemble'
      AND p.prediction_date = r.date
    WHERE r.date >= date('now', '-' || ? || ' days')
    ORDER BY r.date DESC, r.rank ASC
  `).bind(days).all<any>()
  return c.json(results ?? [])
})

// GET /api/recommendations/sector-flow?date=YYYY-MM-DD&type=industry|theme
// 族群資金流向（可指定日期，預設今日；可指定分類，預設全部）
recommendations.get('/sector-flow', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const type = c.req.query('type') // 'industry' | 'theme' | undefined(all)

  const typeFilter = type ? 'AND classification = ?' : ''
  const binds = type ? [date, type] : [date]

  const { results } = await c.env.DB.prepare(`
    SELECT *
    FROM sector_flow
    WHERE date = ? ${typeFilter}
    ORDER BY total_net DESC
  `).bind(...binds).all<any>()

  // 若今天沒資料，取最近一筆
  if (!results?.length) {
    const { results: latest } = await c.env.DB.prepare(`
      SELECT *
      FROM sector_flow
      WHERE date = (SELECT MAX(date) FROM sector_flow WHERE 1=1 ${typeFilter})
      ${typeFilter}
      ORDER BY total_net DESC
    `).bind(...(type ? [type, type] : [])).all<any>()
    const staleDate = latest?.[0]?.date ?? null
    return c.json({
      date,
      requested_date: date,
      stale: Boolean(staleDate),
      stale_date: staleDate,
      flows: latest ?? [],
    })
  }

  return c.json({ date, requested_date: date, stale: false, stale_date: null, flows: results })
})

// GET /api/recommendations/sector-trend?sector=半導體&days=14&type=industry|theme
// 單一族群的資金流向趨勢
recommendations.get('/sector-trend', async (c) => {
  const sector = c.req.query('sector')
  const days   = Math.min(parsePosInt(c.req.query('days'), 14), 60)
  const type   = c.req.query('type')
  if (!sector) return c.json({ error: '請提供 sector 參數' }, 400)

  const typeFilter = type ? 'AND classification = ?' : ''
  const binds = type ? [sector, days, type] : [sector, days]

  const { results } = await c.env.DB.prepare(`
    SELECT date, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d, up_count, stock_count,
           classification, turnover_value, turnover_share, turnover_share_delta
    FROM sector_flow
    WHERE sector = ? AND date >= date('now', '-' || ? || ' days') ${typeFilter}
    ORDER BY date ASC
  `).bind(...binds).all<any>()
  return c.json({ sector, days, trend: results ?? [] })
})

// GET /api/recommendations/sector-flow-stocks?date=&theme=&classification=top|dark_horse
// 主題內個股法人買賣超明細
recommendations.get('/sector-flow-stocks', async (c) => {
  const date  = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const theme = c.req.query('theme')
  const cls   = c.req.query('classification')

  let sql = 'SELECT * FROM sector_flow_stocks WHERE date = ?'
  const binds: any[] = [date]

  if (theme) { sql += ' AND theme = ?'; binds.push(theme) }
  if (cls)   { sql += ' AND classification = ?'; binds.push(cls) }
  sql += ' ORDER BY theme, classification, net_amount DESC'

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>()

  // 若今天沒資料，fallback 最近一天
  if (!results?.length) {
    let fbSql = 'SELECT * FROM sector_flow_stocks WHERE date = (SELECT MAX(date) FROM sector_flow_stocks)'
    const fbBinds: any[] = []
    if (theme) { fbSql += ' AND theme = ?'; fbBinds.push(theme) }
    if (cls)   { fbSql += ' AND classification = ?'; fbBinds.push(cls) }
    fbSql += ' ORDER BY theme, classification, net_amount DESC'
    const { results: fb } = await c.env.DB.prepare(fbSql).bind(...fbBinds).all<any>()
    const staleDate = fb?.[0]?.date ?? null
    return c.json({
      date,
      requested_date: date,
      stale: Boolean(staleDate),
      stale_date: staleDate,
      stale_reason: staleDate
        ? `sector_flow_stocks has no rows for ${date}; latest detail snapshot is ${staleDate}, refusing stale fallback`
        : `sector_flow_stocks has no rows for ${date}`,
      stocks: [],
      stale_preview_count: fb?.length ?? 0,
    })
  }

  return c.json({ date, requested_date: date, stale: false, stale_date: null, stocks: results })
})

// GET /api/recommendations/daily-report?date=YYYY-MM-DD
// AI 整合報告（持久化版，含大盤/ML/推薦/績效/主題輪動）
recommendations.get('/daily-report', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  let report = await c.env.DB.prepare(
    'SELECT * FROM stock_analysis_reports WHERE date=? AND report_type=?'
  ).bind(date, 'daily').first<any>().catch(() => null)

  // fallback 最近一筆
  if (!report) {
    report = await c.env.DB.prepare(
      'SELECT * FROM stock_analysis_reports WHERE report_type=? ORDER BY date DESC LIMIT 1'
    ).bind('daily').first<any>().catch(() => null)
  }

  if (!report) return c.json({ report: null, date })

  // parse JSON fields
  const parsed = {
    date: report.date,
    report_type: report.report_type,
    market_summary: safeJSON(report.market_summary),
    ml_overview: safeJSON(report.ml_overview),
    buy_details: safeJSON(report.buy_details),
    sell_alerts: safeJSON(report.sell_alerts),
    recommendations: safeJSON(report.recommendations),
    performance: safeJSON(report.performance),
    theme_flow: safeJSON(report.theme_flow),
    created_at: report.created_at,
  }
  return c.json({ report: parsed, date: report.date })
})

function safeJSON(str: string | null): any {
  if (!str) return null
  try { return JSON.parse(str) } catch { return null }
}
