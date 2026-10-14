import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import type { Bindings } from '../types'
import { parseSellOrderNote as parsePaperOrderNote } from './paperOrderAccounting'

/** An original Paper entry, not a new portfolio target or a broker order. */
export interface L4EntryAuthorization {
  schema: 'l4-entry-authorization-v1'; id:string; planId:string; review:string;
  tradeDate:string; symbol:string; requestedShares:number; maxPrice:number;
  grossBudget:number; expiresAtMs:number;
}
export interface L4EntryContinuation {
  authorization:L4EntryAuthorization; filledShares:number; grossSpent:number; remainingShares:number;
}
export function validateEntryAuthorization(a:L4EntryAuthorization) {
  if(a?.schema!=='l4-entry-authorization-v1' || !/^[a-f0-9]{64}$/.test(a.planId)
    || !/^[a-f0-9]{64}$/.test(a.review) || !/^\d{4}-\d{2}-\d{2}$/.test(a.tradeDate)
    || !a.symbol || a.id!==`${a.planId}:${a.review}:${a.tradeDate}:${a.symbol}`
    || !Number.isSafeInteger(a.requestedShares) || a.requestedShares<1
    || !Number.isFinite(a.maxPrice) || a.maxPrice<=0 || !Number.isFinite(a.grossBudget) || a.grossBudget<=0
    || !Number.isFinite(a.expiresAtMs)
    || a.expiresAtMs>Date.parse(`${a.tradeDate}T13:21:00+08:00`)
    || a.expiresAtMs<=Date.parse(`${a.tradeDate}T09:00:00+08:00`)) throw new Error('l4_entry_authorization_invalid')
  return a
}
export async function readL4EntryContinuation(env:Bindings,tradeDate:string,symbol:string,planId:string,review:string):Promise<L4EntryContinuation|null> {
  const {results:rows}=await paperDomainDatabase(env).prepare(`SELECT id,side,shares,price,note FROM paper_orders
    WHERE account_id=? AND symbol=? AND created_at>=? AND created_at<? ORDER BY id`)
    .bind(paperAccountId(),symbol,`${tradeDate} 00:00:00`,`${tradeDate} 23:59:59`).all<{id:number;side:string;shares:number;price:number;note:string}>()
  // created_at is UTC; trade window begins at 01:00 UTC, so the same date applies.
  let original:L4EntryAuthorization|null=null,filledShares=0,grossSpent=0
  for(const row of rows) {
    if(row.side==='sell' && original) return null // Never refill an exited position.
    if(row.side!=='buy') continue
    const note=parsePaperOrderNote(row.note),a=note.entry_authorization as L4EntryAuthorization|undefined
    if(!a || a.planId!==planId || a.review!==review || a.tradeDate!==tradeDate) continue
    validateEntryAuthorization(a)
    if(a.symbol!==symbol || note.paper_child_terminal!==true || note.l4_plan_id!==planId)
      throw new Error('l4_entry_child_not_terminal')
    if(original && JSON.stringify(a)!==JSON.stringify(original)) throw new Error('l4_entry_authorization_changed')
    original=a;filledShares+=Number(row.shares);grossSpent+=Number(row.shares)*Number(row.price)
  }
  if(!original || paperExecutionNow()>=original.expiresAtMs) return null
  if(!Number.isSafeInteger(filledShares) || filledShares<0 || filledShares>original.requestedShares
    || !Number.isFinite(grossSpent) || grossSpent>original.grossBudget+1e-6) throw new Error('l4_entry_ledger_exceeds_authorization')
  return {authorization:original,filledShares,grossSpent,remainingShares:original.requestedShares-filledShares}
}
