"""Runner that attaches immutable S12 entry/exit timestamps before evaluation."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from datetime import date, timedelta
from pathlib import Path

import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "s12_state_space_post_exit_validation",
    REPO_ROOT / "tools/s12_state_space_post_exit_validation.py",
)
assert SPEC and SPEC.loader
VALIDATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATION)


def load_immutable_timestamps(client: object, ids: list[int]) -> pl.DataFrame:
    rows: list[dict] = []
    for offset in range(0, len(ids), 80):
        chunk = ids[offset : offset + 80]
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(
            client.query(
                VALIDATION.BASE.LEARNING_DB_ID_DEFAULT,
                f"SELECT id, entry_ms, exit_ms FROM s12_replay_trade_outcomes WHERE id IN ({placeholders})",
                chunk,
            )
        )
    return pl.DataFrame(rows, schema={"id": pl.Int64, "entry_ms": pl.Int64, "exit_ms": pl.Int64})


def main() -> int:
    source_path = REPO_ROOT / "output/s12_state_space_pit_validation/joined_evidence.parquet"
    output_dir = REPO_ROOT / "output/s12_state_space_post_exit_validation"
    source = pl.read_parquet(source_path)
    client = VALIDATION.BASE.D1ReadClient(
        token=os.environ.get("CF_API_TOKEN", ""),
        account_id=os.environ.get("CF_ACCOUNT_ID", VALIDATION.BASE.ACCOUNT_ID_DEFAULT),
    )
    try:
        timestamps = load_immutable_timestamps(client, source["id"].to_list())
        source = source.join(timestamps, on="id", how="left", validate="1:1")
        profit_exits = source.filter(
            pl.col("exit_reason").is_in(sorted(VALIDATION.PROFIT_EXIT_REASONS))
        )
        start_date = min(profit_exits["trade_date"].to_list())
        end_date = (
            date.fromisoformat(max(profit_exits["trade_date"].to_list())) + timedelta(days=14)
        ).isoformat()
        manifests = VALIDATION.load_manifests(client, start_date, end_date)
    finally:
        client.close()
    selected = VALIDATION.select_required_manifests(profit_exits, manifests)
    documents, download_errors = asyncio.run(
        VALIDATION.download_artifacts(
            selected,
            account_id=os.environ.get("CF_ACCOUNT_ID", VALIDATION.BASE.ACCOUNT_ID_DEFAULT),
        )
    )
    samples, unavailable = VALIDATION.build_post_exit_samples(
        profit_exits, selected, documents
    )
    report = VALIDATION.evaluate_post_exit(samples)
    report["source_receipt"] = {
        "profit_exit_outcomes": profit_exits.height,
        "immutable_timestamp_rows": timestamps.height,
        "manifest_window": {"start": start_date, "end": end_date},
        "manifests_scanned": len(manifests),
        "manifests_selected": len(selected),
        "artifacts_downloaded": len(documents),
        "download_errors": download_errors,
        "unavailable": unavailable,
        "input_checksum": VALIDATION.BASE._sha256(source.to_dicts()),
        "selected_manifest_checksum": VALIDATION.BASE._sha256(selected),
    }
    report["result_checksum"] = VALIDATION.BASE._sha256(
        {key: value for key, value in report.items() if key != "result_checksum"}
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8"
    )
    if not samples.is_empty():
        samples.write_parquet(output_dir / "post_exit_samples.parquet")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
