import assert from 'node:assert/strict'
import {
  HOLDING_EXIT_LEARNING_KV_KEY,
  buildHoldingExitLearningObservation,
  defaultHoldingExitLearningState,
  recordHoldingExitSellOutcome,
  updateHoldingExitLearningState,
} from './holdingExitLearning'

const reviewDetail = {
  score: 0.72,
  confidence: 0.9,
  reasons: ['broker_flow_distribution', 'giveback_risk'],
  factors: {
    brokerFlow: 0.9,
    institutionalChip: 0.2,
    moneyFlow: 0.5,
    structure: 0.1,
    giveback: 0.7,
    regime: 0.75,
  },
  features: {
    mfePct: 0.12,
    givebackPct: 0.03,
    regime: 'volatile',
  },
  baseline_counterfactual: { action: 'hold', reason: 'baseline_hold' },
  final_candidate: { source: 'holding_review', action: 'tighten_trail' },
}

const reviewEvent = {
  status: 'tighten_trail',
  reason: 'broker_flow_distribution,giveback_risk',
  detail: reviewDetail,
  createdAt: '2026-05-31T01:00:00Z',
}

const observation = buildHoldingExitLearningObservation({
  tradeDate: '2026-05-31',
  symbol: '2408',
  entryPrice: 100,
  exitPrice: 109,
  shares: 1000,
  exitReason: 'trailing_stop',
  exitSource: 'eod_exit',
  orderId: 42,
  reviewEvent,
})

assert(observation, 'profitable review outcome should produce an observation')
assert.equal(observation.finalAction, 'tighten_trail')
assert.equal(observation.baselineAction, 'hold')
assert(observation.reward > 0, 'retained profit after tighten should receive positive reward')
assert(observation.profitRetention > 0.7, 'observation should estimate profit retention from MFE')

const seed = defaultHoldingExitLearningState('2026-05-31T00:00:00Z')
const learned = updateHoldingExitLearningState(seed, observation, '2026-05-31T02:00:00Z')

assert.equal(learned.sampleCount, 1)
assert(learned.params.weights.brokerFlow > seed.params.weights.brokerFlow, 'positive broker-flow evidence should lift brokerFlow weight')
assert(
  learned.params.thresholds.volatile.tighten < seed.params.thresholds.volatile.tighten,
  'positive tighten outcome should lower volatile tighten threshold within guardrails',
)

const fullExitObservation = {
  ...observation,
  finalAction: 'full_exit',
  reward: 0.8,
  factorValues: {
    ...observation.factorValues,
    structure: 0.55,
    giveback: 0.2,
  },
}
const learnedGate = updateHoldingExitLearningState(seed, fullExitObservation, '2026-05-31T03:00:00Z')
assert(
  learnedGate.params.actionGates.fullExitStructureMin < seed.params.actionGates.fullExitStructureMin,
  'positive full-exit outcome should lower the adaptive full-exit structure gate',
)

const positiveMoveTargetObservation = {
  ...observation,
  finalAction: 'move_tp2',
  reward: 0.75,
  confidence: 0.82,
  score: 0.22,
  realizedReturnPct: 0.14,
  profitRetention: 1.05,
}
const learnedMoveTarget = updateHoldingExitLearningState(seed, positiveMoveTargetObservation, '2026-05-31T04:00:00Z')
assert(
  learnedMoveTarget.params.movingTarget.activationRatio < seed.params.movingTarget.activationRatio,
  'positive move_tp2 outcome should lower activation ratio so winners can extend earlier',
)
assert(
  learnedMoveTarget.params.movingTarget.maxExitRiskScore > seed.params.movingTarget.maxExitRiskScore,
  'positive move_tp2 outcome should tolerate slightly higher exit-risk score',
)
assert(
  learnedMoveTarget.params.movingTarget.minConfidence < seed.params.movingTarget.minConfidence,
  'positive move_tp2 outcome should lower minimum confidence within guardrails',
)
assert(
  learnedMoveTarget.params.movingTarget.maxExtensionPct > seed.params.movingTarget.maxExtensionPct,
  'positive move_tp2 outcome should allow larger target extension',
)

const negativeMoveTargetObservation = {
  ...positiveMoveTargetObservation,
  reward: -0.7,
  profitRetention: 0.2,
}
const learnedBadMoveTarget = updateHoldingExitLearningState(seed, negativeMoveTargetObservation, '2026-05-31T05:00:00Z')
assert(
  learnedBadMoveTarget.params.movingTarget.activationRatio > seed.params.movingTarget.activationRatio,
  'negative move_tp2 outcome should require price to be closer to TP2 before extension',
)
assert(
  learnedBadMoveTarget.params.movingTarget.maxExitRiskScore < seed.params.movingTarget.maxExitRiskScore,
  'negative move_tp2 outcome should tighten exit-risk score guard',
)
assert(
  learnedBadMoveTarget.params.movingTarget.minConfidence > seed.params.movingTarget.minConfidence,
  'negative move_tp2 outcome should raise minimum confidence guard',
)
assert(
  learnedBadMoveTarget.params.movingTarget.maxExtensionPct < seed.params.movingTarget.maxExtensionPct,
  'negative move_tp2 outcome should reduce max target extension',
)

const positivePartialSellObservation = {
  ...observation,
  finalAction: 'partial_sell',
  reward: 0.65,
  confidence: 0.76,
  profitRetention: 0.95,
}
const learnedPartialSell = updateHoldingExitLearningState(seed, positivePartialSellObservation, '2026-05-31T06:00:00Z')
assert(
  learnedPartialSell.params.sellActions.minConfidence < seed.params.sellActions.minConfidence,
  'positive partial_sell outcome should lower guarded sell minimum confidence',
)
assert(
  learnedPartialSell.params.sellActions.partialSellRatio > seed.params.sellActions.partialSellRatio,
  'positive partial_sell outcome should increase partial sell ratio within guardrails',
)

const negativePartialSellObservation = {
  ...positivePartialSellObservation,
  reward: -0.6,
  profitRetention: 0.1,
}
const learnedBadPartialSell = updateHoldingExitLearningState(seed, negativePartialSellObservation, '2026-05-31T07:00:00Z')
assert(
  learnedBadPartialSell.params.sellActions.minConfidence > seed.params.sellActions.minConfidence,
  'negative partial_sell outcome should raise guarded sell minimum confidence',
)
assert(
  learnedBadPartialSell.params.sellActions.partialSellRatio < seed.params.sellActions.partialSellRatio,
  'negative partial_sell outcome should reduce partial sell ratio within guardrails',
)

const partialExposureObservation = buildHoldingExitLearningObservation({
  tradeDate: '2026-05-31',
  symbol: '2408',
  entryPrice: 100,
  exitPrice: 109,
  shares: 1000,
  positionSharesBeforeExit: 5000,
  exitReason: 'guarded_partial_sell',
  exitSource: 'eod_tp1',
  orderId: 49,
  reviewEvent: {
    ...reviewEvent,
    status: 'partial_sell',
    detail: {
      ...reviewDetail,
      final_candidate: { source: 'holding_review', action: 'partial_sell', sellShares: 1000 },
    },
  },
} as any)

assert(partialExposureObservation, 'partial sell outcome should produce an observation')
assert.equal((partialExposureObservation as any).exitShareRatio, 0.2)
assert.equal((partialExposureObservation as any).learningImpactWeight, 0.2)

const learnedWeightedPartial = updateHoldingExitLearningState(seed, partialExposureObservation, '2026-05-31T07:20:00Z')
const learnedFullImpactPartial = updateHoldingExitLearningState(
  seed,
  { ...partialExposureObservation, learningImpactWeight: 1 } as any,
  '2026-05-31T07:25:00Z',
)
assert(
  learnedWeightedPartial.params.sellActions.partialSellRatio - seed.params.sellActions.partialSellRatio
    < learnedFullImpactPartial.params.sellActions.partialSellRatio - seed.params.sellActions.partialSellRatio,
  'small partial sell should have smaller adaptive sizing impact than a full-impact sell outcome',
)

const positiveFullSellObservation = {
  ...observation,
  finalAction: 'full_sell',
  reward: 0.7,
  confidence: 0.78,
}
const learnedFullSell = updateHoldingExitLearningState(seed, positiveFullSellObservation, '2026-05-31T08:00:00Z')
assert(
  learnedFullSell.params.sellActions.minConfidence < seed.params.sellActions.minConfidence,
  'positive full_sell outcome should also lower guarded sell minimum confidence',
)

const movingTp2ReviewEvent = {
  status: 'tighten_trail',
  reason: 'winner_extension',
  detail: {
    ...reviewDetail,
    confidence: 0.84,
    baseline_counterfactual: { action: 'full_sell', reason: 'fixed_tp2_hit' },
    final_candidate: { source: 'holding_review', action: 'tighten_trail' },
    moving_tp_target: {
      action: 'move_tp2',
      currentTp2Price: 120,
      nextTp2Price: 135,
    },
  },
  createdAt: '2026-05-31T09:00:00Z',
}

const movingTp2Observation = buildHoldingExitLearningObservation({
  tradeDate: '2026-05-31',
  symbol: '2408',
  entryPrice: 100,
  exitPrice: 132,
  shares: 1000,
  exitReason: 'moved_tp2_exit',
  exitSource: 'eod_exit',
  orderId: 43,
  reviewEvent: movingTp2ReviewEvent,
})

assert(movingTp2Observation, 'move_tp2 outcome should produce an observation')
assert.equal(movingTp2Observation.finalAction, 'move_tp2')
assert.equal((movingTp2Observation as any).baselineExitPrice, 120)
assert.equal((movingTp2Observation as any).activeVsBaselineReturnDeltaPct, 0.12)
assert.equal((movingTp2Observation as any).activeVsBaselineReturnDeltaAmount, 12000)
assert(movingTp2Observation.reward > 0, 'move_tp2 that beats fixed TP2 should be learned as a positive outcome')

const qualityAwareMoveTp2Observation = buildHoldingExitLearningObservation({
  tradeDate: '2026-05-31',
  symbol: '2408',
  entryPrice: 100,
  exitPrice: 132,
  shares: 1000,
  exitReason: 'moved_tp2_exit',
  exitSource: 'eod_exit',
  orderId: 45,
  reviewEvent: {
    ...movingTp2ReviewEvent,
    detail: {
      ...movingTp2ReviewEvent.detail,
      features: {
        ...reviewDetail.features,
        featureQuality: {
          coverage: 0.67,
          missing: ['brokerFlow'],
        },
      },
    },
  },
})

assert(qualityAwareMoveTp2Observation, 'quality-aware move_tp2 outcome should produce an observation')
assert.equal((qualityAwareMoveTp2Observation as any).featureQualityCoverage, 0.67)
assert.equal((qualityAwareMoveTp2Observation as any).flowEvidenceCoverage, 0.6667)

const learnedQualityMove = updateHoldingExitLearningState(seed, qualityAwareMoveTp2Observation, '2026-05-31T09:30:00Z')
assert(
  learnedQualityMove.params.dataQuality.minCoverageForMoveTarget < seed.params.dataQuality.minCoverageForMoveTarget,
  'positive move_tp2 outcome should adaptively loosen Q move coverage guard',
)
assert(
  learnedQualityMove.params.dataQuality.minFlowCoverageForMoveTarget < seed.params.dataQuality.minFlowCoverageForMoveTarget,
  'positive move_tp2 outcome should adaptively loosen Q move flow guard',
)

const underperformingMoveTp2Observation = buildHoldingExitLearningObservation({
  tradeDate: '2026-05-31',
  symbol: '2408',
  entryPrice: 100,
  exitPrice: 108,
  shares: 1000,
  exitReason: 'moved_tp2_giveback_exit',
  exitSource: 'eod_exit',
  orderId: 44,
  reviewEvent: {
    ...movingTp2ReviewEvent,
    detail: {
      ...movingTp2ReviewEvent.detail,
      features: {
        ...reviewDetail.features,
        mfePct: 0.32,
        givebackPct: 0.24,
        regime: 'volatile',
      },
    },
  },
})

assert(underperformingMoveTp2Observation, 'underperforming move_tp2 outcome should produce an observation')
assert.equal(underperformingMoveTp2Observation.activeVsBaselineReturnDeltaPct, -0.12)
assert(
  underperformingMoveTp2Observation.reward < 0,
  'move_tp2 that materially underperforms fixed TP2 should be learned as a negative counterfactual outcome',
)

const baselinePolicyObservation = buildHoldingExitLearningObservation({
  tradeDate: '2026-05-31',
  symbol: '2408',
  entryPrice: 100,
  exitPrice: 103,
  shares: 1000,
  exitReason: 'Trailing Stop',
  exitSource: 'eod_exit',
  orderId: 46,
  reviewEvent: {
    status: 'full_sell',
    reason: 'baseline_trailing_stop',
    detail: {
      ...reviewDetail,
      baseline_counterfactual: { action: 'full_sell', reason: 'Trailing Stop', exitPrice: 103 },
      final_candidate: { source: 'current_policy', action: 'full_sell' },
    },
    createdAt: '2026-05-31T09:10:00Z',
  },
})

assert(baselinePolicyObservation, 'current-policy exit should still produce an observable outcome')
assert.equal((baselinePolicyObservation as any).activeDecisionSource, 'current_policy')
assert.equal((baselinePolicyObservation as any).learningEligible, false)

const skippedBaselineLearning = updateHoldingExitLearningState(seed, baselinePolicyObservation, '2026-05-31T09:15:00Z')
assert.equal(
  skippedBaselineLearning.sampleCount,
  seed.sampleCount,
  'current-policy exit should not increment adaptive learning sample count',
)
assert.equal(
  skippedBaselineLearning.paramsVersion,
  seed.paramsVersion,
  'current-policy exit should not mutate adaptive params version',
)
assert.deepEqual(
  skippedBaselineLearning.params,
  seed.params,
  'current-policy exit should not change adaptive holding-exit params',
)

const learnedBadQualityMove = updateHoldingExitLearningState(
  seed,
  {
    ...qualityAwareMoveTp2Observation,
    reward: -0.7,
    profitRetention: 0.2,
  },
  '2026-05-31T09:40:00Z',
)
assert(
  learnedBadQualityMove.params.dataQuality.minCoverageForMoveTarget > seed.params.dataQuality.minCoverageForMoveTarget,
  'negative move_tp2 outcome should adaptively tighten Q move coverage guard',
)
assert(
  learnedBadQualityMove.params.dataQuality.minFlowCoverageForMoveTarget > seed.params.dataQuality.minFlowCoverageForMoveTarget,
  'negative move_tp2 outcome should adaptively tighten Q move flow guard',
)

const learnedQualitySell = updateHoldingExitLearningState(
  seed,
  {
    ...positivePartialSellObservation,
    featureQualityCoverage: 0.67,
    flowEvidenceCoverage: 0.6667,
  } as any,
  '2026-05-31T09:50:00Z',
)
assert(
  learnedQualitySell.params.dataQuality.minCoverageForSellAction < seed.params.dataQuality.minCoverageForSellAction,
  'positive sell outcome should adaptively loosen Q sell coverage guard',
)
assert(
  learnedQualitySell.params.dataQuality.minFlowCoverageForSellAction < seed.params.dataQuality.minFlowCoverageForSellAction,
  'positive sell outcome should adaptively loosen Q sell flow guard',
)

const delayedTargetReviewDetail = {
  ...reviewDetail,
  baseline_counterfactual: { action: 'full_sell', reason: 'moved TP2 hit' },
  final_candidate: { source: 'current_policy', action: 'full_sell', priority: 'TP2', reason: 'TP2 moved target hit' },
}

const delayedTargetUpdateDetail = {
  action: 'move_tp2',
  reason: 'low_exit_risk_extend_tp2',
  currentTp2Price: 120,
  nextTp2Price: 135,
  baselineCounterfactual: { action: 'full_sell', reason: 'fixed TP2 hit' },
  evidence: { score: 0.2, confidence: 0.86, regime: 'bull', activationRatio: 0.985, atrMultiplier: 1.8, targetCap: 134.4 },
}

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, type?: string) {
    const raw = this.store.get(key) ?? null
    if (raw == null) return null
    return type === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

function rowDay(row: any): string {
  return String(row?.created_at ?? '').slice(0, 10)
}

class FakeStatement {
  args: unknown[] = []

  constructor(private db: FakeDB, private sql: string) {}

  bind(...args: unknown[]) {
    this.args = args
    return this
  }

  async first() {
    if (this.sql.includes("event_type='holding_exit_outcome'")) {
      const row = this.db.duplicateOutcomeRow
      if (!row) return null
      if (this.sql.includes("status IN ('learned','observed')")) {
        return row.status === 'learned' || row.status === 'observed' ? row : null
      }
      if (this.sql.includes("status='skipped'")) {
        const reasonArg = this.args.find((arg) => typeof arg === 'string' && String(arg).includes('holding_exit_review'))
        if (row.status !== 'skipped') return null
        if (reasonArg && row.reason !== reasonArg) return null
        return row
      }
      return row
    }
    if (this.sql.includes("event_type='holding_exit_target_update'")) {
      if (this.db.targetUpdateRows.length > 0) return this.db.targetUpdateRows[0]
      return this.db.targetUpdateRow
    }
    if (this.sql.includes("event_type='holding_exit_review'")) {
      if (this.db.reviewRow === false) return null
      if (this.db.reviewRows.length > 0) return this.db.reviewRows[0]
      return this.db.reviewRow ?? {
        status: reviewEvent.status,
        reason: reviewEvent.reason,
        detail_json: JSON.stringify(reviewDetail),
        created_at: reviewEvent.createdAt,
      }
    }
    return null
  }

  async all() {
    if (this.sql.includes("event_type='holding_exit_target_update'")) {
      const rows = this.db.targetUpdateRows.length > 0
        ? this.db.targetUpdateRows
        : this.db.targetUpdateRow ? [this.db.targetUpdateRow] : []
      const results = this.applyLifecycleFilter(rows)
      return { results }
    }
    if (this.sql.includes("event_type='holding_exit_review'")) {
      if (this.db.reviewRow === false) return { results: [] }
      const rows = this.db.reviewRows.length > 0
        ? this.db.reviewRows
        : this.db.reviewRow ? [this.db.reviewRow] : [{
            status: reviewEvent.status,
            reason: reviewEvent.reason,
            detail_json: JSON.stringify(reviewDetail),
            created_at: reviewEvent.createdAt,
          }]
      const results = this.applyLifecycleFilter(rows)
      return { results }
    }
    return { results: [] }
  }

  private applyLifecycleFilter(rows: any[]) {
    const lifecycleArgs = this.args.slice(2).map((arg) => String(arg ?? '').slice(0, 10)).filter(Boolean)
    let next = rows
    if (this.sql.includes('date(created_at) >= date(?)') && lifecycleArgs[0]) {
      const entryDay = lifecycleArgs[0]
      next = next.filter((row) => rowDay(row) >= entryDay)
    }
    if (this.sql.includes('date(created_at) <= date(?)')) {
      const tradeDay = lifecycleArgs[this.sql.includes('date(created_at) >= date(?)') ? 1 : 0]
      if (tradeDay) next = next.filter((row) => rowDay(row) <= tradeDay)
    }
    if (this.sql.includes('LIMIT 10')) return next.slice(0, 10)
    return next
  }

  async run() {
    this.db.runs.push({ sql: this.sql, args: this.args })
    return { success: true }
  }
}

class FakeDB {
  runs: Array<{ sql: string; args: unknown[] }> = []
  reviewRow: any = null
  reviewRows: any[] = []
  targetUpdateRow: any = null
  targetUpdateRows: any[] = []
  duplicateOutcomeRow: any = null

  prepare(sql: string) {
    return new FakeStatement(this, sql)
  }
}

async function runFutureReviewFallsBackToLatestEligibleReviewContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRows = [
    {
      status: reviewEvent.status,
      reason: reviewEvent.reason,
      detail_json: JSON.stringify({
        ...reviewDetail,
        final_candidate: { source: 'holding_review', action: 'tighten_trail' },
      }),
      created_at: '2026-06-01T09:00:00Z',
    },
    {
      status: reviewEvent.status,
      reason: reviewEvent.reason,
      detail_json: JSON.stringify({
        ...reviewDetail,
        final_candidate: { source: 'holding_review', action: 'tighten_trail' },
      }),
      created_at: '2026-05-31T11:00:00Z',
    },
  ]

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 56,
  })

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'learned')
  assert.equal(outcome.observation?.reviewCreatedAt, '2026-05-31T11:00:00Z')
  assert(
    fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'future review should not hide an earlier eligible review for the same outcome date',
  )
}

async function runManyFutureReviewsDoNotHideEligibleReviewContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRows = [
    ...Array.from({ length: 10 }, (_, index) => ({
      status: reviewEvent.status,
      reason: `future_review_${index}`,
      detail_json: JSON.stringify(reviewDetail),
      created_at: `2026-06-${String(index + 1).padStart(2, '0')}T09:00:00Z`,
    })),
    {
      status: reviewEvent.status,
      reason: reviewEvent.reason,
      detail_json: JSON.stringify({
        ...reviewDetail,
        final_candidate: { source: 'holding_review', action: 'tighten_trail' },
      }),
      created_at: '2026-05-31T11:00:00Z',
    },
  ]

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 58,
  })

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'learned')
  assert.equal(outcome.observation?.reviewCreatedAt, '2026-05-31T11:00:00Z')
  assert(
    fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'DB lookup must filter future review rows before applying LIMIT',
  )
}

async function runFutureMovingTargetFallsBackToLatestEligibleTargetContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: 'full_sell',
    reason: 'TP2 moved target hit',
    detail_json: JSON.stringify(delayedTargetReviewDetail),
    created_at: '2026-05-31T11:00:00Z',
  }
  fakeDb.targetUpdateRows = [
    {
      status: 'move_tp2',
      reason: 'future_extension',
      detail_json: JSON.stringify({
        ...delayedTargetUpdateDetail,
        currentTp2Price: 140,
        nextTp2Price: 150,
      }),
      created_at: '2026-06-01T09:00:00Z',
    },
    {
      status: 'move_tp2',
      reason: 'low_exit_risk_extend_tp2',
      detail_json: JSON.stringify(delayedTargetUpdateDetail),
      created_at: '2026-05-31T09:00:00Z',
    },
  ]

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 132,
    shares: 1000,
    exitReason: 'TP2 moved target hit',
    exitSource: 'eod_exit',
    orderId: 57,
  })

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'learned')
  assert.equal((outcome.observation as any)?.activeDecisionSource, 'moving_tp_target')
  assert.equal((outcome.observation as any)?.baselineExitPrice, 120)
  assert(
    fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'future moving-TP2 update should not hide an earlier eligible target update',
  )
}

async function runManyFutureTargetsDoNotHideEligibleTargetContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: 'full_sell',
    reason: 'TP2 moved target hit',
    detail_json: JSON.stringify(delayedTargetReviewDetail),
    created_at: '2026-05-31T11:00:00Z',
  }
  fakeDb.targetUpdateRows = [
    ...Array.from({ length: 10 }, (_, index) => ({
      status: 'move_tp2',
      reason: `future_extension_${index}`,
      detail_json: JSON.stringify({
        ...delayedTargetUpdateDetail,
        currentTp2Price: 140,
        nextTp2Price: 150,
      }),
      created_at: `2026-06-${String(index + 1).padStart(2, '0')}T09:00:00Z`,
    })),
    {
      status: 'move_tp2',
      reason: 'low_exit_risk_extend_tp2',
      detail_json: JSON.stringify(delayedTargetUpdateDetail),
      created_at: '2026-05-31T09:00:00Z',
    },
  ]

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 132,
    shares: 1000,
    exitReason: 'TP2 moved target hit',
    exitSource: 'eod_exit',
    orderId: 59,
  })

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'learned')
  assert.equal((outcome.observation as any)?.activeDecisionSource, 'moving_tp_target')
  assert.equal((outcome.observation as any)?.baselineExitPrice, 120)
  assert(
    fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'DB lookup must filter future moving-TP2 rows before applying LIMIT',
  )
}

async function runPersistenceContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 42,
  })

  assert.equal(outcome.recorded, true)
  assert(fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY), 'learning state should be persisted to KV')
  assert(
    fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome')),
    'sell outcome should write an auditable holding_exit_outcome event',
  )
}

async function runDelayedMovingTargetAttributionContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: 'full_sell',
    reason: 'TP2 moved target hit',
    detail_json: JSON.stringify(delayedTargetReviewDetail),
    created_at: '2026-05-31T11:00:00Z',
  }
  fakeDb.targetUpdateRow = {
    status: 'move_tp2',
    reason: 'low_exit_risk_extend_tp2',
    detail_json: JSON.stringify(delayedTargetUpdateDetail),
    created_at: '2026-05-31T09:00:00Z',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryPrice: 100,
    exitPrice: 132,
    shares: 1000,
    exitReason: 'TP2 moved target hit',
    exitSource: 'eod_exit',
    orderId: 47,
  })

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'learned')
  assert.equal((outcome.observation as any)?.activeDecisionSource, 'moving_tp_target')
  assert.equal((outcome.observation as any)?.learningEligible, true)
  assert.equal((outcome.observation as any)?.baselineExitPrice, 120)
  assert.equal((outcome.observation as any)?.activeVsBaselineReturnDeltaPct, 0.12)
  assert(
    fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'delayed moving-TP2 outcome should update adaptive learning state',
  )
}

async function runStaleMovingTargetLifecycleGuardContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: 'full_sell',
    reason: 'Trailing Stop',
    detail_json: JSON.stringify(delayedTargetReviewDetail),
    created_at: '2026-05-31T11:00:00Z',
  }
  fakeDb.targetUpdateRow = {
    status: 'move_tp2',
    reason: 'low_exit_risk_extend_tp2',
    detail_json: JSON.stringify(delayedTargetUpdateDetail),
    created_at: '2026-05-30T09:00:00Z',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 103,
    shares: 1000,
    exitReason: 'Trailing Stop',
    exitSource: 'eod_exit',
    orderId: 48,
  } as any)

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'observed_not_learned')
  assert.equal((outcome.observation as any)?.activeDecisionSource, 'current_policy')
  assert.equal((outcome.observation as any)?.learningEligible, false)
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'stale moving-TP2 event before current entry date must not update adaptive learning state',
  )
}

async function runFutureMovingTargetLifecycleGuardContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: 'full_sell',
    reason: 'Trailing Stop',
    detail_json: JSON.stringify(delayedTargetReviewDetail),
    created_at: '2026-05-31T11:00:00Z',
  }
  fakeDb.targetUpdateRow = {
    status: 'move_tp2',
    reason: 'low_exit_risk_extend_tp2',
    detail_json: JSON.stringify(delayedTargetUpdateDetail),
    created_at: '2026-06-01T09:00:00Z',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 103,
    shares: 1000,
    exitReason: 'Trailing Stop',
    exitSource: 'eod_exit',
    orderId: 54,
  } as any)

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'observed_not_learned')
  assert.equal((outcome.observation as any)?.activeDecisionSource, 'current_policy')
  assert.equal((outcome.observation as any)?.learningEligible, false)
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'future moving-TP2 event after the exit trade date must not update adaptive learning state',
  )
}

async function runStaleReviewLifecycleGuardContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: reviewEvent.status,
    reason: reviewEvent.reason,
    detail_json: JSON.stringify(reviewDetail),
    created_at: '2026-05-30T11:00:00Z',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 50,
  })

  assert.equal(outcome.recorded, false)
  assert.equal(outcome.reason, 'stale_holding_exit_review')
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'review before current entry date must not update adaptive learning state',
  )
  assert(
    fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome') && run.args.includes('skipped') && run.args.includes('stale_holding_exit_review')),
    'review before current entry date should write a skipped holding_exit_outcome audit event',
  )
}

async function runFutureReviewLifecycleGuardContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: reviewEvent.status,
    reason: reviewEvent.reason,
    detail_json: JSON.stringify(reviewDetail),
    created_at: '2026-06-01T11:00:00Z',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 55,
  })

  assert.equal(outcome.recorded, false)
  assert.equal(outcome.reason, 'future_holding_exit_review')
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'review after the exit trade date must not update adaptive learning state',
  )
  assert(
    fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome') && run.args.includes('skipped') && run.args.includes('future_holding_exit_review')),
    'future review should write a skipped holding_exit_outcome audit event',
  )
}

async function runMissingReviewSkipAuditContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = false

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 51,
  })

  assert.equal(outcome.recorded, false)
  assert.equal(outcome.reason, 'missing_holding_exit_review')
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'missing holding-exit review must not update adaptive learning state',
  )
  assert(
    fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome') && run.args.includes('skipped') && run.args.includes('missing_holding_exit_review')),
    'missing review should write a skipped holding_exit_outcome audit event',
  )
}

async function runDuplicateSkippedOutcomeAuditContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = false
  fakeDb.duplicateOutcomeRow = {
    id: 101,
    status: 'skipped',
    reason: 'missing_holding_exit_review',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 60,
  })

  assert.equal(outcome.recorded, false)
  assert.equal(outcome.reason, 'missing_holding_exit_review')
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'duplicate skipped audit must not update adaptive learning state',
  )
  assert(
    !fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome') && run.args.includes('skipped') && run.args.includes('missing_holding_exit_review')),
    'same order id and skip reason should not write duplicate skipped holding_exit_outcome audit rows',
  )
}

async function runInvalidOutcomeSkipAuditContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.reviewRow = {
    status: reviewEvent.status,
    reason: reviewEvent.reason,
    detail_json: JSON.stringify(reviewDetail),
    created_at: '2026-05-31T11:00:00Z',
  }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryDate: '2026-05-31',
    entryPrice: 0,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 53,
  })

  assert.equal(outcome.recorded, false)
  assert.equal(outcome.reason, 'invalid_holding_exit_outcome')
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'invalid holding-exit outcome must not update adaptive learning state',
  )
  assert(
    fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome') && run.args.includes('skipped') && run.args.includes('invalid_holding_exit_outcome')),
    'invalid outcome should write a skipped holding_exit_outcome audit event',
  )
}

async function runDuplicateOutcomeIdempotencyContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.duplicateOutcomeRow = { id: 99, status: 'learned' }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 42,
  })

  assert.equal(outcome.recorded, false)
  assert.equal(outcome.reason, 'duplicate_holding_exit_outcome')
  assert(
    !fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'duplicate sell outcome must not update adaptive learning state',
  )
  assert(
    !fakeDb.runs.some((run) => run.args.includes('holding_exit_outcome')),
    'duplicate sell outcome must not write another holding_exit_outcome event',
  )
}

async function runSkippedOutcomeDoesNotBlockRetryContract() {
  const fakeKv = new FakeKV()
  const fakeDb = new FakeDB()
  fakeDb.duplicateOutcomeRow = { id: 100, status: 'skipped' }

  const outcome = await recordHoldingExitSellOutcome({
    env: { DB: fakeDb, KV: fakeKv } as any,
    tradeDate: '2026-05-31',
    symbol: '2408',
    entryPrice: 100,
    exitPrice: 109,
    shares: 1000,
    exitReason: 'trailing_stop',
    exitSource: 'eod_exit',
    orderId: 52,
  })

  assert.equal(outcome.recorded, true)
  assert.equal(outcome.reason, 'learned')
  assert(
    fakeKv.store.has(HOLDING_EXIT_LEARNING_KV_KEY),
    'a prior skipped audit should not block a later valid learning retry for the same order id',
  )
}

Promise.all([
  runPersistenceContract(),
  runFutureReviewFallsBackToLatestEligibleReviewContract(),
  runManyFutureReviewsDoNotHideEligibleReviewContract(),
  runFutureMovingTargetFallsBackToLatestEligibleTargetContract(),
  runManyFutureTargetsDoNotHideEligibleTargetContract(),
  runDelayedMovingTargetAttributionContract(),
  runStaleMovingTargetLifecycleGuardContract(),
  runFutureMovingTargetLifecycleGuardContract(),
  runStaleReviewLifecycleGuardContract(),
  runFutureReviewLifecycleGuardContract(),
  runMissingReviewSkipAuditContract(),
  runDuplicateSkippedOutcomeAuditContract(),
  runInvalidOutcomeSkipAuditContract(),
  runDuplicateOutcomeIdempotencyContract(),
  runSkippedOutcomeDoesNotBlockRetryContract(),
]).catch((error) => {
  console.error(error)
  process.exit(1)
})
