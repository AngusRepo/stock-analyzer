"""Actual daily Atomic publisher -> original native day -> ledger. Synthetic data."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import sqlite3
from types import SimpleNamespace

import pytest

from test_paired_nav_atomic_candidate import allocated, full_atomic, dispatched, environment, native_runner
from test_paired_native_collector import CompressedMemoryBucket
from test_paired_native_session import full_cash_state, native_config
from test_native_pending_entry import EntrySources
from services.native_paper_source_capture import ImmutableNativeObjects
from services.native_paper_sandbox import native_runtime_manifest
from services.paired_nav_journal import read_snapshot, mature_staged_pairs
from services.paired_nav_atomic_candidate import collect_atomic_allocations
from services.paired_native_registration import register_allocation_pair
from services.paired_native_runtime import build_capture_source, collect_due_execution_frames, KV_READ_POLICY
from services.paired_native_collector import collect_frame
from services.paired_native_sources import build_source_receipt


@pytest.fixture(autouse=True)
def isolated_execution_environment(monkeypatch):
    import test_paired_nav_execution_environment as fixture
    original = fixture.environment_packet
    def packet(*args, **kwargs):
        value = original(*args, **kwargs)
        value['kv_read_policy'] = deepcopy(KV_READ_POLICY)
        value['source_context']['variables'] = {'SHIOAJI_PROXY_URL': 'https://broker.fixture',
            'ML_CONTROLLER_URL': 'https://controller.fixture'}
        return value
    monkeypatch.setattr(fixture, 'environment_packet', packet)
    from services import native_paper_debate
    monkeypatch.setattr(native_paper_debate.NativeGeminiRead, '__call__', lambda self, request:
        {'text': 'VERDICT: APPROVE | CONVICTION: 85\nSynthetic fixture.', 'source': 'gemini_api', 'usage': []})


@pytest.mark.parametrize('full_atomic', ['native_policy_execution','native_policy_holdings'], indirect=True)
@pytest.mark.parametrize('environment', ['2026-09-06'], indirect=True)
def test_daily_atomic_original_complete_session_and_ledger(allocated, native_runner, record_property, request):
    db, graph, state = allocated
    group = collect_atomic_allocations(snapshot_id=state['paired_nav_collection']['snapshot_id'],query=db.query,writer=db.writer)
    parent = read_snapshot(db.query,state['paired_nav_collection']['snapshot_id'])['payload']['content']
    key = parent['atomic_recommendation_inputs']['policy_population']['replacements'][0]['definition_checksum']
    plan = next(p for p in group['plans'] if read_snapshot(db.query,p['snapshot_id'])['payload']['content']['candidate_checksum']==key)
    source = sqlite3.connect(':memory:')
    source.row_factory = sqlite3.Row
    source.executescript(full_cash_state(native_config()))
    source.execute('UPDATE paper_accounts SET cash=100000,initial_cash=100000 WHERE id=1')
    for sid in range(1,5):
        symbol = str(sid+999)
        source.execute("INSERT INTO stocks(id,symbol,name,market,added_at,updated_at) VALUES(?,?,?,'TWSE','2026-09-01','2026-09-01')",(sid,symbol,symbol))
        source.execute("INSERT INTO stock_prices(stock_id,date,close) VALUES(?,'2026-09-06',100)",(sid,))
    held_symbol = '1001' if request.node.callspec.params['full_atomic']=='native_policy_holdings' else '1000'
    source.execute("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop) VALUES(1,?,?,100,100,100,'2026-09-01',101,101)",(held_symbol,held_symbol))
    source.commit()
    query = lambda sql, args: [dict(row) for row in source.execute(sql,args)]
    domains = {d:query for d in set(native_runtime_manifest(native_runner)['tables'].values())}
    objects = ImmutableNativeObjects(CompressedMemoryBucket())
    env = parent['native_execution_environment']
    frozen_at = datetime(2026,9,6,14,tzinfo=timezone.utc)
    def calendar(key):
        return json.dumps({'schemaVersion':'twse-holiday-schedule-v2','source':'twse.openapi.holidaySchedule',
            'loadedAt':frozen_at.isoformat(),'dates':[]}) if key.startswith('market:twse_holiday_schedule:') else None
    try:
        original_changes = source.total_changes
        registered = register_allocation_pair(snapshot_id=plan['snapshot_id'],query=db.query,writer=db.writer,
            domain_queries=domains,kv_read=calendar,objects=objects,account_id=1,variables=env['source_context']['variables'],
            kv_read_policy=env['kv_read_policy'],source_context=env['source_context'],runner=native_runner,now=frozen_at)
        packet = read_snapshot(db.query,registered['snapshot_id'])['payload']['content']
        if held_symbol == '1001':
            definition = parent['atomic_recommendation_inputs']['definitions'][key]
            assert '1001' not in {r['symbol'] for r in definition['screener_recs']}
            assert '1001' not in definition['predictions']
            assert any(h['target_symbol']=='1001' for h in definition['holding_predictions'])
            assert '1001' in packet['model_prediction_arms']['candidate']['predictions']
            assert packet['model_prediction_arms']['candidate']['input_identity']['schema_version']=='atomic-native-input-v2'
            assert packet['model_prediction_arms']['candidate']['input_identity'] != packet['model_prediction_arms']['baseline']['input_identity']
            from test_paired_native_models import capture as rescore_capture, request as rescore_request, outcome, FRAME
            rescore = rescore_capture(packet, ImmutableNativeObjects(CompressedMemoryBucket()))
            position_request = rescore_request()
            position_request['body'] = position_request['body'].replace('2330','1001')
            reads = {arm:rescore.for_arm(arm).read('frozen_fetch',position_request,FRAME) for arm in ('baseline','candidate')}
            for arm in ('baseline','candidate'):
                assert outcome(reads[arm])['original_confidence'] == packet['model_prediction_arms'][arm]['predictions']['1001']['direction_accuracy']
                assert reads[arm]['identity']['source_context']['input_identity'] == packet['model_prediction_arms'][arm]['input_identity']
            assert reads['baseline']['identity'] != reads['candidate']['identity']
        # Original fixture has an unsettled sell receivable of 900: include it
        # before settlement, never book it again as investment return.
        assert packet['initial_account']['cash']==100900
        assert packet['initial_account']['nav']==110900
        market = EntrySources()
        current = [datetime.fromisoformat(packet['schedule'][0]['observed_at'])]
        def transport(method,url,**kwargs):
            mapped = url
            for symbol in ('1000','1001','1002','1003'):
                mapped = mapped.replace(symbol,'2330')
            request = {'url':mapped,'method':method,'body':kwargs.get('content') or ''}
            response = market.fixture_response('frozen_fetch',request,{'observed_at':current[0].isoformat()})['response']
            if response['body']:
                body = json.loads(response['body'])
                request_body = json.loads(request['body']) if request['body'] else {}
                odd_lot = request_body.get('lot_type') == 'odd_lot' or 'lot_type=odd_lot' in url
                for field in ('data','quotes'):
                    if isinstance(body,dict) and isinstance(body.get(field),dict) and '2330' in body[field]:
                        quote = body[field]['2330']
                        if odd_lot:
                            quote = {**quote, 'lot_type': 'odd_lot'}
                        body[field] = {symbol:deepcopy(quote) for symbol in ('1000','1001','1002','1003')}
                if odd_lot and isinstance(body,dict) and 'bid' in body:
                    body['lot_type'] = 'odd_lot'
                    if isinstance(body.get('data'),dict):
                        body['data']['lot_type'] = 'odd_lot'
                response = {**response,'body':json.dumps(body)}
            return SimpleNamespace(status_code=response['status'],text=response['body'],headers=response['headers'])
        def corporate(**request):
            return {'schema_version':'paper-corporate-source-v1','session_date':packet['session_date'],
                'observed_at':current[0].isoformat(),'source_checksum':'a'*64,
                'covered_symbols':request['symbols'],'actions':[],'blockers':{},'tax_basis':'gross_before_personal_tax'}
        for index, frame in enumerate(packet['schedule']):
            current[0] = datetime.fromisoformat(frame['observed_at'])
            capture = build_capture_source(snapshot_id=registered['snapshot_id'],packet=packet,objects=objects,
                domain_queries=domains,kv_read=calendar,transport=transport,corporate_reader=corporate,clock=lambda:current[0])
            result = collect_frame(snapshot_id=registered['snapshot_id'],frame_index=index,objects=objects,
                query=db.query,capture_source=capture,runner=native_runner,now=current[0])
            if index % 50 == 0:
                print('atomic-daily-frame',index,flush=True)
            if index == 10:
                with sqlite3.connect(':memory:') as diagnostic:
                    diagnostic.row_factory = sqlite3.Row
                    diagnostic.executescript(result['states']['baseline']['state_sql'])
                    print('atomic-opening-diagnostic', json.dumps({
                        'positions': [dict(r) for r in diagnostic.execute('SELECT symbol,shares,initial_stop,trailing_stop FROM paper_positions')],
                        'events': [dict(r) for r in diagnostic.execute('SELECT event_type,status,reason FROM paper_execution_events ORDER BY id DESC LIMIT 12')],
                        'routes': sorted(set(market.routes))}, ensure_ascii=False), flush=True)
        now = datetime(2026,9,7,7,tzinfo=timezone.utc)
        receipt = build_source_receipt(snapshot_id=registered['snapshot_id'],objects=objects,query=db.query,now=now)
        assert receipt['complete'] is True and len(receipt['frame_objects'])==281
        def no_capture(**kwargs):
            pytest.fail('closed automatic tick requested new source capture')
        tick_args = dict(session_date='2026-09-07',query=db.query,writer=db.writer,
            objects=objects,capture_factory=no_capture,runner=native_runner,clock=lambda:now)
        def fail_journal(statements):
            if any('INSERT OR IGNORE INTO paired_nav_daily_journal_v1' in sql for sql,_ in statements):
                raise RuntimeError('paired_nav_fixture_journal_unavailable')
            return db.writer(statements)
        failed = collect_due_execution_frames(**{**tick_args,'writer':fail_journal})
        assert failed['status']=='failed' and failed['pairs'][0]['accounting_status']=='unconfirmed'
        assert failed['pairs'][0]['reason']=='paired_nav_fixture_journal_unavailable'
        assert failed['pairs'][0]['receipt_snapshot_id'] is not None
        assert db.query('SELECT * FROM paired_nav_daily_journal_v1',[])==[]
        original_receipt = read_snapshot(db.query,failed['pairs'][0]['receipt_snapshot_id'])
        tick = collect_due_execution_frames(**tick_args)
        assert tick['status']=='ok' and len(tick['pairs'])==1
        assert tick['pairs'][0]['status']=='closed' and tick['pairs'][0]['completed_frames']==281
        assert tick['pairs'][0]['accounting_status']=='materialized'
        assert read_snapshot(db.query,tick['pairs'][0]['receipt_snapshot_id'])==original_receipt
        execution = read_snapshot(db.query,tick['pairs'][0]['receipt_snapshot_id'])['payload']['content']
        for arm in ('baseline','candidate'):
            fills = execution['arms'][arm]['fills']
            assert sum(f['shares'] for f in fills if f['side']=='sell' and f['symbol']==held_symbol)==100
            assert sum(f['commission'] for f in fills)>0
        assert collect_due_execution_frames(session_date='2026-09-07',query=db.query,writer=db.writer,
            objects=objects,capture_factory=no_capture,runner=native_runner,clock=lambda:now)==tick
        mature = mature_staged_pairs(business_date='2026-09-07',query=db.query,writer=db.writer,now=now)
        assert mature['processed_pair_sessions']==0  # Already accounted before OOF/nightly reconciliation.
        rows = db.query('SELECT payload_json FROM paired_nav_daily_journal_v1',[])
        assert len(rows)==1
        journal = json.loads(rows[0]['payload_json'])
        assert journal['promotion_allowed'] is False and journal['ev_prediction_dates_added']==0
        assert journal['arms']['baseline']['costs']>0 and journal['arms']['candidate']['costs']>0
        from services.paired_nav_evidence import read_verified_nav_evidence
        evidence = read_verified_nav_evidence(business_date='2026-09-07',query=db.query,now=now).summary()
        member = next(p for p in evidence['pairs'] if p['pair_id']==plan['pair_id'])
        assert member['accounted_sessions']==member['exact_nav_sessions']==1
        assert member['comparison']['kind']=='atomic_strategy_replacement'
        assert member['inference_status']=='not_evaluated' and member['promotion_allowed'] is False
        from services.paired_nav_native_holdings import capture_native_holdings
        from services.paired_native_carry import read_native_carry
        observed = capture_native_holdings(signal_date='2026-09-07',definition_checksums=[key],
            query=db.query,writer=db.writer,objects=objects,paper_query=query,now=now)
        own = observed['definitions'][key]
        assert own['status']=='ready' and own['source_kind']=='verified_native_carry'
        assert own['arms']=={'baseline':[],'candidate':[]}  # Actual private exit, formal fixture still holds.
        assert own['references'][0]['execution_snapshot_id']==registered['snapshot_id']
        assert observed['initial_observation']['status']=='ready'
        assert observed['initial_observation']['rows']['positions']==[{'symbol':held_symbol,'shares':100}]
        from services.paired_nav_native_holdings import _prediction_symbols
        assert _prediction_symbols(observed,own,'candidate')==[held_symbol]
        def unavailable_initial_account(*args):
            raise RuntimeError('paper_source_unavailable')
        without_initial = capture_native_holdings(signal_date='2026-09-07',definition_checksums=[key],
            query=db.query,writer=db.writer,objects=objects,paper_query=unavailable_initial_account,now=now)
        assert without_initial['initial_observation']['status']=='failed'
        assert without_initial['definitions'][key]==own  # No reset or suppression of verified private carry.
        assert _prediction_symbols(without_initial,own,'candidate')==[]
        assert source.execute('SELECT shares FROM paper_positions WHERE symbol=?',(held_symbol,)).fetchone()[0]==100
        with pytest.raises(ValueError,match='paired_native_carry_receipt_not_observable'):
            read_native_carry(pair_id=plan['pair_id'],signal_date='2026-09-07',query=db.query,objects=objects,now=frozen_at)
        metrics = {'scope':'synthetic_accounting_not_investment_roi','frames':281,
            'opening_nav':packet['initial_account']['nav'],'net_return_delta':journal['net_return_delta'],
            'arms':{arm:{key:journal['arms'][arm][key] for key in ('nav','cash','costs','positions')}
                    for arm in ('baseline','candidate')}}
        print('atomic-daily-accounting',json.dumps(metrics),flush=True)
        record_property('synthetic_accounting_receipt',json.dumps(metrics))
        assert mature_staged_pairs(business_date='2026-09-07',query=db.query,writer=db.writer,now=now)['processed_pair_sessions']==0
        assert source.total_changes==original_changes
    finally:
        source.close()
