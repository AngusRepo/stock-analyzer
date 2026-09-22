import type { Bindings } from '../types'
import type { RetentionArchiveSource } from './retentionArchiveOnly'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sourceReleaseTable } from './retentionSourceRelease'
import { sha256Text } from './datasetSnapshots'
import { loadRetentionCursor } from './retentionRunLedger'

type Release = { artifact_id: string; checksum: string; dataset_id: string; row_count: number; released_at: string }

/** Repair only the lost OPS acknowledgement of an already committed source transaction. */
export async function reconcileRetentionReleases(
  env: Pick<Bindings,'DB'|'ARTIFACTS'> & Partial<Bindings>,
  sourceDb: D1Database, source: RetentionArchiveSource, policyId: string,
  limit = 50,
): Promise<{ checked: number; reconciled: number; backlog_remaining: boolean }> {
  limit = Math.max(1,Math.min(Math.floor(limit),50))
  const ops = databaseForDataDomain(env,'ops')
  const dataset = `release-reconcile:${source.datasetId}`
  const cursor = await loadRetentionCursor(ops,policyId,dataset)
  // Source receipts are immutable and use the source database's UTC clock.
  // Read settled seconds only, so concurrent inserts in the current second
  // cannot fall behind the (time, artifact) keyset checkpoint.
  const rows = (await sourceDb.prepare(`SELECT artifact_id,checksum,dataset_id,row_count,released_at
    FROM ${sourceReleaseTable(source.sourceDomain)} WHERE dataset_id=?
      AND released_at < datetime('now','-5 seconds')
      AND (released_at>? OR (released_at=? AND artifact_id>?))
    ORDER BY released_at,artifact_id LIMIT ?`)
    .bind(source.datasetId,cursor?.cursor_date ?? '',cursor?.cursor_date ?? '',cursor?.cursor_key ?? '',limit)
    .all<Release>()).results ?? []
  let reconciled = 0
  for (const release of rows) {
    const saved = await ops.prepare(`SELECT 1 ok FROM data_retention_run_items
      WHERE status='success' AND deleted_rows=? AND CASE WHEN json_valid(evidence_json)
      THEN json_extract(evidence_json,'$.artifact_id') END=?
      AND json_extract(evidence_json,'$.checksum')=? LIMIT 1`)
      .bind(release.row_count,release.artifact_id,release.checksum).first()
    if (saved) continue
    const artifact = await ops.prepare(`SELECT * FROM run_artifacts WHERE artifact_id=?`)
      .bind(release.artifact_id).first<Record<string,any>>()
    if (!artifact || artifact.checksum!==release.checksum || artifact.row_count!==release.row_count
        || artifact.domain!==`retention_${policyId}_${source.datasetId}`
        || artifact.schema_version!=='d1-retention-hot-window-drain-v1'
        || artifact.retention_class!=='ten_year_cold_archive' || artifact.status!=='ready' || artifact.payload_deleted_at)
      throw new Error('retention_reconcile_manifest_mismatch')
    const object = await env.ARTIFACTS?.get(artifact.r2_key)
    if (!object) throw new Error('retention_reconcile_archive_missing')
    const raw = await object.text()
    if (await sha256Text(raw)!==release.checksum) throw new Error('retention_reconcile_checksum_mismatch')
    const body = JSON.parse(raw), payload = body.payload
    if (body.domain!==artifact.domain || body.schema_version!==artifact.schema_version
        || payload?.schema_version!==artifact.schema_version || payload?.dataset_id!==source.datasetId
        || payload?.source_domain!==source.sourceDomain || payload?.policy_id!==policyId
        || !Array.isArray(payload?.rows) || payload.rows.length!==release.row_count)
      throw new Error('retention_reconcile_payload_mismatch')
    const runId=`retention-release-reconcile:${release.artifact_id}`
    const evidence=JSON.stringify({ schema_version:artifact.schema_version,artifact_id:release.artifact_id,
      checksum:release.checksum,r2_key:artifact.r2_key,source_release_verified_at:release.released_at,
      reconciliation_only:true,deleted_now:0,archive_before_delete:true })
    // This transaction publishes historical proof, not another deletion count.
    // Deterministic ids make an uncertain HTTP reply safe to retry.
    await ops.batch([
      ops.prepare(`INSERT OR IGNORE INTO data_retention_runs(run_id,policy_id,business_date,status,completed_at)
        VALUES(?,?,?,'success',CURRENT_TIMESTAMP)`).bind(runId,policyId,release.released_at.slice(0,10)),
      ops.prepare(`INSERT OR IGNORE INTO data_retention_run_items(run_id,dataset_id,status,archived_rows,
        deleted_rows,archived_bytes,backlog_remaining,evidence_json)
        VALUES(?,?,'success',?,?,?,0,?)`).bind(runId,`hot-drain:${source.datasetId}`,release.row_count,release.row_count,artifact.byte_size,evidence),
    ])
    reconciled++
  }
  const last=rows.at(-1)
  if (last) await ops.prepare(`INSERT INTO data_retention_cursors(policy_id,dataset_id,status,cursor_date,cursor_key,backlog_remaining)
    VALUES(?,?,'running',?,?,?) ON CONFLICT(policy_id,dataset_id) DO UPDATE SET
      cursor_date=excluded.cursor_date,cursor_key=excluded.cursor_key,backlog_remaining=excluded.backlog_remaining,
      updated_at=CURRENT_TIMESTAMP`)
    .bind(policyId,dataset,last.released_at,last.artifact_id,rows.length>=limit?1:0).run()
  return { checked:rows.length,reconciled,backlog_remaining:rows.length>=limit }
}
