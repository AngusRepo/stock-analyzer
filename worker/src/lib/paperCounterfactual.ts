import type { AuthoritativeExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { matchPaperOrderAgainstAuthoritativeDepth, type PaperDepthMatch } from './paperOrderBookMatcher'
import { assessSwingExit, closeSwingSession, SWING_POLICY_VERSION, type SwingPositionState } from './paperSwingPolicy'

export const COUNTERFACTUAL_POLICY = 'blocked-signal-three-exits-v1' as const
export const EXIT_ARMS = ['current_target', 'z_hysteresis', 'or15_only'] as const
export type ExitArm = typeof EXIT_ARMS[number]
type PendingExit = { reason: string; remainingShares: number; triggeredAtMs: number }
export type ShadowExitState = {
  shares: number; proceeds: number; pending: PendingExit | null; consumedBook: string | null; consumedTarget: string | null;
}
export type CounterfactualLot = {
  schemaVersion: typeof COUNTERFACTUAL_POLICY; lotId: string; accountId: number; symbol: string;
  signalMs: number; lastObservedMs: number; lotType: 'board_lot' | 'odd_lot'; entryShares: number; entry: PaperDepthMatch;
  source: { signalSha: string; modelSha: string; planId: string; l3Identity: Record<string, string>;
    blockedReason?: string; quantitySource?: 'paper_entry_same_snapshot' };
  swing: SwingPositionState; arms: Record<ExitArm, ShadowExitState>;
}
export type CounterfactualExitEvent = {
  arm: ExitArm; status: 'hold' | 'unknown' | 'unobservable' | 'partial' | 'closed'; reason: string;
  z: number | null; requestedShares: number; fill: PaperDepthMatch | null;
}
const positive = (x: number) => Number.isFinite(x) && x > 0
const sha = (x: string) => /^[a-f0-9]{64}$/.test(x)

/** Use the actual first observed book, not a later bar's price or a manufactured latency. */
function bookError(snapshot: AuthoritativeExecutionSnapshot | null, side: 'buy' | 'sell', nowMs: number, notBefore: number): string | null {
  if (!snapshot) return 'execution_book_missing'
  if (snapshot.side !== side || Date.parse(snapshot.createdAt) !== nowMs) return 'execution_book_identity_or_clock_mismatch'
  const observed = Date.parse(snapshot.selectedReceivedAt ?? snapshot.selectedSourceTime ?? '')
  if (!Number.isFinite(observed) || observed < notBefore || observed > nowMs) return 'execution_book_not_observed_after_signal'
  return null
}
function bookIdentity(snapshot: AuthoritativeExecutionSnapshot): string {
  const selected = snapshot.observations.find(o => o.source === snapshot.selectedSource && o.lotType === snapshot.lotType)
  return JSON.stringify([snapshot.selectedSource, snapshot.lotType, selected?.sourceTime,
    selected?.sessionEpoch, selected?.bidPrices, selected?.bidVolumes, selected?.volumeUnit])
}
export function openCounterfactualLot(input: {
  lotId: string; accountId: number; symbol: string; date: string; signalMs: number; nowMs: number;
  observableUntilMs: number; requestedShares: number; limitPrice: number; entryOrLow: number;
  source: CounterfactualLot['source']; snapshot: AuthoritativeExecutionSnapshot | null;
}): { lot: CounterfactualLot | null; reason: string; fill: PaperDepthMatch | null } {
  if (!input.lotId || !input.symbol || !Number.isSafeInteger(input.accountId) || input.accountId < 1
    || !Number.isFinite(input.signalMs) || !Number.isFinite(input.nowMs)
    || input.nowMs < input.signalMs || !Number.isFinite(input.observableUntilMs)
    || input.observableUntilMs <= input.signalMs || !positive(input.entryOrLow)
    || !positive(input.limitPrice) || !Number.isSafeInteger(input.requestedShares) || input.requestedShares < 1
    || !sha(input.source.signalSha) || !sha(input.source.modelSha) || !sha(input.source.planId)
    || !Object.keys(input.source.l3Identity).length) throw new Error('counterfactual_entry_contract_invalid')
  if (new Date(input.signalMs + 8 * 3600_000).toISOString().slice(0, 10) !== input.date)
    throw new Error('counterfactual_signal_date_mismatch')
  if (input.nowMs >= input.observableUntilMs) return { lot: null, reason: 'signal_observation_window_missed', fill: null }
  const requiredLot = input.requestedShares >= 1000 ? 'board_lot' : 'odd_lot'
  if (input.requestedShares >= 1000 && input.requestedShares % 1000 !== 0)
    throw new Error('counterfactual_requested_lot_invalid')
  const error = input.snapshot && input.snapshot.lotType !== requiredLot ? 'execution_lot_type_mismatch' :
    bookError(input.snapshot, 'buy', input.nowMs, input.signalMs)
  if (error) return { lot: null, reason: error, fill: null }
  const fill = matchPaperOrderAgainstAuthoritativeDepth({ snapshot: input.snapshot!, requestedShares: input.requestedShares, limitPrice: input.limitPrice })
  if (!fill.filledShares || fill.averageFillPrice == null) return { lot: null, reason: fill.reason, fill }
  const arms = Object.fromEntries(EXIT_ARMS.map(arm => [arm, {
    shares: fill.filledShares, proceeds: 0, pending: null, consumedBook: null, consumedTarget: null,
  }])) as CounterfactualLot['arms']
  return { reason: fill.reason, fill, lot: {
    schemaVersion: COUNTERFACTUAL_POLICY, lotId: input.lotId, accountId: input.accountId, symbol: input.symbol,
    signalMs: input.signalMs, lastObservedMs: input.nowMs, lotType: input.snapshot!.lotType, entryShares: fill.filledShares, entry: fill,
    source: structuredClone(input.source), arms,
    swing: { policy: SWING_POLICY_VERSION, entryDate: input.date, entryPrice: fill.averageFillPrice, entryOrLow: input.entryOrLow },
  } }
}

/** No account, order, cash or position writer. Each policy has independent remaining shares. */
export function advanceCounterfactualLot(previous: CounterfactualLot, input: {
  date: string; nowMs: number; price: number | null; calendar: string[];
  // Explicit decision from the existing target/rotation owner; missing target is NOT weight zero.
  targetExit: { decisionId: string; shares: number; reason: string } | null; z: number | null;
  closes: Array<{ date: string; close: number; observedAtMs: number; nextSession: string }>;
  snapshot: AuthoritativeExecutionSnapshot | null; limitPrice: number | null;
}): { lot: CounterfactualLot; events: CounterfactualExitEvent[] } {
  if (previous.schemaVersion !== COUNTERFACTUAL_POLICY || !Number.isFinite(input.nowMs)
    || input.nowMs <= previous.lastObservedMs
    || new Date(input.nowMs + 8 * 3600_000).toISOString().slice(0, 10) !== input.date
    || (input.z !== null && !Number.isFinite(input.z))
    || (input.targetExit !== null && (!Number.isSafeInteger(input.targetExit.shares) || input.targetExit.shares < 0 || !input.targetExit.reason || !input.targetExit.decisionId)))
    throw new Error('counterfactual_observation_contract_invalid')
  const lot = structuredClone(previous)
  lot.lastObservedMs = input.nowMs
  for (const close of [...input.closes].sort((a, b) => a.date.localeCompare(b.date))) {
    if (close.date < lot.swing.entryDate || close.date <= (lot.swing.lastEvaluatedCloseDate ?? '')) continue
    if (close.observedAtMs > input.nowMs) throw new Error('counterfactual_future_close')
    lot.swing = { ...closeSwingSession(lot.swing, { ...close, calendar: input.calendar }), lastEvaluatedCloseDate: close.date }
  }
  let shared: ReturnType<typeof assessSwingExit> | null = null
  let sharedError: string | null = null
  if (input.price !== null && positive(input.price)) {
    try { shared = assessSwingExit(lot.swing, { date: input.date, nowMs: input.nowMs, price: input.price, calendar: input.calendar }) }
    catch (error) { sharedError = String(error) }
  } else sharedError = 'observed_price_missing'
  if (shared?.action === 'full_sell' && !lot.swing.pendingExit) lot.swing.pendingExit = {
    reason: shared.reason as NonNullable<SwingPositionState['pendingExit']>['reason'], notBeforeMs: input.nowMs,
  }
  const events: CounterfactualExitEvent[] = []
  for (const arm of EXIT_ARMS) {
    const state = lot.arms[arm]
    if (!state.shares) continue
    const emit = (status: CounterfactualExitEvent['status'], reason: string, fill: PaperDepthMatch | null = null) =>
      events.push({ arm, status, reason, z: input.z, requestedShares: state.pending?.remainingShares ?? 0, fill })
    if (shared?.action === 'full_sell') state.pending = {
      reason: shared.reason, remainingShares: state.shares, triggeredAtMs: state.pending?.triggeredAtMs ?? input.nowMs,
    }
    if (!state.pending && arm === 'current_target' && input.targetExit?.shares && state.consumedTarget !== input.targetExit.decisionId) {
      state.consumedTarget = input.targetExit.decisionId
      state.pending = { reason: input.targetExit.reason, remainingShares: Math.min(state.shares, input.targetExit.shares), triggeredAtMs: input.nowMs }
    }
    if (!state.pending && arm === 'z_hysteresis' && input.z !== null && input.z < 0) state.pending = {
      reason: 'z_below_zero', remainingShares: state.shares, triggeredAtMs: input.nowMs,
    }
    if (!state.pending) {
      const missing = sharedError ?? (arm === 'z_hysteresis' && input.z === null ? 'z_missing' :
        arm === 'current_target' && input.targetExit === null ? 'target_decision_missing' : null)
      emit(missing ? 'unknown' : 'hold', missing ?? shared?.reason ?? 'hold')
      continue
    }
    if (state.pending.reason === 'swing_20_sessions' && shared?.action !== 'full_sell') {
      emit('hold', shared?.reason ?? sharedError ?? 'expiry_evidence_missing'); continue
    }
    const error = input.snapshot && input.snapshot.lotType !== lot.lotType ? 'execution_lot_type_mismatch' :
      bookError(input.snapshot, 'sell', input.nowMs, state.pending.triggeredAtMs)
    if (error || input.limitPrice === null || !positive(input.limitPrice)) {
      emit('unobservable', error ?? 'sell_limit_missing'); continue
    }
    const identity = bookIdentity(input.snapshot!)
    if (state.consumedBook === identity) { emit('unobservable', 'depth_already_consumed'); continue }
    const requested = state.pending.remainingShares
    const reason = state.pending.reason
    const fill = matchPaperOrderAgainstAuthoritativeDepth({ snapshot: input.snapshot!, requestedShares: requested, limitPrice: input.limitPrice! })
    if (!fill.filledShares || fill.averageFillPrice === null) { emit('unobservable', fill.reason, fill); continue }
    state.shares -= fill.filledShares
    state.proceeds += fill.filledShares * fill.averageFillPrice
    state.consumedBook = identity
    state.pending.remainingShares -= fill.filledShares
    events.push({ arm, status: state.shares === 0 ? 'closed' : 'partial', reason, z: input.z, requestedShares: requested, fill })
    if (!state.pending.remainingShares) state.pending = null
  }
  return { lot, events }
}
