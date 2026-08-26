"""
Prediction runtime use-case boundary.

Groups predict / retrain / ARF update flows under one stable owner surface so
Modal and other orchestrators do not couple directly to the FastAPI route
module layout.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Optional, TYPE_CHECKING

import numpy as np
import polars as pl
from pydantic import BaseModel

from .artifact_contract import ArtifactValidationError, now_utc_iso, validate_serving_feature_compatibility
from .arf_aggregator import (
    ARF_STATE_DIR,
    apply_arf_correction,
    build_arf_features,
    get_dynamic_min_obs,
    load_arf,
    save_arf,
)
from .features import FEATURE_SCHEMA, build_feature_matrix, close_or_adjusted, close_price, get_features, get_lgbm_features, safe_float
from .linucb_bandit import build_context, compute_dynamic_alpha, linucb_select, load_bandit
from .models import (
    run_dlinear,
    run_extra_trees,
    run_garch_volatility,
    run_kalman_filter,
    run_lightgbm,
    run_markov_switching,
    run_xgboost,
)
from .model_serving_contract import ALPHA_PREDICTION_MODELS, TIMESFM_L2_SIDECAR_MODELS
from .schemas import PredictRequest


class ARFUpdateRequest(BaseModel):
    arf_features: list[float]
    actual_up: bool
    model_name: Optional[str] = None
    hmm_regime: Optional[str] = None
    garch_vol: Optional[float] = None
    current_price: float = 1.0
    market_risk_score: float = 0.5
    actual_return_pct: Optional[float] = None
    realized_pnl_r: Optional[float] = None
    actual_return: float = 0.0
    forecast_pct: float = 0.0
    stock_id: int = 0
    symbol: str = ""


# 手續費 0.1425% + 賣出手續費 0.1425% + 證交稅 0.3% = 0.585%
FRICTION_COST_PCT = 0.00585

# Batch transport only.  Formal weighting and signals remain owned by the
# immutable Active-8 ensemble artifact in the Controller.
_MODEL_NAMES_V2 = list(ALPHA_PREDICTION_MODELS)
_FEATURE_MODEL_NAMES_V2 = list(ALPHA_PREDICTION_MODELS[:5])
_TIME_SERIES_MODEL_NAMES_V2 = list(ALPHA_PREDICTION_MODELS[5:])
_L2_FEATURE_SIDECAR_NAMES = list(TIMESFM_L2_SIDECAR_MODELS)
_MODEL_POOL_ALLOWED_STATUSES = {"active", "degraded", "challenger", "retired"}
_BATCH_FEATURE_RANK_SCORES_KEY = "__batch_feature_rank_scores"
_BATCH_FEATURE_MODEL_ERRORS_KEY = "__batch_feature_model_errors"
_BATCH_FEATURE_CONTEXT_KEY = "__batch_feature_context"
_BATCH_CHALLENGER_RANK_SCORES_KEY = "__batch_challenger_rank_scores"
_BATCH_CHALLENGER_MODEL_ERRORS_KEY = "__batch_challenger_model_errors"
_BATCH_MODEL_POOL_KEY = "__batch_model_pool"
_BATCH_RUNTIME_OPTION_KEYS = {
    _BATCH_FEATURE_RANK_SCORES_KEY,
    _BATCH_FEATURE_MODEL_ERRORS_KEY,
    _BATCH_FEATURE_CONTEXT_KEY,
    _BATCH_CHALLENGER_RANK_SCORES_KEY,
    _BATCH_CHALLENGER_MODEL_ERRORS_KEY,
    _BATCH_MODEL_POOL_KEY,
}


def _model_prediction_block_reason(prediction: Any) -> str | None:
    fallback_reason = getattr(prediction, "fallback_reason", None)
    if bool(getattr(prediction, "degraded", False)) or fallback_reason:
        return str(fallback_reason or "degraded_model_prediction")
    return None


def _actual_return_pct(req: ARFUpdateRequest) -> float:
    if req.actual_return_pct is not None:
        return float(req.actual_return_pct)
    return float(req.actual_return)


def update_arf(req: ARFUpdateRequest) -> dict:
    """Core ARF/LinUCB/FT online update logic."""
    if len(req.arf_features) == 0:
        raise ValueError("arf_features 不可為空")

    features = np.array(req.arf_features, dtype=np.float64)
    results: dict = {}
    actual_return_pct = _actual_return_pct(req)
    net_profitable = actual_return_pct > FRICTION_COST_PCT

    arf = load_arf(ARF_STATE_DIR)
    arf.update(features, net_profitable)
    save_arf(arf, ARF_STATE_DIR)
    results["arf"] = {
        "updated": True,
        "n_trained": arf.n_trained,
        "is_warmed_up": arf.is_warmed_up(),
    }

    if req.model_name:
        from .linucb_bandit import (
            DONOTHING_ARM_IDX,
            build_context,
            linucb_update,
            load_bandit,
            save_bandit,
        )

        bandit = load_bandit("/tmp/linucb_bandit")
        raw_reward = (
            float(
                np.clip(
                    actual_return_pct / max(abs(req.forecast_pct), 0.005),
                    0.0,
                    1.0,
                )
            )
            if net_profitable
            else 0.0
        )
        linucb_update(
            hmm_regime=req.hmm_regime,
            garch_vol=req.garch_vol,
            current_price=req.current_price,
            market_risk_score=req.market_risk_score,
            model_name=req.model_name,
            reward=raw_reward,
            bandit=bandit,
        )

        donothing_reward = 1.0 if actual_return_pct < -FRICTION_COST_PCT else 0.0
        ctx = build_context(
            req.hmm_regime,
            req.garch_vol,
            req.current_price,
            req.market_risk_score,
        )
        bandit.update(DONOTHING_ARM_IDX, ctx, donothing_reward)
        save_bandit(bandit, "/tmp/linucb_bandit")

        results["linucb"] = {
            "updated": True,
            "model_name": req.model_name,
            "donothing_reward": donothing_reward,
            "total_observations": bandit.total_observations(),
            "is_warmed_up": bandit.is_warmed_up(),
        }

    if req.forecast_pct:
        from . import conformal as _conformal

        conformal = _conformal.load_conformal()
        conformal.update(req.forecast_pct, actual_return_pct)
        saved = _conformal.save_conformal(conformal)
        results["conformal"] = {
            "updated": True,
            "n_residuals": len(getattr(conformal, "residuals", [])),
            **saved,
        }
    else:
        results["conformal"] = {
            "updated": False,
            "reason": "missing forecast_pct",
        }

    results["ft_online"] = {
        "updated": False,
        "reason": "FT-Transformer retired from alpha vote and online update path",
    }

    return {
        "updated_at": now_utc_iso(),
        "actual_up": req.actual_up,
        "actual_return_pct": actual_return_pct,
        "realized_pnl_r": req.realized_pnl_r,
        "net_profitable": net_profitable,
        "friction_cost": FRICTION_COST_PCT,
        "results": results,
    }


def _extract_feature_importance(predictions, feature_names: list[str]) -> dict:
    importance_agg: dict[str, float] = {}
    count = 0
    for pred in predictions:
        fi = getattr(pred, "feature_importance", None)
        if not fi:
            continue
        for key, value in fi.items():
            importance_agg[key] = importance_agg.get(key, 0.0) + float(value)
        count += 1

    if count == 0:
        return {}

    averaged = {k: v / count for k, v in importance_agg.items()}
    return dict(
        sorted(
            ((k, round(float(v), 4)) for k, v in averaged.items() if k in feature_names),
            key=lambda item: item[1],
            reverse=True,
        )[:20]
    )


def _check_anomaly(
    x: np.ndarray,
    x_latest: np.ndarray,
    contamination: float = 0.05,
) -> tuple[bool, float]:
    if len(x) < 30:
        return False, 0.0
    try:
        from sklearn.ensemble import IsolationForest

        iso = IsolationForest(contamination=contamination, random_state=42)
        iso.fit(x)
        score = float(iso.score_samples(x_latest.reshape(1, -1))[0])
        decision = int(iso.predict(x_latest.reshape(1, -1))[0])
        return decision == -1, score
    except Exception as e:
        print(f"[IsolationForest] failed: {e}")
        return False, 0.0




class ModelPoolContractError(RuntimeError):
    """Raised when model_pool.json is incomplete for v2 serving."""


def _require_model_pool_contract(pool: Any, *, stage: str = "predict_v2") -> tuple[dict, dict]:
    if not isinstance(pool, dict) or not isinstance(pool.get("models"), dict):
        raise ModelPoolContractError(f"{stage}: model_pool.json unavailable")
    pool_models = pool.get("models") or {}
    missing = [
        name
        for name in _MODEL_NAMES_V2
        if not isinstance(pool_models.get(name), dict)
    ]
    if missing:
        raise ModelPoolContractError(
            f"{stage}: missing model_pool.models entries: {', '.join(missing)}"
        )
    sidecars = pool.get("l2_feature_sidecars") if isinstance(pool.get("l2_feature_sidecars"), dict) else {}
    missing_sidecars = [
        name
        for name in _L2_FEATURE_SIDECAR_NAMES
        if not isinstance(sidecars.get(name), dict) and not isinstance(pool_models.get(name), dict)
    ]
    if missing_sidecars:
        raise ModelPoolContractError(
            f"{stage}: missing model_pool.l2_feature_sidecars entries: {', '.join(missing_sidecars)}"
        )
    invalid = [
        f"{name}={pool_models[name].get('status')}"
        for name in _MODEL_NAMES_V2
        if str(pool_models[name].get("status") or "").strip() not in _MODEL_POOL_ALLOWED_STATUSES
    ]
    invalid.extend(
        f"{name}={(sidecars.get(name) or pool_models.get(name) or {}).get('status')}"
        for name in _L2_FEATURE_SIDECAR_NAMES
        if str(((sidecars.get(name) or pool_models.get(name) or {}).get("status") or "")).strip()
        not in _MODEL_POOL_ALLOWED_STATUSES
    )
    if invalid:
        raise ModelPoolContractError(
            f"{stage}: invalid model_pool lifecycle status: {', '.join(invalid)}"
        )
    formal_slots = pool.get("formal_layer3_slots") if isinstance(pool.get("formal_layer3_slots"), dict) else {}
    return pool_models, formal_slots








def predict_stock_v2(req: PredictRequest) -> dict:
    """Emit exact base-model evidence for the Controller-owned Active-8 ensemble.

    This boundary never turns partial Modal output into a trade signal.  The
    Controller adds GNN and sequence results, performs same-date tie-safe
    normalization, then applies the immutable learned ensemble artifact.
    """
    if len(req.prices) < 60:
        raise ValueError("至少需要 60 筆價格資料")
    runtime_options = getattr(req, "runtime_options", {}) or {}
    precomputed = runtime_options.get(_BATCH_FEATURE_RANK_SCORES_KEY)
    if not isinstance(precomputed, dict):
        raise ValueError("active8_controller_batch_evidence_required")
    pool_snapshot = runtime_options.get(_BATCH_MODEL_POOL_KEY)
    if not isinstance(pool_snapshot, dict):
        raise ValueError("active8_frozen_model_pool_required")
    _require_model_pool_contract(pool_snapshot, stage="predict_v2_feature_evidence")

    rank_scores: dict[str, float] = {}
    for model_name, raw_score in precomputed.items():
        if model_name not in _FEATURE_MODEL_NAMES_V2:
            continue
        score = float(raw_score)
        if not np.isfinite(score):
            raise ValueError(f"active8_base_score_non_finite:{model_name}")
        rank_scores[model_name] = float(np.clip(score, 0.0, 1.0))
    if not rank_scores:
        raise ValueError("active8_feature_evidence_empty")

    errors = [
        str(value)
        for value in (runtime_options.get(_BATCH_FEATURE_MODEL_ERRORS_KEY) or [])
        if value
    ]
    challengers = {
        str(name): round(float(np.clip(float(value), 0.0, 1.0)), 6)
        for name, value in (runtime_options.get(_BATCH_CHALLENGER_RANK_SCORES_KEY) or {}).items()
        if np.isfinite(float(value))
    }
    challenger_errors = [
        str(value)
        for value in (runtime_options.get(_BATCH_CHALLENGER_MODEL_ERRORS_KEY) or [])
        if value
    ]
    feature_context = runtime_options.get(_BATCH_FEATURE_CONTEXT_KEY)
    feature_names = (
        [str(value) for value in feature_context.get("feature_names") or []]
        if isinstance(feature_context, dict)
        else []
    )
    current_price = float(close_price(req.prices[-1]))
    public_runtime_options = {
        key: value for key, value in runtime_options.items()
        if key not in _BATCH_RUNTIME_OPTION_KEYS
    }
    return {
        "stock_id": req.stock_id,
        "symbol": req.symbol,
        "current_price": current_price,
        "signal": "HOLD",
        "direction": "neutral",
        "confidence": 0.0,
        "consensus": 0.0,
        "forecast_pct": None,
        "forecast_range": None,
        "signal_strength": 0,
        "reasoning": "Base-model evidence only; Controller Active-8 ensemble required",
        "entry_price": current_price,
        "stop_loss": None,
        "target1": None,
        "target2": None,
        "models": [
            {"name": name, "rank_score": round(value, 6)}
            for name, value in sorted(rank_scores.items())
        ],
        "features_used": feature_names,
        "feature_schema": FEATURE_SCHEMA,
        "feature_count": len(feature_names),
        "feature_version": f"{FEATURE_SCHEMA}:{len(feature_names)}",
        "model_errors": errors or None,
        "rank_scores": {name: round(value, 6) for name, value in rank_scores.items()},
        "score_scores": {name: round(value, 6) for name, value in rank_scores.items()},
        "challenger_rank_scores": challengers,
        "challenger_errors": challenger_errors or None,
        "production_effect": False,
        "aggregation_owner": "daily_pipeline_v2.active8_ensemble_pointer_v1",
        "runtime_options": public_runtime_options,
    }
