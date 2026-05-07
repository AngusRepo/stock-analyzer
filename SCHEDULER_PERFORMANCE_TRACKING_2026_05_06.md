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

## Forced 2026-05-06 Rerun After Performance Optimizations

Snapshot time: 2026-05-07 12:25 Asia/Taipei

Purpose:

- Rerun the full 2026-05-06 evening path after the latest queue/batch and hot-path optimizations.
- Confirm that the chain produces clean serving data for the same business date.
- Compare the latest forced rerun against the previous two measured runs.

### Trigger And Chain Result

Triggered through the existing GCP Scheduler `evening-chain` service authorization header. The bearer token was reused but not printed.

| Stage | Evidence | Result |
|---|---|---|
| evening-chain trigger | `triggered_at=2026-05-07T04:04:33Z` | accepted |
| market data readiness | `price=2296`, `TWSE=1085`, `OTC=1211`, `chip=16606`, `indicators=2296` | ready |
| update fetch summary | `fetched price=1083 chip=16606 margin=1051` | ok |
| indicator queue | callback response said `indicator queue accepted` | accepted |
| screener / pipeline trigger | scheduler API later reported `event-driven chain reached pipeline trigger for 2026-05-06; LOCKED` | pipeline still started; lock message likely came from duplicate finalize/poll path |
| pipeline-v2 | `pipeline-v2-db8sk` | success, 8m50.67s |
| daily recommendation | D1 `daily_recommendations` for `2026-05-06` | 64 rows / 64 symbols / max_rank 64 |
| ML prediction matrix | D1 `predictions` for `2026-05-06` | 704 rows / 64 symbols / 11 models |
| verify-v2 | `verify-v2-dzhcg` | success, 14.71s |
| data quality | Worker DQ API for `2026-05-06` | price/chip/indicator/prediction coverage ok; predeploy status warn, not block |

Recommendation note:

- `recommendation` is not a separate GCP Scheduler job in this contract.
- It is the logical output stage after `pipeline/ML predict`, materialized as `daily_recommendations`.
- For this rerun it is verified by D1 row count: 64 recommendations for 64 distinct symbols on business date `2026-05-06`.

### Three-Run Comparison

| Run | Business date | Execution date | Pipeline execution | Pipeline wall time | Verify execution | Verify wall time | Cost events | Compute sec | Estimated USD |
|---|---|---|---|---:|---|---:|---:|---:|---:|
| A baseline | 2026-05-05 | 2026-05-05 | `pipeline-v2-f4qvv` | 8m38.52s | duplicate verify observed next cycle | about 16-17s each | 37 | 2,659.422 | 0.104253 |
| B first optimized | 2026-05-06 | 2026-05-06 | `pipeline-v2-w66bt` | 7m16.78s | `verify-v2-vvxkm`, `verify-v2-gsl45` | 18.83s / 15.00s | 18 | 1,958.026 | 0.076127 |
| C forced optimized rerun | 2026-05-06 | 2026-05-07 | `pipeline-v2-db8sk` | 8m50.67s | `verify-v2-dzhcg` | 14.71s | 9 | 934.201 | 0.036988 |

Important attribution detail:

- `cost_events.date` stores execution date, not business date.
- The forced rerun for business date `2026-05-06` appears under `cost_events.date = '2026-05-07'`.
- This is acceptable for cost accounting, but the table should eventually add explicit `business_date` or run-id lineage to avoid future ambiguity.

### Cost Delta

Raw daily total comparison:

| Comparison | Event delta | Compute delta | Estimated USD delta |
|---|---:|---:|---:|
| C vs A | 37 -> 9, down 75.7% | 2,659.422 -> 934.201, down 64.9% | 0.104253 -> 0.036988, down 64.5% |
| C vs B | 18 -> 9, down 50.0% | 1,958.026 -> 934.201, down 52.3% | 0.076127 -> 0.036988, down 51.4% |

Normalized interpretation:

- The raw daily reduction is large because earlier days included duplicate or multiple prediction-related runs.
- Normalized to one effective pipeline, C is slightly better than B on compute/cost but not faster on wall time.
- Compared with B normalized single-run cost, C is roughly 4.6% lower compute seconds and 2.8% lower estimated USD.
- Compared with A normalized single-run cost, C is roughly 5.4% higher compute seconds and 6.4% higher estimated USD, so the optimization is not yet a pure per-run compute win against the 5/5 normalized baseline.

### Cost Breakdown By Source

| Execution cost date | Source / model | Events | Compute sec | Estimated USD | Share of USD |
|---|---|---:|---:|---:|---:|
| 2026-05-07 | `predict_batch_v2` | 1 | 476.647 | 0.020953 | 56.6% |
| 2026-05-07 | `state_space_universal_predict` | 2 | 369.226 | 0.011313 | 30.6% |
| 2026-05-07 | `gemini-3.1-flash-lite-preview / llm_reason` | 1 | 0.000 | 0.001632 | 4.4% |
| 2026-05-07 | `patchtst_universal_predict` | 2 | 42.985 | 0.001507 | 4.1% |
| 2026-05-07 | `dlinear_universal_predict` | 2 | 30.826 | 0.000945 | 2.6% |
| 2026-05-07 | `chronos_universal_predict` | 1 | 14.517 | 0.000638 | 1.7% |

Conclusion:

- The biggest remaining cost source is still `predict_batch_v2`.
- The second biggest is still `state_space_universal_predict`; it deserves the next targeted optimization pass.
- DLinear/PatchTST/Chronos are no longer the primary cost drivers for this rerun.

### D1 Query Cost During Verification

| Evidence query | SQL duration | Rows read |
|---|---:|---:|
| `cost_events` total by date | 0.6769 ms | 69 |
| `cost_events` grouped by source/provider/model | 0.7053 ms | 154 |
| output row counts across recommendations, predictions, prices, indicators | 8.1643 ms | 10,705 |

These evidence reads are not the performance bottleneck. The current bottleneck remains Cloud Run/Modal runtime plus orchestration wait time.

### Output Consistency After Rerun

| Table | 2026-05-05 | 2026-05-06 after forced rerun |
|---|---:|---:|
| `stock_prices` | 2,287 | 2,296 |
| `technical_indicators` | 2,287 | 2,296 |
| `daily_recommendations` | 64 rows / 64 symbols | 64 rows / 64 symbols |
| `predictions` | 695 rows / 64 symbols / 11 models | 704 rows / 64 symbols / 11 models |

The recommendation stage is therefore present and current for the rerun. It was missing from the earlier written stage list, not missing from production output.

### Findings

- Cost efficiency improved materially at the daily-run level because duplicate/multiple prediction events were reduced.
- Pipeline wall-clock did not consistently improve. The forced rerun took 8m50.67s, slower than the 2026-05-06 first optimized evening run but faster than one earlier same-day manual pipeline run.
- `scheduler/status` still does not clearly represent event-driven historical reruns; some stages can appear as waiting or locked even after Cloud Run completed.
- `evening-chain` produced a `LOCKED` summary after it had already reached pipeline trigger. This looks like duplicate finalization or stale polling telemetry, not a failed run, because `pipeline-v2-db8sk`, `daily_recommendations`, and `verify-v2-dzhcg` all completed.
- The forced historical rerun correctly does not imply that every daily/weekly/monthly scheduler should run. Date-dependent tasks that are current-day only should remain skipped by contract.

### Next Optimization Targets

1. Add `business_date` or explicit run lineage into `cost_events` so forced historical reruns do not get mixed with execution-date accounting.
2. Clean `evening-chain` lock/finalizer telemetry so a successful triggered pipeline is not summarized as `LOCKED`.
3. Optimize `state_space_universal_predict` batching/caching; it is still about 30.6% of this rerun's estimated cost.
4. Keep `recommendation` as a first-class logical stage in future reports, even though it is materialized inside the pipeline contract rather than as a standalone Scheduler job.

## Fourth Run: 2026-05-07 Rerun After Scheduler/Optuna Controller Changes

Snapshot time: 2026-05-07 21:15 Asia/Taipei

Purpose:

- Rerun the 2026-05-07 market-data/evening path after the latest scheduler ownership and Optuna controller changes.
- Confirm TPEX/OTC data is no longer returning the pathological `15/700` readiness failure.
- Capture a fourth performance sample against the earlier A/B/C runs.

### Trigger And Chain Result

Triggered with the existing production scheduler authorization path. The bearer token was reused but not printed.

| Stage | Evidence | Result |
|---|---|---|
| manual market-data update | `2026-05-07`, `price=2291`, `TWSE=1085`, `OTC=1206`, `chip=16196`, `indicators=2296` | ready; TPEX/OTC fixed for this run |
| GCP `evening-chain` trigger | Scheduler job accepted | accepted |
| indicator queue | `run_id=2026-05-07-movh24hn`, `shards=4` | success |
| screener | Worker scheduler log | success |
| pipeline-v2 | `pipeline-v2-x5llm` | success, 599.44s |
| ML predict | `predictions_written=704` | success |
| daily recommendation | `recommendations_updated=64` | success |
| verify-v2 | `verify-1778158632-7681a89e` | success, 3.188s |
| post-verify chain | `model-ic-tracker:success adapt:success daily-report:success obsidian-sync:success` | success, 15.733s |

Important closure note:

- The pipeline Cloud Run job did POST four successful callbacks to the Worker callback endpoint.
- The pipeline/recommendation/screener logs were written, but the post-pipeline callback chain did not automatically trigger `verify-v2`.
- `verify-v2` was manually triggered to complete this rerun.
- This means the data path is clean for this forced run, but the pipeline callback -> post-pipeline-chain contract still has a root-cause tail.

### Four-Run Comparison

| Run | Business date | Execution date | Pipeline execution | Pipeline wall time | Verify execution | Verify wall time | Cost events | Compute sec | Estimated USD |
|---|---|---|---|---:|---|---:|---:|---:|---:|
| A baseline | 2026-05-05 | 2026-05-05 | `pipeline-v2-f4qvv` | 8m38.52s | duplicate verify observed next cycle | about 16-17s each | 37 | 2,659.422 | 0.104253 |
| B first optimized | 2026-05-06 | 2026-05-06 | `pipeline-v2-w66bt` | 7m16.78s | `verify-v2-vvxkm`, `verify-v2-gsl45` | 18.83s / 15.00s | 18 | 1,958.026 | 0.076127 |
| C forced optimized rerun | 2026-05-06 | 2026-05-07 | `pipeline-v2-db8sk` | 8m50.67s | `verify-v2-dzhcg` | 14.71s | 9 | 934.201 | 0.036988 |
| D scheduler/controller rerun | 2026-05-07 | 2026-05-07 | `pipeline-v2-x5llm` | 9m59.44s | `verify-1778158632-7681a89e` | 3.188s | 8 | 974.753 | 0.037959 |

Cost attribution detail:

- `cost_events.date = '2026-05-07'` includes both an earlier run and this evening rerun.
- The D row isolates this rerun using `ts >= '2026-05-07T12:30:00Z'`.
- The full day total was `17 events / 1,908.954 compute_sec / $0.074947`, so using the whole date would double-count unrelated work.

### Cost Delta

| Comparison | Event delta | Compute delta | Estimated USD delta | Pipeline wall-time delta |
|---|---:|---:|---:|---:|
| D vs A | 37 -> 8, down 78.4% | 2,659.422 -> 974.753, down 63.4% | 0.104253 -> 0.037959, down 63.6% | 8m38.52s -> 9m59.44s, slower 15.7% |
| D vs B | 18 -> 8, down 55.6% | 1,958.026 -> 974.753, down 50.2% | 0.076127 -> 0.037959, down 50.1% | 7m16.78s -> 9m59.44s, slower 37.2% |
| D vs C | 9 -> 8, down 11.1% | 934.201 -> 974.753, up 4.3% | 0.036988 -> 0.037959, up 2.6% | 8m50.67s -> 9m59.44s, slower 13.0% |

Interpretation:

- The latest run is not a wall-clock improvement. It is cleaner on event count, but pipeline elapsed time regressed versus B and C.
- The per-run Modal cost is roughly flat versus C, slightly higher by about 2.6% USD.
- Verify improved materially because the forced verify run completed in 3.188s, but this does not offset the unresolved callback-chain issue.
- The most important correctness win is TPEX/OTC readiness: `OTC=1206`, so the prior `OTC price rows=15/700` failure was not reproduced after the rerun.

### D Cost Breakdown By Source

| Source / model | Events | Compute sec | Estimated USD | Share of USD |
|---|---:|---:|---:|---:|
| `predict_batch_v2` | 1 | 450.226 | 0.019792 | 52.1% |
| `state_space_universal_predict` | 1 | 434.963 | 0.013327 | 35.1% |
| `gemini-3.1-flash-lite-preview / llm_reason` | 1 | 0.000 | 0.001632 | 4.3% |
| `patchtst_universal_predict` | 2 | 40.420 | 0.001418 | 3.7% |
| `chronos_universal_predict` | 1 | 21.283 | 0.000936 | 2.5% |
| `dlinear_universal_predict` | 2 | 27.861 | 0.000854 | 2.2% |

### Output Consistency After D Rerun

| Table / artifact | 2026-05-07 result |
|---|---:|
| `stock_prices` | 2,291 rows |
| `technical_indicators` | 2,291 rows |
| `daily_recommendations` | 64 rows / 64 symbols |
| `predictions` | 704 rows / 64 symbols |
| verify-v2 | verified 600/600, correct 22, pnl 18.3%, arf 0 |
| model IC tracker | success; rolling IC updated |
| adaptive params | success; `v51`, confidence 0.56, risk green 19 |

### Findings From D

- TPEX/OTC data quality recovered for this rerun. The critical `OTC price rows=15/700` condition did not recur after manual update plus evening-chain rerun.
- Pipeline cost remains dominated by `predict_batch_v2` and `state_space_universal_predict`; together they account for about 87.2% of this run's estimated USD.
- The controller/scheduler ownership cleanup reduced event count, but did not reduce wall-clock time.
- The post-pipeline callback chain is still not deterministic: pipeline callback delivery succeeded, but `verify-v2` did not auto-start. This is the main remaining production closure issue before calling the chain fully fixed.
- The recommendation stage is present and must stay in future reports even though it is not a standalone GCP Scheduler job.

### Why D Was Slower Than The 7-Minute Run

The 2026-05-07 D run was slower mostly because heavier work moved into the pipeline hot path, not because Cloud Run cold start regressed.

| Component | 2026-05-06 B run | 2026-05-07 D run | Delta | Interpretation |
|---|---:|---:|---:|---|
| Cloud Run start latency | 8.76s | 12.36s | +3.60s | minor; not the root cause |
| Pipeline app elapsed | 422.026s | 599.440s | +177.414s | main wall-clock regression |
| ML predict section | about 367s | about 437s | about +70s | state-space/Modal runtime slower |
| MarkovSwitching overlay | not emitted in B log | 427.375s | n/a | D explicitly shows Markov as the dominant ML wait |
| Dataset snapshot export | not in B metrics | 100.819s for `backtest_dataset` | about +101s | new heavy snapshot work now blocks pipeline completion |
| Price-history snapshot | not in B metrics | 0.135s | negligible | shared snapshot path is fine |

Evidence:

- B run `pipeline-v2-w66bt` completed in `422.026s`.
- D run `pipeline-v2-x5llm` completed in `599.440s`.
- D run emitted `State-space overlays metrics: KalmanFilter=2.813s, MarkovSwitching=427.375s`.
- D run emitted `dataset_snapshot_export.backtest_dataset.elapsed_s=100.819`, `row_count=1,304,313`, D1 query counts `prices=43`, `indicators=43`, `chips=43`, `signals=43`.

Root-cause conclusion:

- The 9m59s runtime is mostly explained by `MarkovSwitching` plus synchronous `backtest_dataset` snapshot export.
- `predict_batch_v2` cost is still the largest USD source, but wall-clock latency is being dominated by state-space wait and snapshot export.
- The next low-risk optimization is not lowering hardware. It is moving heavy research/backtest snapshot export out of the serving-critical pipeline completion path, or making it callback/queue driven after recommendations are already materialized.
