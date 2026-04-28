# Issue Triage 2026-04-23

目的：把 `2026-04-22` handoff 與 `2026-04-23` live 驗證收斂成一份可執行的優先級清單，避免只記住單一症狀。

## P0 直接事故 blocker

### 1. live `ml-controller` 缺 pipeline trigger 必要 env

狀態：
- `2026-04-23` 初始驗證時，live Cloud Run Service 缺
  - `GCP_PROJECT_ID`
  - `GCP_REGION`
  - `PIPELINE_JOB_NAME`
- `2026-04-23` 後續已 deploy 到 revision `ml-controller-00166-5hd`
- 目前 live env 已補齊上述三個 key

影響：
- `POST /pipeline/v2/run` 進到 controller 後，會在 Cloud Run Job trigger 前失敗。
- `worker` 端只會看到 trigger 失敗，後續 `predictions` 不會寫入。

程式路徑：
- [ml-controller/routers/pipeline.py](C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/ml-controller/routers/pipeline.py)
- [ml-controller/services/cloud_run_jobs_client.py](C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/ml-controller/services/cloud_run_jobs_client.py)
- [worker/src/index.ts](C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/worker/src/index.ts)

處理原則：
- env blocker 已解除，但還沒做實際 trigger 驗證。
- 在未確認 `/pipeline/v2/run` 真正可成功觸發前，不要直接手動補跑 `ml predict`。

### 2. deploy script 修補目前只存在工作樹

狀態：
- `deploy_ml_controller.sh` 裡的 env 修補不是 `HEAD` 既有內容，而是工作樹未提交修改。

影響：
- 可以解釋為什麼 handoff 說「script 已補」，但 live service 仍沒有吃到。
- 目前 repo 真實狀態是「本地修了、live 未修、正式 deploy 也還沒做」。

處理原則：
- 先把本地 patch 補到可重複使用的 preflight。
- deploy 仍需 Wei 明確批准。

## P1 live 症狀

### 3. `predictions` 沒落地，但 `daily_recommendations` 已產生

已知事實：
- `2026-04-22` 的 `predictions = 0`
- `2026-04-22` 的 `daily_recommendations = 25`
- `2026-04-22` 的 `zero_ml = 25`

解讀：
- screener 有跑。
- recommendation 有寫。
- prediction 沒落地，所以 `ml_score = 0` 是結果，不是單純前端顯示或 score function 問題。

處理原則：
- 先修 trigger path，再驗證 `pipeline/v2` 是否能完成 `ml_predict -> recommendation -> write_d1`。

`2026-04-23` 追加驗證：
- `pipeline-v2-gjfst` 已成功完成，耗時約 `7m20s`
- `predictions` 在 `generated_at >= '2026-04-22 16:42:00'` 新增 `120` 筆
- 代表 trigger path 與 ML predict 寫入已恢復
- 但 `daily_recommendations WHERE date='2026-04-23'` 仍為 `0`

最新解讀：
- 當前不是「整條 pipeline 都沒跑」
- 而是「trigger + Cloud Run Job + predictions 寫入已恢復」
- 剩下要追的是 recommendation / write_d1 這一段為何沒有對 `2026-04-23` 產生資料

## P1 deploy / runtime 缺口

### 4. Service 與 Job 仍有 image / config 漂移風險

已知背景：
- `ml-controller` Service deploy 不會自動同步 `pipeline-v2` Job image。
- 這件事在 handoff / operations 文件裡已被重複記錄。

風險：
- 即使補 env 並 deploy Service，Job 也可能仍跑舊 image。
- 只看 Service revision 綠燈，不代表 pipeline 真正跑的是新版本。

`2026-04-23` 補驗結果：
- deploy 前 live Service revision: `ml-controller-00165-qgt`
- deploy 後 live Service revision: `ml-controller-00166-5hd`
- live Service image = live Job image
- 所以「Service / Job image 不一致」目前不是當前 blocker
- 但它仍是 deploy path 的結構性風險，不能省略驗證

處理原則：
- deploy 時必須同時驗證
  - Service image
  - Job image
  - 必要 env

## P2 已知 ML caveats

### 5. `predict_stock_v2` 已知 crash 點

狀態：
- `allow_missing_target=True` 路徑是已知核心修補點。

影響：
- 後續若要追單股 predict / feature pipeline，不要把這條已知 crash 當成新的未知問題。

### 6. `chips` 缺資料時 feature schema 仍可能漂移

已知訊號：
- `5/46`
- `9/106`
- missing features warning

影響：
- 這不是單純 log noise。
- 即使 pipeline trigger 修好，feature schema 仍可能造成 prediction 品質或穩定性問題。

### 7. `shioaji-proxy` 與文件可能不完全一致

狀態：
- Plan A / paper precision 文件把 `/snapshots` 當前提，但 AGENTS 明確要求以 code 為準。

影響：
- 任何 paper precision / risk / intraday 推論都要再對一次真實 call path。

## P3 暫緩處理的技術債

### 8. 編碼污染仍有殘留風險

已知狀態：
- `BotDashboard.tsx`
- `SchedulerPage.tsx`

上面兩頁已回到可 build。

仍需注意：
- `ARCHITECTURE.md`
- `RISK_FRAMEWORK_ARCHITECTURE.md`
- `ML_POOL_ARCHITECTURE.md`
- 部分後端註解 / comment

處理原則：
- 不做全 repo 機械式轉碼。
- 採模組化、逐檔清理。

### 9. 架構重整項目先記錄，不在本輪展開

暫不展開：
- `marketScreener.ts` 拆模組
- `recommendation_service.py` 拆層
- predict / retrain 主幹全面收斂

原因：
- 這些是中期架構收斂，不是本輪 incident 的第一優先。

## 建議處理順序

1. deploy 前 preflight 必須先能抓出必要 env 缺失與 live drift。
2. Wei 批准後，再做一次正式 deploy，並同步驗證 Service / Job image 與 env。
3. deploy 完成後，再驗證 `/pipeline/v2/run` 是否能成功觸發。
4. 只有在 trigger path 確認正常後，才決定要不要補跑 `pipeline/v2` 或 `ml_predict`。
5. 之後再處理 ML caveats 與編碼污染等次級議題。
