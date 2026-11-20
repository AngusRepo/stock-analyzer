from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
sys.path.insert(0, str(ML_CONTROLLER))

from services.finlab_canonical_materializer import (  # noqa: E402
    materialize_finlab_canonical_outputs,
)


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()


def security_master_raw_pin(artifact_root: Path, run_id: str) -> dict:
    """Digest of the exact security_master capture, cross-checked against the capture
    manifest's per-file checksums so an apply writes the bytes the dry-run diffed."""
    raw = artifact_root / "raw" / "security_master"
    files = {path.name: _file_sha256(path) for path in sorted(raw.glob("*.parquet"))}
    if not files:
        raise SystemExit("security_master_raw_capture_missing")
    pin = {"files": files, "raw_sha256": "sha256:" + hashlib.sha256(
        json.dumps(files, sort_keys=True).encode("utf-8")).hexdigest(), "manifest_verified": []}
    manifest_path = artifact_root / "manifest.json"
    if not manifest_path.exists():
        return pin
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if run_id and manifest.get("run_id") != run_id:
        raise SystemExit(f"security_master_manifest_run_id_mismatch:{manifest.get('run_id')}")
    for report in manifest.get("source_key_reports") or []:
        expected = str(report.get("artifact_checksum") or "")
        if report.get("lane") != "security_master" or not expected:
            continue
        name = Path(str(report.get("artifact_uri") or report.get("artifact_path") or "")).name
        if files.get(name) != expected:
            raise SystemExit(f"security_master_artifact_checksum_mismatch:{name}")
        pin["manifest_verified"].append(name)
    pin["manifest_verified"].sort()
    return pin


def _current_listing(symbols: list[str]) -> dict[str, dict]:
    sys.path.insert(0, str(ROOT))
    from tools.finlab_v4_remote_backfill import d1_query
    placeholders = ",".join("?" for _ in symbols)
    rows = d1_query(f"SELECT symbol,listing_observed_at,listing_checksum FROM stocks WHERE symbol IN ({placeholders})",
                    list(symbols), domain="core")
    return {str(row.get("symbol")): row for row in rows}


def stocks_capture_blockers(rows: list[dict], current: dict[str, dict]) -> list[str]:
    """Target rows the upsert would not write: the listing_observed_at guard skips an older
    capture, and an equal clock with another checksum aborts on the conflict trigger."""
    blockers = []
    for row in rows:
        old = current.get(row["symbol"]) or {}
        observed = old.get("listing_observed_at")
        if observed and row["listing_observed_at"] < observed:
            blockers.append(f"{row['symbol']}:capture_older_than_core:{observed}")
        elif observed == row["listing_observed_at"] and old.get("listing_checksum") != row["listing_checksum"]:
            blockers.append(f"{row['symbol']}:capture_conflict_same_clock")
    return blockers


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
    parser.add_argument("--symbols", default=None,
                        help="Comma-separated allowlist for the stocks upsert; requires --datasets stocks.")
    parser.add_argument("--expect-raw-sha256", default="",
                        help="security_master raw_sha256 printed by the dry-run; required with --symbols --apply.")
    args = parser.parse_args()
    datasets = [part.strip() for part in args.datasets.split(",") if part.strip()]
    symbols = None
    if args.symbols is not None:
        symbols = [part.strip() for part in args.symbols.split(",") if part.strip()]
        if not symbols:
            # An empty allowlist must never fall through to the unscoped full upsert.
            raise SystemExit("security_master_symbols_empty")
    if args.apply and args.expect_raw_sha256 and not symbols:
        raise SystemExit("security_master_raw_pin_requires_symbols")
    raw_pin = None
    if symbols or args.expect_raw_sha256:
        raw_pin = security_master_raw_pin(Path(args.artifact_root), args.run_id)
        if symbols and args.apply:
            # A scoped apply must be the run the operator diffed: explicit run id, its
            # manifest checksums for both FinLab masters, and the dry-run's raw digest.
            if not args.run_id or not {"company_basic_info.parquet", "tw_etf_basic_info.parquet"} <= set(
                    raw_pin["manifest_verified"]):
                raise SystemExit("security_master_apply_requires_run_manifest_pin")
            if not args.expect_raw_sha256:
                raise SystemExit("security_master_apply_requires_expect_raw_sha256")
        if args.expect_raw_sha256 and args.expect_raw_sha256 != raw_pin["raw_sha256"]:
            raise SystemExit("security_master_raw_sha256_mismatch")

    outputs = materialize_finlab_canonical_outputs(
        args.artifact_root,
        run_id=args.run_id or None,
        start_date=args.start_date or None,
        end_date=args.end_date or None,
        limit_per_dataset=args.limit_per_dataset or None,
        generated_at=args.generated_at or None,
        datasets=datasets or None,
        symbols=symbols,
    )
    summary = {
        "mode": "apply" if args.apply else "dry_run",
        "run_id": outputs.run_id,
        "artifact_root": outputs.artifact_root,
        "row_counts": outputs.manifest["row_counts"],
        "checksum": outputs.manifest["checksum"],
    }
    if raw_pin is not None:
        summary["raw_pin"] = raw_pin
    if symbols:
        summary["symbol_filter"] = outputs.manifest.get("symbol_filter")
        summary["stocks_rows"] = [
            {key: row.get(key) for key in ("symbol", "name", "market", "listing_market", "listed_date",
                                           "listed_date_source", "listing_observed_at")}
            for row in outputs.security_master]

    if symbols and args.apply:
        arbitration = outputs.manifest.get("venue_arbitration") or {}
        if arbitration.get("official_snapshot") is not True:
            raise SystemExit("security_master_apply_requires_official_snapshot")
        blockers = stocks_capture_blockers(outputs.security_master, _current_listing(symbols))
        if blockers:
            raise SystemExit("security_master_apply_rows_not_writable:" + ",".join(blockers))

    # Dry-run and apply share the daily owner's domain routing and ordering.
    sys.path.insert(0, str(ROOT))
    from tools.finlab_v4_remote_backfill import materialize_canonical_to_d1
    result = materialize_canonical_to_d1(
        {"run_id": outputs.run_id, "generated_at": outputs.generated_at, "artifact_root": outputs.artifact_root},
        start_date=args.start_date or None, end_date=args.end_date or None,
        datasets=datasets, canonical_outputs=outputs, chunk_size=args.chunk_size, dry_run=not args.apply,
    )
    summary.update(result)
    unwritten = []
    if symbols and args.apply:
        # Count rows actually holding this capture, not acknowledged statements.
        current = _current_listing(symbols)
        unwritten = sorted(row["symbol"] for row in outputs.security_master
                           if (current.get(row["symbol"]) or {}).get("listing_checksum") != row["listing_checksum"]
                           or (current.get(row["symbol"]) or {}).get("listing_observed_at") != row["listing_observed_at"])
        summary["stocks_rows_written"] = len(outputs.security_master) - len(unwritten)
        summary["stocks_rows_unwritten"] = unwritten
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True, default=str))
    if int(result["apply_result"].get("error_count") or 0) > 0 or unwritten:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
