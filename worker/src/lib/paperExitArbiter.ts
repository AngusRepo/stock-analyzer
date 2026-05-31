import type { ExitDecision } from './paperExitPolicy'

export type PaperExitPriority =
  | 'HARD_STOP'
  | 'INIT_STOP'
  | 'ML_SELL'
  | 'HOLDING_REVIEW_FULL'
  | 'TRAILING_STOP'
  | 'HOLDING_REVIEW_PARTIAL'
  | 'TP2'
  | 'TP1'
  | 'HOLDING_REVIEW_TIGHTEN'
  | 'TIME_STOP'
  | 'HOLD'

export type PaperExitCandidateAction = 'full_sell' | 'partial_sell' | 'tighten_trail' | 'hold'

export interface PaperExitCandidate {
  source: 'current_policy' | 'holding_review' | 'intraday_rescore' | 'manual'
  action: PaperExitCandidateAction
  priority: PaperExitPriority
  reason: string
  sellShares?: number
  newTrailingStop?: number
  newHighest?: number
  detail?: Record<string, unknown>
}

export interface PaperExitArbiterOptions {
  currentTrailingStop?: number | null
}

const PRIORITY_RANK: Record<PaperExitPriority, number> = {
  HARD_STOP: 10,
  INIT_STOP: 20,
  ML_SELL: 30,
  HOLDING_REVIEW_FULL: 35,
  TRAILING_STOP: 40,
  HOLDING_REVIEW_PARTIAL: 50,
  TP2: 60,
  TP1: 70,
  HOLDING_REVIEW_TIGHTEN: 80,
  TIME_STOP: 90,
  HOLD: 100,
}

function holdCandidate(reason: string, detail?: Record<string, unknown>): PaperExitCandidate {
  return {
    source: 'holding_review',
    action: 'hold',
    priority: 'HOLD',
    reason,
    detail,
  }
}

function normalizeCandidate(
  candidate: PaperExitCandidate,
  options: PaperExitArbiterOptions,
): PaperExitCandidate {
  if (candidate.action !== 'tighten_trail') return candidate
  const currentTrail = Number(options.currentTrailingStop ?? 0)
  const nextTrail = Number(candidate.newTrailingStop ?? 0)
  if (currentTrail > 0 && nextTrail <= currentTrail) {
    return holdCandidate('would_loosen_trailing_stop', {
      rejected_candidate: candidate,
      current_trailing_stop: currentTrail,
      requested_trailing_stop: Number.isFinite(nextTrail) ? nextTrail : null,
    })
  }
  return candidate
}

export function arbitratePaperExit(
  candidates: PaperExitCandidate[],
  options: PaperExitArbiterOptions = {},
): PaperExitCandidate {
  const normalized = candidates
    .filter(Boolean)
    .map((candidate) => normalizeCandidate(candidate, options))

  if (normalized.length === 0) return holdCandidate('no candidates')

  return normalized
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const byPriority = PRIORITY_RANK[a.candidate.priority] - PRIORITY_RANK[b.candidate.priority]
      return byPriority !== 0 ? byPriority : a.index - b.index
    })[0].candidate
}

export function paperExitCandidateFromDecision(decision: ExitDecision): PaperExitCandidate {
  if (decision.action === 'full_sell') {
    if (decision.reason.includes('Hard stop')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'HARD_STOP', reason: decision.reason }
    }
    if (decision.reason.includes('ATR') || decision.reason.includes('InitStop')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'INIT_STOP', reason: decision.reason }
    }
    if (decision.reason.includes('ML SELL')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'ML_SELL', reason: decision.reason }
    }
    if (decision.reason.includes('Trailing Stop')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'TRAILING_STOP', reason: decision.reason }
    }
    if (decision.reason.includes('TP2')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'TP2', reason: decision.reason }
    }
    if (decision.reason.includes('TP1')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'TP1', reason: decision.reason }
    }
    if (decision.reason.includes('Time stop')) {
      return { source: 'current_policy', action: 'full_sell', priority: 'TIME_STOP', reason: decision.reason }
    }
    return { source: 'current_policy', action: 'full_sell', priority: 'TRAILING_STOP', reason: decision.reason }
  }

  if (decision.action === 'partial_sell') {
    return {
      source: 'current_policy',
      action: 'partial_sell',
      priority: decision.reason.includes('TP2') ? 'TP2' : 'TP1',
      reason: decision.reason,
      sellShares: decision.sellShares,
    }
  }

  if (decision.newTrailingStop != null || decision.newHighest != null) {
    return {
      source: 'current_policy',
      action: 'tighten_trail',
      priority: 'HOLD',
      reason: decision.reason,
      newTrailingStop: decision.newTrailingStop,
      newHighest: decision.newHighest,
    }
  }

  return { source: 'current_policy', action: 'hold', priority: 'HOLD', reason: decision.reason }
}
