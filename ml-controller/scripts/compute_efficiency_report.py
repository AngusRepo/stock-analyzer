"""Build a high-spec compute efficiency report from local JSON profiles.

This script is intentionally local/read-only. It does not query D1, GCP, Modal,
or mutate production state. Export live evidence first, then pass the exported
JSON files here.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.compute_efficiency_contract import (  # noqa: E402
    build_compute_efficiency_report_from_events,
    validate_compute_efficiency_report,
)

DECISION_EXIT_CODES = {
    "ACCEPT_HIGH_SPEC_EFFICIENCY": 0,
    "BLOCK_QUALITY_REGRESSION": 2,
    "NEEDS_REVIEW": 3,
    "KEEP_BASELINE_RUNTIME": 4,
    "BLOCK_SPEC_REGRESSION": 6,
}


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _as_event_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        if isinstance(value.get("events"), list):
            return [item for item in value["events"] if isinstance(item, dict)]
        if isinstance(value.get("profiles"), list):
            return [item for item in value["profiles"] if isinstance(item, dict)]
        return [value]
    return []


def build_report_from_files(
    *,
    job_name: str,
    baseline_path: Path,
    optimized_path: Path,
    quality_path: Path,
    generated_at: str | None = None,
) -> dict[str, Any]:
    baseline_events = _as_event_list(_read_json(baseline_path))
    optimized_events = _as_event_list(_read_json(optimized_path))
    quality = _read_json(quality_path)
    if not isinstance(quality, dict):
        raise ValueError("quality JSON must be an object")
    report = build_compute_efficiency_report_from_events(
        job_name=job_name,
        baseline_events=baseline_events,
        optimized_events=optimized_events,
        quality=quality,
        generated_at=generated_at,
    )
    errors = validate_compute_efficiency_report(report)
    if errors:
        report = {**report, "validation_errors": errors}
    return report


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a high-spec compute efficiency report from local JSON profile files.",
    )
    parser.add_argument("--job-name", required=True)
    parser.add_argument("--baseline", required=True, type=Path, help="Baseline profile/event JSON file.")
    parser.add_argument("--optimized", required=True, type=Path, help="Optimized profile/event JSON file.")
    parser.add_argument("--quality", required=True, type=Path, help="Quality evidence JSON file.")
    parser.add_argument("--generated-at", default=None)
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument(
        "--fail-on-decision",
        action="store_true",
        help=(
            "Return a non-zero exit code for any decision other than "
            "ACCEPT_HIGH_SPEC_EFFICIENCY. Report-only mode remains exit 0 by default."
        ),
    )
    return parser


def decision_exit_code(report: dict[str, Any], *, fail_on_decision: bool) -> int:
    if report.get("validation_errors"):
        return 1
    if not fail_on_decision:
        return 0
    return DECISION_EXIT_CODES.get(str(report.get("decision")), 5)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    report = build_report_from_files(
        job_name=args.job_name,
        baseline_path=args.baseline,
        optimized_path=args.optimized,
        quality_path=args.quality,
        generated_at=args.generated_at,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return decision_exit_code(report, fail_on_decision=bool(args.fail_on_decision))


if __name__ == "__main__":
    raise SystemExit(main())
