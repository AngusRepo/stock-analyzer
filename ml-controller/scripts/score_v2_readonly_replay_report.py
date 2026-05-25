"""Export a read-only Score V2 rollout replay audit.

The script compares legacy scalar `daily_recommendations.score` with canonical
Score V2 `score_components.finalScore/total`. It never writes to D1.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services import d1_client  # noqa: E402
from services.score_v2_replay_audit import (  # noqa: E402
    build_score_v2_readonly_replay_report,
    evaluate_score_v2_rollout_gate,
)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def _load_rows_from_d1(*, start_date: str, end_date: str, limit: int) -> list[dict[str, Any]]:
    return d1_client.query(
        """
        SELECT date, symbol, name, rank, score, score_components,
               signal, confidence, industry, recommendation_lane
          FROM daily_recommendations
         WHERE date >= ?
           AND date <= ?
         ORDER BY date ASC, rank ASC, score DESC
         LIMIT ?
        """,
        [start_date, end_date, limit],
        timeout=90,
    )


def _rows_from_input_json(loaded: Any) -> list[dict[str, Any]]:
    if isinstance(loaded, dict):
        rows = loaded.get("rows")
        if isinstance(rows, list):
            return rows
    if isinstance(loaded, list):
        if loaded and isinstance(loaded[0], dict) and isinstance(loaded[0].get("results"), list):
            rows: list[dict[str, Any]] = []
            for item in loaded:
                if isinstance(item, dict) and isinstance(item.get("results"), list):
                    rows.extend(row for row in item["results"] if isinstance(row, dict))
            return rows
        return loaded
    raise ValueError("--input-json must contain a JSON array, Wrangler D1 JSON output, or {'rows': [...]}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only Score V2 rollout replay audit.")
    parser.add_argument("--date", default="", help="Single decision date YYYY-MM-DD.")
    parser.add_argument("--start-date", default="", help="Inclusive start date.")
    parser.add_argument("--end-date", default="", help="Inclusive end date.")
    parser.add_argument("--input-json", default="", help="Optional local JSON rows file for offline audit.")
    parser.add_argument("--output-json", default="", help="Optional output report path.")
    parser.add_argument("--top-n", type=int, default=10)
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--gate", action="store_true", help="Include read-only Score V2 rollout readiness gate.")
    parser.add_argument("--fail-on-block", action="store_true", help="Exit 2 when the rollout gate blocks.")
    args = parser.parse_args()

    if args.input_json:
        loaded = _read_json(Path(args.input_json))
        try:
            rows = _rows_from_input_json(loaded)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
    else:
        start_date = args.date or args.start_date
        end_date = args.date or args.end_date or start_date
        if not start_date or not end_date:
            raise SystemExit("Provide --date, --start-date/--end-date, or --input-json")
        rows = _load_rows_from_d1(start_date=start_date, end_date=end_date, limit=max(1, args.limit))

    report = build_score_v2_readonly_replay_report(rows, top_n=max(1, args.top_n))
    if args.gate or args.fail_on_block:
        report["rollout_gate"] = evaluate_score_v2_rollout_gate(report)
    if args.output_json:
        _write_json(Path(args.output_json), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=str))
    if args.fail_on_block and report["rollout_gate"]["decision"] == "BLOCK":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
