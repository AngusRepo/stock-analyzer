from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.cost_tracker import (  # noqa: E402
    build_compute_profile_event_payload,
    build_modal_compute_profile,
    estimate_modal_cost,
)
from services.compute_efficiency_contract import normalize_compute_profile  # noqa: E402


def test_estimate_modal_cost_includes_gpu_cpu_and_memory_components():
    cost = estimate_modal_cost(
        compute_sec=100,
        cpu=2,
        memory_mb=4096,
        gpu="L4",
    )

    expected = 100 * (
        2 * 0.0000131
        + 4 * 0.00000222
        + 0.000222
    )
    assert cost == round(expected, 6)


def test_estimate_modal_cost_ignores_unknown_gpu_but_keeps_cpu_memory():
    cost = estimate_modal_cost(
        compute_sec=10,
        cpu=1,
        memory_mb=1024,
        gpu="unknown",
    )

    assert cost == round(10 * (0.0000131 + 0.00000222), 6)


def test_build_modal_compute_profile_preserves_modal_runtime_fields():
    profile = build_modal_compute_profile(
        source="modal_predict_batch_v2",
        function_name="predict_batch_v2",
        compute_sec=539.888,
        est_usd=0.023733,
        cpu=2,
        memory_mb=8192,
        gpu=None,
        meta={
            "wall_sec": 134.972,
            "call_type": "map_batch",
            "input_count": 64,
            "chunk_count": 4,
            "chunk_size": 20,
            "model_cache_hit_ratio": 0.75,
            "run_id": "universal-20260517T233956-32000efc",
            "await_sec": 0.0,
        },
    )

    assert profile["provider"] == "modal"
    assert profile["job_name"] == "predict_batch_v2"
    assert profile["run_id"] == "universal-20260517T233956-32000efc"
    assert profile["wall_sec"] == 134.972
    assert profile["compute_sec"] == 539.888
    assert profile["await_sec"] == 0.0
    assert profile["compute_owner"] == "modal"
    assert profile["remote_function"] == "predict_batch_v2"
    assert profile["cpu"] == 2.0
    assert profile["memory_mb"] == 8192
    assert profile["symbols"] == 64
    assert profile["cache_hit_ratio"] == 0.75
    assert profile["meta"]["chunk_count"] == 4


def test_build_modal_compute_profile_preserves_artifact_count_from_meta():
    profile = build_modal_compute_profile(
        source="modal_function",
        function_name="train_tree_models",
        compute_sec=408.1,
        est_usd=0.02,
        cpu=2,
        memory_mb=4096,
        meta={
            "wall_sec": 408.1,
            "artifact_count": 4,
            "model_artifacts": [
                "xgboost",
                "catboost",
                "extratrees",
                "lightgbm",
            ],
        },
    )

    assert profile["artifact_count"] == 4
    assert profile["meta"]["model_artifacts"] == ["xgboost", "catboost", "extratrees", "lightgbm"]


def test_build_modal_compute_profile_maps_training_samples_to_rows():
    profile = build_modal_compute_profile(
        source="modal_followup",
        function_name="train_tree_models",
        compute_sec=408.1,
        est_usd=0.02,
        cpu=2,
        memory_mb=4096,
        meta={
            "wall_sec": 408.1,
            "total_samples": 1250,
            "train_samples": 1000,
            "test_samples": 250,
        },
    )
    fallback_profile = build_modal_compute_profile(
        source="modal_followup",
        function_name="train_patchtst_universal",
        compute_sec=3310.0,
        est_usd=0.8,
        cpu=1,
        memory_mb=8192,
        gpu="L4",
        meta={
            "wall_sec": 3310.0,
            "train_samples": 1000,
        },
    )

    assert profile["rows"] == 1250
    assert fallback_profile["rows"] == 1000


def test_build_compute_profile_event_payload_targets_compute_profile_events():
    profile = build_modal_compute_profile(
        source="modal_function",
        function_name="train_patchtst_universal",
        compute_sec=3310.0,
        est_usd=0.807574,
        cpu=1,
        memory_mb=8192,
        gpu="L4",
        meta={
            "wall_sec": 3310.0,
            "rows": 1_200_000,
            "features": 106,
            "symbols": 2200,
            "trials": 0,
            "artifact_count": 1,
        },
    )
    payload = build_compute_profile_event_payload(profile=profile, event_date="2026-05-18")

    assert "INSERT INTO compute_profile_events" in payload["sql"]
    assert "await_sec" in payload["sql"]
    assert "compute_owner" in payload["sql"]
    assert "remote_function" in payload["sql"]
    assert payload["params"][0] == "2026-05-18"
    assert payload["params"][1] == "modal"
    assert payload["params"][2] == "train_patchtst_universal"
    assert payload["params"][5] == 3310.0
    assert payload["params"][7] == "modal"
    assert payload["params"][8] == "train_patchtst_universal"
    assert payload["params"][11] == "L4"
    assert payload["params"][13] == 1_200_000
    assert payload["params"][14] == 106
    assert payload["params"][15] == 2200
    assert '"artifact_count": 1' in payload["params"][18]
    assert '"job_name": "train_patchtst_universal"' in payload["params"][18]


def test_build_compute_profile_event_payload_keeps_legacy_table_fallback():
    profile = build_modal_compute_profile(
        source="modal_function",
        function_name="train_patchtst_universal",
        compute_sec=3310.0,
        est_usd=0.807574,
        cpu=1,
        memory_mb=8192,
        gpu="L4",
        meta={"wall_sec": 3310.0, "await_sec": 0.0},
    )
    payload = build_compute_profile_event_payload(
        profile=profile,
        event_date="2026-05-18",
        include_wait_columns=False,
    )

    assert "await_sec" not in payload["sql"]
    assert "compute_owner" not in payload["sql"]
    assert "remote_function" not in payload["sql"]
    assert len(payload["params"]) == 16
    assert '"await_sec": 0.0' in payload["params"][15]
    assert '"compute_owner": "modal"' in payload["params"][15]
    assert '"remote_function": "train_patchtst_universal"' in payload["params"][15]


def test_compute_profile_event_json_round_trips_artifact_count_to_contract():
    profile = build_modal_compute_profile(
        source="modal_function",
        function_name="train_tree_models",
        compute_sec=408.1,
        est_usd=0.02,
        cpu=2,
        memory_mb=4096,
        meta={
            "wall_sec": 408.1,
            "total_samples": 1250,
            "model_artifacts": ["xgb", "cat", "et", "lgbm"],
        },
    )
    payload = build_compute_profile_event_payload(profile=profile, event_date="2026-05-18")

    normalized = normalize_compute_profile({
        "provider": payload["params"][1],
        "job_name": payload["params"][2],
        "profile_json": payload["params"][18],
    })

    assert normalized["rows"] == 1250
    assert normalized["artifact_count"] == 4
