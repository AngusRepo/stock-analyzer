"""Original native pending-entry path; synthetic inputs, never promotion data."""
import json
import sqlite3
import tomllib
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs
from types import SimpleNamespace
import pytest

from services.native_paper_sandbox import run_native_paper_frames
from services.native_paper_read_capabilities import NativeReadCapabilities
from test_native_paper_sandbox import ROOT, checksum, native_runner
from test_paired_native_session import full_cash_state, native_config


def entry_state():
    config = native_config()
    config['risk']['system']['killSwitch'] = False
    with sqlite3.connect(':memory:') as db:
        db.executescript(full_cash_state(config))
        db.executescript("""
          INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE');
          INSERT INTO model_accuracy(stock_id,model_name,period,total_count,correct_count,accuracy)
            VALUES(1,'LightGBM','30d',100,70,.7);
          INSERT INTO market_risk(date,twii_close,risk_score,risk_level)
            VALUES('2026-09-04',22000,10,'green'),('2026-09-03',21900,10,'green');
          INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-04',.8,.8);
          INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,
            contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at)
            VALUES('2026-09-04','market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}','2026-09-04T14:00:00Z');
          INSERT INTO pending_buy_runs(id,trade_date,source_reco_date,status,debate_status,candidate_count)
            VALUES(1,'2026-09-07','2026-09-04','ready','completed',1);
          INSERT INTO pending_buy_items(run_id,symbol,name,signal,confidence,ml_entry_price,
            ml_stop_loss,ml_target1,ml_target2,debate_verdict,debate_status,risk_pct,
            watch_points_json,score,chip_score,tech_score,ml_score,source)
            VALUES(1,'2330','fixture','BUY',.85,100,95,108,115,'BUY','completed',.01,
              '[]',85,80,80,85,'native-test-fixture');
        """)
        regime = {'schema_version': 'market-regime-state-v1', 'label': 'bull',
                  'run_date': '2026-09-04', 'source': 'hmm', 'computed_at': '2026-09-04T14:00:00Z'}
        db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)', ('market_regime_state', json.dumps(regime)))
        return '\n'.join(db.iterdump())


class EntrySources:
    def __init__(self, bars=None, price=100):
        self.routes = []
        self.bars = bars
        self.price = price
        self.trading = native_config()['trading']
        from services.native_paper_debate import NativeCapturedDebate
        from services.native_paper_source_capture import NativeSourceCapture, ImmutableNativeObjects
        from services.llm_debate_client import GEMINI_MODEL_DEFAULT
        from test_native_paper_source_capture import Bucket
        self.llm_calls = []
        def provider(request):
            self.llm_calls.append(request)
            return {'text': 'VERDICT: APPROVE | CONVICTION: 85\nSynthetic evidence.', 'source': 'gemini_api', 'usage': []}
        capture = NativeSourceCapture(objects=ImmutableNativeObjects(Bucket()), clock=lambda: self.observed,
                                      domain_queries={}, inference_reads={'native_debate_llm': provider})
        self.debate = NativeCapturedDebate(source_capture=capture, max_rounds=3,
                                          session_date='2026-09-07', model_name=GEMINI_MODEL_DEFAULT)

    def read(self, operation, request, frame):
        assert operation == 'frozen_fetch'
        self.observed = datetime.fromisoformat(frame['observed_at'])
        def transport(method, url, **kwargs):
            packet = self.fixture_response(operation, {'url': url, 'method': method,
                'body': kwargs.get('content') or ''}, frame)['response']
            return SimpleNamespace(status_code=packet['status'], text=packet['body'], headers=packet['headers'])
        configured = tomllib.loads((ROOT / 'worker/wrangler.toml').read_text(encoding='utf-8'))['vars']
        reader = NativeReadCapabilities(broker_url='https://broker.fixture', broker_token='synthetic-broker-secret',
            controller_url='https://controller.fixture', controller_token='synthetic-controller-secret',
            trading_config=self.trading, predictions={'2330': {'signal_raw': 'BUY', 'direction_accuracy': .85}},
            session_date='2026-09-07', transport=transport,
            debate_reader=self.debate,
            kv_read=lambda key: None, shadow_hmac_secret='synthetic-shadow-secret',
            shadow_scope=str(configured.get('LIVE_EXECUTION_SHADOW_SCOPE', '')))
        response = reader.frozen_fetch(request, frame=frame)
        return {'request': request, 'captured_at': frame['observed_at'], 'response': response}

    def fixture_response(self, operation, request, frame):
        assert operation == 'frozen_fetch'
        url = request['url']
        self.routes.append(url)
        observed = frame['observed_at']
        quote = {'status': 'ok', 'last': 100, 'price': 100, 'bid': 99.9, 'ask': 100,
                 'bid_volume': 1000, 'ask_volume': 1000, 'reference_price': 100,
                 'source_time': observed, 'confirmed_at': observed, 'received_at': observed,
                 'quote_age_ms': 0, 'source_age_ms': 0, 'low': 99.9, 'high': 100.5,
                 'open': 100, 'total_volume': 100000, 'session_epoch': 1,
                 'bid_prices': [99.9, 99.8, 99.7, 99.6, 99.5],
                 'ask_prices': [100, 100.1, 100.2, 100.3, 100.4],
                 'bid_volumes': [1000] * 5, 'ask_volumes': [1000] * 5}
        if self.price != 100:
            quote.update(last=self.price, price=self.price, bid=self.price - .5, ask=self.price,
                         low=98.8, high=105., total_volume=105,
                         bid_prices=[self.price - .5 * i for i in range(1, 6)],
                         ask_prices=[self.price + .5 * i for i in range(5)])
        if url == 'https://controller.fixture/finlab/execution/l5-market-data':
            assert json.loads(request['body'])['allow_broker_login'] is False
            body = {'status': 'pass', 'quotes': {'2330': quote},
                    'live_submit_enabled': False, 'can_submit_real_order': False}
        elif url == 'https://controller.fixture/finlab/execution/shadow-relay':
            assert json.loads(request['body'])['packet']['trade_date'] == '2026-09-07'
            body = {'status': 'blocked', 'reason': 'broker_account_not_this_private_account',
                    'live_submit_enabled': False, 'can_submit_real_order': False}
        elif url == 'https://controller.fixture/breeze2/fact_check':
            request_body = json.loads(request['body'])
            assert request_body['mutation_allowed'] is False and request_body['real_trading_allowed'] is False
            body = {'status': 'unavailable', 'reason': 'synthetic_no_additional_fact_check_evidence'}
        elif url == 'https://mis.taifex.com.tw/futures/api/getQuoteList':
            assert json.loads(request['body']) == {'CID': '', 'SymbolID': '', 'MarketType': '1'}
            body = {'RtData': {'QuoteList': [{'SymbolID': 'TXFF-M', 'CLastPrice': '22000', 'CRefPrice': '22000',
                                             'CDate': '20260905', 'CTime': '050000'}]}}
        elif url.startswith('https://broker.fixture/') and url.endswith(('/quotes', '/snapshots', '/orderbooks')):
            body = {'data': {'2330': quote}}
        elif url.startswith(('https://broker.fixture/orderbook/2330', 'https://broker.fixture/quote/2330',
                             'https://broker.fixture/snapshot/2330')):
            body = {**quote, 'data': quote}
        elif url.startswith('https://www.twse.com.tw/rwd/zh/announcement/'):
            body = {'stat': 'OK', 'data': []}
        elif url.startswith('https://www.tpex.org.tw/openapi/v1/tpex_'):
            body = []
        elif url == 'https://broker.fixture/trend/2330?minutes=5':
            body = {'slope_5min': .1}
        elif url.startswith('https://broker.fixture/kbars/2330?'):
            start = datetime.fromisoformat('2026-09-07T01:00:00+00:00')
            body = {'data': [{'ts': (start + timedelta(minutes=i)).isoformat(),
                             'open': 100, 'high': 100.5, 'low': 99.9, 'close': 100, 'volume': 1000}
                            for i in range(30)]}
            if self.bars is not None:
                query = parse_qs(urlparse(url).query)
                body = {'data': [bar for bar in self.bars if query['start'][0] <= bar['ts'][:10] <= query['end'][0]
                        and datetime.fromisoformat(bar['ts']) + timedelta(minutes=1) <= datetime.fromisoformat(observed)]}
        elif url.startswith('https://query1.finance.yahoo.com/v8/finance/chart/'):
            return {'request': request, 'captured_at': observed,
                    'response': {'body': '', 'status': 503, 'headers': {}}}
        else:
            raise AssertionError('Unregistered native entry input: ' + url)
        return {'request': request, 'captured_at': observed,
                'response': {'body': json.dumps(body), 'status': 200, 'headers': {}}}


def test_enabled_native_pending_entry_reaches_l5_without_formal_writes(native_runner):
    raw = entry_state()
    configured = tomllib.loads((ROOT / 'worker/wrangler.toml').read_text(encoding='utf-8'))['vars']
    variables = {**{k: str(v) for k, v in configured.items()},
                 'SHIOAJI_PROXY_URL': 'https://broker.fixture', 'ML_CONTROLLER_URL': 'https://controller.fixture',
                 'ML_CONTROLLER_SECRET': '__SEALED_CREDENTIAL__', 'PROXY_SERVICE_TOKEN': '__SEALED_CREDENTIAL__',
                 'LIVE_EXECUTION_HMAC_SECRET': '__SEALED_CREDENTIAL__'}
    frame = {'input_id': 'entry-0930', 'stage': 'intraday', 'observed_at': '2026-09-07T01:30:00Z'}
    source = EntrySources()
    args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=2,
                variables=variables, frames=[frame], runner=native_runner)
    try:
        result = run_native_paper_frames(**args, frame_inputs={frame['input_id']: frame}, capture_source=source)
    except RuntimeError as exc:
        raise AssertionError(str(exc) + '\nSynthetic routes: ' + repr(source.routes)) from exc
    with sqlite3.connect(':memory:') as db:
        db.executescript(result['state_sql'])
        events = db.execute('SELECT event_type,status,reason,detail_json FROM paper_execution_events').fetchall()
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
        assert 'https://controller.fixture/finlab/execution/l5-market-data' in source.routes, str(events)
        assert 'l5_status=pass' in str(events), 'Allocator did not consume the L5 result'
        structure = [json.loads(event[3]) for event in events if event[0] == 's12_intraday_structure']
        assert structure, str(events)
        assert structure[0]['barDiagnostics']['parsed_kbars_count'] == 30
        assert structure[0]['barDiagnostics']['invalid_kbars_count'] == 0
        assert structure[0]['state'] == 'waiting_15m_completed_bars'
        assert db.execute('SELECT COUNT(*) FROM paper_orders WHERE account_id=2').fetchone()[0] == 0
    replay = run_native_paper_frames(**args, frame_inputs=result['captured_inputs'])
    assert replay['state_checksum'] == result['state_checksum']
    assert result['frames'][0]['result']['nav_maturity_credit'] == 0


def ready_entry_case(whole_session):
    # Synthetic market bars exercise native structure detection; no ready flag
    # or hand-authored fill is supplied to the production engine.
    sequence = [(102., 102.2, 100.5, 101.), (101., 101.5, 99.8, 100.2),
                (100.2, 101., 98.8, 100.4), (100.5, 102.8, 100.4, 102.6),
                (102.6, 103., 100.2, 101.), (101., 104.8, 101., 104.5),
                (101.4, 103., 101.2, 102.8)]
    bars = []
    def expand(start, minutes, o, h, l, c):
        def tick(value):
            size = .5 if value >= 100 else .1
            return round(round(value / size) * size, 1)
        o, h, l, c = map(tick, (o, h, l, c))
        for i in range(minutes):
            close = tick(o + (c - o) * (i + 1) / minutes)
            opening = tick(o + (c - o) * i / minutes)
            bars.append({'ts': (start + timedelta(minutes=i)).isoformat(), 'open': opening,
                         'high': h if i == 1 else max(opening, close),
                         'low': l if i == 2 else min(opening, close), 'close': close, 'volume': 1000})
    expand(datetime.fromisoformat('2026-09-04T01:00:00+00:00'), 240, 100, 110, 98, 108)
    for index, prices in enumerate(sequence):
        expand(datetime.fromisoformat('2026-09-07T01:00:00+00:00') + timedelta(minutes=15 * index), 15, *prices)
    with sqlite3.connect(':memory:') as db:
        db.executescript(entry_state())
        db.execute('UPDATE paper_accounts SET cash=5000000,initial_cash=5000000 WHERE id=2')
        db.execute('DELETE FROM paper_settlements WHERE account_id=2')
        db.execute("INSERT INTO stock_prices(stock_id,date,open,high,low,close,volume) VALUES(1,'2026-09-04',100,110,98,100,270000)")
        if whole_session:
            db.execute("INSERT INTO stock_prices(stock_id,date,open,high,low,close,volume) VALUES(1,'2026-09-07',102,105,98.8,103,270000)")
            score = {'version': 'score_v2', 'components': {'mlEdge': 22, 'chipFlow': 22,
                     'technicalStructure': 22, 'fundamentalQuality': 12, 'newsTheme': 5}, 'finalScore': 85}
            allocation = {'engine': 'sparse_tangent_inverse_risk', 'selected': True, 'target_weight': .3}
            db.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,signal,confidence,reason,has_buy_signal,score_components,alpha_allocation) VALUES('2026-09-04',1,'2330','fixture',1,85,'BUY',.85,'synthetic frozen recommendation',1,?,?)",
                       (json.dumps(score), json.dumps(allocation)))
            db.execute("INSERT INTO predictions(stock_id,model_name,prediction_date,entry_price,stop_loss,target1,target2,generated_at,forecast_data) VALUES(1,'ensemble','2026-09-04',100,95,108,115,'2026-09-04T14:00:00Z','{}')")
        raw = '\n'.join(db.iterdump())
    configured = tomllib.loads((ROOT / 'worker/wrangler.toml').read_text(encoding='utf-8'))['vars']
    variables = {**{k: str(v) for k, v in configured.items()},
                 'SHIOAJI_PROXY_URL': 'https://broker.fixture', 'ML_CONTROLLER_URL': 'https://controller.fixture',
                 'ML_CONTROLLER_SECRET': '__SEALED_CREDENTIAL__', 'PROXY_SERVICE_TOKEN': '__SEALED_CREDENTIAL__',
                 'LIVE_EXECUTION_HMAC_SECRET': '__SEALED_CREDENTIAL__'}
    frame = {'input_id': 'entry-1045', 'stage': 'intraday', 'observed_at': '2026-09-07T02:45:00Z'}
    from services.paired_native_session import session_schedule, native_fills, validate_native_account
    frames = session_schedule('2026-09-07') if whole_session else [frame]
    source = EntrySources(bars, price=103.)
    return raw, variables, frames, source


@pytest.mark.parametrize('eligible_shares, expected_buy', [(100, True), (100000, False)])
def test_unpriced_right_after_parent_sale_allows_only_risk_safe_native_entry(native_runner, eligible_shares, expected_buy):
    from services.paired_nav_journal import _corporate_receivables
    from test_subscription_rights import action
    raw, variables, frames, market = ready_entry_case(False)
    _, rights = _corporate_receivables({'corporate_receivables': []}, [action()],
        {'2330': eligible_shares}, '2026-09-07')
    right = rights[0]
    with sqlite3.connect(':memory:') as db:
        db.executescript(raw)
        # Synthetic carried entitlement; no current parent position, no free
        # shares/cash and no NAV credit. Exercise the ORIGINAL entry engine.
        db.execute('''INSERT INTO paper_corporate_entitlements_v1
            (account_id,action_id,symbol,kind,ex_date,eligible_shares,cash_due,shares_due,
             whole_shares_due,share_cost_basis,terms_json,rights_json,settled,source_checksum,recognized_at)
            VALUES(2,?,?,?,?,?,0,0,0,0,'[]',?,0,?,'2026-09-07T00:00:00Z')''',
            [right[k] for k in ('action_id','symbol','kind','ex_date','eligible_shares','rights_json')] + ['a' * 64])
        raw = '\n'.join(db.iterdump())
    args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=2,
        variables=variables, frames=frames, runner=native_runner)
    result = run_native_paper_frames(**args, frame_inputs={f['input_id']: f for f in frames}, capture_source=market)
    with sqlite3.connect(':memory:') as db:
        db.executescript(result['state_sql'])
        buys = db.execute("SELECT COUNT(*) FROM paper_orders WHERE account_id=2 AND side='buy'").fetchone()[0]
        assert bool(buys) == expected_buy
        if not expected_buy:
            assert db.execute("SELECT COUNT(*) FROM paper_execution_events WHERE reason='subscription_valuation_risk_bound'").fetchone()[0] > 0
        assert db.execute('SELECT COUNT(*) FROM paper_corporate_entitlements_v1 WHERE settled=0').fetchone()[0] == 1
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
    assert run_native_paper_frames(**args, frame_inputs=result['captured_inputs'])['state_checksum'] == result['state_checksum']
    assert result['frames'][0]['result']['nav_maturity_credit'] == 0


@pytest.mark.parametrize('whole_session', [False, True])
def test_original_s12_ready_entry_executes_in_private_account(native_runner, whole_session):
    from services.paired_native_session import native_fills, validate_native_account
    raw, variables, frames, source = ready_entry_case(whole_session)
    args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=2,
                variables=variables, frames=frames, runner=native_runner)
    try:
        result = run_native_paper_frames(**args, frame_inputs={f['input_id']: f for f in frames}, capture_source=source)
    except RuntimeError as exc:
        raise AssertionError(str(exc) + '\nSynthetic routes: ' + repr(sorted(set(source.routes)))) from exc
    with sqlite3.connect(':memory:') as db:
        db.executescript(result['state_sql'])
        events = db.execute('SELECT event_type,status,reason,detail_json FROM paper_execution_events').fetchall()
        orders = db.execute('SELECT side,shares,price,commission FROM paper_orders WHERE account_id=2').fetchall()
        assert orders, repr({'events': events[:5], 'routes': sorted(set(source.routes)),
            'pending_runs': db.execute('SELECT trade_date,status,debate_status,meta_json FROM pending_buy_runs ORDER BY id DESC LIMIT 2').fetchall(),
            'llm_calls': len(source.llm_calls),
            'early_frames': result['frames'][:3]})
        assert sum(o[0] == 'buy' for o in orders) == 1 and orders[0][0] == 'buy' and orders[0][1] > 0
        assert orders[0][2] >= 103. and orders[0][3] > 0
        position = db.execute('SELECT shares,avg_cost FROM paper_positions WHERE account_id=2 AND symbol=\'2330\'').fetchone()
        if not whole_session:
            assert position is not None and position[0] == orders[0][1] and position[1] >= 103.
        structure = [json.loads(event[3]) for event in events if event[0] == 's12_intraday_structure']
        assert any(s['state'] in ('reaction_ready', 'limited_takeover_ready') for s in structure), str(structure)
        assert 'l5_status=pass' in str(events)
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
    replay = run_native_paper_frames(**args, frame_inputs=result['captured_inputs'])
    assert replay['state_checksum'] == result['state_checksum']
    assert result['frames'][0]['result']['nav_maturity_credit'] == 0
    if whole_session:
        from services.paired_nav_journal import replay_session
        fills = native_fills(result['frames'], 2)
        assert len(result['frames']) == 281 and any(f['side'] == 'buy' for f in fills)
        assert source.llm_calls  # Original private debate ran; no pre-approved pending flag.
        ledger = replay_session(previous={'cash': 5000000., 'nav': 5000000., 'positions': {}},
            fills=fills, marks={'2330': 103.}, corporate_actions=[], session_date='2026-09-07', fees=source.trading['fees'])
        validate_native_account(result['frames'][-1]['result']['valuation'], ledger)
