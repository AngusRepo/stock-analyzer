from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import model_artifact_registry as registry  # noqa: E402
from services import model_serving_resolver as resolver  # noqa: E402


def _fallback_pool() -> dict:
    return {
        "models": {
            name: {"status": "active", "version": "old", "gcs_path": f"legacy/{name}.joblib"}
            for name in resolver.DIRECT_ALPHA_MODELS
        },
        "l2_feature_sidecars": {
            "TimesFM": {"status": "active", "version": "old", "gcs_path": "legacy/timesfm.json"}
        },
    }


def test_artifact_id_query_is_parameterized_deduplicated_and_bounded(monkeypatch):
    observed: dict = {}

    def fake_query(sql, params, timeout=60.0):
        observed.update({"sql": sql, "params": params, "timeout": timeout})
        return [{
            "artifact_id": "XGBoost:v1:test",
            "offline_evidence_json": '{"registration":{"metadata":{"version":"v1"}}}',
            "live_evidence_json": "{}",
            "offline_gate_failed_gates": "[]",
        }]

    monkeypatch.setattr(registry.d1_client, "query", fake_query)
    rows = registry.list_artifacts_by_ids([
        "XGBoost:v1:test",
        "GNN:v1:test",
        "XGBoost:v1:test",
    ])

    assert "WHERE artifact_id IN (?, ?)" in observed["sql"]
    assert observed["params"] == ["XGBoost:v1:test", "GNN:v1:test"]
    assert rows[0]["offline_evidence_json"]["registration"]["metadata"]["version"] == "v1"

    with pytest.raises(ValueError, match="artifact_id_query_exceeds_bound"):
        registry.list_artifacts_by_ids([f"artifact-{index}" for index in range(10)])


def _retired_test_load_d1_champion_pool_never_uses_broad_registry_query(monkeypatch):
    pointers = [
        {
            "model_name": "XGBoost",
            "champion_version": "v1",
            "champion_artifact_id": "XGBoost:v1:test",
        },
        {
            "model_name": "GNN",
            "champion_version": "v1",
            "champion_artifact_id": "GNN:v1:test",
        },
        {
            "model_name": "Unrelated",
            "champion_version": "v1",
            "champion_artifact_id": "Unrelated:v1:test",
        },
    ]
    observed: dict = {}
    monkeypatch.setattr(registry, "list_champion_pointers", lambda: pointers)
    monkeypatch.setattr(
        registry,
        "list_artifact_registry",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("broad registry query must not be used by serving")
        ),
    )

    def exact_query(artifact_ids, *, max_ids=9):
        observed.update({"artifact_ids": artifact_ids, "max_ids": max_ids})
        return []

    monkeypatch.setattr(registry, "list_artifacts_by_ids", exact_query)
    pool = resolver.load_d1_champion_pool(
        fallback_pool=_fallback_pool(),
        required_models=("XGBoost", "GNN"),
        sidecar_models=(),
    )

    assert observed == {
        "artifact_ids": ["XGBoost:v1:test", "GNN:v1:test"],
        "max_ids": 2,
    }
    assert pool["models"]["XGBoost"]["serving_eligible"] is False
    assert pool["models"]["XGBoost"]["serving_block_reason"] == "missing_registry_artifact"


def _retired_test_build_pool_from_d1_champion_pointer_serves_production_artifact():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vGood",
            "champion_artifact_id": "PatchTST:vGood:weekly_drift",
            "promotion_evidence_json": {
                "rolling_ic": 0.12,
                "last_ic_artifact_version": "vGood",
                "last_ic_target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
            },
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vGood:weekly_drift",
            "model_name": "PatchTST",
            "version": "vGood",
            "candidate_type": "weekly_drift",
            "state": "production",
            "artifact_path": "universal/patchtst/vGood.zip",
            "checksum": "sha256:" + "a" * 64,
            "metadata_path": "universal/patchtst/metadata_vGood.json",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "offline_evidence_json": {
                "registration": {
                    "metadata": {
                        "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                        "seq_len": 512,
                        "pred_len": 5,
                        "rank_ic_semantic_version": resolver.FORMAL_RANK_IC_SEMANTIC_VERSION,
                    }
                }
            },
        }],
        fallback_pool=_fallback_pool(),
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert pool["source_of_truth"] == "model_champion_pointers"
    assert entry["status"] == "active"
    assert entry["version"] == "vGood"
    assert entry["gcs_path"] == "universal/patchtst/vGood.zip"
    assert entry["rolling_ic"] == 0.12
    assert entry["target_semantic_version"] == resolver.LABEL_SCHEMA_VERSION
    assert entry["seq_len"] == 512
    assert entry["pred_len"] == 5
    assert entry["sequence_contract"] == {
        "schema_version": "model-serving-sequence-contract-v1",
        "source": "model_artifact_registry",
        "model": "PatchTST",
        "artifact_id": "PatchTST:vGood:weekly_drift",
        "version": "vGood",
        "seq_len": 512,
        "pred_len": 5,
        "rank_ic_semantic_version": resolver.FORMAL_RANK_IC_SEMANTIC_VERSION,
    }


def _retired_test_gnn_graph_semantic_is_required_by_champion_resolver():
    base_artifact = {
        "artifact_id": "GNN:v2:oof_full_fit_release",
        "model_name": "GNN",
        "version": "v2",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/gnn/v2.pt",
        "checksum": "sha256:" + "a" * 64,
        "metadata_path": "universal/gnn/metadata_v2.json",
        "offline_gate_decision": "PASS",
        "live_gate_status": "promoted",
        "offline_evidence_json": {
            "registration": {
                "metadata": {
                    "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                    "feature_semantic_version": resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
                }
            }
        },
    }
    pointer = {"model_name": "GNN", "champion_version": "v2", "champion_artifact_id": base_artifact["artifact_id"]}
    blocked = resolver.build_pool_from_champion_pointers(
        pointers=[pointer], artifacts=[base_artifact], fallback_pool=_fallback_pool(), required_models=("GNN",), sidecar_models=(),
    )["models"]["GNN"]
    assert blocked["serving_eligible"] is False
    assert blocked["serving_block_reason"].startswith("artifact_gnn_graph_semantic_missing_")

    valid_artifact = dict(base_artifact)
    valid_artifact["offline_evidence_json"] = {
        "registration": {"metadata": {
            "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
            "feature_semantic_version": resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
            "graph": {"semantic_version": resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION},
        }}
    }
    ready = resolver.build_pool_from_champion_pointers(
        pointers=[pointer], artifacts=[valid_artifact], fallback_pool=_fallback_pool(), required_models=("GNN",), sidecar_models=(),
    )["models"]["GNN"]
    assert ready["serving_eligible"] is True
    assert ready["gnn_graph_semantic_version"] == resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION


def _retired_test_timesfm_production_backfill_is_eligible_only_as_l2_sidecar():
    artifact = {
        "artifact_id": "TimesFM:v1:l2_release",
        "model_name": "TimesFM",
        "version": "v1",
        "candidate_type": "timesfm_l175_l2_feature_release",
        "state": "production",
        "artifact_path": "universal/timesfm/v1.json",
        "checksum": "sha256:" + "a" * 64,
        "offline_gate_decision": "PRODUCTION_BACKFILL",
        "live_gate_status": "passed",
    }
    pointer = {
        "model_name": "TimesFM",
        "champion_version": "v1",
        "champion_artifact_id": artifact["artifact_id"],
    }

    sidecar_pool = resolver.build_pool_from_champion_pointers(
        pointers=[pointer],
        artifacts=[artifact],
        fallback_pool=_fallback_pool(),
        required_models=(),
        sidecar_models=("TimesFM",),
    )
    sidecar = sidecar_pool["l2_feature_sidecars"]["TimesFM"]
    assert sidecar["role"] == "l2_feature_sidecar"
    assert sidecar["direct_prediction"] is False
    assert sidecar["status"] == "active"
    assert sidecar["serving_eligible"] is True
    assert sidecar["serving_block_reason"] is None

    direct_pool = resolver.build_pool_from_champion_pointers(
        pointers=[pointer],
        artifacts=[artifact],
        fallback_pool={"models": {"TimesFM": {}}},
        required_models=("TimesFM",),
        sidecar_models=(),
    )
    direct = direct_pool["models"]["TimesFM"]
    assert direct["serving_eligible"] is False
    assert direct["serving_block_reason"] == "offline_gate_production_backfill"


def _retired_test_d1_champion_blocks_legacy_target_without_retiring_active8_slot():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "XGBoost",
            "champion_version": "vLegacy",
            "champion_artifact_id": "XGBoost:vLegacy:weekly_drift",
        }],
        artifacts=[{
            "artifact_id": "XGBoost:vLegacy:weekly_drift",
            "model_name": "XGBoost",
            "version": "vLegacy",
            "candidate_type": "weekly_drift",
            "state": "production",
            "artifact_path": "universal/xgboost/vLegacy.joblib",
            "checksum": "sha256:" + "a" * 64,
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "offline_evidence_json": {
                "registration": {
                    "metadata": {
                        "target_semantic_version": "next-session-open-to-fifth-session-close-v2",
                    }
                }
            },
        }],
        fallback_pool=_fallback_pool(),
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    entry = pool["models"]["XGBoost"]
    assert entry["status"] == "degraded"
    assert entry["model_slot_status"] == "active"
    assert entry["serving_eligible"] is False
    assert entry["serving_block_reason"].startswith("artifact_target_semantic_")


def _retired_test_build_pool_blocks_archived_artifact_without_retiring_active8_slot():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vBad",
            "champion_artifact_id": "PatchTST:vBad:monthly_release",
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vBad:monthly_release",
            "model_name": "PatchTST",
            "version": "vBad",
            "candidate_type": "monthly_release",
            "state": "archived",
            "artifact_path": "universal/patchtst/vBad.zip",
            "offline_gate_decision": "FAIL",
            "live_gate_status": "failed",
        }],
        fallback_pool=_fallback_pool(),
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "degraded"
    assert entry["model_slot_status"] == "active"
    assert entry["serving_eligible"] is False
    assert entry["version"] == "vBad"
    assert entry["serving_block_reason"] == "artifact_state_archived"


def _retired_test_patchtst_d1_champion_rejects_legacy_pt_artifact():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vLegacy",
            "champion_artifact_id": "PatchTST:vLegacy:weekly_drift",
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vLegacy:weekly_drift",
            "model_name": "PatchTST",
            "version": "vLegacy",
            "candidate_type": "weekly_drift",
            "state": "production",
            "artifact_path": "universal/patchtst/vLegacy.pt",
            "metadata_path": "universal/patchtst/metadata_vLegacy.json",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
        }],
        fallback_pool=_fallback_pool(),
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "degraded"
    assert entry["model_slot_status"] == "active"
    assert entry["serving_eligible"] is False
    assert entry["version"] == "vLegacy"
    assert entry["serving_block_reason"] == "artifact_extension_pt_expected_zip"


def _retired_test_model_pool_reconcile_plan_updates_patchtst_to_d1_champion():
    current_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vBad",
                "gcs_path": "universal/patchtst/vBad.zip",
            }
        }
    }
    champion_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vGood",
                "gcs_path": "universal/patchtst/vGood.zip",
                "metadata_path": "universal/patchtst/metadata_vGood.json",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "PatchTST:vGood:weekly_drift",
            }
        }
    }

    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current_pool,
        champion_pool=champion_pool,
        model_names=("PatchTST",),
    )

    assert plan["mode"] == "dry_run"
    assert plan["apply_allowed"] is True
    assert plan["action_count"] == 1
    action = plan["actions"][0]
    assert action["action"] == "update_model_pool_pointer"
    assert action["model_name"] == "PatchTST"
    assert action["diff"]["version"] == {"from": "vBad", "to": "vGood"}
    assert action["patch"]["gcs_path"] == "universal/patchtst/vGood.zip"


def _retired_test_model_pool_reconcile_plan_clears_stale_serving_block_reason():
    current_pool = {
        "models": {
            "TabM": {
                "status": "active",
                "version": "vGood",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "TabM:vGood:oof_full_fit_release",
                "serving_block_reason": "artifact_target_semantic_missing",
            }
        }
    }
    champion_pool = {
        "models": {
            "TabM": {
                "status": "active",
                "version": "vGood",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "TabM:vGood:oof_full_fit_release",
                "serving_block_reason": None,
            }
        }
    }

    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current_pool,
        champion_pool=champion_pool,
        model_names=("TabM",),
    )

    assert plan["action_count"] == 1
    assert plan["actions"][0]["diff"]["serving_block_reason"] == {
        "from": "artifact_target_semantic_missing",
        "to": None,
    }
    patched = resolver.apply_model_pool_reconcile_plan(model_pool=current_pool, plan=plan)
    assert patched["models"]["TabM"]["serving_block_reason"] is None


def _retired_test_model_pool_reconcile_plan_blocks_archived_pointer_without_retiring_slot():
    plan = resolver.build_model_pool_reconcile_plan(
        model_pool={"models": {"PatchTST": {"status": "active", "version": "vBad"}}},
        champion_pool={
            "models": {
                "PatchTST": {
                    "status": "retired",
                    "version": "vBad",
                    "serving_block_reason": "artifact_state_archived",
                }
            }
        },
        model_names=("PatchTST",),
    )

    assert plan["apply_allowed"] is True
    assert plan["blocked"] == []
    assert plan["action_count"] == 1
    assert plan["actions"][0]["action"] == "block_incompatible_model_pool_artifact"
    assert plan["actions"][0]["patch"] == {
        "version": "vBad",
        "status": "degraded",
        "serving_block_reason": "artifact_state_archived",
        "seq_len": None,
        "pred_len": None,
        "sequence_contract": None,
        "model_slot_status": "active",
        "serving_eligible": False,
        "production_weight": 0.0,
    }

    patched = resolver.apply_model_pool_reconcile_plan(
        model_pool={"models": {"PatchTST": {"status": "active", "version": "vBad"}}},
        plan=plan,
    )
    assert patched["models"]["PatchTST"]["status"] == "degraded"
    assert patched["models"]["PatchTST"]["production_weight"] == 0.0
    assert patched["models"]["PatchTST"]["serving_block_reason"] == "artifact_state_archived"


def _retired_test_apply_model_pool_reconcile_plan_updates_stale_compat_artifact_id():
    current_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vGood",
                "gcs_path": "universal/patchtst/vGood.zip",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "PatchTST:vOld:weekly_drift",
            }
        }
    }
    champion_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vGood",
                "gcs_path": "universal/patchtst/vGood.zip",
                "metadata_path": "universal/patchtst/metadata_vGood.json",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "PatchTST:vGood:weekly_drift",
            }
        }
    }
    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current_pool,
        champion_pool=champion_pool,
        model_names=("PatchTST",),
    )

    patched = resolver.apply_model_pool_reconcile_plan(model_pool=current_pool, plan=plan)

    assert patched["models"]["PatchTST"]["serving_artifact_id"] == "PatchTST:vGood:weekly_drift"
    assert patched["models"]["PatchTST"]["version"] == "vGood"
    assert patched["source_of_truth"] == "model_champion_pointers"
    assert patched["reconcile_evidence"]["applied_count"] == 1


def _retired_test_oof_prior_quarantines_stale_fallback_ic_and_reconcile_repairs_pool():
    artifact = {
        "artifact_id": "XGBoost:vGood:oof_full_fit_release",
        "model_name": "XGBoost",
        "version": "vGood",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/xgboost/vGood.joblib",
        "checksum": "sha256:" + "a" * 64,
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "promoted",
        "offline_evidence_json": {
            "registration": {
                "metadata": {
                    "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                    "feature_semantic_version": resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
                    "sample_count": 1000,
                    "model_cpcv": {
                        "method": "outer_purged_walk_forward_rank_ic",
                        "decision": "PASS",
                        "passed": True,
                        "oos_ic_mean": 0.0617,
                        "folds": 5,
                        "positive_fold_ratio": 0.6,
                    },
                }
            }
        },
    }
    stale_pool = {
        "models": {
            "XGBoost": {
                "status": "active",
                "version": "vGood",
                "rolling_ic": -0.09,
                "ic_4w_avg": -0.08,
                "weekly_ic": [-0.09],
                "last_ic_semantic_version": "daily-cross-sectional-equal-date-v2",
                "last_ic_evaluation_contract": {
                    "target_semantic_version": "next-session-open-to-fifth-session-close-v2",
                },
            }
        }
    }
    champion_pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "XGBoost",
            "champion_version": "vGood",
            "champion_artifact_id": artifact["artifact_id"],
        }],
        artifacts=[artifact],
        fallback_pool=stale_pool,
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    champion = champion_pool["models"]["XGBoost"]
    assert champion["rolling_ic"] is None
    assert champion["weekly_ic"] == []
    assert champion["serving_ic_prior"]["value"] == 0.0617
    assert champion["serving_ic_prior"]["artifact_version"] == "vGood"

    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=stale_pool,
        champion_pool=champion_pool,
        model_names=("XGBoost",),
    )
    repaired = resolver.apply_model_pool_reconcile_plan(model_pool=stale_pool, plan=plan)
    entry = repaired["models"]["XGBoost"]
    assert entry["rolling_ic"] is None
    assert entry["ic_4w_avg"] is None
    assert entry["weekly_ic"] == []
    assert entry["serving_ic_prior"]["source"] == "candidate_scoped_purged_oof_model_cpcv"


def _retired_test_champion_projection_requires_and_reconciles_checksum():
    checksum = "sha256:" + "c" * 64
    artifact = {
        "artifact_id": "LightGBM:vGood:oof_full_fit_release",
        "model_name": "LightGBM",
        "version": "vGood",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/lightgbm/vGood.joblib",
        "metadata_path": "universal/lightgbm/metadata_vGood.json",
        "offline_gate_decision": "PASS",
        "checksum": checksum,
        "offline_evidence_json": {
            "registration": {
                "metadata": {
                    "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                    "feature_semantic_version": resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
                }
            }
        },
    }
    pointer = {
        "model_name": "LightGBM",
        "champion_version": "vGood",
        "champion_artifact_id": artifact["artifact_id"],
    }

    champion_pool = resolver.build_pool_from_champion_pointers(
        pointers=[pointer],
        artifacts=[artifact],
        fallback_pool=_fallback_pool(),
        required_models=("LightGBM",),
        sidecar_models=(),
    )
    champion = champion_pool["models"]["LightGBM"]
    assert champion["status"] == "active"
    assert champion["checksum"] == checksum

    current = {
        "models": {
            "LightGBM": {
                "status": "active",
                "version": "vGood",
                "serving_artifact_id": artifact["artifact_id"],
            }
        }
    }
    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current, champion_pool=champion_pool, model_names=("LightGBM",)
    )
    assert plan["actions"][0]["patch"]["checksum"] == checksum
    repaired = resolver.apply_model_pool_reconcile_plan(model_pool=current, plan=plan)
    assert repaired["models"]["LightGBM"]["checksum"] == checksum

    artifact_without_checksum = dict(artifact)
    artifact_without_checksum.pop("checksum")
    blocked = resolver.build_pool_from_champion_pointers(
        pointers=[pointer],
        artifacts=[artifact_without_checksum],
        fallback_pool=_fallback_pool(),
        required_models=("LightGBM",),
        sidecar_models=(),
    )["models"]["LightGBM"]
    assert blocked["serving_eligible"] is False
    assert blocked["serving_block_reason"] == "artifact_checksum_missing_or_invalid"
