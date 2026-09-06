from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
sys.path.insert(0, str(ML_CONTROLLER))

from services.finlab_canonical_materializer import (  # noqa: E402
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
    summary = {
        "mode": "apply" if args.apply else "dry_run",
        "run_id": outputs.run_id,
        "artifact_root": outputs.artifact_root,
        "row_counts": outputs.manifest["row_counts"],
        "checksum": outputs.manifest["checksum"],
    }

    # Dry-run and apply share the daily owner's domain routing and ordering.
    sys.path.insert(0, str(ROOT))
    from tools.finlab_v4_remote_backfill import materialize_canonical_to_d1
    result = materialize_canonical_to_d1(
        {"run_id": outputs.run_id, "generated_at": outputs.generated_at, "artifact_root": outputs.artifact_root},
        start_date=args.start_date or None, end_date=args.end_date or None,
        datasets=datasets, canonical_outputs=outputs, chunk_size=args.chunk_size, dry_run=not args.apply,
    )
    summary.update(result)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True, default=str))
    if int(result["apply_result"].get("error_count") or 0) > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
