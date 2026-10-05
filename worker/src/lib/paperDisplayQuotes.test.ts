import assert from 'node:assert/strict'
import {displayQuoteSymbols,projectDisplayQuotes} from './paperDisplayQuotes'
const now=Date.parse('2026-10-02T02:00:00Z')
assert.deepEqual(displayQuoteSymbols('2330,0050,2330'),['0050','2330'])
assert.throws(()=>displayQuoteSymbols('../secret'))
assert.throws(()=>displayQuoteSymbols(Array.from({length:21},(_,i)=>String(1000+i)).join(',')))
const quote=(ms:number)=>({price:100,reference_price:99,source_time:new Date(ms).toISOString()})
assert.equal(projectDisplayQuotes({'2330':quote(now-1000)},['2330'],now)['2330'].reference_price,99)
for(const q of [quote(now-90001),quote(now+1),{price:100},{price:100,source_time:'invalid'}])
  assert.deepEqual(projectDisplayQuotes({'2330':q},['2330'],now),{},'stale/unknown quote must not look fresh')
assert.deepEqual(projectDisplayQuotes({'2330':quote(now)},['0050'],now),{})
console.log('paper display quote validation passed')
