import {corporateStockQuantity, type CorporateEntitlement} from './paperCorporateActions'
import type {CorporateOpeningBasis} from './paperCorporateOpeningBasis'
export type RotationOrder={id:number;symbol:string;side:string;shares:number;price:number;total_cost:number;created_at:string;note:string}
export type RotationEntitlement=CorporateEntitlement & {settled_at?:string|null}
export const orderMs=(value:string)=>Date.parse(value.includes('T')?value:value.replace(' ','T')+'Z')
export const orderDay=(o:RotationOrder)=>new Date(orderMs(o.created_at)+8*3600000).toISOString().slice(0,10)

/** Diagnostic lot accounting from actual account receipts. No synthetic fills,
 * no sale-fee estimate on unsold shares, and no silent FIFO assumption after a
 * new purchase merges with an old dividend delivery. Such ownership is unknown.
 */
export function replacementLotOutcome(buy:RotationOrder, orders:RotationOrder[], close:number|null,
  evidence:{entitlements:RotationEntitlement[];openings:CorporateOpeningBasis[];until:string}={entitlements:[],openings:[],until:'9999-12-31'}) {
  let remaining=buy.shares,proceeds=0,cash=0,receivable=0,reason:string|null=null,closedToOrders=false
  const pending=new Map<string,number>(), attributed=new Set<string>()
  type Event={ms:number;priority:number;id:number;run:()=>void}
  const events:Event[]=[], fail=(code:string)=>{reason??=code}
  const untilMs=Date.parse(evidence.until+'T23:59:59+08:00')
  const valid=(x:number)=>Number.isFinite(x)&&x>=0
  if(!Number.isSafeInteger(buy.shares)||buy.shares<=0||!valid(buy.total_cost))fail('invalid_buy_cost_or_quantity')
  for(const order of orders.filter(o=>o.id>buy.id&&o.symbol===buy.symbol).sort((a,b)=>a.id-b.id)) {
    const ms=order.created_at?orderMs(order.created_at):order.id
    if(ms>untilMs)continue
    events.push({ms,priority:3,id:order.id,run:()=>{
      if(order.side==='buy') {
        if(remaining>0||[...pending.values()].some(x=>x>0))fail('merged_lot_ownership_ambiguous')
        closedToOrders=true;return
      }
      if(closedToOrders||remaining===0)return
      if(order.side!=='sell'||!Number.isSafeInteger(order.shares)||order.shares<=0||!valid(order.total_cost)) {
        fail('invalid_sell_cost_or_quantity');return
      }
      if(order.shares>remaining)fail('sell_exceeds_reconciled_lot')
      const sold=Math.min(remaining,order.shares)
      proceeds+=order.total_cost*sold/order.shares;remaining-=sold
    }})
  }
  const buyDate=buy.created_at?orderDay(buy):'0000-00-00'
  const byDay=new Map<string,RotationEntitlement[]>()
  for(const row of evidence.entitlements.filter(r=>r.symbol===buy.symbol&&r.ex_date>buyDate&&r.ex_date<=evidence.until)) {
    byDay.set(row.ex_date,[...(byDay.get(row.ex_date)??[]),row])
  }
  const openingDays=new Map(evidence.openings.filter(o=>o.session_date>buyDate&&o.session_date<=evidence.until).map(o=>[o.session_date,o]))
  for(const date of [...new Set([...byDay.keys(),...openingDays.keys()])].sort()) {
    events.push({ms:Date.parse(date+'T00:00:00+08:00'),priority:0,id:0,run:()=>{
      if(closedToOrders||remaining===0)return
      const opening=openingDays.get(date),actual=opening?.positions.find(p=>p.symbol===buy.symbol)
      if(opening&&!Array.isArray(opening.actions))fail('legacy_corporate_terms_missing')
      if(opening&&Number(actual?.shares??0)!==remaining)fail('opening_quantity_mismatch')
      const eligible=remaining, seen=new Set<string>()
      for(const row of byDay.get(date)??[]) {
        if(seen.has(row.action_id)||!valid(row.cash_due)||!valid(row.shares_due)||row.eligible_shares!==eligible) {
          fail('entitlement_ownership_mismatch');continue
        }
        seen.add(row.action_id);attributed.add(row.action_id)
        if(row.kind==='cash')cash+=row.cash_due
        else if(row.kind==='stock')pending.set(row.action_id,row.fractional_treatment==='book_entry_fee'?row.whole_shares_due:row.shares_due)
        else if(row.kind==='subscription') {
          try {
            const rights=JSON.parse(row.rights_json??'null')
            if(rights?.policy!=='do_not_subscribe'||!rights.payment_deadline||evidence.until<=rights.payment_deadline)
              fail('subscription_fair_value_unobservable')
          }catch{fail('subscription_terms_missing')}
        }else fail('corporate_kind_unknown')
      }
      const exchanges=opening?.actions?.filter(a=>a.symbol===buy.symbol&&a.ex_date===date&&a.kind==='exchange')??[]
      if(exchanges.length>1)fail('exchange_terms_ambiguous')
      for(const action of exchanges)remaining=corporateStockQuantity(remaining,action.stock_per_share).whole
    }})
  }
  for(const row of evidence.entitlements.filter(r=>r.symbol===buy.symbol&&r.kind==='stock'&&r.settled_at)) {
    const ms=orderMs(row.settled_at!)
    if(ms>untilMs)continue
    events.push({ms,priority:1,id:0,run:()=>{
      if(!attributed.has(row.action_id))return
      if(closedToOrders){fail('merged_lot_ownership_ambiguous');return}
      if(pending.get(row.action_id)!==row.whole_shares_due)fail('fractional_delivery_terms_missing')
      remaining+=row.whole_shares_due;pending.delete(row.action_id)
    }})
  }
  for(const event of events.sort((a,b)=>a.ms-b.ms||a.priority-b.priority||a.id-b.id))event.run()
  receivable=[...pending.values()].reduce((a,b)=>a+b,0)
  const marked=remaining+receivable
  if(marked>0&&!(close!=null&&Number.isFinite(close)&&close>0))fail('mark_missing')
  return {order_id:buy.id,symbol:buy.symbol,invested:buy.total_cost,realized_net_proceeds:proceeds,
    remaining_shares:remaining,receivable_shares:receivable,cash_entitlements:cash,
    unrealized_mark_value:marked&&close!=null?marked*close:marked===0?0:null,
    net_pnl:reason?null:proceeds+cash+marked*(close??0)-buy.total_cost,reconciliation_reason:reason,
    valuation_basis:'actual_costs_plus_corporate_entitlements_and_unsold_mark_no_hypothetical_sell_fee'}
}
