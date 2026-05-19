from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.cloud_run_cost_hotspot_report import (  # noqa: E402
    build_report,
    main,
    normalize_job_configs,
    normalize_scheduler_jobs,
)


def _execution(name: str, ts: str, message: str, *, failed: bool = False) -> dict:
    return {
        "metadata": {"name": name, "creationTimestamp": ts},
        "status": {
            "succeededCount": 0 if failed else 1,
            "failedCount": 1 if failed else 0,
            "conditions": [{
                "type": "Completed",
                "status": "False" if failed else "True",
                "message": message,
            }],
        },
    }


def _request(path: str, ts: str, latency: str = "1.0s") -> dict:
    return {
        "timestamp": ts,
        "httpRequest": {
            "requestUrl": f"https://ml-controller.example{path}",
            "latency": latency,
            "status": 200,
        },
    }


def _case_dir(name: str) -> Path:
    path = Path(__file__).resolve().parent.parent / ".tmp" / "cloud_run_cost_hotspot_report" / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_daily_high_spec_job_is_flagged_for_review():
    scheduler = normalize_scheduler_jobs([
        {
            "name": "projects/p/locations/r/jobs/finlab-v4-backfill",
            "schedule": "30 18 * * 1-5",
            "timeZone": "Asia/Taipei",
        }
    ])
    job_configs = normalize_job_configs([
        {
            "metadata": {"name": "finlab-v4-backfill"},
            "spec": {
                "template": {
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [{
                                    "resources": {"limits": {"cpu": "4", "memory": "16Gi"}},
                                }],
                            },
                        },
                    },
                },
            },
        }
    ])
    report = build_report(
        scheduler_jobs=scheduler,
        job_configs=job_configs,
        executions_by_job={
            "finlab-v4-backfill": [
                _execution("finlab-v4-backfill-a", "2026-05-18T10:30:00Z", "Execution completed successfully in 1m37.8s."),
            ],
        },
    )

    job = report["jobs"][0]
    assert job["schedule_frequency"] == "weekday"
    assert job["resource"]["memory_gib"] == 16
    assert job["cost_proxy"]["total_vcpu_sec"] == 391.2
    assert job["cost_proxy"]["total_gib_sec"] == 1564.8
    assert job["decision"] == "review_daily_high_spec"


def test_low_frequency_high_spec_job_can_be_kept_when_actual_frequency_is_low():
    scheduler = normalize_scheduler_jobs([
        {
            "name": "projects/p/locations/r/jobs/monthly-optuna",
            "schedule": "first saturday of month 16:00",
            "timeZone": "UTC",
        }
    ])
    job_configs = normalize_job_configs([
        {"metadata": {"name": "monthly-optuna"}, "resources": {"limits": {"cpu": "4", "memory": "8Gi"}}}
    ])
    report = build_report(
        scheduler_jobs=scheduler,
        job_configs=job_configs,
        executions_by_job={
            "monthly-optuna": [
                _execution("monthly-optuna-a", "2026-05-02T16:00:00Z", "Execution completed successfully in 1h2m3s."),
            ],
        },
    )

    job = report["jobs"][0]
    assert job["schedule_frequency"] == "monthly"
    assert job["decision"] == "keep_high_spec_allowed"


def test_weekly_job_with_repeated_actual_runs_is_flagged():
    scheduler = normalize_scheduler_jobs([
        {
            "name": "projects/p/locations/r/jobs/weekly-optuna",
            "schedule": "30 22 * * 6",
            "timeZone": "UTC",
        }
    ])
    report = build_report(
        scheduler_jobs=scheduler,
        executions_by_job={
            "weekly-optuna": [
                _execution("weekly-optuna-a", "2026-05-17T18:37:00Z", "Execution completed successfully in 12m25s."),
                _execution("weekly-optuna-b", "2026-05-17T19:12:00Z", "Execution completed successfully in 12m23s."),
                _execution("weekly-optuna-c", "2026-05-18T03:04:00Z", "Execution completed successfully in 12m25s."),
            ],
        },
    )

    job = report["jobs"][0]
    assert job["schedule_frequency"] == "weekly"
    assert job["decision"] == "review_duplicate_or_queue_triggers"
    assert job["max_daily_execution_count"] == 2


def test_optuna_research_sweep_uses_scheduler_alias_sources():
    scheduler = normalize_scheduler_jobs([
        {"name": "projects/p/locations/r/jobs/weekly-optuna", "schedule": "30 22 * * 6", "timeZone": "UTC"},
        {"name": "projects/p/locations/r/jobs/monthly-optuna", "schedule": "first saturday of month 16:00", "timeZone": "UTC"},
        {"name": "projects/p/locations/r/jobs/optuna-queue", "schedule": "0 */6 * * *", "timeZone": "UTC"},
    ])
    job_configs = normalize_job_configs([
        {"metadata": {"name": "optuna-research-sweep"}, "resources": {"limits": {"cpu": "4", "memory": "4Gi"}}}
    ])

    report = build_report(
        scheduler_jobs=scheduler,
        job_configs=job_configs,
        executions_by_job={
            "optuna-research-sweep": [
                _execution("optuna-a", "2026-05-17T18:37:00Z", "Execution completed successfully in 12m25s."),
            ],
        },
    )

    job = report["jobs"][0]
    assert job["schedule_frequency"] == "mixed_subdaily"
    assert {source["id"] for source in job["schedule_sources"]} == {
        "weekly-optuna",
        "monthly-optuna",
        "optuna-queue",
    }
    assert job["decision"] == "review_daily_high_spec"


def test_service_sizing_strategy_blocks_global_downsize_for_long_and_high_read_paths():
    service_requests = [
        _request("/optuna/per_regime", "2026-05-18T01:00:00Z", "784.1s"),
        *[
            _request("/model_pool/lineage", f"2026-05-18T02:{idx % 60:02d}:00Z", "1.0s")
            for idx in range(101)
        ],
    ]
    service_config = {
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "run.googleapis.com/cpu-throttling": "false",
                        "autoscaling.knative.dev/maxScale": "5",
                    },
                },
                "spec": {
                    "containers": [{
                        "resources": {"limits": {"cpu": "4", "memory": "4Gi"}},
                    }],
                },
            },
        },
    }

    report = build_report(
        scheduler_jobs={},
        executions_by_job={},
        request_entries=service_requests,
        service_config=service_config,
    )

    strategy = report["service_sizing_strategy"]
    assert strategy["decision"] == "do_not_downsize_globally_yet"
    assert "long_request_paths_present" in strategy["blockers"]
    assert "high_frequency_read_paths_present" in strategy["blockers"]
    assert "/optuna/per_regime" in strategy["long_request_paths"]
    assert "/model_pool/lineage" in strategy["high_frequency_read_paths"]
    lineage = next(item for item in report["service_requests"] if item["path"] == "/model_pool/lineage")
    assert lineage["cost_proxy"]["service_vcpu_sec"] == 404.0


def test_cli_builds_report_from_exported_json_files(capsys):
    case_dir = _case_dir("cli")
    scheduler_path = case_dir / "scheduler.json"
    job_configs_path = case_dir / "jobs.json"
    executions_path = case_dir / "pipeline.json"
    requests_path = case_dir / "requests.json"
    service_path = case_dir / "service.json"
    scheduler_path.write_text(json.dumps({
        "jobs": [{"id": "pipeline-v2", "schedule": "0 14 * * 1-5", "timeZone": "UTC"}],
    }), encoding="utf-8")
    job_configs_path.write_text(json.dumps([
        {"metadata": {"name": "pipeline-v2"}, "resources": {"limits": {"cpu": "4", "memory": "4Gi"}}},
    ]), encoding="utf-8")
    executions_path.write_text(json.dumps([
        _execution("pipeline-v2-a", "2026-05-18T14:00:00Z", "Execution completed successfully in 8m13.97s."),
    ]), encoding="utf-8")
    requests_path.write_text(json.dumps([
        _request("/health", "2026-05-18T14:00:00Z", "0.1s"),
    ]), encoding="utf-8")
    service_path.write_text(json.dumps({
        "spec": {"template": {"spec": {"containers": [{"resources": {"limits": {"cpu": "4", "memory": "4Gi"}}}]}}},
    }), encoding="utf-8")

    exit_code = main([
        "--scheduler",
        str(scheduler_path),
        "--job-configs",
        str(job_configs_path),
        "--executions",
        f"pipeline-v2={executions_path}",
        "--service-requests",
        str(requests_path),
        "--service-config",
        str(service_path),
        "--generated-at",
        "2026-05-19T00:00:00+00:00",
    ])

    out = json.loads(capsys.readouterr().out)
    assert exit_code == 0
    assert out["schema_version"] == "cloud-run-cost-hotspot-report-v1"
    assert out["jobs"][0]["job_name"] == "pipeline-v2"
