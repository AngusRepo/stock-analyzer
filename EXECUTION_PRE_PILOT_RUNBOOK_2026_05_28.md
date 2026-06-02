# Execution Pre-Pilot Runbook - 2026-05-28

## Target State

Status: real execution loop with simulated paper orders, before Small
Real-Order Pilot.

This runbook covers the Phase 0 to Phase 6 execution lane. It is still
pre-pilot. It runs the real polling loop and real market-data readback, but it
must not submit, amend, cancel, or preview-submit a real broker order.

Non-negotiable boundary:

```text
live_submit_enabled = false
can_submit_real_order = false
real_order_pilot = not_started
```

## Phase Closure

| Phase | Status | Owner | Evidence |
|---|---|---|---|
| Phase 0 ownership | Implemented | Shared | StockVision keeps final decision; FinLab/Sinopac owns broker adapter evidence. |
| Phase 1 L5 market-data lane | Active | FinLab/Sinopac | `finlab_l5_market_data` event in `paper_execution_events`; `live_submit_enabled=false`. |
| Phase 2 10s production-simulated loop | Active | FinLab/Sinopac | `poll_seconds >= 10`, `rolling_bar_seconds >= 30`, Worker `intraday-check` paper-order trigger. |
| Phase 3 dynamic intraday technical gate | Active | StockVision | ATR, OBV temperature, Adaptive RSI, VWAP/reclaim state affect pre-trade gates. |
| Phase 4 adaptive execution gate | Active | StockVision | strategy-aware volume, range-position, chase, and L5 envelope thresholds. |
| Phase 5 FinLab execution preview | Deferred | FinLab/Sinopac | Disabled until a real broker preview factory exists; no live submit or preview-submit. |
| Phase 6 paper-broker reconciliation | Active | Shared | `paper_broker_reconciliation` event after simulated fill. |

## Feature Flags

Production-simulated mode:

```text
FINLAB_L5_MARKET_DATA_ENABLED=true
FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN=true
FINLAB_EXECUTION_LOOP_ENABLED=true
FINLAB_L5_ENVELOPE_GUARD_ENABLED=true
EXECUTION_WATCH_POOL_SIZE=10
EXECUTION_WATCH_MIN_ML_EDGE=12
EXECUTION_WATCH_MIN_FINAL_SCORE=55
EXECUTION_WATCH_RISK_MULTIPLIER=0.55
EXECUTION_CLOSE_WINDOW_MIN_VOLUME_RATIO=0.9
FINLAB_EXECUTION_PREVIEW_ENABLED=false
FINLAB_EXECUTION_PREVIEW_ALLOW_BROKER_LOGIN=false
FINLAB_EXECUTION_PREVIEW_GUARD_ENABLED=false
INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED=true
INTRADAY_TECHNICAL_BAR_INTERVAL_MS=30000
INTRADAY_TECHNICAL_BAR_LOOKBACK=40
INTRADAY_TECHNICAL_DISTRIBUTION_SKIP_MIN_BARS=60
```

Escalation order:

```text
1. Run `/finlab/execution/production-simulated-loop` with `dry_run=false`.
2. Use live Shioaji/FinLab market-data readback for L5 and quotes.
3. Keep all Worker decision gates active.
4. Insert simulated paper orders only.
5. Record evidence rows for L5 market data, intraday technical decision, and paper-broker reconciliation.
6. Keep FinLab execution preview disabled until a real broker preview factory exists.
7. Only after Wei approves, prepare Small Real-Order Pilot.
```

Do not enable:

```text
live submit
create_orders
update_order
cancel_order
real broker order callback ownership
```

## Runtime Surfaces

Worker:

```text
worker/src/lib/paperEntryTasks.ts
worker/src/lib/finlabL5MarketData.ts
worker/src/lib/finlabExecutionPreviewClient.ts
worker/src/lib/intradayTechnicalSnapshot.ts
worker/src/lib/executionAdaptivePolicy.ts
worker/src/lib/stockvisionOrderIntent.ts
worker/src/lib/paperBrokerReconciliation.ts
worker/src/lib/executionPrePilotReadiness.ts
```

ML controller:

```text
POST /finlab/execution/l5-market-data
POST /finlab/execution/preview
POST /finlab/execution/production-simulated-loop
```

The `/finlab/execution/production-simulated-loop` route has two modes:

```text
dry_run=true  -> return loop plan only
dry_run=false -> run bounded production-simulated loop and call Worker intraday-check
```

`dry_run=false` still uses simulated/paper orders only:

```text
paper_order_mode = worker_intraday_check
live_submit_enabled = false
can_submit_real_order = false
```

The Worker `intraday-check` path remains the decision and simulated order owner.
It performs Shioaji quote checks, FinLab L5 market-data readback, dynamic
technical decisions, pre-trade gates, active L5 envelope guard, and paper order
insertion.

Controller loop calls the Worker internal endpoint directly:

```text
POST /api/internal/execution/intraday-check
Authorization: Bearer <STOCKVISION_AUTH_TOKEN>
```

This endpoint is service-token protected and intentionally does not reuse
`/api/admin/trigger/:task`, because a 10-second loop would exceed the admin
trigger 100/hr rate limit. It still writes the canonical `intraday-check`
Scheduler KV log so the dashboard can show the loop status.

## Daily Evidence Query

Use an explicit Taiwan trade date.

```sql
SELECT
  trade_date,
  event_type,
  status,
  COUNT(*) AS cnt
FROM paper_execution_events
WHERE trade_date = 'YYYY-MM-DD'
  AND event_type IN (
    'finlab_l5_market_data',
    'intraday_technical_decision',
    'paper_broker_reconciliation'
  )
GROUP BY trade_date, event_type, status
ORDER BY event_type, status;
```

Expected production-simulated result:

```text
finlab_l5_market_data: present for pending candidates when flag is enabled
intraday_technical_decision: present before pre-trade gate; decision is active when guard is enabled
paper_broker_reconciliation: present for paper fills
```

## Real Loop Invocation

Controller env must contain:

```text
FINLAB_EXECUTION_LOOP_ENABLED=true
STOCKVISION_WORKER_URL=<worker url>
STOCKVISION_AUTH_TOKEN=<worker service token>
```

GCP Scheduler sync env must also contain:

```text
STOCKVISION_WORKER_BASE_URL=<worker url>
SCHEDULER_AUTH_TOKEN=<worker scheduler token>
ML_CONTROLLER_URL=<ml-controller url>
ML_CONTROLLER_SECRET=<controller token>
```

`infra/gcp-scheduler-jobs.json` routes `intraday-check` to ML Controller:

```text
schedule = * 1-5 * * 1-5
path = /finlab/execution/production-simulated-loop
body.duration_seconds = 50
body.poll_seconds = 10
body.dry_run = false
```

This gives five 10-second checks per minute and leaves margin before the next
Scheduler tick.

Manual smoke invocation:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "$env:ML_CONTROLLER_URL/finlab/execution/production-simulated-loop" `
  -Headers @{ "X-Controller-Token" = $env:ML_CONTROLLER_SECRET } `
  -ContentType "application/json" `
  -Body '{"dry_run":false,"duration_seconds":60,"poll_seconds":10,"rolling_bar_seconds":30,"allow_worker_paper_order":true}'
```

Expected response:

```text
status = completed / completed_with_errors
mode = real_loop_simulated_order
paper_order_mode = worker_intraday_check
live_submit_enabled = false
can_submit_real_order = false
```

## Pilot Gate

Small Real-Order Pilot remains blocked until all are true:

```text
1. Three consecutive trading days have complete Phase 1, 3, 6 events.
2. No payload contains live submit flags or broker order ids.
3. No L5 event has unexplained stale quote, wide spread, or empty book drift.
4. Dynamic ATR/OBV/Adaptive RSI does not contradict paper fills without reason.
5. Reconciliation mismatches are either zero or reviewed and accepted.
6. Kill switch and manual stop path are verified.
7. Wei explicitly approves real-order pilot.
```

## Verification Commands

Worker:

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npm run type-check
```

Python:

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m pytest `
  ml-controller\tests\test_finlab_sinopac_l5_market_data.py `
  ml-controller\tests\test_finlab_execution_preview_service.py `
  ml-controller\tests\test_finlab_production_simulated_loop.py `
  -q -p no:cacheprovider
```

Diff hygiene:

```powershell
git diff --check
```
