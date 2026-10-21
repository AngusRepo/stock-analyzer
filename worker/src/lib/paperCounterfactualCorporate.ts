import { adjustCanonicalCorporatePriceBasis } from './canonicalTradeLifecycle'
import { corporateCashEntitlement, corporateStockQuantity, validateCorporateSnapshot,
  type CorporateAction, type CorporateActionSnapshot } from './paperCorporateActions'
import type { CounterfactualLot, ExitArm } from './paperCounterfactual'
import type { SwingPositionState } from './paperSwingPolicy'

type Right = {
  action: CorporateAction; eligibleShares: number; cashDue: number; sharesDue: number; wholeSharesDue: number;
  shareCostBasis: number; swingBasis: SwingPositionState; sourceChecksum: string;
  recognizedAtMs: number; settledAtMs: number | null;
}
export type ResearchCorporateArm = {
  lastShareChangeMs: number; averageCost: number; deliveredCash: number; rights: Record<string, Right>;
}
export type ResearchCorporateLedger = {
  version: 'counterfactual-corporate-v1';
  entry: { observedAtMs: number; signalSha: string; shares: number; price: number };
  arms: Record<ExitArm, ResearchCorporateArm>;
  sessions: Record<string, {
    sourceChecksum: string; observedAt: string; recordedAtMs: number;
    // Reconstructed from the committed research lot BEFORE its first trade on this date.
    opening: Record<ExitArm, { shares: number; lastShareChangeMs: number }>;
    actionIds: string[]; symbolActionsJson: string; factor: number;
  }>;
}
export type ResearchCorporateSession = {
  snapshot: CorporateActionSnapshot;
  previousClose: { date: string; close: number } | null;
}
const armNames = (lot: CounterfactualLot) => Object.keys(lot.arms) as ExitArm[]
const terms = (a: CorporateAction) => JSON.stringify([a.symbol, a.kind, a.ex_date, a.cash_per_share, a.stock_per_share,
  a.cash_quantity_basis ?? null, a.share_conversion_ratio ?? null, a.related_exchange_action_id ?? null])
const supported = (a: CorporateAction) => ['cash', 'stock'].includes(a.kind) && a.cash_quantity_basis == null
const fail = (reason: string): never => { throw new Error('counterfactual_corporate:' + reason) }

export function createResearchCorporateLedger(lot: CounterfactualLot): ResearchCorporateLedger {
  return {
    version: 'counterfactual-corporate-v1',
    entry: { observedAtMs: lot.lastObservedMs, signalSha: lot.source.signalSha,
      shares: lot.entryShares, price: lot.entry.averageFillPrice! },
    arms: Object.fromEntries(armNames(lot).map(arm => [arm, {
      lastShareChangeMs: lot.lastObservedMs, averageCost: lot.entry.averageFillPrice!, deliveredCash: 0, rights: {},
    }])) as ResearchCorporateLedger['arms'],
    sessions: {},
  }
}

export function counterfactualArmHasOutstandingRights(lot: CounterfactualLot, arm: ExitArm): boolean {
  return Object.values(lot.corporate?.arms[arm]?.rights ?? {}).some(right => right.settledAtMs == null)
}

/** Pure price/entitlement owner adapter. All cash belongs to this research arm;
 * there is no account pooling, buying power or production ledger access.
 * A failed observation returns no partial accrual, price change or payment.
 */
export function applyResearchCorporateSessions(previous: CounterfactualLot, input: {
  date: string; nowMs: number; calendar: string[]; sessions: ResearchCorporateSession[];
}): CounterfactualLot {
  const lot = structuredClone(previous), ledger = lot.corporate
  for (const session of [...input.sessions].sort((a, b) => a.snapshot.session_date.localeCompare(b.snapshot.session_date))) {
    const snapshot = session.snapshot, day = snapshot.session_date
    if (day > input.date || day <= lot.swing.entryDate || !input.calendar.includes(day)) fail('session_date_invalid:' + day)
    validateCorporateSnapshot(snapshot, day, Math.min(input.nowMs, Date.parse(day + 'T23:59:59.999+08:00')))
    if (!snapshot.covered_symbols.includes(lot.symbol)) fail('symbol_not_covered:' + day)
    if (snapshot.blockers[lot.symbol]?.length) fail('terms_blocked:' + day)
    const actions = snapshot.actions.filter(a => a.symbol === lot.symbol && a.ex_date === day)
    const symbolActionsJson = JSON.stringify(snapshot.actions.filter(a => a.symbol === lot.symbol))
    if (actions.some(a => !supported(a))) fail('unsupported_action:' + day)
    if (!ledger) {
      if (actions.length) fail('entry_ownership_basis_missing:' + day)
      continue // Legacy no-action coverage is still usable; never invent its entitlement basis.
    }
    const saved = ledger.sessions[day]
    if (saved) {
      if (saved.sourceChecksum !== snapshot.source_checksum
        || saved.observedAt !== snapshot.observed_at || saved.symbolActionsJson !== symbolActionsJson
        || JSON.stringify(saved.actionIds) !== JSON.stringify(actions.map(a => a.action_id)))
        fail('same_session_source_changed:' + day)
      continue
    }
    if (snapshot.actions.some(a => a.symbol === lot.symbol && a.ex_date > lot.swing.entryDate && a.ex_date < day
      && !ledger.sessions[a.ex_date]?.actionIds.includes(a.action_id))) fail('historical_action_basis_required:' + day)
    const opening = {} as ResearchCorporateLedger['sessions'][string]['opening']
    const openMs = Date.parse(day + 'T09:00:00+08:00')
    for (const arm of armNames(lot)) {
      const own = ledger.arms[arm], state = lot.arms[arm]
      if (!own || !Number.isFinite(own.lastShareChangeMs) || own.lastShareChangeMs >= openMs)
        fail('opening_basis_missing:' + day + ':' + arm)
      if (!Number.isSafeInteger(state.shares) || state.shares < 0) fail('opening_shares_invalid:' + arm)
      opening[arm] = { shares: state.shares, lastShareChangeMs: own.lastShareChangeMs }
    }
    // Do not infer compound rights-on-rights economics without the issuer's basis.
    if (actions.length && armNames(lot).some(arm => Object.values(ledger.arms[arm].rights)
      .some(r => r.settledAtMs == null && r.sharesDue > 0))) fail('outstanding_stock_basis_required:' + day)
    let factor = 1
    const cash = actions.reduce((sum, a) => sum + a.cash_per_share, 0)
    const stock = actions.reduce((sum, a) => sum + a.stock_per_share, 0)
    if (actions.length && armNames(lot).some(arm => opening[arm].shares > 0)) {
      const previousDay = input.calendar[input.calendar.indexOf(day) - 1], close = session.previousClose
      if (!close || close.date !== previousDay || !Number.isFinite(close.close) || close.close <= cash)
        fail('exact_previous_close_missing:' + day)
      factor = (close.close - cash) / close.close / (1 + stock)
    }
    for (const arm of armNames(lot)) {
      const state = lot.arms[arm], own = ledger.arms[arm], eligible = opening[arm].shares
      // Outstanding recognized terms must be present in the current known-at snapshot.
      for (const right of Object.values(own.rights)) {
        if (right.settledAtMs != null) continue
        const action = snapshot.actions.find(a => a.action_id === right.action.action_id)
        if (!action || !supported(action) || terms(action) !== terms(right.action))
          fail('outstanding_terms_missing_or_changed:' + right.action.action_id)
        right.action = structuredClone(action)
        right.cashDue = corporateCashEntitlement(right.eligibleShares, action)
      }
      if (eligible && actions.length) {
        const adjusted = JSON.parse(adjustCanonicalCorporatePriceBasis({
          version: 'canonical_trade_lifecycle_v1', swing: state.swing ?? lot.swing,
        }, factor, actions.map(a => a.action_id), day)!)
        state.swing = adjusted.swing
        own.averageCost /= 1 + stock
        for (const action of actions) {
          if (own.rights[action.action_id]) fail('action_repeated:' + action.action_id)
          const quantity = corporateStockQuantity(eligible, action.stock_per_share)
          own.rights[action.action_id] = {
            action: structuredClone(action), eligibleShares: eligible,
            cashDue: corporateCashEntitlement(eligible, action), sharesDue: quantity.total,
            wholeSharesDue: quantity.whole, shareCostBasis: action.kind === 'stock' ? own.averageCost : 0,
            swingBasis: structuredClone(state.swing!), sourceChecksum: snapshot.source_checksum,
            recognizedAtMs: input.nowMs, settledAtMs: null,
          }
        }
      }
      for (const right of Object.values(own.rights)) {
        if (right.settledAtMs != null || !right.action.payable_date || right.action.payable_date > day) continue
        if (right.action.kind === 'cash') {
          if (!Number.isInteger(right.cashDue) && right.action.cash_rounding == null)
            fail('cash_rounding_terms_missing:' + right.action.action_id)
          own.deliveredCash += right.cashDue
        } else {
          if (right.sharesDue !== right.wholeSharesDue && right.action.fractional_treatment !== 'book_entry_fee')
            fail('fractional_delivery_terms_missing:' + right.action.action_id)
          const delivered = right.wholeSharesDue
          if (delivered > 0) {
            // Sold-out arms regain their own saved owner. Other arms keep their current one.
            if (!state.shares) state.swing = structuredClone(right.swingBasis)
            own.averageCost = (state.shares * own.averageCost + delivered * right.shareCostBasis) / (state.shares + delivered)
            if (state.pending && state.pending.remainingShares === state.shares) state.pending.remainingShares += delivered
            state.shares += delivered
            // This is processing time, not a backdated fill or a claimed pre-open receipt.
            own.lastShareChangeMs = input.nowMs
            state.consumedTarget = null
          }
        }
        right.settledAtMs = input.nowMs
      }
    }
    ledger.sessions[day] = { sourceChecksum: snapshot.source_checksum, observedAt: snapshot.observed_at,
      recordedAtMs: input.nowMs, opening, actionIds: actions.map(a => a.action_id), symbolActionsJson, factor }
  }
  return lot
}
