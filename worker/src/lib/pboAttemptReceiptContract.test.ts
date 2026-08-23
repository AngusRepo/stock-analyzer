import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync('domain-migrations/research/0004_pbo_attempt_receipts.sql', 'utf8')
const schema = fs.readFileSync('domain-schemas/research.sql', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')
const retention = fs.readFileSync('src/lib/retentionArchiveOnly.ts', 'utf8')
const service = fs.readFileSync('../ml-controller/services/pbo_service.py', 'utf8')
const route = fs.readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')

for (const sql of [migration, schema]) {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pbo_attempt_receipts/)
  assert.match(sql, /status\s+TEXT NOT NULL CHECK \(status IN \('computed', 'insufficient_evidence'\)\)/)
  assert.match(sql, /observed_trades\s+INTEGER NOT NULL/)
  assert.match(sql, /required_trades\s+INTEGER NOT NULL/)
  assert.match(sql, /source_provenance_json\s+TEXT NOT NULL CHECK \(json_valid\(source_provenance_json\)\)/)
  assert.match(sql, /pbo_result_id\s+INTEGER/)
  assert.match(sql, /production_effect\s+INTEGER NOT NULL DEFAULT 0 CHECK \(production_effect = 0\)/)
  assert.match(sql, /status = 'insufficient_evidence' AND pbo_result_id IS NULL/)
  assert.match(sql, /status = 'computed' AND pbo_result_id IS NOT NULL/)
}

assert(
  registry.includes("{ table: 'pbo_attempt_receipts', domain: 'research', disposition: 'compact_projection', route_ready: true, shadow_ready: false }"),
  'PBO attempt receipts must be Research-owned domain-native evidence',
)
assert(
  retention.includes("tableSource('research', 'pbo_attempt_receipts', 'run_date')"),
  'PBO attempt receipts must participate in the ten-year Research archive policy',
)
assert(service.includes('async def persist_pbo_attempt_receipt('))
assert(service.includes('INSERT OR IGNORE INTO pbo_attempt_receipts'))
assert(service.includes('status="insufficient_evidence"'))
assert(service.includes('status="computed"'))
assert(service.includes('"pbo": None'))
assert(service.includes('"pbo_result_id": None'))
assert(service.includes('"production_effect": False'))
const reconciliation = fs.readFileSync('../ml-controller/routers/backtest.py', 'utf8')
assert(reconciliation.includes('"receipt_origin": "read_only_source_reconciliation"'))
assert(reconciliation.includes('"attempt_receipt_materialized": bool(pbo_attempt_id)'))
assert(reconciliation.includes('"pbo_attempt": pbo_attempt_id'))
assert(
  service.indexOf('status="insufficient_evidence"') < service.indexOf('"pbo": None'),
  'insufficient evidence must persist its immutable attempt before returning without a numeric PBO',
)
assert(
  route.includes('FROM pbo_attempt_receipts a') &&
    route.includes('ORDER BY a.run_date DESC, a.created_at DESC, a.attempt_id DESC') &&
    route.includes('LEFT JOIN pbo_results p ON p.id = a.pbo_result_id') &&
    route.includes('latest_attempt: latestAttempt') &&
    route.includes('latest_numeric_result: latestNumericResult ?? null'),
  'dashboard PBO response must distinguish the latest attempt from historical numeric results',
)
