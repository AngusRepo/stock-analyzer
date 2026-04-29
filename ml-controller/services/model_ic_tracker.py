"""Weekly model IC tracking and decay inputs.

This module owns the domain calculation behind /model_pool/compute_weekly_ic.
Routers should only load rows/pool objects and persist the result.
"""

from __future__ import annotations

import json
import math
from typing import Any

MANAGED_MODELS = (
    "XGBoost",
    "CatBoost",
    "ExtraTrees",
    "LightGBM",
    "FT-Transformer",
    "Chronos",
    "DLinear",
    "PatchTST",
    "KalmanFilter",
    "MarkovSwitching",
)


def tracked_model_names() -> tuple[str, ...]:
    challengers = tuple(f"{name}::challenger" for name in MANAGED_MODELS)
    return MANAGED_MODELS + challengers


def _as_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _safe_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if raw is None or raw == "":
        return {}
    try:
        parsed = json.loads(str(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def rank_score_from_prediction_row(row: dict[str, Any]) -> tuple[float | None, str]:
    """Return the score used for IC.

    Per-model rows write `forecast_data.rank_score`; older rows only have
    `direction_accuracy`. Prefer rank_score so IC measures rank alpha rather
    than a generic confidence field.
    """
    forecast = _safe_json(row.get("forecast_data"))
    score = _as_float(forecast.get("rank_score"))
    if score is not None:
        return score, "forecast_data.rank_score"
    score = _as_float(row.get("direction_accuracy"))
    if score is not None:
        return score, "direction_accuracy"
    return None, "missing"


def _rank_avg_ties(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(values):
        j = i
        while j + 1 < len(values) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j + 2) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def spearman_ic(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 2:
        return None
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    x_rank = _rank_avg_ties(xs)
    y_rank = _rank_avg_ties(ys)
    mx = sum(x_rank) / len(x_rank)
    my = sum(y_rank) / len(y_rank)
    num = sum((x_rank[i] - mx) * (y_rank[i] - my) for i in range(len(x_rank)))
    denx = math.sqrt(sum((x - mx) ** 2 for x in x_rank))
    deny = math.sqrt(sum((y - my) ** 2 for y in y_rank))
    if denx == 0 or deny == 0:
        return None
    return num / (denx * deny)


def compute_weekly_ic_from_rows(
    rows: list[dict[str, Any]],
    *,
    min_samples: int,
    all_tracked: tuple[str, ...] | None = None,
) -> dict[str, dict[str, Any]]:
    tracked = all_tracked or tracked_model_names()
    by_model: dict[str, list[tuple[float, float]]] = {name: [] for name in tracked}
    score_sources: dict[str, dict[str, int]] = {name: {} for name in tracked}

    for row in rows:
        model_name = str(row.get("model_name") or "")
        if model_name not in by_model:
            continue
        score, source = rank_score_from_prediction_row(row)
        actual = _as_float(row.get("actual_return_pct"))
        if score is None or actual is None:
            continue
        by_model[model_name].append((score, actual))
        source_counts = score_sources[model_name]
        source_counts[source] = source_counts.get(source, 0) + 1

    out: dict[str, dict[str, Any]] = {}
    for name in tracked:
        pairs = by_model[name]
        if len(pairs) < min_samples:
            out[name] = {
                "status": "insufficient_samples",
                "n_samples": len(pairs),
                "score_sources": score_sources[name],
            }
            continue
        ic = spearman_ic(pairs)
        out[name] = {
            "status": "computed",
            "ic": round(ic, 6) if ic is not None else None,
            "n_samples": len(pairs),
            "score_sources": score_sources[name],
        }
    return out


def apply_weekly_ic_to_pool(
    pool: dict[str, Any],
    per_model_ic: dict[str, dict[str, Any]],
    *,
    history_max: int,
) -> tuple[dict[str, dict[str, Any]], bool]:
    """Mutate model_pool dict with computed IC values."""
    pool_changes: dict[str, dict[str, Any]] = {}
    changed = False

    for tracked_name, info in per_model_ic.items():
        is_challenger = tracked_name.endswith("::challenger")
        base_name = tracked_name.replace("::challenger", "")
        entry = (pool.get("models") or {}).get(base_name)
        if not entry:
            continue
        target = entry.get("challenger") if is_challenger else entry
        if target is None:
            continue

        target["last_ic_status"] = info.get("status") or ("computed" if info.get("ic") is not None else "unknown")
        target["last_ic_sample_count"] = int(info.get("n_samples") or 0)
        target["last_ic_score_sources"] = info.get("score_sources") or {}
        target["last_ic_error"] = info.get("error")

        ic = info.get("ic")
        if ic is None:
            pool_changes[tracked_name] = {
                "status": target["last_ic_status"],
                "n_samples": target["last_ic_sample_count"],
                "score_sources": target["last_ic_score_sources"],
                "history_len": len(target.get("weekly_ic") or []),
            }
            changed = True
            continue

        target.setdefault("weekly_ic", [])
        target["weekly_ic"].append(ic)
        if len(target["weekly_ic"]) > history_max:
            target["weekly_ic"] = target["weekly_ic"][-history_max:]
        last4 = target["weekly_ic"][-4:]
        target["ic_4w_avg"] = round(sum(last4) / len(last4), 6)
        target["consecutive_negative_weeks"] = (
            (target.get("consecutive_negative_weeks") or 0) + 1
            if ic < 0
            else 0
        )
        pool_changes[tracked_name] = {
            "ic": ic,
            "ic_4w_avg": target["ic_4w_avg"],
            "consecutive_negative_weeks": target["consecutive_negative_weeks"],
            "history_len": len(target["weekly_ic"]),
            "score_sources": info.get("score_sources") or {},
        }
        changed = True

    return pool_changes, changed
