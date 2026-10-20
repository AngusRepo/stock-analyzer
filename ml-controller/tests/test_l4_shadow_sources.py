import json
from datetime import datetime,timezone
from copy import deepcopy
import pytest
from services.l4_shadow_sources import build_capture,ShadowSourceKV,opening_scope
from services.native_paper_source_capture import ImmutableNativeObjects
from services.l4_challenger_comparison import digest
from test_native_paper_source_capture import Bucket
from test_native_paper_sandbox import native_runner
from test_l4_shadow_daily import setup,reseal


def test_registered_source_seals_once_and_has_no_order_or_mutation_capability(native_runner):
    _,entry,p,head,_=setup(native_runner,full_session=True)
    seen=[];objects=ImmutableNativeObjects(Bucket())
    clock=lambda:datetime(2026,10,20,tzinfo=timezone.utc)
    c=build_capture(entry=entry,packet=p,head=head,objects=objects,domain_queries={},
        kv_read=lambda key:seen.append(key) or 'frozen value',clock=clock)
    frame=dict(stage='morning',input_id='synthetic',observed_at='2026-10-20T00:00:00Z')
    one=c.read('source_kv',dict(key='market:fixture'),frame)
    assert one['response']=='frozen value'
    assert c.read('source_kv',dict(key='market:fixture'),frame)==one and seen==['market:fixture']
    with pytest.raises(ValueError):c.read('source_sql',dict(domain='paper',sql='DELETE FROM paper_orders',args=[]),frame)
    with pytest.raises(ValueError):c.read('submit_order',{},frame)
    reader=c.inference_reads['frozen_fetch']
    assert reader.predictions==p['l4_allocation_inputs']['alpha_policy']['l4Distribution']['runtime']['predictions']
    identity=reader.source_identity
    assert identity['kv_context']['entry_checksum']==entry['checksum']
    assert identity['kv_context']['daily_packet_checksum']==p['checksum']


def test_corporate_scope_uses_only_independent_account_and_shared_reads_stay_read_only(native_runner):
    _,entry,p,head,_=setup(native_runner,full_session=True)
    clock=lambda:datetime(2026,10,20,tzinfo=timezone.utc)
    assert opening_scope(head,p['session_date'],clock)==([],[],{})
    reads=[];objects=ImmutableNativeObjects(Bucket())
    kv=ShadowSourceKV(entry=entry,packet=p,head=head,objects=objects,kv_read=lambda k:reads.append(k),clock=clock)
    saved=json.loads(kv('market:corporate_actions:v1:2026-10-20'))
    assert saved['covered_symbols']==[] and saved['actions']==[] and not reads
    assert kv.scope.startswith('paired-') and 'paper-account-1' not in kv.scope
    assert json.loads(kv('market:corporate_actions:v1:2026-10-20'))==saved
    kv('market:some-other-read');assert reads==['market:some-other-read']


def test_external_execution_guard_is_not_reused_for_private_shadow(native_runner):
    _,entry,p,head,_=setup(native_runner,full_session=True)
    p=deepcopy(p);p['execution_context']['variables']['LIVE_EXECUTION_SHADOW_GUARD_ENABLED']='true'
    entry=deepcopy(entry);entry['components']['execution_context']=digest(p['execution_context']);entry=reseal(entry)
    p=reseal(p)
    with pytest.raises(ValueError,match='external_broker_guard'):
        build_capture(entry=entry,packet=p,head=head,objects=None,domain_queries={},kv_read=lambda k:None)
