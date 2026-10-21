import type { Bindings } from '../types'
import type { PendingBuy } from './pendingBuyStore'
import type { SwingEntryDecision } from './paperSwingPolicy'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import type { AuthoritativeExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { type L4PortfolioPlan, l4TargetExitShares, planIdFromWatchPoints } from './l4PortfolioPlan'
import { verifyDailyReview } from './paperDailyPlan'
import { readL4ExecutionPlan } from './paperDailyPlanRuntime'
import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { batchGetExecutionOrderbooks, type IntradayOHLC } from './paperIntradayData'
import { shioajiBookObservation } from './paperExecutionBook'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import { recordCounterfactualEntry, recordCounterfactualSignal, readCounterfactualLot,
  listOpenCounterfactualLots, recordCounterfactualObservation } from './paperCounterfactualStore'
import { buildTwOrderLegs, normalizeTwLimitPrice } from './twMarketRules'
import type { CounterfactualLot } from './paperCounterfactual'
import { applyResearchCorporateSessions, type ResearchCorporateSession } from './paperCounterfactualCorporate'
import type { FiveSlotDecision } from './fiveSlotCapitalAllocator'
import { evaluatePreTradeExecution, type PreTradeExecutionInput } from './preTradeExecutionPolicy'
import { resolveLimitBuyFill } from './paperTradeMath'
import { validateCorporateSnapshot, type CorporateActionSnapshot } from './paperCorporateActions'

type Sizing = { shares: number; limitPrice: number; snapshot: AuthoritativeExecutionSnapshot;
  quantitySource?: CounterfactualLot['source']['quantitySource']; evidence?: Record<string, unknown> }
type Attempt = { pending: PendingBuy; signal: SwingEntryDecision; observedMs: number;
  blockedReason: string | null; sizing: Sizing | null; sizingMissingReason: string | null; filled: boolean }
type RecorderPorts = { db: D1Database; accountId: number; now: () => number;
  readPlan: (planId: string) => Promise<L4PortfolioPlan | null>; onError: (error: unknown) => void }
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))))
  .map(v=>v.toString(16).padStart(2,'0')).join('')
const sha = (text: unknown): text is string => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text)

/** P6's producer persists raw z in the sealed full-pool distribution, not in PendingBuy's scalar score. */
export function counterfactualZ(plan: L4PortfolioPlan | null, lot: Pick<CounterfactualLot,'symbol'|'source'>): number | null {
  const projection = (plan as any)?.p6_projection, distribution = (plan?.targets[lot.symbol] as any)?.distribution
  if (!plan || plan.model_checksum !== lot.source.modelSha || projection?.schema_version !== 'p6-full-pool-projection-v1'
    || projection.signal_date !== plan.signal_date || projection.model_checksum !== plan.model_checksum
    || !sha(projection.forecast_checksum) || !sha(projection.source_pool_checksum)
    || distribution?.symbol !== lot.symbol || distribution?.model_checksum !== plan.model_checksum
    || distribution?.source_forecast_checksum !== projection.forecast_checksum
    || distribution?.source_pool_checksum !== projection.source_pool_checksum
    || !['artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum'].every(key =>
      typeof lot.source.l3Identity[key] === 'string' && plan.l3_identity?.[key] === lot.source.l3Identity[key]
      && projection.l3_identity?.[key] === lot.source.l3Identity[key])
    || typeof distribution.z !== 'number' || !Number.isFinite(distribution.z)) return null
  return distribution.z
}

/** Pure research sizing: the existing allocator supplies the budget from the same Paper snapshot.
 * Only the observed technical veto is omitted. No account, cooldown, dedupe or risk budget is mutated.
 * Missing odd-lot depth is not replaced by board-lot depth or a later quote.
 */
export function counterfactualSizing(input: {
  nowMs: number; signal: SwingEntryDecision; quote: IntradayOHLC | undefined;
  decision: FiveSlotDecision | null; context: Record<string, unknown>; minPositionValue: number;
  preTrade: PreTradeExecutionInput; slippageTicks: number; maxBookAgeMs: number; maxDisagreementTicks: number;
}): { sizing: Sizing | null; reason: string } {
  const missing = (reason: string) => ({ sizing: null, reason })
  if (!Number.isFinite(input.signal.signalMs) || input.nowMs < input.signal.signalMs!
    || input.nowMs >= (input.signal.submitUntilMs ?? input.signal.signalMs! + 60_000))
    return missing('signal_observation_window_missed')
  const decision = input.decision, quote = input.quote
  if (!decision || !['buy','add'].includes(decision.action)) return missing('counterfactual_allocator:' + (decision?.reason ?? 'missing'))
  // Continuations need their original authorization/remaining-shares owner; do not invent it.
  if (input.context.l4_entry_continuation) return missing('counterfactual_entry_continuation_requires_original_authorization')
  if (!Number.isFinite(decision.budgetCap) || decision.budgetCap < input.minPositionValue)
    return missing('allocator_budget_below_min')
  if (!quote || quote.source !== 'shioaji' || !quote.lotType) return missing('execution_book_missing')
  const preTrade = evaluatePreTradeExecution({ ...input.preTrade, technical: null })
  if (preTrade.action !== 'BUY_AT') return missing('counterfactual_pretrade:' + preTrade.reason)
  const limitPrice = normalizeTwLimitPrice(preTrade.limitPrice ?? input.preTrade.entryPrice, 'buy')
  if (!Number.isFinite(input.signal.maxBuyPrice)) return missing('signal_max_buy_price_missing')
  if (limitPrice > input.signal.maxBuyPrice!) return missing('swing_chase_limit')
  const snapshot = resolveAuthoritativeBuyExecutionSnapshot({ nowMs: input.nowMs, limitPrice, lotType: quote.lotType,
    maxAgeMs: input.maxBookAgeMs, maxDisagreementTicks: input.maxDisagreementTicks,
    observations: [shioajiBookObservation(quote)] })
  if (snapshot.status !== 'ready') return missing(snapshot.reason)
  const fill = resolveLimitBuyFill({ currentPrice: input.preTrade.currentPrice, limitPrice,
    bestAsk: snapshot.ask, bestBid: snapshot.bid, intradayLow: quote.low, intradayHigh: quote.high,
    slippageTicks: input.slippageTicks, requireBestAsk: true })
  if (!fill.fillable || fill.fillPrice == null) return missing(fill.reason)
  const fullLots = Math.floor(decision.budgetCap / (fill.fillPrice * 1000))
  const shares = fullLots >= 1 ? fullLots * 1000 : Math.floor(decision.budgetCap / fill.fillPrice)
  if (shares < 1) return missing('counterfactual_shares_below_one')
  if (snapshot.lotType !== (shares >= 1000 ? 'board_lot' : 'odd_lot')) return missing('execution_lot_type_mismatch')
  return { reason: 'same_snapshot_allocator_sizing', sizing: { shares, limitPrice, snapshot,
    quantitySource: 'paper_allocator_counterfactual_snapshot',
    evidence: { allocator: structuredClone(decision), context: structuredClone(input.context),
      sizing_fill_price: fill.fillPrice, omitted_gate: 'observed_technical_veto', order_risk_validation: 'not_reached' } } }
}

/** Capture decisions without changing the formal entry path. */
export function createCounterfactualRecorder(ports: RecorderPorts, date: string) {
  const attempts = new Map<string, Attempt>()
  return {
    observe(pending: PendingBuy, signal: SwingEntryDecision) {
      if (signal.policy !== SWING_POLICY_VERSION || !Number.isFinite(signal.signalMs)
        || signal.conditions?.or_touch !== true) return
      attempts.set(pending.symbol, { pending: structuredClone(pending), signal: structuredClone(signal),
        observedMs: ports.now(), blockedReason: signal.action === 'defer' ? signal.reason : null,
        sizing: null, sizingMissingReason: null, filled: false })
    },
    blocked(symbol: string, reason: string) {
      const attempt = attempts.get(symbol)
      if (attempt) attempt.blockedReason = reason
    },
    sized(symbol: string, sizing: Sizing) {
      const attempt = attempts.get(symbol)
      if (attempt) attempt.sizing = structuredClone(sizing)
    },
    sizingUnavailable(symbol: string, reason: string) {
      const attempt = attempts.get(symbol)
      if (attempt) attempt.sizingMissingReason = reason
    },
    filled(symbol: string) {
      const attempt = attempts.get(symbol)
      if (attempt) attempt.filled = true
    },
    async flush() {
      for (const [symbol, attempt] of attempts) {
        if (!attempt.blockedReason || attempt.filled) continue
        try {
          const { signal, sizing } = attempt
          const lotId = `${date}:${symbol}:${signal.signalMs}`
          // One research lot per signal. Later scheduler delivery cannot replace its first observed fill.
          if (await readCounterfactualLot(ports.db, ports.accountId, lotId)) continue
          const planId = planIdFromWatchPoints(attempt.pending.watch_points)
          const plan = planId ? await ports.readPlan(planId).catch(() => null) : null
          const sourceReady = plan && plan.plan_id === planId && sha(plan.model_checksum)
            && plan.l3_identity && Object.keys(plan.l3_identity).length > 0
          const missing = !sizing ? attempt.sizingMissingReason ?? 'quantity_not_reached_before_block'
            : !sourceReady ? 'sealed_model_identity_missing'
              : !(Number.isFinite(signal.orLow) && signal.orLow! > 0) ? 'signal_or_low_missing' : null
          if (missing) {
            await recordCounterfactualSignal(ports.db, { accountId: ports.accountId, lotId,
              observedMs: attempt.observedMs, reason: missing,
              evidence: { symbol, date, blocked_reason: attempt.blockedReason, signal, plan_id: planId,
                requested_shares: sizing?.shares ?? null, fill: null, z: null, z_missing_reason: 'entry_not_observable' } })
            continue
          }
          const quantitySource = sizing!.quantitySource ?? 'paper_entry_same_snapshot'
          const signalSha = await digest(JSON.stringify({ symbol, date, signal, plan_id: planId,
            blocked_reason: attempt.blockedReason, quantity_source: quantitySource, sizing_evidence: sizing!.evidence ?? null }))
          await recordCounterfactualEntry(ports.db, {
            accountId: ports.accountId, lotId, symbol, date, signalMs: signal.signalMs!,
            // The exact book used by the same entry attempt, not a quote fetched after the rejection.
            nowMs: Date.parse(sizing!.snapshot.createdAt),
            observableUntilMs: signal.submitUntilMs ?? signal.signalMs! + 60_000,
            requestedShares: sizing!.shares, limitPrice: sizing!.limitPrice, entryOrLow: signal.orLow!,
            source: { signalSha, modelSha: plan!.model_checksum, planId: planId!, l3Identity: plan!.l3_identity!,
              blockedReason: attempt.blockedReason, quantitySource, sizingEvidence: sizing!.evidence },
            snapshot: sizing!.snapshot,
          })
        } catch (error) { ports.onError(error) }
      }
    },
  }
}

export function createPaperCounterfactualRecorder(env: Bindings, date: string) {
  return createCounterfactualRecorder({ db: paperDomainDatabase(env), accountId: paperAccountId(),
    now: paperExecutionNow, readPlan: planId => readL4ExecutionPlan(env, planId, date),
    onError: error => console.warn('[Counterfactual] entry evidence unavailable:', error) }, date)
}

/** Only a signed, known-at-observation, explicit zero target is independent of virtual account NAV.
 * Positive target reductions and conditional rotation require a research account anchor/readiness.
 */
export async function counterfactualTarget(plan: L4PortfolioPlan | null, lot: CounterfactualLot,
  date: string, nowMs: number, price: number | null) {
  const missing = (reason: string) => ({ targetExit: null, reason })
  const review = plan?.execution_review
  if (!plan || !review || review.tradeDate !== date || review.finalizedAtMs > nowMs)
    return missing('target_review_date_or_known_at_missing')
  if (plan.model_checksum !== lot.source.modelSha || !['artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum']
    .every(key => typeof lot.source.l3Identity[key] === 'string' && plan.l3_identity?.[key] === lot.source.l3Identity[key]))
    return missing('target_frozen_model_identity_mismatch')
  try { await verifyDailyReview(plan,review) }
  catch { return missing('target_review_invalid') }
  const target = plan.targets[lot.symbol], weight = review.weights[lot.symbol]
  if (!target || weight == null) return missing('target_symbol_not_explicit')
  if (target.locked) return missing('target_locked')
  if (weight !== 0) return missing('target_reduction_requires_research_account_anchor')
  const riskReduced = weight < target.weight
  if (!riskReduced && plan.sealed_execution?.exit_rules[lot.symbol]?.mode !== 'unconditional')
    return missing('target_rotation_readiness_missing')
  if (price == null || !(price > 0)) return missing('target_observed_price_missing')
  const shares = l4TargetExitShares({ plan, symbol: lot.symbol, shares: lot.arms.current_target.shares,
    originalShares: lot.entryShares, price, nav: plan.nav_at_decision, minTradeValue: 0, rotationSatisfied: false })
  return { targetExit: { shares, decisionId: `${date}:${plan.plan_id}:${review.checksum}:${lot.symbol}`,
    reason: riskReduced ? 'l4_daily_risk_target_zero' : 'l4_unconditional_target_zero' }, reason: null }
}

/** Read-only corporate coverage. Unsupported actions preserve the lot for a later producer;
 * no missing symbol, snapshot or adjustment is treated as "no corporate action".
 */
export async function counterfactualCorporateCoverage(input: {
  lot: CounterfactualLot; date: string; nowMs: number; calendar: string[];
  read: (date: string) => Promise<CorporateActionSnapshot | null>;
  previousClose?: (date: string) => ResearchCorporateSession['previousClose'];
}) {
  const receipts: Array<{ date: string; source_checksum: string; observed_at: string }> = []
  const sessions: ResearchCorporateSession[] = []
  const missing = (reason: string) => ({ reason, throughDate: null, receipts, sessions })
  const from = input.lot.corporateThroughDate ?? input.lot.swing.entryDate
  if (!input.calendar.includes(input.date)) return missing('corporate_session_calendar_incomplete')
  // Recheck today's producer even if an earlier tick established coverage; later source revisions
  // must not be hidden by the cross-day cursor. Ex-day entry lots were acquired after adjustment.
  for (const day of input.calendar.filter(day => day > input.lot.swing.entryDate
    && (day > from || day === input.date) && day <= input.date)) {
    const snapshot = await input.read(day)
    if (!snapshot) return missing('corporate_snapshot_missing:' + day)
    // Historical coverage must have been known that day; do not backdate a newly produced snapshot.
    const knownAt = Math.min(input.nowMs,Date.parse(day+'T23:59:59.999+08:00'))
    try { validateCorporateSnapshot(snapshot,day,knownAt) }
    catch (error) { return missing('corporate_snapshot_invalid:' + day + ':' + String(error)) }
    if (!snapshot.covered_symbols.includes(input.lot.symbol)) return missing('corporate_symbol_not_covered:' + day)
    if (snapshot.blockers[input.lot.symbol]?.length) return missing('corporate_terms_blocked:' + day + ':' + snapshot.blockers[input.lot.symbol].join('|'))
    receipts.push({ date: day, source_checksum: snapshot.source_checksum, observed_at: snapshot.observed_at })
    sessions.push({ snapshot, previousClose: input.previousClose?.(day) ?? null })
  }
  return { reason: null, throughDate: input.date, receipts, sessions }
}

/** Run after the live Paper path, including empty-pending days. Only the research tables are written. */
export async function pollPaperCounterfactualLots(env: Bindings, date: string) {
  const db = paperDomainDatabase(env), lots = await listOpenCounterfactualLots(db, paperAccountId())
  if (!lots.length) return { observed: 0, errors: [] as string[] }
  const byLot = new Map<'board_lot' | 'odd_lot', Map<string, IntradayOHLC>>()
  for (const lotType of ['board_lot', 'odd_lot'] as const) {
    const symbols = [...new Set(lots.filter(row => Object.values(row.lot.arms)
      .some(arm => buildTwOrderLegs(arm.shares).some(leg => leg.lotType === lotType))).map(row => row.lot.symbol))]
    if (symbols.length) byLot.set(lotType, await batchGetExecutionOrderbooks(symbols,
      { ...env, marketDataLotType: lotType }))
  }
  const errors: string[] = []
  const plan = await readL4ExecutionPlan(env,undefined,date).catch(() => null)
  let rows: Awaited<ReturnType<typeof loadMarketPriceHistoryBySymbols>> = []
  try {
    rows = await loadMarketPriceHistoryBySymbols(env, ['0050', ...new Set(lots.map(row => row.lot.symbol))],
      { beforeDate: date, rowsPerSymbol: 260, requireQuerySuccess: true })
  } catch (error) { errors.push('daily_evidence_unavailable:' + String(error)) }
  const calendar = [...new Set([...rows.filter(row => row.symbol === '0050').map(row => row.date), date])].sort()
  let observed = 0
  for (const previous of lots) {
    const lot = previous.lot, nowMs = paperExecutionNow()
    if (nowMs <= lot.lastObservedMs) continue
    try {
      let complete = true
      for (let ms = Date.parse(lot.swing.entryDate+'T00:00:00Z'); ms < Date.parse(date+'T00:00:00Z'); ms += 86400_000) {
        const day = new Date(ms), iso = day.toISOString().slice(0,10)
        if (![0,6].includes(day.getUTCDay()) && !calendar.includes(iso) && !await env.KV.get('holiday:'+iso)) complete = false
      }
      if (complete && calendar.some(day => day >= lot.swing.entryDate && day < date
        && !rows.some(row => row.symbol === lot.symbol && row.date === day && Number(row.close) > 0))) complete = false
      const closes = complete ? rows.filter(row => row.symbol === lot.symbol && row.date >= lot.swing.entryDate
        && row.date < date).map(row => ({
        date: row.date, close: Number(row.close), observedAtMs: nowMs, nextSession: calendar[calendar.indexOf(row.date)+1],
      })).filter(row => row.nextSession) : []
      const corporate = complete
        ? await counterfactualCorporateCoverage({ lot, date, nowMs, calendar,
          previousClose: day => {
            const previousDay = calendar[calendar.indexOf(day) - 1]
            const row = rows.find(row => row.symbol === lot.symbol && row.date === previousDay)
            return row ? { date: row.date, close: Number(row.close) } : null
          },
          read: async day => await env.KV.get('market:corporate_actions:v1:'+day,'json') as CorporateActionSnapshot | null })
        : { reason: 'corporate_session_calendar_incomplete', throughDate: null, receipts: [], sessions: [] }
      let economicLot = lot, corporateReason = corporate.reason
      if (!corporateReason) {
        try { economicLot = applyResearchCorporateSessions(lot, { date, nowMs, calendar, sessions: corporate.sessions }) }
        catch (error) { corporateReason = String(error) }
      }
      const exitBooks: NonNullable<Parameters<typeof recordCounterfactualObservation>[2]['exitBooks']> = {}
      const needed = [...new Set(Object.values(economicLot.arms).flatMap(arm =>
        buildTwOrderLegs(arm.shares).map(leg => leg.lotType)))]
      for (const lotType of needed) {
        // Stock delivery can introduce a lot type absent before this tick.
        if (!byLot.get(lotType)?.has(lot.symbol)) {
          const additional = await batchGetExecutionOrderbooks([lot.symbol], { ...env, marketDataLotType: lotType })
          if (!byLot.has(lotType)) byLot.set(lotType, new Map())
          for (const [symbol, quote] of additional) byLot.get(lotType)!.set(symbol, quote)
        }
        const quote = byLot.get(lotType)?.get(lot.symbol)
        const limitPrice = quote?.bid != null && quote.bid > 0 ? normalizeTwLimitPrice(quote.bid, 'sell') : null
        const snapshot = quote?.source === 'shioaji' && limitPrice != null
          ? resolveAuthoritativeSellExecutionSnapshot({ nowMs, limitPrice, lotType,
            maxAgeMs: Number((env as any).EXECUTION_BOOK_MAX_AGE_MS) || 1500, observations: [shioajiBookObservation(quote)] }) : null
        const price = snapshot?.status === 'ready' && Number.isFinite(quote?.last) && quote!.last > 0 ? quote!.last : null
        exitBooks[lotType] = { snapshot, limitPrice, price }
      }
      const targetLot = buildTwOrderLegs(economicLot.arms.current_target.shares)[0]?.lotType
      const price = targetLot ? exitBooks[targetLot]?.price ?? null : null
      const target = await counterfactualTarget(plan,economicLot,date,nowMs,price)
      await recordCounterfactualObservation(db, previous, { date, nowMs, price, calendar: complete ? calendar : [],
        closes, snapshot: null, limitPrice: null, exitBooks, observationBlockedReason: corporateReason,
        corporateThroughDate: corporate.throughDate ?? undefined, corporateEvidence: corporate.receipts,
        corporateSessions: corporate.sessions,
        // Missing/changed model evidence is unknown; missing membership never means a target exit.
        z: counterfactualZ(plan?.execution_review?.tradeDate === date ? plan : null,lot),
        targetExit: target.targetExit, targetMissingReason: target.reason })
      observed++
    } catch (error) { errors.push(lot.lotId + ':' + String(error)) }
  }
  if (errors.length) console.warn('[Counterfactual] incomplete exit evidence:', errors)
  return { observed, errors }
}
