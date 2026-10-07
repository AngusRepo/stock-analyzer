import assert from 'node:assert/strict'
import {completedPendingBuys,currentDisplayPrice} from './pendingBuyDisplay'
const now=Date.parse('2026-10-02T02:00:00Z')
const q=(age:number,price=100)=>({price,as_of:new Date(now-age).toISOString()})
assert.deepEqual(completedPendingBuys({completedBuys:[{symbol:'2330',execution_status:'cancelled',watch_points:['execution:cancelled:chase_limit']},{symbol:'0050',execution_status:'pending'}]}).map(x=>x.symbol),['2330'])
assert.deepEqual(completedPendingBuys({}),[])
assert.equal(currentDisplayPrice(q(1000,102),q(60000,100),now).price,102)
assert.equal(currentDisplayPrice(q(5000,100),q(1000,101),now).price,101)
assert.equal(currentDisplayPrice(null,q(60000),now).price,100)
assert.equal(currentDisplayPrice(null,q(90001),now),null)
assert.equal(currentDisplayPrice(q(-1),null,now),null)
console.log('terminal history and display freshness passed')


assert.equal(currentDisplayPrice({...q(5000,100),reference_price:99},q(1000,101),now).reference_price,99)
assert.equal(currentDisplayPrice({...q(90001,100),reference_price:99},q(1000,101),now).reference_price,99)

const now3004=Date.parse('2026-10-07T03:46:11.290Z')
const quote3004={price:121,reference_price:null,as_of:'2026-10-07T03:46:10.400Z'}
const daily3004={previous_close:121.5,assessed_at_ms:Date.parse('2026-10-07T03:45:13Z')}
const display3004=currentDisplayPrice(null,quote3004,now3004,daily3004)
assert.equal(display3004.price,121)
assert.equal(display3004.reference_price,121.5)
assert.equal(display3004.reference_source,'daily_assessment')
assert.equal(((display3004.price/display3004.reference_price-1)*100).toFixed(2),'-0.41')
assert.equal(currentDisplayPrice(null,quote3004,now3004,{previous_close:121.5,checked_at:'2026-10-07 03:45:13'}).reference_price,121.5,
  'D1 checked_at is UTC, independent of browser timezone')
for(const daily of [
  {...daily3004,assessed_at_ms:Date.parse('2026-10-06T03:45:13Z')},
  {...daily3004,assessed_at_ms:now3004+1},
  {...daily3004,assessed_at_ms:NaN},
  {...daily3004,assessed_at_ms:-1e20},
  {...daily3004,assessed_at_ms:'not-time'},
  {previous_close:121.5},
  {...daily3004,previous_close:0},
  {...daily3004,previous_close:NaN},
  {...daily3004,previous_close:'121.5'},
])assert.equal(currentDisplayPrice(null,quote3004,now3004,daily).reference_price,null,'only valid same-day baseline may fill missing reference')
assert.equal(currentDisplayPrice(null,quote3004,now3004+90_001,daily3004),null,'daily reference never refreshes an old quote')
assert.equal(currentDisplayPrice(null,null,now3004,daily3004),null,'a baseline cannot invent a current quote')
assert.equal(currentDisplayPrice({...quote3004,reference_price:120},null,now3004,daily3004).reference_price,120,'fresh broker reference has priority')
assert.equal(currentDisplayPrice({...quote3004,reference_price:121.5,as_of:'2026-10-06T03:46:10Z'},quote3004,now3004).reference_price,null,
  'previous-session quote reference must not carry into a new trading day')
