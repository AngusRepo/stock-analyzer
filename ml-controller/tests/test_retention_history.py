import hashlib,json
import pytest
from services.retention_archive import SCHEMA
from services.retention_history import archived_predictions

def fixture():
 rows=[{'__cursor_key':i,'__archive_date':'2025-01-01','id':i,'stock_id':100+i,'model_name':'ensemble','prediction_date':'2025-01-01','generated_at':'2025-01-01T00:00:00','direction_correct':1} for i in (1,2)]
 payload={'schema_version':SCHEMA,'policy_id':'learning_lineage_v1','dataset_id':'predictions','source_domain':'learning','cutoff_date':'2026-01-01','source_schema_sql':'CREATE TABLE predictions(id INTEGER PRIMARY KEY,stock_id INTEGER,model_name TEXT,prediction_date TEXT,generated_at TEXT,direction_correct INTEGER)','rows':rows}
 raw=json.dumps({'schema_version':SCHEMA,'domain':'retention_learning_lineage_v1_predictions','payload':payload},ensure_ascii=False).encode()
 manifest={'artifact_id':'a','checksum':hashlib.sha256(raw).hexdigest(),'domain':'retention_learning_lineage_v1_predictions','schema_version':SCHEMA,'row_count':2,'release_verified_at':'2026-01-02','metadata_json':'{}'}
 return raw,manifest

def read(raw,manifest,**kw):
 return list(archived_predictions('2025-01-01','2025-01-02',query_ops=lambda *a:[manifest],query_hot=lambda *a:[],download=lambda m:raw,**kw))

def test_cold_history_preserves_original_dates_and_identity():
 raw,m=fixture();rows=read(raw,m)
 assert [r['id'] for r in rows]==[1,2] and '__cursor_key' not in rows[0]
 assert rows[0]['prediction_date']=='2025-01-01'

def test_hot_wins_and_model_and_stock_filters_do_not_create_zeros():
 raw,m=fixture()
 assert [r['id'] for r in read(raw,m,hot_ids=[1])]==[2]
 assert [r['id'] for r in read(raw,m,stock_ids=[101])]==[1]
 assert read(raw,m,model_name='missing')==[]
 rows=list(archived_predictions('2025-01-01','2025-01-02',query_ops=lambda *a:[m],query_hot=lambda *a:[{'id':1}],download=lambda m:raw))
 assert [r['id'] for r in rows]==[2]

def test_archive_without_completed_release_fails_if_hot_rows_missing():
 raw,m=fixture();m['release_verified_at']=None
 with pytest.raises(RuntimeError,match='release_receipt_incomplete'):read(raw,m)
 assert read(raw,m,hot_ids=[1,2])==[]

def test_corrupt_archive_never_silently_returns_empty_history():
 raw,m=fixture()
 with pytest.raises(ValueError,match='checksum'):read(raw+b' ',m)

def test_backtest_rolling_accuracy_reads_original_cold_period(monkeypatch):
 from services import backtest_state,retention_history
 raw,m=fixture()
 monkeypatch.setattr(backtest_state.LEARNING_D1_CLIENT,'query',lambda *a:[])
 monkeypatch.setattr(retention_history.OPS,'query',lambda *a:[m])
 monkeypatch.setattr(retention_history.LEARNING,'query',lambda *a:[])
 monkeypatch.setattr(retention_history,'download_archive',lambda manifest:raw)
 rows=backtest_state.load_verified_predictions('2025-01-01','2025-01-02')
 assert rows==[{'generated_at':'2025-01-01T00:00:00','direction_correct':1}]*2
 assert backtest_state.compute_rolling_accuracy_30d(rows,'2025-01-02',min_samples=1)==1.0

def test_prediction_cache_latest_revision_wins_across_hot_and_cold(monkeypatch):
 from services import domain_stock_read_models as stocks,retention_history
 from services.backtest_engine import MLPredictionsCache
 monkeypatch.setattr(stocks,'load_learning_rows_with_symbol',lambda *a:[{'id':9,'symbol':'2330','d':'2025-01-01','generated_at':'2025-01-02','conf':0.8}])
 monkeypatch.setattr(stocks,'load_core_stock_identities',lambda:{1:{'symbol':'2330'},2:{'symbol':'2317'}})
 monkeypatch.setattr(retention_history,'archived_predictions',lambda *a,**k:iter([
  {'id':1,'stock_id':1,'prediction_date':'2025-01-01','generated_at':'2025-01-01','direction_accuracy':0.2},
  {'id':2,'stock_id':2,'prediction_date':'2025-01-01','generated_at':'2025-01-01','direction_accuracy':0.7}]))
 cache=MLPredictionsCache.load_from_d1('2025-01-01','2025-01-02')
 assert cache.get('2330','2025-01-01')==0.8
 assert cache.get('2317','2025-01-01')==0.7


def test_bulk_backtest_uses_one_cold_pass_and_preserves_signal_payload(monkeypatch):
 import asyncio
 from services import backtest_service,retention_history
 async def hot(*a,**kw):return [{'id':2,'stock_id':1,'prediction_date':'2026-01-02','generated_at':'2026-01-02','trade_signal':'HOLD','forecast_data':'{"signal":"HOLD"}'}]
 calls=[]
 def cold(*a,**kw):
  calls.append(kw)
  return iter([{'id':1,'stock_id':1,'prediction_date':'2025-01-01','generated_at':'2025-01-01','trade_signal':'BUY','forecast_data':'{"signal":"BUY"}'}])
 monkeypatch.setattr(backtest_service,'_d1_query',hot)
 monkeypatch.setattr(retention_history,'archived_predictions',cold)
 rows,count=asyncio.run(backtest_service._bulk_load_ensemble_signals_by_stock(None,[1]))
 assert count==1 and len(calls)==1 and calls[0]['hot_ids']==[2]
 assert [r['trade_signal'] for r in rows[1]]==['BUY','HOLD']
 assert rows[1][0]['forecast_data']=='{"signal":"BUY"}' and 'id' not in rows[1][0]

def test_compute_snapshot_export_keeps_archived_signals(monkeypatch):
 import polars as pl
 from services import dataset_snapshot_exporter as exporter,retention_history
 monkeypatch.setattr(exporter,'_query_active_stocks',lambda *a:pl.DataFrame({'id':[1],'symbol':['2330']}))
 monkeypatch.setattr(exporter,'_query_prices',lambda *a:(pl.DataFrame({'stock_id':[1],'date':['2025-01-01'],'close':[100.]}),1))
 def query(sql,*a,**kw):
  if 'FROM predictions' in sql:
   return pl.DataFrame({'id':[2],'stock_id':[1],'generated_at':['2025-01-02'],'prediction_date':['2025-01-02'],'trade_signal':['HOLD'],'direction_accuracy':[0.6],'entry_price':[101.],'stop_loss':[95.],'target1':[110.],'target2':[120.],'forecast_data':['{}']}),1
  return pl.DataFrame(),1
 monkeypatch.setattr(exporter,'_query_date_range',query)
 for name in ('_query_market_risk','_query_monthly_revenue','_query_canonical_fundamentals'):
  monkeypatch.setattr(exporter,name,lambda *a:pl.DataFrame())
 for name in ('_query_sentiment_scores','_query_margin_data','_query_shareholding'):
  monkeypatch.setattr(exporter,name,lambda *a:(pl.DataFrame(),0))
 def cold(*a,**kw):
  assert kw['hot_ids']==[2] and a==('2025-01-01','2025-01-02')
  return iter([{'id':1,'stock_id':1,'generated_at':'2025-01-01','prediction_date':'2025-01-01','trade_signal':'BUY','direction_accuracy':0.7,'entry_price':100.,'forecast_data':'{"retained":true}'}])
 monkeypatch.setattr(retention_history,'archived_predictions',cold)
 monkeypatch.setattr(exporter,'_write_compute_snapshot',lambda **kw:kw)
 req=exporter.DatasetSnapshotExportRequest(business_date='2026-09-22',start_date='2025-01-01',end_date='2025-01-02')
 result=exporter.export_backtest_dataset_snapshot(req)
 signals=result['components']['signals']
 assert signals['prediction_date'].to_list()==['2025-01-01','2025-01-02']
 assert signals['forecast_data'][0]=='{"retained":true}'
 assert 'id' not in signals.columns


def test_source_proof_survives_lost_ops_acknowledgement():
 raw,m=fixture();m['release_verified_at']=None
 def hot(sql,params):
  if 'sqlite_master' in sql:return [{'name':'learning_retention_releases_v1'}]
  if 'FROM learning_retention_releases_v1' in sql:return [{'checksum':m['checksum'],'dataset_id':'predictions','row_count':m['row_count']}]
  return []
 rows=list(archived_predictions('2025-01-01','2025-01-02',query_ops=lambda *a:[m],query_hot=hot,download=lambda m:raw))
 assert len(rows)==2


def test_wrong_source_proof_fails_closed():
 raw,m=fixture();m['release_verified_at']=None
 def hot(sql,params):
  if 'sqlite_master' in sql:return [{'name':'learning_retention_releases_v1'}]
  if 'FROM learning_retention_releases_v1' in sql:return [{'checksum':'wrong','dataset_id':'predictions','row_count':2}]
  return []
 with pytest.raises(RuntimeError,match='release_receipt_incomplete'):
  list(archived_predictions('2025-01-01','2025-01-02',query_ops=lambda *a:[m],query_hot=hot,download=lambda m:raw))
