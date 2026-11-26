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

// A D1 stall or R2 fault must answer a structured, retryable 503 naming the stage,
// never the framework's bare 500.
async function failing(options: {dbErrors?: readonly unknown[]; getError?: unknown; textError?: unknown}) {
 const checksum = await sha256Text(raw)
 let dbCalls = 0, getCalls = 0
 const errors: string[] = []
 const db = {prepare: () => ({bind: () => ({first: async () => {
  dbCalls++
  const error = options.dbErrors?.[dbCalls - 1]
  if (error) throw error
  return {artifact_id: 'artifact:test', r2_key: 'registered/key', checksum, byte_size: Buffer.byteLength(raw)}
 }})})}
 const env = {DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', MULTI_D1_STRICT: 'true', STOCKVISION_AUTH_TOKEN: 'test-service',
  ARTIFACTS: {get: async () => {
   getCalls++
   if (options.getError) throw options.getError
   return {size: Buffer.byteLength(raw), text: async () => { if (options.textError) throw options.textError; return raw }}
  }}}
 return {env: env as any, dbCalls: () => dbCalls, getCalls: () => getCalls, errors}
}
async function send(env: unknown, errors: string[]) {
 const original = console.error
 console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
 try {
  return await adminControlRoutes.fetch(request({artifact_id: 'artifact:test'}), env as any)
 } finally {
  console.error = original
 }
}

test('retention transport retries one transient OPS read and still returns the verified bytes', async () => {
 const b = await failing({dbErrors: [new Error('D1_ERROR: storage operation exceeded timeout')]})
 const response = await send(b.env, b.errors)
 assert.equal(response.status, 200)
 assert.equal(await response.text(), raw)
 assert.equal(b.dbCalls(), 2)
 assert.deepEqual(b.errors, [])
})

for (const [name, options, stage, dbCalls, getCalls] of [
 ['persistent transient OPS read', {dbErrors: [new Error('D1_ERROR: overloaded'), new Error('D1_ERROR: overloaded')]}, 'ops_manifest', 2, 0],
 ['OPS error without the D1_ERROR prefix (not retried)', {dbErrors: [new Error('no such column: byte_size')]}, 'ops_manifest', 1, 0],
 // isTransientD1Reset treats every D1_ERROR as transient, so a permanent D1 error is also retried once.
 ['permanent D1_ERROR OPS read (retried once)', {dbErrors: [new Error('D1_ERROR: no such table: run_artifacts: SQLITE_ERROR'),
  new Error('D1_ERROR: no such table: run_artifacts: SQLITE_ERROR')]}, 'ops_manifest', 2, 0],
 ['R2 get failure', {getError: new Error('R2 internal error (10001)')}, 'r2_get', 1, 1],
 ['R2 body failure', {textError: new Error('stream reset')}, 'r2_body', 1, 1],
] as const) test(`retention transport answers 503 with its stage: ${name}`, async () => {
 const b = await failing(options)
 const response = await send(b.env, b.errors)
 assert.equal(response.status, 503)
 assert.deepEqual(await response.json(), {error: 'retention_artifact_read_transient', stage})
 assert.equal(b.dbCalls(), dbCalls)
 assert.equal(b.getCalls(), getCalls)
 assert.equal(b.errors.length, 1)
 assert.match(b.errors[0], new RegExp(`^\\[retention/read\\] stage=${stage} artifact_id=artifact:test `))
})
