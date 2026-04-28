import {
  runBuyDebateBatchViaController,
  type BatchDebateCandidate,
  type StockProfile,
} from './debateTrader'
import { sendDiscordNotification } from './notify'
import {
  loadPendingBuySnapshot,
  replacePendingBuyState,
  type PendingBuy,
} from './pendingBuyStore'
import { getTradingConfig, type TradingConfig } from './tradingConfig'
import type { Bindings } from '../types'
import type { CircuitBreakerState as _CBState, LegacyLayerDeps } from './riskTypes'
import { checkP1Mdd } from './riskChecks/p1Mdd'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { checkP5Losses } from './riskChecks/p5Losses'
import { checkP6Momentum } from './riskChecks/p6Momentum'
import { checkP7Streak } from './riskChecks/p7Streak'

type CircuitBreakerState = _CBState

interface BuyRecommendationRow {
  symbol: string
  name: string | null
  signal: string
  confidence: number
  reason: string | null
  chip_score: number | null
  tech_score: number | null
  ml_score: number | null
  score: number | null
  ml_entry_price: number | null
  ml_stop_loss: number | null
  ml_target1: number | null
  ml_target2: number | null
  latest_close: number | null
  forecast_data?: string | null
  watch_points?: unknown
}

interface QuadrantInfo {
  theme: string
  quadrant: string
  rs_ratio: number
  rs_momentum: number
}

interface QuadrantFilterLogEntry {
  symbol: string
  name: string
  theme: string
  quadrant: string
  action: string
  momentum_dir?: string
}

interface AlphaForecastContext {
  edge_bucket?: string
  regime?: string
  sizing_multiplier?: number
  risk_overlay?: {
    volatility_level?: string
    liquidity_level?: string
    skip?: boolean
    flags?: string[]
  }
}

function getTwDate(offsetDays = 0): string {
  const now = Date.now() + 8 * 3600_000 + offsetDays * 86400_000
  return new Date(now).toISOString().slice(0, 10)
}

function parseWatchPoints(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  }
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
  } catch {
    return []
  }
}

function clampNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(lo, Math.min(hi, numeric))
}

function parseAlphaContext(rawForecastData: unknown): AlphaForecastContext | null {
  if (typeof rawForecastData !== 'string' || !rawForecastData.trim()) return null
  try {
    const forecastData = JSON.parse(rawForecastData)
    const ctx = forecastData?.alpha_context
    if (!ctx || typeof ctx !== 'object') return null
    return ctx as AlphaForecastContext
  } catch {
    return null
  }
}

function alphaWatchPoint(ctx: AlphaForecastContext | null): string | null {
  if (!ctx) return null
  const risk = ctx.risk_overlay ?? {}
  const sizing = clampNumber(ctx.sizing_multiplier, 0.25, 1.25, 1.0)
  return `Alpha overlay: ${ctx.edge_bucket ?? 'unknown'} / ${ctx.regime ?? 'unknown'}, sizing x${sizing.toFixed(2)}, risk=${risk.volatility_level ?? 'n/a'}/${risk.liquidity_level ?? 'n/a'}`
}

function calcRiskPct(
  signal: string,
  confidence: number,
  debateVerdict: string | undefined,
  cfg: TradingConfig,
): number {
  const position = cfg.position
  const baseline = position.riskPctBaseline ?? 0.01
  const buyRisk = position.riskPctBuy ?? 0.015
  const strongBuyRisk = position.riskPctStrongBuy ?? 0.02
  const buyThreshold = position.riskPctBuyConfThreshold ?? 0.7
  const strongBuyThreshold = position.riskPctStrongBuyConfThreshold ?? 0.8
  const downgradeMultiplier = position.downgradeRiskMultiplier ?? 0.5

  let risk = baseline
  if (signal.includes('STRONG_BUY') && confidence >= strongBuyThreshold) risk = strongBuyRisk
  else if (signal.includes('BUY') && confidence >= buyThreshold) risk = buyRisk
  if (debateVerdict === 'DOWNGRADE') risk *= downgradeMultiplier
  return risk
}

function calcKellyPct(
  confidence: number,
  entryPrice: number,
  stopLoss: number | null,
  target1: number | null,
  kellyCfg: { enabled: boolean; halfKelly: boolean; confClipLo: number; confClipHi: number; maxKellyPct: number },
): { pct: number; info: string } | null {
  if (!kellyCfg.enabled) return null
  if (!stopLoss || !target1) return null
  if (stopLoss >= entryPrice || target1 <= entryPrice) return null

  const p = Math.max(kellyCfg.confClipLo, Math.min(kellyCfg.confClipHi, confidence))
  const q = 1 - p
  const winR = (target1 - entryPrice) / entryPrice
  const lossR = (entryPrice - stopLoss) / entryPrice
  if (winR <= 0 || lossR <= 0) return null
  const b = winR / lossR

  const fullKelly = (p * b - q) / b
  if (fullKelly <= 0) return null

  const kelly = kellyCfg.halfKelly ? fullKelly * 0.5 : fullKelly
  const capped = Math.min(kelly, kellyCfg.maxKellyPct)
  return {
    pct: capped,
    info: `p=${p.toFixed(2)} b=${b.toFixed(2)} fullK=${(fullKelly * 100).toFixed(1)}% -> ${kellyCfg.halfKelly ? 'half' : 'full'}Kelly=${(capped * 100).toFixed(1)}%`,
  }
}

async function getPrevTradingDay(db: D1Database, kv?: KVNamespace): Promise<string> {
  const today = getTwDate()
  let latestAllowedDate: string | null = null

  if (kv) {
    const dt = new Date(`${today}T00:00:00Z`)
    for (let i = 1; i <= 14; i += 1) {
      const d = new Date(dt.getTime() - i * 86400000)
      const dateStr = d.toISOString().slice(0, 10)
      const dayOfWeek = d.getUTCDay()
      if (dayOfWeek === 0 || dayOfWeek === 6) continue
      const isHoliday = await kv.get(`holiday:${dateStr}`)
      if (isHoliday) continue
      latestAllowedDate = dateStr
      break
    }
  }

  const row = latestAllowedDate
    ? await db.prepare(
      'SELECT date FROM daily_recommendations WHERE date <= ? ORDER BY date DESC LIMIT 1',
    ).bind(latestAllowedDate).first<{ date: string }>()
    : await db.prepare(
      'SELECT date FROM daily_recommendations WHERE date < ? ORDER BY date DESC LIMIT 1',
    ).bind(today).first<{ date: string }>()

  return row?.date ?? latestAllowedDate ?? getTwDate(-1)
}

async function loadMacroContext(env: Bindings, tradeDate: string): Promise<{
  usContextStr?: string
  newsContextStr?: string
  taifexContextStr?: string
  taifex: { changePct: number; changePoints: number; lastPrice: number } | null
}> {
  const usSignal = await env.KV.get(`us:leading:${tradeDate}`, 'json') as any
  const usContextStr = usSignal
    ? [
        usSignal.sox_return != null ? `SOX ${usSignal.sox_return >= 0 ? '+' : ''}${(usSignal.sox_return * 100).toFixed(1)}%` : null,
        usSignal.gspc_return != null ? `S&P ${usSignal.gspc_return >= 0 ? '+' : ''}${(usSignal.gspc_return * 100).toFixed(1)}%` : null,
        usSignal.vix_close != null ? `VIX ${Number(usSignal.vix_close).toFixed(1)}` : null,
        usSignal.sentiment ? `Sentiment: ${usSignal.sentiment}` : null,
      ].filter(Boolean).join(' | ')
    : undefined

  let newsContextStr: string | undefined
  try {
    const { readCurrentNewsReport } = await import('./newsAnalyst')
    const newsReport = await readCurrentNewsReport(env.KV, tradeDate)
    if (newsReport) {
      const factors = (newsReport.key_factors ?? []).slice(0, 3).join(' / ')
      newsContextStr = `News Analyst bias=${newsReport.bias} conf=${Number(newsReport.confidence ?? 0).toFixed(2)} | ${factors}`
    }
  } catch (error) {
    console.warn('[PendingBuyOrchestrator] news analyst read failed:', error)
  }

  const { fetchTaifexNightClose } = await import('./twseApi')
  const taifex = await fetchTaifexNightClose().catch((error) => {
    console.warn('[PendingBuyOrchestrator] TAIFEX fetch failed:', error)
    return null
  })
  const taifexContextStr = taifex
    ? `TAIFEX ${taifex.lastPrice.toLocaleString()} ${taifex.changePct >= 0 ? '+' : ''}${taifex.changePct.toFixed(2)}% ${taifex.changePoints >= 0 ? '+' : ''}${taifex.changePoints.toFixed(0)}pt`
    : undefined

  return { usContextStr, newsContextStr, taifexContextStr, taifex }
}

async function loadStockProfiles(db: D1Database, symbols: string[]): Promise<Map<string, StockProfile>> {
  const profileMap = new Map<string, StockProfile>()
  if (!symbols.length) return profileMap
  try {
    const placeholders = symbols.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT symbol, business_desc, key_customers, key_suppliers
         FROM stock_profiles
        WHERE symbol IN (${placeholders})`,
    ).bind(...symbols).all<any>()
    for (const row of results ?? []) {
      profileMap.set(row.symbol, {
        business_desc: row.business_desc,
        key_customers: row.key_customers,
        key_suppliers: row.key_suppliers,
      })
    }
  } catch (error) {
    console.warn('[PendingBuyOrchestrator] stock_profiles query failed:', error)
  }
  return profileMap
}

async function loadPunishedSet(kv: KVNamespace): Promise<Set<string>> {
  try {
    const raw = await kv.get('market:punished_stocks', 'json') as string[] | null
    return new Set(raw ?? [])
  } catch {
    return new Set()
  }
}

async function loadQuadrantMap(db: D1Database, symbols: string[]): Promise<Map<string, QuadrantInfo>> {
  const symbolQuadrantMap = new Map<string, QuadrantInfo>()
  if (!symbols.length) return symbolQuadrantMap
  try {
    const placeholders = symbols.map(() => '?').join(',')
    const { results: tagRows } = await db.prepare(
      `SELECT symbol, tag
         FROM stock_tags
        WHERE symbol IN (${placeholders})
        ORDER BY symbol, weight DESC`,
    ).bind(...symbols).all<any>()
    const topTagBySymbol = new Map<string, string>()
    for (const row of tagRows ?? []) {
      if (!topTagBySymbol.has(row.symbol)) topTagBySymbol.set(row.symbol, row.tag)
    }

    const { results: quadrantRows } = await db.prepare(
      `SELECT sector, rs_ratio, rs_momentum, quadrant
         FROM sector_flow
        WHERE classification = 'theme'
          AND quadrant IS NOT NULL
          AND date = (
            SELECT MAX(date)
              FROM sector_flow
             WHERE classification = 'theme'
               AND quadrant IS NOT NULL
          )`,
    ).all<any>()
    const themeQuadrants = new Map<string, { quadrant: string; rs_ratio: number; rs_momentum: number }>()
    for (const row of quadrantRows ?? []) {
      themeQuadrants.set(row.sector, {
        quadrant: row.quadrant,
        rs_ratio: Number(row.rs_ratio),
        rs_momentum: Number(row.rs_momentum),
      })
    }

    for (const symbol of symbols) {
      const theme = topTagBySymbol.get(symbol)
      if (!theme) continue
      const info = themeQuadrants.get(theme)
      if (!info) continue
      symbolQuadrantMap.set(symbol, { theme, ...info })
    }
  } catch (error) {
    console.warn('[PendingBuyOrchestrator] quadrant query failed:', error)
  }
  return symbolQuadrantMap
}

async function collectCooldownSet(kv: KVNamespace, tradeDate: string, buyRecs: BuyRecommendationRow[]): Promise<{
  cooldownSet: Set<string>
  stopDayFrozen: boolean
}> {
  const { isOnCooldown, isStopDayFrozen } = await import('./postExit')
  const stopDayFrozen = await isStopDayFrozen(kv, tradeDate)
  const cooldownSet = new Set<string>()
  if (stopDayFrozen) return { cooldownSet, stopDayFrozen }
  for (const rec of buyRecs) {
    if (await isOnCooldown(kv, rec.symbol)) cooldownSet.add(rec.symbol)
  }
  return { cooldownSet, stopDayFrozen }
}

function applyRecommendationProvenance(buyRecs: BuyRecommendationRow[]): void {
  for (const rec of buyRecs) {
    try {
      const forecastData = rec.forecast_data ? JSON.parse(rec.forecast_data) : {}
      const ensemble = forecastData?.ensemble_v2 ?? {}
      const avgRank = typeof ensemble.avg_rank === 'number' ? ensemble.avg_rank : null
      const avgRankText = avgRank != null ? avgRank.toFixed(3) : '?'
      const ensembleSignal = ensemble.signal ?? 'unknown'

      let provenance: string | null = null
      if (ensemble.topk_forced === true) {
        provenance =
          `Signal Provenance (ensemble Top-K): BUY forced at ensemble layer (signal_raw=${ensemble.signal_raw ?? 'HOLD'}, avg_rank=${avgRankText}). ` +
          'Judge on business merit and industry context, not raw signal strength.'
      } else if (/BUY/i.test(rec.signal ?? '') && ensembleSignal !== 'unknown' && !/BUY/i.test(ensembleSignal)) {
        provenance =
          `Signal Provenance (ranking promoted): BUY flipped at recommendation layer (ensemble_v2.signal=${ensembleSignal}, avg_rank=${avgRankText}). ` +
          'Treat as ranking promotion, not a naturally strong BUY.'
      }

      if (provenance) rec.reason = `${provenance}\n\n${rec.reason ?? ''}`
    } catch (error) {
      console.warn(`[PendingBuyOrchestrator] forecast_data parse failed for ${rec.symbol}:`, error)
    }
  }
}

async function persistPendingBuys(
  env: Bindings,
  tradeDate: string,
  pendingBuys: PendingBuy[],
  meta?: Record<string, unknown>,
): Promise<void> {
  const pendingKey = `paper:pending_buys:${tradeDate}`
  const pendingMetaKey = `paper:pending_buys_meta:${tradeDate}`
  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate: typeof meta?.prev_day === 'string' ? String(meta.prev_day) : null,
    status: (meta?.status as any) ?? 'ready',
    debateStatus: (meta?.debate_status as any) ?? (
      pendingBuys.some((item) => item.debate_verdict === 'PENDING' || item.debate_status === 'pending')
        ? 'pending'
        : 'completed'
    ),
    errorMessage: typeof meta?.reason === 'string' ? String(meta.reason) : null,
    pendingBuys,
    meta,
  }).catch(async (persistError) => {
    console.warn('[PendingBuyOrchestrator] D1 persist failed, fallback to KV:', persistError)
    await env.KV.put(pendingKey, JSON.stringify(pendingBuys), { expirationTtl: 86400 })
    if (!meta) return
    await env.KV.put(
      pendingMetaKey,
      JSON.stringify({ updated_at: new Date().toISOString(), ...meta }),
      { expirationTtl: 86400 },
    )
  })
  await env.KV.put(pendingKey, JSON.stringify(pendingBuys), { expirationTtl: 86400 })
  if (!meta) return
  await env.KV.put(
    pendingMetaKey,
    JSON.stringify({ updated_at: new Date().toISOString(), ...meta }),
    { expirationTtl: 86400 },
  )
}

export async function checkCircuitBreakers(
  db: D1Database,
  cfg: TradingConfig,
  kv?: KVNamespace,
): Promise<CircuitBreakerState> {
  const circuit = cfg.circuit
  let buyConfBase = circuit.buyConfThreshold
  let sellConfBase = circuit.sellConfThreshold
  let confidenceDelta = 0
  const clipLo = cfg.L2_formula?.confidence_effective_clip_lo ?? 0.45
  const clipHi = cfg.L2_formula?.confidence_effective_clip_hi ?? 0.75

  if (kv) {
    try {
      const { getAdaptiveParams } = await import('./adaptiveConfig')
      const adaptive = await getAdaptiveParams(kv)
      if (adaptive?.confidence_delta != null) {
        confidenceDelta = adaptive.confidence_delta
      } else if (adaptive?.confidence_threshold != null) {
        confidenceDelta = adaptive.confidence_threshold - (circuit.buyConfThreshold ?? 0.6)
      }
    } catch (error) {
      console.warn('[PendingBuyOrchestrator] adaptive params load failed:', error)
    }
  }

  const effectiveBuy = Math.max(clipLo, Math.min(clipHi, buyConfBase + confidenceDelta))
  const effectiveSell = Math.max(clipLo, Math.min(clipHi, sellConfBase + confidenceDelta))
  const defaults: CircuitBreakerState = {
    halt: false,
    maxPositionPct: circuit.maxPositionPct,
    buyConfThreshold: effectiveBuy,
    sellConfThreshold: effectiveSell,
  }
  const deps: LegacyLayerDeps = { defaults, effectiveBuy, effectiveSell }

  const flag = (await kv?.get('risk:use_chain')) ?? 'v1'
  if (flag === 'v1') {
    const { runPortfolioChecks } = await import('./riskChain')
    const agg = await runPortfolioChecks(db, cfg, kv, deps)
    return {
      halt: agg.halt,
      reason: agg.reason || undefined,
      maxPositionPct: agg.maxPositionPct,
      buyConfThreshold: agg.buyConfThreshold,
      sellConfThreshold: agg.sellConfThreshold,
      momentumZone: agg.momentumZone,
    }
  }

  const layers: Array<() => Promise<CircuitBreakerState | null>> = [
    () => checkP1Mdd(db, cfg, deps),
    () => checkP2Accuracy(db, kv, cfg, deps),
    () => checkP3MarketRisk(db, cfg, deps),
    () => checkP4Breadth(db, cfg, deps),
    () => checkP6Momentum(db, deps),
    () => checkP7Streak(db, cfg, deps),
    () => checkP5Losses(db, deps),
  ]
  for (const run of layers) {
    const result = await run()
    if (result) return result
  }
  return defaults
}

export async function setupMorningPendingBuys(env: Bindings): Promise<void> {
  console.log('[MorningSetup] Starting...')
  const cfg = await getTradingConfig(env.KV)
  const pendingDate = getTwDate()
  const cb = await checkCircuitBreakers(env.DB, cfg, env.KV)
  console.log(
    `[MorningSetup] circuit halt=${cb.halt} buyConfThreshold=${cb.buyConfThreshold} maxPositionPct=${cb.maxPositionPct} reason=${cb.reason ?? 'none'}`,
  )

  {
    const { writeAuditEntry } = await import('./riskAudit')
    writeAuditEntry(env.DB, {
      triggerEvent: 'morning_setup',
      decision: cb.halt ? 'halt' : 'executed',
      riskState: cb,
    }).catch(() => {})
  }

  if (cb.halt) {
    await persistPendingBuys(env, pendingDate, [], {
      status: 'halted',
      reason: cb.reason ?? 'circuit_breaker',
    })
    return
  }

  try {
    const prevDay = await getPrevTradingDay(env.DB, env.KV)
    const { results } = await env.DB.prepare(`
      SELECT dr.symbol, dr.name, dr.signal, dr.confidence, dr.reason,
             dr.watch_points, dr.chip_score, dr.tech_score, dr.ml_score, dr.score,
             p.entry_price AS ml_entry_price,
             p.stop_loss AS ml_stop_loss,
             p.target1 AS ml_target1,
             p.target2 AS ml_target2,
             (
               SELECT sp.close
                 FROM stock_prices sp
                WHERE sp.stock_id = s.id
                  AND sp.date <= dr.date
                ORDER BY sp.date DESC
                LIMIT 1
             ) AS latest_close,
             p.forecast_data AS forecast_data
        FROM daily_recommendations dr
        LEFT JOIN stocks s ON s.symbol = dr.symbol
        LEFT JOIN predictions p ON p.id = (
          SELECT p2.id
            FROM predictions p2
           WHERE p2.stock_id = s.id
             AND p2.model_name = 'ensemble'
             AND date(p2.generated_at, '+8 hours') IN (dr.date, ?)
           ORDER BY p2.generated_at DESC, p2.id DESC
           LIMIT 1
        )
       WHERE dr.date = ?
         AND dr.has_buy_signal = 1
         AND dr.confidence >= ?
       ORDER BY dr.score DESC, dr.confidence DESC
       LIMIT 3
    `).bind(pendingDate, prevDay, cb.buyConfThreshold).all<BuyRecommendationRow>()

    const buyRecs = (results ?? []) as BuyRecommendationRow[]
    applyRecommendationProvenance(buyRecs)
    if (buyRecs.length === 0) {
      await persistPendingBuys(env, pendingDate, [], {
        status: 'empty',
        reason: 'no_buy_recommendations',
        prev_day: prevDay,
      })
      return
    }

    const { newsContextStr, taifex, taifexContextStr } = await loadMacroContext(env, pendingDate)
    if (newsContextStr) {
      try {
        const { readCurrentNewsReport } = await import('./newsAnalyst')
        const newsReport = await readCurrentNewsReport(env.KV, pendingDate)
        const newsNegThreshold = cfg.signal.newsNegativeConfThreshold ?? 0.5
        if (newsReport?.bias === 'negative' && Number(newsReport.confidence ?? 0) >= newsNegThreshold) {
          const before = cb.buyConfThreshold
          const newsBoost = cfg.signal.newsNegativeConfBoost ?? 0.05
          const newsCap = cfg.signal.newsNegativeConfCap ?? 0.75
          cb.buyConfThreshold = Math.min(newsCap, cb.buyConfThreshold + newsBoost)
          console.warn(
            `[MorningSetup] news tightened buyConfThreshold ${before.toFixed(3)} -> ${cb.buyConfThreshold.toFixed(3)}`,
          )
        }
      } catch {
        // already logged in loadMacroContext
      }
    }

    const punishedSet = await loadPunishedSet(env.KV)
    const { cooldownSet, stopDayFrozen } = await collectCooldownSet(env.KV, pendingDate, buyRecs)
    if (stopDayFrozen) {
      await persistPendingBuys(env, pendingDate, [], {
        status: 'empty',
        reason: 'stop_day_freeze',
        prev_day: prevDay,
      })
      return
    }

    const quadrantMap = await loadQuadrantMap(env.DB, buyRecs.map((rec) => rec.symbol))
    const quadrantFilterLog: QuadrantFilterLogEntry[] = []
    const pendingBuys: PendingBuy[] = []
    const downgradeMultiplier = cfg.position.downgradeRiskMultiplier ?? 0.5

    for (const rec of buyRecs) {
      if (punishedSet.has(rec.symbol)) continue
      if (cooldownSet.has(rec.symbol)) continue
      if (!rec.ml_entry_price || rec.ml_entry_price <= 0) continue
      const alphaContext = parseAlphaContext(rec.forecast_data)
      if (alphaContext?.risk_overlay?.skip === true) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: alphaContext.edge_bucket ?? 'alpha',
          quadrant: alphaContext.regime ?? 'unknown',
          action: 'ALPHA_SKIP',
        })
        continue
      }

      const quadrant = quadrantMap.get(rec.symbol)
      if (quadrant?.quadrant === 'Lagging') {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          quadrant: quadrant.quadrant,
          action: 'REJECT',
        })
        continue
      }

      let debateVerdict = 'PENDING'
      let riskPct = calcRiskPct(rec.signal, rec.confidence, undefined, cfg)
      const alphaSizing = clampNumber(alphaContext?.sizing_multiplier, 0.25, 1.25, 1.0)
      riskPct *= alphaSizing
      if (quadrant?.quadrant === 'Weakening') {
        debateVerdict = 'DOWNGRADE'
        riskPct *= downgradeMultiplier
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          quadrant: quadrant.quadrant,
          action: 'DOWNGRADE',
        })
      } else if (quadrant) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          quadrant: quadrant.quadrant,
          action: 'PASS',
          momentum_dir: quadrant.rs_momentum >= 0 ? 'up' : 'down',
        })
      }

      let adjustedEntry = rec.ml_entry_price
      let adjustedStop = rec.ml_stop_loss
      let adjustedTarget1 = rec.ml_target1
      let adjustedTarget2 = rec.ml_target2
      const entryWatchPoints: string[] = []
      const originalEntry = rec.ml_entry_price
      const nightDropPct = taifex?.changePct ?? 0
      const l2 = cfg.L2_formula
      if (nightDropPct < l2.night_drop_severe_pct && debateVerdict === 'DOWNGRADE') {
        adjustedEntry = Math.round(rec.ml_entry_price * l2.night_drop_severe_adjust * 100) / 100
        adjustedStop = adjustedStop != null
          ? Math.round(adjustedStop * l2.night_drop_severe_adjust * 100) / 100
          : adjustedStop
      } else if (nightDropPct < l2.night_drop_mild_pct && debateVerdict !== 'APPROVE') {
        adjustedEntry = Math.round(rec.ml_entry_price * l2.night_drop_mild_adjust * 100) / 100
        adjustedStop = adjustedStop != null
          ? Math.round(adjustedStop * l2.night_drop_mild_adjust * 100) / 100
          : adjustedStop
      }

      const prevDayTs = new Date(`${prevDay}T00:00:00Z`).getTime()
      const todayTs = new Date(`${pendingDate}T00:00:00Z`).getTime()
      const holidayGapDays = Math.max(1, Math.round((todayTs - prevDayTs) / 86400000))
      if (holidayGapDays >= 3 && nightDropPct > 1.0) {
        const impliedGap = nightDropPct / 100
        const gapThreshold = cfg.circuit.preMarketGapThreshold ?? 0.05
        if (impliedGap > gapThreshold) continue
        const chasePct = Math.min(impliedGap, gapThreshold)
        const gapBuffer = cfg.position.gapChaseBuffer ?? 0.995
        const newEntry = Math.round(rec.ml_entry_price * (1 + chasePct) * gapBuffer * 100) / 100
        if (newEntry > adjustedEntry) {
          adjustedEntry = newEntry
          if (adjustedStop != null) adjustedStop = Math.round(adjustedStop * (1 + chasePct) * 100) / 100
        }
      }

      const latestClose = Number(rec.latest_close ?? 0)
      const maxPremium = cfg.position.maxEntryPremiumPct ?? 0.01
      if (latestClose > 0) {
        const maxEntry = Math.round(latestClose * (1 + maxPremium) * 100) / 100
        if (adjustedEntry > maxEntry) {
          const ratio = maxEntry / adjustedEntry
          adjustedEntry = maxEntry
          adjustedStop = adjustedStop != null ? Math.round(adjustedStop * ratio * 100) / 100 : adjustedStop
          adjustedTarget1 = adjustedTarget1 != null ? Math.round(adjustedTarget1 * ratio * 100) / 100 : adjustedTarget1
          adjustedTarget2 = adjustedTarget2 != null ? Math.round(adjustedTarget2 * ratio * 100) / 100 : adjustedTarget2
          entryWatchPoints.push(
            `Entry capped to latest close + ${(maxPremium * 100).toFixed(1)}% (${latestClose} -> ${maxEntry})`,
          )
        }
      }

      const kellyResult = calcKellyPct(
        rec.confidence,
        adjustedEntry,
        adjustedStop,
        rec.ml_target1,
        cfg.position.kelly,
      )
      if (kellyResult) {
        console.log(`[MorningSetup] ${rec.symbol} ${kellyResult.info}`)
      }

      pendingBuys.push({
        symbol: rec.symbol,
        name: rec.name ?? rec.symbol,
        signal: rec.signal,
        confidence: rec.confidence,
        ml_entry_price: adjustedEntry,
        ml_stop_loss: adjustedStop,
        ml_target1: adjustedTarget1,
        ml_target2: adjustedTarget2,
        reason: rec.reason ?? '',
        watch_points: [
          ...parseWatchPoints(rec.watch_points),
          ...([alphaWatchPoint(alphaContext)].filter(Boolean) as string[]),
          ...entryWatchPoints,
        ],
        debate_verdict: debateVerdict,
        debate_status: debateVerdict === 'PENDING' ? 'pending' : 'completed',
        risk_pct: riskPct,
        kelly_pct: kellyResult?.pct ?? null,
        chip_score: rec.chip_score ?? null,
        tech_score: rec.tech_score ?? null,
        ml_score: rec.ml_score ?? null,
        score: rec.score ?? null,
        source: 'morning_setup',
        original_entry: originalEntry,
      })
    }

    await persistPendingBuys(env, pendingDate, pendingBuys, {
      status: 'ready',
      count: pendingBuys.length,
      prev_day: prevDay,
    })

    if (quadrantFilterLog.length > 0) {
      await env.KV.put(
        `paper:quadrant_filter:${pendingDate}`,
        JSON.stringify(quadrantFilterLog),
        { expirationTtl: 7 * 86400 },
      )
    }

    if (pendingBuys.length > 0) {
      const summary = pendingBuys.map((item) => `${item.symbol} @${item.ml_entry_price}`).join(', ')
      console.log(`[MorningSetup] generated ${pendingBuys.length} pending buys: ${summary}`)
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        `Paper pending buys (${pendingBuys.length})\n${pendingBuys
          .map((item) => `- ${item.symbol} ${item.name} @ ${item.ml_entry_price} ${item.signal} ${(item.confidence * 100).toFixed(0)}%${item.debate_verdict !== 'APPROVE' ? ` [${item.debate_verdict}]` : ''}`)
          .join('\n')}`,
      )
    } else {
      console.log('[MorningSetup] no pending buys after filters')
    }

    void taifexContextStr
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[MorningSetup] failed before pending buys persisted:', error)
    await persistPendingBuys(env, pendingDate, [], { status: 'error', reason: message })
    throw error
  }
}

export async function reconcilePendingBuyDebates(
  env: Bindings,
  tradeDate = getTwDate(),
): Promise<string> {
  const snapshot = await loadPendingBuySnapshot(env, tradeDate, { allowFallbackRecent: false })
  const pendingItems = snapshot.pendingBuys.filter((item) =>
    (item.debate_verdict ?? 'PENDING') === 'PENDING' || (item.debate_status ?? 'pending') === 'pending',
  )
  if (!pendingItems.length) return 'no_pending_debate'
  if (!env.ML_CONTROLLER_URL) return 'skip:no_controller'

  const cfg = await getTradingConfig(env.KV)
  const { usContextStr, newsContextStr, taifexContextStr } = await loadMacroContext(env, tradeDate)
  const profileMap = await loadStockProfiles(env.DB, pendingItems.map((item) => item.symbol))
  const mergedUsContext = [newsContextStr, usContextStr].filter(Boolean).join(' || ')
  const candidates: BatchDebateCandidate[] = pendingItems.map((item) => ({
    symbol: item.symbol,
    stock_name: item.name ?? item.symbol,
    signal: item.signal,
    confidence: item.confidence,
    reasoning: item.reason ?? 'ML ensemble signal',
    us_context: mergedUsContext || undefined,
    taifex_context: taifexContextStr,
    stock_profile: profileMap.get(item.symbol)
      ? {
          business_desc: profileMap.get(item.symbol)?.business_desc ?? undefined,
          key_customers: profileMap.get(item.symbol)?.key_customers ?? undefined,
          key_suppliers: profileMap.get(item.symbol)?.key_suppliers ?? undefined,
        }
      : undefined,
    cache_key_date: tradeDate,
  }))

  const results = await runBuyDebateBatchViaController(candidates, {
    ML_CONTROLLER_URL: env.ML_CONTROLLER_URL,
    ML_CONTROLLER_SECRET: env.ML_CONTROLLER_SECRET,
  })
  const sourceRecoDate = typeof snapshot.meta?.source_reco_date === 'string'
    ? String(snapshot.meta.source_reco_date)
    : tradeDate

  if (!results || results.size === 0) {
    await replacePendingBuyState(env, {
      tradeDate,
      sourceRecoDate,
      status: 'ready',
      debateStatus: 'failed',
      errorMessage: 'debate_batch_unavailable',
      pendingBuys: snapshot.pendingBuys.map((item) =>
        pendingItems.some((pending) => pending.symbol === item.symbol)
          ? { ...item, debate_status: 'failed' }
          : item,
      ),
      meta: { stage: 'debate_async' },
    })
    return 'debate_unavailable'
  }

  const downgradeMultiplier = cfg.position.downgradeRiskMultiplier ?? 0.5
  const nextPendingBuys: PendingBuy[] = []
  let failedCount = 0

  for (const item of snapshot.pendingBuys) {
    const debate = results.get(item.symbol)
    if (!pendingItems.some((pending) => pending.symbol === item.symbol)) {
      nextPendingBuys.push(item)
      continue
    }
    if (!debate) {
      failedCount += 1
      nextPendingBuys.push({ ...item, debate_status: 'failed' })
      continue
    }
    if (debate.verdict === 'REJECT') continue
    nextPendingBuys.push({
      ...item,
      debate_verdict: debate.verdict,
      debate_status: 'completed',
      risk_pct: debate.verdict === 'DOWNGRADE' ? item.risk_pct * downgradeMultiplier : item.risk_pct,
    })
  }

  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate,
    status: 'ready',
    debateStatus: failedCount > 0 ? 'failed' : 'completed',
    pendingBuys: nextPendingBuys,
    meta: {
      stage: 'debate_async',
      updated_symbols: candidates.map((item) => item.symbol),
      failed_count: failedCount,
    },
  })

  return `debated=${results.size} failed=${failedCount} remaining=${nextPendingBuys.length}`
}
