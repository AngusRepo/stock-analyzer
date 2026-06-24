from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import retrain_followup as followup_router  # noqa: E402


class _Request:
    def __init__(self, headers: dict[str, str] | None = None):
        self.headers = headers or {}


def test_retrain_followup_records_modal_runtime_telemetry(monkeypatch):
    calls: list[dict] = []
    registry_records: list[dict] = []

    async def fake_record_modal_call(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: [])
    monkeypatch.setattr(followup_router.d1_client, "execute", lambda *args, **kwargs: {"meta": {"changes": 1}})
    monkeypatch.setattr(followup_router.retrain_lock, "release", lambda key, **kwargs: True)
    monkeypatch.setattr(followup_router, "record_modal_call", fake_record_modal_call)
    monkeypatch.setattr(
        followup_router,
        "upsert_artifact_records",
        lambda records: registry_records.extend(records) or {
            "attempted": len(records),
            "written": len(records),
            "errors": [],
        },
    )

    payload = followup_router.RetrainFollowupPayload(
        run_id="run-telemetry",
        lock_key="lock-telemetry",
        status="completed",
        modal_telemetry=[
            {
                "function_name": "retrain_orchestrator",
                "compute_sec": 300.2,
                "wall_sec": 300.2,
                "meta": {"stage": "orchestrator"},
            },
            {
                "function_name": "train_patchtst_universal",
                "compute_sec": 125.7,
                "wall_sec": 125.7,
                "meta": {"group": "patchtst", "artifact_count": 1, "model_artifacts": ["PatchTST"]},
            },
            {
                "function_name": "feature_selection_pipeline",
                "compute_sec": 3546.7,
                "wall_sec": 3546.7,
                "meta": {"stage": "feature_selection", "feature_count": 106, "trials": 150},
            },
            {
                "function_name": "train_tree_models",
                "compute_sec": 0,
            },
        ],
    )

    result = asyncio.run(followup_router.retrain_followup(payload, _Request()))

    assert result["status"] == "completed"
    assert result["modal_telemetry"]["recorded"] == 3
    assert result["artifact_registry"]["attempted"] == 0
    assert [c["function_name"] for c in calls] == [
        "retrain_orchestrator",
        "train_patchtst_universal",
        "feature_selection_pipeline",
    ]
    assert calls[0]["source"] == "modal_followup"
    assert calls[1]["gpu"] == "L4"
    assert calls[1]["memory_mb"] == 8192
    assert calls[1]["meta"]["group"] == "patchtst"
    assert calls[1]["meta"]["artifact_count"] == 1
    assert calls[1]["meta"]["model_artifacts"] == ["PatchTST"]
    assert calls[2]["meta"]["feature_count"] == 106
    assert calls[2]["meta"]["trials"] == 150
    assert registry_records == []


def test_retrain_followup_writes_artifact_registry_records(monkeypatch):
    written: list[dict] = []

    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: [])
    monkeypatch.setattr(followup_router.d1_client, "execute", lambda *args, **kwargs: {"meta": {"changes": 1}})
    monkeypatch.setattr(followup_router.retrain_lock, "release", lambda key, **kwargs: True)
    monkeypatch.setattr(followup_router, "record_modal_call", lambda **kwargs: None)
    monkeypatch.setattr(
        followup_router,
        "upsert_artifact_records",
        lambda records: written.extend(records) or {
            "attempted": len(records),
            "written": len(records),
            "errors": [],
        },
    )

    payload = followup_router.RetrainFollowupPayload(
        run_id="monthly-registry-1",
        run_date="2026-05-08",
        is_monthly=True,
        candidate_version="v20260508",
        training_run_id="training-run-v20260508",
        training_manifest_path="universal/manifests/training-run-v20260508.json",
        status="completed",
        ic_summary={"XGBoost": 0.06},
        challenger_registrations={
            "XGBoost": {
                "status": "registered",
                "version": "v20260508",
                "model_cpcv": {"decision": "PASS", "failed_gates": []},
            },
        },
    )

    result = asyncio.run(followup_router.retrain_followup(payload, _Request()))

    assert result["artifact_registry"]["attempted"] == 1
    assert result["artifact_registry"]["written"] == 1
    assert written[0]["artifact_id"] == "XGBoost:v20260508:monthly_release"
    assert written[0]["training_run_id"] == "training-run-v20260508"
    assert written[0]["training_manifest_path"] == "universal/manifests/training-run-v20260508.json"
    assert written[0]["state"] == "offline_strong_pass"


def test_retrain_followup_reconciles_champion_pointer_after_artifact_lifecycle_cutover(monkeypatch):
    written: list[dict] = []
    reconcile_calls: list[dict] = []

    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: [])
    monkeypatch.setattr(followup_router.d1_client, "execute", lambda *args, **kwargs: {"meta": {"changes": 1}})
    monkeypatch.setattr(followup_router.retrain_lock, "release", lambda key, **kwargs: True)
    monkeypatch.setattr(followup_router, "record_modal_call", lambda **kwargs: None)
    monkeypatch.setattr(
        followup_router,
        "upsert_artifact_records",
        lambda records: written.extend(records) or {
            "attempted": len(records),
            "written": len(records),
            "errors": [],
        },
    )

    def fake_reconcile(**kwargs):
        reconcile_calls.append(kwargs)
        return {
            "attempted": True,
            "status": "ok",
            "written": 1,
            "triggered_by": [row.get("artifact_id") for row in kwargs["artifact_records"]],
        }

    monkeypatch.setattr(followup_router, "_backfill_champion_pointers_after_cutover", fake_reconcile)

    payload = followup_router.RetrainFollowupPayload(
        run_id="monthly-artifact-cutover",
        run_date="2026-06-15",
        is_monthly=True,
        candidate_version="v20260615052900",
        status="completed",
        stages={
            "artifact_lifecycle": {
                "results": {
                    "GNN": {
                        "status": "ok",
                        "model": "GNN",
                        "version": "v20260615052900",
                        "artifact_path": "universal/gnn/v20260615052900.pt",
                        "pool_update": {
                            "new_version": "v20260615052900",
                            "old_version": "v20260612165347",
                            "artifact_path": "universal/gnn/v20260615052900.pt",
                        },
                    },
                },
            },
        },
    )

    result = asyncio.run(followup_router.retrain_followup(payload, _Request()))

    assert written[0]["artifact_id"] == "GNN:v20260615052900:monthly_release"
    assert written[0]["state"] == "production"
    assert reconcile_calls
    assert reconcile_calls[0]["reason"] == "retrain_followup_artifact_lifecycle:monthly-artifact-cutover"
    assert result["champion_pointer_reconcile"]["attempted"] is True
    assert result["champion_pointer_reconcile"]["status"] == "ok"


def test_retrain_followup_enriches_timesfm_foundation_evidence(monkeypatch):
    written: list[dict] = []

    def fake_attach_timesfm_l2_evidence(payload: dict) -> dict:
        stages = payload.setdefault("stages", {})
        lifecycle_results = stages.get("artifact_lifecycle", {}).get("results", {})
        legacy = lifecycle_results.pop("TimesFM")
        l2_results = stages.setdefault("timesfm_l2_feature_release", {}).setdefault("results", {})
        l2_results["TimesFM"] = {
            **legacy,
            "candidate_type": "timesfm_l175_l2_feature_release",
            "release_stage": "timesfm_l2_feature_release",
            "direct_alpha_blocked": True,
            "oos_ic": 0.088,
            "metrics": {"oos_ic": 0.088, "oos_samples": 80},
            "model_cpcv": {"decision": "PASS", "failed_gates": []},
            "foundation_forecast_validation": {"decision": "PASS", "oos_ic_mean": 0.088},
        }
        return {"attempted": True, "updated": True, "oos_ic": 0.088, "samples": 80}

    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: [])
    monkeypatch.setattr(followup_router.d1_client, "execute", lambda *args, **kwargs: {"meta": {"changes": 1}})
    monkeypatch.setattr(followup_router.retrain_lock, "release", lambda key, **kwargs: True)
    monkeypatch.setattr(followup_router, "record_modal_call", lambda **kwargs: None)
    monkeypatch.setattr(
        followup_router,
        "attach_timesfm_foundation_evidence_to_followup_payload",
        fake_attach_timesfm_l2_evidence,
    )
    monkeypatch.setattr(
        followup_router,
        "upsert_artifact_records",
        lambda records: written.extend(records) or {
            "attempted": len(records),
            "written": len(records),
            "errors": [],
        },
    )

    payload = followup_router.RetrainFollowupPayload(
        run_id="monthly-timesfm",
        run_date="2026-06-14",
        is_monthly=True,
        candidate_version="v20260612T160113_timesfm25_ctx1024",
        status="completed",
        stages={
            "artifact_lifecycle": {
                "results": {
                    "TimesFM": {
                        "status": "ok",
                        "model": "TimesFM",
                        "version": "v20260612T160113_timesfm25_ctx1024",
                        "artifact_path": "universal/timesfm/v20260612T160113_timesfm25_ctx1024.json",
                        "artifact_type": "foundation_forecast_config",
                    },
                },
            },
        },
    )

    result = asyncio.run(followup_router.retrain_followup(payload, _Request()))

    assert result["foundation_evidence"]["updated"] is True
    assert written[0]["artifact_id"] == "TimesFM:v20260612T160113_timesfm25_ctx1024:timesfm_l175_l2_feature_release"
    assert written[0]["candidate_type"] == "timesfm_l175_l2_feature_release"
    assert written[0]["offline_gate_decision"] in {"PASS", "STRONG_PASS"}


def test_retrain_followup_accepts_modal_service_token(monkeypatch):
    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: ["service-secret"])

    followup_router._check_token(_Request({"X-Service-Token": "service-secret"}))


def test_retrain_followup_accepts_controller_token_compat(monkeypatch):
    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: ["controller-secret"])

    followup_router._check_token(_Request({"X-Controller-Token": "controller-secret"}))


def test_retrain_followup_rejects_wrong_token(monkeypatch):
    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: ["expected-secret"])

    with pytest.raises(Exception) as exc:
        followup_router._check_token(_Request({"X-Service-Token": "wrong"}))

    assert getattr(exc.value, "status_code", None) == 401


def test_monthly_retrain_followup_builds_scheduler_callback_payload():
    payload = followup_router.RetrainFollowupPayload(
        run_id="monthly-run-1",
        run_date="2026-05-03",
        is_monthly=True,
        batch_count=12,
        total_samples=12345,
        feature_count=106,
        elapsed_s=42.7,
        status="completed",
    )

    callback = followup_router._build_scheduler_callback_payload(payload)

    assert callback["task"] == "monthly-retrain"
    assert callback["status"] == "success"
    assert callback["run_id"] == "monthly-run-1"
    assert callback["run_date"] == "2026-05-03"
    assert callback["duration_ms"] == 42700
    assert "samples=12345" in callback["summary"]


def test_non_monthly_retrain_followup_keeps_compat_task():
    payload = followup_router.RetrainFollowupPayload(
        run_id="weekly-run-1",
        is_monthly=False,
        status="failed",
        error="artifact mismatch",
    )

    callback = followup_router._build_scheduler_callback_payload(payload)

    assert callback["task"] == "retrain"
    assert callback["status"] == "error"
    assert callback["error"] == "artifact mismatch"


def test_registry_backfill_only_writes_artifact_registry(monkeypatch):
    written: list[dict] = []
    executed: list[tuple] = []

    monkeypatch.setattr(followup_router, "_valid_service_tokens", lambda: [])
    monkeypatch.setattr(
        followup_router.d1_client,
        "query",
        lambda *args, **kwargs: [{
            "idempotency_key": "run-backfill",
            "payload_summary": """
            {
              "run_id": "run-backfill",
              "run_date": "2026-05-10",
              "is_monthly": false,
              "candidate_version": "v20260510",
              "status": "completed",
              "ic_summary": {"XGBoost": 0.08},
              "challenger_registrations": {
                "XGBoost": {"status": "registered", "version": "v20260510"}
              },
              "stages": {
                "train": {
                  "ic_tracking": {
                    "XGBoost": {
                      "model_cpcv": {"decision": "PASS", "failed_gates": []}
                    }
                  }
                }
              }
            }
            """,
        }],
    )
    monkeypatch.setattr(
        followup_router,
        "upsert_artifact_records",
        lambda records: written.extend(records) or {
            "attempted": len(records),
            "written": len(records),
            "errors": [],
        },
    )
    monkeypatch.setattr(followup_router.d1_client, "execute", lambda *args, **kwargs: executed.append(args))
    monkeypatch.setattr(followup_router.retrain_lock, "release", lambda key, **kwargs: (_ for _ in ()).throw(AssertionError("must not release lock")))
    monkeypatch.setattr(followup_router, "_callback_worker_scheduler", lambda payload: (_ for _ in ()).throw(AssertionError("must not callback scheduler")))

    result = asyncio.run(
        followup_router.retrain_followup_registry_backfill(
            followup_router.RetrainFollowupRegistryBackfillRequest(run_id="run-backfill", dry_run=False),
            _Request(),
        )
    )

    assert result["side_effects"]["webhook_log_updated"] is False
    assert result["side_effects"]["scheduler_callback"] is False
    assert result["side_effects"]["lock_release"] is False
    assert result["artifact_registry"]["written"] == 1
    assert written[0]["artifact_id"] == "XGBoost:v20260510:weekly_drift"
    assert written[0]["state"] == "offline_strong_pass"
    offline = json.loads(written[0]["offline_evidence_json"])
    assert offline["gate"]["policy"]["family"] == "tree"
    assert offline["gate"]["policy"]["pbo"]["max_pbo"] < 0.5
    assert executed == []
