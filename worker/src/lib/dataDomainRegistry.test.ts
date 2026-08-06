import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  activeDataDomains,
  assertSingleDomainOwnership,
  databaseForDataDomain,
  dataDomainForTable,
  invalidActiveDataDomains,
  MULTI_D1_PROJECTION_CONTRACT_GATES,
  MULTI_D1_PROJECTION_CONTRACT_READY,
  MULTI_D1_ROUTING_CONTRACT_GATES,
  shadowDatabaseForDataDomain,
  MULTI_D1_STRICT_ROUTING_READY,
  resolveDataDomainRoute,
  tablesForDataDomain,
  tablesForDataDomainShadowBackfill,
} from './dataDomainRegistry'

const sqlFiles = [
  'schema.sql',
  ...fs.readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .map((name) => path.join('migrations', name)),
]
const tableNames = [...new Set(sqlFiles.flatMap((file) => (
  [...fs.readFileSync(file, 'utf8').matchAll(/^CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gm)]
    .map((match) => match[1].toLowerCase())
)))]
assertSingleDomainOwnership(tableNames)

for (const table of new Set(tableNames)) {
  const owner = dataDomainForTable(table)
  if (!owner) throw new Error(`missing owner for ${table}`)
  if (!tablesForDataDomain(owner).includes(table) && !table.startsWith('paper_')) {
    throw new Error(`registry reverse lookup mismatch for ${table}`)
  }
}

if (dataDomainForTable('unknown_future_table') !== null) {
  throw new Error('unknown tables must fail closed instead of silently defaulting to core')
}

const legacy = { kind: 'legacy' } as unknown as D1Database
const opsControlTables = [
  'maintenance_task_leases',
  'data_domain_cutovers',
  'data_domain_backfill_cursors',
  'data_domain_parity_checks',
]
assert(opsControlTables.every((table) => tablesForDataDomain('ops').includes(table)))
assert(opsControlTables.every((table) => !tablesForDataDomainShadowBackfill('ops').includes(table)))
assert(!tablesForDataDomainShadowBackfill('learning').includes('entry_model_replay_reports'))

const assertParentBeforeChild = (domain: Parameters<typeof tablesForDataDomainShadowBackfill>[0], parent: string, child: string) => {
  const tables = tablesForDataDomainShadowBackfill(domain)
  assert(tables.indexOf(parent) >= 0, `missing parent ${parent}`)
  assert(tables.indexOf(child) >= 0, `missing child ${child}`)
  assert(tables.indexOf(parent) < tables.indexOf(child), `${parent} must precede ${child}`)
}
assertParentBeforeChild('ops', 'data_retention_policies', 'data_retention_runs')
assertParentBeforeChild('ops', 'data_retention_runs', 'data_retention_run_items')
assertParentBeforeChild('ops', 's12_structure_batch_runs', 's12_structure_batch_shards')
assertParentBeforeChild('ops', 'screener_funnel_runs', 'screener_funnel_items')
assertParentBeforeChild('execution', 'broker_execution_intents', 'broker_execution_legs')
assertParentBeforeChild('execution', 'broker_execution_legs', 'broker_execution_events')
assertParentBeforeChild('learning', 'active8_oof_cohorts', 'active8_oof_predictions')
assertParentBeforeChild('learning', 'allocator_ev_snapshot_runs', 'allocator_ev_feature_snapshot_staging')
assertParentBeforeChild('learning', 'model_artifact_registry', 'expected_return_artifact_payloads')
assertParentBeforeChild('learning', 'strategy_marginal_edge_runs_v4', 'strategy_marginal_edge_dates_v4')
assertParentBeforeChild('learning', 'strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1')

const schemaSql = fs.readFileSync('schema.sql', 'utf8')
for (const match of schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)\s*\(([\s\S]*?)\n\);/g)) {
  const child = match[1].toLowerCase()
  const childDomain = dataDomainForTable(child)
  if (!childDomain) continue
  const ownedTables = tablesForDataDomainShadowBackfill(childDomain)
  if (!ownedTables.includes(child)) continue
  for (const reference of match[2].matchAll(/REFERENCES\s+([A-Za-z0-9_]+)/gi)) {
    const parent = reference[1].toLowerCase()
    if (dataDomainForTable(parent) === childDomain && ownedTables.includes(parent)) {
      assertParentBeforeChild(childDomain, parent, child)
    }
  }
}

const market = { kind: 'market' } as unknown as D1Database
const shadowEnv = { DB: legacy, MARKET_DB: market }
assert.equal(databaseForDataDomain(shadowEnv, 'market'), legacy)
assert.equal(shadowDatabaseForDataDomain(shadowEnv, 'market'), market)
assert(activeDataDomains({ MULTI_D1_ACTIVE_DOMAINS: ' market,ops ' }).has('ops'))
assert.deepEqual(invalidActiveDataDomains({ MULTI_D1_ACTIVE_DOMAINS: ' market,unknown,ops,bad ' }), ['unknown', 'bad'])
assert.throws(
  () => databaseForDataDomain({ ...shadowEnv, MULTI_D1_ACTIVE_DOMAINS: 'market' }, 'market'),
  /multi_d1_strict_routing_not_closed/,
)

assert.equal(MULTI_D1_STRICT_ROUTING_READY, false)
assert.equal(MULTI_D1_PROJECTION_CONTRACT_READY, false)
assert.equal(MULTI_D1_ROUTING_CONTRACT_GATES.direct_legacy_db_paths_closed, false)
assert.equal(MULTI_D1_PROJECTION_CONTRACT_GATES.typed_outbox_producers_wired, false)
assert.throws(
  () => databaseForDataDomain({ ...shadowEnv, MULTI_D1_STRICT: 'true' }, 'market'),
  /multi_d1_strict_routing_not_closed/,
)
assert.equal(resolveDataDomainRoute({
  domain: 'market', activeDomains: new Set(['market']), strictRequested: true, routingReady: true,
}), 'domain')
assert.equal(resolveDataDomainRoute({
  domain: 'learning', activeDomains: new Set(['market']), strictRequested: true, routingReady: true,
}), 'legacy')
assert.throws(() => resolveDataDomainRoute({
  domain: 'market', activeDomains: new Set(), strictRequested: true, routingReady: true,
}), /multi_d1_strict_active_domains_missing/)
assert.throws(() => resolveDataDomainRoute({
  domain: 'market', activeDomains: new Set(['market']), invalidDomains: ['unknown'], strictRequested: false, routingReady: true,
}), /multi_d1_active_domain_invalid:unknown/)
