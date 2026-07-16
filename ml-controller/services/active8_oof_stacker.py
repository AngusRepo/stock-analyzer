"""Chronological OOF stacking for the formal Active-8 model set."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

import numpy as np

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
STACKER_SEMANTIC_VERSION = "active8-purged-oof-chronological-ridge-v1"
MIN_STACKER_TRAIN_ROWS = 500
MIN_STACKER_TRAIN_DATES = 5
RIDGE_CANDIDATES = (0.01, 0.1, 1.0, 10.0)


def _spearman(left: np.ndarray, right: np.ndarray) -> float:
    if len(left) < 3 or len(left) != len(right):
        return 0.0
    left_rank = np.argsort(np.argsort(left, kind="mergesort"), kind="mergesort")
    right_rank = np.argsort(np.argsort(right, kind="mergesort"), kind="mergesort")
    if np.std(left_rank) <= 1e-12 or np.std(right_rank) <= 1e-12:
        return 0.0
    value = float(np.corrcoef(left_rank, right_rank)[0, 1])
    return value if math.isfinite(value) else 0.0


def _fit_ridge(x: np.ndarray, y: np.ndarray, regularization: float) -> tuple[np.ndarray, float]:
    mean = np.mean(x, axis=0)
    scale = np.std(x, axis=0)
    scale = np.where(scale > 1e-9, scale, 1.0)
    normalized = (x - mean) / scale
    design = np.column_stack([np.ones(len(normalized)), normalized])
    penalty = np.eye(design.shape[1], dtype=float) * float(regularization)
    penalty[0, 0] = 0.0
    coefficient = np.linalg.solve(design.T @ design + penalty, design.T @ y)
    raw_weights = coefficient[1:] / scale
    intercept = float(coefficient[0] - np.dot(mean, raw_weights))
    return raw_weights, intercept


def _select_regularization(x: np.ndarray, y: np.ndarray, dates: np.ndarray) -> float:
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
        weights, intercept = _fit_ridge(x[train_idx], y[train_idx], regularization)
        prediction = x[validation_idx] @ weights + intercept
        ic = _spearman(prediction, y[validation_idx])
        mse = float(np.mean((prediction - y[validation_idx]) ** 2))
        candidates.append((ic, -mse, regularization))
    return max(candidates)[2]


def _rank_by_date_market(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, str], list[int]] = defaultdict(list)
    for idx, row in enumerate(rows):
        groups[(row["prediction_date"], row["market_segment"])].append(idx)
    for indices in groups.values():
        ordered = sorted(indices, key=lambda idx: (rows[idx]["ensemble_raw"], rows[idx]["symbol"]))
        denominator = max(1, len(ordered) - 1)
        for rank, idx in enumerate(ordered):
            rows[idx]["ensemble_rank"] = 0.5 if len(ordered) == 1 else rank / denominator


def build_chronological_oof_stack(
    prediction_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Stack complete Active-8 rows while fitting only on resolved prior folds."""

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

    complete: list[dict[str, Any]] = []
    incomplete = 0
    for (fold_id, prediction_date, symbol, market), models in grouped.items():
        if set(models) != set(ACTIVE8_MODELS):
            incomplete += 1
            continue
        targets = {round(float(row["target_return"]), 12) for row in models.values()}
        known_dates = {str(row["label_known_date"])[:10] for row in models.values()}
        if len(targets) != 1 or len(known_dates) != 1:
            raise ValueError("active8_oof_target_lineage_disagreement")
        label_known_date = next(iter(known_dates))
        if label_known_date <= prediction_date:
            raise ValueError("active8_oof_label_known_date_not_after_prediction")
        artifact_versions = {
            name: str(models[name].get("artifact_version") or "").strip()
            for name in ACTIVE8_MODELS
        }
        if any(not version for version in artifact_versions.values()):
            raise ValueError("active8_oof_artifact_version_missing")
        complete.append({
            "fold_id": fold_id,
            "prediction_date": prediction_date,
            "symbol": symbol,
            "market_segment": market,
            "label_known_date": label_known_date,
            "target_return": next(iter(targets)),
            "x": np.asarray([float(models[name]["rank_score"]) for name in ACTIVE8_MODELS], dtype=float),
            "artifact_versions": artifact_versions,
        })

    if duplicate_rows:
        raise ValueError(f"active8_oof_duplicate_model_rows:{duplicate_rows}")
    if incomplete:
        raise ValueError(f"active8_oof_incomplete_active8_rows:{incomplete}")

    fold_order = sorted(fold_ranges, key=lambda fold: (fold_ranges[fold][0], fold))
    output: list[dict[str, Any]] = []
    fold_evidence: list[dict[str, Any]] = []
    for fold_id in fold_order:
        current = [row for row in complete if row["fold_id"] == fold_id]
        if not current:
            continue
        first_test_date = min(row["prediction_date"] for row in current)
        prior = [
            row for row in complete
            if row["fold_id"] != fold_id
            and fold_ranges[row["fold_id"]][0] < fold_ranges[fold_id][0]
            and row["label_known_date"] < first_test_date
        ]
        train_dates = sorted({row["prediction_date"] for row in prior})
        ready = len(prior) >= MIN_STACKER_TRAIN_ROWS and len(train_dates) >= MIN_STACKER_TRAIN_DATES
        if ready:
            x_train = np.vstack([row["x"] for row in prior])
            y_train = np.asarray([row["target_return"] for row in prior], dtype=float)
            dates_train = np.asarray([row["prediction_date"] for row in prior], dtype=object)
            regularization = _select_regularization(x_train, y_train, dates_train)
            weights, intercept = _fit_ridge(x_train, y_train, regularization)
            source = "chronological_prior_oof_ridge"
        else:
            regularization = None
            weights = np.full(len(ACTIVE8_MODELS), 1.0 / len(ACTIVE8_MODELS), dtype=float)
            intercept = 0.0
            source = "warmup_equal_weight_baseline"
        fold_rows = []
        for row in current:
            fold_rows.append({
                **{key: value for key, value in row.items() if key != "x"},
                "ensemble_raw": float(row["x"] @ weights + intercept),
                "stacker_source": source,
                "eligible_for_efficacy": ready,
                "stacker_semantic_version": STACKER_SEMANTIC_VERSION,
            })
        _rank_by_date_market(fold_rows)
        output.extend(fold_rows)
        fold_evidence.append({
            "fold_id": fold_id,
            "train_rows": len(prior),
            "train_dates": len(train_dates),
            "eligible_for_efficacy": ready,
            "regularization": regularization,
            "intercept": intercept,
            "weights": dict(zip(ACTIVE8_MODELS, weights.tolist())),
            "source": source,
        })
    return output, {
        "schema_version": "active8-oof-stacker-evidence-v1",
        "stacker_semantic_version": STACKER_SEMANTIC_VERSION,
        "input_rows": len(prediction_rows),
        "complete_candidate_rows": len(complete),
        "incomplete_candidate_rows": incomplete,
        "output_rows": len(output),
        "efficacy_rows": sum(1 for row in output if row["eligible_for_efficacy"]),
        "folds": fold_evidence,
    }
