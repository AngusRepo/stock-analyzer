import type { ExitDecision } from './paperExitPolicy'

export type PositionExitOwner = 'position_policy' | 'l4_target' | 'portfolio_risk'
export interface PositionExitResolution {
  decision: ExitDecision
  evidence: {
    schema_version: 'position-exit-arbitration-v1'
    position_shares: number
    selected_owner: PositionExitOwner
    requested_shares: number
    proposals: { owner: PositionExitOwner; requestedShares: number; reason: string;
      exitIntentKind?: ExitDecision['exitIntentKind'] }[]
  }
}

/** Resolve reductions against one position snapshot; never add quantities.
 * Position policy includes S12, fallback and continuation, and wins ties.
 * The caller retains plan validity, legal-execution and fill guards.
 */
export function resolvePositionExit(input: {
  positionShares: number
  positionDecision: ExitDecision
  l4Decision?: ExitDecision | null
  riskDecision?: ExitDecision | null
}): PositionExitResolution {
  const shares = input.positionShares
  if (!Number.isSafeInteger(shares) || shares <= 0) throw new Error('exit_arbiter_position_invalid')
  const requested = (decision: ExitDecision): number => {
    if (decision.action === 'hold') return 0
    if (decision.action === 'full_sell') return shares
    if (!Number.isSafeInteger(decision.sellShares) || decision.sellShares! <= 0
      || decision.sellShares! > shares) throw new Error('exit_arbiter_reduction_invalid')
    return decision.sellShares!
  }
  const candidates: { owner: PositionExitOwner; decision: ExitDecision; quantity: number }[] = []
  const add = (owner: PositionExitOwner, decision: ExitDecision) => {
    candidates.push({ owner, decision, quantity: requested(decision) })
  }
  // Urgent full exits do not depend on optional allocation proposals.
  if (input.riskDecision) {
    if (input.riskDecision.action !== 'full_sell' || input.riskDecision.exitIntentKind !== 'risk_stop')
      throw new Error('exit_arbiter_risk_contract_invalid')
    add('portfolio_risk', input.riskDecision)
  } else {
    add('position_policy', input.positionDecision)
    if (input.positionDecision.action !== 'full_sell' && input.l4Decision) add('l4_target', input.l4Decision)
  }
  const winner = candidates.reduce((best, next) => next.quantity > best.quantity ? next : best)
  return {
    decision: { ...winner.decision },
    evidence: {
      schema_version: 'position-exit-arbitration-v1',
      position_shares: shares, selected_owner: winner.owner, requested_shares: winner.quantity,
      proposals: candidates.map(({ owner, decision, quantity }) => ({
        owner, requestedShares: quantity, reason: decision.reason, exitIntentKind: decision.exitIntentKind,
      })),
    },
  }
}


/** A stronger L4 fill can satisfy the same snapshot's position TP1 request.
 * Unfilled proposals never advance the position lifecycle.
 */
export function positionTakeProfitSatisfied(resolution: PositionExitResolution, filledShares: number): boolean {
  if (!Number.isSafeInteger(filledShares) || filledShares < 0
    || filledShares > resolution.evidence.position_shares) throw new Error('exit_arbiter_fill_invalid')
  const proposal = resolution.evidence.proposals.find(p => p.owner === 'position_policy')
  return proposal?.exitIntentKind === 'take_profit' && proposal.requestedShares > 0
    && proposal.requestedShares < resolution.evidence.position_shares
    && filledShares >= proposal.requestedShares
}


export interface PositionTakeProfitProgress {
  schema_version: 'position-tp1-progress-v1'
  entry_date: string
  target_shares: number
  filled_shares: number
}
function lifecycleObject(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === '') return {}
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('exit_progress_lifecycle_invalid')
  return parsed as Record<string, unknown>
}

/** Persist a fixed TP1 quantity only upon an actual fill. Re-evaluation may
 * pause the intent, but must not restore previously filled shares.
 */
export function preparePositionTakeProfit(input: {
  lifecycle: unknown; entryDate: string; tp1Hit: boolean; positionShares: number; decision: ExitDecision
}): { decision: ExitDecision; progress: PositionTakeProfitProgress | null } {
  // Emergency exits must not depend on optional TP1 metadata.
  if (input.tp1Hit || input.decision.exitIntentKind === 'risk_stop')
    return { decision: input.decision, progress: null }
  const raw = lifecycleObject(input.lifecycle).position_tp1_progress as PositionTakeProfitProgress | undefined
  let progress: PositionTakeProfitProgress | null = null
  if (raw && raw.entry_date === input.entryDate) {
    if (raw.schema_version !== 'position-tp1-progress-v1'
      || !Number.isSafeInteger(raw.target_shares) || raw.target_shares <= 0
      || !Number.isSafeInteger(raw.filled_shares) || raw.filled_shares < 0
      || raw.filled_shares >= raw.target_shares) throw new Error('exit_progress_invalid')
    progress = { ...raw }
  }
  const isPartialTp = input.decision.action === 'partial_sell' && input.decision.exitIntentKind === 'take_profit'
  const isTp1Full = input.decision.action === 'full_sell'
    && input.decision.exitIntentKind === 'take_profit' && /tp1/i.test(input.decision.reason)
  if (!progress && isPartialTp) progress = {
    schema_version: 'position-tp1-progress-v1', entry_date: input.entryDate,
    target_shares: input.decision.sellShares!, filled_shares: 0,
  }
  if (!progress || (!isPartialTp && !isTp1Full)) return { decision: input.decision, progress }
  const remaining = Math.min(input.positionShares, progress.target_shares - progress.filled_shares)
  return { progress, decision: { ...input.decision,
    action: remaining === input.positionShares ? 'full_sell' : 'partial_sell', sellShares: remaining } }
}

export function recordPositionTakeProfitFill(
  progress: PositionTakeProfitProgress | null, filledShares: number, lifecycle: unknown,
): { complete: boolean; lifecycleJson: string | null } {
  if (!progress) return { complete: false, lifecycleJson: typeof lifecycle === 'string' ? lifecycle : null }
  if (!Number.isSafeInteger(filledShares) || filledShares <= 0) throw new Error('exit_progress_fill_invalid')
  const next = { ...progress, filled_shares: Math.min(progress.target_shares, progress.filled_shares + filledShares) }
  return { complete: next.filled_shares === next.target_shares,
    lifecycleJson: JSON.stringify({ ...lifecycleObject(lifecycle), position_tp1_progress: next }) }
}
