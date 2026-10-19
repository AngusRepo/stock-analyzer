import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { buildLinUcbRewardLedgerRows, refreshLinUcbRewardLedger } from './metaLearningRewardLedger'
import { ADAPTIVE_PARAMS_KV_KEY } from './adaptiveConfig'
import { capturePostVerifyAdaptiveEvidence, enablePostVerifyAdaptiveEvidence,
  recordPostVerifyLinUcbOutput, verifyPostVerifyAdaptiveEvidence } from './postVerifyAdaptiveEvidence'

const day = '2026-10-16', stamp = '2026-10-16T12:00:00.000Z'
function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE meta_reward_ledger(policy_id TEXT,arm_id TEXT,context_hash TEXT,samples INTEGER,
    reward_sum REAL,reward_mean REAL,last_reward_at TEXT,updated_at TEXT,evidence_json TEXT,
    PRIMARY KEY(policy_id,arm_id,context_hash))`)
  let batches = 0, reads = 0, failBatch = 0, falseBatch = false
  const db: any = { prepare(sql: string) {
    let args: any[] = []
    return { bind(...values: any[]) { args = values; return this },
      async all() { reads++; return { success: true, results: sqlite.prepare(sql).all(...args) } },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } } },
      _run() { return sqlite.prepare(sql).run(...args) }, _args() { return args } }
  }, async batch(statements: any[]) {
    batches++
    if (batches === failBatch) throw new Error('injected batch transport failure')
    if (falseBatch) return statements.map(() => ({ success: false }))
    assert.ok(statements.length <= 50)
    assert.ok(statements.every(statement => statement._args().length <= 90))
    sqlite.exec('BEGIN')
    try {
      const result = statements.map(statement => ({ success: true, meta: { changes: Number(statement._run().changes) } }))
      sqlite.exec('COMMIT')
      return result
    } catch (error) { sqlite.exec('ROLLBACK'); throw error }
  } }
  const kv = new Map<string, string>()
  const env: any = { DB: db, LEARNING_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'learning',
    KV: { get: async (key: string) => kv.get(key) ?? null } }
  return { sqlite, db, env, kv, batches: () => batches, reads: () => reads,
    failAt: (n: number) => { failBatch = n }, failResults: () => { falseBatch = true } }
}
function sourceRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ date: day, stock_id: String(i), model_name: 'XGBoost',
    alpha_bucket: `capacity-bucket-${i}`,
    market_segment: 'TWSE', recommendation_lane: 'tradable', has_buy_signal: 1,
    actual_return_pct: 1 + i % 5, model_ic: i / 10000, coverage: .9, data_quality: .99 }))
}

test('bounded batches preserve every original LinUCB value and avoid one RPC per row', async () => {
  const f = fixture(), input = sourceRows(550)
  try {
    const expected = buildLinUcbRewardLedgerRows(input, { nowIso: stamp })
    assert.ok(expected.length > 500)
    const result = await refreshLinUcbRewardLedger(f.db, { sourceRows: input, dryRun: false, nowIso: stamp })
    assert.equal(result.persisted_rows, expected.length)
    assert.equal(f.batches(), Math.ceil(expected.length / 500))
    const actual = f.sqlite.prepare('SELECT * FROM meta_reward_ledger ORDER BY arm_id,context_hash').all()
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), [...expected].sort((a,b) => a.arm_id.localeCompare(b.arm_id) || a.context_hash.localeCompare(b.context_hash)))
  } finally { f.sqlite.close() }
})

test('partial batch failure never returns a successful ledger report', async () => {
  const f = fixture()
  try {
    f.failAt(2)
    await assert.rejects(refreshLinUcbRewardLedger(f.db, { sourceRows: sourceRows(550), dryRun: false, nowIso: stamp }), /injected/)
    assert.equal(Number((f.sqlite.prepare('SELECT count(*) AS n FROM meta_reward_ledger').get() as any).n), 500)
    f.failAt(0)
    const recovered = await refreshLinUcbRewardLedger(f.db, { sourceRows: sourceRows(550), dryRun: false, nowIso: stamp })
    assert.equal(Number((f.sqlite.prepare('SELECT count(*) AS n FROM meta_reward_ledger').get() as any).n), recovered.persisted_rows)
  } finally { f.sqlite.close() }
})

test('resolved batch results with success=false fail closed', async () => {
  const f = fixture()
  try { f.failResults(); await assert.rejects(refreshLinUcbRewardLedger(f.db,
    { sourceRows: sourceRows(1), dryRun: false, nowIso: stamp }), /batch_write_failed/) }
  finally { f.sqlite.close() }
})

test('LinUCB proof binds actual owner output and fresh content, not latest timestamp guesses', async () => {
  const f = fixture()
  try {
    enablePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger')
    const result = await refreshLinUcbRewardLedger(f.db, { sourceRows: sourceRows(550), dryRun: false, nowIso: stamp })
    await assert.rejects(capturePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day), /owner_output_missing/)
    await recordPostVerifyLinUcbOutput(f.env, result.ledger_rows)
    const evidence = await capturePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day)
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day, evidence), true)
    assert.ok(f.reads() < result.ledger_rows.length / 10)
    f.sqlite.exec('UPDATE meta_reward_ledger SET reward_sum=reward_sum+1 WHERE rowid=1')
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day, evidence), false)
    await assert.rejects(capturePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day), /readback_mismatch/)
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', '2026-10-15', evidence), false)
  } finally { f.sqlite.close() }
})

test('missing ledger rows and unrelated later output cannot satisfy the original proof', async () => {
  const f = fixture()
  try {
    enablePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger')
    const result = await refreshLinUcbRewardLedger(f.db, { sourceRows: sourceRows(1), dryRun: false, nowIso: stamp })
    await recordPostVerifyLinUcbOutput(f.env, result.ledger_rows)
    const evidence = await capturePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day)
    f.sqlite.exec("UPDATE meta_reward_ledger SET updated_at='2026-10-16T13:00:00.000Z' WHERE rowid=1")
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day, evidence), false)
  } finally { f.sqlite.close() }
})

test('empty owner output is explicit and has no fake rows', async () => {
  const f = fixture()
  try {
    enablePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger')
    await recordPostVerifyLinUcbOutput(f.env, [])
    const evidence = await capturePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day)
    assert.ok('ledger' in evidence && evidence.ledger.rows === 0 && evidence.ledger.stamp === null)
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day, evidence), true)
  } finally { f.sqlite.close() }
})

test('adaptive reuse requires exact real dated KV and provenance, never cache/defaults', async () => {
  const f = fixture()
  try {
    const value = { computed_at: stamp, version: 3, confidence_delta: .1,
      provenance: { owner: 'ml-controller', schema_version: 'adaptive-params-v2', fallback: false } }
    const raw = JSON.stringify(value), dated = ADAPTIVE_PARAMS_KV_KEY + ':' + day
    f.kv.set(ADAPTIVE_PARAMS_KV_KEY, raw); f.kv.set(dated, raw)
    const evidence = await capturePostVerifyAdaptiveEvidence(f.env, 'adapt', day)
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'adapt', day, evidence), true)
    f.kv.delete(dated)
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'adapt', day, evidence), false)
    f.kv.set(dated, JSON.stringify({ ...value, confidence_delta: .2 }))
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'adapt', day, evidence), false)
    f.kv.set(dated, raw)
    await assert.rejects(capturePostVerifyAdaptiveEvidence(f.env, 'adapt', '2026-10-15'), /identity_invalid/)
    f.kv.set(ADAPTIVE_PARAMS_KV_KEY, JSON.stringify({ ...value, provenance: { ...value.provenance, fallback: true } }))
    await assert.rejects(capturePostVerifyAdaptiveEvidence(f.env, 'adapt', day), /identity_invalid/)
  } finally { f.sqlite.close() }
})

test('read transport, missing schema and failed result preserve uncertainty rather than invalidate a success', async () => {
  const f = fixture()
  try {
    enablePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger')
    const result = await refreshLinUcbRewardLedger(f.db, { sourceRows: sourceRows(1), dryRun: false, nowIso: stamp })
    await recordPostVerifyLinUcbOutput(f.env, result.ledger_rows)
    const evidence = await capturePostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day)
    const broken: any = { ...f.env, LEARNING_DB: { prepare() { throw new Error('network unavailable') } } }
    await assert.rejects(verifyPostVerifyAdaptiveEvidence(broken, 'linucb-reward-ledger', day, evidence), /network unavailable/)
    broken.LEARNING_DB = { prepare() { return { bind() { return this }, all: async () => ({ success: false }) } } }
    await assert.rejects(verifyPostVerifyAdaptiveEvidence(broken, 'linucb-reward-ledger', day, evidence), /readback_failed/)
    broken.LEARNING_DB = { prepare() { return { bind() { return this }, all: async () => ({ success: true }) } } }
    await assert.rejects(verifyPostVerifyAdaptiveEvidence(broken, 'linucb-reward-ledger', day, evidence), /readback_failed/)
    f.sqlite.exec('DROP TABLE meta_reward_ledger')
    await assert.rejects(verifyPostVerifyAdaptiveEvidence(f.env, 'linucb-reward-ledger', day, evidence), /no such table/)
    const kvProof: any = { schema: 'post-verify-adaptive-evidence-v1', task: 'adapt', businessDate: day,
      kv: { datedKey: ADAPTIVE_PARAMS_KV_KEY + ':' + day, checksum: 'a'.repeat(64) } }
    await assert.rejects(verifyPostVerifyAdaptiveEvidence({ ...f.env, KV: { get: async () => { throw new Error('KV timeout') } } },
      'adapt', day, kvProof), /KV timeout/)
    f.kv.set(ADAPTIVE_PARAMS_KV_KEY, '{malformed')
    assert.equal(await verifyPostVerifyAdaptiveEvidence(f.env, 'adapt', day, kvProof), false)
  } finally { f.sqlite.close() }
})
