import type { Bindings } from '../types'
import { databaseForTable } from './dataDomainRegistry'
import { ensurePaperCorporateSource } from './paperCorporateSource'
import { setupMorningPendingBuys } from './pendingBuyOrchestrator'

/** The preopen retry shares the original settlement/setup owners. An empty or
 * halted run is a valid decision, not permission to replace that decision. */
export async function recoverPaperMorningSetup(
  env: Bindings,
  sessionDate: string,
  settle: (env: Bindings) => Promise<void>,
  dependencies = { source: ensurePaperCorporateSource, setup: setupMorningPendingBuys },
): Promise<string> {
  await dependencies.source(env, sessionDate)
  await settle(env)
  const run = await databaseForTable(env, 'pending_buy_runs').prepare(
    `SELECT status FROM pending_buy_runs WHERE trade_date=? AND status!='superseded' ORDER BY id DESC LIMIT 1`,
  ).bind(sessionDate).first<{ status: string }>()
  if (run && ['ready', 'empty', 'halted'].includes(run.status)) return 'preserved_existing_decision'
  if (run && run.status !== 'error') throw new Error('paper_morning_recovery_unknown_run_status')
  await dependencies.setup(env)
  const repaired = await databaseForTable(env, 'pending_buy_runs').prepare(
    `SELECT status FROM pending_buy_runs WHERE trade_date=? AND status!='superseded' ORDER BY id DESC LIMIT 1`,
  ).bind(sessionDate).first<{ status: string }>()
  if (!repaired || !['ready', 'empty', 'halted'].includes(repaired.status)) {
    throw new Error('paper_morning_recovery_setup_not_materialized')
  }
  return 'recovered_missing_morning_decision'
}
