import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { logSchedulerResult, type SchedulerRunLogEntry } from './schedulerRunLogger'
import {
  buildPitResidualCounterfactuals,
  loadPitResidualShadowSnapshot,
  PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED,
  PIT_RESIDUAL_DEBATE_VISIBILITY,
  PIT_RESIDUAL_PRIMARY_HORIZON_SESSIONS,
  PIT_RESIDUAL_SHADOW_APPLICATION_MODE,
  PIT_RESIDUAL_SHADOW_WEIGHT,
} from './pitResidualShadow'

const RESIDUAL_STAGE = 'pit_residual_momentum_shadow'
const BASE_STAGE = 'pit_residual_momentum_shadow_base'
const LEGACY_BASE_STAGE = 'l15_ml_slate_queue'
const INSERT_ROWS_PER_STATEMENT = 7
const ENRICHMENT_TASK = 'pit-residual-funnel-enrichment'
const SNAPSHOT_MISSING_PREFIX = 'pit_residual_same_day_snapshot_missing:'
// The post-close snapshot job lands the same-day shadow about six minutes after
// the 14:20 dispatch queues this chain; past this window a missing shadow is a failure.
const SNAPSHOT_PENDING_WINDOW_MS = 90 * 60_000

type CanonicalScreenerRun = {
  run_id: string
  status: string
  candidate_count: number | string
  final_count: number | string
}

type BaseCandidate = {
  symbol: string
  name: string | null
  score_after: number | string
  rank: number | string | null
}

export type PitResidualFunnelEnrichmentResult = {
  businessDate: string
  screenerRunId: string
  pipelineCanonicalRunId: string
  sourceSignalDate: string
  baseStage: string
  baseCandidateCount: number
  residualItemCount: number
  evaluableItemCount: number
  unavailableItemCount: number
  decisionEffect: 'none'
  summary: string
}

export type PitResidualFunnelRecoveryResult = {
  throughDate: string
  attemptedDates: string[]
  recovered: PitResidualFunnelEnrichmentResult[]
  failures: Array<{ businessDate: string; error: string }>
  summary: string
}

function chunks<T>(rows: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size))
  return output
}

async function loadCanonicalScreenerRun(
  db: D1Database,
  businessDate: string,
): Promise<CanonicalScreenerRun> {
  const row = await db.prepare(`
    SELECT r.run_id, r.status, r.candidate_count, r.final_count
      FROM canonical_run_heads h
      JOIN screener_funnel_runs r ON r.run_id=h.run_id AND r.date=?
     WHERE h.logical_run_key='screener:' || ? || ':TW:production:market_screener'
       AND r.status='success'
     LIMIT 1
  `).bind(businessDate, businessDate).first<CanonicalScreenerRun>()
  if (!row?.run_id) throw new Error(`pit_residual_canonical_screener_run_missing:${businessDate}`)
  return row
}

async function loadBaseCandidates(
  db: D1Database,
  runId: string,
): Promise<{ stage: string; rows: BaseCandidate[] }> {
  for (const stage of [BASE_STAGE, LEGACY_BASE_STAGE]) {
    const { results } = await db.prepare(`
      SELECT symbol, name, score_after, rank
        FROM screener_funnel_items
       WHERE run_id=? AND stage=? AND decision='observe'
         AND score_after IS NOT NULL
       ORDER BY id
    `).bind(runId, stage).all<BaseCandidate>()
    const rows = (results ?? []).filter((row) => {
      const score = Number(row.score_after)
      return Boolean(String(row.symbol ?? '').trim()) && Number.isFinite(score)
    })
    if (rows.length) return { stage, rows }
  }
  throw new Error(`pit_residual_funnel_base_receipt_missing:${runId}`)
}

async function persistReceipt(
  db: D1Database,
  input: {
    businessDate: string
    screenerRunId: string
    pipelineCanonicalRunId: string
    sourceSignalDate?: string | null
    baseStage?: string | null
    baseCandidateCount?: number
    residualItemCount?: number
    status: 'success' | 'error'
    error?: string | null
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO pit_residual_funnel_enrichment_runs_v1 (
      business_date, screener_run_id, pipeline_canonical_run_id,
      source_signal_date, base_stage, base_candidate_count,
      residual_item_count, decision_effect, status, last_error,
      completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(business_date, screener_run_id) DO UPDATE SET
      pipeline_canonical_run_id=excluded.pipeline_canonical_run_id,
      source_signal_date=excluded.source_signal_date,
      base_stage=excluded.base_stage,
      base_candidate_count=excluded.base_candidate_count,
      residual_item_count=excluded.residual_item_count,
      decision_effect='none', status=excluded.status,
      last_error=excluded.last_error,
      completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
  `).bind(
    input.businessDate,
    input.screenerRunId,
    input.pipelineCanonicalRunId,
    input.sourceSignalDate ?? null,
    input.baseStage ?? null,
    Math.max(0, Number(input.baseCandidateCount ?? 0)),
    Math.max(0, Number(input.residualItemCount ?? 0)),
    input.status,
    input.error?.slice(0, 1000) ?? null,
  ).run()
}

function assertEnrichmentInput(input: { businessDate: string; pipelineCanonicalRunId: string }): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new Error(`pit_residual_invalid_enrichment_date:${input.businessDate}`)
  }
  if (!input.pipelineCanonicalRunId.trim()) {
    throw new Error('pit_residual_pipeline_canonical_run_missing')
  }
}

export async function enrichCanonicalPitResidualFunnel(
  env: Bindings,
  input: { businessDate: string; pipelineCanonicalRunId: string },
): Promise<PitResidualFunnelEnrichmentResult> {
  assertEnrichmentInput(input)
  const opsDb = databaseForDataDomain(env, 'ops')
  const learningDb = databaseForDataDomain(env, 'learning')
  let screenerRunId = 'unresolved'
  let baseStage: string | null = null
  let baseCandidateCount = 0
  let sourceSignalDate: string | null = null
  try {
    const canonical = await loadCanonicalScreenerRun(opsDb, input.businessDate)
    screenerRunId = canonical.run_id
    const base = await loadBaseCandidates(opsDb, canonical.run_id)
    baseStage = base.stage
    baseCandidateCount = base.rows.length
    const candidates = base.rows.map((row) => ({
      symbol: String(row.symbol).trim(),
      score: Number(row.score_after),
    }))
    const snapshot = await loadPitResidualShadowSnapshot(
      learningDb,
      candidates.map((row) => row.symbol),
      input.businessDate,
    )
    sourceSignalDate = snapshot.signalDate
    if (snapshot.signalDate !== input.businessDate) {
      throw new Error(
        `pit_residual_same_day_snapshot_missing:${input.businessDate}:latest=${snapshot.signalDate ?? 'missing'}`,
      )
    }
    const counterfactuals = buildPitResidualCounterfactuals(candidates, snapshot)
    if (!counterfactuals.length) {
      throw new Error(
        `pit_residual_counterfactual_coverage_empty:${counterfactuals.length}/${candidates.length}`,
      )
    }
    const counterfactualBySymbol = new Map(counterfactuals.map((row) => [row.symbol, row]))
    const evaluableItemCount = counterfactuals.length
    const unavailableItemCount = candidates.length - evaluableItemCount
    const statements: D1PreparedStatement[] = [
      opsDb.prepare(`DELETE FROM screener_funnel_items WHERE run_id=? AND stage=?`)
        .bind(canonical.run_id, RESIDUAL_STAGE),
    ]
    for (const group of chunks(base.rows, INSERT_ROWS_PER_STATEMENT)) {
      const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
      const bindings: unknown[] = []
      for (const baseRow of group) {
        const symbol = String(baseRow.symbol).trim()
        const score = Number(baseRow.score_after)
        const row = counterfactualBySymbol.get(symbol)
        const rank = row?.productionRank
          ?? (Number.isFinite(Number(baseRow.rank)) ? Number(baseRow.rank) : null)
        const reasonCode = !row
          ? 'pit_residual_shadow_not_evaluable'
          : row.rankDelta > 0
            ? 'pit_residual_shadow_rank_up'
            : row.rankDelta < 0
              ? 'pit_residual_shadow_rank_down'
              : 'pit_residual_shadow_rank_unchanged'
        const evidence = row ? {
          applicationMode: PIT_RESIDUAL_SHADOW_APPLICATION_MODE,
          candidateSetMutationAllowed: PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED,
          debateVisibility: PIT_RESIDUAL_DEBATE_VISIBILITY,
          decisionEffect: 'none',
          evaluationStatus: 'evaluable',
          residualWeight: PIT_RESIDUAL_SHADOW_WEIGHT,
          primaryHorizonSessions: PIT_RESIDUAL_PRIMARY_HORIZON_SESSIONS,
          signalDate: row.signalDate,
          industry: row.industry,
          productionBasePercentile: row.productionBasePercentile,
          residualMomentumRank: row.residualMomentumRank,
          productionShadowScore: row.productionShadowScore,
          productionRank: row.productionRank,
          shadowRank: row.shadowRank,
          rankDelta: row.rankDelta,
          breadthRank: row.breadthRank,
          flowDiffusionRank: row.flowDiffusionRank,
          diagnosticConfirmationRank: row.diagnosticConfirmationRank,
          auxiliaryAuthority: 'diagnostic_only',
          researchBaseScore: row.researchBaseScore,
          researchShadowScore: row.researchShadowScore,
          factorContractVersion: row.factorContractVersion,
          taxonomySnapshotDate: row.taxonomySnapshotDate,
          taxonomyChecksum: row.taxonomyChecksum,
          enrichmentContractVersion: 'pit-residual-funnel-enrichment-v2',
          enrichmentBaseStage: base.stage,
          pipelineCanonicalRunId: input.pipelineCanonicalRunId,
        } : {
          applicationMode: PIT_RESIDUAL_SHADOW_APPLICATION_MODE,
          candidateSetMutationAllowed: PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED,
          debateVisibility: PIT_RESIDUAL_DEBATE_VISIBILITY,
          decisionEffect: 'none',
          evaluationStatus: 'not_evaluable',
          unavailableReason: 'pit_residual_factor_snapshot_missing_for_symbol',
          residualWeight: PIT_RESIDUAL_SHADOW_WEIGHT,
          primaryHorizonSessions: PIT_RESIDUAL_PRIMARY_HORIZON_SESSIONS,
          signalDate: snapshot.signalDate,
          auxiliaryAuthority: 'diagnostic_only',
          enrichmentContractVersion: 'pit-residual-funnel-enrichment-v2',
          enrichmentBaseStage: base.stage,
          pipelineCanonicalRunId: input.pipelineCanonicalRunId,
        }
        bindings.push(
          canonical.run_id,
          input.businessDate,
          symbol,
          baseRow.name ?? null,
          RESIDUAL_STAGE,
          'observe',
          reasonCode,
          score,
          score,
          rank,
          JSON.stringify(evidence),
        )
      }
      statements.push(opsDb.prepare(`
        INSERT INTO screener_funnel_items (
          run_id, date, symbol, name, stage, decision, reason_code,
          score_before, score_after, rank, evidence
        ) VALUES ${values}
      `).bind(...bindings))
    }
    await opsDb.batch(statements)
    const current = await loadCanonicalScreenerRun(opsDb, input.businessDate)
    if (current.run_id !== canonical.run_id) {
      throw new Error(`pit_residual_canonical_screener_run_changed:${canonical.run_id}:${current.run_id}`)
    }
    const persisted = await opsDb.prepare(`
      SELECT COUNT(*) AS row_count
        FROM screener_funnel_items
       WHERE run_id=? AND stage=?
    `).bind(canonical.run_id, RESIDUAL_STAGE).first<{ row_count: number | string }>()
    const residualItemCount = Math.max(0, Number(persisted?.row_count ?? 0))
    if (residualItemCount !== candidates.length) {
      throw new Error(`pit_residual_enrichment_persistence_incomplete:${residualItemCount}/${candidates.length}`)
    }
    await persistReceipt(opsDb, {
      businessDate: input.businessDate,
      screenerRunId: canonical.run_id,
      pipelineCanonicalRunId: input.pipelineCanonicalRunId,
      sourceSignalDate: snapshot.signalDate,
      baseStage: base.stage,
      baseCandidateCount: candidates.length,
      residualItemCount,
      status: 'success',
    })
    const summary = [
      `date=${input.businessDate}`,
      `screener_run=${canonical.run_id}`,
      `source_signal_date=${snapshot.signalDate}`,
      `base_stage=${base.stage}`,
      `base=${candidates.length}`,
      `residual_items=${residualItemCount}`,
      `evaluable=${evaluableItemCount}`,
      `unavailable=${unavailableItemCount}`,
      'decision_effect=none',
      `candidate_count_unchanged=${Number(canonical.candidate_count)}`,
      `final_count_unchanged=${Number(canonical.final_count)}`,
    ].join(' ')
    return {
      businessDate: input.businessDate,
      screenerRunId: canonical.run_id,
      pipelineCanonicalRunId: input.pipelineCanonicalRunId,
      sourceSignalDate: snapshot.signalDate,
      baseStage: base.stage,
      baseCandidateCount: candidates.length,
      residualItemCount,
      evaluableItemCount,
      unavailableItemCount,
      decisionEffect: 'none',
      summary,
    }
  } catch (error) {
    if (screenerRunId !== 'unresolved') {
      await persistReceipt(opsDb, {
        businessDate: input.businessDate,
        screenerRunId,
        pipelineCanonicalRunId: input.pipelineCanonicalRunId,
        sourceSignalDate,
        baseStage,
        baseCandidateCount,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    }
    throw error
  }
}

/**
 * Enriches a date once per canonical screener run. A success receipt for that run
 * settles it, so the snapshot callback, the 14:20 chain and a duplicate callback
 * never rewrite the same rows.
 */
export async function enrichPitResidualFunnelOnce(
  env: Bindings,
  input: { businessDate: string; pipelineCanonicalRunId: string },
): Promise<string> {
  assertEnrichmentInput(input)
  const opsDb = databaseForDataDomain(env, 'ops')
  const canonical = await loadCanonicalScreenerRun(opsDb, input.businessDate)
  const receipt = await opsDb.prepare(`
    SELECT status
      FROM pit_residual_funnel_enrichment_runs_v1
     WHERE business_date=? AND screener_run_id=?
     LIMIT 1
  `).bind(input.businessDate, canonical.run_id).first<{ status: string }>()
  if (receipt?.status === 'success') {
    return `pit_residual_funnel_already_enriched date=${input.businessDate} screener_run=${canonical.run_id} decision_effect=none`
  }
  return (await enrichCanonicalPitResidualFunnel(env, input)).summary
}

/**
 * Returns a waiting summary only while the same-day snapshot is still in flight:
 * the shadow is missing, this run's dataset-snapshot-export has not reported a
 * terminal callback, and the chain was queued within the snapshot window.
 * Anything else stays an error.
 */
export async function pitResidualSnapshotPendingSummary(
  env: Bindings,
  input: { businessDate: string; pipelineCanonicalRunId: string; error: unknown; nowMs?: number },
): Promise<string | null> {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const runId = input.pipelineCanonicalRunId.trim()
  if (!message.startsWith(SNAPSHOT_MISSING_PREFIX) || !runId) return null
  try {
    const [snapshot, enrichment] = await Promise.all([
      env.KV.get(`scheduler:run:dataset-snapshot-export:${input.businessDate}`, 'json'),
      env.KV.get(`scheduler:run:${ENRICHMENT_TASK}:${input.businessDate}`, 'json'),
    ]) as [SchedulerRunLogEntry | null, SchedulerRunLogEntry | null]
    if (
      snapshot
      && String(snapshot.run_id ?? '').startsWith(`${runId}:`)
      && !['triggered', 'running', 'waiting'].includes(snapshot.status)
    ) return null
    // A callback already settled this run; waiting would mask its result.
    if (enrichment?.run_id === runId && ['success', 'error'].includes(enrichment.status)) return null
    const stage = await databaseForDataDomain(env, 'ops').prepare(`
      SELECT queued_at
        FROM pipeline_stage_runs
       WHERE business_date=? AND stage='post_pipeline_chain' AND canonical_run_id=?
       LIMIT 1
    `).bind(input.businessDate, runId).first<{ queued_at: string | null }>()
    const queuedAt = Date.parse(`${String(stage?.queued_at ?? '').replace(' ', 'T')}Z`)
    const elapsedMs = (input.nowMs ?? Date.now()) - queuedAt
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > SNAPSHOT_PENDING_WINDOW_MS) return null
  } catch {
    return null
  }
  return [
    'status=waiting pit_residual_same_day_snapshot_pending',
    `date=${input.businessDate}`,
    `pipeline_run=${runId}`,
    'completion=dataset-snapshot-export_callback',
    `detail=${message}`,
  ].join(' ')
}

/** 14:20 post-pipeline step: the dataset-snapshot callback reruns it once the job finishes. */
export async function enrichPitResidualFunnelForChain(
  env: Bindings,
  input: { businessDate: string; pipelineCanonicalRunId: string },
): Promise<string> {
  try {
    return await enrichPitResidualFunnelOnce(env, input)
  } catch (error) {
    const pending = await pitResidualSnapshotPendingSummary(env, { ...input, error })
    if (pending) return pending
    throw error
  }
}

/**
 * Dataset-snapshot callback hand-off. The post-close job writes the same-day
 * shadow before it calls back, so the enrichment the chain parked runs here.
 * Best effort: the outcome is logged on the enrichment's own task and receipt,
 * and this never throws into the callback.
 */
export async function runPitResidualFunnelEnrichmentAfterSnapshot(
  env: Bindings,
  input: { businessDate: string },
): Promise<string> {
  const startedAt = Date.now()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    return `skipped: invalid snapshot business date ${input.businessDate}`
  }
  let runId = ''
  try {
    // Same eligibility as recovery: only a successful pipeline_execution owns the date.
    const authority = await databaseForDataDomain(env, 'ops').prepare(`
      SELECT canonical_run_id
        FROM pipeline_stage_runs
       WHERE business_date=? AND stage='pipeline_execution' AND status='success'
       LIMIT 1
    `).bind(input.businessDate).first<{ canonical_run_id: string | null }>()
    runId = String(authority?.canonical_run_id ?? '').trim()
    if (!runId) return `skipped: no successful pipeline_execution date=${input.businessDate}`
    const summary = await enrichPitResidualFunnelOnce(env, {
      businessDate: input.businessDate,
      pipelineCanonicalRunId: runId,
    })
    await logSchedulerResult(env.KV, ENRICHMENT_TASK, {
      status: 'success',
      summary: `${summary} trigger=dataset_snapshot_callback`,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: input.businessDate,
    }, env)
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (runId) {
      await logSchedulerResult(env.KV, ENRICHMENT_TASK, {
        status: 'error',
        summary: `${message} trigger=dataset_snapshot_callback`,
        duration_ms: Date.now() - startedAt,
        error: message,
        run_id: runId,
        run_date: input.businessDate,
      }, env).catch(() => {})
    }
    return `error: ${message}`
  }
}

/**
 * Repairs a bounded number of historical canonical funnel dates that already
 * have both an authoritative pipeline run and same-day Learning shadow data.
 * This never changes screener decisions, candidate_count, or final_count.
 */
export async function recoverMissingPitResidualFunnels(
  env: Bindings,
  input: { throughDate: string; excludeBusinessDate?: string | null; maxDates?: number },
): Promise<PitResidualFunnelRecoveryResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.throughDate)) {
    throw new Error(`pit_residual_invalid_recovery_date:${input.throughDate}`)
  }
  const excludeBusinessDate = input.excludeBusinessDate?.trim() || null
  if (excludeBusinessDate && !/^\d{4}-\d{2}-\d{2}$/.test(excludeBusinessDate)) {
    throw new Error(`pit_residual_invalid_recovery_exclusion:${excludeBusinessDate}`)
  }
  const parsedMaxDates = Number(input.maxDates ?? 1)
  const maxDates = Number.isFinite(parsedMaxDates)
    ? Math.max(1, Math.min(5, Math.floor(parsedMaxDates)))
    : 1
  const opsDb = databaseForDataDomain(env, 'ops')
  const learningDb = databaseForDataDomain(env, 'learning')
  const { results } = await opsDb.prepare(`
    WITH ranked AS (
      SELECT r.date AS business_date,
             authority.canonical_run_id AS pipeline_canonical_run_id,
             ROW_NUMBER() OVER (
               PARTITION BY r.date
               ORDER BY authority.updated_at DESC, authority.canonical_run_id DESC
             ) AS ordinal
        FROM screener_funnel_runs r
        JOIN canonical_run_heads h
          ON h.run_id=r.run_id
         AND h.logical_run_key='screener:' || r.date || ':TW:production:market_screener'
        JOIN pipeline_stage_runs authority
          ON authority.business_date=r.date
         AND authority.stage='pipeline_execution'
         AND authority.status='success'
       WHERE r.date <= ?
         AND (? IS NULL OR r.date <> ?)
         AND r.status='success'
         AND EXISTS (
           SELECT 1
             FROM screener_funnel_items base
            WHERE base.run_id=r.run_id
              AND base.stage IN (?, ?)
              AND base.decision='observe'
              AND base.score_after IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pit_residual_funnel_enrichment_runs_v1 receipt
            WHERE receipt.business_date=r.date
              AND receipt.screener_run_id=r.run_id
              AND receipt.status='success'
         )
    )
    SELECT business_date, pipeline_canonical_run_id
      FROM ranked
     WHERE ordinal=1
     ORDER BY business_date DESC
     LIMIT 20
  `).bind(
    input.throughDate,
    excludeBusinessDate,
    excludeBusinessDate,
    BASE_STAGE,
    LEGACY_BASE_STAGE,
  ).all<{ business_date: string; pipeline_canonical_run_id: string }>()

  const candidates = results ?? []
  if (!candidates.length) {
    return {
      throughDate: input.throughDate,
      attemptedDates: [],
      recovered: [],
      failures: [],
      summary: `pit_residual_funnel_recovery through=${input.throughDate} attempted=0 recovered=0 failed=0`,
    }
  }
  const placeholders = candidates.map(() => '?').join(',')
  const { results: availableRows } = await learningDb.prepare(`
    SELECT DISTINCT signal_date
      FROM pit_factor_shadow_daily_v1
     WHERE signal_date IN (${placeholders})
       AND decision_effect='none'
  `).bind(...candidates.map((row) => row.business_date)).all<{ signal_date: string }>()
  const availableDates = new Set((availableRows ?? []).map((row) => String(row.signal_date)))
  const repairable = candidates
    .filter((row) => availableDates.has(String(row.business_date)))
    .slice(0, maxDates)
  const recovered: PitResidualFunnelEnrichmentResult[] = []
  const failures: Array<{ businessDate: string; error: string }> = []
  for (const row of repairable) {
    try {
      recovered.push(await enrichCanonicalPitResidualFunnel(env, {
        businessDate: String(row.business_date),
        pipelineCanonicalRunId: String(row.pipeline_canonical_run_id),
      }))
    } catch (error) {
      failures.push({
        businessDate: String(row.business_date),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const attemptedDates = repairable.map((row) => String(row.business_date))
  return {
    throughDate: input.throughDate,
    attemptedDates,
    recovered,
    failures,
    summary: [
      `pit_residual_funnel_recovery through=${input.throughDate}`,
      `attempted=${attemptedDates.length}`,
      `recovered=${recovered.length}`,
      `failed=${failures.length}`,
      `dates=${attemptedDates.join(',') || 'none'}`,
    ].join(' '),
  }
}

// Scheduler run logs live seven days, so this window covers every entry that can still be waiting.
const STALE_WAIT_LOOKBACK_DAYS = 7

/**
 * Settles enrichment log entries the 14:20 step left waiting past the snapshot
 * window: success when a success receipt exists, otherwise the recovery error or
 * pit_residual_snapshot_never_completed. Reads are one KV get per calendar date
 * in the log TTL window plus primary-key lookups for stale dates only.
 */
export async function settleStalePitResidualWaits(
  env: Bindings,
  input: {
    throughDate: string
    excludeBusinessDate?: string | null
    recovery?: PitResidualFunnelRecoveryResult | null
    nowMs?: number
  },
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.throughDate)) return 'stale_waiting=skipped_invalid_date'
  const nowMs = input.nowMs ?? Date.now()
  const dates: string[] = []
  for (let offset = 0; offset <= STALE_WAIT_LOOKBACK_DAYS; offset += 1) {
    const day = new Date(Date.parse(`${input.throughDate}T00:00:00Z`) - offset * 86400_000)
      .toISOString().slice(0, 10)
    if (day !== input.excludeBusinessDate) dates.push(day)
  }
  const entries = await Promise.all(dates.map(async (day) => ({
    day,
    entry: await env.KV.get(`scheduler:run:${ENRICHMENT_TASK}:${day}`, 'json')
      .catch(() => null) as SchedulerRunLogEntry | null,
  })))
  const recovered = new Map((input.recovery?.recovered ?? []).map((row) => [row.businessDate, row]))
  const failures = new Map((input.recovery?.failures ?? []).map((row) => [row.businessDate, row.error]))
  const opsDb = databaseForDataDomain(env, 'ops')
  const learningDb = databaseForDataDomain(env, 'learning')
  const settled: string[] = []
  for (const { day, entry } of entries) {
    const runId = String(entry?.run_id ?? '').trim()
    if (!entry || !runId) continue
    const recoveredRow = recovered.get(day)
    const stale = entry.status === 'waiting'
      && nowMs - Date.parse(entry.timestamp) > SNAPSHOT_PENDING_WINDOW_MS
    // A date recovered here also replaces an older error from the same run.
    if (!stale && !(recoveredRow && entry.status !== 'success')) continue
    try {
      let status: 'success' | 'error'
      let summary: string
      if (recoveredRow) {
        status = 'success'
        summary = recoveredRow.summary
      } else if (failures.has(day)) {
        status = 'error'
        summary = failures.get(day)!
      } else {
        const receipt = await opsDb.prepare(`
          SELECT receipt.status
            FROM canonical_run_heads h
            JOIN pit_residual_funnel_enrichment_runs_v1 receipt
              ON receipt.business_date=? AND receipt.screener_run_id=h.run_id
           WHERE h.logical_run_key='screener:' || ? || ':TW:production:market_screener'
           LIMIT 1
        `).bind(day, day).first<{ status: string }>()
        if (receipt?.status === 'success') {
          status = 'success'
          summary = `pit_residual_funnel_already_enriched date=${day} decision_effect=none`
        } else {
          const shadow = await learningDb.prepare(`
            SELECT 1 AS present FROM pit_factor_shadow_daily_v1 WHERE signal_date=? LIMIT 1
          `).bind(day).first<{ present: number }>()
          status = 'error'
          summary = shadow
            ? `pit_residual_funnel_not_recovered:${day}`
            : `pit_residual_snapshot_never_completed:${day}`
        }
      }
      // No supersede: a concurrent callback success for the same run still wins.
      // No env: the per-date Discord alert must not stretch the recovery step past its timeout.
      await logSchedulerResult(env.KV, ENRICHMENT_TASK, {
        status,
        summary: `${summary} trigger=stale_wait_settlement`,
        duration_ms: 0,
        error: status === 'error' ? summary : undefined,
        run_id: runId,
        run_date: day,
      })
      settled.push(`${day}:${status}`)
    } catch (error) {
      console.warn(`[pitResidualFunnel] stale wait settlement failed date=${day}:`, error)
    }
  }
  return `stale_waiting_settled=${settled.join(',') || 'none'}`
}
