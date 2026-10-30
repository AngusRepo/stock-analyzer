/** Verify the published plan against D1 without waiting for after-close research. */
import type { Bindings } from '../types'
import type { L4PortfolioPlan } from './l4PortfolioPlan'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'

type Source = {run_id:string;run_date:string;checksum:string}
type Context = {trade_date:string;checksum:string}
export type ServingPublication = {
  schema_version:string;checksum:string;run_id:string;signal_date:string;trade_date:string;
  context_checksum:string;l3_checksum:string;plan_id:string;policy_identity:string;
  allocation_snapshot_id:string;target_count:number;closure:Record<string,unknown>;
}
type Manifest = {source_run_id:string;signal_date:string;snapshot_kind:string}
type Row = {symbol:string;alpha_allocation:string|null}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}'
  return JSON.stringify(value)
}
export async function verifyPublicationReceipt(input:{publication:ServingPublication;source:Source;context:Context;
  plan:L4PortfolioPlan;storedSnapshot:string;manifest:Manifest|null;rows:Row[]}):Promise<void> {
  const {publication:p,source,context,plan,manifest,rows}=input
  const {checksum,...body}=p
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(body)))))
    .map(x=>x.toString(16).padStart(2,'0')).join('')
  if(hash!==checksum || p.schema_version!=='premarket-serving-publication-v1'
    || p.run_id!==source.run_id || p.signal_date!==source.run_date || p.l3_checksum!==source.checksum
    || p.context_checksum!==context.checksum || p.trade_date!==context.trade_date
    || plan.execution_scope!=='paper' || plan.signal_date!==p.signal_date || plan.plan_id!==p.plan_id
    || plan.policy_identity!==p.policy_identity || input.storedSnapshot!==p.allocation_snapshot_id
    || manifest?.source_run_id!==source.run_id || manifest.signal_date!==source.run_date
    || manifest.snapshot_kind!=='allocation_context')throw new Error('premarket_serving_receipt_identity_mismatch')
  // The plan carries every served row (unselected rows keep weight 0), so the plan,
  // the receipt closure and the D1 readback must describe the same row set.
  const c=p.closure, count=Object.keys(plan.targets).length
  if(!count || p.target_count!==count
    || typeof c.predictions_written!=='number' || c.predictions_written<=0
    || c.prediction_symbol_closure_passed!==true || c.incomplete_active_model_symbols!==0
    || c.prediction_seed_symbols!==c.prediction_symbols
    || c.recommendation_seed_rows!==rows.length || c.recommendation_closed_rows!==rows.length
    || c.recommendation_row_closure_passed!==true || !rows.length || !unservedTargetsAreHoldings(plan,rows)
    || new Set(rows.map(r=>r.symbol)).size!==rows.length)throw new Error('premarket_serving_receipt_closure_mismatch')
  for(const row of rows) {
    const allocation=JSON.parse(row.alpha_allocation ?? 'null'), target=plan.targets[row.symbol]
    if(!target || !allocation || allocation.plan_id!==plan.plan_id || allocation.policy_identity!==plan.policy_identity
      || allocation.expected_return_owner!=='l4_distribution' || allocation.engine!=='sparse_tangent_inverse_risk'
      || typeof allocation.allocation_weight!=='number' || !Number.isFinite(allocation.allocation_weight)
      || Math.abs(allocation.allocation_weight-target.weight)>1e-10)
      throw new Error('premarket_serving_receipt_plan_readback_mismatch')
  }
}

/** The plan also carries held names outside the seed: a target without a recommendation row must be a locked holding. */
function unservedTargetsAreHoldings(plan:L4PortfolioPlan,rows:Row[]):boolean {
  const served=new Set(rows.map(r=>r.symbol))
  return Object.entries(plan.targets).every(([symbol,t])=>served.has(symbol) || (t.locked===true && t.current_weight>0))
}

export async function verifyStoredPublication(env:Bindings,input:{publication:ServingPublication;source:Source;context:Context;plan:L4PortfolioPlan}) {
  const stored=await paperDomainDatabase(env).prepare(
    'SELECT allocation_snapshot_id FROM l4_portfolio_plans_v1 WHERE plan_id=? AND account_id=1 AND activated=1')
    .bind(input.plan.plan_id).first<{allocation_snapshot_id:string}>()
  if(!stored)throw new Error('premarket_serving_receipt_plan_missing')
  const [manifest,result]=await Promise.all([
    databaseForDataDomain(env,'learning').prepare(
      'SELECT source_run_id,signal_date,snapshot_kind FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?')
      .bind(stored.allocation_snapshot_id).first<Manifest>(),
    databaseForDataDomain(env,'core').prepare('SELECT symbol,alpha_allocation FROM daily_recommendations WHERE date=?')
      .bind(input.source.run_date).all<Row>(),
  ])
  await verifyPublicationReceipt({...input,storedSnapshot:stored.allocation_snapshot_id,manifest,rows:result.results ?? []})
}
