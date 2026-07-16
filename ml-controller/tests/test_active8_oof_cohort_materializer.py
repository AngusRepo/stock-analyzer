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
