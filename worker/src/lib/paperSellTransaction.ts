import type { Bindings } from '../types'
import { paperAccountId, paperExecutionNow } from './paperExecutionScope'
import { paperDomainDatabase } from './paperDomainDatabase'
import { getSettlementDate } from './dateUtils'

/** The native position mutation, order and T+2 receivable are one D1 transaction.
 * The supplied statements must end in the corresponding paper_orders INSERT.
 */
export async function executePaperSellBatch(env: Bindings, statements: D1PreparedStatement[],
  symbol: string, proceeds: number): Promise<number> {
  if (!symbol || !Number.isFinite(proceeds) || proceeds<0 || statements.length<2)
    throw new Error('paper_sell_transaction_invalid')
  const db=paperDomainDatabase(env),accountId=paperAccountId()
  const day=new Date(paperExecutionNow()+8*3600_000).toISOString().slice(0,10)
  const settlementDate=await getSettlementDate(day,env.KV)
  const result=await db.batch([...statements,db.prepare(`INSERT INTO paper_settlements
    (account_id,order_id,symbol,side,amount,trade_date,settlement_date)
    VALUES (?,(SELECT id FROM paper_orders WHERE id=last_insert_rowid()
      AND account_id=? AND symbol=? AND side='sell' AND total_cost=?),?,'sell',?,?,?)`)
    .bind(accountId,accountId,symbol,proceeds,symbol,proceeds,day,settlementDate)])
  if (result.length!==statements.length+1 || result.some(row=>row.success!==true)
    || Number(result[result.length-1].meta?.changes)!==1) throw new Error('paper_sell_transaction_incomplete')
  const row=await db.prepare(`SELECT order_id FROM paper_settlements
    WHERE account_id=? AND symbol=? AND side='sell' ORDER BY id DESC LIMIT 1`)
    .bind(accountId,symbol).first<{order_id:number}>()
  if (!Number.isSafeInteger(row?.order_id)) throw new Error('paper_sell_settlement_readback_missing')
  return row!.order_id
}
