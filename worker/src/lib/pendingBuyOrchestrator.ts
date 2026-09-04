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
import { databaseForDataDomain, databaseForTable } from './dataDomainRegistry'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import type { CircuitBreakerState as _CBState, LegacyLayerDeps } from './riskTypes'
import type { PortfolioRiskDatabases } from './riskChain'
import {
  applyPendingBuyExecutionStatusUpdates,
} from './pendingBuyExecutionState'
import { recordPendingBuyPaperAttribution } from './paperActiveAttributionWiring'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { loadTradingRestrictionBuckets } from './tradingRestrictions'
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
import {
  loadPromotedPaperKellyCalibrationBefore,
  resolvePaperKellyPct,
} from './paperKellyCalibration'

import { withD1ReadRetry } from './d1TransientRetry'
type CircuitBreakerState = _CBState
async function withD1Retry<T>(label: string, operation: () => Promise<T>, attempts = 3): Promise<T> {
  return withD1ReadRetry('morning_setup', label, operation, attempts)
}


async function recordMorningSetupFailureWithoutReplacingState(
  env: Bindings,
  tradeDate: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await Promise.allSettled([
    env.KV.put(`paper:pending_buys_setup_error:${tradeDate}`, JSON.stringify({
      status: 'error',
      reason: message,
      failed_at: new Date().toISOString(),
      snapshot_policy: 'preserve_last_valid_state',
    }), { expirationTtl: 7 * 86400 }),
    recordPaperExecutionEvent(env, {
      tradeDate,
      eventType: 'pending_buy',
      status: 'error',
      reason: message,
      detail: { snapshot_policy: 'preserve_last_valid_state' },
      source: 'morning_setup_failure',
    }),
  ])
}

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
  alpha_risk_debate_required: number
  trading_attention_risk_evidence: number
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
  const keep = (value: unknown): value is string =>
    typeof value === 'string'
    && value.trim().length > 0
    && !/rrg(?:_|\s|:)|relative rotation/i.test(value)
  if (Array.isArray(raw)) {
    return raw.filter(keep)
  }
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(keep)
      : []
  } catch {
    return []
  }
}

function formatDebateWatchPoints(watchPoints: string[] | undefined): string | null {
  const points = (watchPoints ?? []).filter((point) =>
    typeof point === 'string'
    && point.trim().length > 0
    && !/rrg(?:_|\s|:)|relative rotation/i.test(point),
  )
  if (!points.length) return null
  const riskEvidence = points.filter((point) =>
    point.includes('debate_required=true') ||
    point.includes('alpha_risk_overlay') ||
    point.includes('trading_attention_risk_evidence'),
  )
  const supportingEvidence = points.filter((point) => !riskEvidence.includes(point))
  const promptPoints = [...riskEvidence, ...supportingEvidence].slice(0, 16)
  return [
    'Watch points / debate evidence:',
    ...promptPoints.map((point) => `- ${point}`),
  ].join('\n')
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
    alpha_risk_debate_required: 0,
    trading_attention_risk_evidence: 0,
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
      await databaseForTable(env, 'pending_buy_filter_audit').prepare(
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
  const taifex = await fetchTaifexNightClose(env.ML_CONTROLLER_URL, env.ML_CONTROLLER_SECRET).catch((error) => {
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

async function loadPendingBuyRestrictionPolicy(db: D1Database, kv: KVNamespace, tradeDate: string): Promise<{
  hardBlockedSymbols: Set<string>
  riskEvidenceSymbols: Set<string>
}> {
  try {
    const policy = await loadTradingRestrictionBuckets({ DB: db, KV: kv } as any, tradeDate, { refreshOfficialIfStale: false })
    return {
      hardBlockedSymbols: policy.hardBlockedSymbols,
      riskEvidenceSymbols: policy.riskEvidenceSymbols,
    }
  } catch {
    return { hardBlockedSymbols: new Set(), riskEvidenceSymbols: new Set() }
  }
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
          `Signal Provenance (sparse tangent): BUY selected by sparse_tangent_inverse_risk allocation after ML family evidence (ensemble_v2.signal=${ensembleSignal}, avg_rank=${avgRankText}). ` +
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
  if (meta?.status !== 'error') {
    await env.KV.delete(`paper:pending_buys_setup_error:${tradeDate}`).catch(() => {})
  }
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
  db: D1Database | PortfolioRiskDatabases,
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
  const { runPortfolioChecks } = await import('./riskChain')
  const agg = await runPortfolioChecks(db, cfg, kv, deps)
  return {
    ...agg,
    reason: agg.reason || undefined,
  }
}

export async function checkCircuitBreakersForDomains(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  cfg: TradingConfig,
  kv?: KVNamespace,
): Promise<CircuitBreakerState> {
  return checkCircuitBreakers({
    paper: databaseForDataDomain(env, 'paper'),
    core: databaseForDataDomain(env, 'core'),
    market: databaseForDataDomain(env, 'market'),
    learning: databaseForDataDomain(env, 'learning'),
  }, cfg, kv)
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
  let cb: CircuitBreakerState
  try {
    cb = await withD1Retry('circuit_breakers', () => checkCircuitBreakersForDomains(env, cfg, env.KV))
  } catch (error) {
    await recordMorningSetupFailureWithoutReplacingState(env, pendingDate, error)
    throw error
  }
  console.log(
    `[MorningSetup] circuit halt=${cb.halt} buyConfThreshold=${cb.buyConfThreshold} maxPositionPct=${cb.maxPositionPct} reason=${cb.reason ?? 'none'}`,
  )

  {
    const { writeAuditEntry } = await import('./riskAudit')
    writeAuditEntry(databaseForDataDomain(env, 'execution'), {
      triggerEvent: 'morning_setup',
      decision: cb.halt ? 'halt' : 'executed',
      riskState: cb,
    }).catch(() => {})
  }

  if (cb.halt) {
    await persistPendingBuys(env, pendingDate, [], {
      status: 'halted',
      reason: cb.reason ?? 'circuit_breaker',
      market_risk_owner: 'canonical_market_risk_runtime_v1',
      market_risk_date: cb.marketRiskDate ?? null,
      market_risk_status: cb.marketRiskStatus ?? 'blocked',
      market_risk_level: cb.marketRiskLevel ?? 'unknown',
      market_risk_blockers: cb.marketRiskBlockers ?? [],
    })
    return
  }

  try {
    const prevDay = await withD1Retry('previous_trading_day', () => getPrevTradingDay(databaseForDataDomain(env, 'core'), env.KV))
    const sourceRecoDate = prevDay
    const kellyArtifact = await loadPromotedPaperKellyCalibrationBefore(
      databaseForDataDomain(env, 'paper'),
      pendingDate,
    ).catch((error) => {
      console.warn('[MorningSetup] promoted Paper Kelly artifact unavailable; neutral sizing:', error)
      return null
    })
    const configuredBuySignalCount = Math.max(1, Math.floor(cfg.alphaFramework?.allocation?.buySignalCount ?? 3))
    const { results: coreRecommendationRows } = await withD1Retry('buy_recommendations', () => databaseForDataDomain(env, 'core').prepare(`
      SELECT s.id AS stock_id, dr.symbol, dr.name, dr.signal, dr.confidence, dr.has_buy_signal,
             dr.eligible_for_ml, dr.eligible_for_pending_buy, dr.reason,
             dr.watch_points, dr.score_components, dr.alpha_allocation,
             s.market AS market,
             NULL AS ml_entry_price,
             NULL AS ml_stop_loss,
             NULL AS ml_target1,
             NULL AS ml_target2,
             NULL AS latest_close,
             NULL AS latest_open,
             NULL AS latest_avg_price,
             NULL AS forecast_data,
             CASE WHEN json_valid(dr.alpha_allocation) THEN
               COALESCE(
                 json_extract(dr.alpha_allocation, '$.engine'),
                 json_extract(dr.alpha_allocation, '$.controller')
               )
             ELSE NULL END AS signal_source
        FROM daily_recommendations dr
        LEFT JOIN stocks s ON s.symbol = dr.symbol
       WHERE dr.date = ?
         AND dr.eligible_for_pending_buy = 1
         AND COALESCE(dr.has_buy_signal, 0) = 1
         AND json_valid(dr.alpha_allocation)
         AND json_extract(dr.alpha_allocation, '$.selected') = 1
         AND json_extract(dr.alpha_allocation, '$.engine') = 'sparse_tangent_inverse_risk'
         AND COALESCE(UPPER(s.market), '') NOT IN ('EMERGING', 'ESB')
        ORDER BY CASE WHEN json_valid(dr.score_components) THEN
           COALESCE(
             CAST(json_extract(dr.score_components, '$.finalScore') AS REAL),
             CAST(json_extract(dr.score_components, '$.total') AS REAL),
             0
           ) ELSE 0 END DESC,
           dr.confidence DESC
    `).bind(sourceRecoDate).all<BuyRecommendationRow>())
    const marketPriceRows = await loadMarketPriceHistoryBySymbols(
      env,
      (coreRecommendationRows ?? []).map((row) => row.symbol),
      { onOrBeforeDate: sourceRecoDate, rowsPerSymbol: 1 },
    )
    const marketPriceBySymbol = new Map(marketPriceRows.map((row) => [row.symbol, row]))
    const buyRecs = (coreRecommendationRows ?? [])
      .map((row) => {
        const price = marketPriceBySymbol.get(row.symbol)
        return {
          ...row,
          latest_close: price?.close ?? null,
          latest_open: price?.open ?? null,
          latest_avg_price: price?.avg_price ?? null,
        }
      })
      .filter((row) => row.latest_open != null) as BuyRecommendationRow[]
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
    const learningDb = databaseForDataDomain(env, 'learning')
    if (stockIds.length > 0) {
      const placeholders = stockIds.map(() => '?').join(',')
      const ensembleRows = await learningDb.prepare(`
        SELECT stock_id, entry_price, stop_loss, target1, target2, forecast_data
          FROM predictions
         WHERE stock_id IN (${placeholders})
           AND model_name = 'ensemble'
           AND prediction_date IN (?, ?)
         ORDER BY stock_id, generated_at DESC, id DESC
      `).bind(...stockIds, pendingDate, sourceRecoDate).all<{
        stock_id: number
        entry_price: number | null
        stop_loss: number | null
        target1: number | null
        target2: number | null
        forecast_data: string | null
      }>()
      const latestByStock = new Map<number, NonNullable<typeof ensembleRows.results>[number]>()
      for (const row of ensembleRows.results ?? []) {
        if (!latestByStock.has(Number(row.stock_id))) latestByStock.set(Number(row.stock_id), row)
      }
      for (const rec of buyRecs) {
        const prediction = latestByStock.get(Number(rec.stock_id))
        if (!prediction) continue
        rec.ml_entry_price = prediction.entry_price
        rec.ml_stop_loss = prediction.stop_loss
        rec.ml_target1 = prediction.target1
        rec.ml_target2 = prediction.target2
        rec.forecast_data = prediction.forecast_data
      }
    }
    applyRecommendationProvenance(buyRecs)

    const ohlcvLevelsByStock = await batchLoadOhlcvTradePlanLevels(databaseForDataDomain(env, 'market'), stockIds, sourceRecoDate).catch((error) => {
      console.warn('[MorningSetup] OHLCV trade plan levels unavailable:', error)
      return new Map()
    })
    const perModelByStock = new Map<number, PerModelPredictionRow[]>()
    if (stockIds.length > 0) {
      const placeholders = stockIds.map(() => '?').join(',')
      const { results: perModelRows } = await learningDb.prepare(`
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

    const marketDb = databaseForDataDomain(env, 'market')
    const restrictionPolicy = await loadPendingBuyRestrictionPolicy(marketDb, env.KV, pendingDate)
    const { cooldownSet, stopDayFrozen } = await collectCooldownSet(env.KV, pendingDate, buyRecs)
    if (stopDayFrozen) {
      await persistPendingBuys(env, pendingDate, [], {
        status: 'empty',
        reason: 'stop_day_freeze',
        prev_day: prevDay,
      })
      return
    }

    const quadrantFilterLog: QuadrantFilterLogEntry[] = []
    const pendingBuys: PendingBuy[] = []

    for (const rec of buyRecs) {
      const board = classifyBoard({
        market: rec.market,
        open: rec.latest_open,
        avg_price: rec.latest_avg_price,
        symbol: rec.symbol,
        restricted: restrictionPolicy.hardBlockedSymbols.has(rec.symbol),
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
      const ensembleSemantic = String(forecastData?.ensemble_v2?.semantic_version ?? '').trim()
      const targetSemantic = String(forecastData?.ensemble_v2?.target_semantic_version ?? '').trim()
      const mlConfidenceSemantic = ensembleSemantic && targetSemantic
        ? `${ensembleSemantic}|${targetSemantic}`
        : null
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
      const softRiskWatchPoints: string[] = []
      if (alphaContext?.risk_overlay?.skip === true) {
        const alphaRiskFlags = Array.isArray(alphaContext.risk_overlay?.flags)
          ? alphaContext.risk_overlay.flags
          : []
        softRiskWatchPoints.push(
          `alpha_risk_overlay:skip=true:flags=${alphaRiskFlags.join('|') || 'none'}:hard_block=false:debate_required=true`,
        )
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: alphaContext.edge_bucket ?? 'alpha',
          quadrant: alphaContext.regime ?? 'unknown',
          action: 'ALPHA_RISK_DEBATE_REQUIRED',
          stage: 'soft_risk_overlay',
          reason_code: 'ALPHA_RISK_OVERLAY_DEBATE_REQUIRED',
          details: {
            flags: alphaRiskFlags,
            volatility_level: alphaContext.risk_overlay?.volatility_level ?? null,
            liquidity_level: alphaContext.risk_overlay?.liquidity_level ?? null,
            policy: 'alpha_skip_is_risk_evidence_not_hard_block',
            debate_required: true,
          },
        })
        incAudit(filterAudit, 'alpha_risk_debate_required')
      }

      let debateVerdict = 'PENDING'
      let riskPct = calcRiskPct(pendingSignal, rec.confidence, undefined, cfg)
      const alphaSizing = clampNumber(alphaContext?.sizing_multiplier, 0.25, 1.25, 1.0)
      riskPct *= alphaSizing
      const hasTradingRestrictionRiskEvidence = restrictionPolicy.riskEvidenceSymbols.has(rec.symbol)
        && !restrictionPolicy.hardBlockedSymbols.has(rec.symbol)
      if (hasTradingRestrictionRiskEvidence) {
        softRiskWatchPoints.push('trading_attention_risk_evidence:hard_block=false:debate_required=true')
        quadrantFilterLog.push({
          symbol: rec.symbol,
          name: rec.name ?? rec.symbol,
          theme: 'trading_attention',
          quadrant: 'risk_evidence',
          action: 'TRADING_ATTENTION_DEBATE_REQUIRED',
          stage: 'soft_risk_overlay',
          reason_code: 'TRADING_ATTENTION_RISK_EVIDENCE',
          details: { policy: 'attention_is_risk_evidence_not_hard_block', debate_required: true },
        })
        incAudit(filterAudit, 'trading_attention_risk_evidence')
      }
      let adjustedEntry = rec.ml_entry_price
      let adjustedStop = rec.ml_stop_loss
      let adjustedTarget1 = rec.ml_target1
      let adjustedTarget2 = rec.ml_target2
      const entryWatchPoints: string[] = []
      if (mlConfidenceSemantic) entryWatchPoints.push(`ml_confidence_semantic:${mlConfidenceSemantic}`)
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
              classification: 'market',
              quadrant: 'pre_market_gap',
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

      const kellyResult = resolvePaperKellyPct(
        kellyArtifact,
        rec.confidence,
        cfg.position.kelly.maxKellyPct,
        mlConfidenceSemantic,
      )
      if (kellyResult) {
        console.log(`[MorningSetup] ${rec.symbol} ${kellyResult.info}`)
        entryWatchPoints.push(`paper_kelly_artifact:${kellyResult.artifactId}:pct=${kellyResult.pct.toFixed(6)}`)
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
          `portfolio_risk:owner=canonical_market_risk_runtime_v1;date=${cb.marketRiskDate ?? 'missing'};status=${cb.marketRiskStatus ?? 'blocked'};level=${cb.marketRiskLevel ?? 'unknown'};score=${cb.marketRiskScore ?? 'na'};max_position_pct=${cb.maxPositionPct};target_exposure=${cb.targetExposurePct ?? 'na'}`,
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
    }

    filterAudit.final_candidates = pendingBuys.length
    filterAudit.debate_pending = pendingBuys.filter((item) => (item.debate_status ?? 'pending') === 'pending').length
    filterAudit.debate_completed = pendingBuys.filter((item) => (item.debate_status ?? 'pending') === 'completed').length
    const emptyReason = inferEmptyReason(filterAudit)
    const runId = await persistPendingBuys(env, pendingDate, pendingBuys, {
      status: 'ready',
      count: pendingBuys.length,
      prev_day: prevDay,
      final_buy_limit: pendingBuys.length,
      execution_pool_limit: pendingBuys.length,
      configured_buy_signal_count: configuredBuySignalCount,
      debate_pool_policy: 'all_l4_sparse_buy_signals',
      execution_pool_policy: 'l4_sparse_final_buy_only',
      filter_audit: filterAudit,
      empty_reason: emptyReason,
      market_risk_owner: 'canonical_market_risk_runtime_v1',
      market_risk_date: cb.marketRiskDate ?? null,
      market_risk_status: cb.marketRiskStatus ?? 'blocked',
      market_risk_level: cb.marketRiskLevel ?? 'unknown',
      market_risk_score: cb.marketRiskScore ?? null,
      market_risk_max_position_pct: cb.maxPositionPct,
      market_risk_target_exposure: cb.targetExposurePct ?? null,
      market_risk_reasons: cb.marketRiskReasons ?? [],
      market_risk_blockers: cb.marketRiskBlockers ?? [],
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
    await recordMorningSetupFailureWithoutReplacingState(env, pendingDate, message)
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
  const profileMap = await loadStockProfiles(
    databaseForDataDomain(env, 'market'),
    pendingItems.map((item) => item.symbol),
  )
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
      formatDebateWatchPoints(item.watch_points),
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
    if (debate.terminalStatus !== 'completed' || debate.retryable) {
      failedCount += 1
      const reason = debate.errorCode ?? 'debate_retryable_error'
      const transition = applyPendingBuyExecutionStatusUpdates([item], [{
        symbol: item.symbol,
        status: 'pending',
        reason: `debate_retry:${reason}`,
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
