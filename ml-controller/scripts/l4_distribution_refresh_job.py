"""Durable weekly/monthly L4 candidate job. Does not promote serving pointers."""
import json
import os
from datetime import date
from pathlib import Path
import hashlib
from services.l4_distribution_dataset import build_native_oof_rows, validate_sequence_oof_lineage
from services.l4_distribution_lifecycle import refresh_candidate,persist_candidate
from services.l4_distribution import digest


def training_recipe_signature():
    services=Path(__file__).resolve().parents[1]/'services'
    names=('l4_distribution.py','l4_distribution_dataset.py','l4_native_meta_replica.py',
        'l4_distribution_lifecycle.py','active8_oof_stacker.py','active8_ensemble_artifact.py','ensemble_v2.py',
        'active8_score_semantics.py','active8_oof_cohort_materializer.py',
        'l4_distribution_runtime.py','l4_l3_baseline.py','recommendation_service.py','l4_alpha_ev_producer.py',
        'alpha_model_roster.py','l4_residual_mlp.py','l4_prediction_evaluation.py')
    sources={name:hashlib.sha256((services/name).read_bytes()).hexdigest() for name in names}
    sources['scripts/l4_distribution_refresh_job.py']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    return digest(sources)


def load_target_parent(artifact_id,client):
    from services.active8_ensemble_artifact import payload_checksum,ARTIFACT_SCHEMA_VERSION
    rows=client.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?',[artifact_id])
    if len(rows)!=1:raise ValueError('l4_refresh_target_l3_missing')
    row=rows[0];parent=json.loads(row['payload_json'])
    if (parent.get('schema_version')!=ARTIFACT_SCHEMA_VERSION
            or payload_checksum({k:v for k,v in parent.items() if k!='payload_checksum'})!=row['payload_checksum']
            or parent['payload_checksum']!=row['payload_checksum']
            or parent['cohort_id']!=row['cohort_id']
            or parent['base_artifact_set_checksum']!=row['base_artifact_set_checksum']
            or row.get('state') not in ('candidate','production')):
        raise ValueError('l4_refresh_target_l3_integrity_failed')
    identity={'schema_version':'paired-nav-formal-ml-baseline-v1',
        **{key:row[key] for key in ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')}}
    return parent,identity


def execute(*,as_of,cadence,target_l3_artifact_id=None,strategy_role="A"):
    if strategy_role not in ("A","B"):
        raise ValueError("l4_refresh_strategy_role_invalid")
    from graphs.daily_pipeline_v2 import _load_active8_serving_pool,_load_active8_ensemble_snapshot,_active8_action_authority
    from services.paired_nav_collection import baseline_model_identity
    from services.active8_oof_cohort_materializer import load_verified_oof_manifest,load_oof_prediction_rows
    from services.walk_forward_retrain import _get_bucket
    date.fromisoformat(as_of)
    if target_l3_artifact_id:
        from services.d1_domain_client import client_proxy_for_domain
        parent,identity=load_target_parent(target_l3_artifact_id,client_proxy_for_domain('learning'))
    else:
        _,pool=_load_active8_serving_pool()
        parent=_load_active8_ensemble_snapshot(pool)
        if parent is None:raise ValueError('l4_refresh_parent_l3_missing')
        identity=baseline_model_identity({'active8_ensemble':parent,'active8_action_authority':_active8_action_authority(parent)})
    bucket=_get_bucket()
    if bucket is None:
        raise ValueError('l4_refresh_bucket_missing')
    source=f"walk_forward/oof_cohorts/{parent['cohort_id']}/manifest.json"
    manifest,_=load_verified_oof_manifest(source,bucket=bucket,require_formal_lineage=True)
    recipe=training_recipe_signature()
    if strategy_role == "B":
        from services.alpha_model_roster import TIMEXER_MODELS,validate_order
        if validate_order(parent["model_order"]) != TIMEXER_MODELS:
            raise ValueError("l4_mlp_challenger_requires_timexer_roster")
        source_sha = os.environ.get('STOCKVISION_SOURCE_SHA','')
        if len(source_sha) != 40 or any(c not in '0123456789abcdef' for c in source_sha):
            raise ValueError('l4_mlp_training_source_sha_missing')
        recipe=digest({'anchor_recipe':recipe,'B_source_sha':source_sha,'recipe':'three-head-oof-scalar-mlp-v1'})
    run_key=digest({'source':manifest['manifest_checksum'],'identity':identity,'as_of':as_of,'cadence':cadence,'training_recipe':recipe,**({'strategy_role':'B'} if strategy_role=='B' else {})})
    receipt_path=f'l4_distribution/refresh/{run_key}.json'
    receipt_blob=bucket.blob(receipt_path)
    if receipt_blob.exists():
        return json.loads(receipt_blob.download_as_text())
    predictions=load_oof_prediction_rows(manifest,bucket=bucket)
    sequence_lineage=validate_sequence_oof_lineage(predictions)
    rows,receipt=build_native_oof_rows(predictions,manifest=manifest,
        parent_l3=parent,parent_identity=identity,as_of=as_of)
    receipt['sequence_score_lineage']=sequence_lineage
    receipt['source_pointer']=source
    receipt['training_recipe_signature']=recipe
    dataset_path=f"l4_distribution/native_datasets/{receipt['rows_checksum']}.json"
    receipt['dataset_path']=dataset_path
    candidate=refresh_candidate(rows,dataset_receipt=receipt,l3_identity=identity,as_of=as_of,cadence=cadence)
    dataset_blob=bucket.blob(dataset_path)
    if not dataset_blob.exists():
        dataset_blob.upload_from_string(json.dumps(rows,sort_keys=True,allow_nan=False),content_type='application/json',if_generation_match=0)
    if digest(json.loads(dataset_blob.download_as_text()))!=receipt['rows_checksum']:
        raise ValueError('l4_refresh_dataset_readback_mismatch')
    stored=persist_candidate(candidate,bucket=bucket)
    if strategy_role == "B":
        from services.modal_client import _lookup
        stored = _lookup("train_l4_mlp_candidate").remote({
            "dataset_path":dataset_path,"rows_checksum":receipt['rows_checksum'],
            "anchor_path":stored['artifact_path'],"anchor_checksum":digest(candidate),"as_of":as_of,
            "expected_source_sha":source_sha})
    result={**stored,'run_key':run_key,'as_of':as_of,'cadence':cadence,'dataset_receipt':receipt,'training_recipe_signature':recipe}
    receipt_blob.upload_from_string(json.dumps(result,sort_keys=True),content_type='application/json',if_generation_match=0)
    return result

if __name__=='__main__':
    print(json.dumps(execute(as_of=os.environ['L4_REFRESH_DATE'],cadence=os.environ['L4_REFRESH_CADENCE'],target_l3_artifact_id=os.environ.get('L4_PARENT_ARTIFACT_ID'),strategy_role=os.environ.get('L4_STRATEGY_ROLE','A')),sort_keys=True))
