import gzip,json,sqlite3
from datetime import datetime,timezone
from pathlib import Path
import pytest
from services.oof_storage_archive import archive_storage_chunk,read_verified_chunk,MAX_BYTES

class Store:
 def __init__(self,callback=lambda:None):self.objects={};self.callback=callback;self.corrupt=False
 def put(self,path,checksum):
  key='oof-storage-cold/v1/'+checksum+'.json.gz'
  self.objects[key]=Path(path).read_bytes();self.callback();return key
 def download(self,key,path):
  Path(path).write_bytes(gzip.compress(b'corrupt') if self.corrupt else self.objects[key])

def fixture():
 db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
 db.executescript('CREATE TABLE active8_oof_predictions(id INTEGER PRIMARY KEY,cohort_id TEXT,prediction_date TEXT,prediction REAL,detail TEXT); CREATE TABLE active8_oof_date_eligibility(date TEXT,status TEXT);')
 db.execute("INSERT INTO active8_oof_date_eligibility VALUES('2020-01-01','legal')")
 for i in range(1,4):db.execute('INSERT INTO active8_oof_predictions VALUES(?,?,?,?,?)',(i,'cohort','2020-01-01',.1*i,None))
 calls=[]
 def query(sql,params):
  assert sql.lstrip().upper().startswith(('SELECT ','WITH ')),sql
  calls.append(sql);return [dict(r) for r in db.execute(sql,params)]
 return db,query,calls

def run(query,store,**kwargs):
 return archive_storage_chunk(query=query,store=store,table='active8_oof_predictions',cohort_id='cohort',cutoff_date='2021-01-01',now=datetime(2026,9,22,tzinfo=timezone.utc),**kwargs)

def test_pure_storage_preserves_all_rows_and_eligibility_and_retries_same_object():
 db,q,calls=fixture();store=Store()
 try:
  first=run(q,store,limit=2)
  assert first['row_count']==2 and first['backlog_remaining']
  assert first['deleted_rows']==0 and first['eligibility_changed'] is False
  assert run(q,store,limit=2)==first and len(store.objects)==1
  second=run(q,store,limit=2,after_rowid=first['next_rowid'])
  assert second['row_count']==1 and not second['backlog_remaining']
  assert read_verified_chunk(store,first)['rows']==q('SELECT rowid __archive_rowid,* FROM active8_oof_predictions WHERE id<=? ORDER BY id',[2])
  assert db.execute('SELECT COUNT(*) FROM active8_oof_predictions').fetchone()[0]==3
  assert db.execute('SELECT status FROM active8_oof_date_eligibility').fetchone()[0]=='legal'
 finally:db.close()

@pytest.mark.parametrize('mode',['changed','corrupt'])
def test_mutated_source_and_corrupt_backup_never_publish_verified_receipt(mode):
 db,q,_=fixture()
 store=Store(lambda:db.execute('UPDATE active8_oof_predictions SET prediction=9 WHERE id=1') if mode=='changed' else None)
 store.corrupt=mode=='corrupt'
 try:
  with pytest.raises(RuntimeError,match='source_changed|checksum_mismatch'):run(q,store)
  assert db.execute('SELECT COUNT(*) FROM active8_oof_predictions').fetchone()[0]==3
  assert db.execute('SELECT status FROM active8_oof_date_eligibility').fetchone()[0]=='legal'
 finally:db.close()

def test_large_rows_are_bounded_before_transport_and_oversize_rows_remain_visible():
 db,q,_=fixture();sizes=[]
 try:
  db.execute('UPDATE active8_oof_predictions SET detail=?',('x'*600000,))
  def bounded(sql,params):
   rows=q(sql,params)
   if 'budgeted' in sql:sizes.append(len(json.dumps(rows).encode()))
   return rows
  receipt=run(bounded,Store())
  assert receipt['row_count']==1 and receipt['backlog_remaining'] and max(sizes)<MAX_BYTES
  db.execute('UPDATE active8_oof_predictions SET detail=?',('x'*(MAX_BYTES+1),))
  with pytest.raises(RuntimeError,match='large_object_path'):run(q,Store())
 finally:db.close()

def test_no_old_rows_is_read_only_and_does_not_upload():
 db,q,_=fixture();store=Store()
 try:
  db.execute("UPDATE active8_oof_predictions SET prediction_date='2026-09-21'")
  assert run(q,store)['status']=='no_eligible_rows'
  assert not store.objects
 finally:db.close()


class OpsLedger:
 def __init__(self):
  import re
  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
  self.db.execute('PRAGMA foreign_keys=ON')
  schema=(Path(__file__).resolve().parents[2]/'worker/domain-migrations/ops/0001_ops_baseline.sql').read_text(encoding='utf-8')
  for table in ('data_retention_policies','data_retention_runs','data_retention_run_items'):
   self.db.executescript(re.search(r'CREATE TABLE IF NOT EXISTS '+table+r' \([\s\S]*?\n\);',schema).group())
  self.db.execute("""INSERT INTO data_retention_policies(policy_id,domain,dataset_pattern,hot_retention_days,
    cold_retention_days,archive_store,action,hard_reference_protected,version,status,approved_reason)
    VALUES('oof_lineage_cold_archive_v2','learning','oof',730,3650,'gcs','archive_delete',1,1,'active','test')""")
  self.db.commit();self.lose_ack=False
 def query(self,sql,params):return [dict(r) for r in self.db.execute(sql,params)]
 def atomic_batch_execute(self,statements):
  with self.db:
   for sql,params in statements:self.db.execute(sql,params)
  if self.lose_ack:
   self.lose_ack=False;raise TimeoutError('lost acknowledgement')


def test_storage_owner_lost_ack_retry_preserves_receipt_and_eligibility():
 from services.oof_storage_archive import archive_storage_step
 db,q,_=fixture();ops=OpsLedger();store=Store()
 try:
  kwargs=dict(query=q,ops=ops,store=store,table='active8_oof_predictions',cohort_id='cohort',cutoff_date='2021-01-01',limit=2)
  ops.lose_ack=True
  with pytest.raises(TimeoutError):archive_storage_step(**kwargs)
  first=archive_storage_step(**kwargs)
  assert first['receipt_persisted'] and first['storage_only'] and first['next_rowid']==2
  assert ops.query('SELECT COUNT(*) n,SUM(archived_rows) rows FROM data_retention_runs',[])==[{'n':1,'rows':2}]
  second=archive_storage_step(**kwargs,after_rowid=2)
  assert second['row_count']==1 and not second['backlog_remaining']
  assert ops.query('SELECT SUM(deleted_rows) n FROM data_retention_runs',[])==[{'n':0}]
  assert db.execute('SELECT COUNT(*) FROM active8_oof_predictions').fetchone()[0]==3
  assert db.execute('SELECT status FROM active8_oof_date_eligibility').fetchone()[0]=='legal'
 finally:db.close();ops.db.close()


def test_storage_owner_bad_policy_does_not_upload_and_failed_readback_does_not_advance():
 from services.oof_storage_archive import archive_storage_step
 db,q,_=fixture();ops=OpsLedger();store=Store()
 try:
  kwargs=dict(query=q,ops=ops,store=store,table='active8_oof_predictions',cohort_id='cohort',cutoff_date='2021-01-01')
  ops.db.execute('UPDATE data_retention_policies SET cold_retention_days=30')
  with pytest.raises(RuntimeError,match='policy_not_ready'):archive_storage_step(**kwargs)
  assert not store.objects
  ops.db.execute('UPDATE data_retention_policies SET cold_retention_days=3650');ops.db.commit()
  original=ops.query
  ops.query=lambda sql,params: [] if 'SELECT evidence_json' in sql else original(sql,params)
  with pytest.raises(RuntimeError,match='readback_missing'):archive_storage_step(**kwargs)
 finally:db.close();ops.db.close()


def test_storage_route_dry_run_has_no_storage_or_write_side_effect(monkeypatch):
 from routers import walk_forward
 from services import walk_forward_retrain
 db,q,_=fixture()
 class ReadOnly:
  query=staticmethod(q)
 def forbidden():raise AssertionError('dry run opened cloud storage')
 try:
  monkeypatch.setattr(walk_forward,'LEARNING_D1_CLIENT',ReadOnly())
  monkeypatch.setattr(walk_forward_retrain,'_get_bucket',forbidden)
  req=walk_forward.OofStorageArchiveRequest(table='active8_oof_predictions',cohort_id='cohort',cutoff_date='2021-01-01')
  result=walk_forward.archive_walk_forward_oof_storage(req)
  assert result=={'status':'dry_run','candidates':3,'deleted_rows':0,'eligibility_changed':False,'storage_only':True}
 finally:db.close()
