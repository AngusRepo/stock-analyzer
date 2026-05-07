export type GAPromotionLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

export interface GAPromotionDecision {
  level: GAPromotionLevel
  levelLabel: string
  status: 'learning' | 'review_candidate' | 'shadow_config' | 'approval_required' | 'approved'
  autoPromoted: boolean
  approvalRequiredForNextLevel: boolean
  nextLevel: GAPromotionLevel | null
  reasons: string[]
}

const LEVEL_LABELS: Record<GAPromotionLevel, string> = {
  L0: 'Learning only',
  L1: 'Review candidate',
  L2: 'Shadow config',
  L3: 'Limited production config',
  L4: 'Full production config',
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

function hasPassedGate(state: Record<string, any>): boolean {
  const best = state.best ?? {}
  const gate = best.gate ?? state.gate ?? state.meta?.gate
  if (!gate || typeof gate !== 'object') return false
  return gate.passed === true || gate.decision === 'PASS'
}

function hasPolicyCandidate(state: Record<string, any>): boolean {
  return Boolean(state.best_alphaFramework ?? state.bestAlphaFramework ?? state.best?.candidate?.params?.alphaFramework)
}

function hasStableHistory(state: Record<string, any>): boolean {
  const history = Array.isArray(state.history) ? state.history : []
  if (history.length < 2) return false
  const last = finiteNumber(history[history.length - 1]?.best_score)
  const prev = finiteNumber(history[history.length - 2]?.best_score)
  if (last == null || prev == null) return false
  return last >= prev
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
  const approvedLevel = normalizeLevel(state?.promotion?.approved_level ?? state?.meta?.promotion_approved_level)
  const previousLevel = normalizeLevel(previousState?.promotion?.level) ?? 'L0'
  let level: GAPromotionLevel = 'L0'

  if (!hasPolicyCandidate(state)) {
    reasons.push('no policy candidate')
    return {
      level,
      levelLabel: LEVEL_LABELS[level],
      status: 'learning',
      autoPromoted: false,
      approvalRequiredForNextLevel: false,
      nextLevel: 'L1',
      reasons,
    }
  }
  reasons.push('policy candidate present')

  if (hasPassedGate(state)) {
    level = 'L1'
    reasons.push('primary GA gate passed')
  } else {
    reasons.push('primary GA gate not passed')
  }

  if (level === 'L1' && hasStableHistory(state) && hasGovernanceEvidence(state)) {
    level = 'L2'
    reasons.push('stable generation history plus PBO/MC evidence')
  }

  const requestedLevel = normalizeLevel(state?.promotion?.requested_level ?? state?.meta?.promotion_requested_level)
  const targetApprovalLevel = requestedLevel && levelIndex(requestedLevel) > levelIndex(level) ? requestedLevel : null
  if (targetApprovalLevel && levelIndex(targetApprovalLevel) >= levelIndex('L3')) {
    if (approvedLevel && levelIndex(approvedLevel) >= levelIndex(targetApprovalLevel)) {
      level = targetApprovalLevel
      reasons.push(`Wei approval accepted for ${targetApprovalLevel}`)
    } else {
      reasons.push(`${targetApprovalLevel} requires Wei approval`)
    }
  }

  const autoPromoted = levelIndex(level) > levelIndex(previousLevel) && levelIndex(level) <= levelIndex('L2')
  const nextLevel = LEVEL_ORDER[levelIndex(level) + 1] ?? null
  const approvalRequiredForNextLevel = nextLevel != null && levelIndex(nextLevel) >= levelIndex('L3')
  const status =
    level === 'L0' ? 'learning'
      : level === 'L1' ? 'review_candidate'
        : level === 'L2' ? 'shadow_config'
          : approvedLevel && levelIndex(approvedLevel) >= levelIndex(level) ? 'approved'
            : 'approval_required'

  return {
    level,
    levelLabel: LEVEL_LABELS[level],
    status,
    autoPromoted,
    approvalRequiredForNextLevel,
    nextLevel,
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
    `reason=${decision.reasons.join(' | ')}`,
  ].join('\n')
}
