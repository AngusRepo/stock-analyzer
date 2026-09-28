import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendGroup } from './groupedRows'
test('group append preserves insertion order, values and references without copying prefixes',()=>{
 const old=new Map<string,object[]>(),next=new Map<string,object[]>()
 const inputs=Array.from({length:12000},(_,i)=>({group:String(i%4),i,value:i%7===0?null:i/3}))
 for(const row of inputs){old.set(row.group,[...(old.get(row.group)??[]),row]);appendGroup(next,row.group,row)}
 assert.deepEqual(next,old)
 const before=next.get('0');const row={group:'0',i:12000,value:1};appendGroup(next,'0',row)
 assert.equal(before,next.get('0'));assert.equal(next.get('0')!.at(-1),row)
})
