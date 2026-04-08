"""
main.py — FastAPI ML 服務（v14）

10 模型 Ensemble 架構（5v5 平衡）：
  純價格族（5）：KalmanFilter / DLinear / MarkovSwitching / PatchTST / Chronos
  特徵族  （5）：XGBoost / CatBoost / ExtraTrees / LightGBM / FT-Transformer
"""
import os
import numpy as np
import pandas as pd
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
    from .factor_monitor import compute_factor_ic

    df = build_feature_matrix(req.prices, req.indicators, req.chips,
                              req.sentiment_scores, req.market_env)
    X, y, feature_names = get_features(df)

    if len(X) < 60:
        return {"error": "需要至少 60 天資料", "features": []}

    # 把 X/y 組回 DataFrame 做 IC
    df_ic = pd.DataFrame(X, columns=feature_names)
    df_ic["target_5d"] = y  # target_dir 的值（0/1）

    ic_results = compute_factor_ic(df_ic, feature_names, target_col="target_5d")
    results = ic_results.to_dict(orient="records") if not ic_results.empty else []

    weak = [r["feature"] for r in results if not r.get("effective", True)]
    strong = [r["feature"] for r in results if r.get("effective", False)]

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
        df["taifex_night_change_pct"] = np.clip(ns.change_pct, -10, 10)
        df["taifex_night_range_pct"] = np.clip(ns.range_pct, 0, 15)
        df["taifex_night_available"] = 1.0
        print(f"[Predict] {req.symbol} night_session: {ns.change_pct:.2f}% (date={ns.date})")
    else:
        df["taifex_night_change_pct"] = 0.0
        df["taifex_night_range_pct"] = 0.0
        df["taifex_night_available"] = 0.0
        if ns and ns.date and ns.date != today_str:
            print(f"[Predict] {req.symbol} stale night_session ({ns.date} != {today_str}), zeroed")

    # ── 五檔報價特徵（盤中由 Worker 傳入，盤前/盤後填 0）──────────────────
    # 目前 /predict 是盤後批次呼叫，orderbook 不可用，全填 0
    # 未來盤中 re-predict 可傳入 orderbook features
    df["orderbook_imbalance"] = 0.0
    df["orderbook_spread_pct"] = 0.0
    df["orderbook_available"] = 0.0

    # #5 Price model input diversity：準備 adj_close 和 log(adj_close) 序列
    adj_prices_arr = np.array([float(p.get("adj_close", p["close"])) for p in req.prices])
    log_adj_prices_arr = np.log(np.maximum(adj_prices_arr, 1e-8))

    X, y, feature_names = get_features(df)
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
    X_cb, y_cb, cb_names = get_catboost_features(df)
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


def retrain_stock(req: PredictRequest) -> dict:
    """Core retrain logic — no auth, callable by Modal @function or HTTP endpoint."""
    if len(req.prices) < 60:
        raise ValueError("需要至少 60 天的股價數據")

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df          = build_feature_matrix(req.prices, req.indicators, chips_input,
                                        req.sentiment_scores, req.market_env)
    # retrain 時 optional features 填 0（歷史資料暫無，收集後再回填）
    df["taifex_night_change_pct"] = 0.0
    df["taifex_night_range_pct"] = 0.0
    df["taifex_night_available"] = 0.0
    df["orderbook_imbalance"] = 0.0
    df["orderbook_spread_pct"] = 0.0
    df["orderbook_available"] = 0.0

    prices_arr  = np.array([float(p["close"]) for p in req.prices])
    X, y, feature_names = get_features(df)

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
        ("XGBoost",    lambda: __import__("xgboost", fromlist=["XGBClassifier"]).XGBClassifier(
                           n_estimators=xgb_p.get("n_estimators", 150),
                           max_depth=xgb_p.get("max_depth", 4),
                           learning_rate=xgb_p.get("learning_rate", 0.05),
                           subsample=xgb_p.get("subsample", 0.9),
                           colsample_bytree=xgb_p.get("colsample_bytree", 0.9),
                           use_label_encoder=False, eval_metric="logloss",
                           random_state=42, verbosity=0)),
        ("CatBoost",   lambda: __import__("catboost", fromlist=["CatBoostClassifier"]).CatBoostClassifier(
                           iterations=cat_p.get("iterations", 200),
                           depth=cat_p.get("depth", 5),
                           learning_rate=cat_p.get("learning_rate", 0.05),
                           l2_leaf_reg=cat_p.get("l2_leaf_reg", 3.0),
                           loss_function="Logloss", random_seed=42, verbose=0)),
        ("ExtraTrees", lambda: __import__("sklearn.ensemble", fromlist=["ExtraTreesClassifier"]).ExtraTreesClassifier(
                           n_estimators=et_p.get("n_estimators", 200),
                           max_depth=et_p.get("max_depth", 6),
                           min_samples_split=et_p.get("min_samples_split", 5),
                           min_samples_leaf=et_p.get("min_samples_leaf", 3),
                           max_features="sqrt", class_weight="balanced", bootstrap=True,
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


@app.post("/predict/models")
def predict_all_models(req: PredictRequest):
    prices_arr  = np.array([float(p["close"]) for p in req.prices])
    adj_prices_arr = np.array([float(p.get("adj_close", p["close"])) for p in req.prices])
    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df          = build_feature_matrix(req.prices, req.indicators, chips_input,
                                        req.sentiment_scores, req.market_env)
    X, y, feature_names = get_features(df)
    X_latest = X[-1] if len(X) > 0 else np.zeros(max(len(feature_names), 1))
    X_cb, y_cb, cb_names = get_catboost_features(df)
    X_cb_latest = X_cb[-1] if len(X_cb) > 0 else np.zeros(max(len(cb_names), 1))
    X_lgbm = get_lgbm_features(X) if len(X) > 0 else X
    X_lgbm_latest = X_lgbm[-1] if len(X_lgbm) > 0 else X_latest
    stock_id = req.stock_id

    results = {}
    specs = [
        # 價格族 — 與 /predict 完全對齊（input diversity + stock_id）
        ("KalmanFilter",    lambda: run_kalman_filter(prices_arr, req.horizon, stock_id),           False),
        ("DLinear",         lambda: run_dlinear(adj_prices_arr, req.horizon),                        False),
        ("MarkovSwitching", lambda: run_markov_switching(adj_prices_arr, req.horizon, stock_id),     False),
        ("PatchTST",        lambda: run_patchtst(prices_arr, req.horizon, stock_id),                False),
        ("Chronos",         lambda: run_chronos(adj_prices_arr, req.horizon, stock_id),             False),
        # 特徵族 — input diversity: CatBoost 滯後特徵, LightGBM rank transform
        ("XGBoost",         lambda: run_xgboost(X, y, X_latest, prices_arr, req.horizon, stock_id, feature_names),              True),
        ("CatBoost",        lambda: run_catboost(X_cb, y_cb, X_cb_latest, prices_arr, req.horizon, stock_id, cb_names),         True),
        ("ExtraTrees",      lambda: run_extra_trees(X, y, X_latest, prices_arr, req.horizon, stock_id, feature_names),          True),
        ("LightGBM",        lambda: run_lightgbm(X_lgbm, y, X_lgbm_latest, prices_arr, req.horizon, stock_id, feature_names),  True),
        ("FT-Transformer",  lambda: run_ft_transformer(X, y, X_latest, prices_arr, req.horizon, stock_id, feature_names),       True),
    ]
    import time as _time
    model_timings = {}
    for name, fn, needs_feat in specs:
        if needs_feat and len(X) < 20:
            results[name] = {"error": "insufficient feature samples"}
            continue
        try:
            t0 = _time.monotonic()
            p = fn()
            elapsed_ms = round((_time.monotonic() - t0) * 1000)
            model_timings[name] = elapsed_ms
            results[name] = {
                "direction": p.direction, "confidence": p.confidence,
                "forecast_pct": p.forecast_pct, "direction_accuracy": p.direction_accuracy,
                "forecasts": p.forecasts,
            }
        except Exception as e:
            results[name] = {"error": str(e)}

    garch_vol = run_garch_volatility(prices_arr, horizon=5)
    return {"stock_id": req.stock_id, "symbol": req.symbol,
            "models": results, "garch_vol": round(garch_vol, 4) if garch_vol else None,
            "model_timings_ms": model_timings,
            "feature_count": len(X)}


# ── Phase 3: Factor IC 監控 endpoint ────────────────────────────────────────
@app.post("/factor-ic")
async def factor_ic(req: PredictRequest, request: Request):
    """
    計算所有特徵的 Rank IC，回傳 IC 表 + 有效特徵列表。
    供 weekly retrain 時呼叫，結果可存入 D1 或 GCS。
    """
    await verify_service_token(request)
    from .factor_monitor import compute_factor_ic, filter_effective_features, compute_feature_weights_from_ic
    from .features import FEATURE_COLS

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(req.prices, req.indicators, chips_input,
                               req.sentiment_scores, req.market_env)

    ic_df = compute_factor_ic(df, FEATURE_COLS, target_col="target_5d")
    effective = filter_effective_features(ic_df, FEATURE_COLS)
    weights = compute_feature_weights_from_ic(ic_df, FEATURE_COLS)

    return {
        "stock_id": req.stock_id,
        "symbol": req.symbol,
        "ic_table": ic_df.to_dict(orient="records") if not ic_df.empty else [],
        "effective_features": effective,
        "feature_weights": weights,
        "total_features": len(FEATURE_COLS),
        "effective_count": len(effective),
        "dropped_count": len(FEATURE_COLS) - len(effective),
    }


# ── Feature Drift Detection endpoint ──────────────────────────────────────────
@app.post("/feature-drift")
async def feature_drift(req: PredictRequest, request: Request):
    """
    偵測特徵分佈漂移：比較訓練期（前 80%）vs 近期（後 20%）的 quantile shift。
    Drifted features 應降低權重或觸發 retrain。
    """
    await verify_service_token(request)
    from .factor_monitor import detect_feature_drift
    from .features import FEATURE_COLS

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(req.prices, req.indicators, chips_input,
                               req.sentiment_scores, req.market_env)

    if len(df) < 30:
        return {"error": "insufficient data for drift detection", "sample_count": len(df)}

    split_idx = int(len(df) * 0.8)
    df_train = df.iloc[:split_idx]
    df_recent = df.iloc[split_idx:]

    drift_results = detect_feature_drift(df_train, df_recent, FEATURE_COLS)
    drifted_count = sum(1 for r in drift_results if r["drifted"])

    return {
        "stock_id": req.stock_id,
        "symbol": req.symbol,
        "drift_results": drift_results,
        "drifted_count": drifted_count,
        "total_features": len(drift_results),
        "needs_retrain": drifted_count > len(drift_results) * 0.3,
    }


# ── Phase 4: MAE/MFE 分群 endpoint ──────────────────────────────────────────
class TradeClusterRequest(BaseModel):
    trades: list[dict]
    feature_cols: list[str] = []

@app.post("/trade-cluster")
async def trade_cluster(req: TradeClusterRequest, request: Request):
    """
    對歷史交易做 MAE/MFE KMeans 分群 + DecisionTree 規則學習。
    供 weekly retrain 或 screener 呼叫。
    """
    await verify_service_token(request)
    from .trade_clustering import cluster_trades, learn_trade_quality_rules
    from .features import FEATURE_COLS

    cluster_result = cluster_trades(req.trades, n_clusters=3)
    if "error" in cluster_result:
        return cluster_result

    feat_cols = req.feature_cols if req.feature_cols else FEATURE_COLS
    tree_result = learn_trade_quality_rules(req.trades, feat_cols, cluster_result)

    return {
        "clusters": cluster_result["cluster_stats"],
        "good_cluster_id": cluster_result["good_cluster_id"],
        "bad_cluster_id": cluster_result["bad_cluster_id"],
        "quality_rules": tree_result.get("rules", []),
        "feature_importance": tree_result.get("feature_importance", {}),
        "tree_accuracy": tree_result.get("tree_accuracy"),
    }


# ── Feature Audit endpoint（Weekly pipeline）──────────────────────────────────
@app.post("/feature-audit")
async def feature_audit_endpoint(req: PredictRequest, request: Request):
    """
    特徵重要性審計 + LinUCB arm weight 週報。
    結果由 Worker 存入 D1 feature_importance / model_weights_weekly。
    """
    await verify_service_token(request)
    from .feature_audit import run_feature_audit
    from .features import FEATURE_COLS

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(req.prices, req.indicators, chips_input,
                               req.sentiment_scores, req.market_env)
    X, y, feature_names = get_features(df)

    if len(X) < 50:
        return {"error": "insufficient data for audit", "sample_count": len(X)}

    return run_feature_audit(X, y, feature_names)
