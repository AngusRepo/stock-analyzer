import { normalizeAdaptiveParams } from './adaptiveConfig'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LEGACY_ALPHA_MODELS, PUBLISHED_ALPHA_MODEL_ORDER_PROJECTED_SQL, TIMEXER_ALPHA_MODELS, isR33AlphaModelOrder, publishedAlphaModelOrder, publishedAlphaModelOrderProjected, validateAlphaModelOrder } from './alphaModelRoster'
import { buildMlVoteSummary, buildMlDiagnostics } from './recommendationContext'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
function db(order: readonly string[] | null, calls: unknown[][] = []) {
  return { prepare(sql: string) { return { bind(...values: unknown[]) { calls.push(values); return this }, async first() {
    if (sql.includes('active8_ensemble_pointer_v1')) return order ? {payload_json:JSON.stringify({model_order:order,payload_checksum:'frozen'}),payload_checksum:'frozen',pointer_checksum:'frozen',state:'production',production_effect:1} : null
    return {accuracy:.8,samples:100}
  } } } } as unknown as D1Database
}
test('published TimeXer is exactly eight; legacy and corrupt replacement differ', async () => {
  assert.deepEqual(await publishedAlphaModelOrder(db(null)), [...LEGACY_ALPHA_MODELS])
  assert.deepEqual(await publishedAlphaModelOrder(db(TIMEXER_ALPHA_MODELS)), TIMEXER_ALPHA_MODELS)
  assert.throws(() => validateAlphaModelOrder([...LEGACY_ALPHA_MODELS, 'TimeXer']))
})
test('P2 queries published eight models and never mixes DLinear with TimeXer', async () => {
  const calls: unknown[][]=[]
  await checkP2Accuracy(db(TIMEXER_ALPHA_MODELS,calls),undefined,DEFAULT_TRADING_CONFIG,{defaults:{halt:false,maxPositionPct:.25,buyConfThreshold:.6,sellConfThreshold:.6},effectiveBuy:.6,effectiveSell:.6})
  assert.deepEqual(calls,[TIMEXER_ALPHA_MODELS])
})
test('vote and diagnostic denominator stays eight with TimeXer and stale DLinear row', () => {
  const forecast={ensemble_v2:{model_order:TIMEXER_ALPHA_MODELS,weights:Object.fromEntries(TIMEXER_ALPHA_MODELS.map(n=>[n,1/8])),contributing_models:['TimeXer']}}
  const rows=[...TIMEXER_ALPHA_MODELS,'DLinear'].map(model_name=>({model_name,direction_accuracy:.8}))
  const result=buildMlVoteSummary(forecast,rows)
  assert.equal(result?.total,8);assert.equal(result?.reported,8);assert.deepEqual(result?.contributingModels,['TimeXer'])
  assert.equal(buildMlDiagnostics(forecast)?.totalAlphaModels,8)
})


test('adaptive normalization preserves the published TimeXer roster', () => {
  const result=normalizeAdaptiveParams({meta_layer:{alpha_vote_models:TIMEXER_ALPHA_MODELS}})
  assert.deepEqual(result.meta_layer?.formal_layer3_slots,TIMEXER_ALPHA_MODELS)
  assert.throws(()=>normalizeAdaptiveParams({meta_layer:{alpha_vote_models:[...TIMEXER_ALPHA_MODELS,'DLinear']}}))
})
test('an R33 roster is any non-empty TimeXer-slot-ordered subset without DLinear (Q3: no minimum)', async () => {
  const core4=['LightGBM','ExtraTrees','TabM','GNN']
  assert.equal(isR33AlphaModelOrder(core4),true)
  assert.equal(isR33AlphaModelOrder(['GNN']),true)
  assert.deepEqual(await publishedAlphaModelOrder(db(core4)), core4)
  for (const bad of [[],['GNN','LightGBM'],['LightGBM','DLinear'],['TabM','TabM'],['LightGBM','Unknown']]) {
    assert.equal(isR33AlphaModelOrder(bad),false)
    assert.throws(() => validateAlphaModelOrder(bad))
  }
  // XGBoost is retired from R33 (Q5): a set holding it is a broken eight-model set, never an R33 roster.
  assert.equal(isR33AlphaModelOrder(['LightGBM','XGBoost']),false)
  assert.throws(() => validateAlphaModelOrder(['LightGBM','XGBoost']))
  assert.equal(isR33AlphaModelOrder(TIMEXER_ALPHA_MODELS),false)
  assert.deepEqual(validateAlphaModelOrder(TIMEXER_ALPHA_MODELS),TIMEXER_ALPHA_MODELS)
})

test('the /obs projected pointer read returns only model_order, checks like the full read, and never scans', async () => {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, payload_checksum TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, production_effect INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_active8_ensemble_artifacts_state ON active8_ensemble_artifacts_v1(state);
    CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL, payload_checksum TEXT NOT NULL)`)
  const d1 = { prepare: (query: string) => ({ first: async () => sql.prepare(query).get() ?? null }) } as unknown as D1Database
  assert.deepEqual(await publishedAlphaModelOrderProjected(d1), [...LEGACY_ALPHA_MODELS])
  const core4 = ['LightGBM','ExtraTrees','TabM','GNN']
  const payload = JSON.stringify({ model_order: core4, payload_checksum: 'c'.repeat(64), base_artifacts: { big: 'x'.repeat(4096) } })
  sql.prepare('INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,1)').run('r33-roster:c1', payload, 'c'.repeat(64), 'production')
  sql.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?)').run('r33-roster:c1', 'c'.repeat(64))
  assert.deepEqual(await publishedAlphaModelOrderProjected(d1), core4)
  assert.deepEqual(await publishedAlphaModelOrderProjected(d1), await publishedAlphaModelOrder(d1))
  const row = sql.prepare(PUBLISHED_ALPHA_MODEL_ORDER_PROJECTED_SQL).get() as Record<string, unknown>
  assert.equal('payload_json' in row, false)
  assert.equal(row.model_order_json, JSON.stringify(core4))
  const plan = sql.prepare('EXPLAIN QUERY PLAN ' + PUBLISHED_ALPHA_MODEL_ORDER_PROJECTED_SQL).all() as { detail: string }[]
  assert.ok(plan.length > 0 && plan.every(step => !/^SCAN/.test(step.detail)), JSON.stringify(plan))
  // A string-encoded array (or a string checksum wrapper) is refused exactly as the full read refuses it.
  const setPayload = (value: object) => sql.prepare('UPDATE active8_ensemble_artifacts_v1 SET payload_json=?').run(JSON.stringify(value))
  setPayload({ model_order: JSON.stringify(core4), payload_checksum: 'c'.repeat(64) })
  await assert.rejects(publishedAlphaModelOrder(d1), /alpha_roster_order_invalid/)
  await assert.rejects(publishedAlphaModelOrderProjected(d1), /alpha_roster_order_invalid/)
  setPayload({ model_order: core4, payload_checksum: JSON.stringify('c'.repeat(64)) })
  await assert.rejects(publishedAlphaModelOrder(d1), /alpha_roster_published_pointer_invalid/)
  await assert.rejects(publishedAlphaModelOrderProjected(d1), /alpha_roster_published_pointer_invalid/)
  setPayload({ payload_checksum: 'c'.repeat(64) })
  await assert.rejects(publishedAlphaModelOrder(d1), /alpha_roster_order_invalid/)
  await assert.rejects(publishedAlphaModelOrderProjected(d1), /alpha_roster_order_invalid/)
  setPayload({ model_order: core4, payload_checksum: 'c'.repeat(64) })
  assert.deepEqual(await publishedAlphaModelOrderProjected(d1), core4)
  sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run('d'.repeat(64))
  await assert.rejects(publishedAlphaModelOrderProjected(d1), /alpha_roster_published_pointer_invalid/)
  sql.close()
})
