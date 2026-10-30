"""R18 / NEW-H1g: flow-adjusted Live NAV, drawdown and the immutable ledger."""

from __future__ import annotations

import ast
import re
import sqlite3
from pathlib import Path

import pytest

from services.live_ledger import LiveLedger, account_holdings, account_nav, build_daily_snapshot, pending_settlement_total

ROOT = Path(__file__).resolve().parents[2]
SCOPE = "live:sinopac:" + "f" * 64
EVIDENCE = "e" * 64


def _ledger():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript((ROOT / "worker/domain-migrations/execution/0007_live_ledger.sql").read_text())

    def query(sql, params, timeout):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def execute(sql, params, timeout):
        conn.execute(sql, params)
        conn.commit()

    return LiveLedger(query=query, execute=execute), conn


def _observation(day, cash, positions=(), settlements=()):
    return {
        "schema_version": "live-account-observation-v1", "account_scope": SCOPE, "sha256": "a" * 64,
        "observed_at": f"{day}T06:00:00+00:00", "bank_balance": cash,
        "positions": [{"symbol": s, "shares": n, "direction": "Buy"} for s, n in positions],
        "settlements": [{"date": d, "net_amount": a} for d, a in settlements],
    }


def _mark(day, price):
    return {"price": price, "date": day, "source": "twse_close"}


def test_deposit_is_not_a_gain_and_drawdown_tracks_the_return_index():
    first = build_daily_snapshot(observation=_observation("2026-12-10", 100_000), business_date="2026-12-10",
                                 marks={}, net_external_flow=100_000, previous=None)
    assert (first["nav"], first["return_index"], first["drawdown"]) == (100_000, 1.0, 0.0)
    # Day 2: Wei deposits 50,000 and the account is otherwise flat.
    second = build_daily_snapshot(observation=_observation("2026-12-11", 150_000), business_date="2026-12-11",
                                  marks={}, net_external_flow=50_000, previous=first)
    assert second["return_index"] == pytest.approx(1.0) and second["drawdown"] == 0.0
    # Day 3: a 10% loss on 150,000 then a 20,000 withdrawal.
    third = build_daily_snapshot(observation=_observation("2026-12-14", 115_000), business_date="2026-12-14",
                                 marks={}, net_external_flow=-20_000, previous=second)
    assert third["return_index"] == pytest.approx(0.9)
    assert third["drawdown"] == pytest.approx(-0.1)
    assert third["peak_return_index"] == pytest.approx(1.0)


def test_nav_uses_dated_marks_and_pending_settlements_only():
    obs = _observation("2026-12-10", 50_000, positions=[("2330", 37), ("6488", 0)],
                       settlements=[("2026-12-09", -999), ("2026-12-10", -5), ("2026-12-12", -40_000)])
    assert pending_settlement_total(obs, "2026-12-10") == -40_000
    snap = build_daily_snapshot(observation=obs, business_date="2026-12-10",
                                marks={"2330": _mark("2026-12-10", 1000)}, net_external_flow=0, previous=None)
    assert snap["positions_value"] == 37_000
    assert snap["nav"] == 50_000 - 40_000 + 37_000
    assert snap["marks"] == {"2330": {"price": 1000.0, "date": "2026-12-10", "source": "twse_close"}}


def test_a_snapshot_values_an_untraded_holding_at_todays_contract_reference_price():
    """Wei 10/30: the daily snapshot takes the same marks as the intake (Q1), labelled by source."""
    from services.live_market import MARK_SOURCE, REFERENCE_MARK_SOURCE
    obs = _observation("2026-12-10", 50_000, positions=[("2330", 10), ("6488", 20)])
    marks = {"2330": {"price": 1000.0, "date": "2026-12-10", "source": MARK_SOURCE},
             "6488": {"price": 50.0, "date": "2026-12-10", "source": REFERENCE_MARK_SOURCE}}
    snap = build_daily_snapshot(observation=obs, business_date="2026-12-10", marks=marks,
                                net_external_flow=0, previous=None)
    assert snap["nav"] == 50_000 + 10_000 + 1_000 and snap["marks"] == marks
    stale = {**marks, "6488": {**marks["6488"], "date": "2026-12-09"}}  # a table from another day: no mark
    with pytest.raises(ValueError, match="live_ledger_mark_missing:6488"):
        build_daily_snapshot(observation=obs, business_date="2026-12-10", marks=stale, net_external_flow=0,
                             previous=None)


@pytest.mark.parametrize("marks", [{}, {"2330": _mark("2026-12-09", 1000)}, {"2330": {"price": 0, "date": "2026-12-10", "source": "x"}},
                                   {"2330": {"price": 1000, "date": "2026-12-10", "source": ""}}])
def test_missing_stale_or_unsourced_marks_fail_closed(marks):
    obs = _observation("2026-12-10", 50_000, positions=[("2330", 37)])
    with pytest.raises(ValueError):
        build_daily_snapshot(observation=obs, business_date="2026-12-10", marks=marks, net_external_flow=0, previous=None)


def test_observation_scope_schema_date_and_hash_are_required():
    base = _observation("2026-12-10", 1)
    for change in ({"account_scope": "paper:1"}, {"schema_version": "x"}, {"sha256": ""},
                   {"observed_at": "2026-12-09T06:00:00+00:00"}, {"observed_at": "2026-12-10T06:00:00"}):
        with pytest.raises(ValueError):
            build_daily_snapshot(observation={**base, **change}, business_date="2026-12-10",
                                 marks={}, net_external_flow=0, previous=None)
    short = {**base, "positions": [{"symbol": "2330", "shares": 1, "direction": "Sell"}]}
    with pytest.raises(ValueError, match="direction"):
        build_daily_snapshot(observation=short, business_date="2026-12-10",
                             marks={"2330": _mark("2026-12-10", 1)}, net_external_flow=0, previous=None)


def test_previous_snapshot_must_be_earlier_same_scope_and_positive():
    first = build_daily_snapshot(observation=_observation("2026-12-10", 100), business_date="2026-12-10",
                                 marks={}, net_external_flow=100, previous=None)
    for previous in ({**first, "business_date": "2026-12-11"}, {**first, "account_scope": "live:sinopac:other"},
                     {**first, "nav": 0}):
        with pytest.raises(ValueError):
            build_daily_snapshot(observation=_observation("2026-12-11", 100), business_date="2026-12-11",
                                 marks={}, net_external_flow=0, previous=previous)
    with pytest.raises(ValueError, match="return_not_positive"):
        build_daily_snapshot(observation=_observation("2026-12-11", 10), business_date="2026-12-11",
                             marks={}, net_external_flow=50, previous=first)


def test_cash_flows_are_idempotent_signed_and_immutable():
    ledger, conn = _ledger()
    flow = dict(flow_id="dep-1", account_scope=SCOPE, flow_date="2026-12-10", kind="deposit",
                amount=100_000, source="wei_manual", evidence_sha256=EVIDENCE)
    first = ledger.record_cash_flow(**flow)
    assert ledger.record_cash_flow(**flow) == first
    with pytest.raises(ValueError, match="conflict"):
        ledger.record_cash_flow(**{**flow, "amount": 1})
    for bad in ({"kind": "deposit", "amount": -1}, {"kind": "withdrawal", "amount": 1}, {"amount": 0},
                {"source": "paper"}, {"evidence_sha256": "x"}, {"account_scope": "paper:1"}):
        with pytest.raises(ValueError):
            ledger.record_cash_flow(**{**flow, "flow_id": "f2", **bad})
    ledger.record_cash_flow(**{**flow, "flow_id": "wd-1", "kind": "withdrawal", "amount": -30_000})
    assert ledger.net_flow(SCOPE, "2026-12-10", after=None) == 70_000
    # Another account's flows never count.
    other = "live:sinopac:" + "0" * 64
    ledger.record_cash_flow(**{**flow, "flow_id": "other-1", "account_scope": other})
    assert ledger.net_flow(SCOPE, "2026-12-10", after=None) == 70_000
    assert ledger.net_flow(SCOPE, "2026-12-10", after="2026-12-09") == 70_000
    with pytest.raises(ValueError, match="window"):
        ledger.net_flow(SCOPE, "2026-12-10", after="2026-12-10")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("UPDATE live_cash_flows_v1 SET amount=1")


def _deposit(ledger, flow_id, day, amount):
    return ledger.record_cash_flow(flow_id=flow_id, account_scope=SCOPE, flow_date=day, kind="deposit",
                                   amount=amount, source="wei_manual", evidence_sha256=EVIDENCE)


def test_weekend_deposit_between_snapshots_is_not_a_gain():
    ledger, _ = _ledger()
    _deposit(ledger, "initial", "2026-12-11", 100_000)
    friday = build_daily_snapshot(observation=_observation("2026-12-11", 100_000), business_date="2026-12-11",
                                  marks={}, net_external_flow=100_000, previous=None)
    ledger.append_snapshot(friday)
    ledger.record_cash_flow(flow_id="sat-dep", account_scope=SCOPE, flow_date="2026-12-12", kind="deposit",
                            amount=50_000, source="wei_manual", evidence_sha256=EVIDENCE)
    previous = ledger.previous_snapshot(SCOPE, "2026-12-14")
    flow = ledger.net_flow(SCOPE, "2026-12-14", after=previous["business_date"])
    monday = build_daily_snapshot(observation=_observation("2026-12-14", 150_000), business_date="2026-12-14",
                                  marks={}, net_external_flow=flow, previous=previous)
    assert flow == 50_000 and monday["return_index"] == pytest.approx(1.0) and monday["drawdown"] == 0.0
    ledger.append_snapshot(monday)
    # A flow back-dated into a closed day would never enter any return index.
    with pytest.raises(ValueError, match="already_closed"):
        ledger.record_cash_flow(flow_id="late", account_scope=SCOPE, flow_date="2026-12-12", kind="deposit",
                                amount=1, source="wei_manual", evidence_sha256=EVIDENCE)


def test_peak_follows_a_new_high_and_drawdown_measures_from_it():
    first = build_daily_snapshot(observation=_observation("2026-12-10", 100), business_date="2026-12-10",
                                 marks={}, net_external_flow=100, previous=None)
    high = build_daily_snapshot(observation=_observation("2026-12-11", 120), business_date="2026-12-11",
                                marks={}, net_external_flow=0, previous=first)
    assert high["peak_return_index"] == pytest.approx(1.2) and high["drawdown"] == 0.0
    low = build_daily_snapshot(observation=_observation("2026-12-14", 90), business_date="2026-12-14",
                               marks={}, net_external_flow=0, previous=high)
    assert low["peak_return_index"] == pytest.approx(1.2) and low["drawdown"] == pytest.approx(-0.25)


def test_snapshot_append_verifies_payload_and_refuses_a_different_rewrite():
    ledger, _ = _ledger()
    _deposit(ledger, "initial", "2026-12-10", 100)
    snap = build_daily_snapshot(observation=_observation("2026-12-10", 100), business_date="2026-12-10",
                                marks={}, net_external_flow=100, previous=None)
    assert ledger.append_snapshot(snap) == snap
    assert ledger.append_snapshot(snap) == snap
    assert ledger.previous_snapshot(SCOPE, "2026-12-11")["payload_sha256"] == snap["payload_sha256"]
    with pytest.raises(ValueError, match="integrity"):
        ledger.append_snapshot({**snap, "nav": 1})
    other = build_daily_snapshot(observation=_observation("2026-12-10", 200), business_date="2026-12-10",
                                 marks={}, net_external_flow=100, previous=None)
    with pytest.raises(RuntimeError, match="conflict"):
        ledger.append_snapshot(other)


def test_live_ledger_module_never_touches_paper_tables():
    for name in ("live_ledger.py", "live_account_snapshot.py", "execution_submission_control.py"):
        source = (ROOT / "ml-controller/services" / name).read_text()
        tree = ast.parse(source)
        strings = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        sql = " ".join(text for text in strings if re.search(r"\b(SELECT|INSERT|UPDATE|DELETE)\b", text))
        assert not re.search(r"\b(FROM|INTO|UPDATE|JOIN)\s+paper_", sql, re.I), name
        assert "D1DataDomain.PAPER" not in source


def test_flow_window_boundaries_and_the_closed_day_are_exact():
    ledger, _ = _ledger()
    _deposit(ledger, "d1", "2026-12-10", 100_000)
    first = build_daily_snapshot(observation=_observation("2026-12-10", 100_000), business_date="2026-12-10",
                                 marks={}, net_external_flow=ledger.net_flow(SCOPE, "2026-12-10", after=None),
                                 previous=None)
    ledger.append_snapshot(first)
    # A flow dated on the closed day itself is refused, not silently moved.
    with pytest.raises(ValueError, match="already_closed"):
        _deposit(ledger, "same-day", "2026-12-10", 5)
    _deposit(ledger, "d2", "2026-12-11", 7)
    # Flows on the previous snapshot's day are outside (after, business_date].
    assert ledger.net_flow(SCOPE, "2026-12-11", after="2026-12-10") == 7
    assert ledger.net_flow(SCOPE, "2026-12-11", after=None) == 100_007


@pytest.mark.parametrize("bad", ["20261212", "2026-W50-6", "2026-12-1", "2026-12-12T00:00:00", ""])
def test_only_strict_iso_days_reach_the_text_compared_columns(bad):
    ledger, conn = _ledger()
    with pytest.raises(ValueError, match="invalid"):
        _deposit(ledger, "x", bad, 1)
    with pytest.raises(ValueError, match="invalid"):
        ledger.net_flow(SCOPE, bad, after=None)
    with pytest.raises(ValueError, match="invalid"):
        ledger.net_flow(SCOPE, "2026-12-14", after=bad or "x")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("INSERT INTO live_cash_flows_v1 VALUES ('raw',?,'20261212','deposit',1,'wei_manual',?,'t')",
                     [SCOPE, EVIDENCE])


def test_a_flow_recorded_after_the_snapshot_read_its_window_blocks_the_append():
    ledger, _ = _ledger()
    _deposit(ledger, "d1", "2026-12-10", 100)
    snap = build_daily_snapshot(observation=_observation("2026-12-10", 100), business_date="2026-12-10",
                                marks={}, net_external_flow=ledger.net_flow(SCOPE, "2026-12-10", after=None),
                                previous=None)
    _deposit(ledger, "late", "2026-12-10", 50)  # lands between the read and the append
    with pytest.raises(RuntimeError, match="flow_changed"):
        ledger.append_snapshot(snap)
    assert ledger.previous_snapshot(SCOPE, "2026-12-11") is None


def test_snapshots_chain_to_their_previous_and_never_reset_or_backfill():
    ledger, _ = _ledger()
    _deposit(ledger, "d1", "2026-12-10", 100)
    first = build_daily_snapshot(observation=_observation("2026-12-10", 100), business_date="2026-12-10",
                                 marks={}, net_external_flow=100, previous=None)
    ledger.append_snapshot(first)
    loss = build_daily_snapshot(observation=_observation("2026-12-11", 80), business_date="2026-12-11",
                                marks={}, net_external_flow=0, previous=ledger.previous_snapshot(SCOPE, "2026-12-11"))
    assert loss["previous_payload_sha256"] == first["payload_sha256"]
    ledger.append_snapshot(loss)
    # A caller that forgets the previous would reset index and peak to 1 and erase the drawdown.
    reset = build_daily_snapshot(observation=_observation("2026-12-14", 80), business_date="2026-12-14",
                                 marks={}, net_external_flow=0, previous=None)
    with pytest.raises(RuntimeError, match="previous_mismatch"):
        ledger.append_snapshot(reset)
    # Backfilling an earlier day once a later one exists is refused.
    early = build_daily_snapshot(observation=_observation("2026-12-09", 100), business_date="2026-12-09",
                                 marks={}, net_external_flow=0, previous=None)
    with pytest.raises(RuntimeError, match="out_of_order"):
        ledger.append_snapshot(early)
    # Replaying a stored snapshot stays idempotent even after later days exist.
    assert ledger.append_snapshot(first) == first
    with pytest.raises(ValueError, match="unverified"):
        build_daily_snapshot(observation=_observation("2026-12-14", 80), business_date="2026-12-14", marks={},
                             net_external_flow=0, previous={**loss, "payload_sha256": None})


def test_previous_snapshot_lookup_and_flow_amounts_are_strict():
    ledger, conn = _ledger()
    with pytest.raises(ValueError, match="invalid"):
        ledger.previous_snapshot(SCOPE, "20261212")
    with pytest.raises(ValueError, match="whole_twd"):
        _deposit(ledger, "frac", "2026-12-10", 100.5)
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute("INSERT INTO live_cash_flows_v1 VALUES ('raw',?,'2026-12-10','deposit',0.5,'wei_manual',?,'t')",
                     [SCOPE, EVIDENCE])


def test_split_broker_rows_of_one_symbol_add_up():
    day = "2026-12-10"
    out = account_nav(_observation(day, 1000, positions=[("2330", 1000), ("2330", 37)]), day, {"2330": _mark(day, 10.0)})
    assert out["holdings"] == {"2330": 1037} and out["nav"] == 1000 + 10_370


def test_an_intraday_reader_also_counts_a_settlement_due_that_day():
    obs = {"settlements": [{"date": "2026-12-10", "net_amount": -60_000}, {"date": "2026-12-11", "net_amount": -5}]}
    assert pending_settlement_total(obs, "2026-12-10") == -5
    assert pending_settlement_total(obs, "2026-12-10", include_business_date=True) == -60_005


def test_account_holdings_need_no_marks_but_a_verified_observation():
    obs = _observation("2026-12-10", 500_000, positions=[("2330", 1000), ("2330", 500), ("2317", 0)],
                       settlements=[("2026-12-11", -120_000)])
    got = account_holdings(obs, "2026-12-10")
    assert got == {"cash": 500_000.0, "unsettled": -120_000.0, "holdings": {"2330": 1500}}
    with pytest.raises(ValueError, match="live_ledger_mark_missing:2330"):
        account_nav(obs, "2026-12-10", {})
    for bad in ({"sha256": ""}, {"observed_at": "2026-12-09T06:00:00+00:00"}, {"schema_version": "x"}):
        with pytest.raises(ValueError):
            account_holdings({**obs, **bad}, "2026-12-10")
    with pytest.raises(ValueError, match="direction_unsupported"):
        account_holdings({**obs, "positions": [{"symbol": "2330", "shares": 1, "direction": "Sell"}]}, "2026-12-10")
