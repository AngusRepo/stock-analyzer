from copy import deepcopy
from datetime import datetime, timezone
import json
import sqlite3
import subprocess

import pytest

from services.paired_native_session import session_schedule, validate_schedule, native_fills, validate_native_account, run_paired_session
from services.native_paper_sandbox import native_execution_identity
from services.native_paper_sandbox import run_native_paper_frames
from services.paired_nav_journal import freeze_snapshot, digest, mature_staged_pairs
from test_native_paper_sandbox import native_runner, base_state, run, ROOT, checksum
from test_paired_nav_journal import DB


def test_full_schedule_includes_all_271_minutes_and_native_postclose():
    frames = session_schedule('2026-09-07')
    assert len([f for f in frames if f['stage'] == 'intraday']) == 271
    assert len(frames) == 281
    assert [f['stage'] for f in frames[-2:]] == ['postclose', 'snapshot']
    validate_schedule(frames, '2026-09-07')
    with pytest.raises(ValueError, match='full_schedule_mismatch'):
        validate_schedule(frames[:100] + frames[101:], '2026-09-07')
    with pytest.raises(ValueError, match='full_schedule_mismatch'):
        validate_schedule(frames + frames[-1:], '2026-09-07')


def test_native_fill_uses_recorded_tax_decision_and_utc_timestamp():
    item = {'result': {'account_id': 2, 'observed_at': '2026-09-07T02:00:00Z', 'orders': [
        {'id': 1, 'symbol': '2330', 'side': 'sell', 'shares': 100, 'price': 110,
         'commission': 20, 'tax': 17, 'note': json.dumps({'is_day_trade': True}), 'created_at': '2026-09-07 02:00:00'}]}}
    result = native_fills([item], 2)
    assert result[0]['is_day_trade'] is True
    assert result[0]['executed_at'] == '2026-09-07T02:00:00+00:00'
    with pytest.raises(ValueError, match='duplicate_order'):
        native_fills([item, item], 2)
    item['result']['orders'][0]['note'] = '{}'
    with pytest.raises(ValueError, match='tax_decision_missing'):
        native_fills([item], 2)


def test_native_valuation_cannot_claim_complete_with_unreconciled_cash_or_positions():
    account = {'cash': 100.0, 'nav': 1100.0, 'positions': {'2330': 10}}
    validate_native_account(account, account)
    for bad in ({**account, 'cash': 99}, {**account, 'nav': float('nan')}, {**account, 'positions': {}}):
        with pytest.raises(ValueError, match='not_reconcile'):
            validate_native_account(bad, account)


def native_config():
    # Compile the actual config owners; no hand-written reduced matching engine.
    script = """
const esbuild = require('esbuild');
const r = esbuild.buildSync({stdin:{contents:`import { buildChampionTradingConfig } from './src/lib/tradingConfig';
import { DEFAULT_RISK_CONFIG } from './src/lib/riskConfig';
console.log(JSON.stringify({trading:buildChampionTradingConfig(null),risk:DEFAULT_RISK_CONFIG}));`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
eval(r.outputFiles[0].text);
"""
    result = subprocess.run(['node', '-e', script], cwd=ROOT / 'worker', capture_output=True, text=True, check=True)
    config = json.loads(result.stdout)
    config['risk']['system']['killSwitch'] = True  # Explicit all-cash safety scenario, not missing input.
    return config


def full_cash_state(config):
    with sqlite3.connect(':memory:') as db:
        db.executescript(base_state())
        for path in ('core/0001_core_baseline.sql',
                     'market/0001_market_baseline.sql', 'market/0002_runtime_owned_tables.sql',
                     'market/0004_legacy_schema_alignment.sql',
                     'learning/0001_learning_baseline.sql', 'learning/0031_s12_profit_continuation_serving_owner.sql',
                     'paper/0002_runtime_owned_tables.sql',
                     'paper/0003_paper_kelly_calibration.sql',
                     'ops/0001_ops_baseline.sql', 'ops/0002_runtime_owned_tables.sql',
                     'ops/0005_ops_artifact_compute_cost_runtime.sql',
                     'execution/0001_execution_baseline.sql', 'execution/0002_runtime_owned_tables.sql'):
            db.executescript((ROOT / 'worker/domain-migrations' / path).read_text(encoding='utf-8'))
        db.executescript('CREATE TABLE IF NOT EXISTS _native_private_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_ms REAL,metadata TEXT);')
        # Existing legacy schema delta is present in the real bootstrap snapshot.
        db.executescript((ROOT / 'worker/migration_trade_signal_expand.sql').read_text(encoding='utf-8'))
        for key, value in [('trading:config', config['trading']), ('trading:risk_config', config['risk'])]:
            db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)', (key, json.dumps(value)))
        return '\n'.join(db.iterdump())


def test_actual_native_whole_cash_session_is_deterministic(native_runner):
    config = native_config()
    raw = full_cash_state(config)
    frames = session_schedule('2026-09-07')
    first = run(native_runner, raw, frames)
    second = run(native_runner, raw, frames)
    assert first['state_checksum'] == second['state_checksum']
    assert len(first['frames']) == len(frames)
    valuation = first['frames'][-1]['result']['valuation']
    assert valuation['positions'] == {}
    assert valuation['cash'] == valuation['nav'] == 99000
    assert native_fills(first['frames'], 2) == []


@pytest.mark.parametrize('capture_delay_seconds,formal_flags', [(0, False), (10, False), (0, True)])
def test_actual_native_held_position_whole_session_exits_and_reconciles(native_runner, capture_delay_seconds, formal_flags):
    from services.paired_nav_journal import replay_session
    config = native_config()
    with sqlite3.connect(':memory:') as db:
        db.executescript(full_cash_state(config))
        db.executescript("""
          INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE'),(2,'0050','fixture','TWSE');
          INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop)
          VALUES(2,'2330','fixture',100,100,100,'2026-09-01',99,99);
        """)
        raw = '\n'.join(db.iterdump())
    frames = session_schedule('2026-09-07')
    source_routes = []

    class BrokerFixture:
        # Synthetic external market data, not a synthetic fill. Every sell,
        # fee, tax and settlement below is produced by the ORIGINAL engine.
        def read(self, operation, request, frame):
            from datetime import timedelta
            captured_at = (datetime.fromisoformat(frame['observed_at']) + timedelta(seconds=capture_delay_seconds)).isoformat()
            assert operation == 'frozen_fetch'
            source_routes.append(request['url'])
            quote = {'status': 'ok', 'last': 98, 'bid': 98, 'ask': 98.1,
                'bid_volume': 1000, 'ask_volume': 1000, 'reference_price': 100,
                'source_time': captured_at, 'confirmed_at': captured_at,
                'quote_age_ms': 0, 'source_age_ms': 0, 'low': 98, 'high': 100, 'open': 100,
                'total_volume': 100000, 'session_epoch': 1}
            url = request['url']
            if url == 'https://controller.fixture/finlab/execution/l5-market-data':
                assert json.loads(request['body'])['allow_broker_login'] is False
                body = {'status': 'ok', 'quotes': {'2330': {**quote, 'price': 98,
                    'bid_prices': [98, 97.9, 97.8, 97.7, 97.6], 'ask_prices': [98.1, 98.2, 98.3, 98.4, 98.5],
                    'bid_volumes': [1000] * 5, 'ask_volumes': [1000] * 5,
                    'received_at': captured_at, 'provider': 'finlab_sinopac'}},
                    'live_submit_enabled': False, 'can_submit_real_order': False}
            elif url.startswith('https://broker.fixture/') and ('/orderbooks' in url or url.endswith(('/quotes', '/snapshots'))):
                if request['body'] and json.loads(request['body']).get('lot_type') == 'odd_lot':
                    quote['lot_type'] = 'odd_lot'
                body = {'data': {'2330': quote}}
            elif '/orderbook/2330' in url or '/quote/2330' in url:
                if 'odd_lot' in url:
                    quote['lot_type'] = 'odd_lot'
                body = {'data': quote}
            else:
                raise AssertionError('Unregistered native broker input: ' + url)
            return {'request': request, 'captured_at': captured_at,
                'response': {'body': json.dumps(body), 'status': 200, 'headers': {}}}

    variables = {'SHIOAJI_PROXY_URL': 'https://broker.fixture'}
    if formal_flags:
        import tomllib
        configured = tomllib.loads((ROOT / 'worker/wrangler.toml').read_text(encoding='utf-8'))['vars']
        variables = {**{k: str(v) for k, v in configured.items()}, **variables,
            'ML_CONTROLLER_URL': 'https://controller.fixture',
            'ML_CONTROLLER_SECRET': '__SEALED_CREDENTIAL__', 'PROXY_SERVICE_TOKEN': '__SEALED_CREDENTIAL__',
            'LIVE_EXECUTION_HMAC_SECRET': '__SEALED_CREDENTIAL__'}
        assert variables['FINLAB_L5_MARKET_DATA_ENABLED'] == '1'
        assert variables['LIVE_EXECUTION_SHADOW_CLIENT_ENABLED'] == '1'
        assert variables['LIVE_EXECUTION_SHADOW_GUARD_ENABLED'] == '0'
    kwargs = dict(state_sql=raw, state_checksum=checksum(raw), account_id=2,
        variables=variables, frames=frames, runner=native_runner)
    result = run_native_paper_frames(**kwargs, frame_inputs={f['input_id']: f for f in frames}, capture_source=BrokerFixture())
    fills = native_fills(result['frames'], 2)
    if not fills:
        with sqlite3.connect(':memory:') as inspected:
            inspected.executescript(result['state_sql'])
            events = inspected.execute('SELECT reason FROM paper_execution_events LIMIT 5').fetchall()
        pytest.fail('No original native fill: ' + repr(events))
    assert sum(fill['shares'] for fill in fills if fill['side'] == 'sell') == 100
    if formal_flags:
        # L5 enrichment is an entry path, not the held-position exit path.
        # Prove the actually enabled shadow observer executed; the configured
        # emergency buy kill-switch still permits native protective sells.
        with sqlite3.connect(':memory:') as inspected:
            inspected.executescript(result['state_sql'])
            count = inspected.execute("SELECT COUNT(*) FROM paper_execution_events WHERE event_type='live_execution_shadow'").fetchone()[0]
        assert count > 0
    assert all(datetime.fromisoformat(fill['executed_at']).second == capture_delay_seconds for fill in fills)
    ledger = replay_session(previous={'cash': 99000, 'positions': {'2330': 100}, 'nav': 109000},
        fills=fills, marks={}, corporate_actions=[], session_date='2026-09-07', fees=config['trading']['fees'])
    validate_native_account(result['frames'][-1]['result']['valuation'], ledger)
    replay = run_native_paper_frames(**kwargs, frame_inputs=result['captured_inputs'])
    assert replay['state_checksum'] == result['state_checksum']


def paired_fixture(native_runner):
    db = DB()
    config = native_config()
    raw = full_cash_state(config)
    schedule = session_schedule('2026-09-07')
    configuration = {'trading_config': config['trading'], 'risk_config': config['risk'],
                     'fees': config['trading']['fees'], 'allocator_source_identity': {'fixture': 'test-only'}}
    initial = {'cash': 99000, 'nav': 99000, 'positions': {}, 'marks': {}}
    packet = {'pair_id': 'actual-native-fixture', 'candidate_checksum': 'c' * 64, 'baseline_checksum': 'b' * 64,
        'execution_owner_version': native_execution_identity(native_runner), 'configuration': configuration,
        'configuration_checksum': digest(configuration), 'fees': configuration['fees'],
        'initial_account': initial, 'initial_state_checksums': {arm: checksum(raw) for arm in ('baseline', 'candidate')},
        'account_id': 2, 'variables': {}, 'schedule': schedule, 'previous_session_date': None,
        'session_date': '2026-09-07', 'session_open_at': '2026-09-07T01:00:00Z', 'session_close_at': '2026-09-07T05:30:00Z'}
    seal = freeze_snapshot(signal_date='2026-09-04', source_run_id=packet['pair_id'], snapshot_kind='execution_pair',
        content=packet, query=db.query, writer=db.writer, now=datetime(2026, 9, 4, 14, tzinfo=timezone.utc))
    source = {'session_date': '2026-09-07', 'complete': True, 'schedule_checksum': digest(schedule),
        'closed_at': '2026-09-07T06:20:00Z', 'corporate_actions_complete': True,
        'corporate_actions': [], 'closing_marks': {}}
    return db, {'snapshot_id': seal['snapshot_id'], 'runner': native_runner,
        'now': datetime(2026, 9, 7, 7, tzinfo=timezone.utc), 'query': db.query, 'writer': db.writer,
        'tapes': {arm: {'frames': {f['input_id']: f for f in schedule}, 'source_receipt': deepcopy(source)}
                  for arm in ('baseline', 'candidate')},
        'states': {arm: {'state_sql': raw, 'state_checksum': checksum(raw)} for arm in ('baseline', 'candidate')}}


def test_actual_two_native_sessions_publish_once_then_nightly_materialize(native_runner):
    db, args = paired_fixture(native_runner)
    first = run_paired_session(**args)
    second = run_paired_session(**args)
    assert first['receipt_snapshot_id'] == second['receipt_snapshot_id']
    assert first['states'] == second['states']
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    result = mature_staged_pairs(business_date='2026-09-07', query=db.query, writer=db.writer, now=args['now'])
    assert result['processed_pair_sessions'] == 1
    row = db.query('SELECT payload_json FROM paired_nav_daily_journal_v1', [])[0]
    payload = json.loads(row['payload_json'])
    assert payload['net_return_delta'] == 0
    assert payload['arms']['candidate']['nav'] == 99000
    assert payload['promotion_allowed'] is False
    assert payload['ev_prediction_dates_added'] == 0
    assert mature_staged_pairs(business_date='2026-09-07', query=db.query, writer=db.writer,
                               now=args['now'])['processed_pair_sessions'] == 0


@pytest.mark.parametrize('failure', ['missing_frame', 'second_arm_failure', 'mismatched_mark', 'no_actions_coverage'])
def test_partial_or_invalid_native_pair_never_publishes(native_runner, failure):
    db, args = paired_fixture(native_runner)
    candidate = args['tapes']['candidate']
    if failure == 'missing_frame':
        candidate['frames'].pop(next(iter(candidate['frames'])))
    elif failure == 'second_arm_failure':
        key = next(iter(candidate['frames']))
        candidate['frames'][key] = {**candidate['frames'][key], 'stage': 'bad'}
    elif failure == 'mismatched_mark':
        candidate['source_receipt']['closing_marks'] = {'2330': 100}
    else:
        for tape in args['tapes'].values():
            tape['source_receipt']['corporate_actions_complete'] = False
    with pytest.raises(ValueError):
        run_paired_session(**args)
    assert db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt'", []) == []
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
