import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveStrategyRawSignals, withStrategyRawSignalCache, resolveLegacyMonthlyRevenueEvidence } from './strategySpec'

test('routing cache is scoped to a synchronous pass, raw identity and evidence mode', () => {
  const raw = { close: 42, monthlyRevenueYoY: 12, monthlyRevenueEvidence: resolveLegacyMonthlyRevenueEvidence({
    signalDate: '2026-09-21', observedTaipeiDate: '2026-09-21', evidenceMode: 'live_current' }).evidence }
  const row = { symbol: '2330', raw_signals: raw }
  const expected = deriveStrategyRawSignals(row, { evidenceMode: 'live_current' })
  withStrategyRawSignalCache(() => {
    const first = deriveStrategyRawSignals(row, { evidenceMode: 'live_current' })
    assert.deepEqual(first, expected)
    assert.equal(deriveStrategyRawSignals(row, { evidenceMode: 'live_current' }), first)
    assert.notEqual(deriveStrategyRawSignals(row), first)
    assert.notEqual(deriveStrategyRawSignals({ symbol: '2330', raw_signals: { ...raw } }, { evidenceMode: 'live_current' }), first)
    withStrategyRawSignalCache(() => assert.notEqual(deriveStrategyRawSignals(row, { evidenceMode: 'live_current' }), first))
    assert.equal(deriveStrategyRawSignals(row, { evidenceMode: 'live_current' }), first)
  })
  raw.close = 99
  assert.equal(deriveStrategyRawSignals(row).close, 99)
  assert.throws(() => withStrategyRawSignalCache(() => { deriveStrategyRawSignals(row); throw Error('test') }))
  raw.close = 101
  assert.equal(deriveStrategyRawSignals(row).close, 101)
})
