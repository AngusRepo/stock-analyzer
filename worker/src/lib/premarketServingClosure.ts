/** Formal Paper publication is independent of failed counterfactual NAV inputs.
 * Never clears the parent error or grants NAV maturity/promotion credit.
 */
import type { Bindings } from '../types'
import type { L4PortfolioPlan } from './l4PortfolioPlan'
import type { SchedulerRunLogEntry } from './schedulerRunLogger'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'

const ATOMIC_INPUT_ERRORS = new Set([
  'paired_nav:atomic_daily:paired_nav_source_or_capture_failed',
  'paired_nav:atomic_candidate_setup:paired_nav_atomic_daily_inputs_missing',
])
export function atomicInputFailureOnly(error: string | null | undefined): boolean {
  const errors = (error ?? '').split(';').map(s=>s.trim()).filter(Boolean)
  return errors.length > 0 && errors.every(e=>ATOMIC_INPUT_ERRORS.has(e))
}

type PublishedRow = {symbol:string; alpha_allocation:string | null}
export function verifyFormalServingClosure(input: {
  runId:string; signalDate:string; error:string; plan:L4PortfolioPlan;
  prediction:SchedulerRunLogEntry | null; recommendation:SchedulerRunLogEntry | null;
  rows:PublishedRow[];
  manifest:{source_run_id:string;signal_date:string;snapshot_kind:string}|null;
}): void {
  const {runId,signalDate,plan,prediction,recommendation,rows} = input
  if (!atomicInputFailureOnly(input.error) || plan.execution_scope !== 'paper'
    || plan.signal_date !== signalDate || !/^[a-f0-9]{64}$/.test(plan.plan_id))
    throw new Error('premarket_formal_publication_not_eligible')
  if(input.manifest?.source_run_id!==runId || input.manifest.signal_date!==signalDate
    || input.manifest.snapshot_kind!=='allocation_context')throw new Error('premarket_formal_snapshot_identity_mismatch')
  for (const [task,log] of [['ml-predict',prediction],['recommendation',recommendation]] as const) {
    if (!log || log.task!==task || log.run_id!==runId || log.run_date!==signalDate
      || log.status!=='error' || !atomicInputFailureOnly(log.error)
      || !log.summary.startsWith(`run_id=${runId} `))
      throw new Error('premarket_formal_callback_identity_missing')
  }
  const ml = /\bsymbols=(\d+)\/(\d+) rows=(\d+) models=(\d+) incomplete_active_model_symbols=0 symbol_closure=True active_model_closure=True(?:\s|$)/.exec(prediction!.summary)
  const reco = /\brecos_updated=(\d+) filtered=\d+ seed_rows=(\d+) closure=True(?:\s|$)/.exec(recommendation!.summary)
  const symbols = Object.keys(plan.targets)
  if (!ml || !reco || Number(ml[1])<=0 || ml[1]!==ml[2] || Number(ml[3])<=0 || Number(ml[4])<=0
    || Number(reco[1])!==Number(ml[1]) || reco[1]!==reco[2] || symbols.length!==Number(ml[1])
    || rows.length!==symbols.length || new Set(rows.map(r=>r.symbol)).size!==symbols.length)
    throw new Error('premarket_formal_output_closure_missing')
  for (const row of rows) {
    const a = JSON.parse(row.alpha_allocation ?? 'null')
    const target=plan.targets[row.symbol]
    if (!target || !a || a.plan_id!==plan.plan_id || a.policy_identity!==plan.policy_identity
      || a.expected_return_owner!=='l4_distribution' || a.engine!=='sparse_tangent_inverse_risk'
      || typeof a.allocation_weight!=='number' || Math.abs(a.allocation_weight-target.weight)>1e-10)
      throw new Error('premarket_formal_plan_readback_mismatch')
  }
}

export async function verifyStoredFormalServing(env:Bindings, input:{runId:string;signalDate:string;error:string;plan:L4PortfolioPlan}) {
  const stored=await paperDomainDatabase(env).prepare('SELECT allocation_snapshot_id FROM l4_portfolio_plans_v1 WHERE plan_id=? AND account_id=1 AND activated=1')
    .bind(input.plan.plan_id).first<{allocation_snapshot_id:string}>()
  if(!stored)throw new Error('premarket_formal_plan_missing')
  const manifest=await databaseForDataDomain(env,'learning').prepare('SELECT source_run_id,signal_date,snapshot_kind FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?')
    .bind(stored.allocation_snapshot_id).first<{source_run_id:string;signal_date:string;snapshot_kind:string}>()
  const [prediction,recommendation,result] = await Promise.all([
    env.KV.get(`scheduler:run:ml-predict:${input.signalDate}`,'json') as Promise<SchedulerRunLogEntry|null>,
    env.KV.get(`scheduler:run:recommendation:${input.signalDate}`,'json') as Promise<SchedulerRunLogEntry|null>,
    databaseForDataDomain(env,'core').prepare('SELECT symbol,alpha_allocation FROM daily_recommendations WHERE date=?')
      .bind(input.signalDate).all<PublishedRow>(),
  ])
  verifyFormalServingClosure({...input,manifest,prediction,recommendation,rows:result.results ?? []})
}
