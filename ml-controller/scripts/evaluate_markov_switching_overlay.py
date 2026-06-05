"""Evaluate persisted MarkovSwitching overlay attribution.

This script is read-only. Use --input for exported rows or --from-d1 for live
D1 reads after state_space_overlays have accumulated in predictions.forecast_data.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.state_space_overlay_attribution import (  # noqa: E402
    evaluate_markov_switching_overlay,
    load_markov_switching_overlay_rows,
)


def _read_rows(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        data = data["rows"]
    if not isinstance(data, list):
        raise ValueError("input JSON must be a row list or an object with rows")
    return [row for row in data if isinstance(row, dict)]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Evaluate MarkovSwitching overlay attribution.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Local JSON rows exported from D1.")
    source.add_argument("--from-d1", action="store_true", help="Read verified overlay rows from remote D1 env.")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--min-samples", type=int, default=30)
    parser.add_argument("--min-gate-samples", type=int, default=5)
    parser.add_argument("--min-confidence", type=float, default=0.0)
    parser.add_argument("--min-abs-forecast-pct", type=float, default=0.0)
    parser.add_argument("--min-avg-delta", type=float, default=0.0)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    rows = load_markov_switching_overlay_rows(limit=args.limit) if args.from_d1 else _read_rows(args.input)
    report = evaluate_markov_switching_overlay(
        rows,
        min_samples=args.min_samples,
        min_gate_samples=args.min_gate_samples,
        min_confidence=args.min_confidence,
        min_abs_forecast_pct=args.min_abs_forecast_pct,
        min_avg_delta=args.min_avg_delta,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if report.get("status") in {"completed", "skipped"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
