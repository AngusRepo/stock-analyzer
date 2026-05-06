"""Runtime environment helpers shared by Modal entrypoints."""

from __future__ import annotations

import os
import sys


def setup_modal_container_env() -> dict[str, bool | str | None]:
    """Prepare GCS credentials and import path inside a Modal container."""

    creds_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "")
    creds_written = False
    creds_path: str | None = None
    if creds_json:
        creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_PATH", "/tmp/gcs-credentials.json")
        with open(creds_path, "w", encoding="utf-8") as fh:
            fh.write(creds_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path
        creds_written = True

    if "/root" not in sys.path:
        sys.path.insert(0, "/root")

    return {
        "credentials_written": creds_written,
        "credentials_path": creds_path,
        "root_path_ready": "/root" in sys.path,
    }


def get_gcs_bucket_name() -> str | None:
    bucket = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket:
        print("[runtime_env] GCS_BUCKET_NAME not set; GCS-dependent persistence/checks will be skipped")
        return None
    return bucket
