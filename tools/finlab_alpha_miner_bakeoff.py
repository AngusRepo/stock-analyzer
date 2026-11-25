from __future__ import annotations

import argparse
import csv
import hashlib
import gc
import importlib.util
import itertools
import json
import math
import os
import random
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
AB_RUNNER = ROOT / "tools" / "finlab_alphabuilders_factor_backtest.py"
SPEC_RUNNER = ROOT / "tools" / "finlab_strategy_spec_backtest.py"
OVERLAP_RUNNER = ROOT / "tools" / "feature_strategy_overlap_numeric.py"
FEATURE_TRIAGE_DIR = ROOT / "output" / "feature_universe_triage"
STRATEGY95_VS_ML106_PATH = FEATURE_TRIAGE_DIR / "strategy95_vs_ml106_full_mapping.csv"
TRIAGE_WINDOW_HELPER = ROOT / "tools" / "feature_triage_window.py"
UNIFIED_FEATURE_REGISTRY_PATH = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
MONTHLY_MINING_CONFIG_PATH = ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"
FORMAL137_SIMILARITY_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"
FORMAL137_PAIRWISE_SIMILARITY_PATH = FEATURE_TRIAGE_DIR / "formal137_pairwise_similarity_long_20260617.csv"
STRATEGY_FEATURE_REF_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "strategy_feature_ref_contract_v1.json"

MONTHLY_CONFIGURABLE_DEFAULTS = {
    "factor_universe": "unified_registry_v1",
    "algorithm": "pymoo",
    "min_factors": 2,
    "max_factors": 8,
    "random_trials": 0,
    "optuna_trials": 0,
    "deap_population": 0,
    "deap_generations": 0,
    "pymoo_population": 48,
    "pymoo_generations": 6,
    "pymoo_search_mode": "top_k_v1",
    "pymoo_labeler_population": 32,
    "pymoo_labeler_generations": 4,
    "labeler_min_percentile": 0.55,
    "labeler_max_percentile": 0.85,
    "finlab_confirm_top_n": 8,
    "pbo_folds": 8,
    "promote_family_factor_jaccard": 0.50,
    "promote_family_category_jaccard": 0.67,
}

# Research protocol v3 (audit 2026-11-24). Values here are code defaults; the monthly config's
# "research_protocol" block overrides them and the resolved protocol is recorded in the report.
TW_COMMISSION_RATE = 0.001425  # broker commission, charged on buys and sells
TW_SELL_TAX_RATE = 0.003  # securities transaction tax, sells only
RESEARCH_PROTOCOL_DEFAULTS: dict[str, Any] = {
    "schema_version": "strategy-mining-research-protocol-v3",
    # Rolling walk-forward anchored at the run's last session. Segments are separated by
    # purge (one monthly holding period, so no position straddles a boundary) + embargo.
    "window_mode": "rolling",
    "train_sessions": 504,
    "validation_sessions": 252,
    "holdout_sessions": 126,
    "purge_sessions": 21,
    "embargo_sessions": 5,
    # Runs up to 2026-11-07 optimised/gated on 2026-01-01..run date, so that data is burned
    # as a holdout; the sealed holdout only uses sessions after this date.
    "holdout_not_before": "2026-11-08",
    "min_holdout_sessions_for_gate": 60,
    # Execution: signal at close t, fill at close t+1 (same convention as the FinLab
    # confirmation sim), returns from adjusted close, TW cost model.
    "execution_lag_sessions": 1,
    "fill_price": "close",
    "commission_rate": TW_COMMISSION_RATE,
    "sell_tax_rate": TW_SELL_TAX_RATE,
    "benchmark": "tradable_universe_equal_weight",
    "min_factor_weight_coverage": 0.5,
    "cross_sectional_min_varying_date_ratio": 0.5,
    "direction_ic_horizon_sessions": 21,
    "label_signature_date_stride": 5,
    "novelty_neighbours": 10,
    # Feature eligibility/direction triage that fed the registry (unified179 backtests).
    "feature_triage_window": {"start": "2023-01-01", "end": "2026-06-15"},
    "selection_gate": {
        "min_validation_excess_sharpe": 0.75,
        "min_train_excess_sharpe": 0.0,
        "min_deflated_sharpe_probability": 0.95,
        "max_selection_drawdown": 0.35,
        "max_turnover": 0.95,
        "regime_min_observations": 40,
        "regime_min_excess_return_annualized": -0.15,
    },
    "holdout_gate": {
        "holm_alpha": 0.05,
        "regime_min_observations": 20,
        "regime_min_excess_return_annualized": -0.15,
        "finlab_confirm_min_monthly_sharpe": 0.5,
        "finlab_confirm_require_positive_alpha": True,
    },
}

HIGH_DUPLICATE_SIMILARITY_FLOOR = 0.80
RELATED_CLUSTER_SIMILARITY_FLOOR = 0.40

CANONICAL114_SELECTED_STRATEGY_FACTORS = {
    "l1_monthlyRevenueMoM",
    "l1_revenueGrowthYoY",
    "l1_sectorTurnoverShareDelta",
    "l1_volumeMomentumDivergence132710",
    "mom_12m_1m",
    "tech_adx_14",
    "tech_granville_score",
    "val_sp",
}


L1_SEMANTIC_DUPLICATE_ALIASES = {
    "adx14": "tech_adx_14",
    "atr14": "tech_atr_14",
    "bbPctB": "tech_bbands_pctb_20",
    "rsi14": "mom_rsi_14",
    "closeAboveMa20Pct": "tech_sma_20_pos",
    "pe": "val_ep",
    "pb": "val_bp",
}

L1_SIGNAL_DIRECTIONS = {
    "brokerConcentration": -1.0,
    "smcBiasBearish": -1.0,
    "price": 1.0,
}


@dataclass(frozen=True)
class FactorMeta:
    id: str
    source: str
    category: str
    direction: float
    # "declared": economic prior (AlphaBuilders json / L1 signal map), never fitted.
    # "full_window_triage": fitted on a window that overlaps validation/holdout -> must be
    # re-derived on the train window before mining (see _derive_train_window_directions).
    direction_source: str = "declared"


@dataclass
class Candidate:
    candidate_id: str
    algorithm: str
    factor_ids: list[str]
    weights: list[float]
    combine: str = "weighted_sum"
    transform: str = "rank_pct"
    label_threshold: float | None = None
    # Per-factor directions to score with. None = take them from FactorMeta (mining time);
    # replays set them from the row's recorded factor_directions (see _resolve_candidate_directions).
    directions: list[float] | None = None


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, (pd.Series, pd.DataFrame)):
        return value.to_dict()
    return str(value)


def _progress(message: str) -> None:
    print(f"[alpha-miner] {message}", file=sys.stderr, flush=True)


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _fitness_key(row: dict[str, Any]) -> float:
    """Ranking key: a real 0.0 fitness stays 0.0; only missing/non-finite sorts last."""
    return float(_safe_float(row.get("fitness"), -999.0))


def _direction_from_mode(value: Any, default: float = 1.0) -> float:
    text = str(value or "").strip().lower()
    if text in {"low", "declared_low", "short", "-1"}:
        return -1.0
    if text in {"high", "declared_high", "long", "1"}:
        return 1.0
    return float(default)


def _feature_group(name: str) -> str:
    lower = name.lower()
    if lower.startswith(
        (
            "return",
            "volatility",
            "rsi",
            "macd",
            "bb_",
            "ma",
            "keltner",
            "k",
            "imax",
            "imin",
            "imxd",
            "beta",
            "rsqr",
            "resi",
            "cnt",
            "vstd",
            "wvma",
            "corr",
            "cord",
            "vwap",
            "linear_factor",
        )
    ):
        return "price_technical"
    if any(token in lower for token in ("chip", "foreign", "dealer", "institutional", "margin", "short", "retail")):
        return "chip_margin_flow"
    if any(token in lower for token in ("market_", "us_", "advance", "bull_", "adl_", "limit_")):
        return "market_regime"
    if any(token in lower for token in ("sentiment", "ptt")):
        return "sentiment"
    if any(token in lower for token in ("revenue",)):
        return "fundamental_revenue"
    if any(token in lower for token in ("sector", "market_cap", "avg_volume")):
        return "sector_metadata"
    return "other"


def _read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _load_direction_map(path: Path, *, id_key: str, direction_key: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for row in _read_csv_rows(path):
        fid = str(row.get(id_key) or "").strip()
        if not fid:
            continue
        out[fid] = _direction_from_mode(row.get(direction_key), 1.0)
    return out


def _registry_direction(row: dict[str, Any], default: float = 1.0) -> float:
    triage = row.get("triage") if isinstance(row.get("triage"), dict) else {}
    for source in (triage, row):
        for key in ("direction_mode", "strategy_direction", "declared_direction"):
            if source.get(key) is not None:
                return _direction_from_mode(source.get(key), default)
        if source.get("direction") is not None:
            value = _safe_float(source.get("direction"))
            if value is not None and value != 0:
                return 1.0 if value > 0 else -1.0
    return float(default)


def _rank_pct(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.replace([np.inf, -np.inf], np.nan).rank(axis=1, pct=True)


def _normalize_weights(weights: list[float]) -> list[float]:
    arr = np.asarray([max(0.0, float(w)) for w in weights], dtype=float)
    total = float(arr.sum())
    if total <= 0:
        return [1.0 / len(weights)] * len(weights)
    return [float(x / total) for x in arr]


def _position_from_score(score: pd.DataFrame, top_k: int, tradable: pd.DataFrame) -> pd.DataFrame:
    masked = score.where(tradable)
    rank = masked.rank(axis=1, ascending=False, method="first")
    return (rank <= top_k).astype(bool)


def _labels_from_score(
    score: pd.DataFrame,
    threshold_percentile: float,
    tradable: pd.DataFrame,
) -> pd.DataFrame:
    """Assign a positive/negative label to every tradable L0 candidate."""
    threshold = min(max(float(threshold_percentile), 0.0), 1.0)
    eligible = tradable.reindex(index=score.index, columns=score.columns).fillna(False).astype(bool)
    percentile = score.where(eligible).rank(axis=1, pct=True, method="average")
    return ((percentile >= threshold) & eligible).fillna(False).astype(bool)


def _label_matrix_metrics(labels: pd.DataFrame, tradable: pd.DataFrame) -> dict[str, Any]:
    eligible = tradable.reindex(index=labels.index, columns=labels.columns).fillna(False).astype(bool)
    eligible_count = int(eligible.to_numpy(dtype=bool).sum())
    positive_count = int((labels & eligible).to_numpy(dtype=bool).sum())
    coverage = float(positive_count / eligible_count) if eligible_count else 0.0
    if 0.0 < coverage < 1.0:
        entropy = float(
            -(coverage * math.log2(coverage) + (1.0 - coverage) * math.log2(1.0 - coverage))
        )
    else:
        entropy = 0.0
    daily_positive = (labels & eligible).sum(axis=1)
    daily_eligible = eligible.sum(axis=1).replace(0, np.nan)
    daily_coverage = (daily_positive / daily_eligible).replace([np.inf, -np.inf], np.nan).dropna()
    return {
        "label_scope": "all_l0_candidates",
        "eligible_cell_count": eligible_count,
        "positive_label_count": positive_count,
        "positive_label_rate": coverage,
        "label_entropy": entropy,
        "mean_daily_positive_labels": float(daily_positive.mean()) if len(daily_positive) else 0.0,
        "mean_daily_label_rate": float(daily_coverage.mean()) if len(daily_coverage) else 0.0,
        "daily_label_rate_std": float(daily_coverage.std(ddof=0)) if len(daily_coverage) else 0.0,
    }


_UINT8_BIT_COUNTS = np.unpackbits(np.arange(256, dtype=np.uint8)[:, None], axis=1).sum(axis=1)


def _label_signature(labels: pd.DataFrame, date_stride: int = 5) -> np.ndarray:
    # Weekly-stride dates over EVERY symbol (columns sorted so the bit layout is stable).
    # The old sketch kept only the first 256 columns, so labels on the rest of L0 were invisible.
    ordered = labels.reindex(columns=sorted(labels.columns))
    sampled = ordered.iloc[:: max(1, int(date_stride)), :].to_numpy(dtype=bool, copy=False).reshape(-1)
    return np.packbits(sampled)


def _label_matrix_novelty(signature: np.ndarray, archive: list[np.ndarray]) -> float:
    if not archive:
        return 1.0
    max_jaccard = 0.0
    for prior in archive:
        length = min(len(signature), len(prior))
        if length <= 0:
            continue
        intersection = int(_UINT8_BIT_COUNTS[np.bitwise_and(signature[:length], prior[:length])].sum())
        union = int(_UINT8_BIT_COUNTS[np.bitwise_or(signature[:length], prior[:length])].sum())
        max_jaccard = max(max_jaccard, float(intersection / union) if union else 1.0)
    return min(max(1.0 - max_jaccard, 0.0), 1.0)


def _rebalance_sessions(index: pd.DatetimeIndex, resample: str) -> pd.DatetimeIndex:
    """Last trading session of each period, taken from the data's own trading calendar.

    Calendar period ends (e.g. a Saturday month-end) are not trading days; resampling to them and
    reindexing onto trading days silently dropped that month's rebalance.
    """
    mode = str(resample or "").strip().upper()
    if mode in {"M", "ME", "MONTHLY"}:
        freq = "ME"
    elif mode in {"W", "WEEKLY", "W-FRI"}:
        freq = "W-FRI"
    elif mode in {"Q", "QE", "QUARTERLY"}:
        freq = "QE"
    else:
        raise ValueError(f"unsupported_rebalance_resample:{resample}")
    if len(index) == 0:
        return pd.DatetimeIndex([])
    ordered = pd.DatetimeIndex(index).sort_values()
    series = pd.Series(ordered, index=ordered)
    last = series.groupby(pd.Grouper(freq=freq)).max().dropna()
    # The last period may be incomplete; its last session is still a valid signal date (the
    # trade fills one session later, i.e. after the data ends), so it is kept rather than guessed
    # away without an exchange calendar.
    return pd.DatetimeIndex(last.to_numpy())


def _rebalance_position(position: pd.DataFrame, resample: str) -> pd.DataFrame:
    mode = str(resample or "").strip()
    if not mode or mode.upper() in {"D", "1D", "DAILY"}:
        return position
    sessions = _rebalance_sessions(position.index, mode)
    signal = position.loc[sessions]
    aligned = signal.reindex(position.index).ffill().infer_objects()
    return aligned.where(aligned.notna(), False).astype(bool)


def _max_drawdown(returns: pd.Series) -> float:
    if returns.empty:
        return 0.0
    equity = (1.0 + returns.fillna(0.0)).cumprod()
    peak = equity.cummax()
    dd = equity / peak - 1.0
    return float(dd.min()) if len(dd) else 0.0


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
    years = max(len(clean) / 252.0, 1e-9)
    total = float((1.0 + clean).prod())
    if total <= 0:
        return -1.0
    return float(total ** (1.0 / years) - 1.0)


def _mean_turnover(position: pd.DataFrame) -> float:
    if position.empty:
        return 0.0
    weights = _target_weights(position)
    turnover = weights.diff().abs().sum(axis=1) / 2.0
    return float(turnover.replace([np.inf, -np.inf], np.nan).dropna().mean() or 0.0)


def _target_weights(position: pd.DataFrame) -> pd.DataFrame:
    weights = position.astype(float)
    row_sums = weights.sum(axis=1).replace(0, np.nan)
    return weights.div(row_sums, axis=0).fillna(0.0)


def _portfolio_returns(
    position: pd.DataFrame,
    close: pd.DataFrame,
    *,
    commission_rate: float = TW_COMMISSION_RATE,
    sell_tax_rate: float = TW_SELL_TAX_RATE,
    execution_lag: int = 1,
) -> pd.Series:
    """Daily net returns of an equal-weight book whose targets come from `position`.

    `position` row t is the signal formed with data up to close t. It is filled at close
    t+execution_lag (same convention as the FinLab confirmation sim), so it earns returns from
    the following session on. `close` must be the ADJUSTED close. Buys pay commission; sells pay
    commission + transaction tax; the first entry from cash is a buy like any other.
    """
    if execution_lag < 1:
        raise ValueError("execution_lag_must_be_at_least_one_session")
    daily_ret = close.pct_change(fill_method=None).reindex(index=position.index, columns=position.columns)
    executed = _target_weights(position).shift(int(execution_lag)).fillna(0.0)
    held = executed.shift(1).fillna(0.0)
    # A held name without a return on a day (suspension) is carried flat.
    gross = (held * daily_ret.fillna(0.0)).sum(axis=1)
    delta = executed - held
    buys = delta.clip(lower=0.0).sum(axis=1)
    sells = (-delta).clip(lower=0.0).sum(axis=1)
    cost = buys * float(commission_rate) + sells * (float(commission_rate) + float(sell_tax_rate))
    return gross - cost


def _slice_metrics(returns: pd.Series) -> dict[str, float]:
    return {
        "cagr": _cagr(returns),
        "sharpe": _annualized_sharpe(returns),
        "max_drawdown": _max_drawdown(returns),
        "positive_day_ratio": float((returns > 0).mean()) if len(returns) else 0.0,
    }


def _benchmark_relative_metrics(
    returns: pd.Series,
    benchmark: pd.Series,
    regimes: pd.Series,
    *,
    regime_min_observations: int,
    regime_min_excess_return_annualized: float,
) -> dict[str, Any]:
    """Excess-vs-benchmark statistics, beta, up/down capture and ex-ante regime breakdown.

    A candidate whose excess return is catastrophically negative in any ex-ante (PIT) regime
    with enough observations is flagged one-sided: its "alpha" is a regime bet.
    """
    frame = pd.concat(
        {"r": returns, "b": benchmark.reindex(returns.index), "g": regimes.reindex(returns.index)},
        axis=1,
    ).replace([np.inf, -np.inf], np.nan).dropna(subset=["r", "b"])
    excess = frame["r"] - frame["b"]
    variance = float(frame["b"].var(ddof=1)) if len(frame) > 2 else 0.0
    beta = float(frame["r"].cov(frame["b"]) / variance) if variance > 1e-18 else None
    up = excess[frame["b"] > 0]
    down = excess[frame["b"] < 0]
    regime_stats: dict[str, dict[str, Any]] = {}
    one_sided: list[str] = []
    for regime, values in excess.groupby(frame["g"].fillna("unknown").astype(str)):
        ann = float(values.mean() * 252.0) if len(values) else 0.0
        regime_stats[regime] = {"observations": int(len(values)), "excess_return_annualized": ann}
        if len(values) >= int(regime_min_observations) and ann < float(regime_min_excess_return_annualized):
            one_sided.append(regime)
    return {
        "benchmark": "tradable_universe_equal_weight",
        "observations": int(len(frame)),
        "excess_sharpe": _annualized_sharpe(excess),
        "excess_cagr": _cagr(excess),
        "excess_max_drawdown": _max_drawdown(excess),
        "benchmark_sharpe": _annualized_sharpe(frame["b"]),
        "beta": beta,
        "up_market_excess_annualized": float(up.mean() * 252.0) if len(up) else None,
        "down_market_excess_annualized": float(down.mean() * 252.0) if len(down) else None,
        "regimes": regime_stats,
        "one_sided_regimes": sorted(one_sided),
    }



def _purged_partition_attestation(
    index: pd.Index,
    n_folds: int,
    *,
    embargo_sessions: int,
    sample: str = "holdout",
) -> dict[str, Any]:
    dates = [str(pd.Timestamp(value).date()) for value in index]
    chunks = np.array_split(np.arange(len(dates)), n_folds)
    partitions: list[dict[str, Any]] = []
    for partition_id, chunk in enumerate(chunks):
        usable = chunk[min(max(0, embargo_sessions), len(chunk)) :]
        if not len(chunk) or not len(usable):
            return {}
        partitions.append({
            "partition_id": partition_id,
            "raw_start": dates[int(chunk[0])],
            "raw_end": dates[int(chunk[-1])],
            "test_start": dates[int(usable[0])],
            "test_end": dates[int(usable[-1])],
            "purged_sessions": min(max(0, embargo_sessions), len(chunk)),
        })
    payload = {
        "schema_version": "strategy-mining-purge-attestation-v1",
        "method": "ordered_partition_front_embargo",
        "embargo_sessions": int(embargo_sessions),
        "partition_count": int(n_folds),
        f"{sample}_dates": dates,
        "partitions": partitions,
    }
    if sample != "holdout":
        payload["sample"] = sample
    payload["payload_checksum"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return payload

def _fold_sharpes(returns: pd.Series, n_folds: int) -> list[float]:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    if clean.empty or n_folds <= 1:
        return []
    chunks = np.array_split(np.arange(len(clean)), n_folds)
    return [_annualized_sharpe(clean.iloc[chunk]) for chunk in chunks if len(chunk)]


def _purged_partition_returns(
    returns: pd.Series,
    n_folds: int,
    *,
    embargo_sessions: int,
) -> list[float]:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    if clean.empty or n_folds < 4 or len(clean) < n_folds * (embargo_sessions + 1):
        return []
    chunks = np.array_split(np.arange(len(clean)), n_folds)
    out: list[float] = []
    for chunk in chunks:
        usable = chunk[min(max(0, embargo_sessions), len(chunk)) :]
        if not len(usable):
            return []
        values = clean.iloc[usable].astype(float).to_numpy()
        out.append(float(np.prod(1.0 + values) - 1.0))
    return out


def _pit_market_regimes(close: pd.DataFrame) -> pd.Series:
    market_return = close.pct_change(fill_method=None).median(axis=1).fillna(0.0)
    trend = (1.0 + market_return).rolling(20, min_periods=10).apply(np.prod, raw=True) - 1.0
    volatility = market_return.rolling(20, min_periods=10).std(ddof=0)
    prior_volatility_median = volatility.expanding(min_periods=20).median().shift(1)
    labels = pd.Series("neutral", index=market_return.index, dtype="object")
    labels.loc[trend > 0.03] = "bull"
    labels.loc[trend < -0.03] = "bear"
    high_vol = (
        prior_volatility_median.notna()
        & volatility.notna()
        & (volatility > prior_volatility_median * 1.5)
    )
    labels.loc[high_vol & (labels == "neutral")] = "high_volatility"
    # Label for day t uses information through t-1 only, so the regime a return is bucketed in
    # is not conditioned on that same return.
    return labels.shift(1).fillna("neutral")


def _expected_max_standard_normal(n_trials: float) -> float:
    """E[max of N iid N(0,1)] approximation used by the Deflated Sharpe Ratio (Bailey & LdP 2014)."""
    from scipy.stats import norm

    n = max(float(n_trials), 2.0)
    gamma = 0.5772156649015329
    return float((1.0 - gamma) * norm.ppf(1.0 - 1.0 / n) + gamma * norm.ppf(1.0 - 1.0 / (n * math.e)))


def _sharpe_moments(returns: pd.Series) -> dict[str, float]:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    n_obs = len(clean)
    std = float(clean.std(ddof=0)) if n_obs else 0.0
    if n_obs <= 3 or std <= 1e-12:
        return {"daily_sharpe": 0.0, "skew": 0.0, "kurtosis": 3.0, "sample_count": n_obs}
    return {
        "daily_sharpe": float(clean.mean() / std),
        "skew": _safe_float(clean.skew(), 0.0) or 0.0,
        "kurtosis": (_safe_float(clean.kurt(), 0.0) or 0.0) + 3.0,
        "sample_count": n_obs,
    }


def _effective_trial_count(return_matrix: np.ndarray) -> dict[str, Any]:
    """Effective number of independent trials from the trials' return correlation (Li & Ji 2005).

    M_eff = sum_i [ I(lambda_i >= 1) + (lambda_i - floor(lambda_i)) ] over the eigenvalues of the
    trial-by-trial correlation matrix. Near-duplicate candidates (shared factors, same market beta)
    collapse to ~1 trial instead of each inflating the DSR hurdle as if independent.
    """
    matrix = np.asarray(return_matrix, dtype=float)
    raw = int(matrix.shape[1]) if matrix.ndim == 2 else 0
    if raw == 0:
        return {"raw_trials": 0, "effective_trials": 0.0, "method": "li_ji_2005_eigenvalue"}
    finite_rows = np.all(np.isfinite(matrix), axis=1)
    matrix = matrix[finite_rows]
    std = matrix.std(axis=0) if len(matrix) else np.zeros(raw)
    varying = std > 1e-12
    if len(matrix) < 3 or int(varying.sum()) == 0:
        return {"raw_trials": raw, "effective_trials": 1.0, "method": "li_ji_2005_eigenvalue",
                "constant_trials": int((~varying).sum())}
    corr = np.corrcoef(matrix[:, varying], rowvar=False)
    corr = np.atleast_2d(np.nan_to_num(corr, nan=0.0))
    eigenvalues = np.clip(np.linalg.eigvalsh(corr), 0.0, None)
    effective = float(np.sum((eigenvalues >= 1.0).astype(float) + (eigenvalues - np.floor(eigenvalues))))
    # Constant-return trials (e.g. never invested) count as one extra trial at most.
    effective += 1.0 if int((~varying).sum()) else 0.0
    return {
        "raw_trials": raw,
        "effective_trials": max(1.0, min(float(raw), effective)),
        "method": "li_ji_2005_eigenvalue",
        "observations": int(len(matrix)),
        "constant_trials": int((~varying).sum()),
    }


def _deflated_sharpe(
    moments: dict[str, Any],
    *,
    effective_trials: float,
    cross_trial_sharpe_std: float,
) -> dict[str, Any]:
    """Deflated Sharpe Ratio probability (Bailey & Lopez de Prado 2014).

    SR0 = sqrt(V[SR_n]) * E[max Z] over N effective trials, where V[SR_n] is the cross-sectional
    variance of the trials' Sharpe estimates; the PSR of the candidate is evaluated against SR0.
    The old implementation used the single-estimator standard error for V and the raw trial count,
    which demanded an annualised validation Sharpe of ~4.7-5.6 (infeasible by construction).
    """
    from scipy.stats import norm

    n_obs = int(moments.get("sample_count") or 0)
    daily_sharpe = float(moments.get("daily_sharpe") or 0.0)
    skew = float(moments.get("skew") or 0.0)
    kurtosis = float(moments.get("kurtosis") or 3.0)
    trials = max(1.0, float(effective_trials))
    out = {
        **moments,
        "effective_trials": trials,
        "cross_trial_daily_sharpe_std": float(cross_trial_sharpe_std),
        "method": "bailey_lopez_de_prado_dsr_cross_trial_variance",
    }
    if n_obs <= 3 or daily_sharpe == 0.0:
        return {**out, "probability": 0.0, "z_score": 0.0, "minimum_annualized_sharpe": None}
    sr0 = float(cross_trial_sharpe_std) * _expected_max_standard_normal(trials) if trials > 1.0 else 0.0
    variance_term = 1.0 - skew * daily_sharpe + ((kurtosis - 1.0) / 4.0) * daily_sharpe * daily_sharpe
    sigma_sr = math.sqrt(max(variance_term, 1e-12) / max(1, n_obs - 1))
    z_score = float((daily_sharpe - sr0) / max(sigma_sr, 1e-12))
    return {
        **out,
        "probability": float(norm.cdf(z_score)),
        "z_score": z_score,
        "benchmark_daily_sharpe": sr0,
        "minimum_annualized_sharpe": (sr0 + norm.ppf(0.95) * sigma_sr) * math.sqrt(252.0),
    }


def _candidate_similarity(
    left: set[str],
    right: set[str],
    *,
    pair_map: dict[tuple[str, str], float],
) -> float:
    """Symmetric mean best-match feature similarity between two factor sets (1 = same features)."""
    if not left or not right:
        return 0.0

    def directed(source: set[str], target: set[str]) -> float:
        return float(np.mean([
            max(_feature_pair_similarity(a, b, pair_map=pair_map, feature_meta={}) for b in target)
            for a in source
        ]))

    return 0.5 * (directed(left, right) + directed(right, left))


def _novelty(
    factors: list[str],
    archive: list[set[str]],
    *,
    pair_map: dict[tuple[str, str], float] | None = None,
    neighbours: int = 10,
) -> dict[str, Any]:
    """k-nearest-neighbour novelty against previously evaluated candidates.

    1 - mean similarity to the k MOST similar archived candidates. The old version averaged the
    k largest distances (the least similar candidates), which is ~1.0 for any candidate once the
    archive holds a few disjoint sets, so novelty carried no information.
    """
    current = set(factors)
    if not current or not archive:
        return {"novelty": 1.0, "nearest_similarity": 0.0, "neighbours": 0}
    similarities = sorted(
        (
            _candidate_similarity(current, other, pair_map=pair_map)
            if pair_map is not None
            else _jaccard(current, other)
            for other in archive[-200:]
        ),
        reverse=True,
    )
    nearest = similarities[: max(1, int(neighbours))]
    return {
        "novelty": float(min(1.0, max(0.0, 1.0 - float(np.mean(nearest))))),
        "nearest_similarity": float(nearest[0]),
        "neighbours": len(nearest),
    }


def _pair_key(left: str, right: str) -> tuple[str, str]:
    return tuple(sorted((str(left), str(right))))


def _load_similarity_pair_map(path: Path = FORMAL137_PAIRWISE_SIMILARITY_PATH) -> dict[tuple[str, str], float]:
    pair_map: dict[tuple[str, str], float] = {}
    for row in _read_csv_rows(path):
        left = str(row.get("feature_a") or "").strip()
        right = str(row.get("feature_b") or "").strip()
        if not left or not right or left == right:
            continue
        corr = _safe_float(row.get("abs_rank_corr"))
        if corr is None:
            continue
        pair_map[_pair_key(left, right)] = min(1.0, max(0.0, float(corr)))
    return pair_map


def _similarity_feature_meta(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    meta: dict[str, dict[str, Any]] = {}
    for row in contract.get("features") or []:
        if not isinstance(row, dict):
            continue
        fid = str(row.get("feature_id") or "").strip()
        if not fid:
            continue
        meta[fid] = row
    return meta


def _feature_pair_similarity(
    left: str,
    right: str,
    *,
    pair_map: dict[tuple[str, str], float],
    feature_meta: dict[str, dict[str, Any]],
) -> float:
    del feature_meta
    if left == right:
        return 1.0
    corr = pair_map.get(_pair_key(left, right))
    if corr is not None:
        return corr
    return 1.0


def _missing_similarity_pair_count(
    left: set[str],
    right: set[str],
    *,
    pair_map: dict[tuple[str, str], float],
    same_set: bool = False,
) -> int:
    if not left or not right:
        return 0
    if same_set:
        pairs = itertools.combinations(sorted(left), 2)
    else:
        pairs = ((a, b) for a in left for b in right if a != b)
    return sum(1 for a, b in pairs if _pair_key(a, b) not in pair_map)


def _max_pair_similarity(
    left: set[str],
    right: set[str],
    *,
    pair_map: dict[tuple[str, str], float],
    feature_meta: dict[str, dict[str, Any]],
    same_set: bool = False,
) -> float:
    if not left or not right:
        return 0.0
    best = 0.0
    if same_set:
        pairs = itertools.combinations(sorted(left), 2)
    else:
        pairs = ((a, b) for a in left for b in right)
    for a, b in pairs:
        best = max(best, _feature_pair_similarity(a, b, pair_map=pair_map, feature_meta=feature_meta))
    return best


def _similarity_adjusted_novelty(
    factors: list[str],
    archive: list[set[str]],
    *,
    pair_map: dict[tuple[str, str], float],
    feature_meta: dict[str, dict[str, Any]],
    neighbours: int = 10,
) -> dict[str, Any]:
    current = set(factors)
    max_internal = _max_pair_similarity(
        current,
        current,
        pair_map=pair_map,
        feature_meta=feature_meta,
        same_set=True,
    )
    missing_internal = _missing_similarity_pair_count(
        current,
        current,
        pair_map=pair_map,
        same_set=True,
    )
    knn = _novelty(factors, archive, pair_map=pair_map, neighbours=neighbours)
    # Archive similarity is candidate-to-candidate (nearest archived candidate), not feature-to-
    # union-of-archive: once the archive union covers every feature, the union form is always 1.0
    # and novelty collapsed to the constant 1.0 - 0.45 = 0.55 for every candidate.
    max_archive = float(knn["nearest_similarity"])
    max_similarity = max(max_internal, max_archive)
    penalty = 0.0
    bonus = 0.0
    if max_similarity >= HIGH_DUPLICATE_SIMILARITY_FLOOR:
        penalty = min(0.45, 0.25 + (max_similarity - HIGH_DUPLICATE_SIMILARITY_FLOOR))
    elif max_similarity >= RELATED_CLUSTER_SIMILARITY_FLOOR:
        penalty = min(0.15, (max_similarity - RELATED_CLUSTER_SIMILARITY_FLOOR) * 0.25)
    else:
        bonus = min(0.10, (RELATED_CLUSTER_SIMILARITY_FLOOR - max_similarity) * 0.15)

    base_novelty = float(knn["novelty"])
    adjusted = min(1.0, max(0.0, base_novelty + bonus - penalty))
    return {
        "base_novelty": base_novelty,
        "novelty": adjusted,
        "similarity_novelty_penalty": penalty,
        "similarity_novelty_bonus": bonus,
        "max_internal_similarity": max_internal,
        "max_archive_similarity": max_archive,
        "max_similarity": max_similarity,
        "similarity_matrix_missing_internal_pairs": missing_internal,
        "novelty_neighbours": knn["neighbours"],
        "similarity_novelty_method": "knn_candidate_formal137_pairwise_abs_rank_corr_v2_matrix_only_fail_closed",
    }


def _load_strategy_leaf_refs() -> list[str]:
    contract_error = "missing"
    if STRATEGY_FEATURE_REF_CONTRACT_PATH.exists():
        try:
            contract = json.loads(STRATEGY_FEATURE_REF_CONTRACT_PATH.read_text(encoding="utf-8-sig"))
            leaves = {
                str(row.get("feature_id") or "")[3:]
                for row in contract.get("refs", [])
                if isinstance(row, dict)
                and str(row.get("feature_id") or "").startswith("l1_")
                and row.get("ok", True)
            }
            if leaves:
                return sorted(leaves)
            contract_error = "no_l1_refs"
        except Exception as exc:
            contract_error = f"{type(exc).__name__}: {exc}"
    # The job/Modal image has no Node toolchain (2026-06-18 run died 14 min in with
    # npx_not_found). The TS fallback is a local-research convenience only.
    if os.environ.get("STOCKVISION_ALLOW_STRATEGY_LEAF_TSX_FALLBACK", "").strip() != "1":
        raise RuntimeError(
            f"strategy_feature_ref_contract_unavailable:{STRATEGY_FEATURE_REF_CONTRACT_PATH}:{contract_error}"
        )

    tsx_expr = r"""
import { DEFAULT_STRATEGY_SPECS } from './worker/src/lib/strategySpec';
const active = DEFAULT_STRATEGY_SPECS.filter(s => s.status === 'active' && !s.id.startsWith('alphabuilders_'));
const rawMap = {
  minPrice:'price', maxPrice:'price',
  minCloseAboveMa20Pct:'closeAboveMa20Pct', maxCloseAboveMa20Pct:'closeAboveMa20Pct',
  minCloseAboveMa60Pct:'closeAboveMa60Pct', maxCloseAboveMa60Pct:'closeAboveMa60Pct',
  minVolumeExpansion20:'volumeExpansion20',
  minReturn20d:'return20d', maxReturn20d:'return20d',
  minForeignTrustNet5d:'foreignTrustNet5d',
  minDealerNet5d:'dealerNet5d',
  minBrokerNetShares5d:'brokerNetShares5d',
  minBrokerNetAmount5d:'brokerNetAmount5d',
  minBrokerCount:'brokerCount',
  maxBrokerConcentration:'brokerConcentration',
  minRevenueGrowthYoY:'revenueGrowthYoY',
  minMonthlyRevenueYoY:'monthlyRevenueYoY',
  minMonthlyRevenueMoM:'monthlyRevenueMoM',
  minGrossMargin:'grossMargin',
  minOperatingMargin:'operatingMargin',
  minRoe:'roe',
  minEps:'eps',
  maxPe:'pe',
  maxPb:'pb',
};
const leaves = new Set();
const add = (x) => { if (!x) return; const s = String(x); leaves.add(s.includes('.') ? s.split('.').pop() : s); };
for (const s of active) {
  const t = s.thresholds || {};
  for (const [k,v] of Object.entries(rawMap)) if (t[k] !== undefined) add(v);
  for (const k of Object.keys(t.minTechnicalIndicators || {})) add(k);
  for (const k of Object.keys(t.maxTechnicalIndicators || {})) add(k);
  for (const k of Object.keys(t.minFactorSignals || {})) add(k);
  for (const k of Object.keys(t.maxFactorSignals || {})) add(k);
  for (const group of ['all', 'any', 'not']) for (const c of ((t.dsl || {})[group] || [])) add(c.signal);
}
console.log(JSON.stringify([...leaves].sort()));
"""
    import subprocess

    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        raise RuntimeError("npx_not_found_for_strategy_leaf_refs")
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            suffix=".mts",
            prefix=".alpha-miner-leaf-refs-",
            dir=ROOT,
            delete=False,
        ) as fh:
            fh.write(tsx_expr)
            temp_path = Path(fh.name)
        completed = subprocess.run(
            [npx, "tsx", str(temp_path)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(
            "strategy_leaf_refs_tsx_failed:"
            f" code={completed.returncode}"
            f" stdout={completed.stdout[-1000:]!r}"
            f" stderr={completed.stderr[-1000:]!r}"
        )
    for line in reversed(completed.stdout.splitlines()):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            return list(json.loads(stripped))
    raise RuntimeError(
        "strategy_leaf_refs_json_not_found:"
        f" stdout={completed.stdout[-1000:]!r}"
        f" stderr={completed.stderr[-1000:]!r}"
    )


def _adjusted_close(base: dict[str, pd.DataFrame], close: pd.DataFrame) -> pd.DataFrame:
    """Dividend/split-adjusted close aligned to `close`; strategy returns must not use raw close.

    Raw close drops on every ex-dividend date, so a raw-price return series books dividends as
    losses. Fails closed when the adjusted series is unavailable instead of silently using raw.
    """
    frame = base.get("adj_close")
    if frame is None:
        try:
            from finlab import data

            frame = data.get("etl:adj_close")
        except Exception as exc:  # noqa: BLE001 - surfaced as a fail-closed contract error
            raise RuntimeError(f"strategy_mining_adjusted_close_unavailable:{type(exc).__name__}:{exc}") from exc
    adjusted = pd.DataFrame(frame).copy()
    adjusted.index = pd.to_datetime(adjusted.index)
    adjusted.columns = [str(col).strip() for col in adjusted.columns]
    adjusted = adjusted.sort_index().reindex(index=close.index, columns=close.columns).astype(float)
    if not np.isfinite(adjusted.to_numpy(dtype=float)).any():
        raise RuntimeError("strategy_mining_adjusted_close_empty")
    # Where the raw close exists the adjusted close must too; otherwise returns silently go flat.
    gap = close.notna() & adjusted.isna()
    if float(gap.to_numpy().mean()) > 0.01:
        raise RuntimeError(f"strategy_mining_adjusted_close_coverage_gap:{float(gap.to_numpy().mean()):.4f}")
    return adjusted


def _universe_alignment(universe: str) -> dict[str, Any]:
    """Document how the research universe differs from the live L0 (LISTED + OTC)."""
    markets = ["sii"] if str(universe) == "sii" else ["sii", "otc"]
    return {
        "research_markets": markets,
        "live_l0_markets": ["sii", "otc"],
        "aligned": markets == ["sii", "otc"],
        "symbol_rule": "4-digit common stocks from FinLab security_categories; tradable = raw and adjusted close present",
        "survivorship": (
            "security_categories lists current listings, so names delisted before the run are absent "
            "(survivorship bias, not correctable without a PIT listing table); a held name with no return "
            "on a day (suspension) is carried flat."
        ),
    }


def _seed_from_date(value: str) -> int:
    """Deterministic per-run seed: same run date reproduces, different months explore differently."""
    digest = hashlib.sha256(f"stockvision-strategy-mining:{value}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % (2**31 - 1)


def _resolve_research_protocol(args: argparse.Namespace) -> dict[str, Any]:
    config = {}
    if not getattr(args, "disable_monthly_mining_config", False):
        path = Path(getattr(args, "monthly_mining_config", "") or MONTHLY_MINING_CONFIG_PATH)
        config = (_load_monthly_mining_config(path).get("research_protocol") or {}) if path else {}
    protocol = json.loads(json.dumps(RESEARCH_PROTOCOL_DEFAULTS))
    for key, value in config.items():
        if isinstance(value, dict) and isinstance(protocol.get(key), dict):
            protocol[key] = {**protocol[key], **value}
        else:
            protocol[key] = value
    override = getattr(args, "research_protocol_override", None)
    if isinstance(override, dict):
        for key, value in override.items():
            if isinstance(value, dict) and isinstance(protocol.get(key), dict):
                protocol[key] = {**protocol[key], **value}
            else:
                protocol[key] = value
    return protocol


def _validate_fixed_windows(args: argparse.Namespace, sessions: pd.DatetimeIndex, protocol: dict[str, Any]) -> None:
    keys = ("train_start", "train_end", "validation_start", "validation_end", "holdout_start", "holdout_end")
    missing = [key for key in keys if not getattr(args, key, None)]
    if missing:
        raise RuntimeError(f"strategy_mining_fixed_windows_missing:{','.join(missing)}")
    try:
        bounds = [pd.Timestamp(getattr(args, key)) for key in keys]
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"strategy_mining_fixed_windows_unparseable:{exc}") from exc
    if any(left > right for left, right in zip(bounds, bounds[1:])):
        raise RuntimeError("strategy_mining_fixed_windows_not_ordered")
    gap = int(protocol["purge_sessions"]) + int(protocol["embargo_sessions"])
    for end, start, label in ((bounds[1], bounds[2], "train_validation"), (bounds[3], bounds[4], "validation_holdout")):
        between = int(((sessions > end) & (sessions < start)).sum())
        if between < gap:
            raise RuntimeError(f"strategy_mining_fixed_windows_gap_too_small:{label}:{between}<{gap}")
    not_before = protocol.get("holdout_not_before")
    if not_before and bounds[4] <= pd.Timestamp(not_before):
        raise RuntimeError(f"strategy_mining_fixed_holdout_before_not_before:{not_before}")


def _resolve_walk_forward_windows(
    args: argparse.Namespace,
    index: pd.DatetimeIndex,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    """Rolling train / validation / sealed-holdout windows on the trading calendar.

    Segments are ordered train < validation < holdout and separated by purge+embargo sessions.
    The holdout never reaches back before `holdout_not_before` (data already used for selection by
    earlier runs), so it is fresh and only looked at once, at the gate, for the finalists.
    """
    sessions = pd.DatetimeIndex(index).sort_values()
    sessions = sessions[sessions <= pd.Timestamp(args.end_date)]
    if str(protocol.get("window_mode") or "rolling") == "fixed":
        _validate_fixed_windows(args, sessions, protocol)
        windows = {
            "mode": "fixed",
            "train_start": str(args.train_start), "train_end": str(args.train_end),
            "validation_start": str(args.validation_start), "validation_end": str(args.validation_end),
            "holdout_start": str(args.holdout_start), "holdout_end": str(args.holdout_end),
        }
    else:
        gap = int(protocol["purge_sessions"]) + int(protocol["embargo_sessions"])
        n_hold = int(protocol["holdout_sessions"])
        n_val = int(protocol["validation_sessions"])
        n_train = int(protocol["train_sessions"])
        if len(sessions) < n_train + n_val + 2 * gap + 1:
            raise RuntimeError(
                f"strategy_mining_history_too_short:{len(sessions)}<{n_train + n_val + 2 * gap + 1}"
            )
        hold = sessions[-n_hold:]
        not_before = protocol.get("holdout_not_before")
        if not_before:
            hold = hold[hold > pd.Timestamp(not_before)]
        if len(hold):
            holdout_first = sessions.get_loc(hold[0])
        else:
            holdout_first = len(sessions)
        validation_last = holdout_first - gap - 1
        validation_first = validation_last - n_val + 1
        train_last = validation_first - gap - 1
        train_first = train_last - n_train + 1
        if train_first < 0 or validation_first <= 0:
            raise RuntimeError(
                f"strategy_mining_history_too_short_for_windows:train_first={train_first}:sessions={len(sessions)}"
            )

        def day(position: int) -> str:
            return str(sessions[position].date())

        windows = {
            "mode": "rolling",
            "train_start": day(train_first), "train_end": day(train_last),
            "validation_start": day(validation_first), "validation_end": day(validation_last),
            "holdout_start": day(holdout_first) if len(hold) else None,
            "holdout_end": day(len(sessions) - 1) if len(hold) else None,
            "holdout_sessions": int(len(hold)),
            "gap_sessions": gap,
            "purge_sessions": int(protocol["purge_sessions"]),
            "embargo_sessions": int(protocol["embargo_sessions"]),
            "holdout_not_before": not_before,
        }
    if windows["mode"] == "fixed":
        hold_mask = (sessions >= pd.Timestamp(windows["holdout_start"])) & (sessions <= pd.Timestamp(windows["holdout_end"]))
        windows["holdout_sessions"] = int(hold_mask.sum())
        if pd.Timestamp(windows["validation_end"]) >= pd.Timestamp(windows["holdout_start"]):
            raise RuntimeError("strategy_mining_fixed_windows_overlap")
    windows["selection_start"] = windows["train_start"]
    windows["selection_end"] = windows["validation_end"]
    windows["holdout_gate_ready"] = int(windows.get("holdout_sessions") or 0) >= int(
        protocol.get("min_holdout_sessions_for_gate") or 0
    )
    for key in ("train_start", "train_end", "validation_start", "validation_end", "holdout_start", "holdout_end"):
        setattr(args, key, windows[key])
    return windows


def _feature_triage_check(protocol: dict[str, Any], windows: dict[str, Any]) -> dict[str, Any]:
    """Registry eligibility was triaged on a fixed window; flag (and block promotion) on overlap."""
    triage = protocol.get("feature_triage_window") or {}
    end = triage.get("end")
    overlaps = bool(end) and pd.Timestamp(end) > pd.Timestamp(windows["train_end"])
    return {
        "triage_window": triage,
        "train_end": windows["train_end"],
        "validation_start": windows["validation_start"],
        "overlaps_validation_or_holdout": overlaps,
        "status": "contaminated_promotion_blocked" if overlaps else "clean",
        "regeneration_required": (
            "Re-run the unified179 FinLab triage (finlab_strategy95_backtest / finlab_ml_feature_backtest / "
            "feature_strategy_overlap_numeric / unified179 prune + pairwise similarity, then "
            "build_unified_feature_registry) with --end-date <= train_end, and record the new window in "
            "research_protocol.feature_triage_window. Needs FinLab login."
        ) if overlaps else None,
    }


def _cross_sectional_varying_ratio(frame: pd.DataFrame, tradable: pd.DataFrame) -> float:
    masked = frame.where(tradable.reindex(index=frame.index, columns=frame.columns).fillna(False).astype(bool))
    finite = masked.replace([np.inf, -np.inf], np.nan)
    counts = finite.notna().sum(axis=1)
    spread = (finite.max(axis=1) - finite.min(axis=1)).abs()
    rows = counts >= 2
    if not bool(rows.any()):
        return 0.0
    return float(((spread > 1e-12) & rows).sum() / rows.sum())


def _exclude_cross_sectionally_constant(
    values: dict[str, pd.DataFrame],
    meta: dict[str, FactorMeta],
    tradable: pd.DataFrame,
    *,
    start: str,
    end: str,
    min_varying_ratio: float,
) -> dict[str, Any]:
    """Drop market-level features (same value for every stock on a date) from the mining pool.

    A cross-sectional rank of a constant is a constant, so such a feature (advance_ratio,
    us_sentiment_score) adds a fixed offset to every stock's score and contributes nothing to
    the ranking while still being counted as one of the candidate's factors.
    """
    excluded: dict[str, float] = {}
    for fid in list(values):
        ratio = _cross_sectional_varying_ratio(values[fid].loc[start:end], tradable.loc[start:end])
        if ratio < float(min_varying_ratio):
            excluded[fid] = round(ratio, 6)
            values.pop(fid)
            meta.pop(fid, None)
    return {
        "rule": "exclude if share of train-window dates with cross-sectional variation < min_varying_ratio",
        "min_varying_ratio": float(min_varying_ratio),
        "excluded": excluded,
        "note": "market-level features may only re-enter through an explicit stock-level interaction feature",
    }


def _derive_train_window_directions(
    values: dict[str, pd.DataFrame],
    meta: dict[str, FactorMeta],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    *,
    train_start: str,
    train_end: str,
    horizon: int,
) -> dict[str, Any]:
    """Re-derive fitted directions from the train window only (sign of mean daily rank IC).

    Only features whose direction came from the full-window triage are re-fitted; declared
    directions are economic priors and are left alone. Forward returns are truncated so that no
    target extends past train_end (purge).
    """
    sessions = close.loc[train_start:train_end].index
    if len(sessions) <= horizon + 20:
        raise RuntimeError("strategy_mining_train_window_too_short_for_direction")
    forward = close.shift(-int(horizon)) / close - 1.0
    forward = forward.loc[sessions[0]: sessions[-(horizon + 1)]]
    target_rank = forward.where(tradable.reindex(index=forward.index, columns=forward.columns).fillna(False)).rank(axis=1, pct=True)
    changed: dict[str, dict[str, Any]] = {}
    derived = 0
    for fid, info in list(meta.items()):
        if info.direction_source != "full_window_triage":
            continue
        frame = values[fid].reindex(index=target_rank.index, columns=target_rank.columns)
        feature_rank = frame.where(target_rank.notna()).rank(axis=1, pct=True)
        ic = feature_rank.corrwith(target_rank, axis=1).replace([np.inf, -np.inf], np.nan).dropna()
        mean_ic = float(ic.mean()) if len(ic) else 0.0
        direction = -1.0 if mean_ic < 0 else 1.0
        derived += 1
        if direction != info.direction:
            changed[fid] = {"triage_direction": info.direction, "train_direction": direction, "train_mean_ic": round(mean_ic, 6)}
        meta[fid] = FactorMeta(
            id=info.id,
            source=info.source,
            category=info.category,
            direction=direction,
            direction_source="train_window_rank_ic",
        )
    return {
        "method": "sign_of_mean_daily_rank_ic_vs_forward_return",
        "horizon_sessions": int(horizon),
        "train_window": [train_start, train_end],
        "derived_count": derived,
        "changed_vs_full_window_triage": changed,
    }


def _benchmark_returns(
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    *,
    execution_lag: int,
) -> pd.Series:
    """Equal-weight return of every tradable name, on the same signal-to-fill lag as candidates."""
    return _portfolio_returns(tradable, close, commission_rate=0.0, sell_tax_rate=0.0, execution_lag=execution_lag)


def _build_factor_universe(args: argparse.Namespace) -> tuple[
    pd.DataFrame,
    pd.DataFrame,
    dict[str, pd.DataFrame],
    dict[str, FactorMeta],
    dict[str, Any],
]:
    ab = _load_module(AB_RUNNER, "stockvision_ab_factor_runner")
    spec_runner = _load_module(SPEC_RUNNER, "stockvision_strategy_spec_runner")

    with open(args.factor_json, "r", encoding="utf-8-sig") as fh:
        ab_factors = json.load(fh)

    base = ab._build_base_data(args.universe)
    close = base["close"].loc[: args.end_date]
    high = base["high"].loc[: args.end_date]
    low = base["low"].loc[: args.end_date]
    volume = base["volume"].loc[: args.end_date]
    values, mapping = ab._build_factor_values(base)

    columns = close.columns.tolist()
    tech_features = spec_runner._technical_features(close, high, low, volume)
    fin_features = spec_runner._financial_features(close, columns)
    chip_features = spec_runner._chip_features(close, columns)
    sector_features = spec_runner._sector_features(close, volume, columns)
    l1_features = {
        **tech_features,
        **fin_features,
        **chip_features,
        **sector_features,
    }

    factor_values: dict[str, pd.DataFrame] = {}
    meta: dict[str, FactorMeta] = {}
    missing: list[str] = []
    semantic_duplicates: dict[str, str] = {}

    for factor in ab_factors:
        fid = str(factor.get("id") or "")
        frame = values.get(fid)
        if frame is None:
            missing.append(fid)
            continue
        factor_values[fid] = frame.reindex(index=close.index, columns=columns)
        meta[fid] = FactorMeta(
            id=fid,
            source="alphabuilderstw",
            category=str(factor.get("category") or "unknown"),
            direction=float(factor.get("direction") or 1.0),
        )

    l1_refs = _load_strategy_leaf_refs()
    for leaf in l1_refs:
        if leaf in L1_SEMANTIC_DUPLICATE_ALIASES:
            semantic_duplicates[leaf] = L1_SEMANTIC_DUPLICATE_ALIASES[leaf]
            continue
        frame = l1_features.get(leaf)
        if frame is None:
            missing.append(f"l1:{leaf}")
            continue
        fid = f"l1_{leaf}"
        factor_values[fid] = frame.reindex(index=close.index, columns=columns)
        meta[fid] = FactorMeta(
            id=fid,
            source="stockvision_l1",
            category="l1_signal",
            direction=float(L1_SIGNAL_DIRECTIONS.get(leaf, 1.0)),
        )

    date_mask = (close.index >= pd.Timestamp(args.start_date)) & (close.index <= pd.Timestamp(args.end_date))
    pricing = _adjusted_close(base, close)
    tradable = close.notna() & pricing.notna() & pd.DataFrame(
        np.repeat(np.asarray(date_mask)[:, None], len(columns), axis=1),
        index=close.index,
        columns=columns,
    )
    info = {
        "universe_alignment": _universe_alignment(args.universe),
        "alphabuilderstw_input_count": len(ab_factors),
        "l1_non_alpha_leaf_count": len(l1_refs),
        "mapped_factor_count": len(factor_values),
        "missing": sorted(set(missing)),
        "semantic_duplicates": semantic_duplicates,
        "ab_mapping": mapping,
    }
    return pricing, tradable, factor_values, meta, info


def _build_canonical114_factor_universe(args: argparse.Namespace) -> tuple[
    pd.DataFrame,
    pd.DataFrame,
    dict[str, pd.DataFrame],
    dict[str, FactorMeta],
    dict[str, Any],
]:
    ab = _load_module(AB_RUNNER, "stockvision_canonical114_ab_runner")
    overlap = _load_module(OVERLAP_RUNNER, "stockvision_canonical114_overlap_runner")

    base = ab._build_base_data(args.universe)
    close_all = base["close"].loc[: args.end_date]
    columns = close_all.columns.tolist()
    if getattr(args, "max_symbols", 0) > 0:
        columns = columns[: args.max_symbols]
    index = overlap._common_index(close_all, args.start_date, args.end_date)
    close = close_all.reindex(index=index, columns=columns).astype(float)
    pricing = _adjusted_close(base, close)
    tradable = close.notna() & pricing.notna()

    ml_values, ml_feature_names = overlap._build_ml_feature_pool(
        base=base,
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )
    # The ML106 backtest file is named after the configured feature-triage window, not a fixed stem.
    triage_window = _load_module(TRIAGE_WINDOW_HELPER, "stockvision_feature_triage_window")
    triage_config = Path(getattr(args, "monthly_mining_config", "") or MONTHLY_MINING_CONFIG_PATH)
    ml106_best_path = triage_window.triage_paths(
        triage_window.window_stem(*triage_window.triage_window(triage_config))
    )["ml106_best"]
    ml_direction = _load_direction_map(ml106_best_path, id_key="feature_id", direction_key="direction_mode")

    strategy_values, strategy_meta, strategy_info = overlap._build_strategy_factor_pool(
        base=base,
        factor_json=Path(args.factor_json),
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )
    triage_rows = _read_csv_rows(STRATEGY95_VS_ML106_PATH)
    selected_strategy_factors = {
        str(row.get("strategy_factor") or "").strip()
        for row in triage_rows
        if str(row.get("action") or "").strip() == "candidate_add_to_shared_pool"
    }
    if not selected_strategy_factors:
        selected_strategy_factors = set(CANONICAL114_SELECTED_STRATEGY_FACTORS)

    factor_values: dict[str, pd.DataFrame] = {}
    meta: dict[str, FactorMeta] = {}
    missing: list[str] = []
    for fid in ml_feature_names:
        frame = ml_values.get(fid)
        if frame is None:
            missing.append(f"ml106:{fid}")
            continue
        factor_values[fid] = frame.reindex(index=close.index, columns=columns)
        meta[fid] = FactorMeta(
            id=fid,
            source="ml106",
            category=_feature_group(fid),
            direction=float(ml_direction.get(fid, 1.0)),
            direction_source="full_window_triage",
        )

    for fid in sorted(selected_strategy_factors):
        frame = strategy_values.get(fid)
        if frame is None:
            missing.append(f"strategy:{fid}")
            continue
        raw_meta = strategy_meta.get(fid, {})
        factor_values[fid] = frame.reindex(index=close.index, columns=columns)
        meta[fid] = FactorMeta(
            id=fid,
            source=str(raw_meta.get("source") or "strategy95_selected"),
            category=str(raw_meta.get("category") or "strategy_selected"),
            direction=float(raw_meta.get("direction") or 1.0),
        )

    info = {
        "factor_universe_mode": "canonical114",
        "ml106_input_count": int(len(ml_feature_names)),
        "strategy_selected_input_count": int(len(selected_strategy_factors)),
        "mapped_factor_count": int(len(factor_values)),
        "missing": sorted(set(missing)),
        "strategy_selected_factors": sorted(selected_strategy_factors),
        "direction_source": {
            "ml106": "re-derived on the train window (full-window triage only seeds it)",
            "strategy_selected": "declared",
        },
        "universe_alignment": _universe_alignment(args.universe),
        "strategy_info": strategy_info,
        "note": "canonical114 = ML106 FEATURE_COLS + selected low-overlap strategy factors. Research-only alpha mining universe.",
    }
    return pricing, tradable, factor_values, meta, info


def _load_unified_feature_registry(path: Path = UNIFIED_FEATURE_REGISTRY_PATH) -> dict[str, Any]:
    if not path.exists():
        raise RuntimeError(f"unified_feature_registry_missing:{path}")
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        raise RuntimeError(f"unified_feature_registry_invalid:{path}")
    return data


def _load_monthly_mining_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"monthly_mining_config_invalid:{path}")
    return data


def _load_similarity_contract(path: Path = FORMAL137_SIMILARITY_CONTRACT_PATH) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"similarity_contract_invalid:{path}")
    return data


def _apply_monthly_mining_config(args: argparse.Namespace) -> argparse.Namespace:
    if getattr(args, "disable_monthly_mining_config", False):
        args.monthly_mining_config_applied = False
        return args

    path = Path(getattr(args, "monthly_mining_config", "") or MONTHLY_MINING_CONFIG_PATH)
    config = _load_monthly_mining_config(path)
    defaults = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    applied: dict[str, Any] = {}
    for name, parser_default in MONTHLY_CONFIGURABLE_DEFAULTS.items():
        if name not in defaults:
            continue
        current = getattr(args, name)
        if current == parser_default:
            setattr(args, name, defaults[name])
            applied[name] = defaults[name]

    args.monthly_mining_config_applied = bool(applied)
    args.monthly_mining_config_path = str(path)
    args.monthly_mining_config_version = config.get("schema_version")
    args.monthly_mining_config_applied_values = applied
    return args


def _runtime_float_frame(frame: pd.DataFrame, index: pd.DatetimeIndex, columns: list[str]) -> pd.DataFrame:
    return frame.reindex(index=index, columns=columns).replace([np.inf, -np.inf], np.nan).astype("float32")


def _registry_l1_leaf_id(feature_id: str) -> str | None:
    if not feature_id.startswith("l1_"):
        return None
    leaf = feature_id[3:].strip()
    return leaf or None


def _build_registry_l1_feature_pool(
    *,
    base: dict[str, pd.DataFrame],
    end_date: str,
    columns: list[str],
) -> dict[str, pd.DataFrame]:
    spec_runner = _load_module(SPEC_RUNNER, "stockvision_unified_registry_l1_spec_runner")
    close = base["close"].loc[:end_date].reindex(columns=columns)
    high = base["high"].loc[:end_date].reindex(index=close.index, columns=columns)
    low = base["low"].loc[:end_date].reindex(index=close.index, columns=columns)
    volume = base["volume"].loc[:end_date].reindex(index=close.index, columns=columns)
    return {
        **spec_runner._technical_features(close, high, low, volume),
        **spec_runner._financial_features(close, columns),
        **spec_runner._chip_features(close, columns),
        **spec_runner._sector_features(close, volume, columns),
    }


def _supplement_registry_l1_strategy_values(
    *,
    registry_features: list[dict[str, Any]],
    strategy_values: dict[str, pd.DataFrame],
    strategy_meta: dict[str, dict[str, Any]],
    base: dict[str, pd.DataFrame],
    index: pd.DatetimeIndex,
    end_date: str,
    columns: list[str],
) -> dict[str, Any]:
    required: dict[str, str] = {}
    for row in registry_features:
        if not isinstance(row, dict) or not row.get("eligible_for_alpha_mining"):
            continue
        if str(row.get("runtime_value_source") or "") != "strategy95":
            continue
        fid = str(row.get("feature_id") or "").strip()
        if not fid or fid in strategy_values:
            continue
        leaf = _registry_l1_leaf_id(fid)
        if leaf:
            required[fid] = leaf

    if not required:
        return {
            "requested_count": 0,
            "supplemented_count": 0,
            "supplemented": [],
            "missing": [],
        }

    l1_features = _build_registry_l1_feature_pool(base=base, end_date=end_date, columns=columns)
    supplemented: list[str] = []
    missing: list[str] = []
    for fid, leaf in sorted(required.items()):
        frame = l1_features.get(leaf)
        if frame is None:
            missing.append(fid)
            continue
        direction = float(L1_SIGNAL_DIRECTIONS.get(leaf, 1.0))
        # Raw panel; the direction is applied once, in _candidate_score.
        strategy_values[fid] = _runtime_float_frame(frame, index, columns)
        strategy_meta[fid] = {
            "id": fid,
            "source": "stockvision_l1_registry",
            "category": "l1_signal",
            "direction": direction,
            "materialized_from": "registry_l1_supplement",
            "leaf": leaf,
        }
        supplemented.append(fid)

    return {
        "requested_count": len(required),
        "supplemented_count": len(supplemented),
        "supplemented": supplemented,
        "missing": missing,
    }


def _build_unified_registry_factor_universe(args: argparse.Namespace) -> tuple[
    pd.DataFrame,
    pd.DataFrame,
    dict[str, pd.DataFrame],
    dict[str, FactorMeta],
    dict[str, Any],
]:
    ab = _load_module(AB_RUNNER, "stockvision_unified_registry_ab_runner")
    overlap = _load_module(OVERLAP_RUNNER, "stockvision_unified_registry_overlap_runner")
    registry = _load_unified_feature_registry(Path(getattr(args, "feature_registry", "") or UNIFIED_FEATURE_REGISTRY_PATH))
    similarity_contract = _load_similarity_contract(
        Path(getattr(args, "similarity_contract", "") or FORMAL137_SIMILARITY_CONTRACT_PATH)
    )

    base = ab._build_base_data(args.universe)
    close_all = base["close"].loc[: args.end_date]
    columns = close_all.columns.tolist()
    if getattr(args, "max_symbols", 0) > 0:
        columns = columns[: args.max_symbols]
    index = overlap._common_index(close_all, args.start_date, args.end_date)
    close = close_all.reindex(index=index, columns=columns).astype(float)
    pricing = _adjusted_close(base, close)
    tradable = close.notna() & pricing.notna()
    registry_features = registry.get("features", [])
    required_ml_features = {
        str(row.get("feature_id") or "").strip()
        for row in registry_features
        if isinstance(row, dict)
        and row.get("eligible_for_alpha_mining")
        and str(row.get("runtime_value_source") or "").strip() == "ml106"
        and str(row.get("feature_id") or "").strip()
    }

    ml_values, _ml_feature_names = overlap._build_ml_feature_pool(
        base=base,
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
        required_features=required_ml_features,
    )

    strategy_values, strategy_meta, strategy_info = overlap._build_strategy_factor_pool(
        base=base,
        factor_json=Path(args.factor_json),
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )
    l1_supplement_info = _supplement_registry_l1_strategy_values(
        registry_features=registry_features,
        strategy_values=strategy_values,
        strategy_meta=strategy_meta,
        base=base,
        index=index,
        end_date=args.end_date,
        columns=columns,
    )

    factor_values: dict[str, pd.DataFrame] = {}
    meta: dict[str, FactorMeta] = {}
    missing: list[str] = []
    selected_registry_rows: list[dict[str, Any]] = []
    unavailable_candidates: list[str] = []
    selected_role_counts: dict[str, int] = {}
    for row in registry_features:
        if not isinstance(row, dict) or not row.get("eligible_for_alpha_mining"):
            continue
        fid = str(row.get("feature_id") or "").strip()
        source = str(row.get("runtime_value_source") or "").strip()
        if not fid:
            continue
        selected_registry_rows.append(row)
        role = str(row.get("selector_role") or "unknown")
        selected_role_counts[role] = selected_role_counts.get(role, 0) + 1
        if source == "ml106":
            frame = ml_values.pop(fid, None)
            # Registry triage direction was fitted on 2023-01..2026-06 (overlaps validation and
            # holdout); it only seeds the value and run() re-derives it on the train window.
            direction = _registry_direction(row, 1.0)
            direction_source = "full_window_triage"
            category = str(row.get("category") or _feature_group(fid))
            source_label = str(row.get("source_system") or "stockvision_formal137")
        elif source == "strategy95":
            frame = strategy_values.pop(fid, None)
            raw_meta = strategy_meta.pop(fid, {})
            direction = float(raw_meta.get("direction") or 1.0)
            direction_source = "declared"
            category = str(row.get("category") or raw_meta.get("category") or "strategy95")
            source_label = str(row.get("source_system") or raw_meta.get("source") or "strategy95")
        else:
            unavailable_candidates.append(fid)
            continue
        if frame is None:
            missing.append(f"{source}:{fid}")
            continue
        factor_values[fid] = _runtime_float_frame(frame, close.index, columns)
        meta[fid] = FactorMeta(
            id=fid,
            source=source_label,
            category=category,
            direction=direction,
            direction_source=direction_source,
        )
    del ml_values, strategy_values, strategy_meta
    gc.collect()

    info = {
        "factor_universe_mode": "unified_registry_v1",
        "registry_path": str(Path(getattr(args, "feature_registry", "") or UNIFIED_FEATURE_REGISTRY_PATH)),
        "registry_total_features": int(len(registry.get("features", []))),
        "registry_eligible_alpha_mining_count": int(len(selected_registry_rows)),
        "mapped_factor_count": int(len(factor_values)),
        "missing": sorted(set(missing)),
        "unavailable_candidates": sorted(set(unavailable_candidates)),
        "status_counts": (registry.get("summary") or {}).get("status_counts"),
        "selector_role_counts": (registry.get("summary") or {}).get("selector_role_counts"),
        "selected_selector_role_counts": selected_role_counts,
        "similarity_contract": {
            "path": str(Path(getattr(args, "similarity_contract", "") or FORMAL137_SIMILARITY_CONTRACT_PATH)),
            "schema_version": similarity_contract.get("schema_version"),
            "counts": similarity_contract.get("counts"),
            "duplicate_level_counts": similarity_contract.get("duplicate_level_counts"),
            "selector_role_counts": similarity_contract.get("selector_role_counts"),
            "metadata_loaded": bool(similarity_contract),
            "decision_effect": "metadata_only",
        },
        "origin_counts": (registry.get("summary") or {}).get("origin_counts"),
        "registry_l1_supplement": l1_supplement_info,
        "direction_source": "strategy95=declared (AlphaBuilders json / L1 signal map); ml106=re-derived on the train window",
        "universe_alignment": _universe_alignment(args.universe),
        "strategy_info": strategy_info,
        "note": "unified_registry_v1 supersedes canonical114. L1, ML, PLE, L1.25 and alpha mining share one registry; consumers may apply transforms but may not maintain independent feature universes.",
    }
    return pricing, tradable, factor_values, meta, info


def _candidate_score(
    candidate: Candidate,
    values: dict[str, pd.DataFrame],
    meta: dict[str, FactorMeta],
    *,
    min_weight_coverage: float = 0.5,
) -> pd.DataFrame | None:
    """Combine oriented cross-sectional ranks of the candidate's factors.

    Direction is applied here and only here. Fails closed (None) when any factor is unavailable,
    so a candidate is never silently scored on fewer factors than it declares. For weighted_sum a
    stock missing some factors is scored on the factors it has, re-normalised by the weight that
    is present, and only when that weight is >= min_weight_coverage (previously one NaN factor,
    even at 5% weight, dropped the stock from the ranking).
    """
    if any(fid not in values or fid not in meta for fid in candidate.factor_ids):
        return None
    if candidate.directions is not None:
        directions = _validated_directions(candidate.directions, candidate.factor_ids, label=candidate.candidate_id)
    else:
        directions = [float(meta[fid].direction) for fid in candidate.factor_ids]
    weights = _normalize_weights(candidate.weights)
    ranks = [_rank_pct(values[fid] * direction) for fid, direction in zip(candidate.factor_ids, directions)]
    if not ranks:
        return None
    covered_weight = None
    for rank, weight in zip(ranks, weights):
        coverage = rank.notna().astype(float) * weight
        covered_weight = coverage if covered_weight is None else covered_weight + coverage
    if candidate.combine in {"max", "min"}:
        weighted = [rank * weight for rank, weight in zip(ranks, weights)]
        grouped = pd.concat(weighted, axis=0).groupby(level=0)
        combined = grouped.max() if candidate.combine == "max" else grouped.min()
        return combined.where(covered_weight.reindex_like(combined) >= float(min_weight_coverage) - 1e-12)
    total = None
    covered = None
    for rank, weight in zip(ranks, weights):
        present = rank.notna()
        contribution = rank.fillna(0.0) * weight
        coverage = present.astype(float) * weight
        total = contribution if total is None else total + contribution
        covered = coverage if covered is None else covered + coverage
    score = total / covered.where(covered > 0)
    return score.where(covered >= float(min_weight_coverage) - 1e-12)


def _parse_float_list(raw: Any) -> list[float] | None:
    """A list of floats from a row field (list, JSON or Python literal string); None if absent."""
    if raw is None:
        return None
    if isinstance(raw, float) and not math.isfinite(raw):
        return None
    if isinstance(raw, str):
        text = raw.strip()
        if not text or text.lower() in {"nan", "none", "null"}:
            return None
        try:
            raw = json.loads(text)
        except ValueError:
            import ast

            try:
                raw = ast.literal_eval(text)
            except (ValueError, SyntaxError) as exc:
                raise ValueError(f"factor_directions_unparseable:{text[:80]}") from exc
    if isinstance(raw, np.ndarray):
        raw = raw.tolist()
    if not isinstance(raw, (list, tuple)):
        raise ValueError(f"factor_directions_not_a_list:{type(raw).__name__}")
    return [float(value) for value in raw]


def _validated_directions(directions: list[float], factor_ids: list[str], *, label: str) -> list[float]:
    out = [float(value) for value in directions]
    if len(out) != len(factor_ids):
        raise ValueError(f"factor_directions_length_mismatch:{label}:{len(out)}!={len(factor_ids)}")
    if any(value not in (-1.0, 1.0) for value in out):
        raise ValueError(f"factor_directions_not_unit_sign:{label}:{out}")
    return out


LEGACY_DIRECTION_MODES = ("fail_closed", "as_mined")


def _legacy_as_mined_directions(
    factor_ids: list[str],
    meta: dict[str, FactorMeta],
    *,
    recorded_factor_meta: dict[str, Any] | None = None,
) -> list[float]:
    """Directions a pre-v3 row (no factor_directions) was actually scored with.

    Before the B1 fix the strategy pools (AlphaBuilders json, L1 leaves, L1 supplement) returned
    values already multiplied by their declared direction, and _candidate_score multiplied by the
    run's FactorMeta direction again. The effective direction on the raw panel was therefore
    recorded_meta_direction * (declared direction for a declared/strategy factor, else 1).
    recorded_factor_meta is the mining report's factor_universe.factor_meta (required for canonical114
    runs, whose strategy meta came from triage); without it the current meta stands in, which is only
    correct when the registry / triage files are unchanged since the run (unified_registry_v1).
    """
    out: list[float] = []
    for fid in factor_ids:
        current = meta.get(fid)
        if current is None:
            raise RuntimeError(f"legacy_direction_factor_unavailable:{fid}")
        if recorded_factor_meta is not None:
            recorded = recorded_factor_meta.get(fid)
            if not isinstance(recorded, dict) or _safe_float(recorded.get("direction")) is None:
                raise RuntimeError(f"legacy_direction_missing_in_recorded_factor_meta:{fid}")
            recorded_direction = float(recorded["direction"])
        else:
            recorded_direction = float(current.direction)
        pre_oriented = float(current.direction) if current.direction_source == "declared" else 1.0
        out.append(-1.0 if recorded_direction * pre_oriented < 0 else 1.0)
    return out


def _resolve_candidate_directions(
    record: dict[str, Any],
    meta: dict[str, FactorMeta],
    *,
    legacy_direction_mode: str = "fail_closed",
    recorded_factor_meta: dict[str, Any] | None = None,
) -> tuple[list[float], str]:
    """Directions to replay a mined row with, and where they came from.

    v3+ rows carry factor_directions (train-window re-derived); those are used verbatim. A row
    without them fails closed unless the caller explicitly asks for the legacy as-mined branch.
    """
    factor_ids = [str(fid) for fid in record.get("factor_ids") or []]
    label = str(record.get("candidate_id") or record.get("id") or "?")
    recorded = _parse_float_list(record.get("factor_directions"))
    if recorded is not None:
        return _validated_directions(recorded, factor_ids, label=label), "recorded_factor_directions"
    mode = str(legacy_direction_mode or "fail_closed")
    if mode not in LEGACY_DIRECTION_MODES:
        raise ValueError(f"unknown_legacy_direction_mode:{mode}")
    if mode == "fail_closed":
        raise RuntimeError(
            f"factor_directions_missing:{label}: row predates recorded directions; "
            "replay it only with an explicit legacy_direction_mode=as_mined"
        )
    directions = _legacy_as_mined_directions(factor_ids, meta, recorded_factor_meta=recorded_factor_meta)
    source = "legacy_as_mined_recorded_factor_meta" if recorded_factor_meta is not None else "legacy_as_mined_current_meta"
    return directions, source


def _load_recorded_factor_meta(report_path: Path) -> dict[str, Any]:
    """factor_universe.factor_meta of a mining report (the run's own direction record)."""
    payload = json.loads(Path(report_path).read_text(encoding="utf-8"))
    factor_meta = (payload.get("factor_universe") or {}).get("factor_meta")
    if not isinstance(factor_meta, dict) or not factor_meta:
        raise RuntimeError(f"recorded_factor_meta_missing:{report_path}")
    return factor_meta


@dataclass
class MiningContext:
    values: dict[str, pd.DataFrame]
    meta: dict[str, FactorMeta]
    close: pd.DataFrame  # adjusted close (pricing frame)
    tradable: pd.DataFrame
    args: argparse.Namespace
    protocol: dict[str, Any]
    windows: dict[str, Any]
    benchmark: pd.Series
    market_regimes: pd.Series
    selection_attestation: dict[str, Any]
    archive: list[set[str]]
    label_archive: list[np.ndarray]
    similarity_pair_map: dict[tuple[str, str], float]
    similarity_feature_meta: dict[str, dict[str, Any]]


def _candidate_position(candidate: Candidate, score: pd.DataFrame, ctx: MiningContext, end: str) -> pd.DataFrame:
    args = ctx.args
    if candidate.algorithm == "pymoo_labeler_v2" or candidate.label_threshold is not None:
        threshold = float(candidate.label_threshold or getattr(args, "labeler_min_percentile", 0.55))
        return _labels_from_score(score.loc[:end], threshold, ctx.tradable).loc[args.start_date: end]
    return _position_from_score(score.loc[:end], args.top_k, ctx.tradable).loc[args.start_date: end]


def _candidate_returns(position: pd.DataFrame, ctx: MiningContext, end: str) -> pd.Series:
    """Net returns of an already rebalanced position, priced only on sessions <= end."""
    protocol = ctx.protocol
    return _portfolio_returns(
        position,
        ctx.close.loc[:end],
        commission_rate=float(protocol["commission_rate"]),
        sell_tax_rate=float(protocol["sell_tax_rate"]),
        execution_lag=int(protocol["execution_lag_sessions"]),
    )


def _evaluate_candidate(candidate: Candidate, ctx: MiningContext) -> dict[str, Any]:
    """Score one candidate on the SELECTION sample (train + validation) only.

    The holdout window is not touched here: prices after selection_end are sliced away before
    returns are computed. Holdout evaluation happens once, for the gate finalists, in
    _seal_holdout_evaluation.
    """
    args, protocol, windows = ctx.args, ctx.protocol, ctx.windows
    score = _candidate_score(
        candidate,
        ctx.values,
        ctx.meta,
        min_weight_coverage=float(protocol["min_factor_weight_coverage"]),
    )
    if score is None:
        return {
            "candidate_id": candidate.candidate_id,
            "algorithm": candidate.algorithm,
            "status": "effective_factor_count_dropped",
            "factor_ids": candidate.factor_ids,
            "fitness": None,
        }
    is_labeler_v2 = candidate.algorithm == "pymoo_labeler_v2"
    selection_end = windows["selection_end"]
    raw_position = _candidate_position(candidate, score, ctx, selection_end)
    position = _rebalance_position(raw_position, args.resample)
    returns = _candidate_returns(position, ctx, selection_end)
    gate = protocol["selection_gate"]
    relative = {
        name: _benchmark_relative_metrics(
            returns.loc[start:end],
            ctx.benchmark,
            ctx.market_regimes,
            regime_min_observations=int(gate["regime_min_observations"]),
            regime_min_excess_return_annualized=float(gate["regime_min_excess_return_annualized"]),
        )
        for name, (start, end) in {
            "train": (windows["train_start"], windows["train_end"]),
            "validation": (windows["validation_start"], windows["validation_end"]),
            "selection": (windows["selection_start"], windows["selection_end"]),
        }.items()
    }
    selection_returns = returns.loc[windows["selection_start"]: windows["selection_end"]]
    selection_excess = (selection_returns - ctx.benchmark.reindex(selection_returns.index)).fillna(0.0)
    validation_turnover = _mean_turnover(position.loc[windows["validation_start"]: windows["validation_end"]])
    novelty_evidence = _similarity_adjusted_novelty(
        candidate.factor_ids,
        ctx.archive,
        pair_map=ctx.similarity_pair_map,
        feature_meta=ctx.similarity_feature_meta,
        neighbours=int(protocol["novelty_neighbours"]),
    )
    novelty = float(novelty_evidence["novelty"])
    validation_window = raw_position.loc[windows["validation_start"]: windows["validation_end"]]
    label_metrics = _label_matrix_metrics(validation_window, ctx.tradable) if is_labeler_v2 else {}
    label_signature = (
        _label_signature(validation_window, int(protocol["label_signature_date_stride"])) if is_labeler_v2 else None
    )
    label_matrix_novelty = (
        _label_matrix_novelty(label_signature, ctx.label_archive)
        if label_signature is not None
        else 0.0
    )
    # Selection sample only: the warm-up before train_start is not part of what is evaluated.
    turnover = _mean_turnover(position.loc[windows["selection_start"]: selection_end])
    complexity = len(candidate.factor_ids)
    factor_directions = (
        [float(value) for value in candidate.directions]
        if candidate.directions is not None
        else [float(ctx.meta[fid].direction) for fid in candidate.factor_ids]
    )
    validation_excess_sharpe = float(relative["validation"]["excess_sharpe"])
    train_excess_sharpe = float(relative["train"]["excess_sharpe"])
    validation_metrics = _slice_metrics(returns.loc[windows["validation_start"]: windows["validation_end"]])
    fitness = (
        validation_excess_sharpe * 0.45
        + train_excess_sharpe * 0.15
        + novelty * 0.20
        - max(0.0, abs(validation_metrics["max_drawdown"]) - 0.35) * 2.0
        - validation_turnover * 0.15
        - complexity * 0.015
    )
    if is_labeler_v2:
        fitness += (
            label_matrix_novelty * 0.20
            + float(label_metrics.get("label_entropy") or 0.0) * 0.10
        )
    selection_partition_returns = _purged_partition_returns(
        selection_excess,
        args.pbo_folds,
        embargo_sessions=args.pbo_embargo_sessions,
    )
    return {
        "candidate_id": candidate.candidate_id,
        "algorithm": candidate.algorithm,
        "status": "ok",
        "factor_ids": candidate.factor_ids,
        "weights": [round(w, 6) for w in _normalize_weights(candidate.weights)],
        # Directions the candidate was scored with (train-window re-derived for fitted features);
        # replays must use these, not the registry's full-window triage direction.
        "factor_directions": factor_directions,
        "factor_direction_sources": [ctx.meta[fid].direction_source for fid in candidate.factor_ids],
        "combine": candidate.combine,
        "complexity": complexity,
        "base_novelty": novelty_evidence["base_novelty"],
        "novelty": novelty,
        "similarity_novelty_penalty": novelty_evidence["similarity_novelty_penalty"],
        "similarity_novelty_bonus": novelty_evidence["similarity_novelty_bonus"],
        "max_internal_similarity": novelty_evidence["max_internal_similarity"],
        "max_archive_similarity": novelty_evidence["max_archive_similarity"],
        "max_similarity": novelty_evidence["max_similarity"],
        "similarity_novelty_method": novelty_evidence["similarity_novelty_method"],
        "search_contract": "label_all_l0_v2" if is_labeler_v2 else "portfolio_top_k_v1",
        "label_threshold_percentile": candidate.label_threshold if is_labeler_v2 else None,
        "label_matrix_novelty": label_matrix_novelty,
        "label_matrix_metrics": label_metrics,
        "_label_signature": label_signature,
        "_selection_excess_returns": selection_excess.to_numpy(dtype=np.float64),
        "turnover": turnover,
        "validation_turnover": validation_turnover,
        "fitness": fitness,
        "fitness_contract": "selection_sample_excess_v3_holdout_sealed",
        "sharpe_moments": _sharpe_moments(selection_excess),
        "selection_partition_returns": selection_partition_returns,
        "selection_attestation_checksum": ctx.selection_attestation.get("payload_checksum"),
        "pbo_embargo_sessions": args.pbo_embargo_sessions,
        "train": _slice_metrics(returns.loc[windows["train_start"]: windows["train_end"]]),
        "validation": validation_metrics,
        "selection": _slice_metrics(selection_returns),
        "train_excess": relative["train"],
        "validation_excess": relative["validation"],
        "selection_excess": relative["selection"],
        "latest_matches": int(position.sum(axis=1).iloc[-1]) if len(position) else 0,
        "match_days": int((position.sum(axis=1) > 0).sum()) if len(position) else 0,
    }


def _random_candidate(
    rng: random.Random,
    algorithm: str,
    index: int,
    factor_ids: list[str],
    *,
    min_factors: int,
    max_factors: int,
) -> Candidate:
    k = rng.randint(min_factors, max_factors)
    selected = rng.sample(factor_ids, k)
    weights = [rng.random() + 0.05 for _ in selected]
    combine = rng.choice(["weighted_sum", "weighted_sum", "weighted_sum", "max"])
    return Candidate(f"{algorithm}_{index:04d}", algorithm, selected, weights, combine=combine)


def _run_random(
    factor_ids: list[str],
    evaluate,
    args: argparse.Namespace,
    archive: list[set[str]],
) -> list[dict[str, Any]]:
    rng = random.Random(args.seed)
    rows = []
    for idx in range(args.random_trials):
        cand = _random_candidate(rng, "random", idx, factor_ids, min_factors=args.min_factors, max_factors=args.max_factors)
        row = evaluate(cand, n_trials_hint=args.random_trials)
        rows.append(row)
        if row.get("status") == "ok":
            archive.append(set(cand.factor_ids))
    return rows


def _run_optuna(
    factor_ids: list[str],
    evaluate,
    args: argparse.Namespace,
    archive: list[set[str]],
) -> list[dict[str, Any]]:
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    rows: list[dict[str, Any]] = []
    sampler = optuna.samplers.TPESampler(seed=args.seed + 11, multivariate=True, group=True)

    def objective(trial: optuna.Trial) -> float:
        k = trial.suggest_int("factor_count", args.min_factors, args.max_factors)
        selected = []
        for slot in range(args.max_factors):
            fid = trial.suggest_categorical(f"factor_{slot}", factor_ids)
            if fid not in selected:
                selected.append(fid)
            if len(selected) >= k:
                break
        while len(selected) < k:
            fid = factor_ids[trial.number % len(factor_ids)]
            if fid not in selected:
                selected.append(fid)
            else:
                break
        weights = [trial.suggest_float(f"weight_{idx}", 0.05, 1.0) for idx in range(len(selected))]
        combine = trial.suggest_categorical("combine", ["weighted_sum", "weighted_sum", "max"])
        cand = Candidate(f"optuna_tpe_{trial.number:04d}", "optuna_tpe", selected, weights, combine=combine)
        row = evaluate(cand, n_trials_hint=args.optuna_trials)
        rows.append(row)
        if row.get("status") == "ok":
            archive.append(set(cand.factor_ids))
        return _fitness_key(row)

    study = optuna.create_study(direction="maximize", sampler=sampler)
    study.optimize(objective, n_trials=args.optuna_trials, show_progress_bar=False)
    return rows


def _run_deap(
    factor_ids: list[str],
    evaluate,
    args: argparse.Namespace,
    archive: list[set[str]],
) -> list[dict[str, Any]]:
    from deap import base, creator, tools

    rng = random.Random(args.seed + 23)
    class_name = f"FitnessMaxAlphaMiner{int(time.time() * 1000)}"
    individual_name = f"IndividualAlphaMiner{int(time.time() * 1000)}"
    if not hasattr(creator, class_name):
        creator.create(class_name, base.Fitness, weights=(1.0,))
    if not hasattr(creator, individual_name):
        creator.create(individual_name, list, fitness=getattr(creator, class_name))

    genome_len = args.max_factors * 2 + 1

    def make_individual():
        genes = [rng.random() for _ in range(genome_len)]
        return getattr(creator, individual_name)(genes)

    def decode(ind, idx: int) -> Candidate:
        k = args.min_factors + int(abs(ind[-1]) * 10_000) % (args.max_factors - args.min_factors + 1)
        selected = []
        for slot in range(args.max_factors):
            raw = abs(ind[slot]) % 1.0
            fid = factor_ids[min(len(factor_ids) - 1, int(raw * len(factor_ids)))]
            if fid not in selected:
                selected.append(fid)
            if len(selected) >= k:
                break
        while len(selected) < k:
            fid = factor_ids[rng.randrange(len(factor_ids))]
            if fid not in selected:
                selected.append(fid)
        weights = [0.05 + abs(ind[args.max_factors + i]) % 1.0 for i in range(len(selected))]
        return Candidate(f"deap_gp_{idx:04d}", "deap_gp", selected, weights)

    toolbox = base.Toolbox()
    toolbox.register("individual", make_individual)
    toolbox.register("population", tools.initRepeat, list, toolbox.individual)
    toolbox.register("mate", tools.cxTwoPoint)
    toolbox.register("mutate", tools.mutGaussian, mu=0.0, sigma=0.20, indpb=0.20)
    toolbox.register("select", tools.selTournament, tournsize=3)

    rows: list[dict[str, Any]] = []
    eval_counter = 0

    def eval_individual(ind):
        nonlocal eval_counter
        cand = decode(ind, eval_counter)
        eval_counter += 1
        row = evaluate(cand, n_trials_hint=args.deap_population * args.deap_generations)
        rows.append(row)
        if row.get("status") == "ok":
            archive.append(set(cand.factor_ids))
        return (_fitness_key(row),)

    pop = toolbox.population(n=args.deap_population)
    for ind in pop:
        ind.fitness.values = eval_individual(ind)
    for _ in range(max(1, args.deap_generations - 1)):
        offspring = toolbox.select(pop, len(pop))
        offspring = list(map(toolbox.clone, offspring))
        for left, right in zip(offspring[::2], offspring[1::2]):
            if rng.random() < 0.70:
                toolbox.mate(left, right)
                del left.fitness.values
                del right.fitness.values
        for ind in offspring:
            if rng.random() < 0.35:
                toolbox.mutate(ind)
                del ind.fitness.values
        invalid = [ind for ind in offspring if not ind.fitness.valid]
        for ind in invalid:
            ind.fitness.values = eval_individual(ind)
        pop[:] = offspring
    return rows[: args.deap_population * args.deap_generations]


PYMOO_OBJECTIVES = {
    # Both lanes optimise the SELECTION sample only. The labeler lane used to minimise
    # -holdout_sharpe while claiming "holdout untouched"; the holdout is now sealed until the gate.
    "portfolio_top_k_v1": [
        "validation_excess_sharpe",
        "train_excess_sharpe",
        "turnover",
        "novelty",
        "complexity",
    ],
    "label_all_l0_v2": [
        "validation_excess_sharpe",
        "train_excess_sharpe",
        "turnover",
        "label_matrix_novelty",
        "label_entropy",
    ],
}
# A failed/no-score candidate gets the worst value on every objective. A finite 0.0 Sharpe is
# a legitimate value and must not be mapped to the worst case (the old `x or -999` did that).
_WORST_OBJECTIVE = 1e6


def _finite_or_none(value: Any) -> float | None:
    out = _safe_float(value)
    return None if out is None else float(out)


def _pymoo_objectives(row: dict[str, Any], *, is_labeler_v2: bool, max_factors: int) -> list[float]:
    """NSGA-III minimisation vector built only from selection-sample metrics."""
    if row.get("status") != "ok":
        return [_WORST_OBJECTIVE] * 5

    def maximise(value: Any) -> float:
        out = _finite_or_none(value)
        return _WORST_OBJECTIVE if out is None else -out

    def minimise(value: Any, default: float) -> float:
        out = _finite_or_none(value)
        return float(default) if out is None else out

    validation = maximise((row.get("validation_excess") or {}).get("excess_sharpe"))
    train = maximise((row.get("train_excess") or {}).get("excess_sharpe"))
    turnover = minimise(row.get("turnover"), _WORST_OBJECTIVE)
    if is_labeler_v2:
        return [
            validation,
            train,
            turnover,
            maximise(row.get("label_matrix_novelty")),
            maximise((row.get("label_matrix_metrics") or {}).get("label_entropy")),
        ]
    return [
        validation,
        train,
        turnover,
        maximise(row.get("novelty")),
        minimise(row.get("complexity"), float(max_factors)),
    ]


def _run_pymoo(
    factor_ids: list[str],
    evaluate,
    args: argparse.Namespace,
    archive: list[set[str]],
    label_archive: list[np.ndarray],
    *,
    search_contract: str,
    population: int,
    generations: int,
) -> list[dict[str, Any]]:
    from pymoo.algorithms.moo.nsga3 import NSGA3
    from pymoo.core.problem import ElementwiseProblem
    from pymoo.optimize import minimize
    from pymoo.termination import get_termination
    from pymoo.util.ref_dirs import get_reference_directions

    rows: list[dict[str, Any]] = []
    eval_counter = 0
    is_labeler_v2 = search_contract == "label_all_l0_v2"
    n_var = args.max_factors * 2 + (2 if is_labeler_v2 else 1)

    class AlphaProblem(ElementwiseProblem):
        def __init__(self):
            super().__init__(n_var=n_var, n_obj=5, xl=0.0, xu=1.0)

        def _evaluate(self, x, out, *_, **__):
            nonlocal eval_counter
            k = args.min_factors + int(float(x[-1]) * 10_000) % (args.max_factors - args.min_factors + 1)
            selected = []
            for slot in range(args.max_factors):
                fid = factor_ids[min(len(factor_ids) - 1, int(float(x[slot]) * len(factor_ids)))]
                if fid not in selected:
                    selected.append(fid)
                if len(selected) >= k:
                    break
            idx = 0
            while len(selected) < k:
                fid = factor_ids[(eval_counter + idx) % len(factor_ids)]
                if fid not in selected:
                    selected.append(fid)
                idx += 1
            weights = [0.05 + float(x[args.max_factors + i]) for i in range(len(selected))]
            if is_labeler_v2:
                min_threshold = float(getattr(args, "labeler_min_percentile", 0.55))
                max_threshold = float(getattr(args, "labeler_max_percentile", 0.85))
                threshold = min_threshold + float(x[-2]) * (max_threshold - min_threshold)
                algorithm_name = "pymoo_labeler_v2"
                candidate_id = f"pymoo_labeler_v2_{eval_counter:04d}"
            else:
                threshold = None
                algorithm_name = "pymoo_nsga3_novelty"
                candidate_id = f"pymoo_nsga3_novelty_{eval_counter:04d}"
            cand = Candidate(candidate_id, algorithm_name, selected, weights, label_threshold=threshold)
            eval_counter += 1
            row = evaluate(cand, n_trials_hint=population * generations)
            signature = row.pop("_label_signature", None)
            rows.append(row)
            if row.get("status") == "ok":
                archive.append(set(cand.factor_ids))
                if isinstance(signature, np.ndarray):
                    label_archive.append(signature)
            out["F"] = _pymoo_objectives(row, is_labeler_v2=is_labeler_v2, max_factors=args.max_factors)

    ref_dirs = get_reference_directions("das-dennis", 5, n_partitions=2)
    algorithm = NSGA3(pop_size=population, ref_dirs=ref_dirs)
    minimize(
        AlphaProblem(),
        algorithm,
        get_termination("n_gen", generations),
        seed=args.seed + (73 if is_labeler_v2 else 37),
        verbose=False,
    )
    return rows[: population * generations]


def _pbo_by_algorithm(rows: list[dict[str, Any]], n_folds: int) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    algos = sorted({str(row.get("algorithm")) for row in rows if row.get("status") == "ok"})
    for algo in algos:
        subset = [row for row in rows if row.get("algorithm") == algo and row.get("status") == "ok"]
        if not subset:
            continue
        matrix = []
        usable = []
        for row in subset:
            folds = row.get("selection_partition_returns") or []
            if len(folds) == n_folds and all(np.isfinite(float(x)) for x in folds):
                matrix.append([float(x) for x in folds])
                usable.append(row)
        if len(matrix) < 3 or n_folds < 4:
            out[algo] = {
                "candidate_count": len(subset),
                "usable_candidate_count": len(matrix),
                "pbo": None,
                "method": "cscv_purged_selection_excess_return_rank_logit",
                "reason": "insufficient_candidates_or_folds",
            }
            continue

        perf = np.asarray(matrix, dtype=float)
        split_size = n_folds // 2
        logits: list[float] = []
        for train_idx in itertools.combinations(range(n_folds), split_size):
            train_cols = np.asarray(train_idx, dtype=int)
            test_cols = np.asarray([i for i in range(n_folds) if i not in set(train_idx)], dtype=int)
            train_perf = np.nanmean(perf[:, train_cols], axis=1)
            test_perf = np.nanmean(perf[:, test_cols], axis=1)
            best = int(np.nanargmax(train_perf))
            selected_test = float(test_perf[best])
            oos_percentile = (float(np.sum(test_perf <= selected_test)) + 0.5) / (len(test_perf) + 1.0)
            oos_percentile = min(max(oos_percentile, 1e-6), 1.0 - 1e-6)
            logits.append(math.log(oos_percentile / (1.0 - oos_percentile)))
        pbo = float(np.mean([1.0 if x < 0.0 else 0.0 for x in logits])) if logits else None
        out[algo] = {
            "candidate_count": len(subset),
            "usable_candidate_count": len(usable),
            "pbo": pbo,
            "median_logit": _safe_float(np.median(logits), 0.0) if logits else None,
            "split_count": len(logits),
            "fold_count": n_folds,
            "method": "cscv_purged_selection_excess_return_rank_logit",
        }
    return out


def _summarize(rows: list[dict[str, Any]], *, pbo_folds: int) -> dict[str, Any]:
    ok = [row for row in rows if row.get("status") == "ok"]
    summary: dict[str, Any] = {}

    def median(values: list[Any]) -> float:
        clean = [float(v) for v in values if _safe_float(v) is not None]
        return _safe_float(np.median(clean), 0.0) if clean else 0.0

    for algo in sorted({str(row.get("algorithm")) for row in ok}):
        subset = [row for row in ok if row.get("algorithm") == algo]
        ranked = sorted(subset, key=lambda row: _fitness_key(row), reverse=True)
        top = ranked[: min(10, len(ranked))]
        lead = ranked[0] if ranked else {}
        summary[algo] = {
            "evaluated": len(subset),
            "status_counts": {
                status: sum(1 for row in rows if row.get("algorithm") == algo and row.get("status") == status)
                for status in sorted({str(row.get("status")) for row in rows if row.get("algorithm") == algo})
            },
            "top_fitness": _safe_float(lead.get("fitness"), 0.0) if ranked else None,
            "top_validation_excess_sharpe": _safe_float((lead.get("validation_excess") or {}).get("excess_sharpe"), 0.0) if ranked else None,
            "top_train_excess_sharpe": _safe_float((lead.get("train_excess") or {}).get("excess_sharpe"), 0.0) if ranked else None,
            "top_selection_beta": _safe_float((lead.get("selection_excess") or {}).get("beta")) if ranked else None,
            "top_selection_mdd": _safe_float((lead.get("selection") or {}).get("max_drawdown"), 0.0) if ranked else None,
            "median_top10_validation_excess_sharpe": median([(row.get("validation_excess") or {}).get("excess_sharpe") for row in top]),
            "median_top10_train_excess_sharpe": median([(row.get("train_excess") or {}).get("excess_sharpe") for row in top]),
            "median_top10_selection_beta": median([(row.get("selection_excess") or {}).get("beta") for row in top]),
            "median_top10_base_novelty": median([row.get("base_novelty", row.get("novelty", 0.0)) for row in top]),
            "median_top10_novelty": median([row.get("novelty", 0.0) for row in top]),
            "novelty_std": _safe_float(np.std([float(row.get("novelty") or 0.0) for row in subset]), 0.0),
            "median_top10_similarity_penalty": median([row.get("similarity_novelty_penalty", 0.0) for row in top]),
            "median_top10_max_similarity": median([row.get("max_similarity", 0.0) for row in top]),
            "median_top10_turnover": median([row.get("turnover", 0.0) for row in top]),
            "median_top10_dsr_probability": median([(row.get("deflated_sharpe") or {}).get("probability") for row in top]),
            "top_candidates": top,
        }
    pbo = _pbo_by_algorithm(rows, pbo_folds)
    for algo, value in pbo.items():
        summary.setdefault(algo, {})["pbo"] = value
    return summary


def _jaccard(left: set[str], right: set[str]) -> float:
    union = left | right
    if not union:
        return 0.0
    return float(len(left & right) / len(union))


def _metric(row: dict[str, Any], section: str, key: str, default: float = 0.0) -> float:
    value = (row.get(section) or {}).get(key)
    out = _safe_float(value, default)
    return float(default if out is None else out)


def _windows_overlap(a_start: Any, a_end: Any, b_start: Any, b_end: Any) -> bool:
    if not (a_start and a_end and b_start and b_end):
        return False
    return pd.Timestamp(a_start) <= pd.Timestamp(b_end) and pd.Timestamp(b_start) <= pd.Timestamp(a_end)


def _apply_multiple_testing(
    rows: list[dict[str, Any]],
    *,
    windows: dict[str, Any],
    prior_runs: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run-level DSR on the selection sample with effective trials accumulated across months.

    Effective trials = Li-Ji M_eff of this run's trial return correlation + the M_eff persisted by
    every earlier run whose selection window overlaps this one (legacy runs without a ledger are
    inferred as raw_evaluated * this run's M_eff/raw ratio and flagged). Summing across months
    ignores cross-month correlation, so it over-counts: conservative.
    """
    usable = [row for row in rows if row.get("status") == "ok" and row.get("_selection_excess_returns") is not None]
    if usable:
        matrix = np.column_stack([np.asarray(row["_selection_excess_returns"], dtype=float) for row in usable])
        current = _effective_trial_count(matrix)
    else:
        current = {"raw_trials": 0, "effective_trials": 0.0, "method": "li_ji_2005_eigenvalue"}
    ratio = (float(current["effective_trials"]) / float(current["raw_trials"])) if current["raw_trials"] else 1.0
    prior_effective = 0.0
    counted: list[dict[str, Any]] = []
    for prior in prior_runs:
        if not _windows_overlap(
            prior.get("selection_start"), prior.get("selection_end"),
            windows["selection_start"], windows["selection_end"],
        ):
            continue
        if prior.get("search_trials_effective") is not None:
            effective = float(prior["search_trials_effective"])
            basis = "persisted_ledger"
        else:
            effective = float(prior.get("search_trials_raw") or 0) * ratio
            basis = "inferred_legacy_raw_times_current_ratio"
        prior_effective += effective
        counted.append({"run_id": prior.get("run_id"), "effective_trials": round(effective, 3), "basis": basis})
    total_effective = max(1.0, float(current["effective_trials"]) + prior_effective)
    daily_sharpes = [float((row.get("sharpe_moments") or {}).get("daily_sharpe") or 0.0) for row in usable]
    cross_std = float(np.std(daily_sharpes, ddof=1)) if len(daily_sharpes) >= 2 else 0.0
    for row in usable:
        stats = _deflated_sharpe(
            row.get("sharpe_moments") or {},
            effective_trials=total_effective,
            cross_trial_sharpe_std=cross_std,
        )
        row["deflated_sharpe"] = stats
        row["fitness"] = float(row.get("fitness") or 0.0) + 0.15 * float(stats["probability"])
    for row in rows:
        row.pop("_selection_excess_returns", None)
    return {
        "schema_version": "strategy-mining-multiple-testing-ledger-v1",
        "selection_start": windows["selection_start"],
        "selection_end": windows["selection_end"],
        "holdout_start": windows.get("holdout_start"),
        "holdout_end": windows.get("holdout_end"),
        "search_trials_raw": int(current["raw_trials"]),
        "search_trials_effective": round(float(current["effective_trials"]), 3),
        "effective_trial_method": current.get("method"),
        "prior_effective_trials": round(prior_effective, 3),
        "total_effective_trials": round(total_effective, 3),
        "cross_trial_daily_sharpe_std": cross_std,
        "dsr_sample": "selection_excess_returns(train+validation)",
        "prior_runs_counted": counted,
    }


def _adaptive_strategy_families(
    rows: list[dict[str, Any]],
    *,
    meta: dict[str, FactorMeta],
    args: argparse.Namespace,
    protocol: dict[str, Any],
    similarity_pair_map: dict[tuple[str, str], float],
) -> dict[str, Any]:
    """Selection-stage gate (no holdout) + family clustering of the survivors."""
    gate = protocol["selection_gate"]
    eligible: list[dict[str, Any]] = []
    rejected: dict[str, int] = {}

    def reject(reason: str) -> None:
        rejected[reason] = rejected.get(reason, 0) + 1

    for row in rows:
        if row.get("status") != "ok":
            reject("not_ok")
            continue
        validation_excess = _safe_float((row.get("validation_excess") or {}).get("excess_sharpe"))
        train_excess = _safe_float((row.get("train_excess") or {}).get("excess_sharpe"))
        selection_mdd = _metric(row, "selection", "max_drawdown")
        turnover = float(row.get("turnover") or 0.0)
        dsr_probability = _safe_float((row.get("deflated_sharpe") or {}).get("probability"))
        one_sided = (row.get("selection_excess") or {}).get("one_sided_regimes") or []
        if validation_excess is None or validation_excess < float(gate["min_validation_excess_sharpe"]):
            reject("validation_excess_sharpe_below_floor")
            continue
        if train_excess is None or train_excess < float(gate["min_train_excess_sharpe"]):
            reject("train_excess_sharpe_below_floor")
            continue
        if selection_mdd < -abs(float(gate["max_selection_drawdown"])):
            reject("selection_drawdown_too_deep")
            continue
        if turnover > float(gate["max_turnover"]):
            reject("turnover_too_high")
            continue
        if one_sided:
            reject("regime_one_sided_excess")
            continue
        if dsr_probability is None or dsr_probability < float(gate["min_deflated_sharpe_probability"]):
            reject("deflated_sharpe_probability_below_floor")
            continue
        eligible.append(row)

    ranked = sorted(eligible, key=lambda r: _fitness_key(r), reverse=True)
    families: list[dict[str, Any]] = []
    for row in ranked:
        factors = set(str(fid) for fid in (row.get("factor_ids") or []))
        categories = {meta[fid].category for fid in factors if fid in meta}
        assigned = False
        for family in families:
            representative = set(family["representative"]["factor_ids"] or [])
            factor_overlap = _jaccard(factors, set(family["factor_union"]))
            category_overlap = _jaccard(categories, set(family["category_union"]))
            factor_similarity = _candidate_similarity(factors, representative, pair_map=similarity_pair_map)
            if (
                factor_overlap >= args.promote_family_factor_jaccard
                or category_overlap >= args.promote_family_category_jaccard
                or factor_similarity >= HIGH_DUPLICATE_SIMILARITY_FLOOR
            ):
                family["member_count"] += 1
                family["factor_union"] = sorted(set(family["factor_union"]) | factors)
                family["category_union"] = sorted(set(family["category_union"]) | categories)
                family["max_member_similarity"] = max(float(family.get("max_member_similarity") or 0.0), factor_similarity)
                family["members"].append(row["candidate_id"])
                assigned = True
                break
        if assigned:
            continue
        families.append(
            {
                "family_id": f"adaptive_strategy_family_{len(families) + 1:02d}",
                "member_count": 1,
                "factor_union": sorted(factors),
                "category_union": sorted(categories),
                "max_member_similarity": 0.0,
                "representative": {
                    "candidate_id": row.get("candidate_id"),
                    "algorithm": row.get("algorithm"),
                    "factor_ids": row.get("factor_ids"),
                    "weights": row.get("weights"),
                    "fitness": _safe_float(row.get("fitness")),
                    "novelty": _safe_float(row.get("novelty")),
                    "max_similarity": _safe_float(row.get("max_similarity")),
                    "turnover": _safe_float(row.get("turnover")),
                    "deflated_sharpe_probability": _safe_float((row.get("deflated_sharpe") or {}).get("probability")),
                    "validation_excess": row.get("validation_excess"),
                    "train_excess": row.get("train_excess"),
                    "selection": row.get("selection"),
                },
                "members": [row.get("candidate_id")],
            }
        )

    return {
        "schema_version": "adaptive-alpha-strategy-families-v2",
        "decision_effect": "research_only",
        "promotion_gate": {
            **gate,
            "stage": "selection_sample_only_holdout_sealed",
            "family_factor_jaccard": args.promote_family_factor_jaccard,
            "family_category_jaccard": args.promote_family_category_jaccard,
            "family_similarity_floor": HIGH_DUPLICATE_SIMILARITY_FLOOR,
        },
        "evaluated_count": len(rows),
        "eligible_count": len(eligible),
        "family_count": len(families),
        "rejected_counts": rejected,
        "families": families,
    }


def _row_candidate(row: dict[str, Any]) -> Candidate:
    return Candidate(
        candidate_id=str(row["candidate_id"]),
        algorithm=str(row["algorithm"]),
        factor_ids=list(row["factor_ids"]),
        weights=list(row["weights"]),
        combine=str(row.get("combine") or "weighted_sum"),
        label_threshold=_safe_float(row.get("label_threshold_percentile")),
        directions=_parse_float_list(row.get("factor_directions")),
    )


def _gate_finalists(rows: list[dict[str, Any]], families: dict[str, Any], cap: int) -> list[dict[str, Any]]:
    """Family representatives that passed the selection gate, best fitness first, capped."""
    by_id = {str(row.get("candidate_id")): row for row in rows}
    reps = [by_id[str(f["representative"]["candidate_id"])] for f in families.get("families") or []
            if str(f["representative"]["candidate_id"]) in by_id]
    reps.sort(key=lambda row: _fitness_key(row), reverse=True)
    return reps[: max(0, int(cap))]


def _seal_holdout_evaluation(
    finalists: list[dict[str, Any]],
    ctx: MiningContext,
    *,
    withhold_reasons: list[str] | None = None,
) -> dict[str, Any]:
    """Evaluate the sealed holdout exactly once per run, for the gate finalists only.

    When the run is already blocked before the holdout (contaminated triage, not enough fresh
    sessions, prior ledger unavailable) the holdout is NOT opened: looking would add hypotheses
    to every later run's Holm family without any chance of promotion.
    """
    if getattr(ctx, "_holdout_seal", None) is not None:
        raise RuntimeError("strategy_mining_holdout_already_evaluated_for_this_run")
    windows, protocol, args = ctx.windows, ctx.protocol, ctx.args
    seal: dict[str, Any] = {
        "schema_version": "strategy-mining-holdout-seal-v1",
        "holdout_start": windows.get("holdout_start"),
        "holdout_end": windows.get("holdout_end"),
        "holdout_sessions": int(windows.get("holdout_sessions") or 0),
        "holdout_gate_ready": bool(windows.get("holdout_gate_ready")),
        "finalists": [str(row["candidate_id"]) for row in finalists],
        "evaluation_count": 1,
        "evaluated_at": pd.Timestamp.now("UTC").isoformat(),
    }
    ctx._holdout_seal = seal  # type: ignore[attr-defined]
    if withhold_reasons:
        seal["status"] = "withheld_blocked"
        seal["withhold_reasons"] = list(withhold_reasons)
        seal["family_size"] = 0
        seal["evaluation_count"] = 0
        return seal
    if not windows.get("holdout_start") or not finalists:
        seal["status"] = "no_fresh_holdout" if not windows.get("holdout_start") else "no_finalists"
        seal["family_size"] = 0
        return seal
    hold_gate = protocol["holdout_gate"]
    digest = hashlib.sha256()
    for row in finalists:
        candidate = _row_candidate(row)
        score = _candidate_score(candidate, ctx.values, ctx.meta,
                                 min_weight_coverage=float(protocol["min_factor_weight_coverage"]))
        if score is None:
            row["holdout_status"] = "effective_factor_count_dropped"
            continue
        raw_position = _candidate_position(candidate, score, ctx, args.end_date)
        position = _rebalance_position(raw_position, args.resample)
        returns = _candidate_returns(position, ctx, args.end_date)
        holdout = returns.loc[windows["holdout_start"]: windows["holdout_end"]].replace([np.inf, -np.inf], np.nan).dropna()
        excess = (holdout - ctx.benchmark.reindex(holdout.index)).dropna()
        row["holdout_status"] = "evaluated"
        row["holdout"] = _slice_metrics(holdout)
        row["holdout_excess"] = _benchmark_relative_metrics(
            holdout,
            ctx.benchmark,
            ctx.market_regimes,
            regime_min_observations=int(hold_gate["regime_min_observations"]),
            regime_min_excess_return_annualized=float(hold_gate["regime_min_excess_return_annualized"]),
        )
        row["holdout_daily_returns"] = [round(float(value), 10) for value in excess.tolist()]
        row["holdout_return_basis"] = "excess_vs_tradable_universe_equal_weight"
        row["holdout_dates"] = [str(pd.Timestamp(value).date()) for value in excess.index]
        row["holdout_regimes"] = [str(value) for value in ctx.market_regimes.reindex(excess.index).fillna("unknown").tolist()]
        row["holdout_partition_returns"] = _purged_partition_returns(
            excess, args.pbo_folds, embargo_sessions=args.pbo_embargo_sessions,
        )
        row["pbo_purge_attestation"] = _purged_partition_attestation(
            excess.index, args.pbo_folds, embargo_sessions=args.pbo_embargo_sessions,
        )
        digest.update(json.dumps([row["candidate_id"], row["holdout_dates"], row["holdout_daily_returns"]]).encode("utf-8"))
    seal["family_size"] = sum(1 for row in finalists if row.get("holdout_status") == "evaluated")
    seal["status"] = "evaluated"
    seal["seal_checksum"] = digest.hexdigest()
    return seal


def _finlab_confirm_verdict(confirm: dict[str, Any] | None, protocol: dict[str, Any]) -> dict[str, Any]:
    gate = protocol["holdout_gate"]
    if not confirm:
        return {"status": "failed", "reasons": ["finlab_confirm_missing"]}
    reasons: list[str] = []
    if confirm.get("status") != "ok":
        reasons.append(f"finlab_confirm_status_{confirm.get('status')}")
    sharpe = _safe_float(confirm.get("monthly_sharpe"))
    if sharpe is None or sharpe < float(gate["finlab_confirm_min_monthly_sharpe"]):
        reasons.append("finlab_confirm_monthly_sharpe_below_floor")
    if gate.get("finlab_confirm_require_positive_alpha"):
        alpha = _safe_float(confirm.get("benchmark_alpha"))
        if alpha is None or alpha <= 0.0:
            reasons.append("finlab_confirm_benchmark_alpha_not_positive")
    return {"status": "failed" if reasons else "pass", "reasons": reasons,
            "monthly_sharpe": sharpe, "benchmark_alpha": _safe_float(confirm.get("benchmark_alpha"))}


def _finlab_confirm(finalists: list[dict[str, Any]], ctx: MiningContext) -> list[dict[str, Any]]:
    """FinLab sim of the gate finalists (an actual gate input, not a side report)."""
    args = ctx.args
    ab = _load_module(AB_RUNNER, "stockvision_ab_factor_runner_confirm")
    sim_args = argparse.Namespace(
        resample=args.resample,
        trade_at_price=args.trade_at_price,
        position_limit=args.position_limit,
    )
    confirm_rows: list[dict[str, Any]] = []
    for row in finalists:
        candidate = _row_candidate(row)
        score = _candidate_score(candidate, ctx.values, ctx.meta,
                                 min_weight_coverage=float(ctx.protocol["min_factor_weight_coverage"]))
        if score is None:
            continue
        # Out-of-sample confirmation only: the selection sample was optimised on, so a full-period
        # FinLab sim would pass almost anything that survived the selection gate.
        position = _candidate_position(candidate, score, ctx, args.end_date).loc[
            ctx.windows["holdout_start"]: ctx.windows["holdout_end"]
        ]
        confirm = ab._run_sim(
            row_id=f"alpha_miner_{candidate.candidate_id}",
            kind="alpha_miner_confirm",
            meta={
                "algorithm": candidate.algorithm,
                "factor_ids": candidate.factor_ids,
                "weights": candidate.weights,
                "factor_directions": row.get("factor_directions"),
                "combine": candidate.combine,
                "window": "holdout",
            },
            position=position,
            args=sim_args,
        )
        confirm_rows.append(confirm)
    by_id = {
        str(row.get("id") or "")[len("alpha_miner_"):]: row
        for row in confirm_rows
        if isinstance(row, dict)
    }
    for row in finalists:
        row["finlab_confirm_gate"] = _finlab_confirm_verdict(by_id.get(str(row["candidate_id"])), ctx.protocol)
    return confirm_rows


def _build_mining_context(
    args: argparse.Namespace,
    *,
    extend_universe=None,
) -> tuple[MiningContext, dict[str, Any], list[str]]:
    """Universe, windows, train-window directions and benchmark for one run.

    extend_universe(close, tradable, values, meta) may add research factors (mutating values/meta)
    BEFORE windows are resolved, so added factors go through the same constant-feature exclusion and
    train-window direction fit as registry factors. Its return value is recorded in universe_info.
    """
    protocol = _resolve_research_protocol(args)
    args.research_protocol = protocol
    if getattr(args, "seed", None) in (None, ""):
        args.seed = _seed_from_date(str(args.end_date))
        args.seed_source = f"sha256(run end_date={args.end_date})"
    else:
        args.seed = int(args.seed)
        args.seed_source = getattr(args, "seed_source", None) or "explicit"
    if args.factor_universe == "unified_registry_v1":
        close, tradable, values, meta, universe_info = _build_unified_registry_factor_universe(args)
    elif args.factor_universe == "canonical114":
        close, tradable, values, meta, universe_info = _build_canonical114_factor_universe(args)
    else:
        close, tradable, values, meta, universe_info = _build_factor_universe(args)
    if extend_universe is not None:
        universe_info["universe_extension"] = extend_universe(close, tradable, values, meta)
    windows = _resolve_walk_forward_windows(args, close.index, protocol)
    universe_info["walk_forward_windows"] = windows
    universe_info["feature_triage"] = _feature_triage_check(protocol, windows)
    universe_info["cross_sectional_constant_features"] = _exclude_cross_sectionally_constant(
        values,
        meta,
        tradable,
        start=windows["train_start"],
        end=windows["train_end"],
        min_varying_ratio=float(protocol["cross_sectional_min_varying_date_ratio"]),
    )
    universe_info["direction_fit"] = _derive_train_window_directions(
        values,
        meta,
        close,
        tradable,
        train_start=windows["train_start"],
        train_end=windows["train_end"],
        horizon=int(protocol["direction_ic_horizon_sessions"]),
    )
    benchmark = _benchmark_returns(close, tradable, execution_lag=int(protocol["execution_lag_sessions"]))
    selection_index = close.loc[windows["selection_start"]: windows["selection_end"]].index
    selection_attestation = _purged_partition_attestation(
        selection_index,
        args.pbo_folds,
        embargo_sessions=args.pbo_embargo_sessions,
        sample="selection",
    )
    similarity_contract = _load_similarity_contract(
        Path(getattr(args, "similarity_contract", "") or FORMAL137_SIMILARITY_CONTRACT_PATH)
    )
    similarity_pair_map = _load_similarity_pair_map(
        Path(getattr(args, "similarity_pairs", "") or FORMAL137_PAIRWISE_SIMILARITY_PATH)
    )
    universe_info["similarity_novelty"] = {
        "decision_effect": "research_candidate_scoring_only",
        "method": "knn_candidate_formal137_pairwise_abs_rank_corr_v2_matrix_only_fail_closed",
        "pairwise_path": str(Path(getattr(args, "similarity_pairs", "") or FORMAL137_PAIRWISE_SIMILARITY_PATH)),
        "pair_count": len(similarity_pair_map),
        "high_duplicate_floor": HIGH_DUPLICATE_SIMILARITY_FLOOR,
        "related_cluster_floor": RELATED_CLUSTER_SIMILARITY_FLOOR,
    }
    ctx = MiningContext(
        values=values,
        meta=meta,
        close=close,
        tradable=tradable,
        args=args,
        protocol=protocol,
        windows=windows,
        benchmark=benchmark,
        market_regimes=_pit_market_regimes(close),
        selection_attestation=selection_attestation,
        archive=[],
        label_archive=[],
        similarity_pair_map=similarity_pair_map,
        similarity_feature_meta=_similarity_feature_meta(similarity_contract),
    )
    return ctx, universe_info, sorted(values.keys())


def run(args: argparse.Namespace) -> dict[str, Any]:
    t0 = time.time()
    _progress("building factor universe")
    ctx, universe_info, factor_ids = _build_mining_context(args)
    windows = ctx.windows
    _progress(
        f"factor universe ready: {len(factor_ids)} factors; selection {windows['selection_start']}..{windows['selection_end']}; "
        f"holdout {windows.get('holdout_start')}..{windows.get('holdout_end')} sealed"
    )

    def evaluate(cand: Candidate, *, n_trials_hint: int | None = None) -> dict[str, Any]:
        del n_trials_hint  # trial counting is run-level (effective trials), not per lane
        return _evaluate_candidate(cand, ctx)

    archive, label_archive = ctx.archive, ctx.label_archive
    rows: list[dict[str, Any]] = []
    enabled = str(getattr(args, "algorithm", "all") or "all").strip().lower()
    run_all = enabled == "all"
    if (run_all or enabled == "random") and args.random_trials > 0:
        _progress(f"running random baseline: {args.random_trials} trials")
        rows.extend(_run_random(factor_ids, evaluate, args, archive))
    if (run_all or enabled == "optuna") and args.optuna_trials > 0:
        _progress(f"running Optuna TPE: {args.optuna_trials} trials")
        rows.extend(_run_optuna(factor_ids, evaluate, args, archive))
    if (run_all or enabled == "deap") and args.deap_population > 0 and args.deap_generations > 0:
        _progress(f"running DEAP evolution: population={args.deap_population}, generations={args.deap_generations}")
        rows.extend(_run_deap(factor_ids, evaluate, args, archive))
    if (run_all or enabled == "pymoo") and args.pymoo_population > 0 and args.pymoo_generations > 0:
        search_mode = str(getattr(args, "pymoo_search_mode", "top_k_v1") or "top_k_v1")
        if search_mode in {"top_k_v1", "parallel_shadow"}:
            _progress(f"running pymoo V1 top-k: population={args.pymoo_population}, generations={args.pymoo_generations}")
            rows.extend(_run_pymoo(
                factor_ids, evaluate, args, archive, label_archive,
                search_contract="portfolio_top_k_v1",
                population=args.pymoo_population,
                generations=args.pymoo_generations,
            ))
        if search_mode in {"labeler_v2", "parallel_shadow"}:
            _progress(
                "running pymoo V2 full-L0 labeler: "
                f"population={args.pymoo_labeler_population}, generations={args.pymoo_labeler_generations}"
            )
            rows.extend(_run_pymoo(
                factor_ids, evaluate, args, archive, label_archive,
                search_contract="label_all_l0_v2",
                population=args.pymoo_labeler_population,
                generations=args.pymoo_labeler_generations,
            ))

    return _finalize_mining(rows, ctx, universe_info, factor_ids, t0=t0)


def _finalize_mining(
    rows: list[dict[str, Any]],
    ctx: MiningContext,
    universe_info: dict[str, Any],
    factor_ids: list[str],
    *,
    t0: float,
) -> dict[str, Any]:
    """Multiple testing, families, gate finalists, sealed holdout and FinLab confirm for a run.

    Shared by every search front-end (this miner, alpha223 recursive search) so none of them can
    rank on the holdout or skip the trial-count / Holm bookkeeping.
    """
    args, meta, protocol, windows = ctx.args, ctx.meta, ctx.protocol, ctx.windows
    multiple_testing = _apply_multiple_testing(
        rows,
        windows=windows,
        prior_runs=list(getattr(args, "prior_multiple_testing_runs", None) or []),
    )
    _progress(f"summarizing {len(rows)} candidates")
    summary = _summarize(rows, pbo_folds=args.pbo_folds)
    adaptive_families = _adaptive_strategy_families(
        rows,
        meta=meta,
        args=args,
        protocol=protocol,
        similarity_pair_map=ctx.similarity_pair_map,
    )
    finalists = _gate_finalists(rows, adaptive_families, args.finlab_confirm_top_n)
    blocking_gates: list[str] = []
    if universe_info["feature_triage"]["overlaps_validation_or_holdout"]:
        blocking_gates.append("feature_triage_window_overlaps_evaluation")
    if not windows.get("holdout_gate_ready"):
        blocking_gates.append("holdout_insufficient_fresh_sessions")
    blocking_gates.extend(str(item) for item in getattr(args, "pre_holdout_blocking_gates", None) or [])
    _progress(f"sealed holdout for {len(finalists)} gate finalists (withheld: {blocking_gates or 'no'})")
    holdout_seal = _seal_holdout_evaluation(finalists, ctx, withhold_reasons=blocking_gates)
    finlab_confirm: list[dict[str, Any]] = []
    if finalists and args.finlab_confirm_top_n > 0 and holdout_seal.get("status") == "evaluated":
        _progress(f"running FinLab confirmation for {len(finalists)} finalists")
        finlab_confirm = _finlab_confirm(finalists, ctx)
    multiple_testing["holdout_family_size"] = int(holdout_seal.get("family_size") or 0)
    prior_holdout_family = 0
    for prior in getattr(args, "prior_multiple_testing_runs", None) or []:
        if _windows_overlap(prior.get("holdout_start"), prior.get("holdout_end"),
                            windows.get("holdout_start"), windows.get("holdout_end")):
            prior_holdout_family += int(prior.get("holdout_family_size") or 0)
    multiple_testing["prior_holdout_family_size"] = prior_holdout_family
    multiple_testing["cumulative_holdout_family_size"] = prior_holdout_family + multiple_testing["holdout_family_size"]

    return {
        "schema_version": "stockvision-alpha-miner-bakeoff-v3",
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "runtime_seconds": round(time.time() - t0, 3),
        "config": {key: value for key, value in vars(args).items() if key != "prior_multiple_testing_runs"},
        "research_protocol": protocol,
        "walk_forward_windows": windows,
        "selection_purge_attestation": ctx.selection_attestation,
        "multiple_testing": multiple_testing,
        "holdout_seal": holdout_seal,
        "blocking_gates": blocking_gates,
        "factor_universe": {
            **universe_info,
            "factor_ids": factor_ids,
            "factor_meta": {fid: meta[fid].__dict__ for fid in factor_ids},
        },
        "summary": summary,
        "adaptive_strategy_families": adaptive_families,
        "gate_finalists": [str(row["candidate_id"]) for row in finalists],
        "rows": rows,
        "finlab_confirm": finlab_confirm,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Research-only alpha miner with monthly pymoo NSGA-III defaults.")
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--factor-universe", choices=["strategy95", "canonical114", "unified_registry_v1"], default="unified_registry_v1")
    parser.add_argument("--feature-registry", default=str(UNIFIED_FEATURE_REGISTRY_PATH))
    parser.add_argument("--monthly-mining-config", default=str(MONTHLY_MINING_CONFIG_PATH))
    parser.add_argument("--similarity-contract", default=str(FORMAL137_SIMILARITY_CONTRACT_PATH))
    parser.add_argument("--similarity-pairs", default=str(FORMAL137_PAIRWISE_SIMILARITY_PATH))
    parser.add_argument("--disable-monthly-mining-config", action="store_true")
    parser.add_argument("--algorithm", choices=["all", "random", "optuna", "deap", "pymoo"], default="pymoo")
    parser.add_argument("--start-date", default="2021-01-01", help="data load start; must cover train window")
    parser.add_argument("--end-date", required=True, help="last session of the run (as-of date)")
    # Rolling windows come from research_protocol; these only apply with --window-mode fixed.
    parser.add_argument("--window-mode", choices=["rolling", "fixed"], default="rolling")
    parser.add_argument("--train-start", default=None)
    parser.add_argument("--train-end", default=None)
    parser.add_argument("--validation-start", default=None)
    parser.add_argument("--validation-end", default=None)
    parser.add_argument("--holdout-start", default=None)
    parser.add_argument("--holdout-end", default=None)
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--pymoo-search-mode", choices=["top_k_v1", "labeler_v2", "parallel_shadow"], default="top_k_v1")
    parser.add_argument("--pymoo-labeler-population", type=int, default=32)
    parser.add_argument("--pymoo-labeler-generations", type=int, default=4)
    parser.add_argument("--labeler-min-percentile", type=float, default=0.55)
    parser.add_argument("--labeler-max-percentile", type=float, default=0.85)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--min-factors", type=int, default=2)
    parser.add_argument("--max-factors", type=int, default=8)
    parser.add_argument("--seed", type=int, default=None, help="default: derived from --end-date")
    parser.add_argument("--random-trials", type=int, default=0)
    parser.add_argument("--optuna-trials", type=int, default=0)
    parser.add_argument("--deap-population", type=int, default=0)
    parser.add_argument("--deap-generations", type=int, default=0)
    parser.add_argument("--pymoo-population", type=int, default=48)
    parser.add_argument("--pymoo-generations", type=int, default=6)
    parser.add_argument("--finlab-confirm-top-n", type=int, default=8)
    parser.add_argument("--pbo-folds", type=int, default=8)
    parser.add_argument("--pbo-embargo-sessions", type=int, default=5)
    parser.add_argument("--promote-family-factor-jaccard", type=float, default=0.50)
    parser.add_argument("--promote-family-category-jaccard", type=float, default=0.67)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_alpha_miner_bakeoff"))
    parser.add_argument("--prior-ledger-json", default="", help="JSON list of prior runs' multiple_testing ledgers")
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    args = _apply_monthly_mining_config(args)
    if args.window_mode == "fixed":
        args.research_protocol_override = {"window_mode": "fixed"}
    if args.prior_ledger_json:
        args.prior_multiple_testing_runs = json.loads(Path(args.prior_ledger_json).read_text(encoding="utf-8"))

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = run(args)
    stem = f"alpha_miner_bakeoff_{args.factor_universe}_{args.algorithm}_{args.universe}_{args.start_date}_{args.end_date}_seed{args.seed}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    rows_path = output_dir / f"{stem}_rows.csv"
    confirm_path = output_dir / f"{stem}_finlab_confirm.csv"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["rows"]).to_csv(rows_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["finlab_confirm"]).to_csv(confirm_path, index=False, encoding="utf-8-sig")
    summary_payload = {
        "json": str(json_path),
        "rows_csv": str(rows_path),
        "finlab_confirm_csv": str(confirm_path),
        "summary": report["summary"],
        "adaptive_strategy_families": report["adaptive_strategy_families"],
        "multiple_testing": report["multiple_testing"],
        "holdout_seal": report["holdout_seal"],
        "blocking_gates": report["blocking_gates"],
        "walk_forward_windows": report["walk_forward_windows"],
        "factor_universe": {
            key: value for key, value in report["factor_universe"].items()
            if key not in {"factor_meta", "ab_mapping"}
        },
        "runtime_seconds": report["runtime_seconds"],
    }
    summary_path.write_text(json.dumps(summary_payload, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(summary_payload, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
