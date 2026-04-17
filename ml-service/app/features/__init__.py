"""
features/__init__.py — 特徵工程 (StockVision 2.0)

零 Pandas 原則：全面使用 Polars → NumPy 直接對接。
Triple Barrier Label (Prado 2018) 保留作為 SLTP 執行層使用。
2.0 新增：Cross-sectional rank label 在 P1 實作。
"""
import os
import numpy as np
import polars as pl
from typing import Optional

# ── Thread 控制（避免與 NumPy/torch 搶 CPU）──────────────────────────────────
# Modal container CPU 配置：prep=1 CPU, train=L4 GPU (~4 CPU), selection=L4 (~4 CPU)
# 策略：Polars 和 NumPy 各拿一半 CPU，避免超訂
_cpu_count = os.cpu_count() or 2
_threads_per_lib = max(1, _cpu_count // 2)
os.environ.setdefault("POLARS_MAX_THREADS", str(_threads_per_lib))
os.environ.setdefault("OMP_NUM_THREADS", str(_threads_per_lib))
os.environ.setdefault("MKL_NUM_THREADS", str(_threads_per_lib))


# ── Triple Barrier Label (Prado 2018) ────────────────────────────────────────
def compute_triple_barrier_labels(
    close: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    atr14: np.ndarray,
    upper_atr_mult: float = 3.0,
    lower_atr_mult: float = 2.0,
    upper_pct_cap: float = 0.07,
    lower_pct_cap: float = 0.03,
    max_days: int = 20,
) -> np.ndarray:
    """
    三重屏障標籤（純 NumPy 版）：
      1 = 先觸及上界（停利）→ 賺錢交易
      0 = 先觸及下界（停損）→ 虧錢交易
      NaN = 到期平倉或資料不足

    Input 必須是 np.ndarray（零 Pandas 原則）。
    """
    n = len(close)
    labels = np.full(n, np.nan, dtype=np.float64)

    for i in range(n - 1):
        price = close[i]
        if np.isnan(price) or price <= 0:
            continue

        atr = atr14[i] if not np.isnan(atr14[i]) else price * 0.02
        upper_barrier = price + min(atr * upper_atr_mult, price * upper_pct_cap)
        lower_barrier = price - min(atr * lower_atr_mult, price * lower_pct_cap)

        end_idx = min(i + max_days, n - 1)
        if end_idx <= i:
            continue

        for j in range(i + 1, end_idx + 1):
            h = high[j]
            lo = low[j]
            if np.isnan(h) or np.isnan(lo):
                continue
            hit_upper = h >= upper_barrier
            hit_lower = lo <= lower_barrier
            if hit_upper and hit_lower:
                c_j = close[j] if not np.isnan(close[j]) else price
                labels[i] = 1.0 if c_j >= price else 0.0
                break
            elif hit_upper:
                labels[i] = 1.0
                break
            elif hit_lower:
                labels[i] = 0.0
                break

    return labels


# ── Helper: safe division ────────────────────────────────────────────────────
def _safe_div(num: pl.Expr, den: pl.Expr, default: float = 0.0) -> pl.Expr:
    """Safe division: replace inf/NaN with default."""
    return (
        pl.when(den != 0)
        .then(num / den)
        .otherwise(pl.lit(default))
        .fill_nan(default)
        .fill_null(default)
    )


# ── Cross-sectional Rank Label (2.0) ─────────────────────────────────────────
def compute_cross_sectional_rank(
    pooled: pl.DataFrame,
    return_col: str = "target_5d",
    date_col: str = "_date",
) -> pl.DataFrame:
    """
    Cross-sectional rank label: 每天所有股票的 forward return 排名 → 0~1 percentile。

    為什麼用 rank 不用 binary:
      - Binary label 在牛市 70% 標 UP，model 學的是「市場漲」不是「誰比較強」
      - Rank 每天都有 0~1 分佈，消除 beta，model 學的是「相對強度」
      - IC 0.03 vs 0.05 可區分好壞，accuracy 0.51 vs 0.54 看不出差異

    參數:
      pooled: 已 concat 所有股票的 Polars DataFrame（需含 return_col + date_col）
      return_col: 用來排名的欄位（default: target_5d = 未來 5 日報酬率）
      date_col: 日期欄位（default: _date）

    回傳:
      新增 target_rank 欄位的 DataFrame（0 = 當日最弱，1 = 當日最強）
    """
    if return_col not in pooled.columns or date_col not in pooled.columns:
        # Fallback: 無法 rank，填 0.5（中性）
        return pooled.with_columns(pl.lit(0.5).alias("target_rank"))

    # per-date rank: 同一天的所有股票排名 → 除以當天總數 → [0, 1]
    return pooled.with_columns(
        pl.col(return_col)
        .rank(method="average")
        .over(date_col)
        .truediv(
            pl.col(return_col).count().over(date_col)
        )
        .alias("target_rank")
    )


def _clip_expr(expr: pl.Expr, lo: float, hi: float) -> pl.Expr:
    """Clip expression to [lo, hi]."""
    return expr.clip(lo, hi)


# ── Trend Quality (pure NumPy, reused across timeframes) ─────────────────────
def _trend_quality(arr: np.ndarray) -> tuple[float, float, float]:
    """Return (slope/mean, r2, residual/mean) for a price array."""
    n = len(arr)
    x = np.arange(n, dtype=np.float64)
    y = arr.astype(np.float64)
    mean_y = y.mean()
    if mean_y == 0 or np.isnan(mean_y):
        return 0.0, 0.0, 0.0
    x_mean = x.mean()
    ss_xy = ((x - x_mean) * (y - mean_y)).sum()
    ss_xx = ((x - x_mean) ** 2).sum()
    if ss_xx == 0:
        return 0.0, 0.0, 0.0
    slope = ss_xy / ss_xx
    intercept = mean_y - slope * x_mean
    y_pred = slope * x + intercept
    ss_res = ((y - y_pred) ** 2).sum()
    ss_tot = ((y - mean_y) ** 2).sum()
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    residual = (y[-1] - y_pred[-1]) / mean_y
    return slope / mean_y, r2, residual


def _compute_trend_arrays(close_vals: np.ndarray, window: int, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute BETA/RSQR/RESI arrays for a given window."""
    beta = np.zeros(n, dtype=np.float64)
    rsqr = np.zeros(n, dtype=np.float64)
    resi = np.zeros(n, dtype=np.float64)
    for i in range(window - 1, n):
        b, r2, res = _trend_quality(close_vals[i - window + 1: i + 1])
        beta[i] = b
        rsqr[i] = r2
        resi[i] = res
    return (
        np.clip(beta, -0.1, 0.1),
        np.clip(rsqr, 0, 1),
        np.clip(resi, -0.2, 0.2),
    )


def _imax_imin_numpy(high_vals: np.ndarray, low_vals: np.ndarray, window: int, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Compute IMAX/IMIN (time-cycle extremes) via NumPy — Polars has no rolling argmax."""
    imax = np.full(n, 0.5, dtype=np.float64)
    imin = np.full(n, 0.5, dtype=np.float64)
    for i in range(window - 1, n):
        h_win = high_vals[i - window + 1: i + 1]
        l_win = low_vals[i - window + 1: i + 1]
        imax[i] = (window - 1 - np.argmax(h_win)) / window
        imin[i] = (window - 1 - np.argmin(l_win)) / window
    return imax, imin


# ══════════════════════════════════════════════════════════════════════════════
# build_feature_matrix — 核心特徵工程 (Polars 版)
# ══════════════════════════════════════════════════════════════════════════════
def build_feature_matrix(
    prices: list[dict],
    indicators: list[dict],
    chips: list[dict],
    sentiment_scores: list[dict],
    market_env: dict | None = None,
    barrier_params: dict | None = None,
    stock_meta: dict | None = None,
) -> pl.DataFrame:
    """
    整合所有資料來源，建立特徵矩陣。
    回傳 Polars DataFrame，含 features + target_5d + target_dir。
    """
    # ── 1. Prices base frame ─────────────────────────────────────────────────
    # infer_schema_length=None: D1 JSON 混 int/float（如 close=106 vs 105.5），需掃全量推斷
    df = (
        pl.DataFrame(prices, infer_schema_length=None)
        .with_columns(pl.col("date").cast(pl.Date))
        .sort("date")
    )
    num_cols = ["close", "high", "low", "open", "volume", "adj_close"]
    for col in num_cols:
        if col in df.columns:
            df = df.with_columns(pl.col(col).cast(pl.Float64, strict=False))

    if "adj_close" not in df.columns:
        df = df.with_columns(pl.col("close").alias("adj_close"))

    # ── 2. Technical indicators join ─────────────────────────────────────────
    if indicators:
        df_ind = (
            pl.DataFrame(indicators, infer_schema_length=None)
            .with_columns(pl.col("date").cast(pl.Date))
        )
        ind_num_cols = [c for c in df_ind.columns if c != "date"]
        for col in ind_num_cols:
            df_ind = df_ind.with_columns(pl.col(col).cast(pl.Float64, strict=False))
        df = df.join(df_ind, on="date", how="left", suffix="_ind")

    close = df["close"]
    high = df["high"] if "high" in df.columns else close
    low = df["low"] if "low" in df.columns else close

    # Fallback: 從 prices 計算缺失指標
    if "ma5" not in df.columns or df["ma5"].is_null().all():
        df = df.with_columns(pl.col("close").rolling_mean(5).alias("ma5"))
    if "ma10" not in df.columns or df["ma10"].is_null().all():
        df = df.with_columns(pl.col("close").rolling_mean(10).alias("ma10"))
    if "ma20" not in df.columns or df["ma20"].is_null().all():
        df = df.with_columns(pl.col("close").rolling_mean(20).alias("ma20"))
    if "ma60" not in df.columns or df["ma60"].is_null().all():
        df = df.with_columns(pl.col("close").rolling_mean(60).alias("ma60"))

    if "rsi14" not in df.columns or df["rsi14"].is_null().all():
        delta = pl.col("close").diff()
        gain = delta.clip(0, None).rolling_mean(14)
        loss = (-delta.clip(None, 0)).rolling_mean(14)
        df = df.with_columns(
            (pl.lit(100.0) - pl.lit(100.0) / (pl.lit(1.0) + _safe_div(gain, loss, 1.0)))
            .alias("rsi14")
        )

    if "macd_hist" not in df.columns or df["macd_hist"].is_null().all():
        df = df.with_columns([
            pl.col("close").ewm_mean(span=12, adjust=False).alias("_ema12"),
            pl.col("close").ewm_mean(span=26, adjust=False).alias("_ema26"),
        ])
        df = df.with_columns(
            (pl.col("_ema12") - pl.col("_ema26")).alias("macd")
        )
        df = df.with_columns(
            pl.col("macd").ewm_mean(span=9, adjust=False).alias("macd_signal")
        )
        df = df.with_columns(
            (pl.col("macd") - pl.col("macd_signal")).alias("macd_hist")
        )
        df = df.drop(["_ema12", "_ema26"])
    if "macdHist" not in df.columns and "macd_hist" in df.columns:
        df = df.with_columns(pl.col("macd_hist").alias("macdHist"))

    if "atr14" not in df.columns or df["atr14"].is_null().all():
        df = df.with_columns(
            pl.max_horizontal(
                pl.col("high") - pl.col("low"),
                (pl.col("high") - pl.col("close").shift(1)).abs(),
                (pl.col("low") - pl.col("close").shift(1)).abs(),
            ).rolling_mean(14).alias("atr14")
        )

    if "bb_upper" not in df.columns or df["bb_upper"].is_null().all():
        df = df.with_columns([
            pl.col("close").rolling_mean(20).alias("bb_mid"),
            pl.col("close").rolling_std(20).alias("_bb_std"),
        ])
        df = df.with_columns([
            (pl.col("bb_mid") + 2 * pl.col("_bb_std")).alias("bb_upper"),
            (pl.col("bb_mid") - 2 * pl.col("_bb_std")).alias("bb_lower"),
        ])
        df = df.drop("_bb_std")

    # ── 3. Chips features ────────────────────────────────────────────────────
    if chips:
        df_chip = (
            pl.DataFrame(chips, infer_schema_length=None)
            .with_columns(pl.col("date").cast(pl.Date))
        )
        chip_cols = ["foreign_net", "trust_net", "dealer_net", "margin_balance", "short_balance"]
        for col in chip_cols:
            if col in df_chip.columns:
                df_chip = df_chip.with_columns(pl.col(col).cast(pl.Float64, strict=False))
        avail_chip = [c for c in chip_cols if c in df_chip.columns]
        df = df.join(df_chip.select(["date"] + avail_chip), on="date", how="left", suffix="_chip")

        # institutional_net = foreign + trust + dealer
        fn = pl.col("foreign_net").fill_null(0.0) if "foreign_net" in df.columns else pl.lit(0.0)
        tn = pl.col("trust_net").fill_null(0.0) if "trust_net" in df.columns else pl.lit(0.0)
        dn = pl.col("dealer_net").fill_null(0.0) if "dealer_net" in df.columns else pl.lit(0.0)
        df = df.with_columns((fn + tn + dn).alias("institutional_net"))
        df = df.with_columns([
            pl.col("institutional_net").rolling_sum(5).alias("chip_5d"),
            (pl.col("foreign_net").fill_null(0.0) if "foreign_net" in df.columns else pl.lit(0.0))
            .rolling_sum(5).alias("foreign_5d"),
        ])

        # Tier 0: dealer features
        dealer = pl.col("dealer_net").fill_null(0.0) if "dealer_net" in df.columns else pl.lit(0.0)
        df = df.with_columns(dealer.rolling_sum(5).alias("dealer_5d"))
        df = df.with_columns(
            _clip_expr(
                _safe_div(pl.col("dealer_5d"), pl.col("chip_5d")),
                -5.0, 5.0
            ).alias("dealer_ratio_5d")
        )

        # margin_balance time-series features
        if "margin_balance" in df.columns:
            df = df.with_columns(pl.col("margin_balance").forward_fill().alias("margin_balance"))
            vol_close = pl.col("volume").fill_null(1.0) * pl.col("close").fill_null(1.0)
            df = df.with_columns(
                _clip_expr(_safe_div(pl.col("margin_balance"), vol_close), 0.0, 10.0)
                .alias("margin_ratio")
            )
            # NOTE: shift(5) assumes 5 consecutive rows = 5 trading days. If data has
            # gaps (holidays, trading halts), the actual calendar span may differ.
            # Accepted tradeoff: date-aware shift requires date join (complex + slow).
            # Models are trained on this definition, so changing it requires retrain.
            df = df.with_columns(
                _clip_expr(
                    _safe_div(
                        pl.col("margin_balance") - pl.col("margin_balance").shift(5),
                        pl.col("margin_balance").shift(5),
                    ),
                    -1.0, 1.0
                ).alias("margin_change_5d_ts")
            )

        if "short_balance" in df.columns:
            df = df.with_columns(pl.col("short_balance").forward_fill().alias("short_balance"))
            df = df.with_columns(
                _clip_expr(
                    _safe_div(
                        pl.col("short_balance") - pl.col("short_balance").shift(5),
                        pl.col("short_balance").shift(5),
                    ),
                    -1.0, 1.0
                ).alias("short_change_5d")
            )
            # short_squeeze_proxy
            ret_5d_expr = _safe_div(
                pl.col("close") - pl.col("close").shift(5),
                pl.col("close").shift(5),
            ).clip(0.0, None)
            short_incr = pl.when(pl.col("short_balance") > pl.col("short_balance").shift(5)).then(1.0).otherwise(0.0)
            df = df.with_columns((ret_5d_expr * short_incr).clip(0.0, 1.0).alias("short_squeeze_proxy"))

    # ── 4. Sentiment features ────────────────────────────────────────────────
    if sentiment_scores:
        df_sent = (
            pl.DataFrame(sentiment_scores, infer_schema_length=None)
            .with_columns([
                pl.col("date").cast(pl.Date),
                pl.col("score").cast(pl.Float64, strict=False).alias("sentiment"),
            ])
            .select(["date", "sentiment"])
        )
        df = df.join(df_sent, on="date", how="left", suffix="_sent")
        df = df.with_columns([
            pl.col("sentiment").forward_fill(limit=5).alias("sentiment"),
        ])
        df = df.with_columns([
            pl.col("sentiment").is_not_null().cast(pl.Float64).alias("has_sentiment"),
            pl.col("sentiment").fill_null(0.0).alias("sentiment"),
        ])
        df = df.with_columns(
            pl.col("sentiment").rolling_mean(3).fill_null(0.0).alias("sentiment_3d")
        )
    else:
        df = df.with_columns([
            pl.lit(0.0).alias("sentiment"),
            pl.lit(0.0).alias("has_sentiment"),
            pl.lit(0.0).alias("sentiment_3d"),
        ])

    # ── 5. VWAP features ────────────────────────────────────────────────────
    if "avg_price" in df.columns and df["avg_price"].cast(pl.Float64, strict=False).is_not_null().sum() > len(df) * 0.1:
        df = df.with_columns(pl.col("avg_price").cast(pl.Float64, strict=False).forward_fill().alias("_avg_p"))
    else:
        df = df.with_columns(
            ((pl.col("high").fill_null(pl.col("close")) + pl.col("low").fill_null(pl.col("close")) + pl.col("close")) / 3.0)
            .alias("_avg_p")
        )
    df = df.with_columns([
        _clip_expr(_safe_div(pl.col("close") - pl.col("_avg_p"), pl.col("_avg_p")), -0.5, 0.5).alias("vwap_bias"),
        pl.col("_avg_p").rolling_mean(5).alias("vwap_5d"),
    ])
    df = df.with_columns(
        _clip_expr(
            _safe_div(pl.col("close") - pl.col("vwap_5d"), pl.col("vwap_5d")),
            -0.5, 0.5
        ).alias("vwap_bias_5d")
    )
    df = df.drop("_avg_p")

    # ── 6. Derived price features ────────────────────────────────────────────
    adj = pl.col("adj_close")
    df = df.with_columns([
        _safe_div(adj - adj.shift(1), adj.shift(1)).alias("return_1d"),
        _safe_div(adj - adj.shift(3), adj.shift(3)).alias("return_3d"),
        _safe_div(adj - adj.shift(5), adj.shift(5)).alias("return_5d"),
        _safe_div(adj - adj.shift(10), adj.shift(10)).alias("return_10d"),
    ])
    df = df.with_columns([
        pl.col("return_1d").rolling_std(5).alias("volatility_5d"),
        pl.col("return_1d").rolling_std(20).alias("volatility_20d"),
    ])

    if "bb_upper" in df.columns and "bb_lower" in df.columns:
        bb_range = pl.col("bb_upper") - pl.col("bb_lower")
        df = df.with_columns(
            _safe_div(pl.col("close") - pl.col("bb_lower"), bb_range).alias("bb_position")
        )

    if "volume" in df.columns:
        df = df.with_columns([
            _clip_expr(
                _safe_div(pl.col("volume"), pl.col("volume").rolling_mean(5)),
                0.1, 10.0
            ).alias("vol_ratio_5d"),
            _clip_expr(
                _safe_div(pl.col("volume"), pl.col("volume").rolling_mean(20)),
                0.1, 10.0
            ).alias("vol_ratio_20d"),
        ])

    if "ma20" in df.columns:
        df = df.with_columns(
            _safe_div(pl.col("close") - pl.col("ma20"), pl.col("ma20")).alias("ma20_bias")
        )
    if "ma60" in df.columns:
        df = df.with_columns(
            _safe_div(pl.col("close") - pl.col("ma60"), pl.col("ma60")).alias("ma60_bias")
        )

    # Tier 0.5: raw bias
    if "ma5" in df.columns:
        df = df.with_columns(
            _safe_div(pl.col("close") - pl.col("ma5"), pl.col("ma5")).alias("ma5_bias")
        )
    if "ma10" in df.columns:
        df = df.with_columns(
            _safe_div(pl.col("close") - pl.col("ma10"), pl.col("ma10")).alias("ma10_bias")
        )
    if "bb_upper" in df.columns:
        df = df.with_columns(pl.col("bb_upper").alias("bb_upper_raw"))
    if "bb_lower" in df.columns:
        df = df.with_columns(pl.col("bb_lower").alias("bb_lower_raw"))

    # ── 7. Market env history join (Wave 1+2) ────────────────────────────────
    risk_map = {"low": 0.0, "medium": 0.5, "high": 1.0, "extreme": 1.5}
    market_history: dict = market_env.get("history", {}) if market_env else {}

    if market_history:
        mh_records = []
        for date_str, row in market_history.items():
            rec = {"date": date_str}
            rec["market_risk_score"] = float(row.get("risk_score", 50) or 50) / 100.0
            rec["market_risk_level"] = risk_map.get(str(row.get("risk_level", "medium")).lower(), 0.5)
            for col in ["market_return_1d", "market_return_5d", "market_bias_20d",
                        "foreign_consecutive_sell", "foreign_net_5d_market",
                        "limit_down_count", "limit_down_pct", "adl_value", "adl_trend_numeric",
                        "us_sox_return", "us_gspc_return", "us_dxy_return",
                        "us_hy_spread", "us_hy_spread_chg", "us_vix",
                        "us_sentiment_score", "advance_ratio", "bull_alignment_pct"]:
                rec[col] = float(row.get(col, 0) or 0)
            mh_records.append(rec)

        mh_df = (
            pl.DataFrame(mh_records, infer_schema_length=None)
            .with_columns(pl.col("date").cast(pl.Date))
            .sort("date")
        )
        # Only join columns that exist
        mh_join_cols = [c for c in mh_df.columns if c != "date" and c not in df.columns]
        if mh_join_cols:
            df = df.join(mh_df.select(["date"] + mh_join_cols), on="date", how="left")

    # Fill defaults for market env columns
    market_defaults = {
        "market_risk_score": 0.5, "market_risk_level": 0.5,
        "market_return_1d": 0.0, "market_return_5d": 0.0, "market_bias_20d": 0.0,
        "foreign_consecutive_sell": 0.0, "foreign_net_5d_market": 0.0,
        "limit_down_count": 0.0, "limit_down_pct": 0.0,
        "adl_value": 0.0, "adl_trend_numeric": 0.0,
    }
    for col, default in market_defaults.items():
        if col not in df.columns:
            df = df.with_columns(pl.lit(default).alias(col))
        else:
            df = df.with_columns(pl.col(col).fill_null(default))

    # stock_vs_market
    df = df.with_columns(
        _clip_expr(
            _safe_div(
                _safe_div(pl.col("adj_close") - pl.col("adj_close").shift(5), pl.col("adj_close").shift(5)),
                pl.col("market_return_5d").abs().clip(1e-8, None),
            ),
            -5.0, 5.0
        ).alias("stock_vs_market")
    )

    # ── 8. FinLab factors ────────────────────────────────────────────────────
    # linear_factor: risk-adjusted momentum / volume
    if "volume" in df.columns:
        ret_60d = _safe_div(pl.col("adj_close") - pl.col("adj_close").shift(60), pl.col("adj_close").shift(60))
        abs_ret_sum = pl.col("return_1d").abs().rolling_sum(60)
        vol_avg = pl.col("volume").rolling_mean(60)
        raw_intent = _safe_div(ret_60d, abs_ret_sum) / vol_avg.clip(1.0, None)
        # Rolling rank: only use past data (no lookahead). Per-stock time-sorted → Polars rank() is positional.
        df = df.with_columns(
            (raw_intent.fill_null(0.0).fill_nan(0.0).rank() / pl.lit(float(len(df))))
            .fill_null(0.5).alias("linear_factor")
        )
    else:
        df = df.with_columns(pl.lit(0.5).alias("linear_factor"))

    # rsi5_dulling: consecutive RSI(5) > 80
    delta_5 = pl.col("close").diff()
    gain_5 = delta_5.clip(0, None).rolling_mean(5)
    loss_5 = (-delta_5.clip(None, 0)).rolling_mean(5)
    rsi_5_expr = pl.lit(100.0) - pl.lit(100.0) / (pl.lit(1.0) + _safe_div(gain_5, loss_5, 1.0))
    df = df.with_columns(rsi_5_expr.fill_null(50.0).alias("_rsi5"))
    # Consecutive > 80 count (compute in numpy — Polars has no cumsum-reset)
    rsi5_vals = df["_rsi5"].to_numpy()
    above_80 = (rsi5_vals > 80).astype(int)
    consec = np.zeros(len(above_80), dtype=int)
    for i in range(len(above_80)):
        if above_80[i]:
            consec[i] = consec[i - 1] + 1 if i > 0 else 1
        else:
            consec[i] = 0
    df = df.with_columns(
        pl.Series("rsi5_dulling", np.clip(consec, 0, 10) / 10.0, dtype=pl.Float64)
    )
    df = df.drop("_rsi5")

    # keltner_position
    if "ma20" in df.columns and "atr14" in df.columns:
        df = df.with_columns(
            _clip_expr(
                _safe_div(pl.col("close") - pl.col("ma20"), pl.col("atr14") * 1.5),
                -3.0, 3.0
            ).alias("keltner_position")
        )
    else:
        df = df.with_columns(pl.lit(0.0).alias("keltner_position"))

    # ── 9. Alpha158 Core (Tier A) ────────────────────────────────────────────
    o = pl.col("open") if "open" in df.columns else pl.col("close")
    h_expr = pl.col("high") if "high" in df.columns else pl.col("close")
    l_expr = pl.col("low") if "low" in df.columns else pl.col("close")

    df = df.with_columns([
        _clip_expr(_safe_div(pl.col("close") - o, o), -0.2, 0.2).alias("KMID"),
        _clip_expr(_safe_div(h_expr - l_expr, o), 0.0, 0.3).alias("KLEN"),
        _clip_expr(_safe_div(pl.col("close") - o, h_expr - l_expr), -1.0, 1.0).alias("KMID2"),
        _clip_expr(_safe_div(h_expr - pl.max_horizontal(o, pl.col("close")), o), 0.0, 0.2).alias("KUP"),
        _clip_expr(_safe_div(h_expr - pl.max_horizontal(o, pl.col("close")), h_expr - l_expr), 0.0, 1.0).alias("KUP2"),
        _clip_expr(_safe_div(pl.min_horizontal(o, pl.col("close")) - l_expr, o), 0.0, 0.2).alias("KLOW"),
        _clip_expr(_safe_div(pl.min_horizontal(o, pl.col("close")) - l_expr, h_expr - l_expr), 0.0, 1.0).alias("KLOW2"),
        _clip_expr(_safe_div(2 * pl.col("close") - h_expr - l_expr, o), -0.2, 0.2).alias("KSFT"),
        _clip_expr(_safe_div(2 * pl.col("close") - h_expr - l_expr, h_expr - l_expr), -1.0, 1.0).alias("KSFT2"),
    ])

    # Time-Cycle + Trend Quality → NumPy (no rolling argmax/custom fn in Polars)
    n = len(df)
    close_np = df["close"].to_numpy().astype(np.float64)
    high_np = df["high"].to_numpy().astype(np.float64) if "high" in df.columns else close_np
    low_np = df["low"].to_numpy().astype(np.float64) if "low" in df.columns else close_np

    # IMAX/IMIN-20
    if n >= 20:
        imax_20, imin_20 = _imax_imin_numpy(high_np, low_np, 20, n)
        df = df.with_columns([
            pl.Series("IMAX_20", imax_20),
            pl.Series("IMIN_20", imin_20),
            pl.Series("IMXD_20", imax_20 - imin_20),
        ])
    else:
        df = df.with_columns([
            pl.lit(0.5).alias("IMAX_20"),
            pl.lit(0.5).alias("IMIN_20"),
            pl.lit(0.0).alias("IMXD_20"),
        ])

    # Trend Quality: BETA/RSQR/RESI × {5, 10, 20, 60}
    for tf in [5, 10, 20, 60]:
        if n >= tf:
            beta, rsqr, resi = _compute_trend_arrays(close_np, tf, n)
            df = df.with_columns([
                pl.Series(f"BETA_{tf}", beta),
                pl.Series(f"RSQR_{tf}", rsqr),
                pl.Series(f"RESI_{tf}", resi),
            ])
        else:
            df = df.with_columns([
                pl.lit(0.0).alias(f"BETA_{tf}"),
                pl.lit(0.0).alias(f"RSQR_{tf}"),
                pl.lit(0.0).alias(f"RESI_{tf}"),
            ])

    # CNTP/CNTN/CNTD × {5, 10, 20}
    df = df.with_columns([
        (pl.col("close") > pl.col("close").shift(1)).cast(pl.Float64).alias("_up"),
        (pl.col("close") < pl.col("close").shift(1)).cast(pl.Float64).alias("_down"),
    ])
    for tf in [5, 10, 20]:
        df = df.with_columns([
            (pl.col("_up").rolling_sum(tf).fill_null(0.0) / tf).alias(f"CNTP_{tf}"),
            (pl.col("_down").rolling_sum(tf).fill_null(0.0) / tf).alias(f"CNTN_{tf}"),
        ])
        df = df.with_columns(
            (pl.col(f"CNTP_{tf}") - pl.col(f"CNTN_{tf}")).alias(f"CNTD_{tf}")
        )
    df = df.drop(["_up", "_down"])

    # VSTD/WVMA
    if "volume" in df.columns:
        df = df.with_columns([
            pl.col("volume").rolling_std(10).fill_null(0.0).alias("VSTD_10"),
            pl.col("volume").rolling_std(20).fill_null(0.0).alias("VSTD_20"),
        ])
        # WVMA: volume-weighted MA of close
        df = df.with_columns(
            _safe_div(
                (pl.col("close") * pl.col("volume")).rolling_sum(10),
                pl.col("volume").rolling_sum(10),
            ).fill_null(pl.col("close")).alias("WVMA")
        )
    else:
        df = df.with_columns([
            pl.lit(0.0).alias("VSTD_10"),
            pl.lit(0.0).alias("VSTD_20"),
            pl.col("close").alias("WVMA"),
        ])

    # CORR/CORD — Polars pl.rolling_corr() 原生支援
    if n >= 10 and "volume" in df.columns:
        # CORR_10: close vs volume 的 10 日 rolling Pearson 相關（量價背離偵測）
        df = df.with_columns(
            pl.rolling_corr(pl.col("close"), pl.col("volume"), window_size=10)
            .fill_null(0.0).fill_nan(0.0).clip(-1.0, 1.0)
            .alias("CORR_10")
        )
        # CORD_10: return_1d vs volume_change 的 10 日 rolling 相關
        df = df.with_columns(
            _safe_div(
                pl.col("volume") - pl.col("volume").shift(1),
                pl.col("volume").shift(1),
            ).clip(-10.0, 10.0).alias("_vol_chg")
        )
        df = df.with_columns(
            pl.rolling_corr(pl.col("return_1d").fill_null(0.0), pl.col("_vol_chg").fill_null(0.0), window_size=10)
            .fill_null(0.0).fill_nan(0.0).clip(-1.0, 1.0)
            .alias("CORD_10")
        )
        df = df.drop("_vol_chg")
    else:
        df = df.with_columns([
            pl.lit(0.0).alias("CORR_10"),
            pl.lit(0.0).alias("CORD_10"),
        ])

    # ── 10. Wave 2/3 defaults + per_stock_ts join ────────────────────────────
    wave2_defaults = {
        "us_sox_return": 0.0, "us_gspc_return": 0.0, "us_dxy_return": 0.0,
        "us_hy_spread": 3.5, "us_hy_spread_chg": 0.0, "us_vix": 20.0,
        "advance_ratio": 0.5, "bull_alignment_pct": 50.0,
        "us_sentiment_score": 0.0,
    }
    for col, default in wave2_defaults.items():
        if col not in df.columns:
            df = df.with_columns(pl.lit(default).alias(col))
        else:
            df = df.with_columns(pl.col(col).fill_null(default).fill_nan(default))

    # Wave 3: per-stock time-series
    wave3_defaults = {
        "margin_balance": 0.0, "short_ratio": 0.0,
        "margin_change_5d": 0.0, "retail_pct": 50.0,
        "revenue_yoy": 0.0,
    }
    per_stock_ts: dict = market_env.get("per_stock_ts", {}) if market_env else {}
    if per_stock_ts:
        ps_records = []
        for date_str, vals in per_stock_ts.items():
            rec = {"date": date_str}
            rec.update(vals)
            ps_records.append(rec)
        if ps_records:
            ps_df = (
                pl.DataFrame(ps_records, infer_schema_length=None)
                .with_columns(pl.col("date").cast(pl.Date))
                .sort("date")
            )
            # forward-fill monthly/weekly features
            for ffill_col in ["revenue_yoy", "retail_pct"]:
                if ffill_col in ps_df.columns:
                    ps_df = ps_df.with_columns(pl.col(ffill_col).cast(pl.Float64, strict=False).forward_fill())
            # margin_change_5d from margin_balance
            if "margin_balance" in ps_df.columns and "margin_change_5d" not in ps_df.columns:
                mb = pl.col("margin_balance").cast(pl.Float64, strict=False).forward_fill()
                ps_df = ps_df.with_columns(
                    _clip_expr(_safe_div(mb - mb.shift(5), mb.shift(5)), -1.0, 1.0)
                    .alias("margin_change_5d")
                )
            ps_join_cols = [c for c in wave3_defaults if c in ps_df.columns and c not in df.columns]
            if ps_join_cols:
                df = df.join(ps_df.select(["date"] + ps_join_cols), on="date", how="left")

    for col, default in wave3_defaults.items():
        if col not in df.columns:
            df = df.with_columns(pl.lit(default).alias(col))
        else:
            df = df.with_columns(pl.col(col).fill_null(default).fill_nan(default))

    # ── 11. Lag features ─────────────────────────────────────────────────────
    for lag_col in ["rsi14", "macdHist", "vol_ratio_5d"]:
        if lag_col in df.columns:
            df = df.with_columns([
                pl.col(lag_col).shift(1).alias(f"{lag_col}_lag1"),
                pl.col(lag_col).shift(3).alias(f"{lag_col}_lag3"),
            ])
    if "chip_5d" in df.columns:
        df = df.with_columns(pl.col("chip_5d").shift(1).alias("chip_5d_lag1"))

    # Tier C lags
    for tier_c_col in ["margin_ratio", "short_change_5d", "vwap_bias",
                        "KMID", "KLEN", "BETA_20", "RSQR_20"]:
        if tier_c_col in df.columns:
            df = df.with_columns(pl.col(tier_c_col).shift(1).alias(f"{tier_c_col}_lag1"))

    # ── 12. Stock-level features ─────────────────────────────────────────────
    if stock_meta:
        df = df.with_columns([
            pl.lit(float(stock_meta.get("sector_encoded", 0))).alias("sector_encoded"),
            pl.lit(float(stock_meta.get("market_cap_bucket", 2))).alias("market_cap_bucket"),
            pl.lit(float(stock_meta.get("avg_volume_bucket", 2))).alias("avg_volume_bucket"),
            pl.lit(float(stock_meta.get("sector_peer_return_1d", 0))).alias("sector_peer_return_1d"),
            pl.lit(float(stock_meta.get("sector_peer_return_5d", 0))).alias("sector_peer_return_5d"),
            pl.lit(float(stock_meta.get("stock_vs_sector", 0))).alias("stock_vs_sector"),
        ])
    else:
        df = df.with_columns([
            pl.lit(0.0).alias("sector_encoded"),
            pl.lit(2.0).alias("market_cap_bucket"),
            pl.lit(2.0).alias("avg_volume_bucket"),
            pl.lit(0.0).alias("sector_peer_return_1d"),
            pl.lit(0.0).alias("sector_peer_return_5d"),
            pl.lit(0.0).alias("stock_vs_sector"),
        ])

    # ── 13. Rolling Z-score normalization ────────────────────────────────────
    # Only raw-scale features (returns, volatility, chip flows, bias) are Z-scored.
    # RSI/MACD/KD are intentionally EXCLUDED — they are already bounded by their
    # own formulas (RSI ∈ [0,100], MACD is differenced). Z-scoring them would be
    # double normalization and attenuate their predictive signal.
    ZSCORE_COLS = [
        "return_1d", "return_3d", "return_5d", "return_10d",
        "volatility_5d", "volatility_20d",
        "vol_ratio_5d", "vol_ratio_20d",
        "institutional_net", "chip_5d", "foreign_5d",
        "ma20_bias", "ma60_bias",
    ]
    # Save raw ATR before Z-score for triple barrier
    atr14_raw = df["atr14"].to_numpy().astype(np.float64) if "atr14" in df.columns else None

    _zscore_const_cols = []
    for col in ZSCORE_COLS:
        if col in df.columns:
            roll_mean = pl.col(col).rolling_mean(60)
            roll_std_raw = pl.col(col).rolling_std(60)
            # Track columns where std ≈ 0 in the latest window (constant feature
            # → Z-score becomes ±5 binary after clip, losing granularity)
            latest_std = df.select(roll_std_raw).to_series()[-1] if len(df) > 60 else None
            if latest_std is not None and latest_std < 1e-6:
                _zscore_const_cols.append(col)
            roll_std = roll_std_raw.clip(1e-8, None)
            df = df.with_columns(
                ((pl.col(col) - roll_mean) / roll_std).clip(-5.0, 5.0).alias(col)
            )
    if _zscore_const_cols:
        print(f"[Features] Z-score: {len(_zscore_const_cols)} constant-variance cols "
              f"(will be ±5 binary): {_zscore_const_cols[:5]}")

    # ── 14. NaN handling (features only, not targets) ────────────────────────
    # forward_fill: carry last known value forward (stale but not fictional).
    # fill_null: remaining NaN (start of series) → per-column median, NOT 0.0.
    #   Zero is a false signal for any real feature (e.g. MA5=0 is impossible
    #   for a stock with price > 0). Median is neutral and doesn't create
    #   artificial split patterns in tree models.
    #   Reference: Qlib (Microsoft) CSZFillna uses cross-sectional mean;
    #   we use per-column median (more robust to outliers).
    target_cols = ["target_5d", "target_dir"]
    feature_cols = [c for c in df.columns if c not in target_cols and c != "date"]
    df = df.with_columns(pl.exclude(target_cols + ["date"]).forward_fill())
    median_fills = []
    for col in feature_cols:
        if col in df.columns:
            col_median = df[col].drop_nulls().drop_nans().median()
            fill_val = float(col_median) if col_median is not None else 0.0
            median_fills.append(pl.col(col).fill_null(fill_val).fill_nan(fill_val))
    if median_fills:
        df = df.with_columns(median_fills)

    # ── 15. Target variables ─────────────────────────────────────────────────
    df = df.with_columns(
        (_safe_div(pl.col("close").shift(-5), pl.col("close")) - 1.0).alias("target_5d")
    )

    # Triple Barrier Label (using raw ATR, not Z-scored)
    close_np = df["close"].to_numpy().astype(np.float64)
    high_np = df["high"].to_numpy().astype(np.float64) if "high" in df.columns else close_np
    low_np = df["low"].to_numpy().astype(np.float64) if "low" in df.columns else close_np
    if atr14_raw is None:
        # Compute raw ATR from scratch
        h_arr = high_np
        l_arr = low_np
        c_arr = close_np
        tr = np.maximum(h_arr - l_arr, np.maximum(np.abs(h_arr - np.roll(c_arr, 1)), np.abs(l_arr - np.roll(c_arr, 1))))
        tr[0] = h_arr[0] - l_arr[0]
        # Simple rolling mean
        atr14_raw = np.convolve(tr, np.ones(14)/14, mode='full')[:len(tr)]
        atr14_raw[:13] = np.nan

    bp = barrier_params or {}
    target_dir = compute_triple_barrier_labels(
        close=close_np,
        high=high_np,
        low=low_np,
        atr14=atr14_raw,
        upper_atr_mult=bp.get("upper_mult", 3.0),
        lower_atr_mult=bp.get("lower_mult", 2.0),
        upper_pct_cap=bp.get("upper_pct_cap", 0.07),
        lower_pct_cap=bp.get("lower_pct_cap", 0.03),
        max_days=bp.get("max_days", 20),
    )
    # 2026-04-17 #3 fix: compute_triple_barrier_labels returns float NaN for
    # unresolved rows (last max_days rows or missing data). Polars drop_nulls()
    # only removes null values, NOT NaN floats → get_features leaks NaN into y
    # → sklearn model.score(y_test) raises "Input y_true contains NaN" →
    # [LightGBM] fallback across all stocks every predict.
    # Replace float NaN with Polars null so drop_nulls() catches them cleanly.
    df = df.with_columns(
        pl.Series("target_dir", target_dir).fill_nan(None)
    )

    return df


# ── Feature column definitions ───────────────────────────────────────────────
NIGHT_SESSION_COLS = ["taifex_night_change_pct", "taifex_night_range_pct", "taifex_night_available"]
ORDERBOOK_COLS = ["orderbook_imbalance", "orderbook_spread_pct", "orderbook_available"]
OPTIONAL_FEATURE_COLS = NIGHT_SESSION_COLS + ORDERBOOK_COLS

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
    # 大盤環境
    "market_risk_score", "market_risk_level",
    "market_return_1d", "market_return_5d", "market_bias_20d",
    "stock_vs_market",
    # FinLab 策略因子
    "linear_factor", "rsi5_dulling", "keltner_position",
    # Wave 2
    "us_sox_return", "us_gspc_return", "us_dxy_return",
    "us_hy_spread", "us_hy_spread_chg", "us_vix",
    "us_sentiment_score", "advance_ratio", "bull_alignment_pct",
    "revenue_yoy",
    # Wave 3
    "margin_balance", "short_ratio", "margin_change_5d", "retail_pct",
    # Tier 0
    "margin_ratio", "margin_change_5d_ts", "short_change_5d", "short_squeeze_proxy",
    "vwap_bias", "vwap_5d", "vwap_bias_5d",
    "dealer_5d", "dealer_ratio_5d",
    # Tier 0.5
    "foreign_consecutive_sell", "foreign_net_5d_market",
    "limit_down_count", "limit_down_pct",
    "adl_value", "adl_trend_numeric",
    "ma5_bias", "ma10_bias", "bb_upper_raw", "bb_lower_raw",
    # Tier A: Alpha158
    "KMID", "KLEN", "KMID2", "KUP", "KUP2", "KLOW", "KLOW2", "KSFT", "KSFT2",
    "IMAX_20", "IMIN_20", "IMXD_20",
    "BETA_20", "RSQR_20", "RESI_20",
    "CORR_10", "CORD_10",
    # Tier B
    "BETA_5", "RSQR_5", "RESI_5",
    "BETA_10", "RSQR_10", "RESI_10",
    "BETA_60", "RSQR_60", "RESI_60",
    "CNTP_5", "CNTN_5", "CNTD_5",
    "CNTP_10", "CNTN_10", "CNTD_10",
    "CNTP_20", "CNTN_20", "CNTD_20",
    "VSTD_10", "VSTD_20", "WVMA",
    # Universal model
    "sector_encoded", "market_cap_bucket", "avg_volume_bucket",
    "sector_peer_return_1d", "sector_peer_return_5d", "stock_vs_sector",
]

CATBOOST_EXTRA_COLS = [
    "rsi14_lag1", "rsi14_lag3",
    "macdHist_lag1", "macdHist_lag3",
    "vol_ratio_5d_lag1", "vol_ratio_5d_lag3",
    "chip_5d_lag1",
    "margin_ratio_lag1", "short_change_5d_lag1", "vwap_bias_lag1",
    "KMID_lag1", "KLEN_lag1", "BETA_20_lag1", "RSQR_20_lag1",
]


def get_features(
    df: pl.DataFrame,
    target_col: str = "target_rank",
    allow_missing_target: bool = False,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """取得可用的特徵欄位，回傳 (X, y, feature_names)。

    target_col:
      - "target_rank": cross-sectional rank 0~1 (regression, batch training)
      - "target_dir": binary triple-barrier (per-stock predict/retrain)
    Caller 必須顯式傳 target_col，不做 fallback。

    allow_missing_target: 2026-04-17
      False (default, training): 若 target_col 不在 df 中 → raise ValueError
      True (predict mode): target_col 不存在時回傳 y=empty array；適用於單股
        predict（target_rank 由 batch pool 產生，單股 df 沒有 rank）。
        Caller 不應讀 y，只用 X_latest。
    """
    available = [c for c in FEATURE_COLS if c in df.columns]
    if target_col not in df.columns:
        if not allow_missing_target:
            raise ValueError(f"target_col '{target_col}' not found in DataFrame. "
                             f"Available: {[c for c in df.columns if c.startswith('target')]}")
        # Predict mode: drop nulls on features only, y 回傳空陣列 (caller 不該讀)
        df_clean = df.select(available).drop_nulls()
        X = df_clean.to_numpy()
        y = np.empty(len(X), dtype=np.float32)
        return X, y, available
    select_cols = available + [target_col]
    # 加 target_5d 供 drop_nulls 同步過濾
    if "target_5d" in df.columns and "target_5d" not in select_cols:
        select_cols = select_cols + ["target_5d"]
    df_clean = df.select(select_cols).drop_nulls()
    X = df_clean.select(available).to_numpy()
    y = df_clean[target_col].to_numpy()
    return X, y, available


def get_catboost_features(
    df: pl.DataFrame,
    target_col: str = "target_rank",
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """CatBoost 專用：原始特徵 + 滯後特徵"""
    base = [c for c in FEATURE_COLS if c in df.columns]
    extra = [c for c in CATBOOST_EXTRA_COLS if c in df.columns]
    all_cols = base + extra
    if target_col not in df.columns:
        raise ValueError(f"target_col '{target_col}' not found in DataFrame.")
    select_cols = all_cols + [target_col]
    if "target_5d" in df.columns and "target_5d" not in select_cols:
        select_cols = select_cols + ["target_5d"]
    df_clean = df.select(select_cols).drop_nulls()
    X = df_clean.select(all_cols).to_numpy()
    y = df_clean[target_col].to_numpy()
    return X, y, all_cols


def get_lgbm_features(X: np.ndarray) -> np.ndarray:
    """LightGBM 專用：rank transform"""
    from scipy.stats import rankdata
    return np.apply_along_axis(lambda col: rankdata(col) / len(col), axis=0, arr=X)


def mask_night_session_features(
    X: np.ndarray,
    feature_names: list[str],
    mask_ratio: float = 0.5,
    seed: int = 42,
) -> np.ndarray:
    """Training 時隨機 mask 夜盤特徵"""
    night_indices = [i for i, name in enumerate(feature_names) if name in OPTIONAL_FEATURE_COLS]
    if not night_indices:
        return X
    X_masked = X.copy()
    rng = np.random.RandomState(seed)
    mask = rng.random(len(X_masked)) < mask_ratio
    for idx in night_indices:
        X_masked[mask, idx] = 0.0
    return X_masked


# ── RobustScaler（純 NumPy）─────────────────────────────────────────────────
_robust_scaler_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}


def fit_robust_scaler(X: np.ndarray, stock_id: str = "default") -> tuple[np.ndarray, np.ndarray]:
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
    if median is None or iqr is None:
        cached = _robust_scaler_cache.get(stock_id)
        if cached is None:
            median, iqr = fit_robust_scaler(X, stock_id)
        else:
            median, iqr = cached
    return np.clip((X - median) / iqr, -5, 5)
