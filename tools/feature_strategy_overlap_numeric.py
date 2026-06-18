from __future__ import annotations

import argparse
import contextlib
import importlib.util
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
ML_SERVICE = ROOT / "ml-service"
AB_RUNNER = ROOT / "tools" / "finlab_alphabuilders_factor_backtest.py"
ALPHA_MINER = ROOT / "tools" / "finlab_alpha_miner_bakeoff.py"
SPEC_RUNNER = ROOT / "tools" / "finlab_strategy_spec_backtest.py"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _read_json(path: Path) -> Any:
    text = path.read_text(encoding="utf-8-sig")
    return json.loads(text)


def _common_index(frame: pd.DataFrame, start: str, end: str) -> pd.DatetimeIndex:
    idx = pd.to_datetime(frame.index)
    mask = (idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))
    return pd.DatetimeIndex(idx[mask])


def _to_float_frame(frame: pd.DataFrame, index: pd.DatetimeIndex, columns: list[str]) -> pd.DataFrame:
    out = frame.reindex(index=index, columns=columns)
    return out.replace([np.inf, -np.inf], np.nan).astype(float)


def _align_frame(raw: Any, index: pd.Index, columns: list[str], *, ffill: bool) -> pd.DataFrame:
    frame = pd.DataFrame(raw).copy()
    frame.index = pd.to_datetime(frame.index)
    frame.columns = [str(c).strip() for c in frame.columns]
    out = frame.reindex(index=pd.to_datetime(index), columns=columns)
    if ffill:
        out = out.ffill()
    return out.replace([np.inf, -np.inf], np.nan).astype(float)


def _safe_finlab_frame(key: str, index: pd.Index, columns: list[str], *, ffill: bool = False) -> pd.DataFrame:
    from finlab import data

    try:
        return _align_frame(data.get(key), index, columns, ffill=ffill)
    except Exception as exc:
        print(f"[overlap] warning: finlab dataset failed {key}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return pd.DataFrame(np.nan, index=pd.to_datetime(index), columns=columns)


def _rank_panel(frame: pd.DataFrame) -> pd.DataFrame:
    ranked = frame.replace([np.inf, -np.inf], np.nan).rank(axis=1, pct=True)
    return ranked.astype("float32")


def _flatten(frame: pd.DataFrame) -> np.ndarray:
    return frame.to_numpy(dtype=np.float32, copy=False).reshape(-1)


def _corr(a: np.ndarray, b: np.ndarray, min_obs: int) -> tuple[float | None, int]:
    mask = np.isfinite(a) & np.isfinite(b)
    n = int(mask.sum())
    if n < min_obs:
        return None, n
    av = a[mask].astype(np.float64, copy=False)
    bv = b[mask].astype(np.float64, copy=False)
    av = av - float(av.mean())
    bv = bv - float(bv.mean())
    denom = float(np.sqrt(np.dot(av, av) * np.dot(bv, bv)))
    if denom <= 1e-12:
        return None, n
    return float(np.dot(av, bv) / denom), n


def _daily_ic(feature_rank: pd.DataFrame, target_rank: pd.DataFrame, min_symbols: int) -> dict[str, Any]:
    feature_arr = feature_rank.to_numpy(dtype=np.float32, copy=False)
    target_arr = target_rank.to_numpy(dtype=np.float32, copy=False)
    ics: list[float] = []
    for i in range(feature_arr.shape[0]):
        corr, _ = _corr(feature_arr[i], target_arr[i], min_symbols)
        if corr is not None:
            ics.append(corr)
    if not ics:
        return {"n": 0, "mean_ic": None, "median_ic": None, "ic_ir": None}
    arr = np.asarray(ics, dtype=float)
    std = float(arr.std(ddof=0))
    return {
        "n": int(len(arr)),
        "mean_ic": float(arr.mean()),
        "median_ic": float(np.median(arr)),
        "ic_ir": float(arr.mean() / std) if std > 1e-12 else None,
    }


def _coverage(frame: pd.DataFrame) -> float:
    arr = frame.to_numpy(dtype=float, copy=False)
    return float(np.isfinite(arr).mean())


def _build_strategy_factor_pool(
    *,
    base: dict[str, pd.DataFrame],
    factor_json: Path,
    start_date: str,
    end_date: str,
    columns: list[str],
) -> tuple[dict[str, pd.DataFrame], dict[str, dict[str, Any]], dict[str, Any]]:
    ab = _load_module(AB_RUNNER, "stockvision_overlap_ab_runner")
    alpha = _load_module(ALPHA_MINER, "stockvision_overlap_alpha_miner")
    spec_runner = _load_module(SPEC_RUNNER, "stockvision_overlap_strategy_spec_runner")

    ab_factor_defs = _read_json(factor_json)
    ab_values, ab_mapping = ab._build_factor_values(base)

    close = base["close"].loc[:end_date].reindex(columns=columns)
    high = base["high"].loc[:end_date].reindex(index=close.index, columns=columns)
    low = base["low"].loc[:end_date].reindex(index=close.index, columns=columns)
    volume = base["volume"].loc[:end_date].reindex(index=close.index, columns=columns)

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

    index = _common_index(close, start_date, end_date)
    factor_values: dict[str, pd.DataFrame] = {}
    meta: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    semantic_duplicates: dict[str, str] = {}

    for factor in ab_factor_defs:
        fid = str(factor.get("id") or "")
        frame = ab_values.get(fid)
        if frame is None:
            missing.append(fid)
            continue
        direction = float(factor.get("direction") or 1.0)
        factor_values[fid] = _to_float_frame(frame * direction, index, columns)
        meta[fid] = {
            "id": fid,
            "source": "alphabuilderstw",
            "category": str(factor.get("category") or "unknown"),
            "direction": direction,
        }

    l1_refs = alpha._load_strategy_leaf_refs()
    for leaf in l1_refs:
        if leaf in alpha.L1_SEMANTIC_DUPLICATE_ALIASES:
            semantic_duplicates[leaf] = alpha.L1_SEMANTIC_DUPLICATE_ALIASES[leaf]
            continue
        frame = l1_features.get(leaf)
        if frame is None:
            missing.append(f"l1:{leaf}")
            continue
        fid = f"l1_{leaf}"
        direction = float(alpha.L1_SIGNAL_DIRECTIONS.get(leaf, 1.0))
        factor_values[fid] = _to_float_frame(frame * direction, index, columns)
        meta[fid] = {
            "id": fid,
            "source": "stockvision_l1",
            "category": "l1_signal",
            "direction": direction,
        }

    info = {
        "alphabuilderstw_input_count": len(ab_factor_defs),
        "l1_leaf_refs": len(l1_refs),
        "l1_semantic_duplicates": semantic_duplicates,
        "missing": sorted(set(missing)),
        "ab_mapping": ab_mapping,
    }
    return factor_values, meta, info


def _build_ml_feature_pool(
    *,
    base: dict[str, pd.DataFrame],
    start_date: str,
    end_date: str,
    columns: list[str],
) -> tuple[dict[str, pd.DataFrame], list[str]]:
    sys.path.insert(0, str(ML_SERVICE))
    from app.features import FEATURE_COLS, build_feature_matrix  # type: ignore

    close = base["close"].loc[:end_date].reindex(columns=columns)
    high = base["high"].loc[:end_date].reindex(index=close.index, columns=columns)
    low = base["low"].loc[:end_date].reindex(index=close.index, columns=columns)
    open_ = base["open"].loc[:end_date].reindex(index=close.index, columns=columns)
    volume = base["volume"].loc[:end_date].reindex(index=close.index, columns=columns)
    index = _common_index(close, start_date, end_date)
    source_index = close.index

    cache_mode = os.environ.get("STOCKVISION_CHIP_FEATURE_SOURCE", "finlab_first").strip().lower()
    cache = None
    if cache_mode in {"cache_only", "cache_first"}:
        spec_runner = _load_module(SPEC_RUNNER, "stockvision_overlap_ml_chip_cache_runner")
        cache = spec_runner._load_chip_cache_panel(close, columns)

    if cache is not None and cache_mode == "cache_only":
        foreign_net = cache["foreign"]
        trust_net = cache["trust"]
        dealer_net = cache["dealer"]
        margin_balance = cache["margin"]
        short_balance = cache["short"]
    else:
        foreign_net = _safe_finlab_frame(
            "institutional_investors_trading_summary:外陸資買賣超股數(不含外資自營商)",
            source_index,
            columns,
        )
        trust_net = _safe_finlab_frame(
            "institutional_investors_trading_summary:投信買賣超股數",
            source_index,
            columns,
        )
        dealer_self = _safe_finlab_frame(
            "institutional_investors_trading_summary:自營商買賣超股數(自行買賣)",
            source_index,
            columns,
        )
        dealer_hedge = _safe_finlab_frame(
            "institutional_investors_trading_summary:自營商買賣超股數(避險)",
            source_index,
            columns,
        )
        dealer_net = dealer_self.fillna(0.0) + dealer_hedge.fillna(0.0)
        margin_balance = _safe_finlab_frame("margin_transactions:融資今日餘額", source_index, columns, ffill=True)
        short_balance = _safe_finlab_frame("margin_transactions:融券今日餘額", source_index, columns, ffill=True)
        if cache is not None and cache_mode == "cache_first":
            foreign_net = cache["foreign"].combine_first(foreign_net)
            trust_net = cache["trust"].combine_first(trust_net)
            dealer_net = cache["dealer"].combine_first(dealer_net)
            margin_balance = cache["margin"].combine_first(margin_balance)
            short_balance = cache["short"].combine_first(short_balance)

    rows_by_feature: dict[str, list[pd.Series]] = {name: [] for name in FEATURE_COLS}
    out_index: pd.DatetimeIndex | None = None

    for n, symbol in enumerate(columns, start=1):
        price_df = pd.DataFrame(
            {
                "date": close.index,
                "open": open_[symbol].to_numpy(),
                "high": high[symbol].to_numpy(),
                "low": low[symbol].to_numpy(),
                "close": close[symbol].to_numpy(),
                "adj_close": close[symbol].to_numpy(),
                "volume": volume[symbol].to_numpy(),
            }
        )
        price_df = price_df.dropna(subset=["date", "close"])
        if price_df.empty:
            continue
        chip_df = pd.DataFrame(
            {
                "date": source_index,
                "foreign_net": foreign_net[symbol].to_numpy(),
                "trust_net": trust_net[symbol].to_numpy(),
                "dealer_net": dealer_net[symbol].to_numpy(),
                "margin_balance": margin_balance[symbol].to_numpy(),
                "short_balance": short_balance[symbol].to_numpy(),
            }
        )
        chip_df = chip_df.dropna(subset=["date"])
        with open(os.devnull, "w", encoding="utf-8") as devnull, contextlib.redirect_stdout(devnull):
            feature_df = build_feature_matrix(
                prices=price_df.to_dict("records"),
                indicators=[],
                chips=chip_df.to_dict("records"),
                sentiment_scores=[],
                market_env={},
                stock_meta=None,
            ).to_pandas()
        feature_df["date"] = pd.to_datetime(feature_df["date"])
        feature_df = feature_df.set_index("date").reindex(index=index)
        if out_index is None:
            out_index = index
        for feature in FEATURE_COLS:
            series = pd.to_numeric(feature_df.get(feature), errors="coerce")
            series.name = symbol
            rows_by_feature[feature].append(series)
        if n % 100 == 0:
            print(f"[overlap] built ML features for {n}/{len(columns)} symbols", file=sys.stderr, flush=True)

    feature_values: dict[str, pd.DataFrame] = {}
    for feature, series_list in rows_by_feature.items():
        if not series_list:
            continue
        frame = pd.concat(series_list, axis=1)
        frame = frame.reindex(index=index, columns=columns)
        feature_values[feature] = frame.replace([np.inf, -np.inf], np.nan).astype(float)
    return feature_values, list(FEATURE_COLS)


def _summarize_features(
    values: dict[str, pd.DataFrame],
    *,
    target_rank: pd.DataFrame,
    min_symbols_ic: int,
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for name, frame in values.items():
        rank = _rank_panel(frame)
        flat = _flatten(rank)
        finite = flat[np.isfinite(flat)]
        std = float(np.std(finite)) if finite.size else 0.0
        ic = _daily_ic(rank, target_rank, min_symbols_ic)
        out[name] = {
            "coverage": _coverage(frame),
            "rank_std": std,
            **ic,
        }
    return out


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    ab = _load_module(AB_RUNNER, "stockvision_overlap_ab_base")
    print(f"[overlap] loading FinLab base data universe={args.universe}", file=sys.stderr, flush=True)
    base = ab._build_base_data(args.universe)
    close = base["close"].loc[:args.end_date]
    columns = close.columns.tolist()
    if args.max_symbols > 0:
        columns = columns[: args.max_symbols]
    index = _common_index(close, args.start_date, args.end_date)
    close = close.reindex(index=index, columns=columns).astype(float)
    fwd_return = close.shift(-args.forward_days) / close - 1.0
    target_rank = _rank_panel(fwd_return)

    print(f"[overlap] building strategy factor pool", file=sys.stderr, flush=True)
    strategy_values, strategy_meta, strategy_info = _build_strategy_factor_pool(
        base=base,
        factor_json=Path(args.factor_json),
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )
    print(f"[overlap] strategy factors={len(strategy_values)}", file=sys.stderr, flush=True)

    print(f"[overlap] building ML FEATURE_COLS pool", file=sys.stderr, flush=True)
    ml_values, ml_feature_names = _build_ml_feature_pool(
        base=base,
        start_date=args.start_date,
        end_date=args.end_date,
        columns=columns,
    )
    print(f"[overlap] ML features={len(ml_values)}", file=sys.stderr, flush=True)

    ml_summary = _summarize_features(
        ml_values,
        target_rank=target_rank,
        min_symbols_ic=args.min_symbols_ic,
    )
    strategy_summary = _summarize_features(
        strategy_values,
        target_rank=target_rank,
        min_symbols_ic=args.min_symbols_ic,
    )

    ml_ranks = {name: _rank_panel(frame) for name, frame in ml_values.items()}
    strategy_ranks = {name: _rank_panel(frame) for name, frame in strategy_values.items()}
    ml_flat = {name: _flatten(frame) for name, frame in ml_ranks.items()}

    nearest_rows: list[dict[str, Any]] = []
    pair_rows: list[dict[str, Any]] = []
    for strategy_name, strategy_rank in strategy_ranks.items():
        s_flat = _flatten(strategy_rank)
        best: dict[str, Any] | None = None
        for ml_name, m_flat in ml_flat.items():
            corr, nobs = _corr(s_flat, m_flat, args.min_pair_obs)
            if corr is None:
                continue
            abs_corr = abs(corr)
            row = {
                "strategy_factor": strategy_name,
                "strategy_source": strategy_meta.get(strategy_name, {}).get("source"),
                "strategy_category": strategy_meta.get(strategy_name, {}).get("category"),
                "ml_feature": ml_name,
                "rank_corr": corr,
                "abs_rank_corr": abs_corr,
                "n_obs": nobs,
                "strategy_mean_ic": strategy_summary[strategy_name]["mean_ic"],
                "ml_mean_ic": ml_summary[ml_name]["mean_ic"],
            }
            if best is None or abs_corr > best["abs_rank_corr"]:
                best = row
            if abs_corr >= args.pair_output_threshold:
                pair_rows.append(row)
        if best is not None:
            nearest_rows.append(best)

    nearest_rows.sort(key=lambda r: r["abs_rank_corr"], reverse=True)
    pair_rows.sort(key=lambda r: r["abs_rank_corr"], reverse=True)

    thresholds = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]
    nearest_abs = np.asarray([row["abs_rank_corr"] for row in nearest_rows], dtype=float)
    overlap_counts = {
        f"strategy_factors_nearest_abs_corr_ge_{str(t).replace('.', '_')}": int((nearest_abs >= t).sum())
        for t in thresholds
    }

    high_overlap = [row for row in nearest_rows if row["abs_rank_corr"] >= args.high_overlap_threshold]
    medium_overlap = [row for row in nearest_rows if args.medium_overlap_threshold <= row["abs_rank_corr"] < args.high_overlap_threshold]
    low_overlap = [row for row in nearest_rows if row["abs_rank_corr"] < args.medium_overlap_threshold]

    def top_ic(summary: dict[str, dict[str, Any]], n: int = 15) -> list[dict[str, Any]]:
        rows = []
        for name, row in summary.items():
            mean_ic = row.get("mean_ic")
            if mean_ic is None:
                continue
            rows.append({
                "name": name,
                "mean_ic": mean_ic,
                "median_ic": row.get("median_ic"),
                "ic_ir": row.get("ic_ir"),
                "coverage": row.get("coverage"),
            })
        rows.sort(key=lambda r: abs(float(r["mean_ic"])), reverse=True)
        return rows[:n]

    result = {
        "schema_version": "stockvision-feature-strategy-overlap-numeric-v1",
        "parameters": {
            "universe": args.universe,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "forward_days": args.forward_days,
            "max_symbols": args.max_symbols,
            "min_pair_obs": args.min_pair_obs,
            "min_symbols_ic": args.min_symbols_ic,
            "high_overlap_threshold": args.high_overlap_threshold,
            "medium_overlap_threshold": args.medium_overlap_threshold,
            "pair_output_threshold": args.pair_output_threshold,
        },
        "counts": {
            "dates": int(len(index)),
            "symbols": int(len(columns)),
            "panel_cells": int(len(index) * len(columns)),
            "ml_features": int(len(ml_values)),
            "strategy_factors": int(len(strategy_values)),
            "strategy_high_overlap_ge_threshold": int(len(high_overlap)),
            "strategy_medium_overlap": int(len(medium_overlap)),
            "strategy_low_overlap_lt_medium": int(len(low_overlap)),
            **overlap_counts,
        },
        "strategy_info": strategy_info,
        "nearest_summary": {
            "mean_nearest_abs_corr": _safe_float(nearest_abs.mean()) if nearest_abs.size else None,
            "median_nearest_abs_corr": _safe_float(np.median(nearest_abs)) if nearest_abs.size else None,
            "p75_nearest_abs_corr": _safe_float(np.quantile(nearest_abs, 0.75)) if nearest_abs.size else None,
            "p90_nearest_abs_corr": _safe_float(np.quantile(nearest_abs, 0.90)) if nearest_abs.size else None,
        },
        "top_nearest_pairs": nearest_rows[:50],
        "all_nearest_pairs": nearest_rows,
        "pair_rows_ge_threshold": pair_rows,
        "top_strategy_ic_abs": top_ic(strategy_summary),
        "top_ml_ic_abs": top_ic(ml_summary),
        "ml_summary": ml_summary,
        "strategy_summary": strategy_summary,
        "elapsed_s": round(time.time() - started, 3),
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"feature_strategy_overlap_{args.universe}_{args.start_date}_{args.end_date}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    nearest_path = output_dir / f"{stem}_nearest.csv"
    pairs_path = output_dir / f"{stem}_pairs_ge_{str(args.pair_output_threshold).replace('.', '_')}.csv"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame(nearest_rows).to_csv(nearest_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(pair_rows).to_csv(pairs_path, index=False, encoding="utf-8-sig")
    result["artifacts"] = {
        "json": str(json_path),
        "nearest_csv": str(nearest_path),
        "pairs_csv": str(pairs_path),
    }
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", default="sii")
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--forward-days", type=int, default=5)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--min-pair-obs", type=int, default=5000)
    parser.add_argument("--min-symbols-ic", type=int, default=30)
    parser.add_argument("--high-overlap-threshold", type=float, default=0.8)
    parser.add_argument("--medium-overlap-threshold", type=float, default=0.4)
    parser.add_argument("--pair-output-threshold", type=float, default=0.6)
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "feature_strategy_overlap_numeric"))
    args = parser.parse_args()
    result = run(args)
    print(json.dumps({
        "counts": result["counts"],
        "nearest_summary": result["nearest_summary"],
        "artifacts": result["artifacts"],
        "elapsed_s": result["elapsed_s"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
