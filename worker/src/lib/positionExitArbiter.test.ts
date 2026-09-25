import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePositionExit, positionTakeProfitSatisfied, preparePositionTakeProfit, recordPositionTakeProfitFill } from './positionExitArbiter'
import type { ExitDecision } from './paperExitPolicy'

const hold: ExitDecision = { action: 'hold', reason: 'S12 structural hold', newTrailingStop: 95 }
const partial = (shares: number, reason = 'S12 TP1'): ExitDecision =>
  ({ action: 'partial_sell', reason, sellShares: shares, exitIntentKind: 'take_profit', moveStopToEntry: true })
const full: ExitDecision = { action: 'full_sell', reason: 'S12 stop', exitIntentKind: 'risk_stop' }
const l4 = (shares: number): ExitDecision => ({ ...partial(shares, '[L4Target] test'), moveStopToEntry: undefined })

test('simultaneous S12 TP1 and L4 liquidation produce one full reduction', () => {
  const result = resolvePositionExit({ positionShares: 1000, positionDecision: partial(200),
    l4Decision: { action: 'full_sell', reason: '[L4Target] zero', exitIntentKind: 'take_profit' } })
  assert.equal(result.decision.action, 'full_sell')
  assert.equal(result.evidence.requested_shares, 1000)
  assert.equal(result.evidence.selected_owner, 'l4_target')
  assert.deepEqual(result.evidence.proposals.map(p => p.requestedShares), [200, 1000])
  assert.equal(result.decision.moveStopToEntry, undefined)
})
test('overlapping reductions are not added; stricter target wins', () => {
  const result = resolvePositionExit({ positionShares: 1000, positionDecision: partial(200), l4Decision: l4(600) })
  assert.equal(result.decision.sellShares, 600)
  assert.equal(result.evidence.selected_owner, 'l4_target')
})
test('S12 larger or equal reduction keeps its intent and lifecycle semantics', () => {
  for (const quantity of [100, 200]) {
    const positionDecision = { ...partial(200), tradeLifecycleJson: '{"keep":true}' }
    const result = resolvePositionExit({ positionShares: 1000, positionDecision, l4Decision: l4(quantity) })
    assert.deepEqual(result.decision, positionDecision)
    assert.equal(result.evidence.selected_owner, 'position_policy')
  }
})
test('urgent exits do not depend on invalid optional proposals', () => {
  const invalid = partial(NaN)
  assert.deepEqual(resolvePositionExit({ positionShares: 1000, positionDecision: full, l4Decision: invalid }).decision, full)
  const risk = { ...full, reason: '[PortfolioRisk] hard exit' }
  const result = resolvePositionExit({ positionShares: 1000, positionDecision: invalid, l4Decision: invalid, riskDecision: risk })
  assert.deepEqual(result.decision, risk)
  assert.equal(result.evidence.selected_owner, 'portfolio_risk')
})
test('hold updates survive without a sell; frozen inputs are not mutated', () => {
  const frozen = Object.freeze({ ...hold })
  assert.deepEqual(resolvePositionExit({ positionShares: 1000, positionDecision: frozen }).decision, frozen)
  assert.equal(resolvePositionExit({ positionShares: 1000, positionDecision: frozen, l4Decision: l4(400) }).decision.sellShares, 400)
  assert.deepEqual(frozen, hold)
})
test('reject invalid position sizes and impossible reductions before execution', () => {
  for (const shares of [0, -1, 1.5, NaN]) assert.throws(() =>
    resolvePositionExit({ positionShares: shares, positionDecision: hold }), /position_invalid/)
  for (const shares of [-1, 0, 1001, 2.5, NaN]) assert.throws(() =>
    resolvePositionExit({ positionShares: 1000, positionDecision: hold, l4Decision: l4(shares) }), /reduction_invalid/)
  assert.throws(() => resolvePositionExit({ positionShares: 1000, positionDecision: hold, riskDecision: hold }), /risk_contract/)
})


test('only actual fills covering the position TP1 advance its lifecycle', () => {
  const result = resolvePositionExit({ positionShares: 1000, positionDecision: partial(200), l4Decision: l4(600) })
  for (const quantity of [0, 199]) assert.equal(positionTakeProfitSatisfied(result, quantity), false)
  for (const quantity of [200, 600]) assert.equal(positionTakeProfitSatisfied(result, quantity), true)
  const onlyL4 = resolvePositionExit({ positionShares: 1000, positionDecision: hold, l4Decision: l4(600) })
  assert.equal(positionTakeProfitSatisfied(onlyL4, 600), false)
  assert.throws(() => positionTakeProfitSatisfied(result, 1001), /fill_invalid/)
})


test('TP1 progress survives serialized restart and counts only unfilled shares', () => {
  const initial = { lifecycle: null as unknown, entryDate: '2026-09-24', tp1Hit: false,
    positionShares: 4000, decision: partial(2000) }
  const first = preparePositionTakeProfit(initial)
  const fill = recordPositionTakeProfitFill(first.progress, 1000, initial.lifecycle)
  assert.equal(fill.complete, false)
  const second = preparePositionTakeProfit({ ...initial, positionShares: 3000, lifecycle: fill.lifecycleJson })
  assert.equal(second.decision.sellShares, 1000)
  const completed = recordPositionTakeProfitFill(second.progress, 1000, fill.lifecycleJson)
  assert.equal(completed.complete, true)
  assert.equal(JSON.parse(completed.lifecycleJson!).position_tp1_progress.filled_shares, 2000)
  assert.equal(first.progress!.filled_shares, 0)
  const nextEntry = preparePositionTakeProfit({ ...initial, entryDate: '2026-09-25', lifecycle: fill.lifecycleJson })
  assert.equal(nextEntry.decision.sellShares, 2000)
  assert.equal(preparePositionTakeProfit({ ...initial, lifecycle: '{bad', decision: full }).decision, full)
})

test('held TP1 progress pauses below trigger; a concurrent L4 fill can satisfy it', () => {
  const progress = { schema_version: 'position-tp1-progress-v1' as const, entry_date: '2026-09-24', target_shares: 2000, filled_shares: 1000 }
  const lifecycle = JSON.stringify({ custom: true, position_tp1_progress: progress })
  const prepared = preparePositionTakeProfit({ lifecycle, entryDate: progress.entry_date,
    tp1Hit: false, positionShares: 3000, decision: hold })
  assert.equal(prepared.decision.action, 'hold')
  const fill = recordPositionTakeProfitFill(prepared.progress, 1500, lifecycle)
  assert.equal(fill.complete, true)
  assert.equal(JSON.parse(fill.lifecycleJson!).custom, true)
  assert.equal(JSON.parse(fill.lifecycleJson!).position_tp1_progress.filled_shares, 2000)
})
