"""R2 monthly candidate lifecycle; completion requires all checkpoint readbacks."""
from datetime import datetime,timezone
import hashlib,io,json,re
import numpy as np
from services.l4_distribution import digest
from services.l4_r2_monthly import PREFIX,RECIPE,put
from services.l4_native_observation import read_reference
from services.l4_r2_shadow import validate,infer_seed


def read(bucket,path):
    blob=bucket.blob(path)
    return json.loads(blob.download_as_bytes()) if blob.exists() else None


def write(bucket,path,value):
    return put(bucket,path,json.dumps(value,sort_keys=True,allow_nan=False).encode())


def archived(bucket,path):
    blob=bucket.get_blob(path)
    if blob is None:raise ValueError('l4_r2_completed_object_missing')
    raw=blob.download_as_bytes(if_generation_match=blob.generation)
    if hashlib.sha256(raw).hexdigest()!=(blob.metadata or {}).get('sha256'):
        raise ValueError('l4_r2_completed_object_checksum')
    return raw


def completed(bucket,run_key):
    result=read(bucket,PREFIX+run_key+'/completed.json')
    if not result:raise ValueError('l4_r2_completed_missing')
    candidate=read_reference(bucket,dict(path=result['artifact_path'],sha256=result['artifact_sha256']))
    if (result.get('status')!='validated' or result.get('training_recipe')!=RECIPE
            or result.get('promoted') is not False or result.get('run_key')!=run_key
            or digest(candidate)!=result['artifact_checksum']
            or candidate.get('challenger_training_source',{}).get('run_key')!=run_key):
        raise ValueError('l4_r2_completed_receipt_invalid')
    validate(candidate,identity=candidate['l3_identity'],signal_date=candidate['challenger_training_source']['as_of'])
    return result


def finalize(bucket,run_key,source):
    from services.l4_r2_selection import select_weight_and_calibration
    metadata=source['metadata'];manifest=read_reference(bucket,metadata['matrices-manifest.json'])
    final=read_reference(bucket,metadata['final/receipt.json'])
    raw=bucket.blob(metadata['final/arrays.npz']['path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=metadata['final/arrays.npz']['sha256']:raise ValueError('l4_r2_final_matrix_hash')
    with np.load(io.BytesIO(raw),allow_pickle=False) as arrays:
        inputs=arrays['train_x'][np.linspace(0,len(arrays['train_x'])-1,min(2048,len(arrays['train_x'])),dtype=int)]
    seeds=[];panels=[];verifications=[]
    for seed in (42,43,44):
        root=f"l4_distribution/r2_batches/{source['batch_id']}/seed{seed}/"
        trained=json.loads(archived(bucket,root+'completed.json'))
        verified=json.loads(archived(bucket,root+'checkpoint-verification.json'))
        weights=archived(bucket,root+'weights.npz')
        if (trained.get('seed')!=seed or trained.get('training_completed') is not True or trained.get('promoted') is not False
                or trained['matrices_sha256']!=metadata['matrices-manifest.json']['sha256']
                or trained['weights']['path']!=root+'weights.npz'
                or verified.get('status')!='passed' or verified.get('training_steps')!=0
                or verified.get('batch_id')!=source['batch_id'] or verified.get('seed')!=seed
                or verified.get('input_sha256')!=source['inputs']['sha256']
                or verified['weights_sha256']!=trained['weights']['sha256']):
            raise ValueError('l4_r2_seed_completion_mismatch')
        member={k:trained[k] for k in ('seed','members','weights','target_mean','target_scale','final_recipe')}
        infer_seed(inputs,member,weights)
        seeds.append(member);verifications.append(digest(verified))
        with np.load(io.BytesIO(archived(bucket,root+'selected-validation.npz')),allow_pickle=False) as arrays:
            panels.append({k:arrays[k] for k in ('dates','symbols','y','A','delta')})
    first=panels[0]
    if any(not np.array_equal(panel[key],first[key]) for panel in panels[1:] for key in ('dates','symbols','y','A')):
        raise ValueError('l4_r2_cross_seed_validation_rows')
    if len(set(zip(first['dates'],first['symbols'])))!=len(first['dates']):raise ValueError('l4_r2_duplicate_validation_rows')
    calibration=select_weight_and_calibration(first['A'],np.median(np.stack([p['delta'] for p in panels]),axis=0),first['y'],first['dates'])
    bundle=dict(schema_version='l4-r2-shadow-v1',batch_id=source['batch_id'],l3_identity=manifest['l3_identity'],
        feature_schema=manifest['feature_schema'],source_pool=manifest['source_pool'],calibration=calibration,
        source_signal_dates=manifest['eligible_dates'],training_label_known_max=final['partitions']['train']['label_known_max'],
        head_policy='causal_latest_known_anchor_same_identity_full_pool_whole_mature_dates',
        shadow_only=True,production_enabled=False,efficacy_status='unproven',seeds=seeds,
        cadence=source['provenance']['cadence'],challenger_training_source={**source['provenance'],'run_key':run_key},
        training_source={'source_manifest_checksum':source['provenance']['source_manifest_checksum']},
        checkpoint_verification_checksums=verifications,serving_anchor=metadata['serving-anchor.json'])
    bundle['payload_checksum']=digest(bundle)
    validate(bundle,identity=manifest['l3_identity'],signal_date=source['provenance']['as_of'])
    artifact=write(bucket,PREFIX+run_key+'/candidate.json',bundle)
    result=dict(status='validated',run_key=run_key,training_recipe=RECIPE,model_family='tabpack_r2',
        model_schema='l4-r2-shadow-v1',artifact_path=artifact['path'],artifact_sha256=artifact['sha256'],
        artifact_checksum=digest(bundle),promoted=False,promotion_allowed=False,dependency_retry_required=False)
    write(bucket,PREFIX+run_key+'/completed.json',result)
    return completed(bucket,run_key)


def dispatch(bucket,run_key,make_payload,*,spawn=None,now=None):
    from google.api_core.exceptions import PreconditionFailed
    if not re.fullmatch('[a-f0-9]{64}',run_key):raise ValueError('l4_r2_run_key')
    clock=now or datetime.now(timezone.utc);root=PREFIX+run_key+'/'
    if read(bucket,root+'completed.json') is not None:return completed(bucket,run_key)
    failure=read(bucket,root+'failed.json')
    if failure:return failure
    pending=dict(status='pending',run_key=run_key,training_recipe=RECIPE,model_family='tabpack_r2',
        promoted=False,promotion_allowed=False,dependency_retry_required=True)
    source=read(bucket,root+'source.json')
    if source is None:
        try:bucket.blob(root+'prepare_claim.json').upload_from_string(json.dumps({'created_at':clock.isoformat()}),if_generation_match=0)
        except PreconditionFailed:
            return {**pending,'status':'failed','reason':'l4_r2_prepare_claim_requires_recovery',
                'dependency_retry_required':False,'retry_requires_review':True}
        try:
            source=make_payload();write(bucket,root+'source.json',source)
        except Exception as exc:
            write(bucket,root+'failed.json',{**pending,'status':'failed','stage':'prepare',
                'error_type':type(exc).__name__,'dependency_retry_required':False,'retry_requires_review':True})
            raise
    ready=[]
    for seed in (42,43,44):
        prefix=f"l4_distribution/r2_batches/{source['batch_id']}/seed{seed}/"
        failure=read(bucket,prefix+'failed.json')
        if failure:
            result={**pending,'status':'failed','failed_seed':seed,'dependency_retry_required':False,'retry_requires_review':True}
            write(bucket,root+'failed.json',result);return result
        if read(bucket,prefix+'checkpoint-verification.json') is not None:
            ready.append(seed);continue
        claim=bucket.blob(root+f'seed{seed}-dispatch-claim.json')
        saved=read(bucket,claim.name)
        if saved is not None:
            if (clock-datetime.fromisoformat(saved['created_at'])).total_seconds()>28800:
                return {**pending,'status':'failed','reason':'l4_r2_dispatch_overdue',
                    'failed_seed':seed,'dependency_retry_required':False,'retry_requires_review':True}
            continue
        try:claim.upload_from_string(json.dumps({'created_at':clock.isoformat()}),if_generation_match=0)
        except PreconditionFailed:continue
        payload={k:source[k] for k in ('batch_id','inputs')};payload['seed']=seed
        if spawn is None:
            from services.modal_client import _lookup
            call=_lookup('fit_l4_r2_seed').spawn(payload)
        else:call=spawn(payload)
        write(bucket,root+f'seed{seed}-dispatch.json',dict(function_call_id=call.object_id,payload_checksum=digest(payload)))
    return finalize(bucket,run_key,source) if ready==[42,43,44] else {**pending,'verified_seeds':ready}
