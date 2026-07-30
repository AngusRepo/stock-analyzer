from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent


def test_oof_external_lifecycle_dispatches_durable_prep_owner_before_selecting_cohort():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    dispatch = source.index('"reason": "durable_prep_first_oof_job_dispatched"')
    bucket_lookup = source.index("bucket = _get_bucket()", source.index("async def run_walk_forward_oof_lifecycle"))
    parent_lookup = source.index("parent = _latest_ready_oof_manifest(bucket)")
    assert dispatch < bucket_lookup < parent_lookup
    assert 'os.environ.get("OOF_MATERIALIZE_JOB_EXECUTION", "").strip() != "1"' in source


def test_prep_selector_requires_semantic_signal_horizon_and_never_uses_created_at_as_fallback():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    start = source.index("def _latest_canonical_prep_prefix")
    end = source.index("def _oof_lifecycle_calendar", start)
    selector = source[start:end]
    assert 'and str(manifest.get("signal_date_max") or "")[:10]' in selector
    assert 'manifest.get("signal_date_max") or manifest.get("created_at")' not in selector
    assert 'str(manifest["signal_date_max"])[:10]' in selector


def test_oof_cohort_completion_is_owned_by_durable_daily_scheduler():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    modal = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    assert "completion_task" not in source
    assert "_trigger_worker_admin_task" not in modal
    assert '"status": "terminal_completed"' in source
    assert '"manifest_checksum": manifest.get("manifest_checksum")' in source


def test_spawned_modal_cohort_is_durable_pending_not_a_job_failure():
    source = (ROOT / "ml-controller" / "oof_materialize_job_main.py").read_text(encoding="utf-8")
    assert 'status in {"skipped", "pending", "spawned"}' in source


def test_walk_forward_modal_spawn_is_non_blocking_async():
    modal_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    router_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert "async def spawn_walk_forward_orchestrator" in modal_source
    assert "return await fn.spawn.aio(payload)" in modal_source
    assert "fn_call = await modal_client.spawn_walk_forward_orchestrator" in router_source
