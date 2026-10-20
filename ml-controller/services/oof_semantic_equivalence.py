"""One byte-pinned sequence metadata correction, carried in the sealed manifest."""
import hashlib
import json

SCHEMA='oof-saved-sequence-semantic-equivalence-v1'
OLD='formal137-pit-asof-source-quality-v3'
NEW='formal131-without-unverified-daily-owners-v1'


def checksum(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()


def declared_semantic(manifest, *, metadata, path, artifact_checksum, cohort, fold, model, requested):
    candidates=[r for r in manifest.get('artifact_semantic_equivalences',[]) if
                r.get('artifact_path')==path and r.get('artifact_checksum')==artifact_checksum]
    if not candidates:return requested
    if len(candidates)!=1:raise ValueError('oof_semantic_equivalence_duplicate')
    r=candidates[0]
    if (r.get('schema_version')!=SCHEMA or r.get('checksum')!=checksum({k:v for k,v in r.items() if k!='checksum'})
            or (cohort,fold,model)!=(r.get('cohort_id'),r.get('fold_id'),r.get('model_name'))
            or model!='PatchTST' or fold!='w0' or requested!=NEW or r.get('requested_semantic')!=requested
            or metadata.get('feature_semantic_version')!=OLD or r.get('declared_semantic')!=OLD
            or r.get('metadata_rewritten') is not False):
        raise ValueError('oof_semantic_equivalence_binding')
    proof=r.get('input_equivalence') or {};forward=r.get('checkpoint_forward') or {}
    outputs=proof.get('outputs',[])
    if (r.get('input_equivalence_sha256')!=hashlib.sha256(r.get('input_equivalence_json','').encode()).hexdigest()
            or json.loads(r['input_equivalence_json'])!=proof
            or proof.get('status')!='semantic_changes_metadata_only_for_exact_saved_call'
            or proof.get('same_training_and_inference_inputs') is not True
            or proof.get('training_calls')!=0 or proof.get('network_calls')!=0 or proof.get('gcs_writes')!=0
            or proof.get('original_oof_sha256')!=artifact_checksum
            or len(outputs)!=2 or outputs[0].get('semantic')!=OLD or outputs[0].get('metadata_changed_fields')!=[]
            or outputs[1].get('semantic')!=NEW
            or set(outputs[1].get('metadata_changed_fields',[]))!={'feature_semantic_version','contract_checksum'}):
        raise ValueError('oof_semantic_equivalence_inputs')
    if (forward.get('status')!='saved_checkpoint_forward_exact' or forward.get('fit_calls')!=0
            or forward.get('production_changed') is not False or forward.get('original_oof_sha256')!=artifact_checksum
            or forward.get('semantic_scope_proof_sha256')!=r['input_equivalence_sha256']
            or forward.get('model_sha256')!=proof.get('original_model_sha256')
            or len(forward.get('weights_before_after_sha256',''))!=64
            or forward.get('rows')!=r.get('asof_rows') or forward['rows']<metadata['rows']
            or len(r.get('forward_receipt_sha256',''))!=64 or len(r.get('admission_receipt_sha256',''))!=64):
        raise ValueError('oof_semantic_equivalence_forward')
    return OLD
