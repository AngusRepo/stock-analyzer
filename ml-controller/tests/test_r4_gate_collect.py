"""M12 collector: read-only sources in, an r4-gate-evidence-v1 bundle out; gaps fail the gate closed."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from services.live_account_snapshot import _canonical

ROOT = Path(__file__).resolve().parents[2]


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"tools/live/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collect = _load("r4_gate_collect")
gate = collect.gate

DRAFT = json.loads((ROOT / "docs/live/r4_gate_policy_v1.json").read_text())
OFFICIAL = "2026-11-26"
POLICY = {**DRAFT, "status": "frozen", "calendar": {**DRAFT["calendar"], "official_closures": [OFFICIAL]}}
TYPHOON = "2026-11-20"
START = "2026-11-09"
NOW = datetime(2026, 12, 8, 13, 0, tzinfo=timezone.utc)  # 21:00 Taiwan time
WINDOW = gate.trading_days(START, "2026-12-08", {OFFICIAL, TYPHOON})
PREVIOUS = "2026-11-06"  # the session before START
L3 = {"artifact_id": "r33-a", "cohort_id": "c1", "payload_checksum": "p" * 8, "base_artifact_set_checksum": "b" * 8}
POLICY_ID = "e" * 64
RELEASE = {"effective_from": "2026-11-01", "grant_key": "ml:active8:paper_runtime_approval:v1:slice-a",
           "execution_owner_version": "native-v7", "source_ref": "gs://stockvision-models/release-receipts/x"}
SLICE_A = {"grant_key": RELEASE["grant_key"], "execution_owner_version": RELEASE["execution_owner_version"],
           "l3_identity": gate.sha256_of(L3), "allocator_identity": POLICY_ID}

DDL = {
    "paper": """
CREATE TABLE l4_portfolio_plans_v1 (plan_id TEXT PRIMARY KEY, account_id INTEGER, signal_date TEXT,
  policy_identity TEXT, activated INTEGER, payload_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE pending_buy_runs (id INTEGER PRIMARY KEY, trade_date TEXT, status TEXT);
CREATE TABLE pending_buy_items (id INTEGER PRIMARY KEY, run_id INTEGER, symbol TEXT, created_at TEXT);
CREATE TABLE paper_execution_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, trade_date TEXT,
  event_type TEXT, status TEXT, reason TEXT, detail_json TEXT);
CREATE TABLE paper_daily_snapshots (account_id INTEGER, date TEXT, total_value REAL, benchmark_value REAL,
  twii_value REAL);
CREATE TABLE paper_orders (id INTEGER PRIMARY KEY, account_id INTEGER, side TEXT, shares INTEGER, price REAL,
  commission REAL, tax REAL, created_at TEXT);""",
    "ops": """
CREATE TABLE pipeline_stage_runs (business_date TEXT, stage TEXT, last_error TEXT);
CREATE TABLE scheduler_execution_tickets_v1 (ticket_id TEXT PRIMARY KEY, scheduler_job_id TEXT, business_date TEXT,
  ticket_kind TEXT, status TEXT, last_error TEXT, updated_at TEXT);""",
    "execution": """
CREATE TABLE live_account_observations_v1 (account_scope TEXT, request_id TEXT, observed_at TEXT, sha256 TEXT,
  payload_json TEXT);""",
}


def _observation():
    payload = {"schema_version": "live-account-observation-v1", "account_scope": "live:sinopac:" + "f" * 64,
               "request_id": "live-intake-x", "observed_at": "2026-12-08T05:00:00+00:00", "positions": []}
    return {**payload, "sha256": hashlib.sha256(_canonical(payload).encode()).hexdigest()}


class World:
    def __init__(self):
        self.dbs = {domain: sqlite3.connect(":memory:") for domain in DDL}
        for domain, ddl in DDL.items():
            self.dbs[domain].row_factory = sqlite3.Row
            self.dbs[domain].executescript(ddl)
        self.sql: list[tuple[str, str]] = []
        self.kv = {f"holiday:{TYPHOON}": json.dumps({"source": "twse_adhoc", "title": "颱風停止上班"}),
                   f"holiday:{OFFICIAL}": "1",
                   "trading:config": json.dumps({"fees": {"commission": 0.001425, "tax": 0.003, "minCommission": 20}}),
                   "trading:live_config": json.dumps({"mode": "paper", "pause": {"enabled": False},
                                                      "capital_source": "broker_nav_authoritative_marks"})}
        self.kv_reads: list[str] = []
        sessions = [PREVIOUS, *WINDOW]
        nav = 1_000_000.0
        for i, day in enumerate(sessions):
            self.run("paper", "INSERT INTO paper_daily_snapshots VALUES (1,?,?,?,?)",
                     [day, nav, 100 + i * 0.1, 20000 + i])
            nav *= 1.002
            if day == PREVIOUS:
                continue
            self.plan(sessions[i - 1], f"plan-{day}")
            self.run("paper", "INSERT INTO paper_execution_events (account_id,trade_date,event_type,status,reason,"
                              "detail_json) VALUES (1,?,'snapshot_audit','verified','dated_marks_complete',?)",
                     [day, json.dumps({"mark_evidence": {"2330": {"price": 1000, "price_date": day,
                                                                   "quote_time": f"{day}T05:30:00Z"},
                                                          "6488": {"price": 50, "price_date": day,
                                                                   "quote_time": None, "observed_at": None}}})])
            self.run("ops", "INSERT INTO scheduler_execution_tickets_v1 VALUES (?, 'evening-chain', ?, "
                            "'physical_root', 'success', NULL, ?)", [f"root-{day}", day, f"{day} 14:00:00"])
        self.run("execution", "INSERT INTO live_account_observations_v1 VALUES (?,?,?,?,?)",
                 [_observation()["account_scope"], "live-intake-x", "2026-12-08T05:00:00+00:00",
                  _observation()["sha256"], json.dumps(_observation())])

    def run(self, domain, sql, params=()):
        self.dbs[domain].execute(sql, list(params))

    def plan(self, signal_date, plan_id, l3=L3, policy=POLICY_ID, activated=1):
        self.run("paper", "INSERT INTO l4_portfolio_plans_v1 (plan_id,account_id,signal_date,policy_identity,"
                          "activated,payload_json) VALUES (?,1,?,?,?,?)",
                 [plan_id, signal_date, policy, activated, json.dumps({"l3_identity": l3})])

    def query(self, domain, sql, params):
        self.sql.append((domain, sql))
        return [dict(r) for r in self.dbs[domain].execute(sql, params).fetchall()]

    def kv_get(self, key):
        self.kv_reads.append(key)
        return self.kv.get(key)


def _signal():
    def wiggle(i, base):
        return base + (0.002 if i % 2 else -0.002)
    return {"oos_days": [{"date": d, "tails": {"1.5": wiggle(i, 0.008), "2.0": wiggle(i, 0.010)}}
                         for i, d in enumerate(WINDOW)],
            "oof": {"1.5": {"point": 0.007, "ci_low": 0.005, "ci_high": 0.009},
                    "2.0": {"point": 0.009, "ci_low": 0.006, "ci_high": 0.012}}}


def _manual(**changes):
    manual = {
        "slice_a_identity": dict(SLICE_A), "release_timeline": [RELEASE],
        "ad_hoc_closures_confirmed": [{"date": TYPHOON, "wei_confirmed": True, "reason": "typhoon closure"}],
        "allocator_decisions": {k: {"decided_by": "wei", "receipt_ref": f"DECISIONS#{k}", "decided_at": WINDOW[0]}
                                for k in POLICY["allocator_decisions_required"]},
        "live_tests": {"release_sha": "a" * 40,
                       "results": {k: {"status": "pass", "release_sha": "a" * 40} for k in POLICY["live_tests_required"]},
                       "T8": {"wei_receipt_sha256": "b" * 64},
                       "T9": {"receipt_sha256": "c" * 64, "orders_submitted": 0, "gateway_submit_flag": "0"}},
        "slippage_band": {"artifact_sha256": "9" * 64},
        "net_excess_benchmark": "benchmark_value",
    }
    manual.update(changes)
    return manual


def _collect(world=None, manual=None, signal="default", now=NOW):
    world = world or World()
    collector = collect.Collector(policy=POLICY, manual=manual if manual is not None else _manual(),
                                  signal=_signal() if signal == "default" else signal,
                                  query=world.query, kv_get=world.kv_get, now=now)
    return collector.collect(START), collector, world


def _gate(evidence):
    return gate.evaluate(POLICY, evidence, NOW, gate.sha256_of(POLICY))


def _statuses(receipt):
    return {name: g["status"] for name, g in receipt["gates"].items()}


def test_a_full_collection_meets_every_gate_except_the_undefined_t3_counter():
    evidence, collector, world = _collect()
    assert collector.gaps == ["health_undefined:ledger_cross_write"]
    assert evidence["as_of"] == WINDOW[-1] and len(evidence["paper_days"]) == 20
    assert evidence["ad_hoc_closures"] == [{"date": TYPHOON, "wei_confirmed": True, "reason": "typhoon closure"}]
    assert evidence["paper_days"][0]["identity"] == SLICE_A
    assert all(set(d["health"].values()) == {0} for d in evidence["paper_days"])
    receipt = _gate(evidence)
    assert _statuses(receipt) == {"policy": "PASS", "G1_identity": "PASS", "G2_health": "FAIL", "G3_signal": "PASS",
                                  "G4_net_excess": "PASS", "G5_allocator": "PASS", "G6_live_tests": "PASS",
                                  "G7_config": "PASS"}
    assert "missing:ledger_cross_write" in receipt["gates"]["G2_health"]["error"]
    # Once T3 is defined and counted, the bundle is gate-complete.
    patched = copy.deepcopy(evidence)
    for day in patched["paper_days"]:
        day["health"]["ledger_cross_write"] = 0
    assert _gate(patched)["overall"] == "PASS"
    # Read-only: every D1 statement is a SELECT and KV is only read.
    assert world.sql and all(sql.lstrip().upper().startswith("SELECT") for _, sql in world.sql)
    assert evidence["collector"]["manual_sha256"] == gate.sha256_of(_manual())
    json.dumps(evidence, allow_nan=False)


def test_an_unconfirmed_holiday_kv_closure_is_listed_unconfirmed_and_fails_g1():
    manual = _manual(ad_hoc_closures_confirmed=[])
    evidence, collector, _ = _collect(manual=manual)
    assert evidence["ad_hoc_closures"] == [{"date": TYPHOON, "wei_confirmed": False,
                                            "reason": json.dumps({"source": "twse_adhoc", "title": "颱風停止上班"})}]
    assert f"ad_hoc_closure_unconfirmed:{TYPHOON}" in collector.gaps
    assert _gate(evidence)["gates"]["G1_identity"]["status"] == "FAIL"


def test_a_closure_before_the_window_only_shapes_the_lookback():
    world = World()
    world.kv[f"holiday:{PREVIOUS}"] = "1"  # the session before START closed: the previous one is 11-05
    world.plan("2026-11-05", "plan-lookback")
    world.run("paper", "INSERT INTO paper_daily_snapshots VALUES (1,'2026-11-05',1000000,100,20000)")
    world.run("paper", "DELETE FROM l4_portfolio_plans_v1 WHERE signal_date=?", [PREVIOUS])
    evidence, collector, _ = _collect(world)
    assert all(row["date"] >= START for row in evidence["ad_hoc_closures"])
    assert evidence["paper_days"][0]["date"] == START and not any("unconfirmed" in g for g in collector.gaps)


def test_a_wei_confirmed_closure_missing_from_holiday_kv_is_flagged():
    world = World()
    del world.kv[f"holiday:{TYPHOON}"]
    evidence, collector, _ = _collect(world)
    assert evidence["ad_hoc_closures"][0]["wei_confirmed"] is True
    assert collector.gaps[0] == f"ad_hoc_closure_not_in_holiday_kv:{TYPHOON}"


def test_as_of_is_the_latest_session_before_now():
    sunday = datetime(2026, 12, 6, 4, 0, tzinfo=timezone.utc)
    evidence, _, _ = _collect(now=sunday)
    assert evidence["as_of"] == "2026-12-04"


@pytest.mark.parametrize("change,day", [
    ("no_plan", "2026-11-16"),
    ("two_identities", "2026-11-16"),
    ("plan_without_l3", "2026-11-16"),
    ("inactive_plan", "2026-11-16"),
])
def test_a_day_without_one_clear_paper_identity_is_left_out(change, day):
    world = World()
    signal_date = WINDOW[WINDOW.index(day) - 1]
    if change == "no_plan":
        world.run("paper", "DELETE FROM l4_portfolio_plans_v1 WHERE signal_date=?", [signal_date])
    elif change == "two_identities":
        world.plan(signal_date, "plan-extra", policy="f" * 64)
    elif change == "plan_without_l3":
        world.run("paper", "UPDATE l4_portfolio_plans_v1 SET payload_json='{}' WHERE signal_date=?", [signal_date])
    else:
        world.run("paper", "UPDATE l4_portfolio_plans_v1 SET activated=0 WHERE signal_date=?", [signal_date])
    evidence, collector, _ = _collect(world)
    assert day not in {row["date"] for row in evidence["paper_days"]}
    assert any(g.startswith(f"paper_day_identity_unavailable:{day}") for g in collector.gaps)
    assert _gate(evidence)["gates"]["G1_identity"]["trading_days"] < 20


def test_the_release_timeline_sets_grant_and_owner_per_day():
    later = {**RELEASE, "effective_from": "2026-11-23", "execution_owner_version": "native-v8"}
    evidence, _, _ = _collect(manual=_manual(release_timeline=[RELEASE, later]))
    owners = {row["date"]: row["identity"]["execution_owner_version"] for row in evidence["paper_days"]}
    assert owners["2026-11-19"] == "native-v7" and owners["2026-11-23"] == "native-v8"
    g1 = _gate(evidence)["gates"]["G1_identity"]
    assert g1["status"] == "FAIL" and g1["first_day"] == "2026-11-23"  # no D-12 bridge: the count restarts
    evidence, collector, _ = _collect(manual=_manual(release_timeline=[]))
    assert evidence["paper_days"] == [] and any("no_release" in g for g in collector.gaps)


def test_health_counters():
    world = World()
    d1, d2, d3, d4, d5 = WINDOW[1:6]
    # pending buys: 08:44:59 Taiwan is on time, 08:45:01 is late, a superseded run never counts
    world.run("paper", "INSERT INTO pending_buy_runs VALUES (1,?,'ready'),(2,?,'superseded')", [d1, d1])
    world.run("paper", "INSERT INTO pending_buy_items (run_id,symbol,created_at) VALUES "
                       "(1,'2330',?),(1,'2317',?),(2,'2454',?)",
              [f"{d1} 00:44:59", f"{d1} 00:45:01", f"{d1} 03:00:00"])
    # marks: a stale price_date, a quote stamped the next Taiwan day, an unparseable stamp
    world.run("paper", "UPDATE paper_execution_events SET detail_json=? WHERE trade_date=?",
              [json.dumps({"mark_evidence": {"2330": {"price_date": WINDOW[0]},
                                             "2317": {"price_date": d2, "quote_time": f"{d2}T16:30:00Z"},
                                             "2454": {"price_date": d2, "observed_at": "yesterday"},
                                             "3008": {"price_date": d2, "observed_at": f"{d2}T15:59:00"}}}), d2])
    world.run("paper", "INSERT INTO paper_execution_events (account_id,trade_date,event_type,status) "
                       "VALUES (1,?,'snapshot_audit','pending_valuation')", [d3])
    world.run("paper", "DELETE FROM paper_execution_events WHERE trade_date=?", [d4])
    world.run("ops", "INSERT INTO pipeline_stage_runs VALUES (?,'verify_v2','paper_execution_scope_incomplete:x')", [d5])
    world.run("ops", "INSERT INTO scheduler_execution_tickets_v1 VALUES ('t-x','paper-x',?,'logical_child','error',"
                     "'clock_regression',?)", [d5, f"{d5} 10:00:00"])
    world.run("ops", "INSERT INTO scheduler_execution_tickets_v1 VALUES ('root-late','evening-chain',?,'physical_root',"
                     "'error',NULL,?)", [d3, f"{d3} 15:00:00"])  # a later failed root supersedes the success
    world.run("ops", "DELETE FROM scheduler_execution_tickets_v1 WHERE ticket_id=?", [f"root-{d4}"])
    evidence, _, _ = _collect(world)
    health = {row["date"]: row["health"] for row in evidence["paper_days"]}
    assert health[d1]["pending_buys_after_0845"] == 1
    assert health[d2]["nav_quote_date_mismatch"] == 3
    assert health[d3]["nav_quote_date_mismatch"] == 1 and health[d3]["evening_chain_incomplete"] == 1
    assert health[d4]["nav_quote_date_mismatch"] == 1 and health[d4]["evening_chain_incomplete"] == 1
    assert health[d5]["paper_execution_scope_violation"] == 2
    assert health[WINDOW[6]] == {k: 0 for k in health[WINDOW[6]]}


def test_turnover_return_and_gross_excess():
    world = World()
    day, before = WINDOW[1], WINDOW[0]
    # Taiwan date: 15:59:59 UTC is still day, 16:00:00 UTC is the next day; the day before 16:00 is earlier
    world.run("paper", "INSERT INTO paper_orders (account_id,side,shares,price,commission,tax,created_at) VALUES "
                       "(1,'buy',1000,100,142.5,0,?),(1,'sell',500,200,142.5,300,?),(1,'buy',1,1,0,0,?),"
                       "(1,'buy',7,7,0,0,?),(2,'buy',9,9,0,0,?)",
              [f"{before} 16:00:00", f"{day} 15:59:59", f"{day} 16:00:00", f"{before} 15:59:59", f"{day} 02:00:00"])
    evidence, _, _ = _collect(world)
    row = next(r for r in evidence["net_excess_days"] if r["date"] == day)
    snaps = {r["date"]: r for r in world.query("paper", "SELECT * FROM paper_daily_snapshots", [])}
    prev_nav, nav = snaps[before]["total_value"], snaps[day]["total_value"]
    assert row["one_way_turnover"] == pytest.approx(200_000 / prev_nav)
    assert row["paper_account_return"] == pytest.approx(nav / prev_nav - 1)
    bench = snaps[day]["benchmark_value"] / snaps[before]["benchmark_value"] - 1
    assert row["gross_excess"] == pytest.approx(nav / prev_nav - 1 + 585 / prev_nav - bench)
    twii, _, _ = _collect(world, manual=_manual(net_excess_benchmark="twii_value"))
    twii_row = next(r for r in twii["net_excess_days"] if r["date"] == day)
    assert twii_row["gross_excess"] == pytest.approx(
        nav / prev_nav - 1 + 585 / prev_nav - (snaps[day]["twii_value"] / snaps[before]["twii_value"] - 1))


@pytest.mark.parametrize("benchmark", [None, "0050", "pool_mean"])
def test_without_a_decided_benchmark_there_is_no_gross_excess(benchmark):
    manual = _manual()
    manual.pop("net_excess_benchmark")
    if benchmark:
        manual["net_excess_benchmark"] = benchmark
    evidence, collector, _ = _collect(manual=manual)
    assert all("gross_excess" not in r for r in evidence["net_excess_days"])
    assert "net_excess_benchmark_undecided" in collector.gaps
    assert _gate(evidence)["gates"]["G4_net_excess"]["status"] == "FAIL"


def test_missing_navs_and_benchmarks_leave_days_out():
    world = World()
    world.run("paper", "DELETE FROM paper_daily_snapshots WHERE date=?", [WINDOW[3]])
    world.run("paper", "UPDATE paper_daily_snapshots SET benchmark_value=NULL WHERE date=?", [WINDOW[8]])
    evidence, collector, _ = _collect(world)
    rows = {r["date"]: r for r in evidence["net_excess_days"]}
    assert WINDOW[3] not in rows and WINDOW[4] not in rows  # its own NAV, then the next day's previous NAV
    assert "gross_excess" not in rows[WINDOW[8]] and "gross_excess" not in rows[WINDOW[9]]
    assert {f"paper_nav_missing:{WINDOW[3]}", f"benchmark_missing:{WINDOW[8]}"} <= set(collector.gaps)
    assert _gate(evidence)["gates"]["G4_net_excess"]["status"] == "FAIL"


@pytest.mark.parametrize("config", [None, json.dumps({}), json.dumps({"fees": {"commission": 0.001425}})])
def test_fees_come_only_from_kv_never_from_defaults(config):
    world = World()
    world.kv["trading:config"] = config
    evidence, collector, _ = _collect(world)
    assert "trading_config_fees" not in evidence and "trading_config_fees_missing" in collector.gaps
    assert _gate(evidence)["gates"]["G4_net_excess"]["status"] == "FAIL"


def test_missing_manual_fields_signal_live_config_and_observation_are_gaps():
    world = World()
    world.run("execution", "DELETE FROM live_account_observations_v1")
    world.kv.pop("trading:live_config")
    evidence, collector, _ = _collect(world, manual={"release_timeline": [RELEASE]}, signal=None)
    for gap in ("manual_missing:slice_a_identity", "manual_missing:allocator_decisions", "manual_missing:live_tests",
                "manual_missing:slippage_band", "signal_artifact_missing", "live_config_missing",
                "live_account_observation_missing", "net_excess_benchmark_undecided"):
        assert gap in collector.gaps
    assert evidence["d12_replay_receipts"] == []
    statuses = _statuses(_gate(evidence))
    assert {k for k, v in statuses.items() if v == "FAIL"} == {"G1_identity", "G2_health", "G3_signal",
                                                               "G4_net_excess", "G5_allocator", "G6_live_tests",
                                                               "G7_config"}


def test_a_tampered_account_observation_stops_the_collection():
    world = World()
    world.run("execution", "UPDATE live_account_observations_v1 SET payload_json=?",
              [json.dumps({**_observation(), "positions": [{"symbol": "2330", "shares": 1}]})])
    with pytest.raises(RuntimeError, match="integrity"):
        _collect(world)


def test_the_latest_account_observation_is_used():
    world = World()
    newer = {**_observation(), "request_id": "live-intake-y", "observed_at": "2026-12-08T06:00:00+00:00"}
    newer.pop("sha256")
    newer["sha256"] = hashlib.sha256(_canonical(newer).encode()).hexdigest()
    world.run("execution", "INSERT INTO live_account_observations_v1 VALUES (?,?,?,?,?)",
              [newer["account_scope"], "live-intake-y", newer["observed_at"], newer["sha256"], json.dumps(newer)])
    evidence, _, _ = _collect(world)
    assert evidence["account_observation"]["request_id"] == "live-intake-y"


def test_the_live_sources_are_select_only_shadow_clients():
    query, _ = collect._live_sources()
    with pytest.raises(Exception, match="(?i)read.only|select"):
        query("paper", "DELETE FROM paper_orders", [])


def test_main_writes_the_bundle(tmp_path, monkeypatch):
    world = World()
    monkeypatch.setattr(collect, "_live_sources", lambda: (world.query, world.kv_get))

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW
    monkeypatch.setattr(collect, "datetime", Clock)
    manual, signal, out = tmp_path / "m.json", tmp_path / "s.json", tmp_path / "e.json"
    manual.write_text(json.dumps(_manual()))
    signal.write_text(json.dumps(_signal()))
    policy = tmp_path / "p.json"
    policy.write_text(json.dumps(POLICY))
    assert collect.main(["--calendar-start", START, "--manual", str(manual), "--signal", str(signal),
                         "--policy", str(policy), "--out", str(out)]) == 0
    evidence = gate._strict_json(out.read_text())
    assert evidence["as_of"] == WINDOW[-1] and evidence["collector"]["gaps"] == ["health_undefined:ledger_cross_write"]
    assert evidence["collector"]["signal_sha256"] == gate.sha256_of(_signal())


def test_only_a_json_true_confirms_a_closure():
    manual = _manual(ad_hoc_closures_confirmed=[{"date": TYPHOON, "wei_confirmed": "true", "reason": "typhoon"}])
    evidence, collector, _ = _collect(manual=manual)
    assert evidence["ad_hoc_closures"][0]["wei_confirmed"] is False
    assert f"ad_hoc_closure_unconfirmed:{TYPHOON}" in collector.gaps


@pytest.mark.parametrize("signal", [{"oos_days": []}, {"oof": {}}, []])
def test_an_incomplete_signal_artifact_is_a_gap(signal):
    evidence, collector, _ = _collect(signal=signal)
    assert "signal" not in evidence and "signal_artifact_missing" in collector.gaps


@pytest.mark.parametrize("status,reason", [("error", "dated_marks_complete"), ("verified", "partial_marks")])
def test_only_a_verified_dated_valuation_counts(status, reason):
    world = World()
    day = WINDOW[2]
    world.run("paper", "UPDATE paper_execution_events SET status=?, reason=? WHERE trade_date=?", [status, reason, day])
    evidence, _, _ = _collect(world)
    assert next(r for r in evidence["paper_days"] if r["date"] == day)["health"]["nav_quote_date_mismatch"] == 1


def test_a_zero_previous_nav_or_benchmark_is_a_gap_not_a_division():
    world = World()
    world.run("paper", "UPDATE paper_daily_snapshots SET total_value=0 WHERE date=?", [WINDOW[3]])
    world.run("paper", "UPDATE paper_daily_snapshots SET benchmark_value=0 WHERE date=?", [WINDOW[8]])
    evidence, collector, _ = _collect(world)
    rows = {r["date"]: r for r in evidence["net_excess_days"]}
    assert WINDOW[4] not in rows and "gross_excess" not in rows[WINDOW[9]]
    assert {f"paper_nav_missing:{WINDOW[4]}", f"benchmark_missing:{WINDOW[9]}"} <= set(collector.gaps)


def test_wei_confirmed_d12_receipts_pass_through():
    receipts = [{"from_identity_sha256": "1" * 64, "to_identity_sha256": "2" * 64, "wei_confirmed": True,
                 "receipt_sha256": "3" * 64}]
    evidence, _, _ = _collect(manual=_manual(d12_replay_receipts=receipts))
    assert evidence["d12_replay_receipts"] == receipts


@pytest.mark.parametrize("column,value", [("total_value", 0), ("total_value", -5), ("benchmark_value", 0),
                                          ("benchmark_value", -50)])
def test_a_non_positive_nav_or_benchmark_on_the_day_itself_is_a_gap(column, value):
    world = World()
    day = WINDOW[-1]  # as_of: no later day would expose it as a previous value
    world.run("paper", f"UPDATE paper_daily_snapshots SET {column}=? WHERE date=?", [value, day])
    evidence, collector, _ = _collect(world)
    rows = {r["date"]: r for r in evidence["net_excess_days"]}
    if column == "total_value":
        assert day not in rows and f"paper_nav_missing:{day}" in collector.gaps
    else:
        assert "gross_excess" not in rows[day] and f"benchmark_missing:{day}" in collector.gaps
    assert _gate(evidence)["gates"]["G4_net_excess"]["status"] == "FAIL"


@pytest.mark.parametrize("timeline,reason", [
    ([RELEASE, {**RELEASE, "execution_owner_version": "native-v9"}], "release_ambiguous"),
    ([{**RELEASE, "grant_key": ""}], "release_incomplete"),
    ([{**RELEASE, "execution_owner_version": None}], "release_incomplete"),
    ([{**RELEASE, "grant_key": 7}], "release_incomplete"),
    ([{**RELEASE, "grant_key": "  "}], "release_incomplete"),
    ([{**RELEASE, "effective_from": "2026-11-1"}], "release_timeline_malformed"),
    # A later row with a typo must not leave the earlier release in force.
    ([RELEASE, {**RELEASE, "effective_from": "2026-11-23 ", "execution_owner_version": "native-v8"}],
     "release_timeline_malformed"),
    ([RELEASE, "native-v8 from 11-23"], "release_timeline_malformed"),
    ([RELEASE, {"grant_key": "g", "execution_owner_version": "v"}], "release_timeline_malformed"),
    ({"effective_from": "2026-11-01"}, "release_timeline_malformed"),
])
def test_a_malformed_release_timeline_names_no_identity(timeline, reason):
    evidence, collector, _ = _collect(manual=_manual(release_timeline=timeline))
    assert evidence["paper_days"] == []
    assert f"paper_day_identity_unavailable:{WINDOW[0]}:{reason}" in collector.gaps


def _marks(world, day, detail):
    world.run("paper", "UPDATE paper_execution_events SET detail_json=? WHERE trade_date=?", [json.dumps(detail), day])


def _mismatch(world, day):
    evidence, _, _ = _collect(world)
    return next(r for r in evidence["paper_days"] if r["date"] == day)["health"]["nav_quote_date_mismatch"]


def test_a_holding_without_a_mark_counts():
    world = World()
    day = WINDOW[2]
    _marks(world, day, {"positions": {"2330": 1000, "2317": 2000, "9999": 0},
                        "mark_evidence": {"2330": {"price_date": day}}})
    assert _mismatch(world, day) == 1


@pytest.mark.parametrize("stamp,count", [
    ("{day} 16:30:00", 0),  # naive broker time is Taiwan local (Worker quoteBelongsToSession)
    ("{day}T13:30:00", 0),
    ("{next} 00:30:00", 1),
    ("{day}T16:00:00+00:00", 1),  # 00:00 the next Taiwan day
    ("", 1),  # an empty quote_time is not replaced by observed_at
])
def test_quote_stamps(stamp, count):
    world = World()
    day, nxt = WINDOW[2], WINDOW[3]
    _marks(world, day, {"mark_evidence": {"2330": {"price_date": day, "quote_time": stamp.format(day=day, next=nxt),
                                                   "observed_at": f"{day}T05:00:00Z"}}})
    assert _mismatch(world, day) == count


def test_the_latest_verified_valuation_is_the_one_checked():
    world = World()
    day = WINDOW[2]
    _marks(world, day, {"mark_evidence": {"2330": {"price_date": WINDOW[0]}}})  # superseded by the 18:25 rerun
    world.run("paper", "INSERT INTO paper_execution_events (account_id,trade_date,event_type,status,reason,detail_json)"
                       " VALUES (1,?,'snapshot_audit','verified','dated_marks_complete',?)",
              [day, json.dumps({"mark_evidence": {"2330": {"price_date": day}}})])
    assert _mismatch(world, day) == 0


def test_pending_buys_exactly_at_0845_are_on_time():
    world = World()
    day = WINDOW[1]
    world.run("paper", "INSERT INTO pending_buy_runs VALUES (1,?,'ready')", [day])
    world.run("paper", "INSERT INTO pending_buy_items (run_id,symbol,created_at) VALUES (1,'2330',?)",
              [f"{day} 00:45:00"])
    evidence, _, _ = _collect(world)
    assert evidence["paper_days"][1]["health"]["pending_buys_after_0845"] == 0


def test_other_jobs_and_markers():
    world = World()
    day = WINDOW[2]
    world.run("ops", "UPDATE scheduler_execution_tickets_v1 SET status='error' WHERE ticket_id=?", [f"root-{day}"])
    world.run("ops", "INSERT INTO scheduler_execution_tickets_v1 VALUES ('other','premarket-v3',?,'physical_root',"
                     "'success',NULL,?)", [day, f"{day} 23:00:00"])
    world.run("ops", "INSERT INTO pipeline_stage_runs VALUES (?,'x','paper_execution_unscoped_database')", [day])
    evidence, _, _ = _collect(world)
    health = evidence["paper_days"][2]["health"]
    assert health["evening_chain_incomplete"] == 1 and health["paper_execution_scope_violation"] == 1


def test_as_of_follows_the_taiwan_date():
    after_midnight_taipei = datetime(2026, 12, 8, 16, 30, tzinfo=timezone.utc)  # 12-09 00:30 in Taipei
    assert _collect(now=after_midnight_taipei)[0]["as_of"] == "2026-12-09"
    before = datetime(2026, 12, 8, 15, 59, tzinfo=timezone.utc)
    assert _collect(now=before)[0]["as_of"] == "2026-12-08"


def test_main_refuses_a_non_finite_value(tmp_path, monkeypatch):
    world = World()
    world.kv["trading:live_config"] = '{"mode": "paper", "x": NaN}'
    monkeypatch.setattr(collect, "_live_sources", lambda: (world.query, world.kv_get))
    manual, out, policy = tmp_path / "m.json", tmp_path / "e.json", tmp_path / "p.json"
    manual.write_text(json.dumps(_manual()))
    policy.write_text(json.dumps(POLICY))
    with pytest.raises(ValueError):
        collect.main(["--calendar-start", START, "--manual", str(manual), "--policy", str(policy), "--out", str(out)])
    assert not out.exists()


def test_a_mark_with_a_wrong_date_and_a_wrong_stamp_counts_once():
    world = World()
    day = WINDOW[2]
    _marks(world, day, {"mark_evidence": {"2330": {"price_date": WINDOW[0], "quote_time": "garbage"}}})
    assert _mismatch(world, day) == 1


@pytest.mark.parametrize("detail", [{"positions": [["2330", 1000]], "mark_evidence": {}},
                                    {"positions": {}, "mark_evidence": [["2330", {}]]}])
def test_an_unreadable_valuation_receipt_counts(detail):
    world = World()
    day = WINDOW[2]
    _marks(world, day, detail)
    assert _mismatch(world, day) == 1
