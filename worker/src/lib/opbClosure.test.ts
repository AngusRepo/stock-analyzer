import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Bindings } from '../types'
import { ALLOCATOR_EV_FUSION_CONTRACT as F, L4_ALPHA_EV_CONTRACT as L } from './evidenceContracts'
import { NAV_GATE_SCHEMA } from './pairedNavPromotionEvidence'
import { runOpbArmPriorRefresh } from './controllerResearchWorkflows'
import { mergeAlphaFrameworkConfig } from './tradingConfig'
import { runDailyAllocatorEvReadiness } from './updateOrchestrator'

// Real canonical SQL/registry hydration; these are serving-identity fixtures,
// not statistical evidence or approval to publish an OPB prior.
function servingFixture(t: { after: (fn: () => void) => void }, mode = 'l4') {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
  for (const table of ['model_artifact_registry', 'model_champion_pointers',
    'expected_return_artifact_payloads', 'expected_return_owner_state_v2', 'expected_return_forward_guard_state']) {
    const statement = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert(statement, `missing original schema: ${table}`)
    sql.exec(statement)
  }
  const base: any = { expected_return_owner: 'l4_alpha_ev', model_version: 'fixture-l4',
    promotion_state: 'production_approved', validation_packet: { decision: 'PASS' }, output_is_net_of_costs: true,
    artifact_contract_version: L.artifactContractVersion, feature_semantic_version: L.featureSemanticVersion,
    label_schema_version: L.labelSchemaVersion }
  const residual: any = { expected_return_owner: 'allocator_ev_fusion', model_version: 'fixture-fusion',
    model_fingerprint: 'd'.repeat(64), promotion_state: 'production_primary',
    primary_expected_return_allowed: true, validation_packet: { decision: 'PASS' }, output_is_net_of_costs: true,
    artifact_contract_version: F.artifactContractVersion, feature_semantic_version: F.featureSemanticVersion,
    label_schema_version: F.labelSchemaVersion, policy_value_head_count: 1,
    policy_value_heads: ['residual_adjustment_model'], residual_adjustment_model: { coefficients: { l4_expected_return: .6 } },
    prospective_validation: { schema_version: NAV_GATE_SCHEMA,
      nav_validation: { baseline_checksum: (mode === 'changed_l4' ? 'b' : 'a').repeat(64) } } }
  function insert(artifact: any, checksum: string) {
    const owner = artifact.expected_return_owner, version = artifact.model_version
    const id = `${owner}:${version}:${checksum.repeat(64)}`, raw = JSON.stringify(artifact)
    sql.prepare('INSERT INTO model_artifact_registry (artifact_id,model_name,version,candidate_type,state) VALUES (?,?,?,?,?)')
      .run(id, owner, version, `${owner}_refresh`, 'production')
    sql.prepare('INSERT INTO model_champion_pointers (model_name,champion_version,champion_artifact_id) VALUES (?,?,?)')
      .run(owner, version, id)
    sql.prepare('INSERT INTO expected_return_artifact_payloads (artifact_id,model_name,model_version,serving_mode,artifact_json,payload_checksum) VALUES (?,?,?,?,?,?)')
      .run(id, owner, version, 'alpha', raw, createHash('sha256').update(raw).digest('hex'))
    sql.prepare('INSERT INTO expected_return_owner_state_v2 (owner,owner_state,champion_artifact_id,reason_code,contract_manifest_version) VALUES (?,?,?,?,?)')
      .run(owner, 'learned_champion', id, 'fixture', 'fixture')
    return id
  }
  if (mode !== 'none') insert(base, 'a')
  if (['fusion', 'changed_l4', 'guarded'].includes(mode)) {
    const id = insert(residual, 'c')
    if (mode === 'guarded') sql.prepare(`INSERT INTO expected_return_forward_guard_state
      (model_name,artifact_id,model_fingerprint,model_version,state,last_prediction_date,evidence_json)
      VALUES (?,?,?,?,?,?,?)`).run('allocator_ev_fusion', id, 'd'.repeat(64), 'fixture-fusion', 'residual_bypass', '2026-09-09', '{}')
  }
  const db = { prepare(query: string) {
    const statement = sql.prepare(query)
    let params: any[] = []
    return { bind(...values: any[]) { params = values; return this },
      async all() { return { results: statement.all(...params) } },
      async first() { return statement.get(...params) ?? null } }
  } } as unknown as D1Database
  const env = { ML_CONTROLLER_URL: 'https://isolated.invalid', LEARNING_DB: db,
    DB: { prepare() { throw new Error('legacy DB must not be read') } },
    MULTI_D1_ACTIVE_DOMAINS: 'learning', MULTI_D1_STRICT: 'true',
    KV: { async get() { return { ensemble_v2: { allocatorEvFusion: residual } } } },
  } as unknown as Bindings
  return { env, sql }
}

const good = {
  schema_version: 'opb-candidate-registration-v1', completion_scope: 'candidate_registration',
  status: 'candidate_registered', promotion_owner: 'daily_nav', production_mutation_allowed: false,
  promoted: false, registry_verified: true, config_projection_verified: false, artifact_checksum: 'a'.repeat(64),
  registry_error: null, promotion_error: null, rows_loaded: 42, price_rows_loaded: 100,
  artifact: { artifact_id: 'opb_arm_prior:test', expected_return_owner: 'l4_alpha_ev', trained_until: '2026-09-09',
    validation: { decision: 'PASS', failed_checks: [] } },
}

test('readiness observes canonical state without generating candidates or replacing refresh receipts', async (t) => {
  const { env, sql } = servingFixture(t)
  const learning = readFileSync('domain-schemas/learning.sql', 'utf8')
  const market = readFileSync('domain-schemas/market.sql', 'utf8')
  for (const [schema, table] of [[learning, 'active8_oof_cohorts'],
    [learning, 'active8_oof_materialized_artifacts'], [market, 'canonical_market_daily']]) {
    const statement = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert(statement, `missing original schema: ${table}`)
    sql.exec(statement)
  }
  for (const file of ['0003_learning_active8_forward_extension.sql', '0017_active8_forward_evaluability.sql']) {
    sql.exec(readFileSync(`domain-migrations/learning/${file}`, 'utf8'))
  }
  const store = new Map<string, string>([['trading:config', '{}']])
  const date = '2026-09-09'
  const jobs = ['l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'opb-arm-prior-refresh']
  for (const job of jobs) {
    store.set(`scheduler:run:${job}:${date}`, JSON.stringify({ status: 'error', summary: 'original generation failed' }))
    store.set(`cron:log:${job}`, JSON.stringify({ status: 'error', summary: 'original generation failed' }))
  }
  const original = new Map(store)
  const writes: string[] = []
  env.MARKET_DB = env.LEARNING_DB
  env.MULTI_D1_ACTIVE_DOMAINS = 'learning,market'
  env.KV = {
    async get(key: string, kind?: string) {
      const value = store.get(key) ?? null
      return value !== null && kind === 'json' ? JSON.parse(value) : value
    },
    async put(key: string, value: string) { writes.push(key); store.set(key, value) },
  } as unknown as KVNamespace
  const changes = sql.prepare('SELECT total_changes() AS n').get()!.n
  const saved = globalThis.fetch
  t.after(() => { globalThis.fetch = saved })
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('readiness must not invoke generation') }
  const result = await runDailyAllocatorEvReadiness(env, date, { runId: 'readiness-original-fixture' })
  // Missing canonical sessions remain a genuine error, not a fabricated PASS.
  assert.equal(result.state, 'fatal')
  assert.match(result.summary, /oof_expected_mature_signal_date_unresolved/)
  assert.match(result.summary, /opb_candidate_registration=ev_adoption_event/)
  assert.equal(requests, 0)
  assert.equal(sql.prepare('SELECT total_changes() AS n').get()!.n, changes)
  for (const [key, value] of original) assert.equal(store.get(key), value, `overwrote ${key}`)
  assert(writes.includes(`scheduler:run:allocator-ev-readiness:${date}`))
  assert(!writes.some((key) => jobs.some((job) => key.includes(job))))
})
for (const [name, patch] of Object.entries({
  registry_error: { registry_error: 'fixture_registry_down' },
  registry_unverified: { registry_verified: false },
  legacy_publication: { promoted: true, config_projection_verified: true },
  mutation_allowed: { production_mutation_allowed: true },
  missing_scope: { completion_scope: null },
  wrong_schema: { schema_version: 'old' },
  missing_checksum: { artifact_checksum: null },
  projection_error: { promotion_error: 'fixture_put_failed' },
  wrong_owner: { artifact: { ...good.artifact, expected_return_owner: 'allocator_ev_fusion' } },
  wrong_date: { artifact: { ...good.artifact, trained_until: '2026-09-08' } },
  incomplete_registration: { status: 'registration_incomplete' },
})) {
  test(`OPB cannot report success with ${name}`, async (t) => {
    const { env } = servingFixture(t)
    const saved = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ ...good, ...patch }))
    try {
      await assert.rejects(runOpbArmPriorRefresh(
        env, '2026-09-09', 'l4_alpha_ev'), /closure|identity|opb_arm_prior_refresh/)
    } finally { globalThis.fetch = saved }
  })
}
test('OPB registration retains actual owner without demanding promotion', async (t) => {
  const { env } = servingFixture(t)
  const saved = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(good))
  try {
    const result = await runOpbArmPriorRefresh(
      env, '2026-09-09', 'l4_alpha_ev')
    assert.match(result, /status=candidate_registered owner=l4_alpha_ev date=2026-09-09/)
    assert.match(result, /scope=candidate_registration/)
    assert.match(result, /promoted=0/)
  } finally { globalThis.fetch = saved }
})

for (const mode of ['l4', 'fusion', 'changed_l4', 'guarded']) {
  test(`OPB auto follows canonical serving (${mode}), not stale KV`, async (t) => {
    const { env } = servingFixture(t, mode)
    const expected = mode === 'fusion' ? 'allocator_ev_fusion' : 'l4_alpha_ev'
    const saved = globalThis.fetch
    t.after(() => { globalThis.fetch = saved })
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      assert.equal(JSON.parse(String(init?.body)).expected_return_owner, expected)
      assert.equal(JSON.parse(String(init?.body)).promote, false)
      assert.equal(JSON.parse(String(init?.body)).dry_run, false)
      assert.equal(JSON.parse(String(init?.body)).reuse_registered, true)
      return new Response(JSON.stringify({ ...good, artifact: { ...good.artifact, expected_return_owner: expected } }))
    }
    assert.match(await runOpbArmPriorRefresh(env, '2026-09-09'), new RegExp(`owner=${expected}`))
    assert.equal(calls, 1)
  })
}

test('offline FAIL remains visible and does not fail healthy registration', async (t) => {
  const { env } = servingFixture(t)
  const saved = globalThis.fetch
  t.after(() => { globalThis.fetch = saved })
  globalThis.fetch = async () => new Response(JSON.stringify({ ...good,
    artifact: { ...good.artifact, validation: { decision: 'FAIL', failed_checks: ['insufficient_dates'] } } }))
  const result = await runOpbArmPriorRefresh(env, '2026-09-09')
  assert.match(result, /promoted=0/)
  assert.match(result, /failed_checks=insufficient_dates/)
})

if (process.env.NAV_OPB_REFRESH_FIXTURE) {
  test('original Python registry receipts cross actual Worker summary boundary', async (t) => {
    const path = process.env.NAV_OPB_REFRESH_FIXTURE!
    const responses = JSON.parse(readFileSync(path, 'utf8'))
    const { env } = servingFixture(t)
    const saved = globalThis.fetch
    t.after(() => { globalThis.fetch = saved })
    const summaries = []
    for (const response of responses) {
      globalThis.fetch = async () => new Response(JSON.stringify(response))
      summaries.push(await runOpbArmPriorRefresh(env, '2026-09-09'))
    }
    writeFileSync(path + '.summaries.json', JSON.stringify(summaries))
  })
}
for (const mode of ['l4', 'changed_l4', 'guarded', 'none']) {
  test(`explicit inactive Fusion cannot bypass canonical owner (${mode})`, async (t) => {
    const { env } = servingFixture(t, mode)
    const saved = globalThis.fetch
    t.after(() => { globalThis.fetch = saved })
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(good)) }
    await assert.rejects(runOpbArmPriorRefresh(env, '2026-09-09', 'allocator_ev_fusion'), /serving_owner_mismatch|requires a contract-compatible/)
    assert.equal(calls, 0)
  })
}

for (const alias of ['opbArmPrior', 'opb_arm_prior']) {
  test(`config normalization must retain ${alias} for the actual Python allocator`, () => {
    const artifact = { ...good.artifact, artifact_id: 'opb_arm_prior:test', arm_priors: [{ arm_id: 'balanced' }] }
    const normalized = mergeAlphaFrameworkConfig({ allocation: { [alias]: artifact } })
    assert.deepEqual((normalized.allocation as any).opbArmPrior, artifact)
    assert.deepEqual(mergeAlphaFrameworkConfig(normalized), normalized)
    assert.equal('opb_arm_prior' in normalized.allocation, false)
  })
}
test('absent prior preserves default shape; explicit null clears; malformed values reject', () => {
  assert.equal('opbArmPrior' in mergeAlphaFrameworkConfig({}).allocation, false)
  assert.equal(mergeAlphaFrameworkConfig({ allocation: { opbArmPrior: null } }).allocation.opbArmPrior, null)
  for (const prior of [[], 42, 'not-an-artifact']) {
    assert.throws(() => mergeAlphaFrameworkConfig({ allocation: { opbArmPrior: prior } }), /opb_arm_prior_config_invalid/)
  }
})
