from __future__ import annotations

import argparse
import asyncio
import csv
import importlib.util
import json
import logging
import math
import os
import sys
import time
import types
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
ALPHA_MINER = ROOT / "tools" / "finlab_alpha_miner_bakeoff.py"
DEFAULT_CONFIRM_CSV = (
    ROOT
    / "output"
    / "finlab_alpha_miner_canonical114_mresample"
    / "alpha_miner_bakeoff_canonical114_pymoo_sii_20230101_20260615_seed42_finlab_confirm.csv"
)

REPRESENTATIVE_CANDIDATE_IDS = [
    "alpha_miner_pymoo_nsga3_novelty_0081",
    "alpha_miner_pymoo_nsga3_novelty_0193",
    "alpha_miner_pymoo_nsga3_novelty_0187",
]

STRATEGY_FAMILY_ID = "ALPHA_MINER_NSAS_NOVELTY"


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, set):
        return sorted(value)
    return str(value)


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _parse_literal_list(raw: str) -> list[Any]:
    text = str(raw or "").strip()
    if not text:
        return []
    import ast

    value = ast.literal_eval(text)
    if not isinstance(value, list):
        raise ValueError(f"literal_is_not_list:{text}")
    return value


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _safe_int(value: Any, default: int | None = None) -> int | None:
    try:
        out = int(float(value))
    except (TypeError, ValueError):
        return default
    return out


def _load_confirm_candidates(path: Path, candidate_ids: list[str]) -> list[dict[str, Any]]:
    wanted = set(candidate_ids)
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("id") not in wanted:
                continue
            rows.append(
                {
                    "id": str(row["id"]),
                    "algorithm": row.get("algorithm") or "pymoo_nsga3_novelty",
                    "factor_ids": [str(x) for x in _parse_literal_list(row.get("factor_ids", ""))],
                    "weights": [float(x) for x in _parse_literal_list(row.get("weights", ""))],
                    "combine": row.get("combine") or "weighted_sum",
                    "finlab_confirm": {
                        "cagr": _safe_float(row.get("cagr")),
                        "max_drawdown": _safe_float(row.get("max_drawdown")),
                        "monthly_sharpe": _safe_float(row.get("monthly_sharpe")),
                        "calmar": _safe_float(row.get("calmar")),
                        "latest_matches": _safe_int(row.get("latest_matches")),
                    },
                }
            )
    order = {candidate_id: idx for idx, candidate_id in enumerate(candidate_ids)}
    return sorted(rows, key=lambda row: order.get(str(row["id"]), 999))


def _latest_index(index: pd.Index, run_date: str) -> pd.Timestamp:
    end = pd.Timestamp(run_date)
    available = pd.DatetimeIndex(index)
    filtered = available[available <= end]
    if len(filtered) == 0:
        raise RuntimeError(f"no_available_date_before:{run_date}")
    return pd.Timestamp(filtered[-1])


def _symbols_from_bool_row(row: pd.Series) -> list[str]:
    return sorted(str(symbol) for symbol, flag in row.items() if bool(flag))


def _pairwise_overlap(selection: dict[str, list[str]]) -> list[dict[str, Any]]:
    ids = sorted(selection)
    out: list[dict[str, Any]] = []
    for i, left_id in enumerate(ids):
        left = set(selection[left_id])
        for right_id in ids[i + 1 :]:
            right = set(selection[right_id])
            union = left | right
            inter = left & right
            out.append(
                {
                    "left": left_id,
                    "right": right_id,
                    "left_count": len(left),
                    "right_count": len(right),
                    "intersection": len(inter),
                    "union": len(union),
                    "jaccard": round(len(inter) / len(union), 6) if union else None,
                    "overlap_symbols": sorted(inter),
                }
            )
    return out


def _summarize_overlap(selection: dict[str, list[str]]) -> dict[str, Any]:
    pairwise = _pairwise_overlap(selection)
    jaccards = [float(row["jaccard"]) for row in pairwise if row.get("jaccard") is not None]
    symbols = set()
    for slate in selection.values():
        symbols.update(slate)
    return {
        "strategy_count": len(selection),
        "non_empty_strategy_count": sum(1 for slate in selection.values() if slate),
        "unique_symbol_count": len(symbols),
        "avg_pairwise_jaccard": round(float(np.mean(jaccards)), 6) if jaccards else None,
        "max_pairwise_jaccard": round(float(np.max(jaccards)), 6) if jaccards else None,
        "pairwise": pairwise,
    }


def _normalize_series(row: pd.Series) -> pd.Series:
    clean = row.replace([np.inf, -np.inf], np.nan).astype(float)
    if clean.dropna().empty:
        return clean.fillna(0.0)
    lo = float(clean.min(skipna=True))
    hi = float(clean.max(skipna=True))
    if not math.isfinite(lo) or not math.isfinite(hi) or abs(hi - lo) <= 1e-12:
        return clean.rank(pct=True).fillna(0.0)
    return ((clean - lo) / (hi - lo)).fillna(0.0)


def _adaptive_quality_floor(
    scores: list[float],
    *,
    min_quantile: float,
    mad_multiplier: float,
    min_score: float,
) -> tuple[float, dict[str, Any]]:
    clean = np.asarray([float(value) for value in scores if math.isfinite(float(value))], dtype=float)
    if clean.size == 0:
        return float(min_score), {
            "status": "empty",
            "floor": float(min_score),
            "min_score": float(min_score),
        }
    safe_q = max(0.0, min(1.0, float(min_quantile)))
    median = float(np.median(clean))
    mad = float(np.median(np.abs(clean - median)))
    quantile_floor = float(np.quantile(clean, safe_q))
    robust_floor = median + (float(mad_multiplier) * mad)
    floor = max(float(min_score), quantile_floor, robust_floor)
    return round(float(floor), 6), {
        "status": "ok",
        "floor": round(float(floor), 6),
        "min_score": float(min_score),
        "min_quantile": safe_q,
        "quantile_floor": round(quantile_floor, 6),
        "median": round(median, 6),
        "mad": round(mad, 6),
        "mad_multiplier": float(mad_multiplier),
        "robust_floor": round(robust_floor, 6),
        "score_min": round(float(np.min(clean)), 6),
        "score_max": round(float(np.max(clean)), 6),
        "score_mean": round(float(np.mean(clean)), 6),
        "score_count": int(clean.size),
    }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


def _strategy_reliability(metrics: dict[str, Any]) -> float:
    sharpe = _safe_float(metrics.get("monthly_sharpe"), 0.0) or 0.0
    cagr = _safe_float(metrics.get("cagr"), 0.0) or 0.0
    mdd = abs(_safe_float(metrics.get("max_drawdown"), 0.0) or 0.0)
    sharpe_score = _clamp(sharpe / 1.5, 0.0, 1.0)
    cagr_score = _clamp(cagr / 0.5, 0.0, 1.0)
    drawdown_score = _clamp(1.0 - (mdd / 0.35), 0.0, 1.0)
    return round((sharpe_score * 0.45) + (cagr_score * 0.35) + (drawdown_score * 0.20), 6)


def _build_l125_metrics(
    candidate_rows: list[dict[str, Any]],
    selection: dict[str, list[str]],
) -> dict[str, dict[str, Any]]:
    pairwise = _pairwise_overlap(selection)
    crowd_by_id: dict[str, float] = {row["id"]: 0.0 for row in candidate_rows}
    for row in pairwise:
        j = float(row.get("jaccard") or 0.0)
        crowd_by_id[row["left"]] = max(crowd_by_id.get(row["left"], 0.0), j)
        crowd_by_id[row["right"]] = max(crowd_by_id.get(row["right"], 0.0), j)

    metrics: dict[str, dict[str, Any]] = {}
    raw_weights: dict[str, float] = {}
    for row in candidate_rows:
        sid = str(row["id"])
        reliability = _strategy_reliability(row.get("finlab_confirm") or {})
        crowding = round(crowd_by_id.get(sid, 0.0), 6)
        diversification = round(1.0 - crowding, 6)
        raw_weight = max(0.0, reliability * (0.75 + 0.25 * diversification))
        raw_weights[sid] = raw_weight
        metrics[sid] = {
            "strategy_id": sid,
            "family_id": STRATEGY_FAMILY_ID,
            "source": "finlab_confirm_plus_overlap_research_proxy",
            "finlab_confirm": row.get("finlab_confirm"),
            "strategy_reliability": reliability,
            "strategy_crowding_score": crowding,
            "strategy_diversification_value": diversification,
            "latest_match_count": len(selection.get(sid) or []),
            "factor_ids": row.get("factor_ids") or [],
            "combine": row.get("combine"),
        }

    total = sum(raw_weights.values()) or 1.0
    for sid, metric in metrics.items():
        prior = raw_weights.get(sid, 0.0) / total
        metric["strategy_prior_weight"] = round(prior, 6)
        metric["family_prior_weight"] = 1.0
    return metrics


def _full_market_hit_symbols(
    score_row: pd.Series,
    symbols: list[str],
    *,
    min_quantile: float,
    mad_multiplier: float,
    min_score: float,
) -> tuple[list[str], dict[str, Any]]:
    normalized = _normalize_series(score_row.reindex(symbols))
    floor, detail = _adaptive_quality_floor(
        [float(value) for value in normalized.values],
        min_quantile=min_quantile,
        mad_multiplier=mad_multiplier,
        min_score=min_score,
    )
    hits = sorted(str(symbol) for symbol, value in normalized.items() if float(value or 0.0) >= floor)
    detail["hit_count"] = len(hits)
    return hits, detail


def _build_route_rows(
    *,
    candidates: list[dict[str, Any]],
    scores_by_strategy: dict[str, pd.Series],
    selection: dict[str, list[str]],
    l125_metrics: dict[str, dict[str, Any]],
    universe_symbols: list[str] | None = None,
    route_min_quantile: float = 0.88,
    route_mad_multiplier: float = 1.0,
    route_min_score: float = 0.0,
    apply_route_floor: bool = False,
    selection_policy: str = "union_of_mined_strategy_hits_sorted_by_route_score_no_top_up",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    all_symbols = sorted(universe_symbols or {symbol for symbols in selection.values() for symbol in symbols})
    if not all_symbols:
        return [], {"strategy_hit_matrix_cells": 0, "active_labeled_candidates": 0}

    strategy_ids = [str(row["id"]) for row in candidates]
    normalized_by_strategy: dict[str, pd.Series] = {}
    hit_sets = {sid: set(selection.get(sid) or []) for sid in strategy_ids}
    for sid in strategy_ids:
        series = scores_by_strategy.get(sid)
        normalized_by_strategy[sid] = (
            _normalize_series(series.reindex(all_symbols))
            if isinstance(series, pd.Series)
            else pd.Series(0.0, index=all_symbols)
        )

    rows: list[dict[str, Any]] = []
    for symbol in all_symbols:
        strategy_affinity: dict[str, float] = {}
        weak_label: dict[str, float] = {}
        hit_vector: dict[str, float] = {}
        position_weight: dict[str, float] = {}
        route_score = 0.0
        support_weight = 0.0
        support_count = 0

        for sid in strategy_ids:
            normalized = normalized_by_strategy[sid]
            affinity = float(normalized.get(symbol, 0.0) or 0.0)
            hit = 1.0 if symbol in hit_sets[sid] else 0.0
            prior = float((l125_metrics.get(sid) or {}).get("strategy_prior_weight") or 0.0)
            strategy_affinity[sid] = round(affinity, 6)
            weak_label[sid] = round(affinity, 6)
            hit_vector[sid] = hit
            position_weight[sid] = round(prior * affinity, 6)
            route_score += affinity * prior
            if hit:
                support_weight += prior
                support_count += 1

        family_affinity = {STRATEGY_FAMILY_ID: round(max(strategy_affinity.values() or [0.0]), 6)}
        route_score = round(route_score + min(0.08, support_count * 0.015), 6)
        rows.append(
            {
                "symbol": symbol,
                "candidate_route_score": route_score,
                "ml_slate_eligibility": route_score,
                "strategy_support_count": support_count,
                "strategy_support_weight": round(support_weight, 6),
                "strategy_affinity_vector": strategy_affinity,
                "family_affinity_vector": family_affinity,
                "strategy_family_affinity": family_affinity,
                "strategy_weak_label_vector": weak_label,
                "strategy_hit_vector": hit_vector,
                "strategy_position_weight_vector": position_weight,
                "strategy_overlap_vector": {},
                "runtime_teacher_evidence": {},
                "runtime_teacher_evidence_source": "missing_runtime_teacher_cache",
                "ml_teacher_labels": {},
                "strategy_router_components": {
                    "strategy_prior_weight": round(support_weight, 6),
                    "strategy_crowding_score": round(
                        np.mean([
                            float((l125_metrics.get(sid) or {}).get("strategy_crowding_score") or 0.0)
                            for sid in strategy_ids
                            if symbol in set(selection.get(sid) or [])
                        ])
                        if support_count
                        else 0.0,
                        6,
                    ),
                    "teacher_label_count": 0,
                    "runtime_teacher_evidence_count": 0,
                    "runtime_teacher_evidence_missing": 1,
                },
            }
        )

    rows = sorted(rows, key=lambda row: (row["candidate_route_score"], row["strategy_support_weight"]), reverse=True)
    pre_floor_count = len(rows)
    route_floor = None
    route_floor_detail: dict[str, Any] | None = None
    if apply_route_floor:
        route_floor, route_floor_detail = _adaptive_quality_floor(
            [float(row.get("candidate_route_score") or 0.0) for row in rows],
            min_quantile=route_min_quantile,
            mad_multiplier=route_mad_multiplier,
            min_score=route_min_score,
        )
        rows = [row for row in rows if float(row.get("candidate_route_score") or 0.0) >= route_floor]
    telemetry = {
        "strategy_hit_matrix_cells": len(all_symbols) * len(strategy_ids),
        "active_labeled_candidates": len(all_symbols),
        "strategy_count": len(strategy_ids),
        "pre_floor_count": pre_floor_count,
        "final_seed_count": len(rows),
        "selection_policy": selection_policy,
        "route_floor": route_floor,
        "route_floor_detail": route_floor_detail,
        "runtime_teacher_evidence_policy": "missing_allowed_no_fake_neutral",
    }
    return rows, telemetry


def _stock_placeholders(count: int) -> str:
    return ",".join(["?"] * count)


def _load_stock_metadata(symbols: list[str]) -> dict[str, dict[str, Any]]:
    if not symbols:
        return {}
    if str(ML_CONTROLLER) not in sys.path:
        sys.path.insert(0, str(ML_CONTROLLER))
    from services import d1_client

    rows: list[dict[str, Any]] = []
    unique_symbols = sorted(dict.fromkeys(str(symbol) for symbol in symbols if str(symbol).strip()))
    chunk_size = 80
    for start in range(0, len(unique_symbols), chunk_size):
        chunk = unique_symbols[start : start + chunk_size]
        rows.extend(
            d1_client.query(
                f"""
                SELECT s.id, s.symbol, s.name, s.market, s.sector,
                       (
                         SELECT tag
                           FROM stock_tags st
                          WHERE st.symbol = s.symbol
                            AND st.tag_type IN ('industry', 'sector')
                          ORDER BY CASE st.tag_type WHEN 'industry' THEN 0 ELSE 1 END
                          LIMIT 1
                       ) AS industry
                  FROM stocks s
                 WHERE s.symbol IN ({_stock_placeholders(len(chunk))})
                """,
                chunk,
            )
        )
    return {str(row["symbol"]): dict(row) for row in rows}


def _build_score_seed(route_score: float, support_weight: float) -> dict[str, float]:
    base = _clamp(route_score, 0.0, 1.0)
    support = _clamp(support_weight, 0.0, 1.0)
    return {
        "chipFlowSeed40": round(support * 8.0, 1),
        "technicalSeed30": round(base * 18.0, 1),
        "screenerMomentumSeed20": round(base * 12.0, 1),
        "mlEdgeSeed30": 0.0,
        "personaAlphaSeed": 0.0,
    }


def _build_screener_recs(
    *,
    route_rows: list[dict[str, Any]],
    stock_meta_by_symbol: dict[str, dict[str, Any]],
    run_date: str,
) -> list[dict[str, Any]]:
    if str(ML_CONTROLLER) not in sys.path:
        sys.path.insert(0, str(ML_CONTROLLER))
    from services.recommendation_service import build_score_components

    recs: list[dict[str, Any]] = []
    for rank, route in enumerate(route_rows, start=1):
        symbol = str(route["symbol"])
        meta = stock_meta_by_symbol.get(symbol) or {}
        stock_id = meta.get("id")
        if not stock_id:
            continue
        seed_inputs = _build_score_seed(
            float(route.get("candidate_route_score") or 0.0),
            float(route.get("strategy_support_weight") or 0.0),
        )
        rec: dict[str, Any] = {
            **route,
            "id": -rank,
            "date": run_date,
            "stock_id": stock_id,
            "symbol": symbol,
            "name": meta.get("name") or symbol,
            "sector": meta.get("sector"),
            "industry": meta.get("industry") or meta.get("sector"),
            "market": meta.get("market") or "LISTED",
            "market_segment": "LISTED",
            "recommendation_lane": "tradable",
            "eligible_for_ml": True,
            "eligible_for_pending_buy": True,
            "has_buy_signal": 0,
            "rank": rank,
            "score": round(float(route.get("candidate_route_score") or 0.0) * 100.0, 1),
            "reason": "pymoo_nsga3_novelty_challenger_seed",
            "watch_points": [
                "research_only:pymoo_nsga3_novelty_challenger",
                "dry_run:no_d1_write",
            ],
            "score_seed_inputs": seed_inputs,
            "alpha_context": {
                "edge_bucket": "pymoo_challenger",
                "score_adjustment": 0,
                "risk_overlay": {"flags": []},
            },
        }
        rec["score_components"] = build_score_components(rec, raw_score=float(rec["score"]))
        recs.append(rec)
    return recs


def _patch_payloads_with_strategy_evidence(payloads: list[dict[str, Any]], recs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rec_by_symbol = {str(rec.get("symbol")): rec for rec in recs}
    patched: list[dict[str, Any]] = []
    for payload in payloads:
        row = dict(payload)
        rec = rec_by_symbol.get(str(row.get("symbol")))
        if rec:
            for key in (
                "strategy_affinity_vector",
                "family_affinity_vector",
                "strategy_weak_label_vector",
                "strategy_hit_vector",
                "strategy_position_weight_vector",
                "strategy_overlap_vector",
                "candidate_route_score",
                "ml_slate_eligibility",
            ):
                if key in rec:
                    row[key] = rec[key]
        patched.append(row)
    return patched


def _install_langgraph_import_shim() -> None:
    """Let this research runner import pipeline node functions without local langgraph."""
    if "langgraph.graph" in sys.modules and "langgraph.types" in sys.modules:
        return
    try:
        import langgraph.graph  # type: ignore  # noqa: F401
        import langgraph.types  # type: ignore  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    class _StateGraph:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            self.nodes: dict[str, Any] = {}

        def add_node(self, name: str, fn: Any, *args: Any, **kwargs: Any) -> None:
            self.nodes[name] = fn

        def add_edge(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def set_entry_point(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def compile(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("langgraph shim compile is unavailable in research dry-run")

    class _RetryPolicy:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.args = args
            self.kwargs = kwargs

    langgraph_mod = types.ModuleType("langgraph")
    graph_mod = types.ModuleType("langgraph.graph")
    graph_mod.StateGraph = _StateGraph
    graph_mod.END = "__END__"
    types_mod = types.ModuleType("langgraph.types")
    types_mod.RetryPolicy = _RetryPolicy
    sys.modules.setdefault("langgraph", langgraph_mod)
    sys.modules["langgraph.graph"] = graph_mod
    sys.modules["langgraph.types"] = types_mod


def _summarize_predictions(predictions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    signals: dict[str, int] = {}
    for row in predictions.values():
        signal = str((row.get("ensemble_v2") or {}).get("signal") or row.get("signal") or "UNKNOWN")
        signals[signal] = signals.get(signal, 0) + 1
    return {
        "count": len(predictions),
        "signal_counts": signals,
        "symbols": sorted(predictions),
    }


def _summarize_final(final: list[dict[str, Any]]) -> dict[str, Any]:
    buy = [row for row in final if int(row.get("has_buy_signal") or 0) == 1]
    sparse_selected = [
        row
        for row in final
        if isinstance(row.get("alpha_allocation"), dict)
        and bool(row["alpha_allocation"].get("selected"))
    ]
    return {
        "kept_count": len(final),
        "buy_signal_count": len(buy),
        "sparse_selected_count": len(sparse_selected),
        "kept_symbols": [str(row.get("symbol")) for row in final],
        "buy_symbols": [str(row.get("symbol")) for row in buy],
        "sparse_selected_symbols": [str(row.get("symbol")) for row in sparse_selected],
        "rows": [
            {
                "symbol": row.get("symbol"),
                "score": row.get("score"),
                "signal": row.get("signal"),
                "confidence": row.get("confidence"),
                "ml_forecast_pct": row.get("ml_forecast_pct"),
                "has_buy_signal": row.get("has_buy_signal"),
                "core_ml_gate": row.get("core_ml_gate"),
                "core_family_vote": row.get("core_family_vote"),
                "alpha_allocation": row.get("alpha_allocation"),
                "watch_points": row.get("watch_points"),
            }
            for row in final
        ],
    }


def _build_layer_report(
    *,
    run_date: str,
    latest_factor_date: pd.Timestamp,
    candidates: list[dict[str, Any]],
    selection: dict[str, list[str]],
    route_rows: list[dict[str, Any]],
    l125_metrics: dict[str, dict[str, Any]],
    route_telemetry: dict[str, Any],
    l2_result: dict[str, Any],
    l2_gate: dict[str, Any],
    l3_result: dict[str, Any],
    recommend_result: dict[str, Any],
    screener_recs: list[dict[str, Any]],
    payloads: list[dict[str, Any]],
) -> dict[str, Any]:
    l2_predictions = dict(l2_result.get("l2_predictions") or {})
    merged_predictions = dict(l3_result.get("predictions") or {})
    final = list(recommend_result.get("final_recommendations") or [])
    return {
        "schema_version": "stockvision-pymoo-l0-l4-dry-run-compare-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only_dry_run",
        "decision_effect": "none_no_d1_kv_write",
        "run_date_requested": run_date,
        "latest_factor_date": latest_factor_date.isoformat(),
        "replacement_question": {
            "current_25_plus_3": "not_recommended_as_default",
            "tested_policy": "replace_current_l1_strategy_set_with_3_pymoo_nsga3_novelty_challengers_for_dry_run",
        },
        "L0_universe_features": {
            "factor_universe": "unified_registry_v1",
            "candidate_strategy_count": len(candidates),
            "latest_factor_date": latest_factor_date.isoformat(),
        },
        "L1_strategy_labeler": {
            "strategy_count": len(candidates),
            "label_scope": "mined_strategy_affinity_family_affinity_weak_labels",
            "strategy_selection": selection,
            "diversity": _summarize_overlap(selection),
            "matrix_cells": route_telemetry.get("strategy_hit_matrix_cells"),
            "active_labeled_candidates": route_telemetry.get("active_labeled_candidates"),
        },
        "L1_25_finlab_portfolio_intelligence": {
            "output_scope": "strategy_prior_reliability_crowding_diversification",
            "metrics": l125_metrics,
        },
        "L1_5_router": {
            "policy": route_telemetry,
            "final_seed_count": len(route_rows),
            "final_seed_symbols": [row["symbol"] for row in route_rows],
            "top_rows": route_rows[:50],
        },
        "L2_3ml_coarse": {
            "input_count": len(payloads),
            "l2_predictions": _summarize_predictions(l2_predictions),
            "gate_summary": l2_gate.get("l2_core_ml_gate_summary"),
            "selected_symbols": l2_gate.get("l2_selected_symbols") or [],
        },
        "L3_6ml_formal": {
            "l3_payload_count": len(l2_gate.get("l3_payloads") or []),
            "l3_predictions": _summarize_predictions(dict(l3_result.get("l3_predictions") or {})),
            "merged_predictions": _summarize_predictions(merged_predictions),
            "prediction_dispersion": l3_result.get("prediction_dispersion"),
        },
        "L3_5_evidence_fusion": {
            "sell_filtered_symbols": recommend_result.get("sell_filtered_symbols") or [],
            "layer2_recommendation_symbols": recommend_result.get("layer2_recommendation_symbols") or [],
            "layer3_formal_gate_target_size": recommend_result.get("layer3_formal_gate_target_size"),
        },
        "L4_sparse_allocation": _summarize_final(final),
        "candidate_rows_used_as_screener_recs": [
            {
                "symbol": rec.get("symbol"),
                "stock_id": rec.get("stock_id"),
                "score": rec.get("score"),
                "candidate_route_score": rec.get("candidate_route_score"),
                "strategy_support_count": rec.get("strategy_support_count"),
                "strategy_support_weight": rec.get("strategy_support_weight"),
                "score_seed_inputs": rec.get("score_seed_inputs"),
            }
            for rec in screener_recs
        ],
    }


async def _run_l2_l4(
    *,
    run_date: str,
    screener_recs: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    if str(ML_CONTROLLER) not in sys.path:
        sys.path.insert(0, str(ML_CONTROLLER))

    _install_langgraph_import_shim()
    from graphs import daily_pipeline_v2 as pipeline
    from services.payload_builder import build_ml_universe, build_payloads, load_market_env

    market_env, adaptive_params, barrier_params, lifecycle_weights, trading_config = await asyncio.to_thread(load_market_env, run_date)
    active_stocks = build_ml_universe([], screener_recs)
    payload_objs = await asyncio.to_thread(
        build_payloads,
        active_stocks,
        market_env,
        adaptive_params,
        barrier_params,
        lifecycle_weights,
        trading_config,
    )
    payloads = [_patch for _patch in (_patch_payloads_with_strategy_evidence([asdict(obj) for obj in payload_objs], screener_recs))]
    state: dict[str, Any] = {
        "run_date": run_date,
        "producer_run_id": f"dryrun-pymoo-nsga3-novelty-{run_date}",
        "active_stocks": active_stocks,
        "screener_recs": screener_recs,
        "screener_run_id": f"dryrun-pymoo-nsga3-novelty-{run_date}",
        "market_env": asdict(market_env),
        "adaptive_params": adaptive_params,
        "barrier_params": barrier_params,
        "lifecycle_weights": lifecycle_weights,
        "trading_config": trading_config,
        "payloads": payloads,
        "persona_opinions": {},
        "errors": [],
    }

    l2_result = await pipeline.node_l2_cheap_ml_predict(state)
    state.update(l2_result)
    l2_gate = await pipeline.node_l2_core_gate(state)
    state.update(l2_gate)
    l3_result = await pipeline.node_l3_formal_predict(state)
    state.update(l3_result)
    recommend_result = await pipeline.node_recommend(state)
    return l2_result, l2_gate, l3_result, recommend_result, active_stocks, payloads


async def run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.time()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    alpha = _load_module(ALPHA_MINER, "stockvision_pymoo_l0_l4_alpha_miner")
    candidates = _load_confirm_candidates(Path(args.confirm_csv), args.candidate_id)
    if not candidates:
        raise RuntimeError("no_candidate_loaded")

    universe_args = argparse.Namespace(
        factor_json=args.factor_json,
        factor_universe="unified_registry_v1",
        feature_registry=args.feature_registry,
        start_date=args.factor_start_date,
        end_date=args.run_date,
        universe=args.universe,
        max_symbols=args.max_symbols,
    )
    close, tradable, values, meta, _universe_info = alpha._build_unified_registry_factor_universe(universe_args)
    latest = _latest_index(close.index, args.run_date)
    latest_tradable = tradable.reindex(index=close.index, columns=close.columns).loc[latest].fillna(False).astype(bool)
    l0_symbols = sorted(str(symbol) for symbol, flag in latest_tradable.items() if bool(flag))

    selection: dict[str, list[str]] = {}
    scores_by_strategy: dict[str, pd.Series] = {}
    strategy_hit_thresholds: dict[str, dict[str, Any]] = {}
    for row in candidates:
        cand = alpha.Candidate(
            candidate_id=str(row["id"]).replace("alpha_miner_", ""),
            algorithm=str(row["algorithm"]),
            factor_ids=list(row["factor_ids"]),
            weights=list(row["weights"]),
            combine=str(row["combine"] or "weighted_sum"),
        )
        score = alpha._candidate_score(cand, values, meta)
        if score is None:
            selection[str(row["id"])] = []
            scores_by_strategy[str(row["id"])] = pd.Series(dtype=float)
            continue
        if args.l1_mode == "topk_replay":
            position = alpha._position_from_score(score.loc[: args.run_date], args.top_k, tradable).loc[
                args.factor_start_date : args.run_date
            ]
            latest_for_candidate = latest if latest in position.index else _latest_index(position.index, args.run_date)
            symbols = _symbols_from_bool_row(position.loc[latest_for_candidate])
            selection[str(row["id"])] = symbols
            scores_by_strategy[str(row["id"])] = score.loc[latest_for_candidate]
            strategy_hit_thresholds[str(row["id"])] = {
                "mode": "topk_replay",
                "top_k": args.top_k,
                "hit_count": len(symbols),
            }
        else:
            latest_for_candidate = latest if latest in score.index else _latest_index(score.index, args.run_date)
            score_row = score.loc[latest_for_candidate].reindex(l0_symbols)
            symbols, threshold_detail = _full_market_hit_symbols(
                score_row,
                l0_symbols,
                min_quantile=args.strategy_hit_min_quantile,
                mad_multiplier=args.strategy_hit_mad_multiplier,
                min_score=args.strategy_hit_min_score,
            )
            selection[str(row["id"])] = symbols
            scores_by_strategy[str(row["id"])] = score_row
            strategy_hit_thresholds[str(row["id"])] = {
                "mode": "full_market_affinity_adaptive_hit",
                **threshold_detail,
            }

    l125_metrics = _build_l125_metrics(candidates, selection)
    route_rows, route_telemetry = _build_route_rows(
        candidates=candidates,
        scores_by_strategy=scores_by_strategy,
        selection=selection,
        l125_metrics=l125_metrics,
        universe_symbols=l0_symbols if args.l1_mode == "full_affinity" else None,
        route_min_quantile=args.route_min_quantile,
        route_mad_multiplier=args.route_mad_multiplier,
        route_min_score=args.route_min_score,
        apply_route_floor=args.l1_mode == "full_affinity",
        selection_policy=(
            "full_market_affinity_adaptive_quality_floor_no_top_k"
            if args.l1_mode == "full_affinity"
            else "union_of_mined_strategy_hits_sorted_by_route_score_no_top_up"
        ),
    )
    route_telemetry["l1_mode"] = args.l1_mode
    route_telemetry["l0_tradable_symbols"] = len(l0_symbols)
    route_telemetry["strategy_hit_thresholds"] = strategy_hit_thresholds
    stock_meta = _load_stock_metadata([row["symbol"] for row in route_rows])
    screener_recs = _build_screener_recs(route_rows=route_rows, stock_meta_by_symbol=stock_meta, run_date=args.run_date)
    if not screener_recs:
        raise RuntimeError("no_screener_recs_after_stock_metadata_join")

    l2_result, l2_gate, l3_result, recommend_result, _active_stocks, payloads = await _run_l2_l4(
        run_date=args.run_date,
        screener_recs=screener_recs,
    )

    report = _build_layer_report(
        run_date=args.run_date,
        latest_factor_date=latest,
        candidates=candidates,
        selection=selection,
        route_rows=route_rows,
        l125_metrics=l125_metrics,
        route_telemetry=route_telemetry,
        l2_result=l2_result,
        l2_gate=l2_gate,
        l3_result=l3_result,
        recommend_result=recommend_result,
        screener_recs=screener_recs,
        payloads=payloads,
    )
    report["L0_universe_features"]["l0_tradable_symbols"] = len(l0_symbols)
    report["L0_universe_features"]["l1_mode"] = args.l1_mode
    report["runtime_sec"] = round(time.time() - started, 3)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-date", default="2026-06-17")
    parser.add_argument("--factor-start-date", default="2023-01-01")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--l1-mode", choices=["full_affinity", "topk_replay"], default="full_affinity")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--strategy-hit-min-quantile", type=float, default=0.88)
    parser.add_argument("--strategy-hit-mad-multiplier", type=float, default=1.0)
    parser.add_argument("--strategy-hit-min-score", type=float, default=0.0)
    parser.add_argument("--route-min-quantile", type=float, default=0.88)
    parser.add_argument("--route-mad-multiplier", type=float, default=1.0)
    parser.add_argument("--route-min-score", type=float, default=0.0)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--confirm-csv", default=str(DEFAULT_CONFIRM_CSV))
    parser.add_argument(
        "--candidate-id",
        action="append",
        default=[],
        help="alpha_miner_* id. Defaults to representative 0081/0193/0187.",
    )
    parser.add_argument(
        "--factor-json",
        default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"),
    )
    parser.add_argument("--feature-registry", default=str(ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "pymoo_l0_l4_dry_run_compare"))
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.candidate_id:
        args.candidate_id = REPRESENTATIVE_CANDIDATE_IDS
    report = asyncio.run(run(args))
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"pymoo_l0_l4_dry_run_compare_{args.l1_mode}_{args.run_date.replace('-', '')}"
    json_path = out_dir / f"{stem}.json"
    summary_path = out_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    compact = {
        "json": str(json_path),
        "run_date_requested": report.get("run_date_requested"),
        "latest_factor_date": report.get("latest_factor_date"),
        "L1": {
            "strategy_count": report["L1_strategy_labeler"]["strategy_count"],
            "active_labeled_candidates": report["L1_strategy_labeler"]["active_labeled_candidates"],
            "matrix_cells": report["L1_strategy_labeler"].get("matrix_cells"),
            "diversity": {
                key: report["L1_strategy_labeler"]["diversity"].get(key)
                for key in ("unique_symbol_count", "avg_pairwise_jaccard", "max_pairwise_jaccard")
            },
        },
        "L1_25": {
            sid: {
                "strategy_prior_weight": metric.get("strategy_prior_weight"),
                "strategy_reliability": metric.get("strategy_reliability"),
                "strategy_crowding_score": metric.get("strategy_crowding_score"),
                "strategy_diversification_value": metric.get("strategy_diversification_value"),
                "latest_match_count": metric.get("latest_match_count"),
            }
            for sid, metric in report["L1_25_finlab_portfolio_intelligence"]["metrics"].items()
        },
        "L1_5": {
            "policy": report["L1_5_router"]["policy"],
            "final_seed_count": report["L1_5_router"]["final_seed_count"],
            "final_seed_symbols": report["L1_5_router"]["final_seed_symbols"],
        },
        "L2": report["L2_3ml_coarse"]["gate_summary"],
        "L3": {
            "l3_payload_count": report["L3_6ml_formal"]["l3_payload_count"],
            "l3_prediction_count": report["L3_6ml_formal"]["l3_predictions"]["count"],
        },
        "L4": {
            "kept_count": report["L4_sparse_allocation"]["kept_count"],
            "buy_signal_count": report["L4_sparse_allocation"]["buy_signal_count"],
            "sparse_selected_count": report["L4_sparse_allocation"]["sparse_selected_count"],
            "sparse_selected_symbols": report["L4_sparse_allocation"]["sparse_selected_symbols"],
        },
    }
    summary_path.write_text(json.dumps(compact, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(compact, ensure_ascii=False, indent=2, default=_json_default))


if __name__ == "__main__":
    main()
