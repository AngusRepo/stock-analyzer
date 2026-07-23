from __future__ import annotations

import asyncio
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import pipeline_snapshot_recovery as recovery  # noqa: E402
from services import state_space_series  # noqa: E402


SOURCE_URI = (
    "gs://stockvision-models/pipeline-v2/async-modal-prediction/"
    "2026-07-22/pipeline-v2-nlbpk/partial_state.json"
)


def _state() -> dict:
    payloads = [
        {"symbol": "2330", "prices": [{"date": "2026-07-22", "close": 100.0}]},
        {"symbol": "2317", "prices": [{"date": "2026-07-22", "close": 90.0}]},
    ]
    return {
        "run_date": "2026-07-22",
        "producer_run_id": "pipeline-v2-nlbpk",
        "payloads": payloads,
        "l3_payloads": deepcopy(payloads),
        "market_env": {"regime": "bull"},
        "pipeline_modal_serving_context": {
            "schema_version": "pipeline-modal-serving-context-v1",
            "active_versions": {"DLinear": "v1", "iTransformer": "v2"},
        },
        "errors": [],
        "metrics": {},
    }


def _envelope(created_at: str = "2026-07-23T00:16:15Z") -> dict:
    state = _state()
    return {
        "payload": {
            "schema_version": "pipeline-async-state-v1",
            "run_date": "2026-07-22",
            "producer_run_id": "pipeline-v2-nlbpk",
            "created_at": created_at,
            "state": state,
        },
        "state": state,
        "artifact": {
            "gcs_uri": SOURCE_URI,
            "generation": "1784765785571313",
            "sha256": "a" * 64,
        },
    }


def test_validate_snapshot_recovery_accepts_only_preopen_complete_state():
    state, lineage = recovery.validate_snapshot_recovery_source(
        _envelope(),
        source_gcs_uri=SOURCE_URI,
        run_date="2026-07-22",
        next_session_date="2026-07-23",
    )

    assert state["producer_run_id"] == "pipeline-v2-nlbpk"
    assert lineage["generation_mode"] == "point_in_time_snapshot_recovery"
    assert lineage["eligible_for_native_learning"] is False
    assert lineage["candidate_count"] == 2
    assert lineage["source_active_versions"] == {"DLinear": "v1", "iTransformer": "v2"}


def test_validate_snapshot_recovery_rejects_state_created_at_or_after_next_open():
    with pytest.raises(ValueError, match="source_not_preopen"):
        recovery.validate_snapshot_recovery_source(
            _envelope("2026-07-23T01:00:00Z"),
            source_gcs_uri=SOURCE_URI,
            run_date="2026-07-22",
            next_session_date="2026-07-23",
        )


def test_validate_snapshot_recovery_rejects_payload_identity_mismatch():
    envelope = _envelope()
    envelope["state"]["l3_payloads"][1]["symbol"] = "2454"
    with pytest.raises(ValueError, match="payload_identity_mismatch"):
        recovery.validate_snapshot_recovery_source(
            envelope,
            source_gcs_uri=SOURCE_URI,
            run_date="2026-07-22",
            next_session_date="2026-07-23",
        )


def test_pit_checksum_ignores_only_recovery_owned_state_fields():
    state = _state()
    original = recovery.pit_state_checksum(state)
    state["producer_run_id"] = "recovery-run"
    state["pipeline_modal_serving_context"] = {"active_versions": {"DLinear": "v1"}}
    state["snapshot_recovery_lineage"] = {"scope": "serving_contract_only"}
    assert recovery.pit_state_checksum(state) == original
    state["payloads"][0]["prices"][0]["close"] = 101.0
    assert recovery.pit_state_checksum(state) != original


def test_snapshot_recovery_spawns_with_same_artifact_versions_and_non_native_lineage(monkeypatch):
    monkeypatch.setattr(recovery, "load_pipeline_state_envelope", lambda _uri: _envelope())
    evidence = {
        "schema_version": "state-space-sequence-artifact-evidence-v1",
        "object_fingerprint": "b" * 64,
        "objects": [],
    }
    monkeypatch.setattr(recovery, "long_history_sequence_artifact_evidence", lambda **_kwargs: evidence)

    def query_fn(_sql, _params):
        return [{"next_session_date": "2026-07-23"}]

    async def attach_context(state):
        context = {
            "schema_version": "pipeline-modal-serving-context-v1",
            "active_versions": {"DLinear": "v1", "iTransformer": "v2"},
        }
        state["pipeline_modal_serving_context"] = context
        return context

    def write_state(state):
        assert state["snapshot_recovery_lineage"]["eligible_for_native_learning"] is False
        return "gs://stockvision-models/derived/partial_state.json"

    async def build_payload(state, *, state_gcs_uri):
        assert state_gcs_uri.endswith("partial_state.json")
        return {"run_id": state["producer_run_id"], "payloads": state["payloads"]}

    result = asyncio.run(recovery.run_pipeline_snapshot_recovery(
        source_gcs_uri=SOURCE_URI,
        run_date="2026-07-22",
        producer_run_id="pipeline-v2-recovery-7-22",
        query_fn=query_fn,
        attach_serving_context=attach_context,
        write_state_artifact=write_state,
        build_modal_payload=build_payload,
        spawn_prediction_bundle=lambda payload: {
            "function_call_id": "fc-1",
            "function_name": "pipeline_prediction_bundle",
            "n_input": len(payload["payloads"]),
            "callback_configured": True,
        },
    ))

    async_state = result["metrics"]["async_modal_prediction"]
    assert result["status"] == "deferred"
    assert async_state["n_input"] == 2
    assert async_state["eligible_for_native_learning"] is False


class _FakeBlob:
    def __init__(self, name: str, *, raw: str = "", updated: str = "2026-07-16T13:51:17Z"):
        self.name = name
        self.raw = raw
        self.updated = datetime.fromisoformat(updated.replace("Z", "+00:00"))
        self.generation = "10"
        self.size = len(raw) or 10
        self.md5_hash = "md5"
        self.crc32c = "crc"

    def exists(self):
        return True

    def reload(self):
        return None

    def download_as_text(self):
        return self.raw


class _FakeBucket:
    def __init__(self, updated: str = "2026-07-16T13:51:17Z"):
        self.updated = updated

    def blob(self, name: str):
        raw = '{"batch_count": 2}' if name.endswith("sequence_manifest.json") else ""
        return _FakeBlob(name, raw=raw, updated=self.updated)


class _FakeStorage:
    def __init__(self, updated: str = "2026-07-16T13:51:17Z"):
        self.updated = updated

    def bucket(self, _name: str):
        return _FakeBucket(self.updated)


def test_sequence_artifact_evidence_is_checksum_addressed_and_preopen(monkeypatch):
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    evidence = state_space_series.long_history_sequence_artifact_evidence(
        as_of_utc="2026-07-23T00:16:15Z",
        storage_client=_FakeStorage(),
    )
    assert evidence["batch_count"] == 2
    assert evidence["object_count"] == 3
    assert len(evidence["object_fingerprint"]) == 64


def test_sequence_artifact_evidence_rejects_object_newer_than_pit_source(monkeypatch):
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    with pytest.raises(RuntimeError, match="newer than PIT source state"):
        state_space_series.long_history_sequence_artifact_evidence(
            as_of_utc="2026-07-23T00:16:15Z",
            storage_client=_FakeStorage("2026-07-23T00:17:00Z"),
        )
