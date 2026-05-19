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
    assert spec["memory_mb"] == 8192


def test_modal_predict_batch_chunks_payloads():
    payloads = [{"symbol": str(i)} for i in range(25)]

    chunks = modal_client._chunk_payloads(payloads, 10)

    assert [len(c) for c in chunks] == [10, 10, 5]


def test_modal_predict_batch_v2_is_default_contract(monkeypatch):
    monkeypatch.delenv("MODAL_PREDICT_BATCH_V2", raising=False)
    monkeypatch.delenv("MODAL_PREDICT_BATCH_SIZE", raising=False)

    contract = modal_client.batch_predict_contract()

    assert contract["modal_predict_batch_v2"] is True
    assert contract["chunk_size"] == 40


def test_modal_predict_batch_v2_can_be_disabled(monkeypatch):
    monkeypatch.setenv("MODAL_PREDICT_BATCH_V2", "0")
    monkeypatch.setenv("MODAL_PREDICT_BATCH_SIZE", "12")

    contract = modal_client.batch_predict_contract()

    assert contract["modal_predict_batch_v2"] is False
    assert contract["chunk_size"] == 12


def test_modal_predict_batch_contract_supports_20_40_80_ab(monkeypatch):
    monkeypatch.delenv("MODAL_PREDICT_BATCH_SIZE", raising=False)
    monkeypatch.delenv("MODAL_PREDICT_BATCH_SIZE_OBSERVATIONS", raising=False)
    monkeypatch.setenv("MODAL_PREDICT_BATCH_SIZE_CANDIDATES", "20,40,80")

    contract = modal_client.batch_predict_contract(ab_key="run:2026-05-06")

    assert contract["chunk_candidates"] == [20, 40, 80]
    assert contract["chunk_size"] in {20, 40, 80}
    assert contract["chunk_size_source"] == "ab"
    assert contract["ab_key"] == "run:2026-05-06"


def test_modal_predict_batch_contract_uses_observed_wall_time(monkeypatch):
    monkeypatch.delenv("MODAL_PREDICT_BATCH_SIZE", raising=False)
    monkeypatch.setenv("MODAL_PREDICT_BATCH_SIZE_CANDIDATES", "20,40,80")
    monkeypatch.setenv(
        "MODAL_PREDICT_BATCH_SIZE_OBSERVATIONS",
        """
        [
          {"chunk_size": 20, "wall_sec": 120, "input_count": 60, "n_error": 0},
          {"chunk_size": 40, "wall_sec": 90, "input_count": 60, "n_error": 0},
          {"chunk_size": 80, "wall_sec": 110, "input_count": 60, "n_error": 0}
        ]
        """,
    )

    contract = modal_client.batch_predict_contract(ab_key="run:2026-05-17")

    assert contract["chunk_size"] == 40
    assert contract["chunk_size_source"] == "observed_wall_time"
    assert contract["chunk_policy"]["selected"]["wall_sec_per_symbol"] == 1.5


def test_modal_predict_batch_contract_rejects_high_error_observation(monkeypatch):
    monkeypatch.delenv("MODAL_PREDICT_BATCH_SIZE", raising=False)
    monkeypatch.setenv("MODAL_PREDICT_BATCH_SIZE_CANDIDATES", "20,40")
    monkeypatch.setenv("MODAL_PREDICT_BATCH_SIZE_MAX_ERROR_RATE", "0.02")
    monkeypatch.setenv(
        "MODAL_PREDICT_BATCH_SIZE_OBSERVATIONS",
        """
        [
          {"chunk_size": 20, "wall_sec": 40, "input_count": 40, "n_error": 4},
          {"chunk_size": 40, "wall_sec": 80, "input_count": 40, "n_error": 0}
        ]
        """,
    )

    contract = modal_client.batch_predict_contract(ab_key="run:2026-05-17")

    assert contract["chunk_size"] == 40
    assert contract["chunk_size_source"] == "observed_wall_time"
    assert contract["chunk_policy"]["rejected"][0]["chunk_size"] == 20
    assert contract["chunk_policy"]["rejected"][0]["reason"] == "error_rate"


def test_modal_predict_batch_metrics_aggregate_chunk_cache_stats():
    metrics = modal_client._aggregate_predict_batch_metrics([
        {"metrics": {"batch": {"n_input": 10, "n_error": 1}, "model_cache": {"hits": 5, "misses": 3, "gcs_downloads": 3}}},
        {"metrics": {"batch": {"n_input": 10, "n_error": 0}, "model_cache": {"hits": 7, "misses": 0, "gcs_downloads": 0}}},
        {"results": []},
    ])

    assert metrics["chunks_reported"] == 2
    assert metrics["batch"] == {"n_input": 20, "n_error": 1}
    assert metrics["batch_error_rate"] == 0.05
    assert metrics["model_cache"] == {"hits": 12, "misses": 3, "gcs_downloads": 3}
    assert metrics["model_cache_hit_ratio"] == 0.8
