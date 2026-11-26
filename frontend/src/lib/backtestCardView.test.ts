import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import { formatDrawdownPct, thresholdTone } from './backtestCardView'

test('missing threshold metrics are not-checked (na), never fail', () => {
  assert.equal(thresholdTone(null, 1), 'na')
  assert.equal(thresholdTone(undefined, 1.5), 'na')
  assert.equal(thresholdTone(Number.NaN, 1), 'na')
  assert.equal(thresholdTone(1.2, 1), 'ok')
  assert.equal(thresholdTone(0.8, 1), 'fail')
})

test('drawdown always carries the minus sign', () => {
  assert.equal(formatDrawdownPct(0.123), '-12.3%')
  assert.equal(formatDrawdownPct(-0.123), '-12.3%')
  assert.equal(formatDrawdownPct(null), '—')
})

test('BacktestCard uses the shared helpers instead of `?? 0` threshold checks', () => {
  const page = fs.readFileSync('src/pages/BotDashboard.tsx', 'utf8')
  const card = page.slice(page.indexOf('function BacktestCard'), page.indexOf('function AdaptiveParamsCard'))
  assert.ok(!/\?\? 0\) >/.test(card), 'a null metric must not be compared as 0 (shows a false fail)')
  assert.ok(card.includes('thresholdTone(') && card.includes('formatDrawdownPct('))
})
