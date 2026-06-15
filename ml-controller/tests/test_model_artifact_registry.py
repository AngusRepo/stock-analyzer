from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import model_artifact_registry as registry  # noqa: E402


PROMOTION_GRADE_OFFLINE_EVIDENCE = (
    '{"gate":{"decision":"STRONG_PASS","metrics":{"model_cpcv_decision":"PASS"}},'
    '"validation_packet":{"pbo":0.12,"deflated_sharpe":1.21,"monte_carlo":{"decision":"PASS"}}}'
)


PROMOTION_GRADE_LIVE_EVIDENCE = (
    '{"decision":{"root_cause":"ok","metrics":{"shadow_samples":180,"production_samples":180,"min_samples":50}}}'
)


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


def test_registry_json_io_sanitizes_non_finite_values():
    loaded = registry._json_loads('{"sample_rows":[{"up_prob":NaN,"confidence":Infinity}]}')

    assert loaded["sample_rows"] == [{"up_prob": None, "confidence": None}]
    assert json.loads(registry._json_dumps({"x": float("nan"), "y": [float("-inf")]})) == {
        "x": None,
        "y": [None],
    }


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


def test_disabled_legacy_challenger_registration_does_not_create_artifact_row():
    payload = {
        "run_id": "monthly-legacy-suppressed",
        "run_date": "2026-06-14",
        "is_monthly": True,
        "candidate_version": "v20260614010101",
        "status": "completed",
        "ic_summary": {"DLinear": 0.031},
        "challenger_registrations": {
            "DLinear": {
                "status": "disabled",
                "version": "v20260614010101",
                "reason": "legacy_model_pool_challenger_disabled_for_active9_artifact_registry_flow",
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    assert records == []


def test_explicit_candidate_type_from_weekly_drift_payload_wins_over_monthly_flag():
    payload = {
        "run_id": "weekly-drift-hotfix",
        "run_date": "2026-05-18",
        "is_monthly": True,
        "candidate_type": "weekly_drift",
        "candidate_version": "v20260518w",
        "status": "completed",
        "ic_summary": {"PatchTST": 0.041},
        "challenger_registrations": {
            "PatchTST": {
                "status": "registered",
                "version": "v20260518w",
                "model_cpcv": {"decision": "PASS", "failed_gates": [], "oos_ic_mean": 0.036},
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    assert records[0]["artifact_id"] == "PatchTST:v20260518w:weekly_drift"
    assert records[0]["candidate_type"] == "weekly_drift"


def test_build_artifact_records_from_monthly_followup_includes_lifecycle_targets():
    payload = {
        "run_id": "universal-20260613T000147-b8bdd212",
        "run_date": "2026-06-13",
        "is_monthly": True,
        "candidate_version": "v20260612165347",
        "status": "completed",
        "challenger_registrations": {},
        "stages": {
            "artifact_lifecycle": {
                "status": "ok",
                "results": {
                    "TabM": {
                        "status": "ok",
                        "model": "TabM",
                        "version": "v20260612165347",
                        "artifact_path": "universal/tabm/v20260612165347.pt",
                        "metadata_path": "universal/tabm/metadata_v20260612165347.json",
                        "checksum": "sha256:tabm",
                        "oos_ic": 0.081127,
                        "pool_update": {
                            "old_version": "vOldTabM",
                            "new_version": "v20260612165347",
                            "artifact_path": "universal/tabm/v20260612165347.pt",
                        },
                    },
                    "GNN": {
                        "status": "ok",
                        "model": "GNN",
                        "version": "v20260612165347",
                        "artifact_path": "universal/gnn/v20260612165347.pt",
                        "metadata_path": "universal/gnn/metadata_v20260612165347.json",
                        "checksum": "sha256:gnn",
                        "oos_ic": 0.033348,
                    },
                    "iTransformer": {
                        "status": "ok",
                        "model": "iTransformer",
                        "version": "v20260612165347",
                        "artifact_path": "universal/itransformer/v20260612165347.zip",
                        "metadata_path": "universal/itransformer/metadata_v20260612165347.json",
                        "checksum": "sha256:it",
                        "oos_ic": -0.022954,
                    },
                    "TimesFM": {
                        "status": "ok",
                        "model": "TimesFM",
                        "version": "v20260612T160113_timesfm25_ctx1024",
                        "artifact_path": "universal/timesfm/v20260612T160113_timesfm25_ctx1024.json",
                        "artifact_type": "foundation_forecast_config",
                        "note": "TimesFM is config-backed foundation runtime; no local retrain is run.",
                    },
                },
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    by_model = {row["model_name"]: row for row in records}
    assert set(by_model) == {"TabM", "GNN", "iTransformer", "TimesFM"}
    assert by_model["TabM"]["artifact_id"] == "TabM:v20260612165347:monthly_release"
    assert by_model["TabM"]["candidate_type"] == "monthly_release"
    assert by_model["TabM"]["state"] == "production"
    assert by_model["TabM"]["evaluation_baseline_version"] == "vOldTabM"
    assert by_model["GNN"]["state"] == "offline_passed_weak"
    assert by_model["iTransformer"]["state"] == "offline_failed"
    assert by_model["TimesFM"]["state"] == "production"
    assert by_model["TimesFM"]["artifact_path"] == "universal/timesfm/v20260612T160113_timesfm25_ctx1024.json"
    offline = json.loads(by_model["TabM"]["offline_evidence_json"])
    assert offline["source"] == "artifact_lifecycle"
    assert offline["production_cutover_source"] == "artifact_lifecycle"


def test_timesfm_lifecycle_evidence_is_registered_instead_of_missing_oos_warning():
    payload = {
        "run_id": "timesfm25-oos-backfill",
        "run_date": "2026-06-14",
        "is_monthly": True,
        "candidate_version": "v20260612T160113_timesfm25_ctx1024",
        "status": "completed",
        "stages": {
            "artifact_lifecycle": {
                "status": "ok",
                "results": {
                    "TimesFM": {
                        "status": "ok",
                        "model": "TimesFM",
                        "version": "v20260612T160113_timesfm25_ctx1024",
                        "artifact_path": "universal/timesfm/v20260612T160113_timesfm25_ctx1024.json",
                        "metadata_path": "universal/timesfm/metadata_v20260612T160113_timesfm25_ctx1024.json",
                        "artifact_type": "foundation_forecast_config",
                        "oos_ic": -0.001443,
                        "metrics": {
                            "oos_ic": -0.001443,
                            "oos_ic_std": 0.101689,
                            "oos_samples": 512,
                            "pbo": 0.8,
                        },
                        "model_cpcv": {
                            "decision": "FAIL",
                            "passed": False,
                            "failed_gates": [
                                "cpcv_oos_ic",
                                "cpcv_positive_fold_ratio",
                                "cpcv_coverage",
                            ],
                        },
                    },
                },
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    assert len(records) == 1
    row = records[0]
    assert row["artifact_id"] == "TimesFM:v20260612T160113_timesfm25_ctx1024:monthly_release"
    assert row["state"] == "production"
    assert row["offline_gate_decision"] == "FAIL"
    offline = json.loads(row["offline_evidence_json"])
    assert offline["gate"]["metrics"]["oos_ic"] == -0.001443
    assert offline["gate"]["metrics"]["model_cpcv_decision"] == "FAIL"
    assert "oos_ic_missing_from_callback" not in offline["gate"]["warnings"]


def test_lifecycle_registration_wins_when_train_and_lifecycle_share_artifact_id():
    payload = {
        "run_id": "monthly-duplicate-patchtst",
        "run_date": "2026-06-13",
        "is_monthly": True,
        "candidate_version": "v2026061217170259",
        "status": "completed",
        "ic_summary": {"PatchTST": 0.076},
        "challenger_registrations": {
            "PatchTST": {
                "status": "registered",
                "version": "v2026061217170259",
                "model_cpcv": {"decision": "PASS", "failed_gates": []},
            },
        },
        "stages": {
            "artifact_lifecycle": {
                "results": {
                    "PatchTST": {
                        "status": "ok",
                        "model": "PatchTST",
                        "version": "v2026061217170259",
                        "artifact_path": "universal/patchtst/v2026061217170259.zip",
                        "metadata_path": "universal/patchtst/metadata_v2026061217170259.json",
                        "checksum": "sha256:patch",
                        "oos_ic": 0.076,
                        "pool_update": {
                            "old_version": "vOldPatch",
                            "new_version": "v2026061217170259",
                            "artifact_path": "universal/patchtst/v2026061217170259.zip",
                        },
                    },
                },
            },
        },
    }

    records = registry.build_artifact_records_from_retrain_followup(payload)

    assert len(records) == 1
    row = records[0]
    assert row["artifact_id"] == "PatchTST:v2026061217170259:monthly_release"
    assert row["state"] == "production"
    assert row["artifact_path"] == "universal/patchtst/v2026061217170259.zip"
    assert row["evaluation_baseline_version"] == "vOldPatch"
    offline = json.loads(row["offline_evidence_json"])
    assert offline["source"] == "artifact_lifecycle"


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


def test_list_artifact_registry_attaches_latest_validation_bundle(monkeypatch):
    def fake_query(sql, params=None, timeout=60.0):
        if "FROM pbo_results" in sql:
            return [{
                "run_date": "2026-05-18",
                "pbo": 0.12,
                "go_live_verdict": "PASS",
                "raw_details": '{"method":"cscv_rank_logit","oos_mean_return":0.02}',
            }]
        if "FROM monte_carlo_results" in sql:
            return [{
                "run_date": "2026-05-18",
                "mdd_95th": 0.18,
                "go_live_verdict": "PASS",
                "simulation_method": "block_bootstrap",
            }]
        if "FROM backtest_results" in sql:
            return [{
                "run_date": "2026-05-18",
                "strategy": "StockVisionStrategy",
                "sharpe": 3.0,
                "total_trades": 60,
                "max_drawdown": 0.2,
            }]
        return [{
            "artifact_id": "ExtraTrees:v20260518:monthly_release",
            "offline_gate_failed_gates": "[]",
            "offline_evidence_json": '{"gate":{"decision":"STRONG_PASS"},"registration":{"model_cpcv":{"decision":"PASS"}}}',
            "live_evidence_json": "{}",
        }]

    monkeypatch.setattr(registry.d1_client, "query", fake_query)

    rows = registry.list_artifact_registry(model_name="ExtraTrees", limit=1)
    offline = rows[0]["offline_evidence_json"]

    assert offline["pbo"]["pbo"] == 0.12
    assert offline["pbo"]["method"] == "cscv_rank_logit"
    assert offline["monte_carlo"]["mdd_95th"] == 0.18
    assert offline["deflated_sharpe"]["method"] == "deflated_sharpe_proxy"
    assert offline["validation_packet"]["root_cause"] == "artifact_registry_missing_validation_pointer"


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
    assert model["action_context"]["weekly_drift_candidate"]["root_cause"] == "live_shadow_not_started"
    assert "verify-v2" in model["action_context"]["weekly_drift_candidate"]["scheduler_dependency"]


def test_candidate_selection_suppresses_weekly_when_newer_monthly_is_ready():
    selection = registry.build_candidate_selection([
        {
            "artifact_id": "XGBoost:v20260517170259:monthly_release",
            "model_name": "XGBoost",
            "version": "v20260517170259",
            "candidate_type": "monthly_release",
            "state": "live_gate_passed",
            "live_gate_status": "passed",
            "source_run_date": "2026-05-17",
            "updated_at": "2026-05-18T00:00:00Z",
        },
        {
            "artifact_id": "XGBoost:v20260509200349:weekly_drift",
            "model_name": "XGBoost",
            "version": "v20260509200349",
            "candidate_type": "weekly_drift",
            "state": "live_gate_passed",
            "live_gate_status": "passed",
            "source_run_date": "2026-05-09",
            "updated_at": "2026-05-10T00:00:00Z",
        },
    ])

    model = selection["models"]["XGBoost"]
    assert model["monthly_release_candidate"]["artifact_id"] == "XGBoost:v20260517170259:monthly_release"
    assert model["weekly_drift_candidate"] is None
    assert "XGBoost:v20260509200349:weekly_drift" in model["archive_candidates"]
    assert model["superseded_candidates"] == ["XGBoost:v20260509200349:weekly_drift"]
    assert model["action_context"]["weekly_drift_candidate"]["root_cause"] == "superseded_by_newer_monthly_release"


def test_candidate_selection_keeps_weekly_suppressed_after_monthly_promotes():
    selection = registry.build_candidate_selection([
        {
            "artifact_id": "XGBoost:v20260517170259:monthly_release",
            "model_name": "XGBoost",
            "version": "v20260517170259",
            "candidate_type": "monthly_release",
            "state": "production",
            "live_gate_status": "passed",
            "source_run_date": "2026-05-17",
            "updated_at": "2026-05-18T00:00:00Z",
        },
        {
            "artifact_id": "XGBoost:v20260509200349:weekly_drift",
            "model_name": "XGBoost",
            "version": "v20260509200349",
            "candidate_type": "weekly_drift",
            "state": "live_gate_passed",
            "live_gate_status": "passed",
            "source_run_date": "2026-05-09",
            "updated_at": "2026-05-10T00:00:00Z",
        },
    ])

    model = selection["models"]["XGBoost"]
    assert model["monthly_release_candidate"] is None
    assert model["serving_release_artifact"]["artifact_id"] == "XGBoost:v20260517170259:monthly_release"
    assert model["latest_monthly_release_artifact"]["artifact_id"] == "XGBoost:v20260517170259:monthly_release"
    assert model["weekly_drift_candidate"] is None
    assert "XGBoost:v20260517170259:monthly_release" not in model["archive_candidates"]
    assert model["superseded_candidates"] == ["XGBoost:v20260509200349:weekly_drift"]


def test_artifact_action_context_explains_failed_offline_gate():
    ctx = registry.build_artifact_action_context({
        "artifact_id": "XGBoost:vBad:weekly_drift",
        "state": "offline_failed",
        "offline_gate_status": "failed",
        "offline_gate_failed_gates": '["pbo_fail"]',
    })

    assert ctx["root_cause"] == "offline_gate_failed"
    assert "candidate_selection" in ctx["affected_downstream"]
    assert ctx["failed_gates"] == ["pbo_fail"]


def test_offline_gate_uses_adaptive_oos_policy_metadata():
    gate = registry.evaluate_offline_gate(
        model_name="LightGBM",
        registration={
            "status": "registered",
            "metrics": {"samples": 500, "regime": "volatile"},
            "model_cpcv": {"decision": "PASS"},
        },
        ic_summary={"LightGBM": 0.0},
    )

    assert gate["decision"] == "FAIL"
    assert "oos_ic_below_policy_floor" in gate["failed_gates"]
    assert gate["metrics"]["validation_policy_version"]
    assert gate["metrics"]["family"] == "tree"
    assert gate["metrics"]["regime"] == "volatile"


def test_promotion_blockers_use_adaptive_pbo_policy():
    base_row = {
        "artifact_id": "LightGBM:vNew:monthly_release",
        "model_name": "LightGBM",
        "candidate_type": "monthly_release",
        "state": "live_gate_passed",
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "passed",
        "live_evidence_json": (
            '{"decision":{"metrics":{"shadow_samples":250,'
            '"production_samples":250,"min_samples":50}}}'
        ),
    }
    offline = {
        "gate": {"decision": "STRONG_PASS"},
        "model_cpcv_decision": "PASS",
        "pbo": {"pbo": 0.35, "method": "cscv_rank_logit"},
        "deflated_sharpe": {"decision": "PASS", "value": 1.2},
        "monte_carlo": {"decision": "PASS", "mdd_95th": 0.12},
    }

    row = dict(base_row, offline_evidence_json=json.dumps(offline))
    codes = {blocker["code"] for blocker in registry.artifact_promotion_blockers(row, champion_version="vOld")}

    assert "pbo_threshold_missing" not in codes

    offline["pbo"]["pbo"] = 0.49
    row = dict(base_row, offline_evidence_json=json.dumps(offline))
    codes = {blocker["code"] for blocker in registry.artifact_promotion_blockers(row, champion_version="vOld")}

    assert "pbo_threshold_missing" in codes


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
    assert by_model["DLinear"]["state"] == "offline_strong_pass"
    assert by_model["DLinear"]["offline_gate_decision"] == "STRONG_PASS"
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

    assert result["selected"] == 0
    assert result["updated"] == 0
    assert result["updates"] == []
    assert executed == []


def test_promotion_queue_includes_backend_owned_action_context():
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
                "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
                "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            },
        ],
        champion_versions={"XGBoost": "vM"},
    )

    row = queue["queue"][0]
    assert row["promotion_decision"] == "approval_required"
    assert row["action_context"]["root_cause"] == "live_gate_passed"
    assert "promotion_controller" in row["action_context"]["affected_downstream"]


def test_update_live_gate_from_ic_ignores_active_model_challenger_rows(monkeypatch):
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

    assert result["selected"] == 0
    assert result["updated"] == 0
    assert result["updates"] == []
    assert executed == []


def test_update_live_gate_from_ic_ignores_retired_model_challenger_rows(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_query(sql, params=None, timeout=60.0):
        return [
            {
                "artifact_id": "CatBoost:vM:monthly_release",
                "model_name": "CatBoost",
                "candidate_type": "monthly_release",
                "state": "offline_strong_pass",
                "updated_at": "2026-05-17T00:00:00Z",
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
            "CatBoost": {"status": "computed", "ic": -0.0427, "n_samples": 153, "root_cause": "ok"},
            "CatBoost::challenger": {"status": "computed", "ic": -0.0204, "n_samples": 153, "root_cause": "ok"},
        },
        min_samples=50,
    )

    assert result["selected"] == 0
    assert result["updated"] == 0
    assert result["updates"] == []
    assert executed == []


def test_candidate_selection_suppresses_non_active9_artifact_models():
    selection = registry.build_candidate_selection([
        {
            "artifact_id": "CatBoost:vM:monthly_release",
            "model_name": "CatBoost",
            "version": "vM",
            "candidate_type": "monthly_release",
            "state": "offline_strong_pass",
            "offline_gate_decision": "STRONG_PASS",
            "updated_at": "2026-05-17T00:00:00Z",
        },
        {
            "artifact_id": "LightGBM:vM:monthly_release",
            "model_name": "LightGBM",
            "version": "vM",
            "candidate_type": "monthly_release",
            "state": "offline_strong_pass",
            "offline_gate_decision": "STRONG_PASS",
            "updated_at": "2026-05-17T00:00:00Z",
        },
    ])

    assert "CatBoost" not in selection["models"]
    assert "LightGBM" in selection["models"]
    assert selection["suppressed_count"] == 1
    assert selection["suppressed"][0]["reason"] == "model_not_active_production_artifact"
    assert selection["suppressed"][0]["action_context"]["evidence_status"] == "suppressed"


def test_build_promotion_queue_suppresses_non_active9_artifact_models():
    queue = registry.build_promotion_queue(
        [
            {
                "artifact_id": "CatBoost:vM:monthly_release",
                "model_name": "CatBoost",
                "version": "vM",
                "candidate_type": "monthly_release",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
                "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            },
        ],
        champion_versions={"CatBoost": "vOld"},
    )

    assert queue["queue"] == []
    assert queue["suppressed_count"] == 1
    assert queue["suppressed"][0]["artifact_id"] == "CatBoost:vM:monthly_release"
    assert queue["suppressed"][0]["reason"] == "model_not_active_production_artifact"


def test_promotion_controller_blocks_non_active9_artifact_models():
    result = registry.run_promotion_controller(
        artifact_id="CatBoost:vM:monthly_release",
        registry_rows=[{
            "artifact_id": "CatBoost:vM:monthly_release",
            "model_name": "CatBoost",
            "version": "vM",
            "candidate_type": "monthly_release",
            "state": "live_gate_passed",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
        }],
        d1_pointers=[{
            "model_name": "CatBoost",
            "champion_version": "vOld",
            "champion_artifact_id": "CatBoost:vOld:monthly_release",
        }],
        model_pool_versions={"CatBoost": "vOld"},
        confirm=False,
        approved=False,
    )

    assert result["status"] == "dry_run"
    assert result["decision"] == "blocked"
    assert result["can_promote"] is False
    assert "model_not_active_production_artifact" in result["evidence"]["blockers"]


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
                "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
                "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            },
            {
                "artifact_id": "LightGBM:vM:monthly_release",
                "model_name": "LightGBM",
                "version": "vM",
                "candidate_type": "monthly_release",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
                "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            },
        ],
        champion_versions={"XGBoost": "vOld", "LightGBM": "vOld"},
    )

    by_model = {row["model_name"]: row for row in queue["queue"]}
    assert by_model["XGBoost"]["promotion_decision"] == "approval_required"
    assert by_model["XGBoost"]["final_compared_to"] == "vOld"
    assert by_model["LightGBM"]["promotion_decision"] == "auto_promote_candidate"


def test_build_promotion_queue_suppresses_weekly_when_newer_monthly_is_ready():
    queue = registry.build_promotion_queue(
        [
            {
                "artifact_id": "XGBoost:v20260517170259:monthly_release",
                "model_name": "XGBoost",
                "version": "v20260517170259",
                "candidate_type": "monthly_release",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "source_run_date": "2026-05-17",
            },
            {
                "artifact_id": "XGBoost:v20260509200349:weekly_drift",
                "model_name": "XGBoost",
                "version": "v20260509200349",
                "candidate_type": "weekly_drift",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "source_run_date": "2026-05-09",
            },
        ],
        champion_versions={"XGBoost": "v1"},
    )

    assert [row["artifact_id"] for row in queue["queue"]] == ["XGBoost:v20260517170259:monthly_release"]
    assert queue["suppressed_count"] == 1
    assert queue["suppressed"][0]["artifact_id"] == "XGBoost:v20260509200349:weekly_drift"
    assert queue["suppressed"][0]["superseded_by"] == "XGBoost:v20260517170259:monthly_release"


def test_build_promotion_queue_keeps_weekly_hidden_after_monthly_promotes():
    queue = registry.build_promotion_queue(
        [
            {
                "artifact_id": "XGBoost:v20260517170259:monthly_release",
                "model_name": "XGBoost",
                "version": "v20260517170259",
                "candidate_type": "monthly_release",
                "state": "production",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "source_run_date": "2026-05-17",
            },
            {
                "artifact_id": "XGBoost:v20260509200349:weekly_drift",
                "model_name": "XGBoost",
                "version": "v20260509200349",
                "candidate_type": "weekly_drift",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "source_run_date": "2026-05-09",
            },
        ],
        champion_versions={"XGBoost": "v20260517170259"},
    )

    assert queue["queue"] == []
    assert queue["suppressed_count"] == 1
    assert queue["suppressed"][0]["superseded_by"] == "XGBoost:v20260517170259:monthly_release"


def test_build_promotion_queue_hides_stale_row_when_pointer_already_promoted():
    queue = registry.build_promotion_queue(
        [
            {
                "artifact_id": "ExtraTrees:v20260517170259:monthly_release",
                "model_name": "ExtraTrees",
                "version": "v20260517170259",
                "candidate_type": "monthly_release",
                "state": "live_gate_passed",
                "offline_gate_decision": "STRONG_PASS",
                "live_gate_status": "passed",
                "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
                "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            },
        ],
        champion_versions={"ExtraTrees": "v20260517170259"},
    )

    assert queue["queue"] == []
    assert queue["suppressed_count"] == 1
    assert queue["suppressed"][0]["reason"] == "candidate_version_already_current_champion"
    assert queue["suppressed"][0]["superseded_by"] == "current_champion_pointer"


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


def test_champion_pointer_projection_ignores_retired_pointer_when_serving_map_exists():
    projection = registry.build_champion_pointer_projection(
        registry_rows=[],
        d1_pointers=[
            {
                "model_name": "PatchTST",
                "champion_version": "vServing",
                "champion_artifact_id": "PatchTST:vServing:production_backfill",
            },
            {
                "model_name": "Chronos",
                "champion_version": "vRetired",
                "champion_artifact_id": "Chronos:vRetired:production_backfill",
            },
        ],
        model_pool_versions={"PatchTST": "vServing"},
    )

    assert projection["model_count"] == 1
    assert projection["ready_count"] == 1
    assert projection["migration_ready"] is True
    assert "PatchTST" in projection["models"]
    assert "Chronos" not in projection["models"]


def test_champion_pointer_projection_marks_version_only_pointer_not_migration_ready():
    projection = registry.build_champion_pointer_projection(
        registry_rows=[],
        d1_pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vServing",
        }],
        model_pool_versions={"PatchTST": "vServing"},
    )

    model = projection["models"]["PatchTST"]
    assert projection["migration_ready"] is False
    assert model["readiness"] == "pointer_version_only"
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
            "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
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
            "live_evidence_json": PROMOTION_GRADE_LIVE_EVIDENCE,
            "offline_evidence_json": PROMOTION_GRADE_OFFLINE_EVIDENCE,
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


def test_promotion_controller_is_idempotent_when_pointer_already_promoted(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_execute(sql, params=None, timeout=60.0):
        executed.append({"sql": sql, "params": params})
        return {"success": True}

    monkeypatch.setattr(registry.d1_client, "execute", fake_execute)

    result = registry.run_promotion_controller(
        artifact_id="PatchTST:vNew:weekly_drift",
        registry_rows=[{
            "artifact_id": "PatchTST:vNew:weekly_drift",
            "model_name": "PatchTST",
            "version": "vNew",
            "candidate_type": "weekly_drift",
            "state": "production",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "live_evidence_json": "{}",
            "offline_evidence_json": "{}",
            "approval_state": "approved",
        }],
        d1_pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vNew",
            "champion_artifact_id": "PatchTST:vNew:weekly_drift",
        }],
        model_pool_versions={"PatchTST": "vOld"},
        confirm=True,
        approved=True,
        reason="repeat_click",
    )

    assert result["status"] == "already_promoted"
    assert result["decision"] == "already_production_pointer"
    assert executed == []


def test_build_promotion_queue_excludes_production_artifacts():
    queue = registry.build_promotion_queue(
        [{
            "artifact_id": "PatchTST:vNew:weekly_drift",
            "model_name": "PatchTST",
            "version": "vNew",
            "candidate_type": "weekly_drift",
            "state": "production",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "approval_state": "approved",
        }],
        champion_versions={"PatchTST": "v1"},
    )

    assert queue["queue"] == []


def test_apply_promoted_artifact_to_model_pool_moves_matching_challenger_to_active():
    pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/patchtst/v1.zip",
                "weekly_ic": [0.1],
                "ic_4w_avg": 0.1,
                "challenger": {
                    "version": "vNew",
                    "gcs_path": "universal/patchtst/vNew.zip",
                    "weekly_ic": [0.2],
                    "ic_4w_avg": 0.2,
                    "rolling_ic": 0.21,
                    "last_ic_status": "computed",
                },
            }
        }
    }

    result = registry.apply_promoted_artifact_to_model_pool(
        pool,
        {
            "artifact_id": "PatchTST:vNew:weekly_drift",
            "model_name": "PatchTST",
            "version": "vNew",
            "candidate_type": "weekly_drift",
            "artifact_path": "universal/patchtst/vNew.zip",
        },
        reason="wei_approval",
        promoted_at="2026-05-14T17:31:25+00:00",
    )

    entry = pool["models"]["PatchTST"]
    assert result["challenger_moved"] is True
    assert entry["version"] == "vNew"
    assert entry["weekly_ic"] == [0.2]
    assert entry["ic_4w_avg"] == 0.2
    assert "challenger" not in entry
    assert entry["retired_versions"][0]["version"] == "v1"
    assert entry["promotion_controller"]["artifact_id"] == "PatchTST:vNew:weekly_drift"


def test_apply_promoted_artifact_to_model_pool_rejects_non_active9_artifacts():
    pool = {
        "models": {
            "CatBoost": {
                "version": "vOld",
                "status": "retired",
            },
        },
    }

    try:
        registry.apply_promoted_artifact_to_model_pool(
            pool,
            {
                "artifact_id": "CatBoost:vM:monthly_release",
                "model_name": "CatBoost",
                "version": "vM",
                "candidate_type": "monthly_release",
            },
            reason="test",
        )
    except ValueError as exc:
        assert "not eligible for production artifact promotion" in str(exc)
    else:
        raise AssertionError("CatBoost artifact promotion should be rejected")


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
    evidence = json.loads(str(params[4]))
    assert evidence["registry_artifact_found"] is True
    assert evidence["production_artifact_available"] is True
    assert evidence["production_artifact_created"] is True
    assert evidence["created_this_backfill"] is False
    assert evidence["artifact_id"] == "XGBoost:vServing:monthly_release"


def test_backfill_champion_pointers_can_register_current_production_artifact(monkeypatch):
    executed: list[dict[str, object]] = []

    def fake_execute(sql, params=None, timeout=60.0):
        executed.append({"sql": sql, "params": params})
        return {"success": True}

    monkeypatch.setattr(registry.d1_client, "execute", fake_execute)

    result = registry.backfill_champion_pointers_from_model_pool(
        model_pool_versions={"LightGBM": "v1"},
        registry_rows=[],
        reason="test_production_backfill",
        create_missing_artifacts=True,
    )

    assert result["status"] == "ok"
    assert result["written"] == 1
    assert result["created_artifacts"] == 1
    artifact_params = executed[0]["params"]
    pointer_params = executed[1]["params"]
    assert artifact_params[0] == "LightGBM:v1:production_backfill"
    assert artifact_params[3] == "unknown"
    assert artifact_params[4] == "production"
    assert pointer_params[0] == "LightGBM"
    assert pointer_params[1] == "v1"
    assert pointer_params[2] == "LightGBM:v1:production_backfill"
    evidence = json.loads(str(pointer_params[4]))
    assert evidence["registry_artifact_found"] is True
    assert evidence["production_artifact_available"] is True
    assert evidence["production_artifact_created"] is True
    assert evidence["created_this_backfill"] is True
    assert evidence["artifact_id"] == "LightGBM:v1:production_backfill"
