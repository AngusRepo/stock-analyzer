import copy
import numpy as np
import pytest
from app.full_fit_scope import bounds, row_mask, sequence_records
from app.deployment_refit import validate_full_history


def payload():
    return dict(candidate_type="oof_full_fit_release", generation_mode="oof_full_fit_release",
                run_date="2026-10-01", signal_date_max="2026-09-22", label_known_at_max="2026-10-01")


@pytest.mark.parametrize("change", [dict(signal_date_max=None), dict(label_known_at_max=None),
    dict(label_known_at_max="2026-10-08"), dict(signal_date_max="2026-10-01"),
    dict(test_start="2026-09-01"), dict(generation_mode="native",candidate_type=None)])
def test_incomplete_or_mismatched_scope_rejected(change):
    with pytest.raises((ValueError, TypeError)):
        bounds({**payload(), **change})


def test_tabular_both_dates_and_original_guard_remain_enforced():
    days=np.array(["2026-09-21","2026-09-22","2026-09-22","2026-09-23"])
    known=np.array(["2026-09-30","2026-10-01","2026-10-02","2026-10-02"])
    mask=row_mask(payload(),days,known)
    assert mask.tolist()==[True,True,False,False]
    assert row_mask({},days,known).all()
    with pytest.raises(ValueError,match="future"):
        validate_full_history(signal_dates=days,label_known_dates=known,cutoff="2026-10-01")
    receipt=validate_full_history(signal_dates=days[mask],label_known_dates=known[mask],cutoff="2026-10-01")
    assert receipt['rows']==2 and receipt['train_range'][-1]=='2026-09-22'
    assert receipt['label_known_date_max']=='2026-10-01'


def test_sequence_uses_exchange_sessions_and_future_poison_never_reaches_panel():
    # Exchange sessions: 9/25 and 9/28 are closed, weekends omitted.
    days=['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-29',
          '2026-09-30','2026-10-01','2026-10-02','2026-10-05','2026-10-06']
    records=[dict(symbol='2330',dates=days,open=list(range(100,110)),close=list(range(101,111)))]
    before=copy.deepcopy(records)
    clean,receipt=sequence_records(payload(),records,horizon=5)
    assert records==before
    assert clean[0]['dates'][-1]=='2026-10-01'
    assert receipt['actual_signal_date_max']=='2026-09-22'
    assert receipt['actual_label_known_at_max']=='2026-10-01'
    assert receipt['archive_observation_max']=='2026-10-06'
    assert not receipt['point_in_time_vintage_certified']
    records[0]['open'][7:]=[-999]*3;records[0]['close'][7:]=[99999]*3
    assert sequence_records(payload(),records,horizon=5)[0]==clean
    # A stricter signal cutoff also limits target history even if known date is unchanged.
    earlier,receipt=sequence_records({**payload(),'signal_date_max':'2026-09-21'},records,horizon=5)
    assert earlier[0]['dates'][-1]=='2026-09-30'
    assert receipt['actual_signal_date_max']=='2026-09-21'


def test_timeXer_full_fit_does_not_relax_oof_validation():
    from app.timexer_cutoff import input_scope, admitted
    manifest=dict(source_feature_date_max='2026-10-08')
    scope=input_scope(manifest,payload())
    assert admitted('2026-09-22','2026-10-01',scope)
    assert not admitted('2026-09-23','2026-10-01',scope)
    assert scope['archive_source_feature_date_max']=='2026-10-08'
    with pytest.raises(ValueError):
        input_scope(manifest,{**payload(),'test_start':'2026-09-01'})


def test_training_policy_keeps_scope_for_tree_children():
    from app.training_policy import UniversalTrainingPolicy, build_group_train_payload
    from app.universal_training import UniversalTrainRequest
    base=UniversalTrainingPolicy.from_env().to_base_train_payload(payload(),candidate_version='test')
    actual=UniversalTrainRequest(**build_group_train_payload(base,'tree')).model_dump()
    assert bounds(actual)==bounds(payload())


@pytest.mark.parametrize('name',['TabM','GNN'])
def test_real_trainer_preprocessing_ignores_post_cutoff_poison(monkeypatch,name):
    from datetime import date,timedelta
    from tests.test_deployment_refit import panel
    from app import tabm_training as tabm,gnn_training as gnn
    module=tabm if name=='TabM' else gnn
    clean=panel();archive=copy.deepcopy(clean)
    for key,value in vars(archive).items():
        if isinstance(value,np.ndarray):setattr(archive,key,np.concatenate([value,value[:100]],axis=0))
    archive.dates[-100:]=np.repeat([str(date(2026,3,2)+timedelta(days=i)) for i in range(5)],20)
    archive.label_known_dates[-100:]=np.repeat([str(date(2026,3,7)+timedelta(days=i)) for i in range(5)],20)
    archive.X[-100:]=99999;archive.target_returns[-100:]=-99999
    current=[archive]; captured=[]
    monkeypatch.setattr(module,'_get_bucket',lambda:object())
    monkeypatch.setattr(module,'collect_prep_lineage',lambda *a,**k:{})
    if name=='TabM':
        monkeypatch.setattr(tabm,'load_tabular_dataset',lambda *a,**k:current[0])
        train=tabm.train_tabm_universal
    else:
        def load(*a,**k):
            d=current[0]
            return (d.X,d.y,d.target_returns,d.dates,d.sectors,d.symbols,d.markets,d.label_known_dates,{'prep_objects':0,'prep_bytes':0})
        monkeypatch.setattr(gnn,'_load_npz_batches',load)
        monkeypatch.setattr(gnn,'_load_feature_names',lambda *a,**k:archive.feature_names)
        train=gnn.train_graphsage_universal
    class BeforeFit(Exception): pass
    def standardize(training,all_rows,**kwargs):
        captured.append((training.copy(),all_rows.copy()))
        raise BeforeFit()
    monkeypatch.setattr(module,'_robust_standardize',standardize)
    args=dict(epochs=1,batch_size=256,run_date='2026-03-06',generation_mode='local_full_fit',seed=42,
              signal_date_max='2026-03-01',label_known_at_max='2026-03-06')
    with pytest.raises(BeforeFit):train(args)
    current[0]=clean
    with pytest.raises(BeforeFit):train(args)
    assert len(captured[0][1])==1200
    for left,right in zip(captured[0],captured[1]):np.testing.assert_array_equal(left,right)
