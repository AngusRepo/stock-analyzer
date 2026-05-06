# Session Handoff 2026-04-22

日期：2026-04-22
時區：Asia/Taipei
Repo：`C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12`

## 這份文件的用途

給下一個 session 直接接手用。
如果只讀一份檔案，先讀這份。

## 先遵守的規則

- 一律用繁體中文回覆。
- 先找 root cause，再動手。
- **不要**自行做以下動作，除非 Wei 明確批准：
  - `deploy`
  - `retrain`
  - `commit`
  - `push`
  - 任何真實下單相關操作

## 本 session 已完成的事

### 1. 前端兩頁已恢復到可編譯狀態

以下兩個檔案一度被編碼污染到無法編譯，最後已直接拉回 `HEAD` 的乾淨基線：

- `frontend/src/pages/BotDashboard.tsx`
- `frontend/src/pages/SchedulerPage.tsx`

已驗證：

- 在 `frontend/` 執行 `npm run build`
- 結果：**PASS**

結論：

- 目前前端不是完全沒有編碼污染問題
- 但至少這兩頁已不再卡住 build

### 2. `ml-controller` deploy script 已補齊 pipeline 必要 env

檔案：

- `deploy_ml_controller.sh`

已補：

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `PIPELINE_JOB_NAME`
- `GCS_BUCKET_NAME`
- `RETRAIN_LOCK_BUCKET`

而且 deploy 時會透過：

- `--update-env-vars=...`

一併寫進 Cloud Run Service。

**注意：這只是程式面修補，還沒有 deploy。**

### 3. 已新增兩份審查文件

- `ENCODING_CLEANUP_AUDIT_2026_04_22.md`
- `SYSTEM_SIMPLIFICATION_REVIEW_2026_04_22.md`

用途：

- 前者記錄編碼污染與清理順序
- 後者記錄系統該如何簡化與收斂

## 本 session 實際驗證過的 live 事實

### D1：今天的 predictions 還沒落地

已執行 remote D1 query，結果：

- `predictions` on `2026-04-22`:
  - `pred_cnt = 0`
- `daily_recommendations` on `2026-04-22`:
  - `total = 25`
  - `zero_ml = 25`

結論：

- 今天 screener 已經寫了 25 檔推薦
- 但 prediction 一筆都沒進去
- 所以今天推薦上所有 `ml_score = 0` 是結果，不是 score function 本身壞掉

### Frontend：build 現在是綠的

已執行：

- `frontend/npm run build`

結果：

- PASS

## 本 thread 目前最重要的 root cause

### 今天 ML 分數沒補上的主因

根因不是前端，也不是 `calculate_ml_score()`。

根因是：

- live `ml-controller` 的 pipeline trigger path 之前確認缺少以下 env：
  - `GCP_PROJECT_ID`
  - `GCP_REGION`
  - `PIPELINE_JOB_NAME`

這會導致：

- `/pipeline/v2/run` 在觸發 Cloud Run Job 前就失敗

所以目前判斷：

**先不要手動補跑 `ml predict`。**

正確順序是：

1. 先讓 live `ml-controller` 吃到新 env
2. 確認 `/pipeline/v2/run` 可成功觸發
3. 再補跑：
   - `pipeline/v2`
   - 或至少 `ml_predict -> recommendation -> write_d1`

不要只補跑 `ml predict`，否則 `signal / confidence / ml_score / has_buy_signal` 可能還是不完整。

## 關於編碼污染的真實狀態

### 已經確認的情況

- `BotDashboard.tsx` / `SchedulerPage.tsx` 曾經污染到編譯層級
- 現在已回到乾淨可 build 狀態

### 仍值得後續處理的區塊

- root docs 可能仍有編碼污染：
  - `ARCHITECTURE.md`
  - `RISK_FRAMEWORK_ARCHITECTURE.md`
  - `ML_POOL_ARCHITECTURE.md`
- 後端註解與 comment 也仍可能有殘留

建議：

- 不要做機械式全 repo 轉碼
- 應該採「模組一個一個重整」的方式

## 系統架構的腦內狀態

目前最重要的架構判斷如下：

### 1. Production predict 應只剩一條主幹

保留：

- `/predict/v2`
- `ensemble_v2`

避免：

- gate 用新訊號
- 顯示與分數又讀 legacy signal

### 2. Production retrain 應只剩 `/retrain/universal`

`/retrain/trigger` 應降級為：

- deprecated
- debug / emergency only

不然 active/watchlist 與 universal 會維持兩套 training semantics。

### 3. `marketScreener.ts` 是 god module

建議拆成：

- `screener_core`
- `screener_persistence`
- `screener_postprocess`

### 4. `recommendation_service.py` 也需要拆層

建議拆成：

- `prediction_view`
- `recommendation_policy`
- `reason_builder`
- `recommendation_writer`

### 5. 並不是所有模型都該進 monthly retrain

較適合在 retrain 主鏈：

- tree models
- FT-Transformer
- DLinear
- PatchTST

較像 inference / research side：

- Chronos
- Kalman
- MarkovSwitching

特別記住：

- **Chronos 目前只是 `chronos-t5-tiny` baseline**
- 不要把它誤當成「已升級的大 Chronos production model」

## 下個 session 建議開場命令

### 1. 先確認環境

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npx wrangler@4 whoami
npx wrangler@4 d1 execute stockvision-db --remote --command "SELECT 1 AS ok;"

cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12
gcloud auth list --filter=status:ACTIVE --format="value(account)"
gcloud run services describe ml-controller --region=asia-east1 --format="json(status.url,status.latestReadyRevisionName,spec.template.spec.containers[0].env)"

C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m modal profile current
```

### 2. 再確認今天是否仍未補上 predictions

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npx wrangler@4 d1 execute stockvision-db --remote --command "SELECT COUNT(*) AS pred_cnt FROM predictions WHERE date(generated_at)='2026-04-22'; SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(ml_score,0)=0 THEN 1 ELSE 0 END) AS zero_ml FROM daily_recommendations WHERE date='2026-04-22';"
```

## 下個 session 最值得做的事

### 優先順序

1. 確認 live `ml-controller` 是否仍缺：
   - `GCP_PROJECT_ID`
   - `GCP_REGION`
   - `PIPELINE_JOB_NAME`
2. 如果缺，準備 deploy 方案，但**先不要 deploy，等 Wei 批准**
3. 批准後再 deploy
4. 驗證 `/pipeline/v2/run` 能否正常觸發
5. 再決定是否補跑今天的 pipeline / ml_predict

## 明確不要做的事

- 不要因為今天 `ml_score=0` 就直接手動跑 `ml predict`
- 不要在沒確認 env 修好前就補跑 pipeline
- 不要把 `Chronos` 當成 monthly retrain 主模型
- 不要在未經批准下 deploy / retrain / commit / push

## 一句話摘要

這個 repo 現在的狀態是：

- 前端兩個最嚴重的污染頁面已恢復可 build
- 今天 `predictions` 仍是 `0`
- `daily_recommendations` 今天有 `25` 筆且全部 `ml_score=0`
- 目前最該先處理的是 live `ml-controller` 的 pipeline env，而不是先補跑 ML
