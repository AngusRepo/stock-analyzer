import asyncio
import hashlib
from copy import deepcopy
from types import SimpleNamespace
import pytest
from services.l4_native_l2_dependency import enrich, unused_timesfm_receipt
from services.alpha_model_roster import TIMEXER_MODELS
from services.formal_feature_contract import FEATURE131_SEMANTIC
from services.frozen_manifest_budget import canonical_manifest_bytes

def context():
    rows=[]
    for model in TIMEXER_MODELS:
        row={'model':model,'version':'v1','artifact_id':model+':v1','checksum':'a'*64}
        schema={'feature_semantic_version':FEATURE131_SEMANTIC}
        if model in ('TimeXer','PatchTST','iTransformer'):
            schema={'metadata_schema_version':{'TimeXer':'stockvision-official-timexer-v1-metadata',
                'PatchTST':'neuralforecast_patchtst_universal_v1_metadata_v1',
                'iTransformer':'neuralforecast_itransformer_universal_v1_metadata_v1'}[model],
                'sequence_contract':{'schema_version':'model-serving-sequence-contract-v1',
                    'model':model,'artifact_id':row['artifact_id'],'version':row['version']}}
            if model=='TimeXer':schema['sequence_contract']['timexer']={'feature_history_schema':FEATURE131_SEMANTIC}
        rows.append({**row,'schema':schema})
    return signed({'models':rows})

def signed(manifest):
    return {'serving_manifest':manifest,'serving_manifest_digest':hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()}

def test_nonconsumer_does_not_read_timesfm_context_or_dispatch_generation():
    state={'run_date':'2026-10-16','pipeline_modal_serving_context':context(),'payloads':[{'symbol':'2330'}]}
    before=deepcopy(state)
    def forbidden(*args,**kwargs):raise AssertionError('TimesFM must not run/read')
    result=asyncio.run(enrich(state,pipeline=SimpleNamespace(_node_l2_timesfm_enrich=forbidden),bucket=None,config={},read_reference=forbidden))
    assert result['sequence_dependency_receipt']['l2_ready_required'] is False
    assert state==before and 'payloads' not in result

def test_changed_manifest_is_rejected_not_treated_as_unused():
    c=context();c['serving_manifest']['models'][0]['version']='tampered'
    with pytest.raises(ValueError,match='manifest_checksum'):unused_timesfm_receipt(c)

@pytest.mark.parametrize('fault',('new_feature_schema','missing_model','new_sequence_schema'))
def test_unknown_consumer_rejected_before_any_retired_dependency_read(fault):
    m=context()['serving_manifest']
    if fault=='new_feature_schema':m['models'][0]['schema']['feature_semantic_version']='with-timesfm-v2'
    elif fault=='missing_model':m['models'].pop()
    else:m['models'][-1]['schema']['metadata_schema_version']='future-sequence-with-sidecars'
    c=signed(m);assert unused_timesfm_receipt(c) is None
    calls=[]
    async def blocked(state):
        calls.append(state['pipeline_timesfm_context']);return {'timesfm_l2_summary':{'status':'blocked'}}
    with pytest.raises(ValueError,match='retired_sidecar_feature_contract_unverified'):
        asyncio.run(enrich({'run_date':'2026-10-16','pipeline_modal_serving_context':c},
            pipeline=SimpleNamespace(_node_l2_timesfm_enrich=blocked),bucket=None,
            config={'timesfm_context':{}},read_reference=lambda *args:{}))
    assert calls==[]
