"""Export daily state-space series payload from read-only D1 inputs.

The output shape is accepted by:
  ml-service/scripts/state_space_parallel_parity.py --input <file>

This script does not run Modal, retrain, deploy, or write D1 rows.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.state_space_series import (  # noqa: E402
    load_daily_state_space_series_export,
    load_state_space_series_export_from_payload_file,
)


def _today_tw() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date().isoformat()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export daily pipeline close-price series for state-space parity checks.",
    )
    parser.add_argument("--run-date", default=_today_tw(), help="Trading date, YYYY-MM-DD. Defaults to today Asia/Taipei.")
    parser.add_argument("--limit", type=int, default=None, help="Optional max number of series rows to export.")
    parser.add_argument("--payloads", type=Path, default=None, help="Offline daily payload JSON file; skips D1 reads.")
    parser.add_argument("--output", type=Path, default=None, help="Optional output JSON path. Defaults to stdout.")
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.payloads:
        export = load_state_space_series_export_from_payload_file(
            path=args.payloads,
            run_date=args.run_date,
            limit=args.limit,
        )
    else:
        export = load_daily_state_space_series_export(
            run_date=args.run_date,
            limit=args.limit,
        )
    text = json.dumps(export, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
