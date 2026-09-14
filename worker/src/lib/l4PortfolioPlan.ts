import { l4ReleaseEvidenceError } from './l4ReleaseEvidence'
import { privateL4ResearchAllowed } from './paperExecutionScope'
import type { Bindings } from '../types'
import type { FiveSlotDecision, FiveSlotHolding } from './fiveSlotCapitalAllocator'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'

export interface L4PortfolioPlan {
  execution_scope?: 'paper' | 'private_research'
  schema_version: 'l4-portfolio-plan-v1'
  owner: 'l4_distribution'
  account_anchor: {order_watermark:number;cash:number;positions:Array<{symbol:string;shares:number}>;settlement:{unsettledBuyAmount:number;unsettledSellAmount:number}}
  parent_plan_id: string | null
  plan_id: string
  policy_identity: string
  model_checksum: string
  signal_date: string
  account_id: number
  l3_identity?: Record<string,string>
  nav_at_decision: number
  weights: Record<string, number>
  targets: Record<string, { weight: number; current_weight: number; locked: boolean; expected_return_gross: number | null }>
  constraints: { exposure_cap: number; name_cap: number; min_weight: number; max_positions: number | null; name_caps?: Record<string,number>; exposure_groups?: Record<string,{symbols:string[];cap:number;effective_cap:number;locked_inherited_weight:number}> }
  proof: { within_tolerance: boolean; absolute_objective_gap: number; tolerance: number; evaluated_candidate_count: number; preselection: boolean }
  opb: { enabled: boolean; status: string; arm_id: string }
}

function amount(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

export function validateL4PortfolioPlan(raw: unknown): L4PortfolioPlan {
  const plan = raw as L4PortfolioPlan
  if (!plan || plan.schema_version !== 'l4-portfolio-plan-v1' || plan.owner !== 'l4_distribution'
    || plan.account_id !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(plan.signal_date)
    || !(plan.parent_plan_id === null || /^[a-f0-9]{64}$/.test(plan.parent_plan_id))
    || !/^[a-f0-9]{64}$/.test(plan.model_checksum)
    || !/^[a-f0-9]{64}$/.test(plan.plan_id) || !/^[a-f0-9]{64}$/.test(plan.policy_identity)
    || !amount(plan.nav_at_decision) || plan.nav_at_decision <= 0 || !plan.targets || !plan.weights
    || plan.proof?.within_tolerance !== true || plan.proof.preselection !== false
    || !amount(plan.proof.absolute_objective_gap) || plan.proof.absolute_objective_gap < 0
    || !amount(plan.proof.tolerance) || plan.proof.tolerance <= 0 || plan.proof.tolerance > 1e-8
    || plan.proof.absolute_objective_gap > plan.proof.tolerance) throw new Error('l4_plan_contract_invalid')
  const entries = Object.entries(plan.targets)
  const c = plan.constraints
  if (!c || !amount(c.exposure_cap) || c.exposure_cap < 0 || c.exposure_cap > 1
    || !amount(c.name_cap) || c.name_cap < 0 || c.name_cap > 1
    || !amount(c.min_weight) || c.min_weight < 0 || c.min_weight > 1
    || (c.max_positions !== null && (!Number.isSafeInteger(c.max_positions) || c.max_positions < 1))
    || entries.length !== Object.keys(plan.weights).length || entries.length !== plan.proof.evaluated_candidate_count)
    throw new Error('l4_plan_constraints_invalid')
  let sum = 0, count = 0
  for (const [symbol, target] of entries) {
    if (!symbol || !amount(target.weight) || !amount(target.current_weight) || target.current_weight < 0
      || target.weight < 0 || target.weight !== plan.weights[symbol]
      || (target.weight > Math.min(c.name_cap,c.name_caps?.[symbol] ?? 1) + 1e-8 && !target.locked)
      || (target.weight > 1e-7 && target.weight < c.min_weight - 1e-8 && !target.locked)
      || (target.locked && Math.abs(target.weight - target.current_weight) > 1e-8))
      throw new Error('l4_plan_target_invalid')
    sum += target.weight
    if (target.weight > 1e-7) count++
  }
  for (const [id,group] of Object.entries(c.exposure_groups ?? {})) {
    if (!id || !Array.isArray(group.symbols) || !group.symbols.length
      || new Set(group.symbols).size!==group.symbols.length
      || group.symbols.some(symbol=>!Object.hasOwn(plan.targets,symbol))
      || !amount(group.cap) || group.cap<0 || group.cap>1
      || !amount(group.effective_cap) || !amount(group.locked_inherited_weight))
      throw new Error('l4_plan_exposure_group_invalid')
    const locked=group.symbols.reduce((total,symbol)=>total+(plan.targets[symbol].locked?plan.targets[symbol].current_weight:0),0)
    const exposure=group.symbols.reduce((total,symbol)=>total+plan.weights[symbol],0)
    if (Math.abs(group.locked_inherited_weight-locked)>1e-8
      || Math.abs(group.effective_cap-Math.max(group.cap,locked))>1e-8
      || exposure>group.effective_cap+1e-8) throw new Error('l4_plan_group_limit_exceeded')
  }
  if (sum > c.exposure_cap + 1e-8 || (c.max_positions !== null && count > c.max_positions))
    throw new Error('l4_plan_portfolio_limit_exceeded')
  return plan
}

export async function storeL4PortfolioPlan(env: Bindings, raw: unknown) {
  const envelope = raw as { plan: unknown; canonical_payload: string; allocation_snapshot_id: string }
  if (!/^[a-f0-9]{64}$/.test(envelope?.allocation_snapshot_id)) throw new Error('l4_plan_source_snapshot_missing')
  const plan = validateL4PortfolioPlan(envelope.plan)
  if (plan.execution_scope==='private_research' && !privateL4ResearchAllowed(env.KV)) throw new Error('l4_private_plan_cannot_publish')
  if (typeof envelope.canonical_payload !== 'string') throw new Error('l4_plan_canonical_payload_missing')
  const sealed = JSON.parse(envelope.canonical_payload)
  // Compare parsed values, not JSON number formatting across Python/JavaScript.
  function stable(value: any): string {
    if (Array.isArray(value)) return '['+value.map(stable).join(',')+']'
    if (value !== null && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}'
    return JSON.stringify(value)
  }
  const { plan_id, ...unsigned } = plan
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(envelope.canonical_payload))))
    .map(b=>b.toString(16).padStart(2,'0')).join('')
  if (checksum !== plan_id || stable(sealed) !== stable(unsigned)) throw new Error('l4_plan_checksum_mismatch')
  const db = paperDomainDatabase(env)
  const payload = JSON.stringify(plan)
  const anchor=plan.account_anchor
  if (!anchor || !Number.isSafeInteger(anchor.order_watermark) || !amount(anchor.cash) || !Array.isArray(anchor.positions)) throw new Error('l4_plan_account_anchor_missing')
  await db.batch([
    db.prepare('INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,allocation_snapshot_id,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(plan_id) DO NOTHING')
      .bind(plan_id, plan.account_id, plan.signal_date, plan.policy_identity, envelope.allocation_snapshot_id, payload),
    db.prepare(`UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1 AND plan_id IS ?
      AND EXISTS(SELECT 1 FROM l4_portfolio_plans_v1 WHERE plan_id=? AND payload_json=? AND allocation_snapshot_id=?)
      AND NOT EXISTS(SELECT 1 FROM paper_order_intents WHERE account_id=1 AND status='running')
      AND NOT EXISTS(SELECT 1 FROM paper_exit_intents WHERE account_id=1 AND state='SUBMITTING')
      AND (SELECT COALESCE(MAX(id),0) FROM paper_orders WHERE account_id=1)=?
      AND (SELECT cash FROM paper_accounts WHERE id=1)=?
      AND (SELECT COUNT(*) FROM paper_positions WHERE account_id=1 AND shares>0)=json_array_length(?)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN paper_positions p ON p.account_id=1 AND p.symbol=json_extract(j.value,'$.symbol')
        WHERE p.shares IS NULL OR p.shares<>json_extract(j.value,'$.shares'))
      AND (SELECT COALESCE(SUM(amount),0) FROM paper_settlements WHERE account_id=1 AND settled=0 AND side='buy')=?
      AND (SELECT COALESCE(SUM(amount),0) FROM paper_settlements WHERE account_id=1 AND settled=0 AND side='sell')=?`)
      .bind(plan_id, plan.parent_plan_id, plan_id, payload, envelope.allocation_snapshot_id,anchor.order_watermark,
        anchor.cash,JSON.stringify(anchor.positions),JSON.stringify(anchor.positions),anchor.settlement.unsettledBuyAmount,anchor.settlement.unsettledSellAmount),
    db.prepare('UPDATE l4_portfolio_plans_v1 SET activated=1 WHERE plan_id=? AND EXISTS(SELECT 1 FROM l4_portfolio_head_v1 WHERE plan_id=?)').bind(plan_id,plan_id),
  ])
  const saved = await db.prepare('SELECT payload_json,allocation_snapshot_id FROM l4_portfolio_plans_v1 WHERE plan_id=?')
    .bind(plan_id).first<{ payload_json: string; allocation_snapshot_id: string }>()
  if (!saved || saved.payload_json !== payload || saved.allocation_snapshot_id !== envelope.allocation_snapshot_id)
    throw new Error('l4_plan_immutable_conflict')
  const head = await db.prepare('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1').first<{ plan_id: string }>()
  if (head?.plan_id !== plan_id) throw new Error('l4_plan_concurrent_change_retry')
  return { status: 'stored', plan_id }
}

export async function readL4PortfolioPlan(env: Bindings, planId?: string): Promise<L4PortfolioPlan | null> {
  const db = paperDomainDatabase(env)
  const statement = planId
    ? db.prepare('SELECT payload_json FROM l4_portfolio_plans_v1 WHERE plan_id=? AND account_id=1 AND activated=1').bind(planId)
    : db.prepare('SELECT p.payload_json FROM l4_portfolio_head_v1 h JOIN l4_portfolio_plans_v1 p ON p.plan_id=h.plan_id WHERE h.account_id=1')
  const row = await statement.first<{ payload_json: string }>()
  return row ? validateL4PortfolioPlan(JSON.parse(row.payload_json)) : null
}

export function planIdFromWatchPoints(points: unknown): string | null {
  if (!Array.isArray(points)) return null
  const ids = points.filter((s): s is string => typeof s === 'string' && s.startsWith('l4_plan:'))
    .map(s => s.slice('l4_plan:'.length))
  if (ids.length === 0) return null
  if (new Set(ids).size !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) throw new Error('l4_plan_reference_invalid')
  return ids[0]
}

/** Reconcile the same target against actual fills. Never score or replace names. */
export function l4TargetExecutionDecision(input: {
  plan: L4PortfolioPlan; symbol: string; holdings: FiveSlotHolding[]; nav: number; cash: number;
  dailyRemaining: number; riskExposureCap: number; nameCap: number; maxPositions: number;
  hardVeto: boolean; reservedCash?: number; feeRate: number; minCommission: number;
}): FiveSlotDecision {
  const p = validateL4PortfolioPlan(input.plan)
  const target = p.targets[input.symbol]
  const value = (h: FiveSlotHolding) => h.shares * Number(h.lastPrice ?? h.avgCost)
  if (input.nav <= 0 || input.cash < 0 || input.feeRate < 0 || input.minCommission < 0
    || !Number.isSafeInteger(input.maxPositions) || input.maxPositions < 1) throw new Error('l4_execution_limits_invalid')
  if (![input.nav, input.cash, input.dailyRemaining, input.riskExposureCap, input.nameCap,
    input.feeRate, input.minCommission, input.reservedCash ?? 0, ...input.holdings.map(value)].every(amount))
    throw new Error('l4_execution_account_invalid')
  const held = input.holdings.find(h => h.symbol === input.symbol)
  const current = held ? value(held) : 0
  const invested = input.holdings.reduce((sum, h) => sum + value(h), 0)
  const targetValue = Math.max(0, Math.min(target?.weight ?? 0, input.nameCap) * input.nav)
  const exposure = Math.min(p.constraints.exposure_cap, input.riskExposureCap)
  const free = Math.max(0, input.cash - (input.reservedCash ?? 0))
  const groupRemaining = Object.values(p.constraints.exposure_groups ?? {}).filter(group=>group.symbols.includes(input.symbol))
    .map(group=>group.effective_cap*input.nav-input.holdings.filter(h=>group.symbols.includes(h.symbol)).reduce((sum,h)=>sum+value(h),0))
  const grossBudget = Math.max(0, Math.min(...groupRemaining,targetValue-current, exposure*input.nav-invested, input.dailyRemaining,
    free/(1+input.feeRate), free-input.minCommission))
  const full = !held && input.holdings.filter(h => h.shares>0).length >= input.maxPositions
  const blocked = !target || target.locked || input.hardVeto || full || grossBudget<=0
  return { symbol: input.symbol, action: blocked ? 'skip' : held ? 'add' : 'buy',
    reason: !target ? 'l4_target_missing' : target.locked ? 'l4_target_locked' : input.hardVeto ? 'l4_hard_risk_veto'
      : full ? 'l4_unsold_position_capacity' : grossBudget<=0 ? 'l4_target_met_or_cash_reserved' : 'l4_target_reconciliation',
    budgetCap: blocked ? 0 : grossBudget, targetPositionValue: targetValue, currentPositionValue: current,
    targetExposure: exposure, targetSlotValue: targetValue, confidenceMultiplier: 1,
    slotFloorRatio: 0, slotFloorBudget: 0, slotFloorReasons: [], replaceSymbol: null }
}

export function planIdFromAllocation(raw: unknown): string | null {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!value || typeof value !== 'object' || (value as any).expected_return_owner !== 'l4_distribution') return null
  const id = (value as any).plan_id
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('l4_plan_reference_missing')
  return id
}

export function l4TargetExitShares(input: {
  plan: L4PortfolioPlan; symbol: string; shares: number; price: number; nav: number; minTradeValue: number;
}): number {
  const target = validateL4PortfolioPlan(input.plan).targets[input.symbol]
  if (!target || target.locked) return 0
  if (!Number.isSafeInteger(input.shares) || input.shares < 0 || !amount(input.price) || input.price <= 0
    || !amount(input.nav) || input.nav <= 0) throw new Error('l4_target_exit_units_invalid')
  if (target.weight === 0) return input.shares
  const desiredShares = Math.floor(input.nav * target.weight / input.price)
  const reduction = Math.max(0, input.shares-desiredShares)
  return reduction * input.price >= input.minTradeValue ? reduction : 0
}

/** A model/config cutover invalidates old targets without disabling hard exits. */
export async function assertL4PlanCurrentPolicy(env: Bindings, plan: L4PortfolioPlan, config: { l4Distribution?: { artifact: Record<string,unknown>; opb?: Record<string,unknown> } }) {
  if (plan.execution_scope==='private_research' && !privateL4ResearchAllowed(env.KV)) throw new Error('l4_private_plan_cannot_execute')
  const artifact=config.l4Distribution?.artifact as any
  if (!artifact || artifact.model_checksum!==plan.model_checksum) throw new Error('l4_plan_config_model_changed')
  if (plan.execution_scope!=='private_research') {
    const error=l4ReleaseEvidenceError(artifact); if (error) throw new Error(error)
  }
  if (config.l4Distribution?.opb?.enabled===true && config.l4Distribution.opb.approved_policy_identity!==plan.policy_identity) throw new Error('l4_plan_policy_changed')
  const pointer=await databaseForDataDomain(env,'learning').prepare(
    'SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum FROM active8_ensemble_pointer_v1 WHERE singleton_id=1')
    .first<Record<string,string>>()
  if (!pointer || !['artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum'].every(k=>
    pointer[k]===artifact.l3_identity?.[k] && pointer[k]===plan.l3_identity?.[k])) throw new Error('l4_plan_paired_l3_changed')
}

/** Targets include held names; only a positive target gap belongs in buy debate. */
export function l4HasTargetBuyGap(plan: L4PortfolioPlan, symbol: string, actual?:{nav:number;shares:number;price:number}): boolean {
  const target=plan.targets[symbol]
  if (!target || target.locked) return false
  if (actual) {
    if (![actual.nav,actual.shares,actual.price].every(amount) || actual.nav<=0 || actual.price<=0
      || !Number.isSafeInteger(actual.shares) || actual.shares<0) throw new Error('l4_buy_gap_account_invalid')
    return Math.floor(target.weight*actual.nav/actual.price)>actual.shares
  }
  return target.weight>target.current_weight+1e-7
}
