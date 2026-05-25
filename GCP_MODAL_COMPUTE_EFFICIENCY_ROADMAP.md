# GCP / Modal High-Spec Compute Efficiency Roadmap

Status: draft
Date: 2026-05-18
Scope: daily `pipeline-v2`, Modal daily inference, monthly retrain, compute telemetry

## Principle

This roadmap optimizes runtime and cost without lowering model, feature, or
validation specifications.

Non-negotiables:

- Do not reduce Markov `maxiter`, `search_reps`, or walk-forward validation.
- Do not reduce feature-selection permutations, trials, candidate features, or
  statistical checks.
- Do not reduce FT-Transformer epochs, architecture, feature scope, or
  promotion gates.
- Do not remove tree ensemble members.
- Do not use production `shadow` or `disabled` modes to reduce runtime when the
  current recommendation path depends on the full output.
- Do not weaken IC, precision@K, hit-rate, drawdown, top-K overlap, regime
  split, feature-count, or artifact completeness gates.
- Do not treat local speedup as production readiness without live readback.

Accepted optimization classes:

- Exact parallelism for independent work.
- Batch/vectorized inference with output parity.
- Data-transfer and tensor-allocation reduction.
- Reuse of immutable prepared matrices and artifacts.
- Orchestration changes that reduce idle waiting without changing compute
  results.
- Async Modal bundle/callback closure for long validation chains, with the same
  validation packet and downstream evidence gates.
- Better compute profiling and regression gates.

## Current Baseline

Observed monthly retrain run:

| Stage | Runtime |
|---|---:|
| Total monthly retrain | 8103.5s |
| Feature selection | 3546.7s |
| Tree models | 408.1s |
| FT-Transformer | 3310.0s |
| DLinear | 98.8s |
| PatchTST | 343.1s |
| SHAP | deferred 0.1s |

Observed daily pipeline and Modal surfaces:

| Surface | Current behavior | Optimization target |
|---|---|---|
| GCP `pipeline-v2` | Recent runs around 9.5-12.2 min. | Reduce wall time by removing non-critical tail and parallelizing heavy Modal stages. |
| Modal MarkovSwitching | 64 symbols are processed sequentially; per-symbol fitting dominates daily state-space overlay. | Preserve exact model work but run independent symbols concurrently. |
| Modal `predict_batch_v2` | Modal chunks exist, but each chunk still loops per symbol internally. | True batch feature matrix + model inference parity. |
| Monthly orchestrator | Parent process waits while child training jobs run. | Submit children and use finalizer/callback for artifact merge. |
| Compute telemetry | Modal mostly lands in `cost_events`; Worker profiles land in `compute_profile_events`. | One comparable compute profile layer for GCP, Modal, and Worker. |

## Target Outcomes

| Area | Baseline | Target | Acceptance |
|---|---:|---:|---|
| Daily `pipeline-v2` | 9.5-12.2 min | 3-5 min | Same predictions/recommendations or approved parity tolerance. |
| MarkovSwitching | 365-531s | 60-180s | Same symbol-level outputs and validation fields. |
| Monthly retrain | 8103.5s | 4500-6000s | Same artifacts and all quality gates pass. |
| Feature selection | 3546.7s | 1500-2400s | Same full statistical spec; selected pool non-inferior. |
| FT-Transformer | 3310.0s | 1800-2600s | Same config and non-inferior validation metrics. |
| Tree models | 408.1s | 120-220s | Same four tree artifacts and ensemble membership. |

## Wave 0 - Compute Profile Foundation

Goal: make every optimization measurable before touching compute behavior.

Progress:

- 2026-05-18: Modal cost tracking now builds a normalized
  `compute_profile_events` payload whenever `record_modal_call()` records a
  Modal function observation. The write is non-blocking telemetry: missing
  tables or insert failures do not affect compute paths.
- 2026-05-18: Added local compute efficiency report support. Exported
  baseline/optimized profile JSON files can now be compared with quality
  evidence through `ml-controller/scripts/compute_efficiency_report.py` before
  any production change is considered.

Tasks:

1. Add a normalized compute-profile builder for GCP, Modal, and Worker stages.
2. Persist stage-level fields:
   - `provider`
   - `job_name`
   - `run_id`
   - `stage`
   - `wall_sec`
   - `compute_sec`
   - `cpu`
   - `memory_mb`
   - `gpu`
   - `rows`
   - `features`
   - `symbols`
   - `trials`
   - `artifact_count`
   - `quality_gate_status`
3. Keep `cost_events` for cost accounting, but emit comparable profiles into
   `compute_profile_events`.
4. Add a report command that compares a baseline run with an optimized run.

Local report command:

```powershell
ml-controller\.venv\Scripts\python.exe ml-controller\scripts\compute_efficiency_report.py `
  --job-name monthly-universal-retrain `
  --baseline baseline_profiles.json `
  --optimized optimized_profiles.json `
  --quality quality_evidence.json `
  --fail-on-decision `
  --pretty
```

Primary files:

- `ml-controller/services/cost_tracker.py`
- `ml-controller/services/compute_efficiency_contract.py`
- `ml-controller/services/modal_client.py`
- `worker/src/lib/computeProfileEvents.ts`
- `worker/migration_compute_profile_events.sql`

Definition of done:

- Daily pipeline, monthly retrain, and Worker callbacks expose comparable stage
  timings.
- A faster run is rejected when quality/spec gates regress.
- No production behavior changes.

## Wave 1 - Daily Pipeline P0

### 1.1 Exact MarkovSwitching Parallelization

Root cause:

- `state_space_batch_predict()` processes each symbol sequentially.
- `run_markov_switching()` performs heavy independent fits per symbol.

Progress:

- 2026-05-18: Added bounded per-symbol executor support in
  `ml-service/app/state_space_universal.py`. MarkovSwitching and KalmanFilter
  remain single-worker by default until parity evidence approves enabling
  parallel workers, and
  `STATE_SPACE_MARKOVSWITCHING_MAX_WORKERS` / `STATE_SPACE_MAX_WORKERS` can
  override the cap. The runner, fit parameters, walk-forward validation, and
  output schema are unchanged. Tests verify output order is preserved.
- 2026-05-18: Added local/read-only parity helper
  `ml-service/scripts/state_space_parallel_parity.py` to compare serial output
  against bounded parallel output on the same exported series payload before
  enabling Modal worker overrides.
- 2026-05-18: Added shared state-space series export helpers in
  `ml-controller/services/state_space_series.py` and a read-only exporter
  `ml-controller/scripts/export_state_space_series.py`. Daily pipeline now uses
  the same extraction helper, so parity evidence uses the production
  `payloads[*].prices[*].close` shape.
- 2026-05-18: Added offline payload JSON mode to the exporter via
  `--payloads`. This lets local/CI parity checks build the same state-space
  series from an exported daily payload file without requiring Cloudflare D1
  credentials in the shell.
- 2026-05-18: Added controller-level overlay mode
  `PIPELINE_STATE_SPACE_OVERLAY_MODE` / `STATE_SPACE_OVERLAY_MODE`.
  `blocking` is the default and preserves current behavior. `shadow` spawns the
  coalesced Kalman/Markov Modal job without blocking `node_ml_predict`, and
  does not attach state-space overlays to the recommendation path. `disabled`
  skips overlays explicitly. This is an opt-in serving-path latency control;
  model specs and feature predictions are unchanged.
- 2026-05-24: Production no-downgrade guard added:
  `shadow`/`disabled` now require
  `PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE=1`; otherwise the pipeline forces
  `blocking`. The accepted production optimization is Modal-owned callback
  closure with full overlays, not silently omitting overlays from the daily
  recommendation path.

Optimization:

- Keep the same Markov model, parameters, validation, and output schema.
- Run per-symbol Markov work through bounded concurrency.
- Preserve deterministic result ordering by symbol.
- Keep a sequential fallback behind an environment flag.
- Keep state-space overlays as risk/regime context, not alpha votes; when using
  `shadow`, the recommendation main path is not blocked by Markov fitting.

Primary files:

- `ml-service/app/state_space_universal.py`
- `ml-service/app/models.py`
- `ml-service/modal_app.py`
- `ml-controller/graphs/daily_pipeline_v2.py`
- `ml-controller/services/modal_client.py`

Acceptance:

- Same input payload produces the same symbols and status counts.
- Numeric outputs are equal or within documented floating tolerance.
- Validation fields remain present.
- Markov wall time improves by at least 30%.

Local parity command:

```powershell
ml-controller\.venv\Scripts\python.exe ml-controller\scripts\export_state_space_series.py `
  --run-date 2026-05-18 `
  --output .tmp\state_space_series_2026-05-18.json `
  --pretty

ml-controller\.venv\Scripts\python.exe ml-controller\scripts\export_state_space_series.py `
  --run-date 2026-05-18 `
  --payloads .tmp\daily_payloads_2026-05-18.json `
  --output .tmp\state_space_series_2026-05-18.json `
  --pretty

ml-service\.venv\Scripts\python.exe ml-service\scripts\state_space_parallel_parity.py `
  --input .tmp\state_space_series_2026-05-18.json `
  --model-name MarkovSwitching `
  --parallel-workers 2 `
  --pretty
```

### 1.2 Move Dataset Snapshot Tail Out Of `pipeline-v2`

Root cause:

- The graph can complete, but `pipeline_job_main.py` still runs deferred dataset
  snapshot follow-up in the same Cloud Run job.

Optimization:

- End `pipeline-v2` after graph callbacks and critical writebacks finish.
- Run dataset snapshot export in a separate Cloud Run job, Worker queue, or
  Modal background task.
- Keep snapshot status visible through observability.

Primary files:

- `ml-controller/pipeline_job_main.py`
- `ml-controller/dataset_snapshot_job_main.py`
- `ml-controller/services/dataset_snapshot_exporter.py`
- `worker/src/lib/postMarketChain.ts`

Current implementation state:

- `pipeline-v2` keeps the existing inline fallback when no snapshot job name is
  configured.
- When `DATASET_SNAPSHOT_JOB_NAME` or
  `PIPELINE_DATASET_SNAPSHOT_JOB_NAME` is configured, `pipeline-v2` emits a
  `dataset-snapshot-export` `triggered` callback and exits after starting the
  detached Cloud Run job.
- When `DATASET_SNAPSHOT_EXECUTOR=modal` or
  `PIPELINE_DATASET_SNAPSHOT_EXECUTOR=modal` is configured, the detached
  snapshot owner is Modal `dataset_snapshot_export` with the same
  `export_daily_research_snapshots()` path, callback task, and default 504-day
  lookback.
- `dataset_snapshot_job_main.py` owns the heavy D1 reads, GCS writes, manifest
  upsert, and terminal `dataset-snapshot-export` success/error callback.

Acceptance:

- Daily predictions and recommendations still write successfully.
- Dataset snapshots still complete eventually.
- Main `pipeline-v2` wall time drops by the removed tail duration.
- Snapshot failure cannot mark successful prediction/recommendation writeback as
  failed.

### 1.3 Move Regime Compute Wait Out Of Cloud Run

Root cause:

- `/regime/compute` does not mainly burn CPU; it synchronously waits for
  `load_market_env`, HMM regime compute, Worker KV/D1 writeback, and shift
  trigger closure inside a Cloud Run request.

Optimization:

- Keep the original sync route as rollback.
- Add a short Worker -> controller trigger path that spawns Modal
  `regime_compute` and returns after `function_call_id`.
- Let Modal load the same market environment, run the same HMM/evidence logic,
  push the same `source=regime` payload, then callback Worker
  `task=regime-compute`.
- Pass the previous regime label into the async request so Worker callback can
  close `detectRegimeShift()` after the new label is written.

Current implementation state:

- `ml-controller/routers/regime.py` exposes env-gated
  `POST /regime/compute/run`.
- `ml-controller/services/modal_client.py` exposes `spawn_regime_compute()`
  with 4 CPU / 16Gi Modal spec.
- `ml-service/modal_app.py` exposes Modal `regime_compute`.
- `worker/src/lib/controllerDailyWorkflows.ts` supports
  `REGIME_COMPUTE_MODAL_TRIGGER_ENABLED`,
  `HMM_REGIME_COMPUTE_MODAL_TRIGGER_ENABLED`, or
  `REGIME_COMPUTE_EXECUTOR=modal`.
- `worker/src/routes/adminControlRoutes.ts` records `regime-compute` report
  artifacts and runs callback-side regime-shift detection.

Acceptance:

- Same HMM logic, same market-env owner, same KV push payload.
- Same regime-shift queue semantics.
- Cloud Run request wait is reduced to a short Modal spawn call when enabled.
- No CPU/memory/model/window quality setting is lowered.

### 1.4 Move Universal Retrain Prep Wait Out Of Cloud Run

Root cause:

- Heavy training already runs on Modal, but `/retrain/universal` still keeps a
  Cloud Run service request alive while it loads GCS/D1 data, assembles the
  full-market payload, waits for prep batches, and only then spawns Modal
  `retrain_orchestrator`.

Optimization:

- Keep `/retrain/universal` as rollback.
- Add `/retrain/universal/run` so Cloud Run only acquires the existing retrain
  lock, records dispatch status, spawns Modal, and returns.
- Move GCS snapshot load, D1 fallback, payload assembly, prep batches, and
  `retrain_orchestrator` spawn into Modal `universal_retrain_pipeline`.
- Keep retrain followup as the authoritative completion/lock-release path.

Current implementation state:

- `ml-controller/routers/retrain_trigger.py` exposes env-gated
  `POST /retrain/universal/run`.
- `ml-controller/services/modal_client.py` exposes
  `spawn_universal_retrain_pipeline()` with 4 CPU / 16Gi Modal spec.
- `ml-service/modal_app.py` exposes Modal `universal_retrain_pipeline`; it
  reuses controller retrain helpers by mounting `/root/routers` and keeps the
  same prep/orchestrator sequence.
- `worker/src/lib/controllerResearchWorkflows.ts` can trigger the short path
  via `UNIVERSAL_RETRAIN_MODAL_TRIGGER_ENABLED`,
  `RETRAIN_UNIVERSAL_MODAL_TRIGGER_ENABLED`, `UNIVERSAL_RETRAIN_EXECUTOR`, or
  `RETRAIN_UNIVERSAL_EXECUTOR`.

Acceptance:

- Same lock lifecycle and followup callback.
- Same stock universe, train groups, full-feature prep, FTT hyperparameters,
  artifact registry path, and monthly quality gates.
- Cloud Run request wait is reduced to lock + Modal spawn when enabled.
- No retrain is executed by local verification.

### 1.5 ModelPool Read Hotspot Cache

Root cause:

- `/model_pool/lineage` repeatedly reads `universal/model_pool.json` and every
  active/challenger metadata blob from GCS for dashboard/OBS polling.
- `/model_pool/artifact_registry*` GET endpoints repeatedly query D1 and, for
  promotion/champion views, also read `model_pool.json` champion versions.
- These are read-pressure paths, not heavy compute paths; moving them to Modal
  would add another hop without changing the dominant cost.

Optimization:

- Add a Worker KV read-through cache at dashboard proxy boundaries so repeated
  UI/OBS polling does not hit Cloud Run at all within the freshness window.
- Add a short in-process read-through TTL cache to the controller read routes.
- Keep `bypass_cache=true` for forced readback/debug.
- Invalidate immediately after successful owner mutations: challenger
  register/discard, weekly IC pool/registry updates, promote-check apply,
  validation-chain persistence, promotion-controller confirmation,
  champion-pointer backfill, and pool init.
- Keep the cache bounded to serving reads only; no prediction, training,
  promotion gate, or registry write semantics change.

Current implementation state:

- `worker/src/lib/modelPoolReadCache.ts` caches model-pool controller GETs
  behind KV and invalidates the prefix after confirmed dashboard proxy
  promotion-controller or champion-pointer backfill writes. Scheduler-owned
  weekly IC and artifact validation-chain writes also invalidate the same
  Worker cache after successful controller mutation.
- `ml-controller/routers/model_pool.py` caches `/status`, `/lineage`, and
  read-only `/artifact_registry*` GET payloads.
- TTL defaults to 45 seconds in both Worker and controller and can be set
  through
  `MODEL_POOL_READ_CACHE_TTL_SECONDS` or route-specific
  `MODEL_POOL_<KIND>_CACHE_TTL_SECONDS`; Worker also supports
  `MODEL_POOL_PROXY_CACHE_TTL_SECONDS`.
- Local contract coverage verifies repeated lineage reads reuse GCS downloads,
  `bypass_cache=true` forces fresh GCS reads, artifact registry GETs reuse the
  query result within TTL, Worker KV caching reuses controller payloads, and
  invalidation forces the next query.

Acceptance:

- Dashboard/OBS polling latency and Cloud Run request count drop without moving
  read paths to Modal.
- Freshness-sensitive operator reads can bypass cache explicitly.
- Any successful mutation invalidates cached projections.
- No model spec, dataset scope, promotion rule, or scheduler setting is lowered.

### 1.6 Detach Post-Pipeline Callback Chain

Root cause:

- After `pipeline-v2` posts its terminal scheduler callback, Worker used to
  synchronously run `runPostPipelineCallbackChain()` before responding to the
  controller callback.
- That chain triggers downstream verification closure. It is not part of the
  already-written recommendation payload, but it kept the Cloud Run job request
  open while Worker did follow-up orchestration.

Optimization:

- Release `lock:ml-predict:<date>` immediately in the callback handler.
- Schedule `runPostPipelineCallbackChain()` with `executionCtx.waitUntil()`.
- Preserve the same downstream verify-v2 trigger, scheduler logs, and error
  logging; only move the wait boundary out of the controller callback response.

Current implementation state:

- `worker/src/routes/adminControlRoutes.ts` detaches the post-pipeline callback
  chain for successful `task=pipeline` callbacks.
- `worker/src/lib/pipelineCallbackNonBlockingContract.test.ts` blocks
  reintroducing a synchronous `await runPostPipelineCallbackChain(...)` in the
  callback request path.
- `ml-controller/routers/pipeline.py::_emit_subtask_callbacks()` now fans out
  `ml-predict` and `recommendation` dashboard callbacks concurrently with the
  same payload contract.
- `ml-controller/pipeline_job_main.py` now sends the terminal `pipeline`
  callback and the dashboard tile callbacks in one `asyncio.gather()` fan-out.
  Dataset snapshot follow-up remains after this callback batch, preserving
  closure order while removing another serial callback tail.
- Worker scheduler logs now keep callback `metadata`, and `pipeline-v2`
  annotates `duration_ms` as graph runtime excluding callback tail. The Job log
  reports `graph_elapsed`, `callback_fanout`, `snapshot_followup`, and total
  runtime so Cloud Run cost audits can separate real compute from orchestration
  wait.
- Compute profile events now store `await_sec`, `compute_owner`, and
  `remote_function` as queryable columns, with a legacy-table fallback that
  keeps the raw profile JSON if the additive D1 migration has not run yet.
  Both Worker-originated and controller-originated telemetry have this fallback.
- Compute efficiency reports now aggregate those fields, so wait ownership is
  visible at report level rather than only in raw event rows.
- Post-verify meta-learning shadow now runs NeuralUCB and NeuralTS concurrently
  after registry setup, preserving both policy runs and their 45s timeout while
  reducing Worker callback-chain wall time.
- `pipeline-v2` deferred dataset snapshot follow-up now defaults to Modal when
  Modal credentials are present and no explicit snapshot executor/job is set.
  This matches the observed live env shape on 2026-05-25. Auto Modal spawn
  falls back inline only in non-required mode, preserving snapshot quality while
  moving the normal path out of Cloud Run.
- Scheduler callbacks now emit non-blocking compute-profile events from
  callback metadata. Terminal callbacks become queryable in
  `compute_profile_events`, while `triggered` dispatch-only callbacks are
  intentionally skipped to avoid fake compute rows.
- Admin OBS now has `GET /api/admin/compute-profiles` for read-only callback
  and runtime profile inspection, including a legacy-table fallback that parses
  wait attribution from `profile_json`.
- Worker task telemetry now classifies trigger dispatch as await time
  (`compute_sec=0`, `compute_owner=orchestration_dispatch`) instead of treating
  trigger round-trips as compute.
- Modal dataset snapshot callbacks now carry explicit compute attribution
  metadata, so terminal callback rows can be tied to Modal ownership without
  relying on summary text.
- `pipeline-v2` terminal callback metadata now carries Cloud Run resource hints
  (`PIPELINE_CLOUD_RUN_CPU`, default 4; `PIPELINE_CLOUD_RUN_MEMORY_MB`, default
  4096). This keeps the current runtime spec unchanged and only improves
  vCPU-sec/GiB-sec attribution.
- Post-deploy smoke now includes a read-only
  `/api/admin/compute-profiles?date=$Date&limit=5` readback before optional
  trigger smoke, so OBS endpoint availability and legacy-column fallback state
  are verified immediately after rollout.

Acceptance:

- Cloud Run `pipeline-v2` no longer waits for Worker post-pipeline closure.
- verify-v2 and post-pipeline scheduler evidence still run after success.
- Pipeline lock release remains immediate.
- Dashboard tile callback payloads and ownership are unchanged.
- Terminal callback, tile callbacks, and snapshot follow-up ordering remain
  deterministic enough for scheduler readback: snapshot follow-up is still
  post-callback-batch.
- Billing investigation can compare Cloud Run execution time against graph,
  callback fan-out, and snapshot follow-up timings.
- OBS can query wait ownership directly instead of parsing profile JSON.
- Report-level comparisons can preserve wait-owner context across grouped
  events.
- Worker waitUntil chain duration drops without moving or weakening any
  post-verify evidence task.
- Live `pipeline-v2` env no longer needs a separate executor flip to avoid the
  inline snapshot fallback once this code is deployed.
- OBS can reconcile scheduler callbacks, compute profile rows, and R2 reports
  without manual KV parsing.
- Operators can inspect Cloud Run/Modal wait ownership through the admin API
  before flipping any production scheduler or deploy setting.
- Production D1 currently needs the additive wait-column migration before those
  fields are directly queryable; fallback preserves them in `profile_json`.
- Deploy gate checks `compute_profile_wait_columns` and blocks rollout until
  the additive D1 migration is present.
- No recommendation output, model spec, validation gate, or scheduler cadence is
  reduced.

## Wave 2 - Daily Inference P1

### 2.1 True Batch `predict_batch_v2`

Root cause:

- Modal chunks reduce container count, but inside each chunk
  `predict_stock_v2_batch()` still loops per symbol.

Optimization:

- Build one aligned feature matrix per chunk.
- Run XGBoost, CatBoost, LightGBM, ExtraTrees, FT-Transformer, and challenger
  models with batch inference.
- Reuse loaded artifacts and shared feature metadata.
- Keep the current per-symbol runtime as fallback until parity is proven.

Primary files:

- `ml-service/app/batch_prediction.py`
- `ml-service/app/prediction_runtime.py`
- `ml-service/app/model_store.py`
- `ml-controller/services/modal_client.py`

Implementation state (2026-05-18):

- `predict_stock_v2_batch()` now prepares per-symbol feature contexts once per
  chunk and builds batch matrices for active feature artifacts.
- XGBoost, CatBoost, ExtraTrees, LightGBM, FT-Transformer, and challenger
  artifacts can be scored via one batch call per model per chunk.
- `predict_stock_v2()` accepts internal batch-provided feature rank scores and
  still owns IC merge, rank stacker, thresholds, signal composition, and output
  schema.
- Serial per-symbol prediction remains the correctness fallback when runtime
  monkeypatching, schema drift, or unexpected artifact errors prevent batch
  preparation.
- `torch` is now imported lazily only when the single-symbol FT-Transformer
  fallback branch is actually used.

Acceptance:

- Per-symbol prediction rows match current runtime within tolerance.
- Model count, output labels, and confidence semantics are unchanged.
- Modal wall time improves by at least 25% after Markov is no longer the only
  bottleneck.

### 2.2 Chunk-Size A/B By Wall Time

Optimization:

- Select chunk size using observed wall time and error rate, not compute seconds
  alone.
- Keep candidate chunk sizes fixed unless Wei approves a broader experiment.

Implementation state (2026-05-18):

- `batch_predict_contract()` keeps explicit `MODAL_PREDICT_BATCH_SIZE` as the
  highest-priority override.
- When `MODAL_PREDICT_BATCH_SIZE_OBSERVATIONS` is provided, the controller ranks
  candidate chunk sizes by `wall_sec / input_count`, then rejects variants whose
  observed error rate exceeds `MODAL_PREDICT_BATCH_SIZE_MAX_ERROR_RATE`
  (default `0.02`) or whose run count is below
  `MODAL_PREDICT_BATCH_SIZE_MIN_RUNS`.
- Without eligible observations, the existing deterministic 20/40/80 A/B hash
  remains the fallback.
- `predict_batch_v2` telemetry now records result count, result error count,
  result error rate, batch error rate, and model cache hit ratio at top level so
  later runs can promote a winner without relying on compute seconds.

Acceptance:

- Chunk policy records baseline, variant, winner, and reason.
- Failed or slower variants auto-fallback.

## Wave 3 - Monthly Retrain P0

### 3.1 FT-Transformer No-Result-Change GPU Efficiency

Root cause:

- Training loop can spend unnecessary time on repeated tensor allocation and
  device transfer.

Optimization:

- Pre-convert train, validation, and test arrays into tensors or DataLoader
  structures.
- Use pinned memory or device-resident tensors where appropriate.
- Keep the same model config, seed policy, epochs, patience, batch size, and
  data split.
- Add epoch-level timing for data transfer, forward/backward, validation, and
  artifact upload.

Primary files:

- `ml-service/app/universal_training.py`
- `ml-service/modal_app.py`

Current implementation state:

- FT-Transformer train/validation batches now use CPU TensorDataset/DataLoader
  staging instead of rebuilding `torch.tensor(...)` from NumPy slices every
  mini-batch.
- CUDA path still uses `model_ftt.to(device)`, AMP autocast, GradScaler, and
  non-blocking pinned-memory batch transfer to GPU.
- Model architecture, feature set, epochs, patience, batch size, split policy,
  margin ranking loss, and quality gates are unchanged.

Acceptance:

- Artifact metrics remain non-inferior.
- IC, precision@K, hit-rate, drawdown, and top-K overlap gates pass.
- Wall time improves by at least 15%.

### 3.2 Exact Parallel Feature Selection

Root cause:

- Signal sanity, target permutation, and K sweep contain independent model fits
  but are not fully distributed across Modal child work.

Optimization:

- Keep the same number of permutations, trials, and candidate features.
- Split independent shuffled models and K-sweep trials into child functions.
- Cache shared feature matrices and immutable prepared datasets.
- Aggregate deterministically.

Primary files:

- `ml-service/app/feature_selection.py`
- `ml-service/modal_app.py`

Current implementation state:

- Target permutation and Optuna K sweep already expose bounded parallel workers
  through feature-selection policy.
- Signal sanity gate now uses the same non-downgrade pattern: generate the same
  number of shuffled targets first, then parallelize the independent LightGBM
  fits with bounded per-model CPU threads.
- `UNIVERSAL_FEATURE_SELECTION_SIGNAL_SANITY_WORKERS` controls this separately
  from target permutation and K sweep; default is 2 workers.
- Optuna K sweep now memoizes deterministic objective results by `k`, so
  duplicate trials reuse the first LightGBM fit result instead of retraining the
  same feature subset. This keeps trials, sampler behavior, Pareto selection,
  and selected pool semantics unchanged while reducing wasted duplicate work.
- K sweep evidence now records `n_trials`, `actual_trials`,
  `unique_k_evaluated`, and `objective_cache_hits`.

Acceptance:

- Feature pool is identical, or any difference must pass the same
  non-inferiority gate.
- No reduction in statistical checks.
- Wall time improves by at least 30%.

## Wave 4 - Monthly Retrain P1

### 4.1 Retrain Orchestrator Finalizer Split

Root cause:

- `retrain_orchestrator` waits while child training jobs run, creating idle
  billing and long parent lifetime.

Optimization:

- Parent function submits child jobs and exits after durable run-state creation.
- A finalizer merges artifacts, writes registry entries, and emits webhook
  completion after all required children finish.
- Preserve current artifact naming and registry semantics.

Primary files:

- `ml-service/modal_app.py`
- `ml-service/app/training_finalizer.py`
- `ml-controller/services/modal_client.py`
- `ml-controller/routers/ml.py`

Current implementation state:

- The orchestrator still waits for child jobs by default; production behavior is
  unchanged.
- `training_finalizer.reduce_training_group_results()` now owns the pure merge
  contract for tree, FTT, DLinear, and PatchTST partial results:
  `merged_results`, `merged_ic`, `circuit_breaker`, `total_samples`,
  `candidate_models`, `sequence_candidate_models`, and `partial_errors`.
- `retrain_orchestrator` now calls this side-effect-free reducer before
  challenger registration, rank stacker training, IC tracking GCS writes, SHAP,
  and webhook callback. This is the first detachable finalizer boundary.
- `training_finalizer.build_retrain_followup_payload()` now owns the controller
  followup payload schema, including training sample summary, IC summary,
  challenger registrations, status, stages, and Modal telemetry events. The
  orchestrator still posts the webhook inline, but the payload contract is now
  reusable by a detached finalizer.

Acceptance:

- Same final artifacts and registry entries.
- Webhook lifecycle is complete and auditable.
- Idle parent compute cost is reduced.

### 4.2 Tree Model Parallel Child Jobs

Root cause:

- XGBoost, CatBoost, ExtraTrees, and LightGBM are independent ensemble members
  but run as one serial stage.

Optimization:

- Split each tree model into its own child function.
- Cap per-child CPU to avoid oversubscription.
- Merge artifacts after all children complete.

Primary files:

- `ml-service/app/universal_training.py`
- `ml-service/modal_app.py`
- `ml-service/app/training_policy.py`
- `ml-service/app/training_finalizer.py`

Current implementation state:

- Default `train_tree_models` behavior is unchanged: the four tree models still
  run in the existing single CPU Modal function unless opt-in fan-out is
  enabled.
- `build_tree_model_child_payloads()` now creates one governed payload per tree
  model while preserving `feature_pool.tree_active`, selected-feature policy,
  candidate version, and full tree parent membership metadata.
- `train_tree_model` is an opt-in per-model Modal child function. When
  `tree_model_split` payload flag or `UNIVERSAL_TREE_MODEL_SPLIT=1` is set,
  `train_tree_models` spawns XGBoost, CatBoost, ExtraTrees, and LightGBM child
  jobs, waits for them, combines their OOS artifacts back into the existing
  `tree` group artifact, and returns the same tree-group result shape used by
  the orchestrator.
- `UniversalTrainRequest.training_run_suffix` prevents parallel tree children
  from overwriting the same training manifest path while keeping model artifact
  version semantics unchanged.
- `reduce_tree_model_child_results()` fails the tree group if any required tree
  member is missing, preserving ensemble membership rather than accepting a
  faster partial train.

Acceptance:

- All four tree artifacts exist.
- Ensemble membership is unchanged.
- Wall time approaches the slowest single tree job instead of the sum.

## Wave 5 - Regression Gates And Operations

Current implementation state:

- `compute_efficiency_contract.normalize_compute_profile()` now recovers
  operational telemetry from top-level fields, `meta`, and persisted
  `profile_json`, including Modal batch `chunk_size`, `chunk_count`,
  `result_error_rate`, `batch_error_rate`, `model_cache_hit_ratio`,
  state-space overlay mode, finalizer mode, and Modal function call id.
- `aggregate_compute_profiles()` now summarizes operational telemetry across
  profile events with weighted error-rate rollups and cache/chunk/mode sets, so
  baseline-vs-optimized reports can explain whether speedups came from chunk
  policy, shadow overlay mode, cache behavior, or orchestration split.
- `build_compute_efficiency_report()` now includes an `operational` block with
  baseline/optimized snapshots and deltas. This is observability-only; the
  high-spec quality gates and accept/block decisions are unchanged.
- Missing quality evidence now returns `NEEDS_REVIEW` instead of being accepted
  or mislabeled as a quality regression. A run must provide IC, precision@K,
  hit-rate, drawdown, top-K overlap, regime split, and feature-count evidence
  before it can be marked `ACCEPT_HIGH_SPEC_EFFICIENCY`.
- Artifact/scope regressions now return `BLOCK_SPEC_REGRESSION`. If an
  optimized run reduces rows, symbols, trials, or artifact count versus the
  baseline, the speedup is blocked even when quality metrics look non-inferior.
- With `--fail-on-decision`, the local report command exits non-zero for
  `BLOCK_QUALITY_REGRESSION`, `NEEDS_REVIEW`, `KEEP_BASELINE_RUNTIME`, and
  `BLOCK_SPEC_REGRESSION`.
- Modal compute profiles now preserve `artifact_count` from meta fields such as
  `artifact_count`, `model_artifacts`, `artifact_paths`, or `models` inside
  `profile_json`, so report-only artifact/scope gates can evaluate live Modal
  telemetry without a D1 schema migration.
- Retrain followup Modal telemetry now attaches per-training-group artifact
  scope from partial results, including `artifact_count`, `model_artifacts`,
  train/test sample counts, and feature count. The controller callback forwards
  those meta fields into `record_modal_call()`, so Modal compute profiles can
  preserve artifact scope for monthly retrain reports.
- Modal compute profiles now map training sample metadata into `rows`.
  `total_samples` / `sample_count` are preferred, with `train_samples` as a
  fallback. This gives the Wave 5 rows/scope gate usable retrain sample counts
  from followup telemetry.
- Monthly feature-selection followup telemetry now carries selected feature
  scope and trial scope. The feature-selection stage emits `active_count`,
  reserve/tree/FT counts, target-permutation count, K-sweep trial count, and
  cache-hit count when available; Modal telemetry maps these into
  `feature_count` and `trials` meta for compute reports.
- Compute efficiency reports now include report-only `observability` status:
  `ok`, `needs_review`, `degraded`, or `blocked`. This surfaces degraded compute
  or missing evidence to dashboards and CLI consumers while keeping
  `production_blocking=false` until fail-closed behavior is explicitly approved.

Tasks:

1. Add a compute-efficiency comparison report for:
   - daily pipeline
   - monthly retrain
   - feature selection
   - model training
   - Modal inference
2. Add regression thresholds:
   - wall time regression
   - cost regression
   - error-rate regression
   - artifact-count regression
   - quality-gate regression
3. Surface degraded compute status in observability without blocking production
   until Wei approves fail-closed behavior.

Definition of done:

- Faster-but-worse runs are blocked by report status.
- Faster-and-equivalent runs are marked accepted.
- Unknown quality evidence returns `needs_review`, not `accepted`.

## Execution Order

1. Wave 0: profile foundation.
2. Wave 1.1: Markov exact parallelization.
3. Wave 1.2: dataset snapshot tail split.
4. Wave 3.1: FT-Transformer GPU efficiency.
5. Wave 3.2: exact parallel feature selection.
6. Wave 4.1: orchestrator finalizer split.
7. Wave 4.2: tree model child jobs.
8. Wave 2.1: true batch `predict_batch_v2`.
9. Wave 5: regression dashboard and operations hardening.

## Approval Boundaries

Allowed without extra approval:

- Local code edits.
- Local tests.
- Read-only runtime inspection.
- New docs and reports.

Requires explicit Wei approval:

- Deploy.
- Retrain.
- Commit.
- Push.
- Production scheduler changes.
- Running real GCP/Modal jobs that mutate production state.
- Any real order or live-submit action.
