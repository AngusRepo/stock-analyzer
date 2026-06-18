from __future__ import annotations

import argparse
import csv
import gc
import importlib.util
import itertools
import json
import math
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
ML106_BEST_PATH = ROOT / "output" / "finlab_ml_feature_backtests" / "ml106_features_sii_20230101_20260615_top10_bothdir_best.csv"
UNIFIED_FEATURE_REGISTRY_PATH = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
MONTHLY_MINING_CONFIG_PATH = ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"
FORMAL137_SIMILARITY_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"
FORMAL137_PAIRWISE_SIMILARITY_PATH = FEATURE_TRIAGE_DIR / "formal137_pairwise_similarity_long_20260617.csv"

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
    "finlab_confirm_top_n": 8,
    "pbo_folds": 8,
    "promote_min_validation_sharpe": 1.0,
    "promote_min_holdout_sharpe": 1.0,
    "promote_min_full_cagr": 0.0,
    "promote_max_full_drawdown": 0.35,
    "promote_max_turnover": 0.95,
    "promote_min_deflated_sharpe_probability": 0.95,
    "promote_family_factor_jaccard": 0.50,
    "promote_family_category_jaccard": 0.67,
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


@dataclass
class Candidate:
    candidate_id: str
    algorithm: str
    factor_ids: list[str]
    weights: list[float]
    combine: str = "weighted_sum"
    transform: str = "rank_pct"


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


def _rebalance_position(position: pd.DataFrame, resample: str) -> pd.DataFrame:
    mode = str(resample or "").strip()
    if not mode or mode.upper() in {"D", "1D", "DAILY"}:
        return position
    if mode.upper() == "M":
        mode = "ME"
    signal = position.resample(mode).last()
    aligned = signal.reindex(position.index).ffill().infer_objects(copy=False)
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
    weights = position.astype(float)
    row_sums = weights.sum(axis=1).replace(0, np.nan)
    weights = weights.div(row_sums, axis=0).fillna(0.0)
    turnover = weights.diff().abs().sum(axis=1) / 2.0
    return float(turnover.replace([np.inf, -np.inf], np.nan).dropna().mean() or 0.0)


def _portfolio_returns(
    position: pd.DataFrame,
    close: pd.DataFrame,
    *,
    fee_tax_cost: float,
) -> pd.Series:
    daily_ret = close.pct_change(fill_method=None).reindex(index=position.index, columns=position.columns)
    weights = position.astype(float)
    row_sums = weights.sum(axis=1).replace(0, np.nan)
    weights = weights.div(row_sums, axis=0).fillna(0.0)
    held = weights.shift(1).fillna(0.0)
    gross = (held * daily_ret.fillna(0.0)).sum(axis=1)
    turnover = weights.diff().abs().sum(axis=1).fillna(weights.abs().sum(axis=1)) / 2.0
    return gross - turnover * fee_tax_cost


def _slice_metrics(returns: pd.Series) -> dict[str, float]:
    return {
        "cagr": _cagr(returns),
        "sharpe": _annualized_sharpe(returns),
        "max_drawdown": _max_drawdown(returns),
        "positive_day_ratio": float((returns > 0).mean()) if len(returns) else 0.0,
    }


def _fold_sharpes(returns: pd.Series, n_folds: int) -> list[float]:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    if clean.empty or n_folds <= 1:
        return []
    chunks = np.array_split(np.arange(len(clean)), n_folds)
    return [_annualized_sharpe(clean.iloc[chunk]) for chunk in chunks if len(chunk)]


def _deflated_sharpe_proxy(sharpe: float, n_trials: int, n_obs: int) -> float:
    if n_obs <= 1:
        return float(sharpe)
    haircut = math.sqrt(2.0 * math.log(max(2, n_trials)) / max(2, n_obs))
    return float(sharpe - haircut)


def _deflated_sharpe_stats(returns: pd.Series, n_trials: int) -> dict[str, float]:
    clean = returns.replace([np.inf, -np.inf], np.nan).dropna()
    n_obs = len(clean)
    if n_obs <= 3:
        return {
            "probability": 0.0,
            "z_score": 0.0,
            "minimum_annualized_sharpe": 0.0,
            "daily_sharpe": 0.0,
            "skew": 0.0,
            "kurtosis": 3.0,
        }
    std = float(clean.std(ddof=0))
    if std <= 1e-12:
        return {
            "probability": 0.0,
            "z_score": 0.0,
            "minimum_annualized_sharpe": 0.0,
            "daily_sharpe": 0.0,
            "skew": 0.0,
            "kurtosis": 3.0,
        }

    from scipy.stats import norm

    daily_sharpe = float(clean.mean() / std)
    skew = _safe_float(clean.skew(), 0.0) or 0.0
    kurtosis = (_safe_float(clean.kurt(), 0.0) or 0.0) + 3.0
    n = max(2, int(n_trials))
    gamma = 0.5772156649015329
    trial_threshold = (
        (1.0 - gamma) * norm.ppf(1.0 - 1.0 / n)
        + gamma * norm.ppf(1.0 - 1.0 / (n * math.e))
    )
    variance_term = 1.0 - skew * daily_sharpe + ((kurtosis - 1.0) / 4.0) * daily_sharpe * daily_sharpe
    sigma_sr = math.sqrt(max(variance_term, 1e-12) / max(1, n_obs - 1))
    minimum_daily_sharpe = float(trial_threshold * sigma_sr)
    z_score = float((daily_sharpe - minimum_daily_sharpe) / max(sigma_sr, 1e-12))
    return {
        "probability": float(norm.cdf(z_score)),
        "z_score": z_score,
        "minimum_annualized_sharpe": minimum_daily_sharpe * math.sqrt(252.0),
        "daily_sharpe": daily_sharpe,
        "skew": skew,
        "kurtosis": kurtosis,
    }


def _novelty(factors: list[str], archive: list[set[str]]) -> float:
    current = set(factors)
    if not current or not archive:
        return 1.0
    distances = []
    for other in archive[-200:]:
        union = current | other
        if not union:
            continue
        distances.append(1.0 - len(current & other) / len(union))
    if not distances:
        return 1.0
    distances.sort(reverse=True)
    return float(np.mean(distances[: min(10, len(distances))]))


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
    base_novelty: float,
    pair_map: dict[tuple[str, str], float],
    feature_meta: dict[str, dict[str, Any]],
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
    archive_recent = set().union(*archive[-200:]) if archive else set()
    max_archive = _max_pair_similarity(
        current,
        archive_recent,
        pair_map=pair_map,
        feature_meta=feature_meta,
    )
    missing_archive = _missing_similarity_pair_count(
        current,
        archive_recent,
        pair_map=pair_map,
    )
    max_similarity = max(max_internal, max_archive)
    penalty = 0.0
    bonus = 0.0
    if max_similarity >= HIGH_DUPLICATE_SIMILARITY_FLOOR:
        penalty = min(0.45, 0.25 + (max_similarity - HIGH_DUPLICATE_SIMILARITY_FLOOR))
    elif max_similarity >= RELATED_CLUSTER_SIMILARITY_FLOOR:
        penalty = min(0.15, (max_similarity - RELATED_CLUSTER_SIMILARITY_FLOOR) * 0.25)
    else:
        bonus = min(0.10, (RELATED_CLUSTER_SIMILARITY_FLOOR - max_similarity) * 0.15)

    adjusted = min(1.0, max(0.0, float(base_novelty) + bonus - penalty))
    return {
        "base_novelty": float(base_novelty),
        "novelty": adjusted,
        "similarity_novelty_penalty": penalty,
        "similarity_novelty_bonus": bonus,
        "max_internal_similarity": max_internal,
        "max_archive_similarity": max_archive,
        "max_similarity": max_similarity,
        "similarity_matrix_missing_internal_pairs": missing_internal,
        "similarity_matrix_missing_archive_pairs": missing_archive,
        "similarity_novelty_method": "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
    }


def _load_strategy_leaf_refs() -> list[str]:
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
    tradable = close.notna() & pd.DataFrame(
        np.repeat(np.asarray(date_mask)[:, None], len(columns), axis=1),
        index=close.index,
        columns=columns,
    )
    info = {
        "alphabuilderstw_input_count": len(ab_factors),
        "l1_non_alpha_leaf_count": len(l1_refs),
        "mapped_factor_count": len(factor_values),
        "missing": sorted(set(missing)),
        "semantic_duplicates": semantic_duplicates,
        "ab_mapping": mapping,
    }
    return close, tradable, factor_values, meta, info


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
    tradable = close.notna()

    ml_values, ml_feature_names = overlap._build_ml_feature_pool(
        base=base,
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )
    ml_direction = _load_direction_map(ML106_BEST_PATH, id_key="feature_id", direction_key="direction_mode")

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
    strategy_direction = {
        str(row.get("strategy_factor") or "").strip(): _direction_from_mode(row.get("strategy_best_direction"), 1.0)
        for row in triage_rows
        if str(row.get("strategy_factor") or "").strip()
    }

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
            direction=float(strategy_direction.get(fid, raw_meta.get("direction") or 1.0)),
        )

    info = {
        "factor_universe_mode": "canonical114",
        "ml106_input_count": int(len(ml_feature_names)),
        "strategy_selected_input_count": int(len(selected_strategy_factors)),
        "mapped_factor_count": int(len(factor_values)),
        "missing": sorted(set(missing)),
        "strategy_selected_factors": sorted(selected_strategy_factors),
        "direction_source": {
            "ml106": str(ML106_BEST_PATH),
            "strategy_selected": str(STRATEGY95_VS_ML106_PATH),
        },
        "strategy_info": strategy_info,
        "note": "canonical114 = ML106 FEATURE_COLS + selected low-overlap strategy factors. Research-only alpha mining universe.",
    }
    return close, tradable, factor_values, meta, info


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
        strategy_values[fid] = _runtime_float_frame(frame * direction, index, columns)
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
    tradable = close.notna()
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
    ml_direction = _load_direction_map(ML106_BEST_PATH, id_key="feature_id", direction_key="direction_mode")

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
            direction = float(ml_direction.get(fid, 1.0))
            category = str(row.get("category") or _feature_group(fid))
            source_label = "ml106"
        elif source == "strategy95":
            frame = strategy_values.pop(fid, None)
            raw_meta = strategy_meta.pop(fid, {})
            direction = float((row.get("triage") or {}).get("strategy_direction") or raw_meta.get("direction") or 1.0)
            category = str(row.get("category") or raw_meta.get("category") or "strategy95")
            source_label = str(row.get("source_system") or raw_meta.get("source") or "strategy95")
        else:
            unavailable_candidates.append(fid)
            continue
        if frame is None:
            missing.append(f"{source}:{fid}")
            continue
        factor_values[fid] = _runtime_float_frame(frame, close.index, columns)
        meta[fid] = FactorMeta(id=fid, source=source_label, category=category, direction=direction)
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
        "strategy_info": strategy_info,
        "note": "unified_registry_v1 supersedes canonical114. L1, ML, PLE, L1.25 and alpha mining share one registry; consumers may apply transforms but may not maintain independent feature universes.",
    }
    return close, tradable, factor_values, meta, info


def _candidate_score(candidate: Candidate, values: dict[str, pd.DataFrame], meta: dict[str, FactorMeta]) -> pd.DataFrame | None:
    frames = []
    weights = _normalize_weights(candidate.weights)
    for fid, weight in zip(candidate.factor_ids, weights):
        frame = values.get(fid)
        if frame is None:
            continue
        direction = meta[fid].direction
        transformed = _rank_pct(frame * direction)
        frames.append(transformed * weight)
    if not frames:
        return None
    if candidate.combine == "max":
        return pd.concat(frames, axis=0).groupby(level=0).max()
    if candidate.combine == "min":
        return pd.concat(frames, axis=0).groupby(level=0).min()
    return sum(frames)


def _evaluate_candidate(
    candidate: Candidate,
    *,
    values: dict[str, pd.DataFrame],
    meta: dict[str, FactorMeta],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    args: argparse.Namespace,
    archive: list[set[str]],
    n_trials_hint: int,
    similarity_pair_map: dict[tuple[str, str], float],
    similarity_feature_meta: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    score = _candidate_score(candidate, values, meta)
    if score is None:
        return {
            "candidate_id": candidate.candidate_id,
            "algorithm": candidate.algorithm,
            "status": "no_score",
            "fitness": -999.0,
        }
    raw_position = _position_from_score(score.loc[: args.end_date], args.top_k, tradable).loc[args.start_date: args.end_date]
    position = _rebalance_position(raw_position, args.resample)
    returns = _portfolio_returns(position, close, fee_tax_cost=args.fee_tax_cost)
    train = returns.loc[args.train_start: args.train_end]
    validation = returns.loc[args.validation_start: args.validation_end]
    holdout = returns.loc[args.holdout_start: args.holdout_end]
    full = returns.loc[args.start_date: args.end_date]
    train_metrics = _slice_metrics(train)
    validation_metrics = _slice_metrics(validation)
    holdout_metrics = _slice_metrics(holdout)
    full_metrics = _slice_metrics(full)
    novelty_evidence = _similarity_adjusted_novelty(
        candidate.factor_ids,
        archive,
        base_novelty=_novelty(candidate.factor_ids, archive),
        pair_map=similarity_pair_map,
        feature_meta=similarity_feature_meta,
    )
    novelty = float(novelty_evidence["novelty"])
    turnover = _mean_turnover(position)
    complexity = len(candidate.factor_ids)
    deflated = _deflated_sharpe_proxy(validation_metrics["sharpe"], n_trials_hint, max(1, len(validation)))
    deflated_stats = _deflated_sharpe_stats(validation, n_trials_hint)
    fold_sharpes = _fold_sharpes(full, args.pbo_folds)
    fitness = (
        validation_metrics["sharpe"] * 0.40
        + holdout_metrics["sharpe"] * 0.30
        + novelty * 0.20
        + deflated * 0.05
        + float(deflated_stats["probability"]) * 0.15
        - max(0.0, abs(full_metrics["max_drawdown"]) - 0.35) * 2.0
        - turnover * 0.15
        - complexity * 0.015
    )
    return {
        "candidate_id": candidate.candidate_id,
        "algorithm": candidate.algorithm,
        "status": "ok",
        "factor_ids": candidate.factor_ids,
        "weights": [round(w, 6) for w in _normalize_weights(candidate.weights)],
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
        "turnover": turnover,
        "fitness": fitness,
        "deflated_sharpe_proxy": deflated,
        "deflated_sharpe": deflated_stats,
        "fold_sharpes": fold_sharpes,
        "train": train_metrics,
        "validation": validation_metrics,
        "holdout": holdout_metrics,
        "full": full_metrics,
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
        return float(row.get("fitness") or -999.0)

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
        return (float(row.get("fitness") or -999.0),)

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


def _run_pymoo(
    factor_ids: list[str],
    evaluate,
    args: argparse.Namespace,
    archive: list[set[str]],
) -> list[dict[str, Any]]:
    from pymoo.algorithms.moo.nsga3 import NSGA3
    from pymoo.core.problem import ElementwiseProblem
    from pymoo.optimize import minimize
    from pymoo.termination import get_termination
    from pymoo.util.ref_dirs import get_reference_directions

    rows: list[dict[str, Any]] = []
    eval_counter = 0
    n_var = args.max_factors * 2 + 1

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
            cand = Candidate(f"pymoo_nsga3_novelty_{eval_counter:04d}", "pymoo_nsga3_novelty", selected, weights)
            eval_counter += 1
            row = evaluate(cand, n_trials_hint=args.pymoo_population * args.pymoo_generations)
            rows.append(row)
            if row.get("status") == "ok":
                archive.append(set(cand.factor_ids))
            validation = row.get("validation") or {}
            holdout = row.get("holdout") or {}
            out["F"] = [
                -float(validation.get("sharpe") or -999.0),
                abs(float(validation.get("max_drawdown") or 0.0)),
                float(row.get("turnover") or 0.0),
                -float(row.get("novelty") or 0.0),
                float(row.get("complexity") or args.max_factors),
            ]

    ref_dirs = get_reference_directions("das-dennis", 5, n_partitions=2)
    algorithm = NSGA3(pop_size=args.pymoo_population, ref_dirs=ref_dirs)
    minimize(
        AlphaProblem(),
        algorithm,
        get_termination("n_gen", args.pymoo_generations),
        seed=args.seed + 37,
        verbose=False,
    )
    return rows[: args.pymoo_population * args.pymoo_generations]


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
            folds = row.get("fold_sharpes") or []
            if len(folds) == n_folds and all(np.isfinite(float(x)) for x in folds):
                matrix.append([float(x) for x in folds])
                usable.append(row)
        if len(matrix) < 3 or n_folds < 4:
            out[algo] = {
                "candidate_count": len(subset),
                "usable_candidate_count": len(matrix),
                "pbo": None,
                "method": "cscv_fold_sharpe_rank_logit",
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
            "method": "cscv_fold_sharpe_rank_logit",
        }
    return out


def _summarize(rows: list[dict[str, Any]], *, pbo_folds: int) -> dict[str, Any]:
    ok = [row for row in rows if row.get("status") == "ok"]
    summary: dict[str, Any] = {}
    for algo in sorted({str(row.get("algorithm")) for row in ok}):
        subset = [row for row in ok if row.get("algorithm") == algo]
        ranked = sorted(subset, key=lambda row: float(row.get("fitness") or -999.0), reverse=True)
        top = ranked[: min(10, len(ranked))]
        summary[algo] = {
            "evaluated": len(subset),
            "top_fitness": _safe_float(ranked[0].get("fitness"), 0.0) if ranked else None,
            "top_validation_sharpe": _safe_float((ranked[0].get("validation") or {}).get("sharpe"), 0.0) if ranked else None,
            "top_holdout_sharpe": _safe_float((ranked[0].get("holdout") or {}).get("sharpe"), 0.0) if ranked else None,
            "top_full_cagr": _safe_float((ranked[0].get("full") or {}).get("cagr"), 0.0) if ranked else None,
            "top_full_mdd": _safe_float((ranked[0].get("full") or {}).get("max_drawdown"), 0.0) if ranked else None,
            "median_top10_validation_sharpe": _safe_float(np.median([(row.get("validation") or {}).get("sharpe", 0.0) for row in top]), 0.0),
            "median_top10_holdout_sharpe": _safe_float(np.median([(row.get("holdout") or {}).get("sharpe", 0.0) for row in top]), 0.0),
            "median_top10_base_novelty": _safe_float(np.median([row.get("base_novelty", row.get("novelty", 0.0)) for row in top]), 0.0),
            "median_top10_novelty": _safe_float(np.median([row.get("novelty", 0.0) for row in top]), 0.0),
            "median_top10_similarity_penalty": _safe_float(np.median([row.get("similarity_novelty_penalty", 0.0) for row in top]), 0.0),
            "median_top10_max_similarity": _safe_float(np.median([row.get("max_similarity", 0.0) for row in top]), 0.0),
            "median_top10_turnover": _safe_float(np.median([row.get("turnover", 0.0) for row in top]), 0.0),
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


def _adaptive_strategy_families(
    rows: list[dict[str, Any]],
    *,
    meta: dict[str, FactorMeta],
    args: argparse.Namespace,
    similarity_pair_map: dict[tuple[str, str], float],
    similarity_feature_meta: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    eligible: list[dict[str, Any]] = []
    rejected: dict[str, int] = {}

    def reject(reason: str) -> None:
        rejected[reason] = rejected.get(reason, 0) + 1

    for row in rows:
        if row.get("status") != "ok":
            reject("not_ok")
            continue
        validation_sharpe = _metric(row, "validation", "sharpe")
        holdout_sharpe = _metric(row, "holdout", "sharpe")
        full_cagr = _metric(row, "full", "cagr")
        full_mdd = _metric(row, "full", "max_drawdown")
        turnover = float(row.get("turnover") or 0.0)
        dsr_probability = float(((row.get("deflated_sharpe") or {}).get("probability") or 0.0))
        if validation_sharpe < args.promote_min_validation_sharpe:
            reject("validation_sharpe_below_floor")
            continue
        if holdout_sharpe < args.promote_min_holdout_sharpe:
            reject("holdout_sharpe_below_floor")
            continue
        if full_cagr < args.promote_min_full_cagr:
            reject("full_cagr_below_floor")
            continue
        if full_mdd < -abs(args.promote_max_full_drawdown):
            reject("full_drawdown_too_deep")
            continue
        if turnover > args.promote_max_turnover:
            reject("turnover_too_high")
            continue
        if dsr_probability < args.promote_min_deflated_sharpe_probability:
            reject("deflated_sharpe_probability_below_floor")
            continue
        eligible.append(row)

    ranked = sorted(eligible, key=lambda r: float(r.get("fitness") or -999.0), reverse=True)
    families: list[dict[str, Any]] = []
    for row in ranked:
        factors = set(str(fid) for fid in (row.get("factor_ids") or []))
        categories = {meta[fid].category for fid in factors if fid in meta}
        assigned = False
        for family in families:
            family_factors = set(family["factor_union"])
            factor_overlap = _jaccard(factors, family_factors)
            category_overlap = _jaccard(categories, set(family["category_union"]))
            factor_similarity = _max_pair_similarity(
                factors,
                family_factors,
                pair_map=similarity_pair_map,
                feature_meta=similarity_feature_meta,
            )
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
        family_id = f"adaptive_strategy_family_{len(families) + 1:02d}"
        families.append(
            {
                "family_id": family_id,
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
                    "base_novelty": _safe_float(row.get("base_novelty")),
                    "novelty": _safe_float(row.get("novelty")),
                    "similarity_novelty_penalty": _safe_float(row.get("similarity_novelty_penalty")),
                    "max_similarity": _safe_float(row.get("max_similarity")),
                    "turnover": _safe_float(row.get("turnover")),
                    "deflated_sharpe_probability": _safe_float((row.get("deflated_sharpe") or {}).get("probability")),
                    "validation": row.get("validation"),
                    "holdout": row.get("holdout"),
                    "full": row.get("full"),
                },
                "members": [row.get("candidate_id")],
            }
        )

    return {
        "schema_version": "adaptive-alpha-strategy-families-v1",
        "decision_effect": "research_only",
        "promotion_gate": {
            "min_validation_sharpe": args.promote_min_validation_sharpe,
            "min_holdout_sharpe": args.promote_min_holdout_sharpe,
            "min_full_cagr": args.promote_min_full_cagr,
            "max_full_drawdown": args.promote_max_full_drawdown,
            "max_turnover": args.promote_max_turnover,
            "min_deflated_sharpe_probability": args.promote_min_deflated_sharpe_probability,
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


def _finlab_confirm(
    rows: list[dict[str, Any]],
    *,
    values: dict[str, pd.DataFrame],
    meta: dict[str, FactorMeta],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    ab = _load_module(AB_RUNNER, "stockvision_ab_factor_runner_confirm")
    confirm_rows: list[dict[str, Any]] = []
    selected: list[dict[str, Any]] = []
    for algo in sorted({str(row.get("algorithm")) for row in rows if row.get("status") == "ok"}):
        ranked = sorted(
            [row for row in rows if row.get("algorithm") == algo and row.get("status") == "ok"],
            key=lambda row: float(row.get("fitness") or -999.0),
            reverse=True,
        )
        selected.extend(ranked[: args.finlab_confirm_top_n])

    sim_args = argparse.Namespace(
        resample=args.resample,
        trade_at_price=args.trade_at_price,
        position_limit=args.position_limit,
    )
    for row in selected:
        cand = Candidate(
            candidate_id=str(row["candidate_id"]),
            algorithm=str(row["algorithm"]),
            factor_ids=list(row["factor_ids"]),
            weights=list(row["weights"]),
            combine=str(row.get("combine") or "weighted_sum"),
        )
        score = _candidate_score(cand, values, meta)
        if score is None:
            continue
        position = _position_from_score(score.loc[: args.end_date], args.top_k, tradable).loc[args.start_date: args.end_date]
        confirm = ab._run_sim(
            row_id=f"alpha_miner_{cand.candidate_id}",
            kind="alpha_miner_confirm",
            meta={
                "algorithm": cand.algorithm,
                "factor_ids": cand.factor_ids,
                "weights": cand.weights,
                "combine": cand.combine,
            },
            position=position,
            args=sim_args,
        )
        confirm_rows.append(confirm)
    return confirm_rows


def run(args: argparse.Namespace) -> dict[str, Any]:
    t0 = time.time()
    _progress("building factor universe")
    if args.factor_universe == "unified_registry_v1":
        close, tradable, values, meta, universe_info = _build_unified_registry_factor_universe(args)
    elif args.factor_universe == "canonical114":
        close, tradable, values, meta, universe_info = _build_canonical114_factor_universe(args)
    else:
        close, tradable, values, meta, universe_info = _build_factor_universe(args)
    factor_ids = sorted(values.keys())
    _progress(f"factor universe ready: {len(factor_ids)} factors")
    similarity_contract = _load_similarity_contract(
        Path(getattr(args, "similarity_contract", "") or FORMAL137_SIMILARITY_CONTRACT_PATH)
    )
    similarity_pair_map = _load_similarity_pair_map(
        Path(getattr(args, "similarity_pairs", "") or FORMAL137_PAIRWISE_SIMILARITY_PATH)
    )
    similarity_feature_meta = _similarity_feature_meta(similarity_contract)
    universe_info["similarity_novelty"] = {
        "decision_effect": "research_candidate_scoring_only",
        "method": "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
        "pairwise_path": str(Path(getattr(args, "similarity_pairs", "") or FORMAL137_PAIRWISE_SIMILARITY_PATH)),
        "pair_count": len(similarity_pair_map),
        "feature_meta_count": len(similarity_feature_meta),
        "high_duplicate_floor": HIGH_DUPLICATE_SIMILARITY_FLOOR,
        "related_cluster_floor": RELATED_CLUSTER_SIMILARITY_FLOOR,
    }
    archive: list[set[str]] = []

    def evaluate(cand: Candidate, *, n_trials_hint: int) -> dict[str, Any]:
        return _evaluate_candidate(
            cand,
            values=values,
            meta=meta,
            close=close,
            tradable=tradable,
            args=args,
            archive=archive,
            n_trials_hint=n_trials_hint,
            similarity_pair_map=similarity_pair_map,
            similarity_feature_meta=similarity_feature_meta,
        )

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
        _progress(f"running pymoo NSGA-III + novelty: population={args.pymoo_population}, generations={args.pymoo_generations}")
        rows.extend(_run_pymoo(factor_ids, evaluate, args, archive))

    _progress(f"summarizing {len(rows)} candidates")
    summary = _summarize(rows, pbo_folds=args.pbo_folds)
    adaptive_families = _adaptive_strategy_families(
        rows,
        meta=meta,
        args=args,
        similarity_pair_map=similarity_pair_map,
        similarity_feature_meta=similarity_feature_meta,
    )
    finlab_confirm = []
    if args.finlab_confirm_top_n > 0:
        _progress(f"running FinLab confirmation: top_n={args.finlab_confirm_top_n} per algorithm")
        finlab_confirm = _finlab_confirm(
            rows,
            values=values,
            meta=meta,
            close=close,
            tradable=tradable,
            args=args,
        )

    return {
        "schema_version": "stockvision-alpha-miner-bakeoff-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "runtime_seconds": round(time.time() - t0, 3),
        "config": vars(args),
        "factor_universe": {
            **universe_info,
            "factor_ids": factor_ids,
            "factor_meta": {fid: meta[fid].__dict__ for fid in factor_ids},
        },
        "summary": summary,
        "adaptive_strategy_families": adaptive_families,
        "rows": rows,
        "finlab_confirm": finlab_confirm,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only alpha miner with monthly pymoo NSGA-III defaults.")
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--factor-universe", choices=["strategy95", "canonical114", "unified_registry_v1"], default="unified_registry_v1")
    parser.add_argument("--feature-registry", default=str(UNIFIED_FEATURE_REGISTRY_PATH))
    parser.add_argument("--monthly-mining-config", default=str(MONTHLY_MINING_CONFIG_PATH))
    parser.add_argument("--similarity-contract", default=str(FORMAL137_SIMILARITY_CONTRACT_PATH))
    parser.add_argument("--similarity-pairs", default=str(FORMAL137_PAIRWISE_SIMILARITY_PATH))
    parser.add_argument("--disable-monthly-mining-config", action="store_true")
    parser.add_argument("--algorithm", choices=["all", "random", "optuna", "deap", "pymoo"], default="pymoo")
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--train-start", default="2023-01-01")
    parser.add_argument("--train-end", default="2024-12-31")
    parser.add_argument("--validation-start", default="2025-01-01")
    parser.add_argument("--validation-end", default="2025-12-31")
    parser.add_argument("--holdout-start", default="2026-01-01")
    parser.add_argument("--holdout-end", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--min-factors", type=int, default=2)
    parser.add_argument("--max-factors", type=int, default=8)
    parser.add_argument("--fee-tax-cost", type=float, default=0.004425)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--random-trials", type=int, default=0)
    parser.add_argument("--optuna-trials", type=int, default=0)
    parser.add_argument("--deap-population", type=int, default=0)
    parser.add_argument("--deap-generations", type=int, default=0)
    parser.add_argument("--pymoo-population", type=int, default=48)
    parser.add_argument("--pymoo-generations", type=int, default=6)
    parser.add_argument("--finlab-confirm-top-n", type=int, default=8)
    parser.add_argument("--pbo-folds", type=int, default=8)
    parser.add_argument("--promote-min-validation-sharpe", type=float, default=1.0)
    parser.add_argument("--promote-min-holdout-sharpe", type=float, default=1.0)
    parser.add_argument("--promote-min-full-cagr", type=float, default=0.0)
    parser.add_argument("--promote-max-full-drawdown", type=float, default=0.35)
    parser.add_argument("--promote-max-turnover", type=float, default=0.95)
    parser.add_argument("--promote-min-deflated-sharpe-probability", type=float, default=0.95)
    parser.add_argument("--promote-family-factor-jaccard", type=float, default=0.50)
    parser.add_argument("--promote-family-category-jaccard", type=float, default=0.67)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "finlab_alpha_miner_bakeoff"))
    args = parser.parse_args()
    args = _apply_monthly_mining_config(args)

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
