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

## 2026-05-24 No-Downgrade Amendment

Wei's production boundary is now explicit: cost optimization must not reduce
CPU/memory specs, model families, timeouts, horizons, samples, trials, lookback
windows, overlays, or data coverage. Any earlier "downsize" recommendation in
this read-only audit is superseded. The accepted optimization path is to move
wait ownership, batch I/O, detached artifact jobs, and callback closure while
preserving the same outputs.

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
| `pipeline-v2` | 4 CPU / 4Gi | 74 | 4 | 11 | 30,965s total, 123,862 vCPU-sec | Split wait boundaries; no downsize |
| `finlab-v4-backfill` | 4 CPU / 16Gi | 9 | 3 | 3 | 4,955s total, 19,820 vCPU-sec, 79,282 GiB-sec | Move to Modal P0 |
| `optuna-research-sweep` | 4 CPU / 4Gi | 7 | 1 | 3 | 9,693s total, 38,773 vCPU-sec | Move to Modal P1/P0 |
| `verify-v2` | 4 CPU / 4Gi | 51 | 7 | 4 | 8,079s total, but latest success 18s | Keep spec; optimize wait/I/O only if needed |

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

The service sizing gate is superseded by the no-downgrade boundary. Keep specs;
remove long request waits, high-frequency polling, and duplicated I/O first.

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

Current implementation state:

- 2026-05-24: Added Modal `finlab_v4_backfill`, controller
  `/finlab/backfill/run`, and Worker `finlab-v4-backfill` trigger wiring.
- Worker trigger is explicitly gated by
  `FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED=1` or
  `FINLAB_V4_BACKFILL_MODAL_TRIGGER_ENABLED=1`; without the flag it returns
  skipped and leaves the Cloud Run Job as owner.
- Payload keeps `write_d1=true`, `apply_canonical_d1=true`, archive lookback
  limited to production-supported `3` or `5` years, and a bounded canonical
  repair window.

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
  - `backtest_research_bundle` for weekly backtest + MC + PBO callback closure.
  - Later split `backtest_replay`, `monte_carlo_mdd`, and `pbo_analysis` only
    when route-specific artifact/readback schemas are needed.
- Prefer GCS dataset snapshots as input to avoid repeated D1 fanout.
- Controller endpoints spawn Modal and persist result/callback.
- Keep exact validation packet and promotion gate semantics in `validation_governance.py`.

Current implementation state:

- 2026-05-24: Added `backtest-research-bundle-v1` contract and env-gated
  `/backtest/research-bundle/run` -> Modal spawn path. Existing synchronous
  `/backtest/run`, `/backtest/monte-carlo`, and `/backtest/pbo` routes are not
  changed yet.
- 2026-05-24: Worker `weekly-backtest` can now optionally trigger the Modal
  bundle when `BACKTEST_RESEARCH_BUNDLE_ENABLED=1` or
  `WEEKLY_BACKTEST_RESEARCH_BUNDLE_ENABLED=1`. The default chain remains
  synchronous until production is explicitly flipped. Bundle success callbacks
  trigger `model-artifact-validation`, preserving the existing ModelPool
  evidence closure.
- 2026-05-25: Added env-gated `/backtest/replay/run` -> Modal
  `backtest_replay` spawn path. The Modal function calls the existing
  `trigger_replay(ReplayRequest)` implementation so replay validation,
  persistence guard, and Strategy Lab records are not forked.
- 2026-05-25: Added env-gated async route equivalents for the manual/API
  backtest family:
  - `/backtest/run/async` -> Modal `backtest_full_run`
  - `/backtest/monte-carlo/run` -> Modal `backtest_monte_carlo`
  - `/backtest/pbo/run` -> Modal `backtest_pbo`
  These call the same full backtest, MC, and PBO service owners and preserve
  caller-provided simulation/partition settings.

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

Current implementation state:

- 2026-05-24: Added Modal `dataset_snapshot_export` and
  `modal_client.spawn_dataset_snapshot_export()`.
- `pipeline-v2` deferred snapshot follow-up can now use
  `DATASET_SNAPSHOT_EXECUTOR=modal` or
  `PIPELINE_DATASET_SNAPSHOT_EXECUTOR=modal`.
- The Modal path calls the same `export_daily_research_snapshots()` owner,
  keeps the same callback task, and returns a short `triggered` callback from
  `pipeline-v2` while Modal writes the terminal success/error callback.
- 2026-05-25: Added Modal `d1_cold_archive_export`, controller
  `/datasets/export_cold_archive/run`, and callback/report artifact wiring for
  `dataset-snapshot-export`. The route is gated by
  `D1_COLD_ARCHIVE_EXECUTOR=modal`; the existing synchronous
  `/datasets/export_cold_archive` route is unchanged as rollback.

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

Current implementation state:

- 2026-05-25: Added env-gated `/retrain/universal/run` -> Modal
  `universal_retrain_pipeline` spawn path. The original
  `/retrain/universal` route remains as rollback.
- Controller acquires the existing `retrain:{run_date}` lock and writes
  `webhook_log` status, then returns after Modal spawn. If dispatch fails, the
  controller releases the lock.
- Modal `universal_retrain_pipeline` owns the existing prep sequence:
  `load_market_env`, GCS training snapshot load with D1 fallback, sector
  encoding, full payload assembly, full-feature prep batches, and
  `retrain_orchestrator` spawn.
- Worker can use the short trigger only when
  `UNIVERSAL_RETRAIN_MODAL_TRIGGER_ENABLED=1`,
  `RETRAIN_UNIVERSAL_MODAL_TRIGGER_ENABLED=1`,
  `UNIVERSAL_RETRAIN_EXECUTOR=modal`, or
  `RETRAIN_UNIVERSAL_EXECUTOR=modal` is set. Without the flag it keeps the
  existing fire-and-forget `/retrain/universal` path.
- Weekly drift preserves `candidate_type=weekly_drift`, target models, target
  families, and selected training groups. Monthly/manual retrain keeps the
  same scheduler task ids and retrain followup callback.

Acceptance:

- Same lock lifecycle.
- Same followup payload.
- Same artifact registry writes.
- Same monthly quality gates.
- Same stock universe, train groups, feature count, prep window, FTT
  hyperparameters, and promotion gates.

### P2 - Async or Cache `/regime/compute`

Why:

- Daily HMM prediction already calls `ML_SERVICE_URL`, which is Modal-hosted.
- The Cloud Run cost is mostly market environment assembly, request wait, evidence pack, and KV push.
- Max latency is below the long-path threshold but total 7d latency is visible.

Target shape:

- First cache market-env evidence and shorten `load_market_env`.
- If still costly, move whole regime evidence pack + HMM call + KV push into a Modal function.

Current implementation state:

- 2026-05-25: Added env-gated `/regime/compute/run` -> Modal
  `regime_compute` spawn path. The original `/regime/compute` route remains
  as rollback.
- Modal `regime_compute` uses the same `load_market_env()` owner, same HMM
  detector path, same evidence pack builder, and same `push_optuna_result`
  `source=regime` writeback.
- Worker `runRegimeCompute()` can use the short trigger path only when
  `REGIME_COMPUTE_MODAL_TRIGGER_ENABLED=1`,
  `HMM_REGIME_COMPUTE_MODAL_TRIGGER_ENABLED=1`, or
  `REGIME_COMPUTE_EXECUTOR=modal` is set.
- Worker passes `prev_label` into the async request; scheduler callback then
  runs `detectRegimeShift()` with the callback regime label, preserving the
  existing regime-shift -> per-regime Optuna queue behavior.

Acceptance:

- Same `market_regime_state` payload.
- Same legacy mirror behavior during migration.
- Same run-date semantics for backfills.
- Same regime-shift detection and queue semantics after async callback.

## Do Not Move First

### `verify-v2`

Do not move this to Modal first. Latest runs are around 15-18s. The exported total is inflated by older failures and retries. It is better to downsize or simplify the Cloud Run Job after failure causes are clean.

### `/model_pool/*`

Do not move these to Modal. They are read-pressure and polling/caching problems, not compute problems. Fix with Cloudflare KV/cache, dashboard polling reduction, or precomputed summary snapshots.

Implementation update:

- `worker/src/lib/modelPoolReadCache.ts` now caches dashboard proxy
  `/api/model-pool/*` and `/api/observability/model-health` controller reads
  in KV, with `bypass_cache=true` support and prefix invalidation after
  confirmed dashboard proxy mutations. Weekly IC and artifact validation-chain
  scheduler mutations also clear the Worker cache after success.
- `ml-controller/routers/model_pool.py` now caches `/model_pool/status`,
  `/model_pool/lineage`, and read-only `/model_pool/artifact_registry*` GET
  payloads behind a short in-process TTL.
- `bypass_cache=true` forces a fresh GCS/D1 read for operator debugging.
- Successful mutation owners invalidate the cache so register/discard,
  weekly-IC, validation-chain, promotion-controller, champion-pointer backfill,
  and init changes are visible without waiting for TTL.
- This keeps model_pool as a controller read surface; Worker cache reduces
  Cloud Run request count, controller cache reduces remaining request latency,
  and neither layer reduces polling quality, model specs, or promotion gates.

### `pipeline-v2` Whole Job

Do not move the whole pipeline first. It is the largest Cloud Run proxy, but most model math inside it already runs on Modal. The safer order is:

1. Move isolated true-compute jobs/endpoints.
2. Remove long service blockers.
3. Cache `/model_pool/*`.
4. Then run a sizing experiment for `ml-controller` and possibly `pipeline-v2`.

Moving `pipeline-v2` wholesale to Modal is a later architecture option only if orchestration waiting remains expensive after the above.

Implementation update:

- Worker `task=pipeline` scheduler callback now detaches
  `runPostPipelineCallbackChain()` with `executionCtx.waitUntil()`.
- The callback still releases `lock:ml-predict:<date>` immediately and still
  logs post-pipeline errors, but it no longer makes Cloud Run `pipeline-v2`
  wait while Worker triggers downstream verify-v2 closure.
- `ml-controller` now posts `ml-predict` and `recommendation` dashboard tile
  callbacks concurrently instead of serially after the terminal pipeline
  callback.
- `pipeline_job_main.py` now fans out the terminal `pipeline` callback and both
  dashboard tile callbacks in the same async batch; dataset snapshot follow-up
  still runs after the callback batch.
- Scheduler callback metadata is now persisted, and the Job log splits
  `graph_elapsed`, `callback_fanout`, `snapshot_followup`, and total runtime so
  orchestration wait can be attributed without changing compute specs.
- Compute profile events now persist `await_sec`, `compute_owner`, and
  `remote_function` as columns, so cost reports can query wait ownership
  directly while still falling back to profile JSON on an unmigrated D1 table
  from both Worker and controller telemetry writers.
- Compute efficiency aggregation now carries these wait-owner fields into the
  report payload, preserving the distinction between Cloud Run orchestration
  wait and Modal-owned compute.
- Post-verify meta-learning shadow now runs NeuralUCB and NeuralTS concurrently
  inside Worker waitUntil, preserving both shadow policies while shortening
  callback-chain wall time.
- Live `pipeline-v2` env inspected on 2026-05-25 had Modal credentials but no
  explicit dataset snapshot executor/job setting. The code now treats that env
  shape as `modal_auto` for deferred snapshot export, with inline fallback only
  when detached mode is not explicitly required.
- Scheduler callback handling now records terminal callback metadata into
  `compute_profile_events` while skipping spawn-only `triggered` callbacks, so
  cost analysis can join scheduler status, R2 reports, and compute profiles.
- Admin readback exposes `/api/admin/compute-profiles`, including legacy-table
  fallback from `profile_json`, so wait ownership can be inspected without
  manually parsing KV/R2 artifacts.
- Worker task telemetry now marks trigger-only dispatch rows as await time
  instead of compute time, preventing post-pipeline trigger calls from
  overstating actual compute.
- Deploy gate now blocks if production D1 is still missing the additive
  compute-profile wait columns, making the migration an explicit rollout
  prerequisite.
- Modal dataset snapshot callback metadata now includes provider/job/owner/
  remote-function hints for direct compute-profile attribution.
- `pipeline-v2` terminal callback metadata now includes Cloud Run resource
  hints (`PIPELINE_CLOUD_RUN_CPU`, default 4; `PIPELINE_CLOUD_RUN_MEMORY_MB`,
  default 4096) for vCPU-sec/GiB-sec attribution only; no live spec is reduced.
- Post-deploy smoke now verifies `/api/admin/compute-profiles` read-only
  readback before optional trigger smoke, so the attribution endpoint and
  fallback state are covered in rollout checks.
- This removes an orchestration wait boundary without reducing daily
  recommendation output, validation gates, or scheduler cadence.

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

8. **No-Downgrade Efficiency Experiment**
   - After P0/P1 long paths are gone and `/model_pool/*` is cached, evaluate:
     - `ml-controller`: keep spec; move long waits behind async callbacks.
     - `verify-v2`: keep spec; optimize only duplicated I/O or callback tail.
     - `pipeline-v2`: keep spec; split orchestration waits and detached artifact tails.

## Decision

Best next two implementations:

1. `finlab-v4-backfill` to Modal.
2. `/optuna/per_regime` to Modal spawn/callback.

These two are the clearest remaining GCP-heavy workloads and directly reduce the reasons `ml-controller` and Cloud Run Jobs need high specs. `pipeline-v2` should be optimized after these, not before.
