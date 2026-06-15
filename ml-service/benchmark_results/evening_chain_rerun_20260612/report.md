# 2026-06-12 Evening Chain Rerun Comparison Report

## Closure Status

- Status: local closure + production rerun completed.
- Decision date: 2026-06-12.
- Original baseline: `screener-2026-06-12-1781275176039` created at `2026-06-12 14:40:53`.
- Rerun baseline: `screener-2026-06-12-1781453187444` created at `2026-06-14 16:07:53`.
- FinLab Modal backfill rerun: second trigger `finlab-v4-3y-20260612-1781452245910`, callback HTTP 200.
- Pipeline: `pipeline-v2-zbxxw`, Cloud Run completed successfully; internal Pipeline V2 completed in 282.4s.
- Verify: `verify-v2-t6rx8`, Cloud Run completed successfully; verify business status was skipped because pending predictions=0 for this historical window.
- Post-verify dependencies: model IC ran; strategy-learning materialized historical replay evidence; current-date-only tasks were intentionally skipped by `worker/src/lib/postMarketChain.ts`.

## Root Cause And Fix

Root cause: production Modal `stockvision-ml` did not mount the existing Modal secret `stockvision-finlab`, so FinLab backfill exited with missing `FINLAB_API_KEY`. The function also only caught `Exception`; `SystemExit` escaped and no callback was sent, leaving Worker waiting.

Fix deployed:

- `ml-service/modal_app.py:53` adds `modal.Secret.from_name("stockvision-finlab")`.
- `ml-service/modal_app.py:82` mounts `[gcs_secret, cf_secret, finlab_secret, runtime_env_secret]`.
- `ml-service/modal_app.py:2401` catches `(Exception, SystemExit)` so failure paths callback instead of hanging.
- Contract test: `ml-controller/tests/test_finlab_modal_backfill_contract.py` passed, 3 tests.
- Modal app deployed successfully after the fix.

## Layer Comparison

| Layer/stage | Original | Rerun | Delta |
| --- | --- | --- | --- |
| L0 / Universe pass | 506 | 506 | 0 |
| L0 / Universe drop | 1472 | 1472 | 0 |
| L1.5 / RRG observe capacity | 180 | 120 | -60 |
| L1.5 / Router pass | 68 | 21 | -47 |
| L1.5 / Observe-only | 112 | 99 | -13 |
| L1.5 / ML queue | 68 | 71 | 3 |
| L1.5 / Research-only | 0 | 9 | 9 |
| L1.5 / Candidate seed | 68 | 21 | -47 |
| L2 / coarse audit rows | 136 | 42 | -94 |
| L3 / formal pass | 39 | 40 | 1 |
| L3 / formal drop | 12 | 17 | 5 |
| Final screener observe | 68 | 21 | -47 |

## Strategy / L1.25 Evidence

| Metric | Original | Rerun |
| --- | --- | --- |
| strategy_count | 75 | 75 |
| pool_entries | 644 | 644 |
| deduped_symbols | 78 | 80 |
| ml_queue_count | 68 | 71 |
| research_only_count | 0 | 9 |
| dropped_count | 10 | 0 |
| overflow_count | 10 | 9 |
| FinLab strategy metric source | n/a | strategy_reward_ledger+strategy_decision_log+backtest_results |
| FinLab metric count | n/a | 30 |
| Router version | n/a | multi-strategy-ple-router-v1 |
| Router order | n/a | l1_full_universe_labeler_l125_finlab_portfolio_l15_ple_router |
| Router ML slate | n/a | 21 |
| Router observe-only | n/a | 485 |
| Router overflow | n/a | 0 |

Interpretation: the rerun did not remove L2/L3 9ML. The strategy layer still evaluates 75 strategies and the ML queue increased from 68 to 71. What changed is L1.5 routing strictness: final L1 seed dropped from 68 to 21, while observe/research lanes preserved non-selected evidence.

## L2 / L3 Model Coverage

| Model | Original | Rerun | Delta |
| --- | --- | --- | --- |
| DLinear | 51 | 57 | 6 |
| ExtraTrees | 68 | 76 | 8 |
| GNN | 51 | 57 | 6 |
| LightGBM | 68 | 76 | 8 |
| PatchTST | 51 | 54 | 3 |
| TabM | 51 | 57 | 6 |
| TimesFM | 51 | 54 | 3 |
| XGBoost | 68 | 76 | 8 |
| ensemble | 68 | 76 | 8 |
| iTransformer | 51 | 54 | 3 |

Pipeline evidence from rerun:

- Loaded 76 ML universe stocks from latest screener candidate seed.
- L2 core ML gate kept 57/76 candidates.
- L3 core family vote ranked 40/76 candidates; 57 L3 audit rows written.
- PatchTST / TimesFM / iTransformer produced 54 rows because 3 symbols lacked enough sequence coverage.
- Predictions written: 637 rows; prediction symbols: 76; output model families in pipeline metric: 8.

## Overlap / Diversity

| Set | Original | Rerun | Common | Jaccard |
| --- | --- | --- | --- | --- |
| L1.5 router pass | 68 | 21 | 7 | 0.0854 |
| ML queue | 68 | 71 | 62 | 0.8052 |
| Candidate seed | 68 | 21 | 7 | 0.0854 |
| L3 formal pass | 39 | 40 | 26 | 0.4906 |
| Final screener | 68 | 21 | 7 | 0.0854 |

Daily recommendation overlap:

- Original daily symbols: 92.
- Rerun daily symbols: 45.
- Common: 31.
- Jaccard: 0.2925.
- Removed sample: 2889, 2241, 2030, 5410, 2006, 6901, 2892, 1342, 2890, 2520, 5522, 2884, 3213, 9946, 3322, 6196, 2820, 4534, 3293, 7780.
- Added sample: 1605, 6525, 2476, 3321, 6121, 3576, 3702, 1789, 6202, 6244, 1560, 2412, 1319, 6443.

## L4 Sparse Allocation

| Metric | Original | Rerun | Delta |
| --- | --- | --- | --- |
| daily_recommendations rows | 92 | 45 | -47 |
| unique symbols | 92 | 45 | -47 |
| buy-like / L4 selected | 3 | 0 | -3 |
| alpha_allocation rows | 39 | 13 | -26 |
| daily symbol overlap | 92 | 45 | common=31, J=0.2925 |

Original L4 selected symbols: 2820, 6944, 2542.

Rerun L4 selected symbols: none.

Interpretation: rerun did not top-up weak names. L4 `sparse_tangent_inverse_risk` selected 0/3 BUY-capacity rows, so final BUY-like output is 0. This matches the no-garbage-top-up rule.

## Dependent Scheduler Closure

- FinLab callback: HTTP 200 at 2026-06-14T16:00:35Z.
- TWSE chips / TPEX chips / TPEX prices / attention stocks / regime compute: HTTP 200.
- Pipeline trigger: `/pipeline/v2/run?date=2026-06-12` HTTP 202 at 2026-06-14T16:09:02Z.
- Verify trigger: `/verify/run` HTTP 202 at 2026-06-14T16:13:58Z.
- Model IC tracker: `/model_pool/compute_weekly_ic` HTTP 200 at 2026-06-14T16:14:13Z.
- Strategy learning D1 evidence: `945` decision rows, `178` strategy reward rows updated after 2026-06-14T16:00:00Z.
- Meta reward rows: `0` because historical rerun skips current-date-only meta-learning / LinUCB reward ledger tasks.

Source rule: `worker/src/lib/postMarketChain.ts:208` gates current-date-only tasks with `isCurrentBusinessDate`; lines 217-223 skip LinUCB reward ledger, intraday cache clear, adapt, daily report, paper-active, obsidian sync, and meta-learning-shadow for historical callbacks; line 229 still runs strategy-learning.

## Non-Blocking Warnings

- FinLab SDK warning: runtime has 2.0.7 while 2.0.13 is available. Backfill completed; upgrade is recommended but not blocking this rerun.
- `twse/ex-dividend` logged TWSE/TPEX JSON parse failures, but endpoint returned HTTP 200 and chain continued. Treat as data-quality warning, not chain failure.
- `OnlinePortfolioBandit` module missing; recommendation service fell back to `sparse_tangent_inverse_risk`. This affects L4 controller choice, but fallback completed and selected 0 rows.
- LLM reason generation skipped due no GEMINI/ANTHROPIC key in the pipeline job; Breeze2 shadow still generated 40 advisory reasons. This does not alter selection.

## Evidence Files

- Original snapshot: `ml-service/benchmark_results/evening_chain_rerun_20260612/original/`.
- Rerun snapshot: `ml-service/benchmark_results/evening_chain_rerun_20260612/rerun/`.
- Summary JSON: `ml-service/benchmark_results/evening_chain_rerun_20260612/comparison_summary.json`.
- Pipeline log: `ml-service/benchmark_results/evening_chain_rerun_20260612/logs/pipeline_v2_zbxxw.log`.
- Verify log: `ml-service/benchmark_results/evening_chain_rerun_20260612/logs/verify_v2_t6rx8.log`.
- Controller chain log: `ml-service/benchmark_results/evening_chain_rerun_20260612/logs/controller_evening_chain_20260612.log`.

## Bottom Line

The replay is production-complete for the historical 2026-06-12 evening chain. The repaired architecture is stricter at L1.5, keeps 75 strategies and active 9ML evidence, increases ML queue coverage, and lets L4 choose zero when sparse allocation finds no BUY-quality rows.
