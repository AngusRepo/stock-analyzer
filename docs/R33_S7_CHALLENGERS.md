# R33 §7 挑戰者 trainer：給 W1 的介面（W2，2026-10-25）

branch `r33/s7-challengers`。單一來源是 `ml-service/app/challenger_models.py`：`CHALLENGERS`（模型身分）、`LIFECYCLE_SLOTS`（lifecycle 要排的）、`DEFERRED_CHALLENGERS`（延後的）。

**Wei 10/25 決定（選項 C）**：11/1 只排一格 `linear_neutral`，傳 `neutralization_exposures="auto"`。trainer 每個 fold 自己決定用哪一版：
- PIT 產業 snapshot（`pit_status=pit_snapshot`，不接受 backfill）的第一天 ≤ 該 fold 訓練窗第一個訊號日 → `LinearNeutral`（產業 dummy＋log 市值）。
- 否則 → `LinearNeutralSize`（只做 log 市值中性化＋同日去均值），完全 PIT。
- 結果寫在回傳的 `model` 與 `exposure_coverage.auto_resolution`（含 reason）。兩個 model_name 的 OOF 分開累積。
- 以目前資料（PIT 從 2026-07-31 起、訓練窗從 2023-04-06 起），11/1 每個 fold 都會解成 `LinearNeutralSize`。
- `GNNIndustry`／`GNNIndustryCosine` 延後，等 PIT 產業覆蓋訓練窗。

## 1. 模型與 Modal function

| model_name | Modal function | 關鍵 payload | 需要產業 sidecar | 11/1 可跑 |
|---|---|---|---|---|
| `LinearNeutralSize` | `train_linear_neutral_universal`（CPU 4 core／32 GiB） | `neutralization_exposures="log_mktcap"` | 否 | ✅ 從 2023-04 起完全 PIT |
| `LinearNeutral` | 同上 | `neutralization_exposures="industry_log_mktcap"` + `industry_exposure` | 是 | ❌ 由 auto 在 PIT 覆蓋後自動切入 |
| `GNNIndustry` | `train_gnn_industry_universal`（L4、4 core、16 GiB） | `graph_variant="industry"` + `industry_exposure` | 是 | ❌ 延後 |
| `GNNIndustryCosine` | 同上 | `graph_variant="industry_plus_cosine"` + `industry_exposure` | 是 | ❌ 延後（比較用） |

lifecycle 一般只傳 `neutralization_exposures="auto"`，上面兩個明確值保留給研究或重跑。

### 共用 payload
與 r32 harness 的 fold payload 相同：
- `gcs_prefix`、`batch_count`、`feature_semantic_version=formal131-without-unverified-daily-owners-v1`、`feature_release_mode=approved_full131_v1`。
- `generation_mode`：
  - fold 用 `purged_oof`，並帶 `cohort_id`、`fold_id`、`window_id`、`train_start`、`train_end`、`test_start`、`test_end`、`label_horizon_days=5`；
  - full-fit 用 `oof_full_fit_release`，帶 `as_of_date`，不帶 range。
- `output_model_version`。

### 各模型額外欄位
- **LinearNeutral\***：`validation_folds`（inner purged CV 的折數；harness 現值是 8）。`auto` 模式不可傳 `model_name`；明確 exposure 時 `model_name` 可以不傳，有傳就必須一致，否則 fail。`industry_exposure` 在 `auto` 模式是選填（沒有就是市值版）。
- **GNN\***：沿用現行 GNN profile 的超參數（epochs 36、hidden 64 等），只多一個 `graph_variant`。
- **`industry_exposure`**：`{"path": "<GCS 路徑>", "sha256": "<hex>"}`。sha256 不符就 fail。

## 2. 輸出路徑（格式與主模型相同）

### fold OOF
- 路徑：`{gcs_prefix}/oof/{cohort_id}/{fold_id}/{model_name.lower()}.npz`。
- schema：`active8-oof-predictions-v2`，寫入者 `save_oof_prediction_artifact`。rank 定義為同市場、同日的 average-tie percentile，和 `active8_oof_stacker` 讀的一樣。

### artifact
- **LinearNeutral\***：
  - fold：`{gcs_prefix}/frozen_models/{linearneutral|linearneutralsize}/{version}.joblib`；
  - full-fit：`universal/{…}/{version}.joblib`。
  - metadata 一律是 `model-artifact-v2`，與 tree 模型相同，寫入者 `_save_universal_versioned_model`。
- **GNN\***：
  - `universal/{gnn_industry|gnn_industry_cosine}/{version}.pt` 加上 `metadata_{version}.json`，與現行 GNN 同一格式。
  - 現行 GNN 寫到 `universal/gnn/` 不變。

### 回傳值
- 帶 `model`、`oof_artifact.path`、`ic_tracking[model_name]`、`artifact_registrations[model_name]`（`promotion_eligible=False`）。
- LinearNeutral\* 另外帶 `exposure_coverage`。

## 3. 在 lifecycle 裡怎麼接（W1）

在 R33 profile 加上 `challenger_models`，值取自 `LIFECYCLE_SLOTS`：

```python
from app.challenger_models import LIFECYCLE_SLOTS
"challenger_models": {slot: {"modal_function": spec["modal_function"], "payload_config": spec["payload_config"]}
                      for slot, spec in LIFECYCLE_SLOTS.items()}
# 每個 fold／full-fit：{**共用 payload, **payload_config, "industry_exposure": <有上傳的 sidecar 才帶>}
# 產出身分看回傳的 result["model"]（LinearNeutralSize 或 LinearNeutral）
```

接線規則：
- challenger 不在 `alpha_model_roster`，也不在 `ACTIVE8_MODEL_NAMES`、`release_training_contract.models`、registry 的 full-fit 完成條件、stacker 裡。stacker 會忽略不在 order 裡的 model（`active8_oof_stacker.py`），而 `test_challenger_models.py` 會擋住它們被誤加進 roster。
- 不要把 `release_training_contract` 綁到 challenger。attestation 只認 roster 裡的模型；challenger 的 effective config 記錄在 metadata 的 `linear_neutral`／`training_params`。
- E2 評估讀同一個 cohort 下每個 challenger 的 OOF npz，跨月累積時以 `model_name` 為身分。exposure 或 graph 定義一改，就必須換 model_name，舊 OOF 不可以混用。
- 用明確 `industry_log_mktcap` 或 GNN 產業臂時，缺 PIT 產業的列一律排除；train 或 test 列空了就 fail-closed，這是刻意設計的。`auto` 只在 PIT 覆蓋整個訓練窗時才切產業版，所以不會出現這種部分覆蓋。

## 4. 方法要點

### LinearNeutral\*
1. 以「訊號日 × 市場別」為單位，和 net-v4 target rank 同一個 cohort。131 個特徵先轉成置中的 percentile rank。
2. 對 exposure 做 OLS 取殘差。exposure 是產業 dummy 和／或標準化後的 `size_log_mktcap`；後者就是 FinLab `etl:market_value` 的逐日 sealed PIT 值。
3. 殘差按訓練集 std 標準化之後做 ridge，target 是 global cross-sectional rank，和 tree 模型一樣。

ridge alpha 的選法：
- 用 inner purged blocked CV：連續日期區塊，訓練列的 label 區間只要碰到 test 區塊，前後兩側都 purge。
- 候選 alpha 由訓練集 Gram spectrum 解出，使有效自由度 df = 1…rank−1。
- 以「同日 rank IC 平均」最大者為準；平手時取較大的 alpha。
- 沒有人為設定的 alpha 範圍。

結構限制：
- `us_sentiment_score`、`advance_ratio` 是同日全市場常數，中性化後恆為 0。
- 線性的橫斷面排序模型本來就無法靠同日常數改變排名，這是結構限制，不是 triage 剔除。要用市場因子，得做 interaction，屬於 W4 範圍。

### GNNIndustry\*
- **現行邊的定義**（`gnn_graph_contract.build_feature_sector_edge_index`）：
  - 同一日內，特徵 cosine 取 |sim| 的 top-k=8；
  - 候選鄰居要嘛 |sim| ≥ 0.25，要嘛同產業，才連邊；
  - 邊是對稱的。
- **新版**：
  - `industry`：同日、同一個 PIT 產業的所有配對（clique）。
  - `industry_plus_cosine`：clique 再聯集上面的 cosine 邊（不帶產業標籤）。
- 沒有 PIT 產業的節點直接排除。
- 現行 GNN 的程式路徑與 metadata 完全不變。

## 5. 已知事實與待 Wei 決定

**產業 PIT（D1 唯讀查證）**
- `finlab_taxonomy_tags` 只有 2026-09-02 一份，而且會被覆寫。
- PIT 版本 `sector_taxonomy_membership_snapshots_v1` 只涵蓋 2026-07-31～10-15，共 39 日，44～45 類（不是 33 類）。
- 2026-07-31 以前沒有 PIT 產業。
- ✅ Wei 10/25 選 C：11/1 只跑市值版（auto slot），產業版等 PIT 覆蓋後自動切換，GNN 產業臂延後。backfill（選項 B）沒有採用，`auto` 也不接受 backfill sidecar。

**現行 GNN 的 train/serve 不一致（主 session Slice A 處理）**
- canonical prep 的 `sectors` 欄全部是 "unknown"，所以訓練時同產業條件從來沒有生效；serving 端讀的是 `stock_meta.sector_key`。
- Wei 10/25 決定：線上關掉 sector 連線，讓 train＝serve。產業圖的效果之後由 `GNNIndustry` 挑戰者驗證。

**產業 sidecar 工具**
- `ml-service/scripts/build_industry_exposure_sidecar.py`：從 D1 唯讀讀取、只產出本機檔，上傳到 GCS 要另外拿到 go。

## 6. Smoke（1 fold，r32 plan-a 的 w6）

- **指令**：`ml-service/scripts/s7_challenger_smoke.py`。
  - 預設只排 `linear_neutral`（auto）slot，只印出 payload；加 `--execute` 才會用 ephemeral `app.run()` 執行（不 deploy）。
  - GNN 產業臂要另加 `--include-deferred-gnn` 和 sidecar 參數。
  - 會寫 GCS：smoke cohort 的 OOF、frozen_models，以及 `universal/gnn_industry*/`。
- **成本估計**：依 Modal 定價，以及 r32 實測的 GNN fold 340–500 s、約 1.6M 訓練列。

| 模型 | 估計耗時 | 估計單 fold 成本 |
|---|---|---|
| `LinearNeutralSize` | 約 3–5 分 | 約 US$0.04 |
| `LinearNeutral` | 約 3–5 分 | 約 US$0.04 |
| `GNNIndustry` | 約 450–700 s | 約 US$0.15–0.22 |
| `GNNIndustryCosine` | — | 約 US$0.25 |

  - 產業 clique 估計每日約 17 萬條邊，graph cache 約 1.2 GB。
  - 全部 4 個模型跑一次 smoke 約 US$0.5，上限建議 US$1.5。
  - 只跑 auto slot 的 smoke 約 US$0.04（上限 US$0.1）。
  - 11/1 正式跑（7 fold 加 full-fit，選 C）：約 US$0.3。

### Smoke 實跑結果（2026-10-25，Wei 核准，source `c9b7f7093`）
- `linear_neutral`（auto）→ `LinearNeutralSize`，reason `no_industry_sidecar`；train 1,673,641 列、test 21,409 列（與主模型 tabular OOF 同列數）。
- alpha 101,543（不在 grid 邊界），inner-CV IC 0.1109；fit 52 s，function 總耗時 112 s，約 US$0.014。
- w6（2026-09-09～09-22，10 日 × 2 市場）OOS 平均同日 rank IC −0.050（t −2.40）。同 window 主模型：ExtraTrees −0.094、LightGBM −0.019、XGBoost −0.019、TabM −0.008、GNN −0.007、iTransformer +0.043、TimeXer +0.051、PatchTST +0.074。單一 fold 不能下結論，E2 看三窗累積。
- 寫入：`r32-plan-a-canonical/oof/s7-challenger-smoke-20261028/w6/linearneutralsize.npz`、`r32-plan-a-canonical/frozen_models/linearneutralsize/{s7-challenger-smoke-20261028-w6.joblib, metadata_…json}`、`r32-plan-a-canonical/manifests/s7-challenger-smoke-20261028-w6-linearneutralsize.json`。
