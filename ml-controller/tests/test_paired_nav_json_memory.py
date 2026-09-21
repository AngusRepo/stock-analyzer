from services.pipeline_async_state_transport import decode_pipeline_state_envelope,encode_pipeline_state_envelope,build_pipeline_payload_identity

def test_restore_shares_only_equal_common_context_preserving_per_stock_values():
    common={'rates':[1,2],'revenue':None};config={'fees':{'commission':.001425}}
    rows=[{'symbol':'A','market_env':{**common,'revenue':1},'trading_config':config}, {'symbol':'B','market_env':{**common,'revenue':2},'trading_config':{'fees':{'commission':.002}}}]
    state={'payloads':rows,'market_env':common,'trading_config':config,'pipeline_payload_identity':build_pipeline_payload_identity(rows)}
    packet={'schema_version':'pipeline-async-state-v2','state':state}
    restored=decode_pipeline_state_envelope(encode_pipeline_state_envelope(packet))
    assert restored==packet
    a,b=restored['state']['payloads'];assert a['market_env']['revenue']==1 and b['market_env']['revenue']==2
    assert a['market_env']['rates'] is b['market_env']['rates']
    assert a['trading_config'] is restored['state']['trading_config']
    assert b['trading_config']['fees']['commission']==.002


def test_journal_transport_pages_all_rows_without_changing_order(monkeypatch):
    from services import d1_domain_client as module
    from services import d1_client
    monkeypatch.setattr(module, 'database_id_for_domain', lambda domain:'fixture-learning')
    monkeypatch.setattr(d1_client,'STRATEGY_MINING_D1_WORKER_ONLY',False)
    source=[{'part_no':i,'payload_text':'資料'*20000} for i in range(127)]
    calls=[]
    def post(body,**kwargs):
        calls.append(body)
        assert 'LIMIT 50' in body['sql']
        cursor=body['params'][1]
        return {'result':[{'results':[r for r in source if r['part_no']>cursor][:50]}]}
    monkeypatch.setattr(d1_client,'_post',post)
    got=module.DomainD1Client(module.D1DataDomain.LEARNING).query('SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no',['s'])
    assert got==source and len(calls)==3
    assert [body['params'][1] for body in calls]==[-1,49,99]
