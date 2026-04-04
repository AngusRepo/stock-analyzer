"""
features/__init__.py — 特徵工程
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
        # 動態邊界 + 百分比封頂
        upper_barrier = price + min(atr * upper_atr_mult, price * upper_pct_cap)
        lower_barrier = price - min(atr * lower_atr_mult, price * lower_pct_cap)

        end_idx = min(i + max_days, n - 1)
        if end_idx <= i:
            continue

        # 掃描未來 max_days 內的 high/low，找第一個觸碰的邊界
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
                break
            elif hit_upper:
                labels.iloc[i] = 1.0
                break
            elif hit_lower:
                labels.iloc[i] = 0.0
                break

        # 未觸碰任一邊界 → NaN（到期平倉，dropna 時排除）

    return labels


def build_feature_matrix(
    prices: list[dict],
    indicators: list[dict],
    chips: list[dict],
    sentiment_scores: list[dict],
    market_env: dict | None = None,
    barrier_params: dict | None = None,
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
        # #8 Sentiment 清洗：ffill 最多 5 天延續上次情緒
        # has_sentiment: 讓模型區分「無情緒資料」vs「情緒中性(0)」
        df["sentiment"]     = df["sentiment"].ffill(limit=5)
        df["has_sentiment"] = df["sentiment"].notna().astype(float)
        df["sentiment"]     = df["sentiment"].fillna(0)  # 最後才填 0，模型靠 has_sentiment 區分
        df["sentiment_3d"]  = df["sentiment"].rolling(3, min_periods=1).mean()
    else:
        df["sentiment"]     = 0.0
        df["has_sentiment"] = 0.0
        df["sentiment_3d"]  = 0.0

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
        vol_ma5  = df["volume"].rolling(5).mean().replace(0, np.nan)
        vol_ma20 = df["volume"].rolling(20).mean().replace(0, np.nan)
        df["vol_ratio_5d"]  = (df["volume"] / vol_ma5).replace([np.inf, -np.inf], np.nan).clip(0.1, 10)
        df["vol_ratio_20d"] = (df["volume"] / vol_ma20).replace([np.inf, -np.inf], np.nan).clip(0.1, 10)

    if "ma20" in df.columns:
        df["ma20_bias"] = ((close - df["ma20"]) / df["ma20"].replace(0, np.nan)).replace([np.inf, -np.inf], np.nan)
    if "ma60" in df.columns:
        df["ma60_bias"] = ((close - df["ma60"]) / df["ma60"].replace(0, np.nan)).replace([np.inf, -np.inf], np.nan)

    # ── 大盤環境特徵（時序對齊版，修復 Data Leakage）────────────────────────
    risk_map = {"low": 0.0, "medium": 0.5, "high": 1.0, "extreme": 1.5}

    market_history: dict = market_env.get("history", {}) if market_env else {}

    if market_history:
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
        # 只 join 實際存在的欄位（Worker 可能未傳 market_return_1d/5d）
        join_cols = [c for c in ["market_risk_score", "market_risk_level",
                                  "market_return_1d", "market_return_5d",
                                  "market_bias_20d"] if c in mh_df.columns]
        if join_cols:
            df = df.join(mh_df[join_cols], how="left")
        # 缺失的欄位補中性值
        df["market_risk_score"]  = df.get("market_risk_score", pd.Series(0.5, index=df.index)).fillna(0.5)
        df["market_risk_level"]  = df.get("market_risk_level", pd.Series(0.5, index=df.index)).fillna(0.5)
        df["market_return_1d"]   = df.get("market_return_1d", pd.Series(0.0, index=df.index)).fillna(0.0)
        df["market_return_5d"]   = df.get("market_return_5d", pd.Series(0.0, index=df.index)).fillna(0.0)
        df["market_bias_20d"]    = df.get("market_bias_20d", pd.Series(0.0, index=df.index)).fillna(0.0)
    elif market_env:
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

    # ── FinLab 策略因子（Phase 6: 價格意圖 + RSI 鈍化 + 肯特納通道）──────────

    # ① 價格意圖因子 (LinearFactor)
    # = 60日報酬 / 60日每日|報酬|總和 / 60日均量
    # 本質：risk-adjusted momentum per unit volume — 穩定上漲+放量 = 高分
    if "volume" in df.columns:
        ret_60d = adj.pct_change(60)
        abs_ret_sum_60d = df["return_1d"].abs().rolling(60).sum()
        vol_avg_60d = df["volume"].rolling(60).mean()
        raw_intent = ret_60d / abs_ret_sum_60d.replace(0, np.nan) / vol_avg_60d.replace(0, np.nan)
        # 標準化到合理範圍（原始值極小），rank-based normalize
        df["linear_factor"] = raw_intent.rank(pct=True).fillna(0.5)
    else:
        df["linear_factor"] = 0.5

    # ② RSI 鈍化 (RSI Dulling)
    # RSI(5) > 80 連續 N 天 → 強勢動量信號（FinLab 發現比黃金交叉更有效）
    if "close" in df.columns:
        # 計算 RSI(5)
        delta_5 = close.diff()
        gain_5 = delta_5.clip(lower=0).rolling(5).mean()
        loss_5 = (-delta_5.clip(upper=0)).rolling(5).mean()
        rs_5 = gain_5 / loss_5.replace(0, np.nan)
        rsi_5 = 100 - 100 / (1 + rs_5)
        rsi_5 = rsi_5.fillna(50)
        # 連續 > 80 的天數
        above_80 = (rsi_5 > 80).astype(int)
        consec_above_80 = above_80.groupby((above_80 != above_80.shift()).cumsum()).cumsum()
        df["rsi5_dulling"] = consec_above_80.clip(0, 10) / 10.0  # 歸一化到 [0, 1]
    else:
        df["rsi5_dulling"] = 0.0

    # ③ 肯特納通道位置 (Keltner Channel Position)
    # = (close - EMA20) / (1.5 * ATR14)
    # > 1 = 突破上軌（趨勢強勢），< -1 = 跌破下軌
    if "ma20" in df.columns and "atr14" in df.columns:
        atr_band = df["atr14"] * 1.5
        df["keltner_position"] = ((close - df["ma20"]) / atr_band.replace(0, np.nan)).fillna(0).clip(-3, 3)
    else:
        df["keltner_position"] = 0.0

    # ── Wave 2: 美股先行 + 大盤廣度 + 月營收（market_env 直傳）─────────────

    # 這些是 scalar 值（不隨日期變化，只有最新值），填入最後 30 日
    for wave2_col, default_val in [
        ("us_sox_return", 0.0), ("us_gspc_return", 0.0), ("us_dxy_return", 0.0),
        ("us_hy_spread", 3.5), ("us_hy_spread_chg", 0.0), ("us_vix", 20.0),
        ("advance_ratio", 0.5), ("bull_alignment_pct", 50.0), ("revenue_yoy", 0.0),
    ]:
        val = float(market_env.get(wave2_col) or default_val) if market_env else default_val
        df[wave2_col] = default_val
        if len(df) >= 30:
            df.iloc[-30:, df.columns.get_loc(wave2_col)] = val
        else:
            df[wave2_col] = val

    # Wave 3: 融資融券 + 集保（per stock scalar）
    for w3_col, w3_default in [
        ("margin_balance", 0.0), ("short_ratio", 0.0),
        ("margin_change_5d", 0.0), ("retail_pct", 50.0),
    ]:
        val = float(market_env.get(w3_col) or w3_default) if market_env else w3_default
        df[w3_col] = w3_default
        if len(df) >= 30:
            df.iloc[-30:, df.columns.get_loc(w3_col)] = val
        else:
            df[w3_col] = val

    # us_sentiment 數值化：bullish=1, neutral=0, bearish=-1
    us_sent_map = {"bullish": 1.0, "neutral": 0.0, "bearish": -1.0}
    us_sent_val = us_sent_map.get(str(market_env.get("us_sentiment") or "neutral"), 0.0) if market_env else 0.0
    df["us_sentiment_score"] = 0.0
    if len(df) >= 30:
        df.iloc[-30:, df.columns.get_loc("us_sentiment_score")] = us_sent_val
    else:
        df["us_sentiment_score"] = us_sent_val

    # ── #6 CatBoost 滯後特徵（input diversity）────────────────────────────────
    for lag_col in ["rsi14", "macdHist", "vol_ratio_5d"]:
        if lag_col in df.columns:
            df[f"{lag_col}_lag1"] = df[lag_col].shift(1)
            df[f"{lag_col}_lag3"] = df[lag_col].shift(3)
    if "chip_5d" in df.columns:
        df["chip_5d_lag1"] = df["chip_5d"].shift(1)

    # ── Rolling Z-score normalization（在 ffill 之前，用 raw data 計算）─────
    # 消除 regime 偏差：牛市/熊市的 feature 分佈不同，用 rolling 60d 標準化
    # 必須在 ffill 之前做，避免 forward-fill 的重複值污染 rolling mean/std
    ZSCORE_COLS = [
        "return_1d", "return_3d", "return_5d", "return_10d",
        "volatility_5d", "volatility_20d",
        "vol_ratio_5d", "vol_ratio_20d",
        "institutional_net", "chip_5d", "foreign_5d",
        "ma20_bias", "ma60_bias",
    ]
    for col in ZSCORE_COLS:
        if col in df.columns:
            roll_mean = df[col].rolling(60, min_periods=20).mean()
            roll_std  = df[col].rolling(60, min_periods=20).std().clip(lower=1e-8)
            df[col] = ((df[col] - roll_mean) / roll_std).clip(-5, 5)
            # NaN 由下面的 ffill 處理，不在這裡 fillna

    # ── #1 Fix: ffill 只作用於 feature columns，不汙染 target ──────────────
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
        # fallback: 用 14 日 ATR 近似
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
        upper_atr_mult=barrier_params.get("upper_mult", 3.0) if barrier_params else 3.0,
        lower_atr_mult=barrier_params.get("lower_mult", 2.0) if barrier_params else 2.0,
        upper_pct_cap=barrier_params.get("upper_pct_cap", 0.07) if barrier_params else 0.07,
        lower_pct_cap=barrier_params.get("lower_pct_cap", 0.03) if barrier_params else 0.03,
        max_days=barrier_params.get("max_days", 20) if barrier_params else 20,
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
    "sentiment", "sentiment_3d", "has_sentiment",
    # 波動
    "atr14",
    # ── 大盤環境特徵 ──────────────────────────────────────────────────────────
    "market_risk_score",   # 系統性風險程度 0~1
    "market_risk_level",   # 風險等級數值化
    "market_return_1d",    # 大盤昨日漲跌
    "market_return_5d",    # 大盤近 5 日漲跌
    "market_bias_20d",     # 大盤 20 日乖離率（過熱/過冷指標）
    "stock_vs_market",     # 個股相對大盤強弱
    # ── Phase 5: 主力波動指標 ─────────────────────────────────────────────────
    # "broker_vol_index",  # TODO: 需串接 FinMind broker order flow API，目前無資料源，暫時停用
    # ── Phase 6: FinLab 策略因子 ─────────────────────────────────────────────
    "linear_factor",       # 價格意圖因子（risk-adjusted momentum / volume）
    "rsi5_dulling",        # RSI(5) 鈍化天數（連續 >80 的歸一化天數）
    "keltner_position",    # 肯特納通道位置（突破上軌 >1 = 強勢）
    # ── Wave 2: 美股先行 + 大盤廣度 + 月營收 ──────────────────────────────────
    "us_sox_return",       # 費半前日漲跌 %
    "us_gspc_return",      # S&P 500 前日漲跌 %
    "us_dxy_return",       # 美元指數日變化 %
    "us_hy_spread",        # HY 信用利差 (bps)
    "us_hy_spread_chg",    # HY 利差日變化
    "us_vix",              # VIX 收盤
    "us_sentiment_score",  # 美股綜合情緒 (-1/0/+1)
    "advance_ratio",       # 台股上漲家數比
    "bull_alignment_pct",  # 多頭排列比例 %
    "revenue_yoy",         # 月營收年增率 %
    # ── Wave 3: 融資融券 + 集保 ──────────────────────────────────────────────
    "margin_balance",      # 融資餘額（張）
    "short_ratio",         # 券資比（融券/融資）
    "margin_change_5d",    # 融資 5 日增減率
    "retail_pct",          # 散戶持股占比 %（<50張）
]


def get_features(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """取得可用的特徵欄位，回傳 (X, y, feature_names)"""
    available = [c for c in FEATURE_COLS if c in df.columns]
    df_clean = df[available + ["target_5d", "target_dir"]].dropna()

    X = df_clean[available].values
    y = df_clean["target_dir"].values
    return X, y, available


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


# ── RobustScaler（DLinear/PatchTST/FT-Transformer 需要）──────────────────────
_robust_scaler_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}


def fit_robust_scaler(X: np.ndarray, stock_id: str = "default") -> tuple[np.ndarray, np.ndarray]:
    """RobustScaler：用 median 和 IQR 做標準化，比 StandardScaler 抗離群值。"""
    median = np.median(X, axis=0)
    q75 = np.percentile(X, 75, axis=0)
    q25 = np.percentile(X, 25, axis=0)
    iqr = q75 - q25
    iqr[iqr < 1e-8] = 1.0
    _robust_scaler_cache[stock_id] = (median, iqr)
    return median, iqr


def apply_robust_scaler(X: np.ndarray, stock_id: str = "default",
                        median: Optional[np.ndarray] = None,
                        iqr: Optional[np.ndarray] = None) -> np.ndarray:
    """對 X 做 RobustScaler 轉換。若未提供 median/iqr，從 cache 取。"""
    if median is None or iqr is None:
        cached = _robust_scaler_cache.get(stock_id)
        if cached is None:
            median, iqr = fit_robust_scaler(X, stock_id)
        else:
            median, iqr = cached
    return (X - median) / iqr
