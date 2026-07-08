import type { Bindings } from '../types'
import {
  assessS12IntradayStructureFromBaseBars,
  s12TimingPolicyFromEnv,
  type S12IntradayAssessment,
} from './s12IntradayStructure'
import { loadS12HistoricalReplayBars } from './s12RuntimeBars'
import { persistS12StructureSnapshot } from './s12StructureSnapshots'

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
  source: 's12_candidate_snapshot'
  candidate_count: number
  attempted: number
  persisted: number
  ready: number
  setup_only: number
  skipped: number
  errors: number
  limit: number
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
  } = {},
): Promise<S12CandidateSnapshotSummary> {
  const limit = positiveLimit(options.limit ?? (env as any).S12_PREPIPELINE_SNAPSHOT_LIMIT, 160)
  const candidates = options.symbols ?? await loadS12PipelineSeedSymbolsByDate(env.DB, tradeDate, limit)
  const selected = candidates.slice(0, limit)
  const loadBars = options.loadBars ?? loadS12HistoricalReplayBars
  const policy = s12TimingPolicyFromEnv(env as any)
  let persisted = 0
  let ready = 0
  let setupOnly = 0
  let skipped = 0
  let errors = 0

  for (const row of selected) {
    try {
      const loaded = await loadBars(env, row.symbol, tradeDate)
      if (!loaded.bars.length) {
        skipped += 1
        continue
      }
      const assessment = assessS12IntradayStructureFromBaseBars({
        symbol: row.symbol,
        baseBars: loaded.bars,
        fallback15mBars: loaded.fallback15mBars,
        fallback1hBars: loaded.fallback1hBars,
        fallback4hBars: loaded.fallback4hBars,
        nowMs: lastBarEndMs(loaded.bars),
        policy,
        barDiagnostics: loaded.diagnostics,
        h4ReferenceDate: loaded.diagnostics.previous_4h_reference_date ?? null,
        h4ReferenceClose: Number(loaded.diagnostics.previous_4h_reference_close ?? 0) || null,
      })
      const ok = await persistS12StructureSnapshot(env, {
        tradeDate,
        symbol: row.symbol,
        assessment,
        source: 's12_candidate_snapshot',
        side: 'buy',
      })
      if (ok) persisted += 1
      if (assessment.ready) ready += 1
      else if (isSetupOnly(assessment)) setupOnly += 1
      else skipped += 1
    } catch (error) {
      errors += 1
      console.warn(`[S12CandidateSnapshot] ${row.symbol} skipped:`, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    schema_version: 's12-candidate-structure-snapshot-summary-v1',
    trade_date: tradeDate,
    source: 's12_candidate_snapshot',
    candidate_count: candidates.length,
    attempted: selected.length,
    persisted,
    ready,
    setup_only: setupOnly,
    skipped,
    errors,
    limit,
  }
}

