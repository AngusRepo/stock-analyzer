from __future__ import annotations

import json

from services import recommendation_service
from services.recommendation_service import write_layer2_timesfm_enrichment_audit


def test_write_layer2_timesfm_enrichment_audit_persists_feature_sidecar_evidence(monkeypatch):
    captured = []

    def fake_batch_execute(statements):
        captured.extend(statements)
        return {"success": True}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", fake_batch_execute)

    inserted = write_layer2_timesfm_enrichment_audit(
        predictions={
            "2330": {
                "stock_meta": {
                    "timesfm_l175_sidecar": {
                        "schema_version": "timesfm-l1-75-sidecar-v1",
                        "layer": "L2",
                        "role": "feature_sidecar",
                        "direct_alpha_blocked": True,
                        "eligible_for_l2_feature_enrichment": True,
                        "l2_feature_input_active": True,
                        "l2_feature_schema_version": "formal137+timesfm_l175",
                        "l2_feature_names": ["timesfm_l175_forecast_return"],
                        "current_allowed_use": ["l2_feature_enrichment"],
                        "features": {"forecast_return": 0.012},
                    },
                },
            },
            "2317": {},
        },
        screener_recs=[
            {"symbol": "2330", "name": "TSMC", "score": 88.0},
            {"symbol": "2317", "name": "Hon Hai", "score": 77.0},
        ],
        run_date="2026-06-24",
        screener_run_id="run-20260624",
    )

    assert inserted == 2
    assert captured[0][0].startswith("DELETE FROM screener_funnel_items")
    assert captured[0][1] == ["run-20260624", "2026-06-24"]

    active_params = captured[1][1]
    missing_params = captured[2][1]
    assert active_params[2] == "2330"
    assert active_params[4] == "layer2_timesfm_enrichment"
    assert active_params[5] == "observe"
    assert active_params[6] == "timesfm_l2_feature_input_active"
    assert missing_params[2] == "2317"
    assert missing_params[4] == "layer2_timesfm_enrichment"
    assert missing_params[6] == "timesfm_l2_sidecar_missing"

    evidence = json.loads(active_params[10])
    assert evidence["schema_version"] == "l2_timesfm_enrichment_evidence_v1"
    assert evidence["source"] == "timesfm_l2_sidecar"
    assert evidence["stage"] == "L2"
    assert evidence["selection_role"] == "feature_enrichment_not_gate"
    assert evidence["final_recommendation_gate"] is False
    assert evidence["l3_formal_inference_selected"] is True
    assert evidence["direct_alpha_blocked"] is True
    assert evidence["sidecar_layer"] == "L2"
    assert evidence["l2_feature_input_active"] is True
    assert evidence["l2_feature_schema_version"] == "formal137+timesfm_l175"
    assert evidence["populated_feature_count"] == 1
