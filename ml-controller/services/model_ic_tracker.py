"""Weekly model IC tracking and decay inputs.

This module owns the domain calculation behind /model_pool/compute_weekly_ic.
Routers should only load rows/pool objects and persist the result.
"""

from __future__ import annotations

import json
import math
import statistics
from typing import Any

ALPHA_PREDICTION_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)

EXPERIMENTAL_SHADOW_MODELS = (
    "ResidualMLP",
)

ACTIVE_ARTIFACT_CHALLENGER_MODELS = ALPHA_PREDICTION_MODELS

PRODUCTION_IC_SEGMENTS = {"LISTED", "OTC", "UNKNOWN"}
IC_EVALUATION_SEMANTIC_VERSION = "daily-cross-sectional-equal-date-v2"
IC_TARGET_SEMANTIC_VERSION = "next-session-open-to-fifth-session-close-v2"


def tracked_model_names() -> tuple[str, ...]:
    challengers = tuple(
        f"{name}::challenger"
        for name in (*ACTIVE_ARTIFACT_CHALLENGER_MODELS, *EXPERIMENTAL_SHADOW_MODELS)
    )
    return ALPHA_PREDICTION_MODELS + challengers


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


def _prediction_date(row: dict[str, Any]) -> str:
    value = str(row.get("prediction_date") or "").strip()
    return value[:10] if value else "UNKNOWN_DATE"


def _dedupe_prediction_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Keep the latest rerun for each stock/model/business-date observation."""
    passthrough: list[dict[str, Any]] = []
    latest: dict[tuple[str, str, str], dict[str, Any]] = {}
    dropped: dict[str, int] = {}
    for row in rows:
        model_name = str(row.get("model_name") or "")
        stock_id = row.get("stock_id")
        business_date = _prediction_date(row)
        if stock_id in (None, "") or business_date == "UNKNOWN_DATE" or not model_name:
            passthrough.append(row)
            continue
        key = (str(stock_id), model_name, business_date)
        previous = latest.get(key)
        ordering = (str(row.get("generated_at") or ""), int(row.get("id") or 0))
        previous_ordering = (
            str((previous or {}).get("generated_at") or ""),
            int((previous or {}).get("id") or 0),
        )
        if previous is None or ordering >= previous_ordering:
            if previous is not None:
                dropped[model_name] = dropped.get(model_name, 0) + 1
            latest[key] = row
        else:
            dropped[model_name] = dropped.get(model_name, 0) + 1
    return [*passthrough, *latest.values()], dropped


def _cross_sectional_ic_summary(
    dated_pairs: dict[str, list[tuple[float, float]]],
) -> dict[str, Any]:
    """Aggregate equal-weight daily cross-sectional rank IC.

    Pooling observations across dates lets broad market drift masquerade as
    stock-selection skill. Each date therefore contributes at most one IC.
    """
    daily_ic: dict[str, float] = {}
    undefined_dates: list[str] = []
    for business_date, pairs in sorted(dated_pairs.items()):
        value = spearman_ic(pairs)
        if value is None:
            undefined_dates.append(business_date)
        else:
            daily_ic[business_date] = value

    values = list(daily_ic.values())
    mean_ic = statistics.fmean(values) if values else None
    std_ic = statistics.stdev(values) if len(values) >= 2 else None
    return {
        "ic": mean_ic,
        "n_dates": len(values),
        "observed_dates": len(dated_pairs),
        "undefined_dates": undefined_dates,
        "daily_ic": {key: round(value, 6) for key, value in daily_ic.items()},
        "ic_std": round(std_ic, 6) if std_ic is not None else None,
        "icir": round(mean_ic / std_ic, 6) if mean_ic is not None and std_ic else None,
        "positive_ic_rate": (
            round(sum(value > 0 for value in values) / len(values), 6) if values else None
        ),
    }


def compute_weekly_ic_from_rows(
    rows: list[dict[str, Any]],
    *,
    min_samples: int,
    min_dates: int = 1,
    all_tracked: tuple[str, ...] | None = None,
) -> dict[str, dict[str, Any]]:
    rows, duplicate_rows_dropped = _dedupe_prediction_rows(rows)
    tracked = all_tracked or tracked_model_names()
    by_model: dict[str, list[tuple[float, float]]] = {name: [] for name in tracked}
    by_model_segment: dict[str, dict[str, list[tuple[float, float]]]] = {name: {} for name in tracked}
    by_model_date: dict[str, dict[str, list[tuple[float, float]]]] = {name: {} for name in tracked}
    by_model_segment_date: dict[str, dict[str, dict[str, list[tuple[float, float]]]]] = {
        name: {} for name in tracked
    }
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
            "label_semantic_mismatch_rows": 0,
            "label_lineage_invalid_rows": 0,
            "duplicate_rows_dropped": int(duplicate_rows_dropped.get(name, 0)),
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
        if (
            "verification_label_schema_version" in row
            and str(row.get("verification_label_schema_version") or "").strip()
            != IC_TARGET_SEMANTIC_VERSION
        ):
            diag["label_semantic_mismatch_rows"] += 1
            continue
        if "verification_label_schema_version" in row:
            label_entry = _as_float(row.get("verification_label_entry_price"))
            label_end = str(row.get("verification_label_end_date") or "").strip()
            label_known = str(row.get("verification_label_known_date") or "").strip()
            if (
                label_entry is None
                or label_entry <= 0
                or not label_end
                or not label_known
                or label_known < label_end
            ):
                diag["label_lineage_invalid_rows"] += 1
                continue
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
        business_date = _prediction_date(row)
        if segment in PRODUCTION_IC_SEGMENTS:
            by_model[model_name].append((score, actual))
            by_model_date[model_name].setdefault(business_date, []).append((score, actual))
            diag["production_rows"] += 1
        else:
            diag["non_production_rows"] += 1
        by_model_segment[model_name].setdefault(segment, []).append((score, actual))
        by_model_segment_date[model_name].setdefault(segment, {}).setdefault(
            business_date, []
        ).append((score, actual))
        source_counts = score_sources[model_name]
        source_counts[source] = source_counts.get(source, 0) + 1

    out: dict[str, dict[str, Any]] = {}
    for name in tracked:
        pairs = by_model[name]
        segment_diag: dict[str, dict[str, Any]] = {}
        for segment, segment_pairs in sorted(by_model_segment[name].items()):
            summary = _cross_sectional_ic_summary(by_model_segment_date[name][segment])
            segment_ic = summary["ic"]
            enough_dates = int(summary["n_dates"]) >= max(1, int(min_dates))
            segment_diag[segment] = {
                "status": (
                    "computed"
                    if segment_ic is not None and enough_dates
                    else "insufficient_dates" if segment_ic is not None
                    else "insufficient_samples" if len(segment_pairs) < 2 else "undefined_variance"
                ),
                "ic": round(segment_ic, 6) if segment_ic is not None and enough_dates else None,
                "n_samples": len(segment_pairs),
                **{key: value for key, value in summary.items() if key != "ic"},
            }
        diag = diagnostics[name]
        root_cause = "ok"
        if diag["raw_rows"] == 0:
            root_cause = "prediction_missing"
        elif diag["verified_rows"] == 0:
            root_cause = "verification_missing"
        elif diag["outcome_rows"] == 0:
            root_cause = (
                "label_semantic_mismatch"
                if diag["label_semantic_mismatch_rows"] > 0
                else "label_lineage_invalid"
                if diag["label_lineage_invalid_rows"] > 0
                else "outcome_missing"
            )
        elif diag["score_rows"] == 0:
            root_cause = "ranking_signal_missing"
        cross_sectional = _cross_sectional_ic_summary(by_model_date[name])
        evaluated_dates = sorted(cross_sectional["daily_ic"])
        evaluation_contract = {
            "semantic_version": IC_EVALUATION_SEMANTIC_VERSION,
            "metric": "spearman_rank_ic",
            "aggregation": "equal_weight_mean_of_daily_cross_sections",
            "dedupe_key": "stock_id+model_name+prediction_date_latest_generated_at",
            "target": "actual_return_pct",
            "target_semantic_version": IC_TARGET_SEMANTIC_VERSION,
            "min_samples": int(min_samples),
            "min_dates": max(1, int(min_dates)),
            "n_samples": len(pairs),
            "n_dates": int(cross_sectional["n_dates"]),
            "observed_start_date": evaluated_dates[0] if evaluated_dates else None,
            "observed_end_date": evaluated_dates[-1] if evaluated_dates else None,
        }
        if root_cause == "ok" and len(pairs) < min_samples:
            root_cause = "coverage_low"
        elif (
            root_cause == "ok"
            and cross_sectional["ic"] is not None
            and int(cross_sectional["n_dates"]) < max(1, int(min_dates))
        ):
            root_cause = "date_coverage_low"
        if len(pairs) < min_samples:
            out[name] = {
                "status": "insufficient_samples",
                "root_cause": root_cause,
                "n_samples": len(pairs),
                "evaluation_contract": evaluation_contract,
                **{key: value for key, value in cross_sectional.items() if key != "ic"},
                "diagnostics": diag,
                "score_sources": score_sources[name],
                "segments": segment_diag,
            }
            continue
        ic = cross_sectional["ic"]
        if ic is None:
            out[name] = {
                "status": "undefined_variance",
                "root_cause": "undefined_variance",
                "ic": None,
                "n_samples": len(pairs),
                "evaluation_contract": evaluation_contract,
                **{key: value for key, value in cross_sectional.items() if key != "ic"},
                "diagnostics": diag,
                "score_sources": score_sources[name],
                "segments": segment_diag,
                "error": "rank_score_or_actual_return_has_zero_cross_sectional_variance",
            }
            continue
        if int(cross_sectional["n_dates"]) < max(1, int(min_dates)):
            out[name] = {
                "status": "insufficient_dates",
                "root_cause": "date_coverage_low",
                "n_samples": len(pairs),
                "evaluation_contract": evaluation_contract,
                **{key: value for key, value in cross_sectional.items() if key != "ic"},
                "diagnostics": diag,
                "score_sources": score_sources[name],
                "segments": segment_diag,
            }
            continue
        out[name] = {
            "status": "computed",
            "root_cause": "ok",
            "ic": round(ic, 6),
            "n_samples": len(pairs),
            "evaluation_contract": evaluation_contract,
            **{key: value for key, value in cross_sectional.items() if key != "ic"},
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
        if not entry:
            continue
        target = entry.get("challenger") if is_challenger else entry
        if target is None:
            continue

        previous_semantic = str(target.get("last_ic_semantic_version") or "").strip()
        incoming_contract = info.get("evaluation_contract") or {}
        incoming_semantic = str(incoming_contract.get("semantic_version") or "").strip()
        semantic_migration = bool(
            incoming_semantic and previous_semantic != incoming_semantic
        )
        if semantic_migration:
            # A pooled-observation IC and an equal-date cross-sectional IC are
            # different estimators. Their histories must never be averaged.
            target["weekly_ic"] = []
            target["ic_4w_avg"] = None
            target["consecutive_negative_weeks"] = 0

        target["last_ic_status"] = info.get("status") or ("computed" if info.get("ic") is not None else "unknown")
        target["last_ic_sample_count"] = int(info.get("n_samples") or 0)
        target["last_ic_score_sources"] = info.get("score_sources") or {}
        target["last_ic_by_segment"] = info.get("segments") or {}
        target["last_ic_error"] = info.get("error")
        target["last_ic_root_cause"] = info.get("root_cause")
        target["last_ic_diagnostics"] = info.get("diagnostics") or {}
        target["last_ic_evaluation_contract"] = incoming_contract
        target["last_ic_semantic_version"] = target["last_ic_evaluation_contract"].get(
            "semantic_version"
        )

        ic = info.get("ic")
        if ic is None:
            pool_changes[tracked_name] = {
                "status": target["last_ic_status"],
                "root_cause": target["last_ic_root_cause"],
                "n_samples": target["last_ic_sample_count"],
                "diagnostics": target["last_ic_diagnostics"],
                "score_sources": target["last_ic_score_sources"],
                "segments": target["last_ic_by_segment"],
                "evaluation_contract": target["last_ic_evaluation_contract"],
                "semantic_migration": semantic_migration,
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
                "evaluation_contract": target["last_ic_evaluation_contract"],
                "semantic_migration": semantic_migration,
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
            "evaluation_contract": target["last_ic_evaluation_contract"],
            "semantic_migration": semantic_migration,
        }
        changed = True

    return pool_changes, changed
