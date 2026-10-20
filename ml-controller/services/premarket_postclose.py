"""Durable after-close research dispatch, bound to an actual serving receipt.

This module never runs allocation, changes its clock, or grants NAV credit.
Unknown Cloud Run dispatch outcomes require reconciliation, not another launch.
"""
from datetime import datetime, timezone, timedelta, date
import json
import os
from google.api_core.exceptions import NotFound, PreconditionFailed
from services import premarket_pipeline as owner
from services.premarket_publication import read as read_publication

ROOT = 'pipeline-v2/postclose/'

def _now(now=None):
    result=now or datetime.now(timezone.utc)
    if result.tzinfo is None: raise ValueError('postclose_clock_timezone_missing')
    return result

def _verified(value):
    if (value.get('schema_version')!='premarket-postclose-work-v1'
            or value.get('checksum')!=owner.digest({k:v for k,v in value.items() if k!='checksum'})):
        raise ValueError('postclose_work_checksum_invalid')
    day=value['trade_date']
    if date.fromisoformat(day).isoformat()!=day: raise ValueError('postclose_date_invalid')
    expected=datetime.fromisoformat(day+'T13:30:00+08:00').isoformat()
    if value.get('not_before')!=expected: raise ValueError('postclose_market_close_invalid')
    return value

def work_path(publication):
    day=publication['trade_date']
    if date.fromisoformat(day).isoformat()!=day: raise ValueError('postclose_date_invalid')
    return ROOT+day+'/'+owner.digest([publication['signal_date'],publication['run_id']])+'/work.json'

def enqueue(state, *, client=None):
    """Seal the research reference, never duplicate the large serving snapshot."""
    day,run_id=state['run_date'],state['producer_run_id']
    publication=read_publication(day,run_id,client=client)
    if publication is None: raise ValueError('postclose_serving_receipt_missing')
    context=state.get('premarket_context') or {}
    if (context.get('checksum')!=publication['context_checksum']
            or context.get('trade_date')!=publication['trade_date']):
        raise ValueError('postclose_context_mismatch')
    b=owner.bucket(client)
    input_path=owner.prefix(day,run_id)+'/morning-input.json'
    raw=b.blob(input_path).download_as_bytes()
    input_body=json.loads(raw)
    if input_body.get('context')!=context or input_body.get('receipt')!=owner.read_seal(day,run_id,client=client):
        raise ValueError('postclose_original_input_changed')
    body={'schema_version':'premarket-postclose-work-v1','signal_date':day,'run_id':run_id,
          'trade_date':publication['trade_date'], 'publication_checksum':publication['checksum'],
          'input_gcs_uri':f'gs://{b.name}/{input_path}', 'input_checksum':owner.digest(input_body),
          'not_before':publication['trade_date']+'T13:30:00+08:00',
          'production_effect':False,'nav_maturity_credit':0}
    sealed={**body,'checksum':owner.digest(body)}
    key=work_path(publication)
    owner.immutable(b.blob(key),owner.json_bytes(sealed))
    if json.loads(b.blob(key).download_as_bytes())!=sealed:
        raise ValueError('postclose_work_readback_failed')
    return {'status':'queued_postclose','work_gcs_uri':f'gs://{b.name}/{key}',
            'work_checksum':sealed['checksum'],'not_before':sealed['not_before']}

def read_work(uri, *, client=None, now=None):
    b=owner.bucket(client);root='gs://'+b.name+'/'
    if not uri.startswith(root+ROOT): raise ValueError('postclose_work_bucket_or_prefix_invalid')
    key=uri[len(root):]
    work=_verified(json.loads(b.blob(key).download_as_bytes()))
    if _now(now)<datetime.fromisoformat(work['not_before']):
        raise ValueError('postclose_before_market_close')
    publication=read_publication(work['signal_date'],work['run_id'],client=client)
    if (publication is None or publication['checksum']!=work['publication_checksum']
            or key!=work_path(publication)):
        raise ValueError('postclose_publication_changed')
    expected=root+owner.prefix(work['signal_date'],work['run_id'])+'/morning-input.json'
    if work['input_gcs_uri']!=expected: raise ValueError('postclose_input_path_changed')
    body=json.loads(b.blob(expected[len(root):]).download_as_bytes())
    if (owner.digest(body)!=work['input_checksum']
            or body.get('receipt')!=owner.read_seal(work['signal_date'],work['run_id'],client=client)
            or (body.get('context') or {}).get('checksum')!=publication['context_checksum']):
        raise ValueError('postclose_input_checksum_changed')
    return work

def dispatch_one(uri, *, jobs_client, client=None, now=None):
    work=read_work(uri,client=client,now=now)
    source=os.environ.get('STOCKVISION_SOURCE_SHA','').strip()
    if len(source)!=40 or any(c not in '0123456789abcdef' for c in source):
        raise ValueError('postclose_deployed_source_missing')
    b=owner.bucket(client);key=uri.split(b.name+'/',1)[1]
    claim=b.blob(key.rsplit('/',1)[0]+'/dispatch.json')
    identity={'work_checksum':work['checksum'],'run_id':work['run_id'],'run_date':work['signal_date']}
    required={'PIPELINE_PREMARKET_POSTCLOSE_WORK_URI':uri}
    try:
        claim.upload_from_string(owner.json_bytes({**identity,'status':'dispatching'}),if_generation_match=0)
    except PreconditionFailed:
        old=json.loads(claim.download_as_bytes())
        if any(old.get(k)!=v for k,v in identity.items()):raise ValueError('postclose_dispatch_identity_changed')
        observed=jobs_client.pipeline_execution_status(run_date=work['signal_date'],run_id=work['run_id'],
            execution_name=old.get('execution_name',''),required_env=required)
        if (old.get('execution_name') and observed.get('execution_name')==old['execution_name']
                and observed.get('state')=='failed'):
            claim.reload()
            claim.upload_from_string(owner.json_bytes({**identity,'status':'dispatching',
                'recovery_of':old['execution_name']}),if_generation_match=claim.generation)
        else:
            if not old.get('execution_name') and observed.get('execution_name'):
                old={**identity,'status':'dispatched','execution_name':observed['execution_name']}
                claim.reload();claim.upload_from_string(owner.json_bytes(old),if_generation_match=claim.generation)
            return {**old,'observed_state':observed.get('state','unknown'),
                    'status':old['status'] if old.get('execution_name') else 'reconciliation_required'}
    env={**required,'PIPELINE_RUN_DATE':work['signal_date'],'PIPELINE_PARENT_RUN_ID':work['run_id'],
         'DATASET_SNAPSHOT_RUN_DATE':work['signal_date'],
         'DATASET_SNAPSHOT_PARENT_RUN_ID':work['run_id'],
         'DATASET_SNAPSHOT_PRODUCER_RUN_ID':work['run_id']+':postclose',
         'DATASET_SNAPSHOT_INPUT_ONLY':'0','PIPELINE_PREMARKET_POSTWRITE_INPUT_GCS_URI':''}
    execution=jobs_client.run_job(env_overrides=env,reject_if_running=False,expected_source_sha=source)
    result={**identity,'status':'dispatched','execution_name':execution.execution_name}
    claim.reload();claim.upload_from_string(owner.json_bytes(result),if_generation_match=claim.generation)
    return result

def dispatch_day(trade_date, *, jobs_client, client=None, now=None):
    if date.fromisoformat(trade_date).isoformat()!=trade_date:raise ValueError('postclose_date_invalid')
    if _now(now)<datetime.fromisoformat(trade_date+'T13:30:00+08:00'):
        raise ValueError('postclose_before_market_close')
    b=owner.bucket(client);results=[]
    for blob in b.list_blobs(prefix=ROOT+trade_date+'/'):
        if not blob.name.endswith('/work.json'):continue
        uri=f'gs://{b.name}/{blob.name}'
        try:result=dispatch_one(uri,jobs_client=jobs_client,client=client,now=now)
        except Exception as exc:
            result={'status':'error','reason':type(exc).__name__+':'+str(exc)}
        results.append({'work_gcs_uri':uri,**result})
    return {'trade_date':trade_date,'status':'error' if any(r['status']=='error' for r in results) else
            'reconciliation_required' if any(r['status']=='reconciliation_required' for r in results) else
            'dispatched' if results else 'no_published_work','results':results}
