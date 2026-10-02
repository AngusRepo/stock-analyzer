import { paperExecutionNow } from './paperExecutionScope'
/** A sealed daily execution view; never forges the original optimizer proof. */
import { validateL4PortfolioPlan, type L4PortfolioPlan } from './l4PortfolioPlan'

export interface DailyPlanReview {
  schema: 'paper-daily-review-v1'; tradeDate: string; planId: string; contextHash: string;
  finalizedAtMs: number; weights: Record<string, number>; reasons: Record<string, string[]>;
  revision: number; previousHash: string | null; checksum: string;
}
export type RiskRestriction = { symbol: string; maxWeight: number; reason: string }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function stable(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
async function digest(v: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(v)))))
    .map(v=>v.toString(16).padStart(2,'0')).join('')
}
export function validateDailyReview(plan: L4PortfolioPlan, review: DailyPlanReview): DailyPlanReview {
  validateL4PortfolioPlan(plan)
  if (review.schema !== 'paper-daily-review-v1' || review.planId !== plan.plan_id
    || !/^\d{4}-\d{2}-\d{2}$/.test(review.tradeDate) || review.tradeDate <= plan.signal_date
    || !/^[a-f0-9]{64}$/.test(review.contextHash) || !/^[a-f0-9]{64}$/.test(review.checksum)
    || !Number.isSafeInteger(review.revision) || review.revision < 0
    || (review.revision === 0 ? review.previousHash !== null : !/^[a-f0-9]{64}$/.test(review.previousHash ?? ''))
    || !finite(review.finalizedAtMs) || review.finalizedAtMs < Date.parse(review.tradeDate+'T00:00:00+08:00')
    || review.finalizedAtMs >= Date.parse(review.tradeDate+'T08:45:00+08:00')
    || !review.weights || !review.reasons || Object.keys(review.weights).length !== Object.keys(plan.weights).length)
    throw new Error('daily_plan_review_invalid')
  for (const [symbol, weight] of Object.entries(review.weights)) {
    const target=plan.targets[symbol]
    if (!target || !finite(weight) || weight<0 || weight>target.weight
      || (target.locked && weight !== target.weight)
      || !Array.isArray(review.reasons[symbol]) || review.reasons[symbol].some(r=>typeof r!=='string' || !r.trim()))
      throw new Error('daily_plan_review_expands_or_unlocks')
  }
  return review
}
export async function verifyDailyReview(plan:L4PortfolioPlan,review:DailyPlanReview) {
  validateDailyReview(plan,review)
  const {checksum,...body}=review
  if (await digest(body)!==checksum) throw new Error('daily_plan_review_checksum')
  return review
}
/** Caps are absolute weights; duplicate delivery is idempotent, not another multiplier. */
export async function sealDailyReview(input:{plan:L4PortfolioPlan;tradeDate:string;contextHash:string;nowMs:number;
  restrictions:RiskRestriction[];previous?:DailyPlanReview}):Promise<DailyPlanReview> {
  const p=validateL4PortfolioPlan(input.plan), previous=input.previous
  if (previous) {
    await verifyDailyReview(p,previous)
    if (previous.tradeDate!==input.tradeDate || previous.contextHash!==input.contextHash)
      throw new Error('daily_plan_identity_changed')
    if (!finite(input.nowMs) || input.nowMs < previous.finalizedAtMs
      || input.nowMs>=Date.parse(input.tradeDate+'T24:00:00+08:00')) throw new Error('daily_plan_revision_time_invalid')
  }
  const weights={...(previous?.weights ?? p.weights)}
  const reasons:Record<string,string[]>=Object.fromEntries(Object.keys(weights).map(s=>[s,[...(previous?.reasons[s]??[])]]))
  for(const cap of input.restrictions) {
    const target=p.targets[cap.symbol]
    if (!target || !finite(cap.maxWeight) || cap.maxWeight<0 || cap.maxWeight>target.weight || !cap.reason.trim())
      throw new Error('daily_plan_restriction_invalid')
    if (target.locked && cap.maxWeight<target.weight) throw new Error('daily_plan_locked_target')
    weights[cap.symbol]=Math.min(weights[cap.symbol],cap.maxWeight)
    if (!reasons[cap.symbol].includes(cap.reason)) reasons[cap.symbol].push(cap.reason)
  }
  for(const list of Object.values(reasons)) list.sort()
  if(previous && stable(weights)===stable(previous.weights) && stable(reasons)===stable(previous.reasons)) return previous
  const body={schema:'paper-daily-review-v1' as const,tradeDate:input.tradeDate,planId:p.plan_id,contextHash:input.contextHash,
    finalizedAtMs:previous?.finalizedAtMs ?? input.nowMs,weights,reasons,
    revision:previous ? previous.revision+1 : 0,previousHash:previous?.checksum ?? null}
  const review={...body,checksum:await digest(body)}
  return validateDailyReview(p,review)
}

/** Raw optimizer plan is retained; consumers use this target only for execution. */
export function reviewedTarget(plan:L4PortfolioPlan,review:DailyPlanReview,symbol:string) {
  validateDailyReview(plan,review)
  const target=plan.targets[symbol]
  return !target ? null : {...target,weight:review.weights[symbol]}
}

export async function persistDailyReview(db:D1Database,plan:L4PortfolioPlan,review:DailyPlanReview, nowMs=paperExecutionNow()) {
  await verifyDailyReview(plan,review)
  const payload=JSON.stringify(review)
  if(review.revision===0) {
    const existing=await db.prepare('SELECT checksum FROM paper_daily_plan_heads_v1 WHERE account_id=? AND trade_date=?')
      .bind(plan.account_id,review.tradeDate).first<{checksum:string}>()
    // An old sealed object cannot be first-published after the cutoff.
    if (existing?.checksum!==review.checksum && (!finite(nowMs) || nowMs<review.finalizedAtMs
      || nowMs>=Date.parse(review.tradeDate+'T08:45:00+08:00'))) throw new Error('daily_plan_publication_cutoff')
    await db.batch([
      db.prepare(`INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,previous_hash,revision,payload_json)
        VALUES(?,?,?,?,NULL,0,?) ON CONFLICT(account_id,trade_date,checksum) DO NOTHING`)
        .bind(plan.account_id,review.tradeDate,review.checksum,review.planId,payload),
      db.prepare(`INSERT INTO paper_daily_plan_heads_v1(account_id,trade_date,checksum,plan_id)
        SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM paper_order_intents WHERE account_id=? AND status='running')
        ON CONFLICT(account_id,trade_date) DO NOTHING`)
        .bind(plan.account_id,review.tradeDate,review.checksum,review.planId,plan.account_id),
    ])
  } else {
    const parent=await db.prepare(`SELECT r.payload_json FROM paper_daily_plan_heads_v1 h
      JOIN paper_daily_plan_reviews_v1 r ON r.account_id=h.account_id AND r.trade_date=h.trade_date AND r.checksum=h.checksum
      WHERE h.account_id=? AND h.trade_date=?`).bind(plan.account_id,review.tradeDate).first<{payload_json:string}>()
    if(!parent) throw new Error('daily_plan_parent_missing')
    const old=await verifyDailyReview(plan,JSON.parse(parent.payload_json))
    if(old.checksum===review.checksum) return review
    if(old.checksum!==review.previousHash || review.revision!==old.revision+1 || old.contextHash!==review.contextHash
      || old.finalizedAtMs!==review.finalizedAtMs || Object.keys(old.weights).some(s=>review.weights[s]>old.weights[s]
        || old.reasons[s].some(reason=>!review.reasons[s].includes(reason)))) throw new Error('daily_plan_revision_conflict')
    await db.batch([
      db.prepare(`INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,previous_hash,revision,payload_json)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM paper_daily_plan_heads_v1 WHERE account_id=? AND trade_date=? AND checksum=?)
        ON CONFLICT(account_id,trade_date,checksum) DO NOTHING`)
        .bind(plan.account_id,review.tradeDate,review.checksum,review.planId,review.previousHash,review.revision,payload,
          plan.account_id,review.tradeDate,review.previousHash),
      db.prepare(`UPDATE paper_daily_plan_heads_v1 SET checksum=? WHERE account_id=? AND trade_date=? AND checksum=?
        AND EXISTS(SELECT 1 FROM paper_daily_plan_reviews_v1 WHERE account_id=? AND trade_date=? AND checksum=? AND payload_json=?)
        AND NOT EXISTS(SELECT 1 FROM paper_order_intents WHERE account_id=? AND status='running')`)
        .bind(review.checksum,plan.account_id,review.tradeDate,review.previousHash,plan.account_id,review.tradeDate,review.checksum,payload,plan.account_id),
    ])
  }
  const head=await db.prepare(`SELECT checksum,plan_id FROM paper_daily_plan_heads_v1 WHERE account_id=? AND trade_date=?`)
    .bind(plan.account_id,review.tradeDate).first<{checksum:string;plan_id:string}>()
  if(head?.checksum!==review.checksum || head.plan_id!==review.planId) throw new Error('daily_plan_already_frozen_or_raced')
  const saved=await db.prepare(`SELECT payload_json FROM paper_daily_plan_reviews_v1 WHERE account_id=? AND trade_date=? AND checksum=?`)
    .bind(plan.account_id,review.tradeDate,review.checksum).first<{payload_json:string}>()
  if(saved?.payload_json!==payload) throw new Error('daily_plan_immutable_conflict')
  return review
}
