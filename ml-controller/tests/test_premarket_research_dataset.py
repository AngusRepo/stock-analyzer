from copy import deepcopy
import pytest
from services.premarket_information import build_information_delta
from services.premarket_research_dataset import seal_research_observation,mature_training_rows

def fixture():
    delta=build_information_delta(baseline={'signal_date':'2026-10-01','available_at':'2026-10-01T22:00:00+08:00',
        'l3_snapshot_id':'l3','sources':[]},current_records=[],cutoff='2026-10-02T07:00:00+08:00',trade_date='2026-10-02')
    obs=seal_research_observation(delta=delta,symbol='2330',l3_features=[0.]*30,baseline_prediction=.02,
        prediction_horizon='actual-policy-exit-v1',frozen_at='2026-10-02T08:00:00+08:00')
    outcome={'observation_id':obs['observation_id'],'known_at':'2026-10-08T14:00:00+08:00',
        'closed_at':'2026-10-07T10:00:00+08:00','horizon':'actual-policy-exit-v1','return_unit':'decimal',
        'net_return':.05,'complete':True,'source_checksum':'receipt'}
    return delta,obs,outcome

def test_only_known_mature_residual_is_joined_not_five_day_proxy():
    d,o,y=fixture();saved=deepcopy(o)
    args=dict(observations=[o],deltas={d['checksum']:d},outcomes=[y])
    assert mature_training_rows(**args,fit_cutoff='2026-10-08T13:00:00+08:00')['rows']==[]
    result=mature_training_rows(**args,fit_cutoff='2026-10-08T15:00:00+08:00')
    assert result['rows'][0]['target_residual']==pytest.approx(.03)
    assert o==saved and not result['training_dispatched'] and not result['scores_modified']
    y['horizon']='five-day'
    with pytest.raises(ValueError,match='outcome_contract'):mature_training_rows(**args,fit_cutoff='2026-10-08T15:00:00+08:00')

def test_cutoff_tampering_duplicate_and_incomplete_label_rejected():
    d,o,y=fixture()
    with pytest.raises(ValueError,match='freeze_cutoff'):
        seal_research_observation(delta=d,symbol='2330',l3_features=[0.]*30,baseline_prediction=.02,
            prediction_horizon='actual-policy-exit-v1',frozen_at='2026-10-02T08:45:00+08:00')
    args=dict(observations=[o],deltas={d['checksum']:d},outcomes=[y],fit_cutoff='2026-10-09T00:00:00Z')
    with pytest.raises(ValueError,match='duplicate_outcome'):mature_training_rows(**{**args,'outcomes':[y,y]})
    y['complete']=False
    with pytest.raises(ValueError,match='outcome_contract'):mature_training_rows(**args)
    y['complete']=True;d['missing']=['tampered']
    with pytest.raises(ValueError,match='delta_checksum'):mature_training_rows(**args)
