"""R33 on the paper receipt path: a paper-admission inference grant for the R33 object,
attached to every row (scored and unscored), closed by the nav execution receipt and the
original writer's D1 readback. The paper admission content itself is A2's; here it is
stubbed at validate_publication_receipt so the R33 side of the chain is exercised whole."""
import json
import re
import sqlite3
from pathlib import Path

import pytest

from services import active8_nav_execution as execution
from services import active8_paper_admission as admission
from services import recommendation_service as writer
from services.active8_nav_inference import SCHEMA, restore_frozen_nav_inference
from services.ensemble_v2 import attach_ensemble_v2
from services.paired_nav_journal import digest
from test_r33_l4_equal7 import DAY, _ensemble
from test_r33_serving_chain import COST, POOL_MODELS, _chain


def _context(ensemble, *, captured_at="2026-11-09T12:00:00Z"):
    body = {"schema_version": SCHEMA, "scope": "frozen_compute_only", "captured_at": captured_at,
            "artifact_checksum": ensemble["payload_checksum"],
            "publication_receipt": {"paper_admission": {"synthetic": True}}, "review_records": []}
    return {**body, "context_checksum": digest(body)}


@pytest.fixture
def chain(monkeypatch):
    seen = []
    monkeypatch.setattr(admission, "validate_publication_receipt",
                        lambda receipt, artifact, now=None: seen.append(artifact["artifact_id"]) or {})
    ensemble = _ensemble()
    context = _context(ensemble)
    grant = restore_frozen_nav_inference(context, artifact=ensemble, pool_models=POOL_MODELS)
    predictions, _snapshot = _chain(stale={"P6": "last_bar=2026-11-07"})
    for prediction in predictions.values():
        prediction["feature_version"] = "r33-fixture"
        attach_ensemble_v2(prediction, ensemble, POOL_MODELS, round_trip_cost=COST, nav_authority=grant)
    manifest = {"active8_ensemble": ensemble, "active8_nav_inference": context}
    receipt = execution.attach_execution_receipt(predictions=predictions, manifest=manifest, pool_models=POOL_MODELS,
                                                 run_id="r33-paper-run", run_date=DAY)
    return ensemble, context, predictions, receipt, seen


@pytest.fixture
def d1(monkeypatch):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    root = Path(__file__).parents[2]
    schema = (root / "worker/domain-schemas/learning.sql").read_text(encoding="utf-8")
    conn.executescript(re.search(r"CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);", schema).group())
    from nav_bundle_sqlite import ensure_prediction_schema
    ensure_prediction_schema(conn)

    def clock(sql):
        return sql.replace("datetime('now')", f"'{DAY} 12:00:00'")

    def query(sql, params=None, timeout=None):
        return [dict(r) for r in conn.execute(clock(sql), params or [])]

    def batch(statements):
        for sql, params in statements:
            conn.execute(clock(sql), params)
        conn.commit()
        return {"success_count": len(statements), "error_count": 0}
    monkeypatch.setattr(writer, "_predictions_query", query)
    monkeypatch.setattr(writer, "_predictions_batch_execute", batch)
    return conn, query


def test_r33_paper_grant_closes_the_execution_receipt_and_the_d1_readback(chain, d1):
    ensemble, _context_, predictions, receipt, seen = chain
    _conn, query = d1
    assert seen and set(seen) == {ensemble["artifact_id"]}
    assert receipt["artifact_checksum"] == ensemble["payload_checksum"]
    assert receipt["symbol_count"] == len(predictions)
    assert predictions["P6"]["ensemble_v2"]["lineage_status"] == "unscored"      # the unscored name is bound too
    assert execution.pending_execution_receipt(predictions) == receipt
    observations = []
    stock_ids = {s: i + 1 for i, s in enumerate(sorted(predictions))}
    writer.write_predictions_to_d1(predictions, stock_ids, DAY, execution_sink=observations.append)
    assert len(observations) == 1 and observations[0]["readback_verified"] is True
    assert execution.read_execution(query=query, receipt=receipt) == observations[0]


def test_a_row_without_the_grant_stamp_breaks_the_receipt(chain):
    ensemble, context, predictions, _receipt, _seen = chain
    predictions["P2"]["ensemble_v2"].pop("adoption_basis")
    with pytest.raises(ValueError, match="active8_nav_execution_output_identity_mismatch"):
        execution.attach_execution_receipt(predictions=predictions, manifest={
            "active8_ensemble": ensemble, "active8_nav_inference": context}, pool_models=POOL_MODELS,
            run_id="r33-paper-run", run_date=DAY)


def test_a_changed_output_after_the_receipt_fails_before_the_write(chain):
    _ensemble_, _context_, predictions, _receipt, _seen = chain
    predictions["P3"]["ensemble_v2"]["signal"] = "BUY" if predictions["P3"]["ensemble_v2"]["signal"] != "BUY" else "SELL"
    with pytest.raises(ValueError, match="active8_nav_execution_output_changed_before_write"):
        execution.pending_execution_receipt(predictions)


def test_unscored_lineage_is_accepted_only_for_r33(monkeypatch):
    from services import active8_nav_execution as module
    calls = []
    monkeypatch.setattr("services.active8_nav_inference.restore_frozen_nav_inference",
                        lambda *a, **k: calls.append(1))
    artifact = {"kind": "active8", "payload_checksum": "a" * 64}
    context = {"context_checksum": "c" * 64, "captured_at": "2026-11-09T12:00:00Z",
               "publication_receipt": {"paper_admission": {}}}
    predictions = {"S1": {"ensemble_v2": {"adoption_basis": "committed_paired_nav", "artifact_checksum": "a" * 64,
                                          "nav_inference_context_checksum": "c" * 64, "lineage_status": "unscored",
                                          "signal": "NO_SIGNAL"}}}
    with pytest.raises(ValueError, match="active8_nav_execution_output_identity_mismatch"):
        module.attach_execution_receipt(predictions=predictions, manifest={
            "active8_ensemble": artifact, "active8_nav_inference": context}, pool_models={}, run_id="r", run_date=DAY)


def test_restore_rejects_a_grant_for_another_r33_object(monkeypatch):
    monkeypatch.setattr(admission, "validate_publication_receipt", lambda receipt, artifact, now=None: {})
    ensemble = _ensemble()
    tampered = json.loads(json.dumps(ensemble))
    tampered["cohort_id"] = "c2"
    with pytest.raises(ValueError, match="r33_ensemble_payload_checksum"):
        restore_frozen_nav_inference(_context(ensemble), artifact=tampered, pool_models=POOL_MODELS)


def test_r33_restore_needs_a_paper_admission_receipt():
    ensemble = _ensemble()
    body = {k: v for k, v in _context(ensemble).items() if k != "context_checksum"}
    body["publication_receipt"] = {"nav_validation": {"decision": "PASS"}}
    with pytest.raises(ValueError, match="r33_nav_inference_requires_paper_admission"):
        restore_frozen_nav_inference({**body, "context_checksum": digest(body)}, artifact=ensemble,
                                     pool_models=POOL_MODELS)


def test_the_object_is_validated_before_the_grant_when_both_fail():
    from copy import deepcopy
    from services.ensemble_v2 import validate_active8_ensemble_artifact
    from test_r33_serving_chain import _grant
    ensemble = _ensemble()
    tampered = deepcopy(ensemble)
    tampered["payload_checksum"] = "0" * 64           # the grant names the original checksum: both checks fail
    with pytest.raises(ValueError, match="r33_ensemble_payload_checksum"):
        validate_active8_ensemble_artifact(tampered, POOL_MODELS, nav_authority=_grant(ensemble))


def test_the_r33_object_is_its_own_registry_id():
    from services.ensemble_v2 import ensemble_artifact_id
    ensemble = _ensemble()
    assert ensemble_artifact_id(ensemble) == ensemble["artifact_id"] and ensemble["artifact_id"].startswith("r33-roster:")
    assert ensemble_artifact_id({"cohort_id": "c1", "payload_checksum": "f" * 64}) == "active8-ensemble:c1:" + "f" * 16
