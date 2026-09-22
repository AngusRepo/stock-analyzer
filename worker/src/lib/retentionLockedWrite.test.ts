import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeEvidenceArtifact } from './artifactLifecycle'
function fixture(mode='normal') {
 const objects=new Map<string,string>();let puts=0;let manifests=0
 const db={prepare(){return {bind(){return this},async run(){manifests++}}}}
 const bucket={async get(key:string){const body=objects.get(key);return body===undefined?null:{text:async()=>body}},
  async put(key:string,body:string,options:any){puts++;assert.equal(options.onlyIf.etagDoesNotMatch,'*')
   if(mode==='missing')throw new Error('unavailable')
   if(objects.has(key))throw new Error('locked')
   objects.set(key,mode==='corrupt'?'wrong bytes':body)
   if(mode==='race'||mode==='corrupt')throw new Error('locked race')
  }}
 const input={domain:'retention_test',businessDate:'2026-09-22',producerRunId:'test',retentionClass:'ten_year_cold_archive' as const,schemaVersion:'fixture',payload:{rows:[{id:1}]},rowCount:1}
 return {env:{DB:db as any,ARTIFACTS:bucket as any},input,objects,puts:()=>puts,manifests:()=>manifests}
}
test('ten-year retry reuses verified bytes without overwriting a locked object',async()=>{
 const f=fixture();const first=await writeEvidenceArtifact(f.env,f.input);const second=await writeEvidenceArtifact(f.env,f.input)
 assert.equal(first.checksum,second.checksum);assert.equal(f.puts(),1);assert.equal(f.objects.size,1)
})
test('identical concurrent winner under bucket lock is verified and accepted',async()=>{
 const f=fixture('race');await writeEvidenceArtifact(f.env,f.input);assert.equal(f.manifests(),1)
})
for(const mode of ['missing','corrupt'])test(`cold write ${mode} cannot publish a manifest`,async()=>{
 const f=fixture(mode);await assert.rejects(writeEvidenceArtifact(f.env,f.input));assert.equal(f.manifests(),0)
})
