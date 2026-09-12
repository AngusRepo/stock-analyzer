"""Explicit read-only transport capabilities for the native shadow host.

No arbitrary proxying, redirects, live configuration resolution or order route
is allowed. Credentials stay in this host and are absent from source receipts.
"""
from __future__ import annotations

import json
import re
from urllib.parse import urlsplit, parse_qs
from datetime import date, timedelta

from services.paired_nav_journal import encode, digest


class NativeReadCapabilities:
    def __init__(self, *, broker_url: str, broker_token: str, controller_url: str,
                 trading_config: dict, predictions: dict, session_date: str,
                 transport=None, kv_read=None, debate_reader=None, controller_token='', research_url='',
                 shadow_hmac_secret='', shadow_scope=''):
        import httpx
        self.transport = transport or httpx.request
        self.broker_url = broker_url.rstrip('/')
        self.controller_url = controller_url.rstrip('/')
        self.research_url = research_url.rstrip('/')
        for base in (self.broker_url, self.controller_url, self.research_url):
            parsed = urlsplit(base)
            if base and (parsed.scheme != 'https' or not parsed.netloc or parsed.username
                         or parsed.password or parsed.query or parsed.fragment):
                raise ValueError('native_source_origin_invalid')
        self.broker_token = broker_token
        self.controller_token = controller_token
        self.shadow_hmac_secret, self.shadow_scope = shadow_hmac_secret, shadow_scope
        self.trading_config, self.predictions, self.session_date = trading_config, predictions, session_date
        if kv_read is None:
            from services.kv_client import get
            kv_read = lambda key: get(key, strict=True)
        self.kv_read = kv_read
        self.debate_reader = debate_reader

    @property
    def source_identity(self) -> dict:
        # Same HTTP body under a different frozen model/configuration is NOT
        # the same pure inference request. Never include credentials here.
        return {'owner': 'native-read-capabilities-v1', 'broker_url': self.broker_url,
            'controller_url': self.controller_url, 'session_date': self.session_date,
            'research_url': self.research_url,
            'trading_config_checksum': digest(self.trading_config),
            'predictions_checksum': digest(self.predictions),
            'kv_context': getattr(self.kv_read, 'source_identity', None),
            'shadow_scope': self.shadow_scope,
            'shadow_relay_owner': 'external-broker-observer-not-private-nav',
            'debate': getattr(self.debate_reader, 'source_identity', None)}

    def source_kv(self, request: dict):
        if set(request) != {'key'} or not isinstance(request['key'], str) or not request['key']:
            raise ValueError('native_source_kv_request_invalid')
        return self.kv_read(request['key'])

    def read_native(self, request: dict, frame: dict) -> dict:
        return self.frozen_fetch(request, frame=frame)

    def frozen_fetch(self, request: dict, *, frame: dict | None = None) -> dict:
        from routers.intraday import RescoreRequest, evaluate_rescore, _INTRADAY_DEFAULTS
        import httpx
        if set(request) != {'url', 'method', 'body'}:
            raise ValueError('native_source_http_request_invalid')
        url, method, body = request['url'], request['method'], request['body']
        if self.controller_url and url == self.controller_url + '/debate/buy_batch':
            if method != 'POST' or self.debate_reader is None or frame is None:
                raise ValueError('native_source_private_debate_capability_missing')
            return self.debate_reader.read_native(request, frame)
        if self.controller_url and url == self.controller_url + '/intraday/rescore':
            if method != 'POST':
                raise ValueError('native_source_rescore_method_invalid')
            req = RescoreRequest.model_validate_json(body)
            if req.today != self.session_date:
                raise ValueError('native_source_rescore_session_mismatch')
            intraday = self.trading_config.get('intraday') or {}
            cfg = {key: intraday.get(key, value) for key, value in _INTRADAY_DEFAULTS.items()}
            # Exact original compute function, with the frozen model packet.
            result = evaluate_rescore(req, cfg=cfg, predictions_map=self.predictions, tw_today=self.session_date)
            return {'body': encode(result), 'status': 200, 'headers': {'content-type': 'application/json'}}
        headers = {}
        if self.controller_url and url == self.controller_url + '/breeze2/fact_check':
            from routers.breeze2 import Breeze2FactCheckRequest
            payload = json.loads(body)
            parsed = Breeze2FactCheckRequest.model_validate(payload)
            if (method != 'POST' or set(payload) - set(Breeze2FactCheckRequest.model_fields)
                    or payload.get('mutation_allowed') is not False or payload.get('real_trading_allowed') is not False):
                raise ValueError('native_source_fact_check_mutation_forbidden')
            self._symbols([parsed.symbol])
            if not self.controller_token:
                raise ValueError('native_source_controller_auth_missing')
            headers['X-Controller-Token'] = self.controller_token
        elif self.controller_url and url == self.controller_url + '/finlab/execution/shadow-relay':
            from services.broker_execution_contract import sign_packet
            payload = json.loads(body)
            packet = payload.get('packet')
            if (method != 'POST' or set(payload) != {'packet'} or not isinstance(packet, dict)
                    or packet.get('schema_version') != 'stockvision-execution-shadow-packet-v1'
                    or packet.get('trade_date') != self.session_date or not self.shadow_scope
                    or packet.get('shadow_scope') != self.shadow_scope):
                raise ValueError('native_source_shadow_observer_packet_invalid')
            if not self.controller_token or not self.shadow_hmac_secret:
                raise ValueError('native_source_shadow_observer_credentials_missing')
            # Exact non-mutating observer used by paper. Its result concerns
            # the external broker, NOT this private account, and grants no NAV
            # or execution-parity maturity. No /submit route is ever allowed.
            headers['X-Controller-Token'] = self.controller_token
            headers['X-Execution-Signature'] = sign_packet(packet, self.shadow_hmac_secret)
        elif self.controller_url and url == self.controller_url + '/finlab/execution/l5-market-data':
            payload = json.loads(body)
            if (method != 'POST' or set(payload) != {'symbols', 'allow_broker_login'}
                    or payload['allow_broker_login'] is not False):
                raise ValueError('native_source_l5_broker_login_or_body_forbidden')
            self._symbols(payload['symbols'])
            if not self.controller_token:
                raise ValueError('native_source_controller_auth_missing')
            headers['X-Controller-Token'] = self.controller_token
        elif self.controller_url and url == self.controller_url + '/taifex-quote':
            if method != 'POST' or json.loads(body) != {'market_type': '1'}:
                raise ValueError('native_source_taifex_night_query_forbidden')
            if not self.controller_token:
                raise ValueError('native_source_controller_auth_missing')
            headers['X-Controller-Token'] = self.controller_token
        elif url == 'https://mis.taifex.com.tw/futures/api/getQuoteList':
            if method != 'POST' or json.loads(body) != {'CID': '', 'SymbolID': '', 'MarketType': '1'}:
                raise ValueError('native_source_taifex_night_query_forbidden')
            headers['User-Agent'] = 'Mozilla/5.0'
        elif self.broker_url and url.startswith(self.broker_url + '/'):
            path = url[len(self.broker_url):]
            batch = path in {'/orderbooks', '/quotes', '/snapshots'} and method == 'POST'
            single = re.fullmatch(r'/(?:orderbook|quote)/[A-Za-z0-9]+(?:\?lot_type=(?:board_lot|odd_lot))?', path) and method == 'GET'
            momentum = re.fullmatch(r'/(?:snapshot/[A-Za-z0-9]{4,8}|trend/[A-Za-z0-9]{4,8}\?minutes=5)', path) and method == 'GET'
            kbars = self._kbars(path, method, body)
            if not batch and not single and not momentum and not kbars:
                raise ValueError('native_source_broker_route_forbidden')
            if batch:
                payload = json.loads(body)
                if (set(payload) - {'symbols', 'lot_type'} or not isinstance(payload.get('symbols'), list)
                        or not payload['symbols'] or len(payload['symbols']) > 1000
                        or any(not isinstance(s, str) or not re.fullmatch(r'[A-Za-z0-9]+', s) for s in payload['symbols'])
                        or payload.get('lot_type', 'board_lot') not in {'board_lot', 'odd_lot'}):
                    raise ValueError('native_source_broker_body_invalid')
            elif body:
                raise ValueError('native_source_get_body_forbidden')
            if self.broker_token:
                headers['Authorization'] = 'Bearer ' + self.broker_token
        elif self.research_url and url.startswith(self.research_url + '/'):
            path = url[len(self.research_url):]
            batch = path == '/kbars/batch' and method == 'POST'
            if batch:
                payload = json.loads(body)
                if set(payload) != {'symbols', 'start', 'end', 'limit'}:
                    raise ValueError('native_source_kbars_batch_invalid')
                self._symbols(payload['symbols'])
                if len(payload['symbols']) > 64:
                    raise ValueError('native_source_kbars_batch_unbounded')
                from urllib.parse import urlencode
                self._kbars('/kbars/' + payload['symbols'][0] + '?' + urlencode(
                    {key: payload[key] for key in ('start', 'end', 'limit')}), 'GET', '')
            elif not (path == '/usage' and method == 'GET' and not body) and not self._kbars(path, method, body):
                raise ValueError('native_source_research_route_forbidden')
            if self.broker_token:
                headers['Authorization'] = 'Bearer ' + self.broker_token
        elif method == 'GET' and not body and url in {
                'https://www.twse.com.tw/rwd/zh/announcement/notice?response=json',
                'https://www.twse.com.tw/rwd/zh/announcement/punish?response=json',
                'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information',
                'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information'}:
            headers['User-Agent'] = 'Mozilla/5.0'
        elif (method == 'GET' and not body and re.fullmatch(
                r'https://query1\.finance\.yahoo\.com/v8/finance/chart/[A-Za-z0-9]+\.TW\?interval=1m&range=1d', url)):
            headers['User-Agent'] = 'Mozilla/5.0'
        else:
            raise ValueError('native_source_http_route_forbidden')
        if method == 'POST':
            headers['Content-Type'] = 'application/json'
        try:
            response = self.transport(method, url, headers=headers, content=body or None,
                                      timeout=15, follow_redirects=False)
        except httpx.RequestError:
            # Captured outage permits the original engine's fallback; no raw
            # credential-bearing exception is persisted or logged.
            return {'status': 503, 'body': '', 'headers': {}}
        if 300 <= response.status_code < 400:
            raise ValueError('native_source_redirect_forbidden')
        if any(secret and secret in response.text for secret in (self.broker_token, self.controller_token, self.shadow_hmac_secret)):
            raise ValueError('native_source_response_contains_credential')
        return {'status': response.status_code, 'body': response.text,
                'headers': {'content-type': response.headers.get('content-type', 'application/json')}}

    @staticmethod
    def _symbols(symbols):
        if (not isinstance(symbols, list) or not 0 < len(symbols) <= 1000
                or any(not isinstance(s, str) or not re.fullmatch(r'[A-Za-z0-9]{4,8}', s) for s in symbols)):
            raise ValueError('native_source_symbols_invalid')

    def _kbars(self, path, method, body):
        parts = urlsplit(path)
        if method != 'GET' or body or not re.fullmatch(r'/kbars/[A-Za-z0-9]{4,8}', parts.path):
            return False
        query = parse_qs(parts.query, keep_blank_values=True)
        if set(query) != {'start', 'end', 'limit'} or any(len(v) != 1 for v in query.values()):
            raise ValueError('native_source_kbars_query_forbidden')
        start, end, session = date.fromisoformat(query['start'][0]), date.fromisoformat(query['end'][0]), date.fromisoformat(self.session_date)
        if not session - timedelta(days=7) <= start <= end <= session or not 1 <= int(query['limit'][0]) <= 5000:
            raise ValueError('native_source_kbars_future_or_unbounded_request')
        return True

    def registered(self) -> dict:
        return {'source_kv': self.source_kv, 'frozen_fetch': self}
