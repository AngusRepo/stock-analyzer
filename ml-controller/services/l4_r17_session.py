"""Four independent R17 accounts using the existing native Worker engine.

Immutable object storage owns retries and carry. No fill simulation, no model
training, no production account writes. Deployment/event adapters are separate.
"""
from datetime import datetime,timezone
import time
from services.paired_nav_journal import digest,_timestamp,replay_session
from services.native_paper_sandbox import run_native_paper_frames,PrivatePaperStore,native_execution_identity
from services.paired_native_session import session_schedule,STRATEGY_SESSION_POLICY,native_fills,validate_native_account
from services.native_paper_time import frame_capture_deadline

ARMS=('A','B','C','L')

def identity(kind,experiment,day,index=None):
    return {'schema':'r17-native-event-v1','kind':kind,'experiment':experiment,'day':day,'index':index}

def publish(objects,key,value):
    ref=objects.put(value)
    if objects.publish_delivery(digest(key),ref)!=ref:raise ValueError('r17_concurrent_event_conflict')
    verified=(objects.verify_payload(ref,value) if hasattr(objects,'verify_payload') else objects.get(ref)==value)
    if not verified:raise ValueError('r17_readback_mismatch')
    return ref

def read_event(objects,key,*,header=False):
    ref=getattr(objects,'lookup_delivery_address',objects.lookup_delivery)(digest(key))
    if ref is None:return None,None
    value=(objects.get_header(ref) if header and hasattr(objects,'get_header') else objects.get(ref))
    if value['identity']!=key:raise ValueError('r17_event_identity_mismatch')
    return ref,value


def read_header(objects,ref):return getattr(objects,'get_header',objects.get)(ref)


def resolve_state(objects,state):return objects.resolve_state(state) if hasattr(objects,'resolve_state') else state

def register(*,experiment,signal_date,session_date,activation,forecast,states,opening_accounts,
             configuration,variables,source_tables,calendar,objects,runner,account_id,now=None,previous=None,
             model_predictions=None,source_evidence_ref=None):
    """Prepared states must come from original prepare_native_state per account.

    All targets still require their actual morning allocation receipt before open.
    A registration alone grants no eligible outer date.
    """
    clock=now or datetime.now(timezone.utc)
    if clock.tzinfo is None:raise ValueError('r17_aware_clock_required')
    if activation['checksum']!=digest({k:v for k,v in activation.items() if k!='checksum'}):
        raise ValueError('r17_activation_checksum')
    if activation.get('engineering_verified') is not True:raise ValueError('r17_engineering_incomplete')
    if (activation.get('primary_weight_sample')!='preopen_sealed_targets'
            or not activation.get('weight_timing_sha')):
        raise ValueError('r17_weight_timing_seal_required')
    if not _timestamp(activation['sealed_at'])<_timestamp(forecast['captured_at'])<=clock:
        raise ValueError('r17_signal_before_activation')
    from services.l4_distribution import digest as model_digest
    if forecast['checksum']!=model_digest({k:v for k,v in forecast.items() if k!='checksum'}):
        raise ValueError('r17_forecast_checksum')
    if forecast['signal_date']!=signal_date or forecast['model_checksum']!=activation['model_checksum']:
        raise ValueError('r17_forecast_identity')
    if digest(configuration)!=activation['configuration_checksum']:
        raise ValueError('r17_frozen_configuration_changed')
    if set(states)!=set(ARMS) or set(opening_accounts)!=set(ARMS):raise ValueError('r17_four_accounts_required')
    if signal_date not in calendar or calendar[calendar.index(signal_date)+1]!=session_date:
        raise ValueError('r17_next_exchange_session_required')
    schedule=session_schedule(session_date,policy=STRATEGY_SESSION_POLICY)
    if clock>=_timestamp(schedule[0]['observed_at']):raise ValueError('r17_registration_too_late')
    owner=native_execution_identity(runner)
    if activation['execution_owner']!=owner:raise ValueError('r17_frozen_execution_changed')
    predecessor=None
    if previous:
        predecessor,prior=read_event(objects,identity('close',experiment,previous))
        if prior is None:raise ValueError('r17_carry_missing')
        if calendar[calendar.index(previous)+1]!=session_date:raise ValueError('r17_carry_calendar_gap')
        if prior['activation_checksum']!=activation['checksum']:raise ValueError('r17_carry_experiment_changed')
        if opening_accounts!=prior['accounts']:raise ValueError('r17_opening_account_reset')
        # prepare_native_state may update recommendations/config, never cash,
        # positions, orders or settlements. Compare the account-owned tables.
        for arm in ARMS:
            before=account_rows(prior['states'][arm],account_id)
            after=account_rows(states[arm],account_id)
            if before!=after:raise ValueError('r17_private_carry_reset')
    elif activation['first_session_date']!=session_date:
        raise ValueError('r17_missing_previous_session_cannot_bootstrap')
    normalized_states={}
    for arm in ARMS:
        private=PrivatePaperStore(**states[arm],inputs={})
        try:
            row=private.db.execute('SELECT value FROM _native_private_kv WHERE key=?',('trading:config',)).fetchone()
            import json
            expected=configuration.get('arm_trading_configs',{}).get(arm,configuration['trading_config'])
            if row is None or json.loads(row[0])!=expected:
                raise ValueError('r17_private_config_mismatch')
            if expected.get('l4Distribution'):
                frozen=private.db.execute("SELECT value FROM _native_private_kv WHERE key='l4:private_allocation_inputs'").fetchone()
                if frozen is None:raise ValueError('r17_private_forecast_missing')
                payload=json.loads(frozen[0])['inputs'];bound=payload.get('r16_shadow') or {}
                from services.l4_r17_configuration import arm_trading_config,NAMES
                if bound.get('arm')!=NAMES[arm] or bound.get('forecast')!=forecast:
                    raise ValueError('r17_private_arm_forecast_mismatch')
                computed=arm_trading_config(configuration['trading_config'],
                    allocation_policy=payload['alpha_policy']['l4Distribution'],forecast=forecast,arm=arm)
                if expected!=computed:raise ValueError('r17_private_execution_identity_mismatch')
            normalized_states[arm]=private.export()
        finally:private.db.close()
    states=normalized_states
    key=identity('registration',experiment,session_date)
    record={'identity':key,'signal_date':signal_date,'session_date':session_date,
        'activation_checksum':activation['checksum'],'rules_sha':activation['rules_sha'],
        'weight_timing_sha':activation['weight_timing_sha'],
        'forecast':forecast,'states':states,'opening_accounts':opening_accounts,
        'source_evidence_ref':source_evidence_ref,
        'configuration':configuration,'variables':variables,'source_tables':source_tables,
        'execution_owner':owner,'account_id':account_id,'schedule':schedule,
        'predecessor':predecessor,'calendar':calendar,'registered_at':clock.isoformat(),
        'model_predictions_checksum':digest(model_predictions) if model_predictions is not None else None,
        'account_namespaces':{a:experiment+':'+a for a in ARMS},'production_effect':False}
    return publish(objects,key,record)

def account_rows(state,account_id):
    store=PrivatePaperStore(**state,inputs={})
    try:
        tables={'paper_accounts':'id','paper_positions':'account_id','paper_orders':'account_id','paper_settlements':'account_id'}
        return {t:[dict(r) for r in store.db.execute(f'SELECT * FROM {t} WHERE {column}=? ORDER BY id',(account_id,))] for t,column in tables.items()}
    finally:store.db.close()

def collect(*,registration_ref,index,objects,capture_by_arm,runner,now=None,recover=False):
    reg=read_header(objects,registration_ref);experiment=reg['identity']['experiment'];day=reg['session_date']
    if not isinstance(index,int) or not 0<=index<len(reg['schedule']):raise ValueError('r17_frame_index')
    key=identity('frame',experiment,day,index);ref,existing=read_event(objects,key)
    if existing is not None:
        if existing['registration_ref']!=registration_ref:raise ValueError('r17_registration_changed')
        return ref # immutable retry even after deadline
    clock=now or datetime.now(timezone.utc);frame=reg['schedule'][index]
    expired=clock>=frame_capture_deadline(frame)
    if clock<_timestamp(frame['observed_at']) or (expired and not recover):
        raise ValueError('r17_frame_not_due_or_expired')
    previous_ref=None;states=reg['states']
    if index:
        previous_ref,previous=read_event(objects,identity('frame',experiment,day,index-1),header=True)
        if previous is None:raise ValueError('r17_frame_gap')
        states=previous['states']
    outputs={}
    for arm in ARMS:
        current_state=resolve_state(objects,states[arm])
        arm_key=identity('frame_arm_'+arm,experiment,day,index)
        _,saved=read_event(objects,arm_key)
        if saved is not None:
            if (saved['registration_ref']!=registration_ref or saved['previous_ref']!=previous_ref
                    or saved['initial_state_checksum']!=current_state['state_checksum']):
                raise ValueError('r17_recovered_arm_binding_changed')
            outputs[arm]={**saved['output'],**{k:saved[k] for k in ('state_sql','state_checksum') if k in saved}}
            continue
        capture=capture_by_arm[arm]
        if expired:
            from services.l4_r17_recovery import SealedSourceReplay
            capture=SealedSourceReplay(capture,objects)
        inputs={frame['input_id']:{**frame,'source_tables':reg['source_tables'],
            'capture_kv_reads':True,'kv_read_policy':reg['configuration']['kv_read_policy']}}
        started=time.monotonic()
        try:
            outputs[arm]=run_native_paper_frames(**current_state,frame_inputs=inputs,frames=[frame],
                account_id=reg['account_id'],variables=reg['variables'],runner=runner,
                expected_execution_owner_version=reg['execution_owner'],capture_source=capture,clock_normalized=True)
        except RuntimeError as exc:
            # The private host rolls the failed frame transaction back. Record
            # that actual failed attempt, preserve its predecessor and continue
            # the other arms. Never use an uncertified target as a trade plan.
            code='l4_portfolio_optimality_not_certified'
            if (frame['stage'] not in {'morning','preopen','rescore'} or
                    not str(exc).startswith('native_paper_private_ValueError:'+code)):
                raise
            outputs[arm]={**current_state,'frames':[None],
                'captured_inputs':{frame['input_id']:None},'allocation_failure':code,
                'execution_metrics':[{'status':'failed','reason':code,'solve_seconds':time.monotonic()-started}]}
        if expired:capture.verify()
        publish(objects,arm_key,{'identity':arm_key,'registration_ref':registration_ref,
            'previous_ref':previous_ref,'initial_state_checksum':current_state['state_checksum'],
            'state_sql':outputs[arm]['state_sql'],'state_checksum':outputs[arm]['state_checksum'],
            'output':{k:v for k,v in outputs[arm].items() if k not in ('state_sql','state_checksum')},
            'production_effect':False})
    result={'identity':key,'registration_ref':registration_ref,'previous_ref':previous_ref,
        'states':{a:{k:outputs[a][k] for k in ('state_sql','state_checksum')} for a in ARMS},
        'frames':{a:outputs[a]['frames'][0] for a in ARMS},
        'inputs':{a:outputs[a]['captured_inputs'][frame['input_id']] for a in ARMS},
        'execution_metrics':{a:outputs[a].get('execution_metrics',[]) for a in ARMS},
        'failed_arms':{a:outputs[a]['allocation_failure'] for a in ARMS if outputs[a].get('allocation_failure')},
        'captured_at':clock.isoformat(),'production_effect':False}
    return publish(objects,key,result)

def close(*,registration_ref,objects,runner,source_receipt,now=None):
    reg=read_header(objects,registration_ref);experiment=reg['identity']['experiment'];day=reg['session_date']
    key=identity('close',experiment,day);old_ref,old=read_event(objects,key)
    if old is not None:return old_ref
    clock=now or datetime.now(timezone.utc)
    if _timestamp(reg['schedule'][-1]['observed_at'])>clock:raise ValueError('r17_session_not_closed')
    if (source_receipt.get('complete') is not True or source_receipt.get('session_date')!=day
        or source_receipt.get('schedule_checksum')!=digest(reg['schedule'])
        or source_receipt.get('corporate_actions_complete') is not True):
        raise ValueError('r17_complete_original_sources_required')
    records=[];previous_ref=None
    for i,frame in enumerate(reg['schedule']):
        ref,record=read_event(objects,identity('frame',experiment,day,i),header=True)
        if record is None or record['previous_ref']!=previous_ref or record['registration_ref']!=registration_ref:
            raise ValueError('r17_full_frame_chain_required')
        records.append(record);previous_ref=ref
    accounts={};fills={};states={}
    gaps=[{'index':i,'stage':reg['schedule'][i]['stage'],
           'unobserved_arms':r.get('unobserved_arms',[]),'failed_arms':r.get('failed_arms',{})}
          for i,r in enumerate(records) if r.get('unobserved_arms') or r.get('failed_arms')]
    for arm in ARMS:
        observed=[(frame,record) for frame,record in zip(reg['schedule'],records,strict=True)
                  if record['frames'][arm] is not None]
        inputs={frame['input_id']:record['inputs'][arm] for frame,record in observed}
        initial=resolve_state(objects,reg['states'][arm]);final=resolve_state(objects,records[-1]['states'][arm])
        replay=run_native_paper_frames(**initial,frame_inputs=inputs,frames=[f for f,r in observed],
            account_id=reg['account_id'],variables=reg['variables'],runner=runner,
            expected_execution_owner_version=reg['execution_owner'],clock_normalized=True)
        if replay['state_checksum']!=final['state_checksum']:
            raise ValueError('r17_native_replay_state_mismatch')
        fills[arm]=native_fills(replay['frames'],reg['account_id'])
        account=replay_session(previous=reg['opening_accounts'][arm],fills=fills[arm],
            marks=source_receipt['closing_marks'],corporate_actions=source_receipt['corporate_actions'],
            session_date=day,fees=reg['configuration']['fees'],
            cash_history=source_receipt.get('cash_history'),
            commission_contract=reg['configuration'].get('commission_contract'))
        validate_native_account(replay['frames'][-1]['result']['valuation'],account)
        accounts[arm]=account;states[arm]=final
    result={'identity':key,'registration_ref':registration_ref,'activation_checksum':reg['activation_checksum'],
        'rules_sha':reg['rules_sha'],'signal_date':reg['signal_date'],'accounts':accounts,'fills':fills,
        'states':states,'source_receipt':source_receipt,'closed_at':clock.isoformat(),'last_frame_ref':previous_ref,
        'execution_gaps':gaps,'production_effect':False,'outer_credit':0,
        'status':'native_continuity_verified_excluded' if gaps else 'native_session_verified_labels_pending'}
    return publish(objects,key,result)


def record_unobserved_interval(*,registration_ref,index,objects,now):
    """Continue an excluded shadow day without fabricating missing executions.

    Missing trading opportunities may be omitted, never reconstructed. Missing
    morning/preopen targets invalidate the outer day. Corporate opening and
    closing valuation still need native accounting proof.
    Successfully checkpointed arms retain their actual executions.
    """
    reg=objects.get(registration_ref);frame=reg['schedule'][index]
    if frame['stage'] not in {'morning','preopen','intraday','rescore','eod'} or now<frame_capture_deadline(frame):
        raise ValueError('r17_required_frame_cannot_be_omitted')
    exp=reg['identity']['experiment'];day=reg['session_date']
    key=identity('frame',exp,day,index);old,value=read_event(objects,key)
    if value is not None:return old
    previous_ref,previous=read_event(objects,identity('frame',exp,day,index-1))
    if previous is None:raise ValueError('r17_frame_gap')
    states={};frames={};inputs={};metrics={};missing=[];failed={}
    for arm in ARMS:
        _,saved=read_event(objects,identity('frame_arm_'+arm,exp,day,index))
        if saved is not None:
            if (saved['registration_ref']!=registration_ref or saved['previous_ref']!=previous_ref
                    or saved['initial_state_checksum']!=previous['states'][arm]['state_checksum']):
                raise ValueError('r17_recovered_arm_binding_changed')
            output=saved['output']
            states[arm]={k:saved[k] for k in ('state_sql','state_checksum')}
            frames[arm]=output['frames'][0];inputs[arm]=output['captured_inputs'][frame['input_id']]
            metrics[arm]=output.get('execution_metrics',[])
            if output.get('allocation_failure'):failed[arm]=output['allocation_failure']
        else:
            states[arm]=previous['states'][arm];frames[arm]=None;inputs[arm]=None;metrics[arm]=[]
            missing.append(arm)
    return publish(objects,key,{'identity':key,'registration_ref':registration_ref,'previous_ref':previous_ref,
        'states':states,'frames':frames,'inputs':inputs,'execution_metrics':metrics,
        'unobserved_arms':missing,'failed_arms':failed,'reason':'expired_original_source_missing_no_execution',
        'captured_at':now.isoformat(),'production_effect':False,'outer_credit':0})
