"""Audit and repair the FinLab taxonomy single-owner cutover.

Dry-run is the default. ``--apply`` is intentionally explicit because it
repairs persisted snapshot identities, rebuilds derived sector-flow slices,
and removes legacy classification owners from D1.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = REPO_ROOT / "ml-controller"
if str(ML_CONTROLLER) not in sys.path:
    sys.path.insert(0, str(ML_CONTROLLER))

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain  # noqa: E402
from services.sector_flow_service import (  # noqa: E402
    _taxonomy_snapshot_identity,
    run_sector_flow_pipeline,
)


EXPECTED_SOURCES = {
    "industry": "finlab.security_categories",
    "industry_theme": "finlab.security_industry_themes",
    "subindustry": "finlab.security_industry_themes",
}
FORMAL_CLASSIFICATIONS = tuple(EXPECTED_SOURCES)
BACKUP_RECEIPT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class SnapshotRepair:
    snapshot_date: str
    tag_type: str
    expected_source: str
    canonical_source_rows: int
    canonical_rows: int
    legacy_rows: int
    stale_owner_rows: int
    old_snapshot_id: str
    new_snapshot_id: str
    old_checksum: str
    new_checksum: str
    needs_repair: bool


def _owner_audit(market: Any) -> dict[str, Any]:
    canonical = market.query(
        """
        SELECT tag_type, source, COUNT(*) AS rows, COUNT(DISTINCT symbol) AS symbols,
               MAX(as_of_date) AS latest_as_of_date
          FROM finlab_taxonomy_tags
         WHERE (tag_type='industry' AND source='finlab.security_categories')
            OR (tag_type IN ('industry_theme','subindustry')
                AND source='finlab.security_industry_themes')
         GROUP BY tag_type, source
         ORDER BY tag_type
        """
    )
    legacy = market.query(
        """
        SELECT tag_type, source, COUNT(*) AS rows, COUNT(DISTINCT symbol) AS symbols
          FROM stock_tags
         GROUP BY tag_type, source
         ORDER BY tag_type, source
        """
    )
    unexpected = market.query(
        """
        SELECT tag_type, source, COUNT(*) AS rows, COUNT(DISTINCT symbol) AS symbols
          FROM finlab_taxonomy_tags
         WHERE tag_type IN ('industry','industry_theme','subindustry')
           AND NOT (
             (tag_type='industry' AND source='finlab.security_categories')
             OR (tag_type IN ('industry_theme','subindustry')
                 AND source='finlab.security_industry_themes')
           )
         GROUP BY tag_type, source
         ORDER BY tag_type, source
        """
    )
    profile = market.query(
        "SELECT COUNT(*) AS rows FROM stock_profiles WHERE sector IS NOT NULL AND TRIM(sector)<>''"
    )
    industry = next((row for row in canonical if str(row.get("tag_type")) == "industry"), {})
    return {
        "owner": "finlab_taxonomy_tags",
        "canonical": canonical,
        "industry_duplicate_rows": max(
            0,
            int(industry.get("rows") or 0) - int(industry.get("symbols") or 0),
        ),
        "legacy_stock_tags": legacy,
        "unexpected_finlab_sources": unexpected,
        "legacy_stock_profile_sector_rows": int((profile[0] if profile else {}).get("rows") or 0),
    }


def _snapshot_repairs(market: Any) -> list[SnapshotRepair]:
    runs = market.query(
        """
        SELECT snapshot_date, tag_type, snapshot_id, membership_checksum,
               expected_row_count, persisted_row_count, status
          FROM sector_taxonomy_snapshot_runs_v1
         WHERE tag_type IN ('industry','industry_theme','subindustry')
         ORDER BY snapshot_date, tag_type
        """
    )
    repairs: list[SnapshotRepair] = []
    for run in runs:
        snapshot_date = str(run.get("snapshot_date") or "")
        tag_type = str(run.get("tag_type") or "")
        expected_source = EXPECTED_SOURCES[tag_type]
        rows = market.query(
            """
            SELECT tag, symbol, source, source_as_of_date
              FROM sector_taxonomy_membership_snapshots_v1
             WHERE snapshot_date=? AND tag_type=?
             ORDER BY tag, symbol
            """,
            [snapshot_date, tag_type],
        )
        canonical_source_rows = [row for row in rows if str(row.get("source") or "") == expected_source]
        if not canonical_source_rows:
            raise RuntimeError(f"canonical_snapshot_empty:{snapshot_date}:{tag_type}")
        canonical_rows = canonical_source_rows
        if tag_type == "industry":
            by_symbol: dict[str, dict[str, Any]] = {}
            for row in canonical_source_rows:
                symbol = str(row.get("symbol") or "")
                incumbent = by_symbol.get(symbol)
                rank = (str(row.get("source_as_of_date") or ""), str(row.get("tag") or ""))
                incumbent_rank = (
                    str(incumbent.get("source_as_of_date") or ""),
                    str(incumbent.get("tag") or ""),
                ) if incumbent else None
                if incumbent_rank is None or rank[0] > incumbent_rank[0] or (
                    rank[0] == incumbent_rank[0] and rank[1] < incumbent_rank[1]
                ):
                    by_symbol[symbol] = row
            canonical_rows = list(by_symbol.values())
        by_tag: dict[str, list[str]] = {}
        for row in canonical_rows:
            tag = str(row.get("tag") or "").strip()
            symbol = str(row.get("symbol") or "").strip()
            if tag and symbol:
                by_tag.setdefault(tag, []).append(symbol)
        snapshot_id, checksum = _taxonomy_snapshot_identity(tag_type, snapshot_date, by_tag)
        old_snapshot_id = str(run.get("snapshot_id") or "")
        old_checksum = str(run.get("membership_checksum") or "")
        needs_repair = any((
            len(canonical_rows) != len(rows),
            old_snapshot_id != snapshot_id,
            old_checksum != checksum,
            int(run.get("expected_row_count") or 0) != len(canonical_rows),
            int(run.get("persisted_row_count") or 0) != len(canonical_rows),
            str(run.get("status") or "") != "ready",
        ))
        repairs.append(SnapshotRepair(
            snapshot_date=snapshot_date,
            tag_type=tag_type,
            expected_source=expected_source,
            canonical_source_rows=len(canonical_source_rows),
            canonical_rows=len(canonical_rows),
            legacy_rows=len(rows) - len(canonical_source_rows),
            stale_owner_rows=len(canonical_source_rows) - len(canonical_rows),
            old_snapshot_id=old_snapshot_id,
            new_snapshot_id=snapshot_id,
            old_checksum=old_checksum,
            new_checksum=checksum,
            needs_repair=needs_repair,
        ))
    return repairs


def _validate_canonical_owner(audit: dict[str, Any]) -> None:
    present = {str(row.get("tag_type")): int(row.get("symbols") or 0) for row in audit["canonical"]}
    missing = [tag_type for tag_type in EXPECTED_SOURCES if present.get(tag_type, 0) <= 0]
    if missing:
        raise RuntimeError(f"finlab_taxonomy_owner_incomplete:{','.join(missing)}")


def _validate_snapshot_matrix(repairs: list[SnapshotRepair]) -> None:
    by_date: dict[str, set[str]] = {}
    for repair in repairs:
        by_date.setdefault(repair.snapshot_date, set()).add(repair.tag_type)
    expected = set(EXPECTED_SOURCES)
    invalid = {
        snapshot_date: sorted(expected - tag_types)
        for snapshot_date, tag_types in by_date.items()
        if tag_types != expected
    }
    if not by_date:
        raise RuntimeError("formal_taxonomy_snapshot_matrix_empty")
    if invalid:
        raise RuntimeError(
            f"formal_taxonomy_snapshot_matrix_incomplete:{json.dumps(invalid, ensure_ascii=False, sort_keys=True)}"
        )


def _backup_receipt_digest(receipt: str) -> str:
    if not BACKUP_RECEIPT_RE.fullmatch(receipt):
        raise RuntimeError("taxonomy_backup_receipt_invalid")
    return hashlib.sha256(receipt.encode("utf-8")).hexdigest()[:16]


def _apply_snapshot_repairs(market: Any, repairs: list[SnapshotRepair]) -> None:
    for repair in repairs:
        if not repair.needs_repair:
            continue
        statements = [
            (
                "DELETE FROM sector_taxonomy_membership_snapshots_v1 "
                "WHERE snapshot_date=? AND tag_type=? AND source<>?",
                [repair.snapshot_date, repair.tag_type, repair.expected_source],
            ),
        ]
        if repair.tag_type == "industry":
            statements.append((
                "DELETE FROM sector_taxonomy_membership_snapshots_v1 "
                "WHERE rowid IN ("
                "SELECT victim.rowid FROM sector_taxonomy_membership_snapshots_v1 victim "
                "WHERE victim.snapshot_date=? AND victim.tag_type='industry' AND victim.source=? "
                "AND EXISTS ("
                "SELECT 1 FROM sector_taxonomy_membership_snapshots_v1 better "
                "WHERE better.snapshot_date=victim.snapshot_date "
                "AND better.tag_type=victim.tag_type AND better.source=victim.source "
                "AND better.symbol=victim.symbol "
                "AND (date(better.source_as_of_date)>date(victim.source_as_of_date) "
                "OR (date(better.source_as_of_date)=date(victim.source_as_of_date) "
                "AND better.tag<victim.tag))))",
                [repair.snapshot_date, repair.expected_source],
            ))
        statements.extend([
            (
                "UPDATE sector_taxonomy_membership_snapshots_v1 "
                "SET snapshot_id=?, membership_checksum=? "
                "WHERE snapshot_date=? AND tag_type=? AND source=?",
                [repair.new_snapshot_id, repair.new_checksum, repair.snapshot_date,
                 repair.tag_type, repair.expected_source],
            ),
            (
                "UPDATE sector_taxonomy_snapshot_runs_v1 "
                "SET snapshot_id=?, membership_checksum=?, expected_row_count=?, "
                "persisted_row_count=?, status='ready', error_code=NULL, "
                "completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP "
                "WHERE snapshot_date=? AND tag_type=?",
                [repair.new_snapshot_id, repair.new_checksum, repair.canonical_rows,
                 repair.canonical_rows, repair.snapshot_date, repair.tag_type],
            ),
        ])
        market.atomic_batch_execute(statements, timeout=90)


def _sync_core_projection(market: Any, core: Any) -> dict[str, int]:
    rows = market.query(
        """
        SELECT symbol, tag
          FROM (
            SELECT symbol, tag,
                   ROW_NUMBER() OVER (
                     PARTITION BY symbol ORDER BY date(as_of_date) DESC, tag ASC
                   ) AS rn
              FROM finlab_taxonomy_tags
             WHERE tag_type='industry' AND source='finlab.security_categories'
          )
         WHERE rn=1
         ORDER BY symbol
        """
    )
    canonical = {str(row["symbol"]): str(row["tag"]) for row in rows}
    stocks = core.query("SELECT symbol, sector FROM stocks ORDER BY symbol")
    changed = [
        row for row in stocks
        if (str(row.get("sector") or "").strip() or None) != canonical.get(str(row.get("symbol")))
    ]
    statements = [
        (
            "UPDATE stocks SET sector=?, updated_at=CURRENT_TIMESTAMP WHERE symbol=?",
            [canonical.get(str(row.get("symbol"))), str(row.get("symbol"))],
        )
        for row in changed
    ]
    if statements:
        core.batch_execute(statements, timeout=90, chunk_size=100)
    return {
        "canonical_symbols": len(canonical),
        "core_symbols": len(stocks),
        "updated": len(changed),
        "cleared": sum(1 for row in changed if str(row.get("symbol")) not in canonical),
    }


def _rebuild_sector_flow(market: Any, repairs: list[SnapshotRepair]) -> list[dict[str, Any]]:
    dates = sorted({repair.snapshot_date for repair in repairs})
    results: list[dict[str, Any]] = []
    for snapshot_date in dates:
        result = run_sector_flow_pipeline(snapshot_date, reconstruction_mode="historical_reconstruction")
        errors = {
            tag_type: result.get(tag_type, {}).get("error")
            for tag_type in EXPECTED_SOURCES
            if result.get(tag_type, {}).get("error")
        }
        if errors:
            raise RuntimeError(f"sector_flow_rebuild_failed:{snapshot_date}:{json.dumps(errors, ensure_ascii=False)}")
        results.append({
            "date": snapshot_date,
            "rows_written": sum(int(result.get(tag_type, {}).get("written") or 0) for tag_type in EXPECTED_SOURCES),
        })
    # Once every legal date was rebuilt, remove formal derived rows that have
    # no immutable FinLab snapshot and therefore cannot be trusted as PIT data.
    market.execute(
        """
        DELETE FROM sector_flow
         WHERE classification IN ('industry','industry_theme','subindustry')
           AND NOT EXISTS (
             SELECT 1
               FROM sector_taxonomy_snapshot_runs_v1 runs
              WHERE runs.snapshot_date=sector_flow.date
                AND runs.tag_type=sector_flow.classification
                AND runs.status='ready'
           )
        """,
        timeout=90,
    )
    return results


def _cleanup_legacy_taxonomy(market: Any) -> dict[str, int]:
    statements = {
        "stock_tags": "DELETE FROM stock_tags",
        "concept_membership_snapshots": (
            "DELETE FROM sector_taxonomy_membership_snapshots_v1 WHERE tag_type='concept'"
        ),
        "concept_snapshot_runs": (
            "DELETE FROM sector_taxonomy_snapshot_runs_v1 WHERE tag_type='concept'"
        ),
        "unexpected_finlab_sources": """
            DELETE FROM finlab_taxonomy_tags
             WHERE tag_type IN ('industry','industry_theme','subindustry')
               AND NOT (
                 (tag_type='industry' AND source='finlab.security_categories')
                 OR (tag_type IN ('industry_theme','subindustry')
                     AND source='finlab.security_industry_themes')
               )
        """,
        "stock_profile_sector": (
            "UPDATE stock_profiles SET sector=NULL "
            "WHERE sector IS NOT NULL AND TRIM(sector)<>''"
        ),
        "legacy_theme_sector_flow": "DELETE FROM sector_flow WHERE classification='theme'",
        "orphan_sector_flow_stocks": """
            DELETE FROM sector_flow_stocks
             WHERE NOT EXISTS (
               SELECT 1
                 FROM sector_taxonomy_snapshot_runs_v1 runs
                WHERE runs.snapshot_date=sector_flow_stocks.date
                  AND runs.tag_type='industry_theme'
                  AND runs.status='ready'
             )
        """,
    }
    changes: dict[str, int] = {}
    for name, sql in statements.items():
        result = market.execute(sql, timeout=90)
        changes[name] = int((result.get("meta") or {}).get("changes") or 0)
    return changes


def _post_cutover_audit(market: Any) -> dict[str, int]:
    rows = market.query(
        """
        SELECT
          (SELECT COUNT(*) FROM stock_tags) AS stock_tags,
          (SELECT COUNT(*) FROM sector_taxonomy_membership_snapshots_v1
            WHERE tag_type='concept') AS concept_membership_snapshots,
          (SELECT COUNT(*) FROM sector_taxonomy_snapshot_runs_v1
            WHERE tag_type='concept') AS concept_snapshot_runs,
          (SELECT COUNT(*) FROM sector_flow WHERE classification='theme') AS legacy_theme_sector_flow,
          (SELECT COUNT(*) FROM sector_flow_stocks details
            WHERE NOT EXISTS (
              SELECT 1 FROM sector_taxonomy_snapshot_runs_v1 runs
               WHERE runs.snapshot_date=details.date
                 AND runs.tag_type='industry_theme'
                 AND runs.status='ready'
            )) AS orphan_sector_flow_stocks,
          (SELECT COUNT(*) FROM sector_taxonomy_snapshot_runs_v1
            WHERE tag_type IN ('industry','industry_theme','subindustry')
              AND status<>'ready') AS non_ready_formal_runs
        """
    )
    if not rows:
        raise RuntimeError("finlab_taxonomy_post_cutover_audit_missing")
    return {key: int(value or 0) for key, value in rows[0].items()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--confirm-owner-cutover",
        default="",
        help="Required with --apply; must equal finlab_taxonomy_tags.",
    )
    parser.add_argument(
        "--backup-receipt",
        default="",
        help="Required with --apply; sha256 receipt for the verified pre-cutover exports.",
    )
    args = parser.parse_args()
    if args.apply and args.confirm_owner_cutover != "finlab_taxonomy_tags":
        parser.error("--apply requires --confirm-owner-cutover finlab_taxonomy_tags")
    backup_receipt_digest = ""
    if args.apply:
        backup_receipt_digest = _backup_receipt_digest(args.backup_receipt)

    market = client_proxy_for_domain(D1DataDomain.MARKET)
    core = client_proxy_for_domain(D1DataDomain.CORE)
    before = _owner_audit(market)
    _validate_canonical_owner(before)
    repairs = _snapshot_repairs(market)
    _validate_snapshot_matrix(repairs)
    payload: dict[str, Any] = {
        "mode": "apply" if args.apply else "dry_run",
        "backup_receipt_digest": backup_receipt_digest or None,
        "before": before,
        "snapshot_summary": {
            "total": len(repairs),
            "needs_repair": sum(1 for repair in repairs if repair.needs_repair),
            "legacy_membership_rows": sum(repair.legacy_rows for repair in repairs),
            "stale_owner_membership_rows": sum(repair.stale_owner_rows for repair in repairs),
            "dates": sorted({repair.snapshot_date for repair in repairs}),
        },
        "repairs": [asdict(repair) for repair in repairs],
    }
    if not args.apply:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    _apply_snapshot_repairs(market, repairs)
    market.execute(
        """
        DELETE FROM finlab_taxonomy_tags
         WHERE rowid IN (
           SELECT victim.rowid
             FROM finlab_taxonomy_tags victim
            WHERE victim.tag_type='industry'
              AND victim.source='finlab.security_categories'
              AND EXISTS (
                SELECT 1
                  FROM finlab_taxonomy_tags better
                 WHERE better.symbol=victim.symbol
                   AND better.tag_type=victim.tag_type
                   AND better.source=victim.source
                   AND (date(better.as_of_date)>date(victim.as_of_date)
                     OR (date(better.as_of_date)=date(victim.as_of_date)
                         AND better.tag<victim.tag))
              )
         )
        """,
        timeout=90,
    )
    payload["core_projection"] = _sync_core_projection(market, core)
    payload["sector_flow_rebuild"] = _rebuild_sector_flow(market, repairs)
    payload["legacy_cleanup"] = _cleanup_legacy_taxonomy(market)
    payload["after"] = _owner_audit(market)
    payload["post_cutover"] = _post_cutover_audit(market)
    if (
        payload["after"]["legacy_stock_tags"]
        or payload["after"]["unexpected_finlab_sources"]
        or payload["after"]["industry_duplicate_rows"]
        or payload["after"]["legacy_stock_profile_sector_rows"]
        or any(payload["post_cutover"].values())
    ):
        raise RuntimeError("finlab_taxonomy_owner_cleanup_incomplete")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
