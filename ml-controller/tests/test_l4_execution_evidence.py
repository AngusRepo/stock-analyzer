from copy import deepcopy
from datetime import date,timedelta
import numpy as np
import pytest
from services.l4_distribution import digest
from services.l4_execution_evidence import measured_five_session_covariance,bind_calibration_packets


def history():
    days=[str(date(2026,1,1)+timedelta(days=i)) for i in range(31)]
    returns={'A':[.01,-.02,.03,-.01,.02]*6,'B':[.03,.02,-.01,.02,-.02]*6}
    packet={'schema_version':'l4-dated-risk-v1','signal_date':days[-1],
        'intervals':[list(p) for p in zip(days,days[1:])],'returns':returns}
    packet['checksum']=digest(packet)
    return packet


def test_five_session_evidence_compounds_observations_without_mutating_or_dropping_names():
    from sklearn.covariance import LedoitWolf
    h=history();original=deepcopy(h)
    h['returns']['A'][-1]=.06;h['checksum']=digest({k:v for k,v in h.items() if k!='checksum'})
    packet=measured_five_session_covariance(h,['A','B'],6)
    x=np.array([h['returns'][s] for s in ['A','B']]).T
    expected=LedoitWolf().fit(np.array([np.prod(1+x[i:i+5],axis=0)-1 for i in range(0,30,5)]))
    assert np.array_equal(packet['covariance'],expected.covariance_)
    assert packet['symbols']==['A','B'] and packet['observed_windows']==6
    assert packet['checksum']==digest({k:v for k,v in packet.items() if k!='checksum'})
    assert all(a[1]<=b[0] for a,b in zip(packet['windows'],packet['windows'][1:]))
    assert original==history()


def test_missing_window_remains_explicit_and_insufficient_calendar_or_future_is_blocked():
    h=history();h['returns']['B'][0]=None
    h['checksum']=digest({k:v for k,v in h.items() if k!='checksum'})
    p=measured_five_session_covariance(h,['A','B'],5)
    assert p['observed_windows']==5 and len(p['excluded_missing_windows'])==1
    with pytest.raises(ValueError,match='insufficient'):
        measured_five_session_covariance(h,['A','B'],6)
    h['intervals'][4][0]='2026-01-01'
    h['checksum']=digest({k:v for k,v in h.items() if k!='checksum'})
    with pytest.raises(ValueError,match='calendar'):
        measured_five_session_covariance(h,['A','B'],2)


def test_calibration_binding_requires_exact_immutable_artifact_and_prior_known_date():
    p={'known_date_max':'2026-10-12','model_checksum':'a'*64,'source_reference':'fixture'}
    p['checksum']=digest(p)
    policy={'sealedExecution':{'uncertainty_calibration_checksum':p['checksum']},
        'sealedExecutionCalibration':{'sealed_execution_evidence':p}}
    original=deepcopy(policy)
    bound=bind_calibration_packets(policy,'2026-10-13')['sealed_execution_evidence']
    assert bound['calibration_checksum']==p['checksum'] and policy==original
    assert bound['checksum']==digest({k:v for k,v in bound.items() if k!='checksum'})
    for day in ['2026-10-12','2026-10-11']:
        with pytest.raises(ValueError):bind_calibration_packets(policy,day)
    policy['sealedExecutionCalibration']['sealed_execution_evidence']['model_checksum']='b'*64
    with pytest.raises(ValueError):bind_calibration_packets(policy,'2026-10-13')


def test_native_and_allocator_identity_include_new_policy_dependencies():
    from services.paired_nav_collection import allocator_runtime_source_identity
    from pathlib import Path
    identity=allocator_runtime_source_identity()
    for name in ['l4_execution_evidence.py','l4_position_constraints.py','l4_sealed_execution.py']:
        assert name in identity
        assert repr(name) in Path(__file__).parents[1].joinpath('services/native_paper_sandbox.py').read_text(encoding='utf8')


def test_uncertainty_calibration_uses_only_disjoint_oos_errors_and_requires_each_symbol():
    from services.l4_execution_evidence import calibrate_trade_uncertainty
    records=[]
    for day,end in [('2026-09-01','2026-09-08'),('2026-09-02','2026-09-09'),('2026-09-09','2026-09-16')]:
        for symbol in ['A','B']:
            row={'symbol':symbol,'prediction_date':day,'label_end_date':end,'known_date':end,
                'training_label_known_max':'2026-08-31','model_checksum':'a'*64,'horizon_sessions':5,
                'return_semantic':'canonical_adjusted_five_session_gross_decimal',
                'prediction_source':'synthetic-test-prediction','label_source':'synthetic-test-label',
                'expected_return_gross':.02,'actual_return_gross':.01}
            row['checksum']=digest(row);records.append(row)
    args=dict(model_checksum='a'*64,symbols=['A','B'],as_of='2026-10-01',minimum_dates=2,source_reference='synthetic-test-only')
    packet=calibrate_trade_uncertainty(records,**args)
    assert packet['independent_dates']==2 and packet['absolute_return_error_by_symbol']=={'A':.01,'B':.01}
    with pytest.raises(ValueError,match='coverage'):
        calibrate_trade_uncertainty(records,**{**args,'minimum_dates':3})
    row=records[0];row['training_label_known_max']=row['prediction_date']
    row['checksum']=digest({k:v for k,v in row.items() if k!='checksum'})
    with pytest.raises(ValueError,match='lineage'):calibrate_trade_uncertainty(records,**args)


def test_cost_calibration_requires_observed_fresh_quote_and_both_sides():
    from services.l4_execution_evidence import calibrate_execution_cost
    records=[]
    for side,price in [('buy',100.1),('sell',99.9)]:
        row={'execution_id':side,'symbol':'A','side':side,'fill_price':price,'arrival_mid_price':100,
            'known_date':'2026-10-12','executed_at':'2026-10-12T01:00:01Z',
            'quote_observed_at':'2026-10-12T01:00:00Z','execution_source':'synthetic-test-execution','quote_source':'synthetic-test-quote'}
        row['checksum']=digest(row);records.append(row)
    args=dict(symbols=['A'],as_of='2026-10-13',minimum_observations=1,source_reference='synthetic-test-only',max_quote_age_ms=1500)
    packet=calibrate_execution_cost(records,**args)
    assert packet['additional_buy_cost_by_symbol']['A']==pytest.approx(.001)
    assert packet['additional_sell_cost_by_symbol']['A']==pytest.approx(.001)
    with pytest.raises(ValueError,match='coverage'):calibrate_execution_cost(records[:1],**args)
    row=records[0];row['quote_observed_at']='2026-10-12T01:00:02Z'
    row['checksum']=digest({k:v for k,v in row.items() if k!='checksum'})
    with pytest.raises(ValueError,match='point_in_time'):calibrate_execution_cost(records,**args)
