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


def test_oof_cohort_completion_metadata_is_forwarded_to_modal():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert '"completion_task": req.completion_task' in source
    assert '"completion_run_date": req.completion_run_date' in source
    assert 'completion_task=f"active8-oof-{cadence}"' in source


def test_spawned_modal_cohort_is_durable_pending_not_a_job_failure():
    source = (ROOT / "ml-controller" / "oof_materialize_job_main.py").read_text(encoding="utf-8")
    assert 'status in {"skipped", "pending", "spawned"}' in source
