"""Original native receipts + original five-session label convention -> R17 daily report."""
from datetime import datetime,date,time
from zoneinfo import ZoneInfo
import json,math
from services.l4_r17_acceptance import ARMS,primary,seal,digest,finite
from services.native_paper_sandbox import PrivatePaperStore
from services.l4_r17_session import read_event,identity,resolve_state
from services.l4_distribution import digest as model_digest

NAMES={'A':'raw','B':'linear','C':'empirical_bayes','L':'incumbent'}
TW=ZoneInfo('Asia/Taipei')

def label_returns(*,signal_date,calendar,prices,symbols,cutoff):
    """Same contract as l4_forward_materialization: next adj_open to fifth adj_close.

    Date-only adjusted prices mature on the following Taiwan date. Source hashes
    are required and returned; no training data or target refitting is involved.
    """
    if calendar!=sorted(set(calendar)):raise ValueError('exchange_calendar_invalid')
    i=calendar.index(signal_date)
    if i+5>=len(calendar):return {},{'status':'pending','reason':'calendar_not_yet_covers_maturity'}
    start,end=calendar[i+1],calendar[i+5]
    clock=datetime.fromisoformat(cutoff.replace('Z','+00:00'))
    if clock.tzinfo is None:raise ValueError('aware_maturity_clock_required')
    receipt={'entry_date':start,'label_known_date':end,'semantic':'next_adjusted_open_to_fifth_adjusted_close',
        'cutoff':cutoff,'prices':{},'missing':[]}
    if end>=clock.astimezone(TW).date().isoformat():return {},{**receipt,'status':'pending'}
    returns={}
    for s in sorted(set(symbols)):
        first,last=prices.get((start,s),{}),prices.get((end,s),{})
        op,cl=first.get('adj_open'),last.get('adj_close')
        if not finite(op) or not finite(cl) or op<=0 or cl<=0:
            receipt['missing'].append(s);continue
        if not first.get('source_sha256') or not last.get('source_sha256'):raise ValueError('label_provenance_missing')
        returns[s]=cl/op-1
        receipt['prices'][s]={'entry_sha256':first['source_sha256'],'exit_sha256':last['source_sha256']}
    return returns,{**receipt,'status':'incomplete' if receipt['missing'] else 'mature'}

def target_receipts(reg,objects):
    """Target weights must already exist in an immutable preopen native frame."""
    i=next(i for i,f in enumerate(reg['schedule']) if f['stage']=='preopen')
    ref,frame=read_event(objects,identity('frame',reg['identity']['experiment'],reg['session_date'],i),header=True)
    if frame is None:return {},['preopen_frame_missing']
    deadline=datetime.combine(date.fromisoformat(reg['session_date']),time(9),TW)
    if datetime.fromisoformat(frame['captured_at'])>=deadline:return {},['preopen_frame_late']
    if not hasattr(objects,'receipt_clock'):raise ValueError('preopen_server_receipt_clock_required')
    clock=objects.receipt_clock(ref,digest(frame['identity']))
    available=datetime.fromisoformat(clock['available_at'])
    if available.tzinfo is None or clock.get('authority')!='object_store_server':
        raise ValueError('preopen_server_receipt_clock_invalid')
    if available>=deadline:return {},['preopen_receipt_published_late']
    targets={};reasons=[]
    for arm in ARMS:
        db=PrivatePaperStore(**resolve_state(objects,frame['states'][arm]),inputs={})
        try:
            rows=db.db.execute('SELECT p.payload_json FROM l4_portfolio_plans_v1 p '
                'JOIN l4_portfolio_head_v1 h ON h.account_id=p.account_id AND h.plan_id=p.plan_id '
                'WHERE p.account_id=? AND p.signal_date=?',
                (reg['account_id'],reg['signal_date'])).fetchall()
            if not rows:reasons.append(arm+':preopen_target_missing');continue
            if len(rows)!=1:raise ValueError('preopen_target_head_not_unique')
            plan=json.loads(rows[0][0]);proof=plan.get('r16_evidence',{})
            if (plan.get('plan_id')!=model_digest({k:v for k,v in plan.items() if k!='plan_id'})
                or proof.get('forecast_checksum')!=reg['forecast']['checksum']
                or proof.get('comparison_arm')!=NAMES[arm]):
                raise ValueError('target_arm_or_forecast_mismatch')
            timing=[]
            for j in range(i+1):
                _,item=read_event(objects,identity('frame',reg['identity']['experiment'],reg['session_date'],j),header=True)
                timing.extend(x for x in (item or {}).get('execution_metrics',{}).get(arm,[]) if x.get('plan_id')==plan['plan_id'])
            if not timing:reasons.append(arm+':solve_timing_missing');continue
            targets[arm]={'preopen_receipt_sha':ref.split('/')[-1].removesuffix('.json'),
                'preopen_server_receipt':clock,
                'plan_sha':plan['plan_id'],'weights':plan['weights'],
                'solve_success':plan.get('proof',{}).get('within_tolerance') is True,
                'solve_seconds':timing[-1]['solve_seconds'],'solve_status':timing[-1]['status']}
        finally:db.db.close()
    return targets,reasons

def top10(forecast,arm):
    values=forecast['incumbent']['gross'] if arm=='L' else forecast['arms'][NAMES[arm]]
    return [s for s,v in sorted(zip(forecast['symbols'],values,strict=True),key=lambda v:(-v[1],v[0]))[:10]]

def materialize(*,registration_ref,close_ref,objects,prices,cutoff,previous_forecast=None,calendar=None):
    reg,closed=objects.get(registration_ref),objects.get(close_ref)
    if closed['registration_ref']!=registration_ref or closed['activation_checksum']!=reg['activation_checksum']:
        raise ValueError('native_close_binding')
    if calendar is not None:
        if ([d for d in calendar if d<=reg['session_date']]
                !=[d for d in reg['calendar'] if d<=reg['session_date']]):
            raise ValueError('historical_exchange_calendar_changed')
        reg={**reg,'calendar':calendar}
    targets,reasons=target_receipts(reg,objects)
    if closed.get('execution_gaps'):reasons.append('native_execution_intervals_missing')
    pool=reg['forecast']['symbols'];held={s for a in closed['accounts'].values() for s,q in a['positions'].items() if q>0}
    target_symbols={s for target in targets.values() for s,w in target['weights'].items() if w>0}
    returns,label=label_returns(signal_date=reg['signal_date'],calendar=reg['calendar'],prices=prices,
        symbols=set(pool)|held|target_symbols,cutoff=cutoff)
    z=dict(zip(pool,reg['forecast']['z'],strict=True));reports={}
    for arm in ARMS:
        account=closed['accounts'][arm];marks=closed['source_receipt']['closing_marks']
        values={s:q*marks[s] for s,q in account['positions'].items() if q>0}
        total=sum(values.values());weights={s:v/account['nav'] for s,v in values.items()} if account['nav']>0 else {}
        target_weights=targets.get(arm,{}).get('weights',{})
        stats=primary(target_weights,returns,pool) if label['status']=='mature' and arm in targets else {'exposure':sum(target_weights.values()),'primary':None}
        actual=primary(weights,returns,pool) if label['status']=='mature' else {'exposure':sum(weights.values()),'primary':None}
        store=PrivatePaperStore(**closed['states'][arm],inputs={})
        age_sum=0.;age_complete=True;holdings=[]
        try:
            entry_dates={row['symbol']:row['entry_date'] for row in store.db.execute(
                'SELECT symbol,entry_date FROM paper_positions WHERE account_id=? AND shares>0',(reg['account_id'],))}
        finally:store.db.close()
        for s,value in values.items():
            entry=str(entry_dates.get(s,''))[:10]
            age=reg['calendar'].index(reg['session_date'])-reg['calendar'].index(entry)+1 if entry in reg['calendar'] else None
            if age is None:age_complete=False
            else:age_sum+=value*age
            holdings.append({'symbol':s,'weight':weights[s],'market_value':value,'trading_days':age,'z':z.get(s)})
        before={s for s,q in reg['opening_accounts'][arm]['positions'].items() if q>0}
        after=set(values);entries=sorted(after-before);exits=sorted(before-after)
        old_top=top10(previous_forecast,arm) if previous_forecast else None
        adjacent=previous_forecast is not None and reg['calendar'].index(reg['signal_date'])>0 and previous_forecast['signal_date']==reg['calendar'][reg['calendar'].index(reg['signal_date'])-1]
        reports[arm]={**stats,**targets.get(arm,{}),'native_receipt_sha':close_ref.split('/')[-1].removesuffix('.json'),
            'primary_weight_source':'immutable_preopen_targets','target_weights':target_weights,
            'actual_holding_attribution':{**actual,'semantic':'post_execution_attribution_not_primary'},
            'data_complete':label['status']=='mature' and age_complete and not closed.get('execution_gaps'),'holdings':holdings,
            'holding_age_value_sum':age_sum if age_complete else None,'holding_market_value':total,
            'holding_trading_days':age_sum/total if total>0 and age_complete else None,
            'entries':entries,'exits':exits,'replacement_pairs':min(len(entries),len(exits)),
            'traded_notional':sum(f['shares']*f['price'] for f in closed['fills'][arm]),
            'top10':top10(reg['forecast'],arm),'top10_adjacent_overlap':len(set(old_top)&set(top10(reg['forecast'],arm))) if adjacent else None}
        failures=[{'index':gap['index'],'stage':gap['stage'],'reason':gap['failed_arms'][arm]}
                  for gap in closed.get('execution_gaps',[]) if arm in gap.get('failed_arms',{})]
        if failures:
            reports[arm].update(preopen_solve_success=reports[arm].get('solve_success'),
                solve_success=False,solve_status='failed',solve_failures=failures)
    return seal({'schema':'r17-daily-report-v1','signal_date':reg['signal_date'],'session_date':reg['session_date'],
        'rules_sha':reg['rules_sha'],'activation_checksum':reg['activation_checksum'],'arms':reports,
        'weight_timing_sha':reg['weight_timing_sha'],
        'D':{'pool_equal_weight_return':sum(returns[s] for s in pool)/len(pool) if label['status']=='mature' else None},
        'label_status':label['status'],'label_receipt':label,'exclusion_reasons':reasons,
        'execution_gaps':closed.get('execution_gaps',[]),
        'primary_weight_sample':'preopen_sealed_targets','actual_holding_sample':'entry_session_native_close',
        'return_convention':'signal_next_adj_open_to_fifth_adj_close',
        'registration_ref':registration_ref,'close_ref':close_ref,'online_switch_allowed':False})
