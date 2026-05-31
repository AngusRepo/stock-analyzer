/**
 * marketScreener.ts — 全市場自動選股 + 族群輪動偵測
 *
 * 每日收盤後執行（14:00 TW = 06:00 UTC cron），從全市場篩選出 ~25 支候選股
 * 自動更新 stocks 表（source='screener'），讓後續 ML pipeline 分析
 *
 * 兩階段漏斗（QuantConnect Coarse+Fine pattern）：
 *   Stage 1: Sector Heat Score → top 5 熱門族群
 *   Stage 2: Individual Stock Filter → 每個族群 top 5-8 支
 */

import type { Bindings } from '../types'
import { getTradingConfig, type TradingConfig } from './tradingConfig'
import { buildScreenerSeedPruneSql, buildScreenerSeedRow, buildScreenerSeedUpsertSql } from './screenerSeedQuality'
import { computeAndStoreIndicators, computeTechnicalIndicators } from './technicalIndicators'
import { loadMarketDataFromD1, type FMChip, type FMStockPrice } from './screenerMarketData'
import { annotateCandidatesWithStrategySpecs } from './screenerStrategyConsumer'
import { getAdaptiveParamsForRegime } from './adaptiveConfig'
import { applyScreenerScoreCalibration, resolveScreenerPolicy } from './screenerPolicy'
import { enrichScreenerCandidatesWithBreeze2, extractBreeze2WatchPoint, type Breeze2CandidateLike } from './breeze2Runtime'
import { loadTradingRestrictionSet } from './tradingRestrictions'
import { isEtfLikeSymbol } from './boardTradability'
import { buildPartialScreenerScoreV2, buildScoreV2Components, readScoreV2Snapshot, type ScoreV2StorageRow } from './scoreV2Taxonomy'
import { loadExternalEvidenceRiskOverlays } from './newsThemeRiskOverlay'
import {
  buildFinLabTaxonomyThemeSignals,
  refreshStockThemeFeaturesFromSignals,
  upsertThemeSignals,
  type FinLabTaxonomyTagRow,
} from './v41DataRuntime'

const D1_IN_CHUNK_SIZE = 40
const SCREENER_FUNNEL_MAX_ITEMS = 5000

function isEtfHardGateSymbol(symbol: string, info?: { market?: string }): boolean {
  const market = String(info?.market ?? '').trim().toUpperCase()
  return market === 'ETF' || isEtfLikeSymbol(symbol)
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SectorHeatScore {
  sector: string
  score: number           // 0-100
  components: {
    chipFlow: number      // 法人資金集中度 (40%)
    relativeStrength: number  // 族群相對強度 (30%)
    volumeExpansion: number   // 成交量擴張 (20%)
    momentum: number      // 動量趨勢 (10%)
  }
  stockCount: number
  topStocks: string[]     // representative symbols
}

export interface ScreenerCandidate {
  symbol: string
  name: string
  sector: string
  score: number
  reason: string
  score_components?: string | null
  strategy_matches?: Array<{ specId: string; alphaBucket: string; status: string; label: string; reason: string }>
  strategy_tags?: string[]
  strategy_watch_points?: string[]
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function today(): string {
  // 用台北時間（UTC+8），確保收盤後取到當天資料
  const tw = new Date(Date.now() + 8 * 3600_000)
  return tw.toISOString().slice(0, 10)
}

function resolveScreenerRunDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid screener run date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.min(D1_IN_CHUNK_SIZE, Math.floor(size || D1_IN_CHUNK_SIZE)))
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize))
  }
  return chunks
}

async function readSymbolList(kv: KVNamespace, key: string): Promise<string[]> {
  try {
    const value = await kv.get(key, 'json') as unknown
    return Array.isArray(value) ? value.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

async function loadRestrictedScreenerSymbols(env: Bindings, runDate: string): Promise<Set<string>> {
  const restricted = await loadTradingRestrictionSet(env, runDate, {
    refreshOfficialIfStale: true,
    refreshTtlMs: 12 * 60 * 60_000,
  })
  await env.KV.put(
    `market:trading_restrictions:summary:${runDate}`,
    JSON.stringify({
      count: restricted.symbols.size,
      source_counts: restricted.sourceCounts,
      freshness: restricted.freshness,
      generated_at: new Date().toISOString(),
    }),
    { expirationTtl: 7 * 86400 },
  ).catch(() => {})
  return restricted.symbols
}

export interface ScreenerSelectionFlag {
  highFreq: boolean
  newMoney: boolean
  freq20d: number
}

export async function loadSelectionHistoryFlags(
  db: D1Database,
  symbols: string[],
  endDate: string,
  options: { highFreqThreshold?: number } = {},
): Promise<Map<string, ScreenerSelectionFlag>> {
  const uniqueSymbols = [...new Set(symbols.filter(Boolean))]
  const selectionFlagMap = new Map<string, ScreenerSelectionFlag>()
  for (const sym of uniqueSymbols) {
    selectionFlagMap.set(sym, { highFreq: false, newMoney: true, freq20d: 0 })
  }
  if (!uniqueSymbols.length) return selectionFlagMap

  const highFreqThreshold = Math.max(1, Math.floor(options.highFreqThreshold ?? 12))
  const historyRows: Array<{ symbol: string; freq20d: number; freq30d: number }> = []

  for (let i = 0; i < uniqueSymbols.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = uniqueSymbols.slice(i, i + D1_IN_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT
         symbol,
         SUM(CASE WHEN date >= date(?, '-20 days') THEN 1 ELSE 0 END) as freq20d,
         COUNT(*) as freq30d
       FROM screener_selection_history
       WHERE date >= date(?, '-30 days') AND date < ? AND symbol IN (${placeholders})
       GROUP BY symbol`,
    ).bind(endDate, endDate, endDate, ...chunk).all<{ symbol: string; freq20d: number; freq30d: number }>()
    historyRows.push(...(results ?? []))
  }

  const historyMap = new Map(historyRows.map(r => [r.symbol, {
    freq20d: Number(r.freq20d ?? 0),
    freq30d: Number(r.freq30d ?? 0),
  }]))
  for (const sym of uniqueSymbols) {
    const history = historyMap.get(sym)
    const freq = history?.freq20d ?? 0
    selectionFlagMap.set(sym, {
      freq20d: freq,
      highFreq: freq >= highFreqThreshold,
      newMoney: (history?.freq30d ?? 0) === 0,
    })
  }
  return selectionFlagMap
}

interface ScreenerFunnelItemInput {
  symbol: string
  name?: string | null
  stage: string
  decision: 'pass' | 'drop' | 'selected' | 'observe'
  reasonCode: string
  scoreBefore?: number | null
  scoreAfter?: number | null
  rank?: number | null
  evidence?: Record<string, unknown>
}

function pushFunnelItem(items: ScreenerFunnelItemInput[], item: ScreenerFunnelItemInput): void {
  items.push({
    ...item,
    symbol: String(item.symbol || '').trim(),
    evidence: item.evidence ?? {},
  })
}

export function dedupeScreenerCandidatesBySymbol<T extends { symbol?: unknown }>(candidates: T[]): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const candidate of candidates) {
    const symbol = String(candidate.symbol ?? '').trim().toUpperCase()
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    deduped.push(candidate)
  }
  return deduped
}

export async function queryTopConceptTagsForSymbols(
  db: D1Database,
  symbols: string[],
  chunkSize = 400,
): Promise<Array<{ symbol: string; tag: string; tag_type?: string }>> {
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  const safeChunkSize = Math.max(1, Math.min(D1_IN_CHUNK_SIZE, Math.floor(chunkSize || D1_IN_CHUNK_SIZE)))
  const rows: Array<{ symbol: string; tag: string; tag_type?: string }> = []

  for (let i = 0; i < uniqueSymbols.length; i += safeChunkSize) {
    const chunk = uniqueSymbols.slice(i, i + safeChunkSize)
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
        ORDER BY symbol, priority ASC, weight DESC`
    ).bind(...chunk, ...chunk).all<{ symbol: string; tag: string; tag_type?: string }>()
    rows.push(...(results ?? []))
  }

  return rows
}

async function materializeScreenerThemeRuntime(
  db: D1Database,
  date: string,
  symbols: string[],
): Promise<{ signals: number; tags: number; features: number }> {
  const tags = await queryTopConceptTagsForSymbols(db, symbols) as FinLabTaxonomyTagRow[]
  const generatedAt = new Date().toISOString()
  const signals = buildFinLabTaxonomyThemeSignals(tags, date, generatedAt)
  await upsertThemeSignals(db, signals)
  const featureReport = await refreshStockThemeFeaturesFromSignals(db, date)
  return {
    signals: signals.length,
    tags: tags.length,
    features: featureReport.features,
  }
}

interface SymbolTaxonomyProfile {
  industry?: string
  industryTheme?: string
  subindustry?: string
  concepts: string[]
  tags: string[]
}

function rrgClassificationForTagType(tagType: string | null | undefined): string {
  const normalized = String(tagType || '').trim()
  return normalized === 'concept' ? 'theme' : normalized
}

async function loadSymbolTaxonomyProfiles(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, SymbolTaxonomyProfile>> {
  const rows = await queryTopConceptTagsForSymbols(db, symbols)
  const profiles = new Map<string, SymbolTaxonomyProfile>()
  for (const row of rows) {
    const symbol = String(row.symbol || '').trim()
    const tag = String(row.tag || '').trim()
    if (!symbol || !tag) continue
    const profile = profiles.get(symbol) ?? { concepts: [], tags: [] }
    const tagType = String(row.tag_type || 'concept')
    if (tagType === 'industry' && !profile.industry) profile.industry = tag
    else if (tagType === 'industry_theme' && !profile.industryTheme) profile.industryTheme = tag
    else if (tagType === 'subindustry' && !profile.subindustry) profile.subindustry = tag
    else if (!profile.concepts.includes(tag)) profile.concepts.push(tag)
    if (!profile.tags.includes(tag)) profile.tags.push(tag)
    profiles.set(symbol, profile)
  }
  return profiles
}

function taxonomyDisplay(profile: SymbolTaxonomyProfile | undefined, fallback: string): string {
  return profile?.industryTheme || profile?.industry || profile?.subindustry || fallback
}

function taxonomyWatchPoint(profile: SymbolTaxonomyProfile | undefined): string | null {
  if (!profile) return null
  const parts = [
    profile.industry ? `industry=${profile.industry}` : null,
    profile.industryTheme ? `industry_theme=${profile.industryTheme}` : null,
    profile.subindustry ? `subindustry=${profile.subindustry}` : null,
    profile.concepts.length ? `concept=${profile.concepts.slice(0, 3).join('/')}` : null,
  ].filter(Boolean)
  return parts.length ? `taxonomy:${parts.join(',')}` : null
}

function taxonomyLayerValue(candidate: { taxonomy?: SymbolTaxonomyProfile; industry?: string }, layer: 'industryTheme' | 'subindustry' | 'industry' | 'concept'): string | null {
  if (layer === 'concept') return candidate.taxonomy?.concepts?.[0] ?? null
  return candidate.taxonomy?.[layer] ?? (layer === 'industry' ? candidate.industry ?? null : null)
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clampScore(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
}

function applyScoreV2NewsThemeAdjustment(
  candidate: { score: number; score_components?: string | null },
  requestedDelta: number,
  reason: string,
  riskFlags: string[] = [],
): number {
  const snapshot = readScoreV2Snapshot({ score_components: candidate.score_components } as ScoreV2StorageRow)
  if (!snapshot) return 0
  const positiveDelta = Math.max(0, requestedDelta)
  const appliedNewsDelta = positiveDelta > 0
    ? round1(Math.min(positiveDelta, Math.max(0, 5 - snapshot.components.newsTheme)))
    : 0
  const riskAdjustment = requestedDelta < 0 ? requestedDelta : 0
  const alphaAdjustment = round1((snapshot.alphaAdjustment ?? 0) + riskAdjustment)
  const payload = buildScoreV2Components({
    ...snapshot.components,
    newsTheme: round1(snapshot.components.newsTheme + appliedNewsDelta),
    technicalBreakdown: snapshot.technicalBreakdown,
    riskFlags: [...snapshot.riskFlags, ...riskFlags],
    reasons: [...snapshot.reasons, reason],
  })
  const finalScore = clampScore(round1(payload.total + alphaAdjustment), 0, 100)
  candidate.score_components = JSON.stringify({
    ...payload,
    alphaAdjustment,
    finalScore,
  })
  const appliedRankingDelta = round1(appliedNewsDelta + riskAdjustment)
  candidate.score = round1(candidate.score + appliedRankingDelta)
  return appliedRankingDelta
}

function applyTaxonomyDiversityCap<T extends { taxonomy?: SymbolTaxonomyProfile; industry?: string }>(
  candidates: T[],
  layer: 'industryTheme' | 'subindustry' | 'industry' | 'concept',
  maxPerLayer: number,
): T[] {
  const max = Math.max(1, Math.floor(maxPerLayer))
  const counts = new Map<string, number>()
  return candidates.filter((candidate) => {
    const key = taxonomyLayerValue(candidate, layer)
    if (!key) return true
    const count = counts.get(key) ?? 0
    if (count >= max) return false
    counts.set(key, count + 1)
    return true
  })
}

async function writeScreenerFunnel(
  env: Bindings,
  input: {
    runId: string
    date: string
    status: 'success' | 'skipped' | 'error'
    universeCount: number
    candidateCount: number
    finalCount: number
    emergingCount: number
    metadata: Record<string, unknown>
    debugLog: string[]
    items: ScreenerFunnelItemInput[]
  },
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO screener_funnel_runs
      (run_id, date, status, universe_count, candidate_count, final_count, emerging_count, metadata, debug_log)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status,
      universe_count=excluded.universe_count,
      candidate_count=excluded.candidate_count,
      final_count=excluded.final_count,
      emerging_count=excluded.emerging_count,
      metadata=excluded.metadata,
      debug_log=excluded.debug_log
  `).bind(
    input.runId,
    input.date,
    input.status,
    input.universeCount,
    input.candidateCount,
    input.finalCount,
    input.emergingCount,
    JSON.stringify(input.metadata),
    JSON.stringify(input.debugLog.slice(-80)),
  ).run()

  if (!input.items.length) return
  const persistedItems = input.items.slice(0, SCREENER_FUNNEL_MAX_ITEMS)
  const batch = persistedItems.map((item) =>
    env.DB.prepare(`
      INSERT INTO screener_funnel_items
        (run_id, date, symbol, name, stage, decision, reason_code, score_before, score_after, rank, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.runId,
      input.date,
      item.symbol,
      item.name ?? null,
      item.stage,
      item.decision,
      item.reasonCode,
      item.scoreBefore ?? null,
      item.scoreAfter ?? null,
      item.rank ?? null,
      JSON.stringify(item.evidence ?? {}),
    )
  )
  for (let i = 0; i < batch.length; i += 50) {
    await env.DB.batch(batch.slice(i, i + 50))
  }
}

/** Clamp value to [min, max] */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** 將原始值線性 normalize 到 [0, maxScore] */
function normalize(value: number, lower: number, upper: number, maxScore: number): number {
  if (upper === lower) return maxScore / 2
  return clamp(((value - lower) / (upper - lower)) * maxScore, 0, maxScore)
}

// ─── Sector mapping ──────────────────────────────────────────────────────────

interface SectorMap {
  [stockId: string]: { name: string; sector: string; market?: string }
}

/**
 * 從 D1 stocks 表取已有的 sector mapping。
 * Sector 欄位由 canonical stock metadata / official TWSE/TPEX refresh 寫入。
 * 結果快取到 KV（每週刷新一次）。
 */
async function getSectorMapping(env: Bindings): Promise<SectorMap> {
  // 先查 KV 快取
  const cacheKey = 'screener:sector-map'
  const cached = await env.KV.get(cacheKey, 'json') as SectorMap | null
  if (cached) return cached

  // D1 stocks 表（sector 已由 TWSE opendata 在 screener 初始化時填入）
  const { results: dbStocks } = await env.DB.prepare(
    "SELECT symbol, name, sector, market FROM stocks WHERE sector IS NOT NULL AND sector != ''"
  ).all<{ symbol: string; name: string; sector: string; market?: string }>()
  const map: SectorMap = {}
  for (const s of dbStocks ?? []) {
    map[s.symbol] = { name: s.name, sector: s.sector, market: s.market }
  }

  // 快取 7 天
  await env.KV.put(cacheKey, JSON.stringify(map), { expirationTtl: 7 * 86400 })
  return map
}

// ─── Stage 1: Sector Heat Detection ─────────────────────────────────────────

interface ChipDayNet {
  foreign: number
  trust: number
  dealer?: number
  brokerProxy?: number
  source?: string
  marketSegment?: string
  brokerCount?: number | null
  estimatedAmount?: number | null
  concentration?: number | null
}

interface StockDailyData {
  prices: Map<string, FMStockPrice[]>   // stockId → sorted prices
  chips: Map<string, Map<string, ChipDayNet>>  // stockId → date → net
}

interface StrategyRawFundamentalSignals {
  revenueGrowthYoY?: number | null
  monthlyRevenueYoY?: number | null
  monthlyRevenueMoM?: number | null
  grossMargin?: number | null
  operatingMargin?: number | null
  roe?: number | null
  eps?: number | null
  pe?: number | null
  pb?: number | null
  dividendYield?: number | null
  source?: string | null
}

interface StrategyRawSignals extends StrategyRawFundamentalSignals {
  close?: number | null
  ma20?: number | null
  ma60?: number | null
  closeAboveMa20Pct?: number | null
  closeAboveMa60Pct?: number | null
  volumeExpansion20?: number | null
  return20d?: number | null
  return60d?: number | null
  foreignNet5d?: number | null
  trustNet5d?: number | null
  dealerNet5d?: number | null
  foreignTrustNet5d?: number | null
  brokerNetShares5d?: number | null
  brokerNetAmount5d?: number | null
  brokerCount?: number | null
  brokerConcentration?: number | null
  technicalIndicators?: Record<string, number | null>
  factorSignals?: Record<string, number | null>
}

function buildStockData(
  allPrices: FMStockPrice[],
  allChips: FMChip[],
): StockDailyData {
  // Group prices by stock_id, sorted by date
  const prices = new Map<string, FMStockPrice[]>()
  for (const p of allPrices) {
    if (!prices.has(p.stock_id)) prices.set(p.stock_id, [])
    prices.get(p.stock_id)!.push(p)
  }
  for (const arr of prices.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date))
  }

  // Group chips by stock_id/date. V4.1 keeps listed/OTC institution nets and
  // emerging broker-flow proxy in the same scoring lane, while preserving source metadata.
  const chips = new Map<string, Map<string, ChipDayNet>>()
  for (const c of allChips) {
    if (!chips.has(c.stock_id)) chips.set(c.stock_id, new Map())
    const dateMap = chips.get(c.stock_id)!
    if (!dateMap.has(c.date)) dateMap.set(c.date, { foreign: 0, trust: 0 })
    const entry = dateMap.get(c.date)!
    const net = c.buy - c.sell
    const chipName = String(c.name ?? '').toLowerCase()
    if (chipName.includes('foreign')) entry.foreign += net
    if (chipName.includes('trust')) entry.trust += net
    if (chipName.includes('dealer')) entry.dealer = (entry.dealer ?? 0) + net
    if (chipName.includes('broker_proxy')) {
      entry.brokerProxy = (entry.brokerProxy ?? 0) + net
    }
    if (c.name.includes('外資')) entry.foreign += net
    if (c.name.includes('投信')) entry.trust += net
    entry.source = c.source ?? entry.source
    entry.marketSegment = c.market_segment ?? entry.marketSegment
    entry.brokerCount = c.broker_count ?? entry.brokerCount ?? null
    entry.estimatedAmount = c.estimated_amount ?? entry.estimatedAmount ?? null
    entry.concentration = c.concentration ?? entry.concentration ?? null
  }

  return { prices, chips }
}

/**
 * 計算大盤 5 日報酬率（用加權指數或全市場平均）
 * 這裡用全市場等權平均近似
 */
function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function avg(values: number[]): number | null {
  const clean = values.filter(Number.isFinite)
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null
}

function pctChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return (current - previous) / previous
}

function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null
  let gains = 0
  let losses = 0
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff
    else losses += Math.abs(diff)
  }
  if (gains === 0 && losses === 0) return 50
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function mergeFundamentalSignals(
  map: Map<string, StrategyRawFundamentalSignals>,
  symbol: string,
  patch: StrategyRawFundamentalSignals,
): void {
  const key = String(symbol || '').trim()
  if (!key) return
  const existing = map.get(key) ?? {}
  const next: StrategyRawFundamentalSignals = { ...existing }
  for (const [field, value] of Object.entries(patch) as Array<[keyof StrategyRawFundamentalSignals, unknown]>) {
    if (field === 'source') continue
    if (next[field] == null && value != null && value !== '') {
      ;(next as Record<string, unknown>)[field] = value
    }
  }
  next.source = [existing.source, patch.source].filter(Boolean).join('+') || null
  map.set(key, next)
}

async function loadStrategyRawFundamentalSignals(
  env: Bindings,
  symbols: string[],
  endDate: string,
): Promise<Map<string, StrategyRawFundamentalSignals>> {
  const fundamentals = new Map<string, StrategyRawFundamentalSignals>()
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  if (!uniqueSymbols.length) return fundamentals
  const revenueMonth = endDate.slice(0, 7)

  for (const chunk of chunkArray(uniqueSymbols, D1_IN_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(',')
    try {
      const { results } = await env.DB.prepare(`
        SELECT f.stock_id AS symbol,
               f.revenue_growth_yoy, f.gross_margin, f.operating_margin, f.roe,
               f.eps, f.pe, f.pb, f.dividend_yield
          FROM canonical_fundamental_features f
         WHERE f.stock_id IN (${placeholders})
           AND f.available_date <= ?
           AND f.available_date = (
             SELECT MAX(f2.available_date)
               FROM canonical_fundamental_features f2
              WHERE f2.stock_id = f.stock_id
                AND f2.available_date <= ?
           )
      `).bind(...chunk, endDate, endDate).all<{
        symbol: string
        revenue_growth_yoy: number | null
        gross_margin: number | null
        operating_margin: number | null
        roe: number | null
        eps: number | null
        pe: number | null
        pb: number | null
        dividend_yield: number | null
      }>()
      for (const row of results ?? []) {
        mergeFundamentalSignals(fundamentals, row.symbol, {
          revenueGrowthYoY: finiteOrNull(row.revenue_growth_yoy),
          grossMargin: finiteOrNull(row.gross_margin),
          operatingMargin: finiteOrNull(row.operating_margin),
          roe: finiteOrNull(row.roe),
          eps: finiteOrNull(row.eps),
          pe: finiteOrNull(row.pe),
          pb: finiteOrNull(row.pb),
          dividendYield: finiteOrNull(row.dividend_yield),
          source: 'canonical_fundamental_features',
        })
      }
    } catch {
      // Older local D1 snapshots may not have canonical_fundamental_features.
    }

    try {
      const { results } = await env.DB.prepare(`
        SELECT r.stock_id AS symbol, r.yoy, r.mom
          FROM canonical_revenue_monthly r
         WHERE r.stock_id IN (${placeholders})
           AND r.revenue_month <= ?
           AND r.revenue_month = (
             SELECT MAX(r2.revenue_month)
               FROM canonical_revenue_monthly r2
              WHERE r2.stock_id = r.stock_id
                AND r2.revenue_month <= ?
           )
      `).bind(...chunk, revenueMonth, revenueMonth).all<{
        symbol: string
        yoy: number | null
        mom: number | null
      }>()
      for (const row of results ?? []) {
        mergeFundamentalSignals(fundamentals, row.symbol, {
          monthlyRevenueYoY: finiteOrNull(row.yoy),
          monthlyRevenueMoM: finiteOrNull(row.mom),
          source: 'canonical_revenue_monthly',
        })
      }
    } catch {
      // Canonical revenue is optional in older snapshots; legacy monthly_revenue fills below.
    }

    try {
      const { results } = await env.DB.prepare(`
        SELECT s.symbol, f.revenue_growth_yoy, f.roe, f.eps, f.pe, f.pb, f.dividend_yield
          FROM financials f
          JOIN stocks s ON s.id = f.stock_id
         WHERE s.symbol IN (${placeholders})
           AND f.period_type = 'quarterly'
           AND f.period = (
             SELECT MAX(f2.period)
               FROM financials f2
              WHERE f2.stock_id = f.stock_id
                AND f2.period_type = 'quarterly'
           )
      `).bind(...chunk).all<{
        symbol: string
        revenue_growth_yoy: number | null
        roe: number | null
        eps: number | null
        pe: number | null
        pb: number | null
        dividend_yield: number | null
      }>()
      for (const row of results ?? []) {
        mergeFundamentalSignals(fundamentals, row.symbol, {
          revenueGrowthYoY: finiteOrNull(row.revenue_growth_yoy),
          roe: finiteOrNull(row.roe),
          eps: finiteOrNull(row.eps),
          pe: finiteOrNull(row.pe),
          pb: finiteOrNull(row.pb),
          dividendYield: finiteOrNull(row.dividend_yield),
          source: 'legacy.financials',
        })
      }
    } catch {
      // Legacy fundamentals are a fallback only.
    }

    try {
      const { results } = await env.DB.prepare(`
        SELECT s.symbol, r.revenue_yoy, r.revenue_mom
          FROM monthly_revenue r
          JOIN stocks s ON s.id = r.stock_id
         WHERE s.symbol IN (${placeholders})
           AND r.date <= ?
           AND r.date = (
             SELECT MAX(r2.date)
               FROM monthly_revenue r2
              WHERE r2.stock_id = r.stock_id
                AND r2.date <= ?
           )
      `).bind(...chunk, revenueMonth, revenueMonth).all<{
        symbol: string
        revenue_yoy: number | null
        revenue_mom: number | null
      }>()
      for (const row of results ?? []) {
        mergeFundamentalSignals(fundamentals, row.symbol, {
          monthlyRevenueYoY: finiteOrNull(row.revenue_yoy),
          monthlyRevenueMoM: finiteOrNull(row.revenue_mom),
          source: 'legacy.monthly_revenue',
        })
      }
    } catch {
      // Legacy monthly revenue is a fallback only.
    }
  }

  return fundamentals
}

function deriveStrategyRawSignals(
  prices: FMStockPrice[],
  chipDates: Map<string, ChipDayNet> | undefined,
  fundamentals?: StrategyRawFundamentalSignals,
): StrategyRawSignals {
  const latest = prices[prices.length - 1]
  const closes = prices.map((price) => finiteOrNull(price.close)).filter((value): value is number => value != null)
  const volumes = prices.map((price) => finiteOrNull(price.Trading_Volume)).filter((value): value is number => value != null)
  const close = latest ? finiteOrNull(latest.close) : null
  const ma20 = avg(closes.slice(-20))
  const ma60 = avg(closes.slice(-60))
  const avgVol5 = avg(volumes.slice(-5))
  const avgVol20 = avg(volumes.slice(-20))
  const latestIndex = closes.length - 1
  const closeAboveMa20Pct = pctChange(close, ma20)
  const closeAboveMa60Pct = pctChange(close, ma60)
  const volumeExpansion20 = avgVol5 != null && avgVol20 != null && avgVol20 > 0 ? avgVol5 / avgVol20 : null
  const return20d = latestIndex >= 20 ? pctChange(closes[latestIndex], closes[latestIndex - 20]) : null
  const return60d = latestIndex >= 60 ? pctChange(closes[latestIndex], closes[latestIndex - 60]) : null
  const latestRsi14 = rsi14(closes)
  const chipRows = [...(chipDates?.entries() ?? [])]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-5)
    .map(([, value]) => value)
  const foreignNet5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.foreign) ?? 0), 0)
  const trustNet5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.trust) ?? 0), 0)
  const dealerNet5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.dealer) ?? 0), 0)
  const brokerNetShares5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.brokerProxy) ?? 0), 0)
  const brokerNetAmount5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.estimatedAmount) ?? 0), 0)
  const latestBroker = [...chipRows].reverse().find((row) => row.brokerCount != null || row.concentration != null)
  const base: StrategyRawSignals = {
    close,
    ma20,
    ma60,
    closeAboveMa20Pct,
    closeAboveMa60Pct,
    volumeExpansion20,
    return20d,
    return60d,
    foreignNet5d,
    trustNet5d,
    dealerNet5d,
    foreignTrustNet5d: foreignNet5d + trustNet5d,
    brokerNetShares5d,
    brokerNetAmount5d,
    brokerCount: finiteOrNull(latestBroker?.brokerCount),
    brokerConcentration: finiteOrNull(latestBroker?.concentration),
    ...(fundamentals ?? {}),
    source: [
      'stock_prices',
      chipRows.some((row) => String(row.source || '').includes('canonical')) ? 'canonical_chip_or_broker_flow' : null,
      fundamentals?.source ?? null,
    ].filter(Boolean).join('+'),
  }

  return {
    ...base,
    technicalIndicators: {
      closeAboveMa20Pct,
      closeAboveMa60Pct,
      volumeExpansion20,
      return20d,
      return60d,
      rsi14: latestRsi14,
    },
    factorSignals: {
      closeAboveMa20Pct,
      volumeExpansion20,
      return20d,
      rsi14: latestRsi14,
      foreignTrustNet5d: base.foreignTrustNet5d ?? null,
      brokerNetShares5d,
      brokerNetAmount5d,
      brokerCount: base.brokerCount ?? null,
      brokerConcentration: base.brokerConcentration ?? null,
      revenueGrowthYoY: base.revenueGrowthYoY ?? null,
      monthlyRevenueYoY: base.monthlyRevenueYoY ?? null,
      monthlyRevenueMoM: base.monthlyRevenueMoM ?? null,
      grossMargin: base.grossMargin ?? null,
      operatingMargin: base.operatingMargin ?? null,
      roe: base.roe ?? null,
      eps: base.eps ?? null,
      pe: base.pe ?? null,
      pb: base.pb ?? null,
      dividendYield: base.dividendYield ?? null,
    },
  }
}

function rawSignalEmergencyFallbackScore(candidate: { raw_signals?: StrategyRawSignals; score?: number | null }): number {
  const raw = candidate.raw_signals ?? {}
  const close20 = finiteOrNull(raw.closeAboveMa20Pct) ?? 0
  const close60 = finiteOrNull(raw.closeAboveMa60Pct) ?? 0
  const volume = finiteOrNull(raw.volumeExpansion20) ?? 1
  const ret20 = finiteOrNull(raw.return20d) ?? 0
  const flowAmount = finiteOrNull(raw.brokerNetAmount5d) ?? 0
  const flowShares = finiteOrNull(raw.foreignTrustNet5d) ?? 0
  const revenue = finiteOrNull(raw.revenueGrowthYoY) ?? finiteOrNull(raw.monthlyRevenueYoY) ?? 0
  const roe = finiteOrNull(raw.roe) ?? 0
  const eps = finiteOrNull(raw.eps) ?? 0
  const pe = finiteOrNull(raw.pe)
  const trendScore = Math.max(-12, Math.min(18, close20 * 180))
    + Math.max(-10, Math.min(14, close60 * 120))
    + Math.max(-6, Math.min(16, (volume - 0.8) * 18))
    + Math.max(-8, Math.min(12, ret20 * 80))
  const flowScore = Math.max(-10, Math.min(14, Math.sign(flowAmount) * Math.log10(Math.abs(flowAmount) + 1)))
    + Math.max(-8, Math.min(12, Math.sign(flowShares) * Math.log10(Math.abs(flowShares) + 1)))
  const qualityScore = Math.max(-8, Math.min(12, revenue / 4))
    + Math.max(-4, Math.min(12, roe / 2))
    + Math.max(-6, Math.min(12, eps * 2))
  const valuationScore = pe == null ? 0 : Math.max(-8, Math.min(12, 10 - (pe - 12) / 3))
  return Math.max(0, Math.min(100, 45 + trendScore * 0.34 + flowScore * 0.25 + qualityScore * 0.28 + valuationScore * 0.13))
}

function calcMarketReturn5d(data: StockDailyData): number {
  let totalReturn = 0
  let count = 0
  for (const prices of data.prices.values()) {
    if (prices.length < 6) continue
    const recent = prices[prices.length - 1].close
    const fiveDaysAgo = prices[prices.length - 6]?.close
    if (recent > 0 && fiveDaysAgo > 0) {
      totalReturn += (recent - fiveDaysAgo) / fiveDaysAgo
      count++
    }
  }
  return count > 0 ? totalReturn / count : 0
}

function latestChipMeta(chipDates: Map<string, ChipDayNet> | undefined): string | null {
  if (!chipDates?.size) return null
  const sortedDates = [...chipDates.keys()].sort()
  const latestDate = sortedDates[sortedDates.length - 1]
  if (!latestDate) return null
  const row = chipDates.get(latestDate)
  if (!row?.source) return null
  const parts = [`chip_source=${row.source}`, `source_date=${latestDate}`]
  if (row.marketSegment) parts.push(`market_segment=${row.marketSegment}`)
  if (row.brokerCount != null) parts.push(`broker_count=${row.brokerCount}`)
  if (row.estimatedAmount != null) parts.push(`estimated_amount=${Math.round(row.estimatedAmount)}`)
  if (row.concentration != null) parts.push(`concentration=${row.concentration.toFixed(3)}`)
  return parts.join(',')
}

interface BrokerProxySummary {
  netShares5d: number
  estimatedAmount5d: number
  turnoverIntensity5d: number | null
  consecBuyDays: number
  latestBrokerCount: number | null
  latestConcentration: number | null
  latestSource: string
  latestDate: string
  marketSegment: string
}

function formatAbsTwdAmount(amount: number): string {
  const abs = Math.abs(amount)
  if (abs < 1e8) return `${Math.round(abs / 10_000)}萬`
  return `${(abs / 1e8).toFixed(2)}億`
}

function summarizeBrokerProxyChip(
  chipDates: Map<string, ChipDayNet> | undefined,
  prices: FMStockPrice[],
  latestClose: number,
): BrokerProxySummary | null {
  if (!chipDates?.size) return null
  const sortedDates = [...chipDates.keys()].sort().slice(-5)
  if (!sortedDates.length) return null

  let netShares5d = 0
  let estimatedAmount5d = 0
  let hasBrokerProxy = false
  let consecBuyDays = 0
  let streakBroken = false
  let latestBrokerCount: number | null = null
  let latestConcentration: number | null = null
  let latestSource = ''
  let latestDate = sortedDates[sortedDates.length - 1]
  let marketSegment = ''

  for (let i = sortedDates.length - 1; i >= 0; i--) {
    const date = sortedDates[i]
    const row = chipDates.get(date)
    if (!row) continue
    const shares = row.brokerProxy ?? 0
    const amount = row.estimatedAmount ?? (shares * latestClose)
    if (shares !== 0 || row.estimatedAmount != null) hasBrokerProxy = true
    netShares5d += shares
    estimatedAmount5d += Number.isFinite(amount) ? amount : 0
    latestBrokerCount = row.brokerCount ?? latestBrokerCount
    latestConcentration = row.concentration ?? latestConcentration
    latestSource = row.source ?? latestSource
    marketSegment = row.marketSegment ?? marketSegment
    if (date > latestDate) latestDate = date
    if (!streakBroken) {
      if (shares > 0) consecBuyDays++
      else streakBroken = true
    }
  }

  if (!hasBrokerProxy) return null
  const avgDailyTurnover = prices.reduce((s, p) => s + p.Trading_Volume * p.close, 0) / Math.max(1, prices.length)
  const windowTurnover = avgDailyTurnover * Math.max(1, sortedDates.length)
  const turnoverIntensity5d = windowTurnover > 0 ? estimatedAmount5d / windowTurnover : null

  return {
    netShares5d,
    estimatedAmount5d,
    turnoverIntensity5d,
    consecBuyDays,
    latestBrokerCount,
    latestConcentration,
    latestSource: latestSource || 'finlab.rotc_broker_transactions',
    latestDate,
    marketSegment: marketSegment || 'EMERGING',
  }
}

function scoreBrokerProxyChip(summary: BrokerProxySummary): { score: number; reasons: string[] } {
  const amount = summary.estimatedAmount5d
  const amountBillion = amount / 1e8
  const intensity = summary.turnoverIntensity5d
  let score = 0

  if (amount > 0) {
    const amountScore = clamp(Math.log10(1 + Math.abs(amount) / 1_000_000) * 4.5, 4, 18)
    const intensityScore = intensity == null
      ? clamp(amountBillion * 80, 0, 14)
      : clamp(Math.sqrt(Math.abs(intensity)) * 24, 0, 16)
    const breadthScore = summary.latestBrokerCount == null
      ? 3
      : clamp(Math.log2(Math.max(1, summary.latestBrokerCount)) * 1.2, 1, 6)
    const concentrationPenalty = summary.latestConcentration == null
      ? 0
      : summary.latestConcentration > 0.85
        ? 5
        : summary.latestConcentration > 0.65
          ? 3
          : 0
    score = amountScore + intensityScore + breadthScore - concentrationPenalty
  } else if (amount > -1_000_000) {
    score = 2
  } else {
    const sellPressure = clamp(Math.log10(1 + Math.abs(amount) / 1_000_000) * 2.5, 2, 10)
    score = Math.max(0, 6 - sellPressure)
  }

  if (summary.consecBuyDays >= 3 && amount > 0) score += summary.consecBuyDays >= 5 ? 3 : 1
  score = Math.round(clamp(score, 0, 40) * 10) / 10

  const direction = amount >= 0 ? '買超' : '賣超'
  const reasons = [
    `券商分點5日${direction}${formatAbsTwdAmount(amount)}`,
  ]
  if (intensity != null) reasons.push(`佔5日成交${Math.abs(intensity * 100).toFixed(1)}%`)
  if (summary.latestBrokerCount != null) reasons.push(`券商數${summary.latestBrokerCount}`)
  if (summary.latestConcentration != null) reasons.push(`集中度${summary.latestConcentration.toFixed(2)}`)
  return { score, reasons }
}

// ─── DB Operations ───────────────────────────────────────────────────────────

async function updateScreenerWatchlist(db: D1Database, candidates: ScreenerCandidate[], tpexSymbolSet: Set<string>): Promise<void> {
  const candidateSymbols = candidates.map(c => c.symbol)

  // ── Step 1: 停用上一輪的非 pinned screener 股票 ─────────────────────────
  // source='screener' 且非 pinned → 全部先停用，再由 Step 2 重新啟用本輪候選
  // pinned=1（使用者手動加的）永遠不被 screener 輪換影響
  if (!candidates.length) {
    await db.prepare("UPDATE stocks SET in_current_watchlist=0 WHERE source='screener' AND COALESCE(pinned,0)=0").run()
    return
  }

  if (candidateSymbols.length > 900) {
    await db.prepare("UPDATE stocks SET in_current_watchlist=0 WHERE source='screener' AND COALESCE(pinned,0)=0").run()
  } else {
    const placeholders = candidateSymbols.map(() => '?').join(',')
    await db.prepare(
      `UPDATE stocks SET in_current_watchlist=0 WHERE source='screener' AND COALESCE(pinned,0)=0 AND symbol NOT IN (${placeholders})`
    ).bind(...candidateSymbols).run()
  }

  // ── Step 2: Upsert 候選股票 ────────────────────────────────────────────
  // pinned 股票：只更新 in_current_watchlist=1、sector，不動 source
  // 非 pinned 股票：source 設為 screener，下一輪可被正確輪換
  const batch = candidates.map(c => {
    // 根據資料來源判斷市場：TPEX API 來的是 OTC，其餘為 TWSE
    const market = tpexSymbolSet.has(c.symbol) ? 'OTC' : 'TWSE'
    return db.prepare(`
      INSERT INTO stocks (symbol, name, market, sector, in_current_watchlist, source)
      VALUES (?, ?, ?, ?, 1, 'screener')
      ON CONFLICT(symbol) DO UPDATE SET
        in_current_watchlist=1,
        market=excluded.market,
        source=CASE WHEN COALESCE(stocks.pinned,0)=1 THEN stocks.source ELSE 'screener' END,
        sector=COALESCE(excluded.sector, stocks.sector),
        updated_at=datetime('now')
    `).bind(c.symbol, c.name, market, c.sector)
  })

  const BATCH_SIZE = 50
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await db.batch(batch.slice(i, i + BATCH_SIZE))
  }
}

async function storeSectorHeat(
  db: D1Database,
  date: string,
  scores: SectorHeatScore[],
): Promise<void> {
  const batch = scores.slice(0, 20).map(s =>
    db.prepare(`
      INSERT INTO sector_heat (date, sector, score, chip_flow, relative_strength, volume_expansion, momentum, top_stocks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, sector) DO UPDATE SET
        score=excluded.score, chip_flow=excluded.chip_flow,
        relative_strength=excluded.relative_strength,
        volume_expansion=excluded.volume_expansion,
        momentum=excluded.momentum, top_stocks=excluded.top_stocks
    `).bind(
      date, s.sector, s.score,
      s.components.chipFlow, s.components.relativeStrength,
      s.components.volumeExpansion, s.components.momentum,
      JSON.stringify(s.topStocks),
    )
  )

  const BATCH_SIZE = 50
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    await db.batch(batch.slice(i, i + BATCH_SIZE))
  }
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// Bottom-up 多因子 + RRG 產業輪動 Screener（v2）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 從 stock_tags(tag_type='industry') 建立 symbol → 官方產業 mapping
 * 取代舊 getSectorMapping()（那個讀 stocks.sector 是概念名）
 */
async function getIndustryMapping(db: D1Database, kv: KVNamespace): Promise<Map<string, string>> {
  const cacheKey = 'screener:industry-map:v4.2-finlab-four-layer-taxonomy'
  const cached = await kv.get(cacheKey, 'json') as Record<string, string> | null
  if (cached) return new Map(Object.entries(cached))

  const map = new Map<string, string>()
  try {
    const { results } = await db.prepare(`
      SELECT symbol, tag, tag_type, source, weight, priority
      FROM (
        SELECT symbol, tag, tag_type, source, weight, 1 AS priority
          FROM finlab_taxonomy_tags
         WHERE tag_type IN ('industry_theme', 'industry', 'subindustry')
        UNION ALL
        SELECT symbol, tag, tag_type, source, weight, 5 AS priority
          FROM stock_tags
         WHERE tag_type='industry'
      )
      ORDER BY symbol, priority ASC, weight DESC
    `).all<{ symbol: string; tag: string; tag_type?: string; source?: string; weight?: number; priority?: number }>()
    for (const r of (results ?? [])) {
      if (!map.has(r.symbol)) map.set(r.symbol, r.tag)
    }
  } catch {
    const { results } = await db.prepare(
      "SELECT symbol, tag FROM stock_tags WHERE tag_type='industry'"
    ).all<{ symbol: string; tag: string }>()
    for (const r of (results ?? [])) map.set(r.symbol, r.tag)
  }

  // 快取 7 天
  await kv.put(cacheKey, JSON.stringify(Object.fromEntries(map)), { expirationTtl: 7 * 86400 })
  return map
}

/**
 * Step 2: 多因子評分（FinLab 優化版）
 *
 * 籌碼(0-40): 用 5 日法人淨買超 / 20 日均成交金額，避免大型股金額偏誤
 * 技術(0-30): 趨勢品質分數；高 RSI 只視為動能，不當成無風險滿分
 * 動能(0-20): 超額報酬 + 量能比 + 價格意圖因子 + RSI 鈍化
 */
// Sprint 6a.7b: exported for cross-runtime parity test
// (ml-controller/tests/test_screener_parity.py)
export function scoreMultiFactor(
  prices: FMStockPrice[],
  chipDates: Map<string, ChipDayNet> | undefined,
  marketReturn5d: number,
  latestClose: number,
  config?: TradingConfig,
): { base_score: number; chip_score: number; tech_score: number; momentum_score: number; score_components: string; reasons: string[] } {
  const sc = config?.screener
  const reasons: string[] = []
  const latest = prices[prices.length - 1]

  // ── P0-1: 籌碼面 (0-40) — 用相對比例，消除大小型股偏差 ──
  let chip_score = 0
  if (chipDates) {
    const brokerSummary = summarizeBrokerProxyChip(chipDates, prices, latestClose)
    const isEmergingBrokerFlow = brokerSummary && brokerSummary.marketSegment.toUpperCase() === 'EMERGING'
    if (isEmergingBrokerFlow) {
      const scoredBroker = scoreBrokerProxyChip(brokerSummary)
      chip_score = scoredBroker.score
      reasons.push(...scoredBroker.reasons)
      reasons.push(`broker_flow:${brokerSummary.latestSource} net=${Math.round(brokerSummary.netShares5d)} source_date=${brokerSummary.latestDate}`)
    } else {
      let netBuyShares = 0  // 5 日淨買超股數
      let consecBuyDays = 0
      // Sprint 6a.7b M11 fix (2026-04-08): count consecutive buy days from the
      // most recent day going back, stopping at the first non-positive day.
      // Previous impl zeroed consecBuyDays when hitting a negative mid-loop,
      // which lost the count entirely — e.g. [-,+,+,+,+] returned 0 instead of 4.
      // Python backtest_engine.score_multi_factor had this semantics already.
      // See memory/mistake.md M11.
      const sortedDates = [...chipDates.keys()].sort().slice(-5)
      let streakBroken = false
      for (let i = sortedDates.length - 1; i >= 0; i--) {
        const d = sortedDates[i]
        const nets = chipDates.get(d)!
        const dayNet = nets.foreign + nets.trust + (nets.dealer ?? 0)
        netBuyShares += dayNet
        if (!streakBroken) {
          if (dayNet > 0) consecBuyDays++
          else streakBroken = true
        }
      }

      // chip_intensity = 淨買超金額 / 20日均成交金額（比例）
      const netBuyAmount = netBuyShares * latestClose  // 元
      const avgDailyTurnover = prices.reduce((s, p) => s + p.Trading_Volume * p.close, 0) / prices.length
      const chipIntensity = avgDailyTurnover > 0 ? netBuyAmount / avgDailyTurnover : 0

      // 相對比例分級：80%+ ADTV 才接近極端累積，避免牛市中大量候選股都接近滿分。
      const chipTiers = sc?.chipScoreTiers ?? [32, 24, 16, 8, 2]
      const chipThresholds = sc?.chipIntensityThresholds ?? [0.80, 0.45, 0.20, 0.05, -0.05]
      if (chipIntensity > chipThresholds[0]) chip_score = chipTiers[0]
      else if (chipIntensity > chipThresholds[1]) chip_score = chipTiers[1]
      else if (chipIntensity > chipThresholds[2]) chip_score = chipTiers[2]
      else if (chipIntensity > chipThresholds[3]) chip_score = chipTiers[3]
      else if (chipIntensity > chipThresholds[4]) chip_score = chipTiers[4]  // 微賣
      // else 0

      if (chipIntensity > 0.05) reasons.push(`法人佔成交${(chipIntensity * 100).toFixed(1)}%`)

      // 連續買超天數 bonus
      const cbBonus = sc?.consecBuyBonusTiers ?? [3, 1]
      const cbDays = sc?.consecBuyDayThresholds ?? [5, 3]
      if (consecBuyDays >= cbDays[0]) { chip_score += cbBonus[0]; reasons.push(`連買${consecBuyDays}天`) }
      else if (consecBuyDays >= cbDays[1]) { chip_score += cbBonus[1] }
    }
  }
  chip_score = clamp(chip_score, 0, 40)

  // ── P0-2: 技術面 (0-30) — 趨勢品質，避免超買股無條件滿分 ──
  let tech_score = 0

  // RSI 14：50-68 是趨勢健康區；75+ 代表動能強但追高風險也升高。
  let rsiValue = 50
  if (prices.length >= 15) {
    const changes14 = prices.slice(-15).map((p, i, arr) =>
      i === 0 ? 0 : p.close - arr[i - 1].close
    ).slice(1)
    const gains = changes14.filter(c => c > 0)
    const losses = changes14.filter(c => c < 0).map(c => -c)
    const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / 14 : 0
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / 14 : 0.001
    const rsi = 100 - 100 / (1 + avgGain / avgLoss)
    rsiValue = rsi

    const rsiTiers = sc?.rsiScoreTiers ?? [10, 6, 4, 2, 2]
    if (rsi >= 55 && rsi <= 68) { tech_score += rsiTiers[0]; reasons.push(`RSI ${rsi.toFixed(0)}`) }
    else if (rsi > 68 && rsi <= 75) { tech_score += rsiTiers[1]; reasons.push(`RSI ${rsi.toFixed(0)}`) }
    else if (rsi >= 45 && rsi < 55) tech_score += rsiTiers[2]
    else if (rsi > 75 && rsi <= 85) tech_score += rsiTiers[3]
    else if (rsi >= 30 && rsi < 45) tech_score += rsiTiers[4]
  }

  // MACD（近似 EMA12 - EMA26）
  if (prices.length >= 20) {
    const ma12 = prices.slice(-12).reduce((s, p) => s + p.close, 0) / 12
    const ma26 = prices.slice(-Math.min(26, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(26, prices.length)
    const macdApprox = ma12 - ma26
    if (macdApprox > 0) { tech_score += 6; reasons.push('MACD 多頭') }
    else if (macdApprox > -(sc?.macdNegativeFactor ?? 0.5) * latestClose / 100) tech_score += 2
  }

  // 均線排列
  if (prices.length >= 5) {
    const ma5 = prices.slice(-5).reduce((s, p) => s + p.close, 0) / 5
    if (latest.close > ma5) tech_score += 1
  }
  if (prices.length >= 20) {
    const ma20 = prices.slice(-20).reduce((s, p) => s + p.close, 0) / 20
    if (latest.close > ma20) { tech_score += 3; reasons.push('站上MA20') }

  }

  // P3-5: NATR 低波動加分（低波動 + 趨勢中 = 穩健上漲）
  if (prices.length >= 14) {
    const trueRanges = prices.slice(-15).map((p, i, arr) => {
      if (i === 0) return p.max - p.min
      const prev = arr[i - 1]
      return Math.max(p.max - p.min, Math.abs(p.max - prev.close), Math.abs(p.min - prev.close))
    }).slice(1)
    const atr14 = trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length
    const natr = latestClose > 0 ? (atr14 / latestClose) * 100 : 0

    // 肯特納通道突破
    const ma20 = prices.slice(-Math.min(20, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(20, prices.length)
    const keltnerMult = sc?.keltnerMultiplier ?? 1.5
    if (latest.close > ma20 + keltnerMult * atr14 && atr14 > 0) {
      tech_score += 2
      reasons.push('突破肯特納')
    }

    // NATR 低波動：< threshold 且在均線上方 = 穩健趨勢（FinLab IC 驗證）
    if (natr < (sc?.natrThreshold ?? 3) && latest.close > ma20) tech_score += 1
  }
  tech_score = clamp(tech_score, 0, 30)

  // ── 動能面 (0-20) — 加入價格意圖因子 ──
  let momentum_score = 0

  // 5d excess return vs 大盤 (0-7)
  if (prices.length >= 6) {
    const stockReturn = (latest.close - prices[prices.length - 6].close) / prices[prices.length - 6].close
    const excess = stockReturn - marketReturn5d
    const exRange = sc?.excessReturnRange ?? [-0.03, 0.05]
    momentum_score += normalize(excess, exRange[0], exRange[1], 7)
    if (excess > 0.02) reasons.push(`超額+${(excess * 100).toFixed(1)}%`)
  }

  // 量能比：近 3 日 vs 20 日均量 (0-5)
  if (prices.length >= 5) {
    const recent3 = prices.slice(-3).reduce((s, p) => s + p.Trading_Volume, 0) / 3
    const avg20 = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
    const volRatio = avg20 > 0 ? recent3 / avg20 : 1
    const vrRange = sc?.volRatioRange ?? [0.7, 2.5]
    momentum_score += normalize(volRatio, vrRange[0], vrRange[1], 5)
    if (volRatio > 1.5) reasons.push(`量能${volRatio.toFixed(1)}倍`)
  }

  // P1-3: 價格意圖因子 (0-5) — FinLab 線性因子
  // price_intent = N日報酬 / N日每日絕對報酬總和（1=直線上漲，0=震盪）
  if (prices.length >= 15) {
    const n = Math.min(20, prices.length - 1)
    const retN = (latest.close - prices[prices.length - 1 - n].close) / prices[prices.length - 1 - n].close
    let sumAbsRet = 0
    for (let d = prices.length - n; d < prices.length; d++) {
      if (prices[d - 1].close > 0) sumAbsRet += Math.abs((prices[d].close - prices[d - 1].close) / prices[d - 1].close)
    }
    const priceIntent = sumAbsRet > 0 ? retN / sumAbsRet : 0
    // intent > 0.5 = 大部分漲幅是直線上漲（主力護盤訊號）
    if (priceIntent > 0.5) { momentum_score += 5; reasons.push(`意圖${(priceIntent * 100).toFixed(0)}%`) }
    else if (priceIntent > 0.3) momentum_score += 3
    else if (priceIntent > 0.1) momentum_score += 1
  }

  // RSI 鈍化：RSI > 75 連 3+ 天（門檻從 80 降到 75）
  if (rsiValue > 75 && prices.length >= 6) {
    const recentChanges = prices.slice(-6).map((p, i, arr) =>
      i === 0 ? 0 : p.close - arr[i - 1].close
    ).slice(1)
    let consec = 0
    for (let d = recentChanges.length - 1; d >= 0; d--) {
      if (recentChanges[d] > 0) consec++
      else break
    }
    if (consec >= 3) {
      momentum_score += 3
      reasons.push(`RSI鈍化${consec}天`)
    }
  }
  momentum_score = clamp(momentum_score, 0, 20)

  const scoreV2 = buildPartialScreenerScoreV2({
    chipScore40: chip_score,
    techScore30: tech_score,
    momentumScore20: momentum_score,
    reasons,
  })
  const base_score = scoreV2.finalScore ?? scoreV2.total
  return {
    base_score,
    chip_score,
    tech_score,
    momentum_score,
    score_components: JSON.stringify(scoreV2),
    reasons,
  } as {
    base_score: number
    chip_score: number
    tech_score: number
    momentum_score: number
    score_components: string
    reasons: string[]
  }
}

// RRG logic (classifyQuadrant / backfillRRG / calcIndustryRRG) removed in Phase 6.6
// of 4/8 audit. The Z-score formula used here was incorrect (not Julius de Kempenaer
// RRG). RRG is now computed by ml-controller/services/sector_flow_service.py using
// the vs-TWII benchmark formula (1+group_ret)/(1+twii_ret)*100. V2 LangGraph
// daily_pipeline_v2.py → node_compute_sector_flow writes sector_flow with the
// correct formula for both concept ('theme') and industry tag_types.


/**
 * Step 5c: 報酬率相關性去重 — Pearson correlation > threshold 的只留最高分
 */
async function deduplicateByCorrelation(
  candidates: ScreenerCandidate[],
  db: D1Database,
  threshold: number,
  windowDays: number,
): Promise<ScreenerCandidate[]> {
  if (candidates.length <= 1) return candidates
  const symbols = candidates.map(c => c.symbol)

  const priceRows: { symbol: string; date: string; close: number }[] = []
  for (const chunk of chunkArray(symbols, 400)) {
    const ph = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(`
      SELECT s.symbol, sp.date, sp.close
      FROM stock_prices sp
      JOIN stocks s ON sp.stock_id = s.id
      WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-${windowDays + 30} days')
      ORDER BY s.symbol, sp.date
    `).bind(...chunk).all<{ symbol: string; date: string; close: number }>()
    priceRows.push(...(results ?? []))
  }

  if (!priceRows?.length) return candidates

  // 建 symbol → daily returns 序列
  const returnSeries = new Map<string, number[]>()
  const priceBySymbol = new Map<string, { date: string; close: number }[]>()
  for (const r of priceRows) {
    if (!priceBySymbol.has(r.symbol)) priceBySymbol.set(r.symbol, [])
    priceBySymbol.get(r.symbol)!.push(r)
  }
  for (const [sym, prices] of priceBySymbol) {
    if (prices.length < 10) continue  // 太少不算
    const returns: number[] = []
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1].close > 0) {
        returns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close)
      }
    }
    returnSeries.set(sym, returns)
  }

  // Pearson 相關性
  function pearson(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length)
    if (n < 10) return 0
    const ax = a.slice(-n), bx = b.slice(-n)
    const meanA = ax.reduce((s, v) => s + v, 0) / n
    const meanB = bx.reduce((s, v) => s + v, 0) / n
    let num = 0, denA = 0, denB = 0
    for (let i = 0; i < n; i++) {
      const da = ax[i] - meanA, db = bx[i] - meanB
      num += da * db
      denA += da * da
      denB += db * db
    }
    const den = Math.sqrt(denA * denB)
    return den > 0 ? num / den : 0
  }

  // 標記要移除的（correlation > threshold 時，移除分數較低的）
  const removed = new Set<string>()
  for (let i = 0; i < candidates.length; i++) {
    if (removed.has(candidates[i].symbol)) continue
    const aReturns = returnSeries.get(candidates[i].symbol)
    if (!aReturns) continue

    for (let j = i + 1; j < candidates.length; j++) {
      if (removed.has(candidates[j].symbol)) continue
      const bReturns = returnSeries.get(candidates[j].symbol)
      if (!bReturns) continue

      const corr = pearson(aReturns, bReturns)
      if (corr > threshold) {
        // 移除分數低的
        const loser = candidates[i].score >= candidates[j].score ? candidates[j].symbol : candidates[i].symbol
        removed.add(loser)
      }
    }
  }

  return candidates.filter(c => !removed.has(c.symbol))
}

/**
 * Bottom-up 全市場選股主流程（v2）
 */
export async function runBottomUpScreener(env: Bindings, runDate?: string | null): Promise<{
  hotSectors: SectorHeatScore[]
  candidates: ScreenerCandidate[]
  emergingResearchCandidates?: ScreenerCandidate[]
  debugLog?: string[]
}> {
  const debugLog: string[] = []
  const cfg = await getTradingConfig(env.KV)
  const sc = cfg.screener
  const adaptiveParams = await getAdaptiveParamsForRegime(env.KV)
  const screenerPolicy = resolveScreenerPolicy(cfg, adaptiveParams)
  const endDate = resolveScreenerRunDate(runDate)
  const runId = `screener-${endDate}-${Date.now()}`
  const funnelItems: ScreenerFunnelItemInput[] = []

  // ── 資料抓取（平行）──
  const { detectPttBuzz, storePttBuzz, loadBuzzKeywords } = await import('./pttBuzz')
  const { detectNewsBuzz } = await import('./newsBuzz')
  const { detectAnueBuzz } = await import('./anueBuzz')
  const {
    buzzResultsToThemeEvidence,
    combineMultiSourceThemeEvidence,
    loadRuntimeThemeSignals,
  } = await import('./multiSourceThemeEvidence')

  type BuzzResult = Awaited<ReturnType<typeof detectPttBuzz>>
  let allPrices: FMStockPrice[]
  let emergingResearchPrices: FMStockPrice[]
  let allChips: FMChip[]
  let tpexSymbolSet = new Set<string>()
  let combinedBuzz: BuzzResult = []
  let conceptBuzzScore = new Map<string, number>()
  let conceptEvidenceBreakdown = new Map<string, Record<string, number>>()

  try {
    const buzzKeywords = await loadBuzzKeywords(env.DB, env.KV).catch(() => undefined)

    const [marketData, pttBuzz, newsBuzz, anueBuzz, runtimeThemeSignals] = await Promise.all([
      loadMarketDataFromD1(env, 20, 5, endDate),
      detectPttBuzz(buzzKeywords).catch(() => [] as BuzzResult),
      detectNewsBuzz(env.DB, buzzKeywords).catch(() => [] as BuzzResult),
      detectAnueBuzz(buzzKeywords).catch(() => [] as BuzzResult),
      loadRuntimeThemeSignals(env.DB, endDate).catch(() => []),
    ])
    allPrices = marketData.allPrices
    emergingResearchPrices = marketData.emergingResearchPrices
    allChips = marketData.allChips
    tpexSymbolSet = marketData.tpexSymbols

    // 合併 buzz（Z-score 標準化，same as before）
    const themeEvidence = combineMultiSourceThemeEvidence([
      buzzResultsToThemeEvidence('ptt', pttBuzz),
      buzzResultsToThemeEvidence('news', newsBuzz),
      buzzResultsToThemeEvidence('anue', anueBuzz),
      runtimeThemeSignals,
    ])
    combinedBuzz = themeEvidence.combinedBuzz
    conceptBuzzScore = themeEvidence.scoreMap
    conceptEvidenceBreakdown = themeEvidence.sourceBreakdown

    debugLog.push(
      `[Data] prices=${allPrices.length} emerging_research=${emergingResearchPrices.length} ` +
      `chips=${allChips.length} buzz=${combinedBuzz.length} theme_sources=${JSON.stringify(themeEvidence.acceptedSources)} ` +
      `lanes=${JSON.stringify(marketData.laneCounts)} chip_sources=${JSON.stringify(marketData.chipSourceSummary ?? {})}`,
    )
  } catch (e) {
    console.error('[Screener v2] Data fetch failed:', e)
    return { hotSectors: [], candidates: [] }
  }

  if (!allPrices.length) {
    console.warn('[Screener v2] No price data, aborting')
    return { hotSectors: [], candidates: [] }
  }

  // ── 處置股排除 ──
  const punishedSet = await loadRestrictedScreenerSymbols(env, endDate)
  // restricted symbols are loaded once through loadRestrictedScreenerSymbols above.
  debugLog.push(`[Guard] restricted symbols loaded=${punishedSet.size} (punished + attention, KV fallback enabled)`)

  // ── 讀取官方產業 mapping + 概念標籤 ──
  const industryMap = await getIndustryMapping(env.DB, env.KV)
  const taxonomyUniverse = [...new Set([
    ...allPrices.map((p) => p.stock_id),
    ...emergingResearchPrices.map((p) => p.stock_id),
  ].map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  const taxonomyProfiles = await loadSymbolTaxonomyProfiles(env.DB, taxonomyUniverse)
  const tagRows = [...taxonomyProfiles.entries()].flatMap(([symbol, profile]) =>
    profile.tags.map((tag) => ({ symbol, tag, weight: 1 })),
  )
  const symbolConceptTags = new Map<string, string[]>()
  const conceptCrowding = new Map<string, number>()
  for (const r of (tagRows ?? [])) {
    if (!symbolConceptTags.has(r.symbol)) symbolConceptTags.set(r.symbol, [])
    symbolConceptTags.get(r.symbol)!.push(r.tag)
    conceptCrowding.set(r.tag, (conceptCrowding.get(r.tag) ?? 0) + 1)
  }
  debugLog.push(`[Taxonomy] FinLab four-layer profiles=${taxonomyProfiles.size}/${taxonomyUniverse.length} tags=${tagRows.length}`)

  // ── 股票名稱 mapping ──
  const sectorMap = await getSectorMapping(env)

  // ── 建資料結構 ──
  const data = buildStockData(allPrices, allChips)
  // 大盤 5d return：用 D1 的 0050（元大台灣50 ETF）作為 benchmark
  // 0050 追蹤加權指數，是最穩定的大盤代理。若沒有就用加權指數近似
  let marketReturn5d = 0
  try {
    const latestDate = await env.DB.prepare(
      'SELECT MAX(date) as d FROM stock_prices WHERE date <= ?',
    ).bind(endDate).first<{ d: string }>()
    const fiveDaysAgoDate = await env.DB.prepare(
      `SELECT date
         FROM (SELECT DISTINCT date FROM stock_prices WHERE date <= ? ORDER BY date DESC LIMIT 6)
        ORDER BY date ASC LIMIT 1`,
    ).bind(endDate).first<{ date: string }>()

    if (latestDate?.d && fiveDaysAgoDate?.date) {
      // 嘗試 0050 ETF
      const row0050 = await env.DB.prepare(`
        SELECT
          (SELECT close FROM stock_prices sp JOIN stocks s ON sp.stock_id=s.id WHERE s.symbol='0050' AND sp.date=?) as latest,
          (SELECT close FROM stock_prices sp JOIN stocks s ON sp.stock_id=s.id WHERE s.symbol='0050' AND sp.date=?) as old
      `).bind(latestDate.d, fiveDaysAgoDate.date).first<{ latest: number; old: number }>()

      if (row0050?.latest && row0050?.old && row0050.old > 0) {
        marketReturn5d = (row0050.latest - row0050.old) / row0050.old
      } else {
        // Fallback: 全市場中位數（確定性，不用 LIMIT）
        const { results: allRets } = await env.DB.prepare(`
          SELECT (sp1.close - sp2.close) / sp2.close as ret
          FROM stock_prices sp1
          JOIN stock_prices sp2 ON sp1.stock_id = sp2.stock_id
          WHERE sp1.date = ? AND sp2.date = ? AND sp2.close > 0
        `).bind(latestDate.d, fiveDaysAgoDate.date).all<{ ret: number }>()

        if (allRets?.length) {
          const sorted = allRets.map(r => r.ret).sort((a, b) => a - b)
          marketReturn5d = sorted[Math.floor(sorted.length / 2)]  // 中位數
        }
      }
    }
  } catch (e) {
    marketReturn5d = calcMarketReturn5d(data)
    console.warn('[Screener v2] D1 marketReturn 查詢失敗，fallback API:', e)
  }

  // ── Step 1: Universe hard filter ──
  const universe: { stockId: string; prices: FMStockPrice[] }[] = []
  let skipPrice = 0, skipVol = 0, skipTurnover = 0, skipPunish = 0, skipVolZero = 0, skipEtf = 0

  for (const [stockId, prices] of data.prices) {
    if (prices.length < 3) continue
    const latest = prices[prices.length - 1]
    const info = sectorMap[stockId]

    // Hard filters
    if (isEtfHardGateSymbol(stockId, info)) {
      skipEtf++
      pushFunnelItem(funnelItems, { symbol: stockId, name: info?.name, stage: 'universe', decision: 'drop', reasonCode: 'etf_excluded', evidence: { market: info?.market ?? null } })
      continue
    }
    if (latest.close < sc.minPrice || latest.close > sc.maxPrice) {
      skipPrice++
      pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'drop', reasonCode: 'price_out_of_range', evidence: { close: latest.close, minPrice: sc.minPrice, maxPrice: sc.maxPrice } })
      continue
    }
    if (latest.Trading_Volume === 0) {
      skipVolZero++
      pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'drop', reasonCode: 'zero_volume', evidence: { volume: latest.Trading_Volume } })
      continue
    }
    if (punishedSet.has(stockId)) {
      skipPunish++
      pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'drop', reasonCode: 'restricted_attention_or_punished', evidence: { restricted: true } })
      continue
    }

    const volSlice = prices.slice(-Math.min(20, prices.length))
    const avgVol20 = volSlice.reduce((s, p) => s + p.Trading_Volume, 0) / volSlice.length
    if (avgVol20 < sc.minAvgVolume) {
      skipVol++
      pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'drop', reasonCode: 'avg_volume_below_min', evidence: { avgVol20, minAvgVolume: sc.minAvgVolume } })
      continue
    }

    const avgDailyTurnover = avgVol20 * latest.close
    if (avgDailyTurnover < sc.minDailyTurnover) {
      skipTurnover++
      pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'drop', reasonCode: 'turnover_below_min', evidence: { avgDailyTurnover, minDailyTurnover: sc.minDailyTurnover } })
      continue
    }

    universe.push({ stockId, prices })
    pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'pass', reasonCode: 'hard_filters_passed', evidence: { close: latest.close, avgVol20, avgDailyTurnover } })
  }
  const universeMsg = `[Step 1] Universe: ${universe.length} passed | drops: price=${skipPrice} avgVol=${skipVol} turnover=${skipTurnover} restricted=${skipPunish} zeroVol=${skipVolZero} etf=${skipEtf} other=${data.prices.size - universe.length - skipPrice - skipVol - skipTurnover - skipPunish - skipVolZero - skipEtf}`
  debugLog.push(universeMsg)
  if (skipEtf > 0) debugLog.push(`[Step 1] hard gate excluded ETFs=${skipEtf}`)

  // ── Step 2: 多因子評分 ──
  const rawFundamentalSignals = await loadStrategyRawFundamentalSignals(
    env,
    universe.map((row) => row.stockId),
    endDate,
  )
  debugLog.push(
    `[Step 1b] raw strategy signals: fundamentals=${rawFundamentalSignals.size}/${universe.length} ` +
    `sources=canonical_fundamental_features+canonical_revenue_monthly+legacy_fallback`,
  )

  type ScoredCandidate = ScreenerCandidate & {
    chip_score: number
    tech_score: number
    momentum_score: number
    score_components?: string
    raw_signals?: StrategyRawSignals
    industry: string
    market_segment: string
    taxonomy?: SymbolTaxonomyProfile
  }
  const scored: ScoredCandidate[] = []

  for (const { stockId, prices } of universe) {
    const latest = prices[prices.length - 1]
    const chipDates = data.chips.get(stockId)
    const { base_score, chip_score, tech_score, momentum_score, score_components, reasons } = scoreMultiFactor(
      prices, chipDates, marketReturn5d, latest.close, cfg
    )

    const info = sectorMap[stockId]
    const taxonomy = taxonomyProfiles.get(stockId)
    const industry = taxonomyDisplay(taxonomy, industryMap.get(stockId) ?? '其他')

    const raw_signals = deriveStrategyRawSignals(prices, chipDates, rawFundamentalSignals.get(stockId))

    scored.push({
      symbol: stockId,
      name: info?.name ?? stockId,
      sector: industry,
      score: base_score,
      reason: reasons.slice(0, 3).join('；') || '符合篩選條件',
      chip_score, tech_score, momentum_score,
      score_components,
      raw_signals,
      industry,
      market_segment: 'listed_otc',
      taxonomy,
    })
    pushFunnelItem(funnelItems, {
      symbol: stockId,
      name: info?.name ?? stockId,
      stage: 'scoring',
      decision: 'pass',
      reasonCode: 'base_score_computed',
      scoreAfter: base_score,
      evidence: { chip_score, tech_score, momentum_score, score_components, reasons, taxonomy, raw_signals },
    })
  }

  applyScreenerScoreCalibration(scored, screenerPolicy.scoreCalibration)
  debugLog.push(
    `[Step 2b] score calibration ${screenerPolicy.scoreCalibration.enabled ? screenerPolicy.scoreCalibration.method : 'disabled'} ` +
    `pool=${screenerPolicy.sizing.candidatePoolSize} coarse=${screenerPolicy.sizing.coarseMlQueueSize} ` +
    `shortlist=${screenerPolicy.sizing.mlShortlistSize} ` +
    `emerging=${screenerPolicy.sizing.emergingResearchSize}`,
  )

  // Step 2 debug: top 30 scored
  debugLog.push(`[Step 2] 多因子評分完成: ${scored.length} 檔 | 大盤 5d return=${(marketReturn5d * 100).toFixed(2)}%`)
  const scoredSorted = [...scored].sort((a, b) => b.score - a.score)
  const featureEnrichedUniverse = dedupeScreenerCandidatesBySymbol(scored)
  debugLog.push(`[Step 2] Top 15 (base_score):`)
  for (const c of scoredSorted.slice(0, 15)) {
    debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} | base=${c.score.toFixed(1)} chip=${c.chip_score} tech=${c.tech_score} mom=${c.momentum_score.toFixed(1)} | ${c.reason}`)
  }

  // Score 分布
  const ranges = [
    { label: '60+', min: 60 }, { label: '50-60', min: 50 }, { label: '40-50', min: 40 },
    { label: '30-40', min: 30 }, { label: '20-30', min: 20 }, { label: '<20', min: 0 },
  ]
  debugLog.push(`[Step 2] 分數分布: ${ranges.map(r => `${r.label}=${scored.filter(c => c.score >= r.min && (r.min === 0 || c.score < r.min + 10)).length}`).join(' ')}`)

  const coarseQueueSize = screenerPolicy.sizing.coarseMlQueueSize
  const maxCandidates = screenerPolicy.sizing.mlShortlistSize
  let strategySelectionTelemetry: Record<string, unknown> | null = null
  let strategySelectionPlan: any | null = null
  const strategySourceUniverse = featureEnrichedUniverse
  let layer1BreadthPool: ScoredCandidate[] = []
  let layer2CoarseQueueSeed: ScoredCandidate[] = []
  let overlayEligibleSymbols = new Set<string>()
  try {
    const [{ listStrategySpecsForLearning, getLatestStrategyPolicyState }, { buildLayer1StrategyBreadthPlan }] = await Promise.all([
      import('./strategyLearning'),
      import('./strategyCandidatePool'),
    ])
    const [{ specs, source }, policyState] = await Promise.all([
      listStrategySpecsForLearning(env.DB),
      getLatestStrategyPolicyState(env.DB).catch(() => null),
    ])
    const layer1BreadthPlan = buildLayer1StrategyBreadthPlan(
      strategySourceUniverse as any,
      specs,
      {
        targetSize: screenerPolicy.sizing.candidatePoolSize,
        coarseMlQueueSize: coarseQueueSize,
        regime: (adaptiveParams as any)?.provenance?.regime ?? null,
        strategyWeights: policyState?.strategy_weights ?? undefined,
      },
    )
    strategySelectionPlan = layer1BreadthPlan.selection
    layer1BreadthPool = layer1BreadthPlan.breadthPool as ScoredCandidate[]
    layer2CoarseQueueSeed = layer1BreadthPlan.coarseQueue as ScoredCandidate[]
    overlayEligibleSymbols = new Set(layer1BreadthPool.map((candidate) => String(candidate.symbol || '').trim()).filter(Boolean))
    strategySelectionTelemetry = {
      version: layer1BreadthPlan.version,
      candidate_pool_version: strategySelectionPlan.version,
      spec_source: source,
      capacity: strategySelectionPlan.capacity,
      telemetry: strategySelectionPlan.telemetry,
      layer1_telemetry: layer1BreadthPlan.telemetry,
      source_universe_count: strategySourceUniverse.length,
      layer1_breadth_count: layer1BreadthPool.length,
      layer2_coarse_queue_seed_count: layer2CoarseQueueSeed.length,
      selection_order: layer1BreadthPlan.telemetry.selection_order,
      pool_status: strategySelectionPlan.pools.map((pool: any) => ({
        strategy_id: pool.strategy_id,
        status: pool.status,
        quota: pool.quota,
        candidates: pool.candidates.length,
        regime_scope: pool.regime_scope,
        missing_evidence: pool.missing_evidence,
      })),
    }
    debugLog.push(
      `[Step 2c] layer1_breadth=${layer1BreadthPlan.version} source=${source} ` +
      `source_universe=${strategySourceUniverse.length} layer1=${layer1BreadthPool.length}/${screenerPolicy.sizing.candidatePoolSize} ` +
      `coarse_seed=${layer2CoarseQueueSeed.length}/${coarseQueueSize} core_ml=${maxCandidates} ` +
      `research_only=${strategySelectionPlan.researchOnlyQueue.length} overflow=${strategySelectionPlan.telemetry.overflow_count} ` +
      `cap=${strategySelectionPlan.capacity.mlQueueCap}/${strategySelectionPlan.capacity.totalCap} mode=${strategySelectionPlan.capacity.mode}`,
    )
    layer1BreadthPool.forEach((candidate, index) => {
      pushFunnelItem(funnelItems, {
        symbol: candidate.symbol,
        name: candidate.name,
        stage: 'layer1_strategy_breadth_gate',
        decision: 'pass',
        reasonCode: String((candidate as any).strategy_pool_reason ?? 'strategy_breadth_seed'),
        scoreAfter: candidate.score,
        rank: index + 1,
        evidence: {
          strategy_ids: (candidate as any).strategy_pool_ids ?? [],
          strategy_pool_score: (candidate as any).strategy_pool_score ?? null,
          target_size: screenerPolicy.sizing.candidatePoolSize,
          coarse_ml_queue_size: screenerPolicy.sizing.coarseMlQueueSize,
          core_ml_shortlist_size: screenerPolicy.sizing.mlShortlistSize,
          chip_score: candidate.chip_score,
          tech_score: candidate.tech_score,
          momentum_score: candidate.momentum_score,
          raw_signals: candidate.raw_signals ?? null,
          market_segment: candidate.market_segment ?? null,
          source_universe: 'full_feature_enriched_universe',
          source_universe_count: strategySourceUniverse.length,
          selection_order: layer1BreadthPlan.telemetry.selection_order,
          layer_contract: 'L1 keeps breadth; RRG/news/PTT/heavy ML are not selection owners here',
        },
      })
    })
    layer2CoarseQueueSeed.forEach((candidate, index) => {
      pushFunnelItem(funnelItems, {
        symbol: candidate.symbol,
        name: candidate.name,
        stage: 'layer2_coarse_ml_gate',
        decision: 'pass',
        reasonCode: 'coarse_ml_queue_seed_from_layer1_breadth',
        scoreAfter: candidate.score,
        rank: index + 1,
        evidence: {
          strategy_ids: (candidate as any).strategy_pool_ids ?? [],
          strategy_pool_reason: (candidate as any).strategy_pool_reason ?? null,
          raw_signals: candidate.raw_signals ?? null,
          layer1_rank: (candidate as any).strategy_pool_rank ?? index + 1,
          coarse_ml_queue_size: screenerPolicy.sizing.coarseMlQueueSize,
          core_ml_shortlist_size: screenerPolicy.sizing.mlShortlistSize,
        },
      })
    })
    const mlQueueAuditLimit = Math.min(D1_IN_CHUNK_SIZE * 2, strategySelectionPlan.mlQueue.length)
    for (const entry of strategySelectionPlan.mlQueue.slice(0, mlQueueAuditLimit)) {
      pushFunnelItem(funnelItems, {
        symbol: String(entry.symbol || ''),
        name: entry.name,
        stage: 'strategy_pool_ml_queue',
        decision: 'pass',
        reasonCode: String(entry.strategy_pool_reason ?? 'selected_by_strategy_pool'),
        scoreAfter: Number(entry.strategy_pool_score ?? entry.score ?? 0),
        rank: entry.strategy_pool_rank ?? null,
        evidence: {
          strategy_ids: entry.strategy_pool_ids ?? [],
          strategy_pool_score: entry.strategy_pool_score ?? null,
          strategy_pool_decision: entry.strategy_pool_decision ?? null,
          source_universe: 'post_safety_hard_filter_pre_rrg',
          source_universe_count: strategySourceUniverse.length,
          market_segment: entry.market_segment ?? null,
        },
      })
    }
    const researchOnlyAuditLimit = Math.min(D1_IN_CHUNK_SIZE * 2, strategySelectionPlan.researchOnlyQueue.length)
    for (const entry of strategySelectionPlan.researchOnlyQueue.slice(0, researchOnlyAuditLimit)) {
      pushFunnelItem(funnelItems, {
        symbol: String(entry.symbol || ''),
        name: entry.name,
        stage: 'strategy_pool_research_only',
        decision: 'observe',
        reasonCode: String(entry.strategy_pool_reason ?? 'research_only_queue'),
        scoreAfter: Number(entry.strategy_pool_score ?? entry.score ?? 0),
        rank: entry.strategy_pool_rank ?? null,
        evidence: {
          strategy_ids: entry.strategy_pool_ids ?? [],
          strategy_pool_score: entry.strategy_pool_score ?? null,
          market_segment: entry.market_segment ?? null,
          source_universe: 'post_safety_hard_filter_pre_rrg',
        },
      })
    }
  } catch (e) {
    const rawSignalSorted = [...strategySourceUniverse].sort((a, b) => rawSignalEmergencyFallbackScore(b) - rawSignalEmergencyFallbackScore(a))
    layer1BreadthPool = rawSignalSorted.slice(0, screenerPolicy.sizing.candidatePoolSize)
    layer2CoarseQueueSeed = layer1BreadthPool.slice(0, coarseQueueSize)
    overlayEligibleSymbols = new Set(layer1BreadthPool.map((candidate) => String(candidate.symbol || '').trim()).filter(Boolean))
    strategySelectionTelemetry = {
      version: 'layer1-breadth-fallback',
      selection_order: 'emergency_raw_signal_fallback_after_layer1_strategy_pool_error',
      source_universe_count: strategySourceUniverse.length,
      layer1_breadth_count: layer1BreadthPool.length,
      layer2_coarse_queue_seed_count: layer2CoarseQueueSeed.length,
      error: String(e),
    }
    debugLog.push(`[Step 2c] layer1 breadth unavailable before overlays; emergency raw-signal fallback used: ${String(e)}`)
  }

  // ── Step 3: RRG 象限加權 ── (2026-04-09 rewired)
  // RRG bonus config is consumed below from trading config / Optuna pushes.
  // 但沒 consumer。這裡接上：讀 ml-controller 寫的 sector_flow (classification='theme'
  // + 最新 date + 非空 quadrant)，把每檔候選股的 top concept tag 對應到 quadrant，
  // 然後用 cfg.rrg.{leadingBonus, improvingBonus, weakeningBonus, laggingPenalty}
  // 調整 score。以 Score V2 partial total 作 seed score，後續 overlay 調整後存回 c.score。
  // RRG quadrant axes (RS=100, Mom=0) are canonical de Kempenaer coordinates,
  // so they stay fixed rather than becoming Optuna-tunable policy knobs.
  const sectorHeatScores: SectorHeatScore[] = []
  let rrgAdjustedCount = 0
  const rrgCfg = cfg.rrg
  if (rrgCfg && scored.length > 0) {
    try {
      // (a) 每檔候選股的 top (highest weight) concept tag
      const topTagRows = await queryTopConceptTagsForSymbols(env.DB, [...overlayEligibleSymbols])
      const symbolTags = new Map<string, Array<{ tag: string; classification: string }>>()
      for (const r of topTagRows ?? []) {
        const tags = symbolTags.get(r.symbol) ?? []
        tags.push({ tag: r.tag, classification: rrgClassificationForTagType(r.tag_type) })
        symbolTags.set(r.symbol, tags)
      }
      // (b) 最新 sector_flow 的四層 taxonomy quadrant
      const { results: qRows } = await env.DB.prepare(
        `SELECT sector, classification, quadrant, rs_ratio, rs_momentum, turnover_share_delta FROM sector_flow
         WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
           AND quadrant IS NOT NULL
           AND date = (SELECT MAX(date) FROM sector_flow
                       WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
                         AND quadrant IS NOT NULL)`
      ).all<{ sector: string; classification: string; quadrant: string; rs_ratio: number | null; rs_momentum: number | null; turnover_share_delta: number | null }>()
      const themeQuadrant = new Map<string, { quadrant: string; rsRatio: number; rsMomentum: number; turnoverShareDelta: number }>()
      for (const r of qRows ?? []) {
        const classification = String(r.classification || '').trim()
        const sector = String(r.sector || '').trim()
        if (!classification || !sector) continue
        themeQuadrant.set(`${classification}:${sector}`, {
          quadrant: r.quadrant,
          rsRatio: Number(r.rs_ratio ?? 100),
          rsMomentum: Number(r.rs_momentum ?? 0),
          turnoverShareDelta: Number(r.turnover_share_delta ?? 0),
        })
      }
      const latestThemeUniverse = new Set(themeQuadrant.keys())

      // Apply bonus to each scored candidate
      for (const c of scored) {
        if (!overlayEligibleSymbols.has(c.symbol)) continue
        const tags = symbolTags.get(c.symbol) ?? []
        const matched = tags.find((candidateTag) => latestThemeUniverse.has(`${candidateTag.classification}:${candidateTag.tag}`)) ?? tags[0]
        if (!matched) continue
        const taxonomyKey = `${matched.classification}:${matched.tag}`
        const overlay = themeQuadrant.get(taxonomyKey)
        if (!overlay) {
          pushFunnelItem(funnelItems, {
            symbol: c.symbol,
            name: c.name,
            stage: 'rrg_overlay',
            decision: 'observe',
            reasonCode: 'rrg_overlay_unmapped_neutral',
            scoreBefore: c.score,
            scoreAfter: c.score,
            evidence: { tag: matched.tag, classification: matched.classification, taxonomyKey, latestThemeUniverseSize: latestThemeUniverse.size },
          })
          continue
        }
        const { quadrant: q, rsRatio, rsMomentum, turnoverShareDelta } = overlay
        let adjustment = 0
        let reasonCode = 'rrg_overlay_neutral'
        if (q === 'Leading' && rsRatio >= 100 && rsMomentum >= 0) {
          adjustment = Math.min(4, Math.max(0, Number(rrgCfg.leadingBonus ?? 0)))
          reasonCode = 'rrg_overlay_leading_confirmed'
        } else if (q === 'Improving' && rsMomentum > 0) {
          adjustment = Math.min(3, Math.max(0, Number(rrgCfg.improvingBonus ?? 0)))
          reasonCode = 'rrg_overlay_improving_tailwind'
        } else if (q === 'Weakening' && rsMomentum < 0) {
          adjustment = Math.min(0, Number(rrgCfg.weakeningBonus ?? -2) || -2)
          reasonCode = 'rrg_overlay_weakening_risk'
        } else if (q === 'Lagging') {
          adjustment = Math.max(-6, Math.min(-2, Number(rrgCfg.laggingPenalty ?? -4)))
          reasonCode = 'rrg_overlay_lagging_risk'
        }
        let turnoverShareAdjustment = 0
        if ((q === 'Leading' || q === 'Improving') && turnoverShareDelta >= 0.002) {
          turnoverShareAdjustment = 1
          reasonCode = 'rrg_overlay_turnover_share_tailwind'
        } else if ((q === 'Weakening' || q === 'Lagging') && turnoverShareDelta <= -0.003) {
          turnoverShareAdjustment = -1
          reasonCode = 'rrg_overlay_turnover_share_outflow_risk'
        }
        adjustment += turnoverShareAdjustment
        if (adjustment !== 0) {
          const before = c.score
          c.score += adjustment
          const sign = adjustment > 0 ? '+' : ''
          c.reason = `[rrg_overlay ${q} ${sign}${adjustment}] ${c.reason}`
          rrgAdjustedCount++
          pushFunnelItem(funnelItems, {
            symbol: c.symbol,
            name: c.name,
            stage: 'rrg_overlay',
            decision: 'observe',
            reasonCode,
            scoreBefore: before,
            scoreAfter: c.score,
            evidence: {
              tag: matched.tag,
              classification: matched.classification,
              taxonomyKey,
              quadrant: q,
              rsRatio,
              rsMomentum,
              turnoverShareDelta,
              turnoverShareAdjustment,
              adjustment,
            },
          })
        }
      }
      debugLog.push(
        `[Step 3] RRG overlay applied to ${rrgAdjustedCount}/${scored.length} ` +
        `(taxonomy sectors loaded: ${themeQuadrant.size}, ` +
        `bonuses: L=${rrgCfg.leadingBonus} I=${rrgCfg.improvingBonus} W=${rrgCfg.weakeningBonus} La=${rrgCfg.laggingPenalty})`
      )
    } catch (e) {
      console.warn('[Screener v2] RRG quadrant bonus failed (non-fatal):', e)
      debugLog.push(`[Step 3] RRG quadrant bonus skipped (error): ${e}`)
    }
  } else {
    debugLog.push('[Step 3] RRG quadrant bonus skipped (cfg.rrg missing or empty scored)')
  }

  // ── Step 4: 情緒面加分 ──
  // 4a. 新聞情緒（D1 查詢）
  try {
    // 批次查所有候選的近 7 天新聞情緒
    const topSymbols = [...overlayEligibleSymbols]
    if (topSymbols.length > 0) {
      // 查 stocks 表拿 stock_id
      const newsAgg: { symbol: string; sentiment: string; cnt: number }[] = []
      for (const chunk of chunkArray(topSymbols, 400)) {
        const ph = chunk.map(() => '?').join(',')
        const { results } = await env.DB.prepare(`
          SELECT s.symbol, n.sentiment, COUNT(*) as cnt
          FROM news n
          JOIN stocks s ON n.stock_id = s.id
          WHERE s.symbol IN (${ph}) AND n.published_at >= date('now', '-7 days')
          GROUP BY s.symbol, n.sentiment
        `).bind(...chunk).all<{ symbol: string; sentiment: string; cnt: number }>()
        newsAgg.push(...(results ?? []))
      }

      const sentimentMap = new Map<string, { pos: number; neg: number; total: number }>()
      for (const r of (newsAgg ?? [])) {
        if (!sentimentMap.has(r.symbol)) sentimentMap.set(r.symbol, { pos: 0, neg: 0, total: 0 })
        const s = sentimentMap.get(r.symbol)!
        s.total += r.cnt
        if (r.sentiment === 'positive') s.pos += r.cnt
        if (r.sentiment === 'negative') s.neg += r.cnt
      }

      for (const c of scored) {
        if (!overlayEligibleSymbols.has(c.symbol)) continue
        const s = sentimentMap.get(c.symbol)
        if (!s || s.total === 0) continue
        const posRatio = s.pos / s.total
        const negRatio = s.neg / s.total
        if (posRatio > 0.6) applyScoreV2NewsThemeAdjustment(c, 5, 'positive_news_sentiment')
        else if (posRatio > 0.4) applyScoreV2NewsThemeAdjustment(c, 3, 'positive_news_sentiment')
        else if (negRatio > 0.4) applyScoreV2NewsThemeAdjustment(c, -3, 'negative_news_sentiment', ['negative_news_sentiment'])
      }
    }
  } catch (e) {
    console.warn('[Screener v2] News sentiment failed:', e)
  }

  // 4b. PTT buzz → 概念 → 個股加分
  const hotConcepts = new Set(combinedBuzz.slice(0, 10).map(b => b.concept))
  for (const c of scored) {
    if (!overlayEligibleSymbols.has(c.symbol)) continue
    const tags = symbolConceptTags.get(c.symbol) ?? []
    const matchedHot = tags.filter(t => hotConcepts.has(t))
    if (matchedHot.length > 0) {
      const bestTag = matchedHot
        .map(tag => ({ tag, score: conceptBuzzScore.get(tag) ?? 0, crowding: conceptCrowding.get(tag) ?? 1 }))
        .sort((a, b) => b.score - a.score)[0]
      const sourceStrength = Math.max(0, bestTag?.score ?? 0)
      const crowdingPenalty = Math.min(2, Math.log10(Math.max(1, bestTag?.crowding ?? 1)))
      const buzzBonus = Math.max(0, Math.min(4, sourceStrength * 1.5 + matchedHot.length - crowdingPenalty))
      const before = c.score
      const appliedBuzzBonus = applyScoreV2NewsThemeAdjustment(c, buzzBonus, `buzz_evidence:${bestTag.tag}`)
      if (appliedBuzzBonus <= 0) continue
      c.reason += ` | buzz_evidence:${bestTag.tag}+${appliedBuzzBonus.toFixed(1)}`
      pushFunnelItem(funnelItems, {
        symbol: c.symbol,
        name: c.name,
        stage: 'buzz_evidence',
        decision: 'observe',
        reasonCode: 'weighted_keyword_evidence',
        scoreBefore: before,
        scoreAfter: c.score,
        evidence: {
          concept: bestTag.tag,
          matchedHot,
          sourceStrength,
          sourceBreakdown: conceptEvidenceBreakdown.get(bestTag.tag) ?? {},
          crowding: bestTag.crowding,
          crowdingPenalty,
          buzzBonus,
          appliedBuzzBonus,
        },
      })
    }
  }

  // ── Step 5: 排序 + 去重 + 截斷 ──
  try {
    const evidenceRisk = await loadExternalEvidenceRiskOverlays(env.DB, endDate, [...overlayEligibleSymbols])
    let vetoed = 0
    let penalized = 0
    for (let i = scored.length - 1; i >= 0; i--) {
      const c = scored[i]
      if (!overlayEligibleSymbols.has(c.symbol)) continue
      const overlay = evidenceRisk.get(c.symbol)
      if (!overlay) continue
      if (overlay.action === 'veto') {
        vetoed++
        pushFunnelItem(funnelItems, {
          symbol: c.symbol,
          name: c.name,
          stage: 'external_evidence_risk',
          decision: 'drop',
          reasonCode: overlay.flags[0] ?? 'major_negative_event',
          scoreBefore: c.score,
          scoreAfter: null,
          evidence: { ...overlay },
        })
        scored.splice(i, 1)
        continue
      }
      const before = c.score
      const appliedPenalty = applyScoreV2NewsThemeAdjustment(c, overlay.penalty, overlay.flags[0] ?? 'external_evidence_risk', overlay.flags)
      if (appliedPenalty < 0) {
        penalized++
        c.reason += ` | risk_overlay:${overlay.flags[0] ?? 'external_evidence'}`
        pushFunnelItem(funnelItems, {
          symbol: c.symbol,
          name: c.name,
          stage: 'external_evidence_risk',
          decision: 'observe',
          reasonCode: overlay.flags[0] ?? 'external_evidence_risk',
          scoreBefore: before,
          scoreAfter: c.score,
          evidence: { ...overlay },
        })
      }
    }
    if (vetoed || penalized) debugLog.push(`[Step 4c] external evidence risk overlay veto=${vetoed} penalized=${penalized}`)
  } catch (e) {
    console.warn('[Screener v2] external evidence risk overlay failed:', e)
  }

  // Step 4 debug
  debugLog.push(`[Step 4] 情緒面加分完成 | PTT hot concepts: ${[...hotConcepts].join(', ')}`)
  debugLog.push(`[Step 4] Theme evidence now includes PTT/news/Anue plus runtime theme_signals when available`)
  const afterSentiment = [...scored].sort((a, b) => b.score - a.score)
  debugLog.push(`[Step 4] Top 10 (with sentiment):`)
  for (const c of afterSentiment.slice(0, 10)) {
    debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} | total=${c.score.toFixed(1)} | ${c.reason}`)
  }

  scored.sort((a, b) => b.score - a.score)

  // ── Step 4b: 基本面加分（F-Score + 毛利率事件）──
  try {
    const topSymbols4b = [...overlayEligibleSymbols]
    if (topSymbols4b.length > 0) {
      const ph = topSymbols4b.map(() => '?').join(',')

      // P2-4: 簡化版 F-Score（用 D1 financials 可用欄位）
      // 完整 F-Score 9 項，我們有: ROE(→ROA proxy), EPS, revenue_growth_yoy
      const { results: finRows } = await env.DB.prepare(`
        SELECT s.symbol, f.roe, f.eps, f.revenue_growth_yoy
        FROM financials f
        JOIN stocks s ON f.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND f.period_type = 'quarterly'
        AND f.period = (SELECT MAX(f2.period) FROM financials f2 WHERE f2.stock_id = f.stock_id AND f2.period_type = 'quarterly')
      `).bind(...topSymbols4b).all<{ symbol: string; roe: number | null; eps: number | null; revenue_growth_yoy: number | null }>()

      // 前一季
      const { results: prevFinRows } = await env.DB.prepare(`
        SELECT s.symbol, f.roe, f.eps
        FROM financials f
        JOIN stocks s ON f.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND f.period_type = 'quarterly'
        AND f.period = (SELECT MAX(f2.period) FROM financials f2 WHERE f2.stock_id = f.stock_id AND f2.period_type = 'quarterly' AND f2.period < (SELECT MAX(f3.period) FROM financials f3 WHERE f3.stock_id = f.stock_id AND f3.period_type = 'quarterly'))
      `).bind(...topSymbols4b).all<{ symbol: string; roe: number | null; eps: number | null }>()

      const prevFinMap = new Map<string, { roe: number | null; eps: number | null }>()
      for (const r of (prevFinRows ?? [])) prevFinMap.set(r.symbol, r)

      let fscoreApplied = 0
      for (const r of (finRows ?? [])) {
        let fScore = 0
        // 獲利性
        if (r.roe && r.roe > 0) fScore++                     // ROA proxy: ROE > 0
        if (r.eps && r.eps > 0) fScore++                     // EPS > 0
        // 成長性
        if (r.revenue_growth_yoy && r.revenue_growth_yoy > 0) fScore++  // 營收 YoY 成長
        const prev = prevFinMap.get(r.symbol)
        if (prev?.roe && r.roe && r.roe > prev.roe) fScore++ // ROE 改善
        if (prev?.eps && r.eps && r.eps > prev.eps) fScore++ // EPS 改善

        // F-Score >= 4 加分（滿分 5，對應完整 F-Score 的 8/9）
        const c = scored.find(s => s.symbol === r.symbol)
        if (c && fScore >= 4) {
          c.score += 5
          fscoreApplied++
        } else if (c && fScore >= 3) {
          c.score += 2
        } else if (c && fScore <= 1) {
          c.score -= 3  // 財務惡化扣分
        }
      }

      // P3-12: 毛利率創新高事件（簡化版 — 用 revenue_growth_yoy proxy）
      // 真正的毛利率需要 gross_margin 欄位，暫用營收 YoY > 20% 替代
      for (const r of (finRows ?? [])) {
        if (r.revenue_growth_yoy && r.revenue_growth_yoy > 20) {
          const c = scored.find(s => s.symbol === r.symbol)
          if (c) { c.score += 3; c.reason += '；營收高成長' }
        }
      }

      debugLog.push(`[Step 4b] F-Score 加分: ${fscoreApplied} 檔 (>=4分)`)
    }
  } catch (e) {
    console.warn('[Screener v2] F-Score/毛利率加分失敗:', e)
  }

  // ── P2-10: 外資淨買超天數佔比（大盤層級 risk overlay）──
  // P3-11: ATR V 轉指標
  try {
    let foreignSource = 'canonical_chip_daily'
    let foreignRows: Array<{ date: string; total_foreign_net: number }> = []
    try {
      const canonical = await env.DB.prepare(`
        SELECT date, SUM(foreign_net) as total_foreign_net
        FROM canonical_chip_daily
        WHERE date >= date('now', '-40 days')
        GROUP BY date ORDER BY date
      `).all<{ date: string; total_foreign_net: number }>()
      foreignRows = canonical.results ?? []
    } catch {
      foreignRows = []
    }

    if (foreignRows.length < 10) {
      const legacy = await env.DB.prepare(`
        SELECT date, SUM(foreign_net) as total_foreign_net
        FROM chip_data
        WHERE date >= date('now', '-40 days')
        GROUP BY date ORDER BY date
      `).all<{ date: string; total_foreign_net: number }>()
      foreignRows = legacy.results ?? []
      foreignSource = 'legacy.chip_data'
    }

    if (foreignRows && foreignRows.length >= 10) {
      const buyDays = foreignRows.filter(r => r.total_foreign_net > 0).length
      const foreignBuyRatio = buyDays / foreignRows.length
      // < 0.4 = 外資持續賣超 → 全體候選扣分
      if (foreignBuyRatio < 0.35) {
        for (const c of scored) c.score -= 3
        debugLog.push(`[Step 4b] 外資避險: 買超天數佔比 ${(foreignBuyRatio * 100).toFixed(0)}% < 35% → 全體 -3 source=${foreignSource}`)
      } else if (foreignBuyRatio > 0.65) {
        debugLog.push(`[Step 4b] 外資偏多: 買超天數佔比 ${(foreignBuyRatio * 100).toFixed(0)}% source=${foreignSource}`)
      } else {
        debugLog.push(`[Step 4b] 外資中性: 買超天數佔比 ${(foreignBuyRatio * 100).toFixed(0)}% source=${foreignSource}`)
      }
    }
  } catch (e) {
    console.warn('[Screener v2] 外資天數佔比失敗:', e)
  }

  // ── Step 4c: 趨勢品質 + ADX + 流動性分級（D1 60 天歷史）──
  try {
    const policyPoolSymbols = [...overlayEligibleSymbols]
    if (policyPoolSymbols.length > 0) {
      const ph = policyPoolSymbols.map(() => '?').join(',')
      // 查 60 天 OHLCV（ADX 需要 high/low）
      const { results: histRows } = await env.DB.prepare(`
        SELECT s.symbol, sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume
        FROM stock_prices sp JOIN stocks s ON sp.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-90 days')
        ORDER BY s.symbol, sp.date
      `).bind(...policyPoolSymbols).all<{ symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }>()

      // 按 symbol 分組
      const histBySymbol = new Map<string, { close: number; high: number; low: number; volume: number }[]>()
      for (const r of (histRows ?? [])) {
        if (!histBySymbol.has(r.symbol)) histBySymbol.set(r.symbol, [])
        histBySymbol.get(r.symbol)!.push({ close: r.close, high: r.high ?? r.close, low: r.low ?? r.close, volume: r.volume ?? 0 })
      }

      // ── G1: 全 universe 的 intent 百分位排名（adaptive 門檻）──
      const intentMap = new Map<string, number>()
      for (const [sym, bars] of histBySymbol) {
        if (bars.length < 20) continue
        const latest = bars[bars.length - 1].close
        const first = bars[0].close
        let sumAbsRet = 0
        for (let i = 1; i < bars.length; i++) {
          if (bars[i - 1].close > 0) sumAbsRet += Math.abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close)
        }
        const netReturn = first > 0 ? (latest - first) / first : 0
        intentMap.set(sym, sumAbsRet > 0 ? netReturn / sumAbsRet : 0)
      }
      // 計算百分位門檻
      const intentValues = [...intentMap.values()].sort((a, b) => a - b)
      const p10 = intentValues[Math.floor(intentValues.length * 0.10)] ?? -0.3
      const p20 = intentValues[Math.floor(intentValues.length * 0.20)] ?? -0.1

      let trendPenalty = 0, intentPenalty = 0, adxPenalty = 0, liqPenalty = 0

      for (const c of scored) {
        const bars = histBySymbol.get(c.symbol)
        if (!bars || bars.length < 20) continue

        const latest = bars[bars.length - 1].close
        const first = bars[0].close
        const high60 = Math.max(...bars.map(b => b.close))

        // ① 距離 60 日高點回落
        const fromHigh = (latest - high60) / high60
        if (fromHigh < -0.15) {
          c.score -= 8
          c.reason += `；距高點${(fromHigh * 100).toFixed(0)}%`
          trendPenalty++
        } else if (fromHigh < -0.10) {
          c.score -= 5
          trendPenalty++
        }

        // ② G1: Intent adaptive 百分位扣分
        const intent = intentMap.get(c.symbol) ?? 0
        if (intent < p10 && intent < 0) {
          c.score -= 8  // 最差 10%（淨跌+高震盪）
          intentPenalty++
        } else if (intent < p20 && intent < 0) {
          c.score -= 5  // 最差 20%
          intentPenalty++
        } else if (intent > 0.4) {
          c.score += 3  // 優質直線上漲
        }

        // ③ G2+ADX: 共用完整 ADX 14 計算，避免用最新 DX 近似 ADX。
        if (bars.length >= 28) {
          const technicals = computeTechnicalIndicators(
            bars.map(b => b.close),
            bars.map(b => b.high),
            bars.map(b => b.low),
            bars.map(b => b.volume),
          )
          const adx = technicals.adx14

          if (adx != null && adx < 15 && (c as any).chip_score >= 20) {
            c.score -= 5
            c.reason += `；ADX${adx.toFixed(0)}無趨勢`
            adxPenalty++
          } else if (adx != null && adx > 30) {
            if (intent > 0.1) c.score += 2
          }
        }

        // ④ G4: 流動性分級（不提高硬門檻，用分數機制）
        const avgTurnover = bars.reduce((s, b) => s + b.close * b.volume, 0) / bars.length
        if (avgTurnover < 10_000_000) {        // < 1000 萬
          c.score -= 5
          liqPenalty++
        } else if (avgTurnover < 30_000_000) { // 1000~3000 萬
          c.score -= 2
          liqPenalty++
        } else if (avgTurnover > 100_000_000) { // > 1 億
          c.score += 2  // 高流動性優勢
        }
      }

      debugLog.push(`[Step 4c] 趨勢品質: 距高點=${trendPenalty} intent=${intentPenalty} ADX無趨勢=${adxPenalty} 低流動性=${liqPenalty}`)
      debugLog.push(`[Step 4c] Intent adaptive: p10=${p10.toFixed(3)} p20=${p20.toFixed(3)}`)
    }
  } catch (e) {
    console.warn('[Screener v2] 趨勢品質 filter 失敗:', e)
  }

  // 5a+5b: 同產業上限
  let selectionFlagMap = new Map<string, ScreenerSelectionFlag>()
  try {
    const policyPoolSymbols = [...overlayEligibleSymbols]
    selectionFlagMap = await loadSelectionHistoryFlags(env.DB, policyPoolSymbols, endDate, {
      highFreqThreshold: (sc as any).highFreq20dThreshold ?? 12,
    })
    const highFreqPenalty = Number((sc as any).highFreqPenalty ?? 6)
    const newMoneyBonus = Number((sc as any).newMoneyBonus ?? 2)
    let highFreqAdjusted = 0
    let newMoneyAdjusted = 0
    for (const c of scored) {
      const flag = selectionFlagMap.get(c.symbol)
      if (!flag) continue
      if (flag.highFreq && highFreqPenalty > 0) {
        const before = c.score
        c.score -= highFreqPenalty
        c.reason += ` | high_freq_penalty -${highFreqPenalty}`
        highFreqAdjusted++
        pushFunnelItem(funnelItems, {
          symbol: c.symbol,
          name: c.name,
          stage: 'diversity_cooldown',
          decision: 'observe',
          reasonCode: 'high_frequency_cooldown',
          scoreBefore: before,
          scoreAfter: c.score,
          evidence: { freq20d: flag.freq20d, highFreqPenalty },
        })
      }
      if (flag.newMoney && newMoneyBonus > 0) {
        const before = c.score
        c.score += newMoneyBonus
        c.reason += ` | new_money +${newMoneyBonus}`
        newMoneyAdjusted++
        pushFunnelItem(funnelItems, {
          symbol: c.symbol,
          name: c.name,
          stage: 'diversity_cooldown',
          decision: 'observe',
          reasonCode: 'new_money_boost',
          scoreBefore: before,
          scoreAfter: c.score,
          evidence: { freq20d: flag.freq20d, newMoneyBonus },
        })
      }
    }
    debugLog.push(`[Step 4e] selection diversity: high_freq_penalty=${highFreqAdjusted} new_money_bonus=${newMoneyAdjusted}`)
  } catch (e) {
    console.warn('[Screener v2] selection diversity failed:', e)
  }

  const maxPerIndustry = (sc as any).maxPerIndustry ?? 5
  const industryCount = new Map<string, number>()
  let afterIndustryLimit = scored.filter(c => {
    const cnt = industryCount.get(c.industry) ?? 0
    if (cnt >= maxPerIndustry) return false
    industryCount.set(c.industry, cnt + 1)
    return true
  })
  const selectionTargetSize = screenerPolicy.sizing.coarseMlQueueSize
  const dynamicThemeCap = Number((sc as any).maxPerIndustryTheme ?? Math.max(3, Math.ceil(selectionTargetSize * 0.18)))
  const dynamicSubindustryCap = Number((sc as any).maxPerSubindustry ?? Math.max(2, Math.ceil(selectionTargetSize * 0.14)))
  const beforeTaxonomyCap = afterIndustryLimit.length
  afterIndustryLimit = applyTaxonomyDiversityCap(afterIndustryLimit, 'industryTheme', dynamicThemeCap)
  afterIndustryLimit = applyTaxonomyDiversityCap(afterIndustryLimit, 'subindustry', dynamicSubindustryCap)
  debugLog.push(
    `[Step 5b] taxonomy diversity cap industry<=${maxPerIndustry} ` +
    `industry_theme<=${dynamicThemeCap} subindustry<=${dynamicSubindustryCap} ` +
    `${beforeTaxonomyCap}->${afterIndustryLimit.length}`,
  )

  // 5c: 報酬率相關性去重
  const corrThreshold = (sc as any).correlationThreshold ?? 0.8
  const corrWindow = (sc as any).correlationWindow ?? 60
  try {
    // Only deduplicate the active policy pool to keep the Worker bounded.
    const top50 = afterIndustryLimit.slice(0, screenerPolicy.sizing.candidatePoolSize)
    afterIndustryLimit = [
      ...(await deduplicateByCorrelation(top50, env.DB, corrThreshold, corrWindow)) as ScoredCandidate[],
      ...afterIndustryLimit.slice(screenerPolicy.sizing.candidatePoolSize),
    ]
  } catch (e) {
    console.warn('[Screener v2] Correlation dedup failed:', e)
  }

  // 5d: top N 截斷；strategy pool 已在 Step 2c（安全硬篩後、RRG/去重前）完成。
  let finalCandidates = dedupeScreenerCandidatesBySymbol(
    annotateCandidatesWithStrategySpecs(afterIndustryLimit.slice(0, screenerPolicy.sizing.candidatePoolSize) as ScreenerCandidate[]),
  )
  if (layer1BreadthPool.length > 0) {
    const layer1TargetSize = screenerPolicy.sizing.candidatePoolSize
    const updatedBySymbol = new Map(scored.map((candidate) => [String(candidate.symbol || '').trim(), candidate]))
    const diversityEligibleSymbols = new Set(afterIndustryLimit.map((candidate) => String(candidate.symbol || '').trim()))
    const layer1Queue = layer1BreadthPool
      .filter((candidate) => {
        const symbol = String(candidate.symbol || '').trim()
        return updatedBySymbol.has(symbol) && diversityEligibleSymbols.has(symbol)
      })
      .slice(0, layer1TargetSize)
    const selectedSymbols = new Set(layer1Queue.map((candidate: any) => String(candidate.symbol || '').trim()))
    const selectedCandidates = layer1Queue.map((entry: any) => {
      const symbol = String(entry.symbol || '').trim()
      const updated = updatedBySymbol.get(symbol)
      return {
        ...(updated ?? entry),
        strategy_pool_decision: entry.strategy_pool_decision,
        strategy_pool_reason: entry.strategy_pool_reason,
        strategy_pool_rank: entry.strategy_pool_rank,
        strategy_pool_ids: entry.strategy_pool_ids,
        strategy_pool_score: entry.strategy_pool_score,
        strategy_watch_points: Array.from(new Set([
          ...((updated as any)?.strategy_watch_points ?? []),
          ...((entry as any).strategy_watch_points ?? []),
        ])),
      }
    })
    const topUpCandidates = afterIndustryLimit
      .filter((candidate) => {
        const symbol = String(candidate.symbol || '').trim()
        return !selectedSymbols.has(symbol)
      })
      .slice(0, Math.max(0, layer1TargetSize - selectedCandidates.length))
      .map((candidate, index) => ({
        ...candidate,
        strategy_pool_decision: 'ml_queue',
        strategy_pool_reason: 'layer1_breadth_after_overlay_top_up',
        strategy_pool_rank: selectedCandidates.length + index + 1,
        strategy_pool_ids: (candidate as any).strategy_pool_ids ?? ['layer1_breadth'],
        strategy_watch_points: [
          ...((candidate as any).strategy_watch_points ?? []),
          'strategy_pool:layer1_breadth_after_overlay_top_up',
        ],
      }))
    finalCandidates = dedupeScreenerCandidatesBySymbol(
      annotateCandidatesWithStrategySpecs([
        ...(selectedCandidates as any[]),
        ...(topUpCandidates as any[]),
      ] as ScreenerCandidate[]),
    )
    strategySelectionTelemetry = {
      ...(strategySelectionTelemetry ?? {}),
      post_diversity_universe_count: afterIndustryLimit.length,
      layer1_breadth_count: layer1BreadthPool.length,
      coarse_queue_count: layer2CoarseQueueSeed.length,
      top_up_count: topUpCandidates.length,
      selected_after_overlay_count: selectedCandidates.length,
      l1_seed_count: selectedCandidates.length + topUpCandidates.length,
      core_ml_shortlist_size: maxCandidates,
    }
    debugLog.push(
      `[Step 5] layer1 breadth seed applied: selected=${selectedCandidates.length}+topup=${topUpCandidates.length}/${layer1TargetSize} ` +
      `controller_l2_target=${coarseQueueSize} core_ml_target=${maxCandidates} post_diversity_universe=${afterIndustryLimit.length}`,
    )
  } else {
    debugLog.push(`[Step 5] layer1 breadth unavailable; fallback to score-ranked L1 seed ${screenerPolicy.sizing.candidatePoolSize}`)
  }
  const step5Msg = `[Step 5] ${scored.length} 檔 → 同產業≤${maxPerIndustry} → ${afterIndustryLimit.length} 檔 → coarse ${coarseQueueSize} → ${finalCandidates.length} 檔 → core target ${maxCandidates}`
  debugLog.push(step5Msg)
  debugLog.push(`[Step 5] L1 seed=${finalCandidates.length}; controller L2 target=${coarseQueueSize}; controller L3 target=${maxCandidates}`)

  // 被產業上限篩掉的
  const removedByIndustry = scored.filter(c => !afterIndustryLimit.includes(c)).slice(0, 10)
  if (removedByIndustry.length) {
    debugLog.push(`[Step 5b] 被同產業上限篩掉（前 10）:`)
    for (const c of removedByIndustry) {
      debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} score=${c.score.toFixed(1)}`)
    }
  }

  // 被去重篩掉的
  const afterDedupSet = new Set(afterIndustryLimit.map(c => c.symbol))
  const removedByDedup = afterIndustryLimit.filter(c => !afterDedupSet.has(c.symbol))
  // 被截斷的
  const truncated = afterIndustryLimit.slice(screenerPolicy.sizing.candidatePoolSize)
  const emergingMaxCandidates = screenerPolicy.sizing.emergingResearchSize
  const emergingResearchCandidates: ScreenerCandidate[] = []
  const emergingData = buildStockData(emergingResearchPrices, allChips)
  try {
    const emergingScored: ScoredCandidate[] = []
    for (const [stockId, prices] of emergingData.prices) {
      if (prices.length < 3) continue
      if (punishedSet.has(stockId)) continue
      const latest = prices[prices.length - 1]
      if (latest.close < sc.minPrice || latest.close > sc.maxPrice) continue
      if (latest.Trading_Volume === 0) continue
      const chipMeta = latestChipMeta(emergingData.chips.get(stockId))
      const { base_score, chip_score, tech_score, momentum_score, score_components, reasons } = scoreMultiFactor(
        prices, emergingData.chips.get(stockId), marketReturn5d, latest.close, cfg,
      )
      const info = sectorMap[stockId]
      const taxonomy = taxonomyProfiles.get(stockId)
      const industry = taxonomyDisplay(taxonomy, industryMap.get(stockId) ?? '其他')
      emergingScored.push({
        symbol: stockId,
        name: info?.name ?? stockId,
        sector: industry,
        score: base_score,
        reason: reasons.slice(0, 3).join(' | ') || 'emerging research watchlist',
        chip_score,
        tech_score,
        momentum_score,
        score_components,
        industry,
        market_segment: 'emerging',
        taxonomy,
        strategy_watch_points: chipMeta ? [chipMeta] : ['chip_source:missing'],
      })
    }
    applyScreenerScoreCalibration(emergingScored, screenerPolicy.scoreCalibration)
    emergingResearchCandidates.push(...dedupeScreenerCandidatesBySymbol(
      annotateCandidatesWithStrategySpecs(
        emergingScored.sort((a, b) => b.score - a.score).slice(0, emergingMaxCandidates) as ScreenerCandidate[],
      ),
    ))
    debugLog.push(`[Step 5e] emerging research lane: ${emergingResearchCandidates.length}/${emergingScored.length} top ${emergingMaxCandidates}`)
  } catch (e) {
    console.warn('[Screener v2] Emerging research lane failed:', e)
    debugLog.push(`[Step 5e] emerging research lane skipped (error): ${e}`)
  }
  if (truncated.length) {
    debugLog.push(`[Step 5d] 被 top ${maxCandidates} 截斷（前 10）:`)
    for (const c of truncated.slice(0, 10)) {
      debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} score=${c.score.toFixed(1)}`)
    }
  }

  // ── Step 6: 資料品質（DelistingMonitor）──
  try {
    const candSymbols = finalCandidates.map(c => c.symbol)
    if (candSymbols.length > 0) {
      const ph = candSymbols.map(() => '?').join(',')
      const { results: recentRows } = await env.DB.prepare(`
        SELECT s.symbol, COUNT(sp.date) as days_count
        FROM stocks s
        LEFT JOIN stock_prices sp ON sp.stock_id = s.id AND sp.date >= date('now', '-7 days')
        WHERE s.symbol IN (${ph})
        GROUP BY s.symbol
      `).bind(...candSymbols).all<{ symbol: string; days_count: number }>()
      const delistRisk = new Set<string>()
      for (const r of (recentRows ?? [])) {
        if (r.days_count <= 2) delistRisk.add(r.symbol)
      }
      if (delistRisk.size > 0) {
        const removed = finalCandidates.filter(c => delistRisk.has(c.symbol))
        for (let i = finalCandidates.length - 1; i >= 0; i--) {
          if (delistRisk.has(finalCandidates[i].symbol)) finalCandidates.splice(i, 1)
        }
        if (removed.length) debugLog.push(`[Step 6] DelistingMonitor removed ${removed.map(c => c.symbol).join(', ')}`)
      }
    }
  } catch (e) {
    console.warn('[Screener v2] DelistingMonitor failed:', e)
  }

  const breeze2ScreenerContext = await enrichScreenerCandidatesWithBreeze2(
    env,
    finalCandidates.map((candidate, index) => {
      const rawCandidate = candidate as ScoredCandidate & Breeze2CandidateLike
      return {
        symbol: candidate.symbol,
        name: candidate.name,
        stock_name: candidate.name,
        score_v2: rawCandidate.score_v2 ?? rawCandidate.score_components ?? null,
        reason: candidate.reason,
        strategy_watch_points: candidate.strategy_watch_points ?? [],
        recommendation_lane: 'tradable',
        major_event: rawCandidate.major_event,
        theme: rawCandidate.theme,
        news: rawCandidate.news,
        evidence_items: rawCandidate.evidence_items,
        rank: index + 1,
      } satisfies Breeze2CandidateLike
    }),
    { runDate: endDate, maxCandidates: 5, executeModal: true },
  ).catch((error) => {
    console.warn('[Screener v2] Breeze2 enrichment skipped:', error)
    return new Map<string, any>()
  })
  if (breeze2ScreenerContext.size > 0) {
    debugLog.push(`[Step 5f] Breeze2 semantic context enriched ${breeze2ScreenerContext.size}/${finalCandidates.length}`)
    for (const [symbol, report] of breeze2ScreenerContext) {
      const candidate = finalCandidates.find((item) => item.symbol === symbol)
      pushFunnelItem(funnelItems, {
        symbol,
        name: candidate?.name,
        stage: 'breeze2_semantic_context',
        decision: report.recommended_decision_context === 'human_review' ? 'observe' : 'pass',
        reasonCode: String(report.recommended_decision_context ?? 'semantic_context'),
        scoreAfter: candidate ? Number((candidate as any).score ?? 0) : null,
        evidence: {
          allowed_use: report.allowed_use,
          decision_effect: report.decision_effect,
          scores: report.scores,
          risk_flags: report.risk_flags,
          quality: report.quality,
        },
      })
    }
  } else {
    debugLog.push('[Step 5f] Breeze2 semantic context: no eligible/enriched candidates')
  }

  debugLog.push(`[Final] candidates=${finalCandidates.length}`)
  finalCandidates.forEach((c, index) => {
    const sc = c as any
    const flag = selectionFlagMap.get(c.symbol)
    pushFunnelItem(funnelItems, {
      symbol: c.symbol,
      name: c.name,
      stage: 'layer2_coarse_ml_gate',
      decision: 'observe',
      reasonCode: 'controller_pending_coarse_ml_gate',
      scoreAfter: Number(sc.score ?? 0),
      rank: index + 1,
      evidence: {
        layer_contract: 'ml-controller runs LightGBM/XGBoost/ExtraTrees coarse rank before core family ML',
        worker_seed_only: true,
        coarse_ml_queue_size: coarseQueueSize,
        core_ml_shortlist_size: maxCandidates,
        strategy_pool_ids: sc.strategy_pool_ids ?? [],
        strategy_pool_score: sc.strategy_pool_score ?? null,
        strategy_pool_reason: sc.strategy_pool_reason ?? null,
      },
    })
    pushFunnelItem(funnelItems, {
      symbol: c.symbol,
      name: c.name,
      stage: 'final_selection',
      decision: 'selected',
      reasonCode: 'selected_for_l1_breadth_seed',
      scoreAfter: Number(sc.score ?? 0),
      rank: index + 1,
      evidence: {
        industry: sc.industry ?? c.sector,
        chip_score: sc.chip_score,
        tech_score: sc.tech_score,
        momentum_score: sc.momentum_score,
        highFreq: flag?.highFreq ?? false,
        newMoney: flag?.newMoney ?? false,
        freq20d: flag?.freq20d ?? 0,
        strategy_tags: sc.strategy_tags ?? [],
        strategy_pool_ids: sc.strategy_pool_ids ?? [],
        strategy_pool_score: sc.strategy_pool_score ?? null,
        strategy_pool_reason: sc.strategy_pool_reason ?? null,
        l1_breadth_seed_size: finalCandidates.length,
        layer2_owner: 'ml-controller',
        layer2_coarse_queue_size: coarseQueueSize,
        layer3_core_ml_target_size: maxCandidates,
      },
    })
  })

  // ── DB 寫入 ──
  try {
    await updateScreenerWatchlist(env.DB, finalCandidates, tpexSymbolSet)
  } catch (e) {
    console.error('[Screener v2] Watchlist update failed:', e)
  }

  // ── #15 Selection frequency tag (dannyquant_tw 啟發, 2026-04-21) ──────────
  // Query 前 20 天 / 30 天的 screener selection history 並為本日候選算兩個 flag:
  //   high_freq: 20d count ≥ 12
  //   new_money: 30d count = 0 (今天首次出現)
  // Forward-only: deploy 日起累積，20d 後 high_freq 才成熟、30d 後 new_money 有信度
  debugLog.push('[Step 4e] selection history flags reused from candidate-pool superset; no final refresh query')

  // ── #16 Sector leader correlation bonus (2026-04-21, dannyquant_tw 啟發) ──
  // sectorLeaderBonus(symbol, sector) → bonus points if avg 60d corr > threshold.
  // 連動族群 leaders 的候選 = 跟 ETF/基金 flow 同向，加分反映此 edge。
  // Fire-and-forget: table 缺或運算失敗皆 0 bonus 不擋主流程。
  const sectorBonusMap = new Map<string, { bonus: number; avgCorr: number | null }>()
  try {
    const { sectorLeaderBonusBatch } = await import('./sectorCorrelation')
    const bonusPoints = sc.sectorLeaderBonusPoints ?? 5
    const corrThreshold = sc.sectorLeaderCorrThreshold ?? 0.7
    const bulkBonus = await sectorLeaderBonusBatch(
      env.DB,
      finalCandidates.map(c => ({ symbol: c.symbol, sector: c.sector ?? null })),
      corrThreshold,
      bonusPoints,
    )
    for (const [symbol, value] of bulkBonus) {
      sectorBonusMap.set(symbol, { bonus: value.bonus, avgCorr: value.avgCorr })
    }
    const matched = [...sectorBonusMap.values()].filter(b => b.bonus > 0).length
    debugLog.push(`[Step 4d] sector leader bonus batch: ${matched}/${finalCandidates.length} corr>${corrThreshold} (+${bonusPoints})`)
  } catch (e) {
    console.warn('[Screener v2] #16 sector bonus failed (table missing or cold start):', e)
  }

  // Screener 只負責 seed chip/tech/price；ML-enriched recommendations 由 ml-controller 擁有。
  try {
    const recBatch = finalCandidates.map((c, i) => {
      const sc = c as any
      // 從即時 API 資料取最新收盤價（不寫 null）
      const latestPrices = data.prices.get(c.symbol)
      const currentPrice = latestPrices?.length ? latestPrices[latestPrices.length - 1].close : null
      // #15 tag prefix + #16 sector leader bonus 一起 append 到 reason
      const flag = selectionFlagMap.get(c.symbol)
      const sectorB = sectorBonusMap.get(c.symbol)
      const breeze2WatchPoint = extractBreeze2WatchPoint(breeze2ScreenerContext.get(c.symbol))
      const chipMeta = latestChipMeta(data.chips.get(c.symbol))
      const taxPoint = taxonomyWatchPoint((c as any).taxonomy)
      const tagParts: string[] = []
      if (flag?.highFreq) tagParts.push(`📌 高頻 (20d 入選 ${flag.freq20d} 次)`)
      if (flag?.newMoney) tagParts.push('🆕 新資金 (30d 首見)')
      if (sectorB && sectorB.bonus > 0 && sectorB.avgCorr !== null) {
        tagParts.push(`🔗 族群連動 (corr=${sectorB.avgCorr.toFixed(2)}, +${sectorB.bonus})`)
      }
      for (const tag of sc.strategy_tags ?? []) tagParts.push(tag)
      const seed = buildScreenerSeedRow({
        candidate: c as any,
        rank: i + 1,
        currentPrice,
        sectorBonus: sectorB?.bonus ?? 0,
        tags: tagParts,
      })
      const watchPoints = Array.from(new Set([
        ...seed.watchPoints,
        `screener_funnel:rank=${i + 1},freq20d=${flag?.freq20d ?? 0},high_freq=${flag?.highFreq ? 'yes' : 'no'},new_money=${flag?.newMoney ? 'yes' : 'no'}`,
        ...(chipMeta ? [chipMeta] : ['chip_source:missing']),
        ...(taxPoint ? [taxPoint] : ['taxonomy:missing']),
        ...(breeze2WatchPoint ? [breeze2WatchPoint] : []),
        ...(sc.strategy_watch_points ?? []),
      ]))
      return env.DB.prepare(buildScreenerSeedUpsertSql()).bind(
        endDate, seed.row.symbol, seed.row.symbol, seed.row.name, seed.row.sector,
        seed.rank, seed.row.seedScore,
        seed.row.chipScore, seed.row.techScore, seed.row.momentumScore,
        seed.row.currentPrice,
        seed.row.reason, JSON.stringify(watchPoints), seed.row.scoreComponents, seed.row.industry,
        tpexSymbolSet.has(c.symbol) ? 'OTC' : 'LISTED',
        'tradable',
        1,
        1,
      )
    })
    const emergingRecBatch = emergingResearchCandidates.map((c, i) => {
      const sc = c as any
      const latestPrices = emergingData.prices.get(c.symbol)
      const currentPrice = latestPrices?.length ? latestPrices[latestPrices.length - 1].close : null
      const chipMeta = latestChipMeta(emergingData.chips.get(c.symbol))
      const taxPoint = taxonomyWatchPoint((c as any).taxonomy)
      const seed = buildScreenerSeedRow({
        candidate: c as any,
        rank: 100 + i + 1,
        currentPrice,
        tags: [
          'research_only:emerging_not_for_auto_trade',
          'board_lane:emerging_watchlist',
          ...(sc.strategy_tags ?? []),
        ],
      })
      const watchPoints = Array.from(new Set([
        ...seed.watchPoints,
        'research_only:emerging_not_for_auto_trade',
        'board_lane:emerging_watchlist',
        ...(chipMeta ? [chipMeta] : ['chip_source:missing']),
        ...(taxPoint ? [taxPoint] : ['taxonomy:missing']),
        ...(sc.strategy_watch_points ?? []),
      ]))
      return env.DB.prepare(buildScreenerSeedUpsertSql()).bind(
        endDate, seed.row.symbol, seed.row.symbol, seed.row.name, seed.row.sector,
        seed.rank, seed.row.seedScore,
        seed.row.chipScore, seed.row.techScore, seed.row.momentumScore,
        seed.row.currentPrice,
        seed.row.reason, JSON.stringify(watchPoints), seed.row.scoreComponents, seed.row.industry,
        'EMERGING',
        'emerging_watchlist',
        1,
        0,
      )
    })
    recBatch.push(...emergingRecBatch)
    const BATCH = 50
    for (let b = 0; b < recBatch.length; b += BATCH) {
      await env.DB.batch(recBatch.slice(b, b + BATCH))
    }

    const seedSymbols = [
      ...finalCandidates.map(c => c.symbol),
      ...emergingResearchCandidates.map(c => c.symbol),
    ].map(s => String(s || '').trim()).filter(Boolean)
    await env.DB.prepare(buildScreenerSeedPruneSql(seedSymbols.length))
      .bind(endDate, ...seedSymbols)
      .run()

    // 保證所有候選都 in_current_watchlist=1（防止 updateScreenerWatchlist batch 失敗的邊界情況）
    if (finalCandidates.length > 0) {
      const ph = finalCandidates.map(() => '?').join(',')
      await env.DB.prepare(
        `UPDATE stocks SET in_current_watchlist=1 WHERE symbol IN (${ph})`
      ).bind(...finalCandidates.map(c => c.symbol)).run()
    }

    debugLog.push(
      `[DB] daily_recommendations seed/upsert tradable=${finalCandidates.length} ` +
      `emerging_research=${emergingResearchCandidates.length}; ML owner fields preserved`,
    )

    try {
      const themeRuntime = await materializeScreenerThemeRuntime(env.DB, endDate, seedSymbols)
      debugLog.push(
        `[DB] theme runtime materialized signals=${themeRuntime.signals} ` +
        `tags=${themeRuntime.tags} features=${themeRuntime.features}`,
      )
    } catch (e) {
      console.warn('[Screener v2] theme runtime materialization failed:', e)
    }

    // #15 同步寫 screener_selection_history 供下次 run 計算 freq flag
    try {
      const histBatch = finalCandidates.map(c => {
        const sc = c as any
        const scoreV2 = readScoreV2Snapshot({ score_components: sc.score_components } as ScoreV2StorageRow)
        const combined = Number.isFinite(Number(sc.score))
          ? Number(sc.score)
          : scoreV2?.finalScore ?? 0
        return env.DB.prepare(
          `INSERT OR IGNORE INTO screener_selection_history (date, stock_id, symbol, score, industry)
           VALUES (?, (SELECT id FROM stocks WHERE symbol=?), ?, ?, ?)`
        ).bind(endDate, c.symbol, c.symbol, combined, sc.industry ?? c.sector ?? null)
      })
      for (let b = 0; b < histBatch.length; b += 50) {
        await env.DB.batch(histBatch.slice(b, b + 50))
      }
      const hiCount = [...selectionFlagMap.values()].filter(f => f.highFreq).length
      const newCount = [...selectionFlagMap.values()].filter(f => f.newMoney).length
      debugLog.push(`[DB] selection history +${finalCandidates.length} rows | high_freq=${hiCount} new_money=${newCount}`)
    } catch (e) {
      console.warn('[Screener v2] #15 history insert failed (likely table missing, skip):', e)
    }

    // 對缺 technical_indicators 的新股立即計算（不等 Queue，避免 ML NO_SIGNAL）
    try {
      const seedSymbolsForIndicators = [
        ...finalCandidates.map(c => c.symbol),
        ...emergingResearchCandidates.map(c => c.symbol),
      ].map(s => String(s || '').trim()).filter(Boolean)
      if (!seedSymbolsForIndicators.length) {
        debugLog.push('[DB] skipped technical_indicators seed backfill: no seed symbols')
      } else {
        const ph = seedSymbolsForIndicators.map(() => '?').join(',')
        const { results: noTiStocks } = await env.DB.prepare(`
        SELECT s.id, s.symbol FROM stocks s
        WHERE s.symbol IN (${ph})
          AND NOT EXISTS (
            SELECT 1 FROM technical_indicators ti
             WHERE ti.stock_id = s.id
               AND ti.date >= date(?, '-3 days')
               AND ti.date <= ?
          )
          AND EXISTS (SELECT 1 FROM stock_prices sp WHERE sp.stock_id = s.id LIMIT 1)
      `).bind(...seedSymbolsForIndicators, endDate, endDate).all<{ id: number; symbol: string }>()

        if (noTiStocks?.length) {
          let computed = 0
          for (const stock of noTiStocks) {
            await computeAndStoreIndicators(env.DB, stock.id, endDate)
            computed++
          }
          debugLog.push(`[DB] backfilled technical_indicators for seed symbols=${computed}: ${noTiStocks.map(s => s.symbol).join(', ')}`)
        }
      }
    } catch (e) {
      console.warn('[Screener v2] 新股 TI 補算失敗 (non-blocking):', e)
    }
  } catch (e) {
    console.warn('[Screener v2] daily_recommendations 寫入失敗:', e)
  }

  try {
    await storeSectorHeat(env.DB, endDate, sectorHeatScores)
  } catch (e) {
    console.warn('[Screener v2] sector_heat write failed:', e)
  }

  // Momentum Crash Zone snapshot (Daniel & Moskowitz 2016)
  // Tracks pool-level crowding and writes today's zone for circuit-breaker Layer 6.
  try {
    const {
      aggregateFromPrices, loadOversoldHistory, assessZone, writeMomentumSnapshot,
    } = await import('./momentumZone')
    const indicator = aggregateFromPrices(finalCandidates, data.prices)
    const history = await loadOversoldHistory(env.DB, endDate)
    const assessment = assessZone(indicator.pct_oversold, history)
    await writeMomentumSnapshot(env.DB, endDate, indicator, assessment)
    debugLog.push(
      `[Screener v2] momentum zone ${assessment.zone} ` +
      `(pct_oversold=${(indicator.pct_oversold * 100).toFixed(1)}%, ` +
      `rank=${(assessment.percentile_rank * 100).toFixed(1)}, history=${assessment.n_history})`
    )
  } catch (e) {
    console.warn('[Screener v2] momentum zone snapshot failed (non-blocking):', e)
  }

  try {
    await storePttBuzz(env.DB, endDate, combinedBuzz)
  } catch (e) {
    console.warn('[Screener v2] buzz write failed:', e)
  }

  // Discord 通知
  try {
    const { sendDiscordNotification } = await import('./notify')
    // Phase 6.6: RRG moved to ml-controller; screener no longer has in-memory `rrg` map.
    // Leading industry list omitted from this notification (can be re-added by
    // querying sector_flow table if needed).
    const leadingIndustries = ''
    const topCands = finalCandidates.slice(0, 5).map(c => `${c.symbol}${c.name}(${c.score.toFixed(0)})`).join(' ')
    const pttTop = combinedBuzz.slice(0, 3).map(b => `${b.concept}(${b.mentionCount})`).join(', ')
    void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
      `🔍 **Bottom-up 多因子選股完成**\n` +
      `> 📊 候選：${finalCandidates.length} 支（上限 ${maxCandidates}）\n` +
      `> 🏭 Leading 產業：${leadingIndustries || '無'}\n` +
      `> 🏆 Top 5：${topCands}\n` +
      `> 💬 PTT 熱議：${pttTop || '無'}`)
  } catch (e) {
    console.warn('[Screener v2] Discord failed:', e)
  }

  // Final debug summary
  debugLog.push(`[Final] ${finalCandidates.length} 檔:`)
  for (const c of finalCandidates) {
    debugLog.push(`  ${c.symbol} ${(c as any).name ?? ''} ${(c as any).industry ?? c.sector} score=${c.score.toFixed(1)}`)
  }

  try {
    await writeScreenerFunnel(env, {
      runId,
      date: endDate,
      status: 'success',
      universeCount: universe.length,
      candidateCount: scored.length,
      finalCount: finalCandidates.length,
      emergingCount: emergingResearchCandidates.length,
      metadata: {
        candidatePoolSize: screenerPolicy.sizing.candidatePoolSize,
        coarseMlQueueSize: screenerPolicy.sizing.coarseMlQueueSize,
        mlShortlistSize: screenerPolicy.sizing.mlShortlistSize,
        emergingResearchSize: screenerPolicy.sizing.emergingResearchSize,
        strategyCandidatePool: strategySelectionTelemetry,
        restrictedCount: punishedSet.size,
        buzzConcepts: combinedBuzz.slice(0, 10).map(b => b.concept),
      },
      debugLog,
      items: funnelItems,
    })
  } catch (e) {
    console.warn('[Screener v2] funnel write failed:', e)
  }

  return { hotSectors: sectorHeatScores, candidates: finalCandidates, emergingResearchCandidates, debugLog }
}

// ═══════════════════════════════════════════════════════════════════════════════
// P2-7: IC（Information Coefficient）驗證框架
// P3-8: MAE 停損分析
// P3-6: Z-score 工具
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * P3-6: Z-score 標準化工具
 * 將任意數值陣列轉為 Z-score，截斷 [-3, 3]
 */
function zScore(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 0.001
  return values.map(v => Math.max(-3, Math.min(3, (v - mean) / std)))
}

/**
 * P2-7: 因子 IC 計算 — 各因子與未來 N 日報酬的 Spearman rank correlation
 * 用於驗證 Score V2 五構面與 finalScore 的預測力
 * 門檻：IC > 0.05 (ML), > 0.01 (Factor)
 */
export async function calcFactorIC(env: Bindings): Promise<{
  factors: { name: string; ic_5d: number; ic_10d: number; ic_20d: number; sample: number }[]
}> {
  // Score V2 payload is canonical; factor IC must not read legacy projection columns.
  const { results: recRows } = await env.DB.prepare(`
    SELECT r.symbol, r.date, r.score_components
    FROM daily_recommendations r
    WHERE r.date >= date('now', '-30 days')
    ORDER BY r.date, r.symbol
  `).all<Array<ScoreV2StorageRow & { symbol: string; date: string }>[number]>()

  if (!recRows?.length) return { factors: [] }

  // 查每支股票的未來報酬（5d, 10d, 20d）
  const symbols = [...new Set(recRows.map(r => r.symbol))]
  const priceRows: { symbol: string; date: string; close: number }[] = []
  for (const chunk of chunkArray(symbols, 400)) {
    const ph = chunk.map(() => '?').join(',')
    const { results } = await env.DB.prepare(`
      SELECT s.symbol, sp.date, sp.close
      FROM stock_prices sp JOIN stocks s ON sp.stock_id = s.id
      WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-60 days')
      ORDER BY s.symbol, sp.date
    `).bind(...chunk).all<{ symbol: string; date: string; close: number }>()
    priceRows.push(...(results ?? []))
  }

  // 建 symbol → date → close map
  const priceMap = new Map<string, Map<string, number>>()
  for (const r of (priceRows ?? [])) {
    if (!priceMap.has(r.symbol)) priceMap.set(r.symbol, new Map())
    priceMap.get(r.symbol)!.set(r.date, r.close)
  }

  // Spearman rank correlation
  function spearmanCorr(x: number[], y: number[]): number {
    const n = x.length
    if (n < 5) return 0
    const rankX = rankArray(x), rankY = rankArray(y)
    let sumD2 = 0
    for (let i = 0; i < n; i++) sumD2 += (rankX[i] - rankY[i]) ** 2
    return 1 - (6 * sumD2) / (n * (n * n - 1))
  }
  function rankArray(arr: number[]): number[] {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const ranks = new Array(arr.length)
    sorted.forEach((s, rank) => { ranks[s.i] = rank + 1 })
    return ranks
  }

  // 計算 Score V2 taxonomy 因子的 IC
  const factors = [
    {
      name: 'mlEdge',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.components.mlEdge ?? null,
    },
    {
      name: 'chipFlow',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.components.chipFlow ?? null,
    },
    {
      name: 'technicalStructure',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.components.technicalStructure ?? null,
    },
    {
      name: 'fundamentalQuality',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.components.fundamentalQuality ?? null,
    },
    {
      name: 'newsTheme',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.components.newsTheme ?? null,
    },
    {
      name: 'finalScore',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.finalScore ?? null,
    },
  ] as const
  const results = []

  for (const factor of factors) {
    const ic: { [horizon: string]: number[] } = { '5d': [], '10d': [], '20d': [] }

    // 按日期分組算橫截面 IC
    const byDate = new Map<string, typeof recRows>()
    for (const r of recRows) {
      if (!byDate.has(r.date)) byDate.set(r.date, [])
      byDate.get(r.date)!.push(r)
    }

    for (const [date, recs] of byDate) {
      for (const [horizon, days] of [['5d', 5], ['10d', 10], ['20d', 20]] as const) {
        const factorValues: number[] = []
        const futureReturns: number[] = []

        for (const rec of recs) {
          const prices = priceMap.get(rec.symbol)
          if (!prices) continue
          const dates = [...prices.keys()].sort()
          const dateIdx = dates.indexOf(date)
          if (dateIdx < 0 || dateIdx + days >= dates.length) continue

          const closeNow = prices.get(dates[dateIdx])!
          const closeFuture = prices.get(dates[dateIdx + days])!
          if (closeNow <= 0) continue

          const factorValue = factor.value(rec)
          if (factorValue == null) continue
          factorValues.push(factorValue)
          futureReturns.push((closeFuture - closeNow) / closeNow)
        }

        if (factorValues.length >= 5) {
          ic[horizon].push(spearmanCorr(factorValues, futureReturns))
        }
      }
    }

    results.push({
      name: factor.name,
      ic_5d: ic['5d'].length ? +(ic['5d'].reduce((a, b) => a + b, 0) / ic['5d'].length).toFixed(4) : 0,
      ic_10d: ic['10d'].length ? +(ic['10d'].reduce((a, b) => a + b, 0) / ic['10d'].length).toFixed(4) : 0,
      ic_20d: ic['20d'].length ? +(ic['20d'].reduce((a, b) => a + b, 0) / ic['20d'].length).toFixed(4) : 0,
      sample: recRows.length,
    })
  }

  return { factors: results }
}

/**
 * P3-8: MAE 停損分析 — 用 predictions 表的 max_adverse_pct 分析最佳停損點
 */
export async function analyzeMAE(env: Bindings): Promise<{
  summary: {
    total_trades: number
    winning_trades: number
    losing_trades: number
    winning_mae_p75: number   // 獲利交易的 75 百分位 MAE
    losing_mae_p25: number    // 虧損交易的 25 百分位 MAE
    suggested_stop: number    // 建議停損 %
  }
  distribution: { bucket: string; winning: number; losing: number }[]
}> {
  const { results: trades } = await env.DB.prepare(`
    SELECT max_adverse_pct, actual_return_pct, trade_outcome
    FROM predictions
    WHERE max_adverse_pct IS NOT NULL AND actual_return_pct IS NOT NULL
    ORDER BY generated_at DESC LIMIT 500
  `).all<{ max_adverse_pct: number; actual_return_pct: number; trade_outcome: string | null }>()

  if (!trades?.length) return {
    summary: { total_trades: 0, winning_trades: 0, losing_trades: 0, winning_mae_p75: 0, losing_mae_p25: 0, suggested_stop: -0.10 },
    distribution: [],
  }

  const winning = trades.filter(t => t.actual_return_pct > 0)
  const losing = trades.filter(t => t.actual_return_pct <= 0)

  // MAE 分布（每 2% 一個 bucket）
  const buckets = ['-2%', '-4%', '-6%', '-8%', '-10%', '-12%', '-15%', '-20%', '>-20%']
  const thresholds = [-0.02, -0.04, -0.06, -0.08, -0.10, -0.12, -0.15, -0.20, -1]
  const distribution = buckets.map((bucket, i) => {
    const lo = i === 0 ? 0 : thresholds[i - 1]
    const hi = thresholds[i]
    return {
      bucket,
      winning: winning.filter(t => t.max_adverse_pct >= hi && t.max_adverse_pct < lo).length,
      losing: losing.filter(t => t.max_adverse_pct >= hi && t.max_adverse_pct < lo).length,
    }
  })

  // 百分位計算
  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * p)
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0
  }

  const winMAEs = winning.map(t => t.max_adverse_pct)
  const loseMAEs = losing.map(t => t.max_adverse_pct)

  // 建議停損：獲利交易 75 百分位 MAE（保留大部分獲利交易）
  const winP75 = winMAEs.length ? percentile(winMAEs, 0.25) : -0.05  // 25th percentile of MAE (most negative)
  const suggestedStop = Math.min(winP75 * 1.2, -0.03)  // 多留 20% buffer，最少 -3%

  return {
    summary: {
      total_trades: trades.length,
      winning_trades: winning.length,
      losing_trades: losing.length,
      winning_mae_p75: +(winP75 * 100).toFixed(2),
      losing_mae_p25: loseMAEs.length ? +(percentile(loseMAEs, 0.25) * 100).toFixed(2) : 0,
      suggested_stop: +suggestedStop.toFixed(4),
    },
    distribution,
  }
}
