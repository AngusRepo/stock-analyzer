import { getPrevTradingDay } from './paperMarketData'
import { twToday } from './dateUtils'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperExecutionDate } from './paperExecutionScope'
import { getTradingConfig } from './tradingConfig'
import { getRiskConfig } from './riskConfig'
import { checkCircuitBreakersForDomains } from './pendingBuyOrchestrator'
import { resolveCircuitAdjustedSingleNameCap } from './riskPositionSizing'
import { isTwIntradayTradingMinute } from './twMarketSession'
import { fetchFinLabL5MarketDataSnapshot } from './finlabL5MarketData'
import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import { computePaperTotalValue, getUnsettledSettlementSummary, requireCompletePaperPositionValue } from './paperAccountValue'
import { corporateAccountRiskBounds } from './paperCorporateActions'
import { getAvailableCash } from './dateUtils'

/** Use the same legal share, settlement and corporate-action owners as Paper. */
export async function captureL4AccountContext(env: Bindings, signalDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signalDate)) throw new Error('l4_account_date_invalid')
  if (![twToday(),await getPrevTradingDay(databaseForDataDomain(env,'core'),env.KV)].includes(signalDate)) throw new Error('l4_account_signal_expired')
  const cfg=await getTradingConfig(env.KV)
  const risk=await getRiskConfig(env.KV)
  const cb=await checkCircuitBreakersForDomains(env,cfg,env.KV)
  const riskLimits={exposure_cap:cb.halt ? 0 : cb.targetExposurePct,name_cap:resolveCircuitAdjustedSingleNameCap({
    configuredSingleNameCap:Math.min(cfg.position.maxPctOfPortfolio,risk.position.maxSingleNamePct),
    circuitBaselinePositionPct:cfg.circuit.maxPositionPct,circuitEffectivePositionPct:cb.maxPositionPct}),
    max_positions:cfg.position.maxPositions,min_trade_value:cfg.position.minPositionValue,
    buys_halted:cb.halt || risk.system.killSwitch}
  if (![riskLimits.exposure_cap,riskLimits.name_cap,riskLimits.max_positions,riskLimits.min_trade_value].every(v=>typeof v==='number' && Number.isFinite(v)))
    throw new Error('l4_account_risk_limits_incomplete')
  const db = paperDomainDatabase(env)
  const initialHead = await db.prepare('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1').first<{plan_id:string|null}>()
  const startOrder=await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM paper_orders WHERE account_id=1').first<{id:number}>()
  const account = await db.prepare('SELECT cash FROM paper_accounts WHERE id=1').first<{ cash: number }>()
  if (!account) throw new Error('l4_account_missing')
  const { results: positions } = await db.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=1 AND shares>0',
  ).all<{ symbol: string; shares: number }>()
  const prices = await loadMarketPriceHistoryBySymbols(env, positions.map(row => row.symbol),
    { onOrBeforeDate: signalDate, rowsPerSymbol: 1 })
  let marks = new Map(prices.map(row => [row.symbol, Number(row.close)]))
  const intraday=isTwIntradayTradingMinute()
  if (intraday && positions.length) {
    const snapshot=await fetchFinLabL5MarketDataSnapshot(env,positions.map(row=>row.symbol))
    marks=new Map()
    for (const row of positions) {
      const quote=snapshot.quotes.get(row.symbol)
      if (quote?.lastPrice!=null && quote.quoteAgeMs!=null && quote.quoteAgeMs<=cfg.position.maxQuoteAgeMs) marks.set(row.symbol,quote.lastPrice)
    }
  }
  const heldValue = requireCompletePaperPositionValue(positions, marks)
  const settlement = await getUnsettledSettlementSummary(db, 1)
  const corporate = await corporateAccountRiskBounds(env, 1, marks)
  const cash = await getAvailableCash(db, 1)
  // An in-flight writer has not committed its final shares/cash yet. Never seal
  // a torn account or guess its reservation. A retry takes a fresh snapshot.
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM paper_order_intents WHERE account_id=1 AND status='running'")
    .first<{ n: number }>()
  const exitPending = await db.prepare("SELECT COUNT(*) AS n FROM paper_exit_intents WHERE account_id=1 AND state='SUBMITTING'")
    .first<{ n: number }>()
  const nav = computePaperTotalValue({ settledCash: Number(account.cash), positionsValue: heldValue,
    netUnsettledSettlement: settlement.netUnsettledSettlement, corporateReceivablesValue: corporate.lower })
  const finalAccount = await db.prepare('SELECT cash FROM paper_accounts WHERE id=1').first<{cash:number}>()
  const { results: finalPositions } = await db.prepare('SELECT symbol,shares FROM paper_positions WHERE account_id=1 AND shares>0 ORDER BY symbol').all<{symbol:string;shares:number}>()
  const finalHead = await db.prepare('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1').first<{plan_id:string|null}>()
  const finalOrder=await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM paper_orders WHERE account_id=1').first<{id:number}>()
  const unchanged = startOrder?.id===finalOrder?.id && Number(finalAccount?.cash)===Number(account.cash)
    && JSON.stringify([...positions].sort((a,b)=>a.symbol.localeCompare(b.symbol)))===JSON.stringify(finalPositions)
    && initialHead?.plan_id===finalHead?.plan_id
    && JSON.stringify(settlement)===JSON.stringify(await getUnsettledSettlementSummary(db,1))
    && cash===await getAvailableCash(db,1)
  const { results: vetoRows } = await db.prepare(
    "SELECT o.request_json FROM l4_replan_outbox_v1 o JOIN l4_portfolio_plans_v1 p ON p.plan_id=o.source_plan_id WHERE p.signal_date=? AND o.status<>'expired'",
  ).bind(signalDate).all<{request_json:string}>()
  const vetoes = [...new Set(vetoRows.flatMap(row => (JSON.parse(row.request_json).veto_symbols ?? []) as string[]))]
  const nameCaps: Record<string,number> = {}
  for (const row of vetoRows) for (const [symbol,cap] of Object.entries(JSON.parse(row.request_json).weight_caps ?? {})) {
    if (typeof cap!=='number' || !Number.isFinite(cap) || cap<0 || cap>1) throw new Error('l4_account_name_cap_invalid')
    nameCaps[symbol]=Math.min(nameCaps[symbol] ?? 1,cap)
  }
  const currentPrices = intraday ? positions.every(row=>marks.has(row.symbol)) : prices.every(row=>row.date===signalDate)
  const sectors = new Map<string,string>()
  if (positions.length) {
    const {results}=await databaseForDataDomain(env,'core').prepare(`SELECT symbol,sector FROM stocks WHERE symbol IN (${positions.map(()=>'?').join(',')})`).bind(...positions.map(row=>row.symbol)).all<{symbol:string;sector:string|null}>()
    for (const row of results) if (row.sector) sectors.set(row.symbol,row.sector)
  }
  return { schema_version: 'l4-account-context-v1', account_id: 1, signal_date: signalDate,
    active_plan_id: finalHead?.plan_id ?? null, observed_at: paperExecutionDate().toISOString(), nav, available_cash: cash,
    complete: unchanged && currentPrices && corporate.complete && Number(pending?.n ?? 0) === 0 && Number(exitPending?.n ?? 0) === 0,
    holdings: positions.map(row => ({ symbol: row.symbol, sector:sectors.get(row.symbol) ?? null, shares: row.shares,
      price: marks.get(row.symbol)!, market_value: row.shares * marks.get(row.symbol)! })),
    locked_symbols: [] as string[], forbidden_buys: vetoes, name_caps:nameCaps,
    risk_limits:riskLimits, fees:{buy_cost:cfg.fees.commission,sell_cost:cfg.fees.commission+cfg.fees.tax},
    account_anchor:{order_watermark:Number(finalOrder?.id ?? 0),cash:Number(account.cash),positions:finalPositions,settlement},
    valuation_source:intraday?'authoritative_intraday_quotes':'canonical_signal_close',
    settlement, corporate_receivables: corporate, in_flight_orders: Number(pending?.n ?? 0) + Number(exitPending?.n ?? 0) }
}
