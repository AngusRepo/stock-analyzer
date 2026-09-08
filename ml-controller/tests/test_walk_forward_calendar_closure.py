from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from routers import walk_forward as wf
import pytest

def test_resume_preserves_parent_folds_when_historical_calendar_is_repaired(monkeypatch):
    from services import walk_forward_retrain, active8_oof_cohort_materializer
    days=[f"2026-01-{i:02}" for i in range(1,16)]
    parent={"start_date":days[0],"train_window_days":5,"test_window_days":3,"manifest_checksum":"a"*64,
      "windows":[{"window_id":0,"train_range":[days[0],days[5]],"test_range":[days[6],days[9]]}]}
    calls=[]
    monkeypatch.setattr(walk_forward_retrain,'_get_bucket',lambda:object())
    monkeypatch.setattr(wf,'_oof_lifecycle_calendar',lambda cutoff,**kw:(calls.append((cutoff,kw)) or (days,{"calendar_source":"immutable"})))
    monkeypatch.setattr(wf,'_load_trading_calendar',lambda *a:pytest.fail('D1 must not replan immutable folds'))
    monkeypatch.setattr(active8_oof_cohort_materializer,'load_verified_oof_manifest',lambda *a,**kw:(parent,b''))
    req=wf.WalkForwardRequest(start_date=days[0],end_date=days[12],train_window_days=5,test_window_days=3,
       prep_gcs_prefix='immutable/prep',resume_manifest_path='parent',knowledge_cutoff_date='2026-01-20',expected_producer_source_sha='b'*40)
    dates,evidence,windows=wf._walk_forward_calendar_and_windows(req)
    assert len(windows)==2
    assert wf._window_split_key(windows[0])==tuple(parent['windows'][0]['train_range']+parent['windows'][0]['test_range'])
    assert windows[1].test_start==days[10] and windows[1].test_end==days[12]
    assert windows[1].train_end==days[9] and windows[1].train_start==days[5]
    assert calls[0][0]=='2026-01-20'
    assert calls[0][1]['expected_producer_source_sha']=='b'*40
    assert evidence['parent_manifest_checksum']=='a'*64
    req.start_date=days[1]
    with pytest.raises(wf.HTTPException,match='resume calendar contract mismatch'):
        wf._walk_forward_calendar_and_windows(req)

def test_resume_rejects_mutable_calendar():
    with pytest.raises(wf.HTTPException,match='resume requires immutable prep'):
        wf._walk_forward_calendar_and_windows(wf.WalkForwardRequest(start_date='2026-01-01',end_date='2026-02-01',resume_manifest_path='parent'))


def test_new_native_pit_gap_cannot_be_declared_success():
    from services.active8_oof_cohort_materializer import _classify_forward_evaluability
    evidence={"stacker_eligible_by_date":{"2026-08-31":10,"2026-09-01":10},
      "native_matched_by_date":{"2026-08-31":10},"snapshot_rows_by_date":{"2026-08-31":10},
      "rejected_by_date":{"2026-09-01":{"native_pit_components_missing":10}}}
    with pytest.raises(RuntimeError,match='missing_native_pit_components'):
        _classify_forward_evaluability(['2026-08-31','2026-09-01'],evidence)
    evidence['native_matched_by_date']['2026-09-01']=10
    evidence['snapshot_rows_by_date']['2026-09-01']=10
    assert _classify_forward_evaluability(['2026-08-31','2026-09-01'],evidence)['not_evaluable']==[]
