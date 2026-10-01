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

interface ReplanRow { request_id: string; request_json: string }
interface ReplanRequest {
  plan_id: string
  veto_symbols: string[]
  weight_caps?: Record<string, number>
  reason: string
}

/** Canonical payload preserves retry identity and the strictest known caps. */
function mergeRequests(rows: ReplanRow[]): ReplanRequest {
  const requests = rows.map(row => JSON.parse(row.request_json) as ReplanRequest)
  const caps: Record<string, number> = {}
  for (const request of requests) for (const [symbol, cap] of Object.entries(request.weight_caps ?? {})) {
    if (!Number.isFinite(cap) || cap < 0 || cap > 1) throw new Error('l4_replan_weight_cap_invalid')
    caps[symbol] = Math.min(caps[symbol] ?? 1, cap)
  }
  return {
    plan_id: requests[0].plan_id,
    veto_symbols: [...new Set(requests.flatMap(request => request.veto_symbols))].sort(),
    weight_caps: Object.fromEntries(Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))),
    reason: requests.length === 1 ? requests[0].reason
      : requests.some(request => request.reason === 'account_risk_changed') ? 'account_risk_changed' : 'batched_constraints',
  }
}

/** Returns false while constraints are undelivered: buys wait, exits continue. */
export async function flushL4Replans(
  env: Bindings, signalDate: string, options: { debatePending?: boolean } = {},
): Promise<boolean> {
  const db = paperDomainDatabase(env)
  await db.prepare("UPDATE l4_replan_outbox_v1 SET status='expired' WHERE status='pending' AND source_plan_id IN (SELECT plan_id FROM l4_portfolio_plans_v1 WHERE signal_date<?)")
    .bind(signalDate).run()
  const { results } = await db.prepare("SELECT o.request_id,o.request_json FROM l4_replan_outbox_v1 o JOIN l4_portfolio_plans_v1 p ON p.plan_id=o.source_plan_id WHERE o.status='pending' AND p.signal_date=? ORDER BY o.created_at,o.request_id")
    .bind(signalDate).all<ReplanRow>()
  if (!results.length) return true
  // Partial debate results are durable, but do not optimize until the round is
  // complete. Independent hard-risk events may still require immediate action.
  if (options.debatePending && results.every(row =>
    (JSON.parse(row.request_json) as ReplanRequest).reason.startsWith('debate_'))) return false
  try {
    const request = mergeRequests(results)
    let result: { status?: string; plan_id?: string }
    if (scopedPaperAccountId() != null) {
      // The private account adapter reads the same union of durable constraints.
      result = await replanPrivateL4(env, signalDate)
    } else {
      const response = await controllerFetch(env, '/l4_distribution/replan', {
        method: 'POST', timeoutMs: 45_000, jsonBody: request,
      })
      if (!response.ok) throw new Error(`http_${response.status}`)
      result = await response.json() as { status?: string; plan_id?: string }
    }
    if (result.status !== 'replanned' || !/^[a-f0-9]{64}$/.test(result.plan_id ?? '')) throw new Error('receipt_missing')
    // Complete only the captured request IDs; arrivals during execution belong
    // to the next information batch and must not be silently acknowledged.
    await db.batch(results.map(row => db.prepare("UPDATE l4_replan_outbox_v1 SET status='completed',result_plan_id=?,attempts=attempts+1,last_error=NULL WHERE request_id=? AND status='pending'")
      .bind(result.plan_id!, row.request_id)))
  } catch {
    await db.batch(results.map(row => db.prepare("UPDATE l4_replan_outbox_v1 SET attempts=attempts+1,last_error='delivery_failed' WHERE request_id=? AND status='pending'")
      .bind(row.request_id)))
    return false
  }
  const remaining = await db.prepare("SELECT COUNT(*) AS n FROM l4_replan_outbox_v1 o JOIN l4_portfolio_plans_v1 p ON p.plan_id=o.source_plan_id WHERE o.status='pending' AND p.signal_date=?")
    .bind(signalDate).first<{ n: number }>()
  return Number(remaining?.n ?? 0) === 0
}
