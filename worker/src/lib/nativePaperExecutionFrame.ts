import { runIntradayCheck } from './paperEntryTasks'
import { runEODExit } from './paperExitTasks'
import { runDailySnapshot } from './paperWorkerTasks'
import { withPaperExecutionScope, paperExecutionDate, type PaperExecutionPorts } from './paperExecutionScope'
import { settlePaperT2 } from './paperSettlementTasks'
import { setupMorningPendingBuys, reconcilePendingBuyDebates } from './pendingBuyOrchestrator'
import { runIntradayRescore } from './paperRescoreTasks'
import { twToday } from './dateUtils'
import { refreshOpenPositionPostClosePriceCache } from './paperIntradayPriceCache'

export type NativePaperStage = 'settlement' | 'morning' | 'preopen' | 'intraday' | 'rescore' | 'eod' | 'postclose' | 'snapshot'

export interface NativePaperFramePorts extends PaperExecutionPorts {
  transaction: <T>(execute: () => Promise<T>) => Promise<T>
}

/** Executes the original native workflow, never a parallel fill implementation.
 * The host must provide a transaction over its private stores and publish only
 * after this frame succeeds. A frame is not an entire-session receipt.
 */
export async function runNativePaperExecutionFrame(ports: NativePaperFramePorts, stage: NativePaperStage, context: { cron?: string; scheduledAt?: string } = {}) {
  return ports.transaction(() => withPaperExecutionScope(ports, async () => {
    const env = ports.environment
    const paperDb = ports.databases.paper
    if (!paperDb) throw new Error('native_paper_private_store_missing')
    const account = await paperDb.prepare('SELECT id FROM paper_accounts WHERE id=?')
      .bind(ports.accountId).first()
    if (!account) throw new Error('native_paper_account_missing')
    const before = await paperDb.prepare('SELECT COALESCE(MAX(id),0) AS id FROM paper_orders WHERE account_id=?')
      .bind(ports.accountId).first<{ id: number }>()
    let valuation: Awaited<ReturnType<typeof runDailySnapshot>>['valuation'] | undefined
    switch (stage) {
      case 'settlement': await settlePaperT2(env); break
      case 'morning': await setupMorningPendingBuys(env); break
      case 'preopen': await reconcilePendingBuyDebates(env, twToday()); break
      case 'rescore': {
        if (!context.cron) throw new Error('native_paper_rescore_cron_missing')
        await runIntradayRescore(env, context.cron, twToday())
        break
      }
      case 'intraday': {
        const result = await runIntradayCheck(env)
        if (!['healthy_empty', 'ok'].includes(result.status)) {
          throw new Error('native_paper_intraday_incomplete:' + result.status)
        }
        break
      }
      case 'eod': await runEODExit(env); break
      case 'postclose': {
        const refresh = await refreshOpenPositionPostClosePriceCache(env, { tradeDate: twToday() })
        if (refresh.failed) throw new Error('native_paper_postclose_incomplete')
        break
      }
      case 'snapshot': valuation = (await runDailySnapshot(env, { allowUnpricedRights: true })).valuation; break
      default: throw new Error('native_paper_stage_invalid')
    }
    const { results: orders } = await paperDb.prepare(`SELECT id,symbol,side,shares,price,commission,tax,note,created_at
      FROM paper_orders WHERE account_id=? AND id>? ORDER BY id`).bind(ports.accountId, before?.id ?? 0).all()
    return { stage, account_id: ports.accountId, observed_at: new Date(context.scheduledAt ?? ports.nowMs).toISOString(),
      started_at: new Date(ports.nowMs).toISOString(), completed_at: paperExecutionDate().toISOString(),
      orders: orders ?? [], valuation, session_complete: false, nav_maturity_credit: 0 }
  }))
}
