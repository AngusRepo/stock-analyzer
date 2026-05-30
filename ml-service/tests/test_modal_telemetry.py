from __future__ import annotations

from app.modal_telemetry import build_retrain_orchestrator_telemetry


def test_build_retrain_orchestrator_telemetry_includes_billable_children():
    stages = {
        "feature_selection": {
            "status": "ok",
            "elapsed_s": 10.5,
            "active_count": 106,
            "reserve_count": 24,
            "target_permutation_n": 100,
            "k_sweep_trials": 150,
            "objective_cache_hits": 12,
        },
        "train": {
            "status": "ok",
            "group_coverage": {
                "tree": {"status": "ok", "elapsed_s": 30.0},
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
        partial_results={
            "tree": {
                "results": {
                    "XGBoost": {"saved": True},
                    "CatBoost": {"saved": True},
                    "ExtraTrees": {"saved": True},
                    "LightGBM": {"saved": True},
                },
                "train_samples": 1000,
                "test_samples": 250,
                "feature_count": 106,
            },
            "patchtst": {
                "results": {"PatchTST": {"saved": True}},
                "train_samples": 1000,
                "test_samples": 250,
                "feature_count": 1,
            },
        },
    )

    assert [e["function_name"] for e in telemetry] == [
        "retrain_orchestrator",
        "feature_selection_pipeline",
        "train_tree_models",
        "train_patchtst_universal",
        "shap_feature_audit",
    ]
    assert telemetry[0]["compute_sec"] == 120.0
    assert telemetry[1]["meta"]["run_id"] == "run-a"
    assert telemetry[1]["meta"]["feature_count"] == 106
    assert telemetry[1]["meta"]["trials"] == 150
    assert telemetry[1]["meta"]["target_permutation_n"] == 100
    assert telemetry[1]["meta"]["objective_cache_hits"] == 12
    assert telemetry[3]["meta"]["group"] == "patchtst"
    assert telemetry[2]["meta"]["artifact_count"] == 4
    assert telemetry[2]["meta"]["model_artifacts"] == ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]
    assert telemetry[2]["meta"]["train_samples"] == 1000
    assert telemetry[3]["meta"]["artifact_count"] == 1
    assert all(e["source"] == "modal_followup" for e in telemetry)
