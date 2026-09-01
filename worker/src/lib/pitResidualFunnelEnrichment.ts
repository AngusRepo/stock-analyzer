import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
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
}

export type PitResidualFunnelEnrichmentResult = {
  businessDate: string
  screenerRunId: string
  pipelineCanonicalRunId: string
  sourceSignalDate: string
  baseStage: string
  baseCandidateCount: number
  residualItemCount: number
  decisionEffect: 'none'
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
      SELECT symbol, name, score_after
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

export async function enrichCanonicalPitResidualFunnel(
  env: Bindings,
  input: { businessDate: string; pipelineCanonicalRunId: string },
): Promise<PitResidualFunnelEnrichmentResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new Error(`pit_residual_invalid_enrichment_date:${input.businessDate}`)
  }
  if (!input.pipelineCanonicalRunId.trim()) {
    throw new Error('pit_residual_pipeline_canonical_run_missing')
  }
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
    if (counterfactuals.length !== candidates.length) {
      throw new Error(
        `pit_residual_counterfactual_coverage_incomplete:${counterfactuals.length}/${candidates.length}`,
      )
    }
    const nameBySymbol = new Map(base.rows.map((row) => [String(row.symbol).trim(), row.name ?? null]))
    const scoreBySymbol = new Map(candidates.map((row) => [row.symbol, row.score]))
    const statements: D1PreparedStatement[] = [
      opsDb.prepare(`DELETE FROM screener_funnel_items WHERE run_id=? AND stage=?`)
        .bind(canonical.run_id, RESIDUAL_STAGE),
    ]
    for (const group of chunks(counterfactuals, INSERT_ROWS_PER_STATEMENT)) {
      const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
      const bindings: unknown[] = []
      for (const row of group) {
        bindings.push(
          canonical.run_id,
          input.businessDate,
          row.symbol,
          nameBySymbol.get(row.symbol) ?? null,
          RESIDUAL_STAGE,
          'observe',
          row.rankDelta > 0
            ? 'pit_residual_shadow_rank_up'
            : row.rankDelta < 0
              ? 'pit_residual_shadow_rank_down'
              : 'pit_residual_shadow_rank_unchanged',
          scoreBySymbol.get(row.symbol) ?? null,
          scoreBySymbol.get(row.symbol) ?? null,
          row.productionRank,
          JSON.stringify({
            applicationMode: PIT_RESIDUAL_SHADOW_APPLICATION_MODE,
            candidateSetMutationAllowed: PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED,
            debateVisibility: PIT_RESIDUAL_DEBATE_VISIBILITY,
            decisionEffect: 'none',
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
            enrichmentContractVersion: 'pit-residual-funnel-enrichment-v1',
            enrichmentBaseStage: base.stage,
            pipelineCanonicalRunId: input.pipelineCanonicalRunId,
          }),
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
    if (residualItemCount !== counterfactuals.length) {
      throw new Error(`pit_residual_enrichment_persistence_incomplete:${residualItemCount}/${counterfactuals.length}`)
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
