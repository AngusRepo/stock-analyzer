"""Build allocator EV fusion artifacts from verified recommendation outcomes."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Callable

from services.allocator_ev_fusion import _s12_execution_ready, _s12_multiplier, _target_quality_numeric, _target_quality_state
from services.l4_alpha_ev_resolver import extract_l4_alpha_ev
from services.s12_trade_ev import extract_s12_trade_ev


FEATURE_NAMES = [
    "l4_expected_return",
    "s12_trade_expected_return",
    "s12_available",
    "s12_execution_ready",
    "s12_context_multiplier",
    "s12_target_quality_score",
    "market_heat_expected_return",
    "l4_s12_edge_agreement",
]


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


def _feature_vector(row: dict[str, Any]) -> dict[str, float] | None:
    extractor_row = _row_for_extractors(row)
    l4_value, _l4_source, _l4_payload = extract_l4_alpha_ev(extractor_row)
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


def _target(row: dict[str, Any]) -> float | None:
    for key in ("trade_pnl_pct", "actual_return_pct"):
        value = _float_or_none(row.get(key))
        if value is not None and -1.0 < value < 1.0:
            return value
    return None


def _samples(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    out: list[dict[str, Any]] = []
    invalid = 0
    missing_features = 0
    for row in rows:
        features = _feature_vector(row)
        target = _target(row)
        if features is None:
            missing_features += 1
            invalid += 1
            continue
        if target is None:
            invalid += 1
            continue
        day = str(row.get("prediction_date") or row.get("date") or "")[:10] or "unknown"
        out.append({
            "date": day,
            "symbol": row.get("symbol"),
            "features": features,
            "target": target,
        })
    return out, {
        "input_rows": len(rows),
        "sample_count": len(out),
        "invalid_rows": invalid,
        "missing_feature_rows": missing_features,
        "date_count": len({row["date"] for row in out}),
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
        raise ValueError("allocator_ev_fusion_ridge_fit_singular_matrix")
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
    top = ranked[-bucket:]
    bottom = ranked[:bucket]
    corr = _corr(preds, targets)
    return {
        "samples": len(samples),
        "mean_target": round(_mean(targets), 8),
        "mean_prediction": round(_mean(preds), 8),
        "mae": round(_mean([abs(err) for err in errors]), 8),
        "rmse": round(math.sqrt(_mean([err * err for err in errors])), 8),
        "prediction_target_corr": None if corr is None else round(corr, 8),
        "top_quintile_mean_return": round(_mean([target for _, target in top]), 8),
        "bottom_quintile_mean_return": round(_mean([target for _, target in bottom]), 8),
        "top_bottom_spread": round(_mean([target for _, target in top]) - _mean([target for _, target in bottom]), 8),
    }


def _walk_forward(samples: list[dict[str, Any]], *, folds: int, l2: float) -> dict[str, Any]:
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
        if len(train) < len(FEATURE_NAMES) + 2 or not test:
            continue
        intercept, coefs = _fit_ridge(train, l2=l2)
        rows.append({"fold": fold, **_metrics(test, intercept, coefs)})
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
        if (oos_metrics.get("prediction_target_corr") or 0.0) <= 0.0:
            blockers.append("oos_prediction_target_corr_not_positive")
        if float(oos_metrics.get("top_bottom_spread") or 0.0) <= 0.0:
            blockers.append("oos_top_bottom_spread_not_positive")
        if not walk_forward.get("passed"):
            blockers.append("walk_forward_not_stable")
    decision = "PASS" if not blockers else "FAIL"
    validation_packet = {
        "schema_version": "allocator-ev-fusion-validation-packet-v1",
        "decision": decision,
        "failed_gates": blockers,
        "validation_scope": {
            "owner": "allocator_ev_fusion",
            "target": "verified_trade_pnl_pct_or_actual_return_pct",
            "method": "date_split_oos_plus_walk_forward",
            "lookback_days": lookback_days,
        },
        "sample_audit": diagnostics,
        "train_metrics": train_metrics,
        "oos_metrics": oos_metrics,
        "walk_forward": walk_forward,
    }
    artifact = {
        "schema_version": "allocator-ev-fusion-artifact-v1",
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_approved" if decision == "PASS" else "approval_required",
        "validation_packet": validation_packet,
        "resolver_method": "ridge_allocator_ev_fusion",
        "model_version": f"allocator-ev-fusion-ridge-{trained_until.replace('-', '')}",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v1",
        "trained_until": trained_until,
        "horizon_days": 5,
        "cost_model_bps": cost_model_bps,
        "output_is_net_of_costs": False,
        "feature_names": FEATURE_NAMES,
        "intercept": round(intercept, 10),
        "coefficients": {name: round(value, 10) for name, value in coefs.items()},
        "output_clip": {"min": -0.08, "max": 0.08},
        "training_data": {
            "source": "daily_recommendations alpha_allocation l4_alpha_ev+s12_trade_ev joined verified outcomes",
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
                fs.score,
                fs.score_components,
                fs.alpha_context,
                fs.alpha_allocation,
                fs.market_heat_expected_return,
                fs.market_segment,
                fs.recommendation_lane,
                fs.snapshot_source AS allocator_ev_feature_snapshot_source,
                fs.as_of_guard AS allocator_ev_feature_snapshot_guard
            FROM allocator_ev_feature_snapshots fs
            JOIN predictions p
              ON p.stock_id = fs.stock_id
             AND p.prediction_date = fs.snapshot_date
             AND p.model_name = 'ensemble'
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
            dr.score,
            dr.score_components,
            dr.alpha_context,
            dr.alpha_allocation,
            NULL AS market_heat_expected_return,
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
