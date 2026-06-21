import assert from 'node:assert/strict'
import { checkExitConditions, type ExitPosition } from './paperExitPolicy'
import { buildChampionTradingConfig } from './tradingConfig'

const cfg = buildChampionTradingConfig(null)

function position(overrides: Partial<ExitPosition> = {}): ExitPosition {
  return {
    symbol: '2330',
    shares: 2000,
    avg_cost: 100,
    entry_price: 100,
    initial_stop: 90,
    trailing_stop: 100,
    highest_since_entry: 109,
    tp1_price: 105,
    tp2_price: 110,
    tp1_hit: 1,
    original_shares: 2000,
    entry_date: '2026-06-01',
    stop_multiplier: null,
    ...overrides,
  }
}

{
  const decision = checkExitConditions(
    position(),
    111,
    2,
    false,
    false,
    cfg,
  )

  assert.equal(decision.action, 'hold')
  assert.match(decision.reason, /moving TP2 update/)
  assert.equal(decision.newHighest, 111)
  assert.equal(decision.newTp2Price, 113)
  assert.equal(decision.newTrailingStop, 107)
}

{
  const decision = checkExitConditions(
    position({ highest_since_entry: 112 }),
    111,
    2,
    false,
    false,
    cfg,
  )

  assert.equal(decision.action, 'full_sell')
  assert.match(decision.reason, /TP2 take profit/)
}
