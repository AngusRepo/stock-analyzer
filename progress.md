# Progress

## Session 2026-04-22 - V2 Regression Baseline

### What this session is doing
1. Convert the deep review findings into an executable regression baseline.
2. Run the first smoke pass across Worker, Frontend, ml-controller, and ml-service.
3. Record blockers before touching production code.

### Constraints
- No deploy / retrain / commit / push / real trading.
- Prefer repo-native validation commands first.
- Future formal production try must use offline gate -> paper/shadow AB -> promotion gate -> tiny canary, not direct full-production AB.

## P1 ML Remaining Work

### Current slice
- Harden promotion gate inputs before any production promote: Mode B backtest, Monte Carlo tail-risk, CSCV rank-logit PBO, and shadow/paper evidence must all be explicit.
- Done: upgrade Monte Carlo from legacy IID shuffle to block bootstrap so clustered loss/regime streaks are not washed out by random permutation.
- Done: wire production promotion gate into `model_pool/promote_check`; promote actions now fail closed when Mode B/Monte Carlo/PBO gate is missing or failed.
- Done: add verified shadow IC AB gate for model challengers; `promote_check` now requires per-model challenger evidence before promote.
- Done: promotion gate now rejects legacy IID Monte Carlo rows; production promote requires `block_bootstrap` risk simulation evidence.
- Done: Monte Carlo now supports `regime_block_bootstrap` when backtest raw provides regime labels; otherwise it falls back to regular block bootstrap.
- Done: promotion backtest normalization ignores loose `backtest_results.mode`; only `raw_results.mode` is trusted for Mode B promotion evidence.
- Done: `/backtest/replay` can persist promotion-grade replay rows to D1 only with explicit `persist_results=true` and `persist_confirm=true`; persisted raw includes Mode B provenance, all returns, regimes, and partitions.
- Done: add paper/order-level AB gate for model challengers; `promote_check` now requires actual paper buy/order-mapped active vs challenger evidence before promote.
- Done: require Worker paper-execution parity evidence in promotion backtest rows; `raw_results.parity_audit.worker_parity.decision` must be `PASS` or promotion fails closed.
- Done: make active L2 Optuna guardrails policy/env-driven; min trades, drawdown penalty, PBO candidate cap, and PBO min partitions are no longer buried as fixed script constants.
- Done: centralize legacy Optuna route data sufficiency/sample bounds in `OptunaRoutePolicy`; barrier/signal/conformal/risk/rrg/feature-window loaders now use env-overridable policy and include policy metadata in KV push audits.
- Done: classify Optuna script-level search-space defaults in `OptunaScriptContract`; route contracts now expose production effect, range role, push target, and whether external gates are required.

### Remaining P1 items
- No open P0/P1 local remediation item in the current local scope; full dependency integration testing and prod deploy completed on 2026-04-26.

### Future optimization backlog
- Add Cloudflare R2/GCS data-lake tier for cold historical OHLCV, indicators, chip/margin/shareholding snapshots, monthly retrain datasets, and backtest partitions.
- Keep D1 as hot OLTP/index store: latest dashboard data, recommendations, predictions, paper trading state, manifests, and promotion audit rows.
- Add a D1 manifest table for lake objects before deleting or retaining less D1 history; first phase should mirror cold data only, not remove D1 rows.
- Evaluate D1 paid capacity as max-per-DB vs included storage separately: single DB max can be 10GB, but included paid storage is lower and overage still matters.
- P10 follow-up: add full paper/live parity tests before enabling real broker orders; current gate covers paper execution realism and quote-aware fill behavior.
- P10 follow-up: design the live order adapter around the same state machine as paper trading, including submitted/requoted/partially_filled/filled/skipped/cancelled/expired/rejected.
- P10 follow-up: upgrade partial-fill remaining policy v2 with re-quote rules, price drift guard, session cutoff, and remaining-size cancellation thresholds.

### Pending execution
- Worker type-check
- Frontend build
- Python compile smoke
- Live contract / D1 checks

### Execution results
- Worker `npm run type-check`: PASS
- Frontend `npm run build`: PASS after rerunning outside sandbox
- `ml-controller` py_compile smoke: PASS
- `ml-service` py_compile smoke: PASS
- Cloudflare D1 remote query: PASS
- GCP `ml-controller` describe: PASS
- Modal profile/app list: PASS
- 2026-04-26 integration smoke: `ml-service/tests` PASS (`66 passed, 3 skipped`); `ml-controller/tests` full collection is blocked in the current local env by missing `fastapi/httpx` in the test runner, while P1 targeted suite PASS (`63 passed`).
- 2026-04-26 integration smoke: Worker `npm run type-check` PASS; Frontend `npm run build` PASS; controller/service recursive `py_compile` PASS.
- 2026-04-26 live smoke: GCP auth + `ml-controller` service describe PASS; Modal profile/app list PASS; Cloudflare Wrangler and Cloudflare MCP both require re-auth before D1 remote verification can be repeated.
- 2026-04-26 follow-up: fixed local `ml-controller` test environment (`pytest`, `pytest-asyncio`, `fastapi`, `uvicorn`, `google-cloud-storage`); full controller suite PASS (`153 passed, 15 skipped`).
- 2026-04-26 follow-up: cleared stale Wrangler token with `wrangler logout`, completed OAuth login, `wrangler whoami` PASS, and remote D1 `SELECT 1 AS ok` PASS.
- 2026-04-26 prod deploy: deployed `ml-controller` Cloud Run service revision `ml-controller-00171-9g9`; manually synced `pipeline-v2` and `verify-v2` jobs to image `sha256:760f5b68e55bc75d8c1e6267a00f1f97005afd7ed29c26d8a273e685b2d1a355` after the deploy script hit a Windows CR service-account parsing issue.
- 2026-04-26 prod deploy: deployed Modal `stockvision-ml` (FastAPI `https://wayne60619--stockvision-ml-fastapi-app.modal.run`), Cloudflare Worker version `f2f81b8b-b482-4d58-b64d-c504a7c46349`, and Cloudflare Pages `stockvision-frontend` on branch `main`.
- 2026-04-26 post-deploy smoke: D1 remote `SELECT 1 AS ok` PASS; Worker `/api/health`, Frontend home, Modal `/health`, and Controller `/health` all returned HTTP 200 via Node fetch.
- 2026-04-26 final check: controller tests PASS (`153 passed, 15 skipped`); ml-service tests PASS (`66 passed, 3 skipped`); Worker type-check PASS.

### Notable observations
- Frontend build issue inside sandbox was environmental (`spawn EPERM`), not a code failure.
- D1 still contains the historical 3-prediction failure pattern on `2026-04-12/13/15/16`.
- `daily_recommendations` can stay visually stable while prediction writes are degraded, so future regression checks must include raw prediction counts.

### Fixes executed
1. Patched Worker proxy contract to send auth headers and added `/snapshot/{symbol}` fallback path.
2. Patched `morning-setup` to bind ensemble predictions to the same TW trading date.
3. Tightened admin read routes with shared `requireAdminOrServiceToken()` gate.
4. Fixed momentum gate average-volume SQL to use a recent-20-row subquery.
5. Fixed scheduler named-DOW parsing and corrected heatmap job id.
6. Stabilized `ml-service` predict-time chip schema so the 9 chip-derived V2 features always exist even when `chips=[]`.
7. Removed prod-biased config fallbacks from controller/service/script entry points and made the critical paths env-driven.
8. Revalidated the frontend mojibake finding against current source; it does not reproduce on this snapshot.
9. Removed the last `config_pool` canonical worker fallback and normalized the remaining `SchedulerPage` status label.

### Post-fix verification
- Worker `npm run type-check`: PASS
- `ml-service` `py_compile`: PASS
- `build_feature_matrix(..., chips=[])` smoke regression: PASS (`missing=[]`, `count=0`)
- `ml-controller` / script `py_compile`: PASS
- `config_pool.py` `py_compile`: PASS
- frontend `npm run build`: PASS after final label cleanup
