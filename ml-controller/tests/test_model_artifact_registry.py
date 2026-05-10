from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import model_artifact_registry as registry  # noqa: E402


def test_build_artifact_records_from_monthly_followup_strong_pass():
    payload = {
        "run_id": "monthly-202605",
        "run_date": "2026-05-08",
        "is_monthly": True,
        "candidate_version": "v20260508",
        "training_manifest_path": "universal/manifests/monthly-202605.json",
        "status": "completed",
        "ic_summary": {"XGBoost": 0.061},
        "challenger_registrations": {
            "XGBoost": {
                "status": "registered",
                "version": "v20260508",
                "training_run_id": "tree-v20260508",
                "training_manifest_path": "universal/manifests/tree-v20260508.json",
                "model_cpcv": {
                    "decision": "PASS",
                    "failed_gates": [],
                    "oos_ic_mean": 0.044,
                },
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    assert len(records) == 1
    row = records[0]
    assert row["artifact_id"] == "XGBoost:v20260508:monthly_release"
    assert row["candidate_type"] == "monthly_release"
    assert row["state"] == "offline_strong_pass"
    assert row["offline_gate_decision"] == "STRONG_PASS"
    assert row["training_run_id"] == "tree-v20260508"
    assert row["training_manifest_path"] == "universal/manifests/tree-v20260508.json"
    assert row["artifact_path"] == "universal/xgboost/v20260508.joblib"


def test_build_artifact_records_from_weekly_followup_failed_registration():
    payload = {
        "run_id": "weekly-202605w2",
        "run_date": "2026-05-08",
        "is_monthly": False,
        "candidate_version": "v202605w2",
        "status": "completed",
        "ic_summary": {"DLinear": 0.031},
        "challenger_registrations": {
            "DLinear": {
                "status": "error",
                "version": "v202605w2",
                "error": "artifact missing",
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    assert len(records) == 1
    row = records[0]
    assert row["artifact_id"] == "DLinear:v202605w2:weekly_drift"
    assert row["candidate_type"] == "weekly_drift"
    assert row["state"] == "offline_failed"
    assert "artifact_registration_failed" in row["offline_gate_failed_gates"]


def test_followup_without_candidate_version_does_not_create_registry_records():
    records = registry.build_artifact_records_from_retrain_followup({
        "run_id": "legacy-run",
        "is_monthly": True,
        "challenger_registrations": {"XGBoost": {"status": "registered"}},
    })

    assert records == []


def test_list_artifact_registry_decodes_json_fields(monkeypatch):
    captured: dict[str, object] = {}

    def fake_query(sql, params=None, timeout=60.0):
        captured["sql"] = sql
        captured["params"] = params
        return [{
            "artifact_id": "XGBoost:v20260508:monthly_release",
            "offline_gate_failed_gates": "[]",
            "offline_evidence_json": '{"gate":{"decision":"PASS"}}',
            "live_evidence_json": "{}",
        }]

    monkeypatch.setattr(registry.d1_client, "query", fake_query)

    rows = registry.list_artifact_registry(model_name="XGBoost", candidate_type="monthly_release", limit=10)

    assert captured["params"] == ["XGBoost", "monthly_release", 10]
    assert rows[0]["offline_gate_failed_gates"] == []
    assert rows[0]["offline_evidence_json"]["gate"]["decision"] == "PASS"


def test_candidate_selection_keeps_weekly_out_unless_strong_pass():
    selection = registry.build_candidate_selection([
        {
            "artifact_id": "XGBoost:vM:monthly_release",
            "model_name": "XGBoost",
            "candidate_type": "monthly_release",
            "state": "offline_passed",
            "updated_at": "2026-05-08T00:00:00Z",
        },
        {
            "artifact_id": "XGBoost:vW1:weekly_drift",
            "model_name": "XGBoost",
            "candidate_type": "weekly_drift",
            "state": "offline_passed",
            "updated_at": "2026-05-09T00:00:00Z",
        },
        {
            "artifact_id": "XGBoost:vW2:weekly_drift",
            "model_name": "XGBoost",
            "candidate_type": "weekly_drift",
            "state": "offline_strong_pass",
            "updated_at": "2026-05-10T00:00:00Z",
        },
    ])

    model = selection["models"]["XGBoost"]
    assert model["monthly_release_candidate"]["artifact_id"] == "XGBoost:vM:monthly_release"
    assert model["weekly_drift_candidate"]["artifact_id"] == "XGBoost:vW2:weekly_drift"
    assert "XGBoost:vW1:weekly_drift" in model["archive_candidates"]


def test_build_artifact_records_enriches_cpcv_from_followup_train_stage():
    payload = {
        "run_id": "weekly-20260510",
        "run_date": "2026-05-10",
        "is_monthly": False,
        "candidate_version": "v20260510",
        "status": "completed",
        "ic_summary": {"XGBoost": 0.1361, "DLinear": 0.0465},
        "challenger_registrations": {
            "XGBoost": {"status": "registered", "version": "v20260510"},
            "DLinear": {"status": "registered", "version": "v20260510"},
        },
        "stages": {
            "train": {
                "ic_tracking": {
                    "XGBoost": {
                        "model_cpcv": {"decision": "PASS", "failed_gates": []},
                    },
                    "DLinear": {
                        "model_cpcv": {"decision": "PASS", "failed_gates": []},
                    },
                },
                "aux_train": {
                    "dlinear": {
                        "metadata": {
                            "feature_policy_schema_version": "model-feature-policy-v1",
                            "feature_policy": {"model": "DLinear", "family": "sequence"},
                        },
                    },
                },
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    by_model = {row["model_name"]: row for row in records}
    assert by_model["XGBoost"]["state"] == "offline_strong_pass"
    assert by_model["XGBoost"]["offline_gate_decision"] == "STRONG_PASS"
    assert by_model["DLinear"]["state"] == "offline_passed"
    assert by_model["DLinear"]["offline_gate_decision"] == "PASS"
    assert by_model["DLinear"]["feature_policy_version"] == "model-feature-policy-v1"
