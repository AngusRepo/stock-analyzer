# Scheduler Performance Tracking - 2026-05-06

Snapshot time: 2026-05-06 17:46 Asia/Taipei

## Scope

This file records the before/after performance evidence for the 2026-05-06 scheduler and evening-chain optimization review.

Tracked surfaces:

- GCP Scheduler trigger timestamps
- Cloud Run Job execution duration
- Modal / LLM `cost_events`
- D1 query cost for evidence reads
- Output row counts after data update / pipeline

## Current 2026-05-06 Snapshot

### GCP Scheduler Trigger State

Observed via `gcloud scheduler jobs list --location=asia-east1`.

| Job | Last attempt UTC | Taipei time | Notes |
|---|---:|---:|---|
| pre-market-warmup | 2026-05-06T00:50:00Z | 08:50 | Triggered |
| morning-setup | 2026-05-05T23:15:00Z | 07:15 | Triggered for 2026-05-06 TW morning |
| morning-briefing | 2026-05-05T23:50:00Z | 07:50 | Triggered for 2026-05-06 TW morning |
| intraday-check | 2026-05-06T05:59:04Z | 13:59 | Last per-minute attempt in market window |
| intraday-rescore 10/11/12/12:30 | 2026-05-06T02:00/03:00/04:00/04:30Z | 10:00/11:00/12:00/12:30 | Triggered |
| eod-exit | 2026-05-06T05:25:00Z | 13:25 | Triggered |
| daily-snapshot | 2026-05-06T06:20:00Z | 14:20 | Triggered |
| optuna-queue | 2026-05-06T06:00:01Z | 14:00 | Triggered |
| evening-chain | 2026-05-06T09:15:00Z | 17:15 | Triggered with `sync=1` |
| ml-warmup | 2026-05-06T09:15:00Z | 17:15 | Triggered |
| verify-v2 | 2026-05-05T11:00:05Z | 19:00 previous trading day | 2026-05-06 19:00 has not run at snapshot time |

### Cloud Run Job Duration

Observed via `gcloud run jobs executions list`.

| Job | Execution | Created UTC | Completed UTC | Result | Duration |
|---|---|---:|---:|---|---:|
| pipeline-v2 | pipeline-v2-w66bt | 2026-05-06T09:27:31Z | 2026-05-06T09:34:52Z | success | 7m16.78s |
| pipeline-v2 | pipeline-v2-p7dmd | 2026-05-06T02:18:48Z | 2026-05-06T02:28:15Z | success | 9m22.93s |
| verify-v2 | none yet for 2026-05-06 19:00 TW | - | - | pending | - |

Comparison against 2026-05-05 evening run:

| Date | Execution | Duration |
|---|---|---:|
| 2026-05-05 | pipeline-v2-f4qvv | 8m38.52s |
| 2026-05-06 | pipeline-v2-w66bt | 7m16.78s |

Initial delta: 7m16.78s vs 8m38.52s, about 15.8% faster.

### Modal / LLM Cost Events

Observed from D1 `cost_events` using `date = '2026-05-06'`.

| Model / Source | Events | Compute sec | Estimated USD | Notes |
|---|---:|---:|---:|---|
| predict_batch_v2 | 2 | 913.890 | 0.040174 | `map_batch`, `input_count=64`, `chunk_count=2`, `chunk_size=40` |
| state_space_universal_predict | 4 | 886.918 | 0.027175 | 4 remote calls; two long calls dominate |
| gemini-3.1-flash-lite-preview / llm_reason | 2 | 0 | 0.003265 | `n_candidates=64` |
| dlinear_universal_predict | 4 | 67.449 | 0.002066 | 4 remote calls |
| patchtst_universal_predict | 4 | 56.135 | 0.001969 | 4 remote calls |
| chronos_universal_predict | 2 | 33.634 | 0.001478 | 2 remote calls |

Total so far:

| Date | Events | Compute sec | Estimated USD |
|---|---:|---:|---:|
| 2026-05-05 | 37 | 2659.422 | 0.104253 |
| 2026-05-06 | 18 | 1958.026 | 0.076127 |

Initial delta: 2026-05-06 is about 26.4% lower compute seconds and 27.0% lower estimated cost so far, but the day is not complete.

### D1 Evidence Query Cost

Evidence queries used for this snapshot:

| Query | SQL duration | Rows read |
|---|---:|---:|
| `cost_events` aggregate by date/source/model | 0.8381 ms | 43 |
| `cost_events` total 2026-05-05 vs 2026-05-06 | 0.5808 ms | 58 |
| `cost_events` meta grouped by model | 0.3008 ms | 43 |
| `stock_prices` 5/5-5/6 counts | 3.359 ms | 4,584 |
| `chip_data` 5/5-5/6 counts | 8.2523 ms | 32,369 |
| `technical_indicators` 5/5-5/6 counts | 1.8341 ms | 4,584 |
| `daily_recommendations` 5/5-5/6 counts | 0.1051 ms | 129 |
| `predictions` 5/5-5/6 counts | 0.6455 ms | 1,400 |

### Output Row Counts

| Table | 2026-05-05 | 2026-05-06 |
|---|---:|---:|
| stock_prices | 2,287 | 2,296 |
| chip_data | 15,762 | 16,606 |
| technical_indicators | 2,287 | 2,296 |
| daily_recommendations | 64 | 64 |
| predictions | 695 rows / 11 models | 704 rows / 11 models |

## Initial Findings

- Today evening pipeline completed successfully and faster than yesterday's evening run.
- `predict_batch_v2` is running as `map_batch` with 64 inputs split into 2 chunks of 40, so the earlier 343-row inflation is not present in this run.
- `state_space_universal_predict` still consumes a large part of Modal compute time; this is the next likely cost-efficiency target.
- Data output counts look coherent for 2026-05-06: prices, chips, indicators, recommendations, and predictions all have current-date rows.
- `verify-v2` for 2026-05-06 has not run yet at this snapshot; final comparison needs a post-19:00 refresh.

## Pending 19:00 Refresh

After 2026-05-06 19:00 Asia/Taipei:

- Pull `verify-v2` Cloud Run execution and duration.
- Pull post-verify `model-ic-tracker` / rolling IC callback state.
- Re-read `cost_events` totals for 2026-05-06.
- Compare final 2026-05-06 cost/duration against 2026-05-05.
- Check OBS/Data Quality/Scheduler UI payload after the full chain settles.

## Post-19:00 Live Refresh

Snapshot time: 2026-05-06 23:58 Asia/Taipei

Source of truth:

- GCP Cloud Run Jobs: `pipeline-v2`, `verify-v2`
- GCP Scheduler job list: `asia-east1`
- Cloudflare D1 API: `cost_events`, output row counts

### Scheduler / Cloud Run Execution Result

| Surface | Execution | Created UTC | Completed UTC | Result | Duration |
|---|---|---:|---:|---|---:|
| pipeline-v2 | pipeline-v2-w66bt | 2026-05-06T09:27:31Z | 2026-05-06T09:34:52Z | success | 7m16.78s |
| pipeline-v2 | pipeline-v2-p7dmd | 2026-05-06T02:18:48Z | 2026-05-06T02:28:15Z | success | 9m22.93s |
| verify-v2 | verify-v2-vvxkm | 2026-05-06T11:00:04Z | 2026-05-06T11:00:26Z | success | 18.83s |
| verify-v2 | verify-v2-gsl45 | 2026-05-06T11:00:58Z | 2026-05-06T11:01:18Z | success | 15.00s |

KV scheduler log:

| Task | Status | Timestamp UTC | Duration | Summary |
|---|---|---:|---:|---|
| verify-v2 | success | 2026-05-06T11:01:14Z | 2.65s | verified 600/600 written 600 correct 22 pnl 207.2% arf 0 |
| model-ic-tracker | success | 2026-05-06T11:01:16Z | 1.175s | rolling_ic n_rows=2442 |

Rolling IC values from the post-verify callback:

| Model | IC | Samples |
|---|---:|---:|
| XGBoost | 0.098 | 102 |
| CatBoost | 0.152 | 102 |
| ExtraTrees | 0.079 | 102 |
| LightGBM | 0.012 | 102 |
| FT-Transformer | 0.089 | 102 |
| Chronos | -0.117 | 125 |
| DLinear | 0.025 | 125 |
| PatchTST | 0.180 | 125 |
| DLinear::challenger | 0.108 | 125 |
| PatchTST::challenger | 0.219 | 125 |

Observation:

- `verify-v2` ran twice around the 19:00 Taipei scheduler window. Both completed successfully, but duplicate execution should be treated as a follow-up root-cause item because the scheduler manifest only shows one `verify-v2` job.
- Latest evening pipeline run is faster than the 2026-05-05 evening baseline: 7m16.78s vs 8m38.52s, about 15.8% faster.
- Rolling IC callback completed successfully after verify-v2 and did not leave IC at 0 for active models in this run.

### Final 2026-05-06 Cost Events

Observed from D1 `cost_events` using `date = '2026-05-06'`.

| Model / Source | Events | Compute sec | Estimated USD | Tokens in | Tokens out |
|---|---:|---:|---:|---:|---:|
| predict_batch_v2 | 2 | 913.890 | 0.040174 | 0 | 0 |
| state_space_universal_predict | 4 | 886.918 | 0.027175 | 0 | 0 |
| gemini-3.1-flash-lite-preview / llm_reason | 2 | 0.000 | 0.003265 | 10,885 | 8,161 |
| dlinear_universal_predict | 4 | 67.449 | 0.002066 | 0 | 0 |
| patchtst_universal_predict | 4 | 56.135 | 0.001969 | 0 | 0 |
| chronos_universal_predict | 2 | 33.634 | 0.001478 | 0 | 0 |

Total comparison:

| Date | Events | Compute sec | Estimated USD | Tokens in | Tokens out |
|---|---:|---:|---:|---:|---:|
| 2026-05-05 | 37 | 2,659.422 | 0.104253 | 25,811 | 14,967 |
| 2026-05-06 | 18 | 1,958.026 | 0.076127 | 10,885 | 8,161 |

Delta:

- Compute seconds: down 701.396 sec, about 26.4% lower than 2026-05-05.
- Estimated cost: down 0.028126 USD, about 27.0% lower than 2026-05-05.
- Event count: down from 37 to 18, consistent with fewer repeated calls.

### D1 Query Cost For Refresh

| Query | SQL duration | Rows read |
|---|---:|---:|
| `cost_events` grouped by source/provider/model | 1.5370 ms | 43 |
| `cost_events` 2026-05-05 vs 2026-05-06 totals | 0.7498 ms | 58 |
| output row count union across price/chip/indicator/recommendation/prediction | 32.3421 ms | 43,086 |

### Output Row Counts After 2026-05-06 Evening Flow

| Table | 2026-05-05 | 2026-05-06 |
|---|---:|---:|
| stock_prices | 2,287 | 2,296 |
| chip_data | 15,762 | 16,606 |
| technical_indicators | 2,287 | 2,296 |
| daily_recommendations | 64 | 64 |
| predictions | 695 | 704 |

### Immediate Follow-Up Items

- `verify-v2` duplicate execution at 19:00 needs root-cause tracing before calling the schedule fully clean.
- `state_space_universal_predict` is still the second largest compute consumer after `predict_batch_v2`; it is the next Modal efficiency target.
- The 2026-05-06 cost and output counts look coherent: current-date rows exist across price, chip, indicators, recommendations, and predictions.
