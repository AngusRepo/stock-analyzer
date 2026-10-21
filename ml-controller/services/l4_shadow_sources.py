"""Read-only market sources for one frozen, independent L4 shadow account."""
import os
from datetime import datetime,timezone
from services.l4_challenger_comparison import digest
from services.native_paper_sandbox import PrivatePaperStore
from services.paired_nav_journal import encode


def opening_scope(head,session_date,clock):
    from services.corporate_opening_history import read_corporate_cash_discovery_dates
    store=PrivatePaperStore(head['state_sql'],head['state_checksum'],{})
    try:
        account=head['account_id']
        symbols={r[0] for r in store.db.execute('SELECT symbol FROM paper_positions WHERE account_id=? AND shares>0',[account])}
        rights=list(store.db.execute('SELECT symbol,action_id FROM paper_corporate_entitlements_v1 WHERE account_id=? AND settled=0',[account]))
        symbols.update(r[0] for r in rights)
        def query(sql,params):return [dict(r) for r in store.db.execute(sql,params)]
        history=read_corporate_cash_discovery_dates(query,account_id=account,before_date=session_date,now=clock())
        symbols.update(history)
        return sorted(symbols),sorted({r[1] for r in rights}),history
    finally:store.db.close()


class ShadowSourceKV:
    def __init__(self,*,entry,packet,head,objects,kv_read,clock,corporate_reader=None):
        self.entry,self.packet,self.head=entry,packet,head
        self.objects,self.kv_read,self.clock,self.reader=objects,kv_read,clock,corporate_reader
        self.scope='paired-'+digest(['l4-shadow-corporate',entry['checksum'],packet['checksum']])

    @property
    def source_identity(self):
        return dict(owner='l4-shadow-source-kv-v1',entry_checksum=self.entry['checksum'],
            daily_packet_checksum=self.packet['checksum'],scope_id=self.scope)

    def __call__(self,key):
        if key=='market:corporate_actions:v1:'+self.packet['session_date']:
            from services.paper_corporate_source import materialize_corporate_source
            symbols,rights,history=opening_scope(self.head,self.packet['session_date'],self.clock)
            receipt=materialize_corporate_source(session_date=self.packet['session_date'],scope_id=self.scope,
                symbols=symbols,outstanding_action_ids=rights,historical_cash_dates=history,
                objects=self.objects,reader=self.reader,clock=self.clock)
            return encode(receipt['snapshot'])
        return self.kv_read(key)


def build_capture(*,entry,packet,head,objects,domain_queries,kv_read,clock=None,
                  broker_token='',controller_token='',shadow_hmac_secret='',transport=None,corporate_reader=None):
    from services.native_paper_source_capture import NativeSourceCapture
    from services.native_paper_read_capabilities import NativeReadCapabilities
    from services.native_paper_debate import NativeCapturedDebate,NativeWorkersAIRead
    from services.llm_debate_client import DEBATE_MODEL_POLICY
    from services.l4_shadow_daily import validate
    validate(packet,entry)
    clock=clock or (lambda:datetime.now(timezone.utc))
    context=packet['execution_context'];variables=context['variables']
    if str(variables.get('LIVE_EXECUTION_SHADOW_GUARD_ENABLED','')).lower() in {'1','true','yes','enabled','on'}:
        raise ValueError('shadow_external_broker_guard_cannot_govern_private_account')
    capture=NativeSourceCapture(objects=objects,domain_queries=domain_queries,
        inference_reads={'native_debate_llm':NativeWorkersAIRead()},clock=clock)
    debate=NativeCapturedDebate(source_capture=capture,max_rounds=2,session_date=packet['session_date'],model_name=DEBATE_MODEL_POLICY)
    kv=ShadowSourceKV(entry=entry,packet=packet,head=head,objects=objects,kv_read=kv_read,clock=clock,corporate_reader=corporate_reader)
    policy=packet['l4_allocation_inputs']['alpha_policy']['l4Distribution']
    capabilities=NativeReadCapabilities(broker_url=variables.get('SHIOAJI_PROXY_URL',''),broker_token=broker_token,
        controller_url=variables.get('ML_CONTROLLER_URL',''),controller_token=controller_token,
        research_url=variables.get('S12_RESEARCH_KBARS_URL',''),shadow_hmac_secret=shadow_hmac_secret,
        shadow_scope=variables.get('LIVE_EXECUTION_SHADOW_SCOPE',''),trading_config=packet['trading_config'],
        predictions=policy['runtime']['predictions'],session_date=packet['session_date'],
        transport=transport,kv_read=kv,debate_reader=debate)
    capture.inference_reads.update(capabilities.registered())
    return capture


def run_tick(*,session_date):
    from pathlib import Path
    from services.paper_corporate_source import production_objects
    from services.d1_domain_client import D1DataDomain,client_for_domain
    from services.kv_client import get
    from services.l4_challenger_registry import Registry
    from services.l4_shadow_accounts import Accounts
    from services.l4_shadow_execution import collect_due
    objects=production_objects()
    def no_pointer_authority():raise ValueError('shadow_tick_has_no_registration_or_switch_authority')
    registry=Registry(objects.bucket,formal_identity=no_pointer_authority)
    accounts=Accounts(registry,runner=Path(os.environ.get('NATIVE_PAPER_RUNNER','/app/worker-dist/native-paper.cjs')))
    clients={domain.value:client_for_domain(domain) for domain in D1DataDomain}
    def factory(**kwargs):
        return build_capture(**kwargs,objects=objects,domain_queries={name:client.query for name,client in clients.items()},
            kv_read=lambda key:get(key,strict=True),controller_token=os.environ.get('ML_CONTROLLER_SECRET',''),
            broker_token=os.environ.get('PROXY_SERVICE_TOKEN') or os.environ.get('SHIOAJI_PROXY_TOKEN',''),
            shadow_hmac_secret=os.environ.get('LIVE_EXECUTION_HMAC_SECRET',''))
    return collect_due(accounts=accounts,session_date=session_date,capture_factory=factory)
