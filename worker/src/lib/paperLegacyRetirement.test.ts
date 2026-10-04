import assert from 'node:assert/strict'
import test from 'node:test'
import { paper } from '../routes/paper'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import { runL4AlphaEvRefresh, runL4DistributionRefresh } from './controllerResearchWorkflows'
import type { Bindings } from '../types'

for(const swing of [true,false]) test(`positions retain S12 readers only for legacy holdings: swing=${swing}`,async()=>{
  const f=l4NativeFixture()
  try {
    f.env.STOCKVISION_AUTH_TOKEN='fixture-only'
    const lifecycle=JSON.stringify({version:'canonical_trade_lifecycle_v1',
      ...(swing?{swing:{policy:SWING_POLICY_VERSION,entryPrice:20,entryOrLow:19,entryDate:'2026-10-01'}}:{})})
    f.sqls.paper.prepare('INSERT INTO paper_positions(account_id,symbol,shares,avg_cost,trade_lifecycle_json) VALUES(1,?,?,?,?)').run('2330',1000,20,lifecycle)
    let reads=0
    for(const db of [f.env.PAPER_DB,f.env.LEARNING_DB]) {
      const prepare=db.prepare.bind(db)
      db.prepare=(sql:string)=>{
        if(sql.includes('s12_')){reads++; if(swing) throw Error('swing must not query legacy S12 tables')}
        return prepare(sql)
      }
    }
    const res=await paper.request('/positions',{headers:{Authorization:'Bearer fixture-only'}},f.env)
    assert.equal(res.status,200,await res.clone().text())
    const out=await res.json() as any
    if(swing){assert.equal(reads,0);assert.equal(out.positions[0].s12_holding_defense,null);assert.equal(out.positions[0].s12_near_pressure_price,null);assert.equal(out.positions[0].tp1_price,null)}
    else assert.ok(reads>0,'legacy history must still be read')
  } finally {f.close()}
})

test('missing L4 config cannot revive old alpha-EV training endpoint',async()=>{
  const original=globalThis.fetch
  globalThis.fetch=async()=>{throw Error('unexpected dispatch')}
  try {
    const env={KV:{get:async()=>null}} as unknown as Bindings
    await assert.rejects(runL4AlphaEvRefresh(env,'2026-10-04'),/legacy_refresh_retired/)
  } finally {globalThis.fetch=original}
})

test('standalone L4 schedule cannot dispatch for old, missing or current configurations',async()=>{
  const original=globalThis.fetch
  globalThis.fetch=async()=>{throw Error('unexpected dispatch')}
  try {
    for(const policy of [null,{}, {operating_mode:'old'}, {operating_mode:'single_b_tabpack_v1',strategy_role:'A',scope:'paper'}]) {
      const env={KV:{get:async()=>({l4Distribution:policy})}} as unknown as Bindings
      await assert.rejects(runL4DistributionRefresh(env,'2026-10-04','monthly'),/independent_refresh_retired/)
    }
    const env={KV:{get:async()=>({l4Distribution:{operating_mode:'single_b_tabpack_v1',strategy_role:'B',scope:'paper'}})}} as unknown as Bindings
    assert.match(await runL4DistributionRefresh(env,'2026-10-04','monthly'),/^skipped/)
  } finally {globalThis.fetch=original}
})
