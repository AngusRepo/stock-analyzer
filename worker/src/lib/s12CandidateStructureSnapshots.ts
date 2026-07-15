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
} from './s12TwEquityCalibration'
import { acquireS12ResearchLease, releaseS12ResearchLease } from './s12ResearchLease'

const M15_MS = 15 * 60_000

export interface S12PipelineSeedSymbol {
  symbol: string
  name?: string | null
  rank?: number | null
  score_after?: number | null
  stage?: string | null
}

export interface S12CandidateSnapshotSummary {
  schema_version: 's12-candidate-structure-snapshot-summary-v1'
  trade_date: string
  source: string
  candidate_count: number
  attempted: number
  persisted: number
  ready: number
  setup_only: number
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
  ].includes(String(assessment.state ?? ''))
}

export async function loadS12PipelineSeedSymbolsByDate(
  db: D1Database,
  tradeDate: string,
  limit = 160,
): Promise<S12PipelineSeedSymbol[]> {
  const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const { results } = await db.prepare(`
    WITH latest_screener_run AS (
      SELECT run_id
        FROM screener_funnel_runs
       WHERE date = ?
         AND status = 'success'
       ORDER BY created_at DESC
       LIMIT 1
    ),
    candidate_seed AS (
      SELECT
          sfi.*,
          ROW_NUMBER() OVER (
            PARTITION BY sfi.symbol
            ORDER BY
              CASE sfi.stage
                WHEN 'l1_candidate_seed_after_overlay' THEN 0
                WHEN 'final_selection' THEN 1
                ELSE 3
              END,
              COALESCE(sfi.rank, 999999),
              sfi.created_at DESC
          ) AS stage_preference_rank
        FROM screener_funnel_items sfi
       WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
         AND (
              (sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected')
           OR (sfi.stage = 'final_selection' AND sfi.decision = 'selected')
         )
    )
    SELECT symbol, name, rank, score_after, stage
      FROM candidate_seed
     WHERE stage_preference_rank = 1
     ORDER BY COALESCE(rank, 999999), symbol
     LIMIT ?
  `).bind(tradeDate, cappedLimit).all<S12PipelineSeedSymbol>()

  return (results ?? [])
    .map((row) => ({
      symbol: String(row.symbol ?? '').trim(),
      name: row.name ?? null,
      rank: row.rank ?? null,
      score_after: row.score_after ?? null,
      stage: row.stage ?? null,
    }))
    .filter((row) => row.symbol)
}

export async function runS12CandidateStructureSnapshots(
  env: Bindings,
  tradeDate: string,
  options: {
    limit?: number
    symbols?: S12PipelineSeedSymbol[]
    loadBars?: typeof loadS12HistoricalReplayBars
    source?: 's12_candidate_snapshot' | 's12_candidate_snapshot_reconstruction'
  } = {},
): Promise<S12CandidateSnapshotSummary> {
  const snapshotSource = options.source ?? 's12_candidate_snapshot'
  const leaseRunId = `s12-candidate:${snapshotSource}:${tradeDate}:${crypto.randomUUID()}`
  const leaseAcquired = options.loadBars
    ? false
    : await acquireS12ResearchLease(env.DB, leaseRunId, tradeDate)
  if (!options.loadBars && !leaseAcquired) {
    throw new Error(`s12_research_lease_busy:${tradeDate}`)
  }
  try {
  const limit = positiveLimit(options.limit ?? (env as any).S12_PREPIPELINE_SNAPSHOT_LIMIT, 160)
  const candidates = options.symbols ?? await loadS12PipelineSeedSymbolsByDate(env.DB, tradeDate, limit)
  const selected = candidates.slice(0, limit)
  const loadBars = options.loadBars ?? loadS12HistoricalReplayBars
  const basePolicy = s12TimingPolicyFromEnv(env as any)
  const calibrationArtifacts = await listApprovedS12TwCalibrationArtifacts(env.DB, { includeSuperseded: true }).catch(() => [])
  let persisted = 0
  let ready = 0
  let setupOnly = 0
  let skipped = 0
  let errors = 0
  const skipReasons: Record<string, number> = {}
  let terminalDataSourceReason: string | null = null
  const recordSkipReason = (reason: unknown) => {
    const key = String(reason ?? 'unknown').trim().replace(/\s+/g, '_').slice(0, 160) || 'unknown'
    skipReasons[key] = (skipReasons[key] ?? 0) + 1
  }

  for (const row of selected) {
    try {
      if (terminalDataSourceReason) {
        const ok = await persistS12UnavailableStructureSnapshot(env, {
          tradeDate,
          symbol: row.symbol,
          source: snapshotSource,
          side: 'buy',
          reason: terminalDataSourceReason,
          metadata: {
            snapshot_policy: 'persist_unavailable_continue_analysis_fail_closed_execution',
            source_circuit_open: true,
          },
        })
        if (ok) persisted += 1
        else errors += 1
        skipped += 1
        recordSkipReason(terminalDataSourceReason)
        continue
      }
      const loaded = await loadBars(env, row.symbol, tradeDate)
      if (!loaded.bars.length) {
        const reason = loaded.diagnostics.kbars_error ?? loaded.diagnostics.kbars_unusable_reason ?? 'missing_intraday_bars'
        terminalDataSourceReason = s12ResearchTerminalDataSourceReason(loaded.diagnostics)
        const ok = await persistS12UnavailableStructureSnapshot(env, {
          tradeDate,
          symbol: row.symbol,
          source: snapshotSource,
          side: 'buy',
          reason: terminalDataSourceReason ?? reason,
          metadata: {
            diagnostics: loaded.diagnostics,
            snapshot_policy: 'persist_unavailable_continue_analysis_fail_closed_execution',
          },
        })
        if (ok) persisted += 1
        else errors += 1
        skipped += 1
        recordSkipReason(terminalDataSourceReason ?? reason)
        continue
      }
      const stockRow = await env.DB.prepare('SELECT market FROM stocks WHERE symbol = ? LIMIT 1').bind(row.symbol).first<{ market?: string | null }>()
      const calibration = resolveS12TwCalibrationArtifact(calibrationArtifacts, {
        marketSegment: stockRow?.market ?? 'UNKNOWN',
        asOfDate: tradeDate,
      })
      const assessment = assessS12IntradayStructureFromBaseBars({
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
      const ok = await persistS12StructureSnapshot(env, {
        tradeDate,
        symbol: row.symbol,
        assessment,
        source: snapshotSource,
        side: 'buy',
        metadata: {
          calibration_artifact_id: calibration?.artifactId ?? null,
          calibration_scope: calibration?.scope ?? null,
        },
      })
      if (ok) persisted += 1
      if (assessment.ready) ready += 1
      else if (isSetupOnly(assessment)) setupOnly += 1
      else skipped += 1
    } catch (error) {
      errors += 1
      recordSkipReason(error instanceof Error ? error.message : String(error))
      console.warn(`[S12CandidateSnapshot] ${row.symbol} skipped:`, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    schema_version: 's12-candidate-structure-snapshot-summary-v1',
    trade_date: tradeDate,
    source: snapshotSource,
    candidate_count: candidates.length,
    attempted: selected.length,
    persisted,
    ready,
    setup_only: setupOnly,
    skipped,
    errors,
    limit,
    skip_reasons: skipReasons,
  }
  } finally {
    if (leaseAcquired) await releaseS12ResearchLease(env.DB, leaseRunId)
  }
}
