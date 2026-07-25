from __future__ import annotations

import json

import pytest

from app.gcs_preflight import verify_gcs_object_lifecycle
from app.runtime_env import setup_modal_container_env


class _Blob:
    def __init__(self, *, corrupt_read: bool = False, deny_delete: bool = False):
        self.data = b""
        self.generation = 7
        self.corrupt_read = corrupt_read
        self.deny_delete = deny_delete
        self.deleted = False

    def upload_from_string(self, data, **kwargs):
        assert kwargs["if_generation_match"] == 0
        self.data = bytes(data)

    def download_as_bytes(self):
        return b"corrupt" if self.corrupt_read else self.data

    def delete(self, **kwargs):
        if self.deny_delete:
            raise PermissionError("storage.objects.delete denied")
        if kwargs:
            assert kwargs["if_generation_match"] == self.generation
        self.deleted = True

    def exists(self):
        return not self.deleted


class _Bucket:
    name = "stockvision-models-test"

    def __init__(self, blob):
        self._blob = blob
        self.object_name = None

    def blob(self, object_name):
        self.object_name = object_name
        return self._blob


def test_gcs_preflight_verifies_create_read_delete():
    blob = _Blob()
    bucket = _Bucket(blob)
    result = verify_gcs_object_lifecycle(
        bucket,
        workload="finlab-v4-backfill",
        run_id="run-1",
    )
    assert result["status"] == "pass"
    assert result["operations"] == ["create", "read", "delete"]
    assert blob.deleted is True
    assert bucket.object_name.startswith("health/preflight/finlab-v4-backfill/run-1/")


def test_gcs_preflight_fails_on_read_checksum_mismatch_and_cleans_up():
    blob = _Blob(corrupt_read=True)
    with pytest.raises(RuntimeError, match="gcs_preflight_read_checksum_mismatch"):
        verify_gcs_object_lifecycle(_Bucket(blob), workload="finlab", run_id="run-2")
    assert blob.deleted is True


def test_gcs_preflight_surfaces_delete_permission_failure():
    with pytest.raises(PermissionError, match="storage.objects.delete denied"):
        verify_gcs_object_lifecycle(
            _Bucket(_Blob(deny_delete=True)),
            workload="finlab",
            run_id="run-3",
        )


def test_runtime_env_builds_modal_oidc_wif_adc_config(monkeypatch, tmp_path):
    credentials_path = tmp_path / "gcp-wif.json"
    token_path = tmp_path / "modal-token.jwt"
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS_JSON", raising=False)
    monkeypatch.setenv("MODAL_IDENTITY_TOKEN", "signed-modal-token")
    monkeypatch.setenv("GCP_WIF_PROJECT_NUMBER", "123456789")
    monkeypatch.setenv("GCP_WIF_POOL_ID", "modal-prod")
    monkeypatch.setenv("GCP_WIF_PROVIDER_ID", "modal-oidc")
    monkeypatch.setenv("GCP_WIF_SERVICE_ACCOUNT", "writer@example.iam.gserviceaccount.com")
    monkeypatch.setenv("GCP_WIF_TOKEN_PATH", str(token_path))
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS_PATH", str(credentials_path))

    result = setup_modal_container_env()

    assert result["credentials_mode"] == "modal_oidc_wif"
    assert token_path.read_text(encoding="utf-8") == "signed-modal-token"
    config = json.loads(credentials_path.read_text(encoding="utf-8"))
    assert config["type"] == "external_account"
    assert config["credential_source"] == {"file": str(token_path)}
    assert config["audience"].endswith("/workloadIdentityPools/modal-prod/providers/modal-oidc")
    assert "writer@example.iam.gserviceaccount.com:generateAccessToken" in config["service_account_impersonation_url"]
