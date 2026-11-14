import { SECOND_BREAKOUT_POLICY, recoveryDeadline, type SecondBreakoutEvidence } from './paperSecondBreakout'
export async function readSecondBreakout(db:D1Database,account:number,date:string,symbol:string):Promise<SecondBreakoutEvidence|null> {
  const row=await db.prepare('SELECT evidence_json FROM paper_second_breakout_state_v2 WHERE account_id=? AND trade_date=? AND symbol=? AND policy=?')
    .bind(account,date,symbol,SECOND_BREAKOUT_POLICY).first<{evidence_json:string}>()
  if(!row)return null
  const value=JSON.parse(row.evidence_json) as SecondBreakoutEvidence
  if(value.policy!==SECOND_BREAKOUT_POLICY || !['unknown','weak_waiting','passed'].includes(value.status)
    || !Number.isFinite(value.firstSignalMs) || !Number.isFinite(value.evaluatedMs)) throw new Error('swing_second_breakout_state_invalid')
  return value
}
export async function latchSecondBreakout(db:D1Database,account:number,date:string,symbol:string,value:SecondBreakoutEvidence):Promise<SecondBreakoutEvidence> {
  if(!value.firstSignalMs)return value
  const statements=[db.prepare(`INSERT INTO paper_second_breakout_state_v2(account_id,trade_date,symbol,policy,first_signal_ms,evaluated_ms,status,evidence_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,trade_date,symbol,policy) DO UPDATE SET
    evaluated_ms=excluded.evaluated_ms,status=excluded.status,evidence_json=excluded.evidence_json
    WHERE paper_second_breakout_state_v2.status!='passed'
    AND paper_second_breakout_state_v2.first_signal_ms=excluded.first_signal_ms
    AND paper_second_breakout_state_v2.evaluated_ms<=excluded.evaluated_ms`)
    .bind(account,date,symbol,value.policy,value.firstSignalMs,value.evaluatedMs,value.status,JSON.stringify(value)),
    ...value.signals.map(signal=>db.prepare(`INSERT INTO paper_second_breakout_signals_v2(account_id,trade_date,symbol,policy,signal_ms,evidence_json)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM paper_second_breakout_state_v2 WHERE account_id=? AND trade_date=? AND symbol=? AND policy=? AND first_signal_ms=?)
      ON CONFLICT(account_id,trade_date,symbol,policy,signal_ms) DO NOTHING`)
      .bind(account,date,symbol,value.policy,signal.signalMs,JSON.stringify(signal),account,date,symbol,value.policy,value.firstSignalMs))]
  const result=await db.batch(statements)
  if(result.some(r=>!r.success))throw new Error('swing_second_breakout_write_failed')
  const saved=await readSecondBreakout(db,account,date,symbol)
  if(!saved || saved.firstSignalMs!==value.firstSignalMs)throw new Error('swing_atr_first_signal_conflict')
  return saved
}
/**
 * R14: add the authorization to an already-latched passed signal exactly once. The row must still
 * be unauthorized and carry the same first signal and trigger, and nowMs must be before the original
 * recovery deadline (all in the UPDATE); an existing authorization is never replaced.
 */
export async function authorizeLatchedSecondBreakout(db:D1Database,account:number,date:string,symbol:string,value:SecondBreakoutEvidence,nowMs:number):Promise<SecondBreakoutEvidence> {
  if(value.status!=='passed' || !value.authorization || !value.triggerMs || !value.firstSignalMs)return value
  const result=await db.prepare(`UPDATE paper_second_breakout_state_v2 SET evidence_json=?
    WHERE account_id=? AND trade_date=? AND symbol=? AND policy=? AND status='passed' AND first_signal_ms=?
    AND json_extract(evidence_json,'$.authorization') IS NULL AND json_extract(evidence_json,'$.triggerMs')=? AND ?<?`)
    .bind(JSON.stringify(value),account,date,symbol,value.policy,value.firstSignalMs,value.triggerMs,nowMs,recoveryDeadline(date,value.triggerMs)).run()
  if(!result.success)throw new Error('swing_second_breakout_write_failed')
  const saved=await readSecondBreakout(db,account,date,symbol)
  if(!saved || saved.firstSignalMs!==value.firstSignalMs || saved.triggerMs!==value.triggerMs)throw new Error('swing_atr_first_signal_conflict')
  return saved
}
/**
 * R14: whether a saved passed signal that was latched without authorization may still be authorized now.
 * Only before its original recovery deadline; the caller then re-evaluates it even off the bar minute.
 */
export function secondBreakoutLateAuthorizationOpen(saved:SecondBreakoutEvidence|null|undefined,today:string,nowMs:number):boolean {
  return saved?.status==='passed' && !saved.authorization && Boolean(saved.triggerMs) && nowMs<recoveryDeadline(today,saved.triggerMs!)
}
