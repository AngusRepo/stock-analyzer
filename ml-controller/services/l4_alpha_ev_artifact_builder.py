"""Build a validated formal L4 alpha EV artifact from verified outcomes."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Callable


FEATURE_NAMES = [
    "score_final_norm",
    "ensemble_avg_rank_centered",
    "ensemble_confidence_centered",
]
CANONICAL_SCORE_FEATURE_VERSION = "score_v2"
MIN_CROSS_SECTION_SAMPLES_PER_DATE = 20


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


def _component(score_components: dict[str, Any], name: str) -> float | None:
    components = score_components.get("components") if isinstance(score_components.get("components"), dict) else {}
    return _float_or_none(components.get(name))


def _feature_vector(row: dict[str, Any]) -> dict[str, float] | None:
    score_components = _loads(row.get("score_components"))
    if str(score_components.get("version") or "").strip().lower() != CANONICAL_SCORE_FEATURE_VERSION:
        return None
    forecast_data = _loads(row.get("forecast_data"))
    ev2 = forecast_data.get("ensemble_v2") if isinstance(forecast_data.get("ensemble_v2"), dict) else {}
    final_score = _float_or_none(score_components.get("finalScore") or score_components.get("total") or row.get("score"))
    ml_edge = _component(score_components, "mlEdge")
    fundamental = _component(score_components, "fundamentalQuality")
    chip = _component(score_components, "chipFlow")
    technical = _component(score_components, "technicalStructure")
    avg_rank = _float_or_none(ev2.get("avg_rank"))
    confidence = _float_or_none(ev2.get("confidence"))
    values = {
        "score_final_norm": None if final_score is None else final_score / 100.0,
        "ml_edge_norm": None if ml_edge is None else ml_edge / 25.0,
        "fundamental_quality_norm": None if fundamental is None else fundamental / 25.0,
        "chip_flow_norm": None if chip is None else chip / 25.0,
        "technical_structure_norm": None if technical is None else technical / 25.0,
        "ensemble_avg_rank_centered": None if avg_rank is None else avg_rank - 0.5,
        "ensemble_confidence_centered": None if confidence is None else confidence - 0.5,
    }
    if any(values[name] is None for name in FEATURE_NAMES):
        return None
    return {name: float(values[name]) for name in FEATURE_NAMES}


def _target(row: dict[str, Any]) -> float | None:
    value = _float_or_none(row.get("actual_return_pct"))
    if value is None or not (-1.0 < value < 1.0):
        return None
    return value


def _samples(
    rows: list[dict[str, Any]],
    *,
    zero_return_day_min_samples: int = 20,
    min_cross_section_samples_per_date: int = MIN_CROSS_SECTION_SAMPLES_PER_DATE,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_date: dict[str, list[dict[str, Any]]] = {}
    invalid = 0
    rejected_feature_era_rows = 0
    feature_era_counts: dict[str, int] = {}
    for row in rows:
        era = str(_loads(row.get("score_components")).get("version") or "legacy_unversioned").strip().lower()
        feature_era_counts[era] = feature_era_counts.get(era, 0) + 1
        if era != CANONICAL_SCORE_FEATURE_VERSION:
            rejected_feature_era_rows += 1
        features = _feature_vector(row)
        target = _target(row)
        if features is None or target is None:
            invalid += 1
            continue
        day = str(row.get("prediction_date") or row.get("date") or "")[:10] or "unknown"
        by_date.setdefault(day, []).append({
            "date": day,
            "symbol": row.get("symbol"),
            "features": features,
            "target": target,
        })

    excluded_zero_dates: list[str] = []
    sparse_dates: list[str] = []
    sparse_date_rows_rejected = 0
    minimum_day_samples = max(1, int(min_cross_section_samples_per_date))
    out: list[dict[str, Any]] = []
    for day, day_rows in sorted(by_date.items()):
        if day != "unknown" and len(day_rows) < minimum_day_samples:
            sparse_dates.append(day)
            sparse_date_rows_rejected += len(day_rows)
            invalid += len(day_rows)
            continue
        if (
            day != "unknown"
            and len(day_rows) >= zero_return_day_min_samples
            and all(abs(float(item["target"])) <= 1e-12 for item in day_rows)
        ):
            excluded_zero_dates.append(day)
            continue
        out.extend(day_rows)
    diagnostics = {
        "input_rows": len(rows),
        "sample_count": len(out),
        "invalid_rows": invalid,
        "accepted_feature_era": CANONICAL_SCORE_FEATURE_VERSION,
        "feature_era_counts": dict(sorted(feature_era_counts.items())),
        "rejected_feature_era_rows": rejected_feature_era_rows,
        "min_cross_section_samples_per_date": minimum_day_samples,
        "sparse_dates_rejected": sparse_dates,
        "sparse_date_rows_rejected": sparse_date_rows_rejected,
        "date_count": len({row["date"] for row in out}),
        "excluded_zero_return_dates": excluded_zero_dates,
    }
    return out, diagnostics


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


def _fit_ridge(samples: list[dict[str, Any]], *, l2: float) -> tuple[float, dict[str, float]]:
    p = len(FEATURE_NAMES) + 1
    xtx = [[0.0 for _ in range(p)] for _ in range(p)]
    xty = [0.0 for _ in range(p)]
    for sample in samples:
        x = [1.0, *[float(sample["features"][name]) for name in FEATURE_NAMES]]
        y = float(sample["target"])
        for i in range(p):
            xty[i] += x[i] * y
            for j in range(p):
                xtx[i][j] += x[i] * x[j]
    for i in range(1, p):
        xtx[i][i] += l2
    solved = _solve_linear_system(xtx, xty)
    if solved is None:
        raise ValueError("ridge_fit_singular_matrix")
    return solved[0], {name: solved[idx + 1] for idx, name in enumerate(FEATURE_NAMES)}


def _predict(sample: dict[str, Any], intercept: float, coefs: dict[str, float]) -> float:
    return intercept + sum(coefs[name] * float(sample["features"][name]) for name in FEATURE_NAMES)


def _metrics(samples: list[dict[str, Any]], intercept: float, coefs: dict[str, float]) -> dict[str, Any]:
    if not samples:
        return {"samples": 0}
    pairs = [(_predict(sample, intercept, coefs), float(sample["target"])) for sample in samples]
    preds = [item[0] for item in pairs]
    targets = [item[1] for item in pairs]
    errors = [pred - target for pred, target in pairs]
    ranked = sorted(pairs, key=lambda item: item[0])
    bucket = max(1, len(ranked) // 5)
    bottom = ranked[:bucket]
    top = ranked[-bucket:]
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
        fisher_lcb = math.atanh(corr) - (1.645 / math.sqrt(len(samples) - 3))
        corr_lcb = math.tanh(fisher_lcb)
    return {
        "samples": len(samples),
        "mean_target": round(_mean(targets), 8),
        "mean_prediction": round(_mean(preds), 8),
        "mae": round(_mean([abs(err) for err in errors]), 8),
        "rmse": round(math.sqrt(_mean([err * err for err in errors])), 8),
        "prediction_target_corr": None if corr is None else round(float(corr), 8),
        "prediction_target_corr_lcb90": None if corr_lcb is None else round(corr_lcb, 8),
        "top_quintile_mean_return": round(_mean(top_returns), 8),
        "bottom_quintile_mean_return": round(_mean(bottom_returns), 8),
        "top_bottom_spread": round(spread, 8),
        "top_bottom_spread_lcb90": round(spread - 1.645 * spread_se, 8),
        "top_quintile_hit_rate": round(sum(1 for _, target in top if target > 0) / len(top), 8),
    }


def _sample_variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return sum((value - mean) ** 2 for value in values) / (len(values) - 1)


def _walk_forward(samples: list[dict[str, Any]], *, folds: int, l2: float) -> dict[str, Any]:
    dates = sorted({str(sample["date"]) for sample in samples})
    if len(dates) < folds + 1:
        return {"passed": False, "reason": "insufficient_dates", "folds": []}
    fold_rows: list[dict[str, Any]] = []
    for fold in range(1, folds + 1):
        split_idx = max(1, round(len(dates) * fold / (folds + 1)))
        next_idx = max(split_idx + 1, round(len(dates) * (fold + 1) / (folds + 1)))
        train_dates = set(dates[:split_idx])
        test_dates = set(dates[split_idx:next_idx])
        train = [sample for sample in samples if sample["date"] in train_dates]
        test = [sample for sample in samples if sample["date"] in test_dates]
        if len(train) < len(FEATURE_NAMES) + 2 or not test:
            continue
        intercept, coefs = _fit_ridge(train, l2=l2)
        metric = _metrics(test, intercept, coefs)
        fold_rows.append({
            "fold": fold,
            "train_dates": len(train_dates),
            "test_dates": len(test_dates),
            **metric,
        })
    if not fold_rows:
        return {"passed": False, "reason": "no_valid_folds", "folds": []}
    positive_spread = sum(1 for row in fold_rows if float(row.get("top_bottom_spread") or 0.0) > 0.0)
    positive_corr = sum(1 for row in fold_rows if (row.get("prediction_target_corr") or 0.0) > 0.0)
    passed = positive_spread >= max(1, math.ceil(len(fold_rows) * 0.5)) and positive_corr >= max(1, math.ceil(len(fold_rows) * 0.5))
    return {
        "passed": passed,
        "reason": "ok" if passed else "walk_forward_not_stable",
        "fold_count": len(fold_rows),
        "positive_spread_folds": positive_spread,
        "positive_corr_folds": positive_corr,
        "folds": fold_rows,
    }


def build_l4_alpha_ev_artifact_from_rows(
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
    if len(train) < len(FEATURE_NAMES) + 2 or not test:
        blockers.append("insufficient_train_test_split")

    intercept = 0.0
    coefs = {name: 0.0 for name in FEATURE_NAMES}
    train_metrics: dict[str, Any] = {"samples": len(train)}
    oos_metrics: dict[str, Any] = {"samples": len(test)}
    walk_forward = {"passed": False, "reason": "not_run", "folds": []}
    if not blockers:
        intercept, coefs = _fit_ridge(train, l2=l2)
        train_metrics = _metrics(train, intercept, coefs)
        oos_metrics = _metrics(test, intercept, coefs)
        walk_forward = _walk_forward(samples, folds=4, l2=l2)
        if (oos_metrics.get("prediction_target_corr_lcb90") or 0.0) <= 0.0:
            blockers.append("oos_prediction_target_corr_lcb90_not_positive")
        min_economic_spread = max(0.0, float(cost_model_bps)) / 10000.0
        if float(oos_metrics.get("top_bottom_spread_lcb90") or 0.0) <= min_economic_spread:
            blockers.append("oos_top_bottom_spread_lcb90_not_above_cost")
        if float(oos_metrics.get("top_quintile_mean_return") or 0.0) <= 0.0:
            blockers.append("oos_top_quintile_return_not_positive")
        if not walk_forward.get("passed"):
            blockers.append("walk_forward_not_stable")

    decision = "PASS" if not blockers else "FAIL"
    model_version = f"l4-alpha-ev-ridge-{trained_until.replace('-', '')}"
    validation_packet = {
        "schema_version": "l4-alpha-ev-validation-packet-v1",
        "decision": decision,
        "failed_gates": blockers,
        "validation_scope": {
            "owner": "l4_alpha_ev",
            "target": "verified_ensemble_actual_return_pct",
            "method": "date_split_oos_plus_walk_forward",
            "lookback_days": lookback_days,
            "promotion_confidence_level": 0.90,
            "minimum_economic_spread": round(max(0.0, float(cost_model_bps)) / 10000.0, 8),
            "feature_era": CANONICAL_SCORE_FEATURE_VERSION,
            "point_in_time_features_required": True,
        },
        "sample_audit": diagnostics,
        "train_metrics": train_metrics,
        "oos_metrics": oos_metrics,
        "walk_forward": walk_forward,
    }
    artifact = {
        "schema_version": "l4-alpha-ev-artifact-v1",
        "expected_return_owner": "l4_alpha_ev",
        "promotion_state": "production_approved" if decision == "PASS" else "approval_required",
        "validation_packet": validation_packet,
        "resolver_method": "ridge_meta_calibrator",
        "model_version": model_version,
        "feature_snapshot_version": "l4-alpha-feature-snapshot-v3-canonical-score-v2-only",
        "trained_until": trained_until,
        "horizon_days": 5,
        "cost_model_bps": cost_model_bps,
        "output_is_net_of_costs": False,
        "feature_families": ["score_v2_composite", "formal_ml_rank", "formal_ml_confidence"],
        "feature_names": FEATURE_NAMES,
        "intercept": round(intercept, 10),
        "coefficients": {name: round(value, 10) for name, value in coefs.items()},
        "output_clip": {"min": -0.08, "max": 0.08},
        "training_data": {
            "source": "predictions ensemble verified outcomes join daily_recommendations score_components",
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


def load_l4_alpha_ev_training_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    end_date: str,
    lookback_days: int = 90,
    limit: int = 6000,
) -> list[dict[str, Any]]:
    return query_fn(
        """
        SELECT
            p.stock_id,
            s.symbol,
            date(p.prediction_date) AS prediction_date,
            p.forecast_data,
            p.actual_return_pct,
            dr.score,
            dr.score_components,
            dr.alpha_context,
            dr.market_segment,
            dr.recommendation_lane
        FROM predictions p
        JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id
         AND dr.date = p.prediction_date
        JOIN stocks s
          ON s.id = p.stock_id
        WHERE p.model_name = 'ensemble'
          AND p.verified_at IS NOT NULL
          AND p.actual_return_pct IS NOT NULL
          AND p.actual_price = (
              SELECT sp.close
              FROM stock_prices sp
              WHERE sp.stock_id = p.stock_id
                AND date(sp.date) > date(p.prediction_date)
              ORDER BY date(sp.date) ASC
              LIMIT 1 OFFSET 4
          )
          AND p.forecast_data IS NOT NULL
          AND dr.score_components IS NOT NULL
          AND date(p.prediction_date) <= date(?)
          AND date(p.prediction_date) >= date(?, ?)
        ORDER BY date(p.prediction_date) ASC, s.symbol ASC
        LIMIT ?
        """,
        [end_date, end_date, f"-{max(1, int(lookback_days))} days", int(limit)],
    )
