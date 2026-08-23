from pathlib import Path
import json
import sqlite3
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
    assert rows[0]["decision_universe_frozen_at"] == "2026-06-25 15:00:00"
    assert "after-open" not in str(calls[-1][1])


def test_native_pit_loader_resolves_checksum_verified_r2_pointer():
    import json
    from services.active8_oof_cohort_materializer import load_native_pit_component_rows

    pointer = {
        "schema_version": "legacy-screener-evidence-pointer-v1",
        "artifact_id": "artifact:legacy_screener_funnel_evidence:2026-06-25:abc",
        "r2_key": (
            "evidence/class=superseded_run/domain=legacy_screener_funnel_evidence/"
            "business_date=2026-06-25/chunk=abc.json"
        ),
        "checksum": "sha256:" + "a" * 64,
        "row_id": 77,
    }
    archived_evidence = {
        "score_components": {
            "version": "score_v2",
            "components": {
                "mlEdge": 1.0,
                "chipFlow": 2.0,
                "technicalStructure": 3.0,
                "fundamentalQuality": 4.0,
                "newsTheme": 0.0,
            },
            "total": 10.0,
        },
        "taxonomy": {"industry": "semiconductor"},
        "raw_signals": {"close": 100.0},
    }

    def query(sql, params):
        if "FROM daily_recommendations" in sql:
            return []
        if "FROM stock_prices" in sql:
            return [
                {"trading_date": "2026-06-25", "price_rows": 1000},
                {"trading_date": "2026-06-26", "price_rows": 1000},
            ]
        if "COUNT(i.id) component_rows" in sql:
            assert "legacy-screener-evidence-pointer-v1" in sql
            return [{
                "date": "2026-06-25",
                "run_id": "before-open",
                "created_at": "2026-06-25 15:00:00",
                "component_rows": 1,
            }]
        if "FROM screener_funnel_items i" in sql:
            return [{
                "evidence_row_id": 77,
                "stock_id": 1,
                "symbol": "2330",
                "prediction_date": "2026-06-25",
                "score": 10.0,
                "evidence": pointer,
                "market_segment": "TWSE",
                "native_run_id": "before-open",
                "native_created_at": "2026-06-25 15:00:00",
            }]
        raise AssertionError(sql)

    def resolve(requests):
        assert requests == [{
            "row_id": 77,
            "artifact_id": pointer["artifact_id"],
            "r2_key": pointer["r2_key"],
            "checksum": pointer["checksum"],
            "source_run_id": "before-open",
            "symbol": "2330",
            "stage": "scoring",
        }]
        return {77: {
            **requests[0],
            "evidence": json.dumps(archived_evidence),
        }}

    rows = load_native_pit_component_rows(
        [{"prediction_date": "2026-06-25", "symbol": "2330"}],
        query_fn=query,
        archive_resolver=resolve,
    )

    assert len(rows) == 1
    context = json.loads(rows[0]["alpha_context"])
    assert context["native_evidence_storage_mode"] == "r2_checksum_pointer_v1"
    assert context["native_evidence_artifact_id"] == pointer["artifact_id"]
    assert context["native_evidence_checksum"] == pointer["checksum"]
    assert context["native_evidence_row_id"] == 77


def test_native_pit_loader_bounds_d1_evidence_payload_by_date_chunk():
    source = (
        ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py"
    ).read_text()

    assert "query_date_chunk_size = 4" in source
    assert source.count(
        "for offset in range(0, len(dates), query_date_chunk_size):"
    ) == 2
    assert source.count(
        "substr(json_extract(i.evidence, '$.r2_key'), 1, 69)"
    ) == 2
    assert "$.r2_key') LIKE" not in source


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


def test_ready_oof_cohort_refreshes_mature_artifacts_without_retraining():
    source = (
        ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py"
    ).read_text()

    assert "refreshing_ready = True" in source
    assert '"status": "ready_refreshed" if refreshing_ready else "ready"' in source
    assert 'return {"status": "idempotent_ready"' not in source
    assert "archive_oof_materialized_rows(" in source


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

    immutable_flags = []

    def insert_registry(record, **kwargs):
        registry.append(record)
        immutable_flags.append(kwargs.get("immutable_identity"))

    monkeypatch.setattr(materializer, "upsert_artifact_record", insert_registry)
    l4_result = {
        "artifact": {"model_version": "candidate-v1", "expected_return_owner": "l4_alpha_ev"},
        "validation_packet": {"decision": "PASS", "failed_gates": []},
    }
    fusion_result = {
        "artifact": {
            "model_version": "candidate-v1",
            "expected_return_owner": "allocator_ev_fusion",
        },
        "validation_packet": {"decision": "PASS", "failed_gates": []},
    }
    candidate = materializer.archive_ev_candidate_artifacts(
        bucket=_Bucket(),
        cohort_id="cohort-1",
        source_run_date="2026-07-15",
        manifest_path="manifest.json",
        l4_result=l4_result,
        lifecycle_cadence="weekly",
        fusion_result=fusion_result,
        parity={"decision": "PASS"},
        promoted=False,
    )
    candidate_registry = [dict(record) for record in registry]
    receipt = materializer.archive_ev_candidate_artifacts(
        bucket=_Bucket(),
        cohort_id="cohort-1",
        source_run_date="2026-07-15",
        manifest_path="manifest.json",
        l4_result=l4_result,
        lifecycle_cadence="weekly",
        fusion_result=fusion_result,
        parity={"decision": "PASS"},
        promoted={"l4_alpha_ev": True, "allocator_ev_fusion": False},
        register_candidate=False,
    )

    assert candidate["l4_alpha_ev"]["path"] != receipt["l4_alpha_ev"]["path"]
    assert receipt["l4_alpha_ev"]["state"] == "production"
    assert receipt["allocator_ev_fusion"]["state"] == "offline_passed"
    assert all(item["registry_registered"] is True for item in candidate.values())
    assert all(item["registry_registered"] is False for item in receipt.values())
    assert len(registry) == 2
    assert registry == candidate_registry
    assert immutable_flags == [True, True]
    registry_by_owner = {record["model_name"]: record for record in registry}
    for owner in ("l4_alpha_ev", "allocator_ev_fusion"):
        assert registry_by_owner[owner]["artifact_path"] == candidate[owner]["path"]
        assert registry_by_owner[owner]["checksum"] == candidate[owner]["checksum"]
        assert registry_by_owner[owner]["artifact_path"] != receipt[owner]["path"]
        assert registry_by_owner[owner]["checksum"] != receipt[owner]["checksum"]
        assert registry_by_owner[owner]["artifact_id"] == candidate[owner]["artifact_id"]
        assert registry_by_owner[owner]["artifact_id"].endswith(candidate[owner]["checksum"])
    evidence = [json.loads(record["offline_evidence_json"]) for record in registry]
    assert all(item["cadence"] == "weekly" for item in evidence)
    assert all(item["identity_schema_version"] == "expected-return-candidate-identity-v3" for item in evidence)
    assert all(item["model_version"] == "candidate-v1" for item in evidence)
    assert all(item["expected_return_owner"] == record["model_name"] for item, record in zip(evidence, registry))
    assert all(item["artifact_checksum"] == record["checksum"] for item, record in zip(evidence, registry))
    assert all(record["checksum"] in record["artifact_path"] for record in registry)
    assert len(uploaded) == 4


def test_fundamental_pit_loader_drops_future_rows_and_reuses_formal_owner():
    from services.active8_oof_cohort_materializer import load_fundamental_quality_pit_by_key

    def query(sql, params):
        assert "FROM canonical_revenue_monthly" not in sql
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
    assert payload["sourceRowCounts"]["available"] == 1
    assert payload["noLookahead"]["legacyMonthlyRevenueStatus"] == "PIT_UNAVAILABLE"
    assert "mutable_natural_key" in payload["noLookahead"]["legacyMonthlyRevenueReason"]


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
    assert len(calls) == 3
    financial_param_counts = [len(params) for sql, params in calls if "canonical_fundamental_features" in sql]
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


def test_materialized_index_accepts_verified_no_lookahead_policy_upgrade():
    from services.active8_oof_cohort_materializer import (
        OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        persist_oof_materialized_artifact_indexes,
    )

    captured = []

    def batch_fn(statements, **_kwargs):
        captured.extend(statements)
        return {"error_count": 0}

    persist_oof_materialized_artifact_indexes(
        [{
            "cohort_id": "cohort-1",
            "artifact_kind": "allocator_ev_snapshots",
            "artifact_path": "path",
            "artifact_checksum": "a" * 64,
            "format_version": "active8-oof-materialized-jsonl-gzip-v1",
            "row_count": 20,
            "date_count": 2,
            "min_date": "2026-07-08",
            "max_date": "2026-07-09",
            "compressed_bytes": 10,
            "uncompressed_bytes": 20,
            "source_manifest_checksum": "b" * 64,
            "eligibility_policy_version": OOF_PIT_ELIGIBILITY_POLICY_VERSION,
            "date_set_checksum": "c" * 64,
            "dates": ["2026-07-08", "2026-07-09"],
        }],
        eligibility_rows=[
            {
                "evidence_scope": "snapshot",
                "prediction_date": date,
                "eligibility_status": "legal",
            }
            for date in ("2026-07-08", "2026-07-09")
        ],
        query_fn=lambda *_args: [{
            "cohort_id": "cohort-1",
            "artifact_kind": "allocator_ev_snapshots",
            "artifact_path": "old-path",
            "artifact_checksum": "d" * 64,
            "format_version": "active8-oof-materialized-jsonl-gzip-v1",
            "row_count": 200,
            "date_count": 20,
            "min_date": "2026-06-01",
            "max_date": "2026-07-07",
            "compressed_bytes": 100,
            "uncompressed_bytes": 200,
            "source_manifest_checksum": "b" * 64,
            "eligibility_policy_version": "legacy-unversioned",
            "date_set_checksum": None,
        }],
        batch_fn=batch_fn,
    )

    assert len(captured) == 2
    assert "active8_oof_materialized_artifact_history" in captured[0][0]
    assert captured[0][1][-1] == "add-recorded-decision-cutoff-sector-pit-evidence"
    assert "replacement_reason" in captured[1][0]


def test_materialized_index_rejects_policy_upgrade_without_legal_dates():
    from services.active8_oof_cohort_materializer import (
        OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        persist_oof_materialized_artifact_indexes,
    )

    artifact = {
        "cohort_id": "cohort-1",
        "artifact_kind": "l4_predictions",
        "artifact_path": "new",
        "artifact_checksum": "a" * 64,
        "format_version": "active8-oof-materialized-jsonl-gzip-v1",
        "row_count": 20,
        "date_count": 1,
        "min_date": "2026-07-08",
        "max_date": "2026-07-08",
        "compressed_bytes": 10,
        "uncompressed_bytes": 20,
        "source_manifest_checksum": "b" * 64,
        "eligibility_policy_version": OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        "date_set_checksum": "c" * 64,
        "dates": ["2026-07-08"],
    }
    existing = [{
        **artifact,
        "artifact_path": "old",
        "artifact_checksum": "d" * 64,
        "eligibility_policy_version": "legacy-unversioned",
    }]
    with pytest.raises(ValueError, match="replacement_invalid"):
        persist_oof_materialized_artifact_indexes(
            [artifact],
            eligibility_rows=[],
            query_fn=lambda *_args: existing,
            batch_fn=lambda *_args, **_kwargs: {"error_count": 0},
        )

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


def test_verified_forward_coverage_readback_requires_complete_checksum_group():
    from services.active8_oof_cohort_materializer import (
        OOF_FORWARD_COVERAGE_POLICY_VERSION,
        load_verified_oof_forward_coverage,
    )

    captured = {}

    def row(checksum, kind, *, max_date, cutoff):
        return {
            "extension_manifest_checksum": checksum,
            "artifact_kind": kind,
            "extension_manifest_path": f"forward/{checksum}.json",
            "knowledge_cutoff_date": cutoff,
            "min_date": "2026-08-06",
            "max_date": max_date,
            "date_count": 3,
            "row_count": 100,
            "expected_date_count": 4,
            "not_evaluable_date_count": 1,
            "coverage_status": "verified",
            "promotion_eligible": 0,
            "training_dispatched": 0,
            "policy_version": OOF_FORWARD_COVERAGE_POLICY_VERSION,
            "verified_at": f"{cutoff}T01:00:00Z",
            "updated_at": f"{cutoff}T01:00:00Z",
        }

    def query_fn(sql, params):
        captured["sql"] = sql
        captured["params"] = params
        return [
            row("c" * 64, "allocator_ev_snapshots", max_date="2026-08-14", cutoff="2026-08-23"),
            row("b" * 64, "allocator_ev_snapshots", max_date="2026-08-14", cutoff="2026-08-21"),
            row("b" * 64, "l4_predictions", max_date="2026-08-12", cutoff="2026-08-21"),
        ]

    result = load_verified_oof_forward_coverage(
        cohort_id="cohort-1",
        base_manifest_checksum="a" * 64,
        knowledge_cutoff_date="2026-08-23",
        query_fn=query_fn,
    )

    assert result is not None
    assert result["extension_manifest_checksum"] == "b" * 64
    assert result["max_date"] == "2026-08-12"
    assert set(result["artifacts"]) == {"allocator_ev_snapshots", "l4_predictions"}
    assert result["promotion_eligible"] is False
    assert result["training_dispatched"] is False
    assert "base_manifest_checksum = ?" in captured["sql"]
    assert "coverage_status = 'verified'" in captured["sql"]
    assert captured["params"] == [
        "cohort-1",
        "a" * 64,
        OOF_FORWARD_COVERAGE_POLICY_VERSION,
        "2026-08-23",
        "2026-08-23",
    ]


def test_forward_shadow_coverage_is_complete_checksum_bound_and_non_promotable():
    from services.active8_oof_cohort_materializer import (
        OOF_FORWARD_COVERAGE_POLICY_VERSION,
        persist_verified_oof_forward_coverage,
    )

    captured = []

    def batch_fn(statements, **kwargs):
        captured.extend(statements)
        assert kwargs["chunk_size"] == 2
        return {"error_count": 0}

    extension = {
        "manifest_checksum": "b" * 64,
        "base_cohort_id": "cohort-1",
        "base_manifest_checksum": "a" * 64,
        "dates": ["2026-07-22", "2026-07-23"],
        "promotion_eligible": False,
        "training_dispatched": False,
    }
    snapshot_evidence = {
        "stacker_eligible_by_date": {"2026-07-22": 1, "2026-07-23": 1},
        "native_matched_by_date": {"2026-07-22": 1, "2026-07-23": 1},
        "snapshot_rows_by_date": {"2026-07-22": 1, "2026-07-23": 1},
        "rejected_by_date": {},
    }

    result = persist_verified_oof_forward_coverage(
        cohort_id="cohort-1",
        base_manifest_checksum="a" * 64,
        extension_manifest_path="forward/manifest.json",
        extension_manifest=extension,
        knowledge_cutoff_date="2026-07-30",
        snapshot_rows=[
            {"snapshot_date": "2026-07-22"},
            {"snapshot_date": "2026-07-23"},
        ],
        snapshot_evidence=snapshot_evidence,
        l4_predictions=[
            {"prediction_date": "2026-07-22"},
            {"prediction_date": "2026-07-23"},
        ],
        batch_fn=batch_fn,
    )
    assert result["status"] == "verified"
    assert result["promotion_eligible"] is False
    assert result["training_dispatched"] is False
    assert len(captured) == 2
    assert all(sql.count("?") == len(params) for sql, params in captured)
    assert all(row[1][-2] == OOF_FORWARD_COVERAGE_POLICY_VERSION for row in captured)
    assert all("promotion_eligible=0" in row[0] for row in captured)

    with pytest.raises(RuntimeError, match="active8_oof_forward_coverage_incomplete"):
        persist_verified_oof_forward_coverage(
            cohort_id="cohort-1",
            base_manifest_checksum="a" * 64,
            extension_manifest_path="forward/manifest.json",
            extension_manifest=extension,
            knowledge_cutoff_date="2026-07-30",
            snapshot_rows=[{"snapshot_date": "2026-07-22"}],
            l4_predictions=[{"prediction_date": "2026-07-22"}],
            snapshot_evidence=snapshot_evidence,
            batch_fn=lambda *_args, **_kwargs: {"error_count": 0},
        )


def test_forward_shadow_coverage_classifies_l4_chronological_warmup_per_artifact():
    import json

    from services.active8_oof_cohort_materializer import (
        persist_verified_oof_forward_coverage,
    )

    dates = ["2026-08-06", "2026-08-07", "2026-08-10", "2026-08-11"]
    captured = []

    def batch_fn(statements, **_kwargs):
        captured.extend(statements)
        return {"error_count": 0}

    result = persist_verified_oof_forward_coverage(
        cohort_id="cohort-1",
        base_manifest_checksum="a" * 64,
        extension_manifest_path="forward/manifest.json",
        extension_manifest={
            "manifest_checksum": "b" * 64,
            "base_cohort_id": "cohort-1",
            "base_manifest_checksum": "a" * 64,
            "dates": dates,
            "promotion_eligible": False,
            "training_dispatched": False,
        },
        knowledge_cutoff_date="2026-08-19",
        snapshot_rows=[{"snapshot_date": date} for date in dates],
        snapshot_evidence={
            "stacker_eligible_by_date": {date: 100 for date in dates},
            "native_matched_by_date": {date: 90 for date in dates},
            "snapshot_rows_by_date": {date: 90 for date in dates},
            "rejected_by_date": {},
        },
        l4_predictions=[
            {"prediction_date": "2026-08-10"},
            {"prediction_date": "2026-08-11"},
        ],
        l4_prediction_evidence={
            "dates": [
                {
                    "prediction_date": date,
                    "eligible_for_efficacy": index >= 2,
                    "train_samples": 400 + index * 50,
                    "train_dates": 3 + index,
                }
                for index, date in enumerate(dates)
            ],
        },
        batch_fn=batch_fn,
    )

    assert result["status"] == "verified"
    l4_evaluability = result["artifact_date_evaluability"]["l4_predictions"]
    assert l4_evaluability["evaluable_dates"] == dates[2:]
    assert [row["date"] for row in l4_evaluability["not_evaluable"]] == dates[:2]
    assert {
        row["reason"] for row in l4_evaluability["not_evaluable"]
    } == {"l4_chronological_history_not_ready"}
    assert result["artifacts"]["allocator_ev_snapshots"]["dates"] == 4
    assert result["artifacts"]["l4_predictions"]["dates"] == 2
    assert len(captured) == 2
    snapshot_params = captured[0][1]
    l4_params = captured[1][1]
    assert snapshot_params[12] == 0
    assert l4_params[12] == 2
    assert json.loads(l4_params[13])["evaluable_dates"] == dates[2:]


def test_forward_shadow_coverage_classifies_missing_native_pit_without_lookahead():
    import json

    from services.active8_oof_cohort_materializer import (
        OOF_FORWARD_COVERAGE_POLICY_VERSION,
        persist_verified_oof_forward_coverage,
    )

    captured = []

    def batch_fn(statements, **_kwargs):
        captured.extend(statements)
        return {"error_count": 0}

    dates = ["2026-08-06", "2026-08-07", "2026-08-10", "2026-08-11"]
    evaluable = dates[:3]
    result = persist_verified_oof_forward_coverage(
        cohort_id="cohort-1",
        base_manifest_checksum="a" * 64,
        extension_manifest_path="forward/manifest.json",
        extension_manifest={
            "manifest_checksum": "b" * 64,
            "base_cohort_id": "cohort-1",
            "base_manifest_checksum": "a" * 64,
            "dates": dates,
            "promotion_eligible": False,
            "training_dispatched": False,
        },
        knowledge_cutoff_date="2026-08-19",
        snapshot_rows=[{"snapshot_date": date} for date in evaluable],
        snapshot_evidence={
            "stacker_eligible_by_date": {date: 100 for date in dates},
            "native_matched_by_date": {
                "2026-08-06": 90,
                "2026-08-07": 90,
                "2026-08-10": 90,
            },
            "snapshot_rows_by_date": {date: 90 for date in evaluable},
            "rejected_by_date": {
                "2026-08-11": {"native_pit_components_missing": 100},
            },
        },
        l4_predictions=[{"prediction_date": date} for date in evaluable],
        batch_fn=batch_fn,
    )

    assert result["status"] == "verified"
    assert result["date_evaluability"]["evaluable_dates"] == evaluable
    assert result["date_evaluability"]["not_evaluable"] == [{
        "date": "2026-08-11",
        "reason": "missing_native_pit_components",
        "stacker_eligible_rows": 100,
        "native_matched_rows": 0,
    }]
    assert len(captured) == 2
    assert all(sql.count("?") == len(params) for sql, params in captured)
    for _sql, params in captured:
        assert params[11] == 4
        assert params[12] == 1
        eligibility = json.loads(params[13])
        assert eligibility["evaluable_dates"] == evaluable
        assert eligibility["not_evaluable"][0]["date"] == "2026-08-11"
        assert params[-2] == OOF_FORWARD_COVERAGE_POLICY_VERSION


def test_forward_shadow_coverage_rejects_unresolved_date_exclusions():
    from services.active8_oof_cohort_materializer import _classify_forward_evaluability

    with pytest.raises(
        RuntimeError,
        match="active8_oof_forward_date_evaluability_unresolved",
    ):
        _classify_forward_evaluability(
            ["2026-08-10", "2026-08-11"],
            {
                "stacker_eligible_by_date": {
                    "2026-08-10": 100,
                    "2026-08-11": 100,
                },
                "native_matched_by_date": {"2026-08-10": 90},
                "snapshot_rows_by_date": {"2026-08-10": 90},
                "rejected_by_date": {
                    "2026-08-11": {"oof_native_score_semantic_mismatch": 100},
                },
            },
        )


def test_forward_shadow_evaluation_packets_are_separate_from_candidates(monkeypatch):
    from services import active8_oof_cohort_materializer as materializer

    blobs = {}
    writes = []

    class Blob:
        def __init__(self, path):
            self.path = path

        def upload_from_string(self, payload, content_type=None):
            blobs[self.path] = bytes(payload)
            assert content_type == "application/json"

    class Bucket:
        def blob(self, path):
            return Blob(path)

    def execute(sql, params):
        writes.append((sql, params))
        return {"changes": 1}

    monkeypatch.setattr(materializer.d1_client, "execute", execute)
    extension = {
        "manifest_checksum": "b" * 64,
        "base_cohort_id": "cohort-1",
        "base_manifest_checksum": "a" * 64,
        "dates": ["2026-07-22", "2026-07-23"],
        "promotion_eligible": False,
        "training_dispatched": False,
    }
    result = materializer.archive_ev_shadow_evaluation_packets(
        bucket=Bucket(),
        cohort_id="cohort-1",
        business_date="2026-07-30",
        base_manifest_checksum="a" * 64,
        extension_manifest=extension,
        l4_result={
            "artifact": {"model_version": "l4-v1"},
            "validation_packet": {
                "decision": "PASS",
            },
        },
        fusion_result={
            "artifact": {"model_version": "fusion-v1"},
            "validation_packet": {
                "decision": "FAIL",
            },
        },
        forward_row_count=20,
        execute_fn=execute,
    )
    assert set(result) == {"l4_alpha_ev", "allocator_ev_fusion"}
    assert all(packet["policy_decision"] == "shadow_only" for packet in result.values())
    assert result["l4_alpha_ev"]["quality_decision"] == "PASS"
    assert len(writes) == 2
    assert all("expected_return_shadow_evaluation_packets" in sql for sql, _ in writes)
    assert all("subject_artifact_checksum" in sql for sql, _ in writes)
    assert all("evaluator_contract_checksum" in sql for sql, _ in writes)
    assert all("DO UPDATE SET evaluation_id=NULL" in sql for sql, _ in writes)
    assert all("quality_decision=excluded" not in sql for sql, _ in writes)
    assert all("model_artifact_registry" not in sql for sql, _ in writes)
    assert len(blobs) == 2
    assert all(len(packet["subject_artifact_checksum"]) == 64 for packet in result.values())
    assert all(len(packet["evaluator_contract_checksum"]) == 64 for packet in result.values())

    router = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text()
    forward_policy_start = router.index('if forward_extension:')
    forward_policy = router[
        forward_policy_start:
        router.index('full_fit_plan = build_oof_full_fit_dispatch_plan', forward_policy_start)
    ]
    assert 'packet["decision"] = "FAIL"' not in forward_policy
    assert 'frozen_forward_oos_shadow_only' not in forward_policy
    assert 'packet["monitoring_policy"]' in forward_policy

    migration = (ROOT / "worker" / "migrations" / "0100_expected_return_shadow_evaluation_packets.sql").read_text()
    assert "policy_decision TEXT NOT NULL CHECK(policy_decision = 'shadow_only')" in migration
    assert "model_artifact_registry" not in migration


def test_shadow_evaluation_identity_v2_migration_preserves_legacy_and_allows_successors():
    legacy = (
        ROOT / "worker" / "migrations" / "0100_expected_return_shadow_evaluation_packets.sql"
    ).read_text()
    migration = (
        ROOT / "worker" / "migrations"
        / "0111_expected_return_shadow_evaluation_identity_v2.sql"
    ).read_text()
    db = sqlite3.connect(":memory:")
    try:
        db.executescript(legacy)
        db.execute(
            """
            INSERT INTO expected_return_shadow_evaluation_packets (
              evaluation_id, business_date, cohort_id, base_manifest_checksum,
              extension_manifest_checksum, model_name, model_version,
              oof_min_date, oof_max_date, oof_date_count, oof_row_count,
              quality_decision, policy_decision, validation_packet_json,
              artifact_path, artifact_checksum
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-id", "2026-08-01", "cohort-1", "a" * 64, "b" * 64,
                "l4_alpha_ev", "v1", "2026-07-01", "2026-07-31", 20, 200,
                "FAIL", "shadow_only", "{}", "legacy.json", "c" * 64,
            ),
        )
        db.executescript(migration)
        legacy_row = db.execute(
            """
            SELECT identity_schema_version, subject_artifact_checksum,
                   evaluator_contract_checksum
              FROM expected_return_shadow_evaluation_packets
             WHERE evaluation_id='legacy-id'
            """
        ).fetchone()
        assert legacy_row == (
            "expected-return-shadow-evaluation-identity-legacy-v1", None, None,
        )
        insert = """
          INSERT INTO expected_return_shadow_evaluation_packets (
            evaluation_id, identity_schema_version, subject_artifact_checksum,
            evaluator_contract_checksum, business_date, cohort_id,
            base_manifest_checksum, extension_manifest_checksum, model_name,
            model_version, oof_min_date, oof_max_date, oof_date_count, oof_row_count,
            quality_decision, policy_decision, validation_packet_json,
            artifact_path, artifact_checksum
          ) VALUES (?, 'expected-return-shadow-evaluation-identity-v2', ?, ?, ?,
                    'cohort-1', ?, ?, 'l4_alpha_ev', 'v1', ?, ?, 20, 200,
                    ?, 'shadow_only', '{}', ?, ?)
        """
        common = ("d" * 64, "e" * 64, "2026-08-02", "a" * 64, "b" * 64,
                  "2026-07-01", "2026-07-31")
        db.execute(insert, ("successor-1", *common, "FAIL", "one.json", "f" * 64))
        db.execute(insert, ("successor-2", *common, "PASS", "two.json", "0" * 64))
        assert db.execute(
            "SELECT COUNT(*) FROM expected_return_shadow_evaluation_packets"
        ).fetchone()[0] == 3
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                "UPDATE expected_return_shadow_evaluation_packets SET evaluation_id=NULL "
                "WHERE evaluation_id='successor-1'"
            )
    finally:
        db.close()


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
    assert "prep_only_output_inventory_incomplete" in source
    assert "_verified_prep_only_receipt" in source
    assert '"status": "idempotent_ready"' in source

def test_indexed_oof_loader_enforces_checksum_lineage_and_point_in_time_cutoff():
    from services.active8_oof_cohort_materializer import (
        archive_oof_materialized_rows,
        load_indexed_oof_ev_rows,
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

    checksum = "a" * 64
    snapshots = [
        {
            "cohort_id": "cohort-indexed",
            "fold_id": "w1",
            "snapshot_date": "2026-07-08",
            "symbol": "2330",
            "market_segment": "LISTED",
            "label_known_date": "2026-07-15",
            "source_manifest_checksum": checksum,
        },
        {
            "cohort_id": "cohort-indexed",
            "fold_id": "w1",
            "snapshot_date": "2026-07-09",
            "symbol": "2317",
            "market_segment": "LISTED",
            "label_known_date": "2026-07-16",
            "source_manifest_checksum": checksum,
        },
        {
            "cohort_id": "cohort-indexed",
            "fold_id": "w1",
            "snapshot_date": "2026-07-07",
            "symbol": "2454",
            "market_segment": "LISTED",
            "label_known_date": "2026-07-14",
            "source_manifest_checksum": checksum,
        },
    ]
    l4_rows = [
        {
            "cohort_id": "cohort-indexed",
            "fold_id": "w1",
            "prediction_date": "2026-07-08",
            "symbol": "2330",
            "market_segment": "LISTED",
            "trained_until": "2026-07-07",
            "eligible_for_efficacy": 1,
        },
        {
            "cohort_id": "cohort-indexed",
            "fold_id": "w1",
            "prediction_date": "2026-07-09",
            "symbol": "2317",
            "market_segment": "LISTED",
            "trained_until": "2026-07-08",
            "eligible_for_efficacy": 1,
        },
    ]
    bucket = Bucket()
    indexes = {
        "allocator_ev_snapshots": archive_oof_materialized_rows(
            bucket=bucket,
            cohort_id="cohort-indexed",
            artifact_kind="allocator_ev_snapshots",
            rows=snapshots,
            source_manifest_checksum=checksum,
        ),
        "l4_predictions": archive_oof_materialized_rows(
            bucket=bucket,
            cohort_id="cohort-indexed",
            artifact_kind="l4_predictions",
            rows=l4_rows,
            source_manifest_checksum=checksum,
        ),
    }

    loaded_snapshots, loaded_l4, evidence = load_indexed_oof_ev_rows(
        bucket=bucket,
        cohort_id="cohort-indexed",
        source_manifest_checksum=checksum,
        knowledge_cutoff_date="2026-07-15",
        query_fn=lambda _sql, params: [indexes[params[1]]],
    )

    assert [row["symbol"] for row in loaded_snapshots] == ["2454", "2330"]
    assert [row["symbol"] for row in loaded_l4] == ["2330"]
    assert evidence["snapshot_rows_loaded"] == 3
    assert evidence["snapshot_rows_mature"] == 2
    assert evidence["snapshot_dates_mature"] == 2
    assert evidence["l4_rows_eligible"] == 1
    assert evidence["d1_full_row_tables_required"] is False


def test_active8_owned_state_routes_to_learning_domain_client():
    route = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text()
    materializer = (
        ROOT / "ml-controller" / "services" / "active8_oof_cohort_materializer.py"
    ).read_text()

    assert "learning_client = client_for_domain(D1DataDomain.LEARNING)" in route
    for call in (
        "persisted = learning_client.query(",
        "materialized_indexes = learning_client.query(",
        "query_fn=learning_client.query,",
        "batch_fn=learning_client.batch_execute,",
        "execute_fn=learning_client.execute,",
    ):
        assert call in route
    assert "d1_client.execute(" not in materializer
    assert "execute_fn: Callable[..., dict[str, Any]] = d1_client.execute" in materializer
