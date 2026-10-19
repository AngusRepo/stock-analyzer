import asyncio
from copy import deepcopy
import importlib.util
from pathlib import Path
import pytest
from test_l4_r17_native import Objects, SOURCE
from test_l4_r16_allocation import fixture
from services import l4_r17_runtime as runtime
from services.l4_r17_context import prepare
from services.paired_nav_journal import digest


def context_case():
    recs,policy,_,packet=fixture();day=packet['forecast']['signal_date']
    risk={'schema_version':'l4-dated-risk-v1','signal_date':day,'returns':{r['symbol']:[.01]*20 for r in recs}}
    risk['checksum']=digest(risk)
    source={'inputs':{'recommendations':deepcopy(recs),'alpha_policy':{'l4Distribution':deepcopy(policy)}},
        'risk_config':{'enabled':True},'formal_output':[],
        'recommendation_context':{'inputs':{'screener_recs':[{'symbol':r['symbol'],'stock_id':i+1,'date':day} for i,r in enumerate(recs)]}}}
    payload={'content':source}
    saved={'payload':payload,'manifest':{'snapshot_kind':'allocation_context','prospective':1,
        'signal_date':day,'snapshot_id':'original','frozen_at':day+'T12:00:00Z','payload_checksum':digest(payload)}}
    return dict(saved=saved,observation=packet['observation'],forecast=packet['forecast'],
        predictions=policy['runtime']['predictions'],risk=risk,configuration={'risk_config':{'enabled':True}},
        frozen_policy=policy)


def test_context_keeps_original_slate_and_uses_frozen_predictions_without_mutating_source():
    args=context_case();before=deepcopy(args)
    output=prepare(**args)
    assert args==before
    assert output['source_evidence']['replacement_candidates']==[]
    assert output['allocation_inputs']['return_history']==args['risk']
    assert [r['symbol'] for r in output['allocation_inputs']['recommendations']]==['A','B','C']
    assert output['allocation_inputs']['alpha_policy']['l4Distribution']['runtime']['predictions']==args['predictions']


@pytest.mark.parametrize('mutation',['risk','policy','checksum','outside'])
def test_context_rejects_mixed_sources(mutation):
    args=context_case();saved=args['saved'];source=saved['payload']['content']
    if mutation=='risk':args['risk']['signal_date']='2026-09-10'
    if mutation=='policy':source['inputs']['alpha_policy']['l4Distribution']['constraints']['name_cap']=.9
    if mutation=='outside':source['inputs']['recommendations'][0]['symbol']='outside'
    saved['manifest']['payload_checksum']=digest(saved['payload'])
    if mutation=='checksum':saved['manifest']['payload_checksum']='wrong'
    with pytest.raises(ValueError):prepare(**args)


def test_daily_attempts_registration_even_if_mature_price_reader_fails(monkeypatch):
    calls=[]
    class FakeHost:
        def mature(self,day):calls.append('maturity');raise ValueError('r17_prices_missing')
        async def daily(self,day):calls.append('registration');return {'status':'registered'}
    monkeypatch.setattr(runtime,'configured_host',lambda:FakeHost())
    out=runtime.run_daily('2026-10-20')
    assert calls==['maturity','registration'] and out['status']=='failed'
    assert out['registration']['status']=='registered'


def test_existing_daily_job_cannot_skip_r17_when_legacy_fails(monkeypatch):
    from services.l4_forward_refresh import attach_daily_result
    monkeypatch.setenv('R17_P4_ACTIVATION_REF','private-activation')
    calls=[]
    monkeypatch.setattr(runtime,'run_daily',lambda day:calls.append(day) or {'status':'ok'})
    def fail(*_):raise RuntimeError('provider body must not be exposed')
    result=attach_daily_result({}, {}, '2026-10-20',runner=fail)
    assert calls==['2026-10-20'] and result['r17_p4']['status']=='ok'
    assert result['status']=='failed'


def test_existing_execution_endpoint_invokes_r17_despite_legacy_failure(monkeypatch):
    name='r17_test_paper_route'
    spec=importlib.util.spec_from_file_location(name,SOURCE/'routers/paper_corporate.py')
    route=importlib.util.module_from_spec(spec);spec.loader.exec_module(route)
    def fail(**_):raise ValueError('legacy failed')
    calls=[]
    monkeypatch.setattr('services.paired_native_runtime.run_strategy_execution_tick',fail)
    monkeypatch.setattr(runtime,'run_execution_tick',lambda day:calls.append(day) or {'status':'collecting'})
    result=asyncio.run(route.strategy_nav_execution_tick(route.NativeTickRequest(session_date='2026-10-20')))
    assert calls==['2026-10-20'] and result['r17']['status']=='collecting' and result['status']=='failed'


def test_absent_activation_is_not_reported_as_running(monkeypatch):
    monkeypatch.delenv('R17_P4_ACTIVATION_REF',raising=False)
    assert runtime.run_daily('2026-10-20')['status']=='not_activated'
    assert runtime.run_execution_tick('2026-10-20')['status']=='not_activated'


def test_maturity_wait_does_not_restart_compute_and_twenty_days_stops_new_registration(monkeypatch):
    calls=[];count=[0]
    class FakeHost:
        def mature(self,day):return {'status':'pending','acceptance':{'count':count[0]}}
        async def daily(self,day):calls.append(day);return {'status':'registered'}
    monkeypatch.setattr(runtime,'configured_host',lambda:FakeHost())
    assert runtime.run_daily('2026-10-20')['status']=='ok'
    count[0]=20
    out=runtime.run_daily('2026-11-20')
    assert out['registration']['status']=='outer_complete' and calls==['2026-10-20']


def test_projected_context_keeps_original_checksum_and_rejects_tampering():
    from services.l4_r17_context import CONTEXT_FIELDS
    args=context_case();saved=args['saved']
    saved['r17_projection_proof']={'schema':'r17-full-source-verified-projection-v1',
        'fields':list(CONTEXT_FIELDS),'original_payload_checksum':saved['manifest']['payload_checksum'],
        'projection_checksum':digest(saved['payload'])}
    assert prepare(**args)['source_evidence']['replacement_candidates']==[]
    saved['payload']['content']['inputs']['recommendations'][0]['score']=12345
    with pytest.raises(ValueError,match='context_invalid'):prepare(**args)


def test_activation_rejects_self_asserted_engineering_boolean(monkeypatch):
    from services.l4_r17_activation import implementation_identity
    class ClockObjects(Objects):
        def receipt_clock(self,reference,key):
            return {'authority':'object_store_server','available_at':'2026-10-19T04:00:00Z'}
    objects=ClockObjects();configuration={'fees':{}}
    bootstrap=objects.put({'state':{},'account':{}})
    setup=objects.put({'configuration':configuration,'bootstrap_ref':bootstrap})
    engineering=objects.put({'status':'passed','formal_source_e2e':False,'test_receipts':['fixture'],
        'execution_owner':'engine','implementation_checksum':implementation_identity()})
    body={'schema':'r17-p4-activation-v1','identity':{'kind':'test'},'first_signal_date':'2026-10-19',
        'rules_sha':runtime.RULES_SHA,'weight_timing_sha':runtime.TIMING_SHA,
        'primary_weight_sample':'preopen_sealed_targets','execution_owner':'engine',
        'setup_ref':setup,'engineering_ref':engineering,'configuration_checksum':digest(configuration),
        'bootstrap_checksum':digest(objects.get(bootstrap)),
        'implementation_checksum':implementation_identity(),'engineering_verified':True}
    body['checksum']=digest(body);ref=objects.put(body)
    monkeypatch.setattr('services.native_paper_sandbox.native_execution_identity',lambda runner:'engine')
    with pytest.raises(ValueError,match='not_verified'):runtime.load_activation(objects,ref)


def test_cold_projection_checks_unselected_original_bytes(tmp_path):
    import gzip,json,hashlib
    from services.paired_nav_cold import parse_file
    raw=b'{"keep":1,"ignored":{"large":"original"}}'
    path=tmp_path/'original.gz';path.write_bytes(gzip.compress(raw))
    checksum=hashlib.sha256(raw).hexdigest()
    assert parse_file(path,prefixes={'keep'},checksum=checksum,byte_count=len(raw))=={'keep':1}
    path.write_bytes(gzip.compress(raw.replace(b'original',b'changed!')))
    with pytest.raises(RuntimeError):parse_file(path,prefixes={'keep'},checksum=checksum,byte_count=len(raw))


def test_activation_tick_verifies_bootstrap_header_without_loading_account_sql(monkeypatch):
    from services.l4_r17_activation import implementation_identity,ENGINEERING_CHECKS
    class HeaderOnly(Objects):
        forbidden=None
        def get(self,ref):
            assert ref!=self.forbidden,'minute tick must not expand bootstrap SQL'
            return super().get(ref)
        def get_header(self,ref):return super().get(ref)
        def receipt_clock(self,*args):
            return {'authority':'object_store_server','available_at':'2026-10-19T04:00:00Z'}
    objects=HeaderOnly();configuration={'fees':{}}
    bootstrap=objects.put({'state':{'r17_state_ref':'immutable-private-chunks'},'account':{}})
    setup=objects.put({'configuration':configuration,'bootstrap_ref':bootstrap})
    engineering=objects.put({'status':'passed','checks':dict.fromkeys(ENGINEERING_CHECKS,True),'test_receipts':['unit-test-only'],
        'execution_owner':'engine','implementation_checksum':implementation_identity()})
    body={'schema':'r17-p4-activation-v1','identity':{'kind':'unit-test'},'first_signal_date':'2026-10-19',
        'rules_sha':runtime.RULES_SHA,'weight_timing_sha':runtime.TIMING_SHA,
        'primary_weight_sample':'preopen_sealed_targets','execution_owner':'engine',
        'setup_ref':setup,'engineering_ref':engineering,'configuration_checksum':digest(configuration),
        'bootstrap_checksum':'already-verified-during-sealing',
        'bootstrap_header_checksum':digest(objects.get_header(bootstrap)),
        'implementation_checksum':implementation_identity()}
    body['checksum']=digest(body);ref=objects.put(body);objects.forbidden=bootstrap
    monkeypatch.setattr('services.native_paper_sandbox.native_execution_identity',lambda runner:'engine')
    assert runtime.load_activation(objects,ref)[0]==body
    objects.data[bootstrap]['account']={'tampered':True}
    with pytest.raises(ValueError,match='not_verified'):runtime.load_activation(objects,ref)
