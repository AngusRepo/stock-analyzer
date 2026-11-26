import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DATA_DOMAINS, databaseForDataDomain, databaseForTable, LEGACY_CONTROL_PLANE_TABLES } from './dataDomainRegistry'
import {
  dataDomainControlPlaneDatabase,
  dataDomainControlPlaneLocation,
  optionalLegacyDatabase,
  verifiedDataDomainControlPlaneDatabase,
  requireLegacyDatabase,
  requireLegacyShadowSource,
} from './legacyDatabase'
import { inspectStorageAdmission } from './storageAdmissionControl'
import { buildOpsResourceAudit } from './opsRunbook'
import { capacityRunwayWarningPrefix, summarizeStorageCapacityRunway } from './storageHealthSeverity'
import { runStorageHealthCheck } from './artifactLifecycle'
import { runRetentionArchiveOnly } from './retentionArchiveOnly'
import { inspectLegacyLearningDeletionReadiness, LEGACY_HOT_ARCHIVE_DATASETS } from './learningTenYearRetentionReadiness'
import { tablesForDataDomainRouteReady } from './dataDomainRegistry'
import { RestD1Database } from '../node-runner/cloudflareRestBindings'

// D9 step 1: the Worker runs without the legacy stockvision-db binding.

class Statement {
  values: unknown[] = []
  constructor(private readonly db: MockDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async first<T>(): Promise<T | null> { this.db.reads.push(this.sql); return this.db.firstHandler(this) as T | null }
  async all<T>(): Promise<{ results: T[]; meta: Record<string, unknown> }> {
    this.db.reads.push(this.sql)
    return { results: this.db.allHandler(this) as T[], meta: this.db.queryMeta }
  }
  async run() { this.db.runs.push(this); return { success: true, meta: {} } }
}

class MockDb {
  constructor(readonly name: string) {}
  reads: string[] = []
  runs: Statement[] = []
  firstHandler: (statement: Statement) => unknown = () => null
  allHandler: (statement: Statement) => unknown[] = () => []
  queryMeta: Record<string, unknown> = { size_after: 1_000_000_000 }
  prepare(sql: string) { return new Statement(this, sql) }
  async batch(statements: Statement[]) { return statements.map(() => ({ success: true })) }
}

const db = (name: string) => new MockDb(name) as unknown as D1Database & MockDb
const ALL_DOMAINS = DATA_DOMAINS.join(',')

function splitEnv(overrides: Record<string, unknown> = {}) {
  return {
    MULTI_D1_ACTIVE_DOMAINS: ALL_DOMAINS,
    MULTI_D1_STRICT: 'true',
    CORE_DB: db('core'), MARKET_DB: db('market'), LEARNING_DB: db('learning'), OPS_DB: db('ops'),
    EXECUTION_DB: db('execution'), PAPER_DB: db('paper'), RESEARCH_DB: db('research'),
    ...overrides,
  } as any
}

function runtimeSources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) return runtimeSources(full)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

test('no runtime file reads env.DB except legacyDatabase.ts and the listed holdouts', () => {
  const allowed = new Set([
    'src/lib/legacyDatabase.ts',
  ])
  const offenders: string[] = []
  for (const file of runtimeSources('src')) {
    const rel = file.replaceAll('\\', '/')
    if (allowed.has(rel)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const pattern of LEGACY_BINDING_READS) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${rel}:${line}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

// env.DB / env?.DB, a cast `(env as any).DB`, an index `env['DB']`, and a
// destructured `{ DB } = env` (or `{ DB: db }`).
const LEGACY_BINDING_READS = [
  /\benv\??\.DB\b/g,
  /\(\s*(?:[\w$]+\.)*env\s+as\s+[^()]*\)\s*\??\.DB\b/g,
  /\benv\s*\??\.?\[\s*['"`]DB['"`]\s*\]/g,
  /\{(?:[^{}]*[\s,])?DB\s*(?=[,:}])[^{}]*\}\s*=\s*(?:await\s+)?(?:[\w$]+\.)*env\b/g,
]

test('the env.DB scan catches casts, index access and destructuring', () => {
  const hits = (code: string) => LEGACY_BINDING_READS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(code)
  })
  for (const code of [
    'const db = env.DB',
    'await c.env?.DB.prepare(sql)',
    'const db = (env as any).DB',
    'const db = (c.env as Bindings).DB',
    "const db = env['DB']",
    'const db = c.env["DB"]',
    'const { DB } = env',
    'const { KV, DB: legacy } = c.env',
    'const { DB, KV } = await this.env',
  ]) assert.ok(hits(code), code)
  for (const code of [
    'const db = env.OPS_DB',
    "const db = env['OPS_DB']",
    'const { OPS_DB } = env',
    'const { DB_NAME } = config',
    'return { DB: RestD1Database.optionalFromEnv() }',
  ]) assert.ok(!hits(code), code)
})

test('control-plane location: default legacy, explicit ops, anything else fails closed', () => {
  assert.equal(dataDomainControlPlaneLocation({}), 'legacy')
  assert.equal(dataDomainControlPlaneLocation({ DATA_DOMAIN_CONTROL_PLANE: ' Legacy ' }), 'legacy')
  assert.equal(dataDomainControlPlaneLocation({ DATA_DOMAIN_CONTROL_PLANE: 'ops' }), 'ops')
  assert.throws(() => dataDomainControlPlaneLocation({ DATA_DOMAIN_CONTROL_PLANE: 'opsdb' }), /data_domain_control_plane_invalid:opsdb/)
})

test('the control plane reads the configured database and never falls back', () => {
  const legacy = db('legacy'), ops = db('ops')
  assert.equal(dataDomainControlPlaneDatabase({ DB: legacy, OPS_DB: ops }), legacy)
  assert.equal(dataDomainControlPlaneDatabase({ DB: legacy, OPS_DB: ops, DATA_DOMAIN_CONTROL_PLANE: 'ops' }), ops)
  assert.equal(dataDomainControlPlaneDatabase({ OPS_DB: ops, DATA_DOMAIN_CONTROL_PLANE: 'ops' }), ops)
  // Legacy location without the binding must not read the stale Ops mirror.
  assert.throws(() => dataDomainControlPlaneDatabase({ OPS_DB: ops }), /legacy_db_binding_retired:data_domain_control_plane/)
  assert.throws(() => dataDomainControlPlaneDatabase({ DB: legacy, DATA_DOMAIN_CONTROL_PLANE: 'ops' }), /data_domain_control_plane_ops_binding_missing/)
})

test('control-plane tables route through the location var; control_revisions stays legacy-only', () => {
  const legacy = db('legacy')
  const legacyEnv = splitEnv({ DB: legacy })
  const opsEnv = splitEnv({ DB: legacy, DATA_DOMAIN_CONTROL_PLANE: 'ops' })
  for (const table of LEGACY_CONTROL_PLANE_TABLES) {
    if (table === 'data_domain_control_revisions') continue
    assert.equal(databaseForTable(legacyEnv, table), legacy, table)
    assert.equal(databaseForTable(opsEnv, table), opsEnv.OPS_DB, table)
  }
  assert.equal(databaseForTable(legacyEnv, 'data_domain_control_revisions'), legacy)
  assert.throws(() => databaseForTable(opsEnv, 'data_domain_control_revisions'), /legacy_shadow_machinery_retired/)
})

const opsControlPlane = (receipt: { complete_domains: number; epoch_domains: number; parity_domains: number }) => {
  const ops = db('ops')
  ops.firstHandler = (statement) => statement.sql.includes('AS complete_domains') ? receipt : null
  return ops
}

test('an Ops control plane without the copied cutover receipts fails closed', async () => {
  const legacy = db('legacy')
  // Legacy location: no verification query, unchanged behaviour.
  assert.equal(await verifiedDataDomainControlPlaneDatabase({ DB: legacy }), legacy)
  assert.equal(legacy.reads.length, 0)
  // The pre-copy Ops mirror measured on 11/4: 7 cutovers but 1 writer epoch, no table epochs, no parity.
  const stale = opsControlPlane({ complete_domains: 1, epoch_domains: 0, parity_domains: 0 })
  await assert.rejects(verifiedDataDomainControlPlaneDatabase({ DB: legacy, OPS_DB: stale, DATA_DOMAIN_CONTROL_PLANE: 'ops' }),
    /data_domain_control_plane_ops_unverified:complete=1:epoch_domains=0:parity_domains=0/)
  const noParity = opsControlPlane({ complete_domains: 7, epoch_domains: 7, parity_domains: 0 })
  await assert.rejects(verifiedDataDomainControlPlaneDatabase({ OPS_DB: noParity, DATA_DOMAIN_CONTROL_PLANE: 'ops' }),
    /data_domain_control_plane_ops_unverified:complete=7:epoch_domains=7:parity_domains=0/)
  const copied = opsControlPlane({ complete_domains: 7, epoch_domains: 7, parity_domains: 7 })
  const env = { OPS_DB: copied, DATA_DOMAIN_CONTROL_PLANE: 'ops' }
  assert.equal(await verifiedDataDomainControlPlaneDatabase(env, 1_000), copied)
  assert.equal(await verifiedDataDomainControlPlaneDatabase(env, 2_000), copied)
  assert.equal(copied.reads.length, 1, 'a verified Ops control plane is cached')
  await verifiedDataDomainControlPlaneDatabase(env, 1_000 + 300_001)
  assert.equal(copied.reads.length, 2, 'and re-verified after the TTL')
})

test('storage health on an unverified Ops control plane fails closed instead of auditing legacy as live', async () => {
  const legacy = db('legacy')
  const stale = opsControlPlane({ complete_domains: 1, epoch_domains: 0, parity_domains: 0 })
  await assert.rejects(runStorageHealthCheck(splitEnv({ DB: legacy, OPS_DB: stale, DATA_DOMAIN_CONTROL_PLANE: 'ops' })),
    /data_domain_control_plane_ops_unverified/)
  assert.ok(!legacy.reads.some((sql) => sql.includes('FROM strategy_decision_log')), 'no legacy full-table EXISTS')
})

test('runtime control-plane readers all go through the verified accessor', () => {
  const offenders: string[] = []
  for (const file of runtimeSources('src')) {
    const rel = file.replaceAll('\\', '/')
    if (rel === 'src/lib/legacyDatabase.ts' || rel === 'src/lib/dataDomainRegistry.ts') continue
    const source = fs.readFileSync(file, 'utf8')
    if (/(?<!verified)DataDomainControlPlaneDatabase\(|\bdataDomainControlPlaneDatabase\(/.test(source)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [])
})

test('the retired Fusion replay backfill skips instead of failing once legacy is unbound', () => {
  const source = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
  const body = source.slice(source.indexOf('async function enqueueS12ReplayBackfillTask'))
  assert.match(body, /const legacySource = optionalLegacyDatabase\(env\)\s*if \(!legacySource\) return 'skipped retired_fusion_maturity_backfill_legacy_source_retired'/)
  assert.doesNotMatch(body.slice(0, body.indexOf('for (const signalDate')), /requireLegacyDatabase/)
})

test('migration-era tools retire once the control plane is on Ops or the binding is gone', () => {
  const legacy = db('legacy')
  assert.equal(requireLegacyShadowSource({ DB: legacy }, 'shadow'), legacy)
  assert.throws(() => requireLegacyShadowSource({ DB: legacy, DATA_DOMAIN_CONTROL_PLANE: 'ops' }, 'shadow'),
    /legacy_shadow_machinery_retired:shadow:control_plane_ops/)
  assert.throws(() => requireLegacyShadowSource({}, 'shadow'), /legacy_db_binding_retired:shadow/)
  assert.throws(() => requireLegacyDatabase({}, 'probe'), /legacy_db_binding_retired:probe/)
  assert.equal(optionalLegacyDatabase({}), null)
})

test('domain routing and route-ready tables never need the legacy binding', () => {
  const env = splitEnv({ DATA_DOMAIN_CONTROL_PLANE: 'ops' })
  for (const domain of DATA_DOMAINS) assert.equal(databaseForDataDomain(env, domain), env[`${domain.toUpperCase()}_DB`], domain)
  for (const domain of DATA_DOMAINS) {
    const table = tablesForDataDomainRouteReady(domain)[0]
    assert.ok(databaseForTable(env, table), `${domain}.${table}`)
  }
  // A not-route-ready table fails closed instead of returning undefined.
  assert.throws(() => databaseForTable(env, 'stock_tags'), /legacy_db_binding_retired:table_not_route_ready:stock_tags/)
})

test('storage admission and the ops resource audit work without the legacy binding', async () => {
  const env = splitEnv({ DATA_DOMAIN_CONTROL_PLANE: 'ops' })
  const legacyOwned = await inspectStorageAdmission(env, 'legacy-evidence-migration')
  assert.equal(legacyOwned.status, 'unknown')
  assert.equal(legacyOwned.allowed, false)
  const learningOwned = await inspectStorageAdmission(env, 'strategy-learning')
  assert.equal(learningOwned.status, 'healthy')
  const kv = { list: async () => ({ keys: [] }) } as unknown as KVNamespace
  const audit = await buildOpsResourceAudit({ KV: kv })
  assert.equal(audit.success, true)
})

test('node-runner jobs start without CF_D1_DB_ID', () => {
  const saved = process.env.CF_D1_DB_ID
  delete process.env.CF_D1_DB_ID
  try {
    assert.equal(RestD1Database.optionalFromEnv(), undefined)
  } finally {
    if (saved != null) process.env.CF_D1_DB_ID = saved
  }
})

test('storage health runs with the control plane on Ops and no legacy binding', async () => {
  const ops = db('ops')
  ops.firstHandler = (statement) => {
    if (statement.sql.includes('AS complete_domains')) return { complete_domains: 7, epoch_domains: 7, parity_domains: 7 }
    if (statement.sql.includes('AS frozen_domains')) return { frozen_domains: 7 }
    if (statement.sql.includes('FROM allocator_ev_feature_snapshots')) return { row_count: 1600, date_count: 10 }
    if (statement.sql.includes('active_references')) return { active_references: 10, true_orphan_references: 0 }
    return { integrity_blocked: 0, cleanup_backlog_over_24h: 0 }
  }
  const env = splitEnv({ DATA_DOMAIN_CONTROL_PLANE: 'ops', OPS_DB: ops })
  const result = await runStorageHealthCheck(env)
  assert.equal(result.legacy_retention_audit, 'skipped_legacy_unbound')
  assert.ok(ops.reads.some((sql) => sql.includes('AS frozen_domains')), 'frozen receipt reads the Ops control plane')
  assert.ok(!result.capacity_runway.some((row) => row.domain === 'legacy'), 'no legacy capacity row once unbound')
})

const runwayRow = (domain: string, days: number | null) => ({
  domain, binding_name: `${domain.toUpperCase()}_DB`, utilization_pct: 80,
  forecast_status: 'ready', daily_growth_bytes: 10_000_000, projected_days_to_critical_90pct: days,
}) as any

test('runway summary labels rows with the health check alert decision; frozen legacy is reported only', () => {
  const health = {
    capacity_runway: [runwayRow('legacy', 3), runwayRow('learning', 12), runwayRow('market', 400), runwayRow('ops', null)],
    capacity_runway_alert_days: 30,
    // runStorageHealthCheck already left the frozen legacy row out of its decision.
    capacity_runway_alert_domains: ['learning'],
    legacy_capacity_role: 'frozen_rollback_source',
  } as any
  const summary = summarizeStorageCapacityRunway(health)
  assert.deepEqual(summary.alert_domains, ['learning'])
  assert.equal(summary.alert_days, 30)
  assert.deepEqual(summary.domains.find((row) => row.domain === 'legacy'),
    { domain: 'legacy', role: 'frozen_rollback_source', judged: false, days_to_90pct: 3, alert: false })
  assert.equal(summary.domains.find((row) => row.domain === 'ops')!.alert, false)
  // Even a mislabelled alert list cannot make the frozen source alert.
  assert.deepEqual(summarizeStorageCapacityRunway({ ...health, capacity_runway_alert_domains: ['legacy'] }).alert_domains, [])
  // Before the cutover is complete the legacy DB is live and follows the health decision.
  const live = summarizeStorageCapacityRunway({ ...health, legacy_capacity_role: 'active_source', capacity_runway_alert_domains: ['legacy', 'learning'] })
  assert.deepEqual(live.alert_domains, ['legacy', 'learning'])
  assert.equal(capacityRunwayWarningPrefix(summary), 'warning capacity_runway_alert=learning ')
  assert.equal(capacityRunwayWarningPrefix({ ...summary, alert_domains: [] }), '')
})

test('the runway rows are echoed once and the system-log warning stays with storage-health-check', async () => {
  const ops = db('ops')
  ops.firstHandler = (statement) => {
    if (statement.sql.includes('AS complete_domains')) return { complete_domains: 7, epoch_domains: 7, parity_domains: 7 }
    if (statement.sql.includes('AS frozen_domains')) return { frozen_domains: 7 }
    if (statement.sql.includes('FROM allocator_ev_feature_snapshots')) return { row_count: 1600, date_count: 10 }
    if (statement.sql.includes('active_references')) return { active_references: 10, true_orphan_references: 0 }
    return { integrity_blocked: 0, cleanup_backlog_over_24h: 0 }
  }
  const health = await runStorageHealthCheck(splitEnv({ DATA_DOMAIN_CONTROL_PLANE: 'ops', OPS_DB: ops }))
  const summary = summarizeStorageCapacityRunway(health)
  assert.equal(summary.domains.length, health.capacity_runway.length)
  assert.ok(JSON.stringify(summary).length < 1000, 'compact runway summary')
  assert.equal(ops.runs.length, 0, 'summarizing writes nothing')
})

test('storage-capacity-report judges the runway and marks the frozen legacy row', () => {
  const tasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
  const start = tasks.indexOf("'storage-capacity-report': async () => {")
  const body = tasks.slice(start, tasks.indexOf('\n    },', start))
  assert.match(body, /const runway = summarizeStorageCapacityRunway\(health\)/)
  assert.match(body, /capacityRunwayWarningPrefix\(runway\)/)
  assert.match(body, /runway=\$\{JSON\.stringify\(runway\)\}/)
  // The health echo drops the runway rows the summary already carries.
  assert.match(body, /capacity_runway: _runwayRows,[\s\S]*capacity_runway_alert_domains: _runwayAlertDomains,[\s\S]*\.\.\.healthEcho[\s\S]*\} = health/)
  assert.match(body, /health=\$\{JSON\.stringify\(healthEcho\)\}/)
  assert.doesNotMatch(body, /writeSystemLog|reportStorageCapacityRunway/)
  assert.match(body, /role: row\.domain === 'legacy' && health\.legacy_capacity_role === 'frozen_rollback_source'/)
})

function archiveOnlyOps(cursorStatus: string | null = null) {
  const ops = db('ops')
  ops.firstHandler = (statement) => statement.sql.includes('FROM data_retention_policies')
    ? { policy_id: 'legacy_hot_r2_v1', hot_retention_days: 90, cold_retention_days: null,
        archive_store: 'r2', hard_reference_protected: 1, status: 'active' }
    : statement.sql.includes('FROM data_retention_cursors') && cursorStatus
      ? { policy_id: 'legacy_hot_r2_v1', dataset_id: statement.values[1], status: cursorStatus,
          cursor_date: null, cursor_key: null, cycle: 1, backlog_remaining: 0 }
      : null
  ;(ops as MockDb).batch = async (statements: Statement[]) => { ops.runs.push(...statements); return statements.map(() => ({ success: true })) }
  return ops
}

function cursorWrites(ops: MockDb): unknown[] {
  return ops.runs.filter((statement) => statement.sql.includes('INSERT INTO data_retention_cursors'))
    .map((statement) => statement.values[2])
}

function legacySkipReasons(ops: MockDb): string[] {
  return ops.runs.filter((statement) => statement.sql.includes('data_retention_run_items'))
    .flatMap((statement) => statement.values.filter((value): value is string => typeof value === 'string' && value.includes('"reason"')))
    .map((evidence) => JSON.parse(evidence).reason)
}

// Frozen = every legacy source domain is in writer cutover on the legacy DB itself
// (legacyWritersCutOver in retentionArchiveOnly.ts, the same receipt as the watermark).
function legacySource(cutoverDomains: number) {
  const legacy = db('legacy')
  legacy.firstHandler = (statement) => statement.sql.includes('AS cutover') ? { cutover: cutoverDomains } : null
  return legacy
}
const isCutoverReceipt = (sql: string) => sql.includes('AS cutover')

test('retention archive-only never rescans a frozen legacy dataset the final archive completed', async () => {
  // Before the final archive a frozen source keeps the watermark scan (only rows newly crossing the cutoff).
  const scanning = legacySource(3)
  await runRetentionArchiveOnly(splitEnv({ DB: scanning, OPS_DB: archiveOnlyOps('running'), ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'] })
  assert.ok(scanning.reads.some((sql) => sql.includes('FROM screener_funnel_items i')))

  // After it, cycle_complete reset the cursor position; a normal run must not rescan from the table head.
  const legacy = legacySource(3)
  const ops = archiveOnlyOps('cycle_complete')
  const result = await runRetentionArchiveOnly(splitEnv({ DB: legacy, OPS_DB: ops, ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'] })
  assert.equal(result.status, 'success')
  assert.equal(result.scanned_rows, 0)
  assert.equal(result.backlog_remaining, false)
  // One cutover receipt read, never a scan of screener_funnel_items or the other legacy tables.
  assert.deepEqual(legacy.reads.map(isCutoverReceipt), [true])
  const reasons = legacySkipReasons(ops)
  assert.ok(reasons.length >= 7 && reasons.every((reason) => reason === 'legacy_final_archive_complete'), reasons.join(','))
  // The skip leaves every cursor (position, status, backlog) as it was.
  assert.deepEqual(cursorWrites(ops), [])
})

test('the one-time final archive takes the frozen legacy datasets to cycle_complete, then stops scanning', async () => {
  const legacy = legacySource(3)
  const ops = archiveOnlyOps('running')
  const result = await runRetentionArchiveOnly(splitEnv({ DB: legacy, OPS_DB: ops, ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'], legacyFinalArchive: true })
  assert.equal(result.status, 'success')
  assert.ok(legacy.reads.some((sql) => sql.includes('FROM screener_funnel_items i')), 'final archive scans the frozen source')
  // The hot window does not apply to a frozen source: every row is in scope.
  assert.ok(legacy.reads.filter((sql) => sql.includes('FROM screener_funnel_items i')).length === 1)
  assert.ok(ops.runs.some((statement) => statement.values.some((value) =>
    typeof value === 'string' && value.includes('"cutoff_date":"9999-12-31"'))))
  // No watermark on the final archive: a short page closes the cycle instead.
  assert.ok(!ops.runs.some((statement) => statement.values.some((value) =>
    typeof value === 'string' && value.includes('frozen_source_watermark'))))
  assert.deepEqual(cursorWrites(ops), LEGACY_HOT_ARCHIVE_DATASETS.map(() => 'cycle_complete'))

  const done = legacySource(3)
  const doneOps = archiveOnlyOps('cycle_complete')
  await runRetentionArchiveOnly(splitEnv({ DB: done, OPS_DB: doneOps, ARTIFACTS: {} }),
    { businessDate: '2026-11-06', policyIds: ['legacy_hot_r2_v1'], legacyFinalArchive: true })
  assert.deepEqual(done.reads.map(isCutoverReceipt), [true])
  assert.ok(legacySkipReasons(doneOps).every((reason) => reason === 'legacy_final_archive_complete'))
  assert.deepEqual(cursorWrites(doneOps), [])

  // A source that still receives writes cannot be closed out.
  const live = legacySource(2)
  const liveOps = archiveOnlyOps('running')
  const refused = await runRetentionArchiveOnly(splitEnv({ DB: live, OPS_DB: liveOps, ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'], legacyFinalArchive: true })
  assert.equal(refused.status, 'error')
  assert.match(String(refused.policies[0].error), /legacy_final_archive_requires_frozen_source/)
  assert.ok(!live.reads.some((sql) => sql.includes('FROM screener_funnel_items')))
  assert.deepEqual(cursorWrites(liveOps), [])
})

test('legacy deletion readiness requires every legacy_hot_r2_v1 dataset at cycle_complete', async () => {
  assert.equal(LEGACY_HOT_ARCHIVE_DATASETS.length, 7)
  const readiness = async (completed: readonly string[]) => {
    const ops = db('ops')
    ops.allHandler = (statement) => statement.sql.includes('FROM data_retention_cursors')
      ? LEGACY_HOT_ARCHIVE_DATASETS.map((dataset_id) => ({ dataset_id, status: completed.includes(dataset_id) ? 'cycle_complete' : 'running' }))
      : []
    return inspectLegacyLearningDeletionReadiness(db('control'), db('learning'), '2026-12-31', ops)
  }
  const pending = await readiness(LEGACY_HOT_ARCHIVE_DATASETS.slice(1))
  assert.ok(pending.blockers.includes('legacy_hot_r2_v1_final_archive_not_cycle_complete'))
  assert.deepEqual(pending.evidence.legacy_hot_final_archive.pending_datasets, [LEGACY_HOT_ARCHIVE_DATASETS[0]])
  assert.equal(pending.technical_ready_for_explicit_approval, false)
  const complete = await readiness(LEGACY_HOT_ARCHIVE_DATASETS)
  assert.ok(!complete.blockers.includes('legacy_hot_r2_v1_final_archive_not_cycle_complete'))
  assert.deepEqual(complete.evidence.legacy_hot_final_archive.pending_datasets, [])
})

test('retention archive-only still archives legacy rows before the cutover completes, and skips once unbound', async () => {
  const live = legacySource(2)
  await runRetentionArchiveOnly(splitEnv({ DB: live, OPS_DB: archiveOnlyOps(), ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'] })
  assert.ok(live.reads.some((sql) => sql.includes('FROM screener_funnel_items i')), 'an active legacy source is scanned')

  const ops = archiveOnlyOps()
  const unbound = await runRetentionArchiveOnly(splitEnv({ OPS_DB: ops, ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'] })
  assert.equal(unbound.status, 'success')
  assert.ok(legacySkipReasons(ops).every((reason) => reason === 'legacy_db_binding_retired'))
})

test('a failed cutover read never reopens a legacy dataset the final archive completed', async () => {
  const legacy = db('legacy')
  legacy.firstHandler = (statement) => {
    if (statement.sql.includes('AS cutover')) throw new Error('D1 DB is overloaded')
    return null
  }
  const ops = archiveOnlyOps('cycle_complete')
  const result = await runRetentionArchiveOnly(splitEnv({ DB: legacy, OPS_DB: ops, ARTIFACTS: {} }),
    { businessDate: '2026-11-05', policyIds: ['legacy_hot_r2_v1'] })
  assert.equal(result.status, 'success')
  assert.equal(result.scanned_rows, 0)
  assert.ok(!legacy.reads.some((sql) => sql.includes('FROM screener_funnel_items')))
  const reasons = legacySkipReasons(ops)
  assert.ok(reasons.length >= 7 && reasons.every((reason) => reason === 'legacy_final_archive_complete'), reasons.join(','))
  assert.deepEqual(cursorWrites(ops), [])
})
