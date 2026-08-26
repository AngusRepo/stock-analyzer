import json

import pytest

from services import model_artifact_registry as registry
from test_active8_ensemble_bundle_promotion import AtomicD1, _fixture


class BrokenReadbackD1(AtomicD1):
    def query(self, sql, params=None):
        rows = super().query(sql, params)
        if "FROM active8_ensemble_pointer_v1 AS p" in sql:
            return [{**rows[0], "payload_checksum": "0" * 64}]
        return rows


def test_bundle_rejects_duplicate_model_identity():
    rows, pointers, ensemble = _fixture()
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=[*rows, dict(rows[0])],
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
    )
    assert result["can_promote"] is False
    assert result["decision"] == "active8_bundle_incomplete"
    assert result["duplicate_models"] == [rows[0]["model_name"]]


def test_bundle_rejects_tampered_ensemble_checksum():
    rows, pointers, ensemble = _fixture()
    payload = json.loads(ensemble["payload_json"])
    payload["validation"]["decision"] = "FAIL"
    ensemble["payload_json"] = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=rows,
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
    )
    assert result["can_promote"] is False
    assert result["decision"] == "active8_ensemble_candidate_not_promotion_grade"


def test_bundle_rejects_base_with_fewer_than_five_outer_folds():
    rows, pointers, ensemble = _fixture()
    offline = json.loads(rows[0]["offline_evidence_json"])
    offline["registration"]["oof_promotion_evidence"]["folds"] = 1
    rows[0]["offline_evidence_json"] = json.dumps(offline)
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=rows,
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
    )
    assert result["can_promote"] is False
    assert result["decision"] == "active8_bundle_contract_invalid"
    assert result["blockers"] == [f"base_artifact_contract:{rows[0]['model_name']}"]


def test_bundle_rejects_base_identity_drift_even_when_ensemble_is_valid():
    rows, pointers, ensemble = _fixture()
    rows[0]["checksum"] = "sha256:" + "f" * 64
    result = registry.run_active8_ensemble_bundle_promotion_controller(
        training_run_id="run-new",
        registry_rows=rows,
        d1_pointers=pointers,
        ensemble_rows=[ensemble],
    )
    assert result["can_promote"] is False
    assert result["decision"] == "active8_bundle_contract_invalid"


def test_bundle_confirmation_fails_closed_on_pointer_readback_drift(monkeypatch):
    rows, pointers, ensemble = _fixture()
    d1 = BrokenReadbackD1(rows, ensemble)
    monkeypatch.setattr(registry, "d1_client", d1)
    with pytest.raises(RuntimeError, match="active8_bundle_atomic_readback_mismatch"):
        registry.run_active8_ensemble_bundle_promotion_controller(
            training_run_id="run-new",
            registry_rows=rows,
            d1_pointers=pointers,
            ensemble_rows=[ensemble],
            confirm=True,
        )
    assert d1.statements is not None
    assert len(d1.statements) == 43
