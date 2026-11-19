"""M12 R4-gate check: evaluate G1-G7 from a read-only evidence bundle.

Reads two local JSON files (the frozen policy and the evidence bundle) and
writes a live_gate_receipt. No network, no D1/KV/GCS access, no writes other
than the receipt file. Any missing or malformed input fails closed, and the
policy must be the frozen one whose canonical sha Wei approved.

Usage:
    python tools/live/r4_gate_check.py --evidence evidence.json \
        --expected-policy-sha256 <sha recorded in DECISIONS> \
        [--policy docs/live/r4_gate_policy_v1.json] [--out receipt.json]
The approved policy sha is read from the repo file next to the policy
(r4_gate_policy_v1.approved_sha256), committed when Wei freezes it. The
command-line sha must equal that file; no option points at another file.
Exit code 0 only when every gate passes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import NormalDist
from typing import Any, Callable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLICY = ROOT / "docs/live/r4_gate_policy_v1.json"
DEFAULT_APPROVED_SHA = ROOT / "docs/live/r4_gate_policy_v1.approved_sha256"
TW = ZoneInfo("Asia/Taipei")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_GIT_SHA = re.compile(r"[0-9a-f]{40}")


class EvidenceError(ValueError):
    """Evidence or policy is missing or malformed; the gate fails closed."""


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_of(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _need(mapping: Any, key: str) -> Any:
    if not isinstance(mapping, dict) or key not in mapping or mapping[key] is None:
        raise EvidenceError(f"missing:{key}")
    return mapping[key]


def _dict(value: Any, name: str) -> dict:
    if not isinstance(value, dict):
        raise EvidenceError(f"not_an_object:{name}")
    return value


def _number(value: Any, name: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise EvidenceError(f"not_a_number:{name}")
    if minimum is not None and float(value) < minimum:
        raise EvidenceError(f"below_minimum:{name}")
    return float(value)


def _is_sha(value: Any) -> bool:
    """A lowercase hex sha256 string; a JSON number of 64 digits is malformed, not a sha."""
    return isinstance(value, str) and bool(_SHA256.fullmatch(value))


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvidenceError(f"empty:{name}")
    return value


def _day(value: Any, name: str) -> str:
    text = str(value or "")
    try:
        if date.fromisoformat(text).isoformat() == text:
            return text
    except ValueError:
        pass
    raise EvidenceError(f"bad_date:{name}")


def _by_day(rows: Any, name: str) -> dict[str, dict]:
    if not isinstance(rows, list):
        raise EvidenceError(f"not_a_list:{name}")
    out: dict[str, dict] = {}
    for row in rows:
        day = _day(_need(_dict(row, name), "date"), name)
        if day in out:
            raise EvidenceError(f"duplicate_date:{name}:{day}")
        out[day] = row
    return out


def trading_days(start: str, end: str, holidays: set[str]) -> list[str]:
    """TWSE trading days in [start, end]: weekdays that are not holiday-KV closures."""
    day, last, out = date.fromisoformat(start), date.fromisoformat(end), []
    while day <= last:
        if day.weekday() < 5 and day.isoformat() not in holidays:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def hac_mean_ci(values: list[float], lag: int, level: float) -> dict[str, Any]:
    """Mean with a Newey-West (Bartlett) standard error and a normal CI."""
    n = len(values)
    if n < 2:
        raise EvidenceError("too_few_observations")
    mean = sum(values) / n
    resid = [v - mean for v in values]
    gamma = lambda k: sum(resid[t] * resid[t - k] for t in range(k, n)) / n  # noqa: E731
    long_run = gamma(0) + 2 * sum((1 - k / (lag + 1)) * gamma(k) for k in range(1, min(lag, n - 1) + 1))
    se = math.sqrt(max(long_run, 0.0) / n)
    z = NormalDist().inv_cdf(0.5 + level / 2)
    low, high = mean - z * se, mean + z * se
    return {"n": n, "mean": mean, "se": se, "lag": lag, "ci_low": low, "ci_high": high,
            "ci_crosses_zero": low <= 0.0 <= high}


def _sign(value: float) -> int:
    return (value > 0) - (value < 0)


def validate_policy(policy: Any) -> dict:
    policy = _dict(policy, "policy")
    if policy.get("schema_version") != "r4-gate-policy-v1":
        raise EvidenceError("policy_schema_invalid")
    paper, signal = _dict(_need(policy, "paper"), "paper"), _dict(_need(policy, "signal"), "signal")
    minimum = int(_number(_need(paper, "min_trading_days_under_slice_a_identity"), "min_days", minimum=1))
    horizon = int(_number(_need(signal, "target_horizon_trading_days"), "horizon", minimum=1))
    if minimum <= horizon + 1:
        raise EvidenceError("policy_window_shorter_than_horizon")
    for key, container in (("identity_fields", paper), ("z_tails", signal)):
        if not isinstance(container.get(key), list) or not container[key]:
            raise EvidenceError(f"policy_list_empty:{key}")
    tail_min = _dict(_need(signal, "tail_min_days_with_names"), "tail_min_days_with_names")
    if sorted(tail_min) != sorted(str(tail) for tail in signal["z_tails"]):
        raise EvidenceError("policy_tail_min_days_keys_mismatch")
    for tail, days in tail_min.items():
        # Each tail needs its own floor (Wei 11/18: z>=1.5 every realized day, z>=2 at least 10).
        if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= minimum - horizon:
            raise EvidenceError(f"policy_tail_min_days_invalid:{tail}")
    level = _number(_need(signal, "ci_level"), "ci_level")
    if not 0 < level < 1:
        raise EvidenceError("policy_ci_level_invalid")
    for key in ("allocator_decisions_required", "live_tests_required", "live_receipts_required"):
        if not isinstance(policy.get(key), list) or not policy[key]:
            raise EvidenceError(f"policy_list_empty:{key}")
    if not isinstance(_dict(_need(policy, "calendar"), "calendar").get("official_closures"), list):
        raise EvidenceError("policy_official_closures_missing")
    if not isinstance(_dict(_need(policy, "health"), "health").get("zero_count_fields"), list):
        raise EvidenceError("policy_list_empty:zero_count_fields")
    return policy


# ---- gates -------------------------------------------------------------------

def gate_identity(policy: dict, ev: dict, now: datetime) -> tuple[bool, dict, list[str]]:
    """G1: consecutive trading days under the Slice A identity (D-12 receipts bridge a change)."""
    fields = policy["paper"]["identity_fields"]
    minimum = int(policy["paper"]["min_trading_days_under_slice_a_identity"])
    slice_a = {f: _text(_need(_dict(_need(ev, "slice_a_identity"), "slice_a_identity"), f), f) for f in fields}
    as_of = _day(_need(ev, "as_of"), "as_of")
    start = _day(_need(ev, "calendar_start"), "calendar_start")
    official = {_day(d, "official_closures") for d in policy["calendar"]["official_closures"]}
    ad_hoc = set()
    for row in _need(ev, "ad_hoc_closures"):
        row = _dict(row, "ad_hoc_closures")
        day = _day(_need(row, "date"), "ad_hoc_closures")
        if row.get("wei_confirmed") is not True:
            raise EvidenceError(f"ad_hoc_closure_unconfirmed:{day}")
        _text(row.get("reason"), f"ad_hoc_closure_reason:{day}")
        ad_hoc.add(day)
    holidays = official | ad_hoc
    calendar = trading_days(start, as_of, holidays)
    # Freshness: as_of must be the latest trading day on or before today (Taiwan time).
    today = now.astimezone(TW).date().isoformat()
    if as_of > today:
        raise EvidenceError("evidence_newer_than_receipt")
    if not calendar or calendar[-1] != as_of or trading_days(as_of, today, holidays)[1:]:
        raise EvidenceError("as_of_not_latest_trading_day")
    days = _by_day(_need(ev, "paper_days"), "paper_days")
    bridges = set()
    for receipt in _need(ev, "d12_replay_receipts"):
        receipt = _dict(receipt, "d12_replay_receipts")
        if receipt.get("wei_confirmed") is True and _is_sha(receipt.get("receipt_sha256")):
            bridges.add((receipt.get("from_identity_sha256"), receipt.get("to_identity_sha256")))
    window: list[str] = []
    later_sha = None
    for day in reversed(calendar):
        row = days.get(day)
        if row is None:
            break  # A trading day with no Paper record ends the streak.
        identity = {f: _text(_need(_dict(_need(row, "identity"), "identity"), f), f) for f in fields}
        sha = sha256_of(identity)
        if later_sha is not None and sha != later_sha and (sha, later_sha) not in bridges:
            break
        window.append(day)
        later_sha = sha
    window.reverse()
    starts_on_slice_a = bool(window) and {f: days[window[0]]["identity"][f] for f in fields} == slice_a
    passed = starts_on_slice_a and len(window) >= minimum
    return passed, {"trading_days": len(window), "required": minimum, "first_day": window[0] if window else None,
                    "last_day": window[-1] if window else None, "starts_on_slice_a_identity": starts_on_slice_a,
                    "official_closures_in_window": sorted(h for h in official if window and window[0] <= h <= as_of),
                    "ad_hoc_closures_in_window": sorted(h for h in ad_hoc if window and window[0] <= h <= as_of)}, \
        window


def gate_health(policy: dict, ev: dict, window: list[str]) -> tuple[bool, dict]:
    """G2: every engineering-health counter is zero on every day of the window."""
    fields = policy["health"]["zero_count_fields"]
    rows = _by_day(_need(ev, "paper_days"), "paper_days")
    breaches = []
    for day in window:
        health = _dict(_need(rows[day], "health"), "health")
        for field in fields:
            count = _number(_need(health, field), f"health.{field}")
            if count != 0:
                breaches.append({"date": day, "field": field, "count": count})
    return bool(window) and not breaches, {"days_checked": len(window), "breaches": breaches}


def _round_trip_cost(ev: dict) -> float:
    fees = _dict(_need(ev, "trading_config_fees"), "trading_config_fees")
    return 2 * _number(_need(fees, "commission"), "fees.commission", minimum=0) \
        + _number(_need(fees, "tax"), "fees.tax", minimum=0)


def gate_signal(policy: dict, ev: dict, window: list[str]) -> tuple[bool, dict]:
    """G3: per z tail, OOS sign agrees with OOF and the CIs overlap.

    The mean and HAC CI net of one round-trip cost are reported only (Wei 10/29); the
    after-cost gate is G4 at the portfolio level.

    A signal day counts only when the calendar shows its horizon realized by as_of;
    the evidence's own flag is not trusted. Regime split is descriptive only.
    """
    cfg = policy["signal"]
    horizon = int(cfg["target_horizon_trading_days"])
    level = float(cfg["ci_level"])
    required = int(policy["paper"]["min_trading_days_under_slice_a_identity"]) - horizon
    cost = _round_trip_cost(ev)
    signal = _dict(_need(ev, "signal"), "signal")
    realized_days = window[:-horizon] if len(window) > horizon else []
    rows = _by_day(_need(signal, "oos_days"), "oos_days")
    missing = [d for d in realized_days if d not in rows]
    if missing:
        raise EvidenceError(f"oos_days_missing:{len(missing)}")
    realized = [rows[d] for d in realized_days]
    details: dict[str, Any] = {"realized_signal_days": len(realized), "required": required,
                               "round_trip_cost": cost, "tails": {}}
    passed = len(realized) >= required
    oof_all = _dict(_need(signal, "oof"), "oof")
    for tail in cfg["z_tails"]:
        values = []
        for row in realized:
            value = _dict(_need(row, "tails"), "tails").get(tail)
            if value is not None:
                values.append(_number(value, f"tail.{tail}"))
        oof = _dict(_need(oof_all, tail), f"oof.{tail}")
        oof_point = _number(_need(oof, "point"), "oof.point")
        oof_low, oof_high = _number(_need(oof, "ci_low"), "oof.ci_low"), _number(_need(oof, "ci_high"), "oof.ci_high")
        tail_required = int(cfg["tail_min_days_with_names"][str(tail)])
        if len(values) < tail_required:
            details["tails"][tail] = {"n": len(values), "required": tail_required, "status": "too_few_days_with_names"}
            passed = False
            continue
        stats = hac_mean_ci(values, horizon - 1, level)
        same_sign = _sign(stats["mean"]) == _sign(oof_point) != 0
        overlap = stats["ci_low"] <= oof_high and oof_low <= stats["ci_high"]
        details["tails"][tail] = {**stats, "required": tail_required, "days_without_names": len(realized) - len(values),
                                  "oof": {"point": oof_point, "ci_low": oof_low, "ci_high": oof_high},
                                  "same_sign_as_oof": same_sign, "ci_overlaps_oof": overlap,
                                  "net_of_round_trip_cost_report_only": {
                                      "mean": stats["mean"] - cost, "ci_low": stats["ci_low"] - cost,
                                      "ci_high": stats["ci_high"] - cost, "clears_cost": stats["mean"] - cost > 0}}
        passed = passed and same_sign and overlap
    rhos = [_number(r["spearman"], "spearman") for r in realized if r.get("spearman") is not None]
    details["spearman_mean"] = sum(rhos) / len(rhos) if rhos else None
    by_state: dict[str, list[float]] = {}
    top = str(cfg["z_tails"][-1])
    for r in realized:
        if r.get("hmm_state") is not None and (r.get("tails") or {}).get(top) is not None:
            by_state.setdefault(str(r["hmm_state"]), []).append(float(r["tails"][top]))
    details["hmm_state_descriptive"] = {k: {"n": len(v), "mean": sum(v) / len(v)} for k, v in sorted(by_state.items())}
    return passed, details


def gate_net_excess(policy: dict, ev: dict, window: list[str]) -> tuple[bool, dict]:
    """G4: Paper net excess after cost from trading:config.fees; Paper account return reported alongside."""
    cost = _round_trip_cost(ev)
    lag = int(policy["signal"]["target_horizon_trading_days"]) - 1
    level = float(policy["signal"]["ci_level"])
    rows = _by_day(_need(ev, "net_excess_days"), "net_excess_days")
    missing = [d for d in window if d not in rows]
    if missing or not window:
        raise EvidenceError(f"net_excess_days_missing:{len(missing)}")
    net = [_number(_need(rows[d], "gross_excess"), "gross_excess")
           - _number(_need(rows[d], "one_way_turnover"), "one_way_turnover", minimum=0) * cost for d in window]
    primary = hac_mean_ci(net, lag, level)
    account = [rows[d].get("paper_account_return") for d in window]
    account_stats = (hac_mean_ci([_number(v, "paper_account_return") for v in account], lag, level)
                     if all(v is not None for v in account) else "unavailable")
    return primary["mean"] > 0, {"cost_per_one_way_turnover": cost, "net_excess": primary,
                                 "paper_account_return": account_stats}


def gate_allocator(policy: dict, ev: dict) -> tuple[bool, dict]:
    """G5: R13 replay and NEW-L08 conclusions carry Wei's decision record."""
    as_of = _day(_need(ev, "as_of"), "as_of")
    decisions = _dict(_need(ev, "allocator_decisions"), "allocator_decisions")
    out = {}
    for key in policy["allocator_decisions_required"]:
        row = decisions.get(key)
        out[key] = (isinstance(row, dict) and row.get("decided_by") == "wei"
                    and isinstance(row.get("receipt_ref"), str) and bool(row["receipt_ref"].strip())
                    and _day(row.get("decided_at"), key) <= as_of)
    return all(out.values()), out


_RECEIPT_CHECKS: dict[str, Callable[[dict], bool]] = {
    # T8: Wei's own Shioaji simulation run.
    "T8": lambda r: _is_sha(r.get("wei_receipt_sha256")),
    # T9: prod R17 pause/resume drill with the gateway submit flag at 0 and no order.
    "T9": lambda r: (_is_sha(r.get("receipt_sha256"))
                     and type(r.get("orders_submitted")) is int and r["orders_submitted"] == 0
                     and r.get("gateway_submit_flag") == "0"),
}


def gate_live_tests(policy: dict, ev: dict) -> tuple[bool, dict]:
    """G6: T1-T7 pass on the release SHA plus the T8/T9 receipts."""
    tests = _dict(_need(ev, "live_tests"), "live_tests")
    release = str(_need(tests, "release_sha"))
    results = _dict(_need(tests, "results"), "results")
    out: dict[str, Any] = {"release_sha_valid": bool(_GIT_SHA.fullmatch(release))}
    for key in policy["live_tests_required"]:
        row = results.get(key)
        out[key] = isinstance(row, dict) and row.get("status") == "pass" and row.get("release_sha") == release
    for key in policy["live_receipts_required"]:
        row, check = tests.get(key), _RECEIPT_CHECKS.get(key)
        out[key] = isinstance(row, dict) and check is not None and check(row)
    return all(out.values()), {"release_sha": release, **out}


def gate_config(policy: dict, ev: dict) -> tuple[bool, dict]:
    """G7: trading:live_config still reads paper, pause lines disabled, broker-NAV capital,
    a verified Live account observation and the frozen slippage band artifact."""
    config = _dict(_need(ev, "live_config"), "live_config")
    pause = config.get("pause")
    observation = _dict(_need(ev, "account_observation"), "account_observation")
    band = ev.get("slippage_band")
    out = {
        "mode_is_paper": config.get("mode") == "paper",
        "pause_lines_present_and_disabled": isinstance(pause, dict) and pause.get("enabled") is False,
        "capital_source_is_broker_nav": config.get("capital_source") == "broker_nav_authoritative_marks",
        "account_observation_verified": (
            observation.get("schema_version") == "live-account-observation-v1"
            and str(observation.get("account_scope") or "").startswith("live:sinopac:")
            and _is_sha(observation.get("sha256"))),
        "slippage_band_frozen": isinstance(band, dict) and _is_sha(band.get("artifact_sha256")),
    }
    refs = {"slippage_band_artifact_sha256": band["artifact_sha256"] if out["slippage_band_frozen"] else None,
            "account_observation_sha256": observation.get("sha256") if out["account_observation_verified"] else None}
    return all(out.values()), {**out, **refs}


GATES: list[tuple[str, Callable[..., tuple[bool, dict]], bool]] = [
    ("G2_health", gate_health, True), ("G3_signal", gate_signal, True), ("G4_net_excess", gate_net_excess, True),
    ("G5_allocator", gate_allocator, False), ("G6_live_tests", gate_live_tests, False), ("G7_config", gate_config, False),
]


def evaluate(policy: Any, evidence: Any, generated_at: datetime, expected_policy_sha256: str) -> dict[str, Any]:
    gates: dict[str, Any] = {}
    window: list[str] = []
    try:
        policy_sha = sha256_of(policy)
    except (TypeError, ValueError):
        policy_sha = None
    try:
        evidence_sha = sha256_of(evidence)
    except (TypeError, ValueError):  # NaN/Infinity anywhere in the bundle
        evidence_sha = None
        gates["evidence_canonical"] = {"status": "FAIL", "error": "evidence_not_canonical_json"}
    try:
        validate_policy(policy)
        if policy_sha is None or policy_sha != expected_policy_sha256:
            raise EvidenceError("policy_sha256_not_the_approved_one")
        if policy.get("status") != "frozen":
            raise EvidenceError("policy_not_frozen")
        gates["policy"] = {"status": "PASS"}
    except Exception as exc:  # noqa: BLE001 - every failure is a FAIL receipt
        gates["policy"] = {"status": "FAIL", "error": f"{type(exc).__name__}:{exc}"}
        policy = None
    if policy is not None:
        try:
            if not isinstance(evidence, dict) or evidence.get("schema_version") != "r4-gate-evidence-v1":
                raise EvidenceError("evidence_schema_invalid")
            passed, details, window = gate_identity(policy, evidence, generated_at)
            gates["G1_identity"] = {"status": "PASS" if passed else "FAIL", **details}
        except Exception as exc:  # noqa: BLE001
            gates["G1_identity"] = {"status": "FAIL", "error": f"{type(exc).__name__}:{exc}"}
            window = []
        for name, fn, needs_window in GATES:
            try:
                passed, details = fn(policy, evidence, window) if needs_window else fn(policy, evidence)
                gates[name] = {"status": "PASS" if passed else "FAIL", "details": details}
            except Exception as exc:  # noqa: BLE001
                gates[name] = {"status": "FAIL", "error": f"{type(exc).__name__}:{exc}"}
    as_of = evidence.get("as_of") if isinstance(evidence, dict) else None
    try:
        as_of = _day(as_of, "as_of")
    except EvidenceError:
        as_of = None
    receipt = {
        "schema_version": "live-gate-receipt-v1",
        "generated_at": generated_at.astimezone(timezone.utc).isoformat(),
        "as_of": as_of,
        "policy_sha256": policy_sha,
        "evidence_sha256": evidence_sha,
        "gates": gates,
        "overall": "PASS" if policy is not None and all(g["status"] == "PASS" for g in gates.values()) else "FAIL",
    }
    try:
        return {**receipt, "receipt_sha256": sha256_of(receipt)}
    except (TypeError, ValueError):  # a non-finite value leaked into details: minimal FAIL receipt
        minimal = {key: receipt[key] for key in ("schema_version", "generated_at", "as_of", "policy_sha256",
                                                  "evidence_sha256")}
        minimal.update(gates={"receipt": {"status": "FAIL", "error": "receipt_not_canonical_json"}}, overall="FAIL")
        return {**minimal, "receipt_sha256": sha256_of(minimal)}


def _strict_json(text: str) -> Any:
    def reject_constant(token: str) -> Any:
        raise EvidenceError(f"non_finite_json_constant:{token}")

    def unique(pairs: list[tuple[str, Any]]) -> dict:
        out: dict[str, Any] = {}
        for key, value in pairs:
            if key in out:
                raise EvidenceError(f"duplicate_json_key:{key}")
            out[key] = value
        return out

    def finite_float(token: str) -> float:
        value = float(token)
        if not math.isfinite(value):
            raise EvidenceError(f"non_finite_json_number:{token}")
        return value

    return json.loads(text, parse_constant=reject_constant, parse_float=finite_float, object_pairs_hook=unique)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--policy", default=DEFAULT_POLICY, type=Path)
    parser.add_argument("--expected-policy-sha256", required=True,
                        help="the sha recorded in DECISIONS; it must equal the committed approval file")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        policy = _strict_json(args.policy.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        policy = {"load_error": str(exc)}
    try:
        approved = DEFAULT_APPROVED_SHA.read_text(encoding="utf-8").strip()
    except OSError:
        approved = ""  # not frozen yet: every run fails the policy check
    try:
        evidence = _strict_json(args.evidence.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:  # still emit a FAIL receipt
        evidence = {"load_error": str(exc)}
    # Both the committed approval file and the operator's DECISIONS value must agree.
    expected = approved if approved and args.expected_policy_sha256.strip() == approved else ""
    receipt = evaluate(policy, evidence, datetime.now(timezone.utc), expected)
    text = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if receipt["overall"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
