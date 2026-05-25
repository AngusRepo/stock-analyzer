import assert from 'node:assert/strict'
import {
  brokerFlowWindowSummary,
  buildBrokerFlowLine,
  buildChipFlowHistogram,
  latestChipFlowSummary,
  normalizeBrokerFlowRows,
  normalizeChipFlowRows,
} from './chipFlowSeries'

const rows = normalizeChipFlowRows([
  { date: '2026-05-21', foreign_net: 3000, trust_net: -1000, dealer_net: 0 },
  { date: '2026-05-20', foreign_net: -2000, trust_net: -1000, dealer_net: 500 },
  { date: 'bad-date', foreign_net: 1 },
])

assert.equal(rows.length, 2)
assert.equal(rows[0].date, '2026-05-20')
assert.equal(rows[0].totalNet, -2500)
assert.equal(rows[1].totalNet, 2000)

const histogram = buildChipFlowHistogram(rows)
assert.equal(histogram[0].time, '2026-05-20')
assert.equal(histogram[0].value, -2)
assert.match(histogram[0].color, /52, 211, 153/)
assert.equal(histogram[1].value, 2)
assert.match(histogram[1].color, /248, 113, 113/)

const latest = latestChipFlowSummary(rows)
assert.equal(latest?.date, '2026-05-21')
assert.equal(latest?.foreignLots, 3)
assert.equal(latest?.trustLots, -1)
assert.equal(latest?.dealerLots, 0)
assert.equal(latest?.totalLots, 2)

const brokerRows = normalizeBrokerFlowRows([
  { date: '2026-05-20', net_shares: 1000, estimated_amount: 500000, broker_count: 2, concentration: 0.4 },
  { date: '2026-05-22', net_shares: -2500, estimated_amount: -900000, broker_count: 3, concentration: 0.5 },
  { date: '2026-05-21', net_shares: 1500, estimated_amount: 700000, broker_count: 4, concentration: 0.45 },
])

assert.equal(brokerRows[2].date, '2026-05-22')
assert.equal(buildBrokerFlowLine(brokerRows)[1].value, 2)

const brokerSummary = brokerFlowWindowSummary(brokerRows, 2)
assert.equal(brokerSummary?.date, '2026-05-22')
assert.equal(brokerSummary?.windowDays, 2)
assert.equal(brokerSummary?.netLots, -1)
assert.equal(brokerSummary?.brokerCount, 3)
assert.equal(brokerSummary?.concentration, 0.5)
