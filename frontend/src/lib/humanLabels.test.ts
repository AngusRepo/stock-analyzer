import assert from 'node:assert/strict'
import test from 'node:test'
import { strategyDisplayLabel } from './humanLabels'

test('strategy display_name from the Worker wins; null falls back to the mechanical id label', () => {
  assert.equal(strategyDisplayLabel('momentum_breakout_v3', '動能突破'), '動能突破')
  assert.equal(strategyDisplayLabel('momentum_breakout_v3', null), 'momentum breakout · v3')
  assert.equal(strategyDisplayLabel('momentum_breakout_v3', '  '), 'momentum breakout · v3')
  assert.equal(strategyDisplayLabel('momentum_breakout_v3'), 'momentum breakout · v3', 'old Worker without the field')
})
