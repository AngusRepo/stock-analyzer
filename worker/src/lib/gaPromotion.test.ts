import { evaluateGaPromotion, formatGaPromotionNotification } from './gaPromotion'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const learning = evaluateGaPromotion({})
  assert(learning.level === 'L0', 'missing GA candidate should stay at L0')
  assert(learning.status === 'learning', 'L0 status should be learning')
}

{
  const review = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: { gate: { passed: true }, score: 0.9 },
    history: [{ generation: 0, best_score: 0.9 }],
  })
  assert(review.level === 'L1', 'single gate-passing candidate should reach L1 review')
  assert(review.approvalRequiredForNextLevel === false, 'L1 next level is auto lane')
}

{
  const shadow = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
  }, { promotion: { level: 'L1' } })
  assert(shadow.level === 'L2', 'stable GA evidence should auto-promote to L2 shadow config')
  assert(shadow.autoPromoted === true, 'L1 to L2 should be automatic')
  assert(shadow.nextLevel === 'L3', 'L2 next step is limited production')
  assert(shadow.approvalRequiredForNextLevel === true, 'L3 requires Wei approval')
}

{
  const blocked = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
    promotion: { requested_level: 'L3' },
  }, { promotion: { level: 'L2' } })
  assert(blocked.level === 'L2', 'L3 request without approval must remain at L2')
  assert(blocked.status === 'shadow_config', 'unapproved L3 request should keep safe L2 status')
}

{
  const approved = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
    promotion: { requested_level: 'L3', approved_level: 'L3' },
  }, { promotion: { level: 'L2' } })
  assert(approved.level === 'L3', 'approved L3 request should advance to L3')
  assert(approved.status === 'approved', 'approved production level should be explicit')
  assert(formatGaPromotionNotification({ best: { score: 1.1 } }, approved).includes('L3'), 'notification should include promotion level')
}
