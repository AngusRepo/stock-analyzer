# 2026-06-12 Evening Chain 三版比較報告

## Version 定義

- v1：2026-06-12 原始 evening-chain，`screener-2026-06-12-1781275176039`，pipeline `pipeline-v2-mtst7`。
- v2：2026-06-14 rerun，`screener-2026-06-12-1781453187444`，pipeline `pipeline-v2-zbxxw`。
- v3：2026-06-15 修補版 rerun，`screener-2026-06-12-1781493330819`，pipeline `pipeline-v2-lfqzh`。

## v3 Closure

- Trigger: `2026-06-15T02:48:26Z`
- FinLab: `finlab-v4-3y-20260612-1781491702795`, 5,556,201 rows, 11 datasets, callback success.
- Update: FinLab canonical ready + TWSE/TPEX supplemental complete.
- Indicator queue: `2026-06-12-mqemy3et`, 4 shards, success.
- Pipeline: `pipeline-v2-lfqzh`, success, `preds=166`, `recos=12`, `errors=0`.
- Verify: `verify-v2-hptnj`, success; business status skipped because historical window had no pending predictions.
- Post-verify: success after Worker patch; root `evening-chain` final status is success at `2026-06-15T03:41:17Z`.

## Production Patch Applied

Root cause found during v3: historical `strategy-learning` did write decision/reward evidence, but then attempted to refresh live `strategy_policy_state` inside Worker callback closure. That exceeded the callback completion window and left `post-verify-chain` / `evening-chain` stuck at triggered.

Patch:

- `worker/src/lib/strategyLearning.ts`: `runStrategyLearningClosure(..., { persistPolicy })`.
- `worker/src/lib/postMarketChain.ts`: historical reruns pass `persistPolicy: false`; current business date still refreshes live policy.
- Worker deployed: `bbf9cedf-b5b7-48ad-8748-02d4ba7b613d`.
- Verification: `npx tsx src/lib/postMarketChainContract.test.ts`; `npm.cmd run type-check`.

## Layer Counts

| Layer / stage | v1 original | v2 rerun | v3 rerun |
| --- | ---: | ---: | ---: |
| L0 universe pass | 506 | 506 | 506 |
| L0 universe drop | 1472 | 1472 | 1472 |
| L1 strategy count | 75 | 75 | 75 |
| L1 strategy pool entries | 644 | 644 | 626 |
| L1 deduped strategy symbols | 78 | 80 | 73 |
| L1.25 portfolio metrics | n/a | 30 | 30 |
| L1.5 strategy matrix cells | n/a | n/a | 37,950 |
| L1.5 router ML slate | n/a | 21 | 19 |
| L1.5 observe-only | n/a | 485 | 487 |
| L1.5 final seed | 68 | 21 | 19 |
| Strategy ML queue | 68 | 71 | 64 |
| Research-only lane | 0 | 9 | 9 |
| L3 formal pass | 39 | 40 | 12 |
| Daily recommendation rows | 92 | 45 | 43 |
| L4 sparse selected | 3 | 0 | 0 |

## L2 / L3 v3 Model Coverage

| Model | v3 symbols |
| --- | ---: |
| LightGBM | 19 |
| XGBoost | 19 |
| ExtraTrees | 19 |
| ensemble | 19 |
| TabM | 15 |
| GNN | 15 |
| DLinear | 15 |
| PatchTST | 15 |
| iTransformer | 15 |
| TimesFM | 15 |

All v3 prediction signals were `hold`; no BUY-like rows reached L4.

## Overlap

| Set | v1 vs v2 | v2 vs v3 | v1 vs v3 |
| --- | ---: | ---: | ---: |
| L1.5 final seed Jaccard | 0.0854 | 0.9048 | 0.0741 |
| L3 formal pass Jaccard | 0.4906 | 0.3000 | 0.0851 |
| L1 breadth universe Jaccard | 0.6393 | 0.9672 | 0.6484 |

Interpretation: v3 is structurally close to v2 at L1.5, but stricter by 2 final seed names. It is not reverting to v1/top-k behavior.

## L4 Sparse

v3 daily rows: 43 symbols.

v3 BUY-like rows: 0.

v3 sparse selected: 0.

This is expected under the no-forced-fill rule: L4 can select zero when sparse allocation finds no positive expected edge.

## Evidence

- KV root closure: `scheduler:run:evening-chain:2026-06-12`.
- D1 screener v3: `screener_funnel_runs.run_id = screener-2026-06-12-1781493330819`.
- D1 strategy decision evidence: 945 rows, 45 strategies, 21 symbols.
- D1 strategy reward evidence: 178 rows.
- Existing v1/v2 artifacts remain in `original/` and `rerun/`; this file records v3.
