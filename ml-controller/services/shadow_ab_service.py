"""Verified AB evidence for model-pool version-candidate promotion."""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Any

from services.legacy_prediction_namespace import (
    base_model_name,
    is_legacy_model_candidate_name,
    legacy_model_candidate_name,
)
from services.model_ic_tracker import ALPHA_PREDICTION_MODELS


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rank_avg_ties(values: list[float]) -> list[float]:
    n = len(values)
    order = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j + 2) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def _spearman(xs: list[float], ys: list[float]) -> float:
    if len(xs) != len(ys) or len(xs) < 2:
        return 0.0
    xr = _rank_avg_ties(xs)
    yr = _rank_avg_ties(ys)
    mx = sum(xr) / len(xr)
    my = sum(yr) / len(yr)
    num = sum((x - mx) * (y - my) for x, y in zip(xr, yr))
    denx = sum((x - mx) ** 2 for x in xr) ** 0.5
    deny = sum((y - my) ** 2 for y in yr) ** 0.5
    if denx == 0 or deny == 0:
        return 0.0
    return num / (denx * deny)


def evaluate_shadow_ab_rows(
    rows: list[dict[str, Any]],
    *,
    min_samples: int = 50,
    min_ic_lift: float = 0.0,
    min_challenger_ic: float = 0.0,
) -> dict[str, dict[str, Any]]:
    by_key: dict[tuple[Any, Any], dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        model_name = str(row.get("model_name") or "")
        if not model_name:
            continue
        base = base_model_name(model_name)
        key = (row.get("stock_id"), row.get("sample_date"))
        side = "challenger" if is_legacy_model_candidate_name(model_name) else "active"
        by_key[(base, key)][side] = row

    paired: dict[str, list[tuple[float, float, float]]] = defaultdict(list)
    for (base, _key), sides in by_key.items():
        active = sides.get("active")
        challenger = sides.get("challenger")
        if not active or not challenger:
            continue
        active_score = _as_float(active.get("direction_accuracy"))
        challenger_score = _as_float(challenger.get("direction_accuracy"))
        actual = _as_float(active.get("actual_return_pct"))
        if active_score is None or challenger_score is None or actual is None:
            continue
        paired[base].append((active_score, challenger_score, actual))

    out: dict[str, dict[str, Any]] = {}
    for model, triples in paired.items():
        active_scores = [x[0] for x in triples]
        challenger_scores = [x[1] for x in triples]
        actuals = [x[2] for x in triples]
        active_ic = _spearman(active_scores, actuals)
        challenger_ic = _spearman(challenger_scores, actuals)
        ic_lift = challenger_ic - active_ic
        failed: list[str] = []
        if len(triples) < min_samples:
            failed.append("candidate_min_samples")
        if challenger_ic < min_challenger_ic:
            failed.append("candidate_ic_floor")
        if ic_lift <= min_ic_lift:
            failed.append("candidate_ic_lift")
        out[model] = {
            "decision": "PASS" if not failed else "FAIL",
            "failed_gates": failed,
            "samples": len(triples),
            "active_ic": round(active_ic, 6),
            "challenger_ic": round(challenger_ic, 6),
            "ic_lift": round(ic_lift, 6),
            "min_samples": min_samples,
            "min_ic_lift": min_ic_lift,
            "min_challenger_ic": min_challenger_ic,
        }
    return out


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def load_shadow_ab_by_model(lookback_days: int = 90) -> dict[str, dict[str, Any]]:
    from services.d1_client import query

    alpha_csv = ",".join(f"'{m}'" for m in ALPHA_PREDICTION_MODELS)
    challenger_csv = ",".join(f"'{legacy_model_candidate_name(m)}'" for m in ALPHA_PREDICTION_MODELS)
    rows = query(
        f"""
        SELECT
            stock_id,
            prediction_date AS sample_date,
            model_name,
            direction_accuracy,
            actual_return_pct
        FROM predictions
        WHERE verified_at IS NOT NULL
          AND actual_return_pct IS NOT NULL
          AND direction_accuracy IS NOT NULL
          AND prediction_date >= date('now', ?)
          AND (
            model_name IN ({challenger_csv})
            OR model_name IN (
                {alpha_csv}
            )
          )
        """,
        [f"-{lookback_days} days"],
    )
    return evaluate_shadow_ab_rows(
        rows,
        min_samples=_env_int("PROMOTION_MIN_SHADOW_AB_SAMPLES", 50),
        min_ic_lift=_env_float("PROMOTION_MIN_SHADOW_IC_LIFT", 0.0),
        min_challenger_ic=_env_float("PROMOTION_MIN_SHADOW_CHALLENGER_IC", 0.0),
    )
