# StockVision Score V2 / Compute RoadMap Status - 2026-05-23

Scope: source-of-truth inspection, local implementation, and approved production D1 readback/repair only.

No deploy, retrain, scheduler mutation, commit, or push was performed. On 2026-05-24, Wei-approved production D1 changes applied the Score V2 fundamental schema migration and seeded canonical fundamental rows from existing D1 data.

## 2026-05-24 No-Downgrade Compute Update

- Updated the Cloud Run to Modal plan to make Wei's boundary explicit:
  no CPU/memory downsizing, no reduced trials/windows/horizons/samples, and no
  production shadow/disabled shortcut for state-space overlays.
- `pipeline-v2` detached snapshot follow-up now supports
  `STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP_MODE=detached_required`, which emits
  a `dataset-snapshot-export` error callback instead of silently running the
  full snapshot inline when `DATASET_SNAPSHOT_JOB_NAME` is missing.
- State-space overlays now fail closed to `blocking` unless
  `PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE=1` explicitly authorizes
  `shadow` or `disabled`.
- Compute profile normalization now preserves `await_sec`, `compute_owner`, and
  `remote_function` so Cloud Run orchestration wait can be separated from Modal
  compute without changing model quality.
- `finlab-v4-backfill` now has a Modal spawn/callback skeleton:
  `ml-service/modal_app.py::finlab_v4_backfill`,
  `ml-controller/services/modal_client.py::spawn_finlab_v4_backfill`, and
  `ml-controller/routers/finlab.py` expose an env-gated
  `/finlab/backfill/run` entrypoint. It preserves `write_d1`,
  `apply_canonical_d1`, archive years, canonical window, and artifact upload
  arguments.
- Worker now exposes an explicit `finlab-v4-backfill` trigger owner gated by
  `FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED=1` or
  `FINLAB_V4_BACKFILL_MODAL_TRIGGER_ENABLED=1`. The trigger posts to
  `/finlab/backfill/run`, keeps `write_d1=true`, `apply_canonical_d1=true`,
  3Y/5Y archive validation, and a bounded canonical repair window. If the flag
  is absent, it returns skipped and leaves the existing Cloud Run Job as owner.
- `optuna-research-sweep` now has an env-gated Modal spawn/callback path via
  `OPTUNA_RESEARCH_SWEEP_EXECUTOR=modal`; it preserves `n_trials`,
  `subset_size`, `max_parallel_sources`, GA population/generations, and
  `research_data_source`.
- Backtest/MC/PBO now have a bundle artifact contract and env-gated Modal spawn
  boundary: `backtest-research-bundle-v1`,
  `BACKTEST_RESEARCH_BUNDLE_EXECUTOR=modal`, and
  `ml-service/modal_app.py::backtest_research_bundle`. The bundle requires
  full backtest, paper MC, backtest MC, and PBO results before callback closure;
  it does not reduce MC simulations, PBO partitions, or backtest universe.
- Worker `weekly-backtest` now has an env-gated Modal bundle trigger via
  `BACKTEST_RESEARCH_BUNDLE_ENABLED=1` or
  `WEEKLY_BACKTEST_RESEARCH_BUNDLE_ENABLED=1`. Default production behavior
  remains the legacy synchronous chain; when the bundle callback succeeds,
  Worker automatically runs `model-artifact-validation` so ModelPool evidence
  closure is not weakened.
- `pipeline-v2` deferred dataset snapshot export now supports
  `DATASET_SNAPSHOT_EXECUTOR=modal` or
  `PIPELINE_DATASET_SNAPSHOT_EXECUTOR=modal`. It uses the same
  `export_daily_research_snapshots()` path, same `dataset-snapshot-export`
  callback task, same 504-day default lookback, and bounded chunking, but moves
  the detached snapshot owner to Modal instead of extending the pipeline job
  tail.
- D1 cold archive export now has a Modal async route:
  `POST /datasets/export_cold_archive/run`, gated by
  `D1_COLD_ARCHIVE_EXECUTOR=modal`. The existing synchronous
  `/datasets/export_cold_archive` route remains as rollback. The Modal path
  calls the same `export_d1_cold_archive_snapshot()` owner and preserves
  `delete_requires_manual_approval=true`; it only exports archive artifacts and
  does not delete D1 rows.
- Backtest replay now has a Modal async route:
  `POST /backtest/replay/run`, gated by `BACKTEST_REPLAY_EXECUTOR=modal`.
  The Modal function calls the existing `trigger_replay(ReplayRequest)`
  implementation, preserving Mode A/B, `persist_confirm`, validation packet,
  and Strategy Lab record semantics.
- Backtest family manual/API routes now have env-gated Modal async equivalents:
  `/backtest/run/async` (`BACKTEST_RUN_EXECUTOR=modal`),
  `/backtest/monte-carlo/run` (`BACKTEST_MONTE_CARLO_EXECUTOR=modal`), and
  `/backtest/pbo/run` (`BACKTEST_PBO_EXECUTOR=modal`). The original sync
  routes remain as rollback; Modal calls the same `run_full_backtest()`,
  `run_monte_carlo_mdd()`, and `run_pbo_analysis()` owners with caller-provided
  simulation/partition settings.
- HMM regime compute now has an env-gated Modal async route:
  `POST /regime/compute/run`, gated by `REGIME_COMPUTE_EXECUTOR=modal` or
  `REGIME_COMPUTE_MODAL_ENABLED=1` on the controller and
  `REGIME_COMPUTE_MODAL_TRIGGER_ENABLED=1` on Worker. The original sync
  `/regime/compute` route remains as rollback. Modal loads the same
  `load_market_env()` owner, runs the same HMM regime logic, pushes
  `source=regime` to Worker, and callbacks `task=regime-compute`. Worker passes
  `prev_label` into the async request and closes `detectRegimeShift()` after
  the callback, so regime-shift Optuna queue semantics are preserved.
- Universal retrain prep now has an env-gated Modal async route:
  `POST /retrain/universal/run`, gated by `UNIVERSAL_RETRAIN_EXECUTOR=modal`
  or `UNIVERSAL_RETRAIN_MODAL_ENABLED=1` on the controller and by
  `UNIVERSAL_RETRAIN_MODAL_TRIGGER_ENABLED=1`,
  `RETRAIN_UNIVERSAL_MODAL_TRIGGER_ENABLED=1`,
  `UNIVERSAL_RETRAIN_EXECUTOR=modal`, or `RETRAIN_UNIVERSAL_EXECUTOR=modal`
  on Worker. The original `/retrain/universal` route remains as rollback.
  Controller acquires the same retrain lock and spawns Modal; Modal owns the
  same GCS snapshot/D1 fallback, full-feature prep batches, and
  `retrain_orchestrator` spawn. Weekly drift preserves `candidate_type`,
  target models/families, and train groups; monthly/manual retrain keeps
  canonical scheduler task ids and followup closure.
- ModelPool read hot paths now have a no-downgrade server-side read cache:
  `/model_pool/lineage`, `/model_pool/status`, and read-only
  `/model_pool/artifact_registry*` GET endpoints use a short in-process TTL
  (`MODEL_POOL_READ_CACHE_TTL_SECONDS`, default 45s; route-specific envs
  supported), plus `bypass_cache=true` for forced readback. Successful
  mutation paths invalidate the cache: challenger register/discard, weekly IC
  pool/registry updates, promote-check apply, artifact validation-chain
  persistence, promotion-controller confirmation, champion-pointer backfill,
  and pool init. This reduces repeated GCS/D1 polling latency without moving
  read paths to Modal and without changing model quality, polling semantics,
  or production ownership.
- Worker dashboard proxy now adds the first-hop ModelPool read cache:
  `worker/src/lib/modelPoolReadCache.ts` caches model-pool controller GETs in
  KV with the same default 45s TTL, forwards `bypass_cache=true` to the
  controller, and invalidates the prefix after confirmed promotion-controller
  or champion-pointer backfill writes. Scheduler-owned ModelPool writes also
  invalidate the same Worker cache after successful weekly IC and
  artifact-validation-chain updates. This reduces Cloud Run request count
  itself, while the controller cache reduces the remaining request latency.
- Pipeline scheduler callback no longer synchronously waits for the
  post-pipeline chain. `worker/src/routes/adminControlRoutes.ts` now releases
  the `lock:ml-predict:<date>` lock immediately and schedules
  `runPostPipelineCallbackChain()` with `executionCtx.waitUntil()`. This keeps
  the same verify-v2/post-pipeline closure semantics, but the Cloud Run
  `pipeline-v2` job no longer stays open while Worker triggers downstream
  callback work.
- Pipeline subtask callbacks are now fanned out concurrently from
  `ml-controller/routers/pipeline.py::_emit_subtask_callbacks()`. The callback
  payloads and task ownership stay the same (`ml-predict` and
  `recommendation`; screener remains Worker-owned), but the job tail no longer
  posts those dashboard tile callbacks serially.
- `pipeline-v2` Job now also fans out the terminal `pipeline` callback and the
  two dashboard tile callbacks in the same `asyncio.gather()` batch from
  `ml-controller/pipeline_job_main.py`. Dataset snapshot follow-up still starts
  only after that callback fan-out, so the closure order stays intact while the
  callback tail is no longer terminal-callback-then-tile-callback serial work.
- Scheduler callback logs now preserve callback `metadata` in KV/R2 artifacts,
  and `pipeline-v2` marks its `duration_ms` as graph runtime excluding callback
  tail. Cloud Run logs now emit `graph_elapsed`, `callback_fanout`,
  `snapshot_followup`, and total runtime so the 14-minute execution can be split
  into real compute versus orchestration/callback wait without reducing any
  model or data setting.
- Compute profile storage now persists wait attribution as first-class columns:
  `await_sec`, `compute_owner`, and `remote_function` were added to the D1
  schema/migration and to both Worker and controller-side compute-profile insert
  payloads. Worker telemetry falls back to the legacy insert if production D1
  has not run the additive migration yet, preserving profile JSON instead of
  dropping the event. Controller-side Modal cost telemetry now has the same
  legacy-payload retry, so deploy order does not drop compute-profile events
  before the additive migration is applied.
- Compute efficiency aggregation now carries the same wait attribution through
  reports: `aggregate_compute_profiles()` emits summed `await_sec`, the
  resolved `compute_owner`, `remote_function`, and their owner/function sets.
- Post-verify meta-learning shadow closure now runs NeuralUCB and NeuralTS
  shadow policies concurrently with the same 45s timeout and persistence path.
  This reduces Worker waitUntil wall time without removing either policy or
  weakening the evidence chain.
- Read-only live check on 2026-05-25 showed `pipeline-v2` has Modal credentials
  but no explicit `DATASET_SNAPSHOT_EXECUTOR` or `DATASET_SNAPSHOT_JOB_NAME`.
  To prevent silent inline snapshot export on Cloud Run, `pipeline_job_main.py`
  now defaults deferred snapshot follow-up to `modal_auto` whenever Modal token
  env exists and no explicit executor is configured. If auto Modal spawn fails
  in non-required mode, it falls back inline to preserve snapshot quality; if
  `detached_required` is explicitly set, it still fails closed.
- Scheduler callback handling now emits non-blocking compute-profile events
  from callback metadata via `recordSchedulerCallbackComputeProfile()`. Terminal
  callbacks such as `pipeline` and `verify-v2` become queryable in
  `compute_profile_events`; spawn-only `triggered` callbacks are skipped so
  dispatch latency is not misclassified as compute.
- Admin readback now exposes `GET /api/admin/compute-profiles` with date/job/
  provider filters. It reads `await_sec`, `compute_owner`, and
  `remote_function` directly when the additive migration exists, and falls back
  to parsing `profile_json` on legacy tables.
- Worker task compute profiles now distinguish trigger dispatch from actual
  Worker compute. `triggered`/`running` task logs record `compute_sec=0`,
  `await_sec=wall_sec`, and `compute_owner=orchestration_dispatch`; terminal
  success/error Worker tasks still record compute seconds normally.
- Read-only D1 check on 2026-05-25 confirmed production
  `compute_profile_events` does not yet have `await_sec`, `compute_owner`, or
  `remote_function`; `worker/migration_compute_profile_events_wait_columns.sql`
  remains a rollout prerequisite for queryable columns, with code-level legacy
  fallback active until it is applied.
- Deploy gate now includes `compute_profile_wait_columns`. It blocks rollout
  when the additive wait-attribution columns are missing and points to
  `worker/migration_compute_profile_events_wait_columns.sql`, so this cannot be
  missed during production readiness checks.
- Modal `dataset_snapshot_export` callback metadata now includes
  `provider=modal`, `job_name=dataset_snapshot_export`,
  `compute_owner=modal`, `remote_function=dataset_snapshot_export`, CPU, and
  memory hints so callback-origin compute profiles are attributable without
  parsing ambiguous summaries.
- `pipeline-v2` terminal callback metadata now includes Cloud Run resource
  hints (`PIPELINE_CLOUD_RUN_CPU`, default 4; `PIPELINE_CLOUD_RUN_MEMORY_MB`,
  default 4096). This does not change the live resource spec; it only lets
  callback-origin compute profiles estimate vCPU-sec/GiB-sec consistently.
- `scripts/post_deploy_smoke.ps1` now performs a read-only
  `/api/admin/compute-profiles?date=$Date&limit=5` check after the live
  predeploy gate, so rollout verification confirms the compute-profile
  readback endpoint and legacy-column fallback state before any optional
  trigger smoke.
- Verification: `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_backtest_research_bundle_contract.py
  ml-controller\tests\test_optuna_research_sweep_modal_contract.py
  ml-controller\tests\test_research_data_access_contract.py
  ml-controller\tests\test_finlab_modal_backfill_contract.py
  ml-controller\tests\test_finlab_backfill_job_guard.py
  ml-controller\tests\test_dataset_snapshot_job_split.py
  ml-controller\tests\test_daily_pipeline_state_space_overlay_mode.py
  ml-controller\tests\test_compute_efficiency_contract.py
  ml-controller\tests\test_modal_cost_tracker.py -q -p no:cacheprovider`
  passed (`56 passed`); `npm run type-check -- --pretty false` from `worker`
  passed. Later Worker bundle wiring verification also passed:
  `node_modules\.bin\tsc.cmd src\lib\weeklyResearchClosureContract.test.ts
  --module commonjs --target es2022 --types node --skipLibCheck --outDir
  .tmp\contract-tests --pretty false`, `node
  .tmp\contract-tests\weeklyResearchClosureContract.test.js`, and another
  `npm run type-check -- --pretty false` from `worker`. FinLab Worker trigger
  verification passed with `node_modules\.bin\tsc.cmd
  src\lib\finlabBackfillModalTriggerContract.test.ts --module commonjs
  --target es2022 --types node --skipLibCheck --outDir .tmp\contract-tests
  --pretty false`, `node
  .tmp\contract-tests\finlabBackfillModalTriggerContract.test.js`, and
  `npm run type-check -- --pretty false`. Dataset snapshot Modal executor
  verification passed with `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_dataset_snapshot_job_split.py
  ml-controller\tests\test_research_data_access_contract.py -q -p
  no:cacheprovider` (`17 passed`) and `py_compile` for the changed
  pipeline/modal files. D1 cold archive Modal verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_d1_cold_archive_exporter.py -q -p
  no:cacheprovider` (`4 passed`), `py_compile`, Worker `npm run type-check --
  --pretty false`, and the Worker data-store contract compiled/executed via
  `.tmp\contract-tests\dataStoreBoundaryContract.test.js`. Backtest replay
  Modal verification passed with `ml-controller\.venv\Scripts\python.exe -m
  pytest ml-controller\tests\test_backtest_research_bundle_contract.py -q -p
  no:cacheprovider` (`6 passed`), `py_compile`, and Worker type-check. After
  adding full backtest/MC/PBO async routes, the same contract suite passed with
  `10 passed`. Regime async verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_regime_compute_async_contract.py
  ml-controller\tests\test_backtest_research_bundle_contract.py
  ml-controller\tests\test_d1_cold_archive_exporter.py
  ml-controller\tests\test_dataset_snapshot_job_split.py
  ml-controller\tests\test_research_data_access_contract.py -q -p
  no:cacheprovider` (`33 passed`), `py_compile`, Worker type-check, and the
  compiled Worker `regimeComputeModalTriggerContract` smoke test. Universal
  retrain Modal prep verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_universal_retrain_modal_pipeline_contract.py
  ml-controller\tests\test_regime_compute_async_contract.py -q -p
  no:cacheprovider` (`4 passed`), `py_compile`, Worker type-check, and the
  compiled Worker `universalRetrainModalTriggerContract` smoke test.
  ModelPool read-cache verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_model_pool_lineage.py
  ml-controller\tests\test_model_artifact_registry.py -q -p
  no:cacheprovider` (`40 passed`) and `py_compile` for
  `ml-controller\routers\model_pool.py`. Worker proxy cache verification
  passed with `npm run type-check -- --pretty false`, `npx tsc --module
  commonjs --target ES2022 --types node --skipLibCheck --esModuleInterop
  --outDir ..\.tmp\contract-tests
  src\lib\modelPoolReadCacheContract.test.ts`, and `node
  ..\.tmp\contract-tests\lib\modelPoolReadCacheContract.test.js`.
  Pipeline callback detach verification passed with Worker type-check, `npx
  tsc --module commonjs --target ES2022 --types node --skipLibCheck
  --esModuleInterop --outDir ..\.tmp\contract-tests
  src\lib\pipelineCallbackNonBlockingContract.test.ts`, and `node
  ..\.tmp\contract-tests\pipelineCallbackNonBlockingContract.test.js`.
  Pipeline subtask fan-out verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_pipeline_callback_contract.py -q -p
  no:cacheprovider` (`5 passed`) and `py_compile` for
  `ml-controller\pipeline_job_main.py`, `ml-controller\routers\pipeline.py`,
  and `ml-controller\tests\test_pipeline_callback_contract.py`. Pipeline
  callback cost-attribution metadata verification later passed with the same
  command (`6 passed`). Worker scheduler metadata verification passed with
  `npm run type-check -- --pretty false`, `npx tsc --module commonjs --target
  ES2022 --types node --skipLibCheck --esModuleInterop --outDir
  ..\.tmp\contract-tests src\lib\adminCronCallbackRoutes.test.ts
  src\lib\pipelineCallbackNonBlockingContract.test.ts`, and `node
  ..\.tmp\contract-tests\adminCronCallbackRoutes.test.js`. Compute profile
  wait-column verification passed with `ml-controller\.venv\Scripts\python.exe
  -m pytest ml-controller\tests\test_modal_cost_tracker.py
  ml-controller\tests\test_compute_efficiency_contract.py -q -p
  no:cacheprovider` (`25 passed`), `py_compile` for
  `ml-controller\services\cost_tracker.py`, Worker type-check, compiled
  `src\lib\computeProfileEvents.test.ts`, and `node
  ..\.tmp\contract-tests\lib\computeProfileEvents.test.js`. Read-side compute
  efficiency attribution verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_compute_efficiency_contract.py
  ml-controller\tests\test_modal_cost_tracker.py -q -p no:cacheprovider`
  (`24 passed`) and `py_compile` for
  `ml-controller\services\compute_efficiency_contract.py`. Post-market
  callback contract verification passed with Worker type-check, `npx tsc
  --module commonjs --target ES2022 --types node --skipLibCheck
  --esModuleInterop --outDir ..\.tmp\contract-tests
  src\lib\postMarketChainContract.test.ts
  src\lib\pipelineCallbackNonBlockingContract.test.ts`, and `node
  ..\.tmp\contract-tests\postMarketChainContract.test.js`. Dataset snapshot
  auto-Modal owner verification passed with `ml-controller\.venv\Scripts\python.exe
  -m pytest ml-controller\tests\test_dataset_snapshot_job_split.py
  ml-controller\tests\test_pipeline_callback_contract.py -q -p no:cacheprovider`
  (`13 passed`) and `py_compile` for `ml-controller\pipeline_job_main.py`.
  Scheduler-callback compute-profile verification passed with Worker
  `npm run type-check -- --pretty false`, compiled
  `src\lib\computeProfileEvents.test.ts`,
  `src\lib\adminCronCallbackRoutes.test.ts`, and
  `src\lib\pipelineCallbackNonBlockingContract.test.ts`, plus node smoke tests
  for the compiled outputs. Pipeline callback metadata contract passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_pipeline_callback_contract.py -q -p no:cacheprovider`
  (`6 passed`). Compute profile readback verification passed with Worker
  type-check, compiled `src\lib\computeProfileReadRouteContract.test.ts`, and
  `node ..\.tmp\contract-tests\lib\computeProfileReadRouteContract.test.js`.
  Worker dispatch-only telemetry verification passed with Worker type-check,
  compiled `src\lib\computeProfileEvents.test.ts`, and `node
  ..\.tmp\contract-tests\lib\computeProfileEvents.test.js`. Deploy-gate schema
  verification passed with Worker type-check, compiled
  `src\lib\deployGate.test.ts`, and `node
  ..\.tmp\contract-tests\lib\deployGate.test.js`. Modal dataset snapshot
  callback metadata verification passed with
  `ml-controller\.venv\Scripts\python.exe -m pytest
  ml-controller\tests\test_research_data_access_contract.py
  ml-controller\tests\test_dataset_snapshot_job_split.py -q -p no:cacheprovider`
  (`19 passed`) and `py_compile` for `ml-service\modal_app.py`.

## Status Legend

- 已處理: owner/contract/runtime path exists and targeted verification passed.
- 處理到一半: code or guard exists, but at least one runtime owner, production rollout, or validation gate is still missing.
- 未處理: only discussion, taxonomy placeholder, or roadmap exists.

## Phase Status

| Phase | Status | Current evidence | Remaining gap |
|---|---|---|---|
| Phase 0 - source-of-truth baseline | 處理到一半 | `CLOUD_RUN_COST_HOTSPOT_ROADMAP.md`, `CLOUD_RUN_TO_MODAL_MIGRATION_ANALYSIS_2026_05_21.md`, `ml-controller/scripts/cloud_run_cost_hotspot_report.py`, Score V2 IC contract exist. | R2 mirror inventory and a single exported score-path baseline are not complete. |
| Phase 1 - FinLab daily backfill cost | 處理到一半 | `tools/finlab_v4_remote_backfill.py` has canonical D1 window args; `tools/finlab_backfill_job_guard.py`, `scripts/finlab_canonical_d1_repair_plan.ps1`, strict D1 verifier contract exist. | Live job/scheduler was not changed; daily incremental vs full artifact policy still needs production readback and Modal wrapper. |
| Phase 2 - `/optuna/per_regime` trigger + Modal | 處理到一半偏後 | Worker `optuna-queue` now triggers `/optuna/per_regime/run`; controller returns after async trigger. Cloud Run Job fallback still supports `OPTUNA_JOB_KIND=per_regime`, trigger source/id, callback task, and stable run id. Modal now has `optuna_per_regime_robust`, controller service mounts the per-regime script/services, `modal_client.spawn_optuna_per_regime()` exists, and `/optuna/per_regime/run` supports env-gated Modal spawn via `OPTUNA_PER_REGIME_EXECUTOR=modal`. Worker queue now uses D1 `scheduler_locks` for processor/run locks plus KV cooldown as a secondary guard. `optuna-queue` scheduler callback now closes the D1 run lock and writes an R2 scheduler report artifact/readback payload. | Not deployed; production env is not flipped to Modal. Live callback/readback, Modal app deployment verification, and production artifact candidate readback remain missing. |
| Phase 3 - technical factors V2 | 處理到一半偏後 | `worker/migration_technical_indicators_v2.sql`, `worker/src/lib/technicalIndicators.ts`, `worker/src/lib/technicalIndicatorsV2.fixture.json`, `ml-controller/services/recommendation_service.py`, `ml-controller/services/backtest_engine.py`, `ml-controller/services/dataset_snapshot_exporter.py`, and contracts cover ADX/DMI, SAR, CCI, volume-weighted RSI, and volume momentum divergence. Worker formula tests, Python Score V2 builder, backtest snapshot loader, weekly audit factor contribution smoke, and regime-stratified contribution summary now consume or preserve the same V2 fixture/columns. | IC, forward return, and MAE/MFE validation still require historical replay/read-only runtime data. |
| Phase 4 - Score V2 taxonomy | 處理到一半偏後 | `worker/src/lib/scoreV2Taxonomy.ts` owns 25/25/25/20/5 weights; frontend/worker/controller contracts now push runtime readers toward `score_v2`. Backtest replay/diagnostic ranking now computes screener norm from Score V2 `chipFlow + technicalStructure`, with momentum folded into technicalStructure, and contract guards reject the old `(chip_score + tech_score) / screener_denominator` owner. Worker screener seed score now projects partial Score V2 total; calibration syncs both `score_components` and `candidate.score`; screener seed persistence prefers canonical Score V2 finalScore. `screenerDenominator` is now documented and tested as deprecated config compatibility only, not a runtime owner. | Some storage/projection surfaces still carry legacy scalar names for seed/projection compatibility; rollout owner is not cut over. |
| Phase 5 - fundamental quality 20 | 處理到一半偏後 | `fundamentalQuality` exists in taxonomy/reporting templates. `ml-controller/services/fundamental_quality.py` now provides a pure 0-20 scorer for revenue momentum, profitability, valuation, financial safety, and industry-relative quality with point-in-time guards. `worker/migration_score_v2_fundamental_quality.sql` defines `canonical_fundamental_features`; `finlab_canonical_materializer.py` can materialize FinLab fundamental rows into that table with conservative availability dates; `tools/finlab_v4_remote_backfill.py` supports explicit `FINLAB_FUNDAMENTAL_FACTOR_KEYS_JSON` mapping for paid-plan factor fetches; `load_fundamental_quality_by_symbol()` now prefers canonical fundamental features before legacy `financials` fallback. Live read-only contribution readiness now confirms production has `canonical_revenue_monthly=38536` and `financials=3074`, but `canonical_fundamental_features` table is missing. `score_v2_fundamental_migration_preflight.py` now validates the migration file and live schema read-only; latest preflight decision is `READY_TO_APPLY`. | Applying the migration, materializing canonical fundamental rows, actual FinLab paid-plan key mapping, and historical validation still require explicit approval/readback; owner switch remains blocked. |
| Phase 6 - news/theme 5 + risk overlay | 處理到一半偏後 | Breeze2 research context and fact-support/hype-risk flags exist; `newsTheme` is capped in taxonomy. Worker screener buzz/sentiment now updates canonical Score V2 `newsTheme` instead of only mutating `candidate.score`; positive news/theme contribution is capped at 5, negative sentiment adds a risk flag and `finalScore` adjustment. Runtime `theme_signals` now uses a 14-day freshness window. `newsThemeRiskOverlay.ts` classifies high-confidence official/company IR negative evidence and can veto or penalize candidates from `external_evidence_items`. Live read-only readiness confirms inputs exist (`theme_signals=1655`, `stock_theme_features=39295`, `external_evidence_items=74`, `news_7d=2381`) and screener funnel has buzz evidence, but latest daily Score V2 `newsTheme` is still 0/64. `score_v2_news_theme_handoff_report.py` now separates repo-contract status from live production handoff and reports `WAITING_DEPLOY` when contracts pass but production rows are still zero. | Production deploy/readback is still needed so buzz/theme evidence is preserved in canonical Score V2 payload; real external-evidence replay remains missing. |
| Phase 7 - trading plan chart/product language | 處理到一半偏後 | `buildMarketStructureWatchPoint()` now outputs trading-plan language. `CandlestickChart` now derives and overlays resistance, support, volume node, ATR band/defense, SAR, institutional chip-flow histogram, and broker-branch flow line from OHLCV/indicator/chip/broker-flow APIs. | Real-data rendered QA and production D1/API readback are still pending because local API returned empty datasets / proxy errors. |
| Phase 8 - rollout and observation | 處理到一半偏後 | Local contracts/type-checks exist. `ml-controller/services/score_v2_replay_audit.py` and `ml-controller/scripts/score_v2_readonly_replay_report.py` now provide a read-only Old scalar score vs Score V2 ranking replay audit plus fail-closed rollout gate. `score_v2_contribution_readiness.py` and CLI now diagnose the Phase 5/6 contribution blockers. `score_v2_fundamental_migration_preflight.py` provides a read-only migration readiness gate before any D1 apply. `score_v2_news_theme_handoff.py` now provides a read-only handoff gate for newsTheme. Live read-only D1 replay on latest `daily_recommendations` date `2026-05-22` produced 64 rows, Score V2 coverage 1.0, top10 overlap 1.0, missing Score V2 0, and no drift rows; rollout gate correctly BLOCKs because `fundamentalQuality=0.0` and `newsTheme=0.0`. Contribution readiness root causes: `canonical_fundamental_features_missing`, `fundamental_quality_live_zero`, `news_theme_handoff_missing`; handoff-specific decision is `WAITING_DEPLOY`, not repo-contract BLOCK. | Fundamental/news production materialization/deploy/readback must be repaired before ranking owner switch; dual-write flag, ranking owner switch, and 3-5 trading-day observation are still not done. |

## 2026-05-24 Prod-Readiness Update

- Added the aggregate prod-readiness gate:
  - `ml-controller/services/score_v2_prod_readiness.py`
  - `ml-controller/scripts/score_v2_prod_readiness_report.py`
  - `ml-controller/tests/test_score_v2_prod_readiness.py`
  - report output: `.tmp/score_v2_prod_readiness.json`
- Applied the approved production D1 fundamental schema migration:
  - `worker/migration_score_v2_fundamental_quality.sql`
  - readback decision: `ALREADY_APPLIED`
  - table: `canonical_fundamental_features`
- Superseded legacy D1 fundamental repair:
  - legacy repair SQL has been removed from the repo.
  - current policy is FinLab-only canonical fundamental materialization via `source='finlab.fundamental_factor_diversity'`.
  - any production rows from older non-FinLab repair runs must be ignored by code paths and removed by an explicit D1 cleanup run.
- Re-ran contribution readiness:
  - `canonical_fundamental_features_missing` is resolved
  - remaining root causes: `fundamental_quality_live_zero`, `news_theme_handoff_missing`
  - latest production `daily_recommendations` date remains `2026-05-22`
  - latest component readback remains `fundamentalQuality=0/64`, `newsTheme=0/64`
- Current aggregate decision:
  - `score_v2_prod_readiness.json`: `NOT_PROD_READY`
  - hard blockers: `fundamental_quality_live_zero`, `news_theme_handoff_missing`, `score_v2_rollout_gate_not_passed`
  - Phase 5 next action is now correctly narrowed to `deploy_controller_score_v2_path_and_rerun_daily_recommendations_after_wei_approval`; schema/data materialization is already applied.
  - Phase 6 next action remains `deploy_worker_and_rerun_screener_after_wei_approval`.
  - next production step requires Wei approval: deploy Worker/ml-controller changes and rerun the daily screener/evening recommendation path, then re-run read-only contribution/replay gates.
- Deploy-preflight evidence:
  - `npm run deploy -- --dry-run --outdir ..\.tmp\wrangler-dry-run` from `worker` passed; Worker upload preview was `1630.68 KiB / gzip 366.16 KiB` and bindings resolved.
  - seed-SQL tests are removed; current validation is canonical FinLab materialization plus contribution/readiness contracts.
  - `powershell -ExecutionPolicy Bypass -File scripts\p9_gate.ps1` passed after aligning the gate's Worker contract-test compiler flags with the Worker tsconfig (`ES2022`, `WebWorker`, Node default imports).
  - `gaOptimizerPush.test.ts` now provides a minimal D1 mock so the GA optimizer push contract exercises parameter-candidate recording without crashing on missing `DB.batch()`.
  - `deploy_ml_controller.sh --check-only` passed with service/job/verify/optuna images in sync at revision `ml-controller-00285-jdr`; no deploy was performed.
- Production safety boundary:
  - ml-controller was deployed after explicit approval on 2026-05-24; service revision `ml-controller-00286-wr4`
  - service/job/verify/optuna images were synced to `sha256:760aab861b27744a7ed9575bb665bb1bb2d4745b8d2fbe67391d708151c52c44`
  - `ml-controller /health` readback passed: `callbackConfigured=true`, `pipelineJobConfigured=true`, `verifyJobConfigured=true`, `optunaJobConfigured=true`
  - Worker deploy was not performed; the approval request was blocked because `cont` is not explicit enough for this production mutation.
  - no retrain was performed
  - no scheduler mutation was performed
  - no rerun was performed
  - no commit or push was performed

## This Pass

- Added `worker/src/lib/technicalIndicatorsV2.fixture.json` as the shared Worker/Python golden fixture for V2 technical factors.
- Updated `worker/src/lib/technicalIndicators.test.ts` to verify `computeTechnicalIndicators()` against the shared fixture.
- Updated `ml-controller/tests/test_score_v2_technical_contract.py` to build Score V2 technical signals/breakdown from the same fixture.
- Updated `worker/src/lib/technicalIndicatorsV2Contract.test.ts` so both runtime sides must keep consuming the shared fixture.
- Updated `ml-controller/services/backtest_engine.py` and `ml-controller/services/dataset_snapshot_exporter.py` so backtest D1 loads and compute snapshots preserve technical V2 columns.
- Updated `ml-controller/tests/test_backtest_snapshot_loader.py` to load the same technical V2 fixture into a backtest snapshot and assert the V2 columns survive `get_indicator()`.
- Updated `ml-controller/tests/test_research_data_access_contract.py` to guard V2 technical columns across backtest loader, snapshot exporter, and snapshot fixture.
- Updated `ml-controller/tests/test_weekly_audit_score_v2_contract.py` to verify Score V2 factor contribution accepts a payload built from the technical V2 fixture.
- Updated `ml-controller/graphs/weekly_audit_graph.py` so Score V2 factor attribution now includes a regime-stratified contribution summary from `score_components.alphaReason.regime`.
- Updated `worker/src/lib/recommendationContext.ts` so market-structure context now returns `交易計劃` wording:
  - `回測 ... 站穩才追`
  - `前高壓力`
  - `關鍵支撐`
  - `破位防守`
  - `避免追高，等回測確認`
- Updated `worker/src/lib/recommendationContext.test.ts` to reject internal labels:
  - `POC`
  - `fair_value`
  - `optimistic_value`
  - `optimistic_status`
  - `above_fair_value`
- Added `frontend/src/lib/tradingPlanLevels.ts` as the deterministic OHLCV level owner:
  - swing high resistance
  - swing low support
  - volume node
  - ATR upper/lower band
  - MA20/MA60
- Updated `frontend/src/components/CandlestickChart.tsx` to overlay:
  - 前高壓力
  - 關鍵支撐
  - 量能節點
  - ATR 防守
  - ATR band
  - Parabolic SAR
  - 三大法人淨買賣超 histogram
- Added `frontend/src/lib/chipFlowSeries.ts` as the deterministic chip-flow display owner:
  - foreign/trust/dealer net normalization
  - total institutional net lots
  - buy/sell histogram color
  - latest chip-flow summary chips
  - broker-branch net normalization and 5-day summary
- Added read-only per-stock broker-flow path:
  - `worker/src/routes/stocks.ts` exposes `/api/stocks/:id/broker-flow?days=...`
  - query reads `canonical_broker_flow_daily` by symbol-bound `stock_id`
  - optional missing canonical table fails soft with `[]`
  - `frontend/src/lib/api.ts` exposes `stocksApi.brokerFlow`
- Updated `frontend/src/components/CandlestickChart.tsx` to add a broker-branch flow line and summary chips in the same lower flow pane.
- Moved queued `/optuna/per_regime` off the long HTTP request path:
  - `worker/src/lib/controllerResearchWorkflows.ts` now calls `/optuna/per_regime/run` for queued per-regime items
  - trigger source is mapped from `regime_shift` / `sharpe_rolling` / `dd_spike` / `manual`
  - per-regime queue trigger timeout is capped to 60s because the Job owns the long lifecycle
  - `ml-controller/routers/optuna.py` exposes `/optuna/per_regime/run`
  - `ml-controller/optuna_job_main.py` supports `OPTUNA_JOB_KIND=per_regime`
- Added an env-gated Modal executor for queued per-regime research:
  - `ml-service/modal_app.py` exposes `optuna_per_regime_robust`
  - Modal image mounts `ml-controller/optuna_scripts` and `ml-controller/services`
  - Modal completion posts Worker `/api/admin/scheduler-callback` with `task=optuna-queue`
  - `ml-controller/services/modal_client.py` exposes `spawn_optuna_per_regime()`
  - `/optuna/per_regime/run` uses Modal only when `OPTUNA_PER_REGIME_EXECUTOR=modal`; default remains Cloud Run Job fallback
  - Worker queue processor now records `execution_id`, `function_call_id`, or `run_id` as async trigger evidence
- Hardened `worker/src/lib/optunaQueue.ts`:
  - idempotency key is now target/reason/regime/day instead of only reason/day
  - event triggers get KV cooldown metadata and TTL
  - queue entries carry `trigger_source`
  - processor gets a short TTL KV run lock
- Added D1-backed strong locks for queued per-regime research:
  - `worker/src/lib/optunaQueue.ts` now reuses `scheduler_locks`
  - processor lock key: `optuna-queue:processor`
  - per-run lock key: `optuna:run:<entry.id>`
  - locks are acquired through `INSERT ... ON CONFLICT(lock_key) DO UPDATE ... WHERE expires_at <= created_at`
  - `worker/src/lib/controllerResearchWorkflows.ts` now takes the D1 processor lock before the KV lock
  - queued per-regime entries take a D1 run lock before calling `/optuna/per_regime/run`
  - async run locks are intentionally TTL-based so duplicate queue drains cannot retrigger while Modal/Job is still running
- Added callback-side run closure/readback for queued per-regime research:
  - `worker/src/lib/optunaRunClosure.ts` closes `optuna:run:<run_id>` on terminal `optuna-queue` callback
  - callback business date resolves from explicit `run_date`, then from `run_id`, then TW today
  - callback writes an R2 scheduler report artifact via `recordSchedulerRunReportArtifact`
  - `worker/src/routes/adminControlRoutes.ts` returns `optuna_closure` in scheduler callback response
  - `ml-service/modal_app.py` and `ml-controller/optuna_job_main.py` now include structured callback metadata: executor, trigger source/id, robust Sharpe, weighted metrics, trial counts, regime coverage, warnings, and window
- Started Phase 4 backtest owner convergence:
  - `ml-controller/services/backtest_engine.py` now builds a partial Score V2 screener payload for each replay candidate
  - Python `score_multi_factor()` / `score_multi_factor_np()` now return partial Score V2 total as `base_score`
  - cross-section calibration refreshes the candidate Score V2 payload after chip/technical/momentum seed scores change
  - replay and diagnostic ranking now use `_candidate_screener_norm()` from Score V2 `chipFlow + technicalStructure`
  - added `ml-controller/tests/test_backtest_score_v2_ranking_contract.py` and updated `test_screener_parity.py` to guard momentum folding, calibration sync, Score V2 base score, and the old chip+tech denominator formula
- Continued Phase 4 Worker screener owner convergence:
  - `worker/src/lib/marketScreener.ts` now sets `base_score` from partial Score V2 total instead of legacy chip+tech+momentum sum
  - `worker/src/lib/screenerPolicy.ts` calibration now updates `candidate.score` from the refreshed Score V2 payload
  - `worker/src/lib/screenerSeedQuality.ts` now prefers canonical Score V2 `finalScore` for persisted screener seed score
  - updated contracts in `marketScreenerScoreV2Contract.test.ts`, `screenerPolicy.test.ts`, and `screenerSeedQuality.test.ts`
- Continued Phase 4 deprecated denominator cleanup:
  - `screenerDenominator` remains only in Worker/Python config shapes for older KV/config compatibility
  - `ml-controller/services/backtest_engine.py` documents `screener_denominator` as deprecated compatibility and runtime replay/diagnostic paths ignore it
  - `worker/src/lib/tradingConfig.ts` documents the same boundary so future config readers do not treat it as the Score V2 owner
  - Python and Worker contracts now fail if runtime screener ranking restores the legacy denominator or chip+tech+momentum owner
- Removed dead legacy scorer owner:
  - deleted unused tracked `worker/src/lib/screenerPercentile.ts`, which still implemented an independent chip/tech/liquidity `total_score`
  - `worker/src/lib/screenerOwnerContract.test.ts` now fails if the legacy percentile scorer file or imports return
- Tightened controller Score V2 parity:
  - confirmed `ml-controller/services/recommendation_service.py` requires canonical screener `score_components` before building final recommendations
  - changed controller `_round1()` / `calculate_ml_score()` to use Worker-compatible `Math.round`-style half-up semantics instead of Python banker's rounding
  - `test_recommendation_provenance.py` now guards this rounding behavior together with canonical Score V2 provenance
- Tightened recommendation ranking promotion owner:
  - `hybrid_ranking_promotion()` now requires canonical Score V2 `score_components` for screener normalization
  - ranking promotion no longer accepts `score_seed_inputs` as a downstream fallback score source
  - `test_recommendation_provenance.py` now fails closed when promotion rows lack canonical Score V2 components
- Aligned Score V2 presentation rounding:
  - `llm_reason.py`, `llm_service.py`, and `obsidian_writer.py` now use Worker-compatible one-decimal rounding
  - LLM prompt and Obsidian display contracts guard against Python banker's rounding drift
- Started Phase 5 fundamental quality scorer:
  - added `ml-controller/services/fundamental_quality.py` as a pure, read-only 0-20 scorer
  - monthly revenue rows are filtered by conservative availability date via `monthly_revenue_available_date()`
  - quarterly financial rows require explicit availability/report/as-of dates or conservative quarter-end + 60 day lag
  - `financials.created_at` is not treated as a report availability date; period lag remains the fallback guard
  - subcomponents cover revenue momentum, profitability, valuation, financial safety, and industry-relative quality
  - `build_score_components()` can consume `fundamental_quality.score` into Score V2 `fundamentalQuality`
- Wired Phase 5 into the local daily recommendation path:
  - `load_fundamental_quality_by_symbol()` read-only loads `canonical_revenue_monthly`
  - added `worker/migration_score_v2_fundamental_quality.sql` for `canonical_fundamental_features`
  - `finlab_canonical_materializer.py` now materializes flexible FinLab fundamental factor artifacts into canonical rows
  - `tools/finlab_v4_remote_backfill.py` supports explicit `FINLAB_FUNDAMENTAL_FACTOR_KEYS_JSON` for operator-approved paid-plan factor keys
  - canonical fundamental rows use `available_date`; statement-style fields fall back to conservative quarter-end + 60 days
  - recommendation scoring now prefers `canonical_fundamental_features` and only falls back to legacy `financials` if canonical rows are absent
  - missing canonical tables fail soft and leave `fundamentalQuality` at 0 instead of breaking the pipeline
  - `daily_pipeline_v2.node_recommend` passes the per-symbol quality payload into `filter_and_score_recommendations()`
- Advanced Phase 6 news/theme contract:
  - Worker screener now routes positive news sentiment and buzz evidence through Score V2 `newsTheme`
  - positive news/theme contribution is capped at the taxonomy max of 5 points
  - negative news sentiment now records `negative_news_sentiment` risk flag and lowers Score V2 `finalScore`
  - runtime `theme_signals` ignores rows older than 14 days instead of silently using stale theme evidence
  - high-confidence official/company IR major-negative evidence now triggers screener veto via `external_evidence_risk`
  - non-veto external risk evidence lowers Score V2 `finalScore` through risk adjustment instead of pretending it is only a 5-point news/theme issue
- Started Phase 8 rollout/read-only observation:
  - added `score_v2_replay_audit.py` as a pure read-only comparer for legacy scalar `score` vs canonical Score V2 `finalScore/total`
  - added `score_v2_readonly_replay_report.py` CLI for offline JSON or D1 read-only report export
  - report includes top-N overlap, rank drift rows, Score V2 coverage, component averages, missing payload count, and risk flag counts
  - live read-only D1 export for latest `daily_recommendations` date `2026-05-22` returned 64 rows with `rows_written=0` / `changed_db=false`
  - live replay audit output: Score V2 coverage 1.0, top10 overlap 1.0, missing Score V2 0, drift rows 0
  - live component averages show `fundamentalQuality=0.0` and `newsTheme=0.0`, so Phase 5/6 production materialization/readback remains necessary
  - added `evaluate_score_v2_rollout_gate()` as a pure read-only fail-closed gate for owner-switch readiness
  - `score_v2_readonly_replay_report.py --gate --fail-on-block` now emits `rollout_gate` and returns non-zero when readiness is blocked
  - latest live replay gate output was saved to `.tmp/score_v2_latest_replay_gate.json`
  - current gate decision is `BLOCK` only because `component_nonzero_fundamentalQuality` and `component_nonzero_newsTheme` failed; coverage/top overlap/missing payload/drift checks passed
- Added Score V2 contribution readiness diagnostics:
  - `score_v2_contribution_readiness.py` evaluates production readiness for `fundamentalQuality` and `newsTheme`
  - `score_v2_contribution_readiness_report.py` supports offline JSON, Cloud Run env-backed D1, and local `--wrangler` read-only D1 query mode
  - live read-only production D1 inventory confirmed `canonical_fundamental_features` table is missing
  - live input readiness confirmed news/theme inputs exist (`theme_signals`, `stock_theme_features`, `external_evidence_items`, recent `news`) and screener funnel has `buzz_evidence`
  - latest daily recommendations still have `fundamentalQuality=0/64` and `newsTheme=0/64`
  - readiness report decision is `BLOCK` with root causes `canonical_fundamental_features_missing`, `fundamental_quality_live_zero`, `news_theme_handoff_missing`
  - strengthened Worker seed-row contract to prove repo code preserves already-applied `score_components.components.newsTheme` and buzz reasons into `daily_recommendations` seed payloads
- Added Score V2 newsTheme handoff preflight:
  - `score_v2_news_theme_handoff.py` evaluates repo contract scan plus an existing read-only contribution readiness snapshot
  - `score_v2_news_theme_handoff_report.py` inspects Worker/controller source contracts without querying or writing production
  - repo contracts pass for Worker newsTheme adjustment, `score_components` persistence, seed-row preservation, and Python projection
  - latest handoff report was saved to `.tmp/score_v2_news_theme_handoff.json`
  - current decision is `WAITING_DEPLOY`; `allowed_next_action=deploy_worker_and_rerun_screener_after_approval`
- Added Score V2 fundamental migration preflight:
  - `score_v2_fundamental_migration_preflight.py` validates the migration file and live schema without applying D1 changes
  - checks required table, columns, indexes, primary key, and absence of destructive SQL
  - CLI supports offline JSON, Cloud Run env-backed D1, and local `--wrangler` read-only mode
  - live read-only preflight output was saved to `.tmp/score_v2_fundamental_migration_preflight.json`
  - current decision is `READY_TO_APPLY`; `allowed_next_action=request_wei_approval_before_apply`

## Verified

- `node_modules\.bin\esbuild.cmd src\lib\technicalIndicators.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\technicalIndicators.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\technicalIndicatorsV2Contract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\technicalIndicatorsV2Contract.test.cjs`
- `node ..\.tmp\technicalIndicators.test.cjs`
- `node ..\.tmp\technicalIndicatorsV2Contract.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\scoreV2FactorIcContract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\scoreV2FactorIcContract.test.cjs`
- `node ..\.tmp\scoreV2FactorIcContract.test.cjs`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_technical_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_snapshot_loader.py ml-controller\tests\test_research_data_access_contract.py ml-controller\tests\test_weekly_audit_score_v2_contract.py ml-controller\tests\test_score_v2_technical_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\backtest_engine.py ml-controller\services\dataset_snapshot_exporter.py ml-controller\graphs\weekly_audit_graph.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_weekly_audit_score_v2_contract.py ml-controller\tests\test_backtest_snapshot_loader.py ml-controller\tests\test_research_data_access_contract.py ml-controller\tests\test_score_v2_technical_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\graphs\weekly_audit_graph.py ml-controller\services\backtest_engine.py ml-controller\services\dataset_snapshot_exporter.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_score_v2_ranking_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_alpha_framework.py ml-controller\tests\test_backtest_score_v2_ranking_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_recommendation_provenance.py::test_filter_and_score_preserves_canonical_screener_base_without_legacy_scalars ml-controller\tests\test_recommendation_provenance.py::test_build_reason_does_not_synthesize_score_v2_from_legacy_scalars ml-controller\tests\test_recommendation_provenance.py::test_filter_and_score_requires_canonical_screener_score_components -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_alpha_framework.py ml-controller\tests\test_backtest_score_v2_ranking_contract.py ml-controller\tests\test_research_data_access_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\backtest_engine.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_score_v2_ranking_contract.py ml-controller\tests\test_backtest_alpha_framework.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe ml-controller\tests\test_screener_parity.py --mode local`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\backtest_engine.py ml-controller\tests\test_screener_parity.py`
- `node_modules\.bin\esbuild.cmd src\lib\marketScreenerScoreV2Contract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\marketScreenerScoreV2Contract.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\screenerPolicy.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\screenerPolicy.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\screenerSeedQuality.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\screenerSeedQuality.test.cjs`
- `node ..\.tmp\marketScreenerScoreV2Contract.test.cjs`
- `node ..\.tmp\screenerPolicy.test.cjs`
- `node ..\.tmp\screenerSeedQuality.test.cjs`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_score_v2_ranking_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\backtest_engine.py ml-controller\services\trading_config_loader.py`
- `node_modules\.bin\esbuild.cmd src\lib\marketScreenerScoreV2Contract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `node ..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `npm run type-check -- --pretty false` from `worker`
- `node_modules\.bin\esbuild.cmd src\lib\screenerOwnerContract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\screenerOwnerContract.test.cjs` from `worker`
- `node ..\.tmp\screenerOwnerContract.test.cjs` from `worker`
- `npm run type-check -- --pretty false` from `worker`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_recommendation_provenance.py::test_score_v2_rounding_matches_worker_math_round_semantics ml-controller\tests\test_recommendation_provenance.py::test_filter_and_score_requires_canonical_screener_score_components ml-controller\tests\test_recommendation_provenance.py::test_filter_and_score_preserves_canonical_screener_base_without_legacy_scalars ml-controller\tests\test_recommendation_provenance.py::test_build_reason_does_not_synthesize_score_v2_from_legacy_scalars -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\recommendation_service.py ml-controller\tests\test_recommendation_provenance.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_recommendation_provenance.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_recommendation_provenance.py::test_hybrid_ranking_promotion_marks_signal_source ml-controller\tests\test_recommendation_provenance.py::test_hybrid_ranking_promotion_blocks_negative_forecast ml-controller\tests\test_recommendation_provenance.py::test_hybrid_ranking_promotion_skips_when_controller_policy_already_applied ml-controller\tests\test_recommendation_provenance.py::test_hybrid_ranking_promotion_uses_alpha_policy_slate_size ml-controller\tests\test_recommendation_provenance.py::test_hybrid_ranking_promotion_requires_canonical_score_v2_components -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_recommendation_provenance.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_llm_reason_score_v2_contract.py ml-controller\tests\test_score_v2_legacy_recommend_obsidian.py ml-controller\tests\test_obsidian_writer_score_v2_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\llm_reason.py ml-controller\services\llm_service.py ml-controller\services\obsidian_writer.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_score_v2_ranking_contract.py ml-controller\tests\test_recommendation_provenance.py ml-controller\tests\test_llm_reason_score_v2_contract.py ml-controller\tests\test_score_v2_legacy_recommend_obsidian.py ml-controller\tests\test_obsidian_writer_score_v2_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_fundamental_quality.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\fundamental_quality.py ml-controller\services\recommendation_service.py ml-controller\tests\test_fundamental_quality.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_technical_contract.py ml-controller\tests\test_recommendation_provenance.py ml-controller\tests\test_fundamental_quality.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\fundamental_quality.py ml-controller\services\recommendation_service.py ml-controller\graphs\daily_pipeline_v2.py ml-controller\tests\test_fundamental_quality.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_technical_contract.py ml-controller\tests\test_recommendation_provenance.py ml-controller\tests\test_fundamental_quality.py ml-controller\tests\test_daily_pipeline_screener_contract.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_fundamental_quality.py ml-controller\tests\test_recommendation_provenance.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\fundamental_quality.py ml-controller\services\recommendation_service.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_backtest_score_v2_ranking_contract.py ml-controller\tests\test_recommendation_provenance.py ml-controller\tests\test_fundamental_quality.py ml-controller\tests\test_llm_reason_score_v2_contract.py ml-controller\tests\test_score_v2_legacy_recommend_obsidian.py ml-controller\tests\test_obsidian_writer_score_v2_contract.py ml-controller\tests\test_daily_pipeline_screener_contract.py -q -p no:cacheprovider`
- `node ..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `node ..\.tmp\screenerOwnerContract.test.cjs` from `worker`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\backtest_engine.py ml-controller\services\trading_config_loader.py ml-controller\services\recommendation_service.py ml-controller\services\fundamental_quality.py ml-controller\services\llm_reason.py ml-controller\services\llm_service.py ml-controller\services\obsidian_writer.py ml-controller\graphs\daily_pipeline_v2.py`
- `node_modules\.bin\esbuild.cmd src\lib\marketScreenerScoreV2Contract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `node_modules\.bin\esbuild.cmd src\lib\screenerOwnerContract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\screenerOwnerContract.test.cjs` from `worker`
- `node ..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `node ..\.tmp\screenerOwnerContract.test.cjs` from `worker`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\backtest_engine.py ml-controller\services\trading_config_loader.py ml-controller\services\recommendation_service.py ml-controller\services\llm_reason.py ml-controller\services\llm_service.py ml-controller\services\obsidian_writer.py`
- `node_modules\.bin\esbuild.cmd src\lib\screenerOwnerContract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\screenerOwnerContract.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\scoreV2StrategyCandidatePoolContract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\scoreV2StrategyCandidatePoolContract.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\strategyCandidatePool.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\strategyCandidatePool.test.cjs`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_finlab_canonical_materializer.py ml-controller\tests\test_fundamental_quality.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\finlab_canonical_materializer.py ml-controller\services\recommendation_service.py ml-controller\services\fundamental_quality.py tools\finlab_canonical_materialize.py tools\finlab_v4_remote_backfill.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_finlab_canonical_materializer.py ml-controller\tests\test_fundamental_quality.py -q -p no:cacheprovider` (21 passed)
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\finlab_canonical_materializer.py tools\finlab_v4_remote_backfill.py`
- `node_modules\.bin\esbuild.cmd src\lib\marketScreenerScoreV2Contract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `node_modules\.bin\esbuild.cmd src\lib\multiSourceThemeEvidence.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\multiSourceThemeEvidence.test.cjs` from `worker`
- `npm run type-check -- --pretty false` from `worker`
- `node ..\.tmp\marketScreenerScoreV2Contract.test.cjs` from `worker`
- `node ..\.tmp\multiSourceThemeEvidence.test.cjs` from `worker`
- `node_modules\.bin\esbuild.cmd src\lib\newsThemeRiskOverlay.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\newsThemeRiskOverlay.test.cjs` from `worker`
- `node ..\.tmp\newsThemeRiskOverlay.test.cjs` from `worker`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_readonly_replay_audit.py -q -p no:cacheprovider`
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\score_v2_replay_audit.py ml-controller\scripts\score_v2_readonly_replay_report.py ml-controller\tests\test_score_v2_readonly_replay_audit.py`
- `npx wrangler@4 d1 execute stockvision-db --remote --json --command "SELECT date, symbol, name, rank, score, score_components, signal, confidence, industry, recommendation_lane FROM daily_recommendations WHERE date = (SELECT MAX(date) FROM daily_recommendations) ORDER BY rank ASC LIMIT 200;"` from `worker` (read-only; rows_written=0; changed_db=false)
- `ml-controller\.venv\Scripts\python.exe ml-controller\scripts\score_v2_readonly_replay_report.py --input-json .tmp\score_v2_latest_recommendations_wrangler.json --output-json .tmp\score_v2_latest_replay_audit.json --top-n 10`
- `.tmp\score_v2_latest_replay_audit.json`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_readonly_replay_audit.py -q -p no:cacheprovider` (6 passed)
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\score_v2_replay_audit.py ml-controller\scripts\score_v2_readonly_replay_report.py ml-controller\tests\test_score_v2_readonly_replay_audit.py`
- `ml-controller\.venv\Scripts\python.exe ml-controller\scripts\score_v2_readonly_replay_report.py --input-json .tmp\score_v2_latest_recommendations_wrangler.json --output-json .tmp\score_v2_latest_replay_gate.json --gate --fail-on-block` (expected BLOCK/non-zero; saved read-only gate report)
- `.tmp\score_v2_latest_replay_gate.json`
- `npx wrangler@4 d1 execute stockvision-db --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN (...)"` from `worker` (read-only; confirmed `canonical_fundamental_features` missing)
- `npx wrangler@4 d1 execute stockvision-db --remote --json --command "SELECT ... theme/news/fundamental inventory ..."` from `worker` (read-only; rows_written=0)
- `npx wrangler@4 d1 execute stockvision-db --remote --json --command "SELECT ... daily component nonzero counts ..."` from `worker` (read-only; latest 10 recommendation dates all `fundamental_nonzero=0`, `news_nonzero=0`)
- `npx wrangler@4 d1 execute stockvision-db --remote --json --command "SELECT ... screener_funnel_items ... buzz_evidence ..."` from `worker` (read-only; latest buzz evidence exists)
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_contribution_readiness.py ml-controller\tests\test_score_v2_readonly_replay_audit.py -q -p no:cacheprovider` (10 passed)
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\score_v2_contribution_readiness.py ml-controller\scripts\score_v2_contribution_readiness_report.py ml-controller\tests\test_score_v2_contribution_readiness.py ml-controller\services\score_v2_replay_audit.py ml-controller\scripts\score_v2_readonly_replay_report.py ml-controller\tests\test_score_v2_readonly_replay_audit.py`
- `ml-controller\.venv\Scripts\python.exe ml-controller\scripts\score_v2_contribution_readiness_report.py --wrangler --output-json .tmp\score_v2_contribution_readiness.json --fail-on-block` (expected BLOCK/non-zero; saved read-only readiness report)
- `.tmp\score_v2_contribution_readiness.json`
- `node_modules\.bin\esbuild.cmd src\lib\screenerSeedQuality.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\screenerSeedQuality.test.cjs` from `worker`
- `node ..\.tmp\screenerSeedQuality.test.cjs` from `worker`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_fundamental_migration_preflight.py ml-controller\tests\test_score_v2_contribution_readiness.py ml-controller\tests\test_score_v2_readonly_replay_audit.py -q -p no:cacheprovider` (16 passed)
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\score_v2_fundamental_migration_preflight.py ml-controller\scripts\score_v2_fundamental_migration_preflight.py ml-controller\tests\test_score_v2_fundamental_migration_preflight.py`
- `ml-controller\.venv\Scripts\python.exe ml-controller\scripts\score_v2_fundamental_migration_preflight.py --wrangler --output-json .tmp\score_v2_fundamental_migration_preflight.json --fail-on-block` (read-only; decision `READY_TO_APPLY`)
- `.tmp\score_v2_fundamental_migration_preflight.json`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_news_theme_handoff.py -q -p no:cacheprovider` (5 passed)
- `ml-controller\.venv\Scripts\python.exe -m py_compile ml-controller\services\score_v2_news_theme_handoff.py ml-controller\scripts\score_v2_news_theme_handoff_report.py ml-controller\tests\test_score_v2_news_theme_handoff.py`
- `ml-controller\.venv\Scripts\python.exe ml-controller\scripts\score_v2_news_theme_handoff_report.py --contribution-readiness-json .tmp\score_v2_contribution_readiness.json --output-json .tmp\score_v2_news_theme_handoff.json` (read-only; decision `WAITING_DEPLOY`)
- `.tmp\score_v2_news_theme_handoff.json`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_news_theme_handoff.py ml-controller\tests\test_score_v2_contribution_readiness.py ml-controller\tests\test_score_v2_readonly_replay_audit.py ml-controller\tests\test_score_v2_fundamental_migration_preflight.py -q -p no:cacheprovider` (21 passed)
- `node ..\.tmp\screenerOwnerContract.test.cjs`
- `node ..\.tmp\scoreV2StrategyCandidatePoolContract.test.cjs`
- `node ..\.tmp\strategyCandidatePool.test.cjs`
- `npm run type-check -- --pretty false` from `worker`
- `node ..\.tmp\recommendationContext.test.cjs`
- `node ..\.tmp\scoreV2FactorIcContract.test.cjs`
- `ml-service\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_score_v2_technical_contract.py -q`
- `node ..\.tmp\tradingPlanLevels.test.cjs`
- `node ..\.tmp\chipFlowSeries.test.cjs`
- `node ..\.tmp\brokerFlowRouteContract.test.cjs`
- `node ..\.tmp\optunaPerRegimeJobContract.test.cjs`
- `node ..\.tmp\optunaQueue.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\optunaQueue.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\optunaQueue.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\optunaPerRegimeJobContract.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\optunaPerRegimeJobContract.test.cjs`
- `node_modules\.bin\esbuild.cmd src\lib\optunaRunClosure.test.ts --bundle --platform=node --format=cjs --outfile=..\.tmp\optunaRunClosure.test.cjs`
- `node ..\.tmp\optunaQueue.test.cjs`
- `node ..\.tmp\optunaPerRegimeJobContract.test.cjs`
- `node ..\.tmp\optunaRunClosure.test.cjs`
- `ml-service\.venv\Scripts\python.exe -m py_compile .\ml-service\modal_app.py .\ml-controller\services\modal_client.py .\ml-controller\routers\optuna.py .\ml-controller\optuna_job_main.py`
- `ml-service\.venv\Scripts\python.exe -m py_compile .\ml-service\modal_app.py .\ml-controller\optuna_job_main.py`
- `ml-controller\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_modal_client_telemetry.py ml-controller\tests\test_research_data_access_contract.py`
- `npm run type-check -- --pretty false` from `worker`
- `npm run build` from `frontend`

Note: `npm run test -- src/lib/recommendationContext.test.ts` is not available because `worker/package.json` has no `test` script.
Note: `ml-service\.venv` lacked `httpx` for `test_modal_client_telemetry.py`; the same controller tests passed under `ml-controller\.venv`.
Note: an earlier `npm run type-check -- --pretty false` re-run had failed on unrelated dirty file `worker/src/routes/adminOptunaRoutes.ts` (`GAPromotionDecision` is not assignable to `JsonRecord`), but the latest Worker type-check after this pass completed successfully.
Rendered browser QA note: local Vite dev server opened on `http://127.0.0.1:5178/dashboard`; 2330 `籌碼技術` tab rendered the chart section without crashing, but local API returned `暫無 K 線資料` / `暫無籌碼資料`. After the broker-flow endpoint change, `http://127.0.0.1:5179/dashboard` opened but Browser selection timed out before reaching the stock tab. Real-data chart QA is still not claimed.
