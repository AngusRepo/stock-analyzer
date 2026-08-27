"""Chronological OOF stacking for the formal Active-8 model set."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

import numpy as np

from services.ev_lineage_contract import OOF_ENSEMBLE_SEMANTIC_VERSION

ACTIVE8_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)
STACKER_SEMANTIC_VERSION = OOF_ENSEMBLE_SEMANTIC_VERSION
MIN_STACKER_TRAIN_ROWS = 500
MIN_STACKER_TRAIN_DATES = 5
RIDGE_CANDIDATES = (0.01, 0.1, 1.0, 10.0)
TARGET_AGREEMENT_TOLERANCE = 1e-6
MODEL_WEIGHT_ZERO_TOLERANCE = 1e-10
CORE_CROSS_SECTIONAL_MODELS = ACTIVE8_MODELS[:5]
STACKER_FEATURE_NAMES = tuple(
    [f"{model}.rank" for model in ACTIVE8_MODELS]
    + [f"{model}.available" for model in ACTIVE8_MODELS]
)


def _spearman(left: np.ndarray, right: np.ndarray) -> float:
    if len(left) < 3 or len(left) != len(right):
        return 0.0
    left_rank = _average_rank(left)
    right_rank = _average_rank(right)
    if np.std(left_rank) <= 1e-12 or np.std(right_rank) <= 1e-12:
        return 0.0
    value = float(np.corrcoef(left_rank, right_rank)[0, 1])
    return value if math.isfinite(value) else 0.0


def _average_rank(values: np.ndarray) -> np.ndarray:
    """Stable average ranks; equal scores must remain equal."""

    array = np.asarray(values, dtype=float)
    order = np.argsort(array, kind="mergesort")
    ranks = np.empty(len(array), dtype=float)
    start = 0
    while start < len(array):
        end = start + 1
        while end < len(array) and array[order[end]] == array[order[start]]:
            end += 1
        ranks[order[start:end]] = (start + end - 1) / 2.0
        start = end
    return ranks


def _fit_ridge(
    x: np.ndarray,
    y: np.ndarray,
    regularization: float,
    *,
    active_models: tuple[str, ...] | None = None,
) -> tuple[np.ndarray, float]:
    """Fit convex ridge while forbidding sign inversion of model-rank alpha."""

    from scipy.optimize import lsq_linear

    selected = tuple(ACTIVE8_MODELS if active_models is None else active_models)
    selected_indices = [ACTIVE8_MODELS.index(name) for name in selected]
    feature_indices = [
        *selected_indices,
        *[index + len(ACTIVE8_MODELS) for index in selected_indices],
    ]
    if not feature_indices:
        return np.zeros(x.shape[1], dtype=float), float(np.mean(y))
    selected_x = x[:, feature_indices]
    mean = np.mean(selected_x, axis=0)
    scale = np.std(selected_x, axis=0)
    scale = np.where(scale > 1e-9, scale, 1.0)
    normalized = (selected_x - mean) / scale
    design = np.column_stack([np.ones(len(normalized)), normalized])
    ridge_rows = np.column_stack([
        np.zeros(design.shape[1] - 1, dtype=float),
        np.eye(design.shape[1] - 1, dtype=float) * math.sqrt(float(regularization)),
    ])
    augmented_x = np.vstack([design, ridge_rows])
    augmented_y = np.concatenate([y, np.zeros(design.shape[1] - 1, dtype=float)])
    lower = np.full(design.shape[1], -np.inf, dtype=float)
    lower[1 : 1 + len(selected_indices)] = 0.0
    result = lsq_linear(
        augmented_x,
        augmented_y,
        bounds=(lower, np.full(design.shape[1], np.inf, dtype=float)),
        tol=1e-10,
        max_iter=2000,
        lsmr_tol="auto",
    )
    if not result.success:
        raise RuntimeError(f"active8_nonnegative_ridge_fit_failed:{result.status}")
    selected_weights = result.x[1:] / scale
    selected_weights[: len(selected_indices)] = np.maximum(
        selected_weights[: len(selected_indices)], 0.0
    )
    weights = np.zeros(x.shape[1], dtype=float)
    weights[feature_indices] = selected_weights
    intercept = float(result.x[0] - np.dot(mean, selected_weights))
    return weights, intercept


def _date_market_ic_values(
    prediction: np.ndarray,
    target: np.ndarray,
    dates: np.ndarray,
    markets: np.ndarray,
) -> list[float]:
    daily_values: list[float] = []
    for prediction_date in sorted(set(dates.tolist())):
        market_values: list[float] = []
        date_mask = dates == prediction_date
        for market in sorted(set(markets[date_mask].tolist())):
            mask = date_mask & (markets == market)
            if int(mask.sum()) >= 3:
                market_values.append(_spearman(prediction[mask], target[mask]))
        if market_values:
            daily_values.append(float(np.mean(market_values)))
    return daily_values


def _equal_date_market_ic(
    prediction: np.ndarray,
    target: np.ndarray,
    dates: np.ndarray,
    markets: np.ndarray,
) -> tuple[float, int]:
    """Equal-weight cross-sectional IC by PIT date, never pooled across dates."""

    daily_values = _date_market_ic_values(prediction, target, dates, markets)
    return (float(np.mean(daily_values)) if daily_values else 0.0, len(daily_values))


def _select_regularization(
    x: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    markets: np.ndarray,
    *,
    active_models: tuple[str, ...] | None = None,
) -> float:
    unique_dates = sorted(set(dates.tolist()))
    if len(unique_dates) < 5:
        return 1.0
    split = max(1, int(len(unique_dates) * 0.8))
    train_dates = set(unique_dates[:split])
    validation_dates = set(unique_dates[split:])
    train_idx = np.asarray([date in train_dates for date in dates], dtype=bool)
    validation_idx = np.asarray([date in validation_dates for date in dates], dtype=bool)
    if train_idx.sum() < 100 or validation_idx.sum() < 20:
        return 1.0
    candidates: list[tuple[float, float, float]] = []
    for regularization in RIDGE_CANDIDATES:
        weights, intercept = _fit_ridge(
            x[train_idx],
            y[train_idx],
            regularization,
            active_models=active_models,
        )
        prediction = x[validation_idx] @ weights + intercept
        ic, _ = _equal_date_market_ic(
            prediction,
            y[validation_idx],
            dates[validation_idx],
            markets[validation_idx],
        )
        mse = float(np.mean((prediction - y[validation_idx]) ** 2))
        candidates.append((ic, -mse, regularization))
    return max(candidates)[2]


def _fit_selected_ridge(
    x: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    markets: np.ndarray,
) -> tuple[np.ndarray, float, float, tuple[str, ...]]:
    """Use the convex nonnegative-ridge active set; no hand-ranked model quota."""

    regularization = _select_regularization(x, y, dates, markets)
    weights, intercept = _fit_ridge(x, y, regularization)
    selected_models = tuple(
        model_name
        for index, model_name in enumerate(ACTIVE8_MODELS)
        if float(weights[index]) > MODEL_WEIGHT_ZERO_TOLERANCE
    )
    if not selected_models:
        return (
            np.zeros(x.shape[1], dtype=float),
            float(np.mean(y)),
            regularization,
            selected_models,
        )
    if len(selected_models) != len(ACTIVE8_MODELS):
        regularization = _select_regularization(
            x,
            y,
            dates,
            markets,
            active_models=selected_models,
        )
        weights, intercept = _fit_ridge(
            x,
            y,
            regularization,
            active_models=selected_models,
        )
    return weights, intercept, regularization, selected_models


def _rank_by_date_market(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, str], list[int]] = defaultdict(list)
    for idx, row in enumerate(rows):
        groups[(row["prediction_date"], row["market_segment"])].append(idx)
    for indices in groups.values():
        if len(indices) == 1:
            rows[indices[0]]["ensemble_rank"] = 0.5
            continue
        values = np.asarray([rows[idx]["ensemble_raw"] for idx in indices], dtype=float)
        ranks = _average_rank(values)
        for idx, rank in zip(indices, ranks):
            rows[idx]["ensemble_rank"] = float(rank / (len(indices) - 1))


def _rerank_models_on_available_universe(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, str], list[int]] = defaultdict(list)
    for idx, row in enumerate(rows):
        groups[(row["prediction_date"], row["market_segment"])].append(idx)
    for indices in groups.values():
        for model_idx, model_name in enumerate(ACTIVE8_MODELS):
            available = [idx for idx in indices if row_model_available(rows[idx], model_name)]
            if len(available) == 1:
                rows[available[0]]["x"][model_idx] = 0.5
                continue
            values = np.asarray(
                [rows[idx]["raw_by_model"][model_name] for idx in available],
                dtype=float,
            )
            ranks = _average_rank(values)
            for idx, rank in zip(available, ranks):
                rows[idx]["x"][model_idx] = float(rank / (len(available) - 1))


def row_model_available(row: dict[str, Any], model_name: str) -> bool:
    return bool(row.get("model_availability", {}).get(model_name))

def build_chronological_oof_stack(
    prediction_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Stack PIT model ranks with explicit availability and resolved prior folds."""

    grouped: dict[tuple[str, str, str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    fold_ranges: dict[str, tuple[str, str]] = {}
    duplicate_rows = 0
    for row in prediction_rows:
        model = str(row.get("model_name") or "")
        if model not in ACTIVE8_MODELS:
            continue
        key = (
            str(row.get("fold_id") or ""),
            str(row.get("prediction_date") or "")[:10],
            str(row.get("symbol") or ""),
            str(row.get("market_segment") or "TW"),
        )
        if not all(key):
            continue
        if model in grouped[key]:
            duplicate_rows += 1
            continue
        grouped[key][model] = row
        fold_ranges[key[0]] = (
            str(row.get("test_start") or key[1])[:10],
            str(row.get("test_end") or key[1])[:10],
        )

    candidates: list[dict[str, Any]] = []
    incomplete = 0
    partial_used = 0
    rejected_core_model_rows = 0
    missing_by_model: dict[str, int] = defaultdict(int)
    max_target_lineage_drift = 0.0
    for (fold_id, prediction_date, symbol, market), models in grouped.items():
        available_models = [name for name in ACTIVE8_MODELS if name in models]
        missing_models = [name for name in ACTIVE8_MODELS if name not in models]
        if missing_models:
            incomplete += 1
            for model_name in missing_models:
                missing_by_model[model_name] += 1
        if any(model_name not in models for model_name in CORE_CROSS_SECTIONAL_MODELS):
            rejected_core_model_rows += 1
            continue
        if missing_models:
            partial_used += 1
        target_values = [float(models[name]["target_return"]) for name in available_models]
        target_drift = max(target_values) - min(target_values)
        max_target_lineage_drift = max(max_target_lineage_drift, target_drift)
        known_dates = {str(models[name]["label_known_date"])[:10] for name in available_models}
        if target_drift > TARGET_AGREEMENT_TOLERANCE or len(known_dates) != 1:
            raise ValueError(
                "active8_oof_target_lineage_disagreement:"
                f"{fold_id}:{prediction_date}:{symbol}:"
                f"drift={target_drift:.12g}:known={','.join(sorted(known_dates))}"
            )
        label_known_date = next(iter(known_dates))
        if label_known_date <= prediction_date:
            raise ValueError("active8_oof_label_known_date_not_after_prediction")
        artifact_versions = {
            name: str(models[name].get("artifact_version") or "").strip()
            for name in available_models
        }
        if any(not version for version in artifact_versions.values()):
            raise ValueError("active8_oof_artifact_version_missing")
        availability = {name: name in models for name in ACTIVE8_MODELS}
        candidates.append({
            "fold_id": fold_id,
            "prediction_date": prediction_date,
            "symbol": symbol,
            "market_segment": market,
            "label_known_date": label_known_date,
            "target_return": float(np.mean(target_values)),
            "x": np.concatenate([
                np.full(len(ACTIVE8_MODELS), 0.5, dtype=float),
                np.asarray([1.0 if availability[name] else 0.0 for name in ACTIVE8_MODELS]),
            ]),
            "raw_by_model": {
                name: float(models[name].get("raw_score", models[name]["rank_score"]))
                for name in available_models
            },
            "artifact_versions": artifact_versions,
            "model_availability": availability,
        })

    if duplicate_rows:
        raise ValueError(f"active8_oof_duplicate_model_rows:{duplicate_rows}")
    _rerank_models_on_available_universe(candidates)
    fold_order = sorted(fold_ranges, key=lambda fold: (fold_ranges[fold][0], fold))
    output: list[dict[str, Any]] = []
    fold_evidence: list[dict[str, Any]] = []
    for fold_id in fold_order:
        current = [row for row in candidates if row["fold_id"] == fold_id]
        if not current:
            continue
        fold_rows = []
        date_states: list[dict[str, Any]] = []
        for prediction_date in sorted({row["prediction_date"] for row in current}):
            current_date_rows = [row for row in current if row["prediction_date"] == prediction_date]
            prior = [
                row for row in candidates
                if row["prediction_date"] < prediction_date
                and row["label_known_date"] < prediction_date
            ]
            train_dates = sorted({row["prediction_date"] for row in prior})
            ready = len(prior) >= MIN_STACKER_TRAIN_ROWS and len(train_dates) >= MIN_STACKER_TRAIN_DATES
            if ready:
                x_train = np.vstack([row["x"] for row in prior])
                y_train = np.asarray([row["target_return"] for row in prior], dtype=float)
                dates_train = np.asarray([row["prediction_date"] for row in prior], dtype=object)
                markets_train = np.asarray(
                    [row["market_segment"] for row in prior], dtype=object
                )
                weights, intercept, regularization, selected_models = _fit_selected_ridge(
                    x_train, y_train, dates_train, markets_train
                )
                source = (
                    "chronological_resolved_oof_nonnegative_ridge"
                    if selected_models
                    else "chronological_no_positive_model_abstention"
                )
            else:
                regularization = None
                selected_models = tuple(ACTIVE8_MODELS)
                weights = np.concatenate([
                    np.full(len(ACTIVE8_MODELS), 1.0 / len(ACTIVE8_MODELS), dtype=float),
                    np.zeros(len(ACTIVE8_MODELS), dtype=float),
                ])
                intercept = 0.0
                source = "warmup_equal_weight_baseline"
            for row in current_date_rows:
                fold_rows.append({
                    **{key: value for key, value in row.items() if key not in {"x", "raw_by_model"}},
                    "ensemble_raw": float(row["x"] @ weights + intercept),
                    "stacker_features": row["x"].tolist(),
                    "stacker_source": source,
                    "eligible_for_efficacy": ready,
                    "stacker_semantic_version": STACKER_SEMANTIC_VERSION,
                })
            date_states.append({
                "prediction_date": prediction_date,
                "train_rows": len(prior),
                "train_dates": len(train_dates),
                "eligible_for_efficacy": ready,
                "regularization": regularization,
                "selected_models": list(selected_models),
                "intercept": intercept,
                "weights": dict(zip(STACKER_FEATURE_NAMES, weights.tolist())),
                "source": source,
            })
        _rank_by_date_market(fold_rows)
        output.extend(fold_rows)
        ready_states = [state for state in date_states if state["eligible_for_efficacy"]]
        latest_state = date_states[-1]
        sources = {state["source"] for state in date_states}
        fold_evidence.append({
            "fold_id": fold_id,
            "train_rows": latest_state["train_rows"],
            "train_dates": latest_state["train_dates"],
            "eligible_for_efficacy": bool(ready_states),
            "eligible_dates": len(ready_states),
            "source": next(iter(sources)) if len(sources) == 1 else "mixed_chronological_states",
            "date_states": date_states,
        })
    return output, {
        "schema_version": "active8-oof-stacker-evidence-v1",
        "stacker_semantic_version": STACKER_SEMANTIC_VERSION,
        "input_rows": len(prediction_rows),
        "complete_candidate_rows": sum(
            1 for row in candidates if all(row["model_availability"].values())
        ),
        "eligible_candidate_rows": len(candidates),
        "partial_candidate_rows_used": partial_used,
        "rejected_core_model_rows": rejected_core_model_rows,
        "incomplete_candidate_rows": incomplete,
        "complete_candidate_coverage": round(
            sum(1 for row in candidates if all(row["model_availability"].values()))
            / max(1, len(grouped)),
            6,
        ),
        "eligible_candidate_coverage": round(len(candidates) / max(1, len(grouped)), 6),
        "missing_by_model": dict(sorted(missing_by_model.items())),
        "target_agreement_tolerance": TARGET_AGREEMENT_TOLERANCE,
        "max_target_lineage_drift": max_target_lineage_drift,
        "common_universe_rank_semantic": "same-date-market-available-model-percentile-with-missingness-v3",
        "output_rows": len(output),
        "efficacy_rows": sum(1 for row in output if row["eligible_for_efficacy"]),
        "folds": fold_evidence,
    }
