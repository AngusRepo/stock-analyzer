from types import SimpleNamespace
import polars as pl
from services import dataset_snapshot_exporter as e

def test_input_only_actual_export_includes_us_source_without_outcome_reads(monkeypatch):
    stocks=pl.DataFrame({'id':[1],'symbol':['2330'],'market':['TWSE']})
    frame=pl.DataFrame({'date':['2026-10-07'],'stock_id':[1]})
    monkeypatch.setattr(e,'_query_active_stocks',lambda *a:stocks)
    monkeypatch.setattr(e,'_query_prices',lambda *a:(frame,1))
    monkeypatch.setattr(e,'_query_date_range',lambda *a,**k:(frame,1))
    for name in ('_query_sentiment_scores','_query_margin_data','_query_shareholding'):
        monkeypatch.setattr(e,name,lambda *a:(frame,1))
    for name in ('_query_market_risk','_query_monthly_revenue','_query_canonical_fundamentals'):
        monkeypatch.setattr(e,name,lambda *a:frame)
    calls=[]
    def query(sql,params):
        assert 'FROM us_market_signals' in sql
        calls.append(params)
        return [{'date':'2026-10-07','sentiment':'neutral','vix_close':20.}]
    monkeypatch.setattr(e,'MARKET_D1_CLIENT',SimpleNamespace(query=query))
    monkeypatch.setattr(e,'_write_compute_snapshot',lambda **kw:kw)
    req=e.DatasetSnapshotExportRequest(business_date='2026-10-07',start_date='2023-07-01',end_date='2026-10-07',include_signals=False)
    result=e.export_backtest_dataset_snapshot(req)
    assert result['components']['us_market_signals']['vix_close'].to_list()==[20.]
    assert 'signals' not in result['components']
    assert calls==[['2023-07-01','2026-10-07']]
