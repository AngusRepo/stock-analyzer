import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sourceReleaseTable } from './retentionSourceRelease'
import type { RetentionArchiveSource } from './retentionArchiveOnly'

// An archive whose exact delete never committed (R2 + ops manifest written, source batch failed)
// has no source release receipt, because the receipt is written in the same D1 batch as the
// delete. Its rows stay hot and the next pass archives them again, so the stale manifest is
// moved out of the ten-year class (artifact lifecycle reclaims staging orphans after 7 days).
// Archive ids are content addressed: a pass that re-archives the same rows at the same cutoff
// rewrites the same id back to the ten-year class and releases it with a receipt. Readers skip
// receipt-less archives too; retiring keeps them from being listed and downloaded.

export type OrphanArchiveOutcome = 'retired' | 'released' | 'not_archive'

export async function retireUnreleasedArchive(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  sourceDb: D1Database,
  source: Pick<RetentionArchiveSource, 'sourceDomain' | 'datasetId'>,
  policyId: string,
  artifactId: string,
): Promise<OrphanArchiveOutcome> {
  const ops = databaseForDataDomain(env, 'ops')
  const artifact = await ops.prepare(`SELECT artifact_id,domain,schema_version,retention_class,status FROM run_artifacts
    WHERE artifact_id=?`).bind(artifactId).first<Record<string, string>>()
  if (!artifact || artifact.domain !== `retention_${policyId}_${source.datasetId}`
      || artifact.schema_version !== 'd1-retention-hot-window-drain-v1'
      || artifact.retention_class !== 'ten_year_cold_archive' || artifact.status !== 'ready') return 'not_archive'
  const receipt = await sourceDb.prepare(`SELECT 1 AS ok FROM ${sourceReleaseTable(source.sourceDomain)} WHERE artifact_id=?`)
    .bind(artifactId).first()
  // Released: the delete committed; reconcileRetentionReleases publishes its ops proof.
  if (receipt) return 'released'
  await ops.prepare(`UPDATE run_artifacts SET retention_class='staging_orphan',
      retain_until=datetime('now','+7 days'), updated_at=CURRENT_TIMESTAMP
    WHERE artifact_id=? AND retention_class='ten_year_cold_archive' AND status='ready'`).bind(artifactId).run()
  return 'retired'
}

/** Next-pass self-heal: archives named by recent failed passes of this dataset (30 days, at most 50). */
export async function retireRecentUnreleasedArchives(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  sourceDb: D1Database,
  source: Pick<RetentionArchiveSource, 'sourceDomain' | 'datasetId'>,
  policyId: string,
): Promise<{ checked: number; retired: number }> {
  const ops = databaseForDataDomain(env, 'ops')
  const items = (await ops.prepare(`SELECT DISTINCT CASE WHEN json_valid(i.evidence_json)
      THEN json_extract(i.evidence_json,'$.artifact_id') END AS artifact_id
    FROM data_retention_run_items i
    WHERE i.dataset_id=? AND i.completed_at>=datetime('now','-30 days') AND i.status='error'
      AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END IS NOT NULL
    LIMIT 50`).bind(`hot-drain:${source.datasetId}`).all<{ artifact_id: string }>()).results ?? []
  let retired = 0
  for (const item of items) {
    if (await retireUnreleasedArchive(env, sourceDb, source, policyId, String(item.artifact_id)) === 'retired') retired++
  }
  return { checked: items.length, retired }
}
