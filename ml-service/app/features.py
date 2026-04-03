"""
features.py — 特徵工程
整合：技術指標 + 籌碼面 + 情感分數 + 大盤環境特徵
Triple Barrier Label (Prado 2018) 取代固定 N 日方向標籤
"""
import numpy as np
import pandas as pd
from typing import Optional


# ── Triple Barrier Label (Prado 2018) ────────────────────────────────────────
def compute_triple_barrier_labels(
    close: pd.Series,
    high: pd.Series,
    low: pd.Series,
    atr14: pd.Series,
    upper_atr_mult: float = 3.0,
    lower_atr_mult: float = 2.0,
    upper_pct_cap: float = 0.07,   # 停利上限 7%
    lower_pct_cap: float = 0.03,   # 停損上限 3%
    max_days: int = 20,
    transaction_cost_pct: float = 0.003,  # 來回手續費+稅 0.3%（台股：買 0.1425% + 賣 0.1425% + 證交稅 0.15%）
) -> pd.Series:
    """
    三重屏障標籤：
      1 = 先觸及上界（停利）→ 賺錢交易
      0 = 先觸及下界（停損）→ 虧錢交易
      NaN = 到期平倉（max_days 內未觸碰任一邊界）或資料不足

    參數使用 ATR 動態計算邊界，並以百分比封頂：
      upper = min(ATR × upper_mult, close × upper_pct_cap)
      lower = min(ATR × lower_mult, close × lower_pct_cap)
    """
    n = len(close)
    labels = pd.Series(np.nan, index=close.index, dtype=float)

    close_arr = close.values
    high_arr = high.values
    low_arr = low.values
    atr_arr = atr14.values

    for i in range(n - 1):
        price = close_arr[i]
        if np.isnan(price) or price <= 0:
            continue

        atr = atr_arr[i] if not np.isnan(atr_arr[i]) else price * 0.02
        # 動態邊界 + 百分比封頂 — 扣除交易成本（barrier 需要覆蓋成本才算獲利）
        cost = price * transaction_cost_pct
        upper_barrier = price + min(atr * upper_atr_mult, price * upper_pct_cap) + cost
        lower_barrier = price - min(atr * lower_atr_mult, price * lower_pct_cap) + cost

        end_idx = min(i + max_days, n - 1)
        if end_idx <= i:
            continue

        # 掃描未來 max_days 內的 high/low，找第一個觸碰的邊界
        hit = False
        for j in range(i + 1, end_idx + 1):
            h = high_arr[j]
            lo = low_arr[j]
            if np.isnan(h) or np.isnan(lo):
                continue
            # 同日觸碰兩邊 → 用 close 判定
            hit_upper = h >= upper_barrier
            hit_lower = lo <= lower_barrier
            if hit_upper and hit_lower:
                c_j = close_arr[j] if not np.isnan(close_arr[j]) else price
                labels.iloc[i] = 1.0 if c_j >= price else 0.0
                hit = True
                break
            elif hit_upper:
                labels.iloc[i] = 1.0
                hit = True
                break
            elif hit_lower:
                labels.iloc[i] = 0.0
                hit = True
                break

        # 未觸碰任一邊界 → NaN（到期平倉，dropna 時排除）
        # 保持 labels.iloc[i] = NaN

    return labels


def build_feature_matrix(
    prices: list[dict],
    indicators: list[dict],
    chips: list[dict],
    sentiment_scores: list[dict],
    market_env: dict | None = None,
) -> pd.DataFrame:
    """
    整合所有資料來源，建立特徵矩陣
    prices:           [{date, close, high, low, open, volume}, ...]
    indicators:       [{date, ma5, ma10, ma20, ma60, rsi14, macdHist, bb_upper, bb_lower, atr14}, ...]
    chips:            [{date, foreign_net, trust_net, dealer_net}, ...]
    sentiment_scores: [{date, score}, ...]  # -1~+1
    market_env:       {risk_score, risk_level, twii_return_1d, twii_return_5d,
                       twii_bias_20d, vix_equivalent}  # 大盤環境（單一數值，非時序）
    """
    df_price = pd.DataFrame(prices).set_index("date")
    df_price.index = pd.to_datetime(df_price.index)
    df_price = df_price.sort_index()

    for col in ["close", "high", "low", "open", "volume", "adj_close"]:
        if col in df_price.columns:
            df_price[col] = pd.to_numeric(df_price[col], errors="coerce")

    df = df_price.copy()

    # adj_close fallback：若無調整後收盤價則沿用 close
    if "adj_close" not in df.columns:
        df["adj_close"] = df["close"]

    # ── 技術指標特徵 ──────────────────────────────────────────────────────────
    if indicators:
        df_ind = pd.DataFrame(indicators).set_index("date")
        df_ind.index = pd.to_datetime(df_ind.index)
        for col in df_ind.columns:
            df_ind[col] = pd.to_numeric(df_ind[col], errors="coerce")
        df = df.join(df_ind, how="left")

    # ── 籌碼面特徵（台股獨特優勢）────────────────────────────────────────────
    if chips:
        df_chip = pd.DataFrame(chips).set_index("date")
        df_chip.index = pd.to_datetime(df_chip.index)
        for col in ["foreign_net", "trust_net", "dealer_net"]:
            if col in df_chip.columns:
                df_chip[col] = pd.to_numeric(df_chip[col], errors="coerce")
        df = df.join(df_chip[["foreign_net", "trust_net", "dealer_net"]], how="left")

        df["institutional_net"] = (
            df.get("foreign_net", 0).fillna(0)
            + df.get("trust_net", 0).fillna(0)
            + df.get("dealer_net", 0).fillna(0)
        )
        df["chip_5d"]    = df["institutional_net"].rolling(5).sum()
        df["foreign_5d"] = df.get("foreign_net", pd.Series(0, index=df.index)).rolling(5).sum()

    # ── 情感分數特徵 ──────────────────────────────────────────────────────────
    if sentiment_scores:
        df_sent = pd.DataFrame(sentiment_scores).set_index("date")
        df_sent.index = pd.to_datetime(df_sent.index)
        df_sent["score"] = pd.to_numeric(df_sent["score"], errors="coerce")
        df = df.join(df_sent[["score"]].rename(columns={"score": "sentiment"}), how="left")
        # #8 Sentiment NaN：先延續上次情緒（ffill），僅初始無歷史時才填 0
        df["sentiment"]    = df["sentiment"].ffill().fillna(0)
        df["sentiment_3d"] = df["sentiment"].rolling(3).mean()

    # ── 衍生價格特徵 ──────────────────────────────────────────────────────────
    close = df["close"]
    # #2 adj_close：用除權息調整後收盤價計算 return，防止除息日假跌訊號
    adj = df["adj_close"]
    df["return_1d"]  = adj.pct_change(1)
    df["return_3d"]  = adj.pct_change(3)
    df["return_5d"]  = adj.pct_change(5)
    df["return_10d"] = adj.pct_change(10)

    df["volatility_5d"]  = df["return_1d"].rolling(5).std()
    df["volatility_20d"] = df["return_1d"].rolling(20).std()

    if "bb_upper" in df.columns and "bb_lower" in df.columns:
        bb_range = df["bb_upper"] - df["bb_lower"]
        df["bb_position"] = (close - df["bb_lower"]) / bb_range.replace(0, np.nan)

    if "volume" in df.columns:
        df["vol_ratio_5d"]  = df["volume"] / df["volume"].rolling(5).mean()
        df["vol_ratio_20d"] = df["volume"] / df["volume"].rolling(20).mean()
        # #9 Volume spike clip：極端成交量比值裁剪，防止離群值干擾模型
        df["vol_ratio_5d"]  = df["vol_ratio_5d"].clip(0.1, 10)
        df["vol_ratio_20d"] = df["vol_ratio_20d"].clip(0.1, 10)

    if "ma20" in df.columns:
        df["ma20_bias"] = (close - df["ma20"]) / df["ma20"]
    if "ma60" in df.columns:
        df["ma60_bias"] = (close - df["ma60"]) / df["ma60"]

    # ── 大盤環境特徵（時序對齊版，修復 Data Leakage）────────────────────────
    # 修復前問題：用「今天的市況值」廣播到所有 2 年前的訓練樣本
    #             → 製造假相關：模型學到「2023 年的交易在 2025 年高風險時期不準」
    # 修復後做法：
    #   1. 若有 market_history（time-series dict: {date: {risk_score, risk_level, ...}}）→ 逐日 JOIN
    #   2. 若只有 market_env（單點當前值）→ 只填最後 N 天（推論期合理），訓練期補 neutral
    #   3. 完全沒有 → 全部中性值
    risk_map = {"low": 0.0, "medium": 0.5, "high": 1.0, "extreme": 1.5}

    market_history: dict = market_env.get("history", {}) if market_env else {}

    if market_history:
        # 最佳路徑：每天有自己的市況（來自 D1 market_risk 表歷史）
        mh_df = pd.DataFrame.from_dict(market_history, orient="index")
        mh_df.index = pd.to_datetime(mh_df.index)
        mh_df = mh_df.sort_index()
        if "risk_score" in mh_df.columns:
            mh_df["market_risk_score"] = mh_df["risk_score"].astype(float) / 100.0
        if "risk_level" in mh_df.columns:
            mh_df["market_risk_level"] = mh_df["risk_level"].map(risk_map).fillna(0.5)
        for col in ["market_return_1d", "market_return_5d", "market_bias_20d"]:
            if col in mh_df.columns:
                mh_df[col] = mh_df[col].astype(float)
        df = df.join(mh_df[["market_risk_score", "market_risk_level",
                              "market_return_1d", "market_return_5d",
                              "market_bias_20d"]], how="left")
        # 無歷史市況的日期補中性值（不用當日值污染）
        df["market_risk_score"]  = df["market_risk_score"].fillna(0.5)
        df["market_risk_level"]  = df["market_risk_level"].fillna(0.5)
        df["market_return_1d"]   = df["market_return_1d"].fillna(0.0)
        df["market_return_5d"]   = df["market_return_5d"].fillna(0.0)
        df["market_bias_20d"]    = df["market_bias_20d"].fillna(0.0)
    elif market_env:
        # 降級路徑：只有今日市況 → 訓練期補中性，只有最後 30 天用真實值
        # 這樣避免污染歷史訓練樣本，同時讓推論期的當前市況仍能被使用
        neutral_score = 0.5
        neutral_level = 0.5
        risk_score_now = float(market_env.get("risk_score") or 50) / 100.0
        risk_level_now = risk_map.get(str(market_env.get("risk_level") or "medium").lower(), 0.5)
        twii_1d = float(market_env.get("twii_return_1d") or 0)
        twii_5d = float(market_env.get("twii_return_5d") or 0)
        twii_bias = float(market_env.get("twii_bias_20d") or 0)

        df["market_risk_score"] = neutral_score
        df["market_risk_level"] = neutral_level
        df["market_return_1d"]  = 0.0
        df["market_return_5d"]  = 0.0
        df["market_bias_20d"]   = 0.0
        # 只有最後 30 天填真實市況（推論期 + 最近訓練期是合理的）
        df.iloc[-30:, df.columns.get_loc("market_risk_score")] = risk_score_now
        df.iloc[-30:, df.columns.get_loc("market_risk_level")] = risk_level_now
        df.iloc[-30:, df.columns.get_loc("market_return_1d")]  = twii_1d
        df.iloc[-30:, df.columns.get_loc("market_return_5d")]  = twii_5d
        df.iloc[-30:, df.columns.get_loc("market_bias_20d")]   = twii_bias
    else:
        df["market_risk_score"]  = 0.5
        df["market_risk_level"]  = 0.5
        df["market_return_1d"]   = 0.0
        df["market_return_5d"]   = 0.0
        df["market_bias_20d"]    = 0.0

    # stock_vs_market：用個股 vs 大盤的相對強弱（時序計算，無 leakage）
    twii_5d_series = df["market_return_5d"] if "market_return_5d" in df.columns else pd.Series(0.0, index=df.index)
    stock_5d_series = close.pct_change(5)
    df["stock_vs_market"] = stock_5d_series / twii_5d_series.abs().replace(0, np.nan)
    df["stock_vs_market"] = df["stock_vs_market"].fillna(0.0).clip(-5, 5)

    # ── #6 CatBoost 滯後特徵（input diversity）────────────────────────────────
    for lag_col in ["rsi14", "macdHist", "vol_ratio_5d"]:
        if lag_col in df.columns:
            df[f"{lag_col}_lag1"] = df[lag_col].shift(1)
            df[f"{lag_col}_lag3"] = df[lag_col].shift(3)
    if "chip_5d" in df.columns:
        df["chip_5d_lag1"] = df["chip_5d"].shift(1)

    # ── #1 Fix: ffill 只作用於 feature columns，不汙染 target ──────────────
    # 舊版 bug: df.ffill().fillna(0) 會把 target_dir 的 NaN 覆蓋為 0（下跌）
    # 新版: 先 fill features，再計算 targets，NaN 留給 get_features().dropna() 排除
    target_cols = ["target_5d", "target_dir"]
    non_target = df.columns.difference(target_cols, sort=False)
    df[non_target] = df[non_target].ffill().fillna(0)

    # ── 目標變數（必須在 ffill 之後，確保 close 已填補）─────────────────────
    df["target_5d"]  = close.shift(-5) / close - 1

    # ── Triple Barrier Label (Prado 2018) ─────────────────────────────────────
    # 取代舊版固定 5 日方向 + dead zone，改用動態停利/停損邊界
    # 1=觸及停利（賺）, 0=觸及停損（虧）, NaN=到期或資料不足 → dropna 排除
    if "atr14" in df.columns:
        atr_series = df["atr14"]
    else:
        # fallback: 用 14 日 ATR 近似（不精確但可用）
        tr = pd.concat([
            df["high"] - df["low"],
            (df["high"] - close.shift(1)).abs(),
            (df["low"] - close.shift(1)).abs(),
        ], axis=1).max(axis=1)
        atr_series = tr.rolling(14).mean()

    df["target_dir"] = compute_triple_barrier_labels(
        close=close,
        high=df["high"] if "high" in df.columns else close,
        low=df["low"] if "low" in df.columns else close,
        atr14=atr_series,
        upper_atr_mult=3.0,   # 停利 = ATR×3
        lower_atr_mult=2.0,   # 停損 = ATR×2
        upper_pct_cap=0.07,   # 最多 +7%
        lower_pct_cap=0.03,   # 最多 -3%
        max_days=20,
    )

    return df


# 大盤環境特徵新增 6 個
FEATURE_COLS = [
    # 價格動量
    "return_1d", "return_3d", "return_5d", "return_10d",
    # 波動率
    "volatility_5d", "volatility_20d",
    # 技術指標
    "rsi14", "macdHist", "bb_position",
    # 成交量
    "vol_ratio_5d", "vol_ratio_20d",
    # 均線
    "ma20_bias", "ma60_bias",
    # 籌碼
    "institutional_net", "chip_5d", "foreign_5d",
    # 情感
    "sentiment", "sentiment_3d",
    # 波動
    "atr14",
    # ── 大盤環境特徵（新增）──────────────────────────────────────────────────
    "market_risk_score",   # 系統性風險程度 0~1
    "market_risk_level",   # 風險等級數值化
    "market_return_1d",    # 大盤昨日漲跌
    "market_return_5d",    # 大盤近 5 日漲跌
    "market_bias_20d",     # 大盤 20 日乖離率（過熱/過冷指標）
    "stock_vs_market",     # 個股相對大盤強弱
    # ── 台指期夜盤特徵（07:15 re-predict 可用，15:30 填 0）──────────────────
    "taifex_night_change_pct",  # 夜盤漲跌幅 %
    "taifex_night_range_pct",   # 夜盤振幅 %
    "taifex_night_available",   # 0=無資料(15:30) / 1=有資料(07:15)
    # ── 五檔報價特徵（盤中 intraday-check 可用，盤前/盤後填 0）─────────────
    "orderbook_imbalance",      # bid-ask imbalance -1~+1（正=買強）
    "orderbook_spread_pct",     # 內外盤 spread %（越大流動性越差）
    "orderbook_available",      # 0=無資料 / 1=有資料
]


def get_features(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """取得可用的特徵欄位，回傳 (X, y, feature_names)"""
    available = [c for c in FEATURE_COLS if c in df.columns]
    df_clean = df[available + ["target_5d", "target_dir"]].dropna()

    X = df_clean[available].values
    y = df_clean["target_dir"].values
    return X, y, available


# ── 夜盤特徵 Training Masking ──────────────────────────────────────────────
# 50% 的 training samples 隨機 mask 夜盤特徵 → 模型學會「有就用，沒有靠其他 features」
NIGHT_SESSION_COLS = ["taifex_night_change_pct", "taifex_night_range_pct", "taifex_night_available"]
ORDERBOOK_COLS = ["orderbook_imbalance", "orderbook_spread_pct", "orderbook_available"]
# 所有 optional features（training 時需要 masking）
OPTIONAL_FEATURE_COLS = NIGHT_SESSION_COLS + ORDERBOOK_COLS

def mask_night_session_features(
    X: np.ndarray,
    feature_names: list[str],
    mask_ratio: float = 0.5,
    seed: int = 42,
) -> np.ndarray:
    """Training 時隨機 mask 夜盤特徵（模擬 15:30 無夜盤資料的情況）"""
    night_indices = [i for i, name in enumerate(feature_names) if name in OPTIONAL_FEATURE_COLS]
    if not night_indices:
        return X  # 沒有夜盤欄位，不做任何事

    X_masked = X.copy()
    rng = np.random.RandomState(seed)
    mask = rng.random(len(X_masked)) < mask_ratio
    for idx in night_indices:
        X_masked[mask, idx] = 0.0
    masked_count = mask.sum()
    print(f"[NightMask] Masked {masked_count}/{len(X)} samples ({mask_ratio*100:.0f}%) for night session features")
    return X_masked


# ── #6 CatBoost 滯後特徵（input diversity）─────────────────────────────────
CATBOOST_EXTRA_COLS = [
    "rsi14_lag1", "rsi14_lag3",
    "macdHist_lag1", "macdHist_lag3",
    "vol_ratio_5d_lag1", "vol_ratio_5d_lag3",
    "chip_5d_lag1",
]


def get_catboost_features(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """CatBoost 專用：原始特徵 + 滯後特徵 (~32 維)"""
    base = [c for c in FEATURE_COLS if c in df.columns]
    extra = [c for c in CATBOOST_EXTRA_COLS if c in df.columns]
    all_cols = base + extra
    df_clean = df[all_cols + ["target_5d", "target_dir"]].dropna()

    X = df_clean[all_cols].values
    y = df_clean["target_dir"].values
    return X, y, all_cols


def get_lgbm_features(X: np.ndarray) -> np.ndarray:
    """LightGBM 專用：rank transform（每欄轉為百分位排名）"""
    from scipy.stats import rankdata
    return np.apply_along_axis(lambda col: rankdata(col) / len(col), axis=0, arr=X)


# ── Z-score / Robust Scaling（DLinear, PatchTST, FT-Transformer, KalmanFilter 等 scale-sensitive 模型用）──

_robust_scaler_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}  # {stock_id: (median, iqr)}


def fit_robust_scaler(X: np.ndarray, stock_id: str = "default") -> tuple[np.ndarray, np.ndarray]:
    """
    RobustScaler：用 median 和 IQR 做標準化，比 StandardScaler 抗離群值。
    Tree models 不需要（scale-invariant），只用於 DLinear/PatchTST/FT-Transformer/KalmanFilter。
    """
    median = np.median(X, axis=0)
    q75 = np.percentile(X, 75, axis=0)
    q25 = np.percentile(X, 25, axis=0)
    iqr = q75 - q25
    iqr[iqr < 1e-8] = 1.0  # 避免除以零
    _robust_scaler_cache[stock_id] = (median, iqr)
    return median, iqr


def apply_robust_scaler(X: np.ndarray, stock_id: str = "default",
                        median: Optional[np.ndarray] = None,
                        iqr: Optional[np.ndarray] = None) -> np.ndarray:
    """
    對 X 做 RobustScaler 轉換。若未提供 median/iqr，從 cache 取。
    回傳標準化後的 X（原始 X 不被修改）。
    """
    if median is None or iqr is None:
        cached = _robust_scaler_cache.get(stock_id)
        if cached is None:
            # 沒有 cache → 直接 fit on current data（inference 時的 fallback）
            median, iqr = fit_robust_scaler(X, stock_id)
        else:
            median, iqr = cached
    return (X - median) / iqr


    pass  # get_scaled_features removed — scaling done inline in main.py
