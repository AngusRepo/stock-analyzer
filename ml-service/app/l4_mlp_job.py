"""Immutable B training job; data references only, never serving-pointer writes."""
import json
from services.l4_distribution import digest, predict
from services.l4_distribution_lifecycle import persist_candidate
from .l4_mlp_candidate import fit_candidate


def run(payload, *, bucket=None):
    from .oof_lineage import _runtime_source_sha
    if payload.get("expected_source_sha") != _runtime_source_sha():
        raise ValueError("l4_mlp_runtime_revision_mismatch")
    from .model_store import _get_bucket
    bucket = bucket if bucket is not None else _get_bucket()
    source = payload['dataset_path']
    anchor_path = payload['anchor_path']
    if (source != 'l4_distribution/native_datasets/'+payload['rows_checksum']+'.json'
            or not anchor_path.startswith('l4_distribution/candidates/')
            or '..' in anchor_path.split('/')):
        raise ValueError('l4_mlp_source_reference_invalid')
    rows = json.loads(bucket.blob(source).download_as_bytes())
    anchor = json.loads(bucket.blob(anchor_path).download_as_bytes())
    if digest(rows) != payload['rows_checksum'] or digest(anchor) != payload['anchor_checksum']:
        raise ValueError('l4_mlp_source_checksum_mismatch')
    dates = anchor['evaluation']['dates']
    train = [r for r in rows if r['label_known_date'] < min(dates)]
    candidate = fit_candidate(train,anchor,as_of=payload['as_of'])
    held = [r for r in rows if r['date'] in dates]
    if not held or set(dates) != {r['date'] for r in held}:
        raise ValueError('l4_mlp_heldout_dates_incomplete')
    outputs = predict(held,candidate['model'])
    from services.l4_prediction_evaluation import evaluate_predictions
    candidate['evaluation'] = {'method':'untouched_later_dates_no_refit','dates':dates,
        'rows':len(held),'rows_checksum':digest(held),
        'ev_mse':sum((p['expected_return_gross']-r['gross_return'])**2 for r,p in zip(held,outputs))/len(held),
        'zero_mse':sum(r['gross_return']**2 for r in held)/len(held),
        'native_l3_comparison':evaluate_predictions(held,outputs,model=candidate['model']),
        'portfolio_superiority':'requires_same_account_execution_comparison'}
    candidate['challenger_training_source'] = dict(payload)
    candidate['candidate_id'] = 'l4_distribution:'+digest(candidate)
    return persist_candidate(candidate,bucket=bucket)
