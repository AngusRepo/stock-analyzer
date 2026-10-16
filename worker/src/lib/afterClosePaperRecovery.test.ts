import assert from 'node:assert/strict'
import test from 'node:test'
import { afterClosePaperRecovery } from './afterClosePaperRecovery'
import { premarketWork } from './premarketEventWork'

const env = {PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',LIVE_EXECUTION_CLIENT_ENABLED:'0'} as any
const input = {signal_date:'2026-10-08',l3_receipt:{run_date:'2026-10-08'},morning_context:{trade_date:'2026-10-12'}}

test('October 16 authorized recovery is exact-date Paper publication with both live switches off',()=>{
  const e={...env,LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'0'}
  const i={signal_date:'2026-10-15',l3_receipt:{run_date:'2026-10-15'},morning_context:{trade_date:'2026-10-16'}}
  const now=Date.parse('2026-10-16T12:50:00+08:00')
  assert.equal(afterClosePaperRecovery(e,'2026-10-16',i,now),true)
  for(const at of ['2026-10-16T08:59:59+08:00','2026-10-17T00:00:00+08:00'])
    assert.equal(afterClosePaperRecovery(e,'2026-10-16',i,Date.parse(at)),false)
  for(const changed of [{...e,LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'1'},
      {...e,LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:undefined},{...e,LIVE_EXECUTION_CLIENT_ENABLED:'1'},
      {...e,PAPER_DAILY_PLAN_OWNER:'legacy'}])assert.equal(afterClosePaperRecovery(changed,'2026-10-16',i,now),false)
  for(const changed of [{...i,signal_date:'2026-10-14'},
      {...i,l3_receipt:{run_date:'2026-10-14'}},{...i,morning_context:{trade_date:'2026-10-17'}}])
    assert.equal(afterClosePaperRecovery(e,'2026-10-16',changed,now),false)
  assert.equal(afterClosePaperRecovery(e,'2026-10-17',i,now),false)
})

test('October 16 missing preopen evidence stays explicit while original pending decision owner runs',async()=>{
  const calls:string[]=[]
  const work=premarketWork(env,'2026-10-16',{
    afterClosePaperRecovery:()=>true,warmup:async()=>{},
    ensurePaperCorporateSource:async()=>{throw new Error('no fabricated source')},
    settle:async()=>{throw new Error('no fabricated settlement')},
    recoverPaperMorningSetup:async()=>{throw new Error('preopen only')},
    dispatchSinglePlan:async()=>{calls.push('allocate');return 'plan'},
    materializePaperPendingDecision:async()=>{calls.push('pending');return 'recovered_missing_morning_decision'},
  })
  const setup=await work('setup',{},async()=>{})
  assert.equal(setup.receipt.accounting_status,'deferred_missing_preopen_source')
  assert.equal(setup.receipt.execution_status,'requires_accounting_reconciliation')
  const next=await work('allocate',setup.receipt,async()=>{})
  assert.equal(next.next,'publish:0')
  assert.equal(next.receipt.accounting_status,'deferred_missing_preopen_source')
  assert.deepEqual(calls,['allocate','pending'])
})

test('October 13 publication recovery keeps actual intraday time and cannot authorize execution',()=>{
  const e={...env,LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'0'}
  const i={signal_date:'2026-10-12',l3_receipt:{run_date:'2026-10-12'},morning_context:{trade_date:'2026-10-13'}}
  const now=Date.parse('2026-10-13T10:00:00+08:00')
  assert.equal(afterClosePaperRecovery(e,'2026-10-13',i,now),true)
  for(const at of ['2026-10-13T08:59:59+08:00','2026-10-14T00:00:00+08:00'])
    assert.equal(afterClosePaperRecovery(e,'2026-10-13',i,Date.parse(at)),false)
  for(const changed of [{...e,LIVE_EXECUTION_SUBMIT_GUARD_ENABLED:'1'},{...e,LIVE_EXECUTION_CLIENT_ENABLED:'1'},
      {...e,PAPER_DAILY_PLAN_OWNER:'legacy'}])assert.equal(afterClosePaperRecovery(changed,'2026-10-13',i,now),false)
  assert.equal(afterClosePaperRecovery(e,'2026-10-13',{...i,signal_date:'2026-10-09'},now),false)
  assert.equal(afterClosePaperRecovery(e,'2026-10-13',{...i,l3_receipt:{run_date:'2026-10-09'}},now),false)
})

test('October 13 missing preopen evidence does not fabricate settlement or block decision publication',async()=>{
  const calls:string[]=[]
  const work=premarketWork(env,'2026-10-13',{
    afterClosePaperRecovery:()=>true,warmup:async()=>{},
    ensurePaperCorporateSource:async()=>{throw new Error('no fabricated source')},
    settle:async()=>{throw new Error('no fabricated settlement')},
    dispatchSinglePlan:async()=>{calls.push('allocate');return 'plan'},
    materializePaperPendingDecision:async()=>{calls.push('pending');return 'recovered_missing_morning_decision'},
  })
  const setup=await work('setup',{},async()=>{})
  assert.equal(setup.receipt.accounting_status,'deferred_missing_preopen_source')
  assert.equal(setup.receipt.execution_status,'requires_accounting_reconciliation')
  const next=await work('allocate',setup.receipt,async()=>{})
  assert.equal(next.next,'publish:0')
  assert.deepEqual(calls,['allocate','pending'])
})
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
