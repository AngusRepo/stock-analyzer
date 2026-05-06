from __future__ import annotations

from app.modal_telemetry import build_retrain_orchestrator_telemetry


def test_build_retrain_orchestrator_telemetry_includes_billable_children():
    stages = {
        "feature_selection": {"status": "ok", "elapsed_s": 10.5},
        "train": {
            "status": "ok",
            "group_coverage": {
                "tree": {"status": "ok", "elapsed_s": 30.0},
                "ftt": {"status": "ok", "elapsed_s": 45.0, "gcs_io": {"prep_objects": 5, "prep_bytes": 100}},
                "dlinear": {"status": "skipped", "elapsed_s": None},
                "patchtst": {"status": "ok", "elapsed_s": 60.0},
            },
        },
        "shap": {"status": "ok", "elapsed_s": 12.3},
    }

    telemetry = build_retrain_orchestrator_telemetry(
        stages,
        total_elapsed_s=120.0,
        is_monthly=True,
        run_id="run-a",
    )

    assert [e["function_name"] for e in telemetry] == [
        "retrain_orchestrator",
        "feature_selection_pipeline",
        "train_tree_models",
        "train_ftt_model",
        "train_patchtst_universal",
        "shap_feature_audit",
    ]
    assert telemetry[0]["compute_sec"] == 120.0
    assert telemetry[1]["meta"]["run_id"] == "run-a"
    assert telemetry[3]["meta"]["group"] == "ftt"
    assert telemetry[3]["meta"]["gcs_io"]["prep_objects"] == 5
    assert all(e["source"] == "modal_followup" for e in telemetry)
