import assert from 'node:assert/strict'
import test from 'node:test'
import { SWING_POLICY_VERSION, type SwingEntryDecision } from './paperSwingPolicy'
import { swingExecutionAuthorization, swingExecutionRejection } from './paperSwingExecution'
import { resolveAdaptiveExecutionPolicy } from './executionAdaptivePolicy'
import { normalizeTwLimitPrice } from './twMarketRules'

const now=Date.parse('2026-10-14T10:35:00+08:00')
const decision: SwingEntryDecision={action:'pass',reason:'swing_or15_vwap_relative_strength',policy:SWING_POLICY_VERSION,
  signalMs:now,signalKey:`2026-10-14:${now}`,submitUntilMs:now+60_000,orHigh:614,orLow:593,
  maxBuyPrice:normalizeTwLimitPrice(614*1.018,'buy')}

test('2327 assessment ceiling 625 survives legacy pullback/orange ceiling 616; fill 622 passes',()=>{
  const adaptive=resolveAdaptiveExecutionPolicy({strategyMode:'pullback',marketRiskLevel:'orange',
    base:{minVolumeRatio:.75,minRangePosition:.3,maxEntryChasePct:.009,strongBreakoutMaxEntryChasePct:.018}})
  assert.equal(normalizeTwLimitPrice(614*(1+adaptive.policy.strongBreakoutMaxEntryChasePct),'buy'),616)
  const authorization=swingExecutionAuthorization(decision)!
  assert.equal(authorization.maxBuyPrice,625)
  assert.equal(Object.isFrozen(authorization),true)
  assert.equal(swingExecutionRejection(authorization,{nowMs:now+23_000,fillPrice:622,limitPrice:622,limitUp:658}),null)
  assert.equal(swingExecutionRejection(authorization,{nowMs:now+23_000,fillPrice:625,limitPrice:625,limitUp:658}),null)
  assert.equal(swingExecutionRejection(authorization,{nowMs:now+23_000,fillPrice:622,limitPrice:626,limitUp:658}),'swing_chase_limit')
  assert.equal(swingExecutionRejection(authorization,{nowMs:now+23_000,fillPrice:626,limitPrice:626,limitUp:658}),'swing_chase_limit')
  assert.equal(swingExecutionRejection(authorization,{nowMs:now+60_000,fillPrice:622,limitPrice:622,limitUp:658}),'swing_next_bar_submission_missed')
  assert.equal(swingExecutionRejection(authorization,{nowMs:now,fillPrice:622,limitPrice:622,limitUp:622}),'swing_buy_at_limit')
})

test('missing, deferred, or malformed authorization fails closed',()=>{
  assert.equal(swingExecutionAuthorization(undefined),null)
  assert.equal(swingExecutionAuthorization({...decision,action:'defer'}),null)
  for(const invalid of [{maxBuyPrice:NaN},{maxBuyPrice:0},{orLow:0},{submitUntilMs:now+300_000},{signalKey:undefined}])
    assert.equal(swingExecutionAuthorization({...decision,...invalid}),null)
  const input={nowMs:now,fillPrice:622,limitPrice:622,limitUp:658}
  assert.equal(swingExecutionRejection(null,input),'swing_execution_window_or_price_changed')
  assert.equal(swingExecutionRejection(swingExecutionAuthorization(decision),{...input,limitUp:NaN}),'swing_execution_window_or_price_changed')
})
