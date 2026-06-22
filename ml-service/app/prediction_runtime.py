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
from .ensemble import weighted_vote
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


def predict_stock(req: PredictRequest) -> dict:
    """Core prediction logic."""
    if len(req.prices) < 60:
        raise ValueError("至少需要 60 筆價格資料")

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(
        req.prices,
        req.indicators,
        chips_input,
        req.sentiment_scores,
        req.market_env,
        barrier_params=req.barrier_params or None,
    )
    prices_arr = np.array([close_price(p) for p in req.prices])
    current_price = float(prices_arr[-1])
    atr = float((req.indicators[-1].get("atr14") or 0)) if req.indicators else 0.0

    today_str = datetime.now().strftime("%Y-%m-%d")
    ns = req.night_session
    if ns and ns.date and ns.date == today_str:
        df = df.with_columns(
            [
                pl.lit(float(np.clip(ns.change_pct, -10, 10))).alias("taifex_night_change_pct"),
                pl.lit(float(np.clip(ns.range_pct, 0, 15))).alias("taifex_night_range_pct"),
                pl.lit(1.0).alias("taifex_night_available"),
            ]
        )
        print(f"[Predict] {req.symbol} night_session: {ns.change_pct:.2f}% (date={ns.date})")
    else:
        df = df.with_columns(
            [
                pl.lit(0.0).alias("taifex_night_change_pct"),
                pl.lit(0.0).alias("taifex_night_range_pct"),
                pl.lit(0.0).alias("taifex_night_available"),
            ]
        )
        if ns and ns.date and ns.date != today_str:
            print(f"[Predict] {req.symbol} stale night_session ({ns.date} != {today_str}), zeroed")

    df = df.with_columns(
        [
            pl.lit(0.0).alias("orderbook_imbalance"),
            pl.lit(0.0).alias("orderbook_spread_pct"),
            pl.lit(0.0).alias("orderbook_available"),
        ]
    )

    adj_prices_arr = np.array([close_or_adjusted(p) for p in req.prices])
    x, y, feature_names = get_features(df, target_col="target_dir")
    x_latest = x[-1] if len(x) > 0 else np.zeros(max(len(feature_names), 1))

    from .features import apply_robust_scaler, fit_robust_scaler

    if len(x) > 0:
        fit_robust_scaler(x, req.symbol)
        x_scaled = apply_robust_scaler(x, req.symbol)
        x_scaled_latest = x_scaled[-1]
    else:
        x_scaled, x_scaled_latest = x, x_latest

    x_lgbm = get_lgbm_features(x) if len(x) > 0 else x
    x_lgbm_latest = x_lgbm[-1] if len(x_lgbm) > 0 else x_latest
    stock_id = req.stock_id

    regime_info = None
    regime_label = "N/A"
    try:
        from .regime import RegimeDetector, build_market_feature_matrix, get_current_market_features

        detector = RegimeDetector.load_from_gcs()
        if detector is None:
            feat_mat = build_market_feature_matrix(req.market_env)
            if feat_mat is not None and len(feat_mat) >= 20:
                detector = RegimeDetector().fit(feat_mat)
                detector.save_to_gcs()
        if detector is not None:
            cur_feat = get_current_market_features(req.market_env)
            if cur_feat is not None:
                regime_info = detector.predict_regime(cur_feat)
                regime_label = regime_info.get("label", "N/A")
    except Exception as e:
        print(f"[Regime] failed: {e}")

    garch_vol = run_garch_volatility(prices_arr, horizon=5)
    _, anomaly_score = _check_anomaly(x, x_latest) if len(x) >= 30 else (False, 0.0)
    if anomaly_score < -0.5:
        print(f"[Anomaly] {req.symbol} soft penalty, score={anomaly_score:.3f}")

    meta_bundle = None
    try:
        from .stacking import load_meta_learner

        meta_bundle = load_meta_learner(stock_id)
    except Exception as e:
        print(f"[Stacking] load failed: {e}")

    bandit_multipliers = None
    market_risk = float((req.market_env or {}).get("risk_score") or 50) / 100.0
    regime_for_bandit = regime_label if regime_label != "N/A" else None
    bandit = None
    try:
        bandit = load_bandit("/tmp/linucb_bandit")
        losses_5d = int(req.adaptive_params.get("losses_5d", 0))
        total_5d = int(req.adaptive_params.get("total_5d", 0))
        bandit.alpha = compute_dynamic_alpha(losses_5d, total_5d)
        bandit_multipliers = linucb_select(
            hmm_regime=regime_for_bandit,
            garch_vol=garch_vol,
            current_price=current_price,
            market_risk_score=market_risk,
            bandit=bandit,
            adaptive_params=req.adaptive_params,
        )
    except Exception as e:
        print(f"[LinUCB] failed: {e}")

    arf = load_arf(ARF_STATE_DIR, allow_fresh=True)
    predictions = []

    price_model_fns = [
        ("KalmanFilter", lambda: run_kalman_filter(prices_arr, req.horizon, stock_id)),
        ("DLinear", lambda: run_dlinear(adj_prices_arr, req.horizon)),
        ("MarkovSwitching", lambda: run_markov_switching(adj_prices_arr, req.horizon, stock_id)),
    ]
    print("[PatchTST] embedded predictor disabled; use artifact-backed batch serving")

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(fn): name for name, fn in price_model_fns}
        for future in as_completed(futures):
            name = futures[future]
            try:
                pred = future.result()
                block_reason = _model_prediction_block_reason(pred)
                if block_reason:
                    print(f"[{name}] excluded from vote: {block_reason}")
                    continue
                predictions.append(pred)
            except Exception as e:
                print(f"[{name}] failed: {e}")

    if len(x) >= 30:
        feat_model_fns = [
            ("XGBoost", lambda: run_xgboost(x, y, x_latest, prices_arr, req.horizon, stock_id, feature_names)),
            ("ExtraTrees", lambda: run_extra_trees(x, y, x_latest, prices_arr, req.horizon, stock_id, feature_names)),
            ("LightGBM", lambda: run_lightgbm(x_lgbm, y, x_lgbm_latest, prices_arr, req.horizon, stock_id, feature_names)),
        ]

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {executor.submit(fn): name for name, fn in feat_model_fns}
            for future in as_completed(futures):
                name = futures[future]
                try:
                    pred = future.result()
                    block_reason = _model_prediction_block_reason(pred)
                    if block_reason:
                        print(f"[{name}] excluded from vote: {block_reason}")
                        continue
                    predictions.append(pred)
                except Exception as e:
                    print(f"[{name}] failed: {e}")

    if not predictions:
        raise RuntimeError("沒有任何模型成功產生預測")

    ctx = build_context(regime_for_bandit, garch_vol, current_price, market_risk)
    arf_features = build_arf_features(
        predictions,
        hmm_regime_norm=float(ctx[0]),
        garch_vol_norm=float(ctx[1]),
        market_risk_score=market_risk,
    )

    result = weighted_vote(
        predictions,
        current_price,
        atr,
        req.real_accuracies,
        req.model_stats,
        regime_info=regime_info,
        meta_bundle=meta_bundle,
        garch_vol=garch_vol,
        bandit_multipliers=bandit_multipliers,
        adaptive_params=req.adaptive_params,
        trading_config=req.trading_config,
        anomaly_score=anomaly_score,
        lifecycle_weights=req.lifecycle_weights,
    )

    conformal_info = {}
    try:
        from .conformal import apply_conformal_calibration, load_conformal

        conformal = load_conformal(allow_fresh=True)
        cal_conf, conformal_info = apply_conformal_calibration(
            conformal,
            forecast_pct=result.forecast_pct,
            confidence=result.confidence,
            anomaly_score=anomaly_score,
        )
        if conformal_info.get("is_calibrated"):
            result.confidence = round(cal_conf, 3)
            result.reasoning = (
                f"[Conformal: 寬{conformal_info['interval_width']:.1%}, "
                f"penalty={conformal_info['uncertainty_penalty']:.2f}] "
                + result.reasoning
            )
    except Exception as e:
        print(f"[Conformal] failed: {e}")

    _, arf_conf, arf_signal, arf_prob = apply_arf_correction(
        arf,
        arf_features,
        ensemble_is_up=(result.direction == "up"),
        ensemble_confidence=result.confidence,
        ensemble_signal=result.signal,
    )
    arf_changed = arf_signal != result.signal

    garch_norm = min(2.0, garch_vol / (current_price * 0.02)) if garch_vol and current_price > 0 else 0.4
    arf_min_obs = get_dynamic_min_obs(garch_norm)
    if arf_changed and arf.is_warmed_up(min_obs=arf_min_obs):
        result.signal = arf_signal
        result.confidence = round(arf_conf, 3)
        result.reasoning = (
            f"[ARF校正: {result.signal}->{arf_signal}, P(up)={arf_prob:.2f}] "
            + result.reasoning
        )

    best_model = max(predictions, key=lambda p: p.confidence * p.direction_accuracy)

    return {
        "stock_id": stock_id,
        "symbol": req.symbol,
        "current_price": current_price,
        "signal": result.signal,
        "direction": result.direction,
        "confidence": result.confidence,
        "consensus": result.consensus,
        "forecast_pct": result.forecast_pct,
        "forecast_range": result.forecast_range,
        "signal_strength": result.signal_strength,
        "reasoning": result.reasoning,
        "entry_price": result.entry_price,
        "stop_loss": result.stop_loss,
        "target1": result.target1,
        "target2": result.target2,
        "models": result.models,
        "best_model": best_model.model_name,
        "forecasts": best_model.forecasts,
        "features_used": feature_names,
        "feature_importance": _extract_feature_importance(predictions, feature_names),
        "feature_version": "v4_9models",
        "regime": regime_label,
        "garch_vol": round(garch_vol, 4) if garch_vol else None,
        "anomaly_score": round(anomaly_score, 4),
        "meta_learner_used": meta_bundle is not None,
        "linucb_best_arm": bandit.best_arm(ctx) if bandit and bandit.is_warmed_up() else None,
        "linucb_warmed_up": bandit.is_warmed_up() if bandit else False,
        "arf_prob": round(arf_prob, 4),
        "arf_warmed_up": arf.is_warmed_up(),
        "arf_n_trained": arf.n_trained,
        "arf_features": arf_features.tolist(),
        "conformal_calibrated": conformal_info.get("is_calibrated", False),
        "conformal_interval": conformal_info.get("interval_width", 0.0),
        "conformal_penalty": conformal_info.get("uncertainty_penalty", 1.0),
        "conformal_n_residuals": conformal_info.get("n_residuals", 0),
    }


_FEATURE_MODEL_NAMES_V2 = ["LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"]
_TIME_SERIES_MODEL_NAMES_V2 = ["DLinear", "PatchTST", "iTransformer", "TimesFM"]
_STATE_SPACE_OVERLAY_NAMES_V2 = ["KalmanFilter", "MarkovSwitching"]
_SHADOW_CHALLENGER_MODEL_NAMES = ["ResidualMLP"]
_MODEL_NAMES_V2 = _FEATURE_MODEL_NAMES_V2 + _TIME_SERIES_MODEL_NAMES_V2
_BATCH_FEATURE_RANK_SCORES_KEY = "__batch_feature_rank_scores"
_BATCH_FEATURE_MODEL_ERRORS_KEY = "__batch_feature_model_errors"
_BATCH_CHALLENGER_RANK_SCORES_KEY = "__batch_challenger_rank_scores"
_BATCH_CHALLENGER_MODEL_ERRORS_KEY = "__batch_challenger_model_errors"
_BATCH_RUNTIME_OPTION_KEYS = {
    _BATCH_FEATURE_RANK_SCORES_KEY,
    _BATCH_FEATURE_MODEL_ERRORS_KEY,
    _BATCH_CHALLENGER_RANK_SCORES_KEY,
    _BATCH_CHALLENGER_MODEL_ERRORS_KEY,
}
_MODEL_POOL_ALLOWED_STATUSES = {"active", "degraded", "challenger", "retired"}


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
    invalid = [
        f"{name}={pool_models[name].get('status')}"
        for name in _MODEL_NAMES_V2
        if str(pool_models[name].get("status") or "").strip() not in _MODEL_POOL_ALLOWED_STATUSES
    ]
    if invalid:
        raise ModelPoolContractError(
            f"{stage}: invalid model_pool lifecycle status: {', '.join(invalid)}"
        )
    formal_slots = pool.get("formal_layer3_slots") if isinstance(pool.get("formal_layer3_slots"), dict) else {}
    return pool_models, formal_slots


def _normalize_market_segment_for_serving(req: PredictRequest) -> str | None:
    stock_meta = getattr(req, "stock_meta", {}) or {}
    for value in (
        stock_meta.get("market_segment") if isinstance(stock_meta, dict) else None,
        getattr(req, "market", None),
    ):
        normalized = str(value or "").strip().upper()
        if normalized in {"TWSE", "TSE", "LISTED"}:
            return "LISTED"
        if normalized in {"TPEX", "OTC"}:
            return "OTC"
        if normalized in {"ESB", "EMERGING"}:
            return "EMERGING"
    return None


def _rank_signal_thresholds(trading_config: dict | None, adaptive_params: dict | None) -> dict[str, float]:
    cfg = (trading_config or {}).get("ensemble_v2") if isinstance(trading_config, dict) else {}
    cfg = cfg if isinstance(cfg, dict) else {}
    adaptive = adaptive_params or {}

    def _num(key: str, default: float) -> float:
        try:
            return float(cfg.get(key, default))
        except (TypeError, ValueError):
            return default

    try:
        delta = float(adaptive.get("confidence_delta", 0.0) or 0.0)
    except (TypeError, ValueError):
        delta = 0.0
    # Positive delta means more conservative: widen the neutral band.
    delta = float(np.clip(delta, -0.08, 0.08))

    strong_buy = float(np.clip(_num("strongBuyThreshold", 0.85) + delta, 0.55, 0.97))
    buy = float(np.clip(_num("buyThreshold", 0.70) + delta, 0.52, min(0.95, strong_buy)))
    sell = float(np.clip(_num("sellThreshold", 0.30) - delta, max(0.05, 1.0 - buy), 0.48))
    strong_sell = float(np.clip(_num("strongSellThreshold", 0.15) - delta, 0.03, min(0.45, sell)))

    return {
        "strong_buy_threshold": strong_buy,
        "buy_threshold": buy,
        "sell_threshold": sell,
        "strong_sell_threshold": strong_sell,
        "adaptive_confidence_delta": delta,
    }


def _require_predict_v2_config_contract(req: PredictRequest) -> None:
    trading_config = req.trading_config
    if not isinstance(trading_config, dict) or not isinstance(trading_config.get("ensemble_v2"), dict):
        raise ValueError("predict_v2_config_contract: missing trading_config.ensemble_v2")
    if not isinstance(trading_config.get("mlPool"), dict):
        raise ValueError("predict_v2_config_contract: missing trading_config.mlPool")

    adaptive_params = req.adaptive_params
    if not isinstance(adaptive_params, dict) or not adaptive_params:
        raise ValueError("predict_v2_config_contract: missing adaptive_params")
    provenance = adaptive_params.get("provenance")
    if not isinstance(provenance, dict):
        raise ValueError("predict_v2_config_contract: missing adaptive_params.provenance")
    if provenance.get("fallback") is True:
        raise ValueError("predict_v2_config_contract: adaptive_params fallback provenance is not allowed")


def predict_stock_v2(req: PredictRequest) -> dict:
    """2.0 predict: universal regression models + IC-weighted rank ensemble."""
    from .ensemble import load_ic_weights, merge_with_time_series, rank_to_signal
    from .model_store import load_model
    from .model_pool import load_pool as _load_pool

    if len(req.prices) < 60:
        raise ValueError("至少需要 60 筆價格資料")
    _require_predict_v2_config_contract(req)

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(
        req.prices,
        req.indicators,
        chips_input,
        req.sentiment_scores,
        req.market_env,
        barrier_params=req.barrier_params or None,
        stock_meta=getattr(req, "stock_meta", None),
    )

    prices_arr = np.array([close_price(p) for p in req.prices])
    adj_prices_arr = np.array([close_or_adjusted(p) for p in req.prices])
    current_price = float(prices_arr[-1])
    atr = float((req.indicators[-1].get("atr14") or 0)) if req.indicators else current_price * 0.02

    x, y, feature_names = get_features(df, target_col="target_rank", allow_missing_target=True)
    if len(x) == 0:
        raise ValueError(f"Feature matrix empty for {req.symbol}")
    x_latest = x[-1].reshape(1, -1)
    market_segment = _normalize_market_segment_for_serving(req)
    ic_weights = load_ic_weights(market_segment=market_segment)
    pool_snapshot = _load_pool()
    pool_models, formal_slots = _require_model_pool_contract(pool_snapshot, stage="predict_v2")

    def _resolve_model_pool_status(name: str) -> str:
        if isinstance(pool_models.get(name), dict):
            return str((pool_models.get(name) or {}).get("status") or "active")
        slot = formal_slots.get(name) if isinstance(formal_slots, dict) else None
        if isinstance(slot, dict):
            slot_status = str(slot.get("status") or "").strip()
            try:
                vote_weight = float(slot.get("vote_weight") or 0.0)
            except (TypeError, ValueError):
                vote_weight = 0.0
            direct_prediction = bool(slot.get("direct_prediction")) or vote_weight > 0.0
            if direct_prediction and slot_status in {"production_adapter_active", "active"}:
                return "retired"
            return "retired"
        raise ModelPoolContractError(f"predict_v2: missing model_pool status for {name}")

    model_pool_status = {
        name: _resolve_model_pool_status(name)
        for name in _MODEL_NAMES_V2
    }
    degraded_dampening = 0.1
    try:
        ml_pool_cfg = (req.trading_config or {}).get("mlPool") or {}
        degraded_dampening = float(ml_pool_cfg.get("degradedDampening", 0.1))
    except (TypeError, ValueError):
        degraded_dampening = 0.1

    rank_scores: dict[str, float] = {}
    model_errors: list[str] = []
    runtime_options = getattr(req, "runtime_options", {}) or {}
    run_embedded_time_series = bool(runtime_options.get("embedded_time_series", True))
    run_embedded_state_space = bool(runtime_options.get("embedded_state_space", True))

    def _aligned_features(meta: dict | None) -> np.ndarray:
        training_features = (meta or {}).get("feature_names", [])
        training_medians = (meta or {}).get("feature_medians", {})
        if training_features and training_features != feature_names:
            try:
                compatibility = validate_serving_feature_compatibility(
                    training_features=training_features,
                    serving_features=feature_names,
                    feature_medians=training_medians,
                )
                if compatibility["status"] != "ok":
                    print(f"[PredictV2] artifact feature compatibility: {compatibility}")
            except ArtifactValidationError as exc:
                raise ValueError(f"artifact feature compatibility failed: {exc.report}") from exc
            pred_name_to_idx = {n: i for i, n in enumerate(feature_names)}
            defaults = np.array(
                [safe_float(training_medians.get(n), 0.0) for n in training_features],
                dtype=np.float32,
            ).reshape(1, -1)
            aligned = defaults.copy()
            for j, fname in enumerate(training_features):
                if fname in pred_name_to_idx:
                    aligned[0, j] = float(x_latest[0, pred_name_to_idx[fname]])
            missing = len([f for f in training_features if f not in pred_name_to_idx])
            if missing > 0:
                have_median = sum(
                    1 for f in training_features if f not in pred_name_to_idx and f in training_medians
                )
                print(
                    f"[PredictV2] missing {missing}/{len(training_features)} features, "
                    f"{have_median} filled with training median, "
                    f"{missing - have_median} filled with 0 (no median)"
                )
            return aligned
        return x_latest

    precomputed_rank_scores = runtime_options.get(_BATCH_FEATURE_RANK_SCORES_KEY)
    precomputed_model_errors = runtime_options.get(_BATCH_FEATURE_MODEL_ERRORS_KEY)
    if isinstance(precomputed_rank_scores, dict):
        for model_name, score in precomputed_rank_scores.items():
            if model_name in _FEATURE_MODEL_NAMES_V2:
                rank_scores[model_name] = float(np.clip(float(score), 0.0, 1.0))
        if isinstance(precomputed_model_errors, list):
            model_errors.extend(str(err) for err in precomputed_model_errors if err)
    else:
        for model_name in _FEATURE_MODEL_NAMES_V2:
            try:
                if model_name == "TabM":
                    model_errors.append("TabM: production predictor requires TabM torch batch serving")
                    continue
                if model_name == "GNN":
                    model_errors.append("GNN: production predictor requires GraphSAGE batch-context serving")
                    continue
                status = model_pool_status.get(model_name, "active")
                if status in ("retired", "challenger"):
                    model_errors.append(f"{model_name}: skipped by model_pool status={status}")
                    continue
                model_obj, meta = load_model(0, model_name)
                if model_obj is None:
                    model_errors.append(f"{model_name}: not found in GCS")
                    continue

                x_to_predict = _aligned_features(meta)
                pred = model_obj.predict(x_to_predict)
                rank_scores[model_name] = float(np.clip(pred[0], 0.0, 1.0))
            except Exception as e:
                model_errors.append(f"{model_name}: {e}")

    if not rank_scores:
        raise ValueError(f"All models failed for {req.symbol}: {model_errors}")

    time_series_signals: dict[str, dict] = {}
    if run_embedded_time_series:
        ts_model_fns = [
            ("DLinear", lambda: run_dlinear(adj_prices_arr, req.horizon)),
        ]
        for missing_sequence in ("PatchTST", "iTransformer", "TimesFM"):
            model_errors.append(f"{missing_sequence}: production predictor requires artifact-backed batch serving")
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {}
            for model_name, fn in ts_model_fns:
                status = model_pool_status.get(model_name, "active")
                if status in ("retired", "challenger"):
                    model_errors.append(f"{model_name}: skipped by model_pool status={status}")
                    continue
                futures[executor.submit(fn)] = model_name
            for future in as_completed(futures):
                model_name = futures[future]
                try:
                    pred = future.result()
                    block_reason = _model_prediction_block_reason(pred)
                    if block_reason:
                        model_errors.append(f"{model_name}: excluded fallback prediction: {block_reason}")
                        continue
                    time_series_signals[model_name] = {
                        "forecast_pct": float(getattr(pred, "forecast_pct", 0.0)),
                        "direction": getattr(pred, "direction", None),
                        "confidence": float(getattr(pred, "confidence", 0.0)),
                        "direction_accuracy": float(getattr(pred, "direction_accuracy", 0.0)),
                    }
                except Exception as e:
                    model_errors.append(f"{model_name}: {e}")
    else:
        model_errors.append("embedded time-series skipped: owned by daily_pipeline_v2 batch predictors")

    state_space_overlays: dict[str, dict] = {}
    if run_embedded_state_space:
        state_overlay_fns = [
            ("KalmanFilter", lambda: run_kalman_filter(prices_arr, req.horizon, req.stock_id)),
            ("MarkovSwitching", lambda: run_markov_switching(adj_prices_arr, req.horizon, req.stock_id)),
        ]
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {}
            for model_name, fn in state_overlay_fns:
                futures[executor.submit(fn)] = model_name
            for future in as_completed(futures):
                model_name = futures[future]
                try:
                    pred = future.result()
                    block_reason = _model_prediction_block_reason(pred)
                    if block_reason:
                        model_errors.append(f"{model_name}: excluded fallback overlay: {block_reason}")
                        continue
                    state_space_overlays[model_name] = {
                        "forecast_pct": float(getattr(pred, "forecast_pct", 0.0)),
                        "direction": getattr(pred, "direction", None),
                        "confidence": float(getattr(pred, "confidence", 0.0)),
                        "direction_accuracy": float(getattr(pred, "direction_accuracy", 0.0)),
                    }
                except Exception as e:
                    model_errors.append(f"{model_name}: overlay {e}")
    else:
        model_errors.append("embedded state-space skipped: owned by daily_pipeline_v2 batch predictors")

    challenger_rank_scores: dict[str, float] = {}
    challenger_errors: list[str] = []

    precomputed_challenger_scores = runtime_options.get(_BATCH_CHALLENGER_RANK_SCORES_KEY)
    precomputed_challenger_errors = runtime_options.get(_BATCH_CHALLENGER_MODEL_ERRORS_KEY)
    if isinstance(precomputed_challenger_scores, dict):
        allowed_challengers = set(_SHADOW_CHALLENGER_MODEL_NAMES)
        for model_name, score in precomputed_challenger_scores.items():
            if model_name in allowed_challengers:
                challenger_rank_scores[model_name] = float(np.clip(float(score), 0.0, 1.0))
        if isinstance(precomputed_challenger_errors, list):
            challenger_errors.extend(str(err) for err in precomputed_challenger_errors if err)

    rank_scores, effective_ic_weights = merge_with_time_series(
        rank_scores,
        time_series_signals,
        ic_weights=ic_weights,
        model_status=model_pool_status,
        degraded_dampening=degraded_dampening,
    )

    rank_stacker_info = {"applied": False, "reason": "not_loaded"}
    try:
        from .stacking import apply_rank_stacker, load_meta_learner

        rank_bundle = load_meta_learner(0)
        rank_scores, effective_ic_weights, rank_stacker_info = apply_rank_stacker(
            rank_scores,
            rank_bundle,
            effective_ic_weights,
        )
    except Exception as e:
        rank_stacker_info = {"applied": False, "reason": f"load_or_apply_failed: {e}"}

    rank_thresholds = _rank_signal_thresholds(req.trading_config, req.adaptive_params)
    public_runtime_options = {
        key: value
        for key, value in runtime_options.items()
        if key not in _BATCH_RUNTIME_OPTION_KEYS
    }
    result = rank_to_signal(
        rank_scores=rank_scores,
        current_price=current_price,
        atr=atr,
        ic_weights=effective_ic_weights if effective_ic_weights else None,
        strong_buy_threshold=rank_thresholds["strong_buy_threshold"],
        buy_threshold=rank_thresholds["buy_threshold"],
        sell_threshold=rank_thresholds["sell_threshold"],
        strong_sell_threshold=rank_thresholds["strong_sell_threshold"],
    )

    return {
        "stock_id": req.stock_id,
        "symbol": req.symbol,
        "current_price": current_price,
        "signal": result.signal,
        "direction": result.direction,
        "confidence": result.confidence,
        "consensus": result.consensus,
        "forecast_pct": result.forecast_pct,
        "forecast_range": result.forecast_range,
        "signal_strength": result.signal_strength,
        "reasoning": result.reasoning,
        "entry_price": result.entry_price,
        "stop_loss": result.stop_loss,
        "target1": result.target1,
        "target2": result.target2,
        "models": result.models,
        "features_used": feature_names,
        "feature_schema": FEATURE_SCHEMA,
        "feature_count": len(feature_names),
        "feature_version": f"{FEATURE_SCHEMA}:{len(feature_names)}",
        "model_errors": model_errors if model_errors else None,
        "ic_weights": {k: round(v, 4) for k, v in effective_ic_weights.items()} if effective_ic_weights else None,
        "ic_weight_scope": market_segment or "GLOBAL",
        "rank_signal_thresholds": {k: round(float(v), 4) for k, v in rank_thresholds.items()},
        "model_pool_status": model_pool_status if pool_snapshot else None,
        "rank_scores": {k: round(float(v), 6) for k, v in rank_scores.items()},
        "time_series_signals": time_series_signals if time_series_signals else None,
        "state_space_overlays": state_space_overlays if state_space_overlays else None,
        "rank_stacker": rank_stacker_info,
        "challenger_rank_scores": {k: round(float(v), 6) for k, v in challenger_rank_scores.items()},
        "challenger_errors": challenger_errors if challenger_errors else None,
        "atr": float(atr),
        "runtime_options": public_runtime_options,
    }


def retrain_stock(req: PredictRequest) -> dict:
    """Core retrain logic."""
    if len(req.prices) < 60:
        raise ValueError("至少需要 60 筆價格資料")

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(
        req.prices,
        req.indicators,
        chips_input,
        req.sentiment_scores,
        req.market_env,
    )
    df = df.with_columns(
        [
            pl.lit(0.0).alias("taifex_night_change_pct"),
            pl.lit(0.0).alias("taifex_night_range_pct"),
            pl.lit(0.0).alias("taifex_night_available"),
            pl.lit(0.0).alias("orderbook_imbalance"),
            pl.lit(0.0).alias("orderbook_spread_pct"),
            pl.lit(0.0).alias("orderbook_available"),
        ]
    )

    prices_arr = np.array([close_price(p) for p in req.prices])
    x, y, feature_names = get_features(df, target_col="target_dir")

    if req.weak_features:
        weak_set = set(req.weak_features)
        keep_idx = [i for i, f in enumerate(feature_names) if f not in weak_set]
        if len(keep_idx) >= 5:
            dropped = len(feature_names) - len(keep_idx)
            x = x[:, keep_idx]
            feature_names = [feature_names[i] for i in keep_idx]
            print(f"[Retrain] IC filter: dropped {dropped} weak features, {len(feature_names)} remaining")

    if len(x) < 30:
        raise ValueError("特徵資料少於 30 筆")

    from .features import mask_night_session_features
    from .model_store import save_model

    x = mask_night_session_features(x, feature_names, mask_ratio=0.5)
    results: dict = {}
    split = int(len(x) * 0.8)

    optuna_params: dict[str, dict] = {}
    if req.use_optuna and len(x) >= 60:
        from .optuna_retrain import search_best_params

        for model_name in ["XGBoost", "ExtraTrees", "LightGBM"]:
            best_params = search_best_params(model_name, x, y)
            if best_params:
                optuna_params[model_name] = best_params
                print(f"[Retrain] Optuna {model_name}: {best_params}")

    xgb_p = optuna_params.get("XGBoost", {})
    et_p = optuna_params.get("ExtraTrees", {})

    model_specs = [
        (
            "XGBoost",
            lambda: __import__("xgboost", fromlist=["XGBRegressor"]).XGBRegressor(
                n_estimators=xgb_p.get("n_estimators", 150),
                max_depth=xgb_p.get("max_depth", 4),
                learning_rate=xgb_p.get("learning_rate", 0.05),
                objective="reg:squarederror",
                subsample=xgb_p.get("subsample", 0.9),
                colsample_bytree=xgb_p.get("colsample_bytree", 0.9),
                eval_metric="rmse",
                random_state=42,
                verbosity=0,
            ),
        ),
        (
            "ExtraTrees",
            lambda: __import__("sklearn.ensemble", fromlist=["ExtraTreesRegressor"]).ExtraTreesRegressor(
                n_estimators=et_p.get("n_estimators", 200),
                max_depth=et_p.get("max_depth", 6),
                min_samples_split=et_p.get("min_samples_split", 5),
                min_samples_leaf=et_p.get("min_samples_leaf", 3),
                max_features="sqrt",
                bootstrap=True,
                random_state=42,
                n_jobs=-1,
            ),
        ),
        ("LightGBM", lambda: None),
    ]

    x_latest_rt = x[-1] if len(x) > 0 else np.zeros(max(len(feature_names), 1))

    for name, factory in model_specs:
        try:
            if name == "LightGBM":
                result = run_lightgbm(
                    x, y, x_latest_rt, prices_arr, req.horizon, req.stock_id, feature_names
                )
                acc = float(result.direction_accuracy)
            else:
                model = factory()
                model.fit(x[:split], y[:split])
                acc = float(model.score(x[split:], y[split:])) if len(x[split:]) > 0 else 0.5
                save_model(req.stock_id, name, model, feature_names, len(x))
            results[name] = {"accuracy": round(acc, 3), "samples": len(x), "saved": True}
        except Exception as e:
            results[name] = {"error": str(e)}

    try:
        from .stacking import save_meta_learner, train_meta_learner_oof

        bundle = train_meta_learner_oof(x, y, prices_arr, feature_names, req.stock_id)
        if bundle:
            save_meta_learner(bundle, req.stock_id)
            results["Stacking"] = {"trained": True, "saved": True}
        else:
            results["Stacking"] = {"trained": False, "reason": "insufficient OOF samples"}
    except Exception as e:
        results["Stacking"] = {"error": str(e)}

    try:
        from .stacking_mlp import train_shadow_mlp

        mlp_result = train_shadow_mlp(x, y)
        if mlp_result:
            results["MLP_Shadow"] = {
                "trained": True,
                "oos_accuracy": mlp_result.get("oos_accuracy"),
            }
        else:
            results["MLP_Shadow"] = {"trained": False, "reason": "insufficient data or failed"}
    except Exception as e:
        results["MLP_Shadow"] = {"error": str(e)}

    try:
        from .regime import RegimeDetector, build_market_feature_matrix

        feat_mat = build_market_feature_matrix(req.market_env)
        if feat_mat is not None and len(feat_mat) >= 20:
            detector = RegimeDetector().fit(feat_mat)
            detector.save_to_gcs()
            results["HMM_Regime"] = {
                "n_components": detector.n_components,
                "trained": True,
                "saved": True,
            }
        else:
            results["HMM_Regime"] = {
                "trained": False,
                "reason": "insufficient market history",
            }
    except Exception as e:
        results["HMM_Regime"] = {"error": str(e)}

    return {
        "stock_id": req.stock_id,
        "symbol": req.symbol,
        "retrained_at": now_utc_iso(),
        "feature_count": len(feature_names),
        "features_dropped": len(req.weak_features) if req.weak_features else 0,
        "optuna_models": list(optuna_params.keys()),
        "feature_version": "v5_ic_optuna",
        "results": results,
    }


if TYPE_CHECKING:
    from .schemas import PredictRequest
else:
    from .schemas import PredictRequest

__all__ = [
    "ARFUpdateRequest",
    "FRICTION_COST_PCT",
    "PredictRequest",
    "predict_stock",
    "predict_stock_v2",
    "retrain_stock",
    "update_arf",
]
