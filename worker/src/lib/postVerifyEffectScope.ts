// Post-verify effect scope: the per-task guards and owner acks that notify/controller
// clients consult. A leaf module (no D1, scheduler tickets, clock or random ids) so the
// native Paper bundle can import it without pulling the checkpoint runtime.
const effectGuards = new WeakMap<object, () => Promise<void>>()
export type EffectAck = { kind: string; operation: string; request_sha256: string; response_sha256: string; owner?: Record<string, unknown> }
const effectAcks = new WeakMap<object, EffectAck[]>()
const controllerResponses = new WeakMap<object, Map<string, unknown>>()
export const isPostVerifyTaskScope = (env: object): boolean => effectGuards.has(env)
export const postVerifyControllerResponse = (env: object, path: string): unknown => controllerResponses.get(env)?.get(path)

export async function assertPostVerifyEffectAllowed(env: object): Promise<void> {
  await effectGuards.get(env)?.()
}

export async function recordPostVerifyOwnerAck(env: object, kind: string, operation: string, request: unknown,
  response: unknown, owner?: Record<string, unknown>): Promise<void> {
  const acks = effectAcks.get(env)
  if (!acks) return
  if(kind==='controller')controllerResponses.get(env)?.set(operation,response)
  const requestDescriptor=await postVerifyAckDescriptor(request),responseDescriptor=await postVerifyAckDescriptor(response)
  const opaque=(value:any):boolean=>Boolean(value&&typeof value==='object'&&(value.content_unverified===true||Object.values(value).some(opaque)))
  if(kind==='storage'||kind==='artifact'){
    const observed=responseDescriptor&&typeof responseDescriptor==='object'?responseDescriptor:{}
    const provider=Object.fromEntries(['key','r2_key','etag','size','byte_size','checksums','checksum','artifact_id','generation']
      .filter(key=>observed[key]!==undefined).map(key=>[key,observed[key]]))
    owner={...owner,ack_digest_kind:'typed-descriptor-sha256',request_content_verified:!opaque(requestDescriptor),
      response_content_verified:!opaque(responseDescriptor),...(Object.keys(provider).length?{provider}:{}),
      requires_artifact_readback:opaque(requestDescriptor)}
  }
  acks.push({kind,operation,request_sha256:await postVerifyDigest(requestDescriptor),response_sha256:await postVerifyDigest(responseDescriptor),owner})
}

/** Hash binary bytes directly. Never JSON-expand typed arrays or consume streams. */
export async function postVerifyAckDescriptor(value:unknown):Promise<any>{
  if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)){
    const bytes=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
    const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('')
    return {kind:'binary',byte_length:bytes.byteLength,content_sha256:checksum}
  }
  const isBlob=typeof Blob!=='undefined'&&value instanceof Blob
  if((typeof ReadableStream!=='undefined'&&value instanceof ReadableStream)||isBlob)return {kind:isBlob?'blob':'stream',
      byte_length:isBlob?(value as Blob).size:null,content_sha256:null,content_unverified:true}
  if(Array.isArray(value))return Promise.all(value.map(postVerifyAckDescriptor))
  if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value)
    .filter(([,item])=>typeof item!=='function').map(async([key,item])=>[key,await postVerifyAckDescriptor(item)])))
  return value===undefined?{kind:'undefined'}:value
}

export async function postVerifyOwnerAckEvidence(env: object): Promise<Record<string, unknown>> {
  const acks = effectAcks.get(env) ?? []
  const owners=acks.filter(ack=>ack.owner&&!['d1','storage'].includes(ack.kind)).map(({kind,operation,request_sha256,response_sha256,owner})=>({kind,operation,request_sha256,response_sha256,owner}))
  const groups=new Map<string,EffectAck[]>()
  for(const ack of acks.filter(ack=>['d1','storage'].includes(ack.kind))){
    const key=`${ack.kind}:${ack.operation}:${String(ack.owner?.table??'batch')}`
    const group=groups.get(key)??[]
    group.push(ack);groups.set(key,group)
  }
  for(const group of groups.values()){
    const providers=group.map(row=>row.owner?.provider).filter(Boolean)
    owners.push({kind:group[0].kind,operation:group[0].operation,
    request_sha256:await postVerifyDigest(group.map(row=>row.request_sha256)),response_sha256:await postVerifyDigest(group.map(row=>row.response_sha256)),
    owner:{table:group[0].owner?.table,successful:group.every(row=>row.owner?.successful===true),ack_count:group.length,
      ...(group[0].kind==='storage'?{ack_digest_kind:'typed-descriptor-sha256',
        request_content_verified:group.every(row=>row.owner?.request_content_verified===true),
        response_content_verified:group.every(row=>row.owner?.response_content_verified===true),
        requires_artifact_readback:group.some(row=>row.owner?.request_content_verified===false),
        ...(providers.length?{provider_objects:providers.slice(0,16),provider_count:providers.length,provider_descriptors_sha256:await postVerifyDigest(providers)}:{})}:{})}})
  }
  return { schema:'post-verify-owner-acks-v1',ack_count:acks.length,ack_chain_sha256:await postVerifyDigest(acks),
    // Only compact semantic contracts leave the scope; SQL payloads, notification
    // contents and response bytes are represented by their exact digest.
    owners,
    operations:[...new Set(acks.map(ack=>`${ack.kind}:${ack.operation}`))].sort() }
}

export async function postVerifyDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

/** Register a scoped environment created by createPostVerifyTaskCheckpoints. */
export function registerPostVerifyScope(scoped: object, assertActive: () => Promise<void>, acks: EffectAck[]): void {
  effectGuards.set(scoped, assertActive)
  effectAcks.set(scoped, acks)
  controllerResponses.set(scoped, new Map())
}
