# Cloud Run Cost Hotspot Roadmap

Status: draft

Scope: read-only cost attribution for Cloud Run jobs, ml-controller request
hotspots, and the preconditions for changing ml-controller service sizing.

## Why This Exists

High spec is acceptable for true weekly or monthly research jobs. It is not
acceptable when the same high spec is used by weekday jobs, repeated failures,
manual retriggers, queue processors, or dashboard polling. The current boundary
is therefore frequency plus runtime evidence, not spec alone.

## Phase 1 - Cost Attribution Baseline

Add a repeatable read-only report that compares:

- Cloud Scheduler intended frequency.
- Cloud Run Job actual executions.
- Per-job CPU and memory limits.
- Success/failure count and max per-day execution count.
- ml-controller request count, total latency, and max latency.
- Cost proxy in vCPU-sec and GiB-sec. This is not an invoice; it is the
  comparison layer to use until Billing Export is wired into the report.

Implemented tool:

```powershell
ml-controller\.venv\Scripts\python.exe ml-controller\scripts\cloud_run_cost_hotspot_report.py `
  --scheduler .tmp\cloud-run-cost\scheduler.json `
  --job-configs .tmp\cloud-run-cost\jobs.json `
  --service-config .tmp\cloud-run-cost\ml-controller-service.json `
  --service-requests .tmp\cloud-run-cost\ml-controller-requests.json `
  --executions pipeline-v2=.tmp\cloud-run-cost\pipeline-v2-executions.json `
  --executions verify-v2=.tmp\cloud-run-cost\verify-v2-executions.json `
  --executions optuna-research-sweep=.tmp\cloud-run-cost\optuna-research-sweep-executions.json `
  --executions finlab-v4-backfill=.tmp\cloud-run-cost\finlab-v4-backfill-executions.json `
  --pretty
```

The tool does not call production. Export evidence separately with read-only
`gcloud` commands.

## Phase 7 - ml-controller Service Sizing Gate

Do not globally downsize ml-controller until these blockers are cleared:

- Long request paths still exist on the service surface.
- High-frequency read paths are not cached or throttled.
- Daily or subdaily high-spec jobs still run without duplicate-trigger guards.
- Failed executions are not separated from normal scheduled executions.

Allowed before downsize:

- Add Worker KV or short TTL cache for high-frequency read paths such as
  `/model_pool/lineage` and artifact registry projections.
- Move long request endpoints to Cloud Run Jobs, Modal, or async trigger paths.
- Add run-id evidence to distinguish scheduler, manual, callback, and retry
  triggers.

Blocked before downsize:

- Lowering ml-controller CPU or memory globally.
- Re-enabling synchronous long compute on the service request path.
- Treating local speedup as production readiness without live readback.

## Tonight 22:00 Observation

Observe, do not mutate:

- `evening-chain` scheduler status.
- `pipeline-v2` execution count, status, duration, and retry source.
- `verify-v2` callback execution status and duration.
- `finlab-v4-backfill` execution status if it overlaps the evening window.
- `optuna-research-sweep` executions, especially queue/manual triggers.
- ml-controller request latency hotspots after the chain starts.

Report policy:

- Keep true weekly/monthly high-spec jobs unless actual frequency exceeds the
  schedule.
- Review weekday high-spec jobs first, especially `finlab-v4-backfill`.
- Fix duplicate triggers and failed retries before lowering specs.
