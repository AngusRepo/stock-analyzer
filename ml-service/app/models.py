"""
Model adapters for StockVision inference.

Alpha predictors:
  - DLinear / PatchTST
  - XGBoost / ExtraTrees / LightGBM

State-space overlays:
  - KalmanFilter / MarkovSwitching
"""
import numpy as np
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Literal
import warnings
warnings.filterwarnings("ignore")

@dataclass
class ModelPrediction:
    model_name: str
    direction: Literal["up", "down"]       # ??????
    confidence: float                       # ?????? 0~1
    forecast_pct: float                     # ????????
    forecasts: list[dict] = field(default_factory=list)  # 14????????
    direction_accuracy: float = 0.0        # ????????????walk-forward??
    rmse: float = 0.0
    shap_top5: list[dict] = field(default_factory=list)  # P3#31: top 5 SHAP feature attributions


# ?????? SHAP ?????3#31???????????????????????????????????????????????????????????????????????????????????????????????????????????????????
def _compute_shap_top5(model, X_sample: np.ndarray, feature_names: list[str]) -> list[dict]:
    """Compute top 5 SHAP feature attributions for the latest prediction."""
    try:
        import shap
        explainer = shap.TreeExplainer(model)
        sv = explainer.shap_values(X_sample.reshape(1, -1))
        # sv shape: (1, n_features) for binary or list of 2 arrays
        values = sv[1][0] if isinstance(sv, list) else sv[0]
        # Top 5 by absolute value
        indices = np.argsort(np.abs(values))[-5:][::-1]
        return [
            {"feature": feature_names[i] if i < len(feature_names) else f"f{i}",
             "value": round(float(values[i]), 4)}
            for i in indices
        ]
    except Exception:
        return []


# ?????? ?????? ??????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????
def _direction_accuracy(actual: np.ndarray, predicted: np.ndarray) -> float:
    n = min(len(actual), len(predicted)) - 1
    if n <= 0:
        return 0.5
    correct = sum(
        1 for i in range(n)
        if (actual[i+1] > actual[i]) == (predicted[i+1] > predicted[i])
    )
    return correct / n


def _add_trading_days(last_date: datetime, n: int) -> list[str]:
    dates, d = [], last_date
    while len(dates) < n:
        d += timedelta(days=1)
        if d.weekday() < 5:
            dates.append(d.strftime("%Y-%m-%d"))
    return dates


def _make_forecast_points(prices_forecast: list[float], std: float, dates: list[str]) -> list[dict]:
    return [
        {
            "date": dates[i],
            "forecast": round(float(p), 2),
            "lower80": round(float(p - 1.28 * std * np.sqrt(i + 1)), 2),
            "upper80": round(float(p + 1.28 * std * np.sqrt(i + 1)), 2),
            "lower95": round(float(p - 1.96 * std * np.sqrt(i + 1)), 2),
            "upper95": round(float(p + 1.96 * std * np.sqrt(i + 1)), 2),
        }
        for i, p in enumerate(prices_forecast)
    ]


def _fallback_model(name: str, prices: np.ndarray, horizon: int, reason: str) -> ModelPrediction:
    """Fallback model used when a model cannot produce a valid forecast."""
    last = float(prices[-1]) if len(prices) > 0 else 100.0
    std  = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else last * 0.015
    last_date = datetime.now()
    dates     = _add_trading_days(last_date, horizon)
    forecasts = _make_forecast_points([last] * horizon, std, dates)
    print(f"[{name}] fallback due to: {reason}")
    pred = ModelPrediction(
        model_name=name,
        direction="up",
        confidence=0.35,       # ????????fallback ???????????? real models
        forecast_pct=0.0,
        forecasts=forecasts,
        direction_accuracy=0.5,
    )
    setattr(pred, "degraded", True)
    setattr(pred, "fallback_reason", reason)
    setattr(pred, "diagnostics", {"fallback_type": "flat", "reason": reason})
    return pred


# ?????? Model 1: Kalman Filter????????????????????????????????????????????????????????????????????????????
def run_kalman_filter(
    prices: np.ndarray,
    horizon: int = 14,
    stock_id: int = 0,
    hyperparams: dict | None = None,
) -> ModelPrediction:
    """
    Kalman Filter ?????????????????????????????????

    ????????[price_level, trend]
    ???????? = [[1,1],[0,1]]  ??????????= ?????? + ?????
    ????????H = [1, 0]          ???????????????

    ??DLinear ????????
    - DLinear?????????????????????????
    - Kalman???????????????????????????Kalman gain ????????
    """
    if len(prices) < 30:
        return _fallback_model("KalmanFilter", prices, horizon, "insufficient data")

    n = len(prices)
    hp = hyperparams or {}
    process_noise = max(1e-8, float(hp.get("process_noise", 0.01)))
    observation_noise = max(1e-8, float(hp.get("observation_noise", 1.0)))
    init_cov_scale = max(1e-8, float(hp.get("init_cov_scale", 1.0)))
    diffs         = np.diff(prices[-60:] if n >= 61 else prices)
    sigma_obs     = float(np.std(diffs)) + 1e-8
    sigma_trend   = sigma_obs * 0.1

    F = np.array([[1.0, 1.0], [0.0, 1.0]])
    H = np.array([[1.0, 0.0]])
    Q = np.array([[sigma_obs**2 * process_noise, 0.0], [0.0, sigma_trend**2 * process_noise / 0.01]])
    R = np.array([[sigma_obs**2 * observation_noise]])

    x = np.array([[float(prices[0])], [0.0]])
    P = np.eye(2) * sigma_obs**2 * init_cov_scale

    filtered_prices, filtered_trends = [], []
    for price in prices:
        x_p = F @ x
        P_p = F @ P @ F.T + Q
        S   = H @ P_p @ H.T + R
        K   = P_p @ H.T / S[0, 0]
        inn = float(price) - float((H @ x_p)[0, 0])
        x   = x_p + K * inn
        P   = (np.eye(2) - K @ H) @ P_p
        filtered_prices.append(float(x[0, 0]))
        filtered_trends.append(float(x[1, 0]))

    x_fc = x.copy()
    forecast_vals = []
    for _ in range(horizon):
        x_fc = F @ x_fc
        forecast_vals.append(float(x_fc[0, 0]))

    test_size = min(20, n // 5)
    preds_test = []
    for i in range(test_size):
        idx  = n - test_size + i - 1
        x_t  = np.array([[filtered_prices[idx]], [filtered_trends[idx]]])
        x_nx = F @ x_t
        preds_test.append(float(x_nx[0, 0]))
    dir_acc = _direction_accuracy(prices[-test_size:], np.array(preds_test))

    pct        = (forecast_vals[4] - prices[-1]) / prices[-1] if len(forecast_vals) > 4 else 0.0
    std        = sigma_obs
    confidence = min(0.88, max(0.35, dir_acc * (1.0 + abs(pct) * 5)))

    last_date = datetime.now()
    dates     = _add_trading_days(last_date, horizon)
    forecasts = _make_forecast_points(forecast_vals, std, dates)

    return ModelPrediction(
        model_name="KalmanFilter",
        direction="up" if pct > 0 else "down",
        confidence=round(confidence, 3),
        forecast_pct=round(pct, 4),
        forecasts=forecasts,
        direction_accuracy=round(dir_acc, 3),
    )


# ?????? Model 2: DLinear???????????+ ????????????????????????????????????????????????????????????????????????
def run_dlinear(prices: np.ndarray, horizon: int = 14) -> ModelPrediction:
    """
    DLinear ??"Are Transformers Effective for Time Series Forecasting?" (Zeng et al., ICLR 2023)

    ?????????????????? + ?????????????????????
    ???????????????????????????????????????PatchTST/FEDformer ??Transformer??

    ????????
    - ??numpy??????????????????????????
    - ????????? Kalman ???????????????
    - ??Kalman/N-HiTS ??????????????54%????????nsemble ????????
    """
    if len(prices) < 30:
        return _fallback_model("DLinear", prices, horizon, "insufficient data")

    n = len(prices)
    # ??? kernel????????????????
    kernel = min(25, (n // 4) * 2 + 1)
    pad    = kernel // 2

    def _decompose(seg: np.ndarray):
        padded = np.pad(seg, (pad, pad), mode='edge')
        trend  = np.convolve(padded, np.ones(kernel) / kernel, mode='valid')[:len(seg)]
        return trend, seg - trend

    trend_arr, seasonal_arr = _decompose(prices)

    # ?????? 30 ????????
    window   = min(30, n)
    t_w      = np.arange(n - window, n, dtype=float)
    slope, intercept = np.polyfit(t_w, trend_arr[-window:], 1)
    trend_fc = [slope * (n + i) + intercept for i in range(horizon)]

    # ?????????????? 5 ?????????????
    cycle    = 5
    seasonal_fc = [float(seasonal_arr[-(cycle - i % cycle)]) for i in range(horizon)]

    forecast_vals = [t + s for t, s in zip(trend_fc, seasonal_fc)]

    # Walk-forward ??????????20 ?????
    test_size = min(20, n // 5)
    preds_test, actual_test = [], []
    for i in range(test_size):
        seg = prices[:n - test_size + i]
        if len(seg) < kernel + 5:
            continue
        t_s, s_s = _decompose(seg)
        seg_n    = len(seg)
        t_ws     = np.arange(max(0, seg_n - window), seg_n, dtype=float)
        tr_ws    = t_s[max(0, seg_n - window):]
        if len(t_ws) < 2:
            continue
        sl, ic   = np.polyfit(t_ws, tr_ws, 1)
        pred_5   = sl * (seg_n + 4) + ic + float(s_s[-(cycle - 4 % cycle)])
        preds_test.append(pred_5)
        actual_test.append(float(prices[n - test_size + i]))

    dir_acc    = _direction_accuracy(np.array(actual_test), np.array(preds_test)) if len(preds_test) > 3 else 0.5
    pct        = (forecast_vals[4] - prices[-1]) / prices[-1] if len(forecast_vals) > 4 else 0.0
    std        = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
    confidence = min(0.88, max(0.35, dir_acc * (1 + abs(pct) * 4)))

    last_date = datetime.now()
    dates     = _add_trading_days(last_date, horizon)
    forecasts = _make_forecast_points(forecast_vals, std, dates)

    return ModelPrediction(
        model_name="DLinear",
        direction="up" if pct > 0 else "down",
        confidence=round(confidence, 3),
        forecast_pct=round(pct, 4),
        forecasts=forecasts,
        direction_accuracy=round(dir_acc, 3),
    )


# ?????? Model 3: Markov-Switching AR??egime ??????????????????????????????????????????????????????
def run_markov_switching(
    prices: np.ndarray,
    horizon: int = 14,
    stock_id: int = 0,
    hyperparams: dict | None = None,
) -> ModelPrediction:
    """
    Markov-Switching Autoregression ????? N-HiTS (#13)

    ????????s Kalman/DLinear ????????????????
      - ????????2 ??regime??ull/bear???????????? AR ????????
      - ????????regime ????????????????????
      - ??????????????????????S-AR ????????3-5 ?????????

    ??? statsmodels MarkovAutoregression:
      k_regimes=2, order=2, switching_ar=True, switching_variance=True
      ??smoothed_marginal_probabilities ?????? regime ????????

    Fallback??LE ???????????simple momentum model
    """
    MODEL_NAME = "MarkovSwitching"
    hp = hyperparams or {}
    n_regimes = max(2, min(5, int(hp.get("n_regimes", 2))))
    ar_order = max(1, min(3, int(hp.get("ar_order", 2))))
    switching_vol = bool(hp.get("switching_vol", True))

    if len(prices) < 60:
        return _fallback_model(MODEL_NAME, prices, horizon, "insufficient_data")

    def _params_to_dict(res) -> dict[str, float]:
        params = getattr(res, "params", None)
        if params is None:
            return {}
        if hasattr(params, "to_dict"):
            return {str(k): float(v) for k, v in params.to_dict().items()}
        names = getattr(res, "param_names", None) or getattr(getattr(res, "model", None), "param_names", None)
        raw = np.asarray(params).reshape(-1)
        if names is not None and len(names) == len(raw):
            return {str(k): float(v) for k, v in zip(names, raw.tolist())}
        return {}

    try:
        from statsmodels.tsa.regime_switching.markov_autoregression import MarkovAutoregression
        import warnings as _w
        _w.filterwarnings("ignore", module="statsmodels")

        n = len(prices)
        # ?????1 ??log returns????????LE ????????
        lookback = min(252, n - 1)
        log_returns = np.diff(np.log(prices[-lookback - 1:]))

        if len(log_returns) < 50:
            raise ValueError("too few returns for MS-AR")

        mod = MarkovAutoregression(
            log_returns, k_regimes=n_regimes, order=ar_order,
            switching_ar=True, switching_variance=switching_vol,
        )
        res = mod.fit(maxiter=200, disp=False, search_reps=20)

        # ??smoothed probabilities ????? regime
        # 2026-04-17 #1 fix: ??? statsmodels ??numpy input ??? numpy array
        # (??? pandas DataFrame) ??.iloc ???????? np.asarray ??????????????
        smoothed = np.asarray(res.smoothed_marginal_probabilities)
        regime_probs = smoothed[-1]  # [P(regime0), P(regime1)]

        # ???????regime ??bull??rift ??????
        params_map = _params_to_dict(res)
        regime_means = [params_map.get(f"const[{i}]", 0.0) for i in range(n_regimes)]
        bull_regime = int(np.argmax(regime_means))
        bear_regime = int(np.argmin(regime_means))
        bull_prob = float(regime_probs[bull_regime])

        # ??? + ???
        is_up = bull_prob > 0.5
        direction_strength = abs(bull_prob - 0.5) * 2  # 0~1

        # Forecast?????? regime ??AR ??????
        last_returns = log_returns[-ar_order:]
        forecast_returns = []
        r = last_returns.copy()
        # ??regime-conditional AR ?????horizon-step ???
        ar_params = []
        active_regime = bull_regime if is_up else bear_regime
        for lag in range(1, ar_order + 1):
            key = f"ar.L{lag}[{active_regime}]"
            ar_params.append(params_map.get(key, 0.0))
        drift = regime_means[active_regime]

        for _ in range(horizon):
            next_r = drift
            for lag_i, ar_p in enumerate(ar_params):
                if lag_i < len(r):
                    next_r += ar_p * r[-(lag_i + 1)]
            forecast_returns.append(next_r)
            r = np.append(r, next_r)

        # ??????
        last_price = float(prices[-1])
        forecast_prices = [last_price * np.exp(sum(forecast_returns[:i+1])) for i in range(horizon)]

        pct = (forecast_prices[4] - last_price) / last_price if len(forecast_prices) > 4 else 0.0

        # Walk-forward validation
        test_size = min(15, n // 10)
        wf_correct, wf_total = 0, 0
        for i in range(test_size):
            seg_end = n - test_size + i
            if seg_end < 60:
                continue
            seg_ret = np.diff(np.log(prices[:seg_end]))[-lookback:]
            try:
                m = MarkovAutoregression(seg_ret, k_regimes=n_regimes, order=ar_order,
                                         switching_ar=True, switching_variance=switching_vol)
                r_fit = m.fit(maxiter=100, disp=False, search_reps=5)
                sp = np.asarray(r_fit.smoothed_marginal_probabilities)  # 2026-04-17 #1 fix
                pmap = _params_to_dict(r_fit)
                rm = [pmap.get(f"const[{j}]", 0.0) for j in range(n_regimes)]
                br = int(np.argmax(rm))
                pred_up = float(sp[-1, br]) > 0.5
                actual_up = prices[min(seg_end + 4, n - 1)] > prices[seg_end - 1]
                if pred_up == actual_up:
                    wf_correct += 1
                wf_total += 1
            except Exception:
                continue

        dir_acc = wf_correct / wf_total if wf_total > 0 else 0.5
        std = float(np.std(np.diff(prices[-20:]))) if n >= 21 else last_price * 0.015
        confidence = min(0.88, max(0.35, dir_acc * (1 + direction_strength * 2)))

        last_date = datetime.now()
        dates = _add_trading_days(last_date, horizon)
        forecasts = _make_forecast_points(forecast_prices, std, dates)

        return ModelPrediction(
            model_name=MODEL_NAME,
            direction="up" if is_up else "down",
            confidence=round(confidence, 3),
            forecast_pct=round(pct, 4),
            forecasts=forecasts,
            direction_accuracy=round(dir_acc, 3),
        )

    except Exception as e:
        # Fallback: simple momentum model??/10/20 ?????????
        reason = str(e).strip() or type(e).__name__
        if "SVD did not converge" in reason:
            reason = "svd_not_converged"
        return _fallback_momentum(prices, horizon, stock_id, reason)


def _fallback_momentum(prices: np.ndarray, horizon: int, stock_id: int, reason: str) -> ModelPrediction:
    """Fallback for MarkovSwitching."""
    MODEL_NAME = "MarkovSwitching"
    n = len(prices)
    if n < 20:
        return _fallback_model(MODEL_NAME, prices, horizon, reason)

    # 5/10/20 ????????
    mom5  = (prices[-1] / prices[-min(5, n)] - 1) if n >= 5 else 0
    mom10 = (prices[-1] / prices[-min(10, n)] - 1) if n >= 10 else 0
    mom20 = (prices[-1] / prices[-min(20, n)] - 1) if n >= 20 else 0
    weighted_mom = 0.5 * mom5 + 0.3 * mom10 + 0.2 * mom20

    is_up = weighted_mom > 0
    pct = weighted_mom * 0.3  # dampen
    last_price = float(prices[-1])
    forecast_vals = [last_price * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
    std = float(np.std(np.diff(prices[-20:]))) if n >= 21 else last_price * 0.015

    last_date = datetime.now()
    dates = _add_trading_days(last_date, horizon)
    forecasts = _make_forecast_points(forecast_vals, std, dates)

    logger.debug("[%s] fallback momentum due to: %s", MODEL_NAME, reason)
    pred = ModelPrediction(
        model_name=MODEL_NAME,
        direction="up" if is_up else "down",
        confidence=round(min(0.65, max(0.35, 0.5 + abs(weighted_mom) * 3)), 3),
        forecast_pct=round(pct, 4),
        forecasts=forecasts,
        direction_accuracy=0.5,
    )
    setattr(pred, "degraded", True)
    setattr(pred, "fallback_reason", reason)
    setattr(pred, "diagnostics", {"fallback_type": "momentum", "reason": reason})
    return pred


def run_patchtst(prices: np.ndarray, horizon: int = 14, stock_id: int = 0) -> ModelPrediction:
    raise RuntimeError("PatchTST local predictor removed; use NeuralForecast artifact-backed batch serving")


def run_xgboost(X: np.ndarray, y: np.ndarray, X_latest: np.ndarray,
                prices: np.ndarray, horizon: int = 14,
                stock_id: int = 0, feature_names: list[str] | None = None) -> ModelPrediction:
    try:
        from xgboost import XGBClassifier
        from .model_store import load_model, save_model, is_model_fresh, feature_names_match
        if len(X) < 30:
            raise ValueError("Not enough data")

        feature_names = feature_names or []
        split = int(len(X) * 0.8)
        X_test, y_test = X[split:], y[split:]

        model = None
        # Universal model first (stock_id=0), then per-stock fallback
        for sid in [0, stock_id] if stock_id > 0 else [0]:
            stored_model, meta = load_model(sid, "XGBoost")
            if (stored_model is not None
                    and is_model_fresh(meta)
                    and feature_names_match(meta, feature_names)):
                model = stored_model
                print(f"[XGBoost] Loaded {'universal' if sid == 0 else f'per-stock {sid}'} model")
                break

        if model is None:
            model = XGBClassifier(
                n_estimators=150, max_depth=4, learning_rate=0.05,
                subsample=0.8, colsample_bytree=0.8,
                use_label_encoder=False, eval_metric="logloss",
                random_state=42, verbosity=0,
            )
            model.fit(X[:split], y[:split])
            if stock_id > 0:
                save_model(stock_id, "XGBoost", model, feature_names, len(X))

        dir_acc   = float(model.score(X_test, y_test)) if len(X_test) > 0 else 0.5
        proba     = model.predict_proba(X_latest.reshape(1, -1))[0]
        up_prob   = float(proba[1]) if len(proba) > 1 else 0.5
        direction = "up" if up_prob > 0.5 else "down"
        confidence = max(up_prob, 1 - up_prob)

        pct           = (up_prob - 0.5) * 2 * 0.05
        forecast_vals = [prices[-1] * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
        std           = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
        last_date     = datetime.now()
        dates         = _add_trading_days(last_date, horizon)
        forecasts     = _make_forecast_points(forecast_vals, std, dates)

        shap_top = _compute_shap_top5(model, X_latest, feature_names or [])

        return ModelPrediction(
            model_name="XGBoost",
            direction=direction,
            confidence=round(confidence, 3),
            forecast_pct=round(pct, 4),
            forecasts=forecasts,
            direction_accuracy=round(dir_acc, 3),
            shap_top5=shap_top,
        )
    except Exception as e:
        return _fallback_model("XGBoost", prices, horizon, str(e))


def run_extra_trees(X: np.ndarray, y: np.ndarray, X_latest: np.ndarray,
                    prices: np.ndarray, horizon: int = 14,
                    stock_id: int = 0, feature_names: list[str] | None = None) -> ModelPrediction:
    try:
        from sklearn.ensemble import ExtraTreesClassifier
        from .model_store import load_model, save_model, is_model_fresh, feature_names_match

        if len(X) < 30:
            raise ValueError("Not enough data")

        feature_names = feature_names or []
        split          = int(len(X) * 0.8)
        X_test, y_test = X[split:], y[split:]

        model = None
        for sid in [0, stock_id] if stock_id > 0 else [0]:
            stored_model, meta = load_model(sid, "ExtraTrees")
            if (stored_model is not None
                    and is_model_fresh(meta)
                    and feature_names_match(meta, feature_names)):
                model = stored_model
                print(f"[ExtraTrees] Loaded {'universal' if sid == 0 else f'per-stock {sid}'} model")
                break

        if model is None:
            model = ExtraTreesClassifier(
                n_estimators=200, max_depth=6, min_samples_split=5,
                min_samples_leaf=3, max_features="sqrt",
                class_weight="balanced", bootstrap=True,
                random_state=42, n_jobs=-1,
            )
            model.fit(X[:split], y[:split])
            if stock_id > 0:
                save_model(stock_id, "ExtraTrees", model, feature_names, len(X))

        dir_acc    = float(model.score(X_test, y_test)) if len(X_test) > 0 else 0.5
        proba      = model.predict_proba(X_latest.reshape(1, -1))[0]
        up_prob    = float(proba[1])
        direction  = "up" if up_prob > 0.5 else "down"
        confidence = max(up_prob, 1 - up_prob)

        pct           = (up_prob - 0.5) * 2 * 0.05
        forecast_vals = [prices[-1] * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
        std           = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
        last_date     = datetime.now()
        dates         = _add_trading_days(last_date, horizon)
        forecasts     = _make_forecast_points(forecast_vals, std, dates)

        shap_top = _compute_shap_top5(model, X_latest, feature_names or [])

        return ModelPrediction(
            model_name="ExtraTrees",
            direction=direction,
            confidence=round(confidence, 3),
            forecast_pct=round(pct, 4),
            forecasts=forecasts,
            direction_accuracy=round(dir_acc, 3),
            shap_top5=shap_top,
        )
    except Exception as e:
        return _fallback_model("ExtraTrees", prices, horizon, str(e))


# ?????? Model 9: LightGBM??eaf-wise ????????GBM???????????????????????????????????????????????????????
def run_lightgbm(X: np.ndarray, y: np.ndarray, X_latest: np.ndarray,
                 prices: np.ndarray, horizon: int = 14,
                 stock_id: int = 0, feature_names: list[str] | None = None) -> ModelPrediction:
    """
    LightGBM ????XGBoost/ExtraTrees ??????
    - Leaf-wise ??????vs level-wise?????? leaf ????????????
    - Histogram-based feature binning?????250 ????????XGB ??3-5x
    - ??????????????????????????????

    ??XGBoost ?????????????????????71%???????????????
    XGB ??????????????????LGBM ??????????????????
    """
    try:
        import lightgbm as lgb
        from .model_store import load_model, save_model, is_model_fresh, feature_names_match
        if len(X) < 30:
            raise ValueError("Not enough data")

        feature_names = feature_names or []
        split          = int(len(X) * 0.8)
        X_test, y_test = X[split:], y[split:]

        model = None
        for sid in [0, stock_id] if stock_id > 0 else [0]:
            stored_model, meta = load_model(sid, "LightGBM")
            if (stored_model is not None
                    and is_model_fresh(meta)
                    and feature_names_match(meta, feature_names)):
                model = stored_model
                print(f"[LightGBM] Loaded {'universal' if sid == 0 else f'per-stock {sid}'} model")
                break

        if model is None:
            model = lgb.LGBMClassifier(
                n_estimators=200,
                max_depth=5,
                learning_rate=0.05,
                num_leaves=31,
                subsample=0.8,
                colsample_bytree=0.8,
                min_child_samples=10,
                class_weight="balanced",
                random_state=42,
                verbose=-1,
            )
            model.fit(X[:split], y[:split])
            if stock_id > 0:
                save_model(stock_id, "LightGBM", model, feature_names, len(X))

        dir_acc    = float(model.score(X_test, y_test)) if len(X_test) > 0 else 0.5
        proba      = model.predict_proba(X_latest.reshape(1, -1))[0]
        up_prob    = float(proba[1])
        direction  = "up" if up_prob > 0.5 else "down"
        confidence = max(up_prob, 1 - up_prob)

        pct           = (up_prob - 0.5) * 2 * 0.05
        forecast_vals = [prices[-1] * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
        std           = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
        last_date     = datetime.now()
        dates         = _add_trading_days(last_date, horizon)
        forecasts     = _make_forecast_points(forecast_vals, std, dates)

        shap_top = _compute_shap_top5(model, X_latest, feature_names or [])

        return ModelPrediction(
            model_name="LightGBM",
            direction=direction,
            confidence=round(confidence, 3),
            forecast_pct=round(pct, 4),
            forecasts=forecasts,
            direction_accuracy=round(dir_acc, 3),
            shap_top5=shap_top,
        )
    except Exception as e:
        return _fallback_model("LightGBM", prices, horizon, str(e))


def run_garch_volatility(prices: np.ndarray, horizon: int = 5) -> float:
    """
    GARCH(1,1) ?????? horizon ??????????????????????????
    ??? ensemble ?????????????????? ATR ?????

    ?????fallback ???????????td of diff????
    """
    fallback = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else float(prices[-1]) * 0.015
    if len(prices) < 60:
        return fallback
    try:
        from arch import arch_model
        pct_returns = np.diff(np.log(prices[-252:])) * 100
        if np.isnan(pct_returns).any() or np.isinf(pct_returns).any():
            return fallback
        am  = arch_model(pct_returns, vol="GARCH", p=1, q=1, dist="normal")
        res = am.fit(disp="off", show_warning=False)
        fc  = res.forecast(horizon=horizon, reindex=False)
        mean_var  = float(fc.variance.values[-1].mean())
        daily_vol = np.sqrt(max(mean_var, 0)) / 100
        return float(daily_vol * prices[-1])
    except Exception:
        return fallback
