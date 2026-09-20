"""Full-L3 conditional return model. Inference never reads outcomes or refits.

The three heads preserve the independently regularized research recipe. Returns
are five-session gross decimal returns; the allocation owner accounts for costs.
"""
from __future__ import annotations

from collections import Counter
from datetime import date
import hashlib
import json
import math
from typing import Any

import numpy as np
from services.alpha_model_roster import model_order, LEGACY_MODELS

SCHEMA = "l4-distribution-v1"
FEATURE_SCHEMA = "full-l3-30-all-available-signals-v3"
LABEL_SCHEMA = "next-open-fifth-close-gross-v1"
OWNER = "l4_distribution"
MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN",
          "DLinear", "PatchTST", "iTransformer")
HEADS = ("p_loss", "gain", "loss")
TIMEXER_FEATURE_SCHEMA = "full-l3-30-timexer-signals-v4"


def feature_names(order):
    # The replacement changes identity, not the physical input coordinate. This
    # also preserves seeded MLP initialization against the accepted research.
    from services.alpha_model_roster import validate_order
    order = validate_order(order)
    names = sorted([f"{model}_{suffix}" for model in LEGACY_MODELS
                    for suffix in ("raw", "rank", "available")] +
                   ["ml_edge_norm", "ensemble_directional_margin", "l3_rank_mean",
                    "l3_rank_sd", "l3_rank_range", "l3_available_fraction"])
    return [name.replace("DLinear_", "TimeXer_") for name in names] if "TimeXer" in order else names


FEATURE_NAMES = feature_names(MODELS)


def feature_order(source):
    return model_order(name.removesuffix("_available") for name in source
                       if name.endswith("_available"))


def feature_schema(order):
    return FEATURE_SCHEMA if tuple(order) == LEGACY_MODELS else TIMEXER_FEATURE_SCHEMA


def recipe_order(recipe):
    order = feature_order(recipe.get("names") or [])
    if recipe.get("names") != feature_names(order):
        raise ValueError("l4_distribution_feature_order_mismatch")
    return order


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def finite(value: Any, field: str) -> float:
    if value is None or isinstance(value, bool):
        raise ValueError(f"l4_distribution_invalid:{field}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"l4_distribution_nonfinite:{field}")
    return number


def features(source: dict) -> dict[str, float | None]:
    """Missing optional models have an explicit mask, never invented forecasts."""
    order = feature_order(source)
    result: dict[str, float | None] = {}
    ranks = []
    for model in order:
        available = source.get(f"{model}_available")
        if available not in (0, 1) or available is None:
            raise ValueError(f"l4_distribution_mask_missing:{model}")
        result[f"{model}_available"] = float(available)
        for suffix in ("raw", "rank"):
            key = f"{model}_{suffix}"
            value = source.get(key)
            if available:
                value = finite(value, key)
                if suffix == "rank" and not 0 <= value <= 1:
                    raise ValueError(f"l4_distribution_rank_range:{model}")
            elif value is not None:
                raise ValueError(f"l4_distribution_masked_forecast:{model}")
            result[key] = value
        if available:
            ranks.append(result[f"{model}_rank"])
    if not ranks:
        raise ValueError("l4_distribution_no_l3_evidence")
    result.update(ml_edge_norm=finite(source.get("ml_edge_norm"), "ml_edge_norm"),
                  ensemble_directional_margin=finite(source.get("ensemble_directional_margin"), "margin"),
                  l3_rank_mean=float(np.mean(ranks)), l3_rank_sd=float(np.std(ranks)),
                  l3_rank_range=float(np.ptp(ranks)), l3_available_fraction=len(ranks) / len(order))
    return result


def date_weights(rows: list[dict]) -> np.ndarray:
    counts = Counter(row["date"] for row in rows)
    values = np.asarray([1 / counts[row["date"]] for row in rows])
    return values / values.sum()


def design(rows: list[dict], recipe: dict | None = None) -> tuple[np.ndarray, dict]:
    if not rows:
        raise ValueError("l4_distribution_empty_design")
    order = recipe_order(recipe) if recipe is not None else feature_order(rows[0]["features"])
    if any(feature_order(row["features"]) != order for row in rows):
        raise ValueError("l4_distribution_input_roster_mismatch")
    names = feature_names(order)
    extracted = [features(row["features"]) for row in rows]
    raw = np.array([[row[name] for name in names] for row in extracted], float)
    if recipe is None:
        weights = date_weights(rows)[:, None]
        observed = np.isfinite(raw)
        safe = np.where(observed, raw, 0)
        denominator = (weights * observed).sum(0)
        mean = (weights * safe).sum(0) / np.maximum(denominator, 1e-15)
        variance = (weights * np.where(observed, (safe - mean) ** 2, 0)).sum(0) / np.maximum(denominator, 1e-15)
        recipe = {"names": names, "mean": mean.tolist(),
                  "scale": np.maximum(np.sqrt(variance), .001).tolist(),
                  "observed_weight": denominator.tolist()}
    if recipe["names"] != names:
        raise ValueError("l4_distribution_feature_order_mismatch")
    mean, scale = np.asarray(recipe["mean"], float), np.asarray(recipe["scale"], float)
    if (mean.shape != (30,) or scale.shape != (30,) or not np.isfinite(mean).all()
            or not np.isfinite(scale).all() or (scale <= 0).any()):
        raise ValueError("l4_distribution_scaler_invalid")
    matrix = (np.where(np.isfinite(raw), raw, mean) - mean) / scale
    return matrix, recipe


def predict_head(matrix: np.ndarray, head: dict) -> np.ndarray:
    from scipy.special import expit
    coefficients = np.asarray(head["beta"], float)
    if coefficients.shape != (30,) or not np.isfinite(coefficients).all():
        raise ValueError("l4_distribution_coefficients_invalid")
    value = finite(head["intercept"], "intercept") + matrix @ coefficients
    return expit(value) if head["head"] == "p_loss" else np.maximum(0, value)


def predict(rows: list[dict], model: dict) -> list[dict]:
    if not rows:
        return []
    matrix, _ = design(rows, model["recipe"])
    if any(model["heads"][name]["head"] != name for name in HEADS):
        raise ValueError("l4_distribution_head_identity_mismatch")
    predictions = {name: predict_head(matrix, model["heads"][name]) for name in HEADS}
    gross = (1 - predictions["p_loss"]) * predictions["gain"] - predictions["p_loss"] * predictions["loss"]
    output = [{**{name: float(values[i]) for name, values in predictions.items()},
             "expected_return_gross": float(gross[i]), "output_is_net_of_costs": False,
             "horizon_sessions": 5, "l4plus_status": "disabled"} for i in range(len(rows))]
    if model.get("residual_mlp") is not None:
        from services.l4_residual_mlp import apply
        return apply(rows, output, model["residual_mlp"],
                     anchor_model={key:model[key] for key in ("recipe", "heads")})
    return output


def validate_bundle(bundle: dict, *, l3_identity: dict, signal_date: str,
                    require_paper_release: bool = True) -> None:
    order = recipe_order(bundle.get("model", {}).get("recipe", {}))
    if (bundle.get("schema_version") != SCHEMA or bundle.get("feature_schema") != feature_schema(order)
            or bundle.get("label_schema") != LABEL_SCHEMA or bundle.get("horizon_sessions") != 5):
        raise ValueError("l4_distribution_contract_mismatch")
    if not l3_identity or bundle.get("l3_identity") != l3_identity:
        raise ValueError("l4_distribution_l3_version_mismatch")
    cutoff = date.fromisoformat(bundle["training_label_known_max"])
    if cutoff >= date.fromisoformat(signal_date):
        raise ValueError("l4_distribution_training_after_decision")
    if bundle.get("model_checksum") != digest(bundle["model"]):
        raise ValueError("l4_distribution_model_checksum_mismatch")
    if bundle.get("l4plus", {}).get("enabled") is True:
        raise ValueError("l4_distribution_unvalidated_calibrator")
    if bundle['model'].get('residual_mlp') is not None:
        from services.l4_residual_mlp import validate
        mlp = bundle['model']['residual_mlp']
        validate(mlp, anchor_model={key:bundle['model'][key] for key in ('recipe','heads')}, signal_date=signal_date)
        if mlp['training_label_known_max'] > bundle['training_label_known_max']:
            raise ValueError('l4_distribution_training_cutoff_omits_mlp')
    # A numeric recipe alone is never enough: inspect all heads before activation.
    recipe = bundle['model']['recipe']
    recipe_order(recipe)
    for name in HEADS:
        head = bundle['model']['heads'][name]
        if head.get('head') != name:
            raise ValueError('l4_distribution_head_identity_mismatch')
        predict_head(np.zeros((1,30)),head)
    for key in ('mean','scale'):
        values = np.asarray(recipe[key],float)
        if values.shape!=(30,) or not np.isfinite(values).all() or (key=='scale' and (values<=0).any()):
            raise ValueError('l4_distribution_scaler_invalid')
    if require_paper_release:
        release = bundle.get("release") or {}
        if (release.get("scope") != "paper" or release.get("decision") != "PASS"
                or release.get("model_checksum") != bundle["model_checksum"]
                or release.get("l3_identity_checksum") != digest(l3_identity)
                or not release.get("validation_receipt_checksum")):
            raise ValueError("l4_distribution_paper_release_missing")
        receipt = release.get('validation_receipt') or {}
        from services.l4_distribution_lifecycle import validate_acceptance
        validate_acceptance(receipt,bundle)
        if release['validation_receipt_checksum'] != digest(receipt):
            raise ValueError("l4_distribution_paper_release_missing")


def fit_head(matrix: np.ndarray, target: np.ndarray, weights: np.ndarray,
             regularization: float, name: str) -> dict:
    from scipy.optimize import minimize
    from scipy.special import expit
    if name == "p_loss":
        binary = (target < 0).astype(float)
        prevalence = float(weights @ binary)
        if not 0 < prevalence < 1:
            raise ValueError("l4_distribution_training_requires_both_outcomes")
        def objective(theta):
            eta = theta[0] + matrix @ theta[1:]
            residual = weights * (expit(eta) - binary)
            return (float(weights @ (np.logaddexp(0, eta) - binary * eta)
                          + .5 * regularization * (theta[1:] @ theta[1:])),
                    np.r_[residual.sum(), matrix.T @ residual + regularization * theta[1:]])
        result = minimize(objective, np.r_[math.log(prevalence / (1 - prevalence)), np.zeros(30)],
                          jac=True, method="L-BFGS-B", options={"maxiter": 700, "ftol": 1e-12, "gtol": 1e-8})
        if not result.success:
            raise ValueError("l4_distribution_classifier_not_converged")
        intercept, beta = result.x[0], result.x[1:]
    else:
        mask = target < 0 if name == "loss" else target >= 0
        if not mask.any():
            raise ValueError("l4_distribution_conditional_outcome_missing")
        xx = matrix[mask]
        yy = -target[mask] if name == "loss" else target[mask]
        ww = weights[mask] / weights[mask].sum()
        mean, target_mean = ww @ xx, float(ww @ yy)
        centered = xx - mean
        beta = np.linalg.solve(centered.T @ (ww[:, None] * centered) + regularization * np.eye(30),
                               centered.T @ (ww * (yy - target_mean)))
        intercept = target_mean - mean @ beta
    return {"head": name, "beta": beta.tolist(), "intercept": float(intercept), "lambda": regularization}


def head_loss(target, prediction, weights, name):
    if name == "p_loss":
        clipped = np.clip(prediction, 1e-12, 1 - 1e-12)
        binary = (target < 0).astype(float)
        return float(weights @ (-binary * np.log(clipped) - (1 - binary) * np.log1p(-clipped)))
    mask = target < 0 if name == "loss" else target >= 0
    if not mask.any():
        raise ValueError("l4_distribution_validation_outcome_missing")
    observed = -target[mask] if name == "loss" else target[mask]
    return float(weights[mask] @ ((prediction[mask] - observed) ** 2) / weights[mask].sum())


def fit_candidate(rows: list[dict], *, l3_identity: dict, as_of: str,
                  validation_dates: list[list[str]], lambdas=(.01, .1, 1., 10.)) -> dict:
    """Explicit offline training entry point, never invoked by inference.

    All rows must be point-in-time OOF predictions with matured gross labels.
    A fitted candidate is not a serving release. No automatic promotion occurs.
    """
    if not rows or not validation_dates or not l3_identity:
        raise ValueError("l4_distribution_training_contract_missing")
    schema = feature_schema(feature_order(rows[0]["features"]))
    keys = set()
    for row in rows:
        key = (row["date"], row["symbol"])
        if key in keys:
            raise ValueError("l4_distribution_duplicate_training_row")
        keys.add(key)
        if (row.get("feature_schema") != schema or row.get("prediction_kind") != "oof" or row.get("l3_identity") != l3_identity
                or not row["l3_training_label_known_max"] < row["date"] < row["label_known_date"] < as_of):
            raise ValueError("l4_distribution_training_time_or_lineage_invalid")
        for key_date in (row["date"], row["label_known_date"], row["l3_training_label_known_max"], as_of):
            date.fromisoformat(key_date)
        finite(row["gross_return"], "gross_return")
    folds = []
    seen_validation = set()
    for dates in validation_dates:
        if not dates or seen_validation.intersection(dates):
            raise ValueError("l4_distribution_validation_dates_invalid")
        seen_validation.update(dates)
        train = [row for row in rows if row["label_known_date"] < min(dates)]
        valid = [row for row in rows if row["date"] in dates]
        if not train or {row["date"] for row in valid} != set(dates):
            raise ValueError("l4_distribution_purged_fold_empty")
        tx, recipe = design(train)
        vx, _ = design(valid, recipe)
        folds.append((tx, np.array([r["gross_return"] for r in train]), date_weights(train),
                      vx, np.array([r["gross_return"] for r in valid]), date_weights(valid)))
    matrix, recipe = design(rows)
    target, weights = np.array([row["gross_return"] for row in rows]), date_weights(rows)
    heads, validation = {}, {}
    for name in HEADS:
        trials = []
        for penalty in lambdas:
            if not math.isfinite(penalty) or penalty <= 0:
                raise ValueError("l4_distribution_regularization_invalid")
            losses = [head_loss(vy, predict_head(vx, fit_head(tx, ty, tw, penalty, name)), vw, name)
                      for tx, ty, tw, vx, vy, vw in folds]
            trials.append({"lambda": penalty, "loss": float(np.mean(losses)), "fold_losses": losses})
        selected = min(trials, key=lambda row: (row["loss"], -row["lambda"]))
        heads[name] = fit_head(matrix, target, weights, selected["lambda"], name)
        validation[name] = {"trials": trials, "lambda": selected["lambda"]}
    model = {"recipe": recipe, "heads": heads}
    return {"schema_version": SCHEMA, "feature_schema": schema, "label_schema": LABEL_SCHEMA,
            "horizon_sessions": 5, "l3_identity": l3_identity, "model": model, "model_checksum": digest(model),
            "training_label_known_max": max(row["label_known_date"] for row in rows),
            "training_rows_checksum": digest(rows), "validation": validation,
            "validation_dates": validation_dates, "l4plus": {"enabled": False},
            "release": {"scope": "research", "decision": "CANDIDATE"}}
