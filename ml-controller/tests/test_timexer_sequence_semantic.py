from copy import deepcopy
import json
from pathlib import Path
import pytest
from services.sequence_semantic_contract import sequence_rank_ic_semantic,RANK_IC_SEMANTIC_VERSION
from services.model_serving_resolver import _sequence_artifact_contract


def metadata():
    return json.loads(Path(__file__).with_name('fixtures').joinpath('timexer_4bcc_fullfit_semantic.json').read_text())


def test_actual_fullfit_sidecar_resolves_without_mutation_or_performance_pass():
    m=metadata();before=deepcopy(m)
    assert sequence_rank_ic_semantic(m,'TimeXer')==RANK_IC_SEMANTIC_VERSION
    row={'metadata':m,'artifact_id':'TimeXer:'+m['version']+':oof_full_fit_release','version':m['version']}
    result=_sequence_artifact_contract('TimeXer',row)
    assert result['seq_len']==168 and result['timexer']['variant']=='price'
    assert m==before and 'rank_ic_semantic_version' not in m


@pytest.mark.parametrize('field,value',[
    ('producer_source_sha','f'*40),('raw_score_semantic_version','wrong'),
    ('rank_ic_semantic_version','wrong'),('source_manifest_checksum','a'*64),
    ('exogenous',True),('full_fit_only',False),('checkpoint_selection','wrong')])
def test_unknown_or_conflicting_sidecars_remain_rejected(field,value):
    m=metadata();m[field]=value
    assert sequence_rank_ic_semantic(m,'TimeXer') is None


def test_corrupt_attestation_remains_rejected_and_new_explicit_tags_work():
    m=metadata();m['model_training_config_attestation']['attestation_checksum']='b'*64
    assert sequence_rank_ic_semantic(m,'TimeXer') is None
    assert sequence_rank_ic_semantic({'rank_ic_semantic_version':RANK_IC_SEMANTIC_VERSION},'TimeXer')==RANK_IC_SEMANTIC_VERSION


def test_controller_and_service_share_identical_contract():
    root=Path(__file__).resolve().parents[2]
    assert (root/'ml-controller/services/sequence_semantic_contract.py').read_bytes()==(root/'ml-service/app/sequence_semantic_contract.py').read_bytes()
