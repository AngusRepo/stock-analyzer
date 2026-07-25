from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_modal_uses_dedicated_bucket_scoped_writer_secret():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    contract = json.loads(
        (ROOT / "infra" / "modal-gcs-writer-contract.json").read_text(encoding="utf-8")
    )
    assert contract["modal_secret"] == "stockvision-modal-gcs-writer"
    assert contract["credential_mode"] == "modal_oidc_workload_identity_federation"
    assert contract["oidc_issuer"] == "https://oidc.modal.com"
    assert contract["google_subject_mapping"] == (
        "assertion.workspace_id + ':' + assertion.app_id + ':' + assertion.function_id"
    )
    assert contract["allowed_app_name"] == "stockvision-ml"
    assert contract["bucket_roles"] == ["roles/storage.objectAdmin"]
    assert contract["project_roles"] == []
    assert "roles/editor" in contract["forbidden_roles"]
    assert contract["forbidden_credentials"] == ["service_account_private_key"]
    assert '"stockvision-modal-gcs-writer"' in source
    assert 'modal.Secret.from_name("gcs-credentials")' not in source


def test_finlab_modal_workload_runs_object_lifecycle_preflight_first():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    function = source.split("def finlab_v4_backfill(payload: dict) -> dict:", 1)[1]
    function = function.split("\n@app.", 1)[0]
    assert function.index("verify_gcs_object_lifecycle(") < function.index(
        "finlab_v4_remote_backfill.main()"
    )
