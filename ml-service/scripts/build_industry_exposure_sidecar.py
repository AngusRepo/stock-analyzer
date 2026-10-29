#!/usr/bin/env python3
"""Build the PIT industry sidecar for the §7 challengers (local file only).

Reads D1 ``sector_taxonomy_membership_snapshots_v1`` read-only through
``wrangler@4 d1 execute --json`` (ready runs only, one query per snapshot date),
keeps symbols with exactly one industry per snapshot, and writes an immutable
npz plus its sha256.  Uploading to GCS is a separate, approved step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.industry_exposure import encode_industry_sidecar

SOURCE_FILTER = "m.tag_type='industry' AND m.source='finlab.security_categories'"
# Sentinel for the approved rule-inferred mode: earlier than any signal date.
BACKFILL_SNAPSHOT_DATE = "0001-01-01"


def _d1(sql: str, *, worker_dir: Path) -> list[dict]:
    out = subprocess.run(
        ["npx", "wrangler@4", "d1", "execute", "stockvision-market-db", "--remote", "--json", "--command", sql],
        cwd=worker_dir, capture_output=True, text=True, encoding="utf-8", check=True, shell=sys.platform == "win32",
    ).stdout
    payload = json.loads(out[out.index("["):])
    if not payload or payload[0].get("success") is not True:
        raise RuntimeError("d1_query_failed")
    return payload[0]["results"]


def fetch_membership(worker_dir: Path) -> list[dict]:
    dates = [r["snapshot_date"] for r in _d1(
        "SELECT DISTINCT m.snapshot_date FROM sector_taxonomy_membership_snapshots_v1 m "
        "JOIN sector_taxonomy_snapshot_runs_v1 r ON r.snapshot_id=m.snapshot_id AND r.status='ready' "
        f"WHERE {SOURCE_FILTER} ORDER BY m.snapshot_date", worker_dir=worker_dir)]
    rows: list[dict] = []
    for day in dates:
        if len(day) != 10 or day[4] != "-" or day[7] != "-":
            raise ValueError(f"snapshot_date_invalid:{day}")
        rows.extend(_d1(
            "SELECT m.snapshot_date, m.symbol, m.tag, m.membership_checksum FROM sector_taxonomy_membership_snapshots_v1 m "
            "JOIN sector_taxonomy_snapshot_runs_v1 r ON r.snapshot_id=m.snapshot_id AND r.status='ready' "
            f"WHERE {SOURCE_FILTER} AND m.snapshot_date='{day}' AND TRIM(m.tag) NOT IN ('', 'nan', 'None')",
            worker_dir=worker_dir))
    return rows


def single_industry_rows(rows: list[dict]) -> tuple[list[tuple[str, str, str]], int]:
    by_key: dict[tuple[str, str], set[str]] = {}
    for row in rows:
        symbol, tag = str(row["symbol"]).strip(), str(row["tag"]).strip()
        if symbol and tag:
            by_key.setdefault((symbol, str(row["snapshot_date"])), set()).add(tag)
    kept = [(sym, day, next(iter(tags))) for (sym, day), tags in sorted(by_key.items()) if len(tags) == 1]
    return kept, len(by_key) - len(kept)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--worker-dir", type=Path, default=Path(__file__).resolve().parents[2] / "worker")
    parser.add_argument("--from-json", type=Path, help="Rows previously exported from D1 (list of dicts).")
    parser.add_argument("--rule-inferred-backfill", action="store_true",
                        help="Reuse the first snapshot for earlier dates. Only with Wei's explicit approval.")
    args = parser.parse_args()
    rows = json.loads(args.from_json.read_text(encoding="utf-8")) if args.from_json else fetch_membership(args.worker_dir)
    kept, multi = single_industry_rows(rows)
    if not kept:
        raise SystemExit("industry_membership_empty")
    first_day = min(day for _s, day, _t in kept)
    if args.rule_inferred_backfill:
        kept += [(sym, BACKFILL_SNAPSHOT_DATE, tag) for sym, day, tag in kept if day == first_day]
    raw = encode_industry_sidecar(
        symbols=[r[0] for r in kept], snapshot_dates=[r[1] for r in kept], industries=[r[2] for r in kept],
        pit_status="rule_inferred_backfill" if args.rule_inferred_backfill else "pit_snapshot",
        source={
            "table": "stockvision-market-db.sector_taxonomy_membership_snapshots_v1",
            "filter": "tag_type=industry, source=finlab.security_categories, run status=ready",
            "first_pit_snapshot_date": first_day,
            "multi_industry_symbol_snapshots_dropped": multi,
            "membership_checksums": sorted({str(r.get("membership_checksum") or "") for r in rows} - {""}),
        },
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(raw)
    print(json.dumps({"path": str(args.out), "sha256": hashlib.sha256(raw).hexdigest(), "rows": len(kept),
                      "first_pit_snapshot_date": first_day, "rule_inferred_backfill": args.rule_inferred_backfill}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
