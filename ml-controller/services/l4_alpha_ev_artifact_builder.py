"""Build a validated formal L4 alpha EV artifact from verified outcomes."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Callable

from scipy.stats import t as student_t

from services.evidence_contracts import (
    L4_ARTIFACT_CONTRACT_VERSION,
    L4_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
)
from services.ev_lineage_contract import (
    ENSEMBLE_SEMANTIC_VERSION,
    OOF_ENSEMBLE_SEMANTIC_VERSION,
    attach_same_run_model_version_evidence,
    ev_feature_lineage_blockers,
)


FEATURE_NAMES = [
    "ml_edge_norm",
    "fundamental_quality_norm",
    "chip_flow_norm",
    "technical_structure_norm",
    "ensemble_directional_margin",
]
CANONICAL_SCORE_FEATURE_VERSION = "score_v2"
CANONICAL_SCORE_SEMANTIC_VERSION = "score-v2-active8-components-v3"
CANONICAL_ENSEMBLE_SEMANTIC_VERSION = ENSEMBLE_SEMANTIC_VERSION
CANONICAL_ADJUSTMENT_FACTOR_SOURCE = "canonical_market_daily:finlab.price"
FEATURE_SEMANTIC_VERSION = L4_FEATURE_SEMANTIC_VERSION
LABEL_PURGE_DATE_GROUPS = 5
ARTIFACT_CONTRACT_VERSION = L4_ARTIFACT_CONTRACT_VERSION
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
    if ev_feature_lineage_blockers(row):
        return None
    final_score = _float_or_none(score_components.get("finalScore") or score_components.get("total") or row.get("score"))
    ml_edge = _component(score_components, "mlEdge")
    fundamental = _component(score_components, "fundamentalQuality")
    chip = _component(score_components, "chipFlow")
    technical = _component(score_components, "technicalStructure")
    avg_rank = _float_or_none(ev2.get("avg_rank"))
    values = {
        "score_final_norm": None if final_score is None else final_score / 100.0,
        "ml_edge_norm": None if ml_edge is None else ml_edge / 25.0,
        "fundamental_quality_norm": None if fundamental is None else fundamental / 25.0,
        "chip_flow_norm": None if chip is None else chip / 25.0,
        "technical_structure_norm": None if technical is None else technical / 25.0,
        "ensemble_directional_margin": None if avg_rank is None else avg_rank - 0.5,
    }
    if any(values[name] is None for name in FEATURE_NAMES):
        return None
    return {name: float(values[name]) for name in FEATURE_NAMES}


def _target(row: dict[str, Any], *, cost_model_bps: float) -> float | None:
    value = _float_or_none(row.get("l4_executable_return_pct"))
    if value is None or not (-1.0 < value < 1.0):
        return None
    return value - max(0.0, float(cost_model_bps)) / 10000.0


def _samples(
    rows: list[dict[str, Any]],
    *,
    cost_model_bps: float = 18.0,
    zero_return_day_min_samples: int = 20,
    min_cross_section_samples_per_date: int = MIN_CROSS_SECTION_SAMPLES_PER_DATE,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_date: dict[str, list[dict[str, Any]]] = {}
    invalid = 0
    rejected_feature_era_rows = 0
    feature_era_counts: dict[str, int] = {}
    score_semantic_counts: dict[str, int] = {}
    ensemble_semantic_counts: dict[str, int] = {}
    ensemble_generation_mode_counts: dict[str, int] = {}
    model_set_signature_counts: dict[str, int] = {}
    lineage_blocker_counts: dict[str, int] = {}
    adjustment_lineage_counts: dict[str, int] = {}
    for row in rows:
        score_payload = _loads(row.get("score_components"))
        forecast_payload = _loads(row.get("forecast_data"))
        ensemble_payload = forecast_payload.get("ensemble_v2") if isinstance(forecast_payload.get("ensemble_v2"), dict) else {}
        era = str(score_payload.get("version") or "legacy_unversioned").strip().lower()
        score_semantic = str(score_payload.get("semanticVersion") or "missing")
        ensemble_semantic = str(ensemble_payload.get("semantic_version") or "missing")
        ensemble_generation_mode = str(
            ensemble_payload.get("generation_mode") or "native"
        ).strip().lower()
        model_set_signature = str(ensemble_payload.get("model_set_signature") or "missing")
        feature_era_counts[era] = feature_era_counts.get(era, 0) + 1
        score_semantic_counts[score_semantic] = score_semantic_counts.get(score_semantic, 0) + 1
        ensemble_semantic_counts[ensemble_semantic] = ensemble_semantic_counts.get(ensemble_semantic, 0) + 1
        ensemble_generation_mode_counts[ensemble_generation_mode] = (
            ensemble_generation_mode_counts.get(ensemble_generation_mode, 0) + 1
        )
        model_set_signature_counts[model_set_signature] = model_set_signature_counts.get(model_set_signature, 0) + 1
        adjustment_source = str(row.get("label_adjustment_source") or "missing")
        adjustment_lineage_counts[adjustment_source] = adjustment_lineage_counts.get(adjustment_source, 0) + 1
        if era != CANONICAL_SCORE_FEATURE_VERSION:
            rejected_feature_era_rows += 1
        lineage_blockers = ev_feature_lineage_blockers(row)
        for blocker in lineage_blockers:
            lineage_blocker_counts[blocker] = lineage_blocker_counts.get(blocker, 0) + 1
        features = _feature_vector(row)
        target = (
            _target(row, cost_model_bps=cost_model_bps)
            if adjustment_source == CANONICAL_ADJUSTMENT_FACTOR_SOURCE
            else None
        )
        if features is None or target is None:
            invalid += 1
            continue
        day = str(
            row.get("prediction_date")
            or row.get("snapshot_date")
            or row.get("date")
            or ""
        )[:10] or "unknown"
        by_date.setdefault(day, []).append({
            "date": day,
            "symbol": row.get("symbol"),
            "features": features,
            "target": target,
            "label_known_date": str(row.get("l4_exit_date") or row.get("label_known_date") or "")[:10],
            "source_row": row,
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
    feature_profile: dict[str, dict[str, Any]] = {}
    for name in FEATURE_NAMES:
        values = [float(row["features"][name]) for row in out]
        mean = _mean(values)
        variance = (
            sum((value - mean) ** 2 for value in values) / (len(values) - 1)
            if len(values) > 1
            else 0.0
        )
        feature_profile[name] = {
            "samples": len(values),
            "nonzero_samples": sum(abs(value) > 1e-12 for value in values),
            "minimum": None if not values else round(min(values), 10),
            "maximum": None if not values else round(max(values), 10),
            "mean": None if not values else round(mean, 10),
            "standard_deviation": None if not values else round(math.sqrt(variance), 10),
            "degenerate": not values or variance <= 1e-16,
        }
    generation_modes = set(ensemble_generation_mode_counts)
    if generation_modes == {"purged_oof"}:
        required_ensemble_semantic = OOF_ENSEMBLE_SEMANTIC_VERSION
    elif generation_modes == {"native"}:
        required_ensemble_semantic = ENSEMBLE_SEMANTIC_VERSION
    else:
        required_ensemble_semantic = "generation-mode-dependent"
    diagnostics = {
        "input_rows": len(rows),
        "sample_count": len(out),
        "invalid_rows": invalid,
        "accepted_feature_era": CANONICAL_SCORE_FEATURE_VERSION,
        "feature_era_counts": dict(sorted(feature_era_counts.items())),
        "required_score_semantic_version": CANONICAL_SCORE_SEMANTIC_VERSION,
        "score_semantic_counts": dict(sorted(score_semantic_counts.items())),
        "required_ensemble_semantic_version": required_ensemble_semantic,
        "required_ensemble_semantic_versions": {
            "native": ENSEMBLE_SEMANTIC_VERSION,
            "purged_oof": OOF_ENSEMBLE_SEMANTIC_VERSION,
        },
        "ensemble_generation_mode_counts": dict(sorted(ensemble_generation_mode_counts.items())),
        "ensemble_semantic_counts": dict(sorted(ensemble_semantic_counts.items())),
        "model_set_signature_counts": dict(sorted(model_set_signature_counts.items())),
        "lineage_blocker_counts": dict(sorted(lineage_blocker_counts.items())),
        "required_adjustment_factor_source": CANONICAL_ADJUSTMENT_FACTOR_SOURCE,
        "adjustment_lineage_counts": dict(sorted(adjustment_lineage_counts.items())),
        "rejected_feature_era_rows": rejected_feature_era_rows,
        "min_cross_section_samples_per_date": minimum_day_samples,
        "sparse_dates_rejected": sparse_dates,
        "sparse_date_rows_rejected": sparse_date_rows_rejected,
        "date_count": len({row["date"] for row in out}),
        "feature_profile": feature_profile,
        "degenerate_features": sorted(
            name for name, profile in feature_profile.items() if profile["degenerate"]
        ),
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


def _date_cluster_metrics(
    samples: list[dict[str, Any]],
    pairs: list[tuple[float, float]],
) -> dict[str, Any]:
    by_date: dict[str, list[tuple[float, float]]] = {}
    for sample, pair in zip(samples, pairs, strict=True):
        by_date.setdefault(str(sample["date"]), []).append(pair)

    daily_corrs: list[float] = []
    daily_spreads: list[float] = []
    daily_top_quintile_returns: list[float] = []
    for day_pairs in by_date.values():
        if len(day_pairs) < 5:
            continue
        preds = [pair[0] for pair in day_pairs]
        targets = [pair[1] for pair in day_pairs]
        corr = _corr(preds, targets)
        if corr is not None:
            daily_corrs.append(corr)
        ranked = sorted(day_pairs, key=lambda item: item[0])
        bucket = max(1, len(ranked) // 5)
        daily_top_quintile_returns.append(
            _mean([target for _, target in ranked[-bucket:]])
        )
        daily_spreads.append(
            _mean([target for _, target in ranked[-bucket:]])
            - _mean([target for _, target in ranked[:bucket]])
        )

    def clustered_summary(values: list[float]) -> tuple[float | None, float | None]:
        if not values:
            return None, None
        mean = _mean(values)
        if len(values) < 2:
            return mean, None
        return mean, _date_cluster_lcb90(values)

    corr_mean, corr_lcb = clustered_summary(daily_corrs)
    spread_mean, spread_lcb = clustered_summary(daily_spreads)
    top_return_mean, top_return_lcb = clustered_summary(daily_top_quintile_returns)
    return {
        "date_count": len(by_date),
        "date_corr_samples": len(daily_corrs),
        "date_spread_samples": len(daily_spreads),
        "date_mean_cross_section_corr": None if corr_mean is None else round(corr_mean, 8),
        "date_mean_cross_section_corr_lcb90": None if corr_lcb is None else round(corr_lcb, 8),
        "date_mean_top_bottom_spread": None if spread_mean is None else round(spread_mean, 8),
        "date_mean_top_bottom_spread_lcb90": None if spread_lcb is None else round(spread_lcb, 8),
        "date_mean_top_quintile_return": (
            None if top_return_mean is None else round(top_return_mean, 8)
        ),
        "date_mean_top_quintile_return_lcb90": (
            None if top_return_lcb is None else round(top_return_lcb, 8)
        ),
    }


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
        **_date_cluster_metrics(samples, pairs),
    }


def _sample_variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return sum((value - mean) ** 2 for value in values) / (len(values) - 1)


def _date_cluster_lcb90(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    standard_error = math.sqrt(_sample_variance(values) / len(values))
    critical_value = float(student_t.ppf(0.95, df=len(values) - 1))
    return _mean(values) - critical_value * standard_error


def _walk_forward(samples: list[dict[str, Any]], *, folds: int, l2: float) -> dict[str, Any]:
    dates = sorted({str(sample["date"]) for sample in samples})
    if len(dates) < folds + 1:
        return {"passed": False, "reason": "insufficient_dates", "folds": []}
    fold_rows: list[dict[str, Any]] = []
    for fold in range(1, folds + 1):
        split_idx = max(1, round(len(dates) * fold / (folds + 1)))
        next_idx = max(split_idx + 1, round(len(dates) * (fold + 1) / (folds + 1)))
        train_dates = set(dates[:max(0, split_idx - LABEL_PURGE_DATE_GROUPS)])
        test_dates = set(dates[split_idx:next_idx])
        train = [sample for sample in samples if sample["date"] in train_dates]
        test = [sample for sample in samples if sample["date"] in test_dates]
        if len(train) < len(FEATURE_NAMES) + 2 or not test or len(test_dates) < 2:
            continue
        intercept, coefs = _fit_ridge(train, l2=l2)
        metric = _metrics(test, intercept, coefs)
        fold_rows.append({
            "fold": fold,
            "train_dates": len(train_dates),
            "test_dates": len(test_dates),
            "intercept": round(intercept, 10),
            "coefficients": {name: round(value, 10) for name, value in coefs.items()},
            **metric,
        })
    if not fold_rows:
        return {"passed": False, "reason": "no_valid_folds", "folds": []}
    positive_spread = sum(1 for row in fold_rows if float(row.get("date_mean_top_bottom_spread") or 0.0) > 0.0)
    positive_corr = sum(1 for row in fold_rows if float(row.get("date_mean_cross_section_corr") or 0.0) > 0.0)
    required_positive_folds = max(1, math.ceil(len(fold_rows) * 0.75))
    passed = (
        len(fold_rows) >= 3
        and positive_spread >= required_positive_folds
        and positive_corr >= required_positive_folds
    )
    return {
        "passed": passed,
        "reason": "ok" if passed else "walk_forward_not_stable",
        "fold_count": len(fold_rows),
        "positive_spread_folds": positive_spread,
        "positive_corr_folds": positive_corr,
        "required_positive_folds": required_positive_folds,
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
    fit_min_samples: int | None = None,
    fit_min_dates: int | None = None,
    generation_mode: str = "native",
    cohort_id: str | None = None,
) -> dict[str, Any]:
    if generation_mode not in {"native", "purged_oof"}:
        raise ValueError("l4_generation_mode_invalid")
    if generation_mode == "purged_oof":
        if not cohort_id:
            raise ValueError("l4_oof_cohort_id_missing")
        invalid_modes = [
            row for row in rows
            if str(row.get("generation_mode") or "") != "purged_oof"
            or str(row.get("cohort_id") or "") != cohort_id
        ]
        if invalid_modes:
            raise ValueError("l4_oof_mixed_or_missing_cohort_lineage")
    samples, diagnostics = _samples(rows, cost_model_bps=cost_model_bps)
    dates = sorted({sample["date"] for sample in samples})
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
    train_dates = set(dates[:max(0, split_idx - LABEL_PURGE_DATE_GROUPS)])
    test_dates = set(dates[split_idx:])
    train = [sample for sample in samples if sample["date"] in train_dates]
    test = [sample for sample in samples if sample["date"] in test_dates]
    blockers: list[str] = []
    effective_fit_min_samples = max(len(FEATURE_NAMES) + 2, int(fit_min_samples or min_samples))
    effective_fit_min_dates = max(2, int(fit_min_dates or min_dates))
    if len(samples) < min_samples:
        blockers.append("insufficient_samples")
    if len(dates) < min_dates:
        blockers.append("insufficient_dates")
    if len(train) < len(FEATURE_NAMES) + 2 or not test:
        blockers.append("insufficient_train_test_split")

    fit_blockers: list[str] = []
    if len(samples) < effective_fit_min_samples:
        fit_blockers.append("insufficient_fit_samples")
    if len(dates) < effective_fit_min_dates:
        fit_blockers.append("insufficient_fit_dates")
    if len(train) < len(FEATURE_NAMES) + 2 or not test:
        fit_blockers.append("insufficient_fit_train_test_split")

    fitted = not fit_blockers
    intercept = 0.0
    coefs = {name: 0.0 for name in FEATURE_NAMES}
    train_metrics: dict[str, Any] = {"samples": len(train)}
    oos_metrics: dict[str, Any] = {"samples": len(test)}
    walk_forward = {"passed": False, "reason": "not_run", "folds": []}
    serving_intercept = intercept
    serving_coefs = dict(coefs)
    deployment_fit: dict[str, Any] = {
        "method": "full_known_sample_refit_after_purged_oos_validation",
        "samples": 0,
        "dates": 0,
        "performed": False,
    }
    if fitted:
        intercept, coefs = _fit_ridge(train, l2=l2)
        train_metrics = _metrics(train, intercept, coefs)
        oos_metrics = _metrics(test, intercept, coefs)
        walk_forward = _walk_forward(samples, folds=4, l2=l2)
        if (oos_metrics.get("date_mean_cross_section_corr_lcb90") or 0.0) <= 0.0:
            blockers.append("oos_date_cluster_corr_lcb90_not_positive")
        min_economic_spread = 0.0
        if float(oos_metrics.get("date_mean_top_bottom_spread_lcb90") or 0.0) <= min_economic_spread:
            blockers.append("oos_date_cluster_spread_lcb90_not_above_cost")
        if float(oos_metrics.get("top_quintile_mean_return") or 0.0) <= 0.0:
            blockers.append("oos_top_quintile_return_not_positive")
        if float(oos_metrics.get("date_mean_top_quintile_return_lcb90") or 0.0) <= 0.0:
            blockers.append("oos_date_cluster_top_quintile_return_lcb90_not_positive")
        if not walk_forward.get("passed"):
            blockers.append("walk_forward_not_stable")
        serving_intercept, serving_coefs = _fit_ridge(samples, l2=l2)
        deployment_fit = {
            "method": "full_known_sample_refit_after_purged_oos_validation",
            "samples": len(samples),
            "dates": len(dates),
            "performed": True,
            "validation_coefficients_are_not_served": True,
        }

    blockers.extend(value for value in fit_blockers if value not in blockers)
    decision = "PASS" if not blockers else "FAIL"
    model_version = f"l4-alpha-ev-ridge-v4-{trained_until.replace('-', '')}"
    validation_packet = {
        "schema_version": "l4-alpha-ev-validation-packet-v1",
        "decision": decision,
        "failed_gates": blockers,
        "validation_scope": {
            "owner": "l4_alpha_ev",
            "target": "next_session_raw_open_to_fifth_session_raw_close_factor_stable_net_return",
            "label_schema_version": LABEL_SCHEMA_VERSION,
            "method": "date_split_oos_plus_walk_forward_with_date_clustered_uncertainty",
            "lookback_days": lookback_days,
            "promotion_confidence_level": 0.90,
            "minimum_economic_spread": 0.0,
            "target_is_net_of_costs": True,
            "feature_era": CANONICAL_SCORE_FEATURE_VERSION,
            "point_in_time_features_required": True,
            "purged_signal_date_groups": LABEL_PURGE_DATE_GROUPS,
            "fit_min_samples": effective_fit_min_samples,
            "fit_min_dates": effective_fit_min_dates,
        },
        "sample_audit": diagnostics,
        "train_metrics": train_metrics,
        "oos_metrics": oos_metrics,
        "walk_forward": walk_forward,
        "deployment_fit": deployment_fit,
    }
    artifact = {
        "schema_version": "l4-alpha-ev-artifact-v2",
        "artifact_contract_version": ARTIFACT_CONTRACT_VERSION,
        "expected_return_owner": "l4_alpha_ev",
        "promotion_state": (
            "offline_quality_passed_operational_parity_required"
            if decision == "PASS" and generation_mode == "purged_oof"
            else "production_approved"
            if decision == "PASS"
            else "approval_required"
        ),
        "validation_packet": validation_packet,
        "resolver_method": "ridge_meta_calibrator",
        "fitted": fitted,
        "fit_blockers": fit_blockers,
        "model_version": model_version,
        "feature_snapshot_version": "l4-alpha-feature-snapshot-v4-directional-components",
        "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "trained_until": trained_until,
        "horizon_days": 5,
        "cost_model_bps": cost_model_bps,
        "output_is_net_of_costs": True,
        "feature_families": ["score_v2_components", "formal_ml_direction"],
        "feature_names": FEATURE_NAMES,
        "intercept": round(serving_intercept, 10),
        "coefficients": {name: round(value, 10) for name, value in serving_coefs.items()},
        "output_clip": {"min": -0.08, "max": 0.08},
        "training_data": {
            "source": "point-in-time ensemble and ScoreV2 components joined to raw executable horizon labels with stable adjustment factors",
            "trained_until": trained_until,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            **diagnostics,
            "generation_mode": generation_mode,
            "cohort_id": cohort_id,
            "efficacy_evidence_mode": "purged_oof" if generation_mode == "purged_oof" else "native",
        },
    }
    return {
        "status": "ok" if decision == "PASS" else "failed_validation",
        "artifact": artifact,
        "validation_packet": validation_packet,
    }


def build_l4_chronological_oof_predictions(
    rows: list[dict[str, Any]],
    *,
    cohort_id: str,
    l2: float = 0.25,
    cost_model_bps: float = 18.0,
    min_train_samples: int = 500,
    min_train_dates: int = 5,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Cross-fit L4 on resolved prior OOF dates for downstream Fusion training."""

    if any(
        str(row.get("generation_mode") or "") != "purged_oof"
        or str(row.get("cohort_id") or "") != cohort_id
        for row in rows
    ):
        raise ValueError("l4_oof_mixed_or_missing_cohort_lineage")
    manifest_checksums = {
        str(row.get("source_manifest_checksum") or "").strip()
        for row in rows
        if str(row.get("source_manifest_checksum") or "").strip()
    }
    if len(manifest_checksums) != 1:
        raise ValueError("l4_oof_source_manifest_checksum_missing_or_mixed")
    source_manifest_checksum = next(iter(manifest_checksums))
    samples, diagnostics = _samples(rows, cost_model_bps=cost_model_bps)
    dates = sorted({sample["date"] for sample in samples})
    predictions: list[dict[str, Any]] = []
    date_evidence: list[dict[str, Any]] = []
    for prediction_date in dates:
        current = [sample for sample in samples if sample["date"] == prediction_date]
        prior = [
            sample for sample in samples
            if sample["date"] < prediction_date
            and sample.get("label_known_date")
            and sample["label_known_date"] < prediction_date
        ]
        prior_dates = sorted({sample["date"] for sample in prior})
        ready = len(prior) >= min_train_samples and len(prior_dates) >= min_train_dates
        if not ready:
            date_evidence.append({
                "prediction_date": prediction_date,
                "train_samples": len(prior),
                "train_dates": len(prior_dates),
                "eligible_for_efficacy": False,
            })
            continue
        intercept, coefficients = _fit_ridge(prior, l2=l2)
        trained_until = max(sample["label_known_date"] for sample in prior)
        model_version = f"l4-oof-cross-fit-v4-{cohort_id}-{prediction_date.replace('-', '')}"
        for sample in current:
            expected_return = intercept + sum(
                coefficients[name] * sample["features"][name]
                for name in FEATURE_NAMES
            )
            expected_return = max(-0.08, min(0.08, float(expected_return)))
            source = sample["source_row"]
            payload = {
                "schema_version": "l4-alpha-ev-v1",
                "artifact_contract_version": ARTIFACT_CONTRACT_VERSION,
                "feature_snapshot_version": FEATURE_SEMANTIC_VERSION,
                "label_schema_version": LABEL_SCHEMA_VERSION,
                "status": "purged_oof_evidence",
                "approval_state": "purged_oof_evidence_only",
                "purged_oof_evidence_only": True,
                "expected_return_owner": "l4_alpha_ev",
                "source": "l4_purged_oof_chronological_cross_fit",
                "expected_return_source": "l4_purged_oof_chronological_cross_fit",
                "expected_return": expected_return,
                "trained_until": trained_until,
                "model_version": model_version,
                "resolver_method": "ridge_chronological_cross_fit",
                "horizon_days": 5,
                "cost_model_bps": cost_model_bps,
                "output_is_net_of_costs": True,
                "generation_mode": "purged_oof",
                "cohort_id": cohort_id,
                "fold_id": source.get("fold_id"),
                "source_manifest_checksum": source_manifest_checksum,
                "point_in_time_prediction_lineage": {
                    "schema_version": "l4-point-in-time-prediction-lineage-v1",
                    "as_of_guard": "label_known_date_strictly_before_prediction_date",
                    "cohort_id": cohort_id,
                    "fold_id": source.get("fold_id"),
                    "prediction_date": prediction_date,
                    "trained_until": trained_until,
                    "source_manifest_checksum": source_manifest_checksum,
                    "train_samples": len(prior),
                    "train_dates": len(prior_dates),
                    "feature_semantic_version": FEATURE_SEMANTIC_VERSION,
                },
            }
            predictions.append({
                "cohort_id": cohort_id,
                "fold_id": source.get("fold_id"),
                "prediction_date": prediction_date,
                "symbol": sample.get("symbol"),
                "market_segment": source.get("market_segment") or "UNKNOWN",
                "expected_return": expected_return,
                "prediction_json": json.dumps(payload, sort_keys=True),
                "trained_until": trained_until,
                "model_version": model_version,
                "eligible_for_efficacy": 1,
            })
        date_evidence.append({
            "prediction_date": prediction_date,
            "train_samples": len(prior),
            "train_dates": len(prior_dates),
            "eligible_for_efficacy": True,
            "model_version": model_version,
        })
    return predictions, {
        "schema_version": "l4-chronological-oof-prediction-evidence-v1",
        "cohort_id": cohort_id,
        "input_audit": diagnostics,
        "prediction_rows": len(predictions),
        "prediction_dates": len({row["prediction_date"] for row in predictions}),
        "dates": date_evidence,
    }


def load_l4_alpha_ev_oof_training_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    cohort_id: str,
    knowledge_cutoff_date: str,
    limit: int = 12000,
) -> list[dict[str, Any]]:
    """Load one immutable OOF cohort with executable point-in-time labels."""

    return query_fn(
        """
        WITH price_horizons AS (
          SELECT
            sp.stock_id,
            date(sp.date) price_date,
            LEAD(date(sp.date), 1) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) entry_date,
            LEAD(sp.open, 1) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) entry_raw_open,
            LEAD(CASE WHEN cmd.close > 0 AND cmd.adj_close > 0 THEN cmd.adj_close / cmd.close END, 1)
              OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) entry_adjustment_factor,
            LEAD(date(sp.date), 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) exit_date,
            LEAD(sp.close, 5) OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) exit_raw_close,
            LEAD(CASE WHEN cmd.close > 0 AND cmd.adj_close > 0 THEN cmd.adj_close / cmd.close END, 5)
              OVER (PARTITION BY sp.stock_id ORDER BY date(sp.date)) exit_adjustment_factor
          FROM stock_prices sp
          JOIN stocks s ON s.id = sp.stock_id
          LEFT JOIN canonical_market_daily cmd
            ON cmd.stock_id = s.symbol
           AND cmd.date = date(sp.date)
           AND cmd.source = 'finlab.price'
        )
        SELECT
          fs.cohort_id,
          fs.fold_id,
          fs.generation_mode,
          fs.stock_id,
          fs.symbol,
          fs.snapshot_date prediction_date,
          fs.generated_at prediction_generated_at,
          fs.forecast_data,
          fs.score,
          fs.score_components,
          fs.alpha_context,
          fs.market_segment,
          fs.recommendation_lane,
          fs.label_known_date,
          fs.model_set_signature,
          'canonical_market_daily:finlab.price' label_adjustment_source,
          ((ph.exit_raw_close * ph.exit_adjustment_factor)
            / (ph.entry_raw_open * ph.entry_adjustment_factor)) - 1.0 l4_executable_return_pct,
          ph.entry_date l4_entry_date,
          ph.exit_date l4_exit_date
        FROM allocator_ev_oof_snapshots fs
        JOIN active8_oof_cohorts cohort
          ON cohort.cohort_id = fs.cohort_id
         AND cohort.status = 'ready'
        JOIN price_horizons ph
          ON ph.stock_id = fs.stock_id
         AND ph.price_date = fs.snapshot_date
        WHERE fs.cohort_id = ?
          AND fs.generation_mode = 'purged_oof'
          AND ph.entry_raw_open > 0
          AND ph.exit_raw_close > 0
          AND ph.entry_adjustment_factor > 0
          AND ph.exit_adjustment_factor > 0
          AND date(ph.exit_date) <= date(?)
          AND date(fs.label_known_date) <= date(?)
        ORDER BY fs.snapshot_date, fs.symbol
        LIMIT ?
        """,
        [cohort_id, knowledge_cutoff_date, knowledge_cutoff_date, int(limit)],
    )


def load_l4_alpha_ev_training_rows(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    end_date: str,
    knowledge_cutoff_date: str | None = None,
    lookback_days: int = 90,
    limit: int = 6000,
) -> list[dict[str, Any]]:
    outcome_cutoff = knowledge_cutoff_date or end_date
    rows = query_fn(
        """
        WITH price_horizons AS (
            SELECT
                sp.stock_id,
                sp.date AS price_date,
                LEAD(sp.date, 1) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) AS entry_date,
                LEAD(sp.open, 1) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) AS entry_raw_open,
                LEAD(
                    CASE WHEN cmd.close > 0 AND cmd.adj_close > 0 THEN cmd.adj_close / cmd.close END,
                    1
                ) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) AS entry_adjustment_factor,
                LEAD(sp.date, 5) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) AS exit_date,
                LEAD(sp.close, 5) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) AS exit_raw_close,
                LEAD(
                    CASE WHEN cmd.close > 0 AND cmd.adj_close > 0 THEN cmd.adj_close / cmd.close END,
                    5
                ) OVER (PARTITION BY sp.stock_id ORDER BY sp.date) AS exit_adjustment_factor
            FROM stock_prices sp
            JOIN stocks factor_stock
              ON factor_stock.id = sp.stock_id
            LEFT JOIN canonical_market_daily cmd
              ON cmd.stock_id = factor_stock.symbol
             AND cmd.date = sp.date
             AND cmd.source = 'finlab.price'
            WHERE sp.date >= date(?, ?, '-10 days')
              AND sp.date < date(?, '+1 day')
        )
        SELECT
            p.stock_id,
            s.symbol,
            p.prediction_date AS prediction_date,
            p.generated_at AS prediction_generated_at,
            datetime(ph.entry_date, '+1 hour') AS next_session_open_at,
            p.forecast_data,
            'canonical_market_daily:finlab.price' AS label_adjustment_source,
            ((ph.exit_raw_close * ph.exit_adjustment_factor)
              / (ph.entry_raw_open * ph.entry_adjustment_factor)) - 1.0 AS l4_executable_return_pct,
            ph.entry_date AS l4_entry_date,
            ph.exit_date AS l4_exit_date,
            ph.entry_raw_open AS l4_entry_raw_open,
            ph.exit_raw_close AS l4_exit_raw_close,
            ph.entry_adjustment_factor AS l4_entry_adjustment_factor,
            ph.exit_adjustment_factor AS l4_exit_adjustment_factor,
            dr.score,
            dr.score_components,
            dr.alpha_context,
            dr.market_segment,
            dr.recommendation_lane
        FROM predictions p INDEXED BY idx_pred_date_model_stock
        JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id
         AND dr.date = p.prediction_date
        JOIN stocks s
          ON s.id = p.stock_id
        JOIN price_horizons ph
          ON ph.stock_id = p.stock_id
         AND ph.price_date = p.prediction_date
        WHERE p.model_name = 'ensemble'
          AND p.prediction_date >= date(?, ?)
          AND p.prediction_date < date(?, '+1 day')
          AND ph.entry_raw_open > 0
          AND ph.exit_raw_close > 0
          AND ph.entry_adjustment_factor > 0
          AND ph.exit_adjustment_factor > 0
          AND ph.exit_date < date(?, '+1 day')
          AND (
            date(datetime(p.generated_at, '+8 hours')) <= p.prediction_date
            OR datetime(p.generated_at) < datetime(ph.entry_date || ' 01:00:00')
          )
          AND p.forecast_data IS NOT NULL
          AND dr.score_components IS NOT NULL
        ORDER BY p.prediction_date ASC, s.symbol ASC
        LIMIT ?
        """,
        [
            end_date,
            f"-{max(1, int(lookback_days))} days",
            outcome_cutoff,
            end_date,
            f"-{max(1, int(lookback_days))} days",
            end_date,
            outcome_cutoff,
            int(limit),
        ],
    )
    enriched, _ = attach_same_run_model_version_evidence(query_fn, rows)
    return enriched
