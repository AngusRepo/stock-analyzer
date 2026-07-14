import assert from 'node:assert/strict'
import {
  promoteCanonicalRun,
  registerPipelineRun,
  runR2RetentionSweep,
  STORAGE_LIFECYCLE_SCHEDULE,
  writeEvidenceArtifact,
} from './artifactLifecycle'

class Statement {
  values: unknown[] = []
  constructor(private readonly db: MockDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  async first<T>(): Promise<T | null> { return this.db.first(this) as T | null }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.all(this) as T[] } }
  async run(): Promise<{ success: true }> { this.db.runs.push(this); return { success: true } }
}

class MockDb {
  runs: Statement[] = []
  batches: Statement[][] = []
  firstHandler: (statement: Statement) => unknown = () => null
  allHandler: (statement: Statement) => unknown[] = () => []
  prepare(sql: string) { return new Statement(this, sql) }
  first(statement: Statement) { return this.firstHandler(statement) }
  all(statement: Statement) { return this.allHandler(statement) }
  async batch(statements: Statement[]) { this.batches.push(statements); return statements.map(() => ({ success: true })) }
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
  assert.match(db.runs[0].sql, /INSERT OR REPLACE INTO run_artifacts/)
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
  assert.equal(db.batches[0].length, 3)
  assert.match(db.batches[0][0].sql, /status='superseded'/)
  assert.match(db.batches[0][1].sql, /status='canonical'/)
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

async function main(): Promise<void> {
  assert.equal(STORAGE_LIFECYCLE_SCHEDULE.some((row) => row.task === 'storage-health-gate'), true)
  await testR2FirstWriteVerifiesBeforeManifest()
  await testIdenticalRunBecomesReused()
  await testContentAddressDoesNotDuplicateAcrossRunIds()
  await testCanonicalPromotionSupersedesOnlyAfterVerifiedArtifact()
  await testRetentionSweepPreservesMetadataAfterPayloadDelete()
  console.log('artifact lifecycle tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
