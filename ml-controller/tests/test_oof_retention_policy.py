from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.oof_retention_policy import (  # noqa: E402
    build_oof_date_eligibility_rows, classify_oof_retention,
)


def test_oof_retention_blocks_when_date_legality_is_incomplete():
    out = classify_oof_retention(
        legal_dates=10,
        illegal_dates=0,
        pending_dates=1,
        hard_reference_count=0,
        archive_verified=True,
        cohort_ready=False,
    )
    assert out["retention_action"] == "retain_hot"
    assert out["blocker_reason"] == "date_eligibility_evidence_incomplete"


def test_oof_retention_blocks_active_hard_references():
    out = classify_oof_retention(
        legal_dates=0,
        illegal_dates=6,
        pending_dates=0,
        hard_reference_count=1,
        archive_verified=True,
        cohort_ready=False,
    )
    assert out["retention_action"] == "retain_hot"
    assert out["blocker_reason"] == "active_artifact_hard_reference"


def test_oof_retention_requires_verified_archive_before_hot_delete():
    out = classify_oof_retention(
        legal_dates=0,
        illegal_dates=6,
        pending_dates=0,
        hard_reference_count=0,
        archive_verified=False,
        cohort_ready=False,
    )
    assert out["retention_action"] == "archive_required"


def test_oof_retention_allows_hot_delete_only_after_all_guards():
    out = classify_oof_retention(
        legal_dates=0,
        illegal_dates=6,
        pending_dates=0,
        hard_reference_count=0,
        archive_verified=True,
        cohort_ready=False,
    )
    assert out["retention_action"] == "delete_hot"
    assert out["status"] == "verified"


def _prediction(day: str, label_known_date: str) -> dict:
    return {
        "prediction_date": day,
        "label_known_date": label_known_date,
        "target_semantic_version": "target-v1",
    }


def _snapshot(day: str, label_known_date: str) -> dict:
    return {
        "snapshot_date": day,
        "label_known_date": label_known_date,
        "generation_mode": "purged_oof",
        "source_manifest_checksum": "a" * 64,
    }


def _l4(day: str, trained_until: str) -> dict:
    return {
        "prediction_date": day,
        "trained_until": trained_until,
        "eligible_for_efficacy": 1,
    }


def test_oof_date_eligibility_keeps_snapshot_l4_and_fusion_scopes_separate():
    rows = build_oof_date_eligibility_rows(
        cohort_id="cohort-1",
        source_manifest_checksum="a" * 64,
        prediction_rows=[
            _prediction("2026-07-08", "2026-07-15"),
            _prediction("2026-07-09", "2026-07-27"),
        ],
        snapshot_rows=[
            _snapshot("2026-07-08", "2026-07-15"),
            _snapshot("2026-07-09", "2026-07-27"),
        ],
        l4_prediction_rows=[
            _l4("2026-07-08", "2026-07-07"),
            _l4("2026-07-09", "2026-07-08"),
        ],
        knowledge_cutoff_date="2026-07-24",
        target_semantic_version="target-v1",
        min_cross_section_rows=1,
    )
    by_key = {
        (row["prediction_date"], row["evidence_scope"]): row
        for row in rows
    }
    assert by_key[("2026-07-08", "active8_oof")]["eligibility_status"] == "legal"
    assert by_key[("2026-07-08", "snapshot")]["eligibility_status"] == "legal"
    assert by_key[("2026-07-08", "l4")]["eligibility_status"] == "legal"
    assert by_key[("2026-07-08", "fusion")]["eligibility_status"] == "legal"
    assert by_key[("2026-07-09", "active8_oof")]["eligibility_status"] == "pending"
    assert by_key[("2026-07-09", "snapshot")]["eligibility_status"] == "pending"
    assert by_key[("2026-07-09", "l4")]["eligibility_status"] == "pending"
    assert by_key[("2026-07-09", "fusion")]["eligibility_status"] == "pending"


def test_oof_date_eligibility_does_not_mark_oof_illegal_for_l4_warmup():
    rows = build_oof_date_eligibility_rows(
        cohort_id="cohort-1",
        source_manifest_checksum="a" * 64,
        prediction_rows=[_prediction("2026-07-08", "2026-07-15")],
        snapshot_rows=[_snapshot("2026-07-08", "2026-07-15")],
        l4_prediction_rows=[],
        knowledge_cutoff_date="2026-07-24",
        target_semantic_version="target-v1",
        min_cross_section_rows=1,
    )
    by_scope = {row["evidence_scope"]: row for row in rows}
    assert by_scope["active8_oof"]["eligibility_status"] == "legal"
    assert by_scope["snapshot"]["eligibility_status"] == "legal"
    assert by_scope["l4"]["eligibility_status"] == "illegal"
    assert by_scope["l4"]["reason_code"] == "l4_cross_section_incomplete"
    assert by_scope["fusion"]["eligibility_status"] == "illegal"


def test_retention_plan_bridges_learning_and_ops_without_cross_database_join():
    import sqlite3
    from services.oof_retention_policy import build_oof_retention_plan
    learning, ops = sqlite3.connect(':memory:'), sqlite3.connect(':memory:')
    for db in (learning, ops): db.row_factory = sqlite3.Row
    learning.executescript("""
      CREATE TABLE active8_oof_cohorts(cohort_id TEXT,status TEXT);
      CREATE TABLE active8_oof_date_eligibility(cohort_id TEXT,evidence_scope TEXT,eligibility_status TEXT);
      CREATE TABLE active8_oof_predictions(cohort_id TEXT);
      CREATE TABLE allocator_ev_oof_snapshots(cohort_id TEXT);
      CREATE TABLE l4_oof_predictions(cohort_id TEXT);
      CREATE TABLE active8_oof_retention_ledger(cohort_id TEXT,archive_verified_at TEXT,archive_checksum TEXT);
      CREATE TABLE model_artifact_registry(artifact_id TEXT,training_run_id TEXT);
      INSERT INTO active8_oof_cohorts VALUES('one','superseded'),('two','superseded');
      INSERT INTO active8_oof_date_eligibility VALUES('one','active8_oof','illegal'),('two','active8_oof','illegal');
      INSERT INTO model_artifact_registry VALUES('a','active8_oof:one'),('b','active8_oof:two');
    """)
    ops.executescript("""CREATE TABLE artifact_hard_references(artifact_id TEXT,active INTEGER);
      INSERT INTO artifact_hard_references VALUES('a',1),('a',1),('b',0);""")
    q = lambda sql, args: [dict(row) for row in learning.execute(sql,args)]
    r = lambda sql, args: [dict(row) for row in ops.execute(sql,args)]
    try:
        before = (learning.total_changes, ops.total_changes)
        result = build_oof_retention_plan(q,reference_query_fn=r)
        assert result[0]['hard_reference_count'] == 2
        assert result[0]['blocker_reason'] == 'active_artifact_hard_reference'
        assert result[1]['hard_reference_count'] == 0
        assert result[1]['retention_action'] == 'archive_required'
        assert before == (learning.total_changes, ops.total_changes)
        import pytest
        with pytest.raises(RuntimeError,match='ops_unavailable'):
            build_oof_retention_plan(q,reference_query_fn=lambda *_: (_ for _ in ()).throw(RuntimeError('ops_unavailable')))
    finally:
        learning.close(); ops.close()
