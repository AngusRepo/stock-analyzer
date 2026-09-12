// Private native D1 only. No credentials, remote bindings or production writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { buildStrategyProductionContributionFirewall } from '../src/lib/strategyProductionContributionFirewall'
import { loadStrategyProductionPolicyBefore, persistStrategyProductionPolicy,
  loadStrategyProductionPolicyForHistoricalReconstructionBefore,
  prepareStrategyProductionPolicyWrite,
  sha256StrategyProductionPolicyPayload } from '../src/lib/strategyProductionPolicyStore'

const ids = ['incumbent', 'other']
const makeState = () => buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-09-07',
  strategies: ids.map(id => ({ id, status: 'active' })),
  gates: ids.map(strategy_id => ({ strategy_id, decision: 'active_monitor', allocation_eligible: true })),
  base: { source: 'adaptive_strategy_policy_v2', run_id: 'original-owner',
    weights: { incumbent: 0.6, other: 0.4 }, evidence_owner: {
      version: 'strategy-evidence-owner-fusion-v3', checksum: 'a'.repeat(64),
      weight_effect: 'immutable_oos_calibrated_bounded_bidirectional', ready_profile_count: 2,
      calibration_run_id: 'original-calibration', calibration_artifact_checksum: 'b'.repeat(64),
      strategy_decisions: { incumbent: { primary_horizon_days: 5, performance_state: 'full',
        performance_reason: 'original', negative_calibration_streak: 0, positive_calibration_streak: 1,
        multi_horizon_score: 0.01, weight_multiplier: 1, contribution_mode: 'full' } },
    } },
})

async function fixture(run: (db: D1Database) => Promise<void>) {
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("private") } }', d1Databases: ['LEARNING'] })
  try { await run(await mf.getD1Database('LEARNING') as unknown as D1Database) }
  finally { await mf.dispose() }
}
const rows = async (db: D1Database) => (await db.prepare(
  'SELECT * FROM strategy_production_policy_history_v1 ORDER BY checksum').all<any>()).results
async function original(db: D1Database) {
  const state = makeState()
  await persistStrategyProductionPolicy(db, state)
  // This is an explicit synthetic fixture availability timestamp, not a backfill.
  await db.prepare("UPDATE strategy_production_policy_history_v1 SET created_at='2026-09-07T14:00:00.000Z'").run()
  return state
}

test('original policy round-trips and retry preserves immutable availability', async () => fixture(async db => {
  const state = await original(db), before = await rows(db)
  const loaded = await loadStrategyProductionPolicyBefore(db, '2026-09-08', ids)
  assert.deepEqual(loaded?.state.strategy_weights, state.strategy_weights)
  assert.equal(loaded?.checksum, await sha256StrategyProductionPolicyPayload(state.canonical_payload))
  assert.equal((await persistStrategyProductionPolicy(db, state)).inserted, false)
  const equivalent = structuredClone(state)
  equivalent.strategy_weights = Object.fromEntries(Object.entries(state.strategy_weights).reverse())
  equivalent.evidence = Object.fromEntries(Object.entries(state.evidence).reverse()) as typeof state.evidence
  assert.equal((await persistStrategyProductionPolicy(db, equivalent)).inserted, false)
  assert.deepEqual(await rows(db), before)
  assert.equal(await loadStrategyProductionPolicyBefore(db, '2026-09-07', ids), null)
  await db.prepare("UPDATE strategy_production_policy_history_v1 SET created_at='2026-09-07T16:00:00.000Z'").run()
  assert.equal(await loadStrategyProductionPolicyBefore(db, '2026-09-08', ids), null)
  assert(await loadStrategyProductionPolicyBefore(db, '2026-09-09', ids))
}))

test('serving rejects weights that differ from the sealed policy', async () => fixture(async db => {
  await original(db)
  await db.prepare('UPDATE strategy_production_policy_history_v1 SET strategy_weights_json=?')
    .bind(JSON.stringify({ incumbent: 0.1, other: 0.9 })).run()
  await assert.rejects(() => loadStrategyProductionPolicyBefore(db, '2026-09-08', ids), /canonical_parity_failed/)
}))

test('serving verifies raw canonical checksum, not just a valid-looking row', async () => fixture(async db => {
  await original(db)
  await db.prepare('UPDATE strategy_production_policy_history_v1 SET checksum=?').bind('0'.repeat(64)).run()
  await assert.rejects(() => loadStrategyProductionPolicyBefore(db, '2026-09-08', ids), /checksum_mismatch/)
}))

test('serving and historical reconstruction verify the complete evidence owner', async () => fixture(async db => {
  const state = await original(db)
  for (const edit of [
    (owner: any) => { owner.calibration_artifact_checksum = 'c'.repeat(64) },
    (owner: any) => { owner.strategy_decisions.incumbent.weight_multiplier = 1.25 },
    (owner: any) => { owner.strategy_decisions.incumbent.performance_state = 'cooldown' },
  ]) {
    const evidence = structuredClone(state.evidence)
    edit(evidence.evidence_owner)
    await db.prepare('UPDATE strategy_production_policy_history_v1 SET evidence_json=?').bind(JSON.stringify(evidence)).run()
    await assert.rejects(() => loadStrategyProductionPolicyBefore(db, '2026-09-08', ids), /canonical_parity_failed/)
    await assert.rejects(() => loadStrategyProductionPolicyForHistoricalReconstructionBefore(db, '2026-09-08', ids),
      /canonical_parity_failed/)
  }
}))

test('writer rejects mutated inputs before persisting a new policy', async () => fixture(async db => {
  await original(db)
  const before = await rows(db), malformed = makeState()
  malformed.strategy_weights.incumbent = 0.9
  await assert.rejects(() => persistStrategyProductionPolicy(db, malformed), /canonical_parity_failed/)
  assert.deepEqual(await rows(db), before)
}))

test('a duplicate checksum with conflicting stored content is not a successful retry', async () => fixture(async db => {
  const state = await original(db)
  await db.prepare('UPDATE strategy_production_policy_history_v1 SET strategy_weights_json=?')
    .bind(JSON.stringify({ incumbent: 0.1, other: 0.9 })).run()
  const before = await rows(db)
  await assert.rejects(() => persistStrategyProductionPolicy(db, state), /strategy_production_policy/)
  assert.deepEqual(await rows(db), before, 'never silently overwrite historical evidence to repair it')
}))

test('commit-time content corruption rolls back the entire policy insertion', async () => fixture(async db => {
  await original(db)
  const before = await rows(db), state = makeState()
  state.base_weight_run_id = 'new-run'
  state.canonical_payload = JSON.stringify({ ...JSON.parse(state.canonical_payload), base_weight_run_id: 'new-run' })
  await db.prepare(`CREATE TRIGGER inject_corrupt_policy AFTER INSERT ON strategy_production_policy_history_v1
    BEGIN UPDATE strategy_production_policy_history_v1 SET strategy_weights_json='{"incumbent":0,"other":1}'
    WHERE checksum=NEW.checksum; END`).run()
  await assert.rejects(() => persistStrategyProductionPolicy(db, state), /strategy_production_policy/)
  assert.deepEqual(await rows(db), before)
}))

test('lost acknowledgement recovers the original commit without changing its timestamp', async () => fixture(async db => {
  await original(db)
  const state = makeState()
  state.base_weight_run_id = 'lost-ack-run'
  state.canonical_payload = JSON.stringify({ ...JSON.parse(state.canonical_payload), base_weight_run_id: 'lost-ack-run' })
  const loseAck = new Proxy(db, { get(target, name) {
    if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
      await target.batch(statements)
      throw new Error('injected_lost_ack')
    }
    const value = Reflect.get(target, name)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(() => persistStrategyProductionPolicy(loseAck, state), (error: any) =>
    error.message === 'strategy_production_policy_transaction_failed' && error.cause?.message === 'injected_lost_ack')
  const committed = await rows(db)
  assert.equal(committed.length, 2)
  assert.equal((await persistStrategyProductionPolicy(db, state)).inserted, false)
  assert.deepEqual(await rows(db), committed)
}))

test('a policy mutation between pre-read and commit cannot pass the transactional CAS', async () => fixture(async db => {
  const state = await original(db)
  const racing = new Proxy(db, { get(target, name) {
    if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
      await target.prepare('UPDATE strategy_production_policy_history_v1 SET strategy_weights_json=?')
        .bind(JSON.stringify({ incumbent: 0.2, other: 0.8 })).run()
      return target.batch(statements)
    }
    const value = Reflect.get(target, name)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(() => persistStrategyProductionPolicy(racing, state), /strategy_production_policy_transaction_failed/)
  assert.deepEqual(JSON.parse((await rows(db))[0].strategy_weights_json), { incumbent: 0.2, other: 0.8 },
    'a failed retry must not rewrite separately modified historical evidence')
}))

test('the supported previous-v2 serving reader verifies integrity instead of bypassing it', async () => fixture(async db => {
  await original(db)
  const row = (await rows(db))[0], canonical = JSON.parse(row.canonical_payload)
  canonical.policy_id = 'strategy-production-contribution-firewall-v2'
  canonical.version = 2
  canonical.allocation_eligibility_contract_version = 'strategy-allocation-eligibility-v2'
  delete canonical.evidence_owner
  const payload = JSON.stringify(canonical)
  const evidence = { ...JSON.parse(row.evidence_json), safety_reducing_only: true,
    allocation_eligibility_contract_version: 'strategy-allocation-eligibility-v2' }
  delete evidence.evidence_owner
  await db.prepare(`UPDATE strategy_production_policy_history_v1 SET policy_id=?,version=2,
    evidence_json=?,canonical_payload=?,checksum=?`).bind(canonical.policy_id, JSON.stringify(evidence), payload,
      await sha256StrategyProductionPolicyPayload(payload)).run()
  const loaded = await loadStrategyProductionPolicyBefore(db, '2026-09-08', ids)
  assert.equal(loaded?.state.policy_id, canonical.policy_id)
  assert.deepEqual(loaded?.state.strategy_weights, makeState().strategy_weights)
  await db.prepare('UPDATE strategy_production_policy_history_v1 SET checksum=?').bind('d'.repeat(64)).run()
  await assert.rejects(() => loadStrategyProductionPolicyBefore(db, '2026-09-08', ids), /checksum_mismatch/)
}))

test('a retry guards the original availability timestamp inside the transaction', async () => fixture(async db => {
  const state = await original(db)
  const racing = new Proxy(db, { get(target, name) {
    if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
      await target.prepare("UPDATE strategy_production_policy_history_v1 SET created_at='2026-09-09T00:00:00Z'").run()
      return target.batch(statements)
    }
    const value = Reflect.get(target, name)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(() => persistStrategyProductionPolicy(racing, state), /strategy_production_policy_transaction_failed/)
}))

test('readback rejects a changed full evidence projection after acknowledgement', async () => fixture(async db => {
  const state = await original(db)
  const racing = new Proxy(db, { get(target, name) {
    if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
      const writes = await target.batch(statements)
      const evidence = structuredClone(state.evidence)
      evidence.positive_weight_count = 100
      await target.prepare('UPDATE strategy_production_policy_history_v1 SET evidence_json=?')
        .bind(JSON.stringify(evidence)).run()
      return writes
    }
    const value = Reflect.get(target, name)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(() => persistStrategyProductionPolicy(racing, state), /strategy_production_policy_readback_changed/)
}))

// Compound-storage tests, NOT a NAV adoption grant: use the real registry schema
// and a plainly named private witness. No synthetic PASS or live publication API.
async function compoundFixture(db: D1Database) {
  await original(db)
  const schema = readFileSync(new URL('../domain-schemas/learning.sql', import.meta.url), 'utf8')
  const registry = schema.match(/CREATE TABLE IF NOT EXISTS strategy_spec_registry \([\s\S]*?\n\);/)?.[0]
  assert(registry)
  await db.prepare(registry).run()
  await db.prepare(`INSERT INTO strategy_spec_registry(strategy_id,version,name,status,alpha_bucket,thesis)
    VALUES('incumbent','v1','incumbent','active','trend','fixture'),
          ('candidate','v1','candidate','candidate','trend','fixture')`).run()
  await db.prepare('CREATE TABLE private_transaction_witness(id TEXT PRIMARY KEY, policy_checksum TEXT NOT NULL)').run()
  const state = makeState()
  state.base_weight_run_id = 'compound-test'
  state.strategy_weights = { incumbent: 0, candidate: 0.6, other: 0.4 }
  state.canonical_payload = JSON.stringify({ ...JSON.parse(state.canonical_payload),
    base_weight_run_id: state.base_weight_run_id, strategy_weights: state.strategy_weights })
  return state
}

async function registryState(db: D1Database) {
  return (await db.prepare('SELECT strategy_id,status FROM strategy_spec_registry ORDER BY strategy_id').all()).results
}

function compoundStatements(db: D1Database, policy: Awaited<ReturnType<typeof prepareStrategyProductionPolicyWrite>>) {
  return [
    db.prepare("UPDATE strategy_spec_registry SET status='candidate' WHERE strategy_id='incumbent' AND version='v1'"),
    ...policy.statements,
    db.prepare("UPDATE strategy_spec_registry SET status='active' WHERE strategy_id='candidate' AND version='v1'"),
    db.prepare("INSERT OR IGNORE INTO private_transaction_witness(id,policy_checksum) VALUES('transaction',?)")
      .bind(policy.checksum),
  ]
}

test('prepared policy is read-only and participates in the same registry transaction', async () => fixture(async db => {
  const state = await compoundFixture(db), before = await rows(db), registryBefore = await registryState(db)
  const prepared = await prepareStrategyProductionPolicyWrite(db, state)
  assert.deepEqual(await rows(db), before)
  assert.deepEqual(await registryState(db), registryBefore)
  await assert.rejects(() => prepared.verifyCommitted(), /persistence_missing/)
  const writes = await db.batch(compoundStatements(db, prepared))
  assert(writes.every(write => write.success))
  assert.deepEqual((await prepared.verifyCommitted()).state.strategy_weights, state.strategy_weights)
  assert.deepEqual(await registryState(db), [
    { strategy_id: 'candidate', status: 'active' }, { strategy_id: 'incumbent', status: 'candidate' },
  ])
  assert.equal((await db.prepare('SELECT policy_checksum FROM private_transaction_witness').first<any>())?.policy_checksum,
    prepared.checksum)
}))

for (const boundary of ['before_policy', 'after_policy']) {
  test(`compound ${boundary} failure rolls back registry, policy and witness`, async () => fixture(async db => {
    const state = await compoundFixture(db), before = await rows(db), registryBefore = await registryState(db)
    const prepared = await prepareStrategyProductionPolicyWrite(db, state)
    const statements = compoundStatements(db, prepared)
    statements.splice(boundary === 'before_policy' ? 1 : statements.length, 0,
      db.prepare("SELECT json('injected_compound_failure')"))
    await assert.rejects(() => db.batch(statements))
    assert.deepEqual(await rows(db), before)
    assert.deepEqual(await registryState(db), registryBefore)
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM private_transaction_witness').first<any>())?.n, 0)
  }))
}

test('original policy content guard rolls back adjacent registry mutations', async () => fixture(async db => {
  const state = await compoundFixture(db), before = await rows(db), registryBefore = await registryState(db)
  const prepared = await prepareStrategyProductionPolicyWrite(db, state)
  await db.prepare(`CREATE TRIGGER compound_corruption AFTER INSERT ON strategy_production_policy_history_v1
    BEGIN UPDATE strategy_production_policy_history_v1 SET strategy_weights_json='{}'
      WHERE checksum=NEW.checksum; END`).run()
  await assert.rejects(() => db.batch(compoundStatements(db, prepared)))
  assert.deepEqual(await rows(db), before)
  assert.deepEqual(await registryState(db), registryBefore)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM private_transaction_witness').first<any>())?.n, 0)
}))

test('compound lost acknowledgement retry preserves policy availability and a single witness', async () => fixture(async db => {
  const state = await compoundFixture(db), prepared = await prepareStrategyProductionPolicyWrite(db, state)
  // The native batch commits; transport then loses its acknowledgement.
  await assert.rejects(async () => {
    await db.batch(compoundStatements(db, prepared))
    throw new Error('injected_lost_ack')
  }, /injected_lost_ack/)
  const committed = await rows(db), retry = await prepareStrategyProductionPolicyWrite(db, state)
  await db.batch(compoundStatements(db, retry))
  await retry.verifyCommitted()
  assert.deepEqual(await rows(db), committed)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM private_transaction_witness').first<any>())?.n, 1)
}))

test('prepared write captures caller input before its first asynchronous boundary', async () => fixture(async db => {
  const state = await compoundFixture(db), expected = structuredClone(state)
  const preparing = prepareStrategyProductionPolicyWrite(db, state)
  state.strategy_weights.candidate = 100
  state.evidence.positive_weight_count = 100
  state.canonical_payload = '{}'
  const prepared = await preparing
  await db.batch([...prepared.statements])
  const committed = await prepared.verifyCommitted()
  assert.deepEqual(committed.state.strategy_weights, expected.strategy_weights)
  assert.equal(committed.state.evidence.positive_weight_count, expected.evidence.positive_weight_count)
}))
