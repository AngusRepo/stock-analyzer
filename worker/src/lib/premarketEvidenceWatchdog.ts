import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { fetchAndStoreUSLeading, isReadyUSSignal } from './usLeading'
import { readCurrentNewsReport, runDailyNewsAnalysis } from './newsAnalyst'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { runPremarketEvidenceStage } from './premarketEvidenceStage'
import { reconcilePendingBuyDebates } from './pendingBuyOrchestrator'

export async function runPremarketEvidenceWatchdog(env: Bindings): Promise<string> {
  const tw = new Date(Date.now() + 8 * 3600_000)
  const date = tw.toISOString().slice(0, 10)
  if (tw.getUTCHours() < 7 || tw.getUTCHours() >= 9) return 'status=skipped premarket_recovery_outside_window'
  try {
    const us = await fetchAndStoreUSLeading(env)
    if (!isReadyUSSignal(us, date)) throw new Error('premarket_wait:us-leading')
    const news = await readCurrentNewsReport(env.KV, date) ?? await runDailyNewsAnalysis(env)
    if (!news) throw new Error('premarket_wait:news-analyst')
    // Continue existing pending debate only. Never rebuild candidates/L3 or run exits here.
    const snapshot = await loadPendingBuySnapshot(env, date, { allowFallbackRecent: false })
    const hasPending = snapshot.pendingBuys.some(item => (item.debate_verdict ?? 'PENDING') === 'PENDING' || (item.debate_status ?? 'pending') === 'pending')
    if (!hasPending) return 'premarket_evidence=ready no_pending_debate'
    const continuation = await runPremarketEvidenceStage(env, date, 'debate-continuation', async () => {
      const complete = await databaseForDataDomain(env, 'ops').prepare(`SELECT 1 AS ok FROM pipeline_stage_runs
        WHERE business_date=? AND stage='premarket_v2:debate-continuation' AND status='success'`).bind(date).first()
      return complete ? 'debate-continuation:already_completed' : null
    }, async assertOwner => {
      await assertOwner()
      const result = await reconcilePendingBuyDebates(env, date)
      if (/debate_retry_pending=|status=pending|\bfailed=[1-9]/.test(result)) throw new Error(`premarket_wait:debate:${result}`)
      return result
    })
    return `premarket_evidence=ready ${continuation}`
  } catch (error) {
    const reason = String(error)
    const terminal = /:error:attempt=3|premarket_lease_lost|premarket_exhausted/.test(reason)
    return `status=${terminal ? 'error' : 'pending'} ${reason.slice(0, 900)}`
  }
}
