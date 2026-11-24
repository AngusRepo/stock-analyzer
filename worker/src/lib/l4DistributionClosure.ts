import type { Bindings } from '../types'
import type { AllocatorSnapshotClosure } from './allocatorEvDailyLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { readL4PortfolioPlan, type L4PortfolioPlan } from './l4PortfolioPlan'
import { paperDomainDatabase } from './paperDomainDatabase'

/** New owner evidence: exact original recommendation set and its sealed plan. */
export async function inspectL4DistributionClosure(env:Bindings,day:string,superseded?:L4PortfolioPlan):Promise<AllocatorSnapshotClosure> {
  const plan=superseded ?? await readL4PortfolioPlan(env)
  const {results:rows}=await databaseForDataDomain(env,'core').prepare('SELECT symbol,alpha_allocation,has_buy_signal,eligible_for_pending_buy FROM daily_recommendations WHERE date=?')
    .bind(day).all<{symbol:string;alpha_allocation:string;has_buy_signal:number;eligible_for_pending_buy:number}>()
  const allocations=rows.map(row=>{try{return {...row,alpha:JSON.parse(row.alpha_allocation)}}catch{return {...row,alpha:null}}})
  const ids=[...new Set(allocations.filter(r=>r.alpha?.expected_return_owner==='l4_distribution').map(r=>r.alpha.plan_id))]
  const original=ids.length===1 ? await readL4PortfolioPlan(env,ids[0]):null
  const counts=allocations.filter(row=>original && row.alpha?.expected_return_owner==='l4_distribution'
    && row.alpha?.plan_id===original.plan_id && original.targets[row.symbol]!=null).length
  const source=original ? await paperDomainDatabase(env).prepare('SELECT allocation_snapshot_id FROM l4_portfolio_plans_v1 WHERE plan_id=?')
    .bind(original.plan_id).first<{allocation_snapshot_id:string}>():null
  const frozen=source ? await databaseForDataDomain(env,'learning').prepare('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?')
    .bind(source.allocation_snapshot_id).first<{snapshot_id:string}>():null
  const expected=original ? Object.entries(original.targets).filter(([,target])=>target.expected_return_gross!==null).map(([symbol])=>symbol):[]
  const excludedValid=allocations.filter(row=>!expected.includes(row.symbol)).every(row=>row.alpha?.expected_return_owner==='risk_abstention'
    && row.has_buy_signal===0 && row.eligible_for_pending_buy===0)
  const ready=Boolean(original && plan && plan.signal_date===day && original.signal_date===day && plan.policy_identity===original.policy_identity
    && (!superseded || original.plan_id===superseded.plan_id)
    && expected.length>0 && counts===expected.length && expected.every(symbol=>allocations.some(row=>row.symbol===symbol)) && excludedValid && frozen)
  return {businessDate:day,recommendationRows:rows.length,recommendationMaxCreatedAt:null,nativeLineageRows:counts,
    runNativeLineageRows:counts,reconstructedLineageRows:0,rejectedLineageRows:Math.max(0,expected.length-counts),
    snapshotRunId:source?.allocation_snapshot_id ?? null,expectedRows:expected.length,publishedRows:counts,actualRows:counts,
    snapshotMaxGeneratedAt:null,ready}
}

/** A late repair names the day's own activated plan; the current head must descend from it via the named successor. */
async function readSupersededL4Plan(env:Bindings,receipt:Record<string,unknown>,day:string):Promise<L4PortfolioPlan|null> {
  const {superseded_by_plan_id:by,superseded_by_signal_date:byDate}=receipt
  if (typeof receipt.plan_id!=='string' || typeof by!=='string' || typeof byDate!=='string' || !(byDate>day)) return null
  const original=await readL4PortfolioPlan(env,receipt.plan_id)
  const {results:same}=await paperDomainDatabase(env).prepare('SELECT plan_id FROM l4_portfolio_plans_v1 WHERE account_id=1 AND signal_date=? AND activated=1')
    .bind(day).all<{plan_id:string}>()
  if (!original || original.signal_date!==day || same.length!==1 || same[0].plan_id!==original.plan_id) return null
  let successor=await readL4PortfolioPlan(env)
  while (successor && successor.signal_date>day && successor.parent_plan_id!==original.plan_id) {
    const parent:L4PortfolioPlan|null=successor.parent_plan_id ? await readL4PortfolioPlan(env,successor.parent_plan_id) : null
    successor=parent && parent.signal_date<=successor.signal_date ? parent : null
  }
  return successor && successor.signal_date>day && successor.plan_id===by && successor.signal_date===byDate ? original : null
}

/** New daily closure cannot be relabeled as old OOF freshness credit. */
export async function verifyL4DailyClosure(env:Bindings,receipt:Record<string,unknown>,day:string) {
  const cfg=await env.KV.get('trading:config','json') as {l4Distribution?:{artifact?:{model_checksum?:string}}}|null
  const superseded='superseded_by_plan_id' in receipt || 'superseded_by_signal_date' in receipt
  const plan=superseded ? await readSupersededL4Plan(env,receipt,day) : await readL4PortfolioPlan(env)
  if (!cfg?.l4Distribution || receipt.schema_version!=='l4-daily-plan-closure-v1'
    || receipt.signal_date!==day || receipt.legacy_oof_maturity_requested!==false || receipt.training_dispatched!==false
    || !plan || plan.signal_date!==day || receipt.plan_id!==plan.plan_id || receipt.model_checksum!==plan.model_checksum
    || plan.model_checksum!==cfg.l4Distribution.artifact?.model_checksum)
    throw new Error('l4_daily_identity_mismatch')
  if (!(await inspectL4DistributionClosure(env,day,superseded ? plan : undefined)).ready) throw new Error('l4_daily_recommendations_incomplete')
  const {refreshExpectedReturnServingState,readCurrentExpectedReturnServingState}=await import('./expectedReturnServingState')
  // A late repair must not rewrite the stored serving state with an older run date.
  const serving=superseded ? await readCurrentExpectedReturnServingState(env,day) : await refreshExpectedReturnServingState(env,day)
  if (serving.expected_return_owner!=='l4_distribution') throw new Error('l4_daily_serving_identity_mismatch')
  return {status:'verified',scope:'new_l4_plan_and_account_closure',legacy_oof_maturity_credit:0}
}
