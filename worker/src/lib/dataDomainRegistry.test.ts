import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  activeDataDomains,
  DATA_DOMAINS,
  assertOwnershipEntries,
  assertSingleDomainOwnership,
  databaseForDataDomain,
  dataDomainForTable,
  dataDomainProjectionContractReady,
  databaseForTable,
  LEGACY_CONTROL_PLANE_TABLES,
  dataDomainRoutingContractReady,
  invalidActiveDataDomains,
  MULTI_D1_PROJECTION_CONTRACT_GATES,
  MULTI_D1_PROJECTION_CONTRACT_READY,
  MULTI_D1_ROUTING_CONTRACT_GATES,
  shadowDatabaseForDataDomain,
  MULTI_D1_STRICT_ROUTING_READY,
  resolveDataDomainRoute,
  tableOwnershipMetadata,
  tablesForDataDomain,
  tablesForDataDomainRouteReady,
  tablesForDataDomainShadowBackfill,
  type TableOwnershipMetadata,
} from './dataDomainRegistry'

const tableNamesFromSql = (file: string): string[] => (
  [...fs.readFileSync(file, 'utf8').matchAll(/^CREATE TABLE(?: IF NOT EXISTS)?\s+["`[]?([A-Za-z0-9_]+)/gmi)]
    .map((match) => match[1].toLowerCase())
)

const productionSnapshot = path.join('bootstrap', 'schema.production.snapshot.sql')
const migrationTransientTables = new Set([
  'active8_oof_date_eligibility_v3',
  'chip_data_new',
  'd1_migrations',
  'data_domain_control_revisions',
  'model_artifact_registry_new',
  'model_artifact_registry_oof_release_new',
  'pending_buy_debate_turns',
  'sector_flow_new',
])
const productionSqlFiles = [
  'schema.sql',
  productionSnapshot,
  ...fs.readdirSync('.')
    .filter((name) => /^migration.*\.sql$/i.test(name))
    .map((name) => path.join('.', name)),
  ...fs.readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .map((name) => path.join('migrations', name)),
]
const domainSqlFiles = DATA_DOMAINS.flatMap((domain) => [
  path.join('domain-schemas', `${domain}.sql`),
  ...fs.readdirSync(path.join('domain-migrations', domain))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => path.join('domain-migrations', domain, name)),
])
const productionCreatedTables = [...new Set(productionSqlFiles.flatMap(tableNamesFromSql))]
const productionTableNames = productionCreatedTables.filter((table) => !migrationTransientTables.has(table))
assert.deepEqual(
  productionCreatedTables.filter((table) => !tableOwnershipMetadata(table)).sort(),
  [...migrationTransientTables].sort(),
  'every migration-created table must be explicitly owned or explicitly transient',
)
assert.equal(productionTableNames.length, 234, 'production schema table count changed; ownership review is required')
assert.equal(dataDomainForTable('canonical_revenue_observations_v2'), 'market', 'append-only revenue revisions require one Market owner')
const tableNames = [...new Set([
  ...productionTableNames,
  ...domainSqlFiles.flatMap(tableNamesFromSql)
    .filter((table) => !migrationTransientTables.has(table)),
])]
assertSingleDomainOwnership(tableNames)

for (const table of new Set(tableNames)) {
  const owner = dataDomainForTable(table)
  if (!owner) throw new Error(`missing owner for ${table}`)
  if (!tablesForDataDomain(owner).includes(table)) {
    throw new Error(`registry reverse lookup mismatch for ${table}`)
  }
}

if (dataDomainForTable('unknown_future_table') !== null) {
  throw new Error('unknown tables must fail closed instead of silently defaulting to core')
}
assert.equal(dataDomainForTable('paper_unregistered_future_table'), null, 'paper prefix must not bypass explicit ownership')
assert.throws(
  () => assertSingleDomainOwnership([...tableNames, 'unknown_future_table']),
  /unowned_data_domain_tables:unknown_future_table/,
)

const duplicateOwnership: TableOwnershipMetadata[] = [
  { table: 'duplicate_table', domain: 'core', disposition: 'full_scalar', route_ready: false, shadow_ready: false },
  { table: 'duplicate_table', domain: 'ops', disposition: 'active_window', route_ready: false, shadow_ready: false },
]
assert.throws(() => assertOwnershipEntries(duplicateOwnership), /duplicate_data_domain_ownership:duplicate_table:core\|ops/)

assert.equal(tableOwnershipMetadata('strategy_candidate_contexts')?.route_ready, true,
  'strategy candidate contexts must be materialized in the active Learning owner')
assert.equal(tableOwnershipMetadata('strategy_candidate_contexts')?.shadow_ready, false,
  'active-owner context materialization must not re-enter the inactive-only shadow backfill drain')
for (const table of ['meta_reward_ledger', 'meta_shadow_decisions']) {
  assert.equal(tableOwnershipMetadata(table)?.route_ready, true, `${table} must route to Learning D1`)
  assert.equal(tableOwnershipMetadata(table)?.shadow_ready, false,
    `${table} is active-owner materialization and must not re-enter inactive-only shadow backfill`)
}

const deferredProductionTables = productionTableNames.filter((table) => (
  tableOwnershipMetadata(table)?.route_ready === false && !LEGACY_CONTROL_PLANE_TABLES.has(table)
))
assert.equal(deferredProductionTables.length, 67, 'production tables without target schema readiness require explicit review')
assert.equal(
  deferredProductionTables.filter((table) => tableOwnershipMetadata(table)?.disposition === 'legacy_only').length,
  5,
  'legacy-only table count changed; retirement evidence must be reviewed',
)
for (const table of deferredProductionTables) {
  const metadata = tableOwnershipMetadata(table)
  assert(metadata, `missing metadata for deferred production table ${table}`)
  assert.equal(metadata.route_ready, false, `${table} must not route before target schema closure`)
  assert.equal(
    tablesForDataDomainShadowBackfill(metadata.domain).includes(table),
    metadata.shadow_ready,
    `${table} shadow registry mismatch`,
  )
}

for (const domain of DATA_DOMAINS) {
  const targetFiles = [
    path.join('domain-schemas', `${domain}.sql`),
    ...fs.readdirSync(path.join('domain-migrations', domain))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => path.join('domain-migrations', domain, name)),
  ]
  const targetTables = new Set(targetFiles.flatMap(tableNamesFromSql))
  for (const table of tablesForDataDomainRouteReady(domain)) {
    assert(targetTables.has(table), `${domain}.${table} route_ready without target schema`)
  }
  for (const table of tablesForDataDomainShadowBackfill(domain)) {
    assert(targetTables.has(table), `${domain}.${table} shadow_ready without target schema`)
  }
}

const legacy = { kind: 'legacy' } as unknown as D1Database
const opsControlTables = [
  'maintenance_task_leases',
  'data_domain_cutovers',
  'data_domain_writer_epochs',
  'data_domain_table_writer_epochs',
  'data_domain_backfill_cursors',
  'data_domain_parity_checks',
]
assert(opsControlTables.every((table) => tablesForDataDomain('ops').includes(table)))
assert(opsControlTables.every((table) => !tablesForDataDomainShadowBackfill('ops').includes(table)))
const opsRuntimeTables = [
  'pipeline_runs',
  'canonical_run_heads',
  'run_artifacts',
  'artifact_cleanup_cursors',
  'artifact_cleanup_dlq',
  'compute_profile_events',
  'compute_efficiency_reports',
  'cost_events',
]
assert(opsRuntimeTables.every((table) => tablesForDataDomainShadowBackfill('ops').includes(table)))
assert(!tablesForDataDomainShadowBackfill('learning').includes('entry_model_replay_reports'))
const domainNativeLearningTables = [
  'price_horizon_labels_v2',
  'price_horizon_label_rejections_v2',
  'canonical_selection_outcomes_v1',
  'strategy_evidence_metrics_v1',
]
assert(domainNativeLearningTables.every((table) => tablesForDataDomain('learning').includes(table)))
assert(domainNativeLearningTables.every((table) => tablesForDataDomainRouteReady('learning').includes(table)))
assert(domainNativeLearningTables.every((table) => !tablesForDataDomainShadowBackfill('learning').includes(table)))
assert(!tablesForDataDomainShadowBackfill('market').includes('canonical_revenue_observations_v2'))
assert(tablesForDataDomain('ops').includes('price_horizon_projection_status_v2'))
assert(tablesForDataDomainRouteReady('ops').includes('price_horizon_projection_status_v2'))
assert(!tablesForDataDomainShadowBackfill('ops').includes('price_horizon_projection_status_v2'))

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
assertParentBeforeChild('learning', 'model_artifact_registry', 'model_champion_history')
assertParentBeforeChild('learning', 'expected_return_artifact_payloads', 'model_champion_pointers')
assertParentBeforeChild('learning', 'model_champion_history', 'model_champion_pointers')
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
const learning = { kind: 'learning' } as unknown as D1Database
const learningActiveEnv = {
  DB: legacy,
  LEARNING_DB: learning,
  MULTI_D1_ACTIVE_DOMAINS: 'learning',
}
assert.equal(databaseForDataDomain(learningActiveEnv, 'learning'), learning)
assert.equal(databaseForDataDomain(learningActiveEnv, 'market'), legacy)
const paperDb = { kind: 'paper' } as unknown as D1Database
const paperActiveEnv = {
  DB: legacy,
  PAPER_DB: paperDb,
  MULTI_D1_ACTIVE_DOMAINS: 'paper',
}
assert.equal(databaseForTable(paperActiveEnv, 'paper_orders'), paperDb)
assert.equal(databaseForTable(paperActiveEnv, 'pending_buy_runs'), legacy)
assert.equal(databaseForTable(paperActiveEnv, 'exit_shadow_log'), legacy)
assert.equal(dataDomainRoutingContractReady('execution'), true)
assert.equal(dataDomainProjectionContractReady('execution'), true)
assert.equal(dataDomainRoutingContractReady('paper'), true)
assert.equal(dataDomainProjectionContractReady('paper'), true)
assert(LEGACY_CONTROL_PLANE_TABLES.has('data_domain_cutovers'))
const legacyControlDb = {} as D1Database
assert.equal(databaseForTable({ DB: legacyControlDb }, 'data_domain_cutovers'), legacyControlDb)
assert(!tablesForDataDomainShadowBackfill('ops').includes('data_domain_cutovers'))

assert.equal(MULTI_D1_STRICT_ROUTING_READY, false)
assert.equal(MULTI_D1_PROJECTION_CONTRACT_READY, false)
assert.equal(MULTI_D1_ROUTING_CONTRACT_GATES.direct_legacy_db_paths_closed, false)
assert.equal(MULTI_D1_ROUTING_CONTRACT_GATES.writer_quiescence_shared_epoch_cas, false)
assert.equal(MULTI_D1_PROJECTION_CONTRACT_GATES.typed_outbox_producers_wired, false)
assert.throws(
  () => databaseForDataDomain({ ...shadowEnv, MULTI_D1_STRICT: 'true' }, 'market'),
  /multi_d1_strict_active_domains_missing/,
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
