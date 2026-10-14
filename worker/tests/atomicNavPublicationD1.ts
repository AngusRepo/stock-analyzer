// Original Python numerical NAV verdict -> real Worker authority -> private D1.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { adoptNavAtomicStrategy } from '../src/lib/strategyAtomicNavAdoption'
import { withPaperExecutionScope, advancePaperExecutionClock, paperExecutionNow } from '../src/lib/paperExecutionScope'
import { buildLayer1WithAtomicSource } from '../src/lib/atomicStrategyShadow'
import { strategySpecToRegistryRow, buildStrategyAdaptivePolicyState, evaluateStrategyPromotionGate } from '../src/lib/strategyLearning'
import { buildStrategyEvidenceOwnerSnapshot } from '../src/lib/strategyEvidenceOwnerFusion'
import { listStrategyEvidenceProfiles } from '../src/lib/strategyEvidenceProfile'
import { buildStrategyProductionPolicyState } from '../src/lib/strategyProductionPolicyService'
import { captureStrategyWeightSource } from '../src/lib/strategyProductionWeightReplay'
import { persistStrategyProductionPolicy, resolveRuntimeStrategyWeights, loadStrategyProductionPolicyBefore } from '../src/lib/strategyProductionPolicyStore'
import { sha256Text } from '../src/lib/datasetSnapshots'
import { atomicNavOwnsRegistry, legacyAtomicPromotionGuard } from '../src/lib/strategyAtomicNavReceipt'
import { refreshStrategyMarginalEdgeV4 } from '../src/lib/strategyMarginalEdgeV4'
import { adminConfigCoreRoutes } from '../src/routes/adminConfigCoreRoutes'
import { reconcileAtomicNavCandidates as reconcileOriginalAtomic } from '../src/lib/strategyAtomicNavLifecycle'
import { registryRowToStrategySpec } from '../src/lib/strategyLearning'
import { readStrategyNavEvidence } from '../src/lib/strategyNavEvidence'
import { adminReadRoutes } from '../src/routes/adminReadRoutes'
import { loadPromotedStrategyRouteCalibration, STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION,
  STRATEGY_ROUTE_CHALLENGER_VERSION } from '../src/lib/strategyRouteCalibration'

const original = JSON.parse(fs.readFileSync(process.env.NAV_ATOMIC_PUBLICATION_FIXTURE!, 'utf8'))
const now = new Date(original.now)
const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'isolated-nav-test-token',
  KV: { get: async () => null } } as any
const readConfig = async () => ({ tradingConfig: original.config.trading_config, riskConfig: original.config.risk_config })
const reconcileAtomicNavCandidates = (db: D1Database, bindings: any, request: any, clock: Date) =>
  reconcileOriginalAtomic(db, bindings, request, clock, readConfig)
const specIds = original.config.atomic_policy_identity.specs.map((spec: any) => spec.id)

const reconciliationRequest = { business_date: original.payload.evaluation_business_date,
  candidates: original.payloads.map((payload: any) => ({ artifact_id: payload.artifact_id,
    artifact_checksum: payload.artifact_checksum, baseline_checksum: payload.prospective_validation.nav_validation.baseline_checksum })) }
async function fixture(run: (db: D1Database, refreshSource: () => Promise<void>) => Promise<void>,
  controllerObservedAt = () => original.now, strategyResponse = (value: any) => value) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("private") } }', d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING') as unknown as D1Database
    for (const sql of original.schema) await db.prepare(sql).run()
    const inserts: D1PreparedStatement[] = []
    for (const [name, rows] of Object.entries(original.tables)) for (const row of rows as any[]) {
      const keys = Object.keys(row)
      inserts.push(db.prepare(`INSERT INTO ${name}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).bind(...Object.values(row)))
    }
    for (let start = 0; start < inserts.length; start += 50) await db.batch(inserts.slice(start, start + 50))
    const registry = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8').match(/CREATE TABLE IF NOT EXISTS strategy_spec_registry \([\s\S]*?\n  \)/)?.[0]
    assert(registry)
    await db.prepare(registry).run()
    const migration = fs.readFileSync('domain-migrations/learning/0047_atomic_nav_adoption.sql', 'utf8')
    for (const sql of migration.match(/CREATE TABLE[\s\S]*?\n\);|CREATE TRIGGER[\s\S]*?END;/g) ?? []) await db.prepare(sql).run()
    const baselineSchema = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
    for (const table of ['strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1']) {
      const ddl = baselineSchema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert(ddl)
      await db.prepare(ddl).run()
    }
    for (const sql of [
      'CREATE TABLE model_champion_pointers(model_name TEXT,champion_artifact_id TEXT)',
      'CREATE TABLE model_artifact_registry(artifact_id TEXT,model_name TEXT,state TEXT,checksum TEXT)',
      'CREATE TABLE expected_return_artifact_payloads(artifact_id TEXT,source_artifact_checksum TEXT,serving_mode TEXT)',
      'CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)',
      'CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT,validation_decision TEXT,state TEXT,production_effect INTEGER)',
      'CREATE TABLE pipeline_runs(run_id TEXT,business_date TEXT,domain TEXT,status TEXT,canonical_at TEXT,artifact_id TEXT)',
      'CREATE TABLE run_artifacts(artifact_id TEXT,r2_key TEXT,checksum TEXT,created_at TEXT,schema_version TEXT,producer_run_id TEXT,business_date TEXT,domain TEXT,status TEXT,checksum_verified_at TEXT,payload_deleted_at TEXT)',
    ]) await db.prepare(sql).run()
    const formal = original.config.formal_baseline_identity
    await db.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').bind(formal.artifact_id, formal.cohort_id, formal.payload_checksum, formal.base_artifact_set_checksum).run()
    await db.prepare("INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,'PASS','production',1)")
      .bind(formal.artifact_id, formal.cohort_id, formal.payload_checksum, formal.base_artifact_set_checksum).run()
    const specs = original.config.atomic_policy_identity.specs
    for (const spec of specs) {
      const row = strategySpecToRegistryRow(spec, '2026-09-06T12:00:00Z'), keys = Object.keys(row)
      await db.prepare(`INSERT INTO strategy_spec_registry(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).bind(...Object.values(row)).run()
    }
    const cutoff = '2026-09-20', day = original.payload.evaluation_business_date
    const summary: any = { date: cutoff, specs: specs.map((spec: any) => ({ ...spec, learning: {
      reward_owner: 'selection_edge_v4', rolling_evaluable_decisions: 76, rolling_decisions: 80,
      rolling_unavailable_decisions: 4, rolling_matched: 24, rolling_match_rate: .3, rolling_samples: 45,
      rolling_hit_rate: .6, rolling_avg_return_pct: .01, rolling_max_drawdown_pct: -.03,
      rolling_reward_dates: 12, rolling_date_return_lcb90: .001, decisions: 800,
    } })), promotion_gate: [], replacement_gate: { decisions: [], candidate_prefilters: [], evidence_status: 'pending' } }
    summary.promotion_gate = evaluateStrategyPromotionGate(summary)
    const evidenceFusion = await buildStrategyEvidenceOwnerSnapshot({ strategies: specs, knowledgeCutoffDate: cutoff,
      rows: listStrategyEvidenceProfiles(specs).flatMap(profile => profile.required_metrics.map(metric => ({
        strategy_id: profile.strategy_id, strategy_version: profile.strategy_version, primary_horizon_days: profile.primary_horizon_days,
        metric_name: metric, metric_value: .01, metric_status: 'ready', sample_count: 45, mature_dates: 12,
        outcome_as_of_date: '2026-09-18', definition_version: 'strategy-evidence-metrics-v4',
      }))) })
    const input = { knowledgeCutoffDate: cutoff, strategies: specs, gates: summary.promotion_gate,
      adaptiveState: buildStrategyAdaptivePolicyState(summary, { nowIso: cutoff + 'T12:00:00Z' }), evidenceFusion }
    const policy = buildStrategyProductionPolicyState(input)
    const weightSource = await captureStrategyWeightSource(input, policy)
    policy.evidence.evidence_owner!.weight_source = weightSource
    policy.canonical_payload = JSON.stringify({ ...JSON.parse(policy.canonical_payload), evidence_owner: policy.evidence.evidence_owner })
    const stored = await persistStrategyProductionPolicy(db, policy)
    const weights = resolveRuntimeStrategyWeights(specIds, { state: policy, checksum: stored.checksum, created_at: 'fixture' })
    const source = await buildLayer1WithAtomicSource({ universe: [], specs,
      signalDate: day, producerRunId: 'current-canonical', observedAt: day + 'T08:00:00Z', productionWeightSource: weightSource,
      options: { ...original.config.atomic_policy_identity.options,
        strategyWeights: weights.evaluationWeights, productionStrategyWeights: weights.routingWeights,
        performanceWeightOwner: weights.performanceWeightOwner } })
    const raw = JSON.stringify({ domain: 'screener_funnel', business_date: day, schema_version: 'screener-funnel-evidence-v3',
      payload: { atomic_strategy_source: source.source, items: [] } })
    const objects = new Map([['current-source', raw]])
    env.ARTIFACTS = { get: async (key: string) => {
      assert(objects.has(key), key); return { text: async () => objects.get(key)! }
    } }
    await db.prepare("INSERT INTO pipeline_runs VALUES('current-canonical',?,'screener','canonical',?,'current-artifact')").bind(day, day + 'T08:02:00Z').run()
    await db.prepare("INSERT INTO run_artifacts VALUES('current-artifact','current-source',?,?,'screener-funnel-evidence-v3','current-canonical',?,'screener_funnel','ready',?,NULL)")
      .bind(await sha256Text(raw), day + 'T08:01:00Z', day, day + 'T08:01:00Z').run()
    const refreshSource = async () => {
      const registry = (await db.prepare('SELECT * FROM strategy_spec_registry ORDER BY strategy_id').all<any>()).results!.map(registryRowToStrategySpec)
      const policy = await loadStrategyProductionPolicyBefore(db, day, registry.map(spec => spec.id))
      assert(policy && 'evidence_owner' in policy.state.evidence)
      const weights = resolveRuntimeStrategyWeights(registry.map(spec => spec.id), policy)
      const fresh = await buildLayer1WithAtomicSource({ universe: [], specs: registry,
        signalDate: day, producerRunId: 'refreshed-canonical', observedAt: day + 'T08:10:00Z',
        productionWeightSource: policy.state.evidence.evidence_owner?.weight_source,
        options: { ...original.config.atomic_policy_identity.options, strategyWeights: weights.evaluationWeights,
          productionStrategyWeights: weights.routingWeights, performanceWeightOwner: weights.performanceWeightOwner } })
      const body = JSON.stringify({ domain: 'screener_funnel', business_date: day, schema_version: 'screener-funnel-evidence-v3',
        payload: { atomic_strategy_source: fresh.source, items: [] } })
      objects.set('refreshed-source', body)
      await db.prepare("UPDATE pipeline_runs SET status='superseded' WHERE status='canonical'").run()
      await db.prepare("INSERT INTO pipeline_runs VALUES('refreshed-canonical',?,'screener','canonical',?,'refreshed-artifact')")
        .bind(day, day + 'T08:12:00Z').run()
      await db.prepare("INSERT INTO run_artifacts VALUES('refreshed-artifact','refreshed-source',?,?,'screener-funnel-evidence-v3','refreshed-canonical',?,'screener_funnel','ready',?,NULL)")
        .bind(await sha256Text(body), day + 'T08:11:00Z', day, day + 'T08:11:00Z').run()
    }
    await withPaperExecutionScope({ accountId: 1, nowMs: now.getTime(), environment: env,
      databases: { learning: db, ops: db, market: db }, fetchFrozen: async (url, init) => {
        if (String(url) === 'https://controller.invalid/nav/strategy-evidence') {
          assert.equal(new Headers(init?.headers).get('X-Controller-Token'), env.ML_CONTROLLER_SECRET)
          const request = JSON.parse(String(init?.body))
          const selected = original.strategy_evidence.find((e: any) => e.strategy_id === request.strategy_id
            && e.strategy_version === request.strategy_version && e.as_of_date === request.business_date)
          assert(selected, 'only original strategy evidence may be displayed')
          return Response.json(strategyResponse(structuredClone(selected)))
        }
        assert.equal(String(url), 'https://controller.invalid/nav/policy-decision')
        assert.equal(new Headers(init?.headers).get('X-Controller-Token'), env.ML_CONTROLLER_SECRET)
        const request = JSON.parse(String(init?.body))
        const selected = original.payloads.find((payload: any) => payload.artifact_id === request.candidate_artifact_id)
        assert(selected, 'only original frozen Python candidates may be read')
        assert.deepEqual(request, { owner: 'atomic_strategy',
          candidate_artifact_id: selected.artifact_id, candidate_checksum: selected.artifact_checksum,
          business_date: original.payload.evaluation_business_date })
        return Response.json({ schema_version: 'paired-nav-policy-decision-response-v1', owner: 'atomic_strategy',
          observed_at: controllerObservedAt(), payload: selected, source: 'original_frozen_policy_and_verified_nav', read_only: true })
      } }, () => run(db, refreshSource))
  } finally { await mf.dispose() }
}

const publish = (db: D1Database) => adoptNavAtomicStrategy(db, env, original.payload, readConfig, now)
test('strategy evidence rejects altered identity, omitted comparisons and changed original NAV bytes', async () => {
  let mutate = (value: any) => value
  await fixture(async db => {
    const source = original.strategy_evidence[0]
    const input = { strategy_id: source.strategy_id, strategy_version: source.strategy_version, business_date: source.as_of_date }
    const before = await state(db)
    for (const change of [
      (v: any) => { v.strategy_version = 'wrong' },
      (v: any) => { v.entries.pop() },
      (v: any) => { v.entries[0].nav.decision_payload_json += ' ' },
      (v: any) => { v.entries[0].nav.mean_daily_nav_delta = -99 },
      (v: any) => { v.entries[0].artifact_checksum = '0'.repeat(64) },
    ]) {
      mutate = value => { change(value); return value }
      await assert.rejects(() => readStrategyNavEvidence(env, input), /strategy_nav_original_evidence_invalid/)
      assert.deepEqual(await state(db), before)
    }
  }, () => original.now, value => mutate(value))
})
const readOnly = (db: D1Database) => new Proxy(db, { get(target, key) {
  if (key === 'prepare') return (sql: string) => { assert.match(sql, /^\s*SELECT\b/i); return target.prepare(sql) }
  if (key === 'batch' || key === 'exec') return () => assert.fail('lifecycle reconciliation must not write')
  const value = Reflect.get(target, key)
  return typeof value === 'function' ? value.bind(target) : value
} }) as D1Database
test('Atomic publication uses request clock after receipt lookup, not the earlier cutoff', async () => {
  for (const futureResponse of [false, true]) await fixture(async db => {
    const before = await state(db)
    let delayed = false
    const slow = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (!delayed) { delayed = true; advancePaperExecutionClock(paperExecutionNow() + 1000) }
        return target.prepare(sql)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    if (futureResponse) {
      await assert.rejects(() => publish(slow), /policy_original_decision_changed/)
      assert.deepEqual(await state(db), before)
    } else {
      const result = await publish(slow)
      assert.equal(result.pointer_committed, true)
      assert.equal((await state(db)).receipts!.length, 1)
    }
  }, () => new Date(paperExecutionNow() + (futureResponse ? 60_000 : 0)).toISOString())
})

test('Atomic admin API requires real service authentication before any data access', async () => {
  const bindings = { STOCKVISION_AUTH_TOKEN: 'atomic-local-test-service-token', ENVIRONMENT: 'production' } as any
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
    const response = await adminReadRoutes.request('https://fixture.invalid/api/admin/strategy/nav-evidence', { headers }, bindings)
    assert.equal(response.status, 401)
  }
  assert.equal((await adminReadRoutes.request('https://fixture.invalid/api/admin/strategy/nav-evidence', {
    headers: { authorization: 'Bearer atomic-local-test-service-token' } }, bindings)).status, 400)
  for (const route of ['promote', 'reconcile']) {
  const path = 'https://fixture.invalid/api/admin/config/strategy-atomic/' + route
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
    const response = await adminConfigCoreRoutes.request(path, { method: 'POST', headers, body: '{}' }, bindings)
    assert.equal(response.status, 401)
  }
  const malformed = await adminConfigCoreRoutes.request(path, { method: 'POST',
    headers: { authorization: 'Bearer atomic-local-test-service-token' }, body: '{' }, bindings)
  assert.equal(malformed.status, 400)
  }
})
const state = async (db: D1Database) => ({
  registry: (await db.prepare('SELECT * FROM strategy_spec_registry ORDER BY strategy_id').all()).results,
  policies: (await db.prepare('SELECT * FROM strategy_production_policy_history_v1 ORDER BY checksum').all()).results,
  receipts: (await db.prepare('SELECT * FROM strategy_atomic_nav_adoptions_v1').all()).results,
})

test('original numerical NAV PASS atomically publishes original registry, weights and immutable receipt', async () => fixture(async db => {
  const before = await state(db)
  const readEvidence = async () => Promise.all(original.strategy_evidence.map(async (source: any) => {
    const displayed = await readStrategyNavEvidence(env, { strategy_id: source.strategy_id,
      strategy_version: source.strategy_version, business_date: source.as_of_date })
    assert.deepEqual(displayed.entries.map(({ publication, ...entry }: any) => entry), source.entries)
    return displayed
  }))
  const shadow = await readEvidence()
  assert(shadow.every(e => e.current_replacement_owner === 'legacy_atomic_v7'))
  assert(shadow.every(e => e.entries.every((entry: any) => entry.publication === null)))
  assert.deepEqual(await state(db), before)
  const uncommitted = await reconcileAtomicNavCandidates(readOnly(db), env, reconciliationRequest, now)
  assert(uncommitted.entries.every(row => row.state === 'candidate'))
  assert.deepEqual(await state(db), before)
  const result = await publish(db)
  assert.equal(result.complete, true)
  assert.equal(result.serving_activation_verified, false)
  const after = await state(db), replacement = original.payload.policy_definition.replacement
  const adoptedEvidence = await readEvidence()
  assert(adoptedEvidence.every(e => e.current_replacement_owner === 'original_paired_daily_nav'))
  assert(adoptedEvidence.some(e => e.entries.some((entry: any) => entry.publication?.historical_publication_verified)))
  assert.deepEqual(await state(db), after)
  fs.writeFileSync(process.env.NAV_ATOMIC_PUBLICATION_FIXTURE! + '.strategy.json', JSON.stringify({ shadow, adopted: adoptedEvidence }))
  assert.equal(after.registry!.find((row: any) => row.strategy_id === replacement.candidateId)!.status, 'active')
  assert.equal(after.registry!.find((row: any) => row.strategy_id === replacement.incumbentId)!.status, 'candidate')
  assert.equal(result.policy.weights[replacement.candidateId], 1)
  assert.equal(result.policy.weights[replacement.incumbentId], 0)
  assert.equal(after.policies!.length, before.policies!.length + 1)
  assert.equal(after.receipts!.length, 1)
  const serving = await loadStrategyProductionPolicyBefore(db, '2099-01-01', specIds)
  assert.equal(serving?.checksum, result.policy.checksum)
  const again = await publish(db)
  assert.equal(again.recovered_existing_commit, true)
  assert.equal(again.publication_receipt_checksum, result.publication_receipt_checksum)
  assert.deepEqual(await state(db), after)
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM model_artifact_registry').first<any>()).n, 0)
  console.log('NAV_ATOMIC_PUBLICATION_RESULT=' + JSON.stringify(result))
  const committed = await reconcileAtomicNavCandidates(readOnly(db), env, reconciliationRequest, now)
  assert.equal(committed.entries.filter(row => row.state === 'published').length, 1)
  assert(committed.entries.filter(row => row.artifact_id !== original.payload.artifact_id).every(row => row.state === 'awaiting_current_source'))
  assert.deepEqual(await state(db), after)
  console.log('NAV_ATOMIC_RECONCILIATION=' + JSON.stringify({ before: uncommitted, after: committed }))
}))

test('a failure at every native batch statement leaves no partial registry, policy or receipt', async () => fixture(async db => {
  const before = await state(db)
  let count = 0
  for (let index = 0; index === 0 || index < count; index++) {
    const faulty = new Proxy(db, { get(target, key) {
      if (key === 'batch') return (statements: D1PreparedStatement[]) => {
        count = statements.length
        return target.batch(statements.map((s, i) => i === index ? target.prepare("SELECT json('injected_atomic_failure')") : s))
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    await assert.rejects(() => publish(faulty), /injected_atomic_failure|malformed JSON/)
    assert.deepEqual(await state(db), before)
  }
  assert(count >= 14)
}))

test('lost acknowledgement recovers committed receipt without changing timestamps or NAV reviews', async () => fixture(async db => {
  const reviews = (await db.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()).results
  const lost = new Proxy(db, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => { await target.batch(statements); throw new Error('fixture_ack_lost') }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as D1Database
  await assert.rejects(() => publish(lost), /fixture_ack_lost/)
  const before = await state(db)
  assert.equal((await publish(db)).recovered_existing_commit, true)
  assert.deepEqual(await state(db), before)
  assert.deepEqual((await db.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()).results, reviews)
  await assert.rejects(() => db.prepare("UPDATE strategy_atomic_nav_adoptions_v1 SET receipt_json='{}'").run(), /immutable_receipt/)
  await assert.rejects(() => db.prepare('DELETE FROM strategy_atomic_nav_adoptions_v1').run(), /immutable_receipt/)
}))

test('registry, formal ML and journal races abort the entire adoption', async () => {
  for (const change of ['registry', 'formal', 'journal']) await fixture(async db => {
    const raced = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (change === 'registry') await target.prepare("UPDATE strategy_spec_registry SET thesis='changed'").run()
        else if (change === 'formal') await target.prepare("UPDATE active8_ensemble_pointer_v1 SET artifact_id='changed'").run()
        else await target.prepare("UPDATE paired_nav_daily_journal_v1 SET payload_checksum=? WHERE session_date='2026-09-21'").bind('f'.repeat(64)).run()
        return target.batch(statements)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    await assert.rejects(() => publish(raced))
    const after = await state(db)
    assert.equal(after.receipts!.length, 0)
    assert.equal(after.policies!.length, 1)
    assert.equal(after.registry!.filter((row: any) => row.status === 'active').length, 1)
  })
})

test('caller PASS, altered live risk, and missing current canonical source cannot adopt', async () => fixture(async db => {
  const before = await state(db), changed = structuredClone(original.payload)
  changed.prospective_validation.nav_validation.evaluable_date_count++
  await assert.rejects(() => adoptNavAtomicStrategy(db, env, changed, readConfig, now), /original_decision_changed/)
  await assert.rejects(() => adoptNavAtomicStrategy(db, env, original.payload,
    async () => ({ ...await readConfig(), riskConfig: { changed: true } }), now), /configuration_changed/)
  await db.prepare("UPDATE pipeline_runs SET status='superseded'").run()
  await assert.rejects(() => publish(db), /current_canonical_ambiguous_or_missing/)
  assert.deepEqual(await state(db), before)
}))

test('Atomic cannot combine its old NAV comparison with a different serving Route before or during commit', async () => {
  for (const moment of ['before', 'inside_batch']) await fixture(async db => {
    const changeRoute = async () => {
      await db.batch([
        db.prepare(`INSERT INTO strategy_route_calibration_runs_v1
          (run_id,artifact_version,as_of_date,status,candidate_route_version,route_floor,sample_count,date_count,gate_json)
          VALUES('other-serving-route',?,?,'promoted',?,30,100,20,'{}')`)
          .bind(STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION, original.payload.evaluation_business_date, STRATEGY_ROUTE_CHALLENGER_VERSION),
        db.prepare(`INSERT INTO strategy_route_calibration_head_v1
          (singleton_id,run_id,artifact_version,candidate_route_version,route_floor)
          VALUES(1,'other-serving-route',?,?,30)`)
          .bind(STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION, STRATEGY_ROUTE_CHALLENGER_VERSION),
      ])
      assert.equal((await loadPromotedStrategyRouteCalibration(db))?.runId, 'other-serving-route',
        'the original serving reader really observes a different executable route')
    }
    if (moment === 'before') await changeRoute()
    const raced = moment === 'before' ? db : new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => { await changeRoute(); return target.batch(statements) }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as D1Database
    const prior = await state(db)
    await assert.rejects(() => publish(raced), /strategy_atomic_nav_route_changed|malformed JSON/)
    assert.deepEqual(await state(db), prior, 'registry, weights and receipt must not partially publish')
    const waiting = await reconcileAtomicNavCandidates(readOnly(db), env, reconciliationRequest, now)
    assert.equal(waiting.route_dependency_matches_canonical, false)
    assert(waiting.entries.every(entry => entry.state === 'awaiting_current_source'))
    assert(waiting.entries.every(entry => entry.reason === 'route_publication_after_current_canonical'))
    assert.equal(waiting.nav_maturity_credit, 0)
    if (moment === 'before') console.log('NAV_ATOMIC_POST_ROUTE_RECONCILIATION=' + JSON.stringify(waiting))
  })
})

test('NAV authority keeps legacy refresh diagnostic and rejects a racing legacy cutover', async () => fixture(async db => {
  assert.equal(await atomicNavOwnsRegistry(db), false)
  const legacyStatements = [legacyAtomicPromotionGuard(db),
    db.prepare("UPDATE strategy_spec_registry SET thesis='legacy-overwrite'")]
  await publish(db)
  assert.equal(await atomicNavOwnsRegistry(db), true)
  const before = await state(db)
  await assert.rejects(() => db.batch(legacyStatements), /malformed JSON/)
  assert.deepEqual(await state(db), before)
  const schema = fs.readFileSync('schema.sql', 'utf8')
  for (const name of ['strategy_marginal_edge_runs_v4', 'strategy_marginal_edge_v4',
    'strategy_marginal_edge_dates_v4', 'strategy_marginal_edge_head_v4', 'strategy_replacement_decisions_v5']) {
    const sql = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert(sql, name)
    await db.prepare(sql).run()
  }
  const result = await refreshStrategyMarginalEdgeV4(db, original.payload.evaluation_business_date, { allowPromotion: true })
  assert.equal(result.status, 'shadow')
  assert.deepEqual(await state(db), before)
  const run = await db.prepare('SELECT evidence_json FROM strategy_marginal_edge_runs_v4 WHERE run_id=?').bind(result.runId).first<any>()
  assert.equal(JSON.parse(run.evidence_json).replacement_owner, 'original_paired_daily_nav')
}))

test('fresh canonical source preserves publication and exposes changed comparator without re-promoting old PASS', async () => fixture(async (db, refreshSource) => {
  await publish(db)
  const before = await state(db)
  await refreshSource()
  const result = await reconcileAtomicNavCandidates(db, env, reconciliationRequest, now)
  assert.equal(result.entries.filter(row => row.state === 'published').length, 1)
  const publishedEntry = result.entries.find(row => row.state === 'published')!
  assert.equal(publishedEntry.execution_observation?.executed, true)
  assert.equal(publishedEntry.execution_observation?.orders_executed_verified, false)
  assert.equal(publishedEntry.execution_observation?.scope, 'canonical_l1_l15_selection')
  console.log('NAV_ATOMIC_EXECUTION_RECONCILIATION=' + JSON.stringify(result))
  assert(result.entries.filter(row => row.artifact_id !== original.payload.artifact_id).every(row => row.state === 'baseline_changed'))
  assert.deepEqual(await state(db), before)
  assert.equal((await publish(db)).recovered_existing_commit, true)
  // Caller cannot replace the comparator sealed by the original decision.
  const changed = structuredClone(reconciliationRequest)
  const other = changed.candidates.find((row: any) => row.artifact_id !== original.payload.artifact_id)!
  other.baseline_checksum = result.canonical_policy_checksum
  await assert.rejects(() => reconcileAtomicNavCandidates(db, env, changed, now), /original_baseline_changed/)
  assert.deepEqual(await state(db), before)
}))

test('Atomic reconciliation distinguishes changed ML/config from corrupt sources without writing or replacing NAV', async () => {
  for (const fault of ['ml', 'trading', 'risk', 'missing_config', 'corrupt_ml', 'config_race']) await fixture(async db => {
    const config = structuredClone(await readConfig())
    if (fault === 'ml' || fault === 'corrupt_ml') {
      await db.prepare("UPDATE active8_ensemble_pointer_v1 SET artifact_id='new-formal'").run()
      if (fault === 'ml') await db.prepare("UPDATE active8_ensemble_artifacts_v1 SET artifact_id='new-formal'").run()
    }
    if (fault === 'trading') config.tradingConfig.fixture_changed_allocation = true
    if (fault === 'risk') config.riskConfig.fixture_changed_risk = true
    if (fault === 'missing_config') config.riskConfig = null
    const before = await state(db)
    const journals = (await db.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY session_date,pair_id').all()).results
    const reviews = (await db.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()).results
    let reads = 0
    const reader = async () => {
      reads++
      return fault === 'config_race' && reads > 1
        ? { ...config, riskConfig: { ...config.riskConfig, fixture_race: true } } : config
    }
    if (['missing_config', 'corrupt_ml', 'config_race'].includes(fault)) {
      await assert.rejects(() => reconcileOriginalAtomic(readOnly(db), env, reconciliationRequest, now, reader),
        /current_context_missing|current_ml_baseline_changed|execution_context_changed/)
    } else {
      const result = await reconcileOriginalAtomic(readOnly(db), env, reconciliationRequest, now, reader)
      assert(result.entries.every(row => row.state === 'baseline_changed'))
      assert(result.entries.every(row => row.reason === (fault === 'ml' ? 'ml_baseline_changed' : 'configuration_changed')))
      assert.equal(result.nav_maturity_credit, 0)
      assert.equal(result.promotion_allowed, false)
      console.log('NAV_ATOMIC_POST_DEPENDENCY_' + fault.toUpperCase() + '=' + JSON.stringify(result))
    }
    assert.deepEqual(await state(db), before)
    assert.deepEqual((await db.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY session_date,pair_id').all()).results, journals)
    assert.deepEqual((await db.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()).results, reviews)
  })
})

test('reconciliation rejects unexplained registry changes and corrupted original publication policy', async () => {
  for (const fault of ['registry', 'policy']) await fixture(async db => {
    await publish(db)
    if (fault === 'registry') await db.prepare("UPDATE strategy_spec_registry SET thesis='unexplained'").run()
    else await db.prepare("UPDATE strategy_production_policy_history_v1 SET strategy_weights_json='{}'").run()
    const before = await state(db)
    await assert.rejects(() => reconcileAtomicNavCandidates(db, env, reconciliationRequest, now))
    await assert.rejects(() => publish(db))
    assert.deepEqual(await state(db), before)
  })
})
