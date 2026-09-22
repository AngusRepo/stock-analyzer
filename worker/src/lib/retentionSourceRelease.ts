import { buildExactRetentionDelete } from './retentionExactRows'
import type { RetentionArchiveSource } from './retentionArchiveOnly'

export function sourceReleaseTable(domain: string): string {
  if (!['market', 'learning', 'execution', 'ops', 'research'].includes(domain))
    throw new Error('retention_source_release_domain_invalid')
  return `${domain}_retention_releases_v1`
}

export async function releaseArchivedRows(db: D1Database, source: RetentionArchiveSource,
  cutoffDate: string, rows: Record<string, unknown>[], artifact: { artifact_id: string; checksum: string }): Promise<number> {
  const table = sourceReleaseTable(source.sourceDomain)
  const saved = await db.prepare(`SELECT * FROM ${table} WHERE artifact_id=?`).bind(artifact.artifact_id)
    .first<{ checksum: string; dataset_id: string; row_count: number }>()
  if (saved) {
    if (saved.checksum !== artifact.checksum || saved.dataset_id !== source.datasetId || saved.row_count !== rows.length)
      throw new Error('retention_source_release_identity_conflict')
    return saved.row_count // Lost HTTP/OPS acknowledgement; the source transaction already committed.
  }
  const exact = buildExactRetentionDelete(source, rows)
  // D1 batch is one transaction. changes() is the preceding top-level DELETE
  // count, excluding trigger writes. CHECK failure rolls back BOTH statements.
  // A zero/partial match must never publish an archival release receipt.
  const result = await db.batch([
    db.prepare(exact.sql).bind(exact.rowsJson, cutoffDate),
    db.prepare(`INSERT INTO ${table}(artifact_id,checksum,dataset_id,row_count)
      VALUES(?,?,?,CASE WHEN changes()=? THEN ? ELSE -1 END)`)
      .bind(artifact.artifact_id, artifact.checksum, source.datasetId, rows.length, rows.length),
  ])
  if ((result[0].results ?? []).length !== rows.length)
    throw new Error('retention_source_release_count_mismatch')
  return rows.length
}
