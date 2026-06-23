import {
  runBuyDebateBatchViaController,
  type BatchDebateCandidate,
  type StockProfile,
} from './debateTrader'
import { enrichMorningDebateCandidatesWithBreeze2, extractBreeze2WatchPoint } from './breeze2Runtime'
import { sendDiscordNotification } from './notify'
import {
  expireRecentPendingBuys,
  loadPendingBuySnapshot,
  replacePendingBuyState,
  type PendingBuy,
} from './pendingBuyStore'
import { getTradingConfig, type TradingConfig } from './tradingConfig'
import { capEntryToLatestClose } from './entryPricePolicy'
import { classifyBoard } from './boardTradability'
import {
  buildMarketStructureWatchPoint,
  buildSparseAllocationSummary,
  buildMlVoteSummary,
  buildMlVoteWatchPoint,
  parsePredictionForecastData,
  type PerModelPredictionRow,
} from './recommendationContext'
import { buildL4SparseAllocationWatchPoint } from './l4SparseAllocationSizing'
import type { Bindings } from '../types'
import type { CircuitBreakerState as _CBState, LegacyLayerDeps } from './riskTypes'
import {
  applyPendingBuyExecutionStatusUpdates,
} from './pendingBuyExecutionState'
import { recordPendingBuyPaperAttribution } from './paperActiveAttributionWiring'
import { checkP1Mdd } from './riskChecks/p1Mdd'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { loadTradingRestrictionSet } from './tradingRestrictions'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { checkP5Losses } from './riskChecks/p5Losses'
import { checkP6Momentum } from './riskChecks/p6Momentum'
import { checkP7Streak } from './riskChecks/p7Streak'
import { readScoreV2Snapshot, serializeScoreV2Snapshot } from './scoreV2Taxonomy'
import {
  batchLoadOhlcvTradePlanLevels,
  formatOhlcvTradePlanWatchPoint,
  resolveOhlcvEntryPlan,
} from './ohlcvTradePlanLevels'
import {
  buildEntryPriceModelV2FromOhlcvPlan,
  formatEntryPriceModelV2WatchPoint,
} from './entryPriceModelV2'

type CircuitBreakerState = _CBState

interface BuyRecommendationRow {
  stock_id: number | null
  symbol: string
  name: string | null
  signal: string | null
  confidence: number
  has_buy_signal?: number | null
  eligible_for_ml?: number | null
  eligible_for_pending_buy?: number | null
  reason: string | null
  score_components: unknown
  ml_entry_price: number | null
  ml_stop_loss: number | null
  ml_target1: number | null
  ml_target2: number | null
  latest_close: number | null
  latest_open: number | null
  latest_avg_price: number | null
  market: string | null
  forecast_data?: string | null
  signal_source?: string | null
  alpha_allocation?: string | null
  watch_points?: unknown
}

interface QuadrantInfo {
  theme: string
  classification: string
  quadrant: string
  rs_ratio: number
  rs_momentum: number
  rotation_score?: number | null
  rotation_regime?: string | null
  rotation_hysteresis?: string | null
  rotation_velocity?: number | null
  rotation_acceleration?: number | null
  quadrant_age?: number | null
  transition_path?: string | null
  rotation_window?: number | null
}

interface QuadrantFilterLogEntry {
  symbol: string
  name: string
  theme: string
  classification?: string
  quadrant: string
  action: string
  stage?: string
  reason_code?: string
  rs_ratio?: number
  rs_momentum?: number
  risk_multiplier?: number
  details?: Record<string, unknown>
  momentum_dir?: string
}

interface PendingBuyFilterAuditSummary {
  version: 'pending_buy_filter_audit_v1'
  initial_buy_signals: number
  board_reject: number
  cooldown_reject: number
  missing_entry: number
  score_v2_missing: number
  alpha_skip: number
  rrg_unmapped_neutral: number
  rrg_lagging_soft_downgrade: number
  rrg_weakening_downgrade: number
  rrg_pass: number
  gap_reject: number
  final_candidates: number
  debate_pending: number
  debate_completed: number
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
    structure_detail?: Record<string, unknown>
  }
}

async function persistPendingDebateFailure(
  env: Bindings,
  tradeDate: string,
  snapshot: Awaited<ReturnType<typeof loadPendingBuySnapshot>>,
  pendingItems: PendingBuy[],
  reason: string,
): Promise<string> {
  const transition = applyPendingBuyExecutionStatusUpdates(
    snapshot.pendingBuys,
    pendingItems.map((item) => ({
      symbol: item.symbol,
      status: 'pending',
      reason: `debate_retry:${reason}`,
    })),
  )
  const nextPendingBuys = transition.allItems as PendingBuy[]
  const activeItems = transition.activeItems as PendingBuy[]
  const sourceRecoDate = typeof snapshot.meta?.source_reco_date === 'string'
    ? String(snapshot.meta.source_reco_date)
    : tradeDate

  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate,
    status: 'ready',
    debateStatus: 'pending',
    errorMessage: reason,
    pendingBuys: nextPendingBuys,
    kvPendingBuys: activeItems,
    meta: {
      stage: 'debate_async',
      retry_reason: reason,
      active_summary: transition.activeSummary,
      retry_symbols: pendingItems.map((item) => item.symbol),
    },
  })

  return `debate_retry_pending=${pendingItems.length} reason=${reason} active=${activeItems.length}`
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
  const forecastData = parsePredictionForecastData(rawForecastData)
  const ctx = forecastData?.alpha_context
  return ctx && typeof ctx === 'object' ? ctx as AlphaForecastContext : null
}

function alphaWatchPoint(ctx: AlphaForecastContext | null): string | null {
  if (!ctx) return null
  const risk = ctx.risk_overlay ?? {}
  const sizing = clampNumber(ctx.sizing_multiplier, 0.25, 1.25, 1.0)
  return `Alpha bucket: ${ctx.edge_bucket ?? 'unknown'}, regime=${ctx.regime ?? 'unknown'}, sizing x${sizing.toFixed(2)}, risk=${risk.volatility_level ?? 'n/a'}/${risk.liquidity_level ?? 'n/a'}`
}

function newFilterAuditSummary(initialBuySignals: number): PendingBuyFilterAuditSummary {
  return {
    version: 'pending_buy_filter_audit_v1',
    initial_buy_signals: initialBuySignals,
    board_reject: 0,
    cooldown_reject: 0,
    missing_entry: 0,
    score_v2_missing: 0,
    alpha_skip: 0,
    rrg_unmapped_neutral: 0,
    rrg_lagging_soft_downgrade: 0,
    rrg_weakening_downgrade: 0,
    rrg_pass: 0,
    gap_reject: 0,
    final_candidates: 0,
    debate_pending: 0,
    debate_completed: 0,
  }
}

type PendingBuyFilterAuditCounter = Exclude<keyof PendingBuyFilterAuditSummary, 'version'>

function incAudit(summary: PendingBuyFilterAuditSummary, key: PendingBuyFilterAuditCounter): void {
  summary[key] = Number(summary[key] ?? 0) + 1
}

function inferEmptyReason(summary: PendingBuyFilterAuditSummary): string | undefined {
  if (summary.final_candidates > 0) return undefined
  if (summary.initial_buy_signals <= 0) return 'no_buy_recommendations'
  const hardRejects = summary.board_reject + summary.cooldown_reject + summary.missing_entry + summary.score_v2_missing + summary.alpha_skip + summary.gap_reject
  if (hardRejects >= summary.initial_buy_signals) return 'empty_after_hard_safety'
  return 'empty_after_soft_risk'
}

function isMissingAuditTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table: pending_buy_filter_audit/i.test(message)
}

async function persistPendingBuyFilterAudit(
  env: Bindings,
  runId: number | null,
  tradeDate: string,
  sourceRecoDate: string,
  entries: QuadrantFilterLogEntry[],
): Promise<void> {
  if (!runId || entries.length === 0) return
  try {
    for (const entry of entries) {
      await env.DB.prepare(
        `INSERT INTO pending_buy_filter_audit
          (run_id, trade_date, source_reco_date, symbol, name, stage, action, reason_code,
           theme, classification, quadrant, rs_ratio, rs_momentum, risk_multiplier, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(
        runId,
        tradeDate,
        sourceRecoDate,
        entry.symbol,
        entry.name,
        entry.stage ?? 'morning_setup',
        entry.action,
        entry.reason_code ?? entry.action,
        entry.theme,
        entry.classification ?? null,
        entry.quadrant,
        entry.rs_ratio ?? null,
        entry.rs_momentum ?? null,
        entry.risk_multiplier ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
      ).run()
    }
  } catch (error) {
    if (isMissingAuditTableError(error)) {
      console.warn('[MorningSetup] pending_buy_filter_audit table missing; KV meta still carries filter_audit summary')
      return
    }
    throw error
  }
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

async function addRestrictedKvList(kv: KVNamespace, key: string, target: Set<string>): Promise<void> {
  try {
    const raw = await kv.get(key, 'json') as unknown
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      const symbol = typeof item === 'string' ? item : (item as any)?.symbol ?? (item as any)?.code
      if (symbol) target.add(String(symbol))
    }
  } catch {
    // Optional market-risk caches should not break morning setup.
  }
}

async function loadRestrictedSet(db: D1Database, kv: KVNamespace, tradeDate: string): Promise<Set<string>> {
  const restricted = new Set<string>()
  try {
    const canonical = await loadTradingRestrictionSet({ DB: db, KV: kv } as any, tradeDate, { refreshOfficialIfStale: false })
    for (const symbol of canonical.symbols) restricted.add(symbol)
  } catch {
    // Canonical restrictions are additive; continue with legacy KV/governance.
  }
  await Promise.all([
    addRestrictedKvList(kv, 'market:punished_stocks', restricted),
    addRestrictedKvList(kv, 'market:attention_stocks', restricted),
    addRestrictedKvList(kv, 'market:tpex_punished_stocks', restricted),
    addRestrictedKvList(kv, 'market:tpex_attention_stocks', restricted),
    addRestrictedKvList(kv, 'market:delisting_risk', restricted),
  ])
  try {
    const { results } = await db.prepare(`
      SELECT symbol
        FROM stock_trading_restrictions
       WHERE COALESCE(active, 1) = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
    `).bind(tradeDate, tradeDate).all<{ symbol: string | null }>()
    for (const row of results ?? []) {
      if (row.symbol) restricted.add(String(row.symbol))
    }
  } catch {
    // Optional governance table may not exist in older D1 snapshots; KV still blocks known punished stocks.
  }
  return restricted
}

const RRG_TAXONOMY_CHUNK_SIZE = 40

function rrgClassificationForTagType(tagType: string | null | undefined): string {
  const normalized = String(tagType || '').trim()
  return normalized === 'concept' ? 'theme' : normalized
}

async function loadRrgTaxonomyTags(
  db: D1Database,
  symbols: string[],
): Promise<Array<{ symbol: string; tag: string; tag_type: string; classification: string }>> {
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  const rows: Array<{ symbol: string; tag: string; tag_type: string; classification: string }> = []
  for (let i = 0; i < uniqueSymbols.length; i += RRG_TAXONOMY_CHUNK_SIZE) {
    const chunk = uniqueSymbols.slice(i, i + RRG_TAXONOMY_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT symbol, tag, tag_type
         FROM (
           SELECT symbol, tag, tag_type, weight, 1 AS priority
             FROM finlab_taxonomy_tags
            WHERE tag_type IN ('industry_theme', 'subindustry', 'industry')
              AND symbol IN (${placeholders})
           UNION ALL
           SELECT symbol, tag, tag_type, weight, 2 AS priority
             FROM stock_tags
            WHERE tag_type='concept'
              AND symbol IN (${placeholders})
         )
        ORDER BY symbol, priority ASC, weight DESC`,
    ).bind(...chunk, ...chunk).all<{ symbol: string; tag: string; tag_type?: string | null }>()
    for (const row of results ?? []) {
      const symbol = String(row.symbol || '').trim()
      const tag = String(row.tag || '').trim()
      const tagType = String(row.tag_type || 'concept').trim()
      const classification = rrgClassificationForTagType(tagType)
      if (!symbol || !tag || !classification) continue
      rows.push({ symbol, tag, tag_type: tagType, classification })
    }
  }
  return rows
}

async function loadQuadrantMap(db: D1Database, symbols: string[]): Promise<Map<string, QuadrantInfo>> {
  const symbolQuadrantMap = new Map<string, QuadrantInfo>()
  if (!symbols.length) return symbolQuadrantMap
  try {
    const tagRows = await loadRrgTaxonomyTags(db, symbols)
    const tagsBySymbol = new Map<string, Array<{ tag: string; classification: string }>>()
    for (const row of tagRows ?? []) {
      const tags = tagsBySymbol.get(row.symbol) ?? []
      tags.push({ tag: row.tag, classification: row.classification })
      tagsBySymbol.set(row.symbol, tags)
    }

    const { results: quadrantRows } = await db.prepare(
      `SELECT sector, classification, rs_ratio, rs_momentum, quadrant
              , rotation_score, rotation_regime, rotation_hysteresis, rotation_velocity
              , rotation_acceleration, quadrant_age, transition_path, rotation_window
         FROM sector_flow
        WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
          AND quadrant IS NOT NULL
          AND rs_ratio IS NOT NULL
          AND rs_momentum IS NOT NULL
          AND date = (
            SELECT MAX(date)
              FROM sector_flow
             WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
               AND rs_ratio IS NOT NULL
               AND rs_momentum IS NOT NULL
          )`,
    ).all<any>()
    const themeQuadrants = new Map<string, Omit<QuadrantInfo, 'theme' | 'classification'>>()
    for (const row of quadrantRows ?? []) {
      const classification = String(row.classification || '').trim()
      const sector = String(row.sector || '').trim()
      if (!classification || !sector) continue
      themeQuadrants.set(`${classification}:${sector}`, {
        quadrant: row.quadrant,
        rs_ratio: Number(row.rs_ratio),
        rs_momentum: Number(row.rs_momentum),
        rotation_score: row.rotation_score == null ? null : Number(row.rotation_score),
        rotation_regime: row.rotation_regime == null ? null : String(row.rotation_regime),
        rotation_hysteresis: row.rotation_hysteresis == null ? null : String(row.rotation_hysteresis),
        rotation_velocity: row.rotation_velocity == null ? null : Number(row.rotation_velocity),
        rotation_acceleration: row.rotation_acceleration == null ? null : Number(row.rotation_acceleration),
        quadrant_age: row.quadrant_age == null ? null : Number(row.quadrant_age),
        transition_path: row.transition_path == null ? null : String(row.transition_path),
        rotation_window: row.rotation_window == null ? null : Number(row.rotation_window),
      })
    }
    const themeUniverse = new Set(themeQuadrants.keys())

    for (const symbol of symbols) {
      const tags = tagsBySymbol.get(symbol) ?? []
      const matched = tags.find((candidate) => themeUniverse.has(`${candidate.classification}:${candidate.tag}`)) ?? tags[0]
      if (!matched) continue
      const key = `${matched.classification}:${matched.tag}`
      if (!themeUniverse.has(key)) {
        symbolQuadrantMap.set(symbol, {
          theme: matched.tag,
          classification: matched.classification,
          quadrant: 'Unmapped',
          rs_ratio: 100,
          rs_momentum: 0,
        })
        continue
      }
      const info = themeQuadrants.get(key)
      if (!info) continue
      symbolQuadrantMap.set(symbol, { theme: matched.tag, classification: matched.classification, ...info })
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
      const forecastData = parsePredictionForecastData(rec.forecast_data) ?? {}
      const ensemble = forecastData?.ensemble_v2 ?? {}
      const avgRank = typeof ensemble.avg_rank === 'number' ? ensemble.avg_rank : null
      const avgRankText = avgRank != null ? avgRank.toFixed(3) : '?'
      const ensembleSignal = ensemble.signal ?? 'unknown'
      const signalSource = String(rec.signal_source ?? '').trim()

      let provenance: string | null = null
      if (signalSource === 'sparse_tangent_inverse_risk') {
        provenance =
          `Signal Provenance (sparse tangent): BUY selected by sparse_tangent_inverse_risk allocation after ML family rank (ensemble_v2.signal=${ensembleSignal}, avg_rank=${avgRankText}). ` +
          'Judge on allocation evidence, risk budget and execution feasibility.'
      } else if (/BUY/i.test(rec.signal ?? '') && ensembleSignal !== 'unknown' && !/BUY/i.test(ensembleSignal)) {
        provenance =
          `Signal Provenance (allocator selected): BUY selected after final allocation layer (ensemble_v2.signal=${ensembleSignal}, avg_rank=${avgRankText}). ` +
          'Treat as allocation-selected, not a standalone ensemble BUY.'
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
): Promise<number | null> {
  const runId = await replacePendingBuyState(env, {
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
  })
  if (pendingBuys.length > 0) {
    await recordPendingBuyPaperAttribution(env, pendingBuys, {
      tradeDate,
      sourceRecoDate: typeof meta?.prev_day === 'string' ? String(meta.prev_day) : null,
      paperLane: 'paper_active_baseline',
      candidateSource: 'morning_setup_pending_buy',
      evidenceSources: [
        'daily_recommendations',
        'predictions.ensemble',
        'pending_buy_orchestrator',
      ],
    }).catch((error) => {
      console.warn('[PendingBuyOrchestrator] paper attribution sidecar failed:', error)
    })
  }
  return runId
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
      const { getAdaptiveParamsForRegime } = await import('./adaptiveConfig')
      const adaptive = await getAdaptiveParamsForRegime(kv)
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
  const expiredStale = await expireRecentPendingBuys(env, pendingDate).catch((error) => {
    console.warn('[MorningSetup] stale pending buy expiry failed:', error)
    return 0
  })
  if (expiredStale > 0) console.log(`[MorningSetup] expired ${expiredStale} stale pending buys`)
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
    const sourceRecoDate = prevDay
    const pendingBuyLimit = Math.max(1, Math.floor(cfg.alphaFramework?.allocation?.buySignalCount ?? 3))
    const { results } = await env.DB.prepare(`
      SELECT s.id AS stock_id, dr.symbol, dr.name, dr.signal, dr.confidence, dr.has_buy_signal,
             dr.eligible_for_ml, dr.eligible_for_pending_buy, dr.reason,
             dr.watch_points, dr.score_components, dr.alpha_allocation,
             s.market AS market,
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
             (
               SELECT sp.open
                 FROM stock_prices sp
                WHERE sp.stock_id = s.id
                  AND sp.date <= dr.date
                ORDER BY sp.date DESC
                LIMIT 1
             ) AS latest_open,
             (
               SELECT sp.avg_price
                 FROM stock_prices sp
                WHERE sp.stock_id = s.id
                  AND sp.date <= dr.date
                ORDER BY sp.date DESC
                LIMIT 1
             ) AS latest_avg_price,
             p.forecast_data AS forecast_data,
             CASE WHEN json_valid(dr.alpha_allocation) THEN
               COALESCE(
                 json_extract(dr.alpha_allocation, '$.engine'),
                 json_extract(dr.alpha_allocation, '$.controller')
               )
             ELSE NULL END AS signal_source
        FROM daily_recommendations dr
        LEFT JOIN stocks s ON s.symbol = dr.symbol
        LEFT JOIN predictions p ON p.id = (
          SELECT p2.id
            FROM predictions p2
           WHERE p2.stock_id = s.id
             AND p2.model_name = 'ensemble'
             AND p2.prediction_date IN (dr.date, ?)
           ORDER BY p2.generated_at DESC, p2.id DESC
           LIMIT 1
       )
       WHERE dr.date = ?
         AND COALESCE(dr.eligible_for_pending_buy, 1) = 1
         AND COALESCE(dr.has_buy_signal, 0) = 1
         AND json_valid(dr.alpha_allocation)
         AND json_extract(dr.alpha_allocation, '$.selected') = 1
         AND json_extract(dr.alpha_allocation, '$.engine') = 'sparse_tangent_inverse_risk'
         AND COALESCE(UPPER(s.market), '') NOT IN ('EMERGING', 'ESB')
         AND (
           SELECT sp_exec.open
             FROM stock_prices sp_exec
            WHERE sp_exec.stock_id = s.id
              AND sp_exec.date <= dr.date
            ORDER BY sp_exec.date DESC
            LIMIT 1
         ) IS NOT NULL
        ORDER BY CASE WHEN json_valid(dr.score_components) THEN
           COALESCE(
             CAST(json_extract(dr.score_components, '$.finalScore') AS REAL),
             CAST(json_extract(dr.score_components, '$.total') AS REAL),
             0
           ) ELSE 0 END DESC,
           dr.confidence DESC
        LIMIT ?
    `).bind(sourceRecoDate,
      sourceRecoDate,
      pendingBuyLimit,
    ).all<BuyRecommendationRow>()

    const buyRecs = (results ?? []) as BuyRecommendationRow[]
    applyRecommendationProvenance(buyRecs)
    const filterAudit = newFilterAuditSummary(buyRecs.length)
    if (buyRecs.length === 0) {
      await persistPendingBuys(env, pendingDate, [], {
        status: 'empty',
        reason: 'no_buy_recommendations',
        prev_day: sourceRecoDate,
        filter_audit: filterAudit,
        empty_reason: 'no_buy_recommendations',
      })
      return
    }

    const stockIds = [...new Set(buyRecs.map((rec) => Number(rec.stock_id)).filter((id) => Number.isFinite(id)))]
    const ohlcvLevelsByStock = await batchLoadOhlcvTradePlanLevels(env.DB, stockIds, sourceRecoDate).catch((error) => {
      console.warn('[MorningSetup] OHLCV trade plan levels unavailable:', error)
      return new Map()
    })
    const perModelByStock = new Map<number, PerModelPredictionRow[]>()
    if (stockIds.length > 0) {
      const placeholders = stockIds.map(() => '?').join(',')
      const { results: perModelRows } = await env.DB.prepare(`
        SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data
          FROM predictions
         WHERE stock_id IN (${placeholders})
           AND model_name != 'ensemble'
          AND instr(model_name, '::') = 0
           AND prediction_date IN (?, ?)
         ORDER BY stock_id, model_name, generated_at DESC
      `).bind(
        ...stockIds,
        pendingDate,
        sourceRecoDate,
      ).all<(PerModelPredictionRow & { stock_id: number | null })>().catch(() => ({ results: [] }))
      for (const row of perModelRows ?? []) {
        const id = Number(row.stock_id)
        if (!Number.isFinite(id)) continue
        const list = perModelByStock.get(id) ?? []
        list.push(row)
        perModelByStock.set(id, list)
      }
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

    const restrictedSet = await loadRestrictedSet(env.DB, env.KV, pendingDate)
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
      const board = classifyBoard({
        market: rec.market,
        open: rec.latest_open,
        avg_price: rec.latest_avg_price,
        symbol: rec.symbol,
        restricted: restrictedSet.has(rec.symbol),
      })
      if (!board.eligibleForPendingBuy) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: board.boardType,
          quadrant: board.tradabilityTier,
          action: `BOARD_${board.reason}`,
          stage: 'hard_safety',
          reason_code: `BOARD_${board.reason}`,
          details: { market: rec.market, latest_open: rec.latest_open, latest_avg_price: rec.latest_avg_price },
        })
        incAudit(filterAudit, 'board_reject')
        continue
      }
      if (cooldownSet.has(rec.symbol)) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: 'cooldown',
          quadrant: 'cooldown',
          action: 'COOLDOWN_REJECT',
          stage: 'hard_safety',
          reason_code: 'COOLDOWN_REJECT',
        })
        incAudit(filterAudit, 'cooldown_reject')
        continue
      }
      if (!rec.ml_entry_price || rec.ml_entry_price <= 0) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: 'entry_price',
          quadrant: 'missing',
          action: 'ML_ENTRY_PRICE_MISSING',
          stage: 'hard_safety',
          reason_code: 'ML_ENTRY_PRICE_MISSING',
        })
        incAudit(filterAudit, 'missing_entry')
        continue
      }
      const forecastData = parsePredictionForecastData(rec.forecast_data)
      const alphaContext = parseAlphaContext(forecastData)
      const sparseAllocation = buildSparseAllocationSummary(rec.alpha_allocation)
      const mlVoteSummary = buildMlVoteSummary(forecastData, perModelByStock.get(Number(rec.stock_id)) ?? [])
      const scoreV2 = readScoreV2Snapshot(rec)
      if (!scoreV2) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: 'score_v2',
          quadrant: 'missing',
          action: 'SCORE_V2_MISSING',
          stage: 'hard_safety',
          reason_code: 'SCORE_V2_MISSING',
        })
        incAudit(filterAudit, 'score_v2_missing')
        continue
      }
      const executionRole = 'l4_sparse_final_buy'
      const pendingSignal = rec.signal ?? 'BUY'
      if (alphaContext?.risk_overlay?.skip === true) {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: alphaContext.edge_bucket ?? 'alpha',
          quadrant: alphaContext.regime ?? 'unknown',
          action: 'ALPHA_SKIP',
          stage: 'hard_safety',
          reason_code: 'ALPHA_SKIP',
          details: { flags: alphaContext.risk_overlay?.flags ?? [] },
        })
        incAudit(filterAudit, 'alpha_skip')
        continue
      }

      const quadrant = quadrantMap.get(rec.symbol)
      let debateVerdict = 'PENDING'
      let riskPct = calcRiskPct(pendingSignal, rec.confidence, undefined, cfg)
      const alphaSizing = clampNumber(alphaContext?.sizing_multiplier, 0.25, 1.25, 1.0)
      riskPct *= alphaSizing
      const softRiskWatchPoints: string[] = []
      const rotationDetails = quadrant ? {
        rotation_score: quadrant.rotation_score ?? null,
        rotation_regime: quadrant.rotation_regime ?? null,
        rotation_hysteresis: quadrant.rotation_hysteresis ?? null,
        rotation_velocity: quadrant.rotation_velocity ?? null,
        rotation_acceleration: quadrant.rotation_acceleration ?? null,
        quadrant_age: quadrant.quadrant_age ?? null,
        transition_path: quadrant.transition_path ?? null,
        rotation_window: quadrant.rotation_window ?? null,
      } : undefined
      if (quadrant?.rotation_regime) {
        softRiskWatchPoints.push(
          `rrg_rotation_model:${quadrant.rotation_regime}:score=${Number(quadrant.rotation_score ?? 0).toFixed(3)}:path=${quadrant.transition_path ?? quadrant.quadrant}:hysteresis=${quadrant.rotation_hysteresis ?? 'unknown'}`,
        )
      }
      if (quadrant?.quadrant === 'Lagging') {
        riskPct *= downgradeMultiplier
        softRiskWatchPoints.push(
          `rrg_soft_overlay:Lagging:risk_multiplier=${downgradeMultiplier.toFixed(2)}:debate_required=true`,
        )
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          classification: quadrant.classification,
          quadrant: quadrant.quadrant,
          action: 'SOFT_DOWNGRADE_DEBATE_REQUIRED',
          stage: 'soft_risk_overlay',
          reason_code: 'RRG_LAGGING_SOFT_RISK',
          rs_ratio: quadrant.rs_ratio,
          rs_momentum: quadrant.rs_momentum,
          risk_multiplier: downgradeMultiplier,
          momentum_dir: quadrant.rs_momentum >= 0 ? 'up' : 'down',
          details: rotationDetails,
        })
        incAudit(filterAudit, 'rrg_lagging_soft_downgrade')
      } else if (quadrant?.quadrant === 'Unmapped') {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          classification: quadrant.classification,
          quadrant: quadrant.quadrant,
          action: 'RRG_UNMAPPED_NEUTRAL',
          stage: 'soft_risk_overlay',
          reason_code: 'RRG_UNMAPPED_NEUTRAL',
          details: rotationDetails,
        })
        incAudit(filterAudit, 'rrg_unmapped_neutral')
      }

      if (quadrant?.quadrant === 'Weakening') {
        riskPct *= downgradeMultiplier
        softRiskWatchPoints.push(
          `rrg_soft_overlay:Weakening:risk_multiplier=${downgradeMultiplier.toFixed(2)}:debate_required=true`,
        )
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          classification: quadrant.classification,
          quadrant: quadrant.quadrant,
          action: 'SOFT_DOWNGRADE_DEBATE_REQUIRED',
          stage: 'soft_risk_overlay',
          reason_code: 'RRG_WEAKENING_DOWNGRADE',
          rs_ratio: quadrant.rs_ratio,
          rs_momentum: quadrant.rs_momentum,
          risk_multiplier: downgradeMultiplier,
          details: rotationDetails,
        })
        incAudit(filterAudit, 'rrg_weakening_downgrade')
      } else if (quadrant && quadrant.quadrant !== 'Lagging' && quadrant.quadrant !== 'Unmapped') {
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: quadrant.theme,
          classification: quadrant.classification,
          quadrant: quadrant.quadrant,
          action: 'PASS',
          stage: 'soft_risk_overlay',
          reason_code: 'RRG_PASS',
          rs_ratio: quadrant.rs_ratio,
          rs_momentum: quadrant.rs_momentum,
          momentum_dir: quadrant.rs_momentum >= 0 ? 'up' : 'down',
          details: rotationDetails,
        })
        incAudit(filterAudit, 'rrg_pass')
      }

      let adjustedEntry = rec.ml_entry_price
      let adjustedStop = rec.ml_stop_loss
      let adjustedTarget1 = rec.ml_target1
      let adjustedTarget2 = rec.ml_target2
      const entryWatchPoints: string[] = []
      let originalEntry = rec.ml_entry_price
      const ohlcvEntryPlan = resolveOhlcvEntryPlan(
        ohlcvLevelsByStock.get(Number(rec.stock_id)),
        { latestPrice: rec.latest_close },
      )
      if (ohlcvEntryPlan) {
        adjustedEntry = ohlcvEntryPlan.entryPrice
        adjustedStop = ohlcvEntryPlan.stopLoss
        adjustedTarget1 = ohlcvEntryPlan.target1
        adjustedTarget2 = ohlcvEntryPlan.target2
        originalEntry = ohlcvEntryPlan.entryPrice
        entryWatchPoints.push(formatOhlcvTradePlanWatchPoint(ohlcvEntryPlan))
        entryWatchPoints.push(formatEntryPriceModelV2WatchPoint(buildEntryPriceModelV2FromOhlcvPlan(ohlcvEntryPlan)))
      }
      const nightDropPct = taifex?.changePct ?? 0
      const l2 = cfg.L2_formula
      if (!ohlcvEntryPlan) {
        if (nightDropPct < l2.night_drop_severe_pct && debateVerdict === 'DOWNGRADE') {
          adjustedEntry = Math.round(adjustedEntry * l2.night_drop_severe_adjust * 100) / 100
          adjustedStop = adjustedStop != null
            ? Math.round(adjustedStop * l2.night_drop_severe_adjust * 100) / 100
            : adjustedStop
        } else if (nightDropPct < l2.night_drop_mild_pct && debateVerdict !== 'APPROVE') {
          adjustedEntry = Math.round(adjustedEntry * l2.night_drop_mild_adjust * 100) / 100
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
          if (impliedGap > gapThreshold) {
            quadrantFilterLog.push({
              symbol: rec.symbol,
              name: rec.name ?? rec.symbol,
              theme: 'pre_market_gap',
              classification: quadrant?.classification,
              quadrant: quadrant?.quadrant ?? 'unknown',
              action: 'PRE_MARKET_GAP_REJECT',
              stage: 'hard_safety',
              reason_code: 'PRE_MARKET_GAP_REJECT',
              details: { implied_gap: impliedGap, threshold: gapThreshold, taifex_change_pct: nightDropPct },
            })
            incAudit(filterAudit, 'gap_reject')
            continue
          }
          const chasePct = Math.min(impliedGap, gapThreshold)
          const gapBuffer = cfg.position.gapChaseBuffer ?? 0.995
          const newEntry = Math.round(adjustedEntry * (1 + chasePct) * gapBuffer * 100) / 100
          if (newEntry > adjustedEntry) {
            adjustedEntry = newEntry
            if (adjustedStop != null) adjustedStop = Math.round(adjustedStop * (1 + chasePct) * 100) / 100
          }
        }
      }

      const maxPremium = cfg.position.maxEntryPremiumPct ?? 0.01
      if (!ohlcvEntryPlan) {
        const cappedEntry = capEntryToLatestClose({
          entryPrice: adjustedEntry,
          stopLoss: adjustedStop,
          target1: adjustedTarget1,
          target2: adjustedTarget2,
          latestClose: rec.latest_close,
          maxPremiumPct: maxPremium,
        })
        adjustedEntry = cappedEntry.entryPrice
        adjustedStop = cappedEntry.stopLoss
        adjustedTarget1 = cappedEntry.target1
        adjustedTarget2 = cappedEntry.target2
        if (cappedEntry.watchPoint) {
          entryWatchPoints.push(cappedEntry.watchPoint)
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

      entryWatchPoints.push(
        `execution_pool:${executionRole}:mlEdge=${scoreV2.components.mlEdge};finalScore=${scoreV2.finalScore}`,
      )
      pendingBuys.push({
        symbol: rec.symbol,
        name: rec.name ?? rec.symbol,
        signal: pendingSignal,
        confidence: rec.confidence,
        ml_entry_price: adjustedEntry,
        ml_stop_loss: adjustedStop,
        ml_target1: adjustedTarget1,
        ml_target2: adjustedTarget2,
        reason: rec.reason ?? '',
        watch_points: [
          ...parseWatchPoints(rec.watch_points),
          ...([
            alphaWatchPoint(alphaContext),
            buildMarketStructureWatchPoint(alphaContext),
            buildMlVoteWatchPoint(mlVoteSummary),
            buildL4SparseAllocationWatchPoint(sparseAllocation),
          ].filter(Boolean) as string[]),
          ...softRiskWatchPoints,
          ...entryWatchPoints,
        ],
        debate_verdict: debateVerdict,
        debate_status: debateVerdict === 'PENDING' ? 'pending' : 'completed',
        risk_pct: riskPct,
        kelly_pct: kellyResult?.pct ?? null,
        score_v2: serializeScoreV2Snapshot(scoreV2),
        source: 'morning_setup_l4_sparse',
        original_entry: originalEntry,
      })
      if (pendingBuys.length >= pendingBuyLimit) break
    }

    filterAudit.final_candidates = pendingBuys.length
    filterAudit.debate_pending = pendingBuys.filter((item) => (item.debate_status ?? 'pending') === 'pending').length
    filterAudit.debate_completed = pendingBuys.filter((item) => (item.debate_status ?? 'pending') === 'completed').length
    const emptyReason = inferEmptyReason(filterAudit)
    const runId = await persistPendingBuys(env, pendingDate, pendingBuys, {
      status: 'ready',
      count: pendingBuys.length,
      prev_day: prevDay,
      final_buy_limit: pendingBuyLimit,
      execution_pool_limit: pendingBuyLimit,
      execution_pool_policy: 'l4_sparse_final_buy_only',
      filter_audit: filterAudit,
      empty_reason: emptyReason,
    })
    await persistPendingBuyFilterAudit(env, runId, pendingDate, sourceRecoDate, quadrantFilterLog)

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
  if (!env.ML_CONTROLLER_URL) {
    return persistPendingDebateFailure(env, tradeDate, snapshot, pendingItems, 'no_controller')
  }

  const cfg = await getTradingConfig(env.KV)
  const { usContextStr, newsContextStr, taifexContextStr } = await loadMacroContext(env, tradeDate)
  const profileMap = await loadStockProfiles(env.DB, pendingItems.map((item) => item.symbol))
  const mergedUsContext = [newsContextStr, usContextStr].filter(Boolean).join(' || ')
  const breeze2Context = await enrichMorningDebateCandidatesWithBreeze2(
    env,
    pendingItems.map((item, index) => ({
      symbol: item.symbol,
      name: item.name ?? item.symbol,
      score_v2: item.score_v2 ?? null,
      reason: item.reason ?? 'ML ensemble signal',
      watch_points: item.watch_points,
      rank: index + 1,
      recommendation_lane: 'tradable',
    })),
    { runDate: tradeDate, executeModal: true },
  ).catch((error) => {
    console.warn('[MorningSetup] Breeze2 debate context skipped:', error)
    return new Map<string, any>()
  })
  const candidates: BatchDebateCandidate[] = pendingItems.map((item) => ({
    symbol: item.symbol,
    stock_name: item.name ?? item.symbol,
    signal: item.signal,
    confidence: item.confidence,
    reasoning: [
      item.reason ?? 'ML ensemble signal',
      extractBreeze2WatchPoint(breeze2Context.get(item.symbol)),
    ].filter(Boolean).join('\n'),
    us_context: mergedUsContext || undefined,
    taifex_context: taifexContextStr,
    stock_profile: profileMap.get(item.symbol)
      ? {
          business_desc: profileMap.get(item.symbol)?.business_desc ?? undefined,
          key_customers: profileMap.get(item.symbol)?.key_customers ?? undefined,
          key_suppliers: profileMap.get(item.symbol)?.key_suppliers ?? undefined,
        }
      : undefined,
    breeze2_context: breeze2Context.get(item.symbol),
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
    return persistPendingDebateFailure(env, tradeDate, snapshot, pendingItems, 'debate_batch_unavailable')
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
      const transition = applyPendingBuyExecutionStatusUpdates([item], [{
        symbol: item.symbol,
        status: 'pending',
        reason: 'debate_retry:debate_missing',
      }])
      nextPendingBuys.push(transition.allItems[0] as PendingBuy)
      continue
    }
    if (debate.verdict === 'REJECT') continue
    const breeze2WatchPoint = extractBreeze2WatchPoint(breeze2Context.get(item.symbol))
    nextPendingBuys.push({
      ...item,
      watch_points: [
        ...item.watch_points,
        ...(breeze2WatchPoint ? [breeze2WatchPoint] : []),
      ],
      debate_verdict: debate.verdict,
      debate_status: 'completed',
      risk_pct: debate.verdict === 'DOWNGRADE' ? item.risk_pct * downgradeMultiplier : item.risk_pct,
      debate_turns: debate.agentTurns ?? [],
    })
  }

  await replacePendingBuyState(env, {
    tradeDate,
    sourceRecoDate,
    status: 'ready',
    debateStatus: failedCount > 0 ? 'pending' : 'completed',
    pendingBuys: nextPendingBuys,
    meta: {
      stage: 'debate_async',
      updated_symbols: candidates.map((item) => item.symbol),
      failed_count: failedCount,
    },
  })

  return `debated=${results.size} failed=${failedCount} remaining=${nextPendingBuys.length}`
}
