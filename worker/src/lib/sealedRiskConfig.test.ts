import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChampionTradingConfig,validateTradingConfig } from './tradingConfig'

test('existing default policy validates without enabling guessed calibration',()=>{
  const cfg=buildChampionTradingConfig(null)
  assert.deepEqual(validateTradingConfig(cfg),[])
  assert.equal(cfg.circuit.lossGuard,undefined)
  assert.equal(cfg.l4Distribution?.sealedExecution,undefined)
})
test('invalid loss-window expiry is rejected when explicitly configured',()=>{
  const cfg=buildChampionTradingConfig(null)
  cfg.circuit.lossGuard={lookbackSessions:5,releaseAfterSessions:6,channel:'stopouts',minimumLossValue:0,minimumClosedTrades:3,maximumClosedTrades:5,scale:.5}
  assert.ok(validateTradingConfig(cfg).some(s=>s.includes('lossGuard')))
})
test('sealed policy forbids replacement/reoptimization and demands measured covariance minimum',()=>{
  const cfg=buildChampionTradingConfig(null)
  cfg.l4Distribution={scope:'paper',artifact:{},constraints:{},sealedExecution:{schema_version:'l4-sealed-execution-v1',
    rotation_mode:'selected_ready_or_filled',expiry:'retain_until_next_seal',require_matched_risk_horizon:true}} as any
  assert.ok(validateTradingConfig(cfg).some(s=>s.includes('covariance window')))
  cfg.l4Distribution!.sealedExecution!.minimum_covariance_windows=20
  cfg.l4Distribution!.constraints.covariance_horizon_sessions=5
  assert.ok(!validateTradingConfig(cfg).some(s=>s.includes('sealedExecution')))
  cfg.l4Distribution!.sealedExecution!.find_replacement=true
  assert.ok(validateTradingConfig(cfg).some(s=>s.includes('immutable selected legs')))
})
