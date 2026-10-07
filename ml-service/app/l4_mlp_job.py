"""Complete original E0 three-seed candidate; never changes serving authority."""
from copy import deepcopy
import hashlib
import io
import json
import os
import re

import numpy as np
import torch

from services.l4_distribution import digest, predict, validate_bundle
from services.l4_distribution_lifecycle import persist_candidate
from services.l4_mlp_export import export_member, ensemble
from services.l4_mlp_median import SCHEMA, SEEDS
from services.l4_mlp_dispatch import PREFIX, RECIPE


def put(bucket, path, raw):
    if isinstance(raw,str): raw=raw.encode()
    blob=bucket.blob(path)
    if not blob.exists():
        blob.upload_from_string(raw,content_type='application/octet-stream',if_generation_match=0)
    if blob.download_as_bytes()!=raw: raise ValueError('l4_mlp_immutable_readback_mismatch')


def build_candidate(payload,bucket):
    if (payload.get('training_recipe')!=RECIPE
            or not re.fullmatch('[a-f0-9]{40}',str(payload.get('expected_source_sha','')))
            or payload['expected_source_sha']!=os.environ.get('STOCKVISION_SOURCE_SHA')
            or payload['dataset_path']!='l4_distribution/native_datasets/'+payload['rows_checksum']+'.json'
            or not payload['anchor_path'].startswith('l4_distribution/candidates/')
            or '..' in payload['anchor_path'].split('/')):
        raise ValueError('l4_mlp_source_contract_invalid')
    rows=json.loads(bucket.blob(payload['dataset_path']).download_as_bytes())
    anchor=json.loads(bucket.blob(payload['anchor_path']).download_as_bytes())
    if digest(rows)!=payload['rows_checksum'] or digest(anchor)!=payload['anchor_checksum']:
        raise ValueError('l4_mlp_source_checksum_mismatch')
    from app.l4_mlp_data import prepare
    from app.l4_mlp_training import fit, predict as torch_predict
    arrays,recipe,evidence,held=prepare(rows,anchor,as_of=payload['as_of'])
    root=PREFIX+payload['run_key']+'/'
    raw=json.dumps(evidence,sort_keys=True,separators=(',',':')).encode()
    partition_sha=hashlib.sha256(raw).hexdigest()
    put(bucket,root+'partitions.json',raw)
    members,torch_outputs=[],[]
    torch.set_num_threads(4)
    for seed in SEEDS:
        # Inner validation chooses epochs; full permitted OOF is refitted with
        # its own training-only feature scaler and residual target RMS.
        _,selection=fit(*arrays['inner'],valid=arrays['valid'],seed=seed)
        trained,training=fit(*arrays['full'],epochs=selection['selected_epochs'],seed=seed)
        forecast=torch_predict(trained,arrays['test'][0],arrays['test'][2],scale=training['residual_scale'])
        checkpoint=io.BytesIO();torch.save(trained.state_dict(),checkpoint);weights=checkpoint.getvalue()
        checkpoint_sha=hashlib.sha256(weights).hexdigest()
        receipt={'seed':seed,'selection':selection,'training':training,
            'training_label_known_max':evidence['training_label_known_max'],'checkpoint_sha256':checkpoint_sha}
        raw_receipt=json.dumps(receipt,sort_keys=True,separators=(',',':')).encode()
        put(bucket,root+f'seed-{seed}.pt',weights);put(bucket,root+f'seed-{seed}.json',raw_receipt)
        member=export_member(trained.state_dict(),recipe=recipe,anchor=anchor['model'],training=receipt,
            provenance={'seed':seed,'checkpoint_sha256':checkpoint_sha,
                'training_receipt_sha256':hashlib.sha256(raw_receipt).hexdigest(),'partition_sha256':partition_sha})
        members.append(member);torch_outputs.append(forecast)
    candidate=deepcopy(anchor);candidate.pop('candidate_id',None)
    candidate['model']['residual_mlp']=ensemble(anchor['model'],members)
    candidate['model_checksum']=digest(candidate['model'])
    from services.l4_mlp_weights import compact_candidate
    candidate,objects=compact_candidate(candidate)
    for path,raw in objects.items():put(bucket,path,raw)
    candidate['release']={'scope':'research','decision':'CANDIDATE'}
    candidate['challenger_training_source']=dict(payload)
    output=predict(held,candidate['model'])
    error=float(np.max(np.abs(np.asarray([p['expected_return_gross'] for p in output])-np.median(torch_outputs,axis=0))))
    if error>1e-6: raise ValueError('l4_mlp_export_parity_failed')
    candidate['export_verification']={'max_absolute_error':error,'tolerance':1e-6,'members':3}
    from services.l4_prediction_evaluation import evaluate_predictions
    candidate['evaluation']={'method':'untouched_later_dates_no_refit','dates':anchor['evaluation']['dates'],
        'rows':len(held),'rows_checksum':digest(held),
        'native_l3_comparison':evaluate_predictions(held,output,model=candidate['model']),
        'portfolio_superiority':'requires_same_account_execution_comparison'}
    validate_bundle(candidate,l3_identity=candidate['l3_identity'],signal_date=payload['as_of'],require_paper_release=False)
    candidate['candidate_id']='l4_distribution:'+digest(candidate)
    return {**persist_candidate(candidate,bucket=bucket),'model_schema':SCHEMA,'training_recipe':RECIPE,
        'run_key':payload['run_key'],'promoted':False}


def run(payload,*,bucket=None):
    if bucket is None:
        from google.cloud import storage
        from modal_app import _get_gcs_bucket_name
        bucket=storage.Client().bucket(_get_gcs_bucket_name())
    root=PREFIX+payload['run_key']+'/'
    if bucket.blob(root+'completed.json').exists():
        from services.l4_mlp_dispatch import completed
        return completed(bucket,payload['run_key'])
    if bucket.blob(root+'failed.json').exists():
        return {**json.loads(bucket.blob(root+'failed.json').download_as_bytes()),'dependency_retry_required':False}
    from google.api_core.exceptions import PreconditionFailed
    from datetime import datetime,timezone
    try:
        bucket.blob(root+'training_claim.json').upload_from_string(json.dumps({
            'created_at':datetime.now(timezone.utc).isoformat(),'payload_checksum':digest(payload)}),
            content_type='application/json',if_generation_match=0)
    except PreconditionFailed:
        claim=json.loads(bucket.blob(root+'training_claim.json').download_as_bytes())
        if claim.get('payload_checksum')!=digest(payload):
            raise ValueError('l4_mlp_training_claim_payload_mismatch')
        return {'status':'pending','promoted':False,'reason':'mlp_training_already_claimed'}
    try:
        result=build_candidate(payload,bucket)
        put(bucket,root+'completed.json',json.dumps(result,sort_keys=True))
        return result
    except Exception as exc:
        put(bucket,root+'failed.json',json.dumps({'status':'failed','run_key':payload['run_key'],
            'promoted':False,'reason':'full_mlp_candidate_failed','error_type':type(exc).__name__,'retry_requires_review':True}))
        raise
