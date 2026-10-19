"""Authenticated P4 host: fixed model, daily registration, execution and labels.

The only activation pointer is an explicit deployment environment reference.
No model pointer, trading configuration or production account is ever written.
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import asyncio
import os
from services.paired_nav_journal import digest, _timestamp
from services.l4_r17_session import identity, read_event, publish
from services.l4_r17_events import execution_tick, on_price_capture

RULES_SHA='e8361d229e7810f45ea693f62acdd04f57c3f037e4c2be9edf78c5504eb0cb3d'
TIMING_SHA='be97f6c8b6105eaeac7436ee570aa568d00671686fb8cf8f8f0cc546914ac7f9'
TW=ZoneInfo('Asia/Taipei')


def load_activation(objects, reference, *, runner=None):
    from services.native_paper_sandbox import native_execution_identity
    activation=objects.get(reference)
    if (activation.get('schema')!='r17-p4-activation-v1'
            or activation.get('checksum')!=digest({k:v for k,v in activation.items() if k!='checksum'})
            or activation.get('rules_sha')!=RULES_SHA or activation.get('weight_timing_sha')!=TIMING_SHA
            or activation.get('primary_weight_sample')!='preopen_sealed_targets'
            or activation.get('execution_owner')!=native_execution_identity(runner)):
        raise ValueError('r17_activation_binding')
    proof=objects.receipt_clock(reference,digest(activation['identity']))
    if (proof['authority']!='object_store_server'
            or _timestamp(proof['available_at']).astimezone(TW).date().isoformat()>activation['first_signal_date']):
        raise ValueError('r17_activation_not_before_first_signal')
    setup=objects.get(activation['setup_ref'])
    engineering=objects.get(activation['engineering_ref'])
    from services.l4_r17_activation import implementation_identity,engineering_verified
    code=implementation_identity()
    if (not engineering_verified(engineering,code,activation['execution_owner'])
            or activation.get('implementation_checksum')!=code
            or digest(setup['configuration'])!=activation['configuration_checksum']
            or digest(getattr(objects,'get_header',objects.get)(setup['bootstrap_ref']))
                !=activation.get('bootstrap_header_checksum')):
        raise ValueError('r17_engineering_or_setup_not_verified')
    return activation,setup


class Host:
    def __init__(self, *, objects, bucket, activation, setup, domains, kv_read,
                 runner=None, clock=None, capture_factory=None):
        self.objects,self.bucket,self.activation,self.setup=objects,bucket,activation,setup
        self.domains,self.kv_read,self.runner=domains,kv_read,runner
        self.clock=clock or (lambda:datetime.now(timezone.utc))
        self.experiment=activation['experiment']
        self.capture_factory=capture_factory or self.captures

    def captures(self, reg):
        from services.l4_r17_sources import build_captures
        daily=self.objects.get(reg['source_evidence_ref'])
        return build_captures(reg=reg,objects=self.objects,domain_queries=self.domains,
            kv_read=self.kv_read,model_predictions=daily['model_predictions'],clock=self.clock,
            controller_token=os.environ.get('ML_CONTROLLER_SECRET',''),
            broker_token=os.environ.get('PROXY_SERVICE_TOKEN') or os.environ.get('SHIOAJI_PROXY_TOKEN',''),
            shadow_hmac_secret=os.environ.get('LIVE_EXECUTION_HMAC_SECRET',''))

    def tick(self, day):
        from services.l4_r17_sources import close_source_receipt
        ref,reg=read_event(self.objects,identity('registration',self.experiment,day),header=True)
        if reg is None:return {'status':'awaiting_registration','session_date':day,'outer_credit':0}
        if reg['activation_checksum']!=self.activation['checksum']:
            raise ValueError('r17_tick_activation_changed')
        return execution_tick(registration_ref=ref,objects=self.objects,runner=self.runner,
            capture_factory=self.capture_factory,
            source_receipt_factory=lambda r:close_source_receipt(reg=r,objects=self.objects,now=self.clock()),
            clock=self.clock,recover_sealed=True)

    def prices(self, day):
        from services.l4_forward_refresh import current_price_capture,load_prices
        capture,proof=current_price_capture(self.bucket,day,cutoff=self.clock().isoformat())
        calendar,_,_=load_prices(self.bucket,capture,start=self.activation['first_signal_date'],cutoff_day=day)
        return capture,calendar,proof

    def mature(self, day):
        capture,calendar,_=self.prices(day)
        if self.activation['first_session_date'] not in calendar and (
                not calendar or max(calendar)<self.activation['first_session_date']):
            return {'status':'pending','reason':'r17_first_session_not_yet_observed',
                    'daily':[],'acceptance':{'count':0},'production_effect':False}
        result=on_price_capture(bucket=self.bucket,price_capture=capture,activation=self.activation,
            experiment=self.experiment,objects=self.objects,cutoff=self.clock().isoformat())
        return result

    async def daily(self, day):
        from services.l4_r17_forecast import on_signal_observation
        from services.l4_r17_context import canonical_context,prepare
        from services.l4_r17_registration import register_signal
        from services.l4_native_observation import read_reference
        from services.paired_native_registration import next_session
        from services.paired_native_runtime import KV_READ_POLICY
        if day<self.activation['first_signal_date']:
            return {'status':'before_start','outer_credit':0}
        if day>self.clock().astimezone(TW).date().isoformat():
            raise ValueError('r17_future_signal_forbidden')
        _,calendar,_=await asyncio.to_thread(self.prices,day)
        if day not in calendar:raise ValueError('r17_signal_not_in_official_calendar')
        entry,calendar_proof=await asyncio.to_thread(next_session,day,kv_read=self.kv_read,now=self.clock())
        calendar=sorted(set(calendar+[entry]))
        registered,old=read_event(self.objects,identity('registration',self.experiment,entry))
        if old is not None:
            if old['activation_checksum']!=self.activation['checksum']:
                raise ValueError('r17_daily_activation_changed')
            return {'status':'registered','registration_ref':registered,'reused':True,'outer_credit':0}
        # A completed frame chain whose close write was interrupted is recovered
        # before next-day carry. Missing observations remain explicit gaps.
        if entry!=self.activation['first_session_date']:
            prior=await asyncio.to_thread(self.tick,day)
            if prior['status']!='closed':return {**prior,'reason':'r17_prior_session_incomplete'}
        frozen=await on_signal_observation(bucket=self.bucket,config=self.setup['forecast_config'],
                                          day=day,entry_date=entry)
        if frozen['status']!='forecast_ready':return frozen
        activation_clock=self.objects.receipt_clock(self.activation_ref(),digest(self.activation['identity']))
        if _timestamp(frozen['forecast']['captured_at'])<=_timestamp(activation_clock['available_at']):
            raise ValueError('r17_forecast_before_activation_server_receipt')
        key=identity('daily_source',self.experiment,day)
        source_ref,source=read_event(self.objects,key)
        if source is None:
            saved=await asyncio.to_thread(canonical_context,day=day,
                ops_query=self.domains['ops'],learning_query=self.domains['learning'])
            risk=read_reference(self.bucket,frozen['risk_reference'])
            source=prepare(saved=saved,observation=frozen['observation'],forecast=frozen['forecast'],
                predictions=frozen['model_predictions'],risk=risk,configuration=self.setup['configuration'],
                frozen_policy=self.setup['allocation_policy'])
            stocks=await asyncio.to_thread(self.domains['market'],'SELECT * FROM stocks ORDER BY id',[])
            source.update(identity=key,stock_rows=stocks,calendar=calendar,calendar_proof=calendar_proof,
                          forecast=frozen['forecast'],observation=frozen['observation'],production_effect=False)
            source_ref=publish(self.objects,key,source)
        if source['forecast']!=frozen['forecast'] or source['calendar']!=calendar:
            raise ValueError('r17_daily_source_retry_changed')
        result=await asyncio.to_thread(register_signal,experiment=self.experiment,activation=self.activation,
            forecast=source['forecast'],observation=source['observation'],allocation_inputs=source['allocation_inputs'],
            seed_rows=source['seed_rows'],stock_rows=source['stock_rows'],
            configuration=self.setup['configuration'],calendar=source['calendar'],variables=self.setup['variables'],
            source_tables=self.setup['source_tables'],objects=self.objects,runner=self.runner,
            model_predictions=source['model_predictions'],bootstrap=self.objects.get(self.setup['bootstrap_ref']),
            now=self.clock(),source_evidence_ref=source_ref)
        return {'status':'registered','registration_ref':result,'outer_credit':0}

    def activation_ref(self):
        ref=self.objects.lookup_delivery(digest(self.activation['identity']))
        if ref is None or self.objects.get(ref)!=self.activation:
            raise ValueError('r17_activation_delivery_missing')
        return ref


def configured_host():
    ref=os.environ.get('R17_P4_ACTIVATION_REF','').strip()
    if not ref:return None
    from services.pipeline_input_events import bucket
    from services.l4_r17_objects import R17Objects
    from services.d1_domain_client import D1DataDomain,client_for_domain
    from services.kv_client import get
    store=bucket();objects=R17Objects(store)
    activation,setup=load_activation(objects,ref)
    return Host(objects=objects,bucket=store,activation=activation,setup=setup,
        domains={d.value:client_for_domain(d).query for d in D1DataDomain},
        kv_read=lambda key:get(key,strict=True))


def run_daily(day):
    host=configured_host()
    if host is None:return {'status':'not_activated','outer_credit':0}
    # Label progress is independent from today's forecast availability.
    result={};failed=False
    for name,call in (('maturity',lambda:host.mature(day)),('registration',lambda:asyncio.run(host.daily(day)))):
        if name=='registration' and result.get('maturity',{}).get('acceptance',{}).get('count')==20:
            result[name]={'status':'outer_complete','new_signal_registered':False}
            continue
        try:result[name]=call()
        except Exception as exc:
            result[name]=safe_failure(exc);failed=True
    # Unmatured five-day labels are expected, not a reason to restart tonight's
    # compute job. Only incomplete signal preparation needs continuation.
    registration=result.get('registration',{})
    pending=registration.get('status') in ('pending','execution_gap','awaiting_registration')
    return {'status':'failed' if failed else ('pending' if pending else 'ok'),**result,
            'external_compute_pending':registration.get('external_compute_pending',False),'production_effect':False}


def safe_failure(exc):
    import re
    code=str(exc)
    return {'status':'failed','reason':code if re.fullmatch(r'(r17|l4_native)_[a-z0-9_]+',code)
            else 'r17_source_or_execution_failed','error_type':type(exc).__name__,'outer_credit':0}


def run_execution_tick(day):
    host=configured_host()
    if host is None:return {'status':'not_activated','outer_credit':0}
    if day!=host.clock().astimezone(TW).date().isoformat():raise ValueError('r17_tick_current_day_required')
    return host.tick(day)
