import type { CanonicalMarketRiskContext, CanonicalMarketRiskLevel } from './marketRiskRuntime'

export interface RuntimeMarketRiskDisplay {
  owner: string
  policyVersion: string | null
  status: 'ready' | 'blocked' | 'awaiting_next_session'
  // The level Paper buys/halts use; a blocked runtime trades as black. Null only while awaiting the next session.
  level: CanonicalMarketRiskLevel | null
  score: number | null
  date: string | null
  expectedSession: string | null
  haltNewBuys: boolean | null
  targetExposureCap: number | null
  blockers: string[]
  reasons: string[]
  computedAt: string
}

// Blockers a decision run gets only because its expected session lags the session that has already landed:
// the date check itself, and the receipts it reads for the expected (previous) session.
const NEXT_SESSION_LANDED_BLOCKERS: ReadonlySet<string> = new Set([
  'market_risk_expected_session_mismatch',
  'market_risk_benchmark_price_lineage_mismatch',
  'market_risk_quality_unverified',
  'hmm_model_input_contract_unverified',
  'stored_risk_v2_invalid',
  'stored_risk_v2_missing',
])

/**
 * Display projection of resolveCanonicalMarketRisk (the context riskChain gives P3 and Paper entry).
 * After today's close today's market_risk lands while the decision date still expects the previous session;
 * the level it sets is decided at the next session's setup, so that window is reported as awaiting rather than
 * as the blocked black a decision run now would get. Any other blocker (config, policy, packet, breadth, regime)
 * still halts trading and stays blocked.
 */
// End of the Paper continuous session (13:25 TW, isPaperContinuousSession): no decision run reads the level after it.
const SESSION_CLOSE_TW_MINUTE = 805

export function runtimeMarketRiskDisplay(context: CanonicalMarketRiskContext, computedAt: string): RuntimeMarketRiskDisplay {
  const expectedSession = context.lineage.expectedSession ?? null
  const computedMs = Date.parse(computedAt)
  // Same TW calendar date and clock the runtime derives its decision date from.
  const tw = Number.isFinite(computedMs) ? new Date(computedMs + 8 * 3600_000) : null
  const decisionDate = tw ? tw.toISOString().slice(0, 10) : null
  const afterClose = tw != null && tw.getUTCHours() * 60 + tw.getUTCMinutes() >= SESSION_CLOSE_TW_MINUTE
  // Before the close (pre-open setup or intraday) a landed same-day row is a real halt, never awaiting.
  const awaiting = afterClose && context.status === 'blocked'
    && context.blockers.includes('market_risk_expected_session_mismatch')
    && context.blockers.every(blocker => NEXT_SESSION_LANDED_BLOCKERS.has(blocker))
    && context.date != null && context.date === decisionDate
    && expectedSession != null && context.date > expectedSession
  return {
    owner: context.lineage.owner,
    policyVersion: context.lineage.policyVersion ?? null,
    status: awaiting ? 'awaiting_next_session' : context.status,
    level: awaiting ? null : context.level,
    score: awaiting ? null : context.score,
    date: context.date,
    expectedSession,
    haltNewBuys: awaiting ? null : context.haltNewBuys,
    targetExposureCap: awaiting ? null : context.targetExposureCap,
    blockers: context.blockers,
    reasons: context.reasons,
    computedAt,
  }
}
