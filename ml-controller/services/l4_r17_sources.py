"""R17 four-account source scope; existing read-only native capabilities only."""
from datetime import datetime,timezone
import json
from services.native_paper_sandbox import PrivatePaperStore
from services.paired_nav_journal import digest,encode
from services.l4_r17_session import ARMS,read_event,identity,resolve_state

def corporate_source(reg,objects,*,reader=None,clock=None):
    from services.paper_corporate_source import materialize_corporate_source
    from services.corporate_opening_history import read_corporate_cash_discovery_dates
    symbols=set();outstanding=set();history={}
    for arm in ARMS:
        store=PrivatePaperStore(**resolve_state(objects,reg['states'][arm]),inputs={})
        try:
            symbols.update(r[0] for r in store.db.execute('SELECT symbol FROM paper_positions WHERE account_id=? AND shares>0',(reg['account_id'],)))
            for s,a in store.db.execute('SELECT symbol,action_id FROM paper_corporate_entitlements_v1 WHERE account_id=? AND settled=0',(reg['account_id'],)):
                symbols.add(s);outstanding.add(a)
            def query(sql,args):return [dict(r) for r in store.db.execute(sql,args)]
            owned=read_corporate_cash_discovery_dates(query,account_id=reg['account_id'],
                before_date=reg['session_date'],now=clock() if clock else None)
            for s,dates in owned.items():history.setdefault(s,set()).update(dates);symbols.add(s)
        finally:store.db.close()
    return materialize_corporate_source(session_date=reg['session_date'],
        scope_id='r17-'+digest(reg['identity']),symbols=sorted(symbols),outstanding_action_ids=sorted(outstanding),
        historical_cash_dates={s:sorted(ds) for s,ds in history.items()},objects=objects,reader=reader,clock=clock)

class SourceKV:
    def __init__(self,reg,objects,kv_read,corporate_reader=None,clock=None):
        self.reg,self.objects,self.kv_read,self.corporate_reader,self.clock=reg,objects,kv_read,corporate_reader,clock
    @property
    def source_identity(self):
        return {'owner':'r17-four-arm-market-source','registration':digest(self.reg['identity'])}
    def __call__(self,key):
        if key=='market:corporate_actions:v1:'+self.reg['session_date']:
            return encode(corporate_source(self.reg,self.objects,reader=self.corporate_reader,clock=self.clock)['snapshot'])
        return self.kv_read(key)

def build_captures(*,reg,objects,domain_queries,kv_read,model_predictions,controller_token='',broker_token='',
                   shadow_hmac_secret='',transport=None,clock=None,corporate_reader=None):
    from services.native_paper_source_capture import NativeSourceCapture
    from services.native_paper_read_capabilities import NativeReadCapabilities
    from services.native_paper_debate import NativeCapturedDebate,NativeWorkersAIRead
    from services.llm_debate_client import DEBATE_MODEL_POLICY
    if digest(model_predictions)!=reg.get('model_predictions_checksum'):
        raise ValueError('r17_intraday_frozen_predictions_changed')
    variables=reg['variables']
    if str(variables.get('LIVE_EXECUTION_SHADOW_GUARD_ENABLED','')).lower() in {'1','true','yes','on','enabled'}:
        raise ValueError('r17_external_guard_not_private_owner')
    capture=NativeSourceCapture(objects=objects,domain_queries=domain_queries,
        inference_reads={'native_debate_llm':NativeWorkersAIRead()},clock=clock)
    debate=NativeCapturedDebate(source_capture=capture,max_rounds=2,session_date=reg['session_date'],model_name=DEBATE_MODEL_POLICY)
    capabilities=NativeReadCapabilities(broker_url=variables.get('SHIOAJI_PROXY_URL',''),broker_token=broker_token,
        controller_url=variables.get('ML_CONTROLLER_URL',''),controller_token=controller_token,
        research_url=variables.get('S12_RESEARCH_KBARS_URL',''),shadow_hmac_secret=shadow_hmac_secret,
        shadow_scope=variables.get('LIVE_EXECUTION_SHADOW_SCOPE',''),
        trading_config=reg['configuration']['trading_config'],predictions=model_predictions,
        session_date=reg['session_date'],debate_reader=debate,transport=transport,
        kv_read=SourceKV(reg,objects,kv_read,corporate_reader,clock))
    capture.inference_reads.update(capabilities.registered())
    # Same frozen L3 rescore model in every arm; arm-specific L4 inputs live in
    # four private states. Identical market requests share original observations.
    return {a:capture for a in ARMS}

def close_source_receipt(*,reg,objects,now=None):
    def forbidden(**_):raise ValueError('r17_close_source_backfill_forbidden')
    clock=now or datetime.now(timezone.utc)
    original=corporate_source(reg,objects,reader=forbidden,clock=lambda:clock)
    snapshot=original['snapshot']
    if snapshot.get('blockers'):raise ValueError('r17_corporate_source_blocked')
    _,first=read_event(objects,identity('frame',reg['identity']['experiment'],reg['session_date'],0),header=True)
    _,last=read_event(objects,identity('frame',reg['identity']['experiment'],reg['session_date'],len(reg['schedule'])-1),header=True)
    if first is None or last is None:raise ValueError('r17_native_session_incomplete')
    marks={}
    for arm in ARMS:
        store=PrivatePaperStore(**resolve_state(objects,last['states'][arm]),inputs={})
        try:
            marker=store.db.execute('SELECT source_checksum FROM paper_corporate_sessions_v1 WHERE account_id=? AND session_date=?',
                (reg['account_id'],reg['session_date'])).fetchone()
            consumed=[r['response'] for r in first['inputs'][arm].get('kv_responses',[])
                if r['request']=={'key':'market:corporate_actions:v1:'+reg['session_date']}]
            if marker is None or marker[0]!=snapshot['source_checksum'] or len(consumed)!=1 or json.loads(consumed[0])!=snapshot:
                raise ValueError('r17_original_corporate_marker_mismatch')
        finally:store.db.close()
        result=last['frames'][arm]['result']
        if result['stage']!='snapshot' or result['account_id']!=reg['account_id']:raise ValueError('r17_native_close_identity')
        for s,value in result['valuation']['marks'].items():
            if s in marks and marks[s]!=value:raise ValueError('r17_common_closing_price_mismatch')
            marks[s]=value
    return {'session_date':reg['session_date'],'complete':True,'closed_at':clock.isoformat(),
        'schedule_checksum':digest(reg['schedule']),'corporate_actions_complete':True,
        'corporate_actions':snapshot['actions'],'closing_marks':marks,'corporate_source':original}
