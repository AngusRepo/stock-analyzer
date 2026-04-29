from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.modal_client import _aggregate_map_compute_sec, _modal_resource_spec  # noqa: E402
from services import modal_client  # noqa: E402


def test_modal_resource_spec_knows_expensive_gpu_functions():
    spec = _modal_resource_spec("train_ftt_model")

    assert spec["gpu"] == "L4"
    assert spec["cpu"] == 1
    assert spec["memory_mb"] == 4096


def test_modal_map_compute_uses_aggregate_container_seconds():
    assert _aggregate_map_compute_sec(wall_sec=12.5, item_count=20) == 250.0
    assert _aggregate_map_compute_sec(wall_sec=12.5, item_count=0) == 12.5


def test_modal_resource_spec_knows_predict_batch_v2():
    spec = _modal_resource_spec("predict_batch_v2")

    assert spec["cpu"] == 2
    assert spec["memory_mb"] == 4096


def test_modal_predict_batch_chunks_payloads():
    payloads = [{"symbol": str(i)} for i in range(25)]

    chunks = modal_client._chunk_payloads(payloads, 10)

    assert [len(c) for c in chunks] == [10, 10, 5]
