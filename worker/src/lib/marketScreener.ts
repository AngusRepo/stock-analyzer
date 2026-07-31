/**
 * marketScreener.ts ???典??渲???+ ?黎頛芸??菜葫
 *
 * 瘥?嗥敺銵?14:00 TW = 06:00 UTC cron嚗?敺撣蝭拚??~25 ?臬??
 * ?芸??湔 stocks 銵剁?source='screener'嚗?霈?蝥?ML pipeline ??
 *
 * ?拚?畾菜???QuantConnect Coarse+Fine pattern嚗?
 *   Stage 1: Sector Heat Score ??top 5 ?梢??黎
 *   Stage 2: Individual Stock Filter ??瘥?蝢?top 5-8 ??
 */

import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { getTradingConfig, type TradingConfig } from './tradingConfig'
import { buildScreenerSeedRow, buildScreenerSeedUpsertSql } from './screenerSeedQuality'
import { computeAndStoreIndicators, computeTechnicalIndicators } from './technicalIndicators'
import { loadMarketDataFromD1, type CanonicalScreenerChip, type CanonicalScreenerPrice } from './screenerMarketData'
import {
  annotateCandidatesWithStrategySpecs,
  reconcileCandidatesStrategyPoolAttribution,
} from './screenerStrategyConsumer'
import { getAdaptiveParamsForRegime } from './adaptiveConfig'
import { readMarketRegimeState } from './marketRegimeState'
import { applyScreenerScoreCalibration, resolveScreenerPolicy } from './screenerPolicy'
import { enrichScreenerCandidatesWithBreeze2, extractBreeze2WatchPoint, type Breeze2CandidateShape } from './breeze2Runtime'
import { controllerPostJson } from './controllerClient'
import { loadTradingRestrictionBuckets } from './tradingRestrictions'
import { isEtfPatternSymbol } from './boardTradability'
import { buildPartialScreenerScoreV2, buildScoreV2Components, readScoreV2Snapshot, type ScoreV2StorageRow } from './scoreV2Taxonomy'
import { loadExternalEvidenceRiskOverlays } from './newsThemeRiskOverlay'
import { buildPriceActionStructure } from './priceActionStructure'
import { FINLAB_PORTFOLIO_INTELLIGENCE_VERSION, buildStrategySimilarityEvidencePayload, type StrategySimilarityEvidencePayload } from './multiStrategyPleRouter'
import { coerceModalStrategySimilarityGraphEvidence, modalStrategySimilarityBlockedReason, type StrategySimilarityGraphEvidence } from './strategyPortfolioMetrics'
import { loadRuntimeTeacherEvidence } from './runtimeTeacherEvidence'
import type { StrategySpec } from './strategySpec'
import {
  materializeFormal137FeatureAliases,
  materializeFormal137UsSentimentScoreRank,
  type Formal137FeatureAliasMaterializationTelemetry,
  type Formal137UsSentimentMaterializationTelemetry,
} from './formal137FeatureMaterialization'
import {
  deriveStockTechnicalDailyFeatures,
  deriveStockTechnicalMarketRegime,
  materializeStockTechnicalStrategyScores,
} from './stockTechnicalStrategyMaterialization'
import {
  buildFinLabTaxonomyThemeSignals,
  refreshStockThemeFeaturesFromSignals,
  upsertThemeSignals,
  type FinLabTaxonomyTagRow,
} from './v41DataRuntime'
import { promoteCanonicalRun, registerPipelineRun, writeEvidenceArtifact } from './artifactLifecycle'
import { sha256Text } from './datasetSnapshots'
import {
  buildSelectionEvidenceV4,
  persistSelectionEvidenceV4,
  SELECTION_REFERENCE_CONTRACT_VERSION,
  strategyRegistryFingerprintPayload,
  type SelectionReferenceRowV1,
  type StrategyLabelMatrixRowV4,
} from './selectionReferenceEvidence'

const D1_IN_CHUNK_SIZE = 40
const SCREENER_FUNNEL_MAX_ITEMS = 5000
const SCREENER_PIPELINE_CODE_VERSION = 'market-screener-selection-reference-v4'
const STOCK_TECHNICAL_HISTORY_PRICE_DAYS = 280
const SCREENER_FUNNEL_PIPELINE_SEED_STAGES = new Set([
  'l1_candidate_seed_after_overlay',
  'final_selection',
])
const SCREENER_FUNNEL_AUDIT_CRITICAL_STAGES = new Set([
  'l15_ml_slate_queue',
  'layer2_timesfm_enrichment',
  'strategy_pool_ml_queue',
])

function isEtfHardGateSymbol(symbol: string, info?: { market?: string }): boolean {
  const market = String(info?.market ?? '').trim().toUpperCase()
  return market === 'ETF' || isEtfPatternSymbol(symbol)
}

// ??? Types ???????????????????????????????????????????????????????????????????

export interface SectorHeatScore {
  sector: string
  score: number           // 0-100
  components: {
    chipFlow: number      // 瘜犖鞈??葉摨?(40%)
    relativeStrength: number  // ?黎?詨?撘瑕漲 (30%)
    volumeExpansion: number   // ?漱?撘?(20%)
    momentum: number      // ??頞典 (10%)
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

// ??? Internal helpers ????????????????????????????????????????????????????????

function today(): string {
  // ?典????UTC+8嚗?蝣箔??嗥敺??啁憭抵???
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

type L125StrategySimilarityEvidenceLoad = {
  status: 'modal_python' | 'pending_maturity' | 'unavailable_blocked' | 'invalid_blocked' | 'empty_blocked'
  evidence: StrategySimilarityGraphEvidence | null
  error?: string
  payload_strategy_count: number
  artifact_id?: string
}

async function persistStrategyRedundancyArtifact(
  env: Bindings,
  asOfDate: string,
  raw: Record<string, unknown>,
  payloadStrategyCount: number,
): Promise<string> {
  const rawGraphJson = JSON.stringify(raw)
  const checksum = (await sha256Text(rawGraphJson)).slice(0, 20)
  const artifactId = `strategy-redundancy-oof-v1-${asOfDate}-${checksum}`
  const sourceContract = String(raw.input_scope ?? '').trim()
  const pendingMaturity = raw.status === 'blocked'
    && raw.blocked_reason === 'insufficient_paired_mature_oof_residual_returns'
  const pass = raw.status === 'computed'
    && raw.method === 'networkx_connected_components_oof_residual_correlation'
    && sourceContract === 'mature_oof_residual_returns_with_same_day_overlap_diagnostic'
    && Number(raw.eligible_oof_pair_count ?? 0) > 0
  const evidenceManifest = await writeEvidenceArtifact(env, {
    domain: 'strategy_redundancy_oof',
    businessDate: asOfDate,
    producerRunId: artifactId,
    retentionClass: 'canonical_model_evidence',
    schemaVersion: 'strategy-redundancy-oof-evidence-v1',
    payload: raw,
    rowCount: Math.max(0, Math.floor(Number(raw.eligible_oof_pair_count ?? 0) || 0)),
    metadata: {
      source_contract: sourceContract || 'missing',
      oof_max_date: String(raw.oof_max_date ?? '').trim() || null,
      pass,
    },
  })
  const graphJson = JSON.stringify({
    schema_version: raw.schema_version ?? null,
    status: raw.status ?? null,
    method: raw.method ?? null,
    input_scope: raw.input_scope ?? null,
    edge_threshold: raw.edge_threshold ?? null,
    strategy_cluster_id: raw.strategy_cluster_id ?? {},
    strategy_cluster_size: raw.strategy_cluster_size ?? {},
    strategy_cluster_uniqueness_score: raw.strategy_cluster_uniqueness_score ?? {},
    eligible_oof_pair_count: raw.eligible_oof_pair_count ?? 0,
    paired_date_max: raw.paired_date_max ?? 0,
    eligible_paired_date_max: raw.eligible_paired_date_max ?? 0,
    paired_date_requirement: raw.paired_date_requirement ?? 5,
    pair_count_with_any_overlap: raw.pair_count_with_any_overlap ?? 0,
    oof_max_date: raw.oof_max_date ?? null,
    r2_artifact_id: evidenceManifest.artifact_id,
    r2_key: evidenceManifest.r2_key,
    checksum: evidenceManifest.checksum,
  })
  await env.DB.prepare(`
    INSERT INTO strategy_redundancy_artifacts_v1 (
      artifact_id, as_of_date, status, source_contract,
      strategy_count, paired_date_count, oof_max_date,
      edge_count, effective_strategy_count, graph_json,
      evidence_artifact_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(artifact_id) DO UPDATE SET
      status=excluded.status,
      source_contract=excluded.source_contract,
      strategy_count=excluded.strategy_count,
      paired_date_count=excluded.paired_date_count,
      oof_max_date=excluded.oof_max_date,
      edge_count=excluded.edge_count,
      effective_strategy_count=excluded.effective_strategy_count,
      graph_json=excluded.graph_json,
      evidence_artifact_id=excluded.evidence_artifact_id,
      created_at=CURRENT_TIMESTAMP
  `).bind(
    artifactId,
    asOfDate,
    pass ? 'pass' : pendingMaturity ? 'pending_maturity' : 'fail',
    sourceContract || 'missing',
    Math.max(0, Math.floor(Number(raw.strategy_count ?? payloadStrategyCount) || 0)),
    Math.max(0, Math.floor(Number(raw.paired_date_max ?? 0) || 0)),
    String(raw.oof_max_date ?? '').trim() || null,
    Math.max(0, Math.floor(Number(raw.edge_count ?? 0) || 0)),
    Number.isFinite(Number(raw.effective_strategy_count)) ? Number(raw.effective_strategy_count) : null,
    graphJson,
    evidenceManifest.artifact_id,
  ).run()
  return artifactId
}

export async function loadL125StrategySimilarityGraphEvidence(
  env: Bindings,
  payload: StrategySimilarityEvidencePayload,
  asOfDate: string,
): Promise<L125StrategySimilarityEvidenceLoad> {
  const payloadStrategyCount = payload.strategies.length
  if (!payloadStrategyCount) {
    return {
      status: 'empty_blocked',
      evidence: null,
      payload_strategy_count: payloadStrategyCount,
      error: 'no_strategy_similarity_payload_strategies',
    }
  }
  if (!env.ML_CONTROLLER_URL) {
    return {
      status: 'unavailable_blocked',
      evidence: null,
      payload_strategy_count: payloadStrategyCount,
      error: 'ML_CONTROLLER_URL not set',
    }
  }
  try {
    const raw = await controllerPostJson<Record<string, unknown>>(
      env,
      '/l125/strategy_similarity_evidence',
      payload,
      120_000,
    )
    const artifactId = await persistStrategyRedundancyArtifact(env, asOfDate, raw, payloadStrategyCount)
    const blockedReason = modalStrategySimilarityBlockedReason(raw)
    if (blockedReason) {
      const pendingMaturity = blockedReason === 'insufficient_paired_mature_oof_residual_returns'
      return {
        status: pendingMaturity ? 'pending_maturity' : 'unavailable_blocked',
        evidence: null,
        payload_strategy_count: payloadStrategyCount,
        artifact_id: artifactId,
        error: `strategy_similarity_evidence_blocked:${blockedReason}`,
      }
    }
    const evidence = coerceModalStrategySimilarityGraphEvidence(raw)
    if (!evidence || evidence.source !== 'modal_python') {
      return {
        status: 'invalid_blocked',
        evidence: null,
        payload_strategy_count: payloadStrategyCount,
        artifact_id: artifactId,
        error: 'invalid_modal_strategy_similarity_evidence_contract',
      }
    }
    return { status: 'modal_python', evidence, payload_strategy_count: payloadStrategyCount, artifact_id: artifactId }
  } catch (error) {
    return {
      status: 'unavailable_blocked',
      evidence: null,
      payload_strategy_count: payloadStrategyCount,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    }
  }
}

interface PreparedStrategyRedundancyBackfill {
  as_of_date: string
  producer_run_id: string
  strategy_registry_checksum: string
  matrix_rows: number
  strategy_count: number
  oof_strategy_count: number
  payload: StrategySimilarityEvidencePayload
}

export async function prepareStrategyRedundancyBackfill(
  env: Bindings,
  asOfDate: string,
): Promise<PreparedStrategyRedundancyBackfill> {
  const run = await env.DB.prepare(`
    SELECT mr.producer_run_id, mr.status, mr.strategy_count,
           mr.expected_cell_count, mr.persisted_cell_count,
           mr.strategy_registry_checksum, mr.labeler_version,
           mr.reference_contract_version
      FROM strategy_label_matrix_runs_v4 mr
     WHERE mr.signal_date=?
       AND EXISTS (
         SELECT 1 FROM canonical_run_heads h
          WHERE h.logical_run_key='screener:' || mr.signal_date || ':TW:production:market_screener'
            AND h.run_id=mr.producer_run_id
       )
     ORDER BY datetime(mr.updated_at) DESC
     LIMIT 1
  `).bind(asOfDate).first<{
    producer_run_id: string
    status: string
    strategy_count: number
    expected_cell_count: number
    persisted_cell_count: number
    strategy_registry_checksum: string
    labeler_version: string | null
    reference_contract_version: string | null
  }>()
  if (!run) throw new Error(`strategy_redundancy_matrix_run_missing:${asOfDate}`)
  const expectedCells = Math.max(0, Number(run.expected_cell_count ?? 0))
  const persistedCells = Math.max(0, Number(run.persisted_cell_count ?? 0))
  if (run.status !== 'ready' || expectedCells <= 0 || persistedCells !== expectedCells) {
    throw new Error(`strategy_redundancy_matrix_not_ready:${asOfDate}:${run.status}:${persistedCells}/${expectedCells}`)
  }
  const matrixLabelerVersion = String(run.labeler_version ?? '').trim()
  if (!['strategy-labeler-v1', 'strategy-decision-log-pit-reconstruction-v6'].includes(matrixLabelerVersion)) {
    throw new Error(`strategy_redundancy_matrix_labeler_contract_invalid:${asOfDate}:${run.labeler_version ?? 'missing'}`)
  }
  if (String(run.reference_contract_version ?? '').trim() !== SELECTION_REFERENCE_CONTRACT_VERSION) {
    throw new Error(`strategy_redundancy_reference_contract_invalid:${asOfDate}:${run.reference_contract_version ?? 'missing'}`)
  }

  const matrix = await env.DB.prepare(`
    SELECT strategy_id, strategy_version, strategy_status, family_id,
           symbol, evaluable, strategy_hit, affinity,
           strategy_registry_checksum, labeler_version,
           reference_contract_version
      FROM strategy_label_matrix_v4
     WHERE signal_date=? AND producer_run_id=?
     ORDER BY strategy_id, symbol
  `).bind(asOfDate, run.producer_run_id).all<{
    strategy_id: string
    strategy_version: string
    strategy_status: string
    family_id: string
    symbol: string
    evaluable: number
    strategy_hit: number
    affinity: number
    strategy_registry_checksum: string
    labeler_version: string | null
    reference_contract_version: string | null
  }>()
  const rows = matrix.results ?? []
  if (rows.length !== expectedCells) {
    throw new Error(`strategy_redundancy_matrix_count_mismatch:${asOfDate}:${rows.length}/${expectedCells}`)
  }
  const checksums = new Set(rows.map((row) => String(row.strategy_registry_checksum ?? '').trim()).filter(Boolean))
  if (checksums.size !== 1 || !checksums.has(String(run.strategy_registry_checksum ?? '').trim())) {
    throw new Error(`strategy_redundancy_registry_checksum_mismatch:${asOfDate}`)
  }
  if (rows.some((row) => String(row.labeler_version ?? '').trim() !== matrixLabelerVersion)) {
    throw new Error(`strategy_redundancy_matrix_row_labeler_contract_invalid:${asOfDate}`)
  }
  if (rows.some((row) => String(row.reference_contract_version ?? '').trim() !== SELECTION_REFERENCE_CONTRACT_VERSION)) {
    throw new Error(`strategy_redundancy_matrix_row_reference_contract_invalid:${asOfDate}`)
  }

  const strategyRows = new Map<string, {
    family_id: string | null
    version: string
    status: string
    symbols: Set<string>
  }>()
  for (const row of rows) {
    const strategyId = String(row.strategy_id ?? '').trim()
    const version = String(row.strategy_version ?? '').trim()
    const familyId = String(row.family_id ?? '').trim() || null
    const status = String(row.strategy_status ?? '').trim()
    if (!strategyId || !version || !status) {
      throw new Error(`strategy_redundancy_matrix_identity_missing:${asOfDate}`)
    }
    const current = strategyRows.get(strategyId)
    if (current && (current.version !== version || current.family_id !== familyId || current.status !== status)) {
      throw new Error(`strategy_redundancy_matrix_identity_conflict:${asOfDate}:${strategyId}`)
    }
    const state = current ?? { family_id: familyId, version, status, symbols: new Set<string>() }
    if (Number(row.evaluable) === 1 && Number(row.strategy_hit) === 1 && Number(row.affinity) > 0) {
      const symbol = String(row.symbol ?? '').trim().toUpperCase()
      if (symbol) state.symbols.add(symbol)
    }
    strategyRows.set(strategyId, state)
  }
  if (strategyRows.size !== Number(run.strategy_count ?? 0)) {
    throw new Error(`strategy_redundancy_strategy_count_mismatch:${asOfDate}:${strategyRows.size}/${run.strategy_count}`)
  }

  const oofReturns = await loadMatureStrategyOofReturns(env.DB, asOfDate)
  const strategies = [...strategyRows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([strategyId, row]) => ({
      strategy_id: strategyId,
      family_id: row.family_id,
      symbols: [...row.symbols].sort(),
      oof_returns: oofReturns[strategyId] ?? [],
    }))
  const payload: StrategySimilarityEvidencePayload = {
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    strategies,
    edge_threshold: null,
    threshold_quantile: null,
    random_state: 0,
  }
  return {
    as_of_date: asOfDate,
    producer_run_id: run.producer_run_id,
    strategy_registry_checksum: run.strategy_registry_checksum,
    matrix_rows: rows.length,
    strategy_count: strategies.length,
    oof_strategy_count: strategies.filter((row) => row.oof_returns.length > 0).length,
    payload,
  }
}

export async function rebuildStrategyRedundancyArtifactForDate(env: Bindings, asOfDate: string) {
  const prepared = await prepareStrategyRedundancyBackfill(env, asOfDate)
  const result = await loadL125StrategySimilarityGraphEvidence(env, prepared.payload, asOfDate)
  if (!['modal_python', 'pending_maturity'].includes(result.status) || !result.artifact_id) {
    throw new Error(`strategy_redundancy_artifact_not_ready:${asOfDate}:${result.status}:${result.error ?? 'unknown'}`)
  }
  return {
    ...prepared,
    payload: undefined,
    status: result.status === 'modal_python' ? 'ready' : 'pending_maturity',
    artifact_id: result.artifact_id,
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.min(D1_IN_CHUNK_SIZE, Math.floor(size || D1_IN_CHUNK_SIZE)))
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize))
  }
  return chunks
}

async function loadRestrictedScreenerSymbols(env: Bindings, runDate: string): Promise<{
  hardBlockedSymbols: Set<string>
  riskEvidenceSymbols: Set<string>
  sourceCounts: Record<string, number>
}> {
  const restricted = await loadTradingRestrictionBuckets(env, runDate, {
    refreshOfficialIfStale: true,
    refreshTtlMs: 12 * 60 * 60_000,
  })
  await env.KV.put(
    `market:trading_restrictions:summary:${runDate}`,
    JSON.stringify({
      count: restricted.riskEvidenceSymbols.size,
      hard_block_count: restricted.hardBlockedSymbols.size,
      risk_evidence_count: [...restricted.riskEvidenceSymbols].filter((symbol) => !restricted.hardBlockedSymbols.has(symbol)).length,
      source_counts: restricted.sourceCounts,
      hard_source_counts: restricted.hardSourceCounts,
      freshness: restricted.freshness,
      generated_at: new Date().toISOString(),
    }),
    { expirationTtl: 7 * 86400 },
  ).catch(() => {})
  return {
    hardBlockedSymbols: restricted.hardBlockedSymbols,
    riskEvidenceSymbols: restricted.riskEvidenceSymbols,
    sourceCounts: restricted.sourceCounts,
  }
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

export async function loadPreviousCanonicalL15Slate(
  db: D1Database,
  endDate: string,
): Promise<{ date: string | null; runId: string | null; symbols: string[] }> {
  const { results } = await db.prepare(`
    WITH previous_run AS (
      SELECT r.run_id, r.date
        FROM screener_funnel_runs r
       WHERE r.date < ?
         AND r.status = 'success'
         AND EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.run_id = r.run_id)
       ORDER BY r.date DESC, r.created_at DESC
       LIMIT 1
    )
    SELECT p.date, p.run_id, i.symbol
      FROM previous_run p
      JOIN screener_funnel_items i ON i.run_id = p.run_id
     WHERE i.stage = 'l1_candidate_seed_after_overlay'
       AND i.decision IN ('selected', 'pass')
     GROUP BY p.date, p.run_id, i.symbol
     ORDER BY i.symbol
  `).bind(endDate).all<{ date: string; run_id: string; symbol: string }>()
  const rows = results ?? []
  return {
    date: rows[0]?.date ?? null,
    runId: rows[0]?.run_id ?? null,
    symbols: [...new Set(rows.map((row) => String(row.symbol ?? '').trim().toUpperCase()).filter(Boolean))],
  }
}

export async function loadMatureStrategyOofReturns(
  db: D1Database,
  asOfDate: string,
): Promise<Record<string, Array<{ signal_date: string; residual_return: number; sample_count: number }>>> {
  const { results } = await db.prepare(`
    WITH mature_dates AS (
      SELECT DISTINCT signal_date
        FROM canonical_selection_labels_v4
       WHERE outcome_known_date <= ?
         AND signal_date < ?
         AND label_schema_version = 'canonical-strategy-selection-label-v4'
       ORDER BY signal_date DESC
       LIMIT 60
    )
    SELECT m.strategy_id, m.signal_date,
           AVG(l.residual_return_net) residual_return,
           COUNT(*) sample_count
      FROM strategy_label_matrix_v4 m
      JOIN mature_dates d ON d.signal_date=m.signal_date
      JOIN canonical_selection_labels_v4 l
        ON l.signal_date=m.signal_date
       AND l.symbol=m.symbol
       AND l.producer_run_id=m.producer_run_id
       AND l.label_schema_version='canonical-strategy-selection-label-v4'
     WHERE m.evaluable=1
       AND m.strategy_hit=1
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.producer_run_id=m.producer_run_id AND mr.status='ready'
            AND mr.reference_contract_version=?
            AND mr.labeler_version IN ('strategy-labeler-v1', 'strategy-decision-log-pit-reconstruction-v6')
       )
       AND EXISTS (
         SELECT 1 FROM canonical_run_heads h
          WHERE h.logical_run_key='screener:' || m.signal_date || ':TW:production:market_screener'
            AND h.run_id=m.producer_run_id
       )
     GROUP BY m.strategy_id, m.signal_date
    HAVING COUNT(*) >= 3
     ORDER BY m.strategy_id, m.signal_date
  `).bind(asOfDate, asOfDate, SELECTION_REFERENCE_CONTRACT_VERSION).all<{
    strategy_id: string
    signal_date: string
    residual_return: number | string
    sample_count: number | string
  }>()
  const output: Record<string, Array<{ signal_date: string; residual_return: number; sample_count: number }>> = {}
  for (const row of results ?? []) {
    const strategyId = String(row.strategy_id ?? '').trim()
    const residualReturn = Number(row.residual_return)
    const sampleCount = Number(row.sample_count)
    if (!strategyId || !Number.isFinite(residualReturn) || !Number.isFinite(sampleCount)) continue
    output[strategyId] ??= []
    output[strategyId].push({
      signal_date: row.signal_date,
      residual_return: residualReturn,
      sample_count: Math.max(0, Math.floor(sampleCount)),
    })
  }
  return output
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
  asOfDate?: string,
): Promise<Array<{ symbol: string; tag: string; tag_type?: string }>> {
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  const safeChunkSize = Math.max(1, Math.min(D1_IN_CHUNK_SIZE, Math.floor(chunkSize || D1_IN_CHUNK_SIZE)))
  const rows: Array<{ symbol: string; tag: string; tag_type?: string }> = []
  const decisionDate = String(asOfDate ?? '').slice(0, 10)
  const finlabAsOfClause = decisionDate ? ' AND date(as_of_date) <= date(?)' : ''
  const stockTagsAsOfClause = decisionDate ? " AND datetime(updated_at) < datetime(?, '+1 day')" : ''

  for (let i = 0; i < uniqueSymbols.length; i += safeChunkSize) {
    const chunk = uniqueSymbols.slice(i, i + safeChunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const statement = db.prepare(
      `SELECT symbol, tag, tag_type
         FROM (
           SELECT symbol, tag, tag_type, weight, 1 AS priority
             FROM finlab_taxonomy_tags
            WHERE tag_type IN ('industry_theme', 'subindustry', 'industry')
              AND symbol IN (${placeholders})${finlabAsOfClause}
           UNION ALL
           SELECT symbol, tag, tag_type, weight, 2 AS priority
             FROM stock_tags
            WHERE tag_type='concept'
              AND symbol IN (${placeholders})${stockTagsAsOfClause}
         )
        ORDER BY symbol, priority ASC, weight DESC`
    )
    const params = decisionDate
      ? [...chunk, decisionDate, ...chunk, decisionDate]
      : [...chunk, ...chunk]
    const { results } = await statement.bind(...params).all<{ symbol: string; tag: string; tag_type?: string }>()
    rows.push(...(results ?? []))
  }

  return rows
}

async function materializeScreenerThemeRuntime(
  db: D1Database,
  date: string,
  symbols: string[],
): Promise<{ signals: number; tags: number; features: number }> {
  const tags = await queryTopConceptTagsForSymbols(db, symbols, 400, date) as FinLabTaxonomyTagRow[]
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
  asOfDate?: string,
): Promise<Map<string, SymbolTaxonomyProfile>> {
  const rows = await queryTopConceptTagsForSymbols(db, symbols, 400, asOfDate)
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
  const riskAdjustment = requestedDelta < 0 ? requestedDelta : 0
  if (riskAdjustment === 0) return 0
  const alphaAdjustment = round1((snapshot.alphaAdjustment ?? 0) + riskAdjustment)
  const payload = buildScoreV2Components({
    ...snapshot.components,
    newsTheme: snapshot.components.newsTheme,
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
  const appliedRankingDelta = round1(riskAdjustment)
  candidate.score = round1(candidate.score + appliedRankingDelta)
  return appliedRankingDelta
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
    selectionEvidence: {
      references: SelectionReferenceRowV1[]
      matrix: StrategyLabelMatrixRowV4[]
      strategyCount: number
      strategyRegistryChecksum: string
      labelerVersion: string
    }
  },
): Promise<void> {
  if (!env.ARTIFACTS && !env.EVIDENCE_ARTIFACT_WRITER) {
    throw new Error('screener_r2_artifact_transport_missing')
  }
  const artifactPayload = {
    metadata: input.metadata,
    debug_log: input.debugLog,
    items: input.items,
  }
  const inputFingerprint = await sha256Text(JSON.stringify({
    date: input.date,
    status: input.status,
    universe_count: input.universeCount,
    candidate_count: input.candidateCount,
    final_count: input.finalCount,
    emerging_count: input.emergingCount,
    payload: artifactPayload,
  }))
  const logicalRunKey = `screener:${input.date}:TW:production:market_screener`
  const artifact = await writeEvidenceArtifact(env, {
    domain: 'screener_funnel',
    businessDate: input.date,
    producerRunId: input.runId,
    retentionClass: input.status === 'success' ? 'canonical_model_evidence' : 'failed_debug',
    schemaVersion: 'screener-funnel-evidence-v3',
    payload: artifactPayload,
    rowCount: input.items.length,
    metadata: {
      status: input.status,
      universe_count: input.universeCount,
      candidate_count: input.candidateCount,
      final_count: input.finalCount,
    },
  })
  const registry = await registerPipelineRun(env.DB, {
    runId: input.runId,
    logicalRunKey,
    domain: 'screener',
    businessDate: input.date,
    stage: 'market_screener',
    status: input.status === 'success' ? 'writing' : 'failed',
    inputFingerprint,
    codeVersion: SCREENER_PIPELINE_CODE_VERSION,
    configVersion: String((input.metadata as any)?.config_version ?? 'runtime-config'),
  })
  if (registry.status === 'reused') {
    console.log(`[ScreenerFunnel] reused canonical run=${registry.reused_from_run_id} requested_run=${input.runId}`)
    return
  }
  const metadata = JSON.stringify(input.metadata)
  const debugLog = JSON.stringify(input.debugLog.slice(-80))
  const initialStatus = input.status === 'success' ? 'error' : input.status
  const initialDebugLog = input.status === 'success'
    ? JSON.stringify([...input.debugLog.slice(-79), 'funnel persistence pending item write completion'])
    : debugLog

  try {
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
      initialStatus,
      input.universeCount,
      input.candidateCount,
      input.finalCount,
      input.emergingCount,
      metadata,
      initialDebugLog,
    ).run()

    if (input.items.length) {
      const pipelineSeed = input.items.filter((item) => SCREENER_FUNNEL_PIPELINE_SEED_STAGES.has(item.stage))
      const auditCritical = input.items.filter((item) =>
        !SCREENER_FUNNEL_PIPELINE_SEED_STAGES.has(item.stage) &&
        SCREENER_FUNNEL_AUDIT_CRITICAL_STAGES.has(item.stage)
      )
      const nonCritical = input.items.filter((item) =>
        !SCREENER_FUNNEL_PIPELINE_SEED_STAGES.has(item.stage) &&
        !SCREENER_FUNNEL_AUDIT_CRITICAL_STAGES.has(item.stage)
      )
      const persistedItems = [
        ...pipelineSeed,
        ...auditCritical,
        ...nonCritical.slice(0, Math.max(0, SCREENER_FUNNEL_MAX_ITEMS - pipelineSeed.length - auditCritical.length)),
      ].slice(0, SCREENER_FUNNEL_MAX_ITEMS)
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

    await persistSelectionEvidenceV4(env.DB, {
      signalDate: input.date,
      producerRunId: input.runId,
      references: input.selectionEvidence.references,
      matrix: input.selectionEvidence.matrix,
      strategyCount: input.selectionEvidence.strategyCount,
      strategyRegistryChecksum: input.selectionEvidence.strategyRegistryChecksum,
      labelerVersion: input.selectionEvidence.labelerVersion,
      evidenceArtifactId: artifact.artifact_id,
    }, databaseForDataDomain(env, 'core'))

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
      metadata,
      debugLog,
    ).run()
    if (input.status === 'success') {
      await env.DB.prepare(`
        UPDATE pipeline_runs
           SET status='ready', artifact_id=?, updated_at=CURRENT_TIMESTAMP
         WHERE run_id=? AND status='writing'
      `).bind(artifact.artifact_id, input.runId).run()
      await promoteCanonicalRun(env.DB, logicalRunKey, input.runId, artifact.artifact_id)
    }
  } catch (error) {
    await env.DB.prepare(`
      INSERT INTO screener_funnel_runs
        (run_id, date, status, universe_count, candidate_count, final_count, emerging_count, metadata, debug_log)
      VALUES (?, ?, 'error', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status='error',
        universe_count=excluded.universe_count,
        candidate_count=excluded.candidate_count,
        final_count=excluded.final_count,
        emerging_count=excluded.emerging_count,
        metadata=excluded.metadata,
        debug_log=excluded.debug_log
    `).bind(
      input.runId,
      input.date,
      input.universeCount,
      input.candidateCount,
      input.finalCount,
      input.emergingCount,
      metadata,
      JSON.stringify([
        ...input.debugLog.slice(-79),
        `funnel persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    ).run().catch(() => {})
    await env.DB.prepare(`
      UPDATE pipeline_runs
         SET status='failed', error_code=?, updated_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), input.runId).run().catch(() => {})
    throw error
  }
}

export async function pruneScreenerSeedRows(
  db: D1Database,
  date: string,
  symbols: string[],
): Promise<number> {
  const keep = new Set(symbols.map(symbol => String(symbol || '').trim()).filter(Boolean))
  if (!keep.size) {
    const result = await db.prepare('DELETE FROM daily_recommendations WHERE date = ?').bind(date).run()
    return Number(result.meta?.changes ?? result.meta?.rows_written ?? 0)
  }

  const { results } = await db.prepare(
    'SELECT symbol FROM daily_recommendations WHERE date = ?',
  ).bind(date).all<{ symbol: string }>()
  const stale = (results ?? [])
    .map(row => String(row.symbol || '').trim())
    .filter(symbol => symbol && !keep.has(symbol))
  let deleted = 0
  for (const chunk of chunkArray(stale, D1_IN_CHUNK_SIZE)) {
    const batch = chunk.map(symbol => db.prepare(
      'DELETE FROM daily_recommendations WHERE date = ? AND symbol = ?',
    ).bind(date, symbol))
    const batchResults = await db.batch(batch)
    deleted += batchResults.reduce(
      (sum, result) => sum + Number(result.meta?.changes ?? result.meta?.rows_written ?? 0),
      0,
    )
  }
  return deleted
}

/** Clamp value to [min, max] */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** 撠?憪潛???normalize ??[0, maxScore] */
function normalize(value: number, lower: number, upper: number, maxScore: number): number {
  if (upper === lower) return maxScore / 2
  return clamp(((value - lower) / (upper - lower)) * maxScore, 0, maxScore)
}

function interpolateClamped(value: number, lower: number, upper: number, lowerScore: number, upperScore: number): number {
  if (!Number.isFinite(value)) return 0
  if (upper === lower) return (lowerScore + upperScore) / 2
  const t = clamp((value - lower) / (upper - lower), 0, 1)
  return lowerScore + (upperScore - lowerScore) * t
}

function scoreInstitutionalChipIntensity(intensity: number): number {
  if (!Number.isFinite(intensity)) return 0
  const centered = 15 + Math.tanh(intensity / 0.65) * 15
  const participationBonus = intensity > 0 ? clamp(Math.sqrt(Math.max(0, intensity)) * 2, 0, 2) : 0
  return round1(clamp(centered + participationBonus, 0, 32))
}

function scoreRsiTrendQuality(rsi: number): number {
  if (!Number.isFinite(rsi)) return 0
  let score = 0
  if (rsi < 30) score = interpolateClamped(rsi, 15, 30, 0, 2)
  else if (rsi < 45) score = interpolateClamped(rsi, 30, 45, 2, 5)
  else if (rsi < 55) score = interpolateClamped(rsi, 45, 55, 5, 7)
  else if (rsi <= 65) score = interpolateClamped(rsi, 55, 65, 7, 10)
  else if (rsi <= 72) score = interpolateClamped(rsi, 65, 72, 10, 6)
  else if (rsi <= 80) score = interpolateClamped(rsi, 72, 80, 6, 2)
  else score = interpolateClamped(rsi, 80, 95, 2, 0)
  return round1(clamp(score, 0, 10))
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0 || period <= 0) return []
  const alpha = 2 / (period + 1)
  const out: number[] = []
  let ema = values[0]
  out.push(ema)
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * alpha + ema * (1 - alpha)
    out.push(ema)
  }
  return out
}

function macdHistogramLast(closes: number[]): number | null {
  if (closes.length < 35) return null
  const ema12 = emaSeries(closes, 12)
  const ema26 = emaSeries(closes, 26)
  const macdLine = closes.map((_, idx) => ema12[idx] - ema26[idx])
  const signal = emaSeries(macdLine, 9)
  if (!signal.length) return null
  return macdLine[macdLine.length - 1] - signal[signal.length - 1]
}

// ??? Sector mapping ??????????????????????????????????????????????????????????

interface SectorMap {
  [stockId: string]: { name: string; sector: string; market?: string }
}

/**
 * 敺?D1 stocks 銵典?撌脫???sector mapping??
 * Sector 甈???canonical stock metadata / official TWSE/TPEX refresh 撖怠??
 * 蝯?敹怠???KV嚗??勗?唬?甈∴???
 */
async function getSectorMapping(env: Bindings): Promise<SectorMap> {
  // ? KV 敹怠?
  const cacheKey = 'screener:sector-map'
  const cached = await env.KV.get(cacheKey, 'json') as SectorMap | null
  if (cached) return cached

  // D1 stocks 銵剁?sector 撌脩 TWSE opendata ??screener ????憛怠嚗?
  const { results: dbStocks } = await env.DB.prepare(
    "SELECT symbol, name, sector, market FROM stocks WHERE sector IS NOT NULL AND sector != ''"
  ).all<{ symbol: string; name: string; sector: string; market?: string }>()
  const map: SectorMap = {}
  for (const s of dbStocks ?? []) {
    map[s.symbol] = { name: s.name, sector: s.sector, market: s.market }
  }

  // 敹怠? 7 憭?
  await env.KV.put(cacheKey, JSON.stringify(map), { expirationTtl: 7 * 86400 })
  return map
}

// ??? Stage 1: Sector Heat Detection ?????????????????????????????????????????

interface ChipDayNet {
  foreign: number
  trust: number
  dealer?: number
  brokerFlow?: number
  marginBalance?: number | null
  shortBalance?: number | null
  marginPrevBalance?: number | null
  marginLimit?: number | null
  marginUsageRatio?: number | null
  shortBuy?: number | null
  shortSell?: number | null
  shortStockRepayment?: number | null
  shortPrevBalance?: number | null
  shortLimit?: number | null
  shortUsageRatio?: number | null
  securityLendingBorrow?: number | null
  securityLendingReturn?: number | null
  securityLendingDelta?: number | null
  securityLendingBalance?: number | null
  securityLendingSell?: number | null
  securityLendingSellReturn?: number | null
  securityLendingSellBalance?: number | null
  securityLendingSellLimit?: number | null
  source?: string
  marketSegment?: string
  brokerCount?: number | null
  estimatedAmount?: number | null
  concentration?: number | null
}

interface StockDailyData {
  prices: Map<string, CanonicalScreenerPrice[]>   // stockId ??sorted prices
  chips: Map<string, Map<string, ChipDayNet>>  // stockId ??date ??net
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
  operatingCashFlow?: number | null
  roa?: number | null
  ebitda?: number | null
  freeCashFlow?: number | null
  financialCost?: number | null
  operatingExpenses?: number | null
  cashFlowPerShare?: number | null
  pretaxIncomePerShare?: number | null
  propertyPlantEquipment?: number | null
  workingCapital?: number | null
  currentLiabilities?: number | null
  operatingCashFlowStatement?: number | null
  nonCurrentAssets?: number | null
  cashAndCashEquivalentsIncreaseDecrease?: number | null
  otherPayables?: number | null
  capitalAmount?: number | null
  source?: string | null
}

interface StrategyRawFactorSignalPatch {
  factorSignals?: Record<string, number | null>
  source?: string | null
}

interface StrategyRawSignals extends StrategyRawFundamentalSignals {
  close?: number | null
  ma20?: number | null
  ma60?: number | null
  ma10Bias?: number | null
  closeAboveMa20Pct?: number | null
  closeAboveMa60Pct?: number | null
  KLOW2?: number | null
  KSFT?: number | null
  KSFT2?: number | null
  CNTD_20?: number | null
  CNTN_20?: number | null
  VSTD_10?: number | null
  techEmv14?: number | null
  techRoc10?: number | null
  techGapDown?: number | null
  volaCv90d?: number | null
  bestOrderBlockStrength?: number | null
  bbBandwidthPct?: number | null
  vwapBias?: number | null
  vwap5d?: number | null
  vwapBias5d?: number | null
  return5d?: number | null
  volumeExpansion20?: number | null
  return20d?: number | null
  return60d?: number | null
  volShareTurnover21d?: number | null
  foreignNet5d?: number | null
  trustNet5d?: number | null
  dealerNet5d?: number | null
  foreignTrustNet5d?: number | null
  brokerNetShares5d?: number | null
  brokerNetAmount5d?: number | null
  marginBalance?: number | null
  shortBalance?: number | null
  brokerCount?: number | null
  brokerConcentration?: number | null
  technicalIndicators?: Record<string, number | null>
  factorSignals?: Record<string, number | null>
}

const RAW_FUNDAMENTAL_FIELDS = [
  ['revenueGrowthYoY', 'revenue_growth_yoy'],
  ['grossMargin', 'gross_margin'],
  ['operatingMargin', 'operating_margin'],
  ['roe', 'roe'],
  ['eps', 'eps'],
  ['pe', 'pe'],
  ['pb', 'pb'],
  ['dividendYield', 'dividend_yield'],
  ['operatingCashFlow', 'operating_cash_flow'],
  ['roa', 'roa'],
  ['ebitda', 'ebitda'],
  ['freeCashFlow', 'free_cash_flow'],
  ['financialCost', 'financial_cost'],
  ['operatingExpenses', 'operating_expenses'],
  ['cashFlowPerShare', 'cash_flow_per_share'],
  ['pretaxIncomePerShare', 'pretax_income_per_share'],
  ['propertyPlantEquipment', 'property_plant_equipment'],
  ['workingCapital', 'working_capital'],
  ['currentLiabilities', 'current_liabilities'],
  ['operatingCashFlowStatement', 'operating_cash_flow_statement'],
  ['nonCurrentAssets', 'non_current_assets'],
  ['cashAndCashEquivalentsIncreaseDecrease', 'cash_and_cash_equivalents_increase_decrease'],
  ['otherPayables', 'other_payables'],
  ['capitalAmount', 'capital_amount'],
] as const

type RawFundamentalSignalField = typeof RAW_FUNDAMENTAL_FIELDS[number][0]
type RawFundamentalColumn = typeof RAW_FUNDAMENTAL_FIELDS[number][1]

interface StrategyRawFundamentalLoadTelemetry {
  requestedSymbols: number
  symbolsWithAnyFundamental: number
  canonicalRowsScanned: number
  canonicalSymbols: number
  canonicalErrors: string[]
  revenueRows: number
  revenueSymbols: number
  revenueErrors: string[]
  fieldCoverage: Record<RawFundamentalSignalField, number>
  sourceCoverage: Record<string, number>
}

interface StrategyRawFundamentalLoadResult {
  fundamentals: Map<string, StrategyRawFundamentalSignals>
  telemetry: StrategyRawFundamentalLoadTelemetry
}

interface FinLabStyleFactorNormalizationTelemetry {
  method: 'finlab_style_cs_sector_rank_zscore_winsor_sector_neutral_v2'
  universeCount: number
  sectorCount: number
  fieldCoverage: Record<string, number>
  sectorFieldCoverage: Record<string, number>
  compositeCoverage: Record<string, number>
  allocationCoverage: Record<string, number>
  specialFeatureMaterialization: {
    featureAliases: Formal137FeatureAliasMaterializationTelemetry
    usSentimentScore: Formal137UsSentimentMaterializationTelemetry
  }
}

function buildStockData(
  allPrices: CanonicalScreenerPrice[],
  allChips: CanonicalScreenerChip[],
): StockDailyData {
  // Group prices by stock_id, sorted by date
  const prices = new Map<string, CanonicalScreenerPrice[]>()
  for (const p of allPrices) {
    if (!prices.has(p.stock_id)) prices.set(p.stock_id, [])
    prices.get(p.stock_id)!.push(p)
  }
  for (const arr of prices.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date))
  }

  // Group chips by stock_id/date. V4.1 keeps listed/OTC institution nets and
  // emerging broker-flow evidence in the same scoring lane, while preserving source metadata.
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
    if (chipName.includes('broker_flow')) {
      entry.brokerFlow = (entry.brokerFlow ?? 0) + net
    }
    if (chipName.includes('margin_balance')) {
      entry.marginBalance = c.margin_balance ?? net
      entry.shortBalance = c.short_balance ?? entry.shortBalance ?? null
      entry.marginPrevBalance = c.margin_prev_balance ?? entry.marginPrevBalance ?? null
      entry.marginLimit = c.margin_limit ?? entry.marginLimit ?? null
      entry.marginUsageRatio = c.margin_usage_ratio ?? entry.marginUsageRatio ?? null
      entry.shortBuy = c.short_buy ?? entry.shortBuy ?? null
      entry.shortSell = c.short_sell ?? entry.shortSell ?? null
      entry.shortStockRepayment = c.short_stock_repayment ?? entry.shortStockRepayment ?? null
      entry.shortPrevBalance = c.short_prev_balance ?? entry.shortPrevBalance ?? null
      entry.shortLimit = c.short_limit ?? entry.shortLimit ?? null
      entry.shortUsageRatio = c.short_usage_ratio ?? entry.shortUsageRatio ?? null
      entry.securityLendingBorrow = c.security_lending_borrow ?? entry.securityLendingBorrow ?? null
      entry.securityLendingReturn = c.security_lending_return ?? entry.securityLendingReturn ?? null
      entry.securityLendingDelta = c.security_lending_delta ?? entry.securityLendingDelta ?? null
      entry.securityLendingBalance = c.security_lending_balance ?? entry.securityLendingBalance ?? null
      entry.securityLendingSell = c.security_lending_sell ?? entry.securityLendingSell ?? null
      entry.securityLendingSellReturn = c.security_lending_sell_return ?? entry.securityLendingSellReturn ?? null
      entry.securityLendingSellBalance = c.security_lending_sell_balance ?? entry.securityLendingSellBalance ?? null
      entry.securityLendingSellLimit = c.security_lending_sell_limit ?? entry.securityLendingSellLimit ?? null
    }
    if (c.name.includes('憭?')) entry.foreign += net
    if (c.name.includes('?縑')) entry.trust += net
    entry.source = c.source ?? entry.source
    entry.marketSegment = c.market_segment ?? entry.marketSegment
    entry.brokerCount = c.broker_count ?? entry.brokerCount ?? null
    entry.estimatedAmount = c.estimated_amount ?? entry.estimatedAmount ?? null
    entry.concentration = c.concentration ?? entry.concentration ?? null
  }

  return { prices, chips }
}

/**
 * 閮?憭抒 5 ?亙?祉?嚗????撣撟喳?嚗?
 * ?ㄐ?典撣蝑?撟喳?餈撮
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

function stddev(values: number[]): number | null {
  const clean = values.filter(Number.isFinite)
  if (clean.length < 2) return null
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length
  return Math.sqrt(Math.max(0, variance))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function emptyRawFundamentalCoverage(): Record<RawFundamentalSignalField, number> {
  return RAW_FUNDAMENTAL_FIELDS.reduce((acc, [field]) => {
    acc[field] = 0
    return acc
  }, {} as Record<RawFundamentalSignalField, number>)
}

function createRawFundamentalTelemetry(requestedSymbols: number): StrategyRawFundamentalLoadTelemetry {
  return {
    requestedSymbols,
    symbolsWithAnyFundamental: 0,
    canonicalRowsScanned: 0,
    canonicalSymbols: 0,
    canonicalErrors: [],
    revenueRows: 0,
    revenueSymbols: 0,
    revenueErrors: [],
    fieldCoverage: emptyRawFundamentalCoverage(),
    sourceCoverage: {},
  }
}

function finalizeRawFundamentalTelemetry(
  fundamentals: Map<string, StrategyRawFundamentalSignals>,
  telemetry: StrategyRawFundamentalLoadTelemetry,
): StrategyRawFundamentalLoadTelemetry {
  const fieldCoverage = emptyRawFundamentalCoverage()
  const sourceCoverage: Record<string, number> = {}
  const canonicalSymbols = new Set<string>()
  const revenueSymbols = new Set<string>()
  for (const [symbol, signals] of fundamentals.entries()) {
    for (const [field] of RAW_FUNDAMENTAL_FIELDS) {
      if (signals[field] != null) fieldCoverage[field] += 1
    }
    const sources = String(signals.source ?? '').split('+').map((value) => value.trim()).filter(Boolean)
    for (const source of sources) {
      sourceCoverage[source] = (sourceCoverage[source] ?? 0) + 1
      if (source === 'finlab.fundamental_features') canonicalSymbols.add(symbol)
      if (source === 'finlab.monthly_revenue') revenueSymbols.add(symbol)
    }
  }
  return {
    ...telemetry,
    symbolsWithAnyFundamental: fundamentals.size,
    canonicalSymbols: canonicalSymbols.size,
    revenueSymbols: revenueSymbols.size,
    fieldCoverage,
    sourceCoverage,
  }
}

async function loadStrategyRawFundamentalSignals(
  env: Bindings,
  symbols: string[],
  endDate: string,
): Promise<StrategyRawFundamentalLoadResult> {
  const fundamentals = new Map<string, StrategyRawFundamentalSignals>()
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  const telemetry = createRawFundamentalTelemetry(uniqueSymbols.length)
  if (!uniqueSymbols.length) return { fundamentals, telemetry }
  const revenueMonth = endDate.slice(0, 7)

  for (const chunk of chunkArray(uniqueSymbols, D1_IN_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(',')
    const canonicalColumns = RAW_FUNDAMENTAL_FIELDS.map(([, column]) => column).join(', ')
    const nonNullPredicate = RAW_FUNDAMENTAL_FIELDS.map(([, column]) => `${column} IS NOT NULL`).join(' OR ')
    try {
      const { results } = await env.DB.prepare(`
        SELECT stock_id AS symbol,
               available_date,
               period,
               ${canonicalColumns}
          FROM canonical_fundamental_features
         WHERE stock_id IN (${placeholders})
           AND available_date <= ?
           AND as_of_date <= ?
           AND source IN ('finlab.fundamental_factor_diversity', 'finlab.daily_valuation')
           AND (${nonNullPredicate})
         ORDER BY stock_id, available_date DESC, period DESC
      `).bind(...chunk, endDate, endDate).all<{
        symbol: string
        available_date: string | null
        period: string | null
        revenue_growth_yoy: number | null
        gross_margin: number | null
        operating_margin: number | null
        roe: number | null
        eps: number | null
        pe: number | null
        pb: number | null
        dividend_yield: number | null
        operating_cash_flow: number | null
        roa: number | null
        ebitda: number | null
        free_cash_flow: number | null
        financial_cost: number | null
        operating_expenses: number | null
        cash_flow_per_share: number | null
        pretax_income_per_share: number | null
        property_plant_equipment: number | null
        working_capital: number | null
        current_liabilities: number | null
        operating_cash_flow_statement: number | null
        non_current_assets: number | null
        cash_and_cash_equivalents_increase_decrease: number | null
        other_payables: number | null
        capital_amount: number | null
      }>()
      telemetry.canonicalRowsScanned += (results ?? []).length
      for (const row of results ?? []) {
        const patch: StrategyRawFundamentalSignals = { source: 'finlab.fundamental_features' }
        const rowRecord = row as Record<RawFundamentalColumn, unknown>
        for (const [field, column] of RAW_FUNDAMENTAL_FIELDS) {
          const value = finiteOrNull(rowRecord[column])
          if (value != null) {
            ;(patch as Record<RawFundamentalSignalField, number | null>)[field] = value
          }
        }
        mergeFundamentalSignals(fundamentals, row.symbol, patch)
      }
    } catch (error) {
      telemetry.canonicalErrors.push(`canonical_fundamental_features:${errorText(error)}`)
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
      telemetry.revenueRows += (results ?? []).length
      for (const row of results ?? []) {
        mergeFundamentalSignals(fundamentals, row.symbol, {
          monthlyRevenueYoY: finiteOrNull(row.yoy),
          monthlyRevenueMoM: finiteOrNull(row.mom),
          source: 'finlab.monthly_revenue',
        })
      }
    } catch (error) {
      telemetry.revenueErrors.push(`canonical_revenue_monthly:${errorText(error)}`)
    }
  }

  return { fundamentals, telemetry: finalizeRawFundamentalTelemetry(fundamentals, telemetry) }
}

async function loadStrategyRawSectorRotationSignals(
  env: Bindings,
  symbols: string[],
  endDate: string,
): Promise<Map<string, StrategyRawFactorSignalPatch>> {
  const out = new Map<string, StrategyRawFactorSignalPatch>()
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  if (!uniqueSymbols.length) return out

  const mergePatch = (symbol: string, source: string, factorSignals: Record<string, number | null>) => {
    const existing = out.get(symbol)
    out.set(symbol, {
      source: [existing?.source, source].filter(Boolean).join('+') || null,
      factorSignals: {
        ...(existing?.factorSignals ?? {}),
        ...factorSignals,
      },
    })
  }

  let advanceRatio: number | null = null
  try {
    const row = await env.DB.prepare(
      'SELECT advance_ratio FROM market_breadth WHERE date <= ? ORDER BY date DESC LIMIT 1',
    ).bind(endDate).first<{ advance_ratio: number | null }>()
    advanceRatio = finiteOrNull(row?.advance_ratio)
  } catch {
    advanceRatio = null
  }

  let usSentimentScore: number | null = null
  try {
    const row = await env.DB.prepare(
      'SELECT sentiment FROM us_market_signals WHERE date <= ? ORDER BY date DESC LIMIT 1',
    ).bind(endDate).first<{ sentiment: string | null }>()
    const sentiment = String(row?.sentiment ?? '').toLowerCase()
    usSentimentScore = sentiment === 'bullish' ? 1 : sentiment === 'bearish' ? 0 : sentiment === 'neutral' ? 0.5 : null
  } catch {
    usSentimentScore = null
  }

  if (advanceRatio != null || usSentimentScore != null) {
    for (const symbol of uniqueSymbols) {
      mergePatch(symbol, 'market_breadth+us_market_signals', {
        advance_ratio: advanceRatio,
        advanceRatio,
        us_sentiment_score: usSentimentScore,
        usSentimentScore,
      })
    }
  }

  for (const chunk of chunkArray(uniqueSymbols, D1_IN_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(',')
    try {
      const { results } = await env.DB.prepare(`
        SELECT s.symbol,
               MAX(COALESCE(s.net_amount, 0)) AS sector_net_amount,
               MAX(CASE WHEN s.classification = 'top' THEN 1 ELSE 0 END) AS sector_flow_core,
               MAX(COALESCE(s.volume_ratio, 0)) AS sector_volume_ratio,
               MAX(COALESCE(f.rs_ratio, 0)) AS sector_rs_ratio,
               MAX(COALESCE(f.rs_momentum, -999)) AS sector_rs_momentum,
               MAX(COALESCE(f.turnover_share_delta, -999)) AS sector_turnover_share_delta
          FROM sector_flow_stocks s
          LEFT JOIN sector_flow f
            ON f.date = s.date
           AND f.sector = s.theme
           AND f.classification IN ('theme', 'industry_theme', 'industry', 'subindustry')
         WHERE s.symbol IN (${placeholders})
           AND s.date = (
             SELECT MAX(date)
               FROM sector_flow_stocks
              WHERE date <= ?
           )
         GROUP BY s.symbol
      `).bind(...chunk, endDate).all<{
        symbol: string
        sector_net_amount: number | null
        sector_flow_core: number | null
        sector_volume_ratio: number | null
        sector_rs_ratio: number | null
        sector_rs_momentum: number | null
        sector_turnover_share_delta: number | null
      }>()
      for (const row of results ?? []) {
        mergePatch(row.symbol, 'sector_flow_stocks+sector_flow', {
          sectorNetAmount: finiteOrNull(row.sector_net_amount),
          sectorFlowCore: finiteOrNull(row.sector_flow_core),
          sectorVolumeRatio: finiteOrNull(row.sector_volume_ratio),
          sectorRsRatio: finiteOrNull(row.sector_rs_ratio),
          sectorRsMomentum: finiteOrNull(row.sector_rs_momentum),
          sectorTurnoverShareDelta: finiteOrNull(row.sector_turnover_share_delta),
        })
      }
    } catch {
      // Older local D1 snapshots may not have sector_flow_stocks yet.
    }
  }
  return out
}

function deriveStrategyRawSignals(
  prices: CanonicalScreenerPrice[],
  chipDates: Map<string, ChipDayNet> | undefined,
  fundamentals?: StrategyRawFundamentalSignals,
  extraFactors?: StrategyRawFactorSignalPatch,
  stockTechnicalPrices?: CanonicalScreenerPrice[],
): StrategyRawSignals {
  const latest = prices[prices.length - 1]
  const indicatorRows = prices
    .map((price) => ({
      date: price.date,
      open: finiteOrNull(price.open),
      high: finiteOrNull(price.max),
      low: finiteOrNull(price.min),
      close: finiteOrNull(price.close),
      volume: finiteOrNull(price.Trading_Volume) ?? 0,
    }))
    .filter((row): row is { date: string; open: number; high: number; low: number; close: number; volume: number } =>
      row.open != null && row.high != null && row.low != null && row.close != null && row.high >= row.low,
    )
  const closes = indicatorRows.map((row) => row.close)
  const highs = indicatorRows.map((row) => row.high)
  const lows = indicatorRows.map((row) => row.low)
  const volumes = indicatorRows.map((row) => row.volume)
  const close = latest ? finiteOrNull(latest.close) : null
  const ma20 = avg(closes.slice(-20))
  const ma60 = avg(closes.slice(-60))
  const ma10 = avg(closes.slice(-10))
  const avgVol5 = avg(volumes.slice(-5))
  const avgVol20 = avg(volumes.slice(-20))
  const vstd10 = stddev(volumes.slice(-10))
  const sharesOutstanding = fundamentals?.capitalAmount != null && fundamentals.capitalAmount > 0
    ? fundamentals.capitalAmount / 10
    : null
  const volShareTurnover21d = avgVol20 != null && sharesOutstanding != null && sharesOutstanding > 0
    ? avgVol20 / sharesOutstanding
    : null
  const latestIndex = closes.length - 1
  const ma10Bias = pctChange(close, ma10)
  const closeAboveMa20Pct = pctChange(close, ma20)
  const closeAboveMa60Pct = pctChange(close, ma60)
  const volumeExpansion20 = avgVol5 != null && avgVol20 != null && avgVol20 > 0 ? avgVol5 / avgVol20 : null
  const return5d = latestIndex >= 5 ? pctChange(closes[latestIndex], closes[latestIndex - 5]) : null
  const techRoc10 = latestIndex >= 10 ? pctChange(closes[latestIndex], closes[latestIndex - 10]) : null
  const return20d = latestIndex >= 20 ? pctChange(closes[latestIndex], closes[latestIndex - 20]) : null
  const return60d = latestIndex >= 60 ? pctChange(closes[latestIndex], closes[latestIndex - 60]) : null
  const latestOhlcv = indicatorRows[latestIndex]
  const previousOhlcv = latestIndex >= 1 ? indicatorRows[latestIndex - 1] : null
  const techGapDown = latestOhlcv && previousOhlcv ? (latestOhlcv.high < previousOhlcv.low ? 1 : 0) : null
  const latestTypicalPrice = latestOhlcv ? (latestOhlcv.high + latestOhlcv.low + latestOhlcv.close) / 3 : null
  const vwapBias = pctChange(close, latestTypicalPrice)
  const vwapRows5d = indicatorRows.slice(-5)
  const vwap5dDenominator = vwapRows5d.reduce((sum, row) => sum + Math.max(0, row.volume), 0)
  const vwap5d = vwapRows5d.length >= 5 && vwap5dDenominator > 0
    ? vwapRows5d.reduce((sum, row) => sum + (((row.high + row.low + row.close) / 3) * Math.max(0, row.volume)), 0) / vwap5dDenominator
    : null
  const vwapBias5d = pctChange(close, vwap5d)
  const last90Closes = closes.slice(-90)
  const volaCv90dMean = last90Closes.length >= 90 ? avg(last90Closes) : null
  const volaCv90d = volaCv90dMean != null && volaCv90dMean > 0 ? (stddev(last90Closes) ?? 0) / volaCv90dMean : null
  const latestRange = latestOhlcv ? Math.max(1e-8, latestOhlcv.high - latestOhlcv.low) : null
  const latestOpen = latestOhlcv?.open ?? null
  const kLow2 = latestOhlcv && latestRange != null
    ? clamp((Math.min(latestOhlcv.open, latestOhlcv.close) - latestOhlcv.low) / latestRange, 0, 1)
    : null
  const kSft = latestOhlcv && latestOpen != null && Math.abs(latestOpen) > 1e-8
    ? clamp((2 * latestOhlcv.close - latestOhlcv.high - latestOhlcv.low) / latestOpen, -0.2, 0.2)
    : null
  const kSft2 = latestOhlcv && latestRange != null
    ? clamp((2 * latestOhlcv.close - latestOhlcv.high - latestOhlcv.low) / latestRange, -1, 1)
    : null
  const last20Closes = closes.slice(-21)
  const cntp20 = last20Closes.length >= 21
    ? last20Closes.slice(1).filter((value, idx) => value > last20Closes[idx]).length / 20
    : null
  const cntn20 = last20Closes.length >= 21
    ? last20Closes.slice(1).filter((value, idx) => value < last20Closes[idx]).length / 20
    : null
  const cntd20 = cntp20 != null && cntn20 != null ? cntp20 - cntn20 : null
  const technicals = computeTechnicalIndicators(closes, highs, lows, volumes)
  const latestRsi14 = technicals.rsi14 ?? rsi14(closes)
  const bbBandwidthPct = technicals.bbUpper != null && technicals.bbLower != null && technicals.bbMid != null && technicals.bbMid > 0
    ? (technicals.bbUpper - technicals.bbLower) / technicals.bbMid
    : null
  const bbPctB = close != null && technicals.bbUpper != null && technicals.bbLower != null && technicals.bbUpper > technicals.bbLower
    ? (close - technicals.bbLower) / (technicals.bbUpper - technicals.bbLower)
    : null
  const diTrend = technicals.plusDi14 != null && technicals.minusDi14 != null
    ? technicals.plusDi14 - technicals.minusDi14
    : null
  const emvValues: number[] = []
  for (let i = Math.max(1, indicatorRows.length - 14); i < indicatorRows.length; i++) {
    const current = indicatorRows[i]
    const previous = indicatorRows[i - 1]
    const range = current.high - current.low
    if (range <= 0 || current.volume <= 0) continue
    const midpointMove = ((current.high + current.low) / 2) - ((previous.high + previous.low) / 2)
    const boxRatio = current.volume / range
    if (boxRatio > 0) emvValues.push(midpointMove / boxRatio)
  }
  const emv14 = avg(emvValues)
  const ohlcvRows = indicatorRows.map((row) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }))
  const stockTechnicalIndicatorRows = (stockTechnicalPrices?.length ? stockTechnicalPrices : prices)
    .map((price) => ({
      date: price.date,
      open: finiteOrNull(price.open),
      high: finiteOrNull(price.max),
      low: finiteOrNull(price.min),
      close: finiteOrNull(price.close),
      volume: finiteOrNull(price.Trading_Volume) ?? 0,
    }))
    .filter((row): row is { date: string; open: number; high: number; low: number; close: number; volume: number } =>
      row.open != null && row.high != null && row.low != null && row.close != null && row.high >= row.low,
    )
  const stockTechnicalOhlcvRows = stockTechnicalIndicatorRows.map((row) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }))
  const stockTechnicalDailyFeatures = deriveStockTechnicalDailyFeatures(stockTechnicalOhlcvRows)
  const priceAction = ohlcvRows.length >= 5 ? buildPriceActionStructure(ohlcvRows, { latestPrice: close }) : null
  const bestFvg = priceAction?.bestFvg ?? null
  const bestOrderBlock = priceAction?.bestOrderBlock ?? null
  const bestOrderBlockStrength = priceAction ? bestOrderBlock?.strength ?? 0 : null
  const smc = priceAction?.smc ?? null
  const displacementPct = smc?.bullishDisplacement?.displacementPct ?? 0
  const bosBullish = smc?.bullishBos ? 1 : 0
  const liquiditySweepBullish = smc?.bullishLiquiditySweep ? 1 : 0
  const chochBullish = smc?.bullishChoch ? 1 : 0
  const chipRows = [...(chipDates?.entries() ?? [])]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-5)
    .map(([, value]) => value)
  const foreignNet5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.foreign) ?? 0), 0)
  const trustNet5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.trust) ?? 0), 0)
  const dealerNet5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.dealer) ?? 0), 0)
  const brokerNetShares5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.brokerFlow) ?? 0), 0)
  const brokerNetAmount5d = chipRows.reduce((sum, row) => sum + (finiteOrNull(row.estimatedAmount) ?? 0), 0)
  const latestBroker = [...chipRows].reverse().find((row) => row.brokerCount != null || row.concentration != null)
  const latestMargin = [...chipRows].reverse().find((row) => row.marginBalance != null || row.shortBalance != null)
  const base: StrategyRawSignals = {
    close,
    ma10Bias,
    ma20,
    ma60,
    closeAboveMa20Pct,
    closeAboveMa60Pct,
    KLOW2: kLow2,
    KSFT: kSft,
    KSFT2: kSft2,
    CNTD_20: cntd20,
    CNTN_20: cntn20,
    VSTD_10: vstd10,
    techEmv14: emv14,
    techRoc10,
    techGapDown,
    volaCv90d,
    bestOrderBlockStrength,
    bbBandwidthPct,
    vwapBias,
    vwap5d,
    vwapBias5d,
    volumeExpansion20,
    return5d,
    return20d,
    return60d,
    volShareTurnover21d,
    foreignNet5d,
    trustNet5d,
    dealerNet5d,
    foreignTrustNet5d: foreignNet5d + trustNet5d,
    brokerNetShares5d,
    brokerNetAmount5d,
    marginBalance: finiteOrNull(latestMargin?.marginBalance),
    shortBalance: finiteOrNull(latestMargin?.shortBalance),
    brokerCount: finiteOrNull(latestBroker?.brokerCount),
    brokerConcentration: finiteOrNull(latestBroker?.concentration),
    ...(fundamentals ?? {}),
    source: [
      'finlab.price',
      chipRows.some((row) => String(row.source || '').includes('institutional_investors_trading_summary'))
        ? 'finlab.institutional_investors_trading_summary'
        : null,
      chipRows.some((row) => String(row.source || '') === 'finlab.broker_transactions')
        ? 'finlab.broker_transactions'
        : null,
      chipRows.some((row) => String(row.source || '') === 'finlab.rotc_broker_transactions')
        ? 'finlab.rotc_broker_transactions'
        : null,
      fundamentals?.source ?? null,
      extraFactors?.source ?? null,
    ].filter(Boolean).join('+'),
  }

  return {
    ...base,
    technicalIndicators: {
      closeAboveMa20Pct,
      closeAboveMa60Pct,
      volumeExpansion20,
      VSTD_10: vstd10,
      tech_emv_14: emv14,
      tech_roc_10: techRoc10,
      tech_gap_down: techGapDown,
      vola_cv_90d: volaCv90d,
      ...stockTechnicalDailyFeatures,
      ma10Bias,
      return5d,
      return20d,
      return60d,
      rsi14: latestRsi14,
      macd: technicals.macd,
      macdSignal: technicals.macdSignal,
      macdHist: technicals.macdHist,
      bbUpper: technicals.bbUpper,
      bbMid: technicals.bbMid,
      bbLower: technicals.bbLower,
      bbBandwidthPct,
      vwapBias,
      vwap_5d: vwap5d,
      vwapBias5d,
      vwap_bias: vwapBias,
      vwap_bias_5d: vwapBias5d,
      bbPctB,
      atr14: technicals.atr14,
      plusDi14: technicals.plusDi14,
      minusDi14: technicals.minusDi14,
      adx14: technicals.adx14,
      diTrend,
      cci20: technicals.cci20,
      volumeWeightedRsi14: technicals.volumeWeightedRsi14,
      volumeMomentumDivergence132710: technicals.volumeMomentumDivergence132710,
      squeezeOn: technicals.squeezeOn,
      squeezeRelease: technicals.squeezeRelease,
      squeezeMomentum: technicals.squeezeMomentum,
      obvTemperature60: technicals.obvTemperature60,
      displacementPct,
      bosBullish,
      liquiditySweepBullish,
      chochBullish,
      smcBullishScore: smc?.bullishScore ?? null,
      smcBearishScore: smc?.bearishScore ?? null,
      smcNetScore: smc?.score ?? null,
      smcBiasBullish: smc?.bias === 'bullish' ? 1 : 0,
      smcBiasBearish: smc?.bias === 'bearish' ? 1 : 0,
      bearishBos: smc?.bearishBos ? 1 : 0,
      bearishChoch: smc?.bearishChoch ? 1 : 0,
      bearishLiquiditySweep: smc?.bearishLiquiditySweep ? 1 : 0,
      bestFvgStrength: bestFvg?.strength ?? null,
      bestFvgRetested: bestFvg?.status === 'retested' ? 1 : 0,
      priceActionStructureAvailable: priceAction ? 1 : 0,
      orderBlockDetected: priceAction ? (bestOrderBlock ? 1 : 0) : null,
      bestOrderBlockStrength,
      bestOrderBlockRetested: bestOrderBlock?.status === 'retested' ? 1 : 0,
      KLOW2: kLow2,
      KSFT: kSft,
      KSFT2: kSft2,
      CNTN_20: cntn20,
      CNTD_20: cntd20,
    },
    factorSignals: {
      closeAboveMa20Pct,
      volumeExpansion20,
      KLOW2: kLow2,
      KSFT: kSft,
      KSFT2: kSft2,
      CNTN_20: cntn20,
      CNTD_20: cntd20,
      tech_roc_10: techRoc10,
      tech_gap_down: techGapDown,
      vola_cv_90d: volaCv90d,
      vwap_bias: vwapBias,
      vwap_5d: vwap5d,
      vwap_bias_5d: vwapBias5d,
      vwapBias,
      vwap5d,
      vwapBias5d,
      ma10_bias: ma10Bias,
      ma10Bias,
      return_5d: return5d,
      return5d,
      return20d,
      vol_share_turnover_21d: volShareTurnover21d,
      volShareTurnover21d,
      rsi14: latestRsi14,
      foreignTrustNet5d: base.foreignTrustNet5d ?? null,
      brokerNetShares5d,
      brokerNetAmount5d,
      l1_brokerNetAmount5d: brokerNetAmount5d,
      margin_balance: base.marginBalance ?? null,
      marginBalance: base.marginBalance ?? null,
      short_balance: base.shortBalance ?? null,
      shortBalance: base.shortBalance ?? null,
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
      operatingCashFlow: base.operatingCashFlow ?? null,
      roa: base.roa ?? null,
      ebitda: base.ebitda ?? null,
      freeCashFlow: base.freeCashFlow ?? null,
      financialCost: base.financialCost ?? null,
      operatingExpenses: base.operatingExpenses ?? null,
      cashFlowPerShare: base.cashFlowPerShare ?? null,
      pretaxIncomePerShare: base.pretaxIncomePerShare ?? null,
      propertyPlantEquipment: base.propertyPlantEquipment ?? null,
      workingCapital: base.workingCapital ?? null,
      currentLiabilities: base.currentLiabilities ?? null,
      operatingCashFlowStatement: base.operatingCashFlowStatement ?? null,
      nonCurrentAssets: base.nonCurrentAssets ?? null,
      cashAndCashEquivalentsIncreaseDecrease: base.cashAndCashEquivalentsIncreaseDecrease ?? null,
      otherPayables: base.otherPayables ?? null,
      capitalAmount: base.capitalAmount ?? null,
      ...(extraFactors?.factorSignals ?? {}),
    },
  }
}

type FinLabNormalizationField = {
  rawField: keyof StrategyRawSignals
  signalKey: string
  direction: 'higher_is_better' | 'lower_is_better'
  sectorRank: boolean
}

const FINLAB_STYLE_NORMALIZATION_FIELDS: FinLabNormalizationField[] = [
  { rawField: 'roe', signalKey: 'Roe', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'eps', signalKey: 'Eps', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'grossMargin', signalKey: 'GrossMargin', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'operatingMargin', signalKey: 'OperatingMargin', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'revenueGrowthYoY', signalKey: 'RevenueGrowthYoY', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'monthlyRevenueYoY', signalKey: 'MonthlyRevenueYoY', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'monthlyRevenueMoM', signalKey: 'MonthlyRevenueMoM', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'return5d', signalKey: 'Return5d', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'return20d', signalKey: 'Return20d', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'ma10Bias', signalKey: 'Ma10Bias', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'closeAboveMa60Pct', signalKey: 'CloseAboveMa60Pct', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'volumeExpansion20', signalKey: 'VolumeExpansion20', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'KLOW2', signalKey: 'Klow2Low', direction: 'lower_is_better', sectorRank: false },
  { rawField: 'KSFT', signalKey: 'KsftLow', direction: 'lower_is_better', sectorRank: false },
  { rawField: 'VSTD_10', signalKey: 'Vstd10', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'techEmv14', signalKey: 'TechEmv14', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'techRoc10', signalKey: 'TechRoc10', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'techGapDown', signalKey: 'TechGapDown', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'volaCv90d', signalKey: 'VolaCv90dLow', direction: 'lower_is_better', sectorRank: false },
  { rawField: 'vwapBias', signalKey: 'VwapBias', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'vwapBias5d', signalKey: 'VwapBias5d', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'brokerNetAmount5d', signalKey: 'BrokerNetAmount5d', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'bestOrderBlockStrength', signalKey: 'BestOrderBlockStrength', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'bbBandwidthPct', signalKey: 'BbBandwidthPct', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'marginBalance', signalKey: 'MarginBalance', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'dividendYield', signalKey: 'DividendYield', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'pe', signalKey: 'PeCheap', direction: 'lower_is_better', sectorRank: true },
  { rawField: 'pb', signalKey: 'PbCheap', direction: 'lower_is_better', sectorRank: true },
  { rawField: 'operatingCashFlow', signalKey: 'OperatingCashFlow', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'roa', signalKey: 'Roa', direction: 'higher_is_better', sectorRank: true },
  { rawField: 'ebitda', signalKey: 'Ebitda', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'freeCashFlow', signalKey: 'FreeCashFlow', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'financialCost', signalKey: 'FinancialCost', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'operatingExpenses', signalKey: 'OperatingExpenses', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'cashFlowPerShare', signalKey: 'CashFlowPerShare', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'pretaxIncomePerShare', signalKey: 'PretaxIncomePerShare', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'propertyPlantEquipment', signalKey: 'PropertyPlantEquipment', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'workingCapital', signalKey: 'WorkingCapital', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'currentLiabilities', signalKey: 'CurrentLiabilities', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'operatingCashFlowStatement', signalKey: 'OperatingCashFlowStatement', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'nonCurrentAssets', signalKey: 'NonCurrentAssets', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'cashAndCashEquivalentsIncreaseDecrease', signalKey: 'CashAndCashEquivalentsIncreaseDecrease', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'otherPayables', signalKey: 'OtherPayables', direction: 'higher_is_better', sectorRank: false },
  { rawField: 'volShareTurnover21d', signalKey: 'VolShareTurnover21d', direction: 'higher_is_better', sectorRank: false },
]

function percentileRank(value: number, sortedAsc: number[]): number | null {
  if (!Number.isFinite(value) || !sortedAsc.length) return null
  if (sortedAsc.length === 1) return 1
  let lower = 0
  while (lower < sortedAsc.length && sortedAsc[lower] < value) lower++
  let upper = lower
  while (upper < sortedAsc.length && sortedAsc[upper] <= value) upper++
  const midpointIndex = (lower + Math.max(lower, upper - 1)) / 2
  return clamp(midpointIndex / (sortedAsc.length - 1), 0, 1)
}

function rankKey(prefix: 'finlabCs' | 'finlabSector', signalKey: string): string {
  return `${prefix}${signalKey}Rank`
}

function zScoreKey(prefix: 'finlabCs' | 'finlabSector', signalKey: string): string {
  return `${prefix}${signalKey}ZScore`
}

function winsorizedKey(prefix: 'finlabCs', signalKey: string): string {
  return `${prefix}${signalKey}WinsorizedValue`
}

function sectorNeutralRankKey(signalKey: string): string {
  return `finlabSectorNeutral${signalKey}Rank`
}

function meanStd(sortedAsc: number[]): { mean: number; std: number } | null {
  if (sortedAsc.length < 2) return null
  const mean = sortedAsc.reduce((sum, value) => sum + value, 0) / sortedAsc.length
  const variance = sortedAsc.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sortedAsc.length - 1)
  const std = Math.sqrt(Math.max(0, variance))
  return std > 0 ? { mean, std } : null
}

function directedZScore(value: number, sortedAsc: number[], direction: FinLabNormalizationField['direction']): number | null {
  const stats = meanStd(sortedAsc)
  if (!stats) return null
  const raw = (value - stats.mean) / stats.std
  const directed = direction === 'lower_is_better' ? -raw : raw
  return Math.round(clamp(directed, -5, 5) * 10000) / 10000
}

function winsorizedValue(value: number, sortedAsc: number[]): number | null {
  if (!sortedAsc.length) return null
  const lower = sortedAsc[Math.floor((sortedAsc.length - 1) * 0.05)]
  const upper = sortedAsc[Math.ceil((sortedAsc.length - 1) * 0.95)]
  return Math.round(clamp(value, lower, upper) * 10000) / 10000
}

function applyFinLabStyleFactorNormalization<T extends { raw_signals?: StrategyRawSignals; industry?: string | null }>(
  candidates: T[],
): FinLabStyleFactorNormalizationTelemetry {
  const telemetry: FinLabStyleFactorNormalizationTelemetry = {
    method: 'finlab_style_cs_sector_rank_zscore_winsor_sector_neutral_v2',
    universeCount: candidates.length,
    sectorCount: 0,
    fieldCoverage: {},
    sectorFieldCoverage: {},
    compositeCoverage: {},
    allocationCoverage: {},
    specialFeatureMaterialization: {
      featureAliases: {
        method: 'formal137_feature_alias_materialization_v1',
        universeCount: candidates.length,
        materializedCount: 0,
        aliasCoverage: {},
      },
      usSentimentScore: {
        method: 'formal137_us_sentiment_cross_sectional_exposure_rank_v1',
        universeCount: candidates.length,
        sentimentCoverage: 0,
        exposureEligibleCount: 0,
        materializedCount: 0,
        skippedNeutralCount: 0,
        skippedConstantExposureCount: 0,
        componentCoverage: {},
      },
    },
  }
  const sortedByField = new Map<keyof StrategyRawSignals, number[]>()
  for (const field of FINLAB_STYLE_NORMALIZATION_FIELDS) {
    const values = candidates
      .map((candidate) => finiteOrNull(candidate.raw_signals?.[field.rawField]))
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)
    sortedByField.set(field.rawField, values)
  }

  const bySector = new Map<string, T[]>()
  for (const candidate of candidates) {
    const sector = String(candidate.industry ?? '').trim() || 'unknown'
    const bucket = bySector.get(sector) ?? []
    bucket.push(candidate)
    bySector.set(sector, bucket)
  }
  telemetry.sectorCount = bySector.size

  const sortedBySectorField = new Map<string, Map<keyof StrategyRawSignals, number[]>>()
  for (const [sector, sectorCandidates] of bySector.entries()) {
    const fieldMap = new Map<keyof StrategyRawSignals, number[]>()
    for (const field of FINLAB_STYLE_NORMALIZATION_FIELDS) {
      if (!field.sectorRank) continue
      const values = sectorCandidates
        .map((candidate) => finiteOrNull(candidate.raw_signals?.[field.rawField]))
        .filter((value): value is number => value != null)
        .sort((a, b) => a - b)
      fieldMap.set(field.rawField, values)
    }
    sortedBySectorField.set(sector, fieldMap)
  }

  for (const candidate of candidates) {
    const raw = candidate.raw_signals
    if (!raw) continue
    raw.factorSignals = { ...(raw.factorSignals ?? {}) }
    const sector = String(candidate.industry ?? '').trim() || 'unknown'
    for (const field of FINLAB_STYLE_NORMALIZATION_FIELDS) {
      const value = finiteOrNull(raw[field.rawField])
      if (value == null) continue
      const csRankRaw = percentileRank(value, sortedByField.get(field.rawField) ?? [])
      if (csRankRaw != null) {
        const rank = field.direction === 'lower_is_better' ? 1 - csRankRaw : csRankRaw
        const key = rankKey('finlabCs', field.signalKey)
        const rankValue = Math.round(rank * 10000) / 10000
        raw.factorSignals[key] = rankValue
        telemetry.fieldCoverage[key] = (telemetry.fieldCoverage[key] ?? 0) + 1
        if (field.rawField === 'marginBalance') {
          for (const alias of [
            'formal137MarginBalanceRank',
            'margin_balance_rank',
            'marginBalanceRank',
            'margin_balance_normalized',
          ]) {
            raw.factorSignals[alias] = rankValue
            telemetry.fieldCoverage[alias] = (telemetry.fieldCoverage[alias] ?? 0) + 1
          }
        }
      }
      const csZScore = directedZScore(value, sortedByField.get(field.rawField) ?? [], field.direction)
      if (csZScore != null) {
        const key = zScoreKey('finlabCs', field.signalKey)
        raw.factorSignals[key] = csZScore
        telemetry.fieldCoverage[key] = (telemetry.fieldCoverage[key] ?? 0) + 1
      }
      const csWinsorized = winsorizedValue(value, sortedByField.get(field.rawField) ?? [])
      if (csWinsorized != null) {
        const key = winsorizedKey('finlabCs', field.signalKey)
        raw.factorSignals[key] = csWinsorized
        telemetry.fieldCoverage[key] = (telemetry.fieldCoverage[key] ?? 0) + 1
      }
      if (field.sectorRank) {
        const sectorValues = sortedBySectorField.get(sector)?.get(field.rawField) ?? []
        if (sectorValues.length >= 3) {
          const sectorRankRaw = percentileRank(value, sectorValues)
          if (sectorRankRaw != null) {
            const rank = field.direction === 'lower_is_better' ? 1 - sectorRankRaw : sectorRankRaw
            const key = rankKey('finlabSector', field.signalKey)
            const neutralKey = sectorNeutralRankKey(field.signalKey)
            raw.factorSignals[key] = Math.round(rank * 10000) / 10000
            raw.factorSignals[neutralKey] = raw.factorSignals[key]
            telemetry.sectorFieldCoverage[key] = (telemetry.sectorFieldCoverage[key] ?? 0) + 1
            telemetry.sectorFieldCoverage[neutralKey] = (telemetry.sectorFieldCoverage[neutralKey] ?? 0) + 1
          }
          const sectorZScore = directedZScore(value, sectorValues, field.direction)
          if (sectorZScore != null) {
            const key = zScoreKey('finlabSector', field.signalKey)
            raw.factorSignals[key] = sectorZScore
            telemetry.sectorFieldCoverage[key] = (telemetry.sectorFieldCoverage[key] ?? 0) + 1
          }
        }
      }
    }
    const atrPct = raw.close && raw.technicalIndicators?.atr14
      ? finiteOrNull(raw.technicalIndicators.atr14)! / Math.max(1, Math.abs(raw.close))
      : null
    const volatilityProxy = Math.max(
      0.005,
      Math.abs(atrPct ?? finiteOrNull(raw.return20d) ?? 0.02),
    )
    raw.factorSignals.finlabInverseVolatilityWeight = Math.round(clamp(1 / (1 + volatilityProxy * 25), 0, 1) * 10000) / 10000
    telemetry.allocationCoverage.finlabInverseVolatilityWeight = (telemetry.allocationCoverage.finlabInverseVolatilityWeight ?? 0) + 1
    const sectorSize = bySector.get(sector)?.length ?? 1
    raw.factorSignals.finlabIndustryCapWeight = Math.round((1 / Math.sqrt(Math.max(1, sectorSize))) * 10000) / 10000
    telemetry.allocationCoverage.finlabIndustryCapWeight = (telemetry.allocationCoverage.finlabIndustryCapWeight ?? 0) + 1
    const volumeExpansion = finiteOrNull(raw.volumeExpansion20)
    if (volumeExpansion != null) {
      raw.factorSignals.finlabTurnoverControlWeight = Math.round(clamp(1 / (1 + Math.max(0, volumeExpansion - 1)), 0.2, 1) * 10000) / 10000
      telemetry.allocationCoverage.finlabTurnoverControlWeight = (telemetry.allocationCoverage.finlabTurnoverControlWeight ?? 0) + 1
    }

    const qualityComposite = avg([
      finiteOrNull(raw.factorSignals.finlabCsRoeRank),
      finiteOrNull(raw.factorSignals.finlabCsEpsRank),
      finiteOrNull(raw.factorSignals.finlabCsGrossMarginRank),
      finiteOrNull(raw.factorSignals.finlabCsOperatingMarginRank),
      finiteOrNull(raw.factorSignals.finlabCsRevenueGrowthYoYRank),
      finiteOrNull(raw.factorSignals.finlabCsMonthlyRevenueYoYRank),
    ].filter((value): value is number => value != null))
    const valueComposite = avg([
      finiteOrNull(raw.factorSignals.finlabCsPeCheapRank),
      finiteOrNull(raw.factorSignals.finlabCsPbCheapRank),
      finiteOrNull(raw.factorSignals.finlabCsDividendYieldRank),
    ].filter((value): value is number => value != null))
    const sectorQualityComposite = avg([
      finiteOrNull(raw.factorSignals.finlabSectorRoeRank),
      finiteOrNull(raw.factorSignals.finlabSectorGrossMarginRank),
      finiteOrNull(raw.factorSignals.finlabSectorOperatingMarginRank),
      finiteOrNull(raw.factorSignals.finlabSectorRevenueGrowthYoYRank),
      finiteOrNull(raw.factorSignals.finlabSectorMonthlyRevenueYoYRank),
    ].filter((value): value is number => value != null))

    if (qualityComposite != null) {
      raw.factorSignals.finlabQualityCompositeRank = Math.round(qualityComposite * 10000) / 10000
      telemetry.compositeCoverage.finlabQualityCompositeRank = (telemetry.compositeCoverage.finlabQualityCompositeRank ?? 0) + 1
    }
    if (valueComposite != null) {
      raw.factorSignals.finlabValueCompositeRank = Math.round(valueComposite * 10000) / 10000
      telemetry.compositeCoverage.finlabValueCompositeRank = (telemetry.compositeCoverage.finlabValueCompositeRank ?? 0) + 1
    }
    if (sectorQualityComposite != null) {
      raw.factorSignals.finlabSectorQualityCompositeRank = Math.round(sectorQualityComposite * 10000) / 10000
      telemetry.compositeCoverage.finlabSectorQualityCompositeRank = (telemetry.compositeCoverage.finlabSectorQualityCompositeRank ?? 0) + 1
    }

  }

  telemetry.specialFeatureMaterialization.featureAliases = materializeFormal137FeatureAliases(candidates)
  telemetry.specialFeatureMaterialization.usSentimentScore = materializeFormal137UsSentimentScoreRank(candidates)
  return telemetry
}

type L0RawSignalAuditField =
  | 'pe'
  | 'pb'
  | 'roe'
  | 'eps'
  | 'dividendYield'
  | 'monthlyRevenueYoY'
  | 'brokerCount'
  | 'brokerConcentration'

interface L0RawSignalCoverageAudit {
  version: 'l0-raw-signal-coverage-audit-v1'
  universeCount: number
  candidateCount: number
  rawCoverage: Record<L0RawSignalAuditField, number>
  canonicalCoverageBaseline: Partial<Record<L0RawSignalAuditField, number>>
  sourceCoverage: Record<string, number>
  brokerFlowMaterializationStatus: 'materialized' | 'not_materialized'
  brokerFlowSources: Record<string, number>
  status: 'pass' | 'warn' | 'fail'
  warnings: string[]
  failures: string[]
  fundamental_loader_error: string[]
}

const L0_RAW_SIGNAL_AUDIT_FIELDS: L0RawSignalAuditField[] = [
  'pe',
  'pb',
  'roe',
  'eps',
  'dividendYield',
  'monthlyRevenueYoY',
  'brokerCount',
  'brokerConcentration',
]

function buildL0RawSignalCoverageAudit<T extends { raw_signals?: StrategyRawSignals }>(
  candidates: T[],
  universeCount: number,
  fundamentalTelemetry: StrategyRawFundamentalLoadTelemetry,
  brokerFlowSources: Record<string, number>,
): L0RawSignalCoverageAudit {
  const rawCoverage = Object.fromEntries(L0_RAW_SIGNAL_AUDIT_FIELDS.map((field) => [field, 0])) as Record<L0RawSignalAuditField, number>
  const sourceCoverage: Record<string, number> = {}
  for (const candidate of candidates) {
    const raw = candidate.raw_signals
    if (!raw) continue
    for (const field of L0_RAW_SIGNAL_AUDIT_FIELDS) {
      if (raw[field] != null) rawCoverage[field] += 1
    }
    for (const source of String(raw.source ?? '').split('+').map((value) => value.trim()).filter(Boolean)) {
      sourceCoverage[source] = (sourceCoverage[source] ?? 0) + 1
    }
  }
  const canonicalCoverageBaseline: Partial<Record<L0RawSignalAuditField, number>> = {
    pe: fundamentalTelemetry.fieldCoverage.pe,
    pb: fundamentalTelemetry.fieldCoverage.pb,
    roe: fundamentalTelemetry.fieldCoverage.roe,
    eps: fundamentalTelemetry.fieldCoverage.eps,
    dividendYield: fundamentalTelemetry.fieldCoverage.dividendYield,
    monthlyRevenueYoY: fundamentalTelemetry.revenueSymbols,
  }
  const failures: string[] = []
  for (const field of ['pe', 'pb', 'roe', 'eps', 'dividendYield', 'monthlyRevenueYoY'] as L0RawSignalAuditField[]) {
    const baseline = canonicalCoverageBaseline[field] ?? 0
    if (baseline > 0 && rawCoverage[field] === 0) failures.push(`${field}:raw_signals_zero_while_canonical_baseline_${baseline}`)
  }
  const hasListedBrokerFlow = (brokerFlowSources['finlab.broker_transactions'] ?? 0) > 0
  const brokerFlowMaterializationStatus = hasListedBrokerFlow ? 'materialized' : 'not_materialized'
  const warnings: string[] = []
  if (!hasListedBrokerFlow) {
    warnings.push('listed_otc_finlab_broker_transactions:not_materialized')
  }
  const fundamentalErrors = [
    ...fundamentalTelemetry.canonicalErrors.map((item) => `fundamental:${item}`),
    ...fundamentalTelemetry.revenueErrors.map((item) => `revenue:${item}`),
  ]
  if (fundamentalErrors.length) warnings.push('fundamental_loader_error')
  return {
    version: 'l0-raw-signal-coverage-audit-v1',
    universeCount,
    candidateCount: candidates.length,
    rawCoverage,
    canonicalCoverageBaseline,
    sourceCoverage,
    brokerFlowMaterializationStatus,
    brokerFlowSources,
    status: failures.length ? 'fail' : warnings.length ? 'warn' : 'pass',
    warnings,
    failures,
    fundamental_loader_error: fundamentalErrors,
  }
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

interface BrokerFlowSummary {
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

function normalizeUsageRatio(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.abs(value) > 1.5 ? value / 100 : value
}

function brokerEstimatedAmountTwd(amount: number | null | undefined, shares: number, latestClose: number, source?: string): number {
  const listedBrokerLots = String(source ?? '').includes('finlab.broker_transactions')
    && !String(source ?? '').includes('rotc')
  const unitMultiplier = listedBrokerLots ? 1000 : 1
  const fallback = Number.isFinite(shares) && Number.isFinite(latestClose)
    ? shares * latestClose * unitMultiplier
    : 0
  if (amount == null || !Number.isFinite(amount)) return fallback
  const nominalLotAmount = Math.abs(shares * latestClose)
  if (listedBrokerLots && nominalLotAmount > 0) {
    const ratio = Math.abs(amount) / nominalLotAmount
    if (ratio >= 0.2 && ratio <= 5) return amount * 1000
  }
  return amount
}

function formatAbsTwdAmount(amount: number): string {
  const abs = Math.abs(amount)
  if (abs < 1e8) return `${Math.round(abs / 10_000)}萬`
  return `${(abs / 1e8).toFixed(2)}億`
}

function summarizeBrokerFlowChip(
  chipDates: Map<string, ChipDayNet> | undefined,
  prices: CanonicalScreenerPrice[],
  latestClose: number,
): BrokerFlowSummary | null {
  if (!chipDates?.size) return null
  const sortedDates = [...chipDates.keys()].sort().slice(-5)
  if (!sortedDates.length) return null

  let netShares5d = 0
  let estimatedAmount5d = 0
  let hasBrokerFlow = false
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
    const shares = row.brokerFlow ?? 0
    const amount = brokerEstimatedAmountTwd(row.estimatedAmount, shares, latestClose, row.source)
    if (shares !== 0 || row.estimatedAmount != null) hasBrokerFlow = true
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

  if (!hasBrokerFlow) return null
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

function scoreBrokerFlowChip(summary: BrokerFlowSummary): { score: number; reasons: string[] } {
  const amount = summary.estimatedAmount5d
  const amountBillion = amount / 1e8
  const intensity = summary.turnoverIntensity5d
  let score = 0

  if (amount > 0) {
    const amountScore = clamp(Math.log10(1 + Math.abs(amount) / 1_000_000) * 1.7, 1, 7)
    const intensityScore = intensity == null
      ? clamp(amountBillion * 8, 0, 4)
      : clamp(Math.sqrt(Math.abs(intensity)) * 7, 0, 5)
    const breadthScore = summary.latestBrokerCount == null
      ? 1
      : clamp(Math.log2(Math.max(1, summary.latestBrokerCount)) * 0.8, 0.5, 3)
    const concentrationPenalty = summary.latestConcentration == null
      ? 0
      : summary.latestConcentration > 0.85
        ? 3
        : summary.latestConcentration > 0.65
          ? 1.5
          : 0
    score = clamp(amountScore + intensityScore + breadthScore - concentrationPenalty, 0, 12)
  } else if (amount > -1_000_000) {
    score = 0
  } else {
    const sellPressure = clamp(Math.log10(1 + Math.abs(amount) / 1_000_000) * 2.0, 1, 10)
    const concentrationPenalty = summary.latestConcentration == null
      ? 0
      : summary.latestConcentration > 0.85
        ? 2
        : summary.latestConcentration > 0.65
          ? 1
          : 0
    score = -clamp(sellPressure + concentrationPenalty, 0, 12)
  }

  if (summary.consecBuyDays >= 3 && amount > 0) score += summary.consecBuyDays >= 5 ? 3 : 1
  score = round1(clamp(score, -12, 14))

  const direction = amount >= 0 ? 'buy' : 'sell'
  const reasons = [
    `broker_flow_5d_${direction}_${formatAbsTwdAmount(amount)}`,
  ]
  if (intensity != null) reasons.push(`turnover_intensity_${Math.abs(intensity * 100).toFixed(1)}%`)
  if (summary.latestBrokerCount != null) reasons.push(`broker_count_${summary.latestBrokerCount}`)
  if (summary.latestConcentration != null) reasons.push(`broker_concentration_${summary.latestConcentration.toFixed(2)}`)
  return { score, reasons }
}

interface CreditLendingPressureSummary {
  adjustment: number
  marginDelta: number | null
  shortBalanceDelta: number | null
  shortNetSell5d: number | null
  lendingSellNet5d: number | null
  lendingSellBalanceDelta: number | null
  marginUsageRatio: number | null
  shortUsageRatio: number | null
  reasons: string[]
}

function pressureUnitsScore(units: number, latestClose: number, avgDailyTurnover: number, multiplier: number, cap: number): number {
  if (!Number.isFinite(units) || !Number.isFinite(latestClose) || !Number.isFinite(avgDailyTurnover) || avgDailyTurnover <= 0) return 0
  const intensity = Math.abs(units * latestClose) / avgDailyTurnover
  return clamp(Math.sqrt(intensity) * multiplier, 0, cap)
}

function finiteRowValue(row: ChipDayNet | undefined, key: keyof ChipDayNet): number | null {
  if (!row) return null
  return finiteOrNull(row[key])
}

function scoreCreditLendingPressure(
  chipDates: Map<string, ChipDayNet> | undefined,
  prices: CanonicalScreenerPrice[],
  latestClose: number,
): CreditLendingPressureSummary | null {
  if (!chipDates?.size) return null
  const sortedDates = [...chipDates.keys()].sort().slice(-5)
  const rows = sortedDates.map(date => chipDates.get(date)).filter((row): row is ChipDayNet => !!row)
  const creditRows = rows.filter(row =>
    row.marginBalance != null ||
    row.shortBalance != null ||
    row.shortBuy != null ||
    row.shortSell != null ||
    row.securityLendingSell != null ||
    row.securityLendingSellReturn != null ||
    row.securityLendingSellBalance != null ||
    row.securityLendingBalance != null
  )
  if (!creditRows.length) return null

  const first = creditRows[0]
  const latest = creditRows[creditRows.length - 1]
  const avgDailyTurnover = prices.reduce((s, p) => s + p.Trading_Volume * p.close, 0) / Math.max(1, prices.length)
  const close = latestClose > 0 ? latestClose : (prices[prices.length - 1]?.close ?? 0)
  let adjustment = 0
  const reasons: string[] = []

  const marginBalance0 = finiteRowValue(first, 'marginBalance')
  const marginBalance1 = finiteRowValue(latest, 'marginBalance')
  const marginDelta = marginBalance0 != null && marginBalance1 != null ? marginBalance1 - marginBalance0 : null
  if (marginDelta != null && marginDelta !== 0) {
    const score = pressureUnitsScore(marginDelta, close, avgDailyTurnover, 1.2, 1.5)
    if (marginDelta > 0) {
      adjustment += score
      if (score >= 0.3) reasons.push(`margin_balance_rising_${Math.round(marginDelta)}`)
    } else {
      adjustment -= clamp(score, 0, 1.0)
      if (score >= 0.3) reasons.push(`margin_balance_falling_${Math.round(Math.abs(marginDelta))}`)
    }
  }

  const marginUsageRatio = normalizeUsageRatio(finiteRowValue(latest, 'marginUsageRatio'))
  if (marginUsageRatio != null) {
    if (marginUsageRatio > 0.8) { adjustment -= 2; reasons.push('margin_usage_crowded_gt_80pct') }
    else if (marginUsageRatio > 0.6) { adjustment -= 1; reasons.push('margin_usage_crowded_gt_60pct') }
  }

  let shortNetSell5d: number | null = null
  for (const row of creditRows) {
    const sell = finiteRowValue(row, 'shortSell')
    const buy = finiteRowValue(row, 'shortBuy')
    const repay = finiteRowValue(row, 'shortStockRepayment')
    if (sell != null || buy != null || repay != null) {
      shortNetSell5d = (shortNetSell5d ?? 0) + (sell ?? 0) - (buy ?? 0) - (repay ?? 0)
    }
  }
  const shortBalance0 = finiteRowValue(first, 'shortBalance')
  const shortBalance1 = finiteRowValue(latest, 'shortBalance')
  const shortBalanceDelta = shortBalance0 != null && shortBalance1 != null ? shortBalance1 - shortBalance0 : null
  const shortPressure = shortNetSell5d ?? shortBalanceDelta
  if (shortPressure != null && shortPressure !== 0) {
    const score = pressureUnitsScore(shortPressure, close, avgDailyTurnover, 1.8, 2.0)
    if (shortPressure > 0) {
      adjustment -= score
      if (score >= 0.3) reasons.push(`short_pressure_rising_${Math.round(shortPressure)}`)
    } else {
      adjustment += clamp(score, 0, 1.5)
      if (score >= 0.3) reasons.push(`short_covering_${Math.round(Math.abs(shortPressure))}`)
    }
  }

  const shortUsageRatio = normalizeUsageRatio(finiteRowValue(latest, 'shortUsageRatio'))
  if (shortUsageRatio != null) {
    if (shortUsageRatio > 0.75) { adjustment -= 2; reasons.push('short_usage_crowded_gt_75pct') }
    else if (shortUsageRatio > 0.5) { adjustment -= 1; reasons.push('short_usage_crowded_gt_50pct') }
  }

  let lendingSellNet5d: number | null = null
  for (const row of creditRows) {
    const sell = finiteRowValue(row, 'securityLendingSell')
    const ret = finiteRowValue(row, 'securityLendingSellReturn')
    if (sell != null || ret != null) lendingSellNet5d = (lendingSellNet5d ?? 0) + (sell ?? 0) - (ret ?? 0)
  }
  if (lendingSellNet5d != null && lendingSellNet5d !== 0) {
    const score = pressureUnitsScore(lendingSellNet5d, close, avgDailyTurnover, 2.2, 2.5)
    if (lendingSellNet5d > 0) {
      adjustment -= score
      if (score >= 0.3) reasons.push(`lending_sell_pressure_${Math.round(lendingSellNet5d)}`)
    } else {
      adjustment += clamp(score, 0, 1.5)
      if (score >= 0.3) reasons.push(`lending_sell_covering_${Math.round(Math.abs(lendingSellNet5d))}`)
    }
  }

  const lendingSellBalance0 = finiteRowValue(first, 'securityLendingSellBalance')
  const lendingSellBalance1 = finiteRowValue(latest, 'securityLendingSellBalance')
  const lendingSellBalanceDelta = lendingSellBalance0 != null && lendingSellBalance1 != null
    ? lendingSellBalance1 - lendingSellBalance0
    : null
  if (lendingSellBalanceDelta != null && lendingSellBalanceDelta !== 0) {
    const score = pressureUnitsScore(lendingSellBalanceDelta, close, avgDailyTurnover, 1.4, 1.5)
    if (lendingSellBalanceDelta > 0) {
      adjustment -= score
      if (score >= 0.3) reasons.push(`lending_sell_balance_rising_${Math.round(lendingSellBalanceDelta)}`)
    } else {
      adjustment += clamp(score, 0, 1.0)
      if (score >= 0.3) reasons.push(`lending_sell_balance_falling_${Math.round(Math.abs(lendingSellBalanceDelta))}`)
    }
  }

  const roundedAdjustment = Math.round(clamp(adjustment, -6, 4) * 10) / 10
  if (roundedAdjustment === 0 && !reasons.length) return null
  return {
    adjustment: roundedAdjustment,
    marginDelta,
    shortBalanceDelta,
    shortNetSell5d,
    lendingSellNet5d,
    lendingSellBalanceDelta,
    marginUsageRatio,
    shortUsageRatio,
    reasons,
  }
}

// ??? DB Operations ???????????????????????????????????????????????????????????

async function updateScreenerWatchlist(db: D1Database, candidates: ScreenerCandidate[], tpexSymbolSet: Set<string>): Promise<void> {
  const candidateSymbols = candidates.map(c => c.symbol)

  // ?? Step 1: ?銝?頛芰???pinned screener ?∠巨 ?????????????????????????
  // source='screener' 銝? pinned ???券???剁?? Step 2 ???祈憚?
  // pinned=1嚗蝙?刻?????瘞賊?銝◤ screener 頛芣?敶梢
  if (!candidates.length) {
    await db.prepare("UPDATE stocks SET in_current_watchlist=0 WHERE source='screener' AND COALESCE(pinned,0)=0").run()
    return
  }

  const keep = new Set(candidateSymbols)
  const { results: currentRows } = await db.prepare(
    "SELECT symbol FROM stocks WHERE source='screener' AND COALESCE(pinned,0)=0 AND in_current_watchlist=1",
  ).all<{ symbol: string }>()
  const staleSymbols = (currentRows ?? [])
    .map(row => String(row.symbol || '').trim())
    .filter(symbol => symbol && !keep.has(symbol))
  for (const chunk of chunkArray(staleSymbols, D1_IN_CHUNK_SIZE)) {
    const batch = chunk.map(symbol => db.prepare(
      "UPDATE stocks SET in_current_watchlist=0 WHERE source='screener' AND COALESCE(pinned,0)=0 AND symbol=?",
    ).bind(symbol))
    await db.batch(batch)
  }

  // ?? Step 2: Upsert ??∠巨 ????????????????????????????????????????????
  // pinned ?∠巨嚗?湔 in_current_watchlist=1?ector嚗???source
  // ??pinned ?∠巨嚗ource 閮剔 screener嚗?銝頛芸鋡急迤蝣箄憚??
  const batch = candidates.map(c => {
    // ?寞?鞈?靘??斗撣嚗PEX API 靘???OTC嚗擗 TWSE
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

// ??? Main Entry ??????????????????????????????????????????????????????????????

// ????????????????????????????????????????????????????????????????????????????????
// Bottom-up 憭?摮?+ RRG ?Ｘ平頛芸? Screener嚗2嚗?
// ????????????????????????????????????????????????????????????????????????????????

/**
 * 敺?stock_tags(tag_type='industry') 撱箇? symbol ??摰?Ｘ平 mapping
 * ?誨??getSectorMapping()嚗?? stocks.sector ?舀?敹萄?嚗?
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

  // 敹怠? 7 憭?
  await kv.put(cacheKey, JSON.stringify(Object.fromEntries(map)), { expirationTtl: 7 * 86400 })
  return map
}

/**
 * Step 2: 憭?摮???FinLab ?芸???
 *
 * 蝐Ⅳ(0-40): ??5 ?交?鈭箸楊鞎瑁? / 20 ?亙??漱??嚗?之????炊
 * ?銵?0-30): 頞典?釭?嚗? RSI ?芾??箏??踝?銝?憸券皛踹?
 * ?(0-20): 頞??梢 + ?瘥?+ ?寞???? + RSI ??
 */
// Sprint 6a.7b: exported for cross-runtime parity test
// (ml-controller/tests/test_screener_parity.py)
export function scoreMultiFactor(
  prices: CanonicalScreenerPrice[],
  chipDates: Map<string, ChipDayNet> | undefined,
  marketReturn5d: number,
  latestClose: number,
  config?: TradingConfig,
): {
  base_score: number
  chip_score: number
  tech_score: number
  momentum_score: number
  score_components: string
  reasons: string[]
  chip_evidence: Record<string, unknown>
} {
  const sc = config?.screener
  const reasons: string[] = []
  const latest = prices[prices.length - 1]

  // ?? P0-1: 蝐Ⅳ??(0-40) ???函撠?靘?瘨憭批???榆 ??
  let chip_score = 0
  let canonicalBrokerSummary: BrokerFlowSummary | null = null
  let canonicalBrokerScore = 0
  let creditLendingSummary: CreditLendingPressureSummary | null = null
  let chipEvidenceStatus = 'missing_chip_evidence'
  let chipEvidenceSource = 'none'
  if (chipDates) {
    const brokerSummary = summarizeBrokerFlowChip(chipDates, prices, latestClose)
    canonicalBrokerSummary = brokerSummary
    const isEmergingBrokerFlow = false
    if (isEmergingBrokerFlow) {
      const scoredBroker = scoreBrokerFlowChip(brokerSummary)
      chip_score = scoredBroker.score
      reasons.push(...scoredBroker.reasons)
      reasons.push(`broker_flow:${brokerSummary.latestSource} net=${Math.round(brokerSummary.netShares5d)} source_date=${brokerSummary.latestDate}`)
    } else {
      let netBuyShares = 0  // 5 ?交楊鞎瑁??⊥
      let consecBuyDays = 0
      // Sprint 6a.7b M11 fix (2026-04-08): count consecutive buy days from the
      // most recent day going back, stopping at the first non-positive day.
      // Previous impl zeroed consecBuyDays when hitting a negative mid-loop,
      // which lost the count entirely ??e.g. [-,+,+,+,+] returned 0 instead of 4.
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

      // chip_intensity = 瘛刻眺頞?憿?/ 20?亙??漱??嚗?靘?
      const netBuyAmount = netBuyShares * latestClose  // ??
      const avgDailyTurnover = prices.reduce((s, p) => s + p.Trading_Volume * p.close, 0) / prices.length
      const chipIntensity = avgDailyTurnover > 0 ? netBuyAmount / avgDailyTurnover : 0

      chip_score = scoreInstitutionalChipIntensity(chipIntensity)

      if (Math.abs(chipIntensity) > 0.03) {
        const side = chipIntensity >= 0 ? '+' : ''
        reasons.push(`institutional_turnover_intensity_${side}${(chipIntensity * 100).toFixed(1)}%`)
      }

      // ???鞎瑁?憭拇 bonus
      const cbBonus = sc?.consecBuyBonusTiers ?? [3, 1]
      const cbDays = sc?.consecBuyDayThresholds ?? [5, 3]
      if (chipIntensity > 0 && consecBuyDays >= cbDays[0]) { chip_score += cbBonus[0]; reasons.push(`consecutive_buy_days_${consecBuyDays}`) }
      else if (chipIntensity > 0 && consecBuyDays >= cbDays[1]) { chip_score += cbBonus[1] }
    }
  }
  if (canonicalBrokerSummary) {
    const scoredBroker = scoreBrokerFlowChip(canonicalBrokerSummary)
    canonicalBrokerScore = scoredBroker.score
    if (Math.abs(canonicalBrokerScore) > 0) {
      reasons.push(...scoredBroker.reasons)
      reasons.push(`broker_flow:${canonicalBrokerSummary.latestSource} net=${Math.round(canonicalBrokerSummary.netShares5d)} source_date=${canonicalBrokerSummary.latestDate}`)
    }
    chip_score += canonicalBrokerScore
    chipEvidenceStatus = chip_score > 0 ? 'materialized_chip_evidence' : 'materialized_neutral_or_bearish_chip_evidence'
    chipEvidenceSource = 'canonical_chip_daily+canonical_broker_flow_daily'
  } else if (chipDates?.size) {
    chipEvidenceStatus = chip_score > 0 ? 'materialized_institutional_only' : 'materialized_neutral_or_bearish_institutional_only'
    chipEvidenceSource = 'canonical_chip_daily'
  }
  creditLendingSummary = scoreCreditLendingPressure(chipDates, prices, latestClose)
  if (creditLendingSummary) {
    chip_score += creditLendingSummary.adjustment
    reasons.push(...creditLendingSummary.reasons)
    if (chipEvidenceSource === 'canonical_chip_daily') chipEvidenceSource = 'canonical_chip_daily+credit_lending'
    else if (chipEvidenceSource === 'canonical_chip_daily+canonical_broker_flow_daily') chipEvidenceSource = 'canonical_chip_daily+canonical_broker_flow_daily+credit_lending'
  }
  chip_score = clamp(chip_score, 0, 40)
  const chip_evidence: Record<string, unknown> = {
    schema_version: 'canonical_chip_evidence_v2',
    evidenceStatus: chipEvidenceStatus,
    evidence_status: chipEvidenceStatus,
    source: chipEvidenceSource,
    scoringPolicy: 'continuous_signed_institutional_broker_credit_lending_seed',
    scoring_policy: 'continuous_signed_institutional_broker_credit_lending_seed',
    brokerFlowUsed: canonicalBrokerSummary != null,
    brokerEvidenceStatus: canonicalBrokerSummary == null
      ? 'missing'
      : canonicalBrokerSummary.estimatedAmount5d > 0 && canonicalBrokerScore > 0
        ? 'present_bullish'
        : canonicalBrokerSummary.estimatedAmount5d < 0
          ? 'present_bearish'
          : 'present_neutral',
    broker: canonicalBrokerSummary
      ? {
          score40: round1(clamp(canonicalBrokerScore, 0, 40)),
          signedContribution40: round1(canonicalBrokerScore),
          netShares5d: Math.round(canonicalBrokerSummary.netShares5d),
          estimatedAmount5d: Math.round(canonicalBrokerSummary.estimatedAmount5d),
          turnoverIntensity5d: canonicalBrokerSummary.turnoverIntensity5d == null
            ? null
            : Math.round(canonicalBrokerSummary.turnoverIntensity5d * 10000) / 10000,
          brokerCount: canonicalBrokerSummary.latestBrokerCount,
          concentration: canonicalBrokerSummary.latestConcentration,
          marketSegment: canonicalBrokerSummary.marketSegment,
          source: canonicalBrokerSummary.latestSource,
          sourceDate: canonicalBrokerSummary.latestDate,
        }
      : null,
    creditLending: creditLendingSummary
      ? {
          adjustment: creditLendingSummary.adjustment,
          marginDelta: creditLendingSummary.marginDelta == null ? null : Math.round(creditLendingSummary.marginDelta),
          shortBalanceDelta: creditLendingSummary.shortBalanceDelta == null ? null : Math.round(creditLendingSummary.shortBalanceDelta),
          shortNetSell5d: creditLendingSummary.shortNetSell5d == null ? null : Math.round(creditLendingSummary.shortNetSell5d),
          lendingSellNet5d: creditLendingSummary.lendingSellNet5d == null ? null : Math.round(creditLendingSummary.lendingSellNet5d),
          lendingSellBalanceDelta: creditLendingSummary.lendingSellBalanceDelta == null ? null : Math.round(creditLendingSummary.lendingSellBalanceDelta),
          marginUsageRatio: creditLendingSummary.marginUsageRatio,
          shortUsageRatio: creditLendingSummary.shortUsageRatio,
        }
      : null,
  }

  // ?? P0-2: ?銵 (0-30) ??頞典?釭嚗??鞎瑁?⊥?隞嗆遛????
  let tech_score = 0

  // RSI 14嚗?0-68 ?航隅?Ｗ摨瑕?嚗?5+ 隞?”?撘瑚?餈賡?憸券銋?擃?
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

    const rsiScore = scoreRsiTrendQuality(rsi)
    tech_score += rsiScore
    if (rsiScore >= 6) reasons.push(`RSI ${rsi.toFixed(0)}`)
  }

  // MACD(12,26,9)
  if (prices.length >= 35) {
    const macdHistogram = macdHistogramLast(prices.map(p => p.close))
    if (macdHistogram != null && macdHistogram > 0) { tech_score += 6; reasons.push('MACD 憭') }
    else if (macdHistogram != null && macdHistogram > -(sc?.macdNegativeFactor ?? 0.5) * latestClose / 100) tech_score += 2
  }

  // ????
  if (prices.length >= 5) {
    const ma5 = prices.slice(-5).reduce((s, p) => s + p.close, 0) / 5
    if (latest.close > ma5) tech_score += 1
  }
  if (prices.length >= 20) {
    const ma20 = prices.slice(-20).reduce((s, p) => s + p.close, 0) / 20
    if (latest.close > ma20) { tech_score += 3; reasons.push('蝡?MA20') }

  }

  // P3-5: NATR 雿郭????雿郭??+ 頞典銝?= 蝛拙銝撞嚗?
  if (prices.length >= 14) {
    const trueRanges = prices.slice(-15).map((p, i, arr) => {
      if (i === 0) return p.max - p.min
      const prev = arr[i - 1]
      return Math.max(p.max - p.min, Math.abs(p.max - prev.close), Math.abs(p.min - prev.close))
    }).slice(1)
    const atr14 = trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length
    const natr = latestClose > 0 ? (atr14 / latestClose) * 100 : 0

    // ?舐蝝?蝒
    const ma20 = prices.slice(-Math.min(20, prices.length)).reduce((s, p) => s + p.close, 0) / Math.min(20, prices.length)
    const keltnerMult = sc?.keltnerMultiplier ?? 1.5
    if (latest.close > ma20 + keltnerMult * atr14 && atr14 > 0) {
      tech_score += 2
      reasons.push('keltner_breakout')
    }

    // NATR 雿郭??< threshold 銝??銝 = 蝛拙頞典嚗inLab IC 撽?嚗?
    if (natr < (sc?.natrThreshold ?? 3) && latest.close > ma20) tech_score += 1
  }
  tech_score = clamp(tech_score, 0, 30)

  // ?? ???(0-20) ????寞???? ??
  let momentum_score = 0

  // 5d excess return vs 憭抒 (0-7)
  if (prices.length >= 6) {
    const stockReturn = (latest.close - prices[prices.length - 6].close) / prices[prices.length - 6].close
    const excess = stockReturn - marketReturn5d
    const exRange = sc?.excessReturnRange ?? [-0.03, 0.05]
    momentum_score += normalize(excess, exRange[0], exRange[1], 7)
    if (excess > 0.02) reasons.push(`頞?+${(excess * 100).toFixed(1)}%`)
  }

  // ?瘥?餈?3 ??vs 20 ?亙???(0-5)
  if (prices.length >= 5) {
    const recent3 = prices.slice(-3).reduce((s, p) => s + p.Trading_Volume, 0) / 3
    const avg20 = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
    const volRatio = avg20 > 0 ? recent3 / avg20 : 1
    const vrRange = sc?.volRatioRange ?? [0.7, 2.5]
    momentum_score += normalize(volRatio, vrRange[0], vrRange[1], 5)
    if (volRatio > 1.5) reasons.push(`volume_ratio_${volRatio.toFixed(1)}x`)
  }

  // P1-3: ?寞???? (0-5) ??FinLab 蝺批?摮?
  // price_intent = N?亙??/ N?交??亦?撠?祉蜇??1=?渡?銝撞嚗?=?嚗?
  if (prices.length >= 15) {
    const n = Math.min(20, prices.length - 1)
    const retN = (latest.close - prices[prices.length - 1 - n].close) / prices[prices.length - 1 - n].close
    let sumAbsRet = 0
    for (let d = prices.length - n; d < prices.length; d++) {
      if (prices[d - 1].close > 0) sumAbsRet += Math.abs((prices[d].close - prices[d - 1].close) / prices[d - 1].close)
    }
    const priceIntent = sumAbsRet > 0 ? retN / sumAbsRet : 0
    // intent > 0.5 = 憭折?撞撟?渡?銝撞嚗蜓?風?方???
    if (priceIntent > 0.5) { momentum_score += 5; reasons.push(`??${(priceIntent * 100).toFixed(0)}%`) }
    else if (priceIntent > 0.3) momentum_score += 3
    else if (priceIntent > 0.1) momentum_score += 1
  }

  // RSI ??嚗SI > 75 ??3+ 憭抬??瑼餃? 80 ? 75嚗?
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
      reasons.push(`rsi_hot_consecutive_up_${consec}d`)
    }
  }
  momentum_score = clamp(momentum_score, 0, 20)

  const scoreV2 = buildPartialScreenerScoreV2({
    chipScore40: chip_score,
    techScore30: tech_score,
    momentumScore20: momentum_score,
    chipEvidence: chip_evidence,
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
    chip_evidence,
  } as {
    base_score: number
    chip_score: number
    tech_score: number
    momentum_score: number
    score_components: string
    reasons: string[]
    chip_evidence: Record<string, unknown>
  }
}

// RRG logic (classifyQuadrant / backfillRRG / calcIndustryRRG) removed in Phase 6.6
// of 4/8 audit. The Z-score formula used here was incorrect (not Julius de Kempenaer
// RRG). RRG is now computed by ml-controller/services/sector_flow_service.py using
// the vs-TWII benchmark formula (1+group_ret)/(1+twii_ret)*100. V2 LangGraph
// daily_pipeline_v2.py ??node_compute_sector_flow writes sector_flow with the
// correct formula for both concept ('theme') and industry tag_types.


/**
 * Bottom-up ?典??湧?∩蜓瘚?嚗2嚗?
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
  const endDate = resolveScreenerRunDate(runDate)
  const canonicalRegimeState = await readMarketRegimeState(env.KV)
  if (
    !canonicalRegimeState
    || canonicalRegimeState.source !== 'hmm'
    || canonicalRegimeState.run_date !== endDate
  ) {
    throw new Error(
      'screener_regime_pit_unavailable:expected=' + endDate
      + ':actual=' + (canonicalRegimeState?.run_date ?? 'missing')
      + ':source=' + (canonicalRegimeState?.source ?? 'missing'),
    )
  }
  const adaptiveParams = await getAdaptiveParamsForRegime(env.KV, canonicalRegimeState.family)
  const screenerPolicy = resolveScreenerPolicy(cfg, adaptiveParams)
  const runId = `screener-${endDate}-${Date.now()}`
  const funnelItems: ScreenerFunnelItemInput[] = []

  // ?? 鞈???嚗像銵???
  const { detectPttBuzz, storePttBuzz, loadBuzzKeywords } = await import('./pttBuzz')
  const { detectNewsBuzz } = await import('./newsBuzz')
  const { detectAnueBuzz } = await import('./anueBuzz')
  const {
    buzzResultsToThemeEvidence,
    combineMultiSourceThemeEvidence,
    loadRuntimeThemeSignals,
  } = await import('./multiSourceThemeEvidence')

  type BuzzResult = Awaited<ReturnType<typeof detectPttBuzz>>
  let allPrices: CanonicalScreenerPrice[]
  let stockTechnicalLongPrices: CanonicalScreenerPrice[] = []
  let emergingResearchPrices: CanonicalScreenerPrice[]
  let allChips: CanonicalScreenerChip[]
  let tpexSymbolSet = new Set<string>()
  let chipSourceSummary: Record<string, number> = {}
  let combinedBuzz: BuzzResult = []
  let conceptBuzzScore = new Map<string, number>()
  let conceptEvidenceBreakdown = new Map<string, Record<string, number>>()

  try {
    const buzzKeywords = await loadBuzzKeywords(env.DB, env.KV).catch(() => undefined)

    const [marketData, stockTechnicalMarketData, pttBuzz, newsBuzz, anueBuzz, runtimeThemeSignals] = await Promise.all([
      loadMarketDataFromD1(env, 70, 5, endDate),
      loadMarketDataFromD1(env, STOCK_TECHNICAL_HISTORY_PRICE_DAYS, 0, endDate)
        .catch(() => ({ allPrices: [] as CanonicalScreenerPrice[] })),
      detectPttBuzz(buzzKeywords).catch(() => [] as BuzzResult),
      detectNewsBuzz(env.DB, buzzKeywords).catch(() => [] as BuzzResult),
      detectAnueBuzz(buzzKeywords).catch(() => [] as BuzzResult),
      loadRuntimeThemeSignals(env.DB, endDate).catch(() => []),
    ])
    allPrices = marketData.allPrices
    stockTechnicalLongPrices = stockTechnicalMarketData.allPrices ?? []
    emergingResearchPrices = marketData.emergingResearchPrices
    allChips = marketData.allChips
    tpexSymbolSet = marketData.tpexSymbols
    chipSourceSummary = marketData.chipSourceSummary ?? {}

    // ?蔥 buzz嚗-score 璅???same as before嚗?
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
      `stockTechLongPrices=${stockTechnicalLongPrices.length} stockTechPriceDays=${STOCK_TECHNICAL_HISTORY_PRICE_DAYS} ` +
      `chips=${allChips.length} buzz=${combinedBuzz.length} theme_sources=${JSON.stringify(themeEvidence.acceptedSources)} ` +
      `lanes=${JSON.stringify(marketData.laneCounts)} chip_sources=${JSON.stringify(chipSourceSummary)}`,
    )
  } catch (e) {
    console.error('[Screener v2] Data fetch failed:', e)
    return { hotSectors: [], candidates: [] }
  }

  if (!allPrices.length) {
    console.warn('[Screener v2] No price data, aborting')
    return { hotSectors: [], candidates: [] }
  }

  // ?? ?蔭?⊥?????
  const restrictionPolicy = await loadRestrictedScreenerSymbols(env, endDate)
  const punishedSet = restrictionPolicy.hardBlockedSymbols
  const restrictionRiskSet = restrictionPolicy.riskEvidenceSymbols
  debugLog.push(`[Guard] trading restriction policy hard_block=${punishedSet.size} risk_evidence=${restrictionRiskSet.size} (attention/disposition are not L0 hard blocks)`)

  // ?? 霈???寧璆?mapping + 璁艙璅惜 ??
  const industryMap = await getIndustryMapping(env.DB, env.KV)
  const taxonomyUniverse = [...new Set([
    ...allPrices.map((p) => p.stock_id),
    ...emergingResearchPrices.map((p) => p.stock_id),
  ].map((symbol) => String(symbol || '').trim()).filter(Boolean))]
  const taxonomyProfiles = await loadSymbolTaxonomyProfiles(env.DB, taxonomyUniverse, endDate)
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

  // ?? ?∠巨?迂 mapping ??
  const sectorMap = await getSectorMapping(env)

  // ?? 撱箄???瑽???
  const data = buildStockData(allPrices, allChips)
  const stockTechnicalLongData = buildStockData(stockTechnicalLongPrices.length ? stockTechnicalLongPrices : allPrices, [])
  // 憭抒 5d return嚗 D1 ??0050嚗?憭批??0 ETF嚗???benchmark
  // 0050 餈質馱???嚗?蝛拙??之?支誨?瘝?撠梁???餈撮
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
      // ?岫 0050 ETF
      const row0050 = await env.DB.prepare(`
        SELECT
          (SELECT close FROM stock_prices sp JOIN stocks s ON sp.stock_id=s.id WHERE s.symbol='0050' AND sp.date=?) as latest,
          (SELECT close FROM stock_prices sp JOIN stocks s ON sp.stock_id=s.id WHERE s.symbol='0050' AND sp.date=?) as old
      `).bind(latestDate.d, fiveDaysAgoDate.date).first<{ latest: number; old: number }>()

      if (row0050?.latest && row0050?.old && row0050.old > 0) {
        marketReturn5d = (row0050.latest - row0050.old) / row0050.old
      } else {
        // Fallback: ?典??港葉雿嚗Ⅱ摰改?銝 LIMIT嚗?
        const { results: allRets } = await env.DB.prepare(`
          SELECT (sp1.close - sp2.close) / sp2.close as ret
          FROM stock_prices sp1
          JOIN stock_prices sp2 ON sp1.stock_id = sp2.stock_id
          WHERE sp1.date = ? AND sp2.date = ? AND sp2.close > 0
        `).bind(latestDate.d, fiveDaysAgoDate.date).all<{ ret: number }>()

        if (allRets?.length) {
          const sorted = allRets.map(r => r.ret).sort((a, b) => a - b)
          marketReturn5d = sorted[Math.floor(sorted.length / 2)]  // 銝凋???
        }
      }
    }
  } catch (e) {
    marketReturn5d = calcMarketReturn5d(data)
    console.warn('[Screener v2] D1 marketReturn ?亥岷憭望?嚗allback API:', e)
  }

  // ?? Step 1: Universe hard filter ??
  const universe: { stockId: string; prices: CanonicalScreenerPrice[] }[] = []
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
      pushFunnelItem(funnelItems, { symbol: stockId, stage: 'universe', decision: 'drop', reasonCode: 'hard_trading_restriction_block', evidence: { restricted: true, policy: 'hard_block' } })
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
    pushFunnelItem(funnelItems, {
      symbol: stockId,
      stage: 'universe',
      decision: 'pass',
      reasonCode: 'hard_filters_passed',
      evidence: {
        close: latest.close,
        avgVol20,
        avgDailyTurnover,
        tradingRestrictionRisk: restrictionRiskSet.has(stockId),
      },
    })
  }
  const universeMsg = `[Step 1] Universe: ${universe.length} passed | drops: price=${skipPrice} avgVol=${skipVol} turnover=${skipTurnover} restricted=${skipPunish} zeroVol=${skipVolZero} etf=${skipEtf} other=${data.prices.size - universe.length - skipPrice - skipVol - skipTurnover - skipPunish - skipVolZero - skipEtf}`
  debugLog.push(universeMsg)
  if (skipEtf > 0) debugLog.push(`[Step 1] hard gate excluded ETFs=${skipEtf}`)

  // ?? Step 2: 憭?摮?????
  const rawFundamentalLoad = await loadStrategyRawFundamentalSignals(
    env,
    universe.map((row) => row.stockId),
    endDate,
  )
  const rawFundamentalSignals = rawFundamentalLoad.fundamentals
  const rawSectorRotationSignals = await loadStrategyRawSectorRotationSignals(
    env,
    universe.map((row) => row.stockId),
    endDate,
  )
  debugLog.push(
    `[Step 1b] raw strategy signals: fundamentals=${rawFundamentalSignals.size}/${universe.length} ` +
    `canonical=${rawFundamentalLoad.telemetry.canonicalSymbols}/${universe.length} ` +
    `revenue=${rawFundamentalLoad.telemetry.revenueSymbols}/${universe.length} ` +
    `coverage=${JSON.stringify(rawFundamentalLoad.telemetry.fieldCoverage)} ` +
    `sector_rotation=${rawSectorRotationSignals.size}/${universe.length} ` +
    `sources=finlab.fundamental_features+finlab.monthly_revenue+sector_flow_stocks`,
  )
  if (rawFundamentalLoad.telemetry.canonicalErrors.length || rawFundamentalLoad.telemetry.revenueErrors.length) {
    debugLog.push(
      `[Step 1b] raw fundamental loader errors: ` +
      [...rawFundamentalLoad.telemetry.canonicalErrors, ...rawFundamentalLoad.telemetry.revenueErrors].slice(0, 4).join(' | '),
    )
  }
  const stockTechMarketRegime = deriveStockTechnicalMarketRegime(
    universe.map(({ stockId, prices }) => (stockTechnicalLongData.prices.get(stockId) ?? prices).map((price) => ({
      date: price.date,
      open: price.open,
      high: price.max,
      low: price.min,
      close: price.close,
      volume: price.Trading_Volume,
    }))),
  )

  type ScoredCandidate = ScreenerCandidate & {
    chip_score: number
    tech_score: number
    momentum_score: number
    score_components?: string
    raw_signals?: StrategyRawSignals
    industry: string
    market_segment: string
    current_price: number | null
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
    const industry = taxonomyDisplay(taxonomy, industryMap.get(stockId) ?? '?嗡?')

    const raw_signals = deriveStrategyRawSignals(
      prices,
      chipDates,
      rawFundamentalSignals.get(stockId),
      rawSectorRotationSignals.get(stockId),
      stockTechnicalLongData.prices.get(stockId),
    )

    scored.push({
      symbol: stockId,
      name: info?.name ?? stockId,
      sector: industry,
      score: base_score,
      reason: reasons.slice(0, 3).join(' | ') || 'base_score_candidate',
      chip_score, tech_score, momentum_score,
      score_components,
      raw_signals,
      current_price: finiteOrNull(latest.close),
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

  const finLabFactorNormalizationTelemetry = applyFinLabStyleFactorNormalization(scored)
  const stockTechnicalStrategyTelemetry = materializeStockTechnicalStrategyScores(scored, {
    marketRegime: stockTechMarketRegime,
  })
  const l0RawSignalCoverageAudit = buildL0RawSignalCoverageAudit(
    scored,
    universe.length,
    rawFundamentalLoad.telemetry,
    chipSourceSummary,
  )
  debugLog.push(
    `[Step 1c] FinLab-style factor normalization: method=${finLabFactorNormalizationTelemetry.method} ` +
    `cs=${JSON.stringify(finLabFactorNormalizationTelemetry.fieldCoverage)} ` +
    `sector=${JSON.stringify(finLabFactorNormalizationTelemetry.sectorFieldCoverage)} ` +
    `composite=${JSON.stringify(finLabFactorNormalizationTelemetry.compositeCoverage)} ` +
    `allocation=${JSON.stringify(finLabFactorNormalizationTelemetry.allocationCoverage)} ` +
    `special=${JSON.stringify(finLabFactorNormalizationTelemetry.specialFeatureMaterialization)}`,
  )
  debugLog.push(
    `[Step 1c2] stock technical strategy12 materialization: ` +
    `method=${stockTechnicalStrategyTelemetry.method} ` +
    `market=${JSON.stringify(stockTechnicalStrategyTelemetry.marketRegime)} ` +
    `scores=${JSON.stringify(stockTechnicalStrategyTelemetry.scoreCoverage)} ` +
    `signals=${JSON.stringify(stockTechnicalStrategyTelemetry.signalCoverage)} ` +
    `unsupported=${JSON.stringify(stockTechnicalStrategyTelemetry.unsupported)}`,
  )
  debugLog.push(
    `[Step 1d] L0 raw signal coverage audit: status=${l0RawSignalCoverageAudit.status} ` +
    `raw=${JSON.stringify(l0RawSignalCoverageAudit.rawCoverage)} ` +
    `canonical=${JSON.stringify(l0RawSignalCoverageAudit.canonicalCoverageBaseline)} ` +
    `broker_flow=${l0RawSignalCoverageAudit.brokerFlowMaterializationStatus} ` +
    `sources=${JSON.stringify(l0RawSignalCoverageAudit.sourceCoverage)} ` +
    `warnings=${JSON.stringify(l0RawSignalCoverageAudit.warnings)} failures=${JSON.stringify(l0RawSignalCoverageAudit.failures)}`,
  )

  applyScreenerScoreCalibration(scored, screenerPolicy.scoreCalibration)
  debugLog.push(
    `[Step 2b] score calibration ${screenerPolicy.scoreCalibration.enabled ? screenerPolicy.scoreCalibration.method : 'disabled'} ` +
    `pool=${screenerPolicy.sizing.candidatePoolSize} coarse_keep_ratio=${screenerPolicy.sizing.coarseMlKeepRatio} ` +
    `shortlist=${screenerPolicy.sizing.mlShortlistSize} ` +
    `emerging=${screenerPolicy.sizing.emergingResearchSize}`,
  )

  // Step 2 debug: top 30 scored
  debugLog.push(`[Step 2] 憭?摮????? ${scored.length} 瑼?| 憭抒 5d return=${(marketReturn5d * 100).toFixed(2)}%`)
  const scoredSorted = [...scored].sort((a, b) => b.score - a.score)
  const featureEnrichedUniverse = dedupeScreenerCandidatesBySymbol(scored)
  debugLog.push(`[Step 2] Top 15 (base_score):`)
  for (const c of scoredSorted.slice(0, 15)) {
    debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} | base=${c.score.toFixed(1)} chip=${c.chip_score} tech=${c.tech_score} mom=${c.momentum_score.toFixed(1)} | ${c.reason}`)
  }

  // Score ??
  const ranges = [
    { label: '60+', min: 60 }, { label: '50-60', min: 50 }, { label: '40-50', min: 40 },
    { label: '30-40', min: 30 }, { label: '20-30', min: 20 }, { label: '<20', min: 0 },
  ]
  debugLog.push(`[Step 2] ???: ${ranges.map(r => `${r.label}=${scored.filter(c => c.score >= r.min && (r.min === 0 || c.score < r.min + 10)).length}`).join(' ')}`)

  const coarseQueueSize = screenerPolicy.sizing.coarseMlQueueSize
  const maxCandidates = screenerPolicy.sizing.mlShortlistSize
  let strategySelectionTelemetry: Record<string, unknown> | null = null
  let strategySelectionPlan: any | null = null
  const strategySourceUniverse = featureEnrichedUniverse
  let layer1BreadthPool: ScoredCandidate[] = []
  let layer2CoarseQueueSeed: ScoredCandidate[] = []
  let layer1AdaptiveTargetSize = screenerPolicy.sizing.candidatePoolSize
  let overlayEligibleSymbols = new Set<string>()
  let passesLayer1TopUpQualityGuard: ((candidate: any) => boolean) | null = null
  let runtimeStrategySpecs: StrategySpec[] = []
  let runtimeStrategyRegime: string | null = null
  let selectionEvidence: {
    references: SelectionReferenceRowV1[]
    matrix: StrategyLabelMatrixRowV4[]
    strategyCount: number
    strategyRegistryChecksum: string
    labelerVersion: string
  } | null = null
  try {
    const [{ listStrategySpecsForLearning, getLatestStrategyPolicyState }, strategyCandidatePoolModule, strategyPortfolioMetricsModule] = await Promise.all([
      import('./strategyLearning'),
      import('./strategyCandidatePool'),
      import('./strategyPortfolioMetrics'),
    ])
    const { buildLayer1StrategyBreadthPlan } = strategyCandidatePoolModule
    const { loadStrategyPortfolioMetricOverrides } = strategyPortfolioMetricsModule
    passesLayer1TopUpQualityGuard = strategyCandidatePoolModule.passesLayer1TopUpQualityGuard
    const currentRegime = canonicalRegimeState.family
    runtimeStrategyRegime = currentRegime
    const [{ specs, source, registryRowCount, activeCount }, policyState] = await Promise.all([
      listStrategySpecsForLearning(env.DB),
      getLatestStrategyPolicyState(env.DB).catch(() => null),
    ])
    runtimeStrategySpecs = specs
    const { loadPromotedStrategyMarginalEdgeWeightsV4 } = await import('./strategyMarginalEdgeV4')
    const [marginalEdgeLoad, strategyOofLoad] = await Promise.all([
      loadPromotedStrategyMarginalEdgeWeightsV4(
        env.DB,
        specs.map((spec: StrategySpec) => spec.id),
      )
        .then((value) => ({ value, error: null as string | null }))
        .catch((error) => ({
          value: null,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        })),
      loadMatureStrategyOofReturns(env.DB, endDate)
        .then((returns) => ({ returns, error: null as string | null }))
        .catch((error) => ({
          returns: {} as Record<string, Array<{ signal_date: string; residual_return: number; sample_count: number }>>,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        })),
    ])
    const marginalEdgeState = marginalEdgeLoad.value
    const strategyOofReturns = strategyOofLoad.returns
    const activeStrategyWeights = marginalEdgeState?.weights
      ?? (policyState?.status === 'active' ? policyState.strategy_weights : undefined)
    const strategySimilarityPayload = buildStrategySimilarityEvidencePayload(
      strategySourceUniverse as any,
      specs,
      {
        regime: currentRegime,
        strategyWeights: activeStrategyWeights,
      },
      strategyOofReturns,
    )
    const { loadPromotedStrategyRouteCalibration } = await import('./strategyRouteCalibration')
    const [strategyPortfolioMetrics, strategySimilarityEvidence, runtimeTeacherEvidence, previousL15SlateLoad, promotedRouteCalibrationLoad] = await Promise.all([
      loadStrategyPortfolioMetricOverrides(env.DB, {
        regime: currentRegime,
        marketSegment: 'all',
        asOfDate: endDate,
        minSamples: 5,
        knownStrategyIds: specs.map((spec: any) => String(spec.id || '').trim()).filter(Boolean),
      }),
      loadL125StrategySimilarityGraphEvidence(env, strategySimilarityPayload, endDate),
      loadRuntimeTeacherEvidence(
        env.DB,
        strategySourceUniverse.map((candidate: any) => String(candidate.symbol || '').trim()).filter(Boolean),
        {
          runDate: endDate,
          lookbackDays: 30,
          verifiedOnly: true,
        },
      ),
      loadPreviousCanonicalL15Slate(env.DB, endDate)
        .then((value) => ({ value, error: null as string | null }))
        .catch((error) => ({
          value: { date: null, runId: null, symbols: [] as string[] },
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        })),
      loadPromotedStrategyRouteCalibration(env.DB)
        .then((value) => ({ value, error: null as string | null }))
        .catch((error) => ({
          value: null,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        })),
    ])
    const previousL15Slate = previousL15SlateLoad.value
    const promotedRouteCalibration = promotedRouteCalibrationLoad.value
    const layer1BreadthPlan = buildLayer1StrategyBreadthPlan(
      strategySourceUniverse as any,
      specs,
      {
        targetSize: screenerPolicy.sizing.candidatePoolSize,
        coarseMlQueueSize: coarseQueueSize,
        regime: currentRegime,
        strategyWeights: activeStrategyWeights,
        strategyPortfolioMetrics: strategyPortfolioMetrics.metrics,
        strategyPortfolioMetricSource: strategyPortfolioMetrics.telemetry.source,
        strategySimilarityGraphEvidence: strategySimilarityEvidence.evidence,
        runtimeTeacherEvidence: runtimeTeacherEvidence.labels,
        previousSlateSymbols: previousL15Slate.symbols,
        promotedRouteCalibration,
      },
    )
    strategySelectionPlan = layer1BreadthPlan.selection
    layer1BreadthPool = layer1BreadthPlan.breadthPool as ScoredCandidate[]
    layer2CoarseQueueSeed = layer1BreadthPlan.coarseQueue as ScoredCandidate[]
    layer1AdaptiveTargetSize = Number(layer1BreadthPlan.telemetry.adaptive_target_size ?? layer1BreadthPlan.telemetry.target_size ?? screenerPolicy.sizing.candidatePoolSize)
    overlayEligibleSymbols = new Set(layer1BreadthPool.map((candidate) => String(candidate.symbol || '').trim()).filter(Boolean))
    const strategyRegistryChecksum = await sha256Text(JSON.stringify(strategyRegistryFingerprintPayload(specs)))
    const builtSelectionEvidence = buildSelectionEvidenceV4({
      signalDate: endDate,
      producerRunId: runId,
      candidates: layer1BreadthPlan.l0Annotated as any[],
      specs,
      strategyRegistryChecksum,
    })
    selectionEvidence = {
      ...builtSelectionEvidence,
      strategyRegistryChecksum,
      labelerVersion: String(layer1BreadthPlan.telemetry.strategy_labeler_version ?? ''),
    }
    if (!selectionEvidence.labelerVersion) throw new Error('strategy_label_matrix_labeler_version_missing')
    strategySelectionTelemetry = {
      version: layer1BreadthPlan.version,
      candidate_pool_version: strategySelectionPlan.version,
      spec_source: source,
      strategy_registry_row_count: registryRowCount,
      strategy_registry_active_count: activeCount,
      strategy_registry_runtime_count: specs.length,
      capacity: strategySelectionPlan.capacity,
      telemetry: strategySelectionPlan.telemetry,
      layer1_telemetry: layer1BreadthPlan.telemetry,
      source_universe_count: strategySourceUniverse.length,
      layer1_breadth_count: layer1BreadthPool.length,
      layer2_coarse_queue_seed_count: layer2CoarseQueueSeed.length,
      selection_order: layer1BreadthPlan.telemetry.selection_order,
      strategy_labeler_version: layer1BreadthPlan.telemetry.strategy_labeler_version ?? null,
      finlab_portfolio_intelligence_version: layer1BreadthPlan.telemetry.finlab_portfolio_intelligence_version ?? null,
      l15_router_version: layer1BreadthPlan.telemetry.l15_router_version ?? null,
      l15_router_selection_order: layer1BreadthPlan.telemetry.l15_router_selection_order ?? null,
      l15_router_ml_slate_count: layer1BreadthPlan.telemetry.l15_router_ml_slate_count ?? null,
      l15_router_observe_only_count: layer1BreadthPlan.telemetry.l15_router_observe_only_count ?? null,
      l15_router_capacity_overflow_count: layer1BreadthPlan.telemetry.l15_router_capacity_overflow_count ?? null,
      l15_router_slate_selection_policy: layer1BreadthPlan.telemetry.l15_router_slate_selection_policy ?? null,
      l15_soft_capacity_baseline: layer1BreadthPlan.telemetry.soft_capacity_baseline ?? null,
      l15_adaptive_target_size: layer1BreadthPlan.telemetry.adaptive_target_size ?? null,
      l15_adaptive_capacity_max: layer1BreadthPlan.telemetry.adaptive_capacity_max ?? null,
      l15_adaptive_capacity_policy: layer1BreadthPlan.telemetry.adaptive_capacity_policy ?? null,
      l15_adaptive_capacity_reason: layer1BreadthPlan.telemetry.adaptive_capacity_reason ?? null,
      l15_adaptive_capacity_eligible_count: layer1BreadthPlan.telemetry.adaptive_capacity_eligible_count ?? null,
      l15_adaptive_target_size_before_dynamic_quota: layer1BreadthPlan.telemetry.adaptive_target_size_before_dynamic_quota ?? null,
      l15_dynamic_effective_quota_policy: layer1BreadthPlan.telemetry.dynamic_effective_quota_policy ?? null,
      l15_dynamic_effective_quota_total: layer1BreadthPlan.telemetry.dynamic_effective_quota_total ?? null,
      l15_dynamic_effective_quota_by_strategy: layer1BreadthPlan.telemetry.dynamic_effective_quota_by_strategy ?? null,
      l15_adaptive_strategy_policy_version: layer1BreadthPlan.telemetry.adaptive_strategy_policy_version ?? null,
      l15_adaptive_pool_quota_by_strategy: layer1BreadthPlan.telemetry.adaptive_pool_quota_by_strategy ?? null,
      l15_adaptive_cost_budget_by_strategy: layer1BreadthPlan.telemetry.adaptive_cost_budget_by_strategy ?? null,
      l15_adaptive_max_ml_share_by_strategy: layer1BreadthPlan.telemetry.adaptive_max_ml_share_by_strategy ?? null,
      l15_static_pool_quota_by_strategy: layer1BreadthPlan.telemetry.static_pool_quota_by_strategy ?? null,
      l15_static_cost_budget_by_strategy: layer1BreadthPlan.telemetry.static_cost_budget_by_strategy ?? null,
      l15_static_max_ml_share_by_strategy: layer1BreadthPlan.telemetry.static_max_ml_share_by_strategy ?? null,
      strategy_matrix_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_candidate_count ?? null,
      strategy_matrix_strategy_count: layer1BreadthPlan.telemetry.strategy_matrix_strategy_count ?? null,
      strategy_matrix_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_cell_count ?? null,
      strategy_matrix_expected_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_expected_cell_count ?? null,
      strategy_matrix_coverage_ratio: layer1BreadthPlan.telemetry.strategy_matrix_coverage_ratio ?? null,
      strategy_matrix_matched_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_matched_candidate_count ?? null,
      strategy_matrix_active_labeled_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_active_labeled_candidate_count ?? null,
      min_route_score: layer1BreadthPlan.telemetry.min_route_score ?? null,
      min_route_score_source: layer1BreadthPlan.telemetry.min_route_score_source ?? null,
      route_score_distribution: layer1BreadthPlan.telemetry.route_score_distribution ?? null,
      route_score_above_floor_count: layer1BreadthPlan.telemetry.route_score_above_floor_count ?? null,
      route_score_below_floor_count: layer1BreadthPlan.telemetry.route_score_below_floor_count ?? null,
      previous_l15_slate_date: previousL15Slate.date,
      previous_l15_slate_run_id: previousL15Slate.runId,
      previous_l15_slate_load_error: previousL15SlateLoad.error,
      strategy_oof_return_strategy_count: Object.keys(strategyOofReturns).length,
      strategy_oof_return_load_error: strategyOofLoad.error,
      promoted_route_calibration_run_id: promotedRouteCalibration?.runId ?? null,
      promoted_route_calibration_load_error: promotedRouteCalibrationLoad.error,
      promoted_marginal_edge_run_id: marginalEdgeState?.runId ?? null,
      promoted_marginal_edge_load_error: marginalEdgeLoad.error,
      previous_l15_slate_count: layer1BreadthPlan.telemetry.previous_slate_count ?? null,
      l15_temporal_intersection_count: layer1BreadthPlan.telemetry.temporal_intersection_count ?? null,
      l15_temporal_jaccard: layer1BreadthPlan.telemetry.temporal_jaccard ?? null,
      l15_previous_list_recall: layer1BreadthPlan.telemetry.previous_list_recall ?? null,
      l15_fresh_share: layer1BreadthPlan.telemetry.fresh_share ?? null,
      teacher_label_available_count: layer1BreadthPlan.telemetry.teacher_label_available_count ?? null,
      teacher_label_missing_count: layer1BreadthPlan.telemetry.teacher_label_missing_count ?? null,
      teacher_label_contract: layer1BreadthPlan.telemetry.teacher_label_contract ?? null,
      runtime_teacher_evidence_policy: layer1BreadthPlan.telemetry.runtime_teacher_evidence_policy ?? null,
      runtime_teacher_evidence_available_count: layer1BreadthPlan.telemetry.runtime_teacher_evidence_available_count ?? null,
      runtime_teacher_evidence_missing_count: layer1BreadthPlan.telemetry.runtime_teacher_evidence_missing_count ?? null,
      runtime_teacher_evidence: runtimeTeacherEvidence.telemetry,
      strategy_metric_status_counts: layer1BreadthPlan.telemetry.strategy_metric_status_counts ?? null,
      strategy_metric_ready_count: layer1BreadthPlan.telemetry.strategy_metric_ready_count ?? null,
      strategy_metric_no_evidence_count: layer1BreadthPlan.telemetry.strategy_metric_no_evidence_count ?? null,
      strategy_similarity_evidence_status: strategySimilarityEvidence.status,
      strategy_similarity_evidence_source: layer1BreadthPlan.telemetry.strategy_similarity_evidence_source ?? null,
      strategy_similarity_algorithm_owner: layer1BreadthPlan.telemetry.strategy_similarity_algorithm_owner ?? null,
      strategy_similarity_medoid_algorithm: layer1BreadthPlan.telemetry.strategy_similarity_medoid_algorithm ?? null,
      strategy_similarity_blocked_reason: strategySimilarityEvidence.error ?? layer1BreadthPlan.telemetry.strategy_similarity_blocked_reason ?? null,
      strategy_similarity_payload_strategy_count: strategySimilarityEvidence.payload_strategy_count,
      strategy_similarity_artifact_id: strategySimilarityEvidence.artifact_id ?? null,
      strategy_portfolio_metrics: strategyPortfolioMetrics.telemetry,
      pool_status: strategySelectionPlan.pools.map((pool: any) => ({
        strategy_id: pool.strategy_id,
        status: pool.status,
        daily_match_status: pool.daily_match_status,
        strict_match_count: pool.strict_match_count,
        near_match_count: pool.near_match_count,
        quota: pool.quota,
        static_quota: pool.static_quota,
        cost_budget: pool.cost_budget,
        static_cost_budget: pool.static_cost_budget,
        max_ml_share: pool.max_ml_share,
        static_max_ml_share: pool.static_max_ml_share,
        adaptive_policy: pool.adaptive_policy,
        candidates: pool.candidates.length,
        regime_scope: pool.regime_scope,
        missing_evidence: pool.missing_evidence,
      })),
    }
    debugLog.push(
      `[Step 2c] layer1_breadth=${layer1BreadthPlan.version} source=${source} ` +
      `source_universe=${strategySourceUniverse.length} layer1=${layer1BreadthPool.length}/${layer1AdaptiveTargetSize} baseline=${screenerPolicy.sizing.candidatePoolSize} ` +
      `coarse_seed=${layer2CoarseQueueSeed.length} keep_ratio=${screenerPolicy.sizing.coarseMlKeepRatio} core_ml=${maxCandidates} ` +
      `research_only=${strategySelectionPlan.researchOnlyQueue.length} overflow=${strategySelectionPlan.telemetry.overflow_count} ` +
      `cap=${strategySelectionPlan.capacity.mlQueueCap}/${strategySelectionPlan.capacity.totalCap} mode=${strategySelectionPlan.capacity.mode} ` +
      `l125_metrics=${strategyPortfolioMetrics.telemetry.status}:${strategyPortfolioMetrics.telemetry.metric_count} ` +
      `l125_similarity=${strategySimilarityEvidence.status}:${layer1BreadthPlan.telemetry.strategy_similarity_evidence_source ?? 'unknown'}`,
    )
    layer1BreadthPool.forEach((candidate, index) => {
      const isObserveTopUp = String((candidate as any).strategy_pool_fallback_source ?? '') === 'raw_signal_top_up'
      pushFunnelItem(funnelItems, {
        symbol: candidate.symbol,
        name: candidate.name,
        stage: 'layer1_strategy_breadth_gate',
        decision: isObserveTopUp ? 'observe' : 'pass',
        reasonCode: String((candidate as any).strategy_pool_reason ?? 'strategy_breadth_seed'),
        scoreAfter: candidate.score,
        rank: index + 1,
        evidence: {
          strategy_ids: (candidate as any).strategy_pool_ids ?? [],
          strategy_family_ids: (candidate as any).strategy_family_ids ?? [],
          strategy_variant_ids: (candidate as any).strategy_variant_ids ?? [],
          strategy_owner_types: (candidate as any).strategy_owner_types ?? [],
          research_strategy_ids: (candidate as any).research_strategy_ids ?? [],
          strategy_pool_fallback_source: (candidate as any).strategy_pool_fallback_source ?? null,
          strategy_pool_score: (candidate as any).strategy_pool_score ?? null,
          strategy_labeler_version: (candidate as any).strategy_labeler_version ?? null,
          finlab_portfolio_intelligence_version: layer1BreadthPlan.telemetry.finlab_portfolio_intelligence_version ?? null,
          strategy_router_version: (candidate as any).strategy_router_version ?? null,
          l15_router_slate_selection_policy: layer1BreadthPlan.telemetry.l15_router_slate_selection_policy ?? null,
          strategy_router_score: (candidate as any).strategy_router_score ?? null,
          strategy_router_decision: (candidate as any).strategy_router_decision ?? null,
          strategy_router_reason: (candidate as any).strategy_router_reason ?? null,
          strategy_router_components: (candidate as any).strategy_router_components ?? null,
          strategy_portfolio_metric_source: strategyPortfolioMetrics.telemetry.source,
          strategy_portfolio_metric_status: strategyPortfolioMetrics.telemetry.status,
          strategy_portfolio_metric_count: strategyPortfolioMetrics.telemetry.metric_count,
          strategy_portfolio_backtest_metric_count: strategyPortfolioMetrics.telemetry.backtest_metric_count ?? null,
          strategy_portfolio_backtest_result_row_count: strategyPortfolioMetrics.telemetry.backtest_result_row_count ?? null,
          strategy_matrix_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_candidate_count ?? null,
          strategy_matrix_strategy_count: layer1BreadthPlan.telemetry.strategy_matrix_strategy_count ?? null,
          strategy_matrix_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_cell_count ?? null,
          strategy_matrix_expected_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_expected_cell_count ?? null,
          strategy_matrix_coverage_ratio: layer1BreadthPlan.telemetry.strategy_matrix_coverage_ratio ?? null,
          strategy_matrix_matched_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_matched_candidate_count ?? null,
          strategy_matrix_active_labeled_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_active_labeled_candidate_count ?? null,
          min_route_score: layer1BreadthPlan.telemetry.min_route_score ?? null,
          min_route_score_source: layer1BreadthPlan.telemetry.min_route_score_source ?? null,
          route_score_distribution: layer1BreadthPlan.telemetry.route_score_distribution ?? null,
          route_score_above_floor_count: layer1BreadthPlan.telemetry.route_score_above_floor_count ?? null,
          route_score_below_floor_count: layer1BreadthPlan.telemetry.route_score_below_floor_count ?? null,
          teacher_label_available_count: layer1BreadthPlan.telemetry.teacher_label_available_count ?? null,
          teacher_label_missing_count: layer1BreadthPlan.telemetry.teacher_label_missing_count ?? null,
          strategy_metric_status_counts: layer1BreadthPlan.telemetry.strategy_metric_status_counts ?? null,
          strategy_similarity_evidence_status: strategySimilarityEvidence.status,
          strategy_similarity_evidence_source: layer1BreadthPlan.telemetry.strategy_similarity_evidence_source ?? null,
          strategy_similarity_algorithm_owner: layer1BreadthPlan.telemetry.strategy_similarity_algorithm_owner ?? null,
          strategy_similarity_medoid_algorithm: layer1BreadthPlan.telemetry.strategy_similarity_medoid_algorithm ?? null,
          strategy_similarity_blocked_reason: strategySimilarityEvidence.error ?? layer1BreadthPlan.telemetry.strategy_similarity_blocked_reason ?? null,
          candidate_route_score: (candidate as any).candidate_route_score ?? null,
          ml_slate_eligibility: (candidate as any).ml_slate_eligibility ?? null,
          family_exposure: (candidate as any).family_exposure ?? null,
          diversity_contribution: (candidate as any).diversity_contribution ?? null,
          risk_adjusted_affinity: (candidate as any).risk_adjusted_affinity ?? null,
          uncertainty: (candidate as any).uncertainty ?? null,
          runtime_teacher_evidence: (candidate as any).runtime_teacher_evidence ?? null,
          runtime_teacher_evidence_source: (candidate as any).runtime_teacher_evidence_source ?? null,
          ml_teacher_labels: (candidate as any).ml_teacher_labels ?? null,
          strategy_affinity_vector: (candidate as any).strategy_affinity_vector ?? null,
          strategy_weak_label_vector: (candidate as any).strategy_weak_label_vector ?? null,
          strategy_hit_vector: (candidate as any).strategy_hit_vector ?? null,
          strategy_position_weight_vector: (candidate as any).strategy_position_weight_vector ?? null,
          strategy_overlap_vector: (candidate as any).strategy_overlap_vector ?? null,
          strategy_family_affinity: (candidate as any).strategy_family_affinity ?? null,
          target_size: layer1BreadthPlan.telemetry.target_size,
          soft_capacity_baseline: layer1BreadthPlan.telemetry.soft_capacity_baseline ?? null,
          adaptive_target_size: layer1BreadthPlan.telemetry.adaptive_target_size ?? null,
          adaptive_capacity_max: layer1BreadthPlan.telemetry.adaptive_capacity_max ?? null,
          adaptive_capacity_policy: layer1BreadthPlan.telemetry.adaptive_capacity_policy ?? null,
          adaptive_capacity_reason: layer1BreadthPlan.telemetry.adaptive_capacity_reason ?? null,
          adaptive_capacity_eligible_count: layer1BreadthPlan.telemetry.adaptive_capacity_eligible_count ?? null,
          adaptive_target_size_before_dynamic_quota: layer1BreadthPlan.telemetry.adaptive_target_size_before_dynamic_quota ?? null,
          dynamic_effective_quota_policy: layer1BreadthPlan.telemetry.dynamic_effective_quota_policy ?? null,
          dynamic_effective_quota_total: layer1BreadthPlan.telemetry.dynamic_effective_quota_total ?? null,
          dynamic_effective_quota_by_strategy: layer1BreadthPlan.telemetry.dynamic_effective_quota_by_strategy ?? null,
          adaptive_strategy_policy_version: layer1BreadthPlan.telemetry.adaptive_strategy_policy_version ?? null,
          adaptive_pool_quota_by_strategy: layer1BreadthPlan.telemetry.adaptive_pool_quota_by_strategy ?? null,
          adaptive_cost_budget_by_strategy: layer1BreadthPlan.telemetry.adaptive_cost_budget_by_strategy ?? null,
          adaptive_max_ml_share_by_strategy: layer1BreadthPlan.telemetry.adaptive_max_ml_share_by_strategy ?? null,
          static_pool_quota_by_strategy: layer1BreadthPlan.telemetry.static_pool_quota_by_strategy ?? null,
          static_cost_budget_by_strategy: layer1BreadthPlan.telemetry.static_cost_budget_by_strategy ?? null,
          static_max_ml_share_by_strategy: layer1BreadthPlan.telemetry.static_max_ml_share_by_strategy ?? null,
          coarse_ml_queue_size_legacy: screenerPolicy.sizing.coarseMlQueueSize,
          coarse_ml_keep_ratio: screenerPolicy.sizing.coarseMlKeepRatio,
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
          formal_l2_queue: !isObserveTopUp,
        },
      })
    })
    layer2CoarseQueueSeed.forEach((candidate, index) => {
      pushFunnelItem(funnelItems, {
        symbol: candidate.symbol,
        name: candidate.name,
        stage: 'l15_ml_slate_queue',
        decision: 'observe',
        reasonCode: 'ml_slate_queue_seed_from_l1_5_router',
        scoreAfter: candidate.score,
        rank: index + 1,
        evidence: {
          worker_seed_only: true,
          layer_contract: 'L1.5 router owns ML slate queue; ml-controller owns L2 TimesFM feature enrichment before L3 8ML',
          downstream_owner: 'ml-controller',
          downstream_stage: 'layer2_timesfm_enrichment',
          strategy_ids: (candidate as any).strategy_pool_ids ?? [],
          strategy_family_ids: (candidate as any).strategy_family_ids ?? [],
          strategy_variant_ids: (candidate as any).strategy_variant_ids ?? [],
          strategy_owner_types: (candidate as any).strategy_owner_types ?? [],
          research_strategy_ids: (candidate as any).research_strategy_ids ?? [],
          strategy_pool_fallback_source: (candidate as any).strategy_pool_fallback_source ?? null,
          strategy_pool_reason: (candidate as any).strategy_pool_reason ?? null,
          strategy_labeler_version: (candidate as any).strategy_labeler_version ?? null,
          finlab_portfolio_intelligence_version: layer1BreadthPlan.telemetry.finlab_portfolio_intelligence_version ?? null,
          strategy_router_version: (candidate as any).strategy_router_version ?? null,
          l15_router_slate_selection_policy: layer1BreadthPlan.telemetry.l15_router_slate_selection_policy ?? null,
          strategy_router_score: (candidate as any).strategy_router_score ?? null,
          strategy_router_decision: (candidate as any).strategy_router_decision ?? null,
          strategy_router_reason: (candidate as any).strategy_router_reason ?? null,
          strategy_router_components: (candidate as any).strategy_router_components ?? null,
          strategy_portfolio_metric_source: strategyPortfolioMetrics.telemetry.source,
          strategy_portfolio_metric_status: strategyPortfolioMetrics.telemetry.status,
          strategy_portfolio_metric_count: strategyPortfolioMetrics.telemetry.metric_count,
          strategy_portfolio_backtest_metric_count: strategyPortfolioMetrics.telemetry.backtest_metric_count ?? null,
          strategy_portfolio_backtest_result_row_count: strategyPortfolioMetrics.telemetry.backtest_result_row_count ?? null,
          strategy_matrix_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_candidate_count ?? null,
          strategy_matrix_strategy_count: layer1BreadthPlan.telemetry.strategy_matrix_strategy_count ?? null,
          strategy_matrix_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_cell_count ?? null,
          strategy_matrix_expected_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_expected_cell_count ?? null,
          strategy_matrix_coverage_ratio: layer1BreadthPlan.telemetry.strategy_matrix_coverage_ratio ?? null,
          strategy_matrix_matched_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_matched_candidate_count ?? null,
          strategy_matrix_active_labeled_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_active_labeled_candidate_count ?? null,
          min_route_score: layer1BreadthPlan.telemetry.min_route_score ?? null,
          min_route_score_source: layer1BreadthPlan.telemetry.min_route_score_source ?? null,
          route_score_distribution: layer1BreadthPlan.telemetry.route_score_distribution ?? null,
          route_score_above_floor_count: layer1BreadthPlan.telemetry.route_score_above_floor_count ?? null,
          route_score_below_floor_count: layer1BreadthPlan.telemetry.route_score_below_floor_count ?? null,
          teacher_label_available_count: layer1BreadthPlan.telemetry.teacher_label_available_count ?? null,
          teacher_label_missing_count: layer1BreadthPlan.telemetry.teacher_label_missing_count ?? null,
          strategy_metric_status_counts: layer1BreadthPlan.telemetry.strategy_metric_status_counts ?? null,
          candidate_route_score: (candidate as any).candidate_route_score ?? null,
          ml_slate_eligibility: (candidate as any).ml_slate_eligibility ?? null,
          family_exposure: (candidate as any).family_exposure ?? null,
          diversity_contribution: (candidate as any).diversity_contribution ?? null,
          risk_adjusted_affinity: (candidate as any).risk_adjusted_affinity ?? null,
          uncertainty: (candidate as any).uncertainty ?? null,
          runtime_teacher_evidence: (candidate as any).runtime_teacher_evidence ?? null,
          runtime_teacher_evidence_source: (candidate as any).runtime_teacher_evidence_source ?? null,
          ml_teacher_labels: (candidate as any).ml_teacher_labels ?? null,
          strategy_affinity_vector: (candidate as any).strategy_affinity_vector ?? null,
          strategy_weak_label_vector: (candidate as any).strategy_weak_label_vector ?? null,
          strategy_hit_vector: (candidate as any).strategy_hit_vector ?? null,
          strategy_position_weight_vector: (candidate as any).strategy_position_weight_vector ?? null,
          strategy_overlap_vector: (candidate as any).strategy_overlap_vector ?? null,
          strategy_family_affinity: (candidate as any).strategy_family_affinity ?? null,
          raw_signals: candidate.raw_signals ?? null,
          layer1_rank: (candidate as any).strategy_pool_rank ?? index + 1,
          coarse_ml_queue_size_legacy: screenerPolicy.sizing.coarseMlQueueSize,
          coarse_ml_keep_ratio: screenerPolicy.sizing.coarseMlKeepRatio,
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
        decision: 'observe',
        reasonCode: String(entry.strategy_pool_reason ?? 'selected_by_strategy_pool'),
        scoreAfter: Number(entry.strategy_pool_score ?? entry.score ?? 0),
        rank: entry.strategy_pool_rank ?? null,
        evidence: {
          production_seed_allowed: false,
          audit_lane_only: true,
          layer_contract: 'strategy_pool_ml_queue is strategy evidence audit only; L2 production seed must come from L1.5 router slate',
          strategy_ids: entry.strategy_pool_ids ?? [],
          strategy_family_ids: entry.strategy_family_ids ?? [],
          strategy_variant_ids: entry.strategy_variant_ids ?? [],
          strategy_owner_types: entry.strategy_owner_types ?? [],
          research_strategy_ids: entry.research_strategy_ids ?? [],
          strategy_pool_fallback_source: entry.strategy_pool_fallback_source ?? null,
          strategy_pool_score: entry.strategy_pool_score ?? null,
          strategy_pool_decision: entry.strategy_pool_decision ?? null,
          strategy_labeler_version: entry.strategy_labeler_version ?? null,
          finlab_portfolio_intelligence_version: layer1BreadthPlan.telemetry.finlab_portfolio_intelligence_version ?? null,
          strategy_router_version: entry.strategy_router_version ?? null,
          l15_router_slate_selection_policy: layer1BreadthPlan.telemetry.l15_router_slate_selection_policy ?? null,
          strategy_router_score: entry.strategy_router_score ?? null,
          strategy_router_decision: entry.strategy_router_decision ?? null,
          strategy_router_reason: entry.strategy_router_reason ?? null,
          strategy_router_components: entry.strategy_router_components ?? null,
          strategy_portfolio_metric_source: strategyPortfolioMetrics.telemetry.source,
          strategy_portfolio_metric_status: strategyPortfolioMetrics.telemetry.status,
          strategy_portfolio_metric_count: strategyPortfolioMetrics.telemetry.metric_count,
          strategy_portfolio_backtest_metric_count: strategyPortfolioMetrics.telemetry.backtest_metric_count ?? null,
          strategy_portfolio_backtest_result_row_count: strategyPortfolioMetrics.telemetry.backtest_result_row_count ?? null,
          strategy_matrix_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_candidate_count ?? null,
          strategy_matrix_strategy_count: layer1BreadthPlan.telemetry.strategy_matrix_strategy_count ?? null,
          strategy_matrix_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_cell_count ?? null,
          strategy_matrix_expected_cell_count: layer1BreadthPlan.telemetry.strategy_matrix_expected_cell_count ?? null,
          strategy_matrix_coverage_ratio: layer1BreadthPlan.telemetry.strategy_matrix_coverage_ratio ?? null,
          strategy_matrix_matched_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_matched_candidate_count ?? null,
          strategy_matrix_active_labeled_candidate_count: layer1BreadthPlan.telemetry.strategy_matrix_active_labeled_candidate_count ?? null,
          min_route_score: layer1BreadthPlan.telemetry.min_route_score ?? null,
          min_route_score_source: layer1BreadthPlan.telemetry.min_route_score_source ?? null,
          route_score_distribution: layer1BreadthPlan.telemetry.route_score_distribution ?? null,
          route_score_above_floor_count: layer1BreadthPlan.telemetry.route_score_above_floor_count ?? null,
          route_score_below_floor_count: layer1BreadthPlan.telemetry.route_score_below_floor_count ?? null,
          teacher_label_available_count: layer1BreadthPlan.telemetry.teacher_label_available_count ?? null,
          teacher_label_missing_count: layer1BreadthPlan.telemetry.teacher_label_missing_count ?? null,
          strategy_metric_status_counts: layer1BreadthPlan.telemetry.strategy_metric_status_counts ?? null,
          candidate_route_score: entry.candidate_route_score ?? null,
          ml_slate_eligibility: entry.ml_slate_eligibility ?? null,
          family_exposure: entry.family_exposure ?? null,
          diversity_contribution: entry.diversity_contribution ?? null,
          risk_adjusted_affinity: entry.risk_adjusted_affinity ?? null,
          uncertainty: entry.uncertainty ?? null,
          runtime_teacher_evidence: entry.runtime_teacher_evidence ?? null,
          runtime_teacher_evidence_source: entry.runtime_teacher_evidence_source ?? null,
          ml_teacher_labels: entry.ml_teacher_labels ?? null,
          strategy_affinity_vector: entry.strategy_affinity_vector ?? null,
          strategy_weak_label_vector: entry.strategy_weak_label_vector ?? null,
          strategy_hit_vector: entry.strategy_hit_vector ?? null,
          strategy_position_weight_vector: entry.strategy_position_weight_vector ?? null,
          strategy_overlap_vector: entry.strategy_overlap_vector ?? null,
          strategy_family_affinity: entry.strategy_family_affinity ?? null,
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
          strategy_family_ids: entry.strategy_family_ids ?? [],
          strategy_variant_ids: entry.strategy_variant_ids ?? [],
          strategy_owner_types: entry.strategy_owner_types ?? [],
          research_strategy_ids: entry.research_strategy_ids ?? [],
          strategy_pool_fallback_source: entry.strategy_pool_fallback_source ?? null,
          strategy_pool_score: entry.strategy_pool_score ?? null,
          market_segment: entry.market_segment ?? null,
          source_universe: 'post_safety_hard_filter_pre_rrg',
        },
      })
    }
  } catch (e) {
    debugLog.push(`[Step 2c] layer1 breadth unavailable; strategy registry is required for clean runtime: ${String(e)}`)
    throw new Error(`strategy_registry_required_for_clean_runtime:${String(e)}`)
  }

  // ?? Step 3: RRG 鞊⊿??? ?? (2026-04-09 rewired)
  // RRG bonus config is consumed below from trading config / Optuna pushes.
  // 雿? consumer?ㄐ?乩?嚗? ml-controller 撖怎? sector_flow (classification='theme'
  // + ???date + ?征 quadrant)嚗?瘥???∠? top concept tag 撠???quadrant嚗?
  // ?嗅???cfg.rrg.{leadingBonus, improvingBonus, weakeningBonus, laggingPenalty}
  // 隤踵 score?誑 Score V2 partial total 雿?seed score嚗?蝥?overlay 隤踵敺???c.score??
  // RRG quadrant axes (RS=100, Mom=0) are canonical de Kempenaer coordinates,
  // so they stay fixed rather than becoming Optuna-tunable policy knobs.
  const sectorHeatScores: SectorHeatScore[] = []
  let rrgShadowNonzeroCount = 0
  const rrgCfg = cfg.rrg
  if (rrgCfg && scored.length > 0) {
    try {
      // (a) 瘥???∠? top (highest weight) concept tag
      const topTagRows = await queryTopConceptTagsForSymbols(env.DB, [...overlayEligibleSymbols], 400, endDate)
      const symbolTags = new Map<string, Array<{ tag: string; classification: string }>>()
      for (const r of topTagRows ?? []) {
        const tags = symbolTags.get(r.symbol) ?? []
        tags.push({ tag: r.tag, classification: rrgClassificationForTagType(r.tag_type) })
        symbolTags.set(r.symbol, tags)
      }
      // (b) ???sector_flow ??撅?taxonomy quadrant
      const { results: qRows } = await env.DB.prepare(
        `SELECT sector, classification, quadrant, rs_ratio, rs_momentum, turnover_share_delta,
                rotation_score, rotation_regime, rotation_hysteresis, rotation_velocity,
                rotation_acceleration, quadrant_age, transition_path, rotation_window
           FROM sector_flow
         WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
           AND date <= ?
           AND quadrant IS NOT NULL
           AND rs_ratio IS NOT NULL
           AND rs_momentum IS NOT NULL
           AND date = (SELECT MAX(date) FROM sector_flow
                       WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
                         AND date <= ?
                         AND rs_ratio IS NOT NULL
                         AND rs_momentum IS NOT NULL)`
      ).bind(endDate, endDate).all<{
        sector: string
        classification: string
        quadrant: string
        rs_ratio: number | null
        rs_momentum: number | null
        turnover_share_delta: number | null
        rotation_score: number | null
        rotation_regime: string | null
        rotation_hysteresis: string | null
        rotation_velocity: number | null
        rotation_acceleration: number | null
        quadrant_age: number | null
        transition_path: string | null
        rotation_window: number | null
      }>()
      const themeQuadrant = new Map<string, {
        quadrant: string
        rsRatio: number
        rsMomentum: number
        turnoverShareDelta: number
        rotationScore: number | null
        rotationRegime: string | null
        rotationHysteresis: string | null
        rotationVelocity: number | null
        rotationAcceleration: number | null
        quadrantAge: number | null
        transitionPath: string | null
        rotationWindow: number | null
      }>()
      for (const r of qRows ?? []) {
        const classification = String(r.classification || '').trim()
        const sector = String(r.sector || '').trim()
        if (!classification || !sector) continue
        themeQuadrant.set(`${classification}:${sector}`, {
          quadrant: r.quadrant,
          rsRatio: Number(r.rs_ratio ?? 100),
          rsMomentum: Number(r.rs_momentum ?? 0),
          turnoverShareDelta: Number(r.turnover_share_delta ?? 0),
          rotationScore: r.rotation_score == null ? null : Number(r.rotation_score),
          rotationRegime: r.rotation_regime == null ? null : String(r.rotation_regime),
          rotationHysteresis: r.rotation_hysteresis == null ? null : String(r.rotation_hysteresis),
          rotationVelocity: r.rotation_velocity == null ? null : Number(r.rotation_velocity),
          rotationAcceleration: r.rotation_acceleration == null ? null : Number(r.rotation_acceleration),
          quadrantAge: r.quadrant_age == null ? null : Number(r.quadrant_age),
          transitionPath: r.transition_path == null ? null : String(r.transition_path),
          rotationWindow: r.rotation_window == null ? null : Number(r.rotation_window),
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
            evidence: {
              tag: matched.tag,
              classification: matched.classification,
              taxonomyKey,
              latestThemeUniverseSize: latestThemeUniverse.size,
              applicationMode: 'shadow_late_l4_fusion_feature_only',
              candidateSetMutationAllowed: false,
            },
          })
          continue
        }
        const {
          quadrant: q,
          rsRatio,
          rsMomentum,
          turnoverShareDelta,
          rotationScore,
          rotationRegime,
          rotationHysteresis,
          rotationVelocity,
          rotationAcceleration,
          quadrantAge,
          transitionPath,
          rotationWindow,
        } = overlay
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
        const rotationAdjustment = Number.isFinite(rotationScore)
          ? Math.max(-3, Math.min(3, Number(rotationScore) * 3))
          : 0
        if (rotationAdjustment !== 0) {
          adjustment += rotationAdjustment
          reasonCode = rotationRegime ? `rrg_rotation_${rotationRegime}` : reasonCode
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
          const frozenScore = c.score
          rrgShadowNonzeroCount++
          pushFunnelItem(funnelItems, {
            symbol: c.symbol,
            name: c.name,
            stage: 'rrg_overlay',
            decision: 'observe',
            reasonCode,
            scoreBefore: frozenScore,
            scoreAfter: frozenScore,
            evidence: {
              tag: matched.tag,
              classification: matched.classification,
              taxonomyKey,
              quadrant: q,
              rsRatio,
              rsMomentum,
              turnoverShareDelta,
              rotationScore,
              rotationRegime,
              rotationHysteresis,
              rotationVelocity,
              rotationAcceleration,
              quadrantAge,
              transitionPath,
              rotationWindow,
              rotationAdjustment,
              turnoverShareAdjustment,
              shadowAdjustment: adjustment,
              applicationMode: 'shadow_late_l4_fusion_feature_only',
              downstreamOwner: 'l4_fusion_allocator',
              candidateSetMutationAllowed: false,
            },
          })
        }
      }
      debugLog.push(
        `[Step 3] RRG shadow evidence nonzero=${rrgShadowNonzeroCount}/${scored.length} ` +
        `(taxonomy sectors loaded: ${themeQuadrant.size}, ` +
        `bonuses: L=${rrgCfg.leadingBonus} I=${rrgCfg.improvingBonus} W=${rrgCfg.weakeningBonus} La=${rrgCfg.laggingPenalty})`
      )
    } catch (e) {
      console.warn('[Screener v2] RRG quadrant bonus failed (non-fatal):', e)
      debugLog.push(`[Step 3] RRG quadrant bonus skipped (error): ${e}`)
    }
  } else {
    debugLog.push('[Step 3] RRG shadow evidence skipped (cfg.rrg missing or empty scored)')
  }

  // ?? Step 4: ???Ｗ?????
  // 4a. ?啗???嚗1 ?亥岷嚗?
  try {
    // ?寞活?交???? 7 憭拇??蝺?
    const topSymbols = [...overlayEligibleSymbols]
    if (topSymbols.length > 0) {
      // ??stocks 銵冽 stock_id
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

  // 4b. PTT buzz ??璁艙 ?????
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

  // ?? Step 5: ?? + ?駁? + ?芣 ??
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
  debugLog.push(`[Step 4] ???Ｗ?????| PTT hot concepts: ${[...hotConcepts].join(', ')}`)
  debugLog.push(`[Step 4] Theme evidence now includes PTT/news/Anue plus runtime theme_signals when available`)
  const afterSentiment = [...scored].sort((a, b) => b.score - a.score)
  debugLog.push(`[Step 4] Top 10 (with sentiment):`)
  for (const c of afterSentiment.slice(0, 10)) {
    debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} | total=${c.score.toFixed(1)} | ${c.reason}`)
  }

  scored.sort((a, b) => b.score - a.score)

  // ?? P2-10: 憭?瘛刻眺頞予?訾?瘥?憭抒撅斤? risk overlay嚗??
  // P3-11: ATR V 頧?璅?
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
      // < 0.4 = 憭???鞈?? ???券?????
      if (foreignBuyRatio < 0.35) {
        for (const c of scored) c.score -= 3
        debugLog.push(`[Step 4d] Foreign net weak: source=${foreignSource} buy_ratio=${foreignBuyRatio.toFixed(2)} penalty=-3`)
      } else if (foreignBuyRatio > 0.65) {
        debugLog.push(`[Step 4d] Foreign net supportive: source=${foreignSource} buy_ratio=${foreignBuyRatio.toFixed(2)}`)
      } else {
        debugLog.push(`[Step 4d] Foreign net neutral: source=${foreignSource} buy_ratio=${foreignBuyRatio.toFixed(2)}`)
      }
    }
  } catch (e) {
    console.warn('[Screener v2] 憭?憭拇雿?憭望?:', e)
  }

  // ?? Step 4c: 頞典?釭 + ADX + 瘚??批?蝝?D1 60 憭拇風?莎???
  try {
    const policyPoolSymbols = [...overlayEligibleSymbols]
    if (policyPoolSymbols.length > 0) {
      const histRows: Array<{ symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }> = []
      for (const chunk of chunkArray(policyPoolSymbols, D1_IN_CHUNK_SIZE)) {
        const ph = chunk.map(() => '?').join(',')
      // ??60 憭?OHLCV嚗DX ?閬?high/low嚗?
        const { results } = await env.DB.prepare(`
        SELECT s.symbol, sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume
        FROM stock_prices sp JOIN stocks s ON sp.stock_id = s.id
        WHERE s.symbol IN (${ph}) AND sp.date >= date('now', '-90 days')
        ORDER BY s.symbol, sp.date
        `).bind(...chunk).all<{ symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }>()
        histRows.push(...(results ?? []))
      }

      // ??symbol ??
      const histBySymbol = new Map<string, { close: number; high: number; low: number; volume: number }[]>()
      for (const r of histRows) {
        if (!histBySymbol.has(r.symbol)) histBySymbol.set(r.symbol, [])
        histBySymbol.get(r.symbol)!.push({ close: r.close, high: r.high ?? r.close, low: r.low ?? r.close, volume: r.volume ?? 0 })
      }

      // ?? G1: ??universe ??intent ?曉?雿???adaptive ?瑼鳴???
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
      // 閮??曉?雿?瑼?
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

        // ??頝 60 ?仿?暺???
        const fromHigh = (latest - high60) / high60
        if (fromHigh < -0.15) {
          c.score -= 8
          c.reason += `嚗?擃?${(fromHigh * 100).toFixed(0)}%`
          trendPenalty++
        } else if (fromHigh < -0.10) {
          c.score -= 5
          trendPenalty++
        }

        // ??G1: Intent adaptive ?曉?雿??
        const intent = intentMap.get(c.symbol) ?? 0
        if (intent < p10 && intent < 0) {
          c.score -= 8  // ?撌?10%嚗楊頝?擃??迎?
          intentPenalty++
        } else if (intent < p20 && intent < 0) {
          c.score -= 5  // ?撌?20%
          intentPenalty++
        } else if (intent > 0.4) {
          c.score += 3  // ?芾釭?渡?銝撞
        }

        // ??G2+ADX: ?梁摰 ADX 14 閮?嚗????DX 餈撮 ADX??
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
            c.reason += ` | weak_adx_${adx.toFixed(0)}`
            adxPenalty++
          } else if (adx != null && adx > 30) {
            if (intent > 0.1) c.score += 2
          }
        }

        // ??G4: 瘚??批?蝝?銝?擃′?瑼鳴??典??豢??塚?
        const avgTurnover = bars.reduce((s, b) => s + b.close * b.volume, 0) / bars.length
        if (avgTurnover < 10_000_000) {        // < 1000 ??
          c.score -= 5
          liqPenalty++
        } else if (avgTurnover < 30_000_000) { // 1000~3000 ??
          c.score -= 2
          liqPenalty++
        } else if (avgTurnover > 100_000_000) { // > 1 ??
          c.score += 2  // 擃??批??
        }
      }

      debugLog.push(`[Step 4c] 頞典?釭: 頝?暺?${trendPenalty} intent=${intentPenalty} ADX?∟隅??${adxPenalty} 雿???${liqPenalty}`)
      debugLog.push(`[Step 4c] Intent adaptive: p10=${p10.toFixed(3)} p20=${p20.toFixed(3)}`)
    }
  } catch (e) {
    console.warn('[Screener v2] 頞典?釭 filter 憭望?:', e)
  }

  // 5a+5b: ?璆凋???
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

  // Sector/taxonomy/correlation concentration is evidence for L4/Fusion and the
  // portfolio risk owner. It must not mutate the L1 decision universe.
  const maxPerIndustry = Number((sc as any).maxPerIndustry ?? 5)
  const selectionTargetSize = Math.max(0, Math.round(layer1AdaptiveTargetSize))
  const dynamicThemeCap = Number((sc as any).maxPerIndustryTheme ?? Math.max(3, Math.ceil(selectionTargetSize * 0.18)))
  const dynamicSubindustryCap = Number((sc as any).maxPerSubindustry ?? Math.max(2, Math.ceil(selectionTargetSize * 0.14)))
  const afterIndustryLimit = [...scored]
  const countExposure = (key: 'industry' | 'industryTheme' | 'subindustry') => {
    const counts = new Map<string, number>()
    for (const candidate of scored) {
      const value = key === 'industry'
        ? String(candidate.industry || 'unknown')
        : String((candidate as any)[key] || (candidate as any).taxonomy?.[key] || 'unknown')
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]))
  }
  const industryExposure = countExposure('industry')
  const themeExposure = countExposure('industryTheme')
  const subindustryExposure = countExposure('subindustry')
  const countAbove = (exposure: Record<string, number>, threshold: number) =>
    Object.values(exposure).filter((count) => count > threshold).length
  debugLog.push(
    `[Step 5b] concentration evidence only; candidate mutation disabled ` +
    `industry_over_${maxPerIndustry}=${countAbove(industryExposure, maxPerIndustry)} ` +
    `theme_over_${dynamicThemeCap}=${countAbove(themeExposure, dynamicThemeCap)} ` +
    `subindustry_over_${dynamicSubindustryCap}=${countAbove(subindustryExposure, dynamicSubindustryCap)}`,
  )
  // 5d: top N ?芣嚗trategy pool 撌脣 Step 2c嚗??函′蝭拙??RG/?駁???摰???
  let finalCandidates: ScreenerCandidate[] = []
  if (layer1BreadthPool.length > 0) {
    const layer1TargetSize = selectionTargetSize
    const updatedBySymbol = new Map(scored.map((candidate) => [String(candidate.symbol || '').trim(), candidate]))
    const layer1Queue = layer2CoarseQueueSeed
      .filter((candidate) => {
        const symbol = String(candidate.symbol || '').trim()
        const isFormalStrategyHit =
          String((candidate as any).strategy_pool_decision ?? '') === 'ml_queue' &&
          String((candidate as any).strategy_pool_fallback_source ?? '') !== 'raw_signal_top_up' &&
          ((candidate as any).strategy_pool_ids ?? []).length > 0
        if (!isFormalStrategyHit) return false
        return updatedBySymbol.has(symbol)
      })
    const selectedSymbols = new Set(layer1Queue.map((candidate: any) => String(candidate.symbol || '').trim()))
    const selectedCandidates = reconcileCandidatesStrategyPoolAttribution(layer1Queue.map((entry: any) => {
      const symbol = String(entry.symbol || '').trim()
      const updated = updatedBySymbol.get(symbol)
      return {
        ...(updated ?? entry),
        strategy_pool_decision: entry.strategy_pool_decision,
        strategy_pool_reason: entry.strategy_pool_reason,
        strategy_pool_rank: entry.strategy_pool_rank,
        strategy_pool_ids: entry.strategy_pool_ids,
        strategy_family_ids: entry.strategy_family_ids,
        strategy_variant_ids: entry.strategy_variant_ids,
        strategy_owner_types: entry.strategy_owner_types,
        research_strategy_ids: entry.research_strategy_ids,
        strategy_pool_fallback_source: entry.strategy_pool_fallback_source,
        strategy_pool_score: entry.strategy_pool_score,
        strategy_watch_points: Array.from(new Set([
          ...((updated as any)?.strategy_watch_points ?? []),
          ...((entry as any).strategy_watch_points ?? []),
        ])),
      }
    }), runtimeStrategySpecs, { regime: runtimeStrategyRegime })
    const topUpCandidates = afterIndustryLimit
      .filter((candidate) => {
        const symbol = String(candidate.symbol || '').trim()
        if (selectedSymbols.has(symbol)) return false
        if (passesLayer1TopUpQualityGuard && !passesLayer1TopUpQualityGuard(candidate as any)) return false
        return true
      })
      .slice(0, Math.max(0, layer1TargetSize - selectedCandidates.length))
      .map((candidate, index) => ({
        ...candidate,
        strategy_pool_decision: 'research_only_queue',
        strategy_pool_reason: 'layer1_breadth_after_overlay_top_up_observe',
        strategy_pool_rank: selectedCandidates.length + index + 1,
        strategy_pool_ids: (candidate as any).strategy_pool_ids ?? [],
        strategy_family_ids: (candidate as any).strategy_family_ids ?? [],
        strategy_variant_ids: (candidate as any).strategy_variant_ids ?? [],
        strategy_owner_types: ['observe'],
        research_strategy_ids: (candidate as any).research_strategy_ids ?? [],
        strategy_pool_fallback_source: (candidate as any).strategy_pool_fallback_source ?? 'layer1_breadth',
        strategy_watch_points: [
          ...((candidate as any).strategy_watch_points ?? []),
          'strategy_pool:layer1_breadth_after_overlay_top_up_observe',
          'strategy_pool:not_formal_l2_queue',
        ],
      }))
    topUpCandidates.slice(0, D1_IN_CHUNK_SIZE).forEach((candidate, index) => {
      pushFunnelItem(funnelItems, {
        symbol: candidate.symbol,
        name: candidate.name,
        stage: 'layer1_raw_signal_observe',
        decision: 'observe',
        reasonCode: String((candidate as any).strategy_pool_reason ?? 'raw_signal_observe'),
        scoreAfter: Number((candidate as any).score ?? 0),
        rank: index + 1,
        evidence: {
          strategy_pool_fallback_source: (candidate as any).strategy_pool_fallback_source ?? null,
          strategy_pool_decision: (candidate as any).strategy_pool_decision ?? null,
          formal_l2_queue: false,
          source_universe: 'post_diversity_universe',
        },
      })
    })
    finalCandidates = dedupeScreenerCandidatesBySymbol(
      annotateCandidatesWithStrategySpecs([
        ...(selectedCandidates as any[]),
      ] as ScreenerCandidate[], runtimeStrategySpecs),
    )
    strategySelectionTelemetry = {
      ...(strategySelectionTelemetry ?? {}),
      post_diversity_universe_count: afterIndustryLimit.length,
      sector_concentration_policy: 'evidence_only_no_candidate_mutation',
      layer1_breadth_count: layer1BreadthPool.length,
      coarse_queue_count: layer2CoarseQueueSeed.length,
      top_up_count: 0,
      raw_signal_observe_count: topUpCandidates.length,
      selected_after_overlay_count: selectedCandidates.length,
      l1_seed_count: selectedCandidates.length,
      l15_soft_capacity_baseline: screenerPolicy.sizing.candidatePoolSize,
      l15_adaptive_target_size: layer1TargetSize,
      core_ml_shortlist_size: maxCandidates,
    }
    debugLog.push(
      `[Step 5] layer1 breadth seed applied: selected=${selectedCandidates.length}+observe_topup=${topUpCandidates.length}/${layer1TargetSize} ` +
      `controller_l2_keep_ratio=${screenerPolicy.sizing.coarseMlKeepRatio} core_ml_target=${maxCandidates} post_diversity_universe=${afterIndustryLimit.length}`,
    )
  } else {
    finalCandidates = []
    strategySelectionTelemetry = {
      ...(strategySelectionTelemetry ?? {}),
      post_diversity_universe_count: afterIndustryLimit.length,
      sector_concentration_policy: 'evidence_only_no_candidate_mutation',
      layer1_breadth_count: 0,
      coarse_queue_count: 0,
      top_up_count: 0,
      raw_signal_observe_count: 0,
      selected_after_overlay_count: 0,
      l1_seed_count: 0,
      l15_soft_capacity_baseline: screenerPolicy.sizing.candidatePoolSize,
      l15_adaptive_target_size: selectionTargetSize,
      core_ml_shortlist_size: maxCandidates,
      layer1_breadth_blocked_reason: 'no_formal_strategy_or_observe_evidence',
    }
    debugLog.push(`[Step 5] layer1 breadth empty; blocked score-ranked L1 fallback ${selectionTargetSize} baseline=${screenerPolicy.sizing.candidatePoolSize}`)
  }
  const step5Msg = `[Step 5] ${scored.length} 瑼????璆凌${maxPerIndustry} ??${afterIndustryLimit.length} 瑼???coarse ${coarseQueueSize} ??${finalCandidates.length} 瑼???core target ${maxCandidates}`
  debugLog.push(step5Msg)
  debugLog.push(`[Step 5] L1 seed=${finalCandidates.length}; controller L2 keep ratio=${screenerPolicy.sizing.coarseMlKeepRatio}; controller L3 target=${maxCandidates}`)

  // 鋡怎璆凋??祟??
  const removedByIndustry = scored.filter(c => !afterIndustryLimit.includes(c)).slice(0, 10)
  if (removedByIndustry.length) {
    debugLog.push(`[Step 5b] 鋡怠??Ｘ平銝?蝭拇?嚗? 10嚗?`)
    for (const c of removedByIndustry) {
      debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} score=${c.score.toFixed(1)}`)
    }
  }

  // 鋡怠?祟??
  const afterDedupSet = new Set(afterIndustryLimit.map(c => c.symbol))
  const removedByDedup = afterIndustryLimit.filter(c => !afterDedupSet.has(c.symbol))
  // 鋡急?瑞?
  const selectedAtL1 = new Set(finalCandidates.map((candidate) => String(candidate.symbol || '').trim()))
  const routeFloorRejected = afterIndustryLimit.filter(
    (candidate) => !selectedAtL1.has(String(candidate.symbol || '').trim()),
  )
  const emergingMaxCandidates = screenerPolicy.sizing.emergingResearchSize
  const emergingResearchCandidates: ScreenerCandidate[] = []
  const shouldScoreEmerging = emergingMaxCandidates > 0 && emergingResearchPrices.length > 0
  const emergingData = shouldScoreEmerging
    ? buildStockData(emergingResearchPrices, allChips)
    : { prices: new Map(), chips: new Map() } as StockDailyData
  if (shouldScoreEmerging) {
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
        const industry = taxonomyDisplay(taxonomy, industryMap.get(stockId) ?? '?嗡?')
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
          current_price: finiteOrNull(latest.close),
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
          runtimeStrategySpecs,
        ),
      ))
      debugLog.push(`[Step 5e] emerging research lane: ${emergingResearchCandidates.length}/${emergingScored.length} top ${emergingMaxCandidates}`)
    } catch (e) {
      console.warn('[Screener v2] Emerging research lane failed:', e)
      debugLog.push(`[Step 5e] emerging research lane skipped (error): ${e}`)
    }
  } else {
    debugLog.push('[Step 5e] emerging research lane retired; skipped')
  }
  if (routeFloorRejected.length) {
    debugLog.push('[Step 5d] route-floor rejected evidence: ' + routeFloorRejected.length + '; first 10')
    for (const c of routeFloorRejected.slice(0, 10)) {
      debugLog.push(`  ${c.symbol} ${c.name} ${c.industry} score=${c.score.toFixed(1)}`)
    }
  }

  // ?? Step 6: 鞈??釭嚗elistingMonitor嚗??
  try {
    const candSymbols = finalCandidates.map(c => c.symbol)
    if (candSymbols.length > 0) {
      const recentRows: Array<{ symbol: string; days_count: number }> = []
      for (const chunk of chunkArray(candSymbols, D1_IN_CHUNK_SIZE)) {
        const ph = chunk.map(() => '?').join(',')
        const { results } = await env.DB.prepare(`
          SELECT s.symbol, COUNT(sp.date) as days_count
          FROM stocks s
          LEFT JOIN stock_prices sp ON sp.stock_id = s.id AND sp.date >= date('now', '-7 days')
          WHERE s.symbol IN (${ph})
          GROUP BY s.symbol
        `).bind(...chunk).all<{ symbol: string; days_count: number }>()
        recentRows.push(...(results ?? []))
      }
      const delistRisk = new Set<string>()
      for (const r of recentRows) {
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
      const rawCandidate = candidate as ScoredCandidate & Breeze2CandidateShape
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
      } satisfies Breeze2CandidateShape
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
    const layer1Telemetry = ((strategySelectionTelemetry as any)?.layer1_telemetry ?? {}) as Record<string, any>
    const l1CandidateSeedEvidence = {
      semantic_stage: 'l1_candidate_seed_after_overlay',
      legacy_alias_stage: 'final_selection',
      industry: sc.industry ?? c.sector,
      chip_score: sc.chip_score,
      tech_score: sc.tech_score,
      momentum_score: sc.momentum_score,
      highFreq: flag?.highFreq ?? false,
      newMoney: flag?.newMoney ?? false,
      freq20d: flag?.freq20d ?? 0,
      strategy_tags: sc.strategy_tags ?? [],
      strategy_pool_ids: sc.strategy_pool_ids ?? [],
      strategy_family_ids: sc.strategy_family_ids ?? [],
      strategy_variant_ids: sc.strategy_variant_ids ?? [],
      strategy_owner_types: sc.strategy_owner_types ?? [],
      research_strategy_ids: sc.research_strategy_ids ?? [],
      strategy_pool_fallback_source: sc.strategy_pool_fallback_source ?? null,
      strategy_pool_score: sc.strategy_pool_score ?? null,
      strategy_pool_reason: sc.strategy_pool_reason ?? null,
      strategy_labeler_version: sc.strategy_labeler_version ?? null,
      finlab_portfolio_intelligence_version: FINLAB_PORTFOLIO_INTELLIGENCE_VERSION,
      strategy_router_version: sc.strategy_router_version ?? null,
      candidate_route_score: sc.candidate_route_score ?? null,
      ml_slate_eligibility: sc.ml_slate_eligibility ?? null,
      family_exposure: sc.family_exposure ?? null,
      diversity_contribution: sc.diversity_contribution ?? null,
      risk_adjusted_affinity: sc.risk_adjusted_affinity ?? null,
      uncertainty: sc.uncertainty ?? null,
      runtime_teacher_evidence: sc.runtime_teacher_evidence ?? null,
      runtime_teacher_evidence_source: sc.runtime_teacher_evidence_source ?? null,
      ml_teacher_labels: sc.ml_teacher_labels ?? null,
      strategy_affinity_vector: sc.strategy_affinity_vector ?? null,
      strategy_weak_label_vector: sc.strategy_weak_label_vector ?? null,
      strategy_hit_vector: sc.strategy_hit_vector ?? null,
      strategy_position_weight_vector: sc.strategy_position_weight_vector ?? null,
      strategy_overlap_vector: sc.strategy_overlap_vector ?? null,
      strategy_family_affinity: sc.strategy_family_affinity ?? null,
      strategy_matrix_candidate_count: layer1Telemetry.strategy_matrix_candidate_count ?? null,
      strategy_matrix_strategy_count: layer1Telemetry.strategy_matrix_strategy_count ?? null,
      strategy_matrix_cell_count: layer1Telemetry.strategy_matrix_cell_count ?? null,
      strategy_matrix_expected_cell_count: layer1Telemetry.strategy_matrix_expected_cell_count ?? null,
      strategy_matrix_coverage_ratio: layer1Telemetry.strategy_matrix_coverage_ratio ?? null,
      strategy_matrix_matched_candidate_count: layer1Telemetry.strategy_matrix_matched_candidate_count ?? null,
      strategy_matrix_active_labeled_candidate_count: layer1Telemetry.strategy_matrix_active_labeled_candidate_count ?? null,
      l1_breadth_seed_size: finalCandidates.length,
      soft_capacity_baseline: layer1Telemetry.soft_capacity_baseline ?? screenerPolicy.sizing.candidatePoolSize,
      adaptive_target_size: layer1Telemetry.adaptive_target_size ?? layer1AdaptiveTargetSize,
      adaptive_capacity_max: layer1Telemetry.adaptive_capacity_max ?? null,
      adaptive_capacity_policy: layer1Telemetry.adaptive_capacity_policy ?? null,
      adaptive_capacity_reason: layer1Telemetry.adaptive_capacity_reason ?? null,
      adaptive_capacity_eligible_count: layer1Telemetry.adaptive_capacity_eligible_count ?? null,
      adaptive_target_size_before_dynamic_quota: layer1Telemetry.adaptive_target_size_before_dynamic_quota ?? null,
      dynamic_effective_quota_policy: layer1Telemetry.dynamic_effective_quota_policy ?? null,
      dynamic_effective_quota_total: layer1Telemetry.dynamic_effective_quota_total ?? null,
      dynamic_effective_quota_by_strategy: layer1Telemetry.dynamic_effective_quota_by_strategy ?? null,
      adaptive_strategy_policy_version: layer1Telemetry.adaptive_strategy_policy_version ?? null,
      adaptive_pool_quota_by_strategy: layer1Telemetry.adaptive_pool_quota_by_strategy ?? null,
      adaptive_cost_budget_by_strategy: layer1Telemetry.adaptive_cost_budget_by_strategy ?? null,
      adaptive_max_ml_share_by_strategy: layer1Telemetry.adaptive_max_ml_share_by_strategy ?? null,
      static_pool_quota_by_strategy: layer1Telemetry.static_pool_quota_by_strategy ?? null,
      static_cost_budget_by_strategy: layer1Telemetry.static_cost_budget_by_strategy ?? null,
      static_max_ml_share_by_strategy: layer1Telemetry.static_max_ml_share_by_strategy ?? null,
      layer2_owner: 'ml-controller',
      layer2_coarse_queue_size_legacy: coarseQueueSize,
      layer2_coarse_keep_ratio: screenerPolicy.sizing.coarseMlKeepRatio,
      layer3_core_ml_target_size: maxCandidates,
    }
    pushFunnelItem(funnelItems, {
      symbol: c.symbol,
      name: c.name,
      stage: 'l15_ml_slate_queue',
      decision: 'observe',
      reasonCode: 'ml_slate_queue_seed_from_l1_5_router',
      scoreAfter: Number(sc.score ?? 0),
      rank: index + 1,
      evidence: {
        layer_contract: 'L1.5 router owns ML slate queue; ml-controller runs L2 TimesFM feature enrichment before L3 8ML',
        worker_seed_only: true,
        downstream_owner: 'ml-controller',
        downstream_stage: 'layer2_timesfm_enrichment',
        coarse_ml_queue_size_legacy: coarseQueueSize,
        coarse_ml_keep_ratio: screenerPolicy.sizing.coarseMlKeepRatio,
        core_ml_shortlist_size: maxCandidates,
        soft_capacity_baseline: layer1Telemetry.soft_capacity_baseline ?? screenerPolicy.sizing.candidatePoolSize,
        adaptive_target_size: layer1Telemetry.adaptive_target_size ?? layer1AdaptiveTargetSize,
        adaptive_capacity_max: layer1Telemetry.adaptive_capacity_max ?? null,
        adaptive_capacity_policy: layer1Telemetry.adaptive_capacity_policy ?? null,
        adaptive_capacity_reason: layer1Telemetry.adaptive_capacity_reason ?? null,
        adaptive_capacity_eligible_count: layer1Telemetry.adaptive_capacity_eligible_count ?? null,
        adaptive_target_size_before_dynamic_quota: layer1Telemetry.adaptive_target_size_before_dynamic_quota ?? null,
        dynamic_effective_quota_policy: layer1Telemetry.dynamic_effective_quota_policy ?? null,
        dynamic_effective_quota_total: layer1Telemetry.dynamic_effective_quota_total ?? null,
        dynamic_effective_quota_by_strategy: layer1Telemetry.dynamic_effective_quota_by_strategy ?? null,
        adaptive_strategy_policy_version: layer1Telemetry.adaptive_strategy_policy_version ?? null,
        adaptive_pool_quota_by_strategy: layer1Telemetry.adaptive_pool_quota_by_strategy ?? null,
        adaptive_cost_budget_by_strategy: layer1Telemetry.adaptive_cost_budget_by_strategy ?? null,
        adaptive_max_ml_share_by_strategy: layer1Telemetry.adaptive_max_ml_share_by_strategy ?? null,
        static_pool_quota_by_strategy: layer1Telemetry.static_pool_quota_by_strategy ?? null,
        static_cost_budget_by_strategy: layer1Telemetry.static_cost_budget_by_strategy ?? null,
        static_max_ml_share_by_strategy: layer1Telemetry.static_max_ml_share_by_strategy ?? null,
        strategy_pool_ids: sc.strategy_pool_ids ?? [],
        strategy_family_ids: sc.strategy_family_ids ?? [],
        strategy_variant_ids: sc.strategy_variant_ids ?? [],
        strategy_owner_types: sc.strategy_owner_types ?? [],
        strategy_pool_score: sc.strategy_pool_score ?? null,
        strategy_pool_reason: sc.strategy_pool_reason ?? null,
        strategy_labeler_version: sc.strategy_labeler_version ?? null,
        strategy_router_version: sc.strategy_router_version ?? null,
        candidate_route_score: sc.candidate_route_score ?? null,
        ml_slate_eligibility: sc.ml_slate_eligibility ?? null,
        family_exposure: sc.family_exposure ?? null,
        diversity_contribution: sc.diversity_contribution ?? null,
        risk_adjusted_affinity: sc.risk_adjusted_affinity ?? null,
        uncertainty: sc.uncertainty ?? null,
      },
    })
    pushFunnelItem(funnelItems, {
      symbol: c.symbol,
      name: c.name,
      stage: 'l1_candidate_seed_after_overlay',
      decision: 'selected',
      reasonCode: 'selected_for_l1_breadth_seed',
      scoreAfter: Number(sc.score ?? 0),
      rank: index + 1,
      evidence: l1CandidateSeedEvidence,
    })
    pushFunnelItem(funnelItems, {
      symbol: c.symbol,
      name: c.name,
      stage: 'final_selection',
      decision: 'observe',
      reasonCode: 'selected_for_l1_breadth_seed',
      scoreAfter: Number(sc.score ?? 0),
      rank: index + 1,
      evidence: {
        ...l1CandidateSeedEvidence,
        deprecated_stage_name: true,
        semantic_stage: 'l1_candidate_seed_after_overlay',
      },
    })
  })

  // ?? DB 撖怠 ??
  try {
    await updateScreenerWatchlist(env.DB, finalCandidates, tpexSymbolSet)
  } catch (e) {
    console.error('[Screener v2] Watchlist update failed:', e)
  }

  // ?? #15 Selection frequency tag (dannyquant_tw ?, 2026-04-21) ??????????
  // Query ??20 憭?/ 30 憭拍? screener selection history 銝衣?祆?蝞??flag:
  //   high_freq: 20d count ??12
  //   new_money: 30d count = 0 (隞予擐活?箇)
  // Forward-only: deploy ?亥絲蝝舐?嚗?0d 敺?high_freq ????0d 敺?new_money ?縑摨?
  debugLog.push('[Step 4e] selection history flags reused from candidate-pool superset; no final refresh query')

  // ?? #16 Sector leader correlation bonus (2026-04-21, dannyquant_tw ?) ??
  // sectorLeaderBonus(symbol, sector) ??bonus points if avg 60d corr > threshold.
  // ????黎 leaders ? = 頝?ETF/?粹? flow ??嚗????迨 edge??
  // Fire-and-forget: table 蝻箸???憭望???0 bonus 銝?銝餅?蝔?
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

  // Screener ?芾?鞎?seed chip/tech/price嚗L-enriched recommendations ??ml-controller ????
  let themeRuntimeTelemetry: Record<string, unknown> = { status: 'not_started' }

  try {
    const recBatch = finalCandidates.map((c, i) => {
      const sc = c as any
      // 敺??API 鞈????唳?文嚗?撖?null嚗?
      const latestPrices = data.prices.get(c.symbol)
      const currentPrice = latestPrices?.length ? latestPrices[latestPrices.length - 1].close : null
      // #15 tag prefix + #16 sector leader bonus 銝韏?append ??reason
      const flag = selectionFlagMap.get(c.symbol)
      const sectorB = sectorBonusMap.get(c.symbol)
      const breeze2WatchPoint = extractBreeze2WatchPoint(breeze2ScreenerContext.get(c.symbol))
      const chipMeta = latestChipMeta(data.chips.get(c.symbol))
      const taxPoint = taxonomyWatchPoint((c as any).taxonomy)
      const tagParts: string[] = []
      if (flag?.highFreq) tagParts.push(`?? 擃 (20d ?仿 ${flag.freq20d} 甈?`)
      if (flag?.newMoney) tagParts.push('?? ?啗???(30d 擐?)')
      if (sectorB && sectorB.bonus > 0 && sectorB.avgCorr !== null) {
        tagParts.push(`?? ?黎??? (corr=${sectorB.avgCorr.toFixed(2)}, +${sectorB.bonus})`)
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
    await pruneScreenerSeedRows(env.DB, endDate, seedSymbols)

    // 靽?????in_current_watchlist=1嚗甇?updateScreenerWatchlist batch 憭望?????瘜?
    if (finalCandidates.length > 0) {
      for (const chunk of chunkArray(finalCandidates.map(c => c.symbol), D1_IN_CHUNK_SIZE)) {
        const ph = chunk.map(() => '?').join(',')
        await env.DB.prepare(
          `UPDATE stocks SET in_current_watchlist=1 WHERE symbol IN (${ph})`
        ).bind(...chunk).run()
      }
    }

    debugLog.push(
      `[DB] daily_recommendations seed/upsert tradable=${finalCandidates.length} ` +
      `emerging_research=${emergingResearchCandidates.length}; ML owner fields preserved`,
    )

    try {
      const themeRuntime = await materializeScreenerThemeRuntime(env.DB, endDate, seedSymbols)
      const themeRuntimeStatus = themeRuntime.signals > 0 && themeRuntime.features > 0
        ? 'ok'
        : themeRuntime.signals > 0
          ? 'partial'
          : 'empty'
      themeRuntimeTelemetry = {
        status: themeRuntimeStatus,
        signals: themeRuntime.signals,
        tags: themeRuntime.tags,
        features: themeRuntime.features,
      }
      debugLog.push(
        `[DB] theme runtime ${themeRuntimeStatus} signals=${themeRuntime.signals} ` +
        `tags=${themeRuntime.tags} features=${themeRuntime.features}`,
      )
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      themeRuntimeTelemetry = { status: 'error', error }
      debugLog.push(`[DB] theme runtime materialization failed: ${error.slice(0, 180)}`)
      console.warn('[Screener v2] theme runtime materialization failed:', e)
    }

    // #15 ?郊撖?screener_selection_history 靘?甈?run 閮? freq flag
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
      console.warn('[Screener v2] #15 history insert failed (table may be missing, skip):', e)
    }

    // 撠撩 technical_indicators ??∠??唾?蝞?銝? Queue嚗??ML NO_SIGNAL嚗?
    try {
      const seedSymbolsForIndicators = [
        ...finalCandidates.map(c => c.symbol),
        ...emergingResearchCandidates.map(c => c.symbol),
      ].map(s => String(s || '').trim()).filter(Boolean)
      if (!seedSymbolsForIndicators.length) {
        debugLog.push('[DB] skipped technical_indicators seed backfill: no seed symbols')
      } else {
        const noTiStocks: Array<{ id: number; symbol: string }> = []
        for (const chunk of chunkArray(seedSymbolsForIndicators, D1_IN_CHUNK_SIZE)) {
          const ph = chunk.map(() => '?').join(',')
          const { results } = await env.DB.prepare(`
            SELECT s.id, s.symbol FROM stocks s
            WHERE s.symbol IN (${ph})
              AND NOT EXISTS (
                SELECT 1 FROM technical_indicators ti
                 WHERE ti.stock_id = s.id
                   AND ti.date >= date(?, '-3 days')
                   AND ti.date <= ?
              )
              AND EXISTS (SELECT 1 FROM stock_prices sp WHERE sp.stock_id = s.id LIMIT 1)
          `).bind(...chunk, endDate, endDate).all<{ id: number; symbol: string }>()
          noTiStocks.push(...(results ?? []))
        }

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
      console.warn('[Screener v2] ?啗 TI 鋆?憭望? (non-blocking):', e)
    }
  } catch (e) {
    console.warn('[Screener v2] daily_recommendations 撖怠憭望?:', e)
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

  // Discord ?
  try {
    const { sendDiscordNotification } = await import('./notify')
    // Phase 6.6: RRG moved to ml-controller; screener no longer has in-memory `rrg` map.
    // Leading industry list omitted from this notification (can be re-added by
    // querying sector_flow table if needed).
    const leadingIndustries = ''
    const topCands = finalCandidates.slice(0, 5).map(c => `${c.symbol}${c.name}(${c.score.toFixed(0)})`).join(' ')
    const pttTop = combinedBuzz.slice(0, 3).map(b => `${b.concept}(${b.mentionCount})`).join(', ')
    void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
      `**Bottom-up screener**\n` +
      `> candidates=${finalCandidates.length}/${maxCandidates}\n` +
      `> leading=${leadingIndustries || 'n/a'}\n` +
      `> top5=${topCands}\n` +
      `> ptt=${pttTop || 'n/a'}`)
  } catch (e) {
    console.warn('[Screener v2] Discord failed:', e)
  }

  // Final debug summary
  debugLog.push(`[Final] ${finalCandidates.length} 瑼?`)
  for (const c of finalCandidates) {
    debugLog.push(`  ${c.symbol} ${(c as any).name ?? ''} ${(c as any).industry ?? c.sector} score=${c.score.toFixed(1)}`)
  }

  try {
    if (!selectionEvidence) throw new Error('canonical_strategy_selection_evidence_missing')
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
        coarseMlKeepRatio: screenerPolicy.sizing.coarseMlKeepRatio,
        mlShortlistSize: screenerPolicy.sizing.mlShortlistSize,
        emergingResearchSize: screenerPolicy.sizing.emergingResearchSize,
        strategyCandidatePool: strategySelectionTelemetry,
        themeRuntime: themeRuntimeTelemetry,
        rawFundamentalSignals: rawFundamentalLoad.telemetry,
        fundamental_loader_error: l0RawSignalCoverageAudit.fundamental_loader_error,
        l0RawSignalCoverageAudit,
        finLabFactorNormalization: finLabFactorNormalizationTelemetry,
        restrictedCount: punishedSet.size,
        buzzConcepts: combinedBuzz.slice(0, 10).map(b => b.concept),
      },
      debugLog,
      items: funnelItems,
      selectionEvidence,
    })
  } catch (e) {
    console.warn('[Screener v2] funnel write failed:', e)
    throw e
  }

  return { hotSectors: sectorHeatScores, candidates: finalCandidates, emergingResearchCandidates, debugLog }
}

// ????????????????????????????????????????????????????????????????????????????????
// P2-7: IC嚗nformation Coefficient嚗?霅???
// P3-8: MAE ????
// P3-6: Z-score 撌亙
// ????????????????????????????????????????????????????????????????????????????????

/**
 * P3-6: Z-score 璅??極??
 * 撠遙??潮????Z-score嚗??[-3, 3]
 */
function zScore(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 0.001
  return values.map(v => Math.max(-3, Math.min(3, (v - mean) / std)))
}

/**
 * P2-7: ?? IC 閮? ????摮??芯? N ?亙?祉? Spearman rank correlation
 * ?冽撽? Score V2 鈭??Ｚ? finalScore ??皜砍?
 * ?瑼鳴?IC > 0.05 (ML), > 0.01 (Factor)
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

  // ?交??航蟡函??芯??梢嚗?d, 10d, 20d嚗?
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

  // 撱?symbol ??date ??close map
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

  // 閮? Score V2 taxonomy ????IC
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
      name: 'finalScore',
      value: (row: ScoreV2StorageRow) => readScoreV2Snapshot(row)?.finalScore ?? null,
    },
  ] as const
  const results = []

  for (const factor of factors) {
    const ic: { [horizon: string]: number[] } = { '5d': [], '10d': [], '20d': [] }

    // ???蝯?璈急??IC
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
 * P3-8: MAE ???? ????predictions 銵函? max_adverse_pct ???雿喳???
 */
export async function analyzeMAE(env: Bindings): Promise<{
  summary: {
    total_trades: number
    winning_trades: number
    losing_trades: number
    winning_mae_p75: number   // ?脣鈭斗???75 ?曉?雿?MAE
    losing_mae_p25: number    // ?扳?鈭斗???25 ?曉?雿?MAE
    suggested_stop: number    // 撱箄降?? %
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

  // MAE ??嚗? 2% 銝??bucket嚗?
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

  // ?曉?雿?蝞?
  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * p)
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0
  }

  const winMAEs = winning.map(t => t.max_adverse_pct)
  const loseMAEs = losing.map(t => t.max_adverse_pct)

  // 撱箄降??嚗?拐漱??75 ?曉?雿?MAE嚗??之?典??脣鈭斗?嚗?
  const winP75 = winMAEs.length ? percentile(winMAEs, 0.25) : -0.05  // 25th percentile of MAE (most negative)
  const suggestedStop = Math.min(winP75 * 1.2, -0.03)  // 憭? 20% buffer嚗?撠?-3%

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
