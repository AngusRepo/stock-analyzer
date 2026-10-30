"""The production composition of one Live intake pass (fakes only: no D1, KV, gateway or broker)."""

from __future__ import annotations

import pytest

from services import live_intake_runner as runner
from services.live_market import LiveMarketUnavailable
from services.live_paper_reader import PaperDenominatorNotReady
from test_live_intake import DAY, FEES, OPEN, PAUSED, RISK, FakeBroker, Gateway, _config, _order, _repo, _tw

ENV = {"EXECUTION_GATEWAY_URL": "https://gateway.example.test"}
EMPTY = {key: [] for key in runner.SUMMARY_LISTS}
KV = {"trading:live_config": _config(), "trading:config": {"fees": FEES, "other": 1}, "trading:risk_config": RISK}


class Reader:
    def __init__(self, orders, ready=()):
        self._orders, self.ready = orders, set(ready)

    def orders(self):
        return list(self._orders)

    def portfolio_value(self, order):
        if order["side"] != "buy":
            return None
        if order["id"] not in self.ready:
            raise PaperDenominatorNotReady("missing")
        return 2_000_000.0


class Control:
    def __init__(self, state=OPEN):
        self._state = state

    def state(self):
        return dict(self._state)


def _pass(repo, reader, gw, now, *, kv=None, holiday=None, factory=None, allow=True, warn=None, control=None):
    built = {}

    def market_factory(**kw):
        built.update(kw)
        return FakeBroker()

    out = runner.run_live_intake_pass(
        allow_live_submit=allow, now=now, clock=lambda: now, env=ENV, kv_json=(kv or KV).__getitem__,
        read_holiday=holiday or (lambda key: None), reader=reader, repository=repo, control=control or Control(),
        market_factory=factory or market_factory, relay=gw.relay,
        status=lambda key: {"status": "error", "reason": "x"}, warn=warn)
    return out, built


def _boom(*a, **k):
    pytest.fail("nothing may be read")


@pytest.mark.parametrize("allow", [False, None, 1, "true", "True"])
def test_without_allow_live_submit_the_pass_reads_and_records_nothing(allow):
    out = runner.run_live_intake_pass(allow_live_submit=allow, env=ENV, kv_json=_boom, read_holiday=_boom,
                                      reader=_boom, market_factory=_boom)
    assert out == {**EMPTY, "status": "idle", "reason": "allow_live_submit_required"}


def test_an_empty_env_reads_nothing(monkeypatch):
    monkeypatch.setattr(runner.os, "environ", {})
    for env in ({}, None):
        out = runner.run_live_intake_pass(allow_live_submit=True, env=env, kv_json=_boom, read_holiday=_boom,
                                          reader=_boom, market_factory=_boom)
        assert out == {**EMPTY, "status": "blocked", "reason": "live_intake_env_missing"}


def test_an_empty_env_is_not_replaced_by_the_process_env(monkeypatch):
    monkeypatch.setattr(runner.os, "environ", dict(ENV))
    out = runner.run_live_intake_pass(allow_live_submit=True, env={}, kv_json=_boom, read_holiday=_boom,
                                      reader=_boom, market_factory=_boom)
    assert out == {**EMPTY, "status": "blocked", "reason": "live_intake_env_missing"}


def test_the_kv_reads_are_strict_and_bounded(monkeypatch):
    from services import kv_client
    seen = []
    monkeypatch.setattr(kv_client, "get_json", lambda key, **kw: seen.append(("json", key, kw)) or {"k": 1})
    monkeypatch.setattr(kv_client, "get", lambda key, **kw: seen.append(("raw", key, kw)) or None)
    assert runner._kv_json("trading:live_config") == {"k": 1} and runner._holiday("holiday:x") is None
    assert seen == [("json", "trading:live_config", {"default": None, "timeout": 3.0, "strict": True}),
                    ("raw", "holiday:x", {"timeout": 3.0, "strict": True})]


def test_a_failed_holiday_read_is_not_a_trading_day(monkeypatch):
    from services import kv_client

    def failed(key, **kw):
        raise RuntimeError("kv_read_http_failed:500")
    monkeypatch.setattr(kv_client, "get", failed)
    assert runner.trading_day_confirmed(_tw(DAY, "10:00"), runner._holiday) is False


def test_the_default_control_keeps_the_order_path_read_bound(monkeypatch):
    from services import execution_submission_control as esc
    from services import live_intake, live_paper_reader
    built = {}

    class FakeControl:
        def __init__(self, **kw):
            built.update(kw)

        def state(self):
            return dict(PAUSED)
    monkeypatch.setattr(esc, "D1SubmissionControl", FakeControl)
    monkeypatch.setattr(live_paper_reader, "D1PaperReader", lambda: Reader([]))
    repo, _ = _repo()
    monkeypatch.setattr(live_intake, "D1IntakeRepository", lambda: repo)
    env = {**ENV, "LIVE_EXECUTION_CONTROL_READ_TIMEOUT_SECONDS": "9"}
    out = runner.run_live_intake_pass(allow_live_submit=True, now=_tw(DAY, "10:01"), env=env,
                                      kv_json=KV.__getitem__, read_holiday=lambda key: None,
                                      market_factory=lambda **kw: FakeBroker())
    assert built == {"env": env, "read_timeout": 2.0} and out["status"] != "blocked"


@pytest.mark.parametrize("broken", ["D1PaperReader", "D1SubmissionControl", "D1IntakeRepository"])
def test_a_d1_client_that_cannot_be_built_blocks_the_pass(monkeypatch, broken):
    from services import execution_submission_control as esc
    from services import live_intake, live_paper_reader
    module = {"D1PaperReader": live_paper_reader, "D1SubmissionControl": esc,
              "D1IntakeRepository": live_intake}[broken]

    def fail(**kw):
        raise RuntimeError("d1_config_incomplete token=secret")
    monkeypatch.setattr(module, broken, fail)
    out = runner.run_live_intake_pass(allow_live_submit=True, now=_tw(DAY, "10:01"), env=ENV,
                                      kv_json=KV.__getitem__, read_holiday=lambda key: None,
                                      reader=None if broken == "D1PaperReader" else Reader([]),
                                      control=None if broken == "D1SubmissionControl" else Control(),
                                      repository=None if broken == "D1IntakeRepository" else _repo()[0],
                                      market_factory=lambda **kw: FakeBroker())
    assert out == {**EMPTY, "status": "blocked", "reason": "live_intake_d1_unavailable:RuntimeError"}


def test_a_paused_control_sends_nothing():
    repo, _ = _repo()
    gw = Gateway(repo)
    _pass(repo, Reader([_order(1, "buy", 1000, 100.0)], ready={1}), gw, _tw(DAY, "10:01"), control=Control(PAUSED))
    row = repo.get("paper_orders:1")
    assert gw.calls == [] and row["status"] == "BLOCKED" and "live_paused_before_send" in row["status_reason"]


def test_a_pass_wires_the_paper_reader_and_waits_for_the_sizing_row():
    repo, _ = _repo()
    gw = Gateway(repo)
    reader = Reader([_order(1, "buy", 1000, 100.0)])
    out, built = _pass(repo, reader, gw, _tw(DAY, "10:01"))
    assert out["waiting"] == ["paper_orders:1"] and gw.calls == []
    assert built["live_config"] == KV["trading:live_config"] and built["risk_config"] == RISK
    assert built["trading_day_confirmed"] is True and built["env"] is ENV
    reader.ready.add(1)
    out, _ = _pass(repo, reader, gw, _tw(DAY, "10:02"))
    row = repo.get("paper_orders:1")
    assert row["status"] == "RELAYED" and row["live_shares"] == 500 and len(gw.calls) == 1


def test_fees_come_from_trading_config_only():
    repo, _ = _repo()
    gw = Gateway(repo)
    kv = {**KV, "trading:config": {"fees": "not a mapping"}}
    _pass(repo, Reader([_order(1, "buy", 1000, 100.0)], ready={1}), gw, _tw(DAY, "10:01"), kv=kv)
    assert repo.get("paper_orders:1")["status_reason"] == "trading_fees_unavailable" and gw.calls == []


def test_an_unreadable_kv_blocks_the_pass():
    def kv(key):
        raise RuntimeError("kv_read_http_failed:500")
    out = runner.run_live_intake_pass(allow_live_submit=True, now=_tw(DAY, "10:01"), env=ENV, kv_json=kv,
                                      market_factory=lambda **k: pytest.fail("no market without KV"))
    assert out == {**EMPTY, "status": "blocked", "reason": "live_intake_kv_unavailable:RuntimeError"}


@pytest.mark.parametrize("day,holiday,expected", [
    (DAY, lambda key: None, True),
    (DAY, lambda key: "", True),
    (DAY, lambda key: "Constitution Day", False),
    (DAY, lambda key: (_ for _ in ()).throw(RuntimeError("kv")), False),  # a failed read is not a trading day
    ("2026-12-12", lambda key: pytest.fail("a weekend needs no read"), False),
])
def test_the_trading_day_comes_from_weekday_and_holiday_kv(day, holiday, expected):
    seen = []
    assert runner.trading_day_confirmed(_tw(day, "10:00"), lambda key: seen.append(key) or holiday(key)) is expected
    if day == DAY:
        assert seen == [f"holiday:{DAY}"]


def test_a_market_that_cannot_be_built_blocks_the_pass():
    def factory(**kw):
        raise LiveMarketUnavailable("live_config_mode_invalid")
    repo, _ = _repo()
    out, _ = _pass(repo, Reader([]), Gateway(repo), _tw(DAY, "10:01"), factory=factory)
    assert out == {**EMPTY, "status": "blocked", "reason": "live_config_mode_invalid"}


def test_unreadable_paper_orders_block_the_pass():
    class Broken(Reader):
        def orders(self):
            raise TimeoutError("d1")
    repo, _ = _repo()
    out, _ = _pass(repo, Broken([]), Gateway(repo), _tw(DAY, "10:01"))
    assert out == {**EMPTY, "status": "blocked", "reason": "paper_orders_unavailable:TimeoutError"}


def test_the_deadline_alert_reaches_the_callers_warn():
    repo, _ = _repo()
    warned = []
    out, _ = _pass(repo, Reader([_order(1, "buy", 1000, 100.0)]), Gateway(repo), _tw(DAY, "13:31"),
                   warn=lambda event, detail: warned.append(event))
    assert warned == ["live_intake_paper_denominator_unavailable"] and len(out["warnings"]) == 1


def test_the_default_relay_and_status_use_the_same_control_and_env(monkeypatch):
    from services import execution_gateway_live_relay as relay_module
    seen = {}

    def submit(**kw):
        seen["submit"] = kw
        return {"status": "unknown", "reason": "execution_gateway_response_unknown_reconciliation_required"}

    def status(key, **kw):
        seen["status"] = (key, kw)
        return {"status": "error", "reason": "x"}
    monkeypatch.setattr(relay_module, "relay_execution_live_submit", submit)
    monkeypatch.setattr(relay_module, "relay_execution_live_status", status)
    repo, _ = _repo()
    control, env, now = Control(), {"X": "1"}, _tw(DAY, "10:01")
    runner.run_live_intake_pass(
        allow_live_submit=True, now=now, clock=lambda: now, env=env, kv_json=KV.__getitem__,
        read_holiday=lambda key: None, reader=Reader([_order(1, "buy", 1000, 100.0)], ready={1}),
        repository=repo, control=control, market_factory=lambda **kw: FakeBroker())
    sent = seen["submit"]
    assert sent["allow_live_submit"] is True and sent["submission_control"] is control and sent["env"] is env
    assert sent["packet"]["intent"]["paperOrderRef"] == "paper_orders:1" and sent["signature"] == "sig"
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN"
    runner.run_live_intake_pass(  # the next pass reconciles through the default status read
        allow_live_submit=True, now=now, clock=lambda: now, env=env, kv_json=KV.__getitem__,
        read_holiday=lambda key: None, reader=Reader([_order(1, "buy", 1000, 100.0)], ready={1}),
        repository=repo, control=control, market_factory=lambda **kw: FakeBroker())
    assert seen["status"] == ("live-intake:paper_orders:1", {"env": env})


def test_a_holiday_reaches_the_market_and_the_intake_and_nothing_is_sent():
    repo, _ = _repo()
    gw = Gateway(repo)
    out, built = _pass(repo, Reader([_order(1, "buy", 1000, 100.0)], ready={1}), gw, _tw(DAY, "10:01"),
                       holiday=lambda key: "typhoon")
    assert built["trading_day_confirmed"] is False
    assert repo.get("paper_orders:1")["status"] == "RECEIVED" and gw.calls == []  # recorded, never sent
