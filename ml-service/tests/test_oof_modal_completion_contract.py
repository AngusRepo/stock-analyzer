from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_ready_oof_manifest_event_drives_same_durable_owner():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")
    publish = source.index("publication = publish_oof_manifest(bucket, manifest)")
    trigger = source.index("completion_trigger = _trigger_worker_admin_task")
    assert publish < trigger
    assert 'manifest.get("status") == "ready"' in source[publish:trigger + 300]
    assert '"completion_trigger": completion_trigger' in source


def test_oof_completion_trigger_is_bounded_and_authenticated():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")
    start = source.index("def _trigger_worker_admin_task")
    end = source.index("def _write_finlab_macro_context_to_d1", start)
    helper = source[start:end]
    assert '/api/admin/trigger/{task}' in helper
    assert '"sync": "1"' in helper
    assert '"force": "1"' in helper
    assert '"Authorization": f"Bearer {token}"' in helper
    assert "for attempt in range(1, 4)" in helper
