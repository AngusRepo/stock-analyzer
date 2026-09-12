import type { Bindings } from '../types'
import { twToday } from './dateUtils'
import { paperDomainDatabase } from './paperDomainDatabase'
import { scopedPaperAccountId } from './paperExecutionScope'
import { processCorporateActionsFromSource } from './paperCorporateActions'

/** Cash and settlement flags share one D1 transaction, including on retries. */
export async function settlePaperT2(env: Bindings): Promise<void> {
  const db = paperDomainDatabase(env)
  const today = twToday()
  const accountId = scopedPaperAccountId()
  const rows = await db.batch([
    db.prepare(`UPDATE paper_accounts SET cash=cash+(
      SELECT SUM(CASE WHEN side='buy' THEN -amount ELSE amount END)
      FROM paper_settlements s WHERE s.account_id=paper_accounts.id
        AND s.settled=0 AND s.settlement_date<=?
    ), updated_at=datetime('now')
    WHERE (? IS NULL OR id=?) AND EXISTS (
      SELECT 1 FROM paper_settlements s WHERE s.account_id=paper_accounts.id
        AND s.settled=0 AND s.settlement_date<=?
    )`).bind(today, accountId, accountId, today),
    db.prepare(`UPDATE paper_settlements SET settled=1,settled_at=datetime('now')
      WHERE settled=0 AND settlement_date<=? AND (? IS NULL OR account_id=?)
        AND EXISTS (SELECT 1 FROM paper_accounts a WHERE a.id=paper_settlements.account_id)
    `).bind(today, accountId, accountId),
  ])
  if (rows.length !== 2 || rows.some(row => row.success !== true)) {
    throw new Error('paper_settlement_transaction_incomplete')
  }
  await processCorporateActionsFromSource(env, today)
}
