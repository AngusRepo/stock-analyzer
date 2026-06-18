from __future__ import annotations

import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
STRATEGY95_BEST = ROOT / "output" / "finlab_strategy95_backtests" / "strategy95_factors_sii_20230101_20260615_top10_bothdir_best.csv"
ML106_BEST = ROOT / "output" / "finlab_ml_feature_backtests" / "ml106_features_sii_20230101_20260615_top10_bothdir_best.csv"
OVERLAP_JSON = ROOT / "output" / "feature_strategy_overlap_numeric" / "feature_strategy_overlap_sii_20230101_20260615.json"
OVERLAP_PAIRS = ROOT / "output" / "feature_strategy_overlap_numeric" / "feature_strategy_overlap_sii_20230101_20260615_pairs_ge_0_6.csv"
OUT_DIR = ROOT / "output" / "feature_universe_triage"


def _rel(path: Path | str) -> str:
    resolved = Path(path)
    try:
        return resolved.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


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


def _avg(values: list[float | None]) -> float | None:
    clean = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    return mean(clean) if clean else None


def _median(values: list[float | None]) -> float | None:
    clean = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    return median(clean) if clean else None


def _percentile(values: list[float | None], p: float) -> float | None:
    clean = sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    if not clean:
        return None
    if len(clean) == 1:
        return clean[0]
    pos = (len(clean) - 1) * p
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return clean[lo]
    weight = pos - lo
    return clean[lo] * (1 - weight) + clean[hi] * weight


def _bucket_counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    sharpe = [_num(row.get("monthly_sharpe")) for row in rows]
    cagr = [_num(row.get("cagr")) for row in rows]
    mdd_abs = [abs(_num(row.get("max_drawdown")) or 0.0) for row in rows if _num(row.get("max_drawdown")) is not None]
    abs_ic = [abs(_num(row.get("mean_ic_5d")) or 0.0) for row in rows if _num(row.get("mean_ic_5d")) is not None]
    return {
        "monthly_sharpe_ge_1_5": sum(1 for v in sharpe if v is not None and v >= 1.5),
        "monthly_sharpe_ge_1_0": sum(1 for v in sharpe if v is not None and v >= 1.0),
        "monthly_sharpe_lt_0": sum(1 for v in sharpe if v is not None and v < 0),
        "cagr_ge_30pct": sum(1 for v in cagr if v is not None and v >= 0.30),
        "cagr_ge_15pct": sum(1 for v in cagr if v is not None and v >= 0.15),
        "abs_mdd_le_15pct": sum(1 for v in mdd_abs if v <= 0.15),
        "abs_mdd_gt_30pct": sum(1 for v in mdd_abs if v > 0.30),
        "abs_mean_ic_ge_0_03": sum(1 for v in abs_ic if v >= 0.03),
        "abs_mean_ic_ge_0_02": sum(1 for v in abs_ic if v >= 0.02),
    }


def _summarize_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "count": len(rows),
        "avg_monthly_sharpe": _round(_avg([_num(r.get("monthly_sharpe")) for r in rows])),
        "median_monthly_sharpe": _round(_median([_num(r.get("monthly_sharpe")) for r in rows])),
        "avg_cagr": _round(_avg([_num(r.get("cagr")) for r in rows])),
        "median_cagr": _round(_median([_num(r.get("cagr")) for r in rows])),
        "avg_abs_mdd": _round(_avg([abs(_num(r.get("max_drawdown")) or 0.0) for r in rows if _num(r.get("max_drawdown")) is not None])),
        "median_abs_mdd": _round(_median([abs(_num(r.get("max_drawdown")) or 0.0) for r in rows if _num(r.get("max_drawdown")) is not None])),
        "avg_mean_ic_5d": _round(_avg([_num(r.get("mean_ic_5d")) for r in rows])),
        "median_mean_ic_5d": _round(_median([_num(r.get("mean_ic_5d")) for r in rows])),
        "avg_abs_mean_ic_5d": _round(_avg([abs(_num(r.get("mean_ic_5d")) or 0.0) for r in rows if _num(r.get("mean_ic_5d")) is not None])),
    }


def _load_backtest_rows() -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    strategy = {row["factor_id"]: row for row in _read_csv(STRATEGY95_BEST)}
    ml = {row["feature_id"]: row for row in _read_csv(ML106_BEST)}
    return strategy, ml


def _load_ic_summaries() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    data = json.loads(OVERLAP_JSON.read_text(encoding="utf-8"))
    return data.get("strategy_summary") or {}, data.get("ml_summary") or {}


def _metric_row(feature: dict[str, Any], strategy_best: dict[str, str], ml_best: dict[str, str], strategy_ic: dict[str, Any], ml_ic: dict[str, Any]) -> dict[str, Any]:
    fid = feature["feature_id"]
    origin = feature["origin_pool"]
    backtest = strategy_best.get(fid) if origin == "strategy95" else ml_best.get(fid)
    ic = strategy_ic.get(fid) if origin == "strategy95" else ml_ic.get(fid)
    triage = feature.get("triage") or {}
    if backtest is None:
        backtest = {}
    if ic is None:
        ic = {}
    return {
        "feature_id": fid,
        "origin_pool": origin,
        "category": feature.get("category"),
        "source_system": feature.get("source_system"),
        "active_pool_status": feature.get("active_pool_status"),
        "direction_mode": backtest.get("direction_mode") or backtest.get("declared_direction"),
        "direction": _num(backtest.get("direction")),
        "coverage": _num(backtest.get("coverage"), _num(triage.get("coverage"))),
        "cagr": _num(backtest.get("cagr"), _num(triage.get("cagr"))),
        "monthly_sharpe": _num(backtest.get("monthly_sharpe"), _num(triage.get("monthly_sharpe"))),
        "monthly_sortino": _num(backtest.get("monthly_sortino")),
        "max_drawdown": _num(backtest.get("max_drawdown"), _num(triage.get("max_drawdown"))),
        "calmar": _num(backtest.get("calmar")),
        "win_ratio": _num(backtest.get("win_ratio")),
        "total_return": _num(backtest.get("total_return")),
        "benchmark_alpha": _num(backtest.get("benchmark_alpha")),
        "benchmark_beta": _num(backtest.get("benchmark_beta")),
        "trade_count": _num(backtest.get("trade_count")),
        "avg_daily_matches": _num(backtest.get("avg_daily_matches")),
        "latest_matches": _num(backtest.get("latest_matches")),
        "mean_ic_5d": _num(ic.get("mean_ic"), _num(triage.get("mean_ic_5d"))),
        "median_ic_5d": _num(ic.get("median_ic")),
        "ic_ir_5d": _num(ic.get("ic_ir")),
        "ic_obs_days": _num(ic.get("n")),
        "nearest_ml106_feature": triage.get("nearest_ml106_feature"),
        "nearest_abs_rank_corr": _num(triage.get("nearest_abs_rank_corr")),
        "max_abs_rank_corr_to_strategy95": _num(triage.get("max_abs_rank_corr_to_strategy95")),
        "quality_bucket": triage.get("quality_bucket"),
        "selection_note": backtest.get("selection_note"),
    }


def _homogeneity(active_rows: list[dict[str, Any]], registry_features: list[dict[str, Any]]) -> dict[str, Any]:
    active_ids = {row["feature_id"] for row in active_rows}
    candidate_ml = {row["feature_id"] for row in active_rows if row["origin_pool"] == "ml106"}
    raw_ml = {row["feature_id"] for row in registry_features if row.get("origin_pool") == "ml106"}
    alias_ml = {row["feature_id"] for row in registry_features if row.get("origin_pool") == "ml106" and row.get("active_pool_status") == "alias"}
    pair_rows = _read_csv(OVERLAP_PAIRS)

    def pair_stats(rows: list[dict[str, str]]) -> dict[str, Any]:
        corrs = [_num(row.get("abs_rank_corr")) for row in rows]
        corrs = [v for v in corrs if v is not None]
        return {
            "known_pair_count_ge_0_6": len(corrs),
            "known_pair_count_ge_0_7": sum(1 for v in corrs if v >= 0.7),
            "known_pair_count_ge_0_8": sum(1 for v in corrs if v >= 0.8),
            "known_pair_count_ge_0_9": sum(1 for v in corrs if v >= 0.9),
            "max_abs_rank_corr": _round(max(corrs), 6) if corrs else None,
            "avg_abs_rank_corr_known_pairs": _round(_avg(corrs), 6),
            "median_abs_rank_corr_known_pairs": _round(_median(corrs), 6),
        }

    before_pairs = [row for row in pair_rows if row.get("ml_feature") in raw_ml]
    after_pairs = [row for row in pair_rows if row.get("ml_feature") in candidate_ml]
    top_after = sorted(after_pairs, key=lambda row: _num(row.get("abs_rank_corr"), -1) or -1, reverse=True)[:20]

    by_category = Counter(str(row.get("category") or "unknown") for row in active_rows)
    by_origin_category = Counter(f"{row.get('origin_pool')}::{row.get('category') or 'unknown'}" for row in active_rows)
    categories = defaultdict(list)
    for row in active_rows:
        categories[str(row.get("category") or "unknown")].append(row)

    return {
        "pool_dedupe": {
            "raw_strategy95_plus_ml106": 201,
            "active_candidate_features": len(active_rows),
            "removed_ml106_alias_features": len(alias_ml),
            "removed_ml106_alias_ids": sorted(alias_ml),
            "dedupe_rule": "ML106 features with abs rank correlation >= 0.8 to strategy95 are alias, not active candidates.",
        },
        "cross_pool_correlation_known_pairs_note": "Computed from stored strategy95-vs-ml106 pair rows with abs rank corr >= 0.6; intra-strategy95 and intra-ml106 pair matrices were not stored in existing artifacts.",
        "cross_pool_before_dedupe": pair_stats(before_pairs),
        "cross_pool_after_dedupe": pair_stats(after_pairs),
        "top_residual_cross_pool_pairs_ge_0_6": [
            {
                "strategy_factor": row.get("strategy_factor"),
                "ml_feature": row.get("ml_feature"),
                "abs_rank_corr": _round(_num(row.get("abs_rank_corr"))),
                "strategy_mean_ic": _round(_num(row.get("strategy_mean_ic"))),
                "ml_mean_ic": _round(_num(row.get("ml_mean_ic"))),
            }
            for row in top_after
        ],
        "category_counts": dict(by_category.most_common()),
        "origin_category_counts": dict(by_origin_category.most_common()),
        "category_performance": {
            category: _summarize_group(rows)
            for category, rows in sorted(categories.items(), key=lambda item: len(item[1]), reverse=True)
        },
    }


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = list(rows[0].keys()) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _format_pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.2f}%"


def _format_num(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.4f}"


def _markdown(report: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    summary = report["summary"]
    hom = report["homogeneity"]
    top_sharpe = sorted(rows, key=lambda r: _num(r.get("monthly_sharpe"), -999) or -999, reverse=True)[:20]
    top_ic = sorted(rows, key=lambda r: abs(_num(r.get("mean_ic_5d"), 0) or 0), reverse=True)[:20]
    weak = sorted(
        rows,
        key=lambda r: (
            _num(r.get("monthly_sharpe"), -999) or -999,
            abs(_num(r.get("mean_ic_5d"), 0) or 0),
        ),
    )[:20]

    def table(items: list[dict[str, Any]]) -> str:
        lines = [
            "| feature | pool | category | Sharpe | CAGR | MDD | mean IC 5d | coverage |",
            "|---|---:|---|---:|---:|---:|---:|---:|",
        ]
        for row in items:
            lines.append(
                "| "
                + " | ".join([
                    str(row.get("feature_id")),
                    str(row.get("origin_pool")),
                    str(row.get("category")),
                    _format_num(_num(row.get("monthly_sharpe"))),
                    _format_pct(_num(row.get("cagr"))),
                    _format_pct(_num(row.get("max_drawdown"))),
                    _format_num(_num(row.get("mean_ic_5d"))),
                    _format_pct(_num(row.get("coverage"))),
                ])
                + " |"
            )
        return "\n".join(lines)

    lines = [
        "# Unified 179 Feature Backtest Report",
        "",
        "Data source: existing FinLab research-only artifacts for strategy95 and ML106; no new FinLab rerun.",
        "",
        "## Summary",
        "",
        f"- Active candidates: {summary['active_candidate_count']} / raw 201 strategy95+ML106.",
        f"- Origin split: strategy95={summary['origin_counts'].get('strategy95', 0)}, ml106={summary['origin_counts'].get('ml106', 0)}.",
        f"- Removed high-overlap ML106 aliases: {hom['pool_dedupe']['removed_ml106_alias_features']}.",
        f"- Average Sharpe: {_format_num(summary['performance']['avg_monthly_sharpe'])}; median Sharpe: {_format_num(summary['performance']['median_monthly_sharpe'])}.",
        f"- Average CAGR: {_format_pct(summary['performance']['avg_cagr'])}; median CAGR: {_format_pct(summary['performance']['median_cagr'])}.",
        f"- Average abs MDD: {_format_pct(summary['performance']['avg_abs_mdd'])}; median abs MDD: {_format_pct(summary['performance']['median_abs_mdd'])}.",
        f"- Average abs mean IC 5d: {_format_num(summary['performance']['avg_abs_mean_ic_5d'])}.",
        "",
        "## Quality Buckets",
        "",
        "```json",
        json.dumps(summary["bucket_counts"], ensure_ascii=False, indent=2),
        "```",
        "",
        "## Homogeneity",
        "",
        f"- Before dedupe known cross-pool pairs >=0.8: {hom['cross_pool_before_dedupe']['known_pair_count_ge_0_8']}.",
        f"- After dedupe known cross-pool pairs >=0.8: {hom['cross_pool_after_dedupe']['known_pair_count_ge_0_8']}.",
        f"- After dedupe known cross-pool pairs >=0.6: {hom['cross_pool_after_dedupe']['known_pair_count_ge_0_6']}.",
        f"- Residual max known cross-pool corr: {_format_num(hom['cross_pool_after_dedupe']['max_abs_rank_corr'])}.",
        "",
        hom["cross_pool_correlation_known_pairs_note"],
        "",
        "## Top 20 By Sharpe",
        "",
        table(top_sharpe),
        "",
        "## Top 20 By Absolute IC",
        "",
        table(top_ic),
        "",
        "## Weakest 20 By Sharpe Then IC",
        "",
        table(weak),
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    features = registry["features"]
    active_features = [
        feature
        for feature in features
        if feature.get("active_pool_status") == "candidate"
        and feature.get("origin_pool") in {"strategy95", "ml106"}
    ]
    strategy_best, ml_best = _load_backtest_rows()
    strategy_ic, ml_ic = _load_ic_summaries()
    rows = [_metric_row(feature, strategy_best, ml_best, strategy_ic, ml_ic) for feature in active_features]
    rows.sort(
        key=lambda row: (
            row["origin_pool"],
            str(row.get("category") or ""),
            str(row.get("feature_id") or ""),
        )
    )

    origin_counts = Counter(row["origin_pool"] for row in rows)
    summary = {
        "schema_version": "stockvision-unified179-feature-backtest-report-v1",
        "source": {
            "registry": _rel(REGISTRY),
            "strategy95_best": _rel(STRATEGY95_BEST),
            "ml106_best": _rel(ML106_BEST),
            "overlap_json": _rel(OVERLAP_JSON),
            "overlap_pairs": _rel(OVERLAP_PAIRS),
            "note": "Merged from existing FinLab research-only artifacts; no new FinLab rerun.",
        },
        "summary": {
            "active_candidate_count": len(rows),
            "origin_counts": dict(origin_counts),
            "performance": _summarize_group(rows),
            "bucket_counts": _bucket_counts(rows),
            "sharpe_percentiles": {
                "p25": _round(_percentile([_num(r.get("monthly_sharpe")) for r in rows], 0.25)),
                "p50": _round(_percentile([_num(r.get("monthly_sharpe")) for r in rows], 0.50)),
                "p75": _round(_percentile([_num(r.get("monthly_sharpe")) for r in rows], 0.75)),
                "p90": _round(_percentile([_num(r.get("monthly_sharpe")) for r in rows], 0.90)),
            },
            "abs_ic_percentiles": {
                "p25": _round(_percentile([abs(_num(r.get("mean_ic_5d")) or 0.0) for r in rows if _num(r.get("mean_ic_5d")) is not None], 0.25)),
                "p50": _round(_percentile([abs(_num(r.get("mean_ic_5d")) or 0.0) for r in rows if _num(r.get("mean_ic_5d")) is not None], 0.50)),
                "p75": _round(_percentile([abs(_num(r.get("mean_ic_5d")) or 0.0) for r in rows if _num(r.get("mean_ic_5d")) is not None], 0.75)),
                "p90": _round(_percentile([abs(_num(r.get("mean_ic_5d")) or 0.0) for r in rows if _num(r.get("mean_ic_5d")) is not None], 0.90)),
            },
        },
        "origin_performance": {
            origin: _summarize_group([row for row in rows if row["origin_pool"] == origin])
            for origin in sorted(origin_counts)
        },
        "homogeneity": _homogeneity(rows, features),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / "unified179_feature_backtest_report_20260617.csv"
    json_path = OUT_DIR / "unified179_feature_backtest_summary_20260617.json"
    md_path = OUT_DIR / "unified179_feature_backtest_report_20260617.md"
    _write_csv(rows, csv_path)
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(_markdown(summary, rows), encoding="utf-8")
    print(json.dumps({
        "csv": _rel(csv_path),
        "json": _rel(json_path),
        "md": _rel(md_path),
        "active_candidate_count": len(rows),
        "origin_counts": dict(origin_counts),
        "performance": summary["summary"]["performance"],
        "homogeneity": {
            "before_ge_0_8": summary["homogeneity"]["cross_pool_before_dedupe"]["known_pair_count_ge_0_8"],
            "after_ge_0_8": summary["homogeneity"]["cross_pool_after_dedupe"]["known_pair_count_ge_0_8"],
            "after_ge_0_6": summary["homogeneity"]["cross_pool_after_dedupe"]["known_pair_count_ge_0_6"],
            "removed_ml106_alias_features": summary["homogeneity"]["pool_dedupe"]["removed_ml106_alias_features"],
        },
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
