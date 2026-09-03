import fs from 'node:fs'
import { evaluateGaPromotion, formatGaPromotionNotification } from './gaPromotion'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function shadowMaturity(l2: boolean, l3: boolean, l4: boolean) {
  return {
    schema_version: 'ga-shadow-promotion-policy-v1',
    ga_candidate_id: 'ga-test-candidate',
    l2_pass: l2,
    shadow_id: 'ga-shadow-v1:test',
    l3_pass: l3,
    l4_pass: l4,
    production_effect: false,
  }
}

{
  const learning = evaluateGaPromotion({})
  assert(learning.level === 'L0', 'missing GA candidate should stay at L0')
  assert(learning.status === 'learning', 'L0 status should be learning')
  assert(learning.missingEvidence.includes('policy_candidate'), 'L0 should explain missing policy candidate')
}

{
  const invalidApproval = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: { gate: { passed: false }, score: 0.9 },
    history: [{ generation: 0, best_score: 0.9 }],
    promotion: { requested_level: 'L4', approved_level: 'L4', level: 'L4', status: 'approved' },
  })
  assert(invalidApproval.level === 'L0', 'manual approval must not bypass a failed primary gate')
  assert(invalidApproval.status === 'learning', 'invalid stale approval must fall back to evidence-derived learning state')
  assert(invalidApproval.missingEvidence.includes('primary_gate'), 'invalid approval should expose the missing primary gate')
  assert(invalidApproval.reasons.includes('primary GA gate not passed'), 'stored manual state must not override evidence-derived failure')
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
      candidate: { id: 'ga-test-candidate' },
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
    shadow_maturity: shadowMaturity(true, false, false),
    shadow: { shadow_id: 'ga-shadow-v1:test' },
  }, { promotion: { level: 'L1' } })
  assert(shadow.level === 'L2', 'prospective GA evidence should auto-promote to L2 shadow config')
  assert(shadow.autoPromoted === true, 'L1 to L2 should be automatic')
  assert(shadow.nextLevel === 'L3', 'L2 next step is limited production meta-policy')
  assert(shadow.approvalRequiredForNextLevel === false, 'GA promotion must be evidence-driven without manual approval')
  assert(shadow.canRequestNextLevel === false, 'automatic promotion must not create a manual request queue')
  assert(shadow.missingEvidence.includes('prospective_shadow_l3'), 'L2 must expose the remaining L3 evidence gate')
}

{
  const mismatchedShadow = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      candidate: { id: 'ga-test-candidate' },
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    shadow_maturity: {
      ...shadowMaturity(true, true, true),
      shadow_id: 'ga-shadow-v1:another-run',
    },
    shadow: { shadow_id: 'ga-shadow-v1:test' },
  })
  assert(mismatchedShadow.level === 'L1', 'maturity from another frozen shadow must not promote this candidate')
  assert(
    mismatchedShadow.missingEvidence.includes('prospective_shadow_l2'),
    'shadow identity mismatch must remain visible as missing prospective evidence',
  )
}

{
  const blocked = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      candidate: { id: 'ga-test-candidate' },
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
    promotion: { requested_level: 'L3' },
    shadow_maturity: shadowMaturity(true, true, false),
    shadow: { shadow_id: 'ga-shadow-v1:test' },
  }, { promotion: { level: 'L2' } })
  assert(blocked.level === 'L3', 'complete L3 evidence must auto-promote regardless of stale manual request fields')
  assert(blocked.status === 'approved', 'evidence-complete L3 should materialize as an approved meta-policy')
  assert(blocked.pendingApprovalLevel === null, 'automatic promotion must not retain a pending approval')
  assert(blocked.approvalRequiredForNextLevel === false, 'L4 must also remain evidence-driven')
}

{
  const approved = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      candidate: { id: 'ga-test-candidate' },
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
    promotion: { requested_level: 'L3', approved_level: 'L3' },
    shadow_maturity: shadowMaturity(true, true, false),
    shadow: { shadow_id: 'ga-shadow-v1:test' },
  }, { promotion: { level: 'L2' } })
  assert(approved.level === 'L3', 'complete L3 evidence should auto-promote to the bounded meta-policy')
  assert(approved.status === 'approved', 'automatic L3 production meta-policy should be explicit')
  assert(approved.nextLevel === 'L4', 'automatic L3 should expose L4 as the next level')
  assert(approved.canRequestNextLevel === false, 'automatic L3 must not wait for a manual L4 request')
  assert(approved.nextAction.includes('prospective_shadow_l4'), 'automatic L3 should expose the remaining L4 evidence')
  assert(formatGaPromotionNotification({ best: { score: 1.1 } }, approved).includes('L3'), 'notification should include promotion level')
  assert(formatGaPromotionNotification({ best: { score: 1.1 } }, approved).includes('prospective_shadow_l4'), 'notification should include missing L4 evidence')
}

{
  const full = evaluateGaPromotion({
    best_alphaFramework: { allocation: { weights: {} } },
    best: {
      candidate: { id: 'ga-test-candidate' },
      score: 1.1,
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    history: [
      { generation: 0, best_score: 1.0 },
      { generation: 1, best_score: 1.1 },
    ],
    promotion: { requested_level: 'L4', approved_level: 'L4' },
    shadow_maturity: shadowMaturity(true, true, true),
    shadow: { shadow_id: 'ga-shadow-v1:test' },
  }, { promotion: { level: 'L3' } })
  assert(full.level === 'L4', 'complete L4 evidence should auto-promote to the full production meta-policy')
  assert(full.status === 'approved', 'automatic L4 should be explicit')
  assert(full.nextLevel === null, 'L4 should complete the GA promotion ladder')
}

const reviewRoute = fs.readFileSync('src/routes/adminOptunaRoutes.ts', 'utf8')
assert(reviewRoute.includes("error: 'ga_promotion_evidence_not_ready'"), 'review route must block requests without complete evidence')
assert(reviewRoute.includes("error: 'ga_promotion_request_not_pending'"), 'review route must block approvals without a pending request')
assert(
  reviewRoute.includes("status: 'PENDING'") &&
    reviewRoute.includes("status: 'COMPLETE'") &&
    reviewRoute.includes('candidate_shadow_kv_readback'),
  'GA candidate projection must remain pending until frozen shadow D1/KV materialization closes',
)
const observability = fs.readFileSync('src/lib/observabilityEvents.ts', 'utf8')
assert(!observability.includes('level: storedPromotion?.level ?? evaluatedPromotion.level'), 'OBS must not revive a stale stored GA level')
assert(!observability.includes('status: storedPromotion?.status ?? evaluatedPromotion.status'), 'OBS must not revive a stale stored GA status')

console.log('ga promotion tests passed')
