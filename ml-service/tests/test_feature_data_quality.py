from datetime import date,timedelta
import io,json
import numpy as np
import polars as pl
import pytest
from app.features import build_feature_matrix,FEATURE_COLS,sanitize_feature_frame
from app.feature_data_quality import join_available_history
from app import universal_training
class MemoryBucket:
    def __init__(self): self.files = {}
    def blob(self, name):
        bucket = self
        class Blob:
            def upload_from_file(self, stream, **kwargs): bucket.files[name] = stream.read()
            def upload_from_string(self, value, **kwargs): bucket.files[name] = value
        return Blob()

def prices(n=100):
    days=[date(2026,1,1)+timedelta(days=i) for i in range(n*2)]
    return [{'date':str(d),'open':100+i*.2,'high':102+i*.2,'low':99+i*.2,'close':101+i*.2,'adj_close':101+i*.2,'volume':10000+i*100} for i,d in enumerate(d for d in days if d.weekday()<5)][:n]

def test_weekend_release_is_available_next_session_and_not_before():
    df=pl.DataFrame({'date':[date(2026,1,9),date(2026,1,12),date(2026,1,13)]})
    got=join_available_history(df,{'2026-01-10':{'eps':4.0},'2026-01-13':{'roe':12.0}})
    assert got['eps'].to_list()==[None,4.0,4.0]
    assert got['roe'].to_list()==[None,None,12.0]

def test_dedicated_margin_is_used_before_deriving_ratios_without_chips():
    p=prices();h={r['date']:{'margin_balance':1000+i*10} for i,r in enumerate(p)}
    a=build_feature_matrix(p,[],[],[],{'per_stock_ts':h},historical_training=True)
    b=build_feature_matrix(p,[],[{'date':r['date'],'margin_balance':None} for r in p],[],{'per_stock_ts':h},historical_training=True)
    np.testing.assert_allclose(a['margin_ratio'],b['margin_ratio'])
    assert a['margin_ratio'][-1]>0
    assert b['margin_balance'][-1]>0

def test_imputed_open_must_never_create_a_target():
    p=prices();p[31]['open']=None
    df=build_feature_matrix(p,[],[],[],historical_training=True)
    assert df['target_5d'][30] is None

def test_duplicate_dates_rejected_not_silently_multiplied():
    p=prices()
    with pytest.raises(ValueError,match='invalid_date_keys:prices'):
        build_feature_matrix(p+[p[10]],[],[],[],historical_training=True)
    with pytest.raises(ValueError,match='invalid_date_keys:indicators'):
        build_feature_matrix(p,[{'date':p[10]['date'],'adx14':1}]*2,[],[],historical_training=True)

def test_prep_keeps_pit_sector_metadata_and_reports_hidden_zero_missingness(monkeypatch):
    p=prices();bucket=MemoryBucket();monkeypatch.setattr(universal_training,'_get_bucket',lambda:bucket)
    result=universal_training.prep_universal_batch(universal_training.UniversalPrepRequest(
        payloads=[{'stock_id':1,'symbol':'TEST','market':'TW','prices':p,'stock_meta':{'sector_encoded':99}}],
        per_stock_ts_map={'1':{p[10]['date']:{'sector':'PIT-sector'}}},gcs_prefix='quality-test',active_features=['tech_adx_14']))
    with np.load(io.BytesIO(bucket.files['quality-test/prep/batch_0.npz']),allow_pickle=True) as a:
        assert a['sectors'][:10].tolist()==['unknown']*10
        assert a['sectors'][10:].tolist()==['PIT-sector']*(len(a['sectors'])-10)
        assert a['X'].shape[1]==1
        assert a['missingness_rates'].tolist()==[1.0]
    report=json.loads(bucket.files['quality-test/prep/cleaning_report_batch_0.json'])
    assert report['quality_status']=='needs_source_review'

def test_current_sector_scalar_does_not_leak_into_historical_features():
    df=build_feature_matrix(prices(),[],[],[],{'sector_flow_core':99,'sector_rs_ratio':88,'sector_turnover_share_delta':77,'disposal_active':1},historical_training=True)
    assert df['l1_sectorFlowCore'].max()==0
    assert df['l1_sectorRsRatio'].max()==0
    assert df['tech_disposal_active'].max()==0

def test_imputation_does_not_cross_same_ticker_different_market():
    df=pl.DataFrame({'_symbol':['A','A'],'_market':['TW','US'],'_date':['2026-01-01','2026-01-02'],'f':[10.,None]})
    got,_=sanitize_feature_frame(df,feature_cols=['f'])
    assert got['f'].to_list()==[10.,0.]

def test_late_indicator_rows_cannot_change_prior_features():
    p=prices(150);ind=[{'date':r['date'],'rsi14':60.,'ma60':100.,'ma5':100.,'macd_hist':1.} for r in p[110:]]
    a=build_feature_matrix(p[:100],[],[],[],historical_training=True)
    b=build_feature_matrix(p,ind,[],[],historical_training=True)
    np.testing.assert_allclose(a.select(FEATURE_COLS).to_numpy(),b.select(FEATURE_COLS).head(100).to_numpy(),equal_nan=True)


def test_immutable_source_prep_keeps_unlabeled_features_without_fabricating_returns(monkeypatch):
    from app.target_rank_scope import recompute_global_cross_sectional_rank
    p=prices();p[31]['open']=None
    bucket=MemoryBucket();monkeypatch.setattr(universal_training,'_get_bucket',lambda:bucket)
    result=universal_training.prep_universal_batch(universal_training.UniversalPrepRequest(
        payloads=[{'symbol':'TEST','prices':p}],gcs_prefix='source-only',retain_unlabeled_features=True))
    with np.load(io.BytesIO(bucket.files['source-only/prep/batch_0.npz']),allow_pickle=True) as a:
        assert len(a['dates'])==100
        assert np.isnan(a['target_returns'][30])
        assert np.isfinite(a['X']).all()
        with pytest.raises(ValueError,match='finite_raw_targets'):
            recompute_global_cross_sectional_rank(a['target_returns'],a['dates'],a['markets'])
    assert result['cleaning_report']['canonical_targets_required'] is True
