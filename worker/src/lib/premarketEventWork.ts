import { dailyPlanOwner } from './paperDailyPlanRuntime'
import { singlePlanContext,dispatchSinglePlan,finalizeSinglePlan } from './premarketSinglePlan'
import { ensurePaperCorporateSource } from './paperCorporateSource'
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { fetchAndStoreUSLeading, isReadyUSSignal } from './usLeading'
import { readCurrentNewsReport, runDailyNewsAnalysis } from './newsAnalyst'
import { getPrevTradingDay } from './paperMarketData'
import { recoverPaperMorningSetup } from './paperMorningRecovery'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { reconcilePendingBuyDebates, setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { flushL4Replans } from './l4Replan'
import { readL4PortfolioPlan, planIdFromWatchPoints } from './l4PortfolioPlan'
import { getTradingConfig } from './tradingConfig'
import type { PremarketWork } from './premarketEventChain'

async function contextIdentity(env: Bindings, date: string): Promise<string> {
  const report = await readCurrentNewsReport(env.KV,date)
  const us = await env.KV.get(`us:leading:${date}`,'json')
  if (!report?.evidence_receipt?.sha256 || !isReadyUSSignal(us,date)) throw new Error('premarket_wait:context')
  const bytes = new TextEncoder().encode(JSON.stringify({news:report.evidence_receipt,us}))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('')
}
const pending = (rows: Awaited<ReturnType<typeof loadPendingBuySnapshot>>['pendingBuys']) => rows.some(item =>
  (item.debate_verdict ?? 'PENDING') === 'PENDING' || (item.debate_status ?? 'pending') === 'pending')

const defaultDependencies = {
  singlePlanContext,dispatchSinglePlan,finalizeSinglePlan,ensurePaperCorporateSource,
  contextIdentity, fetchAndStoreUSLeading, runDailyNewsAnalysis, getPrevTradingDay,
  recoverPaperMorningSetup, loadPendingBuySnapshot, reconcilePendingBuyDebates,
  setupMorningPendingBuys, flushL4Replans, readL4PortfolioPlan, getTradingConfig,
  warmup: async (env: Bindings): Promise<unknown> => {
    const result = await (await import('./cronOrchestrator')).runPreMarketWarmup(env,'setup')
    if (result.startsWith('ERROR:')) throw new Error(result)
    await (await import('./localMaintenance')).runMorningWarmup(env, { healthProbe: false })
    return result
  },
  marketHealth: async (env: Bindings) => (await import('./cronOrchestrator')).runPreMarketWarmup(env,'market'),
  settle: async (env: Bindings) => (await import('./cronOrchestrator')).settlePaperT2(env),
}

export function premarketWork(env: Bindings, date: string, overrides: Partial<typeof defaultDependencies> = {}): PremarketWork {
  const deps = { ...defaultDependencies, ...overrides }
  return async (stage,input,assertOwner) => {
    const guard = async () => {
      await assertOwner()
      if (!dailyPlanOwner(env) && stage !== 'context' && input.context_hash !== await deps.contextIdentity(env,date))
        throw new Error('premarket_context_changed_requires_review')
    }
    await guard()
    if (stage === 'context') {
      const us = await deps.fetchAndStoreUSLeading(env)
      if (!isReadyUSSignal(us,date)) throw new Error('premarket_wait:us-leading')
      await deps.runDailyNewsAnalysis(env)
      const signalDate = await deps.getPrevTradingDay(databaseForDataDomain(env,'core'),env.KV,date)
      if(dailyPlanOwner(env))return {next:'setup',receipt:await deps.singlePlanContext(env,date,signalDate)}
      const source = await databaseForDataDomain(env,'ops').prepare(`SELECT status FROM pipeline_stage_runs
        WHERE business_date=? AND stage='pipeline_execution'`).bind(signalDate).first<{status:string}>()
      if (source?.status !== 'success') throw new Error('premarket_wait:evening_pipeline')
      return {next:'setup',receipt:{context_hash:await deps.contextIdentity(env,date),signal_date:signalDate}}
    }
    if (stage === 'market-health') {
      const summary = await deps.marketHealth(env)
      if (summary.startsWith('ERROR:')) throw new Error(summary)
      return {next:null,receipt:{...input,market_health:summary}}
    }
    if (stage === 'setup') {
      const warmup = await deps.warmup(env)
      await guard()
      if(dailyPlanOwner(env)) {
        await deps.ensurePaperCorporateSource(env,date); await deps.settle(env)
        return {next:'allocate',followups:['market-health'],receipt:{...input,warmup}}
      }
      await deps.recoverPaperMorningSetup(env,date,deps.settle)
      return {next:'debate:0',followups:['market-health'],receipt:{...input,warmup}}
    }
    if(stage==='allocate') {
      if(!dailyPlanOwner(env))throw new Error('premarket_owner_mismatch')
      const planId=await deps.dispatchSinglePlan(env,input)
      await guard()
      await deps.recoverPaperMorningSetup(env,date,deps.settle)
      return {next:'publish:0',receipt:{...input,plan_id:planId}}
    }
    const round = Number(stage.split(':')[1])
    if (stage.startsWith('debate:')) {
      if (dailyPlanOwner(env)) {
        const summary = await deps.reconcilePendingBuyDebates(env,date).catch((error) =>
          `debate_observation_failed=${error instanceof Error ? error.message : String(error)}`)
        return {next:null,receipt:{...input,advisory_debate:summary}}
      }
      const summary = await deps.reconcilePendingBuyDebates(env,date)
      const state = await deps.loadPendingBuySnapshot(env,date,{allowFallbackRecent:false})
      if (pending(state.pendingBuys) || /status=pending|debate_retry_pending=|failed=[1-9]/.test(summary))
        throw new Error(`premarket_wait:debate:${summary}`)
      await guard()
      return {next:`replan:${round}`,receipt:{...input,debate_summary:summary,debated_plan_id:(await deps.readL4PortfolioPlan(env))?.plan_id ?? null}}
    }
    if (stage.startsWith('replan:')) {
      if(dailyPlanOwner(env))return {next:'publish:0',receipt:input}
      const cfg = await deps.getTradingConfig(env.KV)
      if (cfg.l4Distribution && !await deps.flushL4Replans(env,String(input.signal_date)))
        throw new Error('premarket_l4_replan_delivery_failed')
      await guard()
      return {next:`publish:${round}`,receipt:input}
    }
    if(dailyPlanOwner(env)) {
      await guard()
      return {next:'debate:0',receipt:await deps.finalizeSinglePlan(env,date,input)}
    }
    const cfg = await deps.getTradingConfig(env.KV)
    let state = await deps.loadPendingBuySnapshot(env,date,{allowFallbackRecent:false})
    let publishedPlanId: string | null = null
    if (cfg.l4Distribution) {
      const plan = await deps.readL4PortfolioPlan(env)
      if (!plan || plan.signal_date !== input.signal_date) throw new Error('premarket_wait:l4_plan')
      publishedPlanId = plan.plan_id
      const planMismatch = state.pendingBuys.length > 0
        ? state.pendingBuys.some(item => planIdFromWatchPoints(item.watch_points) !== plan.plan_id)
        : input.debated_plan_id !== plan.plan_id
      if (planMismatch) {
        await guard()
        await deps.setupMorningPendingBuys(env)
        state = await deps.loadPendingBuySnapshot(env,date,{allowFallbackRecent:false})
      }
    }
    if (pending(state.pendingBuys)) {
      if (round >= 2) throw new Error('premarket_new_candidates_review_rounds_exhausted')
      return {next:`debate:${round+1}`,receipt:input}
    }
    // Empty/halted are explicit outcomes; never mistake a missing/error snapshot for readiness.
    if (!['ready','empty','halted'].includes(String(state.meta?.status))) throw new Error('premarket_wait:pending_publication')
    await guard()
    if (cfg.l4Distribution && (await deps.readL4PortfolioPlan(env))?.plan_id !== publishedPlanId)
      throw new Error('premarket_wait:l4_head_changed')
    return {next:null,receipt:{...input,ready:true,pending_status:state.meta?.status,
      pending_run_id:state.meta?.run_id,plan_id:publishedPlanId,symbols:state.pendingBuys.map(row=>row.symbol)}}
  }
}
