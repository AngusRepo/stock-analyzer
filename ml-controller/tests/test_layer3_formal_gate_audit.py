from __future__ import annotations

import json

from services import recommendation_service
from services.recommendation_service import write_layer3_formal_gate_audit


def test_write_layer3_formal_gate_audit_persists_pass_and_drop(monkeypatch):
    captured = []

    def fake_batch_execute(statements):
        captured.extend(statements)
        return {"success": True}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", fake_batch_execute)

    inserted = write_layer3_formal_gate_audit(
        predictions={
            "2330": {
                "ensemble_v2": {
                    "contributing_models": ["LightGBM", "GNN", "TimesFM"],
                    "weights": {"LightGBM": 0.5, "GNN": 0.3, "TimesFM": 0.2},
                },
                "core_family_vote": {
                    "family_score": 0.81,
                    "active_family_count": 3,
                    "active_families": ["tree", "graph", "time_series"],
                    "inactive_formal_models": [],
                    "inactive_lifecycle_models": [],
                    "lifecycle_weight_source": "model_pool.json",
                },
            },
            "2317": {
                "ensemble_v2": {
                    "contributing_models": ["LightGBM", "ExtraTrees"],
                    "weights": {"LightGBM": 0.7, "ExtraTrees": 0.3},
                },
                "core_family_vote": {
                    "family_score": 0.42,
                    "active_family_count": 1,
                    "active_families": ["tree"],
                    "inactive_formal_models": ["GNN", "TabM", "iTransformer"],
                    "inactive_lifecycle_models": ["GNN"],
                    "lifecycle_weight_source": "model_pool.json",
                },
            },
        },
        recommendations=[
            {"symbol": "2330", "name": "TSMC", "score": 88.0, "rank": 1},
        ],
        layer2_symbols=["2330", "2317", "2330"],
        run_date="2026-06-05",
        screener_run_id="run-20260605",
        target_size=1,
    )

    assert inserted == 2
    assert captured[0][0].startswith("DELETE FROM screener_funnel_items")
    assert captured[0][1] == ["run-20260605", "2026-06-05", "layer3_formal_ml_gate"]

    pass_params = captured[1][1]
    drop_params = captured[2][1]
    assert pass_params[2] == "2330"
    assert pass_params[5] == "pass"
    assert pass_params[6] == "formal_family_evidence_pass"
    assert pass_params[8] == 0.81
    assert drop_params[2] == "2317"
    assert drop_params[5] == "drop"
    assert drop_params[6] == "formal_family_insufficient_active_families"

    evidence = json.loads(pass_params[10])
    assert evidence["schema_version"] == "layer3_formal_ml_gate_audit_v1"
    assert evidence["source"] == "daily_pipeline_v2.apply_core_family_evidence"
    assert evidence["selection_role"] == "evidence_only_not_capacity_gate"
    assert evidence["target_size"] == 1
    assert evidence["layer2_count"] == 2
    assert evidence["active_families"] == ["tree", "graph", "time_series"]
