import type { Bindings } from '../types'
import { paperAccountId, paperExecutionDate } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { batchGetLatestPricesByDomain } from './paperMarketDomainData'
import { adjustCanonicalCorporatePriceBasis } from './canonicalTradeLifecycle'
import { prepareCorporateOpeningBasis, readCorporateOpeningBasis } from './paperCorporateOpeningBasis'

export interface SubscriptionRights {
  ratio: number; issued_ratio: number; subscription_price: number
  policy: 'do_not_subscribe'; payment_start: string; payment_deadline: string
  expiry_policy: 'unexercised_original_holder_rights_expire'
  fractional_policy: 'retain_no_automatic_pooling'
  fair_value_per_right: null; valuation_status: 'unobservable'; promotion_eligible: false
  evidence_checksums: string[]; quantity?: number; whole_quantity?: number
}
export interface CorporateAction {
  action_id: string
  symbol: string
  kind: 'cash' | 'stock' | 'exchange' | 'subscription'
  rights?: SubscriptionRights
  ex_date: string
  payable_date: string | null
  cash_per_share: number
  stock_per_share: number
  capital_return_per_share?: number
  official_share_ratio?: number
  cash_quantity_basis?: 'exchange_fraction'
  share_conversion_ratio?: number
  related_exchange_action_id?: string
  fractional_treatment?: 'book_entry_fee' | null
  cash_rounding?: 'floor_twd' | null
}
export interface CorporateActionSnapshot {
  schema_version: 'paper-corporate-source-v1'
  session_date: string
  observed_at: string
  source_checksum: string
  covered_symbols: string[]
  actions: CorporateAction[]
  blockers: Record<string, string[]>
  tax_basis: 'gross_before_personal_tax'
}
export interface CorporateEntitlement {
  action_id: string; symbol: string; kind: 'cash' | 'stock' | 'subscription'; ex_date: string
  rights_json?: string | null
  eligible_shares: number; cash_due: number; shares_due: number; share_cost_basis: number
  whole_shares_due: number; fractional_treatment: 'book_entry_fee' | null
  cash_rounding?: 'floor_twd' | null
  position_basis_json?: string | null
  payable_date: string | null; terms_json: string; settled: number
}

const day = (raw: unknown): raw is string => typeof raw === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(raw))
  && new Date(raw).toISOString().slice(0, 10) === raw
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const terms = (a: CorporateAction) => JSON.stringify([a.symbol, a.kind, a.ex_date, a.cash_per_share, a.stock_per_share,
  a.cash_quantity_basis ?? null, a.share_conversion_ratio ?? null, a.related_exchange_action_id ?? null,
  ...(a.kind === 'subscription' ? [a.rights?.ratio, a.rights?.issued_ratio, a.rights?.subscription_price, a.rights?.policy] : [])])

export function validateSubscriptionRights(r: SubscriptionRights | undefined, exDate: string): void {
  if (!r || ![r.ratio, r.issued_ratio, r.subscription_price].every(n => nonnegative(n) && n > 0)
    || !day(r.payment_start) || !day(r.payment_deadline) || r.payment_start < exDate || r.payment_deadline < r.payment_start
    || r.policy !== 'do_not_subscribe' || r.expiry_policy !== 'unexercised_original_holder_rights_expire'
    || r.fractional_policy !== 'retain_no_automatic_pooling' || r.fair_value_per_right !== null
    || r.valuation_status !== 'unobservable' || r.promotion_eligible !== false
    || !Array.isArray(r.evidence_checksums) || !r.evidence_checksums.length
    || r.evidence_checksums.some(s => !/^[0-9a-f]{64}$/.test(s))) throw new Error('paper_subscription_terms_invalid')
}

/** Decimal announced ratio, not binary floating-point floor (100 * .29 < 29). */
export function corporateStockQuantity(eligible: number, ratio: number): { total: number; whole: number } {
  if (!Number.isSafeInteger(eligible) || eligible < 0 || !nonnegative(ratio)) throw new Error('paper_corporate_quantity_invalid')
  const [mantissa, power = '0'] = ratio.toString().split('e')
  const [integer, fraction = ''] = mantissa.split('.')
  const exponent = Number(power) - fraction.length
  let numerator = BigInt(integer + fraction) * BigInt(eligible), denominator = 1n
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent)
  else denominator = 10n ** BigInt(-exponent)
  const whole = Number(numerator / denominator)
  const total = exponent < 0 ? Number(numerator.toString() + 'e' + exponent) : Number(numerator)
  if (!Number.isSafeInteger(whole) || !Number.isFinite(total)) throw new Error('paper_corporate_quantity_overflow')
  return { whole, total }
}

export function corporateCashEntitlement(eligible: number, action: CorporateAction): number {
  if (!action.cash_quantity_basis) {
    const value = corporateStockQuantity(eligible, action.cash_per_share)
    return action.cash_rounding === 'floor_twd' ? value.whole : value.total
  }
  // Integer decimal arithmetic for the remainder: 101 * .75 -> .75, never
  // floor a binary floating product or pay cash for the full exchanged stock.
  const ratio = String(action.share_conversion_ratio)
  const [mantissa, power = '0'] = ratio.split('e')
  const [integer, fraction = ''] = mantissa.split('.')
  const exponent = Number(power) - fraction.length
  if (exponent >= 0) return 0
  const denominator = 10n ** BigInt(-exponent)
  const remainder = (BigInt(integer + fraction) * BigInt(eligible)) % denominator
  const [cashMantissa, cashPower = '0'] = String(action.cash_per_share).split('e')
  const [cashInteger, cashFraction = ''] = cashMantissa.split('.')
  const cashExponent = Number(cashPower) - cashFraction.length
  let numerator = remainder * BigInt(cashInteger + cashFraction), divisor = denominator
  if (cashExponent >= 0) numerator *= 10n ** BigInt(cashExponent)
  else divisor *= 10n ** BigInt(-cashExponent)
  const value = action.cash_rounding === 'floor_twd' ? Number(numerator / divisor) : Number(numerator) / Number(divisor)
  if (!Number.isFinite(value) || value < 0) throw new Error('paper_corporate_fraction_cash_invalid')
  return value
}

export function validateCorporateSnapshot(snapshot: CorporateActionSnapshot, sessionDate: string, nowMs: number): void {
  if (snapshot?.schema_version !== 'paper-corporate-source-v1' || snapshot.session_date !== sessionDate
    || !day(sessionDate) || !/^[a-f0-9]{64}$/.test(snapshot.source_checksum)
    || !Number.isFinite(Date.parse(snapshot.observed_at)) || Date.parse(snapshot.observed_at) > nowMs
    || nowMs - Date.parse(snapshot.observed_at) > 36 * 3600_000
    || snapshot.tax_basis !== 'gross_before_personal_tax'
    || !Array.isArray(snapshot.covered_symbols) || !Array.isArray(snapshot.actions)
    || !snapshot.blockers || typeof snapshot.blockers !== 'object') throw new Error('paper_corporate_source_invalid')
  const ids = new Set<string>()
  for (const a of snapshot.actions) {
    if (!a.action_id || ids.has(a.action_id) || !a.symbol || !snapshot.covered_symbols.includes(a.symbol)
      || !['cash', 'stock', 'exchange', 'subscription'].includes(a.kind) || !day(a.ex_date)
      || (a.payable_date !== null && (!day(a.payable_date) || a.payable_date < a.ex_date))
      || !nonnegative(a.cash_per_share) || !nonnegative(a.stock_per_share)
      || (a.capital_return_per_share != null && (a.kind !== 'exchange' || !nonnegative(a.capital_return_per_share)))
      || (a.kind === 'exchange' && a.payable_date !== a.ex_date)
      || (a.cash_quantity_basis != null && (a.kind !== 'cash' || a.cash_quantity_basis !== 'exchange_fraction'
        || !nonnegative(a.share_conversion_ratio) || a.share_conversion_ratio <= 0 || !a.related_exchange_action_id))
      || (a.cash_quantity_basis == null && (a.share_conversion_ratio != null || a.related_exchange_action_id != null))
      || (a.fractional_treatment != null && (!['stock', 'exchange'].includes(a.kind) || a.fractional_treatment !== 'book_entry_fee'))
      || (a.official_share_ratio != null && (a.kind !== 'exchange' || a.fractional_treatment !== 'book_entry_fee'
        || !nonnegative(a.official_share_ratio) || a.official_share_ratio <= 0))
      || (a.cash_rounding != null && (a.kind !== 'cash' || a.cash_rounding !== 'floor_twd'))
      || (a.kind === 'subscription' ? a.cash_per_share !== 0 || a.stock_per_share !== 0 || a.payable_date !== null
        : a.kind === 'cash' ? a.cash_per_share <= 0 || a.stock_per_share !== 0
        : a.stock_per_share <= 0 || a.cash_per_share !== 0)) throw new Error('paper_corporate_terms_invalid')
    if (a.kind === 'subscription') validateSubscriptionRights(a.rights, a.ex_date)
    ids.add(a.action_id)
  }
  for (const action of snapshot.actions.filter(a => a.cash_quantity_basis === 'exchange_fraction')) {
    const exchange = snapshot.actions.find(a => a.action_id === action.related_exchange_action_id)
    if (!exchange || exchange.kind !== 'exchange' || exchange.symbol !== action.symbol
      || exchange.ex_date !== action.ex_date || exchange.stock_per_share !== action.share_conversion_ratio) {
      throw new Error('paper_corporate_fraction_exchange_identity_mismatch')
    }
  }
}

export async function outstandingCorporateEntitlements(db: D1Database, accountId: number): Promise<CorporateEntitlement[]> {
  const result = await db.prepare('SELECT * FROM paper_corporate_entitlements_v1 WHERE account_id=? AND settled=0 ORDER BY action_id')
    .bind(accountId).all<CorporateEntitlement>()
  if (!result.success || !Array.isArray(result.results)) throw new Error('paper_corporate_ledger_read_failed')
  return result.results
}

export function corporateReceivableValue(rows: CorporateEntitlement[], prices: Map<string, number>): number {
  return rows.reduce((sum, row) => {
    if (row.kind === 'subscription') {
      // The issuer's exercise price is NOT a market valuation of the right.
      // Recognition/expiry remains durable even when no complete NAV exists.
      throw new Error('paper_subscription_fair_value_unobservable:' + row.action_id)
    }
    if (!nonnegative(row.cash_due) || !nonnegative(row.shares_due)) throw new Error('paper_corporate_receivable_invalid')
    if (row.shares_due === 0) return sum + row.cash_due
    const price = prices.get(row.symbol)
    if (!nonnegative(price) || price <= 0) throw new Error('paper_corporate_receivable_mark_missing:' + row.symbol)
    const shares = row.fractional_treatment === 'book_entry_fee' ? row.whole_shares_due : row.shares_due
    return sum + row.cash_due + shares * price
  }, 0)
}

/** Bounds for risk capacity only. No unpriced right is booked as cash or NAV. */
export function corporateReceivableBounds(rows: CorporateEntitlement[], prices: Map<string, number>) {
  const known = rows.filter(row => row.kind !== 'subscription')
  const lower = corporateReceivableValue(known, prices)
  let upper = lower
  const unpricedRights: string[] = []
  for (const row of rows.filter(row => row.kind === 'subscription')) {
    const rights: SubscriptionRights = JSON.parse(row.rights_json ?? 'null')
    validateSubscriptionRights(rights, row.ex_date)
    const quantity = corporateStockQuantity(row.eligible_shares, rights.ratio)
    if (row.cash_due !== 0 || row.shares_due !== 0 || quantity.total <= 0
      || rights.quantity !== quantity.total || rights.whole_quantity !== quantity.whole) {
      throw new Error('paper_subscription_quantity_mismatch')
    }
    const price = prices.get(row.symbol)
    if (!nonnegative(price) || price <= 0) throw new Error('paper_subscription_underlying_mark_missing:' + row.symbol)
    upper += quantity.total * price
    unpricedRights.push(row.action_id)
  }
  if (!Number.isFinite(upper)) throw new Error('paper_subscription_bound_invalid')
  return { lower, upper, unpricedRights: unpricedRights.sort(), complete: unpricedRights.length === 0 }
}

export async function corporateAccountRiskBounds(env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  accountId: number, quotePrices = new Map<string, number>()) {
  const rows = await outstandingCorporateEntitlements(paperDomainDatabase(env), accountId)
  const missing = [...new Set(rows.filter(r => (r.shares_due > 0 || r.kind === 'subscription')
    && !quotePrices.has(r.symbol)).map(r => r.symbol))]
  const today = new Date(paperExecutionDate().getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  const fallback = missing.length ? await batchGetLatestPricesByDomain(env, missing, today) : new Map<string, number>()
  return corporateReceivableBounds(rows, new Map([...fallback, ...quotePrices]))
}

export async function processCorporateActionsFromSource(env: Bindings, sessionDate: string): Promise<void> {
  const raw = await env.KV.get(`market:corporate_actions:v1:${sessionDate}`)
  if (!raw) throw new Error('paper_corporate_source_snapshot_missing:' + sessionDate)
  const snapshot: CorporateActionSnapshot = JSON.parse(raw)
  validateCorporateSnapshot(snapshot, sessionDate, paperExecutionDate().getTime())
  const symbols = [...new Set(snapshot.actions.filter(a => a.ex_date === sessionDate).map(a => a.symbol))]
  const previousDate = new Date(Date.parse(sessionDate + 'T00:00:00Z') - 86400_000).toISOString().slice(0, 10)
  const closes = symbols.length ? await batchGetLatestPricesByDomain(env, symbols, previousDate) : new Map<string, number>()
  await processPaperCorporateActions(env, sessionDate, snapshot, closes)
}

/** Common NAV consumer. This never changes the available-cash calculation. */
export async function corporateAccountReceivablesValue(env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  accountId: number, quotePrices = new Map<string, number>()): Promise<number> {
  const rows = await outstandingCorporateEntitlements(paperDomainDatabase(env), accountId)
  const missing = [...new Set(rows.filter(r => r.shares_due > 0 && !quotePrices.has(r.symbol)).map(r => r.symbol))]
  const today = new Date(paperExecutionDate().getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  const fallback = missing.length ? await batchGetLatestPricesByDomain(env, missing, today) : new Map<string, number>()
  return corporateReceivableValue(rows, new Map([...fallback, ...quotePrices]))
}

/** Morning transaction: entitlement before any ex-date trade, cash/stock only on
 * the documented payable date. A retry cannot entitle a newly bought position.
 * Unknown stock delivery dates remain valued, non-tradable receivables.
 */
export async function processPaperCorporateActions(env: Bindings, sessionDate: string,
  snapshot: CorporateActionSnapshot, previousCloses: Map<string, number>): Promise<void> {
  const db = paperDomainDatabase(env), accountId = paperAccountId()
  let now = paperExecutionDate()
  const startedAt = now.getTime()
  validateCorporateSnapshot(snapshot, sessionDate, now.getTime())
  const done = await db.prepare('SELECT source_checksum FROM paper_corporate_sessions_v1 WHERE account_id=? AND session_date=?')
    .bind(accountId, sessionDate).first<{ source_checksum: string }>()
  if (done) {
    if (done.source_checksum !== snapshot.source_checksum) throw new Error('paper_corporate_session_source_changed')
    // Validate new evidence on retry; legacy absence is not fabricated history.
    await readCorporateOpeningBasis(db, accountId, sessionDate)
    return
  }
  // Late first execution cannot reconstruct entitlement from post-trade holdings.
  if (now.toISOString() >= sessionDate + 'T01:00:00.000Z') throw new Error('paper_corporate_exdate_opening_state_required')
  const positionResult = await db.prepare('SELECT * FROM paper_positions WHERE account_id=? AND shares>0').bind(accountId).all<any>()
  if (!positionResult.success || !Array.isArray(positionResult.results)) throw new Error('paper_corporate_positions_read_failed')
  const positions = positionResult.results
  const outstanding = await outstandingCorporateEntitlements(db, accountId)
  for (const symbol of new Set([...positions.map(p => String(p.symbol)), ...outstanding.map(p => p.symbol)])) {
    if (!snapshot.covered_symbols.includes(symbol) || (snapshot.blockers[symbol]?.length ?? 0) > 0) {
      throw new Error('paper_corporate_source_coverage_missing:' + symbol)
    }
  }
  // The ownership observation is complete only after these reads. A slow
  // response crossing open cannot be relabeled with the earlier request clock.
  now = paperExecutionDate()
  if (now.getTime() < startedAt) throw new Error('paper_corporate_opening_clock_regressed')
  if (now.toISOString() >= sessionDate + 'T01:00:00.000Z') throw new Error('paper_corporate_exdate_opening_state_required')
  const openingStatement = await prepareCorporateOpeningBasis(db, {
    schema_version: 'paper-corporate-opening-basis-v1', account_id: accountId, session_date: sessionDate,
    observed_at: now.toISOString(), source_checksum: snapshot.source_checksum, positions,
  })
  const statements: D1PreparedStatement[] = []
  // A marker inserted last makes the entire D1 batch retry-idempotent. Conflict
  // on a concurrent first runner rolls back its earlier account mutations.
  const pending = [...outstanding]
  for (const row of outstanding) {
    const action = snapshot.actions.find(a => a.action_id === row.action_id)
    if (!action || terms(action) !== row.terms_json) throw new Error('paper_corporate_outstanding_terms_changed:' + row.action_id)
    if (row.kind === 'subscription') {
      const quantity = corporateStockQuantity(row.eligible_shares, action.rights!.ratio)
      row.rights_json = JSON.stringify({ ...action.rights, quantity: quantity.total, whole_quantity: quantity.whole })
      statements.push(db.prepare('UPDATE paper_corporate_entitlements_v1 SET rights_json=? WHERE account_id=? AND action_id=? AND settled=0')
        .bind(row.rights_json, accountId, row.action_id))
      continue
    }
    if (row.payable_date !== action.payable_date || row.fractional_treatment !== (action.fractional_treatment ?? null)
      || (row.cash_rounding ?? null) !== (action.cash_rounding ?? null)) {
      row.payable_date = action.payable_date
      row.fractional_treatment = action.fractional_treatment ?? null
      row.cash_rounding = action.cash_rounding ?? null
      row.cash_due = corporateCashEntitlement(row.eligible_shares, action)
      statements.push(db.prepare('UPDATE paper_corporate_entitlements_v1 SET payable_date=?,fractional_treatment=?,cash_rounding=?,cash_due=? WHERE account_id=? AND action_id=? AND settled=0')
        .bind(row.payable_date, row.fractional_treatment, row.cash_rounding, row.cash_due, accountId, row.action_id))
    }
  }
  // A newly observable OLD cash dividend belongs to its original owner, even
  // after sale/rebuy. Never use today's quantity or rewrite old fills/stops.
  // Existing identities (including settled ones) prevent cross-day repayment.
  for (const action of snapshot.actions.filter(a => a.kind === 'cash' && a.ex_date < sessionDate)) {
    const existing = await db.prepare('SELECT * FROM paper_corporate_entitlements_v1 WHERE account_id=? AND action_id=?')
      .bind(accountId, action.action_id).first<CorporateEntitlement>()
    if (existing) {
      if (existing.terms_json !== terms(action)) throw new Error('paper_corporate_recorded_terms_changed:' + action.action_id)
      continue
    }
    if (action.cash_quantity_basis || snapshot.actions.some(a => a.kind === 'exchange'
      && a.symbol === action.symbol && a.ex_date === action.ex_date)) {
      throw new Error('paper_corporate_historical_capital_event_requires_reconciliation:' + action.action_id)
    }
    if (!snapshot.covered_symbols.includes(action.symbol) || snapshot.blockers[action.symbol]?.length) {
      throw new Error('paper_corporate_source_coverage_missing:' + action.symbol)
    }
    const basis = await readCorporateOpeningBasis(db, accountId, action.ex_date, now.getTime())
    if (!basis) throw new Error('paper_corporate_historical_opening_basis_missing:' + action.action_id)
    const position = basis.positions.find(p => p.symbol === action.symbol)
    if (!position) continue // A verified empty original holding, NOT missing history.
    const eligible = Number(position.shares), cashDue = corporateCashEntitlement(eligible, action)
    if (!cashDue) continue
    const row: CorporateEntitlement = { action_id: action.action_id, symbol: action.symbol, kind: 'cash',
      ex_date: action.ex_date, eligible_shares: eligible, cash_due: cashDue, shares_due: 0,
      whole_shares_due: 0, share_cost_basis: 0, fractional_treatment: null,
      cash_rounding: action.cash_rounding ?? null, payable_date: action.payable_date,
      terms_json: terms(action), settled: 0 }
    pending.push(row)
    statements.push(db.prepare(`INSERT INTO paper_corporate_entitlements_v1
      (account_id,action_id,symbol,kind,ex_date,eligible_shares,cash_due,shares_due,share_cost_basis,
       payable_date,terms_json,source_checksum,recognized_at,whole_shares_due,fractional_treatment,cash_rounding,position_basis_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(accountId, row.action_id, row.symbol, row.kind, row.ex_date, eligible, cashDue, 0, 0,
        row.payable_date, row.terms_json, snapshot.source_checksum, now.toISOString(), 0, null,
        row.cash_rounding, JSON.stringify(position)))
    // Explicit prior-period correction, not today's trading gain. Keep source
    // and original ownership links for independent accounting/performance audit.
    statements.push(db.prepare(`INSERT INTO paper_execution_events
      (account_id,trade_date,event_type,status,reason,detail_json,source,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(accountId, sessionDate, 'corporate_cash_correction', 'recorded', 'late_original_cash',
        JSON.stringify({ action_id: action.action_id, ex_date: action.ex_date, eligible_shares: eligible,
          cash_due: cashDue, source_checksum: snapshot.source_checksum,
          opening_source_checksum: basis.source_checksum, opening_observed_at: basis.observed_at,
          recognized_at: now.toISOString(), prospective_backfill_credit: 0 }),
        'paper_corporate_actions_v1', now.toISOString()))
  }
  for (const position of positions) {
    const actions = snapshot.actions.filter(a => a.symbol === position.symbol && a.ex_date === sessionDate)
    if (!actions.length) continue
    if (!Number.isSafeInteger(position.shares) || position.shares <= 0 || !nonnegative(position.avg_cost)) {
      throw new Error('paper_corporate_opening_position_invalid')
    }
    const exchanges = actions.filter(a => a.kind === 'exchange')
    const subscriptions = actions.filter(a => a.kind === 'subscription')
    const dividends = actions.filter((a): a is CorporateAction & { kind: 'cash' | 'stock' } => a.kind === 'cash' || a.kind === 'stock')
    if (subscriptions.length > 1 || exchanges.length > 1 || (exchanges.length && (subscriptions.length > 0 || dividends.some(a => a.kind === 'stock')
      || outstanding.some(r => r.symbol === position.symbol && r.shares_due > 0)))) {
      throw new Error('paper_corporate_combined_share_conversion_terms_required:' + position.symbol)
    }
    const exchange = exchanges[0]
    const cash = dividends.filter(a => !a.cash_quantity_basis).reduce((s, a) => s + a.cash_per_share, 0)
    const stock = dividends.reduce((s, a) => s + a.stock_per_share, 0)
    const conversion = exchange?.stock_per_share ?? 1
    const returnOfCapital = exchange?.capital_return_per_share ?? 0
    if (returnOfCapital > cash) throw new Error('paper_corporate_capital_cash_leg_missing')
    if (exchange) {
      const converted = corporateStockQuantity(position.shares, conversion)
      if (exchange.official_share_ratio != null
        && corporateStockQuantity(position.shares, exchange.official_share_ratio).whole !== converted.whole) {
        throw new Error('paper_corporate_disclosed_quantity_conflict')
      }
      // Exchange fractional units have distinct issuer cash/election terms.
      // Do not create free tradable fractions or round them out of NAV.
      if (converted.total !== converted.whole && exchange.fractional_treatment !== 'book_entry_fee' && !dividends.some(a => a.kind === 'cash'
        && a.cash_quantity_basis === 'exchange_fraction' && a.related_exchange_action_id === exchange.action_id
        && a.share_conversion_ratio === conversion)) throw new Error('paper_corporate_exchange_fractional_terms_required')
      const original = position.original_shares == null ? null
        : corporateStockQuantity(position.original_shares, conversion).whole
      statements.push(db.prepare('UPDATE paper_positions SET shares=?,original_shares=? WHERE account_id=? AND symbol=?')
        .bind(converted.whole, original, accountId, position.symbol))
    }
    const previousClose = previousCloses.get(position.symbol)
    if (!nonnegative(previousClose) || previousClose <= cash) throw new Error('paper_corporate_previous_close_missing:' + position.symbol)
    const subscription = subscriptions[0]?.rights
    const paidRatio = subscription?.issued_ratio ?? 0
    const paidAmount = paidRatio * (subscription?.subscription_price ?? 0)
    // Theoretical ex-right price basis is for stops only, NEVER booked as NAV
    // or as the holder's (different) subscription-right quantity/value.
    const factor = (previousClose - cash + paidAmount) / previousClose / ((1 + stock + paidRatio) * conversion)
    const lifecycle = adjustCanonicalCorporatePriceBasis(position.trade_lifecycle_json, factor, actions.map(a => a.action_id))
    // Preserve the economic stop distance; an exchange adjustment is not a loss.
    statements.push(db.prepare(`UPDATE paper_positions SET avg_cost=MAX(0,avg_cost-?)/?,
      entry_price=entry_price*?, initial_stop=initial_stop*?, trailing_stop=trailing_stop*?,
      highest_since_entry=highest_since_entry*?, tp1_price=tp1_price*?, tp2_price=tp2_price*?, trade_lifecycle_json=?, updated_at=?
      WHERE account_id=? AND symbol=?`).bind(returnOfCapital, (1 + stock) * conversion, factor, factor, factor, factor, factor, factor,
      lifecycle, now.toISOString(), accountId, position.symbol))
    for (const action of subscriptions) {
      const quantity = corporateStockQuantity(position.shares, action.rights!.ratio)
      const row: CorporateEntitlement = { action_id: action.action_id, symbol: action.symbol, kind: 'subscription',
        ex_date: action.ex_date, eligible_shares: position.shares, cash_due: 0, shares_due: 0,
        whole_shares_due: 0, share_cost_basis: 0, fractional_treatment: null, payable_date: null,
        terms_json: terms(action), settled: 0,
        rights_json: JSON.stringify({ ...action.rights, quantity: quantity.total, whole_quantity: quantity.whole }) }
      pending.push(row)
      statements.push(db.prepare(`INSERT INTO paper_corporate_entitlements_v1
        (account_id,action_id,symbol,kind,ex_date,eligible_shares,terms_json,source_checksum,recognized_at,rights_json)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(accountId, row.action_id, row.symbol, row.kind, row.ex_date,
        row.eligible_shares, row.terms_json, snapshot.source_checksum, now.toISOString(), row.rights_json))
    }
    for (const action of dividends) {
      const quantity = corporateStockQuantity(position.shares, action.stock_per_share)
      const cashDue = corporateCashEntitlement(position.shares, action)
      if (cashDue === 0 && quantity.total === 0) continue
      const row: CorporateEntitlement = { action_id: action.action_id, symbol: action.symbol, kind: action.kind,
        ex_date: action.ex_date, eligible_shares: position.shares,
        cash_due: cashDue, shares_due: quantity.total,
        cash_rounding: action.cash_rounding ?? null,
        whole_shares_due: quantity.whole, fractional_treatment: action.fractional_treatment ?? null,
        share_cost_basis: stock > 0 ? position.avg_cost / (1 + stock) : 0,
        payable_date: action.payable_date, terms_json: terms(action), settled: 0 }
      if (action.kind === 'stock') {
        const basis = { ...position, avg_cost: row.share_cost_basis, trade_lifecycle_json: lifecycle }
        for (const key of ['entry_price', 'initial_stop', 'trailing_stop', 'highest_since_entry', 'tp1_price', 'tp2_price']) {
          basis[key] = position[key] == null ? null : position[key] * factor
        }
        row.position_basis_json = JSON.stringify(basis)
      }
      pending.push(row)
      statements.push(db.prepare(`INSERT INTO paper_corporate_entitlements_v1
        (account_id,action_id,symbol,kind,ex_date,eligible_shares,cash_due,shares_due,share_cost_basis,
         payable_date,terms_json,source_checksum,recognized_at,whole_shares_due,fractional_treatment,cash_rounding,position_basis_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(accountId, row.action_id, row.symbol, row.kind, row.ex_date, row.eligible_shares,
          row.cash_due, row.shares_due, row.share_cost_basis, row.payable_date, row.terms_json,
          snapshot.source_checksum, now.toISOString(), row.whole_shares_due, row.fractional_treatment, row.cash_rounding,
          row.position_basis_json ?? null))
    }
  }
  for (const row of pending) {
    if (row.kind === 'subscription') {
      const right = JSON.parse(row.rights_json!) as SubscriptionRights
      validateSubscriptionRights(right, row.ex_date)
      // The original holder's deadline is inclusive. A subsequent placement
      // deadline never prolongs this account's right. No cash/share delivery.
      if (sessionDate > right.payment_deadline) statements.push(db.prepare(
        'UPDATE paper_corporate_entitlements_v1 SET settled=1,settled_at=? WHERE account_id=? AND action_id=? AND settled=0')
        .bind(now.toISOString(), accountId, row.action_id))
      continue
    }
    if (!row.payable_date || row.payable_date > sessionDate) continue
    if (row.kind === 'cash') {
      if (!Number.isInteger(row.cash_due) && row.cash_rounding == null) {
        throw new Error('paper_corporate_cash_rounding_terms_missing:' + row.action_id)
      }
      statements.push(db.prepare('UPDATE paper_accounts SET cash=cash+?, updated_at=? WHERE id=?')
        .bind(row.cash_due, now.toISOString(), accountId))
    } else {
      // Fractional rights need the issuer's cash-in-lieu settlement; never round
      // them into free stock or drop them from economic NAV.
      if (row.shares_due !== row.whole_shares_due && row.fractional_treatment !== 'book_entry_fee') {
        throw new Error('paper_corporate_fractional_delivery_terms_missing:' + row.action_id)
      }
      if (row.whole_shares_due > 0) {
        const basis = row.position_basis_json ? JSON.parse(row.position_basis_json) : null
        if (!basis || basis.symbol !== row.symbol || basis.account_id !== accountId) {
          throw new Error('paper_corporate_position_basis_missing:' + row.action_id)
        }
        // If the old holding was sold before delivery, restore its own exit
        // owner/adjusted anchors; do not create an ownerless default strategy.
        // An existing newer holding keeps its current lifecycle on the upsert.
        statements.push(db.prepare(`INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,
          entry_price,entry_date,updated_at,initial_stop,trailing_stop,highest_since_entry,
          stop_multiplier,tp1_price,tp2_price,tp1_hit,original_shares,trade_lifecycle_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET
          avg_cost=(paper_positions.shares*paper_positions.avg_cost+excluded.shares*excluded.avg_cost)/(paper_positions.shares+excluded.shares),
          shares=paper_positions.shares+excluded.shares, updated_at=excluded.updated_at`)
          .bind(accountId, row.symbol, basis.name ?? row.symbol, row.whole_shares_due, row.share_cost_basis,
            basis.entry_price ?? row.share_cost_basis, basis.entry_date ?? row.ex_date, now.toISOString(),
            basis.initial_stop ?? null, basis.trailing_stop ?? null, basis.highest_since_entry ?? null,
            basis.stop_multiplier ?? 2, basis.tp1_price ?? null, basis.tp2_price ?? null,
            basis.tp1_hit ?? 0, row.whole_shares_due, basis.trade_lifecycle_json ?? null))
      }
    }
    statements.push(db.prepare('UPDATE paper_corporate_entitlements_v1 SET settled=1, settled_at=? WHERE account_id=? AND action_id=? AND settled=0')
      .bind(now.toISOString(), accountId, row.action_id))
  }
  statements.push(db.prepare('INSERT INTO paper_corporate_sessions_v1(account_id,session_date,source_checksum,processed_at) VALUES(?,?,?,?)')
    .bind(accountId, sessionDate, snapshot.source_checksum, now.toISOString()))
  // Do not split the transaction into partial accrual/cash writes.
  if (statements.length > 100) throw new Error('paper_corporate_atomic_batch_limit_exceeded')
  // Keep the existing economic-operation capacity. One mandatory audit insert
  // must not turn an otherwise valid session into a new capacity failure.
  // D1's 100 bound-parameter limit is per statement, not per batch.
  statements.unshift(openingStatement)
  const beforeCommit = paperExecutionDate()
  if (beforeCommit.getTime() < now.getTime()) throw new Error('paper_corporate_opening_clock_regressed')
  if (beforeCommit.toISOString() >= sessionDate + 'T01:00:00.000Z') throw new Error('paper_corporate_exdate_opening_state_required')
  const results = await db.batch(statements)
  if (results.length !== statements.length || results.some(r => r.success !== true)) throw new Error('paper_corporate_transaction_incomplete')
}
