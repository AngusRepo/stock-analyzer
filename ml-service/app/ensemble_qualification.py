"""Independent ranking promotion and directional signal qualifications.

Derive assessments from immutable evidence; never rewrite legacy artifacts.
Directional failures are terminal assessments, not inference/lifecycle errors.
"""
from __future__ import annotations
import math
from typing import Any

QUALIFICATION_SCHEMA = "active8-ensemble-qualifications-v1"
MIN_DIRECTIONAL_ROWS = 200
MIN_DIRECTIONAL_DATES = 10
SIGNALS = ("BUY", "STRONG_BUY", "SELL", "STRONG_SELL")


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _mapping(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def assess_ensemble_qualifications(payload: dict) -> dict[str, Any]:
    validation = _mapping(payload.get("validation"))
    fit = _mapping(payload.get("fit"))
    calibration = _mapping(payload.get("calibration"))
    policy = _mapping(payload.get("signal_policy"))
    rank_blockers = []
    if validation.get("decision") != "PASS" or validation.get("failed_gates"):
        rank_blockers.append("ranking_validation_not_passed")
    for key in ("rank_ic_equal_date_market_lcb90", "top_bottom_net_return_spread_lcb90"):
        value = _number(validation.get(key))
        if value is None or value <= 0:
            rank_blockers.append(key + "_non_positive_or_missing")
    for key in ("validation_dates", "spread_dates"):
        value = _number(validation.get(key))
        if value is None or value < 5:
            rank_blockers.append(key + "_insufficient")

    coverages = {}
    calibration_blockers = []
    for name, key, coverage_key in (
        ("ordinary", "buy_interval_empirical_coverage", "buy_coverage"),
        ("strong", "strong_interval_empirical_coverage", "strong_coverage"),
    ):
        empirical = _number(validation.get(key))
        nominal = _number(policy.get(coverage_key))
        passed = empirical is not None and nominal is not None and 0 < nominal < 1 and nominal-.05 <= empirical <= 1
        coverages[name] = passed
        if not passed:
            calibration_blockers.append(name + "_interval_coverage_insufficient")

    coeff = fit.get("coefficients")
    intercept = _number(fit.get("intercept"))
    values = [_number(value) for value in coeff] if isinstance(coeff, list) else []
    valid_fit = len(values) == 16 and all(value is not None for value in values) and intercept is not None
    lower = intercept + sum(min(value, 0.) for value in values) if valid_fit else None
    upper = intercept + sum(max(value, 0.) for value in values) if valid_fit else None
    quantiles = _mapping(calibration.get("absolute_residual_quantiles"))
    evidence = _mapping(validation.get("directional_evidence"))
    signals = {}
    for signal in SIGNALS:
        strong = signal.startswith("STRONG_")
        buy = signal.endswith("BUY")
        nominal = _number(policy.get("strong_coverage" if strong else "buy_coverage"))
        width = _number(quantiles.get(str(float(nominal)))) if nominal is not None else None
        reachable = None if not valid_fit or width is None or width < 0 else (upper > width if buy else lower < -width)
        side = _mapping(evidence.get(signal))
        rows = _number(side.get("rows"))
        dates = _number(side.get("dates"))
        mean = _number(side.get("net_mean"))
        lcb = _number(side.get("date_net_mean_lcb90"))
        blockers = []
        if rank_blockers:
            blockers.append("ranking_not_qualified")
        if not coverages["strong" if strong else "ordinary"]:
            blockers.append("interval_calibration_not_qualified")
        if reachable is not True:
            blockers.append("signal_unreachable" if reachable is False else "signal_reachability_unknown")
        if rows is None or dates is None:
            blockers.append("directional_evidence_missing")
        elif rows < MIN_DIRECTIONAL_ROWS or dates < MIN_DIRECTIONAL_DATES:
            blockers.append("directional_evidence_insufficient")
        if mean is None or lcb is None or mean <= 0 or lcb <= 0:
            blockers.append("directional_net_edge_not_demonstrated")
        signals[signal] = {"decision": "BLOCKED" if blockers else "PASS", "blockers": blockers,
                           "reachable": reachable, "interval_halfwidth": width,
                           "rows": rows, "dates": dates, "net_mean": mean,
                           "date_net_mean_lcb90": lcb}
    allowed = [signal for signal in SIGNALS if signals[signal]["decision"] == "PASS"]
    return {"schema_version": QUALIFICATION_SCHEMA, "promotion_scope": "ranking",
            "ranking": {"decision": "FAIL" if rank_blockers else "PASS", "blockers": rank_blockers},
            "calibration": {"decision": "INSUFFICIENT" if calibration_blockers else "PASS",
                            "scope": "prediction_interval_coverage", "probability_status": "diagnostic_only",
                            "blockers": calibration_blockers},
            "directional": {"decision": "PASS" if allowed else "BLOCKED", "allowed_signals": allowed,
                            "signals": signals, "minimum_rows": MIN_DIRECTIONAL_ROWS,
                            "minimum_active_dates": MIN_DIRECTIONAL_DATES,
                            "relaxed_prediction_bounds": {"lower": lower, "upper": upper}},
            "evidence_source": "immutable_payload", "source_payload_checksum": payload.get("payload_checksum"),
            "legacy_evidence": validation.get("qualification_schema_version") != QUALIFICATION_SCHEMA}


def qualify_directional_signal(signal: str, payload: dict) -> dict[str, Any]:
    """Keep forecasts usable while restricting each unqualified direction."""
    unqualified_signal = signal
    qualification = assess_ensemble_qualifications(payload)
    allowed = qualification["directional"]["allowed_signals"]
    if signal not in allowed and signal != "HOLD":
        ordinary = signal.removeprefix("STRONG_")
        signal = ordinary if ordinary in allowed else "HOLD"
    blocked = qualification["directional"]["decision"] == "BLOCKED" or (unqualified_signal != "HOLD" and signal == "HOLD")
    blocked_signals = [unqualified_signal] if unqualified_signal != "HOLD" else list(SIGNALS)
    blockers = list(dict.fromkeys(
        reason for name in blocked_signals
        for reason in qualification["directional"]["signals"][name]["blockers"]
    )) if blocked else []
    return {"signal": signal, "unqualified_signal": unqualified_signal,
            "advisory_signal": unqualified_signal, "signal_role": "advisory_only",
            "final_decision_owner": "allocator_opb_policy",
            "signal_status": "policy_blocked" if blocked else "market_hold" if signal == "HOLD" else "qualified",
            "signal_blockers": blockers, "qualifications": qualification}
