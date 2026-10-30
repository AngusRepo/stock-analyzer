from __future__ import annotations

import hashlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from services import live_market as lm
from services.broker_execution_contract import validate_execution_packet
from services.finlab_execution_gateway import PersistentFinlabExecutionGateway
from services.live_intake import live_intent
from services.live_ledger import account_nav
from test_live_intake import FEES, _config, _tw

SECRET = "unit-test-hmac-secret-not-real"
ENV = {"EXECUTION_GATEWAY_URL": "https://gateway.example.test", "EXECUTION_GATEWAY_SERVICE_TOKEN": "svc",
       "SHIOAJI_PROXY_URL": "https://hub.example.test", "PROXY_SERVICE_TOKEN": "hub",
       "LIVE_EXECUTION_HMAC_SECRET": SECRET, "LIVE_TRADING_APPROVAL_SCOPE": "slice-a-live",
       "LIVE_TRADING_APPROVAL_EXPIRES_AT": "2027-01-01T00:00:00+00:00"}
RISK = {"system": {"killSwitch": False},
        "order": {"maxSingleOrderValue": 1_000_000, "maxDailyBuyOrders": 5, "maxDailySellOrders": 5,
                  "maxPriceDeviationPct": 0.1}}
NOW = _tw("2026-12-10", "10:00").astimezone(timezone.utc)
TRUTH = {"status": "ready", "observed_at": NOW.isoformat(), "exchange": "TSE", "reference_price": 100.0,
         "limit_up": 110.0, "limit_down": 90.0, "available_cash": 500_000.0, "position_shares": 2000}


def _observation(positions, request_id):
    payload = {"schema_version": "live-account-observation-v1", "account_scope": "live:sinopac:" + "f" * 64,
               "request_id": request_id, "observed_at": NOW.isoformat(), "bank_balance": 400_000.0,
               "settlements": [], "positions": positions}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {**payload, "sha256": hashlib.sha256(canonical.encode()).hexdigest()}


class Http:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, *, headers, json, timeout):
        self.calls.append((url, headers, json))
        status, body = self.routes[url.split(".test", 1)[1]](json)
        return SimpleNamespace(status_code=status, json=lambda: body)


def _market(http, **kw):
    return lm.GatewayLiveMarket(live_config=kw.pop("config", _config()), risk_config=kw.pop("risk", RISK),
                                trading_day_confirmed=kw.pop("day", True), env=kw.pop("env", ENV), post_fn=http,
                                identity_token_provider=lambda audience: "iam", now=lambda: NOW)


def _books(monkeypatch, errors=(), bid=99.5, ask=100.0, odd_bid=None):
    seen = []

    def fake(packet, *, env, post_fn, max_snapshot_age_ms):
        seen.append(max_snapshot_age_ms)
        lots = [leg["lotType"] for leg in packet["intent"]["orderLegs"]]
        bad = [e for e in errors if e.endswith(tuple(lots))]
        return {"errors": bad, "observations": {lot: {"lot_type": lot, "age_ms": 100, "ask": ask,
                "bid": odd_bid if lot == "odd_lot" and odd_bid is not None else bid,
                "source_time": NOW.isoformat(), "received_at": NOW.isoformat(), "confirmed_at": None,
                "session_epoch": 7} for lot in lots}}

    monkeypatch.setattr(lm, "revalidate_authoritative_snapshots", fake)
    return seen


def _intent(side="buy", shares=1500, price=100.0, symbol="2330"):
    return {**live_intent({"id": 9, "symbol": symbol, "side": side}, shares, price), "tradeDate": "2026-12-10"}


def test_the_packet_carries_the_brokers_exchange_and_the_intent_symbol(monkeypatch):
    _books(monkeypatch)
    http = Http({"/v1/broker-truth": lambda body: (200, {**TRUTH, "exchange": "OTC"})})
    packet, _ = _market(http).signed_packet(_intent(symbol="6488"), "live-intake:paper_orders:9", "2026-12-10")
    assert http.calls[0][2] == {"symbol": "6488"} and packet["broker_truth"]["exchange"] == "OTC"


@pytest.mark.parametrize("at", ["08:59", "13:31", "03:00"])
def test_no_packet_outside_the_continuous_session(monkeypatch, at):
    _books(monkeypatch)
    http = Http({"/v1/broker-truth": lambda body: (200, dict(TRUTH))})
    market = lm.GatewayLiveMarket(live_config=_config(), risk_config=RISK, trading_day_confirmed=True, env=ENV,
                                  post_fn=http, identity_token_provider=lambda a: "iam",
                                  now=lambda: _tw("2026-12-10", at).astimezone(timezone.utc))
    with pytest.raises(lm.LiveMarketUnavailable, match="market_session_closed"):
        market.signed_packet(_intent(), "live-intake:paper_orders:9", "2026-12-10")
    assert http.calls == []


def test_a_signed_packet_passes_the_gateway_contract(monkeypatch):
    seen = _books(monkeypatch)
    http = Http({"/v1/broker-truth": lambda body: (200, dict(TRUTH))})
    packet, signature = _market(http).signed_packet(_intent(), "live-intake:paper_orders:9", "2026-12-10")
    assert validate_execution_packet(packet, signature=signature, env=ENV, risk_config=RISK, daily_side_order_count=0,
                                     live_config=_config(), fees=FEES, now=NOW) == []
    assert seen == [500]  # the KV freshness bound reaches the Hub check
    assert packet["expires_at"] == "2026-12-10T02:00:05+00:00"  # generated + max_packet_age_seconds
    assert set(packet["execution_snapshots"]) == {"board_lot", "odd_lot"}
    url, headers, body = http.calls[0]
    assert url == "https://gateway.example.test/v1/broker-truth" and body == {"symbol": "2330"}
    assert headers["Authorization"] == "Bearer svc" and headers["X-Serverless-Authorization"] == "Bearer iam"
    assert SECRET not in json.dumps(packet)


@pytest.mark.parametrize("change,reason", [
    ({"risk": {"system": {"killSwitch": True}}}, "kill_switch_active_or_unknown"),
    ({"risk": {}}, "kill_switch_active_or_unknown"),
    ({"risk": {"system": {}}}, "kill_switch_active_or_unknown"),
    ({"day": False}, "trading_day_not_confirmed"),
    ({"env": {**ENV, "LIVE_EXECUTION_HMAC_SECRET": ""}}, "live_packet_config_incomplete"),
    ({"env": {**ENV, "LIVE_TRADING_APPROVAL_SCOPE": " "}}, "live_packet_config_incomplete"),
])
def test_no_packet_without_its_preconditions(monkeypatch, change, reason):
    _books(monkeypatch)
    http = Http({"/v1/broker-truth": lambda body: (200, dict(TRUTH))})
    with pytest.raises(lm.LiveMarketUnavailable, match=reason):
        _market(http, **change).signed_packet(_intent(), "live-intake:paper_orders:9", "2026-12-10")
    assert http.calls == []


@pytest.mark.parametrize("truth,books,reason", [
    ({**TRUTH, "status": "degraded"}, (), "broker_truth_incomplete"),
    ({k: v for k, v in TRUTH.items() if k != "limit_up"}, (), "broker_truth_incomplete"),
    ({**TRUTH, "exchange": None}, (), "broker_truth_incomplete"),
    (TRUTH, ("authoritative_hub_book_stale:odd_lot",), "authoritative_hub_book_stale"),
])
def test_incomplete_truth_or_books_raise(monkeypatch, truth, books, reason):
    _books(monkeypatch, errors=books)
    http = Http({"/v1/broker-truth": lambda body: (200, dict(truth))})
    with pytest.raises(lm.LiveMarketUnavailable, match=reason):
        _market(http).signed_packet(_intent(), "live-intake:paper_orders:9", "2026-12-10")


def test_gateway_failures_are_reported_without_detail(monkeypatch):
    _books(monkeypatch)
    for route, reason in ((lambda body: (503, {"detail": "account 12345"}), "execution_gateway_http_503"),
                          (lambda body: (200, ["not", "an", "object"]), "execution_gateway_http_200")):
        with pytest.raises(lm.LiveMarketUnavailable) as caught:
            _market(Http({"/v1/broker-truth": route})).signed_packet(_intent(), "k" * 20, "2026-12-10")
        assert str(caught.value) == reason

    def boom(url, **kw):
        raise TimeoutError("https://gateway.example.test token=svc")

    with pytest.raises(lm.LiveMarketUnavailable) as caught:
        _market(boom).signed_packet(_intent(), "k" * 20, "2026-12-10")
    assert str(caught.value) == "execution_gateway_read_failed:TimeoutError"
    with pytest.raises(lm.LiveMarketUnavailable, match="execution_gateway_config_incomplete"):
        _market(boom, env={**ENV, "EXECUTION_GATEWAY_URL": "http://insecure"}).signed_packet(_intent(), "k" * 20, "d")


def _held(symbols_shares):
    return lambda body: (200, _observation([{"symbol": s, "shares": n, "direction": "Action.Buy"}
                                            for s, n in symbols_shares], body["request_id"]))


def test_account_reads_a_verified_observation_and_todays_marks():
    http = Http({"/v1/account/observations": _held([("2330", 1000), ("0050", 0), ("6488", 2000)]),
                 "/v1/marks": lambda body: (200, {"status": "ready", "marks": {
                     "2330": {"price": 101.0, "date": "2026-12-10", "source": "snapshot_last_trade"},
                     "6488": {"price": 50.5, "date": "2026-12-10", "source": "contract_reference"}}})})
    observation, marks = _market(http).account("2026-12-10")
    assert http.calls[0][2]["request_id"].startswith("live-intake-2026-12-10-")
    assert http.calls[1][0] == "https://gateway.example.test/v1/marks"
    assert http.calls[1][2] == {"symbols": ["2330", "6488"]} and http.calls[1][1]["Authorization"] == "Bearer svc"
    assert marks == {"2330": {"price": 101.0, "date": "2026-12-10", "source": lm.MARK_SOURCE},
                     "6488": {"price": 50.5, "date": "2026-12-10", "source": lm.REFERENCE_MARK_SOURCE}}
    assert account_nav(observation, "2026-12-10", marks)["nav"] == 400_000.0 + 101_000.0 + 101_000.0


def test_each_pass_asks_for_a_new_observation():
    http = Http({"/v1/account/observations": _held([])})
    market = _market(http)
    market.account("2026-12-10")
    market.account("2026-12-10")
    first, second = (call[2]["request_id"] for call in http.calls)
    assert first != second  # a reused id would return the cached earlier observation


@pytest.mark.parametrize("route", [lambda body: (503, {"detail": "marks unavailable"}),
                                   lambda body: (_ for _ in ()).throw(TimeoutError("marks"))])
def test_an_unreadable_marks_route_leaves_the_holdings_unmarked(route):
    http = Http({"/v1/account/observations": _held([("2330", 1000)]), "/v1/marks": route})
    market = _market(http)
    observation, marks = market.account("2026-12-10")
    assert marks == {} and observation["positions"][0]["symbol"] == "2330"
    assert market.marks_error.startswith("execution_gateway_")
    http.routes["/v1/marks"] = lambda body: (200, {"marks": {}})
    market.account("2026-12-10")
    assert market.marks_error is None  # a later read that reached the route clears it


def test_an_unreadable_observation_still_stops_the_pass():
    http = Http({"/v1/account/observations": lambda body: (503, {}),
                 "/v1/marks": lambda body: pytest.fail("no marks without an observation")})
    with pytest.raises(lm.LiveMarketUnavailable, match="execution_gateway_http_503"):
        _market(http).account("2026-12-10")


def test_no_holdings_needs_no_marks():
    http = Http({"/v1/account/observations": _held([])})
    assert _market(http).account("2026-12-10")[1] == {} and len(http.calls) == 1


@pytest.mark.parametrize("mark", [
    {"price": 101.0, "date": "2026-12-09", "source": "snapshot_last_trade"},  # the last trade was yesterday
    {"price": 101.0, "date": "2026-12-10"},  # no source
    {"price": 101.0, "date": "2026-12-10", "source": "hub_quote"},  # not a gateway mark kind
    {"price": 101.0, "date": "2026-12-10", "source": ["snapshot_last_trade"]},  # unhashable: no mark, no TypeError
    {"price": 0, "date": "2026-12-10"},
    {"price": True, "date": "2026-12-10"},
    {"price": math.inf, "date": "2026-12-10"},
    {"price": "101", "date": "2026-12-10"},
    None,
])
def test_a_holding_without_a_mark_for_today_blocks_the_valuation(mark):
    http = Http({"/v1/account/observations": _held([("2330", 1000)]),
                 "/v1/marks": lambda body: (200, {"marks": {"2330": mark} if mark else {}})})
    observation, marks = _market(http).account("2026-12-10")
    assert marks == {}
    with pytest.raises(ValueError, match="live_ledger_mark_missing:2330"):
        account_nav(observation, "2026-12-10", marks)


def _resealed(observation, **changes):
    payload = {k: v for k, v in observation.items() if k != "sha256"} | changes
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {**payload, "sha256": hashlib.sha256(canonical.encode()).hexdigest()}


@pytest.mark.parametrize("tamper", [
    lambda o: {**o, "bank_balance": 9e9},
    lambda o: {**o, "request_id": "other"},
    lambda o: _resealed(o, request_id="another-pass"),  # self-consistent but not this pass's read
    lambda o: _resealed(o, positions=[{"symbol": "2330", "shares": "1,000"}]),
    lambda o: _resealed(o, positions=[{"shares": 1000}]),
])
def test_an_altered_or_foreign_observation_is_refused(tamper):
    http = Http({"/v1/account/observations": lambda body: (200, tamper(_observation([], body["request_id"])))})
    with pytest.raises(lm.LiveMarketUnavailable, match="live_account_observation_unverified"):
        _market(http).account("2026-12-10")


@pytest.mark.parametrize("bid,odd_bid,errors,price", [
    (99.5, None, (), 99.5),
    (100.0, 99.5, (), 99.5),  # odd book lower: a mixed sell must be marketable on both legs
    (99.5, 100.0, (), 99.5),
    (100.0, 99.0, ("authoritative_hub_book_stale:odd_lot",), 100.0),  # no fresh odd book: board bid
    (99.5, None, ("authoritative_hub_book_stale:board_lot",), None),
    (0.0, None, (), None),
    (math.inf, None, (), None),
])
def test_deferred_sell_price_is_the_lower_fresh_bid(monkeypatch, bid, odd_bid, errors, price):
    _books(monkeypatch, bid=bid, odd_bid=odd_bid, errors=errors)
    assert _market(Http({})).deferred_sell_price("2330") == price


def test_a_deferred_mixed_sell_at_that_price_passes_the_contract(monkeypatch):
    _books(monkeypatch, bid=100.0, odd_bid=99.5, ask=100.5)
    http = Http({"/v1/broker-truth": lambda body: (200, dict(TRUTH))})
    market = _market(http)
    price = market.deferred_sell_price("2330")
    packet, signature = market.signed_packet(_intent("sell", 1500, price), "live-intake:paper_orders:9", "2026-12-10")
    assert validate_execution_packet(packet, signature=signature, env=ENV, risk_config=RISK, daily_side_order_count=0,
                                     live_config=_config(), fees=FEES, now=NOW) == []


def test_an_invalid_live_config_never_builds_a_market():
    with pytest.raises(lm.LiveMarketUnavailable, match="live_config_unavailable"):
        _market(Http({}), config=None)


# --- gateway read routes ---

TW = ZoneInfo("Asia/Taipei")
TODAY = NOW.astimezone(TW).date()


class Contract(SimpleNamespace):
    pass


def _contract(**changes):
    fields = {"exchange": SimpleNamespace(value="TSE"), "reference": 50.0, "limit_up": 55.0, "limit_down": 45.0,
              "update_date": TODAY.strftime("%Y/%m/%d"), "trading_suspended": False}
    return Contract(**{**fields, **changes})


class Stocks(dict):
    def __getitem__(self, key):
        raise AssertionError("use .get: a missing code must be a clean rejection")


def _gateway(contracts, account_id="acct", cash=500_000.0, snapshots=(), downloaded=None, clock=None):
    """downloaded: the table fetch_contracts installs (None leaves the table as it is)."""
    calls = []
    api = SimpleNamespace(
        stock_account=SimpleNamespace(account_id=account_id),
        Contracts=SimpleNamespace(Stocks=Stocks(contracts)),
        list_positions=lambda account, unit=None: [SimpleNamespace(code="2330", quantity=2000)],
        snapshots=lambda contracts, timeout=None: calls.append((contracts, timeout)) or list(snapshots))
    api.downloads = []

    def fetch_contracts(**kw):
        api.downloads.append(kw)
        if isinstance(downloaded, Exception):
            raise downloaded
        if downloaded is not None:
            api.Contracts = SimpleNamespace(Stocks=Stocks(downloaded))
    api.fetch_contracts = fetch_contracts
    gateway = PersistentFinlabExecutionGateway(object(), env={
        "LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED": "1", "SHIOAJI_ACCOUNT_ID": "acct"},
        clock=clock or (lambda: NOW))
    gateway._account = SimpleNamespace(api=api, get_cash=lambda: cash)
    started = []
    gateway.ensure_started = lambda: started.append(True)
    gateway.assert_live_submission_allowed = lambda: pytest.fail("a read must not request order admission")
    gateway._place_direct = lambda **kw: pytest.fail("a read must not place an order")
    gateway.submit_leg = lambda **kw: pytest.fail("a read must not place an order")
    return gateway, started, calls


@pytest.fixture(autouse=True)
def _shioaji(monkeypatch):
    monkeypatch.setitem(sys.modules, "shioaji", SimpleNamespace(Unit=SimpleNamespace(Share="Share")))


@pytest.mark.parametrize("update_date", [TODAY.strftime("%Y/%m/%d"), TODAY, TODAY.isoformat(),
                                         datetime(TODAY.year, TODAY.month, TODAY.day, 7, 30)])
def test_gateway_broker_truth_reads_todays_contract_band(update_date):
    gateway, started, _ = _gateway({"2330": _contract(exchange=SimpleNamespace(value="OTC"), update_date=update_date)})
    truth = gateway.broker_truth(symbol="2330")
    assert {k: truth[k] for k in ("status", "exchange", "reference_price", "limit_up", "limit_down",
                                  "available_cash", "position_shares")} == {
        "status": "ready", "exchange": "OTC", "reference_price": 50.0, "limit_up": 55.0, "limit_down": 45.0,
        "available_cash": 500_000.0, "position_shares": 2000}
    assert started and "acct" not in json.dumps(truth)
    assert gateway._account.api.downloads == []  # today's table: no download


@pytest.mark.parametrize("contracts,account_id,symbol,error", [
    ({"2330": _contract()}, "other", "2330", "live_account_identity_mismatch"),
    ({"2330": _contract(update_date="2026/01/02")}, "acct", "2330", "broker_truth_contract_not_current"),
    ({"2330": _contract(update_date=None)}, "acct", "2330", "broker_truth_contract_not_current"),
    ({"2330": _contract(trading_suspended=True)}, "acct", "2330", "broker_truth_contract_not_current"),
    ({"2330": _contract(exchange="TAIFEX")}, "acct", "2330", "broker_truth_contract_invalid"),
    ({"2330": _contract(limit_up=None)}, "acct", "2330", "broker_truth_contract_invalid"),
    ({"2330": _contract(reference=0.0, limit_down=0.0, limit_up=0.0)}, "acct", "2330", "broker_truth_contract_invalid"),
    ({"2330": _contract(reference=60.0)}, "acct", "2330", "broker_truth_contract_invalid"),
    ({"2330": _contract(limit_up=math.nan)}, "acct", "2330", "broker_truth_contract_invalid"),
    ({"2330": _contract(limit_up=math.inf)}, "acct", "2330", "broker_truth_contract_invalid"),
    ({"2330": _contract(reference=True, limit_down=True, limit_up=True)}, "acct", "2330",
     "broker_truth_contract_invalid"),
    ({"2330": _contract(reference="50")}, "acct", "2330", "broker_truth_contract_invalid"),
    ({}, "acct", "2330", "broker_contract_missing"),
    ({"2330": _contract()}, "acct", "23 30", "broker_read_symbols_invalid"),
])
def test_gateway_broker_truth_fails_closed(contracts, account_id, symbol, error):
    with pytest.raises(ValueError, match=error):
        _gateway(contracts, account_id)[0].broker_truth(symbol=symbol)


def test_gateway_reads_need_read_admission():
    gateway = PersistentFinlabExecutionGateway(object(), env={"LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED": "0"})
    gateway.ensure_started = lambda: pytest.fail("must not connect")
    with pytest.raises(RuntimeError, match="broker_read_disabled"):
        gateway.broker_truth(symbol="2330")
    with pytest.raises(RuntimeError, match="broker_read_disabled"):
        gateway.marks(symbols=["2330"])


def _ts(day, hhmm):
    """Snapshot ts as Taiwan wall time encoded as nanoseconds (the date is the same either way)."""
    return int(_tw(day, hhmm).replace(tzinfo=timezone.utc).timestamp() * 1e9)


def _snap(code, close, ts, total_volume=1200):
    return SimpleNamespace(code=code, close=close, ts=ts, total_volume=total_volume)


def test_gateway_marks_are_dated_last_trades():
    today = TODAY.isoformat()
    snapshots = [_snap("2330", 101.0, _ts(today, "13:30")),
                 _snap("6488", 50.5, _ts("2026-01-02", "13:30")),
                 _snap("9999", 1.0, _ts(today, "10:00")),  # not asked for
                 _snap("3008", 0.0, _ts(today, "10:00")),
                 _snap("2454", 10.0, "soon"),
                 _snap("2317", math.inf, _ts(today, "10:00")),
                 _snap("2303", True, _ts(today, "10:00")),
                 _snap("1101", 40.0, True),
                 # no trade today: close is an earlier day's price
                 _snap("2412", 120.0, _ts(today, "13:30"), total_volume=0),
                 _snap("2882", 45.0, _ts(today, "13:30"), total_volume=True),
                 _snap("2891", 30.0, _ts(today, "13:30"), total_volume=None),
                 _snap("2603", 60.0, _ts(today, "13:30"), total_volume=-5)]
    symbols = ["2330", "6488", "3008", "2454", "2317", "2303", "1101", "2412", "2882", "2891", "2603"]
    gateway, started, calls = _gateway({s: _contract() for s in symbols}, snapshots=snapshots)
    out = gateway.marks(symbols=symbols)
    snap, ref = "snapshot_last_trade", "contract_reference"
    # 6488 last traded on an earlier day and 2412 has no trade today: today's reference price
    # (Wei 10/30 Q1). Malformed snapshots (2882, 2891, ...) prove nothing and get no mark.
    assert out == {"status": "ready", "marks": {"2330": {"price": 101.0, "date": today, "source": snap},
                                                "6488": {"price": 50.0, "date": today, "source": ref},
                                                "2412": {"price": 50.0, "date": today, "source": ref}}}
    assert started == [True] and len(calls[0][0]) == len(symbols)
    assert calls[0][1] == 3000  # bounded: snapshots run inside the broker lock


STALE = "2026/01/02"


def test_a_stale_table_is_downloaded_once_then_read_again():
    gateway, _, _ = _gateway({"2330": _contract(update_date=STALE)}, downloaded={"2330": _contract()})
    assert gateway.broker_truth(symbol="2330")["status"] == "ready"
    assert gateway._account.api.downloads == [{"contract_download": True, "contracts_timeout": 10_000}]


@pytest.mark.parametrize("read", ["truth", "marks"])
def test_an_empty_table_is_downloaded_then_read_again(read):
    snapshots = [_snap("2330", 101.0, _ts(TODAY.isoformat(), "10:00"))]
    gateway, _, calls = _gateway({}, snapshots=snapshots, downloaded={"2330": _contract()})
    if read == "truth":
        assert gateway.broker_truth(symbol="2330")["exchange"] == "TSE"
    else:
        assert gateway.marks(symbols=["2330"])["marks"]["2330"]["price"] == 101.0
    assert len(gateway._account.api.downloads) == 1


def test_marks_use_an_earlier_days_table_without_a_download():
    # A snapshot only needs the code; the band's date matters for broker truth alone.
    snapshots = [_snap("2330", 101.0, _ts(TODAY.isoformat(), "10:00"))]
    gateway, _, _ = _gateway({"2330": _contract(update_date=STALE)}, snapshots=snapshots, downloaded={})
    assert gateway.marks(symbols=["2330"])["marks"]["2330"]["price"] == 101.0
    assert gateway._account.api.downloads == []


def test_downloads_are_throttled_and_a_still_stale_table_fails_closed():
    clock = [NOW]
    gateway, _, _ = _gateway({"2330": _contract(update_date=STALE)},
                             downloaded={"2330": _contract(update_date=STALE)}, clock=lambda: clock[0])
    for minutes in (0, 29):
        clock[0] = NOW + timedelta(minutes=minutes)
        with pytest.raises(ValueError, match="broker_truth_contract_not_current"):
            gateway.broker_truth(symbol="2330")
    assert len(gateway._account.api.downloads) == 1
    clock[0] = NOW + timedelta(minutes=30)
    with pytest.raises(ValueError, match="broker_truth_contract_not_current"):
        gateway.broker_truth(symbol="2330")
    assert len(gateway._account.api.downloads) == 2


def test_a_failed_download_is_unavailable_and_throttled():
    gateway, _, _ = _gateway({}, downloaded=OSError("acct 123 secret"))
    with pytest.raises(RuntimeError, match="^broker_contract_refresh_failed:OSError$"):
        gateway.broker_truth(symbol="2330")
    with pytest.raises(ValueError, match="broker_contract_missing"):
        gateway.marks(symbols=["2330"])
    assert len(gateway._account.api.downloads) == 1


@pytest.mark.parametrize("utc,update_date,ok", [
    # 17:00 UTC is 01:00 the next day in Taipei: the band must carry the Taipei date.
    ("2026-12-10T17:00:00+00:00", "2026/12/11", True),
    ("2026-12-10T17:00:00+00:00", "2026/12/10", False),
    ("2026-12-10T15:59:00+00:00", "2026/12/10", True),
])
def test_today_is_the_taipei_date_of_the_gateway_clock(utc, update_date, ok):
    at = datetime.fromisoformat(utc)
    gateway, _, _ = _gateway({"2330": _contract(update_date=update_date)}, downloaded=None, clock=lambda: at)
    if ok:
        assert gateway.broker_truth(symbol="2330")["status"] == "ready"
    else:
        with pytest.raises(ValueError, match="broker_truth_contract_not_current"):
            gateway.broker_truth(symbol="2330")


def test_a_table_from_the_previous_taipei_day_is_downloaded_after_midnight_taipei():
    at = datetime.fromisoformat("2026-12-10T17:00:00+00:00")  # 2026-12-11 01:00 in Taipei
    gateway, _, _ = _gateway({"2330": _contract(update_date="2026/12/10")},
                             downloaded={"2330": _contract(update_date="2026/12/11")}, clock=lambda: at)
    assert gateway.broker_truth(symbol="2330")["status"] == "ready"
    assert len(gateway._account.api.downloads) == 1


@pytest.mark.parametrize("symbols", [[], ["23 30"], ["2330"] * 51])
def test_gateway_marks_reject_bad_symbol_lists(symbols):
    with pytest.raises(ValueError, match="broker_read_symbols_invalid"):
        _gateway({"2330": _contract()})[0].marks(symbols=symbols)


def test_marks_route_authenticates_and_sanitizes(monkeypatch):
    import execution_gateway_app as app
    from fastapi import HTTPException

    monkeypatch.setattr(app, "SERVICE_ROLE", "dedicated_execution_gateway")
    monkeypatch.setattr(app, "SERVICE_TOKEN", "unit-test-marks-token")
    calls = []
    monkeypatch.setattr(app.gateway, "marks", lambda **kw: calls.append(kw) or {"status": "ready", "marks": {}})
    request = app.MarksRequest(symbols=["2330"])
    with pytest.raises(HTTPException) as error:
        app.read_marks(request, authorization=None)
    assert error.value.status_code == 401 and calls == []
    assert app.read_marks(request, authorization="Bearer unit-test-marks-token")["status"] == "ready"
    for exc, code, detail in ((ValueError("acct 123"), 422, "marks rejected"),
                              (RuntimeError("acct 123"), 503, "marks unavailable")):
        def failed(**kw):
            raise exc
        monkeypatch.setattr(app.gateway, "marks", failed)
        with pytest.raises(HTTPException) as error:
            app.read_marks(request, authorization="Bearer unit-test-marks-token")
        assert (error.value.status_code, error.value.detail) == (code, detail)


def test_broker_truth_route_authenticates_and_sanitizes(monkeypatch):
    import execution_gateway_app as app
    from fastapi import HTTPException

    monkeypatch.setattr(app, "SERVICE_ROLE", "dedicated_execution_gateway")
    monkeypatch.setattr(app, "SERVICE_TOKEN", "unit-test-truth-token")
    calls = []
    monkeypatch.setattr(app.gateway, "broker_truth", lambda **kw: calls.append(kw) or {"status": "ready"})
    request = app.BrokerTruthRequest(symbol="2330")
    with pytest.raises(HTTPException) as error:
        app.read_broker_truth(request, authorization=None)
    assert error.value.status_code == 401 and calls == []
    assert app.read_broker_truth(request, authorization="Bearer unit-test-truth-token") == {"status": "ready"}
    for exc, code, detail in ((ValueError("acct 123"), 422, "broker truth rejected"),
                              (RuntimeError("acct 123"), 503, "broker truth unavailable")):
        def failed(**kw):
            raise exc
        monkeypatch.setattr(app.gateway, "broker_truth", failed)
        with pytest.raises(HTTPException) as error:
            app.read_broker_truth(request, authorization="Bearer unit-test-truth-token")
        assert (error.value.status_code, error.value.detail) == (code, detail)


@pytest.mark.parametrize("contract,downloaded", [
    (_contract(update_date=STALE), {"2330": _contract(update_date=STALE)}),  # still an earlier day's table
    (_contract(trading_suspended=True), None),
    (_contract(reference=0.0), None),
    (_contract(reference=True), None),
    (_contract(reference=math.nan), None),
    (_contract(update_date=STALE), OSError("acct 123")),  # the refresh fails
])
def test_no_reference_mark_without_todays_usable_contract(contract, downloaded):
    snapshots = [_snap("2330", 101.0, _ts("2026-12-09", "13:30"), total_volume=0)]
    gateway, _, _ = _gateway({"2330": contract}, snapshots=snapshots, downloaded=downloaded)
    assert gateway.marks(symbols=["2330"]) == {"status": "ready", "marks": {}}


def test_a_stale_table_is_refreshed_for_a_reference_mark():
    snapshots = [_snap("2330", 101.0, _ts(TODAY.isoformat(), "10:00"), total_volume=0)]
    gateway, _, _ = _gateway({"2330": _contract(update_date=STALE)}, snapshots=snapshots,
                             downloaded={"2330": _contract(reference=48.5)})
    assert gateway.marks(symbols=["2330"])["marks"] == {
        "2330": {"price": 48.5, "date": TODAY.isoformat(), "source": "contract_reference"}}
    assert len(gateway._account.api.downloads) == 1


def test_a_missing_snapshot_never_falls_back_to_the_reference():
    gateway, _, _ = _gateway({"2330": _contract()}, snapshots=[])
    assert gateway.marks(symbols=["2330"])["marks"] == {}


def test_a_trade_today_wins_over_a_zero_volume_duplicate():
    today = TODAY.isoformat()
    snapshots = [_snap("2330", 0.0, _ts(today, "09:00"), total_volume=0), _snap("2330", 101.0, _ts(today, "10:00"))]
    gateway, _, _ = _gateway({"2330": _contract()}, snapshots=snapshots)
    assert gateway.marks(symbols=["2330"])["marks"]["2330"] == {"price": 101.0, "date": today,
                                                                "source": "snapshot_last_trade"}
