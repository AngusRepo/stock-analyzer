# Findings

## V2 Regression Baseline

### Available validation entry points
- `worker/package.json` 目前只有 `type-check`，沒有正式 test runner。
- `frontend/package.json` 目前只有 `build`，沒有 Vitest / Playwright / Jest 設定。
- Python 兩個服務都有 `.pytest_cache` 痕跡，但 repo root 沒有清楚的 top-level pytest entrypoint；這代表測試曾跑過，但不是現在這個 repo 的穩定 baseline。

### High-value baseline order
1. 先跑靜態檢查：Worker type-check、Frontend build、Python compile smoke。
2. 再驗高風險 live contract：proxy contract、D1 data-shape、scheduler status source-of-truth。
3. 最後才開始修 review findings，避免邊修邊猜。

### Smoke results
- Worker `npm run type-check`: pass
- Frontend `npm run build`: pass outside sandbox; sandbox build was blocked by `vite/esbuild` child-process `spawn EPERM`, so that one was environment noise, not a repo build failure.
- `ml-controller` `py_compile`: pass for `main.py`, `routers/pipeline.py`, `services/cloud_run_jobs_client.py`, `services/modal_client.py`
- `ml-service` `py_compile`: pass for `app/main.py`, `app/features/__init__.py`, `app/kv_pusher.py`

### Live baseline results
- Cloudflare D1 remote query is healthy.
- GCP Cloud Run `ml-controller` service is describable and reachable in control plane.
- Modal profile and app listing are healthy.

### D1 data-shape checks
- `predictions` still shows the silent-failure signature from the earlier V2 break:
  - `2026-04-16`: 3 preds / 3 stocks
  - `2026-04-15`: 3 preds / 3 stocks
  - `2026-04-13`: 3 preds / 3 stocks
  - `2026-04-12`: 3 preds / 3 stocks
- Recent rows show the pipeline has since recovered and even expanded:
  - `2026-04-17`: 49 preds / 49 stocks
  - `2026-04-20`: 32 preds / 32 stocks
  - `2026-04-21`: 506 preds / 46 stocks
- `daily_recommendations` remains stable at 25 rows/day with 3 buy signals, which means recommendation output can look superficially healthy even when predictions were partially broken.

### Interpretation
- Static quality gates do not currently catch the most dangerous failures in this repo.
- The highest-value regression suite should therefore focus on data-shape and contract correctness, not only compilation/build status.

## Fixes Applied In This Session

### Worker high-risk fixes
- `worker/src/routes/paper.ts`
  - Proxy batch quote / snapshot calls now include `PROXY_SERVICE_TOKEN` auth headers.
  - `batchGetIntradayOHLC()` now falls back to per-symbol `GET /snapshot/{symbol}` before degrading to price-only `/quotes`.
  - `morning-setup` prediction join now constrains `predictions.generated_at` to the same TW date as `daily_recommendations.date`.
  - Momentum gate 20-day average volume SQL now averages over a limited recent subquery instead of full history.
- `worker/src/index.ts`
  - Added `requireAdminOrServiceToken()` helper.
  - Tightened admin read routes: debate A/B stats, scheduler status, costs today/month, cron logs, adaptive params.
- `worker/src/lib/schedulerStatus.ts`
  - Added named weekday parsing for cron expressions like `SUN-THU`.
  - Fixed heatmap job id from `rescore-10` to `intraday-rescore`.

### Verification after fixes
- `worker`: `npm run type-check` passed after the patches.
- `ml-service`: `py_compile` passed after the schema patch.
- `build_feature_matrix(..., chips=[])` smoke check now returns all 9 chip-derived V2 columns with `missing=[]`.
- `ml-controller` / script `py_compile` passed after env cleanup.
- `ml-controller/routers/config_pool.py` `py_compile` passed after removing the canonical worker fallback.
- frontend `npm run build` remained green after the final `SchedulerPage` text cleanup.

### Remaining work
- deeper config coverage audit for lower-priority scripts / services

### ml-service schema stabilization
- `ml-service/app/features/__init__.py`
  - Added a post-chip normalization block that always materializes the 9 chip-derived V2 columns:
    - `institutional_net`
    - `chip_5d`
    - `foreign_5d`
    - `dealer_5d`
    - `dealer_ratio_5d`
    - `margin_ratio`
    - `margin_change_5d_ts`
    - `short_change_5d`
    - `short_squeeze_proxy`
- This keeps predict-time feature schema stable for EG/US/no-chip symbols instead of letting them disappear and forcing the model loader to align from medians/zeros at inference time.

### env-driven config cleanup
- `ml-controller/main.py`, `ml-service/app/main.py`
  - CORS origins now resolve from `CORS_ALLOW_ORIGINS` or `STOCKVISION_WORKER_URL`, with localhost-safe dev defaults instead of a hidden prod URL fallback.
- `ml-controller/services/cloud_run_jobs_client.py`
  - Removed prod project/region/job defaults; `run_job()` now fails loudly if `GCP_PROJECT_ID`, `GCP_REGION`, or `PIPELINE_JOB_NAME` are missing.
- `ml-controller/routers/pipeline.py`
  - Worker callback now requires `STOCKVISION_WORKER_URL`; missing config logs a warning instead of silently targeting prod.
- `ml-controller/services/kv_pusher.py`, `ml-service/app/kv_pusher.py`
  - Worker KV pushers now use env-driven URLs with localhost-safe fallback instead of prod URL default.
- `ml-controller/services/debate_service.py`, `ml-controller/services/llm_debate_client.py`, `ml-controller/services/obsidian_writer.py`
  - Removed Cloudflare account / KV / D1 prod fallbacks; these paths now no-op safely when the required env vars are absent.
- `ml-controller/routers/config_pool.py`
  - Removed the last canonical prod worker URL fallback; config pool now requires `STOCKVISION_WORKER_URL` explicitly.
- `scripts/backfill_prices.py`, `scripts/backfill_chips_margin.py`, `scripts/backfill_delisted_stocks.py`
  - Replaced baked-in Cloudflare account/database IDs with env-driven config and explicit missing-config handling.

### frontend revalidation
- Re-checked `frontend/src/pages/BotDashboard.tsx` and `frontend/src/pages/SchedulerPage.tsx`.
- The earlier mojibake finding does not reproduce on the current source snapshot; build is green and the visibly broken strings from the review snapshot are no longer present in source.
- Cleaned the remaining awkward status label in `SchedulerPage` from `載入中/N-A` to `載入中 / N-A`.

### Known review findings to regress
- Plan A Shioaji proxy contract mismatch
- Morning setup prediction provenance bug
- Admin auth boundary inconsistency
- Momentum gate SQL bug
- Missing chips schema drift
- Scheduler next-run / heatmap mismatch
- Hardcoded production defaults
- Frontend mojibake
