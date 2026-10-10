from datetime import date
import polars as pl
import pytest
from app.feature_data_quality import join_available_history, DAILY_OBSERVATION_FIELDS

def frame():
    return pl.DataFrame({'date':[date(2026,1,9),date(2026,1,12),date(2026,1,13)]})

@pytest.mark.parametrize('field', sorted(DAILY_OBSERVATION_FIELDS))
def test_daily_values_do_not_spread_into_missing_days(field):
    df=join_available_history(frame(),{'2026-01-09':{field:1,'eps':4},'2026-01-13':{'roe':10}})
    key='issuer_limit_down_count_10' if field=='limit_down_count' else field
    assert df[key].to_list()==[1.,None,None]
    assert df['eps'].to_list()==[4.,4.,4.]

@pytest.mark.parametrize('field', sorted(DAILY_OBSERVATION_FIELDS))
def test_zero_valid_null_unobserved_and_no_fallback_to_stale_scalar(field):
    key='issuer_limit_down_count_10' if field=='limit_down_count' else field
    original=frame().with_columns(pl.lit(99.).alias(key))
    df=join_available_history(original,{'2026-01-09':{field:0},'2026-01-12':{field:None}})
    assert df[key].to_list()==[0.,None,None]

def test_weekend_publication_carries_fundamental_but_not_daily_event():
    df=join_available_history(frame(),{'2026-01-10':{'eps':4,'disposal_active':1}})
    assert df['eps'].to_list()==[None,4.,4.]
    assert df['disposal_active'].to_list()==[None,None,None]

def test_daily_only_history_preserves_input_rows_and_sorted_dates():
    df=join_available_history(frame().reverse(),{'2026-01-12':{'locked_open_down':2}})
    assert df['date'].to_list()==frame()['date'].to_list()
    assert df['locked_open_down'].to_list()==[None,2.,None]

def test_real_prep_receipt_counts_only_exact_daily_observations(monkeypatch):
    import io,json
    from datetime import timedelta
    import numpy as np
    from app import universal_training as u
    class Bucket:
        data={}
        def blob(self,path):
            target=self.data
            class Blob:
                def upload_from_string(self,value,**kwargs): target[path]=value
                def upload_from_file(self,stream,**kwargs): target[path]=stream.read()
            return Blob()
    prices=[{'date':str(date(2026,1,1)+timedelta(days=i)),
             'open':100+i,'high':102+i,'low':99+i,'close':101+i,
             'adj_close':101+i,'volume':10000} for i in range(60)]
    indicators=[{'date':r['date'],'plusDi14':20,'minusDi14':10,'adx14':25,'parabolicSar':r['close']*.98}
                for r in prices]
    bucket=Bucket();monkeypatch.setattr(u,'_get_bucket',lambda:bucket)
    result=u.prep_universal_batch(u.UniversalPrepRequest(
        payloads=[{'stock_id':1,'symbol':'TEST','market':'TW','prices':prices,'indicators':indicators}],
        per_stock_ts_map={'1':{prices[20]['date']:{'limit_down_count':0},prices[30]['date']:{'limit_down_count':2}}},
        gcs_prefix='daily-mask',retain_unlabeled_features=True))
    names=json.loads(bucket.data['daily-mask/prep/feature_names.json'])
    with np.load(io.BytesIO(bucket.data['daily-mask/prep/batch_0.npz']),allow_pickle=False) as data:
        assert data['X'].shape==(60,137)
        assert data['missingness_rates'][names.index('tech_limit_down_count_10')]==pytest.approx(58/60)
    assert result['cleaning_report']['source_missingness_by_feature']['tech_limit_down_count_10']==pytest.approx(58/60)
