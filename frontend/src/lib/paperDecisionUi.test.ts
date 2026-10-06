import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { visiblePendingBuys, debateObservationLabel, positionL4View } from './paperDecisionUi'
import { formatPositionRiskPlan } from './pendingBuyExecutionUi'

const rows = [
  { symbol: '3441', debate_status: 'completed', debate_verdict: 'DOWNGRADE' },
  { symbol: '5475', debate_status: 'completed', debate_verdict: 'DOWNGRADE' },
  { symbol: '3004', debate_status: 'pending', debate_verdict: 'PENDING' },
  { symbol: '8039', debate_status: 'pending', debate_verdict: 'PENDING' },
]
assert.equal(visiblePendingBuys({ pendingBuys: rows }).length, 4)
assert.equal(visiblePendingBuys({ pendingBuys: [{ debate_status: 'completed', debate_verdict: 'REJECT' }] }).length, 1)
assert.deepEqual(visiblePendingBuys(null), [])
assert.deepEqual(visiblePendingBuys({ pendingBuys: { holdings: ['6994'] } }), [])
assert.equal(debateObservationLabel(rows[0]), '辯論觀察：保守')
assert.equal(debateObservationLabel(rows[2]), '辯論觀察待完成')
assert.equal(debateObservationLabel({ debate_status: 'completed', debate_verdict: 'REJECT' }), '辯論觀察：反對')
assert.equal(positionL4View(null).label, '暫無判斷')
const held = positionL4View({ status: 'ready', action: 'hold', trade_date: '2026-10-06',
  held_at_decision: true, decision_weight: .03307791968314604, target_weight: .03307791968314604 })
assert.equal(held.label, '續抱')
assert.equal(held.weights, '決策時 3.3078% → 目標 3.3078%')
assert.equal(positionL4View({ status: 'ready', action: 'exit' }).label, '出清目標')
assert.equal(positionL4View({ status: 'ready', action: 'locked' }).label, '保留持倉（未重新評估）')
const risk = formatPositionRiskPlan({ canonical_trade_lifecycle: { swing: {
  policy: 'or15-5m-orl8-20-v1', entryPrice: 33, entryOrLow: 31 } } })
assert.equal(risk.primaryS12, false)
assert.match(risk.tpSource!, /ORL 31/)
assert.match(risk.stopSource!, /8%/)
const source = readFileSync(new URL('../pages/BotDashboard.tsx', import.meta.url), 'utf8')
assert(source.includes('visiblePendingBuys(pbData)'))
assert(!source.includes('allPendingBuys.filter'))
assert(!source.includes('辯論降級通過'))
assert(!source.includes('FallbackRecommendations'))
assert(!source.includes('>S12防守<'))
assert(!source.includes('>S12出場<'))
assert(source.includes('positionL4View(p.l4_assessment)'))
console.log('paperDecisionUi: production four-row replay, advisory verdicts, L4 intent and OR15 presentation passed')
