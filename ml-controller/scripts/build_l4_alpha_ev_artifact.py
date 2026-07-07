from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import d1_client  # noqa: E402
from services.l4_alpha_ev_artifact_builder import (  # noqa: E402
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build read-only formal L4 alpha EV artifact from verified ensemble outcomes.",
    )
    parser.add_argument("--end-date", required=True, help="Training cutoff date YYYY-MM-DD.")
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--min-samples", type=int, default=500)
    parser.add_argument("--min-dates", type=int, default=20)
    parser.add_argument("--l2", type=float, default=0.25)
    parser.add_argument("--cost-model-bps", type=float, default=18.0)
    parser.add_argument("--limit", type=int, default=6000)
    parser.add_argument("--rows-json", help="Optional rows JSON from wrangler D1 execute --json; skips d1_client.")
    parser.add_argument("--output", help="Optional JSON output path.")
    args = parser.parse_args(argv)

    if args.rows_json:
        raw = json.loads(Path(args.rows_json).read_text(encoding="utf-8-sig"))
        if isinstance(raw, list) and raw and isinstance(raw[0], dict) and isinstance(raw[0].get("results"), list):
            rows = raw[0]["results"]
        elif isinstance(raw, dict) and isinstance(raw.get("results"), list):
            rows = raw["results"]
        elif isinstance(raw, list):
            rows = raw
        else:
            raise ValueError("--rows-json must be a row array or wrangler --json result")
    else:
        rows = load_l4_alpha_ev_training_rows(
            d1_client.query,
            end_date=args.end_date,
            lookback_days=args.lookback_days,
            limit=args.limit,
        )
    result = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until=args.end_date,
        lookback_days=args.lookback_days,
        min_samples=args.min_samples,
        min_dates=args.min_dates,
        l2=args.l2,
        cost_model_bps=args.cost_model_bps,
    )
    payload = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0 if result.get("status") == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
