# 2026-06-12 Evening Chain V1~V4 ????

- ?????2026-06-15 17:37:45
- V1?6/12 ?? evening chain?
- V2?6/14 rerun?
- V3?6/15 ????? rerun?
- V4?6/15 ?? V4??? 6/12 FinLab canonical data????? FinLab?? historical TWSE/TPEX supplemental ??????V4 ?? screener/regime/pipeline ?????

## ????

| ?? | Screener run | Pipeline run | ?? |
|---|---|---|---|
| V1 | `screener-2026-06-12-1781275176039` | `pipeline-v2-mtst7` | success |
| V2 | `screener-2026-06-12-1781453187444` | `pipeline-v2-zbxxw` | success |
| V3 | `screener-2026-06-12-1781493330819` | `pipeline-v2-lfqzh` | success |
| V4 | `screener-2026-06-12-1781515300273` | `pipeline-v2-7k7qq` | success?pipeline direct trigger + post-verify callback closed root chain |

## L0~L4 ????

| Layer/Metric | V1 | V2 | V3 | V4 |
|---|---:|---:|---:|---:|
| L0 universe pass | 506 | 506 | 506 | 506 |
| L0 universe drop | 1472 | 1472 | 1472 | 1472 |
| L0.5 restricted/hard-gate count | 545 | 542 | 542 | 542 |
| L1 strategies | 75 | 75 | 75 | 75 |
| L1 strategy pool entries | 644 | 644 | 626 | 626 |
| L1 deduped strategy symbols | 78 | 80 | 73 | 73 |
| Broad strategy ML evidence queue unique | 68 | 71 | 64 | 64 |
| Research-only symbols | 0 | 9 | 9 | 9 |
| L1.25 portfolio metrics | n/a | 30 | 30 | 30 |
| L1.25 metric source rows | n/a | 2014 | 2014 | 2014 |
| L1 strategy matrix cells | n/a | n/a | 37950 | 37950 |
| L1 active labeled candidates | n/a | n/a | 457 | 457 |
| L1.5 router slate | 68 | 21 | 19 | 20 |
| L1.5 observe-only | n/a | 485 | 487 | 486 |
| L1.5 final seed unique | 68 | 21 | 19 | 20 |
| L2 core ML kept | n/a | n/a | 15 | 15 |
| L3 formal pass unique | 39 | 40 | 12 | 12 |
| Prediction rows | 578 | 637 | 166 | 170 |
| Prediction symbols | 68 | 76 | 19 | 20 |
| D1 model names count incl. ensemble | 10 | 10 | 10 | 10 |
| Daily recommendation rows | 92 | 45 | 43 | 44 |
| Alpha allocation rows | 39 | 13 | 12 | 16 |
| L4 sparse selected | 3 | 0 | 0 | 0 |

## V4 ????

- V4 ???? FinLab???? callback `force=false` ? queue lock ?????? `force=true` ?? historical supplemental bug?TWSE/TPEX endpoint ???? 2026-06-15?readiness ? 2026-06-12????????? pipeline/post-verify callback ? root success supersede??? V4 ????? downstream ???screener -> regime-compute -> ml-controller pipeline?
- V4 L1.25 ??? FinLab Portfolio Intelligence?`finlab-portfolio-intelligence-v1`?source=`strategy_reward_ledger+strategy_decision_log+backtest_results`?row_count=2014?metric_count=30?
- V4 ??? L1 strategy matrix?506 ? ? 75 ?? = 37,950 cells?active labeled candidates=457???? PLE/Listwise Router ?????? matrix????? 20/64 ????
- V4 L1.5 final seed=20 ???????? V3 ? 19 ?????? `4721`?
- V4 pipeline summary?L2 core gate kept 15/20?L3 formal ranked 12/20?D1 ?? prediction rows=170?recommendation rows=44?
- V4 L4 sparse ?? 0 ??log ?? `sparse_tangent_inverse_risk selected 0/3 capacity BUY rows: []`??? sparse ?????? V4 ???

## Overlap / Diversity

### L1.5 final seed
| Pair | Intersection | Union | Jaccard |
|---|---:|---:|---:|
| V1 vs V2 | 7 | 82 | 0.0854 |
| V1 vs V3 | 6 | 81 | 0.0741 |
| V1 vs V4 | 7 | 81 | 0.0864 |
| V2 vs V3 | 19 | 21 | 0.9048 |
| V2 vs V4 | 20 | 21 | 0.9524 |
| V3 vs V4 | 19 | 20 | 0.9500 |

### L3 formal pass
| Pair | Intersection | Union | Jaccard |
|---|---:|---:|---:|
| V1 vs V2 | 26 | 53 | 0.4906 |
| V1 vs V3 | 4 | 47 | 0.0851 |
| V1 vs V4 | 4 | 47 | 0.0851 |
| V2 vs V3 | 12 | 40 | 0.3000 |
| V2 vs V4 | 8 | 44 | 0.1818 |
| V3 vs V4 | 8 | 16 | 0.5000 |

### L4 sparse selected
| Pair | Intersection | Union | Jaccard |
|---|---:|---:|---:|
| V1 vs V2 | 0 | 3 | 0.0000 |
| V1 vs V3 | 0 | 3 | 0.0000 |
| V1 vs V4 | 0 | 3 | 0.0000 |
| V2 vs V3 | 0 | 0 | n/a |
| V2 vs V4 | 0 | 0 | n/a |
| V3 vs V4 | 0 | 0 | n/a |

## V4 Symbol Details

### V1
- L1.5 final seed (68): 1227, 1307, 1342, 1723, 1808, 1904, 2006, 2030, 2103, 2241, 2348, 2379, 2425, 2428, 2461, 2497, 2501, 2520, 2542, 2597, 2637, 2645, 2820, 2851, 2881, 2884, 2889, 2890, 2892, 3003, 3022, 3088, 3152, 3213, 3293, 3322, 3691, 4306, 4534, 4541, 4551, 4721, 4904, 4934, 5410, 5434, 5471, 5498, 5522, 5534, 6153, 6177, 6196, 6204, 6214, 6414, 6901, 6944, 7749, 7777, 7780, 8076, 8121, 8932, 9910, 9914, 9939, 9946
- L3 formal pass (39): 1227, 1723, 1808, 1904, 2006, 2030, 2103, 2348, 2379, 2428, 2497, 2542, 2597, 2637, 2645, 2820, 2851, 2881, 2884, 2889, 2890, 2892, 3003, 3152, 3293, 3691, 4551, 4904, 5534, 6153, 6177, 6196, 6414, 6944, 7780, 8076, 9914, 9939, 9946
- L4 sparse selected (3): 2542, 2820, 6944

### V2
- L1.5 final seed (21): 1319, 1560, 1605, 1723, 1789, 1904, 2379, 2412, 2476, 3321, 3576, 3702, 4721, 4904, 5434, 5471, 6121, 6202, 6244, 6443, 6525
- L3 formal pass (40): 1227, 1319, 1342, 1605, 1723, 1789, 1808, 1904, 2006, 2030, 2103, 2348, 2379, 2412, 2461, 2542, 2637, 2820, 2851, 2881, 2884, 2889, 2890, 2892, 3293, 4541, 4904, 4934, 5434, 5471, 5534, 6121, 6177, 6244, 6443, 6944, 7780, 8076, 8932, 9939
- L4 sparse selected (0): none

### V3
- L1.5 final seed (19): 1319, 1560, 1605, 1723, 1904, 2379, 2412, 2476, 3321, 3576, 3702, 4904, 5434, 5471, 6121, 6202, 6244, 6443, 6525
- L3 formal pass (12): 1319, 1605, 1723, 1904, 2379, 2412, 4904, 5434, 5471, 6121, 6244, 6443
- L4 sparse selected (0): none

### V4
- L1.5 final seed (20): 1319, 1560, 1605, 1723, 1904, 2379, 2412, 2476, 3321, 3576, 3702, 4721, 4904, 5434, 5471, 6121, 6202, 6244, 6443, 6525
- L3 formal pass (12): 1560, 1605, 1723, 1904, 2379, 2412, 2476, 3702, 4721, 4904, 5434, 6121
- L4 sparse selected (0): none

## ??

V4 ??? downstream rerun ? L1.25+L1.5+L2/L3/L4 ?????????? top-k????? 64 ? broad strategy evidence queue ??? ML slate??? slate ? 20 ??L2 ????? 15?L3 ?? 12?L4 sparse ?? 0?production root scheduler ?? post-verify callback ?? success?historical supplemental mismatch ??????????????

??????? production historical replay ???Worker `runDailyUpdate(force=true)` ???????? TWSE/TPEX supplemental?? supplemental source ??????????? `MAX(date)=2026-06-15` ?? 2026-06-12 readiness?????? historical rerun ?? continuation?? bypass supplemental???? indicator/screener/regime/pipeline?? scheduler log ??? root error ???
