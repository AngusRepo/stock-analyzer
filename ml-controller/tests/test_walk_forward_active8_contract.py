from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def test_walk_forward_defaults_to_active8_contract():
    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage

    expected = [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
    ]
    assert MODELS_ALL == expected

    coverage = walk_forward_model_coverage()
    assert coverage["requested_models"] == expected
    assert coverage["native_retrain_models"] == expected
    assert coverage["artifact_lifecycle_required_models"] == []
    assert coverage["coverage_mode"] == "active8_purged_oof_retrain"


def test_walk_forward_router_exposes_active8_coverage():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert "walk_forward_model_coverage" in source
    assert "\"planned_model_evaluations\"" in source
    assert "\"model_coverage\"" in source
    assert "active-8 coverage" in source
    assert "5 models" not in source


def test_walk_forward_train_payload_declares_five_day_label_horizon():
    from services.walk_forward_retrain import WalkForwardWindow, build_walk_forward_train_payload

    window = WalkForwardWindow(
        window_id=7,
        train_start="2026-01-02",
        train_end="2026-03-31",
        test_start="2026-04-01",
        test_end="2026-04-30",
    )

    payload = build_walk_forward_train_payload(window, batch_count=5)

    assert payload["label_horizon_days"] == 5
    assert payload["train_end"] == "2026-03-31"
    assert payload["test_start"] == "2026-04-01"


def test_modal_walk_forward_orchestrator_no_longer_defaults_tree_only():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "from app.model_pool import ALPHA_PREDICTION_MODELS" in source
    assert "active8_models = list(ALPHA_PREDICTION_MODELS)" in source
    assert "family_tasks" in source
    assert "oof_fold_ready" in source
    assert "payload.get(\"models\") or active8_models" in source
    assert "payload.get(\"models\") or [\"XGBoost\", \"ExtraTrees\", \"LightGBM\"]" not in source


def test_oof_automatic_promotion_requires_primary_fusion_and_operational_parity():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert 'fusion_tier == "primary"' in source
    assert 'parity.get("decision") == "PASS"' in source
    assert "archive_ev_candidate_artifacts" in source
    assert "purged OOF quality PASS and native operational parity PASS" in source


def test_walk_forward_routes_long_sequence_v3_prep_into_every_oof_fold():
    router_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    modal_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert 'sequence_gcs_prefix: str = "universal/sequence_long"' in router_source
    assert '"sequence_gcs_prefix": req.sequence_gcs_prefix' in router_source
    assert '"sequence_batch_count": req.sequence_batch_count' in router_source
    assert "active8_oof_sequence_v3_prep_batch_missing" in modal_source
    assert 'raw.get("target_semantic_version") == "next-session-open-to-fifth-session-close-v2"' in modal_source
    assert '"version": f"{cohort_id}-w{wid}"' in modal_source
    assert 'version = payload.get("output_model_version") or payload.get("version", "v1")' in modal_source
