import os
import sys
from pathlib import Path

from app.runtime_env import get_gcs_bucket_name, setup_modal_container_env


def test_get_gcs_bucket_name_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv("GCS_BUCKET_NAME", raising=False)

    assert get_gcs_bucket_name() is None


def test_setup_modal_container_env_writes_credentials_and_inserts_root(monkeypatch):
    tmp_dir = Path(__file__).parents[1] / ".test_tmp"
    tmp_dir.mkdir(exist_ok=True)
    creds_path = tmp_dir / "runtime_env_gcs.json"
    if creds_path.exists():
        creds_path.unlink()
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", '{"type":"service_account"}')
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS_PATH", str(creds_path))
    monkeypatch.setattr(sys, "path", [p for p in sys.path if p != "/root"])

    result = setup_modal_container_env()

    assert os.environ["GOOGLE_APPLICATION_CREDENTIALS"] == str(creds_path)
    assert creds_path.read_text(encoding="utf-8") == '{"type":"service_account"}'
    assert result["credentials_written"] is True
    assert result["root_path_ready"] is True
    assert sys.path[0] == "/root"
    creds_path.unlink(missing_ok=True)
