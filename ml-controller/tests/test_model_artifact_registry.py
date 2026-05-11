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


def test_candidate_selection_keeps_shadowing_weekly_candidate_selected():
    selection = registry.build_candidate_selection([
        {
            "artifact_id": "XGBoost:vW:weekly_drift",
            "model_name": "XGBoost",
            "candidate_type": "weekly_drift",
            "state": "shadowing",
            "updated_at": "2026-05-10T00:00:00Z",
        },
    ])

    assert selection["models"]["XGBoost"]["weekly_drift_candidate"]["artifact_id"] == "XGBoost:vW:weekly_drift"


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


def test_update_live_gate_from_ic_marks_selected_candidate_not_enough_data(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_query(sql, params=None, timeout=60.0):
        return [
            {
                "artifact_id": "XGBoost:vW:weekly_drift",
                "model_name": "XGBoost",
                "candidate_type": "weekly_drift",
                "state": "offline_strong_pass",
                "updated_at": "2026-05-10T00:00:00Z",
                "offline_gate_failed_gates": "[]",
                "offline_evidence_json": "{}",
                "live_evidence_json": "{}",
            },
            {
                "artifact_id": "DLinear:vW:weekly_drift",
                "model_name": "DLinear",
                "candidate_type": "weekly_drift",
                "state": "offline_passed",
                "updated_at": "2026-05-10T00:00:00Z",
                "offline_gate_failed_gates": "[]",
                "offline_evidence_json": "{}",
                "live_evidence_json": "{}",
            },
        ]

    def fake_execute(sql, params=None, timeout=60.0):
        executed.append({"sql": sql, "params": params})
        return {"success": True}

    monkeypatch.setattr(registry.d1_client, "query", fake_query)
    monkeypatch.setattr(registry.d1_client, "execute", fake_execute)

    result = registry.update_live_gate_from_ic(
        {
            "XGBoost": {"status": "computed", "ic": 0.10, "n_samples": 80, "root_cause": "ok"},
            "XGBoost::challenger": {
                "status": "insufficient_samples",
                "n_samples": 12,
                "root_cause": "coverage_low",
            },
        },
        min_samples=50,
    )

    assert result["selected"] == 1
    assert result["updated"] == 1
    assert result["updates"][0]["artifact_id"] == "XGBoost:vW:weekly_drift"
    assert result["updates"][0]["live_gate_status"] == "shadowing_not_enough_data"
    assert executed[0]["params"][0] == "shadowing"
    assert executed[0]["params"][1] == "shadowing_not_enough_data"


def test_update_live_gate_from_ic_passes_when_shadow_beats_production(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_query(sql, params=None, timeout=60.0):
        return [
            {
                "artifact_id": "PatchTST:vW:weekly_drift",
                "model_name": "PatchTST",
                "candidate_type": "weekly_drift",
                "state": "offline_strong_pass",
                "updated_at": "2026-05-10T00:00:00Z",
                "offline_gate_failed_gates": "[]",
                "offline_evidence_json": "{}",
                "live_evidence_json": "{}",
            },
        ]

    def fake_execute(sql, params=None, timeout=60.0):
        executed.append({"sql": sql, "params": params})
        return {"success": True}

    monkeypatch.setattr(registry.d1_client, "query", fake_query)
    monkeypatch.setattr(registry.d1_client, "execute", fake_execute)

    result = registry.update_live_gate_from_ic(
        {
            "PatchTST": {"status": "computed", "ic": 0.03, "n_samples": 80, "root_cause": "ok"},
            "PatchTST::challenger": {"status": "computed", "ic": 0.08, "n_samples": 80, "root_cause": "ok"},
        },
        min_samples=50,
    )

    assert result["updates"][0]["state"] == "live_gate_passed"
    assert result["updates"][0]["live_gate_status"] == "passed"
    assert result["updates"][0]["promotion_decision"] == "pending_promotion_controller"
    assert executed[0]["params"][0] == "live_gate_passed"
    assert executed[0]["params"][1] == "passed"


def test_build_promotion_queue_requires_approval_for_weekly_drift():
    queue = registry.build_promotion_queue(
        [
            {
                "artifact_id": "XGBoost:vW:weekly_drift",
                "model_name": "XGBoost",
                "version": "vW",
                "candidate_type": "weekly_drift",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
            },
            {
                "artifact_id": "LightGBM:vM:monthly_release",
                "model_name": "LightGBM",
                "version": "vM",
                "candidate_type": "monthly_release",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
            },
        ],
        champion_versions={"XGBoost": "vOld", "LightGBM": "vOld"},
    )

    by_model = {row["model_name"]: row for row in queue["queue"]}
    assert by_model["XGBoost"]["promotion_decision"] == "approval_required"
    assert by_model["XGBoost"]["final_compared_to"] == "vOld"
    assert by_model["LightGBM"]["promotion_decision"] == "auto_promote_candidate"


def test_build_promotion_queue_blocks_without_champion_pointer():
    queue = registry.build_promotion_queue([
        {
            "artifact_id": "PatchTST:vM:monthly_release",
            "model_name": "PatchTST",
            "version": "vM",
            "candidate_type": "monthly_release",
            "state": "live_gate_passed",
            "live_gate_status": "passed",
        },
    ])

    assert queue["queue"][0]["promotion_decision"] == "blocked_missing_champion_pointer"


def test_champion_pointer_projection_marks_missing_pointer():
    projection = registry.build_champion_pointer_projection(
        registry_rows=[{
            "artifact_id": "XGBoost:vNew:monthly_release",
            "model_name": "XGBoost",
            "version": "vNew",
            "state": "live_gate_passed",
            "updated_at": "2026-05-10T00:00:00Z",
        }],
        d1_pointers=[],
        model_pool_versions={"XGBoost": "vOld"},
    )

    model = projection["models"]["XGBoost"]
    assert projection["production_reader"] == "model_pool.json"
    assert projection["migration_ready"] is False
    assert model["readiness"] == "missing_d1_pointer"
    assert model["serving_version"] == "vOld"


def test_champion_pointer_projection_marks_mismatch():
    projection = registry.build_champion_pointer_projection(
        registry_rows=[],
        d1_pointers=[{
            "model_name": "LightGBM",
            "champion_version": "vPointer",
        }],
        model_pool_versions={"LightGBM": "vServing"},
    )

    model = projection["models"]["LightGBM"]
    assert model["readiness"] == "pointer_mismatch"
    assert model["d1_pointer_version"] == "vPointer"
    assert model["serving_version"] == "vServing"


def test_champion_pointer_projection_ready_when_d1_matches_serving():
    projection = registry.build_champion_pointer_projection(
        registry_rows=[{
            "artifact_id": "PatchTST:vServing:monthly_release",
            "model_name": "PatchTST",
            "version": "vServing",
            "state": "production",
            "updated_at": "2026-05-10T00:00:00Z",
        }],
        d1_pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vServing",
            "champion_artifact_id": "PatchTST:vServing:monthly_release",
        }],
        model_pool_versions={"PatchTST": "vServing"},
    )

    model = projection["models"]["PatchTST"]
    assert projection["migration_ready"] is True
    assert model["readiness"] == "pointer_ready"
    assert model["latest_registry_production_artifact"]["artifact_id"] == "PatchTST:vServing:monthly_release"


def test_champion_pointer_projection_marks_version_only_pointer():
    projection = registry.build_champion_pointer_projection(
        registry_rows=[],
        d1_pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vServing",
        }],
        model_pool_versions={"PatchTST": "vServing"},
    )

    model = projection["models"]["PatchTST"]
    assert projection["migration_ready"] is True
    assert model["readiness"] == "pointer_ready_version_only"
    assert model["artifact_link_status"] == "version_only_pointer"


def test_promotion_controller_dry_run_requires_weekly_approval():
    result = registry.run_promotion_controller(
        artifact_id="XGBoost:vW:weekly_drift",
        registry_rows=[{
            "artifact_id": "XGBoost:vW:weekly_drift",
            "model_name": "XGBoost",
            "version": "vW",
            "candidate_type": "weekly_drift",
            "state": "live_gate_passed",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "live_evidence_json": "{}",
            "offline_evidence_json": "{}",
        }],
        d1_pointers=[{
            "model_name": "XGBoost",
            "champion_version": "vOld",
            "champion_artifact_id": "XGBoost:vOld:monthly_release",
        }],
        model_pool_versions={"XGBoost": "vOld"},
        confirm=False,
        approved=False,
    )

    assert result["status"] == "dry_run"
    assert result["decision"] == "approval_required"
    assert result["can_promote"] is False
    assert result["final_compared_to"] == "vOld"


def test_promotion_controller_confirm_updates_champion_pointer(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_execute(sql, params=None, timeout=60.0):
        executed.append({"sql": sql, "params": params})
        return {"success": True}

    monkeypatch.setattr(registry.d1_client, "execute", fake_execute)

    result = registry.run_promotion_controller(
        artifact_id="LightGBM:vM:monthly_release",
        registry_rows=[{
            "artifact_id": "LightGBM:vM:monthly_release",
            "model_name": "LightGBM",
            "version": "vM",
            "candidate_type": "monthly_release",
            "state": "live_gate_passed",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "live_evidence_json": "{}",
            "offline_evidence_json": "{}",
        }],
        d1_pointers=[{
            "model_name": "LightGBM",
            "champion_version": "vOld",
            "champion_artifact_id": "LightGBM:vOld:monthly_release",
        }],
        model_pool_versions={"LightGBM": "vOld"},
        confirm=True,
        approved=False,
        reason="test_promote",
    )

    assert result["status"] == "ok"
    assert result["decision"] == "promote"
    assert result["can_promote"] is True
    assert len(executed) == 3
    pointer_params = executed[2]["params"]
    assert pointer_params[0] == "LightGBM"
    assert pointer_params[1] == "vM"
    assert pointer_params[2] == "LightGBM:vM:monthly_release"
    assert pointer_params[3] == "vOld"
    assert pointer_params[4] == "LightGBM:vOld:monthly_release"


def test_backfill_champion_pointers_from_model_pool_writes_current_serving_versions(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_execute(sql, params=None, timeout=60.0):
        executed.append({"sql": sql, "params": params})
        return {"success": True}

    monkeypatch.setattr(registry.d1_client, "execute", fake_execute)

    result = registry.backfill_champion_pointers_from_model_pool(
        model_pool_versions={"XGBoost": "vServing"},
        registry_rows=[{
            "artifact_id": "XGBoost:vServing:monthly_release",
            "model_name": "XGBoost",
            "version": "vServing",
        }],
        reason="test_backfill",
    )

    assert result["status"] == "ok"
    assert result["written"] == 1
    params = executed[0]["params"]
    assert params[0] == "XGBoost"
    assert params[1] == "vServing"
    assert params[2] == "XGBoost:vServing:monthly_release"
    assert params[3] == "test_backfill"
