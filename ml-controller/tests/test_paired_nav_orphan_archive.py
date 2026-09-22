import gzip,json,sqlite3
from pathlib import Path
import pytest
from services.paired_nav_orphan_archive import archive_orphan,release_orphan
from services.paired_nav_journal import read_snapshot
from test_paired_nav_journal import DB,NOW
from test_paired_nav_cold import Objects
SID='a'*64
@pytest.fixture
def env():
 db=DB();root=Path(__file__).parents[2]/'worker/domain-migrations/learning'
 for name in ['0048_paired_nav_cold_storage.sql','0049_paired_nav_orphan_archive.sql']:
  db.conn.executescript((root/name).read_text(encoding='utf-8'))
 parts=[{'part_no':i,'payload_text':f'未完成原文 {i} [{{'} for i in range(503)]
 db.writer([('INSERT INTO paired_nav_frozen_parts_v1 VALUES(?,?,?)',[SID,r['part_no'],r['payload_text']]) for r in parts])
 return db,Objects(),parts

def save(env,**kwargs):
 db,objects,_=env
 return archive_orphan(query=db.query,writer=db.writer,snapshot_id=SID,expected_count=503,approval_id='fixture-approved',store=objects,now=NOW,**kwargs)

def release(env,row,writer=None):
 db,objects,_=env
 return release_orphan(query=db.query,writer=writer or db.writer,snapshot_id=SID,expected_checksum=row['fragment_checksum'],approval_id='fixture-approved',store=objects)

def test_exact_fragments_roundtrip_never_fabricates_snapshot(env):
 db,objects,parts=env;row=save(env)
 content=json.loads(gzip.decompress(objects.data[row['object_key']]))
 assert content['schema_version']=='paired-nav-unsealed-fragments-v1' and content['parts']==parts
 assert save(env)==row
 assert not db.query('SELECT * FROM paired_nav_frozen_manifests_v1',[])
 with pytest.raises(Exception):read_snapshot(db.query,SID)
 result=release(env,row)
 assert result['removed_parts']==503 and result['nav_maturity_credit']==0
 assert not db.query('SELECT * FROM paired_nav_frozen_parts_v1',[])
 assert release(env,row)['removed_parts']==0

def test_late_part_and_manifest_writers_are_fenced(env):
 db,_,_=env;save(env)
 with pytest.raises(sqlite3.IntegrityError,match='retired'):
  db.writer([('INSERT INTO paired_nav_frozen_parts_v1 VALUES(?,?,?)',[SID,503,'late'])])
 with pytest.raises(sqlite3.IntegrityError,match='cannot_become_snapshot'):
  db.conn.execute("INSERT INTO paired_nav_frozen_manifests_v1(snapshot_id,signal_date,source_run_id,snapshot_kind,payload_checksum,part_count,frozen_at,prospective) VALUES(?,?,?,?,?,?,?,?)",[SID,'2026-09-21','late','allocation_context','b'*64,503,NOW.isoformat(),0])

def test_corrupt_readback_does_not_fence_or_delete(env):
 db,objects,_=env;objects.broken=True
 with pytest.raises(gzip.BadGzipFile):save(env)
 assert not db.query('SELECT * FROM paired_nav_orphan_archives_v1',[])
 assert db.query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1',[])[0]['n']==503

def test_append_during_upload_rejects_receipt(env):
 db,objects,_=env;put=objects.put
 def race(path,checksum):
  result=put(path,checksum)
  db.writer([('INSERT INTO paired_nav_frozen_parts_v1 VALUES(?,?,?)',[SID,503,'late'])]);return result
 objects.put=race
 with pytest.raises(ValueError,match='source_changed'):save(env)
 assert not db.query('SELECT * FROM paired_nav_orphan_archives_v1',[])
 assert db.query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1',[])[0]['n']==504

def test_release_lost_response_resumes_without_duplicate_or_missing_archive(env):
 db,_,_=env;row=save(env);calls=[]
 def lost(statements):
  db.writer(statements);calls.extend(statements);raise TimeoutError('response lost')
 with pytest.raises(TimeoutError):release(env,row,writer=lost)
 assert db.query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1',[])[0]['n']==253
 assert release(env,row)['removed_parts']==253
 assert len(calls)==1

def test_missing_archive_on_release_preserves_every_hot_fragment(env):
 db,objects,_=env;row=save(env);objects.data.clear()
 with pytest.raises(KeyError):release(env,row)
 assert db.query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1',[])[0]['n']==503

def test_wrong_approval_does_not_reuse_or_delete(env):
 db,objects,_=env;row=save(env)
 with pytest.raises(ValueError,match='identity'):
  release_orphan(query=db.query,writer=db.writer,snapshot_id=SID,expected_checksum=row['fragment_checksum'],approval_id='other',store=objects)
 assert db.query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1',[])[0]['n']==503
