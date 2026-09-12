import type { StrategyEvidenceMetricRow } from './strategyEvidenceMetrics'

export type MetricSnapshotResult = {
  profiles: number
  observations: number
  metric_rows: number
  ready_rows: number
  source: string
  snapshot_run_id: string
  payload_checksum: string
  summary: string
}

type SnapshotReceipt = {
  snapshot_run_id: string
  status: string
  profile_count: number
  observation_count: number
  metric_row_count: number
  ready_row_count: number
  payload_checksum: string
  materialization_source: string
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function metricPayloadChecksum(rows: StrategyEvidenceMetricRow[]): Promise<string> {
  return sha256(JSON.stringify(rows))
}

export async function readMetricSnapshot(
  db: D1Database, date: string, definition: string, mode: string, scope: string,
): Promise<MetricSnapshotResult | null> {
  const receipt = await db.prepare(`
    SELECT snapshot_run_id, status, profile_count, observation_count, metric_row_count,
           ready_row_count, payload_checksum, materialization_source
      FROM strategy_evidence_metric_snapshot_runs_v2
     WHERE outcome_as_of_date=? AND definition_version=? AND source_mode=? AND publication_scope=?
  `).bind(date, definition, mode, scope).first<SnapshotReceipt>()
  if (!receipt) return null
  const stored = await db.prepare(`
    SELECT row_json FROM strategy_evidence_metric_snapshot_rows_v2
     WHERE snapshot_run_id=? ORDER BY row_index
  `).bind(receipt.snapshot_run_id).all<{ row_json: string }>()
  const rows: StrategyEvidenceMetricRow[] = (stored.results ?? []).map(row => JSON.parse(row.row_json))
  if (receipt.status !== 'ready'
    || rows.length !== Number(receipt.metric_row_count)
    || rows.filter(row => row.metric_status === 'ready').length !== Number(receipt.ready_row_count)
    || await metricPayloadChecksum(rows) !== receipt.payload_checksum
  ) {
    throw new Error(`strategy_metric_snapshot_integrity_failure:${receipt.snapshot_run_id}`)
  }
  return {
    profiles: Number(receipt.profile_count),
    observations: Number(receipt.observation_count),
    metric_rows: rows.length,
    ready_rows: Number(receipt.ready_row_count),
    source: receipt.materialization_source,
    snapshot_run_id: receipt.snapshot_run_id,
    payload_checksum: receipt.payload_checksum,
    summary: `strategy_evidence_metrics receipt=${receipt.snapshot_run_id} profiles=${receipt.profile_count} observations=${receipt.observation_count} rows=${rows.length} ready=${receipt.ready_row_count}`,
  }
}

export async function publishMetricSnapshot(db: D1Database, input: {
  date: string
  definition: string
  mode: string
  scope: string
  source: string
  profiles: number
  observations: number
  readyRows: number
  rows: StrategyEvidenceMetricRow[]
}): Promise<MetricSnapshotResult> {
  const checksum = await metricPayloadChecksum(input.rows)
  const scopeHash = await sha256(input.scope)
  const id = [input.definition, input.date, input.mode, scopeHash.slice(0, 20), checksum.slice(0, 20)].join(':')
  const statements = [db.prepare(`
    INSERT OR IGNORE INTO strategy_evidence_metric_snapshot_runs_v2 (
      snapshot_run_id, outcome_as_of_date, definition_version, source_mode, publication_scope,
      materialization_source, status, profile_count, observation_count, metric_row_count,
      ready_row_count, payload_checksum
    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)
  `).bind(id, input.date, input.definition, input.mode, input.scope, input.source,
    input.profiles, input.observations, input.rows.length, input.readyRows, checksum)]
  statements.push(...input.rows.map((row, index) => db.prepare(`
    INSERT OR IGNORE INTO strategy_evidence_metric_snapshot_rows_v2 (snapshot_run_id, row_index, row_json)
    SELECT ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM strategy_evidence_metric_snapshot_runs_v2 WHERE snapshot_run_id=? AND payload_checksum=?
    )
  `).bind(id, index, JSON.stringify(row), id, checksum)))
  // Receipt and exact values become visible together. A losing claim cannot
  // write any rows, and old v1 receipts/values are never modified.
  await db.batch(statements)
  const receipt = await readMetricSnapshot(db, input.date, input.definition, input.mode, input.scope)
  if (!receipt || receipt.snapshot_run_id !== id || receipt.payload_checksum !== checksum) {
    throw new Error(`strategy_evidence_metric_snapshot_receipt_conflict:${input.date}:${input.mode}:${input.scope}`)
  }
  return receipt
}

export const METRIC_ROWS_CTE_SQL = `WITH metric_snapshot_rows AS (
 SELECT s.snapshot_run_id,s.created_at snapshot_created_at,s.source_mode,
 json_extract(m.row_json,'$.strategy_id') strategy_id,
 json_extract(m.row_json,'$.strategy_version') strategy_version,
 json_extract(m.row_json,'$.strategy_status') strategy_status,
 json_extract(m.row_json,'$.alpha_bucket') alpha_bucket,
 json_extract(m.row_json,'$.primary_horizon_days') primary_horizon_days,
 json_extract(m.row_json,'$.metric_name') metric_name,
 json_extract(m.row_json,'$.metric_value') metric_value,
 json_extract(m.row_json,'$.metric_status') metric_status,
 json_extract(m.row_json,'$.sample_count') sample_count,
 json_extract(m.row_json,'$.mature_dates') mature_dates,
 json_extract(m.row_json,'$.date_start') date_start,
 json_extract(m.row_json,'$.date_end') date_end,
 json_extract(m.row_json,'$.outcome_as_of_date') outcome_as_of_date,
 json_extract(m.row_json,'$.definition_version') definition_version,
 json_extract(m.row_json,'$.evidence_json') evidence_json
 FROM strategy_evidence_metric_snapshot_rows_v2 m
 JOIN strategy_evidence_metric_snapshot_runs_v2 s ON s.snapshot_run_id=m.snapshot_run_id AND s.status='ready'
 UNION ALL
 SELECT s.snapshot_run_id,s.created_at snapshot_created_at,s.source_mode,
m.strategy_id,m.strategy_version,m.strategy_status,m.alpha_bucket,m.primary_horizon_days,m.metric_name,m.metric_value,m.metric_status,m.sample_count,m.mature_dates,m.date_start,m.date_end,m.outcome_as_of_date,m.definition_version,m.evidence_json
 FROM strategy_evidence_metrics_v1 m
 JOIN strategy_evidence_metric_snapshot_runs_v1 s
 ON s.outcome_as_of_date=m.outcome_as_of_date AND s.definition_version=m.definition_version AND s.status='ready'
) `

// Cutoff is Taipei start-of-day. Late materialization cannot enter an earlier decision.
// DENSE_RANK selects one complete revision per date, not one row per metric/profile.
export const METRIC_ROWS_BEFORE_CUTOFF_SQL = `${METRIC_ROWS_CTE_SQL}, metric_revisions AS (
 SELECT *, DENSE_RANK() OVER (
   PARTITION BY outcome_as_of_date,definition_version,source_mode
   ORDER BY datetime(snapshot_created_at) DESC,snapshot_run_id DESC
 ) snapshot_rank FROM metric_snapshot_rows
 WHERE outcome_as_of_date < ? AND datetime(snapshot_created_at) < datetime(?,'-8 hours')
   AND source_mode='authority_bridge'
) `
