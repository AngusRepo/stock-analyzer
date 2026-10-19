import assert from 'node:assert/strict'
import test from 'node:test'
import { controllerFetch } from './controllerClient'
import { sendReportToChannels } from './notify'
import { createPostVerifyTaskCheckpoints, postVerifyOwnerAckEvidence } from './postVerifyTaskCheckpoint'
import { capturePostVerifyOwnerEvidence, verifyPostVerifyOwnerEvidence } from './postVerifyOwnerEvidence'

// These fixtures exercise actual owner responses and provider delivery checks;
// the checkpoint SQL fixture itself is shared with the main integration suite.
function ackProof(task:string,owners:any[],operations:string[]=[]){return {task,date:'2026-10-16',acks:{schema:'post-verify-owner-acks-v1',ack_count:owners.length,ack_chain_sha256:'a'.repeat(64),owners,operations}}}

test('queue ACK never substitutes a completed artifact status',async()=>{
  const evidence={schema:'post-verify-enqueue-ack-v1',...ackProof('strategy-learning',[
    {kind:'queue',operation:'send',request_sha256:'b'.repeat(64),response_sha256:'c'.repeat(64),owner:{enqueue_acknowledged:true}},
  ])}
  const result={task:'strategy-learning',summary:'triggered queue',status:'triggered' as const,evidence}
  assert.equal(await verifyPostVerifyOwnerEvidence({} as any,'strategy-learning','2026-10-16',result),true)
  assert.equal(result.status,'triggered')
  evidence.acks.owners[0].owner.enqueue_acknowledged=false
  assert.equal(await verifyPostVerifyOwnerEvidence({} as any,'strategy-learning','2026-10-16',result),false)
})

test('HTTP200 owner response without verified semantic contract is rejected',async()=>{
  const evidence={schema:'post-verify-owner-operation-ack-v1',...ackProof('artifact-auto-promotion',[
    {kind:'controller',operation:'/model_pool/artifact_registry/auto_promote',owner:{owner_contract_verified:false,response_status:200}},
  ])}
  assert.equal(await verifyPostVerifyOwnerEvidence({} as any,'artifact-auto-promotion','2026-10-16',
    {task:'artifact-auto-promotion',summary:'HTTP200',status:'success',evidence}),false)
})

test('report proof requires live persisted report content and delivery ack',async()=>{
  const env={DB:{prepare:()=>({bind(){return this},first:async()=>null})}} as any
  const evidence={schema:'post-verify-daily-report-evidence-v1',report_sha256:'b'.repeat(64),...ackProof('daily-report',[
    {kind:'delivery',operation:'discord',owner:{delivery_acknowledged:true}},
  ])}
  assert.equal(await verifyPostVerifyOwnerEvidence(env,'daily-report','2026-10-16',
    {task:'daily-report',summary:'sent',status:'success',evidence}),false)
})

test('normal notification helper keeps legacy best-effort behavior outside checkpoint scope',async()=>{
  const previous=globalThis.fetch
  globalThis.fetch=async()=>new Response('fixture unavailable',{status:503})
  try{
    assert.equal(await sendReportToChannels({KV:{} as any,DISCORD_WEBHOOK_URL:'https://never-network.invalid'},[],'test'),'discord')
  }finally{globalThis.fetch=previous}
})
