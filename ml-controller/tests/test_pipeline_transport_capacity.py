from __future__ import annotations

import ast
import gzip
import json
import sys
import types
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.pipeline_async_state_transport import (  # noqa: E402
    STATE_SCHEMA_V2,
    build_pipeline_payload_identity,
    decode_pipeline_state_envelope,
    encode_pipeline_state_envelope,
    validate_pipeline_payload_identity,
)
from services.pipeline_modal_request_transport import (  # noqa: E402
    REQUEST_REF_SCHEMA,
    prepare_pipeline_modal_request,
)


def _rows(count: int = 2) -> list[dict]:
    return [
        {
            "symbol": str(2300 + index),
            "prices": [{"date": "2026-08-24", "close": 100.0 + index}],
        }
        for index in range(count)
    ]


def _modal_request(count: int = 2) -> dict:
    return {
        "schema_version": "pipeline-modal-prediction-request-v1",
        "run_date": "2026-08-24",
        "run_id": "pipeline-dispatch:2026-08-24:test",
        "state_gcs_uri": "gs://stockvision-models/pipeline-v2/2026-08-24/partial_state.json.gz",
        "expected_source_sha": "a" * 40,
        "payloads": _rows(count),
        "callback_url": "https://controller.example/pipeline/callback",
        "callback_token": "do-not-persist",
    }


def test_pipeline_state_v2_is_gzipped_and_carries_one_payload_copy() -> None:
    rows = _rows()
    state = {
        "run_date": "2026-08-24",
        "payloads": rows,
        "pipeline_payload_identity": build_pipeline_payload_identity(rows),
    }
    envelope = {
        "schema_version": STATE_SCHEMA_V2,
        "run_date": "2026-08-24",
        "state": state,
    }

    encoded = encode_pipeline_state_envelope(envelope)
    assert encoded.startswith(b"\x1f\x8b")
    decoded = decode_pipeline_state_envelope(encoded)
    assert decoded["state"]["payloads"] == rows
    assert "l3_payloads" not in decoded["state"]
    assert len(gzip.decompress(encoded)) > len(encoded)


def test_pipeline_payload_identity_rejects_tamper_without_duplicate_copy() -> None:
    rows = _rows()
    state = {
        "payloads": rows,
        "pipeline_payload_identity": build_pipeline_payload_identity(rows),
    }
    validate_pipeline_payload_identity(state)
    state["payloads"][1]["symbol"] = "2454"
    with pytest.raises(ValueError, match="contract_mismatch"):
        validate_pipeline_payload_identity(state)


def test_modal_request_reference_is_small_secret_free_and_exact() -> None:
    request = _modal_request()
    compressed, reference = prepare_pipeline_modal_request(request)
    durable = json.loads(gzip.decompress(compressed))

    assert reference["schema_version"] == REQUEST_REF_SCHEMA
    assert reference["n_input"] == 2
    assert reference["request_compressed_bytes"] == len(compressed)
    assert reference["request_uncompressed_bytes"] == len(gzip.decompress(compressed))
    assert reference["callback_token"] == "do-not-persist"
    assert "callback_token" not in durable
    assert "callback_url" not in durable
    assert durable["payloads"] == request["payloads"]


def test_modal_request_capacity_fails_closed_without_top_k(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PIPELINE_MODAL_REQUEST_MAX_SYMBOLS", "2")
    with pytest.raises(ValueError, match="symbol_capacity_exceeded:3:2"):
        prepare_pipeline_modal_request(_modal_request(3))


def test_modal_reference_hydration_round_trip_and_tamper(monkeypatch: pytest.MonkeyPatch) -> None:
    compressed, reference = prepare_pipeline_modal_request(_modal_request())
    reference.update({
        "request_gcs_uri": (
            "gs://stockvision-models/pipeline-v2/async-modal-prediction/2026-08-24/"
            "pipeline-dispatch_2026-08-24_test/modal_request/{}.json.gz"
        ).format(reference["request_sha256"]),
        "request_generation": "7",
    })

    class Blob:
        def __init__(self, content: bytes):
            self.content = content

        def download_as_bytes(self, *, if_generation_match: int):
            assert if_generation_match == 7
            return self.content

    class Bucket:
        def __init__(self, content: bytes):
            self.content = content

        def blob(self, _name: str):
            return Blob(self.content)

    class Client:
        content = compressed

        def bucket(self, name: str):
            assert name == "stockvision-models"
            return Bucket(self.content)

    storage_module = types.ModuleType("google.cloud.storage")
    storage_module.Client = Client
    cloud_module = types.ModuleType("google.cloud")
    cloud_module.storage = storage_module
    google_module = types.ModuleType("google")
    google_module.cloud = cloud_module
    monkeypatch.setitem(sys.modules, "google", google_module)
    monkeypatch.setitem(sys.modules, "google.cloud", cloud_module)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", storage_module)

    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_hydrate_pipeline_prediction_request_reference"
    )
    namespace = {"get_gcs_bucket_name": lambda: "stockvision-models"}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "modal_app.py", "exec"), namespace)
    hydrated = namespace["_hydrate_pipeline_prediction_request_reference"](reference)
    assert hydrated["payloads"] == _modal_request()["payloads"]
    assert hydrated["callback_token"] == "do-not-persist"
    assert hydrated["request_transport"]["request_generation"] == "7"

    Client.content = compressed + b"tamper"
    with pytest.raises(ValueError, match="compressed_size_mismatch"):
        namespace["_hydrate_pipeline_prediction_request_reference"](reference)


def test_modal_runtime_contract_hydrates_generation_fenced_reference() -> None:
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    assert "_hydrate_pipeline_prediction_request_reference" in source
    bundle_start = source.index("def pipeline_prediction_bundle(payload: dict) -> dict:")
    bundle_end = source.index("@app.function(", bundle_start + 1)
    bundle_body = source[bundle_start:bundle_end]
    assert bundle_body.index("_setup_env()") < bundle_body.index("_hydrate_pipeline_prediction_request_reference")
    assert "if_generation_match=generation" in source
    assert "pipeline_modal_request_reference_compressed_checksum_mismatch" in source
    assert "pipeline_modal_request_reference_checksum_mismatch" in source
    assert "max_containers=2" in source
    graph = (ROOT / "ml-controller" / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    request_transport = (ROOT / "ml-controller" / "services" / "pipeline_modal_request_transport.py").read_text(encoding="utf-8")
    assert "_spawn_pipeline_prediction_bundle_from_artifact" in graph
    assert "state[\"l3_payloads\"] = list" not in graph
    assert "if_generation_match=0" in request_transport
    assert "pipeline-modal-prediction-request-ref-v1" in request_transport
    assert '"pipeline-modal-capacity-v1"' in source
    assert 'pipeline_modal_source_sha_mismatch:' in source
    assert 'f"expected={expected_source_sha}:actual={modal_source_sha}"' in source
