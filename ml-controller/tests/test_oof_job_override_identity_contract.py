import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_oof_materializer_override_role_is_minimal_and_reconciled():
    contract = json.loads(
        (ROOT / "infra" / "gcp-runtime-identities.json").read_text()
    )
    role = contract["custom_roles"]["stockvisionOofJobRunner"]

    assert role["permissions"] == [
        "run.jobs.run",
        "run.jobs.runWithOverrides",
    ]
    assert contract["job_override_invokers"] == {
        "controller": {"active8-oof-materialize": "stockvisionOofJobRunner"}
    }

    script = (
        ROOT / "scripts" / "cutover_gcp_runtime_identities.ps1"
    ).read_text()
    assert "function Ensure-CustomRole" in script
    assert '"iam", "roles", "update"' in script
    assert "job_override_invokers" in script
    assert '"projects/$project/roles/$([string]$jobEntry.Value)"' in script
