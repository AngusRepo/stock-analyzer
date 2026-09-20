import { normalizeAdaptiveParams } from './adaptiveConfig'
import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGACY_ALPHA_MODELS, TIMEXER_ALPHA_MODELS, publishedAlphaModelOrder, validateAlphaModelOrder } from './alphaModelRoster'
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
