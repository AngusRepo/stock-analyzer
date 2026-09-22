import hashlib, json, sqlite3
import pytest
from services.retention_archive import SCHEMA
from services.retention_market_history import archived_market_projection


def archive(rows=None, artifact='a'):
 rows=rows or [dict(id=1,stock_id=1,date='2025-01-01',close=101.),dict(id=2,stock_id=2,date='2025-01-01',close=102.)]
 rows=[dict(r,__cursor_key=r['id'],__archive_date=r['date']) for r in rows]
 payload=dict(schema_version=SCHEMA,policy_id='canonical_market_hot_v1',dataset_id='stock_prices',source_domain='market',cutoff_date='2026-01-01',source_schema_sql='CREATE TABLE stock_prices(id INTEGER PRIMARY KEY, stock_id INTEGER,date TEXT,close REAL)',rows=rows)
 raw=json.dumps(dict(schema_version=SCHEMA,domain='retention_canonical_market_hot_v1_stock_prices',payload=payload)).encode()
 m=dict(artifact_id=artifact,checksum=hashlib.sha256(raw).hexdigest(),domain='retention_canonical_market_hot_v1_stock_prices',schema_version=SCHEMA,row_count=len(rows),release_verified_at='2026-01-01',metadata_json='{}')
 return raw,m


def read(raw,m,hot=lambda *a:[],sql='SELECT stock_id,date,close FROM stock_prices WHERE date BETWEEN ? AND ?'):
 return list(archived_market_projection('stock_prices',sql,['2025-01-01','2025-01-02'],'2025-01-01','2025-01-02',query_hot=hot,query_ops=lambda *a:[m],download=lambda *a:raw))


def test_projection_restores_original_values_and_natural_key_hot_precedence():
 raw,m=archive()
 db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
 db.execute('CREATE TABLE stock_prices(id INTEGER,stock_id INTEGER,date TEXT,close REAL)')
 db.execute("INSERT INTO stock_prices VALUES (99,1,'2025-01-01',105)")
 rows=read(raw,m,hot=lambda sql,params:[dict(r) for r in db.execute(sql,params)])
 assert rows==[dict(stock_id=2,date='2025-01-01',close=102.)]


def test_checksum_and_release_proof_required_before_history_is_used():
 raw,m=archive()
 with pytest.raises(ValueError,match='checksum'):read(raw+b' ',m)
 m['release_verified_at']=None
 with pytest.raises(RuntimeError,match='release_receipt_incomplete'):read(raw,m)


def test_cold_schema_mismatch_is_visible_not_empty_history():
 raw,m=archive()
 with pytest.raises(sqlite3.OperationalError,match='no such column'):
  read(raw,m,sql='SELECT absent FROM stock_prices WHERE date BETWEEN ? AND ?')


def test_snapshot_query_loads_cold_once_not_once_per_hot_window(monkeypatch):
 from services import dataset_snapshot_exporter as e,retention_market_history as h
 class Client:
  def query(self,*a,**k):return []
 calls=[]
 def cold(*a,**k):
  calls.append(a)
  yield dict(stock_id=1,date='2025-01-01',close=101.)
 monkeypatch.setattr(h,'archived_market_projection',cold)
 frame,n=e._query_date_range('SELECT stock_id,date,close FROM stock_prices WHERE date BETWEEN ? AND ?','2025-01-01','2025-05-01',30,query_client=Client())
 assert n==5 and len(calls)==1 and frame.height==1
 assert frame['close'][0]==101.


def test_bulk_backtest_combines_exact_cold_prices_once(monkeypatch):
 import asyncio
 from services import backtest_service as b,retention_market_history as h
 async def hot(*a,**k):return [dict(stock_id=1,date='2026-01-01',close=103.)]
 calls=[]
 def cold(*a,**k):
  calls.append(a)
  yield dict(stock_id=1,date='2025-01-01',close=101.)
 monkeypatch.setattr(b,'_d1_query',hot)
 monkeypatch.setattr(h,'archived_market_projection',cold)
 result,n=asyncio.run(b._bulk_load_prices_by_stock(None,[1]))
 assert len(calls)==1 and n==1
 assert [r['close'] for r in result[1]]==[101.,103.]


@pytest.mark.parametrize('method,table', [('_load_prices','stock_prices'),('_load_indicators','technical_indicators'),('_load_chips','chip_data')])
def test_backtest_dataset_does_not_shorten_history_to_hot_window(monkeypatch,method,table):
 from services import backtest_engine as b,retention_market_history as h
 monkeypatch.setattr(b.MARKET_D1_CLIENT,'query',lambda *a,**k:[])
 calls=[]
 def cold(*a,**k):
  calls.append(a)
  yield dict(date='2025-01-01',**({'symbol':'2330','foreign_net':10} if table=='chip_data' else {'stock_id':1,'close':101.}))
 monkeypatch.setattr(h,'archived_market_projection',cold)
 args=(['2330'],'2025-01-01','2025-05-01') if table=='chip_data' else ([1],{1:'2330'},'2025-01-01','2025-05-01')
 result=getattr(b.BacktestDataset,method)(*args)
 assert len(calls)==1 and calls[0][0]==table
 assert result['symbol'].to_list()==['2330'] and result['date'].to_list()==['2025-01-01']
