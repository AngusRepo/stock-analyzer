import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_rotation_helper_keeps_tokens_out_of_native_argv_and_disk() -> None:
    source = (ROOT / "scripts" / "rotate_stockvision_auth_token.ps1").read_text(
        encoding="utf-8"
    )
    scheduler_source = (
        ROOT / "scripts" / "auth_rotation_scheduler_rest.ps1"
    ).read_text(encoding="utf-8")
    combined_source = source + "\n" + scheduler_source

    assert "[ValidateSet('Preflight', 'Sync', 'Rotate', 'Finalize')]" in source
    assert "scheduler-only sync complete; service token unchanged" in source
    assert "[switch]$Apply" in source
    assert "[switch]$DryRun" in source
    assert "[switch]$DrainVerified" in source
    assert "[int]$ExpectedSchedulerCount = 58" in source
    assert "'retention-archive-only'" in source
    assert "'learning-retention-readiness'" in source
    assert "'legacy-learning-deletion-readiness'" in source
    assert "versions', 'secret', 'bulk'" in source
    assert "-StandardInput $stdin" in source
    assert ". $schedulerRestHelper" in source
    assert "Set-SchedulerToken" not in source
    assert "cloudscheduler.googleapis.com" in scheduler_source
    assert "Invoke-SchedulerCreateBody" in scheduler_source
    assert "Invoke-SchedulerPatchBody" in scheduler_source
    assert "Invoke-SchedulerDeleteJob" in scheduler_source
    assert "updateMask=$mask" in scheduler_source
    assert "Invoke-GoogleJson -Method PATCH" in scheduler_source
    assert "secretmanager.googleapis.com" in source
    assert "Invoke-GoogleJson -Method GET -Uri $uri -AccessToken $AccessToken -Operation \"secret_access:$SecretId\"" in source
    assert (
        "Invoke-GoogleJson -Method POST -Uri $uri -AccessToken $AccessToken -Operation \"secret_access:$SecretId\"" not in source
    )
    assert "`:addVersion" in source
    assert "`:disable" in source
    assert "`:enable" in source
    wrangler_json = source[
        source.index("function Get-WranglerJson") : source.index(
            "function Assert-WorkerVersionBaseline"
        )
    ]
    assert "Invoke-SafeNative" not in wrangler_json
    assert "2>&1" not in wrangler_json
    assert "2>$null" in wrangler_json
    assert "$exitCode = $LASTEXITCODE" in wrangler_json
    assert 'throw "rotation_native_failed:$Operation`:exit=$exitCode"' in wrangler_json
    assert '[string]::Join("`n", @($output | ForEach-Object { [string]$_ })).Trim()' in wrangler_json
    assert "ConvertFrom-Json -InputObject $payload -ErrorAction Stop" in wrangler_json
    assert "rotation_wrangler_json_empty:$Operation" in wrangler_json
    assert "function Assert-WorkerTokenEventually" in source
    assert "$delaysMs = @(0, 1000, 2000, 4000, 8000, 12000, 15000)" in source
    assert "Assert-WorkerTokenEventually -Token $newToken -Label 'current_overlap'" in source
    assert "Assert-WorkerTokenEventually -Token $newToken -Label 'current_complete'" in source
    for permissive_parser in ("Substring", "IndexOf", "[regex]", "-match"):
        assert permissive_parser not in wrangler_json
    assert "from modal.secret import _Secret" in source
    assert "_Secret._create_deployed(" in source
    assert "environment_name=" in source
    assert "overwrite=True" in source

    for required_modal_key in (
        "CF_API_TOKEN",
        "CF_ACCOUNT_ID",
        "CF_D1_DB_ID",
        "CF_KV_NAMESPACE_ID",
        "STOCKVISION_AUTH_TOKEN",
        "STOCKVISION_WORKER_URL",
    ):
        assert f'"{required_modal_key}"' in source

    for forbidden_disk_or_argv_path in (
        "Set-Content",
        "Out-File",
        "WriteAllBytes",
        "--from-json",
        "--data-file",
        "--update-headers",
        "--headers",
    ):
        assert forbidden_disk_or_argv_path not in combined_source


def test_rotation_helper_is_fail_closed_and_transactional() -> None:
    source = (ROOT / "scripts" / "rotate_stockvision_auth_token.ps1").read_text(
        encoding="utf-8"
    )

    assert "rotation_worker_traffic_not_single_100_percent" in source
    assert "rotation_worker_deployed_tag_mismatch" in source
    assert "rotation_worker_latest_uploaded_not_deployed" in source
    assert "[string]$traffic[0].version_id" in source
    assert "Enable-SecretVersion -VersionName $PreviousSecretVersion" in source
    finalize = source[source.index("if ($Mode -eq 'Finalize')") :]
    assert finalize.index("Disable-SecretVersion -VersionName $PreviousSecretVersion") < finalize.index(
        "Remove-WorkerPreviousSecret"
    )
    assert "rotation_finalize_failed_and_rollback_attempted" in source
    assert "if ($schedulerAttempted)" in source
    assert "if ($modalAttempted)" in source
    assert "if ($gcpAttempted)" in source
    assert "if ($workerAttempted)" in source
    for stale_flag in (
        "$schedulerChanged",
        "$modalChanged",
        "$gcpChanged",
        "$workerChanged",
    ):
        assert stale_flag not in source


def test_legacy_scheduler_mutation_fails_before_gcloud_auth_argv_path() -> None:
    source = (ROOT / "scripts" / "sync_gcp_scheduler.ps1").read_text(
        encoding="utf-8"
    )

    guard = "if (-not $DryRun)"
    first_mutating_gcloud = "'scheduler', 'jobs', 'update', 'http'"
    parameter_block = source[: source.index("$ErrorActionPreference")]
    assert "[string]$AuthToken" not in parameter_block
    assert "$AuthToken = $env:SCHEDULER_AUTH_TOKEN" in source
    assert "service bearer token in gcloud child-process argv" in source
    assert source.index(guard) < source.index(first_mutating_gcloud)


def test_modal_deploy_receives_release_provenance_for_both_apps() -> None:
    source = (ROOT / "deploy_ml_controller.sh").read_text(encoding="utf-8")

    for variable in (
        "STOCKVISION_SOURCE_SHA",
        "STOCKVISION_SOURCE_TREE_SHA",
        "STOCKVISION_SOURCE_BRANCH",
        "STOCKVISION_SCHEDULER_MANIFEST_SHA256",
    ):
        assert source.count(f'{variable}="') == 2
    assert source.count('-m modal deploy --tag "$SOURCE_SHA"') == 2


def test_scheduler_inventory_create_patch_parity_and_rollback_contract() -> None:
    source = (ROOT / "scripts" / "rotate_stockvision_auth_token.ps1").read_text(
        encoding="utf-8"
    )
    scheduler_source = (
        ROOT / "scripts" / "auth_rotation_scheduler_rest.ps1"
    ).read_text(encoding="utf-8")

    assert "[string[]]$AllowedSchedulerCreateIds" in source
    assert "'screener-v2-watchdog'" in source
    assert "'data-domain-shadow-backfill-ops'" in source
    assert "New-SchedulerInventoryPlan" in source
    assert "Assert-SchedulerCreatePlanAllowed" in source
    assert "Sync-SchedulerInventory" in source
    assert "Restore-SchedulerInventory" in source
    assert "Set-SchedulerToken" not in source

    for required_contract in (
        "Assert-SchedulerPlanBaseline",
        "scheduler_planned_patch_drift ids=$driftText",
        "rotation_scheduler_create_not_allowed",
        "rotation_scheduler_inventory_drift:changed_existing",
        "rotation_scheduler_inventory_parity_drift",
        "rotation_scheduler_rollback_drift_mismatch",
        "Invoke-GoogleJson -Method POST",
        "Invoke-GoogleJson -Method PATCH",
        "Invoke-GoogleJson -Method DELETE",
        "rotation_scheduler_rollback_conflict:changed_patched",
        "rotation_scheduler_rollback_conflict:changed_created",
        "scheduler_sync parity=$ExpectedSchedulerCount/$ExpectedSchedulerCount",
    ):
        assert required_contract in scheduler_source

    for forbidden_native_or_disk_path in (
        "Invoke-SafeNative",
        "gcloud",
        "Set-Content",
        "Out-File",
        "WriteAllText",
        "WriteAllBytes",
        "Start-Process",
    ):
        assert forbidden_native_or_disk_path not in scheduler_source


def _powershell_executable() -> str:
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if executable is None:
        pytest.skip("PowerShell is required for rotation contract tests")
    return executable


def test_rotation_powershell_sources_have_zero_ast_errors() -> None:
    paths = [
        ROOT / "scripts" / "rotate_stockvision_auth_token.ps1",
        ROOT / "scripts" / "auth_rotation_scheduler_rest.ps1",
        ROOT / "scripts" / "sync_gcp_scheduler.ps1",
    ]
    env = os.environ.copy()
    env["ROTATION_AST_PATHS"] = os.pathsep.join(str(path) for path in paths)
    command = textwrap.dedent(
        r"""
        $errorsFound = 0
        foreach ($path in ($env:ROTATION_AST_PATHS -split [IO.Path]::PathSeparator)) {
          $tokens = $null
          $errors = $null
          [void][System.Management.Automation.Language.Parser]::ParseFile(
            $path, [ref]$tokens, [ref]$errors
          )
          $errorsFound += $errors.Count
        }
        if ($errorsFound -ne 0) { exit 9 }
        Write-Output 'ast_ok'
        """
    )
    result = subprocess.run(
        [_powershell_executable(), "-NoProfile", "-NonInteractive", "-Command", command],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "ast_ok" in result.stdout
