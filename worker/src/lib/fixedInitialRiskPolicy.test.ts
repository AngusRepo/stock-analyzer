import assert from 'node:assert/strict'
import { checkExitConditions, type ExitPosition } from './paperExitPolicy'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import { assessOr15NetRewardRisk, resolveOr15PaperExitTargets } from './or15PaperPricePolicy'
import { resolveOhlcvEntryPlan } from './ohlcvTradePlanLevels'
const cfg=structuredClone(DEFAULT_TRADING_CONFIG)
const pos:ExitPosition={symbol:'fixture',shares:4000,original_shares:4000,avg_cost:100,entry_price:100,
 initial_stop:95,trailing_stop:95,highest_since_entry:100,tp1_price:110,tp2_price:130,tp1_hit:0,entry_date:'2026-10-01',stop_multiplier:null}
for(const atr of [.01,1,10]) {
 const r=checkExitConditions(pos,109,atr,false,false,cfg)
 assert.equal(r.action,'hold');assert.equal(r.newTrailingStop,95)
}
const signal=checkExitConditions(pos,110,1,false,false,cfg)
assert.equal(signal.action,'partial_sell');assert.equal(pos.tp1_hit,0)
assert.equal(checkExitConditions(pos,98,1,false,false,cfg).action,'hold')
assert.equal(checkExitConditions({...pos,tp1_hit:1,trailing_stop:100},98,1,false,false,cfg).action,'full_sell')
assert.equal(checkExitConditions({...pos,tp1_hit:1,trailing_stop:105},104,1,false,false,cfg).action,'full_sell')
const netProceeds=(p:number)=>p*1000-100
assert.equal(assessOr15NetRewardRisk({entry:100,stop:95,tp1:100.5,tp2:102,buyCost:100100,netProceeds}).pass,false)
assert.equal(assessOr15NetRewardRisk({entry:100,stop:95,tp1:108,tp2:116,buyCost:100100,netProceeds}).pass,true)
const targets=resolveOr15PaperExitTargets({fillPrice:100,selectedTp1:108,selectedTp2:116,structuralResistance:101,atrTp1:108,atrTp2:116,isNetProfitable:p=>p>100.2})!
assert.equal(targets.tp1,101);assert.equal(targets.tp1Source,'ohlcv_resistance')
assert.equal(assessOr15NetRewardRisk({entry:100,stop:95,...targets,buyCost:100100,netProceeds}).pass,false)
const plan=resolveOhlcvEntryPlan({latestClose:100,support:95,resistance:99,confirmation:100,volumeNode:98,atr:2,atrUpper:102,atrLower:98},{latestPrice:100})!
assert(plan.stopLoss<95)
assert((plan.target1-plan.entryPrice)/(plan.entryPrice-plan.stopLoss)>=1.5)
assert((plan.target2-plan.entryPrice)/(plan.entryPrice-plan.stopLoss)>=3)
assert.notEqual(plan.target1,plan.optimisticHigh)
console.log('fixed stop, filled TP1 state, pressure and net RR tests passed')
