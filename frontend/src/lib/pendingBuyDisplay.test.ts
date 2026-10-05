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
assert.equal(currentDisplayPrice({...q(90001,100),reference_price:99},q(1000,101),now).reference_price,null)
