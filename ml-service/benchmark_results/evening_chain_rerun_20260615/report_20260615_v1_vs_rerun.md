# 2026-06-15 Evening-chain 第一版 vs 本次 rerun 比較報告

## 結論
- 本次 rerun 最終成功，root scheduler 已收斂為 `evening-chain=success`，最終 pipeline run_id 是 `pipeline-v2-l6vvl`。
- 第一版的核心問題是 L1.5 只產生 24 檔 ML slate，另外 96 檔是 raw signal observe/top-up；本次 rerun 改為 L1.5 Router 自己產生 120 檔，`raw_signal_top_up_count=0`。
- L2/L3 不再被 24 檔鎖死：L2 tree 跑 120 檔，L2 gate 進 L3 為 90 檔，L3 formal pass 40 檔。
- L4 sparse 從 0 檔變成 3 檔：`2820 華票`、`2838 聯邦銀`、`2884 玉山金`。不是補滿，是正 expected edge + sparse allocation 才買。
- 中途發現並修復 production blocker：`payload_builder._bulk_load_prices` 對 120 檔一次塞 D1 `IN (...)` 造成 `too many SQL variables`，已用 chunked D1 bulk loads 修復並部署。

## 版本與執行
| 項目 | 第一版 6/15 | 本次 rerun |
|---|---:|---:|
| Screener run_id | `screener-2026-06-15-1781533530594` | `screener-2026-06-15-1781547996222` |
| Screener created_at | 2026-06-15 14:27:23 | 2026-06-15 18:27:45 |
| Pipeline run_id | `pipeline-v2-xbkqm` | `pipeline-v2-l6vvl` |
| Deploy revision | 舊版 | `ml-controller-00419-x7f`, image `sha256:f225c798...` |
| Root status | success | success, manual closure after verified successful rerun |
| Verify-v2 | success, 170/170 historical verify | skipped, no pending predictions in verifiable historical window |

## L0 到 L4 數據
| Layer | 指標 | 第一版 | 本次 rerun | 變化 |
|---|---|---:|---:|---:|
| L0/L0.5 | Universe / hard gate pass | 516 | 516 | 0 |
| L1 | 策略數 | 75 | 75 | 0 |
| L1 | 策略打標 matrix cells | 38,700 | 38,700 | 0 |
| L1 | active labeled candidates | 467 | 467 | 0 |
| L1.25 | strategy portfolio metric count | 30 | 75 | +45 |
| L1.5 | PLE/Listwise router ML slate | 24 | 120 | +96 |
| L1.5 | raw signal top-up | 96 | 0 | -96 |
| L1.5 | observe-only candidates | 492 | 396 | -96 |
| L2 | Tree model prediction symbols | 24 | 120 | +96 |
| L2/L3 | Prediction rows | 204 | 1,010 | +806 |
| L3 | Formal pass | 11 | 40 | +29 |
| L3.5 | Pipeline recommendations | 11 | 40 | +29 |
| L4 | Sparse selected BUY | 0 | 3 | +3 |

## Funnel Stage 對照
| Stage | 第一版 symbols | Rerun symbols | 說明 |
|---|---:|---:|---|
| L0/L0.5 hard gate pass | 516 | 516 | `universe/pass/hard_filters_passed` |
| Score V2 computed | 516 | 516 | `scoring/pass/base_score_computed` |
| L1.5 router pass | 24 | 120 | `layer1_strategy_breadth_gate/pass/l15_ple_router_selected_by_strategy_portfolio_evidence` |
| Raw signal observe/top-up | 96 | 0 | `layer1_strategy_breadth_gate/observe/raw_signal_top_up_observe_after_strategy_quota` |
| Final L1.5 ML slate seed | 24 | 120 | `final_selection/observe/selected_for_l1_breadth_seed` |
| L3 formal pass | 11 | 40 | `layer3_formal_ml_gate/pass/formal_family_rank_pass` |
| L3 formal drop | 3 | 50 | `layer3_formal_ml_gate/drop/formal_family_rank_not_selected` |

## L1.25 / L1.5 詳細
- L1 matrix：兩版都是 516 檔 x 75 策略 = 38,700 cells，coverage=1。
- L1.25：rerun 的 `strategy_portfolio_metric_count=75`，其中 30 個策略有 decision_log evidence，45 個 no_evidence；也就是策略都有 prior slot，但真正可做績效好壞調權的是 30 個。
- Runtime teacher evidence：rerun 可用 299 檔、missing 217 檔；policy 是 `previous_trading_day_or_latest_verified_cache_no_same_day_l2_l3_dependency`。
- Router adaptive floor：`min_route_score=18.803`，route score 分布 `p10=11.495, p25=13.921, p50=17.036, p75=19.755, p90=23.25`。
- Rerun 有 155 檔 above floor、312 檔 below floor，容量上限 120，所以 overflow 35；這是最大容量限制，不是最低補滿。

## L2/L3 Model Distribution
| Model | 第一版 stock_ids | Rerun stock_ids | 第一版 rows | Rerun rows |
|---|---:|---:|---:|---:|
| LightGBM | 24 | 120 | 24 | 120 |
| XGBoost | 24 | 120 | 24 | 120 |
| ExtraTrees | 24 | 120 | 24 | 120 |
| TabM | 18 | 90 | 18 | 90 |
| GNN | 18 | 90 | 18 | 90 |
| DLinear | 18 | 90 | 18 | 90 |
| PatchTST | 18 | 88 | 18 | 88 |
| iTransformer | 18 | 86 | 18 | 86 |
| TimesFM | 18 | 86 | 18 | 86 |
| ensemble | 24 | 120 | 24 | 120 |

## L4 Sparse Allocation
| Symbol | Name | Rank | Score | Weight | Expected return | Risk | Cluster | Pairwise corr max | Covariance | Votes |
|---|---|---:|---:|---:|---:|---:|---|---:|---|---|
| 2884 | 玉山金 | 7 | 58.3 | 0.3111 | 0.0078 | 0.0116 | c001 | 0.194 | ledoit_wolf | bull 3 / flat 6 / bear 0 |
| 2838 | 聯邦銀 | 17 | 59.9 | 0.2888 | 0.0078 | 0.0123 | c000 | 0.194 | ledoit_wolf | bull 3 / flat 6 / bear 0 |
| 2820 | 華票 | 62 | 57.4 | 0.4001 | 0.0078 | 0.0100 | c002 | 0.194 | ledoit_wolf | bull 4 / flat 4 / bear 1 |

- Sparse diagnostics：candidate_count=40、evaluated_candidate_count=3、positive_edge_count=3、selected_count=3、zero_selection_allowed=true。
- LedoitWolf 有發揮：covariance_method=`ledoit_wolf`、shrinkage=0.14712602。
- Graph cluster 有發揮：3 檔各自 cluster_size=1，pairwise_corr_max=0.19398964，未觸發 cluster penalty。

## Overlap / Diversity
| 集合 | intersection | union | Jaccard |
|---|---:|---:|---:|
| L1.5 final slate | 19 | 125 | 0.152 |
| L2/L3 prediction symbols | 19 | 125 | 0.152 |
| Pending-buy eligible | 19 | 125 | 0.152 |

解讀：Jaccard 0.152，代表本次 rerun 並不是把原 24 檔硬擴成 120 檔，而是新增大量不同候選；重疊只有 19 檔。

## Root Cause / Fix
- 原始 6/15 第一版：L1.5 router 只通過 24 檔，`raw_signal_top_up_count=96`，導致 L2/L3 實際只看很窄的 slate。
- 本次修補後：L1.25/L1.5 讀完整 strategy matrix、FinLab portfolio metrics、runtime teacher evidence；L1.5 直接輸出 120 檔，raw top-up 歸零。
- Rerun 中途 blocker：候選從 24 擴到 120 後，`payload_builder._bulk_load_prices(stock_ids)` 單次 D1 bind 超限，production 回 `too many SQL variables`。
- 修補 commit：`6e1c00f1 Chunk D1 payload builder bulk loads`，把 prices / indicators / chips / sentiment / accuracies / misc loaders 全部改成 D1-safe chunks，regression test 覆蓋 165 檔拆成 80/80/5。
- 修補後 pipeline `pipeline-v2-l6vvl` 成功：120 symbols、1,010 prediction rows、40 pipeline recommendations、3 sparse BUY。

## Artifacts
- Baseline artifacts：`ml-service/benchmark_results/evening_chain_rerun_20260615/baseline/`
- Rerun artifacts：`ml-service/benchmark_results/evening_chain_rerun_20260615/rerun/`
- Logs：`ml-service/benchmark_results/evening_chain_rerun_20260615/logs/`
- Machine summary：`ml-service/benchmark_results/evening_chain_rerun_20260615/comparison_summary.json`
