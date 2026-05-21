# Cloud Run to Modal Heavy Compute Migration Analysis

Date: 2026-05-21
Status: read-only analysis

## Source Evidence

- Live Cloud Scheduler export: `.tmp/cloud-run-modal-analysis-2026-05-21/scheduler.json`
- Live Cloud Run Jobs export: `.tmp/cloud-run-modal-analysis-2026-05-21/jobs.json`
- Live Cloud Run Job executions:
  - `.tmp/cloud-run-modal-analysis-2026-05-21/exec-pipeline-v2.json`
  - `.tmp/cloud-run-modal-analysis-2026-05-21/exec-verify-v2.json`
  - `.tmp/cloud-run-modal-analysis-2026-05-21/exec-optuna-research-sweep.json`
  - `.tmp/cloud-run-modal-analysis-2026-05-21/exec-finlab-v4-backfill.json`
- Live `ml-controller` service config: `.tmp/cloud-run-modal-analysis-2026-05-21/ml-controller-service.json`
- Live `ml-controller` request logs, 7d freshness: `.tmp/cloud-run-modal-analysis-2026-05-21/ml-controller-requests-7d.json`
- Local read-only hotspot report: `.tmp/cloud-run-modal-analysis-2026-05-21/hotspot-report.json`
- D1 read-only telemetry:
  - `compute_profile_events`
  - `cost_events`
- Modal read-only app list: `stockvision-*` app is deployed.

No deploy, retrain, scheduler mutation, commit, push, or production write was performed.

## Current Boundary

Modal already owns most heavy ML math:

- Daily Modal inference: `predict_batch_v2`, `state_space_universal_predict`, `chronos_universal_predict`, `dlinear_universal_predict`, `patchtst_universal_predict`.
- Monthly retrain heavy stages: `retrain_orchestrator`, `feature_selection_pipeline`, `train_ftt_model`, `train_tree_models`, `train_patchtst_universal`, `train_dlinear_universal`, `shap_feature_audit`.
- Walk-forward training functions exist in Modal: tree, FT-T, HMM windows.
- Breeze2 research context is already Modal and is not a cost hotspot.

Cloud Run still carries meaningful cost or latency in two forms:

1. Cloud Run Jobs that run Python workloads or wait for Modal callbacks.
2. `ml-controller` service endpoints that stay open for long CPU or orchestration paths while the service is still `4 CPU / 4Gi`, `cpu-throttling=false`, `maxScale=5`.

## Live Hotspot Snapshot

### Cloud Run Jobs

| Surface | Spec | Recent exported executions | Failures | Max daily executions | Duration / cost proxy | Initial decision |
|---|---:|---:|---:|---:|---:|---|
| `pipeline-v2` | 4 CPU / 4Gi | 74 | 4 | 11 | 30,965s total, 123,862 vCPU-sec | Do not move first; split/downsize after blockers |
| `finlab-v4-backfill` | 4 CPU / 16Gi | 9 | 3 | 3 | 4,955s total, 19,820 vCPU-sec, 79,282 GiB-sec | Move to Modal P0 |
| `optuna-research-sweep` | 4 CPU / 4Gi | 7 | 1 | 3 | 9,693s total, 38,773 vCPU-sec | Move to Modal P1/P0 |
| `verify-v2` | 4 CPU / 4Gi | 51 | 7 | 4 | 8,079s total, but latest success 18s | Downsize, not Modal-first |

`pipeline-v2` has the highest exported Cloud Run proxy, but repo evidence shows the heavy model inference is already delegated to Modal. The Cloud Run job is mostly orchestration, D1/GCS writes, recommendation merge, callbacks, and waiting. Moving the whole job to Modal is possible, but it is higher operational risk than moving isolated workloads first.

### `ml-controller` Service Requests

| Path | Count | Max latency | Total latency | Service proxy | Decision |
|---|---:|---:|---:|---:|---|
| `/model_pool/lineage` | 600 | 18.5s | 1,614s | 6,457 vCPU-sec | Cache/reduce polling, not Modal |
| `/optuna/per_regime` | 1 | 784s | 784s | 3,136 vCPU-sec | Move to Modal P0 |
| `/regime/compute` | 15 | 83.6s | 706s | 2,826 vCPU-sec | P2 async/cache; HMM call already goes through Modal service |
| `/model_pool/artifact_registry/*` | 674 combined | 16-18s | 1,334s | 5,334 vCPU-sec | Cache/reduce polling, not Modal |
| `/backtest/run` | 4 | 75.9s | 245s | 982 vCPU-sec | Move validation compute to Modal P1 |
| `/retrain/universal` | 1 | 220.8s | 220.8s | 883 vCPU-sec | Mostly Modal already; move residual prep P2 |
| `/backtest/replay` | 4 | 66.9s | 196.6s | 786 vCPU-sec | Move replay compute to Modal P1 |
| `/datasets/export_cold_archive` | 2 | 174.5s | 174.5s | 698 vCPU-sec | Move to Modal P1 |

The service sizing gate remains `do_not_downsize_globally_yet` because there are still long request paths, high-frequency read paths, `cpu-throttling=false`, and high service spec.

## Migration Candidates

### P0 - Move `finlab-v4-backfill` Cloud Run Job to Modal

Why:

- It is a real GCP compute job, not just orchestration.
- It is weekday scheduled at `30 18 * * 1-5` Asia/Taipei.
- It is high memory: `4 CPU / 16Gi`.
- It had 3 recent exported failures, including one timeout near 3600s.
- The workload is isolated: fetch FinLab, materialize artifacts, upload GCS, write D1 summaries/canonical rows.

Target shape:

- Add a Modal function for `tools/finlab_v4_remote_backfill.py`.
- Worker or Scheduler triggers a short controller endpoint that spawns Modal and returns a `run_id`.
- Modal writes GCS artifacts and D1 summaries using the same idempotent `run_id`.
- Keep current Cloud Run Job as rollback until at least 5 successful weekday runs.

Acceptance:

- Same `manifest.json` schema and checksum.
- Same D1 summary tables updated.
- Same GCS prefix semantics.
- Runtime callback or remote KV/D1 readback proves success.
- Cloud Run `finlab-v4-backfill` can then be paused or deleted only after approval.

### P0 - Move `/optuna/per_regime` to Modal Function Spawn

Why:

- Current code says this route was moved from Modal to Cloud Run to avoid Modal web response timeout.
- The current service request hit 784s on `ml-controller`, blocking downsize.
- The route is explicitly CPU-heavy: replay `50-200` Optuna trials over a `400`-stock subset and `365`-day window.

Target shape:

- Put `optuna_per_regime_robust.run_search()` behind a Modal function with long timeout.
- `POST /optuna/per_regime` becomes a short spawn endpoint.
- Completion writes sandbox/challenger result through the existing `push_optuna_result` contract or a callback.
- Never direct-promote production config from Modal.

Acceptance:

- Same `PerRegimeReq` contract.
- Same sandbox/challenger output.
- Same no-direct-production-push guarantee.
- Modal result includes replay sample scope, trial count, best params, and failure status.
- Cloud Run request latency drops from minutes to seconds.

### P1 - Move `optuna-research-sweep` Cloud Run Job to Modal

Why:

- The job is mixed-frequency: weekly, monthly, and queue-triggered through `optuna-queue` every 6 hours.
- It has `4 CPU / 4Gi`, 7200s timeout, and 12 minute successful runs.
- It had 1 failed exported execution.
- It is research/calibration compute, not a Cloud Run service dependency.

Target shape:

- Replace the Cloud Run Job body with Modal `optuna_research_sweep` function spawn.
- Preserve Worker callback task semantics for `weekly-optuna`, `monthly-optuna`, and queue entries.
- Keep queue de-duplication and exact source attribution.

Acceptance:

- Existing `execute_research_sweep()` result schema preserved.
- Callback still lands in scheduler logs.
- Queue entries are marked processed/failed once.
- No direct production config mutation outside existing sandbox/challenger flow.

### P1 - Move Backtest / Replay / MC / PBO Compute to Modal

Why:

- `/backtest/run` and `/backtest/replay` are CPU-heavy Python loops in `ml-controller`.
- Weekly validation chains combine backtest, Monte Carlo, and PBO.
- These are independent, batchable workloads with natural partitioning by date range, symbol subset, or strategy candidate.
- Moving this off the service removes another reason to keep `ml-controller` high spec.

Target shape:

- Add Modal functions:
  - `backtest_run`
  - `backtest_replay`
  - `monte_carlo_mdd`
  - `pbo_analysis`
- Prefer GCS dataset snapshots as input to avoid repeated D1 fanout.
- Controller endpoints spawn Modal and persist result/callback.
- Keep exact validation packet and promotion gate semantics in `validation_governance.py`.

Acceptance:

- Same metrics for a fixed fixture: Sharpe, MDD, win rate, profit factor, expectancy, regime split, PBO.
- Same persistence guard: `persist_confirm` remains required.
- Same promotion gate behavior.
- Modal failures become visible in scheduler/run logs.

### P1 - Move Dataset Snapshot / Cold Archive Export to Modal

Why:

- `/datasets/export_cold_archive` still appears as a long service path.
- `pipeline-v2` already has a detached snapshot boundary, but no `dataset-snapshot-export` Cloud Run Job is present in the live job list.
- Snapshot/cold archive is D1-read/GCS-write work, not user-facing request work.

Target shape:

- Add Modal `dataset_snapshot_export` / `cold_archive_export` function.
- Trigger it from `pipeline-v2` callback or Worker post-pipeline chain.
- Write terminal `dataset-snapshot-export` scheduler log.

Acceptance:

- Prediction/recommendation success is not coupled to snapshot success.
- Snapshot manifest and GCS paths remain stable.
- Cold archive retries are idempotent by `run_date/run_id`.

### P2 - Move Residual `/retrain/universal` Prep to Modal

Why:

- Heavy model training is already Modal.
- The remaining Cloud Run latency is data prep/orchestrator dispatch, including stock row loading, GCS snapshot loading or D1 fallback, payload assembly, and prep batch submission.
- It is monthly/manual, so this is not the first cost target.

Target shape:

- Cloud Run only acquires lock and spawns Modal with high-level request metadata.
- Modal loads GCS/D1, builds payload batches, runs feature selection/train/followup, and releases lock via callback.

Acceptance:

- Same lock lifecycle.
- Same followup payload.
- Same artifact registry writes.
- Same monthly quality gates.

### P2 - Async or Cache `/regime/compute`

Why:

- Daily HMM prediction already calls `ML_SERVICE_URL`, which is Modal-hosted.
- The Cloud Run cost is mostly market environment assembly, request wait, evidence pack, and KV push.
- Max latency is below the long-path threshold but total 7d latency is visible.

Target shape:

- First cache market-env evidence and shorten `load_market_env`.
- If still costly, move whole regime evidence pack + HMM call + KV push into a Modal function.

Acceptance:

- Same `market_regime_state` payload.
- Same legacy mirror behavior during migration.
- Same run-date semantics for backfills.

## Do Not Move First

### `verify-v2`

Do not move this to Modal first. Latest runs are around 15-18s. The exported total is inflated by older failures and retries. It is better to downsize or simplify the Cloud Run Job after failure causes are clean.

### `/model_pool/*`

Do not move these to Modal. They are read-pressure and polling/caching problems, not compute problems. Fix with Cloudflare KV/cache, dashboard polling reduction, or precomputed summary snapshots.

### `pipeline-v2` Whole Job

Do not move the whole pipeline first. It is the largest Cloud Run proxy, but most model math inside it already runs on Modal. The safer order is:

1. Move isolated true-compute jobs/endpoints.
2. Remove long service blockers.
3. Cache `/model_pool/*`.
4. Then run a sizing experiment for `ml-controller` and possibly `pipeline-v2`.

Moving `pipeline-v2` wholesale to Modal is a later architecture option only if orchestration waiting remains expensive after the above.

## Recommended Roadmap

1. **P0 FinLab Modal Function**
   - Implement Modal wrapper for `finlab_v4_remote_backfill.py`.
   - Add dry-run/readback mode.
   - Keep GCP job as rollback.

2. **P0 `/optuna/per_regime` Modal Spawn**
   - Add Modal long-running function.
   - Change controller endpoint to spawn/callback.
   - Preserve sandbox-only push contract.

3. **P1 Backtest Validation Modal Suite**
   - Move `/backtest/run`, `/backtest/replay`, MC, and PBO compute.
   - Use GCS dataset snapshots as primary input.

4. **P1 `optuna-research-sweep` Modal Job**
   - Move Cloud Run Job body to Modal while preserving queue/callback semantics.

5. **P1 Dataset Snapshot / Cold Archive**
   - Move long D1-read/GCS-write export to Modal.

6. **P2 Retrain Prep Residual**
   - Collapse Cloud Run retrain prep into Modal orchestrator only after monthly lifecycle is stable.

7. **P2 Regime Compute Cache/Async**
   - Cache first; move only if latency remains material.

8. **Sizing Experiment**
   - After P0/P1 long paths are gone and `/model_pool/*` is cached, evaluate:
     - `ml-controller`: lower CPU/memory and/or enable CPU throttling.
     - `verify-v2`: downsize to a small job.
     - `pipeline-v2`: lower spec or split orchestration.

## Decision

Best next two implementations:

1. `finlab-v4-backfill` to Modal.
2. `/optuna/per_regime` to Modal spawn/callback.

These two are the clearest remaining GCP-heavy workloads and directly reduce the reasons `ml-controller` and Cloud Run Jobs need high specs. `pipeline-v2` should be optimized after these, not before.
