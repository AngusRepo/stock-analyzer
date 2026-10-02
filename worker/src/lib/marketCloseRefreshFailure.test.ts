import assert from 'node:assert/strict'
import test from 'node:test'
import {l4NativeFixture} from './l4NativeFixture.testSupport'
import {withPaperExecutionScope} from './paperExecutionScope'
import {runMarketCloseRefresh} from './updateOrchestrator'

test('finished incomplete close refresh records error and rejects for scheduler',async()=>{
 const f=l4NativeFixture()
 try {
  f.env.OFFICIAL_SUPPLEMENTAL_FETCH_MODE='disabled'
  f.ports.fetchFrozen=async()=>new Response('{}',{status:503})
  await withPaperExecutionScope(f.ports,async()=>{
   await assert.rejects(runMarketCloseRefresh(f.env,false,'2026-10-02'),/attempt finished; retry required/)
  })
  const receipt=JSON.parse(f.kvs.get('scheduler:run:market-close-refresh:2026-10-02')!)
  assert.equal(receipt.status,'error')
  assert.equal(f.kvs.has('cron:market-close-refresh:2026-10-02'),false)
 } finally {f.close()}
})
