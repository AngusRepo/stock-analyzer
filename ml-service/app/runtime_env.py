"""Runtime environment helpers shared by Modal entrypoints."""

from __future__ import annotations

import json
import os
import sys


def _write_private_text(path: str, value: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(value)
    os.chmod(path, 0o600)


def _setup_modal_oidc_wif() -> tuple[bool, str | None]:
    token = os.environ.get("MODAL_IDENTITY_TOKEN", "").strip()
    project_number = os.environ.get("GCP_WIF_PROJECT_NUMBER", "").strip()
    project_id = os.environ.get("GCP_WIF_PROJECT_ID", "").strip()
    pool_id = os.environ.get("GCP_WIF_POOL_ID", "").strip()
    provider_id = os.environ.get("GCP_WIF_PROVIDER_ID", "").strip()
    service_account = os.environ.get("GCP_WIF_SERVICE_ACCOUNT", "").strip()
    configured = any((project_number, project_id, pool_id, provider_id, service_account))
    if not configured:
        return False, None
    if not all((token, project_number, project_id, pool_id, provider_id, service_account)):
        raise RuntimeError("modal_oidc_wif_configuration_incomplete")

    token_path = os.environ.get("GCP_WIF_TOKEN_PATH", "/tmp/modal-identity-token.jwt")
    credentials_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_PATH", "/tmp/gcp-wif.json")
    audience = (
        f"//iam.googleapis.com/projects/{project_number}/locations/global/"
        f"workloadIdentityPools/{pool_id}/providers/{provider_id}"
    )
    config = {
        "type": "external_account",
        "audience": audience,
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "token_url": "https://sts.googleapis.com/v1/token",
        "service_account_impersonation_url": (
            "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"
            f"{service_account}:generateAccessToken"
        ),
        "credential_source": {"file": token_path},
    }
    _write_private_text(token_path, token)
    _write_private_text(credentials_path, json.dumps(config, separators=(",", ":")))
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
    os.environ["GOOGLE_CLOUD_PROJECT"] = project_id
    os.environ["GCLOUD_PROJECT"] = project_id
    return True, credentials_path


def setup_modal_container_env() -> dict[str, bool | str | None]:
    """Prepare GCS credentials and import path inside a Modal container."""

    creds_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "")
    creds_written = False
    creds_path: str | None = None
    credentials_mode = "ambient"
    if creds_json:
        creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_PATH", "/tmp/gcs-credentials.json")
        _write_private_text(creds_path, creds_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path
        creds_written = True
        credentials_mode = "service_account_json"
    else:
        creds_written, creds_path = _setup_modal_oidc_wif()
        if creds_written:
            credentials_mode = "modal_oidc_wif"

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    return {
        "credentials_written": creds_written,
        "credentials_path": creds_path,
        "credentials_mode": credentials_mode,
        "root_path_ready": "/root" in sys.path,
    }


def get_gcs_bucket_name() -> str | None:
    bucket = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket:
        print("[runtime_env] GCS_BUCKET_NAME not set; GCS-dependent persistence/checks will be skipped")
        return None
    return bucket
