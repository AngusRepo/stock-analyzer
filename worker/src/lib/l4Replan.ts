import { scopedPaperAccountId } from './paperExecutionScope'
import { replanPrivateL4 } from './l4PrivateExecution'
import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'
import { paperDomainDatabase } from './paperDomainDatabase'

/** Persist a veto before removing pending buys; delivery may safely retry. */
export async function requestL4Replan(env: Bindings, planId: string, vetoSymbols: string[], reason: string, weightCaps: Record<string,number> = {}) {
  if (!vetoSymbols.length && !Object.keys(weightCaps).length && reason!=='account_risk_changed') return
  const request = { plan_id:planId, veto_symbols:[...new Set(vetoSymbols)].sort(), weight_caps:weightCaps, reason }
  const payload = JSON.stringify(request)
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))))
    .map(b=>b.toString(16).padStart(2,'0')).join('')
  await paperDomainDatabase(env).prepare('INSERT INTO l4_replan_outbox_v1(request_id,source_plan_id,request_json) VALUES(?,?,?) ON CONFLICT(request_id) DO NOTHING')
    .bind(id,planId,payload).run()
  return id
}

/** Returns false while a current veto is undelivered: buys wait, exits continue. */
export async function flushL4Replans(env: Bindings, signalDate: string): Promise<boolean> {
  const db = paperDomainDatabase(env)
  await db.prepare("UPDATE l4_replan_outbox_v1 SET status='expired' WHERE status='pending' AND source_plan_id IN (SELECT plan_id FROM l4_portfolio_plans_v1 WHERE signal_date<?)")
    .bind(signalDate).run()
  const { results } = await db.prepare("SELECT o.request_id,o.request_json FROM l4_replan_outbox_v1 o JOIN l4_portfolio_plans_v1 p ON p.plan_id=o.source_plan_id WHERE o.status='pending' AND p.signal_date=? ORDER BY o.created_at,o.request_id LIMIT 1")
    .bind(signalDate).all<{request_id:string;request_json:string}>()
  // The account adapter unions every durable veto, so each replan has full constraints.
  for (const row of results) {
    try {
      let result:{status?:string;plan_id?:string}
      if (scopedPaperAccountId()!=null) {
        result=await replanPrivateL4(env,signalDate)
      } else {
        const response = await controllerFetch(env,'/l4_distribution/replan', {
          method:'POST', timeoutMs:45_000, jsonBody:JSON.parse(row.request_json) })
        if (!response.ok) throw new Error(`http_${response.status}`)
        result=await response.json() as {status?:string;plan_id?:string}
      }
      if (result.status!=='replanned' || !/^[a-f0-9]{64}$/.test(result.plan_id ?? '')) throw new Error('receipt_missing')
      await db.prepare("UPDATE l4_replan_outbox_v1 SET status='completed',result_plan_id=?,attempts=attempts+1,last_error=NULL WHERE request_id=?")
        .bind(result.plan_id!,row.request_id).run()
    } catch {
      await db.prepare("UPDATE l4_replan_outbox_v1 SET attempts=attempts+1,last_error='delivery_failed' WHERE request_id=?").bind(row.request_id).run()
      return false
    }
  }
  const remaining=await db.prepare("SELECT COUNT(*) AS n FROM l4_replan_outbox_v1 o JOIN l4_portfolio_plans_v1 p ON p.plan_id=o.source_plan_id WHERE o.status='pending' AND p.signal_date=?").bind(signalDate).first<{n:number}>()
  return Number(remaining?.n ?? 0)===0
}
