"""V2 rank stacking meta-learner.

The production contract is rank-regression:
  - Level-0 inputs are model rank scores in [0, 1].
  - Level-1 output is a stacked rank score in [0, 1].
  - Missing model scores are neutral 0.5.

Legacy direction APIs are kept only as compatibility wrappers for old /predict.
"""

from __future__ import annotations

import io
import json
import logging
from typing import Optional

import numpy as np

from .model_pool import ALPHA_PREDICTION_MODELS

logger = logging.getLogger(__name__)

MODEL_ORDER = list(ALPHA_PREDICTION_MODELS)
META_FEATURE_DIM = len(MODEL_ORDER)
STACKER_VERSION = "v2_rank_stacker"


def _resolve_model_order(model_order: list[str] | None = None) -> list[str]:
    order = [name for name in (model_order or MODEL_ORDER) if name]
    return order or list(MODEL_ORDER)


def build_rank_meta_features(
    rank_scores: dict[str, float],
    model_order: list[str] | None = None,
) -> np.ndarray:
    """Build one rank feature per model; missing inputs are neutral."""
    order = _resolve_model_order(model_order)
    return np.array(
        [float(np.clip(rank_scores.get(name, 0.5), 0.0, 1.0)) for name in order],
        dtype=np.float32,
    )


def _rows_to_matrix(
    rows: list[dict[str, float]] | np.ndarray,
    model_order: list[str],
) -> np.ndarray:
    if isinstance(rows, np.ndarray):
        arr = np.asarray(rows, dtype=np.float32)
        if arr.ndim != 2:
            raise ValueError("rank score matrix must be 2D")
        if arr.shape[1] != len(model_order):
            raise ValueError(f"rank score width {arr.shape[1]} != model_order {len(model_order)}")
        return np.clip(arr, 0.0, 1.0)
    if not rows:
        return np.empty((0, len(model_order)), dtype=np.float32)
    return np.vstack([build_rank_meta_features(row, model_order) for row in rows]).astype(np.float32)


def build_oos_rank_rows(
    oos_rank_predictions: dict[str, np.ndarray],
    target_len: int,
    model_order: list[str] | None = None,
    min_models: int = 2,
) -> tuple[list[dict[str, float]], list[str]]:
    """Align OOS rank predictions into row-wise stacker training inputs."""
    preferred_order = _resolve_model_order(model_order)
    selected_order: list[str] = []
    cleaned: dict[str, np.ndarray] = {}
    for name in preferred_order:
        if name not in oos_rank_predictions:
            continue
        arr = np.asarray(oos_rank_predictions[name], dtype=float).reshape(-1)
        if len(arr) != target_len:
            raise ValueError(f"{name} OOS prediction length {len(arr)} != target length {target_len}")
        selected_order.append(name)
        cleaned[name] = np.clip(arr, 0.0, 1.0)

    if len(selected_order) < min_models:
        return [], selected_order

    rows = [
        {name: float(cleaned[name][i]) for name in selected_order}
        for i in range(target_len)
    ]
    return rows, selected_order


def train_rank_stacker_oof(
    oof_rank_scores: list[dict[str, float]] | np.ndarray,
    target_rank: np.ndarray,
    model_order: list[str] | None = None,
    min_samples: int = 80,
) -> Optional[dict]:
    """Train an honest v2 rank stacker from OOF base-model rank scores."""
    from scipy.stats import spearmanr
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler

    order = _resolve_model_order(model_order)
    X = _rows_to_matrix(oof_rank_scores, order)
    y = np.asarray(target_rank, dtype=np.float32).reshape(-1)
    valid = np.isfinite(y)
    if len(X) != len(y):
        raise ValueError(f"rank score rows {len(X)} != targets {len(y)}")
    X, y = X[valid], y[valid]
    y = np.clip(y, 0.0, 1.0)
    if len(X) < min_samples:
        logger.info("[RankStacking] insufficient OOF samples: %s < %s", len(X), min_samples)
        return None

    split = max(1, int(len(X) * 0.8))
    if len(X) - split < 10:
        split = max(1, len(X) - 10)
    X_train, X_eval = X[:split], X[split:]
    y_train, y_eval = y[:split], y[split:]

    scaler = StandardScaler()
    Xs_train = scaler.fit_transform(X_train)
    model = RidgeCV(alphas=np.array([0.01, 0.1, 1.0, 10.0], dtype=np.float64))
    model.fit(Xs_train, y_train)

    eval_ic = None
    eval_rmse = None
    if len(X_eval) > 0:
        pred_eval = np.clip(model.predict(scaler.transform(X_eval)), 0.0, 1.0)
        eval_rmse = float(np.sqrt(np.mean((pred_eval - y_eval) ** 2)))
        if len(np.unique(y_eval)) > 1 and len(np.unique(pred_eval)) > 1:
            eval_ic = float(spearmanr(pred_eval, y_eval).correlation)

    full_scaler = StandardScaler()
    full_model = RidgeCV(alphas=np.array([0.01, 0.1, 1.0, 10.0], dtype=np.float64))
    full_model.fit(full_scaler.fit_transform(X), y)

    return {
        "model": full_model,
        "scaler": full_scaler,
        "model_order": order,
        "meta_feature_dim": len(order),
        "target_type": "rank",
        "model_family": "ridge_rank_stacker",
        "stacker_version": STACKER_VERSION,
        "train_samples": int(len(X)),
        "eval_samples": int(len(X_eval)),
        "eval_ic": None if eval_ic is None or not np.isfinite(eval_ic) else round(eval_ic, 4),
        "eval_rmse": None if eval_rmse is None else round(eval_rmse, 4),
    }


def rank_meta_predict(rank_scores: dict[str, float], bundle: dict | None) -> float | None:
    """Return stacked rank in [0, 1], or None when no valid bundle exists."""
    if not bundle or bundle.get("target_type") != "rank":
        return None
    try:
        order = _resolve_model_order(bundle.get("model_order"))
        feat = build_rank_meta_features(rank_scores, order).reshape(1, -1)
        scaled = bundle["scaler"].transform(feat)
        return float(np.clip(bundle["model"].predict(scaled)[0], 0.0, 1.0))
    except Exception as e:
        logger.warning("[RankStacking] rank_meta_predict failed: %s", e)
        return None


def apply_rank_stacker(
    rank_scores: dict[str, float],
    bundle: dict | None,
    ic_weights: dict[str, float] | None = None,
    min_eval_ic: float = 0.0,
) -> tuple[dict[str, float], dict[str, float], dict]:
    """Append a validated v2 rank stacker score for rank_to_signal."""
    scores_out = dict(rank_scores)
    weights_out = dict(ic_weights or {})
    if not bundle or bundle.get("target_type") != "rank":
        return scores_out, weights_out, {"applied": False, "reason": "not_v2_rank_bundle"}

    eval_ic_raw = bundle.get("eval_ic")
    try:
        eval_ic = float(eval_ic_raw)
    except (TypeError, ValueError):
        eval_ic = 0.0
    if not np.isfinite(eval_ic) or eval_ic <= min_eval_ic:
        return scores_out, weights_out, {"applied": False, "reason": "non_positive_eval_ic", "eval_ic": eval_ic_raw}

    stacked_rank = rank_meta_predict(rank_scores, bundle)
    if stacked_rank is None:
        return scores_out, weights_out, {"applied": False, "reason": "prediction_failed", "eval_ic": eval_ic}

    scores_out["StackingRank"] = float(np.clip(stacked_rank, 0.0, 1.0))
    weights_out["StackingRank"] = eval_ic
    return scores_out, weights_out, {
        "applied": True,
        "rank": scores_out["StackingRank"],
        "eval_ic": eval_ic,
        "model_order": _resolve_model_order(bundle.get("model_order")),
    }


def build_meta_features(predictions: list, model_order: list[str] | None = None) -> np.ndarray:
    """Compatibility feature builder for legacy direction stacker callers."""
    order = _resolve_model_order(model_order)
    pred_map = {p.model_name: p for p in predictions}
    meta: list[float] = []
    for name in order:
        p = pred_map.get(name)
        if p is None:
            meta.extend([0.5, 0.0, 0.5])
        else:
            up_prob = p.confidence if p.direction == "up" else (1.0 - p.confidence)
            pct_norm = min(abs(float(p.forecast_pct)) * 20.0, 1.0)
            meta.extend([float(up_prob), pct_norm, float(p.confidence)])
    return np.array(meta, dtype=float)


def meta_predict(predictions: list, bundle: dict | None) -> tuple[str | None, float | None]:
    """Compatibility wrapper for legacy weighted_vote direction correction."""
    if bundle is None:
        return None, None
    try:
        if bundle.get("target_type") == "rank":
            rank_scores = {}
            for p in predictions:
                if p.direction == "up":
                    rank_scores[p.model_name] = float(np.clip(p.confidence, 0.0, 1.0))
                else:
                    rank_scores[p.model_name] = float(np.clip(1.0 - p.confidence, 0.0, 1.0))
            rank = rank_meta_predict(rank_scores, bundle)
            if rank is None:
                return None, None
            return ("up" if rank > 0.5 else "down"), max(rank, 1.0 - rank)

        model_order = bundle.get("model_order") if isinstance(bundle, dict) else None
        feat = build_meta_features(predictions, model_order=model_order).reshape(1, -1)
        scaled = bundle["scaler"].transform(feat)
        proba = bundle["model"].predict_proba(scaled)[0]
        up_p = float(proba[1])
        return ("up" if up_p > 0.5 else "down"), max(up_p, 1.0 - up_p)
    except Exception as e:
        logger.warning("[Stacking] meta_predict failed: %s", e)
        return None, None


def train_meta_learner_oof(
    X: np.ndarray,
    y: np.ndarray,
    prices: np.ndarray,
    feature_names: list,
    stock_id: int,
) -> Optional[dict]:
    """Compatibility entrypoint.

    The old implementation trained a binary direction classifier here. That is
    intentionally removed. Call train_rank_stacker_oof() with OOF rank scores.
    """
    logger.info(
        "[RankStacking] train_meta_learner_oof is disabled for raw feature matrices; "
        "use train_rank_stacker_oof with OOF rank scores"
    )
    return None


def save_meta_learner(bundle: dict, stock_id: int) -> bool:
    from .model_store import _get_bucket

    try:
        import datetime as _dt
        import joblib

        bucket = _get_bucket()
        if not bucket:
            return False
        buf = io.BytesIO()
        joblib.dump(bundle, buf)
        buf.seek(0)
        bucket.blob(f"{stock_id}/stacking_meta.joblib").upload_from_file(buf)
        model_order = _resolve_model_order(bundle.get("model_order") if isinstance(bundle, dict) else None)
        meta = {
            "stock_id": stock_id,
            "trained_at": _dt.datetime.utcnow().isoformat(),
            "meta_feature_dim": int(bundle.get("meta_feature_dim") or len(model_order)),
            "model_order": model_order,
            "model_count": len(model_order),
            "target_type": bundle.get("target_type", "rank"),
            "model_family": bundle.get("model_family", "ridge_rank_stacker"),
            "stacker_version": bundle.get("stacker_version", STACKER_VERSION),
            "eval_ic": bundle.get("eval_ic"),
            "eval_rmse": bundle.get("eval_rmse"),
        }
        bucket.blob(f"{stock_id}/metadata_stacking.json").upload_from_string(
            json.dumps(meta),
            content_type="application/json",
        )
        logger.info("[RankStacking] saved stock %s meta-learner to GCS", stock_id)
        return True
    except Exception as e:
        logger.error("[RankStacking] GCS save failed: %s", e)
        return False


def load_meta_learner(stock_id: int) -> Optional[dict]:
    from .model_store import _get_bucket, is_model_fresh

    try:
        import joblib

        bucket = _get_bucket()
        if not bucket:
            return None
        meta_blob = bucket.blob(f"{stock_id}/metadata_stacking.json")
        if not meta_blob.exists():
            return None
        meta = json.loads(meta_blob.download_as_text())
        if not is_model_fresh({"trained_at": meta.get("trained_at", "")}, max_age_days=10):
            return None
        model_blob = bucket.blob(f"{stock_id}/stacking_meta.joblib")
        if not model_blob.exists():
            return None
        buf = io.BytesIO()
        model_blob.download_to_file(buf)
        buf.seek(0)
        bundle = joblib.load(buf)
        if isinstance(bundle, dict):
            bundle.setdefault("model_order", meta.get("model_order") or list(MODEL_ORDER))
            bundle.setdefault("meta_feature_dim", meta.get("meta_feature_dim") or len(bundle["model_order"]))
            bundle.setdefault("target_type", meta.get("target_type", "rank"))
            bundle.setdefault("stacker_version", meta.get("stacker_version", STACKER_VERSION))
        logger.info("[RankStacking] loaded stock %s meta-learner from GCS", stock_id)
        return bundle
    except Exception as e:
        logger.warning("[RankStacking] GCS load failed: %s", e)
        return None
