import pytest

from tools.repair_finlab_taxonomy_owner import (
    SnapshotRepair,
    _backup_receipt_digest,
    _cleanup_legacy_taxonomy,
    _snapshot_repairs,
    _validate_snapshot_matrix,
)


class FakeMarket:
    def query(self, sql, params=None):
        if "FROM sector_taxonomy_snapshot_runs_v1" in sql:
            return [{
                "snapshot_date": "2026-09-02",
                "tag_type": "industry_theme",
                "snapshot_id": "legacy-id",
                "membership_checksum": "legacy-checksum",
                "expected_row_count": 3,
                "persisted_row_count": 3,
                "status": "ready",
            }]
        if "FROM sector_taxonomy_membership_snapshots_v1" in sql:
            assert params == ["2026-09-02", "industry_theme"]
            return [
                {"tag": "AI", "symbol": "2330", "source": "finlab.security_industry_themes", "source_as_of_date": "2026-09-02"},
                {"tag": "AI", "symbol": "2382", "source": "finlab.security_industry_themes", "source_as_of_date": "2026-09-02"},
                {"tag": "手寫舊分類", "symbol": "2330", "source": "manual_curated_2026_04_08", "source_as_of_date": "2026-09-02"},
            ]
        return []


def test_snapshot_repair_removes_legacy_membership_and_rekeys_manifest():
    repairs = _snapshot_repairs(FakeMarket())

    assert len(repairs) == 1
    repair = repairs[0]
    assert repair.canonical_rows == 2
    assert repair.canonical_source_rows == 2
    assert repair.legacy_rows == 1
    assert repair.stale_owner_rows == 0
    assert repair.needs_repair is True
    assert repair.new_snapshot_id.startswith("sector-taxonomy-2026-09-02-industry_theme-")
    assert len(repair.new_checksum) == 64


def _repair(tag_type: str) -> SnapshotRepair:
    return SnapshotRepair(
        snapshot_date="2026-09-02",
        tag_type=tag_type,
        expected_source="finlab",
        canonical_source_rows=1,
        canonical_rows=1,
        legacy_rows=0,
        stale_owner_rows=0,
        old_snapshot_id="old",
        new_snapshot_id="new",
        old_checksum="old",
        new_checksum="new",
        needs_repair=True,
    )


def test_snapshot_matrix_requires_all_formal_finlab_layers_per_date():
    _validate_snapshot_matrix([_repair("industry"), _repair("industry_theme"), _repair("subindustry")])

    with pytest.raises(RuntimeError, match="snapshot_matrix_incomplete"):
        _validate_snapshot_matrix([_repair("industry"), _repair("industry_theme")])


def test_apply_requires_sha256_backup_receipt():
    assert len(_backup_receipt_digest("sha256:" + "a" * 64)) == 16
    with pytest.raises(RuntimeError, match="backup_receipt_invalid"):
        _backup_receipt_digest("missing")


class CaptureMarket:
    def __init__(self):
        self.sql = []

    def execute(self, sql, timeout=0):
        self.sql.append(" ".join(sql.split()))
        return {"meta": {"changes": 1}}


def test_cleanup_removes_all_retired_owners_after_rebuild():
    market = CaptureMarket()
    changes = _cleanup_legacy_taxonomy(market)

    assert set(changes) == {
        "stock_tags",
        "concept_membership_snapshots",
        "concept_snapshot_runs",
        "unexpected_finlab_sources",
        "stock_profile_sector",
        "legacy_theme_sector_flow",
        "orphan_sector_flow_stocks",
    }
    assert "DELETE FROM stock_tags" in market.sql
    assert any("tag_type='concept'" in sql for sql in market.sql)
    assert any("classification='theme'" in sql for sql in market.sql)
