from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
for candidate in (ROOT, ML_CONTROLLER):
    text = str(candidate)
    if text not in sys.path:
        sys.path.insert(0, text)

from services.finlab_canonical_materializer import (  # noqa: E402
    build_d1_upsert_statements,
    materialize_finlab_canonical_outputs,
)
from tools.finlab_v4_remote_backfill import (  # noqa: E402
    OFFICIAL_MARKET_SUMMARY_LOOKBACK_DAYS,
    fetch_official_market_summary_frames,
    normalize_context_frame,
    write_parquet,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def latest_date(frame: Any) -> str | None:
    if frame is None or getattr(frame, "empty", True) or "date" not in frame.columns:
        return None
    series = frame["date"].dropna()
    if series.empty:
        return None
    return str(series.max())[:10]


def write_market_summary_artifacts(artifact_root: Path, frames: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_dir = artifact_root / "raw" / "market_summary"
    raw_dir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, dict[str, Any]] = {}
    for name, frame in frames.items():
        normalized = normalize_context_frame(frame)
        path = raw_dir / f"{name}.parquet"
        write_parquet(path, normalized)
        summary[name] = {
            "rows": int(len(normalized)),
            "columns": [str(column) for column in normalized.columns],
            "latest_date": latest_date(normalized),
            "path": str(path),
        }
    return summary


def build_market_summary_statements(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
) -> tuple[dict[str, Any], list[tuple[str, list[Any]]]]:
    outputs = materialize_finlab_canonical_outputs(
        artifact_root,
        run_id=run_id,
        generated_at=generated_at,
        start_date=start_date,
        end_date=end_date,
        datasets=["canonical_market_summary_daily"],
        include_emerging=False,
    )
    statements = build_d1_upsert_statements(outputs)
    return outputs.manifest, statements


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch official TWSE/TPEX market summary and materialize canonical_market_summary_daily."
    )
    parser.add_argument("--lookback-days", type=int, default=OFFICIAL_MARKET_SUMMARY_LOOKBACK_DAYS)
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "market_summary_repair"))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--start-date", default="")
    parser.add_argument("--end-date", default="")
    parser.add_argument("--generated-at", default="")
    parser.add_argument("--chunk-size", type=int, default=250)
    parser.add_argument("--apply", action="store_true", help="Write to D1. Omit for dry-run.")
    args = parser.parse_args()

    generated_at = args.generated_at or utc_now()
    run_id = args.run_id or f"market_summary_once_{generated_at[:10]}"
    artifact_root = Path(args.output_dir) / run_id
    frames = fetch_official_market_summary_frames(max(1, int(args.lookback_days)))
    frame_summary = write_market_summary_artifacts(artifact_root, frames)
    manifest, statements = build_market_summary_statements(
        artifact_root,
        run_id=run_id,
        generated_at=generated_at,
        start_date=args.start_date or None,
        end_date=args.end_date or None,
    )
    payload: dict[str, Any] = {
        "schema_version": "market-summary-once-v1",
        "mode": "apply" if args.apply else "dry_run",
        "run_id": run_id,
        "generated_at": generated_at,
        "artifact_root": str(artifact_root),
        "frame_summary": frame_summary,
        "row_counts": manifest.get("row_counts", {}),
        "statement_count": len(statements),
        "checksum": manifest.get("checksum"),
    }

    if args.apply:
        from services.d1_client import batch_execute  # noqa: WPS433

        payload["d1_result"] = batch_execute(statements, chunk_size=args.chunk_size, timeout=120.0)

    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))
    result = payload.get("d1_result")
    if isinstance(result, dict) and int(result.get("error_count") or 0) > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
