from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SPEC_RUNNER = ROOT / "tools" / "finlab_strategy_spec_backtest.py"
DEFAULT_ACTIVE_SPEC_JSON = ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, (pd.Series, pd.DataFrame)):
        return value.to_dict()
    if isinstance(value, set):
        return sorted(value)
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


def _common_stock_columns(close: pd.DataFrame, universe: str) -> list[str]:
    from finlab import data

    sec = pd.DataFrame(data.get("security_categories"))
    sec["symbol"] = sec["symbol"].astype(str).str.strip()
    sec["market"] = sec["market"].astype(str).str.lower().str.strip()
    allowed_markets = ["sii"] if universe == "sii" else ["sii", "otc"]
    allowed = set(sec.loc[sec["market"].isin(allowed_markets) & sec["symbol"].str.fullmatch(r"\d{4}"), "symbol"])
    return [col for col in close.columns if col in allowed]


def _true_range(high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame) -> pd.DataFrame:
    return pd.concat(
        [
            high - low,
            (high - close.shift()).abs(),
            (low - close.shift()).abs(),
        ],
        axis=0,
    ).groupby(level=0).max()


def _atr(high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame, period: int) -> pd.DataFrame:
    return _true_range(high, low, close).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def _rsi_wilder(close: pd.DataFrame, period: int) -> pd.DataFrame:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    out = out.where(loss != 0, 100)
    return out.where(~((loss == 0) & (gain == 0)), 50)


def _rank_pct(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.replace([np.inf, -np.inf], np.nan).rank(axis=1, pct=True)


def _clip(frame: pd.DataFrame, low: float = 0.0, high: float = 1.0) -> pd.DataFrame:
    return frame.clip(lower=low, upper=high)


def _month_end_mask(index: pd.Index) -> pd.Series:
    periods = pd.Series(pd.DatetimeIndex(index).to_period("M"), index=index)
    return periods.ne(periods.shift(-1)).fillna(True)


def _portfolio_returns(position: pd.DataFrame, close: pd.DataFrame, fee_tax_cost: float = 0.004425) -> pd.Series:
    aligned_close = close.reindex(index=position.index, columns=position.columns)
    daily_ret = aligned_close.pct_change(fill_method=None)
    weights = position.astype(float)
    row_sums = weights.sum(axis=1).replace(0, np.nan)
    weights = weights.div(row_sums, axis=0).fillna(0.0)
    held = weights.shift(1).fillna(0.0)
    gross = (held * daily_ret.fillna(0.0)).sum(axis=1)
    turnover = weights.diff().abs().sum(axis=1).fillna(weights.abs().sum(axis=1)) / 2.0
    return gross - turnover * fee_tax_cost


def _max_drawdown(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return 0.0
    equity = (1.0 + clean).cumprod()
    return float((equity / equity.cummax() - 1.0).min())


def _annualized_sharpe(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    if clean.empty:
        return 0.0
    std = float(clean.std(ddof=0))
    if std <= 1e-12:
        return 0.0
    return float(clean.mean() / std * np.sqrt(252))


def _cagr(returns: pd.Series) -> float:
    clean = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if clean.empty:
        return 0.0
    total = float((1.0 + clean).prod())
    if total <= 0:
        return -1.0
    years = max(len(clean) / 252.0, 1e-9)
    return float(total ** (1.0 / years) - 1.0)


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@dataclass(frozen=True)
class StrategyBuild:
    strategy_id: str
    name: str
    family_id: str
    alpha_bucket: str
    signal: pd.DataFrame
    score: pd.DataFrame
    exit_signal: pd.DataFrame
    max_hold_days: int
    entry_delay_days: int = 1
    monthly_rebalance: bool = False
    notes: tuple[str, ...] = ()


def _empty_bool(index: pd.Index, columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame(False, index=index, columns=columns)


def _top_symbols(signal_row: pd.Series, score_row: pd.Series, limit: int, exclude: set[str]) -> list[str]:
    hits = [str(col) for col, flag in signal_row.items() if bool(flag) and str(col) not in exclude]
    if not hits:
        return []
    ranked = (
        score_row.reindex(hits)
        .replace([np.inf, -np.inf], np.nan)
        .fillna(-1e18)
        .sort_values(ascending=False, kind="mergesort")
    )
    return [str(symbol) for symbol in ranked.index[:limit]]


def _event_positions(build: StrategyBuild, columns: list[str], max_positions: int) -> pd.DataFrame:
    index = build.signal.index
    position = _empty_bool(index, columns)
    active: dict[str, int] = {}
    for i in range(len(index) - build.entry_delay_days):
        target_i = i
        for symbol in active:
            position.iat[target_i, position.columns.get_loc(symbol)] = True

        if build.monthly_rebalance and bool(_month_end_mask(index).iloc[i]):
            selected = _top_symbols(build.signal.iloc[i], build.score.iloc[i], max_positions, set())
            active = {symbol: 0 for symbol in selected}
        else:
            to_remove: list[str] = []
            for symbol, age in active.items():
                if bool(build.exit_signal.iat[i, build.exit_signal.columns.get_loc(symbol)]) or age >= build.max_hold_days:
                    to_remove.append(symbol)
            for symbol in to_remove:
                active.pop(symbol, None)
            slots = max(0, max_positions - len(active))
            if slots > 0:
                selected = _top_symbols(build.signal.iloc[i], build.score.iloc[i], slots, set(active))
                for symbol in selected:
                    active[symbol] = 0

        active = {symbol: age + 1 for symbol, age in active.items()}
        next_i = i + build.entry_delay_days
        if next_i < len(index):
            for symbol in active:
                position.iat[next_i, position.columns.get_loc(symbol)] = True
    return position


def _rebalance_positions(build: StrategyBuild, columns: list[str], max_positions: int) -> pd.DataFrame:
    return _event_positions(build, columns, max_positions)


def _build_base(args: argparse.Namespace) -> dict[str, pd.DataFrame]:
    from finlab import data

    close_all = _df(data.get("price:收盤價"))
    columns = _common_stock_columns(close_all, args.universe)
    close = close_all.reindex(columns=columns).loc[: args.end_date]
    return {
        "close": close,
        "open": _df(data.get("price:開盤價")).reindex(index=close.index, columns=columns),
        "high": _df(data.get("price:最高價")).reindex(index=close.index, columns=columns),
        "low": _df(data.get("price:最低價")).reindex(index=close.index, columns=columns),
        "volume": _df(data.get("price:成交股數")).reindex(index=close.index, columns=columns),
    }


def _feature_set(base: dict[str, pd.DataFrame]) -> dict[str, Any]:
    open_ = base["open"]
    high = base["high"]
    low = base["low"]
    close = base["close"]
    volume = base["volume"]
    columns = list(close.columns)

    turnover = close * volume
    adv20 = turnover.rolling(20).mean()
    liquidity_pct = adv20.rank(axis=1, pct=True)
    listed_252 = close.notna().rolling(252).sum() >= 252
    no_missing_20 = close.notna().rolling(20).sum() >= 20
    eligible = listed_252 & no_missing_20 & turnover.gt(0) & liquidity_pct.ge(0.30)

    ret_daily = close.pct_change(fill_method=None)
    market_index = (1 + ret_daily.mean(axis=1).fillna(0.0)).cumprod() * 100.0
    index_ma50 = market_index.rolling(50).mean()
    index_ma200 = market_index.rolling(200).mean()
    mkt1 = market_index > index_ma200
    mkt2 = (market_index > index_ma200) & (index_ma50 > index_ma200)
    mkt1_df = pd.DataFrame(np.repeat(mkt1.to_numpy()[:, None], len(columns), axis=1), index=close.index, columns=columns)
    mkt2_df = pd.DataFrame(np.repeat(mkt2.to_numpy()[:, None], len(columns), axis=1), index=close.index, columns=columns)

    ma = {n: close.rolling(n).mean() for n in (5, 10, 20, 50, 60, 100, 120, 150, 200)}
    vma_prev = {n: volume.shift(1).rolling(n).mean() for n in (10, 20, 50)}
    hh_prev = {n: high.shift(1).rolling(n).max() for n in (20, 55, 60, 252)}
    ll_prev = {n: low.shift(1).rolling(n).min() for n in (5, 10, 20, 60)}
    range_prev = {
        20: hh_prev[20] / ll_prev[20].replace(0, np.nan) - 1,
        60: hh_prev[60] / ll_prev[60].replace(0, np.nan) - 1,
    }
    range_prev[10] = high.shift(1).rolling(10).max() / low.shift(1).rolling(10).min().replace(0, np.nan) - 1

    atr14 = _atr(high, low, close, 14)
    atr20 = _atr(high, low, close, 20)
    natr20 = atr20 / close.replace(0, np.nan)
    ret = {n: close / close.shift(n) - 1 for n in (20, 63, 126, 252)}
    rs = {}
    for n in (63, 126, 252):
        stock_log = np.log(close / close.shift(n))
        index_log = np.log(market_index / market_index.shift(n))
        rs[n] = stock_log.sub(index_log, axis=0)
    high_pos_252 = close / high.rolling(252).max().replace(0, np.nan)
    mom12_1 = close.shift(21) / close.shift(252) - 1
    vr20 = volume / vma_prev[20].replace(0, np.nan)

    day_range = (high - low).replace(0, np.nan)
    clv = ((close - low) / day_range).where(day_range.notna(), 0.5)
    body_frac = (close - open_).abs() / day_range
    upper_wick_frac = (high - pd.DataFrame(np.maximum(open_, close), index=close.index, columns=columns)) / day_range
    lower_wick_frac = (pd.DataFrame(np.minimum(open_, close), index=close.index, columns=columns) - low) / day_range
    rsi2 = _rsi_wilder(close, 2)
    rsi14 = _rsi_wilder(close, 14)

    return {
        "eligible": eligible,
        "market_index_source": "equal_weight_close_return_proxy",
        "market_index": market_index,
        "mkt1": mkt1_df,
        "mkt2": mkt2_df,
        "ma": ma,
        "vma_prev": vma_prev,
        "hh_prev": hh_prev,
        "ll_prev": ll_prev,
        "range_prev": range_prev,
        "atr14": atr14,
        "atr20": atr20,
        "natr20": natr20,
        "ret": ret,
        "rs": rs,
        "high_pos_252": high_pos_252,
        "mom12_1": mom12_1,
        "vr20": vr20,
        "clv": clv,
        "body_frac": body_frac,
        "upper_wick_frac": upper_wick_frac,
        "lower_wick_frac": lower_wick_frac,
        "day_range": high - low,
        "rsi2": rsi2,
        "rsi14": rsi14,
        "adv20": adv20,
    }


def _entry_chase_ok(base: dict[str, pd.DataFrame], atr14: pd.DataFrame, multiple: float) -> pd.DataFrame:
    return base["open"].shift(-1) <= base["close"] + multiple * atr14


def _build_s5(base: dict[str, pd.DataFrame], f: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    close = base["close"]
    high = base["high"]
    volume = base["volume"]
    columns = close.columns
    breakout = (
        close.gt(f["hh_prev"][60])
        & f["vr20"].ge(1.20)
        & close.gt(f["ma"][20])
        & f["ma"][20].gt(f["ma"][50])
        & f["ma"][50].gt(f["ma"][200])
    )
    trigger_base = (
        close.gt(base["open"])
        & close.gt(high.shift(1))
        & f["clv"].ge(0.75)
        & f["vr20"].ge(1.0)
    )
    signal = _empty_bool(close.index, list(columns))
    days_since = pd.DataFrame(np.nan, index=close.index, columns=columns)
    peak_since = pd.DataFrame(np.nan, index=close.index, columns=columns)
    close_gt_ma50_since = _empty_bool(close.index, list(columns))
    last_used_breakout: dict[str, int] = {}

    close_values = close.to_numpy(dtype=float)
    high_values = high.to_numpy(dtype=float)
    ma50_values = f["ma"][50].to_numpy(dtype=float)
    breakout_values = breakout.to_numpy(dtype=bool)
    trigger_values = trigger_base.to_numpy(dtype=bool)
    for c_idx, symbol in enumerate(columns):
        used = -1
        for i in range(len(close.index)):
            start = max(0, i - 15)
            end = i - 2
            if end <= start:
                continue
            candidates = np.flatnonzero(breakout_values[start:end, c_idx]) + start
            if len(candidates) == 0:
                continue
            b = int(candidates[-1])
            days_since.iat[i, c_idx] = i - b
            peak = np.nanmax(high_values[b:i, c_idx]) if i > b else np.nan
            peak_since.iat[i, c_idx] = peak
            path_ok = bool(np.all(close_values[b + 1 : i + 1, c_idx] > ma50_values[b + 1 : i + 1, c_idx]))
            close_gt_ma50_since.iat[i, c_idx] = path_ok
            if trigger_values[i, c_idx] and b != used:
                signal.iat[i, c_idx] = True
                used = b
        last_used_breakout[str(symbol)] = used

    pullback_dd = close / peak_since.replace(0, np.nan) - 1
    dist_ma20_atr = (close - f["ma"][20]).abs() / f["atr14"].replace(0, np.nan)
    pullback_vol3 = volume.shift(1).rolling(3).mean()
    baseline_vol20 = volume.shift(4).rolling(20).mean()
    pullback_vol_ratio = pullback_vol3 / baseline_vol20.replace(0, np.nan)
    pullback_quality = _clip(1 - (pullback_dd + 0.06).abs() / 0.06)
    dryup_quality = _clip(1 - pullback_vol_ratio)
    gates = (
        f["eligible"]
        & f["mkt2"]
        & days_since.ge(3)
        & days_since.le(15)
        & close.gt(f["ma"][20])
        & f["ma"][20].gt(f["ma"][50])
        & f["ma"][50].gt(f["ma"][200])
        & _rank_pct(f["rs"][63]).ge(0.80)
        & close_gt_ma50_since
        & pullback_dd.ge(-0.12)
        & pullback_dd.le(-0.03)
        & dist_ma20_atr.le(0.50)
        & pullback_vol_ratio.le(0.80)
    )
    signal = signal & gates & _entry_chase_ok(base, f["atr14"], 0.5)
    return signal, {
        "days_since_breakout": days_since,
        "pullback_dd": pullback_dd,
        "pullback_quality": pullback_quality,
        "dryup_quality": dryup_quality,
        "pullback_vol_ratio": pullback_vol_ratio,
    }


def _build_s10(base: dict[str, pd.DataFrame], f: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    close = base["close"]
    high = base["high"]
    low = base["low"]
    open_ = base["open"]
    columns = close.columns
    down_gap = high < low.shift(1)
    gap_down_atr = (low.shift(1) - high) / f["atr14"].shift(1).replace(0, np.nan)
    decline = close.shift(1) / close.shift(21) - 1
    down_ok = (
        down_gap
        & gap_down_atr.ge(0.10)
        & close.shift(1).lt(f["ma"][20].shift(1))
        & f["ma"][20].shift(1).lt(f["ma"][50].shift(1))
        & decline.le(-0.08)
    )

    signal = _empty_bool(close.index, list(columns))
    gap_up_atr = pd.DataFrame(np.nan, index=close.index, columns=columns)
    pre_decline = pd.DataFrame(np.nan, index=close.index, columns=columns)
    island_low = pd.DataFrame(np.nan, index=close.index, columns=columns)
    for c_idx, _symbol in enumerate(columns):
        down_col = down_ok.iloc[:, c_idx].to_numpy(dtype=bool)
        for i in range(len(close.index)):
            start = max(0, i - 5)
            candidates = np.flatnonzero(down_col[start:i]) + start
            if len(candidates) == 0:
                continue
            a = int(candidates[-1])
            if i - a < 1 or i - a > 5 or a <= 0:
                continue
            isl_high = float(np.nanmax(high.iloc[a:i, c_idx]))
            isl_low = float(np.nanmin(low.iloc[a:i, c_idx]))
            if not math.isfinite(isl_high) or not math.isfinite(isl_low):
                continue
            if not (isl_high < float(low.iat[a - 1, c_idx])):
                continue
            if not (float(low.iat[i, c_idx]) > isl_high):
                continue
            gu = (float(low.iat[i, c_idx]) - isl_high) / float(f["atr14"].iat[i, c_idx])
            if not math.isfinite(gu) or gu < 0.10:
                continue
            if not (
                float(close.iat[i, c_idx]) > float(open_.iat[i, c_idx])
                and float(f["clv"].iat[i, c_idx]) >= 0.70
                and float(f["vr20"].iat[i, c_idx]) >= 1.50
            ):
                continue
            signal.iat[i, c_idx] = True
            gap_up_atr.iat[i, c_idx] = gu
            pre_decline.iat[i, c_idx] = -float(decline.iat[a, c_idx])
            island_low.iat[i, c_idx] = isl_low
    signal = signal & f["eligible"] & _entry_chase_ok(base, f["atr14"], 0.5)
    return signal, {"gap_up_atr": gap_up_atr, "pre_decline": pre_decline, "island_low": island_low}


def _build_strategies(base: dict[str, pd.DataFrame], f: dict[str, Any]) -> list[StrategyBuild]:
    close = base["close"]
    open_ = base["open"]
    high = base["high"]
    low = base["low"]
    volume = base["volume"]
    eligible = f["eligible"]
    atr14 = f["atr14"]
    ma = f["ma"]
    rs63 = f["rs"][63]
    rs126 = f["rs"][126]
    ret126 = f["ret"][126]
    vr20 = f["vr20"]
    clv = f["clv"]
    natr20 = f["natr20"]

    s1_signal = (
        eligible
        & f["mkt2"]
        & close.gt(ma[50])
        & ma[50].gt(ma[200])
        & ma[50].gt(ma[50].shift(20))
        & close.gt(f["hh_prev"][55])
        & f["high_pos_252"].ge(0.80)
        & _rank_pct(rs126).ge(0.80)
        & vr20.ge(1.50)
        & _entry_chase_ok(base, atr14, 0.5)
    )
    s1_score = 100 * (0.35 * _rank_pct(rs126) + 0.25 * _rank_pct(ret126) + 0.20 * _rank_pct(vr20) + 0.20 * _rank_pct(-natr20))
    s1_exit = close.lt(f["ll_prev"][20]) | close.lt(ma[50])

    month_end = pd.DataFrame(
        np.repeat(_month_end_mask(close.index).to_numpy()[:, None], len(close.columns), axis=1),
        index=close.index,
        columns=close.columns,
    )
    s2_raw_score = 100 * (0.50 * _rank_pct(f["mom12_1"]) + 0.30 * _rank_pct(f["high_pos_252"]) + 0.20 * _rank_pct(rs126))
    s2_signal = (
        eligible
        & f["mkt1"]
        & month_end
        & close.gt(ma[200])
        & ma[100].gt(ma[200])
        & f["high_pos_252"].ge(0.90)
        & f["mom12_1"].gt(0)
        & _rank_pct(f["mom12_1"]).ge(0.80)
        & rs126.gt(0)
    )
    s2_exit = close.lt(ma[100]) | (_rank_pct(s2_raw_score).lt(0.70))

    contract20_60 = 1 - f["range_prev"][20] / f["range_prev"][60].replace(0, np.nan)
    contract10_20 = 1 - f["range_prev"][10] / f["range_prev"][20].replace(0, np.nan)
    contraction_score = 0.5 * _rank_pct(contract20_60) + 0.5 * _rank_pct(contract10_20)
    dryup = 1 - f["vma_prev"][10] / f["vma_prev"][50].replace(0, np.nan)
    s3_signal = (
        eligible
        & f["mkt2"]
        & close.gt(ma[50])
        & ma[50].gt(ma[150])
        & ma[150].gt(ma[200])
        & ma[200].gt(ma[200].shift(20))
        & f["high_pos_252"].ge(0.85)
        & _rank_pct(rs126).ge(0.75)
        & f["range_prev"][20].le(0.65 * f["range_prev"][60])
        & f["range_prev"][10].le(0.75 * f["range_prev"][20])
        & f["range_prev"][20].le(0.18)
        & f["vma_prev"][10].le(0.80 * f["vma_prev"][50])
        & close.gt(f["hh_prev"][20])
        & vr20.ge(1.50)
        & _entry_chase_ok(base, atr14, 0.5)
    )
    s3_score = 100 * (0.35 * _rank_pct(rs126) + 0.25 * contraction_score + 0.20 * _rank_pct(dryup) + 0.20 * _rank_pct(vr20))
    s3_exit = (close.lt(ma[20]) & close.shift(1).lt(ma[20].shift(1)))

    deduct20_raw = close - close.shift(20)
    deduct20_prev = close.shift(1) - close.shift(21)
    deduct20_atr = deduct20_raw / atr14.replace(0, np.nan)
    stretch = (close - f["hh_prev"][20]) / atr14.replace(0, np.nan)
    s4_signal = (
        eligible
        & f["mkt1"]
        & close.gt(ma[60])
        & ma[60].gt(ma[120])
        & deduct20_raw.gt(0)
        & deduct20_prev.le(0)
        & (close - close.shift(60)).gt(0)
        & close.gt(f["hh_prev"][20])
        & vr20.ge(1.30)
        & _rank_pct(rs63).ge(0.60)
        & stretch.le(0.50)
    )
    s4_score = 100 * (0.35 * _rank_pct(rs63) + 0.25 * _rank_pct(deduct20_atr) + 0.20 * _rank_pct(vr20) + 0.20 * _rank_pct(-stretch))
    s4_exit = ((close - close.shift(20)).lt(0) & close.lt(ma[20])) | close.lt(ma[60])

    s5_signal, s5_aux = _build_s5(base, f)
    s5_score = 100 * (0.40 * _rank_pct(rs63) + 0.25 * s5_aux["pullback_quality"] + 0.20 * s5_aux["dryup_quality"] + 0.15 * clv)
    s5_exit = close.lt(ma[20]) & close.shift(1).lt(ma[20].shift(1))

    setup_vr20 = volume.shift(1) / volume.shift(2).rolling(20).mean().replace(0, np.nan)
    nr7 = f["day_range"].shift(1).le(f["day_range"].shift(1).rolling(7).min())
    inside = high.shift(1).lt(high.shift(2)) & low.shift(1).gt(low.shift(2))
    s6_signal = (
        eligible
        & f["mkt2"]
        & close.shift(1).gt(ma[20].shift(1))
        & ma[20].shift(1).gt(ma[50].shift(1))
        & ma[50].shift(1).gt(ma[200].shift(1))
        & _rank_pct(rs63.shift(1)).ge(0.70)
        & inside
        & nr7
        & setup_vr20.le(0.70)
        & close.gt(high.shift(1))
        & vr20.ge(1.20)
        & clv.ge(0.70)
    )
    s6_score = 100 * (0.45 * _rank_pct(rs63) + 0.25 * _rank_pct(-natr20) + 0.20 * _rank_pct(vr20) + 0.10 * clv)
    s6_exit = close.lt(f["ll_prev"][10]) | close.lt(ma[20])

    support_s = low.shift(2).rolling(20).min()
    break_depth = (support_s - low.shift(1)) / atr14.shift(1).replace(0, np.nan)
    close_break_depth = (support_s - close.shift(1)) / atr14.shift(1).replace(0, np.nan)
    reclaim_strength = (close - support_s) / atr14.replace(0, np.nan)
    s7_signal = (
        eligible
        & f["mkt1"]
        & close.shift(2).gt(ma[200].shift(2))
        & ma[200].shift(2).gt(ma[200].shift(22))
        & low.shift(1).lt(support_s)
        & close.shift(1).lt(support_s)
        & break_depth.ge(0.10)
        & break_depth.le(1.00)
        & close_break_depth.gt(0)
        & close_break_depth.le(0.75)
        & vr20.shift(1).ge(1.50)
        & f["rsi2"].shift(1).le(10)
        & close.gt(support_s)
        & close.gt(open_)
        & close.gt((high.shift(1) + low.shift(1)) / 2)
        & clv.ge(0.70)
        & vr20.ge(1.00)
    )
    s7_score = 100 * (0.35 * _rank_pct(reclaim_strength) + 0.25 * _rank_pct(vr20.shift(1)) + 0.20 * _rank_pct(-f["rsi2"].shift(1)) + 0.20 * _rank_pct(rs126))
    s7_exit = close.ge(ma[20]) | f["rsi2"].ge(80)

    ma5_distance = (ma[5] - close) / atr14.replace(0, np.nan)
    s8_signal = (
        eligible
        & f["mkt1"]
        & close.gt(ma[200])
        & ma[50].gt(ma[200])
        & ma[200].gt(ma[200].shift(20))
        & rs126.gt(0)
        & f["rsi2"].le(5)
        & ma5_distance.ge(0.50)
        & vr20.lt(3.00)
        & _entry_chase_ok(base, atr14, 0.5)
    )
    s8_score = 100 * (0.40 * _rank_pct(-f["rsi2"]) + 0.35 * _rank_pct(rs126) + 0.25 * _rank_pct(-vr20))
    s8_exit = close.gt(ma[5]) | f["rsi2"].ge(70) | close.lt(ma[200])

    base_top = high.shift(3).rolling(20).max()
    base_bottom = low.shift(3).rolling(20).min()
    base_width = base_top / base_bottom.replace(0, np.nan) - 1
    candle_ok = close.gt(open_) & f["body_frac"].ge(0.55) & f["upper_wick_frac"].le(0.25) & clv.ge(0.70)
    three_candles = candle_ok & candle_ok.shift(1) & candle_ok.shift(2)
    opens_inside = open_.shift(1).ge(open_.shift(2)) & open_.shift(1).le(close.shift(2)) & open_.ge(open_.shift(1)) & open_.le(close.shift(1))
    ret3 = close / close.shift(3) - 1
    vol3_ratio = volume.rolling(3).mean() / volume.shift(3).rolling(20).mean().replace(0, np.nan)
    heat_quality = _clip(1 - (ret3 - 0.03) / 0.09)
    s9_signal = (
        eligible
        & f["mkt1"]
        & base_width.le(0.15)
        & three_candles
        & close.shift(1).gt(close.shift(2))
        & close.gt(close.shift(1))
        & opens_inside
        & ret3.ge(0.03)
        & ret3.le(0.12)
        & close.gt(base_top)
        & close.gt(ma[50])
        & ma[50].ge(ma[50].shift(10))
        & vol3_ratio.ge(1.20)
        & _entry_chase_ok(base, atr14, 0.3)
    )
    s9_score = 100 * (0.35 * _rank_pct(rs63) + 0.25 * _rank_pct(vol3_ratio) + 0.20 * _rank_pct(-base_width) + 0.20 * heat_quality)
    s9_exit = close.lt(ma[10])

    s10_signal, s10_aux = _build_s10(base, f)
    s10_score = 100 * (0.35 * _rank_pct(vr20) + 0.25 * _rank_pct(s10_aux["gap_up_atr"]) + 0.20 * _rank_pct(s10_aux["pre_decline"]) + 0.20 * clv)
    s10_exit = close.ge(ma[50]) | close.ge(f["hh_prev"][20])

    gap_pct = open_ / close.shift(1) - 1
    gap_quality = _clip(1 - (gap_pct - 0.03).abs() / 0.02)
    range_atr = (high - low) / atr14.replace(0, np.nan)
    s11_signal = (
        eligible
        & f["mkt2"]
        & close.shift(1).gt(ma[50].shift(1))
        & ma[50].shift(1).gt(ma[200].shift(1))
        & _rank_pct(rs63.shift(1)).ge(0.80)
        & gap_pct.ge(0.01)
        & gap_pct.le(0.05)
        & open_.gt(high.shift(1))
        & close.gt(open_)
        & close.gt(f["hh_prev"][20])
        & clv.ge(0.75)
        & vr20.ge(2.00)
        & range_atr.le(2.50)
        & _entry_chase_ok(base, atr14, 0.3)
    )
    s11_score = 100 * (0.35 * _rank_pct(rs63) + 0.25 * _rank_pct(vr20) + 0.20 * clv + 0.20 * gap_quality)
    s11_exit = close.lt(ma[10]) | close.lt(f["ll_prev"][10])

    return [
        StrategyBuild("stock_tech_s01_55d_trend_volume_breakout_v1", "S1 55d trend volume breakout", "TREND_RECLAIM_CONTINUATION", "breakout_vol_expansion", s1_signal, s1_score, s1_exit, 40),
        StrategyBuild("stock_tech_s02_52w_dual_momentum_v1", "S2 52w dual momentum", "TREND_RECLAIM_CONTINUATION", "trend_following", s2_signal, s2_raw_score, s2_exit, 63, monthly_rebalance=True),
        StrategyBuild("stock_tech_s03_vcp_contraction_breakout_v1", "S3 VCP contraction breakout", "VOLATILITY_CONTRACTION_BREAKOUT", "breakout_vol_expansion", s3_signal, s3_score, s3_exit, 30),
        StrategyBuild("stock_tech_s04_ma_deduct_turn_breakout_v1", "S4 MA deduct turn breakout", "TREND_RECLAIM_CONTINUATION", "trend_following", s4_signal, s4_score, s4_exit, 25),
        StrategyBuild("stock_tech_s05_first_dry_pullback_v1", "S5 first dry pullback", "TREND_RECLAIM_CONTINUATION", "trend_following", s5_signal, s5_score, s5_exit, 30, notes=("S5 breakout event state is implemented; stop-to-breakeven is not represented in FinLab boolean positions.",)),
        StrategyBuild("stock_tech_s06_nr7_inside_bar_breakout_v1", "S6 NR7 inside bar breakout", "VOLATILITY_CONTRACTION_BREAKOUT", "breakout_vol_expansion", s6_signal, s6_score, s6_exit, 20),
        StrategyBuild("stock_tech_s07_2b_false_break_reversal_v1", "S7 2B false break reversal", "TREND_RECLAIM_CONTINUATION", "mean_reversion", s7_signal, s7_score, s7_exit, 10),
        StrategyBuild("stock_tech_s08_rsi2_bull_mean_reversion_v1", "S8 RSI2 bull mean reversion", "TREND_RECLAIM_CONTINUATION", "mean_reversion", s8_signal, s8_score, s8_exit, 5),
        StrategyBuild("stock_tech_s09_three_soldiers_base_breakout_v1", "S9 three soldiers base breakout", "VOLATILITY_CONTRACTION_BREAKOUT", "breakout_vol_expansion", s9_signal, s9_score, s9_exit, 20),
        StrategyBuild("stock_tech_s10_island_reversal_v1", "S10 island reversal", "VOLATILITY_CONTRACTION_BREAKOUT", "mean_reversion", s10_signal, s10_score, s10_exit, 20),
        StrategyBuild("stock_tech_s11_gap_breakout_continuation_v1", "S11 gap breakout continuation", "VOLATILITY_CONTRACTION_BREAKOUT", "breakout_vol_expansion", s11_signal, s11_score, s11_exit, 20),
    ]


def _extract_finlab_result(strategy_id: str, build: StrategyBuild | dict[str, Any], position: pd.DataFrame, report: Any, elapsed_s: float) -> dict[str, Any]:
    stats = report.get_stats()
    metrics = report.get_metrics()
    trades = report.get_trades()
    counts = position.sum(axis=1)
    if isinstance(build, StrategyBuild):
        name = build.name
        family_id = build.family_id
        alpha_bucket = build.alpha_bucket
        notes = list(build.notes)
        group = "technical12"
    else:
        name = build.get("name")
        family_id = build.get("familyId")
        alpha_bucket = build.get("alphaBucket")
        notes = []
        group = "active_strategy_spec"
    proxy_returns = _portfolio_returns(position, position.attrs["close_for_returns"])
    return {
        "strategy_id": strategy_id,
        "strategy_group": group,
        "name": name,
        "family_id": family_id,
        "alpha_bucket": alpha_bucket,
        "status": "ok",
        "elapsed_s": round(elapsed_s, 3),
        "cagr": _safe_float(stats.get("cagr")),
        "monthly_sharpe": _safe_float(stats.get("monthly_sharpe")),
        "max_drawdown": _safe_float(stats.get("max_drawdown")),
        "MOD": _safe_float(stats.get("max_drawdown")),
        "calmar": _safe_float(stats.get("calmar")),
        "win_ratio": _safe_float(stats.get("win_ratio")),
        "total_return": _safe_float(stats.get("total_return")),
        "benchmark_alpha": _safe_float((metrics.get("profitability") or {}).get("alpha")),
        "benchmark_beta": _safe_float((metrics.get("profitability") or {}).get("beta")),
        "trade_count": int(len(trades)),
        "avg_trade_return": _safe_float(trades["return"].mean()) if len(trades) and "return" in trades else None,
        "median_trade_return": _safe_float(trades["return"].median()) if len(trades) and "return" in trades else None,
        "match_days": int((counts > 0).sum()),
        "avg_daily_positions": _safe_float(counts.mean()),
        "max_daily_positions": int(counts.max()) if len(counts) else 0,
        "latest_positions": int(counts.iloc[-1]) if len(counts) else 0,
        "proxy_cagr": _cagr(proxy_returns),
        "proxy_sharpe": _annualized_sharpe(proxy_returns),
        "proxy_max_drawdown": _max_drawdown(proxy_returns),
        "notes": notes,
    }


def _run_sim(strategy_id: str, build: StrategyBuild | dict[str, Any], position: pd.DataFrame, close: pd.DataFrame, args: argparse.Namespace) -> dict[str, Any]:
    from finlab.backtest import sim

    t0 = time.time()
    position = position.loc[args.start_date : args.end_date].copy()
    position.attrs["close_for_returns"] = close.loc[position.index.min() : position.index.max()].reindex(index=position.index, columns=position.columns)
    counts = position.sum(axis=1)
    if int(counts.sum()) == 0:
        return {
            "strategy_id": strategy_id,
            "strategy_group": "technical12" if isinstance(build, StrategyBuild) else "active_strategy_spec",
            "name": build.name if isinstance(build, StrategyBuild) else build.get("name"),
            "family_id": build.family_id if isinstance(build, StrategyBuild) else build.get("familyId"),
            "alpha_bucket": build.alpha_bucket if isinstance(build, StrategyBuild) else build.get("alphaBucket"),
            "status": "no_signal",
            "elapsed_s": round(time.time() - t0, 3),
            "match_days": int((counts > 0).sum()),
            "avg_daily_positions": _safe_float(counts.mean()),
            "max_daily_positions": int(counts.max()) if len(counts) else 0,
            "latest_positions": int(counts.iloc[-1]) if len(counts) else 0,
        }
    try:
        report = sim(
            position,
            resample=None if args.resample.lower() in {"none", ""} else args.resample,
            trade_at_price=args.trade_at_price,
            position_limit=float(args.position_limit),
            fee_ratio=0.001425,
            tax_ratio=0.003,
            name=f"stockvision_{strategy_id}",
            upload=False,
            fast_mode=True,
            notification_enable=False,
        )
        return _extract_finlab_result(strategy_id, build, position, report, time.time() - t0)
    except Exception as exc:
        return {
            "strategy_id": strategy_id,
            "strategy_group": "technical12" if isinstance(build, StrategyBuild) else "active_strategy_spec",
            "name": build.name if isinstance(build, StrategyBuild) else build.get("name"),
            "family_id": build.family_id if isinstance(build, StrategyBuild) else build.get("familyId"),
            "alpha_bucket": build.alpha_bucket if isinstance(build, StrategyBuild) else build.get("alphaBucket"),
            "status": "sim_error",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_s": round(time.time() - t0, 3),
            "match_days": int((counts > 0).sum()),
            "avg_daily_positions": _safe_float(counts.mean()),
            "max_daily_positions": int(counts.max()) if len(counts) else 0,
            "latest_positions": int(counts.iloc[-1]) if len(counts) else 0,
        }


def _active_spec_positions(base: dict[str, pd.DataFrame], args: argparse.Namespace) -> tuple[dict[str, pd.DataFrame], list[dict[str, Any]], list[str]]:
    spec_path = Path(args.active_spec_json)
    if not args.include_active_specs or not spec_path.exists():
        return {}, [], []
    spec_runner = _load_module(SPEC_RUNNER, "stockvision_finlab_strategy_spec_backtest_imported")
    with spec_path.open("r", encoding="utf-8-sig") as fh:
        specs = json.load(fh)
    close = base["close"]
    columns = list(close.columns)
    features = spec_runner._technical_features(close, base["high"], base["low"], base["volume"])
    features["open"] = base["open"]
    warnings: list[str] = []
    try:
        features.update(spec_runner._financial_features(close, columns))
    except Exception as exc:
        warnings.append(f"active_spec_financial_features_failed:{type(exc).__name__}:{exc}")
    try:
        features.update(spec_runner._chip_features(close, columns))
    except Exception as exc:
        warnings.append(f"active_spec_chip_features_failed:{type(exc).__name__}:{exc}")
    try:
        features.update(spec_runner._sector_features(close, base["volume"], columns))
    except Exception as exc:
        warnings.append(f"active_spec_sector_features_failed:{type(exc).__name__}:{exc}")
    try:
        alpha_features, alpha_mapping = spec_runner._alpha_miner_scores(
            specs,
            args,
            close,
            base["open"],
            base["high"],
            base["low"],
            features,
            columns,
        )
        features.update(alpha_features)
        if alpha_mapping and alpha_mapping.get("status") == "failed":
            warnings.append(f"active_spec_alpha_miner_features_failed:{alpha_mapping.get('error')}")
    except Exception as exc:
        warnings.append(f"active_spec_alpha_miner_features_failed:{type(exc).__name__}:{exc}")
    date_mask = (close.index >= pd.Timestamp(args.start_date)) & (close.index <= pd.Timestamp(args.end_date))
    date_frame = pd.DataFrame(np.repeat(np.asarray(date_mask)[:, None], len(columns), axis=1), index=close.index, columns=columns)
    universe_mask = close.notna() & (close >= 10) & date_frame
    positions: dict[str, pd.DataFrame] = {}
    loaded_specs: list[dict[str, Any]] = []
    for spec in specs:
        sid = str(spec.get("id") or "")
        pos = spec_runner._position_for_spec(spec, features, close, universe_mask)
        positions[sid] = pos.reindex(index=close.index, columns=columns).fillna(False).astype(bool)
        loaded_specs.append(spec)
    return positions, loaded_specs, warnings


def _pairwise(positions: dict[str, pd.DataFrame], returns: dict[str, pd.Series]) -> list[dict[str, Any]]:
    ids = sorted(positions)
    rows: list[dict[str, Any]] = []
    for i, left_id in enumerate(ids):
        left = positions[left_id].fillna(False).astype(bool)
        left_latest = set(left.columns[left.iloc[-1].to_numpy(dtype=bool)])
        left_flat = left.to_numpy(dtype=bool).reshape(-1)
        for right_id in ids[i + 1 :]:
            right = positions[right_id].reindex(index=left.index, columns=left.columns).fillna(False).astype(bool)
            right_latest = set(right.columns[right.iloc[-1].to_numpy(dtype=bool)])
            right_flat = right.to_numpy(dtype=bool).reshape(-1)
            union_latest = left_latest | right_latest
            inter_latest = left_latest & right_latest
            union_flat = int(np.logical_or(left_flat, right_flat).sum())
            inter_flat = int(np.logical_and(left_flat, right_flat).sum())
            try:
                phi = float(np.corrcoef(left_flat.astype(float), right_flat.astype(float))[0, 1])
            except Exception:
                phi = float("nan")
            joined_returns = pd.concat([returns[left_id], returns[right_id]], axis=1).dropna()
            return_corr = None
            if len(joined_returns) > 2:
                return_corr = _safe_float(joined_returns.iloc[:, 0].corr(joined_returns.iloc[:, 1]))
            rows.append(
                {
                    "left_id": left_id,
                    "right_id": right_id,
                    "left_latest_count": len(left_latest),
                    "right_latest_count": len(right_latest),
                    "latest_intersection_count": len(inter_latest),
                    "latest_union_count": len(union_latest),
                    "latest_jaccard": round(len(inter_latest) / len(union_latest), 6) if union_latest else None,
                    "all_period_intersection_cells": inter_flat,
                    "all_period_union_cells": union_flat,
                    "all_period_jaccard": round(inter_flat / union_flat, 6) if union_flat else None,
                    "position_phi_corr": _safe_float(phi),
                    "return_corr": return_corr,
                }
            )
    return rows


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    base = _build_base(args)
    features = _feature_set(base)
    close = base["close"]
    columns = list(close.columns)
    builds = _build_strategies(base, features)

    positions: dict[str, pd.DataFrame] = {}
    build_by_id: dict[str, StrategyBuild | dict[str, Any]] = {}
    for build in builds:
        pos = _rebalance_positions(build, columns, args.max_positions) if build.monthly_rebalance else _event_positions(build, columns, args.max_positions)
        positions[build.strategy_id] = pos
        build_by_id[build.strategy_id] = build

    active_positions, active_specs, active_warnings = _active_spec_positions(base, args)
    if args.include_active_specs:
        for spec in active_specs:
            sid = str(spec.get("id") or "")
            if sid in active_positions:
                positions[sid] = active_positions[sid]
                build_by_id[sid] = spec

    results = [_run_sim(sid, build_by_id[sid], pos, close, args) for sid, pos in positions.items()]
    returns = {
        sid: _portfolio_returns(pos.loc[args.start_date : args.end_date], close.loc[: args.end_date].reindex(index=pos.loc[args.start_date : args.end_date].index, columns=pos.columns))
        for sid, pos in positions.items()
    }
    pairwise_rows = _pairwise({sid: pos.loc[args.start_date : args.end_date] for sid, pos in positions.items()}, returns)
    return_corr = pd.DataFrame({sid: series for sid, series in returns.items()}).corr().replace([np.inf, -np.inf], np.nan)

    s12_result = {
        "strategy_id": "stock_tech_s12_multitimeframe_smc_reclaim_v1",
        "strategy_group": "technical12",
        "name": "S12 multi-timeframe SMC reclaim",
        "family_id": "SMC_STRUCTURE_RECLAIM",
        "alpha_bucket": "breakout_vol_expansion",
        "status": "unsupported_intraday_data",
        "reason": "requires completed 15m/1h/4h bars, pivot confirmation, OB/FVG state, and intraday execution; daily FinLab OHLCV is not a valid proxy",
    }
    results.append(s12_result)

    return {
        "schema_version": "stockvision-finlab-technical-strategy12-backtest-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "config": {
            "start_date": args.start_date,
            "end_date": args.end_date,
            "universe": args.universe,
            "max_positions": args.max_positions,
            "position_limit": args.position_limit,
            "trade_at_price": args.trade_at_price,
            "resample": args.resample,
            "include_active_specs": bool(args.include_active_specs),
            "active_spec_json": str(Path(args.active_spec_json)),
        },
        "implementation_caveats": [
            "S1-S11 are daily FinLab research benchmarks using boolean target positions.",
            "ATR-based hard stops, partial exits, and intraday stop-before-target ordering are not fully represented by boolean positions.",
            "Entry chase cancellation uses next open as an execution-time fill filter.",
            "Market filter uses equal-weight close-return proxy because the existing FinLab StrategySpec runner did not define a TAIEX dataset.",
            "S12 is registered separately but not backtested with daily data.",
        ],
        "active_spec_warnings": active_warnings,
        "results": results,
        "pairwise": pairwise_rows,
        "return_corr": return_corr.to_dict(),
        "runtime_seconds": round(time.time() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only FinLab benchmark for 12 technical StrategySpec candidates.")
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii_otc")
    parser.add_argument("--max-positions", type=int, default=10)
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="open")
    parser.add_argument("--resample", default="D")
    parser.add_argument("--include-active-specs", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--active-spec-json", default=str(DEFAULT_ACTIVE_SPEC_JSON))
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_technical_strategy12_backtests"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    stem = f"technical_strategy12_{args.universe}_{args.start_date}_{args.end_date}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    csv_path = output_dir / f"{stem}_results.csv"
    pairwise_path = output_dir / f"{stem}_pairwise.csv"
    corr_path = output_dir / f"{stem}_return_corr.csv"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["results"]).to_csv(csv_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["pairwise"]).to_csv(pairwise_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["return_corr"]).to_csv(corr_path, encoding="utf-8-sig")
    rows = report["results"]
    summary = {
        "json": str(json_path),
        "results_csv": str(csv_path),
        "pairwise_csv": str(pairwise_path),
        "return_corr_csv": str(corr_path),
        "technical12_ok": sum(1 for row in rows if row.get("strategy_group") == "technical12" and row.get("status") == "ok"),
        "active_spec_ok": sum(1 for row in rows if row.get("strategy_group") == "active_strategy_spec" and row.get("status") == "ok"),
        "no_signal": [row["strategy_id"] for row in rows if row.get("status") == "no_signal"],
        "errors": [row for row in rows if row.get("status") == "sim_error"],
        "unsupported": [row for row in rows if row.get("status") == "unsupported_intraday_data"],
        "runtime_seconds": report["runtime_seconds"],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0 if not summary["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
