import { verifiedFixture } from './riskProtocol.testSupport'
const buildCanonicalMarketRiskContext=(input:any)=>originalBuild(verifiedFixture(input))
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildCanonicalMarketRiskContext as originalBuild } from './marketRiskRuntime'
import { normalizeRiskConfig } from './riskConfig'
const source=JSON.parse(fs.readFileSync(new URL('../../test-fixtures/daily-market-risk/risk-canonical-inputs.json', import.meta.url),'utf8'))
const state=JSON.parse(source.hmm[0].state_json)
const base:any={marketRiskRows:source.market_risk,factorPacket:source.factors[0],breadth:{...source.breadth[0],advance_ratio:.6,bull_alignment_pct:60},regimeState:state,
 policy:normalizeRiskConfig(source.risk_config).portfolio,expectedSession:'2026-10-06'}
const risk=(patch:any={})=>buildCanonicalMarketRiskContext({...base,...patch})
// v4: HMM volatile is orange; no relief from trend/global evidence (Wei 10/29 Q1).
assert.equal(risk().level,'orange');assert.equal(risk().targetExposureCap,.45)
assert(!risk().reasons.includes('volatile_direction_confirmed_no_stress'))
assert.equal(risk({factorPacket:{...base.factorPacket,level:'green'},marketRiskRows:base.marketRiskRows.map((r:any)=>({...r,risk_level:'green'}))}).targetExposureCap,.45)
assert.equal(risk({regimeState:{...state,family:'bull'}}).targetExposureCap,.95)
assert.equal(risk({regimeState:{...state,family:'sideways'}}).targetExposureCap,.68)
assert.equal(risk({regimeState:{...state,family:'bull'},factorPacket:{...base.factorPacket,level:'red'}}).level,'green','the factor packet is evidence only')
assert.equal(risk({regimeState:{...state,family:'unknown'}}).status,'blocked')
for(const day of ['2026-09-30','2026-10-07']) {
 const result=risk({marketRiskRows:base.marketRiskRows.map((r:any)=>({...r,date:day})),factorPacket:{...base.factorPacket,date:day},breadth:{...base.breadth,date:day},regimeState:{...state,run_date:day}})
 assert.equal(result.status,'blocked');assert.equal(result.haltNewBuys,true);assert.equal(result.deRiskExistingPositions,false)
}
const altered=(key:string,value:any)=>{const clone=structuredClone(state);clone.regime_evidence.evidence[key]=value;return clone}
assert.equal(risk({regimeState:altered('global_risk',{status:'missing'})}).level,'orange')
assert.equal(risk({regimeState:altered('price_trend',{status:'available',stance:'bearish',metrics:{twii_bias_20d:-.1,twii_return_5d:-.1}})}).level,'orange')
assert.equal(risk({regimeState:altered('atr_vturn',{metrics:{realized_vol_10d:.02}})}).level,'orange')
assert.equal(risk({regimeState:{...state,family:'bear'}}).level,'red')
assert.equal(risk({factorPacket:{...base.factorPacket,level:'invalid'}}).status,'blocked','packet integrity still blocks')
for(const [drop,level] of [[.03,'orange'],[.06,'red'],[.09,'black']] as const) {
 const rows=[{...base.marketRiskRows[0],twii_close:100*(1-drop)},{...base.marketRiskRows[1],twii_close:100}]
 assert.equal(risk({marketRiskRows:rows}).level,level)
}
for(const [ratio,level] of [[.24,'orange'],[.14,'red'],[.07,'black']] as const)assert.equal(risk({breadth:{...base.breadth,advance_ratio:ratio}}).level,level)
assert.equal(risk({policy:{...base.policy,greenTargetExposure:NaN}}).status,'blocked')
assert.equal(risk({policy:{...base.policy,redTargetExposure:.9}}).status,'blocked')
console.log('Dynamic market risk: HMM-owned level, evidence-only packet, shock/breadth breakers, expected sessions and policy bounds passed')
