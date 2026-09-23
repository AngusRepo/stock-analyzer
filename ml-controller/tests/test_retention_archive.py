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
