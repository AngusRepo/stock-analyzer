"""Explicit forward admission. Never relabel forward predictions as OOF."""
from collections import defaultdict
import hashlib,json
from services.l4_forward_materialization import digest,timestamp,TZ

def validate_forward_rows(rows,receipts,*,identity,as_of):
    groups=defaultdict(list)
    for row in rows:
        if row.get('prediction_kind')=='forward':groups[row['source']['snapshot_id']].append(row)
    supplied={r['snapshot_id']:r for r in receipts or []}
    if len(supplied)!=len(receipts or []):raise ValueError('l4_forward_duplicate_receipt')
    for snapshot_id,group in groups.items():
        receipt=supplied.get(snapshot_id)
        # Receipt covers exactly the full original pool. Partial-row selection
        # must happen after admission, otherwise relative targets silently drift.
        if (not receipt or receipt.get('training_eligible') is not True
                or receipt.get('prediction_kind')!='forward'
                or receipt.get('status')!='ready' or receipt.get('excluded')
                or receipt.get('pool_contract')!='native_non_etf_equity_v1'
                or receipt.get('l3_identity')!=identity
                or receipt.get('rows')!=len(group)
                or receipt.get('rows_checksum')!=digest(sorted(group,key=lambda r:r['symbol']))):
            raise ValueError('l4_forward_training_receipt_invalid')
        for row in group:
            source=row['source']
            if (row['date']!=receipt['signal_date'] or row['label_known_date']>=as_of
                    or source['original_sha256']!=receipt['source_sha256']
                    or source['frozen_at']!=receipt['captured_at']
                    or timestamp(source['frozen_at'])>=timestamp(source['entry_deadline'])
                    or row['l3_training_label_known_max']>=row['date']):
                raise ValueError('l4_forward_training_time_or_source_invalid')
    return set(groups)

def merge_materializations(native_rows,bodies,*,identity,feature_schema,as_of):
    """Resolve available verified bodies afresh each fit, with an exclusion ledger."""
    result=list(native_rows);keys={(r['date'],r['symbol']):r for r in result}
    if len(keys)!=len(result):raise ValueError('l4_forward_native_duplicate_rows')
    receipts=[];ledger=[];seen={}
    # A later daily refresh can mature a previously pending snapshot. Select by
    # observable cutoff, never by target values, filenames or model performance.
    for body in sorted(bodies,key=lambda b:timestamp(b['receipt']['cutoff']),reverse=True):
        rows=body['rows'];receipt=body['receipt'];snapshot=receipt['snapshot_id']
        entry=dict(snapshot_id=snapshot,date=receipt['signal_date']);ledger.append(entry)
        if timestamp(receipt['cutoff']).astimezone(TZ).date().isoformat()>as_of:
            entry.update(status='excluded',reason='receipt_after_fit_cutoff');continue
        if snapshot in seen:
            previous=seen[snapshot]
            if previous['cutoff']==receipt['cutoff'] and previous!=receipt:
                raise ValueError('l4_forward_conflicting_same_cutoff_receipts')
            if previous['source_sha256']!=receipt['source_sha256']:
                raise ValueError('l4_forward_changed_original_snapshot')
            entry['status']='duplicate_snapshot';continue
        seen[snapshot]=receipt
        if receipt.get('l3_identity')!=identity or receipt.get('feature_schema')!=feature_schema:
            entry.update(status='excluded',reason='incompatible_identity_or_features');continue
        if receipt.get('training_eligible') is not True:
            entry.update(status='excluded',reason=receipt.get('training_blocker') or receipt['status']);continue
        if receipt['label_known_date']>=as_of:
            entry.update(status='excluded',reason='immature_at_fit_cutoff');continue
        validate_forward_rows(rows,[receipt],identity=identity,as_of=as_of)
        for row in rows:
            key=(row['date'],row['symbol'])
            if key in keys:raise ValueError('l4_forward_native_or_snapshot_overlap')
            keys[key]=row
        result.extend(rows);receipts.append(receipt);entry.update(status='included',rows=len(rows))
    result.sort(key=lambda r:(r['date'],r['symbol']))
    return result,receipts,ledger

def load_current_registry(bucket,*,cutoff):
    """Read fresh content-addressed registry; newest failed refresh is not hidden."""
    from services.l4_forward_refresh import PREFIX
    candidates=[]
    for blob in bucket.list_blobs(prefix=PREFIX+'refreshes/'):
        if not blob.name.endswith('.json'):continue
        raw=blob.download_as_bytes(if_generation_match=blob.generation)
        if blob.name!=PREFIX+'refreshes/'+hashlib.sha256(raw).hexdigest()+'.json':
            raise ValueError('l4_forward_registry_checksum')
        value=json.loads(raw)
        if value.get('schema_version')!='l4-forward-refresh-v1':raise ValueError('l4_forward_registry_schema')
        if timestamp(value['cutoff'])<=timestamp(cutoff):candidates.append((timestamp(value['cutoff']),blob.name,value))
    if not candidates:return [],dict(status='no_daily_registry',latest_observed_signal_date=None,latest_training_eligible_date=None)
    _,name,latest=max(candidates,key=lambda r:(r[0],r[1]))
    if latest['status']=='failed':raise ValueError('l4_forward_latest_refresh_failed')
    bodies=[]
    for item in latest['items']:
        ref=item['materialization'];raw=bucket.blob(ref['path']).download_as_bytes()
        if (not ref['path'].startswith(PREFIX+'materializations/')
                or hashlib.sha256(raw).hexdigest()!=ref['sha256']):raise ValueError('l4_forward_materialization_checksum')
        body=json.loads(raw)
        if body['receipt']['snapshot_id']!=item['snapshot_id'] or body['receipt']['source_sha256']!=item['source_sha256']:
            raise ValueError('l4_forward_registry_receipt_mismatch')
        bodies.append(body)
    return bodies,dict(status='verified',registry_path=name,cutoff=latest['cutoff'],
        latest_observed_signal_date=latest['latest_observed_signal_date'],
        latest_training_eligible_date=latest['latest_training_eligible_date'])
