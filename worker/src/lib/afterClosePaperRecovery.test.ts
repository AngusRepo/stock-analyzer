import assert from 'node:assert/strict'
import test from 'node:test'
import { afterClosePaperRecovery } from './afterClosePaperRecovery'
import { premarketWork } from './premarketEventWork'

const env = {PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',LIVE_EXECUTION_CLIENT_ENABLED:'0'} as any
const input = {signal_date:'2026-10-08',l3_receipt:{run_date:'2026-10-08'},morning_context:{trade_date:'2026-10-12'}}
test('recovery expires at midnight and never admits preclose, another signal, day or live configuration',()=>{
  const late = Date.parse('2026-10-12T16:00:00+08:00')
  assert.equal(afterClosePaperRecovery(env,'2026-10-12',input,late),true)
  for (const at of ['2026-10-12T13:29:59+08:00','2026-10-13T00:00:00+08:00'])
    assert.equal(afterClosePaperRecovery(env,'2026-10-12',input,Date.parse(at)),false)
  assert.equal(afterClosePaperRecovery(env,'2026-10-13',input,late),false)
  assert.equal(afterClosePaperRecovery(env,'2026-10-12',{...input,signal_date:'2026-10-12'},late),false)
  assert.equal(afterClosePaperRecovery({...env,LIVE_EXECUTION_CLIENT_ENABLED:'1'},'2026-10-12',input,late),false)
})
test('after-close recovery publishes through original decision owner without claiming corporate settlement',async()=>{
  const calls:string[]=[]
  const work=premarketWork(env,'2026-10-12',{
    afterClosePaperRecovery:()=>true,
    warmup:async()=>{calls.push('warmup')},
    ensurePaperCorporateSource:async()=>{throw new Error('must not fabricate preopen source')},
    settle:async()=>{throw new Error('must not claim settlement')},
    dispatchSinglePlan:async()=>{calls.push('allocate');return 'plan'},
    materializePaperPendingDecision:async()=>{calls.push('pending');return 'recovered_missing_morning_decision'},
    recoverPaperMorningSetup:async()=>{throw new Error('preopen only')},
  })
  const setup=await work('setup',input,async()=>{})
  assert.equal(setup.receipt.accounting_status,'deferred_after_close')
  const allocate=await work('allocate',setup.receipt,async()=>{})
  assert.equal(allocate.next,'publish:0')
  assert.equal(allocate.receipt.accounting_status,'deferred_after_close')
  assert.deepEqual(calls,['warmup','allocate','pending'])
})
