"""Local parity check for state-space serial vs bounded parallel execution.

This is read-only. It does not deploy, retrain, or write artifacts.
Input JSON can be either:
  [{"symbol": "2330", "prices": [...]}]
or:
  {"series_list": [{"symbol": "2330", "prices": [...]}]}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.state_space_universal import build_state_space_parallel_parity_report  # noqa: E402


def _read_series(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if isinstance(raw, dict) and isinstance(raw.get("series_list"), list):
        return [row for row in raw["series_list"] if isinstance(row, dict)]
    raise ValueError("input must be a list of series rows or an object with series_list")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare state-space serial output with bounded parallel output.",
    )
    parser.add_argument("--input", required=True, type=Path, help="JSON series payload.")
    parser.add_argument("--model-name", default="MarkovSwitching", choices=["KalmanFilter", "MarkovSwitching"])
    parser.add_argument("--version", default="v1")
    parser.add_argument("--horizon", type=int, default=5)
    parser.add_argument("--parallel-workers", type=int, default=2)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    report = build_state_space_parallel_parity_report(
        model_name=args.model_name,
        series_list=_read_series(args.input),
        horizon=args.horizon,
        version=args.version,
        parallel_workers=args.parallel_workers,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if report.get("status") == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
