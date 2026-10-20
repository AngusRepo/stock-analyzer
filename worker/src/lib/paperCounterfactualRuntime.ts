import type { Bindings } from '../types'
import type { PendingBuy } from './pendingBuyStore'
import type { SwingEntryDecision } from './paperSwingPolicy'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import type { AuthoritativeExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { type L4PortfolioPlan, planIdFromWatchPoints } from './l4PortfolioPlan'
import { readL4ExecutionPlan } from './paperDailyPlanRuntime'
import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { batchGetExecutionOrderbooks, type IntradayOHLC } from './paperIntradayData'
import { shioajiBookObservation } from './paperExecutionBook'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import { recordCounterfactualEntry, recordCounterfactualSignal, readCounterfactualLot,
  listOpenCounterfactualLots, recordCounterfactualObservation } from './paperCounterfactualStore'
import { normalizeTwLimitPrice } from './twMarketRules'
import type { CounterfactualLot } from './paperCounterfactual'

type Sizing = { shares: number; limitPrice: number; snapshot: AuthoritativeExecutionSnapshot }
type Attempt = { pending: PendingBuy; signal: SwingEntryDecision; observedMs: number;
  blockedReason: string | null; sizing: Sizing | null; filled: boolean }
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

/** Capture existing decisions. Never compute a new budget or bypass a blocked gate to size a trade. */
export function createCounterfactualRecorder(ports: RecorderPorts, date: string) {
  const attempts = new Map<string, Attempt>()
  return {
    observe(pending: PendingBuy, signal: SwingEntryDecision) {
      if (signal.policy !== SWING_POLICY_VERSION || !Number.isFinite(signal.signalMs)
        || signal.conditions?.or_touch !== true) return
      attempts.set(pending.symbol, { pending: structuredClone(pending), signal: structuredClone(signal),
        observedMs: ports.now(), blockedReason: signal.action === 'defer' ? signal.reason : null, sizing: null, filled: false })
    },
    blocked(symbol: string, reason: string) {
      const attempt = attempts.get(symbol)
      if (attempt) attempt.blockedReason = reason
    },
    sized(symbol: string, sizing: Sizing) {
      const attempt = attempts.get(symbol)
      if (attempt) attempt.sizing = structuredClone(sizing)
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
          const missing = !sizing ? 'quantity_not_reached_before_block'
            : !sourceReady ? 'sealed_model_identity_missing'
              : !(Number.isFinite(signal.orLow) && signal.orLow! > 0) ? 'signal_or_low_missing' : null
          if (missing) {
            await recordCounterfactualSignal(ports.db, { accountId: ports.accountId, lotId,
              observedMs: attempt.observedMs, reason: missing,
              evidence: { symbol, date, blocked_reason: attempt.blockedReason, signal, plan_id: planId,
                requested_shares: sizing?.shares ?? null, fill: null, z: null, z_missing_reason: 'entry_not_observable' } })
            continue
          }
          const signalSha = await digest(JSON.stringify({ symbol, date, signal, plan_id: planId,
            blocked_reason: attempt.blockedReason, quantity_source: 'paper_entry_same_snapshot' }))
          await recordCounterfactualEntry(ports.db, {
            accountId: ports.accountId, lotId, symbol, date, signalMs: signal.signalMs!,
            // The exact book used by the same entry attempt, not a quote fetched after the rejection.
            nowMs: Date.parse(sizing!.snapshot.createdAt),
            observableUntilMs: signal.submitUntilMs ?? signal.signalMs! + 60_000,
            requestedShares: sizing!.shares, limitPrice: sizing!.limitPrice, entryOrLow: signal.orLow!,
            source: { signalSha, modelSha: plan!.model_checksum, planId: planId!, l3Identity: plan!.l3_identity!,
              blockedReason: attempt.blockedReason, quantitySource: 'paper_entry_same_snapshot' },
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

/** Run after the live Paper path, including empty-pending days. Only the research tables are written. */
export async function pollPaperCounterfactualLots(env: Bindings, date: string) {
  const db = paperDomainDatabase(env), lots = await listOpenCounterfactualLots(db, paperAccountId())
  if (!lots.length) return { observed: 0, errors: [] as string[] }
  const byLot = new Map<'board_lot' | 'odd_lot', Map<string, IntradayOHLC>>()
  for (const lotType of ['board_lot', 'odd_lot'] as const) {
    const symbols = [...new Set(lots.filter(row => row.lot.lotType === lotType).map(row => row.lot.symbol))]
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
      const quote = byLot.get(lot.lotType)?.get(lot.symbol)
      const limitPrice = quote?.bid != null && quote.bid > 0 ? normalizeTwLimitPrice(quote.bid, 'sell') : null
      const snapshot = quote?.source === 'shioaji' && limitPrice != null
        ? resolveAuthoritativeSellExecutionSnapshot({ nowMs, limitPrice, lotType: lot.lotType,
          maxAgeMs: Number((env as any).EXECUTION_BOOK_MAX_AGE_MS) || 1500, observations: [shioajiBookObservation(quote)] }) : null
      const price = snapshot?.status === 'ready' && Number.isFinite(quote?.last) && quote!.last > 0 ? quote!.last : null
      if (complete && calendar.some(day => day >= lot.swing.entryDate && day < date
        && day > (lot.swing.lastEvaluatedCloseDate ?? '')
        && !rows.some(row => row.symbol === lot.symbol && row.date === day && Number(row.close) > 0))) complete = false
      const closes = complete ? rows.filter(row => row.symbol === lot.symbol && row.date >= lot.swing.entryDate
        && row.date > (lot.swing.lastEvaluatedCloseDate ?? '') && row.date < date).map(row => ({
        date: row.date, close: Number(row.close), observedAtMs: nowMs, nextSession: calendar[calendar.indexOf(row.date)+1],
      })).filter(row => row.nextSession) : []
      await recordCounterfactualObservation(db, previous, { date, nowMs, price, calendar: complete ? calendar : [],
        closes, snapshot, limitPrice,
        // Missing/changed model evidence is unknown; missing membership never means a target exit.
        z: counterfactualZ(plan?.execution_review?.tradeDate === date ? plan : null,lot), targetExit: null })
      observed++
    } catch (error) { errors.push(lot.lotId + ':' + String(error)) }
  }
  if (errors.length) console.warn('[Counterfactual] incomplete exit evidence:', errors)
  return { observed, errors }
}
