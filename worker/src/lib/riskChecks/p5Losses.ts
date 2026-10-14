import { paperAccountId } from '../paperExecutionScope'
import { summarizeSellOrderLosses } from '../paperOrderAccounting'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import { failClosedRiskCheck } from './failClosed'
import { estimateSellOrderRealizedPnl, parseSellOrderNote } from '../paperOrderAccounting'
import { paperExecutionNow } from '../paperExecutionScope'
import { sellReceiptExitCategory } from '../paperExitAttribution'

export interface P5LossGuardPolicy {
  lookbackSessions:number; releaseAfterSessions:number; channel:'stopouts'|'net_pnl';
  minimumLossValue:number; minimumClosedTrades:number; maximumClosedTrades:number; scale:number;
}
export function evaluateBoundedLosses(rows:any[],held:Array<{symbol:string;entry_date:string}>,sessions:string[],policy:P5LossGuardPolicy) {
  if(!Number.isSafeInteger(policy.lookbackSessions) || policy.lookbackSessions<1 || policy.lookbackSessions>60
    || !Number.isSafeInteger(policy.releaseAfterSessions) || policy.releaseAfterSessions<1 || policy.releaseAfterSessions>policy.lookbackSessions
    || !Number.isSafeInteger(policy.minimumClosedTrades) || policy.minimumClosedTrades<3
    || !Number.isSafeInteger(policy.maximumClosedTrades) || policy.maximumClosedTrades<policy.minimumClosedTrades || policy.maximumClosedTrades>100
    || !Number.isFinite(policy.scale) || policy.scale<=0 || policy.scale>1
    || !Number.isFinite(policy.minimumLossValue) || policy.minimumLossValue<0
    || !['stopouts','net_pnl'].includes(policy.channel)) throw new Error('p5_window_policy_invalid')
  const allowed=new Set(sessions.slice(0,policy.lookbackSessions)),groups=new Map<string,{pnl:number;date:string;stopout:boolean}>()
  for(const row of rows) {
    const note=parseSellOrderNote(row.note),entryDate=String(note.entry_date ?? '')
    const millis=Date.parse(String(row.created_at).replace(' ','T')+'Z')
    const date=Number.isFinite(millis)?new Date(millis+8*3600000).toISOString().slice(0,10):''
    if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)
      || held.some(h=>h.symbol===row.symbol && h.entry_date===entryDate)) continue
    const pnl=estimateSellOrderRealizedPnl(row);if(pnl==null) continue
    const key=`${row.symbol}:${entryDate}`,previous=groups.get(key)
    groups.set(key,{pnl:(previous?.pnl??0)+pnl,date:previous && previous.date>date?previous.date:date,
      stopout:previous?.stopout===true || ['hard_stop','structural_stop'].includes(sellReceiptExitCategory(note))})
  }
  const closed=[...groups.values()].filter(t=>allowed.has(t.date)).sort((a,b)=>b.date.localeCompare(a.date))
    .filter(t=>policy.channel==='net_pnl' || t.stopout).slice(0,policy.maximumClosedTrades)
  const losses=closed.filter(t=>t.pnl < -policy.minimumLossValue)
  const age=losses.length ? sessions.indexOf(losses[0].date) : -1
  const netPnl=closed.reduce((n,t)=>n+t.pnl,0)
  return {triggered:closed.length>=policy.minimumClosedTrades && losses.length>=3 && age>=0 && age<policy.releaseAfterSessions
      && (policy.channel==='stopouts' || netPnl < -policy.minimumLossValue),
    total:closed.length,losses:losses.length,ageSessions:age,channel:policy.channel,netPnl}
}

// Loss count reduces Paper sizing; monetary loss/drawdown gates own hard halts.
export const P5_LOSS_POSITION_SCALE = 0.5
export const P5_LOSS_POLICY = 'paper-loss-count-scale-v1'

export async function checkP5Losses(
  db: D1Database,
  deps: LegacyLayerDeps,
  window?:{policy:P5LossGuardPolicy;sessions:string[]},
): Promise<LegacyLayerResult> {
  const { defaults } = deps

  try {
    if(window) {
      const {results:rows}=await db.prepare(`WITH bounds AS (
          SELECT ? AS account_id, ? AS start_at, ? AS end_at,
            COALESCE((SELECT MAX(cutoff_sell_id) FROM paper_p5_rearms_v1 WHERE account_id=?),0) AS cutoff
        ), recent AS (
          SELECT DISTINCT o.symbol,json_extract(CASE WHEN json_valid(o.note) THEN o.note ELSE '{}' END,'$.entry_date') AS entry_date
          FROM paper_orders o,bounds b WHERE o.account_id=b.account_id AND o.side='sell'
            AND o.created_at>=b.start_at AND o.created_at<=b.end_at AND o.id>b.cutoff
        ) SELECT o.id,o.symbol,o.price,o.shares,o.commission,o.tax,o.note,o.created_at
        FROM paper_orders o,bounds b JOIN recent r ON r.symbol=o.symbol
          AND r.entry_date=json_extract(CASE WHEN json_valid(o.note) THEN o.note ELSE '{}' END,'$.entry_date')
        WHERE o.account_id=b.account_id AND o.side='sell' AND o.created_at<=b.end_at AND o.id>b.cutoff
        ORDER BY o.id DESC LIMIT 1000`).bind(paperAccountId(),window.sessions.at(-1)+' 00:00:00',
          new Date(paperExecutionNow()).toISOString().replace('T',' ').slice(0,19),paperAccountId()).all<any>()
      const {results:held}=await db.prepare('SELECT symbol,entry_date FROM paper_positions WHERE account_id=? AND shares>0')
        .bind(paperAccountId()).all<{symbol:string;entry_date:string}>()
      const evidence=evaluateBoundedLosses(rows ?? [],held ?? [],window.sessions,window.policy)
      if(rows?.length===1000) throw new Error('p5_window_coverage_limit')
      if(!evidence.triggered) return null
      return {...defaults,maxPositionPct:defaults.maxPositionPct*window.policy.scale,
        reason:`P5 ${evidence.channel} ${evidence.losses}/${evidence.total} closed trades; age=${evidence.ageSessions} sessions; scale=${window.policy.scale}`}
    }
    const { results: recentSells } = await db.prepare(
      `SELECT price, shares, commission, tax, note
         FROM paper_orders
        WHERE account_id=? AND side='sell'
          AND id > COALESCE((SELECT MAX(cutoff_sell_id) FROM paper_p5_rearms_v1 WHERE account_id=?),0)
        ORDER BY id DESC
        LIMIT 5`,
    ).bind(paperAccountId(), paperAccountId()).all<any>()

    if (!recentSells || recentSells.length < 3) return null

    const summary = summarizeSellOrderLosses(recentSells)
    if (summary.total < 3 || summary.losses < 3) return null

    console.warn(`[CircuitBreaker] Layer5 SCALE: ${summary.losses}/${summary.total} recent closed trades are losses; position cap × ${P5_LOSS_POSITION_SCALE}`)
    return {
      ...defaults,
      reason: `近 ${summary.total} 筆已平倉交易中有 ${summary.losses} 筆虧損，部位上限降為原設定的 50%（虧損筆數不停止買入）`,
      maxPositionPct: defaults.maxPositionPct * P5_LOSS_POSITION_SCALE,
    }
  } catch (e) {
    console.error('[CircuitBreaker] Layer5 check failed; fail closed:', e)
    return failClosedRiskCheck('P5', e, deps)
  }
}
