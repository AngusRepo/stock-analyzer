"""Build allocator EV fusion artifacts from verified recommendation outcomes."""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
from typing import Any, Callable

from services.allocator_ev_fusion import _s12_execution_ready, _s12_multiplier, _target_quality_numeric, _target_quality_state
from services.l4_alpha_ev_resolver import (
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
    SNAPSHOT_BACKFILL_USAGE_SCOPE,
    extract_l4_alpha_ev,
)
from services.s12_trade_ev import extract_s12_trade_ev


SELECTION_FEATURE_NAMES = [
    "l4_expected_return",
    "market_heat_expected_return",
]
EXECUTION_FEATURE_NAMES = [
    "s12_trade_expected_return",
    "s12_execution_ready",
    "s12_context_multiplier",
    "s12_target_quality_score",
    "l4_s12_edge_agreement",
]
FEATURE_NAMES = list(dict.fromkeys([*SELECTION_FEATURE_NAMES, *EXECUTION_FEATURE_NAMES]))

PRIMARY_MIN_DATES = 20
PRIMARY_MIN_SAMPLES = 1500
PRIMARY_MIN_S12_AVAILABLE_SAMPLES = 300
PRIMARY_MIN_S12_AVAILABLE_DATES = 8
ASSISTIVE_MIN_DATES = 5
ASSISTIVE_MIN_SAMPLES = 500


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _corr(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    xm = _mean(xs)
    ym = _mean(ys)
    xv = sum((x - xm) ** 2 for x in xs)
    yv = sum((y - ym) ** 2 for y in ys)
    if xv <= 0 or yv <= 0:
        return None
    cov = sum((x - xm) * (y - ym) for x, y in zip(xs, ys, strict=True))
    return cov / math.sqrt(xv * yv)


def _row_for_extractors(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    allocation = _loads(row.get("alpha_allocation"))
    forecast_data = _loads(row.get("forecast_data"))
    for source in (allocation, forecast_data):
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction", "s12_trade_ev"):
            if isinstance(source.get(key), dict) and key not in out:
                out[key] = source[key]
        fusion = source.get("allocator_ev_fusion") if isinstance(source.get("allocator_ev_fusion"), dict) else {}
        if fusion:
            if isinstance(fusion.get("l4_alpha_ev"), dict) and "l4_alpha_ev" not in out:
                out["l4_alpha_ev"] = fusion["l4_alpha_ev"]
            if isinstance(fusion.get("s12_trade_ev"), dict) and "s12_trade_ev" not in out:
                out["s12_trade_ev"] = fusion["s12_trade_ev"]
    return out


def _market_heat(row: dict[str, Any]) -> float:
    allocation = _loads(row.get("alpha_allocation"))
    alpha_context = _loads(row.get("alpha_context"))
    forecast_data = _loads(row.get("forecast_data"))
    for value in (
        row.get("market_heat_expected_return"),
        allocation.get("market_heat_expected_return"),
        alpha_context.get("market_heat_expected_return"),
        forecast_data.get("market_heat_expected_return"),
    ):
        number = _float_or_none(value)
        if number is not None:
            return max(0.0, number)
    return 0.0


def _l4_usage_scope(row: dict[str, Any]) -> str:
    if (
        str(row.get("allocator_ev_feature_snapshot_source") or "").strip() == SNAPSHOT_BACKFILL_SOURCE
        and str(row.get("allocator_ev_feature_snapshot_guard") or "").strip()
        == SNAPSHOT_BACKFILL_AS_OF_GUARD
    ):
        return SNAPSHOT_BACKFILL_USAGE_SCOPE
    return "production"


def _date_strictly_before(left: Any, right: Any) -> bool:
    try:
        return date.fromisoformat(str(left)[:10]) < date.fromisoformat(str(right)[:10])
    except (TypeError, ValueError):
        return False


def _feature_vector(row: dict[str, Any]) -> dict[str, float] | None:
    extractor_row = _row_for_extractors(row)
    usage_scope = _l4_usage_scope(row)
    l4_value, _l4_source, _l4_payload = extract_l4_alpha_ev(
        extractor_row,
        usage_scope=usage_scope,
    )
    if usage_scope == SNAPSHOT_BACKFILL_USAGE_SCOPE and (
        not isinstance(_l4_payload, dict)
        or not _date_strictly_before(_l4_payload.get("trained_until"), row.get("prediction_date"))
    ):
        return None
    s12_value, _s12_source, s12_payload = extract_s12_trade_ev(extractor_row)
    if l4_value is None:
        return None
    s12_available = 1.0
    if s12_value is None:
        if not isinstance(s12_payload, dict):
            return None
        s12_value = 0.0
        s12_available = 0.0
    target_state = _target_quality_state(s12_payload)
    return {
        "l4_expected_return": float(l4_value),
        "s12_trade_expected_return": float(s12_value),
        "s12_available": s12_available,
        "s12_execution_ready": _s12_execution_ready(s12_payload),
        "s12_context_multiplier": _s12_multiplier(s12_payload),
        "s12_target_quality_score": _target_quality_numeric(target_state),
        "market_heat_expected_return": _market_heat(row),
        "l4_s12_edge_agreement": 1.0 if (l4_value > 0 and s12_value > 0) or (l4_value <= 0 and s12_value <= 0) else 0.0,
    }


def _bounded_return(row: dict[str, Any], key: str) -> float | None:
    value = _float_or_none(row.get(key))
    return value if value is not None and -1.0 < value < 1.0 else None


def _samples(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    out: list[dict[str, Any]] = []
    invalid = 0
    missing_features = 0
    for row in rows:
        features = _feature_vector(row)
        selection_target = _bounded_return(row, "actual_return_pct")
        if features is None:
            missing_features += 1
            invalid += 1
            continue
        if selection_target is None:
            invalid += 1
            continue
        day = str(row.get("prediction_date") or row.get("date") or "")[:10] or "unknown"
        replay_target = _bounded_return(row, "s12_replay_pnl_pct")
        actual_trade_target = _bounded_return(row, "trade_pnl_pct")
        trade_target = replay_target if replay_target is not None else actual_trade_target
        replay_status = str(row.get("s12_replay_status") or "").strip().lower()
        execution_observed = bool(replay_status) or actual_trade_target is not None
        s12_available = float(features.get("s12_available") or 0.0) > 0.0
        execution_target = (
            trade_target - selection_target
            if s12_available and trade_target is not None
            else None
        )
        out.append({
            "date": day,
            "symbol": row.get("symbol"),
            "market_segment": str(row.get("market_segment") or "UNKNOWN").strip() or "UNKNOWN",
            "sector": str(row.get("sector") or "UNKNOWN").strip() or "UNKNOWN",
            "features": features,
            "target": selection_target,
            "actual_return_target": selection_target,
            "selection_target": selection_target,
            "trade_target": trade_target,
            "execution_target": execution_target,
            "execution_probability_target": (
                1.0 if trade_target is not None else 0.0
            ) if s12_available and execution_observed else None,
            "execution_label_source": (
                "s12_replay_trade_outcomes"
                if replay_target is not None
                else "predictions_trade_pnl_pct"
                if actual_trade_target is not None
                else "s12_replay_non_execution"
                if replay_status
                else None
            ),
        })
    by_day: dict[str, list[dict[str, Any]]] = {}
    by_day_segment: dict[tuple[str, str], list[dict[str, Any]]] = {}
    by_day_sector: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for sample in out:
        by_day.setdefault(sample["date"], []).append(sample)
        by_day_segment.setdefault((sample["date"], sample["market_segment"]), []).append(sample)
        by_day_sector.setdefault((sample["date"], sample["sector"]), []).append(sample)
    for day, day_samples in by_day.items():
        day_mean = _mean([float(sample["actual_return_target"]) for sample in day_samples])
        for sample in day_samples:
            segment_samples = by_day_segment.get((day, sample["market_segment"]), [])
            sector_samples = by_day_sector.get((day, sample["sector"]), [])
            benchmark = (
                _mean([float(item["actual_return_target"]) for item in sector_samples])
                if sample["sector"] != "UNKNOWN" and len(sector_samples) >= 5
                else _mean([float(item["actual_return_target"]) for item in segment_samples])
                if sample["market_segment"] != "UNKNOWN" and len(segment_samples) >= 5
                else day_mean
            )
            sample["selection_target"] = float(sample["actual_return_target"]) - benchmark
            sample["target"] = sample["selection_target"]
        ranked = sorted(day_samples, key=lambda item: (float(item["selection_target"]), str(item.get("symbol") or "")))
        denominator = max(1, len(ranked) - 1)
        for idx, sample in enumerate(ranked):
            sample["selection_rank_target"] = (idx / denominator) - 0.5 if len(ranked) > 1 else 0.0
    s12_ready_count = sum(
        1
        for sample in out
        if float(sample["features"].get("s12_execution_ready") or 0.0) > 0.0
    )
    s12_available_count = sum(
        1
        for sample in out
        if float(sample["features"].get("s12_available") or 0.0) > 0.0
    )
    execution_samples = [sample for sample in out if sample["execution_target"] is not None]
    execution_observation_samples = [
        sample for sample in out if sample["execution_probability_target"] is not None
    ]
    return out, {
        "input_rows": len(rows),
        "sample_count": len(out),
        "invalid_rows": invalid,
        "missing_feature_rows": missing_features,
        "date_count": len({row["date"] for row in out}),
        "s12_ready_count": s12_ready_count,
        "s12_available_count": s12_available_count,
        "s12_available_date_count": len({row["date"] for row in out if row["features"]["s12_available"] > 0.0}),
        "execution_sample_count": len(execution_samples),
        "execution_date_count": len({row["date"] for row in execution_samples}),
        "execution_observation_count": len(execution_observation_samples),
        "execution_observation_date_count": len({row["date"] for row in execution_observation_samples}),
        "execution_label_source_counts": {
            source: sum(1 for row in out if row.get("execution_label_source") == source)
            for source in sorted({str(row.get("execution_label_source")) for row in out if row.get("execution_label_source")})
        },
        "s12_ready_coverage": round(s12_ready_count / len(out), 8) if out else 0.0,
        "s12_available_coverage": round(s12_available_count / len(out), 8) if out else 0.0,
        "target_policy": {
            "selection": "actual_return_pct",
            "execution_residual": "canonical_s12_replay_pnl_then_actual_trade_pnl_minus_actual_return_pct",
            "execution_probability": "observed_s12_replay_or_actual_trade_execution_indicator",
            "rowwise_label_coalesce": False,
        },
    }


def _solve_linear_system(a: list[list[float]], b: list[float]) -> list[float] | None:
    n = len(b)
    mat = [row[:] + [b[idx]] for idx, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(mat[r][col]))
        if abs(mat[pivot][col]) < 1e-12:
            return None
        mat[col], mat[pivot] = mat[pivot], mat[col]
        scale = mat[col][col]
        mat[col] = [value / scale for value in mat[col]]
        for row in range(n):
            if row == col:
                continue
            factor = mat[row][col]
            if abs(factor) <= 1e-18:
                continue
            mat[row] = [value - factor * mat[col][idx] for idx, value in enumerate(mat[row])]
    return [mat[row][-1] for row in range(n)]


def _fit_ridge(
    samples: list[dict[str, Any]],
    *,
    l2: float,
    feature_names: list[str],
    target_key: str = "target",
) -> tuple[float, dict[str, float]]:
    p = len(feature_names) + 1
    xtx = [[0.0 for _ in range(p)] for _ in range(p)]
    xty = [0.0 for _ in range(p)]
    for sample in samples:
        x = [1.0, *[float(sample["features"][name]) for name in feature_names]]
        y = float(sample[target_key])
        for i in range(p):
            xty[i] += x[i] * y
            for j in range(p):
                xtx[i][j] += x[i] * x[j]
    for i in range(1, p):
        xtx[i][i] += l2
    solved = _solve_linear_system(xtx, xty)
    if solved is None:
        raise ValueError("allocator_ev_fusion_ridge_fit_singular_matrix")
    return solved[0], {name: solved[idx + 1] for idx, name in enumerate(feature_names)}


def _predict(sample: dict[str, Any], intercept: float, coefs: dict[str, float]) -> float:
    return intercept + sum(coef * float(sample["features"][name]) for name, coef in coefs.items())


def _linear_calibration(
    samples: list[dict[str, Any]],
    intercept: float,
    coefs: dict[str, float],
    *,
    target_key: str,
    l2: float,
) -> tuple[float, float]:
    xs = [_predict(sample, intercept, coefs) for sample in samples]
    ys = [float(sample[target_key]) for sample in samples]
    xm = _mean(xs)
    ym = _mean(ys)
    covariance = sum((x - xm) * (y - ym) for x, y in zip(xs, ys, strict=True))
    variance = sum((x - xm) ** 2 for x in xs) + max(0.0, l2)
    slope = covariance / variance if variance > 1e-12 else 0.0
    return ym - slope * xm, slope


def _compose_calibrated_model(
    intercept: float,
    coefs: dict[str, float],
    calibration_intercept: float,
    calibration_slope: float,
) -> tuple[float, dict[str, float]]:
    return (
        calibration_intercept + calibration_slope * intercept,
        {name: calibration_slope * value for name, value in coefs.items()},
    )


def _metrics(
    samples: list[dict[str, Any]],
    intercept: float,
    coefs: dict[str, float],
    *,
    target_key: str = "target",
) -> dict[str, Any]:
    if not samples:
        return {"samples": 0}
    pairs = [(_predict(sample, intercept, coefs), float(sample[target_key])) for sample in samples]
    preds = [item[0] for item in pairs]
    targets = [item[1] for item in pairs]
    errors = [pred - target for pred, target in pairs]
    ranked = sorted(pairs, key=lambda item: item[0])
    bucket = max(1, len(ranked) // 5)
    top = ranked[-bucket:]
    bottom = ranked[:bucket]
    top_returns = [target for _, target in top]
    bottom_returns = [target for _, target in bottom]
    spread = _mean(top_returns) - _mean(bottom_returns)
    spread_se = math.sqrt(
        (_sample_variance(top_returns) / max(1, len(top_returns)))
        + (_sample_variance(bottom_returns) / max(1, len(bottom_returns)))
    )
    corr = _corr(preds, targets)
    corr_lcb = None
    if corr is not None and len(samples) > 3 and abs(corr) < 1.0:
        corr_lcb = math.tanh(math.atanh(corr) - (1.645 / math.sqrt(len(samples) - 3)))
    return {
        "samples": len(samples),
        "mean_target": round(_mean(targets), 8),
        "mean_prediction": round(_mean(preds), 8),
        "mae": round(_mean([abs(err) for err in errors]), 8),
        "rmse": round(math.sqrt(_mean([err * err for err in errors])), 8),
        "prediction_target_corr": None if corr is None else round(corr, 8),
        "prediction_target_corr_lcb90": None if corr_lcb is None else round(corr_lcb, 8),
        "top_quintile_mean_return": round(_mean(top_returns), 8),
        "bottom_quintile_mean_return": round(_mean(bottom_returns), 8),
        "top_bottom_spread": round(spread, 8),
        "top_bottom_spread_lcb90": round(spread - 1.645 * spread_se, 8),
    }


def _sample_variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return sum((value - mean) ** 2 for value in values) / (len(values) - 1)


def _walk_forward(
    samples: list[dict[str, Any]],
    *,
    folds: int,
    l2: float,
    feature_names: list[str],
    target_key: str = "target",
    calibration_target_key: str | None = None,
) -> dict[str, Any]:
    dates = sorted({str(sample["date"]) for sample in samples})
    if len(dates) < folds + 1:
        return {"passed": False, "reason": "insufficient_dates", "folds": []}
    rows: list[dict[str, Any]] = []
    for fold in range(1, folds + 1):
        split_idx = max(1, round(len(dates) * fold / (folds + 1)))
        next_idx = max(split_idx + 1, round(len(dates) * (fold + 1) / (folds + 1)))
        train_dates = set(dates[:split_idx])
        test_dates = set(dates[split_idx:next_idx])
        train = [sample for sample in samples if sample["date"] in train_dates]
        test = [sample for sample in samples if sample["date"] in test_dates]
        if len(train) < len(feature_names) + 2 or not test:
            continue
        intercept, coefs = _fit_ridge(train, l2=l2, feature_names=feature_names, target_key=target_key)
        metrics_target_key = target_key
        if calibration_target_key:
            calibration_intercept, calibration_slope = _linear_calibration(
                train,
                intercept,
                coefs,
                target_key=calibration_target_key,
                l2=l2,
            )
            intercept, coefs = _compose_calibrated_model(
                intercept,
                coefs,
                calibration_intercept,
                calibration_slope,
            )
            metrics_target_key = calibration_target_key
        rows.append({"fold": fold, **_metrics(test, intercept, coefs, target_key=metrics_target_key)})
    if not rows:
        return {"passed": False, "reason": "no_valid_folds", "folds": []}
    positive_spread = sum(1 for row in rows if float(row.get("top_bottom_spread") or 0.0) > 0.0)
    positive_corr = sum(1 for row in rows if (row.get("prediction_target_corr") or 0.0) > 0.0)
    passed = positive_spread >= max(1, math.ceil(len(rows) * 0.5)) and positive_corr >= max(1, math.ceil(len(rows) * 0.5))
    return {
        "passed": passed,
        "reason": "ok" if passed else "walk_forward_not_stable",
        "fold_count": len(rows),
        "positive_spread_folds": positive_spread,
        "positive_corr_folds": positive_corr,
        "folds": rows,
    }


def _fit_expert(
    samples: list[dict[str, Any]],
    *,
    feature_names: list[str],
    target_key: str,
    min_samples: int,
    min_dates: int,
    l2: float,
    minimum_spread: float = 0.0,
    calibration_target_key: str | None = None,
) -> dict[str, Any]:
    dates = sorted({sample["date"] for sample in samples})
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
    train_dates = set(dates[:split_idx])
    test_dates = set(dates[split_idx:])
    train = [sample for sample in samples if sample["date"] in train_dates]
    test = [sample for sample in samples if sample["date"] in test_dates]
    blockers: list[str] = []
    if len(samples) < min_samples:
        blockers.append("insufficient_samples")
    if len(dates) < min_dates:
        blockers.append("insufficient_dates")
    if len(train) < len(feature_names) + 2 or not test:
        blockers.append("insufficient_train_test_split")
    intercept = 0.0
    coefs = {name: 0.0 for name in feature_names}
    train_metrics: dict[str, Any] = {"samples": len(train)}
    oos_metrics: dict[str, Any] = {"samples": len(test)}
    walk_forward: dict[str, Any] = {"passed": False, "reason": "not_run", "folds": []}
    if not blockers:
        rank_intercept, rank_coefs = _fit_ridge(
            train,
            l2=l2,
            feature_names=feature_names,
            target_key=target_key,
        )
        intercept, coefs = rank_intercept, rank_coefs
        metrics_target_key = target_key
        calibration_model = None
        if calibration_target_key:
            calibration_intercept, calibration_slope = _linear_calibration(
                train,
                rank_intercept,
                rank_coefs,
                target_key=calibration_target_key,
                l2=l2,
            )
            intercept, coefs = _compose_calibrated_model(
                rank_intercept,
                rank_coefs,
                calibration_intercept,
                calibration_slope,
            )
            metrics_target_key = calibration_target_key
            calibration_model = {
                "method": "oof_rank_score_linear_ev_calibration",
                "intercept": round(calibration_intercept, 10),
                "slope": round(calibration_slope, 10),
                "target": calibration_target_key,
            }
        train_metrics = _metrics(train, intercept, coefs, target_key=metrics_target_key)
        oos_metrics = _metrics(test, intercept, coefs, target_key=metrics_target_key)
        walk_forward = _walk_forward(
            samples,
            folds=4,
            l2=l2,
            feature_names=feature_names,
            target_key=target_key,
            calibration_target_key=calibration_target_key,
        )
        if (oos_metrics.get("prediction_target_corr_lcb90") or 0.0) <= 0.0:
            blockers.append("oos_prediction_target_corr_lcb90_not_positive")
        if float(oos_metrics.get("top_bottom_spread_lcb90") or 0.0) <= minimum_spread:
            blockers.append("oos_top_bottom_spread_lcb90_not_economic")
        if not walk_forward.get("passed"):
            blockers.append("walk_forward_not_stable")
    result = {
        "status": "fitted" if not blockers else "shadow",
        "decision": "PASS" if not blockers else "FAIL",
        "failed_gates": blockers,
        "sample_count": len(samples),
        "date_count": len(dates),
        "feature_names": feature_names,
        "target": target_key,
        "calibration_target": calibration_target_key,
        "promotion_confidence_level": 0.90,
        "minimum_economic_spread": round(minimum_spread, 8),
        "intercept": round(intercept, 10),
        "coefficients": {name: round(value, 10) for name, value in coefs.items()},
        "train_metrics": train_metrics,
        "oos_metrics": oos_metrics,
        "walk_forward": walk_forward,
    }
    if not blockers and calibration_target_key:
        result["rank_model"] = {
            "intercept": round(rank_intercept, 10),
            "coefficients": {name: round(value, 10) for name, value in rank_coefs.items()},
            "target": target_key,
        }
        result["calibration_model"] = calibration_model
    return result


def _fit_execution_probability_expert(
    samples: list[dict[str, Any]],
    *,
    l2: float,
) -> dict[str, Any]:
    targets = [float(sample["execution_probability_target"]) for sample in samples]
    dates = {sample["date"] for sample in samples}
    if (
        len(samples) >= PRIMARY_MIN_S12_AVAILABLE_SAMPLES
        and len(dates) >= PRIMARY_MIN_S12_AVAILABLE_DATES
        and targets
        and max(targets) - min(targets) <= 1e-12
    ):
        probability = _mean(targets)
        return {
            "status": "fitted",
            "decision": "PASS",
            "failed_gates": [],
            "sample_count": len(samples),
            "date_count": len(dates),
            "feature_names": EXECUTION_FEATURE_NAMES,
            "target": "execution_probability_target",
            "intercept": round(probability, 10),
            "coefficients": {name: 0.0 for name in EXECUTION_FEATURE_NAMES},
            "train_metrics": {
                "samples": len(samples),
                "mean_target": round(probability, 8),
                "brier_score": 0.0,
            },
            "oos_metrics": {
                "samples": len(samples),
                "mean_target": round(probability, 8),
                "brier_score": 0.0,
                "constant_probability": True,
            },
            "walk_forward": {
                "passed": True,
                "reason": "stable_constant_execution_probability",
                "folds": [],
            },
        }
    return _fit_expert(
        samples,
        feature_names=EXECUTION_FEATURE_NAMES,
        target_key="execution_probability_target",
        min_samples=PRIMARY_MIN_S12_AVAILABLE_SAMPLES,
        min_dates=PRIMARY_MIN_S12_AVAILABLE_DATES,
        l2=l2,
    )


def _promotion_tier(
    *,
    decision: str,
    diagnostics: dict[str, Any],
    oos_metrics: dict[str, Any],
    walk_forward: dict[str, Any],
    execution_model: dict[str, Any],
    execution_probability_model: dict[str, Any],
    min_dates: int,
    min_samples: int,
) -> tuple[str, list[str]]:
    blockers: list[str] = []
    sample_count = int(diagnostics.get("sample_count") or 0)
    date_count = int(diagnostics.get("date_count") or 0)
    execution_sample_count = int(diagnostics.get("execution_sample_count") or 0)
    execution_date_count = int(diagnostics.get("execution_date_count") or 0)
    top_mean = float(oos_metrics.get("top_quintile_mean_return") or 0.0)
    spread = float(oos_metrics.get("top_bottom_spread") or 0.0)
    corr = float(oos_metrics.get("prediction_target_corr") or 0.0)

    if decision != "PASS":
        return "shadow", ["validation_not_pass"]

    if sample_count < max(min_samples, PRIMARY_MIN_SAMPLES):
        blockers.append("primary_insufficient_samples")
    if date_count < max(min_dates, PRIMARY_MIN_DATES):
        blockers.append("primary_insufficient_dates")
    if execution_sample_count < PRIMARY_MIN_S12_AVAILABLE_SAMPLES:
        blockers.append("primary_s12_available_samples_low")
    if execution_date_count < PRIMARY_MIN_S12_AVAILABLE_DATES:
        blockers.append("primary_s12_available_dates_low")
    if execution_model.get("decision") != "PASS":
        blockers.append("primary_s12_execution_expert_not_validated")
    if execution_probability_model.get("decision") != "PASS":
        blockers.append("primary_s12_execution_probability_not_validated")
    if top_mean <= 0.0:
        blockers.append("primary_top_bucket_not_positive")
    if spread <= 0.0:
        blockers.append("primary_top_bottom_spread_not_positive")
    if corr <= 0.0:
        blockers.append("primary_oos_corr_not_positive")
    if not walk_forward.get("passed"):
        blockers.append("primary_walk_forward_not_stable")

    if not blockers:
        return "primary", []

    assistive_ok = (
        sample_count >= min(min_samples, ASSISTIVE_MIN_SAMPLES)
        and date_count >= min(min_dates, ASSISTIVE_MIN_DATES)
        and top_mean > 0.0
        and spread > 0.0
        and corr > 0.0
        and bool(walk_forward.get("passed"))
    )
    if assistive_ok:
        return "assistive", blockers
    return "shadow", blockers


def build_allocator_ev_fusion_artifact_from_rows(
    rows: list[dict[str, Any]],
    *,
    trained_until: str,
    lookback_days: int = 90,
    min_samples: int = 500,
    min_dates: int = 20,
    l2: float = 0.25,
    cost_model_bps: float = 18.0,
) -> dict[str, Any]:
    samples, diagnostics = _samples(rows)
    selection_model = _fit_expert(
        samples,
        feature_names=SELECTION_FEATURE_NAMES,
        target_key="selection_rank_target",
        min_samples=min_samples,
        min_dates=min_dates,
        l2=l2,
        minimum_spread=max(0.0, cost_model_bps) / 10000.0,
        calibration_target_key="selection_target",
    )
    execution_samples = [sample for sample in samples if sample["execution_target"] is not None]
    execution_observation_samples = [
        sample for sample in samples if sample["execution_probability_target"] is not None
    ]
    execution_probability_model = _fit_execution_probability_expert(
        execution_observation_samples,
        l2=l2,
    )
    execution_model = _fit_expert(
        execution_samples,
        feature_names=EXECUTION_FEATURE_NAMES,
        target_key="execution_target",
        min_samples=PRIMARY_MIN_S12_AVAILABLE_SAMPLES,
        min_dates=PRIMARY_MIN_S12_AVAILABLE_DATES,
        l2=l2,
    )
    decision = str(selection_model["decision"])
    promotion_tier, promotion_blockers = _promotion_tier(
        decision=decision,
        diagnostics=diagnostics,
        oos_metrics=selection_model["oos_metrics"],
        walk_forward=selection_model["walk_forward"],
        execution_model=execution_model,
        execution_probability_model=execution_probability_model,
        min_dates=min_dates,
        min_samples=min_samples,
    )
    validation_packet = {
        "schema_version": "allocator-ev-fusion-validation-packet-v4",
        "decision": decision,
        "failed_gates": selection_model["failed_gates"],
        "validation_scope": {
            "owner": "allocator_ev_fusion",
            "selection_target": "actual_return_pct",
            "execution_probability_target": "observed_replay_or_actual_trade_execution_indicator",
            "execution_target": "canonical_replay_or_actual_trade_pnl_minus_candidate_return_when_executed",
            "rowwise_label_coalesce": False,
            "method": "date_split_oos_plus_walk_forward",
            "lookback_days": lookback_days,
        },
        "sample_audit": diagnostics,
        "train_metrics": selection_model["train_metrics"],
        "oos_metrics": selection_model["oos_metrics"],
        "walk_forward": selection_model["walk_forward"],
        "selection_model": selection_model,
        "execution_model": execution_model,
        "execution_probability_model": execution_probability_model,
        "promotion": {
            "schema_version": "allocator-ev-fusion-promotion-v3",
            "tier": promotion_tier,
            "automatic": True,
            "failed_gates": promotion_blockers,
            "primary_requirements": {
                "min_dates": max(min_dates, PRIMARY_MIN_DATES),
                "min_samples": max(min_samples, PRIMARY_MIN_SAMPLES),
                "min_s12_available_samples": PRIMARY_MIN_S12_AVAILABLE_SAMPLES,
                "min_s12_available_dates": PRIMARY_MIN_S12_AVAILABLE_DATES,
                "s12_coverage_is_diagnostic_only": True,
                "execution_expert_validation_passed": True,
                "execution_probability_validation_passed": True,
                "top_bucket_return_positive": True,
                "top_bottom_spread_positive": True,
                "oos_corr_positive": True,
                "walk_forward_passed": True,
            },
        },
    }
    artifact = {
        "schema_version": "allocator-ev-fusion-artifact-v4",
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": (
            "production_primary" if promotion_tier == "primary"
            else "production_assistive" if promotion_tier == "assistive"
            else "shadow"
        ),
        "promotion_tier": promotion_tier,
        "primary_expected_return_allowed": promotion_tier == "primary",
        "assistive_expected_return_allowed": promotion_tier in {"assistive", "primary"},
        "promotion_blockers": promotion_blockers,
        "validation_packet": validation_packet,
        "resolver_method": "rank_calibrated_two_part_allocator_ev_fusion",
        "model_version": f"allocator-ev-fusion-rank-two-part-{trained_until.replace('-', '')}",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v3-rank-two-part",
        "trained_until": trained_until,
        "horizon_days": 5,
        "cost_model_bps": cost_model_bps,
        "output_is_net_of_costs": False,
        "feature_names": FEATURE_NAMES,
        "selection_model": selection_model,
        "execution_model": execution_model,
        "execution_probability_model": execution_probability_model,
        "intercept": selection_model["intercept"],
        "coefficients": {
            **selection_model["coefficients"],
            **{name: 0.0 for name in EXECUTION_FEATURE_NAMES},
        },
        "output_clip": {"min": -0.08, "max": 0.08},
        "training_data": {
            "source": "as-of L4/S12 snapshots joined to separate candidate-return and executed-trade outcomes",
            "trained_until": trained_until,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            **diagnostics,
        },
    }
    return {
        "status": "ok" if decision == "PASS" else "failed_validation",
        "artifact": artifact,
        "validation_packet": validation_packet,
    }


def load_allocator_ev_fusion_training_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    end_date: str,
    lookback_days: int = 90,
    limit: int = 6000,
) -> list[dict[str, Any]]:
    snapshot_rows: list[dict[str, Any]] = []
    snapshot_available = False
    try:
        snapshot_rows = query_fn(
            """
            SELECT
                p.stock_id,
                fs.symbol,
                date(p.prediction_date) AS prediction_date,
                fs.forecast_data,
                p.actual_return_pct,
                p.trade_pnl_pct,
                (
                    SELECT o.pnl_pct
                    FROM s12_replay_trade_outcomes o
                    WHERE o.symbol = fs.symbol
                      AND date(o.trade_date) = date(fs.snapshot_date)
                      AND o.sample_eligible = 1
                      AND o.pnl_pct IS NOT NULL
                    ORDER BY o.created_at DESC, o.id DESC
                    LIMIT 1
                ) AS s12_replay_pnl_pct,
                (
                    SELECT json_extract(o.detail_json, '$.status')
                    FROM s12_replay_trade_outcomes o
                    WHERE o.symbol = fs.symbol
                      AND date(o.trade_date) = date(fs.snapshot_date)
                    ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC
                    LIMIT 1
                ) AS s12_replay_status,
                fs.score,
                fs.score_components,
                fs.alpha_context,
                fs.alpha_allocation,
                fs.market_heat_expected_return,
                fs.market_segment,
                st.sector,
                fs.recommendation_lane,
                fs.snapshot_source AS allocator_ev_feature_snapshot_source,
                fs.as_of_guard AS allocator_ev_feature_snapshot_guard
            FROM allocator_ev_feature_snapshots fs
            JOIN predictions p
              ON p.stock_id = fs.stock_id
             AND p.prediction_date = fs.snapshot_date
             AND p.model_name = 'ensemble'
            JOIN stocks st
              ON st.id = fs.stock_id
            WHERE p.verified_at IS NOT NULL
              AND (p.actual_return_pct IS NOT NULL OR p.trade_pnl_pct IS NOT NULL)
              AND fs.alpha_allocation IS NOT NULL
              AND date(p.prediction_date) <= date(?)
              AND date(p.prediction_date) >= date(?, ?)
            ORDER BY date(p.prediction_date) ASC, fs.symbol ASC
            LIMIT ?
            """,
            [end_date, end_date, f"-{max(1, int(lookback_days))} days", int(limit)],
        )
        snapshot_available = True
    except Exception as exc:  # noqa: BLE001 - migration may not be deployed yet.
        if "allocator_ev_feature_snapshots" not in str(exc):
            raise

    daily_rows = query_fn(
        """
        SELECT
            p.stock_id,
            s.symbol,
            date(p.prediction_date) AS prediction_date,
            p.forecast_data,
            p.actual_return_pct,
            p.trade_pnl_pct,
            (
                SELECT o.pnl_pct
                FROM s12_replay_trade_outcomes o
                WHERE o.symbol = s.symbol
                  AND date(o.trade_date) = date(p.prediction_date)
                  AND o.sample_eligible = 1
                  AND o.pnl_pct IS NOT NULL
                ORDER BY o.created_at DESC, o.id DESC
                LIMIT 1
            ) AS s12_replay_pnl_pct,
            (
                SELECT json_extract(o.detail_json, '$.status')
                FROM s12_replay_trade_outcomes o
                WHERE o.symbol = s.symbol
                  AND date(o.trade_date) = date(p.prediction_date)
                ORDER BY o.sample_eligible DESC, o.created_at DESC, o.id DESC
                LIMIT 1
            ) AS s12_replay_status,
            dr.score,
            dr.score_components,
            dr.alpha_context,
            dr.alpha_allocation,
            NULL AS market_heat_expected_return,
            dr.market_segment,
            s.sector,
            dr.recommendation_lane
        FROM predictions p
        JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id
         AND dr.date = p.prediction_date
        JOIN stocks s
          ON s.id = p.stock_id
        WHERE p.model_name = 'ensemble'
          AND p.verified_at IS NOT NULL
          AND (p.actual_return_pct IS NOT NULL OR p.trade_pnl_pct IS NOT NULL)
          AND dr.alpha_allocation IS NOT NULL
          AND date(p.prediction_date) <= date(?)
          AND date(p.prediction_date) >= date(?, ?)
        ORDER BY date(p.prediction_date) ASC, s.symbol ASC
        LIMIT ?
        """,
        [end_date, end_date, f"-{max(1, int(lookback_days))} days", int(limit)],
    )
    if not snapshot_available or not snapshot_rows:
        return daily_rows

    seen = {
        (str(row.get("prediction_date") or "")[:10], str(row.get("stock_id") or ""))
        for row in snapshot_rows
    }
    merged = list(snapshot_rows)
    for row in daily_rows:
        key = (str(row.get("prediction_date") or "")[:10], str(row.get("stock_id") or ""))
        if key not in seen:
            merged.append(row)
            seen.add(key)
    return merged[: int(limit)]
