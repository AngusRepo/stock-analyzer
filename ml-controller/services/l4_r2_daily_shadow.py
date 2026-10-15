"""Freeze same-pool old/new forecasts and a causal Anchor; no neural updates."""
from datetime import date,datetime,time,timezone
from pathlib import Path
import hashlib,json,tempfile
from services import l4_distribution as native
from services.l4_native_observation import read_reference
from services.l4_forward_refresh import publish
from services.l4_r2_shadow import predict,validate


def score_snapshot(snapshot,*,bundle,anchor,baseline,load_bytes,policy):
    from services.l4_r2_forward_evaluation import validate_policy
    validate_policy(policy)
    from services.l4_r2_identity import implementation_identity
    if policy['implementation_checksum']!=implementation_identity()['checksum']:
        raise ValueError('l4_r2_implementation_changed')
    day=snapshot['signal_date'];identity=snapshot['l3_identity']
    validate(bundle,identity=identity,signal_date=day)
    if (policy.get('schema_version')!='l4-r2-forward-evaluation-policy-v1'
            or policy.get('model_checksum')!=bundle['payload_checksum']
            or policy.get('baseline_model_checksum')!=baseline['model_checksum']
            or policy.get('required_mature_days')!=20
            or policy.get('head_policy')!=bundle['head_policy']
            or policy.get('risk_horizon_sessions')!=5
            or policy.get('automatic_promotion') is not False
            or not policy.get('cost_policy_checksum') or not policy.get('allocation_policy_checksum')
            or baseline['l3_identity']!=identity
            or baseline['model_checksum']!=native.digest(baseline['model'])
            or baseline['training_label_known_max']>=day):
        raise ValueError('l4_r2_forward_policy_binding')
    rows=[dict(r,date=day,l3_identity=identity,feature_schema=snapshot['feature_schema']) for r in snapshot['feature_rows']]
    if native.digest(snapshot['feature_rows'])!=snapshot['features_checksum']:
        raise ValueError('l4_r2_shadow_projection_changed')
    outputs=predict(rows,bundle=bundle,anchor=anchor,identity=identity,signal_date=day,
        load_bytes=load_bytes,pool_symbols=snapshot['eligible_symbols'])
    old=native.predict(rows,baseline['model'])
    mean=sum(r['expected_return_gross'] for r in old)/len(old)
    forecasts=[dict(new,baseline_gross=prior['expected_return_gross'],baseline_relative=prior['expected_return_gross']-mean,
        native_features_checksum=native.digest(row['features']))
        for new,prior,row in zip(outputs,old,rows,strict=True)]
    return dict(schema_version='l4-r2-daily-shadow-v1',signal_date=day,l3_identity=identity,
        model_checksum=bundle['payload_checksum'],baseline_model_checksum=baseline['model_checksum'],
        policy_checksum=native.digest(policy),anchor_checksum=anchor['model_checksum'],
        implementation_checksum=policy['implementation_checksum'],
        anchor_training_label_known_max=anchor['training_label_known_max'],
        native_snapshot_id=snapshot['snapshot_id'],native_original_sha256=snapshot['original_sha256'],
        forecasts=forecasts,forecasts_checksum=native.digest(forecasts),
        neural_network_updated=False,training_dispatched=False,promoted=False,
        execution_scope='shadow_only',efficacy_status='awaiting_unseen_matured_labels')


def run(*,bucket,config,observation,day):
    """Fresh-source head policy matches causal training; model weights stay fixed."""
    from services.l4_r2_sources import resolve
    from services.l4_distribution_lifecycle import chronological_validation_blocks
    from scripts.l4_r2_source_refresh import classification_filter
    snapshot=read_reference(bucket,observation['projection'])
    bundle=read_reference(bucket,config['bundle']);baseline=read_reference(bucket,config['baseline'])
    policy=read_reference(bucket,config['evaluation_policy'])
    if snapshot['signal_date']!=day:raise ValueError('l4_r2_shadow_signal_date')
    from services.l4_r2_forward_evaluation import validate_policy
    validate_policy(policy)
    policy_blob=bucket.blob(config['evaluation_policy']['path']);policy_blob.reload()
    if policy_blob.time_created is None:raise ValueError('l4_r2_policy_server_clock_missing')
    if day<policy['first_signal_date']:raise ValueError('l4_r2_shadow_before_evaluation_window')
    key=native.digest(dict(signal_date=day,model=bundle['payload_checksum'],policy=policy))
    index=bucket.blob('l4_distribution/r2_shadow_index/'+key+'.json')
    if index.exists():
        saved=json.loads(index.download_as_bytes());body=read_reference(bucket,saved['reference'])
        if body['model_checksum']!=bundle['payload_checksum'] or body['policy_checksum']!=native.digest(policy):
            raise ValueError('l4_r2_shadow_index_binding')
        return {**saved,'reused':True}
    with tempfile.TemporaryDirectory(prefix='r2-shadow-head-') as directory:
        directory=Path(directory);classification=directory/'classification.json'
        classification.write_bytes(bucket.blob(config['classification']['path']).download_as_bytes())
        from services.l4_forward_materialization import TZ
        # A continuation after midnight must not admit the next day's labels.
        cutoff=min(datetime.now(timezone.utc),datetime.combine(date.fromisoformat(day),time.max,TZ))
        rows,receipt=resolve(bucket=bucket,identity=bundle['l3_identity'],feature_schema=bundle['feature_schema'],
            cutoff=cutoff.isoformat(),work=directory/'source-cache',
            classify=classification_filter(classification,config['classification']['sha256']))
        anchor=native.fit_candidate(rows,l3_identity=bundle['l3_identity'],as_of=day,
            validation_dates=chronological_validation_blocks(rows),forward_receipts=receipt['forward_receipts'])
    def load(ref):
        raw=bucket.blob(ref['path']).download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=ref['sha256']:raise ValueError('l4_r2_shadow_weights_hash')
        return raw
    body=score_snapshot(snapshot,bundle=bundle,anchor=anchor,baseline=baseline,load_bytes=load,policy=policy)
    body.update(frozen_at=datetime.now(timezone.utc).isoformat(),source_receipt=receipt,
        anchor=publish(bucket,'r2_shadow_heads',anchor),native_projection=observation['projection'])
    reference=publish(bucket,'r2_shadow_forecasts',body)
    result=dict(status='sealed',signal_date=day,reference=reference,model_checksum=bundle['payload_checksum'],
        rows=len(body['forecasts']),neural_network_updated=False,training_dispatched=False,promoted=False)
    from google.api_core.exceptions import PreconditionFailed
    try:index.upload_from_string(json.dumps(result,sort_keys=True),if_generation_match=0)
    except PreconditionFailed:
        # Concurrent readers use the first immutable same-policy observation.
        saved=json.loads(index.download_as_bytes());read_reference(bucket,saved['reference'])
        return {**saved,'reused':True}
    return result
