import json

import pytest

from services.native_paper_read_capabilities import NativeReadCapabilities


def capabilities(transport):
    return NativeReadCapabilities(broker_url='https://broker.fixture', broker_token='synthetic-secret',
        controller_url='https://controller.fixture', trading_config={'intraday': {}},
        predictions={'2330': {'signal_raw': 'BUY', 'direction_accuracy': .7}}, session_date='2026-09-07',
        transport=transport, kv_read=lambda key: None)


def test_frozen_rescore_never_calls_live_controller_or_changes_frozen_prediction():
    def forbidden(*args, **kwargs):
        raise AssertionError('No network for frozen rescore')
    reader = capabilities(forbidden)
    request = {'url': 'https://controller.fixture/intraday/rescore', 'method': 'POST',
               'body': json.dumps({'today': '2026-09-07', 'positions': [dict(symbol='2330', shares=100,
                    entry_date='2026-09-01', entry_price=100, current_price=95)]})}
    result = reader.frozen_fetch(request)
    assert json.loads(result['body'])['results'][0]['original_confidence'] == .7


@pytest.mark.parametrize('url,method,body', [
    ('https://broker.fixture/order', 'POST', '{}'),
    ('https://broker.fixture.evil/quote/2330', 'GET', ''),
    ('https://controller.fixture/retrain', 'POST', '{}'),
    ('https://broker.fixture/quote/2330?redirect=x', 'GET', ''),
    ('https://broker.fixture/snapshot/2330', 'POST', '{}'),
    ('https://broker.fixture/snapshot/2330?redirect=x', 'GET', ''),
    ('https://broker.fixture/trend/2330?minutes=5000', 'GET', ''),
    ('https://broker.fixture/trend/2330?minutes=5&minutes=50', 'GET', ''),
])
def test_unregistered_route_has_no_network_authority(url, method, body):
    def forbidden(*args, **kwargs):
        raise AssertionError('Forbidden route reached transport')
    with pytest.raises(ValueError, match='forbidden'):
        capabilities(forbidden).frozen_fetch({'url': url, 'method': method, 'body': body})


def test_credentials_are_host_only_and_redirects_are_not_followed():
    seen = []
    class Response:
        status_code = 200
        text = '{"data":{}}'
        headers = {'content-type': 'application/json', 'set-cookie': 'sensitive'}
    def transport(*args, **kwargs):
        seen.append(kwargs)
        return Response()
    reader = capabilities(transport)
    result = reader.frozen_fetch({'url': 'https://broker.fixture/orderbooks', 'method': 'POST',
                                  'body': '{"symbols":["2330"],"lot_type":"odd_lot"}'})
    assert seen[0]['follow_redirects'] is False
    assert seen[0]['headers']['Authorization'] == 'Bearer synthetic-secret'
    assert 'synthetic-secret' not in json.dumps(result)
    assert 'set-cookie' not in result['headers']


@pytest.mark.parametrize('path', ['/snapshot/2330', '/trend/2330?minutes=5'])
def test_original_pretrade_momentum_reads_are_explicit_bounded_capabilities(path):
    seen = []
    class Response:
        status_code, text, headers = 200, '{"slope_5min":0.1}', {}
    def transport(method, url, **kwargs):
        seen.append((method, url, kwargs))
        return Response()
    request = {'url': 'https://broker.fixture' + path, 'method': 'GET', 'body': ''}
    reader = capabilities(transport)
    assert reader.frozen_fetch(request)['status'] == 200
    assert seen[0][0] == 'GET' and seen[0][2]['follow_redirects'] is False
    request['body'] = '{}'
    with pytest.raises(ValueError, match='get_body_forbidden'):
        reader.frozen_fetch(request)
    assert len(seen) == 1


@pytest.mark.parametrize('url,payload', [
    ('https://mis.taifex.com.tw/futures/api/getQuoteList', {'CID': '', 'SymbolID': '', 'MarketType': '1'}),
    ('https://controller.fixture/taifex-quote', {'market_type': '1'}),
])
def test_original_night_quote_is_read_only_and_body_constrained(url, payload):
    seen = []
    class Response:
        status_code, text, headers = 200, '{"quote":null}', {}
    def transport(method, target, **kwargs):
        seen.append((method, target, kwargs))
        return Response()
    reader = capabilities(transport)
    reader.controller_token = 'synthetic-controller-token'
    request = {'url': url, 'method': 'POST', 'body': json.dumps(payload)}
    assert reader.frozen_fetch(request)['status'] == 200
    assert len(seen) == 1 and seen[0][2]['follow_redirects'] is False
    for invalid in ({**payload, 'order': 'buy'}, {key: '0' for key in payload}):
        with pytest.raises(ValueError, match='query_forbidden'):
            reader.frozen_fetch({**request, 'body': json.dumps(invalid)})
    assert len(seen) == 1


def test_formal_l5_route_uses_host_auth_and_never_allows_broker_login_or_live_submit():
    seen = []
    class Response:
        status_code, text, headers = 200, '{"quotes":{}}', {}
    def transport(*args, **kwargs):
        seen.append(kwargs)
        return Response()
    reader = capabilities(transport)
    reader.controller_token = 'controller-secret'
    request = {'url': 'https://controller.fixture/finlab/execution/l5-market-data', 'method': 'POST',
        'body': json.dumps({'symbols': ['2330'], 'allow_broker_login': False})}
    result = reader.frozen_fetch(request)
    assert seen[0]['headers']['X-Controller-Token'] == 'controller-secret'
    assert 'controller-secret' not in json.dumps(result) + json.dumps(reader.source_identity)
    request['body'] = json.dumps({'symbols': ['2330'], 'allow_broker_login': True})
    with pytest.raises(ValueError, match='forbidden'):
        reader.frozen_fetch(request)
    assert len(seen) == 1


def test_original_intraday_kbars_request_is_bounded_to_frozen_session():
    class Response:
        status_code, text, headers = 200, '{"data":[]}', {}
    reader = capabilities(lambda *args, **kwargs: Response())
    request = {'url': 'https://broker.fixture/kbars/2330?start=2026-09-07&end=2026-09-07&limit=3000',
        'method': 'GET', 'body': ''}
    assert reader.frozen_fetch(request)['status'] == 200
    request['url'] = request['url'].replace('end=2026-09-07', 'end=2026-09-08')
    with pytest.raises(ValueError, match='future_or_unbounded'):
        reader.frozen_fetch(request)


def test_fact_check_and_batch_bars_preserve_real_response_but_reject_write_or_future_scope():
    calls = []
    class Response:
        status_code, text, headers = 200, '{"status":"partial"}', {}
    def transport(*args, **kwargs):
        calls.append(args[1])
        return Response()
    reader = capabilities(transport)
    reader.controller_token, reader.research_url = 'controller-secret', 'https://research.fixture'
    request = {'url': 'https://controller.fixture/breeze2/fact_check', 'method': 'POST',
        'body': json.dumps({'symbol': '2330', 'mutation_allowed': False, 'real_trading_allowed': False})}
    assert json.loads(reader.frozen_fetch(request)['body'])['status'] == 'partial'
    request['body'] = json.dumps({'symbol': '2330', 'mutation_allowed': True, 'real_trading_allowed': False})
    with pytest.raises(ValueError, match='mutation_forbidden'):
        reader.frozen_fetch(request)
    request = {'url': 'https://research.fixture/kbars/batch', 'method': 'POST',
        'body': json.dumps({'symbols': ['2330', '2317'], 'start': '2026-08-31', 'end': '2026-09-07', 'limit': 5000})}
    reader.frozen_fetch(request)
    request['body'] = request['body'].replace('2026-09-07', '2026-09-08')
    with pytest.raises(ValueError, match='future_or_unbounded'):
        reader.frozen_fetch(request)
    assert len(calls) == 2


def test_read_only_broker_observer_is_host_signed_and_not_a_private_account_pass():
    from services.broker_execution_contract import signature_valid
    calls = []
    class Response:
        status_code, text, headers = 200, '{"status":"blocked","reason":"broker_position_insufficient_at_shadow"}', {}
    def transport(*args, **kwargs):
        calls.append(kwargs)
        return Response()
    reader = capabilities(transport)
    reader.controller_token, reader.shadow_hmac_secret, reader.shadow_scope = 'controller-secret', 'hmac-secret', 'paper-parity-v1'
    packet = {'schema_version': 'stockvision-execution-shadow-packet-v1', 'trade_date': '2026-09-07',
        'shadow_scope': 'paper-parity-v1'}
    request = {'url': 'https://controller.fixture/finlab/execution/shadow-relay', 'method': 'POST',
        'body': json.dumps({'packet': packet})}
    result = reader.frozen_fetch(request)
    assert signature_valid(packet, calls[0]['headers']['X-Execution-Signature'], 'hmac-secret')
    assert json.loads(result['body'])['status'] == 'blocked'
    assert 'hmac-secret' not in json.dumps(result) + json.dumps(reader.source_identity)
    request['url'] = 'https://controller.fixture/finlab/execution/live-relay'
    with pytest.raises(ValueError, match='forbidden'):
        reader.frozen_fetch(request)
    assert len(calls) == 1
