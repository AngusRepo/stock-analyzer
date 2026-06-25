from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
STATUS_SCOPES = {
    "active": {"active"},
    "runtime": {"active", "candidate", "shadow", "research"},
}

ALPHA_MINER_SCORE_SPECS = {
    "alphaMinerPymoo0081Score": {
        "candidate_id": "pymoo_nsga3_novelty_0081",
        "factor_ids": ["KLOW2", "advance_ratio", "CNTD_20", "KSFT"],
        "weights": [0.415128, 0.117772, 0.20684, 0.260259],
    },
    "alphaMinerPymoo0187Score": {
        "candidate_id": "pymoo_nsga3_novelty_0187",
        "factor_ids": ["KSFT2", "l1_monthlyRevenueMoM", "CNTN_20", "ma10_bias", "return_5d"],
        "weights": [0.300141, 0.056417, 0.106408, 0.351215, 0.185819],
    },
    "alphaMinerPymoo0193Score": {
        "candidate_id": "pymoo_nsga3_novelty_0193",
        "factor_ids": ["us_sentiment_score", "margin_balance"],
        "weights": [0.479025, 0.520975],
    },
}
ALPHA_MINER_FACTOR_DIRECTIONS = {
    "KLOW2": -1.0,
    "advance_ratio": 1.0,
    "CNTD_20": 1.0,
    "KSFT": -1.0,
    "KSFT2": -1.0,
    "l1_monthlyRevenueMoM": -1.0,
    "CNTN_20": -1.0,
    "ma10_bias": -1.0,
    "return_5d": 1.0,
    "us_sentiment_score": 1.0,
    "margin_balance": 1.0,
}


def _rel(path: Path | str) -> str:
    resolved = Path(path)
    try:
        return resolved.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        if not np.isfinite(value):
            return None
        return float(value)
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, (pd.Series, pd.DataFrame)):
        return value.to_dict()
    return str(value)


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _as_dt_index(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(df).copy()
    out.index = pd.to_datetime(out.index)
    out = out.sort_index()
    out.columns = [str(col).strip() for col in out.columns]
    return out


def _common_stock_columns(close: pd.DataFrame) -> list[str]:
    from finlab import data

    sec = pd.DataFrame(data.get("security_categories"))
    sec["symbol"] = sec["symbol"].astype(str).str.strip()
    sec["market"] = sec["market"].astype(str).str.lower().str.strip()
    allowed = set(sec.loc[sec["market"].isin(["sii", "otc"]) & sec["symbol"].str.fullmatch(r"\d{4}"), "symbol"])
    return [col for col in close.columns if col in allowed]


def _align(df: pd.DataFrame, index: pd.Index, columns: list[str], *, ffill: bool = True) -> pd.DataFrame:
    out = pd.DataFrame(df).copy()
    out.index = pd.to_datetime(out.index)
    out.columns = [str(col).strip() for col in out.columns]
    out = out.infer_objects(copy=False)
    out = out.reindex(columns=columns)
    out = out.reindex(index)
    if ffill:
        out = out.ffill()
    out = out.infer_objects(copy=False)
    return out


def _nan_panel(index: pd.Index, columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame(np.nan, index=pd.to_datetime(index), columns=columns)


def _requires_alpha_miner_scores(specs: list[dict[str, Any]]) -> bool:
    score_keys = set(ALPHA_MINER_SCORE_SPECS)
    for spec in specs:
        thresholds = spec.get("thresholds") or {}
        for group_key in ("minFactorSignals", "maxFactorSignals"):
            if score_keys.intersection((thresholds.get(group_key) or {}).keys()):
                return True
        dsl = thresholds.get("dsl") or {}
        for condition_group in ("all", "any", "not"):
            for condition in dsl.get(condition_group) or []:
                if _normalize_feature_key(str(condition.get("signal") or "")) in score_keys:
                    return True
    return False


def _rank_pct(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.replace([np.inf, -np.inf], np.nan).rank(axis=1, pct=True)


def _normalize_weights(weights: list[float]) -> list[float]:
    arr = np.asarray([max(0.0, float(weight)) for weight in weights], dtype=float)
    total = float(arr.sum())
    if total <= 0:
        return [1.0 / len(weights)] * len(weights)
    return [float(weight / total) for weight in arr]


def _safe_div(left: pd.DataFrame, right: pd.DataFrame) -> pd.DataFrame:
    return left / right.replace(0, np.nan)


def _load_margin_balance(close: pd.DataFrame, columns: list[str]) -> tuple[pd.DataFrame, str]:
    from finlab import data

    cache_mode = os.environ.get("STOCKVISION_CHIP_FEATURE_SOURCE", "finlab_first").strip().lower()
    cache = _load_chip_cache_panel(close, columns)
    try:
        raw = _align(data.get("margin_transactions:融資今日餘額"), close.index, columns, ffill=True)
        source = "finlab:margin_transactions:融資今日餘額"
    except Exception as exc:
        print(f"[warn] dataset_failed margin_transactions:margin_balance: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raw = _nan_panel(close.index, columns)
        source = "missing"
    if not raw.notna().to_numpy().any():
        fallback_paths = sorted(
            (ROOT / "data" / "finlab_remote_backfill").glob("finlab-v4-5y-*/raw/chip_diversity/margin_balance.parquet"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for path in fallback_paths:
            try:
                fallback = _align(pd.read_parquet(path), close.index, columns, ffill=True)
            except Exception as exc:  # noqa: BLE001 - research fallback must fail soft
                print(f"[warn] margin_balance_fallback_failed {path}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
                continue
            if fallback.notna().to_numpy().any():
                raw = fallback
                source = f"local_backfill:{_rel(path)}"
                break
    if cache is not None and cache_mode == "cache_only":
        return cache["margin"], "chip_cache:margin_balance"
    if cache is not None and cache_mode == "cache_first":
        return cache["margin"].combine_first(raw), "chip_cache_first:margin_balance"
    return raw, source


def _alpha_miner_factor_frames(
    close: pd.DataFrame,
    open_: pd.DataFrame,
    high: pd.DataFrame,
    low: pd.DataFrame,
    features: dict[str, pd.DataFrame],
    columns: list[str],
) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    open_proxy = open_.where(open_.notna(), close)
    high_low = high - low
    candle_body_low = open_proxy.where(open_proxy <= close, close)
    up = (close > close.shift(1)).astype(float)
    down = (close < close.shift(1)).astype(float)
    advance_ratio = up.sum(axis=1) / close.notna().sum(axis=1).replace(0, np.nan)
    margin_balance, margin_source = _load_margin_balance(close, columns)
    constant_us_sentiment = pd.DataFrame(0.0, index=close.index, columns=columns)

    frames = {
        "KLOW2": _safe_div(candle_body_low - low, high_low).clip(0.0, 1.0),
        "advance_ratio": pd.DataFrame(
            np.repeat(advance_ratio.to_numpy(dtype=float)[:, None], len(columns), axis=1),
            index=close.index,
            columns=columns,
        ),
        "CNTD_20": up.rolling(20).sum().fillna(0.0) / 20.0 - down.rolling(20).sum().fillna(0.0) / 20.0,
        "KSFT": _safe_div(2.0 * close - high - low, open_proxy).clip(-0.2, 0.2),
        "KSFT2": _safe_div(2.0 * close - high - low, high_low).clip(-1.0, 1.0),
        "l1_monthlyRevenueMoM": features.get("monthlyRevenueMoM", _nan_panel(close.index, columns)),
        "CNTN_20": down.rolling(20).sum().fillna(0.0) / 20.0,
        "ma10_bias": close / close.rolling(10).mean().replace(0, np.nan) - 1.0,
        "return_5d": close / close.shift(5).replace(0, np.nan) - 1.0,
        "us_sentiment_score": constant_us_sentiment,
        "margin_balance": margin_balance,
    }
    return frames, {
        "factor_source": "direct_adapter_reconstruction",
        "formula_source": "canonical114_mresample promoted alphaMiner active specs",
        "direction_source": "output/finlab_alpha_miner_canonical114_mresample factor_meta",
        "margin_balance_source": margin_source,
        "advance_ratio_source": "FinLab sii_otc close cross-section daily up ratio broadcast to symbols",
        "us_sentiment_score_source": "constant_zero_proxy_ranked_cross_sectionally",
        "us_sentiment_score_limitation": "non-constant historical US sentiment is not materialized in this adapter; 0193 is research-only until that feature exists.",
    }


def _alpha_miner_scores(
    specs: list[dict[str, Any]],
    args: argparse.Namespace,
    close: pd.DataFrame,
    open_: pd.DataFrame,
    high: pd.DataFrame,
    low: pd.DataFrame,
    features: dict[str, pd.DataFrame],
    columns: list[str],
) -> tuple[dict[str, pd.DataFrame], dict[str, Any] | None]:
    if not _requires_alpha_miner_scores(specs):
        return {}, None
    try:
        factor_frames, provider_info = _alpha_miner_factor_frames(close, open_, high, low, features, columns)
        out: dict[str, pd.DataFrame] = {}
        materialized: dict[str, Any] = {}
        for score_key, config in ALPHA_MINER_SCORE_SPECS.items():
            frames: list[pd.DataFrame] = []
            missing: list[str] = []
            weights = _normalize_weights(list(config["weights"]))
            for factor_id, weight in zip(config["factor_ids"], weights):
                frame = factor_frames.get(str(factor_id))
                if frame is None or not frame.notna().to_numpy().any():
                    missing.append(str(factor_id))
                    continue
                direction = float(ALPHA_MINER_FACTOR_DIRECTIONS.get(str(factor_id), 1.0))
                frames.append(_rank_pct(frame * direction) * weight)
            if not frames:
                materialized[score_key] = {"status": "no_score", "missing": missing or list(config["factor_ids"])}
                continue
            aligned = sum(frames).replace([np.inf, -np.inf], np.nan).reindex(index=close.index, columns=columns)
            out[score_key] = aligned
            materialized[score_key] = {
                "status": "ok",
                "candidate_id": str(config["candidate_id"]),
                "factor_ids": list(config["factor_ids"]),
                "weights": weights,
                "missing": missing,
                "coverage": _safe_float(aligned.notna().mean().mean()),
            }
        return out, {
            **provider_info,
            "universe": "sii_otc",
            "materialized": materialized,
        }
    except Exception as exc:  # noqa: BLE001 - alpha-miner provider must fail soft for non-alpha specs
        print(f"[warn] alpha_miner_score_provider_failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return {}, {
            "provider": "finlab_alpha_miner_bakeoff._build_unified_registry_factor_universe",
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
        }


def _deadline_daily(raw: pd.DataFrame, close: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    if hasattr(raw, "deadline"):
        raw = raw.deadline()
    return _align(raw, close.index, columns, ffill=True)


def _combine_first(left: pd.DataFrame | None, right: pd.DataFrame | None) -> pd.DataFrame | None:
    if left is None:
        return right
    if right is None:
        return left
    return left.combine_first(right)


def _chip_cache_paths() -> list[Path]:
    raw = os.environ.get("STOCKVISION_CHIP_CACHE_PARQUET", "").strip()
    if not raw:
        return []
    return [Path(part.strip()) for part in raw.split(os.pathsep) if part.strip()]


def _broker_cache_paths() -> list[Path]:
    raw = os.environ.get("STOCKVISION_BROKER_FLOW_CACHE_PARQUET", "").strip()
    if not raw:
        return []
    return [Path(part.strip()) for part in raw.split(os.pathsep) if part.strip()]


def _load_chip_cache_panel(close: pd.DataFrame, columns: list[str]) -> dict[str, pd.DataFrame] | None:
    paths = [path for path in _chip_cache_paths() if path.exists()]
    if not paths:
        return None

    frames: list[pd.DataFrame] = []
    for path in paths:
        try:
            frames.append(pd.read_parquet(path))
        except Exception as exc:  # noqa: BLE001 - research cache must fail soft
            print(f"[warn] chip_cache_failed {path}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    if not frames:
        return None

    raw = pd.concat(frames, ignore_index=True)
    symbol_col = "symbol" if "symbol" in raw.columns else "stock_id" if "stock_id" in raw.columns else ""
    if not symbol_col or "date" not in raw.columns:
        print("[warn] chip_cache_missing_required_columns:symbol_or_stock_id,date", file=sys.stderr, flush=True)
        return None
    if symbol_col != "symbol":
        raw = raw.rename(columns={symbol_col: "symbol"})
    raw["symbol"] = raw["symbol"].astype(str).str.strip()
    raw["date"] = pd.to_datetime(raw["date"])
    raw = raw.loc[raw["symbol"].isin(columns)].copy()
    if raw.empty:
        return None
    raw = raw.sort_values(["date", "symbol"]).drop_duplicates(["date", "symbol"], keep="last")

    def pivot(column: str) -> pd.DataFrame:
        if column not in raw.columns:
            return _nan_panel(close.index, columns)
        frame = raw.pivot(index="date", columns="symbol", values=column)
        return _align(frame, close.index, columns, ffill=False)

    foreign = pivot("foreign_net")
    trust = pivot("trust_net")
    dealer = pivot("dealer_net")
    margin = pivot("margin_balance")
    short = pivot("short_balance")
    return {
        "foreign": foreign,
        "trust": trust,
        "dealer": dealer,
        "margin": margin,
        "short": short,
    }


def _load_broker_cache_panel(close: pd.DataFrame, columns: list[str]) -> dict[str, pd.DataFrame] | None:
    paths = [path for path in _broker_cache_paths() if path.exists()]
    if not paths:
        return None

    frames: list[pd.DataFrame] = []
    for path in paths:
        try:
            frames.append(pd.read_parquet(path))
        except Exception as exc:  # noqa: BLE001 - research cache must fail soft
            print(f"[warn] broker_cache_failed {path}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    if not frames:
        return None

    raw = pd.concat(frames, ignore_index=True)
    if "stock_id" not in raw.columns or "date" not in raw.columns:
        print("[warn] broker_cache_missing_required_columns:stock_id,date", file=sys.stderr, flush=True)
        return None
    raw["stock_id"] = raw["stock_id"].astype(str).str.strip()
    raw["date"] = pd.to_datetime(raw["date"])
    raw = raw.loc[raw["stock_id"].isin(columns)].copy()
    if raw.empty:
        return None
    raw = raw.sort_values(["date", "stock_id"]).drop_duplicates(["date", "stock_id"], keep="last")

    def pivot(column: str) -> pd.DataFrame:
        if column not in raw.columns:
            return _nan_panel(close.index, columns)
        frame = raw.pivot(index="date", columns="stock_id", values=column)
        return _align(frame, close.index, columns, ffill=False)

    return {
        "net_shares": pivot("net_shares"),
        "estimated_amount": pivot("estimated_amount"),
        "broker_count": pivot("broker_count"),
        "concentration": pivot("concentration"),
    }


def _rsi(close: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(loss != 0, 100)


def _macd_hist(close: pd.DataFrame) -> pd.DataFrame:
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    return macd - signal


def _dmi_adx(high: pd.DataFrame, low: pd.DataFrame, close: pd.DataFrame, period: int = 14) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0)
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=0).groupby(level=0).max()
    atr = tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr.replace(0, np.nan)
    dx = ((plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)) * 100
    adx = dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    return plus_di, minus_di, adx


def _technical_features(close: pd.DataFrame, high: pd.DataFrame, low: pd.DataFrame, volume: pd.DataFrame) -> dict[str, pd.DataFrame]:
    ma20 = close.rolling(20).mean()
    ma60 = close.rolling(60).mean()
    close_above_ma20 = close / ma20 - 1
    close_above_ma60 = close / ma60 - 1
    volume_expansion20 = volume.rolling(5).mean() / volume.rolling(20).mean().replace(0, np.nan)
    return20d = close / close.shift(20) - 1
    return60d = close / close.shift(60) - 1

    bb_mid = ma20
    bb_std = close.rolling(20).std(ddof=0)
    bb_upper = bb_mid + 2 * bb_std
    bb_lower = bb_mid - 2 * bb_std
    bb_bandwidth = (bb_upper - bb_lower) / bb_mid.replace(0, np.nan)
    bb_pct_b = (close - bb_lower) / (bb_upper - bb_lower).replace(0, np.nan)

    true_range = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=0).groupby(level=0).max()
    atr14 = true_range.rolling(14).mean()
    plus_di, minus_di, adx14 = _dmi_adx(high, low, close, 14)

    kc_mid = ma20
    kc_range = true_range.rolling(20).mean()
    kc_upper = kc_mid + 1.5 * kc_range
    kc_lower = kc_mid - 1.5 * kc_range
    squeeze_on = (bb_upper < kc_upper) & (bb_lower > kc_lower)
    squeeze_off = (bb_upper > kc_upper) & (bb_lower < kc_lower)
    squeeze_release = squeeze_on.shift(1).where(squeeze_on.shift(1).notna(), False).astype(bool) & squeeze_off
    squeeze_anchor = ((high.rolling(20).max() + low.rolling(20).min()) / 2 + ma20) / 2
    squeeze_momentum = close - squeeze_anchor

    volume_diff = volume.rolling(13).mean() - volume.rolling(27).mean()
    volume_momentum_divergence = volume_diff - volume_diff.rolling(10).mean()

    prev_high20 = high.rolling(20).max().shift(1)
    prev_low20 = low.rolling(20).min().shift(1)
    displacement_pct = (close / close.shift(1) - 1).clip(lower=0)
    bos_bullish = close > prev_high20
    liquidity_sweep_bullish = (low < prev_low20) & (close > close.shift(1))
    choch_bullish = (close > ma20) & (close.shift(1) <= ma20.shift(1))
    fvg_strength = ((low - high.shift(2)) / close).clip(lower=0)
    order_block_strength = ((close - open_proxy(close)) / close).clip(lower=0) * volume_expansion20
    smc_bullish_score = (
        bos_bullish.astype(float) * 0.08
        + liquidity_sweep_bullish.astype(float) * 0.08
        + choch_bullish.astype(float) * 0.06
        + displacement_pct.fillna(0).clip(upper=0.05) * 2
    )
    smc_bias_bearish = ((close < ma20) & (return20d < 0)).astype(float)

    return {
        "close": close,
        "ma20": ma20,
        "ma60": ma60,
        "closeAboveMa20Pct": close_above_ma20,
        "closeAboveMa60Pct": close_above_ma60,
        "volumeExpansion20": volume_expansion20,
        "return20d": return20d,
        "return60d": return60d,
        "rsi14": _rsi(close),
        "macdHist": _macd_hist(close),
        "bbBandwidthPct": bb_bandwidth,
        "bbPctB": bb_pct_b,
        "atr14": atr14,
        "plusDi14": plus_di,
        "minusDi14": minus_di,
        "adx14": adx14,
        "diTrend": plus_di - minus_di,
        "squeezeRelease": squeeze_release.astype(float),
        "squeezeMomentum": squeeze_momentum,
        "volumeMomentumDivergence132710": volume_momentum_divergence,
        "displacementPct": displacement_pct,
        "bosBullish": bos_bullish.astype(float),
        "liquiditySweepBullish": liquidity_sweep_bullish.astype(float),
        "chochBullish": choch_bullish.astype(float),
        "bestFvgStrength": fvg_strength,
        "bestOrderBlockStrength": order_block_strength,
        "smcBullishScore": smc_bullish_score,
        "smcNetScore": smc_bullish_score - smc_bias_bearish * 0.05,
        "smcBiasBearish": smc_bias_bearish,
    }


def open_proxy(close: pd.DataFrame) -> pd.DataFrame:
    return close.shift(1).fillna(close)


def _sector_features(close: pd.DataFrame, volume: pd.DataFrame, columns: list[str]) -> dict[str, pd.DataFrame]:
    from finlab import data

    try:
        sec = pd.DataFrame(data.get("security_categories"))
    except Exception as exc:
        print(f"[warn] dataset_failed security_categories: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        blank = _nan_panel(close.index, columns)
        return {
            "sectorRsRatio": blank,
            "sectorRsMomentum": blank,
            "sectorTurnoverShareDelta": blank,
            "sectorFlowCore": blank,
        }
    sec["symbol"] = sec["symbol"].astype(str).str.strip()
    sec["category"] = sec["category"].astype(str).str.strip()
    category = sec.set_index("symbol")["category"].to_dict()
    groups: dict[str, list[str]] = {}
    for col in columns:
        cat = category.get(col)
        if cat:
            groups.setdefault(cat, []).append(col)

    ret20 = close / close.shift(20) - 1
    market_ret20 = ret20.mean(axis=1)
    value = close * volume
    total_value = value.sum(axis=1).replace(0, np.nan)

    sector_ratio_by_cat: dict[str, pd.Series] = {}
    sector_momentum_by_cat: dict[str, pd.Series] = {}
    sector_core_by_cat: dict[str, pd.Series] = {}
    sector_turnover_delta_by_cat: dict[str, pd.Series] = {}
    sector_ratio_table: dict[str, pd.Series] = {}

    for cat, cols in groups.items():
        sector_ret = ret20[cols].mean(axis=1)
        ratio = 100 + (sector_ret - market_ret20) * 100
        momentum = ratio.diff(20)
        share = value[cols].sum(axis=1) / total_value
        delta = share - share.rolling(20).mean()
        sector_ratio_table[cat] = ratio
        sector_ratio_by_cat[cat] = ratio
        sector_momentum_by_cat[cat] = momentum
        sector_turnover_delta_by_cat[cat] = delta

    ratio_frame = pd.DataFrame(sector_ratio_table)
    threshold = ratio_frame.rank(axis=1, pct=True) >= 0.75
    for cat in groups:
        sector_core_by_cat[cat] = (threshold.get(cat, pd.Series(False, index=close.index)) & (sector_momentum_by_cat[cat] >= 0)).astype(float)

    def expand(mapping: dict[str, pd.Series]) -> pd.DataFrame:
        return pd.DataFrame({col: mapping.get(category.get(col, ""), pd.Series(np.nan, index=close.index)) for col in columns}, index=close.index)

    return {
        "sectorRsRatio": expand(sector_ratio_by_cat),
        "sectorRsMomentum": expand(sector_momentum_by_cat),
        "sectorTurnoverShareDelta": expand(sector_turnover_delta_by_cat),
        "sectorFlowCore": expand(sector_core_by_cat),
    }


def _financial_features(close: pd.DataFrame, columns: list[str]) -> dict[str, pd.DataFrame]:
    from finlab import data

    def get_daily(key: str, *, deadline: bool = False) -> pd.DataFrame | None:
        try:
            raw = data.get(key)
            if deadline:
                return _deadline_daily(raw, close, columns)
            return _align(raw, close.index, columns, ffill=True)
        except Exception as exc:
            print(f"[warn] dataset_failed {key}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            return None

    monthly_yoy = _combine_first(
        get_daily("monthly_revenue:去年同月增減(%)", deadline=True),
        get_daily("rotc_monthly_revenue:去年同月增減(%)", deadline=True),
    )
    monthly_mom = _combine_first(
        get_daily("monthly_revenue:上月比較增減(%)", deadline=True),
        get_daily("rotc_monthly_revenue:上月比較增減(%)", deadline=True),
    )
    features = {
        "monthlyRevenueYoY": monthly_yoy,
        "monthlyRevenueMoM": monthly_mom,
        "revenueGrowthYoY": get_daily("fundamental_features:營收成長率", deadline=True),
        "grossMargin": get_daily("fundamental_features:營業毛利率", deadline=True),
        "operatingMargin": get_daily("fundamental_features:營業利益率", deadline=True),
        "roe": get_daily("fundamental_features:ROE稅後", deadline=True),
        "eps": get_daily("fundamental_features:每股稅後淨利", deadline=True),
        "pe": get_daily("price_earning_ratio:本益比"),
        "pb": get_daily("price_earning_ratio:股價淨值比"),
        "dividendYield": get_daily("price_earning_ratio:殖利率(%)"),
    }
    return {k: v for k, v in features.items() if v is not None}


def _chip_features(close: pd.DataFrame, columns: list[str]) -> dict[str, pd.DataFrame]:
    from finlab import data

    cache_mode = os.environ.get("STOCKVISION_CHIP_FEATURE_SOURCE", "finlab_first").strip().lower()
    cache = _load_chip_cache_panel(close, columns)
    broker_cache = _load_broker_cache_panel(close, columns)

    def get(key: str) -> tuple[pd.DataFrame, bool]:
        try:
            return _align(data.get(key), close.index, columns, ffill=False), True
        except Exception as exc:
            print(f"[warn] dataset_failed {key}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            return _nan_panel(close.index, columns), False

    def combine_sum(left: pd.DataFrame, left_ok: bool, right: pd.DataFrame, right_ok: bool) -> pd.DataFrame:
        if left_ok and right_ok:
            return left.fillna(0) + right.fillna(0)
        if left_ok:
            return left
        if right_ok:
            return right
        return _nan_panel(close.index, columns)

    if cache is not None and cache_mode == "cache_only":
        foreign, foreign_ok = cache["foreign"], True
        trust, trust_ok = cache["trust"], True
        dealer, dealer_ok = cache["dealer"], True
    else:
        foreign, foreign_ok = get("institutional_investors_trading_summary:外陸資買賣超股數(不含外資自營商)")
        trust, trust_ok = get("institutional_investors_trading_summary:投信買賣超股數")
        dealer_self, dealer_self_ok = get("institutional_investors_trading_summary:自營商買賣超股數(自行買賣)")
        dealer_hedge, dealer_hedge_ok = get("institutional_investors_trading_summary:自營商買賣超股數(避險)")
        dealer = combine_sum(dealer_self, dealer_self_ok, dealer_hedge, dealer_hedge_ok)
        dealer_ok = dealer_self_ok or dealer_hedge_ok
        if cache is not None and cache_mode == "cache_first":
            foreign = cache["foreign"].combine_first(foreign)
            trust = cache["trust"].combine_first(trust)
            dealer = cache["dealer"].combine_first(dealer)
            foreign_ok = foreign_ok or bool(cache["foreign"].notna().to_numpy().any())
            trust_ok = trust_ok or bool(cache["trust"].notna().to_numpy().any())
            dealer_ok = dealer_ok or bool(cache["dealer"].notna().to_numpy().any())

    if cache is not None and cache_mode == "cache_only":
        if broker_cache is not None:
            broker_net_shares = broker_cache["net_shares"]
            broker_net_amount = broker_cache["estimated_amount"]
            broker_count_proxy = broker_cache["broker_count"]
            balance_index = broker_cache["concentration"]
        else:
            broker_net_shares = _nan_panel(close.index, columns)
            broker_net_amount = _nan_panel(close.index, columns)
            broker_count_proxy = _nan_panel(close.index, columns)
            balance_index = _nan_panel(close.index, columns)
    else:
        top15_buy, top15_buy_ok = get("etl:broker_transactions:top15_buy")
        top15_sell, top15_sell_ok = get("etl:broker_transactions:top15_sell")
        balance_index, _balance_index_ok = get("etl:broker_transactions:balance_index")
        if top15_buy_ok or top15_sell_ok:
            broker_net_shares = top15_buy.fillna(0) - top15_sell.fillna(0)
        else:
            broker_net_shares = _nan_panel(close.index, columns)
        broker_net_amount = broker_net_shares * close
        broker_count_proxy = top15_buy.notna().astype(float) * 15 if top15_buy_ok else _nan_panel(close.index, columns)
        if broker_cache is not None and cache_mode == "cache_first":
            broker_net_shares = broker_cache["net_shares"].combine_first(broker_net_shares)
            broker_net_amount = broker_cache["estimated_amount"].combine_first(broker_net_amount)
            broker_count_proxy = broker_cache["broker_count"].combine_first(broker_count_proxy)
            balance_index = broker_cache["concentration"].combine_first(balance_index)

    return {
        "foreignNet5d": foreign.rolling(5).sum(),
        "trustNet5d": trust.rolling(5).sum(),
        "dealerNet5d": dealer.rolling(5).sum(),
        "foreignTrustNet5d": combine_sum(foreign, foreign_ok, trust, trust_ok).rolling(5).sum(),
        "brokerNetShares5d": broker_net_shares.rolling(5).sum(),
        "brokerNetAmount5d": broker_net_amount.rolling(5).sum(),
        "brokerCount": broker_count_proxy,
        "brokerConcentration": balance_index,
    }


def _compare(frame: pd.DataFrame, op: str, expected: Any) -> pd.DataFrame:
    if isinstance(expected, bool):
        rhs = 1.0 if expected else 0.0
    else:
        rhs = float(expected)
    if op == ">=":
        return frame >= rhs
    if op == ">":
        return frame > rhs
    if op == "<=":
        return frame <= rhs
    if op == "<":
        return frame < rhs
    if op == "==":
        return frame == rhs
    if op == "!=":
        return frame != rhs
    return pd.DataFrame(False, index=frame.index, columns=frame.columns)


def _blank_like(close: pd.DataFrame, value: bool = False) -> pd.DataFrame:
    return pd.DataFrame(value, index=close.index, columns=close.columns)


def _normalize_feature_key(signal: str) -> str:
    normalized = signal.strip()
    for prefix in ("technicalIndicators.", "factorSignals.", "technical.", "factor.", "factors."):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break
    return normalized


def _feature(features: dict[str, pd.DataFrame], signal: str, close: pd.DataFrame) -> pd.DataFrame:
    normalized = _normalize_feature_key(signal)
    return features.get(normalized, pd.DataFrame(np.nan, index=close.index, columns=close.columns))


def _as_bool_frame(frame: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(frame).infer_objects(copy=False)
    return out.where(out.notna(), False).astype(bool)


DIRECT_THRESHOLD_MAP = [
    ("minPrice", "close", ">="),
    ("maxPrice", "close", "<="),
    ("minCloseAboveMa20Pct", "closeAboveMa20Pct", ">="),
    ("maxCloseAboveMa20Pct", "closeAboveMa20Pct", "<="),
    ("minCloseAboveMa60Pct", "closeAboveMa60Pct", ">="),
    ("maxCloseAboveMa60Pct", "closeAboveMa60Pct", "<="),
    ("minVolumeExpansion20", "volumeExpansion20", ">="),
    ("minReturn20d", "return20d", ">="),
    ("maxReturn20d", "return20d", "<="),
    ("minForeignTrustNet5d", "foreignTrustNet5d", ">="),
    ("minDealerNet5d", "dealerNet5d", ">="),
    ("minBrokerNetShares5d", "brokerNetShares5d", ">="),
    ("minBrokerNetAmount5d", "brokerNetAmount5d", ">="),
    ("minBrokerCount", "brokerCount", ">="),
    ("maxBrokerConcentration", "brokerConcentration", "<="),
    ("minRevenueGrowthYoY", "revenueGrowthYoY", ">="),
    ("minMonthlyRevenueYoY", "monthlyRevenueYoY", ">="),
    ("minMonthlyRevenueMoM", "monthlyRevenueMoM", ">="),
    ("minGrossMargin", "grossMargin", ">="),
    ("minOperatingMargin", "operatingMargin", ">="),
    ("minRoe", "roe", ">="),
    ("minEps", "eps", ">="),
    ("maxPe", "pe", "<="),
    ("maxPb", "pb", "<="),
]


def _missing_feature_keys(spec: dict[str, Any], features: dict[str, pd.DataFrame]) -> list[str]:
    thresholds = spec.get("thresholds") or {}
    keys: list[str] = []
    for threshold_key, feature_key, _op in DIRECT_THRESHOLD_MAP:
        if threshold_key in thresholds:
            keys.append(feature_key)
    for group_key in ("minTechnicalIndicators", "maxTechnicalIndicators", "minFactorSignals", "maxFactorSignals"):
        keys.extend(str(key) for key in (thresholds.get(group_key) or {}).keys())
    dsl = thresholds.get("dsl") or {}
    for group_key in ("all", "any", "not"):
        for condition in dsl.get(group_key) or []:
            keys.append(str(condition.get("signal") or ""))
    return sorted({key for key in keys if _normalize_feature_key(key) not in features})


def _apply_threshold(mask: pd.DataFrame, features: dict[str, pd.DataFrame], key: str, op: str, value: Any, close: pd.DataFrame) -> pd.DataFrame:
    frame = _feature(features, key, close)
    return mask & _as_bool_frame(_compare(frame, op, value))


def _position_for_spec(spec: dict[str, Any], features: dict[str, pd.DataFrame], close: pd.DataFrame, universe_mask: pd.DataFrame) -> pd.DataFrame:
    thresholds = spec.get("thresholds") or {}
    mask = _blank_like(close, True) & universe_mask

    for threshold_key, feature_key, op in DIRECT_THRESHOLD_MAP:
        if threshold_key in thresholds:
            mask = _apply_threshold(mask, features, feature_key, op, thresholds[threshold_key], close)

    for feature_key, value in (thresholds.get("minTechnicalIndicators") or {}).items():
        mask = _apply_threshold(mask, features, feature_key, ">=", value, close)
    for feature_key, value in (thresholds.get("maxTechnicalIndicators") or {}).items():
        mask = _apply_threshold(mask, features, feature_key, "<=", value, close)
    for feature_key, value in (thresholds.get("minFactorSignals") or {}).items():
        mask = _apply_threshold(mask, features, feature_key, ">=", value, close)
    for feature_key, value in (thresholds.get("maxFactorSignals") or {}).items():
        mask = _apply_threshold(mask, features, feature_key, "<=", value, close)

    dsl = thresholds.get("dsl") or {}
    for condition in dsl.get("all") or []:
        frame = _feature(features, str(condition.get("signal") or ""), close)
        mask = mask & _as_bool_frame(_compare(frame, str(condition.get("op") or ""), condition.get("value")))

    any_conditions = dsl.get("any") or []
    if any_conditions:
        any_mask = _blank_like(close, False)
        for condition in any_conditions:
            frame = _feature(features, str(condition.get("signal") or ""), close)
            any_mask = any_mask | _as_bool_frame(_compare(frame, str(condition.get("op") or ""), condition.get("value")))
        mask = mask & any_mask

    for condition in dsl.get("not") or []:
        frame = _feature(features, str(condition.get("signal") or ""), close)
        mask = mask & (~_as_bool_frame(_compare(frame, str(condition.get("op") or ""), condition.get("value"))))

    return _as_bool_frame(mask)


@dataclass
class BacktestConfig:
    start_date: str
    end_date: str
    resample: str
    position_limit: float
    trade_at_price: str


def _extract_result(strategy_id: str, spec: dict[str, Any], pos: pd.DataFrame, report: Any, elapsed_s: float) -> dict[str, Any]:
    stats = report.get_stats()
    metrics = report.get_metrics()
    trades = report.get_trades()
    match_counts = pos.sum(axis=1)
    return {
        "strategy_id": strategy_id,
        "name": spec.get("name"),
        "family_id": spec.get("familyId"),
        "alpha_bucket": spec.get("alphaBucket"),
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
        "avg_trade_return": _safe_float(trades["return"].mean()) if len(trades) and "return" in trades else None,
        "median_trade_return": _safe_float(trades["return"].median()) if len(trades) and "return" in trades else None,
        "match_days": int((match_counts > 0).sum()),
        "avg_daily_matches": _safe_float(match_counts.mean()),
        "max_daily_matches": int(match_counts.max()) if len(match_counts) else 0,
        "latest_matches": int(match_counts.iloc[-1]) if len(match_counts) else 0,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    from finlab import data
    from finlab.backtest import sim

    with open(args.spec_json, "r", encoding="utf-8-sig") as fh:
        specs = json.load(fh)
    status_scope = str(getattr(args, "status_scope", "active"))
    if status_scope not in STATUS_SCOPES:
        raise ValueError(f"unsupported_status_scope:{status_scope}")
    selected_statuses = STATUS_SCOPES[status_scope]
    selected = [
        spec
        for spec in specs
        if spec.get("status") in selected_statuses
        and (not args.exclude_alphabuilders or not str(spec.get("id", "")).startswith("alphabuilders_"))
    ]

    close_raw = data.get("price:收盤價")
    close_all = _as_dt_index(close_raw)
    columns = _common_stock_columns(close_all)
    close = close_all.reindex(columns=columns).loc[: args.end_date]
    open_ = _as_dt_index(data.get("price:開盤價")).reindex(index=close.index, columns=columns)
    high = _as_dt_index(data.get("price:最高價")).reindex(index=close.index, columns=columns)
    low = _as_dt_index(data.get("price:最低價")).reindex(index=close.index, columns=columns)
    volume = _as_dt_index(data.get("price:成交股數")).reindex(index=close.index, columns=columns)

    features = _technical_features(close, high, low, volume)
    features["open"] = open_
    features.update(_financial_features(close, columns))
    features.update(_chip_features(close, columns))
    features.update(_sector_features(close, volume, columns))
    alpha_miner_feature_mapping: dict[str, Any] | None = None
    alpha_miner_features, alpha_miner_feature_mapping = _alpha_miner_scores(
        selected,
        args,
        close,
        open_,
        high,
        low,
        features,
        columns,
    )
    features.update(alpha_miner_features)

    start = pd.Timestamp(args.start_date)
    end = pd.Timestamp(args.end_date)
    date_mask = (close.index >= start) & (close.index <= end)
    tradable = close.notna() & (close >= 10)
    date_frame = pd.DataFrame(
        np.repeat(np.asarray(date_mask)[:, None], len(columns), axis=1),
        index=close.index,
        columns=columns,
    )
    universe_mask = tradable & date_frame

    results: list[dict[str, Any]] = []
    positions_summary: dict[str, Any] = {}
    for spec in selected:
        strategy_id = str(spec["id"])
        t0 = time.time()
        pos = _position_for_spec(spec, features, close, universe_mask).loc[args.start_date : args.end_date]
        pos = pos.reindex(columns=columns)
        pos = pos.where(pos.notna(), False).astype(bool)
        match_counts = pos.sum(axis=1)
        positions_summary[strategy_id] = {
            "match_days": int((match_counts > 0).sum()),
            "avg_daily_matches": _safe_float(match_counts.mean()),
            "max_daily_matches": int(match_counts.max()) if len(match_counts) else 0,
            "latest_matches": int(match_counts.iloc[-1]) if len(match_counts) else 0,
        }
        if int(match_counts.sum()) == 0:
            missing_features = _missing_feature_keys(spec, features)
            status = "unsupported_feature" if missing_features else "no_signal"
            results.append({
                "strategy_id": strategy_id,
                "name": spec.get("name"),
                "family_id": spec.get("familyId"),
                "alpha_bucket": spec.get("alphaBucket"),
                "status": status,
                "reason": "missing_feature_key" if missing_features else "no_matching_position",
                "missing_feature_keys": missing_features,
                "elapsed_s": round(time.time() - t0, 3),
                **positions_summary[strategy_id],
            })
            continue
        try:
            report = sim(
                pos,
                resample=args.resample,
                trade_at_price=args.trade_at_price,
                position_limit=float(args.position_limit),
                fee_ratio=0.001425,
                tax_ratio=0.003,
                name=f"stockvision_{strategy_id}",
                upload=False,
                fast_mode=True,
                notification_enable=False,
            )
            results.append(_extract_result(strategy_id, spec, pos, report, time.time() - t0))
        except Exception as exc:
            results.append({
                "strategy_id": strategy_id,
                "name": spec.get("name"),
                "family_id": spec.get("familyId"),
                "alpha_bucket": spec.get("alphaBucket"),
                "status": "sim_error",
                "error": f"{type(exc).__name__}: {exc}",
                "elapsed_s": round(time.time() - t0, 3),
                **positions_summary[strategy_id],
            })

    report = {
        "schema_version": "stockvision-finlab-strategy-spec-backtest-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "sdk": {
            "finlab_version": getattr(sys.modules.get("finlab"), "__version__", None),
            "pandas_version": pd.__version__,
        },
        "config": {
            "start_date": args.start_date,
            "end_date": args.end_date,
            "resample": args.resample,
            "position_limit": float(args.position_limit),
            "trade_at_price": args.trade_at_price,
            "universe": "FinLab security_categories market in sii/otc and 4-digit common stocks",
            "status_scope": status_scope,
            "selected_statuses": sorted(selected_statuses),
            "retired_included": False,
            "strategy_count": len(selected),
        },
        "feature_mapping": {
            "price": "finlab price:開盤價/最高價/最低價/收盤價/成交股數",
            "financials": "finlab fundamental_features deadline() + price_earning_ratio daily",
            "monthly_revenue": "finlab monthly_revenue + rotc_monthly_revenue deadline()",
            "chips": "finlab institutional_investors_trading_summary 5d rolling",
            "broker": "finlab etl:broker_transactions top15_buy/top15_sell/balance_index proxy; full broker_transactions was not used",
            "sector_flow": "reconstructed from FinLab security_categories + OHLCV relative strength proxy",
            "smc": "reconstructed OHLCV price-action proxy; not a byte-identical production SMC replay",
            "alpha_miner": alpha_miner_feature_mapping,
        },
        "results": results,
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only FinLab sim backtest for StockVision StrategySpec labels.")
    parser.add_argument("--spec-json", required=True)
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_strategy_backtests"))
    parser.add_argument("--exclude-alphabuilders", action="store_true")
    parser.add_argument("--status-scope", choices=sorted(STATUS_SCOPES), default="active")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)

    status_scope = str(report["config"].get("status_scope") or "active")
    strategy_scope = f"{status_scope}{int(report['config']['strategy_count'])}"
    stem = f"finlab_strategy_spec_{strategy_scope}_{args.start_date}_{args.end_date}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    csv_path = output_dir / f"{stem}.csv"
    summary_path = output_dir / f"{stem}_summary.json"

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    rows = report["results"]
    pd.DataFrame(rows).to_csv(csv_path, index=False, encoding="utf-8-sig")
    summary = {
        "json": _rel(json_path),
        "csv": _rel(csv_path),
        "strategy_count": report["config"]["strategy_count"],
        "ok": sum(1 for row in rows if row.get("status") == "ok"),
        "no_signal": sum(1 for row in rows if row.get("status") == "no_signal"),
        "unsupported_feature": sum(1 for row in rows if row.get("status") == "unsupported_feature"),
        "errors": [row for row in rows if row.get("status") not in {"ok", "no_signal", "unsupported_feature"}],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default))
    return 0 if not summary["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
