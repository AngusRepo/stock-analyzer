import type { Bindings } from '../types'
import { retainArtifactHardReference, writeEvidenceArtifact } from './artifactLifecycle'
import { checkpointLegacyMigration, loadLegacyMigrationCursor } from './legacyMigrationCursor'

type LegacyScreenerEvidenceRow = {
  id: number
  run_id: string
  date: string
  symbol: string
  stage: string
  evidence: string
}

function pointerJson(artifact: { artifact_id: string; r2_key: string; checksum: string }, rowId: number): string {
  return JSON.stringify({
    schema_version: 'legacy-screener-evidence-pointer-v1',
    artifact_id: artifact.artifact_id,
    r2_key: artifact.r2_key,
    checksum: artifact.checksum,
    row_id: rowId,
  })
}

export async function runLegacyEvidenceMigration(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { limit?: number } = {},
): Promise<{
  candidates: number
  artifacts: number
  queued_scrubs: number
  backlog_remaining: boolean
}> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 200), 500))
  const taskName = 'legacy_screener_evidence_v2'
  const cursor = await loadLegacyMigrationCursor(env.DB, taskName)
  if (cursor?.status === 'complete') {
    return { candidates: 0, artifacts: 0, queued_scrubs: 0, backlog_remaining: false }
  }
  const cursorId = Math.max(0, Number.parseInt(cursor?.cursor_key ?? '0', 10) || 0)
  const { results } = await env.DB.prepare(`
    SELECT sfi.id, sfi.run_id, sfi.date, sfi.symbol, sfi.stage, sfi.evidence
      FROM screener_funnel_items sfi
      JOIN screener_funnel_runs sfr ON sfr.run_id = sfi.run_id
     WHERE sfi.id > ?
       AND sfi.evidence IS NOT NULL
       AND LENGTH(sfi.evidence) > 256
       AND (
         json_valid(sfi.evidence) = 0
         OR json_extract(sfi.evidence, '$.artifact_id') IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM canonical_run_heads h WHERE h.run_id = sfi.run_id
       )
       AND sfi.run_id <> COALESCE((
         SELECT latest.run_id
           FROM screener_funnel_runs latest
          WHERE latest.date = sfi.date
            AND latest.status = 'success'
          ORDER BY latest.created_at DESC
          LIMIT 1
       ), '')
       AND NOT EXISTS (
         SELECT 1
           FROM artifact_d1_scrub_queue q
          WHERE q.target_table='screener_funnel_items'
            AND q.target_pk_column='id'
            AND q.target_pk_value=CAST(sfi.id AS TEXT)
            AND q.target_column='evidence'
            AND q.status IN ('pending','running','complete')
       )
     ORDER BY sfi.id
     LIMIT ?
  `).bind(cursorId, limit).all<LegacyScreenerEvidenceRow>()

  const rows = results ?? []
  if (!rows.length) {
    await checkpointLegacyMigration(env.DB, { taskName, status: 'complete' })
    return { candidates: 0, artifacts: 0, queued_scrubs: 0, backlog_remaining: false }
  }
  const grouped = new Map<string, LegacyScreenerEvidenceRow[]>()
  for (const row of rows) {
    const group = grouped.get(row.run_id) ?? []
    group.push(row)
    grouped.set(row.run_id, group)
  }
  let artifacts = 0
  let queuedScrubs = 0
  for (const [runId, runRows] of grouped) {
    const businessDate = runRows[0].date
    const artifact = await writeEvidenceArtifact(env, {
      domain: 'legacy_screener_funnel_evidence',
      businessDate,
      producerRunId: `legacy-migration:${runId}:${runRows[0].id}-${runRows[runRows.length - 1].id}`,
      retentionClass: 'superseded_run',
      schemaVersion: 'legacy-screener-funnel-evidence-v1',
      payload: {
        source_run_id: runId,
        rows: runRows.map((row) => ({
          id: row.id,
          symbol: row.symbol,
          stage: row.stage,
          evidence: row.evidence,
        })),
      },
      rowCount: runRows.length,
      metadata: { migration: 'legacy_noncanonical_screener' },
    })
    artifacts += 1
    await retainArtifactHardReference(env.DB, {
      artifactId: artifact.artifact_id,
      ownerType: 'legacy_screener_run',
      ownerId: runId,
    })
    const statements = runRows.map((row) => env.DB.prepare(`
      INSERT OR IGNORE INTO artifact_d1_scrub_queue (
        scrub_id, artifact_id, target_table, target_pk_column, target_pk_value,
        target_column, replacement_json, status, created_at, updated_at
      ) VALUES (?, ?, 'screener_funnel_items', 'id', ?, 'evidence', ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      `legacy-screener-item:${row.id}`,
      artifact.artifact_id,
      String(row.id),
      pointerJson(artifact, row.id),
    ))
    for (let i = 0; i < statements.length; i += 50) {
      await env.DB.batch(statements.slice(i, i + 50))
    }
    queuedScrubs += runRows.length
  }
  const lastRow = rows[rows.length - 1]
  const backlogRemaining = rows.length === limit
  await checkpointLegacyMigration(env.DB, {
    taskName,
    status: backlogRemaining ? 'running' : 'complete',
    cursorDate: lastRow.date,
    cursorKey: String(lastRow.id),
    scannedRows: rows.length,
    archivedRows: queuedScrubs,
  })
  return {
    candidates: rows.length,
    artifacts,
    queued_scrubs: queuedScrubs,
    backlog_remaining: backlogRemaining,
  }
}
