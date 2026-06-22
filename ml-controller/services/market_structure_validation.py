from __future__ import annotations

import json
from statistics import mean
from typing import Any


def _to_float(value: Any, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out and out not in (float("inf"), float("-inf")) else default


def _parse_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw or not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _structure_from_row(row: dict[str, Any]) -> dict[str, Any]:
    forecast = _parse_json(row.get("forecast_data"))
    ctx = forecast.get("alpha_context") if isinstance(forecast.get("alpha_context"), dict) else {}
    overlay = ctx.get("risk_overlay") if isinstance(ctx.get("risk_overlay"), dict) else {}
    structure = overlay.get("structure_detail") if isinstance(overlay.get("structure_detail"), dict) else {}
    if structure:
        return structure
    alpha_ctx = _parse_json(row.get("alpha_context"))
    overlay = alpha_ctx.get("risk_overlay") if isinstance(alpha_ctx.get("risk_overlay"), dict) else {}
    structure = overlay.get("structure_detail") if isinstance(overlay.get("structure_detail"), dict) else {}
    return structure if isinstance(structure, dict) else {}


def _location(row: dict[str, Any], structure: dict[str, Any]) -> str:
    explicit = str(structure.get("price_location") or row.get("price_location") or "").strip()
    if explicit:
        return explicit
    latest = _to_float(row.get("entry_price") or row.get("current_price") or structure.get("latest_close"))
    fair_low = _to_float(structure.get("fair_value_low"))
    fair_high = _to_float(structure.get("fair_value_high"))
    if latest is None or fair_low is None or fair_high is None:
        return "unknown"
    if latest < fair_low:
        return "below_fair_value"
    if latest > fair_high:
        return "above_fair_value"
    return "in_fair_value"


def _forward_return(row: dict[str, Any]) -> float | None:
    value = _to_float(row.get("forward_return"))
    if value is not None:
        return value
    entry = _to_float(row.get("entry_price") or row.get("current_price"))
    future = _to_float(row.get("future_close") or row.get("outcome_close"))
    if entry is None or future is None or entry <= 0:
        return None
    return (future - entry) / entry


def _coverage_hit(row: dict[str, Any], structure: dict[str, Any]) -> bool | None:
    future = _to_float(row.get("future_close") or row.get("outcome_close"))
    fair_low = _to_float(structure.get("fair_value_low"))
    fair_high = _to_float(structure.get("fair_value_high"))
    if future is None or fair_low is None or fair_high is None:
        return None
    return fair_low <= future <= fair_high


def _gate_active(row: dict[str, Any], structure: dict[str, Any]) -> bool:
    forecast = _parse_json(row.get("forecast_data"))
    ctx = forecast.get("alpha_context") if isinstance(forecast.get("alpha_context"), dict) else {}
    overlay = ctx.get("risk_overlay") if isinstance(ctx.get("risk_overlay"), dict) else {}
    flags = overlay.get("flags") if isinstance(overlay.get("flags"), list) else []
    if "extended_above_fair_value" in flags:
        return True
    volatility = str(overlay.get("volatility_level") or row.get("volatility_level") or "")
    return _location(row, structure) == "above_fair_value" and volatility in {"high", "extreme"}


def _stat(rows: list[dict[str, Any]]) -> dict[str, Any]:
    returns = [r["forward_return"] for r in rows if r.get("forward_return") is not None]
    coverage = [r["coverage_hit"] for r in rows if r.get("coverage_hit") is not None]
    return {
        "count": len(rows),
        "coverage_rate": round(sum(1 for hit in coverage if hit) / len(coverage), 4) if coverage else None,
        "avg_forward_return": round(mean(returns), 6) if returns else None,
        "hit_rate": round(sum(1 for value in returns if value > 0) / len(returns), 4) if returns else None,
        "avg_drawdown_proxy": round(mean([min(0.0, value) for value in returns]), 6) if returns else None,
    }


def validate_market_structure(rows: list[dict[str, Any]], *, min_samples: int = 30) -> dict[str, Any]:
    samples: list[dict[str, Any]] = []
    for row in rows:
        structure = _structure_from_row(row)
        if structure.get("structure_status") not in {None, "ok"}:
            continue
        location = _location(row, structure)
        fwd = _forward_return(row)
        coverage = _coverage_hit(row, structure)
        if location == "unknown" and fwd is None and coverage is None:
            continue
        samples.append({
            "symbol": row.get("symbol"),
            "location": location,
            "forward_return": fwd,
            "coverage_hit": coverage,
            "gate_active": _gate_active(row, structure),
        })

    if len(samples) < min_samples:
        return {
            "status": "skipped",
            "reason": "insufficient_market_structure_samples",
            "sample_count": len(samples),
            "required_samples": min_samples,
        }

    by_location: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        by_location.setdefault(sample["location"], []).append(sample)

    gated = [sample for sample in samples if sample["gate_active"]]
    non_gated = [sample for sample in samples if not sample["gate_active"]]
    above = by_location.get("above_fair_value", [])
    in_band = by_location.get("in_fair_value", [])
    below = by_location.get("below_fair_value", [])

    warnings: list[dict[str, Any]] = []
    above_stat = _stat(above)
    in_stat = _stat(in_band)
    if above and in_band and above_stat["avg_forward_return"] is not None and in_stat["avg_forward_return"] is not None:
        if above_stat["avg_forward_return"] >= in_stat["avg_forward_return"]:
            warnings.append({
                "level": "warning",
                "reason": "above_value_not_worse_than_in_band",
                "message": "above_fair_value did not show weaker forward return than in_fair_value in this sample.",
            })

    gated_stat = _stat(gated)
    non_gated_stat = _stat(non_gated)
    if gated and non_gated and gated_stat["avg_drawdown_proxy"] is not None and non_gated_stat["avg_drawdown_proxy"] is not None:
        if gated_stat["avg_drawdown_proxy"] < non_gated_stat["avg_drawdown_proxy"]:
            warnings.append({
                "level": "warning",
                "reason": "gate_group_has_worse_downside",
                "message": "extended-above-value gate group still has worse downside; penalty may need calibration.",
            })

    return {
        "status": "completed",
        "sample_count": len(samples),
        "overall": _stat(samples),
        "by_location": {
            "below_fair_value": _stat(below),
            "in_fair_value": _stat(in_band),
            "above_fair_value": above_stat,
        },
        "gate_stats": {
            "active": gated_stat,
            "inactive": non_gated_stat,
        },
        "warnings": warnings,
    }


def load_market_structure_rows(limit: int = 1000) -> list[dict[str, Any]]:
    """Load verified ensemble rows with market-structure evidence."""
    from services.d1_client import query as d1_query

    safe_limit = max(1, min(int(limit or 1000), 5000))
    return d1_query(
        """SELECT p.generated_at,
                  s.symbol,
                  p.forecast_data,
                  p.entry_price,
                  p.actual_return_pct,
                  p.trade_pnl_pct,
                  p.trade_pnl_r,
                  p.direction_correct
           FROM predictions p
           LEFT JOIN stocks s ON s.id = p.stock_id
           WHERE p.model_name='ensemble'
             AND p.forecast_data IS NOT NULL
             AND p.forecast_data LIKE '%structure_detail%'
             AND (
               p.actual_return_pct IS NOT NULL OR p.trade_pnl_pct IS NOT NULL
               OR p.trade_pnl_r IS NOT NULL OR p.direction_correct IN (0, 1)
             )
           ORDER BY p.generated_at DESC
           LIMIT ?""",
        [safe_limit],
    )
