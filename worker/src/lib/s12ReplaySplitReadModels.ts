import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadCoreStockIdentitiesBySymbols } from './stockIdentityMarketBridge'
import { EVIDENCE_LABEL_SCHEMA_VERSION } from './evidenceContracts'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'
import {
  ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD,
  type FusionSnapshotReplayCoverage,
  type S12L0PassedSymbol,
} from './s12ReplayTradeOutcome'

type DomainEnv = Pick<Bindings, 'DB'> & Partial<Bindings>
const D1_CHUNK_SIZE = 36
const SEALED_SOURCE = 'allocator_ev_asof_backfill_v2'
const SEALED_REVALIDATION_SOURCE = 'allocator_snapshot_ledger_revalidation_v1'

function chunks<T>(rows: T[]): T[][] {
  const output: T[][] = []
  for (let offset = 0; offset < rows.length; offset += D1_CHUNK_SIZE) output.push(rows.slice(offset, offset + D1_CHUNK_SIZE))
  return output
}

async function enrichCoreRows(
  env: DomainEnv,
  signalDate: string,
  rows: S12L0PassedSymbol[],
): Promise<S12L0PassedSymbol[]> {
  const symbols = [...new Set(rows.map((row) => String(row.symbol ?? '').trim()).filter(Boolean))]
  const identities = await loadCoreStockIdentitiesBySymbols(env, symbols)
  const recommendationBySymbol = new Map<string, any>()
  for (const chunk of chunks(symbols)) {
    const marks = chunk.map(() => '?').join(',')
    const result = await databaseForDataDomain(env, 'core').prepare(`
      SELECT symbol, rank, alpha_context, alpha_allocation
        FROM daily_recommendations
       WHERE date=? AND symbol IN (${marks})
    `).bind(signalDate, ...chunk).all<any>()
    for (const row of result.results ?? []) recommendationBySymbol.set(String(row.symbol), row)
  }
  return rows.map((row) => {
    const symbol = String(row.symbol ?? '').trim()
    const identity = identities.get(symbol)
    const recommendation = recommendationBySymbol.get(symbol)
    return {
      ...row,
      symbol,
      name: row.name ?? identity?.name ?? null,
      market: row.market ?? identity?.market ?? null,
      rank: row.rank ?? recommendation?.rank ?? null,
      alpha_context: row.alpha_context ?? recommendation?.alpha_context ?? null,
      alpha_allocation: row.alpha_allocation ?? recommendation?.alpha_allocation ?? null,
    }
  }).filter((row) => row.symbol)
}

export async function loadSplitCanonicalSelectionSymbols(env: DomainEnv, signalDate: string): Promise<S12L0PassedSymbol[]> {
  const head = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT run_id FROM canonical_run_heads
     WHERE logical_run_key=? LIMIT 1
  `).bind(`screener:${signalDate}:TW:production:market_screener`).first<{ run_id?: string | null }>()
  const canonicalRunId = String(head?.run_id ?? '').trim()
  if (!canonicalRunId) return []
  const result = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT symbol, name, score_v2 AS score_after, rejection_reason AS evidence,
           market_segment, producer_run_id AS replay_cohort_id
      FROM selection_reference_snapshots_v1
     WHERE signal_date=? AND hard_gate_passed=1 AND feature_available=1 AND producer_run_id=?
     ORDER BY symbol
  `).bind(signalDate, canonicalRunId).all<any>()
  return enrichCoreRows(env, signalDate, (result.results ?? []).map((row) => ({
    ...row,
    replay_cohort_source: 'canonical_selection_reference_v1',
    replay_model_set_signature: null,
    replay_target_semantic_version: null,
  })))
}

async function sealedFusionRows(env: DomainEnv, signalDate: string): Promise<S12L0PassedSymbol[]> {
  const result = await databaseForDataDomain(env, 'learning').prepare(`
    WITH ranked AS (
      SELECT fs.*,
             ROW_NUMBER() OVER (PARTITION BY fs.symbol ORDER BY fs.generated_at DESC) AS rn
        FROM allocator_ev_feature_snapshots fs
       WHERE fs.snapshot_date=?
         AND fs.snapshot_source=?
         AND fs.as_of_guard=?
         AND fs.generation_mode='native'
         AND json_extract(fs.score_components, '$.version')='score_v2'
         AND COALESCE(NULLIF(fs.model_set_signature, ''), NULLIF(json_extract(fs.forecast_data, '$.ensemble_v2.model_set_signature'), '')) IS NOT NULL
         AND COALESCE(
           NULLIF(fs.target_semantic_version, ''),
           NULLIF(json_extract(fs.forecast_data, '$.ensemble_v2.target_semantic_version'), ''),
           NULLIF(json_extract(fs.forecast_data, '$.model_score_lineage.target_semantic_version'), '')
         )=?
         AND EXISTS (
           SELECT 1 FROM allocator_ev_snapshot_runs sr
            WHERE sr.snapshot_date=fs.snapshot_date AND sr.snapshot_source=fs.snapshot_source
              AND sr.as_of_guard=fs.as_of_guard AND sr.status='ready' AND sr.error_code IS NULL
              AND sr.expected_rows=sr.published_rows AND sr.published_rows>0
              AND sr.native_lineage_rows=sr.published_rows
              AND sr.reconstructed_lineage_rows=0 AND sr.rejected_lineage_rows=0
         )
    )
    SELECT symbol, score AS score_after, market_segment, alpha_context, alpha_allocation,
           COALESCE(NULLIF(lineage_cohort_id, ''), snapshot_source || ':' || snapshot_date) AS replay_cohort_id,
           COALESCE(NULLIF(model_set_signature, ''), json_extract(forecast_data, '$.ensemble_v2.model_set_signature')) AS replay_model_set_signature,
           COALESCE(
             NULLIF(target_semantic_version, ''),
             NULLIF(json_extract(forecast_data, '$.ensemble_v2.target_semantic_version'), ''),
             json_extract(forecast_data, '$.model_score_lineage.target_semantic_version')
           ) AS replay_target_semantic_version
      FROM ranked WHERE rn=1 ORDER BY symbol
  `).bind(
    signalDate,
    SEALED_SOURCE,
    ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD,
    EVIDENCE_LABEL_SCHEMA_VERSION,
  ).all<any>()
  return enrichCoreRows(env, signalDate, (result.results ?? []).map((row) => ({
    ...row,
    replay_cohort_source: SEALED_REVALIDATION_SOURCE,
  })))
}

async function replayCandidates(env: DomainEnv, signalDate: string): Promise<S12L0PassedSymbol[]> {
  const [canonical, sealed] = await Promise.all([
    loadSplitCanonicalSelectionSymbols(env, signalDate),
    sealedFusionRows(env, signalDate),
  ])
  const bySymbol = new Map<string, S12L0PassedSymbol>()
  for (const row of [...canonical, ...sealed]) if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row)
  return [...bySymbol.values()]
}

async function maturityBySymbol(
  env: DomainEnv,
  symbols: string[],
  signalDate: string,
  maturityAsOfDate: string,
): Promise<Map<string, number>> {
  const output = new Map(symbols.map((symbol) => [symbol, 0]))
  for (const chunk of chunks(symbols)) {
    const marks = chunk.map(() => '?').join(',')
    const result = await databaseForDataDomain(env, 'market').prepare(`
      SELECT stock_id, COUNT(DISTINCT date) AS completed_sessions
        FROM canonical_market_daily
       WHERE stock_id IN (${marks}) AND source='finlab.price'
         AND date(date)>date(?) AND date(date)<=date(?)
         AND open>0 AND high>0 AND low>0 AND close>0
       GROUP BY stock_id
    `).bind(...chunk, signalDate, maturityAsOfDate).all<any>()
    for (const row of result.results ?? []) output.set(String(row.stock_id), Number(row.completed_sessions ?? 0))
  }
  return output
}

async function terminalReplaySymbols(env: DomainEnv, signalDate: string, symbols: string[]): Promise<Set<string>> {
  const output = new Set<string>()
  for (const chunk of chunks(symbols)) {
    const marks = chunk.map(() => '?').join(',')
    const result = await databaseForDataDomain(env, 'learning').prepare(`
      SELECT DISTINCT symbol FROM s12_replay_trade_outcomes
       WHERE signal_date=? AND symbol IN (${marks}) AND source='s12_multisession_structure_replay_v3'
         AND NOT (
           COALESCE(json_extract(detail_json, '$.observation_kind'), '')='unavailable'
           AND COALESCE(json_extract(detail_json, '$.status_reason'), '') IN (
             'missing_intraday_bars', 'missing_entry_session_bars', 'missing_post_entry_bars',
             'missing_five_session_lifecycle_bars', 'unresolved_execution_date'
           )
         )
    `).bind(signalDate, ...chunk).all<{ symbol: string }>()
    for (const row of result.results ?? []) output.add(String(row.symbol))
  }
  return output
}

export async function loadSplitFusionSnapshotSymbols(
  env: DomainEnv,
  signalDate: string,
  limit = 40,
  offset = 0,
): Promise<S12L0PassedSymbol[]> {
  const result = await databaseForDataDomain(env, 'learning').prepare(`
    WITH latest_snapshot AS (
      SELECT fs.*,
             ROW_NUMBER() OVER (PARTITION BY fs.symbol ORDER BY fs.generated_at DESC, fs.snapshot_source DESC) AS rn
        FROM allocator_ev_feature_snapshots fs
       WHERE fs.snapshot_date=?
         AND json_extract(fs.score_components, '$.version')='score_v2'
         AND fs.snapshot_source=? AND fs.as_of_guard=?
    )
    SELECT symbol, score AS score_after, market_segment, alpha_context, alpha_allocation
      FROM latest_snapshot WHERE rn=1 ORDER BY symbol
  `).bind(signalDate, SEALED_SOURCE, ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD).all<any>()
  const enriched = await enrichCoreRows(env, signalDate, result.results ?? [])
  enriched.sort((left, right) => Number(left.rank ?? 999999) - Number(right.rank ?? 999999) || left.symbol.localeCompare(right.symbol))
  const safeOffset = Math.max(0, Math.floor(offset))
  const safeLimit = Math.max(1, Math.min(160, Math.floor(limit)))
  return enriched.slice(safeOffset, safeOffset + safeLimit)
}
export async function loadSplitFusionSnapshotMissingReplaySymbols(
  env: DomainEnv,
  signalDate: string,
  maturityAsOfDate = '9999-12-31',
): Promise<S12L0PassedSymbol[]> {
  const candidates = await replayCandidates(env, signalDate)
  const symbols = candidates.map((row) => row.symbol)
  const [maturity, terminal] = await Promise.all([
    maturityBySymbol(env, symbols, signalDate, maturityAsOfDate),
    terminalReplaySymbols(env, signalDate, symbols),
  ])
  return candidates.filter((row) => (maturity.get(row.symbol) ?? 0) >= 5 && !terminal.has(row.symbol))
}

export async function loadSplitFusionSnapshotReplayCoverage(
  env: DomainEnv,
  signalDate: string,
  maturityAsOfDate: string,
): Promise<FusionSnapshotReplayCoverage> {
  const candidates = await replayCandidates(env, signalDate)
  const symbols = candidates.map((row) => row.symbol)
  const [maturity, terminal] = await Promise.all([
    maturityBySymbol(env, symbols, signalDate, maturityAsOfDate),
    terminalReplaySymbols(env, signalDate, symbols),
  ])
  return {
    totalSnapshotRows: symbols.length,
    replayRows: symbols.filter((symbol) => terminal.has(symbol)).length,
    matureMissingRows: symbols.filter((symbol) => !terminal.has(symbol) && (maturity.get(symbol) ?? 0) >= 5).length,
    pendingMaturityRows: symbols.filter((symbol) => !terminal.has(symbol) && (maturity.get(symbol) ?? 0) < 5).length,
  }
}

export async function loadSplitSignedEligibleRepairSymbolsByHistoricalDate(
  env: DomainEnv,
  signalDate: string,
): Promise<S12L0PassedSymbol[]> {
  const result = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT DISTINCT legacy.symbol
      FROM s12_replay_trade_outcomes legacy
     WHERE legacy.signal_date=?
       AND (legacy.sample_eligible=1 OR json_extract(legacy.detail_json, '$.lineage_validation.previous_sample_eligible')=1)
       AND (
         legacy.sample_eligible!=1
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.replay_engine_signature'), '')!=?
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.entry_policy_signature'), '')=''
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.exit_calibration_signature'), '')=''
         OR COALESCE(json_extract(legacy.detail_json, '$.replay_diagnostics.replay_cohort_signature'), '')=''
       )
       AND NOT EXISTS (
         SELECT 1 FROM s12_replay_trade_outcomes current
          WHERE current.signal_date=legacy.signal_date AND current.symbol=legacy.symbol
            AND (
              (
                current.sample_eligible=1
                AND json_extract(current.detail_json, '$.replay_diagnostics.replay_engine_signature')=?
                AND COALESCE(json_extract(current.detail_json, '$.replay_diagnostics.entry_policy_signature'), '')!=''
                AND COALESCE(json_extract(current.detail_json, '$.replay_diagnostics.exit_calibration_signature'), '')!=''
                AND json_extract(current.detail_json, '$.replay_diagnostics.replay_cohort_signature')=(
                  ? || '|entry=' || lower(json_extract(current.detail_json, '$.replay_diagnostics.entry_policy_signature'))
                  || '|calibration=' || json_extract(current.detail_json, '$.replay_diagnostics.exit_calibration_signature')
                )
              )
              OR (
                current.sample_eligible=0
                AND json_extract(current.detail_json, '$.lineage_validation.status')='signed_repair_terminal_noneligible'
                AND json_extract(current.detail_json, '$.replay_diagnostics.replay_engine_signature')=?
                AND date(json_extract(current.detail_json, '$.replay_diagnostics.outcome_known_date')) IS NOT NULL
              )
            )
       )
     ORDER BY legacy.symbol
  `).bind(
    signalDate,
    S12_REPLAY_ENGINE_SIGNATURE,
    S12_REPLAY_ENGINE_SIGNATURE,
    S12_REPLAY_ENGINE_SIGNATURE,
    S12_REPLAY_ENGINE_SIGNATURE,
  ).all<{ symbol: string }>()
  const pending = new Set((result.results ?? []).map((row) => String(row.symbol)))
  return (await replayCandidates(env, signalDate)).filter((row) => pending.has(row.symbol))
}