import assert from 'node:assert/strict'
import test from 'node:test'
import { humanJobSummary, strategyDisplayLabel } from './humanLabels'

test('strategy display_name from the Worker wins; null falls back to the mechanical id label', () => {
  assert.equal(strategyDisplayLabel('momentum_breakout_v3', '動能突破'), '動能突破')
  assert.equal(strategyDisplayLabel('momentum_breakout_v3', null), 'momentum breakout · v3')
  assert.equal(strategyDisplayLabel('momentum_breakout_v3', '  '), 'momentum breakout · v3')
  assert.equal(strategyDisplayLabel('momentum_breakout_v3'), 'momentum breakout · v3', 'old Worker without the field')
})

test('humanJobSummary drops embedded JSON blobs and keeps the readable part untruncated', () => {
  const blob = JSON.stringify({ input: { signal_date: '2026-11-25', l3_receipt: { checksum: 'a'.repeat(64) } } })
  const out = humanJobSummary(`status=success event_driven_ready market_health=success ${blob} tail=ok`)
  assert.equal(out, `status=success event driven ready market health=success tail=ok（另有機器明細 ${blob.length.toLocaleString()} 字）`)
  const long = 'k=v '.repeat(200).trim()
  assert.equal(humanJobSummary(long), long)
  assert.equal(humanJobSummary('cutoff=[1,2] ok'), 'cutoff=[1,2] ok')
  const unclosed = '{"a": "' + 'x'.repeat(50)
  assert.equal(humanJobSummary(`broken ${unclosed}`), `broken（另有機器明細 ${unclosed.length} 字）`)
  assert.equal(humanJobSummary(undefined), '')
})
