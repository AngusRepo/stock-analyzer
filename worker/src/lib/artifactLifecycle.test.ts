import assert from 'node:assert/strict'
import {
  promoteCanonicalRun,
  retainArtifactHardReference,
  releaseArtifactHardReferencesByOwner,
  registerPipelineRun,
  runD1EvidenceScrub,
  runR2RetentionSweep,
  runStorageHealthCheck,
  STORAGE_LIFECYCLE_SCHEDULE,
  writeEvidenceArtifact,
} from './artifactLifecycle'

class Statement {
  values: unknown[] = []
  constructor(private readonly db: MockDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async first<T>(): Promise<T | null> { return this.db.first(this) as T | null }
  async all<T>(): Promise<{ results: T[]; meta: Record<string, unknown> }> {
    return { results: this.db.all(this) as T[], meta: this.db.queryMeta }
  }
  async run(): Promise<{ success: true }> { this.db.runs.push(this); return { success: true } }
}

class MockDb {
  runs: Statement[] = []
  batches: Statement[][] = []
  firstHandler: (statement: Statement) => unknown = () => null
  allHandler: (statement: Statement) => unknown[] = () => []
  batchHandler: (statements: Statement[]) => Array<{ success: boolean; error?: string }> =
    (statements) => statements.map(() => ({ success: true }))
  queryMeta: Record<string, unknown> = { size_after: 1 }
  prepare(sql: string) { return new Statement(this, sql) }
  first(statement: Statement) { return this.firstHandler(statement) }
  all(statement: Statement) { return this.allHandler(statement) }
  async batch(statements: Statement[]) {
    this.batches.push(statements)
    return this.batchHandler(statements)
  }
}

class MockR2 {
  objects = new Map<string, string>()
  deleted: string[] = []
  async put(key: string, body: string) { this.objects.set(key, body) }
  async get(key: string) {
    const body = this.objects.get(key)
    return body == null ? null : { text: async () => body }
  }
  async delete(key: string) { this.deleted.push(key); this.objects.delete(key) }
}

async function testR2FirstWriteVerifiesBeforeManifest(): Promise<void> {
  const db = new MockDb()
  const r2 = new MockR2()
  const manifest = await writeEvidenceArtifact({ DB: db as any, ARTIFACTS: r2 as any }, {
    domain: 'strategy',
    businessDate: '2026-07-14',
    producerRunId: 'strategy-2026-07-14',
    retentionClass: 'canonical_model_evidence',
    schemaVersion: 'strategy-evidence-v1',
    payload: { rows: [{ symbol: '2330', matched: true }] },
    rowCount: 1,
  })

  assert.equal(manifest.status, 'ready')
  assert.equal(manifest.retention_class, 'canonical_model_evidence')
  assert.match(manifest.checksum, /^sha256:/)
  assert.equal(r2.objects.has(manifest.r2_key), true)
  assert.equal(db.runs.length, 1)
  assert.match(db.runs[0].sql, /INSERT INTO run_artifacts/)
  assert.match(db.runs[0].sql, /ON CONFLICT\(artifact_id\) DO UPDATE/)
  assert.doesNotMatch(db.runs[0].sql, /hard_ref_count=excluded/)
}

async function testIdenticalRunBecomesReused(): Promise<void> {
  const db = new MockDb()
  db.firstHandler = (statement) => statement.sql.includes('FROM pipeline_runs')
    ? { run_id: 'existing-run' }
    : null
  const result = await registerPipelineRun(db as any, {
    runId: 'rerun',
    logicalRunKey: 'strategy:2026-07-14:TW:production:materialize',
    domain: 'strategy',
    businessDate: '2026-07-14',
    stage: 'materialize',
    inputFingerprint: 'sha256:same',
    codeVersion: 'abc',
    configVersion: 'v1',
  })

  assert.equal(result.status, 'reused')
  assert.equal(result.reused_from_run_id, 'existing-run')
}

async function testContentAddressDoesNotDuplicateAcrossRunIds(): Promise<void> {
  const db = new MockDb()
  const r2 = new MockR2()
  const base = {
    domain: 'screener',
    businessDate: '2026-07-14',
    retentionClass: 'canonical_model_evidence' as const,
    schemaVersion: 'screener-v2',
    payload: { rows: [{ symbol: '6712', score: 88 }] },
    rowCount: 1,
  }
  const first = await writeEvidenceArtifact({ DB: db as any, ARTIFACTS: r2 as any }, {
    ...base,
    producerRunId: 'first-run',
  })
  const rerun = await writeEvidenceArtifact({ DB: db as any, ARTIFACTS: r2 as any }, {
    ...base,
    producerRunId: 'manual-rerun',
  })

  assert.equal(rerun.artifact_id, first.artifact_id)
  assert.equal(rerun.r2_key, first.r2_key)
  assert.equal(r2.objects.size, 1)
}

async function testCanonicalPromotionSupersedesOnlyAfterVerifiedArtifact(): Promise<void> {
  const db = new MockDb()
  db.firstHandler = (statement) => {
    if (statement.sql.includes('FROM pipeline_runs')) return { status: 'ready' }
    if (statement.sql.includes('FROM run_artifacts')) return { status: 'ready', checksum_verified_at: '2026-07-14T01:00:00Z' }
    if (statement.sql.includes('FROM canonical_run_heads')) return { run_id: 'old-run' }
    return null
  }

  const result = await promoteCanonicalRun(db as any, 'screener:2026-07-14', 'new-run', 'artifact-1')

  assert.equal(result.previous_run_id, 'old-run')
  assert.equal(db.batches.length, 1)
  assert.equal(db.batches[0].length, 5)
  assert.match(db.batches[0][0].sql, /status='superseded'/)
  assert.match(db.batches[0][1].sql, /status='canonical'/)
  assert.match(db.batches[0][3].sql, /artifact_hard_references/)
  assert.match(db.batches[0][4].sql, /hard_ref_count=/)
}

async function testHardReferenceEdgesAreReachabilitySourceOfTruth(): Promise<void> {
  const db = new MockDb()
  await retainArtifactHardReference(db as any, {
    artifactId: 'artifact-1',
    ownerType: 'strategy_decision_evidence_batch',
    ownerId: 'batch-1',
  })
  assert.equal(db.batches.length, 1)
  assert.match(db.batches[0][0].sql, /INSERT INTO artifact_hard_references/)
  assert.match(db.batches[0][1].sql, /SELECT COUNT\(\*\) FROM artifact_hard_references/)

  db.allHandler = () => [{ artifact_id: 'artifact-1' }]
  const released = await releaseArtifactHardReferencesByOwner(db as any, {
    ownerType: 'strategy_decision_evidence_batch',
    ownerId: 'batch-1',
  })
  assert.equal(released, 1)
  assert.equal(db.batches.length, 2)
  assert.match(db.batches[1][0].sql, /SET active=0/)
}

async function testRetentionSweepPreservesMetadataAfterPayloadDelete(): Promise<void> {
  const db = new MockDb()
  const r2 = new MockR2()
  r2.objects.set('evidence/expired.json', '{}')
  db.allHandler = () => [{ artifact_id: 'expired', r2_key: 'evidence/expired.json' }]

  const result = await runR2RetentionSweep({ DB: db as any, ARTIFACTS: r2 as any }, {
    now: '2035-07-14T00:00:00Z',
  })

  assert.deepEqual(result, { candidates: 1, deleted: 1, failed: 0, errors: [] })
  assert.deepEqual(r2.deleted, ['evidence/expired.json'])
  assert.match(db.runs[0].sql, /status='payload_deleted'/)
  assert.doesNotMatch(db.runs[0].sql, /DELETE FROM run_artifacts/)
}

async function testD1EvidenceScrubBatchesVerifiedRowsAtomically(): Promise<void> {
  const db = new MockDb()
  const selects: Statement[] = []
  db.allHandler = (statement) => {
    selects.push(statement)
    return statement.sql.includes("q.status='failed'") ? [] : Array.from({ length: 60 }, (_, index) => ({
    scrub_id: `scrub-${index}`,
    artifact_id: `artifact-${index}`,
    target_table: 'screener_funnel_items',
    target_pk_column: 'id',
    target_pk_value: String(index + 1),
    target_column: 'evidence',
    replacement_json: JSON.stringify({ artifact_id: `artifact-${index}` }),
    artifact_status: 'ready',
    checksum_verified_at: '2026-07-14T01:00:00Z',
    }))
  }

  const result = await runD1EvidenceScrub({ DB: db as any }, { limit: 1000 })

  assert.deepEqual(result, { candidates: 60, scrubbed: 60, failed: 0, blocked: 0, errors: [] })
  assert.deepEqual(db.batches.map(batch => batch.length), [50, 50, 20])
  assert.equal(db.runs.length, 0)
  assert.equal(selects.length, 2)
  assert.match(selects[0].sql, /q\.status='failed' AND q\.next_attempt_at <= \?/)
  assert.match(selects[1].sql, /q\.status='pending' AND q\.next_attempt_at IS NULL/)
  assert.equal(selects.some(statement => statement.sql.includes("status IN ('pending','failed')")), false)
}

async function testD1EvidenceScrubBisectsFailedBatchInsteadOfRetryingEveryRow(): Promise<void> {
  const db = new MockDb()
  db.allHandler = (statement) => statement.sql.includes("q.status='failed'") ? [] : Array.from({ length: 25 }, (_, index) => ({
    scrub_id: `scrub-${index}`,
    artifact_id: `artifact-${index}`,
    target_table: 'screener_funnel_items',
    target_pk_column: 'id',
    target_pk_value: String(index + 1),
    target_column: 'evidence',
    replacement_json: JSON.stringify({ artifact_id: `artifact-${index}` }),
    artifact_status: 'ready',
    checksum_verified_at: '2026-07-14T01:00:00Z',
  }))
  db.batchHandler = (statements) => {
    const hasMalformedRow = statements.some(statement => statement.values.includes('13'))
    if (hasMalformedRow) throw new Error('malformed legacy row')
    return statements.map(() => ({ success: true }))
  }

  const result = await runD1EvidenceScrub({ DB: db as any }, { limit: 1000 })

  assert.equal(result.candidates, 25)
  assert.equal(result.scrubbed, 24)
  assert.equal(result.failed, 1)
  assert.equal(result.blocked, 0)
  assert.match(result.errors[0], /scrub-12:malformed legacy row/)
  assert.equal(db.runs.length, 1)
  assert.ok(db.batches.length < 12, `expected binary isolation, got ${db.batches.length} batches`)
  assert.equal(
    db.batches.filter(batch => batch.length === 2).length,
    1,
    'only the isolated malformed row should require a singleton batch',
  )
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

const executionDomainDb = readyDomainDb('0001_execution_baseline.sql', [
  'broker_execution_intents', 'broker_execution_legs', 'broker_execution_events', 'risk_audit_log',
])
const paperDomainDb = readyDomainDb('0001_paper_baseline.sql', [
  'debate_memory', 'decision_logs', 'exit_shadow_log', 'paper_accounts', 'paper_orders',
  'paper_positions', 'paper_settlements', 'paper_daily_snapshots', 'paper_execution_events',
  'paper_order_intents', 'paper_exit_intents', 'paper_challenger_candidates',
  'paper_challenger_daily_metrics', 'paper_decision_attribution', 'pending_buy_filter_audit',
  'pending_buy_items', 'pending_buy_runs', 'promotion_audit_events',
])

async function testStorageHealthCheckUsesD1ResultSizeAndReportsTruthfulScope(): Promise<void> {
  const healthyDb = new MockDb()
  healthyDb.queryMeta = { size_after: 7_000_000_000 }
  healthyDb.firstHandler = (statement) => {
    if (statement.sql.includes('artifact_cleanup_dlq')) return { count: 0 }
    if (statement.sql.includes('FROM allocator_ev_feature_snapshots')) return { row_count: 1600, date_count: 10 }
    if (statement.sql.includes('active_references')) return { active_references: 1998, true_orphan_references: 0 }
    if (statement.sql.includes('AS backlog_cohorts')) return { backlog_cohorts: 7, progress_24h: 10 }
    return { integrity_blocked: 0, cleanup_backlog_over_24h: 0 }
  }
  const splitBindings = { EXECUTION_DB: executionDomainDb as any, PAPER_DB: paperDomainDb as any }
  const healthy = await runStorageHealthCheck({ DB: healthyDb as any, ...splitBindings })
  assert.equal(healthy.healthy, true)
  assert.equal(healthy.enforcement_scope, 'scheduler_and_producer_admission')
  assert.equal(healthy.admission_control, true)
  assert.equal(healthy.blocks_storage_producers, true)
  assert.equal(healthy.blocks_trading_path, false)
  assert.equal(healthy.artifact_active_references, 1998)
  assert.equal(healthy.artifact_true_orphan_references, 0)
  assert.equal(healthy.domain_schema.every((row) => row.ready), true)
  assert.equal(healthy.d1_bytes, 7_000_000_000)
  assert.equal(healthy.allocator_ev_snapshot_dates, 10)
  assert.equal(healthy.legacy_retention_stalled, false)

  const overCapacityDb = new MockDb()
  overCapacityDb.queryMeta = { size_after: 8_864_489_472 }
  overCapacityDb.firstHandler = healthyDb.firstHandler
  const overCapacity = await runStorageHealthCheck({ DB: overCapacityDb as any, ...splitBindings })
  assert.equal(overCapacity.healthy, false)
  assert.equal(overCapacity.d1_utilization, 0.8864489472)

  const frozenLegacyDb = new MockDb()
  frozenLegacyDb.queryMeta = { size_after: 8_864_489_472 }
  frozenLegacyDb.firstHandler = (statement) => statement.sql.includes('AS frozen_domains')
    ? { frozen_domains: 7 }
    : healthyDb.firstHandler(statement)
  const frozenLegacy = await runStorageHealthCheck({ DB: frozenLegacyDb as any, ...splitBindings })
  assert.equal(frozenLegacy.healthy, true)
  assert.equal(frozenLegacy.legacy_capacity_role, 'frozen_rollback_source')
  assert.deepEqual(frozenLegacy.blocking_capacity_domains, [])

  const criticalLearningDb = new MockDb()
  criticalLearningDb.queryMeta = { size_after: 8_864_489_472 }
  const activeCritical = await runStorageHealthCheck({
    DB: frozenLegacyDb as any,
    LEARNING_DB: criticalLearningDb as any,
    ...splitBindings,
  })
  assert.equal(activeCritical.healthy, false)
  assert.equal(activeCritical.legacy_capacity_role, 'frozen_rollback_source')
  assert.deepEqual(activeCritical.blocking_capacity_domains, ['learning'])

  const missingAllocatorDb = new MockDb()
  missingAllocatorDb.queryMeta = { size_after: 7_000_000_000 }
  missingAllocatorDb.firstHandler = (statement) => {
    if (statement.sql.includes('artifact_cleanup_dlq')) return { count: 0 }
    if (statement.sql.includes('active_references')) return { active_references: 0, true_orphan_references: 0 }
    if (statement.sql.includes('FROM allocator_ev_feature_snapshots')) return { row_count: 0, date_count: 0 }
    if (statement.sql.includes('AS backlog_cohorts')) return { backlog_cohorts: 0, progress_24h: 0 }
    return { integrity_blocked: 0, cleanup_backlog_over_24h: 0 }
  }
  const missingAllocator = await runStorageHealthCheck({ DB: missingAllocatorDb as any, ...splitBindings })
  assert.equal(missingAllocator.healthy, false)
  assert.equal(missingAllocator.allocator_ev_snapshot_rows, 0)

  const unknownDb = new MockDb()
  unknownDb.queryMeta = {}
  unknownDb.firstHandler = healthyDb.firstHandler
  const unknown = await runStorageHealthCheck({ DB: unknownDb as any, ...splitBindings })
  assert.equal(unknown.healthy, false)
  assert.equal(unknown.d1_bytes, null)
}

async function main(): Promise<void> {
  assert.equal(STORAGE_LIFECYCLE_SCHEDULE.some((row) => row.task === 'storage-health-check'), true)
  assert.equal(STORAGE_LIFECYCLE_SCHEDULE.some((row) => String(row.task) === 'storage-health-gate'), false)
  for (const retired of ['legacy-evidence-migration', 'd1-evidence-scrub', 'cleanup-dlq-replay']) {
    assert.equal(STORAGE_LIFECYCLE_SCHEDULE.some((row) => row.task === retired), false)
  }
  await testR2FirstWriteVerifiesBeforeManifest()
  await testIdenticalRunBecomesReused()
  await testContentAddressDoesNotDuplicateAcrossRunIds()
  await testCanonicalPromotionSupersedesOnlyAfterVerifiedArtifact()
  await testHardReferenceEdgesAreReachabilitySourceOfTruth()
  await testRetentionSweepPreservesMetadataAfterPayloadDelete()
  await testD1EvidenceScrubBatchesVerifiedRowsAtomically()
  await testD1EvidenceScrubBisectsFailedBatchInsteadOfRetryingEveryRow()
  await testStorageHealthCheckUsesD1ResultSizeAndReportsTruthfulScope()
  console.log('artifact lifecycle tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
