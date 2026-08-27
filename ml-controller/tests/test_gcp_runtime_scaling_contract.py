import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_runtime_scaling_manifest_matches_scheduler_and_warm_ownership() -> None:
    scaling = json.loads((ROOT / "infra" / "gcp-runtime-scaling.json").read_text(encoding="utf-8"))
    identities = json.loads((ROOT / "infra" / "gcp-runtime-identities.json").read_text(encoding="utf-8"))

    schedules = {row["name"]: row["job"] for row in scaling["schedules"]}
    assert schedules == identities["scheduler_oauth_callers"]
    assert scaling["scaler_jobs"]["realtime-runtime-min-1"]["services"] == ["shioaji-proxy"]
    assert "stockvision-execution-gateway" not in {
        service
        for job in scaling["scaler_jobs"].values()
        if job["desired_min"] > 0
        for service in job["services"]
    }
    assert scaling["service_policies"]["shioaji-proxy"]["cpu_allocation"] == "continuous"
    assert scaling["service_policies"]["shioaji-proxy"]["warm_enabled"] is True
    assert scaling["service_policies"]["stockvision-execution-gateway"]["cpu_allocation"] == "continuous"
    assert scaling["service_policies"]["stockvision-execution-gateway"]["warm_enabled"] is False
    assert scaling["scaler_jobs"]["realtime-runtime-min-1"]["calendar_gate"] == "twse_fail_open_min_1"

    monthly_up = scaling["scaler_jobs"]["ml-controller-monthly-min-1"]
    monthly_down = scaling["scaler_jobs"]["ml-controller-monthly-min-0"]
    assert monthly_up["calendar_gate"] == "first_saturday_only"
    assert monthly_down["calendar_gate"] == "first_saturday_only"
    schedule_by_name = {row["name"]: row["cron"] for row in scaling["schedules"]}
    assert schedule_by_name["ml-controller-min-1-monthly-sat"] == "first saturday of month 09:50"
    assert schedule_by_name["ml-controller-min-0-monthly-sat"] == "first saturday of month 16:30"
    assert schedule_by_name["ml-controller-min-1-trading-open"] == "40 8 * * 1-5"
    assert schedule_by_name["ml-controller-min-0-trading-midday"] == "40 13 * * 1-5"
    warm_policy = scaling["trading_warm_window_policy"]
    assert warm_policy["source"] == "cloud_run_request_logs"
    assert warm_policy["correctness_owner"] == "durable_queue_and_terminal_receipt"
    assert warm_policy["rollback"]["restore_cron"] == "0 14 * * 1-5"
    assert warm_policy["late_window_request_classification"] == "manual_or_research_non_correctness_path"


def test_scaler_has_repository_scoped_pull_permission_and_fail_open_calendar() -> None:
    identities = json.loads((ROOT / "infra" / "gcp-runtime-identities.json").read_text(encoding="utf-8"))
    cutover = (ROOT / "scripts" / "cutover_gcp_runtime_identities.ps1").read_text(encoding="utf-8")
    sync = (ROOT / "scripts" / "sync_gcp_runtime_scalers.ps1").read_text(encoding="utf-8")

    assert identities["artifact_registry_readers"]["scaler"] == ["cloud-run-source-deploy"]
    assert '"artifacts", "repositories", "add-iam-policy-binding"' in cutover
    assert "--role=roles/artifactregistry.reader" in cutover
    assert '*) desired=1; echo "TWSE calendar unavailable; fail-open min=1"' in sync
    assert '"artifacts", "repositories", "add-iam-policy-binding"' in sync
    assert '"--role=roles/artifactregistry.reader"' in sync
    assert "scaler Artifact Registry reader binding missing after apply" in sync
    assert "& gcloud run jobs list" in sync
    assert "& gcloud scheduler jobs list" in sync
    assert '"scheduler", "jobs", $verb, "http"' in sync
    assert "gcloud run jobs describe $jobName" not in sync
    assert '.Replace("`r`n", "`n").Replace("`r", "`n")' in sync
    assert "warm-disabled service cannot be in min-1 job" in sync
    assert 'first_saturday_only' in sync
    assert 'TZ=Asia/Taipei date +%d' in sync
    assert '[switch]$DryRun' in sync
    assert 'Specify exactly one of -DryRun or -Apply' in sync
    assert 'if ($Apply -eq $DryRun)' in sync


def test_controller_deploy_reads_service_level_scaling_without_owning_dynamic_min() -> None:
    deploy = (ROOT / "deploy_ml_controller.sh").read_text(encoding="utf-8")

    assert 'service_annotations.get("run.googleapis.com/minScale"' in deploy
    assert 'service_annotations.get("run.googleapis.com/maxScale"' in deploy
    service_deploy = deploy.split('gcloud run deploy "$SERVICE"', 1)[1].split("Step 2/4", 1)[0]
    assert "--min" not in service_deploy
    assert "--max" not in service_deploy
