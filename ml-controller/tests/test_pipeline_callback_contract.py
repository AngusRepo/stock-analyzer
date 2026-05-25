import pytest
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import google.cloud as google_cloud
except ImportError:
    google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
setattr(google_cloud, "run_v2", run_v2_stub)
sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)

from routers import pipeline


@pytest.mark.asyncio
async def test_pipeline_subtask_callbacks_include_run_date(monkeypatch):
    payloads = []

    async def fake_callback_worker(payload, client=None):
        payloads.append(payload)

    monkeypatch.setattr(pipeline, "_callback_worker", fake_callback_worker)

    await pipeline._emit_subtask_callbacks(
        "pipeline-v2-test",
        {"metrics": {"predictions_written": 10, "prediction_symbols": 2, "prediction_output_models": 5, "recommendations_updated": 2}},
        "success",
        None,
        1234,
        run_date="2026-05-04",
    )

    assert {payload["task"] for payload in payloads} == {"ml-predict", "recommendation"}
    assert all(payload["run_date"] == "2026-05-04" for payload in payloads)
    assert [p for p in payloads if p["task"] == "ml-predict"][0]["summary"] == "run_id=pipeline-v2-test symbols=2 rows=10 models=5"


def test_pipeline_subtask_callbacks_do_not_overwrite_worker_owned_screener():
    source = Path(pipeline.__file__).read_text(encoding="utf-8")

    callback_body = source[source.index("subtasks = ["):source.index("async with httpx.AsyncClient")]
    assert '"screener"' not in callback_body
    assert "Screener is Worker-owned before" in source


def test_pipeline_subtask_callbacks_are_fanned_out_concurrently():
    source = Path(pipeline.__file__).read_text(encoding="utf-8")

    assert "asyncio.gather" in source
    assert "for task, ok, summary in subtasks" in source
    assert "await _callback_worker(payload, client=client)" in source


def test_pipeline_job_fans_out_terminal_and_tile_callbacks_concurrently():
    source = (Path(__file__).resolve().parent.parent / "pipeline_job_main.py").read_text(encoding="utf-8")
    callback_tail = source[source.index("await asyncio.gather("):source.index("logger.info(\n        \"[JobEntry] Pipeline finished")]

    assert "await asyncio.gather(" in callback_tail
    assert "_callback_worker(overall_payload)" in callback_tail
    assert "_emit_subtask_callbacks(run_id, result, status, error, elapsed_ms" in callback_tail
    assert callback_tail.index("_callback_worker(overall_payload)") < callback_tail.index("_run_deferred_snapshot_followup")
    assert callback_tail.index("_emit_subtask_callbacks(run_id, result, status, error, elapsed_ms") < callback_tail.index(
        "_run_deferred_snapshot_followup"
    )


def test_pipeline_job_exposes_callback_tail_cost_attribution_metadata():
    source = (Path(__file__).resolve().parent.parent / "pipeline_job_main.py").read_text(encoding="utf-8")

    assert '"provider": "gcp_cloud_run"' in source
    assert '"job_name": "pipeline-v2"' in source
    assert '"remote_function": "pipeline_job_main"' in source
    assert "PIPELINE_CLOUD_RUN_CPU" in source
    assert "PIPELINE_CLOUD_RUN_MEMORY_MB" in source
    assert "**_cloud_run_resource_metadata()" in source
    assert '"duration_ms_semantics": "pipeline_graph_runtime_excludes_callback_tail"' in source
    assert '"callback_tail_strategy": "terminal_and_tile_asyncio_gather"' in source
    assert "callback_fanout_ms" in source
    assert "snapshot_followup_ms" in source
    assert "graph_elapsed=%dms callback_fanout=%dms snapshot_followup=%dms total=%dms" in source


def test_deferred_snapshot_callbacks_include_compute_attribution_metadata():
    source = (Path(__file__).resolve().parent.parent / "pipeline_job_main.py").read_text(encoding="utf-8")

    assert '"remote_function": "pipeline_job_main.dataset_snapshot_inline"' in source
    assert '"remote_function": "dataset_snapshot_export"' in source
    assert '"remote_function": "pipeline_job_main.modal_snapshot_trigger"' in source
    assert '"remote_function": "pipeline_job_main.cloud_run_snapshot_trigger"' in source


def test_pipeline_terminal_callback_has_longer_timeout():
    source = Path(pipeline.__file__).read_text(encoding="utf-8")

    assert 'timeout_s = 60.0 if payload.get("task") == "pipeline" else 15.0' in source
    assert "httpx.AsyncClient(timeout=timeout_s)" in source
