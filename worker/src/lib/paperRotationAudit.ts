import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { paperAccountId } from './paperExecutionScope'
import { loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import { parseSellOrderNote } from './paperOrderAccounting'

/** Decision evidence is stored inside the actual sell order's atomic transaction. */
export function rotationDecision(reason:string,position:{avg_cost:number;shares:number},price:number) {
 const planId=reason.match(/\[L4Target\] plan=([a-f0-9]{64})/)?.[1]
 if(!planId)return null
 if(![price,position.avg_cost].every(x=>Number.isFinite(x)&&x>0))throw new Error('rotation_cost_basis_missing')
 return {schema:'l4-rotation-decision-v1',plan_id:planId,reason,decision_price:price,
   average_cost_including_buy_fees:position.avg_cost,position_shares:position.shares,
   floating_pnl_pct:price/position.avg_cost-1,attribution:'shared_plan_cash_pool'}
}
import {replacementLotOutcome,orderDay as day,type RotationOrder as Order,type RotationEntitlement} from './paperRotationLot'
import {readCorporateOpeningHistory} from './paperCorporateOpeningBasis'
export {replacementLotOutcome} from './paperRotationLot'
/** Daily attribution is diagnostic; it never feeds future outcomes into today's OPB reward. */
export async function updateRotationAudit(env:Bindings,date:string) {
 if(env.PAPER_DAILY_PLAN_OWNER!=='premarket_once_v1')return
 const db=paperDomainDatabase(env),account=paperAccountId()
 const {results:orders}=await db.prepare(`SELECT id,symbol,side,shares,price,total_cost,created_at,note
   FROM paper_orders WHERE account_id=? AND date(created_at,'+8 hours')<=? ORDER BY id`).bind(account,date).all<Order>()
 const rotations=orders.filter(o=>o.side==='sell'&&parseSellOrderNote(o.note).l4_rotation)
 if(!rotations.length)return
 const symbols=[...new Set(['0050',...rotations.map(o=>o.symbol),...orders.filter(o=>o.side==='buy').map(o=>o.symbol)])]
 const rows=await loadMarketPriceHistoryBySymbols(env,symbols,{onOrBeforeDate:date,rowsPerSymbol:260,requireQuerySuccess:true})
 const calendar=[...new Set(rows.filter(r=>r.symbol==='0050').map(r=>r.date))].sort()
 const corporate=(await db.prepare('SELECT * FROM paper_corporate_entitlements_v1 WHERE account_id=?')
   .bind(account).all<RotationEntitlement>()).results
 const firstDate=orders.filter(o=>o.side==='buy').map(day).sort()[0]??date
 const openings=await readCorporateOpeningHistory(db,account,firstDate,date)
 for(const sale of rotations) {
   const decision=parseSellOrderNote(sale.note).l4_rotation as any,exitDate=day(sale),start=calendar.indexOf(exitDate)
   const sessions=start<0?[]:calendar.slice(start+1,start+21)
   const path=rows.filter(r=>r.symbol===sale.symbol&&sessions.includes(r.date)).sort((a,b)=>a.date.localeCompare(b.date))
     .map(r=>({date:r.date,close:Number(r.close)}))
   const buys=orders.filter(o=>o.side==='buy'&&o.id>sale.id&&day(o)===exitDate&&parseSellOrderNote(o.note).l4_plan_id===decision.plan_id)
   const replacements=buys.map(buy=>{
     const index=calendar.indexOf(day(buy)),end=index>=0?calendar[index+20]:undefined
     const until=end??date,lotOrders=orders.filter(o=>day(o)<=until)
     const mark=rows.find(r=>r.symbol===buy.symbol&&r.date===until)?.close
     const result=replacementLotOutcome(buy,lotOrders,mark==null?null:Number(mark),{entitlements:corporate,openings,until})
     const expectedDays=calendar.filter(d=>d>day(buy)&&d<=until)
     if(expectedDays.some(d=>!openings.some(o=>o.session_date===d))) {
       result.net_pnl=null;result.reconciliation_reason='corporate_opening_evidence_missing'
     }
     const actions=corporate.filter(c=>c.symbol===buy.symbol&&c.ex_date>day(buy)&&c.ex_date<=until)
     return {...result,status:result.reconciliation_reason?'missing_data':end&&end<=date?'mature':'immature',
       cash_and_share_entitlements:actions,as_of_date:until}

   })
   const status=start<0||path.length!==sessions.length?'missing_data':sessions.length===20?'mature':'immature'
   const payload={schema:'l4-rotation-outcome-v1',order_id:sale.id,as_of_date:date,status,
     exit_reason:decision.reason,floating_pnl_pct:decision.floating_pnl_pct,actual_exit_price:sale.price,actual_exit_shares:sale.shares,
     original_next_20_sessions:path,original_price_basis:'raw_close_path_corporate_changes_not_profit',
     replacement_status:buys.length?'shared_plan_cohort':'not_replaced',replacements,
     causal_pairing:false,learning_input:false}
   await db.prepare(`INSERT INTO paper_rotation_outcomes_v1(account_id,order_id,as_of_date,status,payload_json) VALUES(?,?,?,?,?)
     ON CONFLICT(account_id,order_id,as_of_date) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json`)
     .bind(account,sale.id,date,status,JSON.stringify(payload)).run()
 }
}
