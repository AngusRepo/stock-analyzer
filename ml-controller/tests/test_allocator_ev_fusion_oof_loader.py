from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import active8_oof_cohort_materializer
from services.allocator_ev_fusion_artifact_builder import (
    load_allocator_ev_fusion_oof_training_rows,
)


def _query(sql: str, params: list[object]):
    if "FROM active8_oof_cohorts" in sql:
        return [{
            "status": "ready",
            "prediction_storage_mode": "gcs_indexed_v1",
            "artifact_manifest_checksum": "a" * 64,
        }]
    if "FROM active8_oof_materialized_artifacts" in sql:
        return [
            {"artifact_kind": "allocator_ev_snapshots", "source_manifest_checksum": "a" * 64},
            {"artifact_kind": "l4_predictions", "source_manifest_checksum": "a" * 64},
        ]
    raise AssertionError(sql)


def test_indexed_oof_loader_joins_verified_gcs_artifacts(monkeypatch):
    snapshot = {
        "cohort_id": "cohort-1",
        "fold_id": "w4",
        "snapshot_date": "2026-07-08",
        "prediction_date": "2026-07-08",
        "symbol": "2330",
        "market_segment": "TWSE",
        "generation_mode": "purged_oof",
        "source_manifest_checksum": "a" * 64,
        "label_known_date": "2026-07-15",
    }
    l4 = {
        "cohort_id": "cohort-1",
        "fold_id": "w4",
        "prediction_date": "2026-07-08",
        "symbol": "2330",
        "market_segment": "TWSE",
        "trained_until": "2026-07-07",
        "eligible_for_efficacy": 1,
    }

    def fake_load(*, artifact_kind, **_kwargs):
        return [snapshot] if artifact_kind == "allocator_ev_snapshots" else [l4]

    monkeypatch.setattr(active8_oof_cohort_materializer, "load_oof_materialized_rows", fake_load)
    monkeypatch.setattr(
        active8_oof_cohort_materializer,
        "build_fusion_oof_rows",
        lambda snapshots, predictions, **_kwargs: [{
            **snapshots[0],
            "l4_alpha_ev": predictions[0],
        }],
    )

    rows = load_allocator_ev_fusion_oof_training_rows(
        _query,
        cohort_id="cohort-1",
        knowledge_cutoff_date="2026-07-24",
        bucket=object(),
    )

    assert len(rows) == 1
    assert rows[0]["prediction_date"] == "2026-07-08"


def test_indexed_oof_loader_rejects_incomplete_artifact_indexes():
    def query(sql: str, params: list[object]):
        if "FROM active8_oof_cohorts" in sql:
            return [{
                "status": "ready",
                "prediction_storage_mode": "gcs_indexed_v1",
                "artifact_manifest_checksum": "a" * 64,
            }]
        return [{
            "artifact_kind": "allocator_ev_snapshots",
            "source_manifest_checksum": "a" * 64,
        }]

    with pytest.raises(ValueError, match="artifact_indexes_incomplete"):
        load_allocator_ev_fusion_oof_training_rows(
            query,
            cohort_id="cohort-1",
            knowledge_cutoff_date="2026-07-24",
            bucket=object(),
        )


def test_indexed_oof_loader_rejects_l4_trained_on_prediction_date(monkeypatch):
    snapshot = {
        "cohort_id": "cohort-1",
        "fold_id": "w4",
        "snapshot_date": "2026-07-08",
        "symbol": "2330",
        "market_segment": "TWSE",
        "generation_mode": "purged_oof",
        "source_manifest_checksum": "a" * 64,
        "label_known_date": "2026-07-15",
    }
    l4 = {
        "prediction_date": "2026-07-08",
        "trained_until": "2026-07-08",
        "eligible_for_efficacy": 1,
    }
    monkeypatch.setattr(
        active8_oof_cohort_materializer,
        "load_oof_materialized_rows",
        lambda *, artifact_kind, **_kwargs: (
            [snapshot] if artifact_kind == "allocator_ev_snapshots" else [l4]
        ),
    )

    with pytest.raises(ValueError, match="indexed_rows_empty"):
        load_allocator_ev_fusion_oof_training_rows(
            _query,
            cohort_id="cohort-1",
            knowledge_cutoff_date="2026-07-24",
            bucket=object(),
        )


def test_indexed_oof_loader_keeps_complete_most_recent_dates(monkeypatch):
    snapshot = {
        "cohort_id": "cohort-1",
        "fold_id": "w4",
        "snapshot_date": "2026-07-08",
        "symbol": "2330",
        "market_segment": "TWSE",
        "generation_mode": "purged_oof",
        "source_manifest_checksum": "a" * 64,
        "label_known_date": "2026-07-15",
    }
    l4 = {
        "prediction_date": "2026-07-08",
        "trained_until": "2026-07-07",
        "eligible_for_efficacy": 1,
    }
    monkeypatch.setattr(
        active8_oof_cohort_materializer,
        "load_oof_materialized_rows",
        lambda *, artifact_kind, **_kwargs: (
            [snapshot] if artifact_kind == "allocator_ev_snapshots" else [l4]
        ),
    )
    joined = [
        {"prediction_date": day, "symbol": symbol}
        for day in ("2026-07-08", "2026-07-09", "2026-07-10")
        for symbol in ("2330", "2317")
    ]
    monkeypatch.setattr(
        active8_oof_cohort_materializer,
        "build_fusion_oof_rows",
        lambda *_args, **_kwargs: joined,
    )

    rows = load_allocator_ev_fusion_oof_training_rows(
        _query,
        cohort_id="cohort-1",
        knowledge_cutoff_date="2026-07-24",
        limit=4,
        bucket=object(),
    )

    assert len(rows) == 4
    assert sorted({row["prediction_date"] for row in rows}) == [
        "2026-07-09",
        "2026-07-10",
    ]
    assert {
        row["prediction_date"]: sum(
            other["prediction_date"] == row["prediction_date"] for other in rows
        )
        for row in rows
    } == {"2026-07-09": 2, "2026-07-10": 2}
