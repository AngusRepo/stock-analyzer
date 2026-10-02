"""Durable L3 handoff and resumable morning downstream execution. No overnight process."""
from __future__ import annotations
import hashlib
import json
import os
from datetime import datetime, timezone, timedelta
from google.cloud import storage
from google.api_core.exceptions import NotFound, PreconditionFailed
from services.pipeline_async_state_transport import (STATE_SCHEMA_V2, build_pipeline_payload_identity,
    encode_pipeline_state_envelope, decode_pipeline_state_envelope)
from services.premarket_information import build_information_delta

OWNER = 'premarket_once_v1'
def enabled():
    return os.environ.get('PIPELINE_DAILY_PLAN_OWNER') == OWNER
def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode()).hexdigest()
def prefix(day, run_id):
    datetime.strptime(day,'%Y-%m-%d')
    if not run_id: raise ValueError('premarket_run_id_missing')
    return 'pipeline-v2/premarket/'+day+'/'+hashlib.sha256(run_id.encode()).hexdigest()
def bucket(client=None):
    name=os.environ.get('GCS_BUCKET_NAME','').strip()
    if not name: raise ValueError('premarket_bucket_missing')
    return (client or storage.Client()).bucket(name)
def immutable(blob,raw,content_type='application/json'):
    try: blob.upload_from_string(raw,content_type=content_type,if_generation_match=0)
    except PreconditionFailed:
        if blob.download_as_bytes() != (raw.encode() if isinstance(raw,str) else raw):
            raise ValueError('premarket_immutable_conflict')
def json_bytes(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False,ensure_ascii=False).encode()

def source_records(us, news, *, captured_at):
    """Global economic sources, not per-symbol duplicated macro features."""
    records=[]
    if us:
        available=us.get('fetched_at') or captured_at
        payload={k:v for k,v in us.items() if k not in ('date','fetched_at','source_times')}
        times=[v for v in (us.get('source_times') or {}).values() if v and 'T' in v]
        records.append(dict(source_key='us-leading',version='us-leading-v1',session=us.get('date'),
            observed_at=max(times) if times else available,available_at=available,payload=payload))
    if news and news.get('evidence_receipt'):
        cutoff=news.get('cutoff') or captured_at
        # Macro prices are independently keyed above; news evidence IDs are not repeated price features.
        records.append(dict(source_key='news',version='news-evidence-v2',session=news.get('date'),
            observed_at=cutoff,available_at=captured_at,payload={k:news.get(k) for k in
                ('evidence','assessments','sector_evidence','sector_bias','risk_factors','bias')}))
        night=(news.get('macro_evidence') or {}).get('taifex_night')
        if night:
            d=str(night['date']);t=str(night['time'])
            if len(d)==8:d=d[:4]+'-'+d[4:6]+'-'+d[6:]
            if len(t)==6:t=t[:2]+':'+t[2:4]+':'+t[4:]
            records.append(dict(source_key='taifex-night',version='taifex-night-v1',session=d,
                observed_at=d+'T'+t+'+08:00',available_at=captured_at,
                payload={k:night[k] for k in ('lastPrice','changePct','changePoints')}))
    return records

def capture_baseline(day,read_json):
    now=datetime.now(timezone.utc).isoformat()
    return {'signal_date':day,'available_at':now,'sources':source_records(
        read_json('us:leading:'+day,default=None,strict=True),
        read_json('market:news_analyst:'+day,default=None,strict=True),captured_at=now)}

def seal_l3(state, *, client=None):
    if not state.get('predictions') or not state.get('premarket_baseline'):
        raise ValueError('premarket_l3_incomplete')
    b=bucket(client); path=prefix(state['run_date'],state['producer_run_id'])
    receipt_blob=b.blob(path+'/l3-receipt.json')
    source_hash=digest({'predictions':state['predictions'],'payload_identity':build_pipeline_payload_identity(state['payloads']),
        'baseline':state['premarket_baseline'],'modal_bundle_checksum':state.get('modal_bundle_checksum')})
    try:
        old=json.loads(receipt_blob.download_as_bytes())
        if old['source_hash']!=source_hash: raise ValueError('premarket_l3_divergent_retry')
        return old
    except NotFound: pass
    saved={k:v for k,v in state.items() if k!='l3_payloads'}
    saved['pipeline_payload_identity']=build_pipeline_payload_identity(saved['payloads'])
    raw=encode_pipeline_state_envelope({'schema_version':STATE_SCHEMA_V2,'state':saved})
    checksum=hashlib.sha256(raw).hexdigest()
    uri=f'gs://{b.name}/{path}/l3-{checksum}.json.gz'
    immutable(b.blob(path+'/l3-'+checksum+'.json.gz'),raw,'application/gzip')
    receipt={'schema_version':'premarket-l3-seal-v1','run_date':state['run_date'],'run_id':state['producer_run_id'],
        'state_gcs_uri':uri,'checksum':checksum,'modal_bundle_checksum':state.get('modal_bundle_checksum'),'source_hash':source_hash,'sealed_at':datetime.now(timezone.utc).isoformat()}
    immutable(receipt_blob,json_bytes(receipt))
    return receipt

def read_seal(day,run_id,*,client=None):
    try:return json.loads(bucket(client).blob(prefix(day,run_id)+'/l3-receipt.json').download_as_bytes())
    except NotFound:return None

def load_state(receipt, *, client=None):
    b=bucket(client); expected=read_seal(receipt['run_date'],receipt['run_id'],client=client)
    if receipt != expected: raise ValueError('premarket_seal_mismatch')
    root='gs://'+b.name+'/'
    if not receipt['state_gcs_uri'].startswith(root): raise ValueError('premarket_bucket_mismatch')
    raw=b.blob(receipt['state_gcs_uri'][len(root):]).download_as_bytes()
    if hashlib.sha256(raw).hexdigest()!=receipt['checksum']:raise ValueError('premarket_state_checksum')
    return decode_pipeline_state_envelope(raw)['state']

def validate_context(receipt, context, *, now=None):
    now=now or datetime.now(timezone.utc)
    tw=now.astimezone(timezone(timedelta(hours=8)))
    if context.get('trade_date')!=tw.date().isoformat() or (tw.hour,tw.minute)>=(8,45):
        raise ValueError('premarket_allocation_cutoff')
    if receipt['run_date']>=context['trade_date']:raise ValueError('premarket_signal_date_invalid')
    cutoff=datetime.fromisoformat(context['cutoff'].replace('Z','+00:00'))
    if cutoff.tzinfo is None or cutoff>now or now-cutoff>timedelta(minutes=105):raise ValueError('premarket_context_stale')
    if context['checksum']!=digest({k:v for k,v in context.items() if k!='checksum'}):raise ValueError('premarket_context_checksum')

def dispatch(receipt,context,*,jobs_client,client=None):
    validate_context(receipt,context)
    if receipt != read_seal(receipt['run_date'],receipt['run_id'],client=client):
        raise ValueError('premarket_seal_mismatch')  # resume verifies the large artifact once, not on every poll
    b=bucket(client);p=prefix(receipt['run_date'],receipt['run_id'])
    body={'receipt':receipt,'context':context};raw=json_bytes(body)
    immutable(b.blob(p+'/morning-input.json'),raw)
    claim=b.blob(p+'/dispatch.json')
    identity={'input_checksum':hashlib.sha256(raw).hexdigest(),'run_id':receipt['run_id'],'run_date':receipt['run_date']}
    try:claim.upload_from_string(json_bytes({**identity,'status':'dispatching'}),if_generation_match=0)
    except PreconditionFailed:
        old=json.loads(claim.download_as_bytes())
        if any(old.get(k)!=v for k,v in identity.items()):raise ValueError('premarket_dispatch_identity_changed')
        # Unknown dispatch is not permission to launch again. Reconcile the exact parent ID.
        observed=jobs_client.pipeline_execution_status(run_date=receipt['run_date'],run_id=receipt['run_id'],
            execution_name=old.get('execution_name',''),
            required_env={'PIPELINE_PREMARKET_RESUME_MODE':'1','PIPELINE_PREMARKET_INPUT_GCS_URI':f'gs://{b.name}/{p}/morning-input.json'})
        if old.get('execution_name') and observed.get('execution_name')==old['execution_name'] and observed.get('state')=='failed':
            claim.reload()
            claim.upload_from_string(json_bytes({**identity,'status':'dispatching','recovery_of':old['execution_name']}),
                if_generation_match=claim.generation)
        else:
            if not old.get('execution_name'):
                if observed.get('execution_name') and observed.get('state') in ('running','succeeded','failed'):
                    # Recover a lost dispatch response from the exact morning input identity.
                    claim.reload()
                    old={**identity,'status':'dispatched','execution_name':observed['execution_name']}
                    claim.upload_from_string(json_bytes(old),if_generation_match=claim.generation)
                else:
                    return {**old,'status':'reconciliation_required','reason':'premarket_dispatch_outcome_unknown'}
            return old
    execution=jobs_client.run_job(env_overrides={'PIPELINE_PREMARKET_RESUME_MODE':'1',
        'PIPELINE_MODAL_CONTINUATION_MODE':'0','PIPELINE_SNAPSHOT_RECOVERY_MODE':'0',
        'PIPELINE_RUN_DATE':receipt['run_date'],'PIPELINE_PARENT_RUN_ID':receipt['run_id'],
        'PIPELINE_PREMARKET_INPUT_GCS_URI':f'gs://{b.name}/{p}/morning-input.json'},reject_if_running=False)
    claim.reload()
    result={**identity,'status':'dispatched','execution_name':execution.execution_name}
    claim.upload_from_string(json_bytes(result),if_generation_match=claim.generation)
    return result

async def resume(input_uri, *, nodes, merge, client=None):
    b=bucket(client);root='gs://'+b.name+'/'
    if not input_uri.startswith(root):raise ValueError('premarket_input_bucket_mismatch')
    body=json.loads(b.blob(input_uri[len(root):]).download_as_bytes());receipt,context=body['receipt'],body['context']
    validate_context(receipt,context)
    state=load_state(receipt,client=client)
    baseline={**state['premarket_baseline'],'l3_snapshot_id':receipt['checksum']}
    delta=build_information_delta(baseline=baseline,current_records=source_records(context['us'],context['news'],captured_at=context['cutoff']),cutoff=context['cutoff'],
        trade_date=context['trade_date'],required_sources=('us-leading','news','taifex-night'),
        max_age_seconds={'us-leading':96*3600,'news':24*3600,'taifex-night':96*3600})
    state['premarket_information']=delta
    state['premarket_context']=context
    state.setdefault('metrics',{})['premarket_information']={k:v for k,v in delta.items() if k!='changes'}
    p=prefix(receipt['run_date'],receipt['run_id'])
    for node in nodes:
        validate_context(receipt,context)
        key=p+'/phases/'+node.__name__+'.json.gz'; blob=b.blob(key)
        try:
            state=decode_pipeline_state_envelope(blob.download_as_bytes())['state']
            continue
        except NotFound:pass
        # A phase has one producer. A lost completion receipt is an unknown
        # outcome, never permission to pay for a second allocation.
        claim=b.blob(p+'/phases/'+node.__name__+'.claim.json')
        identity={'input_checksum':body['context']['checksum'],'phase':node.__name__}
        try:claim.upload_from_string(json_bytes({**identity,'status':'running'}),if_generation_match=0)
        except PreconditionFailed:
            old=json.loads(claim.download_as_bytes())
            if any(old.get(k)!=v for k,v in identity.items()):raise ValueError('premarket_phase_identity_changed')
            if old.get('status')!='failed':raise ValueError('premarket_phase_outcome_requires_reconciliation:'+node.__name__)
            claim.reload()
            claim.upload_from_string(json_bytes({**identity,'status':'running'}),if_generation_match=claim.generation)
        try:
            merge(state,await node(state))
            raw=encode_pipeline_state_envelope({'schema_version':STATE_SCHEMA_V2,'state':{k:v for k,v in state.items() if k!='l3_payloads'}})
            immutable(blob,raw,'application/gzip')
        except Exception:
            claim.reload()
            claim.upload_from_string(json_bytes({**identity,'status':'ambiguous' if node.__name__=='node_recommend' else 'failed'}),
                if_generation_match=claim.generation)
            raise
    return state
