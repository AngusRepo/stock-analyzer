"""
Model adapters for StockVision inference.

Alpha predictors:
  - DLinear / PatchTST / Chronos
  - XGBoost / CatBoost / ExtraTrees / LightGBM / FT-Transformer

State-space overlays:
  - KalmanFilter / MarkovSwitching
"""
import numpy as np
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Literal
import warnings
warnings.filterwarnings("ignore")

from .ft_transformer import build_ft_transformer, rebuild_ft_transformer_from_bundle


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

    print(f"[{MODEL_NAME}] fallback momentum due to: {reason}")
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


# ?????? Model 4: PatchTST??atch ?????+ Ridge ??????????????????????????????????????????????????????????????
def run_patchtst(prices: np.ndarray, horizon: int = 14, stock_id: int = 0) -> ModelPrediction:
    """
    PatchTST ??"A Time Series is Worth 64 Words" (Nie et al., ICLR 2023)

    ??????????????patch??????????????patch ?????????oken????
    ?????? Transformer ??? patch tokens????????Ridge Regression??? PyTorch ??????
      1. ?????N_PATCH ??patch?????patch ??PATCH_LEN????????
      2. ?????????????Ridge ?????
      3. ??????????????????walk-forward??

    ????????????????????
      KalmanFilter????????????
      DLinear???????????
      N-HiTS?????????
      PatchTST???????????????????????????????????????
    """
    PATCH_LEN   = 16    # ????patch ?????
    PATCH_STRIDE = 8    # patch ????????0% ?????
    N_PATCHES   = 6     # ??????????patch

    total_len = PATCH_LEN + PATCH_STRIDE * (N_PATCHES - 1)
    if len(prices) < total_len + horizon + 10:
        return _fallback_model("PatchTST", prices, horizon, "insufficient data")

    try:
        # #10 PatchTST: Ridge ??MLPClassifier???????pattern matching??
        from sklearn.neural_network import MLPClassifier
        from sklearn.preprocessing import StandardScaler
    except ImportError:
        return _fallback_model("PatchTST", prices, horizon, "sklearn not available")

    n = len(prices)

    def _extract_patches(seg: np.ndarray) -> np.ndarray:
        """Extract fixed-length patches for PatchTST fallback."""
        patches = []
        for i in range(N_PATCHES):
            start = len(seg) - total_len + PATCH_STRIDE * i
            end   = start + PATCH_LEN
            patch = seg[start:end].astype(float)
            # ????patch ????????
            p_mu, p_std = patch.mean(), patch.std() + 1e-8
            patches.append((patch - p_mu) / p_std)
        return np.concatenate(patches)  # shape: (N_PATCHES * PATCH_LEN,)

    # ???????????X=patches, y=5??????)
    min_train = total_len + 5
    X_rows, y_rows = [], []
    for i in range(min_train, n - 5):
        try:
            feat = _extract_patches(prices[:i])
            label = 1 if prices[i + 4] > prices[i - 1] else 0
            X_rows.append(feat)
            y_rows.append(label)
        except Exception:
            continue

    if len(X_rows) < 20:
        return _fallback_model("PatchTST", prices, horizon, "not enough training windows")

    X_arr = np.array(X_rows)
    y_arr = np.array(y_rows)
    split = int(len(X_arr) * 0.8)

    scaler  = StandardScaler()
    X_train = scaler.fit_transform(X_arr[:split])
    if split < len(X_arr):
        X_test = scaler.transform(X_arr[split:])
        y_test = y_arr[split:]
    else:
        X_test = np.empty((0, X_arr.shape[1]))
        y_test = np.array([])

    model = MLPClassifier(
        hidden_layer_sizes=(32, 16), max_iter=300,
        random_state=42, early_stopping=True, validation_fraction=0.15,
    )
    model.fit(X_train, y_arr[:split])

    dir_acc  = float(model.score(X_test, y_test)) if len(y_test) > 0 else 0.5
    x_latest = scaler.transform(_extract_patches(prices).reshape(1, -1))
    proba    = model.predict_proba(x_latest)[0]
    up_prob  = float(proba[1]) if len(proba) > 1 else 0.5
    up_prob  = min(0.95, max(0.05, up_prob))

    pct           = (up_prob - 0.5) * 2 * 0.05
    forecast_vals = [prices[-1] * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
    std           = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
    confidence    = max(up_prob, 1 - up_prob)
    confidence    = min(0.87, max(0.35, dir_acc * (1 + abs(pct) * 4)))

    last_date = datetime.now()
    dates     = _add_trading_days(last_date, horizon)
    forecasts = _make_forecast_points(forecast_vals, std, dates)

    return ModelPrediction(
        model_name="PatchTST",
        direction="up" if up_prob > 0.5 else "down",
        confidence=round(confidence, 3),
        forecast_pct=round(pct, 4),
        forecasts=forecasts,
        direction_accuracy=round(dir_acc, 3),
    )


# ?????? Model 5: Chronos??mazon ????????ero-Shot?????????????????????????????????????????????????????????
def run_chronos(prices: np.ndarray, horizon: int = 14, stock_id: int = 0) -> ModelPrediction:
    """Production Chronos slot backed by Chronos-2 universal runtime."""
    if len(prices) < 10:
        return _fallback_model("Chronos", prices, horizon, "insufficient data")

    try:
        from .chronos_universal import chronos_batch_predict

        result = chronos_batch_predict(
            [{"symbol": str(stock_id or "single"), "prices": [float(v) for v in prices]}],
            horizon=horizon,
        )[0]
        if result.get("error"):
            raise RuntimeError(result["error"])
        forecast_price = float(result.get("forecast_price") or prices[-1])
        pct = float(result.get("forecast_pct") or 0.0)
        up_prob = float(result.get("up_prob") or (0.6 if pct > 0 else 0.4))
        confidence = float(result.get("confidence") or 0.5)
        dates = _add_trading_days(datetime.now(), horizon)
        forecasts = [
            {
                "date": dates[i],
                "forecast": round(forecast_price, 2),
                "lower80": round(forecast_price * 0.98, 2),
                "upper80": round(forecast_price * 1.02, 2),
                "lower95": round(forecast_price * 0.96, 2),
                "upper95": round(forecast_price * 1.04, 2),
            }
            for i in range(horizon)
        ]
        return ModelPrediction(
            model_name="Chronos",
            direction="up" if up_prob > 0.5 else "down",
            confidence=round(min(0.85, max(0.35, confidence)), 3),
            forecast_pct=round(pct, 4),
            forecasts=forecasts,
            direction_accuracy=round(max(up_prob, 1 - up_prob), 3),
        )
    except ImportError:
        result = run_dlinear(prices, horizon)
        return ModelPrediction(
            model_name="Chronos",
            direction=result.direction,
            confidence=round(result.confidence * 0.9, 3),
            forecast_pct=result.forecast_pct,
            forecasts=result.forecasts,
            direction_accuracy=result.direction_accuracy,
        )
    except Exception as e:
        return _fallback_model("Chronos", prices, horizon, str(e))


# ?????? Model 6: XGBoost (?????? + GCS ????? ????????????????????????????????????????????????????????????????
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


# ?????? Model 7: CatBoost???????????????????????????????????????????????????????????????????????????????????????????
def run_catboost(X: np.ndarray, y: np.ndarray, X_latest: np.ndarray,
                 prices: np.ndarray, horizon: int = 14,
                 stock_id: int = 0, feature_names: list[str] | None = None) -> ModelPrediction:
    try:
        from catboost import CatBoostClassifier
        from .model_store import load_model, save_model, is_model_fresh, feature_names_match
        if len(X) < 30:
            raise ValueError("Not enough data")

        feature_names = feature_names or []
        split = int(len(X) * 0.8)
        X_test, y_test = X[split:], y[split:]

        model = None
        for sid in [0, stock_id] if stock_id > 0 else [0]:
            stored_model, meta = load_model(sid, "CatBoost")
            if (stored_model is not None
                    and is_model_fresh(meta)
                    and feature_names_match(meta, feature_names)):
                model = stored_model
                print(f"[CatBoost] Loaded {'universal' if sid == 0 else f'per-stock {sid}'} model")
                break

        if model is None:
            model = CatBoostClassifier(
                iterations=200, depth=5, learning_rate=0.05,
                loss_function='Logloss', eval_metric='Accuracy',
                random_seed=42, verbose=0,
            )
            model.fit(X[:split], y[:split])
            if stock_id > 0:
                save_model(stock_id, "CatBoost", model, feature_names, len(X))

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
            model_name="CatBoost",
            direction=direction,
            confidence=round(confidence, 3),
            forecast_pct=round(pct, 4),
            forecasts=forecasts,
            direction_accuracy=round(dir_acc, 3),
            shap_top5=shap_top,
        )
    except Exception as e:
        return _fallback_model("CatBoost", prices, horizon, str(e))


# ?????? Model 8: Extra Trees????????????????????????????????????????????????????????????????????????????????????????
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
    LightGBM ????XGBoost/CatBoost ??????
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


# ?????? Model 10: FT-Transformer?????Tokenization + Transformer?????????????????????????????
def run_ft_transformer(X: np.ndarray, y: np.ndarray, X_latest: np.ndarray,
                       prices: np.ndarray, horizon: int = 14,
                       stock_id: int = 0, feature_names: list[str] | None = None) -> ModelPrediction:
    """
    FT-Transformer ??"Revisiting Deep Learning Models for Tabular Data" (Gorishniy et al., NeurIPS 2021)

    ?????
      FeatureTokenizer?????????????????? embedding ??shape (B, F, D)
      TransformerEncoder?? ???4 head??_model=64
      CLS token ??Linear ?????

    ??MLP ??????MLP ?????????
      MLP???????????????????????????
      FT-T??ttention ???????????? RSI>70 AND ?????? AND GARCH ?????????????

    Fallback??yTorch ???????????LightGBM ???
    GCS ???????????? state_dict??redict ????????TCN ????????
    """
    if len(X) < 30:
        return _fallback_model("FT-Transformer", prices, horizon, "insufficient data")

    try:
        import torch
        import torch.nn as nn
        from .model_store import load_model, save_model, is_model_fresh, feature_names_match
    except ImportError:
        # PyTorch ????????????LightGBM
        result = run_lightgbm(X, y, X_latest, prices, horizon, stock_id, feature_names)
        return ModelPrediction(
            model_name="FT-Transformer",
            direction=result.direction,
            confidence=round(result.confidence * 0.9, 3),
            forecast_pct=result.forecast_pct,
            forecasts=result.forecasts,
            direction_accuracy=result.direction_accuracy,
        )

    feature_names = feature_names or []
    n_features    = X.shape[1]
    D_MODEL       = 64
    N_HEADS       = 4
    N_LAYERS      = 2
    EPOCHS        = 60
    LR            = 1e-3

    class FTTransformer(nn.Module):
        def __init__(self, n_feat, d_model, n_heads, n_layers):
            super().__init__()
            self.feat_embed = nn.Linear(1, d_model, bias=True)
            self.cls_token  = nn.Parameter(torch.zeros(1, 1, d_model))
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=d_model, nhead=n_heads,
                dim_feedforward=d_model * 4,
                dropout=0.1, batch_first=True,
            )
            self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
            self.head     = nn.Linear(d_model, 2)

        def forward(self, x):
            # x: (B, F)
            B = x.shape[0]
            tokens = self.feat_embed(x.unsqueeze(-1))           # (B, F, D)
            cls    = self.cls_token.expand(B, -1, -1)           # (B, 1, D)
            tokens = torch.cat([cls, tokens], dim=1)            # (B, F+1, D)
            out    = self.encoder(tokens)                        # (B, F+1, D)
            return self.head(out[:, 0, :])                      # (B, 2)  ??CLS output

    split          = int(len(X) * 0.8)
    X_test, y_test = X[split:], y[split:]

    # ???? ?????? GCS??niversal first, per-stock fallback?????????????????????????????????????????
    model  = None
    scaler = None
    for sid in [0, stock_id] if stock_id > 0 else [0]:
        stored, meta = load_model(sid, "FT-Transformer")
        if (stored is not None
                and is_model_fresh(meta)
                and feature_names_match(meta, feature_names)):
            if isinstance(stored, dict) and "state_dict" in stored:
                try:
                    from sklearn.preprocessing import StandardScaler as SS
                    scaler = stored["scaler"]
                    m      = FTTransformer(n_features, D_MODEL, N_HEADS, N_LAYERS)
                    m.load_state_dict(stored["state_dict"])
                    m.eval()
                    model = m
                    print(f"[FT-Transformer] Loaded {'universal' if sid == 0 else f'per-stock {sid}'} model")
                    break
                except Exception:
                    model = None

    # ???? ??? ??????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????
    if model is None:
        from sklearn.preprocessing import StandardScaler as SS
        scaler  = SS()
        X_train = scaler.fit_transform(X[:split]).astype(np.float32)
        y_train = y[:split].astype(np.int64)

        model   = FTTransformer(n_features, D_MODEL, N_HEADS, N_LAYERS)
        opt     = torch.optim.Adam(model.parameters(), lr=LR, weight_decay=1e-4)
        crit    = nn.CrossEntropyLoss()

        model.train()
        for epoch in range(EPOCHS):
            idx   = np.random.permutation(len(X_train))
            for s in range(0, len(X_train), 32):
                bi   = idx[s:s+32]
                xb   = torch.tensor(X_train[bi])
                yb   = torch.tensor(y_train[bi])
                loss = crit(model(xb), yb)
                opt.zero_grad(); loss.backward(); opt.step()
        model.eval()

        if stock_id > 0:
            bundle = {
                "state_dict": model.state_dict(),
                "scaler":     scaler,
                "n_features": n_features,
            }
            save_model(stock_id, "FT-Transformer", bundle, feature_names, len(X))

    # ???? ??? ??????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????????
    with torch.no_grad():
        X_test_t  = torch.tensor(scaler.transform(X_test).astype(np.float32))
        X_lat_t   = torch.tensor(scaler.transform(X_latest.reshape(1, -1)).astype(np.float32))
        logits_t  = model(X_test_t)
        proba_lat = torch.softmax(model(X_lat_t), dim=-1).numpy()[0]

    if len(y_test) > 0:
        preds_t = torch.argmax(logits_t, dim=-1).numpy()
        dir_acc = float(np.mean(preds_t == y_test))
    else:
        dir_acc = 0.5

    up_prob    = float(proba_lat[1]) if len(proba_lat) > 1 else 0.5
    direction  = "up" if up_prob > 0.5 else "down"
    confidence = max(up_prob, 1 - up_prob)

    pct           = (up_prob - 0.5) * 2 * 0.05
    forecast_vals = [prices[-1] * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
    std           = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
    last_date     = datetime.now()
    dates         = _add_trading_days(last_date, horizon)
    forecasts     = _make_forecast_points(forecast_vals, std, dates)

    return ModelPrediction(
        model_name="FT-Transformer",
        direction=direction,
        confidence=round(confidence, 3),
        forecast_pct=round(pct, 4),
        forecasts=forecasts,
        direction_accuracy=round(dir_acc, 3),
    )


# ?????? GARCH ?????????helper?????? ModelPrediction?????????????????????????????????????????????
def run_ft_transformer(X: np.ndarray, y: np.ndarray, X_latest: np.ndarray,
                       prices: np.ndarray, horizon: int = 14,
                       stock_id: int = 0, feature_names: list[str] | None = None) -> ModelPrediction:
    """
    FT-Transformer serving contract cleanup.

    If a saved bundle exists, always rebuild that exact bundle architecture.
    Regression bundles must never silently fall back into legacy classifier retraining.
    Legacy classifier training is only kept as a last-resort fallback for the old
    /predict path until the controller fully converges to V2.
    """
    if len(X) < 30:
        return _fallback_model("FT-Transformer", prices, horizon, "insufficient data")

    try:
        import torch
        import torch.nn as nn
        from .model_store import load_model, save_model, is_model_fresh, feature_names_match
    except ImportError:
        result = run_lightgbm(X, y, X_latest, prices, horizon, stock_id, feature_names)
        return ModelPrediction(
            model_name="FT-Transformer",
            direction=result.direction,
            confidence=round(result.confidence * 0.9, 3),
            forecast_pct=result.forecast_pct,
            forecasts=result.forecasts,
            direction_accuracy=result.direction_accuracy,
        )

    feature_names = feature_names or []
    n_features = X.shape[1]
    split = int(len(X) * 0.8)
    X_test, y_test = X[split:], y[split:]

    model = None
    scaler = None
    model_type = "classification"

    for sid in [0, stock_id] if stock_id > 0 else [0]:
        stored, meta = load_model(sid, "FT-Transformer")
        if not (
            stored is not None
            and is_model_fresh(meta)
            and feature_names_match(meta, feature_names)
            and isinstance(stored, dict)
            and "state_dict" in stored
        ):
            continue
        try:
            scaler = stored.get("scaler")
            if scaler is None:
                raise ValueError("bundle missing scaler")
            model, model_type, _arch = rebuild_ft_transformer_from_bundle(stored)
            print(
                f"[FT-Transformer] Loaded {'universal' if sid == 0 else f'per-stock {sid}'} "
                f"{model_type} bundle"
            )
            break
        except Exception as e:
            print(f"[FT-Transformer] bundle load failed for sid={sid}: {e}")
            model = None
            scaler = None

    if model is None:
        from sklearn.preprocessing import StandardScaler as SS

        scaler = SS()
        X_train = scaler.fit_transform(X[:split]).astype(np.float32)
        y_train = y[:split].astype(np.int64)

        model, legacy_arch = build_ft_transformer(n_features, "classification")
        opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
        crit = nn.CrossEntropyLoss()

        model.train()
        for _epoch in range(60):
            idx = np.random.permutation(len(X_train))
            for s in range(0, len(X_train), 32):
                bi = idx[s:s+32]
                xb = torch.tensor(X_train[bi])
                yb = torch.tensor(y_train[bi])
                loss = crit(model(xb), yb)
                opt.zero_grad()
                loss.backward()
                opt.step()
        model.eval()
        model_type = "classification"

        if stock_id > 0:
            bundle = {
                "state_dict": model.state_dict(),
                "scaler": scaler,
                "n_features": n_features,
                "model_type": model_type,
                "arch": legacy_arch,
            }
            save_model(stock_id, "FT-Transformer", bundle, feature_names, len(X))

    with torch.no_grad():
        X_test_scaled = scaler.transform(X_test).astype(np.float32) if len(X_test) > 0 else np.empty((0, n_features), dtype=np.float32)
        X_latest_scaled = scaler.transform(X_latest.reshape(1, -1)).astype(np.float32)

        if model_type == "regression":
            from .ft_transformer import rank_from_ft_regression_output

            logits_t = model(torch.tensor(X_test_scaled)) if len(X_test_scaled) > 0 else None
            pred_latest = rank_from_ft_regression_output(model(torch.tensor(X_latest_scaled)).reshape(-1)[0].item())
            up_prob = pred_latest
            if logits_t is not None and len(y_test) > 0:
                preds_t = np.array(
                    [rank_from_ft_regression_output(v) for v in logits_t.detach().cpu().numpy().reshape(-1)],
                    dtype=float,
                )
                dir_acc = float(np.mean((preds_t > 0.5) == y_test))
            else:
                dir_acc = 0.5
        else:
            logits_t = model(torch.tensor(X_test_scaled)) if len(X_test_scaled) > 0 else None
            proba_lat = torch.softmax(model(torch.tensor(X_latest_scaled)), dim=-1).detach().cpu().numpy()[0]
            up_prob = float(proba_lat[1]) if len(proba_lat) > 1 else 0.5
            if logits_t is not None and len(y_test) > 0:
                preds_t = torch.argmax(logits_t, dim=-1).detach().cpu().numpy()
                dir_acc = float(np.mean(preds_t == y_test))
            else:
                dir_acc = 0.5

    direction = "up" if up_prob > 0.5 else "down"
    confidence = max(up_prob, 1 - up_prob)
    pct = (up_prob - 0.5) * 2 * 0.05
    forecast_vals = [prices[-1] * (1 + pct * (i + 1) / horizon) for i in range(horizon)]
    std = float(np.std(np.diff(prices[-20:]))) if len(prices) >= 21 else prices[-1] * 0.015
    last_date = datetime.now()
    dates = _add_trading_days(last_date, horizon)
    forecasts = _make_forecast_points(forecast_vals, std, dates)

    return ModelPrediction(
        model_name="FT-Transformer",
        direction=direction,
        confidence=round(confidence, 3),
        forecast_pct=round(pct, 4),
        forecasts=forecasts,
        direction_accuracy=round(dir_acc, 3),
    )


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
