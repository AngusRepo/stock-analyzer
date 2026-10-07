import assert from 'node:assert/strict'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { buildMarketRegimeState,persistMarketRegimeState,readMarketRegimeStateHistory,readLatestMarketRegimeStateOnOrBefore } from './marketRegimeState'
async function main(){const f=l4NativeFixture();try{
 const db=f.env.MARKET_DB,date='2026-09-11'
 const first=buildMarketRegimeState({label:'volatile',runDate:date,computedAt:date+'T10:00:00Z'})
 const next=buildMarketRegimeState({label:'bear_market',runDate:date,computedAt:'2026-09-14T00:00:00Z'})
 await withPaperExecutionScope({...f.ports,nowMs:Date.parse(date+'T10:01:00Z')},()=>persistMarketRegimeState(f.env.KV,first,{historyDb:db}))
 const old=f.sqls.market.prepare('SELECT * FROM market_regime_state_history_v1 WHERE run_date=?').get(date) as any
 await withPaperExecutionScope({...f.ports,nowMs:Date.parse('2026-09-14T00:01:00Z')},()=>persistMarketRegimeState(f.env.KV,next,{historyDb:db}))
 assert.deepEqual(f.sqls.market.prepare('SELECT * FROM market_regime_state_history_v1 WHERE run_date=?').get(date),old)
 assert.equal((f.sqls.market.prepare('SELECT COUNT(*) AS n FROM market_regime_state_revisions_v1').get() as any).n,2)
 assert.equal((await readMarketRegimeStateHistory(db,date,date+'T10:02:00Z'))?.label,'volatile')
 // Computation precedes receipt: the new observation must not appear until publication.
 assert.equal((await readMarketRegimeStateHistory(db,date,'2026-09-14T00:00:30Z'))?.label,'volatile')
 assert.equal((await readMarketRegimeStateHistory(db,date,'2026-09-14T00:02:00Z'))?.label,'bear_market')
 assert.equal((await readLatestMarketRegimeStateOnOrBefore(db,'2026-09-14','2026-09-14T00:02:00Z'))?.label,'bear_market')
 assert.equal(await readMarketRegimeStateHistory(db,date,date+'T09:59:59Z'),null)
 // An invalid future computation is rejected before touching D1 or KV.
 await assert.rejects(()=>withPaperExecutionScope({...f.ports,nowMs:Date.parse('2026-09-14T00:01:00Z')},()=>persistMarketRegimeState(f.env.KV,{...next,computed_at:'2026-09-15T00:00:00Z'},{historyDb:db})),/publication_clock_invalid/)
 // A failure in the revision insert rolls back its legacy first observation too.
 const fault={...db,batch:async(items:any[])=>db.batch([items[0],{run:async()=>{throw Error('revision_write_failure')}}])}
 await assert.rejects(()=>persistMarketRegimeState(f.env.KV,{...first,run_date:'2026-09-10'},{historyDb:fault}),/revision_write_failure/)
 assert.equal((f.sqls.market.prepare("SELECT COUNT(*) AS n FROM market_regime_state_history_v1 WHERE run_date='2026-09-10'").get() as any).n,0)
 assert.equal(JSON.parse(f.kvs.get('market_regime_state')!).label,'bear_market')
 f.sqls.market.prepare('UPDATE market_regime_state_revisions_v1 SET state_json=? WHERE computed_at=?').run('{}',next.computed_at)
 await assert.rejects(()=>readMarketRegimeStateHistory(db,date,'2026-09-14T00:02:00Z'),/checksum_mismatch/)
 console.log('PASS: revisions preserve legacy history, same-date refresh, as-of computation/receipt, future rejection, atomic rollback and corruption detection')
}finally{f.close()}}
main().catch(e=>{console.error(e);process.exitCode=1})
