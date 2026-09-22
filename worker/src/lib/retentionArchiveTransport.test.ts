import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { sha256Text } from './datasetSnapshots'
const raw='{"schema_version":"d1-retention-hot-window-drain-v1","payload":{"rows":[]}}'
const request=(input: unknown,token='test-service')=>new Request('https://local.test/api/internal/evidence-artifacts/retention/read',{
 method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input),
})
async function bindings(options: {exists?:boolean;size?:number;objectSize?:number;checksum?:string;objectMissing?:boolean}={}) {
 const checksum=await sha256Text(raw);let reads=0
 const db={prepare:()=>({bind:()=>({first:async()=>options.exists===false?null:{artifact_id:'artifact:test',r2_key:'registered/key',checksum:options.checksum??checksum,byte_size:options.size??Buffer.byteLength(raw)}})})}
 const env={DB:db,OPS_DB:db,MULTI_D1_ACTIVE_DOMAINS:'ops',MULTI_D1_STRICT:'true',STOCKVISION_AUTH_TOKEN:'test-service',ARTIFACTS:{get:async(key:string)=>{
  reads++;assert.equal(key,'registered/key');return options.objectMissing?null:{size:options.objectSize??Buffer.byteLength(raw),text:async()=>raw}
 }}}
 return {env:env as any,reads:()=>reads}
}
test('retention transport authenticates, rejects arbitrary keys and returns checksum-verified original bytes',async()=>{
 const b=await bindings()
 assert.equal((await adminControlRoutes.fetch(request({artifact_id:'artifact:test'},'wrong'),b.env)).status,401)
 assert.equal((await adminControlRoutes.fetch(request({artifact_id:'artifact:test',r2_key:'arbitrary'}),b.env)).status,400)
 assert.equal(b.reads(),0)
 const response=await adminControlRoutes.fetch(request({artifact_id:'artifact:test'}),b.env)
 assert.equal(response.status,200);assert.equal(await response.text(),raw);assert.equal(b.reads(),1)
})
for(const [name,options,status] of [
 ['manifest missing',{exists:false},404],['oversized',{size:8*1024*1024+1},413],
 ['size mismatch',{objectSize:1},409],['checksum mismatch',{checksum:'sha256:'+'0'.repeat(64)},409],
 ['object missing',{objectMissing:true},404],
] as const) test(`retention transport fails closed: ${name}`,async()=>{
 const b=await bindings(options)
 assert.equal((await adminControlRoutes.fetch(request({artifact_id:'artifact:test'}),b.env)).status,status)
})
