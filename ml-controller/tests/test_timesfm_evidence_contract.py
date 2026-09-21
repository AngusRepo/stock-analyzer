from copy import deepcopy
import json
import pytest
from services import model_serving_resolver as resolver
from services.timesfm_evidence_contract import SCHEMA


def fixture():
    artifact={'artifact_id':'TimesFM:verified','model_name':'TimesFM','version':'v1','state':'production',
        'candidate_type':'manual_hotfix','checksum':'sha256:'+'a'*64,'artifact_path':'universal/timesfm/v1.json',
        'metadata_path':'universal/timesfm/metadata_v1.json','offline_gate_decision':'PRODUCTION_BACKFILL',
        'live_gate_status':'rolling_ic_failed'}
    contract={'schema_version':SCHEMA,**{k:artifact[k] for k in ('artifact_id','version','artifact_path')},
        'config_sha256':'a'*64,'direct_alpha_blocked':True,'trained_feature_adoption':False,
        'efficacy_status':'unproven','source_reference':'SYNTHETIC bytes attestation'}
    artifact['offline_evidence_json']=json.dumps({'registration':{'metadata':{'timesfm_evidence_contract':contract}}})
    return artifact,contract


def test_verified_diagnostic_forecast_does_not_require_alpha_profit_gate_or_admit_direct_vote():
    artifact,_=fixture()
    assert resolver._artifact_block_reason(artifact,model_name='TimesFM',artifact_role='l2_feature_sidecar') is None
    assert resolver._artifact_block_reason(artifact,model_name='TimesFM',artifact_role='direct_alpha') is not None
    from app.serving_resolver import _artifact_block_reason as remote
    assert remote(artifact,model_name='TimesFM',artifact_role='l2_feature_sidecar') is None
    from services.timesfm_l175_sidecar import _release_policy_active
    assert _release_policy_active({})[0] is False


@pytest.mark.parametrize('fault',['checksum','identity','type','alpha','features','source','state'])
def test_unknown_or_changed_artifact_cannot_borrow_evidence_eligibility(fault):
    artifact,contract=fixture()
    if fault=='checksum':artifact['checksum']=None
    elif fault=='identity':contract['artifact_id']='other'
    elif fault=='type':artifact['candidate_type']='unknown'
    elif fault=='alpha':contract['direct_alpha_blocked']=False
    elif fault=='features':contract['trained_feature_adoption']=True
    elif fault=='source':contract['source_reference']=''
    elif fault=='state':artifact['state']='archived'
    artifact['offline_evidence_json']=json.dumps({'registration':{'metadata':{'timesfm_evidence_contract':contract}}})
    assert resolver._artifact_block_reason(artifact,model_name='TimesFM',artifact_role='l2_feature_sidecar')
