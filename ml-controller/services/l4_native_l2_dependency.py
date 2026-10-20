"""Remove unused TimesFM from native observations only for proven input schemas."""
import hashlib
from services.alpha_model_roster import TIMEXER_MODELS
from services.formal_feature_contract import FEATURE131_SEMANTIC, LEGACY_SEMANTIC
from services.paired_nav_journal import digest

def unused_timesfm_receipt(context):
    manifest = context.get('serving_manifest') or {}
    from services.frozen_manifest_budget import canonical_manifest_bytes
    if hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest() != context.get('serving_manifest_digest'):
        raise ValueError('native_l2_serving_manifest_checksum')
    rows = manifest.get('models') or []
    if len(rows) != 8 or {r.get('model') for r in rows} != set(TIMEXER_MODELS):
        return None
    schemas = {}
    for row in rows:
        name = row['model']; schema = row.get('schema') or {}
        if not all(row.get(k) for k in ('artifact_id','checksum','version')):
            return None
        if name in ('LightGBM','XGBoost','ExtraTrees','TabM','GNN'):
            if schema.get('feature_semantic_version') not in (FEATURE131_SEMANTIC, LEGACY_SEMANTIC):
                return None
        else:
            sequence = schema.get('sequence_contract') or {}
            if (sequence.get('schema_version') != 'model-serving-sequence-contract-v1'
                    or sequence.get('artifact_id') != row['artifact_id']
                    or sequence.get('version') != row['version'] or sequence.get('model') != name):
                return None
            if name == 'TimeXer':
                if (sequence.get('timexer') or {}).get('feature_history_schema') not in (FEATURE131_SEMANTIC, LEGACY_SEMANTIC):
                    return None
            elif schema.get('metadata_schema_version') != {
                'PatchTST':'neuralforecast_patchtst_universal_v1_metadata_v1',
                'iTransformer':'neuralforecast_itransformer_universal_v1_metadata_v1',
            }[name]:
                return None
        schemas[name] = {'artifact_id':row['artifact_id'],'checksum':row['checksum'],'schema':schema}
    return {'schema_version':'native-l2-unused-dependency-v1',
            'reason':'frozen_eight_model_input_schemas_do_not_consume_timesfm',
            'models_checksum':digest(schemas), 'generation_required':False,
            'l2_ready_required':False, 'model_input_schemas':schemas}

async def enrich(state, *, pipeline, bucket, config, read_reference):
    proof = unused_timesfm_receipt(state['pipeline_modal_serving_context'])
    if proof is not None:
        # No payload/feature/roster mutation and no new "ready" claim.
        return {'sequence_dependency_receipt':proof}
    raise ValueError('retired_sidecar_feature_contract_unverified')
