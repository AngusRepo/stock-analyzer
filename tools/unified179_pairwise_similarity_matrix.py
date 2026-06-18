from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OVERLAP_RUNNER = ROOT / "tools" / "feature_strategy_overlap_numeric.py"
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
BACKTEST_REPORT = ROOT / "output" / "feature_universe_triage" / "unified179_feature_backtest_report_20260617.csv"
OUT_DIR = ROOT / "output" / "feature_universe_triage"


def _rel(path: Path | str) -> str:
    resolved = Path(path)
    try:
        return resolved.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _num(value: Any, default: float | None = None) -> float | None:
    if value in (None, ""):
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _round(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(float(value), digits)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write_csv(rows: list[dict[str, Any]], path: Path, *, fields: list[str] | None = None) -> None:
    fields = fields or (list(rows[0].keys()) if rows else [])
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _load_active_features(path: Path) -> list[dict[str, Any]]:
    registry = json.loads(path.read_text(encoding="utf-8"))
    active = [
        row
        for row in registry.get("features", [])
        if row.get("eligible_for_alpha_mining")
        and row.get("origin_pool") in {"strategy95", "ml106"}
    ]
    active.sort(key=lambda row: (str(row.get("origin_pool")), str(row.get("category")), str(row.get("feature_id"))))
    return active


def _load_backtest_metrics(path: Path) -> dict[str, dict[str, Any]]:
    return {row["feature_id"]: row for row in _read_csv(path)}


def _quality_score(metric: dict[str, Any] | None) -> float:
    if not metric:
        return 0.0
    sharpe = _num(metric.get("monthly_sharpe"), 0.0) or 0.0
    cagr = _num(metric.get("cagr"), 0.0) or 0.0
    mdd = abs(_num(metric.get("max_drawdown"), 0.35) or 0.35)
    abs_ic = abs(_num(metric.get("mean_ic_5d"), 0.0) or 0.0)
    coverage = _num(metric.get("coverage"), 0.0) or 0.0
    sharpe_score = max(0.0, min(1.0, (sharpe + 0.25) / 1.75))
    cagr_score = max(0.0, min(1.0, (cagr + 0.05) / 0.55))
    mdd_score = max(0.0, min(1.0, 1.0 - max(0.0, mdd - 0.10) / 0.35))
    ic_score = max(0.0, min(1.0, abs_ic / 0.04))
    coverage_score = max(0.0, min(1.0, coverage))
    return round(
        sharpe_score * 0.30
        + cagr_score * 0.25
        + mdd_score * 0.20
        + ic_score * 0.15
        + coverage_score * 0.10,
        6,
    )


def _union_find(nodes: list[str], pairs: list[dict[str, Any]], threshold: float) -> list[list[str]]:
    parent = {node: node for node in nodes}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for row in pairs:
        corr = _num(row.get("abs_rank_corr"), 0.0) or 0.0
        if corr >= threshold:
            union(str(row["feature_a"]), str(row["feature_b"]))

    groups: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        groups[find(node)].append(node)
    return sorted((sorted(v) for v in groups.values()), key=lambda group: (-len(group), group[0]))


def _component_rows(
    groups: list[list[str]],
    metrics: dict[str, dict[str, Any]],
    meta: dict[str, dict[str, Any]],
    *,
    threshold: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for idx, group in enumerate(groups, start=1):
        if len(group) < 2:
            continue
        scored = sorted(group, key=lambda fid: _quality_score(metrics.get(fid)), reverse=True)
        leader = scored[0]
        for rank, fid in enumerate(scored, start=1):
            metric = metrics.get(fid) or {}
            rows.append({
                "threshold": threshold,
                "component_id": idx,
                "component_size": len(group),
                "component_rank": rank,
                "feature_id": fid,
                "leader_feature_id": leader,
                "origin_pool": meta[fid].get("origin_pool"),
                "category": meta[fid].get("category"),
                "quality_score": _quality_score(metric),
                "monthly_sharpe": _num(metric.get("monthly_sharpe")),
                "cagr": _num(metric.get("cagr")),
                "max_drawdown": _num(metric.get("max_drawdown")),
                "mean_ic_5d": _num(metric.get("mean_ic_5d")),
                "coverage": _num(metric.get("coverage")),
            })
    return rows


def _prune_candidates(
    pairs: list[dict[str, Any]],
    metrics: dict[str, dict[str, Any]],
    meta: dict[str, dict[str, Any]],
    components_075: list[list[str]],
) -> list[dict[str, Any]]:
    strongest: dict[str, dict[str, Any]] = {}
    for row in pairs:
        corr = _num(row.get("abs_rank_corr"), 0.0) or 0.0
        for side, peer_side in (("feature_a", "feature_b"), ("feature_b", "feature_a")):
            fid = str(row[side])
            if fid not in strongest or corr > (_num(strongest[fid].get("abs_rank_corr"), 0.0) or 0.0):
                strongest[fid] = {
                    "nearest_feature": row[peer_side],
                    "abs_rank_corr": corr,
                    "rank_corr": _num(row.get("rank_corr")),
                }

    component_by_feature: dict[str, list[str]] = {}
    for group in components_075:
        for fid in group:
            component_by_feature[fid] = group

    rows: list[dict[str, Any]] = []
    for fid, metric in metrics.items():
        if fid not in meta:
            continue
        sharpe = _num(metric.get("monthly_sharpe"))
        cagr = _num(metric.get("cagr"))
        mdd = _num(metric.get("max_drawdown"))
        ic = _num(metric.get("mean_ic_5d"))
        coverage = _num(metric.get("coverage"))
        q = _quality_score(metric)
        nearest = strongest.get(fid, {})
        nearest_corr = _num(nearest.get("abs_rank_corr"), 0.0) or 0.0
        group = component_by_feature.get(fid, [fid])
        leader = max(group, key=lambda item: _quality_score(metrics.get(item)))
        leader_score = _quality_score(metrics.get(leader))

        reasons: list[str] = []
        action = "keep"
        if coverage is not None and coverage < 0.60:
            reasons.append("low_coverage_lt_60pct")
        if sharpe is not None and cagr is not None and sharpe < 0 and cagr < 0:
            reasons.append("negative_sharpe_and_cagr")
        if ic is None and sharpe is not None and sharpe < 0:
            reasons.append("missing_ic_negative_backtest")
        if ic is not None and abs(ic) < 0.005 and sharpe is not None and sharpe < 0.15:
            reasons.append("weak_ic_and_weak_backtest")
        if nearest_corr >= 0.75 and fid != leader and q + 0.08 < leader_score:
            reasons.append("duplicate_cluster_weaker_than_leader")

        if "duplicate_cluster_weaker_than_leader" in reasons and (
            "negative_sharpe_and_cagr" in reasons
            or "missing_ic_negative_backtest" in reasons
            or "weak_ic_and_weak_backtest" in reasons
            or "low_coverage_lt_60pct" in reasons
        ):
            action = "drop_research_candidate"
        elif "negative_sharpe_and_cagr" in reasons and ("missing_ic_negative_backtest" in reasons or "weak_ic_and_weak_backtest" in reasons):
            action = "drop_research_candidate"
        elif reasons:
            action = "watch_not_selector"

        if action == "keep":
            continue
        rows.append({
            "feature_id": fid,
            "origin_pool": meta[fid].get("origin_pool"),
            "category": meta[fid].get("category"),
            "action": action,
            "reasons": ",".join(reasons),
            "quality_score": q,
            "monthly_sharpe": sharpe,
            "cagr": cagr,
            "max_drawdown": mdd,
            "mean_ic_5d": ic,
            "coverage": coverage,
            "nearest_feature": nearest.get("nearest_feature"),
            "nearest_abs_rank_corr": nearest_corr,
            "component_075_size": len(group),
            "component_leader": leader,
            "component_leader_score": leader_score,
        })
    rows.sort(key=lambda row: (row["action"], row["quality_score"], -(row["nearest_abs_rank_corr"] or 0.0)))
    return rows


def _write_square_matrix(feature_ids: list[str], pairs: list[dict[str, Any]], path: Path) -> None:
    matrix: dict[tuple[str, str], float] = {}
    for fid in feature_ids:
        matrix[(fid, fid)] = 1.0
    for row in pairs:
        a = str(row["feature_a"])
        b = str(row["feature_b"])
        corr = _num(row.get("rank_corr"))
        if corr is None:
            continue
        matrix[(a, b)] = corr
        matrix[(b, a)] = corr

    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["feature_id", *feature_ids])
        for a in feature_ids:
            writer.writerow([a, *[_round(matrix.get((a, b)), 6) for b in feature_ids]])


def _markdown(summary: dict[str, Any], prune_rows: list[dict[str, Any]], component_rows: list[dict[str, Any]]) -> str:
    drop_rows = [row for row in prune_rows if row["action"] == "drop_research_candidate"]
    watch_rows = [row for row in prune_rows if row["action"] == "watch_not_selector"]
    top_components = [row for row in component_rows if row["component_rank"] == 1][:12]

    def prune_table(rows: list[dict[str, Any]], limit: int = 30) -> str:
        lines = [
            "| feature | pool | category | action | reason | Sharpe | CAGR | MDD | IC | nearest | corr |",
            "|---|---|---|---|---|---:|---:|---:|---:|---|---:|",
        ]
        for row in rows[:limit]:
            lines.append(
                "| "
                + " | ".join([
                    str(row.get("feature_id")),
                    str(row.get("origin_pool")),
                    str(row.get("category")),
                    str(row.get("action")),
                    str(row.get("reasons")),
                    f"{(_num(row.get('monthly_sharpe')) or 0.0):.4f}" if _num(row.get("monthly_sharpe")) is not None else "n/a",
                    f"{(_num(row.get('cagr')) or 0.0) * 100:.2f}%" if _num(row.get("cagr")) is not None else "n/a",
                    f"{(_num(row.get('max_drawdown')) or 0.0) * 100:.2f}%" if _num(row.get("max_drawdown")) is not None else "n/a",
                    f"{(_num(row.get('mean_ic_5d')) or 0.0):.4f}" if _num(row.get("mean_ic_5d")) is not None else "n/a",
                    str(row.get("nearest_feature") or ""),
                    f"{(_num(row.get('nearest_abs_rank_corr')) or 0.0):.4f}",
                ])
                + " |"
            )
        return "\n".join(lines)

    lines = [
        "# Unified 179 Pairwise Similarity Matrix",
        "",
        "Scope: research-only feature similarity and prune recommendation; no production registry mutation.",
        "",
        "## Summary",
        "",
        f"- Features materialized: {summary['counts']['features_materialized']}.",
        f"- Pair rows: {summary['counts']['pair_rows']}.",
        f"- Pair corr >= 0.9: {summary['pair_threshold_counts']['abs_corr_ge_0_9']}.",
        f"- Pair corr >= 0.8: {summary['pair_threshold_counts']['abs_corr_ge_0_8']}.",
        f"- Pair corr >= 0.75: {summary['pair_threshold_counts']['abs_corr_ge_0_75']}.",
        f"- Pair corr >= 0.6: {summary['pair_threshold_counts']['abs_corr_ge_0_6']}.",
        f"- Drop research candidates: {len(drop_rows)}.",
        f"- Watch/not-selector candidates: {len(watch_rows)}.",
        "",
        "## Cluster Leaders At Corr >= 0.75",
        "",
        "| component | size | leader | leader score |",
        "|---:|---:|---|---:|",
    ]
    for row in top_components:
        lines.append(
            f"| {row['component_id']} | {row['component_size']} | {row['feature_id']} | {row['quality_score']:.4f} |"
        )

    lines.extend([
        "",
        "## Drop Research Candidates",
        "",
        prune_table(drop_rows),
        "",
        "## Watch / Not Selector Candidates",
        "",
        prune_table(watch_rows),
        "",
        "## Artifacts",
        "",
    ])
    for key, value in summary["artifacts"].items():
        lines.append(f"- {key}: `{value}`")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build full pairwise similarity matrix for unified179 feature candidates.")
    parser.add_argument("--registry", default=str(REGISTRY))
    parser.add_argument("--backtest-report", default=str(BACKTEST_REPORT))
    parser.add_argument("--start-date", default="2023-01-01")
    parser.add_argument("--end-date", default="2026-06-15")
    parser.add_argument("--universe", default="sii")
    parser.add_argument("--forward-days", type=int, default=5)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--min-pair-obs", type=int, default=5000)
    parser.add_argument("--min-symbols-ic", type=int, default=30)
    parser.add_argument("--factor-json", default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"))
    parser.add_argument("--output-dir", default=str(OUT_DIR))
    args = parser.parse_args()

    started = time.time()
    overlap = _load_module(OVERLAP_RUNNER, "stockvision_unified179_overlap")
    alpha = overlap._load_module(overlap.ALPHA_MINER, "stockvision_unified179_alpha_miner")

    active = _load_active_features(Path(args.registry))
    meta = {row["feature_id"]: row for row in active}
    metrics = _load_backtest_metrics(Path(args.backtest_report))
    feature_ids = [row["feature_id"] for row in active]

    print(f"[unified179] building unified registry factor universe={args.universe}", file=sys.stderr, flush=True)
    registry_args = argparse.Namespace(
        feature_registry=args.registry,
        similarity_contract=str(ROOT / "data" / "feature_registry" / "formal137_similarity_contract_v1.json"),
        factor_json=args.factor_json,
        start_date=args.start_date,
        end_date=args.end_date,
        universe=args.universe,
        max_symbols=args.max_symbols,
    )
    close, _tradable, registry_values, _registry_meta, registry_info = alpha._build_unified_registry_factor_universe(registry_args)
    columns = close.columns.tolist()
    index = pd.DatetimeIndex(close.index)
    fwd_return = close.shift(-args.forward_days) / close - 1.0
    target_rank = overlap._rank_panel(fwd_return)

    values: dict[str, pd.DataFrame] = {}
    missing: list[str] = []
    for row in active:
        fid = row["feature_id"]
        frame = registry_values.get(fid)
        if frame is None:
            missing.append(fid)
            continue
        values[fid] = frame.reindex(index=index, columns=columns)

    print(f"[unified179] materialized={len(values)} missing={len(missing)}", file=sys.stderr, flush=True)
    summaries = overlap._summarize_features(values, target_rank=target_rank, min_symbols_ic=args.min_symbols_ic)
    ranks = {fid: overlap._rank_panel(frame) for fid, frame in values.items()}
    flat = {fid: overlap._flatten(frame) for fid, frame in ranks.items()}
    ids = [fid for fid in feature_ids if fid in flat]

    pair_rows: list[dict[str, Any]] = []
    for i, a in enumerate(ids):
        if i and i % 20 == 0:
            print(f"[unified179] pairwise progress {i}/{len(ids)}", file=sys.stderr, flush=True)
        af = flat[a]
        for b in ids[i + 1 :]:
            corr, nobs = overlap._corr(af, flat[b], args.min_pair_obs)
            if corr is None:
                continue
            abs_corr = abs(corr)
            pair_rows.append({
                "feature_a": a,
                "feature_b": b,
                "origin_a": meta[a].get("origin_pool"),
                "origin_b": meta[b].get("origin_pool"),
                "category_a": meta[a].get("category"),
                "category_b": meta[b].get("category"),
                "rank_corr": _round(corr, 8),
                "abs_rank_corr": _round(abs_corr, 8),
                "n_obs": nobs,
                "mean_ic_5d_a": _round(_num((summaries.get(a) or {}).get("mean_ic"))),
                "mean_ic_5d_b": _round(_num((summaries.get(b) or {}).get("mean_ic"))),
                "quality_score_a": _quality_score(metrics.get(a)),
                "quality_score_b": _quality_score(metrics.get(b)),
            })

    pair_rows.sort(key=lambda row: row["abs_rank_corr"], reverse=True)
    thresholds = [0.9, 0.8, 0.75, 0.7, 0.6, 0.5, 0.4]
    threshold_counts = {
        f"abs_corr_ge_{str(t).replace('.', '_')}": sum(1 for row in pair_rows if (_num(row.get("abs_rank_corr"), 0.0) or 0.0) >= t)
        for t in thresholds
    }

    groups_08 = _union_find(ids, pair_rows, 0.8)
    groups_075 = _union_find(ids, pair_rows, 0.75)
    groups_06 = _union_find(ids, pair_rows, 0.6)
    component_rows_075 = _component_rows(groups_075, metrics, meta, threshold=0.75)
    prune_rows = _prune_candidates(pair_rows, metrics, meta, groups_075)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    long_path = output_dir / "unified179_pairwise_similarity_long_20260617.csv"
    matrix_path = output_dir / "unified179_pairwise_similarity_matrix_20260617.csv"
    components_path = output_dir / "unified179_similarity_components_20260617.csv"
    prune_path = output_dir / "unified179_prune_candidates_20260617.csv"
    summary_path = output_dir / "unified179_pairwise_similarity_summary_20260617.json"
    md_path = output_dir / "unified179_pairwise_similarity_report_20260617.md"

    _write_csv(pair_rows, long_path)
    _write_square_matrix(ids, pair_rows, matrix_path)
    _write_csv(component_rows_075, components_path)
    _write_csv(prune_rows, prune_path)

    summary = {
        "schema_version": "stockvision-unified179-pairwise-similarity-v1",
        "parameters": {
            "universe": args.universe,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "forward_days": args.forward_days,
            "max_symbols": args.max_symbols,
            "min_pair_obs": args.min_pair_obs,
            "min_symbols_ic": args.min_symbols_ic,
            "registry": _rel(Path(args.registry)),
            "backtest_report": _rel(Path(args.backtest_report)),
        },
        "counts": {
            "features_requested": len(active),
            "features_materialized": len(ids),
            "missing_features": len(missing),
            "pair_rows": len(pair_rows),
            "dates": len(index),
            "symbols": len(columns),
        },
        "missing_features": missing,
        "registry_materializer_info": {
            "factor_universe_mode": registry_info.get("factor_universe_mode"),
            "mapped_factor_count": registry_info.get("mapped_factor_count"),
            "registry_l1_supplement": registry_info.get("registry_l1_supplement"),
            "selected_selector_role_counts": registry_info.get("selected_selector_role_counts"),
        },
        "pair_threshold_counts": threshold_counts,
        "component_counts": {
            "corr_ge_0_8_components_size_ge_2": sum(1 for group in groups_08 if len(group) >= 2),
            "corr_ge_0_8_largest_component": max((len(group) for group in groups_08), default=0),
            "corr_ge_0_75_components_size_ge_2": sum(1 for group in groups_075 if len(group) >= 2),
            "corr_ge_0_75_largest_component": max((len(group) for group in groups_075), default=0),
            "corr_ge_0_6_components_size_ge_2": sum(1 for group in groups_06 if len(group) >= 2),
            "corr_ge_0_6_largest_component": max((len(group) for group in groups_06), default=0),
        },
        "origin_pair_counts_ge_0_75": dict(Counter(
            "::".join(sorted([str(row["origin_a"]), str(row["origin_b"])]))
            for row in pair_rows
            if (_num(row.get("abs_rank_corr"), 0.0) or 0.0) >= 0.75
        )),
        "category_pair_counts_ge_0_75": dict(Counter(
            "::".join(sorted([str(row["category_a"]), str(row["category_b"])]))
            for row in pair_rows
            if (_num(row.get("abs_rank_corr"), 0.0) or 0.0) >= 0.75
        ).most_common(20)),
        "prune_counts": dict(Counter(row["action"] for row in prune_rows)),
        "top_pairs": pair_rows[:50],
        "artifacts": {
            "long_csv": _rel(long_path),
            "square_matrix_csv": _rel(matrix_path),
            "components_csv": _rel(components_path),
            "prune_candidates_csv": _rel(prune_path),
            "summary_json": _rel(summary_path),
            "report_md": _rel(md_path),
        },
        "elapsed_s": round(time.time() - started, 3),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(_markdown(summary, prune_rows, component_rows_075), encoding="utf-8")

    print(json.dumps({
        "counts": summary["counts"],
        "pair_threshold_counts": threshold_counts,
        "component_counts": summary["component_counts"],
        "prune_counts": summary["prune_counts"],
        "artifacts": summary["artifacts"],
        "elapsed_s": summary["elapsed_s"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
