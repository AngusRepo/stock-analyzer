"""Pure storage OOF backup. No eligibility, cohort, model, or hot-row mutation.

The caller records the returned receipt using its retention-run owner. A backup
alone does not authorize hot deletion or count as an operational cold reader.
"""
from datetime import date, datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import tempfile

TABLES = {'active8_oof_predictions':'prediction_date',
          'allocator_ev_oof_snapshots':'snapshot_date', 'l4_oof_predictions':'prediction_date'}
PREFIX = 'oof-storage-cold/v1/'
SCHEMA = 'oof-storage-chunk-v1'
MAX_BYTES = 1024 * 1024


def _identifier(name):
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',name):
        raise ValueError('oof_storage_identifier_invalid')
    return '"'+name+'"'


class HeldOofObjects:
    def __init__(self,bucket):self.bucket=bucket

    def put(self,path,checksum):
        from google.api_core.exceptions import PreconditionFailed
        key=PREFIX+checksum+'.json.gz'
        blob=self.bucket.blob(key,chunk_size=8*1024*1024)
        try:blob.upload_from_filename(str(path),content_type='application/gzip',if_generation_match=0)
        except PreconditionFailed:pass
        blob.reload()
        if blob.temporary_hold is not True:
            generation,metageneration=blob.generation,blob.metageneration
            blob.temporary_hold=True
            blob.patch(if_generation_match=generation,if_metageneration_match=metageneration)
            blob.reload()
        if blob.temporary_hold is not True:raise RuntimeError('oof_storage_hold_missing')
        return key

    def download(self,key,path):
        if not re.fullmatch(re.escape(PREFIX)+r'[0-9a-f]{64}\.json\.gz',key):
            raise ValueError('oof_storage_key_invalid')
        self.bucket.blob(key,chunk_size=8*1024*1024).download_to_filename(str(path))


def read_verified_chunk(store,receipt):
    if (receipt.get('schema_version')!=SCHEMA or receipt.get('dataset_id') not in TABLES
            or type(receipt.get('payload_bytes')) is not int or not 0<receipt['payload_bytes']<=MAX_BYTES+65536
            or type(receipt.get('row_count')) is not int or not 0<receipt['row_count']<=250
            or not re.fullmatch('[0-9a-f]{64}',str(receipt.get('checksum','')))):
        raise ValueError('oof_storage_receipt_invalid')
    with tempfile.TemporaryDirectory(prefix='oof-storage-read-') as directory:
        path=Path(directory)/'chunk.gz';store.download(receipt['object_key'],path)
        with gzip.open(path,'rb') as stream:
            raw=stream.read(int(receipt['payload_bytes'])+1)
        if len(raw)!=receipt['payload_bytes'] or hashlib.sha256(raw).hexdigest()!=receipt['checksum']:
            raise RuntimeError('oof_storage_checksum_mismatch')
        payload=json.loads(raw)
    expected={k:receipt[k] for k in ('schema_version','dataset_id','cohort_id','cutoff_date')}
    if any(payload.get(k)!=v for k,v in expected.items()) or len(payload.get('rows',[]))!=receipt['row_count']:
        raise RuntimeError('oof_storage_identity_mismatch')
    return payload


def archive_storage_chunk(*,query,store,table,cohort_id,cutoff_date,after_rowid=0,limit=250,now=None):
    """Bound the SELECT before transfer, retain original values, verify both ends.

    Only SELECT calls are accepted by the query dependency. The storage owner
    must obtain any required payload-transfer approval before supplying store.
    """
    if table not in TABLES or not cohort_id or type(after_rowid) is not int or after_rowid<0:
        raise ValueError('oof_storage_request_invalid')
    date.fromisoformat(cutoff_date)
    stamp=now or datetime.now(timezone.utc)
    if stamp.tzinfo is None:raise ValueError('oof_storage_timezone_required')
    limit=max(1,min(int(limit),250));day=TABLES[table]
    ddl=query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[table])
    if len(ddl)!=1 or not ddl[0].get('sql'):raise ValueError('oof_storage_schema_missing')
    columns=query('SELECT name FROM pragma_table_info(?)',[table])
    names=[_identifier(r['name']) for r in columns]
    if not names:raise ValueError('oof_storage_columns_missing')
    cost='+'.join(f'(length(CAST(json_quote({name}) AS BLOB))+{len(name.encode())+4})' for name in names)
    sql=f'''WITH candidates AS MATERIALIZED (
      SELECT rowid row_key,({cost})+256 row_bytes FROM {table}
      WHERE cohort_id=? AND {day}<? AND rowid>? ORDER BY rowid LIMIT ?
    ), budgeted AS MATERIALIZED (
      SELECT *,SUM(row_bytes) OVER (ORDER BY row_key) total_bytes FROM candidates
    ) SELECT p.rowid __archive_rowid,p.* FROM {table} p JOIN budgeted b ON b.row_key=p.rowid
      WHERE b.total_bytes<=? ORDER BY p.rowid'''
    rows=query(sql,[cohort_id,cutoff_date,after_rowid,limit,MAX_BYTES])
    if not rows:
        pending=query(f'SELECT 1 pending FROM {table} WHERE cohort_id=? AND {day}<? AND rowid>? LIMIT 1',
                      [cohort_id,cutoff_date,after_rowid])
        if pending:raise RuntimeError('oof_storage_row_requires_large_object_path')
        return {'status':'no_eligible_rows','dataset_id':table,'cohort_id':cohort_id,
                'cutoff_date':cutoff_date,'next_rowid':after_rowid,'row_count':0,'deleted_rows':0,
                'eligibility_changed':False,'backlog_remaining':False}
    payload={'schema_version':SCHEMA,'dataset_id':table,'cohort_id':cohort_id,
             'cutoff_date':cutoff_date,'source_schema_sql':ddl[0]['sql'],'rows':rows}
    raw=json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    if len(raw)>MAX_BYTES+65536:raise RuntimeError('oof_storage_envelope_too_large')
    checksum=hashlib.sha256(raw).hexdigest()
    with tempfile.TemporaryDirectory(prefix='oof-storage-write-') as directory:
        path=Path(directory)/'chunk.gz'
        with path.open('wb') as target:
            with gzip.GzipFile(fileobj=target,mode='wb',mtime=0) as zipped:zipped.write(raw)
        key=store.put(path,checksum)
    receipt={k:payload[k] for k in ('schema_version','dataset_id','cohort_id','cutoff_date')}
    receipt.update(object_key=key,checksum=checksum,payload_bytes=len(raw),row_count=len(rows),
                   next_rowid=rows[-1]['__archive_rowid'],verified_at=stamp.isoformat(),
                   retain_until=(stamp+timedelta(days=3650)).isoformat(),deleted_rows=0,eligibility_changed=False)
    if read_verified_chunk(store,receipt)!=payload:raise RuntimeError('oof_storage_readback_mismatch')
    keys=json.dumps([row['__archive_rowid'] for row in rows])
    fresh=query(f'SELECT rowid __archive_rowid,* FROM {table} WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY rowid',[keys])
    if fresh!=rows:raise RuntimeError('oof_storage_source_changed')
    receipt['backlog_remaining']=bool(query(f'SELECT 1 pending FROM {table} WHERE cohort_id=? AND {day}<? AND rowid>? LIMIT 1',
                                          [cohort_id,cutoff_date,receipt['next_rowid']]))
    return {'status':'verified',**receipt}


def archive_storage_step(*, query, ops, store, table, cohort_id, cutoff_date,
                         after_rowid=0, limit=250, now=None):
    """Persist a resumable backup; never delete hot rows or change eligibility."""
    policy = 'oof_lineage_cold_archive_v2'
    policies = ops.query('SELECT archive_store,cold_retention_days,status FROM data_retention_policies WHERE policy_id=?', [policy])
    if (len(policies) != 1 or policies[0]['archive_store'] != 'gcs'
            or policies[0]['status'] != 'active' or policies[0]['cold_retention_days'] < 3650):
        raise RuntimeError('oof_storage_policy_not_ready')
    receipt = archive_storage_chunk(query=query, store=store, table=table,
        cohort_id=cohort_id, cutoff_date=cutoff_date, after_rowid=after_rowid, limit=limit, now=now)
    stamp = now or datetime.now(timezone.utc)
    identity = receipt.get('checksum') or hashlib.sha256(json.dumps(
        [table, cohort_id, cutoff_date, after_rowid, stamp.date().isoformat()]).encode()).hexdigest()
    run_id = 'oof-storage-backup:' + identity
    count = receipt['row_count']
    receipt.update(start_after_rowid=after_rowid, run_id=run_id, storage_only=True)
    encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    # Both records commit together. Content-addressed identity survives a lost ACK.
    statements = [
        ("""INSERT INTO data_retention_runs(run_id,policy_id,business_date,status,scanned_rows,
              archived_rows,deleted_rows,archived_bytes,completed_at)
            VALUES(?,?,?,'success',?,?,0,?,CURRENT_TIMESTAMP) ON CONFLICT(run_id) DO NOTHING""",
         [run_id, policy, stamp.date().isoformat(), count, count, receipt.get('payload_bytes', 0)]),
        ("""INSERT INTO data_retention_run_items(run_id,dataset_id,status,scanned_rows,archived_rows,
              deleted_rows,archived_bytes,cursor_date,cursor_key,backlog_remaining,evidence_json)
            VALUES(?,?,'success',?,?,0,?,?,?,?,?) ON CONFLICT(run_id,dataset_id) DO NOTHING""",
         [run_id, table, count, count, receipt.get('payload_bytes', 0), cutoff_date,
          str(receipt['next_rowid']), int(receipt['backlog_remaining']), encoded]),
    ]
    ops.atomic_batch_execute(statements)
    rows = ops.query('SELECT evidence_json FROM data_retention_run_items WHERE run_id=? AND dataset_id=?', [run_id, table])
    if len(rows) != 1:
        raise RuntimeError('oof_storage_receipt_readback_missing')
    recorded = json.loads(rows[0]['evidence_json'])
    # Retry timestamps may differ; immutable storage identity may not.
    fields = ('schema_version', 'dataset_id', 'cohort_id', 'cutoff_date', 'checksum',
              'object_key', 'payload_bytes', 'row_count', 'next_rowid', 'deleted_rows', 'eligibility_changed')
    if any(recorded.get(k) != receipt.get(k) for k in fields):
        raise RuntimeError('oof_storage_receipt_conflict')
    return {**recorded, 'backlog_remaining': receipt['backlog_remaining'], 'receipt_persisted': True}
