from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_oof_orchestrator_publishes_manifest_without_worker_secret_callback():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")
    publish = source.index("publication = publish_oof_manifest(bucket, manifest)")
    result = source.index('"manifest_checksum": manifest["manifest_checksum"]', publish)
    lifecycle = source[publish:result]
    assert "_trigger_worker_admin_task" not in lifecycle
    assert "completion_task" not in lifecycle
    assert "completion_trigger" not in lifecycle


def test_modal_app_does_not_mount_a_duplicate_worker_callback_secret():
    source = (ROOT / "modal_app.py").read_text(encoding="utf-8")
    assert "stockvision-oof-worker-callback" not in source
    assert "OOF_WORKER_AUTH_TOKEN" not in source
