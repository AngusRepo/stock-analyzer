from __future__ import annotations

import json

from services import recommendation_service
from services.recommendation_service import write_layer2_core_gate_audit


def test_write_layer2_core_gate_audit_persists_core_ml_evidence_only_l3_queue(monkeypatch):
    captured = []

    def fake_batch_execute(statements):
        captured.extend(statements)
        return {"success": True}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", fake_batch_execute)

    inserted = write_layer2_core_gate_audit(
        predictions={
            "2330": {
                "core_ml_evidence": {
                    "selected": True,
                    "rank": 1,
                    "target_size": 1,
                    "upstream_count": 2,
                    "score": 0.81,
                    "models": ["LightGBM", "XGBoost", "ExtraTrees"],
                },
            },
            "2317": {
                "core_ml_evidence": {
                    "selected": False,
                    "rank": 2,
                    "target_size": 1,
                    "upstream_count": 2,
                    "score": 0.42,
                    "models": ["LightGBM", "XGBoost", "ExtraTrees"],
                },
            },
        },
        screener_recs=[
            {"symbol": "2330", "name": "TSMC", "score": 88.0},
            {"symbol": "2317", "name": "Hon Hai", "score": 77.0},
        ],
        run_date="2026-06-22",
        screener_run_id="run-20260622",
        target_size=1,
    )

    assert inserted == 2
    assert captured[0][0].startswith("DELETE FROM screener_funnel_items")
    assert captured[0][1] == ["run-20260622", "2026-06-22", "layer2_coarse_ml_gate"]

    pass_params = captured[1][1]
    drop_params = captured[2][1]
    assert pass_params[2] == "2330"
    assert pass_params[5] == "observe"
    assert pass_params[6] == "l2_tree_evidence_l3_queue_selected"
    assert pass_params[8] == 0.81
    assert drop_params[2] == "2317"
    assert drop_params[5] == "observe"
    assert drop_params[6] == "l2_tree_evidence_not_in_l3_cost_queue"

    evidence = json.loads(pass_params[10])
    assert evidence["schema_version"] == "layer2_core_ml_evidence_audit_v1"
    assert evidence["legacy_schema_version"] == "layer2_core_ml_gate_audit_v1"
    assert evidence["source"] == "daily_pipeline_v2.node_l2_core_evidence"
    assert evidence["selection_role"] == "evidence_only_l3_formal_inference_queue"
    assert evidence["final_recommendation_gate"] is False
    assert evidence["l3_formal_inference_selected"] is True
    assert evidence["target_size"] == 1
    assert evidence["upstream_count"] == 2
    assert evidence["models"] == ["LightGBM", "XGBoost", "ExtraTrees"]
