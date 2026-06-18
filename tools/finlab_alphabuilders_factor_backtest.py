from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _df(frame: Any) -> pd.DataFrame:
    out = pd.DataFrame(frame).copy()
    out.index = pd.to_datetime(out.index)
    out = out.sort_index()
    out.columns = [str(col).strip() for col in out.columns]
    return out


def _align(frame: Any, index: pd.Index, columns: list[str], *, ffill: bool = True) -> pd.DataFrame:
    out = _df(frame).reindex(columns=columns).reindex(index)
    return out.ffill() if ffill else out


def _deadline_daily(frame: Any, close: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    if hasattr(frame, "deadline"):
        frame = frame.deadline()
    return _align(frame, close.index, columns, ffill=True)


def _common_stock_columns(close: pd.DataFrame, universe: str) -> list[str]:
    from finlab import data

    sec = pd.DataFrame(data.get("security_categories"))
    sec["symbol"] = sec["symbol"].astype(str).str.strip()
    sec["market"] = sec["market"].astype(str).str.lower().str.strip()
    allowed_markets = ["sii"] if universe == "sii" else ["sii", "otc"]
    allowed = set(sec.loc[sec["market"].isin(allowed_markets) & sec["symbol"].str.fullmatch(r"\d{4}"), "symbol"])
    return [col for col in close.columns if col in allowed]


def _ema(frame: pd.DataFrame, span: int) -> pd.DataFrame:
    return frame.ewm(span=span, adjust=False).mean()


def _rsi(close: pd.DataFrame, period: int) -> pd.DataFrame:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(loss != 0, 100)


def _stoch_k(close: pd.DataFrame, high: pd.DataFrame, low: pd.DataFrame, period: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    low_n = low.rolling(period).min()
    high_n = high.rolling(period).max()
    rsv = (close - low_n) / (high_n - low_n).replace(0, np.nan) * 100
    k = rsv.ewm(alpha=1 / 3, adjust=False).mean()
    d = k.ewm(alpha=1 / 3, adjust=False).mean()
    return k, d


def _true_range(high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame) -> pd.DataFrame:
    return pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=0).groupby(level=0).max()


def _dmi_adx(high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame, period: int = 14) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0)
    atr = _true_range(high, low, close).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr.replace(0, np.nan)
    dx = (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan) * 100
    adx = dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    return plus_di, minus_di, adx


def _parabolic_sar(high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(np.nan, index=close.index, columns=close.columns)
    for col in close.columns:
        h = high[col].to_numpy(dtype=float)
        l = low[col].to_numpy(dtype=float)
        c = close[col].to_numpy(dtype=float)
        if len(c) < 2:
            continue
        sar = np.full(len(c), np.nan)
        valid = np.isfinite(h) & np.isfinite(l) & np.isfinite(c)
        idx = np.flatnonzero(valid)
        if len(idx) < 2:
            continue
        first = idx[0]
        second = idx[1]
        uptrend = c[second] >= c[first]
        current_sar = l[first] if uptrend else h[first]
        ep = h[second] if uptrend else l[second]
        af = 0.02
        sar[first] = current_sar
        for i in range(second, len(c)):
            if not valid[i]:
                continue
            current_sar = current_sar + af * (ep - current_sar)
            if uptrend:
                prev_lows = [l[j] for j in (i - 1, i - 2) if j >= 0 and np.isfinite(l[j])]
                if prev_lows:
                    current_sar = min(current_sar, *prev_lows)
                if l[i] < current_sar:
                    uptrend = False
                    current_sar = ep
                    ep = l[i]
                    af = 0.02
                elif h[i] > ep:
                    ep = h[i]
                    af = min(0.2, af + 0.02)
            else:
                prev_highs = [h[j] for j in (i - 1, i - 2) if j >= 0 and np.isfinite(h[j])]
                if prev_highs:
                    current_sar = max(current_sar, *prev_highs)
                if h[i] > current_sar:
                    uptrend = True
                    current_sar = ep
                    ep = h[i]
                    af = 0.02
                elif l[i] < ep:
                    ep = l[i]
                    af = min(0.2, af + 0.02)
            sar[i] = current_sar
        out[col] = sar
    return out


def _wma(frame: pd.DataFrame, period: int) -> pd.DataFrame:
    weights = np.arange(1, period + 1, dtype=float)
    return frame.rolling(period).apply(lambda x: float(np.dot(x, weights) / weights.sum()), raw=True)


def _rolling_sum_bool(mask: pd.DataFrame, period: int) -> pd.DataFrame:
    return mask.astype(float).rolling(period).sum()


def _build_base_data(universe: str) -> dict[str, pd.DataFrame]:
    from finlab import data

    close_all = _df(data.get("price:收盤價"))
    columns = _common_stock_columns(close_all, universe)
    close = close_all.reindex(columns=columns)
    open_ = _df(data.get("price:開盤價")).reindex(index=close.index, columns=columns)
    high = _df(data.get("price:最高價")).reindex(index=close.index, columns=columns)
    low = _df(data.get("price:最低價")).reindex(index=close.index, columns=columns)
    volume = _df(data.get("price:成交股數")).reindex(index=close.index, columns=columns)
    market_value = _align(data.get("etl:market_value"), close.index, columns)
    pe = _align(data.get("price_earning_ratio:本益比"), close.index, columns)
    pb = _align(data.get("price_earning_ratio:股價淨值比"), close.index, columns)
    dividend_yield = _align(data.get("price_earning_ratio:殖利率(%)"), close.index, columns)
    revenue = _deadline_daily(data.get("monthly_revenue:當月營收"), close, columns)
    try:
        disposal_filter = _align(data.get("etl:disposal_stock_filter"), close.index, columns)
    except Exception:
        disposal_filter = pd.DataFrame(np.nan, index=close.index, columns=columns)
    return {
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "market_value": market_value,
        "pe": pe,
        "pb": pb,
        "dividend_yield": dividend_yield,
        "monthly_revenue": revenue,
        "disposal_filter": disposal_filter,
    }


def _build_factor_values(base: dict[str, pd.DataFrame]) -> tuple[dict[str, pd.DataFrame], dict[str, dict[str, Any]]]:
    open_ = base["open"]
    high = base["high"]
    low = base["low"]
    close = base["close"]
    volume = base["volume"]
    market_value = base["market_value"]
    ret = close.pct_change(fill_method=None)
    dollar_volume = close * volume
    tr = _true_range(high, low, close)
    atr14 = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    atr20 = tr.ewm(alpha=1 / 20, adjust=False, min_periods=20).mean()
    plus_di, minus_di, adx14 = _dmi_adx(high, low, close, 14)
    sar = _parabolic_sar(high, low, close)
    k9, d9 = _stoch_k(close, high, low, 9)
    k14, _ = _stoch_k(close, high, low, 14)
    typical = (high + low + close) / 3
    direction = np.sign(close.diff()).fillna(0)
    obv = (direction * volume).cumsum()
    vol5_prev = volume.shift(1).rolling(5).mean()
    up_day = close > close.shift(1)
    down_day = close < close.shift(1)

    gain = close.diff().clip(lower=0).rolling(14).sum()
    loss = (-close.diff().clip(upper=0)).rolling(14).sum()
    cmo = (gain - loss) / (gain + loss).replace(0, np.nan) * 100

    pos_money_flow = (typical * volume).where(typical > typical.shift(), 0).rolling(14).sum()
    neg_money_flow = (typical * volume).where(typical < typical.shift(), 0).rolling(14).sum()
    mfi = 100 - 100 / (1 + pos_money_flow / neg_money_flow.replace(0, np.nan))

    up_vol = volume.where(up_day, 0).rolling(26).sum()
    down_vol = volume.where(down_day, 0).rolling(26).sum()
    flat_vol = volume.where(~up_day & ~down_day, 0).rolling(26).sum()
    vr = (up_vol + 0.5 * flat_vol) / (down_vol + 0.5 * flat_vol).replace(0, np.nan) * 100

    mid_move = ((high + low) / 2).diff()
    emv_raw = mid_move * (high - low) / volume.replace(0, np.nan)
    emv14 = emv_raw.rolling(14).mean()

    high_252 = high.rolling(252).max()
    low_252 = low.rolling(252).min()
    ma3 = close.rolling(3).mean()
    ma5 = close.rolling(5).mean()
    ma6 = close.rolling(6).mean()
    ma10 = close.rolling(10).mean()
    ma12 = close.rolling(12).mean()
    ma20 = close.rolling(20).mean()
    ma24 = close.rolling(24).mean()
    ma50 = close.rolling(50).mean()
    ma60 = close.rolling(60).mean()
    ma200 = close.rolling(200).mean()

    revenue_ttm = base["monthly_revenue"].rolling(12).sum()
    market_value_safe = market_value.replace(0, np.nan)
    psr_proxy = revenue_ttm / market_value_safe

    limit_up = ret >= 0.095
    limit_down = ret <= -0.095
    price_range = (high - low).abs() / close.replace(0, np.nan)
    locked_up = ((open_ / close.shift() - 1) >= 0.095) & (price_range <= 0.005)
    locked_down = ((open_ / close.shift() - 1) <= -0.095) & (price_range <= 0.005)
    disposal_active = (~base["disposal_filter"].astype("boolean")).astype(float)

    values: dict[str, pd.DataFrame] = {
        "mom_rsi_14": _rsi(close, 14),
        "mom_macd_trend_10": (close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()).ewm(span=10, adjust=False).mean(),
        "mom_12m_1m": close.shift(21) / close.shift(252) - 1,
        "mom_reversal_1m": -(close / close.shift(21) - 1),
        "mom_reversal_6m": -(close / close.shift(126) - 1),
        "mom_9m": close / close.shift(189) - 1,
        "mom_hl52": (high_252 - close) / (high_252 - low_252).replace(0, np.nan),
        "mom_close_to_52w_high": close / high_252,
        "mom_ma50_200_ratio": ma50 / ma200,
        "mom_vol_adj_12m": (close / close.shift(252) - 1) / (ret.rolling(252).std() * np.sqrt(252)).replace(0, np.nan),
        "vol_share_turnover_21d": (dollar_volume / market_value_safe).rolling(21).mean(),
        "vol_chg_turnover_1y": ((dollar_volume / market_value_safe) - (dollar_volume / market_value_safe).rolling(252).mean()) / (dollar_volume / market_value_safe).rolling(252).std().replace(0, np.nan),
        "vol_signal_5d": np.log(volume.rolling(5).mean() / volume.rolling(60).mean().replace(0, np.nan)),
        "vol_money_flow_5d": (dollar_volume.rolling(5).sum() / volume.rolling(5).sum().replace(0, np.nan)) / close - 1,
        "vol_cv_volprice_20d": (volume / close.replace(0, np.nan)).rolling(20).std() / (volume / close.replace(0, np.nan)).rolling(20).mean().replace(0, np.nan),
        "vola_realized_1m": ret.rolling(21).std() * np.sqrt(252),
        "vola_realized_12m": ret.rolling(252).std() * np.sqrt(252),
        "liq_amihud_21d": (ret.abs() / dollar_volume.replace(0, np.nan)).rolling(21).mean() * 1e6,
        "vola_cv_90d": close.rolling(90).std() / close.rolling(90).mean().replace(0, np.nan),
        "vola_min_130d": ret.rolling(130).min(),
        "val_ep": 1 / base["pe"].replace(0, np.nan),
        "val_bp": 1 / base["pb"].replace(0, np.nan),
        "val_sp": psr_proxy,
        "val_dp": base["dividend_yield"] / 100,
        "size_log_mktcap": np.log(market_value_safe),
        "tech_kd9_k": k9,
        "tech_bbands_pctb_20": (close - (ma20 - 2 * close.rolling(20).std())) / (4 * close.rolling(20).std()).replace(0, np.nan),
        "tech_bias_20": (close - ma20) / ma20.replace(0, np.nan),
        "tech_granville_score": (close / ma60 - 1) * np.sign(ma60 - ma200),
        "tech_limit_up_streak_10": _rolling_sum_bool(limit_up, 10),
        "tech_sma_20_pos": (close - ma20) / ma20.replace(0, np.nan),
        "tech_ema_12_pos": (close - _ema(close, 12)) / _ema(close, 12).replace(0, np.nan),
        "tech_wma_10_pos": (close - _wma(close, 10)) / _wma(close, 10).replace(0, np.nan),
        "tech_dma_10_50": ma10 - ma50,
        "tech_bbi": (close - ((ma3 + ma6 + ma12 + ma24) / 4)) / ((ma3 + ma6 + ma12 + ma24) / 4).replace(0, np.nan),
        "tech_trix_12": _ema(_ema(_ema(close, 12), 12), 12).pct_change(fill_method=None),
        "tech_kdj_j_9": 3 * k9 - 2 * d9,
        "tech_williams_r_14": (high.rolling(14).max() - close) / (high.rolling(14).max() - low.rolling(14).min()).replace(0, np.nan) * -100,
        "tech_cci_20": (typical - typical.rolling(20).mean()) / (0.015 * typical.rolling(20).apply(lambda x: np.mean(np.abs(x - np.mean(x))), raw=True)).replace(0, np.nan),
        "tech_mtm_10": close - close.shift(10),
        "tech_roc_10": close / close.shift(10) - 1,
        "tech_cmo_14": cmo,
        "tech_obv": (obv - obv.shift(21)) / obv.shift(21).abs().replace(0, np.nan),
        "tech_volume_ratio_5": volume / vol5_prev.replace(0, np.nan),
        "tech_vr_26": vr,
        "tech_mfi_14": mfi,
        "tech_emv_14": emv14,
        "tech_atr_14": atr14,
        "tech_keltner_pos_20": (close - _ema(close, 20)) / atr20.replace(0, np.nan),
        "tech_donchian_pos_20": (close - low.rolling(20).min()) / (high.rolling(20).max() - low.rolling(20).min()).replace(0, np.nan),
        "tech_sar": (close - sar) / sar.replace(0, np.nan),
        "tech_adx_14": adx14,
        "tech_psy_12": up_day.astype(float).rolling(12).mean(),
        "tech_ma_convergence": pd.concat([ma5, ma10, ma20], axis=0).groupby(level=0).max() / pd.concat([ma5, ma10, ma20], axis=0).groupby(level=0).min().replace(0, np.nan) - 1,
        "tech_bullish_streak_5": _rolling_sum_bool(close > open_, 5),
        "tech_gap_up": (low > high.shift()).astype(float),
        "tech_gap_down": (high < low.shift()).astype(float),
        "tech_limit_down_count_10": _rolling_sum_bool(limit_down, 10),
        "tech_locked_open_up_10": _rolling_sum_bool(locked_up, 10),
        "tech_locked_open_down_10": _rolling_sum_bool(locked_down, 10),
        "tech_disposal_active": disposal_active,
        "tech_slow_kd_14": k14,
        "tech_tower_3": (close > close.shift(1).rolling(3).max()).astype(float),
    }
    mapping: dict[str, dict[str, Any]] = {key: {"status": "mapped", "source": "finlab_ohlcv_or_finlab_dataset"} for key in values}
    mapping["tech_disposal_active"] = {
        "status": "mapped_proxy",
        "source": "etl:disposal_stock_filter inverted",
        "caveat": "FinLab dataset is a filter; active flag is approximated by inverse boolean.",
    }
    for key in ("tech_limit_up_streak_10", "tech_limit_down_count_10", "tech_locked_open_up_10", "tech_locked_open_down_10"):
        mapping[key] = {
            "status": "mapped_proxy",
            "source": "OHLCV price-limit proxy",
            "caveat": "No per-symbol AlphaBuilders limit_fg/limo_fg; reconstructed with +/-9.5% and narrow range.",
        }
    return values, mapping


def _top_k_position(score: pd.DataFrame, top_k: int, tradable: pd.DataFrame) -> pd.DataFrame:
    score = score.where(tradable)
    rank = score.rank(axis=1, ascending=False, method="first")
    return (rank <= top_k).astype(bool)


def _composite_score(values: dict[str, pd.DataFrame], factors: list[dict[str, Any]]) -> pd.DataFrame | None:
    ranks = []
    for factor in factors:
        factor_id = factor["id"]
        frame = values.get(factor_id)
        if frame is None:
            continue
        direction = float(factor.get("direction") or 1)
        score = frame * direction
        ranks.append(score.rank(axis=1, pct=True))
    if not ranks:
        return None
    return sum(ranks) / len(ranks)


def _extract_report(row_id: str, kind: str, meta: dict[str, Any], position: pd.DataFrame, report: Any, elapsed_s: float) -> dict[str, Any]:
    stats = report.get_stats()
    metrics = report.get_metrics()
    trades = report.get_trades()
    counts = position.sum(axis=1)
    return {
        "id": row_id,
        "kind": kind,
        **meta,
        "status": "ok",
        "elapsed_s": round(elapsed_s, 3),
        "cagr": _safe_float(stats.get("cagr")),
        "benchmark_alpha": _safe_float((metrics.get("profitability") or {}).get("alpha")),
        "benchmark_beta": _safe_float((metrics.get("profitability") or {}).get("beta")),
        "total_return": _safe_float(stats.get("total_return")),
        "max_drawdown": _safe_float(stats.get("max_drawdown")),
        "monthly_sharpe": _safe_float(stats.get("monthly_sharpe")),
        "monthly_sortino": _safe_float(stats.get("monthly_sortino")),
        "calmar": _safe_float(stats.get("calmar")),
        "win_ratio": _safe_float(stats.get("win_ratio")),
        "avg_n_stock": _safe_float((metrics.get("profitability") or {}).get("avgNStock")),
        "max_n_stock": _safe_float((metrics.get("profitability") or {}).get("maxNStock")),
        "trade_count": int(len(trades)),
        "avg_turnover_proxy": None,
        "match_days": int((counts > 0).sum()),
        "avg_daily_matches": _safe_float(counts.mean()),
        "max_daily_matches": int(counts.max()) if len(counts) else 0,
        "latest_matches": int(counts.iloc[-1]) if len(counts) else 0,
    }


def _run_sim(row_id: str, kind: str, meta: dict[str, Any], position: pd.DataFrame, args: argparse.Namespace) -> dict[str, Any]:
    from finlab.backtest import sim

    t0 = time.time()
    counts = position.sum(axis=1)
    if int(counts.sum()) == 0:
        return {
            "id": row_id,
            "kind": kind,
            **meta,
            "status": "no_signal",
            "elapsed_s": round(time.time() - t0, 3),
            "match_days": int((counts > 0).sum()),
            "avg_daily_matches": _safe_float(counts.mean()),
            "max_daily_matches": int(counts.max()) if len(counts) else 0,
            "latest_matches": int(counts.iloc[-1]) if len(counts) else 0,
        }
    try:
        report = sim(
            position,
            resample=args.resample,
            trade_at_price=args.trade_at_price,
            position_limit=float(args.position_limit),
            fee_ratio=0.001425,
            tax_ratio=0.003,
            name=f"stockvision_ab_{row_id}",
            upload=False,
            fast_mode=True,
            notification_enable=False,
        )
        return _extract_report(row_id, kind, meta, position, report, time.time() - t0)
    except Exception as exc:
        return {
            "id": row_id,
            "kind": kind,
            **meta,
            "status": "sim_error",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_s": round(time.time() - t0, 3),
            "match_days": int((counts > 0).sum()),
            "avg_daily_matches": _safe_float(counts.mean()),
            "max_daily_matches": int(counts.max()) if len(counts) else 0,
            "latest_matches": int(counts.iloc[-1]) if len(counts) else 0,
        }


COMPOSITES: dict[str, list[str]] = {
    "ab_academic_momentum": ["mom_9m", "mom_macd_trend_10", "mom_vol_adj_12m", "mom_close_to_52w_high", "mom_12m_1m"],
    "ab_channel_breakout": ["tech_donchian_pos_20", "tech_keltner_pos_20", "tech_sar", "tech_adx_14", "tech_volume_ratio_5"],
    "ab_low_vol_value": ["val_ep", "val_bp", "val_dp", "vola_realized_12m", "vola_min_130d", "tech_atr_14"],
    "ab_attention_flow": ["vol_chg_turnover_1y", "vol_signal_5d", "tech_obv", "tech_volume_ratio_5", "tech_vr_26"],
    "ab_defensive_momentum": ["mom_vol_adj_12m", "mom_close_to_52w_high", "vola_realized_1m", "vola_realized_12m", "tech_atr_14"],
    "ab_short_reversal": ["mom_reversal_1m", "tech_bias_20", "tech_williams_r_14", "tech_psy_12", "tech_mfi_14"],
}


def run(args: argparse.Namespace) -> dict[str, Any]:
    with open(args.factor_json, "r", encoding="utf-8-sig") as fh:
        factors = json.load(fh)
    if not isinstance(factors, list):
        raise RuntimeError("factor_json_must_be_list")

    base = _build_base_data(args.universe)
    close = base["close"].loc[: args.end_date]
    values, mapping = _build_factor_values(base)
    columns = close.columns.tolist()
    date_mask = (close.index >= pd.Timestamp(args.start_date)) & (close.index <= pd.Timestamp(args.end_date))
    date_frame = pd.DataFrame(np.repeat(np.asarray(date_mask)[:, None], len(columns), axis=1), index=close.index, columns=columns)
    tradable = close.notna() & date_frame

    results: list[dict[str, Any]] = []
    for factor in factors:
        factor_id = str(factor.get("id") or "")
        frame = values.get(factor_id)
        meta = {
            "factor_id": factor_id,
            "factor_name": factor.get("name"),
            "factor_name_zh": factor.get("name_zh"),
            "category": factor.get("category"),
            "direction": factor.get("direction"),
            "tags": factor.get("tags") or [],
            "mapping": mapping.get(factor_id, {"status": "not_mapped"}),
        }
        if frame is None:
            results.append({"id": factor_id, "kind": "single_factor", **meta, "status": "not_mapped"})
            continue
        score = frame * float(factor.get("direction") or 1)
        position = _top_k_position(score.loc[: args.end_date], args.top_k, tradable).loc[args.start_date : args.end_date]
        results.append(_run_sim(factor_id, "single_factor", meta, position, args))

    factor_by_id = {str(factor.get("id")): factor for factor in factors}
    composite_results: list[dict[str, Any]] = []
    if args.run_composites:
        for composite_id, factor_ids in COMPOSITES.items():
            selected = [factor_by_id[fid] for fid in factor_ids if fid in factor_by_id and fid in values]
            score = _composite_score(values, selected)
            meta = {
                "factor_id": composite_id,
                "factor_name": composite_id,
                "factor_name_zh": composite_id,
                "category": "composite",
                "direction": 1,
                "tags": ["composite"],
                "component_factors": factor_ids,
                "mapped_components": [str(factor.get("id")) for factor in selected],
            }
            if score is None:
                composite_results.append({"id": composite_id, "kind": "composite", **meta, "status": "not_mapped"})
                continue
            position = _top_k_position(score.loc[: args.end_date], args.top_k, tradable).loc[args.start_date : args.end_date]
            composite_results.append(_run_sim(composite_id, "composite", meta, position, args))

    return {
        "schema_version": "stockvision-finlab-alphabuilders-factor-backtest-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "config": {
            "start_date": args.start_date,
            "end_date": args.end_date,
            "resample": args.resample,
            "top_k": args.top_k,
            "position_limit": args.position_limit,
            "trade_at_price": args.trade_at_price,
            "universe": args.universe,
            "factor_count_input": len(factors),
            "note": "Top-k is used only as a research benchmark to measure raw factor edge, not as production selector.",
        },
        "feature_mapping": mapping,
        "results": results,
        "composite_results": composite_results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only FinLab backtest for AlphaBuilders factor catalog.")
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--run-composites", action="store_true")
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_alphabuilders_factor_backtests"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)

    stem = f"alphabuilders_factors_{args.universe}_{args.start_date}_{args.end_date}_top{args.top_k}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    csv_path = output_dir / f"{stem}.csv"
    composite_csv_path = output_dir / f"{stem}_composites.csv"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["results"]).to_csv(csv_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["composite_results"]).to_csv(composite_csv_path, index=False, encoding="utf-8-sig")

    rows = report["results"]
    summary = {
        "json": str(json_path),
        "csv": str(csv_path),
        "composite_csv": str(composite_csv_path),
        "factor_count_input": report["config"]["factor_count_input"],
        "ok": sum(1 for row in rows if row.get("status") == "ok"),
        "not_mapped": sum(1 for row in rows if row.get("status") == "not_mapped"),
        "no_signal": sum(1 for row in rows if row.get("status") == "no_signal"),
        "errors": [row for row in rows if row.get("status") not in {"ok", "not_mapped", "no_signal"}],
        "composites_ok": sum(1 for row in report["composite_results"] if row.get("status") == "ok"),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0 if not summary["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
