import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChampionTradingConfig, validateTradingConfig } from './tradingConfig'

// HL1-4#a: screener.delistingMonitorMaxRecentSessions is a registered data-quality threshold
// (integer >= 0, unset = default 2 at the reader). It is not an alpha parameter and not in Optuna.

const message = 'screener.delistingMonitorMaxRecentSessions must be an integer >= 0'

test('unset (undefined or null, like the reader) or a non-negative integer is valid', () => {
  for (const value of [undefined, null as unknown as number, 0, 2, 5]) {
    const config = buildChampionTradingConfig(null)
    if (value !== undefined) config.screener.delistingMonitorMaxRecentSessions = value
    assert.ok(!validateTradingConfig(config).includes(message), String(value))
  }
})

test('a negative, fractional or non-numeric value is rejected', () => {
  for (const value of [-1, 1.5, Number.NaN, '2' as unknown as number]) {
    const config = buildChampionTradingConfig(null)
    config.screener.delistingMonitorMaxRecentSessions = value
    assert.ok(validateTradingConfig(config).includes(message), String(value))
  }
})
