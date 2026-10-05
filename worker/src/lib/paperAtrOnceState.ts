import {ATR_ONCE_POLICY,type AtrOnceEvidence} from './paperAtrOnce'
/** Atomic first-signal latch. No pending-run/plan id in the key: a new batch cannot reset a daily veto. */
export async function readAtrOnce(db:D1Database,account:number,date:string,symbol:string):Promise<AtrOnceEvidence|null> {
  const row=await db.prepare('SELECT evidence_json FROM paper_atr_once_v1 WHERE account_id=? AND trade_date=? AND symbol=? AND policy=?')
    .bind(account,date,symbol,ATR_ONCE_POLICY).first<{evidence_json:string}>()
  if(!row) return null
  const value=JSON.parse(row.evidence_json) as AtrOnceEvidence
  if(value.policy!==ATR_ONCE_POLICY || !['unknown','passed','veto'].includes(value.status) || !Number.isFinite(value.firstSignalMs))
    throw new Error('swing_atr_state_invalid')
  return value
}
export async function latchAtrOnce(db:D1Database,account:number,date:string,symbol:string,value:AtrOnceEvidence):Promise<AtrOnceEvidence> {
  if(!value.firstSignalMs) return value
  const result=await db.prepare(`INSERT INTO paper_atr_once_v1(account_id,trade_date,symbol,policy,first_signal_ms,status,evidence_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,trade_date,symbol,policy) DO UPDATE SET status=excluded.status,evidence_json=excluded.evidence_json
    WHERE paper_atr_once_v1.status='unknown' AND paper_atr_once_v1.first_signal_ms=excluded.first_signal_ms`)
    .bind(account,date,symbol,ATR_ONCE_POLICY,value.firstSignalMs,value.status,JSON.stringify(value)).run()
  if(!result.success) throw new Error('swing_atr_state_write_failed')
  const saved=await readAtrOnce(db,account,date,symbol)
  if(!saved || saved.firstSignalMs!==value.firstSignalMs) throw new Error('swing_atr_first_signal_conflict')
  return saved
}
