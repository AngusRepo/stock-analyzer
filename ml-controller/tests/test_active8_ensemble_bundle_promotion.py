import asyncio
import hashlib
import json

from routers import model_pool as model_pool_router
from services import model_artifact_registry as registry
from services.active8_release_training_contract import ACTIVE8_MODEL_NAMES


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _fixture():
    rows = []
    base = {}
    for model in ACTIVE8_MODEL_NAMES:
        checksum = "sha256:" + hashlib.sha256(model.encode()).hexdigest()
        artifact_id = f"{model}:v-new:oof_full_fit_release"
        base[model] = {
            "artifact_id": artifact_id,
            "version": "v-new",
            "checksum": checksum,
            "candidate_type": "oof_full_fit_release",
        }
        rows.append({
            **base[model],
            "model_name": model,
            "training_run_id": "run-new",
            "state": "offline_failed" if model == "PatchTST" else "offline_passed",
            "artifact_path": f"{model}/v-new.bin",
            "metadata_path": f"{model}/v-new.json",
            "offline_evidence_json": json.dumps({
                "registration": {"oof_promotion_evidence": {
                    "schema_version": "model-cpcv-evidence-v1",
                    "method": "outer_purged_walk_forward_rank_ic",
                    "folds": 5,
                    "decision": "FAIL" if model == "PatchTST" else "PASS",
                }}
            }),
        })
    selected = [model for model in ACTIVE8_MODEL_NAMES if model != "PatchTST"]
    payload = {
        "schema_version": "active8-oof-ensemble-serving-artifact-v1",
        "observation_artifacts": base,
        "observation_artifact_set_checksum": "a" * 64,
        "base_artifacts": {model: base[model] for model in selected},
        "selected_models": selected,
        "excluded_models": ["PatchTST"],
        "validation": {"decision": "PASS", "failed_gates": []},
    }
    payload["payload_checksum"] = hashlib.sha256(_canonical(payload).encode()).hexdigest()
    ensemble = {
        "artifact_id": "active8-ensemble:cohort-new:1234",
        "cohort_id": "cohort-new",
        "training_run_id": "run-new",
        "payload_json": _canonical(payload),
        "payload_checksum": payload["payload_checksum"],
        "base_artifact_set_checksum": "b" * 64,
        "validation_decision": "PASS",
        "state": "candidate",
    }
    pointers = [{
        "model_name": model,
        "champion_version": "v-old",
        "champion_artifact_id": f"old:{model}",
    } for model in ACTIVE8_MODEL_NAMES]
    return rows, pointers, ensemble


class AtomicD1:
    def __init__(self, rows, ensemble):
        self.statements = None
        self.rows = rows
        self.ensemble = ensemble

    def atomic_batch_execute(self, statements, timeout=0):
        self.statements = statements
        return {"atomic": True, "total": len(statements)}

    def query(self, sql, params=None):
        if "FROM model_champion_pointers AS p" in sql:
            return [
                {
                    "model_name": row["model_name"],
                    "champion_artifact_id": row["artifact_id"],
                    "training_run_id": row["training_run_id"],
                    "state": "production",
                }
                for row in self.rows
            ]
        if "FROM active8_ensemble_pointer_v1 AS p" in sql:
            return [{
                "artifact_id": self.ensemble["artifact_id"],
                "payload_checksum": self.ensemble["payload_checksum"],
                "base_artifact_set_checksum": self.ensemble["base_artifact_set_checksum"],
                "training_run_id": self.ensemble["training_run_id"],
                "cohort_id": self.ensemble["cohort_id"],
                "payload_json": self.ensemble["payload_json"],
                "validation_decision": self.ensemble["validation_decision"],
                "promoted_at": "2026-08-27T00:00:00Z",
                "state": "production",
                "production_effect": 1,
            }]
        raise AssertionError(sql)


def test_bundle_dry_run_observes_weak_learner_but_promotes_only_selected_models():
    rows, pointers, ensemble = _fixture()
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=rows,
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
        confirm=False,
    )
    assert result["can_promote"] is True
    assert len(result["observation_models"]) == 8
    assert len(result["release_models"]) == 7
    assert "PatchTST" not in result["release_models"]
    assert result["validation"]["decision"] == "PASS"


def test_bundle_commit_is_one_atomic_batch(monkeypatch):
    rows, pointers, ensemble = _fixture()
    d1 = AtomicD1(rows, ensemble)
    monkeypatch.setattr(registry, "d1_client", d1)
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=rows,
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
        confirm=True,
    )
    assert result["status"] == "ok"
    assert result["d1_batch"]["atomic"] is True
    assert result["readback_verified"] is True
    assert len(d1.statements) == 38
    sql = "\n".join(statement[0] for statement in d1.statements)
    assert "active8_ensemble_pointer_v1" in sql
    assert "model_champion_pointers" in sql


def test_serving_bundle_read_model_never_falls_back_to_legacy_pointers(monkeypatch):
    rows, _, ensemble = _fixture()
    d1 = AtomicD1(rows, ensemble)
    monkeypatch.setattr(registry, "d1_client", d1)

    serving = registry.load_active8_ensemble_serving_bundle()
    assert serving["status"] == "production"
    assert serving["production_effect"] is True
    assert serving["artifact_id"] == ensemble["artifact_id"]
    assert set(serving["selected_models"]) == set(json.loads(ensemble["payload_json"])["selected_models"])
    assert set(serving["base_artifacts"]) == set(serving["selected_models"])

    class NoBundleD1:
        @staticmethod
        def query(sql, params=None):
            assert "active8_ensemble_pointer_v1" in sql
            return []

    monkeypatch.setattr(registry, "d1_client", NoBundleD1())
    missing = registry.load_active8_ensemble_serving_bundle()
    assert missing["status"] == "evidence_only_no_action"
    assert missing["production_effect"] is False
    assert missing["base_artifacts"] == {}
    assert missing["blockers"] == ["active8_v5_serving_bundle_not_promoted"]

def test_champion_pointer_read_model_keeps_legacy_names_out_of_active8_slots(monkeypatch):
    monkeypatch.setattr(
        model_pool_router,
        "list_champion_pointers",
        lambda model_name=None: [{
            "model_name": "legacy_retired_model",
            "champion_version": "v-old",
            "champion_artifact_id": "legacy:artifact",
        }],
    )
    monkeypatch.setattr(model_pool_router, "list_artifact_registry", lambda model_name=None, limit=200: [])
    monkeypatch.setattr(
        model_pool_router,
        "load_active8_ensemble_serving_bundle",
        lambda: {
            "status": "evidence_only_no_action",
            "production_effect": False,
            "base_artifacts": {},
        },
    )

    result = asyncio.run(model_pool_router.artifact_registry_champion_pointers())

    assert result["model_count"] == len(ACTIVE8_MODEL_NAMES)
    assert set(result["models"]) == set(ACTIVE8_MODEL_NAMES)
    assert "legacy_retired_model" not in result["models"]
    assert result["pointers"][0]["authority"] == "legacy_rollback_audit_only"


def test_bundle_rejects_missing_model():
    rows, pointers, ensemble = _fixture()
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=rows[:-1],
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
    )
    assert result["can_promote"] is False
    assert result["decision"] == "active8_bundle_incomplete"