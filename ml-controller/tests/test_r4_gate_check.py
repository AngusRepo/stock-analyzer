"""M12: the R4-gate check fails closed on every missing or contrary input."""

from __future__ import annotations

import copy
import importlib.util
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("r4_gate_check", ROOT / "tools/live/r4_gate_check.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

DRAFT = json.loads((ROOT / "docs/live/r4_gate_policy_v1.json").read_text())
OFFICIAL = "2026-11-26"  # a TWSE-announced closure frozen in the policy
POLICY = {**DRAFT, "status": "frozen", "calendar": {**DRAFT["calendar"], "official_closures": [OFFICIAL]}}
POLICY_SHA = gate.sha256_of(POLICY)
HOLIDAY = "2026-11-20"  # an ad hoc closure confirmed by Wei
CLOSED = {HOLIDAY, OFFICIAL}
START = "2026-11-09"
IDENTITY = {"grant_key": "g1", "execution_owner_version": "v1", "l3_identity": "l3", "allocator_identity": "a1"}
HEALTH = {field: 0 for field in POLICY["health"]["zero_count_fields"]}
DAYS = gate.trading_days(START, "2026-12-08", CLOSED)
AS_OF = DAYS[-1]
NOW = datetime(2026, 12, 8, 13, 0, tzinfo=timezone.utc)  # 21:00 Taiwan time on as_of


def _wiggle(i, base, size=0.002):
    return base + (size if i % 2 else -size)


def _evidence():
    return {
        "schema_version": "r4-gate-evidence-v1",
        "as_of": AS_OF,
        "calendar_start": START,
        "ad_hoc_closures": [{"date": HOLIDAY, "wei_confirmed": True, "reason": "typhoon closure"}],
        "slice_a_identity": dict(IDENTITY),
        "d12_replay_receipts": [],
        "paper_days": [{"date": d, "identity": dict(IDENTITY), "health": dict(HEALTH)} for d in DAYS],
        "signal": {
            "oos_days": [{"date": d, "tails": {"1.5": _wiggle(i, 0.008), "2.0": _wiggle(i, 0.010)},
                          "hmm_state": "bull" if i % 3 else "bear", "spearman": 0.03}
                         for i, d in enumerate(DAYS)],
            "oof": {"1.5": {"point": 0.007, "ci_low": 0.005, "ci_high": 0.009},
                    "2.0": {"point": 0.009, "ci_low": 0.006, "ci_high": 0.012}},
        },
        "trading_config_fees": {"commission": 0.001425, "tax": 0.003},
        "net_excess_days": [{"date": d, "gross_excess": _wiggle(i, 0.003), "one_way_turnover": 0.2,
                             "paper_account_return": _wiggle(i, 0.001)} for i, d in enumerate(DAYS)],
        "allocator_decisions": {k: {"decided_by": "wei", "receipt_ref": f"DECISIONS#{k}", "decided_at": DAYS[0]}
                                for k in POLICY["allocator_decisions_required"]},
        "live_tests": {
            "release_sha": "a" * 40,
            "results": {k: {"status": "pass", "release_sha": "a" * 40} for k in POLICY["live_tests_required"]},
            "T8": {"wei_receipt_sha256": "b" * 64},
            "T9": {"receipt_sha256": "c" * 64, "orders_submitted": 0, "gateway_submit_flag": "0"},
        },
        "live_config": {"mode": "paper", "pause": {"enabled": False}, "capital_source": "broker_nav_authoritative_marks"},
        "account_observation": {"schema_version": "live-account-observation-v1",
                                "account_scope": "live:sinopac:" + "f" * 64, "sha256": "d" * 64},
        "slippage_band": {"artifact_sha256": "9" * 64},
    }


def _run(evidence, policy=POLICY, now=NOW, expected=POLICY_SHA):
    return gate.evaluate(policy, evidence, now, expected)


def test_complete_evidence_passes_and_the_receipt_hash_covers_everything():
    receipt = _run(_evidence())
    assert receipt["overall"] == "PASS", json.dumps(receipt["gates"], indent=1)
    assert len(DAYS) == 20 and not CLOSED & set(DAYS)
    body = {k: v for k, v in receipt.items() if k != "receipt_sha256"}
    assert receipt["receipt_sha256"] == gate.sha256_of(body)
    assert receipt["policy_sha256"] == POLICY_SHA
    g3 = receipt["gates"]["G3_signal"]["details"]
    assert g3["realized_signal_days"] == 20 - POLICY["signal"]["target_horizon_trading_days"]
    assert g3["tails"]["2.0"]["lag"] == POLICY["signal"]["target_horizon_trading_days"] - 1
    assert set(g3["hmm_state_descriptive"]) == {"bull", "bear"}
    assert receipt["gates"]["G4_net_excess"]["details"]["cost_per_one_way_turnover"] == pytest.approx(0.00585)


def test_the_draft_policy_or_any_other_policy_never_passes():
    draft = _run(_evidence(), policy=DRAFT, expected=gate.sha256_of(DRAFT))
    assert draft["overall"] == "FAIL" and "policy_not_frozen" in draft["gates"]["policy"]["error"]
    loose = copy.deepcopy(POLICY)
    loose["paper"]["min_trading_days_under_slice_a_identity"] = 8
    assert _run(_evidence(), policy=loose)["gates"]["policy"]["status"] == "FAIL"
    empty = copy.deepcopy(POLICY)
    empty["signal"]["z_tails"] = []
    assert _run(_evidence(), policy=empty, expected=gate.sha256_of(empty))["gates"]["policy"]["status"] == "FAIL"


def _mutate(path, value):
    ev = _evidence()
    target = ev
    for key in path[:-1]:
        target = target[key]
    if value is KeyError:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return ev


@pytest.mark.parametrize("gate_name,path,value", [
    ("G1_identity", ("schema_version",), "x"),
    ("G1_identity", ("slice_a_identity", "grant_key"), "other"),
    ("G1_identity", ("slice_a_identity", "grant_key"), ""),
    ("G1_identity", ("paper_days", 19), KeyError),  # the latest trading day has no Paper record
    ("G1_identity", ("paper_days", 9), KeyError),  # a mid-window gap
    ("G1_identity", ("ad_hoc_closures",), [{"date": HOLIDAY, "wei_confirmed": True, "reason": "typhoon"},
                                           {"date": "2026-11-25", "wei_confirmed": True, "reason": "x"}]),
    ("G1_identity", ("ad_hoc_closures", 0, "wei_confirmed"), False),  # a missing Paper day relabelled as a closure
    ("G1_identity", ("ad_hoc_closures", 0, "wei_confirmed"), "true"),  # only the JSON literal true counts
    ("G1_identity", ("ad_hoc_closures", 0, "reason"), ""),
    ("G1_identity", ("ad_hoc_closures", 0, "reason"), 5),
    ("G1_identity", ("ad_hoc_closures", 0, "reason"), "   "),
    ("G1_identity", ("ad_hoc_closures", 0, "wei_confirmed"), 1),
    ("G1_identity", ("as_of",), "2026-12-05"),  # a Saturday as_of run on a later day
    ("G1_identity", ("as_of",), "2026-12-09"),  # evidence newer than the receipt
    ("G1_identity", ("as_of",), "2026-12-04"),  # stale: later trading days exist
    ("G1_identity", ("as_of",), "2026-12-06"),  # a Sunday is never a trading day
    ("G1_identity", ("d12_replay_receipts",), ["x"]),
    ("G2_health", ("paper_days", 3, "health", "evening_chain_incomplete"), 1),
    ("G2_health", ("paper_days", 3, "health", "evening_chain_incomplete"), -1),
    ("G2_health", ("paper_days", 3, "health", "evening_chain_incomplete"), True),
    ("G2_health", ("paper_days", 3, "health", "ledger_cross_write"), KeyError),
    ("G3_signal", ("signal", "oof", "2.0", "point"), -0.005),
    ("G3_signal", ("signal", "oof", "1.5"), {"point": 0.007, "ci_low": 0.02, "ci_high": 0.03}),
    ("G3_signal", ("signal", "oof", "2.0"), KeyError),
    ("G3_signal", ("signal", "oos_days", 4), KeyError),
    ("G4_net_excess", ("trading_config_fees", "tax"), 0.02),
    ("G4_net_excess", ("trading_config_fees", "commission"), KeyError),
    ("G4_net_excess", ("trading_config_fees", "commission"), -0.01),
    ("G4_net_excess", ("trading_config_fees", "tax"), -0.003),
    ("G4_net_excess", ("net_excess_days", 2, "one_way_turnover"), -0.2),
    ("G4_net_excess", ("net_excess_days", 2, "gross_excess"), float("nan")),
    ("G5_allocator", ("allocator_decisions", "NEW-L08", "decided_by"), "agent"),
    ("G5_allocator", ("allocator_decisions", "NEW-L08", "receipt_ref"), ""),
    ("G5_allocator", ("allocator_decisions", "NEW-L08", "decided_at"), "2026-12-09"),
    ("G5_allocator", ("allocator_decisions", "R13"), KeyError),
    ("G5_allocator", ("allocator_decisions", "R13"), "decided"),
    ("G6_live_tests", ("live_tests", "results", "T3", "status"), "fail"),
    ("G6_live_tests", ("live_tests", "results", "T7", "release_sha"), "b" * 40),
    ("G6_live_tests", ("live_tests", "T8"), KeyError),
    ("G6_live_tests", ("live_tests", "T8", "wei_receipt_sha256"), "x"),
    ("G6_live_tests", ("live_tests", "T8", "wei_receipt_sha256"), int("1" * 64)),  # a number is not a sha
    ("G6_live_tests", ("live_tests", "T9", "receipt_sha256"), int("1" * 64)),
    ("G6_live_tests", ("live_tests", "T9"), "x"),
    ("G6_live_tests", ("live_tests", "T9", "orders_submitted"), 1),
    ("G6_live_tests", ("live_tests", "T9", "orders_submitted"), False),
    ("G6_live_tests", ("live_tests", "T9", "gateway_submit_flag"), "1"),
    ("G7_config", ("live_config", "mode"), "live"),
    ("G7_config", ("live_config", "pause", "enabled"), True),
    ("G7_config", ("live_config", "capital_source"), "broker_available_cash"),
    ("G7_config", ("live_config",), ["paper"]),
    ("G7_config", ("account_observation", "sha256"), "x"),
    ("G7_config", ("account_observation", "sha256"), int("1" * 64)),
    ("G7_config", ("account_observation", "schema_version"), "v0"),
    ("G7_config", ("account_observation", "account_scope"), "paper:1"),
    ("G7_config", ("slippage_band",), KeyError),
])
def test_each_missing_or_contrary_input_fails_its_gate(gate_name, path, value):
    receipt = _run(_mutate(path, value))
    assert receipt["gates"][gate_name]["status"] == "FAIL"
    assert receipt["overall"] == "FAIL"


def test_release_sha_must_be_a_git_sha_even_when_every_test_names_it():
    ev = _evidence()
    ev["live_tests"]["release_sha"] = "x"
    for row in ev["live_tests"]["results"].values():
        row["release_sha"] = "x"
    assert _run(ev)["gates"]["G6_live_tests"]["status"] == "FAIL"


def test_net_excess_of_exactly_zero_fails():
    ev = _evidence()
    for row in ev["net_excess_days"]:
        row["gross_excess"] = row["one_way_turnover"] * 0.00585
    assert _run(ev)["gates"]["G4_net_excess"]["status"] == "FAIL"


def test_a_sparse_tail_cannot_pass_on_a_wide_interval():
    ev = _evidence()
    for row in ev["signal"]["oos_days"][2:]:
        row["tails"]["2.0"] = None
    tail = _run(ev)["gates"]["G3_signal"]["details"]["tails"]["2.0"]
    assert tail["status"] == "too_few_days_with_names"


def test_unrealized_days_are_derived_from_the_calendar_not_the_evidence_flag():
    ev = _evidence()
    for row in ev["signal"]["oos_days"][-5:]:
        row["realized"] = True
        row["tails"] = {"1.5": -1.0, "2.0": -1.0}  # partial-horizon values must not enter the mean
    assert _run(ev)["gates"]["G3_signal"]["status"] == "PASS"


def test_a_late_identity_change_restarts_the_count_unless_wei_confirmed_a_d12_replay():
    ev = _evidence()
    new = {**IDENTITY, "grant_key": "g2"}
    for row in ev["paper_days"][10:]:
        row["identity"] = dict(new)
    assert _run(ev)["gates"]["G1_identity"]["trading_days"] == 10
    ev["d12_replay_receipts"] = [{"from_identity_sha256": gate.sha256_of(IDENTITY),
                                  "to_identity_sha256": gate.sha256_of(new),
                                  "wei_confirmed": True, "receipt_sha256": "e" * 64}]
    assert _run(ev)["gates"]["G1_identity"]["status"] == "PASS"
    ev["d12_replay_receipts"][0]["wei_confirmed"] = False
    assert _run(ev)["gates"]["G1_identity"]["status"] == "FAIL"


def test_duplicate_dates_and_malformed_bundles_fail_without_raising():
    ev = _evidence()
    ev["paper_days"].append(copy.deepcopy(ev["paper_days"][0]))
    assert _run(ev)["gates"]["G1_identity"]["status"] == "FAIL"
    for bad in ([], "x", {"schema_version": "r4-gate-evidence-v1"}):
        receipt = _run(bad)
        assert receipt["overall"] == "FAIL" and all(g["status"] == "FAIL" for k, g in receipt["gates"].items()
                                                    if k.startswith("G"))


def test_hac_matches_a_hand_computed_newey_west_value():
    values = [1.0, -1.0, 2.0, 0.0]
    # mean 0.5; resid 0.5,-1.5,1.5,-0.5; g0=1.25, g1=(-0.75-2.25-0.75)/4=-0.9375; LR=1.25+2*0.5*-0.9375=0.3125
    out = gate.hac_mean_ci(values, 1, 0.95)
    assert out["mean"] == pytest.approx(0.5) and out["se"] == pytest.approx((0.3125 / 4) ** 0.5)
    series = [0.01, 0.011, 0.012, 0.011, 0.01, -0.01, -0.011, -0.012, -0.011, -0.01] * 2
    assert gate.hac_mean_ci(series, 4, 0.95)["se"] > gate.hac_mean_ci(series, 0, 0.95)["se"]


class _EvidenceDayClock(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW


def test_cli_rejects_duplicate_keys_and_non_finite_values_with_a_fail_receipt(tmp_path, monkeypatch):
    monkeypatch.setattr(gate, "datetime", _EvidenceDayClock)
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(POLICY))
    approved = tmp_path / "approved"
    approved.write_text(POLICY_SHA + "\n")
    monkeypatch.setattr(gate, "DEFAULT_APPROVED_SHA", approved)
    evidence = tmp_path / "evidence.json"
    out = tmp_path / "receipt.json"
    args = ["--evidence", str(evidence), "--policy", str(policy), "--out", str(out),
            "--expected-policy-sha256", POLICY_SHA]
    evidence.write_text(json.dumps(_evidence()))
    assert gate.main(args) == 0  # the complete bundle passes on its evidence day
    assert json.loads(out.read_text())["overall"] == "PASS"
    for text in ('{"a": 1, "a": 2}', '{"a": NaN}'):
        evidence.write_text(text)
        assert gate.main(args) == 1 and json.loads(out.read_text())["overall"] == "FAIL"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["approved", "evidence.json", "policy.json", "receipt.json"]
    # 1e400 parses to infinity; it is rejected like NaN.
    evidence.write_text('{"as_of": 1e400}')
    assert gate.main(args) == 1
    # Without the committed approval file nothing passes, even a complete bundle.
    evidence.write_text(json.dumps(_evidence()))
    monkeypatch.setattr(gate, "DEFAULT_APPROVED_SHA", tmp_path / "missing")
    assert gate.main(args) == 1
    assert "policy_sha256_not_the_approved_one" in json.loads(out.read_text())["gates"]["policy"]["error"]
    # A broken policy file still yields a FAIL receipt.
    monkeypatch.setattr(gate, "DEFAULT_APPROVED_SHA", approved)
    policy.write_text("{")
    assert gate.main(args) == 1
    assert json.loads(out.read_text())["gates"]["policy"]["error"] == "EvidenceError:policy_schema_invalid"


def test_the_cli_has_no_way_to_point_at_another_approval_file(tmp_path):
    with pytest.raises(SystemExit):
        gate.main(["--evidence", str(tmp_path / "e"), "--expected-policy-sha256", POLICY_SHA,
                   "--approved-sha-file", str(tmp_path / "a")])


def test_the_cli_refuses_to_run_without_the_expected_policy_sha(tmp_path):
    with pytest.raises(SystemExit):
        gate.main(["--evidence", str(tmp_path / "e")])


@pytest.mark.parametrize("operator_sha", ["0" * 64, POLICY_SHA.upper(), ""])
def test_an_expected_sha_that_differs_from_the_committed_file_fails(tmp_path, monkeypatch, operator_sha):
    monkeypatch.setattr(gate, "datetime", _EvidenceDayClock)
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps(POLICY))
    approved = tmp_path / "approved"
    approved.write_text(POLICY_SHA + "\n")
    monkeypatch.setattr(gate, "DEFAULT_APPROVED_SHA", approved)
    evidence = tmp_path / "evidence.json"
    evidence.write_text(json.dumps(_evidence()))
    out = tmp_path / "receipt.json"
    assert gate.main(["--evidence", str(evidence), "--policy", str(policy), "--out", str(out),
                      "--expected-policy-sha256", operator_sha]) == 1
    assert json.loads(out.read_text())["gates"]["policy"]["status"] == "FAIL"
    assert gate.main(["--evidence", str(evidence), "--policy", str(policy), "--out", str(out),
                      "--expected-policy-sha256", POLICY_SHA]) == 0


@pytest.mark.parametrize("status", ["approved", "Frozen", "frozen ", "FROZEN", ""])
def test_only_the_exact_frozen_status_passes_the_policy_gate(status):
    policy = {**POLICY, "status": status}
    receipt = gate.evaluate(policy, _evidence(), NOW, gate.sha256_of(policy))
    assert receipt["gates"]["policy"]["status"] == "FAIL"


def test_an_ad_hoc_closure_outside_the_window_is_not_listed():
    ev = _evidence()
    ev["calendar_start"] = "2026-11-02"
    ev["ad_hoc_closures"].append({"date": "2026-11-04", "wei_confirmed": True, "reason": "typhoon"})
    g1 = _run(ev)["gates"]["G1_identity"]
    assert g1["first_day"] == DAYS[0] and g1["ad_hoc_closures_in_window"] == [HOLIDAY]


def test_the_draft_policy_fails_even_with_its_own_sha():
    receipt = gate.evaluate(DRAFT, _evidence(), NOW, gate.sha256_of(DRAFT))
    assert receipt["overall"] == "FAIL" and receipt["gates"]["policy"]["status"] == "FAIL"


def test_the_tail_cost_condition_is_reported_but_never_fails_g3():
    ev = _evidence()
    ev["trading_config_fees"]["tax"] = 0.02  # round trip 0.02285 > every tail mean
    receipt = _run(ev)
    g3 = receipt["gates"]["G3_signal"]
    assert g3["status"] == "PASS"
    for tail in ("1.5", "2.0"):
        report = g3["details"]["tails"][tail]["net_of_round_trip_cost_report_only"]
        assert report["clears_cost"] is False and report["mean"] < 0 and report["ci_high"] < 0
    assert receipt["gates"]["G4_net_excess"]["status"] == "FAIL"  # the after-cost gate is G4


def test_receipt_time_binds_the_evidence_date():
    # Run before as_of exists (Taiwan date 12/7) or after later trading days passed (12/10).
    assert _run(_evidence(), now=datetime(2026, 12, 7, 13, 0, tzinfo=timezone.utc))["overall"] == "FAIL"
    stale = _run(_evidence(), now=datetime(2026, 12, 10, 13, 0, tzinfo=timezone.utc))
    assert "as_of_not_latest_trading_day" in stale["gates"]["G1_identity"]["error"]
    # Late evening on as_of (23:59 Taiwan) is still fresh; 07:00 the next trading day is not.
    assert _run(_evidence(), now=datetime(2026, 12, 8, 15, 59, tzinfo=timezone.utc))["overall"] == "PASS"
    assert _run(_evidence(), now=datetime(2026, 12, 8, 23, 0, tzinfo=timezone.utc))["overall"] == "FAIL"


def test_blank_identities_and_boolean_counts_are_not_evidence():
    ev = _evidence()
    blank = {k: "" for k in IDENTITY}
    ev["slice_a_identity"] = dict(blank)
    for row in ev["paper_days"]:
        row["identity"] = dict(blank)
    assert _run(ev)["gates"]["G1_identity"]["status"] == "FAIL"
    ev = _mutate(("paper_days", 3, "health", "evening_chain_incomplete"), False)
    assert _run(ev)["gates"]["G2_health"]["status"] == "FAIL"


def test_duplicate_json_keys_are_rejected_before_hashing():
    with pytest.raises(gate.EvidenceError, match="duplicate_json_key"):
        gate._strict_json('{"as_of": "2026-12-08", "as_of": "2026-12-01"}')


def test_the_approved_sha_ships_only_with_a_frozen_policy():
    approved = ROOT / "docs/live/r4_gate_policy_v1.approved_sha256"
    if DRAFT.get("status") == "frozen":
        assert approved.read_text().strip() == gate.sha256_of(DRAFT)
    else:
        assert not approved.exists()


def test_non_finite_values_copied_into_the_receipt_never_raise():
    ev = _evidence()
    ev["as_of"] = float("inf")
    ev["signal"]["oof"]["2.0"]["extra"] = float("inf")
    receipt = _run(ev)
    assert receipt["overall"] == "FAIL" and receipt["as_of"] is None
    ev = _evidence()
    ev["signal"]["oof"]["2.0"]["extra"] = float("nan")
    receipt = _run(ev)  # evidence hash fails, oof copy keeps only the validated numbers
    assert receipt["overall"] == "FAIL" and "extra" not in json.dumps(receipt)


def test_tail_mean_exactly_at_cost_is_reported_as_not_clearing_without_failing_g3():
    ev = _evidence()
    for row in ev["signal"]["oos_days"]:
        row["tails"]["1.5"] = 0.00585
    ev["signal"]["oof"]["1.5"] = {"point": 0.006, "ci_low": 0.005, "ci_high": 0.007}
    g3 = _run(ev)["gates"]["G3_signal"]
    report = g3["details"]["tails"]["1.5"]["net_of_round_trip_cost_report_only"]
    assert report["clears_cost"] is False and report["mean"] == pytest.approx(0)
    assert g3["status"] == "PASS"


def test_a_mid_window_gap_breaks_the_streak_even_with_spare_days():
    days = gate.trading_days("2026-11-02", "2026-12-08", CLOSED)
    ev = _evidence()
    ev["calendar_start"] = days[0]
    ev["paper_days"] = [{"date": d, "identity": dict(IDENTITY), "health": dict(HEALTH)} for d in days]
    for key in ("oos_days", ):
        ev["signal"][key] = [{"date": d, "tails": {"1.5": _wiggle(i, 0.008), "2.0": _wiggle(i, 0.010)}}
                             for i, d in enumerate(days)]
    ev["net_excess_days"] = [{"date": d, "gross_excess": _wiggle(i, 0.003), "one_way_turnover": 0.2}
                             for i, d in enumerate(days)]
    assert _run(ev)["overall"] == "PASS"
    del ev["paper_days"][len(days) - 12]  # inside the last 20 trading days
    g1 = _run(ev)["gates"]["G1_identity"]
    assert g1["status"] == "FAIL" and g1["trading_days"] == 11


def test_g7_writes_the_band_and_observation_shas_into_the_receipt():
    details = _run(_evidence())["gates"]["G7_config"]["details"]
    assert details["slippage_band_artifact_sha256"] == "9" * 64
    assert details["account_observation_sha256"] == "d" * 64


@pytest.mark.parametrize("band", [{"artifact_sha256": "x"}, {"artifact_sha256": "9" * 63}, {}, "9" * 64, None,
                                  {"artifact_sha256": int("1" * 64)}, {"artifact_sha256": "9" * 64 + "\n"}])
def test_g7_fails_on_a_malformed_slippage_band(band):
    ev = _evidence()
    ev["slippage_band"] = band
    g7 = _run(ev)["gates"]["G7_config"]
    assert g7["status"] == "FAIL" and g7["details"]["slippage_band_frozen"] is False
    assert g7["details"]["slippage_band_artifact_sha256"] is None


def test_the_receipt_lists_both_closure_kinds_for_wei_to_check():
    g1 = _run(_evidence())["gates"]["G1_identity"]
    assert g1["status"] == "PASS"
    assert g1["official_closures_in_window"] == [OFFICIAL]
    assert g1["ad_hoc_closures_in_window"] == [HOLIDAY]


def test_an_official_closure_with_a_paper_record_missing_is_not_a_gap():
    policy = {**POLICY, "calendar": {**POLICY["calendar"], "official_closures": []}}
    receipt = gate.evaluate(policy, _evidence(), NOW, gate.sha256_of(policy))
    assert receipt["gates"]["G1_identity"]["status"] == "FAIL"  # 11/26 is a weekday without Paper


def _long_evidence(end):
    days = gate.trading_days("2026-11-02", end, CLOSED)
    ev = _evidence()
    ev["calendar_start"] = days[0]
    ev["paper_days"] = [{"date": d, "identity": dict(IDENTITY), "health": dict(HEALTH)} for d in days]
    ev["signal"]["oos_days"] = [{"date": d, "tails": {"1.5": _wiggle(i, 0.008), "2.0": _wiggle(i, 0.010)}}
                                for i, d in enumerate(days)]
    ev["net_excess_days"] = [{"date": d, "gross_excess": _wiggle(i, 0.003), "one_way_turnover": 0.2}
                             for i, d in enumerate(days)]
    return ev


def test_a_weekend_as_of_is_refused_even_when_no_trading_day_followed():
    ev = _long_evidence("2026-12-04")
    monday = datetime(2026, 12, 7, 1, 0, tzinfo=timezone.utc)  # before Monday's session
    ev["as_of"] = "2026-12-04"
    assert _run(ev, now=datetime(2026, 12, 4, 13, 0, tzinfo=timezone.utc))["overall"] == "PASS"
    ev["as_of"] = "2026-12-05"
    assert "as_of_not_latest_trading_day" in _run(ev, now=monday)["gates"]["G1_identity"]["error"]


def test_a_non_finite_value_in_gate_details_still_yields_a_fail_receipt(monkeypatch):
    monkeypatch.setattr(gate, "GATES", [("G2_health", lambda p, e, w: (True, {"x": float("inf")}), True)])
    receipt = _run(_evidence())
    assert receipt["overall"] == "FAIL" and receipt["gates"] == {
        "receipt": {"status": "FAIL", "error": "receipt_not_canonical_json"}}
    assert receipt["receipt_sha256"] == gate.sha256_of({k: v for k, v in receipt.items() if k != "receipt_sha256"})


def _blank_tail(ev, tail, n):
    """Remove names for `tail` on the first n realized signal days of the 20-day window."""
    realized = set(DAYS[-20:-POLICY["signal"]["target_horizon_trading_days"]][:n])
    for row in ev["signal"]["oos_days"]:
        if row["date"] in realized:
            row["tails"][tail] = None


def test_the_z2_tail_passes_with_ten_days_of_names_and_fails_with_nine():
    ev = _evidence()
    _blank_tail(ev, "2.0", 5)
    g3 = _run(ev)["gates"]["G3_signal"]
    assert g3["status"] == "PASS"
    assert g3["details"]["tails"]["2.0"]["required"] == 10
    assert g3["details"]["tails"]["2.0"]["days_without_names"] == 5
    ev = _evidence()
    _blank_tail(ev, "2.0", 6)
    tail = _run(ev)["gates"]["G3_signal"]["details"]["tails"]["2.0"]
    assert tail == {"n": 9, "required": 10, "status": "too_few_days_with_names"}


def test_the_z15_tail_still_needs_every_realized_day():
    ev = _evidence()
    _blank_tail(ev, "1.5", 1)
    g3 = _run(ev)["gates"]["G3_signal"]
    assert g3["status"] == "FAIL"
    assert g3["details"]["tails"]["1.5"] == {"n": 14, "required": 15, "status": "too_few_days_with_names"}


@pytest.mark.parametrize("tail_min, reason", [
    (None, "missing"),
    ({"1.5": 15}, "policy_tail_min_days_keys_mismatch"),
    ({"1.5": 15, "2.0": 10, "2.5": 5}, "policy_tail_min_days_keys_mismatch"),
    ({"1.5": 15, "2.0": 0}, "policy_tail_min_days_invalid:2.0"),
    ({"1.5": 16, "2.0": 10}, "policy_tail_min_days_invalid:1.5"),
    ({"1.5": 15, "2.0": True}, "policy_tail_min_days_invalid:2.0"),
    ({"1.5": 15, "2.0": 10.0}, "policy_tail_min_days_invalid:2.0"),
])
def test_a_tail_floor_must_be_set_for_every_tail_within_the_realized_window(tail_min, reason):
    policy = copy.deepcopy(POLICY)
    if tail_min is None:
        del policy["signal"]["tail_min_days_with_names"]
    else:
        policy["signal"]["tail_min_days_with_names"] = tail_min
    with pytest.raises((gate.EvidenceError, KeyError)) as exc:
        gate.validate_policy(policy)
    if reason != "missing":
        assert str(exc.value) == reason
