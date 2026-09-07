import assert from 'node:assert/strict'
import test from 'node:test'
import { writeSandbox, DEFAULT_TRADING_CONFIG, mergeAlphaFrameworkConfig } from './tradingConfig'
import { mergeCompositeOptunaCandidate } from './optunaConfigMerge'

test('same input/run retry reuses sandbox; new input never overwrites it', async () => {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.has(key) ? JSON.parse(store.get(key)!) : null,
    put: async (key: string, value: string) => { store.set(key, value) },
  } as unknown as KVNamespace
  const config = structuredClone(DEFAULT_TRADING_CONFIG)
  const first = await writeSandbox(kv, 'research_sweep', config, { push_id: 'run:selection' })
  const retry = await writeSandbox(kv, 'research_sweep', config, { push_id: 'run:selection' })
  assert.equal(retry, first)
  const changed = await writeSandbox(kv, 'research_sweep', config, { push_id: 'new-input:selection' })
  assert.notEqual(changed, first)
  const configChanged = await writeSandbox(kv, 'research_sweep', {
    ...config, signal: { ...config.signal, buySignalScore: config.signal.buySignalScore + 1 },
  }, { push_id: 'run:selection' })
  assert.notEqual(configChanged, first)
  assert(!store.has('trading:config'))
  const firstBody = JSON.parse(store.get(first)!)
  assert.equal(firstBody.push_id, 'run:selection')
})

test('grouped candidates cannot silently omit shared risk fields or add unrelated fields', () => {
  const base = structuredClone(DEFAULT_TRADING_CONFIG)
  assert.throws(() => mergeCompositeOptunaCandidate(base, { sltp: { sl_mult: 1.1 } },
    mergeAlphaFrameworkConfig, 'execution_risk'), /missing sources: risk_params/)
  assert.throws(() => mergeCompositeOptunaCandidate(base,
    { sltp: {}, risk_params: {}, signal: {} }, mergeAlphaFrameworkConfig, 'execution_risk'), /unexpected/)
  const result = mergeCompositeOptunaCandidate(base,
    { sltp: { sl_mult: 1.1 }, risk_params: { risk_pct: 0.012 } }, mergeAlphaFrameworkConfig, 'execution_risk')
  assert.equal(result.config.sltp.slMultBase, 1.1)
  assert.equal(result.config.position.riskPctPerTrade, 0.012)
  assert.deepEqual(result.config.signal, base.signal)
})
