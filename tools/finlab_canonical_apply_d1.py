from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
sys.path.insert(0, str(ML_CONTROLLER))

from services.finlab_canonical_materializer import (  # noqa: E402
    build_d1_upsert_statements,
    materialize_finlab_canonical_outputs,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prepare or apply FinLab canonical row-level materialization to D1."
    )
    parser.add_argument("--artifact-root", required=True, help="Path to data/finlab_remote_backfill/<run_id>.")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--start-date", default="")
    parser.add_argument("--end-date", default="")
    parser.add_argument("--limit-per-dataset", type=int, default=0, help="Smoke limiter; 0 means no limit.")
    parser.add_argument("--datasets", default="", help="Comma-separated canonical datasets to materialize/apply.")
    parser.add_argument("--generated-at", default="", help="Override generated_at/as_of_date, e.g. 2026-05-18T23:00:00+00:00.")
    parser.add_argument("--chunk-size", type=int, default=250)
    parser.add_argument("--apply", action="store_true", help="Actually write to D1. Omit for dry-run.")
    args = parser.parse_args()
    datasets = [part.strip() for part in args.datasets.split(",") if part.strip()]

    outputs = materialize_finlab_canonical_outputs(
        args.artifact_root,
        run_id=args.run_id or None,
        start_date=args.start_date or None,
        end_date=args.end_date or None,
        limit_per_dataset=args.limit_per_dataset or None,
        generated_at=args.generated_at or None,
        datasets=datasets or None,
    )
    statements = build_d1_upsert_statements(outputs)
    summary = {
        "mode": "apply" if args.apply else "dry_run",
        "run_id": outputs.run_id,
        "artifact_root": outputs.artifact_root,
        "row_counts": outputs.manifest["row_counts"],
        "statement_count": len(statements),
        "checksum": outputs.manifest["checksum"],
    }

    if not args.apply:
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0

    from services.d1_client import batch_execute  # noqa: WPS433

    result = batch_execute(statements, chunk_size=args.chunk_size, timeout=60.0)
    summary["d1_result"] = result
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True, default=str))
    if int(result.get("error_count") or 0) > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
