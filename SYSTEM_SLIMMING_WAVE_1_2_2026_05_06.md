# StockVision 瘦身第一波 / 第二波與效能掃描

日期：2026-05-06

原則：

- 不降級、不砍準確度來源、不大重構 production flow。
- 先瘦 data/research/runtime 重複成本，再碰模組邊界。
- 不做 `retrain`、`deploy`、`commit`、`push`。
- 所有替換必須保留 parity gate：coverage、missing rate、IC drift、recommendation drift、artifact contract。

## Executive Summary

第一波先做「低風險、立刻降低維運/運算噪音」：

1. Modal batch predict 成本實測與 chunk tuning。
2. model/GCS load cache 指標化。
3. repo hygiene 與 generated artifacts 清理規則。
4. research jobs budget lane，避免 expensive jobs 擠壓 daily production。
5. FinLab adapter sidecar，先替換 data cleaning/research，不替換 production ML contract。

第二波做「單一 owner 與重複路徑收斂」：

1. verify/recommendation owner 收斂到 `ml-controller`，Worker 退成 trigger/read layer。
2. Worker queue daily update 由逐股序列處理改成 bounded parallel + batched metadata query。
3. D1 SQL 熱點改成 grouped aggregate / window precompute，降低 N+1 查詢。
4. backtest/optuna/research loader 改成批次讀取或 artifact-first。
5. 大檔拆 ownership module，但不改策略邏輯。

## 第一波：低風險瘦身

### W1-1. Modal batch predict 實測與調參

現況：

- `ml-controller/services/modal_client.py` 已有 `predict_batch_v2`。
- 預設 `MODAL_PREDICT_BATCH_SIZE=40`。
- `cost_events` 已能記錄 `function_name`、`wall_sec`、`compute_sec`、`chunk_count`、`chunk_size`。

問題：

- 目前還缺完整 production evening run 的 before/after 成本比較。
- `daily_pipeline_v2` 同時啟動 feature batch、Chronos、DLinear、PatchTST、Kalman、Markov、challenger DLinear、challenger PatchTST。名稱是 batch，但實際上是多個 Modal function fan-out。

建議：

- 保留所有 alpha voters，不降級。
- 用 `cost_events` 做 3 組 production run 比較：
  - chunk 20
  - chunk 40
  - chunk 80
- 指標：
  - total wall time
  - total Modal compute sec
  - chunk error rate
  - per-symbol success rate
  - GCS model load count
  - predictions written count
- 若 time-series / state-space overlay 是 0 成功或長期 degraded，改由 model_pool lifecycle 自動 skip，不手動刪模型。

候選檔案：

- `ml-controller/services/modal_client.py`
- `ml-controller/graphs/daily_pipeline_v2.py`
- `ml-service/app/batch_prediction.py`
- `ml-service/modal_app.py`

### W1-2. GCS/model load cache 指標化

現況：

- `ml-service/app/model_store.py` 已有 `_MODEL_LOAD_CACHE`。
- `predict_stock_v2` 仍會對多個 active/challenger model 做 `load_model`。

問題：

- cache hit/miss 沒有被成本化。
- 無法直接知道每天是否重複下載同一批 model artifacts。

建議：

- 在 `load_model` 回傳 meta 中加入 container-local cache metrics：
  - `model_cache_hit`
  - `model_cache_miss`
  - `blob_path`
  - `artifact_size_bytes`，可選
- 在 `predict_batch_v2` response aggregate 加上：
  - `model_cache_hits`
  - `model_cache_misses`
  - `gcs_downloads`
- 只做 observability，不改 prediction 結果。

候選檔案：

- `ml-service/app/model_store.py`
- `ml-service/app/prediction_runtime.py`
- `ml-service/app/batch_prediction.py`

### W1-3. Repo hygiene 與 workspace 噪音

現況：

- 工作目錄曾出現大量 `pytest-cache-files-*`。
- 目前 `git status` 顯示使用者改動在前端檔案，另有未追蹤截圖。

建議：

- 補 `.gitignore` 規則：
  - `pytest-cache-files-*`
  - `screen_*.png`
  - `uiux_gemini_package_*/`
  - `*.zip`，若非 release artifact
- 不刪使用者檔案，先只建立規則與清單。
- generated artifact 改放 `C:\tmp` 或 artifact storage，不放 repo root。

收益：

- 降低搜尋噪音。
- 降低 code review 干擾。
- 降低跨 session 接手成本。

### W1-4. Research jobs budget lane

現況：

- Optuna、feature selection、SHAP、walk-forward 都有價值，但不該和 daily production 混在同一成本語意。
- `feature_selection.py` 會逐一列出並下載 `universal/prep/*.npz`。

建議：

- 明確分三條 lane：
  - `daily_production`
  - `weekly_audit`
  - `monthly_research`
- expensive jobs 必須有：
  - dry-run
  - idempotency key
  - max samples / max trials
  - budget label
  - cost_events output
- feature selection 加上 prep manifest：
  - 路徑
  - row count
  - sha/hash
  - created_at
  - feature count
- 有 manifest 時先讀 manifest，不每次 list/download 全部 blob。

候選檔案：

- `ml-service/app/feature_selection.py`
- `ml-service/modal_app.py`
- `ml-controller/routers/optuna.py`
- `ml-controller/services/cost_tracker.py`

### W1-5. FinLab sidecar adapter

定位：

- FinLab 可以瘦 data ingestion / cleaning / research。
- 不直接取代 production prediction schema、risk engine、macro-leading feed。

第一批適合替換：

- 財報
- 月營收
- 籌碼
- 融資融券
- 基本面衍生欄位
- research factor catalog

不建議第一批替換：

- `worker/src/lib/usLeading.ts` 的 VIX / DXY / SOX / TSM / HY OAS 類 macro-leading feed。
- `ml-service/app/features/__init__.py` 既有 106 features production schema。
- risk / paper trading / model promotion / validation。

做法：

- 建 `finlab_adapter -> canonical_feature_frame -> existing feature schema`。
- 先產出 R2/GCS artifact，不直接改 serving path。
- 對每個 feature 做 overlap matrix：
  - `finlab_direct`
  - `finlab_derive`
  - `local_only`
  - `macro_only`
  - `trading_runtime_only`

## 第二波：單一 owner 與效能結構收斂

### W2-1. verify/recommendation owner 收斂

現況：

- `ml-controller/services/verify_service.py` 是 `worker/src/lib/predictionVerifier.ts` 的 1:1 port。
- `ml-controller/services/recommendation_service.py` 仍保留 legacy / fallback / backward compat 邏輯。

風險：

- parity drift。
- incident triage 會分不清 production owner。
- 同一行為兩邊改，維護成本翻倍。

建議：

- production owner 固定在 `ml-controller`。
- Worker 只保留 trigger、status read、dashboard read。
- 舊 Worker implementation freeze，標成 emergency/manual only。
- 加 owner contract tests，確保 cron 不再走舊 verify/recommendation owner。

候選檔案：

- `ml-controller/services/verify_service.py`
- `worker/src/lib/predictionVerifier.ts`
- `ml-controller/services/recommendation_service.py`
- `worker/src/lib/controllerWorkflows.ts`

### W2-2. `update_model_accuracy` SQL cost 收斂

現況：

- `update_model_accuracy()` 先查 distinct `(stock_id, model_name)`。
- 對每個 group 跑 3 個 period。
- 每個 period 內又跑多個 aggregate query。

風險：

- group 數增加後，D1 query count 會線性放大。
- 這是典型 SQL cost hot path。

建議：

- 改成 grouped aggregate 一次算：
  - all
  - 30d
  - 90d
  - low/high risk
  - win/loss
  - trade outcome
- 或建立 nightly materialized summary table：
  - `model_accuracy_daily_rollup`
  - 再 upsert `model_accuracy`
- 第一階段先新增新 implementation + parity test，不刪舊 function。

候選檔案：

- `ml-controller/services/verify_service.py`

### W2-3. Worker queue daily update：keyset cursor 已對，但內部逐股序列

現況：

- `processUpdateBatch` 使用 `id > cursor`，不是 OFFSET，這點是對的。
- 但每個 stock 依序做：
  - count stock_prices
  - optional fetchAndStoreStockData
  - computeAndStoreIndicators
  - optional crawlAndStoreNews
  - sleep 25ms/300ms

風險：

- queue shard 雖然有 cursor，但 batch 內仍是序列。
- D1 count query 是每股一次。
- news sleep 會拖長整批。

建議：

- 先批次查 currentBatch 的 `price_count`：
  - `SELECT stock_id, COUNT(*) FROM stock_prices WHERE stock_id IN (...) GROUP BY stock_id`
- `computeAndStoreIndicators` 用 bounded concurrency，例如 3-5。
- `crawlAndStoreNews` 獨立成 news queue，不阻塞 price/indicator update。
- 保留 keyset cursor，不改成 OFFSET。

候選檔案：

- `worker/src/lib/updateOrchestrator.ts`

### W2-4. Screener selection flags 重複查詢

現況：

- `loadSelectionHistoryFlags` 本身已是 set-based query。
- 但 `runMarketScreener` 先對 policy pool 查一次，後面又對 final candidates refresh 一次。

建議：

- 只查一次 superset，後續用 Map filter。
- 若 final candidates 包含 emerging lane，再把 emerging symbols 一起納入 superset。

候選檔案：

- `worker/src/lib/marketScreener.ts`

### W2-5. Sector leader bonus N calls

現況：

- `marketScreener` 對 final candidates 以 concurrency 5 呼叫 `sectorLeaderBonus`。
- 如果 `sectorLeaderBonus` 內部查 D1，每晚就是 N 次 D1 query。

建議：

- 改成 `loadSectorLeaderBonusMap(symbols)` 一次查完候選 + leader return series。
- 先保留舊 function，新增 batch function，做 output parity。

候選檔案：

- `worker/src/lib/marketScreener.ts`
- `worker/src/lib/sectorCorrelation.ts`

### W2-6. backtest/optuna N+1 D1 loader

現況：

- `ml-controller/services/backtest_service.py` 逐股查 prices，再逐股查 predictions。
- `ml-controller/routers/optuna.py` 先抓 top stocks，再逐股抓 price rows。
- `backtest_engine.py` 已有 date chunk loading，比逐股查更適合大範圍回測。

建議：

- backtest route 優先走 `backtest_engine` 的 chunked loader。
- optuna loaders 改成單次查 `(stock_id IN top_ids)` 後 Python group by。
- 研究用途資料優先從 prep/artifact 讀，不每次打 D1。

候選檔案：

- `ml-controller/services/backtest_service.py`
- `ml-controller/routers/optuna.py`
- `ml-controller/services/backtest_engine.py`

### W2-7. Prediction write D1 statement volume

現況：

- `write_predictions_to_d1` 對每個 symbol：
  - delete ensemble
  - delete non-ensemble
  - insert ensemble
  - insert per-model rows
  - insert challenger rows
- 這是完整 audit/IC tracking 所需，但 statement volume 很高。

建議：

- 不刪 per-model audit。
- 優化方向是 statement 合併：
  - run-date scoped pre-delete 一次做完。
  - per-symbol 只 insert。
  - 或改用 unique key + upsert。
- 先加 metrics：
  - statements_count
  - inserted_rows
  - delete_rows
  - per_model_rows
  - challenger_rows

候選檔案：

- `ml-controller/services/recommendation_service.py`

## 效能掃描結果

### 最大 source 熱點

| 檔案 | 行數 | 評估 |
|---|---:|---|
| `ml-controller/services/backtest_engine.py` | 3761 | 回測核心，已有 chunk 與 numpy fast path；避免大重構，優先復用它取代舊逐股 backtest route。 |
| `worker/src/lib/marketScreener.ts` | 1902 | screener god module；先做 query/cache/batch 優化，再拆 owner。 |
| `ml-service/app/universal_training.py` | 1774 | training path，不碰 production predict；先加 cost/profiling。 |
| `worker/src/lib/tradingConfig.ts` | 1541 | config/fallback 多，適合 owner freeze 與 schema cleanup。 |
| `ml-controller/routers/model_pool.py` | 1506 | lifecycle 路由大，但屬治理面；避免和瘦身第一波混在一起。 |
| `ml-controller/services/recommendation_service.py` | 1388 | D1 write statement volume 與 legacy/fallback 熱點。 |
| `worker/src/lib/twseApi.ts` | 1175 | FinLab adapter 最可能瘦的區域之一。 |
| `ml-controller/graphs/daily_pipeline_v2.py` | 1080 | 多路 Modal batch fan-out 成本熱點。 |

### 具體可優化點

| 類型 | 位置 | 現況 | 建議 |
|---|---|---|---|
| fake/multi batch fan-out | `daily_pipeline_v2.node_ml_predict` | 一次 gather 多個 Modal batch function | 以 cost_events 衡量每一路收益；長期 0 成功或 degraded 由 model_pool skip。 |
| chunk tuning | `modal_client._modal_batch_predict_v2` | chunk size 預設 40 | 用 20/40/80 production run 比較。 |
| 序列 cursor | `updateOrchestrator.processUpdateBatch` | keyset cursor 正確，但 batch 內逐股序列 | price count 批次查、indicator bounded parallel、news 拆 queue。 |
| SQL cost | `verify_service.update_model_accuracy` | group x period x 多 aggregate query | grouped aggregate 或 rollup table。 |
| D1 statement volume | `recommendation_service.write_predictions_to_d1` | 每股多 delete + insert | run-date scoped delete 一次化或 upsert，先加 metrics。 |
| N+1 loader | `backtest_service.run_backtest` | 逐股查 prices/predictions | 改用 chunked loader 或一次查後 group。 |
| N+1 loader | `optuna._load_top_active_stocks_with_prices` | top stocks 後逐股查 price | 用 `stock_id IN (...)` 一次查。 |
| GCS blob scan | `feature_selection.run_feature_selection_pipeline` | list blobs 後逐一下載 npz | prep manifest + hash/row count；只在 manifest 變更時重讀。 |
| 重複 query | `marketScreener.loadSelectionHistoryFlags` usage | policy pool 與 final refresh 兩次 | 查 superset 一次。 |
| per-candidate D1 | `sectorLeaderBonus` usage | final candidates concurrency 5 逐檔呼叫 | batch sector bonus map。 |

## 建議落地順序

### Sprint A：不改行為，只加觀測與 hygiene

1. 新增 Modal run comparison script/report。
2. 加 model cache hit/miss metrics。
3. 加 prediction write statement metrics。
4. 補 `.gitignore` 規則。
5. 建 FinLab overlap matrix 文件/腳本。

驗證：

- `worker npm run type-check`
- `ml-controller` targeted tests for modal telemetry / recommendation provenance
- `ml-service` targeted tests for model_store / batch_prediction

### Sprint B：低風險 SQL/query 優化

1. `update_model_accuracy` 新增 grouped aggregate implementation。
2. `optuna` top stock price loader 改成 bulk query。
3. `backtest_service` 改走 chunked loader 或 artifact。
4. `marketScreener` selection flags 查一次。

驗證：

- 舊/新 output parity。
- D1 query count 對比。
- wall time 對比。

### Sprint C：owner freeze

1. verify production owner 固定 `ml-controller`。
2. recommendation production owner 固定 `ml-controller`。
3. Worker legacy path 標示 emergency/manual only。
4. dashboard/status read path 不變。

驗證：

- scheduler owner contract。
- prediction/recommendation provenance。
- daily pipeline smoke。

## 不建議做

- 不為了省錢降級模型或硬體。
- 不刪 8 alpha voters。
- 不把 FinLab 當 production schema replacement。
- 不用 OFFSET pagination 取代現有 keyset cursor。
- 不先拆大檔再談效能；先找 SQL/Modal/GCS 成本熱點。

---

## 效能優化 V2：State-space overlay 與 verify rollup

本節記錄 2026-05-08 針對 Cloud Run 成本上升的第二輪效能優化結論。原則是不降規、不降模型品質、不做大重構，而是把高成本流程接到正確決策位置，並移出不必要的同步等待。

### V2-1. Kalman / Markov 的正確角色

結論：

- `KalmanFilter` / `MarkovSwitching` 不應預設納入 alpha ensemble vote。
- 它們應作為 state-space overlay，接到：
  - `regime gate`
  - `risk confidence modifier`
  - `position cap / slate size`
  - `rank_signal_thresholds`
  - audit/explanation payload
- 若未接到上述任一決策點，就不應同步卡在 evening critical path。

目前 production code truth：

- `daily_pipeline_v2.node_ml_predict` 會呼叫 state-space batch：
  - `modal_client.state_space_overlays_batch_predict(...)`
- pipeline 會把結果掛到 in-memory prediction row：
  - `row["kalman_filter"]`
  - `row["markov_switching"]`
- `ensemble_v2` 先讀 5 個 feature model rank scores，再合併 3 個 time-series alpha predictors，形成 8 alpha voters。
- `KalmanFilter` / `MarkovSwitching` 已被排除於：
  - alpha ensemble vote
  - per-model IC tracking
  - challenger promotion / demotion
  - alternate alpha fallback

核心判斷：

- 目前設計定位正確：state-space overlay，不是 alpha peer。
- 目前 production wiring 未完成：有產出 overlay，但沒有真正接到 gate/modifier，也沒有寫入 `forecast_data.state_space_overlays`。
- 因此 Markov 目前屬於高成本、低消費價值路徑。

### V2-2. State-space overlay 應接入的決策點

建議把 state-space output 接到以下決策位置，而不是直接加入 ensemble vote。

#### MarkovSwitching：regime gate

用途：

- 估計市場或個股近期 regime probability。
- 在 bear / volatile regime probability 偏高時收緊交易條件。

可接入：

- `regime_aware_allocate`
- `alpha_allocation`
- `rank_signal_thresholds`
- `slate_size`
- `position_cap`
- `ranking_promotion` aggressive level

範例規則：

- `volatile_probability >= 0.65`
  - BUY threshold 上調。
  - ranking promotion 降低或暫停。
  - position cap 下修。
- `bear_probability >= 0.65`
  - 只允許 high confidence / high liquidity candidate。
  - 降低 slate size。

#### KalmanFilter：risk confidence modifier

用途：

- 估計 filtered trend、state uncertainty、price deviation。
- 不負責產生 BUY/SELL，而是修正 confidence 與風險暴露。

可接入：

- `confidence` haircut / boost
- `effective_confidence_threshold`
- `stop_loss / target` 的保守程度
- `alpha_context` explanation

範例規則：

- ensemble 看多，但 Kalman filtered trend 不支持：
  - confidence haircut。
- Kalman uncertainty 高：
  - 提高 confidence threshold。
  - 降低 position cap。
- Kalman trend 穩定且與 alpha 方向一致：
  - 小幅 confidence boost，但需設上限。

### V2-3. Markov 不應同步阻塞 evening chain

已觀測數據：

- `SCHEDULER_PERFORMANCE_TRACKING_2026_05_06.md` 記錄 2026-05-07 D run：
  - `KalmanFilter=2.813s`
  - `MarkovSwitching=427.375s`
  - pipeline app elapsed `599.440s`
- Markov 是主要 ML wait 來源之一。

優化方向：

1. Kalman 可保留同步，因為成本低且可作 confidence modifier。
2. Markov 改成以下任一模式：
   - cache-first：同一 stock / same price window 不重跑。
   - async overlay：推薦先 materialize，Markov 後補 overlay。
   - regime refresh only：只有價格結構或市場 regime 明顯變動才重算。
   - off-hot-path：寫入 overlay table，由 dashboard / report / next-run gate 使用。
3. 若 Markov 要保留在 critical path，必須先完成 gate 接線，否則沒有決策消費價值。

### V2-4. Ensemble V2 模型邊界

容易誤解的地方：

- `ensemble_v2` 不是只讀 `Chronos / DLinear / PatchTST`。
- 它先讀 `rank_scores` 裡的 5 個 feature models，再合併 3 個 time-series alpha predictors。

實際 alpha voters：

| 類型 | 模型 | 來源 |
|---|---|---|
| Feature alpha | XGBoost | `pred["rank_scores"]` |
| Feature alpha | CatBoost | `pred["rank_scores"]` |
| Feature alpha | ExtraTrees | `pred["rank_scores"]` |
| Feature alpha | LightGBM | `pred["rank_scores"]` |
| Feature alpha | FT-Transformer | `pred["rank_scores"]` |
| Time-series alpha | Chronos | `pred["chronos"].forecast_pct` |
| Time-series alpha | DLinear | `pred["dlinear"].forecast_pct` |
| Time-series alpha | PatchTST | `pred["patchtst"].forecast_pct` |

排除在 alpha vote 之外：

- KalmanFilter：state-space overlay。
- MarkovSwitching：state-space overlay。
- ResidualMLP：experimental challenger / shadow。
- GNN：experimental challenger / shadow。
- GAOptimizer：meta optimizer，不是 base alpha predictor。

### V2-5. Verify aggregate：incremental rollup + off-hot-path full calibration

目前 verify-v2 nightly path 已預設 skip 兩個全量刷新：

- `update_model_accuracy`
- `update_trade_performance`

原因：

- 這兩個 function 會掃所有 verified `(stock_id, model_name)` groups。
- 每個 group 重算 `all / 30d / 90d`。
- 每個 period 內再跑多個 aggregate query。
- 每晚全量重掃會增加 Cloud Run wall time 與 D1 SQL cost。

production D1 觀測數據：

| 指標 | 數值 |
|---|---:|
| predictions total rows | 6,715 |
| verified predictions | 536 |
| verified groups | 317 |
| latest prediction_date groups | 33 |
| recent 7d verified groups | 157 |
| model_accuracy rows | 480 |
| model_accuracy groups | 160 |
| model_accuracy max last_updated | 2026-05-03 16:20:02 |
| trade_performance rows | 441 |
| trade_performance groups | 147 |
| trade_performance max last_updated | 2026-05-03 16:18:19 |

成本比例估算：

- Full rollup：
  - `317 groups * 3 periods * 2 tables = 1,902 group-period recomputes`
- Latest trading day incremental：
  - `33 groups * 3 periods * 2 tables = 198 group-period recomputes`
  - 約 full rollup 的 `10.4%`
- Recent 7d catch-up：
  - `157 groups * 3 periods * 2 tables = 942 group-period recomputes`
  - 約 full rollup 的 `49.5%`

結論：

- 跳過 nightly 全量重掃是正確方向。
- 但不能只 skip，否則 `model_accuracy` / `trade_performance` 會 stale。
- 正確做法是：
  - nightly verify 後做 incremental rollup。
  - off-hot-path 做低頻 full calibration。
  - dashboard / adaptive 讀取時加 freshness guard。

### V2-6. Verify rollup 實作策略

第一階段：incremental group refresh。

- 在 `write_verified` 後保留本次 verified rows 影響到的 `(stock_id, model_name)`。
- 只對這些 groups 重算：
  - `all`
  - `30d`
  - `90d`
- 寫回：
  - `model_accuracy`
  - `trade_performance`
- 不重掃未變動 groups。

第二階段：off-hot-path full calibration。

- 每週或手動觸發 full rollup。
- 用於處理：
  - late verification correction
  - historical backfill
  - null `prediction_date` legacy rows
  - schema / logic 修正後的全域校準
- full calibration 不應阻塞 nightly recommendation materialization。

第三階段：freshness guard。

- 在 consuming path 加 freshness check：
  - `adaptiveEngine`
  - `payload_builder.load_real_accuracies`
  - dashboard/report read routes
- 若 `last_updated` 超過門檻：
  - 降低該 metric 權重。
  - 標示 stale。
  - 不讓 stale accuracy 直接放大 confidence。

### V2-7. 優先順序

P0：

1. 把 Kalman output 接到 confidence modifier，並寫入 audit payload。
2. 把 Markov 從 evening critical path 改成 cache-first 或 async overlay。
3. verify-v2 補 incremental rollup，避免 aggregate table stale。

P1：

1. Markov output 接 `regime_aware_allocate` / `rank_signal_thresholds`。
2. 新增 `forecast_data.state_space_overlays`。
3. 新增 rollup freshness observability。

P2：

1. 低頻 full calibration job。
2. state-space overlay dashboard。
3. 用 walk-forward IC / regime-conditioned IC 驗證 Markov gate 是否真的改善 risk-adjusted outcome。
