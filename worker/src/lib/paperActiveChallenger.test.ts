import {
  buildPaperActiveRuntimePolicy,
  normalizePaperChallengerCandidate,
  normalizePaperDecisionAttribution,
  normalizePaperChallengerDailyMetrics,
  normalizePromotionAuditEvent,
  recordPaperActivePromotionAudit,
  recordPaperActivePostmarketReport,
  recordPaperChallengerCandidate,
  recordPaperChallengerDailyMetrics,
  recordPaperDecisionAttribution,
  validatePaperActiveRuntimePacket,
} from './paperActiveChallenger'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
  }
}

function createMockEnv() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                calls.push({ sql, params })
                return { success: true }
              },
            }
          },
        }
      },
    },
  }
  return { env, calls }
}

{
  const policy = buildPaperActiveRuntimePolicy()
  assert(policy.schemaVersion === 'paper-active-runtime-v1', 'policy should expose stable schema')
  assert(policy.canInfluencePaperDecision === true, 'paper-active may influence paper decisions')
  assert(policy.canWritePaperAttribution === true, 'paper-active may write attribution')
  assert(policy.canWriteOrder === false, 'paper-active must not write orders')
  assert(policy.canSubmitRealOrder === false, 'paper-active must not submit real orders')
}

{
  const violations = validatePaperActiveRuntimePacket({
    canInfluencePaperDecision: true,
    canWritePaperAttribution: true,
    canWriteOrder: true,
    canSubmitRealOrder: true,
    canWriteRegime: true,
    canWriteMlVote: true,
    canWrite106Feature: true,
  })

  assertDeepEqual(violations, [
    'paper_active_must_not_write_order',
    'paper_active_must_not_submit_real_order',
    'paper_active_must_not_write_regime',
    'paper_active_must_not_write_ml_vote',
    'paper_active_must_not_write_106_feature',
  ], 'runtime validator should reject forged production authority')
}

{
  const attribution = normalizePaperDecisionAttribution({
    tradeDate: '2026-05-17',
    symbol: '2330',
    decision: 'candidate',
    paperLane: 'paper_active_challenger',
    candidateSource: 'finlab-broker-concentration',
    baselineScore: 0.61,
    challengerScore: 0.74234,
    featureSetVersion: 'finlab-v4.1',
    regimeVersion: 'market-regime-state-v4',
    evidenceSources: ['finlab.rotc_broker_transactions', 'finlab.security_categories'],
  })

  assert(attribution.decisionDelta === 0.13234, 'decision delta should be deterministic')
  assert(attribution.canWriteOrder === false, 'attribution must not write orders')
  assertDeepEqual(attribution.evidenceSources, [
    'finlab.rotc_broker_transactions',
    'finlab.security_categories',
  ], 'evidence sources should be preserved')
}

{
  const candidate = normalizePaperChallengerCandidate({
    candidateId: 'finlab-broker-concentration',
    candidateType: 'finlab_feature',
    currentState: 'paper_active_challenger',
    source: 'finlab',
    featureSetVersion: 'finlab-v4.1',
    promotionPacket: { decision: 'ALLOW_PAPER_ACTIVE_CHALLENGER' },
  })

  assert(candidate.currentState === 'paper_active_challenger', 'candidate state should be preserved')
  assert(candidate.promotionPacketJson?.includes('ALLOW_PAPER_ACTIVE_CHALLENGER'), 'promotion packet should be JSON encoded')
}

{
  const metrics = normalizePaperChallengerDailyMetrics({
    tradeDate: '2026-05-17',
    candidateId: 'finlab-broker-concentration',
    paperDecisionCount: 38,
    precisionAtK: 0.48,
    hitRate: 0.54,
    avgReturnPct: 3.1,
    maxDrawdownPct: -7.6,
    turnoverRatio: 3.2,
    topkOverlap: 0.72,
    regimeSplitPassed: true,
    runtimeSpeedupPct: 18.4,
    metrics: { blind_spot_coverage: 'emerging_broker_flow' },
  })

  assert(metrics.regimeSplitPassed === 1, 'boolean regime split should normalize to D1 integer')
  assert(metrics.metricsJson?.includes('emerging_broker_flow'), 'metrics JSON should preserve blind spot metadata')
}

{
  const audit = normalizePromotionAuditEvent({
    candidateId: 'finlab-broker-concentration',
    fromState: 'paper_active_challenger',
    toState: 'paper_primary',
    decision: 'PROMOTE_TO_PAPER_PRIMARY',
    failedGates: [],
    packet: { real_trading_effect: 'none' },
  })

  assert(audit.realTradingEffect === 'none', 'paper promotion audit must keep real effect none')
  assert(audit.packetJson.includes('real_trading_effect'), 'packet should be JSON encoded')
}

async function runPersistenceChecks() {
  const { env, calls } = createMockEnv()
  await recordPaperChallengerCandidate(env as any, {
    candidateId: 'finlab-broker-concentration',
    candidateType: 'finlab_feature',
    currentState: 'paper_active_challenger',
    source: 'finlab',
  })
  await recordPaperDecisionAttribution(env as any, {
    tradeDate: '2026-05-17',
    symbol: '2330',
    decision: 'candidate',
    candidateSource: 'finlab-broker-concentration',
    baselineScore: 0.61,
    challengerScore: 0.74,
  })
  await recordPaperChallengerDailyMetrics(env as any, {
    tradeDate: '2026-05-17',
    candidateId: 'finlab-broker-concentration',
    paperDecisionCount: 38,
  })
  await recordPaperActivePromotionAudit(env as any, {
    candidateId: 'finlab-broker-concentration',
    decision: 'KEEP_PAPER_ACTIVE',
    packet: { next_state: 'paper_active_challenger' },
  })

  assert(calls.length === 4, 'four D1 writes should be issued')
  assert(calls[0].sql.includes('paper_challenger_candidates'), 'candidate upsert should target candidate table')
  assert(calls[1].sql.includes('paper_decision_attribution'), 'attribution insert should target attribution table')
  assert(calls[2].sql.includes('paper_challenger_daily_metrics'), 'metrics upsert should target daily metrics table')
  assert(calls[3].sql.includes('promotion_audit_events'), 'audit insert should target promotion audit table')
}

void runPersistenceChecks()

async function runPostmarketReportPersistenceCheck() {
  const { env, calls } = createMockEnv()
  const summary = await recordPaperActivePostmarketReport(env as any, {
    schema_version: 'paper-challenger-postmarket-report-v1',
    generated_at: '2026-05-17T13:45:00Z',
    promotion_packets: [
      {
        candidate_id: 'finlab-broker-concentration',
        candidate_type: 'finlab_feature',
        current_state: 'paper_active_challenger',
        next_state: 'paper_primary',
        decision: 'PROMOTE_TO_PAPER_PRIMARY',
        failed_gates: [],
        challenger_metrics: {
          paper_decision_count: 42,
          precision_at_k: 0.54,
          hit_rate: 0.58,
          avg_return_pct: 3.2,
          max_drawdown_pct: -6.4,
          turnover_ratio: 2.8,
          topk_overlap: 0.74,
          regime_split_passed: true,
          runtime_speedup_pct: 12.5,
        },
        real_trading_effect: 'none',
      },
    ],
    audit_events: [
      {
        candidate_id: 'finlab-broker-concentration',
        from_state: 'paper_active_challenger',
        to_state: 'paper_primary',
        decision: 'PROMOTE_TO_PAPER_PRIMARY',
        failed_gates: [],
        packet: { real_trading_effect: 'none' },
        real_trading_effect: 'none',
      },
    ],
    real_trading_effect: 'none',
  })

  assertDeepEqual(summary, {
    candidates: 1,
    dailyMetrics: 1,
    auditEvents: 1,
  }, 'postmarket report should persist all promotion evidence families')
  assert(calls.some((call) => call.sql.includes('paper_challenger_candidates')), 'report should upsert candidate state')
  assert(calls.some((call) => call.sql.includes('paper_challenger_daily_metrics')), 'report should upsert challenger metrics')
  assert(calls.some((call) => call.sql.includes('promotion_audit_events')), 'report should insert audit event')
  assert(!calls.some((call) => call.sql.includes('paper_orders')), 'postmarket report must never write orders')
}

void runPostmarketReportPersistenceCheck()
