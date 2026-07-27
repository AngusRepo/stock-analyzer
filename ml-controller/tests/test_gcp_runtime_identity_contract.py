import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_no_runtime_workload_uses_default_compute_identity() -> None:
    contract = json.loads((ROOT / "infra" / "gcp-runtime-identities.json").read_text(encoding="utf-8"))
    default_email = contract["default_compute_identity"]["email"]
    accounts = contract["service_accounts"]

    for alias in contract["services"].values():
        assert accounts[alias] != default_email
    for alias in contract["jobs"].values():
        assert accounts[alias] != default_email
    assert len(contract["scheduler_oauth_callers"]) == 10
    assert set(contract["scheduler_oauth_callers"].values()) == {
        "ml-controller-min-0",
        "ml-controller-min-1",
        "ml-controller-monthly-min-0",
        "ml-controller-monthly-min-1",
        "realtime-runtime-min-0",
        "realtime-runtime-min-1",
    }
    assert "roles/editor" in contract["default_compute_identity"]["forbidden_project_roles"]
    assert contract["project_roles"]["builder"] == ["roles/run.builder"]

    pipeline_secrets = set(contract["secret_access"]["pipeline"])
    assert {
        "stockvision-anthropic-api-key",
        "stockvision-gemini-api-key",
        "stockvision-github-token",
        "stockvision-ml-service-secret",
    } <= pipeline_secrets


def test_controller_override_role_covers_every_invoked_job() -> None:
    contract = json.loads((ROOT / "infra" / "gcp-runtime-identities.json").read_text(encoding="utf-8"))
    role_id = "stockvisionJobOverrideRunner"

    assert set(contract["job_override_invokers"]["controller"]) == set(contract["job_invokers"]["controller"])
    assert set(contract["job_override_invokers"]["controller"].values()) == {role_id}
    assert set(contract["custom_roles"][role_id]["permissions"]) == {
        "run.jobs.run",
        "run.jobs.runWithOverrides",
    }


def test_controller_deploy_is_fail_closed_on_identity_and_provenance() -> None:
    script = (ROOT / "deploy_ml_controller.sh").read_text(encoding="utf-8")

    assert '--service-account="$SERVICE_RUNTIME_SERVICE_ACCOUNT"' in script
    assert '--service-account="$JOB_RUNTIME_SERVICE_ACCOUNT"' in script
    assert '--build-service-account="projects/${GCP_PROJECT_ID}/serviceAccounts/${BUILD_SERVICE_ACCOUNT}"' in script
    assert "*-compute@developer.gserviceaccount.com*" in script
    assert "PRODUCTION_BRANCH" in script
    assert "STOCKVISION_SOURCE_SHA" in script
    assert "STOCKVISION_SCHEDULER_MANIFEST_SHA256" in script
    assert 'PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"' in script
    assert script.count('--update-labels="$PROVENANCE_LABELS"') == 8
    assert script.count('--labels="$PROVENANCE_LABELS"') == 6


def test_cutover_requires_explicit_apply_and_separate_role_removal() -> None:
    script = (ROOT / "scripts" / "cutover_gcp_runtime_identities.ps1").read_text(encoding="utf-8")

    assert "[switch]$Apply" in script
    assert "[switch]$RemoveDefaultComputeRoles" in script
    assert "if (-not $Apply)" in script
    assert "still uses $defaultEmail" in script
    assert "--oauth-service-account-email=$scalerEmail" in script
    assert '@("roles/run.invoker", "roles/run.viewer")' in script
    assert "function Assert-LiveSecretCoverage" in script
    assert script.index("Assert-LiveSecretCoverage") < script.index("Ensure-ServiceAccount $property.Name")
    assert '$ready -eq "True"' in script
    assert "function Invoke-GcloudWithRetry" in script
    assert script.count("Invoke-GcloudWithRetry @(") == 2
