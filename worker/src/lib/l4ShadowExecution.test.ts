import test from 'node:test'
import assert from 'node:assert/strict'
import {l4ShadowExecution} from './l4ShadowExecution'
test('registered shadow task is isolated, no registry is skipped, invalid/missing days fail visibly',async()=>{
  const original=globalThis.fetch
  const env:any={ML_CONTROLLER_URL:'https://controller.invalid',ML_CONTROLLER_SECRET:'test-secret'}
  let receipt:any={status:'ok',accounts:[{status:'collecting'}],production_effect:false,outer_acceptance_credit:0}
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://controller.invalid/paper/l4-shadow-execution-tick')
    assert.equal(init?.method,'POST');assert.equal((init?.headers as any)['X-Controller-Token'],'test-secret')
    assert.deepEqual(Object.keys(JSON.parse(init!.body as string)),['session_date'])
    return new Response(JSON.stringify(receipt))
  }
  try{
    assert.match(await l4ShadowExecution(env),/accounts=1/)
    for(const bad of [{...receipt,status:'failed'},{...receipt,production_effect:true},
      {...receipt,outer_acceptance_credit:1},{...receipt,accounts:[{status:'awaiting_daily_inputs'}]},
      {...receipt,accounts:[{status:'failed'}]},{...receipt,status:'awaiting_registry'}]){
      const good=receipt;receipt=bad;await assert.rejects(l4ShadowExecution(env),/l4_shadow_execution_/);receipt=good
    }
    receipt={...receipt,status:'awaiting_registry',accounts:[]};assert.match(await l4ShadowExecution(env),/^SKIPPED:/)
  }finally{globalThis.fetch=original}
})
