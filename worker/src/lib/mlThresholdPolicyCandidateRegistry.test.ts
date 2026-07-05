import {
  buildGaOptimizerPolicyValidationEvidence,
  buildMlThresholdPolicyCandidateEvidence,
} from './parameterCandidateRegistry'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const validationEvidence = {
  walk_forward_oos: { status: 'pass', sharpe: 1.2 },
  cpcv_pbo: { status: 'pass', pbo: 0.12 },
  regime_segments: { status: 'pass', covered: ['bull', 'chop'] },
  twse_otc_segments: { status: 'pass', covered: ['LISTED', 'OTC'] },
  turnover_capacity: { status: 'pass', turnover: 0.31 },
  collapse_guard: { status: 'pass', all_hold: false, all_buy: false },
}

const policyCandidate = {
  policy_id: 'threshold-policy-candidate-20260704',
  status: 'candidate',
  trained_until: '2026-07-03',
  effective_from: '2026-07-04',
  mutates_trading_config: false,
  thresholds: {
    strongBuyThreshold: 0.85,
    buyThreshold: 0.70,
    sellThreshold: 0.30,
    strongSellThreshold: 0.15,
  },
  validation_evidence: validationEvidence,
}

const passed = buildMlThresholdPolicyCandidateEvidence({
  candidate: policyCandidate,
  source: 'optuna',
  candidateId: 'parameter:optuna:threshold-policy-candidate-20260704',
})

assert(passed.decision === 'PASS', 'complete threshold policy candidate evidence should pass')
assert(passed.validation_status === 'PROMOTION_READY', 'passing threshold candidate should become promotion ready')
assert(
  (passed.validation_packet as Record<string, unknown>).decision === 'PASS',
  'threshold candidate validation packet must carry PASS decision',
)

const blocked = buildMlThresholdPolicyCandidateEvidence({
  candidate: {
    ...policyCandidate,
    mutates_trading_config: true,
    validation_evidence: {
      ...validationEvidence,
      collapse_guard: { status: 'pass', all_hold: true, all_buy: false },
    },
  },
  source: 'ga_optimizer',
})

const blockers = blocked.blockers as string[]
assert(blocked.decision === 'FAIL', 'invalid threshold policy candidate should fail')
assert(blockers.includes('threshold_policy_candidate_must_not_mutate_trading_config'), 'candidate must not mutate trading config')
assert(blockers.includes('all_hold_collapse'), 'all-HOLD collapse must block promotion')

const gaEvidence = buildGaOptimizerPolicyValidationEvidence({
  learningState: {
    best: {
      score: 0.77,
      gate: { decision: 'PASS' },
      metrics: { sharpe: 1.1, pbo: 0.15, mdd_95th: 0.08, trade_count: 160 },
      candidate: {
        params: {
          alphaFramework: { allocation: { weights: {} } },
          mlThresholdPolicy: policyCandidate,
        },
      },
    },
  },
  promotion: {
    level: 'L3',
    missingEvidence: [],
  },
  latestKey: 'optimizer:ga:latest',
  kvReadbackOk: true,
  candidateId: 'parameter:ga_optimizer:threshold-policy-candidate-20260704',
})

assert(gaEvidence.decision === 'PASS', 'GA packet with valid threshold candidate should pass')
assert(
  (gaEvidence.validation_packet as Record<string, unknown>).threshold_policy_candidate != null,
  'GA validation packet must include threshold policy candidate evidence when provided',
)
