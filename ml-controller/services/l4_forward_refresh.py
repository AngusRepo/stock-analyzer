"""Daily forward-label registry, separate from fitting and account execution.

The caller supplies the current producer's verified price-capture reference.
Never choose a fixed training parquet, manufacture OOF lineage, or infer full
native-pool coverage from a smaller routed prediction set.
"""
from datetime import datetime,timedelta
import hashlib,io,json,os,re
import polars as pl
from services.l4_forward_materialization import digest,materialize,timestamp

PREFIX='l4_distribution/forward_data/v1/'
_SECRET_ENV=re.compile(r'TOKEN|SECRET|PASSWORD|KEY|PRIVATE|CREDENTIAL|AUTH|WEBHOOK')
_SECRET_KEY=r'(?i)\b((?:access_)?token|secret|password|api[_-]?key|signature|sig|key|x-goog-[a-z-]+)'
_SECRET_TEXT=(
    (re.compile(r'(?i)\b(authorization[\'"]?\s*[=:]\s*[\'"]?)(?:[A-Za-z-]+\s+)?[^\s\'",}]+'),r'\1***'),
    (re.compile(r'(?i)(bearer\s+)\S+'),r'\1***'),
    (re.compile(_SECRET_KEY+r'([\'"]?\s*[=:]\s*)([\'"])(?:(?!\3).)*\3'),r'\1\2\3***\3'),
    (re.compile(_SECRET_KEY+r'([\'"]?\s*[=:]\s*)[^&\s\'",}]+'),r'\1\2***'),
    (re.compile(r'(https?://[^\s?\'"]+)\?[^\s\'"]*'),r'\1?***'),
    # Opaque credentials mix upper case and digits; snake_case codes and hex digests stay readable.
    (re.compile(r'(?=[A-Za-z0-9+/_.=-]*[A-Z])(?=[A-Za-z0-9+/_.=-]*\d)[A-Za-z0-9+/_.=-]{32,}'),'***'))


def error_summary(exc,limit=300):
    """FU4: bounded, secret-redacted exception text for callbacks and logs."""
    text=' '.join(str(exc)[:4096].split())  # bound regex work; only `limit` chars survive anyway
    for name,value in os.environ.items():
        value=value.strip()
        if len(value)>=8 and _SECRET_ENV.search(name):text=text.replace(value,'***')
    for pattern,replacement in _SECRET_TEXT:text=pattern.sub(replacement,text)
    return text[:limit]

NATIVE_POOL='native_non_etf_equity_v1'
ROUTED_POOL='routed_available_l3_v1'

def publish(bucket,kind,value):
    raw=json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    checksum=hashlib.sha256(raw).hexdigest();key=f'{PREFIX}{kind}/{checksum}.json'
    blob=bucket.blob(key)
    from google.api_core.exceptions import PreconditionFailed
    try:blob.upload_from_string(raw,content_type='application/json',if_generation_match=0)
    except PreconditionFailed:pass
    if hashlib.sha256(blob.download_as_bytes()).hexdigest()!=checksum:raise ValueError('l4_forward_readback_mismatch')
    return dict(path=key,sha256=checksum)

def project(frozen):
    """Input exclusively from paired_nav_journal's byte-verifying reader."""
    from services.l4_distribution import feature_schema,feature_order
    from services.l4_distribution_runtime import native_features,missing_l3_evidence
    from services.l4_l3_baseline import native_baseline
    from services.recommendation_service import calculate_ml_score,_rescale_score
    manifest=frozen['manifest'];content=frozen['payload']['content']
    if manifest['snapshot_kind']!='allocation_context':raise ValueError('l4_forward_snapshot_kind')
    policy=content['inputs']['alpha_policy']['l4Distribution'];runtime=policy['runtime']
    identity=runtime['l3_identity'];predictions=content.get('model_predictions') or runtime['predictions']
    rows=[];excluded=[]
    for symbol,prediction in sorted(predictions.items()):
        reasons=missing_l3_evidence(prediction,identity,manifest['signal_date'])
        if reasons:
            excluded.append(dict(symbol=symbol,reason='attested_l3_missing',details=reasons));continue
        edge=_rescale_score(calculate_ml_score(prediction['ensemble_v2'],prediction),30,25)
        row=dict(symbol=symbol,score_components={'components':{'mlEdge':edge}})
        rows.append(dict(symbol=symbol,features=native_features(row,prediction,identity),
            l3_baseline=native_baseline(prediction,identity)))
    if not rows:raise ValueError('l4_forward_empty_projection')
    # A future full-pool producer must seal this declaration in the original
    # pre-entry snapshot. Existing routed snapshots are never upgraded in place.
    declaration=content.get('l4_native_pool_contract')
    pool=ROUTED_POOL
    if declaration is not None:
        expected=sorted(declaration.get('eligible_symbols') or [])
        if (declaration.get('schema_version')!='l4-native-pool-contract-v1'
                or declaration.get('pool')!=NATIVE_POOL or not declaration.get('classification_sha256')
                or declaration.get('symbol_checksum')!=digest(expected)
                or expected!=sorted(predictions) or excluded
                or not declaration.get('l3_training_label_known_max')
                or declaration['l3_training_label_known_max']>=manifest['signal_date']):
            raise ValueError('l4_forward_full_pool_declaration_invalid')
        pool=NATIVE_POOL
    return dict(snapshot_id=manifest['snapshot_id'],signal_date=manifest['signal_date'],
        frozen_at=manifest['frozen_at'],original_sha256=manifest['payload_checksum'],
        verified_original_sha256=manifest['payload_checksum'],feature_rows=rows,
        features_checksum=digest(rows),eligible_symbols=[r['symbol'] for r in rows],
        feature_schema=feature_schema(feature_order(rows[0]['features'])),l3_identity=identity,
        pool_contract=pool,coverage_exclusions=excluded,original_prediction_count=len(predictions),
        source_manifest=manifest,l3_training_label_known_max=(declaration or {}).get('l3_training_label_known_max'))

def load_prices(bucket,reference,*,start,cutoff_day):
    """Verify official sessions and both adjusted fields from ONE current capture."""
    from services.training_session_calendar import verify_training_calendar
    raw=bucket.blob(reference['capture_manifest_path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=reference['capture_manifest_sha256']:raise ValueError('l4_forward_price_manifest_hash')
    manifest=json.loads(raw)
    if manifest['capture_id']!=reference['capture_id'] or manifest['end_date']>cutoff_day:raise ValueError('l4_forward_price_capture_date')
    proof=verify_training_calendar(bucket,price_capture=reference)
    root=reference['capture_manifest_path'].rsplit('/',1)[0];parts=[];all_dates=None;sources={}
    for field in ('adj_open','adj_close'):
        raw=bucket.blob(root+'/'+field+'.parquet').download_as_bytes();checksum=hashlib.sha256(raw).hexdigest()
        if checksum!=manifest['checksums'][field]:raise ValueError('l4_forward_price_field_hash')
        frame=pl.read_parquet(io.BytesIO(raw)).with_columns(pl.col('date').cast(pl.String).str.slice(0,10))
        dates=sorted(frame['date'].to_list())
        if len(dates)!=len(set(dates)) or (all_dates is not None and dates!=all_dates):raise ValueError('l4_forward_price_date_mismatch')
        all_dates=dates;sources[field]=checksum
        parts.append(frame.filter((pl.col('date')>=start)&(pl.col('date')<=cutoff_day)).unpivot(index='date',variable_name='symbol',value_name=field))
    prices=parts[0].join(parts[1],on=['date','symbol'],how='full',coalesce=True,validate='1:1')
    source_sha=digest(dict(reference=reference,fields=sources,calendar=proof))
    return all_dates,{(r['date'],r['symbol']):{**r,'source_sha256':source_sha} for r in prices.to_dicts()},proof

def refresh(*,query,bucket,price_capture,expected_identity,cutoff,lookback_days=90,
            snapshot_reader=None,publisher=publish,price_loader=load_prices,native_reader=None):
    """Idempotent daily refresh; returns observed/ready/failure dates separately."""
    from services.paired_nav_journal import read_context_projection
    if not 1<=lookback_days<=366:raise ValueError('l4_forward_lookback_invalid')
    clock=timestamp(cutoff);day=clock.astimezone(__import__('zoneinfo').ZoneInfo('Asia/Taipei')).date().isoformat()
    start=(datetime.fromisoformat(day)-timedelta(days=lookback_days)).date().isoformat()
    manifests=query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind=? AND signal_date>=? AND signal_date<=? ORDER BY signal_date,snapshot_id",['allocation_context',start,day])
    calendar,prices,price_proof=price_loader(bucket,price_capture,start=start,cutoff_day=day)
    reader=snapshot_reader or (lambda sid:read_context_projection(query,sid,
        ('inputs.alpha_policy.l4Distribution.runtime','model_predictions','l4_native_pool_contract')))
    items=[]
    for manifest in manifests:
        item=dict(snapshot_id=manifest['snapshot_id'],signal_date=manifest['signal_date'])
        try:
            # Cached projection remains bound to the original complete checksum.
            cache_id=digest(dict(snapshot=manifest['snapshot_id'],source=manifest['payload_checksum']))
            cache=bucket.blob(PREFIX+'projection_index/'+cache_id+'.json')
            if cache.exists():
                ref=json.loads(cache.download_as_bytes());raw=bucket.blob(ref['path']).download_as_bytes()
                if hashlib.sha256(raw).hexdigest()!=ref['sha256']:raise ValueError('l4_forward_projection_hash')
                snapshot=json.loads(raw)
                if snapshot['source_manifest']!=manifest:raise ValueError('l4_forward_manifest_changed')
            else:
                frozen=reader(manifest['snapshot_id'])
                if frozen['manifest']!=manifest:raise ValueError('l4_forward_manifest_changed')
                snapshot=project(frozen);ref=publisher(bucket,'projections',snapshot)
                from google.api_core.exceptions import PreconditionFailed
                raw=json.dumps(ref,sort_keys=True).encode()
                try:cache.upload_from_string(raw,if_generation_match=0)
                except PreconditionFailed:
                    if json.loads(cache.download_as_bytes())!=ref:raise ValueError('l4_forward_projection_index_conflict')
            rows,receipt=materialize(snapshot,calendar=calendar,prices=prices,cutoff=cutoff,
                expected_identity=expected_identity,pool_contract=NATIVE_POOL)
            if snapshot['coverage_exclusions']:
                receipt.update(training_eligible=False,training_blocker='incomplete_original_l3_coverage')
            body=dict(rows=rows,receipt=receipt,projection=ref,price_proof=price_proof)
            record=publisher(bucket,'materializations',body)
            items.append({**item,**receipt,'materialization':record})
        except Exception as exc:
            items.append({**item,'status':'failed','reason':'l4_forward_source_or_maturity_failed','error_type':type(exc).__name__,
                'error_summary':error_summary(exc),'training_eligible':False})
    if native_reader is not None:
        for snapshot,ref in native_reader(bucket,start=start,end=day,cutoff=cutoff):
            item=dict(snapshot_id=snapshot['snapshot_id'],signal_date=snapshot['signal_date'])
            try:
                rows,receipt=materialize(snapshot,calendar=calendar,prices=prices,cutoff=cutoff,
                    expected_identity=expected_identity,pool_contract=NATIVE_POOL)
                record=publisher(bucket,'materializations',dict(rows=rows,receipt=receipt,projection=ref,price_proof=price_proof))
                items.append({**item,**receipt,'materialization':record})
            except Exception as exc:
                items.append({**item,'status':'failed','reason':'l4_native_maturity_failed',
                    'error_type':type(exc).__name__,'error_summary':error_summary(exc),'training_eligible':False})
    eligible=[r['signal_date'] for r in items if r['training_eligible']]
    ready=[r['signal_date'] for r in items if r['status']=='ready']
    result=dict(schema_version='l4-forward-refresh-v1',cutoff=cutoff,status='failed' if any(r['status']=='failed' for r in items) else 'refreshed',
        latest_observed_signal_date=max((r['signal_date'] for r in items),default=None),
        latest_mature_evaluation_date=max(ready,default=None),latest_training_eligible_date=max(eligible,default=None),
        source_count=len(items),items=items,price_proof=price_proof,training_dispatched=False,promoted=False)
    result['registry_receipt']=publisher(bucket,'refreshes',result.copy())
    return result

def current_price_capture(bucket,business_date,*,cutoff):
    """Discover immutable daily price evidence without requiring a trading plan.

    Newest receipt at the requested observation time must verify; corruption is
    not hidden by falling back. Feature tensors are not label-price inputs.
    """
    candidates=[];clock=timestamp(cutoff)
    prefix='universal/oof_forward_prep_v2/'+business_date+'-'
    for blob in bucket.list_blobs(prefix=prefix):
        if not blob.name.endswith('/prep/immutable_receipt.json'):continue
        created=blob.time_created
        if created is None:raise ValueError('l4_forward_price_receipt_creation_missing')
        if created<=clock:candidates.append((created,blob.name,blob))
    if not candidates:raise ValueError('l4_forward_daily_price_source_missing')
    _,path,blob=max(candidates,key=lambda item:item[:2])
    raw=blob.download_as_bytes(if_generation_match=blob.generation);receipt=json.loads(raw)
    checksum=hashlib.sha256(json.dumps({k:v for k,v in receipt.items() if k!='receipt_checksum'},sort_keys=True).encode()).hexdigest()
    capture=receipt.get('price_capture') or {}
    if (receipt.get('receipt_checksum')!=checksum or receipt.get('status')!='ready'
            or receipt.get('business_date')!=business_date
            or receipt.get('output_gcs_prefix')!=path.removesuffix('/prep/immutable_receipt.json')
            or not capture.get('capture_manifest_path') or not capture.get('capture_manifest_sha256')):
        raise ValueError('l4_forward_daily_price_receipt_invalid')
    manifest_raw=bucket.blob(capture['capture_manifest_path']).download_as_bytes()
    if (hashlib.sha256(manifest_raw).hexdigest()!=capture['capture_manifest_sha256']
            or json.loads(manifest_raw).get('end_date')!=business_date):
        raise ValueError('l4_forward_daily_price_capture_not_current')
    return capture,dict(path=path,sha256=hashlib.sha256(raw).hexdigest(),receipt_checksum=checksum)


def refresh_daily(config,business_date,*,now=None):
    """Durable daily-job entry; current capture is independent of Paper closure."""
    from datetime import timezone
    from services.d1_domain_client import client_proxy_for_domain
    from services.walk_forward_retrain import _get_bucket
    clock=now or datetime.now(timezone.utc)
    learning=client_proxy_for_domain('learning');bucket=_get_bucket()
    if bucket is None:raise ValueError('l4_forward_bucket_missing')
    capture,source=current_price_capture(bucket,business_date,cutoff=clock.isoformat())
    identity=config['l4Distribution']['artifact']['l3_identity']
    observation=None
    native_config=(config.get('l4R2Learning') or {}).get('native_observation')
    from services.l4_native_observation import collect,discover
    if native_config is not None:
        import asyncio
        identity=native_config['l3_identity']
        try:
            from services.l4_r2_release_preflight import check
            check(bucket,config,signal_date=business_date)
            observation=asyncio.run(collect(bucket=bucket,config=native_config,day=business_date))
        except Exception as exc:
            import re
            reason=str(exc)
            if not re.fullmatch('l4_(?:native|r2)_[a-z_]+',reason):reason='l4_native_collection_failed'
            observation=dict(status='failed',reason=reason,error_type=type(exc).__name__,error_summary=error_summary(exc))
        clock=datetime.now(timezone.utc)
    result=refresh(query=learning.query,bucket=bucket,price_capture=capture,
        expected_identity=identity,cutoff=clock.isoformat(),native_reader=discover)
    result.update(business_date=business_date,current_price_source=source,native_observation=observation)
    if observation and observation['status']=='failed':
        result.update(status='failed',reason=observation['reason'])
        return result
    if observation and observation['status']=='pending':
        if result['status']!='failed':
            result.update(status='pending',reason=observation['reason'],
                external_compute_pending=observation.get('external_compute_pending',False))
        return result
    shadow=(config.get('l4R2Learning') or {}).get('shadow')
    if shadow is not None:
        if observation is None:raise ValueError('l4_forward_native_observation_required_for_shadow')
        from services.l4_r2_daily_shadow import run
        try:result['r2_shadow']=run(bucket=bucket,config=shadow,observation=observation,day=business_date)
        except Exception as exc:return component_failure(result,'r2_shadow',exc)
        from services.l4_r2_forward_evaluation import run as evaluate
        try:
            result['r2_evaluation']=evaluate(bucket=bucket,config=shadow,price_capture=capture,
                cutoff=datetime.now(timezone.utc).isoformat(),identity=identity)
        except Exception as exc:component_failure(result,'r2_evaluation',exc)
        from services.l4_r2_paired import run as pair
        try:
            result['r2_paired']=pair(bucket=bucket,config=shadow,observation=observation,
                shadow=result['r2_shadow'],day=business_date,query=learning.query,writer=learning.batch_execute)
        except Exception as exc:component_failure(result,'r2_paired',exc)
        if result['r2_paired']['status']=='pending' and result['status']!='failed':
            result.update(status='pending',reason=result['r2_paired']['reason'])
    return result


def component_failure(result,component,exc):
    """Preserve independently refreshed dates while exposing downstream failure."""
    import re
    code=str(exc)
    if not re.fullmatch('l4_(?:forward|native|r2)_[a-z_]+',code):code='l4_'+component+'_failed'
    result[component]=dict(status='failed',reason=code,error_type=type(exc).__name__,error_summary=error_summary(exc))
    result.update(status='failed',reason=code)
    return result

def attach_daily_result(result,config,business_date,*,runner=None):
    """Keep account closure independent, but never turn data failure into passed."""
    try:
        data=(runner or refresh_daily)(config,business_date)
    except Exception as exc:
        code=str(exc)
        import re
        if not re.fullmatch('l4_(?:forward|native|r2)_[a-z_]+',code):code='l4_forward_refresh_failed'
        data=dict(status='failed',reason=code,error_type=type(exc).__name__,error_summary=error_summary(exc),
            training_dispatched=False,promoted=False)
    result['forward_learning_data']=data
    if data['status']=='failed':
        result.update(status='failed',dependency_retry_required=True,reason='l4_forward_refresh_failed')
    elif data['status']=='pending':
        result.update(status='pending',dependency_retry_required=True,reason=data.get('reason','l4_native_inference_pending'),
            external_compute_pending=data.get('external_compute_pending',False))
    return result


def callback_summary(result):
    """Bounded observability: data dates cannot masquerade as model-fit dates."""
    from collections import Counter
    return {k:result[k] for k in ('status','reason','error_type','error_summary','business_date','cutoff',
        'latest_observed_signal_date','latest_mature_evaluation_date','latest_training_eligible_date',
        'source_count','registry_receipt','training_dispatched','promoted','native_observation','r2_shadow','r2_evaluation','r2_paired') if k in result} | {
        'status_counts':dict(Counter(r['status'] for r in result.get('items',[]))),
        'failure_samples':[{k:r.get(k) for k in ('signal_date','reason','error_type','error_summary')}
            for r in result.get('items',[]) if r['status']=='failed'][:3],
        'training_blocker_counts':dict(Counter(r['training_blocker'] for r in result.get('items',[])
            if r.get('training_blocker')))}
