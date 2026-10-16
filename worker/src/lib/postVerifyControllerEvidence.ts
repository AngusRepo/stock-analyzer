import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

type Task = 'model-ic-rolling' | 'artifact-auto-promotion'
type Row = Record<string, any>
type Artifact = { artifactId: string; modelName: string; version: string; checksum: string
  kind: 'ic' | 'promotion' | 'decision'; witness: string; effectiveAt?: string; ensembleId?: string; ensembleChecksum?: string; promotionEventId?: string }
type Ensemble = { artifactId: string; trainingRunId: string; payloadChecksum: string; witness: string }
export type PostVerifyControllerEvidence = { schema: 'post-verify-controller-evidence-v1'; task: Task
  businessDate: string; responseChecksum: string; artifacts: Artifact[]; ensembles: Ensemble[]; checksum: string }

function canonical(value: any): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v
  return JSON.stringify(sorted(value))
}
async function textHash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('')
}
const digest = (value: unknown) => textHash(canonical(value))
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const count = (v: unknown, max=500) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max
const checksum = (v: unknown) => typeof v === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(v)

async function registry(env: Bindings, id: string): Promise<Row> {
  if (!id || id.length > 1000) throw new Error('post_verify_controller_artifact_id_invalid')
  const row = await databaseForDataDomain(env, 'learning').prepare(`SELECT artifact_id,model_name,version,checksum,
      training_run_id,candidate_type,artifact_path,state,live_gate_status,promotion_decision,
      json_extract(live_evidence_json,'$.schema_version') ic_schema,
      json_extract(live_evidence_json,'$.evaluated_at') ic_evaluated_at,
      json_extract(live_evidence_json,'$.selection_slot') ic_selection_slot,
      json_extract(live_evidence_json,'$.model_name') ic_model_name,
      json_extract(live_evidence_json,'$.artifact_id') ic_artifact_id,
      json_extract(live_evidence_json,'$.decision') ic_decision
    FROM model_artifact_registry WHERE artifact_id=?`).bind(id).first<Row>()
  if (!row || !row.model_name || !row.version || !checksum(row.checksum)) throw new Error('post_verify_controller_artifact_missing')
  return row
}
function identity(row: Row) {
  return { artifact_id: row.artifact_id, model_name: row.model_name, version: row.version,
    checksum: row.checksum, training_run_id: row.training_run_id, candidate_type: row.candidate_type, artifact_path: row.artifact_path }
}
function icProjection(row: Row) {
  if (row.ic_schema !== 'artifact-live-gate-v1' || row.ic_artifact_id !== row.artifact_id
      || row.ic_model_name !== row.model_name || !Number.isFinite(Date.parse(row.ic_evaluated_at))) {
    throw new Error('post_verify_controller_ic_evidence_missing')
  }
  return { identity: identity(row), schema: row.ic_schema, evaluated_at: row.ic_evaluated_at,
    selection_slot: row.ic_selection_slot, decision: JSON.parse(row.ic_decision) }
}
async function history(env: Bindings, item: Artifact) {
  // The original event remains proof after another legitimate promotion retires
  // it. Never substitute a current champion pointer for this exact event.
  // Project owner identity; model-bearing evidence_json is not downloaded N times.
  const rows = await databaseForDataDomain(env, 'learning').prepare(`SELECT event_id,model_name,version,artifact_id,
      effective_at,source,evidence_grade,
      json_extract(evidence_json,'$.ensemble_artifact_id') ensemble_id,
      json_extract(evidence_json,'$.ensemble_payload_checksum') ensemble_checksum,
      json_extract(evidence_json,'$.training_run_id') training_run_id
    FROM model_champion_history WHERE artifact_id=? AND model_name=? AND version=?
      AND ${item.promotionEventId ? 'event_id=?' : 'effective_at=?'}
      AND source='model_champion_history' AND evidence_grade='exact'`)
    .bind(item.artifactId,item.modelName,item.version,item.promotionEventId ?? item.effectiveAt).all<Row>()
  if (rows?.success === false || !Array.isArray(rows?.results)) {
    throw new Error('post_verify_owner_read_failed:promotion_history')
  }
  if (rows.results.length !== 1) throw new Error('post_verify_controller_promotion_history_missing')
  const row=rows.results[0]
  if (item.ensembleId && (row.ensemble_id !== item.ensembleId || row.ensemble_checksum !== item.ensembleChecksum)) {
    throw new Error('post_verify_controller_promotion_history_mismatch')
  }
  return row
}
async function artifactWitness(env: Bindings, item: Artifact, row?: Row) {
  row ??= await registry(env,item.artifactId)
  if (row.model_name !== item.modelName || row.version !== item.version || row.checksum !== item.checksum) {
    throw new Error('post_verify_controller_artifact_identity_changed')
  }
  return digest(item.kind === 'ic' ? icProjection(row) : item.kind === 'promotion'
    ? {identity:identity(row),history:await history(env,item)}
    : {identity:identity(row),state:row.state,live_gate_status:row.live_gate_status,promotion_decision:row.promotion_decision})
}
async function ensemble(env: Bindings,id: string) {
  const row=await databaseForDataDomain(env,'learning').prepare(`SELECT artifact_id,training_run_id,payload_json,
      payload_checksum,base_artifact_set_checksum,state FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?`).bind(id).first<Row>()
  if (!row || !checksum(row.payload_checksum) || await textHash(row.payload_json) !== row.payload_checksum) {
    throw new Error('post_verify_controller_ensemble_payload_changed')
  }
  const payload=JSON.parse(row.payload_json)
  if (!payload.base_artifacts || !Array.isArray(payload.selected_models)
      || !equal([...payload.selected_models].sort(),Object.keys(payload.base_artifacts).sort())
      || await digest(payload.base_artifacts) !== row.base_artifact_set_checksum) throw new Error('post_verify_controller_ensemble_base_identity_changed')
  const pointer:Ensemble={artifactId:id,trainingRunId:row.training_run_id,payloadChecksum:row.payload_checksum,
    witness:await digest({artifact_id:id,training_run_id:row.training_run_id,payload_checksum:row.payload_checksum,
      base_artifact_set_checksum:row.base_artifact_set_checksum})}
  return {row,payload,pointer}
}

export async function capturePostVerifyControllerEvidence(env: Bindings,task: Task,businessDate: string,response: unknown): Promise<PostVerifyControllerEvidence> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('post_verify_controller_date_invalid')
  const body=response as Row
  if (!body || body.status !== 'ok') throw new Error('post_verify_controller_response_not_complete')
  const artifacts:Artifact[]=[], ensembles:Ensemble[]=[]
  if (task === 'model-ic-rolling') {
    const updates=body.artifact_registry_updates
    if (body.run_date !== businessDate || body.source_of_truth !== 'model_artifact_registry/model_champion_pointers'
        || !count(body.n_rows_total,Number.MAX_SAFE_INTEGER) || !body.per_model_ic || typeof body.per_model_ic !== 'object' || Array.isArray(body.per_model_ic)
        || !updates || updates.status !== 'ok' || !count(updates.selected) || updates.updated !== updates.selected
        || !Array.isArray(updates.updates) || updates.updates.length !== updates.updated
        || !Array.isArray(updates.errors) || updates.errors.length) throw new Error('post_verify_controller_ic_partial_or_date_mismatch')
    for (const update of updates.updates) {
      const row=await registry(env,update.artifact_id), projection=icProjection(row), decision=projection.decision
      if (row.model_name !== update.model_name || row.state !== update.state || row.live_gate_status !== update.live_gate_status
          || row.promotion_decision !== update.promotion_decision || decision.state !== update.state
          || decision.live_gate_status !== update.live_gate_status || decision.promotion_decision !== update.promotion_decision
          || !equal(decision.metrics,update.metrics) || decision.root_cause !== update.root_cause) {
        throw new Error('post_verify_controller_ic_registry_readback_mismatch')
      }
      const item:Artifact={artifactId:row.artifact_id,modelName:row.model_name,version:row.version,checksum:row.checksum,kind:'ic',witness:''}
      item.witness=await artifactWitness(env,item,row);artifacts.push(item)
    }
  } else if (task === 'artifact-auto-promotion') {
    if (body.readback_verified !== true || !count(body.eligible,64) || !count(body.promoted,128)
        || !Array.isArray(body.results)) throw new Error('post_verify_controller_promotion_readback_missing')
    let promoted=0
    for (const result of body.results) {
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.status === 'partial_error'
          || (Array.isArray(result.errors) && result.errors.length)) {
        throw new Error('post_verify_controller_promotion_partial_error')
      }
      const active=result.can_promote === true
      if (active && (result.status !== 'ok' || !Number.isFinite(Date.parse(result.confirmed_at)))) throw new Error('post_verify_controller_promotion_terminal_missing')
      const candidates:Array<{id:string;version?:string;model?:string;checksum?:string}>=[]
      let bundle:Awaited<ReturnType<typeof ensemble>>|undefined
      if (active && result.ensemble_artifact_id) {
        bundle=await ensemble(env,result.ensemble_artifact_id)
        if (bundle.row.state !== 'production' || result.readback_verified !== true || bundle.row.training_run_id !== result.training_run_id
            || !Array.isArray(result.release_models) || !equal([...result.release_models].sort(),[...bundle.payload.selected_models].sort())) {
          throw new Error('post_verify_controller_promoted_ensemble_mismatch')
        }
        ensembles.push(bundle.pointer)
        for (const model of result.release_models) {
          const base=bundle.payload.base_artifacts[model]
          candidates.push({id:base.artifact_id,version:base.version,checksum:base.checksum,model})
        }
      } else if (result.artifact_id) candidates.push({id:result.artifact_id,version:result.candidate_version,model:result.model_name})
      else if (active) throw new Error('post_verify_controller_promoted_artifact_identity_missing')
      for (const candidate of candidates) {
        const row=await registry(env,candidate.id)
        if ((candidate.version && row.version !== candidate.version) || (candidate.model && row.model_name !== candidate.model)
            || (candidate.checksum && row.checksum !== candidate.checksum) || (active && row.state !== 'production')
            || (bundle && row.training_run_id !== bundle.pointer.trainingRunId)) {
          throw new Error('post_verify_controller_promotion_artifact_readback_mismatch')
        }
        const item:Artifact={artifactId:row.artifact_id,modelName:row.model_name,version:row.version,checksum:row.checksum,
          kind:active?'promotion':'decision',witness:'',...(active?{effectiveAt:result.confirmed_at}:{}),
          ...(bundle?{ensembleId:bundle.pointer.artifactId,ensembleChecksum:bundle.pointer.payloadChecksum,
            // The original bundle transaction uses this exact immutable ID.
            // Recovered responses carry pointer timestamps with different
            // precision; never weaken the history lookup to a date range.
            promotionEventId:`champion:${row.model_name}:${row.version}:${bundle.pointer.trainingRunId}:ensemble:${bundle.pointer.payloadChecksum}`}:{})}
        item.witness=await artifactWitness(env,item,row);artifacts.push(item)
        if(active)promoted++
      }
    }
    if (promoted !== body.promoted) throw new Error('post_verify_controller_promoted_count_mismatch')
  } else throw new Error('post_verify_controller_task_invalid')
  if (artifacts.length > 128 || new Set(artifacts.map(row=>row.artifactId)).size !== artifacts.length) throw new Error('post_verify_controller_artifact_count_invalid')
  // Promotion has no native run_date/root fields. This is the enclosing Worker
  // operation date; its checkpoint identity owns root/source/lease lineage.
  const value={schema:'post-verify-controller-evidence-v1' as const,task,businessDate,
    responseChecksum:await digest(body),artifacts,ensembles}
  return {...value,checksum:await digest(value)}
}

export async function verifyPostVerifyControllerEvidence(env:Bindings,evidence:PostVerifyControllerEvidence):Promise<boolean> {
  try {
    if(!evidence||typeof evidence!=='object')return false
    const {checksum:hash,...body}=evidence
    if (evidence.schema !== 'post-verify-controller-evidence-v1' || !['model-ic-rolling','artifact-auto-promotion'].includes(evidence.task)
        || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.businessDate) || await digest(body) !== hash
        || !Array.isArray(evidence.artifacts) || evidence.artifacts.length > 128 || !Array.isArray(evidence.ensembles)
        || (evidence.task==='model-ic-rolling'&&evidence.ensembles.length!==0)) return false
    for (const item of evidence.artifacts) {
      if (!(evidence.task==='model-ic-rolling' ? item.kind==='ic' : ['promotion','decision'].includes(item.kind))
          || await artifactWitness(env,item) !== item.witness) return false
    }
    for (const item of evidence.ensembles) if (!equal((await ensemble(env,item.artifactId)).pointer,item)) return false
    return true
  } catch(error) {
    if(error instanceof Error&&/^post_verify_controller_/.test(error.message))return false
    // Unknown I/O/schema failures must block verification, not become a
    // confirmed optional-artifact failure that permits later side effects.
    throw error
  }
}
