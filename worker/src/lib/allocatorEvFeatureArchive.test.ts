import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { writeAllocatorForecastArchive, readAllocatorForecastArchive, reconcileAllocatorForecastReferences,
  reconcileAllocatorForecastReferenceTick, ALLOCATOR_FORECAST_RECONCILE_CURSOR,
  allocatorForecastArchivePreflight,
  allocatorForecastWriterGate, ALLOCATOR_FORECAST_ACTIVATION_KEY,
  ALLOCATOR_FORECAST_MAX_BYTES, ALLOCATOR_FORECAST_POINTER_SCHEMA } from './allocatorEvFeatureArchive'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'
import { writeEvidenceArtifact } from './artifactLifecycle'
import { sha256Text } from './datasetSnapshots'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { allocatorForecastActivationFixture } from '../../../ml-controller/tests/fixtures/allocator_forecast_activation'

const GUARD = 'prediction_before_next_executable_session_open;exact_active8_artifact_lineage;l4_trained_before_snapshot;s12_samples_before_run'
const SOURCE = 'allocator_ev_asof_backfill_v2'
const RUN = 'allocator-fixture-run'
function fixture() {
  const db = new DatabaseSync(':memory:')
  const schemas = readFileSync('domain-schemas/ops.sql', 'utf8') + '\n' + readFileSync('domain-schemas/learning.sql', 'utf8')
  for (const table of ['run_artifacts', 'artifact_hard_references', 'maintenance_task_leases', 'allocator_ev_snapshot_runs',
    'allocator_ev_feature_snapshots', 'allocator_ev_feature_snapshot_staging']) {
    const ddl = schemas.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert(ddl); db.exec(ddl[0])
  }
  db.exec(readFileSync('domain-migrations/ops/0020_artifact_deletion_claims.sql', 'utf8'))
  db.exec(readFileSync('domain-migrations/ops/0021_allocator_forecast_active_references.sql', 'utf8'))
  function prepare(sql: string) {
    let params: any[] = []
    return { sql, get params() { return params }, bind(...values: any[]) { params = values; return this },
      async first() { return db.prepare(sql).get(...params) ?? null },
      async all() { return { results: db.prepare(sql).all(...params) } },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } } } }
  }
  const adapter = { prepare, async batch(statements: Array<{ run(): Promise<any> }>) {
    db.exec('BEGIN'); try { const output = []; for (const s of statements) output.push(await s.run()); db.exec('COMMIT'); return output }
    catch (e) { db.exec('ROLLBACK'); throw e }
  } }
  const objects = new Map<string, string>()
  const cache = new Map<string, string>()
  cache.set(ALLOCATOR_FORECAST_ACTIVATION_KEY, JSON.stringify(allocatorForecastActivationFixture()))
  let puts = 0
  const env = { DB: adapter, CF_VERSION_METADATA: { id: 'fixture-worker' }, ML_CONTROLLER_URL: 'https://controller.fixture.invalid',
    KV: { async get(key: string) { return cache.get(key) ?? null },
    async put(key: string, value: string) { cache.set(key, value) } }, STOCKVISION_AUTH_TOKEN: 'fixture-service', ARTIFACTS: {
    async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body, size: Buffer.byteLength(body) } },
    async put(key: string, body: string, options: any) { assert.equal(options.onlyIf.etagDoesNotMatch, '*'); objects.set(key, body); puts++ },
  } } as any
  db.prepare(`INSERT INTO allocator_ev_snapshot_runs(run_id,snapshot_date,snapshot_source,as_of_guard,status)
    VALUES(?,'2026-09-11',?,?,'writing')`).run(RUN, SOURCE, GUARD)
  const raw = JSON.stringify({ ensemble_v2: { model_set_signature: 'exact-models', target_semantic_version: null, avg_rank: 0.74 },
    model_score_lineage: { target_semantic_version: 'semantic-v4' }, huge: '原始'.repeat(10000) })
  const row = { snapshot_date: '2026-09-11', stock_id: 1, snapshot_source: SOURCE, as_of_guard: GUARD, forecast_data: raw }
  const write = async () => {
    const result = await writeAllocatorForecastArchive(env, { run_id: RUN, rows: [row] })
    assert(result.manifest)
    return { ...result, manifest: result.manifest }
  }
  const refs = () => Number(db.prepare('SELECT COUNT(*) n FROM artifact_hard_references WHERE active=1').get()!.n)
  return { db, env, objects, cache, row, write, refs, puts: () => puts }
}

test('allocator forecast: exact original, hot lineage, immutable retry and governed retention', async () => {
  const f = fixture()
  try {
    const result = await f.write()
    const pointer = JSON.parse(result.rows[0].forecast_data)
    assert.equal(pointer.schema_version, ALLOCATOR_FORECAST_POINTER_SCHEMA)
    assert.deepEqual(pointer.ensemble_v2, { model_set_signature: 'exact-models', target_semantic_version: null })
    assert.deepEqual(pointer.model_score_lineage, { target_semantic_version: 'semantic-v4' })
    assert.equal(pointer.forecast_checksum, await sha256Text(f.row.forecast_data))
    assert(Buffer.byteLength(result.rows[0].forecast_data) < Buffer.byteLength(f.row.forecast_data))
    assert.equal(f.refs(), 1)
    assert.equal(Date.parse(result.manifest.retain_until!) - Date.parse(result.manifest.created_at), 3650 * 86400000)
    const readback = await readAllocatorForecastArchive(f.env, result.manifest.artifact_id)
    assert.equal(readback.rows[0].forecast_data, f.row.forecast_data)
    assert.equal(await sha256Text(readback.body), result.manifest.checksum)
    assert.equal(Number(f.db.prepare('SELECT COUNT(*) n FROM allocator_ev_feature_snapshots').get()!.n), 0)
    const retry = await f.write()
    assert.equal(retry.manifest.artifact_id, result.manifest.artifact_id)
    assert.equal(f.puts(), 1); assert.equal(f.refs(), 1)
  } finally { f.db.close() }
})

test('allocator writer is inline by default without R2, refs or a migration requirement; readers survive revocation', async () => {
  const f = fixture()
  try {
    const active = await f.write()
    const before = f.puts(), refs = f.refs()
    f.cache.delete(ALLOCATOR_FORECAST_ACTIVATION_KEY)
    const off = await writeAllocatorForecastArchive(f.env, { run_id: RUN, rows: [f.row] })
    assert.equal(off.writer_enabled, false); assert.equal(off.manifest, null)
    assert.deepEqual(off.rows, [f.row]); assert.equal(f.puts(), before); assert.equal(f.refs(), refs)
    assert.equal((await readAllocatorForecastArchive(f.env, active.manifest.artifact_id)).rows[0].forecast_data, f.row.forecast_data)
    f.db.exec('DROP INDEX idx_allocator_forecast_active_refs_v1')
    assert.equal((await writeAllocatorForecastArchive(f.env, { run_id: RUN, rows: [f.row] })).writer_enabled, false)
    assert.equal(f.puts(), before)
    const endpoint = await adminControlRoutes.request('https://fixture/api/internal/evidence-artifacts/allocator-forecast/gate', {
      method: 'POST', headers: { Authorization: 'Bearer fixture-service' }, body: '{}' }, f.env)
    assert.equal(endpoint.status, 200)
    assert.equal((await endpoint.json() as any).writer_enabled, false)
  } finally { f.db.close() }
})

test('allocator activation rejects incomplete inventory, old reachable readers, inflight work and wrong deployment identities', async () => {
  const f = fixture()
  try {
    const cases: Array<[string, (v: any) => void]> = [
      ['activation_disabled', v => { v.enabled = false }],
      ['activation_worker_version_mismatch', v => { v.worker_version_id = 'old-worker' }],
      ['activation_controller_mismatch', v => { v.controller_url = 'https://wrong.invalid' }],
      ['activation_inventory_incomplete', v => { v.deployment_inventory.complete = false }],
      ['activation_inventory_incomplete', v => { v.controller.revisions = []; v.controller.inventory_count = 0 }],
      ['activation_inventory_incomplete', v => { v.controller.inventory_count++ }],
      ['activation_inventory_incomplete', v => { v.controller.full_reader_routes.pop() }],
      ['activation_revision_invalid', v => { v.controller.revisions[0].image_digest = 'mutable:latest' }],
      ['activation_old_reader_reachable', v => { v.controller.revisions[1].reachable = true }],
      ['activation_old_reader_not_drained', v => { v.controller.revisions[1].quiescence.inflight_requests = 1 }],
      ['activation_old_reader_not_drained', v => { v.controller.revisions[1].quiescence.background_work = 1 }],
      ['activation_old_reader_not_drained', v => { v.controller.revisions[1].quiescence.method = 'waited_one_hour' }],
      ['activation_old_reader_not_drained', v => { delete v.controller.revisions[1].quiescence.sha256 }],
      ['activation_approval_missing', v => { delete v.approval.reference }],
      ['activation_approval_predates_evidence', v => { v.approval.approved_at = '2026-09-29T00:00:00Z' }],
      ['activation_approval_predates_evidence', v => { v.controller.revisions[1].quiescence.observed_at = '2026-09-30T00:02:00Z' }],
      ['activation_approval_missing', v => { v.approval.approved_at = '2099-01-01T00:00:00Z' }],
      ['activation_approval_missing', v => { v.approval.approved_at = '2026-09-30T00:00:00' }],
      ['activation_inventory_incomplete', v => { v.deployment_inventory.observed_at = '2099-01-01T00:00:00Z' }],
      ['activation_old_reader_not_drained', v => { v.controller.revisions[1].quiescence.observed_at = '2099-01-01T00:00:00Z' }],
    ]
    for (const [reason, change] of cases) {
      const value = allocatorForecastActivationFixture(); change(value)
      f.cache.set(ALLOCATOR_FORECAST_ACTIVATION_KEY, JSON.stringify(value))
      const result = await writeAllocatorForecastArchive(f.env, { run_id: RUN, rows: [f.row] })
      assert.equal(result.writer_enabled, false, reason); assert.equal(result.reason, reason)
      assert.deepEqual(result.rows, [f.row]); assert.equal(f.puts(), 0); assert.equal(f.refs(), 0)
    }
    f.cache.set(ALLOCATOR_FORECAST_ACTIVATION_KEY, '{')
    assert.equal((await allocatorForecastWriterGate(f.env)).reason, 'activation_invalid_json')
  } finally { f.db.close() }
})

test('allocator activation represents the 870-revision census; retired readers need drain proof, not source provenance', async () => {
  const f = fixture()
  try {
    const value = allocatorForecastActivationFixture()
    // The real captured census has 870 revisions. Retired historical revisions
    // need unreachable/drained proof; their old build provenance is irrelevant.
    delete (value.controller.revisions[1] as any).image_digest
    delete (value.controller.revisions[1] as any).source_commit
    for (let i = 0; i < 868; i++) value.controller.revisions.push({ ...value.controller.revisions[1], revision: `ml-controller-old-${i}` })
    value.controller.inventory_count = value.controller.revisions.length
    assert.equal(value.controller.revisions.length, 870)
    const encoded = JSON.stringify(value)
    assert(Buffer.byteLength(encoded) < 512 * 1024)
    f.cache.set(ALLOCATOR_FORECAST_ACTIVATION_KEY, encoded)
    assert.equal((await allocatorForecastWriterGate(f.env)).writer_enabled, true)
    f.db.exec('DROP INDEX idx_allocator_forecast_active_refs_v1')
    await assert.rejects(f.write(), /active_reference_index_not_ready/)
    assert.equal(f.puts(), 0); assert.equal(f.refs(), 0)
  } finally { f.db.close() }
})

test('allocator forecast: small originals never grow and huge/duplicate rows are rejected before puts', async () => {
  const f = fixture()
  try {
    const small = { ...f.row, forecast_data: '{"ensemble_v2":{"model_set_signature":"exact-models"}}' }
    const result = await writeAllocatorForecastArchive(f.env, { run_id: RUN, rows: [small] })
    assert.equal(result.rows[0].forecast_data, small.forecast_data)
    const puts = f.puts()
    await assert.rejects(writeAllocatorForecastArchive(f.env, { run_id: RUN, rows: [f.row, f.row] }), /duplicate_row/)
    await assert.rejects(writeAllocatorForecastArchive(f.env, { run_id: RUN, rows: [{ ...f.row, forecast_data: JSON.stringify({ huge: 'x'.repeat(ALLOCATOR_FORECAST_MAX_BYTES) }) }] }), /byte_limit/)
    assert.equal(f.puts(), puts)
  } finally { f.db.close() }
})

test('allocator forecast: read corruption/missing/manifest contradictions fail closed', async () => {
  const f = fixture()
  try {
    const { manifest } = await f.write()
    const body = f.objects.get(manifest.r2_key)!
    f.objects.set(manifest.r2_key, body.replace('exact-models', 'wrong-models'))
    await assert.rejects(readAllocatorForecastArchive(f.env, manifest.artifact_id), /checksum_mismatch/)
    f.objects.delete(manifest.r2_key)
    await assert.rejects(readAllocatorForecastArchive(f.env, manifest.artifact_id), /object_missing/)
    f.objects.set(manifest.r2_key, body)
    f.db.prepare('UPDATE run_artifacts SET row_count=2 WHERE artifact_id=?').run(manifest.artifact_id)
    await assert.rejects(readAllocatorForecastArchive(f.env, manifest.artifact_id), /manifest_identity_mismatch/)
  } finally { f.db.close() }
})

test('allocator forecast: writing/canonical/staging references protected; only proven absent terminal edges released', async () => {
  const f = fixture()
  try {
    const result = await f.write()
    assert.equal((await reconcileAllocatorForecastReferences(f.env, { run_id: RUN })).reason, 'run_not_terminal')
    f.db.prepare(`INSERT INTO allocator_ev_feature_snapshots(snapshot_date,stock_id,symbol,forecast_data,alpha_allocation,snapshot_source,as_of_guard)
      VALUES('2026-09-11',1,'2330',?,'{}',?,?)`).run(result.rows[0].forecast_data, SOURCE, GUARD)
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='ready' WHERE run_id=?").run(RUN)
    assert.equal((await reconcileAllocatorForecastReferences(f.env, { run_id: RUN })).protected, 1)
    assert.equal(f.refs(), 1)
    f.db.prepare(`INSERT INTO allocator_ev_feature_snapshot_staging(run_id,snapshot_date,stock_id,symbol,forecast_data,
      alpha_allocation,snapshot_source,as_of_guard,generated_at) VALUES(?,'2026-09-11',1,'2330',?,'{}',?,?,'2026-09-11')`)
      .run(RUN, result.rows[0].forecast_data, SOURCE, GUARD)
    f.db.prepare("UPDATE allocator_ev_feature_snapshots SET forecast_data='{}'").run()
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='failed' WHERE run_id=?").run(RUN)
    assert.equal((await reconcileAllocatorForecastReferences(f.env, { run_id: RUN })).protected, 1)
    f.db.prepare('DELETE FROM allocator_ev_feature_snapshot_staging WHERE run_id=?').run(RUN)
    const released = await reconcileAllocatorForecastReferences(f.env, { run_id: RUN })
    assert.equal(released.released, 1); assert.equal(f.refs(), 0)
    assert.equal(f.db.prepare('SELECT forecast_data FROM allocator_ev_feature_snapshots').get()!.forecast_data, '{}')
    assert.equal(f.objects.size, 1)
    await assert.rejects(f.write(), /run_not_writing/)
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='writing' WHERE run_id=?").run(RUN)
    await assert.rejects(f.write(), /terminal_reference_reactivation_forbidden/)
  } finally { f.db.close() }
})

test('allocator forecast typed routes require auth and reject request bytes before archive', async () => {
  const f = fixture()
  try {
    const path = 'https://fixture/api/internal/evidence-artifacts/allocator-forecast/write'
    const input = JSON.stringify({ run_id: RUN, rows: [f.row] })
    const preflight = await adminControlRoutes.request(path.replace('/write', '/preflight'), { method: 'POST',
      headers: { Authorization: 'Bearer fixture-service' }, body: '{}' }, f.env)
    assert.equal(preflight.status, 200)
    const noAuth = await adminControlRoutes.request(path, { method: 'POST', body: input }, f.env)
    assert.equal(noAuth.status, 401)
    const oversized = await adminControlRoutes.request(path, { method: 'POST', headers: { Authorization: 'Bearer fixture-service' }, body: ' '.repeat(ALLOCATOR_FORECAST_MAX_BYTES + 1) }, f.env)
    assert.equal(oversized.status, 413); assert.equal(f.puts(), 0)
    const response = await adminControlRoutes.request(path, { method: 'POST', headers: { Authorization: 'Bearer fixture-service' }, body: input }, f.env)
    assert.equal(response.status, 200)
    const receipt = await response.json() as any
    const readback = await adminControlRoutes.request(path.replace('/write', '/read'), { method: 'POST',
      headers: { Authorization: 'Bearer fixture-service' }, body: JSON.stringify({ artifact_id: receipt.manifest.artifact_id }) }, f.env)
    assert.equal(readback.status, 200)
    assert.equal(await sha256Text(await readback.text()), receipt.manifest.checksum)
  } finally { f.db.close() }
})

test('missing or wrong active inventory index blocks capture before any original is written', async () => {
  const f = fixture()
  try {
    f.db.exec('DROP INDEX idx_allocator_forecast_active_refs_v1')
    await assert.rejects(f.write(), /active_reference_index_not_ready/)
    assert.equal(f.puts(), 0)
    f.db.exec('CREATE INDEX idx_allocator_forecast_active_refs_v1 ON artifact_hard_references(owner_id,artifact_id)')
    await assert.rejects(allocatorForecastArchivePreflight(f.env), /active_reference_index_not_ready/)
  } finally { f.db.close() }
})

test('existing natural owner recovers process death after publication and retries failed proof without skipping', async () => {
  const f = fixture()
  try {
    const { manifest } = await f.write()
    // Publication replaced the old pointer, then the process died before cleanup.
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='ready'").run()
    const original = f.objects.get(manifest.r2_key)!
    f.objects.set(manifest.r2_key, original.replace('exact-models', 'wrong-models'))
    await assert.rejects(reconcileAllocatorForecastReferenceTick(f.env), /checksum_mismatch/)
    assert.equal(f.refs(), 1)
    assert.equal(f.cache.has(ALLOCATOR_FORECAST_RECONCILE_CURSOR), false)
    f.objects.set(manifest.r2_key, original)
    const recovered = await buildAdminWorkerDomainTaskMap({ env: f.env, req: { query: () => '1' } }, {} as any)['artifact-reconcile']()
    assert.match(String(recovered), /allocator_refs_released=1/)
    assert.equal(f.refs(), 0)
    assert.equal(f.objects.size, 1, 'reference cleanup does not delete the 3650-day original')
  } finally { f.db.close() }
})

test('natural bounded cursor crosses a large run, revisits writing runs, and reaches newly added runs', async () => {
  const f = fixture()
  try {
    const addRun = (id: string) => f.db.prepare(`INSERT INTO allocator_ev_snapshot_runs
      (run_id,snapshot_date,snapshot_source,as_of_guard,status) VALUES(?,'2026-09-11',?,?,'writing')`).run(id, SOURCE, GUARD)
    addRun('a-writing'); addRun('b-large')
    await writeAllocatorForecastArchive(f.env, { run_id: 'a-writing', rows: [f.row] })
    for (let stock = 1; stock <= 20; stock++) {
      await writeAllocatorForecastArchive(f.env, { run_id: 'b-large', rows: [{ ...f.row, stock_id: stock }] })
    }
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='failed' WHERE run_id='b-large'").run()
    const first = await reconcileAllocatorForecastReferenceTick(f.env)
    assert.equal(first.checked, 16); assert.equal(first.released, 16); assert.equal(first.skipped, 1)
    assert.equal(first.cursor.active_run_id, 'b-large'); assert.equal(f.refs(), 5)
    addRun('z-new')
    await writeAllocatorForecastArchive(f.env, { run_id: 'z-new', rows: [f.row] })
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='failed' WHERE run_id='z-new'").run()
    const second = await reconcileAllocatorForecastReferenceTick(f.env)
    assert.equal(second.released, 5); assert.equal(second.cycle_complete, true); assert.equal(f.refs(), 1)
    f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='failed' WHERE run_id='a-writing'").run()
    assert.equal((await reconcileAllocatorForecastReferenceTick(f.env)).released, 1)
    assert.equal(f.refs(), 0)
  } finally { f.db.close() }
})

test('lost cursor acknowledgement replays conservatively and converges', async () => {
  const f = fixture()
  try {
    await f.write(); f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='failed'").run()
    const put = f.env.KV.put
    f.env.KV.put = async () => { throw new Error('fixture_cursor_write_unavailable') }
    await assert.rejects(reconcileAllocatorForecastReferenceTick(f.env), /cursor_write_unavailable/)
    assert.equal(f.refs(), 0)
    assert.equal(f.cache.has(ALLOCATOR_FORECAST_RECONCILE_CURSOR), false)
    f.env.KV.put = put
    assert.equal((await reconcileAllocatorForecastReferenceTick(f.env)).cycle_complete, true)
  } finally { f.db.close() }
})

test('generic integrity failure does not cancel independent forecast recovery and task remains failed', async () => {
  const f = fixture()
  try {
    await f.write(); f.db.prepare("UPDATE allocator_ev_snapshot_runs SET status='ready'").run()
    const unrelated = await writeEvidenceArtifact(f.env, { domain: 'unrelated_fixture', businessDate: '2026-09-11',
      producerRunId: 'unrelated', retentionClass: 'ten_year_cold_archive', schemaVersion: 'fixture-v1', payload: { a: 1 }, rowCount: 1 })
    f.objects.set(unrelated.r2_key, 'bad original')
    const handler = buildAdminWorkerDomainTaskMap({ env: f.env, req: { query: () => '500' } }, {} as any)['artifact-reconcile']
    await assert.rejects(handler(), /artifact reconcile failed/)
    assert.equal(f.refs(), 0, 'healthy forecast recovery still completes its bounded pass')
    assert.equal(f.db.prepare('SELECT status FROM run_artifacts WHERE artifact_id=?').get(unrelated.artifact_id)!.status, 'integrity_blocked')
  } finally { f.db.close() }
})
