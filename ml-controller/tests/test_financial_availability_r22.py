import pandas as pd
import numpy as np
import pytest
import sys
import json
from types import SimpleNamespace
from services.financial_availability import align_financial_availability
from test_finlab_remote_backfill_tool_contract import _load_tool_module


def resolve(values,disclosures,deadlines,sessions):
    index=[f'2023-Q{i+1}' for i in range(len(values))]
    raw=pd.DataFrame({'0050':values},index=index)
    d=pd.DataFrame({'0050':pd.to_datetime(disclosures)},index=index)
    e=pd.DataFrame({'0050':pd.to_datetime(deadlines)},index=index)
    return align_financial_availability(raw,(d,e),pd.to_datetime(sessions))


def test_late_publication_delays_zero_without_rejection():
    x=resolve([0.],['2023-05-18'],['2023-05-15'],['2023-05-15','2023-05-18'])
    assert list(x.index)==[pd.Timestamp('2023-05-18')]
    assert x.iloc[0,0]==0 and x.attrs['financial_availability_proof']['late_disclosure_cells']==1


def test_early_publication_keeps_deadline_policy():
    x=resolve([12.],['2023-05-10'],['2023-05-15'],['2023-05-10','2023-05-15'])
    assert list(x.index)==[pd.Timestamp('2023-05-15')]


def test_weekend_moves_forward_only():
    x=resolve([12.],['2023-05-20'],['2023-05-15'],['2023-05-19','2023-05-22'])
    assert list(x.index)==[pd.Timestamp('2023-05-22')]


def test_old_quarter_late_upload_never_overwrites_new_quarter():
    x=resolve([1.,2.],['2023-10-01','2023-08-14'],['2023-05-15','2023-08-14'],['2023-05-15','2023-08-14','2023-10-02'])
    assert list(x['0050'])==[2.]
    assert x.attrs['financial_availability_proof']['older_quarter_late_arrivals_not_overwriting']==1


def test_same_session_keeps_newest_quarter():
    x=resolve([1.,2.],['2023-08-14','2023-08-14'],['2023-05-15','2023-08-14'],['2023-05-15','2023-08-14'])
    assert list(x['0050'])==[2.]


def test_future_disclosure_has_no_early_value():
    x=resolve([12.],['2023-06-01'],['2023-05-15'],['2023-05-15','2023-05-31'])
    assert x.empty and x.attrs['financial_availability_proof']['calendar_unresolved_cells']==1


def test_missing_date_still_requires_owner():
    with pytest.raises(ValueError,match='owner_missing'):
        resolve([12.],[None],['2023-05-15'],['2023-05-15'])


def test_unpublished_deadline_waits_without_fabricating_a_date():
    # 10/30: 6026 disclosed 2026-Q3 on 10/29 before FinLab published its Q3 deadline.
    raw=pd.DataFrame({'2330':[9.,10.],'6026':[1.,1.86]},index=['2026-Q2','2026-Q3'])
    d=pd.DataFrame({'2330':pd.to_datetime(['2026-08-10','2026-10-28']),'6026':pd.to_datetime(['2026-08-13','2026-10-29'])},index=raw.index)
    e=pd.DataFrame({'2330':pd.to_datetime(['2026-08-14','2026-11-16']),'6026':pd.to_datetime(['2026-08-31',None])},index=raw.index)
    sessions=pd.to_datetime(['2026-08-14','2026-08-31','2026-10-29','2026-10-30'])
    x=align_financial_availability(raw,(d,e),sessions)
    proof=x.attrs['financial_availability_proof']
    assert proof['deadline_unpublished_pending_cells']==1 and proof['valued_cells']==3
    assert x.loc['2026-08-31','6026']==1. and not (x['6026']==1.86).any()
    events=x.attrs['financial_availability_events']
    assert events.filter((events['symbol']=='6026')&(events['quarter']=='2026-Q3')).height==0
    # The held output equals the output without the cell; once the deadline arrives the old rule admits it.
    y=align_financial_availability(raw.assign(**{'6026':[1.,np.nan]}),(d,e),sessions)
    pd.testing.assert_frame_equal(x,y)
    e.loc['2026-Q3','6026']=pd.Timestamp('2026-11-16')
    z=align_financial_availability(raw,(d,e),pd.to_datetime(['2026-10-30','2026-11-16']))
    assert z.loc['2026-11-16','6026']==1.86 and z.attrs['financial_availability_proof']['deadline_unpublished_pending_cells']==0


def test_deadline_hold_does_not_cover_bad_owner_values():
    # A deadline that exists but is not a date still fails; so does a symbol with no disclosure.
    raw=pd.DataFrame({'6026':[1.86]},index=['2026-Q3'])
    d=pd.DataFrame({'6026':pd.to_datetime(['2026-10-29'])},index=raw.index)
    with pytest.raises(ValueError,match='owner_date_invalid'):
        align_financial_availability(raw,(d,pd.DataFrame({'6026':[20261116.]},index=raw.index)),pd.to_datetime(['2026-10-30']))
    with pytest.raises(ValueError,match='owner_missing'):
        align_financial_availability(raw,(d,pd.DataFrame({'6026':['not-a-date']},index=raw.index)),pd.to_datetime(['2026-10-30']))
    with pytest.raises(ValueError,match='owner_missing'):
        align_financial_availability(raw,(pd.DataFrame({'6026':pd.to_datetime([None])},index=raw.index),pd.DataFrame({'6026':pd.to_datetime([None])},index=raw.index)),pd.to_datetime(['2026-10-30']))


def test_deadline_hold_never_masks_misaligned_owner_labels():
    # Only a NaT inside a published deadline column and quarter row is held; label drift still fails.
    raw=pd.DataFrame({'6026':[1.86]},index=['2026-Q3'])
    d=pd.DataFrame({'6026':pd.to_datetime(['2026-10-29'])},index=raw.index)
    published=pd.DataFrame({'2330':pd.to_datetime(['2026-11-16']),'6026':pd.to_datetime([None])},index=raw.index)
    sessions=pd.to_datetime(['2026-10-30'])
    assert align_financial_availability(raw,(d,published),sessions).attrs['financial_availability_proof']['deadline_unpublished_pending_cells']==1
    cases=[published.rename(columns={'6026':6026}),               # int labels
           published.rename(index={'2026-Q3':'2026Q3'}),          # quarter format drift
           published.drop(columns='6026'),                        # symbol absent from the owner
           published.assign(**{'6026':[np.nan]}),                 # all-NaN numeric column
           pd.DataFrame({'2330':pd.to_datetime([None]),'6026':pd.to_datetime([None])},index=raw.index)]  # no published row
    for owner in cases:
        with pytest.raises(ValueError,match='owner_(missing|date_invalid)'):
            align_financial_availability(raw,(d,owner),sessions)
    with pytest.raises(ValueError,match='nonfinite'):
        align_financial_availability(raw.assign(**{'6026':[np.inf]}),(d,published),sessions)


def test_multi_symbol_keeps_null_and_does_not_cross_fill():
    raw=pd.DataFrame({'0050':[0.], '2330':[9.]},index=['2023-Q1'])
    d=pd.DataFrame({'0050':pd.to_datetime(['2023-05-15']),'2330':pd.to_datetime(['2023-05-18'])},index=raw.index)
    e=d.copy();e[:]=pd.Timestamp('2023-05-15')
    x=align_financial_availability(raw,(d,e),pd.to_datetime(['2023-05-15','2023-05-18']))
    assert np.isnan(x.loc['2023-05-15','2330']) and x.loc['2023-05-18','0050']==0


def test_actual_producer_uses_resolved_date():
    tool=_load_tool_module()
    class Raw(pd.DataFrame):
        def deadline(self):pytest.fail('must use pinned date owners, not hidden SDK fetch')
    raw=Raw({'1435':[-0.02116896468095244]},index=['2023-Q1'])
    d=pd.DataFrame({'1435':pd.to_datetime(['2023-05-18'])},index=raw.index)
    e=pd.DataFrame({'1435':pd.to_datetime(['2023-05-15'])},index=raw.index)
    x=tool.normalize_finlab_wide_field(raw,api_key_name='fundamental_features:每股稅後淨利',date_owners=(d,e),sessions=pd.to_datetime(['2023-05-15','2023-05-18']))
    assert list(x.index)==[pd.Timestamp('2023-05-18')] and x.iloc[0,0]==raw.iloc[0,0]


def test_materializer_accepts_late_financial_and_saves_evidence(monkeypatch,tmp_path):
    tool=_load_tool_module()
    class Raw(pd.DataFrame):
        def deadline(self):pytest.fail('hidden SDK alignment must not run')
    raw=Raw({'1435':[-0.02116896468095244]},index=['2023-Q1'])
    frames={'fundamental_features:每股稅後淨利':raw,
        'etl:financial_statements_disclosure_dates':pd.DataFrame({'1435':pd.to_datetime(['2023-05-18'])},index=raw.index),
        'etl:financial_statements_deadline':pd.DataFrame({'1435':pd.to_datetime(['2023-05-15'])},index=raw.index),
        'price:收盤價':pd.DataFrame(index=pd.to_datetime(['2023-05-15','2023-05-18']))}
    monkeypatch.setitem(sys.modules,'finlab',SimpleNamespace(data=SimpleNamespace(get=lambda key:frames[key]),login=lambda:None))
    monkeypatch.setattr(tool,'login_finlab_sdk',lambda fn:None)
    monkeypatch.setattr(tool,'d1_counts',lambda *a:{})
    out=tmp_path/'out'
    tool.materialize_specs(years=3,run_dir=out,lanes=['fundamental_factor_diversity'],
        key_scope={'fundamental_factor_diversity':{'eps'}},source_start_date='2023-01-01',source_end_date='2023-05-18')
    saved=pd.read_parquet(out/'raw/fundamental_factor_diversity/eps.parquet')
    assert list(saved.index)==[pd.Timestamp('2023-05-18')]
    proof,=list((out/'raw/financial_availability').glob('*.json'))
    receipt=json.loads(proof.read_text())
    assert receipt['late_disclosure_cells']==1 and receipt['status']=='availability_resolved'
    assert set(receipt['date_owners'])=={'deadline','disclosure','sessions'}
