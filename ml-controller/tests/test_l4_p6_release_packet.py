from copy import deepcopy
import pytest
from services.l4_distribution import digest
from services.l4_distribution_lifecycle import P6_ACCEPTANCE_CHECKS
from services.l4_distribution_runtime import distribution_policy_identity
from services.l4_release_packet import prepare_packet
from services.l4_allocation_contract import inherited_sparse_controls
from services.paper_strategy_mode import P6_MODE,refresh_family,single_b_policy
from test_l4_p6_runtime import setup,IDENTITY


def test_P6_B_uses_existing_packet_owner_with_explicit_recipe_and_rollback():
    _,policy,_,_=setup();candidate=policy['artifact'];constraints={**policy['constraints'],**inherited_sparse_controls({})}
    opb=dict(enabled=True,arms=[dict(id='base',constraints={})])
    opb['approved_policy_identity']=distribution_policy_identity(dict(artifact=candidate,constraints=constraints,opb=opb),IDENTITY)
    evidence=dict(scope='r32_p6_native_engineering_paper_execution',complete=True,opb_policy=opb)
    acceptance=dict(schema_version='l4-paper-acceptance-v1',model_checksum=candidate['model_checksum'],
        l3_identity_checksum=digest(IDENTITY),feature_schema=candidate['feature_schema'],
        checks=dict.fromkeys(P6_ACCEPTANCE_CHECKS,True),source_evidence_checksum=digest(evidence),
        acceptance_mode='p6_r32_paper',efficacy_status='inner_only_outer_unproven',
        inner_report_checksum=candidate['model']['inner_report']['checksum'],
        experiment_authorization=dict(scope='paper',approved=True,model_checksum=candidate['model_checksum'],source_reference='test-only'))
    current=dict(position={'maxPositions':2},fees={'commission':.001,'tax':.003},ranking={'enabled':True},untouched='yes')
    packet=prepare_packet(current_config=current,candidate=candidate,acceptance=acceptance,source_evidence=evidence,
        l3_identity=IDENTITY,current_l3_identity=IDENTITY,constraints=constraints,signal_date='2026-10-19')
    config=packet['next_config'];mode=single_b_policy(config,signal_date='2026-10-19')
    assert mode['mode']==P6_MODE and refresh_family(config)=='p6_a'
    assert packet['rollback_config']==current and packet['reset_account'] is False
    assert packet['remote_mutations_executed'] is False
    bad=deepcopy(config);bad['l4Distribution']['artifact']['model']['calibration_kind']='raw'
    with pytest.raises(ValueError,match='linear_champion_required'):single_b_policy(bad,signal_date='2026-10-19')
