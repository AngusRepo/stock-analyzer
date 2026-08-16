import {
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'

export const DATA_DOMAIN_WRITER_EPOCH_SCHEMA_VERSION = 'data-domain-writer-epoch-v1'

const OPERATIONS = ['insert', 'update', 'delete'] as const

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`data_domain_writer_epoch_identifier_invalid:${value}`)
  }
  return value
}

export function dataDomainWriterEpochTriggerName(
  domain: DataDomain,
  table: string,
  operation: typeof OPERATIONS[number],
): string {
  return `trg_dd_epoch_${identifier(domain)}_${identifier(table)}_${operation}`
}

export function dataDomainWriterEpochTriggerStatements(
  domain: DataDomain,
  tables = tablesForDataDomainShadowBackfill(domain),
): string[] {
  return tables.flatMap((rawTable) => {
    const table = identifier(rawTable)
    return OPERATIONS.map((operation) => `
      CREATE TRIGGER IF NOT EXISTS ${dataDomainWriterEpochTriggerName(domain, table, operation)}
      BEFORE ${operation.toUpperCase()} ON "${table}"
      BEGIN
        SELECT CASE
          WHEN COALESCE((
            SELECT writer_state FROM data_domain_writer_epochs WHERE domain='${domain}'
          ), 'missing') <> 'open'
          THEN RAISE(ABORT, 'data_domain_writer_quiescing')
        END;
        UPDATE data_domain_writer_epochs
           SET epoch=epoch + 1, updated_at=CURRENT_TIMESTAMP
         WHERE domain='${domain}' AND writer_state='open';
        INSERT INTO data_domain_table_writer_epochs(domain, table_name, epoch, updated_at)
        VALUES ('${domain}', '${table}', 1, CURRENT_TIMESTAMP)
        ON CONFLICT(domain, table_name) DO UPDATE SET
          epoch=epoch + 1,
          updated_at=CURRENT_TIMESTAMP;
      END;
    `.trim())
  })
}

export type DataDomainWriterEpochInstallResult = {
  schemaVersion: typeof DATA_DOMAIN_WRITER_EPOCH_SCHEMA_VERSION
  domain: DataDomain
  tableCount: number
  triggerCount: number
  epoch: number
}

export async function installDataDomainWriterEpochTriggers(
  db: D1Database,
  domain: DataDomain,
): Promise<DataDomainWriterEpochInstallResult> {
  const tables = tablesForDataDomainShadowBackfill(domain)
  await db.prepare(`
    INSERT INTO data_domain_writer_epochs(domain, epoch, writer_state, updated_at)
    VALUES (?, 0, 'open', CURRENT_TIMESTAMP)
    ON CONFLICT(domain) DO NOTHING
  `).bind(domain).run()
  for (const table of tables) {
    await db.prepare(`
      INSERT INTO data_domain_table_writer_epochs(domain, table_name, epoch, updated_at)
      VALUES (?, ?, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(domain, table_name) DO NOTHING
    `).bind(domain, table).run()
  }
  const statements = dataDomainWriterEpochTriggerStatements(domain, tables)
  for (const statement of statements) await db.prepare(statement).run()

  const prefix = `trg_dd_epoch_${domain}_%`
  const installed = await db.prepare(`
    SELECT COUNT(*) count
      FROM sqlite_master
     WHERE type='trigger' AND name LIKE ?
       AND sql LIKE '%data_domain_writer_epochs%'
       AND sql LIKE '%data_domain_table_writer_epochs%'
  `).bind(prefix).first<{ count?: number | string }>()
  const triggerCount = Number(installed?.count ?? 0)
  if (triggerCount !== statements.length) {
    throw new Error(`data_domain_writer_epoch_trigger_verification_failed:${domain}:${triggerCount}/${statements.length}`)
  }
  const row = await db.prepare(`
    SELECT epoch, writer_state FROM data_domain_writer_epochs WHERE domain=?
  `).bind(domain).first<{ epoch?: number | string; writer_state?: string }>()
  const epoch = Number(row?.epoch)
  if (!Number.isSafeInteger(epoch) || epoch < 0 || row?.writer_state !== 'open') {
    throw new Error(`data_domain_writer_epoch_seed_invalid:${domain}`)
  }
  return {
    schemaVersion: DATA_DOMAIN_WRITER_EPOCH_SCHEMA_VERSION,
    domain,
    tableCount: tables.length,
    triggerCount,
    epoch,
  }
}

export type DataDomainWriterEpochSnapshot = {
  schema_version: typeof DATA_DOMAIN_WRITER_EPOCH_SCHEMA_VERSION
  domain: DataDomain
  epoch: number
  writer_state: 'open' | 'quiescing' | 'cutover'
  table_epochs: Record<string, number>
}

export async function readDataDomainWriterEpochSnapshot(
  db: D1Database,
  domain: DataDomain,
): Promise<DataDomainWriterEpochSnapshot> {
  const [domainRow, tableRows] = await Promise.all([
    db.prepare(`
      SELECT epoch, writer_state FROM data_domain_writer_epochs WHERE domain=?
    `).bind(domain).first<{ epoch?: number | string; writer_state?: string }>(),
    db.prepare(`
      SELECT table_name, epoch FROM data_domain_table_writer_epochs
       WHERE domain=? ORDER BY table_name
    `).bind(domain).all<{ table_name?: string; epoch?: number | string }>(),
  ])
  const epoch = Number(domainRow?.epoch)
  const writerState = String(domainRow?.writer_state ?? '')
  if (
    !Number.isSafeInteger(epoch)
    || epoch < 0
    || !['open', 'quiescing', 'cutover'].includes(writerState)
  ) throw new Error(`data_domain_writer_epoch_missing_or_invalid:${domain}`)
  const tableEpochs: Record<string, number> = {}
  for (const row of tableRows.results ?? []) {
    const table = String(row.table_name ?? '')
    const tableEpoch = Number(row.epoch)
    if (!table || !Number.isSafeInteger(tableEpoch) || tableEpoch < 0) {
      throw new Error(`data_domain_table_writer_epoch_invalid:${domain}:${table || 'missing'}`)
    }
    tableEpochs[table] = tableEpoch
  }
  return {
    schema_version: DATA_DOMAIN_WRITER_EPOCH_SCHEMA_VERSION,
    domain,
    epoch,
    writer_state: writerState as DataDomainWriterEpochSnapshot['writer_state'],
    table_epochs: tableEpochs,
  }
}

export async function beginDataDomainWriterQuiescence(
  db: D1Database,
  domain: DataDomain,
  expectedEpoch: number,
): Promise<number> {
  const result = await db.prepare(`
    UPDATE data_domain_writer_epochs
       SET writer_state='quiescing', epoch=epoch + 1, updated_at=CURRENT_TIMESTAMP
     WHERE domain=? AND writer_state='open' AND epoch=?
  `).bind(domain, expectedEpoch).run()
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error(`data_domain_writer_epoch_cas_conflict:${domain}:${expectedEpoch}`)
  }
  return expectedEpoch + 1
}

export async function reopenDataDomainWriters(
  db: D1Database,
  domain: DataDomain,
  expectedQuiescedEpoch: number,
): Promise<void> {
  const result = await db.prepare(`
    UPDATE data_domain_writer_epochs
       SET writer_state='open', updated_at=CURRENT_TIMESTAMP
     WHERE domain=? AND writer_state='quiescing' AND epoch=?
  `).bind(domain, expectedQuiescedEpoch).run()
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error(`data_domain_writer_epoch_reopen_conflict:${domain}:${expectedQuiescedEpoch}`)
  }
}
