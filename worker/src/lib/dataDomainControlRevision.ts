import type { DataDomainControlTable } from './dataDomainShadowManifest'

export const DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION =
  'data-domain-control-revision-v1'

export type DataDomainControlRevisionPair = {
  sourceRevision: number
  targetRevision: number
}

type RevisionBoundReceipt = {
  evidence_json?: string | null
}

export type DataDomainControlRevisionEvidence = {
  revision_schema_version: typeof DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION
  source_revision: number
  target_revision: number
}

export function strictDataDomainControlRevision(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseEvidence(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function dataDomainControlRevisionEvidence(
  revisions: DataDomainControlRevisionPair,
): DataDomainControlRevisionEvidence {
  const sourceRevision = strictDataDomainControlRevision(revisions.sourceRevision)
  const targetRevision = strictDataDomainControlRevision(revisions.targetRevision)
  if (sourceRevision == null || targetRevision == null) {
    throw new Error('data_domain_control_revision_evidence_invalid')
  }
  return {
    revision_schema_version: DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION,
    source_revision: sourceRevision,
    target_revision: targetRevision,
  }
}

export function parseDataDomainControlRevisionEvidence(
  receipt: RevisionBoundReceipt | null | undefined,
): DataDomainControlRevisionEvidence | null {
  const evidence = parseEvidence(receipt?.evidence_json)
  const sourceRevision = strictDataDomainControlRevision(evidence?.source_revision)
  const targetRevision = strictDataDomainControlRevision(evidence?.target_revision)
  if (
    evidence?.revision_schema_version !== DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION
    || sourceRevision == null
    || targetRevision == null
  ) return null
  return {
    revision_schema_version: DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION,
    source_revision: sourceRevision,
    target_revision: targetRevision,
  }
}

export async function loadDataDomainControlRevision(
  db: D1Database,
  table: DataDomainControlTable,
): Promise<number> {
  const row = await db.prepare(`
    SELECT revision
      FROM data_domain_control_revisions
     WHERE table_name=?
  `).bind(table).first<{ revision?: number | string | null }>()
  const revision = strictDataDomainControlRevision(row?.revision)
  if (revision == null) throw new Error(`data_domain_control_revision_missing:${table}`)
  return revision
}

export async function loadDataDomainControlRevisionPair(
  sourceDb: D1Database,
  targetDb: D1Database,
  table: DataDomainControlTable,
): Promise<DataDomainControlRevisionPair> {
  const [sourceRevision, targetRevision] = await Promise.all([
    loadDataDomainControlRevision(sourceDb, table),
    loadDataDomainControlRevision(targetDb, table),
  ])
  return { sourceRevision, targetRevision }
}

export function dataDomainControlRevisionBlockers(input: {
  receipt: RevisionBoundReceipt | null | undefined
  live: DataDomainControlRevisionPair
}): string[] {
  const evidence = parseDataDomainControlRevisionEvidence(input.receipt)
  if (!evidence) return ['revision_evidence_missing_or_invalid']
  const blockers: string[] = []
  if (evidence.source_revision !== input.live.sourceRevision) {
    blockers.push(`source_revision_stale:${evidence.source_revision}/${input.live.sourceRevision}`)
  }
  if (evidence.target_revision !== input.live.targetRevision) {
    blockers.push(`target_revision_stale:${evidence.target_revision}/${input.live.targetRevision}`)
  }
  return blockers
}
