// Original Python review -> authenticated Worker client -> private native D1.
// Artificial fills test publication plumbing, not economic value of a route.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { adoptNavStrategyRoute, reconcileNavStrategyRoute } from '../src/lib/strategyRouteNavAdoption'
import { adminConfigCoreRoutes } from '../src/routes/adminConfigCoreRoutes'
import { loadPromotedStrategyRouteCalibration } from '../src/lib/strategyRouteCalibration'
import { withPaperExecutionScope, advancePaperExecutionClock, paperExecutionNow } from '../src/lib/paperExecutionScope'
import { buildLayer1WithAtomicSource } from '../src/lib/atomicStrategyShadow'
import { sha256Text } from '../src/lib/datasetSnapshots'
import { refreshStrategyRouteCalibration } from '../src/lib/strategyRouteCalibration'
import { buildPipelineDecisionMaturityPacket } from '../src/lib/pipelineDecisionMaturity'
import { strategySpecToRegistryRow } from '../src/lib/strategyLearning'

const original = JSON.parse(fs.readFileSync(process.env.NAV_ROUTE_PUBLICATION_FIXTURE!, 'utf8'))
const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'isolated-nav-test-token',
  KV: { get: async () => null } } as any
const now = new Date(original.now)
const readConfig = async () => ({ tradingConfig: original.config.trading_config, riskConfig: original.config.risk_config })

type Route = { runId: string; routeVersion: string; routeFloor: number | null }
type Capture = (route: Route, observedAt: string) => Promise<{ plan: any; corrupt: () => void }>
async function fixture(run: (db: D1Database, capture: Capture) => Promise<void>, controllerPayload = original.payload,
  controllerObservedAt = () => original.now) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("private") } }',
    d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING') as unknown as D1Database
    for (const sql of original.schema) await db.prepare(sql).run()
    const inserts: D1PreparedStatement[] = []
    for (const [name, rows] of Object.entries(original.tables)) for (const row of rows as any[]) {
      const keys = Object.keys(row)
      inserts.push(db.prepare(`INSERT INTO ${name}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
        .bind(...Object.values(row)))
    }
    for (let start = 0; start < inserts.length; start += 50) await db.batch(inserts.slice(start, start + 50))
    const baseline = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
    for (const name of ['strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1']) {
      const ddl = baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert(ddl)
      await db.prepare(ddl).run()
    }
    for (const name of ['0023_strategy_route_paired_incumbent_evidence.sql', '0046_route_nav_diagnostic_floor.sql']) {
      const sql = fs.readFileSync('domain-migrations/learning/' + name, 'utf8')
      await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)))
    }
    for (const sql of [
      `CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
        strategy_challenger_affinity_version TEXT,strategy_challenger_route_version TEXT,
        strategy_challenger_route_score REAL,strategy_router_score REAL,strategy_router_version TEXT,hard_gate_passed INTEGER)`,
      `CREATE TABLE strategy_route_versioned_evidence_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
        route_version TEXT,route_score REAL,incumbent_route_score REAL)`,
      'CREATE TABLE model_champion_pointers(model_name TEXT,champion_artifact_id TEXT)',
      'CREATE TABLE model_artifact_registry(artifact_id TEXT,model_name TEXT,state TEXT,checksum TEXT)',
      'CREATE TABLE expected_return_artifact_payloads(artifact_id TEXT,source_artifact_checksum TEXT,serving_mode TEXT)',
      'CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)',
      'CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT,validation_decision TEXT,state TEXT,production_effect INTEGER)',
      'CREATE TABLE pipeline_runs(run_id TEXT,logical_run_key TEXT,business_date TEXT,domain TEXT,status TEXT,canonical_at TEXT,artifact_id TEXT)',
      'CREATE TABLE run_artifacts(artifact_id TEXT,r2_key TEXT,checksum TEXT,created_at TEXT,schema_version TEXT,producer_run_id TEXT,business_date TEXT,domain TEXT,status TEXT,checksum_verified_at TEXT,payload_deleted_at TEXT)',
    ]) await db.prepare(sql).run()
    const objects = new Map<string, string>()
    const registryDdl = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
      .match(/CREATE TABLE IF NOT EXISTS strategy_spec_registry \([\s\S]*?\n  \)/)?.[0]
    assert(registryDdl)
    await db.prepare(registryDdl).run()
    for (const spec of original.route_inputs.specs) {
      const row = strategySpecToRegistryRow(spec)
      const keys = Object.keys(row)
      await db.prepare(`INSERT INTO strategy_spec_registry(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
        .bind(...Object.values(row)).run()
    }
    env.ARTIFACTS = { get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null }
    // This numerical fixture maps the original router's three synthetic rows to
    // 2330/2317/2454 in test_paired_nav_route_pit.with_routes, without refitting.
    const nav = original.payload.prospective_validation.nav_validation
    const manifest = original.tables.paired_nav_frozen_manifests_v1.find((row: any) => row.snapshot_id === nav.allocation_snapshot_id)
    const allocation = JSON.parse(original.tables.paired_nav_frozen_parts_v1
      .filter((row: any) => row.snapshot_id === nav.allocation_snapshot_id)
      .sort((a: any, b: any) => a.part_no - b.part_no).map((row: any) => row.payload_text).join('')).content
    const oldId = allocation.route_effect.screener_run_id, oldDay = manifest.signal_date
    const historical = await buildLayer1WithAtomicSource({ ...original.route_inputs,
      universe: original.route_inputs.universe.map((row: any, index: number) => ({ ...row, symbol: ['2330', '2317', '2454'][index] })),
      signalDate: oldDay, producerRunId: oldId, observedAt: oldDay + 'T09:59:00Z',
      options: { targetSize: 4, coarseMlQueueSize: 4, regime: 'bull',
        strategyWeights: Object.fromEntries(original.route_inputs.specs.map((spec: any) => [spec.id, 1])),
        productionStrategyWeights: Object.fromEntries(original.route_inputs.specs.map((spec: any) => [spec.id, 1])) } })
    const oldRaw = JSON.stringify({ domain: 'screener_funnel', business_date: oldDay, schema_version: 'screener-funnel-evidence-v3',
      payload: { atomic_strategy_source: historical.source, items: [] } })
    objects.set(oldId, oldRaw)
    await db.prepare("INSERT INTO pipeline_runs VALUES(?,?,?,'screener','superseded',?,?)")
      .bind(oldId, 'screener:' + oldDay, oldDay, oldDay + 'T09:59:02Z', oldId).run()
    await db.prepare("INSERT INTO run_artifacts VALUES(?,?,?,?,'screener-funnel-evidence-v3',?,?,'screener_funnel','ready',?,NULL)")
      .bind(oldId, oldId, await sha256Text(oldRaw), oldDay + 'T09:59:01Z', oldId, oldDay, oldDay + 'T09:59:02Z').run()
    let serial = 0
    const capture: Capture = async (route, observedAt) => {
      const day = original.payload.evaluation_business_date, id = 'observed-route-' + ++serial
      const specs = original.route_inputs.specs
      const result = await buildLayer1WithAtomicSource({ ...original.route_inputs,
        signalDate: day, producerRunId: id, observedAt,
        options: { targetSize: 4, coarseMlQueueSize: 4, regime: 'bull',
          strategyWeights: Object.fromEntries(specs.map((spec: any) => [spec.id, 1])),
          productionStrategyWeights: Object.fromEntries(specs.map((spec: any) => [spec.id, 1])),
          promotedRouteCalibration: route } })
      const raw = JSON.stringify({ domain: 'screener_funnel', business_date: day, schema_version: 'screener-funnel-evidence-v3',
        payload: { atomic_strategy_source: result.source, items: [] } })
      objects.set(id, raw)
      const created = new Date(Date.parse(observedAt) + 1000).toISOString()
      const canonical = new Date(Date.parse(observedAt) + 2000).toISOString()
      await db.prepare("UPDATE pipeline_runs SET status='superseded' WHERE status='canonical'").run()
      await db.prepare("INSERT INTO pipeline_runs VALUES(?,?,?,'screener','canonical',?,?)")
        .bind(id, 'screener:' + day, day, canonical, id).run()
      await db.prepare("INSERT INTO run_artifacts VALUES(?,?,?,?,'screener-funnel-evidence-v3',?,?,'screener_funnel','ready',?,NULL)")
        .bind(id, id, await sha256Text(raw), created, id, day, created).run()
      advancePaperExecutionClock(Math.max(paperExecutionNow(), Date.parse(canonical)) + 1000)
      return { plan: result.plan, corrupt: () => objects.set(id, '{}') }
    }
    const formal = original.config.formal_baseline_identity
    await db.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)')
      .bind(formal.artifact_id, formal.cohort_id, formal.payload_checksum, formal.base_artifact_set_checksum).run()
    await db.prepare("INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,'PASS','production',1)")
      .bind(formal.artifact_id, formal.cohort_id, formal.payload_checksum, formal.base_artifact_set_checksum).run()
    await withPaperExecutionScope({ accountId: 1, nowMs: now.getTime(), environment: env,
      databases: { learning: db, market: db, ops: db },
      fetchFrozen: async (url, init) => {
        assert.equal(String(url), 'https://controller.invalid/nav/policy-decision')
        assert.equal(new Headers(init?.headers).get('X-Controller-Token'), env.ML_CONTROLLER_SECRET)
        assert.deepEqual(JSON.parse(String(init?.body)), { owner: 'l15_route',
          candidate_artifact_id: original.payload.artifact_id, candidate_checksum: original.payload.artifact_checksum,
          business_date: controllerPayload.evaluation_business_date })
        return Response.json({ schema_version: 'paired-nav-policy-decision-response-v1', owner: 'l15_route',
          observed_at: controllerObservedAt(), payload: controllerPayload, source: 'original_frozen_policy_and_verified_nav', read_only: true })
      },
    }, () => run(db, capture))
  } finally { await mf.dispose() }
}

const publish = (db: D1Database) => adoptNavStrategyRoute(db, env, original.payload, readConfig, now)
const candidateRequest = { business_date: original.payload.evaluation_business_date,
  candidates: [{ artifact_id: original.payload.artifact_id, artifact_checksum: original.payload.artifact_checksum }] }
const reconcileCandidates = (db: D1Database, config = readConfig) =>
  (reconcileNavStrategyRoute as any)(db, env, candidateRequest, now, config)
const reconcile = (db: D1Database) => reconcileNavStrategyRoute(new Proxy(db, { get(target, key) {
  if (key === 'prepare') return (sql: string) => { assert.match(sql, /^\s*SELECT\b/i); return target.prepare(sql) }
  if (key === 'batch' || key === 'exec') return () => assert.fail('reconciliation must not write')
  const value = Reflect.get(target, key)
  return typeof value === 'function' ? value.bind(target) : value
} }) as D1Database, env, candidateRequest, now, readConfig)
const state = async (db: D1Database) => ({
  runs: (await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1 ORDER BY run_id').all()).results,
  heads: (await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').all()).results,
})

test('Route rejects changed Atomic strategy definitions before and during publication', async () => {
  for (const race of [false, true]) await fixture(async db => {
    const mutate = () => db.prepare("UPDATE strategy_spec_registry SET thresholds_json='{}'").run()
    if (!race) await mutate()
    const target = race ? new Proxy(db, { get(owner, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        await mutate()
        return owner.batch(statements)
      }
      const value = Reflect.get(owner, key)
      return typeof value === 'function' ? value.bind(owner) : value
    } }) as D1Database : db
    await assert.rejects(() => publish(target), /strategy_route_nav_registry_changed|malformed JSON/)
    assert.deepEqual(await state(db), { runs: [], heads: [] })
  })
})

test('Route requires exact old canonical evidence, never a current-run substitute', async () => {
  for (const fault of ['missing', 'future', 'corrupt']) await fixture(async db => {
    if (fault === 'missing') await db.prepare("UPDATE pipeline_runs SET run_id='different-run'").run()
    if (fault === 'future') await db.prepare("UPDATE pipeline_runs SET canonical_at='2026-09-22T00:00:00Z'").run()
    if (fault === 'corrupt') env.ARTIFACTS = { get: async () => ({ text: async () => '{}' }) }
    await assert.rejects(() => publish(db), /atomic_source_canonical_run_missing|atomic_source_canonical_time_invalid|atomic_source_artifact_checksum_mismatch/)
    assert.deepEqual(await state(db), { runs: [], heads: [] })
  })
})

test('Route reconciliation and publication use each request clock after preceding database reads', async () => {
  for (const operation of ['reconcile', 'publish']) for (const futureResponse of [false, true]) await fixture(async db => {
    let delayed = false
    const slow = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (!delayed) {
          delayed = true
          advancePaperExecutionClock(paperExecutionNow() + 1000)
        }
        if (operation === 'reconcile') assert.match(sql, /^\s*SELECT\b/i)
        return target.prepare(sql)
      }
      if (operation === 'reconcile' && (key === 'batch' || key === 'exec')) return () => assert.fail('reconciliation must not write')
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    const action = () => operation === 'reconcile' ? reconcileCandidates(slow) : publish(slow)
    if (futureResponse) await assert.rejects(action, /policy_original_decision_changed/)
    else {
      const result = await action()
      if (operation === 'reconcile') {
        assert.equal(result.entries![0].state, 'candidate')
        assert.equal(result.nav_maturity_credit, 0)
      } else assert.equal(result.pointer_committed, true)
    }
    if (futureResponse || operation === 'reconcile') assert.deepEqual(await state(db), { runs: [], heads: [] })
  }, original.payload, () => new Date(paperExecutionNow() + (futureResponse ? 60_000 : 0)).toISOString())
})

test('registry timestamp-only refresh retains the original executable comparison', async () => fixture(async db => {
  await db.prepare("UPDATE strategy_spec_registry SET updated_at='2026-09-21T13:00:00Z'").run()
  assert.equal((await publish(db)).complete, true)
}))

test('Route daily inventory distinguishes changed valid baseline from broken evidence', async () => fixture(async db => {
  const ready = await reconcileCandidates(db)
  assert.equal(ready.entries[0].state, 'candidate')
  await db.prepare("UPDATE strategy_spec_registry SET thresholds_json='{}'").run()
  const waiting = await reconcileCandidates(db)
  assert.equal(waiting.entries[0].state, 'baseline_changed')
  assert.equal(waiting.entries[0].reason, 'registry_changed')
  assert.equal(waiting.nav_maturity_credit, 0)
  assert.deepEqual(await state(db), { runs: [], heads: [] })
  console.log('NAV_ROUTE_CANDIDATE_RECONCILIATION=' + JSON.stringify({ ready, waiting }))
  await db.prepare('DELETE FROM active8_ensemble_pointer_v1').run()
  await assert.rejects(() => reconcileCandidates(db), /ml_baseline|context/)
}))

test('Route candidate eligibility keeps valid ML/config changes separate from corrupt or racing sources', async () => {
  for (const fault of ['valid_ml', 'risk_config', 'corrupt_ml', 'missing_config', 'registry_race', 'missing_source']) await fixture(async db => {
    if (fault === 'valid_ml') await db.batch([
      db.prepare("UPDATE active8_ensemble_pointer_v1 SET artifact_id='different-valid-formal'"),
      db.prepare("UPDATE active8_ensemble_artifacts_v1 SET artifact_id='different-valid-formal'"),
    ])
    if (fault === 'corrupt_ml') await db.prepare("UPDATE active8_ensemble_artifacts_v1 SET state='candidate'").run()
    if (fault === 'missing_source') await db.prepare('DELETE FROM pipeline_runs').run()
    let reads = 0
    const config = async () => {
      if (fault === 'registry_race' && ++reads === 1)
        await db.prepare("UPDATE strategy_spec_registry SET thresholds_json='{}'").run()
      if (fault === 'missing_config') return { tradingConfig: null, riskConfig: null } as any
      const current = await readConfig()
      return fault === 'risk_config' ? { ...current, riskConfig: { changed: true } } : current
    }
    if (['valid_ml', 'risk_config'].includes(fault)) {
      const result = await reconcileCandidates(db, config)
      assert.equal(result.entries[0].state, 'baseline_changed')
      assert.equal(result.entries[0].reason, fault === 'valid_ml' ? 'ml_baseline_changed' : 'configuration_changed')
    } else await assert.rejects(() => reconcileCandidates(db, config))
    assert.deepEqual(await state(db), { runs: [], heads: [] })
  })
})

test('original pre-maturity Route decision is observing and never gains a PASS proof', async () => {
  assert(original.pending_payload)
  await fixture(async db => {
    const request = { ...candidateRequest, business_date: original.pending_payload.evaluation_business_date }
    const result = await reconcileNavStrategyRoute(db, env, request, now, readConfig)
    assert.equal(result.entries![0].state, 'observing')
    assert.equal(result.entries![0].decision_checksum, original.pending_payload.prospective_validation.nav_validation.decision_checksum)
    assert.equal(result.promotion_allowed, false)
    assert.equal(result.nav_maturity_credit, 0)
    await assert.rejects(() => adoptNavStrategyRoute(db, env, original.pending_payload, readConfig, now), /gate_identity_invalid/)
    assert.deepEqual(await state(db), { runs: [], heads: [] })
  }, original.pending_payload)
})

test('original numerical NAV PASS publishes no diagnostic floor and exact retry keeps receipt', async () => {
  await fixture(async db => {
    const before = await reconcile(db)
    assert.equal(before.publication, null)
    console.log('NAV_ROUTE_RECONCILIATION_BEFORE=' + JSON.stringify(before))
    const result = await publish(db)
    assert.equal(result.complete, true)
    assert.equal(result.serving.routeFloor, null)
    assert.equal(result.serving_activation_verified, false)
    assert.equal(result.recovered_existing_commit, false)
    assert.deepEqual(await loadPromotedStrategyRouteCalibration(db), {
      runId: result.serving.runId, routeVersion: result.serving.routeVersion, routeFloor: null })
    const priorState = await state(db)
    const again = await publish(db)
    assert.equal(again.recovered_existing_commit, true)
    assert.equal(again.publication_receipt_checksum, result.publication_receipt_checksum)
    assert.deepEqual(await state(db), priorState)
    assert.equal((await db.prepare('SELECT count(*) n FROM model_artifact_registry').first<any>()).n, 0)
    const packet = await buildPipelineDecisionMaturityPacket(env, original.payload.evaluation_business_date)
    const stage = packet.stages.find(s => s.id === 'route_score_v2')!
    assert.equal(stage.status, 'ready')
    assert.equal(stage.metrics.find(m => m.key === 'canonical_execution_observed')?.value, false)
    assert.equal(stage.lineage.oof_applicable, false)
    assert.equal(stage.metrics.find(m => m.key === 'nav_sessions')?.value, 10)
    assert.equal(packet.strategy_route_bundle.route_mature_dates, 10)
    assert.equal(packet.strategy_route_bundle.route_required_dates, 10)
    assert.equal(stage.metrics.find(m => m.key === 'route_floor')?.value, null)
    assert(!stage.metrics.some(m => m.key === 'weekly_candidate_mature_dates'))
    console.log('NAV_ROUTE_PUBLICATION_RESULT=' + JSON.stringify(result))
  })
})

test('canonical original Layer1 route execution, not head publication, activates serving observation', async () => fixture(async (db, capture) => {
  const published = await publish(db)
  assert.equal(published.execution_observation.executed, false)
  const serving = await loadPromotedStrategyRouteCalibration(db)
  assert(serving)
  const selected = await capture(serving, new Date(now.getTime() + 60_000).toISOString())
  assert.equal(selected.plan.l0Annotated.length, 3)
  assert(selected.plan.l0Annotated.some((row: any) => row.l15_route_contrast?.serving_arm === 'challenger'))
  const observed = await publish(db)
  assert.equal(observed.serving_activation_verified, true)
  assert.equal(observed.execution_observation.scope, 'canonical_l1_l15_selection')
  assert.equal(observed.execution_observation.orders_executed_verified, false)
  const packet = await buildPipelineDecisionMaturityPacket(env, original.payload.evaluation_business_date)
  assert.equal(packet.stages.find(stage => stage.id === 'route_score_v2')?.status, 'serving')
  console.log('NAV_ROUTE_EXECUTION_RESULT=' + JSON.stringify(observed))
  const beforeReconciliation = await state(db)
  const reconciled = await reconcile(db)
  assert.equal(reconciled.publication?.serving_activation_verified, true)
  assert.deepEqual(await state(db), beforeReconciliation)
  console.log('NAV_ROUTE_RECONCILIATION_AFTER=' + JSON.stringify(reconciled))
  selected.corrupt()
  await assert.rejects(() => publish(db), /checksum_mismatch/)
  const corruptPacket = await buildPipelineDecisionMaturityPacket(env, original.payload.evaluation_business_date)
  assert.equal(corruptPacket.stages.find(stage => stage.id === 'route_score_v2')?.status, 'unavailable')
  assert.equal(corruptPacket.strategy_route_bundle.route_mature_dates, null)
  assert.equal(corruptPacket.strategy_route_bundle.route_required_dates, null)
}))

test('Route publication and observation require service authentication before database access', async () => {
  const bindings = { STOCKVISION_AUTH_TOKEN: 'route-local-service-token', ENVIRONMENT: 'production' } as any
  for (const endpoint of ['promote', 'reconcile']) {
    const url = 'https://fixture.invalid/api/admin/config/strategy-route/' + endpoint
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
      assert.equal((await adminConfigCoreRoutes.request(url, { method: 'POST', headers, body: '{}' }, bindings)).status, 401)
    }
    assert.equal((await adminConfigCoreRoutes.request(url, { method: 'POST',
      headers: { authorization: 'Bearer route-local-service-token' }, body: '{' }, bindings)).status, 400)
  }
})

test('another route or source predating publication cannot claim activation', async () => fixture(async (db, capture) => {
  await publish(db)
  const serving = await loadPromotedStrategyRouteCalibration(db)
  assert(serving)
  await capture({ ...serving, runId: 'other-original-route' }, new Date(now.getTime() + 60_000).toISOString())
  assert.equal((await publish(db)).serving_activation_verified, false)
  await capture(serving, new Date(now.getTime() - 60_000).toISOString())
  await assert.rejects(() => publish(db), /used_before_publication/)
}))

test('every publication statement failure rolls back run and head', async () => {
  await fixture(async db => {
    let statementCount = 1
    for (let index = 0; index < statementCount; index++) {
      const faulty = new Proxy(db, { get(target, key) {
        if (key === 'batch') return (statements: D1PreparedStatement[]) => {
          statementCount = statements.length
          return target.batch(statements.map((s, i) =>
            i === index ? target.prepare("SELECT json('injected_route_failure')") : s))
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } }) as D1Database
      await assert.rejects(() => publish(faulty), /injected_route_failure|malformed JSON/)
      assert.deepEqual(await state(db), { runs: [], heads: [] })
    }
  })
})

test('lost acknowledgement recovers original publication without re-spending review', async () => {
  await fixture(async db => {
    const before = (await db.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()).results
    const lost = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        await target.batch(statements)
        throw new Error('fixture_ack_lost')
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    await assert.rejects(() => publish(lost), /fixture_ack_lost/)
    const committed = await state(db)
    const recovered = await publish(db)
    assert.equal(recovered.recovered_existing_commit, true)
    assert.deepEqual(await state(db), committed)
    assert.deepEqual((await db.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()).results, before)
  })
})

test('late original journal or changed formal pointer cannot race publication', async () => {
  for (const change of ['journal', 'formal']) await fixture(async db => {
    const raced = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (change === 'journal') await target.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_checksum=? WHERE session_date=?")
          .bind('f'.repeat(64), '2026-09-21').run()
        else await target.prepare("UPDATE active8_ensemble_pointer_v1 SET artifact_id='changed'").run()
        return target.batch(statements)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    await assert.rejects(() => publish(raced))
    assert.deepEqual(await state(db), { runs: [], heads: [] })
  })
})

test('caller-edited PASS and changed risk config leave existing tables untouched', async () => {
  await fixture(async db => {
    const changed = structuredClone(original.payload)
    changed.prospective_validation.nav_validation.evaluable_date_count++
    await assert.rejects(() => adoptNavStrategyRoute(db, env, changed, readConfig, now), /original_decision_changed/)
    await assert.rejects(() => adoptNavStrategyRoute(db, env, original.payload,
      async () => ({ ...await readConfig(), riskConfig: { changed: true } }), now), /configuration_changed/)
    assert.deepEqual(await state(db), { runs: [], heads: [] })
  })
})

test('diagnostic refresh cannot unpublish NAV and damaged head/run cannot silently serve', async () => {
  await fixture(async db => {
    await publish(db)
    const before = await state(db)
    await refreshStrategyRouteCalibration(db, '2026-09-21', { allowPromotion: true })
    assert.deepEqual((await state(db)).heads, before.heads)
    const promoted = (await state(db)).runs!.find((row: any) => row.run_id === before.runs![0].run_id)
    assert.deepEqual(promoted, before.runs![0])
    const serving = await loadPromotedStrategyRouteCalibration(db)
    assert(serving && serving.routeFloor === null)
    const changed = JSON.parse(String(before.runs![0].gate_json))
    changed.policy_definition.slate_builder_version = 'retired-executable'
    await db.prepare('UPDATE strategy_route_calibration_runs_v1 SET gate_json=? WHERE run_id=?')
      .bind(JSON.stringify(changed), serving.runId).run()
    await assert.rejects(() => loadPromotedStrategyRouteCalibration(db), /runtime_version_unavailable/)
    await db.prepare('UPDATE strategy_route_calibration_runs_v1 SET gate_json=? WHERE run_id=?')
      .bind(before.runs![0].gate_json, serving.runId).run()
    await db.prepare('UPDATE strategy_route_calibration_head_v1 SET route_floor=0 WHERE singleton_id=1').run()
    assert.equal(await loadPromotedStrategyRouteCalibration(db), null)
    await assert.rejects(() => publish(db), /existing_head_invalid/)
  })
})
