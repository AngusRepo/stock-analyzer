"""
main.py — FastAPI ML 服務（v14）

10 模型 Ensemble 架構（5v5 平衡）：
  純價格族（5）：KalmanFilter / DLinear / MarkovSwitching / PatchTST / Chronos
  特徵族  （5）：XGBoost / CatBoost / ExtraTrees / LightGBM / FT-Transformer
"""
import os
import numpy as np
import polars as pl
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from .features import (
    build_feature_matrix, get_features,
    get_catboost_features, get_lgbm_features,  # #6 feature input diversity
)
from .models import (
    run_kalman_filter, run_dlinear, run_markov_switching, run_patchtst, run_chronos,
    run_xgboost, run_catboost, run_extra_trees, run_lightgbm, run_ft_transformer,
    run_garch_volatility,
)
from .ensemble import weighted_vote
from .linucb_bandit import linucb_select, load_bandit, build_context, compute_dynamic_alpha
from .arf_aggregator import (
    build_arf_features, load_arf, save_arf, apply_arf_correction, ARF_STATE_DIR,
    get_dynamic_min_obs,
)

app = FastAPI(title="StockVision ML Service", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    # #21 CORS 限制：只允許 StockVision Worker 呼叫
    allow_origins=["https://stockvision-worker.angus-solo-dev.workers.dev"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 2026-04-07 Phase 1: Optuna routes（自動 push KV，取代 local JSON）──────
try:
    from .optuna_routes import router as optuna_router
    app.include_router(optuna_router)
except Exception as _e:  # noqa: BLE001
    import logging
    logging.getLogger(__name__).warning(f"[main] optuna_routes not loaded: {_e}")

# ─── 服務間驗證（從環境變數讀取，部署時設定）────────────────────────────────
_SERVICE_TOKEN = os.environ.get("ML_SERVICE_SECRET", "")

async def verify_service_token(request: Request) -> None:
    """若有設定 ML_SERVICE_SECRET，驗證 X-Service-Token header"""
    if not _SERVICE_TOKEN:
        return  # 未設定 → 不驗證（開發環境相容）
    token = request.headers.get("X-Service-Token", "")
    if token != _SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid service token")


class NightSessionData(BaseModel):
    change_pct: float = 0       # 夜盤漲跌幅 %
    range_pct: float = 0        # 夜盤振幅 %
    date: str = ""              # 資料日期（防呆用）

class PredictRequest(BaseModel):
    stock_id: int
    symbol: str
    prices: list[dict]
    indicators: list[dict] = []
    chips: list[dict] = []
    sentiment_scores: list[dict] = []
    horizon: int = 14
    real_accuracies: dict[str, float] = {}
    market: str = "TW"
    market_env: dict | None = None
    model_stats: dict[str, dict] = {}
    adaptive_params: dict = {}   # 來自 KV ml:adaptive_params（T+1 自適應，向後相容）
    trading_config: dict = {}    # 來自 KV trading:config（Optuna baseline，含 sltp/signal/circuit etc.）
    barrier_params: dict = {}   # 來自 KV trading:config.barrier（Optuna #1 搜尋，零 deploy）
    lifecycle_weights: dict[str, float] = {}  # P1#8: per-model lifecycle weight overrides
    weak_features: list[str] = []             # P1#9: IC audit 無效特徵（retrain 時排除）
    use_optuna: bool = False                  # P1#9: 啟用 Optuna 超參數搜索
    night_session: NightSessionData | None = None  # 台指期夜盤（07:15 re-predict 時傳入）
    context: str = "scheduled_daily"  # "scheduled_daily" (15:30) or "morning_repredict" (07:15)


@app.get("/health")
def health():
    return {"status": "ok", "service": "stockvision-ml", "version": "2.0.0"}


@app.get("/warmup")
async def warmup(request: Request):
    """
    喚醒 Cloud Run 並強制 import 所有 ML 模組。
    Worker 在 Queue 開始前呼叫此端點（取代 /health），
    確保第一支 /predict 不會因 cold import 而 timeout。
    """
    await verify_service_token(request)
    import time
    t0 = time.time()
    # 觸發所有 model/feature 模組的 import（它們在 module 頂層已 import，這裡只是確認）
    dummy_prices = np.random.randn(100).cumsum() + 100
    dummy_prices = np.maximum(dummy_prices, 1.0)
    # 跑最輕量的 model：KalmanFilter（純數值，無 DB，< 1s）
    try:
        from .models import run_kalman_filter
        run_kalman_filter(dummy_prices, horizon=5, stock_id=0)
    except Exception as e:
        print(f"[Warmup] KalmanFilter skipped: {e}")
    elapsed = round(time.time() - t0, 3)
    print(f"[Warmup] done in {elapsed}s")
    return {"status": "warm", "elapsed_s": elapsed}


class FactorAuditRequest(BaseModel):
    prices: list[dict]
    indicators: list[dict] = []
    chips: list[dict] = []
    sentiment_scores: list[dict] = []
    market_env: dict | None = None


@app.post("/factor-ic-audit")
async def factor_ic_audit(req: FactorAuditRequest, request: Request):
    """
    Weekly IC audit：對所有 FEATURE_COLS 計算 Spearman IC。
    Worker weekly cron 用一支代表性股票（資料多的）呼叫此 endpoint。
    回傳各 feature 的 IC/ICIR/trend/effective 狀態。
    """
    await verify_service_token(request)
    from .features import build_feature_matrix, get_features, FEATURE_COLS
    from .feature_selection import ic_icir_check

    df = build_feature_matrix(req.prices, req.indicators, req.chips,
                              req.sentiment_scores, req.market_env)
    X, y, feature_names = get_features(df, target_col="target_dir")

    if len(X) < 60:
        return {"error": "需要至少 60 天資料", "features": []}

    # IC/ICIR per-feature (pure NumPy, no Pandas)
    # For per-stock IC audit, dates are implicit (sequential rows = sequential days)
    dates_seq = np.arange(len(X)).astype(str)  # sequential pseudo-dates
    ic_results_dict = ic_icir_check(X, y, dates_seq, feature_names, min_ic=0.0, min_icir=0.0)

    results = [
        {"feature": name, "ic": v["ic"], "icir": v["icir"],
         "effective": v["stable"], "n_dates": v["n_dates"]}
        for name, v in ic_results_dict.items()
    ]

    weak = [r["feature"] for r in results if not r["effective"]]
    strong = [r["feature"] for r in results if r["effective"]]

    print(f"[IC Audit] {len(strong)} effective / {len(weak)} weak out of {len(results)} features")
    return {
        "total": len(results),
        "effective_count": len(strong),
        "weak_count": len(weak),
        "weak_features": weak,
        "details": results,
    }


def _extract_feature_importance(predictions, feature_names: list[str]) -> dict:
    importance_agg: dict[str, float] = {}
    count = 0
    for pred in predictions:
        model_obj = getattr(pred, "_model", None)
        if model_obj is None:
            continue
        try:
            if hasattr(model_obj, "feature_importances_"):
                imp = model_obj.feature_importances_
                for i, name in enumerate(feature_names):
                    importance_agg[name] = importance_agg.get(name, 0) + float(imp[i])
                count += 1
        except Exception:
            pass
    if count > 0:
        return {k: round(v / count, 4) for k, v in
                sorted(importance_agg.items(), key=lambda x: -x[1])[:15]}
    return {}


def _check_anomaly(X: np.ndarray, X_latest: np.ndarray,
                   contamination: float = 0.05) -> tuple[bool, float]:
    """Isolation Forest 異常偵測，回傳 (is_anomaly, score)"""
    if len(X) < 30:
        return False, 0.0
    try:
        from sklearn.ensemble import IsolationForest
        iso = IsolationForest(n_estimators=100, contamination=contamination,
                              random_state=42, n_jobs=-1)
        iso.fit(X)
        score    = float(iso.score_samples(X_latest.reshape(1, -1))[0])
        decision = int(iso.predict(X_latest.reshape(1, -1))[0])
        return decision == -1, score
    except Exception as e:
        print(f"[IsolationForest] failed: {e}")
        return False, 0.0


def predict_stock(req: PredictRequest) -> dict:
    """Core prediction logic — no auth check, callable by Modal @function or HTTP endpoint."""
    if len(req.prices) < 60:
        raise ValueError("需要至少 60 天的股價數據")

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df           = build_feature_matrix(req.prices, req.indicators, chips_input,
                                         req.sentiment_scores, req.market_env,
                                         barrier_params=req.barrier_params or None)
    prices_arr   = np.array([float(p["close"]) for p in req.prices])
    current_price = float(prices_arr[-1])
    atr = float((req.indicators[-1].get("atr14") or 0)) if req.indicators else 0.0

    # ── 台指期夜盤特徵注入 ──────────────────────────────────────────────────
    # 15:30 (scheduled_daily): 無夜盤資料 → 全填 0
    # 07:15 (morning_repredict): 夜盤已收盤 → 填實際值
    today_str = datetime.now().strftime("%Y-%m-%d")
    ns = req.night_session
    if ns and ns.date and ns.date == today_str:
        df = df.with_columns([
            pl.lit(float(np.clip(ns.change_pct, -10, 10))).alias("taifex_night_change_pct"),
            pl.lit(float(np.clip(ns.range_pct, 0, 15))).alias("taifex_night_range_pct"),
            pl.lit(1.0).alias("taifex_night_available"),
        ])
        print(f"[Predict] {req.symbol} night_session: {ns.change_pct:.2f}% (date={ns.date})")
    else:
        df = df.with_columns([
            pl.lit(0.0).alias("taifex_night_change_pct"),
            pl.lit(0.0).alias("taifex_night_range_pct"),
            pl.lit(0.0).alias("taifex_night_available"),
        ])
        if ns and ns.date and ns.date != today_str:
            print(f"[Predict] {req.symbol} stale night_session ({ns.date} != {today_str}), zeroed")

    # ── 五檔報價特徵（盤中由 Worker 傳入，盤前/盤後填 0）──────────────────
    df = df.with_columns([
        pl.lit(0.0).alias("orderbook_imbalance"),
        pl.lit(0.0).alias("orderbook_spread_pct"),
        pl.lit(0.0).alias("orderbook_available"),
    ])

    # #5 Price model input diversity：準備 adj_close 和 log(adj_close) 序列
    adj_prices_arr = np.array([float(p.get("adj_close", p["close"])) for p in req.prices])
    log_adj_prices_arr = np.log(np.maximum(adj_prices_arr, 1e-8))

    X, y, feature_names = get_features(df, target_col="target_dir")
    X_latest = X[-1] if len(X) > 0 else np.zeros(max(len(feature_names), 1))

    # RobustScaler for scale-sensitive models (DLinear, PatchTST, FT-Transformer)
    # Tree models (XGB, CatBoost, ExtraTrees, LGBM) are scale-invariant → use raw X
    from .features import fit_robust_scaler, apply_robust_scaler
    if len(X) > 0:
        fit_robust_scaler(X, req.symbol)
        X_scaled = apply_robust_scaler(X, req.symbol)
        X_scaled_latest = X_scaled[-1]
    else:
        X_scaled, X_scaled_latest = X, X_latest

    # #6 Feature model input diversity：CatBoost 滯後特徵 + LightGBM rank transform
    X_cb, y_cb, cb_names = get_catboost_features(df, target_col="target_dir")
    X_cb_latest = X_cb[-1] if len(X_cb) > 0 else np.zeros(max(len(cb_names), 1))
    X_lgbm = get_lgbm_features(X) if len(X) > 0 else X
    X_lgbm_latest = X_lgbm[-1] if len(X_lgbm) > 0 else X_latest
    stock_id = req.stock_id

    # ── ① HMM Regime 偵測（最前面：只需 market_env，不依賴 model output）────
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
                regime_info  = detector.predict_regime(cur_feat)
                regime_label = regime_info.get("label", "N/A")
    except Exception as e:
        print(f"[Regime] failed: {e}")

    # ── GARCH 波動率 ──────────────────────────────────────────────────────────
    garch_vol = run_garch_volatility(prices_arr, horizon=5)

    # ── Isolation Forest（降級為 soft penalty，不再 hard gate）────────────────
    _, anomaly_score = _check_anomaly(X, X_latest) if len(X) >= 30 else (False, 0.0)
    if anomaly_score < -0.5:
        print(f"[Anomaly] {req.symbol} soft penalty（score={anomaly_score:.3f}），models 照跑")

    # ── Stacking Meta-Learner 載入 ────────────────────────────────────────────
    meta_bundle = None
    try:
        from .stacking import load_meta_learner
        meta_bundle = load_meta_learner(stock_id)
    except Exception as e:
        print(f"[Stacking] load failed: {e}")

    # ── LinUCB Bandit（第11模型 Layer 1：市場情境路由）────────────────────────
    bandit_multipliers = None
    _market_risk  = float((req.market_env or {}).get("risk_score") or 50) / 100.0
    _regime_label = regime_label if regime_label != "N/A" else None
    _bandit       = None
    try:
        _bandit = load_bandit("/tmp/linucb_bandit")
        # P1#10: dynamic alpha from adaptive_params (win/loss streak)
        _losses_5d = int(req.adaptive_params.get("losses_5d", 0))
        _total_5d = int(req.adaptive_params.get("total_5d", 0))
        _bandit.alpha = compute_dynamic_alpha(_losses_5d, _total_5d)
        bandit_multipliers = linucb_select(
            hmm_regime=_regime_label,
            garch_vol=garch_vol,
            current_price=current_price,
            market_risk_score=_market_risk,
            bandit=_bandit,
            adaptive_params=req.adaptive_params,   # T+1 bandit protection
        )
    except Exception as e:
        print(f"[LinUCB] failed: {e}")

    # ── ARF Aggregator（第11模型 Layer 2：在線增量聚合）────────────────────────
    # 注意：ARF 特徵需要在 10 個模型跑完後建立，這裡先載入 ARF 實例
    _arf = load_arf(ARF_STATE_DIR)

    # ── 10 個模型預測（#17 並行化 + #5/#6 input diversity）──────────────────
    predictions = []

    # 純價格族（5 個）— #5 各吃不同 input，#17 並行執行
    price_model_fns = [
        ("KalmanFilter",    lambda: run_kalman_filter(prices_arr, req.horizon, stock_id)),      # raw close（需真實跳動）
        ("DLinear",         lambda: run_dlinear(adj_prices_arr, req.horizon)),                   # #5 adj_close（趨勢分解）
        ("MarkovSwitching", lambda: run_markov_switching(adj_prices_arr, req.horizon, stock_id)),# #5/#13 adj_close + regime switch
        ("PatchTST",        lambda: run_patchtst(prices_arr, req.horizon, stock_id)),            # raw close（內部已正規化）
        ("Chronos",         lambda: run_chronos(adj_prices_arr, req.horizon, stock_id)),         # #5 adj_close（foundation model 需乾淨序列）
    ]

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(fn): name for name, fn in price_model_fns}
        for future in as_completed(futures):
            name = futures[future]
            try:
                predictions.append(future.result())
            except Exception as e:
                print(f"[{name}] failed: {e}")

    # 特徵族（5 個）— #6 CatBoost/LightGBM 各用不同 input，#17 並行執行
    if len(X) >= 30:
        feat_model_fns = [
            ("XGBoost",        lambda: run_xgboost(X, y, X_latest, prices_arr, req.horizon, stock_id, feature_names)),
            ("CatBoost",       lambda: run_catboost(X_cb, y_cb, X_cb_latest, prices_arr, req.horizon, stock_id, cb_names)),  # #6 滯後特徵
            ("ExtraTrees",     lambda: run_extra_trees(X, y, X_latest, prices_arr, req.horizon, stock_id, feature_names)),
            ("LightGBM",       lambda: run_lightgbm(X_lgbm, y, X_lgbm_latest, prices_arr, req.horizon, stock_id, feature_names)),  # #6 rank transform
            ("FT-Transformer", lambda: run_ft_transformer(X_scaled, y, X_scaled_latest, prices_arr, req.horizon, stock_id, feature_names)),  # RobustScaler
        ]

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {executor.submit(fn): name for name, fn in feat_model_fns}
            for future in as_completed(futures):
                name = futures[future]
                try:
                    predictions.append(future.result())
                except Exception as e:
                    print(f"[{name}] failed: {e}")

    if not predictions:
        raise RuntimeError("所有模型均失敗")

    # ── ARF 特徵建構（10 個模型跑完後）────────────────────────────────────────
    _ctx = build_context(_regime_label, garch_vol, current_price, _market_risk)
    _arf_features = build_arf_features(
        predictions,
        hmm_regime_norm=float(_ctx[0]),
        garch_vol_norm=float(_ctx[1]),
        market_risk_score=_market_risk,
    )

    # ── Ensemble（Layer 1 LinUCB 加權投票 + anomaly soft penalty）────────────
    result = weighted_vote(
        predictions, current_price, atr,
        req.real_accuracies, req.model_stats,
        regime_info=regime_info,
        meta_bundle=meta_bundle,
        garch_vol=garch_vol,
        bandit_multipliers=bandit_multipliers,
        adaptive_params=req.adaptive_params,   # T+1 自適應（信心門檻/PF/SL_TP）
        trading_config=req.trading_config,      # B12 fix: Optuna baseline (含 sltp)
        anomaly_score=anomaly_score,            # soft penalty，不再 hard gate
        lifecycle_weights=req.lifecycle_weights, # P1#8: model lifecycle 降權
    )

    # ── ③ Conformal Prediction 校準（ensemble 之後、ARF 之前）────────────────
    conformal_info = {}
    try:
        from .conformal import load_conformal, apply_conformal_calibration
        _conformal = load_conformal()
        cal_conf, conformal_info = apply_conformal_calibration(
            _conformal,
            forecast_pct=result.forecast_pct,
            confidence=result.confidence,
            anomaly_score=anomaly_score,
        )
        if conformal_info.get("is_calibrated"):
            result.confidence = round(cal_conf, 3)
            result.reasoning = (
                f"[Conformal: ±{conformal_info['interval_width']:.1%}, "
                f"penalty={conformal_info['uncertainty_penalty']:.2f}] "
                + result.reasoning
            )
    except Exception as e:
        print(f"[Conformal] failed: {e}")

    # ── ARF 修正（Layer 2 增量聚合）───────────────────────────────────────────
    # warm-up 前 apply_arf_correction 完全透明（回傳原始值）
    arf_is_up, arf_conf, arf_signal, arf_prob = apply_arf_correction(
        _arf,
        _arf_features,
        ensemble_is_up=(result.direction == "up"),
        ensemble_confidence=result.confidence,
        ensemble_signal=result.signal,
    )
    arf_changed = arf_signal != result.signal

    # 若 ARF 有修正訊號，更新 result 欄位（保守：只修改 signal / confidence）
    # P1#10: dynamic warm-up threshold based on volatility
    _garch_norm = min(2.0, garch_vol / (current_price * 0.02)) if garch_vol and current_price > 0 else 0.4
    _arf_min_obs = get_dynamic_min_obs(_garch_norm)
    if arf_changed and _arf.is_warmed_up(min_obs=_arf_min_obs):
        result.signal     = arf_signal
        result.confidence = round(arf_conf, 3)
        result.reasoning  = (
            f"[ARF修正: {result.signal}→{arf_signal}, P(up)={arf_prob:.2f}] "
            + result.reasoning
        )

    best_model = max(predictions, key=lambda p: p.confidence * p.direction_accuracy)

    return {
        "stock_id": stock_id, "symbol": req.symbol,
        "current_price": current_price,
        "signal": result.signal, "direction": result.direction,
        "confidence": result.confidence, "consensus": result.consensus,
        "forecast_pct": result.forecast_pct, "forecast_range": result.forecast_range,
        "signal_strength": result.signal_strength, "reasoning": result.reasoning,
        "entry_price": result.entry_price, "stop_loss": result.stop_loss,
        "target1": result.target1, "target2": result.target2,
        "models": result.models,
        "best_model": best_model.model_name, "forecasts": best_model.forecasts,
        "features_used": feature_names,
        "feature_importance": _extract_feature_importance(predictions, feature_names),
        "feature_version": "v4_9models",
        "regime": regime_label,
        "garch_vol": round(garch_vol, 4) if garch_vol else None,
        "anomaly_score": round(anomaly_score, 4),
        "meta_learner_used": meta_bundle is not None,
        # ── 第11模型狀態（供前端 / Discord 顯示診斷資訊）──────────────────────
        "linucb_best_arm":   _bandit.best_arm(_ctx) if _bandit and _bandit.is_warmed_up() else None,
        "linucb_warmed_up":  _bandit.is_warmed_up() if _bandit else False,
        "arf_prob":          round(arf_prob, 4),
        "arf_warmed_up":     _arf.is_warmed_up(),
        "arf_n_trained":     _arf.n_trained,
        # arf_features 序列化供驗證 cron 回填 reward 使用
        "arf_features":      _arf_features.tolist(),
        # ── Conformal Prediction 校準狀態 ────────────────────────────────────
        "conformal_calibrated":  conformal_info.get("is_calibrated", False),
        "conformal_interval":    conformal_info.get("interval_width", 0.0),
        "conformal_penalty":     conformal_info.get("uncertainty_penalty", 1.0),
        "conformal_n_residuals": conformal_info.get("n_residuals", 0),
    }


@app.post("/predict")
async def predict_endpoint(req: PredictRequest, request: Request):
    """HTTP endpoint wrapper — adds auth then delegates to predict_stock()."""
    await verify_service_token(request)
    return predict_stock(req)


# ══════════════════════════════════════════════════════════════════════════════
# 2.0 Predict Path — regression models + IC-weighted rank_to_signal
# ══════════════════════════════════════════════════════════════════════════════
# TODO: 穩定後砍 predict_stock() 和 models.py 裡的 run_xgboost/catboost/etc

_MODEL_NAMES_V2 = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"]


def predict_stock_v2(req: PredictRequest) -> dict:
    """2.0 predict: load regression models from GCS → .predict(X_latest) → rank_to_signal().

    Differences from predict_stock (1.0):
      - target_col="target_rank" (not "target_dir")
      - Loads universal regression models (stock_id=0), not per-stock classifiers
      - .predict() returns rank 0~1, not .predict_proba()
      - IC-weighted ensemble via rank_to_signal() (not weighted_vote())
      - No per-stock retrain fallback (universal model only)
    """
    import torch
    from .model_store import load_model
    from .ensemble import rank_to_signal, load_ic_weights
    from .features import get_features

    if len(req.prices) < 60:
        raise ValueError("需要至少 60 天的股價數據")

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(
        req.prices, req.indicators, chips_input,
        req.sentiment_scores, req.market_env,
        barrier_params=req.barrier_params or None,
        stock_meta=getattr(req, "stock_meta", None),
    )

    prices_arr = np.array([float(p["close"]) for p in req.prices])
    current_price = float(prices_arr[-1])
    atr = float((req.indicators[-1].get("atr14") or 0)) if req.indicators else current_price * 0.02

    # Feature extraction — 2.0 uses target_rank (continuous 0~1)
    # 2026-04-17 v2-predict-crash fix:
    # target_rank is produced by cross-sectional pooling (prep_universal_batch).
    # Single-stock predict-time `build_feature_matrix` doesn't produce target_rank
    # → get_features raises ValueError (line 947) → v2 crashes on every stock,
    #   falls through to v1 fallback which only works for 5 per-stock legacy
    #   models → pipeline writes 3/33 predictions every day.
    # Fix: pass allow_missing_target=True so get_features tolerates predict-time
    # (y unused — we only consume X_latest).
    X, y, feature_names = get_features(df, target_col="target_rank", allow_missing_target=True)
    if len(X) == 0:
        raise ValueError(f"Feature matrix empty for {req.symbol}")
    X_latest = X[-1].reshape(1, -1)

    # Load IC weights for Grinold-Kahn ensemble
    ic_weights = load_ic_weights()

    # Predict with each model
    rank_scores: dict[str, float] = {}
    model_errors: list[str] = []

    for model_name in _MODEL_NAMES_V2:
        try:
            model_obj, meta = load_model(0, model_name)  # stock_id=0 = universal
            if model_obj is None:
                model_errors.append(f"{model_name}: not found in GCS")
                continue

            # Name-based feature alignment: align predict features to training features
            # 2026-04-17 P1 fix: missing features fill training median (from meta) not 0
            # — 填 0 會讓 tree model 把缺失當 "最低值" 處理，預測偏差；median 是 neutral 填法
            training_features = (meta or {}).get("feature_names", [])
            training_medians = (meta or {}).get("feature_medians", {})  # new metadata field
            if training_features and training_features != feature_names:
                _pred_name_to_idx = {n: i for i, n in enumerate(feature_names)}
                # Start with training medians (neutral fallback) — shape (1, n_train_features)
                _defaults = np.array(
                    [float(training_medians.get(n, 0.0)) for n in training_features],
                    dtype=np.float32,
                ).reshape(1, -1)
                _X_aligned = _defaults.copy()
                # Overwrite with actual predict values where feature name matches
                for _j, _fname in enumerate(training_features):
                    if _fname in _pred_name_to_idx:
                        _X_aligned[0, _j] = float(X_latest[0, _pred_name_to_idx[_fname]])
                X_to_predict = _X_aligned
                _missing = len([f for f in training_features if f not in _pred_name_to_idx])
                if _missing > 0:
                    _have_median = sum(1 for f in training_features if f not in _pred_name_to_idx and f in training_medians)
                    print(f"[PredictV2] {model_name}: {_missing}/{len(training_features)} features missing, "
                          f"{_have_median} filled with training median, {_missing - _have_median} filled with 0 (no median)")
            else:
                X_to_predict = X_latest

            if model_name == "FT-Transformer":
                # FT-T needs StandardScaler + torch inference
                bundle = model_obj  # joblib saved the whole bundle dict
                state_dict = bundle["state_dict"]
                scaler = bundle["scaler"]
                valid_cols = bundle.get("valid_cols_mask")
                n_feat = bundle.get("n_features", X_to_predict.shape[1])

                # Dimension mismatch guard: skip instead of crash
                if X_to_predict.shape[1] != n_feat:
                    model_errors.append(f"{model_name}: dim mismatch (predict={X_to_predict.shape[1]}, train={n_feat}), skipped")
                    continue

                # Scale
                X_scaled = scaler.transform(X_to_predict).astype(np.float32)
                X_scaled = np.nan_to_num(X_scaled, nan=0.0, posinf=0.0, neginf=0.0)

                # Rebuild model architecture (must match training)
                import torch.nn as nn
                class _FTT(nn.Module):
                    def __init__(self, n_f, d_model=128, n_heads=8, n_layers=3):
                        super().__init__()
                        self.feat_embed = nn.Linear(1, d_model, bias=True)
                        self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
                        enc_layer = nn.TransformerEncoderLayer(
                            d_model=d_model, nhead=n_heads,
                            dim_feedforward=int(d_model * 4 / 3),
                            dropout=0.1, batch_first=True,
                        )
                        self.encoder = nn.TransformerEncoder(enc_layer, num_layers=n_layers)
                        self.head = nn.Linear(d_model, 1)
                    def forward(self, x):
                        B = x.shape[0]
                        tokens = self.feat_embed(x.unsqueeze(-1))
                        cls = self.cls_token.expand(B, -1, -1)
                        tokens = torch.cat([cls, tokens], dim=1)
                        out = self.encoder(tokens)
                        return self.head(out[:, 0, :]).squeeze(-1)

                ftt = _FTT(n_feat)
                ftt.load_state_dict(state_dict)
                ftt.eval()
                with torch.no_grad():
                    pred = ftt(torch.tensor(X_scaled)).item()
                rank_scores[model_name] = float(np.clip(pred, 0.0, 1.0))
            else:
                # Tree models: .predict() returns rank 0~1 directly
                pred = model_obj.predict(X_to_predict)
                rank_scores[model_name] = float(np.clip(pred[0], 0.0, 1.0))

        except Exception as e:
            model_errors.append(f"{model_name}: {e}")

    if not rank_scores:
        raise ValueError(f"All models failed for {req.symbol}: {model_errors}")

    # IC-weighted ensemble → EnsembleResult
    result = rank_to_signal(
        rank_scores=rank_scores,
        current_price=current_price,
        atr=atr,
        ic_weights=ic_weights if ic_weights else None,
    )

    return {
        "stock_id": req.stock_id, "symbol": req.symbol,
        "current_price": current_price,
        "signal": result.signal, "direction": result.direction,
        "confidence": result.confidence, "consensus": result.consensus,
        "forecast_pct": result.forecast_pct, "forecast_range": result.forecast_range,
        "signal_strength": result.signal_strength, "reasoning": result.reasoning,
        "entry_price": result.entry_price, "stop_loss": result.stop_loss,
        "target1": result.target1, "target2": result.target2,
        "models": result.models,
        "features_used": feature_names,
        "feature_version": "v2_universal_regression",
        "model_errors": model_errors if model_errors else None,
        "ic_weights": {k: round(v, 4) for k, v in ic_weights.items()} if ic_weights else None,
        # 2026-04-19 ML_POOL Plan A: expose raw per-model rank scores so
        # pipeline_v2 can re-merge with Chronos/DLinear/PatchTST + lifecycle
        # weights from model_pool.json without a second predict round-trip.
        "rank_scores": {k: round(float(v), 6) for k, v in rank_scores.items()},
        "atr": float(atr),
    }


@app.post("/predict/v2")
async def predict_v2_endpoint(req: PredictRequest, request: Request):
    """2.0 predict endpoint — regression models + IC-weighted ensemble."""
    await verify_service_token(request)
    return predict_stock_v2(req)


def retrain_stock(req: PredictRequest) -> dict:
    """Core retrain logic — no auth, callable by Modal @function or HTTP endpoint."""
    if len(req.prices) < 60:
        raise ValueError("需要至少 60 天的股價數據")

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df          = build_feature_matrix(req.prices, req.indicators, chips_input,
                                        req.sentiment_scores, req.market_env)
    # retrain 時 optional features 填 0（歷史資料暫無，收集後再回填）
    df = df.with_columns([
        pl.lit(0.0).alias("taifex_night_change_pct"),
        pl.lit(0.0).alias("taifex_night_range_pct"),
        pl.lit(0.0).alias("taifex_night_available"),
        pl.lit(0.0).alias("orderbook_imbalance"),
        pl.lit(0.0).alias("orderbook_spread_pct"),
        pl.lit(0.0).alias("orderbook_available"),
    ])

    prices_arr  = np.array([float(p["close"]) for p in req.prices])
    X, y, feature_names = get_features(df, target_col="target_dir")

    # P1#9: Filter out weak features identified by IC audit
    if req.weak_features:
        weak_set = set(req.weak_features)
        keep_idx = [i for i, f in enumerate(feature_names) if f not in weak_set]
        if len(keep_idx) >= 5:  # guard: keep at least 5 features
            dropped = len(feature_names) - len(keep_idx)
            X = X[:, keep_idx]
            feature_names = [feature_names[i] for i in keep_idx]
            print(f"[Retrain] IC filter: dropped {dropped} weak features, {len(feature_names)} remaining")

    if len(X) < 30:
        raise ValueError("特徵樣本不足 30 筆")

    # Training masking：50% samples 隨機 mask 夜盤特徵
    from .features import mask_night_session_features
    X = mask_night_session_features(X, feature_names, mask_ratio=0.5)

    results = {}
    split   = int(len(X) * 0.8)
    from .model_store import save_model

    # P1#9: Optuna hyperparameter search (if enabled)
    optuna_params: dict[str, dict] = {}
    if req.use_optuna and len(X) >= 60:
        from .optuna_retrain import search_best_params
        for model_name in ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]:
            bp = search_best_params(model_name, X, y)
            if bp:
                optuna_params[model_name] = bp
                print(f"[Retrain] Optuna {model_name}: {bp}")

    # Build model specs — use Optuna params if available, else defaults
    xgb_p = optuna_params.get("XGBoost", {})
    cat_p = optuna_params.get("CatBoost", {})
    et_p  = optuna_params.get("ExtraTrees", {})

    _specs = [
        ("XGBoost",    lambda: __import__("xgboost", fromlist=["XGBRegressor"]).XGBRegressor(
                           n_estimators=xgb_p.get("n_estimators", 150),
                           max_depth=xgb_p.get("max_depth", 4),
                           learning_rate=xgb_p.get("learning_rate", 0.05),
                           objective="reg:squarederror",
                           subsample=xgb_p.get("subsample", 0.9),
                           colsample_bytree=xgb_p.get("colsample_bytree", 0.9),
                           eval_metric="rmse",
                           random_state=42, verbosity=0)),
        ("CatBoost",   lambda: __import__("catboost", fromlist=["CatBoostRegressor"]).CatBoostRegressor(
                           iterations=cat_p.get("iterations", 200),
                           depth=cat_p.get("depth", 5),
                           learning_rate=cat_p.get("learning_rate", 0.05),
                           l2_leaf_reg=cat_p.get("l2_leaf_reg", 3.0),
                           loss_function="RMSE", random_seed=42, verbose=0)),
        ("ExtraTrees", lambda: __import__("sklearn.ensemble", fromlist=["ExtraTreesRegressor"]).ExtraTreesRegressor(
                           n_estimators=et_p.get("n_estimators", 200),
                           max_depth=et_p.get("max_depth", 6),
                           min_samples_split=et_p.get("min_samples_split", 5),
                           min_samples_leaf=et_p.get("min_samples_leaf", 3),
                           max_features="sqrt", bootstrap=True,
                           random_state=42, n_jobs=-1)),
        ("LightGBM",   lambda: None),         # 特殊處理（直接呼叫 run_lightgbm）
        ("FT-Transformer", lambda: None),     # 特殊處理（PyTorch + scaler bundle）
    ]

    X_latest_rt = X[-1] if len(X) > 0 else np.zeros(max(len(feature_names), 1))

    for name, factory in _specs:
        try:
            if name == "LightGBM":
                # P1#9: LightGBM has its own internal params, Optuna params logged but not injected
                # (run_lightgbm uses lgb.train API which takes params dict differently)
                result = run_lightgbm(X, y, X_latest_rt, prices_arr, req.horizon, req.stock_id, feature_names)
                acc = float(result.direction_accuracy)
            elif name == "FT-Transformer":
                result = run_ft_transformer(X, y, X_latest_rt, prices_arr, req.horizon, req.stock_id, feature_names)
                acc = float(result.direction_accuracy)
            else:
                m = factory()
                m.fit(X[:split], y[:split])
                acc = float(m.score(X[split:], y[split:])) if len(X[split:]) > 0 else 0.5
                save_model(req.stock_id, name, m, feature_names, len(X))
            results[name] = {"accuracy": round(acc, 3), "samples": len(X), "saved": True}
        except Exception as e:
            results[name] = {"error": str(e)}

    # Stacking
    try:
        from .stacking import train_meta_learner_oof, save_meta_learner
        bundle = train_meta_learner_oof(X, y, prices_arr, feature_names, req.stock_id)
        if bundle:
            save_meta_learner(bundle, req.stock_id)
            results["Stacking"] = {"trained": True, "saved": True}
        else:
            results["Stacking"] = {"trained": False, "reason": "insufficient OOF samples"}
    except Exception as e:
        results["Stacking"] = {"error": str(e)}

    # P2#21: MLP Shadow — train parallel to LR stacking, compare 4 weeks
    try:
        from .stacking_mlp import train_shadow_mlp
        mlp_result = train_shadow_mlp(X, y)
        if mlp_result:
            results["MLP_Shadow"] = {"trained": True, "oos_accuracy": mlp_result.get("oos_accuracy")}
        else:
            results["MLP_Shadow"] = {"trained": False, "reason": "insufficient data or failed"}
    except Exception as e:
        results["MLP_Shadow"] = {"error": str(e)}

    # HMM Regime
    try:
        from .regime import RegimeDetector, build_market_feature_matrix
        feat_mat = build_market_feature_matrix(req.market_env)
        if feat_mat is not None and len(feat_mat) >= 20:
            det = RegimeDetector().fit(feat_mat)
            det.save_to_gcs()
            results["HMM_Regime"] = {"n_components": det.n_components, "trained": True, "saved": True}
        else:
            results["HMM_Regime"] = {"trained": False, "reason": "insufficient market history"}
    except Exception as e:
        results["HMM_Regime"] = {"error": str(e)}

    return {
        "stock_id": req.stock_id, "symbol": req.symbol,
        "retrained_at": datetime.utcnow().isoformat() + "Z",
        "feature_count": len(feature_names),
        "features_dropped": len(req.weak_features) if req.weak_features else 0,
        "optuna_models": list(optuna_params.keys()),
        "feature_version": "v5_ic_optuna",
        "results": results,
    }


@app.post("/retrain")
async def retrain_endpoint(req: PredictRequest, request: Request):
    """HTTP endpoint wrapper — adds auth then delegates to retrain_stock()."""
    await verify_service_token(request)
    return retrain_stock(req)


# ── Universal Model Retrain (Batch approach) ────────────────────────────────
#
# 流程：
#   1. prep_universal_batch(payloads) × N 批 → 存 GCS universal/prep/batch_{i}.npz
#   2. train_universal_from_gcs() → 讀全部 npz → concat → 訓練 5 models → 存 GCS
#

class UniversalPrepRequest(BaseModel):
    """單批 prep request — ml-controller 分批送 ~500 stocks。"""
    payloads: list[dict]
    barrier_params: dict = {}
    batch_index: int = 0
    # Batch-level shared data (avoid duplicating in every payload)
    shared_market_history: dict = {}    # {date: {risk_score, us_vix, ...}} — same for all stocks
    per_stock_ts_map: dict = {}         # {stock_id_str: {date: {revenue_yoy, margin_balance, ...}}}
    # V2 Feature Pool: only keep these features in the output (None = keep all)
    active_features: list[str] | None = None


class UniversalTrainRequest(BaseModel):
    """觸發 train — 不帶資料，從 GCS 讀 prep 結果。"""
    batch_count: int = 5  # 預期幾個 batch npz
    models_filter: list[str] | None = None  # None=all, or ["XGBoost","CatBoost",...] subset
    skip_feature_pool: bool = False  # True = FT-T mode: use all features, skip pool filter
    # ── 2026-04-18 #32 Sprint 6b walk-forward params ──────────────────────────
    # When train_start/train_end given: use explicit date range instead of purged split.
    # test_start/test_end: OOS evaluation range (must be AFTER train_end, can have gap).
    # gcs_prefix: override default 'universal/' save path. For walk-forward: 'walk_forward/w{id}'.
    # window_id: identifier stored in model metadata for traceability.
    train_start: str | None = None
    train_end: str | None = None
    test_start: str | None = None
    test_end: str | None = None
    gcs_prefix: str | None = None
    window_id: int | None = None
    skip_weekly_backup: bool = False  # walk-forward uses window-versioned paths, no weekly needed
    # 2026-04-19 N2: walk-forward — load per-window pool to eliminate look-ahead bias.
    # None → legacy (universal/feature_pool.json). Walk-forward orchestrator passes
    # {gcs_prefix}/feature_pool.json after running per-window feature_selection.
    feature_pool_path: str | None = None


class UniversalRetrainRequest(BaseModel):
    """向後相容：單次全量 retrain（小規模測試用）。"""
    payloads: list[dict]
    barrier_params: dict = {}


def prep_universal_batch(req: UniversalPrepRequest) -> dict:
    """單批 feature engineering — build_feature_matrix × N stocks → 存 GCS npz。

    ml-controller 分 5 批各 ~500 stocks 呼叫此函數。
    結果存 GCS universal/prep/batch_{i}.npz (X, y, dates, feature_names)。
    """
    import time, io, json
    t0 = time.time()
    payloads = req.payloads

    from .features import build_feature_matrix, get_features, FEATURE_COLS
    from .model_store import _get_bucket

    # Batch-level shared data — inject into each stock's market_env at prep time
    shared_history = req.shared_market_history or {}
    ps_ts_map = req.per_stock_ts_map or {}

    all_dfs = []
    skipped = 0
    for payload in payloads:
        prices_data = payload.get("prices", [])
        if len(prices_data) < 60:
            skipped += 1
            continue
        try:
            chips_input = payload.get("chips", [])
            market_upper = payload.get("market", "TW").upper()
            if market_upper in ("US", "NYSE", "NASDAQ"):
                chips_input = []
            # Inject batch-level shared data into market_env
            me = payload.get("market_env") or {}
            if shared_history and "history" not in me:
                me["history"] = shared_history
            stock_id_str = str(payload.get("stock_id", ""))
            if ps_ts_map and stock_id_str in ps_ts_map:
                me["per_stock_ts"] = ps_ts_map[stock_id_str]
            df = build_feature_matrix(
                prices_data,
                payload.get("indicators", []),
                chips_input,
                payload.get("sentiment_scores", []),
                me,
                req.barrier_params or None,
                payload.get("stock_meta"),
            )
            # 保留 date 供時間基 split
            if "date" not in df.columns and len(prices_data) > 0:
                dates = [p.get("date", "") for p in prices_data]
                date_list = dates[-len(df):] if len(dates) >= len(df) else dates + [""] * (len(df) - len(dates))
                df = df.with_columns(pl.Series("_date", date_list))
            elif "date" in df.columns:
                df = df.with_columns(pl.col("date").cast(pl.Utf8).alias("_date"))
            else:
                df = df.with_columns(pl.lit("").alias("_date"))
            all_dfs.append(df)
        except Exception as e:
            skipped += 1
            print(f"[PrepBatch] Skip stock: {e}")

    if not all_dfs:
        return {"batch_index": req.batch_index, "rows": 0, "skipped": skipped, "error": "no valid stocks"}

    pooled = pl.concat(all_dfs, how="diagonal_relaxed")

    # 2.0: Cross-sectional rank label — per-date rank of target_5d (0~1)
    from .features import compute_cross_sectional_rank
    pooled = compute_cross_sectional_rank(pooled, return_col="target_5d", date_col="_date")
    rank_stats = pooled["target_rank"].describe()
    print(f"[PrepBatch] Cross-sectional rank: mean={pooled['target_rank'].mean():.3f}, "
          f"nulls={pooled['target_rank'].null_count()}")

    # V2 Feature Pool: filter to active features only (if provided)
    active_filter = req.active_features
    if active_filter:
        keep_cols = [c for c in active_filter if c in pooled.columns]
        drop_cols = [c for c in FEATURE_COLS if c in pooled.columns and c not in keep_cols]
        if drop_cols:
            pooled = pooled.drop(drop_cols)
            print(f"[PrepBatch] Feature pool filter: kept {len(keep_cols)}, dropped {len(drop_cols)}")

    # 2026-04-18 #32 walk-forward bug fix:
    # Derive X / y / dates_arr from the SAME df_clean so .shape[0] aligned.
    # Previous code: X from get_features() which drops on target_rank+target_5d,
    # dates_arr from a separate df_clean dropping target_rank+target_5d+target_dir
    # → X had 38K more rows than dates → walk-forward boolean mask crashed.
    available = [c for c in FEATURE_COLS if c in pooled.columns]
    select_cols = available + ["target_rank", "_date"]
    if "target_5d" in pooled.columns:
        select_cols.append("target_5d")
    if "target_dir" in pooled.columns:
        select_cols.append("target_dir")
    df_clean = pooled.select(select_cols).drop_nulls()
    X = df_clean.select(available).to_numpy()
    y = df_clean["target_rank"].to_numpy()
    dates_arr = df_clean["_date"].to_numpy()
    feature_names = available
    assert len(X) == len(y) == len(dates_arr), (
        f"prep alignment broken: X={len(X)} y={len(y)} dates={len(dates_arr)}"
    )

    # 存 GCS npz
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    buf = io.BytesIO()
    np.savez_compressed(buf, X=X, y=y, dates=dates_arr)
    buf.seek(0)
    blob = bucket.blob(f"universal/prep/batch_{req.batch_index}.npz")
    blob.upload_from_file(buf, content_type="application/octet-stream")

    # feature_names 只需存一次（每批都一樣），batch_0 存
    if req.batch_index == 0:
        meta_blob = bucket.blob("universal/prep/feature_names.json")
        meta_blob.upload_from_string(json.dumps(feature_names), content_type="application/json")

    elapsed = round(time.time() - t0, 1)
    print(f"[PrepBatch] batch_{req.batch_index}: {len(all_dfs)} stocks → {len(X)} rows, "
          f"skipped {skipped}, {elapsed}s")

    return {
        "batch_index": req.batch_index,
        "stocks_pooled": len(all_dfs),
        "rows": len(X),
        "features": len(feature_names),
        "skipped": skipped,
        "elapsed_s": elapsed,
    }


def train_universal_from_gcs(req: UniversalTrainRequest) -> dict:
    """從 GCS 讀全部 prep npz → concat → 時間基 split → 訓練 5 models → 存 GCS。"""
    import time, io, json
    t0 = time.time()

    from .model_store import _get_bucket, save_model

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    # ── 1. Load all batch npz ────────────────────────────────────────────────
    all_X, all_y, all_dates = [], [], []
    for i in range(req.batch_count):
        blob = bucket.blob(f"universal/prep/batch_{i}.npz")
        if not blob.exists():
            print(f"[TrainUniversal] batch_{i}.npz not found, skipping")
            continue
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
        print(f"[TrainUniversal] batch_{i}: {len(data['X'])} rows loaded")

    if not all_X:
        raise ValueError("No prep batches found in GCS")

    X = np.concatenate(all_X, axis=0)
    y = np.concatenate(all_y, axis=0)
    dates_arr = np.concatenate(all_dates, axis=0)

    # Load feature names
    fn_blob = bucket.blob("universal/prep/feature_names.json")
    feature_names = json.loads(fn_blob.download_as_text()) if fn_blob.exists() else [f"f{i}" for i in range(X.shape[1])]

    # ── 1b. Filter to active features from feature_pool.json ─────────────────
    # Feature selection 產出 pool → train 只用 active features（降維 + 避免 noise）
    # skip_feature_pool=True (FT-T mode): use all 106 features, bypass pool filter
    if req.skip_feature_pool:
        print(f"[TrainUniversal] skip_feature_pool=True → using all {len(feature_names)} features (FT-T mode)")
    else:
        # 2026-04-19 N2: walk-forward passes feature_pool_path = walk_forward/w{id}/feature_pool.json
        # so each tree window loads its own pool computed only from data ≤ train_end (no leak).
        pool_path = req.feature_pool_path or "universal/feature_pool.json"
        try:
            pool_blob = bucket.blob(pool_path)
            if pool_blob.exists():
                pool = json.loads(pool_blob.download_as_text())
                # Prefer tree_active (dual-pool output), fallback to active (backward compat)
                active = pool.get("tree_active") or pool.get("active", [])
                if active:
                    keep_idx = [i for i, name in enumerate(feature_names) if name in set(active)]
                    if keep_idx:
                        orig_count = len(feature_names)
                        X = X[:, keep_idx]
                        feature_names = [feature_names[i] for i in keep_idx]
                        print(f"[TrainUniversal] Feature pool filter ({pool_path}): {len(keep_idx)} active (from {orig_count} total)")
                    else:
                        print(f"[TrainUniversal] Feature pool {pool_path} has {len(active)} active but none match prep columns, using all")
                else:
                    print(f"[TrainUniversal] Feature pool {pool_path} empty, using all features")
            else:
                print(f"[TrainUniversal] No {pool_path}, using all features")
        except Exception as e:
            print(f"[TrainUniversal] Feature pool load failed (using all): {e}")

    print(f"[TrainUniversal] Total: {len(X)} rows × {len(feature_names)} features")

    # ── 2026-04-18 #32 Sprint 6b: walk-forward explicit date-range split ─────
    # When train_start/train_end/test_start/test_end are all provided, skip
    # purged_train_test_split and use the explicit dates. Walk-forward windows
    # already enforce train-then-test temporal ordering so embargo is implicit
    # in the window step_size.
    walk_forward_mode = (
        req.train_start is not None and req.train_end is not None
        and req.test_start is not None and req.test_end is not None
    )

    if walk_forward_mode:
        print(f"[TrainUniversal] Walk-forward mode: train={req.train_start}..{req.train_end} "
              f"test={req.test_start}..{req.test_end} window_id={req.window_id}")
        # dates_arr is numpy array of "YYYY-MM-DD" strings
        dates_str = dates_arr.astype(str)
        train_mask = (dates_str >= req.train_start) & (dates_str <= req.train_end)
        test_mask  = (dates_str >= req.test_start)  & (dates_str <= req.test_end)
        X_train, y_train, dates_train = X[train_mask], y[train_mask], dates_arr[train_mask]
        X_test,  y_test,  dates_test  = X[test_mask],  y[test_mask],  dates_arr[test_mask]
        print(f"[TrainUniversal] Walk-forward split: train={len(X_train)}, test={len(X_test)}")
        if len(X_train) < 500:
            raise ValueError(
                f"Walk-forward train window {req.train_start}..{req.train_end} has only "
                f"{len(X_train)} samples (<500 minimum)"
            )
        if len(X_test) < 100:
            raise ValueError(
                f"Walk-forward test window {req.test_start}..{req.test_end} has only "
                f"{len(X_test)} samples (<100 minimum)"
            )
    else:
        if len(X) < 1000:
            raise ValueError(f"Pooled 樣本不足 1000 ({len(X)})")
        # ── 2. Purged time-based split (2.0: embargo gap to prevent label leakage) ──
        from .purged_cv import purged_train_test_split
        X_train, y_train, dates_train, X_test, y_test, dates_test = purged_train_test_split(
            X, y, dates_arr,
            test_ratio=0.2,
            embargo_days=10,  # ~1.3%T per De Prado AFML Ch.7
        )
        print(f"[TrainUniversal] Purged split: train={len(X_train)}, test={len(X_test)}, embargo=10d")

    # ── 3. Train models (filtered by models_filter if set) ──────────────────
    results = {}
    trained_models: dict[str, object] = {}  # model_name → trained model (for IC tracking)
    _filter = set(req.models_filter) if req.models_filter else None
    def _should_train(name: str) -> bool:
        return _filter is None or name in _filter
    class _SkipModel(Exception):
        pass

    # ── Helper: compute OOS Spearman IC ────────────────────────────────────────
    from scipy.stats import spearmanr as _spearmanr

    def _oos_ic(preds: np.ndarray, y_actual: np.ndarray) -> float:
        if len(preds) < 10 or np.std(preds) < 1e-10 or np.std(y_actual) < 1e-10:
            return 0.0
        rho, _ = _spearmanr(preds, y_actual)
        return float(rho) if not np.isnan(rho) else 0.0

    # 3a: XGBoost (regression)
    try:
        if not _should_train("XGBoost"):
            raise _SkipModel()
        from xgboost import XGBRegressor
        xgb = XGBRegressor(
            n_estimators=300, max_depth=6, learning_rate=0.03,
            objective="reg:squarederror",
            subsample=0.8, colsample_bytree=0.8,
            eval_metric="rmse",
            random_state=42, verbosity=0, n_jobs=-1,
        )
        xgb.fit(X_train, y_train)
        preds = xgb.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["XGBoost"] = xgb
        results["XGBoost"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] XGBoost IC={ic:.4f}")
    except _SkipModel:
        results["XGBoost"] = {"skipped": True}
    except Exception as e:
        results["XGBoost"] = {"error": str(e)}

    # 3b: CatBoost (regression)
    try:
        if not _should_train("CatBoost"):
            raise _SkipModel()
        from catboost import CatBoostRegressor
        cat = CatBoostRegressor(
            iterations=400, depth=6, learning_rate=0.03,
            l2_leaf_reg=3.0, loss_function="RMSE",
            random_seed=42, verbose=0, thread_count=-1,
        )
        cat.fit(X_train, y_train)
        preds = cat.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["CatBoost"] = cat
        results["CatBoost"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] CatBoost IC={ic:.4f}")
    except _SkipModel:
        results["CatBoost"] = {"skipped": True}
    except Exception as e:
        results["CatBoost"] = {"error": str(e)}

    # 3c: ExtraTrees (regression)
    try:
        if not _should_train("ExtraTrees"):
            raise _SkipModel()
        from sklearn.ensemble import ExtraTreesRegressor
        et = ExtraTreesRegressor(
            n_estimators=300, max_depth=8,
            min_samples_split=10, min_samples_leaf=5,
            max_features="sqrt",
            bootstrap=True, random_state=42, n_jobs=-1,
        )
        et.fit(X_train, y_train)
        preds = et.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["ExtraTrees"] = et
        results["ExtraTrees"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] ExtraTrees IC={ic:.4f}")
    except _SkipModel:
        results["ExtraTrees"] = {"skipped": True}
    except Exception as e:
        results["ExtraTrees"] = {"error": str(e)}

    # 3d: LightGBM (regression)
    try:
        if not _should_train("LightGBM"):
            raise _SkipModel()
        import lightgbm as lgb
        lgbm = lgb.LGBMRegressor(
            n_estimators=300, max_depth=6, learning_rate=0.03,
            objective="regression",
            num_leaves=63, subsample=0.8, colsample_bytree=0.8,
            min_child_samples=20,
            random_state=42, verbose=-1, n_jobs=-1,
        )
        lgbm.fit(X_train, y_train)
        preds = lgbm.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["LightGBM"] = lgbm
        results["LightGBM"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] LightGBM IC={ic:.4f}")
    except _SkipModel:
        results["LightGBM"] = {"skipped": True}
    except Exception as e:
        results["LightGBM"] = {"error": str(e)}

    # 3e: FT-Transformer (regression, GPU L4 + AMP + early stopping)
    # Ref: Gorishniy et al. NeurIPS 2021 "Revisiting Deep Learning Models for Tabular Data"
    try:
        if not _should_train("FT-Transformer"):
            raise _SkipModel()
        import torch
        import torch.nn as nn

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"[TrainUniversal] FT-T device={device}")

        n_features = X_train.shape[1]
        D_MODEL, N_HEADS, N_LAYERS = 128, 8, 3
        # 2026-04-17: PATIENCE 12→16 (Gorishniy 2021 原論文標準；12 太緊讓 noisy val IC 早停)
        MAX_EPOCHS, LR, PATIENCE = 120, 2e-4, 16
        BATCH_SIZE = 1024                           # P0-5e: 512→1024

        class _FTT(nn.Module):
            def __init__(self, n_feat, d_model, n_heads, n_layers):
                super().__init__()
                self.feat_embed = nn.Linear(1, d_model, bias=True)
                self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
                encoder_layer = nn.TransformerEncoderLayer(
                    d_model=d_model, nhead=n_heads,
                    dim_feedforward=int(d_model * 4 / 3),
                    dropout=0.12, batch_first=True,  # P0-5d: 0.1→0.12 (attn=0.10/FFN=0.15/resid=0.05 weighted avg)
                )
                self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
                self.head = nn.Linear(d_model, 1)  # 2.0: regression output (single scalar)

            def forward(self, x):
                B = x.shape[0]
                tokens = self.feat_embed(x.unsqueeze(-1))
                cls = self.cls_token.expand(B, -1, -1)
                tokens = torch.cat([cls, tokens], dim=1)
                out = self.encoder(tokens)
                return self.head(out[:, 0, :]).squeeze(-1)  # (B,) scalar predictions

        from sklearn.preprocessing import StandardScaler
        feat_scaler = StandardScaler()
        Xt = feat_scaler.fit_transform(X_train).astype(np.float32)
        # StandardScaler: zero-variance columns get scale_=1.0 (scikit-learn docs).
        # Post-scaler, remaining NaN (from upstream edge cases) → fill with 0.0
        # which in scaled space = column mean (neutral, per Qlib CSZFillna rationale).
        zero_var_count = int((feat_scaler.scale_ <= 1e-10).sum())
        Xt = np.nan_to_num(Xt, nan=0.0, posinf=0.0, neginf=0.0)
        yt = y_train.astype(np.float32)  # 2.0: regression target (rank 0~1)
        print(f"[TrainUniversal] FT-T scaler: {len(feat_scaler.scale_) - zero_var_count}/{len(feat_scaler.scale_)} columns with variance (zero-var={zero_var_count})")
        print(f"[TrainUniversal] FT-T using all {len(Xt)} samples (L4 24GB + batched val)")

        # Val split with 5-day embargo (De Prado AFML: prevent label leakage)
        # Fallback to simple split if train data < 1000 rows
        if len(Xt) >= 1000:
            _unique_td = np.sort(np.unique(np.array([str(d) for d in dates_train])))
            _n_td = len(_unique_td)
            _val_start_idx = int(_n_td * 0.8)
            _embargo_end_idx = min(_val_start_idx + 5, _n_td)
            _trn_date_set = set(_unique_td[:_val_start_idx].tolist())
            _val_date_set = set(_unique_td[_embargo_end_idx:].tolist())
            _dates_str = np.array([str(d) for d in dates_train])
            _trn_mask = np.array([d in _trn_date_set for d in _dates_str])
            _val_mask = np.array([d in _val_date_set for d in _dates_str])
            Xt_trn, yt_trn = Xt[_trn_mask], yt[_trn_mask]
            Xt_val, yt_val = Xt[_val_mask], yt[_val_mask]
            print(f"[TrainUniversal] FT-T embargo split: trn={_trn_mask.sum()}, val={_val_mask.sum()}, embargo=5d")
            if len(Xt_val) == 0:
                # Fallback if embargo ate all val data
                val_size = max(int(len(Xt) * 0.2), 256)
                Xt_val, yt_val = Xt[-val_size:], yt[-val_size:]
                Xt_trn, yt_trn = Xt[:-val_size], yt[:-val_size]
                print("[TrainUniversal] FT-T embargo fallback: not enough val dates, using simple split")
        else:
            val_size = max(int(len(Xt) * 0.2), 256)
            Xt_val, yt_val = Xt[-val_size:], yt[-val_size:]
            Xt_trn, yt_trn = Xt[:-val_size], yt[:-val_size]
            print(f"[TrainUniversal] FT-T simple split (data < 1000): trn={len(Xt_trn)}, val={len(Xt_val)}")

        model_ftt = _FTT(n_features, D_MODEL, N_HEADS, N_LAYERS).to(device)
        # AdamW; weight_decay 5e-5（PyTrial 預設 1e-4，5e-5 更溫和）
        # 2026-04-17: 移除 cosine warmup + decay scheduler
        # Gorishniy 2021 原論文明示「do not employ learning rate warmup, learning rate decay」
        # 實測 warmup 6 epochs 期 LR 過低 → model 學到 spurious peak → early stop 誤觸 → IC=0.015
        opt = torch.optim.AdamW(model_ftt.parameters(), lr=LR, weight_decay=5e-5)
        _global_step = 0
        # 2.0: Pairwise Margin Ranking Loss (CIKM 2025: best Sharpe 0.7529)
        # ListNet softmax unstable with unbounded FT-T output (caused IC=0 collapse)
        # Margin: PyTorch default=0.0; CIKM 2025 (arXiv 2510.14156) recommends grid
        # search per dataset. Read from Optuna params if available, else default 0.0.
        _ftt_margin = float(req.get("ftt_margin", 0.0)) if hasattr(req, "get") else 0.0
        _margin_loss = nn.MarginRankingLoss(margin=_ftt_margin)
        _n_pairs = 1024  # P0-5e: 256→1024 (larger batch → more pairs available)

        def crit(preds: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
            B = preds.shape[0]
            if B < 2:
                return torch.tensor(0.0, device=preds.device)
            # Sample random pairs
            n = min(_n_pairs, B * (B - 1) // 2)
            idx_i = torch.randint(0, B, (n,), device=preds.device)
            idx_j = torch.randint(0, B, (n,), device=preds.device)
            # Avoid same-index pairs
            mask = idx_i != idx_j
            idx_i, idx_j = idx_i[mask], idx_j[mask]
            if len(idx_i) == 0:
                return torch.tensor(0.0, device=preds.device)
            # target: +1 if label_i > label_j, -1 otherwise
            target = torch.sign(labels[idx_i] - labels[idx_j])
            # skip ties
            non_tie = target != 0
            if non_tie.sum() == 0:
                return torch.tensor(0.0, device=preds.device)
            return _margin_loss(preds[idx_i[non_tie]], preds[idx_j[non_tie]], target[non_tie])

        use_amp = device.type == "cuda"
        amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        grad_scaler = torch.amp.GradScaler(enabled=(use_amp and amp_dtype == torch.float16))
        print(f"[TrainUniversal] AMP={'ON' if use_amp else 'OFF'} dtype={amp_dtype if use_amp else 'fp32'}")

        from scipy.stats import spearmanr as _spearmanr  # P0-5c: val IC early stop

        # P0-5c: monitor val Spearman IC (not val_loss) — maximise rank correlation
        best_val_ic = -float("inf")
        best_state = None
        no_improve = 0
        last_epoch = 0  # P0-7: outer-scope epoch tracker (nonlocal in _run_ftt_training) — fix NameError

        def _run_ftt_training(batch_sz: int, grad_accum: int = 1) -> None:
            """Inner training loop (factored out for OOM fallback). Modifies outer scope vars."""
            nonlocal best_val_ic, best_state, no_improve, _global_step, last_epoch

            for epoch in range(MAX_EPOCHS):
                model_ftt.train()
                perm = np.random.permutation(len(Xt_trn))
                step_loss = 0.0
                opt.zero_grad()
                mini_step = 0
                for s in range(0, len(Xt_trn), batch_sz):
                    bi = perm[s:s + batch_sz]
                    xb = torch.tensor(Xt_trn[bi], device=device)
                    yb = torch.tensor(yt_trn[bi], device=device)
                    with torch.amp.autocast(device_type="cuda", dtype=amp_dtype, enabled=use_amp):
                        preds_amp = model_ftt(xb)
                    # Loss in fp32: bf16 ULP ≈ 0.004 cannot resolve rank steps of 0.0004
                    # (cross-sectional rank with 2500 stocks). PyTorch AMP docs:
                    # "Wrap fragile ops/losses in fp32 blocks."
                    loss = crit(preds_amp.float(), yb.float()) / grad_accum
                    grad_scaler.scale(loss).backward()
                    step_loss += loss.item()
                    mini_step += 1
                    if mini_step % grad_accum == 0:
                        grad_scaler.step(opt)
                        grad_scaler.update()
                        opt.zero_grad()
                        _global_step += 1
                # flush remaining gradient
                if mini_step % grad_accum != 0:
                    grad_scaler.step(opt)
                    grad_scaler.update()
                    opt.zero_grad()
                    _global_step += 1

                # P0-5c: val Spearman IC (model must be in eval mode, no grad)
                model_ftt.eval()
                with torch.no_grad():
                    val_preds = []
                    for vs in range(0, len(Xt_val), batch_sz):
                        xvb = torch.tensor(Xt_val[vs:vs + batch_sz], device=device)
                        with torch.amp.autocast(device_type="cuda", dtype=amp_dtype, enabled=use_amp):
                            val_preds.append(model_ftt(xvb).float().cpu().numpy())  # .float() bfloat16→fp32 before numpy
                    val_preds_arr = np.concatenate(val_preds)
                val_ic = 0.0
                nan_count = int(np.isnan(val_preds_arr).sum())
                if nan_count > 0:
                    print(f"[TrainUniversal] FT-T val preds contain {nan_count} NaN — skipping IC")
                elif np.std(val_preds_arr) > 1e-10 and np.std(yt_val) > 1e-10:
                    rho, _ = _spearmanr(val_preds_arr, yt_val)
                    val_ic = float(rho) if not np.isnan(rho) else 0.0

                if val_ic > best_val_ic:
                    best_val_ic = val_ic
                    best_state = {k: v.cpu().clone() for k, v in model_ftt.state_dict().items()}
                    no_improve = 0
                else:
                    no_improve += 1

                if (epoch + 1) % 10 == 0:
                    print(f"[TrainUniversal] FT-T epoch {epoch+1} val_IC={val_ic:.6f} best={best_val_ic:.6f} patience={no_improve}/{PATIENCE}")

                last_epoch = epoch + 1  # P0-7: track last completed epoch in outer scope
                if no_improve >= PATIENCE:
                    print(f"[TrainUniversal] FT-T early stop at epoch {epoch+1} (val_IC={best_val_ic:.6f})")
                    break

        # P0-5f: OOM protection — fallback to BATCH_SIZE=512 + grad_accum=2
        try:
            _run_ftt_training(BATCH_SIZE, grad_accum=1)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            print("[TrainUniversal] FT-T OOM with BATCH_SIZE=1024, retrying BATCH_SIZE=512 + grad_accum=2")
            best_val_ic = -float("inf")
            best_state = None
            no_improve = 0
            _global_step = 0
            _run_ftt_training(512, grad_accum=2)

        if best_state is not None:
            model_ftt.load_state_dict(best_state)
        model_ftt.to("cpu").eval()

        # OOS IC
        Xt_test = feat_scaler.transform(X_test).astype(np.float32)
        Xt_test = np.nan_to_num(Xt_test, nan=0.0, posinf=0.0, neginf=0.0)
        all_preds = []
        with torch.no_grad():
            for ts in range(0, len(Xt_test), BATCH_SIZE):
                xb = torch.tensor(Xt_test[ts:ts + BATCH_SIZE])
                all_preds.append(model_ftt(xb).numpy())  # (B,) scalar
        preds = np.concatenate(all_preds)
        ic = _oos_ic(preds, y_test)

        stopped_epoch = last_epoch  # P0-7: use outer-scope tracker (epoch is local to _run_ftt_training)
        # 2026-04-19: valid_cols_mask 從 FT-T training 流程移除（P1 M1 fix 歷史殘留）
        # bundle dict 與 tuple 原本仍引用此變數 → NameError。改為 None，
        # consumer (line 585 / 1759) 用 bundle.get() 已為 None-safe。
        bundle = {
            "state_dict": model_ftt.state_dict(),
            "scaler": feat_scaler,
            "n_features": n_features,
            "model_type": "regression",  # 2.0 flag
        }
        trained_models["FT-Transformer"] = (model_ftt, feat_scaler, None, bundle)
        results["FT-Transformer"] = {
            "oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test),
            "stopped_epoch": stopped_epoch, "best_val_ic": round(best_val_ic, 6),
            "device": str(device), "saved": True,
        }
        print(f"[TrainUniversal] FT-Transformer IC={ic:.4f} stopped={stopped_epoch} device={device}")
    except _SkipModel:
        results["FT-Transformer"] = {"skipped": True}
    except Exception as e:
        results["FT-Transformer"] = {"error": str(e)}

    # ── 4. Prep data 保留（SHAP audit 需要）──────────────────────────────────
    # 2026-04-10: 不再自動清 prep/，讓 SHAP audit 跑完後再清
    # 或下次 retrain 的 prep 會自動覆蓋
    print(f"[TrainUniversal] Prep data preserved for SHAP audit")

    elapsed = round(time.time() - t0, 1)
    print(f"[TrainUniversal] Done in {elapsed}s — {len(results)} models")

    # ── 5. IC tracking + 熔斷 (2.0) ────────────────────────────────────────────
    # IC already computed inline during training (results[name]["oos_ic"])
    ic_tracking = {}
    circuit_breaker_triggered = False

    for model_name, model_result in results.items():
        if model_result.get("error"):
            continue
        if model_result.get("skipped"):
            # models_filter excluded this model — don't write to ic_tracking (orchestrator merges)
            continue
        oos_ic = model_result.get("oos_ic", 0.0)
        ic_tracking[model_name] = {
            "oos_ic": oos_ic,
            "oos_samples": len(X_test),
            "passed": oos_ic > 0,
        }
        if oos_ic <= 0:
            circuit_breaker_triggered = True
            print(f"[IC-熔斷] ⚠️ {model_name} OOS IC={oos_ic:.4f} ≤ 0 → 熔斷！沿用舊 model")
        elif oos_ic < 0.02:
            print(f"[IC-Warning] ⚠️ {model_name} OOS IC={oos_ic:.4f} < 0.02 → 通過但接近雜訊，留意 drift")

    # Save IC tracking to GCS
    # When models_filter is set (partial train), skip GCS write — orchestrator merges and writes
    if req.models_filter is not None:
        print(f"[IC-Track] models_filter={req.models_filter} → skip GCS write (orchestrator will merge)")
    else:
        try:
            from datetime import datetime
            ic_record = {
                "computed_at": datetime.utcnow().isoformat() + "Z",
                "models": ic_tracking,
                "circuit_breaker": circuit_breaker_triggered,
                "train_samples": len(X_train),
                "test_samples": len(X_test),
            }
            if walk_forward_mode:
                ic_record.update({
                    "window_id": req.window_id,
                    "train_range": [req.train_start, req.train_end],
                    "test_range":  [req.test_start, req.test_end],
                })
            ic_json = json.dumps(ic_record, indent=2)
            # 2026-04-18 #32: walk-forward writes to windowed path, not universal/
            ic_base_prefix = (req.gcs_prefix.rstrip("/") if req.gcs_prefix else "universal")
            bucket.blob(f"{ic_base_prefix}/ic_tracking.json").upload_from_string(
                ic_json, content_type="application/json"
            )
            # History (only for universal, walk-forward windows are themselves the history)
            if not walk_forward_mode:
                month = datetime.utcnow().strftime("%Y-%m")
                bucket.blob(f"{ic_base_prefix}/ic_history/{month}.json").upload_from_string(
                    ic_json, content_type="application/json"
                )
            print(f"[IC-Track] Saved {ic_base_prefix}/ic_tracking.json (breaker={'ON' if circuit_breaker_triggered else 'OFF'})")
        except Exception as e:
            print(f"[IC-Track] GCS save failed: {e}")

    # ── 6. Save ALL models to GCS (IC-weighted ensemble handles quality at predict time) ──
    if circuit_breaker_triggered:
        print(f"[IC-熔斷] ⚠️ 至少一個 model OOS IC ≤ 0 — ensemble 會自動零權重排除，但 model 仍存 GCS")

    # 2026-04-17 P1: compute per-feature training median for predict_stock_v2 fallback
    # when a feature is missing at predict time (previously filled with 0 → biased).
    try:
        medians_arr = np.nanmedian(X_train, axis=0)
        feature_medians = {
            feature_names[i]: float(medians_arr[i]) if not np.isnan(medians_arr[i]) else 0.0
            for i in range(len(feature_names))
        }
    except Exception as _med_err:
        print(f"[TrainUniversal] feature_medians compute failed: {_med_err}")
        feature_medians = {}

    # 2026-04-18 #32: walk-forward passes gcs_prefix + window_id metadata
    extra_meta = {}
    if walk_forward_mode:
        extra_meta = {
            "window_id": req.window_id,
            "train_range": [req.train_start, req.train_end],
            "test_range":  [req.test_start, req.test_end],
        }

    for model_name, model_obj in trained_models.items():
        try:
            if model_name == "FT-Transformer":
                _, _, _, ftt_bundle = model_obj
                save_model(0, "FT-Transformer", ftt_bundle, feature_names, len(X_train),
                           feature_medians=feature_medians,
                           gcs_prefix=req.gcs_prefix,
                           extra_metadata=extra_meta or None,
                           skip_weekly_backup=req.skip_weekly_backup)
            else:
                save_model(0, model_name, model_obj, feature_names, len(X_train),
                           feature_medians=feature_medians,
                           gcs_prefix=req.gcs_prefix,
                           extra_metadata=extra_meta or None,
                           skip_weekly_backup=req.skip_weekly_backup)
            print(f"[TrainUniversal] Saved {model_name} to GCS ✅ (prefix={req.gcs_prefix or 'universal'})")
        except Exception as e:
            print(f"[TrainUniversal] Failed to save {model_name}: {e}")

    elapsed = round(time.time() - t0, 1)
    print(f"[TrainUniversal] Done in {elapsed}s — {len(results)} models")

    return {
        "type": "universal",
        "total_samples": len(X),
        "train_samples": len(X_train),
        "test_samples": len(X_test),
        "feature_count": len(feature_names),
        "embargo_days": 10,
        "elapsed_s": elapsed,
        "results": results,
        "ic_tracking": ic_tracking,
        "circuit_breaker": circuit_breaker_triggered,
    }


@app.post("/retrain/universal/prep")
async def prep_universal_endpoint(req: UniversalPrepRequest, request: Request):
    await verify_service_token(request)
    return prep_universal_batch(req)


@app.post("/retrain/universal/train")
async def train_universal_endpoint(req: UniversalTrainRequest, request: Request):
    await verify_service_token(request)
    return train_universal_from_gcs(req)


# ── SHAP Feature Importance Audit ────────────────────────────────────────────
# 2026-04-10: 用 SHAP 跨 5 個 model 評估 106 features 的重要性
# TreeExplainer for tree models (GPU accelerated), GradientExplainer for FT-T

def run_shap_audit(shap_samples: int = 5000) -> dict:
    """從 GCS 讀 5 個 universal models + test data → 跑 SHAP → 回傳 feature importance 排名。"""
    import time, io, json, joblib
    t0 = time.time()

    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")

    # ── 1. Load test data from prep npz ──────────────────────────────────────
    prep_blobs = sorted(
        [b for b in bucket.list_blobs(prefix="universal/prep/") if b.name.endswith(".npz")],
        key=lambda b: b.name,
    )
    if not prep_blobs:
        return {"error": "No prep data in GCS. Run retrain first."}

    all_X, all_y, all_dates = [], [], []
    for blob in prep_blobs:
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    dates = np.concatenate(all_dates)

    # Feature names
    fn_blob = bucket.blob("universal/prep/feature_names.json")
    import json as _json
    feature_names = _json.loads(fn_blob.download_as_text())
    n_features = len(feature_names)
    print(f"[SHAP] Loaded {len(X)} samples, {n_features} features")

    # Time-based split (same as training: 80/20)
    sorted_dates = np.sort(np.unique(dates))
    cutoff_idx = int(len(sorted_dates) * 0.8)
    cutoff_date = sorted_dates[cutoff_idx]
    test_mask = dates > cutoff_date
    X_test = X[test_mask]
    y_test = y[test_mask]
    print(f"[SHAP] Test set: {len(X_test)} samples (cutoff={cutoff_date})")

    # Subsample for SHAP (speed)
    if len(X_test) > shap_samples:
        rng = np.random.RandomState(42)
        idx = rng.choice(len(X_test), shap_samples, replace=False)
        idx.sort()
        X_shap = X_test[idx]
    else:
        X_shap = X_test
    print(f"[SHAP] Using {len(X_shap)} samples for SHAP computation")

    import shap

    model_importance = {}  # model_name → np.array of shape (n_features,)

    # ── 2. Tree models: TreeExplainer ────────────────────────────────────────
    tree_models = ["xgboost", "catboost", "extratrees", "lightgbm"]
    for name in tree_models:
        try:
            blob = bucket.blob(f"universal/{name}.joblib")
            buf = io.BytesIO()
            blob.download_to_file(buf)
            buf.seek(0)
            model = joblib.load(buf)

            # Name-based feature alignment: model may be trained on filtered pool features
            # (predict_stock_v2 同樣邏輯 — 讀 metadata_{name}.json 的 feature_names)
            name_to_idx = {n: i for i, n in enumerate(feature_names)}
            model_keep_idx = list(range(n_features))  # default: all features
            try:
                meta_blob = bucket.blob(f"universal/metadata_{name}.json")
                if meta_blob.exists():
                    model_meta = _json.loads(meta_blob.download_as_text())
                    model_fnames = model_meta.get("feature_names", [])
                    if model_fnames and model_fnames != feature_names:
                        model_keep_idx = [name_to_idx[n] for n in model_fnames if n in name_to_idx]
                        print(f"[SHAP] {name} feature align: {len(model_keep_idx)}/{n_features} features")
            except Exception as me:
                print(f"[SHAP] {name} meta load failed (using all features): {me}")

            X_shap_model = X_shap[:, model_keep_idx] if len(model_keep_idx) < n_features else X_shap

            print(f"[SHAP] Computing TreeExplainer for {name} ({X_shap_model.shape[1]} features)...")
            t1 = time.time()
            explainer = shap.TreeExplainer(model)
            shap_values = explainer.shap_values(X_shap_model)
            # regression models: ndarray (n_samples, n_model_features)
            if isinstance(shap_values, list):
                sv = np.abs(shap_values[0])  # regression: single output at index 0
            elif isinstance(shap_values, np.ndarray) and shap_values.ndim == 3:
                sv = np.abs(shap_values[:, :, 0])
            else:
                sv = np.abs(shap_values)
            print(f"[SHAP] {name} sv.shape={sv.shape}")
            local_importance = sv.mean(axis=0)  # (n_model_features,)
            if local_importance.ndim > 1:
                local_importance = local_importance.ravel()
            local_importance = local_importance.astype(np.float64)

            # Map back to global feature space (zero-fill missing features)
            full_importance = np.zeros(n_features, dtype=np.float64)
            for local_i, global_i in enumerate(model_keep_idx):
                if local_i < len(local_importance):
                    full_importance[global_i] = local_importance[local_i]
            total = full_importance.sum()
            if total > 0:
                full_importance = full_importance / total
            model_importance[name] = full_importance
            top_idx = int(full_importance.argmax())
            print(f"[SHAP] {name} done in {time.time()-t1:.1f}s, top feature: {feature_names[top_idx]} ({full_importance[top_idx]:.4f})")
        except Exception as e:
            print(f"[SHAP] {name} failed: {e}")
            model_importance[name] = np.zeros(n_features)

    # ── 3. FT-Transformer: GradientExplainer ─────────────────────────────────
    try:
        import torch
        import torch.nn as nn
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        blob = bucket.blob("universal/ft-transformer.joblib")
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        bundle = joblib.load(buf)

        # 2.0: regression head (1 output) — must match train_universal_from_gcs _FTT
        ftt_n_features = bundle.get("n_features", n_features)

        class _FTT(nn.Module):
            def __init__(self, n_feat, d_model=128, n_heads=8, n_layers=3):
                super().__init__()
                self.feat_embed = nn.Linear(1, d_model, bias=True)
                self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
                encoder_layer = nn.TransformerEncoderLayer(
                    d_model=d_model, nhead=n_heads,
                    dim_feedforward=int(d_model * 4 / 3),
                    dropout=0.1, batch_first=True,
                )
                self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
                self.head = nn.Linear(d_model, 1)  # 2.0: regression output (single scalar)
            def forward(self, x):
                B = x.shape[0]
                tokens = self.feat_embed(x.unsqueeze(-1))
                cls = self.cls_token.expand(B, -1, -1)
                tokens = torch.cat([cls, tokens], dim=1)
                out = self.encoder(tokens)
                return self.head(out[:, 0, :]).squeeze(-1)  # (B,) scalar

        model_ftt = _FTT(ftt_n_features, d_model=128, n_heads=8, n_layers=3)
        model_ftt.load_state_dict(bundle["state_dict"])
        model_ftt.to(device).eval()
        ftt_scaler = bundle.get("scaler")
        ftt_valid_cols = bundle.get("valid_cols_mask")

        # Feature alignment: FT-T uses all features (skip_feature_pool=True), but guard mismatch
        X_shap_ftt = X_shap
        ftt_keep_idx = list(range(n_features))
        if ftt_n_features != n_features:
            try:
                ftt_meta_blob = bucket.blob("universal/metadata_ft-transformer.json")
                if ftt_meta_blob.exists():
                    ftt_meta = _json.loads(ftt_meta_blob.download_as_text())
                    ftt_fnames = ftt_meta.get("feature_names", [])
                    name_to_idx_ftt = {n: i for i, n in enumerate(feature_names)}
                    ftt_keep_idx = [name_to_idx_ftt[n] for n in ftt_fnames if n in name_to_idx_ftt]
                    X_shap_ftt = X_shap[:, ftt_keep_idx]
                    print(f"[SHAP] FT-T feature align: {len(ftt_keep_idx)} features (model={ftt_n_features}, prep={n_features})")
            except Exception as fe:
                print(f"[SHAP] FT-T meta load failed: {fe}")
                X_shap_ftt = X_shap[:, :ftt_n_features]
                ftt_keep_idx = list(range(ftt_n_features))

        if ftt_scaler and ftt_valid_cols is not None:
            X_shap_scaled = X_shap_ftt.copy().astype(np.float32)
            # valid_cols_mask was removed from training (P1 M1 fix); this path
            # is legacy for old GCS bundles. Use scaler.transform on all columns
            # for consistency. If bundle still has valid_cols_mask, apply as boolean.
            if hasattr(ftt_valid_cols, 'dtype') and ftt_valid_cols.dtype == bool:
                vc = ftt_valid_cols if ftt_valid_cols.shape[0] == X_shap_ftt.shape[1] else ftt_valid_cols[:X_shap_ftt.shape[1]]
                X_shap_scaled[:, vc] = ftt_scaler.transform(X_shap_ftt)[:, vc].astype(np.float32)
            else:
                X_shap_scaled = ftt_scaler.transform(X_shap_ftt).astype(np.float32)
                X_shap_scaled = np.nan_to_num(X_shap_scaled, nan=0.0, posinf=0.0, neginf=0.0)
        elif ftt_scaler:
            X_shap_scaled = ftt_scaler.transform(X_shap_ftt).astype(np.float32)
            X_shap_scaled = np.nan_to_num(X_shap_scaled, nan=0.0, posinf=0.0, neginf=0.0)
        else:
            X_shap_scaled = X_shap_ftt.astype(np.float32)

        # Background for GradientExplainer (small subset)
        bg_size = min(500, len(X_shap_scaled))
        bg = torch.tensor(X_shap_scaled[:bg_size], device=device)
        data_tensor = torch.tensor(X_shap_scaled, device=device)

        print(f"[SHAP] Computing GradientExplainer for FT-Transformer on {device} ({ftt_n_features} features)...")
        t1 = time.time()
        explainer = shap.GradientExplainer(model_ftt, bg)
        shap_values = explainer.shap_values(data_tensor)
        # 2.0 regression: shap_values is ndarray (n_samples, n_ftt_features), or list of 1 array
        if isinstance(shap_values, list):
            sv = np.abs(shap_values[0])  # regression: single output at index 0
        elif isinstance(shap_values, np.ndarray) and shap_values.ndim == 3:
            sv = np.abs(shap_values[:, :, 0])
        else:
            sv = np.abs(shap_values)  # (n_samples, n_ftt_features)
        print(f"[SHAP] ft-transformer sv.shape={sv.shape}")
        local_importance = sv.mean(axis=0)
        if local_importance.ndim > 1:
            local_importance = local_importance.ravel()
        local_importance = local_importance.astype(np.float64)

        # Map back to global feature space
        full_importance = np.zeros(n_features, dtype=np.float64)
        for local_i, global_i in enumerate(ftt_keep_idx):
            if local_i < len(local_importance):
                full_importance[global_i] = local_importance[local_i]
        total = full_importance.sum()
        if total > 0:
            full_importance = full_importance / total
        model_importance["ft-transformer"] = full_importance
        top_idx = int(full_importance.argmax())
        print(f"[SHAP] FT-Transformer done in {time.time()-t1:.1f}s, top feature: {feature_names[top_idx]} ({full_importance[top_idx]:.4f})")
    except Exception as e:
        print(f"[SHAP] FT-Transformer failed: {e}")
        model_importance["ft-transformer"] = np.zeros(n_features)

    # ── 4. Average across models → rank → flag <1% ───────────────────────────
    valid_models = [v.ravel() for v in model_importance.values() if v.sum() > 0]
    if not valid_models:
        return {"error": "All models failed SHAP computation"}

    avg_importance = np.mean(np.stack(valid_models), axis=0)
    # Re-normalize
    total = avg_importance.sum()
    if total > 0:
        avg_importance = avg_importance / total

    ranked = sorted(
        [(feature_names[i], float(avg_importance[i]), {k: float(model_importance[k][i]) for k in model_importance})
         for i in range(n_features)],
        key=lambda x: x[1], reverse=True,
    )

    features_result = []
    for rank, (fname, avg_imp, per_model) in enumerate(ranked, 1):
        below_1pct_all = all(v < 0.01 for v in per_model.values() if v > 0)  # all models agree <1%
        features_result.append({
            "rank": rank,
            "feature": fname,
            "avg_importance": round(avg_imp, 6),
            "per_model": {k: round(v, 6) for k, v in per_model.items()},
            "below_1pct_all_models": below_1pct_all,
        })

    n_below = sum(1 for f in features_result if f["below_1pct_all_models"])
    elapsed = round(time.time() - t0, 1)

    result = {
        "total_features": n_features,
        "shap_samples": len(X_shap),
        "models_computed": list(model_importance.keys()),
        "models_success": [k for k, v in model_importance.items() if v.sum() > 0],
        "below_1pct_count": n_below,
        "keep_count": n_features - n_below,
        "elapsed_s": elapsed,
        "features": features_result,
    }

    # Save to GCS
    try:
        result_json = _json.dumps(result, ensure_ascii=False, indent=2)
        bucket.blob("universal/shap_audit.json").upload_from_string(result_json, content_type="application/json")
        print(f"[SHAP] Saved to GCS universal/shap_audit.json")
    except Exception as e:
        print(f"[SHAP] Failed to save to GCS: {e}")

    print(f"\n[SHAP] === RESULTS ({elapsed}s) ===")
    print(f"[SHAP] Models: {result['models_success']}")
    print(f"[SHAP] Features: {n_features} total, {n_below} below 1% (all models agree), {n_features - n_below} keep")
    print(f"\n[SHAP] Top 20:")
    for f in features_result[:20]:
        print(f"  #{f['rank']:3d} {f['feature']:30s} avg={f['avg_importance']:.4f}")
    print(f"\n[SHAP] Bottom 20 (candidates to cut):")
    for f in features_result[-20:]:
        flag = " *** CUT" if f["below_1pct_all_models"] else ""
        print(f"  #{f['rank']:3d} {f['feature']:30s} avg={f['avg_importance']:.4f}{flag}")

    return result


@app.post("/audit/shap")
async def shap_audit_endpoint(request: Request):
    await verify_service_token(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    shap_samples = body.get("shap_samples", 5000)
    return run_shap_audit(shap_samples=shap_samples)


def _deprecated_run_permutation_importance(n_repeats: int = 5, max_samples: int = 50000) -> dict:
    """DEPRECATED — replaced by V2 Grouped Powershap (feature_selection.py).

    Original Permutation Importance: shuffle each feature, measure accuracy drop on OOS test set.
    - accuracy_drop > 0 → feature helps prediction (Active)
    - accuracy_drop ≈ 0 → feature is noise (Reserve)
    - accuracy_drop < 0 → feature hurts prediction (Cut)

    Runs on already-trained models from GCS. No retrain needed.
    """
    import time, io, json as _json, joblib
    from sklearn.metrics import accuracy_score
    t0 = time.time()

    from google.cloud import storage
    bucket = storage.Client().bucket("stockvision-models")

    # ── 1. Load test data ────────────────────────────────────────────────────
    prep_blobs = sorted(
        [b for b in bucket.list_blobs(prefix="universal/prep/") if b.name.endswith(".npz")],
        key=lambda b: b.name,
    )
    if not prep_blobs:
        return {"error": "No prep data in GCS. Run retrain first."}

    all_X, all_y, all_dates = [], [], []
    for blob in prep_blobs:
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    dates = np.concatenate(all_dates)

    fn_blob = bucket.blob("universal/prep/feature_names.json")
    feature_names = _json.loads(fn_blob.download_as_text())
    n_features = len(feature_names)

    # Time-based split (same as training)
    sorted_dates = np.sort(np.unique(dates))
    cutoff_idx = int(len(sorted_dates) * 0.8)
    cutoff_date = sorted_dates[cutoff_idx]
    test_mask = dates > cutoff_date
    X_test = X[test_mask]
    y_test = y[test_mask]

    # Subsample if too large (permutation is O(n_features × n_repeats × n_samples))
    if len(X_test) > max_samples:
        rng = np.random.RandomState(42)
        idx = rng.choice(len(X_test), max_samples, replace=False)
        idx.sort()
        X_test = X_test[idx]
        y_test = y_test[idx]

    print(f"[PermImp] {len(X_test)} test samples, {n_features} features, {n_repeats} repeats")

    # ── 2. Load models ───────────────────────────────────────────────────────
    model_names = ["xgboost", "catboost", "extratrees", "lightgbm"]
    models = {}
    for name in model_names:
        try:
            blob = bucket.blob(f"universal/{name}.joblib")
            buf = io.BytesIO()
            blob.download_to_file(buf)
            buf.seek(0)
            models[name] = joblib.load(buf)
        except Exception as e:
            print(f"[PermImp] {name} load failed: {e}")

    if not models:
        return {"error": "No models loaded"}

    # ── 3. Compute permutation importance per model ──────────────────────────
    rng = np.random.RandomState(42)
    model_results = {}  # model_name → {feature_name: accuracy_drop}

    for model_name, model in models.items():
        try:
            # Replace inf/nan for prediction safety
            X_clean = np.nan_to_num(X_test, nan=0.0, posinf=0.0, neginf=0.0)
            base_pred = model.predict(X_clean)
            base_acc = accuracy_score(y_test, base_pred)
            print(f"[PermImp] {model_name} baseline acc={base_acc:.4f}")

            drops_mean = np.zeros(n_features)
            drops_std = np.zeros(n_features)
            for fi in range(n_features):
                fi_drops = []
                for _ in range(n_repeats):
                    X_perm = X_clean.copy()
                    X_perm[:, fi] = rng.permutation(X_perm[:, fi])
                    perm_pred = model.predict(X_perm)
                    perm_acc = accuracy_score(y_test, perm_pred)
                    fi_drops.append(base_acc - perm_acc)
                drops_mean[fi] = np.mean(fi_drops)
                drops_std[fi] = np.std(fi_drops)

            model_results[model_name] = {
                "baseline_acc": base_acc,
                "drops": drops_mean,
                "drops_std": drops_std,
            }
            top_fi = feature_names[np.argmax(drops_mean)]
            print(f"[PermImp] {model_name} done, top feature: {top_fi} (drop={drops_mean.max():.4f})")
        except Exception as e:
            print(f"[PermImp] {model_name} failed: {e}")

    if not model_results:
        return {"error": "All models failed permutation importance"}

    # ── 4. Average across models → classify by sklearn convention ─────────────
    # sklearn: keep if mean - 2*std > 0 (95% CI lower bound > 0)
    all_drops = np.stack([r["drops"] for r in model_results.values()])
    all_stds = np.stack([r["drops_std"] for r in model_results.values()])
    avg_drops = np.mean(all_drops, axis=0)
    # Pooled std: combine across models via root-mean-square of per-model stds
    pooled_std = np.sqrt(np.mean(all_stds ** 2, axis=0))

    features_result = []
    for fi in range(n_features):
        per_model = {}
        for mname, mresult in model_results.items():
            per_model[mname] = round(float(mresult["drops"][fi]), 6)

        avg_drop = float(avg_drops[fi])
        std = float(pooled_std[fi])
        ci_lower = avg_drop - 2 * std  # 95% CI lower bound

        # sklearn convention: Active if CI lower bound > 0, Cut if CI upper bound < 0
        if ci_lower > 0:
            category = "active"
        elif avg_drop + 2 * std < 0:
            category = "cut"
        else:
            category = "reserve"

        features_result.append({
            "feature": feature_names[fi],
            "avg_accuracy_drop": round(avg_drop, 6),
            "std": round(std, 6),
            "ci_lower": round(ci_lower, 6),
            "category": category,
            "per_model": per_model,
        })

    # Sort by accuracy drop (most important first)
    features_result.sort(key=lambda x: x["avg_accuracy_drop"], reverse=True)
    for i, f in enumerate(features_result):
        f["rank"] = i + 1

    n_active = sum(1 for f in features_result if f["category"] == "active")
    n_reserve = sum(1 for f in features_result if f["category"] == "reserve")
    n_cut = sum(1 for f in features_result if f["category"] == "cut")
    elapsed = round(time.time() - t0, 1)

    result = {
        "total_features": n_features,
        "test_samples": len(X_test),
        "n_repeats": n_repeats,
        "models_used": list(model_results.keys()),
        "baseline_acc": {k: round(v["baseline_acc"], 4) for k, v in model_results.items()},
        "active_count": n_active,
        "reserve_count": n_reserve,
        "cut_count": n_cut,
        "elapsed_s": elapsed,
        "features": features_result,
    }

    # Save to GCS
    try:
        result_json = _json.dumps(result, ensure_ascii=False, indent=2)
        bucket.blob("universal/permutation_importance.json").upload_from_string(
            result_json, content_type="application/json"
        )
        print(f"[PermImp] Saved to GCS universal/permutation_importance.json")
    except Exception as e:
        print(f"[PermImp] Failed to save to GCS: {e}")

    print(f"\n[PermImp] === RESULTS ({elapsed}s) ===")
    print(f"[PermImp] Active: {n_active}, Reserve: {n_reserve}, Cut: {n_cut}")
    print(f"\n[PermImp] Top 20 (most impactful):")
    for f in features_result[:20]:
        print(f"  #{f['rank']:3d} {f['feature']:30s} drop={f['avg_accuracy_drop']:.4f} [{f['category']}]")
    print(f"\n[PermImp] Bottom 20 (candidates to cut):")
    for f in features_result[-20:]:
        print(f"  #{f['rank']:3d} {f['feature']:30s} drop={f['avg_accuracy_drop']:.4f} [{f['category']}]")

    return result


@app.post("/audit/feature-selection")
async def feature_selection_endpoint(request: Request):
    """V2 Feature Selection: Silhouette → Grouped Powershap → Feature Pool update."""
    await verify_service_token(request)
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    from .feature_selection import run_feature_selection_pipeline
    return run_feature_selection_pipeline(
        max_rounds=body.get("max_rounds", 100),
        alpha=body.get("alpha", 0.01),
        required_power=body.get("required_power", 0.99),
    )


# ── ARF Reward Update（驗證後由 Cron 呼叫）────────────────────────────────────

class ARFUpdateRequest(BaseModel):
    arf_features: list[float]     # /predict 回傳的 arf_features 原值
    actual_up: bool               # 5 日後實際方向（True=上漲, False=下跌）
    # LinUCB reward 同步更新
    model_name: Optional[str] = None   # 若提供，一併更新 LinUCB 對應 arm
    hmm_regime: Optional[str] = None
    garch_vol: Optional[float] = None
    current_price: float = 1.0
    market_risk_score: float = 0.5
    # #14 LinUCB reward enrichment
    actual_return: float = 0.0    # 實際 5 日漲跌幅（小數）
    forecast_pct: float = 0.0     # 模型預測漲跌幅（小數）
    # FT online update 需要 stock_id 定位模型
    stock_id: int = 0
    symbol: str = ""

# 台股單趟摩擦成本：買手續費 0.1425% + 賣手續費 0.1425% + 交易稅 0.3% = 0.585%
# Reward 只有在扣除摩擦成本後仍為正時才給 1，避免學出「帳面賺、實際賠」的微利策略
FRICTION_COST_PCT = 0.00585


def update_arf(req: ARFUpdateRequest) -> dict:
    """Core ARF/LinUCB update logic — no auth, callable by Modal or HTTP."""
    if len(req.arf_features) == 0:
        raise ValueError("arf_features 不可為空")

    features = np.array(req.arf_features, dtype=np.float64)
    results: dict = {}

    # ── Layer 2：ARF 線上更新 ──────────────────────────────────────────────────
    # 扣除摩擦成本：只有淨收益 > 0.585% 才算「真正上漲」
    net_profitable = req.actual_return > FRICTION_COST_PCT
    try:
        _arf = load_arf(ARF_STATE_DIR)
        _arf.update(features, net_profitable)
        save_arf(_arf, ARF_STATE_DIR)
        results["arf"] = {
            "updated": True,
            "n_trained": _arf.n_trained,
            "is_warmed_up": _arf.is_warmed_up(),
        }
    except Exception as e:
        results["arf"] = {"updated": False, "error": str(e)}

    # ── Layer 1：LinUCB Bandit 更新（若有提供 model_name）────────────────────
    if req.model_name:
        try:
            from .linucb_bandit import linucb_update, load_bandit, save_bandit, DONOTHING_ARM_IDX
            _bandit = load_bandit("/tmp/linucb_bandit")
            # Reward 扣摩擦成本：淨收益 > 0.585% 才有 reward
            # 漲幅越大 reward 越高（ratio-based），但微利不給分
            raw_reward = float(np.clip(
                req.actual_return / max(abs(req.forecast_pct), 0.005), 0.0, 1.0
            )) if net_profitable else 0.0
            linucb_update(
                hmm_regime=req.hmm_regime,
                garch_vol=req.garch_vol,
                current_price=req.current_price,
                market_risk_score=req.market_risk_score,
                model_name=req.model_name,
                reward=raw_reward,
                bandit=_bandit,
            )
            # DoNothing arm 同步更新：市場下跌 > 摩擦成本 → 不出手是對的 (reward=1)
            # 市場上漲 > 摩擦成本 → 不出手是錯的 (reward=0)
            from .linucb_bandit import build_context
            donothing_reward = 1.0 if req.actual_return < -FRICTION_COST_PCT else 0.0
            ctx = build_context(req.hmm_regime, req.garch_vol, req.current_price, req.market_risk_score)
            _bandit.update(DONOTHING_ARM_IDX, ctx, donothing_reward)

            save_bandit(_bandit, "/tmp/linucb_bandit")
            results["linucb"] = {
                "updated": True,
                "model_name": req.model_name,
                "donothing_reward": donothing_reward,
                "total_observations": _bandit.total_observations(),
                "is_warmed_up": _bandit.is_warmed_up(),
            }
        except Exception as e:
            results["linucb"] = {"updated": False, "error": str(e)}

    # P2#22: FT-Transformer Online Update — fine-tune last 2 layers with new data
    # FT bundle in model_store: {"state_dict": ..., "scaler": ..., "n_features": ...}
    # Need to reconstruct PyTorch model from state_dict before fine-tuning
    try:
        from .ft_online_update import online_update_ft_transformer
        from .model_store import load_model as _load_model, save_model as _save_model
        stock_id = req.stock_id
        ft_stored = _load_model(stock_id, "FT-Transformer")
        if ft_stored and ft_stored[0] is not None:
            bundle_data, ft_meta = ft_stored
            # bundle_data is {"state_dict": ..., "scaler": ..., "n_features": ...}
            if isinstance(bundle_data, dict) and "state_dict" in bundle_data:
                import torch
                import torch.nn as nn
                # Reconstruct FTTransformer (same arch as models.py)
                _D, _H, _L = 64, 4, 2
                n_feat = bundle_data.get("n_features", features.shape[-1] if features.ndim > 1 else features.shape[0])

                class _FT(nn.Module):
                    def __init__(self, nf, d, h, nl):
                        super().__init__()
                        self.feat_embed = nn.Linear(1, d, bias=True)
                        self.cls_token = nn.Parameter(torch.zeros(1, 1, d))
                        enc_layer = nn.TransformerEncoderLayer(d_model=d, nhead=h, dim_feedforward=d*4, dropout=0.1, batch_first=True)
                        self.encoder = nn.TransformerEncoder(enc_layer, num_layers=nl)
                        self.head = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, 2))
                    def forward(self, x):
                        x = x.unsqueeze(-1) if x.dim() == 2 else x
                        x = self.feat_embed(x)
                        cls = self.cls_token.expand(x.size(0), -1, -1)
                        x = torch.cat([cls, x], dim=1)
                        x = self.encoder(x)
                        return self.head(x[:, 0])
                ft_model = _FT(n_feat, _D, _H, _L)
                ft_model.load_state_dict(bundle_data["state_dict"])
                ft_model.eval()

                ft_bundle = {"model": ft_model, "scaler": bundle_data.get("scaler")}
                y_label = np.array([1 if req.actual_up else 0])
                X_new = features.reshape(1, -1) if features.ndim == 1 else features[:1]
                ft_result = online_update_ft_transformer(ft_bundle, X_new, y_label)

                # Save updated state_dict back
                if ft_result and ft_result.get("updated"):
                    bundle_data["state_dict"] = ft_model.state_dict()
                    _save_model(stock_id, "FT-Transformer", bundle_data,
                                ft_meta.get("feature_names", []), ft_meta.get("n_samples", 0))
                results["ft_online"] = ft_result or {"updated": False, "reason": "below MIN_NEW_SAMPLES"}
            else:
                results["ft_online"] = {"updated": False, "reason": "bundle format mismatch (no state_dict)"}
        else:
            results["ft_online"] = {"updated": False, "reason": "no FT model yet (will be created on Sunday retrain)"}
    except Exception as e:
        results["ft_online"] = {"error": str(e)}

    return {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "actual_up": req.actual_up,
        "actual_return": req.actual_return,
        "net_profitable": net_profitable,
        "friction_cost": FRICTION_COST_PCT,
        "results": results,
    }


@app.post("/arf/update")
async def arf_update_endpoint(req: ARFUpdateRequest, request: Request):
    """HTTP endpoint wrapper — adds auth then delegates to update_arf()."""
    await verify_service_token(request)
    return update_arf(req)


@app.get("/bandit/stats")
async def bandit_stats(request: Request):
    """診斷用：回傳 LinUCB + ARF 當前學習狀態"""
    await verify_service_token(request)
    out: dict = {}
    try:
        _bandit = load_bandit("/tmp/linucb_bandit")
        out["linucb"] = _bandit.stats_summary()
    except Exception as e:
        out["linucb"] = {"error": str(e)}
    try:
        _arf = load_arf(ARF_STATE_DIR)
        out["arf"] = _arf.stats_summary()
    except Exception as e:
        out["arf"] = {"error": str(e)}
    return out


# ── Regime Pipeline (Sprint 4-2 revisit, 2026-04-17 #30) ─────────────────────
# Fixes "HMM regime pipeline broken" — adds /regime/current endpoint so that
# ml-controller can pull the current HMM regime and push to Worker KV.
# See memory/project_regime_pipeline_broken.md for the full 9-item checklist.

# English labels for KV consumption (Worker marketScreener / paper.ts consume
# these via string .includes('bull'/'bear'/'sideways'/'volatile')).
_REGIME_INDEX_TO_EN = {
    0: "bull_market",   # 低波動牛市
    1: "volatile",      # 高波動牛市（bull but high vol）
    2: "sideways",      # 震盪整理
    3: "bear_market",   # 熊市危機
}


class RegimeRequest(BaseModel):
    market_env: dict | None = None  # same structure used by /predict /predict/v2
    force_retrain: bool = False     # if True, retrain HMM from history


@app.post("/regime/current")
async def regime_current(req: RegimeRequest, request: Request):
    """Returns the current HMM market regime.

    Response:
      {
        "regime_label_en":       "bull_market" | "volatile" | "sideways" | "bear_market",
        "regime_index":          0-3,
        "hmm_state":              HMM internal state index,
        "label_zh":              "低波動牛市" etc,
        "weight_multipliers":    {model_name: mult},
        "consensus_threshold":   float,
        "computed_at":           ISO8601 TWD,
      }
    """
    await verify_service_token(request)
    from datetime import datetime, timezone, timedelta
    from .regime import (
        RegimeDetector,
        build_market_feature_matrix,
        get_current_market_features,
    )

    TW_TZ = timezone(timedelta(hours=8))

    detector = None if req.force_retrain else RegimeDetector.load_from_gcs()
    if detector is None:
        feat_mat = build_market_feature_matrix(req.market_env)
        if feat_mat is None or len(feat_mat) < 20:
            raise HTTPException(
                status_code=400,
                detail="insufficient market_env.history to train HMM (need >=20 days)",
            )
        detector = RegimeDetector().fit(feat_mat)
        if detector._trained:
            detector.save_to_gcs()

    cur_feat = get_current_market_features(req.market_env)
    if cur_feat is None:
        raise HTTPException(status_code=400, detail="market_env missing current features")

    info = detector.predict_regime(cur_feat)
    reg_idx = int(info.get("regime_index", 1))
    label_en = _REGIME_INDEX_TO_EN.get(reg_idx, "sideways")

    return {
        "regime_label_en":     label_en,
        "regime_index":        reg_idx,
        "hmm_state":           info.get("hmm_state", -1),
        "label_zh":            info.get("label", "未知"),
        "weight_multipliers":  info.get("weight_multipliers", {}),
        "consensus_threshold": info.get("consensus_threshold", 0.60),
        "computed_at":         datetime.now(TW_TZ).isoformat(),
    }


# ── Walk-Forward endpoints (Sprint 6b / 2026-04-18 #32) ──────────────────────

class WalkForwardHMMTrainRequest(BaseModel):
    """Train HMM on historical window for walk-forward regime replay."""
    window_id: int
    train_end: str                       # HMM sees history up to & including this date
    market_env: dict                     # already-filtered history (caller ensures no future leak)
    gcs_prefix: str                      # e.g. "walk_forward/w3"


@app.post("/regime/train_window")
async def regime_train_window(req: WalkForwardHMMTrainRequest, request: Request):
    """Train HMM on a historical window's market data and save a snapshot.

    This enables `predict_regime_at_date()` to replay regime decisions without
    future leak — each window has its own HMM joblib under `walk_forward/w{id}/`.
    """
    await verify_service_token(request)
    from .regime import RegimeDetector, build_market_feature_matrix

    feat_mat = build_market_feature_matrix(req.market_env)
    if feat_mat is None or len(feat_mat) < 30:
        raise HTTPException(
            status_code=400,
            detail=f"insufficient market_env.history (got {len(feat_mat) if feat_mat is not None else 0} days, need ≥30)",
        )

    detector = RegimeDetector().fit(feat_mat)
    if not detector._trained:
        raise HTTPException(status_code=500, detail="HMM fit did not converge")

    saved = detector.save_to_gcs(
        gcs_prefix=req.gcs_prefix,
        extra_metadata={
            "window_id": req.window_id,
            "train_end": req.train_end,
            "history_days": len(feat_mat),
        },
    )
    return {
        "window_id": req.window_id,
        "gcs_prefix": req.gcs_prefix.rstrip("/"),
        "n_components": detector.n_components,
        "regime_map": {str(k): v for k, v in detector.regime_map.items()},
        "history_days": len(feat_mat),
        "saved": saved,
    }


class WalkForwardReplayRequest(BaseModel):
    """Replay HMM prediction for a historical date using per-window snapshot."""
    window_id: int                       # which window's HMM joblib to load
    market_env: dict                      # filtered history + 'current' date's features


@app.post("/regime/replay_at_date")
async def regime_replay_at_date(req: WalkForwardReplayRequest, request: Request):
    """Predict regime at a historical date using the windowed HMM snapshot.

    No future leak: loads HMM from `walk_forward/w{id}/` which was trained only
    on data up to window.train_end. Caller must pass market_env with features
    computed using data available at the replay date (not beyond).
    """
    await verify_service_token(request)
    from .regime import RegimeDetector, get_current_market_features

    gcs_prefix = f"walk_forward/w{req.window_id}"
    detector = RegimeDetector.load_from_gcs(
        gcs_prefix=gcs_prefix,
        skip_freshness_check=True,   # historical snapshots are never "fresh"
    )
    if detector is None:
        raise HTTPException(
            status_code=404,
            detail=f"No HMM snapshot at {gcs_prefix}. Run /regime/train_window first.",
        )

    cur_feat = get_current_market_features(req.market_env)
    if cur_feat is None:
        raise HTTPException(status_code=400, detail="market_env missing current features")

    info = detector.predict_regime(cur_feat)
    reg_idx = int(info.get("regime_index", 1))
    return {
        "window_id":       req.window_id,
        "regime_label_en": _REGIME_INDEX_TO_EN.get(reg_idx, "sideways"),
        "regime_index":    reg_idx,
        "hmm_state":       info.get("hmm_state", -1),
        "label_zh":        info.get("label", "未知"),
    }


class WalkForwardTrainRequest(BaseModel):
    """Retrain 5 ML models on a walk-forward window's train range."""
    window_id: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    models: list[str] | None = None      # None = all 5
    batch_count: int = 5                  # re-uses existing prep npz
    skip_feature_pool: bool = False


@app.post("/retrain/walk_forward")
async def retrain_walk_forward_endpoint(req: WalkForwardTrainRequest, request: Request):
    """Train all specified models on a walk-forward window.

    Writes per-window model artifacts to GCS `walk_forward/w{window_id}/`.
    Returns per-model IC + metadata for the window.

    This endpoint is a thin wrapper around `train_universal_from_gcs` with
    walk-forward params baked in. Heavy lifting happens in the Modal functions
    `train_tree_models` / `train_ftt_model` when called from ml-controller.
    """
    await verify_service_token(request)
    gcs_prefix = f"walk_forward/w{req.window_id}"

    # Delegate to existing train with walk-forward params
    inner_req = UniversalTrainRequest(
        batch_count=req.batch_count,
        models_filter=req.models,
        skip_feature_pool=req.skip_feature_pool,
        train_start=req.train_start,
        train_end=req.train_end,
        test_start=req.test_start,
        test_end=req.test_end,
        gcs_prefix=gcs_prefix,
        window_id=req.window_id,
        skip_weekly_backup=True,   # windowed paths are themselves versioned
    )
    result = train_universal_from_gcs(inner_req)
    result["window_id"] = req.window_id
    result["gcs_prefix"] = gcs_prefix
    return result