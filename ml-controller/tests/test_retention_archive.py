import hashlib,json,sqlite3
from pathlib import Path
import pytest
from services.retention_archive import SCHEMA,restore_archives,verify_archive

def archive(rows=None, **updates):
    rows=rows or [{"__cursor_key":1,"__archive_date":"2025-01-01","id":1,"date":"2025-01-01","value":1.25,"note":"台股原始資料"},
                  {"__cursor_key":2,"__archive_date":"2025-01-02","id":2,"date":"2025-01-02","value":None,"note":None}]
    payload={"schema_version":SCHEMA,"policy_id":"learning_lineage_v1","dataset_id":"samples","source_domain":"learning","cutoff_date":"2026-01-01","source_schema_sql":"CREATE TABLE samples(id INTEGER PRIMARY KEY,date TEXT,value REAL,note TEXT)","rows":rows,**updates}
    body={"schema_version":SCHEMA,"domain":"retention_learning_lineage_v1_samples","payload":payload}
    raw=json.dumps(body,ensure_ascii=False,separators=(',',':')).encode()
    manifest={"artifact_id":"test","checksum":"sha256:"+hashlib.sha256(raw).hexdigest(),"domain":body['domain'],"schema_version":SCHEMA,"row_count":len(rows)}
    return raw,manifest

def test_restore_exact_real_null_unicode_and_queries(tmp_path):
    raw,manifest=archive();result=restore_archives([(raw,manifest)],tmp_path/'restored.sqlite')
    assert result['status']=='verified' and result['tables']=={'samples':2}
    with sqlite3.connect(tmp_path/'restored.sqlite') as db:
        assert db.execute('SELECT SUM(value),COUNT(*) FROM samples').fetchone()==(1.25,2)
        assert db.execute('SELECT note FROM samples WHERE id=1').fetchone()[0]=='台股原始資料'

def test_corrupt_object_fails_and_rolls_back_all_chunks(tmp_path):
    raw,manifest=archive()
    with pytest.raises(ValueError,match='checksum'):
        restore_archives([(raw,manifest),(raw+b' ',manifest)],tmp_path/'failed.sqlite')
    with sqlite3.connect(tmp_path/'failed.sqlite') as db:
        assert db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]==0

def test_existing_output_never_overwritten(tmp_path):
    path=tmp_path/'existing';path.write_bytes(b'keep')
    with pytest.raises(FileExistsError):restore_archives([archive()],path)
    assert path.read_bytes()==b'keep'

@pytest.mark.parametrize('updates,message',[
    ({'source_schema_sql':''},'schema_missing'),
    ({'source_schema_sql':'CREATE TABLE another(id INTEGER)'},'schema_missing'),
    ({'dataset_id':'samples; DROP TABLE x'},'identifier'),
    ({'source_domain':'other'},'domain'),
    ({'cutoff_date':'2024-01-01'},'date'),
])
def test_archive_contract_failures(updates,message):
    with pytest.raises(ValueError,match=message):verify_archive(*archive(**updates))

def test_manifest_count_and_identity_checked():
    raw,manifest=archive()
    with pytest.raises(ValueError,match='row_count'):verify_archive(raw,{**manifest,'row_count':99})
    with pytest.raises(ValueError,match='manifest'):verify_archive(raw,{**manifest,'domain':'another'})

def test_multiple_chunks_and_no_partial_on_conflicting_primary_key(tmp_path):
    raw,manifest=archive()
    with pytest.raises(sqlite3.IntegrityError):restore_archives([(raw,manifest),(raw,manifest)],tmp_path/'duplicate.sqlite')
    with sqlite3.connect(tmp_path/'duplicate.sqlite') as db:
        assert db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]==0


def test_legacy_read_validation_does_not_weaken_exact_restore_contract(tmp_path):
 raw,m=archive(source_schema_sql='')
 assert len(verify_archive(raw,m,require_restore_schema=False)['rows'])==2
 with pytest.raises(ValueError,match='schema_missing'):restore_archives([(raw,m)],tmp_path/'legacy.sqlite')
 with pytest.raises(ValueError,match='checksum'):verify_archive(raw+b' ',m,require_restore_schema=False)
 raw,m=archive(source_schema_sql='CREATE TABLE wrong(id INTEGER)')
 with pytest.raises(ValueError,match='schema_missing'):verify_archive(raw,m,require_restore_schema=False)


class _Reply:
 def __init__(self,status,content=b''):self.status_code=status;self.content=content

@pytest.fixture(autouse=True)
def _fresh_retry_budget(monkeypatch):
 from services import retention_archive
 monkeypatch.setitem(retention_archive._job_retry_ledger,'seconds',0.0)
 monkeypatch.setattr(retention_archive,'_warned_budget_values',set())
 monkeypatch.delenv(retention_archive.DOWNLOAD_RETRY_BUDGET_ENV,raising=False)
 monkeypatch.delenv('CLOUD_RUN_JOB',raising=False)

def _download(replies,monkeypatch,manifest,calls,waits,attempt_seconds=0.0):
 from services.retention_archive import download_archive
 from services import worker_config_client
 monkeypatch.setenv(worker_config_client.WORKER_URL_ENV,'https://worker.invalid')
 clock=[1000.0]
 def post(url,**request):
  calls.append((url,request['json']))
  clock[0]+=attempt_seconds
  reply=replies[len(calls)-1]
  if isinstance(reply,Exception):raise reply
  return reply
 def sleep(seconds):
  waits.append(seconds);clock[0]+=seconds
 return download_archive(manifest,post=post,sleep=sleep,clock=lambda:clock[0])

def test_download_retries_transient_answers_with_backoff_and_verifies_each_body(monkeypatch):
 import httpx
 raw,manifest=archive();calls,waits=[],[]
 result=_download([_Reply(500),httpx.ConnectError('reset'),_Reply(429),_Reply(200,raw)],monkeypatch,manifest,calls,waits)
 assert result==raw and len(calls)==4 and waits==[2.0,4.0,8.0]
 assert all(call==('https://worker.invalid/api/internal/evidence-artifacts/retention/read',{'artifact_id':'test'}) for call in calls)

def test_download_gives_up_after_three_retries(monkeypatch):
 import httpx
 raw,manifest=archive()
 for replies,message in [([_Reply(503)]*5,'retention_archive_read_http_503'),
                         ([httpx.ReadTimeout('slow')]*5,'retention_archive_read_transport_ReadTimeout')]:
  calls,waits=[],[]
  with pytest.raises(RuntimeError,match=message):_download(replies,monkeypatch,manifest,calls,waits)
  assert len(calls)==4 and waits==[2.0,4.0,8.0]

@pytest.mark.parametrize('status',[404,409,413,400,401])
def test_download_never_retries_terminal_answers(status,monkeypatch):
 raw,manifest=archive();calls,waits=[],[]
 with pytest.raises(RuntimeError,match=f'retention_archive_read_http_{status}$'):
  _download([_Reply(status),_Reply(200,raw)],monkeypatch,manifest,calls,waits)
 assert len(calls)==1 and waits==[]

def test_download_verifies_the_body_of_the_retried_attempt(monkeypatch):
 raw,manifest=archive();calls,waits=[],[]
 # A retried 200 whose bytes do not match the manifest checksum fails closed and is not retried.
 with pytest.raises(ValueError,match='checksum'):
  _download([_Reply(502),_Reply(200,raw+b' '),_Reply(200,raw)],monkeypatch,manifest,calls,waits)
 assert len(calls)==2 and waits==[2.0]

def test_download_retry_budget_is_shared_across_archives_and_stops_retries(monkeypatch):
 import httpx
 from services import retention_archive
 monkeypatch.setenv('CLOUD_RUN_JOB','dataset-snapshot-export')
 monkeypatch.setenv(retention_archive.DOWNLOAD_RETRY_BUDGET_ENV,'130')
 raw,manifest=archive();calls,waits=[],[]
 # Every attempt burns a full 60 s timeout. Retry 1 (2+60) and retry 2 (4+60) fit 130 s;
 # retry 3 would need 126+8+60, so the third failure raises.
 with pytest.raises(RuntimeError,match='retention_archive_read_transport_ReadTimeout'):
  _download([httpx.ReadTimeout('slow')]*4,monkeypatch,manifest,calls,waits,attempt_seconds=60.0)
 assert len(calls)==3 and waits==[2.0,4.0]
 assert retention_archive._job_retry_ledger['seconds']==126.0
 # The next archive in the same process gets no retry at all, as before retries existed.
 calls,waits=[],[]
 with pytest.raises(RuntimeError,match='retention_archive_read_http_503'):
  _download([_Reply(503),_Reply(200,raw)],monkeypatch,manifest,calls,waits)
 assert len(calls)==1 and waits==[]

def test_download_retries_while_the_budget_still_covers_a_full_attempt(monkeypatch):
 from services import retention_archive
 monkeypatch.setenv('CLOUD_RUN_JOB','dataset-snapshot-export')
 raw,manifest=archive();calls,waits=[],[]
 # Default 300 s: 300-238 = 62 s left covers the 2 s wait plus one 60 s attempt.
 monkeypatch.setitem(retention_archive._job_retry_ledger,'seconds',238.0)
 assert _download([_Reply(502),_Reply(200,raw)],monkeypatch,manifest,calls,waits)==raw
 assert len(calls)==2 and waits==[2.0]
 calls,waits=[],[]
 # 0.5 s more spent and the same failure is final.
 monkeypatch.setitem(retention_archive._job_retry_ledger,'seconds',238.5)
 with pytest.raises(RuntimeError,match='retention_archive_read_http_502'):
  _download([_Reply(502),_Reply(200,raw)],monkeypatch,manifest,calls,waits)
 assert len(calls)==1 and waits==[]

def test_service_calls_outside_a_job_each_get_a_full_retry_budget(monkeypatch):
 import httpx
 from services import retention_archive
 monkeypatch.setenv(retention_archive.DOWNLOAD_RETRY_BUDGET_ENV,'130')
 raw,manifest=archive()
 for _ in range(2):
  calls,waits=[],[]
  # The controller service (no CLOUD_RUN_JOB) never carries spent budget into the next call.
  with pytest.raises(RuntimeError,match='retention_archive_read_transport_ReadTimeout'):
   _download([httpx.ReadTimeout('slow')]*4,monkeypatch,manifest,calls,waits,attempt_seconds=60.0)
  assert len(calls)==3 and waits==[2.0,4.0]
 assert retention_archive._job_retry_ledger['seconds']==0.0

@pytest.mark.parametrize('value,retries,warns',[('0',0,False),('not-a-number',3,True),('-5',3,True),
                                               ('inf',3,True),('nan',3,True),('',3,False),('45.5',0,False)])
def test_download_retry_budget_env_override(value,retries,warns,monkeypatch,caplog):
 import logging
 from services import retention_archive
 monkeypatch.setenv(retention_archive.DOWNLOAD_RETRY_BUDGET_ENV,value)
 raw,manifest=archive()
 with caplog.at_level(logging.WARNING,logger='services.retention_archive'):
  for _ in range(2):
   calls,waits=[],[]
   with pytest.raises(RuntimeError,match='retention_archive_read_http_500'):
    _download([_Reply(500)]*4,monkeypatch,manifest,calls,waits)
   assert len(calls)==retries+1 and waits==[2.0,4.0,8.0][:retries]
 invalid=[r for r in caplog.records if 'is not a finite non-negative number' in r.getMessage()]
 assert len(invalid)==(1 if warns else 0), 'an invalid override warns once, not on every retry'
