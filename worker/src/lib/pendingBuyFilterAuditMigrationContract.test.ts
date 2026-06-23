const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const migration = fs.readFileSync('migration_pending_buy_filter_audit_2026_06_23.sql', 'utf8')
const orchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const normalizedMigration = migration.replace(/\s+/g, ' ')

assert(
  migration.includes('CREATE TABLE IF NOT EXISTS pending_buy_filter_audit'),
  'pending-buy filter audit migration must create the audit table idempotently',
)
for (const column of [
  'run_id INTEGER',
  'trade_date TEXT NOT NULL',
  'source_reco_date TEXT NOT NULL',
  'symbol TEXT',
  'stage TEXT NOT NULL',
  'action TEXT NOT NULL',
  'reason_code TEXT NOT NULL',
  'classification TEXT',
  'quadrant TEXT',
  'rs_ratio REAL',
  'rs_momentum REAL',
  'risk_multiplier REAL',
  'details_json TEXT',
]) {
  assert(normalizedMigration.includes(column), `pending-buy filter audit migration missing column contract: ${column}`)
}
for (const indexName of [
  'idx_pending_buy_filter_audit_run',
  'idx_pending_buy_filter_audit_trade_date',
  'idx_pending_buy_filter_audit_reason',
]) {
  assert(migration.includes(indexName), `pending-buy filter audit migration missing index: ${indexName}`)
}

assert(
  orchestrator.includes('persistPendingBuyFilterAudit') &&
    orchestrator.includes('pending_buy_filter_audit') &&
    orchestrator.includes('isMissingAuditTableError'),
  'Morning Setup must persist filter audit rows while failing open if the new table is not yet deployed',
)
assert(
  orchestrator.includes('filter_audit: filterAudit') &&
    orchestrator.includes('empty_reason: emptyReason') &&
    orchestrator.includes('persistPendingBuyFilterAudit(env, runId, pendingDate, sourceRecoDate, quadrantFilterLog)'),
  'Morning Setup snapshot meta must carry filter_audit/empty_reason and write D1 audit after run id is known',
)
