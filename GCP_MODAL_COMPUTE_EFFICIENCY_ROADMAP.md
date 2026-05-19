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
- `dataset_snapshot_job_main.py` owns the heavy D1 reads, GCS writes, manifest
  upsert, and terminal `dataset-snapshot-export` success/error callback.

Acceptance:

- Daily predictions and recommendations still write successfully.
- Dataset snapshots still complete eventually.
- Main `pipeline-v2` wall time drops by the removed tail duration.
- Snapshot failure cannot mark successful prediction/recommendation writeback as
  failed.

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
