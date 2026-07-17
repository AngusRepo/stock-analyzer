from pathlib import Path
import sys


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
