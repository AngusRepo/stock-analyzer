import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'
import {
  assessS12IntradayStructureFromBaseBars,
  s12TimingPolicyFromEnv,
  type S12IntradayAssessment,
} from './s12IntradayStructure'
import {
  loadS12HistoricalReplayBars,
  s12ResearchTerminalDataSourceReason,
} from './s12RuntimeBars'
import {
  persistS12StructureSnapshot,
  persistS12UnavailableStructureSnapshot,
} from './s12StructureSnapshots'
import {
  applyS12TwCalibrationArtifact,
  listApprovedS12TwCalibrationArtifacts,
  resolveS12TwCalibrationArtifact,
  type S12TwCalibrationArtifact,
} from './s12TwEquityCalibration'
import {
  acquireS12ResearchLease,
  assertS12ResearchLeaseRenewed,
  isS12ResearchLeaseLost,
  releaseS12ResearchLease,
} from './s12ResearchLease'

const M15_MS = 15 * 60_000

export interface S12ResearchCohortSymbol {
  symbol: string
  name?: string | null
  rank?: number | null
  score_after?: number | null
  stage?: string | null
}

export interface S12ResearchSnapshotSummary {
  schema_version: 's12-research-structure-snapshot-summary-v1'
  trade_date: string
  source: string
  candidate_count: number
  attempted: number
  persisted: number
  ready: number
  setup_only: number
  unavailable: number
  blocked: number
  skipped: number
  errors: number
  limit: number
  skip_reasons: Record<string, number>
}

function positiveLimit(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function lastBarEndMs(bars: Array<{ startMs: number }>): number {
  const last = bars.length ? bars[bars.length - 1] : null
  return Number.isFinite(last?.startMs) ? Number(last?.startMs) + M15_MS : Date.now()
}

function isSetupOnly(assessment: S12IntradayAssessment): boolean {
  return [
    'waiting_sweep',
    'waiting_choch',
    'waiting_bos',
    'waiting_retest',
    'waiting_reaction',
    'waiting_1h_demand_zone',
    'waiting_15m_zone_touch',
  ].includes(String(assessment.state ?? ''))
}

export async function loadS12ResearchCohortSymbolsByDate(
  db: D1Database,
  tradeDate: string,
  limit = 1000,
  afterSymbol = '',
): Promise<S12ResearchCohortSymbol[]> {
  const cappedLimit = Math.max(1, Math.min(2000, Math.floor(limit)))
  const { results } = await db.prepare(`
    SELECT r.symbol, r.name, NULL rank, r.score_v2 score_after, r.selection_stage stage
      FROM selection_reference_snapshots_v1 r
     WHERE r.signal_date = ?
       AND r.symbol > ?
       AND EXISTS (
         SELECT 1 FROM canonical_run_heads h
          WHERE h.logical_run_key = 'screener:' || r.signal_date || ':TW:production:market_screener'
            AND h.run_id = r.producer_run_id
       )
     ORDER BY r.symbol
     LIMIT ?
  `).bind(tradeDate, afterSymbol, cappedLimit + 1).all<S12ResearchCohortSymbol>()
  return (results ?? []).map((row) => ({
    symbol: String(row.symbol ?? '').trim(),
    name: row.name ?? null,
    rank: row.rank ?? null,
    score_after: row.score_after ?? null,
    stage: row.stage ?? null,
  })).filter((row) => row.symbol)
}

async function loadS12ResearchCohortSymbolsAcrossDomains(
  env: Bindings,
  tradeDate: string,
  limit: number,
): Promise<S12ResearchCohortSymbol[]> {
  const head = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT run_id FROM canonical_run_heads WHERE logical_run_key=? LIMIT 1
  `).bind(`screener:${tradeDate}:TW:production:market_screener`).first<{ run_id?: string | null }>()
  const canonicalRunId = String(head?.run_id ?? '').trim()
  if (!canonicalRunId) return []
  const cappedLimit = Math.max(1, Math.min(2000, Math.floor(limit)))
  const result = await databaseForDataDomain(env, 'learning').prepare(`
    SELECT symbol, name, NULL AS rank, score_v2 AS score_after, selection_stage AS stage
      FROM selection_reference_snapshots_v1
     WHERE signal_date=? AND producer_run_id=?
     ORDER BY symbol
     LIMIT ?
  `).bind(tradeDate, canonicalRunId, cappedLimit + 1).all<S12ResearchCohortSymbol>()
  return (result.results ?? []).map((row) => ({
    ...row,
    symbol: String(row.symbol ?? '').trim(),
  })).filter((row) => row.symbol)
}

export async function runS12ResearchStructureSnapshots(
  env: Bindings,
  tradeDate: string,
  options: {
    limit?: number
    symbols?: S12ResearchCohortSymbol[]
    loadBars?: typeof loadS12HistoricalReplayBars
    source?: 's12_research_structure_snapshot' | 's12_research_structure_reconstruction'
    pendingRunId?: string
  } = {},
): Promise<S12ResearchSnapshotSummary> {
  const snapshotSource = options.source ?? 's12_research_structure_snapshot'
  const leaseRunId = `s12-research-structure:${snapshotSource}:${tradeDate}:${crypto.randomUUID()}`
  const opsDb = databaseForDataDomain(env, 'ops')
  const learningDb = databaseForDataDomain(env, 'learning')
  const leaseAcquired = options.loadBars
    ? false
    : await acquireS12ResearchLease(opsDb, leaseRunId, tradeDate)
  if (!options.loadBars && !leaseAcquired) {
    throw new Error(`s12_research_lease_busy:${tradeDate}`)
  }
  const assertLeaseOwned = async (): Promise<void> => {
    if (leaseAcquired) await assertS12ResearchLeaseRenewed(opsDb, leaseRunId)
  }
  try {
  const limit = Math.min(2000, positiveLimit(options.limit ?? (env as any).S12_RESEARCH_SNAPSHOT_LIMIT, 1000))
  const candidates = options.symbols ?? await loadS12ResearchCohortSymbolsAcrossDomains(env, tradeDate, limit)
  const selected = candidates.slice(0, limit)
  const loadBars = options.loadBars ?? loadS12HistoricalReplayBars
  const basePolicy = s12TimingPolicyFromEnv(env as any)
  const calibrationArtifacts = await listApprovedS12TwCalibrationArtifacts(learningDb, { includeSuperseded: true }).catch(() => [])
  let persisted = 0
  let ready = 0
  let setupOnly = 0
  let unavailable = 0
  let blocked = 0
  let skipped = 0
  let errors = 0
  const skipReasons: Record<string, number> = {}
  let terminalDataSourceReason: string | null = null
  const recordSkipReason = (reason: unknown) => {
    const key = String(reason ?? 'unknown').trim().replace(/\s+/g, '_').slice(0, 160) || 'unknown'
    skipReasons[key] = (skipReasons[key] ?? 0) + 1
  }

  for (const row of selected) {
    await assertLeaseOwned()
    try {
      if (terminalDataSourceReason) {
        await assertLeaseOwned()
        const ok = await persistS12UnavailableStructureSnapshot(env, {
          tradeDate,
          symbol: row.symbol,
          source: snapshotSource,
          pendingRunId: options.pendingRunId,
          side: 'buy',
          reason: terminalDataSourceReason,
          metadata: {
            snapshot_policy: 'persist_unavailable_continue_analysis_fail_closed_execution',
            source_circuit_open: true,
          },
        })
        if (ok) persisted += 1
        else errors += 1
        unavailable += 1
        skipped += 1
        recordSkipReason(terminalDataSourceReason)
        continue
      }
      const loaded = await loadBars(env, row.symbol, tradeDate)
      if (!loaded.bars.length) {
        const reason = loaded.diagnostics.kbars_error ?? loaded.diagnostics.kbars_unusable_reason ?? 'missing_intraday_bars'
        terminalDataSourceReason = s12ResearchTerminalDataSourceReason(loaded.diagnostics)
        await assertLeaseOwned()
        const ok = await persistS12UnavailableStructureSnapshot(env, {
          tradeDate,
          symbol: row.symbol,
          source: snapshotSource,
          pendingRunId: options.pendingRunId,
          side: 'buy',
          reason: terminalDataSourceReason ?? reason,
          metadata: {
            diagnostics: loaded.diagnostics,
            snapshot_policy: 'persist_unavailable_continue_analysis_fail_closed_execution',
          },
        })
        if (ok) persisted += 1
        else errors += 1
        unavailable += 1
        skipped += 1
        recordSkipReason(terminalDataSourceReason ?? reason)
        continue
      }
      const stockRow = await databaseForDataDomain(env, 'core').prepare('SELECT market FROM stocks WHERE symbol = ? LIMIT 1').bind(row.symbol).first<{ market?: string | null }>()
      const assess = (calibration: S12TwCalibrationArtifact | null) => assessS12IntradayStructureFromBaseBars({
        symbol: row.symbol,
        baseBars: loaded.bars,
        fallback15mBars: loaded.fallback15mBars,
        fallback1hBars: loaded.fallback1hBars,
        fallback4hBars: loaded.fallback4hBars,
        fallbackDailyBars: loaded.fallbackDailyBars,
        nowMs: lastBarEndMs(loaded.bars),
        policy: applyS12TwCalibrationArtifact(basePolicy, calibration),
        barDiagnostics: {
          ...loaded.diagnostics,
          calibration_artifact_id: calibration?.artifactId ?? null,
          calibration_scope: calibration?.scope ?? null,
        },
        h4ReferenceDate: loaded.diagnostics.previous_daily_context_date ?? null,
        h4ReferenceClose: Number(loaded.diagnostics.previous_daily_raw_close ?? 0) || null,
      })
      const preliminary = assess(null)
      const calibration = resolveS12TwCalibrationArtifact(calibrationArtifacts, {
        entryCohort: preliminary.state === 'limited_takeover_ready' ? 'limited_takeover_ready' : 'reaction_ready',
        marketSegment: stockRow?.market ?? 'UNKNOWN',
        asOfDate: tradeDate,
      })
      const assessment = calibration ? assess(calibration) : preliminary
      await assertLeaseOwned()
      const ok = await persistS12StructureSnapshot(env, {
        tradeDate,
        symbol: row.symbol,
        assessment,
        source: snapshotSource,
        side: 'buy',
        pendingRunId: options.pendingRunId,
        metadata: {
          calibration_artifact_id: calibration?.artifactId ?? null,
          calibration_scope: calibration?.scope ?? null,
        },
      })
      if (ok) persisted += 1
      if (assessment.ready) ready += 1
      else if (isSetupOnly(assessment)) setupOnly += 1
      else {
        blocked += 1
        skipped += 1
      }
    } catch (error) {
      if (isS12ResearchLeaseLost(error)) throw error
      errors += 1
      recordSkipReason(error instanceof Error ? error.message : String(error))
      console.warn(`[S12ResearchStructureSnapshot] ${row.symbol} skipped:`, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    schema_version: 's12-research-structure-snapshot-summary-v1',
    trade_date: tradeDate,
    source: snapshotSource,
    candidate_count: candidates.length,
    attempted: selected.length,
    persisted,
    ready,
    setup_only: setupOnly,
    unavailable,
    blocked,
    skipped,
    errors,
    limit,
    skip_reasons: skipReasons,
  }
  } finally {
    if (leaseAcquired) await releaseS12ResearchLease(opsDb, leaseRunId)
  }
}
