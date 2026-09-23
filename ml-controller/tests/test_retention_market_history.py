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


def test_archive_overlap_filtered_in_sql_and_uses_coverage_index():
 from pathlib import Path
 raw,m=archive();queries=[]
 db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
 db.executescript('CREATE TABLE run_artifacts(artifact_id TEXT,domain TEXT,schema_version TEXT,checksum TEXT,row_count INTEGER,metadata_json TEXT,retention_class TEXT,status TEXT,payload_deleted_at TEXT); CREATE TABLE data_retention_run_items(completed_at TEXT,status TEXT,deleted_rows INTEGER,evidence_json TEXT)')
 db.executescript((Path(__file__).resolve().parents[2]/'worker/domain-migrations/ops/0015_retention_source_release.sql').read_text(encoding='utf-8-sig'))
 db.executescript((Path(__file__).resolve().parents[2]/'worker/domain-migrations/ops/0016_retention_history_coverage.sql').read_text(encoding='utf-8-sig'))
 for i in range(201):
  item=dict(m,artifact_id=f'{i:04}',metadata_json=json.dumps({'coverage_start':'2030-01-01','coverage_end':'2030-01-02'}))
  if i==100:item=dict(m,artifact_id=f'{i:04}',metadata_json=json.dumps({'coverage_start':'2025-01-01','coverage_end':'2025-01-02'}))
  db.execute('INSERT INTO run_artifacts VALUES(?,?,?,?,?,?,?,?,NULL)',[item[k] for k in ['artifact_id','domain','schema_version','checksum','row_count','metadata_json']]+['ten_year_cold_archive','ready'])
  db.execute('INSERT INTO data_retention_run_items VALUES(?,?,?,?)',('2026-01-01','success',m['row_count'],json.dumps({'artifact_id':item['artifact_id'],'checksum':item['checksum']})))
 def ops(sql,params):
  queries.append((sql,params))
  return [dict(r) for r in db.execute(sql,params)]
 rows=list(archived_market_projection('stock_prices','SELECT * FROM stock_prices WHERE date BETWEEN ? AND ?',['2025-01-01','2025-01-02'],'2025-01-01','2025-01-02',query_hot=lambda *a:[],query_ops=ops,download=lambda *a:raw))
 assert len(rows)==2 and len(queries)==1
 plan=' '.join(r['detail'] for r in db.execute('EXPLAIN QUERY PLAN '+queries[0][0],queries[0][1]))
 assert 'idx_artifact_retention_coverage' in plan
 db.close()


def test_disk_duplicate_index_rejects_conflicts_and_cleans_on_close(monkeypatch,tmp_path):
 from services import retention_history_keys as h
 from contextlib import contextmanager
 from tempfile import TemporaryDirectory
 locations=[]
 @contextmanager
 def temporary(**kwargs):
  with TemporaryDirectory(dir=tmp_path,**kwargs) as directory:
   locations.append(Path(directory))
   yield directory
 from pathlib import Path
 monkeypatch.setattr(h,'TemporaryDirectory',temporary)
 with h.history_keys() as remember:
  for i in range(20000):assert remember((i,'2025-01-01'),b'a')
  assert not remember((1,'2025-01-01'),b'a')
  with pytest.raises(RuntimeError,match='revision_conflict'):remember((1,'2025-01-01'),b'b')
  assert (locations[0]/'keys.sqlite').is_file()
 assert not locations[0].exists()


def legacy_archive():
 raw,m=archive()
 body=json.loads(raw);body['payload'].pop('source_schema_sql')
 raw=json.dumps(body).encode();m['checksum']=hashlib.sha256(raw).hexdigest()
 return raw,m


def test_legacy_market_uses_verified_current_schema_and_exact_original_values():
 raw,m=legacy_archive()
 def hot(sql,params):
  if "SELECT sql FROM sqlite_master" in sql:
   return [{'sql':'CREATE TABLE stock_prices(id INTEGER PRIMARY KEY,stock_id INTEGER,date TEXT,close REAL)'}]
  return []
 assert read(raw,m,hot)==[dict(stock_id=1,date='2025-01-01',close=101.),dict(stock_id=2,date='2025-01-01',close=102.)]


@pytest.mark.parametrize('ddl,error',[
 ('CREATE TABLE stock_prices(id INTEGER,stock_id INTEGER,date TEXT,close REAL,new_column TEXT DEFAULT "invented")','columns_mismatch'),
 ('CREATE TABLE stock_prices(id INTEGER,stock_id INTEGER,date TEXT,close TEXT)','readback_mismatch'),
 ('CREATE TABLE wrong(id INTEGER)','schema_invalid'),
 (None,'schema_missing'),
])
def test_legacy_schema_cannot_invent_columns_or_change_values(ddl,error):
 raw,m=legacy_archive()
 def hot(sql,params):
  return [{'sql':ddl}] if "SELECT sql FROM sqlite_master" in sql and ddl else []
 with pytest.raises(ValueError,match=error):read(raw,m,hot)


def test_legacy_hot_precedence_and_unrelated_dates_need_no_restore_ddl():
 raw,m=legacy_archive();m['release_verified_at']=None
 def hot(sql,params):
  assert 'JOIN json_each' in sql
  return [dict(stock_id=i,date='2025-01-01') for i in (1,2)]
 assert read(raw,m,hot)==[]
 assert list(archived_market_projection('stock_prices','SELECT * FROM stock_prices',[],
  '2026-01-01','2026-01-02',query_hot=lambda *a:pytest.fail('unrelated data queried'),
  query_ops=lambda *a:[m],download=lambda *a:raw))==[]
 with pytest.raises(RuntimeError,match='release_receipt'):read(raw,m)
