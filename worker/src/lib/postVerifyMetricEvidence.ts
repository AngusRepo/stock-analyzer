import type { Bindings } from '../types'
import { databaseForDataDomain, shadowDatabaseForDataDomain } from './dataDomainRegistry'
import { readMetricSnapshot, type MetricSnapshotResult } from './strategyMetricSnapshots'
import { STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION, strategyMetricPublicationScope } from './strategyEvidenceMetrics'
import {
  STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION, STRATEGY_EVIDENCE_OWNER_CHALLENGER_VERSION,
  type StrategyEvidenceOwnerCalibrationResult,
} from './strategyEvidenceOwnerCalibration'

type Task = 'strategy-evidence-current' | 'strategy-evidence-metric-backfill'
type Backfill = { processedDates: string[]; materializedRows: number; readyRows: number; summary: string }
type MetricPointer = { date: string; scope: string; snapshotRunId: string; payloadChecksum: string; witness: string }
type CalibrationPointer = { runId: string; status: string; artifactChecksum: string; witness: string }
export type PostVerifyMetricEvidence = {
  schema: 'post-verify-metric-evidence-v1'; task: Task; businessDate: string; canonicalRunId: string
  snapshots: MetricPointer[]; calibration: CalibrationPointer | null; checksum: string
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

function validDate(value: string): boolean {
  const time = typeof value === 'string' ? Date.parse(value + 'T00:00:00Z') : Number.NaN
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

function metricWitness(result: MetricSnapshotResult) {
  return { profiles: result.profiles, observations: result.observations, metric_rows: result.metric_rows,
    ready_rows: result.ready_rows, source: result.source, snapshot_run_id: result.snapshot_run_id,
    payload_checksum: result.payload_checksum }
}

async function readSnapshot(env: Bindings, date: string, scope: string) {
  // Match the metric publisher, not calibration's independent authority DB.
  const db = shadowDatabaseForDataDomain(env, 'learning') ?? databaseForDataDomain(env, 'learning')
  const result = await readMetricSnapshot(db, date, STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION, 'authority_bridge', scope)
  if (!result) throw new Error('post_verify_metric_snapshot_missing')
  const pointer: MetricPointer = { date, scope, snapshotRunId: result.snapshot_run_id,
    payloadChecksum: result.payload_checksum, witness: await digest(metricWitness(result)) }
  return { result, pointer }
}

async function readCalibration(env: Bindings, businessDate: string, runId: string) {
  const db = databaseForDataDomain(env, 'learning')
  const run = await db.prepare(`SELECT run_id,artifact_version,knowledge_cutoff_date,status,
      source_snapshot_checksum,gate_json,artifact_checksum
    FROM strategy_evidence_owner_calibration_runs_v1 WHERE run_id=?`).bind(runId).first<{
      run_id: string; artifact_version: string; knowledge_cutoff_date: string; status: string
      source_snapshot_checksum: string; gate_json: string; artifact_checksum: string
    }>()
  if (!run || run.artifact_version !== STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION
      || run.knowledge_cutoff_date !== businessDate
      || !['pending_maturity', 'rejected', 'approved', 'promoted'].includes(run.status)) {
    throw new Error('post_verify_calibration_run_missing_or_changed')
  }
  const stored = await db.prepare(`SELECT strategy_id,strategy_version,metric_outcome_as_of_date,
      multi_horizon_score,weight_multiplier,source_metric_checksum,payload_checksum
    FROM strategy_evidence_owner_calibration_artifacts_v1 WHERE run_id=? ORDER BY strategy_id,strategy_version`)
    .bind(runId).all<StrategyEvidenceOwnerCalibrationResult['artifacts'][number]>()
  if (stored?.success === false || !Array.isArray(stored?.results)) {
    throw new Error('post_verify_owner_read_failed:calibration_artifacts')
  }
  const artifacts = stored.results.map(row => ({
    strategy_id: row.strategy_id, strategy_version: row.strategy_version,
    metric_outcome_as_of_date: row.metric_outcome_as_of_date,
    multi_horizon_score: row.multi_horizon_score == null ? null : Number(row.multi_horizon_score),
    weight_multiplier: Number(row.weight_multiplier), source_metric_checksum: row.source_metric_checksum,
    payload_checksum: row.payload_checksum,
  })).sort((a, b) => `${a.strategy_id}|${a.strategy_version}`.localeCompare(`${b.strategy_id}|${b.strategy_version}`))
  for (const row of artifacts) {
    const { payload_checksum: checksum, ...body } = row
    if (await digest(body) !== checksum || row.source_metric_checksum !== run.source_snapshot_checksum
        || (row.multi_horizon_score != null && !Number.isFinite(row.multi_horizon_score))
        || !Number.isFinite(row.weight_multiplier)) throw new Error('post_verify_calibration_artifact_changed')
  }
  const gate = JSON.parse(run.gate_json) as { history_checksum?: string }
  if (!gate.history_checksum || await digest({ version: STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION,
      challenger: STRATEGY_EVIDENCE_OWNER_CHALLENGER_VERSION,
      source_snapshot_checksum: run.source_snapshot_checksum, history_checksum: gate.history_checksum, artifacts }) !== run.artifact_checksum) {
    throw new Error('post_verify_calibration_checksum_changed')
  }
  const pointer: CalibrationPointer = { runId, status: run.status, artifactChecksum: run.artifact_checksum,
    witness: await digest({ run, artifacts }) }
  return { run, artifacts, historyChecksum: gate.history_checksum, pointer }
}

export async function capturePostVerifyMetricEvidence(env: Bindings, input: {
  task: Task; businessDate: string; canonicalRunId: string
  metrics?: MetricSnapshotResult | Backfill
  calibration?: { runId: string; result: StrategyEvidenceOwnerCalibrationResult }
}): Promise<PostVerifyMetricEvidence> {
  if (!validDate(input.businessDate) || !input.canonicalRunId.trim()) throw new Error('post_verify_metric_evidence_identity_missing')
  const snapshots: MetricPointer[] = []
  let calibration: CalibrationPointer | null = null
  if (input.task === 'strategy-evidence-current') {
    if (!input.metrics || !('snapshot_run_id' in input.metrics) || !input.calibration) {
      throw new Error('post_verify_metric_evidence_producer_result_missing')
    }
    const scope = strategyMetricPublicationScope(`canonical:${input.canonicalRunId}`)
    const fresh = await readSnapshot(env, input.businessDate, scope)
    if (await digest(metricWitness(fresh.result)) !== await digest(metricWitness(input.metrics))) {
      throw new Error('post_verify_metric_producer_readback_mismatch')
    }
    snapshots.push(fresh.pointer)
    const current = await readCalibration(env, input.businessDate, input.calibration.runId)
    const expected = input.calibration.result
    if (current.run.status !== expected.status || current.run.artifact_checksum !== expected.artifactChecksum
        || current.run.source_snapshot_checksum !== expected.sourceSnapshotChecksum
        || current.historyChecksum !== expected.historyChecksum || await digest(current.artifacts) !== await digest(expected.artifacts)) {
      throw new Error('post_verify_calibration_producer_readback_mismatch')
    }
    calibration = current.pointer
  } else if (input.task === 'strategy-evidence-metric-backfill') {
    if (!input.metrics || !('processedDates' in input.metrics) || input.calibration
        || input.metrics.processedDates.length > 8 || new Set(input.metrics.processedDates).size !== input.metrics.processedDates.length) {
      throw new Error('post_verify_metric_backfill_result_invalid')
    }
    let rows = 0, ready = 0
    for (const date of input.metrics.processedDates) {
      if (!validDate(date) || date >= input.businessDate) throw new Error('post_verify_metric_backfill_date_invalid')
      const fresh = await readSnapshot(env, date, strategyMetricPublicationScope(`daily:${date}`))
      snapshots.push(fresh.pointer)
      rows += fresh.result.metric_rows
      ready += fresh.result.ready_rows
    }
    if (rows !== input.metrics.materializedRows || ready !== input.metrics.readyRows) {
      throw new Error('post_verify_metric_backfill_readback_mismatch')
    }
  } else {
    throw new Error('post_verify_metric_evidence_task_invalid')
  }
  const body = { schema: 'post-verify-metric-evidence-v1' as const, task: input.task,
    businessDate: input.businessDate, canonicalRunId: input.canonicalRunId, snapshots, calibration }
  return { ...body, checksum: await digest(body) }
}

export async function verifyPostVerifyMetricEvidence(env: Bindings, evidence: PostVerifyMetricEvidence): Promise<boolean> {
  try {
    if (!evidence || typeof evidence !== 'object') return false
    const { checksum, ...body } = evidence
    if (evidence.schema !== 'post-verify-metric-evidence-v1' || !validDate(evidence.businessDate)
        || typeof evidence.canonicalRunId !== 'string' || !evidence.canonicalRunId.trim()
        || await digest(body) !== checksum || !Array.isArray(evidence.snapshots)) return false
    if (evidence.task === 'strategy-evidence-current') {
      if (evidence.snapshots.length !== 1 || !evidence.calibration) return false
    } else if (evidence.task === 'strategy-evidence-metric-backfill') {
      if (evidence.snapshots.length > 8 || evidence.calibration
          || new Set(evidence.snapshots.map(row => row.date)).size !== evidence.snapshots.length) return false
    } else return false
    for (const pointer of evidence.snapshots) {
      const current = evidence.task === 'strategy-evidence-current'
      const expectedScope = strategyMetricPublicationScope(current ? `canonical:${evidence.canonicalRunId}` : `daily:${pointer.date}`)
      if (!validDate(pointer.date) || pointer.scope !== expectedScope
          || (current ? pointer.date !== evidence.businessDate : pointer.date >= evidence.businessDate)) return false
      if (JSON.stringify((await readSnapshot(env, pointer.date, pointer.scope)).pointer) !== JSON.stringify(pointer)) return false
    }
    if (evidence.calibration && (typeof evidence.calibration.runId !== 'string' || !evidence.calibration.runId)) return false
    if (evidence.calibration && JSON.stringify((await readCalibration(env, evidence.businessDate, evidence.calibration.runId)).pointer)
        !== JSON.stringify(evidence.calibration)) return false
    return true
  } catch (error) {
    if (error instanceof Error && (/^post_verify_(?:metric_|calibration_)/.test(error.message)
        || /^strategy_metric_snapshot_integrity_failure:/.test(error.message))) return false
    // An unavailable read is not proof that a completed artifact changed.
    // Propagate transport/schema failures so the checkpoint preserves its
    // receipt and cannot silently continue an unverified optional task.
    throw error
  }
}
