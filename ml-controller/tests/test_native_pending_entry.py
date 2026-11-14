"""Original native pending-entry path; synthetic inputs, never promotion data."""
import functools
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tomllib
from datetime import date, datetime, timedelta
from urllib.parse import urlparse, parse_qs
from types import SimpleNamespace
import pytest

from services.native_paper_sandbox import run_native_paper_frames
from services.native_paper_read_capabilities import NativeReadCapabilities
from services.hmm_input_contract import CONTRACT_HASH
from test_native_paper_sandbox import ROOT, checksum, native_runner
from test_paired_native_session import full_cash_state, native_config


def session_minutes(day, price):
    start = datetime.fromisoformat(day + 'T01:00:00+00:00')
    return [{'ts': (start + timedelta(minutes=i)).isoformat(), 'open': price, 'high': price,
             'low': price, 'close': price, 'volume': 1000} for i in range(270)]


# Flat 0050 benchmark: zero session return, so relative strength is the stock's own move.
BENCHMARK_BARS = session_minutes('2026-09-04', 50.) + session_minutes('2026-09-07', 50.)


def completed_bars(bars, url, observed):
    query = parse_qs(urlparse(url).query)
    return [bar for bar in bars if query['start'][0] <= bar['ts'][:10] <= query['end'][0]
            and datetime.fromisoformat(bar['ts']) + timedelta(minutes=1) <= datetime.fromisoformat(observed)]


def entry_state():
    config = native_config()
    config['risk']['system']['killSwitch'] = False
    with sqlite3.connect(':memory:') as db:
        db.executescript(full_cash_state(config))
        db.executescript((ROOT / 'worker/domain-migrations/market/0005_market_regime_state_history.sql').read_text(encoding='utf8'))
        # bdf904c74: regime reads union the append-only revisions table (same as l4NativeFixture).
        db.executescript((ROOT / 'worker/domain-migrations/market/0010_market_regime_state_revisions.sql').read_text(encoding='utf8'))
        # The swing entry path reads the premarket plan, rotation audit and ATR-once tables.
        for path in ('0007_daily_plan_reviews.sql', '0008_rotation_audit.sql', '0009_atr_once.sql'):
            db.executescript((ROOT / 'worker/domain-migrations/paper' / path).read_text(encoding='utf8'))
        db.executescript("""
          INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status)
            VALUES('2026-09-04','pipeline_execution','synthetic-fixture-pipeline','success');
          INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE');
          INSERT INTO model_accuracy(stock_id,model_name,period,total_count,correct_count,accuracy)
            VALUES(1,'LightGBM','30d',100,70,.7);
          INSERT INTO market_risk(date,twii_close,risk_score,risk_level)
            VALUES('2026-09-04',22000,10,'green'),('2026-09-03',21900,10,'green');
          INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-04',.8,80);
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
        # 0050 benchmark: 60 prior sessions, last close above its MA60 (swing market filter).
        db.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(2,'0050','benchmark','TWSE')")
        day, sessions = date(2026, 9, 4), []
        while len(sessions) < 60:
            if day.weekday() < 5:
                sessions.append(day.isoformat())
            day -= timedelta(days=1)
        db.executemany('INSERT INTO stock_prices(stock_id,date,open,high,low,close,volume) VALUES(2,?,?,?,?,?,1000000)',
                       [(d, *[50. if d == '2026-09-04' else 48.] * 4) for d in sessions])
        db.execute('INSERT INTO market_risk_quality_v1 VALUES(?,?,?,?,?,?,?,?)',
                   ('2026-09-04', 'market-risk-quality-v1', 'complete', 10, 10, RISK_QUALITY_JSON,
                    RISK_QUALITY_CHECKSUM, '2026-09-04T14:00:00Z'))
        regime = {'schema_version': 'market-regime-state-v1', 'label': 'bull',
                  'run_date': '2026-09-04', 'source': 'hmm', 'computed_at': '2026-09-04T14:00:00Z',
                  # Fixed fixture times: the P3 gate compares them with the frame clock, never wall time.
                  'regime_evidence': {'hmm_provenance': {
                      'feature_date': '2026-09-04', 'input_contract': CONTRACT_HASH, 'input_checksum': 'a' * 64,
                      'risk_quality_checksum': RISK_QUALITY_CHECKSUM, 'inference_as_of': '2026-09-04T13:30:00Z',
                      'model': {'sha256': 'b' * 64, 'generation': '1', 'input_contract': CONTRACT_HASH,
                                'trained_at': '2026-09-04T00:00:00Z'}}}}
        db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)', ('market_regime_state', json.dumps(regime)))
        # Production registers the native private account as account_id=1, the only
        # account an L4 plan may belong to. Account 2 stays as an untouched sentinel.
        db.execute('UPDATE paper_accounts SET cash=5000000,initial_cash=5000000 WHERE id=1')
        db.execute('DELETE FROM paper_settlements WHERE account_id=1')
        policy, envelope = l4_envelope()
        plan = envelope['plan']
        config['trading']['l4Distribution'] = policy
        db.execute("UPDATE _native_private_kv SET value=? WHERE key='trading:config'", (json.dumps(config['trading']),))
        db.execute("""INSERT INTO active8_ensemble_artifacts_v1(artifact_id,cohort_id,training_run_id,knowledge_cutoff_date,
            schema_version,payload_json,payload_checksum,base_artifact_set_checksum,validation_decision,validation_json,
            archive_uri,state,production_effect) VALUES(?,?,'fixture-run','2026-09-04',
            'active8-oof-ensemble-serving-artifact-v1',?,?,?,'PASS','{}','gs://fixture/l3','production',1)""",
            [L3_IDENTITY['artifact_id'], L3_IDENTITY['cohort_id'], json.dumps(L3_PAYLOAD),
             L3_IDENTITY['payload_checksum'], L3_IDENTITY['base_artifact_set_checksum']])
        db.execute("""INSERT INTO active8_ensemble_pointer_v1(singleton_id,artifact_id,cohort_id,payload_checksum,
            base_artifact_set_checksum,promotion_reason) VALUES(1,?,?,?,?,'fixture')""",
            [L3_IDENTITY[k] for k in ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')])
        db.execute('INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json) VALUES(?,1,?,?,1,?,?)',
                   (plan['plan_id'], plan['signal_date'], plan['policy_identity'], envelope['allocation_snapshot_id'], json.dumps(plan)))
        db.execute('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1', (plan['plan_id'],))
        # The 07:00 premarket seal (PAPER_DAILY_PLAN_OWNER=premarket_once_v1); no native stage seals it.
        review = sealed_review(json.dumps(plan))
        db.execute('INSERT INTO paper_daily_plan_reviews_v1(account_id,trade_date,checksum,plan_id,previous_hash,revision,payload_json) VALUES(1,?,?,?,NULL,0,?)',
                   ('2026-09-07', review['checksum'], plan['plan_id'], json.dumps(review)))
        db.execute('INSERT INTO paper_daily_plan_heads_v1 VALUES(1,?,?,?)', ('2026-09-07', review['checksum'], plan['plan_id']))
        db.execute('UPDATE pending_buy_items SET watch_points_json=?', (json.dumps(['l4_plan:' + plan['plan_id']]),))
        # 07:00 premarket evidence; the 08:50 advisory debate waits for it.
        news, us_signal = premarket_evidence()
        db.executemany('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)',
                       [('market:news_analyst:2026-09-07', news), ('us:leading:2026-09-07', us_signal)])
        return '\n'.join(db.iterdump())


def risk_quality_record():
    """A market-risk-quality-v1 record matching the fixture market_risk rows."""
    days, day = [], date(2026, 9, 4)
    while len(days) < 21:
        if day.weekday() < 5:
            days.insert(0, day.isoformat())
        day -= timedelta(days=1)
    sessions = [{'date': d, 'close': 22000 if d == '2026-09-04' else 21900, 'source': 'finlab.taiex_total_index'}
                for d in days]
    content = {'schema_version': 'market-risk-quality-v1', 'date': '2026-09-04', 'status': 'complete',
               'known_score': 10, 'upper_score': 10, 'missing': [], 'critical_missing': [],
               'sources': {'benchmark': {'source': 'finlab.taiex_total_index', 'sessions': sessions}}}
    # Same canonical form as the Worker's canonicalRiskJson: sorted keys, no whitespace.
    text = json.dumps(content, sort_keys=True, separators=(',', ':'))
    return text, hashlib.sha256(text.encode()).hexdigest()


RISK_QUALITY_JSON, RISK_QUALITY_CHECKSUM = risk_quality_record()
# hmmLineage() of the fixture regime state; recommendations carry it from the signal date.
HMM_LINEAGE = {'modelSha256': 'b' * 64, 'modelGeneration': '1', 'inputChecksum': 'a' * 64,
               'qualityChecksum': RISK_QUALITY_CHECKSUM}
# Serving L3 named by both the L4 plan and the active8 pointer.
L3_IDENTITY = {'artifact_id': 'l3-fixture', 'cohort_id': 'cohort-fixture', 'payload_checksum': 'c' * 64,
               'base_artifact_set_checksum': 'd' * 64}
# Published eight-model roster; P2 reads model_accuracy for these names.
L3_PAYLOAD = {'payload_checksum': L3_IDENTITY['payload_checksum'],
              'model_order': ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']}


@functools.cache
def l4_envelope():
    """Plan from the real L4/OPB allocator, via the worker swing chain test's adapter."""
    from test_l4_distribution_runtime import fixture
    account = {**fixture()[1]['runtime']['account'], 'signal_date': '2026-09-04', 'nav': 5000000,
               'available_cash': 5000000, 'forbidden_buys': [], 'observed_at': '2026-09-04T14:00:00+00:00'}
    request = {'account': account, 'identity': L3_IDENTITY, 'hmm_lineage': HMM_LINEAGE,
               'constraints': {'name_cap': .3, 'max_positions': 5}}
    result = subprocess.run([sys.executable, '-B', str(ROOT / 'ml-controller/tests/l4_native_chain_allocator.py')],
                            input=json.dumps(request), capture_output=True, text=True, check=True)
    parsed = json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{"policy"')))
    return parsed['policy'], parsed['envelope']


@functools.cache
def premarket_evidence():
    """A news-evidence-v2 report assembled like runDailyNewsAnalysis, validated by parseReportJson."""
    script = """
const esbuild = require('esbuild');
const r = esbuild.buildSync({stdin:{contents:`import { parseReportJson } from './src/lib/newsAnalyst';
import { NEWS_FEATURES } from './src/lib/newsEvidence';
import { createHash } from 'node:crypto';
const date='2026-09-07', cutoff='2026-09-06T23:00:00.000Z', at='2026-09-06T22:00:00.000Z';
const evidence=[{id:'news:1',title:'Fixture supplier orders steady',summary:'Synthetic supplier update',
  url:'https://example.com/fixture',source:'fixture',published_at:'2026-09-06T20:00:00.000Z',observed_at:at}];
const raw={bias:'neutral',confidence:.5,key_factors:['Orders steady [news:1]'],sector_bias:{semiconductor:.2},
  sector_evidence:{semiconductor:['news:1']},risk_factors:['Demand risk [news:1]'],summary:'Synthetic fixture report',
  assessments:[{evidence_ids:['news:1'],features:Object.fromEntries(NEWS_FEATURES.map(k=>[k,null])),rationale:'Synthetic'}]};
const parsed=parseReportJson(JSON.stringify(raw),evidence);
if(!parsed)throw new Error('fixture_news_report_invalid');
const us={date,sox_close:5000,gspc_close:5000,vix_close:20,source_times:{sox:at,gspc:at,vix:at}};
const night={lastPrice:22000,changePct:0,changePoints:0,date:'20260904',time:'050000'};
const report={...parsed,date,source:'cloudflare_workers_ai:fixture',schema_version:'news-evidence-v2',status:'ready',cutoff,evidence,
  macro_evidence:{us_signal:us,taifex_night:night,market_risk:null,market_breadth:null}};
const sha256=createHash('sha256').update(JSON.stringify(report)).digest('hex');
report.evidence_receipt={key:'premarket-news/v2/'+date+'/'+sha256+'.json',sha256};
console.log(JSON.stringify([JSON.stringify(report),JSON.stringify(us)]));`,
  resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
eval(r.outputFiles[0].text);
"""
    result = subprocess.run(['node', '-e', script], cwd=ROOT / 'worker', capture_output=True, text=True, check=True)
    return tuple(json.loads(result.stdout))


@functools.cache
def sealed_review(plan_json):
    """Production sealDailyReview for trade date 2026-09-07, sealed at 07:00 TW."""
    script = """
const esbuild = require('esbuild');
const r = esbuild.buildSync({stdin:{contents:`import { sealDailyReview } from './src/lib/paperDailyPlan';
sealDailyReview({plan:JSON.parse(process.env.PLAN),tradeDate:'2026-09-07',contextHash:'f'.repeat(64),
  nowMs:Date.parse('2026-09-07T07:00:00+08:00'),restrictions:[]}).then(r=>console.log(JSON.stringify(r)));`,
  resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
eval(r.outputFiles[0].text);
"""
    result = subprocess.run(['node', '-e', script], cwd=ROOT / 'worker', capture_output=True, text=True, check=True,
                            env={**os.environ, 'PLAN': plan_json})
    return json.loads(result.stdout)


class EntrySources:
    def __init__(self, bars=None, price=100):
        self.routes = []
        self.bars = bars
        self.price = price
        self.trading = native_config()['trading']
        from services.native_paper_debate import NativeCapturedDebate
        from services.native_paper_source_capture import NativeSourceCapture, ImmutableNativeObjects
        from services.llm_debate_client import DEBATE_MODEL_POLICY
        from test_native_paper_source_capture import Bucket
        self.llm_calls = []
        def provider(request):
            self.llm_calls.append(request)
            return {'text': 'VERDICT: APPROVE | CONVICTION: 85\nSynthetic evidence.', 'source': 'cloudflare_workers_ai:' + request['model'], 'usage': []}
        capture = NativeSourceCapture(objects=ImmutableNativeObjects(Bucket()), clock=lambda: self.observed,
                                      domain_queries={}, inference_reads={'native_debate_llm': provider})
        self.debate = NativeCapturedDebate(source_capture=capture, max_rounds=3,
                                          session_date='2026-09-07', model_name=DEBATE_MODEL_POLICY)

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
            research_url='https://research.fixture',
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
        elif url == 'https://broker.fixture/orderbook/watchlist':
            symbols = json.loads(request['body'])['symbols']
            body = {'status': 'ok', 'count': len(symbols), 'symbols': symbols, 'lot_type': 'odd_lot'}
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
                body = {'data': completed_bars(self.bars, url, observed)}
        elif url.startswith('https://broker.fixture/kbars/0050?'):
            body = {'data': completed_bars(BENCHMARK_BARS, url, observed)}
        elif url.startswith(('https://research.fixture/kbars/2330?', 'https://research.fixture/kbars/0050?')):
            # The research service labels each minute by its close (09:01 covers 09:00-09:01).
            bars = BENCHMARK_BARS if '/kbars/0050?' in url else self.bars or []
            body = {'data': [{**bar, 'ts': (datetime.fromisoformat(bar['ts']) + timedelta(minutes=1)).isoformat()}
                             for bar in completed_bars(bars, url, observed)]}
        elif url.startswith('https://query1.finance.yahoo.com/v8/finance/chart/'):
            return {'request': request, 'captured_at': observed,
                    'response': {'body': '', 'status': 503, 'headers': {}}}
        else:
            raise AssertionError('Unregistered native entry input: ' + url)
        return {'request': request, 'captured_at': observed,
                'response': {'body': json.dumps(body), 'status': 200, 'headers': {}}}


def test_enabled_native_pending_entry_waits_for_swing_signal_without_formal_writes(native_runner):
    raw = entry_state()
    configured = tomllib.loads((ROOT / 'worker/wrangler.toml').read_text(encoding='utf-8'))['vars']
    variables = {**{k: str(v) for k, v in configured.items()},
                 'SHIOAJI_PROXY_URL': 'https://broker.fixture', 'ML_CONTROLLER_URL': 'https://controller.fixture',
                 'S12_RESEARCH_KBARS_URL': 'https://research.fixture',
                 'ML_CONTROLLER_SECRET': '__SEALED_CREDENTIAL__', 'PROXY_SERVICE_TOKEN': '__SEALED_CREDENTIAL__',
                 'LIVE_EXECUTION_HMAC_SECRET': '__SEALED_CREDENTIAL__'}
    frame = {'input_id': 'entry-0930', 'stage': 'intraday', 'observed_at': '2026-09-07T01:30:00Z'}
    source = EntrySources()
    args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=1,
                variables=variables, frames=[frame], runner=native_runner)
    try:
        result = run_native_paper_frames(**args, frame_inputs={frame['input_id']: frame}, capture_source=source)
    except RuntimeError as exc:
        raise AssertionError(str(exc) + '\nSynthetic routes: ' + repr(source.routes)) from exc
    with sqlite3.connect(':memory:') as db:
        db.executescript(result['state_sql'])
        events = db.execute('SELECT event_type,status,reason,detail_json FROM paper_execution_events').fetchall()
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 90000
        # Flat 09:00-09:30 bars: the sealed plan authorizes 2330, but the swing
        # owner defers until its first signal; allocator and L5 are not consulted.
        decisions = [json.loads(event[3]) for event in events if event[0] == 'intraday_technical_decision']
        decisions = [d for d in decisions if d.get('owner') == variables['PAPER_INTRADAY_ENTRY_OWNER']]
        assert decisions, str(events)
        decision = decisions[0]
        assert decision['s12_role'] == 'not_in_entry_path' and decision['bar_error'] is None
        assert decision['signal']['action'] == 'defer'
        assert decision['signal']['reason'] == 'swing_atr_waiting_first_signal'
        assert decision['signal']['conditions']['plan'] is True and decision['signal']['conditions']['bars'] is True
        assert not any(event[0] == 's12_intraday_structure' for event in events)
        assert not any(event[0] == 'finlab_l5_market_data' for event in events)
        assert db.execute('SELECT COUNT(*) FROM paper_orders WHERE account_id=1').fetchone()[0] == 0
    replay = run_native_paper_frames(**args, frame_inputs=result['captured_inputs'])
    assert replay['state_checksum'] == result['state_checksum']
    assert result['frames'][0]['result']['nav_maturity_credit'] == 0


def ready_entry_case(whole_session):
    # Synthetic five-minute blocks for the production swing entry (OR15 touch,
    # VWAP, relative strength, ATR first signal); no ready flag or hand-authored
    # fill is supplied. The opening range tops at 102, the stock holds 101-101.5,
    # then breaks out at 09:45 (delta 1.5 > 1.5 x ATR5 of 0.7) and holds 103.
    sequence = ([(100., 102., 100., 101.5), (101.5, 101.5, 101., 101.), (101., 101.5, 101., 101.)]
                + [(101., 101.5, 101., 101.)] * 6 + [(101., 102.5, 101., 102.5), (102.5, 103.5, 102.5, 103.)]
                + [(103., 103.5, 102.5, 103.)] * 11)
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
        expand(datetime.fromisoformat('2026-09-07T01:00:00+00:00') + timedelta(minutes=5 * index), 5, *prices)
    with sqlite3.connect(':memory:') as db:
        db.executescript(entry_state())
        db.execute("INSERT INTO stock_prices(stock_id,date,open,high,low,close,volume) VALUES(1,'2026-09-04',100,110,98,100,270000)")
        if whole_session:
            db.execute("INSERT INTO stock_prices(stock_id,date,open,high,low,close,volume) VALUES(1,'2026-09-07',102,105,98.8,103,270000)")
            score = {'version': 'score_v2', 'components': {'mlEdge': 22, 'chipFlow': 22,
                     'technicalStructure': 22, 'fundamentalQuality': 12, 'newsTheme': 5}, 'finalScore': 85}
            allocation = {'engine': 'sparse_tangent_inverse_risk', 'selected': True, 'target_weight': .3,
                          'hmm_lineage': HMM_LINEAGE}
            db.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,signal,confidence,reason,has_buy_signal,score_components,alpha_allocation) VALUES('2026-09-04',1,'2330','fixture',1,85,'BUY',.85,'synthetic frozen recommendation',1,?,?)",
                       (json.dumps(score), json.dumps(allocation)))
            db.execute("INSERT INTO predictions(stock_id,model_name,prediction_date,entry_price,stop_loss,target1,target2,generated_at,forecast_data) VALUES(1,'ensemble','2026-09-04',100,95,108,115,'2026-09-04T14:00:00Z','{}')")
        raw = '\n'.join(db.iterdump())
    configured = tomllib.loads((ROOT / 'worker/wrangler.toml').read_text(encoding='utf-8'))['vars']
    variables = {**{k: str(v) for k, v in configured.items()},
                 'SHIOAJI_PROXY_URL': 'https://broker.fixture', 'ML_CONTROLLER_URL': 'https://controller.fixture',
                 'S12_RESEARCH_KBARS_URL': 'https://research.fixture',
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
            VALUES(1,?,?,?,?,?,0,0,0,0,'[]',?,0,?,'2026-09-07T00:00:00Z')''',
            [right[k] for k in ('action_id','symbol','kind','ex_date','eligible_shares','rights_json')] + ['a' * 64])
        raw = '\n'.join(db.iterdump())
    args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=1,
        variables=variables, frames=frames, runner=native_runner)
    result = run_native_paper_frames(**args, frame_inputs={f['input_id']: f for f in frames}, capture_source=market)
    with sqlite3.connect(':memory:') as db:
        db.executescript(result['state_sql'])
        buys = db.execute("SELECT COUNT(*) FROM paper_orders WHERE account_id=1 AND side='buy'").fetchone()[0]
        assert bool(buys) == expected_buy
        if not expected_buy:
            assert db.execute("SELECT COUNT(*) FROM paper_execution_events WHERE reason='p9_intraday_drawdown_halt'").fetchone()[0] > 0
        assert db.execute('SELECT COUNT(*) FROM paper_corporate_entitlements_v1 WHERE settled=0').fetchone()[0] == 1
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 90000
    assert run_native_paper_frames(**args, frame_inputs=result['captured_inputs'])['state_checksum'] == result['state_checksum']
    assert result['frames'][0]['result']['nav_maturity_credit'] == 0


@pytest.mark.parametrize('whole_session', [False, True])
def test_swing_ready_entry_executes_in_private_account(native_runner, whole_session):
    from services.paired_native_session import native_fills, validate_native_account
    raw, variables, frames, source = ready_entry_case(whole_session)
    args = dict(state_sql=raw, state_checksum=checksum(raw), account_id=1,
                variables=variables, frames=frames, runner=native_runner)
    try:
        result = run_native_paper_frames(**args, frame_inputs={f['input_id']: f for f in frames}, capture_source=source)
    except RuntimeError as exc:
        raise AssertionError(str(exc) + '\nSynthetic routes: ' + repr(sorted(set(source.routes)))) from exc
    with sqlite3.connect(':memory:') as db:
        db.executescript(result['state_sql'])
        events = db.execute('SELECT event_type,status,reason,detail_json FROM paper_execution_events').fetchall()
        orders = db.execute('SELECT side,shares,price,commission FROM paper_orders WHERE account_id=1').fetchall()
        assert orders, repr({'events': events[:5], 'routes': sorted(set(source.routes)),
            'pending_runs': db.execute('SELECT trade_date,status,debate_status,error_message FROM pending_buy_runs ORDER BY id DESC LIMIT 2').fetchall(),
            'llm_calls': len(source.llm_calls),
            'early_frames': result['frames'][:3]})
        assert sum(o[0] == 'buy' for o in orders) == 1 and orders[0][0] == 'buy' and orders[0][1] > 0
        assert orders[0][2] >= 103. and orders[0][3] > 0
        position = db.execute('SELECT shares,avg_cost FROM paper_positions WHERE account_id=1 AND symbol=\'2330\'').fetchone()
        if not whole_session:
            assert position is not None and position[0] == orders[0][1] and position[1] >= 103.
        # The production swing owner (not S12) authorized the entry: first signal at
        # 09:50 breaks the 102 opening-range high and passes the ATR-once gate.
        decisions = [json.loads(event[3]) for event in events if event[0] == 'intraday_technical_decision']
        passed = [d for d in decisions if d.get('owner') == variables['PAPER_INTRADAY_ENTRY_OWNER']
                  and d['signal']['action'] == 'pass']
        assert passed, str(decisions)
        signal = passed[0]['signal']
        assert passed[0]['s12_role'] == 'not_in_entry_path'
        assert signal['reason'] == 'swing_or15_vwap_relative_strength' and signal['atrOnce']['status'] == 'passed'
        assert all(value is not False for value in signal['conditions'].values()), signal['conditions']
        assert signal['orHigh'] == 102 and signal['maxBuyPrice'] == 103.5 and orders[0][2] <= 103.5
        assert not any(event[0] == 's12_intraday_structure' for event in events)
        # L5 comes from the broker live book (finlab_l5_market_data), not the controller route.
        assert ('finlab_l5_market_data', 'pass') in [event[:2] for event in events]
        assert 'l5_status=pass' in str(events), 'Allocator did not consume the L5 result'
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 90000
    replay = run_native_paper_frames(**args, frame_inputs=result['captured_inputs'])
    assert replay['state_checksum'] == result['state_checksum']
    assert result['frames'][0]['result']['nav_maturity_credit'] == 0
    if whole_session:
        from services.paired_nav_journal import replay_session
        fills = native_fills(result['frames'], 1)
        assert len(result['frames']) == 281 and any(f['side'] == 'buy' for f in fills)
        assert source.llm_calls  # Original private debate ran; no pre-approved pending flag.
        ledger = replay_session(previous={'cash': 5000000., 'nav': 5000000., 'positions': {}},
            fills=fills, marks={'2330': 103.}, corporate_actions=[], session_date='2026-09-07', fees=source.trading['fees'])
        validate_native_account(result['frames'][-1]['result']['valuation'], ledger)
