"""Weekly model IC tracking and decay inputs.

This module owns the domain calculation behind /model_pool/compute_weekly_ic.
Routers should only load rows/pool objects and persist the result.
"""

from __future__ import annotations

import json
import math
from typing import Any

ALPHA_PREDICTION_MODELS = (
    "XGBoost",
    "CatBoost",
    "ExtraTrees",
    "LightGBM",
    "DLinear",
    "PatchTST",
)

FORMAL_LAYER3_MODELS = (
    "TabM",
    "GNN",
    "iTransformer",
    "TimesFM",
)

PRODUCTION_IC_SEGMENTS = {"LISTED", "OTC", "UNKNOWN"}


def tracked_model_names() -> tuple[str, ...]:
    return ALPHA_PREDICTION_MODELS + FORMAL_LAYER3_MODELS


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

    Per-model rows must write `forecast_data.rank_score`. Do not fall back to
    direction_accuracy because that column is a confidence/legacy compatibility
    field, not the ranking signal we want to audit.
    """
    forecast = _safe_json(row.get("forecast_data"))
    score = _as_float(forecast.get("rank_score"))
    if score is not None:
        return score, "forecast_data.rank_score"
    return None, "missing"


def market_segment_from_prediction_row(row: dict[str, Any]) -> str:
    forecast = _safe_json(row.get("forecast_data"))
    stock_meta = forecast.get("stock_meta")
    if isinstance(stock_meta, dict):
        segment = str(stock_meta.get("market_segment") or "").strip().upper()
        if segment:
            return segment
    return "UNKNOWN"


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
    by_model_segment: dict[str, dict[str, list[tuple[float, float]]]] = {name: {} for name in tracked}
    score_sources: dict[str, dict[str, int]] = {name: {} for name in tracked}
    diagnostics: dict[str, dict[str, int]] = {
        name: {
            "raw_rows": 0,
            "verified_rows": 0,
            "outcome_rows": 0,
            "score_rows": 0,
            "production_rows": 0,
            "non_production_rows": 0,
            "unverified_rows": 0,
            "missing_outcome_rows": 0,
            "missing_score_rows": 0,
        }
        for name in tracked
    }

    for row in rows:
        model_name = str(row.get("model_name") or "")
        if model_name not in by_model:
            continue
        diag = diagnostics[model_name]
        diag["raw_rows"] += 1
        if "verified_at" in row and not row.get("verified_at"):
            diag["unverified_rows"] += 1
            continue
        diag["verified_rows"] += 1
        score, source = rank_score_from_prediction_row(row)
        actual = _as_float(row.get("actual_return_pct"))
        if actual is None:
            diag["missing_outcome_rows"] += 1
        else:
            diag["outcome_rows"] += 1
        if score is None:
            diag["missing_score_rows"] += 1
        else:
            diag["score_rows"] += 1
        if score is None or actual is None:
            continue
        segment = market_segment_from_prediction_row(row)
        if segment in PRODUCTION_IC_SEGMENTS:
            by_model[model_name].append((score, actual))
            diag["production_rows"] += 1
        else:
            diag["non_production_rows"] += 1
        by_model_segment[model_name].setdefault(segment, []).append((score, actual))
        source_counts = score_sources[model_name]
        source_counts[source] = source_counts.get(source, 0) + 1

    out: dict[str, dict[str, Any]] = {}
    for name in tracked:
        pairs = by_model[name]
        segment_diag: dict[str, dict[str, Any]] = {}
        for segment, segment_pairs in sorted(by_model_segment[name].items()):
            segment_ic = spearman_ic(segment_pairs)
            segment_diag[segment] = {
                "status": (
                    "computed"
                    if segment_ic is not None
                    else "insufficient_samples" if len(segment_pairs) < 2 else "undefined_variance"
                ),
                "ic": round(segment_ic, 6) if segment_ic is not None else None,
                "n_samples": len(segment_pairs),
            }
        diag = diagnostics[name]
        root_cause = "ok"
        if diag["raw_rows"] == 0:
            root_cause = "prediction_missing"
        elif diag["verified_rows"] == 0:
            root_cause = "verification_missing"
        elif diag["outcome_rows"] == 0:
            root_cause = "outcome_missing"
        elif diag["score_rows"] == 0:
            root_cause = "ranking_signal_missing"
        elif len(pairs) < min_samples:
            root_cause = "coverage_low"
        if len(pairs) < min_samples:
            out[name] = {
                "status": "insufficient_samples",
                "root_cause": root_cause,
                "n_samples": len(pairs),
                "diagnostics": diag,
                "score_sources": score_sources[name],
                "segments": segment_diag,
            }
            continue
        ic = spearman_ic(pairs)
        if ic is None:
            out[name] = {
                "status": "undefined_variance",
                "root_cause": "undefined_variance",
                "ic": None,
                "n_samples": len(pairs),
                "diagnostics": diag,
                "score_sources": score_sources[name],
                "segments": segment_diag,
                "error": "rank_score_or_actual_return_has_zero_cross_sectional_variance",
            }
            continue
        out[name] = {
            "status": "computed",
            "root_cause": "ok",
            "ic": round(ic, 6),
            "n_samples": len(pairs),
            "diagnostics": diag,
            "score_sources": score_sources[name],
            "segments": segment_diag,
        }
    return out


def apply_weekly_ic_to_pool(
    pool: dict[str, Any],
    per_model_ic: dict[str, dict[str, Any]],
    *,
    history_max: int,
    append_history: bool = True,
) -> tuple[dict[str, dict[str, Any]], bool]:
    """Mutate model_pool dict with computed IC values."""
    pool_changes: dict[str, dict[str, Any]] = {}
    changed = False

    for tracked_name, info in per_model_ic.items():
        is_challenger = tracked_name.endswith("::challenger")
        base_name = tracked_name.replace("::challenger", "")
        entry = (pool.get("models") or {}).get(base_name)
        if not entry and not is_challenger:
            entry = (pool.get("formal_layer3_slots") or {}).get(base_name)
        if not entry:
            continue
        target = entry.get("challenger") if is_challenger else entry
        if target is None:
            continue

        target["last_ic_status"] = info.get("status") or ("computed" if info.get("ic") is not None else "unknown")
        target["last_ic_sample_count"] = int(info.get("n_samples") or 0)
        target["last_ic_score_sources"] = info.get("score_sources") or {}
        target["last_ic_by_segment"] = info.get("segments") or {}
        target["last_ic_error"] = info.get("error")
        target["last_ic_root_cause"] = info.get("root_cause")
        target["last_ic_diagnostics"] = info.get("diagnostics") or {}

        ic = info.get("ic")
        if ic is None:
            pool_changes[tracked_name] = {
                "status": target["last_ic_status"],
                "root_cause": target["last_ic_root_cause"],
                "n_samples": target["last_ic_sample_count"],
                "diagnostics": target["last_ic_diagnostics"],
                "score_sources": target["last_ic_score_sources"],
                "segments": target["last_ic_by_segment"],
                "history_len": len(target.get("weekly_ic") or []),
            }
            changed = True
            continue

        target["rolling_ic"] = ic
        if not append_history:
            pool_changes[tracked_name] = {
                "rolling_ic": ic,
                "status": target["last_ic_status"],
                "root_cause": target["last_ic_root_cause"],
                "n_samples": target["last_ic_sample_count"],
                "diagnostics": target["last_ic_diagnostics"],
                "score_sources": info.get("score_sources") or {},
                "segments": info.get("segments") or {},
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
            "root_cause": target["last_ic_root_cause"],
            "diagnostics": target["last_ic_diagnostics"],
            "history_len": len(target["weekly_ic"]),
            "score_sources": info.get("score_sources") or {},
            "segments": info.get("segments") or {},
        }
        changed = True

    return pool_changes, changed
