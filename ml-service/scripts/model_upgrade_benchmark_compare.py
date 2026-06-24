"""Run read-only before/after benchmark pairs for Active-8 direct-alpha runtime upgrades.

This script never promotes artifacts and never writes model_pool state. It expects either
payload.sequence_records or a GCS-backed payload understood by app.research_benchmarks.common.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.research_model_benchmark_runtime import run_research_model_benchmark  # noqa: E402


DEFAULT_PAIRS = [
    ("TimesFM", "TimesFM25"),
]


def _mean_fold_ic(report: dict[str, Any]) -> float | None:
    metrics = report.get("fold_metrics")
    if not isinstance(metrics, list) or not metrics:
        return None
    vals: list[float] = []
    for row in metrics:
        if not isinstance(row, dict):
            continue
        try:
            vals.append(float(row.get("oos_ic")))
        except (TypeError, ValueError):
            continue
    return round(sum(vals) / len(vals), 6) if vals else None


def _pbo(report: dict[str, Any]) -> float | None:
    try:
        return float(report.get("pbo"))
    except (TypeError, ValueError):
        return None


def _latency(report: dict[str, Any]) -> float | None:
    cost = report.get("cost_sensitivity")
    if not isinstance(cost, dict):
        return None
    try:
        return float(cost.get("latency_sec"))
    except (TypeError, ValueError):
        return None


def _compare_pair(payload: dict[str, Any], before: str, after: str) -> dict[str, Any]:
    before_report = run_research_model_benchmark({**payload, "candidate_id": before})
    after_report = run_research_model_benchmark({**payload, "candidate_id": after})
    before_ic = _mean_fold_ic(before_report)
    after_ic = _mean_fold_ic(after_report)
    before_pbo = _pbo(before_report)
    after_pbo = _pbo(after_report)
    return {
        "before": before,
        "after": after,
        "before_status": before_report.get("status"),
        "after_status": after_report.get("status"),
        "before_oos_ic_mean": before_ic,
        "after_oos_ic_mean": after_ic,
        "delta_oos_ic_mean": round(after_ic - before_ic, 6) if before_ic is not None and after_ic is not None else None,
        "before_pbo": before_pbo,
        "after_pbo": after_pbo,
        "delta_pbo": round(after_pbo - before_pbo, 6) if before_pbo is not None and after_pbo is not None else None,
        "before_latency_sec": _latency(before_report),
        "after_latency_sec": _latency(after_report),
        "before_blockers": before_report.get("blockers", []),
        "after_blockers": after_report.get("blockers", []),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True, help="JSON payload file with sequence_records or GCS data_slice.")
    parser.add_argument("--pairs", default=None, help="Optional JSON list of [before, after] pairs.")
    parser.add_argument("--pairs-file", default=None, help="Optional JSON file containing [before, after] pairs.")
    args = parser.parse_args()

    payload = json.loads(Path(args.payload).read_text(encoding="utf-8-sig"))
    if args.pairs_file:
        pairs = json.loads(Path(args.pairs_file).read_text(encoding="utf-8-sig"))
    else:
        pairs = json.loads(args.pairs) if args.pairs else DEFAULT_PAIRS
    comparisons = [_compare_pair(payload, str(before), str(after)) for before, after in pairs]
    print(json.dumps({
        "status": "completed",
        "production_mutation_allowed": False,
        "promotion_allowed": False,
        "comparisons": comparisons,
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
