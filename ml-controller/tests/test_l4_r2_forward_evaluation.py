from copy import deepcopy
from datetime import date,timedelta
import pytest
from services.l4_r2_forward_evaluation import evaluate
from services.l4_forward_materialization import digest

def fixture():
    calendar=[(date(2026,10,15)+timedelta(days=i)).isoformat() for i in range(40)]
    from services.l4_r2_identity import implementation_identity
    policy=dict(schema_version='l4-r2-forward-evaluation-policy-v1',required_mature_days=20,risk_horizon_sessions=5,
        implementation_checksum=implementation_identity()['checksum'],
        automatic_promotion=False,first_signal_date=calendar[0],last_inspected_signal_date='2026-10-14',
        model_checksum='a'*64,baseline_model_checksum='b'*64,cost_policy_checksum='c'*64,allocation_policy_checksum='d'*64,
        head_policy='causal_latest_known_anchor_same_identity_full_pool_whole_mature_dates',
        uncertainty={'method':'paired_five_session_moving_block','replicates':5000,'seed':42,'confidence':.95},
        acceptance='manual_review_of_precommitted_metrics_no_automatic_promotion')
    items=[];prices={};identity={'test':'parent'}
    for day in calendar:
        for i,s in enumerate(('A','B','C')):prices[(day,s)]=dict(adj_open=100,adj_close=101+i,source_sha256='f'*64)
    for day in calendar[:22]:
        rows=[dict(symbol=s,features={'x':i},l3_baseline={}) for i,s in enumerate(('A','B','C'))]
        snapshot=dict(signal_date=day,snapshot_id=day,feature_rows=rows,features_checksum=digest(rows),
            eligible_symbols=['A','B','C'],l3_identity=identity,pool_contract='native_non_etf_equity_v1',feature_schema='test',
            original_sha256='e'*64,verified_original_sha256='e'*64,frozen_at=day+'T16:00:00+08:00',l3_training_label_known_max='2026-10-08')
        predictions=[dict(symbol=s,relative_mu=(i-1)*.01,baseline_relative=(1-i)*.01) for i,s in enumerate(('A','B','C'))]
        forecast=dict(schema_version='l4-r2-daily-shadow-v1',signal_date=day,l3_identity=identity,
            implementation_checksum=policy['implementation_checksum'],
            model_checksum='a'*64,baseline_model_checksum='b'*64,policy_checksum=digest(policy),native_snapshot_id=day,
            native_original_sha256='e'*64,frozen_at=day+'T17:00:00+08:00',forecasts=predictions,forecasts_checksum=digest(predictions))
        items.append(dict(forecast=forecast,snapshot=snapshot,server_created_at=day+'T17:00:01+08:00',forecast_sha256='a'*64))
    return items,dict(policy=policy,policy_created_at='2026-10-14T20:00:00+08:00',calendar=calendar,
        prices=prices,cutoff=calendar[-1]+'T20:00:00+08:00',identity=identity)

def test_first_twenty_mature_days_fixed_and_never_auto_promote():
    items,kw=fixture();result=evaluate(items,**kw)
    assert result['matured_days']==20 and result['additional_mature_days']==2
    assert result['dates']==kw['calendar'][:20]
    assert result['summary']['rank_ic']['difference']==pytest.approx(2)
    assert result['summary']['relative_mse']['difference']<0
    assert result['status']=='ready_for_manual_review' and not result['promotion_allowed']

def test_server_clock_defeats_backdated_forecast():
    items,kw=fixture();items=items[:1]
    items[0]['server_created_at']=kw['calendar'][1]+'T09:00:00+08:00'
    result=evaluate(items,**kw)
    assert result['matured_days']==0 and result['excluded'][0]['reason']=='prediction_sealed_after_entry'

def test_policy_cannot_be_frozen_after_predictions():
    items,kw=fixture();kw['policy_created_at']=kw['calendar'][1]+'T00:00:00+08:00'
    assert evaluate(items[:1],**kw)['matured_days']==0

def test_immature_or_partial_days_cannot_inflate_sample_count():
    items,kw=fixture();kw['cutoff']=kw['calendar'][5]+'T23:00:00+08:00'
    assert evaluate(items[:1],**kw)['matured_days']==0
    items,kw=fixture();del kw['prices'][(kw['calendar'][5],'A')]
    result=evaluate(items[:1],**kw)
    assert result['matured_days']==0 and result['excluded'][0]['reason']=='incomplete_labels'

def test_duplicate_day_or_changed_model_cannot_share_window():
    items,kw=fixture()
    with pytest.raises(ValueError,match='duplicate_day'):evaluate(items[:1]*2,**kw)
    items[0]['forecast']['model_checksum']='c'*64
    with pytest.raises(ValueError,match='binding'):evaluate(items[:1],**kw)

def test_no_fabricated_confidence_interval_before_twenty_days():
    items,kw=fixture();result=evaluate(items[:6],**kw)
    assert result['days_remaining']==14 and result['summary']['rank_ic']['difference_ci95'] is None
