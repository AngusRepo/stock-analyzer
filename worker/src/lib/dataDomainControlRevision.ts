import {
  DATA_DOMAIN_CONTROL_TABLES,
  type DataDomainControlTable,
} from './dataDomainShadowManifest'

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

const DATA_DOMAIN_CONTROL_REVISION_OPERATIONS = [
  'insert',
  'update',
  'delete',
] as const

export type DataDomainControlRevisionTriggerInstallResult = {
  schemaVersion: typeof DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION
  revisionRows: number
  triggerCount: number
  triggerNames: string[]
}

export function dataDomainControlRevisionTriggerName(
  table: DataDomainControlTable,
  operation: typeof DATA_DOMAIN_CONTROL_REVISION_OPERATIONS[number],
): string {
  return `trg_${table}_revision_${operation}`
}

// Wrangler remote migrations cannot reliably split CREATE TRIGGER bodies.
// Migrations own the table/seed; the protected admin task installs these
// idempotently through the D1 binding exec() path after schema rebuilds.
export function dataDomainControlRevisionTriggerStatements(): string[] {
  return DATA_DOMAIN_CONTROL_TABLES.flatMap((table) => (
    DATA_DOMAIN_CONTROL_REVISION_OPERATIONS.map((operation) => `
      CREATE TRIGGER IF NOT EXISTS ${dataDomainControlRevisionTriggerName(table, operation)}
      AFTER ${operation.toUpperCase()} ON "${table}"
      BEGIN
        INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
        VALUES ('${table}', 1, CURRENT_TIMESTAMP)
        ON CONFLICT(table_name) DO UPDATE SET
          revision=revision + 1,
          updated_at=CURRENT_TIMESTAMP;
      END;
    `.trim())
  ))
}

export async function installDataDomainControlRevisionTriggers(
  db: D1Database,
): Promise<DataDomainControlRevisionTriggerInstallResult> {
  for (const table of DATA_DOMAIN_CONTROL_TABLES) {
    await db.prepare(`
      INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
      VALUES (?, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(table_name) DO NOTHING
    `).bind(table).run()
  }
  const statements = dataDomainControlRevisionTriggerStatements()
  for (const statement of statements) await db.exec(statement)

  const expectedNames = statements.map((statement) => {
    const match = statement.match(/CREATE TRIGGER IF NOT EXISTS\s+(\S+)/i)
    if (!match) throw new Error('data_domain_control_revision_trigger_statement_invalid')
    return match[1]
  }).sort()
  const triggerResult = await db.prepare(`
    SELECT name, sql
      FROM sqlite_master
     WHERE type='trigger' AND name LIKE 'trg_%_revision_%'
     ORDER BY name
  `).all<{ name?: string; sql?: string | null }>()
  const triggers = (triggerResult.results ?? []).map((row) => ({
    name: String(row.name ?? ''),
    sql: String(row.sql ?? ''),
  }))
  if (
    triggers.length !== expectedNames.length
    || JSON.stringify(triggers.map((row) => row.name)) !== JSON.stringify(expectedNames)
    || triggers.some((row) => !/INSERT\s+INTO\s+data_domain_control_revisions/i.test(row.sql))
  ) {
    throw new Error(`data_domain_control_revision_trigger_verification_failed:${triggers.length}`)
  }

  const revisionResult = await db.prepare(`
    SELECT table_name, revision
      FROM data_domain_control_revisions
     ORDER BY table_name
  `).all<{ table_name?: string; revision?: number | string | null }>()
  const revisions = new Map((revisionResult.results ?? []).map((row) => [
    String(row.table_name ?? ''),
    strictDataDomainControlRevision(row.revision),
  ]))
  if (DATA_DOMAIN_CONTROL_TABLES.some((table) => revisions.get(table) == null)) {
    throw new Error('data_domain_control_revision_seed_verification_failed')
  }
  return {
    schemaVersion: DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION,
    revisionRows: DATA_DOMAIN_CONTROL_TABLES.length,
    triggerCount: triggers.length,
    triggerNames: triggers.map((row) => row.name),
  }
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
