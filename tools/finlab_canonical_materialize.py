from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_canonical_materializer import materialize_finlab_canonical_outputs  # noqa: E402


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True, default=str) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize FinLab backfill parquet into canonical row-level outputs.")
    parser.add_argument("--artifact-root", required=True, help="Path to data/finlab_remote_backfill/<run_id>.")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--start-date", default="")
    parser.add_argument("--end-date", default="")
    parser.add_argument("--limit-per-dataset", type=int, default=0, help="Test/smoke limiter; 0 means no limit.")
    parser.add_argument("--datasets", default="", help="Comma-separated canonical datasets to materialize.")
    parser.add_argument("--generated-at", default="", help="Override generated_at/as_of_date, e.g. 2026-05-18T23:00:00+00:00.")
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "finlab_canonical_materialized"))
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
    out = Path(args.output_dir) / outputs.run_id
    tables = {
        "canonical_market_daily": outputs.canonical_market_daily,
        "canonical_chip_daily": outputs.canonical_chip_daily,
        "canonical_institutional_amount_daily": outputs.canonical_institutional_amount_daily,
        "canonical_market_index_daily": outputs.canonical_market_index_daily,
        "canonical_futures_daily": outputs.canonical_futures_daily,
        "canonical_regime_context_daily": outputs.canonical_regime_context_daily,
        "canonical_revenue_monthly": outputs.canonical_revenue_monthly,
        "canonical_broker_flow_daily": outputs.canonical_broker_flow_daily,
        "canonical_broker_rank_daily": outputs.canonical_broker_rank_daily,
        "finlab_taxonomy_tags": outputs.finlab_taxonomy_tags,
        "data_source_inventory": outputs.data_source_inventory,
        "source_quality_metrics": outputs.source_quality_metrics,
    }
    for name, rows in tables.items():
        write_jsonl(out / f"{name}.jsonl", rows)
    write_json(out / "manifest.json", outputs.manifest)
    print(json.dumps({
        "run_id": outputs.run_id,
        "artifact_root": outputs.artifact_root,
        "output_dir": str(out),
        "row_counts": outputs.manifest["row_counts"],
        "checksum": outputs.manifest["checksum"],
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
