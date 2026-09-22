"""Held forensic backups of interrupted NAV writes; never grant NAV evidence credit."""
from datetime import datetime,timedelta,timezone
import gzip,json,re
import ijson
from services.paired_nav_cold import packed,verified_file,production_store
from services.paired_nav_journal import _write
TABLE='paired_nav_orphan_archives_v1'
SCHEMA='paired-nav-unsealed-fragments-v1'

def _parts(query,snapshot_id):
    last=-1
    while True:
        rows=query('SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? AND part_no>? ORDER BY part_no LIMIT 50',[snapshot_id,last])
        if not rows:return
        for row in rows:
            if row['part_no'] != last+1:raise ValueError('nav_orphan_noncontiguous')
            last=row['part_no'];yield row

def _inventory(query,sid):
    if query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',[sid]):
        raise ValueError('nav_orphan_has_complete_manifest')
    return query('SELECT COUNT(*) n,MIN(part_no) first_part,MAX(part_no) last_part FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=?',[sid])[0]

def archive_orphan(*,query,writer,snapshot_id,expected_count,approval_id,store=None,now=None):
    if not re.fullmatch('[0-9a-f]{64}',snapshot_id) or not approval_id.strip() or expected_count<1:
        raise ValueError('nav_orphan_exact_approval_required')
    store=store or production_store()
    if store is None:raise ValueError('nav_orphan_store_missing')
    existing=query(f'SELECT * FROM {TABLE} WHERE snapshot_id=?',[snapshot_id])
    if existing:
        row=existing[0]
        if row['fragment_count']!=expected_count or row['approval_id']!=approval_id:
            raise ValueError('nav_orphan_retry_identity_mismatch')
        with verified_file(store,row['object_key'],row['fragment_checksum'],row['object_bytes']):pass
        return row
    before=_inventory(query,snapshot_id)
    if before != {'n':expected_count,'first_part':0,'last_part':expected_count-1}:
        raise ValueError('nav_orphan_expected_inventory_mismatch')
    def pieces():
        yield '{"schema_version":'+json.dumps(SCHEMA)+',"snapshot_id":'+json.dumps(snapshot_id)+',"parts":['
        count=0
        for row in _parts(query,snapshot_id):
            if count:yield ','
            yield json.dumps(row,ensure_ascii=False,separators=(',',':'),allow_nan=False)
            count+=1
        if count!=expected_count:raise ValueError('nav_orphan_source_changed')
        yield ']}'
    with packed(pieces()) as bundle:
        path,checksum,size,_=bundle
        key=store.put(path,checksum)
        with verified_file(store,key,checksum,size) as readback:
            with gzip.open(readback,'rb') as stream:
                count=0
                for fragment in ijson.items(stream,'parts.item'):
                    if fragment['part_no']!=count:raise ValueError('nav_orphan_readback_sequence_mismatch')
                    count+=1
                if count!=expected_count:raise ValueError('nav_orphan_readback_count_mismatch')
    if _inventory(query,snapshot_id)!=before:raise ValueError('nav_orphan_source_changed')
    stamp=now or datetime.now(timezone.utc)
    row={'snapshot_id':snapshot_id,'fragment_checksum':checksum,'object_key':key,'object_bytes':size,
         'fragment_count':expected_count,'verified_at':stamp.isoformat(),'retain_until':(stamp+timedelta(days=3650)).isoformat(),'approval_id':approval_id}
    # The database guard atomically checks count/manifest and fences ALL retries.
    _write(writer, [(f'INSERT INTO {TABLE} ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',list(row.values()))])
    if query(f'SELECT * FROM {TABLE} WHERE snapshot_id=?',[snapshot_id]) != [row]:
        raise RuntimeError('nav_orphan_receipt_readback_mismatch')
    return row

def release_orphan(*,query,writer,snapshot_id,expected_checksum,approval_id,store=None):
    rows=query(f'SELECT * FROM {TABLE} WHERE snapshot_id=?',[snapshot_id])
    if len(rows)!=1 or rows[0]['fragment_checksum']!=expected_checksum or rows[0]['approval_id']!=approval_id:
        raise ValueError('nav_orphan_release_identity_mismatch')
    row=rows[0];store=store or production_store()
    if store is None:raise ValueError('nav_orphan_store_missing')
    _inventory(query,snapshot_id)
    with verified_file(store,row['object_key'],expected_checksum,row['object_bytes']):pass
    before=query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=?',[snapshot_id])[0]['n']
    for first in range(0,row['fragment_count'],250):
        _write(writer, [('DELETE FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? AND part_no>=? AND part_no<?',
                 [snapshot_id,first,min(first+250,row['fragment_count'])])])
        if query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? AND part_no>=? AND part_no<?',[snapshot_id,first,first+250])[0]['n']:
            raise RuntimeError('nav_orphan_release_readback_mismatch')
    return {'snapshot_id':snapshot_id,'forensic_checksum':expected_checksum,'removed_parts':before,
            'status':'forensic_cold_only','complete_nav_snapshot':False,'nav_maturity_credit':0}
