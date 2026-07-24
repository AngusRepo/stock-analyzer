from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def test_counterfactual_score_v2_replaces_only_ml_and_excludes_native_alpha():
    from services.active8_oof_cohort_materializer import _counterfactual_score_v2

    native = {
        "version": "score_v2",
        "semanticVersion": "score-v2-active8-components-v3",
        "components": {
            "mlEdge": 3.0,
            "chipFlow": 19.0,
            "technicalStructure": 21.0,
            "fundamentalQuality": 17.0,
            "newsTheme": 0.0,
        },
        "total": 60.0,
        "finalScore": 67.0,
        "alphaAdjustment": 7.0,
    }

    rebuilt = _counterfactual_score_v2(native, 0.8)

    assert rebuilt["components"] == {
        "mlEdge": 20.0,
        "chipFlow": 19.0,
        "technicalStructure": 21.0,
        "fundamentalQuality": 17.0,
        "newsTheme": 0.0,
    }
    assert rebuilt["total"] == 77.0
    assert rebuilt["finalScore"] == 77.0
    assert rebuilt["alphaAdjustment"] == 0.0
    assert rebuilt["counterfactualLineage"]["nativeAlphaAdjustmentExcluded"] is True


def test_counterfactual_score_v2_accepts_only_explicit_recorded_pit_legacy_source():
    import pytest
    from services.active8_oof_cohort_materializer import (
        RECORDED_PIT_COMPONENT_SOURCE,
        _counterfactual_score_v2,
    )

    native = {
        "version": "score_v2",
        "components": {
            "mlEdge": 0.0,
            "chipFlow": 19.0,
            "technicalStructure": 21.0,
            "fundamentalQuality": 17.0,
            "newsTheme": 0.0,
        },
    }

    with pytest.raises(ValueError, match="oof_native_score_semantic_mismatch"):
        _counterfactual_score_v2(native, 0.8)
    rebuilt = _counterfactual_score_v2(
        native,
        0.8,
        native_component_source=RECORDED_PIT_COMPONENT_SOURCE,
    )
    assert rebuilt["semanticVersion"] == "score-v2-active8-components-v3"
    assert rebuilt["counterfactualLineage"]["sourceSemanticVersion"] is None
    assert rebuilt["counterfactualLineage"]["sourceWasRecordedPointInTime"] is True


def test_native_pit_loader_uses_earliest_complete_run_before_next_open():
    from services.active8_oof_cohort_materializer import (
        RECORDED_PIT_COMPONENT_SOURCE,
        load_native_pit_component_rows,
    )

    score_payload = {
        "version": "score_v2",
        "components": {
            "mlEdge": 1.0,
            "chipFlow": 2.0,
            "technicalStructure": 3.0,
            "fundamentalQuality": 4.0,
            "newsTheme": 0.0,
        },
        "total": 10.0,
    }
    calls = []

    def query(sql, params):
        calls.append((sql, params))
        if "FROM daily_recommendations" in sql:
            return []
        if "FROM stock_prices" in sql:
            return [
                {"trading_date": "2026-06-24", "price_rows": 1000},
                {"trading_date": "2026-06-25", "price_rows": 1000},
                {"trading_date": "2026-06-26", "price_rows": 1000},
            ]
        if "COUNT(i.id) component_rows" in sql:
            return [
                {
                    "date": "2026-06-25",
                    "run_id": "before-open",
                    "created_at": "2026-06-25 15:00:00",
                    "component_rows": 1,
                },
                {
                    "date": "2026-06-25",
                    "run_id": "after-open",
                    "created_at": "2026-06-26 02:00:00",
                    "component_rows": 1,
                },
            ]
        if "FROM screener_funnel_items i" in sql:
            assert params == ["before-open"]
            return [{
                "stock_id": 1,
                "symbol": "2330",
                "prediction_date": "2026-06-25",
                "score": 10.0,
                "evidence": {
                    "score_components": score_payload,
                    "taxonomy": {"industry": "semiconductor"},
                    "raw_signals": {"close": 100.0},
                },
                "market_segment": "TWSE",
                "native_run_id": "before-open",
                "native_created_at": "2026-06-25 15:00:00",
            }]
        raise AssertionError(sql)

    rows = load_native_pit_component_rows(
        [{"prediction_date": "2026-06-25", "symbol": "2330"}],
        query_fn=query,
    )

    assert len(rows) == 1
    assert rows[0]["native_component_source"] == RECORDED_PIT_COMPONENT_SOURCE
    assert rows[0]["native_run_id"] == "before-open"
    assert "after-open" not in str(calls[-1][1])


def test_native_pit_loader_bounds_d1_evidence_payload_by_date_chunk():
    source = (
        ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py"
    ).read_text()

    assert "query_date_chunk_size = 4" in source
    assert source.count(
        "for offset in range(0, len(dates), query_date_chunk_size):"
    ) == 2


def test_oof_persistence_rejects_duplicate_snapshot_identity_before_writes():
    from services.active8_oof_cohort_materializer import persist_oof_cohort

    duplicate = {
        "cohort_id": "cohort",
        "fold_id": "w0",
        "snapshot_date": "2026-07-01",
        "symbol": "2330",
        "market_segment": "LISTED",
    }
    with pytest.raises(ValueError, match="active8_oof_snapshot_identity_duplicate"):
        persist_oof_cohort(
            manifest={"cohort_id": "cohort", "windows": []},
            prediction_rows=[],
            snapshot_rows=[duplicate, dict(duplicate)],
            dry_run=True,
        )


def test_oof_persistence_is_resumable_and_uses_deterministic_upserts():
    source = (
        ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py"
    ).read_text()

    assert 'row.get("status") != "building"' in source
    assert "ON CONFLICT(cohort_id, fold_id, prediction_date, symbol, market_segment, model_name)" in source
    assert "ON CONFLICT(cohort_id, fold_id, model_name)" in source
    assert "ON CONFLICT(cohort_id, fold_id, snapshot_date, symbol, market_segment)" in source
    assert "ON CONFLICT(cohort_id, fold_id, prediction_date, symbol, market_segment)" in source

def test_oof_migration_enforces_immutable_keys_and_point_in_time_labels():
    migration = (ROOT / "worker" / "migrations" / "0066_active8_oof_stacking_cohorts.sql").read_text()

    assert "PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment, model_name)" in migration
    assert "CHECK(label_known_date > prediction_date)" in migration
    assert "CHECK(trained_until < prediction_date)" in migration
    assert "generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof')" in migration


def test_candidate_and_promotion_packets_are_checksum_addressed(monkeypatch):
    from services import active8_oof_cohort_materializer as materializer

    uploaded = {}
    registry = []

    class _Blob:
        def __init__(self, path):
            self.path = path

        def upload_from_string(self, payload, content_type=None):
            uploaded[self.path] = payload

    class _Bucket:
        def blob(self, path):
            return _Blob(path)

    monkeypatch.setattr(materializer, "upsert_artifact_record", registry.append)
    result = {
        "artifact": {"model_version": "candidate-v1"},
        "validation_packet": {"decision": "PASS", "failed_gates": []},
    }
    candidate = materializer.archive_ev_candidate_artifacts(
        bucket=_Bucket(),
        cohort_id="cohort-1",
        source_run_date="2026-07-15",
        manifest_path="manifest.json",
        l4_result=result,
        fusion_result=result,
        parity={"decision": "PASS"},
        promoted=False,
    )
    receipt = materializer.archive_ev_candidate_artifacts(
        bucket=_Bucket(),
        cohort_id="cohort-1",
        source_run_date="2026-07-15",
        manifest_path="manifest.json",
        l4_result=result,
        fusion_result=result,
        parity={"decision": "PASS"},
        promoted=True,
    )

    assert candidate["l4_alpha_ev"]["path"] != receipt["l4_alpha_ev"]["path"]
    assert all(record["checksum"] in record["artifact_path"] for record in registry)
    assert len(uploaded) == 4


def test_fundamental_pit_loader_drops_future_rows_and_reuses_formal_owner():
    from services.active8_oof_cohort_materializer import load_fundamental_quality_pit_by_key

    def query(sql, params):
        if "FROM canonical_revenue_monthly" in sql:
            return [{
                "stock_id": "2330",
                "revenue_month": "2026-05",
                "yoy": 20.0,
                "mom": 5.0,
                "source": "finlab.monthly_revenue",
                "as_of_date": "2026-06-10",
            }]
        if "FROM canonical_fundamental_features" in sql:
            return [
                {
                    "stock_id": "2330",
                    "period": "2026Q1",
                    "available_date": "2026-05-15",
                    "as_of_date": "2026-05-15",
                    "roe": 18.0,
                    "pe": 15.0,
                    "source": "finlab.fundamental_factor_diversity",
                },
                {
                    "stock_id": "2330",
                    "period": "2026Q2",
                    "available_date": "2026-07-20",
                    "as_of_date": "2026-07-20",
                    "roe": 99.0,
                    "source": "finlab.fundamental_factor_diversity",
                },
            ]
        raise AssertionError(sql)

    result = load_fundamental_quality_pit_by_key(
        [{"prediction_date": "2026-06-25", "symbol": "2330"}],
        query_fn=query,
    )
    payload = result[("2026-06-25", "2330")]

    assert payload["version"] == "fundamental_quality_v1"
    assert payload["score"] > 0
    assert payload["noLookahead"]["decisionDate"] == "2026-06-25"
    assert payload["noLookahead"]["droppedFutureFinancialRows"] == 1
    assert payload["sourceRowCounts"]["available"] == 2


def test_fundamental_pit_loader_chunks_below_d1_variable_limit():
    from services.active8_oof_cohort_materializer import load_fundamental_quality_pit_by_key

    calls = []

    def query(sql, params):
        calls.append((sql, list(params)))
        assert len(params) <= 100
        return []

    result = load_fundamental_quality_pit_by_key(
        [
            {"prediction_date": "2026-06-25", "symbol": f"{index:04d}"}
            for index in range(205)
        ],
        query_fn=query,
    )

    assert result == {}
    assert len(calls) == 6
    revenue_param_counts = [len(params) for sql, params in calls if "canonical_revenue_monthly" in sql]
    financial_param_counts = [len(params) for sql, params in calls if "canonical_fundamental_features" in sql]
    assert revenue_param_counts == [80, 80, 45]
    assert financial_param_counts == [82, 82, 47]

def test_counterfactual_score_uses_formal_pit_fundamental_owner_when_available():
    from services.active8_oof_cohort_materializer import _counterfactual_score_v2

    native = {
        "version": "score_v2",
        "semanticVersion": "score-v2-active8-components-v3",
        "components": {
            "mlEdge": 0.0,
            "chipFlow": 10.0,
            "technicalStructure": 10.0,
            "fundamentalQuality": 0.0,
            "newsTheme": 0.0,
        },
    }
    formal = {
        "version": "fundamental_quality_v1",
        "score": 12.5,
        "dataIssues": [],
        "noLookahead": {"decisionDate": "2026-06-25"},
    }

    rebuilt = _counterfactual_score_v2(native, 0.8, fundamental_quality=formal)

    assert rebuilt["components"]["fundamentalQuality"] == 12.5
    assert rebuilt["counterfactualLineage"]["fundamentalQualityOwner"] == "fundamental_quality_v1_pit"
    assert rebuilt["counterfactualLineage"]["fundamentalQualityNoLookahead"]["decisionDate"] == "2026-06-25"


def test_v2_manifest_reuses_verified_parent_artifacts():
    import hashlib
    import io
    import json

    import numpy as np
    from services.active8_oof_cohort_materializer import (
        ACTIVE8_MODELS,
        TARGET_SEMANTIC_VERSION,
        _manifest_checksum,
        build_oof_fold_artifact_rows,
        load_oof_prediction_rows,
        load_verified_oof_manifest,
        persist_oof_cohort,
    )

    parent_cohort = "parent-cohort"
    child_cohort = "child-cohort"
    parent_checksum = "a" * 64
    blobs = {}
    metrics = {}
    for model_name in ACTIVE8_MODELS:
        metadata = {
            "schema_version": "active8-oof-predictions-v1",
            "generation_mode": "purged_oof",
            "cohort_id": parent_cohort,
            "fold_id": "w0",
            "model_name": model_name,
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "artifact_version": f"{parent_cohort}-w0-{model_name}",
            "score_semantic": "same-market-same-date-percentile-rank-v1",
            "rows": 1,
        }
        buffer = io.BytesIO()
        np.savez_compressed(
            buffer,
            metadata=np.asarray(json.dumps(metadata), dtype=object),
            raw_scores=np.asarray([0.2]),
            rank_scores=np.asarray([0.7]),
            targets=np.asarray([0.03]),
            dates=np.asarray(["2026-06-26"]),
            symbols=np.asarray(["2330"]),
            markets=np.asarray(["LISTED"]),
            label_known_dates=np.asarray(["2026-07-03"]),
        )
        payload = buffer.getvalue()
        artifact_path = f"oof/{model_name}.npz"
        blobs[artifact_path] = payload
        metrics[model_name] = {
            "status": "ready",
            "oof_artifact": artifact_path,
            "artifact_checksum": hashlib.sha256(payload).hexdigest(),
        }

    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v2",
        "cohort_id": child_cohort,
        "generation_mode": "purged_oof",
        "status": "ready",
        "model_set": list(ACTIVE8_MODELS),
        "parent_manifest": {
            "path": "parent/manifest.json",
            "cohort_id": parent_cohort,
            "checksum": parent_checksum,
        },
        "windows": [{
            "window_id": 1,
            "train_range": ["2026-03-01", "2026-06-25"],
            "test_range": ["2026-06-26", "2026-07-09"],
            "source_cohort_id": parent_cohort,
            "source_fold_id": "w0",
            "source_manifest_checksum": parent_checksum,
            "model_metrics": metrics,
        }],
    }
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    blobs["child/manifest.json"] = json.dumps(manifest).encode()

    class Blob:
        def __init__(self, value):
            self.value = value
        def download_as_bytes(self):
            return self.value
    class Bucket:
        def blob(self, path):
            return Blob(blobs[path])

    loaded, _ = load_verified_oof_manifest("child/manifest.json", bucket=Bucket())
    rows = load_oof_prediction_rows(loaded, bucket=Bucket())
    index_rows = build_oof_fold_artifact_rows(loaded, rows)
    dry_run = persist_oof_cohort(
        manifest=loaded,
        prediction_rows=rows,
        snapshot_rows=[],
        dry_run=True,
    )

    assert len(rows) == 8
    assert {row["cohort_id"] for row in rows} == {child_cohort}
    assert {row["source_cohort_id"] for row in rows} == {parent_cohort}
    assert {row["fold_id"] for row in rows} == {"w1"}
    assert len(index_rows) == 8
    assert {row["source_manifest_checksum"] for row in index_rows} == {parent_checksum}
    assert dry_run["prediction_storage_mode"] == "gcs_indexed_v1"
    assert dry_run["fold_artifact_rows"] == 8


def test_compact_oof_migration_preserves_raw_artifact_lineage():
    migration = (ROOT / "worker" / "migrations" / "0067_active8_oof_compact_fold_lineage.sql").read_text()
    assert "CREATE TABLE IF NOT EXISTS active8_oof_fold_artifacts" in migration
    assert "source_manifest_checksum TEXT NOT NULL" in migration
    assert "CHECK(length(artifact_checksum) = 64)" in migration
    assert "prediction_storage_mode TEXT NOT NULL DEFAULT 'd1_full_v1'" in migration


def test_gcs_indexed_materialized_artifact_round_trip_and_checksum():
    from services.active8_oof_cohort_materializer import (
        archive_oof_materialized_rows,
        load_oof_materialized_rows,
    )

    blobs = {}

    class Blob:
        def __init__(self, path):
            self.path = path

        def upload_from_string(self, payload, content_type=None):
            blobs[self.path] = bytes(payload)

        def download_as_bytes(self):
            return blobs[self.path]

    class Bucket:
        def blob(self, path):
            return Blob(path)

    rows = [{
        "cohort_id": "cohort-1",
        "fold_id": "w1",
        "snapshot_date": "2026-07-01",
        "symbol": "2330",
        "market_segment": "LISTED",
        "score": 51.0,
    }]
    artifact = archive_oof_materialized_rows(
        bucket=Bucket(),
        cohort_id="cohort-1",
        artifact_kind="allocator_ev_snapshots",
        rows=rows,
        source_manifest_checksum="a" * 64,
    )

    loaded = load_oof_materialized_rows(
        bucket=Bucket(),
        cohort_id="cohort-1",
        artifact_kind="allocator_ev_snapshots",
        query_fn=lambda _sql, _params: [artifact],
    )

    assert loaded == rows
    assert artifact["row_count"] == 1
    assert artifact["date_count"] == 1
    assert artifact["artifact_checksum"] in artifact["artifact_path"]
    assert artifact["compressed_bytes"] > 0
    assert artifact["uncompressed_bytes"] > 0


def test_gcs_indexed_materialization_never_writes_large_oof_tables():
    source = (
        ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py"
    ).read_text()
    migration = (
        ROOT / "worker" / "migrations" / "0068_active8_oof_materialized_artifact_index.sql"
    ).read_text()

    assert 'if prediction_storage_mode == "gcs_indexed_v1":' in source
    assert 'artifact_kind="allocator_ev_snapshots"' in source
    assert 'artifact_kind="l4_predictions"' in source
    assert "indexed_snapshot_rows" in source
    assert "indexed_l4_prediction_rows" in source
    assert "CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifacts" in migration
    assert "active8-oof-materialized-jsonl-gzip-v1" in migration


def test_forward_extension_manifest_is_shadow_only_and_bound_to_base():
    import hashlib
    import json

    from services.active8_oof_cohort_materializer import (
        _manifest_checksum,
        load_verified_oof_forward_extension,
    )
    from services.active8_oof_stacker import CORE_CROSS_SECTIONAL_MODELS

    base = {"cohort_id": "base", "manifest_checksum": "a" * 64}
    manifest = {
        "schema_version": "active8-oof-forward-extension-v1",
        "status": "ready",
        "generation_mode": "frozen_forward_oos",
        "extension_id": "ext",
        "base_cohort_id": "base",
        "base_manifest_checksum": "a" * 64,
        "promotion_eligible": False,
        "training_dispatched": False,
        "counterfactual_reconstruction": True,
        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "extension_range": ["2026-07-08", "2026-07-16"],
        "knowledge_cutoff_date": "2026-07-23",
        "dates": ["2026-07-08", "2026-07-09"],
        "model_artifacts": {name: {"path": name} for name in CORE_CROSS_SECTIONAL_MODELS},
    }
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    raw = json.dumps(manifest).encode()

    class Blob:
        def download_as_bytes(self):
            return raw

    class Bucket:
        def blob(self, _path):
            return Blob()

    loaded = load_verified_oof_forward_extension(
        "forward/manifest.json", bucket=Bucket(), base_manifest=base
    )
    assert loaded["promotion_eligible"] is False

    manifest["promotion_eligible"] = True
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    raw = json.dumps(manifest).encode()
    with pytest.raises(ValueError, match="active8_oof_forward_manifest_invalid"):
        load_verified_oof_forward_extension(
            "forward/manifest.json", bucket=Bucket(), base_manifest=base
        )


def test_prep_only_source_stops_before_training_dispatch():
    source = (ROOT / "ml-controller" / "routers" / "retrain_trigger.py").read_text(encoding="utf-8")
    request_pos = source.index("prep_only: bool")
    receipt_pos = source.index("prep_only_complete_no_training_dispatched")
    orchestrator_pos = source.index(
        "from services.modal_client import retrain_orchestrator",
        source.index("async def trigger_universal_retrain"),
    )
    assert request_pos < receipt_pos < orchestrator_pos
    assert '"training_dispatched": False' in source
    assert "prep_only_output_prefix_collision" in source