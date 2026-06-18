from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
BACKTEST = ROOT / "output" / "feature_universe_triage" / "unified179_feature_backtest_report_20260617.csv"
PRUNE = ROOT / "output" / "feature_universe_triage" / "unified179_prune_candidates_20260617.csv"
SUMMARY = ROOT / "output" / "feature_universe_triage" / "unified179_pairwise_similarity_summary_20260617.json"
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


def _num(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = list(rows[0].keys()) if rows else []
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    active = [
        row
        for row in registry.get("features", [])
        if row.get("active_pool_status") == "candidate"
        and row.get("origin_pool") in {"strategy95", "ml106"}
    ]
    metrics = {row["feature_id"]: row for row in _read_csv(BACKTEST)}
    prune = {row["feature_id"]: row for row in _read_csv(PRUNE)}
    pair_summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    missing = set(pair_summary.get("missing_features") or [])

    rows: list[dict[str, Any]] = []
    for feature in active:
        fid = feature["feature_id"]
        metric = metrics.get(fid, {})
        decision = prune.get(fid)
        action = decision.get("action") if decision else "keep_candidate"
        if fid in missing and action == "keep_candidate":
            action = "watch_not_selector"
        rows.append({
            "feature_id": fid,
            "origin_pool": feature.get("origin_pool"),
            "category": feature.get("category"),
            "recommended_status": action,
            "recommended_pool": (
                "remove_from_selector_candidate_pool"
                if action == "drop_research_candidate"
                else "context_or_secondary_evidence"
                if action == "watch_not_selector"
                else "active_candidate"
            ),
            "reasons": decision.get("reasons") if decision else ("missing_pairwise_panel" if fid in missing else ""),
            "monthly_sharpe": _num(metric.get("monthly_sharpe")),
            "cagr": _num(metric.get("cagr")),
            "max_drawdown": _num(metric.get("max_drawdown")),
            "mean_ic_5d": _num(metric.get("mean_ic_5d")),
            "coverage": _num(metric.get("coverage")),
            "nearest_feature": decision.get("nearest_feature") if decision else "",
            "nearest_abs_rank_corr": _num(decision.get("nearest_abs_rank_corr")) if decision else None,
        })

    rows.sort(key=lambda row: (row["recommended_status"], row["origin_pool"], row["category"] or "", row["feature_id"]))
    keep_rows = [row for row in rows if row["recommended_status"] != "drop_research_candidate"]
    strict_keep_rows = [row for row in rows if row["recommended_status"] == "keep_candidate"]
    status_counts = Counter(row["recommended_status"] for row in rows)
    origin_status_counts = Counter(f"{row['origin_pool']}::{row['recommended_status']}" for row in rows)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    decision_path = OUT_DIR / "unified179_feature_prune_decision_20260617.csv"
    keep_path = OUT_DIR / "unified179_feature_pool_after_strict_drop_20260617.csv"
    strict_keep_path = OUT_DIR / "unified179_feature_pool_keep_only_20260617.csv"
    summary_path = OUT_DIR / "unified179_feature_prune_decision_summary_20260617.json"
    _write_csv(rows, decision_path)
    _write_csv(keep_rows, keep_path)
    _write_csv(strict_keep_rows, strict_keep_path)
    summary = {
        "schema_version": "stockvision-unified179-feature-prune-decision-v1",
        "source": {
            "registry": _rel(REGISTRY),
            "backtest_report": _rel(BACKTEST),
            "pairwise_summary": _rel(SUMMARY),
            "prune_candidates": _rel(PRUNE),
        },
        "counts": {
            "total_features": len(rows),
            "after_strict_drop": len(keep_rows),
            "keep_only": len(strict_keep_rows),
            "missing_pairwise_panel": len(missing),
        },
        "status_counts": dict(status_counts),
        "origin_status_counts": dict(origin_status_counts),
        "artifacts": {
            "decision_csv": _rel(decision_path),
            "after_strict_drop_csv": _rel(keep_path),
            "keep_only_csv": _rel(strict_keep_path),
            "summary_json": _rel(summary_path),
        },
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
