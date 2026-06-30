from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
FINLAB86_PATH = ROOT / "output" / "feature_universe_triage" / "finlab701_recommended_keep_candidates.csv"
DEFAULT_OUTPUT_DIR = ROOT / "output" / "finlab_alpha223_recursive_search"


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


miner = _load_module(TOOLS / "finlab_alpha_miner_bakeoff.py", "stockvision_alpha223_miner")
augment = _load_module(TOOLS / "finlab_augment701_backtest.py", "stockvision_alpha223_augment701")
compare = _load_module(TOOLS / "finlab_active_candidate_strategy_compare.py", "stockvision_alpha223_active_compare")


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


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _progress(message: str) -> None:
    print(f"[alpha223] {message}", file=sys.stderr, flush=True)


def _safe_feature_id(api_key: str) -> str:
    out = "".join(ch if ch.isalnum() else "_" for ch in api_key.strip())
    while "__" in out:
        out = out.replace("__", "_")
    return f"finlab701_{out.strip('_')}"[:120]


def _read_finlab86(path: Path, limit: int) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    if limit > 0:
        rows = rows[:limit]
    return rows


def _build_base_universe(args: argparse.Namespace):
    ns = argparse.Namespace(
        factor_json=args.factor_json,
        factor_universe="unified_registry_v1",
        feature_registry=args.feature_registry,
        monthly_mining_config=args.monthly_mining_config,
        similarity_contract=args.similarity_contract,
        similarity_pairs=args.similarity_pairs,
        disable_monthly_mining_config=True,
        start_date=args.start_date,
        end_date=args.end_date,
        train_start=args.train_start,
        train_end=args.train_end,
        validation_start=args.validation_start,
        validation_end=args.validation_end,
        holdout_start=args.holdout_start,
        holdout_end=args.holdout_end,
        universe=args.universe,
        top_k=args.top_k,
        max_symbols=args.max_symbols,
        min_factors=args.min_factors,
        max_factors=args.max_factors,
        fee_tax_cost=args.fee_tax_cost,
        seed=args.seed,
        random_trials=0,
        optuna_trials=0,
        deap_population=0,
        deap_generations=0,
        pymoo_population=0,
        pymoo_generations=0,
        finlab_confirm_top_n=0,
        pbo_folds=args.pbo_folds,
        promote_min_validation_sharpe=1.0,
        promote_min_holdout_sharpe=1.0,
        promote_min_full_cagr=0.0,
        promote_max_full_drawdown=0.35,
        promote_max_turnover=0.95,
        promote_min_deflated_sharpe_probability=0.95,
        promote_family_factor_jaccard=0.50,
        promote_family_category_jaccard=0.67,
        resample=args.resample,
        position_limit=args.position_limit,
        trade_at_price=args.trade_at_price,
        output_dir=str(args.output_dir),
    )
    return miner._build_unified_registry_factor_universe(ns)


def _materialize_finlab86(
    *,
    rows: list[dict[str, str]],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    materialized: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen_ids: set[str] = set(values)
    aug_args = argparse.Namespace(
        start_date=args.start_date,
        end_date=args.end_date,
        min_overlap_symbols=args.min_overlap_symbols,
        min_coverage=args.min_coverage,
        min_rank_std=args.min_rank_std,
    )
    close_all = close.loc[: args.end_date]
    columns = list(close.columns)
    for idx, row in enumerate(rows, start=1):
        frame, audit = augment._materialize_field(row, close=close_all, columns=columns, args=aug_args)
        if frame is None:
            skipped.append({**audit, "decision": row.get("decision")})
            continue
        fid = _safe_feature_id(str(row.get("api_key") or ""))
        if fid in seen_ids:
            suffix = 2
            while f"{fid}_{suffix}" in seen_ids:
                suffix += 1
            fid = f"{fid}_{suffix}"
        seen_ids.add(fid)
        aligned = miner._runtime_float_frame(frame, close.index, columns)
        values[fid] = aligned
        direction = miner._direction_from_mode(row.get("direction_mode"), 1.0)
        meta[fid] = miner.FactorMeta(
            id=fid,
            source="finlab701_research_supplement",
            category=str(row.get("dataset_lane") or row.get("group") or "finlab701"),
            direction=float(direction),
        )
        materialized.append(
            {
                "feature_id": fid,
                "api_key": row.get("api_key"),
                "field": row.get("field"),
                "dataset_lane": row.get("dataset_lane"),
                "decision": row.get("decision"),
                "direction_mode": row.get("direction_mode"),
                "monthly_sharpe": _safe_float(row.get("monthly_sharpe")),
                "cagr": _safe_float(row.get("cagr")),
                "coverage": _safe_float(row.get("coverage")),
            }
        )
        if idx % args.progress_every == 0:
            _progress(f"finlab86 materialized={len(materialized)} skipped={len(skipped)} processed={idx}/{len(rows)}")
    return {
        "requested": len(rows),
        "materialized": len(materialized),
        "skipped": len(skipped),
        "features": materialized,
        "skipped_rows": skipped,
    }


def _position_for_row(
    row: dict[str, Any],
    *,
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    args: argparse.Namespace,
) -> pd.DataFrame:
    cand = miner.Candidate(
        candidate_id=str(row["candidate_id"]),
        algorithm=str(row.get("algorithm") or "recursive_beam"),
        factor_ids=list(row["factor_ids"]),
        weights=list(row["weights"]),
        combine=str(row.get("combine") or "weighted_sum"),
    )
    score = miner._candidate_score(cand, values, meta)
    if score is None:
        return pd.DataFrame(False, index=close.index, columns=close.columns)
    raw = miner._position_from_score(score.loc[: args.end_date], args.top_k, tradable).loc[args.start_date : args.end_date]
    return miner._rebalance_position(raw, args.resample).reindex(index=close.loc[args.start_date : args.end_date].index, columns=close.columns).fillna(False).astype(bool)


def _load_active_positions(close: pd.DataFrame, args: argparse.Namespace) -> tuple[dict[str, pd.DataFrame], dict[str, Any], dict[str, pd.Series]]:
    tech = compare._load_module(compare.TECH_RUNNER, "stockvision_alpha223_tech")
    ns = argparse.Namespace(
        base_start_date=args.start_date,
        robustness_start_date=args.start_date,
        start_date=args.start_date,
        end_date=args.end_date,
        universe=args.universe,
        max_positions=args.top_k,
        position_limit=args.position_limit,
        trade_at_price=args.trade_at_price,
        resample="D",
        include_active_specs=True,
        active_spec_json=args.active_spec_json,
        base_results_csv=args.base_results_csv,
        fee_tax_cost=args.fee_tax_cost,
        extra_slippage_bps=[0],
        include_yearly=False,
    )
    positions, metadata, _active_close, warnings = compare._build_positions(ns, tech)
    active_positions: dict[str, pd.DataFrame] = {}
    active_returns: dict[str, pd.Series] = {}
    close_slice = close.loc[args.start_date : args.end_date]
    for sid, pos in positions.items():
        meta_row = metadata.get(sid)
        if meta_row is None or meta_row.group != "active_strategy_spec":
            continue
        aligned = pos.reindex(index=close_slice.index, columns=close_slice.columns).fillna(False).astype(bool)
        active_positions[sid] = aligned
        active_returns[sid] = miner._portfolio_returns(aligned, close_slice, fee_tax_cost=args.fee_tax_cost)
    return active_positions, {"warnings": warnings, "active_count": len(active_positions)}, active_returns


def _cell_jaccard(left: pd.DataFrame, right: pd.DataFrame) -> float:
    l = left.to_numpy(dtype=bool, copy=False)
    r = right.to_numpy(dtype=bool, copy=False)
    union = np.logical_or(l, r).sum()
    if int(union) == 0:
        return 0.0
    return float(np.logical_and(l, r).sum() / union)


def _latest_jaccard(left: pd.DataFrame, right: pd.DataFrame) -> float:
    if left.empty or right.empty:
        return 0.0
    lset = set(left.columns[left.iloc[-1].to_numpy(dtype=bool)])
    rset = set(right.columns[right.iloc[-1].to_numpy(dtype=bool)])
    union = lset | rset
    if not union:
        return 0.0
    return float(len(lset & rset) / len(union))


def _active_overlap(
    row: dict[str, Any],
    *,
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    active_positions: dict[str, pd.DataFrame],
    active_returns: dict[str, pd.Series],
    args: argparse.Namespace,
) -> dict[str, Any]:
    close_slice = close.loc[args.start_date : args.end_date]
    position = _position_for_row(row, values=values, meta=meta, close=close, tradable=tradable, args=args)
    returns = miner._portfolio_returns(position, close_slice, fee_tax_cost=args.fee_tax_cost)
    corr_rows: list[tuple[str, float]] = []
    jaccard_rows: list[tuple[str, float, float]] = []
    for sid, active_ret in active_returns.items():
        joined = pd.concat([returns, active_ret.reindex(returns.index)], axis=1).dropna()
        corr = _safe_float(joined.iloc[:, 0].corr(joined.iloc[:, 1])) if len(joined) > 2 else None
        corr_rows.append((sid, 0.0 if corr is None else float(corr)))
    for sid, active_pos in active_positions.items():
        aligned_active = active_pos.reindex(index=position.index, columns=position.columns).fillna(False).astype(bool)
        jaccard_rows.append((sid, _cell_jaccard(position, aligned_active), _latest_jaccard(position, aligned_active)))
    max_corr = max(corr_rows, key=lambda item: item[1]) if corr_rows else (None, None)
    max_abs_corr = max(corr_rows, key=lambda item: abs(item[1])) if corr_rows else (None, None)
    max_jaccard = max(jaccard_rows, key=lambda item: item[1]) if jaccard_rows else (None, None, None)
    return {
        "max_active_return_corr_id": max_corr[0],
        "max_active_return_corr": max_corr[1],
        "max_active_abs_return_corr_id": max_abs_corr[0],
        "max_active_abs_return_corr": abs(max_abs_corr[1]) if max_abs_corr[1] is not None else None,
        "max_active_all_period_jaccard_id": max_jaccard[0],
        "max_active_all_period_jaccard": max_jaccard[1],
        "latest_jaccard_to_max_active": max_jaccard[2],
        "avg_active_return_corr": float(np.mean([x[1] for x in corr_rows])) if corr_rows else None,
        "avg_active_all_period_jaccard": float(np.mean([x[1] for x in jaccard_rows])) if jaccard_rows else None,
    }


def _rank_score(row: dict[str, Any]) -> float:
    validation = row.get("validation") or {}
    holdout = row.get("holdout") or {}
    full = row.get("full") or {}
    full_cagr = float(full.get("cagr") or 0.0)
    full_sharpe = float(full.get("sharpe") or 0.0)
    val_sharpe = float(validation.get("sharpe") or 0.0)
    holdout_sharpe = float(holdout.get("sharpe") or 0.0)
    drawdown = abs(float(full.get("max_drawdown") or 0.0))
    corr = float(row.get("max_active_abs_return_corr") or 0.0)
    jaccard = float(row.get("max_active_all_period_jaccard") or 0.0)
    turnover = float(row.get("turnover") or 0.0)
    return (
        full_sharpe * 0.30
        + val_sharpe * 0.20
        + holdout_sharpe * 0.15
        + full_cagr * 0.60
        + float(row.get("novelty") or 0.0) * 0.15
        - corr * 0.75
        - jaccard * 4.00
        - max(0.0, drawdown - 0.35) * 1.5
        - turnover * 0.20
    )


def _evaluate(
    candidate: Any,
    *,
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    active_positions: dict[str, pd.DataFrame],
    active_returns: dict[str, pd.Series],
    args: argparse.Namespace,
    archive: list[set[str]],
    n_trials_hint: int,
    similarity_pair_map: dict[tuple[str, str], float],
    similarity_feature_meta: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    row = miner._evaluate_candidate(
        candidate,
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
    if row.get("status") == "ok":
        row.update(
            _active_overlap(
                row,
                values=values,
                meta=meta,
                close=close,
                tradable=tradable,
                active_positions=active_positions,
                active_returns=active_returns,
                args=args,
            )
        )
        row["alpha223_score"] = _rank_score(row)
        row["factor_sources"] = [meta[fid].source for fid in row["factor_ids"]]
        row["factor_categories"] = [meta[fid].category for fid in row["factor_ids"]]
        row["has_finlab86"] = any(str(meta[fid].source) == "finlab701_research_supplement" for fid in row["factor_ids"])
    else:
        row["alpha223_score"] = -999.0
    return row


def _candidate_key(factors: list[str]) -> tuple[str, ...]:
    return tuple(sorted(set(factors)))


def _recursive_beam_search(
    *,
    factor_ids: list[str],
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    active_positions: dict[str, pd.DataFrame],
    active_returns: dict[str, pd.Series],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    similarity_contract = miner._load_similarity_contract(Path(args.similarity_contract))
    similarity_pair_map = miner._load_similarity_pair_map(Path(args.similarity_pairs))
    similarity_feature_meta = miner._similarity_feature_meta(similarity_contract)
    rows: list[dict[str, Any]] = []
    archive: list[set[str]] = []
    seen: set[tuple[str, ...]] = set()

    def eval_factors(name: str, factors: list[str], weights: list[float] | None = None) -> dict[str, Any]:
        key = _candidate_key(factors)
        if key in seen:
            return {}
        seen.add(key)
        selected = list(key)
        if weights is None or len(weights) != len(selected):
            weights = [1.0] * len(selected)
        cand = miner.Candidate(name, "recursive_beam", selected, weights, combine="weighted_sum")
        row = _evaluate(
            cand,
            values=values,
            meta=meta,
            close=close,
            tradable=tradable,
            active_positions=active_positions,
            active_returns=active_returns,
            args=args,
            archive=archive,
            n_trials_hint=args.max_evals,
            similarity_pair_map=similarity_pair_map,
            similarity_feature_meta=similarity_feature_meta,
        )
        rows.append(row)
        if row.get("status") == "ok":
            archive.append(set(selected))
        return row

    _progress(f"evaluating singles: {len(factor_ids)}")
    single_rows: list[dict[str, Any]] = []
    for idx, fid in enumerate(factor_ids):
        row = eval_factors(f"recursive_beam_single_{idx:04d}", [fid])
        if row and row.get("status") == "ok":
            single_rows.append(row)
        if args.max_evals > 0 and len(rows) >= args.max_evals:
            return rows

    ranked_singles = sorted(single_rows, key=lambda row: float(row.get("alpha223_score") or -999.0), reverse=True)
    seed_factors = [fid for row in ranked_singles[: args.seed_pool] for fid in row.get("factor_ids", [])]
    finlab_seed = [
        fid
        for fid in factor_ids
        if str(meta[fid].source) == "finlab701_research_supplement"
    ][: args.finlab_seed_pool]
    seed_factors = list(dict.fromkeys(seed_factors + finlab_seed))
    beam = ranked_singles[: args.beam_width]

    for depth in range(2, args.max_depth + 1):
        _progress(f"expanding depth={depth} beam={len(beam)} seeds={len(seed_factors)} evals={len(rows)}")
        candidates: list[dict[str, Any]] = []
        for parent in beam:
            base = list(parent.get("factor_ids") or [])
            expansions = 0
            for fid in seed_factors:
                if fid in base:
                    continue
                factors = base + [fid]
                if len(set(factors)) != depth:
                    continue
                row = eval_factors(f"recursive_beam_d{depth}_{len(rows):05d}", factors)
                if row and row.get("status") == "ok":
                    candidates.append(row)
                    expansions += 1
                if expansions >= args.expand_per_node:
                    break
                if args.max_evals > 0 and len(rows) >= args.max_evals:
                    break
            if args.max_evals > 0 and len(rows) >= args.max_evals:
                break
        beam = sorted(candidates, key=lambda row: float(row.get("alpha223_score") or -999.0), reverse=True)[: args.beam_width]
        if not beam:
            break
        if args.max_evals > 0 and len(rows) >= args.max_evals:
            break
    return rows


def _pymoo_search(
    *,
    factor_ids: list[str],
    values: dict[str, pd.DataFrame],
    meta: dict[str, Any],
    close: pd.DataFrame,
    tradable: pd.DataFrame,
    active_positions: dict[str, pd.DataFrame],
    active_returns: dict[str, pd.Series],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    similarity_contract = miner._load_similarity_contract(Path(args.similarity_contract))
    similarity_pair_map = miner._load_similarity_pair_map(Path(args.similarity_pairs))
    similarity_feature_meta = miner._similarity_feature_meta(similarity_contract)
    archive: list[set[str]] = []

    def evaluate(cand: Any, *, n_trials_hint: int) -> dict[str, Any]:
        row = _evaluate(
            cand,
            values=values,
            meta=meta,
            close=close,
            tradable=tradable,
            active_positions=active_positions,
            active_returns=active_returns,
            args=args,
            archive=archive,
            n_trials_hint=n_trials_hint,
            similarity_pair_map=similarity_pair_map,
            similarity_feature_meta=similarity_feature_meta,
        )
        if row.get("status") == "ok":
            archive.append(set(row.get("factor_ids") or []))
        return row

    _progress(
        "running pymoo NSGA-III + novelty: "
        f"population={args.pymoo_population}, generations={args.pymoo_generations}, factors={len(factor_ids)}"
    )
    return miner._run_pymoo(factor_ids, evaluate, args, archive)


def _finlab_confirm(rows: list[dict[str, Any]], *, values, meta, close, tradable, args) -> list[dict[str, Any]]:
    selected = sorted(
        [row for row in rows if row.get("status") == "ok"],
        key=lambda row: float(row.get("alpha223_score") or -999.0),
        reverse=True,
    )[: args.finlab_confirm_top_n]
    confirm_args = argparse.Namespace(
        resample=args.resample,
        trade_at_price=args.trade_at_price,
        position_limit=args.position_limit,
    )
    ab = miner._load_module(miner.AB_RUNNER, "stockvision_alpha223_confirm_ab")
    out: list[dict[str, Any]] = []
    for row in selected:
        pos = _position_for_row(row, values=values, meta=meta, close=close, tradable=tradable, args=args)
        confirm = ab._run_sim(
            row_id=f"alpha223_{row['candidate_id']}",
            kind="alpha223_recursive_confirm",
            meta={
                "factor_ids": row.get("factor_ids"),
                "weights": row.get("weights"),
                "alpha223_score": row.get("alpha223_score"),
                "max_active_return_corr": row.get("max_active_return_corr"),
                "max_active_all_period_jaccard": row.get("max_active_all_period_jaccard"),
                "has_finlab86": row.get("has_finlab86"),
            },
            position=pos,
            args=confirm_args,
        )
        out.append(confirm)
    return out


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    _progress("building formal137 universe")
    close, tradable, values, meta, universe_info = _build_base_universe(args)
    formal_count = len(values)
    _progress(f"formal137 mapped={formal_count}")

    finlab86_rows = _read_finlab86(Path(args.finlab86_csv), args.limit_finlab86)
    finlab86_info = _materialize_finlab86(
        rows=finlab86_rows,
        close=close,
        tradable=tradable,
        values=values,
        meta=meta,
        args=args,
    )
    factor_ids = sorted(values.keys())
    _progress(f"combined universe mapped={len(factor_ids)} formal={formal_count} finlab86={finlab86_info['materialized']}")

    _progress("building active 11 positions")
    active_positions, active_info, active_returns = _load_active_positions(close, args)
    _progress(f"active positions ready: {len(active_positions)}")

    rows: list[dict[str, Any]] = []
    enabled = str(args.algorithm or "pymoo").strip().lower()
    if enabled in {"pymoo", "both"}:
        rows.extend(
            _pymoo_search(
                factor_ids=factor_ids,
                values=values,
                meta=meta,
                close=close,
                tradable=tradable,
                active_positions=active_positions,
                active_returns=active_returns,
                args=args,
            )
        )
    if enabled in {"recursive_beam", "both"}:
        rows.extend(
            _recursive_beam_search(
                factor_ids=factor_ids,
                values=values,
                meta=meta,
                close=close,
                tradable=tradable,
                active_positions=active_positions,
                active_returns=active_returns,
                args=args,
            )
        )
    ok_rows = [row for row in rows if row.get("status") == "ok"]
    ranked = sorted(ok_rows, key=lambda row: float(row.get("alpha223_score") or -999.0), reverse=True)
    confirm = _finlab_confirm(rows, values=values, meta=meta, close=close, tradable=tradable, args=args) if args.finlab_confirm_top_n > 0 else []
    return {
        "schema_version": "stockvision-alpha223-recursive-search-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "runtime_seconds": round(time.time() - started, 3),
        "config": vars(args),
        "universe": {
            "formal137_mapped": formal_count,
            "finlab86_requested": finlab86_info["requested"],
            "finlab86_materialized": finlab86_info["materialized"],
            "combined_mapped": len(factor_ids),
            "formal_universe_info": {key: value for key, value in universe_info.items() if key not in {"factor_meta"}},
            "finlab86": finlab86_info,
        },
        "active": active_info,
        "summary": {
            "evaluated": len(rows),
            "ok": len(ok_rows),
            "top_candidates": ranked[: args.report_top_n],
        },
        "rows": rows,
        "finlab_confirm": confirm,
    }


def _write_outputs(report: dict[str, Any], args: argparse.Namespace) -> dict[str, str]:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"alpha223_recursive_{args.universe}_{args.start_date}_{args.end_date}_seed{args.seed}".replace("-", "")
    json_path = output_dir / f"{stem}.json"
    rows_path = output_dir / f"{stem}_rows.csv"
    top_path = output_dir / f"{stem}_top.csv"
    confirm_path = output_dir / f"{stem}_finlab_confirm.csv"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report["rows"]).to_csv(rows_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["summary"]["top_candidates"]).to_csv(top_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report["finlab_confirm"]).to_csv(confirm_path, index=False, encoding="utf-8-sig")
    summary = {
        "json": str(json_path),
        "rows_csv": str(rows_path),
        "top_csv": str(top_path),
        "finlab_confirm_csv": str(confirm_path),
        "runtime_seconds": report["runtime_seconds"],
        "universe": {
            "formal137_mapped": report["universe"]["formal137_mapped"],
            "finlab86_requested": report["universe"]["finlab86_requested"],
            "finlab86_materialized": report["universe"]["finlab86_materialized"],
            "combined_mapped": report["universe"]["combined_mapped"],
        },
        "active": report["active"],
        "summary": report["summary"],
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    return {
        "json": str(json_path),
        "rows_csv": str(rows_path),
        "top_csv": str(top_path),
        "finlab_confirm_csv": str(confirm_path),
        "summary_json": str(summary_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Research-only recursive alpha search over formal137 plus FinLab86 supplement candidates.")
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--feature-registry", default=str(ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"))
    parser.add_argument("--monthly-mining-config", default=str(ROOT / "data" / "feature_registry" / "pymoo_monthly_mining_config_v1.json"))
    parser.add_argument("--similarity-contract", default=str(ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"))
    parser.add_argument("--similarity-pairs", default=str(ROOT / "output" / "feature_universe_triage" / "formal137_pairwise_similarity_long_20260617.csv"))
    parser.add_argument("--finlab86-csv", default=str(FINLAB86_PATH))
    parser.add_argument("--active-spec-json", default=str(ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"))
    parser.add_argument("--base-results-csv", default=str(ROOT / "output" / "finlab_technical_strategy12_backtests" / "technical_strategy12_sii_otc_20230101_20260615_results.csv"))
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--train-start", default="2023-01-01")
    parser.add_argument("--train-end", default="2024-12-31")
    parser.add_argument("--validation-start", default="2025-01-01")
    parser.add_argument("--validation-end", default="2025-12-31")
    parser.add_argument("--holdout-start", default="2026-01-01")
    parser.add_argument("--holdout-end", default="2026-06-15")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--algorithm", choices=["pymoo", "recursive_beam", "both"], default="pymoo")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--min-factors", type=int, default=1)
    parser.add_argument("--max-factors", type=int, default=6)
    parser.add_argument("--max-depth", type=int, default=5)
    parser.add_argument("--beam-width", type=int, default=24)
    parser.add_argument("--seed-pool", type=int, default=72)
    parser.add_argument("--finlab-seed-pool", type=int, default=48)
    parser.add_argument("--expand-per-node", type=int, default=18)
    parser.add_argument("--max-evals", type=int, default=1200)
    parser.add_argument("--pymoo-population", type=int, default=48)
    parser.add_argument("--pymoo-generations", type=int, default=6)
    parser.add_argument("--limit-finlab86", type=int, default=0)
    parser.add_argument("--min-overlap-symbols", type=int, default=80)
    parser.add_argument("--min-coverage", type=float, default=0.15)
    parser.add_argument("--min-rank-std", type=float, default=0.01)
    parser.add_argument("--fee-tax-cost", type=float, default=0.004425)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--pbo-folds", type=int, default=8)
    parser.add_argument("--resample", default="M")
    parser.add_argument("--position-limit", type=float, default=0.10)
    parser.add_argument("--trade-at-price", default="close")
    parser.add_argument("--finlab-confirm-top-n", type=int, default=12)
    parser.add_argument("--report-top-n", type=int, default=20)
    parser.add_argument("--progress-every", type=int, default=10)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()
    report = run(args)
    paths = _write_outputs(report, args)
    payload = {
        **paths,
        "runtime_seconds": report["runtime_seconds"],
        "universe": {
            "formal137_mapped": report["universe"]["formal137_mapped"],
            "finlab86_requested": report["universe"]["finlab86_requested"],
            "finlab86_materialized": report["universe"]["finlab86_materialized"],
            "combined_mapped": report["universe"]["combined_mapped"],
        },
        "evaluated": report["summary"]["evaluated"],
        "ok": report["summary"]["ok"],
        "top_candidates": report["summary"]["top_candidates"][:5],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
