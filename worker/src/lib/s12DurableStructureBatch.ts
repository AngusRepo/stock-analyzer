import type { Bindings } from '../types'
import {
  assessS12IntradayStructureFromBaseBars,
  s12TimingPolicyFromEnv,
  type S12IntradayAssessment,
} from './s12IntradayStructure'
import {
  fetchS12ResearchKbarsBatch,
  loadS12HistoricalReplayBars,
} from './s12RuntimeBars'
import {
  loadS12PipelineSeedSymbolsByDate,
  type S12PipelineSeedSymbol,
} from './s12CandidateStructureSnapshots'
import {
  applyS12TwCalibrationArtifact,
  listApprovedS12TwCalibrationArtifacts,
  resolveS12TwCalibrationArtifact,
  type S12TwCalibrationArtifact,
} from './s12TwEquityCalibration'
import { buildS12SnapshotEntryContext } from './s12StructureSnapshots'
import { classifyS12Structure, type S12StructureClass } from './s12StructureTaxonomy'
import { acquireS12ResearchLease, releaseS12ResearchLease } from './s12ResearchLease'
import { writeEvidenceArtifact } from './artifactLifecycle'

const M15_MS = 15 * 60_000
const DEFAULT_SHARD_SIZE = 48
const DEFAULT_CONCURRENCY = 12

export type S12DurableRunSource = 'evening_chain' | 'historical_shadow' | 'manual_repair'

export interface S12DurableStructureBatchSummary {
  schema_version: 's12-durable-structure-batch-summary-v1'
  run_id: string
  trade_date: string
  source: S12DurableRunSource
  candidate_count: number
  attempted: number
  persisted: number
  execution_ready: number
  setup_waiting: number
  risk_blocked: number
  invalidated: number
  unavailable: number
  errors: number
  shard_count: number
  completed_shards: number
  coverage_passed: boolean
  duration_ms: number
  artifact_id?: string
  artifact_checksum?: string
}

type ComputedSnapshot = {
  row: S12PipelineSeedSymbol
  assessment?: S12IntradayAssessment
  unavailableReason?: string
  unavailableMetadata?: Record<string, unknown>
  structureClass: S12StructureClass
}

function lastBarEndMs(bars: Array<{ startMs: number }>): number {
  const last = bars.length ? bars[bars.length - 1] : null
  return Number.isFinite(last?.startMs) ? Number(last?.startMs) + M15_MS : Date.now()
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function assessmentStatement(
  db: D1Database,
  tradeDate: string,
  runId: string,
  source: string,
  row: S12PipelineSeedSymbol,
  assessment: S12IntradayAssessment,
  calibration: S12TwCalibrationArtifact | null,
): D1PreparedStatement {
  const structureStop = positiveNumber(assessment.exitPlan?.trailingStop?.initial)
    ?? positiveNumber(assessment.execution?.stopLoss)
  const entryContext = buildS12SnapshotEntryContext(assessment)
  return db.prepare(`
    INSERT INTO s12_structure_snapshots (
      trade_date, symbol, source, side, state, ready, invalidated, setup_id,
      entry_price, chase_ceiling, structure_stop,
      target1_price, target2_price, target3_price, target4_price,
      demand_zone_low, demand_zone_high, supply_zone_low, supply_zone_high,
      detail, entry_context_json, exit_plan_json, raw_json, pending_run_id, updated_at
    )
    VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(trade_date, symbol, source) DO UPDATE SET
      side=excluded.side,
      state=excluded.state,
      ready=excluded.ready,
      invalidated=excluded.invalidated,
      setup_id=excluded.setup_id,
      entry_price=excluded.entry_price,
      chase_ceiling=excluded.chase_ceiling,
      structure_stop=excluded.structure_stop,
      target1_price=excluded.target1_price,
      target2_price=excluded.target2_price,
      target3_price=excluded.target3_price,
      target4_price=excluded.target4_price,
      demand_zone_low=excluded.demand_zone_low,
      demand_zone_high=excluded.demand_zone_high,
      supply_zone_low=excluded.supply_zone_low,
      supply_zone_high=excluded.supply_zone_high,
      detail=excluded.detail,
      entry_context_json=excluded.entry_context_json,
      exit_plan_json=excluded.exit_plan_json,
      raw_json=excluded.raw_json,
      pending_run_id=excluded.pending_run_id,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    tradeDate,
    row.symbol,
    source,
    assessment.state,
    assessment.ready ? 1 : 0,
    assessment.invalidated ? 1 : 0,
    assessment.setupId ?? null,
    positiveNumber(assessment.execution?.entryPrice),
    positiveNumber(assessment.execution?.chaseCeiling),
    structureStop,
    positiveNumber(assessment.exitPlan?.tp1?.price) ?? positiveNumber(assessment.execution?.target1),
    positiveNumber(assessment.exitPlan?.mainExit?.price) ?? positiveNumber(assessment.execution?.target2),
    positiveNumber(assessment.exitPlan?.tp3?.price) ?? positiveNumber(assessment.execution?.target3),
    positiveNumber(assessment.exitPlan?.tp4?.price) ?? positiveNumber(assessment.execution?.target4),
    positiveNumber(assessment.demandZone1h?.low),
    positiveNumber(assessment.demandZone1h?.high),
    positiveNumber(assessment.supplyZone1h?.low),
    positiveNumber(assessment.supplyZone1h?.high),
    assessment.detail ?? null,
    JSON.stringify(entryContext),
    JSON.stringify(assessment.exitPlan ?? null),
    JSON.stringify({
      ...assessment,
      runtimeMetadata: {
        durable_batch_run_id: runId,
        calibration_artifact_id: calibration?.artifactId ?? null,
        calibration_scope: calibration?.scope ?? null,
      },
    }),
    runId,
  )
}

function unavailableStatement(
  db: D1Database,
  tradeDate: string,
  runId: string,
  source: string,
  row: S12PipelineSeedSymbol,
  reason: string,
  metadata: Record<string, unknown> | undefined,
): D1PreparedStatement {
  const normalizedReason = String(reason || 'missing_intraday_bars').slice(0, 300)
  return db.prepare(`
    INSERT INTO s12_structure_snapshots (
      trade_date, symbol, source, side, state, ready, invalidated,
      detail, entry_context_json, raw_json, pending_run_id, updated_at
    )
    VALUES (?, ?, ?, 'buy', 'data_unavailable', 0, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(trade_date, symbol, source) DO UPDATE SET
      state='data_unavailable',
      ready=0,
      invalidated=0,
      detail=excluded.detail,
      entry_context_json=excluded.entry_context_json,
      raw_json=excluded.raw_json,
      pending_run_id=excluded.pending_run_id,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    tradeDate,
    row.symbol,
    source,
    `data_available=false;unavailable_reason=${normalizedReason}`,
    JSON.stringify({
      schema_version: 's12-equity-mutation-context-v1',
      source: 's12_structure_snapshots',
      state: 'data_unavailable',
      ready: false,
      data_available: false,
      unavailable_reason: normalizedReason,
    }),
    JSON.stringify({
      schema_version: 's12-structure-unavailable-v1',
      state: 'data_unavailable',
      ready: false,
      invalidated: false,
      reason: normalizedReason,
      runtimeMetadata: metadata ?? null,
    }),
    runId,
  )
}

async function marketBySymbol(
  db: D1Database,
  candidates: S12PipelineSeedSymbol[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let offset = 0; offset < candidates.length; offset += 80) {
    const symbols = candidates.slice(offset, offset + 80).map((row) => row.symbol)
    if (!symbols.length) continue
    const placeholders = symbols.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT symbol, market FROM stocks WHERE symbol IN (${placeholders})`,
    ).bind(...symbols).all<{ symbol?: string | null; market?: string | null }>()
    for (const stock of results ?? []) {
      const symbol = String(stock.symbol ?? '').trim()
      if (symbol) out.set(symbol, String(stock.market ?? 'UNKNOWN'))
    }
  }
  return out
}

function countClasses(rows: ComputedSnapshot[]): Record<S12StructureClass, number> {
  const counts: Record<S12StructureClass, number> = {
    execution_ready: 0,
    setup_waiting: 0,
    risk_blocked: 0,
    invalidated: 0,
    unavailable: 0,
  }
  for (const row of rows) counts[row.structureClass] += 1
  return counts
}

async function persistStatements(db: D1Database, statements: D1PreparedStatement[]): Promise<number> {
  let persisted = 0
  for (let offset = 0; offset < statements.length; offset += 64) {
    const chunk = statements.slice(offset, offset + 64)
    const results = await db.batch(chunk)
    if (results.length !== chunk.length || results.some((result) => result.success === false || result.error)) {
      throw new Error(`s12_structure_batch_partial_write:${results.length}/${chunk.length}`)
    }
    persisted += results.length
  }
  return persisted
}

export async function runS12DurableStructureBatch(
  env: Bindings,
  tradeDate: string,
  options: {
    runId: string
    source: S12DurableRunSource
    shardSize?: number
    concurrency?: number
    candidates?: S12PipelineSeedSymbol[]
  },
): Promise<S12DurableStructureBatchSummary> {
  const startedAt = Date.now()
  const runId = String(options.runId || '').trim()
  if (!runId) throw new Error('s12_structure_batch_run_id_missing')
  const leaseAcquired = await acquireS12ResearchLease(env.DB, runId, tradeDate, 3600)
  if (!leaseAcquired) throw new Error(`s12_research_lease_busy:${tradeDate}`)
  const snapshotSource = options.source === 'historical_shadow'
    ? 's12_candidate_snapshot_reconstruction'
    : 's12_candidate_snapshot'
  const shardSize = Math.max(8, Math.min(64, Math.floor(options.shardSize ?? DEFAULT_SHARD_SIZE)))
  const concurrency = Math.max(1, Math.min(24, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)))
  try {
    const candidates = options.candidates
      ?? await loadS12PipelineSeedSymbolsByDate(env.DB, tradeDate, 2000)
    if (!candidates.length) throw new Error(`s12_structure_batch_reference_empty:${tradeDate}`)
    const shards = Array.from(
      { length: Math.ceil(candidates.length / shardSize) },
      (_, index) => candidates.slice(index * shardSize, (index + 1) * shardSize),
    )
    await env.DB.prepare(`
      INSERT INTO s12_structure_batch_runs (
        run_id, trade_date, source, status, candidate_count, shard_count,
        started_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(run_id) DO UPDATE SET
        status='running',
        candidate_count=excluded.candidate_count,
        shard_count=excluded.shard_count,
        last_error=NULL,
        completed_at=NULL,
        updated_at=CURRENT_TIMESTAMP
    `).bind(runId, tradeDate, options.source, candidates.length, shards.length).run()
    await persistStatements(env.DB, shards.map((shard, index) => env.DB.prepare(`
      INSERT INTO s12_structure_batch_shards (
        run_id, shard_index, first_symbol, last_symbol, symbol_count, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
      ON CONFLICT(run_id, shard_index) DO UPDATE SET
        first_symbol=excluded.first_symbol,
        last_symbol=excluded.last_symbol,
        symbol_count=excluded.symbol_count,
        status=CASE WHEN s12_structure_batch_shards.status='success' THEN 'success' ELSE 'pending' END,
        updated_at=CURRENT_TIMESTAMP
    `).bind(runId, index, shard[0]?.symbol ?? null, shard[shard.length - 1]?.symbol ?? null, shard.length)))

    const markets = await marketBySymbol(env.DB, candidates)
    const calibrationArtifacts = await listApprovedS12TwCalibrationArtifacts(
      env.DB, { includeSuperseded: true },
    ).catch(() => [])
    const basePolicy = s12TimingPolicyFromEnv(env as any)
    const allComputed: ComputedSnapshot[] = []
    let persisted = 0
    let completedShards = 0

    for (let shardIndex = 0; shardIndex < shards.length; shardIndex += 1) {
      const shard = shards[shardIndex]
      const existing = await env.DB.prepare(`
        SELECT status FROM s12_structure_batch_shards
         WHERE run_id=? AND shard_index=?
      `).bind(runId, shardIndex).first<{ status?: string }>()
      if (existing?.status === 'success') {
        completedShards += 1
        continue
      }
      await env.DB.prepare(`
        UPDATE s12_structure_batch_shards
           SET status='running', attempt=attempt+1, started_at=CURRENT_TIMESTAMP,
               last_error=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE run_id=? AND shard_index=?
      `).bind(runId, shardIndex).run()
      try {
        const barsBySymbol = await fetchS12ResearchKbarsBatch(
          env, shard.map((row) => row.symbol), tradeDate, 600_000,
        )
        const computed = new Array<ComputedSnapshot>(shard.length)
        let nextIndex = 0
        const worker = async () => {
          while (nextIndex < shard.length) {
            const index = nextIndex++
            const row = shard[index]
            const override = barsBySymbol.get(row.symbol)
            const loaded = await loadS12HistoricalReplayBars(env, row.symbol, tradeDate, {
              researchTimeoutMs: 600_000,
              researchBarsOverride: override,
            })
            if (!loaded.bars.length) {
              computed[index] = {
                row,
                structureClass: 'unavailable',
                unavailableReason: loaded.diagnostics.kbars_error
                  ?? loaded.diagnostics.kbars_unusable_reason
                  ?? 'missing_intraday_bars',
                unavailableMetadata: { diagnostics: loaded.diagnostics, durable_batch_run_id: runId },
              }
              continue
            }
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
              entryCohort: preliminary.state === 'limited_takeover_ready'
                ? 'limited_takeover_ready'
                : 'reaction_ready',
              marketSegment: markets.get(row.symbol) ?? 'UNKNOWN',
              asOfDate: tradeDate,
            })
            const assessment = calibration ? assess(calibration) : preliminary
            computed[index] = { row, assessment, structureClass: classifyS12Structure(assessment) }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, shard.length) }, () => worker()))
        const statements = computed.map((item) => item.assessment
          ? assessmentStatement(
            env.DB, tradeDate, runId, snapshotSource, item.row, item.assessment,
            resolveS12TwCalibrationArtifact(calibrationArtifacts, {
              entryCohort: item.assessment.state === 'limited_takeover_ready'
                ? 'limited_takeover_ready'
                : 'reaction_ready',
              marketSegment: markets.get(item.row.symbol) ?? 'UNKNOWN',
              asOfDate: tradeDate,
            }),
          )
          : unavailableStatement(
            env.DB, tradeDate, runId, snapshotSource, item.row,
            item.unavailableReason ?? 'missing_intraday_bars', item.unavailableMetadata,
          ))
        const shardPersisted = await persistStatements(env.DB, statements)
        const counts = countClasses(computed)
        await env.DB.prepare(`
          UPDATE s12_structure_batch_shards
             SET status='success', attempted_count=?, persisted_count=?,
                 ready_count=?, setup_waiting_count=?, risk_blocked_count=?,
                 invalidated_count=?, unavailable_count=?, completed_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP
           WHERE run_id=? AND shard_index=?
        `).bind(
          computed.length,
          shardPersisted,
          counts.execution_ready,
          counts.setup_waiting,
          counts.risk_blocked,
          counts.invalidated,
          counts.unavailable,
          runId,
          shardIndex,
        ).run()
        allComputed.push(...computed)
        persisted += shardPersisted
        completedShards += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await env.DB.prepare(`
          UPDATE s12_structure_batch_shards
             SET status='error', last_error=?, completed_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP
           WHERE run_id=? AND shard_index=?
        `).bind(message.slice(0, 500), runId, shardIndex).run()
        throw error
      }
    }

    const coverage = await env.DB.prepare(`
      SELECT COUNT(*) reference_rows,
             SUM(CASE WHEN s.symbol IS NOT NULL THEN 1 ELSE 0 END) persisted_rows
        FROM selection_reference_snapshots_v1 r
        LEFT JOIN s12_structure_snapshots s
          ON s.trade_date=r.signal_date AND s.symbol=r.symbol
         AND s.source=? AND s.pending_run_id=?
       WHERE r.signal_date=?
         AND EXISTS (
           SELECT 1 FROM canonical_run_heads h
            WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
              AND h.run_id=r.producer_run_id
         )
    `).bind(snapshotSource, runId, tradeDate).first<{ reference_rows?: number; persisted_rows?: number }>()
    const referenceRows = Number(coverage?.reference_rows ?? 0)
    const persistedRows = Number(coverage?.persisted_rows ?? 0)
    const shardTotals = await env.DB.prepare(`
      SELECT COALESCE(SUM(attempted_count), 0) attempted_count,
             COALESCE(SUM(persisted_count), 0) persisted_count,
             COALESCE(SUM(ready_count), 0) ready_count,
             COALESCE(SUM(setup_waiting_count), 0) setup_waiting_count,
             COALESCE(SUM(risk_blocked_count), 0) risk_blocked_count,
             COALESCE(SUM(invalidated_count), 0) invalidated_count,
             COALESCE(SUM(unavailable_count), 0) unavailable_count,
             SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) completed_shards,
             SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) error_shards
        FROM s12_structure_batch_shards
       WHERE run_id=?
    `).bind(runId).first<Record<string, number>>()
    const counts: Record<S12StructureClass, number> = {
      execution_ready: Number(shardTotals?.ready_count ?? 0),
      setup_waiting: Number(shardTotals?.setup_waiting_count ?? 0),
      risk_blocked: Number(shardTotals?.risk_blocked_count ?? 0),
      invalidated: Number(shardTotals?.invalidated_count ?? 0),
      unavailable: Number(shardTotals?.unavailable_count ?? 0),
    }
    const aggregateAttempted = Number(shardTotals?.attempted_count ?? 0)
    const aggregatePersisted = Number(shardTotals?.persisted_count ?? 0)
    completedShards = Number(shardTotals?.completed_shards ?? 0)
    const errorShards = Number(shardTotals?.error_shards ?? 0)
    const coveragePassed = referenceRows > 0
      && persistedRows === referenceRows
      && aggregateAttempted === referenceRows
      && aggregatePersisted === referenceRows
      && completedShards === shards.length
      && errorShards === 0
    if (!coveragePassed) {
      throw new Error(`s12_structure_batch_coverage_failed:${persistedRows}/${referenceRows}`)
    }
    const summary: S12DurableStructureBatchSummary = {
      schema_version: 's12-durable-structure-batch-summary-v1',
      run_id: runId,
      trade_date: tradeDate,
      source: options.source,
      candidate_count: candidates.length,
      attempted: aggregateAttempted,
      persisted: aggregatePersisted,
      execution_ready: counts.execution_ready,
      setup_waiting: counts.setup_waiting,
      risk_blocked: counts.risk_blocked,
      invalidated: counts.invalidated,
      unavailable: counts.unavailable,
      errors: 0,
      shard_count: shards.length,
      completed_shards: completedShards,
      coverage_passed: coveragePassed,
      duration_ms: Date.now() - startedAt,
    }
    const manifest = await writeEvidenceArtifact(env, {
      domain: 's12_structure_batch',
      businessDate: tradeDate,
      producerRunId: runId,
      canonicalRunId: options.source === 'evening_chain' ? runId : null,
      retentionClass: options.source === 'evening_chain'
        ? 'canonical_model_evidence'
        : 'paper_shadow',
      schemaVersion: 's12-structure-batch-summary-v1',
      payload: { ...summary },
      rowCount: candidates.length,
      metadata: { source: options.source, snapshot_source: snapshotSource },
    })
    summary.artifact_id = manifest.artifact_id
    summary.artifact_checksum = manifest.checksum
    await env.DB.prepare(`
      UPDATE s12_structure_batch_runs
         SET status='success', attempted_count=?, persisted_count=?, ready_count=?,
             setup_waiting_count=?, risk_blocked_count=?, invalidated_count=?,
             unavailable_count=?, completed_shards=?, artifact_id=?, artifact_checksum=?,
             completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(
      summary.attempted,
      summary.persisted,
      summary.execution_ready,
      summary.setup_waiting,
      summary.risk_blocked,
      summary.invalidated,
      summary.unavailable,
      completedShards,
      manifest.artifact_id,
      manifest.checksum,
      runId,
    ).run()
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await env.DB.prepare(`
      UPDATE s12_structure_batch_runs
         SET status='error', last_error=?, completed_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(message.slice(0, 500), runId).run().catch(() => null)
    throw error
  } finally {
    await releaseS12ResearchLease(env.DB, runId)
  }
}
