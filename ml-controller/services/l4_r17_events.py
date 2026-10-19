"""Explicit R17 event adapter. Writes only immutable private objects.

The host supplies authenticated source readers, a verified exchange calendar,
and the frozen activation. No fallback to current model/configuration pointers.
"""
from datetime import datetime,timezone
from services.paired_nav_journal import digest,_timestamp
from services.l4_r17_session import ARMS,identity,read_event,read_header,publish,collect,close
from services.native_paper_time import frame_capture_deadline
from services.l4_r17_acceptance import seal,evaluate
from services.l4_r17_reporting import materialize,target_receipts


def execution_tick(*,registration_ref,objects,runner,capture_factory,source_receipt_factory,clock=None,
                   recover_sealed=False):
    clock=clock or (lambda:datetime.now(timezone.utc))
    reg=read_header(objects,registration_ref);exp=reg['identity']['experiment'];day=reg['session_date']
    done_ref,done=read_event(objects,identity('close',exp,day))
    if done is not None:
        return {'status':'closed','close_ref':done_ref,'outer_credit':0}
    captures=None;completed=0
    # Published frames form a contiguous prefix: collect refuses a missing
    # predecessor. Locate its boundary using small aliases, not 281 SQL states
    # on every minute tick. Verify the actual boundary before trusting it.
    locate=getattr(objects,'lookup_delivery_address',objects.lookup_delivery)
    low,high=0,len(reg['schedule'])
    while low<high:
        middle=(low+high)//2
        if locate(digest(identity('frame',exp,day,middle))) is None:high=middle
        else:low=middle+1
    completed=low
    if completed:
        _,boundary=read_event(objects,identity('frame',exp,day,completed-1),header=True)
        if boundary is None or boundary['registration_ref']!=registration_ref:
            raise ValueError('r17_execution_frontier_binding')
    for i in range(completed,len(reg['schedule'])):
        frame=reg['schedule'][i]
        old,_=read_event(objects,identity('frame',exp,day,i))
        if old is not None:
            completed+=1;continue
        now=clock()
        if now<_timestamp(frame['observed_at']):break
        if now>=frame_capture_deadline(frame) and not recover_sealed:
            # Continuing would require inventing a historical execution. Keep
            # last exact private state and require source/continuity recovery.
            return {'status':'execution_gap','missing_index':i,'completed':completed,
                    'reason':'expired_unobserved_native_frame','outer_credit':0}
        if captures is None:captures=capture_factory(reg)
        try:
            collect(registration_ref=registration_ref,index=i,objects=objects,
                    capture_by_arm=captures,runner=runner,now=now,recover=recover_sealed)
        except ValueError as exc:
            if str(exc)!='r17_recovery_original_read_missing':raise
            if frame['stage'] in {'morning','preopen','intraday','rescore','eod'}:
                from services.l4_r17_session import record_unobserved_interval
                record_unobserved_interval(registration_ref=registration_ref,index=i,objects=objects,now=now)
                completed+=1
                continue
            return {'status':'execution_gap','missing_index':i,'completed':completed,
                    'reason':str(exc),'outer_credit':0}
        completed+=1
    if completed!=len(reg['schedule']):
        return {'status':'collecting','completed':completed,'outer_credit':0}
    result=close(registration_ref=registration_ref,objects=objects,runner=runner,
                 source_receipt=source_receipt_factory(reg),now=clock())
    return {'status':'closed','completed':completed,'close_ref':result,'outer_credit':0}


def excluded_day(*,signal_date,session_date,activation,reason,targets=None,label_status='incomplete'):
    """Missing attempt remains visible in the solve-rate denominator."""
    return seal({'schema':'r17-daily-report-v1','signal_date':signal_date,'session_date':session_date,
        'rules_sha':activation['rules_sha'],'weight_timing_sha':activation['weight_timing_sha'],
        'activation_checksum':activation['checksum'],'primary_weight_sample':'preopen_sealed_targets',
        'label_status':label_status,'exclusion_reasons':[reason],
        'arms':{a:{**(targets or {}).get(a,{}),'data_complete':False,'exposure':None,
                   'primary':None,'native_receipt_sha':None} for a in ARMS},
        'D':{'pool_equal_weight_return':None},'online_switch_allowed':False})


def maturity_tick(*,experiment,activation,calendar,objects,prices,cutoff,calendar_proof):
    """Census every scheduled date, including missing registrations and failures.

    Prices/calendar must come from load_prices' checksum-verified producer
    reference. Historical calendars may extend; prior session dates cannot change.
    Recomputed pending views are never counted as immutable mature evidence.
    """
    if not calendar_proof:raise ValueError('r17_official_price_calendar_proof_missing')
    if calendar!=sorted(set(calendar)):raise ValueError('r17_calendar_invalid')
    first=activation['first_session_date']
    if first not in calendar:raise ValueError('r17_calendar_missing_first_session')
    start=calendar.index(first)
    if start==0:raise ValueError('r17_calendar_missing_first_signal')
    now=_timestamp(cutoff);reports=[];previous_forecast=None
    for i in range(start,len(calendar)):
        session=calendar[i];signal=calendar[i-1]
        from zoneinfo import ZoneInfo
        if session>=now.astimezone(ZoneInfo('Asia/Taipei')).date().isoformat():break
        key=identity('mature_report',experiment,signal)
        old_ref,old=read_event(objects,key)
        reg_ref,reg=read_event(objects,identity('registration',experiment,session))
        if old is not None:
            report=old['report']
        else:
            close_ref,closed=read_event(objects,identity('close',experiment,session))
            if reg is None:
                report=excluded_day(signal_date=signal,session_date=session,activation=activation,
                                    reason='registration_missing_before_session')
            elif closed is None:
                targets,_=target_receipts(reg,objects)
                from services.l4_r17_reporting import label_returns
                _,label=label_returns(signal_date=signal,calendar=calendar,prices={},symbols=[],cutoff=cutoff)
                report=excluded_day(signal_date=signal,session_date=session,activation=activation,
                                    reason='native_close_receipt_missing',targets=targets,
                                    label_status='pending' if label['status']=='pending' else 'incomplete')
            else:
                report=materialize(registration_ref=reg_ref,close_ref=close_ref,objects=objects,
                    prices=prices,cutoff=cutoff,previous_forecast=previous_forecast,calendar=calendar)
            if report['label_status']!='pending':
                publish(objects,key,{'identity':key,'report':report,'price_calendar_proof':calendar_proof,
                                     'materialized_at':cutoff,'production_effect':False})
        reports.append(report)
        previous_forecast=reg['forecast'] if reg else None
        decision=evaluate(reports,rules_sha=activation['rules_sha'],
            weight_timing_sha=activation['weight_timing_sha'],activation_checksum=activation['checksum'])
        if decision['count']==20:break
    decision=evaluate(reports,rules_sha=activation['rules_sha'],
        weight_timing_sha=activation['weight_timing_sha'],activation_checksum=activation['checksum'])
    return {'daily':reports,'acceptance':decision,'production_effect':False}


def on_price_capture(*,bucket,price_capture,activation,experiment,objects,cutoff):
    from services.l4_forward_refresh import load_prices
    from zoneinfo import ZoneInfo
    cutoff_day=_timestamp(cutoff).astimezone(ZoneInfo('Asia/Taipei')).date().isoformat()
    calendar,prices,proof=load_prices(bucket,price_capture,
        start=activation['first_signal_date'],cutoff_day=cutoff_day)
    return maturity_tick(experiment=experiment,activation=activation,calendar=calendar,objects=objects,
                         prices=prices,cutoff=cutoff,calendar_proof=proof)
