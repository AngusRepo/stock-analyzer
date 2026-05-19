"""Build a Cloud Run cost hotspot report from exported evidence.

This script is intentionally local/read-only. It does not call GCP, Cloudflare,
Modal, D1, or mutate production state. Export live evidence first, then pass the
JSON files here.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


HIGH_MEMORY_GIB = 8.0
HIGH_CPU = 4.0
LONG_REQUEST_SEC = 120.0
HIGH_READ_COUNT = 100

SCHEDULER_SOURCE_ALIASES = {
    "pipeline-v2": ["evening-chain"],
    "verify-v2": ["evening-chain"],
    "optuna-research-sweep": ["weekly-optuna", "monthly-optuna", "optuna-queue"],
}


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as fh:
        return json.load(fh)


def _iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc)
    except ValueError:
        return None


def _date_key(value: Any) -> str:
    dt = _iso_datetime(value)
    return dt.date().isoformat() if dt else "unknown"


def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(str(value).replace("Gi", "").replace("Mi", ""))
    except (TypeError, ValueError):
        return default


def _memory_gib(value: Any) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    if text.lower().endswith("gi"):
        return _num(text[:-2])
    if text.lower().endswith("mi"):
        return _num(text[:-2]) / 1024.0
    return _num(text)


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def _tail_name(value: Any) -> str:
    text = str(value or "").strip()
    return text.rsplit("/", 1)[-1] if text else ""


def _duration_from_message(message: Any) -> float | None:
    text = str(message or "")
    match = re.search(r"in\s+((?:(?P<hours>\d+)h)?(?:(?P<minutes>\d+)m)?(?P<seconds>\d+(?:\.\d+)?)s)", text)
    if not match:
        return None
    hours = float(match.group("hours") or 0)
    minutes = float(match.group("minutes") or 0)
    seconds = float(match.group("seconds") or 0)
    return hours * 3600 + minutes * 60 + seconds


def _completed_condition(execution: dict[str, Any]) -> dict[str, Any]:
    conditions = execution.get("status", {}).get("conditions") or []
    if isinstance(conditions, list):
        for condition in conditions:
            if isinstance(condition, dict) and condition.get("type") == "Completed":
                return condition
        for condition in conditions:
            if isinstance(condition, dict):
                return condition
    return {}


def _execution_duration_sec(execution: dict[str, Any]) -> float:
    condition = _completed_condition(execution)
    from_message = _duration_from_message(condition.get("message"))
    if from_message is not None:
        return from_message
    start = _iso_datetime(execution.get("status", {}).get("startTime") or execution.get("metadata", {}).get("creationTimestamp"))
    end = _iso_datetime(execution.get("status", {}).get("completionTime"))
    if start and end:
        return max((end - start).total_seconds(), 0.0)
    return 0.0


def _execution_status(execution: dict[str, Any]) -> str:
    status = execution.get("status", {})
    if _num(status.get("succeededCount")) > 0:
        return "success"
    if _num(status.get("failedCount")) > 0:
        return "failed"
    condition = _completed_condition(execution)
    if condition.get("status") == "False":
        return "failed"
    if condition.get("status") == "True":
        return "success"
    return "unknown"


def _extract_resource(raw: dict[str, Any]) -> dict[str, Any]:
    limits = (
        raw.get("resources", {}).get("limits")
        or raw.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [{}])[0]
        .get("resources", {})
        .get("limits")
        or raw.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [{}])[0]
        .get("resources", {})
        .get("limits")
        or {}
    )
    return {
        "cpu": _num(limits.get("cpu")),
        "memory_gib": _round(_memory_gib(limits.get("memory")), 3),
        "memory": limits.get("memory"),
    }


def normalize_scheduler_jobs(raw: Any) -> dict[str, dict[str, Any]]:
    """Normalize gcloud scheduler list JSON or infra/gcp-scheduler-jobs.json."""
    if isinstance(raw, dict) and isinstance(raw.get("jobs"), list):
        jobs = raw["jobs"]
    elif isinstance(raw, list):
        jobs = raw
    else:
        return {}

    normalized: dict[str, dict[str, Any]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = str(job.get("id") or _tail_name(job.get("name"))).strip()
        if not job_id:
            continue
        uri = (job.get("httpTarget") or {}).get("uri")
        normalized[job_id] = {
            "id": job_id,
            "schedule": job.get("schedule"),
            "time_zone": job.get("timeZone"),
            "state": job.get("state"),
            "task": job.get("task"),
            "uri": uri,
            "description": job.get("description"),
        }
    return normalized


def normalize_job_configs(raw: Any) -> dict[str, dict[str, Any]]:
    if isinstance(raw, dict) and isinstance(raw.get("jobs"), list):
        jobs = raw["jobs"]
    elif isinstance(raw, list):
        jobs = raw
    elif isinstance(raw, dict):
        jobs = [raw]
    else:
        return {}

    out: dict[str, dict[str, Any]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            continue
        name = str(job.get("name") or job.get("metadata", {}).get("name") or "").strip()
        if not name:
            continue
        out[name] = {
            "job_name": name,
            "resource": _extract_resource(job),
        }
    return out


def normalize_executions(raw: Any, *, job_name: str | None = None) -> dict[str, list[dict[str, Any]]]:
    if isinstance(raw, dict) and isinstance(raw.get("jobs"), dict):
        return {
            str(name): [item for item in value if isinstance(item, dict)]
            for name, value in raw["jobs"].items()
            if isinstance(value, list)
        }
    if isinstance(raw, dict) and all(isinstance(value, list) for value in raw.values()):
        return {
            str(name): [item for item in value if isinstance(item, dict)]
            for name, value in raw.items()
        }
    if isinstance(raw, list):
        if job_name:
            return {job_name: [item for item in raw if isinstance(item, dict)]}
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("job") or item.get("job_name") or item.get("metadata", {}).get("labels", {}).get("run.googleapis.com/job")
            if name:
                grouped[str(name)].append(item)
        return dict(grouped)
    return {}


def _schedule_frequency(schedule: Any) -> str:
    text = str(schedule or "").strip().lower()
    if not text:
        return "unknown"
    if text.startswith("first "):
        return "monthly"
    parts = text.split()
    if len(parts) != 5:
        return "custom"
    minute, hour, _dom, _month, dow = parts
    if minute.startswith("*") or hour.startswith("*") or "*/" in hour:
        return "subdaily"
    if dow in {"0-4", "1-5", "sun-thu", "mon-fri"}:
        return "weekday"
    if dow not in {"*", "?"}:
        return "weekly"
    return "daily"


def _is_low_frequency(freq: str) -> bool:
    return freq in {"weekly", "monthly", "mixed_low_frequency"}


def _scheduler_sources_for_job(job_name: str, scheduler_jobs: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    names = [job_name, *SCHEDULER_SOURCE_ALIASES.get(job_name, [])]
    out: list[dict[str, Any]] = []
    for name in names:
        source = scheduler_jobs.get(name)
        if source:
            out.append(source)
    return out


def _combined_frequency(sources: list[dict[str, Any]]) -> str:
    frequencies = sorted({_schedule_frequency(source.get("schedule")) for source in sources})
    if not frequencies:
        return "unknown"
    if len(frequencies) == 1:
        return frequencies[0]
    if "subdaily" in frequencies:
        return "mixed_subdaily"
    if "daily" in frequencies or "weekday" in frequencies:
        return "mixed_weekday"
    if all(freq in {"weekly", "monthly"} for freq in frequencies):
        return "mixed_low_frequency"
    return "mixed"


def _job_decision(
    *,
    schedule_frequency: str,
    actual_count: int,
    max_daily_count: int,
    failures: int,
    cpu: float,
    memory_gib: float,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    high_spec = cpu >= HIGH_CPU or memory_gib >= HIGH_MEMORY_GIB
    if failures:
        reasons.append(f"{failures} recent failed execution(s)")
    if max_daily_count > 1:
        reasons.append(f"max {max_daily_count} executions on one UTC date")
    if high_spec:
        reasons.append(f"high spec cpu={cpu:g} memory_gib={memory_gib:g}")

    if _is_low_frequency(schedule_frequency) and actual_count <= 2 and failures == 0:
        return "keep_high_spec_allowed", reasons or ["low-frequency scheduled job"]
    if schedule_frequency in {"weekday", "daily", "subdaily", "mixed_subdaily", "mixed_weekday"} and high_spec:
        return "review_daily_high_spec", reasons or ["high-spec daily/subdaily job"]
    if _is_low_frequency(schedule_frequency) and (actual_count > 2 or max_daily_count > 1):
        return "review_duplicate_or_queue_triggers", reasons or ["actual frequency exceeds low-frequency schedule"]
    if failures:
        return "review_failures_before_resize", reasons
    return "observe", reasons or ["no immediate sizing action"]


def summarize_job(
    *,
    job_name: str,
    executions: list[dict[str, Any]],
    scheduler_jobs: dict[str, dict[str, Any]],
    job_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    by_date: dict[str, int] = defaultdict(int)
    durations: list[float] = []
    failures = 0
    latest: list[dict[str, Any]] = []
    for execution in sorted(
        executions,
        key=lambda item: str(item.get("metadata", {}).get("creationTimestamp") or ""),
        reverse=True,
    ):
        timestamp = execution.get("metadata", {}).get("creationTimestamp")
        status = _execution_status(execution)
        duration = _execution_duration_sec(execution)
        by_date[_date_key(timestamp)] += 1
        durations.append(duration)
        if status == "failed":
            failures += 1
        if len(latest) < 5:
            latest.append({
                "created_at": timestamp,
                "name": execution.get("metadata", {}).get("name"),
                "status": status,
                "duration_sec": _round(duration, 2),
                "message": _completed_condition(execution).get("message"),
            })

    scheduler_sources = _scheduler_sources_for_job(job_name, scheduler_jobs)
    resource = (job_config or {}).get("resource") or {}
    schedule_frequency = _combined_frequency(scheduler_sources)
    max_daily_count = max(by_date.values()) if by_date else 0
    decision, reasons = _job_decision(
        schedule_frequency=schedule_frequency,
        actual_count=len(executions),
        max_daily_count=max_daily_count,
        failures=failures,
        cpu=_num(resource.get("cpu")),
        memory_gib=_num(resource.get("memory_gib")),
    )
    return {
        "job_name": job_name,
        "schedule_sources": [
            {
                "id": source.get("id"),
                "task": source.get("task"),
                "schedule": source.get("schedule"),
                "time_zone": source.get("time_zone"),
                "frequency": _schedule_frequency(source.get("schedule")),
            }
            for source in scheduler_sources
        ],
        "schedule_frequency": schedule_frequency,
        "execution_count": len(executions),
        "by_utc_date": dict(sorted(by_date.items())),
        "failure_count": failures,
        "max_daily_execution_count": max_daily_count,
        "total_duration_sec": _round(sum(durations), 2),
        "max_duration_sec": _round(max(durations) if durations else 0.0, 2),
        "resource": resource,
        "cost_proxy": {
            "total_vcpu_sec": _round(sum(durations) * _num(resource.get("cpu")), 2),
            "total_gib_sec": _round(sum(durations) * _num(resource.get("memory_gib")), 2),
        },
        "decision": decision,
        "reasons": reasons,
        "latest": latest,
    }


def _request_path(entry: dict[str, Any]) -> str | None:
    request = entry.get("httpRequest") or {}
    url = request.get("requestUrl")
    if not url:
        return None
    return urlparse(str(url)).path or None


def _request_latency(entry: dict[str, Any]) -> float:
    latency = (entry.get("httpRequest") or {}).get("latency")
    return _num(str(latency or "").removesuffix("s"))


def summarize_service_requests(raw: Any) -> list[dict[str, Any]]:
    entries = raw if isinstance(raw, list) else []
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        path = _request_path(entry)
        if path:
            grouped[path].append(entry)

    summaries: list[dict[str, Any]] = []
    for path, items in grouped.items():
        latencies = [_request_latency(item) for item in items]
        by_date: dict[str, int] = defaultdict(int)
        for item in items:
            by_date[_date_key(item.get("timestamp"))] += 1
        max_latency = max(latencies) if latencies else 0.0
        total_latency = sum(latencies)
        action = "observe"
        if path.startswith("/model_pool/") and len(items) >= HIGH_READ_COUNT:
            action = "cache_or_reduce_polling"
        elif max_latency >= LONG_REQUEST_SEC:
            action = "split_or_async_before_downsize"
        elif total_latency >= LONG_REQUEST_SEC and len(items) >= 5:
            action = "profile_before_downsize"
        summaries.append({
            "path": path,
            "count": len(items),
            "by_utc_date": dict(sorted(by_date.items())),
            "total_latency_sec": _round(total_latency, 2),
            "max_latency_sec": _round(max_latency, 2),
            "action": action,
        })
    return sorted(summaries, key=lambda item: item["total_latency_sec"], reverse=True)


def build_service_sizing_strategy(
    *,
    service_config: dict[str, Any] | None,
    request_summaries: list[dict[str, Any]],
) -> dict[str, Any]:
    service_config = service_config or {}
    template = service_config.get("spec", {}).get("template", {})
    annotations = template.get("metadata", {}).get("annotations", {})
    resource = _extract_resource(service_config)
    long_paths = [
        item for item in request_summaries
        if item.get("max_latency_sec", 0) >= LONG_REQUEST_SEC
    ]
    high_read_paths = [
        item for item in request_summaries
        if item.get("action") == "cache_or_reduce_polling"
    ]
    blockers: list[str] = []
    if long_paths:
        blockers.append("long_request_paths_present")
    if high_read_paths:
        blockers.append("high_frequency_read_paths_present")
    if str(annotations.get("run.googleapis.com/cpu-throttling", "")).lower() == "false":
        blockers.append("service_cpu_throttling_disabled")
    if resource["cpu"] >= HIGH_CPU or resource["memory_gib"] >= HIGH_MEMORY_GIB:
        blockers.append("service_high_spec")

    decision = "do_not_downsize_globally_yet" if long_paths or high_read_paths else "eligible_for_sizing_experiment"
    next_steps = [
        "cache_or_reduce_polling_for_high_frequency_read_paths",
        "move_or_async_split_long_request_paths_before_global_downsize",
        "re-evaluate_cpu_throttling_and_cpu_memory_after_7d_clean_window",
    ]
    if decision == "eligible_for_sizing_experiment":
        next_steps.insert(0, "run_read_only_7d_baseline_then_prepare_dry_run_sizing_diff")

    return {
        "service": "ml-controller",
        "resource": resource,
        "cpu_throttling": annotations.get("run.googleapis.com/cpu-throttling"),
        "max_scale": annotations.get("autoscaling.knative.dev/maxScale"),
        "decision": decision,
        "blockers": blockers,
        "long_request_paths": [item["path"] for item in long_paths],
        "high_frequency_read_paths": [item["path"] for item in high_read_paths],
        "next_steps": next_steps,
    }


def build_report(
    *,
    scheduler_jobs: dict[str, dict[str, Any]],
    executions_by_job: dict[str, list[dict[str, Any]]],
    request_entries: Any = None,
    service_config: dict[str, Any] | None = None,
    job_configs: dict[str, dict[str, Any]] | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    job_configs = job_configs or {}
    job_names = sorted(set(executions_by_job) | set(job_configs))
    jobs = [
        summarize_job(
            job_name=job_name,
            executions=executions_by_job.get(job_name, []),
            scheduler_jobs=scheduler_jobs,
            job_config=job_configs.get(job_name),
        )
        for job_name in job_names
    ]
    request_summaries = summarize_service_requests(request_entries or [])
    service_resource = _extract_resource(service_config or {})
    for summary in request_summaries:
        total_latency = _num(summary.get("total_latency_sec"))
        summary["cost_proxy"] = {
            "service_vcpu_sec": _round(total_latency * _num(service_resource.get("cpu"))),
            "service_gib_sec": _round(total_latency * _num(service_resource.get("memory_gib"))),
        }
    return {
        "schema_version": "cloud-run-cost-hotspot-report-v1",
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(),
        "jobs": jobs,
        "service_requests": request_summaries,
        "service_sizing_strategy": build_service_sizing_strategy(
            service_config=service_config,
            request_summaries=request_summaries,
        ),
    }


def _parse_execution_arg(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("--executions must be JOB=PATH")
    job, path = value.split("=", 1)
    job = job.strip()
    if not job:
        raise argparse.ArgumentTypeError("execution JOB cannot be empty")
    return job, Path(path)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a read-only Cloud Run cost hotspot report from exported JSON evidence.",
    )
    parser.add_argument("--scheduler", type=Path, help="Scheduler JSON export or infra/gcp-scheduler-jobs.json.")
    parser.add_argument("--job-configs", type=Path, help="Cloud Run job config/list JSON export.")
    parser.add_argument("--service-config", type=Path, help="ml-controller service describe JSON export.")
    parser.add_argument("--service-requests", type=Path, help="Cloud Run revision request log JSON export.")
    parser.add_argument(
        "--executions",
        action="append",
        default=[],
        type=_parse_execution_arg,
        metavar="JOB=PATH",
        help="Cloud Run executions JSON export for one job. Repeat for multiple jobs.",
    )
    parser.add_argument("--generated-at")
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    scheduler_jobs = normalize_scheduler_jobs(_read_json(args.scheduler)) if args.scheduler else {}
    job_configs = normalize_job_configs(_read_json(args.job_configs)) if args.job_configs else {}
    service_config = _read_json(args.service_config) if args.service_config else {}
    request_entries = _read_json(args.service_requests) if args.service_requests else []
    executions_by_job: dict[str, list[dict[str, Any]]] = {}
    for job_name, path in args.executions:
        executions_by_job.update(normalize_executions(_read_json(path), job_name=job_name))

    report = build_report(
        scheduler_jobs=scheduler_jobs,
        executions_by_job=executions_by_job,
        request_entries=request_entries,
        service_config=service_config,
        job_configs=job_configs,
        generated_at=args.generated_at,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
