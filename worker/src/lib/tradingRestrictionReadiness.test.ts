import assert from 'node:assert/strict'
import {readOfficialRestrictionReadiness} from './tradingRestrictionReadiness'
import {officialTradingRestrictionsRefreshComplete} from './updateOrchestrator'
const date='2026-10-08',prefix='market:trading_restrictions:'
async function main() {
  for(const mode of ['dated','legacy','partial','wrong-date','wrong-time','missing']) {
    const rows=new Map<string,any>()
    if(mode!=='missing') {
      rows.set(prefix+'checked_at','current')
      rows.set(prefix+'refresh_status',{status:'success',trade_date:date,checked_at:'current'})
    }
    if(['dated','partial','wrong-date','wrong-time'].includes(mode)) {
      rows.set(prefix+'refresh_status:'+date,{status:'success',trade_date:mode==='wrong-date'?'2026-10-12':date,checked_at:'archive'})
      if(mode!=='partial') rows.set(prefix+'checked_at:'+date,mode==='wrong-time'?'other':'archive')
    }
    const before=JSON.stringify([...rows])
    const kv={get:async(k:string)=>rows.get(k)??null} as unknown as KVNamespace
    const out=await readOfficialRestrictionReadiness(kv,date)
    assert.equal(officialTradingRestrictionsRefreshComplete(out.refresh,out.checkedAt,date),['dated','legacy'].includes(mode),mode)
    assert.equal(JSON.stringify([...rows]),before)
    if(mode==='dated') assert.equal(out.checkedAt,'archive')
  }
  console.log('dated readiness: 6 cases passed; no KV writes')
}
void main()
