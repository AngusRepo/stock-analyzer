import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runStorageHealthCheck, type StorageHealthResult } from './artifactLifecycle'
import { tablesForDataDomainRouteReady } from './dataDomainRegistry'
import { classifyStorageHealth, reportStorageHealthSeverity } from './storageHealthSeverity'

// D7a A-2: a live domain in the drain band (75-90%) is a warning, not an unhealthy storage check.

class Statement {
  values: unknown[] = []
  constructor(private readonly db: MockDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async first<T>(): Promise<T | null> { return this.db.firstHandler(this) as T | null }
  async all<T>(): Promise<{ results: T[]; meta: Record<string, unknown> }> {
    return { results: this.db.allHandler(this) as T[], meta: this.db.queryMeta }
  }
  async run() { this.db.runs.push(this); return { success: true } }
}

class MockDb {
  runs: Statement[] = []
  firstHandler: (statement: Statement) => unknown = () => null
  allHandler: (statement: Statement) => unknown[] = () => []
  queryMeta: Record<string, unknown> = { size_after: 1 }
  prepare(sql: string) { return new Statement(this, sql) }
  async batch(statements: Statement[]) { return statements.map(() => ({ success: true })) }
}

function readyDomainDb(baseline: string, tables: string[]): MockDb {
  const db = new MockDb()
  db.allHandler = (statement) => {
    if (statement.sql.includes('FROM d1_migrations')) return [{ name: baseline }]
    if (statement.sql.includes('FROM sqlite_schema')) return tables.map((name) => ({ name }))
    return []
  }
  return db
}

function legacyDb(overrides: Record<string, unknown> = {}): MockDb {
  const db = new MockDb()
  db.queryMeta = { size_after: 1_000_000_000 }
  db.firstHandler = (statement) => {
    if (statement.sql.includes('AS frozen_domains')) return { frozen_domains: 7 }
    if (statement.sql.includes('artifact_cleanup_dlq')) return { count: overrides.dlq ?? 0 }
    if (statement.sql.includes('FROM allocator_ev_feature_snapshots')) return { row_count: 1600, date_count: 10 }
    if (statement.sql.includes('active_references')) return { active_references: 10, true_orphan_references: 0 }
    if (statement.sql.includes('AS backlog_cohorts')) return { backlog_cohorts: 0, progress_24h: 0 }
    return { integrity_blocked: overrides.integrity ?? 0, cleanup_backlog_over_24h: 0 }
  }
  return db
}

function sizedDb(bytes: number): MockDb {
  const db = new MockDb()
  db.queryMeta = { size_after: bytes }
  return db
}

const split = {
  EXECUTION_DB: readyDomainDb('0001_execution_baseline.sql', tablesForDataDomainRouteReady('execution')) as any,
  PAPER_DB: readyDomainDb('0001_paper_baseline.sql', tablesForDataDomainRouteReady('paper')) as any,
}

async function health(learningBytes: number, legacy = legacyDb()): Promise<StorageHealthResult> {
  return runStorageHealthCheck({ DB: legacy as any, LEARNING_DB: sizedDb(learningBytes) as any, ...split })
}

test('a learning domain in the drain band is a warning, not unhealthy', async () => {
  const result = await health(8_201_020_000)
  assert.equal(result.healthy, false)
  assert.deepEqual(result.blocking_capacity_domains, ['learning'])
  assert.deepEqual(classifyStorageHealth(result), { severity: 'warning', drain_domains: ['learning'], runway_alert_domains: [] })
})

test('a live domain at 90% or more stays unhealthy', async () => {
  const result = await health(9_100_000_000)
  assert.equal(classifyStorageHealth(result).severity, 'unhealthy')
})

test('drain plus any other failed gate stays unhealthy', async () => {
  assert.equal(classifyStorageHealth(await health(8_201_020_000, legacyDb({ dlq: 1 }))).severity, 'unhealthy')
  assert.equal(classifyStorageHealth(await health(8_201_020_000, legacyDb({ integrity: 2 }))).severity, 'unhealthy')
  // Without drain the same gates fail `healthy` on their own, and the classifier agrees.
  for (const overrides of [{ dlq: 1 }, { integrity: 2 }]) {
    const result = await health(1_000_000_000, legacyDb(overrides))
    assert.equal(result.healthy, false)
    assert.equal(classifyStorageHealth(result).severity, 'unhealthy')
  }
})

test('a frozen legacy source over 90% does not block, and a healthy result is healthy', async () => {
  const legacy = legacyDb()
  legacy.queryMeta = { size_after: 9_125_700_000 }
  const result = await health(1_000_000_000, legacy)
  assert.equal(result.healthy, true)
  assert.equal(classifyStorageHealth(result).severity, 'healthy')
})

test('a reported runway alert turns a healthy result into a warning', async () => {
  const result = { ...(await health(1_000_000_000)), capacity_runway_alert_domains: ['learning'] } as StorageHealthResult
  assert.deepEqual(classifyStorageHealth(result), { severity: 'warning', drain_domains: [], runway_alert_domains: ['learning'] })
})

test('a warning is written to the ops system log; an unhealthy result is left to the caller', async () => {
  const ops = new MockDb()
  const warnings: unknown[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    const prefix = await reportStorageHealthSeverity({ DB: ops as any }, 'storage-health-check',
      await health(8_201_020_000))
    assert.equal(prefix, 'warning capacity_drain=learning ')
    assert.equal(ops.runs.length, 1)
    assert.match(ops.runs[0].sql, /INSERT INTO system_logs/)
    assert.equal(ops.runs[0].values[0], 'warn')
    assert.equal(ops.runs[0].values[1], 'storage-health-check')
    assert.equal(warnings.length, 1)
    assert.equal(await reportStorageHealthSeverity({ DB: ops as any }, 'storage-health-check',
      await health(9_100_000_000)), null)
    assert.equal(await reportStorageHealthSeverity({ DB: ops as any }, 'storage-health-check',
      await health(1_000_000_000)), '')
    assert.equal(ops.runs.length, 1)
  } finally {
    console.warn = warn
  }
})

test('the classifier mirrors every gate of `healthy` (update storageHealthSeverity.ts when this changes)', () => {
  const source = readFileSync(new URL('./artifactLifecycle.ts', import.meta.url), 'utf8')
  const expression = source.match(/\n {4}healthy: ([\s\S]*?),\n {4}integrity_blocked:/)?.[1].replace(/\s+/g, ' ')
  assert.equal(expression, 'integrityBlocked === 0 && backlog === 0 && dlqPending === 0 && '
    + 'allocatorSnapshotRows > 0 && allocatorSnapshotDates > 0 && '
    + 'allocatorSnapshotIncompleteRuns === 0 && allocatorSnapshotStagingOrphans === 0 && '
    + 'artifactHardRefDrift === 0 && artifactTrueOrphanReferences === 0 && domainSchemaReady && '
    + '(expectedLineageDate == null || (executionLineageReady && paperLineageReady)) && '
    + '(!legacyRetentionStalled || legacyFrozenRollbackSource) && '
    + 'capacityError == null && capacityRows.length > 0 && !capacityDrain')
})

test('the storage-health-check task routes its result through the severity report', () => {
  const tasks = readFileSync(new URL('./adminTriggerWorkerDomainTasks.ts', import.meta.url), 'utf8')
  for (const task of ['storage-health-check', 'storage-health-gate']) {
    const body = tasks.slice(tasks.indexOf(`'${task}': async () => {`), tasks.indexOf('\n    },', tasks.indexOf(`'${task}': async () => {`)))
    assert.match(body, new RegExp(`reportStorageHealthSeverity\\(c\\.env, '${task}', result\\)`))
    assert.match(body, /if \(warning == null\) throw new Error/)
    assert.doesNotMatch(body, /if \(!result\.healthy\)/)
  }
})
