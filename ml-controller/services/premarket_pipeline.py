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
SERVING_PHASES=('node_compute_personas','node_recommend','node_llm_reasons','node_write_d1',
    'node_paired_nav_setup','node_export_dataset_snapshot')
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
            # MIS CDate identifies the opening session, matching Worker
            # isReadyNight: 00:00 through 05:00 occur on the next civil day.
            observed=datetime.fromisoformat(d+'T'+t+'+08:00')
            if '00:00:00' <= t <= '05:00:00':
                observed+=timedelta(days=1)
            records.append(dict(source_key='taifex-night',version='taifex-night-v1',session=d,
                observed_at=observed.isoformat(),available_at=captured_at,
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

def l3_handoff_result(state, receipt):
    """Prediction sealing and comparison-input readiness are separate facts."""
    atomic = state.get('paired_nav_atomic_inputs') or {}
    status = atomic.get('status', 'missing')
    readiness = ('failed' if status in ('failed', 'error') else
                 'ready' if status == 'pre_l2_inputs_captured' else 'waiting')
    return {'status':'awaiting_premarket', 'run_date':state['run_date'],
            'l3_receipt':receipt, 'metrics':state.get('metrics', {}),
            'input_readiness':{'atomic_inputs':readiness}}

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
    # Wei's one-day realtime-paper recovery keeps the actual capture time.
    paper_recovery = (enabled() and receipt.get('run_date') == '2026-10-08'
        and context.get('trade_date') == tw.date().isoformat() == '2026-10-12')
    # Oct 13 paper recovery remains valid for this date; preopen is the target.
    opening_recovery = (enabled() and receipt.get('run_date') == '2026-10-12'
        and context.get('trade_date') == tw.date().isoformat() == '2026-10-13')
    # Dated Paper recoveries preserve the actual context clock. Oct 16 also
    # permits a fresh same-day context after 08:45, as explicitly authorized.
    late_recovery = (enabled() and (receipt.get('run_date'), context.get('trade_date')) in {
        ('2026-10-13', '2026-10-14'), ('2026-10-15', '2026-10-16')}
        and context.get('trade_date') == tw.date().isoformat())
    if context.get('trade_date')!=tw.date().isoformat() or ((tw.hour,tw.minute)>=(8,45) and not (paper_recovery or opening_recovery or late_recovery)):
        raise ValueError('premarket_allocation_cutoff')
    if receipt['run_date']>=context['trade_date']:raise ValueError('premarket_signal_date_invalid')
    cutoff=datetime.fromisoformat(context['cutoff'].replace('Z','+00:00'))
    if cutoff.tzinfo is None or cutoff>now:raise ValueError('premarket_context_stale')
    captured_tw=cutoff.astimezone(timezone(timedelta(hours=8)))
    late_recovery = (late_recovery and captured_tw.date()==tw.date()
        and ((6,45)<=(captured_tw.hour,captured_tw.minute)<(8,45)
             or (tw.date().isoformat()=='2026-10-16' and now-cutoff<=timedelta(minutes=120))))
    if tw.date().isoformat() in {'2026-10-14','2026-10-16'} and (tw.hour,tw.minute)>=(8,45) and not late_recovery:
        raise ValueError('premarket_allocation_cutoff')
    # The explicitly authorized Oct 12 after-close paper backfill retains its
    # original capture for this day. It cannot open another day's allocation,
    # alter source freshness at capture, or grant an execution window.
    after_close_recovery=(paper_recovery and captured_tw.date()==tw.date()
        and (captured_tw.hour,captured_tw.minute)>=(13,30) and (tw.hour,tw.minute)>=(13,30))
    # Context can freeze at 06:45; the independent 08:45 cutoff remains strict.
    max_age_minutes = 105 if (paper_recovery or opening_recovery) else 120
    if now-cutoff>timedelta(minutes=max_age_minutes) and not (after_close_recovery or late_recovery):raise ValueError('premarket_context_stale')
    if context['checksum']!=digest({k:v for k,v in context.items() if k!='checksum'}):raise ValueError('premarket_context_checksum')

def dispatch(receipt,context,*,jobs_client,client=None):
    validate_context(receipt,context)
    if receipt != read_seal(receipt['run_date'],receipt['run_id'],client=client):
        raise ValueError('premarket_seal_mismatch')  # resume verifies the large artifact once, not on every poll
    b=bucket(client);p=prefix(receipt['run_date'],receipt['run_id'])
    body={'receipt':receipt,'context':context};raw=json_bytes(body)
    immutable(b.blob(p+'/morning-input.json'),raw)
    try:
        terminal=json.loads(b.blob(p+'/nonretryable-inputs.json').download_as_bytes())
    except NotFound:
        terminal=None
    if terminal is not None:
        expected={'schema_version':'premarket-nonretryable-inputs-v1',
                  'run_id':receipt['run_id'],'run_date':receipt['run_date'],
                  'l3_checksum':receipt['checksum'],'context_checksum':context['checksum']}
        if any(terminal.get(k)!=v for k,v in expected.items()):
            raise ValueError('premarket_nonretryable_receipt_identity_mismatch')
        raise ValueError('premarket_nonretryable_frozen_atomic_inputs_requires_explicit_recovery')
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


def record_nonretryable_inputs(state, result, *, client=None):
    """A sealed missing Atomic source cannot improve by replaying the same state."""
    atomic=state.get('paired_nav_atomic_inputs') or {}
    if (result.get('status') != 'error' or atomic.get('status') not in ('failed','error')
            or atomic.get('reason') != 'paired_nav_source_or_capture_failed'
            or not any(str(e).startswith('paired_nav:atomic_') for e in result.get('critical_errors',[]))):
        return
    receipt=read_seal(state['run_date'],state['producer_run_id'],client=client)
    context=state.get('premarket_context') or {}
    if not receipt or not context.get('checksum'):
        raise ValueError('premarket_nonretryable_receipt_scope_missing')
    value={'schema_version':'premarket-nonretryable-inputs-v1','run_id':receipt['run_id'],
           'run_date':receipt['run_date'],'l3_checksum':receipt['checksum'],
           'context_checksum':context['checksum'],'reason':'frozen_atomic_inputs_failed'}
    b=bucket(client)
    immutable(b.blob(prefix(receipt['run_date'],receipt['run_id'])+'/nonretryable-inputs.json'),json_bytes(value))

def save_historical_exclusion(state, receipt, *, client=None):
    from services.historical_atomic_exclusion import valid
    collection={**state['paired_nav_collection'],'status':'historical_not_prospective','historical_exclusion':receipt}
    if not valid(collection):raise ValueError('paired_nav_invalid_historical_exclusion')
    immutable(bucket(client).blob(prefix(state['run_date'],state['producer_run_id'])+'/historical-atomic-exclusion.json'),json_bytes(receipt))

def dispatch_terminal_reconciliation(receipt,context,*,jobs_client,client=None):
    """One explicit receipt-only continuation; normal failure fence stays held."""
    now=datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=8)))
    if not enabled() or (receipt['run_date'],context.get('trade_date'),now.date().isoformat())!=('2026-10-15','2026-10-16','2026-10-16'):
        raise ValueError('premarket_terminal_reconciliation_scope_invalid')
    b=bucket(client);p=prefix(receipt['run_date'],receipt['run_id'])
    if receipt!=read_seal(receipt['run_date'],receipt['run_id'],client=client):raise ValueError('premarket_seal_mismatch')
    raw=json_bytes({'receipt':receipt,'context':context})
    if b.blob(p+'/morning-input.json').download_as_bytes()!=raw:raise ValueError('premarket_terminal_reconciliation_input_changed')
    for name in SERVING_PHASES:
        if not b.blob(p+'/phases/'+name+'.json.gz').exists():raise ValueError('premarket_terminal_reconciliation_incomplete')
    fence=json.loads(b.blob(p+'/nonretryable-inputs.json').download_as_bytes())
    from services.historical_atomic_exclusion import ERRORS
    if (fence.get('run_id')!=receipt['run_id'] or fence.get('l3_checksum')!=receipt['checksum']
        or fence.get('context_checksum')!=context['checksum'] or set(fence.get('original_error','').split('; '))!=ERRORS
        or fence.get('reason')!='frozen_historical_atomic_comparison_not_retryable'):
        raise ValueError('premarket_terminal_reconciliation_fence_invalid')
    # Check the original context at its capture clock; no phase may execute.
    validate_context(receipt,context,now=datetime.fromisoformat(context['cutoff'].replace('Z','+00:00'))+timedelta(seconds=1))
    claim=b.blob(p+'/terminal-reconciliation.json')
    identity={'input_checksum':hashlib.sha256(raw).hexdigest(),'run_id':receipt['run_id'],'run_date':receipt['run_date']}
    required={'PIPELINE_PREMARKET_COMPLETED_ONLY':'1','PIPELINE_PREMARKET_INPUT_GCS_URI':f'gs://{b.name}/{p}/morning-input.json'}
    try:claim.upload_from_string(json_bytes({**identity,'status':'dispatching'}),if_generation_match=0)
    except PreconditionFailed:
        old=json.loads(claim.download_as_bytes())
        if any(old.get(k)!=v for k,v in identity.items()):raise ValueError('premarket_terminal_reconciliation_identity_changed')
        observed=jobs_client.pipeline_execution_status(run_date=receipt['run_date'],run_id=receipt['run_id'],
            execution_name=old.get('execution_name',''),required_env=required)
        if old.get('execution_name'):return {**old,'observed_state':observed.get('state')}
        if not observed.get('execution_name'):return {**old,'status':'reconciliation_required','reason':'premarket_dispatch_outcome_unknown'}
        result={**identity,'status':'dispatched','execution_name':observed['execution_name']}
        claim.reload();claim.upload_from_string(json_bytes(result),if_generation_match=claim.generation);return result
    execution=jobs_client.run_job(env_overrides={**required,'PIPELINE_PREMARKET_RESUME_MODE':'1',
        'PIPELINE_MODAL_CONTINUATION_MODE':'0','PIPELINE_SNAPSHOT_RECOVERY_MODE':'0',
        'PIPELINE_INPUT_CONTINUATION_MODE':'0','PIPELINE_SAVED_L2_RESUME_MODE':'0',
        'PIPELINE_RUN_DATE':receipt['run_date'],'PIPELINE_PARENT_RUN_ID':receipt['run_id']},
        reject_if_running=True,expected_source_sha=os.environ.get('STOCKVISION_SOURCE_SHA'))
    result={**identity,'status':'dispatched','execution_name':execution.execution_name}
    claim.reload();claim.upload_from_string(json_bytes(result),if_generation_match=claim.generation);return result

from services.paired_nav_read_cache import verified_reads_async

@verified_reads_async
async def resume(input_uri, *, nodes, merge, client=None, postwrite_only=False):
    b=bucket(client);root='gs://'+b.name+'/'
    if not input_uri.startswith(root):raise ValueError('premarket_input_bucket_mismatch')
    body=json.loads(b.blob(input_uri[len(root):]).download_as_bytes());receipt,context=body['receipt'],body['context']
    completed_only=os.environ.get('PIPELINE_PREMARKET_COMPLETED_ONLY')=='1'
    if completed_only:
        if postwrite_only or tuple(n.__name__ for n in nodes)!=SERVING_PHASES:
            raise ValueError('premarket_terminal_reconciliation_phases_invalid')
        p=prefix(receipt['run_date'],receipt['run_id'])
        if not all(b.blob(p+'/phases/'+name+'.json.gz').exists() for name in SERVING_PHASES):
            raise ValueError('premarket_terminal_reconciliation_incomplete')
    if postwrite_only or completed_only:
        # Research cannot open a second allocation window. Validate the sealed
        # capture time, then require both serving phase receipts before work.
        captured=datetime.fromisoformat(context['cutoff'].replace('Z','+00:00'))
        validate_context(receipt,context,now=captured+timedelta(seconds=1))
    else:
        validate_context(receipt,context)
    if receipt != read_seal(receipt['run_date'],receipt['run_id'],client=client):
        raise ValueError('premarket_seal_mismatch')
    # A full phase checkpoint already includes every preceding phase. Restore
    # only the latest contiguous one; do not decode all prior large snapshots.
    p=prefix(receipt['run_date'],receipt['run_id'])
    completed = 0
    gap = False
    for node in nodes:
        present = b.blob(p+'/phases/'+node.__name__+'.json.gz').exists()
        if present and gap:
            raise ValueError('premarket_phase_checkpoint_gap')
        if present:
            completed += 1
        else:
            gap = True
    if completed:
        phase_key = p+'/phases/'+nodes[completed-1].__name__+'.json.gz'
        state=decode_pipeline_state_envelope(b.blob(phase_key).download_as_bytes())['state']
        if (state.get('run_date') != receipt['run_date']
                or state.get('producer_run_id') != receipt['run_id']
                or (state.get('premarket_context') or {}).get('checksum') != context.get('checksum')):
            raise ValueError('premarket_phase_checkpoint_identity_mismatch')
        source_hash=digest({'predictions':state['predictions'],
            'payload_identity':build_pipeline_payload_identity(state['payloads']),
            'baseline':state['premarket_baseline'],'modal_bundle_checksum':state.get('modal_bundle_checksum')})
        if source_hash != receipt['source_hash'] and (
                any(n.__name__=='node_recommend' for n in nodes[:completed])
                or (postwrite_only and b.blob(p+'/phases/node_recommend.json.gz').exists())):
            # Recommendation legitimately adds these L4-owned fields in place.
            # Strip only those additions from the comparison, not the restored
            # state; every original L3 field must still match its sealed hash.
            downstream={'alpha_context','core_family_evidence','core_family_vote','alpha_allocation'}
            original_predictions={symbol:{k:v for k,v in row.items() if k not in downstream}
                                  for symbol,row in state['predictions'].items()}
            source_hash=digest({'predictions':original_predictions,
                'payload_identity':build_pipeline_payload_identity(state['payloads']),
                'baseline':state['premarket_baseline'],'modal_bundle_checksum':state.get('modal_bundle_checksum')})
        if source_hash != receipt['source_hash']:
            raise ValueError('premarket_phase_checkpoint_source_changed')
    else:
        state=load_state(receipt,client=client)
    if not completed:
        baseline={**state['premarket_baseline'],'l3_snapshot_id':receipt['checksum']}
        delta=build_information_delta(baseline=baseline,current_records=source_records(context['us'],context['news'],captured_at=context['cutoff']),cutoff=context['cutoff'],
            trade_date=context['trade_date'],required_sources=('us-leading','news','taifex-night'),
            max_age_seconds={'us-leading':96*3600,'news':24*3600,'taifex-night':96*3600})
        state['premarket_information']=delta
        state['premarket_context']=context
        state.setdefault('metrics',{})['premarket_information']={k:v for k,v in delta.items() if k!='changes'}
    if postwrite_only:
        if any(node.__name__ not in ('node_compute_sector_flow','node_compute_pit_residual_shadow') for node in nodes):
            raise ValueError('premarket_postwrite_phase_invalid')
        for required in ('node_paired_nav_setup','node_export_dataset_snapshot'):
            if not b.blob(p+'/phases/'+required+'.json.gz').exists():
                raise ValueError('premarket_postwrite_serving_not_sealed:'+required)
    for node in nodes[completed:]:
        if not postwrite_only:validate_context(receipt,context)
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
            from services.pipeline_progress import phase
            async with phase(node.__name__):
                merge(state,await node(state))
            raw=encode_pipeline_state_envelope({'schema_version':STATE_SCHEMA_V2,'state':{k:v for k,v in state.items() if k!='l3_payloads'}})
            immutable(blob,raw,'application/gzip')
        except Exception:
            claim.reload()
            claim.upload_from_string(json_bytes({**identity,'status':'ambiguous' if node.__name__=='node_recommend' else 'failed'}),
                if_generation_match=claim.generation)
            raise
    return state
