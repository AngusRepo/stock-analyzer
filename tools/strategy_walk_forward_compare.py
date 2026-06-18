from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
DEFAULT_MINED_DIR = ROOT / "output" / "pymoo_l0_l4_dry_run_compare"
DEFAULT_STRATEGY_BACKTEST_DIR = ROOT / "output" / "finlab_strategy_backtests"
DEFAULT_STRATEGY_BACKTEST_FALLBACK = DEFAULT_STRATEGY_BACKTEST_DIR / "finlab_strategy_spec_current_20230101_20260615.json"
DEFAULT_MINED_CONFIRM = (
    ROOT
    / "output"
    / "finlab_alpha_miner_canonical114_mresample"
    / "alpha_miner_bakeoff_canonical114_pymoo_sii_20230101_20260615_seed42_finlab_confirm.csv"
)


def _rel(path: Path | str) -> str:
    resolved = Path(path)
    try:
        return resolved.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _default_current_strategy_backtest() -> str:
    candidates = sorted(
        DEFAULT_STRATEGY_BACKTEST_DIR.glob("finlab_strategy_spec_active*_20230101_20260615.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return str(candidates[0] if candidates else DEFAULT_STRATEGY_BACKTEST_FALLBACK)


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, set):
        return sorted(value)
    return str(value)


def _safe_json(raw: Any) -> dict[str, Any]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(str(raw))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _safe_float(value: Any, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _pairwise_overlap(selection: dict[str, list[str]]) -> list[dict[str, Any]]:
    ids = sorted(selection)
    rows: list[dict[str, Any]] = []
    for i, left_id in enumerate(ids):
        left = set(selection[left_id])
        for right_id in ids[i + 1 :]:
            right = set(selection[right_id])
            union = left | right
            inter = left & right
            rows.append(
                {
                    "left": left_id,
                    "right": right_id,
                    "left_count": len(left),
                    "right_count": len(right),
                    "intersection": len(inter),
                    "union": len(union),
                    "jaccard": round(len(inter) / len(union), 6) if union else None,
                }
            )
    return rows


def _summarize_overlap(selection: dict[str, list[str]]) -> dict[str, Any]:
    pairwise = _pairwise_overlap({key: value for key, value in selection.items() if value})
    jaccards = [float(row["jaccard"]) for row in pairwise if row.get("jaccard") is not None]
    all_symbols: set[str] = set()
    for symbols in selection.values():
        all_symbols.update(symbols)
    return {
        "strategy_count": len(selection),
        "non_empty_strategy_count": sum(1 for symbols in selection.values() if symbols),
        "unique_symbol_count": len(all_symbols),
        "avg_pairwise_jaccard": round(float(np.mean(jaccards)), 6) if jaccards else None,
        "max_pairwise_jaccard": round(float(np.max(jaccards)), 6) if jaccards else None,
        "top_pairwise": sorted(pairwise, key=lambda row: float(row.get("jaccard") or 0), reverse=True)[:10],
    }


def _jaccard(left: list[str] | set[str], right: list[str] | set[str]) -> float | None:
    lset = set(left)
    rset = set(right)
    union = lset | rset
    if not union:
        return None
    return round(len(lset & rset) / len(union), 6)


def _load_mined_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _mined_path_for_date(output_dir: Path, date: str) -> Path:
    return output_dir / f"pymoo_l0_l4_dry_run_compare_full_affinity_{date.replace('-', '')}.json"


def _existing_compare_path(output_dir: Path, dates: list[str]) -> Path:
    stem = "strategy_walk_forward_compare_" + "_".join(date.replace("-", "") for date in dates)
    return output_dir / f"{stem}.json"


def _load_existing_current_strategy_rows(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not path.exists():
        return [], {
            "status": "missing_existing_report",
            "source": "existing_report_reuse",
            "path": _rel(path),
        }
    report = json.loads(path.read_text(encoding="utf-8"))
    section = report.get("current_strategy_benchmark") or {}
    rows: list[dict[str, Any]] = []
    for row in section.get("rows") or []:
        if not isinstance(row, dict):
            continue
        normalized = dict(row)
        normalized["source"] = "current_strategy_production"
        rows.append(normalized)
    return rows, {
        "status": "reused_existing_report",
        "source": "existing_report_reuse",
        "path": _rel(path),
        "row_count": len(rows),
        "reason": "D1 client env is unavailable in local closure context",
    }


def _mined_metrics(report: dict[str, Any]) -> dict[str, Any]:
    l1 = report.get("L1_strategy_labeler") or {}
    l15 = report.get("L1_5_router") or {}
    l2 = report.get("L2_3ml_coarse") or {}
    l3 = report.get("L3_6ml_formal") or {}
    l35 = report.get("L3_5_evidence_fusion") or {}
    l4 = report.get("L4_sparse_allocation") or {}
    gate = l2.get("gate_summary") or {}
    l1_seed = int(l15.get("final_seed_count") or 0)
    l2_selected = int(gate.get("selected_count") or len(l2.get("selected_symbols") or []))
    l3_payload = int(l3.get("l3_payload_count") or 0)
    l3_pass = int(l35.get("layer3_formal_gate_target_size") or l4.get("kept_count") or 0)
    l4_kept = int(l4.get("kept_count") or 0)
    buys = [str(symbol) for symbol in (l4.get("sparse_selected_symbols") or l4.get("buy_symbols") or [])]
    return {
        "date": report.get("run_date_requested"),
        "source": "mined3_dry_run",
        "l0_count": (report.get("L0_universe_features") or {}).get("l0_tradable_symbols"),
        "strategy_count": l1.get("strategy_count"),
        "l1_active_labeled_candidates": l1.get("active_labeled_candidates"),
        "l1_matrix_cells": l1.get("matrix_cells"),
        "l1_hit_union": (l1.get("diversity") or {}).get("unique_symbol_count"),
        "l1_diversity": l1.get("diversity"),
        "l15_seed_count": l1_seed,
        "l15_seed_symbols": [str(symbol) for symbol in (l15.get("final_seed_symbols") or [])],
        "l2_selected_count": l2_selected,
        "l2_retention": round(l2_selected / l1_seed, 6) if l1_seed else None,
        "l3_payload_count": l3_payload,
        "l3_pass_count": l3_pass,
        "l3_retention": round(l3_pass / l2_selected, 6) if l2_selected else None,
        "l4_kept_count": l4_kept,
        "l4_buy_count": len(buys),
        "l4_buy_symbols": buys,
        "l4_buy_jaccard_vs_prev": None,
    }


def _ensure_d1_client() -> Any:
    if str(ML_CONTROLLER) not in sys.path:
        sys.path.insert(0, str(ML_CONTROLLER))
    from services import d1_client

    return d1_client


def _latest_run_for_date(d1_client: Any, date: str) -> dict[str, Any] | None:
    rows = d1_client.query(
        """
        SELECT run_id, date, status, universe_count, candidate_count, final_count, created_at
          FROM screener_funnel_runs
         WHERE date = ?
           AND status = 'success'
         ORDER BY created_at DESC
         LIMIT 1
        """,
        [date],
    )
    return dict(rows[0]) if rows else None


def _production_stage_counts(d1_client: Any, run_id: str) -> dict[str, dict[str, int]]:
    rows = d1_client.query(
        """
        SELECT stage, decision, COUNT(*) AS n
          FROM screener_funnel_items
         WHERE run_id = ?
         GROUP BY stage, decision
        """,
        [run_id],
        timeout=120.0,
    )
    out: dict[str, dict[str, int]] = {}
    for row in rows:
        stage = str(row.get("stage") or "")
        decision = str(row.get("decision") or "")
        out.setdefault(stage, {})[decision] = int(row.get("n") or 0)
    return out


def _production_l15_rows(d1_client: Any, run_id: str) -> list[dict[str, Any]]:
    return d1_client.query(
        """
        SELECT symbol, rank, score_after, evidence
          FROM screener_funnel_items
         WHERE run_id = ?
           AND stage = 'l1_candidate_seed_after_overlay'
           AND decision = 'selected'
         ORDER BY COALESCE(rank, 999999), COALESCE(score_after, 0) DESC
        """,
        [run_id],
        timeout=120.0,
    )


def _production_l3_rows(d1_client: Any, run_id: str) -> list[dict[str, Any]]:
    return d1_client.query(
        """
        SELECT symbol, decision, rank, evidence
          FROM screener_funnel_items
         WHERE run_id = ?
           AND stage = 'layer3_formal_ml_gate'
        """,
        [run_id],
        timeout=120.0,
    )


def _production_recommendation_rows(d1_client: Any, date: str) -> list[dict[str, Any]]:
    return d1_client.query(
        """
        SELECT symbol, rank, signal, confidence, has_buy_signal, alpha_allocation
          FROM daily_recommendations
         WHERE date = ?
         ORDER BY COALESCE(rank, 999999), score DESC
        """,
        [date],
        timeout=120.0,
    )


def _production_metrics(d1_client: Any, date: str) -> dict[str, Any]:
    run = _latest_run_for_date(d1_client, date)
    if not run:
        return {
            "date": date,
            "source": "current_strategy_production",
            "status": "missing_screener_run",
        }
    run_id = str(run["run_id"])
    stage_counts = _production_stage_counts(d1_client, run_id)
    l15_rows = _production_l15_rows(d1_client, run_id)
    l3_rows = _production_l3_rows(d1_client, run_id)
    rec_rows = _production_recommendation_rows(d1_client, date)

    strategy_selection: dict[str, list[str]] = {}
    family_selection: dict[str, list[str]] = {}
    l15_symbols: list[str] = []
    vector_coverage = 0
    for row in l15_rows:
        symbol = str(row.get("symbol") or "")
        if not symbol:
            continue
        l15_symbols.append(symbol)
        evidence = _safe_json(row.get("evidence"))
        strategy_ids = evidence.get("strategy_pool_ids") or []
        family_ids = evidence.get("strategy_family_ids") or []
        if isinstance(evidence.get("strategy_hit_vector"), dict):
            vector_coverage += 1
        for sid in strategy_ids:
            strategy_selection.setdefault(str(sid), []).append(symbol)
        for family_id in family_ids:
            family_selection.setdefault(str(family_id), []).append(symbol)

    l3_pass_symbols = [str(row.get("symbol")) for row in l3_rows if str(row.get("decision")) == "pass"]
    l3_drop_symbols = [str(row.get("symbol")) for row in l3_rows if str(row.get("decision")) == "drop"]
    l2_count_candidates: list[int] = []
    for row in l3_rows:
        evidence = _safe_json(row.get("evidence"))
        layer2_count = _safe_float(evidence.get("layer2_count"))
        if layer2_count is not None:
            l2_count_candidates.append(int(layer2_count))
    l2_selected = max(l2_count_candidates) if l2_count_candidates else (
        stage_counts.get("layer2_coarse_ml_gate", {}).get("pass")
        or stage_counts.get("layer2_coarse_ml_gate", {}).get("observe")
        or len(l3_pass_symbols) + len(l3_drop_symbols)
    )

    allocation_rows = []
    sparse_buy_symbols: list[str] = []
    for row in rec_rows:
        alloc = _safe_json(row.get("alpha_allocation"))
        if alloc:
            allocation_rows.append(row)
        if int(row.get("has_buy_signal") or 0) == 1 or alloc.get("selected") is True:
            sparse_buy_symbols.append(str(row.get("symbol")))

    l1_seed = len(l15_symbols)
    return {
        "date": date,
        "source": "current_strategy_production",
        "status": "ok",
        "run_id": run_id,
        "created_at": run.get("created_at"),
        "l0_count": run.get("universe_count"),
        "strategy_count": None,
        "l1_active_labeled_candidates": run.get("candidate_count"),
        "l1_matrix_cells": None,
        "stage_counts": stage_counts,
        "l15_seed_count": l1_seed,
        "l15_seed_symbols": l15_symbols,
        "l15_strategy_id_diversity": _summarize_overlap(strategy_selection),
        "l15_family_diversity": _summarize_overlap(family_selection),
        "l15_strategy_vector_coverage": {
            "with_strategy_hit_vector": vector_coverage,
            "rows": l1_seed,
            "coverage": round(vector_coverage / l1_seed, 6) if l1_seed else None,
        },
        "l2_selected_count": l2_selected,
        "l2_retention": round(l2_selected / l1_seed, 6) if l1_seed else None,
        "l3_payload_count": len(l3_rows),
        "l3_pass_count": len(l3_pass_symbols),
        "l3_retention": round(len(l3_pass_symbols) / l2_selected, 6) if l2_selected else None,
        "l4_kept_count": len(allocation_rows),
        "l4_buy_count": len(sorted(set(sparse_buy_symbols))),
        "l4_buy_symbols": sorted(set(sparse_buy_symbols)),
        "l4_buy_jaccard_vs_prev": None,
    }


def _load_current_strategy_backtest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"status": "missing", "path": _rel(path)}
    report = json.loads(path.read_text(encoding="utf-8"))
    rows = [row for row in report.get("results") or [] if row.get("status") == "ok"]
    sharpes = [_safe_float(row.get("monthly_sharpe")) for row in rows]
    cagrs = [_safe_float(row.get("cagr")) for row in rows]
    drawdowns = [abs(_safe_float(row.get("max_drawdown"), 0.0) or 0.0) for row in rows]
    latest_matches = [_safe_float(row.get("latest_matches")) for row in rows]
    config = report.get("config") if isinstance(report.get("config"), dict) else {}
    strategy_count = config.get("strategy_count")
    return {
        "status": "ok",
        "path": _rel(path),
        "strategy_count": strategy_count,
        "ok": len(rows),
        "avg_monthly_sharpe": round(statistics.mean([x for x in sharpes if x is not None]), 6) if sharpes else None,
        "median_monthly_sharpe": round(statistics.median([x for x in sharpes if x is not None]), 6) if sharpes else None,
        "avg_cagr": round(statistics.mean([x for x in cagrs if x is not None]), 6) if cagrs else None,
        "avg_abs_max_drawdown": round(statistics.mean(drawdowns), 6) if drawdowns else None,
        "avg_latest_matches": round(statistics.mean([x for x in latest_matches if x is not None]), 6) if latest_matches else None,
        "scope_note": (
            "Backtest scope is read from the selected FinLab strategy-spec artifact; "
            "it is not assumed to equal the current production strategy registry count."
        ),
    }


def _load_mined_backtest(confirm_csv: Path) -> dict[str, Any]:
    import csv

    if not confirm_csv.exists():
        return {"status": "missing", "path": _rel(confirm_csv)}
    wanted = {
        "alpha_miner_pymoo_nsga3_novelty_0081",
        "alpha_miner_pymoo_nsga3_novelty_0193",
        "alpha_miner_pymoo_nsga3_novelty_0187",
    }
    rows: list[dict[str, Any]] = []
    with confirm_csv.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("id") in wanted:
                rows.append(row)
    sharpes = [_safe_float(row.get("monthly_sharpe")) for row in rows]
    cagrs = [_safe_float(row.get("cagr")) for row in rows]
    drawdowns = [abs(_safe_float(row.get("max_drawdown"), 0.0) or 0.0) for row in rows]
    latest_matches = [_safe_float(row.get("latest_matches")) for row in rows]
    return {
        "status": "ok",
        "path": _rel(confirm_csv),
        "strategy_count": len(rows),
        "avg_monthly_sharpe": round(statistics.mean([x for x in sharpes if x is not None]), 6) if sharpes else None,
        "median_monthly_sharpe": round(statistics.median([x for x in sharpes if x is not None]), 6) if sharpes else None,
        "avg_cagr": round(statistics.mean([x for x in cagrs if x is not None]), 6) if cagrs else None,
        "avg_abs_max_drawdown": round(statistics.mean(drawdowns), 6) if drawdowns else None,
        "avg_latest_matches": round(statistics.mean([x for x in latest_matches if x is not None]), 6) if latest_matches else None,
        "rows": [
            {
                "id": row.get("id"),
                "cagr": _safe_float(row.get("cagr")),
                "monthly_sharpe": _safe_float(row.get("monthly_sharpe")),
                "max_drawdown": _safe_float(row.get("max_drawdown")),
                "latest_matches": _safe_float(row.get("latest_matches")),
            }
            for row in rows
        ],
    }


def _apply_stability(rows: list[dict[str, Any]]) -> dict[str, Any]:
    previous: set[str] | None = None
    frequency: dict[str, int] = {}
    jaccards: list[float] = []
    for row in rows:
        buys = set(str(symbol) for symbol in row.get("l4_buy_symbols") or [])
        for symbol in buys:
            frequency[symbol] = frequency.get(symbol, 0) + 1
        if previous is not None:
            j = _jaccard(previous, buys)
            row["l4_buy_jaccard_vs_prev"] = j
            if j is not None:
                jaccards.append(j)
        previous = buys
    return {
        "buy_symbol_frequency": dict(sorted(frequency.items(), key=lambda item: (-item[1], item[0]))),
        "avg_consecutive_buy_jaccard": round(float(np.mean(jaccards)), 6) if jaccards else None,
    }


def _backtest_bias_summary(backtest: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {}
    avg_l15 = statistics.mean([float(row.get("l15_seed_count") or 0) for row in rows])
    avg_l4_buy = statistics.mean([float(row.get("l4_buy_count") or 0) for row in rows])
    avg_latest_matches = _safe_float(backtest.get("avg_latest_matches"))
    return {
        "backtest_avg_latest_matches": avg_latest_matches,
        "walk_forward_avg_l15_seed_count": round(avg_l15, 6),
        "walk_forward_avg_l4_buy_count": round(avg_l4_buy, 6),
        "l15_vs_backtest_latest_match_ratio": (
            round(avg_l15 / avg_latest_matches, 6)
            if avg_latest_matches and avg_latest_matches > 0
            else None
        ),
        "buy_vs_backtest_latest_match_ratio": (
            round(avg_l4_buy / avg_latest_matches, 6)
            if avg_latest_matches and avg_latest_matches > 0
            else None
        ),
        "interpretation": (
            "ratio_above_1_means_runtime_pipeline_is_broader_than_backtest_latest_holdings; "
            "ratio_below_1_means_runtime_pipeline_is_tighter_than_backtest_latest_holdings"
        ),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    mined_rows: list[dict[str, Any]] = []
    missing_mined: list[str] = []
    for date in args.date:
        path = _mined_path_for_date(Path(args.mined_output_dir), date)
        if not path.exists():
            missing_mined.append(_rel(path))
            continue
        mined_rows.append(_mined_metrics(_load_mined_report(path)))

    production_evidence: dict[str, Any] = {
        "status": "queried_d1",
        "source": "d1_client",
    }
    try:
        d1_client = _ensure_d1_client()
        current_strategy_rows = [_production_metrics(d1_client, date) for date in args.date]
        current_strategy_rows = [row for row in current_strategy_rows if row.get("status") == "ok"]
        production_evidence["row_count"] = len(current_strategy_rows)
    except RuntimeError as exc:
        message = str(exc)
        if "Missing env vars for D1 client" not in message:
            raise
        current_strategy_rows, production_evidence = _load_existing_current_strategy_rows(
            Path(args.existing_report_json)
            if args.existing_report_json
            else _existing_compare_path(Path(args.output_dir), args.date)
        )

    mined_stability = _apply_stability(mined_rows)
    current_strategy_stability = _apply_stability(current_strategy_rows)
    mined_backtest = _load_mined_backtest(Path(args.mined_confirm_csv))
    current_strategy_backtest = _load_current_strategy_backtest(Path(args.current_strategy_backtest_json))

    return {
        "schema_version": "stockvision-strategy-walk-forward-compare-v1",
        "allowed_use": "research_only",
        "decision_effect": "none_no_d1_kv_write",
        "dates_requested": args.date,
        "missing_mined_dry_run_reports": missing_mined,
        "production_evidence": production_evidence,
        "metric_definitions": {
            "l2_retention": "L2 core selected / L1.5 seed count",
            "l3_retention": "L3 formal pass / L2 core selected",
            "l4_kept_count": "rows with alpha_allocation in daily_recommendations for production; kept_count in dry-run for mined3",
            "l4_buy_stability": "consecutive-date Jaccard and symbol frequency over sparse selected BUY symbols",
            "backtest_bias": "walk-forward average slate or BUY count divided by FinLab latest_matches baseline",
        },
        "mined3": {
            "rows": mined_rows,
            "stability": mined_stability,
            "backtest": mined_backtest,
            "backtest_bias": _backtest_bias_summary(mined_backtest, mined_rows),
        },
        "current_strategy_benchmark": {
            "rows": current_strategy_rows,
            "stability": current_strategy_stability,
            "backtest": current_strategy_backtest,
            "backtest_bias": _backtest_bias_summary(current_strategy_backtest, current_strategy_rows),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare mined3 dry-run against current strategy production evidence over multiple dates.")
    parser.add_argument("--date", action="append", required=True, help="YYYY-MM-DD. Repeat for walk-forward dates.")
    parser.add_argument("--mined-output-dir", default=str(DEFAULT_MINED_DIR))
    parser.add_argument("--mined-confirm-csv", default=str(DEFAULT_MINED_CONFIRM))
    parser.add_argument("--current-strategy-backtest-json", default=_default_current_strategy_backtest())
    parser.add_argument("--existing-report-json", default=None, help="Optional prior compare report used only when D1 env is unavailable.")
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "strategy_walk_forward_compare"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = run(args)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = "strategy_walk_forward_compare_" + "_".join(date.replace("-", "") for date in args.date)
    json_path = out_dir / f"{stem}.json"
    summary_path = out_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    compact = {
        "json": _rel(json_path),
        "dates_requested": report["dates_requested"],
        "missing_mined_dry_run_reports": report["missing_mined_dry_run_reports"],
        "production_evidence": report["production_evidence"],
        "mined3": {
            "rows": [
                {
                    "date": row.get("date"),
                    "l15_seed_count": row.get("l15_seed_count"),
                    "l2_retention": row.get("l2_retention"),
                    "l3_retention": row.get("l3_retention"),
                    "l4_buy_count": row.get("l4_buy_count"),
                    "l4_buy_symbols": row.get("l4_buy_symbols"),
                    "l1_avg_pairwise_jaccard": (row.get("l1_diversity") or {}).get("avg_pairwise_jaccard"),
                    "l1_max_pairwise_jaccard": (row.get("l1_diversity") or {}).get("max_pairwise_jaccard"),
                }
                for row in report["mined3"]["rows"]
            ],
            "stability": report["mined3"]["stability"],
            "backtest_bias": report["mined3"]["backtest_bias"],
        },
        "current_strategy_benchmark": {
            "rows": [
                {
                    "date": row.get("date"),
                    "run_id": row.get("run_id"),
                    "l15_seed_count": row.get("l15_seed_count"),
                    "l2_retention": row.get("l2_retention"),
                    "l3_retention": row.get("l3_retention"),
                    "l4_buy_count": row.get("l4_buy_count"),
                    "l4_buy_symbols": row.get("l4_buy_symbols"),
                    "l15_strategy_avg_pairwise_jaccard": (row.get("l15_strategy_id_diversity") or {}).get("avg_pairwise_jaccard"),
                    "l15_strategy_max_pairwise_jaccard": (row.get("l15_strategy_id_diversity") or {}).get("max_pairwise_jaccard"),
                    "l15_family_avg_pairwise_jaccard": (row.get("l15_family_diversity") or {}).get("avg_pairwise_jaccard"),
                    "l15_family_max_pairwise_jaccard": (row.get("l15_family_diversity") or {}).get("max_pairwise_jaccard"),
                    "strategy_vector_coverage": row.get("l15_strategy_vector_coverage"),
                }
                for row in report["current_strategy_benchmark"]["rows"]
            ],
            "stability": report["current_strategy_benchmark"]["stability"],
            "backtest": report["current_strategy_benchmark"]["backtest"],
            "backtest_bias": report["current_strategy_benchmark"]["backtest_bias"],
        },
    }
    summary_path.write_text(json.dumps(compact, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(compact, ensure_ascii=False, indent=2, default=_json_default))


if __name__ == "__main__":
    main()
