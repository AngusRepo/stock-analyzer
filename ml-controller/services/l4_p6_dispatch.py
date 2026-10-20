"""Three-seed P6 phase dispatch with durable claims and explicit completion.

No legacy R2 import, implicit training restart, model promotion, or new recipe.
Source preparation and final collection remain separately verified owners.
"""
from datetime import datetime,timezone
import hashlib,json,re
from services.l4_distribution import digest
from services.l4_p6_recipe import RECIPE,PROTOCOL

PREFIX='l4_distribution/p6_phase_dispatch/'


def read(bucket,path):
    blob=bucket.get_blob(path)
    if blob is None:return None
    raw=blob.download_as_bytes(if_generation_match=blob.generation)
    if hashlib.sha256(raw).hexdigest()!=(blob.metadata or {}).get('sha256'):
        raise ValueError('p6_phase_object_checksum')
    return json.loads(raw)


def put(bucket,path,value):
    from google.api_core.exceptions import PreconditionFailed
    raw=json.dumps(value,sort_keys=True,allow_nan=False).encode();blob=bucket.blob(path)
    blob.metadata={'sha256':hashlib.sha256(raw).hexdigest()}
    try:blob.upload_from_string(raw,content_type='application/json',if_generation_match=0)
    except PreconditionFailed:pass
    saved=read(bucket,path)
    if saved!=value:raise ValueError('p6_phase_immutable_conflict')
    return saved


def validate_source(source):
    phase=source.get('phase');batch=source.get('batch_id','');inputs=source.get('inputs') or {}
    if (source.get('recipe')!=RECIPE or phase not in ('cv','final')
            or not re.fullmatch('[a-f0-9]{64}',batch)
            or inputs.get('path')!=f'l4_distribution/p6_batches/{batch}/inputs.zip'
            or not re.fullmatch('[a-f0-9]{64}',inputs.get('sha256',''))
            or type(inputs.get('bytes')) is not int or inputs['bytes']<1
            or not str(inputs.get('generation','')).isdigit() or int(inputs['generation'])<1):
        raise ValueError('p6_phase_source_contract')


def advance(bucket,source,*,spawn=None,now=None):
    """One nonblocking phase poll. Three independent seeds use separate claims.

    A dispatch receipt without completion is pending. A claim without a dispatch
    receipt is an unknown outcome requiring recovery; never a second fit.
    """
    from google.api_core.exceptions import PreconditionFailed
    validate_source(source)
    root=PREFIX+digest(source)+'/'
    clock=(now or datetime.now(timezone.utc)).isoformat()
    status=dict(status='pending',phase=source['phase'],batch_id=source['batch_id'],recipe=RECIPE,
        model_family='p6_a',verified_seeds=[],pending_seeds=[],failed_seeds=[],
        dependency_retry_required=True,training_dispatched=False,promoted=False)
    # Verify the sealed input's exact generation before paying for any work.
    from services.l4_p6_results import _read
    _read(bucket,source['inputs']['path'],source['inputs'])
    outcomes={}
    for seed in PROTOCOL['seeds']:
        prefix=f"l4_distribution/p6_batches/{source['batch_id']}/{source['phase']}/seed{seed}/"
        result=read(bucket,prefix+'completed.json')
        if result is not None:
            if (result.get('schema_version')!='p6-seed-result-v1' or result.get('recipe')!=RECIPE
                    or result.get('sealed_batch_id')!=source['batch_id'] or result.get('seed')!=seed
                    or result.get('phase')!=source['phase'] or result.get('training_completed') is not True
                    or result.get('promoted') is not False or result.get('outer_rows')!=0
                    or not result.get('checkpoint_restoration')
                    or any(r.get('training_steps')!=0 for r in result['checkpoint_restoration'])):
                raise ValueError('p6_phase_completion_identity')
            outcomes[seed]='complete';continue
        # Worker failures use an immutable JSON without metadata. Presence is
        # sufficient to forbid a paid retry; never use its contents as evidence.
        if bucket.get_blob(prefix+'failed.json') is not None:
            outcomes[seed]='failed';continue
        claim=read(bucket,root+f'seed{seed}-claim.json')
        dispatch=read(bucket,root+f'seed{seed}-dispatch.json')
        if dispatch is not None and claim is None:raise ValueError('p6_dispatch_without_claim')
        if claim is not None and dispatch is None:
            outcomes[seed]='ambiguous';continue
        outcomes[seed]='pending' if dispatch else 'new'
    # Inspect all seed failures before starting any remaining seed.
    if any(value in ('failed','ambiguous') for value in outcomes.values()):
        return {**status,'status':'needs_review','dependency_retry_required':False,
            'retry_requires_review':True,'failed_seeds':[s for s,v in outcomes.items() if v in ('failed','ambiguous')],
            'seed_states':outcomes}
    for seed,outcome in outcomes.items():
        if outcome=='complete':status['verified_seeds'].append(seed);continue
        status['pending_seeds'].append(seed)
        if outcome=='pending':continue
        payload={k:source[k] for k in ('phase','batch_id','inputs')};payload['seed']=seed
        path=root+f'seed{seed}-claim.json';blob=bucket.blob(path)
        raw=json.dumps(dict(created_at=clock,payload_checksum=digest(payload)),sort_keys=True).encode()
        blob.metadata={'sha256':hashlib.sha256(raw).hexdigest()}
        try:blob.upload_from_string(raw,content_type='application/json',if_generation_match=0)
        except PreconditionFailed:continue
        if spawn is None:
            from services.modal_client import _lookup
            call=_lookup('fit_l4_p6_seed').spawn(payload)
        else:call=spawn(payload)
        put(bucket,root+f'seed{seed}-dispatch.json',dict(function_call_id=call.object_id,payload_checksum=digest(payload)))
        status['training_dispatched']=True
    if status['verified_seeds']==PROTOCOL['seeds']:
        status.update(status='phase_complete',dependency_retry_required=False,
            final_artifact_admitted=False,collection_required=True)
    return status
