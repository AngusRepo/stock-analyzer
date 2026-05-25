"""Read-only Score V2 rollout replay/audit helpers.

This module compares legacy scalar ranking with canonical Score V2 ranking from
already materialized recommendation rows. It does not query or mutate D1.
"""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from typing import Any


SCORE_V2_VERSION = "score_v2"
SCORE_V2_COMPONENTS = ("mlEdge", "chipFlow", "technicalStructure", "fundamentalQuality", "newsTheme")
DEFAULT_ROLLOUT_GATE_POLICY = {
    "min_score_v2_coverage": 0.98,
    "max_missing_score_v2_count": 0,
    "max_invalid_legacy_score_count": 0,
    "min_top_overlap_ratio": 0.85,
    "max_drift_rows": 5,
    "required_nonzero_components": ("fundamentalQuality", "newsTheme"),
}


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _parse_score_v2(value: Any) -> dict[str, Any] | None:
    payload = value
    if isinstance(value, str):
        try:
            payload = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(payload, dict) or payload.get("version") != SCORE_V2_VERSION:
        return None
    components = payload.get("components")
    if not isinstance(components, dict):
        return None
    return payload


def _score_v2_final(payload: dict[str, Any]) -> float | None:
    final_score = _number(payload.get("finalScore"))
    if final_score is not None:
        return final_score
    return _number(payload.get("total"))


def _symbol(row: dict[str, Any], index: int) -> str:
    return str(row.get("symbol") or row.get("stock_id") or f"row_{index}").strip()


def _date(row: dict[str, Any]) -> str:
    return str(row.get("date") or row.get("run_date") or "unknown")[:10]


def _rank_maps(rows: list[dict[str, Any]], score_key: str) -> dict[str, int]:
    ranked = sorted(
        rows,
        key=lambda row: (
            -float(row[score_key]),
            int(_number(row.get("rank")) or 999999),
            str(row["_symbol"]),
        ),
    )
    return {row["_key"]: index + 1 for index, row in enumerate(ranked)}


def build_score_v2_readonly_replay_report(
    rows: list[dict[str, Any]],
    *,
    top_n: int = 10,
    divergence_threshold: float = 5.0,
) -> dict[str, Any]:
    """Compare legacy scalar score ranking with canonical Score V2 ranking."""

    normalized: list[dict[str, Any]] = []
    component_values: dict[str, list[float]] = {name: [] for name in SCORE_V2_COMPONENTS}
    risk_flags = Counter()
    missing_score_v2 = 0
    invalid_legacy_score = 0

    for index, row in enumerate(rows):
        payload = _parse_score_v2(row.get("score_components") or row.get("score_v2"))
        legacy_score = _number(row.get("score"))
        if legacy_score is None:
            invalid_legacy_score += 1
            continue
        if payload is None:
            missing_score_v2 += 1
            continue
        score_v2_final = _score_v2_final(payload)
        if score_v2_final is None:
            missing_score_v2 += 1
            continue
        components = payload.get("components") or {}
        for name in SCORE_V2_COMPONENTS:
            value = _number(components.get(name))
            if value is not None:
                component_values[name].append(value)
        for flag in payload.get("riskFlags") or []:
            risk_flags[str(flag)] += 1
        symbol = _symbol(row, index)
        date = _date(row)
        normalized.append({
            **row,
            "_key": f"{date}:{symbol}:{index}",
            "_date": date,
            "_symbol": symbol,
            "_legacy_score": legacy_score,
            "_score_v2_final": score_v2_final,
            "_score_delta": _round(score_v2_final - legacy_score, 4),
        })

    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in normalized:
        by_date[row["_date"]].append(row)

    date_reports: list[dict[str, Any]] = []
    drift_rows: list[dict[str, Any]] = []
    for date, date_rows in sorted(by_date.items()):
        legacy_rank = _rank_maps(date_rows, "_legacy_score")
        score_v2_rank = _rank_maps(date_rows, "_score_v2_final")
        legacy_top = set(list(legacy_rank.keys())[: max(1, top_n)])
        score_v2_top = set(list(score_v2_rank.keys())[: max(1, top_n)])
        overlap_denominator = max(1, min(len(legacy_top), len(score_v2_top)))
        rank_deltas = []
        for row in date_rows:
            legacy = legacy_rank[row["_key"]]
            score_v2 = score_v2_rank[row["_key"]]
            delta = score_v2 - legacy
            rank_deltas.append(abs(delta))
            if abs(delta) >= 3 or abs(row["_score_delta"]) >= divergence_threshold:
                drift_rows.append({
                    "date": date,
                    "symbol": row["_symbol"],
                    "legacy_rank": legacy,
                    "score_v2_rank": score_v2,
                    "rank_delta": delta,
                    "legacy_score": _round(row["_legacy_score"], 2),
                    "score_v2_final": _round(row["_score_v2_final"], 2),
                    "score_delta": _round(row["_score_delta"], 2),
                })
        date_reports.append({
            "date": date,
            "row_count": len(date_rows),
            "top_n": top_n,
            "top_overlap_ratio": _round(len(legacy_top & score_v2_top) / overlap_denominator, 4),
            "avg_abs_rank_delta": _round(sum(rank_deltas) / max(1, len(rank_deltas)), 4),
            "max_abs_rank_delta": max(rank_deltas) if rank_deltas else 0,
        })

    component_summary = {
        name: {
            "avg": _round(sum(values) / len(values), 4) if values else 0.0,
            "coverage": len(values),
        }
        for name, values in component_values.items()
    }
    drift_rows.sort(key=lambda row: (abs(row["rank_delta"]), abs(row["score_delta"])), reverse=True)
    warnings: list[str] = []
    if missing_score_v2:
        warnings.append("missing_score_v2_rows")
    if invalid_legacy_score:
        warnings.append("invalid_legacy_score_rows")

    return {
        "schema_version": "score-v2-readonly-replay-audit-v1",
        "mode": "read_only",
        "row_count": len(rows),
        "valid_comparison_rows": len(normalized),
        "missing_score_v2_count": missing_score_v2,
        "invalid_legacy_score_count": invalid_legacy_score,
        "score_v2_coverage": _round(len(normalized) / max(1, len(rows)), 4),
        "top_n": top_n,
        "date_reports": date_reports,
        "component_summary": component_summary,
        "risk_flag_counts": dict(sorted(risk_flags.items())),
        "drift_rows": drift_rows[:50],
        "warnings": warnings,
    }


def _gate_check(
    checks: list[dict[str, Any]],
    *,
    check_id: str,
    passed: bool,
    value: Any,
    threshold: Any,
    details: dict[str, Any] | None = None,
) -> None:
    checks.append({
        "id": check_id,
        "passed": bool(passed),
        "value": value,
        "threshold": threshold,
        **({"details": details} if details else {}),
    })


def evaluate_score_v2_rollout_gate(
    report: dict[str, Any],
    *,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fail-closed readiness gate for switching runtime owners to Score V2."""

    gate_policy = {**DEFAULT_ROLLOUT_GATE_POLICY, **(policy or {})}
    checks: list[dict[str, Any]] = []

    valid_rows = int(_number(report.get("valid_comparison_rows")) or 0)
    row_count = int(_number(report.get("row_count")) or 0)
    score_v2_coverage = _number(report.get("score_v2_coverage")) or 0.0
    missing_score_v2_count = int(_number(report.get("missing_score_v2_count")) or 0)
    invalid_legacy_score_count = int(_number(report.get("invalid_legacy_score_count")) or 0)
    drift_rows = report.get("drift_rows") if isinstance(report.get("drift_rows"), list) else []
    date_reports = report.get("date_reports") if isinstance(report.get("date_reports"), list) else []
    component_summary = report.get("component_summary") if isinstance(report.get("component_summary"), dict) else {}

    _gate_check(
        checks,
        check_id="valid_comparison_rows",
        passed=row_count > 0 and valid_rows > 0,
        value=valid_rows,
        threshold="> 0",
        details={"row_count": row_count},
    )
    _gate_check(
        checks,
        check_id="score_v2_coverage",
        passed=score_v2_coverage >= float(gate_policy["min_score_v2_coverage"]),
        value=_round(score_v2_coverage, 4),
        threshold=gate_policy["min_score_v2_coverage"],
    )
    _gate_check(
        checks,
        check_id="missing_score_v2_count",
        passed=missing_score_v2_count <= int(gate_policy["max_missing_score_v2_count"]),
        value=missing_score_v2_count,
        threshold=f"<= {gate_policy['max_missing_score_v2_count']}",
    )
    _gate_check(
        checks,
        check_id="invalid_legacy_score_count",
        passed=invalid_legacy_score_count <= int(gate_policy["max_invalid_legacy_score_count"]),
        value=invalid_legacy_score_count,
        threshold=f"<= {gate_policy['max_invalid_legacy_score_count']}",
    )

    top_overlap_values = [
        _number(item.get("top_overlap_ratio"))
        for item in date_reports
        if isinstance(item, dict) and _number(item.get("top_overlap_ratio")) is not None
    ]
    min_top_overlap = min(top_overlap_values) if top_overlap_values else 0.0
    _gate_check(
        checks,
        check_id="top_overlap_ratio",
        passed=bool(top_overlap_values) and min_top_overlap >= float(gate_policy["min_top_overlap_ratio"]),
        value=_round(min_top_overlap, 4),
        threshold=gate_policy["min_top_overlap_ratio"],
        details={"dates_checked": len(top_overlap_values)},
    )
    _gate_check(
        checks,
        check_id="drift_rows",
        passed=len(drift_rows) <= int(gate_policy["max_drift_rows"]),
        value=len(drift_rows),
        threshold=f"<= {gate_policy['max_drift_rows']}",
    )

    for component in gate_policy["required_nonzero_components"]:
        summary = component_summary.get(component) if isinstance(component_summary, dict) else None
        component_avg = _number(summary.get("avg")) if isinstance(summary, dict) else None
        component_coverage = int(_number(summary.get("coverage")) or 0) if isinstance(summary, dict) else 0
        _gate_check(
            checks,
            check_id=f"component_nonzero_{component}",
            passed=component_avg is not None and component_avg > 0 and component_coverage > 0,
            value={"avg": _round(component_avg or 0.0, 4), "coverage": component_coverage},
            threshold={"avg": "> 0", "coverage": "> 0"},
        )

    failed_gates = [check["id"] for check in checks if not check["passed"]]
    passed = not failed_gates
    return {
        "schema_version": "score-v2-rollout-gate-v1",
        "mode": "read_only",
        "decision": "PASS" if passed else "BLOCK",
        "passed": passed,
        "failed_gates": failed_gates,
        "checks": checks,
        "policy": gate_policy,
        "allowed_next_action": "cutover_candidate" if passed else "read_only_repair_before_cutover",
    }
