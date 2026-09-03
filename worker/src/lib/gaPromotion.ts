export type GAPromotionLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

export interface GAPromotionDecision {
  level: GAPromotionLevel
  levelLabel: string
  status: 'learning' | 'review_candidate' | 'shadow_config' | 'approval_required' | 'approved'
  autoPromoted: boolean
  approvalRequiredForNextLevel: boolean
  nextLevel: GAPromotionLevel | null
  pendingApprovalLevel: GAPromotionLevel | null
  canRequestNextLevel: boolean
  missingEvidence: string[]
  requiredEvidence: string[]
  nextAction: string
  reasons: string[]
}

const LEVEL_LABELS: Record<GAPromotionLevel, string> = {
  L0: 'Learning only',
  L1: 'Review candidate',
  L2: 'Shadow config',
  L3: 'Limited production meta-policy',
  L4: 'Full production meta-policy',
}

const LEVEL_ORDER: GAPromotionLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4']

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function levelIndex(level: GAPromotionLevel): number {
  return LEVEL_ORDER.indexOf(level)
}

function normalizeLevel(value: unknown): GAPromotionLevel | null {
  return typeof value === 'string' && LEVEL_ORDER.includes(value as GAPromotionLevel)
    ? value as GAPromotionLevel
    : null
}

export const GA_CANDIDATE_LATEST_KEY = 'optimizer:ga:candidate:latest'
export const GA_SHADOW_ACTIVE_KEY = 'optimizer:ga:shadow:active'
export const GA_CHAMPION_KEY = 'optimizer:ga:champion'
export const GA_LEGACY_LATEST_KEY = 'optimizer:ga:latest'

export function isApprovedGaRelease(state: Record<string, any> | null | undefined): boolean {
  const promotion = state?.promotion
  const level = normalizeLevel(promotion?.level ?? promotion?.approved_level)
  return promotion?.status === 'approved' && (level === 'L3' || level === 'L4')
}

function hasPassedGate(state: Record<string, any>): boolean {
  const best = state.best ?? {}
  const gate = best.gate ?? state.gate ?? state.meta?.gate
  if (!gate || typeof gate !== 'object') return false
  return gate.passed === true || gate.decision === 'PASS'
}

function hasPolicyCandidate(state: Record<string, any>): boolean {
  return Boolean(state.best_alphaFramework ?? state.bestAlphaFramework ?? state.best?.candidate?.params?.alphaFramework)
}

function hasProspectiveShadowEvidence(
  state: Record<string, any>,
  level: 'l2' | 'l3' | 'l4',
): boolean {
  const maturity = state.shadow_maturity
  if (!maturity || maturity.schema_version !== 'ga-shadow-promotion-policy-v1') return false
  if (maturity.production_effect !== false) return false
  if (String(maturity.ga_candidate_id ?? '') !== String(state?.best?.candidate?.id ?? '')) return false
  if (String(maturity.shadow_id ?? '') !== String(state?.shadow?.shadow_id ?? '')) return false
  return maturity[`${level}_pass`] === true
}

function hasGovernanceEvidence(state: Record<string, any>): boolean {
  const best = state.best ?? {}
  const metrics = best.metrics ?? state.metrics ?? {}
  const gate = best.gate ?? state.gate ?? {}
  const pbo = finiteNumber(metrics.pbo)
  const mdd95 = finiteNumber(metrics.mdd_95th)
  const sharpe = finiteNumber(metrics.sharpe)
  const tradeCount = finiteNumber(metrics.trade_count)
  const checks = gate.checks ?? {}
  return Boolean(
    checks.pbo === true ||
    checks.monte_carlo_mdd_95th === true ||
    (pbo != null && pbo < 0.5 && mdd95 != null && mdd95 <= 0.2 && sharpe != null && sharpe >= 0.5 && tradeCount != null && tradeCount >= 60),
  )
}

export function evaluateGaPromotion(
  state: Record<string, any>,
  previousState?: Record<string, any> | null,
): GAPromotionDecision {
  const reasons: string[] = []
  const requiredEvidence = [
    'policy_candidate',
    'primary_gate',
    'prospective_shadow_l2',
    'pbo_mc_cost_governance',
    'prospective_shadow_l3_l4',
  ]
  const missingEvidence: string[] = []
  const previousLevel = normalizeLevel(previousState?.promotion?.level) ?? 'L0'
  let level: GAPromotionLevel = 'L0'

  if (!hasPolicyCandidate(state)) {
    missingEvidence.push('policy_candidate')
    reasons.push('no policy candidate')
    return {
      level,
      levelLabel: LEVEL_LABELS[level],
      status: 'learning',
      autoPromoted: false,
      approvalRequiredForNextLevel: false,
      nextLevel: 'L1',
      pendingApprovalLevel: null,
      canRequestNextLevel: false,
      missingEvidence,
      requiredEvidence,
      nextAction: 'Keep GA learning until it emits a policy candidate with fitness evidence.',
      reasons,
    }
  }
  reasons.push('policy candidate present')

  if (hasPassedGate(state)) {
    level = 'L1'
    reasons.push('primary GA gate passed')
  } else {
    missingEvidence.push('primary_gate')
    reasons.push('primary GA gate not passed')
  }

  const governanceEvidence = hasGovernanceEvidence(state)
  const l2ShadowReady = hasProspectiveShadowEvidence(state, 'l2')
  const l3ShadowReady = hasProspectiveShadowEvidence(state, 'l3')
  const l4ShadowReady = hasProspectiveShadowEvidence(state, 'l4')
  if (level === 'L1' && l2ShadowReady && governanceEvidence) {
    level = 'L2'
    reasons.push('frozen prospective shadow plus PBO/MC evidence')
  }
  if (level === 'L1' && !l2ShadowReady) missingEvidence.push('prospective_shadow_l2')
  if (level === 'L1' && !governanceEvidence) missingEvidence.push('pbo_mc_cost_governance')

  if (level === 'L2' && l3ShadowReady) {
    level = 'L3'
    reasons.push('candidate-specific L3 evidence auto-promoted the bounded meta-policy')
  }
  if (level === 'L3' && l4ShadowReady) {
    level = 'L4'
    reasons.push('candidate-specific L4 evidence auto-promoted the full meta-policy')
  }

  const autoPromoted = levelIndex(level) > levelIndex(previousLevel)
  const nextLevel = LEVEL_ORDER[levelIndex(level) + 1] ?? null
  if (level === 'L2' && !l3ShadowReady) missingEvidence.push('prospective_shadow_l3')
  if (level === 'L3' && !l4ShadowReady) missingEvidence.push('prospective_shadow_l4')
  const status = level === 'L0' ? 'learning'
        : level === 'L1' ? 'review_candidate'
          : level === 'L2' ? 'shadow_config'
            : 'approved'
  const nextAction = missingEvidence.length
          ? `Collect missing frozen prospective GA evidence: ${[...new Set(missingEvidence)].join(', ')}.`
          : nextLevel
            ? `Continue automatic GA evidence accumulation toward ${nextLevel}.`
            : 'GA promotion ladder is complete.'

  return {
    level,
    levelLabel: LEVEL_LABELS[level],
    status,
    autoPromoted,
    approvalRequiredForNextLevel: false,
    nextLevel,
    pendingApprovalLevel: null,
    canRequestNextLevel: false,
    missingEvidence: [...new Set(missingEvidence)],
    requiredEvidence,
    nextAction,
    reasons,
  }
}

export function formatGaPromotionNotification(state: Record<string, any>, decision: GAPromotionDecision): string {
  const bestScore = finiteNumber(state?.best?.score ?? state?.meta?.best_score)
  const gate = state?.best?.gate ?? state?.meta?.gate
  const failed = Array.isArray(gate?.failed_gates) && gate.failed_gates.length ? ` failed=${gate.failed_gates.join(',')}` : ''
  const scoreText = bestScore == null ? 'score=N/A' : `score=${bestScore.toFixed(4)}`
  return [
    `StockVision GA promotion: ${decision.level} ${decision.levelLabel}`,
    `status=${decision.status} ${scoreText}${failed}`,
    `next=${decision.nextLevel ?? 'none'} approval_required=${decision.approvalRequiredForNextLevel ? 'yes' : 'no'}`,
    `ready_to_request=${decision.canRequestNextLevel ? 'yes' : 'no'} pending_approval=${decision.pendingApprovalLevel ?? 'none'}`,
    `missing=${decision.missingEvidence.join(',') || 'none'}`,
    `reason=${decision.reasons.join(' | ')}`,
    `next_action=${decision.nextAction}`,
  ].join('\n')
}
