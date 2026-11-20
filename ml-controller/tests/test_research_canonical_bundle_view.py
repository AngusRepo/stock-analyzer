from copy import deepcopy
import pytest
from services.research_canonical_bundle_view import canonical_bundle_view
from test_nav_l3_adoption import ready, prepared, environment
from test_active8_paper_admission import approved, publish


def test_canonical_bundle_reads_original_committed_paper_authority(approved):
    (client, *_), approval = approved
    publish(approved)
    result=canonical_bundle_view(query=client.query)
    assert result['status']=='PASS' and result['adoption_basis']=='paper_experiment_unproven'
    assert result['efficacy_status']=='unproven' and result['promotion_authority'] is False
    assert set(result['components'])=={'strategy','models','parameters','data_semantics','cost','execution'}
    assert result['models']['fit_coefficients']
    assert len(result['models']['base_artifacts'])==8


@pytest.mark.parametrize('component',['parameters','execution','cost','data_semantics'])
def test_canonical_reader_reports_current_drift_without_new_authority(approved,monkeypatch,component):
    from services import active8_nav_adoption as authority
    (client,*_),approval=approved
    publish(approved)
    current=deepcopy(approval['configuration'])
    if component=='parameters':current['risk_config']['test_changed']=1
    elif component=='execution':current['native_execution_policy']['execution_owner_version']='native-paper-v1:'+'f'*64
    elif component=='cost':current['trading_config']['fees']['commission']=.2
    else:current['native_execution_policy']['kv_read_policy']['test_changed']=1
    monkeypatch.setattr(authority,'current_execution_configuration',lambda:current)
    result=canonical_bundle_view(query=client.query)
    assert result['status']=='FAIL' and result['drift_fields']
    assert any(row['field'].startswith(component+'.') for row in result['drift_fields'])
    assert result['promotion_authority'] is False


def test_r33_roster_object_components_without_learned_fit():
    # 11/20: the R33 roster object has no fit/feature_names, so the view FAILed and blocked CD admission.
    from services.r33_ensemble import KIND
    from services.research_canonical_bundle_view import configuration_components
    calibration={'schema_version':'r33-cal-v1','target':'fwd','weighting':'equal','blocks':[1]}
    model={'kind':KIND,'schema_version':'r33-roster-ensemble-v1','artifact_id':'r33-roster:x','cohort_id':'c',
           'payload_checksum':'p'*64,'base_artifacts':{'LightGBM':{}},'model_order':['LightGBM'],
           'variant':'mean_z','serving_calibration':calibration}
    configuration={'native_execution_policy':{'frozen_kv':{},'kv_read_policy':{},'execution_owner_version':'n',
                   'variables':{}},'trading_config':{'fees':{}},'risk_config':{},
                   'allocator_source_identity':{},'l3_inference_source_identity':{}}
    out=configuration_components(configuration,strategy={'s':1},model=model)
    assert out['models']['weight_semantic']=='r33_roster_equal_weight' and 'fit_coefficients' not in out['models']
    assert out['models']['variant']=='mean_z' and out['data_semantics']['calibration_target']=='fwd'
    calibration['blocks']=[2]
    assert configuration_components(configuration,strategy={'s':1},model=model)['models']!=out['models']
