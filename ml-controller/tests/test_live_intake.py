"""R21 Live intake: D-6 conversion, legs, DEFERRED exits, pause, and no resend (fake broker only)."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from services import live_intake as li
from services.finlab_execution_preview_service import validate_stockvision_execution_intent

ROOT = Path(__file__).resolve().parents[2]
FEES = {"commission": 0.001425, "tax": 0.003, "dayTradeTax": 0.0015, "minCommission": 20}
RISK = {"order": {"maxSingleOrderValue": 1_000_000}}
SCOPE = "live:sinopac:" + "f" * 64
DAY = "2026-12-10"  # Thursday
NEXT = "2026-12-11"
UTC = timezone.utc


def _config(mode="live"):
    return {"schema_version": "live-config-v1", "mode": mode, "capital_source": "broker_nav_authoritative_marks",
            "session": {"timezone": "Asia/Taipei", "continuous_open": "09:00", "continuous_close": "13:30",
                        "deferred_sell_release": "09:00"},
            "freshness": {"max_packet_age_seconds": 5, "max_snapshot_age_ms": 500, "max_broker_truth_age_seconds": 5},
            "pause": {"enabled": False, "daily_loss_pct": None, "cumulative_drawdown_pct": None}}


def _tw(day, hhmm):
    hour, minute = map(int, hhmm.split(":"))
    return datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:00+08:00")


def _order(oid, side, shares, price, day=DAY, hhmm="10:00", symbol="2330"):
    utc = _tw(day, hhmm).astimezone(UTC)
    return {"id": oid, "symbol": symbol, "side": side, "shares": shares, "price": price,
            "created_at": utc.strftime("%Y-%m-%d %H:%M:%S")}


def _repo(now=None):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript((ROOT / "worker/domain-migrations/execution/0008_live_intake_orders.sql").read_text())

    def query(sql, params, timeout):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def execute(sql, params, timeout):
        conn.execute(sql, params)
        conn.commit()

    return li.D1IntakeRepository(query=query, execute=execute, **({"now": now} if now else {})), conn


class FakeBroker:
    """Fake broker/market: account observation, marks, deferred quote and packet signing."""

    def __init__(self, cash=1_000_000.0, holdings=None, marks=None, exchange="TSE", bid=99.5):
        self.cash, self.holdings = cash, dict(holdings or {})
        self.mark_prices = dict(marks or {})
        self.exchange, self.bid = exchange, bid
        self.packets: list[dict] = []
        self.fail_account = False

    def account(self, business_date):
        if self.fail_account:
            raise TimeoutError("broker")
        observed = _tw(business_date, "09:01").astimezone(UTC).isoformat()
        observation = {"schema_version": "live-account-observation-v1", "account_scope": SCOPE, "sha256": "a" * 64,
                       "observed_at": observed, "bank_balance": self.cash, "settlements": [],
                       "positions": [{"symbol": s, "shares": n, "direction": "Buy"} for s, n in self.holdings.items()]}
        marks = {s: {"price": self.mark_prices.get(s, 100.0), "date": business_date, "source": "hub"}
                 for s in self.holdings}
        return observation, marks

    def deferred_sell_price(self, symbol):
        return self.bid

    def signed_packet(self, intent, key, trade_date):
        assert validate_stockvision_execution_intent(dict(intent)) is None
        packet = {"schema_version": "stockvision-live-execution-packet-v1", "idempotency_key": key,
                  "trade_date": trade_date, "intent": dict(intent),
                  "expires_at": (_tw(trade_date, "09:00") + timedelta(hours=5)).astimezone(UTC).isoformat(),
                  "broker_truth": {"exchange": self.exchange}}
        self.packets.append(packet)
        return packet, "sig"


class Gateway:
    def __init__(self, repo, answer="submitted"):
        self.repo, self.answer, self.calls, self.seen_status = repo, answer, [], []

    def relay(self, packet, signature):
        ref = packet["intent"]["paperOrderRef"]
        self.seen_status.append(self.repo.get(ref)["status"])  # must already be UNKNOWN
        self.calls.append(packet)
        if isinstance(self.answer, Exception):
            raise self.answer
        if isinstance(self.answer, dict):
            return dict(self.answer)
        if self.answer == "blocked":  # the gateway's own pre-reserve_intent block
            return {"status": "blocked", "submitted_orders": [], "intent_id": None, "blocked_before_reservation": True}
        return {"status": self.answer, "submitted_orders": []}


GENESIS = "1970-01-01T00:00:00+00:00"  # a readable chain always has its genesis pause
OPEN = {"status": "live_submission_open", "reason": None, "durable_pause": False, "last_pause_at": GENESIS}
PAUSED = {"status": "live_submission_paused", "reason": "paused", "durable_pause": True, "last_pause_at": GENESIS}
LAPSED = {"status": "live_submission_paused", "reason": "live_approval_expired", "durable_pause": False,
          "last_pause_at": GENESIS}


def _run(repo, broker, gateway, orders, now, *, control=OPEN, trading_day=True, denominator=2_000_000.0,
         config=None, status=None, clock=None, warn=None):
    def state():
        if isinstance(control, Exception):
            raise control
        return control

    return li.run_live_intake(
        paper_orders=orders, live_config=config or _config(), trading_day_confirmed=trading_day,
        submission_state=state, market=broker, repository=repo, relay=gateway.relay,
        status=status or (lambda key: {"status": "error", "reason": "execution_gateway_status_http_404"}),
        fees=FEES, risk_config=RISK, now=now, clock=clock or (lambda: now), warn=warn,
        paper_portfolio_value=denominator if callable(denominator) else (lambda order: denominator))


# --- conversion (pure) ---

def _convert(order, **kw):
    args = dict(paper_position_before=0, paper_portfolio_value=2_000_000.0, live_nav=1_000_000.0,
                live_position_shares=0, live_available_cash=1_000_000.0, fees=FEES, risk_config=RISK)
    args.update(kw)
    return li.convert_paper_order(order=order, **args)


def test_buy_scales_by_live_nav_over_paper_portfolio_value():
    out = _convert(_order(1, "buy", 3209, 100.0))
    assert out["status"] == "RECEIVED" and out["live_shares"] == 1604  # floor(3209 x 0.5)
    assert out["conversion"]["ratio"] == 0.5 and out["conversion"]["truncations"] == []
    assert out["conversion_sha256"] == li._sha(out["conversion"])


def test_buy_is_cut_by_broker_cash_including_the_minimum_commission():
    # 14 x 100 = 1400 + max(1.995, 20) = 1420 <= 1430; 15 shares would need 1520.
    out = _convert(_order(1, "buy", 1000, 100.0), live_available_cash=1430.0)
    assert out["live_shares"] == 14
    assert out["conversion"]["truncations"] == [{"by": "broker_cash", "from": 500, "to": 14}]
    assert li.buy_cash_required(14, 100.0, FEES) <= 1430 < li.buy_cash_required(15, 100.0, FEES)


def test_buy_is_cut_by_the_single_order_value_cap():
    out = _convert(_order(1, "buy", 40_000, 100.0), risk_config={"order": {"maxSingleOrderValue": 150_000}},
                   live_available_cash=10_000_000.0)
    assert out["live_shares"] == 1500 and out["conversion"]["truncations"][-1]["by"] == "max_single_order_value"


@pytest.mark.parametrize("kw,reason", [
    ({"paper_portfolio_value": None}, "paper_denominator_unavailable"),
    ({"paper_portfolio_value": 0.0}, "paper_denominator_unavailable"),
    ({"fees": None}, "trading_fees_unavailable"),
    ({"fees": {"commission": 0.001425}}, "trading_fees_unavailable"),
    ({"risk_config": {}}, "risk_config_unavailable"),
    ({"live_nav": 0.0}, "live_account_invalid"),
])
def test_buy_without_a_needed_input_is_blocked(kw, reason):
    out = _convert(_order(1, "buy", 1000, 100.0), **kw)
    assert (out["status"], out["live_shares"], out["reason"]) == ("BLOCKED", 0, reason)


def test_a_buy_that_scales_below_one_share_is_skipped():
    out = _convert(_order(1, "buy", 1, 100.0))
    assert (out["status"], out["live_shares"], out["reason"]) == ("SKIPPED", 0, "live_shares_zero")


def test_paper_flatten_sells_every_live_share_without_a_denominator():
    out = _convert(_order(2, "sell", 3000, 100.0), paper_position_before=3000, live_position_shares=1234,
                   paper_portfolio_value=None)
    assert out["status"] == "RECEIVED" and out["live_shares"] == 1234 and out["conversion"]["paper_flattened"]
    empty = _convert(_order(2, "sell", 3000, 100.0), paper_position_before=3000, live_position_shares=0)
    assert (empty["status"], empty["reason"]) == ("SKIPPED", "live_position_empty")


def test_a_partial_sell_sells_the_same_fraction_of_live_holdings():
    # Wei 3e (10/29): floor(Paper sold / Paper held before x Live shares); no denominator needed.
    out = _convert(_order(2, "sell", 2000, 100.0), paper_position_before=3000, live_position_shares=700,
                   paper_portfolio_value=None)
    assert (out["status"], out["live_shares"]) == ("RECEIVED", 466)
    assert out["conversion"]["sell_fraction"] == [2000, 3000] and not out["conversion"]["paper_flattened"]
    tiny = _convert(_order(2, "sell", 1, 100.0), paper_position_before=3000, live_position_shares=700)
    assert (tiny["status"], tiny["reason"]) == ("SKIPPED", "live_shares_zero")


@pytest.mark.parametrize("before", [0, 999, -5, None])
def test_a_sell_larger_than_paper_holdings_is_blocked(before):
    out = _convert(_order(2, "sell", 1000, 100.0), paper_position_before=before, live_position_shares=700)
    assert (out["status"], out["reason"]) == ("BLOCKED", "paper_position_inconsistent")


@pytest.mark.parametrize("order", [
    {"id": 1, "symbol": "2330", "side": "short", "shares": 1000, "price": 100.0},
    {"id": 1, "symbol": "2330", "side": "buy", "shares": 0, "price": 100.0},
    {"id": 1, "symbol": "2330", "side": "buy", "shares": 1000, "price": float("nan")},
    {"id": 1, "symbol": "", "side": "buy", "shares": 1000, "price": 100.0},
])
def test_an_invalid_paper_order_is_blocked(order):
    assert _convert(order)["reason"] == "paper_order_invalid"


@pytest.mark.parametrize("shares", [1, 999, 1000, 1001, 3209, 20000])
def test_live_legs_split_board_and_odd_lots(shares):
    intent = {**li.live_intent(_order(1, "buy", shares, 100.0), shares, 100.0), "tradeDate": DAY}
    assert validate_stockvision_execution_intent(intent) is None
    assert sum(leg["shares"] for leg in intent["orderLegs"]) == shares
    assert all(leg["oddLot"] == (leg["lotType"] == "odd_lot") for leg in intent["orderLegs"])


def test_paper_holdings_before_each_order_come_from_orders_only():
    orders = [_order(1, "buy", 3000, 100.0), _order(2, "sell", 1000, 101.0), _order(3, "buy", 500, 99.0),
              _order(4, "sell", 2500, 102.0)]
    assert li.paper_positions_before(orders) == {1: 0, 2: 3000, 3: 2000, 4: 2500}


# --- orchestration with the fake broker ---

def test_paper_mode_records_and_sends_nothing():
    repo, conn = _repo()
    gw = Gateway(repo)
    out = _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"), config=_config("paper"))
    assert out["status"] == "idle" and gw.calls == []
    assert conn.execute("SELECT COUNT(*) FROM live_intake_orders_v1").fetchone()[0] == 0


def test_missing_live_config_blocks_the_pass():
    repo, _ = _repo()
    out = li.run_live_intake(paper_orders=[], live_config=None, trading_day_confirmed=True,
                             submission_state=lambda: OPEN, market=FakeBroker(), repository=repo,
                             relay=Gateway(repo).relay, status=lambda k: {}, fees=FEES, risk_config=RISK,
                             paper_portfolio_value=lambda o: 1.0, now=_tw(DAY, "10:01"))
    assert out["reason"] == "live_config_unavailable"


@pytest.mark.parametrize("exchange", ["TSE", "OTC"])
def test_an_in_session_buy_is_marked_unknown_before_the_relay_then_relayed(exchange):
    repo, _ = _repo()
    broker, gw = FakeBroker(exchange=exchange), Gateway(repo)
    out = _run(repo, broker, gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert out["relayed"] == ["paper_orders:1"] and gw.seen_status == ["UNKNOWN"]
    row = repo.get("paper_orders:1")
    assert row["status"] == "RELAYED" and row["live_shares"] == 500
    assert row["idempotency_key"] == "live-intake:paper_orders:1"
    assert gw.calls[0]["broker_truth"]["exchange"] == exchange
    assert gw.calls[0]["intent"]["requestedShares"] == 500 and gw.calls[0]["intent"]["limitPrice"] == 100.0


def test_an_unclear_relay_is_never_sent_again_and_settles_only_by_reconciliation():
    repo, _ = _repo()
    broker, gw = FakeBroker(), Gateway(repo, answer=TimeoutError("relay"))
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN" and len(gw.calls) == 1
    gw.answer = "submitted"
    # Before the packet expires a missing gateway intent proves nothing.
    _run(repo, broker, gw, orders, _tw(DAY, "10:02"))
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN" and len(gw.calls) == 1
    # A reached broker leg settles it as RELAYED, still without a resend.
    lifecycle = {"status": "ok", "legs": [{"status": "ACKNOWLEDGED"}]}
    _run(repo, broker, gw, orders, _tw(DAY, "10:03"), status=lambda key: lifecycle)
    assert repo.get("paper_orders:1")["status"] == "RELAYED" and len(gw.calls) == 1


@pytest.mark.parametrize("lifecycle", [
    {"status": "error", "reason": "execution_gateway_status_http_404"},
    {"status": "ok", "legs": [{"status": "REJECTED"}]},
    {"status": "ok", "legs": [{"status": "RESERVED"}]},
])
def test_after_expiry_an_order_that_never_reached_the_broker_settles_blocked(lifecycle):
    repo, _ = _repo()
    gw = Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"))
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "14:01"), status=lambda key: lifecycle)
    row = repo.get("paper_orders:1")
    assert row["status"] == "BLOCKED" and len(gw.calls) == 1


@pytest.mark.parametrize("leg", ["SUBMITTING", "UNKNOWN", "PARTIALLY_FILLED", "FILLED", "CANCELLED"])
def test_a_leg_that_may_be_at_the_broker_is_never_blocked(leg):
    repo, _ = _repo()
    gw = Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"))
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "14:01"),
         status=lambda key: {"status": "ok", "legs": [{"status": "REJECTED"}, {"status": leg}]})
    assert repo.get("paper_orders:1")["status"] == "RELAYED"


def test_a_gateway_block_settles_blocked():
    repo, _ = _repo()
    gw = Gateway(repo, answer="blocked")
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert repo.get("paper_orders:1")["status"] == "BLOCKED"


def test_live_closed_blocks_pending_orders_and_they_are_not_sent_after_reopening():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"), control=PAUSED)
    row = repo.get("paper_orders:1")
    assert row["status"] == "BLOCKED"
    assert json.loads(row["status_reason"]) == {"reason": "live_paused_before_send", "control": "paused"}
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:02"))
    assert gw.calls == []


def test_an_after_close_paper_exit_is_deferred_and_released_next_trading_day_after_release():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    row = repo.get("paper_orders:2")
    # Paper sold 1000 of 2000: half of the 600 Live shares.
    assert (row["status"], row["status_reason"], row["live_shares"]) == ("DEFERRED", "paper_exit_outside_session", 300)
    _run(repo, broker, gw, orders, _tw(NEXT, "08:59"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED" and gw.calls == []
    broker.holdings = {"2330": 200}  # fewer shares than converted: cut at release
    _run(repo, broker, gw, orders, _tw(NEXT, "09:00"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED"
    assert gw.calls[0]["intent"]["requestedShares"] == 200 and gw.calls[0]["intent"]["limitPrice"] == 99.5


def test_a_deferred_exit_with_no_live_shares_left_is_blocked():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    broker.holdings = {}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    row = repo.get("paper_orders:2")
    assert row["status"] == "BLOCKED" and json.loads(row["status_reason"])["reason"] == "deferred_nothing_to_sell"
    assert gw.calls == []


def test_a_pause_before_release_means_the_deferred_exit_is_never_sent():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    _run(repo, broker, gw, orders, _tw(NEXT, "08:30"), control=PAUSED)
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "BLOCKED" and gw.calls == []


def test_a_paper_buy_outside_the_session_is_skipped():
    repo, _ = _repo()
    gw = Gateway(repo)
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0, hhmm="13:35")], _tw(DAY, "13:40"))
    assert repo.get("paper_orders:1")["status"] == "SKIPPED" and gw.calls == []


def test_without_a_confirmed_trading_day_nothing_is_sent_and_a_stale_received_order_is_blocked_next_day():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"), trading_day=False)
    assert repo.get("paper_orders:1")["status"] == "RECEIVED" and gw.calls == []
    _run(repo, FakeBroker(), gw, orders, _tw(NEXT, "10:01"))
    assert repo.get("paper_orders:1")["status"] == "BLOCKED" and gw.calls == []


def test_an_unreadable_live_account_records_and_sends_nothing():
    repo, conn = _repo()
    broker, gw = FakeBroker(), Gateway(repo)
    broker.fail_account = True
    out = _run(repo, broker, gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert out["reason"] == "live_account_unavailable:TimeoutError" and gw.calls == []
    assert conn.execute("SELECT COUNT(*) FROM live_intake_orders_v1").fetchone()[0] == 0


def test_buys_in_one_pass_share_the_broker_cash():
    repo, _ = _repo()
    broker, gw = FakeBroker(cash=80_000.0), Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0, symbol="2330"), _order(2, "buy", 1000, 100.0, symbol="2317")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"), denominator=160_000.0)
    first, second = repo.get("paper_orders:1"), repo.get("paper_orders:2")
    assert first["live_shares"] == 500  # 50,071.25 needed of 80,000
    assert second["live_shares"] == 298  # what is left after the first buy
    used = sum(li.buy_cash_required(r["live_shares"], 100.0, FEES) for r in (first, second))
    assert used <= 80_000


def test_two_sells_in_one_pass_never_sell_more_than_held():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 400}), Gateway(repo)
    orders = [_order(1, "buy", 4000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0),
              _order(3, "sell", 1000, 100.0, hhmm="10:05")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"))
    assert [repo.get(f"paper_orders:{i}")["live_shares"] for i in (2, 3)] == [100, 100]  # 1/4 then 1/3
    assert repo.get("paper_orders:2")["live_shares"] + repo.get("paper_orders:3")["live_shares"] <= 400


def test_conversion_rows_are_immutable_and_unknown_cannot_become_sendable():
    repo, conn = _repo()
    gw = Gateway(repo, answer="unknown")
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("UPDATE live_intake_orders_v1 SET live_shares=1 WHERE paper_order_ref='paper_orders:1'")
    assert not repo.transition("paper_orders:1", expected="RECEIVED", status="RELAYED", reason="x")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("UPDATE live_intake_orders_v1 SET status='RECEIVED' WHERE paper_order_ref='paper_orders:1'")
    row = dict(repo.get("paper_orders:1"))
    with pytest.raises(RuntimeError, match="live_intake_conversion_conflict"):
        repo.insert({**row, "conversion_sha256": "0" * 64})


def test_earlier_days_orders_are_not_new():
    repo, conn = _repo()
    gw = Gateway(repo)
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0, day="2026-12-09")], _tw(DAY, "10:01"))
    assert conn.execute("SELECT COUNT(*) FROM live_intake_orders_v1").fetchone()[0] == 0 and gw.calls == []


def test_a_released_exit_and_a_new_sell_of_the_same_symbol_never_sell_more_than_held():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 3000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    orders.append(_order(3, "sell", 1000, 100.0, day=NEXT, hhmm="09:01"))
    _run(repo, broker, gw, orders, _tw(NEXT, "09:02"))
    sent = sum(packet["intent"]["requestedShares"] for packet in gw.calls)
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and sent <= 600
    assert json.loads(repo.get("paper_orders:3")["conversion_json"])["inputs"]["live_position_shares"] == 600 - 200


# --- verifier round 1 and Wei 10/29 follow-ups ---

def test_a_paper_exit_seconds_after_the_close_is_deferred_not_lost():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    late = _order(2, "sell", 2000, 101.0)
    late["created_at"] = (_tw(DAY, "13:30") + timedelta(seconds=30)).astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), late]
    _run(repo, broker, gw, orders, _tw(DAY, "13:31"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and gw.calls[0]["intent"]["requestedShares"] == 600


def test_an_in_session_exit_the_intake_saw_too_late_carries_over_to_the_next_day():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="11:00")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:40"))
    assert repo.get("paper_orders:2")["status"] == "RECEIVED" and gw.calls == []
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED"
    assert [p["intent"]["requestedShares"] for p in gw.calls] == [300]


@pytest.mark.parametrize("answer", ["submitted", "unknown"])
def test_buys_sent_in_an_earlier_pass_still_hold_their_cash(answer):
    repo, _ = _repo()
    broker, gw = FakeBroker(cash=100_000.0), Gateway(repo, answer=answer)
    orders = [_order(1, "buy", 1800, 100.0, symbol="2330")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"), denominator=200_000.0)
    assert repo.get("paper_orders:1")["live_shares"] == 900
    gw.answer = "submitted"
    orders.append(_order(2, "buy", 1800, 100.0, symbol="2317", hhmm="10:05"))
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"), denominator=200_000.0)
    assert repo.get("paper_orders:2")["live_shares"] == 98  # 100,000 - 90,128.25 left
    sent = sum(li.buy_cash_required(p["intent"]["requestedShares"], 100.0, FEES) for p in gw.calls)
    assert sent <= 100_000


def test_a_blocked_buy_from_an_earlier_pass_frees_its_cash():
    repo, _ = _repo()
    broker, gw = FakeBroker(cash=100_000.0), Gateway(repo, answer="blocked")
    orders = [_order(1, "buy", 1800, 100.0, symbol="2330")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"), denominator=200_000.0)
    gw.answer = "submitted"
    orders.append(_order(2, "buy", 1800, 100.0, symbol="2317", hhmm="10:05"))
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"), denominator=200_000.0)
    assert repo.get("paper_orders:2")["live_shares"] == 900


def test_orders_on_a_day_the_intake_missed_are_recorded_not_dropped():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09")]
    _run(repo, broker, gw, orders, _tw("2026-12-09", "10:01"))  # Live began on 12/09
    orders += [_order(2, "sell", 1000, 101.0), _order(3, "buy", 500, 100.0, hhmm="10:30")]
    _run(repo, broker, gw, orders, _tw(NEXT, "08:30"))  # no pass ran on 12/10
    sell, buy = repo.get("paper_orders:2"), repo.get("paper_orders:3")
    assert (sell["status"], sell["status_reason"], sell["live_shares"]) == ("DEFERRED", "paper_exit_missed_by_intake", 300)
    assert (buy["status"], buy["status_reason"]) == ("SKIPPED", "paper_buy_missed_by_intake")
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED"
    assert [p["intent"]["paperOrderRef"] for p in gw.calls] == ["paper_orders:1", "paper_orders:2"]


@pytest.mark.parametrize("control", [LAPSED, RuntimeError("d1"), {"status": "live_submission_open"}])
def test_a_temporary_closure_holds_orders_without_sending_or_blocking(control):
    if isinstance(control, dict) and control["status"] == "live_submission_open":
        control = {**control, "status": "live_submission_open_typo"}  # anything but exactly open is closed
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40"),
              _order(3, "buy", 100, 100.0, day=NEXT, hhmm="09:01")]
    _run(repo, broker, gw, orders[:2], _tw(DAY, "13:45"))
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control=control)
    assert repo.get("paper_orders:2")["status"] == "DEFERRED" and repo.get("paper_orders:3")["status"] == "RECEIVED"
    assert gw.calls == []
    _run(repo, broker, gw, orders, _tw(NEXT, "09:10"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and repo.get("paper_orders:3")["status"] == "RELAYED"


@pytest.mark.parametrize("durable", [1, "true", None])
def test_only_a_literal_true_durable_pause_is_durable(durable):
    repo, _ = _repo()
    gw = Gateway(repo)
    control = {"status": "live_submission_paused", "reason": "x", "durable_pause": durable}
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"), control=control)
    assert repo.get("paper_orders:1")["status"] == "RECEIVED" and gw.calls == []


def test_a_durable_pause_blocks_deferred_orders_for_good():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control=PAUSED)
    _run(repo, broker, gw, orders, _tw(NEXT, "09:10"))
    assert repo.get("paper_orders:2")["status"] == "BLOCKED" and gw.calls == []


@pytest.mark.parametrize("bid", [None, 0.0, float("nan"), RuntimeError("hub")])
def test_a_deferred_exit_without_a_fresh_quote_stays_deferred(bid):
    class Broker(FakeBroker):
        def deferred_sell_price(self, symbol):
            if isinstance(bid, Exception):
                raise bid
            return bid

    repo, _ = _repo()
    broker, gw = Broker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    out = _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED" and gw.calls == []
    assert out["deferred"] == ["paper_orders:2"] and len(out["errors"]) == 1


def test_a_deferred_exit_whose_packet_fails_stays_deferred():
    class Broker(FakeBroker):
        def signed_packet(self, intent, key, trade_date):
            raise TimeoutError("hub")

    repo, _ = _repo()
    broker, gw = Broker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    out = _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    assert out["errors"] == ["paper_orders:2:packet_unavailable:TimeoutError"]


def test_a_deferred_exit_from_today_waits_for_the_next_session():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="08:30")]
    _run(repo, broker, gw, orders, _tw(DAY, "08:31"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    _run(repo, broker, gw, orders, _tw(DAY, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED" and gw.calls == []


def test_a_deferred_exit_waits_for_the_configured_release_time():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    config = {**_config(), "session": {**_config()["session"], "deferred_sell_release": "09:30"}}
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"), config=config)
    _run(repo, broker, gw, orders, _tw(NEXT, "09:29"), config=config)
    assert gw.calls == []
    _run(repo, broker, gw, orders, _tw(NEXT, "09:30"), config=config)
    assert repo.get("paper_orders:2")["status"] == "RELAYED"


@pytest.mark.parametrize("lifecycle", [
    {"status": "ok", "legs": [{"status": "rejected"}]},
    {"status": "ok", "legs": [{"status": "REJECTED"}, "garbage"]},
    {"status": "ok", "legs": "x"},
    {"status": "error", "legs": [{"status": "REJECTED"}]},
    {"status": "unknown", "reason": "execution_gateway_status_unavailable"},
    RuntimeError("status"),
])
def test_an_unclear_lifecycle_never_settles_an_unknown_order(lifecycle):
    repo, _ = _repo()
    gw = Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"))

    def status(key):
        if isinstance(lifecycle, Exception):
            raise lifecycle
        return lifecycle

    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "14:01"), status=status)
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN" and len(gw.calls) == 1


def test_expiry_allows_for_clock_skew():
    repo, _ = _repo()
    gw = Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"))
    expires = datetime.fromisoformat(json.loads(repo.get("paper_orders:1")["status_reason"])["packet_expires_at"])
    _run(repo, FakeBroker(), gw, orders, expires + timedelta(seconds=li.CLOCK_SKEW_SECONDS))
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN"
    _run(repo, FakeBroker(), gw, orders, expires + timedelta(seconds=li.CLOCK_SKEW_SECONDS + 1))
    assert repo.get("paper_orders:1")["status"] == "BLOCKED"


@pytest.mark.parametrize("bad", [{"schema_version": "bogus"}, {"sha256": ""}, {"account_scope": "paper:1"},
                                 {"observed_at": "2026-12-09T09:00:00+08:00"}])
def test_an_unverified_broker_observation_is_never_used(bad):
    class Bad(FakeBroker):
        def account(self, business_date):
            observation, marks = super().account(business_date)
            return {**observation, **bad}, marks

    repo, conn = _repo()
    gw = Gateway(repo)
    out = _run(repo, Bad(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert out["reason"] == "live_account_unavailable:ValueError" and gw.calls == []
    assert conn.execute("SELECT COUNT(*) FROM live_intake_orders_v1").fetchone()[0] == 0


@pytest.mark.parametrize("mode", [["live"], {"live": 1}, 1])
def test_an_invalid_live_config_blocks_the_pass(mode):
    repo, _ = _repo()
    gw = Gateway(repo)
    out = _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"),
               config={**_config(), "mode": mode})
    assert (out["status"], out["reason"]) == ("blocked", "live_config_text_field_invalid") and gw.calls == []


def test_unsettled_payables_are_not_spendable_cash():
    class Owing(FakeBroker):
        def account(self, business_date):
            observation, marks = super().account(business_date)
            return {**observation, "settlements": [{"date": "2026-12-14", "net_amount": -60_000.0}]}, marks

    repo, _ = _repo()
    gw = Gateway(repo)
    # NAV 40,000 = 100,000 bank - 60,000 due after today; ratio 1 wants 1000 shares, but only
    # 40,000 is free: 399 x 100 + 56.86 commission fits, 400 shares do not.
    _run(repo, Owing(cash=100_000.0), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"), denominator=40_000.0)
    conversion = json.loads(repo.get("paper_orders:1")["conversion_json"])
    assert conversion["live_shares"] == 399 and conversion["truncations"][0]["by"] == "broker_cash"


def test_a_deferred_flatten_sells_every_share_held_at_release():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 2000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    assert repo.get("paper_orders:2")["live_shares"] == 600
    broker.holdings = {"2330": 800}  # a late fill landed overnight; Paper holds nothing
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert gw.calls[0]["intent"]["requestedShares"] == 800


# --- verifier round 2: nothing committed by an earlier pass is used twice ---

def test_an_open_sell_from_an_earlier_pass_holds_its_shares():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"))  # 500 sent; the broker still shows 1000
    orders.append(_order(3, "sell", 1000, 100.0, hhmm="10:05"))  # Paper flatten
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"))
    assert [p["intent"]["requestedShares"] for p in gw.calls] == [500, 500]


@pytest.mark.parametrize("held_by", ["temporary_closure", "deferred"])
def test_an_unsent_sell_holds_its_shares_for_later_sells(held_by):
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    first = _order(2, "sell", 1000, 100.0, hhmm="13:40" if held_by == "deferred" else "10:00")
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), first]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45" if held_by == "deferred" else "10:01"),
         control=OPEN if held_by == "deferred" else LAPSED)
    assert gw.calls == [] and repo.get("paper_orders:2")["live_shares"] == 500
    when = NEXT if held_by == "deferred" else DAY
    orders.append(_order(3, "sell", 500, 100.0, day=when, hhmm="09:30" if held_by == "deferred" else "10:05"))
    _run(repo, broker, gw, orders, _tw(when, "09:31" if held_by == "deferred" else "10:06"), control=LAPSED)
    # Paper sold 500 of the 1000 left: half of the 500 Live shares not already committed.
    assert json.loads(repo.get("paper_orders:3")["conversion_json"])["inputs"]["live_position_shares"] == 500
    _run(repo, broker, gw, orders, _tw(when, "10:10"))
    assert sorted(p["intent"]["requestedShares"] for p in gw.calls) == [250, 500]


def test_two_deferred_exits_of_one_symbol_never_sell_more_than_held():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40"),
              _order(3, "sell", 1000, 101.0, hhmm="13:50")]  # partial, then flatten
    _run(repo, broker, gw, orders, _tw(DAY, "13:55"))
    assert [repo.get(f"paper_orders:{i}")["live_shares"] for i in (2, 3)] == [300, 300]
    broker.holdings = {"2330": 500}  # 100 fewer than both conversions
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    # First in, first out: the older partial exit sells its 300; the flatten sells what is left.
    assert [p["intent"]["requestedShares"] for p in gw.calls] == [300, 200]


def test_a_buy_held_by_a_temporary_closure_holds_its_cash():
    repo, _ = _repo()
    broker, gw = FakeBroker(cash=100_000.0), Gateway(repo)
    orders = [_order(1, "buy", 30_000, 100.0)]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"), control=LAPSED)
    orders.append(_order(2, "buy", 30_000, 100.0, symbol="2317", hhmm="10:05"))
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"))
    cash = sum(li.buy_cash_required(p["intent"]["requestedShares"], 100.0, FEES) for p in gw.calls)
    assert gw.calls[0]["intent"]["requestedShares"] == 998 and cash <= 100_000
    assert repo.get("paper_orders:2")["status"] == "SKIPPED"  # nothing left after the held buy


def test_reservations_count_only_what_may_still_trade():
    def row(ref, side, status, shares, day=DAY, reason=None, sent_on=None):
        conversion = json.dumps({"inputs": {"paper_price": 100.0}})
        return {"paper_order_ref": ref, "side": side, "status": status, "live_shares": shares, "symbol": "2330",
                "trade_date": day, "status_reason": reason, "conversion_json": conversion, "sent_on": sent_on}

    sent = json.dumps({"reason": "gateway_submitted", "shares": 7, "limit_price": 50.0})
    rows = [row("a", "buy", "RECEIVED", 10), row("b", "buy", "RELAYED", 99, reason=sent, sent_on=DAY),
            row("c", "buy", "BLOCKED", 1000, sent_on=DAY), row("d", "buy", "RELAYED", 1000, day="2026-12-09",
                                                                sent_on="2026-12-09"),
            row("k", "buy", "RECEIVED", 1000, day="2026-12-09"),
            row("e", "sell", "DEFERRED", 5, day="2026-12-09", reason="paper_exit_outside_session"),
            row("f", "sell", "RELAYED", 3, reason=sent, sent_on=DAY),
            row("g", "sell", "RELAYED", 1000, day="2026-12-09", sent_on="2026-12-09"),
            row("l", "sell", "RELAYED", 13, day="2026-12-08", sent_on=DAY),  # a DEFERRED exit released today
            row("h", "sell", "UNKNOWN", 2, day="2026-12-09"), row("i", "sell", "SKIPPED", 1000),
            row("j", "sell", "RECEIVED", 11), row("m", "sell", "BLOCKED", 1000, sent_on=DAY)]
    cash, shares = li.reservations(rows, DAY, FEES)
    assert cash == pytest.approx(li.buy_cash_required(10, 100.0, FEES) + li.buy_cash_required(7, 50.0, FEES))
    assert shares == {"2330": 5 + 7 + 13 + 2 + 11}


def test_a_failed_unknown_mark_never_reaches_the_relay():
    repo, _ = _repo()
    gw = Gateway(repo)

    class Stuck:
        def __getattr__(self, name):
            return getattr(repo, name)

        def transition(self, ref, *, expected, status, reason, idempotency_key=None, sent_on=None):
            if status == "UNKNOWN":
                return False
            return repo.transition(ref, expected=expected, status=status, reason=reason,
                                   idempotency_key=idempotency_key, sent_on=sent_on)

    out = _run(Stuck(), FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert gw.calls == [] and out["unknown"] == ["paper_orders:1"]


def test_a_gateway_block_after_a_leg_was_submitted_stays_unknown():
    repo, _ = _repo()

    class Partial(Gateway):
        def relay(self, packet, signature):
            super().relay(packet, signature)
            return {"status": "blocked", "submitted_orders": [{"leg": "board_lot"}], "blocked_before_reservation": True}

    gw = Partial(repo)
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN"


def test_the_single_order_cap_rounds_down():
    out = _convert(_order(1, "buy", 40_000, 99.9), risk_config={"order": {"maxSingleOrderValue": 150_000}},
                   live_available_cash=10_000_000.0)
    assert out["live_shares"] == 1501 and out["live_shares"] * 99.9 <= 150_000


def test_an_earlier_days_unsent_buy_is_blocked_and_never_sent():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"), control=LAPSED)
    _run(repo, FakeBroker(), gw, orders, _tw(NEXT, "10:01"))
    row = repo.get("paper_orders:1")
    assert row["status"] == "BLOCKED" and json.loads(row["status_reason"])["reason"] == "received_buy_not_sent_on_its_day"
    assert gw.calls == []


def test_a_missed_days_buy_is_skipped_whatever_its_conversion():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0, day="2026-12-09")]
    _run(repo, FakeBroker(), gw, orders, _tw("2026-12-09", "10:01"))
    orders.append(_order(2, "buy", 1000, 100.0))
    _run(repo, FakeBroker(), gw, orders, _tw(NEXT, "10:01"), denominator=None)
    row = repo.get("paper_orders:2")
    assert (row["status"], row["status_reason"]) == ("SKIPPED", "paper_buy_missed_by_intake")


def test_nothing_is_sent_one_second_after_the_close():
    repo, _ = _repo()
    gw = Gateway(repo)
    out = _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0, hhmm="13:29")],
               _tw(DAY, "13:30") + timedelta(seconds=1))
    assert gw.calls == [] and repo.get("paper_orders:1")["status"] == "RECEIVED" and out["status"] == "ok"


# --- verifier round 3 ---

def test_an_exit_released_today_still_holds_its_shares_in_later_passes():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))  # 500 released and open; broker still shows 1000
    orders.append(_order(3, "sell", 1000, 100.0, day=NEXT, hhmm="10:00"))  # Paper flatten
    _run(repo, broker, gw, orders, _tw(NEXT, "10:01"))
    assert [p["intent"]["requestedShares"] for p in gw.calls] == [500, 500]


def test_an_exit_settled_relayed_by_reconciliation_today_still_holds_its_shares():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    gw.answer = "submitted"
    orders.append(_order(3, "sell", 500, 100.0, day=NEXT, hhmm="10:00"))
    _run(repo, broker, gw, orders, _tw(NEXT, "10:01"),
         status=lambda key: {"status": "ok", "legs": [{"status": "ACKNOWLEDGED"}]})
    assert repo.get("paper_orders:2")["status"] == "RELAYED"
    # Paper sold 500 of 1000: half of the 500 Live shares not already committed.
    assert json.loads(repo.get("paper_orders:3")["conversion_json"])["inputs"]["live_position_shares"] == 500
    assert [p["intent"]["requestedShares"] for p in gw.calls] == [500, 250]


@pytest.mark.parametrize("later", [LAPSED, PAUSED, RuntimeError("d1"), "closed"])
def test_each_send_rechecks_control_and_clock(later):
    repo, _ = _repo()
    gw = Gateway(repo)
    reads = []

    def state():
        reads.append(1)
        if len(reads) == 1:
            return OPEN
        if isinstance(later, Exception):
            raise later
        return OPEN if later == "closed" else later

    moments = iter([_tw(DAY, "13:30") + timedelta(seconds=1)])
    out = li.run_live_intake(
        paper_orders=[_order(1, "buy", 1000, 100.0, hhmm="13:29")], live_config=_config(),
        trading_day_confirmed=True, submission_state=state, market=FakeBroker(), repository=repo,
        relay=gw.relay, status=lambda key: {}, fees=FEES, risk_config=RISK,
        paper_portfolio_value=lambda order: 2_000_000.0, now=_tw(DAY, "13:29") + timedelta(seconds=59),
        clock=(lambda: next(moments)) if later == "closed" else (lambda: _tw(DAY, "13:29")))
    assert gw.calls == []
    expected = "BLOCKED" if later is PAUSED else "RECEIVED"
    assert repo.get("paper_orders:1")["status"] == expected and out["status"] == "ok"


def test_a_sell_whose_packet_fails_is_held_then_carried_to_the_next_day():
    class Flaky(FakeBroker):
        fail = True

        def signed_packet(self, intent, key, trade_date):
            if self.fail:
                raise TimeoutError("hub")
            return super().signed_packet(intent, key, trade_date)

    repo, _ = _repo()
    broker, gw = Flaky(holdings={"2330": 600}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="11:00")]
    out = _run(repo, broker, gw, orders, _tw(DAY, "11:01"))
    assert repo.get("paper_orders:2")["status"] == "RECEIVED" and out["errors"] == [
        "paper_orders:2:packet_unavailable:TimeoutError"]
    broker.fail = False
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and len(gw.calls) == 1


@pytest.mark.parametrize("reason", ["live_submission_paused:live_approval_expired",
                                    "runtime_market_session_closed", "authoritative_hub_snapshot_stale"])
def test_a_sell_the_gateway_blocks_before_reserving_is_deferred_not_lost(reason):
    class Blocking(Gateway):
        def relay(self, packet, signature):
            super().relay(packet, signature)
            if len(self.calls) == 1:
                return {"status": "blocked", "reason": reason, "blocked_before_reservation": True}
            return {"status": "submitted", "submitted_orders": []}

    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Blocking(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 101.0, hhmm="11:00")]
    _run(repo, broker, gw, orders, _tw(DAY, "11:01"))
    row = repo.get("paper_orders:2")
    assert row["status"] == "DEFERRED" and json.loads(row["status_reason"])["detail"] == reason
    _run(repo, broker, gw, orders, _tw(DAY, "11:30"))
    assert len(gw.calls) == 1  # never resent the same day
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and len(gw.calls) == 2
    assert gw.calls[1]["idempotency_key"] == gw.calls[0]["idempotency_key"]


@pytest.mark.parametrize("reason", ["execution_idempotency_conflict", "execution_reservation_failed:TimeoutError"])
@pytest.mark.parametrize("side", ["buy", "sell"])
def test_a_block_that_may_follow_a_reservation_stays_unknown(reason, side):
    class Blocking(Gateway):
        def relay(self, packet, signature):
            super().relay(packet, signature)
            # even marked, a block that may follow a reservation stays UNKNOWN
            return {"status": "blocked", "reason": reason, "blocked_before_reservation": True}

    repo, _ = _repo()
    gw = Blocking(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09")] if side == "sell" else []
    orders.append(_order(2, side, 1000, 100.0))
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:2")["status"] == "UNKNOWN"


def test_two_overlapping_passes_never_both_claim_one_order():
    repo, _ = _repo()
    gw = Gateway(repo)
    calls = []  # a second pass runs inside the first one's relay window

    def relay(packet, signature):
        calls.append(packet)
        if len(calls) == 1:
            _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
        return {"status": "submitted", "submitted_orders": []}

    li.run_live_intake(
        paper_orders=[_order(1, "buy", 1000, 100.0)], live_config=_config(), trading_day_confirmed=True,
        submission_state=lambda: OPEN, market=FakeBroker(), repository=repo, relay=relay,
        status=lambda key: {}, fees=FEES, risk_config=RISK, paper_portfolio_value=lambda o: 2_000_000.0,
        now=_tw(DAY, "10:01"), clock=lambda: _tw(DAY, "10:01"))
    assert len(calls) == 1 and gw.calls == []


def test_an_expired_order_with_no_legs_stays_unknown():
    repo, _ = _repo()
    gw = Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"))
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "14:01"), status=lambda key: {"status": "ok", "legs": []})
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN"


def test_a_row_without_a_key_is_never_settled():
    repo, conn = _repo()
    gw = Gateway(repo, answer="unknown")
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"))
    conn.execute("DROP TRIGGER live_intake_orders_v1_conversion_immutable")
    conn.execute("UPDATE live_intake_orders_v1 SET idempotency_key=NULL")
    out = _run(repo, FakeBroker(), gw, orders, _tw(DAY, "14:01"))
    assert repo.get("paper_orders:1")["status"] == "UNKNOWN" and out["unknown"] == ["paper_orders:1"]


def test_a_block_after_the_gateway_reserved_the_intent_stays_unknown():
    class Blocking(Gateway):
        def relay(self, packet, signature):
            super().relay(packet, signature)
            return {"status": "blocked", "reason": "leg_market_data_revalidation_failed", "intent_id": "i-1",
                    "blocked_before_reservation": True}

    repo, _ = _repo()
    gw = Blocking(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:2")["status"] == "UNKNOWN"


def test_a_competing_pass_that_marked_the_order_first_wins():
    repo, _ = _repo()
    gw = Gateway(repo)

    class Raced:
        raced = False

        def __getattr__(self, name):
            return getattr(repo, name)

        def transition(self, ref, *, expected, status, reason, **kw):
            if status == "UNKNOWN" and not self.raced:
                self.raced = True  # another pass builds the same packet and marks it first
                theirs = json.loads(reason)
                if "attempt" in theirs:
                    theirs["attempt"] = "another-pass"
                repo.transition(ref, expected=expected, status=status, reason=li._reason(**theirs), **kw)
            return repo.transition(ref, expected=expected, status=status, reason=reason, **kw)

    _run(Raced(), FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert gw.calls == [] and repo.get("paper_orders:1")["status"] == "UNKNOWN"


def test_a_released_exit_the_gateway_blocks_gives_back_what_it_did_not_reserve():
    class Blocking(Gateway):
        def relay(self, packet, signature):
            super().relay(packet, signature)
            return {"status": "blocked", "reason": "authoritative_hub_snapshot_stale", "blocked_before_reservation": True}

    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 600}), Blocking(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 2000, 101.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))  # flatten, 600 reserved
    broker.holdings = {"2330": 800}
    orders += [_order(3, "buy", 100, 100.0, day=NEXT, hhmm="09:01"), _order(4, "sell", 100, 100.0, day=NEXT, hhmm="09:02")]
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    # The unsent deferred flatten holds every share until it is sent (it sells all that is
    # free then), so the new flatten waits for it and is converted against what the broker holds.
    row = repo.get("paper_orders:4")
    assert (row["status"], row["status_reason"]) == ("DEFERRED", "exit_waits_for_open_sells")
    assert json.loads(row["conversion_json"])["inputs"]["live_position_shares"] == 800


# --- Wei 10/29: UNKNOWN -> DEFERRED only on an explicit pre-reservation block ---

_PRE = {"status": "blocked", "reason": "authoritative_hub_snapshot_stale", "submitted_orders": [],
        "intent_id": None, "blocked_before_reservation": True}


@pytest.mark.parametrize("answer", [
    TimeoutError("relay timeout"),                                        # timeout: the POST may have landed
    ConnectionError("transport"),                                         # transport error
    {"status": "unknown", "reason": "execution_gateway_response_unknown_reconciliation_required"},  # 5xx
    {"status": "error", "reason": "execution_gateway_http_422"},          # non-200
    {"status": "partial", "submitted_orders": []},                        # partial answer -> RELAYED, never DEFERRED
    {**_PRE, "submitted_orders": [{"leg": "board_lot"}]},                 # a leg reached the broker
    {**_PRE, "intent_id": "i-1"},                                         # post-reserve leg block
    {**_PRE, "broker_order_id": "B-1"},                                   # broker order id present
    {**_PRE, "blocked_before_reservation": False},                        # gateway says after reservation
    {k: v for k, v in _PRE.items() if k != "blocked_before_reservation"},  # flag missing
    {**_PRE, "blocked_before_reservation": "true"},                       # flag not exactly True
    {**_PRE, "blocked_before_reservation": 1},
    {**_PRE, "status": "BLOCKED_SOMEHOW"},                                # unknown status
    {**_PRE, "status": None},                                             # missing status
    {**_PRE, "reason": "execution_idempotency_conflict"},                 # idempotency conflict
    {**_PRE, "reason": "x", "blocked_reasons": ["x", "execution_reservation_failed:OSError"]},
    {},                                                                   # empty answer
], ids=lambda a: type(a).__name__ if isinstance(a, Exception) else str(sorted(a.items()))[:60])
def test_an_uncertain_answer_never_defers_a_sent_exit(answer):
    repo, _ = _repo()
    gw = Gateway(repo, answer=answer)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    status = repo.get("paper_orders:2")["status"]
    assert status != "DEFERRED" and status in {"UNKNOWN", "RELAYED"}
    if not (isinstance(answer, dict) and answer.get("status") == "partial"):
        assert status == "UNKNOWN"  # reconcile only
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(NEXT, "09:05"))
    assert len(gw.calls) == 1  # never resent


def test_only_the_explicit_pre_reservation_block_defers_an_exit():
    repo, _ = _repo()
    gw = Gateway(repo, answer=dict(_PRE))
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"


@pytest.mark.parametrize("answer", [dict(_PRE), {**_PRE, "blocked_before_reservation": False}, {}])
def test_a_buy_never_goes_back_from_unknown_except_to_blocked(answer):
    repo, _ = _repo()
    gw = Gateway(repo, answer=answer)
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    expected = "BLOCKED" if answer.get("blocked_before_reservation") is True else "UNKNOWN"
    assert repo.get("paper_orders:1")["status"] == expected


def test_the_real_gateway_and_relay_mark_only_pre_reservation_blocks():
    from services import execution_gateway_live_relay as relay_mod
    from services import finlab_live_submit_service as gw_mod

    assert gw_mod._blocked(None, "x")["blocked_before_reservation"] is True
    assert gw_mod._blocked(None, "x", before_reservation=False)["blocked_before_reservation"] is False
    off = relay_mod.relay_execution_live_submit(packet={}, signature=None, allow_live_submit=True, env={})
    assert off == {"status": "blocked", "reason": "execution_gateway_live_relay_disabled",
                   "blocked_before_reservation": True}
    source = Path(gw_mod.__file__).read_text()
    for reason in ("execution_reservation_failed", "execution_idempotency_conflict"):
        call = source[source.index(f'_blocked(packet, f"{reason}' if reason.endswith("failed") else
                                   f'_blocked(packet, "{reason}"'):]
        assert "before_reservation=False" in call[:call.index(")  #") + 2]


def test_a_sell_blocked_before_reservation_after_a_pause_is_blocked_not_deferred():
    repo, _ = _repo()
    gw = Gateway(repo, answer=dict(_PRE))
    states = [OPEN, OPEN]

    def state():  # a pause lands while the order is in flight
        return states.pop(0) if states else {**OPEN, "last_pause_at": datetime.now(UTC).isoformat()}

    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    li.run_live_intake(
        paper_orders=orders, live_config=_config(), trading_day_confirmed=True, submission_state=state,
        market=FakeBroker(holdings={"2330": 600}), repository=repo, relay=gw.relay, status=lambda key: {},
        fees=FEES, risk_config=RISK, paper_portfolio_value=lambda o: 2_000_000.0, now=_tw(DAY, "10:01"),
        clock=lambda: _tw(DAY, "10:01"))
    assert len(gw.calls) == 1 and repo.get("paper_orders:2")["status"] == "BLOCKED"


# --- verifier round 4 ---

def test_a_flatten_behind_a_filled_partial_sell_waits_instead_of_being_skipped():
    """A: an earlier same-day sell filled, so the broker shows fewer shares while that
    sell is still reserved. The new flatten must not be dropped."""
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="10:00")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"))
    assert gw.calls[0]["intent"]["requestedShares"] == 500
    broker.holdings = {"2330": 500}  # the 500 filled; the reservation still counts them today
    orders.append(_order(3, "sell", 1000, 100.0, hhmm="10:05"))  # Paper flatten
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"))
    row = repo.get("paper_orders:3")
    assert row["status"] == "DEFERRED" and row["status_reason"] == "exit_waits_for_open_sells"
    assert len(gw.calls) == 1
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))  # yesterday's sell no longer reserves
    assert repo.get("paper_orders:3")["status"] == "RELAYED" and gw.calls[1]["intent"]["requestedShares"] == 500


def test_a_released_exit_with_shares_still_held_waits_instead_of_blocking():
    """A (release): open sells hold every free share but the broker still holds some."""
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 2000, 100.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    gw2 = Gateway(repo)
    # Today's RELAYED sell of all 1000 shares reserves them; the release must hold, not block.
    repo.insert({"paper_order_ref": "paper_orders:9", "trade_date": NEXT, "symbol": "2330", "side": "sell",
                 "paper_shares": 1000, "live_shares": 1000, "idempotency_key": None,
                 "conversion_json": json.dumps({"inputs": {"paper_price": 100.0}}),
                 "conversion_sha256": "x" * 64, "status": "RECEIVED", "status_reason": None})
    repo.transition("paper_orders:9", expected="RECEIVED", status="UNKNOWN", reason="m", sent_on=NEXT)
    repo.transition("paper_orders:9", expected="UNKNOWN", status="RELAYED",
                    reason=li._reason(reason="gateway_submitted", shares=1000, limit_price=100.0))
    out = _run(repo, broker, gw2, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED" and gw2.calls == []
    assert "paper_orders:2:exit_waits_for_open_sells" in out["errors"]


def test_a_released_exit_with_nothing_held_is_blocked():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 2000, 100.0, hhmm="13:40")]
    _run(repo, broker, gw, orders, _tw(DAY, "13:45"))
    broker.holdings = {}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get("paper_orders:2")["status"] == "BLOCKED" and gw.calls == []


class _Interleaved:
    """The repository of a pass that another pass overtakes: just before this pass records
    its first order, the other pass records and sends its own (after this one's account load)."""

    def __init__(self, repo, other):
        self._repo, self._other = repo, other

    def __getattr__(self, name):
        return getattr(self._repo, name)

    def insert(self, row):
        if self._other:
            self._other.pop()()
        return self._repo.insert(row)


def test_overlapping_passes_never_spend_the_same_cash():
    """B: the other pass committed cash after this pass loaded its reservations."""
    repo, _ = _repo()
    gw = Gateway(repo)
    a, b = _order(1, "buy", 1200, 100.0, hhmm="10:00"), _order(2, "buy", 1200, 100.0, hhmm="10:00")
    other = [lambda: _run(repo, FakeBroker(cash=100_000.0), gw, [a], _tw(DAY, "10:01"), denominator=100_000.0)]
    out = _run(_Interleaved(repo, other), FakeBroker(cash=100_000.0), gw, [b], _tw(DAY, "10:01"),
               denominator=100_000.0)
    assert len(gw.calls) == 1 and gw.calls[0]["intent"]["paperOrderRef"] == "paper_orders:1"
    assert repo.get("paper_orders:2")["status"] == "RECEIVED"  # held for a later pass
    assert "paper_orders:2:cash_committed_elsewhere" in out["errors"]


def test_overlapping_passes_never_sell_the_same_shares():
    repo, _ = _repo()
    gw = Gateway(repo)
    buy = _order(1, "buy", 2000, 100.0, day="2026-12-09")
    s1, s2 = _order(2, "sell", 2000, 100.0, hhmm="10:00"), _order(3, "sell", 2000, 100.0, hhmm="10:00")
    other = [lambda: _run(repo, FakeBroker(holdings={"2330": 1000}), gw, [buy, s1], _tw(DAY, "10:01"))]
    out = _run(_Interleaved(repo, other), FakeBroker(holdings={"2330": 1000}), gw, [buy, s2], _tw(DAY, "10:01"))
    assert [p["intent"]["requestedShares"] for p in gw.calls] == [1000]
    assert repo.get("paper_orders:3")["status"] == "RECEIVED"
    assert "paper_orders:3:exit_waits_for_open_sells" in out["errors"]


def test_a_pause_then_resume_between_passes_blocks_orders_from_before_the_pause():
    """C (D-7): resumed before this pass, but the rows were sendable before the pause."""
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "buy", 1000, 100.0, hhmm="10:00"),
              _order(3, "sell", 1000, 100.0, hhmm="13:40")]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"), control=LAPSED)
    assert repo.get("paper_orders:2")["status"] == "RECEIVED"
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "13:45"), control=LAPSED)
    assert repo.get("paper_orders:3")["status"] == "DEFERRED"
    resumed = {**OPEN, "last_pause_at": datetime.now(UTC).isoformat()}
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "11:00"), control=resumed)
    assert repo.get("paper_orders:2")["status"] == "BLOCKED"
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(NEXT, "09:05"), control=resumed)
    assert repo.get("paper_orders:3")["status"] == "BLOCKED" and gw.calls == []


def test_an_earlier_days_exit_paused_since_is_blocked_at_rollover():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="10:00")]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"), control=LAPSED)
    resumed = {**OPEN, "last_pause_at": datetime.now(UTC).isoformat()}
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(NEXT, "09:05"), control=resumed)
    assert repo.get("paper_orders:2")["status"] == "BLOCKED" and gw.calls == []


def test_a_pause_before_the_row_was_recorded_does_not_block_it():
    repo, _ = _repo()
    gw = Gateway(repo)
    resumed = {**OPEN, "last_pause_at": "2026-01-01T00:00:00+00:00"}
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"), control=resumed)
    assert repo.get("paper_orders:1")["status"] == "RELAYED"


@pytest.mark.parametrize("stamp", ["not-a-time", "2026-01-01 00:00:00"])  # no offset: unreadable, not UTC
def test_an_unreadable_pause_time_fails_closed(stamp):
    repo, _ = _repo()
    gw = Gateway(repo)
    _run(repo, FakeBroker(), gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"),
         control={**OPEN, "last_pause_at": stamp})
    assert repo.get("paper_orders:1")["status"] == "BLOCKED" and gw.calls == []


def test_spendable_cash_counts_a_payable_due_today():
    """D: the bank may debit a payable due today after the observation."""
    class Due(FakeBroker):
        def account(self, business_date):
            observation, marks = super().account(business_date)
            observation["settlements"] = [{"date": business_date, "net_amount": -60_000.0}]
            return observation, marks

    repo, _ = _repo()
    gw = Gateway(repo)
    _run(repo, Due(cash=100_000.0), gw, [_order(1, "buy", 1200, 100.0)], _tw(DAY, "10:01"), denominator=100_000.0)
    sent = sum(li.buy_cash_required(p["intent"]["requestedShares"], 100.0, FEES) for p in gw.calls)
    assert 30_000.0 < sent <= 40_000.0


def test_step_five_sends_only_todays_received_rows():
    """H: a RECEIVED row of another day, recorded by an overlapping pass after step 2, is never sent."""
    repo, _ = _repo()
    gw = Gateway(repo)

    class Racing:
        def __getattr__(self, name):
            return getattr(repo, name)

        def first_trade_date(self):
            repo.insert({"paper_order_ref": "paper_orders:7", "trade_date": NEXT, "symbol": "2330", "side": "buy",
                         "paper_shares": 10, "live_shares": 10, "idempotency_key": None,
                         "conversion_json": json.dumps({"inputs": {"paper_price": 100.0}}),
                         "conversion_sha256": "x" * 64, "status": "RECEIVED", "status_reason": None})
            return repo.first_trade_date()

    _run(Racing(), FakeBroker(), gw, [], _tw(DAY, "10:01"))
    assert gw.calls == [] and repo.get("paper_orders:7")["status"] == "RECEIVED"


def test_a_pause_and_resume_after_the_pass_began_blocks_at_send():
    """D-7 at send: the fresh read just before marking sees a pause written since the row was recorded."""
    repo, _ = _repo()
    gw = Gateway(repo)
    reads = []

    def state():
        reads.append(1)
        return OPEN if len(reads) == 1 else {**OPEN, "last_pause_at": datetime.now(UTC).isoformat()}

    li.run_live_intake(
        paper_orders=[_order(1, "buy", 1000, 100.0)], live_config=_config(), trading_day_confirmed=True,
        submission_state=state, market=FakeBroker(), repository=repo, relay=gw.relay, status=lambda key: {},
        fees=FEES, risk_config=RISK, paper_portfolio_value=lambda o: 2_000_000.0, now=_tw(DAY, "10:01"),
        clock=lambda: _tw(DAY, "10:01"))
    assert gw.calls == [] and repo.get("paper_orders:1")["status"] == "BLOCKED"


def test_a_buy_is_not_sent_when_the_fees_are_gone_at_send():
    """Missing fees fail closed (Wei): the cash a recorded buy needs cannot be checked."""
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"), control=LAPSED)
    assert repo.get("paper_orders:1")["status"] == "RECEIVED"
    li.run_live_intake(
        paper_orders=orders, live_config=_config(), trading_day_confirmed=True, submission_state=lambda: OPEN,
        market=FakeBroker(), repository=repo, relay=gw.relay, status=lambda key: {}, fees=None,
        risk_config=RISK, paper_portfolio_value=lambda o: 2_000_000.0, now=_tw(DAY, "10:05"),
        clock=lambda: _tw(DAY, "10:05"))
    assert gw.calls == [] and repo.get("paper_orders:1")["status"] == "RECEIVED"


def test_an_unreadable_row_after_a_pre_reservation_block_is_blocked_not_deferred():
    repo, _ = _repo()
    gw = Gateway(repo, answer=dict(_PRE))

    class Unreadable:
        def __getattr__(self, name):
            return getattr(repo, name)

        def get(self, ref):
            if gw.calls:  # the row can no longer be read once the relay has answered
                raise TimeoutError("d1")
            return repo.get(ref)

    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(Unreadable(), FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    assert len(gw.calls) == 1 and repo.get("paper_orders:2")["status"] == "BLOCKED"



# --- verifier round 5 ---

def test_two_deferred_flattens_of_one_symbol_never_hold_each_other_forever():
    """M1: the older exit goes first; the younger one never deadlocks against it."""
    repo, _ = _repo()
    broker = FakeBroker(holdings={"2330": 600})
    gw = Gateway(repo, answer=dict(_PRE))  # the first flatten is blocked before reservation
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 2000, 100.0, hhmm="10:00")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    gw.answer = "unknown"  # Paper buys back; the Live buy is never confirmed
    orders += [_order(3, "buy", 2000, 100.0, hhmm="11:00"), _order(4, "sell", 2000, 100.0, hhmm="12:00")]
    _run(repo, broker, gw, orders, _tw(DAY, "12:01"))
    assert repo.get("paper_orders:4")["status"] == "DEFERRED"
    gw.answer = "submitted"
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    sells = [p["intent"]["requestedShares"] for p in gw.calls if p["intent"]["side"] == "sell"]
    assert sells[-1] == 600 and repo.get("paper_orders:2")["status"] == "RELAYED"
    assert repo.get("paper_orders:4")["status"] == "DEFERRED"  # waits behind the open sell
    broker.holdings = {}
    _run(repo, broker, gw, orders, _tw("2026-12-14", "09:05"))
    assert repo.get("paper_orders:4")["status"] == "BLOCKED"


def test_reservations_are_first_in_first_out_for_the_row_being_sent():
    rows = [
        {"paper_order_ref": "paper_orders:1", "status": "DEFERRED", "side": "sell", "symbol": "2330",
         "trade_date": DAY, "created_at": "2026-12-10T05:00:00+00:00", "live_shares": 100, "status_reason": None,
         "conversion_json": json.dumps({"inputs": {"paper_price": 100.0}}), "sent_on": None},
        {"paper_order_ref": "paper_orders:2", "status": "DEFERRED", "side": "sell", "symbol": "2330",
         "trade_date": DAY, "created_at": "2026-12-10T06:00:00+00:00", "live_shares": 200, "status_reason": None,
         "conversion_json": json.dumps({"inputs": {"paper_price": 100.0}}), "sent_on": None},
        {"paper_order_ref": "paper_orders:3", "status": "UNKNOWN", "side": "sell", "symbol": "2330",
         "trade_date": DAY, "created_at": "2026-12-10T07:00:00+00:00", "live_shares": 400, "status_reason": None,
         "conversion_json": json.dumps({"inputs": {"paper_price": 100.0}}), "sent_on": NEXT},
    ]
    assert li.reservations(rows, NEXT, FEES)[1] == {"2330": 700}
    assert li.reservations(rows, NEXT, FEES, before=rows[0])[1] == {"2330": 400}  # younger unsent rows wait
    assert li.reservations(rows, NEXT, FEES, before=rows[1])[1] == {"2330": 500}


def test_an_unreadable_control_at_rollover_never_hides_an_earlier_pause():
    """M2: a pass that cannot read the control makes no transition that refreshes updated_at."""
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="10:00")]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"), control=LAPSED)
    paused_at = datetime.now(UTC).isoformat()
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(NEXT, "09:05"), control=TimeoutError("d1"))
    assert repo.get("paper_orders:2")["status"] == "RECEIVED"  # not rolled over
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(NEXT, "09:10"),
         control={**OPEN, "last_pause_at": paused_at})
    assert repo.get("paper_orders:2")["status"] == "BLOCKED" and gw.calls == []


@pytest.mark.parametrize("state", [{"status": "live_submission_open", "reason": None, "durable_pause": False},
                                   {**OPEN, "last_pause_at": None}])
def test_an_open_state_without_a_pause_time_never_sends(state):
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 600})
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="13:40"),
              _order(3, "buy", 1000, 100.0, day=NEXT, hhmm="09:01")]
    _run(repo, broker, gw, orders[:2], _tw(DAY, "13:45"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"
    out = _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control=state)
    assert gw.calls == [] and broker.packets == []  # neither the release nor today's buy is even signed
    assert repo.get("paper_orders:2")["status"] == "DEFERRED" and repo.get("paper_orders:3")["status"] == "RECEIVED"
    assert out["status"] == "ok"


def test_a_fresh_read_without_a_pause_time_holds_the_send():
    repo, _ = _repo()
    gw = Gateway(repo)
    reads = []

    def state():
        reads.append(1)
        return OPEN if len(reads) == 1 else {k: v for k, v in OPEN.items() if k != "last_pause_at"}

    out = li.run_live_intake(
        paper_orders=[_order(1, "buy", 1000, 100.0)], live_config=_config(), trading_day_confirmed=True,
        submission_state=state, market=FakeBroker(), repository=repo, relay=gw.relay, status=lambda key: {},
        fees=FEES, risk_config=RISK, paper_portfolio_value=lambda o: 2_000_000.0, now=_tw(DAY, "10:01"),
        clock=lambda: _tw(DAY, "10:01"))
    assert gw.calls == [] and repo.get("paper_orders:1")["status"] == "RECEIVED"
    assert out["errors"] == ["paper_orders:1:held:live_submission_control_incomplete"]


def test_a_pre_reservation_block_with_the_control_unreadable_stays_unknown():
    """M2: cannot tell whether a pause came first, so the exit is not carried over."""
    repo, _ = _repo()
    gw = Gateway(repo, answer=dict(_PRE))
    reads = []

    def state():
        reads.append(1)
        if len(reads) > 2:
            raise TimeoutError("d1")
        return OPEN

    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    li.run_live_intake(
        paper_orders=orders, live_config=_config(), trading_day_confirmed=True, submission_state=state,
        market=FakeBroker(holdings={"2330": 600}), repository=repo, relay=gw.relay, status=lambda key: {},
        fees=FEES, risk_config=RISK, paper_portfolio_value=lambda o: 2_000_000.0, now=_tw(DAY, "10:01"),
        clock=lambda: _tw(DAY, "10:01"))
    assert len(gw.calls) == 1 and repo.get("paper_orders:2")["status"] == "UNKNOWN"


def test_a_row_that_vanished_after_a_pre_reservation_block_is_not_deferred():
    repo, _ = _repo()
    gw = Gateway(repo, answer=dict(_PRE))

    class Vanishing:
        def __getattr__(self, name):
            return getattr(repo, name)

        def get(self, ref):
            return None if gw.calls else repo.get(ref)

    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(Vanishing(), FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:2")["status"] == "BLOCKED"


def test_a_pause_at_the_same_instant_as_the_row_blocks_it():
    row = {"updated_at": "2026-12-10T02:00:00+00:00"}
    assert li.paused_before_send(row, {**OPEN, "last_pause_at": "2026-12-10T10:00:00+08:00"}) is True
    assert li.paused_before_send(row, {**OPEN, "last_pause_at": "2026-12-10T01:59:59+00:00"}) is False
    assert li.paused_before_send({"updated_at": "garbage"}, OPEN) is True
    assert li.paused_before_send({"updated_at": None}, OPEN) is True


@pytest.mark.parametrize("answer", [{**_PRE, "status": "Blocked"}, {**_PRE, "status": " blocked"},
                                    {**_PRE, "reason": "execution_idempotency_conflict:live-intake:paper_orders:2"},
                                    {**_PRE, "reason": "x", "blocked_reasons": ["execution_idempotency_conflict"]}])
def test_near_miss_blocks_stay_unknown(answer):
    repo, _ = _repo()
    gw = Gateway(repo, answer=answer)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0)]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:2")["status"] == "UNKNOWN"


def test_a_receivable_due_today_is_not_spent_and_nav_keeps_the_r18_rule():
    class Due(FakeBroker):
        def account(self, business_date):
            observation, marks = super().account(business_date)
            observation["settlements"] = [{"date": business_date, "net_amount": 60_000.0}]
            return observation, marks

    repo, _ = _repo()
    gw = Gateway(repo)
    _run(repo, Due(cash=100_000.0), gw, [_order(1, "buy", 1500, 100.0)], _tw(DAY, "10:01"), denominator=100_000.0)
    conversion = json.loads(repo.get("paper_orders:1")["conversion_json"])
    assert conversion["inputs"]["live_nav"] == 100_000.0  # today's settlement is already in the balance
    sent = sum(li.buy_cash_required(p["intent"]["requestedShares"], 100.0, FEES) for p in gw.calls)
    assert 90_000.0 < sent <= 100_000.0


def test_an_earlier_days_received_row_is_not_sent_when_the_rollover_write_fails():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(), gw, orders, _tw(DAY, "10:01"), control=LAPSED)

    class NoRollover:
        def __getattr__(self, name):
            return getattr(repo, name)

        def transition(self, ref, **kw):
            return False if kw.get("status") == "BLOCKED" else repo.transition(ref, **kw)

    _run(NoRollover(), FakeBroker(), gw, orders, _tw(NEXT, "09:05"))
    assert gw.calls == [] and repo.get("paper_orders:1")["status"] == "RECEIVED"


# --- verifier round 6 ---

def _sells(gw):
    return [(p["intent"]["paperOrderRef"], p["intent"]["requestedShares"]) for p in gw.calls
            if p["intent"]["side"] == "sell"]


def test_an_unsent_deferred_flatten_holds_every_share_against_an_overlapping_pass():
    """R1: X releases an older flatten (it sells all that is free); an overlapping pass Y must
    not sell any of those shares for a younger order meanwhile."""
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1200, 100.0, hhmm="10:00"),
              _order(3, "sell", 800, 100.0, hhmm="13:40")]
    _run(repo, FakeBroker(holdings={"2330": 1000}), gw, orders, _tw(DAY, "10:01"))
    _run(repo, FakeBroker(holdings={"2330": 1000}), gw, orders, _tw(DAY, "13:45"))
    assert (repo.get("paper_orders:3")["status"], repo.get("paper_orders:3")["live_shares"]) == ("DEFERRED", 400)
    orders += [_order(4, "buy", 1000, 100.0, day=NEXT, hhmm="09:01"), _order(5, "sell", 500, 100.0, day=NEXT, hhmm="09:02")]

    class NoQuote(FakeBroker):
        def deferred_sell_price(self, symbol):
            return None

    fired = []

    class X(FakeBroker):
        def signed_packet(self, intent, key, trade_date):
            if not fired and intent["paperOrderRef"] == "paper_orders:3":
                fired.append(_run(repo, NoQuote(holdings={"2330": 1000}), gw, orders, _tw(NEXT, "09:05")))
            return super().signed_packet(intent, key, trade_date)

    _run(repo, X(holdings={"2330": 1000}), gw, orders[:3], _tw(NEXT, "09:05"))
    sent = [n for ref, n in _sells(gw) if ref in {"paper_orders:3", "paper_orders:5"}]
    assert fired and sum(sent) <= 1000 and sent == [1000]


def test_fifo_orders_by_record_time_not_by_ref_text():
    """Record time decides, both ways: as text "paper_orders:10" < "paper_orders:9"."""
    base = {"status": "DEFERRED", "side": "sell", "symbol": "2330", "trade_date": DAY, "status_reason": None,
            "conversion_json": json.dumps({"inputs": {"paper_price": 100.0}}), "sent_on": None}
    for older_ref, younger_ref in (("paper_orders:10", "paper_orders:9"), ("paper_orders:9", "paper_orders:10")):
        older = {**base, "paper_order_ref": older_ref, "created_at": "2026-12-10T05:00:00+00:00", "live_shares": 100}
        younger = {**base, "paper_order_ref": younger_ref, "created_at": "2026-12-10T06:00:00+00:00", "live_shares": 200}
        assert li.reservations([older, younger], NEXT, FEES, before=older)[1] == {}
        assert li.reservations([older, younger], NEXT, FEES, before=younger)[1] == {"2330": 100}


def test_a_missed_days_exit_behind_open_sells_is_deferred_not_skipped():
    """V34: the A path also covers an exit from a day the intake missed."""
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 2000, 100.0, hhmm="13:40")]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw(DAY, "13:45"))
    assert repo.get("paper_orders:2")["status"] == "DEFERRED"  # an unsent flatten holds every share
    orders += [_order(3, "buy", 1000, 100.0, day=NEXT, hhmm="09:01"), _order(4, "sell", 1000, 100.0, day=NEXT, hhmm="10:00")]
    _run(repo, FakeBroker(holdings={"2330": 600}), gw, orders, _tw("2026-12-14", "09:05"), control=LAPSED)
    assert repo.get("paper_orders:3")["status"] == "SKIPPED"
    row = repo.get("paper_orders:4")
    assert (row["status"], row["status_reason"]) == ("DEFERRED", "exit_waits_for_open_sells")


def test_days_in_paper_mode_after_live_began_count_as_missed_days():
    """Wei 10/29 (E): back to mode=live, the paper-mode days are missed intake days."""
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0)]
    _run(repo, FakeBroker(holdings={"2330": 500}), gw, orders, _tw(DAY, "10:01"))
    assert repo.get("paper_orders:1")["status"] == "RELAYED"  # Live began on DAY
    orders += [_order(2, "buy", 1000, 100.0, day=NEXT, hhmm="10:00"), _order(3, "sell", 500, 100.0, day=NEXT, hhmm="11:00")]
    idle = _run(repo, FakeBroker(holdings={"2330": 500}), gw, orders, _tw(NEXT, "11:01"), config=_config("paper"))
    assert idle["status"] == "idle" and repo.get("paper_orders:2") is None
    _run(repo, FakeBroker(holdings={"2330": 500}), gw, orders, _tw("2026-12-14", "08:30"))
    assert repo.get("paper_orders:2")["status"] == "SKIPPED"
    assert (repo.get("paper_orders:3")["status"], repo.get("paper_orders:3")["status_reason"]) == (
        "DEFERRED", "paper_exit_missed_by_intake")
    _run(repo, FakeBroker(holdings={"2330": 500}), gw, orders, _tw("2026-12-14", "09:05"))
    assert repo.get("paper_orders:3")["status"] == "RELAYED" and len(gw.calls) == 2


# --- Wei 10/29 (m2): next-day liquidation top-up ---

TOPUP = "paper_orders:3:topup:" + NEXT


def _flatten_behind_a_partial_sell(repo, gw, broker, last_sell=1000, flatten_answer="submitted"):
    """DAY: Live 1000. Paper sells 1000/2000 (Live 500 sent, 300 fill), then sells `last_sell`."""
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="10:00"),
              _order(3, "sell", last_sell, 100.0, hhmm="11:00")]
    _run(repo, broker, gw, orders[:2], _tw(DAY, "10:01"))
    broker.holdings = {"2330": 700}
    gw.answer = flatten_answer
    _run(repo, broker, gw, orders, _tw(DAY, "11:01"))
    gw.answer = "submitted"
    return orders


def test_a_paper_flat_symbol_with_a_live_residual_is_sold_next_morning():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    assert _sells(gw) == [("paper_orders:2", 500), ("paper_orders:3", 200)]
    _run(repo, broker, gw, orders, _tw(DAY, "12:00"))  # same day: the earlier sell may still fill
    assert repo.get(TOPUP) is None
    broker.holdings = {"2330": 500}  # 200 of the first sell expired unfilled
    _run(repo, broker, gw, orders, _tw(NEXT, "08:55"))  # before the release time
    assert repo.get(TOPUP) is None
    out = _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    row = repo.get(TOPUP)
    assert row["live_shares"] == 500 and row["paper_shares"] == 1000  # from the Live position, not Paper
    conversion = json.loads(row["conversion_json"])
    assert (conversion["kind"], conversion["paper_flattened"], conversion["source_ref"]) == (
        "paper_flat_live_residual", True, "paper_orders:3")
    assert row["status"] == "RELAYED" and _sells(gw)[-1] == (TOPUP, 500) and TOPUP in out["recorded"]
    assert gw.calls[-1]["idempotency_key"] == li.IDEMPOTENCY_PREFIX + TOPUP
    _run(repo, broker, gw, orders, _tw(NEXT, "10:00"))  # sent today: never a second top-up
    assert len(_sells(gw)) == 3


def test_no_top_up_while_paper_still_holds_the_symbol():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker, last_sell=500)
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_no_top_up_when_the_earlier_sell_filled_later():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {}  # the rest of the first sell filled before the close
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_no_top_up_while_the_flatten_is_unsettled():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker, flatten_answer="unknown")
    assert repo.get("paper_orders:3")["status"] == "UNKNOWN"
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_no_top_up_after_a_pause_since_the_flatten():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control={**OPEN, "last_pause_at": _tw(DAY, "12:00").isoformat()})
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_no_top_up_when_paper_traded_the_symbol_after_the_flatten():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {"2330": 500}
    orders += [_order(4, "buy", 100, 100.0, day=NEXT, hhmm="08:50"), _order(5, "sell", 100, 100.0, day=NEXT, hhmm="08:51")]
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    assert repo.get(TOPUP) is None


def test_a_top_up_that_leaves_a_residual_is_topped_up_again_next_day():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    broker.holdings = {"2330": 100}  # the top-up filled only 400
    _run(repo, broker, gw, orders, _tw("2026-12-14", "09:05"))
    again = repo.get("paper_orders:3:topup:2026-12-14")
    assert again["live_shares"] == 100 and _sells(gw)[-1] == ("paper_orders:3:topup:2026-12-14", 100)


def test_no_top_up_while_an_earlier_sell_of_the_symbol_is_unsettled():
    repo, _ = _repo()
    gw, broker = Gateway(repo, answer="unknown"), FakeBroker(holdings={"2330": 1000})
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="10:00"),
              _order(3, "sell", 1000, 100.0, hhmm="11:00")]
    _run(repo, broker, gw, orders[:2], _tw(DAY, "10:01"))
    gw.answer = "submitted"
    _run(repo, broker, gw, orders, _tw(DAY, "11:01"))
    assert repo.get("paper_orders:2")["status"] == "UNKNOWN" and repo.get("paper_orders:3")["status"] == "RELAYED"
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), status=lambda key: {"status": "ok", "legs": []})
    assert repo.get("paper_orders:2")["status"] == "UNKNOWN"
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_no_top_up_while_an_older_exit_sent_today_may_still_fill():
    repo, _ = _repo()
    gw = Gateway(repo)

    class NoPacketFor2(FakeBroker):
        def signed_packet(self, intent, key, trade_date):
            if intent["paperOrderRef"] == "paper_orders:2" and trade_date == DAY:
                raise TimeoutError("signer")
            return super().signed_packet(intent, key, trade_date)

    broker = NoPacketFor2(holdings={"2330": 1000})
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0, hhmm="10:00"),
              _order(3, "sell", 1000, 100.0, hhmm="11:00")]
    _run(repo, broker, gw, orders, _tw(DAY, "11:01"))
    assert repo.get("paper_orders:2")["status"] == "RECEIVED" and _sells(gw) == [("paper_orders:3", 500)]
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))  # the older exit rolls over and is released
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and _sells(gw)[-1] == ("paper_orders:2", 500)
    _run(repo, broker, gw, orders, _tw(NEXT, "10:00"))  # it has not filled yet: no top-up on top of it
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_a_pause_after_the_flatten_was_sent_is_not_hidden_by_its_reconcile():
    """Round 7 T1: marked UNKNOWN 11:01, paused 11:30, reconciled RELAYED 12:00 (updated_at moves)."""
    clock = {"now": datetime(2026, 12, 10, 2, 1, tzinfo=UTC)}
    repo, _ = _repo(now=lambda: clock["now"])
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker, flatten_answer="unknown")
    pause_at = datetime(2026, 12, 10, 3, 30, tzinfo=UTC).isoformat()
    clock["now"] = datetime(2026, 12, 10, 4, 0, tzinfo=UTC)
    _run(repo, broker, gw, orders, _tw(DAY, "12:00"), control={**PAUSED, "last_pause_at": pause_at},
         status=lambda key: {"status": "ok", "legs": [{"status": "ACKNOWLEDGED"}]})
    assert repo.get("paper_orders:3")["status"] == "RELAYED"
    assert repo.get("paper_orders:3")["updated_at"] > pause_at
    broker.holdings = {"2330": 500}
    clock["now"] = datetime(2026, 12, 11, 1, 5, tzinfo=UTC)
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control={**OPEN, "last_pause_at": pause_at})
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_a_pause_before_the_send_day_does_not_stop_the_top_up():
    clock = {"now": _tw(DAY, "11:01")}
    repo, _ = _repo(now=lambda: clock["now"])
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {"2330": 500}
    clock["now"] = _tw(NEXT, "09:05")
    day_before = _tw("2026-12-09", "23:59").isoformat()
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control={**OPEN, "last_pause_at": day_before})
    assert repo.get(TOPUP)["status"] == "RELAYED"


def test_no_top_up_is_recorded_while_live_submission_is_not_open():
    for control in (LAPSED, PAUSED):
        repo, _ = _repo()
        gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
        orders = _flatten_behind_a_partial_sell(repo, gw, broker)
        broker.holdings = {"2330": 500}
        _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control=control)
        assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


def test_a_blocked_top_up_ends_the_top_ups_for_that_flatten():
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {"2330": 500}
    gw.answer = "unknown"
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"))
    gw.answer = "submitted"
    _run(repo, broker, gw, orders, _tw("2026-12-14", "09:05"))  # expired, no broker order: BLOCKED
    assert repo.get(TOPUP)["status"] == "BLOCKED"
    assert repo.get("paper_orders:3:topup:2026-12-14") is None and len(_sells(gw)) == 3


@pytest.mark.parametrize("pause_at", [_tw(DAY, "00:00").isoformat(), _tw(DAY, "07:00").isoformat(), "not-a-time"])
def test_a_pause_early_on_the_send_day_or_an_unreadable_pause_time_withholds_the_top_up(pause_at):
    """Round 8 H1/H2/H4: the send day starts at 00:00 Taipei; an unparseable pause time counts as a pause."""
    repo, _ = _repo()
    gw, broker = Gateway(repo), FakeBroker(holdings={"2330": 1000})
    orders = _flatten_behind_a_partial_sell(repo, gw, broker)
    broker.holdings = {"2330": 500}
    _run(repo, broker, gw, orders, _tw(NEXT, "09:05"), control={**OPEN, "last_pause_at": pause_at})
    assert repo.get(TOPUP) is None and len(_sells(gw)) == 2


# --- the Paper sizing row is not ready yet (Wei 10/30 A: wait until that day's continuous_close) ---

class Sizing:
    """Fake D1PaperReader.portfolio_value: buys raise PaperDenominatorNotReady until marked ready."""

    def __init__(self, value=160_000.0):
        self.value, self.ready = value, set()

    def __call__(self, order):
        if order["side"] != "buy":
            return None
        if order["id"] not in self.ready:
            raise li.PaperDenominatorNotReady("missing")
        return self.value


def test_a_buy_waits_for_its_sizing_row_and_is_sent_once_the_row_appears():
    repo, _ = _repo()
    broker, gw, sizing, warned = FakeBroker(cash=80_000.0), Gateway(repo), Sizing(), []
    orders = [_order(1, "buy", 1000, 100.0)]
    out = _run(repo, broker, gw, orders, _tw(DAY, "10:01"), denominator=sizing,
               warn=lambda *a: warned.append(a))
    assert out["waiting"] == ["paper_orders:1"] and out["recorded"] == [] and out["warnings"] == []
    assert repo.get("paper_orders:1") is None and gw.calls == [] and warned == []
    sizing.ready.add(1)
    out = _run(repo, broker, gw, orders, _tw(DAY, "10:02"), denominator=sizing,
               warn=lambda *a: warned.append(a))
    assert out["waiting"] == [] and out["recorded"] == ["paper_orders:1"] and len(gw.calls) == 1
    assert repo.get("paper_orders:1")["live_shares"] == 500 and warned == []


@pytest.mark.parametrize("after_close,waiting", [(0, True), (1, False), (3600, False)])
def test_the_wait_ends_at_that_days_continuous_close(after_close, waiting):
    repo, _ = _repo()
    broker, gw, warned = FakeBroker(), Gateway(repo), []
    clock = _tw(DAY, "13:30") + timedelta(seconds=after_close)
    out = _run(repo, broker, gw, [_order(1, "buy", 1000, 100.0)], clock, denominator=Sizing(),
               warn=lambda event, detail: warned.append((event, dict(detail))))
    if waiting:  # 13:30:00 is still inside the session (inclusive close)
        assert out["waiting"] == ["paper_orders:1"] and repo.get("paper_orders:1") is None and warned == []
        return
    row = repo.get("paper_orders:1")
    assert row["status"] == "BLOCKED" and row["status_reason"] == "paper_denominator_unavailable"
    assert json.loads(row["conversion_json"])["paper_denominator_not_ready"] == "missing"
    detail = {"paper_order_ref": "paper_orders:1", "cause": "missing", "deadline": "2026-12-10T13:30:00+08:00"}
    assert warned == [("live_intake_paper_denominator_unavailable", detail)]
    assert out["warnings"] == [{"event": "live_intake_paper_denominator_unavailable", **detail}]
    assert gw.calls == [] and out["waiting"] == []


def test_a_blocked_denominator_is_warned_once():
    repo, _ = _repo()
    broker, gw, warned = FakeBroker(), Gateway(repo), []
    orders = [_order(1, "buy", 1000, 100.0)]
    for hhmm in ("13:31", "13:40"):
        _run(repo, broker, gw, orders, _tw(DAY, hhmm), denominator=Sizing(), warn=lambda *a: warned.append(a))
    assert len(warned) == 1 and repo.get("paper_orders:1")["status"] == "BLOCKED"


@pytest.mark.parametrize("hhmm,now", [("13:40", "13:41"), ("08:30", "08:31")])
def test_a_buy_placed_outside_the_session_never_waits_or_alerts(hhmm, now):
    repo, _ = _repo()
    broker, gw, warned = FakeBroker(), Gateway(repo), []
    out = _run(repo, broker, gw, [_order(1, "buy", 1000, 100.0, hhmm=hhmm)], _tw(DAY, now),
               denominator=Sizing(), warn=lambda *a: warned.append(a))
    row = repo.get("paper_orders:1")
    assert row["status"] == "SKIPPED" and row["status_reason"] == "paper_buy_outside_session"
    assert json.loads(row["conversion_json"])["paper_denominator_not_ready"] == "missing"
    assert warned == [] and out["waiting"] == [] and gw.calls == []


def test_a_missed_days_buy_without_its_row_is_blocked_not_skipped():
    repo, _ = _repo()
    broker, gw, sizing, warned = FakeBroker(), Gateway(repo), Sizing(), []
    sizing.ready.add(1)
    _run(repo, broker, gw, [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"), denominator=sizing)
    orders = [_order(1, "buy", 1000, 100.0), _order(2, "buy", 1000, 100.0, day=NEXT, hhmm="10:00")]
    day_after = "2026-12-14"  # Monday: the intake missed the 11th
    _run(repo, broker, gw, orders, _tw(day_after, "10:01"), denominator=sizing, warn=lambda *a: warned.append(a))
    row = repo.get("paper_orders:2")
    assert row["status"] == "BLOCKED" and row["status_reason"] == "paper_denominator_unavailable"
    assert len(warned) == 1


def test_sells_never_wait_for_a_sizing_row():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0),
              _order(3, "buy", 1000, 100.0, symbol="2317", hhmm="10:01")]
    out = _run(repo, broker, gw, orders, _tw(DAY, "10:02"), denominator=Sizing())
    assert out["waiting"] == ["paper_orders:3"]
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and repo.get("paper_orders:2")["live_shares"] == 500


def test_a_waiting_buy_recorded_later_only_gets_the_cash_left():
    """Accepted side effect (Wei 10/30): a later buy may use the cash first; the waiting one only buys less."""
    repo, _ = _repo()
    broker, gw, sizing = FakeBroker(cash=80_000.0), Gateway(repo), Sizing()
    sizing.ready.add(2)
    orders = [_order(1, "buy", 1000, 100.0, symbol="2330"), _order(2, "buy", 1000, 100.0, symbol="2317")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:01"), denominator=sizing)
    assert repo.get("paper_orders:1") is None and repo.get("paper_orders:2")["live_shares"] == 500
    sizing.ready.add(1)
    _run(repo, broker, gw, orders, _tw(DAY, "10:02"), denominator=sizing)
    first = repo.get("paper_orders:1")
    assert first["live_shares"] == 298 and first["status"] == "RELAYED" and len(gw.calls) == 2
    assert json.loads(first["conversion_json"])["truncations"][0]["by"] == "broker_cash"
    used = sum(li.buy_cash_required(repo.get(f"paper_orders:{i}")["live_shares"], 100.0, FEES) for i in (1, 2))
    assert used <= 80_000


def test_the_default_warning_goes_to_the_log(caplog):
    repo, _ = _repo()
    with caplog.at_level("WARNING", logger="services.live_intake"):
        _run(repo, FakeBroker(), Gateway(repo), [_order(1, "buy", 1000, 100.0)], _tw(DAY, "13:31"),
             denominator=Sizing())
    assert "live_intake_paper_denominator_unavailable" in caplog.text and "paper_orders:1" in caplog.text


def test_a_waiting_buy_overtaken_by_a_later_paper_exit_is_never_sent():
    repo, _ = _repo()
    broker, gw, sizing, warned = FakeBroker(cash=1_000_000.0), Gateway(repo), Sizing(), []
    orders = [_order(1, "buy", 1000, 100.0, hhmm="10:00"), _order(2, "sell", 1000, 100.0, hhmm="10:05"),
              _order(3, "buy", 1000, 100.0, symbol="2317", hhmm="10:05")]
    sizing.ready.add(3)
    _run(repo, broker, gw, orders, _tw(DAY, "10:06"), denominator=sizing)
    assert repo.get("paper_orders:1") is None and repo.get("paper_orders:2") is not None
    sizing.ready.add(1)
    calls = len(gw.calls)
    _run(repo, broker, gw, orders, _tw(DAY, "10:07"), denominator=sizing, warn=lambda *a: warned.append(a))
    buy = repo.get("paper_orders:1")
    assert buy["status"] == "BLOCKED" and buy["status_reason"] == "paper_buy_superseded_while_waiting"
    assert len(gw.calls) == calls
    assert warned == [("live_intake_paper_buy_superseded", {"paper_order_ref": "paper_orders:1", "cause": None})]
    assert repo.get("paper_orders:3")["status"] == "RELAYED"  # another symbol is not affected


def test_a_failing_alert_sink_never_stops_the_pass():
    repo, _ = _repo()
    broker, gw = FakeBroker(holdings={"2330": 1000}), Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "buy", 1000, 100.0, symbol="2317"),
              _order(3, "sell", 2000, 100.0, hhmm="13:00")]

    def sizing(order):
        if order["side"] == "buy" and order["id"] == 2:
            raise li.PaperDenominatorNotReady("read_failed:TimeoutError")
        return 2_000_000.0 if order["side"] == "buy" else None

    def broken(*a):
        raise RuntimeError("system log down")
    out = _run(repo, broker, gw, orders, _tw(DAY, "13:30") + timedelta(seconds=1), denominator=sizing, warn=broken,
               clock=lambda: _tw(DAY, "13:29"))
    assert repo.get("paper_orders:2")["status_reason"] == "paper_denominator_unavailable"
    assert out["warnings"][0]["paper_order_ref"] == "paper_orders:2"
    assert repo.get("paper_orders:3") is not None and out["status"] == "ok"


def test_the_alert_follows_a_successful_insert_only():
    repo, _ = _repo()
    broker, gw, warned = FakeBroker(), Gateway(repo), []
    orders = [_order(1, "buy", 1000, 100.0)]
    original = repo.insert

    def failing(row):
        raise TimeoutError("d1")
    repo.insert = failing
    with pytest.raises(TimeoutError):
        _run(repo, broker, gw, orders, _tw(DAY, "13:31"), denominator=Sizing(), warn=lambda *a: warned.append(a))
    assert warned == []
    repo.insert = original
    _run(repo, broker, gw, orders, _tw(DAY, "13:32"), denominator=Sizing(), warn=lambda *a: warned.append(a))
    assert len(warned) == 1


def test_the_deadline_is_the_close_whatever_second_the_order_was_placed():
    repo, _ = _repo()
    order = _order(1, "buy", 1000, 100.0)
    order["created_at"] = order["created_at"][:-2] + "37"  # 10:00:37
    out = _run(repo, FakeBroker(), Gateway(repo), [order], _tw(DAY, "13:30") + timedelta(seconds=10),
               denominator=Sizing())
    assert out["waiting"] == [] and repo.get("paper_orders:1")["status"] == "BLOCKED"


def test_other_reader_errors_are_not_treated_as_not_ready():
    repo, _ = _repo()

    def broken(order):
        raise KeyError("id")
    with pytest.raises(KeyError):
        _run(repo, FakeBroker(), Gateway(repo), [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"),
             denominator=broken)
    assert repo.get("paper_orders:1") is None


def test_a_ready_row_leaves_no_not_ready_mark():
    repo, _ = _repo()
    _run(repo, FakeBroker(), Gateway(repo), [_order(1, "buy", 1000, 100.0)], _tw(DAY, "10:01"))
    assert "paper_denominator_not_ready" not in json.loads(repo.get("paper_orders:1")["conversion_json"])


def test_an_invalid_buy_without_its_row_is_blocked_for_what_it_is_without_an_alert():
    repo, _ = _repo()
    warned = []
    order = _order(1, "buy", 1000, 0.0)  # no usable price
    _run(repo, FakeBroker(), Gateway(repo), [order], _tw(DAY, "13:31"), denominator=Sizing(),
         warn=lambda *a: warned.append(a))
    assert repo.get("paper_orders:1")["status_reason"] == "paper_order_invalid" and warned == []


@pytest.mark.parametrize("ref,later", [("paper_orders:12", True), ("paper_orders:12:topup:2026-12-10", True),
                                       ("paper_orders:11", False), ("paper_orders:11:topup:2026-12-10", False),
                                       ("manual-1", True), ("paper_orders:x", True)])
def test_which_intake_rows_follow_a_paper_order(ref, later):
    assert li._later_than(ref, 11) is later


def test_a_later_buy_of_the_symbol_does_not_supersede_a_waiting_buy():
    repo, _ = _repo()
    broker, gw, sizing = FakeBroker(cash=1_000_000.0), Gateway(repo), Sizing(value=2_000_000.0)
    orders = [_order(1, "buy", 1000, 100.0, hhmm="10:00"), _order(2, "buy", 1000, 100.0, hhmm="10:30")]
    sizing.ready.add(2)
    _run(repo, broker, gw, orders, _tw(DAY, "10:31"), denominator=sizing)
    sizing.ready.add(1)
    _run(repo, broker, gw, orders, _tw(DAY, "10:32"), denominator=sizing)
    assert repo.get("paper_orders:1")["status"] == "RELAYED" and len(gw.calls) == 2


def test_a_later_sell_of_another_symbol_does_not_supersede_a_waiting_buy():
    repo, _ = _repo()
    broker, gw, sizing = FakeBroker(cash=1_000_000.0, holdings={"2317": 1000}), Gateway(repo), Sizing(value=2_000_000.0)
    orders = [_order(1, "buy", 1000, 100.0, hhmm="10:00"),
              _order(2, "buy", 2000, 100.0, symbol="2317", day="2026-12-09"),
              _order(3, "sell", 1000, 100.0, symbol="2317", hhmm="10:30")]
    _run(repo, broker, gw, orders, _tw(DAY, "10:31"), denominator=sizing)
    assert repo.get("paper_orders:3")["status"] == "RELAYED" and repo.get("paper_orders:1") is None
    sizing.ready.add(1)
    _run(repo, broker, gw, orders, _tw(DAY, "10:32"), denominator=sizing)
    assert repo.get("paper_orders:1")["status"] == "RELAYED"


# --- no Live NAV (a holding without a mark): only buys stop (Wei 10/30 Q2) ---

class Unmarked(FakeBroker):
    """The observation is verified, but one holding has no usable mark today."""

    def __init__(self, *a, unmarked=("2330",), **kw):
        super().__init__(*a, **kw)
        self.unmarked = set(unmarked)

    def account(self, business_date):
        observation, marks = super().account(business_date)
        return observation, {s: m for s, m in marks.items() if s not in self.unmarked}


def test_without_a_nav_exits_still_go_and_buys_wait():
    repo, _ = _repo()
    broker, gw, warned = Unmarked(holdings={"2330": 1000}), Gateway(repo), []
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0),
              _order(3, "buy", 1000, 100.0, symbol="2317", hhmm="10:01"),
              _order(4, "buy", 100, 100.0, symbol="2454", hhmm="10:01")]
    out = _run(repo, broker, gw, orders, _tw(DAY, "10:02"), warn=lambda e, d: warned.append((e, dict(d))))
    assert repo.get("paper_orders:4") is None  # both buys wait; the alert is sent once per pass
    sell = repo.get("paper_orders:2")
    assert sell["status"] == "RELAYED" and sell["live_shares"] == 500
    assert json.loads(sell["conversion_json"])["inputs"]["live_nav"] is None
    assert repo.get("paper_orders:3") is None and "paper_orders:3" in out["deferred"]
    assert out["nav_unavailable"] == "live_ledger_mark_missing:2330"
    assert warned == [("live_intake_nav_unavailable", {"reason": "live_ledger_mark_missing:2330"})]
    assert [p["intent"]["side"] for p in gw.calls] == ["sell"]
    broker.unmarked = set()  # the mark is back: the buy is recorded and sent
    out = _run(repo, broker, gw, orders, _tw(DAY, "10:03"))
    assert repo.get("paper_orders:3")["status"] == "RELAYED" and "nav_unavailable" not in out


def test_a_failed_marks_route_is_named_in_the_nav_alert():
    class RouteDown(Unmarked):
        def account(self, business_date):
            self.marks_error = "execution_gateway_http_503"
            return super().account(business_date)
    repo, _ = _repo()
    warned = []
    out = _run(repo, RouteDown(holdings={"2330": 1000}), Gateway(repo), [_order(1, "buy", 1000, 100.0, symbol="2317")],
               _tw(DAY, "10:02"), warn=lambda e, d: warned.append((e, d["reason"])))
    assert out["nav_unavailable"] == "live_marks_unavailable:execution_gateway_http_503"
    assert warned == [("live_intake_nav_unavailable", "live_marks_unavailable:execution_gateway_http_503")]


def test_a_recorded_buy_is_not_sent_while_the_nav_is_unavailable():
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 1000, 100.0, symbol="2317")]
    _run(repo, FakeBroker(holdings={"2330": 100}), gw, orders, _tw(DAY, "10:01"), trading_day=False)
    assert repo.get("paper_orders:1")["status"] == "RECEIVED" and gw.calls == []
    out = _run(repo, Unmarked(holdings={"2330": 100}), gw, orders, _tw(DAY, "10:02"))
    assert repo.get("paper_orders:1")["status"] == "RECEIVED" and gw.calls == []
    assert "paper_orders:1:live_nav_unavailable" in out["errors"]


def test_a_sell_converts_without_a_nav():
    out = _convert(_order(1, "sell", 500, 100.0), paper_position_before=1000, live_position_shares=300,
                   live_nav=None)
    assert (out["status"], out["live_shares"]) == ("RECEIVED", 150)


@pytest.mark.parametrize("price,error", [("n/a", "ValueError"), ([101.0], "TypeError")])
def test_a_non_ledger_valuation_error_still_only_stops_buys(price, error):
    class Garbage(FakeBroker):
        def account(self, business_date):
            observation, marks = super().account(business_date)
            return observation, {s: {**m, "price": price} for s, m in marks.items()}
    repo, _ = _repo()
    gw = Gateway(repo)
    orders = [_order(1, "buy", 2000, 100.0, day="2026-12-09"), _order(2, "sell", 1000, 100.0),
              _order(3, "buy", 1000, 100.0, symbol="2317", hhmm="10:01")]
    out = _run(repo, Garbage(holdings={"2330": 1000}), gw, orders, _tw(DAY, "10:02"))
    assert out["nav_unavailable"] == f"live_ledger_nav_invalid:{error}"
    assert repo.get("paper_orders:2")["status"] == "RELAYED" and repo.get("paper_orders:3") is None
