import assert from 'node:assert/strict'
import { buildMarketRiskQuality, fetchBullAlignmentCount } from './marketRisk'
import { buildCanonicalMarketRiskContext, HMM_INPUT_CONTRACT } from './marketRiskRuntime'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { fixtureQuality, fixtureProvenance } from './riskProtocol.testSupport'
const data:any={date:'2026-10-06',vix:12,twiiClose:30000,twiiMa20:29900,twiiBias:1,twiiVol20:10,
 foreignConsecutiveSell:0,foreignNet5d:1,marginRatio:20,adlTrend:'up',bullAlignmentPct:60}
assert.equal(buildMarketRiskQuality(data).status,'complete')
assert.equal(buildMarketRiskQuality({...data,marginRatio:null}).upper_score,10)
assert.equal(buildMarketRiskQuality({...data,marginRatio:null}).status,'bounded')
assert.equal(buildMarketRiskQuality({...data,bullAlignmentPct:null}).status,'blocked')
assert.equal(buildMarketRiskQuality({...data,vix:NaN,twiiVol20:NaN,twiiBias:NaN,foreignNet5d:NaN,marginRatio:NaN,adlTrend:null,bullAlignmentPct:NaN}).upper_score,100)
const date=data.date
const base:any={marketRiskRows:[{date,twii_close:30000,risk_score:0,risk_level:'green'},{date:'2026-10-05',twii_close:29900,risk_score:0,risk_level:'green'}],
 factorPacket:{date,score:0,level:'green'},breadth:{date,advance_ratio:.6,bull_alignment_pct:60},
 regimeState:{source:'hmm',family:'bull',run_date:date,regime_evidence:{hmm_provenance:fixtureProvenance(date,fixtureQuality(date,0).checksum),evidence:{
 price_trend:{status:'available',stance:'bullish',metrics:{twii_bias_20d:.01,twii_return_5d:.04}},
 global_risk:{status:'available',stance:'bullish'},atr_vturn:{metrics:{realized_vol_10d:.005}}}}},
 quality:fixtureQuality(date,0),policy:DEFAULT_RISK_CONFIG.portfolio,expectedSession:date}
const healthy=buildCanonicalMarketRiskContext(base)
assert.equal(healthy.status,'ready');assert.equal(healthy.targetExposureCap,DEFAULT_RISK_CONFIG.portfolio.greenTargetExposure)
for(const patch of [{quality:null},{regimeState:{...base.regimeState,regime_evidence:{}}},{factorPacket:null},{factorPacket:{...base.factorPacket,level:'unknown'}},
 {quality:{...base.quality,status:'blocked'}},{quality:{...base.quality,upper_score:99}},
 // Q2: the stored-risk integrity blocker stays even though the stored level is evidence only.
 {marketRiskRows:[{...base.marketRiskRows[0],risk_level:'unknown'},base.marketRiskRows[1]]}]){
 const result=buildCanonicalMarketRiskContext({...base,...patch})
 assert.equal(result.status,'blocked');assert.equal(result.haltNewBuys,true);assert.equal(result.deRiskExistingPositions,false)
}
// Wei 10/29 Q2: bull alignment is evidence only — neither a blocker nor a trigger.
const noAlignment=buildCanonicalMarketRiskContext({...base,breadth:{...base.breadth,bull_alignment_pct:null}})
assert.equal(noAlignment.status,'ready');assert.equal(noAlignment.bullAlignmentRatio,null)
const onePct=buildCanonicalMarketRiskContext({...base,breadth:{...base.breadth,bull_alignment_pct:1}})
assert.equal(onePct.bullAlignmentRatio,.01);assert.equal(onePct.level,'green')
const bounded=buildCanonicalMarketRiskContext({...base,quality:{...base.quality,status:'bounded'}})
assert.equal(bounded.level,'green','proven identical risk-score bounds do not impose an arbitrary cap')
// Wei 10/29: the level is the HMM effective label with the shock and breadth breakers; no evidence relief (Q1).
const volatile=buildCanonicalMarketRiskContext({...base,regimeState:{...base.regimeState,family:'volatile'}})
assert.equal(volatile.level,'orange','volatile stays orange whatever the trend/global evidence says')
assert(!volatile.reasons.includes('volatile_direction_confirmed_no_stress'))
const loudEvidence=buildCanonicalMarketRiskContext({...base,factorPacket:{...base.factorPacket,level:'red',score:90},
 marketRiskRows:[{...base.marketRiskRows[0],risk_level:'red'},base.marketRiskRows[1]]})
assert.equal(loudEvidence.status,'ready');assert.equal(loudEvidence.level,'green','packet and stored levels are evidence, not the level')
assert(loudEvidence.reasons.includes('evidence_factor_packet=red:90'))
console.log('Market quality: known vs upper scores, missing critical inputs, model contract and HMM-owned level PASS')

const boundedMargin={status:'bounded',ratio_lower:0,ratio_upper:3.681}
const scoreProven=buildMarketRiskQuality({...data,marginRatio:null},{margin:boundedMargin})
assert.equal(scoreProven.status,'bounded');assert(scoreProven.missing.includes('margin_ratio'))
assert.equal(scoreProven.known_score,scoreProven.upper_score)
assert.equal(buildMarketRiskQuality({...data,marginRatio:null},{margin:{...boundedMargin,ratio_upper:90}}).upper_score,10)

const stalePosterior=structuredClone(base)
stalePosterior.regimeState.regime_evidence.hmm_provenance.risk_quality_checksum='f'.repeat(64)
assert.equal(buildCanonicalMarketRiskContext(stalePosterior).status,'blocked','same date is insufficient when HMM used a different risk receipt')
const staleLegacyPrice=buildCanonicalMarketRiskContext({...base,marketRiskRows:[base.marketRiskRows[0],{...base.marketRiskRows[1],twii_close:60000}]})
assert.equal(staleLegacyPrice.shockLevel,null,'canonical same-source prices prevent a false 50% day drop from an old Core row')
assert.equal(staleLegacyPrice.status,'ready')
assert.equal(buildCanonicalMarketRiskContext({...base,expectedPreviousSession:'2026-10-02'}).status,'blocked')
assert.equal(buildCanonicalMarketRiskContext({...base,breadth:{...base.breadth,advance_ratio:1.1}}).status,'blocked','advance_ratio is a fraction, not guessed percent units')

const futureClock=structuredClone(base)
futureClock.decisionAsOfMs=Date.parse('2026-10-07T00:00:00Z')
futureClock.regimeState.computed_at='2026-10-07T01:00:00Z'
assert.equal(buildCanonicalMarketRiskContext(futureClock).status,'blocked','future inference cannot enter the current decision')
