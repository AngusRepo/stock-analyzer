import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settledL4DowngradeSymbols } from './pendingBuyOrchestrator'
import type { L4PortfolioPlan } from './l4PortfolioPlan'

const source = {
  signal_date: '2026-09-24',
  targets: { '3576': { weight: 0.125 }, '7792': { weight: 0.125 } },
}
const plan = {
  signal_date: '2026-09-24',
  targets: { '3576': { weight: 0.0625 }, '7792': { weight: 0.0625 } },
  constraints: { name_caps: { '3576': 0.0625, '7792': 0.0625 } },
} as unknown as L4PortfolioPlan

test('settled L4 downgrade survives a plan rebase only when its cap is applied', () => {
  const rows = [
    {
      request_json: JSON.stringify({ reason: 'debate_risk_cap', weight_caps: { '3576': 0.0625 } }),
      source_payload_json: JSON.stringify(source),
    },
    {
      request_json: JSON.stringify({ reason: 'debate_risk_cap', weight_caps: { '7792': 0.04 } }),
      source_payload_json: JSON.stringify(source),
    },
  ]
  assert.deepEqual([...settledL4DowngradeSymbols(plan, rows)], ['3576'])
  assert.deepEqual([...settledL4DowngradeSymbols(
    { ...plan, signal_date: '2026-09-25' }, rows,
  )], [])
})

test('unapplied, malformed, or non-debate caps do not complete a debate', () => {
  const rows = [
    { request_json: '{bad', source_payload_json: JSON.stringify(source) },
    {
      request_json: JSON.stringify({ reason: 'account_risk_changed', weight_caps: { '3576': 0.0625 } }),
      source_payload_json: JSON.stringify(source),
    },
    {
      request_json: JSON.stringify({ reason: 'debate_risk_cap', weight_caps: { '3576': 0.0625 } }),
      source_payload_json: JSON.stringify({ ...source, targets: { '3576': { weight: 0.04 } } }),
    },
  ]
  assert.equal(settledL4DowngradeSymbols(plan, rows).size, 0)
})
